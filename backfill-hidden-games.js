#!/usr/bin/env node
// backfill-hidden-games.js
/**
 * Enriches game entries that have no score by calling the spectator endpoint
 * game(id) — which returns scores for games hidden by competition admin
 * (where discoverGame on the main API returns null).
 *
 * Three outcomes per game:
 *   1. game(id) returns data  → score stored, flag: hidden: true
 *   2. game(id) returns null  → genuinely orphaned, flag: legacy: true
 *   3. game(id) errors        → skip, retry next run
 *
 * Reads no-venue-seasons.json to target seasons with missing data.
 * Progress file: backfill-hidden-progress.json
 *
 * Usage:
 *   node backfill-hidden-games.js
 *   node backfill-hidden-games.js --concurrency=100
 *   node backfill-hidden-games.js --season=b81be631
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
    const res = await fetch(API_URL, {
      method:  'POST',
      headers: { ...HEADERS_API, 'request-id': crypto.randomUUID() },
      body: JSON.stringify({
        operationName: 'ProfileSearch',
        variables:     { fullName: 'test' },
        query:         'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
      }),
    });

    const rawCookie = res.headers.get('set-cookie');
    if (!rawCookie) throw new Error(`No Set-Cookie header from API (status ${res.status})`);

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

// ─── GraphQL query for the spectator endpoint ─────────────────────────────────
// This is the exact "Game" query from the mobile app traffic.
// It uses integer game IDs (not UUIDs) and hits spectator.playhq.com.
// Crucially this endpoint does NOT respect the admin "hide game" flag —
// it returns full data even for hidden games.

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

// ─── Helper: call spectator endpoint ─────────────────────────────────────────

let _diagPrinted = 0;

async function fetchGame(gameId, session) {
  try {
    const res = await fetch(SPECTATOR_URL, {
      method:  'POST',
      headers: {
        ...HEADERS_SPECTATOR,
        'request-id': crypto.randomUUID(),
        'Cookie':     session.allCookies,
      },
      body: JSON.stringify({
        operationName: 'Game',
        variables:     { id: String(gameId) },
        query:         Q_GAME,
      }),
    });

    if (res.status === 429) return { _rateLimit: true };
    if (res.status === 401 || res.status === 403) return { _authError: true };
    if (!res.ok) {
      if (_diagPrinted++ < 3) {
        const body = await res.text().catch(() => '');
        console.warn(`\n  ⚠ Spectator HTTP ${res.status} for game ${gameId}: ${body.slice(0, 200)}`);
      }
      return { _transient: true };
    }

    const json = await res.json();

    if (_diagPrinted++ < 3) {
      console.log(`\n  DIAG game ${gameId}: data.game=${json?.data?.game ? 'GOT DATA' : 'null'} errors=${JSON.stringify(json?.errors?.[0])?.slice(0,100)}`);
    }

    if (json.errors?.length) {
      if (_diagPrinted < 5) console.warn(`\n  ⚠ GraphQL error for ${gameId}:`, JSON.stringify(json.errors[0]).slice(0, 150));
      const msg = json.errors[0]?.message || '';
      // "could not be found or was not electronically scored" = permanently no data
      if (msg.includes('could not be found') || msg.includes('not electronically scored')) {
        return { _legacy: true };
      }
      return { _graphqlError: true };
    }

    return json;
  } catch (e) {
    if (_diagPrinted++ < 3) console.warn(`\n  ⚠ Fetch exception for ${gameId}:`, e.message);
    return { _transient: true };
  }
}

// ─── Score parser ─────────────────────────────────────────────────────────────

function parseScore(statistics) {
  return statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;
}

// Parse quarter-by-quarter scores into a compact array [q1, q2, q3, q4]
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
    if (!diff) { console.log('\n  (no changes to commit)'); return; }
    execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('\n  ✓ Committed and pushed');
  } catch (e) {
    console.warn(`\n  ⚠ Git error: ${e.message}`);
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

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

  // Collect all game IDs that need probing:
  // - no score (hs undefined)
  // - not already flagged as hidden or legacy
  // - not already in progress file
  const todo    = [];
  const sgCache = {};

  for (const season of targetSeasons) {
    const gameFile = path.join(GAMES_DIR, `${season.id}.json`);
    if (!fs.existsSync(gameFile)) continue;
    let sg;
    try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); } catch (e) { continue; }
    sgCache[season.id] = sg;

    for (const [gameId, game] of Object.entries(sg.games || {})) {
      if (game.hs !== undefined)    continue;  // already has score
      if (game.hidden)              continue;  // already flagged hidden
      if (game.legacy)              continue;  // already flagged legacy
      if (prog.done.has(gameId))    continue;  // already processed this run
      todo.push({ seasonId: season.id, gameId });
    }
  }

  console.log(`📋 Games to probe: ${todo.length.toLocaleString()}\n`);

  if (todo.length === 0) {
    console.log('✅ Nothing to do — all games already have scores or flags');
    return;
  }

  let hidden = 0, legacy = 0, failed = 0, sinceLastSave = 0;

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);

    function buildResult(gameId, seasonId, game) {
    const hs  = parseScore(game.result?.home?.statistics);
    const as_ = parseScore(game.result?.away?.statistics);
    const hq  = parseQuarterScores(game.result?.home?.periods);
    const aq  = parseQuarterScores(game.result?.away?.periods);
    const homePlayers = (game.statistics?.home?.players || []).map(p => ({
      profileID: p.profileID, name: p.name, number: p.playerNumber,
      pts:   parseScore(p.statistics),
      pt1:   p.statistics?.find(s => s.type?.value === '1_POINT_SCORE')?.count ?? 0,
      pt2:   p.statistics?.find(s => s.type?.value === '2_POINT_SCORE')?.count ?? 0,
      pt3:   p.statistics?.find(s => s.type?.value === '3_POINT_SCORE')?.count ?? 0,
      fouls: p.statistics?.find(s => s.type?.value === 'TOTAL_FOULS')?.count ?? 0,
    }));
    const awayPlayers = (game.statistics?.away?.players || []).map(p => ({
      profileID: p.profileID, name: p.name, number: p.playerNumber,
      pts:   parseScore(p.statistics),
      pt1:   p.statistics?.find(s => s.type?.value === '1_POINT_SCORE')?.count ?? 0,
      pt2:   p.statistics?.find(s => s.type?.value === '2_POINT_SCORE')?.count ?? 0,
      pt3:   p.statistics?.find(s => s.type?.value === '3_POINT_SCORE')?.count ?? 0,
      fouls: p.statistics?.find(s => s.type?.value === 'TOTAL_FOULS')?.count ?? 0,
    }));
    return { gameId, seasonId, outcome: 'hidden', hs, as: as_, hq, aq, homePlayers, awayPlayers, status: game.status, updatedAt: game.updatedAt };
  }

  const results = await Promise.all(batch.map(async ({ seasonId, gameId }, j) => {
      // Small stagger to avoid thundering herd
      await delay(j * 5);

      const resp = await fetchGame(gameId, session);

      // Permanently no data — not e-scored
      if (resp?._legacy) return { gameId, seasonId, outcome: 'legacy' };

      // Handle auth failure — force a fresh cookie fetch (not cached) then retry once
      if (resp?._authError) {
        try { session = await getSession(true); } catch (e) {
          return { gameId, seasonId, outcome: 'skip' };
        }
        // Retry the request once with the new cookie
        const retry = await fetchGame(gameId, session);
        if (retry?._authError || retry?._rateLimit || retry?._transient || retry?._graphqlError) {
          return { gameId, seasonId, outcome: 'skip' };
        }
        const retryGame = retry?.data?.game;
        if (retryGame) {
          return buildResult(gameId, seasonId, retryGame);
        }
        return { gameId, seasonId, outcome: 'legacy' };
      }

      // Rate limit or transient error — skip for retry
      if (resp?._rateLimit || resp?._transient || resp?._graphqlError) {
        return { gameId, seasonId, outcome: 'skip' };
      }

      const game = resp?.data?.game;

      if (game) {
        return buildResult(gameId, seasonId, game);
      }

      // game(id) returned null — genuinely no data anywhere
      return { gameId, seasonId, outcome: 'legacy' };
    }));

    // Apply results to in-memory cache
    for (const r of results) {
      if (r.outcome === 'skip') { failed++; continue; }

      const sg    = sgCache[r.seasonId];
      if (!sg) continue;
      const entry = sg.games[r.gameId] || {};

      if (r.outcome === 'hidden') {
        if (r.hs !== null) entry.hs = r.hs;
        if (r.as !== null) entry.as = r.as;
        if (r.hq)          entry.hq = r.hq;   // home quarter scores
        if (r.aq)          entry.aq = r.aq;   // away quarter scores
        if (r.homePlayers?.length) entry.hp = r.homePlayers;
        if (r.awayPlayers?.length) entry.ap = r.awayPlayers;
        if (r.updatedAt)   entry.updatedAt = r.updatedAt;
        entry.hidden = true;
        hidden++;
      } else if (r.outcome === 'legacy') {
        entry.legacy = true;
        prog.legacy.add(r.gameId);
        legacy++;
      }

      sg.games[r.gameId] = entry;
      prog.done.add(r.gameId);
      sinceLastSave++;
    }

    // Flush to disk every 5000 games processed
    if (sinceLastSave >= 5000) {
      for (const [sid, sg] of Object.entries(sgCache)) {
        fs.writeFileSync(path.join(GAMES_DIR, `${sid}.json`), JSON.stringify(sg));
      }
      flushVenueShards();
      saveProgress(prog);
      sinceLastSave = 0;
      console.log(`\n  💾 Committing...`);
      gitCommitPush(`Hidden game backfill: ${hidden} hidden, ${legacy} legacy`);
    }

    const done = Math.min(i + CONCURRENCY, todo.length);
    process.stdout.write(
      `  ${done.toLocaleString()}/${todo.length.toLocaleString()}` +
      ` (${((done / todo.length) * 100).toFixed(1)}%)` +
      ` — 🔒 ${hidden} hidden, 📜 ${legacy} legacy, ✗ ${failed} failed\r`
    );

    // Brief pause between batches to be kind to the server
    if (i + CONCURRENCY < todo.length) await delay(100);
  }

  // Final flush
  for (const [sid, sg] of Object.entries(sgCache)) {
    fs.writeFileSync(path.join(GAMES_DIR, `${sid}.json`), JSON.stringify(sg));
  }
  flushVenueShards();
  saveProgress(prog);

  console.log(`\n\n✅ Backfill complete`);
  console.log(`   🔒 Hidden (scored via spectator): ${hidden.toLocaleString()}`);
  console.log(`   📜 Legacy (no data anywhere):     ${legacy.toLocaleString()}`);
  console.log(`   ✗  Failed/skipped:               ${failed.toLocaleString()}`);
  console.log(`   Total probed:                     ${todo.length.toLocaleString()}`);

  gitCommitPush(`Hidden game backfill complete: ${hidden} hidden, ${legacy} legacy`);
}

main().catch(e => { console.error(`\n❌ Fatal: ${e.message}`); process.exit(1); });
