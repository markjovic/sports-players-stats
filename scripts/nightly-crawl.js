// scripts/nightly-crawl.js
// Nightly active-season update:
//   Phase 1 — discoverGrade(gradeRounds) for all active grades → round IDs
//   Phase 1b — Detect grades that became hidden; reclassify their game entries
//   Phase 2 — discoverFixtureByRound for current + N previous rounds
//             Commits game files every COMMIT_EVERY seasons
//   Phase 3 — Spectator game(id) for FINAL games without spc flag
//             Commits player files every COMMIT_EVERY_PLAYERS
//   Phase 4 — Stub new players not yet in the index
//
// Usage:
//   node scripts/nightly-crawl.js                   # active seasons, 2 rounds back
//   node scripts/nightly-crawl.js --rounds-back=14  # backfill ~3 weeks
//   node scripts/nightly-crawl.js --season=<id>     # single season
//   node scripts/nightly-crawl.js --dry-run         # no writes or commits

'use strict';

function isFinal(rn) {
  if (!rn) return false;
  return rn.toLowerCase().includes('final');
}
function isGrandFinal(rn) {
  if (!rn) return false;
  const r = rn.toLowerCase();
  return r.includes('grand final') || r === 'gf';
}

const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execFileSync } = require('child_process');
const { truncateUuid, resolveToFullUuid, TRUNC_LEN } = require('./lib/uuid-prefix.cjs');
// The per-grade fixture refresh lives in its own module because it DELETES data
// and that logic has to be executable without a PlayHQ session. It is pure: no
// network, no writes, no git — it decides, this file applies. See the header of
// scripts/lib/round-refresh.cjs for the four deletion rules it enforces.
const RR = require('./lib/round-refresh.cjs');

// ─── Identity alias for brand-new players (api-canonical, 2026-07-16) ─────────
// Every player file key must have an alias entry (trunc13(key) -> key), or the
// index gap the 3b-2 repair closed re-opens with every stub. Written at stub
// time; the matrix's recovery later REPLACES it with a redirect if the player
// turns out diverged. Format matches build-alias-index.js: sorted, minified.
// Covered by gitCommit(['players/']) — players/aliases sits under players/.
function writeAliasIdentity(uuid) {
  const bucket = uuid.slice(0, 2).toLowerCase();
  const aliasPath = path.join(ROOT, 'players', 'aliases', `${bucket}.json`);
  let map = {};
  try { map = JSON.parse(fs.readFileSync(aliasPath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const key = uuid.slice(0, TRUNC_LEN);
  if (map[key] !== undefined) return; // never clobber an existing (possibly redirect) entry
  map[key] = uuid;
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
  fs.writeFileSync(aliasPath, JSON.stringify(sorted));
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const DRY_RUN       = !!ARGS['dry-run'];
const TARGET_SEASON = ARGS.season || null;
const ROUNDS_BACK   = Math.max(1, parseInt(ARGS['rounds-back'] || '2', 10));
const FORCE_RECHECK = !!ARGS['force-recheck'];       // ignore roundsComplete markers, re-fetch every round

// ── Per-grade fixture refresh (2026-11-22) ───────────────────────────────────
// Until now the nightly fetched the CURRENT round plus ROUNDS_BACK-1 previous
// rounds and NOTHING forward, and `applyRoundFixtures` has never removed a game
// PlayHQ stopped returning. So a future fixture was written once by the Monday
// discover-fixtures sweep and never looked at again until it became current:
// during grading its date, venue, opponent and grade went stale for up to a
// week, and a withdrawn game stayed on disk for ever. A team's old-grade games
// then outlived the regrade, and because build-team-stats takes meta.grade from
// the grade of the team's LATEST DATED GAME, the team showed the wrong grade.
//
// This closes both. Per ACTIVE grade, each night: compare the grade's round list
// against a stored fingerprint, re-fetch the next REFRESH_AHEAD unplayed rounds,
// overwrite changed fields, and DELETE stored UNPLAYED games that a SUCCESSFUL
// fetch did not return. First run for a grade is a baseline over every unplayed
// round, which is what cleans up what is already on disk.
//
// ⚠ Every default here fails toward doing LESS. --no-round-refresh turns the
// whole thing off and restores the previous behaviour exactly.
const NO_ROUND_REFRESH   = !!ARGS['no-round-refresh'];
const REFRESH_AHEAD      = Math.max(0, parseInt(ARGS['refresh-rounds-ahead'] || '2', 10));
const REFRESH_DRY_RUN    = !!ARGS['refresh-dry-run'];   // fetch and report, delete nothing
// Baselining every grade at once is ~5,000 grades x ~8 unplayed rounds of extra
// requests on the first night. The paced pool would survive it, but a cost that
// large belongs spread across nights rather than spent in one run that then has
// to be explained. Grades without a fingerprint are taken BASELINE_PER_RUN at a
// time and the remainder is printed, so the drain is visible rather than silent.
//
// 2000 IS MEASURED, NOT GUESSED. The first production dry run baselined 750
// grades and that cost 361 round fetches — 0.48 per grade, with blocked=0 across
// the entire run — because most grades have nothing ahead of their current round.
// At 750 the 7,819-grade backlog takes eleven nights; at 2000 it takes four, for
// roughly 960 fetches a night against the 11,326 Phase 2 already makes. Raise it
// further only against a measurement, not against this comment.
const BASELINE_PER_RUN   = Math.max(0, parseInt(ARGS['baseline-grades-per-run'] || '2000', 10));
// Caps ABORT the deletion pass; they never trim it. A trimmed deletion list is a
// half-applied change nobody reviewed. On abort nothing is deleted, no
// fingerprint is written, and the full would-have-deleted list is printed.
const MAX_DELETES_RUN    = Math.max(0, parseInt(ARGS['max-deletes'] || '500', 10));
const MAX_DELETES_SEASON = Math.max(0, parseInt(ARGS['max-deletes-per-season'] || '100', 10));
// A cap breach is a REFUSAL, not a crash, and by default it does not fail the
// run: the crawl itself succeeded, and failing it would skip team-stats,
// win-loss, team-index and the chain for the whole night over a refusal to
// delete. It is printed, it raises a ::warning::, and it lands in
// .nightly-status.json. --fail-on-delete-cap makes it red for anyone who would
// rather lose the night than miss it.
const FAIL_ON_DELETE_CAP = !!ARGS['fail-on-delete-cap'];
// The runaway stop. NOT a review gate — the caps above are advisory now, because
// a large regrade is a normal event and blocking on volume stopped the cleanup
// dead while catching nothing. This is the "the world has changed in a way
// nothing here anticipated" halt, set far above any plausible regrade.
const RUNAWAY_STOP = Math.max(1, parseInt(ARGS['runaway-stop'] || '20000', 10));
const COMPLETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;   // trust a round-complete marker only after 7 days (catch late score corrections first)

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const GAMES_DIR     = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR   = path.join(ROOT, 'players');
const INDEX_DIR     = path.join(ROOT, 'players', 'indexes');
const INDEX_FILE    = path.join(ROOT, 'data', 'sports-index.json');
const STATUS_FILE   = path.join(ROOT, '.nightly-status.json');

// CloudFront WAF (per-IP) trips at ~1,250-1,790 requests inside a rolling ~80s
// window, then hard-blocks for ~80s (measured 2026-07 via probe-api-limits.js).
// So Phase 1/2 no longer fire a wide pool — they use a paced burst-and-rest pool
// (see runPaced). Spectator is a different host and keeps its low fixed pool.
const CONCURRENCY_GRADES    = 25;      // paced-pool worker width, Phase 1
const CONCURRENCY_FIXTURES  = 25;      // paced-pool worker width, Phase 2
const CONCURRENCY_SPECTATOR = 3;       // unchanged (spectator.playhq.com)
const PACE_BURST            = 1000;    // requests per burst — under the ~1,256 min budget
const PACE_REST             = 90000;   // ms rest between bursts — clears the ~80s WAF window
const COMMIT_EVERY          = 50;  // commit game files every N seasons
const COMMIT_EVERY_PLAYERS  = 200; // commit player files every N players updated

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP ─────────────────────────────────────────────────────────────────────

// ⚠️ 2026-09-29 — REWRITTEN FROM https.request TO fetch(). THIS IS THE TRANSPORT FIX.
//
// THE EVIDENCE, in order, after four wrong theories:
//   1. The bootstrap was 403 CLOUDFRONT-BLOCK on every attempt while
//      discover-fixtures.js worked against the same API from the same runner in the
//      same minutes — ruling out the runner image (byte-identical), the IP range and
//      the query (both ProfileSearch and TenantConfig were refused).
//   2. The ONE remaining difference: discover-fixtures uses fetch(); this used
//      https.request with its own agent and a hand-set content-length. Switching
//      only the bootstrap to fetch() OBTAINED A SESSION on attempt 1.
//   3. And then every real call through this function came back `blocked` —
//      `burst 1: ok=0 blocked=25`. So the refusal follows the CLIENT, not the
//      endpoint and not the credentials.
//
// A different HTTP client means a different TLS and HTTP fingerprint on the wire,
// which is what a CloudFront WAF rule keys on. That is the same class of cause as
// this repo's standing rule that actions/setup-node must never appear in a job
// fetching api.playhq.com — that rule is about the RUNTIME changing the outbound
// fingerprint; this is the same idea one level down, in the client library.
//
// ⚠️ DO NOT "OPTIMISE" THIS BACK TO https.request, AND DO NOT SET content-length BY
// HAND. Both are what was being blocked. The signature and the return shape are
// unchanged — { status, rawCookies, body, rawText } — so every caller is untouched.
//
// keepAlive: the old agent explicitly disabled it. fetch() pools connections, which
// is what discover-fixtures has always done at concurrency 40 without trouble. If a
// future block looks connection-shaped rather than request-shaped, that is the first
// thing to revisit.
async function doFetch(url, bodyObj, headers) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { ...headers, 'request-id': crypto.randomUUID() },
    body:    JSON.stringify(bodyObj),
  });
  const rawText = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(rawText); } catch (_) { body = null; }
  // undici exposes each Set-Cookie separately; the joined header is the fallback for
  // older runtimes. Callers expect an array or undefined, never an empty array.
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return {
    status:     res.status,
    rawCookies: cookies.length ? cookies : undefined,
    body,
    rawText,
  };
}

// ─── Session ──────────────────────────────────────────────────────────────────

const HEADERS_MAIN = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};
const HEADERS_SPECTATOR = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'bv', 'x-phq-tenant': 'bv', 'content-type': 'application/json',
};

let sessionCookie = null;

// ⚠️ THE SESSION HAS A REQUEST BUDGET OF ROUGHLY 290 CALLS (REPO_MANIFEST §6.59).
// This script refreshed only when it had NO cookie or after a 403 — so it ran until
// PlayHQ refused it, and a bootstrap inside the penalty window that follows is itself
// refused. The guard rotates BEFORE the budget runs out, which is granted instantly,
// and makes concurrent callers share one refresh instead of starting one each.
const { createSessionGuard } = require('./lib/playhq-session.cjs');
const sessionGuard = createSessionGuard({
  refresh:   () => refreshSession(),
  hasCookie: () => !!sessionCookie,
  clear:     () => { sessionCookie = null; },
});

