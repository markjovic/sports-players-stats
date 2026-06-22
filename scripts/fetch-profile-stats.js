// scripts/fetch-profile-stats.js
//
// Fetches publicProfileStatistics for all players in a single index shard.
// Run one shard at a time — the workflow uses sparse checkout so only
// players/indexes/{shard}.json and players/{shard}/ are on disk.
//
// Usage:
//   node scripts/fetch-profile-stats.js --shard=3a
//   node scripts/fetch-profile-stats.js --shard=3a --force
//
// Writes to each players/{shard}/{uuid}.json:
//   sports.Basketball.foulOuts       — { [seasonId]: count }
//   sports.Basketball.maxGamePTS     — number | null
//   sports.Basketball.maxGameThreePt — number | null
//   sports.Basketball.statsChecked   — ISO timestamp
//
// statsChecked is ONLY written on a real data response.
// A 403 that persists after a session refresh = truly inaccessible profile.
// A 403 that resolves after a session refresh = session expiry (retry succeeds).
//
// One git commit after all writes for the shard.

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');
const https = require('https');

const ROOT = path.join(__dirname, '..');

// ─── CLI args ────────────────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const SHARD = (args.find(a => a.startsWith('--shard=')) || '').replace('--shard=', '').toLowerCase().trim();
const FORCE = args.includes('--force');
const MAX   = (() => { const a = args.find(a => a.startsWith('--max=')); return a ? parseInt(a.split('=')[1]) : Infinity; })();

if (!SHARD || !/^[0-9a-f]{2}$/.test(SHARD)) {
  console.error('Usage: node scripts/fetch-profile-stats.js --shard=<00-ff> [--force]');
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const API_URL     = 'https://api.playhq.com/graphql';
const CONCURRENCY  = 1;    // ProfileSeasonStatistics is expensive — one at a time
const REQUEST_DELAY = 800; // ms between requests — avoids overwhelming PlayHQ backend
const RETRY_BASE  = 2000; // ms, multiplied by attempt number

// ─── Headers — full set, never split, never modified ─────────────────────────

const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── Session cookie ───────────────────────────────────────────────────────────
// Promise-locked so concurrent workers don't trigger multiple simultaneous refreshes.

let sessionCookie   = null;
let sessionPromise  = null;

const COOKIE_QUERIES = [
  {
    operationName: 'TenantConfig',
    variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }',
  },
  {
    operationName: 'ProfileSearch',
    variables: { fullName: 'a' },
    query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
  },
];

async function refreshSession() {
  // If a refresh is already in flight, wait for it rather than firing another
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (attempt > 1) await sleep(attempt * 5000);
      for (const body of COOKIE_QUERIES) {
        const res = await doFetch(API_URL, {
          method:  'POST',
          headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() },
          body:    JSON.stringify(body),
        });
        const raw = res.headers.get('set-cookie');
        if (!raw) continue;
        // Extract each named cookie value, then reassemble in the exact order
        // the mobile client sends them: phq_tier first, phq_session, phq_sub.
        // (The server returns them in a different order in set-cookie headers.)
        const parts = raw.split(',').map(c => c.trim().split(';')[0]);
        const get = (name) => {
          const p = parts.find(c => c.startsWith(name + '='));
          return p || null;
        };
        const tier    = get('phq_tier');
        const session = get('phq_session');
        const sub     = get('phq_sub');
        if (!tier || !session || !sub) continue;
        sessionCookie = `${tier}; ${session}; ${sub}`;
        sessionPromise = null;
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    }
    sessionPromise = null;
    throw new Error('Failed to obtain session cookie after 10 attempts');
  })();

  return sessionPromise;
}

// ─── GraphQL query ────────────────────────────────────────────────────────────
// ProfileSeasonStatistics — returns per-game stat lines via gradeStatistics.
// This is the correct query for deriving foulOuts, maxGamePTS, maxGameThreePt.
// Confirmed working from mobile traffic (request_7.txt).

