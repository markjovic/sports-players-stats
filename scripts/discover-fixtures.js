#!/usr/bin/env node
// scripts/discover-fixtures.js
/**
 * Discovers fixtures for all teams using discoverTeamFixture — which works for
 * ALL seasons (including historical), returns all rounds in one call per team,
 * and includes venue, court, time, scores, and team details.
 *
 * Strategy:
 *   1. For each season in sports-index.json, get team IDs from discoverGrade.ladder
 *   2. For each team, call discoverTeamFixture(teamID)
 *   3. Write/update game entries in games/bv/{seasonId}.json with:
 *      - Scores (hs, as), venue (vid, vn, ct, t), round name (rn)
 *      - Team IDs and names (h, hn, a, an), game status (st)
 *      - Constructed PlayHQ URL (url)
 *   4. Populate venue-lookup/{prefix}.json shards
 *
 * Safe to re-run — deduplicates by game ID, skips already-complete entries.
 *
 * Usage:
 *   node discover-fixtures.js                       # active seasons only (locked: false)
 *   node discover-fixtures.js --all-seasons         # all seasons including completed
 *   node discover-fixtures.js --locked-resweep      # locked && !removed — §2.2 historical re-sweep
 *   node discover-fixtures.js --current-only        # weekly mode: skip finished seasons
 *   node discover-fixtures.js --season=<id>         # single season (no progress file)
 *   node discover-fixtures.js --concurrency=20      # team fetches in parallel
 *
 * 2026-08-03 hardening (§2.2 Phase 0 findings):
 *   - Progress file is MODE-KEYED BY FILENAME (discover-fixtures-progress-{mode}.json) so a
 *     weekly --current-only run can never resume over — or clear — a cancelled historical
 *     sweep's checkpoint. The old unkeyed file is removed on the next successful run.
 *   - loadGameFile THROWS when an existing season file fails to parse (matches nightly-crawl);
 *     the old {games:{}} fallback would have rewritten a corrupt file as fixture-only data.
 *   - A season where EVERY enumeration call returned null is TRANSIENT (API failure, WAF
 *     block), not zero-team: it is retried in a second pass, and anything still failing turns
 *     the run red AFTER committing — never silently recorded as done-with-no-teams.
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

// ─── Config ───────────────────────────────────────────────────────────────────

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const TENANT        = ARGS.tenant      || 'bv';
const TENANT_FULL   = { bv: 'basketball-victoria', afl: 'afl' }[TENANT] || TENANT;
const CONCURRENCY   = parseInt(ARGS.concurrency || '20', 10);
const TARGET_SEASON = ARGS.season      || null;
const ALL_SEASONS   = !!ARGS['all-seasons'];
const DRY_RUN       = !!ARGS['dry-run'];   // resolve everything, write/commit nothing
const CURRENT_ONLY  = !!ARGS['current-only']; // skip finished seasons (weekly mode)
const LOCKED_RESWEEP = !!ARGS['locked-resweep']; // §2.2: locked && !removed historical re-sweep
// discoverTeams is ON by default: it is the only route that reaches an
// all-grading season, and it costs ONE request per season against dozens of
// per-grade ladder calls. --no-season-teams restores the pre-2026-08-19 behaviour
// if it ever needs to be isolated.
const USE_SEASON_TEAMS = !ARGS['no-season-teams'];

// ── THE SPLIT (2026-11-24) ───────────────────────────────────────────────────
// The sweep holds the data-write lock for six hours and needs it for five minutes:
// 83% of a run is a 90-second WAF pause and the commits themselves totalled 4.2 min
// of 5h 50m on 2026-11-10. So the run is now two jobs.
//
//   --emit=<file>   do every PlayHQ read, write NOTHING to the tree and commit
//                   nothing; record what was found to <file>. Takes no lock.
//   --apply=<file>  take the lock, check out fresh, replay <file> onto the files
//                   as they are NOW, and commit once.
//
// This is only safe because flushGameFiles re-reads and merges (see the note at
// _pendingFixtures): the changeset carries the fields PlayHQ ANSWERED, never a
// whole row, so replaying it an hour later cannot overwrite a fresher value.
const EMIT_PATH  = typeof ARGS.emit  === 'string' ? ARGS.emit  : null;
const APPLY_PATH = typeof ARGS.apply === 'string' ? ARGS.apply : null;
const CHANGESET_V = 1;

if (ARGS.emit === true || ARGS.apply === true) {
  console.error('--emit and --apply take a file path: --emit=/path/to/changeset.json');
  process.exit(1);
}
if (EMIT_PATH && APPLY_PATH) {
  console.error('--emit and --apply are the two halves of one run; give one or the other');
  process.exit(1);
}

if (LOCKED_RESWEEP && (ALL_SEASONS || CURRENT_ONLY || TARGET_SEASON)) {
  console.error('--locked-resweep is exclusive with --all-seasons / --current-only / --season');
  process.exit(1);
}

// Progress-file mode key: every distinct target-selection gets its own file.
const MODE = TARGET_SEASON ? 'single'
  : LOCKED_RESWEEP ? 'locked-resweep'
  : (ALL_SEASONS ? 'all' : 'active') + (CURRENT_ONLY ? '-current' : '');

const API_URL     = 'https://api.playhq.com/graphql';
const GAMES_DIR   = path.join(ROOT, 'games', TENANT);
const VENUE_DIR   = path.join(ROOT, 'venue-lookup');
const INDEX_FILE  = path.join(ROOT, 'data', 'sports-index.json');
const COOKIE_FILE = path.join(ROOT, `cookie-${TENANT}.json`);

// ─── Headers ──────────────────────────────────────────────────────────────────

const MOBILE_HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT_FULL,
  'content-type': 'application/json',
};

// ─── Cookie ───────────────────────────────────────────────────────────────────

let _cookie = null;

// ⚠️ 2026-10-04 — THE SESSION HAS A REQUEST BUDGET AND IT IS SMALLER THAN IT WAS.
// The 2026-10-04 Weekly Indexes run obtained a cookie, processed 240 teams cleanly,
// and then EVERY TeamFixture call returned 403 — for four hours, across retries,
// never recovering. The cookie was not rejected at the start; it stopped being
// accepted partway through. Retrying the same dead cookie cannot fix that, which is
// exactly what the generic !res.ok branch did: four attempts, five seconds apart,
// with the identical Cookie header, then "giving up on this call" — for every one of
// the remaining 386 teams and then 377 more seasons.
// Invalidating and re-obtaining the session is the only thing that can work.
// ⚠️ THE REFRESH MUST BE SINGLE-FLIGHT. The first version of this had no lock, and
// at concurrency 20 the result was visible in the log: twenty calls hit 403, twenty
// called invalidateSession(), and twenty ran their own bootstrap — "Fetching session
// cookie..." twenty times in a row. THAT BURST IS ITSELF REFUSED, so the bootstrap
// came back "No Set-Cookie", every caller retried, and it never escaped.
// One refresh at a time; everyone else waits on the same promise.
// (discover-org-seasons.js has had a promise-locked session for this reason.)
let _sessionPromise = null;

// ⚠️ THE SESSION HAS A REQUEST BUDGET OF ROUGHLY 290 CALLS. Measured 2026-10-04 on
// season 7f7c13f5: clean to team 280, 403; recovered; clean again to team 580, 403.
// Twice, ~300 apart. It is a budget, not a block and not a fingerprint.
//
// Waiting for the 403 costs TWO MINUTES every time, because the bootstrap inside the
// penalty window is itself refused and all three backoff steps (20s + 40s + 60s) are
// consumed before a cookie comes back. Over 648 teams that is two stalls; over the
// 378 seasons weekly-indexes.yml sweeps it would be hundreds, which is how a run
// spends six hours and finishes nothing.
//
// So ROTATE BEFORE THE BUDGET RUNS OUT. A refresh requested while the current cookie
// still works is granted immediately — the penalty only applies once PlayHQ has
// started refusing. 250 leaves room for the ~20 calls already in flight at
// concurrency 20 to land on the old cookie without crossing the line.
// ⚠️ MEASURED 2026-10-13, AND IT OVERTURNS THE §6.59 MODEL. Two read-only runs
// of measure-playhq-limits:
//   budget    400 calls on ONE cookie at 18/min — zero refusals. No lifetime budget.
//   bootstrap  60 cookieless bootstraps at 6/min — zero refusals. No bootstrap quota.
// The ~290 "request budget" was a RATE measured at high concurrency, not a count.
// The fixture logs agree independently: refusals arrived 60-80 calls after a FRESH
// cookie, nowhere near 290, and a PROACTIVE rotation was always granted instantly
// while a post-403 bootstrap was refused three times. Both facts have one cause —
// a per-IP request-rate WAF that refuses EVERYTHING, queries and bootstraps alike,
// while it is tripped. Rotating the cookie cannot help with a rate; it only adds a
// request, and one that stalls for 120s if it lands inside the penalty window.
//
// So rotation is now keyed to the cookie's AGE (TTL is ~30-40 min per
// playhq_api_reference.md), and the rate itself is governed by rateGate() below.
const ROTATE_AGE_MS = parseInt(ARGS['rotate-age-min'] || '25', 10) * 60 * 1000;
// ⚠️ RESTORED 2026-10-13 AFTER REMOVING IT WAS WRONG. The probes that said "no
// lifetime budget" used PublicProfileTeams, which playhq_api_reference records as
// the FRIENDLIER operation; this sweep uses discoverTeamFixture. The first cron run
// without the call rotation took a 403 burst in six of seven seasons, every one of
// them 200-330 calls after a fresh cookie — the same ~290 §6.59 measured. Whatever
// the mechanism, rotating proactively costs ONE request and not rotating costs a
// 120s stall, so both triggers apply and whichever comes first wins.
const ROTATE_AFTER = parseInt(ARGS['rotate-after'] || '250', 10);
const RUN_T0 = Date.now();
let _cookieAt = 0, _callsOnCookie = 0;

// Requests per rolling 60s across EVERY PlayHQ call this process makes — queries
// and bootstraps share one window, because the WAF does.
//
// ⚠️ 300 IS MEASURED NOW, NOT DERIVED. The 1ae60211 run of 2026-10-13 carried a
// clock on every progress line, and the window count AT THE MOMENT OF EACH BLOCK
// was: 366, 422, 322, 342, 362, 342. The WAF trips between roughly 320 and 420
// requests per rolling 60s — NOT the ~940-1,340 playhq_api_reference records, so
// that figure does not describe this operation. 600 never bound: the block always
// arrived first, which is exactly why six of them cost 9 minutes of a 11.2 minute
// run. 300 sits under the lowest observed trip with room to spare.
//
// ⚠️ THE SAME RUN SETTLES BUDGET-VS-RATE. Block #1 came 100 teams after a fresh
// cookie; block #2 came ~160 teams after a rotation; the CALL counts differ, the
// WINDOW counts do not. It is a rate. ROTATE_AFTER is kept because a cookie still
// has a TTL and rotating costs one request, but it is not what prevents these.
// --rate=0 disables the gate.
// ⚠️ DEFAULT IS OFF. Three runs of the same season, same teams, one variable:
// SETTLED 2026-10-13. Stop tuning this. BLOCKS PER TEAM is the metric, because
// elapsed is ~90s x blocks and the work itself costs almost nothing:
//     600/min counter       6 blocks / 2093 teams = 1 per 349   <-- SHIPPED
//     no gate (pre-§6.74)   3 blocks /  863 teams = 1 per 288
//     300/min counter       8 blocks / 2093 teams = 1 per 262
//     no gate (2026-10-13)  4 blocks /  940 teams = 1 per 235
//     300/min PACED         ruined by T80; discard
//     600/min PACED        16 blocks / 2093 teams = 1 per 131  <-- WORST
// Six configurations over six runs. The rolling counter at 600 wins and PACING
// LOSES: spacing requests evenly made the WAF block SOONER, twice, which is the
// opposite of what every rate-limiter instinct predicts. The mechanism is not
// understood and does not need to be — the measurement is consistent and the
// cost of further tuning has already exceeded the ~9 min of pausing it buys.
// Pacing survives behind --pace for anyone who wants to re-measure it, OFF by
// default. Do not turn it on without a reason better than "it should work".
const RATE_PER_MIN = parseInt(ARGS.rate === undefined ? '600' : ARGS.rate, 10);
const _rateWindow = [];
// When the WAF refuses us it refuses the whole IP — so twenty callers each
// retrying is twenty more refused requests feeding the thing that blocked us.
// One 403 parks EVERY caller until the recovery window passes. Documented
// recovery is a flat ~80s; 90 gives it margin.
const BLOCK_PAUSE_MS = parseInt(ARGS['block-pause-sec'] || '90', 10) * 1000;
let _blockUntil = 0, _blockEvents = 0;
function noteBlocked(why) {
  const now = Date.now();
  if (now < _blockUntil) return;            // already parked by a sibling call
  _blockEvents++;
  _blockUntil = now + BLOCK_PAUSE_MS;
  console.log(`  ⏸ ${why} — pausing ALL requests for ${Math.round(BLOCK_PAUSE_MS/1000)}s (block #${_blockEvents})`);
}
// ⚠️ A ROLLING COUNTER IS NOT A PACER, AND THAT WAS THE WHOLE PROBLEM.
// The first version capped requests per 60s and nothing else, so after a 90s
// block pause every entry had aged out and the window was EMPTY — it then
// admitted a full allowance instantly. At concurrency 20 that is ~300 requests
// in 13-15 seconds, which is the same instantaneous rate as having no gate at
// all. It is why lowering 600 → 300 made things WORSE rather than better
// (6 blocks/11.2 min → 8 blocks/17.8 min, 2026-10-13): the burst shape never
// changed, only how soon each burst ran out.
//
// `_minGapMs` fixes the shape. 300/min is now one request every 200ms, enforced
// between admissions, so twenty concurrent callers are paced instead of firing
// together. The window cap stays as a second bound for the long run.
const PACE = ARGS.pace === '1' || ARGS.pace === 'true' || ARGS.pace === '';
const _minGapMs = (PACE && RATE_PER_MIN > 0) ? Math.ceil(60000 / RATE_PER_MIN) : 0;
// WARN: the progress line read `_rateWindow.length`, which only rateGate fed, so
// with the gate OFF it printed `0/min` for the whole run. The throughput number
// went dark in exactly the configuration we are trying to measure. Every request
// now stamps the window; the gate READS it, it does not own it.
// WARN: when the gate is ON it stamps its OWN admission, inside the same
// synchronous block as the cap check. That check-and-set is the reservation, and
// it must stay atomic: a first attempt at this moved the stamp out here, one
// microtask later, which left the window reading ONE SHORT between admitting and
// stamping and let an extra caller past the cap under 300-way concurrency.
// So this stamps only when the gate is OFF, which is the case it exists for.
function noteRequest() {
  if (RATE_PER_MIN > 0) return;
  const cut = Date.now() - 60000;
  while (_rateWindow.length && _rateWindow[0] <= cut) _rateWindow.shift();
  _rateWindow.push(Date.now());
}
let _lastAdmit = 0;
async function rateGate() {
  while (Date.now() < _blockUntil) await delay(Math.min(5000, _blockUntil - Date.now()));
  if (!(RATE_PER_MIN > 0)) return;
  for (;;) {
    const now = Date.now(), cut = now - 60000;
    while (_rateWindow.length && _rateWindow[0] <= cut) _rateWindow.shift();
    // Spacing first: this is what stops the post-pause burst.
    const gap = (_lastAdmit + _minGapMs) - now;
    if (gap > 0) { await delay(gap); continue; }
    if (_rateWindow.length < RATE_PER_MIN) {
      // Check-and-set is synchronous between awaits, so exactly one caller can
      // take each slot however many are waiting.
      // Check-and-set is synchronous between awaits, so exactly one caller can
      // take each slot however many are waiting. The stamp MUST happen here, not
      // in noteRequest() — see the note there.
      _lastAdmit = now; _rateWindow.push(now); return;
    }
    await delay(Math.max(50, _rateWindow[0] - cut));
  }
}

// ⚠️ T80. DO NOT CLEAR `_sessionPromise` HERE. It is the single-flight lock, and
// clearing it lets the NEXT caller start a second bootstrap while the first is
// still in the air. That was survivable while twenty 403s arrived in the same
// tick — they all invalidated, then all awaited the one promise the first of
// them created. Pacing (§6.77) spread those callers out in TIME, so each now
// arrives to find the lock cleared and starts its own: the 2026-10-13 run shows
// eight "Fetching session cookie..." and eight "✓ Cookie obtained" in a row.
// That burst is itself refused — §6.59 fault 2 and §6.61's nightly-crawl fault,
// reintroduced by a change made somewhere else entirely.
//
// A refresh already in flight is the refresh this caller wants. `_cookieGen`
// lets a caller say WHICH cookie it is complaining about, so a 403 raised
// against an already-replaced cookie does not trigger yet another rotation.
let _cookieGen = 0;
// Returns TRUE only when this call actually rotated. The 2026-10-13 run printed
// twenty "re-authenticating" lines for ONE rotation: the guard was working and
// the log was describing the intent of each caller rather than what happened.
// A log that overstates the work is the same fault as one that hides it.
function invalidateSession(gen) {
  if (gen !== undefined && gen !== _cookieGen) return false;   // already rotated past it
  _cookie = null;
  _cookieGen++;
  try { if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE); } catch (_) {}
  return true;
}

async function getSession() {
  if (_cookie) return _cookie;
  // Someone is already fetching one — wait for theirs rather than starting another.
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = (async () => {
    try { return await fetchSessionOnce(); }
    finally { _sessionPromise = null; }
  })();
  return _sessionPromise;
}

async function fetchSessionOnce() {
  if (_cookie) return _cookie;
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const d = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      // A cookie read from disk has unknown mileage — a previous run may have used
      // most of its budget. Start it at the rotation threshold so the first 403 is
      // not how we find out.
      // A cookie from disk has unknown AGE as well as unknown mileage, and the TTL
      // is the thing that matters now. Trust it only inside the rotation window,
      // dated from when it was actually fetched.
      // Unknown mileage: start a disk cookie AT the threshold so its first use
      // rotates rather than discovering the limit with a 403.
      if (Date.now() - d.fetchedAt < ROTATE_AGE_MS) { _cookie = d.cookie; _cookieAt = d.fetchedAt; _callsOnCookie = ROTATE_AFTER; return _cookie; }
    }
  } catch (e) {}
  console.log('  Fetching session cookie...');
  await rateGate();               // a bootstrap is a request like any other
  noteRequest();
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({
      operationName: 'ProfileSearch',
      variables:     { fullName: 'test player' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
    }),
  });
  const raw = res.headers.get('set-cookie');
  // A refused bootstrap is a rate signal, not a transient blip. Three attempts with
  // a long, growing wait — retrying this quickly is what kept the block alive.
  if (!raw) {
    // WARN: a refused BOOTSTRAP is a block, and until 2026-10-13 it did not say so.
    // noteBlocked() was called on a refused query but not here, so while this
    // retried over 120s the other 19 callers were never parked and kept firing
    // into a live block. The 2026-10-13 run ends on exactly that: three refused
    // bootstraps, no pause, no block counted.
    noteBlocked('session bootstrap refused');
    for (let i = 1; i <= 3; i++) {
      const wait = 20000 * i;
      console.log(`  … session bootstrap refused, waiting ${wait / 1000}s (attempt ${i}/3)`);
      await delay(wait);
      await rateGate();
      noteRequest();
      const r2 = await fetch(API_URL, {
        method:  'POST',
        headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() },
        body:    JSON.stringify({ operationName: 'ProfileSearch', variables: { fullName: 'a' },
          query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' }),
      });
      const raw2 = r2.headers.get('set-cookie');
      if (raw2) {
        _cookie = raw2.split(';')[0];
        _cookieAt = Date.now(); _callsOnCookie = 0;
        fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie: _cookie, fetchedAt: Date.now() }));
        console.log(`  ✓ Cookie obtained (after ${i} backoff attempt(s))`);
        return _cookie;
      }
    }
    throw new Error('No Set-Cookie');
  }
  _cookie = raw.split(';')[0];
  _cookieAt = Date.now(); _callsOnCookie = 0;
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie: _cookie, fetchedAt: Date.now() }));
  console.log('  ✓ Cookie obtained');
  return _cookie;
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// 2026-08-13 — TWO SILENT-HANG BUGS FIXED HERE. The weekly run froze after
// "Teams: 594" and produced no further output at all, for over five minutes,
// until it was cancelled.
//
// (1) NO TIMEOUT. Node's fetch waits FOREVER for a response that never arrives.
//     The caller batches teams with `await Promise.all(batch.map(processTeam))`,
//     so ONE stalled socket blocks its whole batch, and therefore the entire run,
//     silently and permanently. Every request now carries an explicit timeout and
//     a stalled request becomes an ordinary retryable failure.
// (2) THE 429 BRANCH LOOPED FOREVER. `if (res.status === 429) { delay; continue; }`
//     never incremented `attempts`, so sustained rate limiting spun at ten seconds
//     a turn with no output and no exit — the same symptom as a hang, and
//     impossible to tell apart from one in the log. 429s are now counted and give
//     up like any other failure.
//
// Both fixes are visible by design: every retry PRINTS. A silent stall is what
// cost this run, so the tool must now say what it is waiting for.
//
// NOT the cause: concurrency. The weekly cron runs at 40 and that is the proven
// working value on this endpoint — a single stalled socket freezes a batch of any
// size, so batch width was never the problem. (Recorded because I twice argued
// otherwise from my own assumptions instead of the run log.)
const GQL_TIMEOUT_MS  = 30000;   // per request
const GQL_MAX_ATTEMPTS = 4;      // total tries per call, including the first

// Requests that gave up, and 403s seen. A sweep that reports "0 new, 0 updated"
// after being refused is reporting a measurement it did not take.
let _refused403 = 0, _gaveUp = 0;

async function gql(operationName, query, variables) {
  let attempts = 0;
  let reauths  = 0;              // session refreshes used on THIS call
  while (true) {
    try {
      // Rotate on AGE, before the ~30-40 min TTL expires. invalidateSession() is
      // idempotent and getSession() is single-flight, so the twenty callers that
      // cross the line together still produce exactly one bootstrap.
      // (Was a 250-CALL rotation. Measured 2026-10-13: there is no per-cookie call
      // budget, so counting calls bought nothing and spent a request each time.)
      if (_cookie && ROTATE_AFTER > 0 && _callsOnCookie >= ROTATE_AFTER) {
        console.log(`  ↻ ${_callsOnCookie} calls on this session — rotating before it is refused`);
        invalidateSession();
      } else if (_cookie && _cookieAt && (Date.now() - _cookieAt) >= ROTATE_AGE_MS) {
        console.log(`  ↻ session is ${Math.round((Date.now()-_cookieAt)/60000)} min old — rotating before the TTL expires`);
        invalidateSession();
      }
      // Read the cookie INSIDE the loop. It used to be fetched once before the loop,
      // so a refreshed session could never reach the retry that needed it.
      const cookie = await getSession();
      const gen = _cookieGen;            // which cookie THIS call is using
      // The gate is taken HERE, after the cookie is in hand and immediately before
      // the request leaves — so a bootstrap that happened on the way through has
      // already spent its own slot, and the window counts what actually went out.
      await rateGate();
      noteRequest();
      _callsOnCookie++;
      const res = await fetch(API_URL, {
        method:  'POST',
        headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
        body:    JSON.stringify({ operationName, variables, query }),
        signal:  AbortSignal.timeout(GQL_TIMEOUT_MS),
      });
      if (res.status === 429) {
        if (++attempts >= GQL_MAX_ATTEMPTS) {
          console.log(`  ⚠ ${operationName}: rate limited (429) ${attempts}x — giving up on this call`);
          return null;
        }
        const wait = 10000 * attempts;
        console.log(`  … ${operationName}: 429 rate limited, waiting ${wait / 1000}s (attempt ${attempts}/${GQL_MAX_ATTEMPTS})`);
        await delay(wait);
        continue;
      }
      // 403 means the SESSION is being refused, not this request. Throw it away and
      // get a new one rather than replaying the dead cookie. Bounded at 2 per call:
      // if a fresh session is refused twice, this is not a session problem and
      // hammering it is what turned a four-hour run into nothing.
      if (res.status === 403 && reauths < 2) {
        reauths++;
        _refused403++;
        noteBlocked(`${operationName}: HTTP 403`);
        const rotated = invalidateSession(gen);   // false if a sibling already did it
        console.log(rotated
          ? `  … ${operationName}: HTTP 403 — session refused, rotating (${reauths}/2)`
          : `  … ${operationName}: HTTP 403 — refused on cookie gen ${gen}, already rotated — waiting`);
        await delay(2000);
        continue;
      }
      if (!res.ok) {
        if (++attempts < GQL_MAX_ATTEMPTS) {
          console.log(`  … ${operationName}: HTTP ${res.status}, retry ${attempts}/${GQL_MAX_ATTEMPTS} in 5s`);
          await delay(5000);
          continue;
        }
        console.log(`  ⚠ ${operationName}: HTTP ${res.status} after ${attempts} attempts — giving up on this call`);
        _gaveUp++;
        return null;
      }
      const json = await res.json();
      if (json.errors) return null;
      return json.data;
    } catch (e) {
      const why = (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))
        ? `no response in ${GQL_TIMEOUT_MS / 1000}s`
        : (e && (e.code || e.message)) || 'network error';
      if (++attempts < GQL_MAX_ATTEMPTS) {
        console.log(`  … ${operationName}: ${why}, retry ${attempts}/${GQL_MAX_ATTEMPTS} in 3s`);
        await delay(3000);
        continue;
      }
      console.log(`  ⚠ ${operationName}: ${why} after ${attempts} attempts — giving up on this call`);
      _gaveUp++;
      return null;
    }
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const Q_GRADE_TEAMS = `
query DiscoverGrade($id: ID!) {
  discoverGrade(gradeID: $id) {
    id name
    ladder {
      pool { name }
      standings { team { id name } }
    }
  }
}`;

// ─── discoverTeams: teams WITHOUT going through a ladder ─────────────────────
// Added 2026-08-19. The ladder route below cannot see a season whose grades are
// all GRADING grades: a grading grade returns `ladder: []` (not an error — it is
// not a competition), so the season enumerates zero teams and no fixture is ever
// fetched for it. Seven seasons were in that state, six of them ACTIVE, including
// EDJBA Winter 2026 which holds 55 grading grades against 263 live ones.
//
// MEASURED ON THIS TENANT 2026-08-19 (probe-discover-teams), not assumed from the
// junior-footy-dashboard import it came from:
//   1ae60211 EDJBA        → 2,093 teams, 263 grades, 22 orgs
//   aacc7335 Camberwell   →   672 teams,  82 grades, 14 orgs
//   7ccb2e98 Altona (ctl) →   385 teams,  51 grades, 20 orgs
// `ID!` is the correct variable type here — note that is the OPPOSITE of
// discoverSeason on the same tenant, which needs String!.
//
// ⚠️ IT IS NOT A STRICT SUPERSET OF THE LADDER ROUTE. Camberwell returned 13 of
// the 16 grades our held games use. So this is UNIONED with the ladder result and
// never replaces it — dropping the old path would lose those three grades.
//
// ⚠️ `grade` CAN BE NULL on a returned team (EDJBA's first team: z101, U7, no
// grade). Anything reading team.grade.id must tolerate that.
const Q_SEASON_TEAMS = `
query discoverTeamsBySeason($seasonId: ID!) {
  discoverTeams(filter: {seasonID: $seasonId}) {
    id
    grade { id name }
  }
}`;

const Q_TEAM_FIXTURE = `
query TeamFixture($teamID: ID!) {
  discoverTeam(teamID: $teamID) {
    id
    grade { id name }
    season {
      id name
      competition { id name organisation { id name } }
      status { value }
    }
    organisation { id name }
  }
  discoverTeamFixture(teamID: $teamID) {
    id name isFinalsRound
    grade {
      id name
      season {
        id name
        competition { id name organisation { id name } }
      }
    }
    fixture {
      games {
        id dates
        status { value }
        home {
          ... on DiscoverTeam {
            id name
            logo { sizes { url dimensions { width } } }
            organisation { id name }
          }
        }
        away {
          ... on DiscoverTeam {
            id name
            logo { sizes { url dimensions { width } } }
            organisation { id name }
          }
        }
        result {
          home { statistics { count type { value } } }
          away { statistics { count type { value } } }
        }
        allocation {
          dateTimeList { date time }
          court {
            id name abbreviatedName
            venue {
              id name abbreviatedName
              latitude longitude
              address suburb state postcode country
            }
          }
        }
      }
    }
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[()]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
}

function buildGameUrl(gameId, orgName, compName, seasonName, gradeName) {
  const org   = slugify(orgName);
  const comp  = slugify(`${compName} ${seasonName}`);
  const grade = slugify(gradeName);
  if (!org || !comp || !grade) return null;
  return `https://www.playhq.com/${TENANT_FULL}/org/${org}/${comp}/${grade}/game-centre/${gameId}`;
}

function smallestLogo(logo) {
  if (!logo?.sizes?.length) return null;
  return logo.sizes.sort((a, b) => (a.dimensions?.width || 999) - (b.dimensions?.width || 999))[0]?.url || null;
}

function parseScore(statistics) {
  return statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;
}

// ─── Venue lookup shards ──────────────────────────────────────────────────────

const _venueShards = {};
const _dirtyVenues = new Set();

function loadVenueShard(venueId) {
  const prefix = venueId.slice(0, 2);
  if (!_venueShards[prefix]) {
    const f = path.join(VENUE_DIR, `${prefix}.json`);
    try { _venueShards[prefix] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; }
    catch (e) { _venueShards[prefix] = {}; }
  }
  return _venueShards[prefix];
}

// While emitting there is no point loading the shards of a checkout that is about
// to be thrown away — and the shards the apply job must merge into are the ones in
// ITS checkout. So record the raw venue and court and replay storeVenue there.
const _pendingVenues = [];
const _seenVenueKeys = new Set();

function storeVenue(venue, court) {
  if (!venue?.id) return;
  if (EMIT_PATH) {
    const k = `${venue.id}|${court?.id || ''}`;
    if (!_seenVenueKeys.has(k)) { _seenVenueKeys.add(k); _pendingVenues.push({ venue, court: court || null }); }
    return;
  }
  const prefix = venue.id.slice(0, 2);
  const shard  = loadVenueShard(venue.id);
  if (!shard[venue.id]) {
    shard[venue.id] = {
      name: venue.name, abbr: venue.abbreviatedName || null,
      lat: venue.latitude || null, lng: venue.longitude || null,
      address: venue.address || null, suburb: venue.suburb || null,
      state: venue.state || null, postcode: venue.postcode || null,
      country: venue.country || null, courts: {},
    };
    _dirtyVenues.add(prefix);
  }
  if (court?.id && !shard[venue.id].courts[court.id]) {
    shard[venue.id].courts[court.id] = { name: court.name, abbr: court.abbreviatedName || null };
    _dirtyVenues.add(prefix);
  }
}

function flushVenueShards() {
  if (EMIT_PATH) return 0;
  if (DRY_RUN) return 0;
  if (!fs.existsSync(VENUE_DIR)) fs.mkdirSync(VENUE_DIR, { recursive: true });
  let count = 0;
  for (const prefix of _dirtyVenues) {
    fs.writeFileSync(path.join(VENUE_DIR, `${prefix}.json`), JSON.stringify(_venueShards[prefix]));
    count++;
  }
  _dirtyVenues.clear();
  return count;
}

// ─── Game file helpers ────────────────────────────────────────────────────────

const _gameFileCache = {};
const _dirtySeasons  = new Set();   // only season files with a real change get written

// ⚠️ 2026-11-24 — WHAT THIS RUN FOUND, KEPT APART FROM WHAT IT READ.
// `_gameFileCache` holds a season file as it was when the season was first
// touched, which on a six-hour sweep is up to six hours old. flushGameFiles used
// to write that object back WHOLE, so anything another writer had put in the file
// meanwhile was overwritten — and `merge -X ours` in the push loop then made the
// loss silent. It was safe only because the data-write lock guaranteed there was
// no other writer, which is exactly the guarantee we want to stop needing.
// So the PlayHQ-answered fields are recorded here per game, and the flush replays
// them onto the file as it is ON DISK at that moment. seasonId -> Map(gameId -> fresh).
const _pendingFixtures = new Map();
function notePending(seasonId, gameId, fresh) {
  let m = _pendingFixtures.get(seasonId);
  if (!m) { m = new Map(); _pendingFixtures.set(seasonId, m); }
  // A game is returned by BOTH its teams, so this is written twice per run with
  // the same values. Last write wins, and they are the same write.
  m.set(gameId, fresh);
}

function loadGameFile(seasonId) {
  if (_gameFileCache[seasonId]) return _gameFileCache[seasonId];
  if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });
  const f = path.join(GAMES_DIR, `${seasonId}.json`);
  if (!fs.existsSync(f)) { _gameFileCache[seasonId] = { games: {} }; return _gameFileCache[seasonId]; }
  // An EXISTING file that fails to parse THROWS (matches nightly-crawl's guard). The old
  // {games:{}} fallback meant one corrupt file would be silently rewritten as fixture-only
  // data — losing p[]/spc/hidden games. 2026-08-02 sizing measured 0 parse failures live.
  try { _gameFileCache[seasonId] = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { throw new Error(`loadGameFile: ${seasonId}.json exists but failed to parse (${e.message}) — refusing the empty fallback`); }
  return _gameFileCache[seasonId];
}

// RE-READ, MERGE, WRITE — never write back the cache. See the note at
// _pendingFixtures. Three refusals, because a flush that quietly does the wrong
// thing is worse than one that stops:
//   · a file that exists and will not parse            -> THROW, do not overwrite
//   · a file with no games object                      -> THROW, do not overwrite
//   · a merge that would leave fewer games than it found -> THROW. This script only
//     ever adds and updates; it has no deletion path, so a shrink means the merge
//     is wrong, not that the data is.
// A game that became PLAYED on disk since this run read it is left alone — the same
// rule applyGame applies, applied again at the only moment that can see the race.
function flushGameFiles() {
  // While emitting, the pending map IS the product: keep accumulating it.
  if (EMIT_PATH) return 0;
  if (DRY_RUN) { _pendingFixtures.clear(); _dirtySeasons.clear(); return 0; }
  let count = 0;
  for (const seasonId of _dirtySeasons) {
    const pending = _pendingFixtures.get(seasonId);
    if (!pending || pending.size === 0) continue;
    const f = path.join(GAMES_DIR, `${seasonId}.json`);
    let disk;
    if (!fs.existsSync(f)) disk = { games: {} };
    else {
      try { disk = JSON.parse(fs.readFileSync(f, 'utf8')); }
      catch (e) { throw new Error(`flushGameFiles: ${seasonId}.json exists but failed to parse (${e.message}) — refusing to overwrite it`); }
    }
    if (!disk || typeof disk !== 'object' || !disk.games || typeof disk.games !== 'object') {
      throw new Error(`flushGameFiles: ${seasonId}.json holds no games object — refusing to overwrite it`);
    }
    const before = Object.keys(disk.games).length;
    let played = 0;
    for (const [gameId, fresh] of pending) {
      const ex = disk.games[gameId];
      if (ex && (ex.hs !== undefined || ex.as !== undefined
                 || ex.st === 'FINAL' || ex.forfeit === true)) { played++; continue; }
      disk.games[gameId] = mergeFixture(ex, fresh);
    }
    const after = Object.keys(disk.games).length;
    if (after < before) {
      throw new Error(`flushGameFiles: ${seasonId}.json would go from ${before} games to ${after} — this script only adds and updates. Refusing to write.`);
    }
    fs.writeFileSync(f, JSON.stringify(disk));
    // The cache must now agree with disk, or the next team in this season would
    // diff against a copy that no longer matches the file.
    _gameFileCache[seasonId] = disk;
    if (played) console.log(`    ↩ ${seasonId}: ${played} game(s) became played since they were read — left as history`);
    count++;
  }
  _pendingFixtures.clear();
  _dirtySeasons.clear();
  return count;
}

// Mode-keyed BY FILENAME: the hazard was not just cross-mode resume but cross-mode DELETION —
// a weekly run's clearProgress() would have destroyed a cancelled historical sweep's checkpoint.
const PROGRESS_FILE        = path.join(ROOT, `discover-fixtures-progress-${MODE}.json`);
const LEGACY_PROGRESS_FILE = path.join(ROOT, 'discover-fixtures-progress.json'); // pre-2026-08-03 unkeyed

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) return new Set(JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')).done || []);
  } catch (e) {}
  return new Set();
}

function saveProgress(done) {
  // Emitting: the done set travels in the changeset and is written by the apply
  // job, so the checkpoint lands with the commit it describes, as it always has.
  if (DRY_RUN || TARGET_SEASON || EMIT_PATH) return;   // single-season runs keep no checkpoint
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ mode: MODE, done: [...done], savedAt: new Date().toISOString() }));
}

function clearProgress() {
  if (DRY_RUN || TARGET_SEASON) return;
  try { fs.unlinkSync(PROGRESS_FILE); } catch (e) {}
  try { fs.unlinkSync(LEGACY_PROGRESS_FILE); } catch (e) {}   // one-time cleanup of the unkeyed file
}

// ─── Git ──────────────────────────────────────────────────────────────────────

// ── EVERY git CALL NEEDS A TIMEOUT AND A maxBuffer ───────────────────────────
// 2026-08-20 audit, after build-player-games hung with no output. execFileSync is
// SYNCHRONOUS: it blocks the whole Node process, event loop included, so nothing
// can time it out from outside. `git fetch` and `git push` talk to the network
// against a 6 GB repo; without a timeout a stalled connection hangs the job until
// the workflow ceiling kills it, with NO output and NO retry. A timeout makes the
// call THROW, which the push-retry loop below already handles.
//
// maxBuffer as well: the default is 1 MB, and git output across this repo can
// exceed it — the same class of silent failure, free to close while here.
// DF_GIT_TIMEOUT_MS exists so scripts/tests/test-git-stall-cap.js can exercise the
// REAL timeout branch in under two seconds instead of ten minutes. Nothing in the
// workflows sets it; absent, this is exactly the 10 minutes it has always been.
const GIT_TIMEOUT_MS = parseInt(process.env.DF_GIT_TIMEOUT_MS || String(10 * 60 * 1000), 10);
const GIT_MAXBUF     = 512 * 1024 * 1024;

// ⚠️ 2026-11-24 — A STALLED FETCH IS NOT CONTENTION AND MUST NOT BURN 60 ATTEMPTS.
// Measured on run 45326672826: `git fetch origin main` was killed at the 10-minute
// timeout six times in a row, each retry sleeping 1-91s, and the run held the
// data-write lock for 68 minutes having done 12 minutes of actual sweeping. Left
// alone it would have spent ~11 hours there; `timeout-minutes: 360` would have cut
// it at six. Every other workflow queues behind that, and the one in the pending
// slot is cancelled by the next arrival.
//
// Contention is still retried 60 times — that is what the loop is for, and a
// rejected push genuinely does clear. A STALL is different: it is the same call
// failing the same way with nothing to clear, and `e.killed` identifies it exactly,
// so it needs no transient/fatal classifier and no PlayHQ stub to test.
// The counter is CONSECUTIVE: any fetch that answers resets it, so a slow repo that
// recovers is unaffected and only an unbroken run of stalls gives up.
// Giving up THROWS, which fails the run red and releases the lock. Work already
// pushed stays pushed; seasons swept since the last successful push are redone next
// run, because the progress file travels with the commit that did not happen.
// --max-fetch-stalls=0 restores the pre-2026-11-24 behaviour exactly.
const MAX_FETCH_STALLS = parseInt(ARGS['max-fetch-stalls'] === undefined ? '3' : ARGS['max-fetch-stalls'], 10);

function gitCommitPush(message) {
  if (EMIT_PATH) { console.log(`  [emit] not committing here — the apply job does it: ${message}`); return; }
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }

  // ── Per-path add (directive 9) ────────────────────────────────────────────
  // `git add` is ATOMIC across pathspecs. The previous form passed all five in
  // ONE call wrapped in an empty catch, so a single non-matching pathspec exited
  // 128, staged NOTHING, and the catch swallowed it — every commit then printed
  // "(no changes to commit)" while a full run's work sat unstaged. That is the
  // 2026-07-19 failure exactly: 30,426 games fetched across 25,448 teams in 28
  // minutes, ZERO committed, job green.
  //
  // REPO_MANIFEST §2.2 and §6.8 record this as fixed on 2026-07-21. It was not
  // fixed in the deployed file — verified 2026-07-31 by reading it and by
  // reproducing the failure with this exact pathspec list.
  //
  // `team-lookup/` is retained in the list because team-lookup-utils still
  // writes it, but it is precisely the pathspec that made this dangerous:
  // README L186 recommends DELETING that directory, and under the old combined
  // add that deletion would have silently broken every commit this script makes.
  // Per-path, its absence now skips only itself.
  const PATHS = [
    'games/',
    'venue-lookup/',
    'team-lookup/',
    path.basename(PROGRESS_FILE),          // mode-keyed checkpoint
    'discover-fixtures-progress.json',     // legacy unkeyed name — stages its one-time deletion
    'zero-team-seasons.json',
    'data/stale-grade-seasons.json',       // consumed by discover-seasons.js grade-refresh
  ];
  // A pathspec that matches nothing is BENIGN here (team-lookup/ is gone; the progress and
  // zero-team files only exist sometimes) — git says "did not match any files" and that must
  // not count toward the silent-loss guard below, or a clean no-op with optional paths absent
  // would throw. Anything else from `git add` is a real staging failure and does count.
  let addFailures = 0;
  for (const p of PATHS) {
    try { execFileSync('git', ['add', '--', p], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF }); }
    catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      if (/did not match any file/i.test(detail)) continue;   // benign-absent, not a failure
      addFailures++;
      console.error(`  ⚠ git add FAILED "${p}": ${detail}`);
    }
  }

  let staged = '';
  try { staged = execFileSync('git', ['diff', '--staged', '--shortstat'], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF }).toString().trim(); }
  catch (e) {}

  if (!staged) {
    // Nothing staged AFTER a staging failure is the silent-loss signature, not a
    // clean no-op — refuse to report it as success. All adds clean and nothing
    // staged is genuinely nothing to do.
    if (addFailures) {
      throw new Error(`gitCommitPush: nothing staged and ${addFailures} path(s) failed to stage — refusing to report a clean no-op ("${message}")`);
    }
    console.log('  (no changes to commit)');
    return;
  }
  console.log(`  staging: ${staged}`);   // directive 9: prove what was staged

  // Identity inline on commit AND merge: a missing committer identity otherwise
  // surfaces only as a merge failure and burns the whole retry budget on a
  // config problem retrying cannot fix.
  const IDENT = ['-c', 'user.name=github-actions[bot]',
                 '-c', 'user.email=github-actions[bot]@users.noreply.github.com'];

  // execFileSync with an argument array — the message is no longer interpolated
  // into a shell string, so the `"` -> `'` escaping hack is gone with it.
  try { execFileSync('git', [...IDENT, 'commit', '-q', '-m', message], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF }); }
  catch (e) {
    const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
    throw new Error(`gitCommitPush: commit failed for "${message}" — ${detail}`);
  }

  // ── Push with retry (house pattern) ───────────────────────────────────────
  // 60 attempts, pure random 1-91s jitter, `merge --abort` before each attempt,
  // THROW on total failure. The previous loop ended in `console.warn` + `return`,
  // so a run could push NOTHING and still exit 0 — the same swallow closed on
  // build-team-stats.js (2026-07-29) and on nightly-crawl.js (2026-07-31).
  // Only genuine contention is retried; anything else (auth, branch protection,
  // hook rejection) fails fast with git's real error instead of being buried
  // under 60 identical lines.
  const MAX_ATTEMPTS = 60;
  let consecutiveStalls = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try { execFileSync('git', ['merge', '--abort'], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF }); } catch (_) { /* none in progress */ }

    try {
      execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF });
      consecutiveStalls = 0;          // a fetch that ANSWERS ends the stall run, however it answered
    } catch (e) {
      // ⚠ 2026-11-24 — THIS BRANCH PRINTED NOTHING BUT "fetch failed". The push branch
      // below prints git's real error and fails fast on anything that is not contention;
      // this one retried BLIND, so a fetch failing for an unchanging reason (auth, a bad
      // remote, a full disk, or the 10-minute timeout) burned up to 60 attempts and ~46
      // minutes of sleep WHILE HOLDING THE data-write LOCK, with no line anywhere saying
      // why. Observed 2026-11-24 on a weekly sweep: five identical lines, no reason, and
      // every other workflow queued behind it.
      // The reason is now printed, and a timeout is named as a STALL rather than being
      // indistinguishable from a refusal (T104's wording).
      // ⚠ The control flow is DELIBERATELY unchanged. Failing fast here needs a
      // transient/fatal classifier, and that cannot be exercised without stubbing
      // PlayHQ — an untested change to the lock-holding push path is a worse trade than
      // a loop that now says what is wrong.
      const detail  = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n').slice(0, 2).join(' / ');
      const stalled = e.killed === true || e.signal === 'SIGTERM' || /ETIMEDOUT/i.test(String(e.code || ''));
      // Only an unbroken RUN of stalls gives up. A plain failure neither counts
      // toward the cap nor clears it: it is not the thing being bounded, and
      // treating it as a reset would let stall/fail/stall/fail run for ever.
      if (stalled) consecutiveStalls++;
      if (stalled && MAX_FETCH_STALLS > 0 && consecutiveStalls >= MAX_FETCH_STALLS) {
        throw new Error(`gitCommitPush: git fetch STALLED past ${GIT_TIMEOUT_MS / 60000} min on `
          + `${consecutiveStalls} consecutive attempts with no fetch answering in between — `
          + `refusing to hold the data-write lock for a further ${MAX_ATTEMPTS - attempt} attempt(s) `
          + `("${message}"). Last git output: ${detail || '(no output)'}`);
      }
      if (attempt === MAX_ATTEMPTS) throw e;
      const waitSec = 1 + Math.floor(Math.random() * 91);
      console.log(`  fetch ${stalled ? `STALLED past ${GIT_TIMEOUT_MS / 60000} min and was killed (stall ${consecutiveStalls}/${MAX_FETCH_STALLS || '∞'})` : 'failed'} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${waitSec}s — git said: ${detail || '(no output)'}`);
      try { execFileSync('sleep', [String(waitSec)], { stdio: 'pipe', timeout: (waitSec + 30) * 1000 }); } catch (_) {}
      continue;
    }

    // A merge failure is a config or content problem, not a race — fatal.
    execFileSync('git', [...IDENT, 'merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat'], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF });

    try {
      execFileSync('git', ['push', 'origin', 'HEAD:main'], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF });
      console.log(`  ✓ Committed and pushed (attempt ${attempt})`);
      return;
    } catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
      const contention = /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(detail);
      if (!contention) {
        console.error(`  push failed — NOT contention, failing fast. git said:\n${detail}`);
        throw e;
      }
      if (attempt === MAX_ATTEMPTS) {
        console.error(`  push still rejected after ${MAX_ATTEMPTS} attempts. git said:\n${detail}`);
        throw e;
      }
      const waitSec = 1 + Math.floor(Math.random() * 91);
      console.log(`  push attempt ${attempt}/${MAX_ATTEMPTS} rejected (remote advanced), re-syncing in ${waitSec}s`);
      try { execFileSync('sleep', [String(waitSec)], { stdio: 'pipe', timeout: (waitSec + 30) * 1000 }); } catch (_) {}
    }
  }
  throw new Error(`gitCommitPush: exhausted ${MAX_ATTEMPTS} push attempts for "${message}"`);
}

