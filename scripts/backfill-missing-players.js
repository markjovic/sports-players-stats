// scripts/backfill-missing-players.js
//
// One-off, resumable: creates player records for uuids that appear in
// games/bv/*.json (as full-length p[].id / hp[].profileID / ap[].profileID
// entries) but have no players/indexes/{shard}.json entry at all -- i.e. no
// player record has ever been created for them. These are exactly the
// historical players recovered by recover-uuids-from-git-history.js: their
// truncated id couldn't be resolved (no index entry existed), so their real,
// full-length uuid was restored straight from pre-migration git history into
// games/bv/*.json. Until this script runs, that uuid is a dead end.
//
// For each candidate uuid:
//   1. Probe publicProfileStatistics (same endpoint/session recipe as
//      fetch-profile-stats.js -- proven to work for this specific query).
//      If it returns real data, the profile is PUBLIC: build a full record
//      with real name + stats + seasons, exactly mirroring
//      fetch-profile-stats.js's "ok" branch. private: false.
//   2. If it 403s / not-found, the profile is PRIVATE. games/bv/*.json never
//      stored per-game stats -- only attendee lists (see
//      migrate-uuid-truncation.js's header note: "no current code path
//      writes hp[]/ap[] to game files at all anymore", and nightly-crawl.js
//      never writes per-player pts/fouls into game files either, only into
//      transient in-memory playerDeltas). So the ONLY way to get real
//      maxGamePTS/maxGameThreePt/foulOuts for a private player is to
//      re-query the spectator game(id) endpoint (same one nightly-crawl.js
//      uses for every FINAL game) for every game this uuid appeared in --
//      discovered in phase 1 below. Builds a stub record: name =
//      `Player #<prefix>` (TRUNC_LEN chars, matching uuid-prefix.cjs),
//      private: true, real aggregated stats from the re-fetched games.
//
// Name privacy note: the spectator endpoint returns a real name regardless
// of profile privacy (it's a box-score view, not the profile API), so it
// WOULD be technically possible to learn a private player's real name this
// way. Deliberately not used here -- the entire point of the private flag is
// to not expose identity, so a stub's displayed name stays `Player #...`
// even when the box score incidentally reveals a real name.
//
// Discovery (phase 1) is NOT persisted to a progress file -- it is
// recomputed fresh every run by scanning games/bv/*.json and checking which
// full-length uuids are absent from every players/indexes/{shard}.json.
// Any uuid already written (indexed) by a previous, possibly-interrupted,
// run is automatically excluded on the next scan -- the index itself IS the
// progress marker. Same lesson learned this session while rebuilding
// recover-uuids-from-git-history.js: no separate bookkeeping file needed
// when the real output is itself a durable, checkable marker.
//
// This workflow deliberately does NOT check out players/<shard>/ (the
// individual player JSON blobs -- large, and irrelevant here: every
// candidate this script touches is, by construction, NOT YET a player file,
// so nothing here ever reads an existing one). Only players/indexes/ (small,
// name+history only) is needed, exactly like diagnose-missing-player-files.js.
//
// Run:     node scripts/backfill-missing-players.js
// Dry run: node scripts/backfill-missing-players.js --dry-run
// Limit:   node scripts/backfill-missing-players.js --max=500   (testing)

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const https        = require('https');
const { execSync } = require('child_process');
const { isFullUuid, TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

const ROOT        = path.join(__dirname, '..');
const GAMES_DIR    = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR  = path.join(ROOT, 'players');
const INDEX_DIR    = path.join(ROOT, 'players', 'indexes');
const SPORT_INDEX_FILE = path.join(ROOT, 'data', 'sports-index.json');
const FORFEIT_FILE     = path.join(ROOT, 'data', 'forfeit-games.json');
const REPORT_FILE       = path.join(ROOT, 'reports', 'backfill-missing-players-report.json');

const ARGS    = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const MAX     = (() => { const a = ARGS.find(x => x.startsWith('--max=')); return a ? parseInt(a.split('=')[1], 10) : Infinity; })();

const COMMIT_EVERY  = 150; // candidates processed per commit
const PROFILE_BATCH = 30;  // matches fetch-profile-stats.js -- proven safe against CloudFront
const SPECTATOR_CONCURRENCY = 3; // matches nightly-crawl.js -- spectator.playhq.com's own safe limit

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

let sportIndex = { seasons: {} };
try { sportIndex = readJson(SPORT_INDEX_FILE); } catch (_) {}

const forfeitGameIds = new Set();
try {
  const ids = readJson(FORFEIT_FILE);
  for (const id of (Array.isArray(ids) ? ids : [])) forfeitGameIds.add(id);
} catch (_) {}

// ─── git commit (with push-conflict retry) ─────────────────────────────────
// Copied from nightly-crawl.js's gitCommit -- 10-attempt retry with jitter,
// proven under concurrent writers via the data-write concurrency lock.
async function gitCommit(message, dirs) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  const paths = (dirs && dirs.length ? dirs : ['.']).join(' ');
  try { execSync(`git add -- ${paths}`, { stdio: 'pipe', cwd: ROOT }); } catch (_) {}
  const staged = (() => {
    try { return execSync('git diff --staged --shortstat', { stdio: 'pipe', cwd: ROOT }).toString().trim(); }
    catch (_) { return ''; }
  })();
  if (!staged) return;
  try { execSync(`git commit -q -m "${message.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT }); }
  catch (_) { return; }
  const MAX_ATTEMPTS = 10;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      execSync('git fetch origin main',                            { stdio: 'pipe', cwd: ROOT });
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main',                             { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✓ Committed: ${message}`);
      return;
    } catch (_) {
      if (attempt === MAX_ATTEMPTS) { console.error(`  Push failed after ${MAX_ATTEMPTS} attempts`); return; }
      const jitter = Math.floor(Math.random() * 15000) + attempt * 3000;
      await sleep(jitter);
    }
  }
}

