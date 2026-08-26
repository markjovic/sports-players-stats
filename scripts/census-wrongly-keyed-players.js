// scripts/census-wrongly-keyed-players.js
//
// Finds EVERY player file keyed on a non-api id — not the handful a game sample
// happened to walk past — and recovers each one's real api id from PlayHQ.
// Emits a report the seeder consumes unchanged.
//
// WHY A CENSUS AND NOT A WIDER AUDIT. The 2026-08-26 audit found 67 in 4,066
// games at 2.9 games/sec. The store holds roughly two million games, so sweeping
// them all is past a hundred hours of runner time AND still only a sample of the
// affected people. This asks the question per PLAYER instead, which is both
// cheaper and complete.
//
// THE OFFLINE SIGNAL, read from the code not guessed. fetch-profile-stats.js
// markNotObtainable (L872-884) stamps `player.private = true` and
// `sports.Basketball.statsChecked` on every player whose namespace recovery
// failed. Recovery is a three-tier NAME match; when no tier yields exactly one
// candidate the player is marked and NEVER offered again. So every wrongly-keyed
// player carries private:true — findable with zero API calls.
//
// WHY private:true IS A CANDIDATE SET, NOT AN ANSWER. It also contains genuinely
// private profiles that are correctly keyed. isApiProfile separates them exactly:
//   403 without CloudFront HTML -> 'api'      = real private profile, CORRECT key
//   404 / NOT_FOUND             -> 'not-api'  = spectator-keyed, THE FAULT
//   anything else               -> 'unknown'  = transport, decides nothing
// One call per candidate player, versus two per game.
//
// THREE PHASES, each resumable, progress COMMITTED at every interval:
//   1. scan players/ offline for private:true                 (no API calls)
//   2. isApiProfile on each candidate's own file key          (1 call each)
//   3. for each confirmed, read ONE of its own games and take the api id PlayHQ
//      pairs with it                                          (2 calls each)
//
// PHASE 3 IDENTIFIES THE PLAYER BY ID, NOT BY NAME. It pairs the two rosters by
// name+number — the proven method, 42,671 pairs, 0 unresolved — but then picks
// the pair whose SPECTATOR id is one this player already claims in
// spectatorIds[] or is the file key itself. Names are used to align two PlayHQ
// rosters with each other, never to choose which of our players a profile is.
// That distinction is the whole reason the earlier alias rounds were unsound.
//
// WRITES: reports/wrongly-keyed-census.json and its progress file. NO player
// file, no index, no alias, nothing under games/. It changes no data.
//
// Its `wrong` array uses the audit's field names (resolvesTo, apiId, name,
// spectatorId, gameId) so seed-apiid-from-playhq-pairs.js reads it with no change.
//
// Queries copied verbatim from discover-game-backfill.js and spectator-backfill.js.

'use strict';

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { execFileSync } = require('child_process');
const { TRUNC_LEN, isFullUuid } = require('./lib/uuid-prefix.cjs');
const { normName } = require('./lib/namespace-resolve.cjs');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; })
);

