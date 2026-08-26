// scripts/probe-roster-sources.js
//
// READ-ONLY against games/ and players/. Writes exactly ONE file:
// reports/roster-source-probe.json, and commits that one path.
//
// PURPOSE. Decide which record the game-by-game comparator should treat as
// ground truth, by measuring both on the same 20 games instead of arguing from
// documents. For each game it puts three rosters side by side:
//
//   ours        — games/bv/{sid}.json games[gid].p[] (13-char ids)
//   gameView    — api.playhq.com discoverGame (the canonical record)
//   spectator   — spectator.playhq.com game (the live-scoring service)
//
// and reports, in BOTH directions, ids each source holds that the others do
// not. Rows carrying no profile id (fill-ins, anonymous participants) are
// counted and listed by __typename, never guessed at and never silently
// dropped: parseGameViewPlayers / parseSpectatorPlayers in the live scripts
// drop them, which is right for a writer and wrong for a measurement, so this
// file counts them itself.
//
// WHY IT ALSO ANSWERS THE NAMESPACE QUESTION WITH NO EXTRA ENDPOINT. Where the
// same person appears in both sources (matched on normalised name, then jersey
// number), the two profile ids are printed side by side. If they differ, that
// IS the spectator -> api divergence, measured directly, and it is also the
// spectator->api bridge that REPO_MANIFEST §6.6 wanted the game-centre HTML
// page for. It does NOT prove gameView's id is api-namespace; only a
// publicProfileStatistics call proves that, and this script deliberately does
// not make one because that query is not available to it verbatim.
//
// QUERIES AND TRANSPORT. doFetch, HEADERS_MAIN, HEADERS_SPECTATOR,
// refreshSession, GV_QUERY, gqlGameView, gqlSpectator and gitCommit are copied
// from scripts/discover-game-backfill.js unchanged. Nothing here is
// hand-written. GV_QUERY is the full untrimmed browser capture.
//
// CONCURRENCY 1, DELIBERATELY. 40 calls total. The 2026-08-2x session read a
// throttled endpoint as a fact about the data; at concurrency 1 a non-answer
// cannot be throttling.
//
// SELECTION. Four blocks of five so the result is interpretable:
//   A  spc set (live-scoring captured it)
//   B  dg set, no spc (paper-scored — spectator failed, canonical served it)
//   C  roster contains an id listed in reports/alias-repoint-log.json
//   D  roster contains an id listed in reports/boxscore-repoint-log.json
// --games=id,id,... overrides selection entirely.

'use strict';

const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execFileSync } = require('child_process');
const { resolveToFullUuid, TRUNC_LEN } = require('./lib/uuid-prefix.cjs');
const { normName, rosterIdMatches } = require('./lib/namespace-resolve.cjs');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; })
);

const DRY_RUN     = !!ARGS['dry-run'];
const PER_BLOCK   = ARGS['per-block'] ? Math.max(1, parseInt(ARGS['per-block'], 10)) : 5;
const MIN_ROSTER  = ARGS['min-roster'] ? Math.max(0, parseInt(ARGS['min-roster'], 10)) : 6;
const GAMES_ARG   = typeof ARGS.games === 'string' ? ARGS.games.split(',').map(s => s.trim()).filter(Boolean) : null;
const MAX_NS      = ARGS['max-namespace-probes'] ? Math.max(0, parseInt(ARGS['max-namespace-probes'], 10)) : 150;
const SKIP_NAMESPACE = !!ARGS['skip-namespace'];

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const GAMES_DIR     = path.join(ROOT, 'games', 'bv');
const REPORTS_DIR   = path.join(ROOT, 'reports');
const OUT_FILE      = path.join(REPORTS_DIR, 'roster-source-probe.json');
const ALIAS_LOG     = path.join(REPORTS_DIR, 'alias-repoint-log.json');
const BOXSCORE_LOG  = path.join(REPORTS_DIR, 'boxscore-repoint-log.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
}

// ─── Namespace test — spectator-backfill.js, verbatim ─────────────────────────
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