// ⚠️ 2026-09-29 — THE BOOTSTRAP QUERY CHANGED. TenantConfig WAS BEING REFUSED.
//
// On 2026-09-28/29 this script and discover-org-seasons.js failed EVERY attempt with
// HTTP 403, no set-cookie, CloudFront block page — while THREE other scripts hit the
// same API from the same runner in the same hours and succeeded. Nightly Crawl #117
// shows it starkly: `crawl` failed the session ten times and the
// `profile-stats-matrix` it dispatched went green minutes later.
//
// What separated them was the bootstrap QUERY. Not the headers — identical five keys
// in all five scripts. Not the runner image — byte-identical between a working and a
// failing run. Not the IP range — the successes prove it was reachable.
//   WORKED  discover-fixtures.js and the profile matrix: ProfileSearch, only that.
//   FAILED  this script: TenantConfig, ONLY that.
//   FAILED  discover-org-seasons.js: TenantConfig FIRST, then ProfileSearch on the
//           same keep-alive connection, and BOTH refused — which is why the first
//           refusal marking the connection is the likelier reading than ProfileSearch
//           being broken, given it worked elsewhere in the same minutes.
//
// ProfileSearch now goes first, copied from the implementation that was working that
// morning. TenantConfig is KEPT AS A FALLBACK rather than deleted: this evidence is
// behavioural, PlayHQ may change it back, and a query that stops working is not a
// query that is wrong.
//
// THE COOKIE SHAPE IS NOT ASSUMED. This script needs phq_tier, phq_session and
// phq_sub BY NAME; discover-fixtures joins whatever comes back. A different operation
// may not return the same three, so the named extraction is tried first and the
// joined form is the fallback. The log says which was used, so nobody has to guess.
const BOOTSTRAP_QUERIES = [
  { operationName: 'ProfileSearch', variables: { fullName: 'a' },
    query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
  { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' },
];

// ⚠️ 2026-09-29 — THE BOOTSTRAP USES fetch(), NOT doFetch(). THIS IS THE FIX.
//
// Evidence, gathered over four wrong theories:
//   · runner image — byte-identical between a working and a failing run.
//   · IP range — discover-fixtures.js ran 1h02m against this API at 10:01 the same
//     morning, and the profile matrix went green inside the very run whose `crawl`
//     job had just been refused ten times.
//   · bootstrap query — swapping to ProfileSearch changed nothing; BOTH queries 403.
//   · keep-alive poisoning — impossible here, doFetch builds
//     `new https.Agent({ keepAlive: false })` per request.
//
// What is left, and what actually separates the two scripts: discover-fixtures.js
// bootstraps with **fetch()** and this script used **https.request** with its own
// agent and a hand-set content-length. Same URL, same five headers, same query,
// different CLIENT — and therefore a different TLS and HTTP fingerprint on the wire,
// which is what a CloudFront WAF rule keys on. That is the same class of cause as
// this repo's standing rule about actions/setup-node changing the runner's outbound
// fingerprint and drawing 403s on every request.
//
// So the session is obtained with fetch(), copied from the implementation that was
// working that morning, rather than approximated.
//
// ⚠️ IF THE CRAWL NOW GETS A SESSION AND THEN 403s ON ITS FIRST REAL CALL, the
// fingerprint is the cause and the whole transport needs replacing, not just this.
// That is the next thing to check, and it is one run away.
// The bootstrap now uses the same transport as everything else — doFetch() — so
// there is no second implementation to drift. Kept as a named wrapper only because
// refreshSession reads better for it.
const sessionFetch = (bodyObj) => doFetch(API_URL, bodyObj, HEADERS_MAIN);

async function refreshSession() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    for (const body of BOOTSTRAP_QUERIES) {
      try {
        // ⚠️ THE TRANSPORT, NOT THE QUERY. See the note above the loop.
        // ⚠️ doFetch RESOLVES ON ANY STATUS — it never throws for a 403 (see its
        // definition: it hands back {status, rawCookies, body, rawText} whatever
        // comes back). Reading only rawCookies reported a CloudFront block page as
        // "no set-cookie", which is how the 2026-09-29 diagnosis went wrong: the
        // failure LOOKED different after a change that had not altered it at all.
        // Log the status and the first of the body, the way discover-org-seasons.js
        // already does, so the next run says what actually came back.
        const { rawCookies, status, rawText } = await sessionFetch(body);
        if (!rawCookies) {
          const blocked = /cloudfront|Request blocked|ERROR: The request could not be satisfied/i.test(rawText || '');
          const detail = blocked
            ? `CLOUDFRONT-BLOCK (${(rawText || '').length}b HTML)`
            : (rawText || '').slice(0, 160).replace(/\s+/g, ' ');
          console.log(`  \u26a0 session attempt ${attempt} ${body.operationName}: HTTP ${status}, NO set-cookie, body: ${detail || '(empty)'}`);
          continue;
        }
        const arr = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
          .map(c => c.split(';')[0].trim());
        const get = n => arr.find(p => p.startsWith(n + '=')) || null;
        const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
        if (tier && session && sub) {
          sessionCookie = `${tier}; ${session}; ${sub}`;
          console.log(`  Session refreshed (attempt ${attempt}, ${body.operationName})`);
          return;
        }
        // Cookies came back, but not the three this script names. Use them joined,
        // the way discover-fixtures.js does — a session that works beats discarding a
        // 200 and retrying into the same wall.
        if (arr.length) {
          sessionCookie = arr.join('; ');
          console.log(`  Session refreshed (attempt ${attempt}, ${body.operationName}) — joined ${arr.length} cookie(s), named set absent`);
          return;
        }
      } catch (_) { /* transport failure — try the next query, then the next attempt */ }
    }
  }
  throw new Error('Failed to obtain session after 10 attempts');
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

// Typed GraphQL call for the MAIN api. Returns { kind, data }:
//   'ok'        — HTTP 200 with body.data (caller inspects payload for genuine-empty)
//   'blocked'   — CloudFront WAF 403 (rate limit). Caller MUST rest & requeue, never retry.
//   'transient' — network / 5xx / 429 / GraphQL errors. Caller requeues.
//   'empty'     — ProfileSeasonStatistics private 403.
// Session-expiry 403 (JSON, not WAF HTML) is refreshed and retried inline once —
// that is not throttling. We never collapse a failure into "no data"
// (see playhq_api_reference.md "Failure handling").
async function gqlMain(operationName, query, variables) {
  // §6.62 — capture the generation ensure() issues this call on, so a rotation
  // requested below is skipped when another caller has already replaced the cookie.
  const gen = await sessionGuard.ensure();
  for (let attempt = 1; attempt <= 2; attempt++) {
    let status, body, rawText;
    try {
      ({ status, body, rawText } = await doFetch(
        API_URL, { operationName, variables, query },
        { ...HEADERS_MAIN, 'Cookie': sessionCookie }
      ));
    } catch (_) {
      if (attempt < 2) { await sleep(1000); continue; }
      return { kind: 'transient', data: null };
    }
    if (status === 403) {
      const isWaf = rawText && (rawText.includes('DOCTYPE') || rawText.includes('Request blocked'));
      if (isWaf) return { kind: 'blocked', data: null };                 // WAF — do NOT retry
      if (operationName === 'ProfileSeasonStatistics') return { kind: 'empty', data: null };
      // ⚠️ 2026-10-05 §6.62 — WAS `await refreshSession()`, WHICH HAS NO SINGLE-FLIGHT
      // LOCK. N concurrent expiry 403s on the same dead cookie started N bootstraps —
      // the exact burst lib/playhq-session.cjs was written to stop, and a burst of
      // bootstraps is itself refused. rotateNow() shares one refresh and skips it
      // outright when `gen` says the session has already moved on.
      await sessionGuard.rotateNow('session expiry 403', gen);           // session expiry — retry once
      continue;
    }
    if (status === 429)   return { kind: 'transient', data: null };
    if (status !== 200)   { if (attempt < 2) { await sleep(1000); continue; } return { kind: 'transient', data: null }; }
    if (body && body.errors) return { kind: 'transient', data: null };
    return { kind: 'ok', data: (body && body.data) || null };
  }
  return { kind: 'transient', data: null };
}

async function gqlSpectator(gameId) {
  const gen = await sessionGuard.ensure();   // §6.62 — see gqlMain
  const query = `query game($id: ID!) {
    game(id: $id) {
      id status
      statistics {
        home { players { profileID name playerNumber statistics { type { value } count } } }
        away { players { profileID name playerNumber statistics { type { value } count } } }
      }
    }
  }`;
  try {
    const { status, body } = await doFetch(
      SPECTATOR_URL,
      { operationName: 'game', variables: { id: gameId }, query },
      { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
    );
    if (status === 403) {
      // Single refresh then retry — do not loop.
      // §6.62 — through the guard, for the same single-flight reason as gqlMain.
      await sessionGuard.rotateNow('spectator 403', gen);
      const retry = await doFetch(
        SPECTATOR_URL,
        { operationName: 'game', variables: { id: gameId }, query },
        { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
      );
      if (retry.status !== 200 || retry.body.errors) return null;
      return retry.body.data?.game || null;
    }
    if (status !== 200 || body.errors) return null;
    return body.data?.game || null;
  } catch (_) { return null; }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const Q_GRADE_ROUNDS = `query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id name hideScores
    rounds { id name abbreviatedName current number isFinalsRound }
    season { id competition { id organisation { id name } } }
  }
}`;

// __typename is requested explicitly on inline fragments to ensure reliable
// type discrimination in the response, regardless of server defaults.
const Q_FIXTURE_BY_ROUND = `query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    byes {
      id name __typename
      organisation { id name }
    }
    games {
      id date dates __typename
      status { value }
      home {
        __typename
        ... on DiscoverTeam { id name organisation { id name } season { id } }
        ... on ProvisionalTeam { name }
      }
      away {
        __typename
        ... on DiscoverTeam { id name organisation { id name } season { id } }
        ... on ProvisionalTeam { name }
      }
      result {
        outcome { name value }
        winner  { name value }
        home {
          outcome { name value }
          statistics { count type { value } }
          gameOutcomeDescription
        }
        away {
          outcome { name value }
          statistics { count type { value } }
        }
      }
      allocation {
        time
        dateTimeList { date time }
        court {
          id name abbreviatedName
          venue { id name abbreviatedName latitude longitude
                  address suburb state postcode country }
        }
      }
    }
  }
}`;

// ⚠ COPIED VERBATIM from discover-fixtures.js (Q_SEASON_TEAMS). Never retyped,
// never trimmed — the standing rule is that a PlayHQ query comes from the live
// script that exercises it, because authority comes from being exercised rather
// than from being on disk.
//
// `ID!` is the correct variable type here, and that is the OPPOSITE of
// discoverSeason on this tenant, which needs String!. `grade` CAN BE NULL on a
// returned team (EDJBA's z101, U7, no grade), so anything reading team.grade.id
// must tolerate it.
const Q_SEASON_TEAMS = `
query discoverTeamsBySeason($seasonId: ID!) {
  discoverTeams(filter: {seasonID: $seasonId}) {
    id
    grade { id name }
  }
}`;

// ─── Stat helpers ─────────────────────────────────────────────────────────────

function parseScore(statistics) {
  if (!Array.isArray(statistics)) return null;
  const s = statistics.find(x => x.type?.value === 'TOTAL_SCORE');
  return s ? (s.count ?? null) : null;
}

function spectatorStatValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const s = statistics.find(x => x.type?.value === typeValue);
  return s ? (s.count || 0) : 0;
}

function parseSpectatorPlayers(players) {
  if (!Array.isArray(players)) return [];
  return players
    .filter(p => p && p.profileID)
    .map(p => ({
      profileID: p.profileID,
      name:      p.name  || null,
      number:    p.playerNumber ?? null,
      pts:       spectatorStatValue(p.statistics, 'TOTAL_SCORE'),
      pt1:       spectatorStatValue(p.statistics, '1_POINT_SCORE'),
      pt2:       spectatorStatValue(p.statistics, '2_POINT_SCORE'),
      pt3:       spectatorStatValue(p.statistics, '3_POINT_SCORE'),
      fouls:     spectatorStatValue(p.statistics, 'TOTAL_FOULS'),
    }));
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function runPool(tasks, concurrency) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) { await tasks[i++](); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// Budget-aware paced pool for the MAIN api (Phase 1/2). Fires items in bursts of
// `burst` at concurrency `conc`, resting `rest` ms between bursts to clear the
// CloudFront window. worker(item) returns 'ok'|'empty'|'blocked'|'transient'.
//  - blocked  : WAF trip. The rest of the burst is requeued WITHOUT firing (stop
//               hammering a closed gate); the 90s rest then clears the window.
//  - transient: requeued up to MAX_TRANSIENT times, then dropped (poison item).
//  - blocked is environmental, so it never counts toward the drop cap.
// Bails after 3 bursts with no progress so the workflow retrigger resumes in a
// fresh run. Never drops a call silently.
async function runPaced(items, worker, { conc, burst, rest, label }) {
  const MAX_TRANSIENT = 4;
  let queue = items.map(it => ({ it, t: 0 }));
  const counts = { ok: 0, empty: 0, blocked: 0, transient: 0, dropped: 0 };
  let round = 0, lastRemaining = Infinity, stall = 0;
  while (queue.length) {
    round++;
    const chunk = queue.slice(0, burst);
    const rest_ = queue.slice(burst);
    const requeue = [];
    let stop = false, i = 0;
    const w = async () => {
      while (i < chunk.length) {
        const entry = chunk[i++];
        if (stop) { requeue.push(entry); continue; }
        const kind = await worker(entry.it);
        counts[kind] = (counts[kind] || 0) + 1;
        if (kind === 'blocked') { stop = true; requeue.push(entry); }
        else if (kind === 'transient') {
          entry.t++;
          if (entry.t < MAX_TRANSIENT) requeue.push(entry); else counts.dropped++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, chunk.length) }, w));
    queue = requeue.concat(rest_);
    console.log(`  [${label}] burst ${round}: ok=${counts.ok} empty=${counts.empty} blocked=${counts.blocked} transient=${counts.transient} dropped=${counts.dropped} | remaining=${queue.length}`);
    if (queue.length >= lastRemaining) stall++; else stall = 0;
    lastRemaining = queue.length;
    if (stall >= 3) { console.log(`  [${label}] no progress for 3 bursts — stopping; ${queue.length} left for next run`); break; }
    if (queue.length) await sleep(rest);
  }
  return { counts, remaining: queue.length };
}

// ─── Git commit ───────────────────────────────────────────────────────────────

// commitLock prevents concurrent tasks from triggering simultaneous commits
let commitLock = false;

// dirs: explicit paths only — never -A. This repo is multi-GB with 370k+
// player files and 2,800+ game/team-stats files; -A walks the whole index
// and risks ENOBUFS (confirmed empirically 2026-07-10: a 355k-file operation
// blew Node's execSync 1MB stdout buffer via git's own default per-file
// output — the same class of thing -A risks here at similar or larger scale,
// since it has to diff the ENTIRE working tree, not just what this run touched).
// --shortstat (not --stat) and --no-stat on merge for the same reason — both
// print a per-file line/graph by default, --stat and a real merge diffstat
// scale with file count, --shortstat and --no-stat don't.
// 2026-08-09: execFileSync's DEFAULT maxBuffer is 1 MB and exceeding it SIGTERMs
// the child MID-OPERATION. fold-diverged-players died exactly this way on a
// 25,593-file commit: `git merge` emitted 1,051,036 bytes of per-file
// "Auto-merging …" lines against the 1,048,576-byte default, Node killed git
// during the merge, and a commit that had already been made was never pushed.
// The nightly is exposed the same way whenever it merges a remote that has
// advanced by a large commit (a fold, a sweep, a weekly rebuild). Every git
// call here scales its output with the number of changed files, so all seven
// get the larger buffer; `-q` on the merge suppresses the per-file lines at
// source. Reproduced at the exact failing size before this change was made.
const GIT_MAXBUF = 512 * 1024 * 1024;
async function gitCommit(message, dirs) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  const paths = (dirs && dirs.length ? dirs : ['.']);

  // ── Per-path add (directive 9) ──────────────────────────────────────────────
  // `git add` is ATOMIC across pathspecs: one unmatched path in a combined add
  // stages NOTHING, exits 128, and the empty `catch (_) {}` this replaces then
  // hid it — leaving "nothing to commit" as the only visible symptom. That is
  // exactly how discover-fixtures.js discarded 30,426 fetched games on a GREEN
  // run (2026-07-19). Staged individually, a miss skips only itself and is
  // reported loudly.
  let addFailures = 0, hardAddFailures = 0;
  for (const p of paths) {
    try { execFileSync('git', ['add', '--', p], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF }); }
    catch (e) {
      addFailures++;
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      // "did not match any files" on a per-path add is benign — see the note below.
      if (!/did not match any files/i.test(detail)) hardAddFailures++;
      console.error(`  ⚠ git add ${/did not match any files/i.test(detail) ? 'skipped' : 'FAILED'} for "${p}": ${detail}`);
    }
  }

  const staged = (() => {
    try { return execFileSync('git', ['diff', '--staged', '--shortstat'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF }).toString().trim(); }
    catch (_) { return ''; }
  })();

  if (!staged) {
    // Previously a bare silent `return`. Nothing staged AFTER a staging failure is
    // the silent-loss signature, so it must not be reported as a clean no-op.
    //
    // But be PRECISE about which failure. With per-path adds, a pathspec that
    // "did not match any files" is provably harmless: it staged nothing AND, unlike
    // the old combined add, took nothing else down with it. That is the ordinary
    // case for an optional path — e.g. needs-matrix-shards.json, which this script
    // deletes when there are no affected shards, and which a forward-mode run
    // (--rounds-forward) legitimately never recreates. Throwing on that would fail
    // a run that did exactly what it should.
    // Any OTHER add error — permissions, a locked index, corruption — is NOT
    // harmless and still throws.
    if (hardAddFailures) {
      throw new Error(`gitCommit: nothing staged and ${hardAddFailures} path(s) failed to stage for a reason other than "did not match any files" — refusing to report this as a clean no-op ("${message}")`);
    }
    if (addFailures) {
      console.log(`  (no changes to commit: ${message}) — ${addFailures} optional path(s) absent, which is not an error here`);
      return;
    }
    console.log(`  (no changes to commit: ${message})`);
    return;
  }
  console.log(`  staging: ${staged}`);   // directive 9: prove what was staged

  // Identity passed inline on commit AND merge: a missing committer identity
  // otherwise surfaces only as a merge failure, and burns the whole retry budget
  // on a config problem no amount of retrying can fix.
  const IDENT = ['-c', 'user.name=github-actions[bot]',
                 '-c', 'user.email=github-actions[bot]@users.noreply.github.com'];

  // execFileSync with an argument array — the message is no longer interpolated
  // into a shell string, so the `"` -> `'` escaping hack is gone with it.
  try { execFileSync('git', [...IDENT, 'commit', '-q', '-m', message], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF }); }
  catch (e) {
    const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
    throw new Error(`gitCommit: commit failed for "${message}" — ${detail}`);
  }

  // ── Push with retry (house pattern, copied from fold-diverged-players.js) ────
  // 60 attempts, pure random 1-91s jitter, `merge --abort` before each attempt,
  // and THROW on total failure. The previous 10-attempt loop ended in
  // `console.error` + `return`, so a run could push NOTHING and still go green —
  // the same defect closed on build-team-stats.js on 2026-07-29, which REPO_MANIFEST
  // §6.9/§6.10 called "the remaining"/"the last" 10-attempt outlier. It was not:
  // this file had it too.
  // Only genuine contention is retried. A non-contention push failure (auth,
  // branch protection, size, hook rejection) is not fixed by waiting, so it fails
  // fast with git's real error rather than being buried under 60 identical lines.
  // NOTE: async sleep, not a blocking one — gitCommit is awaited from inside the
  // Phase 2 paced pool, and blocking here would stall sibling fetch workers.
  const MAX = 60;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try { execFileSync('git', ['merge', '--abort'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF }); } catch (_) { /* none in progress */ }

    try {
      execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF });
    } catch (e) {
      if (attempt === MAX) throw e;
      const s = 1 + Math.floor(Math.random() * 91);
      console.log(`  fetch failed (attempt ${attempt}/${MAX}), retrying in ${s}s`);
      await sleep(s * 1000);
      continue;
    }

    // A merge failure is a config or content problem, not a race — fatal.
    execFileSync('git', [...IDENT, 'merge', '-q', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF });

    try {
      execFileSync('git', ['push', 'origin', 'HEAD:main'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF });
      console.log(`  ✓ Committed: ${message} (pushed on attempt ${attempt})`);
      return;
    } catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
      const contention = /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(detail);
      if (!contention) {
        console.error(`  push failed — NOT contention, failing fast. git said:\n${detail}`);
        throw e;
      }
      if (attempt === MAX) {
        console.error(`  push still rejected after ${MAX} attempts. git said:\n${detail}`);
        throw e;
      }
      const s = 1 + Math.floor(Math.random() * 91);
      console.log(`  push attempt ${attempt}/${MAX} rejected (remote advanced), re-syncing in ${s}s`);
      await sleep(s * 1000);
    }
  }
  throw new Error(`gitCommit: exhausted ${MAX} push attempts for "${message}"`);
}

