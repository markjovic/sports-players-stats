// scripts/audit-aliases-against-playhq.js
//
// THE TEST THIS PROJECT HAS NEVER HAD.
//
// Every alias round so far assembled candidates by name-matching our OWN
// players/ directory, then picked a winner. If the correct api profile had no
// player file, or was filed under a different name, it could never be proposed
// — so the "winner" was the best of a set that may not have contained the right
// answer. That is why rounds 2 and 3 are suspect and why Max Matthews was
// confirmed on a figure taken from our own rosters.
//
// This asks a question our data cannot answer for itself. Inside ONE game,
// PlayHQ gives both:
//   spectator.playhq.com  -> profileID in the SPECTATOR namespace, with a name
//                            and a jersey number
//   api.playhq.com        -> gameView profile.id in the API namespace, with a
//                            name and the same jersey number
// Measured 2026-08-26 across 55 ids, 0 unknowns: gameView ids are api-side 18/18,
// spectator ids are not-api 18/18, controls api 19/19. Pairing the two by
// normalised name (jersey number as tiebreak when a name repeats) yields a
// spectator-id -> api-id fact SOURCED FROM PlayHQ, not from us.
//
// The audit is then one question per pair:
//   resolveToFullUuid(truncate13(spectatorId)) === apiId ?
// That is deliberately the PRODUCTION resolver, the same call build-player-games
// makes at L179, not a raw alias lookup — the thing being tested is where an
// appearance actually lands, which is indexes-then-aliases, not the alias shard
// alone. The raw alias entry is reported alongside so an index hit and an alias
// hit are distinguishable.
//
// Verdicts. Only CORRECT is fine:
//   IDENTICAL   spectator id == api id. Not diverged; nothing to get wrong.
//   CORRECT     diverged, and we resolve to the api id PlayHQ paired it with.
//   WRONG       diverged, and we resolve to a DIFFERENT person. A live
//               misattribution, with the game that proves it named.
//   UNRESOLVED  no index and no alias entry. Appearances land nowhere.
//
// It also reports DUPLICATE_IN_ROSTER: our p[] holding BOTH ids for one person,
// found in all five sampled games of season f729667e (bailey sheen). Harmless to
// build-player-games, which adds to a Set; NOT harmless to anything reading p[]
// directly — team stats, leaderboards, opposition lookup, StatTrack all see an
// extra player.
//
// WHAT IT DOES NOT DO. It writes nothing to players/, games/ or players/aliases/.
// It proposes no repoints and reverses nothing. It produces evidence; deciding
// what to do with a WRONG verdict is a separate, deliberate step.
//
// SELECTION IS NOT ALLOWED TO CHEAT. Games are chosen WITHOUT reference to spcm
// or dgm. The 2026-08-26 probe selected five games our own flags already recorded
// as spectator failures, then reported spectator failing on them as a finding; it
// was the flag being accurate and nothing more. Default selection is a stride
// across every season file, so no flag steers it.
//
// TRANSPORT AND QUERIES are copied verbatim from discover-game-backfill.js. No
// PlayHQ string in this file was written by hand. NO publicProfileStatistics call
// is made anywhere, so the ~30-call session quota on that operation is not in play.
//
// PROGRESS. Long-running and resumable: reports/alias-audit-progress.json holds
// every game already done plus the running verdicts, and is COMMITTED at every
// save interval. In-memory progress is lost on timeout. It is deleted on success
// only.

'use strict';

const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execFileSync } = require('child_process');
const { resolveToFullUuid, TRUNC_LEN } = require('./lib/uuid-prefix.cjs');
const { normName } = require('./lib/namespace-resolve.cjs');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; })
);

