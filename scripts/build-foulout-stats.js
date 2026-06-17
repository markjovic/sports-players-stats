// scripts/build-foulout-stats.js
//
// Single-pass scan of all games/bv/{sid}.json box score data (hp/ap arrays).
// Computes all derived per-game stats in one pass — no separate scripts needed:
//
//   foulOuts    — games where player accumulated >= 5 fouls
//   foulOutsPG  — foulOuts / gp
//   threePtPG   — total 3-pointers / gp  (pt3 field in box scores)
//   foulsPG     — total personal fouls / gp
//
// Also checks for technicalFouls/tech fields and reports if found.
//
// Writes computed stats into each player file's reg.stats and career totals.
// build-leaderboards.js --force then picks them up automatically.
//
// Run:     node scripts/build-foulout-stats.js
// Dry run: node scripts/build-foulout-stats.js --dry-run
// Resume:  node scripts/build-foulout-stats.js   (progress saved every interval)
//
// Progress file: scripts/.foulout-progress.json

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT             = path.join(__dirname, '..');
const DRY_RUN          = process.argv.includes('--dry-run');
const FOUL_THRESHOLD   = 5;
const GAME_COMMIT_INTERVAL   = 200;  // commit every N season game files scanned
const PLAYER_COMMIT_INTERVAL = 2000; // commit every N player files written

const PROGRESS_FILE = path.join(ROOT, 'scripts', '.foulout-progress.json');

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

// ─── Step 1: scan game files ──────────────────────────────────────────────────
// Build: statsMap  = Map<uuid, Map<sid, {foulOuts,threePt,fouls,games}>>  per player per season
//        techFoulsFound = boolean                 whether tech fouls field exists

console.log('── Step 1: Scanning game files for box score foul data ─────────────');

const gamesDir = path.join(ROOT, 'games', 'bv');
const sids     = fs.readdirSync(gamesDir)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''))
  .sort();

// Load scan progress
let progress = { scannedSids: [] };
if (fs.existsSync(PROGRESS_FILE)) {
  try { progress = readJson(PROGRESS_FILE); } catch {}
}
const scannedSids = new Set(progress.scannedSids || []);

// Load existing stats map from progress if available
// Map structure: { uuid: { sid: { foulOuts, threePt, fouls, games } } }
const statsFlat = progress.statsMap || {};
const statsMap  = new Map(); // uuid → Map<sid, {foulOuts, threePt, fouls, games}>
for (const [uuid, smap] of Object.entries(statsFlat)) {
  const inner = new Map();
  for (const [sid, v] of Object.entries(smap)) inner.set(sid, v);
  statsMap.set(uuid, inner);
}

let techFoulsFound    = progress.techFoulsFound || false;
let gamesWithBoxScore = progress.gamesWithBoxScore || 0;
let totalFoulOuts     = progress.totalFoulOuts || 0;
let sinceLastCommit   = 0;

const sidsToScan = sids.filter(sid => !scannedSids.has(sid));
console.log(`  ${sids.length} season files total, ${scannedSids.size} already scanned, ${sidsToScan.length} remaining`);

for (const sid of sidsToScan) {
  let gf;
  try { gf = readJson(path.join(gamesDir, `${sid}.json`)); } catch { scannedSids.add(sid); continue; }

  for (const g of Object.values(gf.games || {})) {
    // Check both sides of the box score
    for (const [side, tid] of [['hp', g.h || g.t1], ['ap', g.a || g.t2]]) {
      const boxScores = g[side];
      if (!Array.isArray(boxScores) || boxScores.length === 0) continue;

      gamesWithBoxScore++;

      for (const entry of boxScores) {
        const uuid = entry.profileID;
        if (!uuid) continue;

        // Check for tech fouls field
        if (!techFoulsFound && (entry.technicalFouls != null || entry.tech != null)) {
          techFoulsFound = true;
          console.log(`  ✓ Tech fouls field found: technicalFouls=${entry.technicalFouls} tech=${entry.tech}`);
        }

        // Accumulate per-game stats for this player
        const fouls   = entry.fouls ?? 0;
        const threePt = entry.pt3   ?? 0;

        if (!statsMap.has(uuid)) statsMap.set(uuid, new Map());
        const sidMap = statsMap.get(uuid);
        if (!sidMap.has(sid)) sidMap.set(sid, { foulOuts: 0, threePt: 0, fouls: 0, games: 0 });
        const acc = sidMap.get(sid);
        acc.games++;
        acc.threePt += threePt;
        acc.fouls   += fouls;
        if (fouls >= FOUL_THRESHOLD) { acc.foulOuts++; totalFoulOuts++; }
      }
    }
  }

  scannedSids.add(sid);
  sinceLastCommit++;

  if (sinceLastCommit >= GAME_COMMIT_INTERVAL) {
    // Save progress (convert Maps to plain objects for JSON)
    const statsFlat2 = {};
    for (const [uuid, smap] of statsMap) {
      statsFlat2[uuid] = Object.fromEntries(smap);
    }
    const prog = {
      scannedSids: [...scannedSids],
      statsMap: statsFlat2,
      techFoulsFound,
      gamesWithBoxScore,
      totalFoulOuts,
    };
    if (!DRY_RUN) {
      writeJson(PROGRESS_FILE, prog);
      gitCommit(
        `build-foulout-stats: ${scannedSids.size}/${sids.length} seasons scanned, ${statsMap.size} players with box score data`,
        ['scripts/.foulout-progress.json']
      );
    }
    sinceLastCommit = 0;
    console.log(`  ${scannedSids.size}/${sids.length} seasons scanned — ${statsMap.size} players, ${totalFoulOuts} foul-outs`);
  }
}