// Commit only if not already in progress — safe for concurrent callers
async function tryPeriodicCommit(message, dirs) {
  if (commitLock) return;
  commitLock = true;
  try {
    const n = flushGameFiles();
    if (n > 0) await gitCommit(message, dirs);
  } finally {
    commitLock = false;
  }
}

// ─── Game file cache ──────────────────────────────────────────────────────────

const gameCache = new Map();   // seasonId → { games: {} }
const gameDirty = new Set();   // seasonIds with pending writes
// seasonId → how many games THIS RUN deliberately deleted from that season.
// Read by the shrink guard in flushGameFiles, and by nothing else. A season is
// only ever allowed to lose the exact number of games the refresh removed from
// it on purpose; any larger shortfall is still refused.
const intentionalDeletes = new Map();

function loadGameFile(seasonId) {
  if (gameCache.has(seasonId)) return gameCache.get(seasonId);
  const file = path.join(GAMES_DIR, `${seasonId}.json`);
  let data = { games: {} };
  if (fs.existsSync(file)) {
    // If the file EXISTS but can't be read/parsed, do NOT fall back to an empty
    // object — upserting onto empty and flushing would overwrite the file with
    // only this run's games, destroying existing (often unrecoverable, e.g.
    // API-withheld junior) data on disk. Abort loudly instead.
    const raw = fs.readFileSync(file, 'utf8');   // throws on read error — intended
    try { data = JSON.parse(raw); }
    catch (e) { throw new Error(`Refusing to proceed: ${file} exists but failed to parse (${e.message}). Would risk overwriting existing games.`); }
  }
  if (!data.games) data.games = {};
  gameCache.set(seasonId, data);
  return data;
}

function markGameDirty(seasonId) { gameDirty.add(seasonId); }

