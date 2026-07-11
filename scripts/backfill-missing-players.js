// scripts/backfill-missing-players.js
//
// CLEAN REWRITE (2026-07-11). The previous version of this script is retired
// entirely — nothing in this file is copied from it, not transport, not
// session handling, not structure. Every proven piece below is sourced from a
// script that is actually deployed and working, cited at each point:
//   - HTTP transport (doFetch), PROFILE_QUERY, statValue, parseProfileStats
//     -- copied verbatim from fetch-profile-stats.js.
//   - Session refresh (retry-with-backoff, no fail-fast-on-first-403), header
//     sets, gqlSpectator, parseSpectatorPlayers -- copied verbatim from
//     nightly-crawl.js (which shares ONE session cookie across both the main
//     api and spectator hosts -- simpler than maintaining two, and it's what
//     runs successfully every night in production).
//   - gradePlayerStatistics pagination, profileSearch, and the matching
//     functions -- from lib/namespace-resolve.cjs (built and verified live
//     this session: diagnose-namespace-mismatch.js, diagnose-grade-
//     pagination.js, diagnose-uuid-classification.js).
//   - Candidate discovery (games/bv scan for un-indexed full-length uuids)
//     -- same logic validated in diagnose-uuid-population.js /
//     diagnose-uuid-classification.js this session.
//
// What this script does:
//   Phase 1 -- scan games/bv/*.json for full-length uuids in p[]/hp[]/ap[]
//              attendee lists that have no players/indexes/{shard}.json entry.
//   Phase 2 -- for each candidate:
//     (a) try the stored (spectator-namespace) id directly against
//         publicProfileStatistics. If it resolves, write a normal public
//         player record.
//     (b) if not, re-fetch the candidate's spectator box scores to recover
//         the real name and per-appearance team (tid) via home/away
//         cross-reference -- this ALSO reconstructs stats from spectator data
//         for use if step (c) fails.
//     (c) attempt namespace-mismatch recovery: tid-based grade match ->
//         grade-roster name-only match -> profileSearch(+org) fallback. If a
//         recovered id resolves live, write a normal public player record
//         (with apiId stored, so it's never re-recovered).
//     (d) otherwise, write a private stub: real captured name if we have one,
//         stats reconstructed from spectator data, private:true.
//
// Resumable by construction: candidates are recomputed fresh every run by
// scanning games/bv/*.json for full-length uuids missing from every shard
// index -- once a uuid is written (and indexed), it drops out of the
// candidate set on the next run. No separate progress file needed. An
// unresolved candidate is never written anywhere -- it simply remains a
// candidate on the next run, with no risk of polluting good data.
//
// Usage:
//   node scripts/backfill-missing-players.js --dry-run
//   node scripts/backfill-missing-players.js --max=500   (testing)

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const https        = require('https');
const { execSync } = require('child_process');
const { isFullUuid, TRUNC_LEN } = require('./lib/uuid-prefix.cjs');
const {
  GRADE_PLAYERS_QUERY, gradePageFilter, PROFILE_SEARCH_QUERY,
  matchFromGrade, matchFromGradeRosterByName, matchFromSearch, isPlaceholderName,
} = require('./lib/namespace-resolve.cjs');

const ROOT          = path.join(__dirname, '..');
const GAMES_DIR      = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR    = path.join(ROOT, 'players');
const INDEX_DIR      = path.join(ROOT, 'players', 'indexes');
const SPORT_INDEX_FILE = path.join(ROOT, 'data', 'sports-index.json');
const FORFEIT_FILE   = path.join(ROOT, 'data', 'forfeit-games.json');
const REPORT_FILE    = path.join(ROOT, 'reports', 'backfill-missing-players-report.json');

// ─── CLI args ────────────────────────────────────────────────────────────────
const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const DRY_RUN = !!ARGS['dry-run'];
const MAX     = ARGS.max ? parseInt(ARGS.max, 10) : Infinity;
const PROFILE_BATCH        = 30; // matches fetch-profile-stats.js's JWT-quota batch size
const SPECTATOR_CONCURRENCY = 3;  // matches nightly-crawl.js's CONCURRENCY_SPECTATOR
const COMMIT_EVERY          = 150;

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

