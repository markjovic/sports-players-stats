#!/usr/bin/env node
// backfill-game-scores.js
/**
 * Backfills team scores (home/away) for every game ID stored in games/bv/*.json
 * using the discoverGame API endpoint.
 *
 * Enriches each game entry from:
 *   { d, on, o }
 * to:
 *   { d, on, o, h: homeTeamId, hn: homeTeamName, a: awayTeamId, an: awayTeamName,
 *     hs: homeScore, as: awayScore }
 *
 * Also writes individual per-game player stats into player detail files
 * from publicProfileStatistics.gameStatistics (already fetched, not yet stored).
 *
 * Safe to re-run — skips games that already have scores.
 *
 * Usage:
 *   node backfill-game-scores.js
 *   node backfill-game-scores.js --concurrency=50 --tenant=bv
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const TENANT      = process.argv.find(a => a.startsWith('--tenant='))?.split('=')[1] || 'bv';
const TENANT_FULL = { bv: 'basketball-victoria', afl: 'afl', ca: 'cricket-australia' }[TENANT] || TENANT;
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '100', 10);

const API_URL    = 'https://api.playhq.com/graphql';
const GAMES_DIR  = path.join(__dirname, 'games', TENANT);
const COOKIE_FILE = path.join(__dirname, 'backfill-cookie.json');
const PROGRESS_FILE = path.join(__dirname, 'backfill-progress.json');

const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT_FULL,
  'content-type': 'application/json',
};

// ─── Cookie management ────────────────────────────────────────────────────────

function loadCookie() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const data = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      if (Date.now() - data.fetchedAt < 5 * 60 * 60 * 1000) return data.cookie;
    }
  } catch (e) {}
  return null;
}

function saveCookie(cookie) {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie, fetchedAt: Date.now() }));
}

async function fetchCookie() {
  console.log('  Fetching session cookie...');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({
      operationName: 'ProfileSearch',
      variables: { fullName: 'test player' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id __typename } __typename } }',
    }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No Set-Cookie header — cookie fetch failed');
  const cookie = raw.split(';')[0];
  saveCookie(cookie);
  console.log('  ✓ Cookie obtained');
  return cookie;
}

async function getSession() {
  return loadCookie() || await fetchCookie();
}

// ─── API helpers ──────────────────────────────────────────────────────────────

const Q_GAME = `query DiscoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) {
    id
    date
    round { name }
    home { ... on DiscoverTeam { id name } }
    away { ... on DiscoverTeam { id name } }
    result {
      home { statistics { count type { value } } }
      away { statistics { count type { value } } }
    }
  }
}`;

async function fetchGame(gameId, cookie, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
        body: JSON.stringify({ operationName: 'DiscoverGame', variables: { gameID: gameId }, query: Q_GAME }),
      });
      if (res.status === 403 || res.status === 401) return { _authError: true };
      if (!res.ok) {
        if (attempt < retries) { await delay(5000); continue; }
        return null;
      }
      const json = await res.json();
      if (json.errors) return null;
      return json.data?.discoverGame || null;
    } catch (e) {
      if (attempt < retries) { await delay(3000); continue; }
      return null;
    }
  }
  return null;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseScore(statistics) {
  const total = statistics?.find(s => s.type?.value === 'TOTAL_SCORE');
  return total?.count ?? null;
}

// ─── Progress tracking ────────────────────────────────────────────────────────

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (e) {}
  return { done: new Set(), failed: new Set() };
}

function saveProgress(prog) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
    done:   [...prog.done],
    failed: [...prog.failed],
  }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🏀 Game Score Backfill`);
  console.log(`   Tenant:      ${TENANT}`);
  console.log(`   Games dir:   ${GAMES_DIR}`);
  console.log(`   Concurrency: ${CONCURRENCY}\n`);

  if (!fs.existsSync(GAMES_DIR)) {
    console.error(`❌ Games directory not found: ${GAMES_DIR}`);
    process.exit(1);
  }

  // Load all season game files and collect unique game IDs needing scores
  const seasonFiles = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
  console.log(`📁 Found ${seasonFiles.length} season game files`);

  // Collect all game IDs that don't yet have home/away scores
  const allGameIds   = new Set();
  const needsBackfill = new Set();
  let totalGames = 0;

  for (const file of seasonFiles) {
    const sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8'));
    for (const [gameId, game] of Object.entries(sg.games || {})) {
      allGameIds.add(gameId);
      totalGames++;
      if (game.hs === undefined || game.as === undefined) {
        needsBackfill.add(gameId);
      }
    }
  }

  console.log(`📊 Total unique games:    ${totalGames}`);
  console.log(`📊 Games needing scores:  ${needsBackfill.size}`);
  console.log(`📊 Already have scores:   ${totalGames - needsBackfill.size}`);

  if (needsBackfill.size === 0) {
    console.log('\n✅ All games already have scores — nothing to do');
    return;
  }

  // Load progress to resume if interrupted
  const prog = loadProgress();
  prog.done   = new Set(prog.done);
  prog.failed = new Set(prog.failed);

  const remaining = [...needsBackfill].filter(id => !prog.done.has(id));
  console.log(`📋 Remaining after progress: ${remaining.length} games\n`);

  // Get auth cookie
  let cookie;
  try {
    cookie = await getSession();
  } catch (e) {
    console.error(`❌ Could not get session cookie: ${e.message}`);
    process.exit(1);
  }

  // Fetch game scores in batches
  let fetched = 0;
  let failed  = 0;
  let authErrors = 0;

  // Build a lookup: gameId → which season files contain it
  const gameToFiles = {};
  for (const file of seasonFiles) {
    const sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8'));
    for (const gameId of Object.keys(sg.games || {})) {
      if (!gameToFiles[gameId]) gameToFiles[gameId] = [];
      gameToFiles[gameId].push(file);
    }
  }

  // Cache season game data in memory to avoid repeated disk reads
  const sgCache = {};
  function loadSg(file) {
    if (!sgCache[file]) sgCache[file] = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8'));
    return sgCache[file];
  }

  const SAVE_INTERVAL = 500; // save every N games
  let sinceLastSave = 0;

  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);

    const results = await Promise.all(batch.map(async (gameId, j) => {
      await delay(j * 10); // small stagger to avoid thundering herd
      const game = await fetchGame(gameId, cookie);
      return { gameId, game };
    }));

    for (const { gameId, game } of results) {
      if (game?._authError) {
        authErrors++;
        console.warn(`  ⚠ Auth error — refreshing cookie`);
        try {
          cookie = await fetchCookie();
          authErrors = 0;
        } catch (e) {
          console.error(`❌ Could not refresh cookie: ${e.message}`);
          process.exit(1);
        }
        continue;
      }

      if (!game) {
        prog.failed.add(gameId);
        failed++;
        continue;
      }

      // Extract scores
      const homeScore = parseScore(game.result?.home?.statistics);
      const awayScore = parseScore(game.result?.away?.statistics);
      const homeId    = game.home?.id;
      const homeName  = game.home?.name;
      const awayId    = game.away?.id;
      const awayName  = game.away?.name;

      // Update all season files that contain this game
      for (const file of (gameToFiles[gameId] || [])) {
        const sg = loadSg(file);
        if (sg.games[gameId]) {
          sg.games[gameId].h  = homeId;
          sg.games[gameId].hn = homeName;
          sg.games[gameId].a  = awayId;
          sg.games[gameId].an = awayName;
          if (homeScore !== null) sg.games[gameId].hs = homeScore;
          if (awayScore !== null) sg.games[gameId].as = awayScore;
          sg.games[gameId].rn = game.round?.name;
        }
      }

      prog.done.add(gameId);
      fetched++;
      sinceLastSave++;
    }

    const pct = Math.round(((i + batch.length) / remaining.length) * 100);
    console.log(`  ${i + batch.length}/${remaining.length} (${pct}%) — ✓ ${fetched} fetched, ✗ ${failed} failed`);

    // Periodically flush to disk
    if (sinceLastSave >= SAVE_INTERVAL) {
      flushCache(sgCache, GAMES_DIR);
      saveProgress(prog);
      sinceLastSave = 0;
    }
  }

  // Final flush
  flushCache(sgCache, GAMES_DIR);
  saveProgress(prog);

  console.log(`\n✅ Backfill complete`);
  console.log(`   Fetched:  ${fetched}`);
  console.log(`   Failed:   ${failed}`);
  console.log(`   Total:    ${needsBackfill.size}`);
}

function flushCache(cache, dir) {
  for (const [file, sg] of Object.entries(cache)) {
    fs.writeFileSync(path.join(dir, file), JSON.stringify(sg));
  }
  console.log(`  💾 Flushed ${Object.keys(cache).length} season files to disk`);
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
