// scripts/lib/round-refresh.cjs
//
// The per-grade fixture refresh: decide which rounds of an active grade to
// re-fetch tonight, and which stored UNPLAYED games a successful fetch proves
// PlayHQ no longer holds.
//
// WHY THIS IS A LIBRARY AND NOT MORE OF nightly-crawl.js. It deletes data. The
// only honest way to trust a deletion rule is to execute it against constructed
// cases — a withdrawn game, a regrade, a round that vanished, a fetch that was
// refused, an empty response, a played game PlayHQ stopped returning — and none
// of that is reachable inside the crawl without a PlayHQ session. Here it is
// pure: no network, no filesystem writes, no git. `scripts/lib/` already holds
// the shared predicates this repo could not afford to have two copies of
// (game-scores.cjs exists because an audit and a deleting consumer disagreed
// about MIN_TRUSTED_SCORE). This is the same reasoning.
//
// WHAT IT DOES NOT DO. It never calls PlayHQ and it never writes a file. The
// caller fetches, the caller applies, the caller commits. Everything here is a
// decision about data it was handed.
//
// ── THE RULES, which are not negotiable and are enforced here rather than at
// ── the call site, so a future caller cannot quietly drop one.
//
// 1. A deletion comes ONLY from a round fetch that SUCCEEDED. The caller passes
//    `returnedIds` only for a `kind === 'ok'` response; there is no code path in
//    this file that produces a deletion from an absent or failed fetch.
// 2. Only UNPLAYED games may be deleted. `isPlayedGame` is deliberately
//    over-inclusive: a score, FINAL, a forfeit, a captured roster (`spc`/`dg`)
//    or a non-empty `p[]` all mean something happened, and an unrecognised shape
//    returns TRUE. The failure direction is "refuse to delete", always.
// 3. An EMPTY result for a round that is STILL IN THE ROUND LIST is suspect, not
//    evidence. It deletes nothing and is reported. (PlayHQ answering with
//    nothing and PlayHQ having nothing are different facts — the failure-to-ASK
//    class has struck this repository four times.)
// 4. A game with no `rn` cannot be scoped to a round. games/bv stores the round
//    NAME and no round id, so a game that never recorded one is unreachable by a
//    (gid, rn) scope. It is counted and reported, never deleted.
//
// ── THE FINGERPRINT FILE
//
// `data/round-fingerprints.json` holds, per ACTIVE grade, a hash of the round
// list and a hash of the game-id set of each round we have fetched:
//
//   { generatedAt, grades: { "<gid>": { rl: "<hash12>", r: { "<roundName>": "<hash12>" }, at } } }
//
// HASHES, NOT IDS, AND THE ARITHMETIC IS WHY. Storing the ids themselves is
// ~450k entries across ~5,000 active grades — roughly 17 MB and rising with
// every season that opens. T22 is the standing rule against committing derived
// state that scales with the corpus: build-finals-stats serialised its map, hit
// 110.14 MB, crossed GitHub's hard 100 MB file limit, and the 60-attempt push
// retry then burned every attempt on a rejection that could never succeed.
// A 12-char hash per round is ~2.5 MB at the same scale, it is bounded by the
// number of UNLOCKED grades rather than by history, and the season-lifecycle
// rule keeps that number falling. `saveFingerprints` still refuses outright
// above MAX_FINGERPRINT_BYTES rather than discovering the limit from a push
// rejection.
//
// 12 hex characters is 48 bits. The set being compared is the ~6 games of one
// round, and a collision would mean failing to NOTICE a change — it cannot
// cause a deletion, because deletions come from the fetched id set and never
// from the hash. So the cost of a collision is one missed refresh, not data.

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const FINGERPRINT_REL   = path.join('data', 'round-fingerprints.json');
const MAX_FINGERPRINT_BYTES = 40 * 1024 * 1024;   // refuse long before GitHub's 100 MB (T22)

// NUL as the separator, not a comma: it cannot occur in a uuid or a round name,
// so ["a","b"] and ["a,b"] can never hash alike.
const SEP = '\u0000';

function sha12(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12);
}

// Order MATTERS for the round list — a round inserted in the middle is a change
// worth noticing even if the names are otherwise the same set.
function hashRoundList(rounds) {
  return sha12((rounds || []).map(r => String((r && r.name) ?? '')).join(SEP));
}

