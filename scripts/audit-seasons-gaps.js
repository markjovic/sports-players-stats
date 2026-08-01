// scripts/audit-seasons-gaps.js
//
// READ-ONLY diagnostic. Writes nothing, commits nothing, makes no network calls.
//
// Answers the three questions §2.2 turned into once build-finals-stats.js and
// fetch-profile-stats.js were read end to end (2026-08-01).
//
// ── Q1. Are regs being DUPLICATED? ───────────────────────────────────────────
// The two writers create regs in different SHAPES:
//   nightly-crawl.js  L1014: { tid, tn, gid, gn, div, stats }
//   fetch-profile-stats.js L1040: { tid }                     <- no gid
// and nightly's duplicate check is:
//   season.regs.some(r => r.tid === playerTid && r.gid === gradeId)
// Against a matrix-created reg, r.gid is undefined, the test fails, and nightly
// pushes a SECOND reg for the same team. Matrix-first-then-nightly duplicates;
// nightly-first does not, because the matrix matches on tid alone (L1039).
// If this is real, regs[] is inflated and anything counting regs over-counts.
//
// ── Q2. How many regs lack `gid`? ────────────────────────────────────────────
// Directly measures the writer split above, and settles a documentation
// contradiction: claude_context listed reg.gid under BOTH "regs[] = {sid,tid,gid,
// gn,stats}" and "stripped fields (do not re-add)", eight lines apart. Neither is
// right — gid is present on nightly-written regs and absent on matrix-written
// ones. nightly L1011/L1122 READ it as a match key, so its absence is not benign.
//
// ── Q3. What is the real size of the seasons[] gap? ──────────────────────────
// build-finals-stats.js reported 218, but that number is:
//   (a) FINALS-ONLY — L215 filters to finalsGames, so it saw 120,813 of 2,311,527
//       games (5.2% of the corpus), and
//   (b) TWO defects conflated — its playedSids requires regs.length > 0 (L375-377),
//       so "sid absent from seasons[]" and "sid present with an EMPTY regs[]" both
//       increment the same counter.
// This scans ALL games and reports the two conditions SEPARATELY.
//
// Why the gap is not self-healing: nightly's reg-discovery repair (L986-1032) only
// runs for games in needsSpectator, gated on `!game.spc` — one pass per game, ever
// — and only for ACTIVE seasons within --rounds-back. The matrix can only add
// seasons the API reports in publicProfileStatistics. A season the API does not
// expose, in a game already carrying spc:1 or in a locked season, is unreachable
// by BOTH writers. Some of this is therefore expected to be irreparable, and the
// scan is the only evidence the player was there — which is exactly why
// build-finals-stats L383 trusts the scan rather than clamping the ratio.
//
// Usage: node scripts/audit-seasons-gaps.js
//        node scripts/audit-seasons-gaps.js --samples=40   (default 20)

'use strict';