// ─── HTTP transport ─────────────────────────────────────────────────────────
// keepAlive:false forces a new TCP connection per request -- prevents
// CloudFront per-connection rate limiting. Same recipe as fetch-profile-stats.js
// and nightly-crawl.js.
function doFetch(url, options) {
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
        const hdrs = res.headers;
        resolve({
          status:     res.statusCode,
          ok:         res.statusCode >= 200 && res.statusCode < 300,
          rawCookies: hdrs['set-cookie'],
          text:       () => Promise.resolve(rawBody),
          json:       () => { try { return Promise.resolve(JSON.parse(rawBody)); } catch (e) { return Promise.reject(e); } },
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Profile-API session (publicProfileStatistics) ─────────────────────────
// Copied verbatim from fetch-profile-stats.js -- this exact two-query cookie
// recipe (TenantConfig then ProfileSearch) is what's proven to work for
// ProfileSeasonStatistics; nightly-crawl's simpler TenantConfig-only refresh
// is kept separate below for the spectator API, which has different quota
// behaviour. Do not merge these two session mechanisms speculatively.
const API_URL = 'https://api.playhq.com/graphql';
const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

let profileCookie  = null;
let profilePromise = null;

async function refreshProfileSession() {
  if (profilePromise) return profilePromise;
  profilePromise = (async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (attempt > 1) await sleep(attempt * 5000);
      for (const q of COOKIE_QUERIES) {
        let res;
        try {
          res = await doFetch(API_URL, {
            headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() },
            body:    JSON.stringify(q),
          });
        } catch (err) {
          console.log(`  [session attempt ${attempt}, ${q.operationName}] request threw: ${err.message}`);
          continue;
        }
        const raw = res.rawCookies;
        if (!raw) {
          // No visibility into WHY previously -- log enough to tell a WAF
          // block (HTML page, no set-cookie) apart from a legitimate
          // GraphQL error apart from a genuinely empty response.
          let snippet = '';
          try { snippet = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200); } catch (_) {}
          console.log(`  [session attempt ${attempt}, ${q.operationName}] no set-cookie header. status=${res.status} body="${snippet}"`);
          continue;
        }
        const parts = (Array.isArray(raw) ? raw : [raw]).map(c => c.split(';')[0].trim());
        const get = (name) => parts.find(c => c.startsWith(name + '=')) || null;
        const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
        if (!tier || !session || !sub) {
          console.log(`  [session attempt ${attempt}, ${q.operationName}] set-cookie present but missing tier/session/sub. raw="${JSON.stringify(raw).slice(0, 200)}"`);
          continue;
        }
        profileCookie  = `${tier}; ${session}; ${sub}`;
        profilePromise = null;
        console.log(`  Profile session refreshed (attempt ${attempt})`);
        return;
      }
    }
    profilePromise = null;
    throw new Error('Failed to obtain profile session after 10 attempts');
  })();
  return profilePromise;
}