const DRY_RUN      = !!ARGS['dry-run'];
const MAX_GAMES    = ARGS['max-games']   ? Math.max(1, parseInt(ARGS['max-games'], 10))   : 500;
const PER_SEASON   = ARGS['per-season']  ? Math.max(1, parseInt(ARGS['per-season'], 10))  : 2;
const MIN_ROSTER   = ARGS['min-roster']  ? Math.max(0, parseInt(ARGS['min-roster'], 10))  : 6;
const CONCURRENCY  = ARGS.concurrency    ? Math.max(1, parseInt(ARGS.concurrency, 10))    : 3;
const COMMIT_EVERY = ARGS['commit-every'] ? Math.max(1, parseInt(ARGS['commit-every'], 10)) : 100;
const REPOINT_ONLY = !!ARGS['repoint-games'];
const GAMES_ARG    = typeof ARGS.games === 'string' ? ARGS.games.split(',').map(s => s.trim()).filter(Boolean) : null;
const RESET        = !!ARGS.reset;

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const GAMES_DIR     = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR   = path.join(ROOT, 'players');
const REPORTS_DIR   = path.join(ROOT, 'reports');
const OUT_FILE      = path.join(REPORTS_DIR, 'alias-vs-playhq-audit.json');
const PROGRESS_FILE = path.join(REPORTS_DIR, 'alias-audit-progress.json');
const ALIAS_LOG     = path.join(REPORTS_DIR, 'alias-repoint-log.json');

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
}
// ─── Concurrency pool — discover-game-backfill.js, verbatim ───────────────────

async function runPool(tasks, concurrency) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) { await tasks[i++](); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// ─── Row readers ──────────────────────────────────────────────────────────────
// NOT the live parseGameViewPlayers / parseSpectatorPlayers: both DROP rows with
// no profile id. Correct for a writer, wrong here — a dropped row is the fill-in
// population, which must be counted and never guessed at.

function gvRows(teamStats) {
  const rows = [];
  for (const p of ((teamStats && teamStats.players) || [])) {
    const pl   = p && p.player;
    const prof = pl && pl.profile;
    rows.push({
      profileId: (prof && prof.id) || null,
      name: prof ? [prof.firstName, prof.lastName].filter(Boolean).join(' ').trim() : ((pl && pl.name) || null),
      number: p.playerNumber ?? null,
      typename: (pl && pl.__typename) || null,
    });
  }
  return rows;
}

function specRows(teamStats) {
  const rows = [];
  for (const p of ((teamStats && teamStats.players) || [])) {
    rows.push({ profileId: p.profileID || null, name: p.name || null, number: p.playerNumber ?? null });
  }
  return rows;
}

// ─── Pairing ──────────────────────────────────────────────────────────────────
// A pair is only made when it is UNAMBIGUOUS. One spectator row with that
// normalised name -> pair it. Several -> require an exact jersey-number match, and
// if that does not single one out, make NO pair and count it as ambiguous. A wrong
// pair here would manufacture a false WRONG verdict, which is worse than no
// verdict: it would send someone reversing a correct alias.

function pairRosters(gvList, specList) {
  const pairs = [], ambiguous = [];
  const byName = new Map();
  for (const r of specList) {
    if (!r.profileId) continue;
    const k = normName(r.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  for (const r of gvList) {
    if (!r.profileId) continue;
    const k = normName(r.name);
    if (!k) continue;
    const cands = byName.get(k) || [];
    if (cands.length === 1) { pairs.push({ name: r.name, number: r.number, apiId: r.profileId, spectatorId: cands[0].profileId, by: 'name' }); continue; }
    if (cands.length > 1) {
      const m = cands.filter(c => c.number != null && r.number != null && c.number === r.number);
      if (m.length === 1) { pairs.push({ name: r.name, number: r.number, apiId: r.profileId, spectatorId: m[0].profileId, by: 'name+number' }); continue; }
      ambiguous.push({ name: r.name, number: r.number, apiId: r.profileId, candidates: cands.length });
    }
  }
  return { pairs, ambiguous };
}

// ─── The audit ────────────────────────────────────────────────────────────────

const aliasShardCache = new Map();
function rawAliasEntry(specId) {
  const shard = String(specId).slice(0, 2).toLowerCase();
  if (!aliasShardCache.has(shard)) {
    let obj = {};
    try { obj = JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, 'aliases', `${shard}.json`), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    aliasShardCache.set(shard, obj);
  }
  const m = aliasShardCache.get(shard);
  return m[t13(specId)] || null;
}

function playerFileExists(uuid) {
  if (!uuid || uuid.length !== 36) return false;
  return fs.existsSync(path.join(PLAYERS_DIR, uuid.slice(0, 2).toLowerCase(), `${uuid}.json`));
}

function playerName(uuid) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, uuid.slice(0, 2).toLowerCase(), `${uuid}.json`), 'utf8'));
    return p && p.name || null;
  } catch (e) { return null; }
}

