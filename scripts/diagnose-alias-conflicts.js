// scripts/diagnose-alias-conflicts.js
//
// Takes the WRONG rows and the duplicateInRoster rows out of an audit report and
// asks PlayHQ which namespace each id in them actually belongs to. Read-only
// against games/ and players/; writes one report.
//
// WHY. The 500-game audit (2026-08-26) returned 5 WRONG out of 461 diverged pairs
// and 10 duplicates. My WRONG label said "our resolver lands on a different
// person" and that label was WRONG ITSELF: in all five cases the name we resolve
// to is the SAME person PlayHQ names (Aston Dyt, Umer Qureshi, Victoria Hu, Jack
// Telford, Darcy Bendeich). The verdict compares ids and cannot tell "wrong
// person" from "same person, second id". This script gets the fact the label
// assumed.
//
// Three explanations fit the five, and they call for opposite responses:
//   1. our alias target is itself a SPECTATOR id wearing api clothing — a player
//      file keyed on the wrong namespace, which is the duplicate-creation failure
//      isApiProfile was added to spectator-backfill.js to prevent. Darcy Bendeich
//      is the clearest candidate: the alias maps 423776e0-c910 TO ITSELF while
//      PlayHQ pairs that spectator id with e358fc8a-593b.
//   2. the person genuinely holds TWO api profiles, which would contradict the
//      0.09% api-stability finding in README ("no evidence a person has two
//      distinct api profiles").
//   3. gameView's id is not api-side after all — which would contradict the
//      18/18 measured on 2026-08-26, so it is the least likely, but it is a
//      hypothesis this script can kill rather than assume.
// isApiProfile separates them in one call per id.
//
// THE ONLY QUERY IT SENDS is PROFILE_EXISTS_QUERY / isApiProfile, copied verbatim
// from spectator-backfill.js L282-316. It does NOT call publicProfile: that query
// is documented in playhq_api_reference.md but I do not have it verbatim from a
// live script, and the names it would fetch are already in the audit report,
// supplied by PlayHQ itself.
//
// 'unknown' is a TRANSPORT outcome and is never read as an answer. An id that
// comes back unknown is reported as untested, not as either verdict.
//
// It changes NOTHING. No repoint, no reversal, no player write. It produces the
// evidence a decision needs.

'use strict';

const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execFileSync } = require('child_process');
const { resolveToFullUuid, TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; })
);

const DRY_RUN  = !!ARGS['dry-run'];
const REPORT   = typeof ARGS.report === 'string' && ARGS.report.trim() ? ARGS.report.trim() : 'reports/alias-vs-playhq-audit.json';
const IDS_ARG  = typeof ARGS.ids === 'string' ? ARGS.ids.split(',').map(s => s.trim()).filter(Boolean) : null;
const MAX_IDS  = ARGS['max-ids'] ? Math.max(1, parseInt(ARGS['max-ids'], 10)) : 400;

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';   // declared for the verbatim block below; unused here
const PLAYERS_DIR   = path.join(ROOT, 'players');
const REPORTS_DIR   = path.join(ROOT, 'reports');
const OUT_FILE      = path.join(REPORTS_DIR, 'alias-conflict-diagnosis.json');
const OUT_REL       = path.relative(ROOT, OUT_FILE);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const t13 = id => String(id || '').slice(0, TRUNC_LEN);
// ─── HTTP — discover-game-backfill.js, verbatim ───────────────────────────────

function doFetch(url, bodyObj, headers) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify(bodyObj);
    const parsed = new URL(url);
    const h      = { ...headers, 'request-id': crypto.randomUUID(),
                     'content-length': Buffer.byteLength(body) };
    const req    = https.request(
      { hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
        headers: h, agent: new https.Agent({ keepAlive: false }) },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = JSON.parse(rawText); } catch (_) { body = null; }
          resolve({ status: res.statusCode, rawCookies: res.headers['set-cookie'], body, rawText });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Session — discover-game-backfill.js, verbatim ────────────────────────────

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