// ─── Probe-local parsers ──────────────────────────────────────────────────────
// NOT the live parsers. parseGameViewPlayers and parseSpectatorPlayers both DROP
// rows without a profile id, which is correct for a writer and wrong here: a
// dropped row is exactly the fill-in population this probe has to count. These
// keep every row and label it.

function gvRows(teamStats) {
  const rows = [];
  for (const p of ((teamStats && teamStats.players) || [])) {
    const pl   = p && p.player;
    const prof = pl && pl.profile;
    rows.push({
      profileId:  (prof && prof.id) || null,
      name:       prof ? [prof.firstName, prof.lastName].filter(Boolean).join(' ').trim()
                       : ((pl && pl.name) || null),
      number:     p.playerNumber ?? null,
      typename:   (pl && pl.__typename) || null,
      participantId: (pl && pl.id) || null,
    });
  }
  return rows;
}

function specRows(teamStats) {
  const rows = [];
  for (const p of ((teamStats && teamStats.players) || [])) {
    rows.push({
      profileId: p.profileID || null,
      name:      p.name || null,
      number:    p.playerNumber ?? null,
      typename:  null,
      participantId: null,
    });
  }
  return rows;
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

// ─── Repoint log reading ──────────────────────────────────────────────────────
// The logs are read defensively. Their exact shape is documented as
// { id, from, to } per entry, but a document is not the file: if the shape is
// not recognised the script PRINTS what it actually found and continues with
// that block empty, rather than silently selecting nothing and reporting a
// clean run. A block that could not be filled is stated in the output.

function readRepointIds(file, label) {
  if (!fs.existsSync(file)) {
    console.log(`  ${label}: file absent (${path.relative(ROOT, file)}) — block will be empty`);
    return { ids: new Set(), note: 'file absent' };
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    console.log(`  ${label}: unreadable — ${e.message} — block will be empty`);
    return { ids: new Set(), note: 'unreadable: ' + e.message };
  }
  const entries = Array.isArray(raw) ? raw
                : Array.isArray(raw.entries) ? raw.entries
                : Array.isArray(raw.repoints) ? raw.repoints
                : null;
  if (!entries) {
    console.log(`  ${label}: unrecognised shape. Top-level keys: ${Object.keys(raw).join(', ') || '(none)'} — block will be empty`);
    return { ids: new Set(), note: 'unrecognised shape, keys: ' + Object.keys(raw).join(',') };
  }
  const ids = new Set();
  for (const e of entries) {
    if (!e) continue;
    const id = e.id || e.alias || e.aliasId || e.key;
    if (typeof id === 'string' && id.length >= 10) ids.add(id);
  }
  console.log(`  ${label}: ${entries.length} entries, ${ids.size} distinct alias ids`);
  if (entries[0]) console.log(`    first entry shape: ${JSON.stringify(entries[0]).slice(0, 200)}`);
  return { ids, note: `${entries.length} entries, ${ids.size} ids` };
}

// ─── Selection ────────────────────────────────────────────────────────────────

function rosterIds(g) {
  return ((g && g.p) || []).map(x => x && x.id).filter(Boolean);
}

function eligible(g) {
  if (!g) return false;
  if (g.forfeit || g.bye || g.cancelled || g.abandoned || g.legacy || g.profileOnly) return false;
  if (g.hidden) return false;                 // hidden grades carry t1/t2 and no public game page
  return rosterIds(g).length >= MIN_ROSTER;
}

function selectGames(aliasIds, boxIds) {
  const blocks = { A: [], B: [], C: [], D: [] };
  const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort();
  let scanned = 0;
  const full = () => Object.values(blocks).every(b => b.length >= PER_BLOCK);

  for (const fname of files) {
    if (full()) break;
    scanned++;
    if (scanned % 200 === 0) {
      console.log(`  scanned ${scanned}/${files.length} season files — A:${blocks.A.length} B:${blocks.B.length} C:${blocks.C.length} D:${blocks.D.length}`);
    }
    const sid = fname.replace('.json', '');
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); } catch { continue; }
    for (const [gameId, g] of Object.entries(gf.games || {})) {
      if (!eligible(g)) continue;
      const ids = rosterIds(g);
      const rec = { gameId, seasonId: sid,
                    flags: { spc: g.spc || null, dg: g.dg || null, spcm: g.spcm || null, dgm: g.dgm || null },
                    st: g.st || null, d: g.d || null, rosterIds: ids };

      // C and D take priority: those games are the point of the exercise.
      if (blocks.C.length < PER_BLOCK && aliasIds.size &&
          ids.some(id => rosterIdMatches(id, aliasIds))) { blocks.C.push({ ...rec, block: 'C' }); continue; }
      if (blocks.D.length < PER_BLOCK && boxIds.size &&
          ids.some(id => rosterIdMatches(id, boxIds)))   { blocks.D.push({ ...rec, block: 'D' }); continue; }
      if (blocks.B.length < PER_BLOCK && g.dg && !g.spc)  { blocks.B.push({ ...rec, block: 'B' }); continue; }
      if (blocks.A.length < PER_BLOCK && g.spc)           { blocks.A.push({ ...rec, block: 'A' }); continue; }
    }
  }
  console.log(`  selection scanned ${scanned}/${files.length} season files`);
  return [...blocks.A, ...blocks.B, ...blocks.C, ...blocks.D];
}