// One pair -> one verdict. rosterIds is our stored p[] for this game.
function judge(pair, rosterT13) {
  const { spectatorId, apiId } = pair;
  const identical = spectatorId === apiId;

  let resolved = null, resolveError = null;
  try { resolved = resolveToFullUuid(t13(spectatorId), ROOT); }
  catch (e) { resolveError = e.message; }

  const alias = rawAliasEntry(spectatorId);
  const verdict = identical ? 'IDENTICAL'
                : !resolved  ? 'UNRESOLVED'
                : resolved === apiId ? 'CORRECT'
                : 'WRONG';

  const out = {
    ...pair,
    identical,
    resolvesTo: resolved,
    resolvedVia: alias ? (alias === resolved ? 'alias' : 'index-or-other') : 'index-or-none',
    rawAliasEntry: alias,
    resolveError,
    verdict,
    apiIdHasPlayerFile: playerFileExists(apiId),
    // Both ids present in OUR roster for the same person: invisible to
    // build-player-games (Set), visible as an extra player to everything that
    // reads p[] directly.
    duplicateInRoster: rosterT13.has(t13(spectatorId)) && rosterT13.has(t13(apiId)) && !identical,
    spectatorIdInRoster: rosterT13.has(t13(spectatorId)),
    apiIdInRoster: rosterT13.has(t13(apiId)),
  };
  if (verdict === 'WRONG') {
    out.weResolveToName = playerName(resolved);
    out.playhqSaysName  = pair.name;
  }
  return out;
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
// ─── Selection ────────────────────────────────────────────────────────────────
// NO reference to spc, spcm, dg or dgm. A game either has a roster we can compare
// or it does not; our own capture flags must not steer which games get audited.

function rosterIds(g) { return ((g && g.p) || []).map(x => x && x.id).filter(Boolean); }

function eligible(g) {
  if (!g) return false;
  if (g.forfeit || g.bye || g.cancelled || g.abandoned || g.legacy || g.profileOnly || g.hidden) return false;
  return rosterIds(g).length >= MIN_ROSTER;
}

function readRepointGameIds() {
  if (!fs.existsSync(ALIAS_LOG)) { console.log(`  alias-repoint-log.json absent — no repoint games`); return new Set(); }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(ALIAS_LOG, 'utf8')); }
  catch (e) { console.log(`  alias-repoint-log.json unreadable: ${e.message}`); return new Set(); }
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw.entries) ? raw.entries : null;
  if (!entries) { console.log(`  alias-repoint-log.json unrecognised shape. Top-level keys: ${Object.keys(raw).join(', ')}`); return new Set(); }
  const ids = new Set();
  for (const e of entries) for (const g of (e && e.games) || []) if (g) ids.add(String(g));
  console.log(`  alias-repoint-log.json: ${entries.length} entries listing ${ids.size} distinct games`);
  return ids;
}

function selectGames(done) {
  const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort();
  const picked = [];

  const wantExplicit = GAMES_ARG ? new Set(GAMES_ARG) : null;
  const wantRepoint  = REPOINT_ONLY ? readRepointGameIds() : null;
  const targeted     = wantExplicit || wantRepoint;

  let scanned = 0;
  for (const fname of files) {
    if (picked.length >= MAX_GAMES && !targeted) break;
    if (targeted && !targeted.size) break;
    scanned++;
    if (scanned % 400 === 0) console.log(`  scanned ${scanned}/${files.length} season files — picked ${picked.length}`);
    const sid = fname.replace('.json', '');
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); } catch { continue; }

    let takenHere = 0;
    for (const [gameId, g] of Object.entries(gf.games || {})) {
      if (targeted) {
        if (!targeted.has(gameId)) continue;
        targeted.delete(gameId);
        if (done.has(gameId) || !eligible(g)) continue;
      } else {
        if (takenHere >= PER_SEASON) break;
        if (done.has(gameId) || !eligible(g)) continue;
        if (picked.length >= MAX_GAMES) break;
      }
      picked.push({ gameId, seasonId: sid, rosterIds: rosterIds(g) });
      takenHere++;
    }
  }
  console.log(`  selection scanned ${scanned}/${files.length} season files, picked ${picked.length}`);
  if (targeted && targeted.size) console.log(`  ⚠ ${targeted.size} requested game id(s) not found in games/bv: ${[...targeted].slice(0, 10).join(', ')}`);
  return picked;
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function loadProgress() {
  if (RESET) { console.log('--reset given: ignoring any existing progress file'); return { doneGames: [], rows: [], gameNotes: [] }; }
  try {
    const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    console.log(`Resuming: ${(p.doneGames || []).length} games already audited, ${(p.rows || []).length} pairs judged`);
    return { doneGames: p.doneGames || [], rows: p.rows || [], gameNotes: p.gameNotes || [] };
  } catch (e) { return { doneGames: [], rows: [], gameNotes: [] }; }
}