// Order does NOT matter for a round's games — PlayHQ returns them in whatever
// order it likes, and re-ordering is not a change.
function hashIdSet(ids) {
  return sha12([...new Set(ids || [])].sort().join(SEP));
}

// ⚠ OVER-INCLUSIVE BY DESIGN. Anything that might mean the game happened
// returns TRUE and is therefore undeletable. An unrecognised or missing entry
// returns TRUE as well: a guard must FAIL TOWARD DOING LESS (T3).
//
// `hs !== undefined` rather than a truthiness test — a legitimate 0 score is a
// played game, and `if (g.hs)` would call it unplayed. The 0-0 scoreline is a
// real shape in this data (game-scores.cjs returns null for it rather than a cap
// of 0, after treating it as a cap produced 1,241 false "impossible" records).
function isPlayedGame(g) {
  if (!g || typeof g !== 'object') return true;
  if (g.hs !== undefined || g.as !== undefined) return true;
  if (g.st === 'FINAL') return true;
  if (g.forfeit === true) return true;
  if (g.spc || g.dg) return true;                          // a roster was captured
  if (Array.isArray(g.p) && g.p.length > 0) return true;   // attendees recorded
  return false;
}

// ─── Fingerprint file ─────────────────────────────────────────────────────────

function fingerprintPath(ROOT) { return path.join(ROOT, FINGERPRINT_REL); }

// An ABSENT file is a first run — every grade baselines, which is correct.
// An UNREADABLE file is a fault and THROWS: silently treating a corrupt
// fingerprint as "no fingerprint" would baseline the whole repository and
// present it as routine. (Same reasoning as loadGameFile's parse guard.)
function loadFingerprints(ROOT) {
  const f = fingerprintPath(ROOT);
  if (!fs.existsSync(f)) return { generatedAt: null, grades: {} };
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); }
  catch (e) { throw new Error(`round-refresh: ${FINGERPRINT_REL} exists but could not be read (${e.message})`); }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error(`round-refresh: ${FINGERPRINT_REL} exists but failed to parse (${e.message}) — refusing to treat a corrupt fingerprint as an absent one`); }
  if (!data || typeof data !== 'object' || typeof data.grades !== 'object' || data.grades === null) {
    throw new Error(`round-refresh: ${FINGERPRINT_REL} has an unexpected shape — refusing to proceed`);
  }
  return data;
}

function saveFingerprints(ROOT, data) {
  const out = JSON.stringify({ generatedAt: new Date().toISOString(), grades: data.grades || {} });
  const bytes = Buffer.byteLength(out, 'utf8');
  if (bytes > MAX_FINGERPRINT_BYTES) {
    throw new Error(
      `round-refresh: ${FINGERPRINT_REL} would be ${(bytes / 1048576).toFixed(1)} MB, over the ${(MAX_FINGERPRINT_BYTES / 1048576)} MB ceiling. ` +
      `This file is meant to scale with ACTIVE grades, not with history — if it has grown this far, grades are not being retired from it. ` +
      `Refusing to write (T22: a file that crosses GitHub's 100 MB limit is a permanent push rejection, and the retry loop cannot tell).`
    );
  }
  const f = fingerprintPath(ROOT);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, out);
  return bytes;
}

// Grades that are no longer active must leave the file, or it grows forever and
// the ceiling above eventually fires on a healthy repository. Called with the
// set of grade ids the crawl considered tonight.
function pruneFingerprints(fp, activeGradeIds) {
  const keep = activeGradeIds instanceof Set ? activeGradeIds : new Set(activeGradeIds || []);
  let removed = 0;
  for (const gid of Object.keys(fp.grades || {})) {
    if (!keep.has(gid)) { delete fp.grades[gid]; removed++; }
  }
  return removed;
}

// ─── Reading what we already hold for a grade ────────────────────────────────