// ─── Comparison ───────────────────────────────────────────────────────────────

const t13 = id => String(id || '').slice(0, TRUNC_LEN);

function compareOne(sel, gv, spec) {
  const ourIds  = sel.rosterIds;
  const ourT    = new Set(ourIds.map(t13));

  const gvWith  = gv.rows.filter(r => r.profileId);
  const specWith = spec.rows.filter(r => r.profileId);
  const gvT     = new Set(gvWith.map(r => t13(r.profileId)));
  const specT   = new Set(specWith.map(r => t13(r.profileId)));

  // Where does each of our ids land, and does it resolve at all?
  const resolution = ourIds.map(id => {
    let full = null, err = null;
    try { full = resolveToFullUuid(id, ROOT); } catch (e) { err = e.message; }
    return { rosterId: id, resolvesTo: full, error: err };
  });

  // Same person in both sources, ids compared. Name first, jersey number as a
  // tiebreak when a name appears twice.
  const byName = new Map();
  for (const r of specWith) {
    const k = normName(r.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  const idPairs = [];
  for (const r of gvWith) {
    const k = normName(r.name);
    const cands = byName.get(k) || [];
    let m = null;
    if (cands.length === 1) m = cands[0];
    else if (cands.length > 1) m = cands.find(c => c.number != null && c.number === r.number) || null;
    if (!m) continue;
    idPairs.push({
      name: r.name, number: r.number,
      gameviewId: r.profileId, spectatorId: m.profileId,
      same: r.profileId === m.profileId,
      samePrefix13: t13(r.profileId) === t13(m.profileId),
    });
  }

  return {
    ours: { count: ourIds.length, ids: ourIds },
    gameview: {
      ok: gv.ok, why: gv.why || null, permanent: gv.permanent ?? null,
      withProfile: gvWith.length,
      noProfile: gv.rows.filter(r => !r.profileId)
                        .map(r => ({ typename: r.typename, name: r.name, number: r.number })),
      rows: gvWith.map(r => ({ profileId: r.profileId, name: r.name, number: r.number, typename: r.typename })),
    },
    spectator: {
      ok: spec.ok, why: spec.why || null, permanent: spec.permanent ?? null,
      withProfile: specWith.length,
      noProfileCount: spec.rows.filter(r => !r.profileId).length,
      rows: specWith.map(r => ({ profileId: r.profileId, name: r.name, number: r.number })),
    },
    compare: {
      oursNotInGameview:  gv.ok   ? [...ourT].filter(x => !gvT.has(x))   : null,
      gameviewNotInOurs:  gv.ok   ? [...gvT].filter(x => !ourT.has(x))   : null,
      oursNotInSpectator: spec.ok ? [...ourT].filter(x => !specT.has(x)) : null,
      spectatorNotInOurs: spec.ok ? [...specT].filter(x => !ourT.has(x)) : null,
      idPairs,
      idPairsDiffering: idPairs.filter(p => !p.same).length,
      unresolvedOurIds: resolution.filter(r => !r.resolvesTo).map(r => r.rosterId),
      resolution,
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('probe-roster-sources — three-way roster comparison, concurrency 1\n');

  if (!fs.existsSync(GAMES_DIR)) throw new Error(`games dir not found: ${GAMES_DIR}`);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  let selection;
  if (GAMES_ARG) {
    console.log(`Explicit --games given (${GAMES_ARG.length}); locating them in games/bv`);
    const wanted = new Set(GAMES_ARG);
    selection = [];
    for (const fname of fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort()) {
      if (!wanted.size) break;
      let gf; try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); } catch { continue; }
      for (const gid of [...wanted]) {
        const g = gf.games && gf.games[gid];
        if (!g) continue;
        wanted.delete(gid);
        selection.push({ gameId: gid, seasonId: fname.replace('.json', ''), block: 'explicit',
          flags: { spc: g.spc || null, dg: g.dg || null, spcm: g.spcm || null, dgm: g.dgm || null },
          st: g.st || null, d: g.d || null, rosterIds: rosterIds(g) });
      }
    }
    if (wanted.size) console.log(`  ⚠ not found in games/bv: ${[...wanted].join(', ')}`);
  } else {
    console.log('Reading repoint logs');
    const aliasLog = readRepointIds(ALIAS_LOG, 'alias-repoint-log.json');
    const boxLog   = readRepointIds(BOXSCORE_LOG, 'boxscore-repoint-log.json');
    console.log('\nSelecting games');
    selection = selectGames(aliasLog.ids, boxLog.ids);
  }

  const byBlock = selection.reduce((m, s) => { m[s.block] = (m[s.block] || 0) + 1; return m; }, {});
  console.log(`\nSelected ${selection.length} games: ${JSON.stringify(byBlock)}`);
  for (const s of selection) {
    console.log(`  [${s.block}] ${s.gameId}  season ${s.seasonId}  roster ${s.rosterIds.length}  spc=${s.flags.spc} dg=${s.flags.dg} spcm=${s.flags.spcm}`);
  }
  if (!selection.length) throw new Error('no games selected — nothing to probe');

  await refreshSession();

  const results = [];
  for (let i = 0; i < selection.length; i++) {
    const sel = selection[i];
    console.log(`\n[${i + 1}/${selection.length}] ${sel.gameId} (block ${sel.block})`);

    const gvRes = await gqlGameView(sel.gameId);
    let gv = { ok: false, why: gvRes.why, permanent: gvRes.permanent, rows: [] };
    if (gvRes.ok) {
      const st = gvRes.game.statistics || {};
      gv = { ok: true, why: null, permanent: null, rows: [...gvRows(st.home), ...gvRows(st.away)] };
    }
    console.log(`  gameView : ${gv.ok ? gv.rows.length + ' rows' : 'FAILED ' + gv.why}`);

    const spRes = await gqlSpectator(sel.gameId);
    let spec = { ok: false, why: spRes.why, permanent: spRes.permanent, rows: [] };
    if (spRes.ok) {
      const st = (spRes.game.statistics) || {};
      spec = { ok: true, why: null, permanent: null, rows: [...specRows(st.home), ...specRows(st.away)] };
    }
    console.log(`  spectator: ${spec.ok ? spec.rows.length + ' rows' : 'FAILED ' + spec.why}`);

    const cmp = compareOne(sel, gv, spec);
    results.push({ ...sel, ...cmp });

    const c = cmp.compare;
    console.log(`  ours ${cmp.ours.count} · gameView with-profile ${cmp.gameview.withProfile} (no-profile ${cmp.gameview.noProfile.length}) · spectator with-profile ${cmp.spectator.withProfile} (no-profile ${cmp.spectator.noProfileCount})`);
    if (c.oursNotInGameview)  console.log(`  ours not in gameView : ${c.oursNotInGameview.length} ${JSON.stringify(c.oursNotInGameview.slice(0, 8))}`);
    if (c.gameviewNotInOurs)  console.log(`  gameView not in ours : ${c.gameviewNotInOurs.length} ${JSON.stringify(c.gameviewNotInOurs.slice(0, 8))}`);
    if (c.oursNotInSpectator) console.log(`  ours not in spectator: ${c.oursNotInSpectator.length} ${JSON.stringify(c.oursNotInSpectator.slice(0, 8))}`);
    if (c.spectatorNotInOurs) console.log(`  spectator not in ours: ${c.spectatorNotInOurs.length} ${JSON.stringify(c.spectatorNotInOurs.slice(0, 8))}`);
    console.log(`  same-person id pairs: ${c.idPairs.length}, differing: ${c.idPairsDiffering}`);
    for (const p of c.idPairs.filter(p => !p.same).slice(0, 5)) {
      console.log(`    ${p.name} #${p.number}  spectator ${p.spectatorId}  gameView ${p.gameviewId}`);
    }
    if (c.unresolvedOurIds.length) console.log(`  our ids that do NOT resolve: ${c.unresolvedOurIds.length} ${JSON.stringify(c.unresolvedOurIds.slice(0, 8))}`);
  }

  // ── Namespace probe ─────────────────────────────────────────────────────────
  // Only the ids where the answer changes something, each tagged with why it was
  // asked, plus a small control set of ids all three sources agree on — without a
  // control, a run in which every verdict came back 'api' proves nothing, because
  // a uniformly permissive endpoint looks identical to a correct one.
  const nsTargets = new Map();   // fullId -> Set(reason)
  const addTarget = (id, reason) => {
    if (!id || id.length !== 36) return;
    if (!nsTargets.has(id)) nsTargets.set(id, new Set());
    nsTargets.get(id).add(reason);
  };
  for (const r of results) {
    for (const p of r.compare.idPairs) {
      if (p.same) continue;
      addTarget(p.gameviewId,  'gameview-side-of-differing-pair');
      addTarget(p.spectatorId, 'spectator-side-of-differing-pair');
    }
    const ourT = new Set(r.ours.ids.map(t13));
    for (const row of r.gameview.rows)  if (!ourT.has(t13(row.profileId))) addTarget(row.profileId, 'gameview-not-in-ours');
    for (const row of r.spectator.rows) if (!ourT.has(t13(row.profileId))) addTarget(row.profileId, 'spectator-not-in-ours');
    // control: agreed by all three
    const specT = new Set(r.spectator.rows.map(x => t13(x.profileId)));
    for (const row of r.gameview.rows.slice(0, 2)) {
      if (ourT.has(t13(row.profileId)) && specT.has(t13(row.profileId))) addTarget(row.profileId, 'control-agreed-by-all-three');
    }
  }

  const namespaceResults = [];
  if (SKIP_NAMESPACE) {
    console.log(`\nNamespace probe skipped (--skip-namespace). ${nsTargets.size} ids would have been asked.`);
  } else if (!nsTargets.size) {
    console.log('\nNamespace probe: no ids qualified — nothing to ask.');
  } else {
    const list = [...nsTargets.entries()].slice(0, MAX_NS);
    console.log(`\nNamespace probe: asking publicProfileStatistics about ${list.length} of ${nsTargets.size} qualifying ids (cap --max-namespace-probes=${MAX_NS}), one at a time`);
    for (const [id, reasons] of list) {
      const verdict = await namespaceVerdict(id);
      namespaceResults.push({ id, reasons: [...reasons], verdict });
      console.log(`  ${verdict.padEnd(8)} ${id}  [${[...reasons].join(', ')}]`);
    }
    if (nsTargets.size > list.length) {
      console.log(`  ⚠ ${nsTargets.size - list.length} qualifying ids NOT asked (cap reached) — this is a truncated sample, not a full census`);
    }
  }
  const nsCount = v => namespaceResults.filter(x => x.verdict === v).length;
  const nsBy = (reason, v) => namespaceResults.filter(x => x.reasons.includes(reason) && x.verdict === v).length;

  // ── Totals ──────────────────────────────────────────────────────────────────
  const sum = (f) => results.reduce((n, r) => n + f(r), 0);
  const gvOk   = results.filter(r => r.gameview.ok);
  const specOk = results.filter(r => r.spectator.ok);
  const totals = {
    games: results.length,
    gameviewAnswered:  gvOk.length,
    spectatorAnswered: specOk.length,
    gameviewFailures:  results.filter(r => !r.gameview.ok).map(r => ({ gameId: r.gameId, block: r.block, why: r.gameview.why, permanent: r.gameview.permanent })),
    spectatorFailures: results.filter(r => !r.spectator.ok).map(r => ({ gameId: r.gameId, block: r.block, why: r.spectator.why, permanent: r.spectator.permanent })),
    ourRosterEntries:      sum(r => r.ours.count),
    gameviewWithProfile:   sum(r => r.gameview.withProfile),
    gameviewNoProfileRows: sum(r => r.gameview.noProfile.length),
    spectatorWithProfile:  sum(r => r.spectator.withProfile),
    spectatorNoProfileRows: sum(r => r.spectator.noProfileCount),
    oursNotInGameview:  sum(r => (r.compare.oursNotInGameview || []).length),
    gameviewNotInOurs:  sum(r => (r.compare.gameviewNotInOurs || []).length),
    oursNotInSpectator: sum(r => (r.compare.oursNotInSpectator || []).length),
    spectatorNotInOurs: sum(r => (r.compare.spectatorNotInOurs || []).length),
    samePersonPairs:    sum(r => r.compare.idPairs.length),
    samePersonPairsDiffering: sum(r => r.compare.idPairsDiffering),
    unresolvedOurIds:   sum(r => r.compare.unresolvedOurIds.length),
    namespaceQualifying: nsTargets.size,
    namespaceAsked:      namespaceResults.length,
    namespaceApi:        nsCount('api'),
    namespaceNotApi:     nsCount('not-api'),
    namespaceUnknown:    nsCount('unknown'),
    // The three figures that decide the source question. If gameView ids come
    // back 'api' and spectator ids 'not-api' on the SAME differing pair, the two
    // namespaces are confirmed and gameView is the api-side record.
    gameviewSideApi:      nsBy('gameview-side-of-differing-pair', 'api'),
    gameviewSideNotApi:   nsBy('gameview-side-of-differing-pair', 'not-api'),
    spectatorSideApi:     nsBy('spectator-side-of-differing-pair', 'api'),
    spectatorSideNotApi:  nsBy('spectator-side-of-differing-pair', 'not-api'),
    controlApi:           nsBy('control-agreed-by-all-three', 'api'),
    controlNotApi:        nsBy('control-agreed-by-all-three', 'not-api'),
  };

  console.log('\n──── TOTALS ────');
  for (const [k, v] of Object.entries(totals)) {
    if (Array.isArray(v)) console.log(`  ${k}: ${v.length} ${v.length ? JSON.stringify(v) : ''}`);
    else console.log(`  ${k}: ${v}`);
  }
  console.log('\nHOW TO READ THE NAMESPACE FIGURES. `unknown` is transport, never an answer:');
  console.log('if unknown is a large share, the run proves nothing about namespace and should');
  console.log('be repeated, not interpreted. If every control id also came back api, the');
  console.log('endpoint is answering; if controls came back not-api, the probe itself is wrong');
  console.log('and no verdict in this run should be trusted.');
  console.log('\nSTILL NOT ANSWERED BY THIS PROBE: whether a game missing from a profile\'s');
  console.log('statistics is a wrong attribution or PlayHQ simply omitting it. That is the');
  console.log('comparator, and it is what this run is choosing a source for.');

  const out = {
    generatedAt: new Date().toISOString(),
    args: { perBlock: PER_BLOCK, minRoster: MIN_ROSTER, games: GAMES_ARG,
            maxNamespaceProbes: MAX_NS, skipNamespace: SKIP_NAMESPACE },
    totals,
    namespace: namespaceResults,
    games: results,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));   // a REPORT, not player data — indented on purpose
  console.log(`\nWrote ${path.relative(ROOT, OUT_FILE)}`);

  await gitCommit(`probe-roster-sources: ${results.length} games, gameView ${totals.gameviewAnswered} answered, spectator ${totals.spectatorAnswered} answered`, ['reports/roster-source-probe.json']);

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch(e => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
