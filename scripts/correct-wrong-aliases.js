// scripts/correct-wrong-aliases.js
//
// Repairs aliases the audit proved wrong, from the audit's own evidence.
//
// WHAT COUNTS AS PROOF. audit-aliases-against-playhq.js pairs a spectator id with
// an api id using PlayHQ's OWN two records of one game — the spectator box score
// and gameView — joined on name, or name plus jersey number where a name repeats.
// It never uses elimination (checked: that inference lives in the census, not the
// audit). A WRONG row therefore means PlayHQ itself says this spectator id belongs
// to that api id, and our resolver disagrees.
//
// THE FIX IS ONE MAP ENTRY: players/aliases/<shard>.json[trunc13(spectatorId)] = apiId.
// Nothing else. No player file is written, moved or merged.
//
// WHAT IT REFUSES, AND WHY EACH GUARD EXISTS:
//
//   the api id must test 'api'         — never point an alias at a second spectator
//                                        id. 1 case of exactly this was caught by
//                                        the seeder on 2026-08-27.
//   the CURRENT target must test 'api' — if what we resolve to today is not-api,
//                                        the fault is a player file keyed on the
//                                        wrong namespace, and the repair is
//                                        seed-apiid + fold, NOT an alias repoint.
//                                        Those are routed out and counted, not fixed
//                                        here. That is the 3,033-player shape.
//   agreement across >= N games        — one game is one observation. Two games
//                                        independently producing the same pair is
//                                        not a coincidence. Default 2.
//   no conflicting api id in the input — if the report pairs one spectator id with
//                                        two different api ids, that is not a thing
//                                        to resolve by picking; it is a stop.
//   'unknown' from PlayHQ skips        — transport, never an answer.
//
// REVERSAL. Every write is recorded in reports/alias-correction-log.json with the
// shard, key, value before and value after. That is what rounds 1 and 2 never did:
// 16,610 alias repoints were measured across a fortnight on 2026-08-29 and only
// 136 of them had any log at all.
//
// DEFAULT IS DRY RUN. --apply is required to write.

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

const APPLY    = !!ARGS.apply;
const DRY_RUN  = false;                      // gitCommit's own flag; APPLY gates the data writes
const MIN_GAMES = ARGS['min-games'] ? Math.max(1, parseInt(ARGS['min-games'], 10)) : 2;
const MAX       = ARGS.max ? Math.max(1, parseInt(ARGS.max, 10)) : 5000;
const REPORTS   = typeof ARGS.reports === 'string' && ARGS.reports.trim()
  ? ARGS.reports.split(',').map(s => s.trim()).filter(Boolean)
  : ['reports/alias-vs-playhq-audit-wide.json', 'reports/alias-vs-playhq-audit-after-fold.json'];

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';   // declared for the verbatim block; unused
const PLAYERS_DIR   = path.join(ROOT, 'players');
const REPORTS_DIR   = path.join(ROOT, 'reports');
const LOG_FILE      = path.join(REPORTS_DIR, 'alias-correction-log.json');
const LOG_REL       = path.relative(ROOT, LOG_FILE);

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
// ─── Alias shard access ───────────────────────────────────────────────────────

function aliasPathFor(id) { return path.join(PLAYERS_DIR, 'aliases', `${String(id).slice(0, 2).toLowerCase()}.json`); }