// ─── Change detection ─────────────────────────────────────────────────────────
// Fields this script owns on a game object. A game is only rewritten (and only
// counted/logged as "updated") when one of these actually changes — everything
// else on the object (nightly-crawl's player roster `p`, the `spc` flag, etc.) is
// preserved by merging rather than replacing.
// ⚠️ 2026-10-12 — `gid`/`gn` ADDED. They were missing from BOTH the entry and
// this list, and the second omission is the one that matters: diffEntry only
// compares the keys named here, so a fixture already on disk would never gain a
// grade no matter how many times the sweep re-ran. With them listed, one ordinary
// Discover Fixtures run backfills every unplayed game.
const TRACKED = ['d', 'rn', 'gid', 'gn', 'h', 'hn', 'a', 'an', 'hs', 'as', 'vid', 'vn', 'ct', 't', 'st'];

function diffEntry(existing, entry) {
  const changes = [];
  for (const k of TRACKED) {
    const o = existing[k], n = entry[k];
    if (o !== n) changes.push([k, o, n]);
  }
  return changes;
}

// ─── The two halves of what used to be one `entry` literal ───────────────────
// fixtureFields returns ONLY what PlayHQ answered: a field it did not answer is
// `undefined` and is NOT filled in here from whichever copy of the row we happen
// to be holding. mergeFixture does the filling, against whatever row it is given —
// the cached one while the season is being swept, and the one read fresh from disk
// at flush time. That separation is the whole point: the old literal baked the
// fallbacks in at fetch time, so replaying it hours later would have written
// six-hour-old values over fresher ones.
//
// Every one of the fifteen existing-wins rules the literal spelled out individually
// is now the single rule in mergeFixture, and they are the same rule.
function fixtureFields(game, round, roundGradeName) {
  const court = game.allocation?.court;
  const venue = court?.venue;
  const dt    = game.allocation?.dateTimeList?.[0];
  const hs    = parseScore(game.result?.home?.statistics);
  const as    = parseScore(game.result?.away?.statistics);
  return {
    d:   dt?.date || game.dates?.[0] || undefined,
    // BARE round name — matches nightly-crawl (line 570) and isFinal(rn) detection;
    // a "Finals — " prefix here diverged from stored data and churned every finals game.
    rn:  round?.name || undefined,
    // ⚠️ 2026-10-12 — THE GRADE WAS FETCHED AND THROWN AWAY. `round.grade` carries
    // id and name on every round of the TeamFixture response, and the only code that
    // touched them was the dead storeLookupEntry block, which requires a
    // `team-lookup-utils` module that is not in scripts/. nightly-crawl.js L798-799
    // writes gid/gn on everything it stores, so a PLAYED game had a grade and an
    // unplayed FIXTURE did not — which is why the club view could group results by
    // age and not future games.
    gid: round?.grade?.id || undefined,
    gn:  roundGradeName || undefined,
    h:   game.home?.id   || undefined,
    hn:  game.home?.name || undefined,
    a:   game.away?.id   || undefined,
    an:  game.away?.name || undefined,
    hs:  hs !== null ? hs : undefined,
    as:  as !== null ? as : undefined,
    vid: venue?.id   || undefined,
    vn:  venue?.name || undefined,
    ct:  court?.name || undefined,
    t:   dt?.time ? dt.time.slice(0, 5) : undefined,
    st:  game.status?.value || undefined,
    // url omitted — PlayHQ game URL not used in StatTrack
  };
}

