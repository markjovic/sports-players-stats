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

  // ── EVERY ROUND WE HOLD AN UNPLAYED GAME IN GETS FETCHED ────────────────
  //
  // This is what the coverage rule actually requires, and getting it half right
  // cost two rounds of measurement.
  //
  // v1 fetched only from after the current round, so a PAST round holding an
  // unplayed game was never looked at and coverage refused every deletion for
  // that grade: 197 grades withheld on the first live run, the guard blocking
  // the cleanup it exists to protect.
  //
  // v2 added past rounds and took that to 26. The residual was the mirror of the
  // same mistake: a round BEYOND the `aheadN` window holding unplayed games was
  // also never fetched, so those grades could never satisfy coverage either —
  // and since a grade is incremental for ever after its baseline, that was a
  // PERMANENT blind spot rather than a one-off.
  //
  // So the rule is symmetric and stated once: if we hold an unplayed game in a
  // round, we fetch that round, wherever it sits. `aheadN` then governs only
  // rounds we hold NOTHING for, which is its real job — discovering fixtures
  // that have appeared since.
  //
  // The cost is bounded by our own stale data and falls as it is cleaned: a
  // grade with unplayed games in eight far-out rounds costs eight fetches a
  // night until those games are played or removed, then nothing.
  //
  // The CURRENT round is always excluded — Phase 2 has already fetched it and
  // the caller feeds its ids in.
  const addHeldUnplayed = () => {
    for (let i = 0; i < rounds.length; i++) {
      if (currentIdx >= 0 && i === currentIdx) continue;
      const held = byRound.get(rounds[i].name);
      if (held && held.some(e => !isPlayedGame(e.g))) add(rounds[i], 'held-unplayed');
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
    addHeldUnplayed();
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
    addHeldUnplayed();
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

// ─── FULL-GRADE RESCAN AND CHANGE EXPANSION (2026-11-23) ─────────────────────
//
// THE DESIGN, IN MARK'S WORDS: "we are looking for any changes in fixtures, and
// when we find one we scan all of them for that grade and expand until we find
// the boundary of the changes."
//
// WHAT THIS REPLACES, AND WHY. The first version treated the forward window as
// the whole mechanism: it fetched the next `aheadN` unplayed rounds plus any
// round we hold a past-dated unplayed game in, and then — if that partial view
// could not account for every round — refused to delete anything in the grade
// (`assessGradeCoverage`). The stated reason was that a game vanishing from
// Round 6 might have MOVED to Round 14.
//
// That reason does not survive contact with the fixture. A rescheduled game
// moves by days, and rarely; it does not move two months down a junior season.
// And `withholdLiveElsewhere` already catches the real case — a game that comes
// back under any round of the grade is alive, whatever round it is now in.
//
// The guard's only measured effect was to block the cleanup the feature exists
// to perform: 26 grades and 251 candidate games withheld on 2026-11-23, every
// one of them pre-regrade residue PlayHQ had already dropped. A team was left
// holding two fixtures in two grades on the same day, which is the state the
// guard was supposed to make impossible.
//
// So the window is now for DISCOVERY ONLY — finding fixtures that have appeared
// since — and any detected change triggers a full scan of the grade, which then
// expands along the teams whose games changed into the grades they now sit in.
// Coverage is satisfied by construction rather than asserted, and PlayHQ is
// canonical: a round that was scanned and came back without a game means that
// game is gone.

// Every round of a grade that can be fetched, minus the ones already fetched.
// A round with no `id` cannot be fetched at all — `discoverFixtureByRound` takes
// the id — so it is RETURNED SEPARATELY rather than dropped silently, which is
// what the previous `add()` did and what cost a night's diagnosis.
function planGradeFull({ grade, fetchedRoundNames }) {
  const fetched = fetchedRoundNames instanceof Set ? fetchedRoundNames : new Set(fetchedRoundNames || []);
  const rounds  = Array.isArray(grade.rounds) ? grade.rounds : [];
  const fetch   = [];
  const unfetchable = [];
  const seen = new Set();
  for (const r of rounds) {
    if (!r || !r.name) continue;
    if (fetched.has(r.name)) continue;
    if (!r.id) { unfetchable.push(r.name); continue; }
    if (seen.has(r.id)) { unfetchable.push(r.name); continue; }   // duplicate id: second one is unaddressable
    seen.add(r.id);
    fetch.push({ roundId: r.id, roundName: r.name, reason: 'full-rescan' });
  }
  return { fetch, unfetchable };
}

// Did anything about this grade's fixtures change? Compares each round we
// actually fetched against the id-set hash stored for it, and treats a round the
// fingerprint has never seen as a change. A grade with no fingerprint is NOT
// reported as changed — it is a baseline, which already scans everything.
function detectGradeChange({ stored, gid, roundResults, roundListHash }) {
  if (!stored) return { changed: false, reason: 'baseline', rounds: [] };
  const prev = (stored && stored.r) || {};
  const rounds = [];
  let listChanged = !!(stored.rl && roundListHash && stored.rl !== roundListHash);
  for (const [key, got] of roundResults) {
    const bar = key.indexOf('|');
    if (bar < 0 || key.slice(0, bar) !== gid) continue;
    if (!got || !got.answered) continue;
    const rn = key.slice(bar + 1);
    const now = hashIdSet(got.ids);
    if (!Object.prototype.hasOwnProperty.call(prev, rn)) { rounds.push(rn); continue; }
    if (prev[rn] !== now) rounds.push(rn);
  }
  return { changed: listChanged || rounds.length > 0, reason: listChanged ? 'round-list' : 'round-ids', rounds };
}

// The expansion step. Given the rounds that changed in a grade, the team ids of
// every stored game in those rounds are the teams the change is ABOUT — a
// regrade removes a team's games from one grade and creates them in another, so
// those teams are the thread to follow into the next grade.
//
// ⚠ THE SIDE KEYS IN games/bv ARE `h` AND `a`, OR `t1`/`t2` — NEVER hTid/aTid.
// `applyRoundFixtures` writes `{ h, hn, a, an }`; `hTid`/`aTid` do not exist in
// that file at all. The first version of this function read hTid/aTid, taken
// from a doc instead of from the writer, so it returned NO teams and expansion
// silently expanded nothing — while its tests passed, because the fixtures were
// built with the same wrong names. Read exactly as build-player-games.js:197
// does, which is the canonical both-shapes read in this repo (T44). `p[]` carries
// no side information at all (T67) and is never consulted.
function sideIds(g) {
  const h = (g && (g.h ?? g.t1)) || null;
  const a = (g && (g.a ?? g.t2)) || null;
  return [h, a].filter(v => typeof v === 'string' && v);
}

function teamsInRounds({ byRound, roundNames }) {
  const out = new Set();
  for (const rn of roundNames) {
    for (const e of (byRound.get(rn) || [])) {
      for (const tid of sideIds((e && e.g) || {})) out.add(tid);
    }
  }
  return out;
}

// THE INVARIANT. A team holding fixtures in two different grades on the same
// DATE is wrong on its face, whatever the coverage state — it is the shape a
// half-applied regrade leaves behind. Reported in its own right rather than
// inferred from deletion arithmetic, because the previous design permitted
// exactly this state while reporting itself healthy.
function findSameDayGradeConflicts(games) {
  const byTeamDay = new Map();                       // `${tid}|${d}` → Set(gid)
  for (const id of Object.keys(games || {})) {
    const g = games[id];
    if (!g || !g.d || !g.gid) continue;
    for (const tid of sideIds(g)) {
      const key = `${tid}|${g.d}`;
      if (!byTeamDay.has(key)) byTeamDay.set(key, new Map());
      byTeamDay.get(key).set(g.gid, { id, gn: g.gn || null, played: isPlayedGame(g) });
    }
  }
  const conflicts = [];
  for (const [key, gidMap] of byTeamDay) {
    if (gidMap.size < 2) continue;
    const bar = key.indexOf('|');
    conflicts.push({
      tid:   key.slice(0, bar),
      date:  key.slice(bar + 1),
      grades: [...gidMap.keys()],
      gameIds: [...gidMap.values()].map(v => v.id),
      // The grade NAME, not just the id. Without it the report is 113 lines of
      // hex that say nothing about WHICH grades collide — and whether one side
      // is a grading pool is the first question anyone asks of this output.
      gradeNames: [...gidMap.values()].map(v => v.gn || null),
      // Whether each side was actually played. A team genuinely cannot play two
      // games on one day, but two PLAYED games mean something different from one
      // played and one not: the second is residue, the first is a data problem
      // upstream. Reported rather than judged.
      played: [...gidMap.values()].map(v => !!v.played),
    });
  }
  return conflicts;
}

// THE SAME CONFLICT, KEYED ON TEAM NAME INSTEAD OF TEAM ID.
//
// ⚠ WHY A SECOND PASS IS NEEDED AND THE FIRST ONE IS NOT ENOUGH.
// `findSameDayGradeConflicts` keys on the team ID, so it can only see a team
// that kept its identity across a regrade. PlayHQ sometimes applies a regrade by
// creating a NEW TEAM ENTRY in the destination grade — `claude/fixture-watch.md`
// records exactly this ("the regrade was made as a NEW team entry, so the real
// fixture is under a different tid"). When that happens the old grade's fixture
// and the new grade's fixture carry DIFFERENT tids, the id-keyed pass sees two
// unrelated teams, and the collision is structurally invisible to it.
//
// Names are the only thing the two identities share. `applyRoundFixtures` writes
// `hn`/`an` beside `h`/`a`, so the name is on every game without another call.
//
// Reported SEPARATELY and never merged into the id-keyed list: a name match with
// differing tids is a weaker claim than an id match, and conflating a strong
// signal with a weak one is how a report stops being trusted. Only rows whose
// tids genuinely differ are returned — anything the id pass already caught is
// excluded, so the two lists never double-count.
function findSameDayNameConflicts(games) {
  const byNameDay = new Map();                       // `${name}|${d}` → Map(gid → {...})
  for (const id of Object.keys(games || {})) {
    const g = games[id];
    if (!g || !g.d || !g.gid) continue;
    const pairs = [[g.hn, (g.h ?? g.t1) || null], [g.an, (g.a ?? g.t2) || null]];
    for (const [name, tid] of pairs) {
      if (typeof name !== 'string' || !name) continue;
      const key = `${name}|${g.d}`;
      if (!byNameDay.has(key)) byNameDay.set(key, new Map());
      byNameDay.get(key).set(g.gid, { id, tid, gn: g.gn || null, played: isPlayedGame(g) });
    }
  }
  const conflicts = [];
  for (const [key, gidMap] of byNameDay) {
    if (gidMap.size < 2) continue;
    const rows = [...gidMap.values()];
    const tids = new Set(rows.map(r => r.tid).filter(Boolean));
    if (tids.size < 2) continue;                     // same tid → the id pass owns this one
    const bar = key.lastIndexOf('|');
    conflicts.push({
      name:       key.slice(0, bar),
      date:       key.slice(bar + 1),
      grades:     [...gidMap.keys()],
      gradeNames: rows.map(r => r.gn),
      gameIds:    rows.map(r => r.id),
      tids:       rows.map(r => r.tid),
      played:     rows.map(r => r.played),
    });
  }
  return conflicts;
}

// ─── ONE INDEX, ONE RULE — SHARED BY THE REPORT AND THE FLAG ─────────────────
//
// ⚠ WHY THIS EXISTS. The stale report and the `sup` flag each built their own
// played-game lookup and each applied their own idea of "superseded". On the
// first live run they disagreed: the report said 52, the flag set 47. Two
// numbers for one concept, printed three lines apart, is how a report stops
// being evidence. They now share this index and this predicate, so they cannot
// drift again.
//
// ⚠⚠ AND THE FLAG'S OWN LOOKUP WAS ORDER-DEPENDENT. It stored ONE played game
// per team-day — `if (!map.has(key)) map.set(key, id)` — so a team with two
// played games that day kept whichever `Object.keys()` happened to yield first.
// If that one was in the SAME grade as the stale fixture, the different-grade
// game that genuinely superseded it was never seen and no flag was written. A
// silent miss decided by key order. This keeps every played game per team-day.
function playedGamesByTeamDay(games) {
  const byTeamDay = new Map();                       // `${tid}|${d}` → [gameId]
  for (const id of Object.keys(games || {})) {
    const g = games[id];
    if (!g || !g.d || !isPlayedGame(g)) continue;
    for (const tid of sideIds(g)) {
      const key = `${tid}|${g.d}`;
      if (!byTeamDay.has(key)) byTeamDay.set(key, []);
      byTeamDay.get(key).push(id);
    }
  }
  return byTeamDay;
}

// The game that superseded this fixture, or null. TWO causes, and the caller
// can tell them apart — `{ id, reason }`, reason being 'grade' or 'round'.
//
// Both require the same three things of the stale fixture: unplayed, dated in
// the past, and one of its teams has a PLAYED game on that same date.
//
//   reason 'grade' — the played game is in a DIFFERENT grade. This is the
//     regrade signal and it is the original rule.
//
//   reason 'round' — ADDED 2026-11-24. The played game is in the SAME grade AND
//     carries the SAME non-empty round name. A team plays ONE game per round per
//     grade, so two fixtures for one team in one grade and one round, where one
//     of them was played, is a DUPLICATE of that played game.
//     ⚠ Seen on screen, not theorised: B11 Spirit Magic 1 holds Round 4 against
//     B11 E.Bees 3 on 30 Oct TWICE, both in Friday U11 Boys D — one won 34-3 and
//     one still UPCOMING. The old same-grade exclusion let it through, and the
//     retired display pass used to hide it by inference.
//     ⚠⚠ THE ROUND NAME IS WHAT MAKES THIS SAFE. A genuine double-header or a
//     tournament day is two games in DIFFERENT rounds, so it is not caught. Both
//     round names must be present and equal: an absent `rn` can never match,
//     because a game with no `rn` cannot be scoped to a round at all.
//
// PRECEDENCE IS EXPLICIT: a different-grade match is searched for across every
// side and every candidate FIRST, and only then the same-round case. Otherwise
// which cause was reported would depend on team order, which is the kind of
// order-dependence that produced the 47-vs-52 miss.
function supersedingGameFor(games, g, index, cutoff) {
  if (!g || !g.d || !g.gid) return null;
  if (isPlayedGame(g)) return null;
  if (!(g.d < cutoff)) return null;

  const sides = sideIds(g);

  // Pass 1 — a PLAYED game in a different grade that day: a regrade.
  for (const tid of sides) {
    for (const other of (index.get(`${tid}|${g.d}`) || [])) {
      const o = games[other];
      if (o && o.gid !== g.gid) return { id: other, reason: 'grade' };
    }
  }

  // Pass 2 — same grade, same round, one of the pair played: a duplicate.
  const rn = typeof g.rn === 'string' ? g.rn.trim() : '';
  if (!rn) return null;
  for (const tid of sides) {
    for (const other of (index.get(`${tid}|${g.d}`) || [])) {
      const o = games[other];
      if (!o || o.gid !== g.gid) continue;
      const orn = typeof o.rn === 'string' ? o.rn.trim() : '';
      if (orn && orn === rn) return { id: other, reason: 'round' };
    }
  }
  return null;
}

// The original contract, unchanged: the id alone, or null. ONE implementation
// underneath, so the id and the reason can never disagree.
function findSupersedingGame(games, g, index, cutoff) {
  const hit = supersedingGameFor(games, g, index, cutoff);
  return hit ? hit.id : null;
}

// ─── STALE FIXTURES, PER GRADE ───────────────────────────────────────────────
//
// ⚠ THIS REPLACES A "DEAD GRADE" TEST THAT WAS BUILT ON A WRONG READING AND
// REPORTED ZERO. That test asked whether a grade had NO played game at all,
// on the theory that `Friday U11 Boys AR` was an abandoned grading pool. It is
// not: AR, BR, CR and DR are A-Reserve, B-Reserve, C-Reserve and D-Reserve —
// real divisions with real results — and PlayHQ even tags visiting teams with
// their home division, e.g. "B11 Waverley 2 (CR)". So `played > 0` always held
// and the test never fired, while the problem it was aimed at was plainly in
// the data. A whole-grade story generalised from four screenshots.
//
// What is actually wrong is a SUBSET of a grade's games: fixtures dated in the
// past that were never played and never withdrawn. PlayHQ still serves them, so
// they are not deletion candidates — rule 1 is that PlayHQ is canonical. They
// are what inflates "still to play", shows PENDING on a date long gone, and
// makes the grading flow draw moves nobody made.
//
// Reported as counts per grade so the shape is visible without reading 113
// lines: how many of a grade's games are stale, against how many it has.
// `withPlayedElsewhere` is the corroboration — stale games whose team has a
// PLAYED game in another grade on that same date. That subset is the overlap
// with findSameDayGradeConflicts and is the strongest evidence a fixture was
// superseded rather than merely postponed.
function findStaleFixtureGrades(games, { today, minStale = 1 } = {}) {
  const cutoff = today || new Date().toISOString().slice(0, 10);
  const index = playedGamesByTeamDay(games);
  const byGrade = new Map();
  for (const id of Object.keys(games || {})) {
    const g = games[id];
    if (!g || !g.gid) continue;
    if (!byGrade.has(g.gid)) {
      byGrade.set(g.gid, {
        gid: g.gid, gn: g.gn || null, total: 0, played: 0,
        stale: 0, withPlayedElsewhere: 0, withSameRoundPlayed: 0, staleDates: [], examples: [],
      });
    }
    const e = byGrade.get(g.gid);
    if (g.gn && !e.gn) e.gn = g.gn;
    e.total++;
    if (isPlayedGame(g)) { e.played++; continue; }
    if (!g.d || !(g.d < cutoff)) continue;           // unplayed but not yet due: normal
    e.stale++;
    e.staleDates.push(g.d);
    // ⚠ The SAME rule the flag uses, not a looser one. This counted any played
    // game that day, same grade included, and so reported 52 where the flag
    // wrote 47. Mislabelling five double-headers as superseded regrades.
    // ⚠ withPlayedElsewhere KEEPS ITS ORIGINAL MEANING — different grade only.
    // The same-round duplicates added on 2026-11-24 are counted separately, so
    // a number that has been reported for weeks does not silently change what it
    // means. Both are flagged; only the reason differs.
    const hit = supersedingGameFor(games, g, index, cutoff);
    if (hit && hit.reason === 'grade') e.withPlayedElsewhere++;
    if (hit && hit.reason === 'round') e.withSameRoundPlayed++;
    if (e.examples.length < 3) e.examples.push({ id, d: g.d, rn: g.rn || null, superseded: !!hit, reason: hit ? hit.reason : null });
  }
  const out = [];
  for (const e of byGrade.values()) {
    if (e.stale < minStale) continue;
    const dates = e.staleDates.slice().sort();
    out.push({
      gid: e.gid, gn: e.gn, total: e.total, played: e.played, stale: e.stale,
      withPlayedElsewhere: e.withPlayedElsewhere,
      withSameRoundPlayed: e.withSameRoundPlayed,
      firstStale: dates[0], lastStale: dates[dates.length - 1],
      examples: e.examples,
    });
  }
  return out.sort((a, b) => b.stale - a.stale);
}

// ─── THE `sup` FLAG: a fixture superseded by a regrade ───────────────────────
//
// WHAT IT MARKS. A game that is past-dated, was never played, is still served by
// PlayHQ, and whose team has a PLAYED game in a DIFFERENT grade on that same
// date. That is a fixture the association replaced when it regraded the team and
// never withdrew. 52 of them in season 3d25b666 on 2026-11-24, all U11.
//
// WHY IT IS A FLAG AND NOT A DELETION. PlayHQ still serves these games, and rule
// 1 is that PlayHQ is canonical. Deleting them would be inventing a withdrawal
// the source never made. But left unmarked they inflate "still to play", render
// as UPCOMING on a date months gone, and make the grading flow draw moves nobody
// made. Mark's call, 2026-11-24: the marker lives in the DATA, so `team-stats`,
// the fixture card, the grading panel and the season card all read one field
// instead of each re-deriving the same rule.
//
// ⚠⚠ IT IS DERIVED, SO IT MUST BE RECOMPUTED AND CLEARED ON EVERY RUN.
//
// This returns BOTH what to set and what to clear, and the caller must apply
// both. A flag that is only ever set is a flag that outlives its condition:
//   · the game is finally played      → it has a score, no longer superseded
//   · PlayHQ withdraws it             → Phase 2R deletes it, flag goes with it
//   · the OTHER game is deleted       → the team no longer played elsewhere that
//                                       day, so this fixture is just unplayed
//   · the association restores it      → nothing supersedes it any more
// And `applyRoundFixtures` spreads `...existing` before overlaying new values,
// so a `sup` already on disk SURVIVES a refetch. Set-only would make a wrong
// flag permanent and invisible. Clearing is not an optimisation here, it is the
// difference between a derived field and a lie.
//
// The value is the game id that superseded it — not `true`. A bare boolean says
// "this is wrong" and leaves nobody able to check it; the id makes every flag
// auditable against PlayHQ's own game centre in one click.
function computeSupersededFlags(games, { today } = {}) {
  const cutoff = today || new Date().toISOString().slice(0, 10);

  const index = playedGamesByTeamDay(games);

  const set = new Map();     // gameId → superseding gameId
  const clear = [];          // gameId
  // Two causes, counted separately and RETURNED, so the caller can print them.
  // A count that is accumulated and never shown is the same defect as a counter
  // that only ever increments. `flagged` counts every flag that STANDS this run,
  // not only the ones newly written, because `set` excludes the already-correct.
  const reasons = { grade: 0, round: 0 };
  for (const id of Object.keys(games || {})) {
    const g = games[id];
    if (!g) continue;
    const had = Object.prototype.hasOwnProperty.call(g, 'sup');

    const hit = supersedingGameFor(games, g, index, cutoff);
    const supersededBy = hit ? hit.id : null;

    if (supersededBy) {
      reasons[hit.reason]++;
      if (!had || g.sup !== supersededBy) set.set(id, supersededBy);
    } else if (had) {
      clear.push(id);
    }
  }
  return { set, clear, reasons };
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
  planGradeFull,
  detectGradeChange,
  sideIds,
  teamsInRounds,
  findSameDayGradeConflicts,
  supersedingGameFor,
  findSameDayNameConflicts,
  findStaleFixtureGrades,
  playedGamesByTeamDay,
  findSupersedingGame,
  computeSupersededFlags,
  computeRoundDeletions,
  assessGradeCoverage,
  withholdLiveElsewhere,
  makeDeletionBudget,
};
