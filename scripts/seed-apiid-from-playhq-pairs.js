// scripts/seed-apiid-from-playhq-pairs.js
//
// Writes ONE field — player.apiId — on player files whose key is not an api id,
// using the api id PlayHQ itself supplied. Then the EXISTING fold does the rest.
//
// WHY THIS AND NOT A RE-KEY TOOL. fold-diverged-players.js already promotes,
// merges, moves the index entry, repoints orphaned aliases and commits, and it
// selects purely on `typeof p.apiId === 'string' && p.apiId` (scanDiverged L399).
// It is idempotent and has run over the whole store. Writing a second re-key
// path would duplicate proven code and add a second way to corrupt the same
// invariant. This tool therefore does the one thing the fold cannot do for
// itself: supply the apiId.
//
// WHY THESE PLAYERS WERE NEVER FIXED BY THE NIGHTLY. fetch-profile-stats.js only
// runs attemptNamespaceRecovery when a profile comes back private/inaccessible
// (L917-928), and that recovery is a three-tier NAME match — grade+tid, grade
// roster by name, then profileSearch (L688-734). If no tier yields exactly one
// candidate it returns null, markNotObtainable writes statsChecked, and the
// player is never offered again (L946-951). That gate is correct; it stops an
// endless refetch. The consequence is that anyone whose name match failed once
// is parked permanently. That is why a July migration and a month of nightlies
// did not reach them.
//
// WHAT IS DIFFERENT NOW. The api id here comes from PlayHQ's own game record —
// gameView profile.id paired with the spectator profileID by name AND jersey
// number inside a single game — measured across 42,671 pairs on 2026-08-26 with
// 0 unresolved. No name matching against our own players/ directory is involved
// anywhere in that chain. That is the flaw every earlier alias round shared.
//
// VERIFICATION AT APPLY TIME, NOT TRUST IN THE REPORT. The report may be days
// old and the audit only namespace-tested a handful of ids. Before ANY write,
// each case must pass all of:
//   1. the old key resolves 'not-api'  — if it is already api-keyed, LEAVE IT
//   2. the new apiId resolves 'api'    — never point at another spectator id
//   3. the player file exists, and carries no apiId already
//   4. apiId !== key
// A case failing any check is skipped WITH ITS REASON PRINTED. 'unknown' is
// transport, never an answer: an unknown skips, it does not pass.
//
// isApiProfile / PROFILE_EXISTS_QUERY are copied verbatim from
// spectator-backfill.js. No query in this file was hand-written.
//
// WRITES: players/{xx}/{uuid}.json (the apiId field only, file MINIFIED) and
// reports/apiid-seed-log.json. Nothing else. It does NOT move files, touch
// players/indexes, touch players/aliases, or clear statsChecked — every one of
// those is the fold's job or the matrix's, and doing them here would create a
// second writer for data that has exactly one.
//
// REVERSAL: reports/apiid-seed-log.json records { uuid, apiId, file } per write.
// Delete the apiId field from those files and the state is restored EXACTLY,
// provided the fold has not yet run. Once the fold runs the promotion is what
// reverses it, not this log — the log says so in its own header.
//
// Default is DRY RUN. --apply is required to write anything.

'use strict';

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { execFileSync } = require('child_process');
const { TRUNC_LEN, isFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; })
);

const APPLY   = !!ARGS.apply;                 // absent = DRY RUN
const REPORTS = typeof ARGS.reports === 'string' && ARGS.reports.trim()
  ? ARGS.reports.split(',').map(s => s.trim()).filter(Boolean)
  : ['reports/alias-vs-playhq-audit-wide.json', 'reports/alias-vs-playhq-audit.json'];
const MAX     = ARGS.max ? Math.max(1, parseInt(ARGS.max, 10)) : 1000;

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';  // declared for the verbatim block; unused
const PLAYERS_DIR   = path.join(ROOT, 'players');
const REPORTS_DIR   = path.join(ROOT, 'reports');
const LOG_FILE      = path.join(REPORTS_DIR, 'apiid-seed-log.json');
const LOG_REL       = path.relative(ROOT, LOG_FILE);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// gitCommit below is copied verbatim from discover-game-backfill.js, and that
// script gates it on a DRY_RUN const of its own. This file has no dry-run of
// that kind, so the constant is declared here rather than editing the copied
// block — an edited copy stops being verbatim and stops being checkable against
// its source. It cost a full dispatch on 2026-08-26 when the census crashed at
// its first commit AFTER a 419,427-file scan had completed.
const DRY_RUN = false;
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
// ─── Player file access ───────────────────────────────────────────────────────