// ─── HTTP transport — copied verbatim from fetch-profile-stats.js ───────────
// keepAlive:false forces a new TCP connection per request (prevents CloudFront
// per-connection rate limiting).
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

// ─── Headers + session — copied verbatim from nightly-crawl.js ─────────────
// ONE shared session cookie for both hosts (main api + spectator) -- this is
// what nightly-crawl.js does in production every night, successfully. No
// separate "profile session" / "spectator session" split.
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

let sessionCookie = null;
async function refreshSession() {
  const body = { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() }, body: JSON.stringify(body) });
      const raw = res.rawCookies;
      if (!raw) continue;
      const arr = (Array.isArray(raw) ? raw : [raw]).map(c => c.split(';')[0].trim());
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

// gqlSpectator — copied verbatim from nightly-crawl.js (query text + retry-
// once-on-403 logic), adapted only to this file's doFetch return shape
// (fetch-profile-stats.js's Promise-based { status, json(), text() } style,
// since fetchProfile below already uses that shape and one file should not
// carry two different fetch wrapper conventions).
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
      // Single refresh then retry — do not loop (matches nightly-crawl.js).
      await refreshSession();
      res = await doFetch(SPECTATOR_URL, { headers: { ...HEADERS_SPECTATOR, 'request-id': crypto.randomUUID(), Cookie: sessionCookie }, body });
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

// spectatorStatValue / parseSpectatorPlayers — copied verbatim from
// nightly-crawl.js (includes `name` and `number`, unlike an older stripped
// version that discarded them).
function spectatorStatValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const s = statistics.find(x => x.type?.value === typeValue);
  return s ? (s.count || 0) : 0;
}
function parseSpectatorPlayers(players) {
  if (!Array.isArray(players)) return [];
  return players
    .filter(p => p && p.profileID)
    .map(p => ({
      profileID: p.profileID,
      name:      p.name  || null,
      number:    p.playerNumber ?? null,
      pts:       spectatorStatValue(p.statistics, 'TOTAL_SCORE'),
      pt1:       spectatorStatValue(p.statistics, '1_POINT_SCORE'),
      pt2:       spectatorStatValue(p.statistics, '2_POINT_SCORE'),
      pt3:       spectatorStatValue(p.statistics, '3_POINT_SCORE'),
      fouls:     spectatorStatValue(p.statistics, 'TOTAL_FOULS'),
    }));
}

// ─── Profile API — PROFILE_QUERY, statValue, parseProfileStats copied
// verbatim from fetch-profile-stats.js ───────────────────────────────────────
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

// Derive foulOuts, maxGamePTS, maxGameThreePt from per-game stat lines.
// Returns null if publicProfileStatistics is absent (inaccessible profile).
function parseProfileStats(data) {
  const seasonStats = data?.publicProfileStatistics?.seasonStatistics;
  if (!seasonStats) return null;

  const playerName = seasonStats[0]?.name || null;

  const seenGameKeys = new Set();
  const foulOuts     = {};
  let maxGamePTS     = null;
  let maxGameThreePt = null;
  let maxGamePTSKey  = null;
  let maxGameThreePtKey = null;

  const regStats = new Map(); // key `${sid}:${tid}` → { gp, pts, fg, ft, threePt, fouls }
  const gameTids = {};
  const sidTids  = {};

  for (const season of seasonStats) {
    for (const reg of (season.statistics || [])) {
      const seasonId = reg?.season?.id;
      if (!seasonId) continue;

      for (const teamStat of (reg.teamStatistics || [])) {
        const tid = teamStat.team?.id || null;
        if (tid && seasonId) {
          if (!sidTids[seasonId]) sidTids[seasonId] = new Set();
          sidTids[seasonId].add(tid);
        }

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
  if (!sessionCookie) await refreshSession();
  const body = { ...PROFILE_QUERY, variables: { profileID } };
  let res;
  try {
    res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie }, body: JSON.stringify(body) });
  } catch (err) { return { status: 'error', err }; }

  if (res.status === 403) {
    let body403 = ''; try { body403 = await res.text(); } catch (_) {}
    if (body403.includes('DOCTYPE') || body403.includes('Request blocked')) {
      console.log(`  ⛔ CloudFront block (uuid=${profileID})`);
      return { status: 'cloudfront-block' };
    }
    return { status: 'private' };
  }
  if (res.status === 504) {
    await sleep(15000);
    try { res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie }, body: JSON.stringify(body) }); }
    catch (err) { return { status: 'error', err }; }
  }
  if (!res.ok) return { status: 'error', err: new Error(`HTTP ${res.status}`) };
  let json; try { json = await res.json(); } catch (err) { return { status: 'error', err }; }
  if (json.errors && json.errors.length > 0) {
    const msg = json.errors[0]?.message || '';
    if (msg.includes('NOT_FOUND') || msg.includes('failed to find profile')) return { status: 'private' };
    return { status: 'error', err: new Error(`GraphQL error: ${msg}`) };
  }
  const data = json.data || json;
  if (!data?.publicProfileStatistics) return { status: 'inaccessible' };
  return { status: 'ok', data };
}