const SCAN_ONLY    = !!ARGS['scan-only'];       // phase 1 only — free, no API calls
const MAX_KEYS     = ARGS['max-keys']  ? Math.max(0, parseInt(ARGS['max-keys'], 10))  : 100000;
const MAX_GAMES    = ARGS['max-games'] ? Math.max(0, parseInt(ARGS['max-games'], 10)) : 100000;
const GAMES_PER    = ARGS['games-per-player'] ? Math.max(1, parseInt(ARGS['games-per-player'], 10)) : 3;
const COMMIT_EVERY = ARGS['commit-every'] ? Math.max(1, parseInt(ARGS['commit-every'], 10)) : 250;
const RESET        = !!ARGS.reset;
// Offline. Reads the committed report and tallies WHY recovery failed. Added
// 2026-08-26 after a run reported "recoveryFailed: 2928" with no breakdown — a
// counter without examples is a number that cannot be checked, and the reasons
// were sitting in the report unprinted.
const EXPLAIN      = !!ARGS['explain-failures'];
// Re-runs phase 3 on the first N players from recoveryFailed, capturing the FULL
// evidence instead of a verdict string, and writes a separate report. Added
// 2026-08-26: the first run reported 5,600 attempts as "no pair carried an id this
// player claims" and 2,766 as "gameView: no-game" without recording whether the
// claimed id was in either roster, or whether the game id was even in games/bv.
// Those distinctions call for opposite fixes. It touches no progress file and
// re-runs nothing else.
const DIAGNOSE     = ARGS.diagnose ? Math.max(1, parseInt(ARGS.diagnose, 10)) : 0;
// OFFLINE. Reads the saved diagnosis and shows, per attempt, the spectator row
// carrying the claimed id next to the gameView rows — to establish WHY no pair
// formed. Added 2026-08-26: 145/145 attempts had the claimed id present in
// PlayHQ's spectator list and still produced no pair, and pairing joins on name.
const WHYNOPAIR    = !!ARGS['why-no-pair'];
const DIAG_FILE    = path.join(ROOT, 'reports', 'census-recovery-diagnosis.json');
const DIAG_REL     = path.relative(ROOT, DIAG_FILE);
const GAMES_DIR    = path.join(ROOT, 'games', 'bv');

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const PLAYERS_DIR   = path.join(ROOT, 'players');
const REPORTS_DIR   = path.join(ROOT, 'reports');
const OUT_FILE      = path.join(REPORTS_DIR, 'wrongly-keyed-census.json');
const PROGRESS_FILE = path.join(REPORTS_DIR, 'wrongly-keyed-census-progress.json');
const OUT_REL       = path.relative(ROOT, OUT_FILE);
const PROGRESS_REL  = path.relative(ROOT, PROGRESS_FILE);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// gitCommit below is copied verbatim from discover-game-backfill.js, and that
// script gates it on a DRY_RUN const of its own. This file has no dry-run of
// that kind, so the constant is declared here rather than editing the copied
// block — an edited copy stops being verbatim and stops being checkable against
// its source. It cost a full dispatch on 2026-08-26 when the census crashed at
// its first commit AFTER a 419,427-file scan had completed.
const DRY_RUN = false;
const t13 = id => String(id || '').slice(0, TRUNC_LEN);
const HEX = '0123456789abcdef';
const ALL_BUCKETS = [];
for (const a of HEX) for (const b of HEX) ALL_BUCKETS.push(a + b);
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
// ─── Row readers (probe-local: the live parsers DROP no-profile rows) ─────────

function gvRows(ts) {
  const out = [];
  for (const p of ((ts && ts.players) || [])) {
    const pl = p && p.player, pr = pl && pl.profile;
    out.push({ profileId: (pr && pr.id) || null,
               name: pr ? [pr.firstName, pr.lastName].filter(Boolean).join(' ').trim() : ((pl && pl.name) || null),
               number: p.playerNumber ?? null });
  }
  return out;
}
function specRows(ts) {
  const out = [];
  for (const p of ((ts && ts.players) || [])) {
    out.push({ profileId: p.profileID || null, name: p.name || null, number: p.playerNumber ?? null });
  }
  return out;
}

// Unambiguous pairs only. One spectator row with that name, or a jersey number
// that singles one out. Otherwise NO pair — a wrong pair would hand the seeder a
// false api id and it would be written to a player file.
function pairRosters(gvList, spList) {
  const pairs = [];
  const byName = new Map();
  for (const r of spList) {
    if (!r.profileId) continue;
    const k = normName(r.name); if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  for (const r of gvList) {
    if (!r.profileId) continue;
    const k = normName(r.name); if (!k) continue;
    const c = byName.get(k) || [];
    if (c.length === 1) { pairs.push({ name: r.name, number: r.number, apiId: r.profileId, spectatorId: c[0].profileId }); continue; }
    if (c.length > 1) {
      const m = c.filter(x => x.number != null && r.number != null && x.number === r.number);
      if (m.length === 1) pairs.push({ name: r.name, number: r.number, apiId: r.profileId, spectatorId: m[0].profileId });
    }
  }
  return pairs;
}

// ─── Phase 1: offline scan ────────────────────────────────────────────────────

function scanCandidates() {
  const candidates = [];
  let files = 0, privateTrue = 0, noGames = 0;
  for (const bucket of ALL_BUCKETS) {
    const dir = path.join(PLAYERS_DIR, bucket);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const key = f.slice(0, -5);
      if (!isFullUuid(key)) continue;
      files++;
      if (files % 100000 === 0) console.log(`  scanned ${files} player files — ${privateTrue} private:true so far`);
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (p.private !== true) continue;
      privateTrue++;
      // Already carries apiId -> the fold will act on it; not our business.
      if (typeof p.apiId === 'string' && p.apiId) continue;
      const games = Array.isArray(p.games) ? p.games.map(g => (typeof g === 'string' ? g : (g && (g.id || g.gid)))).filter(Boolean) : [];
      if (!games.length) { noGames++; continue; }   // nothing to recover an api id FROM
      candidates.push({ uuid: key, name: p.name || null, games: games.slice(0, GAMES_PER),
                        gamesHeld: games.length,
                        spectatorIds: Array.isArray(p.spectatorIds) ? p.spectatorIds : [] });
    }
  }
  console.log(`  scan complete: ${files} player files · ${privateTrue} private:true · ${candidates.length} candidates · ${noGames} private:true but hold no games (cannot be recovered from a game)`);
  return { candidates, files, privateTrue, noGames };
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function loadProgress() {
  if (RESET) { console.log('--reset: ignoring existing progress'); return null; }
  try {
    const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    console.log(`Resuming: ${(p.candidates || []).length} candidates, ${Object.keys(p.keyVerdicts || {}).length} keys tested, ${(p.wrong || []).length} api ids recovered`);
    return p;
  } catch { return null; }
}
function saveProgress(st) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(st)); }

