// scripts/build-leaderboards.js
//
// Generates leaderboard index files for StatTrack.
//
// Output files:
//   leaderboard/all-time.json          — top 2000 per stat category, career totals
//   leaderboard/season/{sid}.json      — all regs sorted desc, one season, per-reg stats
//
// All-time entry:  { uuid, name, club, sport, gp, v }
// Per-season entry: { uuid, name, club, grade, age, gender, gp, v }
//
// Caps:
//   ALL_TIME_LIMIT = 2000  — deep enough for grade/age/gender filters across every age group
//   Per-season: TopN(5000) — never trims a real season (max ~1500 regs), memory-safe per pass
//
// TWO-PASS STRATEGY (avoids OOM):
//   Pass 1 — all-time: scan all 369k player files once, feed career totals into TopN heap.
//            Write all-time.json. Discard.
//   Pass 2 — per-season: for each season, collect UUIDs from team-stats roster,
//            scan only those player files, build season heaps, write, discard.
//            Only one season's heaps live in memory at a time.
//
// Modes:
//   node scripts/build-leaderboards.js                 — full rebuild
//   node scripts/build-leaderboards.js --active-only   — active seasons only (nightly crawl)
//   node scripts/build-leaderboards.js --dry-run       — no writes, no commits

'use strict';

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));


const ROOT            = path.join(__dirname, '..');
const DRY_RUN         = process.argv.includes('--dry-run');
const ACTIVE_ONLY     = process.argv.includes('--active-only');
const FORCE_FULL      = process.argv.includes('--force'); // ignore progress file, full rebuild
const ALL_TIME_LIMIT  = 2000;
const SEASON_LIMIT    = 5000; // never trims; bounds memory to one season at a time
const PASS2_PROGRESS  = path.join(ROOT, 'scripts', '.build-leaderboards-progress.json');
const COMMIT_INTERVAL = 100;

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

// ─── TopN heap ───────────────────────────────────────────────────────────────

