#!/usr/bin/env node
// backfill-venue.js
/**
 * Backfills venue, court, time, and URL data for games missing a vid field.
 * Uses discoverGame which returns allocation.court.venue for every game.
 *
 * Reads no-venue-seasons.json to know which seasons need work.
 * Safe to re-run — skips games that already have vid populated.
 *
 * Usage:
 *   node backfill-venue.js
 *   node backfill-venue.js --concurrency=500
 *   node backfill-venue.js --tenant=bv
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────

const TENANT      = process.argv.find(a => a.startsWith('--tenant='))?.split('=')[1] || 'bv';
const TENANT_FULL = { bv: 'basketball-victoria', afl: 'afl' }[TENANT] || TENANT;
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '500', 10);

const API_URL        = 'https://api.playhq.com/graphql';
const GAMES_DIR      = path.join(__dirname, 'games', TENANT);
const VENUE_DIR      = path.join(__dirname, 'venue-lookup');
const COOKIE_FILE    = path.join(__dirname, `backfill-venue-cookie.json`);
const PROGRESS_FILE  = path.join(__dirname, 'backfill-venue-progress.json');
const NO_VENUE_FILE  = path.join(__dirname, 'no-venue-seasons.json');

const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT_FULL,
  'content-type': 'application/json',
};

// ─── Cookie ───────────────────────────────────────────────────────────────────

function loadCookie() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const d = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      if (Date.now() - d.fetchedAt < 5 * 60 * 60 * 1000) return d.cookie;
    }
  } catch (e) {}
  return null;
}

async function fetchCookie() {
  console.log('  Fetching session cookie...');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({
      operationName: 'ProfileSearch',
      variables: { fullName: 'test player' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
    }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No Set-Cookie header');
  const cookie = raw.split(';')[0];
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie, fetchedAt: Date.now() }));
  console.log('  ✓ Cookie obtained');
  return cookie;
}

async function getSession() {
  return loadCookie() || await fetchCookie();
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

const Q_GAME = `query DiscoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) {
    id date
    round { name }
    home { ... on DiscoverTeam { id name } }
    away { ... on DiscoverTeam { id name } }
    result {
      home { statistics { count type { value } } }
      away { statistics { count type { value } } }
    }
    allocation {
      time
      court {
        id name abbreviatedName
        venue {
          id name abbreviatedName
          latitude longitude
          address suburb state postcode country
        }
      }
    }
  }
}`;

async function fetchGame(gameId, cookie) {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
      body: JSON.stringify({ operationName: 'DiscoverGame', variables: { gameID: gameId }, query: Q_GAME }),
    });
    if (res.status === 403 || res.status === 401) return { _authError: true };
    if (res.status === 429) return { _rateLimit: true };
    if (!res.ok) return { _transient: true };
    const json = await res.json();
    if (json.errors) return { _notFound: true };
    return json.data?.discoverGame || { _notFound: true };
  } catch (e) {
    return { _transient: true };
  }
}

// ─── Venue lookup shards ──────────────────────────────────────────────────────

const _venueShards = {};
const _dirtyVenues = new Set();

function loadVenueShard(venueId) {
  const prefix = venueId.slice(0, 2);
  if (!_venueShards[prefix]) {
    const f = path.join(VENUE_DIR, `${prefix}.json`);
    try { _venueShards[prefix] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; }
    catch (e) { _venueShards[prefix] = {}; }
  }
  return _venueShards[prefix];
}

function storeVenue(venue, court) {
  if (!venue?.id) return;
  const prefix = venue.id.slice(0, 2);
  const shard  = loadVenueShard(venue.id);
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
  let count = 0;
  for (const prefix of _dirtyVenues) {
    fs.writeFileSync(path.join(VENUE_DIR, `${prefix}.json`), JSON.stringify(_venueShards[prefix]));
    count++;
  }
  _dirtyVenues.clear();
  return count;
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      return { done: new Set(p.done || []), failed: new Set(p.failed || []) };
    }
  } catch (e) {}
  return { done: new Set(), failed: new Set() };
}

function saveProgress(prog) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
    done:    [...prog.done],
    failed:  [...prog.failed],
    savedAt: new Date().toISOString(),
  }));
}

// ─── Git ──────────────────────────────────────────────────────────────────────

function gitCommitPush(message) {
  try {
    execSync('git add games/ venue-lookup/ backfill-venue-progress.json 2>/dev/null || true', { stdio: 'pipe', shell: true });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) { console.log('\n  (no changes to commit)'); return; }
    execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('\n  ✓ Committed and pushed');
  } catch (e) {
    console.warn(`\n  ⚠ Git push failed: ${e.message}`);
  }
}

// ─── Slugify for URL construction ─────────────────────────────────────────────

function slugify(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[()]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🏟  Venue Backfill`);
  console.log(`   Tenant:      ${TENANT}`);
  console.log(`   Concurrency: ${CONCURRENCY}\n`);

  if (!fs.existsSync(NO_VENUE_FILE)) {
    console.error(`❌ ${NO_VENUE_FILE} not found — run bootstrap-fixture-progress.js first`);
    process.exit(1);
  }

  const noVenueSeasons = JSON.parse(fs.readFileSync(NO_VENUE_FILE, 'utf8'));
  console.log(`📋 Seasons needing venue data: ${noVenueSeasons.length}`);
  console.log(`📋 Games needing venue data:   ${noVenueSeasons.reduce((n, s) => n + s.missingVenue, 0).toLocaleString()}\n`);

  // Load progress
  const prog = loadProgress();
  if (prog.done.size > 0) console.log(`  ↻ Resuming — ${prog.done.size.toLocaleString()} games already done\n`);

  let cookie = await getSession();

  // Load all game files for seasons with missing venues into memory
  // Build flat list of { seasonId, gameId } pairs needing venue
  const todo = [];
  for (const season of noVenueSeasons) {
    const gameFile = path.join(GAMES_DIR, `${season.id}.json`);
    if (!fs.existsSync(gameFile)) continue;
    let sg;
    try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); } catch (e) { continue; }
    for (const [gameId, game] of Object.entries(sg.games || {})) {
      if (game.vid) continue;           // already has venue
      if (prog.done.has(gameId)) continue;  // already processed
      if (prog.failed.has(gameId)) continue; // permanently failed
      todo.push({ seasonId: season.id, gameId });
    }
  }

  console.log(`📋 Remaining to fetch: ${todo.length.toLocaleString()}\n`);

  if (todo.length === 0) {
    console.log('✅ All games already have venue data');
    return;
  }

  // Cache season game files to avoid repeated reads/writes
  const sgCache = {};
  function getsg(seasonId) {
    if (!sgCache[seasonId]) {
      const f = path.join(GAMES_DIR, `${seasonId}.json`);
      sgCache[seasonId] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { games: {} };
    }
    return sgCache[seasonId];
  }

  let fetched = 0, failed = 0, rateLimited = 0;
  let concurrency = CONCURRENCY;
  let streak429   = 0;
  let sinceLastSave = 0;

  for (let i = 0; i < todo.length; i += concurrency) {
    const batch = todo.slice(i, i + concurrency);

    const results = await Promise.all(batch.map(async ({ seasonId, gameId }, j) => {
      await delay(j * 5);
      return { seasonId, gameId, game: await fetchGame(gameId, cookie) };
    }));

    // Handle rate limiting
    const hits429 = results.filter(r => r.game?._rateLimit).length;
    if (hits429 > 0) {
      streak429++;
      concurrency = Math.max(10, Math.floor(concurrency * 0.6));
      rateLimited += hits429;
      console.warn(`\n  ⚠ Rate limited (${hits429} hits) — concurrency → ${concurrency}, backing off 10s`);
      await delay(10000);
      i -= concurrency; // retry batch
      continue;
    }
    streak429 = 0;

    for (const { seasonId, gameId, game } of results) {
      if (game?._authError) {
        console.warn(`\n  ⚠ Auth error — refreshing cookie`);
        try { cookie = await fetchCookie(); } catch (e) { console.error('❌ Cookie refresh failed'); process.exit(1); }
        continue;
      }
      if (game?._rateLimit) continue; // handled above
      if (game?._notFound) {
        prog.done.add(gameId); // permanently gone
        continue;
      }
      if (game?._transient) {
        failed++;
        continue;
      }

      const court = game.allocation?.court;
      const venue = court?.venue;
      const time  = game.allocation?.time ? game.allocation.time.slice(0, 5) : null;

      if (venue) storeVenue(venue, court);

      // Update game entry
      const sg   = getsg(seasonId);
      const entry = sg.games[gameId] || {};

      if (venue?.id)   entry.vid = venue.id;
      if (venue?.name) entry.vn  = venue.name;
      if (court?.name) entry.ct  = court.name;
      if (time)        entry.t   = time;

      // Also update round name if missing
      if (game.round?.name && !entry.rn) entry.rn = game.round.name;

      // Update home/away if missing
      if (game.home?.id   && !entry.h)  entry.h  = game.home.id;
      if (game.home?.name && !entry.hn) entry.hn = game.home.name;
      if (game.away?.id   && !entry.a)  entry.a  = game.away.id;
      if (game.away?.name && !entry.an) entry.an = game.away.name;

      sg.games[gameId] = entry;
      prog.done.add(gameId);
      fetched++;
      sinceLastSave++;
    }

    // Flush and commit every max(2000, concurrency*10) games
    if (sinceLastSave >= Math.max(2000, concurrency * 10)) {
      // Write dirty game files
      let filesFlushed = 0;
      for (const [sid, sg] of Object.entries(sgCache)) {
        fs.writeFileSync(path.join(GAMES_DIR, `${sid}.json`), JSON.stringify(sg));
        delete sgCache[sid];
        filesFlushed++;
      }
      const vf = flushVenueShards();
      saveProgress(prog);
      sinceLastSave = 0;
      console.log(`\n  💾 ${filesFlushed} game files, ${vf} venue shards — committing...`);
      gitCommitPush(`Venue backfill: ${fetched.toLocaleString()} games enriched`);
    }

    const done = Math.min(i + concurrency, todo.length);
    process.stdout.write(`  ${done.toLocaleString()}/${todo.length.toLocaleString()} (${((done/todo.length)*100).toFixed(1)}%) — ✓ ${fetched.toLocaleString()} venues, ✗ ${failed} failed, ⚡ ${rateLimited} rate-limited, concurrency=${concurrency}\r`);

    if (i + concurrency < todo.length) await delay(50);
  }

  // Final flush
  for (const [sid, sg] of Object.entries(sgCache)) {
    fs.writeFileSync(path.join(GAMES_DIR, `${sid}.json`), JSON.stringify(sg));
  }
  flushVenueShards();
  saveProgress(prog);

  console.log(`\n\n✅ Venue backfill complete`);
  console.log(`   Venues fetched: ${fetched.toLocaleString()}`);
  console.log(`   Failed:         ${failed}`);
  console.log(`   Rate limited:   ${rateLimited}`);
  console.log(`   Total probed:   ${todo.length.toLocaleString()}`);

  gitCommitPush(`Venue backfill complete: ${fetched.toLocaleString()} games enriched`);
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}`);
  process.exit(1);
});
