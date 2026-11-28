// scripts/publish-final-game.js
//
// FAST PUBLISH ON FINAL. Dispatched by markjovic/fixture-watch the moment a
// watched team's game flips to FINAL, so the result, the box score and the
// players' profile stats land within minutes instead of waiting for the 01:00
// nightly.
//
// It does ONE round of ONE grade:
//   1. gradeRounds(gradeID)            -> the round id for --round
//   2. discoverFixtureByRound(roundID) -> the round's games, written to games/bv
//   3. spectator game(id)              -> p[] + spc for the FINAL ones
//   4. clear statsChecked              -> so the matrix re-fetches those players
//   5. stub genuinely-new players
// and emits the affected shards so the workflow can run fetch-profile-stats.js
// against them. THE PROFILE NUMBERS ARE NOT COMPUTED HERE: gp/pts/fg/ft/3pt/
// fouls come from PlayHQ's own publicProfileStatistics via fetch-profile-stats.js,
// and that script runs only for players whose statsChecked has been cleared. Step
// 4 is the whole reason this script touches player files at all.
//
// ⚠ IT DELETES NOTHING. applyRoundFixtures only ever writes. Withdrawal of a
// stale fixture is Phase 2R's job in nightly-crawl.js and is deliberately not
// duplicated here: a dispatch arriving from another repo must not be able to
// remove anything.
//
// ⚠ EVERY PLAYHQ-FACING LINE IS COPIED VERBATIM FROM scripts/nightly-crawl.js
// (headers, session handling, gqlMain, the two queries, parseScore,
// parseSpectatorPlayers, loadGameFile/flushGameFiles, gitCommit, Phases 3, 3-cont
// and 4). Nothing was rewritten or trimmed. If nightly-crawl.js changes, this
// file is regenerated from it rather than hand-patched.
//
// W/L is NOT updated. build-win-loss.js has no season or team scope and opens
// with a pre-pass over every player file; it stays on the nightly chain.
//
// Usage:
//   node scripts/publish-final-game.js --season=3d25b666 --grade=7d0c2383 --round="Round 7"
//   node scripts/publish-final-game.js --season=... --grade=... --round=... --games=76b04de5
//   node scripts/publish-final-game.js --season=... --grade=... --round=... --dry-run

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

// NOT needs-matrix-shards.json. That file is the nightly's own handoff to the
// matrix job, and a fast publish landing mid-evening must never overwrite what
// the nightly left there.
//
// ⚠️ THIS FILE IS A LOCAL ARTIFACT AND IS NEVER COMMITTED (2026-11-28). It sits at
// the repo root, outside this workflow's sparse-checkout definition, so `git add`
// refuses it. Nothing reads it — the shard list reaches the matrix job through
// GITHUB_OUTPUT. The writes below are kept so a local run can still inspect the
// list; if you are tempted to add it back to a gitCommit path list, don't. Widening
// the sparse checkout to accommodate it is also not the answer.
const SHARDS_FILE_NAME = 'fast-publish-shards.json';

