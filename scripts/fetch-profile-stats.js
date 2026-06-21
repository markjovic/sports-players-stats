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

const API_URL     = 'https://api.playhq.com/graphql';
const CONCURRENCY = 5;
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
    throw new Error('Failed to obtain session cookie after 5 attempts');
  })();

  return sessionPromise;
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
            const stats = gameStat.statistics || [];
            const fo    = statValue(stats, 'FOUL_OUT');
            const pts   = statValue(stats, 'POINTS');
            const three = statValue(stats, 'THREE_POINT_FIELD_GOALS_MADE');
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

// ─── API fetch — with session-refresh-aware 403 handling ─────────────────────
//
// A 403 can mean two different things:
//   A) Profile is genuinely inaccessible (private/deleted)
//   B) Session has expired
//
// We disambiguate by refreshing the session on the first 403 and retrying once.
// If the retry also 403s → truly inaccessible (A). Leave file untouched.
// If the retry succeeds → was a session expiry (B). Write normally.

async function fetchProfile(profileID) {
  if (!sessionCookie) await refreshSession();

  const body = { ...PROFILE_QUERY, variables: { profileID } };

  const attempt = async () => {
    const res = await fetch(API_URL, {
      method:  'POST',
      headers: {
        ...HEADERS_BASE,
        'request-id': crypto.randomUUID(),
        'Cookie':     sessionCookie,
      },
      body: JSON.stringify(body),
    });
    return res;
  };

  let res;
  try {
    res = await attempt();
  } catch (err) {
    return { status: 'error', err };
  }

  if (res.status === 403) {
    // Refresh session and retry once
    console.log(`  403 on ${profileID} — refreshing session and retrying`);
    try {
      await refreshSession();
      res = await attempt();
    } catch (err) {
      return { status: 'error', err };
    }

    // Still 403 after fresh session → genuinely inaccessible
    if (res.status === 403) return { status: 'inaccessible' };
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

async function processUUID(uuid, stats) {
  const result = await fetchProfile(uuid);

  if (result.status === 'inaccessible') {
    stats.inaccessible++;
    return;
  }

  if (result.status === 'error') {
    stats.errors++;
    console.error(`  ERROR ${uuid}: ${result.err?.message}`);
    return;
  }

  const parsed = parseProfileStats(result.data);
  if (!parsed) {
    stats.inaccessible++;
    return;
  }

  const player = readPlayer(uuid);
  if (!player.sports)            player.sports = {};
  if (!player.sports.Basketball) player.sports.Basketball = {};

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

  const indexPath = path.join(ROOT, 'players', 'indexes', `${SHARD}.json`);
  if (!fs.existsSync(indexPath)) {
    console.error(`ERROR: index shard not found: ${indexPath}`);
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const uuids = Object.keys(index);
  console.log(`  UUIDs in shard: ${uuids.length}`);

  const toFetch = FORCE
    ? uuids
    : uuids.filter(uuid => {
        try {
          const p = readPlayer(uuid);
          return !p?.sports?.Basketball?.statsChecked;
        } catch { return true; }
      });

  const stats = {
    total:        uuids.length,
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
  console.log(`  Inaccessible:  ${stats.inaccessible}  (files untouched)`);
  console.log(`  Skipped:       ${stats.skipped}`);
  console.log(`  Errors:        ${stats.errors}`);

  console.log('\n  Committing…');
  gitCommit(stats);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