// MERGE, never replace: nightly-crawl's player roster (`p`), the `spc` flag, `sup`
// and anything else on the row survive, because only the fields this script owns
// are overlaid and only where PlayHQ actually answered.
// These six were written unconditionally by the old entry literal, null where
// PlayHQ said nothing. A NEW row still gets them, so its shape — and, built in
// TRACKED order, its key order — is byte-for-byte what the literal produced.
const NEW_ROW_KEYS = new Set(['d', 'rn', 'h', 'hn', 'a', 'an']);

function mergeFixture(existing, fresh) {
  if (!existing) {
    const row = {};
    for (const k of TRACKED) {
      if (fresh[k] !== undefined) row[k] = fresh[k];
      else if (NEW_ROW_KEYS.has(k)) row[k] = null;
    }
    return row;
  }
  // On an EXISTING row a missing key STAYS missing. The old literal wrote
  // `h: game.home?.id || existing?.h || null` unconditionally, so a stored row with
  // no `h` gained `h: null` and diffEntry read undefined !== null as a change —
  // rewriting and re-counting that game as "updated" on every run, for ever, with
  // nothing having changed. That is the one deliberate behaviour change here.
  const out = { ...existing };
  for (const k of TRACKED) if (fresh[k] !== undefined) out[k] = fresh[k];
  return out;
}

