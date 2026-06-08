#!/usr/bin/env node
// backfill-hidden-games.js
/**
 * Enriches game entries that have no score and no venue by calling game(id)
 * — the live e-scoring endpoint — which returns scores for games hidden by
 * competition admin (where discoverGame returns null).
 *
 * Three outcomes per game:
 *   1. game(id) returns data → score stored, flag: hidden: true
 *   2. game(id) returns null → genuinely orphaned, flag: legacy: true
 *   3. game(id) errors → skip, retry next run
 *
 * Also flags existing no-score no-venue games based on backfill-venue
 * progress (done set = discoverGame returned null = hidden or legacy).
 *
 * Reads no-venue-seasons.json to target seasons with missing data.
 * Progress file: backfill-hidden-progress.json
 *
 * Usage:
 *   node backfill-hidden-games.js
 *   node backfill-hidden-games.js --concurrency=300
 *   node backfill-hidden-games.js --season=b81be631   (single season)
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
const CONCURRENCY   = parseInt(ARGS.concurrency || '300', 10);
const TARGET_SEASON = ARGS.season      || null;

const API_URL       = 'https://api.playhq.com/graphql';
const GAMES_DIR     = path.join(__dirname, 'games', TENANT);
const COOKIE_FILE   = path.join(__dirname, `backfill-hidden-cookie.json`);
const PROGRESS_FILE = path.join(__dirname, 'backfill-hidden-progress.json');
const NO_VENUE_FILE = path.join(__dirname, 'no-venue-seasons.json');
const VENUE_DIR     = path.join(__dirname, 'venue-lookup');

const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT_FULL,
  'content-type': 'application/json',
};

// ─── Cookie ───────────────────────────────────────────────────────────────────

async function getSession() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const d = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      if (Date.now() - d.fetchedAt < 5 * 60 * 60 * 1000) return d.cookie;
    }
  } catch (e) {}
  console.log('  Fetching session cookie...');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({
      operationName: 'ProfileSearch',
      variables:     { fullName: 'test player' },
      query:         'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
    }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No Set-Cookie header');
  const cookie = raw.split(';')[0];
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie, fetchedAt: Date.now() }));
  console.log('  ✓ Cookie obtained');
  return cookie;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

// game(id) — live e-scoring endpoint, returns data for hidden games
// discoverGame returns null for hidden games; game(id) returns scores
const Q_GAME_ESCORE = `query GameScore($id: ID!) {
  game(id: $id) {
    id
    status
    updatedAt
    result {
      home {
        statistics { count type { value } }
        periods { period { value } statistics { count type { value } } }
      }
      away {
        statistics { count type { value } }
      }
    }
  }
}`;

// discoverGame — to distinguish hidden (null) from legacy (error/absent)
const Q_DISCOVER_GAME = `query DiscoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) {
    id
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
    result {
      home { statistics { count type { value } } }
      away { statistics { count type { value } } }
    }
  }
}`;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

let _diagCount = 0;
async function gql(operationName, query, variables, cookie) {
  try {
    const res = await fetch(API_URL, {
      method:  'POST',
      headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
      body:    JSON.stringify({ operationName, variables, query }),
    });
    if (_diagCount < 3) {
      _diagCount++;
      console.warn(`\n  DIAG [${operationName}] status=${res.status} gameID=${variables.gameID || variables.id}`);
    }
    if (res.status === 429) return { _rateLimit: true };
    if (res.status === 403 || res.status === 401) return { _authError: true };
    if (!res.ok) return { _transient: true };
    const json = await res.json();
    if (_diagCount <= 3) console.warn(`  DIAG response keys:`, Object.keys(json.data || {}), 'errors:', json.errors?.[0]?.message?.slice(0,100));
    if (json.errors) {
      if (_errSample++ < 3) console.warn(`\n  ⚠ GraphQL error (${operationName}):`, JSON.stringify(json.errors[0]).slice(0, 200));
      return { _graphqlError: true, errors: json.errors };
    }
    return json;
  } catch (e) {
    if (_diagCount < 3) console.warn(`\n  DIAG fetch exception:`, e.message);
    return { _transient: true };
  }
}

function parseScore(statistics) {
  return statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;
}

// ─── Venue shards ─────────────────────────────────────────────────────────────

const _venueShards = {};
const _dirtyVenues = new Set();

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
      name: venue.name, abbr: venue.abbreviatedName || null,
      lat: venue.latitude || null, lng: venue.longitude || null,
      address: venue.address || null, suburb: venue.suburb || null,
      state: venue.state || null, postcode: venue.postcode || null,
      country: venue.country || null, courts: {},
    };
    _dirtyVenues.add(prefix);
  }
  if (court?.id && !shard[venue.id].courts[court.id]) {
    shard[venue.id].courts[court.id] = { name: court.name, abbr: court.abbreviatedName || null };
    _dirtyVenues.add(prefix);
  }
}

function flushVenueShards() {
  if (!fs.existsSync(VENUE_DIR)) fs.mkdirSync(VENUE_DIR, { recursive: true });
  let n = 0;
  for (const prefix of _dirtyVenues) {
    fs.writeFileSync(path.join(VENUE_DIR, `${prefix}.json`), JSON.stringify(_venueShards[prefix]));
    n++;
  }
  _dirtyVenues.clear();
  return n;
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Backfill Hidden Games`);
  console.log(`   Tenant:      ${TENANT}`);
  console.log(`   Concurrency: ${CONCURRENCY}\n`);

  if (!fs.existsSync(NO_VENUE_FILE)) {
    console.error(`❌ ${NO_VENUE_FILE} not found — run bootstrap-fixture-progress.js first`);
    process.exit(1);
  }

  const noVenueSeasons = JSON.parse(fs.readFileSync(NO_VENUE_FILE, 'utf8'));

  // Build list of seasons to process
  const targetSeasons = TARGET_SEASON
    ? [{ id: TARGET_SEASON }]
    : noVenueSeasons;

  console.log(`📋 Seasons to check: ${targetSeasons.length}`);

  const prog = loadProgress();
  if (prog.done.size > 0) {
    console.log(`  ↻ Resuming — ${prog.done.size.toLocaleString()} already done, ${prog.legacy.size.toLocaleString()} flagged legacy\n`);
  }

  let cookie = await getSession();

  // Collect all game IDs missing score AND venue, not yet processed
  const todo = [];
  const sgCache = {};

  for (const season of targetSeasons) {
    const gameFile = path.join(GAMES_DIR, `${season.id}.json`);
    if (!fs.existsSync(gameFile)) continue;
    let sg;
    try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); } catch (e) { continue; }
    sgCache[season.id] = sg;

    for (const [gameId, game] of Object.entries(sg.games || {})) {
      // Skip games that already have a score OR a venue OR are already flagged
      if (game.hs !== undefined) continue;
      if (game.vid) continue;
      if (game.hidden || game.legacy) continue;
      if (prog.done.has(gameId)) continue;
      todo.push({ seasonId: season.id, gameId });
    }
  }

  console.log(`📋 Games to probe: ${todo.length.toLocaleString()}\n`);

  if (todo.length === 0) {
    console.log('✅ Nothing to do — all games already have scores, venues, or flags');
    return;
  }

  let hidden = 0, legacy = 0, scored = 0, failed = 0, sinceLastSave = 0;

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);

    const results = await Promise.all(batch.map(async ({ seasonId, gameId }, j) => {
      await delay(j * 3);

      // Step 1: call discoverGame — if it returns data, game is accessible normally
      const dg = await gql('DiscoverGame', Q_DISCOVER_GAME, { gameID: gameId }, cookie);

      if (dg?._authError) {
        try { cookie = await getSession(); } catch (e) { return { gameId, seasonId, outcome: 'skip' }; }
        return { gameId, seasonId, outcome: 'skip' };
      }
      if (dg?._rateLimit || dg?._transient || dg?._graphqlError) return { gameId, seasonId, outcome: 'skip' };

      // discoverGame returned actual data — game is accessible, get venue from it
      if (dg?.data?.discoverGame) {
        const dgg = dg.data.discoverGame;
        const court = dgg.allocation?.court;
        const venue = court?.venue;
        const dt    = dgg.allocation?.dateTimeList?.[0];
        const hs    = parseScore(dgg.result?.home?.statistics);
        const as_   = parseScore(dgg.result?.away?.statistics);
        return { gameId, seasonId, outcome: 'accessible', hs, as: as_, venue, court, time: dt?.time?.slice(0, 5) || null };
      }

      // discoverGame returned null → game hidden by admin
      // Call game(id) to get the score
      const ge = await gql('GameScore', Q_GAME_ESCORE, { id: gameId }, cookie);

      if (ge?._authError || ge?._rateLimit || ge?._transient || ge?._graphqlError) return { gameId, seasonId, outcome: 'skip' };

      if (ge?.data?.game) {
        const g   = ge.data.game;
        const hs  = parseScore(g.result?.home?.statistics);
        const as_ = parseScore(g.result?.away?.statistics);
        return { gameId, seasonId, outcome: 'hidden', hs, as: as_, status: g.status };
      }

      // game(id) also returned null → genuinely orphaned/legacy
      return { gameId, seasonId, outcome: 'legacy' };
    }));

    for (const r of results) {
      if (r.outcome === 'skip') { failed++; continue; }

      const sg    = sgCache[r.seasonId];
      if (!sg) continue;
      const entry = sg.games[r.gameId] || {};

      if (r.outcome === 'accessible') {
        // Normal game — just needed to be retried
        if (r.hs !== null) entry.hs = r.hs;
        if (r.as !== null) entry.as = r.as;
        if (r.venue) { storeVenue(r.venue, r.court); entry.vid = r.venue.id; entry.vn = r.venue.name; }
        if (r.court?.name) entry.ct = r.court.name;
        if (r.time) entry.t = r.time;
        scored++;
      } else if (r.outcome === 'hidden') {
        // Hidden by competition admin — score available via game(id)
        if (r.hs !== null) entry.hs = r.hs;
        if (r.as !== null) entry.as = r.as;
        entry.hidden = true;   // flag for HTML tool
        hidden++;
      } else if (r.outcome === 'legacy') {
        // Genuinely orphaned — no data accessible via any route
        entry.legacy = true;   // flag for HTML tool
        prog.legacy.add(r.gameId);
        legacy++;
      }

      sg.games[r.gameId] = entry;
      prog.done.add(r.gameId);
      sinceLastSave++;
    }

    // Flush and commit every 5000 games
    if (sinceLastSave >= 5000) {
      for (const [sid, sg] of Object.entries(sgCache)) {
        fs.writeFileSync(path.join(GAMES_DIR, `${sid}.json`), JSON.stringify(sg));
      }
      flushVenueShards();
      saveProgress(prog);
      sinceLastSave = 0;
      console.log(`\n  💾 Committing...`);
      gitCommitPush(`Hidden game backfill: ${hidden} hidden, ${legacy} legacy, ${scored} scored`);
    }

    const done = Math.min(i + CONCURRENCY, todo.length);
    process.stdout.write(
      `  ${done.toLocaleString()}/${todo.length.toLocaleString()} (${((done/todo.length)*100).toFixed(1)}%)` +
      ` — 🔒 ${hidden} hidden, 📜 ${legacy} legacy, ✓ ${scored} scored, ✗ ${failed} failed\r`
    );
    if (i + CONCURRENCY < todo.length) await delay(50);
  }

  // Final flush
  for (const [sid, sg] of Object.entries(sgCache)) {
    fs.writeFileSync(path.join(GAMES_DIR, `${sid}.json`), JSON.stringify(sg));
  }
  flushVenueShards();
  saveProgress(prog);

  console.log(`\n\n✅ Hidden game backfill complete`);
  console.log(`   🔒 Hidden (score via game(id)): ${hidden.toLocaleString()}`);
  console.log(`   📜 Legacy (no data anywhere):   ${legacy.toLocaleString()}`);
  console.log(`   ✓  Accessible (scored+venued):  ${scored.toLocaleString()}`);
  console.log(`   ✗  Failed/skipped:              ${failed.toLocaleString()}`);
  console.log(`   Total probed:                   ${todo.length.toLocaleString()}`);

  gitCommitPush(`Hidden game backfill complete: ${hidden} hidden, ${legacy} legacy`);
}

main().catch(e => { console.error(`\n❌ Fatal: ${e.message}`); process.exit(1); });
