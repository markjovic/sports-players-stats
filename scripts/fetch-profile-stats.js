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
// statsChecked is ONLY written on a real data response (even if all nulls/empty).
// 403 and null responses leave the player file completely untouched.
//
// One git commit after all writes for the shard.

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ─── CLI args ────────────────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const SHARD = (args.find(a => a.startsWith('--shard=')) || '').replace('--shard=', '').toLowerCase().trim();
const FORCE = args.includes('--force');

if (!SHARD || !/^[0-9a-f]{2}$/.test(SHARD)) {
  console.error('Usage: node scripts/fetch-profile-stats.js --shard=<00-ff> [--force]');
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const API_URL    = 'https://api.playhq.com/graphql';
const CONCURRENCY = 5;
const RETRY_LIMIT = 3;
const RETRY_BASE  = 2000; // ms, multiplied by attempt number

// ─── Headers — full set, never split, never modified ─────────────────────────

const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── Session cookie (promise-locked — one fetch at a time) ───────────────────

let sessionCookie  = null;
let sessionFetching = null;

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
  if (sessionFetching) return sessionFetching;
  sessionFetching = (async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) await sleep(attempt * 3000);
      for (const body of COOKIE_QUERIES) {
        const res = await fetch(API_URL, {
          method:  'POST',
          headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() },
          body:    JSON.stringify(body),
        });
        const raw = res.headers.get('set-cookie');
        if (!raw) continue;
        // Documented 3-part cookie extraction
        sessionCookie = raw.split(',').map(c => c.trim().split(';')[0]).join('; ');
        console.log(`  Session obtained (attempt ${attempt})`);
        sessionFetching = null;
        return;
      }
    }
    throw new Error('Failed to obtain session cookie after 5 attempts');
  })();
  return sessionFetching;
}

// ─── GraphQL query ────────────────────────────────────────────────────────────

const PROFILE_QUERY = {
  operationName: 'ProfileSeasonStatistics',
  query: `query ProfileSeasonStatistics($profileID: ID!) {
    publicProfileStatistics(profileID: $profileID) {
      seasonStatistics {
        statistics {
          season { id }
          teamStatistics {
            team { ... on DiscoverTeam { id name } }
            gradeStatistics {
              grade { id name }
              gameStatistics {
                game { id }
                statistics { count details { value } }
              }
            }
          }
        }
      }
    }
  }`,
};

// ─── Stat helpers ─────────────────────────────────────────────────────────────

function statValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const match = statistics.find(s => Array.isArray(s.details) && s.details[0]?.value === typeValue);
  return match ? (match.count || 0) : 0;
}

// Returns { foulOuts, maxGamePTS, maxGameThreePt } or null if profile inaccessible.
function parseProfileStats(data) {
  const seasonStats = data?.publicProfileStatistics?.seasonStatistics;
  if (!seasonStats) return null;

  const foulOuts     = {};
  let maxGamePTS     = null;
  let maxGameThreePt = null;

  for (const season of seasonStats) {
    const seasonId = season?.statistics?.[0]?.season?.id;
    if (!seasonId) continue;

    let seasonFoulOuts = 0;

    for (const stat of (season.statistics || [])) {
      for (const teamStat of (stat.teamStatistics || [])) {
        for (const gradeStat of (teamStat.gradeStatistics || [])) {
          for (const gameStat of (gradeStat.gameStatistics || [])) {
            const stats  = gameStat.statistics || [];
            const fo     = statValue(stats, 'FOUL_OUT');
            const pts    = statValue(stats, 'POINTS');
            const three  = statValue(stats, 'THREE_POINT_FIELD_GOALS_MADE');

            seasonFoulOuts += fo;
            if (pts   > (maxGamePTS     ?? 0)) maxGamePTS     = pts;
            if (three > (maxGameThreePt ?? 0)) maxGameThreePt = three;
          }
        }
      }
    }

    if (seasonFoulOuts > 0) foulOuts[seasonId] = seasonFoulOuts;
  }

  return { foulOuts, maxGamePTS, maxGameThreePt };
}

// ─── API fetch ────────────────────────────────────────────────────────────────

// Returns:
//   { status: 'ok',           data }   — real response, write statsChecked
//   { status: 'inaccessible' }         — 403 or null body — do NOT touch file
//   { status: 'error',        err  }   — network/parse failure