const fs   = require('fs');
const path = require('path');
const { resolveToFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const SPORTS_IDX  = path.join(ROOT, 'data', 'sports-index.json');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const MAX_SAMPLES = Math.min(parseInt(ARGS.samples, 10) || 20, 200);

function log(m) { console.log(`[seasons-gaps] ${m}`); }

// Season ids repeat across every player, so intern them: ~3.2k distinct strings
// instead of ~1.6M copies. Keeps the uuid -> sids map inside a sane footprint.
const sidPool = new Map();
function intern(sid) {
  let v = sidPool.get(sid);
  if (v === undefined) { v = sid; sidPool.set(sid, sid); }
  return v;
}

// ─── locked/active, for splitting the result by reachability ──────────────────
let lockedSids = new Set(), activeSids = new Set(), sportsIndexOk = false;
try {
  const idx = JSON.parse(fs.readFileSync(SPORTS_IDX, 'utf8'));
  for (const [sid, s] of Object.entries(idx.seasons || {})) {
    (s.locked === true ? lockedSids : activeSids).add(sid);
  }
  sportsIndexOk = true;
  log(`sports-index: ${activeSids.size} active, ${lockedSids.size} locked`);
} catch (e) {
  log(`⚠️  sports-index NOT LOADED (${e.message}) — the active/locked split below is MEANINGLESS.`);
}

// ─── Pass 1: players ──────────────────────────────────────────────────────────
// Build uuid -> Set(sid) for seasons with a NON-EMPTY regs[], plus uuid -> Set(sid)
// for seasons present with an EMPTY regs[]. Q1 and Q2 are answered entirely here.
log('pass 1/2 — players/ …');

const sidsWithRegs  = new Map();   // uuid -> Set(sid)
const sidsEmptyRegs = new Map();   // uuid -> Set(sid)

let players = 0, unreadablePlayers = 0;
let totalSeasons = 0, seasonsEmptyRegs = 0;
let totalRegs = 0, regsNoGid = 0, regsNoTid = 0;
let seasonsWithDupTid = 0, dupRegPairs = 0;
const dupSamples = [], noGidSamples = [];

const shards = fs.readdirSync(PLAYERS_DIR)
  .filter(d => /^[0-9a-f]{2}$/.test(d))
  .sort();

for (const shard of shards) {
  const dir = path.join(PLAYERS_DIR, shard);
  for (const fname of fs.readdirSync(dir)) {
    if (!fname.endsWith('.json')) continue;
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); }
    catch { unreadablePlayers++; continue; }
    players++;

    const uuid = fname.replace('.json', '');
    const withRegs = new Set();
    const emptyRegs = new Set();

    for (const s of (p.seasons || [])) {
      if (!s || !s.sid) continue;
      totalSeasons++;
      const sid = intern(s.sid);
      const regs = s.regs || [];

      if (regs.length === 0) { seasonsEmptyRegs++; emptyRegs.add(sid); }
      else withRegs.add(sid);

      // Q1 + Q2, in the same walk.
      const seenTids = new Map();   // tid -> count within THIS season
      for (const r of regs) {
        totalRegs++;
        if (!r || r.tid === undefined || r.tid === null) { regsNoTid++; continue; }
        if (r.gid === undefined || r.gid === null) {
          regsNoGid++;
          if (noGidSamples.length < MAX_SAMPLES) {
            noGidSamples.push(`${uuid} sid=${sid} tid=${r.tid} keys=[${Object.keys(r).join(',')}]`);
          }
        }
        seenTids.set(r.tid, (seenTids.get(r.tid) || 0) + 1);
      }
      let dupHere = 0;
      for (const [tid, n] of seenTids) {
        if (n > 1) {
          dupHere += n - 1;
          if (dupSamples.length < MAX_SAMPLES) {
            const shapes = regs.filter(r => r && r.tid === tid)
              .map(r => `{${Object.keys(r).join(',')}}`).join(' + ');
            dupSamples.push(`${uuid} sid=${sid} tid=${tid} x${n}  ${shapes}`);
          }
        }
      }
      if (dupHere) { seasonsWithDupTid++; dupRegPairs += dupHere; }
    }

    if (withRegs.size)  sidsWithRegs.set(uuid, withRegs);
    if (emptyRegs.size) sidsEmptyRegs.set(uuid, emptyRegs);
  }
  if (shards.indexOf(shard) % 32 === 31) log(`  … ${shards.indexOf(shard) + 1}/256 shards`);
}
log(`pass 1 done — ${players} players, ${totalSeasons} seasons, ${totalRegs} regs`);

// ─── Pass 2: games ────────────────────────────────────────────────────────────
// For every player in every game, is that game's sid present in their seasons[]
// with a non-empty regs[]? Misses are deduped by "uuid|sid", so memory is bounded
// by the size of the DEFECT, not by the 2.3M-game corpus.
log('pass 2/2 — games/bv/ …');

const missAbsent = new Set();   // sid not in seasons[] at all
const missEmpty  = new Set();   // sid present but regs[] empty
let gamesScanned = 0, seasonFiles = 0, unreadableGames = 0;
let playerRefs = 0, unresolvable = 0;
let finalsOnlyMisses = new Set();   // reproduce build-finals-stats' 218 as a cross-check

function isFinalRound(rn) { return typeof rn === 'string' && rn.toLowerCase().includes('final'); }

for (const fname of fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort()) {
  let gfile;
  try { gfile = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); }
  catch { unreadableGames++; continue; }
  seasonFiles++;
  const sid = intern(fname.replace('.json', ''));

  for (const g of Object.values(gfile.games || {})) {
    gamesScanned++;
    const ids = [];
    for (const e of (g.p  || [])) if (e && e.id)        ids.push(e.id);
    for (const e of (g.hp || [])) if (e && e.profileID) ids.push(e.profileID);
    for (const e of (g.ap || [])) if (e && e.profileID) ids.push(e.profileID);
    if (!ids.length) continue;

    const isFin = isFinalRound(g.rn);
    for (const raw of ids) {
      playerRefs++;
      const uuid = resolveToFullUuid(raw, ROOT);
      if (!uuid) { unresolvable++; continue; }
      if (sidsWithRegs.get(uuid)?.has(sid)) continue;   // fine

      const key = `${uuid}|${sid}`;
      if (sidsEmptyRegs.get(uuid)?.has(sid)) missEmpty.add(key);
      else missAbsent.add(key);
      if (isFin) finalsOnlyMisses.add(key);
    }
  }
}

