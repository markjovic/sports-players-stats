#!/usr/bin/env node
// backfill-hidden-games.js
/**
 * Enriches game entries that have no score by calling the spectator endpoint
 * game(id) — which returns scores for games hidden by competition admin
 * (where discoverGame on the main API returns null).
 *
 * Three outcomes per game:
 * 1. game(id) returns data  → score stored, flag: hidden: true
 * 2. game(id) returns null  → genuinely orphaned, flag: legacy: true
 * 3. game(id) errors        → skip, retry next run
 *
 * Reads no-venue-seasons.json to target seasons with missing data.
 * Progress file: backfill-hidden-progress.json
 *
 * Usage:
 * node backfill-hidden-games.js
 * node backfill-hidden-games.js --concurrency=100
 * node backfill-hidden-games.js --season=b81be631
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const TENANT        = ARGS.tenant      || 'bv';
const TENANT_FULL   = { bv: 'basketball-victoria' }[TENANT] || TENANT;
const CONCURRENCY   = parseInt(ARGS.concurrency || '100', 10);
const TARGET_SEASON = ARGS.season      || null;
const REVIEW_LEGACY   = !!ARGS['review-legacy'];   // re-probe legacy games via discoverGame for forfeits
const REVIEW_UNSCORED = !!ARGS['review-unscored']; // probe ALL unscored unflagged games via discoverGame

// Two separate endpoints with different purposes:
//   API_URL       — main GraphQL API, used to get session cookie
//   SPECTATOR_URL — live scoring engine, returns data even for admin-hidden games
const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';

const GAMES_DIR     = path.join(__dirname, 'games', TENANT);
const COOKIE_FILE   = path.join(__dirname, 'backfill-hidden-cookie.json');
const PROGRESS_FILE = path.join(__dirname, 'backfill-hidden-progress.json');
const NO_VENUE_FILE = path.join(__dirname, 'no-venue-seasons.json');
const VENUE_DIR     = path.join(__dirname, 'venue-lookup');

// Headers for the main API (basketball-victoria tenant, long form)
const HEADERS_API = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT_FULL,
  'content-type': 'application/json',
};

// Headers for the spectator endpoint (short tenant 'bv' + x-phq-tenant)
const HEADERS_SPECTATOR = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT,
  'x-phq-tenant': TENANT,
  'content-type': 'application/json',
};

// ─── Session cookie ───────────────────────────────────────────────────────────
// The cookie is obtained by hitting the main API with any valid query.
// The Set-Cookie response header gives us phq_session, which we also use
// for the spectator endpoint (along with phq_sub and phq_tier).
//
// getSession(force=false) — pass force=true to bypass the cache and fetch fresh.
// _refreshPromise ensures only one refresh happens at a time even under
// high concurrency — other callers wait for the same promise rather than
// all hitting the API simultaneously.

let _refreshPromise = null;

async function getSession(force = false) {
  // If a refresh is already in flight, wait for it rather than firing another
  if (_refreshPromise) return _refreshPromise;

  try {
    if (!force && fs.existsSync(COOKIE_FILE)) {
      const d = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      // Reuse if less than 23 hours old (JWT expires at 24h)
      if (Date.now() - d.fetchedAt < 23 * 60 * 60 * 1000) {
        return d;
      }
    }
  } catch (e) {}

  _refreshPromise = (async () => {
    console.log('\n  Fetching fresh session cookie...');

    // Try multiple queries — the API issues a session cookie on any successful request.
    // Fall back through options if one returns 403 or no cookie.
    const cookieQueries = [
      { operationName: 'TenantConfig', variables: {},
        query: 'query TenantConfig { tenantConfiguration { label } }' },
      { operationName: 'ProfileSearch', variables: { fullName: 'a' },
        query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
    ];

    let res;
    for (const body of cookieQueries) {
      res = await fetch(API_URL, {
        method:  'POST',
        headers: { ...HEADERS_API, 'request-id': crypto.randomUUID() },
        body:    JSON.stringify(body),
      });
      if (res.headers.get('set-cookie')) {
        console.log(`  ✓ Got cookie via ${body.operationName}`);
        break;
      }
    }

    const rawCookie = res.headers.get('set-cookie');
    if (!rawCookie) throw new Error(`No Set-Cookie header from API (status ${res.status}) — all cookie queries failed`);

    // Extract phq_session=<token> from the cookie string
    const sessionMatch = rawCookie.match(/phq_session=([^;]+)/);
    if (!sessionMatch) throw new Error('phq_session not found in Set-Cookie header');

    const sessionToken  = sessionMatch[1];
    const sessionCookie = `phq_session=${sessionToken}`;

    // Decode the JWT payload to get sub (used as phq_sub value)
    let sub = '';
    try {
      const payload = JSON.parse(Buffer.from(sessionToken.split('.')[1], 'base64').toString());
      sub = payload.sub || payload.jti || '';
    } catch (e) {}

    // The spectator endpoint needs all three cookies
    const allCookies = sub
      ? `${sessionCookie}; phq_sub=${sub}; phq_tier=cookie-no-jwt`
      : sessionCookie;

    const sessionData = { sessionCookie, allCookies, sub, fetchedAt: Date.now() };
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(sessionData));
    console.log(`  ✓ Cookie obtained (sub: ${sub || 'none'})`);
    return sessionData;
  })().finally(() => { _refreshPromise = null; });

  return _refreshPromise;
}

// ─── Deduplicated Session Lock for high-concurrency batches ───────────────────
let currentCookiePromise = null;

async function safeRefreshSession() {
  if (currentCookiePromise) return currentCookiePromise;

  currentCookiePromise = (async () => {
    try {
      console.log(`\n🔄 [Deduplicated] Fetching a single fresh session cookie for this batch...`);
      const newSession = await getSession(true); 
      return newSession;
    } finally {
      currentCookiePromise = null; 
    }
  })();

  return currentCookiePromise;
}

// ─── GraphQL query for the spectator endpoint ─────────────────────────────────
const Q_GAME = `query Game($id: ID!) {
  game(id: $id) {
    id
    status
    updatedAt
    break
    clock {
      period
      periodValue
      time
      status
      lastUpdatedAt
    }
    result {
      home {
        statistics { count type { value } }
        periods(scope: BY_PERIOD) {
          period { value }
          overtimeSequenceNo
          statistics { count type { value } }
          role
          closureStatus
        }
      }
      away {
        statistics { count type { value } }
        periods(scope: BY_PERIOD) {
          period { value }
          overtimeSequenceNo
          statistics { count type { value } }
          role
          closureStatus
        }
      }
      currentPeriod { value primarySide }
    }
    statistics {
      home {
        statisticsV2 { type { value } count }
        players {
          profileID
          playerNumber
          name
          id
          statistics { count type { value pointValue type } }
          periodStatistics {
            period { value }
            statistics { count type { value } }
            status
            displayOrder
          }
        }
      }
      away {
        statisticsV2 { type { value } count }
        players {
          profileID
          playerNumber
          name
          id
          statistics { count type { value pointValue type } }
          periodStatistics {
            period { value }
            statistics { count type { value } }
            status
            displayOrder
          }
        }
      }
    }
    liveStreamingEnabled
    liveStream { url provider videoId }
  }
}`;

// ─── discoverGame query — used for review-legacy mode to detect forfeits ─────
const Q_DISCOVER_GAME = `query GameCentre($gameId: ID!) {
  discoverGame(gameID: $gameId) {
    id
    date
    status { name value }
    round { id name }
    home {
      ... on DiscoverTeam { id name logo { sizes { url dimensions { width } } } }
    }
    away {
      ... on DiscoverTeam { id name logo { sizes { url dimensions { width } } } }
    }
    result {
      winner { value }
      outcome { name value }
      home {
        outcome { name value }
        gameOutcomeDescription
        statistics { count type { value } }
      }
      away {
        outcome { name value }
        statistics { count type { value } }
      }
    }
    allocation {
      dateTimeList { date time }
      court {
        id name abbreviatedName
        venue {
          id name abbreviatedName latitude longitude
          address suburb state postcode country
        }
      }
    }
  }
}`;

async function fetchGame(gameId, cookieString) {
  try {
    const res = await fetch(SPECTATOR_URL, {
      method:  'POST',
      headers: {
        ...HEADERS_SPECTATOR,
        'request-id': crypto.randomUUID(),
        'Cookie':     cookieString,
      },
      body: JSON.stringify({
        operationName: 'Game',
        variables:     { id: String(gameId) },
        query:         Q_GAME,
      }),
    });

    if (res.status === 429) {
      return { _rateLimit: true };
    }
    if (res.status === 401 || res.status === 403) {
      return { _authError: true };
    }
    if (!res.ok) {
      return { _transient: true };
    }

    const json = await res.json();

    if (json.errors?.length) {
      const msg = json.errors[0]?.message || '';
      if (msg.includes('could not be found') || msg.includes('not electronically scored')) {
        return { _legacy: true };
      }
      return { _graphqlError: true };
    }

    return json;
  } catch (e) {
    return { _transient: true };
  }
}

// ─── Score parser ─────────────────────────────────────────────────────────────

function parseScore(statistics) {
  return statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;
}

function parseQuarterScores(periods) {
  if (!periods?.length) return null;
  const order = ['FIRST_QTR', 'SECOND_QTR', 'THIRD_QTR', 'FOURTH_QTR'];
  const map = {};
  for (const p of periods) {
    const score = p.statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count;
    if (score !== undefined) map[p.period?.value] = score;
  }
  const qtrs = order.map(q => map[q] ?? null);
  return qtrs.some(q => q !== null) ? qtrs : null;
}

// ─── Venue shards ─────────────────────────────────────────────────────────────

const _venueShards  = {};
const _dirtyVenues  = new Set();

function storeVenue(venue, court) {
  if (!venue?.id) return;
  const prefix = venue.id.slice(0, 2);
  if (!_venueShards[prefix]) {
    const f = path.join(VENUE_DIR, `${prefix}.json`);
    try { _venueShards[prefix] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; }
    catch (e) { _venueShards[prefix] = {}; }
  }
  const shard = _venueShards[prefix];
  if (!shard[venue.id]) {
    shard[venue.id] = {
      name:    venue.name,
      abbr:    venue.abbreviatedName || null,
      lat:     venue.latitude        || null,
      lng:     venue.longitude       || null,
      address: venue.address         || null,
      suburb:  venue.suburb          || null,
      state:   venue.state           || null,
      postcode:venue.postcode        || null,
      country: venue.country         || null,
      courts:  {},
    };
    _dirtyVenues.add(prefix);
  }
  if (court?.id && !shard[venue.id].courts[court.id]) {
    shard[venue.id].courts[court.id] = {
      name: court.name,
      abbr: court.abbreviatedName || null,
    };
    _dirtyVenues.add(prefix);
  }
}

function flushVenueShards() {
  if (!fs.existsSync(VENUE_DIR)) fs.mkdirSync(VENUE_DIR, { recursive: true });
  for (const prefix of _dirtyVenues) {
    fs.writeFileSync(path.join(VENUE_DIR, `${prefix}.json`), JSON.stringify(_venueShards[prefix]));
  }
  _dirtyVenues.clear();
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      return { done: new Set(p.done || []), legacy: new Set(p.legacy || []) };
    }
  } catch (e) {}
  return { done: new Set(), legacy: new Set() };
}

function saveProgress(prog) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
    done:    [...prog.done],
    legacy:  [...prog.legacy],
    savedAt: new Date().toISOString(),
  }));
}

// ─── Git ──────────────────────────────────────────────────────────────────────

function gitCommitPush(message) {
  try {
    execSync('git add games/ venue-lookup/ backfill-hidden-progress.json 2>/dev/null || true', { stdio: 'pipe', shell: true });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) { return; }
    execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('\n  ✓ Committed and pushed');
  } catch (e) {
    console.warn(`\n  ⚠ Git error: ${e.message}`);
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchDiscoverGame(gameId, session) {
  try {
    const res = await fetch(API_URL, {
      method:  'POST',
      headers: { ...HEADERS_API, 'request-id': crypto.randomUUID(), 'Cookie': session.sessionCookie },
      body:    JSON.stringify({ operationName: 'GameCentre', variables: { gameId }, query: Q_DISCOVER_GAME }),
    });
    if (res.status === 429) return { _rateLimit: true };
    if (res.status === 403 || res.status === 401) return { _authError: true };
    if (!res.ok) return { _transient: true };
    const json = await res.json();
    if (json.errors) return { _graphqlError: true };
    return json;
  } catch (e) {
    return { _transient: true };
  }
}

function slugify(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[()]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Backfill Hidden Games`);
  console.log(`   Tenant:      ${TENANT} (${TENANT_FULL})`);
  console.log(`   Concurrency: ${CONCURRENCY}`);
  console.log(`   Endpoint:    ${SPECTATOR_URL}\n`);

  if (!fs.existsSync(NO_VENUE_FILE)) {
    console.error(`❌ ${NO_VENUE_FILE} not found`);
    process.exit(1);
  }

  const noVenueSeasons = JSON.parse(fs.readFileSync(NO_VENUE_FILE, 'utf8'));
  const targetSeasons  = TARGET_SEASON ? [{ id: TARGET_SEASON }] : noVenueSeasons;

  console.log(`📋 Seasons to check: ${targetSeasons.length}`);

  const prog = loadProgress();
  if (prog.done.size > 0) {
    console.log(`  ↻ Resuming — ${prog.done.size.toLocaleString()} already done, ${prog.legacy.size.toLocaleString()} flagged legacy\n`);
  }

  let session = await getSession();

  // ─── Review-legacy mode ───────────────────────────────────────────────────
  if (REVIEW_LEGACY) {
    console.log(`\n🔎 Review-legacy mode — re-probing legacy games via discoverGame\n`);

    const legacyTodo = [];
    const sgCache2 = {};
    for (const season of targetSeasons) {
      const gameFile = path.join(GAMES_DIR, `${season.id}.json`);
      if (!fs.existsSync(gameFile)) continue;
      let sg;
      try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); } catch (e) { continue; }
      sgCache2[season.id] = sg;
      for (const [gameId, game] of Object.entries(sg.games || {})) {
        if (!game.legacy) continue;
        legacyTodo.push({ seasonId: season.id, gameId });
      }
    }

    console.log(`📋 Legacy games to re-probe: ${legacyTodo.length.toLocaleString()}\n`);

    let forfeits = 0, stillLegacy = 0, accessible = 0, legacyFailed = 0, legacySinceLastSave = 0;

    for (let i = 0; i < legacyTodo.length; i += CONCURRENCY) {
      const batch = legacyTodo.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async ({ seasonId, gameId }, j) => {
        await delay(j * 3);
        const resp = await fetchDiscoverGame(gameId, session);
        if (resp?._authError) { try { session = await getSession(true); } catch (e) {} return { gameId, seasonId, type: 'skip' }; }
        if (resp?._rateLimit || resp?._transient || resp?._graphqlError) return { gameId, seasonId, type: 'skip' };
        const dg = resp?.data?.discoverGame;
        if (!dg) return { gameId, seasonId, type: 'stillLegacy' };

        const outcomeVal = dg.result?.outcome?.value || '';
        const isForfeit  = outcomeVal.includes('FORFEIT');
        const hs         = parseScore(dg.result?.home?.statistics);
        const as_        = parseScore(dg.result?.away?.statistics);
        const court = dg.allocation?.court;
        const venue = court?.venue;

        return {
          gameId, seasonId, type: isForfeit ? 'forfeit' : 'accessible',
          hs, as: as_,
          outcome:   outcomeVal,
          outcomeName: dg.result?.outcome?.name || null,
          fo: dg.result?.winner?.value?.toLowerCase() || null,
          desc: dg.result?.home?.gameOutcomeDescription || null,
          h:  dg.home?.id   || null, hn: dg.home?.name  || null,
          a:  dg.away?.id   || null, an: dg.away?.name  || null,
          rn: dg.round?.name || null,
          st: dg.status?.value || null,
          venue, court,
          time: dg.allocation?.dateTimeList?.[0]?.time?.slice(0, 5) || null,
        };
      }));

      for (const r of results) {
        if (r.type === 'skip') { legacyFailed++; continue; }
        const sg    = sgCache2[r.seasonId];
        if (!sg) continue;
        const entry = sg.games[r.gameId] || {};

        if (r.type === 'stillLegacy') {
          stillLegacy++;
          continue;
        }

        delete entry.legacy;
        prog.legacy.delete(r.gameId);

        if (r.h)  entry.h  = r.h;
        if (r.hn) entry.hn = r.hn;
        if (r.a)  entry.a  = r.a;
        if (r.an) entry.an = r.an;
        if (r.rn) entry.rn = r.rn;
        if (r.st) entry.st = r.st;

        if (r.type === 'forfeit') {
          entry.forfeit = true;