async function fetchProfile(profileID) {
  if (!sessionCookie) await refreshSession();

  const body = { ...PROFILE_QUERY, variables: { profileID } };

  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    let res;
    try {
      res = await fetch(API_URL, {
        method:  'POST',
        headers: {
          ...HEADERS_BASE,
          'request-id': crypto.randomUUID(),
          'Cookie':     sessionCookie,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt === RETRY_LIMIT) return { status: 'error', err };
      await sleep(RETRY_BASE * attempt);
      continue;
    }

    // 403 = profile inaccessible — leave file untouched
    if (res.status === 403) return { status: 'inaccessible' };

    if (!res.ok) {
      if (attempt === RETRY_LIMIT) return { status: 'error', err: new Error(`HTTP ${res.status}`) };
      await sleep(RETRY_BASE * attempt);
      continue;
    }

    let json;
    try { json = await res.json(); }
    catch (err) { return { status: 'error', err }; }

    const data = json.data || json;

    // Null body = inaccessible profile — leave file untouched
    if (!data?.publicProfileStatistics) return { status: 'inaccessible' };

    return { status: 'ok', data };
  }
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

async function processUUID(uuid, stats) {
  const result = await fetchProfile(uuid);

  if (result.status === 'inaccessible') {
    // Leave file completely untouched — no statsChecked written
    stats.inaccessible++;
    return;
  }

  if (result.status === 'error') {
    stats.errors++;
    console.error(`  ERROR ${uuid}: ${result.err?.message}`);
    return;
  }

  // Real data response — parse and write atomically
  const parsed = parseProfileStats(result.data);
  if (!parsed) {
    // Shouldn't happen given the null check in fetchProfile, but be safe
    stats.inaccessible++;
    return;
  }

  const player = readPlayer(uuid);
  if (!player.sports)             player.sports = {};
  if (!player.sports.Basketball)  player.sports.Basketball = {};

  // All four fields written together — no partial state possible
  player.sports.Basketball.foulOuts       = parsed.foulOuts;
  player.sports.Basketball.maxGamePTS     = parsed.maxGamePTS;
  player.sports.Basketball.maxGameThreePt = parsed.maxGameThreePt;
  player.sports.Basketball.statsChecked   = new Date().toISOString();

  writePlayer(uuid, player);
  stats.written++;
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

function gitCommit(stats) {
  try {
    execSync(`git add players/${SHARD}`, { stdio: 'pipe', cwd: ROOT });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim();
    if (!diff) { console.log('  No changes to commit.'); return; }
    const msg = `fetch-profile-stats: shard ${SHARD} — ${stats.written} written, ${stats.inaccessible} inaccessible, ${stats.skipped} skipped`;
    execSync(`git commit -m "${msg}"`, { stdio: 'pipe', cwd: ROOT });
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe', cwd: ROOT });
    execSync('git push', { stdio: 'pipe', cwd: ROOT });
    console.log(`  Committed: ${msg}`);
  } catch (err) {
    console.error(`  Git commit failed: ${err.message}`);
  }
}

// ─── Sleep ────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nfetch-profile-stats  shard=${SHARD}  force=${FORCE}`);
  console.log('─'.repeat(50));

  // Load index shard — only this file needed to get UUIDs
  const indexPath = path.join(ROOT, 'players', 'indexes', `${SHARD}.json`);
  if (!fs.existsSync(indexPath)) {
    console.error(`ERROR: index shard not found: ${indexPath}`);
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const uuids = Object.keys(index);
  console.log(`  UUIDs in shard: ${uuids.length}`);

  // Skip those already fully fetched (unless --force)
  const toFetch = FORCE
    ? uuids
    : uuids.filter(uuid => {
        try {
          const p = readPlayer(uuid);
          return !p?.sports?.Basketball?.statsChecked;
        } catch { return true; }
      });

  const stats = {
    total:       uuids.length,
    toFetch:     toFetch.length,
    written:     0,
    inaccessible: 0,
    skipped:     uuids.length - toFetch.length,
    errors:      0,
  };

  console.log(`  Already done (statsChecked present): ${stats.skipped}`);
  console.log(`  To fetch: ${stats.toFetch}`);

  if (stats.toFetch === 0) {
    console.log('  Nothing to do.');
    return;
  }

  console.log('\n  Obtaining session…');
  await refreshSession();

  let done = 0;
  const tasks = toFetch.map(uuid => async () => {
    await processUUID(uuid, stats);
    done++;
    if (done % 50 === 0 || done === stats.toFetch) {
      console.log(`  ${done}/${stats.toFetch}  written=${stats.written}  inaccessible=${stats.inaccessible}  errors=${stats.errors}`);
    }
  });

  console.log(`\n  Running (concurrency=${CONCURRENCY})…\n`);
  await runPool(tasks, CONCURRENCY);

  console.log('\n' + '─'.repeat(50));
  console.log(`  Written:       ${stats.written}`);
  console.log(`  Inaccessible:  ${stats.inaccessible}  (files untouched — will retry next run)`);
  console.log(`  Skipped:       ${stats.skipped}`);
  console.log(`  Errors:        ${stats.errors}`);

  console.log('\n  Committing…');
  gitCommit(stats);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
