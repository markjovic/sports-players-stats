// scripts/build-finals-stats.js
//
// Scans all games/bv/{sid}.json files for finals games (any game where rn
// contains "final" case-insensitive), then counts per player per season:
//
//   finals      — total finals appearances (SF, PF, GF, etc.)
//   gfApps      — Grand Final appearances specifically
//   gfWins      — Grand Final wins
//
// Career stats additionally compute:
//   finalsPerSeason — career finals / seasons with at least one game
//
// Team assignment (needed for win determination) is resolved from
// team-stats/bv/{sid}.json — no API calls needed.
//
// Writes results to:
//   - player files: reg.stats.{finals, gfApps, gfWins}
//   - player files: player.sports.Basketball.{finals, gfApps, gfWins, finalsPerSeason}
//
// After this runs, rebuild leaderboards:
//   node scripts/build-leaderboards.js --force
//
// Run:     node scripts/build-finals-stats.js
// Dry run: node scripts/build-finals-stats.js --dry-run
// Resume:  node scripts/build-finals-stats.js  (progress saved every interval)

'use strict';

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));


const ROOT             = path.join(__dirname, '..');
const DRY_RUN          = process.argv.includes('--dry-run');
const ACTIVE_ONLY      = process.argv.includes('--active-only');
const GAME_COMMIT_INTERVAL   = 200;
const PLAYER_COMMIT_INTERVAL = 2000;
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.finals-progress.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