const PROFILE_QUERY = {
  operationName: 'ProfileSeasonStatistics',
  query: `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      name
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
}`,
};

function statValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const match = statistics.find(s => s?.details?.value === typeValue);
  return match ? (match.count || 0) : 0;
}

// Identical shape/logic to fetch-profile-stats.js's parseProfileStats.
function parseProfileStats(data) {
  const seasonStats = data?.publicProfileStatistics?.seasonStatistics;
  if (!seasonStats) return null;
  const playerName = seasonStats[0]?.name || null;
  const seenGameKeys = new Set();
  const foulOuts = {};
  let maxGamePTS = null, maxGameThreePt = null, maxGamePTSKey = null, maxGameThreePtKey = null;
  const regStats = new Map();
  const gameTids = {};
  const sidTids  = {};

  for (const season of seasonStats) {
    for (const reg of (season.statistics || [])) {
      const seasonId = reg?.season?.id;
      if (!seasonId) continue;
      for (const teamStat of (reg.teamStatistics || [])) {
        const tid = teamStat.team?.id || null;
        if (tid && seasonId) { if (!sidTids[seasonId]) sidTids[seasonId] = new Set(); sidTids[seasonId].add(tid); }
        for (const gradeStat of (teamStat.gradeStatistics || [])) {
          const regKey = `${seasonId}:${tid}`;
          for (const gameStat of (gradeStat.gameStatistics || [])) {
            const stats   = gameStat.statistics || [];
            const gameKey = gameStat.game?.id || null;
            if (gameKey && forfeitGameIds.has(gameKey)) continue;
            if (gameKey && tid) gameTids[gameKey] = tid;
            if (gameKey && seenGameKeys.has(gameKey)) continue;
            if (gameKey) seenGameKeys.add(gameKey);
            const fouls  = statValue(stats, 'TOTAL_FOULS');
            const pts    = statValue(stats, 'TOTAL_SCORE');
            const three  = statValue(stats, '3_POINT_SCORE');
            const fg     = statValue(stats, '2_POINT_SCORE');
            const ft     = statValue(stats, '1_POINT_SCORE');
            const gp_val = statValue(stats, 'APPEARANCE') || 1;
            if (fouls >= 5) foulOuts[seasonId] = (foulOuts[seasonId] || 0) + 1;
            if (pts > (maxGamePTS ?? 0)) { maxGamePTS = pts; maxGamePTSKey = gameKey ? { gameKey, sid: seasonId } : null; }
            if (three > (maxGameThreePt ?? 0)) { maxGameThreePt = three; maxGameThreePtKey = gameKey ? { gameKey, sid: seasonId } : null; }
            if (!regStats.has(regKey)) regStats.set(regKey, { gp: 0, pts: 0, fg: 0, ft: 0, threePt: 0, fouls: 0 });
            const rs = regStats.get(regKey);
            rs.gp += gp_val; rs.pts += pts; rs.fg += fg; rs.ft += ft; rs.threePt += three; rs.fouls += fouls;
          }
        }
      }
    }
  }
  const hasAmbiguousSeason = Object.values(sidTids).some(s => s.size > 1);
  return { playerName, foulOuts, maxGamePTS, maxGamePTSKey, maxGameThreePt, maxGameThreePtKey, regStats, gameTids: hasAmbiguousSeason ? gameTids : null };
}