async function refreshSession() {
  const body = { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const { rawCookies } = await doFetch(API_URL, body, HEADERS_MAIN);
      if (!rawCookies) continue;
      const arr = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
        .map(c => c.split(';')[0].trim());
      const get = n => arr.find(p => p.startsWith(n + '=')) || null;
      const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
      if (tier && session && sub) {
        sessionCookie = `${tier}; ${session}; ${sub}`;
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    } catch (_) {}
  }
  throw new Error('Failed to obtain session after 10 attempts');
}

// ─── gameView — discover-game-backfill.js, VERBATIM, UNTRIMMED ────────────────

const GV_QUERY = "query gameView($gameId: ID!, $gameStatisticsFilter: GameStatisticsFilter!) {\n  discoverGame(gameID: $gameId) {\n    id\n    alias\n    away {\n      ...TeamFragment\n      __typename\n    }\n    home {\n      ...TeamFragment\n      __typename\n    }\n    result {\n      winner {\n        name\n        value\n        __typename\n      }\n      outcome {\n        name\n        value\n        __typename\n      }\n      home {\n        score\n        outcome {\n          name\n          value\n          __typename\n        }\n        statistics {\n          count\n          type {\n            value\n            __typename\n          }\n          __typename\n        }\n        periods {\n          period {\n            label\n            value\n            __typename\n          }\n          type\n          closureStatus\n          statistics {\n            count\n            type {\n              label\n              value\n              __typename\n            }\n            __typename\n          }\n          __typename\n        }\n        gameOutcomeDescription\n        revisedTarget {\n          type\n          runs\n          overLimit\n          __typename\n        }\n        __typename\n      }\n      away {\n        score\n        outcome {\n          name\n          value\n          __typename\n        }\n        statistics {\n          count\n          type {\n            value\n            __typename\n          }\n          __typename\n        }\n        periods {\n          period {\n            label\n            value\n            __typename\n          }\n          type\n          closureStatus\n          statistics {\n            count\n            type {\n              label\n              value\n              __typename\n            }\n            __typename\n          }\n          __typename\n        }\n        revisedTarget {\n          type\n          runs\n          overLimit\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    status {\n      name\n      value\n      __typename\n    }\n    round {\n      id\n      name\n      abbreviatedName\n      grade {\n        id\n        name\n        day {\n          name\n          value\n          __typename\n        }\n        hideScores\n        season {\n          id\n          name\n          competition {\n            id\n            name\n            organisation {\n              ...OrganisationDetails\n              __typename\n            }\n            __typename\n          }\n          __typename\n        }\n        gameEvents {\n          participantEvents {\n            type\n            label\n            shortName\n            value\n            pointValue\n            applicableTo\n            advanced\n            __typename\n          }\n          periodEvents {\n            value\n            __typename\n          }\n          __typename\n        }\n        hasPeriodScores\n        periodScoresDisplayType {\n          name\n          value\n          __typename\n        }\n        periods {\n          shortName\n          value\n          __typename\n        }\n        playerPoints {\n          enforceTeamTotalCap\n          teamPlayerPointsCap\n          publicVisible\n          __typename\n        }\n        bestPlayers {\n          max\n          __typename\n        }\n        gameStatisticsConfiguration {\n          gameStatistics(filter: $gameStatisticsFilter) {\n            type\n            glossary {\n              default {\n                name\n                shortName\n                message\n                labelName\n                __typename\n              }\n              scoring {\n                name\n                shortName\n                message\n                labelName\n                __typename\n              }\n              __typename\n            }\n            value\n            pointValue\n            applicableTo\n            required\n            max\n            __typename\n          }\n          __typename\n        }\n        lineupRemainsWhenGameStarted\n        __typename\n      }\n      __typename\n    }\n    date\n    dates\n    allocation {\n      time\n      dateTimeList {\n        date\n        time\n        __typename\n      }\n      court {\n        id\n        abbreviatedName\n        name\n        venue {\n          id\n          name\n          latitude\n          longitude\n          address\n          suburb\n          state\n          postcode\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    statistics {\n      home {\n        ...GameViewGameTeamStatisticsFragment\n        __typename\n      }\n      away {\n        ...GameViewGameTeamStatisticsFragment\n        __typename\n      }\n      shared {\n        period {\n          label\n          shortName\n          value\n          __typename\n        }\n        type\n        status\n        statistics {\n          count\n          type {\n            value\n            __typename\n          }\n          __typename\n        }\n        side\n        players {\n          playerID\n          teamID\n          role\n          __typename\n        }\n        dismissalType\n        displayOrder\n        __typename\n      }\n      __typename\n    }\n    publishLineup\n    gameType {\n      name\n      value\n      maxBattersPerInnings\n      eScoringSettings {\n        dismissalsPerBatter\n        legalBallsPerOver\n        __typename\n      }\n      emergencyPlayersSettings {\n        enabled\n        __typename\n      }\n      playerPositionsSettings {\n        isInGamePositionsLineupVisible\n        __typename\n      }\n      clockType\n      __typename\n    }\n    formation {\n      template\n      __typename\n    }\n    __typename\n  }\n  tenantConfiguration {\n    label\n    statistics {\n      enabled\n      __typename\n    }\n    showPlayerPositionsInLineup\n    showDuckIconInBattingTable\n    periodType {\n      value\n      __typename\n    }\n    gameTypes {\n      gameType {\n        value\n        __typename\n      }\n      gameTypeFeatures {\n        lineupOrderingEnabled\n        __typename\n      }\n      __typename\n    }\n    ...TenantContactRolesConfiguration\n    __typename\n  }\n}\n\nfragment TeamFragment on DiscoverPossibleTeam {\n  ... on ProvisionalTeam {\n    name\n    pool {\n      id\n      name\n      __typename\n    }\n    __typename\n  }\n  ...DiscoverTeamFragment\n  __typename\n}\n\nfragment DiscoverTeamFragment on DiscoverTeam {\n  id\n  name\n  logo {\n    sizes {\n      url\n      dimensions {\n        width\n        height\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  season {\n    id\n    name\n    competition {\n      id\n      name\n      __typename\n    }\n    __typename\n  }\n  organisation {\n    id\n    name\n    type\n    __typename\n  }\n  playerPointsCap\n  __typename\n}\n\nfragment OrganisationDetails on DiscoverOrganisation {\n  id\n  type\n  name\n  email\n  contactNumber\n  websiteUrl\n  address {\n    id\n    line1\n    suburb\n    postcode\n    state\n    country\n    __typename\n  }\n  logo {\n    sizes {\n      url\n      dimensions {\n        width\n        height\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  contacts {\n    id\n    firstName\n    lastName\n    position\n    email\n    phone\n    __typename\n  }\n  shopVisible\n  __typename\n}\n\nfragment GameViewGameTeamStatisticsFragment on DiscoverGameTeamStatistics {\n  players {\n    playerNumber\n    player {\n      ... on DiscoverParticipant {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        hasSeasonPermit\n        memberships {\n          ...ShortTermMembershipFields\n          __typename\n        }\n        __typename\n      }\n      ... on DiscoverParticipantFillInPlayer {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        hasSeasonPermit\n        __typename\n      }\n      ... on DiscoverGamePermitFillInPlayer {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        __typename\n      }\n      ... on DiscoverRegularFillInPlayer {\n        id\n        name\n        __typename\n      }\n      ... on DiscoverAnonymousParticipant {\n        id\n        name\n        hasGamePermit\n        hasSeasonPermit\n        __typename\n      }\n      __typename\n    }\n    statistics {\n      count\n      type {\n        value\n        __typename\n      }\n      __typename\n    }\n    periodStatistics {\n      period {\n        label\n        shortName\n        value\n        __typename\n      }\n      type\n      statistics {\n        type {\n          type\n          label\n          shortName\n          value\n          pointValue\n          applicableTo\n          advanced\n          __typename\n        }\n        count\n        details {\n          value\n          __typename\n        }\n        __typename\n      }\n      status\n      side\n      displayOrder\n      __typename\n    }\n    periods {\n      period {\n        label\n        shortName\n        value\n        __typename\n      }\n      overtimeSequenceNo\n      inGamePositions {\n        shortName\n        __typename\n      }\n      __typename\n    }\n    playerPoints\n    playerPosition {\n      positionType\n      shortName\n      order\n      __typename\n    }\n    captain {\n      name\n      shortName\n      __typename\n    }\n    lineupOrder\n    __typename\n  }\n  statistics {\n    count\n    type {\n      value\n      pointValue\n      __typename\n    }\n    __typename\n  }\n  periods {\n    period {\n      value\n      __typename\n    }\n    overtimeSequenceNo\n    statistics {\n      type {\n        value\n        __typename\n      }\n      count\n      __typename\n    }\n    teamEvents {\n      sequenceNo\n      playerID\n      statistic {\n        type {\n          value\n          __typename\n        }\n        count\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  emergencyPlayers {\n    playerNumber\n    playerPoints\n    player {\n      ... on DiscoverParticipant {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        hasSeasonPermit\n        __typename\n      }\n      ... on DiscoverParticipantFillInPlayer {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        hasSeasonPermit\n        __typename\n      }\n      ... on DiscoverGamePermitFillInPlayer {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        __typename\n      }\n      ... on DiscoverAnonymousParticipant {\n        id\n        name\n        hasGamePermit\n        hasSeasonPermit\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  bestPlayers {\n    participant {\n      ... on DiscoverParticipant {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        __typename\n      }\n      ... on DiscoverAnonymousParticipant {\n        name\n        __typename\n      }\n      __typename\n    }\n    ranking\n    __typename\n  }\n  coinTossWinningResult {\n    preference\n    __typename\n  }\n  __typename\n}\n\nfragment ShortTermMembershipFields on Membership {\n  history {\n    startDate\n    expiryDate\n    purchaseDate\n    __typename\n  }\n  categoryBasedFee {\n    tenantPeriod {\n      period\n      isShortTerm\n      __typename\n    }\n    __typename\n  }\n  organisation {\n    id\n    type\n    name\n    __typename\n  }\n  __typename\n}\n\nfragment TenantContactRolesConfiguration on TenantConfiguration {\n  contactRoles {\n    name\n    value\n    __typename\n  }\n  __typename\n}\n";