function gitCommit(message, dirs) {
  try {
    execSync('git add -A', { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git fetch origin main', { cwd: ROOT, stdio: 'pipe' });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push origin main', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ committed: ${message}`);
  } catch (e) {
    console.error(`  ✗ git error: ${e.message}`);
  }
}

function isFinal(rn) {
  if (!rn) return false;
  return rn.toLowerCase().includes('final');
}

function isGrandFinal(rn) {
  if (!rn) return false;
  const r = rn.toLowerCase();
  return r.includes('grand final') || r === 'gf';
}

// ─── Phase 1: scan game files ─────────────────────────────────────────────────
// finalsMap: Map<uuid, Map<sid, {finals, gfApps, gfWins}>>

console.log('── Phase 1: Scanning game files for finals ─────────────────────────');

const gamesDir     = path.join(ROOT, 'games', 'bv');
const teamStatsDir = path.join(ROOT, 'team-stats', 'bv');

const sids = fs.readdirSync(gamesDir)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''))
  .sort();

// Load progress
let progress = { scannedSids: [], finalsMap: {} };
if (fs.existsSync(PROGRESS_FILE)) {
  try { progress = readJson(PROGRESS_FILE); } catch {}
}
const scannedSids = new Set(progress.scannedSids || []);

// Restore finalsMap from progress
// Storage format: { uuid: { sid: { finals, gfApps, gfWins } } }
const finalsMap = new Map();
for (const [uuid, smap] of Object.entries(progress.finalsMap || {})) {
  const inner = new Map();
  for (const [sid, v] of Object.entries(smap)) inner.set(sid, { ...v });
  finalsMap.set(uuid, inner);
}

let totalFinalsGames = progress.totalFinalsGames || 0;
let totalGFGames     = progress.totalGFGames     || 0;
let sinceLastCommit  = 0;

// In active-only mode restrict to unlocked seasons
let candidateSids = sids;
if (ACTIVE_ONLY) {
  const sportsIndex = readJson(path.join(ROOT, 'sports-index.json'));
  const activeSids  = new Set(
    Object.values(sportsIndex.seasons ?? {})
      .filter(s => !s.locked)
      .map(s => s.id)
  );
  candidateSids = sids.filter(s => activeSids.has(s));
  console.log(`  Active-only: ${activeSids.size} active seasons`);
}

const sidsToScan = candidateSids.filter(s => !scannedSids.has(s));
console.log(`  ${sids.length} total seasons, ${candidateSids.length} in scope, ${scannedSids.size} already scanned, ${sidsToScan.length} remaining`);

for (const sid of sidsToScan) {
  // Load game file
  let gf;
  try { gf = readJson(path.join(gamesDir, `${sid}.json`)); } catch { scannedSids.add(sid); continue; }

  // Check if this season has any finals at all before loading team-stats
  const finalsGames = Object.values(gf.games || {}).filter(g => isFinal(g.rn));
  if (finalsGames.length === 0) { scannedSids.add(sid); continue; }

  // Resolve uuid→tid from the game entry itself (h/a team IDs)
  // We determine team from whether player is in homePlayers or awayPlayers below
  // uuidToTid built per-game for GF win determination
  const uuidToTid = new Map();

  for (const g of finalsGames) {
    const gf_flag = isGrandFinal(g.rn);
    if (gf_flag) totalGFGames++;
    totalFinalsGames++;

    // Determine winning tid (null = draw or unknown)
    const hs = g.hs ?? g.s1 ?? null;
    const as = g.as ?? g.s2 ?? null;
    let winnerTid = null;
    if (hs != null && as != null) {
      if (hs > as) winnerTid = g.h || g.t1 || null;
      else if (as > hs) winnerTid = g.a || g.t2 || null;
    }

    // Build uuid→tid from p[] + game h/a for win determination
    // p[] has all players but no team — use hp/ap if available, else use game.h/game.a heuristic
    const homeTid = g.h || g.t1 || null;
    const awayTid = g.a || g.t2 || null;
    const homeUuids = new Set((g.hp || []).map(p => p.profileID).filter(Boolean));
    const awayUuids = new Set((g.ap || []).map(p => p.profileID).filter(Boolean));

    for (const pEntry of (g.p || [])) {
      const uuid = pEntry.id;
      if (!uuid) continue;

      if (!finalsMap.has(uuid)) finalsMap.set(uuid, new Map());
      const sidMap = finalsMap.get(uuid);
      if (!sidMap.has(sid)) sidMap.set(sid, { finals: 0, gfApps: 0, gfWins: 0 });
      const acc = sidMap.get(sid);

      acc.finals = 1;
      if (gf_flag) {
        acc.gfApps = 1;
        // Determine team: prefer hp/ap attribution, fall back to winnerTid heuristic
        let playerTid = null;
        if (homeUuids.has(uuid)) playerTid = homeTid;
        else if (awayUuids.has(uuid)) playerTid = awayTid;
        if (playerTid && winnerTid && playerTid === winnerTid) {
          acc.gfWins = 1;
        }
      }
    }
  }

  scannedSids.add(sid);
  sinceLastCommit++;

  if (sinceLastCommit >= GAME_COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      const flat = {};
      for (const [uuid, smap] of finalsMap) flat[uuid] = Object.fromEntries(smap);
      writeJson(PROGRESS_FILE, { scannedSids: [...scannedSids], finalsMap: flat, totalFinalsGames, totalGFGames });
      gitCommit(
        `build-finals-stats: ${scannedSids.size}/${sids.length} seasons scanned, ${finalsMap.size} players with finals data`,
        ['scripts/.finals-progress.json']
      );
    }
    sinceLastCommit = 0;
    console.log(`  ${scannedSids.size}/${sids.length} seasons — ${finalsMap.size} players, ${totalFinalsGames} finals games`);
  }
}

// Final progress save
if (!DRY_RUN) {
  const flat = {};
  for (const [uuid, smap] of finalsMap) flat[uuid] = Object.fromEntries(smap);
  writeJson(PROGRESS_FILE, { scannedSids: [...scannedSids], finalsMap: flat, totalFinalsGames, totalGFGames, scanComplete: true });
}

console.log(`\n  Scan complete:`);
console.log(`  ${totalFinalsGames} finals games found`);
console.log(`  ${totalGFGames} Grand Finals found`);
console.log(`  ${finalsMap.size} players with finals appearances`);

// ─── Phase 2: write to player files ──────────────────────────────────────────

console.log('\n── Phase 2: Writing finals stats to player files ───────────────────');
console.log(`  ${finalsMap.size} player files to update`);

const playersDir = path.join(ROOT, 'players');
let playersUpdated = 0;
let playersSkipped = 0;
sinceLastCommit = 0;

for (const [uuid, sidMap] of finalsMap) {
  const prefix     = uuid.slice(0, 2);
  const playerPath = path.join(playersDir, prefix, `${uuid}.json`);

  let player;
  try { player = readJson(playerPath); } catch { playersSkipped++; continue; }

  let modified = false;

  // Career totals
  let careerFinals = 0, careerGfApps = 0, careerGfWins = 0;
  // Count seasons the player has registrations in — every season entry means they played.
  // Do NOT use r.stats.gp here: that field is stale and may be 0 even when the player played,
  // which causes seasonsWithGames < seasonsWithFinals and finalsPerSeason > 1.
  const seasonsWithGames = (player.seasons || []).filter(s => (s.regs || []).length > 0).length;

  let seasonsWithFinals = 0;
  for (const acc of sidMap.values()) {
    if (acc.finals > 0)  { careerFinals++;  seasonsWithFinals++; }
    if (acc.gfApps > 0)    careerGfApps++;
    if (acc.gfWins > 0)    careerGfWins++;
  }

  // finalsPerSeason = fraction of seasons where player appeared in finals (max 1 per season)
  const finalsPerSeason = seasonsWithGames > 0
    ? Math.round((seasonsWithFinals / seasonsWithGames) * 100) / 100
    : 0;

  if (!player.sports)            player.sports = {};
  if (!player.sports.Basketball) player.sports.Basketball = {};
  const bball = player.sports.Basketball;
  if ((bball.finals          ?? -1) !== careerFinals)      { bball.finals          = careerFinals;      modified = true; }
  if ((bball.gfApps          ?? -1) !== careerGfApps)      { bball.gfApps          = careerGfApps;      modified = true; }
  if ((bball.gfWins          ?? -1) !== careerGfWins)      { bball.gfWins          = careerGfWins;      modified = true; }
  if ((bball.finalsPerSeason ?? -1) !== finalsPerSeason)   { bball.finalsPerSeason = finalsPerSeason;   modified = true; }

  // Per-reg: write season-level counts to every reg in that season
  for (const season of (player.seasons || [])) {
    const sid = season.sid;
    const acc = sidMap.get(sid) ?? { finals: 0, gfApps: 0, gfWins: 0 };
    for (const reg of (season.regs || [])) {
      if (!reg.stats) reg.stats = {};
      // Only write non-zero values — omit zeros to save space
      if (acc.finals > 0)  { if ((reg.stats.finals  ?? 0) !== acc.finals)  { reg.stats.finals  = acc.finals;  modified = true; } }
      else if (reg.stats.finals  !== undefined) { delete reg.stats.finals;  modified = true; }
      if (acc.gfApps > 0)  { if ((reg.stats.gfApps  ?? 0) !== acc.gfApps)  { reg.stats.gfApps  = acc.gfApps;  modified = true; } }
      else if (reg.stats.gfApps  !== undefined) { delete reg.stats.gfApps;  modified = true; }
      if (acc.gfWins > 0)  { if ((reg.stats.gfWins  ?? 0) !== acc.gfWins)  { reg.stats.gfWins  = acc.gfWins;  modified = true; } }
      else if (reg.stats.gfWins  !== undefined) { delete reg.stats.gfWins;  modified = true; }
    }
  }

  if (!modified) { playersSkipped++; continue; }

  if (!DRY_RUN) writeJson(playerPath, player);
  playersUpdated++;
  sinceLastCommit++;

  if (sinceLastCommit >= PLAYER_COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      gitCommit(
        `build-finals-stats: ${playersUpdated} player files updated`,
        ['players/']
      );
    }
    sinceLastCommit = 0;
    console.log(`  ${playersUpdated} players updated...`);
  }
}

if (!DRY_RUN && sinceLastCommit > 0) {
  gitCommit(
    `build-finals-stats: complete — ${playersUpdated} player files updated`,
    ['players/']
  );
}

// Clean up progress file
if (!DRY_RUN && fs.existsSync(PROGRESS_FILE)) {
  fs.unlinkSync(PROGRESS_FILE);
  gitCommit('build-finals-stats: remove progress file', ['scripts/.finals-progress.json']);
}

console.log('\n─── Summary ─────────────────────────────────────────────────────────');
console.log(`  Finals games found          : ${totalFinalsGames}`);
console.log(`  Grand Finals found          : ${totalGFGames}`);
console.log(`  Players with finals data    : ${finalsMap.size}`);
console.log(`  Player files updated        : ${playersUpdated}`);
console.log(`  Player files skipped        : ${playersSkipped}`);
console.log(`  Mode                        : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
console.log('\nNext step: node scripts/build-leaderboards.js --force');
