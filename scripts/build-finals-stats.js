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

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT             = path.join(__dirname, '..');
const DRY_RUN          = process.argv.includes('--dry-run');
const GAME_COMMIT_INTERVAL   = 200;
const PLAYER_COMMIT_INTERVAL = 2000;
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.finals-progress.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

function gitCommit(message, dirs) {
  try {
    execSync(`git add ${dirs.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
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

const sidsToScan = sids.filter(s => !scannedSids.has(s));
console.log(`  ${sids.length} season files total, ${scannedSids.size} already scanned, ${sidsToScan.length} remaining`);

for (const sid of sidsToScan) {
  // Load game file
  let gf;
  try { gf = readJson(path.join(gamesDir, `${sid}.json`)); } catch { scannedSids.add(sid); continue; }

  // Check if this season has any finals at all before loading team-stats
  const finalsGames = Object.values(gf.games || {}).filter(g => isFinal(g.rn));
  if (finalsGames.length === 0) { scannedSids.add(sid); continue; }

  // Load team-stats to resolve uuid→tid for this season
  const uuidToTid = new Map(); // uuid → tid
  try {
    const tsData = readJson(path.join(teamStatsDir, `${sid}.json`));
    for (const [tid, team] of Object.entries(tsData)) {
      for (const uuid of Object.keys(team.roster || {})) {
        uuidToTid.set(uuid, tid);
      }
    }
  } catch {
    // team-stats missing — can still count finals appearances, just not wins
  }

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

    // Accumulate for each player in this game
    for (const pEntry of (g.p || [])) {
      const uuid = pEntry.id;
      if (!uuid) continue;

      if (!finalsMap.has(uuid)) finalsMap.set(uuid, new Map());
      const sidMap = finalsMap.get(uuid);
      if (!sidMap.has(sid)) sidMap.set(sid, { finals: 0, gfApps: 0, gfWins: 0 });
      const acc = sidMap.get(sid);

      acc.finals++;
      if (gf_flag) {
        acc.gfApps++;
        // Win: player's tid matches winning tid
        const playerTid = uuidToTid.get(uuid);
        if (playerTid && winnerTid && playerTid === winnerTid) {
          acc.gfWins++;
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
  let seasonsWithGames = 0;
  for (const season of (player.seasons || [])) {
    const totalGp = (season.regs || []).reduce((sum, r) => sum + (r.stats?.gp ?? 0), 0);
    if (totalGp > 0) seasonsWithGames++;
  }

  for (const acc of sidMap.values()) {
    careerFinals  += acc.finals;
    careerGfApps  += acc.gfApps;
    careerGfWins  += acc.gfWins;
  }

  const finalsPerSeason = seasonsWithGames > 0
    ? Math.round((careerFinals / seasonsWithGames) * 10) / 10
    : 0;

  const bball = player.sports?.Basketball;
  if (bball) {
    if ((bball.finals          ?? -1) !== careerFinals)      { bball.finals          = careerFinals;      modified = true; }
    if ((bball.gfApps          ?? -1) !== careerGfApps)      { bball.gfApps          = careerGfApps;      modified = true; }
    if ((bball.gfWins          ?? -1) !== careerGfWins)      { bball.gfWins          = careerGfWins;      modified = true; }
    if ((bball.finalsPerSeason ?? -1) !== finalsPerSeason)   { bball.finalsPerSeason = finalsPerSeason;   modified = true; }
  }

  // Per-reg: write season-level counts to every reg in that season
  for (const season of (player.seasons || [])) {
    const sid = season.sid;
    const acc = sidMap.get(sid) ?? { finals: 0, gfApps: 0, gfWins: 0 };
    for (const reg of (season.regs || [])) {
      if (!reg.stats) reg.stats = {};
      if ((reg.stats.finals  ?? -1) !== acc.finals)  { reg.stats.finals  = acc.finals;  modified = true; }
      if ((reg.stats.gfApps  ?? -1) !== acc.gfApps)  { reg.stats.gfApps  = acc.gfApps;  modified = true; }
      if ((reg.stats.gfWins  ?? -1) !== acc.gfWins)  { reg.stats.gfWins  = acc.gfWins;  modified = true; }
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