// ─── Namespace-mismatch recovery — gradePlayerStatistics (paginated) +
// profileSearch. Shared lib queries/matchers (lib/namespace-resolve.cjs),
// same 3-tier logic already validated this session in
// diagnose-uuid-classification.js and shipped in fetch-profile-stats.js. ───
async function gradePlayersPage(gradeID, page) {
  if (!sessionCookie) await refreshSession();
  const body = { operationName: 'publicGradeStatistics', variables: { gradeID, filter: gradePageFilter(page) }, query: GRADE_PLAYERS_QUERY };
  let res;
  try { res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie }, body: JSON.stringify(body) }); }
  catch (_) { return { status: 'error', results: [], meta: null }; }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    return (b.includes('DOCTYPE') || b.includes('Request blocked')) ? { status: 'blocked', results: [], meta: null } : { status: 'error', results: [], meta: null };
  }
  if (!res.ok) return { status: 'error', results: [], meta: null };
  let json; try { json = await res.json(); } catch (_) { return { status: 'error', results: [], meta: null }; }
  if (json.errors && json.errors.length) return { status: 'error', results: [], meta: null };
  const data = (json.data || json)?.gradePlayerStatistics;
  return { status: 'ok', results: data?.results || [], meta: data?.meta || null };
}

const gradeCache = new Map();
async function gradePlayers(gradeID) {
  if (gradeCache.has(gradeID)) return gradeCache.get(gradeID);
  const p1 = await gradePlayersPage(gradeID, 1);
  if (p1.status !== 'ok') return p1;
  let all = p1.results;
  const totalPages = p1.meta?.totalPages || 1;
  for (let page = 2; page <= totalPages; page++) {
    const p = await gradePlayersPage(gradeID, page);
    if (p.status !== 'ok') return p;
    all = all.concat(p.results);
  }
  const out = { status: 'ok', results: all };
  gradeCache.set(gradeID, out);
  return out;
}

async function profileSearchLookup(fullName) {
  if (!sessionCookie) await refreshSession();
  const body = { operationName: 'ProfileSearch', variables: { fullName }, query: PROFILE_SEARCH_QUERY };
  let res;
  try { res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie }, body: JSON.stringify(body) }); }
  catch (_) { return { status: 'error', result: [] }; }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    return (b.includes('DOCTYPE') || b.includes('Request blocked')) ? { status: 'blocked', result: [] } : { status: 'error', result: [] };
  }
  if (!res.ok) return { status: 'error', result: [] };
  let json; try { json = await res.json(); } catch (_) { return { status: 'error', result: [] }; }
  if (json.errors && json.errors.length) return { status: 'error', result: [] };
  return { status: 'ok', result: (json.data || json)?.profileSearch?.result || [] };
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

const indexCache = new Map();
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
function isAlreadyKnown(uuid) { return !!readPlayerIndex(playerShard(uuid))[uuid]; }

// ─── git commit — standard project pattern (explicit paths, merge -X ours) ──
async function gitCommit(message, dirs) {
  if (DRY_RUN) return;
  try {
    execSync(`git add ${dirs.map(d => `"${d}"`).join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    const staged = execSync('git diff --staged --shortstat', { cwd: ROOT }).toString().trim();
    if (!staged) return;
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git fetch origin main', { cwd: ROOT, stdio: 'pipe' });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push origin main', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  Committed: ${message}`);
  } catch (err) {
    console.error(`  ⚠ git commit failed: ${err.message}`);
    throw err;
  }
}