// ─── Main ─────────────────────────────────────────────────────────────────────

function explainFailures() {
  const p = OUT_FILE;
  if (!fs.existsSync(p)) throw new Error(`no report at ${OUT_REL} — run the census first`);
  const rep = JSON.parse(fs.readFileSync(p, 'utf8'));
  const fails = Array.isArray(rep.recoveryFailed) ? rep.recoveryFailed : [];
  console.log(`${OUT_REL}: ${fails.length} player(s) where no api id could be recovered\n`);
  if (!fails.length) return;

  const byReason = {}, bySpectator = {}, byGameview = {};
  let attempts = 0, noGamesTried = 0;
  for (const f of fails) {
    const tried = Array.isArray(f.tried) ? f.tried : [];
    if (!tried.length) { noGamesTried++; continue; }
    for (const t of tried) {
      attempts++;
      const gv = t.gameview || 'n/a', sp = t.spectator || 'n/a';
      byGameview[gv]  = (byGameview[gv]  || 0) + 1;
      bySpectator[sp] = (bySpectator[sp] || 0) + 1;
      const r = t.why || (gv !== 'ok' ? `gameView: ${gv}` : (sp !== 'ok' ? `spectator: ${sp}` : 'unknown'));
      byReason[r] = (byReason[r] || 0) + 1;
    }
  }
  const show = (title, obj) => {
    console.log(`──── ${title} ────`);
    for (const [k, v] of Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${String(v).padStart(6)}  ${k}`);
    }
    console.log('');
  };
  console.log(`  ${attempts} game read attempt(s) across ${fails.length} player(s); ${noGamesTried} player(s) had no attempt recorded\n`);
  show('WHY EACH ATTEMPT FAILED', byReason);
  show('GAMEVIEW OUTCOME PER ATTEMPT', byGameview);
  show('SPECTATOR OUTCOME PER ATTEMPT', bySpectator);

  console.log('──── EXAMPLES (first 10 players, with every game they tried) ────');
  for (const f of fails.slice(0, 10)) {
    console.log(`  ${f.uuid} (${f.name || 'no name'}) holds ${f.gamesHeld} game(s)`);
    for (const t of (f.tried || [])) {
      console.log(`      game ${t.gameId} · gameView ${t.gameview || '-'} · spectator ${t.spectator || '-'}${t.why ? ` · ${t.why}` : ''}`);
    }
  }
}

// Is this game id in games/bv at all, and what does our own roster hold for it?
// Loaded lazily: one pass over the season files, only in diagnose mode.
let gamesIndex = null;
function loadGamesIndex(wanted) {
  const idx = new Map();
  let files = [];
  try { files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort(); } catch { return idx; }
  for (const f of files) {
    let gf; try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, f), 'utf8')); } catch { continue; }
    for (const gid of wanted) {
      const g = gf.games && gf.games[gid];
      if (g && !idx.has(gid)) {
        idx.set(gid, { seasonId: f.replace('.json', ''),
                       roster: ((g.p) || []).map(x => x && x.id).filter(Boolean),
                       spc: g.spc || null, dg: g.dg || null, spcm: g.spcm || null,
                       st: g.st || null, d: g.d || null, hidden: g.hidden || null });
      }
    }
  }
  return idx;
}

function whyNoPair() {
  if (!fs.existsSync(DIAG_FILE)) throw new Error(`no diagnosis at ${DIAG_REL} — run the diagnose mode first`);
  const rep = JSON.parse(fs.readFileSync(DIAG_FILE, 'utf8'));
  let attempts = 0, nameBlank = 0, nameSet = 0, numberSet = 0, numberBlank = 0;
  let gvNameForSameNumber = 0, uniqueNumberOnSide = 0, sameCount = 0;
  const examples = [];

  for (const p of (rep.players || [])) {
    const claimed = new Set(p.claimed || []);
    for (const t of (p.attempts || [])) {
      const spec = t.spectatorRoster || [], gv = t.gameviewRoster || [];
      if (!spec.length || !gv.length) continue;
      const row = spec.find(r => r.profileId && claimed.has(String(r.profileId).slice(0, TRUNC_LEN)));
      if (!row) continue;
      attempts++;
      const hasName = !!(row.name && String(row.name).trim());
      hasName ? nameSet++ : nameBlank++;
      const hasNum = row.number !== null && row.number !== undefined && String(row.number) !== '';
      hasNum ? numberSet++ : numberBlank++;
      if (spec.length === gv.length) sameCount++;

      // Would a jersey-number match be decisive?
      const sameNum = hasNum ? gv.filter(g => String(g.number) === String(row.number)) : [];
      if (sameNum.length === 1) uniqueNumberOnSide++;
      if (sameNum.length === 1 && sameNum[0].name) gvNameForSameNumber++;

      if (examples.length < 12) {
        examples.push({ player: p.name, gameId: t.gameId,
          specRow: { id: row.profileId, name: row.name, number: row.number },
          gvSameNumber: sameNum.map(g => ({ id: g.profileId, name: g.name, number: g.number })),
          specRows: spec.length, gvRows: gv.length });
      }
    }
  }

  console.log(`${DIAG_REL}: ${attempts} attempt(s) where the claimed id was found in the spectator roster\n`);
  console.log('──── THE SPECTATOR ROW CARRYING OUR PLAYER ────');
  console.log(`  name present : ${nameSet}`);
  console.log(`  name BLANK   : ${nameBlank}   <- pairing joins on name, so these can never pair`);
  console.log(`  number present: ${numberSet}`);
  console.log(`  number blank  : ${numberBlank}`);
  console.log(`  rosters equal in size: ${sameCount}/${attempts}`);
  console.log('\n──── WOULD JERSEY NUMBER BE DECISIVE INSTEAD? ────');
  console.log(`  exactly one gameView row shares that number : ${uniqueNumberOnSide}/${attempts}`);
  console.log(`  ...and that row carries a name              : ${gvNameForSameNumber}`);
  console.log('\n──── EXAMPLES ────');
  for (const e of examples) {
    console.log(`  ${e.player} · game ${e.gameId} · spectator ${e.specRows} rows, gameView ${e.gvRows} rows`);
    console.log(`      our player's spectator row: id ${e.specRow.id} · name ${JSON.stringify(e.specRow.name)} · number ${JSON.stringify(e.specRow.number)}`);
    console.log(`      gameView rows with that number: ${e.gvSameNumber.length ? JSON.stringify(e.gvSameNumber) : 'none'}`);
  }
  console.log('\nNOTE: this reads the SAVED rosters. No API calls, nothing written.');
}

async function diagnoseRecovery(n) {
  if (!fs.existsSync(OUT_FILE)) throw new Error(`no report at ${OUT_REL} — run the census first`);
  const rep = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  const fails = (Array.isArray(rep.recoveryFailed) ? rep.recoveryFailed : []).slice(0, n);
  if (!fails.length) { console.log('recoveryFailed is empty — nothing to diagnose.'); return; }
  console.log(`Diagnosing ${fails.length} of ${(rep.recoveryFailed || []).length} failed player(s), full evidence per attempt\n`);

  // Every game these players tried, so we can say whether it exists in games/bv.
  const wantedGames = new Set();
  for (const f of fails) for (const t of (f.tried || [])) if (t.gameId) wantedGames.add(t.gameId);
  console.log(`Loading our own records for ${wantedGames.size} game id(s) (one pass over games/bv)`);
  gamesIndex = loadGamesIndex(wantedGames);
  console.log(`  found ${gamesIndex.size} of ${wantedGames.size} in games/bv\n`);

  await refreshSession();
  const out = [];

  for (const f of fails) {
    // The player file is the authority on what ids this person claims.
    let claimedList = [t13(f.uuid)];
    try {
      const pf = JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, f.uuid.slice(0, 2).toLowerCase(), `${f.uuid}.json`), 'utf8'));
      if (Array.isArray(pf.spectatorIds)) claimedList = [...new Set([...claimedList, ...pf.spectatorIds.map(t13)])];
    } catch (e) { /* reported below as claimedFromFile: false */ }
    const claimed = new Set(claimedList);

    const attempts = [];
    for (const t of (f.tried || [])) {
      const gameId = t.gameId;
      if (!gameId) continue;
      const ours = gamesIndex.get(gameId) || null;
      const gv = await gqlGameView(gameId);
      const sp = await gqlSpectator(gameId);

      const gvList = gv.ok ? [...gvRows((gv.game.statistics || {}).home), ...gvRows((gv.game.statistics || {}).away)] : [];
      const spList = sp.ok ? [...specRows((sp.game.statistics || {}).home), ...specRows((sp.game.statistics || {}).away)] : [];

      const specHasClaimed = spList.filter(r => r.profileId && claimed.has(t13(r.profileId)));
      const gvHasClaimed   = gvList.filter(r => r.profileId && claimed.has(t13(r.profileId)));
      const ourRosterHasClaimed = ours ? ours.roster.filter(id => claimed.has(t13(id))) : [];

      attempts.push({
        gameId,
        inGamesBv: !!ours,
        ourGame: ours ? { seasonId: ours.seasonId, rosterSize: ours.roster.length, spc: ours.spc, dg: ours.dg, spcm: ours.spcm, st: ours.st, d: ours.d, hidden: ours.hidden } : null,
        ourRosterHasClaimed,
        gameview:  { ok: gv.ok, why: gv.why || null, rows: gvList.length, withProfile: gvList.filter(r => r.profileId).length },
        spectator: { ok: sp.ok, why: sp.why || null, rows: spList.length, withProfile: spList.filter(r => r.profileId).length },
        claimedFoundInSpectator: specHasClaimed.map(r => ({ id: r.profileId, name: r.name, number: r.number })),
        claimedFoundInGameview:  gvHasClaimed.map(r => ({ id: r.profileId, name: r.name, number: r.number })),
        pairsFormed: (gv.ok && sp.ok) ? pairRosters(gvList, spList).length : 0,
        spectatorRoster: spList.slice(0, 30),
        gameviewRoster:  gvList.slice(0, 30),
      });

      console.log(`  ${f.uuid.slice(0, 8)} ${f.name || ''} · game ${gameId}` +
        ` · in games/bv ${ours ? 'yes' : 'NO'}` +
        ` · gameView ${gv.ok ? gvList.length + ' rows' : gv.why}` +
        ` · spectator ${sp.ok ? spList.length + ' rows' : sp.why}` +
        ` · claimed id in spectator ${specHasClaimed.length} · in gameView ${gvHasClaimed.length}` +
        ` · in OUR roster ${ourRosterHasClaimed.length}`);
    }
    out.push({ uuid: f.uuid, name: f.name, gamesHeld: f.gamesHeld, claimed: [...claimed], attempts });
  }

  // ── Tallies that answer the two open questions ─────────────────────────────
  let a = 0, notInGamesBv = 0, claimedInSpec = 0, claimedInGv = 0, claimedInOurRoster = 0, gvNoGame = 0, bothOk = 0;
  for (const p of out) for (const t of p.attempts) {
    a++;
    if (!t.inGamesBv) notInGamesBv++;
    if (t.claimedFoundInSpectator.length) claimedInSpec++;
    if (t.claimedFoundInGameview.length) claimedInGv++;
    if (t.ourRosterHasClaimed.length) claimedInOurRoster++;
    if (!t.gameview.ok && t.gameview.why === 'no-game') gvNoGame++;
    if (t.gameview.ok && t.spectator.ok) bothOk++;
  }
  console.log('\n──── TALLIES ────');
  console.log(`  attempts                                   : ${a}`);
  console.log(`  game NOT present in our games/bv           : ${notInGamesBv}`);
  console.log(`  gameView returned no-game                  : ${gvNoGame}`);
  console.log(`  both sources answered                      : ${bothOk}`);
  console.log(`  a claimed id WAS in PlayHQ's spectator list : ${claimedInSpec}`);
  console.log(`  a claimed id WAS in PlayHQ's gameView list  : ${claimedInGv}`);
  console.log(`  a claimed id WAS in OUR OWN p[] roster      : ${claimedInOurRoster}`);
  console.log('\nREAD IT LIKE THIS. If the claimed id is in OUR roster but not in PlayHQ\'s');
  console.log('spectator list, our roster holds an id PlayHQ no longer serves. If it is in');
  console.log('the spectator list but no pair formed, gameView omitted that person and the');
  console.log('pairing has nothing to join. Those need different fixes.');

  fs.writeFileSync(DIAG_FILE, JSON.stringify({ generatedAt: new Date().toISOString(),
    sampled: out.length, tallies: { attempts: a, notInGamesBv, gvNoGame, bothOk, claimedInSpec, claimedInGv, claimedInOurRoster },
    players: out }, null, 2));
  console.log(`\nWrote ${DIAG_REL}`);
  await gitCommit(`census: recovery diagnosis on ${out.length} players`, [DIAG_REL]);
}