async function fetchProfile(profileID) {
  if (!profileCookie) await refreshProfileSession();
  const body = { ...PROFILE_QUERY, variables: { profileID } };
  let res;
  try {
    res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': profileCookie }, body: JSON.stringify(body) });
  } catch (err) { return { status: 'error', err }; }

  if (res.status === 403) {
    let body403 = '';
    try { body403 = await res.text(); } catch (_) {}
    if (body403.includes('DOCTYPE') || body403.includes('Request blocked')) {
      console.log(`  ⛔ CloudFront block (uuid=${profileID})`);
      return { status: 'cloudfront-block' };
    }
    return { status: 'private' };
  }
  if (res.status === 504) {
    await sleep(15000);
    try { res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': profileCookie }, body: JSON.stringify(body) }); }
    catch (err) { return { status: 'error', err }; }
  }
  if (!res.ok) return { status: 'error', err: new Error(`HTTP ${res.status}`) };
  let json;
  try { json = await res.json(); } catch (err) { return { status: 'error', err }; }
  if (json.errors && json.errors.length > 0) {
    const msg = json.errors[0]?.message || '';
    if (msg.includes('NOT_FOUND') || msg.includes('failed to find profile')) return { status: 'private' };
    return { status: 'error', err: new Error(`GraphQL error: ${msg}`) };
  }
  const data = json.data || json;
  if (!data?.publicProfileStatistics) return { status: 'inaccessible' };
  return { status: 'ok', data };
}

// ─── Spectator-API session (box scores, privacy-blind) ─────────────────────
// Copied verbatim from nightly-crawl.js -- simpler single-query refresh,
// shared cookie style works fine for this endpoint per that script's
// production track record.
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const HEADERS_SPECTATOR = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'bv', 'x-phq-tenant': 'bv', 'content-type': 'application/json',
};
let spectatorCookie = null;

async function refreshSpectatorSession() {
  const body = { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const res = await doFetch(API_URL, { headers: { ...HEADERS_SPECTATOR, tenant: 'basketball-victoria', 'request-id': crypto.randomUUID() }, body: JSON.stringify(body) });
      const raw = res.rawCookies;
      if (!raw) continue;
      const arr = (Array.isArray(raw) ? raw : [raw]).map(c => c.split(';')[0].trim());
      const get = n => arr.find(p => p.startsWith(n + '=')) || null;
      const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
      if (tier && session && sub) { spectatorCookie = `${tier}; ${session}; ${sub}`; return; }
    } catch (_) {}
  }
  throw new Error('Failed to obtain spectator session after 10 attempts');
}

function spectatorStatValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const s = statistics.find(x => x.type?.value === typeValue);
  return s ? (s.count || 0) : 0;
}

function parseSpectatorPlayers(players) {
  if (!Array.isArray(players)) return [];
  return players.filter(p => p && p.profileID).map(p => ({
    profileID: p.profileID,
    pts:   spectatorStatValue(p.statistics, 'TOTAL_SCORE'),
    pt1:   spectatorStatValue(p.statistics, '1_POINT_SCORE'),
    pt2:   spectatorStatValue(p.statistics, '2_POINT_SCORE'),
    pt3:   spectatorStatValue(p.statistics, '3_POINT_SCORE'),
    fouls: spectatorStatValue(p.statistics, 'TOTAL_FOULS'),
  }));
}

async function gqlSpectator(gameId) {
  if (!spectatorCookie) await refreshSpectatorSession();
  const query = `query game($id: ID!) {
    game(id: $id) {
      id status
      statistics {
        home { players { profileID name playerNumber statistics { type { value } count } } }
        away { players { profileID name playerNumber statistics { type { value } count } } }
      }
    }
  }`;
  try {
    const res = await doFetch(SPECTATOR_URL, { headers: { ...HEADERS_SPECTATOR, 'request-id': crypto.randomUUID(), Cookie: spectatorCookie }, body: JSON.stringify({ operationName: 'game', variables: { id: gameId }, query }) });
    if (res.status === 403) {
      await refreshSpectatorSession();
      const retry = await doFetch(SPECTATOR_URL, { headers: { ...HEADERS_SPECTATOR, 'request-id': crypto.randomUUID(), Cookie: spectatorCookie }, body: JSON.stringify({ operationName: 'game', variables: { id: gameId }, query }) });
      const rj = await retry.json().catch(() => null);
      if (retry.status !== 200 || !rj || rj.errors) return null;
      return rj.data?.game || null;
    }
    if (res.status !== 200) return null;
    const j = await res.json().catch(() => null);
    if (!j || j.errors) return null;
    return j.data?.game || null;
  } catch (_) { return null; }
}

// ─── Player file / index helpers ────────────────────────────────────────────