// ─── Phase 1: discover candidates from games/bv/*.json ─────────────────────
// A candidate uuid is: full-length, appears in some game's p[]/hp[]/ap[]
// attendee list, and is NOT a key in its shard's index yet.
console.log('backfill-missing-players.js (clean rewrite, 2026-07-11)');
if (DRY_RUN) console.log('  ⚠  DRY RUN — no writes or commits');
console.log('─'.repeat(60));
console.log('Phase 1 — scanning games/bv/*.json for un-indexed full-length uuids…');

const sids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
const candidates = new Map(); // uuid -> [{ gid(gameId), sid, gradeId, gradeName, h, hn, a, an, forfeit }]
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
      if (!isFullUuid(uuid)) continue;
      appearancesScanned++;
      if (isAlreadyKnown(uuid)) continue;
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

// ─── Phase 2 helpers: build public/private player records ─────────────────
const REG_STAT_FIELDS = ['gp', 'pts', 'fg', 'ft', 'threePt', 'fouls'];

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
    for (const field of REG_STAT_FIELDS) career[field] += rs[field];
  }
  for (const field of REG_STAT_FIELDS) if (career[field] !== 0) bk[field] = career[field];

  if (parsed.gameTids && Object.keys(parsed.gameTids).length > 0) player.gameTids = parsed.gameTids;

  player.records = {
    maxGamePTS: parsed.maxGamePTSKey ? { v: parsed.maxGamePTS, ...parsed.maxGamePTSKey } : { v: parsed.maxGamePTS ?? null },
    maxGameThreePt: parsed.maxGameThreePtKey ? { v: parsed.maxGameThreePt, ...parsed.maxGameThreePtKey } : { v: parsed.maxGameThreePt ?? null },
  };
  bk.statsChecked = new Date().toISOString();

  player.teams = [];
  player.games = appearanceGids;
  player.updatedAt = new Date().toISOString();
  return player;
}