const PROFILE_QUERY = {
  operationName: 'ProfileSeasonStatistics',
  query: `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      name
      player { hasGamePermit __typename }
      statistics {
        season { id name competition { id name organisation { id name __typename } __typename } __typename }
        club { id name __typename }
        totalStatistics { ...ProfileSeasonStatistic __typename }
        teamStatistics {
          team { ... on DiscoverTeam { id name __typename } __typename }
          totalStatistics { ...ProfileSeasonStatistic __typename }
          gradeStatistics {
            grade { id name __typename }
            totalStatistics { ...ProfileSeasonStatistic __typename }
            gameStatistics {
              game {
                id
                round { name number isFinalsRound abbreviatedName __typename }
                home { ... on DiscoverTeam { id name __typename } __typename }
                away { ... on DiscoverTeam { id name __typename } __typename }
                __typename
              }
              statistics { ...ProfileSeasonStatistic __typename }
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
  tenantConfiguration {
    statistics {
      seasonStatisticsMeta { value name shortName isDisplayable __typename }
      __typename
    }
    __typename
  }
}
fragment ProfileSeasonStatistic on Statistic {
  count
  details { value __typename }
  __typename
}`,
};

// ─── Stat helpers ─────────────────────────────────────────────────────────────
// Response stat entries: { count, details: { value } }

function statValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const match = statistics.find(s => s?.details?.value === typeValue);
  return match ? (match.count || 0) : 0;
}

// Derive foulOuts, maxGamePTS, maxGameThreePt from per-game stat lines.
// Returns null if publicProfileStatistics is absent (inaccessible profile).
//
// foulOuts: { [seasonId]: count } — number of games with >= 5 fouls
// maxGamePTS: highest TOTAL_SCORE in any single game across career
// maxGameThreePt: highest 3_POINT_SCORE in any single game across career
function parseProfileStats(data) {
  const seasonStats = data?.publicProfileStatistics?.seasonStatistics;
  if (!seasonStats) return null;

  const foulOuts     = {};
  let maxGamePTS     = null;
  let maxGameThreePt = null;
  let maxGamePTSKey  = null;   // { gameKey, sid } for the game where PTS record was set
  let maxGameThreePtKey = null; // { gameKey, sid } for the game where 3PT record was set

  for (const season of seasonStats) {
    for (const reg of (season.statistics || [])) {
      const seasonId = reg?.season?.id;
      if (!seasonId) continue;

      for (const teamStat of (reg.teamStatistics || [])) {
        for (const gradeStat of (teamStat.gradeStatistics || [])) {
          for (const gameStat of (gradeStat.gameStatistics || [])) {
            const stats   = gameStat.statistics || [];
            const gameKey = gameStat.game?.id || null;
            const fouls   = statValue(stats, 'TOTAL_FOULS');
            const pts     = statValue(stats, 'TOTAL_SCORE');
            const three   = statValue(stats, '3_POINT_SCORE');

            // Foul-out = 5 or more fouls in a single game
            if (fouls >= 5) {
              foulOuts[seasonId] = (foulOuts[seasonId] || 0) + 1;
            }

            if (pts > (maxGamePTS ?? 0)) {
              maxGamePTS    = pts;
              maxGamePTSKey = gameKey ? { gameKey, sid: seasonId } : null;
            }
            if (three > (maxGameThreePt ?? 0)) {
              maxGameThreePt    = three;
              maxGameThreePtKey = gameKey ? { gameKey, sid: seasonId } : null;
            }
          }
        }
      }
    }
  }

  return { foulOuts, maxGamePTS, maxGamePTSKey, maxGameThreePt, maxGameThreePtKey };
}

// ─── API fetch ────────────────────────────────────────────────────────────────
//
// 403 = profile inaccessible to a guest session. Leave file untouched.
// Session expiry would manifest as all requests failing, not individual 403s.
// We refresh the session proactively after every REFRESH_EVERY successful
// requests to prevent expiry on long runs, but we never refresh on a 403.

const REFRESH_EVERY  = 30;  // refresh session every 30 requests — PlayHQ enforces a per-session quota on ProfileSeasonStatistics
let requestCount = 0;