function playerShard(uuid)    { return uuid.slice(0, 2).toLowerCase(); }
function playerFilePath(uuid) { return path.join(PLAYERS_DIR, playerShard(uuid), `${uuid}.json`); }
function playerIndexPath(s)   { return path.join(INDEX_DIR, `${s}.json`); }

function writePlayer(uuid, data) {
  if (DRY_RUN) return;
  const file = playerFilePath(uuid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

const indexCache = new Map(); // shard -> index object (mutated in place, written on flush)
function readPlayerIndex(shard) {
  if (indexCache.has(shard)) return indexCache.get(shard);
  const file = playerIndexPath(shard);
  let data = {};
  if (fs.existsSync(file)) { try { data = readJson(file); } catch (_) { data = {}; } }
  indexCache.set(shard, data);
  return data;
}
function writePlayerIndex(shard) {
  if (DRY_RUN) return;
  const file = playerIndexPath(shard);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(indexCache.get(shard) || {}));
}

// ─── Phase 1: discover candidates from games/bv/*.json ─────────────────────
// A candidate uuid is: full-length (36 chars), appears in some game's p[]/
// hp[]/ap[] attendee list, and is NOT a key in its shard's index yet.
console.log('backfill-missing-players.js');
if (DRY_RUN) console.log('  ⚠  DRY RUN — no writes or commits');
console.log('─'.repeat(60));
console.log('Phase 1 — scanning games/bv/*.json for un-indexed full-length uuids…');

// Indexes are loaded lazily (per shard, on first touch) via readPlayerIndex —
// small (name+history only per shard), so touching all 256 as candidates are
// discovered is cheap and avoids paying for shards with zero candidates.
function isAlreadyKnown(uuid) {
  const shard = playerShard(uuid);
  const idx = readPlayerIndex(shard);
  return !!idx[uuid];
}

const sids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
const candidates = new Map(); // uuid -> [{ gid, sid, gradeId, gradeName, h, hn, a, an, forfeit }]
let seasonsScanned = 0, gamesScanned = 0, appearancesScanned = 0;

for (const fname of sids) {
  let gf;
  try { gf = readJson(path.join(GAMES_DIR, fname)); } catch { continue; }
  const sid = fname.replace('.json', '');
  seasonsScanned++;
  for (const [gid, g] of Object.entries(gf.games || {})) {
    gamesScanned++;
    const ids = new Set();
    for (const e of (g.p  || [])) { if (e?.id)        ids.add(e.id); }
    for (const e of (g.hp || [])) { if (e?.profileID) ids.add(e.profileID); }
    for (const e of (g.ap || [])) { if (e?.profileID) ids.add(e.profileID); }
    for (const uuid of ids) {
      if (!isFullUuid(uuid)) continue; // normal, already-resolvable truncated id — not our concern
      appearancesScanned++;
      if (isAlreadyKnown(uuid)) continue; // has a player record already — not a candidate
      if (!candidates.has(uuid)) candidates.set(uuid, []);
      candidates.get(uuid).push({
        gid, sid,
        gradeId: g.gid || null, gradeName: g.gn || null,
        h: g.h || null, hn: g.hn || null, a: g.a || null, an: g.an || null,
        forfeit: !!g.forfeit,
      });
    }
  }
}

console.log(`  ${seasonsScanned} season files | ${gamesScanned.toLocaleString()} games | ${appearancesScanned.toLocaleString()} full-uuid appearances scanned`);
console.log(`  Candidates found (no index entry yet): ${candidates.size.toLocaleString()}`);

const allCandidateUuids = [...candidates.keys()].sort();
const toProcess = allCandidateUuids.slice(0, MAX);
console.log(`  Processing this run: ${toProcess.length.toLocaleString()}${MAX < Infinity ? ` (--max=${MAX})` : ''}`);

if (toProcess.length === 0) {
  console.log('  Nothing to do.');
  process.exit(0);
}

// ─── Build a public player record from a successful profile fetch ──────────
function buildPublicPlayer(uuid, apiData, appearanceGids) {
  const parsed = parseProfileStats(apiData);
  if (!parsed) return null;

  const player = { uuid, private: false };
  player.name = parsed.playerName || `Player #${uuid.slice(0, TRUNC_LEN)}`;
  player.sports = { Basketball: {} };
  const bk = player.sports.Basketball;
  bk.foulOuts = parsed.foulOuts;
  bk.maxGamePTS = parsed.maxGamePTS;
  bk.maxGameThreePt = parsed.maxGameThreePt;

  player.seasons = [];
  for (const season of (apiData.publicProfileStatistics?.seasonStatistics || [])) {
    for (const reg of (season.statistics || [])) {
      const sid = reg?.season?.id;
      if (!sid) continue;
      for (const teamStat of (reg.teamStatistics || [])) {
        const tid = teamStat.team?.id;
        if (!tid) continue;
        let s = player.seasons.find(x => x.sid === sid);
        if (!s) { s = { sid, regs: [] }; player.seasons.push(s); }
        if (!s.regs.find(r => r.tid === tid)) s.regs.push({ tid });
      }
    }
  }

  const REG_STAT_FIELDS = ['gp', 'pts', 'fg', 'ft', 'threePt', 'fouls'];
  for (const season of player.seasons) {
    for (const reg of season.regs) {
      const rs = parsed.regStats.get(`${season.sid}:${reg.tid}`);
      reg.stats = {};
      for (const field of REG_STAT_FIELDS) {
        const val = rs ? (rs[field] || 0) : 0;
        if (val !== 0) reg.stats[field] = val;
      }
    }
  }

  const career = { gp: 0, pts: 0, fg: 0, ft: 0, threePt: 0, fouls: 0 };
  for (const [, rs] of parsed.regStats) {
    career.gp += rs.gp; career.pts += rs.pts; career.fg += rs.fg;
    career.ft += rs.ft; career.threePt += rs.threePt; career.fouls += rs.fouls;
  }
  for (const field of REG_STAT_FIELDS) if (career[field] !== 0) bk[field] = career[field];

  if (parsed.gameTids && Object.keys(parsed.gameTids).length > 0) player.gameTids = parsed.gameTids;

  if (!player.records) player.records = {};
  player.records.maxGamePTS = parsed.maxGamePTSKey ? { v: parsed.maxGamePTS, ...parsed.maxGamePTSKey } : { v: parsed.maxGamePTS ?? null };
  player.records.maxGameThreePt = parsed.maxGameThreePtKey ? { v: parsed.maxGameThreePt, ...parsed.maxGameThreePtKey } : { v: parsed.maxGameThreePt ?? null };
  bk.statsChecked = new Date().toISOString();

  player.teams = [];
  player.games = appearanceGids;
  player.updatedAt = new Date().toISOString();
  return player;
}

// ─── Build a private player stub from re-fetched spectator box scores ──────
// appearances: [{ gid, sid, gradeId, gradeName, h, hn, a, an, forfeit }]
// spectatorPool: shared { run(fn) } — see runSpectatorPool below.
async function buildPrivatePlayer(uuid, appearances, spectatorPool, spectatorStats) {
  const bk = { maxGamePTS: null, maxGameThreePt: null, foulOuts: {} };
  let maxGamePTSKey = null, maxGameThreePtKey = null;
  const seasonsMap = new Map(); // sid -> { sid, sn, club, regs: Map<tid, reg> }
  const seenGameKeys = new Set();

  const live = appearances.filter(a => !a.forfeit);
  await Promise.all(live.map(appearance => spectatorPool.run(async () => {
    if (seenGameKeys.has(appearance.gid)) return;
    const game = await gqlSpectator(appearance.gid);
    if (!game?.statistics) { spectatorStats.misses++; return; }
    const homePlayers = parseSpectatorPlayers(game.statistics?.home?.players);
    const awayPlayers = parseSpectatorPlayers(game.statistics?.away?.players);
    const mine = homePlayers.find(p => p.profileID === uuid) || awayPlayers.find(p => p.profileID === uuid);
    if (!mine) { spectatorStats.misses++; return; }
    if (seenGameKeys.has(appearance.gid)) return; // re-check post-await
    seenGameKeys.add(appearance.gid);
    spectatorStats.hits++;

    const isHome = homePlayers.some(p => p.profileID === uuid);
    const tid = isHome ? appearance.h  : appearance.a;
    const tn  = isHome ? appearance.hn : appearance.an;

    if (mine.fouls >= 5) bk.foulOuts[appearance.sid] = (bk.foulOuts[appearance.sid] || 0) + 1;
    if (mine.pts > (bk.maxGamePTS ?? 0)) { bk.maxGamePTS = mine.pts; maxGamePTSKey = { gameKey: appearance.gid, sid: appearance.sid }; }
    if (mine.pt3 > (bk.maxGameThreePt ?? 0)) { bk.maxGameThreePt = mine.pt3; maxGameThreePtKey = { gameKey: appearance.gid, sid: appearance.sid }; }

    if (!seasonsMap.has(appearance.sid)) {
      const si = sportIndex.seasons?.[appearance.sid];
      seasonsMap.set(appearance.sid, { sid: appearance.sid, sn: si?.name || appearance.sid, club: si?.orgName || '', regs: new Map() });
    }
    const season = seasonsMap.get(appearance.sid);
    if (tid) {
      if (!season.regs.has(tid)) {
        season.regs.set(tid, { tid, tn: tn || '', gid: appearance.gradeId, gn: appearance.gradeName || '', div: null, stats: { gp: 0, pts: 0, fg: 0, ft: 0, threePt: 0, fouls: 0 } });
      }
      const rs = season.regs.get(tid).stats;
      rs.gp += 1; rs.pts += mine.pts; rs.fg += mine.pt2; rs.ft += mine.pt1; rs.threePt += mine.pt3; rs.fouls += mine.fouls;
    }
  })));

  const career = { gp: 0, pts: 0, fg: 0, ft: 0, threePt: 0, fouls: 0 };
  const seasons = [...seasonsMap.values()].map(s => {
    const regs = [...s.regs.values()].map(r => {
      const stats = {};
      for (const [k, v] of Object.entries(r.stats)) { if (v !== 0) stats[k] = v; career[k] += v; }
      return { ...r, stats };
    });
    return { ...s, regs };
  });
  for (const field of Object.keys(career)) if (career[field] !== 0) bk[field] = career[field];

  bk.statsChecked = new Date().toISOString(); // confirmed-private — the regular matrix will not retry this uuid

  return {
    uuid,
    name: `Player #${uuid.slice(0, TRUNC_LEN)}`,
    private: true,
    sports: { Basketball: bk },
    seasons,
    teams: [],
    records: {
      maxGamePTS:     maxGamePTSKey     ? { v: bk.maxGamePTS,     ...maxGamePTSKey }     : { v: bk.maxGamePTS ?? null },
      maxGameThreePt: maxGameThreePtKey ? { v: bk.maxGameThreePt, ...maxGameThreePtKey } : { v: bk.maxGameThreePt ?? null },
    },
    games: appearances.map(a => a.gid).sort(),
    updatedAt: new Date().toISOString(),
  };
}

// Shared spectator-request pool — global concurrency 3 across ALL private
// candidates in a batch, matching nightly-crawl.js's CONCURRENCY_SPECTATOR.
// Nesting a per-player pool inside a 30-wide profile batch would otherwise
// multiply out to far more concurrent spectator connections than that host
// has ever been proven safe against.
function makePool(concurrency) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  }
  return {
    run(fn) {
      return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
    },
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log('\nPhase 2 — resolving each candidate (public via profile API, private via spectator re-fetch)…');
  await refreshProfileSession();

  const summary = {
    candidatesFound: candidates.size,
    processed: 0, public: 0, private: 0, errors: 0, skippedCloudfront: 0,
    spectatorHits: 0, spectatorMisses: 0, cloudfrontBlocked: false,
  };

  const shardsTouched = new Set();
  let sinceCommit = 0;
  let blocked = false;

  for (let batchStart = 0; batchStart < toProcess.length && !blocked; batchStart += PROFILE_BATCH) {
    const batch = toProcess.slice(batchStart, batchStart + PROFILE_BATCH);
    if (batchStart > 0) await refreshProfileSession(); // reset JWT quota each batch, same as fetch-profile-stats.js

    const profileResults = await Promise.allSettled(batch.map(uuid => fetchProfile(uuid)));

    const blockIdx = profileResults.findIndex(r => r.status === 'fulfilled' && r.value?.status === 'cloudfront-block');
    if (blockIdx !== -1) {
      console.log(`  ⛔ CloudFront block at batch offset ${batchStart + blockIdx}. Stopping — re-run to continue.`);
      summary.cloudfrontBlocked = true;
      blocked = true;
      break;
    }

    const spectatorPool = makePool(SPECTATOR_CONCURRENCY);
    const spectatorStats = { hits: 0, misses: 0 };

    const built = await Promise.all(batch.map(async (uuid, i) => {
      const result = profileResults[i].status === 'fulfilled' ? profileResults[i].value : { status: 'error', err: profileResults[i].reason };
      const appearances = candidates.get(uuid) || [];
      const appearanceGids = [...new Set(appearances.map(a => a.gid))].sort();

      if (result.status === 'ok') {
        const player = buildPublicPlayer(uuid, result.data, appearanceGids);
        if (player) return { uuid, player, kind: 'public' };
        // parseProfileStats returned null despite an "ok" fetch — treat like private fallback
      }
      if (result.status === 'private' || result.status === 'inaccessible' || (result.status === 'ok')) {
        const player = await buildPrivatePlayer(uuid, appearances, spectatorPool, spectatorStats);
        return { uuid, player, kind: 'private' };
      }
      return { uuid, player: null, kind: 'error', err: result.err };
    }));

    summary.spectatorHits   += spectatorStats.hits;
    summary.spectatorMisses += spectatorStats.misses;

    for (const { uuid, player, kind } of built) {
      summary.processed++;
      if (kind === 'error' || !player) { summary.errors++; continue; }

      const shard = playerShard(uuid);
      writePlayer(uuid, player);
      const index = readPlayerIndex(shard);
      const history = {};
      for (const season of (player.seasons || [])) {
        history[season.sid] = (season.regs || []).map(r => r.tid);
      }
      index[uuid] = { name: player.name, history };
      shardsTouched.add(shard);

      if (kind === 'public') summary.public++; else summary.private++;
    }

    sinceCommit += batch.length;
    console.log(`  ${Math.min(batchStart + PROFILE_BATCH, toProcess.length)}/${toProcess.length} — public=${summary.public} private=${summary.private} errors=${summary.errors} spectator(hit/miss)=${summary.spectatorHits}/${summary.spectatorMisses}`);

    if (sinceCommit >= COMMIT_EVERY) {
      for (const shard of shardsTouched) writePlayerIndex(shard);
      await gitCommit(
        `backfill-missing-players: ${summary.processed}/${toProcess.length} processed — ${summary.public} public, ${summary.private} private`,
        ['players/']
      );
      shardsTouched.clear();
      sinceCommit = 0;
    }
  }

  if (shardsTouched.size > 0) {
    for (const shard of shardsTouched) writePlayerIndex(shard);
    await gitCommit(`backfill-missing-players: complete — ${summary.public} public, ${summary.private} private, ${summary.errors} errors`, ['players/']);
  }

  summary.elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
  summary.mode = DRY_RUN ? 'DRY RUN' : 'LIVE';
  summary.remainingCandidates = Math.max(0, candidates.size - summary.processed);

  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
    writeJson(REPORT_FILE, summary);
    await gitCommit('backfill-missing-players: report committed', ['reports/']);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`  Candidates found      : ${summary.candidatesFound.toLocaleString()}`);
  console.log(`  Processed this run    : ${summary.processed.toLocaleString()}`);
  console.log(`  Public (real record)  : ${summary.public.toLocaleString()}`);
  console.log(`  Private (stub record) : ${summary.private.toLocaleString()}`);
  console.log(`  Errors (left pending) : ${summary.errors.toLocaleString()}`);
  console.log(`  Spectator hits/misses : ${summary.spectatorHits.toLocaleString()}/${summary.spectatorMisses.toLocaleString()}`);
  console.log(`  Remaining candidates  : ${summary.remainingCandidates.toLocaleString()}${summary.remainingCandidates > 0 ? ' (re-run to continue)' : ''}`);
  console.log(`  CloudFront blocked    : ${summary.cloudfrontBlocked}`);
  console.log(`  Elapsed               : ${summary.elapsedSeconds}s`);
  console.log(`  Mode                  : ${summary.mode}`);
  console.log('─'.repeat(60));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
