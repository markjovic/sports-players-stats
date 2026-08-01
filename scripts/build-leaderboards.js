// scripts/build-leaderboards.js
//
// Generates leaderboard index files for StatTrack.
//
// Output files:
//   leaderboard/all-time.json          — top 2000 per stat category, career totals
//   leaderboard/season/{sid}.json      — { players: { "uuid|tid": {...raw stats} } }
//                                         NO pre-sorted per-category arrays — StatTrack
//                                         computes rankings client-side from raw fields
//                                         (removed ~Jul 2026: 17 redundant {id,v} arrays
//                                         per file were pure overhead — SEASON_LIMIT was
//                                         already "effectively unlimited", so they held
//                                         the same ~500-1500 ids as the players map, just
//                                         repeated up to 17x).
//
// All-time entry:  { uuid, name, club, sport, gp, v }
// Per-season entry (players map): { n, team, org, comp, grade, age, gender, gp,
//   foulOuts, foulOutsPG, threePtPG, foulsPG, finals, gfApps, gfWins,
//   pts, threePt, fouls, wins, losses, draws, club? }
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
//   node scripts/build-leaderboards.js --active-only   — active seasons only (weekly chain)
//   node scripts/build-leaderboards.js --dry-run       — no writes, no commits
//
// 2026-07-10: uuid values written to all-time entries and season "uuid|tid" map
// keys are truncated via truncateUuid() — TRUNC_LEN, currently 13 (see
// scripts/lib/uuid-prefix.cjs). Comment corrected 2026-07-31: it said "10-char
// prefix", which was the REJECTED length (10 chars is only 9 hex digits — the
// first hyphen sits at index 8 — so ~36 bits and ~63% birthday-collision odds at
// ~370k players). The CODE was always right: L248/L305 call truncateUuid(), and
// every alias key in production is 13 chars. Only this comment was wrong —
// part of the UUID-storage-footprint reduction. Every player uuid used in this
// file is now sourced from the player file's own filename (never player.uuid,
// a body field docs say was stripped in June 2026 — pushAllTime/pushSeason
// used to silently re-derive it from the body instead of the filename their
// callers already had on hand; fixed here to match every other pipeline
// script, which all derive uuid from the filename).

'use strict';

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { truncateUuid } from './lib/uuid-prefix.cjs';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));


const ROOT            = path.join(__dirname, '..');
const DRY_RUN         = process.argv.includes('--dry-run');
const ACTIVE_ONLY     = process.argv.includes('--active-only');
const MODE            = ACTIVE_ONLY ? 'active' : 'full';
const FORCE_FULL      = process.argv.includes('--force'); // ignore progress file, full rebuild
const ALL_TIME_LIMIT  = 2000;

