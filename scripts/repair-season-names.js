// scripts/repair-season-names.js
//
// Repairs player records whose `name` is a SEASON name (the parseProfileStats
// bug — the backfill wrote seasonStatistics[].name as the player name). For
// each contaminated record it probes the record's OWN games[] via the spectator
// box score to recover the real player name, then rewrites player.name and the
// index name. NAME-ONLY: stats/seasons/games are already correct and untouched.
//
// The name cannot be read locally — games/bv stores only the truncated player
// id (name omitted; nightly-crawl.js line ~881), and the profile API has no
// player-name field. The spectator box score is the only source.
//
// Transport / session / spectator parsing are copied VERBATIM from
// backfill-missing-players.js (which sourced them from nightly-crawl.js /
// fetch-profile-stats.js), so this survives CloudFront the same way. No
// actions/setup-node in the workflow (changes the runner fingerprint → 403).
//
// Modes (mirror backfill-missing-players.js for matrix compatibility):
//   --candidates-file=PATH  bucket file of contaminated uuids (from repair-generate-candidates.js)
//   --bucket=XX             only process uuids whose prefix == XX
//   --no-commit             write files but don't git commit (matrix apply-and-commit does it)
//   --gentle [--pace=MS]    serial + paced calls, for the stubborn high-appearance tail
//   --max=N                 cap records processed this run
//   --dry-run               resolve names but write nothing
//
// Usage:
//   node scripts/repair-season-names.js --candidates-file=/tmp/repair/ab.json --bucket=ab --no-commit

'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const crypto  = require('crypto');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const INDEX_DIR   = path.join(ROOT, 'players', 'indexes');
const PLAYERS_DIR = path.join(ROOT, 'players');
const SPORT_INDEX_FILE = path.join(ROOT, 'data', 'sports-index.json');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const CANDIDATES_FILE = ARGS['candidates-file'] || null;
const BUCKET   = ARGS.bucket || null;
const NO_COMMIT = !!ARGS['no-commit'];
const DRY_RUN   = !!ARGS['dry-run'];
const MAX       = ARGS.max ? parseInt(ARGS.max, 10) : Infinity;
const GENTLE    = !!ARGS['gentle'];
const PACE_MS   = GENTLE ? (ARGS.pace ? parseInt(ARGS.pace, 10) : 1200) : 0;
const SPECTATOR_CONCURRENCY = GENTLE ? 1 : 3;
const PROBE_CAP = 8;         // max box scores to try per record before giving up on a name
const COMMIT_EVERY = 200;    // commit progress periodically (in-memory progress is lost on timeout)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }
function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
function playerShard(uuid)     { return uuid.slice(0, 2).toLowerCase(); }
function playerFilePath(uuid)  { return path.join(PLAYERS_DIR, playerShard(uuid), `${uuid}.json`); }
function indexShardPath(shard) { return path.join(INDEX_DIR, `${shard}.json`); }

function isPlaceholderName(nm) {
  if (!nm) return true;
  return /^player\s*#/i.test(String(nm).trim());
}

// ─── HTTP transport — copied verbatim from backfill-missing-players.js ──────
let paceChain = Promise.resolve();
function doFetch(url, options) {
  if (!PACE_MS) return doFetchRaw(url, options);
  const run = paceChain.then(async () => { await sleep(PACE_MS); return doFetchRaw(url, options); });
  paceChain = run.then(() => undefined, () => undefined);
  return run;
}
function doFetchRaw(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body   = options.body || '';
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'POST',
      headers:  { ...options.headers, 'content-length': Buffer.byteLength(body) },
      agent:    new https.Agent({ keepAlive: false }),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          rawCookies: res.headers['set-cookie'],
          text: () => Promise.resolve(rawBody),
          json: () => { try { return Promise.resolve(JSON.parse(rawBody)); } catch (e) { return Promise.reject(e); } },
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Headers + session — copied verbatim from backfill-missing-players.js ───
const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const HEADERS_BASE = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};
const HEADERS_SPECTATOR = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'bv', 'x-phq-tenant': 'bv', 'content-type': 'application/json',
};
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

let sessionCookie = null;
let refreshPromise = null; // promise-lock: concurrent callers await ONE refresh
function refreshSession() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefreshSession().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
async function doRefreshSession() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 5000);
    for (const body of COOKIE_QUERIES) {
      let res;
      try {
        res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() }, body: JSON.stringify(body) });
      } catch (_) { continue; }
      const raw = res.rawCookies;
      if (!raw) continue;
      const arr = (Array.isArray(raw) ? raw : [raw]).map(c => c.split(';')[0].trim());
      const get = n => arr.find(p => p.startsWith(n + '=')) || null;
      const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
      if (!tier || !session || !sub) continue;
      sessionCookie = `${tier}; ${session}; ${sub}`;
      console.log(`  Session refreshed (attempt ${attempt})`);
      return;
    }
  }
  throw new Error('Failed to obtain session after 10 attempts');
}

