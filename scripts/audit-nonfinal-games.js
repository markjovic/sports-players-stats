// scripts/audit-nonfinal-games.js
// REVISION 2026-09-10e — spreads the sample across rounds instead of taking the
// first N, and counts unallocated placeholder fixtures.
//
// READ-ONLY. Counts every game that has not reached a terminal state, splits them by
// whether their season is locked, then asks PlayHQ's CANONICAL record what it says
// about a sample of the frozen ones.
//
// WRITES NOTHING. No fs.writeFileSync, no git, no commit. Safe to run twice.
//
// WHY THE FIRST TWO REVISIONS WERE WORTHLESS
// ──────────────────────────────────────────
// They asked gradeRounds(gradeID) -> discoverFixtureByRound(roundID), the pair the
// nightly uses to walk a season's fixtures. Every grade returned discoverGrade: null
// and not one game was ever asked about.
//
// The documentation says why, and it should have been read first.
// REPO_MANIFEST §1629 and OUTSTANDING_TASKS §352: `spectator.playhq.com` is PlayHQ's
// LIVE-SCORING service and holds only games scored in real time; `api.playhq.com`'s
// gameView -> discoverGame is the CANONICAL record and holds everything, including
// games scored on paper and entered afterwards. Roster capture has read spectator
// exclusively since it was written.
//
// So `LIVE` is a spectator-service status. Those games were reached through a
// live-scoring or player route, NOT through a grade listing — which is exactly why
// the grade endpoint knows nothing about their grades. Asking it was a category
// error, and the numbers it returned were zeros with no meaning.
//
// WHAT THIS ASKS INSTEAD
// ──────────────────────
// discoverGame(gameID) per game, via the gameView operation. That is the canonical
// record, it is keyed by the game id we already hold, and it needs no grade, no round
// and no season listing. gqlGameView, GV_QUERY, doFetch, HEADERS_MAIN and
// refreshSession below are COPIED VERBATIM from discover-game-backfill.js — the live
// script that makes exactly this class of call, already exercised against the real
// API for exactly this purpose. Nothing is retyped or trimmed: a partial PlayHQ query
// breaks silently.
//
// CONCURRENCY 5, AND IT SHOULD STAY. discover-game-backfill.js measured it on
// 2026-08-11: 25 ran a 98% hit rate for ~140 games then hit a wall it never recovered
// from; 5 ran 200/200 clean in 52 seconds. The nightly depends on this same endpoint,
// so provoking a throttling regime here damages far more than this audit.
//
// WHAT IT MEASURED (2026-09-10)
// ─────────────────────────────
//   LIVE          47,807   every single one in a LOCKED season, none unlocked
//   PENDING       14,722   13,968 locked
//   PRE_GAME       1,269   all locked
//   IN_PROGRESS      515   441 locked
//   (absent)         113    47 locked
// Locked seasons are skipped by the nightly, so a non-final game inside one is frozen
// permanently. The worst offenders cluster hard on Winter 2022 and Spring 2021 and
// carry no endDate — they are among the 808 seasons no organisation returned in the
// 2026-09-08 backfill.
//
// FULL CHECKOUT, NOT SPARSE. It reads every file in games/bv — 1.94 GB across 2,966
// files. Sparse checkout fetches roughly one blob per second, so naming them all is
// slower than cloning. A full checkout takes about seven minutes on a runner.
//
// A CONCLUSION IS ONLY DRAWN FROM QUESTIONS THAT WERE ACTUALLY PUT. If nothing was
// asked, it says so and refuses to interpret the zeros. Revision a printed
// "nothing is frozen here" on the back of eight seasons and zero questions.
//
// Run:
//   node scripts/audit-nonfinal-games.js --count-only
//   node scripts/audit-nonfinal-games.js
//   node scripts/audit-nonfinal-games.js --max-seasons=20 --per-season=10
//   node scripts/audit-nonfinal-games.js --status=LIVE

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT       = path.join(__dirname, '..');
const INDEX_FILE = path.join(ROOT, 'data', 'sports-index.json');
const GAMES_DIR  = path.join(ROOT, 'games', 'bv');
const API_URL    = 'https://api.playhq.com/graphql';

