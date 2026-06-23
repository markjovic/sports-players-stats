// scripts/recheck-private-profiles.js
//
// Re-checks players previously marked as private/inaccessible.
// These are identified by: statsChecked present AND maxGamePTS === null.
//
// If now accessible: writes full stats (foulOuts, maxGamePTS, maxGameThreePt,
//                    records, statsChecked) — same as fetch-profile-stats.js.
// If still inaccessible: updates statsChecked timestamp only, so we know
//                        when it was last confirmed private.
//
// Run monthly. Safe to re-run — only touches private-marked players.
//
// Usage:
//   node scripts/recheck-private-profiles.js
//   node scripts/recheck-private-profiles.js --dry-run
//   node scripts/recheck-private-profiles.js --shard=06   # single shard

'use strict';

const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT  = path.join(__dirname, '..');
const ARGS  = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const DRY_RUN     = !!ARGS['dry-run'];
const SHARD_FILTER = ARGS.shard || null;

const PLAYERS_DIR   = path.join(ROOT, 'players');
const REQUEST_DELAY = 800;
const REFRESH_EVERY = 28;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP / session ───────────────────────────────────────────────────────────

const HEADERS_BASE = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

function doFetch(bodyObj, extraHeaders) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const h    = { ...HEADERS_BASE, ...extraHeaders,
                   'request-id': crypto.randomUUID(),
                   'content-length': Buffer.byteLength(body) };
    const req  = https.request(
      { hostname: 'api.playhq.com', path: '/graphql', method: 'POST',
        headers: h, agent: new https.Agent({ keepAlive: false }) },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode,
                      rawCookies: res.headers['set-cookie'],
                      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (e) { reject(e); }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let sessionCookie = null;
async function refreshSession() {
  const body = { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const { rawCookies } = await doFetch(body, {});
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

// ─── Query ────────────────────────────────────────────────────────────────────

const PROFILE_QUERY = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      statistics {
        season { id }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          gradeStatistics {
            grade { id name }
            gameStatistics {
              game {
                id
                round { name number isFinalsRound abbreviatedName }
                home { ... on DiscoverTeam { id name } }
                away { ... on DiscoverTeam { id name } }
              }
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

function parseProfileStats(data) {
  const seasonStats = data?.publicProfileStatistics?.seasonStatistics;
  if (!seasonStats) return null;

  const foulOuts         = {};
  let maxGamePTS         = null, maxGamePTSKey    = null;
  let maxGameThreePt     = null, maxGameThreePtKey = null;

  for (const season of seasonStats) {
    for (const reg of (season.statistics || [])) {
      const sid = reg?.season?.id;
      if (!sid) continue;
      for (const teamStat of (reg.teamStatistics || [])) {
        for (const gradeStat of (teamStat.gradeStatistics || [])) {
          for (const gameStat of (gradeStat.gameStatistics || [])) {
            const gameKey = gameStat.game?.id || null;
            const stats   = gameStat.statistics || [];
            const fouls   = statValue(stats, 'TOTAL_FOULS');
            const pts     = statValue(stats, 'TOTAL_SCORE');
            const three   = statValue(stats, '3_POINT_SCORE');

            if (fouls >= 5) foulOuts[sid] = (foulOuts[sid] || 0) + 1;
            if (pts > (maxGamePTS ?? 0)) {
              maxGamePTS    = pts;
              maxGamePTSKey = gameKey ? { gameKey, sid } : null;
            }
            if (three > (maxGameThreePt ?? 0)) {
              maxGameThreePt    = three;
              maxGameThreePtKey = gameKey ? { gameKey, sid } : null;
            }
          }
        }
      }
    }
  }

  return { foulOuts, maxGamePTS, maxGamePTSKey, maxGameThreePt, maxGameThreePtKey };
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
      execSync('git merge -X ours FETCH_HEAD --no-edit',  { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main',                    { stdio: 'pipe', cwd: ROOT });
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
  console.log('recheck-private-profiles.js');
  if (DRY_RUN)      console.log('  ⚠  DRY RUN');
  if (SHARD_FILTER) console.log(`  Shard filter: ${SHARD_FILTER}`);
  console.log('─'.repeat(50));

  // Load active season IDs for staleness check
  const INDEX_FILE  = path.join(ROOT, 'sports-index.json');
  const activeSids  = new Set();
  if (fs.existsSync(INDEX_FILE)) {
    const idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    for (const s of Object.values(idx.seasons || {})) {
      if (s.locked === false) activeSids.add(s.id);
    }
  }

  const now          = Date.now();
  const PRIVATE_DAYS = 30;   // recheck private-marked players monthly
  const ACTIVE_DAYS  = 90;   // recheck active-season players quarterly

  // Two categories:
  //   A — private-marked: statsChecked present AND maxGamePTS === null, older than PRIVATE_DAYS
  //   B — active-stale:   has real stats (maxGamePTS > 0), playing in active season,
  //                       statsChecked older than ACTIVE_DAYS
  //       Catches players who were previously fetchable but later went private mid-season.
  console.log('Scanning player files…');
  console.log(`  Private-marked threshold: ${PRIVATE_DAYS} days`);
  console.log(`  Active-season threshold:  ${ACTIVE_DAYS} days`);
  const toRecheck = [];
  let countA = 0, countB = 0;

  const shardDirs = fs.readdirSync(PLAYERS_DIR)
    .filter(d => /^[0-9a-f]{2}$/.test(d))
    .filter(d => !SHARD_FILTER || d === SHARD_FILTER)
    .sort();

  for (const shard of shardDirs) {
    const shardDir = path.join(PLAYERS_DIR, shard);
    const files    = fs.readdirSync(shardDir).filter(f => f.endsWith('.json'));
    for (const fname of files) {
      let player;
      try { player = JSON.parse(fs.readFileSync(path.join(shardDir, fname), 'utf8')); }
      catch (_) { continue; }
      const bk = player.sports?.Basketball;
      if (!bk?.statsChecked) continue;

      const checkedAge = (now - new Date(bk.statsChecked).getTime()) / (1000 * 60 * 60 * 24);

      // Category A: private-marked, monthly recheck
      if (bk.maxGamePTS === null && checkedAge >= PRIVATE_DAYS) {
        toRecheck.push({ uuid: player.uuid, shard, fname, category: 'A' });
        countA++;
        continue;
      }

      // Category B: was fetchable, in active season, quarterly recheck
      if (bk.maxGamePTS !== null && checkedAge >= ACTIVE_DAYS) {
        const hasActiveSeason = (player.seasons || []).some(s => activeSids.has(s.sid));
        if (hasActiveSeason) {
          toRecheck.push({ uuid: player.uuid, shard, fname, category: 'B' });
          countB++;
        }
      }
    }
  }

  console.log(`  Category A (private-marked, >${PRIVATE_DAYS}d old): ${countA}`);
  console.log(`  Category B (active-season,  >${ACTIVE_DAYS}d old):  ${countB}`);
  console.log(`  Total to recheck: ${toRecheck.length}`);
  if (toRecheck.length === 0) { console.log('  Nothing to recheck.'); return; }
  console.log();

  await refreshSession();

  let requestCount = 0;
  let recovered = 0, stillPrivate = 0, errors = 0;

  for (let i = 0; i < toRecheck.length; i++) {
    const { uuid, shard, fname } = toRecheck[i];
    const short = uuid.slice(0, 8);

    if (requestCount > 0 && requestCount % REFRESH_EVERY === 0) {
      console.log(`  ↺ Session refresh at request ${requestCount}`);
      await refreshSession();
    }
    requestCount++;

    let res;
    try {
      res = await doFetch(
        { operationName: 'ProfileSeasonStatistics',
          variables: { profileID: uuid }, query: PROFILE_QUERY },
        { 'Cookie': sessionCookie }
      );
    } catch (e) {
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
      // Still private — update statsChecked timestamp
      stillPrivate++;
      if (!DRY_RUN) {
        const playerFile = path.join(PLAYERS_DIR, shard, fname);
        const player     = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
        player.sports.Basketball.statsChecked = new Date().toISOString();
        fs.writeFileSync(playerFile, JSON.stringify(player));
      }
      await sleep(REQUEST_DELAY);
      continue;
    }

    if (res.status !== 200) {
      errors++;
      await sleep(REQUEST_DELAY);
      continue;
    }

    // Check for NOT_FOUND or other GraphQL errors
    if (res.body.errors && res.body.errors.length > 0) {
      const msg = res.body.errors[0]?.message || '';
      stillPrivate++;
      if (!DRY_RUN) {
        const playerFile = path.join(PLAYERS_DIR, shard, fname);
        const player     = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
        player.sports.Basketball.statsChecked = new Date().toISOString();
        fs.writeFileSync(playerFile, JSON.stringify(player));
      }
      if (i < 5 || i % 50 === 0)
        console.log(`  [${i+1}/${toRecheck.length}] — ${short} still inaccessible (${msg.slice(0, 40)})`);
      await sleep(REQUEST_DELAY);
      continue;
    }

    const parsed = parseProfileStats(res.body.data);
    if (!parsed) {
      // publicProfileStatistics is null — still private
      stillPrivate++;
      if (!DRY_RUN) {
        const playerFile = path.join(PLAYERS_DIR, shard, fname);
        const player     = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
        player.sports.Basketball.statsChecked = new Date().toISOString();
        fs.writeFileSync(playerFile, JSON.stringify(player));
      }
      await sleep(REQUEST_DELAY);
      continue;
    }

    // Now accessible — write full stats
    recovered++;
    const playerFile = path.join(PLAYERS_DIR, shard, fname);
    const player     = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
    const bk         = player.sports.Basketball;

    bk.foulOuts       = parsed.foulOuts;
    bk.maxGamePTS     = parsed.maxGamePTS;
    bk.maxGameThreePt = parsed.maxGameThreePt;
    bk.statsChecked   = new Date().toISOString();

    if (!player.records) player.records = {};
    player.records.maxGamePTS     = parsed.maxGamePTSKey
      ? { v: parsed.maxGamePTS,     ...parsed.maxGamePTSKey }
      : { v: parsed.maxGamePTS ?? null };
    player.records.maxGameThreePt = parsed.maxGameThreePtKey
      ? { v: parsed.maxGameThreePt, ...parsed.maxGameThreePtKey }
      : { v: parsed.maxGameThreePt ?? null };

    if (!DRY_RUN) fs.writeFileSync(playerFile, JSON.stringify(player));
    console.log(`  [${i+1}/${toRecheck.length}] ✓ RECOVERED ${short}  pts=${parsed.maxGamePTS ?? 0}`);
    await sleep(REQUEST_DELAY);
  }

  await gitCommit(
    `recheck-private-profiles: ${recovered} recovered, ${stillPrivate} still private, ${errors} errors`
  );

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('\n─'.repeat(50));
  console.log(`  Rechecked:     ${toRecheck.length}`);
  console.log(`  Recovered:     ${recovered}`);
  console.log(`  Still private: ${stillPrivate}`);
  console.log(`  Errors:        ${errors}`);
  console.log(`  Elapsed:       ${elapsed}s`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