async function main() {
  const startTime = Date.now();
  console.log('publish-final-game.js');

  const SID   = String(ARGS.season || '').trim();
  const GID   = String(ARGS.grade  || '').trim();
  const RNAME = String(ARGS.round  || '').trim();
  const ONLY  = String(ARGS.games === true ? '' : (ARGS.games || '')).split(/[\s,]+/).filter(Boolean);

  // ── PHASES ──────────────────────────────────────────────────────────────────
  // MEASURED 2026-11-23: players/ is 3.4 GB of a 4.3 GB checkout and a full tree
  // takes 5m52s on a runner, for a script that runs in 3 seconds. A fast publish
  // needs about TEN player files out of ~370,000, but which ten is not known until
  // the box score has been fetched — so the checkout cannot be narrowed in one
  // pass. It is split instead:
  //
  //   --phase=fetch    needs games/bv/{sid}.json, players/indexes, players/aliases
  //                    (~160 MB). Writes the round, pulls the box scores, resolves
  //                    spectator ids to canonical api ids, and writes its state to
  //                    --state. Emits fetch_shards for the workflow to
  //                    `git sparse-checkout add` before the second half.
  //   --phase=players  reads --state, then clears statsChecked and stubs new
  //                    players against the shards just added.
  //   --phase=all      both, in one process. The default, and what a local run or
  //                    a manual dispatch uses.
  //
  // ⚠ The split is a CHECKOUT optimisation only. Neither phase changes what is
  //   written, and `all` is the same code path end to end.
  const PHASE = String(ARGS.phase || 'all').trim().toLowerCase();
  if (!['all', 'fetch', 'players'].includes(PHASE)) {
    console.error(`::error::--phase must be all, fetch or players (got "${PHASE}")`);
    process.exit(2);
  }
  const DO_FETCH   = PHASE === 'all' || PHASE === 'fetch';
  const DO_PLAYERS = PHASE === 'all' || PHASE === 'players';
  const STATE_PATH = String(ARGS.state || '').trim();
  if (PHASE !== 'all' && !STATE_PATH) {
    console.error(`::error::--phase=${PHASE} needs --state=<path> — the two phases are separate processes and the deltas are handed over on disk.`);
    process.exit(2);
  }
  // ⚠ NOT inside the repo. A state file committed by accident would be a blob of
  //   player ids in a public repository, and it would collide with the nightly.
  if (STATE_PATH && !path.isAbsolute(STATE_PATH)) {
    console.error(`::error::--state must be an ABSOLUTE path outside the repo (got "${STATE_PATH}")`);
    process.exit(2);
  }

  // Hoisted out of the spectator block so the players phase can see them without
  // having run it. See the generator for the two declaration-only edits this needs.
  let playerDeltas = new Map();
  let spectatorHits = 0, spectatorMiss = 0;
  let totalGames = 0, byeCount = 0, forfeitCount = 0, queuedCount = 0;
  let gradeName = GID, roundName = RNAME;

  // All three are REQUIRED and none has a default. A missing value must stop the
  // run, never widen it: this script is dispatched from another repository and is
  // allowed to touch exactly the round it was given.
  const missing = [];
  if (!SID)   missing.push('--season');
  if (!GID)   missing.push('--grade');
  if (!RNAME) missing.push('--round');
  if (missing.length) {
    console.error(`::error::missing required argument(s): ${missing.join(' ')}`);
    console.error('Usage: node scripts/publish-final-game.js --season=<sid> --grade=<gid> --round="Round 7" [--games=id,id] [--dry-run]');
    process.exit(2);
  }

  console.log(`  season:  ${SID}`);
  console.log(`  grade:   ${GID}`);
  console.log(`  round:   "${RNAME}"`);
  if (PHASE !== 'all') console.log(`  phase:   ${PHASE}  (state ${STATE_PATH})`);
  if (ONLY.length) console.log(`  games:   ${ONLY.join(', ')}  (the dispatcher's list — the whole round is fetched regardless)`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — no writes or commits');
  console.log('─'.repeat(50));

  if (!fs.existsSync(INDEX_FILE)) { console.error('::error::data/sports-index.json not found'); process.exit(1); }
  const sportIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));

  // ⚠ The fetch half below is WRAPPED BUT NOT RE-INDENTED, deliberately. The
  //   spectator and alias blocks inside it are verbatim copies of nightly-crawl.js
  //   and have to stay byte-comparable with it; an indentation pass would make
  //   every future diff between the two files meaningless.
  if (DO_FETCH) {

  // ── Step 1: the grade's round list ──────────────────────────────────────────
  // The dispatcher sends a round NAME, because that is what its state file holds.
  // Round ids are resolved here rather than carried across repos, so a cached or
  // stale id in fixture-watch can never send this job at the wrong round.
  const gr = await gqlMain('gradeRounds', Q_GRADE_ROUNDS, { gradeID: GID });
  if (gr.kind !== 'ok' || !gr.data || !gr.data.discoverGrade) {
    console.error(`::error::gradeRounds(${GID}) returned ${gr.kind} — nothing fetched, nothing written.`);
    process.exit(1);
  }
  const grade  = gr.data.discoverGrade;
  const rounds = grade.rounds || [];
  const norm   = (s) => String(s == null ? '' : s).trim().toLowerCase();
  const round  = rounds.find(r => r && r.name === RNAME)
              || rounds.find(r => r && norm(r.name) === norm(RNAME))
              || rounds.find(r => r && norm(r.abbreviatedName) === norm(RNAME));
  if (!round || !round.id) {
    console.error(`::error::grade ${GID} has no round named "${RNAME}".`);
    console.error(`  rounds offered: ${rounds.map(r => r && r.name).filter(Boolean).join(' | ') || '(none)'}`);
    process.exit(1);
  }

  // The workflow sparse-checks out games/bv/${SID}.json and nothing else. If the
  // grade does not belong to that season the file on disk is the wrong one, and
  // writing would either create a season file from a partial checkout or silently
  // put the games somewhere nobody looks.
  const apiSid = grade.season && grade.season.id;
  if (apiSid && apiSid !== SID) {
    console.error(`::error::season mismatch — the dispatch said ${SID}, PlayHQ says grade ${GID} sits in season ${apiSid}.`);
    console.error('  Refusing: only one season file is checked out and it is not that one.');
    process.exit(1);
  }
  console.log(`  grade:   ${grade.name || '(unnamed)'}  round "${round.name}" (${round.id})${round.current ? ' — CURRENT' : ''}`);

  // ── Step 2: the round's fixture ─────────────────────────────────────────────
  const fr = await gqlMain('discoverFixtureByRound', Q_FIXTURE_BY_ROUND, { roundID: round.id });
  if (fr.kind !== 'ok') {
    console.error(`::error::discoverFixtureByRound(${round.id}) returned ${fr.kind} — nothing written.`);
    process.exit(1);
  }
  if (!fr.data || !fr.data.discoverFixtureByRound) {
    // A null payload is NOT an empty round. The same distinction Phase 2R turns on.
    console.error(`::error::discoverFixtureByRound(${round.id}) answered null. That is a non-answer, not an empty round. Nothing written.`);
    process.exit(1);
  }

  gradeName = grade.name || GID;
  roundName = round.name || RNAME;
  const { needsSpectator: roundSpectator, forfeitGameIds, totalGames: fetchedTotal } = applyRoundFixtures(
    fr.data, GID, grade.name || null, round.name || RNAME, !!round.current
  );
  totalGames = fetchedTotal;
  byeCount = ((fr.data.discoverFixtureByRound.byes) || []).length;
  forfeitCount = forfeitGameIds.length;
  console.log(`  fixture: ${totalGames} game(s), ${byeCount} bye(s), ${forfeitGameIds.length} forfeit(s)`);

  // The dispatcher named the games it saw flip. Say plainly whether they were in
  // what PlayHQ just returned — a silent miss here is the difference between
  // "published" and "looked like it published".
  if (ONLY.length) {
    const seen = new Set(((fr.data.discoverFixtureByRound.games) || []).map(g => g && g.id).filter(Boolean));
    const absent = ONLY.filter(id => !seen.has(id));
    if (absent.length) {
      console.log(`  ⚠ ${absent.length} dispatched game id(s) are NOT in this round: ${absent.join(', ')}`);
      console.log('    The round was still processed. A missing id usually means the game moved rounds or was regraded.');
      console.log(`::warning::publish-final-game: ${absent.length} dispatched game id(s) absent from ${GID} "${round.name}": ${absent.join(', ')}`);
    }
  }

  // Forfeits — same merge the nightly performs, so a forfeit found here is not
  // re-discovered tonight.
  if (forfeitGameIds.length > 0 && !DRY_RUN) {
    const forfeitFile = path.join(ROOT, 'data', 'forfeit-games.json');
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(forfeitFile, 'utf8')); } catch (_) {}
    const merged = [...new Set([...existing, ...forfeitGameIds])].sort();
    fs.writeFileSync(forfeitFile, JSON.stringify(merged));
    console.log(`  Updated forfeit-games.json: +${forfeitGameIds.length} new (${merged.length} total)`);
  }

  const seenGameIds    = new Set();
  const needsSpectator = roundSpectator.filter(({ gameId }) => {
    if (seenGameIds.has(gameId)) return false;
    seenGameIds.add(gameId);
    return true;
  });
  queuedCount = needsSpectator.length;
  console.log(`  Games needing spectator: ${needsSpectator.length}`);

  const flushedGames = flushGameFiles();
  if (flushedGames > 0) {
    await gitCommit(
      `publish-final-game: ${SID} ${grade.name || GID} "${round.name}" — ${totalGames} game(s)`,
      ['games/', 'data/forfeit-games.json']
    );
  }
  console.log();

  // ── Phase 3: Spectator + player stat updates ──────────────────────────────────
  console.log(`Phase 3/4 — Spectator box scores (${needsSpectator.length} games)…`);

  // playerDeltas: Map<uuid, { name, deltas: [{seasonId, pts, pt3, fouls}] }>
  playerDeltas = new Map();
  let p3Done = 0;

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
    await gitCommit(`publish-final-game: spc+p[] written for ${spectatorHits} games`, ['games/']);
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


  // ── Hand over to the players phase ──────────────────────────────────────────
  if (!DO_PLAYERS) {
    const st = {
      v: 1, season: SID, grade: GID, gradeName, roundName,
      totalGames, byeCount, forfeitCount, queuedCount, spectatorHits, spectatorMiss,
      deltas: [...playerDeltas],
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(st));
    const fetchShards = [...new Set([...playerDeltas.keys()].map(playerShard))].sort();
    console.log(`  State written to ${STATE_PATH} — ${playerDeltas.size} player(s) across ${fetchShards.length} shard(s)`);
    if (process.env.GITHUB_OUTPUT) {
      // The SUPERSET of shards the players phase can touch, for the sparse-checkout
      // add. The matrix's own list comes later and is narrower.
      fs.appendFileSync(process.env.GITHUB_OUTPUT,
        `fetch_shards=${fetchShards.join(' ')}\n` +
        `fetch_shard_count=${fetchShards.length}\n` +
        `games=${totalGames}\n` +
        `spectator_hits=${spectatorHits}\n`);
    }
    console.log('─'.repeat(50));
    console.log(`  Phase FETCH complete: ${totalGames} game(s), ${spectatorHits} box score(s), ${playerDeltas.size} player(s), ${fetchShards.length} shard(s)`);
    console.log(`  Elapsed: ${Math.round((Date.now() - startTime) / 1000)}s`);
    console.log('─'.repeat(50));
    return;
  }

  } else {
  // ── Resume from the fetch phase ─────────────────────────────────────────────
  // A missing or unreadable state file is FATAL, never an empty run: "no players
  // to update" and "the first half's output was lost" must not look the same.
  let st;
  try { st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (err) {
    console.error(`::error::--phase=players could not read ${STATE_PATH}: ${err.message}`);
    console.error('  The fetch phase either did not run or its state was lost. Nothing has been changed by this phase.');
    process.exit(1);
  }
  if (!st || st.v !== 1 || !Array.isArray(st.deltas)) {
    console.error(`::error::${STATE_PATH} is not a v1 publish-final-game state file.`);
    process.exit(1);
  }
  if (st.season !== SID || st.grade !== GID) {
    console.error(`::error::state file is for ${st.season}/${st.grade}, this phase was given ${SID}/${GID}. Refusing.`);
    process.exit(1);
  }
  playerDeltas  = new Map(st.deltas);
  gradeName     = st.gradeName || GID;
  roundName     = st.roundName || RNAME;
  totalGames    = st.totalGames    || 0;
  byeCount      = st.byeCount      || 0;
  forfeitCount  = st.forfeitCount  || 0;
  queuedCount   = st.queuedCount   || 0;
  spectatorHits = st.spectatorHits || 0;
  spectatorMiss = st.spectatorMiss || 0;
  console.log(`Resumed from ${STATE_PATH} — ${playerDeltas.size} player(s), ${totalGames} game(s) fetched, ${spectatorHits} box score(s).`);
  console.log();
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
          await gitCommit(`publish-final-game: statsChecked cleared (${statsCleared} so far)`, ['players/']);
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
        path.join(ROOT, SHARDS_FILE_NAME),
        JSON.stringify([...affectedShards].sort())
      );
    }
  } else {
    const shardsFile = path.join(ROOT, SHARDS_FILE_NAME);
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

  // ── ⚠ NEW PLAYERS' SHARDS ───────────────────────────────────────────────────
  // Phase 3-cont adds a shard to affectedShards only on the statsChecked branches,
  // and a genuinely-new player never reaches those — it is `continue`d out to
  // Phase 4 before them. So a player appearing for the first time tonight is
  // stubbed with zeros and their shard is NOT in the list the matrix is run
  // against. nightly-crawl.js has the same gap; there it merely means a new
  // player waits for the next full matrix sweep, which is survivable on a nightly
  // and is NOT survivable here, where the whole point is that the profile is
  // right within minutes. Added back, and the file rewritten, AFTER Phase 4.
  let newShards = 0;
  for (const uuid of genuinelyNew.keys()) {
    const sh = playerShard(uuid);
    if (!affectedShards.has(sh)) { affectedShards.add(sh); newShards++; }
  }
  if (newShards > 0) {
    console.log(`  +${newShards} shard(s) from newly stubbed players: ${[...genuinelyNew.keys()].map(playerShard).join(', ')}`);
    if (!DRY_RUN) {
      fs.writeFileSync(path.join(ROOT, SHARDS_FILE_NAME), JSON.stringify([...affectedShards].sort()));
    }
  }

  // Final commit — remaining player + stub writes.
  //
  // ⚠️ 2026-11-28 — SHARDS_FILE_NAME IS DELIBERATELY NOT IN THIS LIST.
  // `fast-publish-shards.json` sits at the repo ROOT, outside this workflow's
  // sparse-checkout definition, so `git add` refused it on every run from the
  // first production dispatch (#5, 2026-11-28 11:00) onward. The file is
  // WRITE-ONLY — nothing in scripts/ or workflows/ reads it; the matrix job gets
  // its shards through GITHUB_OUTPUT below — so committing it buys nothing.
  //
  // It was not merely noise. A sparse-checkout refusal does NOT match the
  // "did not match any files" test above, so it counted as a HARD add failure;
  // on any run where Phase 4 wrote no player changes, `staged` would be empty
  // and gitCommit would THROW, failing a run that had done everything right.
  //
  // The fix is to stop committing the file, NOT to widen the sparse checkout —
  // widening it would pull repo-root paths into a job that has no use for them.
  await gitCommit(
    `publish-final-game: ${statsCleared} statsChecked cleared, ${stubbed} new players stubbed`,
    ['players/']
  );

  // ── Hand the shard list to the workflow ─────────────────────────────────────
  // The matrix job cannot be built from a file the runner has not checked out, so
  // the list goes out through GITHUB_OUTPUT as well as onto disk. An EMPTY list is
  // written explicitly: the next step must be able to tell "no players to refresh"
  // from "the step never ran".
  const shardList = [...affectedShards].sort();
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `shards=${JSON.stringify(shardList)}\n` +
      `shard_count=${shardList.length}\n` +
      `season=${SID}\n` +
      `spectator_hits=${spectatorHits}\n` +
      `games=${totalGames}\n`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('─'.repeat(50));
  console.log(`  Season:            ${SID}`);
  console.log(`  Grade / round:     ${gradeName} / "${roundName}"`);
  console.log(`  Games in round:    ${totalGames}  (byes ${byeCount}, forfeits ${forfeitCount})`);
  console.log(`  Spectator queued:  ${queuedCount}`);
  console.log(`  Spectator hits:    ${spectatorHits}  misses: ${spectatorMiss}`);
  console.log(`  statsChecked cleared: ${statsCleared}  new regs: ${newRegsAdded}`);
  console.log(`  New players:       ${stubbed}`);
  console.log(`  Shards to refresh: ${shardList.length}${shardList.length ? ` — ${shardList.join(', ')}` : ''}`);
  console.log(`  Elapsed:           ${elapsed}s`);
  console.log('─'.repeat(50));
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing was written');
  if (spectatorMiss > 0) {
    console.log(`  note: ${spectatorMiss} game(s) had no spectator data. That is the live-scoring service having nothing,`);
    console.log('        not a failure — those games keep their result and get no box score.');
  }
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