const args   = process.argv.slice(2);
const argVal = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const COUNT_ONLY  = args.includes('--count-only');
const MAX_SEASONS = Math.max(1, parseInt(argVal('max-seasons', '10'), 10) || 10);
const PER_SEASON  = Math.max(1, parseInt(argVal('per-season', '8'), 10) || 8);
const ONLY_STATUS = argVal('status', '').trim();

const log   = (m) => console.log(`[nonfinal] ${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Allowlist, never a test for a specific non-terminal value. Real data uses statuses
// nobody anticipated, and testing for `st === 'UPCOMING'` once counted zero unplayed
// games in a season holding three (T53).
const TERMINAL = new Set(['FINAL', 'CANCELLED', 'ABANDONED', 'FORFEIT']);

// ─── Everything below to the end of gqlGameView is COPIED VERBATIM from
//     scripts/discover-game-backfill.js. Do not edit it here. ──────────────────
// ⚠️ 2026-10-05 — REWRITTEN FROM https.request TO fetch(). THE CLIENT WAS THE KEY.
// measure-playhq-limits.js --mode=compare, one runner, 10 s apart, same URL, same five
// headers, same user-agent: fetch() GRANTED, https.request REFUSED (403 CLOUDFRONT-BLOCK),
// fetch() GRANTED. REPO_MANIFEST §6.61. nightly-crawl.js's doFetch, pasted VERBATIM.
// ⚠️ DO NOT "OPTIMISE" THIS BACK TO https.request, AND DO NOT SET content-length BY HAND.
// Resolves on ANY status — never throws for a 403. Returns { status, rawCookies, body, rawText }.
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

// ─── Session — nightly-crawl.js, verbatim ─────────────────────────────────────

const HEADERS_MAIN = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};
let sessionCookie = null;

async function refreshSession() {
  const body = { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const { rawCookies, status, rawText } = await doFetch(API_URL, body, HEADERS_MAIN);
      if (!rawCookies) {
        // 2026-10-05 §6.62 — closes the 2026-09-29 instrumentation gap: doFetch resolves
        // on ANY status, so a CloudFront block page was logged as nothing at all. Shape
        // copied from nightly-crawl.js refreshSession(). Logging only; no behaviour change.
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
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    } catch (_) {}
  }
  throw new Error('Failed to obtain session after 10 attempts');
}

// ─── Spectator query — nightly-crawl.js, verbatim ─────────────────────────────

// ─── gameView (api.playhq.com) ────────────────────────────────────────────────
// Query VERBATIM from a live browser request captured 2026-08-11. NOT trimmed: a
// partial PlayHQ query breaks silently (house rule), so the whole operation with
// every fragment is sent exactly as the site sends it; we simply read the few
// fields we need from the response.
const GV_QUERY = "query gameView($gameId: ID!, $gameStatisticsFilter: GameStatisticsFilter!) {\n  discoverGame(gameID: $gameId) {\n    id\n    alias\n    away {\n      ...TeamFragment\n      __typename\n    }\n    home {\n      ...TeamFragment\n      __typename\n    }\n    result {\n      winner {\n        name\n        value\n        __typename\n      }\n      outcome {\n        name\n        value\n        __typename\n      }\n      home {\n        score\n        outcome {\n          name\n          value\n          __typename\n        }\n        statistics {\n          count\n          type {\n            value\n            __typename\n          }\n          __typename\n        }\n        periods {\n          period {\n            label\n            value\n            __typename\n          }\n          type\n          closureStatus\n          statistics {\n            count\n            type {\n              label\n              value\n              __typename\n            }\n            __typename\n          }\n          __typename\n        }\n        gameOutcomeDescription\n        revisedTarget {\n          type\n          runs\n          overLimit\n          __typename\n        }\n        __typename\n      }\n      away {\n        score\n        outcome {\n          name\n          value\n          __typename\n        }\n        statistics {\n          count\n          type {\n            value\n            __typename\n          }\n          __typename\n        }\n        periods {\n          period {\n            label\n            value\n            __typename\n          }\n          type\n          closureStatus\n          statistics {\n            count\n            type {\n              label\n              value\n              __typename\n            }\n            __typename\n          }\n          __typename\n        }\n        revisedTarget {\n          type\n          runs\n          overLimit\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    status {\n      name\n      value\n      __typename\n    }\n    round {\n      id\n      name\n      abbreviatedName\n      grade {\n        id\n        name\n        day {\n          name\n          value\n          __typename\n        }\n        hideScores\n        season {\n          id\n          name\n          competition {\n            id\n            name\n            organisation {\n              ...OrganisationDetails\n              __typename\n            }\n            __typename\n          }\n          __typename\n        }\n        gameEvents {\n          participantEvents {\n            type\n            label\n            shortName\n            value\n            pointValue\n            applicableTo\n            advanced\n            __typename\n          }\n          periodEvents {\n            value\n            __typename\n          }\n          __typename\n        }\n        hasPeriodScores\n        periodScoresDisplayType {\n          name\n          value\n          __typename\n        }\n        periods {\n          shortName\n          value\n          __typename\n        }\n        playerPoints {\n          enforceTeamTotalCap\n          teamPlayerPointsCap\n          publicVisible\n          __typename\n        }\n        bestPlayers {\n          max\n          __typename\n        }\n        gameStatisticsConfiguration {\n          gameStatistics(filter: $gameStatisticsFilter) {\n            type\n            glossary {\n              default {\n                name\n                shortName\n                message\n                labelName\n                __typename\n              }\n              scoring {\n                name\n                shortName\n                message\n                labelName\n                __typename\n              }\n              __typename\n            }\n            value\n            pointValue\n            applicableTo\n            required\n            max\n            __typename\n          }\n          __typename\n        }\n        lineupRemainsWhenGameStarted\n        __typename\n      }\n      __typename\n    }\n    date\n    dates\n    allocation {\n      time\n      dateTimeList {\n        date\n        time\n        __typename\n      }\n      court {\n        id\n        abbreviatedName\n        name\n        venue {\n          id\n          name\n          latitude\n          longitude\n          address\n          suburb\n          state\n          postcode\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    statistics {\n      home {\n        ...GameViewGameTeamStatisticsFragment\n        __typename\n      }\n      away {\n        ...GameViewGameTeamStatisticsFragment\n        __typename\n      }\n      shared {\n        period {\n          label\n          shortName\n          value\n          __typename\n        }\n        type\n        status\n        statistics {\n          count\n          type {\n            value\n            __typename\n          }\n          __typename\n        }\n        side\n        players {\n          playerID\n          teamID\n          role\n          __typename\n        }\n        dismissalType\n        displayOrder\n        __typename\n      }\n      __typename\n    }\n    publishLineup\n    gameType {\n      name\n      value\n      maxBattersPerInnings\n      eScoringSettings {\n        dismissalsPerBatter\n        legalBallsPerOver\n        __typename\n      }\n      emergencyPlayersSettings {\n        enabled\n        __typename\n      }\n      playerPositionsSettings {\n        isInGamePositionsLineupVisible\n        __typename\n      }\n      clockType\n      __typename\n    }\n    formation {\n      template\n      __typename\n    }\n    __typename\n  }\n  tenantConfiguration {\n    label\n    statistics {\n      enabled\n      __typename\n    }\n    showPlayerPositionsInLineup\n    showDuckIconInBattingTable\n    periodType {\n      value\n      __typename\n    }\n    gameTypes {\n      gameType {\n        value\n        __typename\n      }\n      gameTypeFeatures {\n        lineupOrderingEnabled\n        __typename\n      }\n      __typename\n    }\n    ...TenantContactRolesConfiguration\n    __typename\n  }\n}\n\nfragment TeamFragment on DiscoverPossibleTeam {\n  ... on ProvisionalTeam {\n    name\n    pool {\n      id\n      name\n      __typename\n    }\n    __typename\n  }\n  ...DiscoverTeamFragment\n  __typename\n}\n\nfragment DiscoverTeamFragment on DiscoverTeam {\n  id\n  name\n  logo {\n    sizes {\n      url\n      dimensions {\n        width\n        height\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  season {\n    id\n    name\n    competition {\n      id\n      name\n      __typename\n    }\n    __typename\n  }\n  organisation {\n    id\n    name\n    type\n    __typename\n  }\n  playerPointsCap\n  __typename\n}\n\nfragment OrganisationDetails on DiscoverOrganisation {\n  id\n  type\n  name\n  email\n  contactNumber\n  websiteUrl\n  address {\n    id\n    line1\n    suburb\n    postcode\n    state\n    country\n    __typename\n  }\n  logo {\n    sizes {\n      url\n      dimensions {\n        width\n        height\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  contacts {\n    id\n    firstName\n    lastName\n    position\n    email\n    phone\n    __typename\n  }\n  shopVisible\n  __typename\n}\n\nfragment GameViewGameTeamStatisticsFragment on DiscoverGameTeamStatistics {\n  players {\n    playerNumber\n    player {\n      ... on DiscoverParticipant {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        hasSeasonPermit\n        memberships {\n          ...ShortTermMembershipFields\n          __typename\n        }\n        __typename\n      }\n      ... on DiscoverParticipantFillInPlayer {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        hasSeasonPermit\n        __typename\n      }\n      ... on DiscoverGamePermitFillInPlayer {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        __typename\n      }\n      ... on DiscoverRegularFillInPlayer {\n        id\n        name\n        __typename\n      }\n      ... on DiscoverAnonymousParticipant {\n        id\n        name\n        hasGamePermit\n        hasSeasonPermit\n        __typename\n      }\n      __typename\n    }\n    statistics {\n      count\n      type {\n        value\n        __typename\n      }\n      __typename\n    }\n    periodStatistics {\n      period {\n        label\n        shortName\n        value\n        __typename\n      }\n      type\n      statistics {\n        type {\n          type\n          label\n          shortName\n          value\n          pointValue\n          applicableTo\n          advanced\n          __typename\n        }\n        count\n        details {\n          value\n          __typename\n        }\n        __typename\n      }\n      status\n      side\n      displayOrder\n      __typename\n    }\n    periods {\n      period {\n        label\n        shortName\n        value\n        __typename\n      }\n      overtimeSequenceNo\n      inGamePositions {\n        shortName\n        __typename\n      }\n      __typename\n    }\n    playerPoints\n    playerPosition {\n      positionType\n      shortName\n      order\n      __typename\n    }\n    captain {\n      name\n      shortName\n      __typename\n    }\n    lineupOrder\n    __typename\n  }\n  statistics {\n    count\n    type {\n      value\n      pointValue\n      __typename\n    }\n    __typename\n  }\n  periods {\n    period {\n      value\n      __typename\n    }\n    overtimeSequenceNo\n    statistics {\n      type {\n        value\n        __typename\n      }\n      count\n      __typename\n    }\n    teamEvents {\n      sequenceNo\n      playerID\n      statistic {\n        type {\n          value\n          __typename\n        }\n        count\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  emergencyPlayers {\n    playerNumber\n    playerPoints\n    player {\n      ... on DiscoverParticipant {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        hasSeasonPermit\n        __typename\n      }\n      ... on DiscoverParticipantFillInPlayer {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        hasSeasonPermit\n        __typename\n      }\n      ... on DiscoverGamePermitFillInPlayer {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        __typename\n      }\n      ... on DiscoverAnonymousParticipant {\n        id\n        name\n        hasGamePermit\n        hasSeasonPermit\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  bestPlayers {\n    participant {\n      ... on DiscoverParticipant {\n        id\n        profile {\n          id\n          firstName\n          lastName\n          __typename\n        }\n        __typename\n      }\n      ... on DiscoverAnonymousParticipant {\n        name\n        __typename\n      }\n      __typename\n    }\n    ranking\n    __typename\n  }\n  coinTossWinningResult {\n    preference\n    __typename\n  }\n  __typename\n}\n\nfragment ShortTermMembershipFields on Membership {\n  history {\n    startDate\n    expiryDate\n    purchaseDate\n    __typename\n  }\n  categoryBasedFee {\n    tenantPeriod {\n      period\n      isShortTerm\n      __typename\n    }\n    __typename\n  }\n  organisation {\n    id\n    type\n    name\n    __typename\n  }\n  __typename\n}\n\nfragment TenantContactRolesConfiguration on TenantConfiguration {\n  contactRoles {\n    name\n    value\n    __typename\n  }\n  __typename\n}\n";

// Concurrency: this is the MAIN api, not spectator, and this query is HEAVY — an
// ~11 KB operation returning a large document, so it is nothing like the same
// number of concurrent calls against publicProfileStatistics.
// MEASURED 2026-08-11: 25 ran a 98% hit rate for ~140 games and then hit a wall
// it never recovered from — sustained 403s, the retry path refreshing the session
// over and over, transient failures reaching ~87% of all calls. 5 ran 200/200
// clean in 52 s with zero failures. 5 IS THE DEFAULT AND SHOULD STAY: the nightly
// crawl depends on this same endpoint, so a throttling regime provoked here
// damages far more than this backfill. Raise it only with a measured probe.
const CONCURRENCY_GAMEVIEW = Number((process.argv.find(a => a.startsWith('--concurrency=')) || '').replace('--concurrency=', '')) || 5;

// Same classified-outcome contract as gqlSpectator below.
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


// ─── End of the verbatim block. ──────────────────────────────────────────────

async function main() {
  log(`audit-nonfinal-games  READ-ONLY${COUNT_ONLY ? '  (COUNT ONLY — no API calls)' : ''}${ONLY_STATUS ? `  status=${ONLY_STATUS}` : ''}`);
  console.log('─'.repeat(92));

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const meta  = index.seasons || {};

  // ── Phase 1: count. No network. This alone answers "is anything frozen". ───
  const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
  let totalGames = 0, filesRead = 0, noMeta = 0;
  const byStatus = new Map();
  const perSeason = [];
  // Unallocated-fixture counters. See the note in the scan loop.
  const ph = { total: 0, noDate: 0, noVenue: 0, noTeams: 0, placeholder: 0, lockedPh: 0, byStatus: {} };

  for (const fname of files) {
    const sid = fname.replace('.json', '');
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); } catch { continue; }
    filesRead++;
    const entries = Object.entries(gf.games || {});
    totalGames += entries.length;

    const s = meta[sid];
    const bucket = !s ? 'unknown' : (s.locked === true ? 'locked' : 'unlocked');
    if (!s) noMeta++;

    const nonFinalIds = [];
    const statuses = {};
    for (const [gid, g] of entries) {
      const st = g.st === undefined ? '(absent)' : String(g.st);
      if (!byStatus.has(st)) byStatus.set(st, { locked: 0, unlocked: 0, unknown: 0 });
      byStatus.get(st)[bucket]++;
      if (TERMINAL.has(st)) continue;
      if (ONLY_STATUS && st !== ONLY_STATUS) continue;

      // A game PlayHQ generated and never allocated: no date, no venue, no court.
      // Seen 2026-09-10 in EDJBA Winter 2023 — "z3 vs z4", date TBC, venue TBC, no
      // line-up. That is a draw slot, not a fixture anybody failed to score, and
      // counting it as an uncaptured game overstates the gap by however many there
      // are.
      const noDate = !g.d, noVenue = !g.vid, noCourt = !g.ct;
      const noTeams = !(g.h || g.t1) && !(g.a || g.t2);
      const placeholder = noDate && noVenue && noCourt;
      ph.total++;
      if (noDate)      ph.noDate++;
      if (noVenue)     ph.noVenue++;
      if (noTeams)     ph.noTeams++;
      if (placeholder) { ph.placeholder++; ph.byStatus[st] = (ph.byStatus[st] || 0) + 1; if (bucket === 'locked') ph.lockedPh++; }

      // rn carries the round, and it is what makes a spread sample possible.
      nonFinalIds.push({ gid, st, rn: g.rn || null, placeholder });
      statuses[st] = (statuses[st] || 0) + 1;
    }
    if (nonFinalIds.length) perSeason.push({ sid, locked: bucket === 'locked', nonFinalIds, total: entries.length, statuses, s });
  }

  console.log(`  games files read      : ${filesRead} of ${files.length}`);
  console.log(`  games                 : ${totalGames}`);
  if (noMeta) console.log(`  ⚠ games files with NO season in the index : ${noMeta}`);

  console.log(`\n─── EVERY STATUS, SPLIT BY WHETHER ITS SEASON IS LOCKED ────────────────────────`);
  console.log(`    ${'status'.padEnd(14)} ${'locked'.padStart(10)} ${'unlocked'.padStart(10)} ${'no season'.padStart(10)} ${'total'.padStart(11)}`);
  const rows = [...byStatus].sort((a, b) => (b[1].locked + b[1].unlocked + b[1].unknown) - (a[1].locked + a[1].unlocked + a[1].unknown));
  let frozen = 0, recoverable = 0;
  for (const [st, c] of rows) {
    const t = c.locked + c.unlocked + c.unknown;
    const flag = TERMINAL.has(st) ? '' : (c.locked ? '   ← FROZEN: the nightly will never revisit these' : '   (still crawled)');
    console.log(`    ${st.padEnd(14)} ${String(c.locked).padStart(10)} ${String(c.unlocked).padStart(10)} ${String(c.unknown).padStart(10)} ${String(t).padStart(11)}${flag}`);
    if (!TERMINAL.has(st)) { frozen += c.locked; recoverable += c.unlocked + c.unknown; }
  }

  console.log(`\n${'═'.repeat(92)}`);
  console.log(`  non-final in LOCKED seasons   : ${frozen}   ← frozen; only unlocking or a targeted fetch reaches them`);
  console.log(`  non-final in unlocked seasons : ${recoverable}   ← tonight's nightly still covers these`);
  console.log(`${'═'.repeat(92)}`);

  console.log(`\n─── ARE THE NON-FINAL GAMES REAL FIXTURES? ─────────────────────────────────────`);
  console.log(`    non-final games examined  : ${ph.total}`);
  console.log(`    no date                   : ${ph.noDate}   (${(ph.noDate / Math.max(1, ph.total) * 100).toFixed(1)}%)`);
  console.log(`    no venue                  : ${ph.noVenue}`);
  console.log(`    no teams on either side   : ${ph.noTeams}`);
  console.log(`    UNALLOCATED PLACEHOLDERS  : ${ph.placeholder}   no date AND no venue AND no court`);
  console.log(`      of those, in locked seasons : ${ph.lockedPh}`);
  console.log(`      by status                   : ${Object.entries(ph.byStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`);
  console.log(`    A placeholder is a draw slot PlayHQ generated and never allocated — "z3 vs z4",`);
  console.log(`    date TBC, venue TBC, no line-up. Not a game anybody failed to capture.`);

  const lockedSeasons = perSeason.filter(x => x.locked).sort((a, b) => b.nonFinalIds.length - a.nonFinalIds.length);
  console.log(`\n─── WORST LOCKED SEASONS ───────────────────────────────────────────────────────`);
  if (!lockedSeasons.length) console.log('    (none — nothing is frozen)');
  for (const x of lockedSeasons.slice(0, 25)) {
    const st = Object.entries(x.statuses).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`    ${x.sid}  ${String(x.nonFinalIds.length).padStart(6)}/${String(x.total).padEnd(6)} non-final  ended ${String(x.s?.endDate || '?').padEnd(10)}  ${st.slice(0, 30).padEnd(30)}  ${(x.s?.fullName || '').slice(0, 34)}`);
  }
  if (lockedSeasons.length > 25) console.log(`    … and ${lockedSeasons.length - 25} more`);

  if (COUNT_ONLY || !lockedSeasons.length) {
    if (COUNT_ONLY) log('count only — PlayHQ was not asked. Drop --count-only to check the canonical record.');
    else log('nothing frozen — nothing to ask PlayHQ about.');
    return;
  }

  // ── Phase 2: ask the CANONICAL record, per game. ──────────────────────────
  // No grades, no rounds, no season listing — just the game id we already hold.
  const queue = lockedSeasons.slice(0, MAX_SEASONS);
  // ⚠️ THE SAMPLE USED TO BE `.slice(0, PER_SEASON)` — THE FIRST N IN FILE ORDER,
  // WHICH IS CONSECUTIVE GAMES FROM THE SAME ROUND. Eight fixtures in one round share
  // a state, so eight agreeing answers were closer to ONE observation than eight, and
  // the per-season 8/8 uniformity was an artefact of the sampling rather than
  // evidence for it. Spotted 2026-09-10 when all six sampled URLs from one season
  // turned out to be consecutive EDJBA games, several in the same round.
  //
  // Now: one game per distinct round, round-robin, so N samples means N different
  // parts of the season. A season with no `rn` falls back to evenly spaced indices
  // across the whole list — still spread, never clustered.
  function spread(list, k) {
    const byRound = new Map();
    for (const g of list) {
      const key = g.rn || '(none)';
      if (!byRound.has(key)) byRound.set(key, []);
      byRound.get(key).push(g);
    }
    if (byRound.size <= 1) {
      const step = Math.max(1, Math.floor(list.length / k));
      const out = [];
      for (let i = 0; i < list.length && out.length < k; i += step) out.push(list[i]);
      return out;
    }
    const rounds = [...byRound.values()];
    const out = [];
    for (let depth = 0; out.length < k; depth++) {
      let added = false;
      for (const r of rounds) {
        if (r[depth]) { out.push(r[depth]); added = true; if (out.length >= k) break; }
      }
      if (!added) break;
    }
    return out;
  }

  const sample = [];
  for (const x of queue) for (const g of spread(x.nonFinalIds, PER_SEASON)) sample.push({ sid: x.sid, ...g });

  console.log(`\n─── ASKING discoverGame ABOUT ${sample.length} GAME(S) ─────────────────────────────────`);
  console.log(`    ${queue.length} season(s), up to ${PER_SEASON} games each, concurrency ${CONCURRENCY_GAMEVIEW}`);
  await refreshSession();

  let stillNonFinal = 0, nowFinished = 0, gone = 0, failed = 0;
  const bySeason = new Map();
  const examples = [];
  // ⚠️ ids were sampled for the FINISHED bucket only, and that bucket has been empty
  // on every run — so the log named no game at all and a season could not be checked
  // by hand without opening a games file. Every outcome now carries examples.
  const sampleIds = { still: [], gone: [], failed: [] };
  const GC = (gid) => `https://www.playhq.com/basketball-victoria/org/a/a/a/game-centre/${gid}`;

  for (let i = 0; i < sample.length; i += CONCURRENCY_GAMEVIEW) {
    const batch = sample.slice(i, i + CONCURRENCY_GAMEVIEW);
    const results = await Promise.all(batch.map(async (item) => ({ item, r: await gqlGameView(item.gid) })));
    for (const { item, r } of results) {
      if (!bySeason.has(item.sid)) bySeason.set(item.sid, { asked: 0, still: 0, done: 0, gone: 0, fail: 0 });
      const b = bySeason.get(item.sid);
      b.asked++;
      if (!r.ok) {
        // permanent means PlayHQ does not hold the game at all — a real answer.
        // Anything else is a failure to ask and is never counted as one.
        if (r.permanent) { gone++; b.gone++; if (sampleIds.gone.length < 6) sampleIds.gone.push({ ...item, why: r.why }); }
        else             { failed++; b.fail++; if (sampleIds.failed.length < 6) sampleIds.failed.push({ ...item, why: r.why }); }
        continue;
      }
      const theirs = r.game?.status?.value || '(none)';
      const hs = r.game?.result?.home?.score, as = r.game?.result?.away?.score;
      const hasScore = hs != null || as != null;
      if (TERMINAL.has(String(theirs)) || hasScore) {
        nowFinished++; b.done++;
        if (examples.length < 20) examples.push({ sid: item.sid, gid: item.gid, ours: item.st, theirs, score: hasScore ? `${hs}-${as}` : 'none' });
      } else {
        stillNonFinal++; b.still++;
        if (sampleIds.still.length < 6) sampleIds.still.push({ ...item, theirs });
      }
    }
    await sleep(200);
  }

  console.log('');
  for (const x of queue) {
    const b = bySeason.get(x.sid);
    if (!b) continue;
    const answered = b.still + b.done + b.gone;
    if (answered === 0) { console.log(`  ${x.sid}  ⚠ NOTHING ANSWERED — ${b.fail} call(s) failed, no result either way`); continue; }
    console.log(`  ${x.sid}  asked ${String(b.asked).padStart(4)}  →  still non-final ${String(b.still).padStart(4)}   FINISHED at PlayHQ ${String(b.done).padStart(4)}   not held by PlayHQ ${String(b.gone).padStart(4)}   failures ${b.fail}`);
  }

  const answeredTotal = stillNonFinal + nowFinished + gone;
  console.log(`\n${'═'.repeat(92)}`);
  console.log(`  games asked about         : ${sample.length}`);
  console.log(`  still non-final at PlayHQ : ${stillNonFinal}   → PlayHQ never completed it either; nothing to recover`);
  console.log(`  FINISHED at PlayHQ        : ${nowFinished}   → WE MISSED IT. A real capture gap.`);
  console.log(`  not held by PlayHQ at all : ${gone}   → the game no longer exists upstream`);
  console.log(`  failed (no answer)        : ${failed}   ← NOT a finding either way`);
  console.log(`${'═'.repeat(92)}`);

  if (examples.length) {
    console.log(`\n  games PlayHQ HAS A RESULT for that we hold as non-final — check these first:`);
    for (const e of examples) console.log(`    ${e.sid}  ours=${e.ours} playhq=${e.theirs} score=${e.score}\n      ${GC(e.gid)}`);
  }
  if (sampleIds.still.length) {
    console.log(`\n  STILL SERVED but never completed — open these to see a live PlayHQ page:`);
    for (const e of sampleIds.still) console.log(`    ${e.sid}  ours=${e.st} playhq=${e.theirs}  round=${e.rn || '?'}${e.placeholder ? '  ⚠ UNALLOCATED (no date/venue/court)' : ''}\n      ${GC(e.gid)}`);
  }
  if (sampleIds.gone.length) {
    console.log(`\n  NOT HELD by PlayHQ — these should 404 or redirect:`);
    for (const e of sampleIds.gone) console.log(`    ${e.sid}  ours=${e.st}  (${e.why})  round=${e.rn || '?'}${e.placeholder ? '  ⚠ UNALLOCATED' : ''}\n      ${GC(e.gid)}`);
  }
  if (sampleIds.failed.length) {
    console.log(`\n  FAILED to answer — re-run; these are not a finding:`);
    for (const e of sampleIds.failed) console.log(`    ${e.sid}  ours=${e.st}  (${e.why})`);
  }

  // A conclusion may only be drawn from questions that were actually answered.
  if (answeredTotal === 0) {
    console.log(`\n  \u26a0 NOT ONE GAME WAS ANSWERED. This run establishes NOTHING — do not read the`);
    console.log(`    zeros above as a finding. ${failed} call(s) failed. Re-run.`);
  } else if (nowFinished > 0) {
    const pct = (nowFinished / answeredTotal * 100).toFixed(1);
    console.log(`\n  \u26a0 ${nowFinished} of ${answeredTotal} answered (${pct}%) ARE FINISHED at PlayHQ and non-final here,`);
    console.log(`    inside LOCKED seasons the nightly will never revisit. That is a real capture`);
    console.log(`    gap. Scaled across ${frozen} frozen games it is roughly ${Math.round(frozen * nowFinished / answeredTotal)}.`);
    console.log(`    Reopen the affected seasons by clearing locked/lockedAt/lockedReason, or`);
    console.log(`    backfill them per game — discover-game-backfill.js already does exactly this.`);
  } else {
    // ⚠️ THIS USED TO SAY "PlayHQ itself never completed" FOR EVERYTHING, WHICH IS
    // TRUE OF ONLY ONE OF THE TWO OUTCOMES. On 2026-09-10, 320 games across 40
    // seasons split 232 not-held / 88 still-non-final — and the split was perfectly
    // clean, every season 8/8 one way or 8/8 the other. Those are different facts
    // about different competitions and collapsing them into one sentence is how a
    // summary line gets quoted back later as the finding.
    console.log(`\n  Nothing PlayHQ holds a result for is frozen here, across ${answeredTotal} answered game(s).`);
    console.log(`  Two DIFFERENT reasons, and they are not interchangeable:`);
    if (gone) {
      console.log(`    ${gone} game(s) are NOT HELD BY PLAYHQ AT ALL — the competition has been withdrawn`);
      console.log(`      upstream. There is nothing to fetch, now or ever, and we hold the only copy.`);
      console.log(`      These correlate with seasons showing no endDate: no organisation lists them.`);
    }
    if (stillNonFinal) {
      console.log(`    ${stillNonFinal} game(s) ARE still served and PlayHQ still calls them non-final —`);
      console.log(`      run and never scored. Same finding as the PENDING work on 2026-09-08`);
      console.log(`      (685 asked, 0 finished), reached through a different endpoint.`);
    }
    console.log(`  Both lead to the same decision: nothing is recoverable, and locking cost nothing.`);
  }
  log('read-only — nothing written, nothing committed.');
}

main().catch(err => { console.error(`FATAL: ${err.stack || err.message}`); process.exit(1); });