// ─── report ───────────────────────────────────────────────────────────────────
function splitByScope(keys) {
  let active = 0, locked = 0, unknown = 0;
  for (const k of keys) {
    const sid = k.split('|')[1];
    if (activeSids.has(sid)) active++;
    else if (lockedSids.has(sid)) locked++;
    else unknown++;
  }
  return { active, locked, unknown };
}

const L = [];
const pctRegs = n => totalRegs ? ` (${(100 * n / totalRegs).toFixed(2)}%)` : '';
L.push('');
L.push(`Scanned ${players} players (${totalSeasons} seasons, ${totalRegs} regs) and ${gamesScanned} games across ${seasonFiles} season files.`);
if (unreadablePlayers || unreadableGames) L.push(`  unreadable: ${unreadablePlayers} player file(s), ${unreadableGames} game file(s)`);
L.push(`  player refs in games: ${playerRefs}   unresolvable ids: ${unresolvable}`);

L.push('');
L.push('Q1 — DUPLICATE REGS (two regs sharing a tid within one season)');
L.push(`  seasons containing a duplicate : ${seasonsWithDupTid}`);
L.push(`  surplus regs                   : ${dupRegPairs}${pctRegs(dupRegPairs)}`);
L.push(dupRegPairs === 0
  ? '  ✅ none — the shape mismatch between the two writers is NOT producing duplicates.'
  : '  ❌ nightly matches on (tid AND gid); the matrix writes {tid} only, so nightly cannot see');
if (dupRegPairs > 0) L.push('     a matrix-created reg and pushes a second one for the same team.');
for (const s of dupSamples) L.push(`       ${s}`);

L.push('');
L.push('Q2 — REGS MISSING `gid`');
L.push(`  regs with no gid : ${regsNoGid}${pctRegs(regsNoGid)}`);
L.push(`  regs with no tid : ${regsNoTid}${pctRegs(regsNoTid)}`);
L.push('  (nightly L1011/L1122 use gid as a match key, so a missing gid is not cosmetic.)');
for (const s of noGidSamples) L.push(`       ${s}`);

L.push('');
L.push('Q3 — SEASONS[] GAP, ALL GAMES (build-finals-stats saw only finals: 5.2% of the corpus)');
const a = splitByScope(missAbsent), e = splitByScope(missEmpty);
L.push(`  player+season pairs, sid ABSENT from seasons[]      : ${missAbsent.size}`);
L.push(`      active seasons ${a.active}   locked ${a.locked}   not in sports-index ${a.unknown}${sportsIndexOk ? '' : '   ⚠️ INDEX NOT LOADED'}`);
L.push(`  player+season pairs, sid present but regs[] EMPTY   : ${missEmpty.size}`);
L.push(`      active seasons ${e.active}   locked ${e.locked}   not in sports-index ${e.unknown}`);
L.push(`  TOTAL                                              : ${missAbsent.size + missEmpty.size}`);
L.push('');
L.push(`  of which appear in a FINALS game : ${finalsOnlyMisses.size}`);
L.push('     ^ cross-check against build-finals-stats.js `sidsNotInSeasons` (was 218).');
L.push('       Close agreement means both scans see the same corpus. A large gap means one of');
L.push('       them is scoped differently than believed — investigate before trusting either.');
L.push('');
L.push('  Reachability: ACTIVE-season pairs can still be repaired in place by the nightly IF the');
L.push('  game is re-fetched (it will not be — spc:1 makes reg-discovery one-shot per game).');
L.push('  LOCKED-season pairs are unreachable by both writers and need a backfill or nothing.');
L.push('  Where the API does not expose the season at all, the game scan is the ONLY evidence the');
L.push('  player was there — that subset is irreparable and must be trusted from the scan.');

const out = L.join('\n');
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) {
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + out + '\n```\n'); } catch (_) {}
}
