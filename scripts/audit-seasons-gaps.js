// scripts/audit-seasons-gaps.js
//
// READ-ONLY diagnostic. Writes nothing, commits nothing, makes no network calls.
//
// Answers the three questions §2.2 turned into once build-finals-stats.js and
// fetch-profile-stats.js were read end to end (2026-08-01).
//
// ── Q1. Are regs being DUPLICATED? ───────────────────────────────────────────
// ⚠️ v1 of this check (2026-08-01) keyed duplicates on `tid` ALONE and reported
// 1,330,231 "surplus" regs (32% of all regs). THAT NUMBER WAS MEANINGLESS. Every
// sample it printed was two FULL-shape regs both carrying gid — same team, same
// season, DIFFERENT grade. That is REGRADING, which BV does routinely with juniors,
// and two regs is the correct representation of it. A reg is a (team, grade)
// registration, so the key is (tid, gid) — exactly what nightly matches on.
//
// v2 separates the three cases properly:
//   dupExact       same (tid, gid) twice          -> a GENUINE duplicate
//   dupRegrade     same tid, different real gids  -> EXPECTED, not a defect
//   dupNullGid     same tid, >=1 reg with gid null/absent -> the real MECHANISM
//
// dupNullGid is the one that matters. nightly's check is
//   season.regs.some(r => r.tid === playerTid && r.gid === gradeId)
// so a reg carrying `gid: null` can NEVER satisfy it: nightly cannot see that reg
// and pushes a second one for the same team. Q2 below found 110,232 regs with a
// null/absent gid, and `publicProfileTeams` is documented to return grade=NULL for
// COMPLETED season registrations — a writer doing `gid: grade?.id ?? null` produces
// exactly this shape.
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
let dupExact = 0, dupRegrade = 0, dupNullGid = 0;
// For the EXACT (tid,gid) duplicates only: are the copies carrying the same stats?
// This is what decides whether dedup is mechanical or lossy. Identical stats -> pick
// either. Divergent stats -> one is stale and choosing wrong silently loses data.
let dupExactStatsIdentical = 0, dupExactStatsDiffer = 0, dupExactOneEmpty = 0;
const dupStatsDifferSamples = [];
// Which stat keys actually differ across an EXACT-duplicate group, over ALL of them.
// The 20 printed samples all differed only in `foulOuts`, but samples ordered by uuid
// are suggestive, not measured — this counts every group so the merge rule can be
// justified rather than assumed.
const differKeyHisto = new Map();
// REGRADE groups: do the copies hold SPLIT stats (5 games in grade A, 10 in B) or
// DUPLICATED team totals (both saying 15)? This is the question OUTSTANDING §1.1
// hangs on. build-leaderboards.js now keys season rows on `uuid|tid|gid`, so a
// regraded team yields TWO rows. Correct if the stats are split; if they are
// duplicated totals it produces two identical rows per player and the key change
// must be reverted. 1,300,376 regs are regrades, so this is not a corner case.
let regradeSplit = 0, regradeIdenticalTotals = 0, regradePartlyEmpty = 0;
const regradeSplitSamples = [], regradeIdenticalSamples = [];
let differOnlyByAbsence = 0, differByValue = 0;
const differByValueSamples = [];
const dupSamples = [], noGidSamples = [], dupExactSamples = [], dupNullGidSamples = [];

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
        if (n <= 1) continue;
        dupHere += n - 1;
        const sameTid = regs.filter(r => r && r.tid === tid);

        // Classify by GRADE, which is what actually makes a reg distinct.
        const gids = sameTid.map(r => (r.gid === undefined || r.gid === null) ? null : r.gid);
        const realGids = gids.filter(g => g !== null);
        const nullCount = gids.length - realGids.length;
        const distinctReal = new Set(realGids).size;

        if (nullCount > 0 && gids.length > 1) {
          dupNullGid += n - 1;
          if (dupNullGidSamples.length < MAX_SAMPLES) {
            dupNullGidSamples.push(`${uuid} sid=${sid} tid=${tid} x${n} gids=[${gids.map(g => g === null ? 'NULL' : g).join(', ')}]`);
          }
        } else if (distinctReal < realGids.length) {
          dupExact += realGids.length - distinctReal;
          if (dupExactSamples.length < MAX_SAMPLES) {
            dupExactSamples.push(`${uuid} sid=${sid} tid=${tid} x${n} gids=[${realGids.join(', ')}]`);
          }
          // Compare stats within each repeated (tid,gid) group.
          const byGid = new Map();
          for (const r of sameTid) {
            if (r.gid === undefined || r.gid === null) continue;
            if (!byGid.has(r.gid)) byGid.set(r.gid, []);
            byGid.get(r.gid).push(r);
          }
          for (const [g, group] of byGid) {
            if (group.length < 2) continue;
            const norm = r => {
              const st = r.stats || {};
              // Zero-valued keys are stripped on write, so {} and {pts:0} are the
              // same record — compare on non-zero entries only, sorted for stability.
              return JSON.stringify(Object.entries(st)
                .filter(([, v]) => v !== 0 && v !== null && v !== undefined)
                .sort(([a], [b]) => a < b ? -1 : 1));
            };
            const sigs = group.map(norm);
            const nonEmpty = sigs.filter(x => x !== '[]');
            const distinct = new Set(sigs).size;
            if (distinct === 1) {
              dupExactStatsIdentical += group.length - 1;
            } else if (nonEmpty.length <= 1) {
              // One copy holds the stats, the rest are empty shells — safe to drop the shells.
              dupExactOneEmpty += group.length - 1;
            } else {
              dupExactStatsDiffer += group.length - 1;
              if (dupStatsDifferSamples.length < MAX_SAMPLES) {
                dupStatsDifferSamples.push(`${uuid} sid=${sid} tid=${tid} gid=${g} -> ${sigs.join('  VS  ')}`);
              }
              // Classify the disagreement key by key.
              const maps = group.map(r => {
                const m = new Map();
                for (const [k, v] of Object.entries(r.stats || {})) if (v !== 0 && v !== null && v !== undefined) m.set(k, v);
                return m;
              });
              const allKeys = new Set(maps.flatMap(m => [...m.keys()]));
              const diffKeys = [];
              let byValue = false;
              for (const k of allKeys) {
                const vals = maps.map(m => m.get(k));
                const present = vals.filter(v => v !== undefined);
                const distinctPresent = new Set(present).size;
                if (present.length !== vals.length || distinctPresent > 1) {
                  diffKeys.push(k);
                  // A key that is PRESENT on every copy with different values is a real
                  // conflict; a key merely missing from some copies is not.
                  if (present.length === vals.length && distinctPresent > 1) byValue = true;
                }
              }
              const sig = diffKeys.sort().join('+') || '(none)';
              differKeyHisto.set(sig, (differKeyHisto.get(sig) || 0) + 1);
              if (byValue) {
                differByValue++;
                if (differByValueSamples.length < MAX_SAMPLES) {
                  differByValueSamples.push(`${uuid} sid=${sid} tid=${tid} gid=${g} keys=[${diffKeys.join(', ')}] -> ${sigs.join('  VS  ')}`);
                }
              } else {
                differOnlyByAbsence++;
              }
            }
          }
        } else {
          dupRegrade += n - 1;
          if (dupSamples.length < MAX_SAMPLES) {
            dupSamples.push(`${uuid} sid=${sid} tid=${tid} x${n} gids=[${realGids.join(', ')}]  (distinct grades — expected)`);
          }
          // §1.1: split vs duplicated totals.
          const sig = r => {
            const st = r.stats || {};
            return JSON.stringify(Object.entries(st)
              .filter(([, v]) => v !== 0 && v !== null && v !== undefined)
              .sort(([a], [b]) => a < b ? -1 : 1));
          };
          const sigs = sameTid.map(sig);
          const nonEmpty = sigs.filter(x => x !== '[]');
          if (nonEmpty.length <= 1) {
            // Only one grade carries stats — no double-count risk either way.
            regradePartlyEmpty++;
          } else if (new Set(nonEmpty).size === 1) {
            regradeIdenticalTotals++;
            if (regradeIdenticalSamples.length < MAX_SAMPLES) {
              regradeIdenticalSamples.push(`${uuid} sid=${sid} tid=${tid} gids=[${realGids.join(', ')}] BOTH=${nonEmpty[0]}`);
            }
          } else {
            regradeSplit++;
            if (regradeSplitSamples.length < MAX_SAMPLES) {
              regradeSplitSamples.push(`${uuid} sid=${sid} tid=${tid} gids=[${realGids.join(', ')}] -> ${sigs.join('  VS  ')}`);
            }
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
L.push('Q1 — REGS SHARING A tid WITHIN ONE SEASON, split by GRADE');
L.push('  A reg is a (team, grade) registration, so sharing a tid is only a DEFECT when the');
L.push('  grades do not distinguish them. v1 of this check keyed on tid alone and called all');
L.push('  1,330,231 of these "surplus" — that was wrong, and most of them are regrading.');
L.push(`  seasons containing any tid repeat : ${seasonsWithDupTid}`);
L.push(`  total tid repeats                 : ${dupRegPairs}${pctRegs(dupRegPairs)}`);
L.push('');
L.push(`  a) REGRADE — distinct real grades  : ${dupRegrade}${pctRegs(dupRegrade)}   ✅ expected, correct data`);
for (const s of dupSamples.slice(0, 5)) L.push(`       ${s}`);
L.push('');
L.push('     §1.1 — do REGRADE copies hold SPLIT stats or DUPLICATED team totals?');
L.push('     build-leaderboards.js now keys season rows on uuid|tid|gid, so a regraded team');
L.push('     yields TWO rows. SPLIT = correct, the key change recovered data that the old');
L.push('     uuid|tid key was silently overwriting. DUPLICATED = two identical rows per');
L.push('     player, and the key change must be REVERTED.');
L.push(`       SPLIT (different stats per grade)   : ${regradeSplit}   ${regradeSplit ? '✅ key change is CORRECT' : ''}`);
L.push(`       DUPLICATED (identical totals)       : ${regradeIdenticalTotals}   ${regradeIdenticalTotals ? '❌ REVERT the key change' : '✅ none'}`);
L.push(`       only one grade carries stats        : ${regradePartlyEmpty}   (no risk either way)`);
for (const s of regradeSplitSamples.slice(0, 5)) L.push(`         SPLIT      ${s}`);
for (const s of regradeIdenticalSamples.slice(0, 5)) L.push(`         DUPLICATED ${s}`);
L.push('');
L.push(`  b) NULL-GID — >=1 reg has no grade : ${dupNullGid}${pctRegs(dupNullGid)}   ${dupNullGid ? '❌ THE MECHANISM' : '✅ none'}`);
L.push('       nightly matches `r.tid === playerTid && r.gid === gradeId`, so a reg carrying');
L.push('       gid:null can never match and nightly pushes a second one for the same team.');
L.push('       publicProfileTeams returns grade=NULL for COMPLETED season registrations.');
for (const s of dupNullGidSamples) L.push(`       ${s}`);
L.push('');
L.push(`  c) EXACT — same (tid, gid) twice   : ${dupExact}${pctRegs(dupExact)}   ${dupExact ? '❌ genuine duplicate' : '✅ none'}`);
for (const s of dupExactSamples.slice(0, 5)) L.push(`       ${s}`);
if (dupExact) {
  L.push('');
  L.push('     Do the copies carry the SAME stats? This decides whether dedup is safe.');
  L.push(`       identical stats        : ${dupExactStatsIdentical}   ✅ dedup is mechanical, keep either`);
  L.push(`       one copy empty         : ${dupExactOneEmpty}   ✅ keep the populated one, drop the shell`);
  L.push(`       DIVERGENT stats        : ${dupExactStatsDiffer}   ${dupExactStatsDiffer ? '❌ one copy is stale — a blind dedup LOSES DATA' : '✅ none'}`);
  L.push('       (zero-valued stats keys are stripped on write, so {} and {pts:0} compare equal)');
  if (dupExactStatsDiffer) {
    L.push('');
    L.push('     WHICH KEYS DISAGREE (all divergent groups, not a sample):');
    for (const [sig, n] of [...differKeyHisto.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      L.push(`       ${String(n).padStart(6)}  ${sig}`);
    }
    L.push('');
    L.push(`       groups differing ONLY by a key being ABSENT : ${differOnlyByAbsence}   ✅ merge by max per key is LOSSLESS`);
    L.push(`       groups where a shared key has DIFFERENT values : ${differByValue}   ${differByValue ? '❌ a real conflict — max() would pick a winner' : '✅ none'}`);
    for (const s of differByValueSamples) L.push(`       ${s}`);
  }
  for (const s of dupStatsDifferSamples.slice(0, 5)) L.push(`       ${s}`);
}

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