// gqlSpectator + parseSpectatorPlayers — copied verbatim from
// backfill-missing-players.js. Returns null on CloudFront block / error.
let cloudfrontBlocked = false;
async function gqlSpectator(gameId) {
  if (!sessionCookie) await refreshSession();
  const query = `query game($id: ID!) {
    game(id: $id) {
      id status
      statistics {
        home { players { profileID name playerNumber statistics { type { value } count } } }
        away { players { profileID name playerNumber statistics { type { value } count } } }
      }
    }
  }`;
  const body = JSON.stringify({ operationName: 'game', variables: { id: gameId }, query });
  try {
    let res = await doFetch(SPECTATOR_URL, { headers: { ...HEADERS_SPECTATOR, 'request-id': crypto.randomUUID(), Cookie: sessionCookie }, body });
    if (res.status === 403) {
      await refreshSession();
      res = await doFetch(SPECTATOR_URL, { headers: { ...HEADERS_SPECTATOR, 'request-id': crypto.randomUUID(), Cookie: sessionCookie }, body });
      if (res.status === 403) { cloudfrontBlocked = true; return null; }
      if (res.status !== 200) return null;
      const j = await res.json().catch(() => null);
      if (!j || j.errors) return null;
      return j.data?.game || null;
    }
    if (res.status !== 200) return null;
    const j = await res.json().catch(() => null);
    if (!j || j.errors) return null;
    return j.data?.game || null;
  } catch (_) { return null; }
}
function parseSpectatorPlayers(players) {
  if (!Array.isArray(players)) return [];
  return players.filter(p => p && p.profileID).map(p => ({ profileID: p.profileID, name: p.name || null }));
}

// ─── Season-name detection (ground truth, from sports-index) ────────────────
let sportIndex = { seasons: {} };
try { sportIndex = readJson(SPORT_INDEX_FILE); } catch (_) {}
const knownSeasonNames = new Set();
for (const sid of Object.keys(sportIndex.seasons || {})) {
  const nm = normName(sportIndex.seasons[sid] && sportIndex.seasons[sid].name);
  if (nm) knownSeasonNames.add(nm);
}
function isSeasonName(nm) { return knownSeasonNames.has(normName(nm)); }

// ─── Name probe: fetch the record's OWN games until a name is found ─────────
// Stops at the first box score that lists this uuid with a name (cap PROBE_CAP).
async function probeName(uuid, games) {
  const gids = Array.isArray(games) ? games : [];
  for (let i = 0; i < gids.length && i < PROBE_CAP; i++) {
    if (cloudfrontBlocked) return null;
    const game = await gqlSpectator(gids[i]);
    if (!game?.statistics) continue;
    const players = [
      ...parseSpectatorPlayers(game.statistics?.home?.players),
      ...parseSpectatorPlayers(game.statistics?.away?.players),
    ];
    const mine = players.find(p => p.profileID === uuid);
    if (mine && mine.name) return mine.name;
  }
  return null;
}

// ─── git ────────────────────────────────────────────────────────────────────
function gitCommit(paths, message) {
  if (NO_COMMIT || DRY_RUN) return;
  try {
    execSync('git config user.name "github-actions[bot]"');
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
    for (const p of paths) execSync(`git add "${p}"`);
    const staged = execSync('git diff --cached --shortstat').toString().trim();
    if (!staged) return;
    execSync(`git commit -m "${message}" --quiet`);
    execSync('git fetch origin --quiet');
    try { execSync('git merge -X ours origin/main --no-edit --quiet'); } catch (_) {}
    execSync('git push --quiet');
    console.log(`  Committed: ${message}`);
  } catch (e) {
    console.log(`  ⚠ git commit failed: ${e.message}`);
  }
}

// ─── main ─────────────────────────────────────────────────────────────────
function discoverContaminated() {
  // From a bucket candidates file if given (matrix), else scan all index shards.
  if (CANDIDATES_FILE) {
    const list = readJson(CANDIDATES_FILE);
    const uuids = Array.isArray(list) ? list : Object.keys(list);
    return uuids.filter(u => !BUCKET || playerShard(u) === BUCKET.toLowerCase());
  }
  const out = [];
  let shardFiles = [];
  try { shardFiles = fs.readdirSync(INDEX_DIR).filter(f => /^[0-9a-f]{2}\.json$/i.test(f)); } catch (_) {}
  for (const f of shardFiles) {
    const shard = f.slice(0, 2);
    if (BUCKET && shard !== BUCKET.toLowerCase()) continue;
    let idx; try { idx = readJson(path.join(INDEX_DIR, f)); } catch (_) { continue; }
    for (const [uuid, rec] of Object.entries(idx)) {
      if (rec && isSeasonName(rec.name)) out.push(uuid);
    }
  }
  return out;
}

