// scripts/build-foulout-stats.js
//
// Scans all games/bv/{sid}.json files for box score entries (hp/ap arrays)
// where fouls >= 5, counts foul-outs per player per season, then writes
// foulOuts and foulOutsPG into each player file's reg.stats and career totals.
//
// Also checks for technicalFouls/tech fields in box scores and reports
// whether they exist (does not add API calls to fetch them).
//
// After this script runs, rebuild leaderboards:
//   node scripts/build-leaderboards.js --force
//
// build-leaderboards.js will pick up foulOuts from reg.stats automatically
// once pushSeason is updated to include it (handled in that script).
//
// Run:     node scripts/build-foulout-stats.js
// Dry run: node scripts/build-foulout-stats.js --dry-run
// Resume:  node scripts/build-foulout-stats.js   (progress saved every interval)
//
// Progress file: scripts/.foulout-progress.json
// Stores which sids have been scanned so interrupted runs resume.

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
// Build: foulOutMap  = Map<uuid, Map<sid, int>>   foul-outs per player per season
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

// Load existing foul-out map from progress if available
// Map structure in progress file: { uuid: { sid: count } }
const foulOutFlat = progress.foulOutMap || {};
const foulOutMap  = new Map(); // uuid → Map<sid, count>
for (const [uuid, smap] of Object.entries(foulOutFlat)) {
  foulOutMap.set(uuid, new Map(Object.entries(smap)));
}

let techFoulsFound  = progress.techFoulsFound || false;
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

        // Count foul-outs
        if ((entry.fouls ?? 0) >= FOUL_THRESHOLD) {
          if (!foulOutMap.has(uuid)) foulOutMap.set(uuid, new Map());
          const sidMap = foulOutMap.get(uuid);
          sidMap.set(sid, (sidMap.get(sid) || 0) + 1);
          totalFoulOuts++;
        }
      }
    }
  }

  scannedSids.add(sid);
  sinceLastCommit++;

  if (sinceLastCommit >= GAME_COMMIT_INTERVAL) {
    // Save progress (convert Maps to plain objects for JSON)
    const foulOutFlat2 = {};
    for (const [uuid, smap] of foulOutMap) {
      foulOutFlat2[uuid] = Object.fromEntries(smap);
    }
    const prog = {
      scannedSids: [...scannedSids],
      foulOutMap: foulOutFlat2,
      techFoulsFound,
      gamesWithBoxScore,
      totalFoulOuts,
    };
    if (!DRY_RUN) {
      writeJson(PROGRESS_FILE, prog);
      gitCommit(
        `build-foulout-stats: ${scannedSids.size}/${sids.length} seasons scanned, ${foulOutMap.size} players with foul-outs`,
        ['scripts/.foulout-progress.json']
      );
    }
    sinceLastCommit = 0;
    console.log(`  ${scannedSids.size}/${sids.length} seasons scanned — ${foulOutMap.size} players, ${totalFoulOuts} foul-outs`);
  }
}

// Save final scan progress
if (!DRY_RUN) {
  const foulOutFlat2 = {};
  for (const [uuid, smap] of foulOutMap) {
    foulOutFlat2[uuid] = Object.fromEntries(smap);
  }
  writeJson(PROGRESS_FILE, {
    scannedSids: [...scannedSids],
    foulOutMap: foulOutFlat2,
    techFoulsFound,
    gamesWithBoxScore,
    totalFoulOuts,
    scanComplete: true,
  });
}

console.log(`\n  Scan complete:`);
console.log(`  ${gamesWithBoxScore} games had box score data`);
console.log(`  ${foulOutMap.size} players have at least one foul-out`);
console.log(`  ${totalFoulOuts} total foul-out game instances`);
console.log(`  Tech fouls field present: ${techFoulsFound}`);

// ─── Step 2: write foulOuts into player files ─────────────────────────────────

console.log('\n── Step 2: Writing foulOuts to player files ────────────────────────');
console.log(`  ${foulOutMap.size} player files to update`);

const playersDir = path.join(ROOT, 'players');
let playersUpdated = 0;
let playersSkipped = 0;
sinceLastCommit    = 0;

for (const [uuid, sidMap] of foulOutMap) {
  const prefix     = uuid.slice(0, 2);
  const playerPath = path.join(playersDir, prefix, `${uuid}.json`);

  let player;
  try { player = readJson(playerPath); } catch { playersSkipped++; continue; }

  let modified = false;

  // Career total foul-outs
  const careerFoulOuts = [...sidMap.values()].reduce((a, b) => a + b, 0);
  const bball = player.sports?.Basketball;
  if (bball) {
    if ((bball.foulOuts ?? -1) !== careerFoulOuts) {
      bball.foulOuts = careerFoulOuts;
      modified = true;
    }
  }

  // Per-reg foulOuts — write season-level count to every reg in that season
  // (if player has multiple regs per season, all regs in that season get the
  // same season-total foul-out count; leaderboard can sum or display as-is)
  for (const season of (player.seasons || [])) {
    const sid      = season.sid;
    const foCount  = sidMap.get(sid) ?? 0;
    for (const reg of (season.regs || [])) {
      if (!reg.stats) reg.stats = {};
      if ((reg.stats.foulOuts ?? -1) !== foCount) {
        reg.stats.foulOuts = foCount;
        modified = true;
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
console.log(`  Players with foul-outs      : ${foulOutMap.size}`);
console.log(`  Total foul-out instances    : ${totalFoulOuts}`);
console.log(`  Tech fouls field found      : ${techFoulsFound}`);
console.log(`  Player files updated        : ${playersUpdated}`);
console.log(`  Player files skipped        : ${playersSkipped}`);
console.log(`  Mode                        : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
console.log('\nNext step: node scripts/build-leaderboards.js --force');
console.log('(After updating pushSeason/pushAllTime to include foulOuts field)');
