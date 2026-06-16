// scripts/build-leaderboards.js
//
// Generates leaderboard index files for StatTrack.
//
// Output files:
//   leaderboard/all-time.json          — top 200 per stat category, all seasons, career totals
//   leaderboard/season/{sid}.json      — top 200 per stat category, one season, per-reg stats
//
// All-time entry:
//   { uuid, name, club, sport, gp, v }        (ppg entries include gp for min-GP filter)
//
// Per-season entry:
//   { uuid, name, club, grade, age, gender, gp, v }
//
// Categories: pts, ppg, gp, threePt, fouls
// PPG computed as pts/gp — only included when gp >= 1
// One entry per registration (reg) for per-season files — no cross-reg aggregation.
//
// Modes:
//   node scripts/build-leaderboards.js                 — full rebuild (all players, all seasons)
//   node scripts/build-leaderboards.js --active-only   — active seasons only (nightly crawl)
//   node scripts/build-leaderboards.js --dry-run       — no writes, no commits
//
// --active-only strategy:
//   1. Read sports-index.json → collect active season IDs (locked: false)
//   2. Read team-stats/bv/{sid}.json for each active season → collect player UUIDs
//   3. Scan only those player files → update per-season leaderboards for active seasons
//   4. Rebuild all-time.json by merging updated player career totals into existing all-time data

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const DRY_RUN     = process.argv.includes('--dry-run');
const ACTIVE_ONLY = process.argv.includes('--active-only');
const TOP_N       = 200;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
}

function gitCommit(message, dirs) {
  try {
    execSync(`git add ${dirs.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) { console.log('  nothing to commit'); return; }
    execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ committed: ${message}`);
  } catch (e) {
    console.error(`  ✗ git error: ${e.message}`);
  }
}

function topN(arr, n) {
  return arr.sort((a, b) => b.v - a.v).slice(0, n);
}

function emptyBuckets() {
  return { pts: [], ppg: [], gp: [], threePt: [], fouls: [] };
}

// ─── load sports-index ───────────────────────────────────────────────────────

console.log(`Mode: ${ACTIVE_ONLY ? 'ACTIVE ONLY' : 'FULL'}`);
console.log('Loading sports-index.json...');
const sportsIndex = readJson(path.join(ROOT, 'sports-index.json'));

// active season IDs (locked: false)
const activeSids = new Set(
  Object.values(sportsIndex.seasons)
    .filter(s => !s.locked)
    .map(s => s.id)
);
console.log(`  ${Object.keys(sportsIndex.seasons).length} total seasons, ${activeSids.size} active`);

// ─── determine which player UUIDs to scan ────────────────────────────────────

let uuidsToScan = null; // null = scan all

if (ACTIVE_ONLY) {
  console.log('\nCollecting player UUIDs from active season rosters...');
  uuidsToScan = new Set();
  const teamStatsDir = path.join(ROOT, 'team-stats', 'bv');

  for (const sid of activeSids) {
    const tsPath = path.join(teamStatsDir, `${sid}.json`);
    let tsData;
    try { tsData = readJson(tsPath); } catch { continue; }
    for (const team of Object.values(tsData)) {
      for (const uuid of Object.keys(team.roster || {})) {
        uuidsToScan.add(uuid);
      }
    }
  }
  console.log(`  ${uuidsToScan.size} player UUIDs to scan`);
}

// ─── accumulators ────────────────────────────────────────────────────────────

const allTime  = emptyBuckets();       // career totals — all players (full) or active subset
const perSeason = new Map();           // sid → buckets

function getOrCreateSeason(sid) {
  if (!perSeason.has(sid)) perSeason.set(sid, emptyBuckets());
  return perSeason.get(sid);
}

// ─── scan player files ───────────────────────────────────────────────────────

console.log('\nScanning player detail files...');
const playersDir = path.join(ROOT, 'players');
const prefixDirs = fs.readdirSync(playersDir)
  .filter(d => /^[0-9a-f]{2}$/.test(d))
  .sort();

let playerCount = 0;
let skipped     = 0;