// Group a season's stored games by round name, for ONE grade.
//
// ⚠ Scoped by `gid` AND `rn`, and both must be present. A game with no `rn` goes
// into `noRound` and is never a deletion candidate — see rule 4. This is not a
// defensive nicety: `applyRoundFixtures` writes `rn` conditionally
// (`...(roundName ? { rn: roundName } : {})`), so the shape genuinely occurs.
function groupStoredByRound(games, gradeId) {
  const byRound = new Map();   // roundName -> [{ gameId, g }]
  const noRound = [];
  for (const [gameId, g] of Object.entries(games || {})) {
    if (!g || g.gid !== gradeId) continue;
    if (!g.rn) { noRound.push({ gameId, g }); continue; }
    if (!byRound.has(g.rn)) byRound.set(g.rn, []);
    byRound.get(g.rn).push({ gameId, g });
  }
  return { byRound, noRound };
}

// ─── The plan ────────────────────────────────────────────────────────────────

// Decide what to fetch for one grade tonight.
//
//   grade          { gradeId, gradeName, seasonId, rounds: [{id,name,number,current}] }
//   stored         this grade's fingerprint entry, or null/undefined
//   byRound        from groupStoredByRound
//   aheadN         how many unplayed rounds beyond the current one to re-fetch
//   skipCurrent    true when Phase 2 already queues the current round (it does)
//
// Returns { mode, listChanged, roundListHash, fetch: [{roundId, roundName, reason}], vanished: [roundName] }
//
// ⚠ "UNPLAYED ROUND" MEANS "WE DO NOT HOLD A COMPLETE RESULT FOR IT", not "it is
// in the future". A round we hold nothing for is unplayed — that is the whole
// point, since a round whose fixtures have not been discovered yet holds zero
// games and must still be reachable.
//
// ⚠ A grade with NO CURRENT ROUND is not skipped here. nightly-crawl's Phase 2
// does `if (!currentRound) continue;` and so contributes nothing for such a
// grade — which is exactly the shape a freshly created grading grade has. This
// plan treats the whole round list as candidates in that case, which is what
// closes that hole.
function planGrade({ grade, stored, byRound, aheadN = 2, skipCurrent = true }) {
  const rounds = Array.isArray(grade.rounds) ? grade.rounds : [];
  const roundListHash = hashRoundList(rounds);
  // TWO DIFFERENT FACTS, and conflating them cost a nightly request per season.
  //
  // listUnverified — we cannot prove the list is the same as last time. True for
  //   a baseline (no fingerprint at all) and for a grade whose last run was
  //   incomplete (a suspect or failed round withholds `rl` on purpose). Drives
  //   the "fetch rounds the fingerprint has never seen" behaviour, which fails
  //   toward MORE checking and is therefore right to be generous.
  //
  // listChanged — we have a previous list and it genuinely differs. Only this
  //   justifies the expensive consequence: re-resolving the whole season's
  //   grades via discoverTeams. The first version used the generous test for
  //   both, so one permanently-suspect grade made the crawl re-resolve its
  //   season and re-sweep every grade the index lacked EVERY NIGHT, for ever.
  //   Seen on the second run of the harness, not reasoned about.
  const listUnverified = !stored || !stored.rl || stored.rl !== roundListHash;
  const listChanged    = !!(stored && stored.rl && stored.rl !== roundListHash);

  const roundIsUnplayed = (name) => {
    const held = byRound.get(name);
    if (!held || held.length === 0) return true;          // hold nothing -> unplayed
    return held.some(e => !isPlayedGame(e.g));            // any unplayed game -> unplayed round
  };

  const currentIdx = rounds.findIndex(r => r && r.current);
  // No current round: every round is a candidate. This is the grading case.
  const firstIdx = currentIdx >= 0 ? (skipCurrent ? currentIdx + 1 : currentIdx) : 0;

  const fetch = [];
  const seen  = new Set();
  const add = (r, reason) => {
    if (!r || !r.id || seen.has(r.id)) return;
    seen.add(r.id);
    fetch.push({ roundId: r.id, roundName: r.name, reason });
  };

  const mode = stored ? 'incremental' : 'baseline';

  // ── ROUNDS BEFORE THE CURRENT ONE THAT STILL HOLD UNPLAYED GAMES ────────
  // Added 2026-11-23 after the first live run reported `grades withheld for
  // incomplete coverage: 197`.
  //
  // The fetch window starts after the current round, so a round in the PAST
  // holding an unplayed game was never fetched — and the coverage rule then
  // refused to delete anything for that grade, for ever. The guard was blocking
  // the exact cleanup it exists to make safe. Live example: grade 647b4d51 had a
  // candidate in "Finals Round 3" withheld because "Finals Round 1" held unplayed
  // games and had not been fetched.
  //
  // A past round holding an unplayed game is unusual — a postponement, or a
  // stale fixture of precisely the kind this pass removes — so the extra cost is
  // small and falls on the grades that need it. Applied in BOTH modes: without
  // it in the incremental pass, a grade that keeps one genuinely unplayed past
  // game could never satisfy coverage again.
  const addPastUnplayed = () => {
    // STRICTLY BEFORE the current round. `firstIdx` is currentIdx+1, so using it
    // as the bound swept the CURRENT round in — which Phase 2 has already
    // fetched and whose ids are fed in, so re-fetching it is one wasted request
    // per grade. Caught by the existing tests the moment the bound was wrong.
    const pastEnd = currentIdx >= 0 ? currentIdx : 0;
    for (let i = 0; i < pastEnd && i < rounds.length; i++) {
      const held = byRound.get(rounds[i].name);
      if (held && held.some(e => !isPlayedGame(e.g))) add(rounds[i], 'past-unplayed');
    }
  };

  if (mode === 'baseline') {
    // THE BASELINE IS THE CLEAN-UP. Every stale game already on disk was written
    // by a sweep that has never looked at it again, so the first run for a grade
    // must see every unplayed round once or those games are never reconsidered.
    // It happens exactly once per grade; the fingerprint written afterwards is
    // what makes every later night cheap.
    //
    // It starts at firstIdx, i.e. AFTER the current round, for the same reason
    // the incremental path does: Phase 2 of the crawl has already fetched the
    // current round, and the caller feeds those ids in rather than asking for
    // them twice. Re-fetching would be ~5,000 duplicate requests on a baseline
    // night — found by running this, not by reading it.
    for (let i = firstIdx; i < rounds.length; i++) {
      if (roundIsUnplayed(rounds[i].name)) add(rounds[i], 'baseline');
    }
    addPastUnplayed();
  } else {
    let taken = 0;
    for (let i = firstIdx; i < rounds.length && taken < aheadN; i++) {
      if (!roundIsUnplayed(rounds[i].name)) continue;
      add(rounds[i], 'ahead');
      taken++;
    }
    if (listUnverified) {
      // A round the fingerprint has never seen is new — fetch it however far out
      // it sits, because a new round IS the signal that something was regraded
      // or rescheduled. Bounded by the round list, so it cannot run away.
      const known = new Set(Object.keys(stored.r || {}));
      for (let i = firstIdx; i < rounds.length; i++) {
        if (!known.has(rounds[i].name) && roundIsUnplayed(rounds[i].name)) add(rounds[i], 'new-round');
      }
    }
    addPastUnplayed();
  }

  // A round that is no longer in PlayHQ's list has been withdrawn. Its unplayed
  // games are deletion candidates WITHOUT a fetch — the round list itself came
  // from a successful gradeRounds call, which is the "successful fetch" rule 1
  // requires. The caller must only use this when the gradeRounds call for this
  // grade actually succeeded.
  //
  // ⚠ THE CANDIDATE SET IS THE ROUNDS WE HOLD GAMES FOR, not just the rounds the
  // fingerprint knows about. The first version read only the fingerprint, so on
  // a BASELINE run — where there is no fingerprint by definition — `vanished`
  // was always empty and a game sitting in a withdrawn round survived the very
  // pass whose job is to clean up what is already on disk. Caught by running it:
  // a stale game in a withdrawn round came through the baseline untouched.
  const liveNames = new Set(rounds.map(r => r && r.name).filter(Boolean));
  const seenNames = new Set([
    ...Object.keys((stored && stored.r) || {}),
    ...byRound.keys(),
  ]);
  const vanished = [...seenNames].filter(n => !liveNames.has(n));

  return { mode, listChanged, listUnverified, roundListHash, fetch, vanished };
}