async function main() {
  console.log('repair-season-names.js');
  console.log('─'.repeat(60));
  if (!knownSeasonNames.size) { console.error('No known season names loaded from sports-index — aborting (cannot identify contamination).'); process.exit(1); }

  const contaminated = discoverContaminated();
  console.log(`  Known season names       : ${knownSeasonNames.size}`);
  console.log(`  Contaminated candidates  : ${contaminated.length}${BUCKET ? ` (bucket ${BUCKET})` : ''}`);
  const toProcess = contaminated.slice(0, MAX === Infinity ? contaminated.length : MAX);
  console.log(`  Processing this run      : ${toProcess.length}${MAX !== Infinity ? ` (--max=${MAX})` : ''}`);
  if (GENTLE) console.log(`  GENTLE mode: serial + ${PACE_MS}ms pacing`);

  // Group by index shard so we can load/update/write each index shard once.
  const byShard = new Map();
  for (const uuid of toProcess) {
    const s = playerShard(uuid);
    if (!byShard.has(s)) byShard.set(s, []);
    byShard.get(s).push(uuid);
  }

  let fixed = 0, alreadyOk = 0, noName = 0, fileMissing = 0, blocked = false;
  const touchedPlayerFiles = new Set();
  const touchedIndexShards = new Set();
  let sinceCommit = 0;

  outer:
  for (const [shard, uuids] of byShard) {
    let idx;
    const ip = indexShardPath(shard);
    try { idx = readJson(ip); } catch (_) { idx = {}; }

    // Concurrency within a shard (gentle → 1). Simple sequential when gentle,
    // small pool otherwise — but each record's probe is itself sequential.
    const pool = [];
    const runOne = async (uuid) => {
      if (cloudfrontBlocked) return;
      let rec;
      try { rec = readJson(playerFilePath(uuid)); } catch (_) { fileMissing++; return; }
      // Idempotency: if the name is no longer a season name, it's already fixed.
      if (!isSeasonName(rec.name)) { alreadyOk++; return; }
      const realName = await probeName(uuid, rec.games);
      if (cloudfrontBlocked) return;
      if (!realName || isPlaceholderName(realName) || isSeasonName(realName)) { noName++; return; }
      rec.name = realName;
      rec.updatedAt = new Date().toISOString();
      if (!DRY_RUN) writeJson(playerFilePath(uuid), rec);
      if (idx[uuid]) idx[uuid].name = realName; else idx[uuid] = { name: realName, history: {} };
      touchedPlayerFiles.add(playerFilePath(uuid));
      touchedIndexShards.add(ip);
      fixed++;
      sinceCommit++;
    };

    for (const uuid of uuids) {
      if (cloudfrontBlocked) { blocked = true; }
      if (blocked) break;
      if (GENTLE || SPECTATOR_CONCURRENCY === 1) {
        await runOne(uuid);
      } else {
        pool.push(runOne(uuid));
        if (pool.length >= SPECTATOR_CONCURRENCY) { await Promise.all(pool.splice(0)); }
      }
      // periodic flush of this shard's index + commit
      if (sinceCommit >= COMMIT_EVERY && !cloudfrontBlocked) {
        if (!DRY_RUN) writeJson(ip, idx);
        gitCommit([PLAYERS_DIR + '/', INDEX_DIR + '/'], `repair-season-names: progress (+${fixed} fixed)`);
        sinceCommit = 0;
      }
    }
    await Promise.all(pool.splice(0));
    if (!DRY_RUN) writeJson(ip, idx); // flush this shard's index
    if (cloudfrontBlocked) { blocked = true; break outer; }
  }

  if (blocked) console.log('  ⛔ CloudFront block — committing what succeeded, then stopping. Re-run to continue.');

  // Final commit (matrix jobs pass --no-commit; apply-and-commit does the real one).
  gitCommit([PLAYERS_DIR + '/', INDEX_DIR + '/'], `repair-season-names: ${fixed} names repaired`);

  console.log('─'.repeat(60));
  console.log(`  Names repaired           : ${fixed}`);
  console.log(`  Already OK (idempotent)  : ${alreadyOk}`);
  console.log(`  No name found (retry)    : ${noName}`);
  console.log(`  Player file missing      : ${fileMissing}`);
  console.log(`  Remaining (re-run)       : ${contaminated.length - fixed - alreadyOk}`);
  console.log(`  CloudFront blocked       : ${blocked}`);
  console.log(`  Mode                     : ${DRY_RUN ? 'DRY-RUN' : (NO_COMMIT ? 'NO-COMMIT' : 'LIVE')}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