for (const prefix of prefixDirs) {
  const prefixDir = path.join(playersDir, prefix);
  const files = fs.readdirSync(prefixDir).filter(f => f.endsWith('.json'));

  for (const fname of files) {
    const uuid = fname.replace('.json', '');

    // in active-only mode, skip players not in active rosters
    if (uuidsToScan && !uuidsToScan.has(uuid)) continue;

    let player;
    try { player = readJson(path.join(prefixDir, fname)); } catch { skipped++; continue; }

    const name  = player.name || `Player #${uuid.slice(0, 10)}`;
    const bball = player.sports?.Basketball;
    const lastSeason = (player.seasons || []).at(-1);
    const club  = lastSeason?.club || null;

    // ── all-time ─────────────────────────────────────────────────────────────
    if (bball && typeof bball.gp === 'number' && bball.gp > 0) {
      const base = { uuid, name, club, sport: 'Basketball', gp: bball.gp };
      if (typeof bball.pts     === 'number') allTime.pts    .push({ ...base, v: bball.pts });
      if (typeof bball.gp      === 'number') allTime.gp     .push({ ...base, v: bball.gp });
      if (typeof bball.threePt === 'number') allTime.threePt.push({ ...base, v: bball.threePt });
      if (typeof bball.fouls   === 'number') allTime.fouls  .push({ ...base, v: bball.fouls });
      if (typeof bball.pts     === 'number') {
        allTime.ppg.push({ ...base, v: Math.round((bball.pts / bball.gp) * 10) / 10 });
      }
    }

    // ── per-season: one entry per reg ─────────────────────────────────────────
    // In active-only mode, only process regs belonging to active seasons.
    for (const season of (player.seasons || [])) {
      const sid = season.sid;
      if (ACTIVE_ONLY && !activeSids.has(sid)) continue;

      const sClub  = season.club || null;
      const gender = player.gender || null;
      const bucket = getOrCreateSeason(sid);

      for (const reg of (season.regs || [])) {
        const stats = reg.stats || {};
        const gp    = stats.gp;
        if (typeof gp !== 'number' || gp < 1) continue;

        const base = {
          uuid,
          name,
          club:   sClub,
          grade:  reg.gn  || '',
          age:    reg.age || '',
          gender: gender  || '',
          gp,
        };

        if (typeof stats.pts     === 'number') bucket.pts    .push({ ...base, v: stats.pts });
        if (typeof stats.gp      === 'number') bucket.gp     .push({ ...base, v: stats.gp });
        if (typeof stats.threePt === 'number') bucket.threePt.push({ ...base, v: stats.threePt });
        if (typeof stats.fouls   === 'number') bucket.fouls  .push({ ...base, v: stats.fouls });
        if (typeof stats.pts     === 'number') {
          bucket.ppg.push({ ...base, v: Math.round((stats.pts / gp) * 10) / 10 });
        }
      }
    }

    playerCount++;
    if (playerCount % 50000 === 0) {
      console.log(`  ${playerCount} players scanned...`);
    }
  }
}

console.log(`  ${playerCount} players scanned, ${skipped} skipped`);

// ─── active-only: merge all-time with existing all-time.json ─────────────────
//
// We only scanned active-season players, so we can't rebuild all-time from scratch.
// Strategy: load existing all-time.json, remove entries for UUIDs we just re-scanned
// (their career totals may have changed), then merge in the fresh entries and re-rank.

let allTimeOut;

if (ACTIVE_ONLY) {
  console.log('\nMerging all-time leaderboard with existing data...');
  const allTimePath = path.join(ROOT, 'leaderboard', 'all-time.json');
  let existing = null;
  try { existing = readJson(allTimePath); } catch { /* first run */ }

  allTimeOut = {};
  for (const cat of Object.keys(allTime)) {
    const freshUuids = new Set(allTime[cat].map(e => e.uuid));
    const retained   = existing
      ? (existing[cat] || []).filter(e => !freshUuids.has(e.uuid))
      : [];
    allTimeOut[cat] = topN([...retained, ...allTime[cat]], TOP_N);
  }
} else {
  console.log('\nSorting all-time leaderboards...');
  allTimeOut = {};
  for (const cat of Object.keys(allTime)) {
    allTimeOut[cat] = topN(allTime[cat], TOP_N);
    console.log(`  ${cat}: ${allTimeOut[cat].length} entries`);
  }
}

// ─── write all-time ──────────────────────────────────────────────────────────

const allTimePath = path.join(ROOT, 'leaderboard', 'all-time.json');
if (!DRY_RUN) writeJson(allTimePath, allTimeOut);
console.log('\nWrote leaderboard/all-time.json');

// ─── write per-season ────────────────────────────────────────────────────────

console.log(`\nWriting ${perSeason.size} per-season leaderboard files...`);
let seasonFilesWritten = 0;

for (const [sid, cats] of perSeason) {
  const out = {};
  for (const cat of Object.keys(cats)) {
    out[cat] = topN(cats[cat], TOP_N);
  }
  const p = path.join(ROOT, 'leaderboard', 'season', `${sid}.json`);
  if (!DRY_RUN) writeJson(p, out);
  seasonFilesWritten++;
}

console.log(`  ${seasonFilesWritten} season files written`);

// ─── commit ──────────────────────────────────────────────────────────────────

if (!DRY_RUN) {
  const label = ACTIVE_ONLY ? 'active seasons' : 'full rebuild';
  gitCommit(
    `build-leaderboards: ${label} — ${seasonFilesWritten} season files`,
    ['leaderboard/']
  );
}

// ─── summary ─────────────────────────────────────────────────────────────────

console.log('\n─── Summary ─────────────────────────────────────────────────');
console.log(`  Mode                     : ${ACTIVE_ONLY ? 'ACTIVE ONLY' : 'FULL'}${DRY_RUN ? ' + DRY RUN' : ''}`);
console.log(`  Players scanned          : ${playerCount}`);
console.log(`  Players skipped          : ${skipped}`);
console.log(`  All-time categories      : ${Object.keys(allTimeOut).length}`);
console.log(`  Per-season files         : ${seasonFilesWritten}`);