// ─── The deletion decision ───────────────────────────────────────────────────

// For ONE round, given what a SUCCESSFUL fetch returned and what we hold.
//
//   roundStillListed  is this round still in PlayHQ's round list?
//   returnedIds       game ids the successful fetch returned for this round
//   storedGames       [{ gameId, g }] we hold for (gid, roundName)
//
// Returns { deletable: [{gameId, g}], keptPlayed: n, suspectEmpty: bool }
// `answered` — did PlayHQ return a payload for this round at all? The caller
// passes `data.discoverFixtureByRound !== null`. Defaults to TRUE only when the
// caller supplies ids, so an old call site cannot silently flip the meaning.
function computeRoundDeletions({ roundStillListed, returnedIds, storedGames, answered }) {
  if (answered === undefined) answered = Array.isArray(returnedIds) && returnedIds.length > 0;
  const held = storedGames || [];

  // RULE 3, AND THE WHOLE RULE TURNS ON `answered`.
  //
  // "Never let a failure to ASK become a recorded ANSWER" is the rule this
  // repository has been bitten by four times. But the mirror of it is just as
  // wrong: refusing to accept an answer that was actually given.
  //
  //   discoverFixtureByRound === null   → PlayHQ did not answer about this
  //                                       round. Not evidence. SUSPECT.
  //   discoverFixtureByRound = {games:[]} → PlayHQ answered, and the answer is
  //                                       that the round holds no games. That
  //                                       IS evidence.
  //
  // `gqlMain` already separates a refusal (blocked / transient) from an `ok`,
  // so by the time a result reaches here the call succeeded. The caller passes
  // `answered = payload !== null`.
  //
  // The first version collapsed both shapes into an empty id list and called
  // them suspect. Measured consequence on MEBA Summer 2026/27, confirmed
  // against PlayHQ's own page: the association published a fixture, regraded,
  // and withdrew most of it. Rounds 11-18 of sixteen grades now read
  // "Fixture has not yet been confirmed" and hold NO games, while we hold two
  // to five stale games in each. 103 rounds of games PlayHQ has explicitly
  // removed, which the suspect rule would have protected for ever.
  //
  // A round we hold NOTHING for is never suspect either way — there is nothing
  // to delete and nothing to be suspicious about.
  // RULE 3, AND THE EVIDENCE FOR IT IS NOW THREE-DEEP.
  //
  //   discoverFixtureByRound === null   → PlayHQ did not answer. SUSPECT.
  //   {games: []}                       → PlayHQ answered, and the answer is
  //                                       that the round holds no games.
  //
  // `gqlMain` already separates a refusal (blocked / transient) from an `ok`, so
  // by the time a result reaches here the call succeeded. The caller passes
  // `answered = payload !== null`.
  //
  // ⚠ THIS RULE WAS SHIPPED, THEN REVERTED ON 2026-11-23, THEN RESTORED THE SAME
  // DAY. The reversal is the part worth remembering. Three games dated
  // 2026-11-27 were deleted from grade fd985ec5 Round 8, and a PlayHQ screenshot
  // appeared to show the fixture still live, so the rule was blamed and undone.
  // The screenshot was StatTrack's own dark-themed team view — OUR data — not
  // PlayHQ. PlayHQ's actual team fixture shows **Round 8 as a BYE**.
  //
  // WHICH EXPLAINS THE EMPTY ARRAY EXACTLY: `Q_FIXTURE_BY_ROUND` requests `byes`
  // and `games` as SEPARATE arrays, and this code reads only `games`. A bye round
  // genuinely returns no games. The empty answer was a true answer and the stored
  // fixture was pre-regrade residue.
  //
  // The lesson is not about byes. It is that a screenshot is only evidence when
  // you know which system produced it, and that reversing a measured rule on one
  // unverified image is worse than shipping it was. The bye count is now carried
  // through to the log so the next ambiguous case names its own cause.
  if (roundStillListed && !answered && held.length > 0) {
    return { deletable: [], keptPlayed: 0, suspectEmpty: true };
  }

  const ret = new Set(returnedIds || []);
  const deletable = [];
  let keptPlayed = 0;
  for (const e of held) {
    if (ret.has(e.gameId)) continue;           // still there
    if (isPlayedGame(e.g)) { keptPlayed++; continue; }   // RULE 2
    deletable.push(e);
  }
  return { deletable, keptPlayed, suspectEmpty: false };
}