const ALL_TIME_CATS = ['pts','ppg','gp','threePt','fouls','threePtPG','foulsPG','foulOuts','foulOutsPG','finals','gfApps','gfWins','finalsPerSeason','maxGamePTS','maxGameThreePt','wins','losses','draws','winPct','lossPct'];
// SEASON_CATS list moved to StatTrack's client-side statValueForPlayer() — season
// files now ship only the players map (see pushSeason), computed on demand there.
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
  // Staging: PER-PATH adds — `git add` is ATOMIC across pathspecs, so one
  // combined add with any unmatched pathspec stages NOTHING (this exact bug
  // silently discarded a whole discover-fixtures run, 2026-07-19). Per-path,
  // a miss skips only itself and is logged. --shortstat (never --stat: --stat
  // prints per-file lines and scales with file count — real ENOBUFS risk on a
  // repo this size, confirmed 2026-07-10) is printed so the log proves what
  // was staged. COMMIT FIRST, then fetch/merge/push with the proven retry
  // pattern copied from build-win-loss.js (60 attempts, random 1-91s jitter,
  // merge --abort cleanup, merge -X ours --no-stat — merge's default diffstat
  // is the same ENOBUFS class, scaling with what landed on main since the
  // fetch). THROW on total push failure — a red job beats silently discarded
  // work.
  if (!dirs || !dirs.length) { console.error('  gitCommit: no paths given — refusing blanket add'); return; }
  try {
    for (const dir of dirs) {
      try {
        execSync(`git add ${dir}`, { stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
      } catch (e) {
        console.error(`  staging miss (skipped): ${dir} — ${e.stderr?.toString().slice(0, 120) || e.message.slice(0, 120)}`);
      }
    }
    const staged = execSync('git diff --staged --shortstat',
      { stdio: 'pipe', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).toString().trim();
    if (!staged) { console.log('  nothing to commit'); return; }
    console.log(`  staging: ${staged}`);
    execSync(`git commit -q -m "${message}"`, { stdio: 'pipe', cwd: ROOT });
  } catch (e) {
    console.error('  git error (stage/commit):', e.stderr?.toString().slice(0, 200) || e.message.slice(0, 200));
    return;
  }
  for (let attempt = 1; attempt <= 60; attempt++) {
    try { execSync('git merge --abort', { stdio: 'pipe', cwd: ROOT }); } catch (_) { /* none in progress */ }
    try {
      execSync('git fetch origin main',                            { stdio: 'pipe', cwd: ROOT });
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main',                             { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✔ committed: ${message}`);
      return;
    } catch (e) {
      if (attempt === 60) {
        console.error('  git push failed after 60 attempts:', e.stderr?.toString().slice(0, 200) || e.message.slice(0, 200));
        throw e;
      }
      const s = 1 + Math.floor(Math.random() * 91);
      execSync(`sleep ${s}`, { stdio: 'pipe', cwd: ROOT });
    }
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


function makeBuckets(cats, limit) {
  const b = {};
  for (const cat of cats) b[cat] = new TopN(limit);
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
const rawTeamIndex = readJson(path.join(ROOT, 'data', 'team-index.json'));
// Flatten to tid → comp map
const tidToComp = new Map();
for (const entries of Object.values(rawTeamIndex)) {
  for (const entry of entries) {
    if (entry.id && entry.comp) tidToComp.set(entry.id, entry.comp);
  }
}
console.log(`  ${tidToComp.size} team→comp mappings loaded`);

console.log('Loading sports-index.json...');
const sportsIndex = readJson(path.join(ROOT, 'data', 'sports-index.json'));

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

// Load forfeit games — used to exclude contaminated maxGamePTS/maxGameThreePt entries
const FORFEIT_FILE   = path.join(ROOT, 'data', 'forfeit-games.json');
const forfeitGameIds = new Set();
try {
  const ids = readJson(FORFEIT_FILE);
  for (const id of (Array.isArray(ids) ? ids : [])) forfeitGameIds.add(id);
  console.log(`  ${forfeitGameIds.size} forfeit games loaded`);
} catch (_) {
  console.log('  forfeit-games.json not found — maxGamePTS/maxGameThreePt unfiltered');
}

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

// uuid is always the FULL player uuid, passed in by the caller (derived from
// the player file's own filename — see the pass 1/pass 2 loops below). Never
// read player.uuid here; that's a body field, not guaranteed present for
// every player file, unlike the filename.
function pushAllTime(buckets, player, uuid) {
  // 2026-07-31: was `uuid.slice(0, 10)` — a hardcoded truncation in a placeholder
  // minter, which the house rule forbids: every minter must use TRUNC_LEN so the
  // same player gets the SAME placeholder name from every script. With a hardcoded
  // 10 here and TRUNC_LEN 13 elsewhere, a player's placeholder name flipped between
  // two forms depending on which script wrote last, dirtying the file every run.
  const name     = player.name || `Player #${truncateUuid(uuid)}`;
  const bball    = player.sports?.Basketball;
  const lastSeason = (player.seasons || []).at(-1);
  const club     = lastSeason?.club || null;
  // Most recently seen team: last reg of last season
  const lastReg  = (lastSeason?.regs || []).at(-1);
  const team     = lastReg?.tn  || null;
  const org      = sidToOrg.get(lastSeason?.sid) || null;
  if (!bball || typeof bball.gp !== 'number' || bball.gp < 1) return;
  // foulOuts may be a number (old format) or { seasonId: count } object (new format)
  const rawFoulOuts    = bball.foulOuts ?? 0;
  const careerFoulOuts = typeof rawFoulOuts === 'object' && rawFoulOuts !== null
    ? Object.values(rawFoulOuts).reduce((a, b) => a + b, 0)
    : (typeof rawFoulOuts === 'number' ? rawFoulOuts : 0);
  const careerFoulOutsPG = bball.gp > 0 ? Math.round((careerFoulOuts / bball.gp) * 1000) / 1000 : 0;
  const careerThreePtPG  = bball.gp > 0 ? Math.round(((bball.threePt ?? 0) / bball.gp) * 100) / 100 : 0;
  const careerFoulsPG    = bball.gp > 0 ? Math.round(((bball.fouls   ?? 0) / bball.gp) * 100) / 100 : 0;
  const careerFinals          = bball.finals          ?? 0;
  const careerGfApps          = bball.gfApps          ?? 0;
  const careerGfWins          = bball.gfWins          ?? 0;
  const careerFinalsPerSeason = bball.finalsPerSeason  ?? 0;
  const gender   = player.gender || '';
  // Age: most recent reg's age group — best single value for a career-spanning player
  const age      = lastReg?.age || '';
  const base = { uuid: truncateUuid(uuid), name, club, team, org, sport: 'Basketball', gp: bball.gp,
    foulOuts: careerFoulOuts, foulOutsPG: careerFoulOutsPG,
    threePtPG: careerThreePtPG, foulsPG: careerFoulsPG,
    finals: careerFinals, gfApps: careerGfApps, gfWins: careerGfWins,
    finalsPerSeason: careerFinalsPerSeason,
    gender, age,
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
  if (typeof bball.wins    === 'number' && bball.wins > 0)    buckets.wins   .push({ ...base, v: bball.wins });
  if (typeof bball.losses  === 'number' && bball.losses > 0)  buckets.losses .push({ ...base, v: bball.losses });
  if (typeof bball.draws   === 'number' && bball.draws > 0)   buckets.draws  .push({ ...base, v: bball.draws });
  // winPct only meaningful with sufficient games — require at least 10 GP
  if (typeof bball.winPct  === 'number' && bball.gp >= 10)    buckets.winPct .push({ ...base, v: Math.round(bball.winPct * 100) });
  // lossPct — same 10 GP minimum
  if (typeof bball.losses  === 'number' && bball.gp >= 10) {
    const total = (bball.wins || 0) + (bball.losses || 0) + (bball.draws || 0);
    if (total > 0) buckets.lossPct.push({ ...base, v: Math.round((bball.losses / total) * 100) });
  }
  if (typeof bball.pts     === 'number') {
    buckets.ppg.push({ ...base, v: Math.round((bball.pts / bball.gp) * 10) / 10 });
  }
  // Single-game records — skip if gameKey resolves to a known forfeit game
  if (typeof bball.maxGamePTS === 'number' && bball.maxGamePTS > 0) {
    const gameKey = player.records?.maxGamePTS?.gameKey;
    if (!gameKey || !forfeitGameIds.has(gameKey))
      buckets.maxGamePTS.push({ ...base, v: bball.maxGamePTS });
  }
  if (typeof bball.maxGameThreePt === 'number' && bball.maxGameThreePt > 0) {
    const gameKey = player.records?.maxGameThreePt?.gameKey;
    if (!gameKey || !forfeitGameIds.has(gameKey))
      buckets.maxGameThreePt.push({ ...base, v: bball.maxGameThreePt });
  }
}

// uuid is always the FULL player uuid — see pushAllTime's comment above.
function pushSeason(players, player, sid, uuid) {
  // See L224 — same hardcoded-truncation fix.
  const name   = player.name || `Player #${truncateUuid(uuid)}`;
  const gender = player.gender || null;
  for (const season of (player.seasons || [])) {
    if (season.sid !== sid) continue;
    const sClub = season.club || null;
    for (const reg of (season.regs || [])) {
      const stats = reg.stats || {};
      const gp    = stats.gp;
      if (typeof gp !== 'number' || gp < 1) continue;
      // ⚠️ REVERTED 2026-08-01. This was briefly `${truncateUuid(uuid)}|${reg.tid}|${reg.gid || ''}`
      // on the reasoning that, since a reg is a (team, grade) registration (decision A),
      // a regraded team should produce one season row per grade — and that the old
      // uuid|tid key was silently dropping one of them, because L340 ASSIGNS.
      //
      // MEASURED AFTERWARDS, and the reasoning was wrong: regrade regs hold the SAME
      // team-season totals on every grade. Of ~913,000 regrade groups, the copies are
      // byte-identical apart from `foulOuts`, which lands on whichever copy the
      // foul-out writer matched first. gp/pts/fg/ft/threePt/fouls/wins/losses agree
      // across grades in every sample.
      //
      // So the API reports per-TEAM season totals and repeats them on each grade
      // registration. Keying by grade therefore produces TWO leaderboard rows with
      // identical stats for one player, and the ASSIGN it replaced was not losing
      // anything — both copies said the same thing. uuid|tid is correct.
      const id         = `${truncateUuid(uuid)}|${reg.tid}`;
      const comp       = tidToComp.get(reg.tid) || '';
      const org        = sidToOrg.get(sid) || '';
      const foulOuts   = stats.foulOuts   ?? 0;
      const foulOutsPG = gp > 0 ? Math.round((foulOuts / gp) * 1000) / 1000 : 0;
      const threePtPG  = gp > 0 ? Math.round(((stats.threePt ?? 0) / gp) * 100) / 100 : 0;
      const foulsPG    = gp > 0 ? Math.round(((stats.fouls   ?? 0) / gp) * 100) / 100 : 0;
      const finals     = stats.finals ?? 0;
      const gfApps     = stats.gfApps ?? 0;
      const gfWins     = stats.gfWins ?? 0;
      // Every raw field needed to derive all 17 SEASON_CATS client-side, so the
      // per-category {id,v} arrays below are no longer written at all — this
      // players map is now the ONLY thing a season file contains besides it.
      const playerEntry = {
        n: name, team: reg.tn || '', org, comp,
        grade: reg.gn || '', age: reg.age || '', gender: gender || '',
        gp, foulOuts, foulOutsPG, threePtPG, foulsPG, finals, gfApps, gfWins,
        pts: stats.pts, threePt: stats.threePt, fouls: stats.fouls,
        wins: stats.wins, losses: stats.losses, draws: stats.draws,
      };
      // Strip undefined values (e.g. stats.pts missing) rather than serialise
      // them as explicit nulls — keeps the file no larger than it needs to be.
      for (const k of Object.keys(playerEntry)) if (playerEntry[k] === undefined) delete playerEntry[k];
      if (sClub) playerEntry.club = sClub;
      players[id] = playerEntry;
    }
    break;
  }
}

// ─── PASS 1: all-time ────────────────────────────────────────────────────────

console.log('\n── Pass 1: all-time leaderboard ────────────────────────────');
const allTime = makeBuckets(ALL_TIME_CATS, ALL_TIME_LIMIT);
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
    pushAllTime(allTime, player, uuid);
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
  for (const cat of ALL_TIME_CATS) {
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

// Build sid→[uuid] map from player index history — covers ALL 2,792 seasons
// regardless of whether team-stats files are populated. Same source of truth
// as team-stats (both derived from player.seasons[].regs[]) but authoritative.
const indexDir   = path.join(ROOT, 'players', 'indexes');
const sidToUuids = new Map();
console.log('  Building season→player map from index shards...');
for (const fname of fs.readdirSync(indexDir).filter(f => f.endsWith('.json')).sort()) {
  let shard;
  try { shard = readJson(path.join(indexDir, fname)); } catch { continue; }
  for (const [uuid, entry] of Object.entries(shard)) {
    for (const sid of Object.keys(entry.history || {})) {
      if (!sidToUuids.has(sid)) sidToUuids.set(sid, []);
      sidToUuids.get(sid).push(uuid);
    }
  }
}
console.log(`  ${sidToUuids.size} seasons found across index shards`);

const seasonIds = [...(targetSids || new Set(Object.keys(readJson(path.join(ROOT, 'data', 'sports-index.json')).seasons)))];
console.log(`  ${seasonIds.length} season files to process`);

// Load pass 2 progress — resume from last committed point. MODE-KEYED: progress
// from a full run must not gate an active-only run's writes or vice versa.
let doneSids = new Set();
if (FORCE_FULL && fs.existsSync(PASS2_PROGRESS)) {
  if (!DRY_RUN) fs.unlinkSync(PASS2_PROGRESS);
  console.log('  --force: progress file cleared, full rebuild');
} else if (fs.existsSync(PASS2_PROGRESS)) {
  try {
    const loaded = readJson(PASS2_PROGRESS);
    if ((loaded.mode || 'full') === MODE) doneSids = new Set(loaded.done || []);
    else console.log(`  Progress file is from a '${loaded.mode || 'full'}' run — discarding (this run is '${MODE}')`);
  } catch {}
  if (doneSids.size > 0) console.log(`  Resuming — ${doneSids.size} season files already done`);
}

let seasonFilesWritten = 0;
let seasonFilesSkipped = 0;
let sinceLastCommit    = 0;

for (const sid of seasonIds) {
  if (doneSids.has(sid)) { seasonFilesSkipped++; continue; }

  const uuids = sidToUuids.get(sid) || [];
  if (uuids.length === 0) { doneSids.add(sid); seasonFilesSkipped++; continue; }

  const players = {};
  for (const uuid of uuids) {
    const player = readPlayer(uuid);
    if (!player) continue;
    pushSeason(players, player, sid, uuid);
  }

  const out     = { players };
  const hasData = Object.keys(players).length > 0;
  if (!hasData) { doneSids.add(sid); seasonFilesSkipped++; continue; }

  if (!DRY_RUN) writeJson(path.join(ROOT, 'leaderboard', 'season', `${sid}.json`), out);
  doneSids.add(sid);
  seasonFilesWritten++;
  sinceLastCommit++;

  if (sinceLastCommit >= COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      writeJson(PASS2_PROGRESS, { mode: MODE, done: [...doneSids] });
      gitCommit(
        `build-leaderboards: pass 2 — ${seasonFilesWritten} season files written`,
        ['leaderboard/season/', 'scripts/.build-leaderboards-progress.json']
      );
    }
    sinceLastCommit = 0;
    console.log(`  ${seasonFilesWritten + seasonFilesSkipped} of ${seasonIds.length} seasons done (${seasonFilesWritten} written)...`);
  }
}

// Pass 2 completed — delete the progress file (progress files delete on SUCCESS
// only; the mid-run commits above preserve it for resume after a timeout/kill).
// Pre-fix, this file was never deleted, so a completed run left every sid
// marked done and each subsequent run silently no-op'd unless --force was
// passed — fatal for a recurring active-only chain from its second run on.
if (!DRY_RUN && fs.existsSync(PASS2_PROGRESS)) fs.unlinkSync(PASS2_PROGRESS);

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
console.log(`  Per-season files skipped : ${seasonFilesSkipped} (no player history)`);