async function fetchProfile(profileID) {
  if (!sessionCookie) await refreshSession();

  requestCount++;

  // Proactive session refresh every REFRESH_EVERY requests
  if (requestCount % REFRESH_EVERY === 0) {
    console.log(`  ↺  Session refresh at request ${requestCount} (new JWT quota)`);
    await refreshSession();
  }

  const body = { ...PROFILE_QUERY, variables: { profileID } };

  let res;
  try {
    res = await doFetch(API_URL, {
      method:  'POST',
      headers: {
        ...HEADERS_BASE,
        'request-id': crypto.randomUUID(),
        'Cookie':     sessionCookie,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { status: 'error', err };
  }

  if (res.status === 403) {
    let body403 = '';
    try { body403 = await res.text(); } catch { /* ignore */ }
    if (body403.includes('DOCTYPE') || body403.includes('Request blocked')) {
      // CloudFront block — log first 300 chars so we can see what identifier it tracks
      const snippet = body403.replace(/\s+/g, ' ').trim().slice(0, 300);
      console.log(`  ⛔ CloudFront block (req#${requestCount}, uuid=${profileID}): ${snippet}`);
      return { status: 'cloudfront-block' };
    }
    // Application-level 403 — profile genuinely inaccessible (private/deleted).
    // Log it but return a distinct status so processUUID writes statsChecked,
    // preventing infinite retries on future runs.
    console.log(`  — private profile (req#${requestCount}, uuid=${profileID})`);
    return { status: 'private' };
  }

  // 504 = backend overloaded — wait and retry once
  if (res.status === 504) {
    await sleep(15000);
    try {
      res = await doFetch(API_URL, {
        method:  'POST',
        headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
        body:    JSON.stringify(body),
      });
    } catch (err) { return { status: 'error', err }; }
  }

  if (!res.ok) {
    return { status: 'error', err: new Error(`HTTP ${res.status}`) };
  }

  let json;
  try { json = await res.json(); }
  catch (err) { return { status: 'error', err }; }

  const data = json.data || json;

  // Null publicProfileStatistics = inaccessible profile
  if (!data?.publicProfileStatistics) return { status: 'inaccessible' };

  return { status: 'ok', data };
}

// ─── Player file helpers ──────────────────────────────────────────────────────

function playerPath(uuid) {
  return path.join(ROOT, 'players', SHARD, `${uuid}.json`);
}

function readPlayer(uuid) {
  return JSON.parse(fs.readFileSync(playerPath(uuid), 'utf8'));
}

function writePlayer(uuid, player) {
  fs.writeFileSync(playerPath(uuid), JSON.stringify(player), 'utf8');
}

// ─── Process one UUID ─────────────────────────────────────────────────────────

async function processUUID(uuid, stats, idx) {
  const short = uuid.slice(0, 8);
  const prefix = `  [${String(idx).padStart(4)}/${stats.total}]`;

  const result = await fetchProfile(uuid);

  if (result.status === 'inaccessible') {
    // Should not normally reach here — kept as safety fallback
    stats.inaccessible++;
    console.log(`${prefix} — ${short} inaccessible`);
    return;
  }

  if (result.status === 'private') {
    // Genuine private/deleted profile — write statsChecked so we never retry
    stats.inaccessible++;
    try {
      const player = readPlayer(uuid);
      if (!player.sports)            player.sports = {};
      if (!player.sports.Basketball) player.sports.Basketball = {};
      player.sports.Basketball.foulOuts       = {};
      player.sports.Basketball.maxGamePTS     = null;
      player.sports.Basketball.maxGameThreePt = null;
      player.sports.Basketball.statsChecked   = new Date().toISOString();
      if (!player.records) player.records = {};
      player.records.maxGamePTS     = { v: null };
      player.records.maxGameThreePt = { v: null };
      writePlayer(uuid, player);
      stats.written++; // counts toward completion — won't be retried
    } catch (err) {
      console.log(`${prefix} ✗ ${short} could not write private marker: ${err.message}`);
    }
    console.log(`${prefix} — ${short} private profile (marked done)`);
    return;
  }

  if (result.status === 'cloudfront-block') {
    // Caller handles the wait-and-retry loop
    return result;
  }

  if (result.status === 'error') {
    stats.errors++;
    console.log(`${prefix} ✗ ${short} ERROR: ${result.err?.message}`);
    return;
  }

  const parsed = parseProfileStats(result.data);
  if (!parsed) {
    stats.inaccessible++;
    console.log(`${prefix} — ${short} no profile data`);
    return;
  }

  const player = readPlayer(uuid);
  if (!player.sports)            player.sports = {};
  if (!player.sports.Basketball) player.sports.Basketball = {};

  const bk = player.sports.Basketball;
  bk.foulOuts       = parsed.foulOuts;
  bk.maxGamePTS     = parsed.maxGamePTS;
  bk.maxGameThreePt = parsed.maxGameThreePt;

  // Write records with gameKey context for db-report and StatTrack game linking
  if (!player.records) player.records = {};
  player.records.maxGamePTS = parsed.maxGamePTSKey
    ? { v: parsed.maxGamePTS, ...parsed.maxGamePTSKey }
    : { v: parsed.maxGamePTS ?? null };
  player.records.maxGameThreePt = parsed.maxGameThreePtKey
    ? { v: parsed.maxGameThreePt, ...parsed.maxGameThreePtKey }
    : { v: parsed.maxGameThreePt ?? null };
  bk.statsChecked   = new Date().toISOString();

  writePlayer(uuid, player);
  stats.written++;
  const fo = Object.values(parsed.foulOuts).reduce((a, b) => a + b, 0);
  console.log(`${prefix} ✓ ${short} pts=${parsed.maxGamePTS ?? 0} 3pt=${parsed.maxGameThreePt ?? 0} fo=${fo}`);
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function runPool(tasks, concurrency) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const task = tasks[i++];
      await task();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// ─── Git commit ───────────────────────────────────────────────────────────────

async function gitCommit(stats) {
  execSync(`git add players/${SHARD}`, { stdio: 'pipe', cwd: ROOT });
  const diff = execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim();
  if (!diff) { console.log('  No changes to commit.'); return; }

  const msg = `fetch-profile-stats: shard ${SHARD} — ${stats.written} written, ${stats.inaccessible} inaccessible, ${stats.skipped} skipped`;
  execSync(`git commit -m "${msg}"`, { stdio: 'pipe', cwd: ROOT });

  // Push with retry + random jitter to handle concurrent jobs pushing to the same branch.
  // Each shard writes to a different directory so merges are always conflict-free.
  const MAX_PUSH_ATTEMPTS = 10;
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    try {
      execSync('git fetch origin main', { stdio: 'pipe', cwd: ROOT });
      execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main', { stdio: 'pipe', cwd: ROOT });
      console.log(`  Committed and pushed: ${msg}`);
      return;
    } catch (err) {
      if (attempt === MAX_PUSH_ATTEMPTS) {
        console.error(`  Push failed after ${MAX_PUSH_ATTEMPTS} attempts: ${err.message}`);
        return;
      }
      // Random jitter: 3–30 seconds, increasing with attempt number
      const jitter = Math.floor(Math.random() * 15000) + (attempt * 3000);
      console.log(`  Push conflict (attempt ${attempt}/${MAX_PUSH_ATTEMPTS}) — retrying in ${Math.round(jitter / 1000)}s…`);
      await sleep(jitter);
    }
  }
}

// ─── Sleep ────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// doFetch: wraps https.request with keepAlive:false to force a new TCP connection
// per request. This prevents CloudFront per-connection rate limiting.
function doFetch(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body   = options.body || '';
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  { ...options.headers, 'content-length': Buffer.byteLength(body) },
      agent:    new https.Agent({ keepAlive: false }),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        // Build a headers.get() shim matching the Fetch API.
        // Node's https module stores set-cookie as an array; join with ', '
        // so our existing cookie-parsing code works unchanged.
        const hdrs = res.headers;
        const headers = {
          get(name) {
            const val = hdrs[name.toLowerCase()];
            if (val === undefined || val === null) return null;
            return Array.isArray(val) ? val.join(', ') : val;
          },
        };
        resolve({
          status:  res.statusCode,
          ok:      res.statusCode >= 200 && res.statusCode < 300,
          headers,
          text:    () => Promise.resolve(rawBody),
          json:    () => Promise.resolve(JSON.parse(rawBody)),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nfetch-profile-stats  shard=${SHARD}  force=${FORCE}`);
  console.log('─'.repeat(50));

  const indexPath = path.join(ROOT, 'players', 'indexes', `${SHARD}.json`);
  if (!fs.existsSync(indexPath)) {
    console.error(`ERROR: index shard not found: ${indexPath}`);
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const uuids = Object.keys(index);
  console.log(`  UUIDs in shard: ${uuids.length}`);

  const allToFetch = FORCE
    ? uuids
    : uuids.filter(uuid => {
        try {
          const p = readPlayer(uuid);
          return !p?.sports?.Basketball?.statsChecked;
        } catch { return true; }
      });
  const toFetch = allToFetch.slice(0, MAX);

  const stats = {
    total:        Math.min(uuids.length, MAX),
    toFetch:      toFetch.length,
    written:      0,
    inaccessible: 0,
    skipped:      uuids.length - toFetch.length,
    errors:       0,
  };

  console.log(`  Already done (statsChecked present): ${stats.skipped}`);
  console.log(`  To fetch: ${stats.toFetch}`);

  if (stats.toFetch === 0) {
    console.log('  Nothing to do.');
    return;
  }

  // Random startup delay (0–60s) to spread 256 concurrent matrix jobs
  // and avoid hammering the session endpoint simultaneously.
  const startDelay = Math.floor(Math.random() * 60000);
  console.log(`  Startup delay: ${Math.round(startDelay / 1000)}s (spreading concurrent jobs)…`);
  await sleep(startDelay);

  console.log('\n  Obtaining session…');
  try {
    await refreshSession();
  } catch (err) {
    console.error(`  FATAL: Could not obtain session — ${err.message}`);
    console.log('  Writing empty summary and exiting cleanly.');
    const summaryPath = path.join(ROOT, `shard-summary-${SHARD}.json`);
    fs.writeFileSync(summaryPath, JSON.stringify({
      shard: SHARD, total: 0, already_done: 0, written: 0,
      inaccessible: 0, errors: 1, remaining: 0, blocked: false,
    }));
    process.exit(0);
  }

  console.log(`\n  Running (concurrency=${CONCURRENCY})…\n`);

  let blocked = false;

  for (let i = 0; i < toFetch.length; i++) {
    const uuid = toFetch[i];
    const result = await processUUID(uuid, stats, i + 1);

    if (result && result.status === 'cloudfront-block') {
      console.log(`\n  ⛔ CloudFront rate limit hit at position ${i + 1}/${toFetch.length}.`);
      console.log(`  Committing ${stats.written} written so far — re-run this shard to continue.`);
      blocked = true;
      break;
    }

    await sleep(REQUEST_DELAY);
  }

  stats.blocked = blocked;

  console.log('\n' + '─'.repeat(50));
  console.log(`  Written:       ${stats.written}`);
  console.log(`  Inaccessible:  ${stats.inaccessible}  (files untouched)`);
  console.log(`  Skipped:       ${stats.skipped}`);
  console.log(`  Errors:        ${stats.errors}`);
  if (stats.blocked) {
    const remaining = stats.toFetch - stats.written - stats.inaccessible - stats.errors;
    console.log(`  Remaining:     ~${remaining} (re-run shard to continue)`);
  }

  // Write shard summary for matrix aggregation
  const summaryPath = path.join(ROOT, `shard-summary-${SHARD}.json`);
  const remaining = stats.toFetch - stats.written - stats.inaccessible - stats.errors;
  fs.writeFileSync(summaryPath, JSON.stringify({
    shard:        SHARD,
    total:        stats.total,
    already_done: stats.skipped,
    written:      stats.written,
    inaccessible: stats.inaccessible,
    errors:       stats.errors,
    remaining:    Math.max(0, remaining),
    blocked:      stats.blocked || false,
  }));

  console.log('\n  Committing…');
  await gitCommit(stats);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