function playerPath(uuid) { return path.join(PLAYERS_DIR, uuid.slice(0, 2).toLowerCase(), `${uuid}.json`); }

function readPlayer(uuid) {
  try { return JSON.parse(fs.readFileSync(playerPath(uuid), 'utf8')); }
  catch (e) { return null; }
}

// MINIFIED. Player files are stored with no indentation — house rule, and the
// fold reads them back with readJson which does not care, but the repo size does.
function writePlayer(uuid, player) {
  fs.writeFileSync(playerPath(uuid), JSON.stringify(player), 'utf8');
}

// ─── Case collection ──────────────────────────────────────────────────────────
// Reads the WRONG rows out of one or more audit reports. A WRONG row means: for
// a real game, PlayHQ paired this spectator id with this api id, and our
// resolver landed somewhere else. `resolvesTo` is the player file our resolver
// chose and is therefore the file to seed — NOT the spectator id from the box
// score, which usually has no file of its own.

function collectCases() {
  const byUuid = new Map();   // player-file uuid -> case
  const sources = [];
  for (const rel of REPORTS) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { console.log(`  ${rel}: absent, skipped`); continue; }
    let rep;
    try { rep = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { console.log(`  ${rel}: unreadable — ${e.message}`); continue; }
    const wrong = Array.isArray(rep.wrong) ? rep.wrong : null;
    if (!wrong) {
      console.log(`  ${rel}: no 'wrong' array. Top-level keys: ${Object.keys(rep).join(', ')}`);
      continue;
    }
    sources.push(`${rel} (${wrong.length} wrong rows)`);
    for (const r of wrong) {
      const uuid = r.resolvesTo;
      if (!uuid || !isFullUuid(uuid)) continue;
      if (!byUuid.has(uuid)) {
        byUuid.set(uuid, { uuid, apiId: r.apiId, name: r.name, ourName: r.ourName || null,
                           pairedBy: r.pairedBy || 'name',
                           gameviewName: r.gameviewName || null, spectatorName: r.spectatorName || null,
                           gamesHeld: r.gamesHeld ?? null,
                           spectatorIds: new Set(), games: new Set(), conflictingApiIds: new Set() });
      }
      const c = byUuid.get(uuid);
      c.spectatorIds.add(r.spectatorId);
      c.games.add(r.gameId);
      if (r.apiId !== c.apiId) c.conflictingApiIds.add(r.apiId);
    }
  }
  console.log(`  sources: ${sources.join(' · ') || 'none'}`);
  return [...byUuid.values()];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log(`seed-apiid-from-playhq-pairs — ${APPLY ? 'APPLY (will write)' : 'DRY RUN (writes nothing)'}\n`);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  console.log('Collecting cases');
  const cases = collectCases();
  if (!cases.length) {
    console.log('\nNO CASES. This is not a clean result — no audit report supplied any WRONG rows.');
    console.log('Run Audit Aliases Against PlayHQ first, or pass --reports=<path>.');
    return;
  }
  console.log(`  ${cases.length} distinct player file(s) to consider\n`);

  // ── How each api id was arrived at ──────────────────────────────────────────
  // 'name' and 'name+number' are PlayHQ's OWN claim: both rosters agree who that
  // is. 'elimination' is an INFERENCE — within one side of one game, once every
  // exact match is removed, one row left on each side is taken to be the same
  // person. It is what recovered most of these, because a diverged player's
  // spectator row carries the name the club typed and the gameView row carries
  // the PlayHQ account name ("Nathan Hargrave" against "Nate Hargrave"). It would
  // be wrong if, in the same game and on the same side, spectator listed someone
  // gameView omitted AND gameView listed someone spectator omitted. That rate has
  // not been measured. Read this split before applying.
  const byMethod = {};
  for (const c of cases) byMethod[c.pairedBy] = (byMethod[c.pairedBy] || 0) + 1;
  console.log('──── HOW EACH api id WAS DERIVED ────');
  for (const [k, v] of Object.entries(byMethod).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}${k === 'elimination' ? '   <- inference, not PlayHQ\'s own claim' : ''}`);
  }
  const elim = cases.filter(c => c.pairedBy === 'elimination').slice(0, 10);
  if (elim.length) {
    console.log('\n  examples of elimination pairs (the two name forms it joined):');
    for (const c of elim) console.log(`    ${c.spectatorName || c.ourName || '?'}  =  ${c.gameviewName || '?'}`);
  }

  // ── Targets claimed by more than one of our files ───────────────────────────
  // The fold MERGES when a file already sits at the target id. Two of our files
  // pointing at one api id therefore become one player. Usually right — one human
  // with two stubs — but it is a merge of real data and it must be visible BEFORE
  // it happens, not discovered afterwards.
  const byTarget = new Map();
  for (const c of cases) {
    if (!byTarget.has(c.apiId)) byTarget.set(c.apiId, []);
    byTarget.get(c.apiId).push(c);
  }
  const shared = [...byTarget.entries()].filter(([, v]) => v.length > 1);
  console.log(`\n──── api ids CLAIMED BY MORE THAN ONE OF OUR PLAYER FILES ────`);
  console.log(`  ${shared.length} target(s) — the fold will MERGE the files pointing at each`);
  for (const [apiId, list] of shared.slice(0, 15)) {
    console.log(`  ${apiId}`);
    for (const c of list) console.log(`      ${c.uuid}  ${c.ourName || c.name || '(no name)'}  ${c.gamesHeld ?? '?'} games`);
  }
  if (shared.length > 15) console.log(`  … and ${shared.length - 15} more, all in the log`);
  console.log('');

  await refreshSession();

  const written = [], skipped = [];
  let considered = 0;

  for (const c of cases) {
    if (considered >= MAX) { skipped.push({ ...c, spectatorIds: [...c.spectatorIds], games: [...c.games], conflictingApiIds: [...c.conflictingApiIds], why: `--max=${MAX} reached` }); continue; }
    considered++;

    const rec = { uuid: c.uuid, apiId: c.apiId, name: c.name, ourName: c.ourName,
                  pairedBy: c.pairedBy, gameviewName: c.gameviewName, spectatorName: c.spectatorName,
                  gamesHeld: c.gamesHeld,
                  targetHasPlayerFile: fs.existsSync(playerPath(c.apiId)),
                  spectatorIds: [...c.spectatorIds], games: [...c.games],
                  conflictingApiIds: [...c.conflictingApiIds] };

    // Two audits disagreeing about this person's api id is not something to
    // resolve by picking one. Skip and say so.
    if (c.conflictingApiIds.size) {
      skipped.push({ ...rec, why: `report gives more than one api id: ${[c.apiId, ...c.conflictingApiIds].join(', ')}` });
      console.log(`  SKIP ${c.uuid.slice(0, 8)} ${c.name} — conflicting api ids in report`);
      continue;
    }
    if (!isFullUuid(c.apiId) || c.apiId === c.uuid) {
      skipped.push({ ...rec, why: 'api id is not a full uuid, or equals the file key' });
      console.log(`  SKIP ${c.uuid.slice(0, 8)} ${c.name} — api id unusable`);
      continue;
    }

    const player = readPlayer(c.uuid);
    if (!player) {
      skipped.push({ ...rec, why: `no player file at ${path.relative(ROOT, playerPath(c.uuid))}` });
      console.log(`  SKIP ${c.uuid.slice(0, 8)} ${c.name} — no player file`);
      continue;
    }
    if (typeof player.apiId === 'string' && player.apiId) {
      skipped.push({ ...rec, why: `already carries apiId ${player.apiId} — the fold will act on it; not overwriting` });
      console.log(`  SKIP ${c.uuid.slice(0, 8)} ${c.name} — already has apiId`);
      continue;
    }

    // Check 1 — the file key must NOT be an api id. If it is, this file is
    // already correctly keyed and seeding it would send the fold to move a
    // correct file. This is the check that makes the tool safe to re-run.
    const keyVerdict = await namespaceVerdict(c.uuid);
    if (keyVerdict !== 'not-api') {
      skipped.push({ ...rec, why: `file key tested '${keyVerdict}' — only 'not-api' may be seeded` });
      console.log(`  SKIP ${c.uuid.slice(0, 8)} ${c.name} — key is '${keyVerdict}'`);
      continue;
    }

    // Check 2 — the target must BE an api id. Never point the fold at another
    // spectator id: that would key the file wrongly a second time.
    const apiVerdict = await namespaceVerdict(c.apiId);
    if (apiVerdict !== 'api') {
      skipped.push({ ...rec, why: `proposed apiId tested '${apiVerdict}' — only 'api' may be written` });
      console.log(`  SKIP ${c.uuid.slice(0, 8)} ${c.name} — target is '${apiVerdict}'`);
      continue;
    }

    if (!APPLY) {
      written.push({ ...rec, wouldWrite: true });
      console.log(`  WOULD SEED ${c.uuid.slice(0, 8)} ${c.ourName || c.name} -> ${c.apiId.slice(0, 8)}` +
        ` · by ${c.pairedBy}` +
        ` · fold will ${rec.targetHasPlayerFile ? 'MERGE (a file already exists at the target)' : 'promote into empty space'}`);
      continue;
    }

    player.apiId = c.apiId;
    writePlayer(c.uuid, player);
    written.push({ ...rec, file: path.relative(ROOT, playerPath(c.uuid)) });
    console.log(`  SEEDED ${c.uuid.slice(0, 8)} ${c.name} -> apiId ${c.apiId.slice(0, 8)}`);
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const merges = written.filter(w => w.targetHasPlayerFile).length;
  console.log('\n──── TOTALS ────');
  console.log(`  cases considered : ${considered}`);
  console.log(`  of those, fold would MERGE into an existing file : ${merges}`);
  console.log(`  of those, fold would promote into empty space    : ${written.length - merges}`);
  console.log(`  ${APPLY ? 'seeded' : 'would seed'} : ${written.length}`);
  console.log(`  skipped          : ${skipped.length}`);
  if (skipped.length) {
    const byWhy = {};
    for (const s of skipped) byWhy[s.why] = (byWhy[s.why] || 0) + 1;
    console.log('\n──── SKIPPED, WITH REASONS ────');
    for (const [why, n] of Object.entries(byWhy)) console.log(`  ${n}  ${why}`);
  }
  const nsTally = {};
  for (const v of nsCache.values()) nsTally[v] = (nsTally[v] || 0) + 1;
  console.log('\n──── NAMESPACE VERDICTS USED ────');
  for (const [k, v] of Object.entries(nsTally)) console.log(`  ${k}: ${v}`);
  if (nsTally.unknown) console.log(`  ⚠ ${nsTally.unknown} unknown — TRANSPORT, not an answer. Those cases were SKIPPED, not decided.`);

  const out = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    reports: REPORTS,
    // REVERSAL: while the fold has NOT yet run, deleting the apiId field from
    // each file below restores the previous state exactly. AFTER the fold runs,
    // the file has moved and this log no longer describes the live tree — undo
    // is then a fold-level operation, not a field deletion.
    reversal: 'delete the apiId field from each listed file — valid only until fold-diverged-players runs',
    seeded: written,
    skipped,
    namespaceTally: nsTally,
  };
  fs.writeFileSync(LOG_FILE, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${LOG_REL}`);

  if (!APPLY) {
    console.log('\nDRY RUN — no player file was written. Re-run with apply to write.');
    await gitCommit(`apiId seed: dry run, ${written.length} would be seeded, ${skipped.length} skipped`, [LOG_REL]);
  } else {
    const paths = [LOG_REL, ...written.filter(w => w.file).map(w => w.file)];
    await gitCommit(`apiId seed: ${written.length} player files seeded with api id from PlayHQ pairs`, paths);
    console.log('\nNEXT: run Fold diverged players with mode=dry-run to see the plan, then mode=apply.');
    console.log('This tool deliberately does NOT move files, touch players/indexes or players/aliases,');
    console.log('or clear statsChecked — every one of those has exactly one writer already.');
  }

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch(e => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