class TopN {
  constructor(n) {
    this.n   = n;
    this.arr = [];
    this.min = -Infinity;
  }
  push(entry) {
    if (this.arr.length >= this.n && entry.v <= this.min) return;
    this.arr.push(entry);
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

const CATS = ['pts', 'ppg', 'gp', 'threePt', 'fouls', 'threePtPG', 'foulsPG', 'foulOuts', 'foulOutsPG', 'finals', 'gfApps', 'gfWins', 'finalsPerSeason'];

function makeBuckets(limit) {
  const b = {};
  for (const cat of CATS) b[cat] = new TopN(limit);
  return b;
}

function serialise(buckets) {
  const out = {};
  for (const [cat, heap] of Object.entries(buckets)) out[cat] = heap.result();
  return out;
}

// ─── load sports-index ───────────────────────────────────────────────────────

console.log(`Mode: ${ACTIVE_ONLY ? 'ACTIVE ONLY' : 'FULL'}${DRY_RUN ? ' + DRY RUN' : ''}`);

// Load team-index to resolve tid → comp
console.log('Loading team-index.json...');
const rawTeamIndex = readJson(path.join(ROOT, 'team-index.json'));
// Flatten to tid → comp map
const tidToComp = new Map();
for (const entries of Object.values(rawTeamIndex)) {
  for (const entry of entries) {
    if (entry.id && entry.comp) tidToComp.set(entry.id, entry.comp);
  }
}
console.log(`  ${tidToComp.size} team→comp mappings loaded`);

console.log('Loading sports-index.json...');
const sportsIndex = readJson(path.join(ROOT, 'sports-index.json'));

const activeSids = new Set(
  Object.values(sportsIndex.seasons)
    .filter(s => !s.locked)
    .map(s => s.id)
);
// sid → orgName for org field on leaderboard entries
const sidToOrg = new Map(
  Object.values(sportsIndex.seasons).map(s => [s.id, s.orgName || ''])
);
console.log(`  ${Object.keys(sportsIndex.seasons).length} total seasons, ${activeSids.size} active`);

const targetSids = ACTIVE_ONLY ? activeSids : null; // null = all seasons

// ─── helpers ─────────────────────────────────────────────────────────────────

const playersDir = path.join(ROOT, 'players');
const prefixDirs = fs.readdirSync(playersDir)
  .filter(d => /^[0-9a-f]{2}$/.test(d))
  .sort();

function readPlayer(uuid) {
  const p = path.join(playersDir, uuid.slice(0, 2), `${uuid}.json`);
  try { return readJson(p); } catch { return null; }
}

function pushAllTime(buckets, player) {
  const uuid     = player.uuid;
  const name     = player.name || `Player #${uuid.slice(0, 10)}`;
  const bball    = player.sports?.Basketball;
  const lastSeason = (player.seasons || []).at(-1);
  const club     = lastSeason?.club || null;
  // Most recently seen team: last reg of last season
  const lastReg  = (lastSeason?.regs || []).at(-1);
  const team     = lastReg?.tn  || null;
  const org      = sidToOrg.get(lastSeason?.sid) || null;
  if (!bball || typeof bball.gp !== 'number' || bball.gp < 1) return;
  const careerFoulOuts   = bball.foulOuts ?? 0;
  const careerFoulOutsPG = bball.gp > 0 ? Math.round((careerFoulOuts / bball.gp) * 1000) / 1000 : 0;
  const careerThreePtPG  = bball.gp > 0 ? Math.round(((bball.threePt ?? 0) / bball.gp) * 100) / 100 : 0;
  const careerFoulsPG    = bball.gp > 0 ? Math.round(((bball.fouls   ?? 0) / bball.gp) * 100) / 100 : 0;
  const careerFinals          = bball.finals          ?? 0;
  const careerGfApps          = bball.gfApps          ?? 0;
  const careerGfWins          = bball.gfWins          ?? 0;
  const careerFinalsPerSeason = bball.finalsPerSeason  ?? 0;
  const base = { uuid, name, club, team, org, sport: 'Basketball', gp: bball.gp,
    foulOuts: careerFoulOuts, foulOutsPG: careerFoulOutsPG,
    threePtPG: careerThreePtPG, foulsPG: careerFoulsPG,
    finals: careerFinals, gfApps: careerGfApps, gfWins: careerGfWins,
    finalsPerSeason: careerFinalsPerSeason,
  };

  if (typeof bball.pts     === 'number') buckets.pts    .push({ ...base, v: bball.pts });
  if (typeof bball.gp      === 'number') buckets.gp     .push({ ...base, v: bball.gp });
  if (typeof bball.threePt === 'number') buckets.threePt.push({ ...base, v: bball.threePt });
  if (typeof bball.fouls   === 'number') buckets.fouls  .push({ ...base, v: bball.fouls });
  if (careerThreePtPG > 0)  buckets.threePtPG .push({ ...base, v: careerThreePtPG });
  if (careerFoulsPG   > 0)  buckets.foulsPG   .push({ ...base, v: careerFoulsPG });
  if (careerFoulOuts  > 0)  buckets.foulOuts  .push({ ...base, v: careerFoulOuts });
  if (careerFoulOutsPG    > 0) buckets.foulOutsPG    .push({ ...base, v: careerFoulOutsPG });
  if (careerFinals        > 0) buckets.finals        .push({ ...base, v: careerFinals });
  if (careerGfApps        > 0) buckets.gfApps        .push({ ...base, v: careerGfApps });
  if (careerGfWins        > 0) buckets.gfWins        .push({ ...base, v: careerGfWins });
  if (careerFinalsPerSeason  > 0) buckets.finalsPerSeason .push({ ...base, v: careerFinalsPerSeason });
  if (typeof bball.pts     === 'number') {
    buckets.ppg.push({ ...base, v: Math.round((bball.pts / bball.gp) * 10) / 10 });
  }
}

function pushSeason(buckets, player, sid) {
  const uuid   = player.uuid;
  const name   = player.name || `Player #${uuid.slice(0, 10)}`;
  const gender = player.gender || null;
  for (const season of (player.seasons || [])) {
    if (season.sid !== sid) continue;
    const sClub = season.club || null;
    for (const reg of (season.regs || [])) {
      const stats = reg.stats || {};
      const gp    = stats.gp;
      if (typeof gp !== 'number' || gp < 1) continue;
      const comp = tidToComp.get(reg.tid) || '';
      const org  = sidToOrg.get(sid) || '';
      const foulOuts   = reg.stats?.foulOuts ?? 0;
      const foulOutsPG = gp > 0 ? Math.round((foulOuts / gp) * 1000) / 1000 : 0;
      const threePtPG  = gp > 0 ? Math.round(((reg.stats?.threePt ?? 0) / gp) * 100) / 100 : 0;
      const foulsPG    = gp > 0 ? Math.round(((reg.stats?.fouls   ?? 0) / gp) * 100) / 100 : 0;
      const finals          = reg.stats?.finals         ?? 0;
      const gfApps          = reg.stats?.gfApps         ?? 0;
      const gfWins          = reg.stats?.gfWins         ?? 0;
      const base = {
        uuid, name,
        club:   sClub,
        team:   reg.tn  || '',
        org,
        comp,
        grade:  reg.gn  || '',
        age:    reg.age || '',
        gender: gender  || '',
        gp,
        foulOuts,
        foulOutsPG,
        threePtPG,
        foulsPG,
        finals,
        gfApps,
        gfWins,
      };
      if (typeof stats.pts     === 'number') buckets.pts    .push({ ...base, v: stats.pts });
      if (typeof stats.gp      === 'number') buckets.gp     .push({ ...base, v: stats.gp });
      if (typeof stats.threePt === 'number') buckets.threePt.push({ ...base, v: stats.threePt });
      if (typeof stats.fouls   === 'number') buckets.fouls  .push({ ...base, v: stats.fouls });
      if (threePtPG  > 0) buckets.threePtPG .push({ ...base, v: threePtPG });
      if (foulsPG    > 0) buckets.foulsPG   .push({ ...base, v: foulsPG });
      if (foulOuts   > 0) buckets.foulOuts  .push({ ...base, v: foulOuts });
      if (foulOutsPG > 0) buckets.foulOutsPG.push({ ...base, v: foulOutsPG });
      if (finals     > 0) buckets.finals    .push({ ...base, v: finals });
      if (gfApps     > 0) buckets.gfApps    .push({ ...base, v: gfApps });
      if (gfWins        > 0) buckets.gfWins       .push({ ...base, v: gfWins });
                              if (typeof stats.pts     === 'number') {
        buckets.ppg.push({ ...base, v: Math.round((stats.pts / gp) * 10) / 10 });
      }
    }
    break; // found this season — no need to keep scanning
  }
}

// ─── PASS 1: all-time ────────────────────────────────────────────────────────

console.log('\n── Pass 1: all-time leaderboard ────────────────────────────');
const allTime = makeBuckets(ALL_TIME_LIMIT);
let playerCount = 0;
let skipped     = 0;

for (const prefix of prefixDirs) {
  const prefixDir = path.join(playersDir, prefix);
  const files = fs.readdirSync(prefixDir).filter(f => f.endsWith('.json'));
  for (const fname of files) {
    const uuid = fname.replace('.json', '');
    // In active-only mode still scan all players for all-time (career totals need full history)
    let player;
    try { player = readJson(path.join(prefixDir, fname)); } catch { skipped++; continue; }
    pushAllTime(allTime, player);
    playerCount++;
    if (playerCount % 50000 === 0) console.log(`  ${playerCount} players scanned...`);
  }
}

console.log(`  ${playerCount} players scanned, ${skipped} skipped`);

// active-only: merge with existing all-time
let allTimeOut;
if (ACTIVE_ONLY) {
  console.log('  Merging with existing all-time.json...');
  const allTimePath = path.join(ROOT, 'leaderboard', 'all-time.json');
  let existing = null;
  try { existing = readJson(allTimePath); } catch {}
  allTimeOut = {};
  const fresh = serialise(allTime);
  for (const cat of CATS) {
    const freshUuids = new Set(fresh[cat].map(e => e.uuid));
    const retained   = existing ? (existing[cat] || []).filter(e => !freshUuids.has(e.uuid)) : [];
    const merged = new TopN(ALL_TIME_LIMIT);
    for (const e of [...retained, ...fresh[cat]]) merged.push(e);
    allTimeOut[cat] = merged.result();
  }
} else {
  allTimeOut = serialise(allTime);
  for (const [cat, entries] of Object.entries(allTimeOut)) {
    console.log(`  ${cat}: ${entries.length} entries`);
  }
}

if (!DRY_RUN) writeJson(path.join(ROOT, 'leaderboard', 'all-time.json'), allTimeOut);
console.log('  Wrote leaderboard/all-time.json');

// ─── PASS 2: per-season (one season at a time) ───────────────────────────────

console.log('\n── Pass 2: per-season leaderboards ─────────────────────────');
const teamStatsDir = path.join(ROOT, 'team-stats', 'bv');
const tsFiles = fs.readdirSync(teamStatsDir)
  .filter(f => f.endsWith('.json'))
  .filter(f => !targetSids || targetSids.has(f.replace('.json', '')))
  .sort();

console.log(`  ${tsFiles.length} season files to process`);

// Load pass 2 progress — resume from last committed point
let doneSids = new Set();
if (FORCE_FULL && fs.existsSync(PASS2_PROGRESS)) {
  if (!DRY_RUN) fs.unlinkSync(PASS2_PROGRESS);
  console.log('  --force: progress file cleared, full rebuild');
} else if (fs.existsSync(PASS2_PROGRESS)) {
  try { doneSids = new Set((readJson(PASS2_PROGRESS).done || [])); } catch {}
  if (doneSids.size > 0) console.log(`  Resuming — ${doneSids.size} season files already done`);
}

let seasonFilesWritten = 0;
let seasonFilesSkipped = 0;
let sinceLastCommit    = 0;

for (const fname of tsFiles) {
  const sid = fname.replace('.json', '');

  if (doneSids.has(sid)) { seasonFilesSkipped++; continue; }

  let tsData;
  try { tsData = readJson(path.join(teamStatsDir, fname)); } catch { doneSids.add(sid); seasonFilesSkipped++; continue; }

  const uuids = new Set();
  for (const team of Object.values(tsData)) {
    for (const uuid of Object.keys(team.roster || {})) uuids.add(uuid);
  }

  if (uuids.size === 0) { doneSids.add(sid); seasonFilesSkipped++; continue; }

  const buckets = makeBuckets(SEASON_LIMIT);
  for (const uuid of uuids) {
    const player = readPlayer(uuid);
    if (!player) continue;
    pushSeason(buckets, player, sid);
  }

  const out = serialise(buckets);
  const hasData = CATS.some(cat => out[cat].length > 0);
  if (!hasData) { doneSids.add(sid); seasonFilesSkipped++; continue; }

  if (!DRY_RUN) writeJson(path.join(ROOT, 'leaderboard', 'season', `${sid}.json`), out);
  doneSids.add(sid);
  seasonFilesWritten++;
  sinceLastCommit++;

  if (sinceLastCommit >= COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      writeJson(PASS2_PROGRESS, { done: [...doneSids] });
      gitCommit(
        `build-leaderboards: pass 2 — ${seasonFilesWritten} season files written`,
        ['leaderboard/season/', 'scripts/.build-leaderboards-progress.json']
      );
    }
    sinceLastCommit = 0;
    console.log(`  ${seasonFilesWritten + seasonFilesSkipped} of ${tsFiles.length} seasons done (${seasonFilesWritten} written)...`);
  }
}

if (!DRY_RUN && sinceLastCommit > 0) {
  writeJson(PASS2_PROGRESS, { done: [...doneSids] });
}

// ─── commit ──────────────────────────────────────────────────────────────────

if (!DRY_RUN) {
  const label = ACTIVE_ONLY ? 'active seasons' : 'full rebuild';
  gitCommit(
    `build-leaderboards: ${label} — ${seasonFilesWritten} season files`,
    ['leaderboard/', 'scripts/.build-leaderboards-progress.json']
  );
}

// ─── summary ─────────────────────────────────────────────────────────────────

console.log('\n─── Summary ─────────────────────────────────────────────────');
console.log(`  Mode                     : ${ACTIVE_ONLY ? 'ACTIVE ONLY' : 'FULL'}${DRY_RUN ? ' + DRY RUN' : ''}`);
console.log(`  Players scanned (pass 1) : ${playerCount}`);
console.log(`  Per-season files written : ${seasonFilesWritten}`);
console.log(`  Per-season files skipped : ${seasonFilesSkipped} (no roster data)`);