// ─── Apply one PlayHQ game to the in-memory season file ──────────────────────
// Lifted out of processTeam 2026-11-24 so the apply rules — the played-game guard,
// the merge, the change test, and the pending record the flush replays — are a
// function that can be called without a PlayHQ stub. T103: the thing under test has
// to be the shipped code, not a copy of it living in a fixture.
// Returns { added, updated, changes }.
function applyGame(sg, seasonId, game, round, roundGradeName) {
  const existing = sg.games[game.id];
  // A game with a recorded score (or FINAL/forfeit) is history: nightly-crawl
  // captured its as-played teams/venue/time alongside the score, so a later PlayHQ
  // edit must NOT rewrite it. Only unplayed fixtures and games not yet on file are
  // managed here. This is also what keeps team-id swaps and archival
  // "ZZ - … - W" renames off completed games.
  if (existing && (existing.hs !== undefined || existing.as !== undefined
                   || existing.st === 'FINAL' || existing.forfeit === true)) {
    return { added: 0, updated: 0, changes: [] };
  }

  const court = game.allocation?.court;
  const venue = court?.venue;
  if (venue) storeVenue(venue, court);

  const fresh  = fixtureFields(game, round, roundGradeName);
  const merged = mergeFixture(existing, fresh);

  if (!existing) {
    sg.games[game.id] = merged;
    _dirtySeasons.add(seasonId);
    notePending(seasonId, game.id, fresh);
    return { added: 1, updated: 0, changes: [] };
  }

  const changes = diffEntry(existing, merged);
  if (!changes.length) return { added: 0, updated: 0, changes: [] };
  sg.games[game.id] = merged;
  _dirtySeasons.add(seasonId);
  notePending(seasonId, game.id, fresh);
  return { added: 0, updated: 1, changes };
}