// discover-game-backfill.js gqlGameView, verbatim.
async function gqlGameView(gameId) {
  if (!sessionCookie) await refreshSession();
  const body = {
    operationName: 'gameView',
    variables: { gameId, gameStatisticsFilter: { classification: 'TOTAL' } },
    query: GV_QUERY,
  };
  try {
    const { status, body: resp } = await doFetch(API_URL, body, { ...HEADERS_MAIN, 'Cookie': sessionCookie });
    if (status === 403) {
      await refreshSession();
      const retry = await doFetch(API_URL, body, { ...HEADERS_MAIN, 'Cookie': sessionCookie });
      if (retry.status === 404) return { ok: false, permanent: true, why: '404' };
      if (retry.status !== 200 || retry.body.errors) return { ok: false, permanent: false, why: '403-retry-' + retry.status };
      const g403 = retry.body.data?.discoverGame;
      return g403 ? { ok: true, game: g403 } : { ok: false, permanent: true, why: 'no-game' };
    }
    if (status === 404) return { ok: false, permanent: true, why: '404' };
    if (status !== 200) return { ok: false, permanent: false, why: 'http-' + status };
    if (resp.errors) {
      const msg = String((resp.errors[0] || {}).message || '').slice(0, 80);
      const perm = /could not be found|not found|does not exist|no such|invalid.*id/i.test(msg);
      return { ok: false, permanent: perm, why: 'graphql:' + (msg || 'nomsg') };
    }
    const g = resp.data?.discoverGame;
    return g ? { ok: true, game: g } : { ok: false, permanent: true, why: 'no-game' };
  } catch (e) { return { ok: false, permanent: false, why: 'network-' + (e.code || e.message || 'err') }; }
}