async function main() {
  const t0 = Date.now();
  console.log('census-wrongly-keyed-players — every player file keyed on a non-api id\n');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  if (EXPLAIN) { explainFailures(); return; }
  if (DIAGNOSE)  { await diagnoseRecovery(DIAGNOSE); return; }
  if (WHYNOPAIR) { whyNoPair(); return; }

  let st = loadProgress();
  if (!st) {
    console.log('Phase 1 — offline scan for private:true (no API calls)');
    const s = scanCandidates();
    st = { scan: { files: s.files, privateTrue: s.privateTrue, noGames: s.noGames },
           candidates: s.candidates, keyVerdicts: {}, wrong: [], gameFailures: [], done: [] };
    saveProgress(st);
    await gitCommit(`census: phase 1 scan, ${s.privateTrue} private:true, ${s.candidates.length} candidates`, [PROGRESS_REL]);
  }

  if (SCAN_ONLY) {
    console.log('\n--scan-only: stopping after the offline scan.');
    console.log(`  player files      : ${st.scan.files}`);
    console.log(`  private:true      : ${st.scan.privateTrue}`);
    console.log(`  candidates        : ${st.candidates.length}`);
    console.log(`  private, no games : ${st.scan.noGames}`);
    console.log('\nPhase 2 costs one API call per candidate. Phase 3 costs two per game read.');
    fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), scanOnly: true, scan: st.scan, candidateCount: st.candidates.length }, null, 2));
    await gitCommit(`census: scan-only, ${st.candidates.length} candidates`, [OUT_REL, PROGRESS_REL]);
    return;
  }

  await refreshSession();

  // ── Phase 2: is each candidate's own key an api id? ─────────────────────────
  const untested = st.candidates.filter(c => !st.keyVerdicts[c.uuid]).slice(0, MAX_KEYS);
  console.log(`\nPhase 2 — testing ${untested.length} candidate key(s), one call each`);
  let n = 0;
  for (const c of untested) {
    st.keyVerdicts[c.uuid] = await namespaceVerdict(c.uuid);
    n++;
    if (n % 100 === 0) {
      const na = Object.values(st.keyVerdicts).filter(v => v === 'not-api').length;
      console.log(`  ${n}/${untested.length} tested · not-api so far ${na}`);
    }
    if (n % COMMIT_EVERY === 0) { saveProgress(st); await gitCommit(`census: phase 2 progress, ${n} keys tested`, [PROGRESS_REL]); }
  }
  saveProgress(st);

  const confirmed = st.candidates.filter(c => st.keyVerdicts[c.uuid] === 'not-api');
  const reallyPrivate = st.candidates.filter(c => st.keyVerdicts[c.uuid] === 'api').length;
  const unknownKeys = st.candidates.filter(c => st.keyVerdicts[c.uuid] === 'unknown').length;
  console.log(`\n  WRONGLY KEYED (not-api) : ${confirmed.length}`);
  console.log(`  genuinely private (api) : ${reallyPrivate}`);
  console.log(`  unknown (transport)     : ${unknownKeys}  — decided nothing, will be retried on the next run`);

  // ── Phase 3: recover each confirmed player's api id from one of its games ───
  const doneSet = new Set(st.done);
  const todo = confirmed.filter(c => !doneSet.has(c.uuid));
  console.log(`\nPhase 3 — recovering api ids for ${todo.length} player(s), up to ${GAMES_PER} game(s) each`);
  let gamesRead = 0, m = 0;

  for (const c of todo) {
    if (gamesRead >= MAX_GAMES) { console.log(`  --max-games=${MAX_GAMES} reached; ${todo.length - m} player(s) left for the next run`); break; }
    m++;
    const claimed = new Set([t13(c.uuid), ...c.spectatorIds.map(t13)]);
    let found = null, tried = [];

    for (const gameId of c.games) {
      if (found || gamesRead >= MAX_GAMES) break;
      gamesRead++;
      const gv = await gqlGameView(gameId);
      const sp = await gqlSpectator(gameId);
      if (!gv.ok || !sp.ok) { tried.push({ gameId, gameview: gv.ok ? 'ok' : gv.why, spectator: sp.ok ? 'ok' : sp.why }); continue; }
      const gvs = gv.game.statistics || {}, sps = sp.game.statistics || {};
      const pairs = pairRosters([...gvRows(gvs.home), ...gvRows(gvs.away)],
                                [...specRows(sps.home), ...specRows(sps.away)]);
      // Identify by ID: the pair whose spectator id this player already claims.
      const hit = pairs.find(p => claimed.has(t13(p.spectatorId)));
      if (!hit) { tried.push({ gameId, gameview: 'ok', spectator: 'ok', why: 'no pair carried an id this player claims' }); continue; }
      if (hit.apiId === c.uuid) { tried.push({ gameId, why: 'PlayHQ api id equals our key — not diverged after all' }); continue; }
      found = { gameId, ...hit };
    }

    if (found) {
      st.wrong.push({ resolvesTo: c.uuid, apiId: found.apiId, name: found.name,
                      spectatorId: found.spectatorId, gameId: found.gameId,
                      number: found.number, gamesHeld: c.gamesHeld, ourName: c.name });
      console.log(`  ✓ ${c.uuid.slice(0, 8)} ${c.name || '(no name)'} -> api ${found.apiId.slice(0, 8)} (game ${found.gameId}, holds ${c.gamesHeld} games)`);
    } else {
      st.gameFailures.push({ uuid: c.uuid, name: c.name, gamesHeld: c.gamesHeld, tried });
      console.log(`  ✗ ${c.uuid.slice(0, 8)} ${c.name || '(no name)'} — no api id recovered from ${c.games.length} game(s)`);
    }
    st.done.push(c.uuid);

    if (m % COMMIT_EVERY === 0) { saveProgress(st); await gitCommit(`census: phase 3 progress, ${st.wrong.length} api ids recovered`, [PROGRESS_REL]); }
  }
  saveProgress(st);

  // ── Report ─────────────────────────────────────────────────────────────────
  const totals = {
    playerFilesScanned: st.scan.files,
    privateTrue: st.scan.privateTrue,
    privateTrueButHoldNoGames: st.scan.noGames,
    candidates: st.candidates.length,
    keysTested: Object.keys(st.keyVerdicts).length,
    wronglyKeyed: confirmed.length,
    genuinelyPrivate: reallyPrivate,
    keysUnknown: unknownKeys,
    apiIdsRecovered: st.wrong.length,
    recoveryFailed: st.gameFailures.length,
    playersStillToProcess: confirmed.length - st.done.length,
  };
  console.log('\n──── TOTALS ────');
  for (const [k, v] of Object.entries(totals)) console.log(`  ${k}: ${v}`);
  if (unknownKeys) console.log(`  ⚠ ${unknownKeys} key(s) came back unknown — TRANSPORT, not an answer. Re-dispatch to retry them.`);
  if (totals.playersStillToProcess > 0) console.log(`  ⚠ NOT COMPLETE — re-dispatch to continue. Progress is committed.`);

  console.log('\n──── SAMPLE OF RECOVERED (first 20) ────');
  for (const w of st.wrong.slice(0, 20)) {
    console.log(`  ${w.resolvesTo} (${w.ourName}) -> ${w.apiId} · ${w.gamesHeld} games · via ${w.gameId}`);
  }

  const out = { generatedAt: new Date().toISOString(), totals,
                wrong: st.wrong, recoveryFailed: st.gameFailures,
                complete: totals.playersStillToProcess === 0 && unknownKeys === 0 };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT_REL}`);
  await gitCommit(`census: ${totals.wronglyKeyed} wrongly keyed, ${totals.apiIdsRecovered} api ids recovered`, [OUT_REL, PROGRESS_REL]);
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch(e => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