function fmtVal(v) {
  if (v === undefined || v === null) return '∅';
  const s = String(v);
  return s.length > 24 ? s.slice(0, 24) + '…' : s;
}

// ─── Process a single team's fixtures ────────────────────────────────────────

// WARN: `data === null` means the CALL FAILED — refused, timed out, or out of
// retries. `data` present with no discoverTeamFixture means the team genuinely
// has no fixture. Until 2026-10-13 both returned {added:0,updated:0} and the
// run reported a refused team as a clean zero, so a sweep that was blocked for
// half its length still printed "0 new, 0 updated" and exited 0.
async function processTeam(teamId, seasonId) {
  const data = await gql('TeamFixture', Q_TEAM_FIXTURE, { teamID: teamId });
  if (!data) return { added: 0, updated: 0, updates: [], refused: true };
  if (!data.discoverTeamFixture) return { added: 0, updated: 0, updates: [] };

  const team     = data.discoverTeam;
  const rounds   = data.discoverTeamFixture;
  const orgName  = team?.season?.competition?.organisation?.name || '';
  const compName = team?.season?.competition?.name || '';
  const sName    = team?.season?.name || '';
  const gradeName = team?.grade?.name || '';

  // Use grade's season ID if available (more accurate than passed-in seasonId)
  const effectiveSeasonId = rounds[0]?.grade?.season?.id || seasonId;

  // Store team in team-lookup if utils available
  try {
    const { storeLookupEntry, flushLookupShards } = require('./team-lookup-utils');
    if (team?.id) {
      storeLookupEntry({
        id: team.id, name: team.grade?.name ? `${team.id}` : team.id,
        logo: null, organisation: team.organisation,
        grade: team.grade,
        season: team.season,
      });
    }
  } catch (e) {}

  const sg = loadGameFile(effectiveSeasonId);
  let added = 0, updated = 0; const updates = [];

  for (const round of rounds) {
    const roundName    = round.name;
    const roundOrgName  = round.grade?.season?.competition?.organisation?.name || orgName;
    const roundCompName = round.grade?.season?.competition?.name || compName;
    const roundSeasonName = round.grade?.season?.name || sName;
    const roundGradeName  = round.grade?.name || gradeName;

    for (const game of (round.fixture?.games || [])) {
      if (!game?.id) continue;

      const r = applyGame(sg, effectiveSeasonId, game, round, roundGradeName);
      if (r.added)   added++;
      if (r.updated) { updated++; updates.push({ gid: game.id, changes: r.changes }); }
      const status = game.status?.value || null;

      // Also store team logo in team-lookup
      try {
        const { storeLookupEntry } = require('./team-lookup-utils');
        const teamSeason = { id: effectiveSeasonId, name: roundSeasonName, status: { value: status },
          competition: { id: null, name: roundCompName, organisation: { id: null, name: roundOrgName } } };
        const teamGrade  = { id: round.grade?.id || null, name: roundGradeName };
        if (game.home?.id) storeLookupEntry({ ...game.home, logo: { sizes: game.home.logo?.sizes }, season: teamSeason, grade: teamGrade });
        if (game.away?.id) storeLookupEntry({ ...game.away, logo: { sizes: game.away.logo?.sizes }, season: teamSeason, grade: teamGrade });
      } catch (e) {}
    }
  }

  return { added, updated, updates };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function scopeLabel() {
  return TARGET_SEASON ? `single season ${TARGET_SEASON}`
       : LOCKED_RESWEEP ? 'locked re-sweep'
       : ALL_SEASONS ? 'all seasons'
       : CURRENT_ONLY ? 'active, current only'
       : 'active only';
}

// ⚠️ MERGE, NEVER REPLACE — 2026-10-12, after a --season=5e26f10f run overwrote this
// file with its own one-season view: `count 12, seasonsScanned 188` became `count 0,
// seasonsScanned 1`, and discover-seasons.js would next have read "nothing is stale"
// for a repository it had scanned 1/188th of. A PARTIAL RUN MUST NOT CLEAR A
// REPOSITORY-WIDE WORKLIST — the same rule build-club-index.js applies to
// clubs/{clubId}.json, for the same reason.
//
// The merge is by season id: an entry for a season this run SCANNED is replaced by
// this run's finding (and disappears when the season is no longer stale, which is how
// entries retire); an entry for a season this run did not reach is carried through
// untouched. An entry with no id cannot be matched either way, so it is KEPT —
// dropping it would be a silent loss on a guess.
//
// Lifted out of main() 2026-11-24 so the apply job merges against the file in ITS
// checkout using this code, not a second copy of it.
function writeStaleGrades(staleGradeSeasons, scannedSeasonIds, seasonsProcessed) {
  const STALE_FILE = path.join(ROOT, 'data', 'stale-grade-seasons.json');
  let carried = [];
  try {
    const prev = JSON.parse(fs.readFileSync(STALE_FILE, 'utf8'));
    if (prev && Array.isArray(prev.seasons)) {
      carried = prev.seasons.filter(x => !(x && x.id && scannedSeasonIds.has(x.id)));
    }
  } catch (e) {
    // No previous file, or an unreadable one. Starting fresh is correct for the first
    // case and the only option in the second, but it must be VISIBLE rather than
    // looking like a clean sweep that found nothing.
    if (fs.existsSync(STALE_FILE)) {
      console.log(`  ⚠ stale-grade-seasons.json could not be parsed (${e.message}) — writing this run's findings only; entries for seasons this run did not scan are LOST.`);
    }
  }
  const mergedStale = carried.concat(staleGradeSeasons);
  if (!fs.existsSync(path.dirname(STALE_FILE))) fs.mkdirSync(path.dirname(STALE_FILE), { recursive: true });
  fs.writeFileSync(STALE_FILE, JSON.stringify({
    generatedAt:    new Date().toISOString(),
    // What this run covered, so a reader can tell a full sweep's verdict from a
    // single season's. `seasonsScanned` alone said 1 and looked authoritative.
    scope:          scopeLabel(),
    seasonsScanned: seasonsProcessed,
    carriedForward: carried.length,
    count:          mergedStale.length,
    seasons:        mergedStale,
  }, null, 2));
  console.log(`  stale-grade worklist: ${staleGradeSeasons.length} from this run + ${carried.length} carried forward = ${mergedStale.length}`);
}

// ─── --emit / --apply ────────────────────────────────────────────────────────

function writeChangeset(file, cs) {
  const dir = path.dirname(file);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cs));
  const bytes = fs.statSync(file).size;
  console.log(`\n  📦 changeset written: ${file}`);
  console.log(`     ${Object.keys(cs.seasons).length} season file(s), ${cs.gameCount} game entr(ies), ${cs.venues.length} venue/court pair(s), ${bytes.toLocaleString()} bytes`);
  console.log(`     progress: ${cs.completed ? 'run COMPLETED — the apply job clears the checkpoint' : `${cs.progressDone.length} season(s) done — the apply job saves the checkpoint`}`);
  console.log(`     NOTHING was written to the tree and nothing was committed. The apply job does both.`);
}