// discover-game-backfill.js gqlSpectator, verbatim.
async function gqlSpectator(gameId) {
  if (!sessionCookie) await refreshSession();
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
      await refreshSession();
      const retry = await doFetch(
        SPECTATOR_URL,
        { operationName: 'game', variables: { id: gameId }, query },
        { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
      );
      if (retry.status === 404) return { ok: false, permanent: true, why: '404' };
      if (retry.status !== 200 || retry.body.errors) return { ok: false, permanent: false, why: '403-retry-' + retry.status };
      const g403 = retry.body.data?.game;
      return g403 ? { ok: true, game: g403 } : { ok: false, permanent: true, why: 'no-game' };
    }
    if (status === 404) return { ok: false, permanent: true, why: '404' };
    if (status !== 200) return { ok: false, permanent: false, why: 'http-' + status };
    if (body.errors) {
      const e0 = body.errors[0] || {};
      const code = (e0.extensions && (e0.extensions.code || e0.extensions.errorType)) || '';
      const msg  = String(e0.message || '').slice(0, 80);
      const perm = /could not be found|not electronically scored|NOT_FOUND|NOT FOUND|does not exist|no such|invalid.*id|BAD_USER_INPUT/i.test(code + ' ' + msg);
      return { ok: false, permanent: perm, why: 'graphql:' + (code || 'nocode') + ':' + (msg || 'nomsg') };
    }
    const g = body.data?.game;
    return g ? { ok: true, game: g } : { ok: false, permanent: true, why: 'no-game' };
  } catch (e) { return { ok: false, permanent: false, why: 'network-' + (e.code || e.message || 'err') }; }
}// ─── Namespace test — spectator-backfill.js, verbatim ─────────────────────────
// PROFILE_EXISTS_QUERY and isApiProfile are copied unchanged from
// spectator-backfill.js (L282-316). The three-way verdict is the whole point:
// 'unknown' is a TRANSPORT outcome and is never read as either answer. That is
// exactly the distinction the last session collapsed when it read a throttled
// endpoint as "most of the store is not api profiles".
const PROFILE_EXISTS_QUERY = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) { seasonStatistics { name } }
}`;

async function isApiProfile(uuid) {
  if (!sessionCookie) await refreshSession();
  let res;
  try {
    res = await doFetch(API_URL,
      { operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: PROFILE_EXISTS_QUERY },
      { ...HEADERS_MAIN, 'Cookie': sessionCookie });
  } catch (e) { return 'unknown'; }
  const raw = res.rawText || '';
  if (res.status === 403) {
    if (/DOCTYPE|Request blocked/i.test(raw)) return 'unknown';
    return 'api';
  }
  if (res.status === 404) return 'not-api';
  if (res.status < 200 || res.status >= 300) return 'unknown';
  const j = res.body;
  if (!j) return 'unknown';
  if (j.errors && j.errors.length) {
    const m = String(j.errors[0].message || '');
    if (/NOT_FOUND|failed to find profile/i.test(m)) return 'not-api';
    return 'unknown';
  }
  return (j.data && j.data.publicProfileStatistics !== undefined) ? 'api' : 'not-api';
}

// ONE DELIBERATE DEVIATION FROM THE CALL SITE IN spectator-backfill.js (L1038-1046),
// stated rather than hidden. That loop calls isApiProfile sequentially with a 250 ms
// sleep and never refreshes the session. It probes ~115 ids per sweep and has run
// clean. playhq_api_reference.md records a per-session JWT quota of roughly 30-35
// calls on THIS operation specifically, refreshed between batches of 30. The two
// disagree, and here the disagreement is dangerous in one direction: a
// quota-exhausted 403 whose body is NOT CloudFront HTML returns 'api', so exhausting
// the quota would silently label every remaining id an api profile. That is the same
// shape of misread as last session's 82% claim, running the other way. So this probe
// refreshes the session every 25 calls. If the run shows that was unnecessary, the
// evidence for changing the live script will be in the log.
const NS_REFRESH_EVERY = 25;
let nsCalls = 0;
const nsCache = new Map();   // uuid -> 'api' | 'not-api' | 'unknown'

async function namespaceVerdict(uuid) {
  if (nsCache.has(uuid)) return nsCache.get(uuid);
  if (nsCalls > 0 && nsCalls % NS_REFRESH_EVERY === 0) {
    console.log(`    (namespace probe: ${nsCalls} calls made, refreshing session)`);
    await refreshSession();
  }
  nsCalls++;
  const v = await isApiProfile(uuid);
  await sleep(250);
  nsCache.set(uuid, v);
  return v;
}
// ─── Git commit — discover-game-backfill.js, verbatim ─────────────────────────

const GIT_MAXBUF     = 512 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

async function gitCommit(message, dirs) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  const paths = (dirs && dirs.length ? dirs : ['.']);

  let addFailures = 0, hardAddFailures = 0;
  for (const p of paths) {
    try { execFileSync('git', ['add', '--', p], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS }); }
    catch (e) {
      addFailures++;
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      if (!/did not match any files/i.test(detail)) hardAddFailures++;
      console.error(`  ⚠ git add ${/did not match any files/i.test(detail) ? 'skipped' : 'FAILED'} for "${p}": ${detail}`);
    }
  }

  const staged = (() => {
    try { return execFileSync('git', ['diff', '--staged', '--shortstat'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS }).toString().trim(); }
    catch (_) { return ''; }
  })();

  if (!staged) {
    if (hardAddFailures) {
      throw new Error(`gitCommit: nothing staged and ${hardAddFailures} path(s) failed to stage for a reason other than "did not match any files" ("${message}")`);
    }
    if (addFailures) {
      console.log(`  (no changes to commit: ${message}) — ${addFailures} optional path(s) absent`);
      return;
    }
    console.log(`  (no changes to commit: ${message})`);
    return;
  }
  console.log(`  staging: ${staged}`);

  const IDENT = ['-c', 'user.name=github-actions[bot]',
                 '-c', 'user.email=github-actions[bot]@users.noreply.github.com'];

  try { execFileSync('git', [...IDENT, 'commit', '-q', '-m', message], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS }); }
  catch (e) {
    const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
    throw new Error(`gitCommit: commit failed for "${message}" — ${detail}`);
  }

  const MAX = 60;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try { execFileSync('git', ['merge', '--abort'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS }); } catch (_) {}

    try {
      execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS });
    } catch (e) {
      if (attempt === MAX) throw e;
      const s = 1 + Math.floor(Math.random() * 91);
      console.log(`  fetch failed (attempt ${attempt}/${MAX}), retrying in ${s}s`);
      await sleep(s * 1000);
      continue;
    }

    execFileSync('git', [...IDENT, 'merge', '-q', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS });

    try {
      execFileSync('git', ['push', 'origin', 'HEAD:main'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS });
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
      console.log(`  push attempt ${attempt}/${MAX} rejected, re-syncing in ${s}s`);
      await sleep(s * 1000);
    }
  }
  throw new Error(`gitCommit: exhausted ${MAX} push attempts for "${message}"`);
}
// ─── Offline facts about an id ────────────────────────────────────────────────

const aliasShardCache = new Map();
function rawAliasEntry(id) {
  const shard = String(id).slice(0, 2).toLowerCase();
  if (!aliasShardCache.has(shard)) {
    let obj = {};
    try { obj = JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, 'aliases', `${shard}.json`), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    aliasShardCache.set(shard, obj);
  }
  return aliasShardCache.get(shard)[t13(id)] || null;
}

function readPlayer(uuid) {
  if (!uuid || uuid.length !== 36) return null;
  try { return JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, uuid.slice(0, 2).toLowerCase(), `${uuid}.json`), 'utf8')); }
  catch (e) { return null; }
}

function offlineFacts(id) {
  const p = readPlayer(id);
  let resolves = null, resolveError = null;
  try { resolves = resolveToFullUuid(t13(id), ROOT); } catch (e) { resolveError = e.message; }
  return {
    id,
    hasPlayerFile: !!p,
    name: p ? (p.name || null) : null,
    private: p ? (p.private === true) : null,
    gamesHeld: p && Array.isArray(p.games) ? p.games.length : null,
    spectatorIds: p && Array.isArray(p.spectatorIds) ? p.spectatorIds : null,
    seasonCount: p && Array.isArray(p.seasons) ? p.seasons.length : null,
    aliasEntryFor: rawAliasEntry(id),
    truncResolvesTo: resolves,
    resolveError,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('diagnose-alias-conflicts — which namespace does each conflicting id belong to?\n');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // Cases: either explicit ids, or pulled out of an audit report.
  let wrong = [], dupes = [];
  if (!IDS_ARG) {
    const rp = path.join(ROOT, REPORT);
    if (!fs.existsSync(rp)) throw new Error(`report not found: ${REPORT} — run audit-aliases-against-playhq first, or pass --ids=`);
    let rep;
    try { rep = JSON.parse(fs.readFileSync(rp, 'utf8')); }
    catch (e) { throw new Error(`report unreadable: ${REPORT} — ${e.message}`); }
    wrong = Array.isArray(rep.wrong) ? rep.wrong : [];
    dupes = Array.isArray(rep.duplicateInRoster) ? rep.duplicateInRoster : [];
    if (!wrong.length && !dupes.length) {
      console.log(`${REPORT} holds no WRONG rows and no duplicateInRoster rows.`);
      console.log(`Top-level keys present: ${Object.keys(rep).join(', ')}`);
      console.log('Nothing to diagnose — this is a clean report, not a failure.');
      return;
    }
    console.log(`${REPORT}: ${wrong.length} WRONG rows, ${dupes.length} duplicate rows`);
  }

  // Which ids need asking, and why. An id can appear under several reasons.
  const targets = new Map();
  const want = (id, role, caseKey) => {
    if (!id || id.length !== 36) return;
    if (!targets.has(id)) targets.set(id, { roles: new Set(), cases: new Set() });
    targets.get(id).roles.add(role);
    targets.get(id).cases.add(caseKey);
  };

  if (IDS_ARG) {
    for (const id of IDS_ARG) want(id, 'explicit', 'explicit');
  } else {
    for (const r of wrong) {
      const k = `WRONG:${r.gameId}:${r.name}`;
      want(r.spectatorId, 'spectator-id-in-our-roster', k);
      want(r.apiId,       'playhq-says-this-is-the-api-id', k);
      want(r.resolvesTo,  'what-our-alias-points-at', k);
    }
    for (const r of dupes) {
      const k = `DUPLICATE:${r.gameId}:${r.name}`;
      want(r.spectatorId, 'spectator-id-in-our-roster', k);
      want(r.apiId,       'playhq-says-this-is-the-api-id', k);
    }
  }

  const list = [...targets.keys()].slice(0, MAX_IDS);
  console.log(`\n${targets.size} distinct ids to ask; asking ${list.length} (cap --max-ids=${MAX_IDS}), one at a time`);
  if (targets.size > list.length) console.log(`  ⚠ ${targets.size - list.length} NOT asked — truncated sample, not a census`);

  await refreshSession();

  const facts = new Map();
  for (const id of list) {
    const verdict = await namespaceVerdict(id);
    const off = offlineFacts(id);
    facts.set(id, { ...off, namespace: verdict, roles: [...targets.get(id).roles], cases: [...targets.get(id).cases] });
    console.log(`  ${verdict.padEnd(8)} ${id}  file:${off.hasPlayerFile ? 'yes' : 'NO '}  ${off.name || '(no name)'}  games:${off.gamesHeld ?? '-'}`);
  }

  // ── Per case ────────────────────────────────────────────────────────────────
  // The classification below is stated as an OBSERVATION of three verdicts, not
  // as a recommendation. Nothing here decides to reverse anything.
  const cases = [];
  for (const r of wrong) {
    const s = facts.get(r.spectatorId), a = facts.get(r.apiId), o = facts.get(r.resolvesTo);
    let reading;
    if (!s || !a || !o) reading = 'NOT-FULLY-TESTED (an id was not asked)';
    else if ([s, a, o].some(x => x.namespace === 'unknown')) reading = 'UNTESTED (transport, ask again)';
    else if (o.namespace === 'not-api') reading = 'OUR TARGET IS A SPECTATOR ID — player file keyed on the wrong namespace';
    else if (a.namespace === 'not-api') reading = 'PLAYHQ GAMEVIEW ID IS NOT API-SIDE — contradicts the 18/18 of 2026-08-26, re-measure before believing';
    else if (o.namespace === 'api' && a.namespace === 'api') reading = 'TWO API PROFILES FOR ONE PERSON — contradicts the 0.09% api-stability claim';
    else reading = 'unclassified — read the facts below';
    cases.push({ kind: 'WRONG', gameId: r.gameId, name: r.name, number: r.number,
                 spectatorId: r.spectatorId, playhqApiId: r.apiId, weResolveTo: r.resolvesTo,
                 aliasEntry: r.rawAliasEntry, reading,
                 facts: { spectatorId: s || null, playhqApiId: a || null, weResolveTo: o || null } });
  }
  for (const r of dupes) {
    const s = facts.get(r.spectatorId), a = facts.get(r.apiId);
    let reading;
    if (!s || !a) reading = 'NOT-FULLY-TESTED (an id was not asked)';
    else if (s.namespace === 'unknown' || a.namespace === 'unknown') reading = 'UNTESTED (transport, ask again)';
    else if (s.truncResolvesTo === r.apiId) reading = 'COSMETIC — both ids fold to one player, so games[] is unaffected; p[] consumers still see an extra player';
    else if (s.hasPlayerFile && a.hasPlayerFile) reading = 'TWO PLAYER FILES FOR ONE PERSON — appearances are split between them';
    else reading = 'unclassified — read the facts below';
    cases.push({ kind: 'DUPLICATE', gameId: r.gameId, name: r.name, number: r.number,
                 spectatorId: r.spectatorId, playhqApiId: r.apiId, reading,
                 facts: { spectatorId: s || null, playhqApiId: a || null } });
  }

  console.log('\n──── CASES ────');
  for (const c of cases) {
    console.log(`\n[${c.kind}] ${c.name} #${c.number} · game ${c.gameId}`);
    console.log(`  reading: ${c.reading}`);
    for (const [label, f] of Object.entries(c.facts)) {
      if (!f) { console.log(`  ${label}: not asked`); continue; }
      console.log(`  ${label}: ${f.id}`);
      console.log(`      namespace ${f.namespace} · player file ${f.hasPlayerFile ? 'yes' : 'NO'} · name ${JSON.stringify(f.name)} · private ${f.private} · games ${f.gamesHeld ?? '-'} · seasons ${f.seasonCount ?? '-'}`);
      console.log(`      alias entry for its own prefix: ${f.aliasEntryFor || 'none'} · prefix resolves to: ${f.truncResolvesTo || 'null'}`);
      if (f.spectatorIds) console.log(`      spectatorIds on file: ${JSON.stringify(f.spectatorIds.slice(0, 6))}${f.spectatorIds.length > 6 ? ` (+${f.spectatorIds.length - 6})` : ''}`);
    }
  }

  const tally = {};
  for (const c of cases) tally[`${c.kind}: ${c.reading}`] = (tally[`${c.kind}: ${c.reading}`] || 0) + 1;
  console.log('\n──── READINGS ────');
  for (const [k, v] of Object.entries(tally)) console.log(`  ${v}  ${k}`);
  const nsTally = {};
  for (const f of facts.values()) nsTally[f.namespace] = (nsTally[f.namespace] || 0) + 1;
  console.log('\n──── NAMESPACE VERDICTS ────');
  for (const [k, v] of Object.entries(nsTally)) console.log(`  ${k}: ${v}`);
  if (nsTally.unknown) console.log(`  ⚠ ${nsTally.unknown} unknown — TRANSPORT, not an answer. Those cases are untested and must be asked again.`);

  const out = {
    generatedAt: new Date().toISOString(),
    sourceReport: IDS_ARG ? null : REPORT,
    args: { ids: IDS_ARG, maxIds: MAX_IDS },
    namespaceTally: nsTally,
    readings: tally,
    cases,
    ids: [...facts.values()],
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT_REL}`);
  await gitCommit(`alias conflict diagnosis: ${cases.length} cases, ${facts.size} ids asked`, [OUT_REL]);
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch(e => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
