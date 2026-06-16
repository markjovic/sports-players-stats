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
//
// Memory strategy: fixed-size TopN heap per category — discards entries below the Nth value
// immediately. Memory is O(N × categories) not O(players) — safe for 369k players.

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

// ─── TopN: fixed-size leaderboard — O(N) memory, O(N) insert ────────────────
// Keeps at most `n` entries sorted descending by `v`.
// Once full, new entries with v <= min are discarded without allocation.

class TopN {
  constructor(n) {
    this.n    = n;
    this.arr  = [];  // sorted descending by v, max length n
    this.min  = -Infinity;
  }

  push(entry) {
    if (this.arr.length >= this.n && entry.v <= this.min) return;
    this.arr.push(entry);
    // insertion sort: move new entry into position
    let i = this.arr.length - 1;
    while (i > 0 && this.arr[i].v > this.arr[i - 1].v) {
      const tmp = this.arr[i]; this.arr[i] = this.arr[i - 1]; this.arr[i - 1] = tmp;
      i--;
    }
    if (this.arr.length > this.n) this.arr.length = this.n;
    this.min = this.arr.length === this.n ? this.arr[this.n - 1].v : -Infinity;
  }

  result() { return this.arr; }
}

function emptyBuckets() {
  return {
    pts:     new TopN(TOP_N),
    ppg:     new TopN(TOP_N),
    gp:      new TopN(TOP_N),
    threePt: new TopN(TOP_N),
    fouls:   new TopN(TOP_N),
  };
}

function serialiseBuckets(buckets) {
  const out = {};
  for (const [cat, heap] of Object.entries(buckets)) out[cat] = heap.result();
  return out;
}

// ─── load sports-index ───────────────────────────────────────────────────────

console.log(`Mode: ${ACTIVE_ONLY ? 'ACTIVE ONLY' : 'FULL'}`);
console.log('Loading sports-index.json...');
const sportsIndex = readJson(path.join(ROOT, 'sports-index.json'));

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
    let tsData;
    try { tsData = readJson(path.join(teamStatsDir, `${sid}.json`)); } catch { continue; }
    for (const team of Object.values(tsData)) {
      for (const uuid of Object.keys(team.roster || {})) uuidsToScan.add(uuid);
    }
  }
  console.log(`  ${uuidsToScan.size} player UUIDs to scan`);
}

// ─── accumulators ────────────────────────────────────────────────────────────

const allTime   = emptyBuckets();
const perSeason = new Map(); // sid → buckets

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
    if (uuidsToScan && !uuidsToScan.has(uuid)) continue;

    let player;
    try { player = readJson(path.join(prefixDir, fname)); } catch { skipped++; continue; }

    const name  = player.name || `Player #${uuid.slice(0, 10)}`;
    const bball = player.sports?.Basketball;
    const club  = (player.seasons || []).at(-1)?.club || null;

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
    if (playerCount % 50000 === 0) console.log(`  ${playerCount} players scanned...`);
  }
}

console.log(`  ${playerCount} players scanned, ${skipped} skipped`);

// ─── active-only: merge all-time with existing data ──────────────────────────

let allTimeOut;

if (ACTIVE_ONLY) {
  console.log('\nMerging all-time leaderboard with existing data...');
  const allTimePath = path.join(ROOT, 'leaderboard', 'all-time.json');
  let existing = null;
  try { existing = readJson(allTimePath); } catch { /* first run */ }

  allTimeOut = {};
  const fresh = serialiseBuckets(allTime);
  for (const cat of Object.keys(fresh)) {
    const freshUuids = new Set(fresh[cat].map(e => e.uuid));
    const retained   = existing ? (existing[cat] || []).filter(e => !freshUuids.has(e.uuid)) : [];
    // merge and re-rank using a fresh TopN
    const merged = new TopN(TOP_N);
    for (const e of [...retained, ...fresh[cat]]) merged.push(e);
    allTimeOut[cat] = merged.result();
  }
} else {
  console.log('\nFinalising all-time leaderboards...');
  allTimeOut = serialiseBuckets(allTime);
  for (const [cat, entries] of Object.entries(allTimeOut)) {
    console.log(`  ${cat}: ${entries.length} entries`);
  }
}

// ─── write all-time ──────────────────────────────────────────────────────────

if (!DRY_RUN) writeJson(path.join(ROOT, 'leaderboard', 'all-time.json'), allTimeOut);
console.log('\nWrote leaderboard/all-time.json');

// ─── write per-season ────────────────────────────────────────────────────────

console.log(`\nWriting ${perSeason.size} per-season leaderboard files...`);
let seasonFilesWritten = 0;

for (const [sid, buckets] of perSeason) {
  const p = path.join(ROOT, 'leaderboard', 'season', `${sid}.json`);
  if (!DRY_RUN) writeJson(p, serialiseBuckets(buckets));
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
