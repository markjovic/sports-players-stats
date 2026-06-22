// scripts/fetch-leaderboard-records.js
//
// Fetches publicProfileStatistics for the players appearing in the
// maxGamePTS and maxGameThreePt leaderboard categories, to backfill
// player.records with the gameKey for their career record game.
//
// Only processes players where records.maxGamePTS or records.maxGameThreePt
// is missing a gameKey — skips anyone already fully populated.
//
// Usage:
//   node scripts/fetch-leaderboard-records.js
//   node scripts/fetch-leaderboard-records.js --dry-run
//   node scripts/fetch-leaderboard-records.js --force  # re-fetch all leaderboard players

'use strict';

const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const ARGS    = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const DRY_RUN = !!ARGS['dry-run'];
const FORCE   = !!ARGS.force;

const API_URL        = 'https://api.playhq.com/graphql';
const LB_FILE        = path.join(ROOT, 'leaderboard', 'all-time.json');
const PLAYERS_DIR    = path.join(ROOT, 'players');
const REQUEST_DELAY  = 800;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const HEADERS_BASE = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

function doFetch(bodyObj, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const h    = { ...headers, 'request-id': crypto.randomUUID(),
                   'content-length': Buffer.byteLength(body) };
    const req  = https.request(
      { hostname: 'api.playhq.com', path: '/graphql', method: 'POST',
        headers: h, agent: new https.Agent({ keepAlive: false }) },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode,
                          rawCookies: res.headers['set-cookie'],
                          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (e) { reject(e); }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Session ──────────────────────────────────────────────────────────────────

let sessionCookie = null;

async function refreshSession() {
  const body = { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const { rawCookies } = await doFetch(body, HEADERS_BASE);
      if (!rawCookies) continue;
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

// ─── Profile query ────────────────────────────────────────────────────────────

const PROFILE_QUERY = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      statistics {
        season { id }
        teamStatistics {
          gradeStatistics {
            gameStatistics {
              game { id }
              statistics { count details { value } }
            }
          }
        }
      }
    }
  }
}`;

function statValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const m = statistics.find(s => s?.details?.value === typeValue);
  return m ? (m.count || 0) : 0;
}

// Returns { maxGamePTS: {v, gameKey, sid}, maxGameThreePt: {v, gameKey, sid} }
function parseRecords(data) {
  const seasonStats = data?.publicProfileStatistics?.seasonStatistics;
  if (!seasonStats) return null;

  let maxPTS = null, maxPTSKey = null;
  let max3PT = null, max3PTKey = null;

  for (const season of seasonStats) {
    for (const reg of (season.statistics || [])) {
      const sid = reg?.season?.id;
      if (!sid) continue;
      for (const teamStat of (reg.teamStatistics || [])) {
        for (const gradeStat of (teamStat.gradeStatistics || [])) {
          for (const gameStat of (gradeStat.gameStatistics || [])) {
            const gameKey = gameStat.game?.id || null;
            const stats   = gameStat.statistics || [];
            const pts     = statValue(stats, 'TOTAL_SCORE');
            const three   = statValue(stats, '3_POINT_SCORE');

            if (pts > (maxPTS ?? 0)) {
              maxPTS    = pts;
              maxPTSKey = gameKey ? { gameKey, sid } : null;
            }
            if (three > (max3PT ?? 0)) {
              max3PT    = three;
              max3PTKey = gameKey ? { gameKey, sid } : null;
            }
          }
        }
      }
    }
  }

  return {
    maxGamePTS:     maxPTSKey ? { v: maxPTS,  ...maxPTSKey } : { v: maxPTS },
    maxGameThreePt: max3PTKey ? { v: max3PT,  ...max3PTKey } : { v: max3PT },
  };
}

// ─── Player file helpers ──────────────────────────────────────────────────────

function playerFilePath(uuid) {
  return path.join(PLAYERS_DIR, uuid.slice(0, 2), `${uuid}.json`);
}

function readPlayer(uuid) {
  try { return JSON.parse(fs.readFileSync(playerFilePath(uuid), 'utf8')); }
  catch (_) { return null; }
}

function writePlayer(uuid, data) {
  if (DRY_RUN) return;
  fs.writeFileSync(playerFilePath(uuid), JSON.stringify(data));
}

// ─── Git commit ───────────────────────────────────────────────────────────────

async function gitCommit(message) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  try { execSync('git add players/', { stdio: 'pipe', cwd: ROOT }); } catch (_) {}
  const staged = (() => {
    try { return execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim(); }
    catch (_) { return ''; }
  })();
  if (!staged) { return; }
  try { execSync(`git commit -m "${message.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT }); }
  catch (_) { return; }
  const MAX = 10;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      execSync('git fetch origin main',                    { stdio: 'pipe', cwd: ROOT });
      execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main',                   { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✓ ${message}`);
      return;
    } catch (_) {
      if (attempt === MAX) { console.error(`  Push failed after ${MAX} attempts`); return; }
      await sleep(Math.floor(Math.random() * 15000) + attempt * 3000);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log('fetch-leaderboard-records.js');
  if (DRY_RUN) console.log('  ⚠  DRY RUN');
  if (FORCE)   console.log('  ⚠  FORCE — re-fetching all leaderboard players');
  console.log('─'.repeat(50));

  // Load leaderboard to find which players to fetch
  if (!fs.existsSync(LB_FILE)) {
    console.error('leaderboard/all-time.json not found — run build-leaderboards.js first');
    process.exit(1);
  }
  const lb = JSON.parse(fs.readFileSync(LB_FILE, 'utf8'));

  // Collect unique UUIDs from maxGamePTS and maxGameThreePt categories
  const targetUUIDs = new Set();
  for (const cat of ['maxGamePTS', 'maxGameThreePt']) {
    for (const entry of (lb[cat] || [])) {
      if (entry.uuid) targetUUIDs.add(entry.uuid);
    }
  }

  if (targetUUIDs.size === 0) {
    console.log('No maxGamePTS or maxGameThreePt entries in leaderboard.');
    console.log('Run build-leaderboards.js first to populate these categories.');
    process.exit(0);
  }

  console.log(`Leaderboard players to check: ${targetUUIDs.size}`);

  // Filter to only players missing a gameKey (unless --force)
  const toFetch = [];
  for (const uuid of targetUUIDs) {
    if (!FORCE) {
      const player = readPlayer(uuid);
      if (!player) { toFetch.push(uuid); continue; }
      const hasPTSKey   = player.records?.maxGamePTS?.gameKey;
      const has3PTKey   = player.records?.maxGameThreePt?.gameKey;
      // Only fetch if either record is missing a gameKey
      if (hasPTSKey && has3PTKey) continue;
    }
    toFetch.push(uuid);
  }

  console.log(`Need fetching (missing gameKey): ${toFetch.length}`);
  if (toFetch.length === 0) {
    console.log('All leaderboard players already have records with gameKey. Done.');
    process.exit(0);
  }
  console.log();

  await refreshSession();

  let requestCount = 0;
  let written = 0, inaccessible = 0, errors = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const uuid  = toFetch[i];
    const short = uuid.slice(0, 8);

    // Proactive session refresh every 28 requests
    if (requestCount > 0 && requestCount % 28 === 0) {
      console.log(`  ↺ Session refresh at request ${requestCount}`);
      await refreshSession();
    }
    requestCount++;

    let res;
    try {
      res = await doFetch(
        { operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid },
          query: PROFILE_QUERY },
        { ...HEADERS_BASE, 'Cookie': sessionCookie }
      );
    } catch (e) {
      console.log(`  [${i+1}/${toFetch.length}] ✗ ${short} network error: ${e.message}`);
      errors++;
      await sleep(REQUEST_DELAY);
      continue;
    }

    if (res.status === 403) {
      const body = JSON.stringify(res.body || '');
      if (body.includes('DOCTYPE') || body.includes('Request blocked')) {
        console.log(`  ⛔ CloudFront block at request ${requestCount} — stopping`);
        break;
      }
      console.log(`  [${i+1}/${toFetch.length}] — ${short} inaccessible`);
      inaccessible++;
      await sleep(REQUEST_DELAY);
      continue;
    }

    if (res.status !== 200 || res.body.errors) {
      console.log(`  [${i+1}/${toFetch.length}] ✗ ${short} HTTP ${res.status}`);
      errors++;
      await sleep(REQUEST_DELAY);
      continue;
    }

    const records = parseRecords(res.body.data);
    if (!records) {
      console.log(`  [${i+1}/${toFetch.length}] — ${short} no profile data`);
      inaccessible++;
      await sleep(REQUEST_DELAY);
      continue;
    }

    const player = readPlayer(uuid);
    if (!player) { errors++; await sleep(REQUEST_DELAY); continue; }

    if (!player.records) player.records = {};
    player.records.maxGamePTS     = records.maxGamePTS;
    player.records.maxGameThreePt = records.maxGameThreePt;

    writePlayer(uuid, player);
    written++;

    const ptsKey   = records.maxGamePTS?.gameKey     ? `✓ gameKey` : `no gameKey`;
    const threePtKey = records.maxGameThreePt?.gameKey ? `✓ gameKey` : `no gameKey`;
    console.log(`  [${i+1}/${toFetch.length}] ✓ ${short}  PTS:${records.maxGamePTS?.v ?? 0}(${ptsKey})  3PT:${records.maxGameThreePt?.v ?? 0}(${threePtKey})`);

    await sleep(REQUEST_DELAY);
  }

  await gitCommit(`fetch-leaderboard-records: ${written} player records updated`);

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('\n─'.repeat(50));
  console.log(`  Fetched:       ${toFetch.length}`);
  console.log(`  Written:       ${written}`);
  console.log(`  Inaccessible:  ${inaccessible}`);
  console.log(`  Errors:        ${errors}`);
  console.log(`  Elapsed:       ${elapsed}s`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