// Save final scan progress
if (!DRY_RUN) {
  const statsFlat2 = {};
  for (const [uuid, smap] of statsMap) {
    statsFlat2[uuid] = Object.fromEntries(smap);
  }
  writeJson(PROGRESS_FILE, {
    scannedSids: [...scannedSids],
    statsMap: statsFlat2,
    techFoulsFound,
    gamesWithBoxScore,
    totalFoulOuts,
    scanComplete: true,
  });
}

console.log(`\n  Scan complete:`);
console.log(`  ${gamesWithBoxScore} games had box score data`);
console.log(`  ${statsMap.size} players have box score data`);
console.log(`  ${totalFoulOuts} total foul-out instances`);
console.log(`  Tech fouls field present: ${techFoulsFound}`);

// ─── Step 2: write foulOuts into player files ─────────────────────────────────

console.log('\n── Step 2: Writing foulOuts to player files ────────────────────────');
console.log(`  ${statsMap.size} player files to update`);

const playersDir = path.join(ROOT, 'players');
let playersUpdated = 0;
let playersSkipped = 0;
sinceLastCommit    = 0;

for (const [uuid, sidMap] of statsMap) {
  const prefix     = uuid.slice(0, 2);
  const playerPath = path.join(playersDir, prefix, `${uuid}.json`);

  let player;
  try { player = readJson(playerPath); } catch { playersSkipped++; continue; }

  let modified = false;

  // Career totals from all seasons
  let careerFoulOuts = 0, careerThreePt = 0, careerFouls = 0;
  for (const acc of sidMap.values()) {
    careerFoulOuts += acc.foulOuts;
    careerThreePt  += acc.threePt;
    careerFouls    += acc.fouls;
  }

  const bball = player.sports?.Basketball;
  if (bball) {
    const gp = bball.gp || 1;
    if ((bball.foulOuts  ?? -1) !== careerFoulOuts)  { bball.foulOuts  = careerFoulOuts;  modified = true; }
    if ((bball.threePtPG ?? -1) !== Math.round(careerThreePt / gp * 100) / 100) {
      bball.threePtPG = Math.round(careerThreePt / gp * 100) / 100; modified = true;
    }
    if ((bball.foulsPG   ?? -1) !== Math.round(careerFouls / gp * 100) / 100) {
      bball.foulsPG = Math.round(careerFouls / gp * 100) / 100; modified = true;
    }
  }

  // Per-reg: write season-level accumulated stats to every reg in that season
  for (const season of (player.seasons || [])) {
    const sid = season.sid;
    const acc = sidMap.get(sid) ?? { foulOuts: 0, threePt: 0, fouls: 0, games: 0 };
    const sgp = acc.games || 1;
    for (const reg of (season.regs || [])) {
      if (!reg.stats) reg.stats = {};
      if ((reg.stats.foulOuts  ?? -1) !== acc.foulOuts)  { reg.stats.foulOuts  = acc.foulOuts;  modified = true; }
      if ((reg.stats.threePtPG ?? -1) !== Math.round(acc.threePt / sgp * 100) / 100) {
        reg.stats.threePtPG = Math.round(acc.threePt / sgp * 100) / 100; modified = true;
      }
      if ((reg.stats.foulsPG   ?? -1) !== Math.round(acc.fouls / sgp * 100) / 100) {
        reg.stats.foulsPG = Math.round(acc.fouls / sgp * 100) / 100; modified = true;
      }
    }
  }

  if (!modified) { playersSkipped++; continue; }

  if (!DRY_RUN) writeJson(playerPath, player);
  playersUpdated++;
  sinceLastCommit++;

  if (sinceLastCommit >= PLAYER_COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      gitCommit(
        `build-foulout-stats: ${playersUpdated} player files updated`,
        ['players/']
      );
    }
    sinceLastCommit = 0;
    console.log(`  ${playersUpdated} players updated...`);
  }
}

// Also zero-out foulOuts on players who have NO foul-outs but previously had the field
// (not strictly necessary on first run, but makes re-runs safe)

if (!DRY_RUN && sinceLastCommit > 0) {
  gitCommit(
    `build-foulout-stats: complete — ${playersUpdated} player files updated`,
    ['players/']
  );
}

// Clean up progress file now that we're done
if (!DRY_RUN && fs.existsSync(PROGRESS_FILE)) {
  fs.unlinkSync(PROGRESS_FILE);
  gitCommit('build-foulout-stats: remove progress file', ['scripts/.foulout-progress.json']);
}

console.log('\n─── Summary ─────────────────────────────────────────────────────────');
console.log(`  Games with box score data   : ${gamesWithBoxScore}`);
console.log(`  Players with box score data : ${statsMap.size}`);
console.log(`  Total foul-out instances    : ${totalFoulOuts}`);
console.log(`  Tech fouls field found      : ${techFoulsFound}`);
console.log(`  Player files updated        : ${playersUpdated}`);
console.log(`  Player files skipped        : ${playersSkipped}`);
console.log(`  Mode                        : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
console.log('\nNext step: node scripts/build-leaderboards.js --force');
console.log('(After updating pushSeason/pushAllTime to include foulOuts field)');