// Replay a changeset onto the checkout this job has, and commit once.
// Every refusal is loud: a changeset that is missing, will not parse, was written by
// a different version, for a different tenant, or under a different progress key is a
// changeset that would write the wrong thing, and writing the wrong thing quietly is
// the failure this whole split exists to avoid.
function applyChangeset(file) {
  console.log('=== discover-fixtures.js --apply ===');
  console.log(`Changeset:   ${file}`);
  if (!fs.existsSync(file)) throw new Error(`--apply: no changeset at ${file}`);
  let cs;
  try { cs = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`--apply: the changeset at ${file} will not parse (${e.message})`); }
  if (cs.v !== CHANGESET_V) throw new Error(`--apply: changeset version ${cs.v} — this script writes and reads ${CHANGESET_V}`);
  if (cs.tenant !== TENANT) throw new Error(`--apply: changeset tenant "${cs.tenant}" is not this run's "${TENANT}"`);
  // The progress key decides WHICH checkpoint file is written. A changeset emitted by
  // a --current-only sweep applied by a run without that flag would save the active
  // sweep's done-set over the current-only one, and the next weekly run would skip
  // seasons it never swept.
  if (cs.mode !== MODE) {
    throw new Error(`--apply: changeset progress-key "${cs.mode}" but this run's is "${MODE}" — the apply step must carry the same mode flags as the sweep`);
  }
  console.log(`Emitted:     ${cs.startedAt} → ${cs.finishedAt}  (progress-key ${cs.mode})`);
  const t = cs.totals || {};
  console.log(`Sweep found: ${t.seasons} season(s), ${(t.teams || 0).toLocaleString()} team call(s), ${(t.added || 0).toLocaleString()} new, ${(t.updated || 0).toLocaleString()} updated`);
  if (t.refusedTeams) console.log(`::warning::${t.refusedTeams} team(s) were never read in the sweep — the totals are a lower bound`);

  for (const [sid, games] of Object.entries(cs.seasons || {})) {
    for (const [gameId, fresh] of Object.entries(games)) notePending(sid, gameId, fresh);
    _dirtySeasons.add(sid);
  }
  const gf = flushGameFiles();
  for (const v of (cs.venues || [])) storeVenue(v.venue, v.court);
  const vf = flushVenueShards();
  console.log(`\n  💾 ${gf} game file(s), ${vf} venue shard(s)`);

  if (!DRY_RUN) {
    if (cs.completed) clearProgress(); else saveProgress(new Set(cs.progressDone || []));
    if ((cs.zeroTeam || []).length) {
      fs.writeFileSync(path.join(ROOT, 'zero-team-seasons.json'), JSON.stringify(cs.zeroTeam, null, 2));
    }
    writeStaleGrades(cs.staleGrades || [], new Set(cs.scanned || []), t.seasons || 0);
  }

  gitCommitPush(cs.message || 'Fixture discovery (applied changeset)');

  if ((cs.transient || []).length) {
    console.error(`\n✗ the sweep left ${cs.transient.length} season(s) unreachable on every attempt — failing this job (the work above is committed).`);
    process.exit(1);
  }
}

