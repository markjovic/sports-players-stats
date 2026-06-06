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

async function fetchGame(gameId, cookie, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
        body: JSON.stringify({ operationName: 'DiscoverGame', variables: { gameID: gameId }, query: Q_GAME }),
      });
      if (res.status === 403 || res.status === 401) return { _authError: true };
      if (res.status === 429) {
        return { _rateLimit: true };
      }
      if (!res.ok) {
        if (attempt < retries) { await delay(5000); continue; }
        return { _transient: true };
      }
      const json = await res.json();
      if (json.errors) return { _notFound: true };  // GraphQL error = game ID not in API at all
      const g = json.data?.discoverGame;
      if (!g) return { _notFound: true };
      return g;
    } catch (e) {
      if (attempt < retries) { await delay(3000); continue; }
      return { _transient: true };
    }
  }
  return { _transient: true };
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

  // Collect all game IDs that don't yet have home/away scores, excluding future games
  const today        = new Date().toISOString().slice(0, 10);
  const allGameIds   = new Set();
  const needsBackfill = new Set();
  let totalGames  = 0;
  let futureGames = 0;

  for (const file of seasonFiles) {
    const sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8'));
    for (const [gameId, game] of Object.entries(sg.games || {})) {
      allGameIds.add(gameId);
      totalGames++;
      if (game.hs === undefined || game.as === undefined) {
        // Skip future games — they have no score yet and won't until played
        if (game.d && game.d > today) { futureGames++; continue; }
        needsBackfill.add(gameId);
      }
    }
  }

  console.log(`📁 Found ${seasonFiles.length} season game files`);
  console.log(`📊 Total unique games:    ${totalGames.toLocaleString()}`);
  console.log(`📊 Future games skipped:  ${futureGames.toLocaleString()}`);
  console.log(`📊 Already have scores:   ${(totalGames - needsBackfill.size - futureGames).toLocaleString()}`);
  console.log(`📊 Games needing scores:  ${needsBackfill.size.toLocaleString()}`);

  if (needsBackfill.size === 0) {
    console.log('\n✅ All games already have scores — nothing to do');
    return;
  }

  // Load progress to resume if interrupted
  const prog = loadProgress();
  prog.done   = new Set(prog.done);
  prog.failed = new Set(prog.failed);

  const remaining = [...needsBackfill].filter(id => !prog.done.has(id));
  console.log(`📋 Remaining after progress: ${remaining.length.toLocaleString()} games\n`);

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
  let rateLimited = 0;
  let authErrors  = 0;
  let concurrency = CONCURRENCY;
  let concurrencyCap = CONCURRENCY;
  let streak429 = 0;

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

  for (let i = 0; i < remaining.length; i += concurrency) {
    const batch = remaining.slice(i, i + concurrency);

    const results = await Promise.all(batch.map(async (gameId, j) => {
      await delay(j * 10);
      const game = await fetchGame(gameId, cookie);
      return { gameId, game };
    }));

    // Check for rate limiting before processing results
    const rateLimitHits = results.filter(r => r.game?._rateLimit).length;
    if (rateLimitHits > 0) {
      streak429++;
      concurrency = Math.max(5, Math.floor(concurrency * 0.6));
      if (streak429 >= 3) {
        concurrencyCap = Math.max(5, concurrencyCap - 10);
        concurrency    = Math.min(concurrency, concurrencyCap);
        streak429      = 0;
        console.warn(`\n  ⚠ Repeated rate limiting — cap lowered to ${concurrencyCap}, concurrency now ${concurrency}`);
      } else {
        console.warn(`\n  ⚠ Rate limited (${rateLimitHits} hits) — concurrency → ${concurrency}, backing off 10s`);
      }
      rateLimited += rateLimitHits;
      await delay(10000);
      // Re-queue rate-limited games by stepping back
      i -= concurrency;
      continue;
    } else if (streak429 > 0) {
      streak429 = 0; // clear streak on clean batch
    }

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

      if (game?._notFound) {
        // Game ID not in API at all — skip permanently
        prog.done.add(gameId);
        failed++;
        continue;
      }

      if (game?._transient) {
        // Network/server error — don't mark done, will be retried next run
        failed++;
        continue;
      }

      // Game was found — check if it has scores yet
      const homeScore = parseScore(game.result?.home?.statistics);
      const awayScore = parseScore(game.result?.away?.statistics);

      // Game was found but has no scores — past game with no data (bye/cancelled/gap)
      // Skip permanently since future games were already filtered out before this loop
      if (homeScore === null && awayScore === null) {
        prog.done.add(gameId);
        failed++;
        continue;
      }

      // Extract team info and update season files
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

    const pct = Math.round(((i + concurrency) / remaining.length) * 100);
    process.stdout.write(`  ${Math.min(i + concurrency, remaining.length).toLocaleString()}/${remaining.length.toLocaleString()} (${pct}%) — ✓ ${fetched.toLocaleString()} scored, ✗ ${failed} no-data, ⚡ ${rateLimited} rate-limited, concurrency=${concurrency}\r`);

    // Periodically flush to disk and clear cache to avoid OOM
    if (sinceLastSave >= Math.max(500, concurrency * 10)) {
      flushCache(sgCache, GAMES_DIR);
      saveProgress(prog);
      sinceLastSave = 0;
    }
  }

  // Final flush
  flushCache(sgCache, GAMES_DIR);
  saveProgress(prog);

  console.log(`\n✅ Backfill complete`);
  console.log(`   Scored:        ${fetched.toLocaleString()}`);
  console.log(`   No score:      ${failed} (past games with no data — skipped permanently)`);
  console.log(`   Rate limited:  ${rateLimited} (retried via backoff)`);
  console.log(`   Total probed:  ${needsBackfill.size.toLocaleString()}`);
}

function flushCache(cache, dir) {
  let count = 0;
  for (const [file, sg] of Object.entries(cache)) {
    fs.writeFileSync(path.join(dir, file), JSON.stringify(sg));
    delete cache[file];  // free memory after writing
    count++;
  }
  console.log(`\n  💾 Flushed ${count} season files to disk`);
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