function writeProgress(state) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(state));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('audit-aliases-against-playhq — PlayHQ-sourced spectator/api pairs vs our resolver\n');
  if (!fs.existsSync(GAMES_DIR)) throw new Error(`games dir not found: ${GAMES_DIR}`);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const prog = loadProgress();
  const done = new Set(prog.doneGames);
  const rows = prog.rows;
  const gameNotes = prog.gameNotes;

  console.log('Selecting games');
  const picked = selectGames(done);
  if (!picked.length) { console.log('Nothing to audit.'); }

  await refreshSession();

  let processed = 0, sinceCommit = 0;
  const tasks = picked.map(sel => async () => {
    const gv = await gqlGameView(sel.gameId);
    const sp = await gqlSpectator(sel.gameId);

    const note = { gameId: sel.gameId, seasonId: sel.seasonId,
                   gameview: gv.ok ? 'ok' : gv.why, spectator: sp.ok ? 'ok' : sp.why,
                   ourRoster: sel.rosterIds.length, pairs: 0, ambiguous: 0,
                   gvNoProfile: 0, specNoProfile: 0 };

    if (gv.ok && sp.ok) {
      const gvs = gv.game.statistics || {};
      const sps = sp.game.statistics || {};
      const gvList = [...gvRows(gvs.home), ...gvRows(gvs.away)];
      const spList = [...specRows(sps.home), ...specRows(sps.away)];
      note.gvNoProfile   = gvList.filter(r => !r.profileId).length;
      note.specNoProfile = spList.filter(r => !r.profileId).length;

      const { pairs, ambiguous } = pairRosters(gvList, spList);
      note.pairs = pairs.length;
      note.ambiguous = ambiguous.length;

      const rosterT13 = new Set(sel.rosterIds.map(t13));
      for (const p of pairs) rows.push({ gameId: sel.gameId, seasonId: sel.seasonId, ...judge(p, rosterT13) });
    }

    gameNotes.push(note);
    done.add(sel.gameId);
    processed++; sinceCommit++;

    if (processed % 25 === 0) {
      const w = rows.filter(r => r.verdict === 'WRONG').length;
      const u = rows.filter(r => r.verdict === 'UNRESOLVED').length;
      console.log(`  ${processed}/${picked.length} games · ${rows.length} pairs · WRONG ${w} · UNRESOLVED ${u}`);
    }
    if (sinceCommit >= COMMIT_EVERY) {
      sinceCommit = 0;
      writeProgress({ doneGames: [...done], rows, gameNotes });
      await gitCommit(`alias audit: progress ${processed}/${picked.length} games, ${rows.length} pairs`, ['reports/alias-audit-progress.json']);
    }
  });

  await runPool(tasks, CONCURRENCY);

  // ── Verdict tallies ─────────────────────────────────────────────────────────
  const count = v => rows.filter(r => r.verdict === v).length;
  const wrong      = rows.filter(r => r.verdict === 'WRONG');
  const unresolved = rows.filter(r => r.verdict === 'UNRESOLVED');
  const dupes      = rows.filter(r => r.duplicateInRoster);

  const totals = {
    gamesAudited: gameNotes.length,
    gameviewAnswered:  gameNotes.filter(n => n.gameview === 'ok').length,
    spectatorAnswered: gameNotes.filter(n => n.spectator === 'ok').length,
    gamesWithBothSources: gameNotes.filter(n => n.gameview === 'ok' && n.spectator === 'ok').length,
    pairsJudged: rows.length,
    ambiguousUnpaired: gameNotes.reduce((n, g) => n + g.ambiguous, 0),
    gameviewNoProfileRows:  gameNotes.reduce((n, g) => n + g.gvNoProfile, 0),
    spectatorNoProfileRows: gameNotes.reduce((n, g) => n + g.specNoProfile, 0),
    IDENTICAL:  count('IDENTICAL'),
    CORRECT:    count('CORRECT'),
    WRONG:      wrong.length,
    UNRESOLVED: unresolved.length,
    divergedPairs: count('CORRECT') + wrong.length + unresolved.length,
    duplicateInRoster: dupes.length,
    distinctWrongSpectatorIds: new Set(wrong.map(r => t13(r.spectatorId))).size,
    distinctDuplicatePeople:   new Set(dupes.map(r => t13(r.spectatorId))).size,
  };

  console.log('\n──── TOTALS ────');
  for (const [k, v] of Object.entries(totals)) console.log(`  ${k}: ${v}`);

  // A counter without examples is a number that cannot be checked.
  console.log('\n──── WRONG (our resolver lands on a different person) ────');
  if (!wrong.length) console.log('  none');
  for (const r of wrong.slice(0, 40)) {
    console.log(`  ${r.gameId} · ${r.playhqSaysName} #${r.number}`);
    console.log(`      spectator ${r.spectatorId}  PlayHQ pairs it with api ${r.apiId}`);
    console.log(`      we resolve to ${r.resolvesTo} (${r.weResolveToName || 'no name'}) via ${r.resolvedVia}, alias entry ${r.rawAliasEntry || 'none'}`);
  }
  if (wrong.length > 40) console.log(`  … and ${wrong.length - 40} more, all in the report`);

  console.log('\n──── UNRESOLVED (appearances land nowhere) ────');
  if (!unresolved.length) console.log('  none');
  for (const r of unresolved.slice(0, 20)) {
    console.log(`  ${r.gameId} · ${r.name} #${r.number} · spectator ${r.spectatorId} · PlayHQ api ${r.apiId} · api file exists: ${r.apiIdHasPlayerFile}`);
  }
  if (unresolved.length > 20) console.log(`  … and ${unresolved.length - 20} more`);

  console.log('\n──── DUPLICATE IN ROSTER (p[] holds both ids for one person) ────');
  if (!dupes.length) console.log('  none');
  for (const r of dupes.slice(0, 20)) {
    console.log(`  ${r.gameId} · ${r.name} #${r.number} · spectator ${r.spectatorId} AND api ${r.apiId} both in p[]`);
  }
  if (dupes.length > 20) console.log(`  … and ${dupes.length - 20} more`);

  console.log('\nHOW TO READ THIS. WRONG is the only verdict that means an alias is');
  console.log('misdirecting appearances, and each one names the game that proves it.');
  console.log('IDENTICAL means the person is not diverged and no alias could be wrong.');
  console.log('ambiguousUnpaired is pairs NOT made because two people in one game share a');
  console.log('name and no jersey number separated them — those are untested, not clean.');
  console.log('Games where either source failed produced no pairs and are listed in the report.');

  const out = {
    generatedAt: new Date().toISOString(),
    args: { maxGames: MAX_GAMES, perSeason: PER_SEASON, minRoster: MIN_ROSTER,
            concurrency: CONCURRENCY, repointGames: REPOINT_ONLY, games: GAMES_ARG },
    totals,
    wrong,
    unresolved,
    duplicateInRoster: dupes,
    rows,
    gameNotes,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));   // a REPORT, not player data — indented on purpose
  console.log(`\nWrote ${path.relative(ROOT, OUT_FILE)}`);

  writeProgress({ doneGames: [...done], rows, gameNotes });
  await gitCommit(`alias audit: ${totals.gamesAudited} games, ${totals.pairsJudged} pairs, ${totals.WRONG} wrong, ${totals.UNRESOLVED} unresolved`,
                  ['reports/alias-vs-playhq-audit.json', 'reports/alias-audit-progress.json']);

  // Progress file deleted on SUCCESS only — house rule.
  if (!DRY_RUN) {
    try {
      fs.unlinkSync(PROGRESS_FILE);
      execFileSync('git', ['rm', '--cached', '-q', '--', 'reports/alias-audit-progress.json'], { stdio: 'pipe', cwd: ROOT });
      await gitCommit('alias audit: run complete, progress file removed', ['reports/alias-audit-progress.json']);
    } catch (e) { console.log(`  (progress file cleanup skipped: ${e.message.split('\n')[0]})`); }
  }

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch(e => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