async function main() {
  if (APPLY_PATH) { applyChangeset(APPLY_PATH); return; }
  console.log('=== discover-fixtures.js ===');
  console.log(`Tenant:      ${TENANT}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Rate limit:  ${RATE_PER_MIN > 0
    ? RATE_PER_MIN + ' req/min, rolling-window counter' + (PACE ? `, PACED 1 every ${_minGapMs}ms — MEASURED WORSE, see the note at RATE_PER_MIN` : '')
    : 'DISABLED (--rate=0) — measured worse than 600, see the note at RATE_PER_MIN'}`);
  console.log(`Rotate at:   ${Math.round(ROTATE_AGE_MS/60000)} min of cookie age`);
  console.log(`Mode:        ${TARGET_SEASON ? `single season ${TARGET_SEASON}` : LOCKED_RESWEEP ? 'locked re-sweep (locked && !removed)' : ALL_SEASONS ? 'all seasons' : 'active only (locked: false)'}${CURRENT_ONLY ? ' [current-only]' : ''}${DRY_RUN ? '   [DRY RUN — no writes/commits]' : ''}  progress-key: ${MODE}\n`);

  if (!fs.existsSync(INDEX_FILE)) { console.error('sports-index.json not found'); process.exit(1); }

  const index   = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const seasons = Object.values(index.seasons || {});

  let targets = seasons;
  if (TARGET_SEASON) {
    targets = seasons.filter(s => s.id === TARGET_SEASON);
    if (targets.length === 0) targets = [{ id: TARGET_SEASON, grades: [] }];
  } else if (LOCKED_RESWEEP) {
    // §2.2: every locked, non-removed season. removed:true stubs are unfetchable by design
    // (bare --all-seasons would waste probes on all 274 of them and pollute zero-team).
    targets = seasons.filter(s => s.locked === true && s.removed !== true);
  } else if (!ALL_SEASONS) {
    targets = seasons.filter(s => s.locked === false);
  }

  if (CURRENT_ONLY && !TARGET_SEASON) {
    // Weekly mode: skip seasons that are clearly finished — no local game dated
    // within the last GRACE_DAYS and none in the future. New/empty seasons (no
    // local games yet) are kept so their fixtures still get discovered. Makes the
    // weekly run scale with current activity instead of all history — no fetch for
    // the seasons it skips.
    const GRACE_DAYS = 21;
    const cutoff = new Date(Date.now() - GRACE_DAYS * 86400000).toISOString().slice(0, 10);
    const before = targets.length;
    targets = targets.filter(s => {
      const sg = loadGameFile(s.id);
      const dates = Object.values(sg.games || {}).map(g => g && g.d).filter(Boolean);
      if (dates.length === 0) return true;                        // never fetched -> keep
      return dates.reduce((a, b) => (a > b ? a : b)) >= cutoff;   // has recent/future game
    });
    console.log(`--current-only: ${targets.length} active of ${before} seasons (skipped ${before - targets.length} finished)`);
  }

  console.log(`Seasons to process: ${targets.length}`);

  await getSession();

  const doneSeasonsSet = TARGET_SEASON ? new Set() : loadProgress();
  const remaining = targets.filter(s => !doneSeasonsSet.has(s.id));
  if (doneSeasonsSet.size > 0) console.log(`  ↻ Resuming — ${doneSeasonsSet.size} already done, ${remaining.length} remaining`);

  let totalAdded = 0, totalUpdated = 0, totalTeams = 0, seasonsProcessed = 0, totalRefusedTeams = 0;
  let sinceLastCommit = 0;
  const zeroTeamSeasons = [];
  const staleGradeSeasons = [];
  // Which seasons THIS run actually scanned. The stale-grade worklist is
  // repository-wide and merges against it: a season this run did not look at
  // keeps whatever a previous run recorded. See the write block at the bottom.
  const scannedSeasonIds = new Set();

  // Sweep one season. Returns 'ok' | 'zero-team' | 'transient'.
  // TRANSIENT means every enumeration call for the season returned null — that is an API
  // failure (WAF block, network), NOT a season with no ladder, and it must never be marked
  // done: the old behaviour recorded such seasons as done-zero-team, permanently for the run.
  async function sweepSeason(season, tag) {
    const seasonId = season.id;
    const grades   = (season.grades || []).slice();   // never mutate the index object
    let probeCalls = 0, probeNulls = 0;

    if (grades.length === 0) {
      probeCalls++;
      const data = await gql('DiscoverSeason', `query DiscoverSeason($id: String!) { discoverSeason(seasonID: $id) { id name grades { id name } } }`, { id: seasonId });
      if (!data) probeNulls++;
      if (data?.discoverSeason?.grades) grades.push(...data.discoverSeason.grades);
    }

    console.log(`\n📅 ${tag} ${season.fullName || season.name || seasonId} — ${seasonId} (${grades.length} grades)`);

    // Collect all unique team IDs across all grades in this season — parallelised
    const teamIds = new Set();

    // ROUTE A — one call, no ladder. Runs FIRST because it is one request against
    // dozens, and because it is the only route that works for an all-grading
    // season. Its result is unioned with the ladder sweep below, never substituted
    // for it: Camberwell returned 13 of the 16 grades our games actually use.
    let viaSeason = 0;
    const gradesFromTeams = new Map();
    if (USE_SEASON_TEAMS) {
      probeCalls++;
      const dt = await gql('discoverTeamsBySeason', Q_SEASON_TEAMS, { seasonId: seasonId });
      if (!dt) probeNulls++;
      for (const t of (dt?.discoverTeams || [])) {
        if (t?.id) { teamIds.add(t.id); viaSeason++; }
        // grade is NULL for some teams — record only when present.
        if (t?.grade?.id) gradesFromTeams.set(t.grade.id, t.grade.name || '?');
      }
      if (viaSeason) console.log(`  discoverTeams: ${viaSeason} teams, ${gradesFromTeams.size} grades (no ladder needed)`);
    }

    for (let i = 0; i < grades.length; i += CONCURRENCY) {
      const batch = grades.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(g => gql('DiscoverGrade', Q_GRADE_TEAMS, { id: g.id })));
      for (const data of results) {
        probeCalls++;
        if (!data) { probeNulls++; continue; }
        for (const pool of (data?.discoverGrade?.ladder || [])) {
          for (const s of (pool.standings || [])) {
            if (s.team?.id) teamIds.add(s.team.id);
          }
        }
      }
    }

    // Grades this season really has, learned for free from the team list. The
    // index is written once at season creation (discover-seasons.js L526) and only
    // refreshed for seasons sitting at grades:[] (L542), so a season captured
    // mid-grading keeps grading grades forever. Reporting the difference here means
    // the staleness is visible in the run that is affected by it.
    if (gradesFromTeams.size) {
      const known = new Set(grades.map(g => String(g && g.id)));
      const unseen = [...gradesFromTeams.keys()].filter(g => !known.has(String(g)));
      if (unseen.length) {
        console.log(`  ⚠ sports-index holds ${grades.length} grades for this season; discoverTeams reports ${gradesFromTeams.size} (${unseen.length} the index lacks)`);
        // The IDS, not just the count. discover-seasons.js's grade-refresh needs to
        // know which seasons to re-resolve, and a bare number cannot tell it.
        staleGradeSeasons.push({ id: seasonId, name: season.fullName || season.name,
                                 indexGrades: grades.length, liveGrades: gradesFromTeams.size,
                                 missing: unseen.length, missingIds: unseen.slice(0, 50),
                                 seenAt: new Date().toISOString() });
      }
    }

    if (teamIds.size === 0) {
      if (probeCalls > 0 && probeNulls === probeCalls) {
        console.log(`  Teams: 0 ⚠ every enumeration call (${probeCalls}) returned null — TRANSIENT, not marking done`);
        return 'transient';
      }
      console.log(`  Teams: 0 ⚠ no teams from EITHER route (ladder + discoverTeams) — season ID: ${seasonId}`);
      zeroTeamSeasons.push({ id: seasonId, name: season.fullName || season.name, grades: grades.length });
      return 'zero-team';
    }
    console.log(`  Teams: ${teamIds.size}${viaSeason ? ` (${viaSeason} via discoverTeams, ${teamIds.size - viaSeason} more from ladders)` : ''}`);

    const teamArr = [...teamIds];
    let seasonAdded = 0, seasonUpdated = 0, seasonRefused = 0; const seasonUpdates = [];

    for (let i = 0; i < teamArr.length; i += CONCURRENCY) {
      const batch = teamArr.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(tid => processTeam(tid, seasonId)));
      for (const r of results) { seasonAdded += r.added; seasonUpdated += r.updated; if (r.refused) { seasonRefused++; totalRefusedTeams++; } if (r.updates.length) seasonUpdates.push(...r.updates); }
      totalTeams += batch.length;
      // Elapsed and achieved rate on every line — the 2026-10-13 cron log could not
      // be used to work out the request rate, because nothing in it carried a clock.
      process.stdout.write(`  ${Math.min(i + CONCURRENCY, teamArr.length)}/${teamArr.length} teams (${seasonAdded} new, ${seasonUpdated} updated${seasonRefused ? `, ${seasonRefused} REFUSED` : ''})  ${((Date.now()-RUN_T0)/1000).toFixed(0)}s  ${_rateWindow.length}/min\r`);
      if (i + CONCURRENCY < teamArr.length) await delay(100);
    }

    console.log(`  ✓ ${seasonAdded} new games, ${seasonUpdated} updated`);
    if (seasonRefused) {
      console.log(`  ⚠ ${seasonRefused} of ${teamArr.length} teams were NEVER READ — refused or timed out.`);
      console.log(`    Their contribution to the counts above is UNKNOWN, not zero. This season is INCOMPLETE.`);
      console.log(`::warning::${seasonId}: ${seasonRefused}/${teamArr.length} teams unread — season incomplete, re-run required`);
    }
    // Record exactly what changed (game id + field old→new) — an audit trail, not just a count.
    for (const u of seasonUpdates) {
      console.log(`    ↻ ${u.gid}  ${u.changes.map(([f, o, n]) => `${f} ${fmtVal(o)}→${fmtVal(n)}`).join(', ')}`);
    }
    totalAdded   += seasonAdded;
    totalUpdated += seasonUpdated;
    return 'ok';
  }

  // One pass over a season list; returns the transient leftovers.
  async function runPass(list, label) {
    const leftover = [];
    let n = 0;
    for (const season of list) {
      n++;
      const status = await sweepSeason(season, `[${label} ${n}/${list.length}]`);
      if (status === 'transient') { leftover.push(season); continue; }
      seasonsProcessed++;
      sinceLastCommit++;
      if (season.id) scannedSeasonIds.add(season.id);
      doneSeasonsSet.add(season.id);
      saveProgress(doneSeasonsSet);

      if (sinceLastCommit >= 10) {
        const gf = flushGameFiles();
        const vf = flushVenueShards();
        if (!DRY_RUN) { try { const { flushLookupShards } = require('./team-lookup-utils'); flushLookupShards(); } catch (e) {} }
        console.log(`\n  💾 Flushed ${gf} game files, ${vf} venue shards — committing...`);
        gitCommitPush(`Fixture discovery: ${seasonsProcessed} seasons, +${totalAdded} games`);
        sinceLastCommit = 0;
      }
    }
    return leftover;
  }

  let stillTransient = await runPass(remaining, 'main');
  if (stillTransient.length) {
    console.log(`\n↻ Retry pass — ${stillTransient.length} transient season(s)`);
    stillTransient = await runPass(stillTransient, 'retry');
  }
  if (stillTransient.length) {
    // Survived a full retry pass: mark done so the progress lifecycle stays intact (weekly
    // runs must still clear at end), but do NOT record as zero-team, and turn the run RED
    // after the final commit so it is investigated rather than trusted.
    console.log(`\n⚠ ${stillTransient.length} season(s) still returned null on every call after retry — marking done, NOT recording as zero-team:`);
    for (const s of stillTransient) {
      console.log(`    ${s.id}  ${s.fullName || s.name || ''}`);
      doneSeasonsSet.add(s.id);
    }
    saveProgress(doneSeasonsSet);
  }

  // Final flush
  const gf = flushGameFiles();
  const vf = flushVenueShards();
  if (!DRY_RUN) { try { const { flushLookupShards } = require('./team-lookup-utils'); flushLookupShards(); } catch (e) {} }

  console.log(`\n✅ Done`);
  console.log(`  Seasons:       ${seasonsProcessed}`);
  console.log(`  Teams:         ${totalTeams.toLocaleString()}`);
  console.log(`  Added:         ${totalAdded.toLocaleString()}`);
  console.log(`  Updated:       ${totalUpdated.toLocaleString()}`);
  console.log(`  Zero-team:     ${zeroTeamSeasons.length} (no teams from either route — saved to zero-team-seasons.json)`);
  console.log(`  WAF blocks:    ${_blockEvents}${_blockEvents ? `  (× ${Math.round(BLOCK_PAUSE_MS/1000)}s = ${Math.round(_blockEvents*BLOCK_PAUSE_MS/60000)} min paused)` : ''}`);
  console.log(`  Elapsed:       ${((Date.now()-RUN_T0)/60000).toFixed(1)} min — overall ${Math.round(totalTeams / Math.max((Date.now()-RUN_T0)/60000, 0.01))} team-calls/min`);
  console.log(`  403s seen:     ${_refused403}`);
  console.log(`  Calls dropped: ${_gaveUp}  (gave up after ${GQL_MAX_ATTEMPTS} attempts)`);
  if (totalRefusedTeams) {
    console.log('');
    console.log(`  ⚠⚠ ${totalRefusedTeams} TEAM(S) WERE NEVER READ. The "new/updated" totals above are a`);
    console.log(`     LOWER BOUND, not a result. Do not treat this run as a measurement of coverage`);
    console.log(`     or as evidence that a season holds no new games. Re-run before concluding.`);
    console.log(`::warning::${totalRefusedTeams} teams unread across the run — totals are a lower bound`);
  }
  // SETTLED §6.80: blocks are a known, bounded cost of this endpoint. Lowering the
  // rate was tried four times and never helped once. The hint that used to live
  // here told the next operator to do exactly that.
  // ⚠️ T81 AGAIN, in the hint written to warn about T81. This said "expect ~1 per
  // 349 teams", a figure measured on a ONE-season run. A 97-season sweep spends
  // extra requests per season (DiscoverSeason, discoverTeams, DiscoverGrade) that
  // no team is charged for, so its blocks-per-TEAM is necessarily worse: this run
  // did 38 / 8,181 = 1 per 215 and was perfectly healthy. Blocks track REQUESTS,
  // and the number of teams is not the number of requests. No figure is quoted.
  if (_blockEvents) console.log(`  → ${_blockEvents} blocks is EXPECTED at --rate=${RATE_PER_MIN}; the WAF allows a fixed budget of requests per 90s window. Do not lower the rate — see REPO_MANIFEST §6.80.`);
  if (staleGradeSeasons.length) {
    console.log(`  Stale grades:  ${staleGradeSeasons.length} season(s) where sports-index holds fewer grades than discoverTeams reports`);
    for (const s of staleGradeSeasons.slice(0, 15)) {
      // `missing` is a SET difference, not liveGrades - indexGrades: it counts live
      // grade IDs the index lacks. So "index 9 → live 9, 1 not in index" is a grade
      // that was REPLACED, and is correct however much it looks like a subtraction
      // error. Spelled out because it was read as one.
      console.log(`      ${s.id}  index ${s.indexGrades} → live ${s.liveGrades}, ${s.missing} live grade${s.missing === 1 ? '' : 's'} not in index  ${s.name}`);
    }
    console.log('      Harmless for THIS sweep — a team returns its whole fixture regardless of grade.');
    console.log(`      Written to data/stale-grade-seasons.json, which discover-seasons.js reads in its`);
    console.log('      grade-refresh and re-resolves. NOTE THE LAG: that sweep runs Sunday 20:00 UTC and');
    console.log('      this one Monday 20:00 UTC, so a season flagged here is corrected SIX DAYS later,');
    console.log('      on the following Sunday — not the next run.');
  }
  console.log(`  Transient:     ${stillTransient.length} (null on every call, survived retry — run goes RED)`);

  if (zeroTeamSeasons.length > 0 && !DRY_RUN && !EMIT_PATH) {
    fs.writeFileSync(path.join(ROOT, 'zero-team-seasons.json'), JSON.stringify(zeroTeamSeasons, null, 2));
  }

  // ── PERSIST THE STALE-GRADE LIST ──────────────────────────────────────────
  // Until 2026-09-08 this was printed and thrown away. The 29 seasons the
  // 2026-09-07 run found - EDJBA holding 55 grades against 263 live - vanished
  // with the run log, and nothing downstream could act on them. The comment at the
  // detection site USED TO SAY discover-seasons.js "will not correct the index by
  // itself (L542 only refreshes seasons at grades:[])". That was true until
  // 2026-09-08, when discover-seasons.js's grade-refresh was widened to read this
  // file; the sentence was left in place for three days after it stopped being
  // true, two lines above the line announcing the file this fixes it with.
  // Corrected 2026-09-11.
  //
  // FIRST OVERLAP. The writer shipped on Monday 2026-09-08, and this workflow's
  // cron is Monday 20:00 UTC — the 09-08 run started before the commit, so it
  // printed the detection without writing the file. The first run to write it is
  // 2026-09-15, and the first discover-seasons sweep to READ it is Sunday
  // 2026-09-20. Until then `stale-grade-seasons.json: not present` in that log is
  // expected and is not a fault.
  //
  // Written even when EMPTY, deliberately. An absent file is indistinguishable
  // from "this run found none", and the consumer must be able to tell the
  // difference between nothing stale and never checked.
  //
  // ⚠️ MERGE, NEVER REPLACE — added 2026-10-12 after a --season=5e26f10f run
  // overwrote this file with its own one-season view: `count 12, seasonsScanned
  // 188` became `count 0, seasonsScanned 1`, and discover-seasons.js would next
  // have read "nothing is stale" for a repository it had scanned 1/188th of.
  // A PARTIAL RUN MUST NOT CLEAR A REPOSITORY-WIDE WORKLIST. This is the same
  // rule build-club-index.js applies to clubs/{clubId}.json, for the same reason.
  //
  // The merge is by season id: an entry for a season this run SCANNED is replaced
  // by this run's finding (and disappears when the season is no longer stale,
  // which is how entries retire); an entry for a season this run did not reach is
  // carried through untouched. An entry with no id cannot be matched either way,
  // so it is KEPT — dropping it would be a silent loss on a guess.
  if (!DRY_RUN && !EMIT_PATH) writeStaleGrades(staleGradeSeasons, scannedSeasonIds, seasonsProcessed);

  const message = `Fixture discovery complete: ${seasonsProcessed} seasons, ${totalAdded.toLocaleString()} new games`;

  if (EMIT_PATH) {
    const seasonsOut = {}; let gameCount = 0;
    for (const [sid, m] of _pendingFixtures) {
      const o = {};
      // JSON.stringify drops undefined, which is exactly the contract: the changeset
      // carries the fields PlayHQ ANSWERED and no others.
      for (const [gameId, fresh] of m) { o[gameId] = fresh; gameCount++; }
      seasonsOut[sid] = o;
    }
    writeChangeset(EMIT_PATH, {
      v: CHANGESET_V, tenant: TENANT, mode: MODE, scope: scopeLabel(),
      startedAt: new Date(RUN_T0).toISOString(), finishedAt: new Date().toISOString(),
      message,
      seasons: seasonsOut, gameCount,
      venues: _pendingVenues,
      progressDone: [...doneSeasonsSet],
      completed: stillTransient.length === 0,
      zeroTeam: zeroTeamSeasons,
      staleGrades: staleGradeSeasons,
      scanned: [...scannedSeasonIds],
      transient: stillTransient.map(x => x.id),
      totals: { seasons: seasonsProcessed, teams: totalTeams, added: totalAdded,
                updated: totalUpdated, refusedTeams: totalRefusedTeams,
                blocks: _blockEvents, refused403: _refused403, gaveUp: _gaveUp },
    });
  } else {
    clearProgress();
    gitCommitPush(message);
  }

  if (stillTransient.length) {
    console.error(`\n✗ ${stillTransient.length} season(s) unreachable on every attempt — failing the run (work above is committed).`);
    process.exit(1);
  }
}

// Entry-point guard, 2026-11-24. `node scripts/discover-fixtures.js` is unchanged —
// require.main is this module and main() runs. A require() of this file (only
// scripts/tests/test-git-stall-cap.js does it) gets gitCommitPush WITHOUT starting a
// sweep, so the retry loop is tested as it actually ships rather than re-implemented
// in a fixture (T103).
if (require.main === module) {
  main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
}

module.exports = { gitCommitPush, loadGameFile, flushGameFiles, applyGame, fixtureFields, mergeFixture, applyChangeset, writeStaleGrades, notePending };