const shardCache = new Map();
function loadShard(id) {
  const p = aliasPathFor(id);
  if (!shardCache.has(p)) {
    let obj = {};
    try { obj = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    shardCache.set(p, obj);
  }
  return shardCache.get(p);
}
// Written sorted and MINIFIED, matching recordAliasDiscovery in
// fetch-profile-stats.js — a differently-ordered rewrite would show as a whole-file
// change in every diff and bury the real one.
function saveShard(p, map) {
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  fs.writeFileSync(p, JSON.stringify(sorted));
}

// ─── Gather the evidence ──────────────────────────────────────────────────────

function collect() {
  const bySpectator = new Map();
  for (const rel of REPORTS) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { console.log(`  ${rel}: absent, skipped`); continue; }
    let rep;
    try { rep = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { console.log(`  ${rel}: unreadable — ${e.message}`); continue; }
    const wrong = Array.isArray(rep.wrong) ? rep.wrong : null;
    if (!wrong) { console.log(`  ${rel}: no 'wrong' array (keys: ${Object.keys(rep).join(', ')})`); continue; }
    console.log(`  ${rel}: ${wrong.length} WRONG row(s)`);
    for (const r of wrong) {
      const key = t13(r.spectatorId);
      if (!key || !isFullUuid(r.apiId)) continue;
      if (!bySpectator.has(key)) {
        bySpectator.set(key, { key, spectatorId: r.spectatorId, apiId: r.apiId,
                               names: new Set(), games: new Set(), resolvesTo: new Set(),
                               aliasEntries: new Set(), conflicting: new Set() });
      }
      const c = bySpectator.get(key);
      if (r.apiId !== c.apiId) c.conflicting.add(r.apiId);
      if (r.name) c.names.add(r.name);
      if (r.gameId) c.games.add(r.gameId);
      if (r.resolvesTo) c.resolvesTo.add(r.resolvesTo);
      if (r.rawAliasEntry) c.aliasEntries.add(r.rawAliasEntry);
    }
  }
  return [...bySpectator.values()];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log(`correct-wrong-aliases — ${APPLY ? 'APPLY (will write aliases)' : 'DRY RUN (writes nothing)'}`);
  console.log(`evidence: PlayHQ's own pairing of one game, from audit WRONG rows`);
  console.log(`guards: api id must be api · current target must be api · agreement across >= ${MIN_GAMES} game(s)\n`);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  console.log('Collecting evidence');
  const cases = collect();
  if (!cases.length) {
    console.log('\nNO CASES. Not a clean result — no audit report supplied WRONG rows.');
    console.log('Run Audit Aliases Against PlayHQ first, or pass --reports=<path>.');
    return;
  }
  console.log(`  ${cases.length} distinct spectator id(s)\n`);

  await refreshSession();

  const fixed = [], skipped = [], routedToSeeder = [];
  let considered = 0;

  for (const c of cases) {
    if (considered >= MAX) { skipped.push({ key: c.key, why: `--max=${MAX} reached` }); continue; }
    considered++;

    const rec = { key: c.key, spectatorId: c.spectatorId, apiId: c.apiId,
                  name: [...c.names][0] || null, games: [...c.games],
                  currentTarget: [...c.resolvesTo][0] || null,
                  aliasEntry: [...c.aliasEntries][0] || null };

    if (c.conflicting.size) {
      skipped.push({ ...rec, why: `report pairs this id with more than one api id: ${[c.apiId, ...c.conflicting].join(', ')}` });
      continue;
    }
    if (c.games.size < MIN_GAMES) {
      skipped.push({ ...rec, why: `seen in ${c.games.size} game(s), needs ${MIN_GAMES} — one observation is not corroboration` });
      continue;
    }

    const shardPath = aliasPathFor(c.key);
    const shard = loadShard(c.key);
    const current = shard[c.key];
    if (current === c.apiId) {
      skipped.push({ ...rec, why: 'alias already points at the api id — nothing to do' });
      continue;
    }

    const apiVerdict = await namespaceVerdict(c.apiId);
    if (apiVerdict !== 'api') {
      skipped.push({ ...rec, why: `PlayHQ's api id tested '${apiVerdict}' — only 'api' may be written` });
      console.log(`  SKIP ${c.key} — target tested '${apiVerdict}'`);
      continue;
    }

    // Where we resolve TODAY decides whether this is an alias fault at all.
    const target = rec.currentTarget;
    if (target && isFullUuid(target)) {
      const targetVerdict = await namespaceVerdict(target);
      if (targetVerdict === 'not-api') {
        routedToSeeder.push({ ...rec, why: 'we resolve to a file keyed on a NON-api id — repair is seed-apiid + fold, not an alias repoint' });
        console.log(`  ROUTE ${c.key} ${rec.name || ''} — current target is not-api, this is the seeder's job`);
        continue;
      }
      if (targetVerdict === 'unknown') {
        skipped.push({ ...rec, why: 'current target tested unknown (transport) — decides nothing, retry later' });
        continue;
      }
    }

    if (!APPLY) {
      fixed.push({ ...rec, from: current === undefined ? null : current, to: c.apiId, wouldWrite: true });
      console.log(`  WOULD FIX ${c.key} ${rec.name || ''} · ${current || '(no entry)'} -> ${c.apiId} · ${c.games.size} games agree`);
      continue;
    }

    shard[c.key] = c.apiId;
    saveShard(shardPath, shard);
    fixed.push({ ...rec, shard: path.relative(ROOT, shardPath),
                 from: current === undefined ? null : current, to: c.apiId });
    console.log(`  FIXED ${c.key} ${rec.name || ''} · ${current || '(no entry)'} -> ${c.apiId}`);
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log('\n──── TOTALS ────');
  console.log(`  cases considered            : ${considered}`);
  console.log(`  ${APPLY ? 'aliases corrected' : 'would correct'}          : ${fixed.length}`);
  console.log(`  routed to seed-apiid + fold : ${routedToSeeder.length}   (player file keyed on a non-api id — not an alias fault)`);
  console.log(`  skipped                     : ${skipped.length}`);
  if (skipped.length) {
    const byWhy = {};
    for (const s of skipped) byWhy[s.why] = (byWhy[s.why] || 0) + 1;
    console.log('\n──── SKIPPED, WITH REASONS ────');
    for (const [why, n] of Object.entries(byWhy).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${why}`);
  }
  const nsTally = {};
  for (const v of nsCache.values()) nsTally[v] = (nsTally[v] || 0) + 1;
  console.log('\n──── NAMESPACE VERDICTS USED ────');
  for (const [k, v] of Object.entries(nsTally)) console.log(`  ${k}: ${v}`);
  if (nsTally.unknown) console.log(`  ⚠ ${nsTally.unknown} unknown — TRANSPORT, not an answer. Those cases were SKIPPED.`);

  const out = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    reports: REPORTS, minGames: MIN_GAMES,
    reversal: 'for each entry in corrected[], write players/aliases/<shard>.json[key] = from',
    corrected: fixed, routedToSeeder, skipped, namespaceTally: nsTally,
  };
  fs.writeFileSync(LOG_FILE, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${LOG_REL}`);

  if (!APPLY) {
    console.log('\nDRY RUN — no alias was written. Re-run with apply to write.');
    await gitCommit(`alias correction: dry run, ${fixed.length} would be corrected, ${skipped.length} skipped`, [LOG_REL]);
  } else {
    const paths = [LOG_REL, ...new Set(fixed.filter(f => f.shard).map(f => f.shard))];
    await gitCommit(`alias correction: ${fixed.length} aliases repointed to the profile PlayHQ pairs them with`, paths);
    console.log('\nNEXT: build-player-games, then Post-Drain Chain from search. An alias change');
    console.log('moves appearances between players, so games[] and everything built on it are stale.');
  }
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch(e => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