// Re-fetches spectator box scores for every non-forfeit appearance to recover
// the real name and per-appearance tid (via home/away cross-reference), and
// to reconstruct stats for use if namespace recovery below finds nothing.
async function reconstructFromSpectator(uuid, appearances, spectatorPool, spectatorStats) {
  const bk = { maxGamePTS: null, maxGameThreePt: null, foulOuts: {} };
  let maxGamePTSKey = null, maxGameThreePtKey = null;
  const seasonsMap = new Map(); // sid -> { sid, sn, club, regs: Map<tid, reg> }
  const seenGameKeys = new Set();
  let capturedName = null;

  const live = appearances.filter(a => !a.forfeit);
  await Promise.all(live.map(appearance => spectatorPool.run(async () => {
    if (seenGameKeys.has(appearance.gid)) return;
    const game = await gqlSpectator(appearance.gid);
    if (!game?.statistics) { spectatorStats.misses++; return; }
    const homePlayers = parseSpectatorPlayers(game.statistics?.home?.players);
    const awayPlayers = parseSpectatorPlayers(game.statistics?.away?.players);
    const mine = homePlayers.find(p => p.profileID === uuid) || awayPlayers.find(p => p.profileID === uuid);
    if (!mine) { spectatorStats.misses++; return; }
    if (seenGameKeys.has(appearance.gid)) return;
    seenGameKeys.add(appearance.gid);
    spectatorStats.hits++;
    if (!capturedName && mine.name) capturedName = mine.name;

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

  return { name: capturedName, seasons, bk, maxGamePTSKey, maxGameThreePtKey };
}

// Namespace-mismatch recovery: tid-based grade match -> grade-roster
// name-only match -> profileSearch(+org) fallback. Returns { blocked } |
// { apiId, checkResult } | null.
async function attemptRecovery(uuid, name, seasons) {
  if (isPlaceholderName(name)) return null;

  let orgId = null;
  const regPairs = [];
  const allGids = new Set();
  for (const s of seasons) {
    if (!orgId) orgId = sportIndex.seasons?.[s.sid]?.orgId || null;
    for (const r of s.regs) {
      if (r.gid) allGids.add(r.gid);
      if (r.tid && r.gid) regPairs.push({ tid: r.tid, gid: r.gid });
    }
  }

  // Tier 1: tid-based match.
  const tidHits = new Set();
  for (const gid of new Set(regPairs.map(r => r.gid))) {
    const g = await gradePlayers(gid);
    if (g.status === 'blocked') return { blocked: true };
    for (const r of regPairs.filter(r => r.gid === gid)) {
      const m = matchFromGrade(g.results, { name, tid: r.tid });
      if (m) tidHits.add(m);
    }
  }
  let candidate = tidHits.size === 1 ? [...tidHits][0] : null;

  // Tier 2: grade-roster name-only match.
  if (!candidate) {
    const rosterHits = new Set();
    for (const gid of allGids) {
      const g = await gradePlayers(gid);
      if (g.status === 'blocked') return { blocked: true };
      const m = matchFromGradeRosterByName(g.results, { name });
      if (m) rosterHits.add(m);
    }
    candidate = rosterHits.size === 1 ? [...rosterHits][0] : null;
  }

  // Tier 3: profileSearch (+ orgId) fallback.
  if (!candidate) {
    const sr = await profileSearchLookup(name);
    if (sr.status === 'blocked') return { blocked: true };
    candidate = matchFromSearch(sr.result, { name, orgId: null })
             || (orgId ? matchFromSearch(sr.result, { name, orgId }) : null);
  }
  if (!candidate || candidate === uuid) return null;

  const check = await fetchProfile(candidate);
  if (check.status === 'cloudfront-block') return { blocked: true };
  if (check.status !== 'ok') return null;
  return { apiId: candidate, checkResult: check };
}

function buildPrivateStub(uuid, recon, appearances) {
  const bk = recon.bk;
  bk.statsChecked = new Date().toISOString();
  return {
    uuid,
    name: recon.name || `Player #${uuid.slice(0, TRUNC_LEN)}`,
    private: true,
    sports: { Basketball: bk },
    seasons: recon.seasons,
    teams: [],
    records: {
      maxGamePTS:     recon.maxGamePTSKey     ? { v: bk.maxGamePTS,     ...recon.maxGamePTSKey }     : { v: bk.maxGamePTS ?? null },
      maxGameThreePt: recon.maxGameThreePtKey ? { v: bk.maxGameThreePt, ...recon.maxGameThreePtKey } : { v: bk.maxGameThreePt ?? null },
    },
    games: appearances.map(a => a.gid).sort(),
    updatedAt: new Date().toISOString(),
  };
}

// Shared spectator-request pool — global concurrency 3, matching
// nightly-crawl.js's CONCURRENCY_SPECTATOR.
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

async function resolveCandidate(uuid, appearances, spectatorPool, spectatorStats) {
  const appearanceGids = [...new Set(appearances.map(a => a.gid))].sort();

  const direct = await fetchProfile(uuid);
  if (direct.status === 'cloudfront-block') return { kind: 'blocked' };
  if (direct.status === 'ok') {
    const player = buildPublicPlayer(uuid, direct.data, appearanceGids);
    if (player) return { kind: 'public', player };
    // parseProfileStats returned null despite "ok" -- fall through to reconstruction.
  }

  const recon = await reconstructFromSpectator(uuid, appearances, spectatorPool, spectatorStats);

  const recovery = await attemptRecovery(uuid, recon.name, recon.seasons);
  if (recovery?.blocked) return { kind: 'blocked' };
  if (recovery) {
    const player = buildPublicPlayer(uuid, recovery.checkResult.data, appearanceGids);
    if (player) {
      player.apiId = recovery.apiId; // so a future re-check never has to recover it again
      return { kind: 'public', player };
    }
  }

  return { kind: 'private', player: buildPrivateStub(uuid, recon, appearances) };
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  const summary = {
    candidatesFound: candidates.size,
    processed: 0, committed: 0, public: 0, private: 0, errors: 0,
    recoveredViaNamespace: 0,
    spectatorHits: 0, spectatorMisses: 0, cloudfrontBlocked: false,
  };

  console.log('\nPhase 2 — resolving each candidate (public via profile API + namespace recovery, private via spectator reconstruction)…');

  try {
    await refreshSession();
    console.log('  ✓ Session acquired');
  } catch (err) {
    console.error(`\nFATAL — could not acquire session: ${err.message}`);
    throw err;
  }

  const shardsTouched = new Set();
  let sinceCommit = 0;
  let blocked = false;

  for (let batchStart = 0; batchStart < toProcess.length && !blocked; batchStart += PROFILE_BATCH) {
    if (batchStart > 0) await refreshSession(); // reset JWT quota each batch, matching fetch-profile-stats.js

    const batch = toProcess.slice(batchStart, batchStart + PROFILE_BATCH);
    const spectatorPool = makePool(SPECTATOR_CONCURRENCY);
    const spectatorStats = { hits: 0, misses: 0 };

    const results = await Promise.allSettled(
      batch.map(uuid => resolveCandidate(uuid, candidates.get(uuid) || [], spectatorPool, spectatorStats))
    );

    summary.spectatorHits   += spectatorStats.hits;
    summary.spectatorMisses += spectatorStats.misses;

    const built = results.map((r, i) => r.status === 'fulfilled' ? { uuid: batch[i], ...r.value } : { uuid: batch[i], kind: 'error', err: r.reason });

    const blockIdx = built.findIndex(b => b.kind === 'blocked');
    if (blockIdx !== -1) {
      console.log(`  ⛔ CloudFront block at batch offset ${batchStart + blockIdx}. Committing what succeeded this batch, then stopping — re-run to continue.`);
      summary.cloudfrontBlocked = true;
      blocked = true;
    }

    for (const { uuid, player, kind } of built) {
      if (kind === 'blocked') continue; // stays a candidate for next run
      summary.processed++;
      if (kind === 'error' || !player) { summary.errors++; continue; }

      const shard = playerShard(uuid);
      writePlayer(uuid, player);
      const index = readPlayerIndex(shard);
      const history = {};
      for (const season of (player.seasons || [])) {
        history[season.sid] = [...new Set((season.regs || []).map(r => r.tid))];
      }
      index[uuid] = { name: player.name, history };
      shardsTouched.add(shard);

      if (kind === 'public') {
        summary.public++;
        if (player.apiId) summary.recoveredViaNamespace++;
      } else {
        summary.private++;
      }
    }

    sinceCommit += batch.length;
    console.log(`  ${Math.min(batchStart + PROFILE_BATCH, toProcess.length)}/${toProcess.length} — public=${summary.public} (recovered=${summary.recoveredViaNamespace}) private=${summary.private} errors=${summary.errors} spectator(hit/miss)=${summary.spectatorHits}/${summary.spectatorMisses}`);

    if (sinceCommit >= COMMIT_EVERY || blocked) {
      for (const shard of shardsTouched) writePlayerIndex(shard);
      await gitCommit(
        `backfill-missing-players: ${summary.processed}/${toProcess.length} processed — ${summary.public} public (${summary.recoveredViaNamespace} recovered), ${summary.private} private`,
        ['players/']
      );
      summary.committed = summary.processed;
      shardsTouched.clear();
      sinceCommit = 0;
    }
  }

  if (shardsTouched.size > 0) {
    for (const shard of shardsTouched) writePlayerIndex(shard);
    await gitCommit(`backfill-missing-players: complete — ${summary.public} public (${summary.recoveredViaNamespace} recovered), ${summary.private} private, ${summary.errors} errors`, ['players/']);
    summary.committed = summary.processed;
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
  console.log(`  Candidates found       : ${summary.candidatesFound.toLocaleString()}`);
  console.log(`  Processed this run     : ${summary.processed.toLocaleString()}`);
  console.log(`  Public (real record)   : ${summary.public.toLocaleString()}`);
  console.log(`    ├─ recovered via namespace fix : ${summary.recoveredViaNamespace.toLocaleString()}`);
  console.log(`  Private (stub record)  : ${summary.private.toLocaleString()}`);
  console.log(`  Errors (left pending)  : ${summary.errors.toLocaleString()}`);
  console.log(`  Spectator hits/misses  : ${summary.spectatorHits.toLocaleString()}/${summary.spectatorMisses.toLocaleString()}`);
  console.log(`  Remaining candidates   : ${summary.remainingCandidates.toLocaleString()}${summary.remainingCandidates > 0 ? ' (re-run to continue)' : ''}`);
  console.log(`  CloudFront blocked     : ${summary.cloudfrontBlocked}`);
  console.log(`  Elapsed                : ${summary.elapsedSeconds}s`);
  console.log(`  Mode                   : ${summary.mode}`);
  console.log('─'.repeat(60));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