function flushGameFiles() {
  let count = 0;
  for (const seasonId of [...gameDirty]) {
    if (!gameCache.has(seasonId)) continue;
    const file = path.join(GAMES_DIR, `${seasonId}.json`);
    const next = gameCache.get(seasonId);
    const nextN = Object.keys(next.games || {}).length;
    // Shrink guard: never write fewer games than already exist on disk. A stripped/
    // empty API response must never delete existing (possibly unrecoverable) games.
    if (fs.existsSync(file)) {
      let prevN = 0;
      try { prevN = Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')).games) || {}).length; } catch { prevN = Infinity; }
      // ⚠ THE SHRINK GUARD NOW HAS AN ALLOWANCE, AND IT IS NARROW ON PURPOSE.
      // The guard exists because a stripped or empty API response must never be
      // able to delete games we may not be able to get back. That is unchanged.
      // What changed on 2026-11-22 is that the refresh pass CAN delete games, on
      // purpose, having proved from a successful fetch that PlayHQ no longer
      // holds them — and without an allowance this guard would silently refuse
      // every one of those writes and print a warning that looked like a fault.
      //
      // The allowance is the exact count this run deleted from THIS season, and
      // the test is `shortfall > allowed`, not equality: the same run routinely
      // ADDS games to a season it also deleted from, which offsets the shortfall.
      // So a season may lose at most what the refresh deliberately removed, and
      // anything beyond that is still refused exactly as before.
      const allowedLoss = intentionalDeletes.get(seasonId) || 0;
      if (prevN - nextN > allowedLoss) {
        console.error(`  ⚠ SHRINK GUARD: ${seasonId} would drop from ${prevN} to ${nextN} games`
                    + ` (${prevN - nextN} lost, only ${allowedLoss} deliberately deleted) — refusing to write.`);
        gameDirty.delete(seasonId);
        continue;
      }
      if (allowedLoss > 0) {
        console.log(`  shrink guard: ${seasonId} ${prevN} → ${nextN} games, ${allowedLoss} deliberate deletion(s) allowed`);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next));
    gameDirty.delete(seasonId);
    count++;
  }
  return count;
}

// ─── Player file helpers ──────────────────────────────────────────────────────

function playerShard(uuid)    { return uuid.slice(0, 2).toLowerCase(); }
function playerFilePath(uuid) { return path.join(PLAYERS_DIR, playerShard(uuid), `${uuid}.json`); }
function playerIndexPath(s)   { return path.join(INDEX_DIR, `${s}.json`); }

function readPlayer(uuid) {
  const file = playerFilePath(uuid);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writePlayer(uuid, data) {
  if (DRY_RUN) return;
  const file = playerFilePath(uuid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

function readPlayerIndex(shard) {
  const file = playerIndexPath(shard);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

function writePlayerIndex(shard, data) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(playerIndexPath(shard)), { recursive: true });
  fs.writeFileSync(playerIndexPath(shard), JSON.stringify(data));
}

// ─── Apply round fixtures to game cache ───────────────────────────────────────
//
// Returns: { needsSpectator: [{gameId, seasonId}], forfeitGameIds: [gameId], totalGames: N }
// needsSpectator = games that are FINAL and have no spc flag yet.
// This covers both newly-scored games AND games that went FINAL in a previous
// run that timed out before spectator processing completed.

// A game is terminal (its round can't change on its account) when FINAL, or the comp
// resolved it without a normal result (cancelled/abandoned/bye), or a forfeit.
// scan-complete-rounds.js MUST use an identical rule so offline and live agree.
const TERMINAL_STATUS = new Set(['FINAL', 'CANCELLED', 'ABANDONED', 'BYE']);
function isGameTerminal(status, isForfeit) {
  return !!isForfeit || TERMINAL_STATUS.has(status);
}

function applyRoundFixtures(roundData, gradeId, gradeName, roundName, isCurrent = false) {
  const needsSpectator = [];
  const forfeitGameIds  = [];
  if (!roundData?.discoverFixtureByRound) return { needsSpectator, forfeitGameIds, totalGames: 0 };
  let totalGames = 0;
  let allTerminal = true;
  let roundSeasonId = null;

  for (const game of (roundData.discoverFixtureByRound.games || [])) {
    if (!game?.id) continue;
    totalGames++;

    const homeTeam = (game.home?.__typename === 'DiscoverTeam')     ? game.home : null;
    const awayTeam = (game.away?.__typename === 'DiscoverTeam')     ? game.away : null;
    const homeProv = (game.home?.__typename === 'ProvisionalTeam')  ? game.home : null;
    const awayProv = (game.away?.__typename === 'ProvisionalTeam')  ? game.away : null;

    // Season ID comes from team data — without it we can't write to the right file
    const seasonId = homeTeam?.season?.id || awayTeam?.season?.id || null;
    if (!seasonId) continue;
    roundSeasonId = seasonId;

    const homeScore = parseScore(game.result?.home?.statistics);
    const awayScore = parseScore(game.result?.away?.statistics);
    const status    = game.status?.value || null;
    const court     = game.allocation?.court;
    const venue     = court?.venue;
    const dt        = game.allocation?.dateTimeList?.[0];
    // Use string slicing — never new Date() for time/date parsing
    const time = dt?.time ? dt.time.slice(0, 5)
               : (game.allocation?.time || '').slice(0, 5) || null;
    const date = dt?.date
               || (Array.isArray(game.dates) ? game.dates[0] : null)
               || game.date
               || null;

    const gf       = loadGameFile(seasonId);
    const existing = gf.games[game.id] || null;

    // Build entry — spread existing first, then overlay new values
    const entry = {
      ...(existing || {}),
      ...(date       ? { d:   date }        : {}),
      ...(roundName  ? { rn:  roundName }   : {}),
      gid: gradeId,
      gn:  gradeName,
      ...(homeTeam   ? { h: homeTeam.id, hn: homeTeam.name }
          : homeProv ? { hn: homeProv.name }
          : {}),
      ...(awayTeam   ? { a: awayTeam.id, an: awayTeam.name }
          : awayProv ? { an: awayProv.name }
          : {}),
      ...(homeScore !== null ? { hs: homeScore } : {}),
      ...(awayScore !== null ? { as: awayScore } : {}),
      ...(status     ? { st: status }  : {}),
      ...(venue?.id   ? { vid: venue.id }   : {}),
      ...(venue?.name ? { vn:  venue.name } : {}),
      ...(court?.name ? { ct:  court.name } : {}),
      ...(time        ? { t:   time }        : {}),
    };

    // Detect forfeit from API outcome value
    const outcomeValue = game.result?.outcome?.value || '';
    const isForfeit    = outcomeValue.includes('FORFEIT');
    if (isForfeit) {
      entry.forfeit = true;
      const winnerSide = game.result?.winner?.value;
      entry.fo = winnerSide === 'HOME' ? (homeTeam?.id || null)
               : winnerSide === 'AWAY' ? (awayTeam?.id || null)
               : null;
      forfeitGameIds.push(game.id);
    }

    if (!isGameTerminal(status, isForfeit)) allTerminal = false;

    const changed = JSON.stringify(entry) !== JSON.stringify(existing || {});
    if (changed && !DRY_RUN) {
      gf.games[game.id] = entry;
      markGameDirty(seasonId);
    }

    // Queue for spectator if FINAL, not yet processed, and not a forfeit.
    // Covers both: games newly scored this run, and games that timed out
    // before spectator processing in a previous run.
    if (status === 'FINAL' && !existing?.spc && !isForfeit) {
      needsSpectator.push({
        gameId: game.id,
        seasonId,
        rn:      roundName || null,
        gradeId: gradeId   || null,
        gradeName: gradeName || null,
        homeTid: homeTeam?.id || null,
        awayTid: awayTeam?.id || null,
        homeScore,
        awayScore,
      });
    }
  }

  // Round-completion marker (keyed by gradeId + roundName; see queue-build skip).
  // Never mark the current round (still live) or an empty round.
  if (!isCurrent && !DRY_RUN && roundSeasonId && totalGames > 0) {
    const gf = loadGameFile(roundSeasonId);
    if (!gf.roundsComplete) gf.roundsComplete = {};
    const byGrade = gf.roundsComplete[gradeId] || (gf.roundsComplete[gradeId] = {});
    const prior = byGrade[roundName];
    if (allTerminal) {
      const at = prior?.at || new Date().toISOString();   // pin first-seen time so grace elapses
      if (!prior || prior.at !== at || prior.n !== totalGames) {
        byGrade[roundName] = { at, n: totalGames };
        markGameDirty(roundSeasonId);
      }
    } else if (prior) {
      delete byGrade[roundName];                           // a reschedule reopened it
      markGameDirty(roundSeasonId);
    }
  }

  return { needsSpectator, forfeitGameIds, totalGames };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log('nightly-crawl.js');
  console.log(`  rounds-back: ${ROUNDS_BACK}`);
  if (TARGET_SEASON) console.log(`  season:      ${TARGET_SEASON}`);
  if (DRY_RUN)       console.log('  ⚠  DRY RUN — no writes or commits');
  console.log('─'.repeat(50));

  if (!fs.existsSync(INDEX_FILE)) {
    console.error('sports-index.json not found'); process.exit(1);
  }
  const sportIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const allSeasons = Object.values(sportIndex.seasons || {});
  const seasons    = TARGET_SEASON
    ? allSeasons.filter(s => s.id === TARGET_SEASON)
    : allSeasons.filter(s => s.locked === false);

  console.log(`\nActive seasons: ${seasons.length}`);

  const gradeEntries = [];
  for (const season of seasons) {
    for (const grade of (season.grades || [])) {
      if (grade.id) gradeEntries.push({ gradeId: grade.id });
    }
  }
  console.log(`Active grades:  ${gradeEntries.length}\n`);

  await refreshSession();

  // ── Phase 1: Grade rounds ────────────────────────────────────────────────────
  console.log('Phase 1/4 — Grade rounds…');
  const gradeRoundResults = [];

  const p1 = await runPaced(gradeEntries, async ({ gradeId }) => {
    const { kind, data } = await gqlMain('gradeRounds', Q_GRADE_ROUNDS, { gradeID: gradeId });
    if (kind !== 'ok') return kind;                  // blocked/transient -> requeue; empty -> counted
    const g = data && data.discoverGrade;
    if (!g) return 'empty';                           // genuine: grade has no data
    gradeRoundResults.push({
      gradeId:    g.id,
      gradeName:  g.name  || '',
      hideScores: !!g.hideScores,
      seasonId:   g.season?.id || null,
      rounds:     g.rounds || [],
    });
    return 'ok';
  }, { conc: CONCURRENCY_GRADES, burst: PACE_BURST, rest: PACE_REST, label: 'P1 grades' });
  console.log(`  ${gradeEntries.length} grades done — ok=${p1.counts.ok} empty=${p1.counts.empty} blocked=${p1.counts.blocked} transient=${p1.counts.transient} dropped=${p1.counts.dropped} remaining=${p1.remaining}`);

  const normalGrades = gradeRoundResults.filter(g => !g.hideScores);
  const hiddenCount  = gradeRoundResults.filter(g =>  g.hideScores).length;
  console.log(`  Normal: ${normalGrades.length}  Hidden (skipped): ${hiddenCount}\n`);

  // ── Phase 1b: Reclassify games for grades that became hidden ────────────────
  // When a grade's hideScores flips from false to true, its existing game entries
  // in the game file still have no hidden flag. Detect and reclassify them.
  // DO NOT delete scores — spectator can still fetch them. Queue FINAL games for
  // spectator processing so box scores are fetched and stored.
  const hiddenGrades = gradeRoundResults.filter(g => g.hideScores && g.seasonId);
  let reclassified = 0;
  const reclassifiedSpectator = []; // FINAL reclassified games to queue for spectator

  for (const grade of hiddenGrades) {
    const gf = loadGameFile(grade.seasonId);
    for (const [gameId, game] of Object.entries(gf.games || {})) {
      if (game.gid !== grade.gradeId) continue;
      if (game.hidden) continue;  // already classified
      // Grade is now hidden — mark it but preserve any existing scores
      game.hidden = true;
      markGameDirty(grade.seasonId);
      reclassified++;
      // Queue FINAL games without box scores for spectator
      if (game.st === 'FINAL' && !game.spc && !game.legacy && !game.forfeit) {
        reclassifiedSpectator.push({
          gameId,
          seasonId:  grade.seasonId,
          rn:        game.rn  || null,
          gradeId:   grade.gradeId,
          gradeName: grade.gradeName,
          homeTid:   game.t1 || null,
          awayTid:   game.t2 || null,
          homeScore: game.hs ?? null,
          awayScore: game.as ?? null,
        });
      }
    }
  }
  if (reclassified > 0) {
    console.log(`  Reclassified ${reclassified} games as hidden (grade hideScores flipped)`);
    console.log(`  Queued ${reclassifiedSpectator.length} reclassified FINAL games for spectator`);
    const n = flushGameFiles();
    if (n > 0) await gitCommit(`nightly-crawl: ${reclassified} games reclassified as hidden`, ['games/']);
  }
  console.log(`  Hidden grades checked: ${hiddenGrades.length}  Games reclassified: ${reclassified}\n`);

  // ── Phase 2: Fixture fetches ──────────────────────────────────────────────────
  console.log(`Phase 2/4 — Round fixtures (${ROUNDS_BACK} round(s) back)…`);

  // Build round queue: each grade contributes current round + up to ROUNDS_BACK-1 previous
  // A previous round already marked complete (all games terminal) and past the grace
  // window can never change — skip fetching it. The current round is always fetched.
  // --force-recheck ignores markers entirely (audit / catch late corrections).
  const nowMs = Date.now();
  const isSettled = (seasonId, gid, roundName) => {
    if (FORCE_RECHECK || !seasonId) return false;
    const m = loadGameFile(seasonId).roundsComplete?.[gid]?.[roundName];
    return !!(m && (nowMs - Date.parse(m.at)) > COMPLETE_GRACE_MS);
  };

  const roundQueue = [];
  let skippedComplete = 0;
  for (const grade of normalGrades) {
    if (!grade.rounds.length) continue;
    const currentRound = grade.rounds.find(r => r.current);
    if (!currentRound) continue;

    roundQueue.push({ roundId: currentRound.id, roundName: currentRound.name, grade, isCurrent: true });

    // Previous rounds by descending round number
    const prevRounds = [...grade.rounds]
      .filter(r => r.number < currentRound.number)
      .sort((a, b) => b.number - a.number)
      .slice(0, ROUNDS_BACK - 1);

    for (const r of prevRounds) {
      if (isSettled(grade.seasonId, grade.gradeId, r.name)) { skippedComplete++; continue; }
      roundQueue.push({ roundId: r.id, roundName: r.name, grade, isCurrent: false });
    }
  }
  console.log(`  Round fetches queued: ${roundQueue.length}  (skipped ${skippedComplete} settled rounds)`);

  let seasonsSinceCommit = 0;
  const processedSeasons  = new Set();
  const allNeedsSpectator = [];  // { gameId, seasonId } — deduped after phase
  // Add any FINAL games reclassified as hidden in Phase 1b
  if (reclassifiedSpectator.length > 0) allNeedsSpectator.push(...reclassifiedSpectator);
  const allNewForfeitIds  = [];  // new forfeit game IDs detected this run

  // Phase 2R reuses what this pass fetched instead of asking PlayHQ twice for
  // the same rounds — and reusing the CURRENT round's ids is what lets the
  // withdrawal check cover it at all. Phase 2 has never deleted anything, so
  // without this a game withdrawn from the current round would survive for ever.
  const p2RoundIds = new Map();   // `${gradeId}|${roundName}` -> [gameId]

  const p2 = await runPaced(roundQueue, async ({ roundId, roundName, grade, isCurrent }) => {
    const { kind, data } = await gqlMain('discoverFixtureByRound', Q_FIXTURE_BY_ROUND, { roundID: roundId });
    if (kind !== 'ok') return kind;                  // blocked/transient -> requeue
    const { needsSpectator, forfeitGameIds } = applyRoundFixtures(
      data, grade.gradeId, grade.gradeName, roundName, isCurrent
    );
    // {ids, answered}. `answered` is whether PlayHQ returned a payload for the
    // round at all: a null discoverFixtureByRound is NOT an answer, an empty
    // games array IS one. Collapsing the two is what would have protected 103
    // rounds of withdrawn fixtures for ever.
    p2RoundIds.set(`${grade.gradeId}|${roundName}`, {
      ids: ((data && data.discoverFixtureByRound && data.discoverFixtureByRound.games) || [])
        .map(g => g && g.id).filter(Boolean),
      answered: !!(data && data.discoverFixtureByRound),
    });
    allNeedsSpectator.push(...needsSpectator);
    allNewForfeitIds.push(...forfeitGameIds);

    // Count seasons touched for periodic commit — track unique seasons per commit window
    for (const { seasonId } of needsSpectator) {
      if (!processedSeasons.has(seasonId)) {
        processedSeasons.add(seasonId);
        seasonsSinceCommit++;
      }
    }

    // Periodic commit — lock prevents concurrent tasks both committing
    if (seasonsSinceCommit >= COMMIT_EVERY) {
      seasonsSinceCommit = 0;  // reset immediately before await
      await tryPeriodicCommit(
        `nightly-crawl: game files (${allNeedsSpectator.length} games queued for spectator so far)`,
        ['games/']
      );
    }
    return 'ok';
  }, { conc: CONCURRENCY_FIXTURES, burst: PACE_BURST, rest: PACE_REST, label: 'P2 fixtures' });
  console.log(`  ${roundQueue.length} rounds done — ok=${p2.counts.ok} empty=${p2.counts.empty} blocked=${p2.counts.blocked} transient=${p2.counts.transient} dropped=${p2.counts.dropped} remaining=${p2.remaining}`);

  // ── Phase 2R: per-grade fixture refresh, and withdrawal deletion ───────────
  //
  // Phase 2 above fetched the CURRENT round and ROUNDS_BACK-1 previous rounds.
  // This pass fetches FORWARD, and it is the only place in this repository that
  // removes a game.
  //
  // Per active grade: compare the grade's round list — which Phase 1 already
  // fetched, so it costs nothing — against the fingerprint stored from the last
  // successful run. Re-fetch the next REFRESH_AHEAD unplayed rounds, plus any
  // round the fingerprint has never seen. Overwrite changed fields through the
  // same applyRoundFixtures the rest of the crawl uses. Then delete the stored
  // UNPLAYED games that a SUCCESSFUL fetch did not return.
  //
  // ⚠ A GRADE WHOSE FETCHES DID NOT ALL SUCCEED IS LEFT ENTIRELY ALONE: no
  // deletions, no fingerprint. A 403, a GraphQL error, a timeout or a round that
  // came back empty while still being listed all disqualify the whole grade for
  // the night. This is the failure-to-ASK rule, which has cost this repository
  // four separate incidents: PlayHQ declining to answer must never be recorded
  // as PlayHQ answering with nothing.
  //
  // ⚠ IT RUNS BEFORE THE SPECTATOR DEDUPE DELIBERATELY. A forward round can come
  // back already FINAL — a late entry, or a game brought forward — and those
  // belong in tonight's spectator queue like any other. Pushing into
  // allNeedsSpectator here and letting the existing dedupe below handle the
  // overlap is why this block sits above it rather than after.
  const refresh = {
    gradesConsidered: 0, baselined: 0, incremental: 0, baselineDeferred: 0,
    noRounds: 0, currentIsLast: 0, nothingToFetch: 0, baselineFree: 0,
    movedNotDeleted: 0, gradesUnaccounted: 0, capWarnings: 0, archived: 0, resurrected: 0,
    roundsQueued: 0, gradesFullRescanned: 0, wavesExhausted: 0, sameDayConflicts: 0,
    roundsFetched: 0, roundsFailed: 0, suspectEmpty: 0,
    deleted: 0, keptPlayed: 0, noRoundSkipped: 0,
    listChanged: 0, seasonsRegraded: 0, newGradesSwept: 0,
    abortedBy: null,
  };
  const refreshStatePaths = [];

  if (NO_ROUND_REFRESH) {
    console.log('\nPhase 2R — per-grade fixture refresh: DISABLED (--no-round-refresh)\n');
  } else {
    console.log(`\nPhase 2R — per-grade fixture refresh`
              + ` (${REFRESH_AHEAD} round(s) ahead for DISCOVERY; any change triggers a full grade rescan + expansion)…`);
    if (REFRESH_DRY_RUN) console.log('  ⚠ --refresh-dry-run: fetches and reports, deletes nothing, writes no fingerprint');

    // A corrupt fingerprint file THROWS rather than being treated as absent —
    // silently baselining the whole repository off a parse failure would be a
    // very large amount of work presented as routine.
    const fp = RR.loadFingerprints(ROOT);

    // Completed seasons are out of scope by decision: their fixtures cannot
    // change and their games are history. `locked` is already excluded upstream
    // — gradeEntries is built from seasons at locked === false.
    const seasonStatus = (sid) => (sportIndex.seasons && sportIndex.seasons[sid] && sportIndex.seasons[sid].status) || null;

    let baselinesLeft = BASELINE_PER_RUN;
    const work = [];

    for (const grade of normalGrades) {
      if (!grade.seasonId) continue;                       // cannot scope a write without it
      if (seasonStatus(grade.seasonId) === 'COMPLETED') continue;

      const gfNow = loadGameFile(grade.seasonId);
      const { byRound, noRound } = RR.groupStoredByRound(gfNow.games, grade.gradeId);
      refresh.noRoundSkipped += noRound.length;

      const stored = fp.grades[grade.gradeId] || null;
      const plan = RR.planGrade({ grade, stored, byRound, aheadN: REFRESH_AHEAD });

      if (plan.mode === 'baseline') {
        // ⚠ A GRADE THAT PLANS NO FETCH DOES NOT SPEND BASELINE BUDGET.
        // Measured on the first live run: of 2,000 grades baselined, 1,978
        // planned no fetch at all — 1,972 of them sitting on their LAST round,
        // i.e. seasons that are over but not yet locked (lock_after_months is 3).
        // They cost nothing in API terms and are "done" the moment a fingerprint
        // is written, but under the old accounting they consumed 98.6% of the
        // night's budget and the 5,598-grade backlog was draining in name only.
        // Spending the budget on grades that actually fetch something means the
        // real work drains in a handful of nights instead of weeks.
        if (plan.fetch.length > 0) {
          if (baselinesLeft <= 0) { refresh.baselineDeferred++; continue; }
          baselinesLeft--;
        } else {
          refresh.baselineFree++;
        }
        refresh.baselined++;
      } else {
        refresh.incremental++;
      }
      if (plan.listChanged) refresh.listChanged++;
      refresh.gradesConsidered++;

      // WHY A GRADE PLANNED NOTHING. The first production dry run fetched 361
      // rounds for 750 grades — 0.48 each — and nothing in the log said whether
      // that was correct or a planner that was too narrow. These three counters
      // answer it without another dispatch: a grade with no rounds at all is a
      // grading grade PlayHQ has not drawn yet, and a grade whose CURRENT round
      // is its LAST is a season that is over but not yet locked (lock_after_months
      // is 3, so recently finished seasons sit here for months). Both legitimately
      // have nothing ahead to fetch.
      if (plan.fetch.length === 0) {
        refresh.nothingToFetch++;
        const rs = grade.rounds || [];
        const ci = rs.findIndex(r => r && r.current);
        if (rs.length === 0) refresh.noRounds++;
        else if (ci === rs.length - 1) refresh.currentIsLast++;
      }

      work.push({ grade, plan, byRound, stored });
    }

    console.log(`  Grades considered: ${refresh.gradesConsidered}`
              + `  (baseline ${refresh.baselined}, incremental ${refresh.incremental}`
              + `${refresh.baselineDeferred ? `, ${refresh.baselineDeferred} baseline deferred to a later run` : ''})`);
    if (refresh.baselineFree) {
      console.log(`  ${refresh.baselineFree} grade(s) baselined for free — they plan no fetch, so they did not spend budget.`);
    }
    if (refresh.noRoundSkipped) {
      console.log(`  ${refresh.noRoundSkipped} stored game(s) carry no round name and are OUT OF SCOPE for deletion`
                + ` — games/bv holds the round NAME and no round id, so they cannot be scoped to a round.`);
    }

    // ── Fetch every planned round through the paced pool ─────────────────────
    const fetchItems = [];
    for (const w of work) for (const f of w.plan.fetch) fetchItems.push({ w, f });
    console.log(`  Round fetches queued: ${fetchItems.length}`);
    if (refresh.nothingToFetch) {
      console.log(`  ${refresh.nothingToFetch} grade(s) planned no fetch at all —`
                + ` ${refresh.noRounds} have no rounds yet (undrawn),`
                + ` ${refresh.currentIsLast} are on their LAST round (season over, not yet locked),`
                + ` ${refresh.nothingToFetch - refresh.noRounds - refresh.currentIsLast} have every round ahead already played.`);
    }

    // Seeded with what PHASE 2 ALREADY FETCHED. The current round is queued by
    // Phase 2 for every grade that has one, so asking for it again here would be
    // one duplicate request per grade — thousands on a baseline night. Reusing
    // its ids also means the CURRENT round gets the same withdrawal check as the
    // forward ones, which it otherwise would not: Phase 2 fetches it and has
    // never deleted anything.
    const roundResults = new Map(p2RoundIds);   // `${gid}|${roundName}` → {ids, answered}

    // ── WAVE SCAN: change detected → full grade → expand until quiet ─────────
    //
    // "we are looking for any changes in fixtures, and when we find one we scan
    // all of them for that grade and expand until we find the boundary of the
    // changes." — Mark, 2026-11-23. The forward window is DISCOVERY ONLY now.
    //
    // ⚠ WHY THE COVERAGE GATE IS GONE RATHER THAN RELAXED. Deletions can only
    // arise in a grade whose fixtures changed — if every fetched round's id set
    // matches the fingerprint, the grade holds the same games and there is
    // nothing to delete. And any changed grade is FULLY rescanned here before
    // the deletion decision runs. So full coverage is now guaranteed exactly
    // where it matters, by construction, instead of being asserted after a
    // partial look and used to refuse the work. The old gate withheld 26 grades
    // and 251 games on 2026-11-23, all of them residue PlayHQ had already
    // dropped, and left a team holding two fixtures in two grades on one day.
    const fetchedByGrade = new Map();              // gid → Set(roundName)
    const noteFetched = (gid, rn) => {
      if (!fetchedByGrade.has(gid)) fetchedByGrade.set(gid, new Set());
      fetchedByGrade.get(gid).add(rn);
    };
    for (const key of roundResults.keys()) {       // seed with Phase 2's own fetches
      const bar = key.indexOf('|');
      if (bar > 0) noteFetched(key.slice(0, bar), key.slice(bar + 1));
    }

    const workByGid = new Map(work.map(w => [w.grade.gradeId, w]));

    // Team → grades we hold games for it in. Built from the stored games already
    // loaded for planning, so expansion costs no extra read and no extra call.
    // A grade holding no stored games has nothing to delete, so its absence here
    // cannot hide work.
    const gradesOfTeam = new Map();
    for (const w of work) {
      for (const arr of w.byRound.values()) {
        for (const e of arr) {
          const g = (e && e.g) || {};
          for (const k of ['hTid', 'aTid', 't1', 't2']) {
            const tid = g[k];
            if (typeof tid !== 'string' || !tid) continue;
            if (!gradesOfTeam.has(tid)) gradesOfTeam.set(tid, new Set());
            gradesOfTeam.get(tid).add(w.grade.gradeId);
          }
        }
      }
    }

    const fullRescanned   = new Set();   // gid — already queued for a full scan
    const seenChanged     = new Set();   // `gid|roundName` — already expanded from
    const unfetchable     = new Map();   // gid → [roundName] that cannot be fetched at all
    // A runaway here would be an expansion loop, not a deletion loop. The round
    // list bounds each grade and the grade list bounds the season, so this cap
    // exists to turn a logic error into a loud stop rather than a 6-hour job.
    const MAX_WAVES = 8;

    let queue = fetchItems;
    let wave  = 0;

    while (queue.length) {
      wave++;
      if (wave > MAX_WAVES) {
        console.log(`::warning::nightly-crawl refresh: expansion did not settle in ${MAX_WAVES} waves —`
                  + ` ${queue.length} round(s) left unfetched. Deletions proceed only for grades`
                  + ` actually scanned; nothing is deleted on the strength of a round we never asked for.`);
        refresh.wavesExhausted = queue.length;
        break;
      }
      if (wave > 1) console.log(`  wave ${wave}: ${queue.length} round(s) queued from detected changes`);

      const p2r = await runPaced(queue, async ({ w, f }) => {
        const { kind, data } = await gqlMain('discoverFixtureByRound', Q_FIXTURE_BY_ROUND, { roundID: f.roundId });
        if (kind !== 'ok') return kind;                    // blocked/transient → requeue
        const { needsSpectator, forfeitGameIds } = applyRoundFixtures(
          data, w.grade.gradeId, w.grade.gradeName, f.roundName, false
        );
        allNeedsSpectator.push(...needsSpectator);
        allNewForfeitIds.push(...forfeitGameIds);
        roundResults.set(`${w.grade.gradeId}|${f.roundName}`, {
          ids: ((data && data.discoverFixtureByRound && data.discoverFixtureByRound.games) || [])
            .map(g => g && g.id).filter(Boolean),
          answered: !!(data && data.discoverFixtureByRound),
          // ⚠ `byes` IS A SEPARATE ARRAY FROM `games`, and this is why an empty
          // games list can be a TRUE answer. A bye round returns no games at
          // all. On 2026-11-23 three deletions from a bye round were briefly
          // believed to be wrong because nothing in the log said "bye".
          byes: ((data && data.discoverFixtureByRound && data.discoverFixtureByRound.byes) || []).length,
        });
        noteFetched(w.grade.gradeId, f.roundName);
        return 'ok';
      }, { conc: CONCURRENCY_FIXTURES, burst: PACE_BURST, rest: PACE_REST, label: 'P2R refresh' });
      console.log(`  wave ${wave}: ${queue.length} rounds done — ok=${p2r.counts.ok} empty=${p2r.counts.empty}`
                + ` blocked=${p2r.counts.blocked} transient=${p2r.counts.transient} dropped=${p2r.counts.dropped}`
                + ` remaining=${p2r.remaining}`);
      refresh.roundsQueued += queue.length;

      // ── DETECT, THEN EXPAND ────────────────────────────────────────────────
      //
      // Detection runs over EVERY grade each wave, not only the ones just
      // fetched: a grade whose rounds were fetched in wave 1 can be shown to
      // have changed only once those results are in, and a grade pulled in by
      // expansion changes the picture for the grade that pulled it.
      //
      // `seenChanged` is keyed on (gid, round) so the same change is never
      // expanded from twice — that, not the wave cap, is what makes this
      // terminate: there are finitely many (grade, round) pairs and each can
      // contribute to expansion once.
      const expandTeams = new Set();
      const markFull    = new Set();

      for (const w of work) {
        const gid = w.grade.gradeId;
        const ch  = RR.detectGradeChange({
          stored: w.stored, gid, roundResults, roundListHash: w.plan.roundListHash,
        });
        if (!ch.changed) continue;

        const fresh = ch.rounds.filter(rn => !seenChanged.has(`${gid}|${rn}`));
        for (const rn of ch.rounds) seenChanged.add(`${gid}|${rn}`);

        if (!fullRescanned.has(gid)) markFull.add(gid);

        // The teams whose games changed are the thread to follow. A regrade
        // takes a team's games OUT of this grade and creates them in another,
        // so the stored games in the changed rounds name exactly who moved.
        if (fresh.length) {
          for (const tid of RR.teamsInRounds({ byRound: w.byRound, roundNames: fresh })) expandTeams.add(tid);
        }
      }

      for (const tid of expandTeams) {
        for (const gid of (gradesOfTeam.get(tid) || [])) {
          if (workByGid.has(gid) && !fullRescanned.has(gid)) markFull.add(gid);
        }
      }

      const next = [];
      for (const gid of markFull) {
        fullRescanned.add(gid);
        const w  = workByGid.get(gid);
        if (!w) continue;
        const pf = RR.planGradeFull({ grade: w.grade, fetchedRoundNames: fetchedByGrade.get(gid) || new Set() });
        // ⚠ NAMED, NOT DROPPED. A round with no id — or a duplicate id — cannot
        // be fetched, and the previous planner discarded it silently inside
        // `add()`. That silence is what made the 26 withheld grades
        // undiagnosable from a log: the round was named as unaccounted for, and
        // nothing said it had never been asked for in the first place.
        if (pf.unfetchable.length) unfetchable.set(gid, pf.unfetchable);
        for (const f of pf.fetch) next.push({ w, f });
      }
      refresh.gradesFullRescanned = fullRescanned.size;
      queue = next;
    }

    if (unfetchable.size) {
      let shown = 0;
      console.log(`  ⚠ ${unfetchable.size} grade(s) hold round(s) that CANNOT be fetched (no round id, or a duplicate id).`
                + ` PlayHQ is asked by round id, so these rounds can never be checked:`);
      for (const [gid, names] of unfetchable) {
        if (shown++ >= 20) { console.log(`      … and ${unfetchable.size - 20} more grade(s)`); break; }
        console.log(`      grade ${gid}: ${names.join(', ')}`);
      }
      console.log(`::warning::nightly-crawl refresh: ${unfetchable.size} grade(s) hold unfetchable rounds`
                + ` — see the list above. Games in those rounds are never deletion candidates.`);
    }

    // ── Decide deletions, per grade, all-or-nothing ──────────────────────────
    const budget  = RR.makeDeletionBudget({ maxPerRun: MAX_DELETES_RUN, maxPerSeason: MAX_DELETES_SEASON });
    // A deletion nobody can look up is a deletion nobody can audit. PlayHQ's
    // game centre resolves on the game id alone and ignores the org/season/grade
    // slugs, so placeholder slugs give a working link from the id we already hold
    // (same construction as audit-nonfinal-games.js and build-alias-worklist.js).
    const gcUrl = (id) => `https://www.playhq.com/basketball-victoria/org/a/a/a/game-centre/${id}`;
    const toDelete = [];           // { sid, gid, rn, gameId }
    const fpNext   = new Map();    // gid → fingerprint entry, applied only at the end
    const regradedSeasons = new Set();

    for (const w of work) {
      const gid = w.grade.gradeId;
      const sid = w.grade.seasonId;
      const liveNames = new Set((w.grade.rounds || []).map(r => r && r.name).filter(Boolean));
      const roundHashes = Object.assign({}, (w.stored && w.stored.r) || {});
      const gradeDeletes = [];
      // `gradeClean` governs only whether the ROUND-LIST hash is written. A
      // round that failed or came back suspect says nothing about the other
      // rounds — deletions are scoped to (gid, rn), so each round's verdict
      // stands on its own fetch. But withholding `rl` keeps listChanged true
      // next run, which guarantees the unresolved round is looked at again
      // instead of sliding out of the ahead-window and never being re-asked.
      let gradeClean = true;

      // ⚠ JUDGE EVERY ROUND ACTUALLY FETCHED, NOT THE ORIGINAL PLAN.
      //
      // This read `w.plan.fetch.slice()` and was wrong the moment the wave scan
      // existed: the full rescan fetches the rest of the grade in a later wave
      // and those rounds are NOT in `plan.fetch`, so their results would have
      // been fetched, paid for, and then never examined — the residue in Rounds
      // 11-16 would have survived the very pass built to remove it, silently.
      // Caught by a fixture, not by reading. `fetchedByGrade` is the record of
      // what was actually asked, across every wave, and includes Phase 2's
      // current-round fetch because the map is seeded from `roundResults`.
      const judged = [...(fetchedByGrade.get(gid) || new Set())].map((rn) => {
        const r = (w.grade.rounds || []).find(x => x && x.name === rn);
        const planned = w.plan.fetch.find(f => f.roundName === rn);
        return { roundId: (r && r.id) || null, roundName: rn, reason: planned ? planned.reason : 'wave' };
      });

      // RULE 5, half one: everything PlayHQ returned anywhere in this grade. A
      // game that came back under ANY round is alive, whatever round it is now
      // in — which is the case a per-round comparison gets wrong when an
      // association re-draws or renames its rounds.
      const aliveGradeWide = new Set();
      const fetchedNames   = new Set();
      for (const f of judged) {
        const got = roundResults.get(`${gid}|${f.roundName}`);
        if (got === undefined) continue;
        fetchedNames.add(f.roundName);
        for (const id of got.ids) aliveGradeWide.add(id);
      }

      // Coverage is now an ASSERTION, not a gate — see the wave-scan note in the
      // fetch section. It still governs whether the ROUND-LIST hash is written:
      // a grade with a round we could not account for keeps `listChanged` true,
      // so it is fully rescanned again next run instead of settling into a
      // partial view. That is the self-healing behaviour for a grade holding an
      // unfetchable round, and it is bounded by how few such grades there are.
      const cov = RR.assessGradeCoverage({ rounds: w.grade.rounds, byRound: w.byRound, fetchedRoundNames: fetchedNames });
      if (!cov.fullyAccounted) {
        refresh.gradesUnaccounted++;
        gradeClean = false;
      }

      for (const f of judged) {
        const got = roundResults.get(`${gid}|${f.roundName}`);
        if (got === undefined) {
          // The fetch never succeeded. Rule 1: no deletion can come from it.
          refresh.roundsFailed++;
          gradeClean = false;
          continue;
        }
        if (f.roundId !== null) refresh.roundsFetched++;
        const d = RR.computeRoundDeletions({
          roundStillListed: liveNames.has(f.roundName),
          returnedIds:      got.ids,
          answered:         got.answered,
          storedGames:      w.byRound.get(f.roundName) || [],
        });
        if (d.suspectEmpty) {
          // Rule 3. Listed, we hold games for it, and it came back with nothing.
          refresh.suspectEmpty++;
          gradeClean = false;
          console.log(`  ⚠ SUSPECT: grade ${gid} round "${f.roundName}" is still in PlayHQ's round list`
                    + ` and we hold ${(w.byRound.get(f.roundName) || []).length} game(s) for it, but PlayHQ returned`
                    + ` NO PAYLOAD for it (not an empty round — no answer). Deleting nothing from that round.`);
          continue;
        }
        refresh.keptPlayed += d.keptPlayed;
        if (got.answered && got.ids.length === 0 && d.deletable.length) {
          console.log(`  · grade ${gid} round "${f.roundName}": PlayHQ returned the round with 0 games`
                    + ` and ${got.byes} bye(s) — the round exists and holds no fixtures, so the`
                    + ` ${d.deletable.length} stored game(s) are pre-regrade residue.`);
        }
        const live = RR.withholdLiveElsewhere(d.deletable, aliveGradeWide);
        refresh.movedNotDeleted += live.moved.length;
        for (const e of live.moved) {
          console.log(`  ↷ MOVED, not deleted: grade ${gid} game ${e.gameId} was in "${f.roundName}"`
                    + ` and PlayHQ returned it under another round of the same grade.`);
        }
        // PLAYHQ IS CANONICAL. The round was fetched, the fetch succeeded, the
        // game is unplayed and it came back under no round of this grade. It is
        // gone. No cross-round gate stands between that and the deletion any
        // more — see the wave-scan note above for why coverage is now a
        // property of the scan rather than a condition checked after it.
        for (const e of live.deletable) gradeDeletes.push({ sid, gid, rn: f.roundName, gameId: e.gameId });

        // Kept as an ASSERTION, never as a gate. If a grade yields deletions
        // while a live round holding unplayed games went unfetched, the wave
        // scan did not do its job and that is a defect to be seen, not a reason
        // to abandon the deletions. Printed with the reason the round was
        // missed, which the old gate never said.
        if (!cov.fullyAccounted && live.deletable.length) {
          const uf = unfetchable.get(gid) || [];
          const why = cov.unaccounted.map(rn => `${rn}${uf.includes(rn) ? ' (UNFETCHABLE)' : ''}`);
          console.log(`  ⚠ grade ${gid}: deleting ${live.deletable.length} game(s) from "${f.roundName}"`
                    + ` while round(s) ${why.slice(0, 6).join(', ')}${why.length > 6 ? ', …' : ''}`
                    + ` hold unplayed games and were not fetched. Expansion should have covered them.`);
        }
        roundHashes[f.roundName] = RR.hashIdSet(got.ids);
      }

      // A round PlayHQ has withdrawn from the list entirely. The round list came
      // from a gradeRounds call that succeeded (this grade is in normalGrades
      // only because it did), so rule 1 is satisfied without a fixture fetch.
      for (const rn of w.plan.vanished) {
        const d = RR.computeRoundDeletions({
          roundStillListed: false,
          returnedIds:      [],
          answered:         true,   // the ROUND LIST answered: this round is gone
          storedGames:      w.byRound.get(rn) || [],
        });
        refresh.keptPlayed += d.keptPlayed;
        const liveV = RR.withholdLiveElsewhere(d.deletable, aliveGradeWide);
        refresh.movedNotDeleted += liveV.moved.length;
        for (const e of liveV.moved) {
          console.log(`  ↷ MOVED, not deleted: grade ${gid} game ${e.gameId} was in withdrawn round "${rn}"`
                    + ` and PlayHQ returned it under a live round of the same grade.`);
        }
        // A round PlayHQ has withdrawn from the list entirely. The round list
        // came from a gradeRounds call that succeeded, which satisfies rule 1
        // without a fixture fetch. Gated on coverage until 2026-11-23; PlayHQ is
        // canonical and the wave scan covers the grade, so it no longer is.
        for (const e of liveV.deletable) gradeDeletes.push({ sid, gid, rn, gameId: e.gameId });
        delete roundHashes[rn];
        console.log(`  round withdrawn: grade ${gid} "${rn}" — ${d.deletable.length} unplayed game(s) to remove,`
                  + ` ${d.keptPlayed} played game(s) kept`);
      }

      if (gradeDeletes.length) {
        // ⚠ THE CAP IS A WARNING, NOT A GATE — CHANGED 2026-11-22 AND THE
        // REASONING MATTERS MORE THAN THE CODE.
        //
        // It was originally an abort: exceed the count, delete nothing, make a
        // human look. The first live contact showed why that is the wrong
        // instrument. MEBA published a fixture, regraded, and withdrew most of
        // it — 108 games in rounds 7-10 and several hundred more across rounds
        // 11-18, in ONE season, every one of them correctly identified. A flat
        // cap of 100 aborted the lot.
        //
        // Volume does not correlate with wrongness. A regrade withdrawing 400
        // fixtures is exactly as legitimate as one withdrawing 4, and a bug that
        // deleted 50 WRONG games would pass a cap of 100 untouched. So the cap
        // fired on the common legitimate case and would miss the dangerous one.
        // Worse, it left the cleanup permanently blocked until someone noticed
        // and raised a number by hand — on a job that runs unattended at 01:00.
        //
        // What actually catches wrongness is the semantic guards: unplayed only,
        // successful fetch only, a null payload is suspect, the grade-wide alive
        // set, and the full-coverage requirement. Those are kept and are strict.
        //
        // The cap existed because deletion was irreversible. It is not any more:
        // every deleted game is archived IN FULL to data/withdrawn-games/{sid}.json
        // before it is removed, and restore-withdrawn-games.js puts it back
        // verbatim. So the cap now warns, records and proceeds, and RUNAWAY_STOP
        // below is the only thing that still halts a run.
        const refused = budget.tryTake(sid, gradeDeletes.length);
        if (refused) {
          refresh.capWarnings++;
          console.log(`  ⚠ deletion cap exceeded — ${refused}`);
          console.log(`    Proceeding anyway: volume is not evidence of error, and every deletion is`);
          console.log(`    archived to data/withdrawn-games/${sid}.json and restorable. Raise the cap to silence this.`);
          console.log(`::warning::nightly-crawl refresh: ${refused} — proceeding, ${gradeDeletes.length} game(s) archived and deleted`);
        }
        toDelete.push(...gradeDeletes);

        // The one thing that still STOPS a run. Not a review gate — a runaway
        // stop, set far above any plausible regrade, for the case where the
        // world has changed in a way nothing here anticipated.
        if (toDelete.length > RUNAWAY_STOP) {
          refresh.abortedBy = `runaway stop: ${toDelete.length} deletions in one run exceeds --runaway-stop=${RUNAWAY_STOP}`;
          console.log(`\n  ⚠⚠ RUNAWAY STOP — ${refresh.abortedBy}`);
          console.log('  NOTHING will be deleted this run and no fingerprint will be written.');
          console.log(`::warning::nightly-crawl refresh: runaway stop at ${toDelete.length} deletions — nothing deleted`);
          break;
        }
      }

      // When to suspect the SEASON has been regraded, and therefore pay for a
      // discoverTeams call:
      //   · the round list genuinely changed since last night — the live signal;
      //   · or this grade's FIRST pass found rounds on disk that PlayHQ no longer
      //     lists, which is the same evidence arriving from history instead of
      //     from a diff. Restricted to the baseline so it fires once per grade:
      //     a withdrawn round that still holds a played game keeps showing up in
      //     `vanished` for ever, and without the mode test that would re-resolve
      //     the season every single night.
      if (w.plan.listChanged || (w.plan.mode === 'baseline' && w.plan.vanished.length)) {
        regradedSeasons.add(sid);
      }
      // `rl` only on a clean grade — see gradeClean above. Writing the
      // round-list hash is the claim "this grade's rounds are accounted for",
      // and a grade with an unresolved round has not earned it.
      fpNext.set(gid, {
        ...(gradeClean ? { rl: w.plan.roundListHash } : {}),
        r: roundHashes,
        at: new Date().toISOString(),
        ...(gradeClean ? {} : { incomplete: true }),
      });
    }

    // ── Apply ────────────────────────────────────────────────────────────────
    if (refresh.abortedBy) {
      console.log('  Deletions abandoned; field updates fetched above are kept, as they are the same');
      console.log('  overwrite Phase 2 performs on the current round and carry no risk of loss.');
    } else if (REFRESH_DRY_RUN) {
      console.log(`  [refresh-dry-run] would delete ${toDelete.length} game(s):`);
      for (const d of toDelete) console.log(`    sid=${d.sid} gid=${d.gid} round="${d.rn}" game=${d.gameId}  ${gcUrl(d.gameId)}`);
    } else {
      // ── ARCHIVE BEFORE DELETE ────────────────────────────────────────────
      // This is what makes a deletion reversible, and therefore what lets the
      // cap be a warning rather than a gate. The FULL stored entry is written
      // to data/withdrawn-games/{sid}.json — not the id, the whole object — so
      // restore-withdrawn-games.js can put it back byte-for-byte.
      //
      // data/, not reports/: reports/ is gitignored, a plain `git add` on an
      // ignored path matches nothing and EXITS ZERO, and the script then prints
      // its success line over a file that was never committed (T94). The archive
      // has to be committed or it does not exist to anything, so it goes
      // somewhere that is tracked by default.
      //
      // Keyed by game id and MERGED with what is already there, never replaced:
      // a season can be cleaned on more than one night and losing the first
      // night's record would be the same silent loss this exists to prevent.
      const archives = new Map();   // sid -> object
      const loadArchive = (sid) => {
        if (archives.has(sid)) return archives.get(sid);
        const f = path.join(ROOT, 'data', 'withdrawn-games', `${sid}.json`);
        let obj = {};
        if (fs.existsSync(f)) {
          // An unreadable archive THROWS. Overwriting it would destroy the
          // record of every earlier deletion, which is strictly worse than
          // stopping.
          try { obj = JSON.parse(fs.readFileSync(f, 'utf8')); }
          catch (e) { throw new Error(`round-refresh: data/withdrawn-games/${sid}.json exists but failed to parse (${e.message}) — refusing to overwrite the record of earlier deletions`); }
        }
        archives.set(sid, obj);
        return obj;
      };

      const runAt = new Date().toISOString();
      for (const d of toDelete) {
        const gfDel = loadGameFile(d.sid);
        const entry = gfDel.games[d.gameId];
        if (!entry) continue;                             // already gone; nothing to report

        // ── RESURRECTION DETECTOR ────────────────────────────────────────
        // An id ALREADY in the archive means we deleted this game before and it
        // has come back. That is the signature of two writers disagreeing about
        // the same game, and the likely other writer is discover-fixtures.js:
        // it resolves fixtures through `discoverTeamFixture`, a DIFFERENT query
        // from the `discoverFixtureByRound` this pass deletes on, and it runs
        // weekly from weekly-indexes.yml. If the two endpoints disagree, the
        // nightly deletes and the weekly restores, for ever, churning git and
        // leaving the stale fixture on the site anyway.
        //
        // This is cheap and exact, and it costs nothing when there is no loop.
        // The first-seen time is preserved so the age of the loop is readable.
        const arch = loadArchive(d.sid);
        const prior = arch[d.gameId];
        if (prior) {
          refresh.resurrected++;
          console.log(`  \u26a0 RESURRECTED: ${d.gameId} was deleted ${String(prior.firstDeletedAt || prior.at).slice(0, 19)}`
                    + ` and has come back \u2014 something re-added it. Deleting again.`);
        }
        arch[d.gameId] = {
          at: runAt,
          firstDeletedAt: (prior && (prior.firstDeletedAt || prior.at)) || runAt,
          deletions: ((prior && prior.deletions) || 0) + 1,
          gid: d.gid, rn: d.rn, reason: 'withdrawn-at-playhq', entry,
        };
        refresh.archived++;

        delete gfDel.games[d.gameId];
        markGameDirty(d.sid);
        intentionalDeletes.set(d.sid, (intentionalDeletes.get(d.sid) || 0) + 1);
        refresh.deleted++;
        // Every deletion is printed in full. A deletion nobody can find in a log
        // is a deletion nobody can audit.
        console.log(`  ✖ DELETED  sid=${d.sid}  gid=${d.gid}  round="${d.rn}"  game=${d.gameId}`
                  + `  d=${entry.d || '∅'}  ${entry.hn || '?'} v ${entry.an || '?'}`
                  + `\n             ${gcUrl(d.gameId)}`);
      }

      if (archives.size) {
        const dir = path.join(ROOT, 'data', 'withdrawn-games');
        fs.mkdirSync(dir, { recursive: true });
        for (const [sid, obj] of archives) {
          fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify(obj));
        }
        refreshStatePaths.push('data/withdrawn-games');
        console.log(`  Archived ${refresh.archived} deleted game(s) in full across ${archives.size} season file(s)`
                  + ` — restore with restore-withdrawn-games.js`);
      }
      console.log(`  Deletions applied: ${refresh.deleted}`);
    }

    // ── THE INVARIANT: one team, one grade, one day ──────────────────────────
    //
    // A team holding fixtures in two different grades on the same DATE is wrong
    // on its face. It is what a half-applied regrade leaves behind, and it is
    // the state the old coverage gate permitted while reporting itself healthy —
    // B13 Maroondah Magic 1 carried two Round 6 fixtures dated 13 Nov 2026, one
    // in Friday U13 Boys AR and one in Friday U13 Boys A, and nothing in the run
    // said so. Checked directly rather than inferred from deletion arithmetic,
    // because an invariant that is only ever implied is an invariant nobody can
    // see break.
    //
    // Reported, never acted on. Which of the two fixtures is the real one is a
    // question for PlayHQ, and the scan above is what answers it; this says the
    // cleanup has not finished.
    {
      const seasonsToCheck = new Set(work.map(w => w.grade.seasonId).filter(Boolean));
      let shown = 0;
      for (const sid of seasonsToCheck) {
        const gfC = loadGameFile(sid);
        const conflicts = RR.findSameDayGradeConflicts(gfC.games);
        if (!conflicts.length) continue;
        refresh.sameDayConflicts += conflicts.length;
        for (const c of conflicts) {
          if (shown++ >= 40) continue;
          console.log(`  ⚠ TWO GRADES ONE DAY: sid=${sid} team=${c.tid} date=${c.date}`
                    + ` grades=${c.grades.join(' + ')} games=${c.gameIds.join(' ')}`);
          for (const id of c.gameIds) console.log(`             ${gcUrl(id)}`);
        }
      }
      if (refresh.sameDayConflicts) {
        if (refresh.sameDayConflicts > shown) {
          console.log(`  … and ${refresh.sameDayConflicts - shown} more same-day conflict(s) not printed`);
        }
        console.log(`::warning::nightly-crawl refresh: ${refresh.sameDayConflicts} team-day(s) hold fixtures in`
                  + ` two or more grades on the same date — a regrade that has not finished cleaning up.`);
      } else {
        console.log('  Invariant OK: no team holds fixtures in two grades on the same day.');
      }
    }

    // ── A changed round list may mean the SEASON was regraded ────────────────
    // A regrade moves a team's games to a DIFFERENT grade. The old grade stops
    // returning them, which the pass above handles. The NEW grade only reaches
    // the nightly if it is in sports-index.json — and that list is written once
    // at season creation and refreshed on discover-seasons' Sunday sweep, which
    // reads the worklist discover-fixtures writes on Monday. That is a six-day
    // lag by construction, and it is long enough for a regraded team to look
    // empty here.
    //
    // So when a grade's round list changed, re-resolve that season's grades now,
    // sweep any the index lacks, and record them on the SAME worklist
    // discover-fixtures writes so the index is corrected permanently on Sunday.
    //
    // ⚠ THIS DOES NOT WRITE sports-index.json. discover-seasons.js owns that
    // file and this script has never written it — adding a second writer of the
    // season index to the most contended workflow in the repository is not worth
    // saving one sweep. The games land in games/bv keyed by season regardless of
    // whether the grade is in the index yet, so the DATA is correct tonight and
    // the bookkeeping catches up on schedule.
    const staleFound = [];
    if (!REFRESH_DRY_RUN && regradedSeasons.size) {
      console.log(`\n  Round list changed in ${regradedSeasons.size} season(s) — re-resolving their grades via discoverTeams`);
      for (const sid of regradedSeasons) {
        const { kind, data } = await gqlMain('discoverTeamsBySeason', Q_SEASON_TEAMS, { seasonId: sid });
        if (kind !== 'ok') {
          console.log(`    ${sid}: discoverTeams ${kind} — skipped, will be re-asked next run`);
          continue;
        }
        const liveGrades = new Map();
        for (const t of ((data && data.discoverTeams) || [])) {
          if (t && t.grade && t.grade.id) liveGrades.set(t.grade.id, t.grade.name || '');
        }
        if (!liveGrades.size) continue;
        const known = new Set(((sportIndex.seasons && sportIndex.seasons[sid] && sportIndex.seasons[sid].grades) || [])
          .map(g => String(g && g.id)));
        const unseen = [...liveGrades.keys()].filter(g => !known.has(String(g)));
        if (!unseen.length) continue;

        refresh.seasonsRegraded++;
        console.log(`    ${sid}: index holds ${known.size} grade(s), discoverTeams reports ${liveGrades.size}`
                  + ` — ${unseen.length} the index lacks`);
        staleFound.push({
          id: sid,
          name: (sportIndex.seasons && sportIndex.seasons[sid] && (sportIndex.seasons[sid].fullName || sportIndex.seasons[sid].name)) || null,
          indexGrades: known.size, liveGrades: liveGrades.size,
          missing: unseen.length, missingIds: unseen.slice(0, 50),
          seenAt: new Date().toISOString(),
        });

        // Sweep the new grades now so tonight's fixtures land rather than waiting
        // for Sunday. Nothing stored under a brand-new grade, so there is nothing
        // to delete — this is additive only.
        for (const newGid of unseen) {
          const gr = await gqlMain('gradeRounds', Q_GRADE_ROUNDS, { gradeID: newGid });
          if (gr.kind !== 'ok' || !gr.data || !gr.data.discoverGrade) continue;
          const g = gr.data.discoverGrade;
          if (g.hideScores) continue;
          const newRounds = g.rounds || [];
          const hashes = {};
          let allOk = true;
          for (const r of newRounds) {
            if (!r || !r.id) continue;
            const fr = await gqlMain('discoverFixtureByRound', Q_FIXTURE_BY_ROUND, { roundID: r.id });
            if (fr.kind !== 'ok') { allOk = false; continue; }
            const { needsSpectator, forfeitGameIds } = applyRoundFixtures(fr.data, g.id, g.name || '', r.name, !!r.current);
            allNeedsSpectator.push(...needsSpectator);
            allNewForfeitIds.push(...forfeitGameIds);
            const ids = ((fr.data && fr.data.discoverFixtureByRound && fr.data.discoverFixtureByRound.games) || [])
              .map(x => x && x.id).filter(Boolean);
            hashes[r.name] = RR.hashIdSet(ids);
          }
          refresh.newGradesSwept++;
          console.log(`      swept new grade ${newGid} "${g.name || ''}" — ${newRounds.length} round(s)`);
          if (allOk) fpNext.set(g.id, { rl: RR.hashRoundList(newRounds), r: hashes, at: new Date().toISOString() });
        }
      }
    }

    // ── Persist the fingerprints ─────────────────────────────────────────────
    // Only on a run that did not abort, and only for grades that completed
    // cleanly. A fingerprint is a claim that we have seen this grade's rounds;
    // writing one for a grade we failed to read would stop the next run asking.
    if (!refresh.abortedBy && !REFRESH_DRY_RUN && !DRY_RUN) {
      for (const [gid, entry] of fpNext) fp.grades[gid] = entry;
      // Grades that are no longer active must leave the file or it grows without
      // bound and eventually trips its own size ceiling on a healthy repository.
      // ⚠ PRUNE ONLY ON A FULL-REPOSITORY RUN. `normalGrades` holds the grades
      // THIS RUN considered, and on a --season run that is one season's worth.
      // Pruning against it would delete every other grade's fingerprint and
      // force a repo-wide re-baseline — ~7,800 grades, ten nights of work — as
      // a silent side effect of a one-season diagnostic. Found when the first
      // production dry run made a targeted run the obvious next step; the dry
      // run itself writes no fingerprint, so nothing was damaged.
      //
      // A partial run must never clear a repository-wide record. Same rule
      // discover-fixtures.js applies to the stale-grade worklist and
      // build-club-index.js to clubs/, for the same reason.
      //
      // Grades swept above are active too, even though they were not in the
      // season index when Phase 1 built its list — that is precisely why they
      // were swept. Without them the prune would delete the fingerprint written
      // seconds earlier and the grade would baseline again every night until
      // discover-seasons catches up on Sunday.
      let pruned = 0;
      if (TARGET_SEASON) {
        console.log('  Fingerprint prune SKIPPED — this run covered one season, and a partial run'
                  + ' must not clear a repository-wide record.');
      } else {
        const activeIds = new Set([...normalGrades.map(g => g.gradeId), ...fpNext.keys()]);
        pruned = RR.pruneFingerprints(fp, activeIds);
      }
      const bytes = RR.saveFingerprints(ROOT, fp);
      refreshStatePaths.push('data/round-fingerprints.json');
      console.log(`  Fingerprints: ${fpNext.size} written, ${pruned} pruned, ${Object.keys(fp.grades).length} total`
                + ` (${(bytes / 1024).toFixed(0)} KB)`);

      // The stale-grade worklist. ⚠ MERGE, NEVER REPLACE, and by season id —
      // identical semantics to discover-fixtures.js, which is the other writer of
      // this file. A partial run must not clear a repository-wide worklist: a
      // --season=<id> run of discover-fixtures once overwrote it with its own
      // one-season view and took `count 12, seasonsScanned 188` to
      // `count 0, seasonsScanned 1`. Entries for seasons this run did not look at
      // are carried through untouched; an entry with no id cannot be matched
      // either way, so it is KEPT rather than dropped on a guess.
      if (staleFound.length) {
        const STALE_FILE = path.join(ROOT, 'data', 'stale-grade-seasons.json');
        const scanned = new Set(staleFound.map(x => x.id));
        let carried = [];
        try {
          const prev = JSON.parse(fs.readFileSync(STALE_FILE, 'utf8'));
          if (prev && Array.isArray(prev.seasons)) {
            carried = prev.seasons.filter(x => !(x && x.id && scanned.has(x.id)));
          }
        } catch (e) {
          if (fs.existsSync(STALE_FILE)) {
            console.log(`  ⚠ stale-grade-seasons.json could not be parsed (${e.message}) — writing this run's findings only;`
                      + ` entries for seasons this run did not scan are LOST.`);
          }
        }
        const merged = carried.concat(staleFound);
        fs.mkdirSync(path.dirname(STALE_FILE), { recursive: true });
        fs.writeFileSync(STALE_FILE, JSON.stringify({
          generatedAt:    new Date().toISOString(),
          scope:          'nightly-crawl round refresh (regraded seasons only)',
          seasonsScanned: staleFound.length,
          carriedForward: carried.length,
          count:          merged.length,
          seasons:        merged,
        }, null, 2));
        refreshStatePaths.push('data/stale-grade-seasons.json');
        console.log(`  stale-grade worklist: ${staleFound.length} from this run + ${carried.length} carried forward = ${merged.length}`);
      }
    }

    if (refresh.abortedBy && FAIL_ON_DELETE_CAP) {
      throw new Error(`nightly-crawl refresh: ${refresh.abortedBy} (--fail-on-delete-cap)`);
    }
    console.log('');
  }

  // Update forfeit-games.json with any newly detected forfeits
  if (allNewForfeitIds.length > 0 && !DRY_RUN) {
    const forfeitFile = path.join(ROOT, 'data', 'forfeit-games.json');
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(forfeitFile, 'utf8')); } catch (_) {}
    const merged = [...new Set([...existing, ...allNewForfeitIds])].sort();
    fs.writeFileSync(forfeitFile, JSON.stringify(merged));
    console.log(`  Updated forfeit-games.json: +${allNewForfeitIds.length} new (${merged.length} total)`);
  }

  // Deduplicate — same game may appear in current + previous round fetches
  const seenGameIds     = new Set();
  const needsSpectator  = allNeedsSpectator.filter(({ gameId }) => {
    if (seenGameIds.has(gameId)) return false;
    seenGameIds.add(gameId);
    return true;
  });

  console.log(`  Games needing spectator: ${needsSpectator.length}`);

  // Final Phase 2 flush
  const flushedGames = flushGameFiles();
  if (flushedGames > 0 || needsSpectator.length > 0) {
    await gitCommit(
      `nightly-crawl: ${needsSpectator.length} games queued, ${flushedGames} season files updated`,
      ['games/', 'data/forfeit-games.json']
    );
  }
  console.log();

  // ── Phase 3: Spectator + player stat updates ──────────────────────────────────
  console.log(`Phase 3/4 — Spectator box scores (${needsSpectator.length} games)…`);

  // playerDeltas: Map<uuid, { name, deltas: [{seasonId, pts, pt3, fouls}] }>
  const playerDeltas = new Map();
  let spectatorHits = 0, spectatorMiss = 0, p3Done = 0;

  const p3Tasks = needsSpectator.map(({ gameId, seasonId, rn, gradeId, gradeName, homeTid, awayTid, homeScore, awayScore }) => async () => {
    const game = await gqlSpectator(gameId);
    p3Done++;
    if (p3Done % 50 === 0 || p3Done === needsSpectator.length)
      process.stdout.write(`  ${p3Done}/${needsSpectator.length}  hits: ${spectatorHits}  misses: ${spectatorMiss}\r`);

    if (!game?.statistics) {
      spectatorMiss++;
      return;
    }
    spectatorHits++;

    const homePlayers = parseSpectatorPlayers(game.statistics?.home?.players);
    const awayPlayers = parseSpectatorPlayers(game.statistics?.away?.players);
    const allPlayers  = [...homePlayers, ...awayPlayers];

    // Collect player deltas for later batch processing
    const isFinalsGame = isFinal(rn);
    const isGF         = isGrandFinal(rn);
    const homeWon      = (homeScore !== null && awayScore !== null) ? homeScore > awayScore : null;

    for (const p of allPlayers) {
      if (!p.profileID) continue;
      if (!playerDeltas.has(p.profileID)) {
        playerDeltas.set(p.profileID, { name: p.name, deltas: [] });
      }
      const isHomePlayer = homePlayers.some(hp => hp.profileID === p.profileID);
      const playerTid    = isHomePlayer ? homeTid : awayTid;
      const playerWon    = homeWon === null ? null : (isHomePlayer ? homeWon : !homeWon);
      playerDeltas.get(p.profileID).deltas.push({
        seasonId, gameKey: gameId, pts: p.pts, pt3: p.pt3, fouls: p.fouls,
        isFinalsGame, isGF, playerTid, playerWon,
        gradeId, gradeName,
      });
    }

    // Mark spc:1 and update p[] on the game entry — spc prevents re-processing.
    // p[].id is truncated to a 13-char prefix (uuid-prefix.cjs TRUNC_LEN; the
    // original 2026-07-10 UUID-storage migration used 10, later widened to 13)
    // — this field is only ever an attendee list keyed by id, never resolved
    // back to a player file from within this script, so it's safe to write
    // truncated here. playerDeltas above (used for player-file writes) keeps
    // p.profileID FULL-length throughout — only the on-disk game file field
    // is shortened.
    const gf = loadGameFile(seasonId);
    if (gf.games[gameId] && !DRY_RUN) {
      if (allPlayers.length > 0) {
        gf.games[gameId].p = allPlayers.map(p => ({
          id: truncateUuid(p.profileID),
          // n omitted — name not needed in p[], profileID is the key
        }));
      }
      gf.games[gameId].spc = 1;
      markGameDirty(seasonId);
    }
  });

  await runPool(p3Tasks, CONCURRENCY_SPECTATOR);
  console.log(`  ${needsSpectator.length}/${needsSpectator.length} done`
            + `  hits: ${spectatorHits}  misses: ${spectatorMiss}`);
  console.log(`  Players with deltas: ${playerDeltas.size}`);

  // Flush game spc + p[] updates
  const flushedSpc = flushGameFiles();
  if (flushedSpc > 0) {
    await gitCommit(`nightly-crawl: spc+p[] written for ${spectatorHits} games`, ['games/']);
  }
  console.log();

  // ── api-canonical resolution (2026-07-16) ─────────────────────────────────────
  // p.profileID is a SPECTATOR-namespace id; player files and the index are
  // keyed by api id post-migration. Re-key playerDeltas through the
  // alias-aware resolver ONCE here — everything downstream (byShard, index
  // lookups, genuinelyNew, Phase 4 delta lookups) then operates on canonical
  // ids. Unknown full ids pass through unchanged (genuinely new players get
  // stubbed under their observed id; the matrix's recovery discovers and
  // persists the real api id later). Two observed ids resolving to the same
  // person have their deltas concatenated, never summed.
  {
    const canonicalDeltas = new Map();
    let redirected = 0;
    for (const [origId, info] of playerDeltas) {
      const key = resolveToFullUuid(origId, ROOT); // full ids never resolve to null
      if (key !== origId) redirected++;
      const existing = canonicalDeltas.get(key);
      if (existing) existing.deltas.push(...info.deltas);
      else canonicalDeltas.set(key, info);
    }
    playerDeltas.clear();
    for (const [k, v] of canonicalDeltas) playerDeltas.set(k, v);
    if (redirected > 0) console.log(`  Alias-resolved ${redirected} spectator id(s) to canonical api ids`);
  }

  // ── Phase 3 cont.: Clear statsChecked for all players in tonight's games ───────
  // All player stat computation is owned by the matrix (fetch-profile-stats.js).
  // Nightly's only job here is to clear statsChecked for players who appeared in
  // any completed game tonight, so the matrix knows to re-fetch them.

  console.log('Phase 3/4 (cont.) — Clearing statsChecked for updated players…');

  let statsCleared       = 0;
  let playersSinceCommit = 0;
  const genuinelyNew     = new Map();
  const affectedShards   = new Set();

  // Group by shard for efficient index reads
  const byShard = new Map();
  for (const [uuid, info] of playerDeltas) {
    const shard = playerShard(uuid);
    if (!byShard.has(shard)) byShard.set(shard, []);
    byShard.get(shard).push({ uuid, ...info });
  }

  let newRegsAdded = 0;

  for (const [shard, entries] of byShard) {
    const index = readPlayerIndex(shard);

    for (const { uuid, name, deltas } of entries) {
      if (!index[uuid]) {
        // New player — defer to Phase 4 for stubbing
        genuinelyNew.set(uuid, name || `Player #${uuid.slice(0, TRUNC_LEN)}`);
        continue;
      }

      const player = readPlayer(uuid);
      if (!player) continue;

      if (!player.sports)            player.sports = {};
      if (!player.sports.Basketball) player.sports.Basketball = {};
      const bk = player.sports.Basketball;

      // ── Reg discovery: add missing season/reg entries for existing players ──
      // The matrix writes stats into existing regs but never adds new ones.
      // If a player appeared in a game for a season/team not in their file,
      // add the stub reg now so the matrix has somewhere to write stats to.
      let playerModified = false;
      for (const { seasonId, playerTid, gradeId, gradeName } of deltas) {
        if (!seasonId || !playerTid || !gradeId) continue;

        // Find or create the season entry
        let season = (player.seasons || []).find(s => s.sid === seasonId);
        if (!season) {
          if (!player.seasons) player.seasons = [];
          const si = sportIndex.seasons?.[seasonId];
          season = {
            sid:   seasonId,
            sn:    si?.name    || seasonId,
            club:  si?.orgName || '',
            // sport omitted — always Basketball for this repo
            regs:  [],
          };
          player.seasons.push(season);
          playerModified = true;
        }

        // Find or create the reg entry
        const hasReg = (season.regs || []).some(r => r.tid === playerTid && r.gid === gradeId);
        if (!hasReg) {
          if (!season.regs) season.regs = [];
          season.regs.push({
            tid:   playerTid,
            tn:    '',        // team name — not available from spectator; matrix will fill stats
            gid:   gradeId,
            gn:    gradeName || '',
            // age omitted — derivable from team-lookup
            div:   null,
            stats: {},
          });
          // Update index history
          if (!index[uuid].history) index[uuid].history = {};
          if (!index[uuid].history[seasonId]) index[uuid].history[seasonId] = [];
          if (!index[uuid].history[seasonId].includes(playerTid)) {
            index[uuid].history[seasonId].push(playerTid);
          }
          playerModified = true;
          newRegsAdded++;
        }
      }

      if (playerModified) {
        if (!DRY_RUN) {
          writePlayer(uuid, player);
          writePlayerIndex(shard, index);
        }
      }

      // Clear statsChecked — matrix will re-fetch and recompute all stats
      if (bk.statsChecked !== undefined) {
        delete bk.statsChecked;
        player.updatedAt = new Date().toISOString();
        if (!DRY_RUN) writePlayer(uuid, player);
        statsCleared++;
        playersSinceCommit++;
        affectedShards.add(uuid.slice(0, 2));

        if (playersSinceCommit >= COMMIT_EVERY_PLAYERS) {
          await gitCommit(`nightly-crawl: statsChecked cleared (${statsCleared} so far)`, ['players/']);
          playersSinceCommit = 0;
        }
      } else {
        // No statsChecked yet — still needs matrix (new stub or cleared earlier)
        affectedShards.add(uuid.slice(0, 2));
      }
    }
  }
  if (newRegsAdded > 0) console.log(`  New regs added to existing players: ${newRegsAdded}`);
  console.log(`  statsChecked cleared: ${statsCleared}  new regs: ${newRegsAdded}  shards affected: ${affectedShards.size}`);

  // Write needs-matrix-shards.json for the nightly workflow to trigger targeted matrix
  if (affectedShards.size > 0) {
    console.log(`  Shards needing matrix re-fetch: ${[...affectedShards].sort().join(', ')}`);
    if (!DRY_RUN) {
      fs.writeFileSync(
        path.join(ROOT, 'needs-matrix-shards.json'),
        JSON.stringify([...affectedShards].sort())
      );
    }
  } else {
    const shardsFile = path.join(ROOT, 'needs-matrix-shards.json');
    if (fs.existsSync(shardsFile) && !DRY_RUN) fs.unlinkSync(shardsFile);
  }
  console.log();

  // ── Phase 4: Stub new players ────────────────────────────────────────────────
  console.log(`Phase 4/4 — New player stubs (${genuinelyNew.size})…`);

  const now       = new Date().toISOString();
  const newByShard = new Map();
  for (const [uuid, name] of genuinelyNew) {
    const shard = playerShard(uuid);
    if (!newByShard.has(shard)) newByShard.set(shard, []);
    newByShard.get(shard).push({ uuid, name });
  }

  let stubbed = 0;
  for (const [shard, entries] of newByShard) {
    const index        = readPlayerIndex(shard);
    let   indexChanged = false;

    for (const { uuid, name } of entries) {
      if (index[uuid]) continue;  // guard — another process may have added it

      // Compute initial stats from the deltas we already collected
      const deltas = playerDeltas.get(uuid)?.deltas || [];
      const bk     = { maxGamePTS: 0, maxGameThreePt: 0, foulOuts: {} };

      // Build seasons/regs from the SAME deltas, using the SAME construction
      // as the existing-player path above (Phase 3 cont., L945-986). Previously
      // new stubs got `seasons: []` — no tid/gid at all — which meant a
      // namespace-mismatch recovery attempt (fetch-profile-stats.js) had
      // nothing to give gradePlayerStatistics for a brand-new player. This
      // also means Phase 3-cont's "New player -> defer to Phase 4" path no
      // longer silently loses that first night's season/team/history data.
      const seasons = [];
      for (const d of deltas) {
        const { seasonId, pts, pt3, fouls, playerTid, gradeId, gradeName } = d;
        if (pts > bk.maxGamePTS)     bk.maxGamePTS     = pts;
        if (pt3 > bk.maxGameThreePt) bk.maxGameThreePt = pt3;
        if (fouls >= 5) bk.foulOuts[seasonId] = (bk.foulOuts[seasonId] || 0) + 1;

        if (!seasonId || !playerTid || !gradeId) continue;
        let season = seasons.find(s => s.sid === seasonId);
        if (!season) {
          const si = sportIndex.seasons?.[seasonId];
          season = { sid: seasonId, sn: si?.name || seasonId, club: si?.orgName || '', regs: [] };
          seasons.push(season);
        }
        if (!season.regs.some(r => r.tid === playerTid && r.gid === gradeId)) {
          season.regs.push({ tid: playerTid, tn: '', gid: gradeId, gn: gradeName || '', div: null, stats: {} });
        }
      }

      const stub = {
        uuid, name,
        sports:    { Basketball: bk },
        seasons,
        teams:     [],
        spectatorIds: [uuid.slice(0, TRUNC_LEN)],
        updatedAt: now,
      };
      writePlayer(uuid, stub);
      writeAliasIdentity(uuid);

      // History — same shape as the existing-player path (season -> unique tids).
      const history = {};
      for (const season of seasons) {
        history[season.sid] = [...new Set(season.regs.map(r => r.tid))];
      }
      index[uuid]    = { name, history };
      indexChanged   = true;
      stubbed++;
    }

    if (indexChanged) writePlayerIndex(shard, index);
  }
  console.log(`  Stubbed: ${stubbed}`);
  console.log();

  // Final commit — remaining player + stub writes
  await gitCommit(
    `nightly-crawl: ${statsCleared} statsChecked cleared, ${stubbed} new players stubbed`,
    ['players/', 'needs-matrix-shards.json']
  );

  // The refresh's own state files. Committed here rather than inside Phase 2R so
  // the fingerprints land in the same run as the game deletions they describe —
  // a fingerprint that says "this round is settled" must never be on main while
  // the deletion it justifies is not.
  if (refreshStatePaths.length) {
    await gitCommit(`nightly-crawl: round fingerprints (${refresh.deleted} withdrawn game(s) deleted)`, refreshStatePaths);
  }

  // ── Status file ───────────────────────────────────────────────────────────────
  // gamesRemaining is the count the workflow uses to decide whether to self-trigger.
  // Only a genuinely bailed phase is resumable. spectatorMiss = FINAL games the
  // spectator endpoint has no data for (blocked/private/legacy) — that is 'empty',
  // NOT 'remaining'. Folding it in here made every run look incomplete and drove an
  // endless retrigger that re-fetched all rounds just to rediscover the same dead games.
  const gamesRemaining = p1.remaining + p2.remaining;

  if (!DRY_RUN) {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      gamesRemaining,
      gamesProcessed:  spectatorHits,
      statsCleared,
      stubbed,
      completed:       gamesRemaining === 0,
      refreshDeleted:  refresh.deleted,
      refreshCapHit:   !!refresh.abortedBy,
      timestamp:       new Date().toISOString(),
    }));
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('─'.repeat(50));
  console.log(`  Seasons:           ${seasons.length}`);
  console.log(`  Normal grades:     ${normalGrades.length}`);
  console.log(`  Rounds fetched:    ${roundQueue.length}`);
  console.log(`  P1 grades:         ok=${p1.counts.ok} blocked=${p1.counts.blocked} transient=${p1.counts.transient} dropped=${p1.counts.dropped} left=${p1.remaining}`);
  console.log(`  P2 fixtures:       ok=${p2.counts.ok} blocked=${p2.counts.blocked} transient=${p2.counts.transient} dropped=${p2.counts.dropped} left=${p2.remaining}`);
  console.log(`  Spectator queued:  ${needsSpectator.length}`);
  console.log(`  Spectator hits:    ${spectatorHits}  misses: ${spectatorMiss}`);
  console.log(`  statsChecked cleared: ${statsCleared}`);
  console.log(`  New players:       ${stubbed}`);
  console.log(`  Refresh grades:    ${refresh.gradesConsidered} (${refresh.baselined} baseline, ${refresh.incremental} incremental)`
            + `  rounds ok=${refresh.roundsFetched} failed=${refresh.roundsFailed}`);
  if (refresh.resurrected) {
    console.log(`  ⚠⚠ ${refresh.resurrected} game(s) RESURRECTED — previously deleted by this pass and re-added by something else.`);
    console.log(`     The likely culprit is discover-fixtures.js (weekly-indexes.yml), which resolves fixtures through`);
    console.log(`     discoverTeamFixture while this pass deletes on discoverFixtureByRound. Two writers disagreeing about`);
    console.log(`     the same games is a delete/re-add loop, not a transient. Investigate before the next weekly sweep.`);
    console.log(`::warning::nightly-crawl refresh: ${refresh.resurrected} previously-deleted game(s) have been re-added by another writer`);
  }
  console.log(`  Refresh archived:  ${refresh.archived} game(s) written to data/withdrawn-games/ before deletion`
            + `${refresh.capWarnings ? `  (advisory cap exceeded ${refresh.capWarnings}x — proceeded)` : ''}`);
  console.log(`  Refresh moved-not-deleted: ${refresh.movedNotDeleted}`
            + `  grades fully rescanned on change: ${refresh.gradesFullRescanned}`
            + `  rounds fetched: ${refresh.roundsQueued}`);
  console.log(`  Refresh coverage gaps: ${refresh.gradesUnaccounted} grade(s) had a live unplayed round left unfetched`
            + ` (reported, no longer blocking deletions)`
            + `${refresh.wavesExhausted ? `  ⚠ EXPANSION DID NOT SETTLE: ${refresh.wavesExhausted} round(s) left` : ''}`);
  console.log(`  Refresh invariant: ${refresh.sameDayConflicts} team-day(s) holding two grades on one date`
            + `${refresh.sameDayConflicts ? '  ⚠ regrade cleanup incomplete' : ''}`);
  console.log(`  Refresh deletions: ${refresh.deleted}  kept-because-played: ${refresh.keptPlayed}`
            + `  suspect-empty rounds: ${refresh.suspectEmpty}  unscopeable (no rn): ${refresh.noRoundSkipped}`);
  if (refresh.baselineDeferred) console.log(`  Baseline backlog:  ${refresh.baselineDeferred} grade(s) waiting for a later run`);
  if (refresh.abortedBy)        console.log(`  ⚠ DELETIONS ABORTED: ${refresh.abortedBy}`);
  console.log(`  Games remaining:   ${gamesRemaining}`);
  console.log(`  Elapsed:           ${elapsed}s`);
  console.log('─'.repeat(50));
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing was written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