// ─── RULE 5: A GAME IS JUDGED AGAINST THE WHOLE GRADE, NEVER ONE ROUND ───────
//
// This rule was missing, and its absence would have deleted live fixtures.
//
// `groupStoredByRound` buckets our stored games by the `rn` they carry AT PLAN
// TIME — before any fetch. `applyRoundFixtures` then rewrites `rn` from whatever
// PlayHQ now calls the round. So when an association re-draws or renames a
// competition's rounds, every stored game keeps its OLD bucket while PlayHQ
// returns it under a NEW name. Judged round by round, each of those games looks
// withdrawn: we fetched "Round 7", PlayHQ answered about a round it now calls
// something else, and our Round 7 bucket came back unmatched.
//
// Proven, not suspected: three games PlayHQ still held, all three marked
// deletable, in a fixture where the only change was the round's name.
//
// TWO CONDITIONS, BOTH REQUIRED, before a stored game may be called withdrawn:
//
//   1. ITS ID APPEARS IN NO ROUND WE FETCHED FOR THIS GRADE. A game that came
//      back anywhere in the grade is alive, whatever round it is now in.
//
//   2. THE GRADE IS FULLY ACCOUNTED FOR — every live round we hold unplayed
//      games in was actually fetched this run. Without this, a game moved into a
//      round outside the fetch window is indistinguishable from a game that is
//      gone, and the incremental pass only fetches two rounds ahead. A grade
//      that is not fully accounted for yields NO deletions and says so.
//
// The cost is that incremental runs rarely delete, and the baseline — which
// fetches every unplayed round — does the removing. That is the right way round:
// the baseline is the pass that can see the whole grade.
function assessGradeCoverage({ rounds, byRound, fetchedRoundNames }) {
  const fetched = fetchedRoundNames instanceof Set ? fetchedRoundNames : new Set(fetchedRoundNames || []);
  const live = new Set((rounds || []).map(r => r && r.name).filter(Boolean));
  const unaccounted = [];
  for (const [rn, held] of byRound) {
    if (!live.has(rn)) continue;                       // vanished rounds are judged separately
    if (fetched.has(rn)) continue;                     // we looked
    if (!held.some(e => !isPlayedGame(e.g))) continue; // only played games there — nothing at risk
    unaccounted.push(rn);
  }
  return { fullyAccounted: unaccounted.length === 0, unaccounted };
}

// Filter a round's candidate deletions against the grade-wide alive set.
function withholdLiveElsewhere(deletable, aliveGradeWide) {
  const alive = aliveGradeWide instanceof Set ? aliveGradeWide : new Set(aliveGradeWide || []);
  const keep = [], moved = [];
  for (const e of deletable) {
    if (alive.has(e.gameId)) moved.push(e);
    else keep.push(e);
  }
  return { deletable: keep, moved };
}

// ─── Caps ────────────────────────────────────────────────────────────────────
//
// A cap that trims the deletion list and carries on is worse than no cap: it
// half-applies a change nobody reviewed. These ABORT, and the caller prints the
// full list of what it would have deleted and commits nothing from the refresh.
function makeDeletionBudget({ maxPerRun, maxPerSeason }) {
  const perSeason = new Map();
  let total = 0;
  return {
    // Returns null when the deletion is allowed, or a string reason when a cap
    // would be crossed. Never partially admits a round's deletions: a round is
    // taken whole or the run aborts, so the result can never be a half-applied
    // round.
    tryTake(seasonId, n) {
      const s = (perSeason.get(seasonId) || 0) + n;
      if (total + n > maxPerRun) {
        return `per-run deletion cap of ${maxPerRun} would be exceeded (${total} taken, ${n} more requested)`;
      }
      if (s > maxPerSeason) {
        return `per-season deletion cap of ${maxPerSeason} would be exceeded for ${seasonId} (${perSeason.get(seasonId) || 0} taken, ${n} more requested)`;
      }
      perSeason.set(seasonId, s);
      total += n;
      return null;
    },
    get total() { return total; },
    perSeasonCounts() { return new Map(perSeason); },
  };
}

module.exports = {
  FINGERPRINT_REL,
  MAX_FINGERPRINT_BYTES,
  sha12,
  hashRoundList,
  hashIdSet,
  isPlayedGame,
  loadFingerprints,
  saveFingerprints,
  pruneFingerprints,
  groupStoredByRound,
  planGrade,
  computeRoundDeletions,
  assessGradeCoverage,
  withholdLiveElsewhere,
  makeDeletionBudget,
};
