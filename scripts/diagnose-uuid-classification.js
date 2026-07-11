// scripts/diagnose-uuid-classification.js
//
// READ-ONLY. Samples the un-indexed full-length-uuid pool found by
// diagnose-uuid-population.js (games/bv attendee lists minus players/indexes/*)
// and classifies each into:
//
//   already-public        publicProfileStatistics(storedUuid) -> ok. Backfill
//                          would just work on these; not a namespace problem.
//   diverged-recoverable  storedUuid -> not-found, BUT the real spectator name +
//                          gradePlayerStatistics/profileSearch recovers a
//                          DIFFERENT api id that resolves ok. This is the
//                          population that would become dead private stubs if
//                          backfill (unmodified) ran over them.
//   genuinely-private     storedUuid -> not-found, and no recovery match found.
//   unrecoverable-noname  spectator re-fetch couldn't produce a usable name
//                          (game/box-score gone) — can't attempt recovery.
//   blocked / error       transport-level, not a classification.
//
// Every query/session here is the SAME code already proven in this session:
//   - session + publicProfileStatistics + gradePlayerStatistics + profileSearch:
//     copied from diagnose-namespace-mismatch.js (itself copied from
//     fetch-profile-stats.js / playhq_api_reference.md).
//   - spectator game(id) fetch: copied from diagnose-namespace-mismatch.js
//     (itself copied from nightly-crawl.js).
//   - candidate/appearance extraction from games/bv: copied from
//     diagnose-uuid-population.js / backfill-missing-players.js Phase 1, with
//     one addition — team id (tid), not just team name, since matchFromGrade
//     needs tid.
//
// Usage:
//   node scripts/diagnose-uuid-classification.js --sample=300
//   node scripts/diagnose-uuid-classification.js --sample=300 --seed=42

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
const { isFullUuid } = require('./lib/uuid-prefix.cjs');
const {
  GRADE_PLAYERS_QUERY, PROFILE_SEARCH_QUERY,
  matchFromGrade, matchFromSearch, isPlaceholderName,
} = require('./lib/namespace-resolve.cjs');

const ROOT      = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games', 'bv');
const INDEX_DIR = path.join(ROOT, 'players', 'indexes');
const SPORT_INDEX_FILE = path.join(ROOT, 'data', 'sports-index.json');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const SAMPLE_SIZE = Math.max(1, parseInt(ARGS['sample'] || '300', 10));
const SEED        = parseInt(ARGS['seed'] || '1', 10);

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function playerShard(uuid) { return uuid.slice(0, 2).toLowerCase(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// sports-index.json — { seasons: { [sid]: { orgId, ... } } } — same access
// pattern as backfill-missing-players.js L588/686 (sportIndex.seasons?.[sid]).
let sportIndex = { seasons: {} };
try { sportIndex = readJson(SPORT_INDEX_FILE); } catch (_) {}
function orgIdForSid(sid) { return sportIndex.seasons?.[sid]?.orgId || null; }

// Deterministic PRNG (mulberry32) so --seed makes the sample reproducible.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Step 1: rebuild the un-indexed candidate pool from games/bv ─────────────
// Same extraction as diagnose-uuid-population.js, PLUS team id (tid) alongside
// team name, since gradePlayerStatistics matching needs tid.
console.log('diagnose-uuid-classification.js  (READ-ONLY — no writes, no commits)');
console.log('─'.repeat(64));
console.log(`Step 1 — rebuilding un-indexed candidate pool from games/bv (sample=${SAMPLE_SIZE}, seed=${SEED})…`);

const indexCache = new Map();
function readPlayerIndex(shard) {
  if (indexCache.has(shard)) return indexCache.get(shard);
  const file = path.join(INDEX_DIR, `${shard}.json`);
  let data = {};
  if (fs.existsSync(file)) { try { data = readJson(file); } catch (_) { data = {}; } }
  indexCache.set(shard, data);
  return data;
}
function isAlreadyKnown(uuid) { return !!readPlayerIndex(playerShard(uuid))[uuid]; }

let sids = [];
try { sids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')); }
catch (e) { console.error(`Cannot read ${GAMES_DIR}: ${e.message}`); process.exit(1); }

const pool = new Map(); // uuid -> { sid, gameId, gradeId, tid, side }
let gamesScanned = 0;

for (const fname of sids) {
  let gf;
  try { gf = readJson(path.join(GAMES_DIR, fname)); } catch { continue; }
  const sid = fname.replace('.json', '');
  for (const [gameId, g] of Object.entries(gf.games || {})) {
    gamesScanned++;
    const tagged = [];
    for (const e of (g.p  || [])) { if (e?.id)        tagged.push([e.id, null,  null]); }
    for (const e of (g.hp || [])) { if (e?.profileID) tagged.push([e.profileID, 'home', g.h || null]); }
    for (const e of (g.ap || [])) { if (e?.profileID) tagged.push([e.profileID, 'away', g.a || null]); }
    for (const [uuid, side, tid] of tagged) {
      if (!isFullUuid(uuid)) continue;
      if (isAlreadyKnown(uuid)) continue;
      if (!pool.has(uuid)) {
        pool.set(uuid, { sid, gameId, gradeId: g.gid || null, tid, side });
      }
    }
  }
}
console.log(`  ${gamesScanned.toLocaleString()} games scanned | ${pool.size.toLocaleString()} un-indexed full-uuids found`);

// Deterministic sample without replacement.
const allUuids = [...pool.keys()];
const rng = mulberry32(SEED);
for (let i = allUuids.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [allUuids[i], allUuids[j]] = [allUuids[j], allUuids[i]];
}
const sample = allUuids.slice(0, Math.min(SAMPLE_SIZE, allUuids.length));
console.log(`  Sampled ${sample.length} of ${pool.size.toLocaleString()} un-indexed uuids.`);

// ─── HTTP transport (copied from fetch-profile-stats.js via diagnose-namespace-mismatch.js) ─
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
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          rawCookies: hdrs['set-cookie'],
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

let apiCookie = null, apiPromise = null;
async function refreshApiSession() {
  if (apiPromise) return apiPromise;
  apiPromise = (async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (attempt > 1) await sleep(attempt * 5000);
      for (const body of COOKIE_QUERIES) {
        const res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() }, body: JSON.stringify(body) });
        const raw = res.rawCookies;
        if (!raw) continue;
        const parts = (Array.isArray(raw) ? raw : [raw]).map(c => c.split(';')[0].trim());
        const get = n => parts.find(c => c.startsWith(n + '=')) || null;
        const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
        if (!tier || !session || !sub) continue;
        apiCookie = `${tier}; ${session}; ${sub}`;
        apiPromise = null;
        console.log(`  api session refreshed (attempt ${attempt})`);
        return;
      }
    }
    apiPromise = null;
    throw new Error('Failed to obtain api session after 10 attempts');
  })();
  return apiPromise;
}

let spectatorCookie = null;
async function refreshSpectatorSession() {
  const body = { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    const res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() }, body: JSON.stringify(body) });
    const raw = res.rawCookies;
    if (!raw) continue;
    const arr = (Array.isArray(raw) ? raw : [raw]).map(c => c.split(';')[0].trim());
    const get = n => arr.find(p => p.startsWith(n + '=')) || null;
    const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
    if (tier && session && sub) { spectatorCookie = `${tier}; ${session}; ${sub}`; return; }
  }
  throw new Error('Failed to obtain spectator session after 10 attempts');
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

const REFRESH_EVERY = 30;
let profileCallCount = 0;

async function publicProfileStatistics(profileID) {
  if (!apiCookie) await refreshApiSession();
  if (profileCallCount > 0 && profileCallCount % REFRESH_EVERY === 0) { apiCookie = null; await refreshApiSession(); }
  profileCallCount++;
  const body = { ...PROFILE_QUERY, variables: { profileID } };
  let res;
  try { res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': apiCookie }, body: JSON.stringify(body) }); }
  catch (_) { return { status: 'error' }; }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    return (b.includes('DOCTYPE') || b.includes('Request blocked')) ? { status: 'blocked' } : { status: 'not-found' };
  }
  if (!res.ok) return { status: 'error' };
  let json; try { json = await res.json(); } catch (_) { return { status: 'error' }; }
  if (json.errors && json.errors.length) {
    const msg = json.errors[0]?.message || '';
    return (msg.includes('NOT_FOUND') || msg.includes('failed to find profile')) ? { status: 'not-found' } : { status: 'error' };
  }
  const data = json.data || json;
  return data?.publicProfileStatistics ? { status: 'ok' } : { status: 'not-found' };
}

// gradePlayerStatistics, cached per gradeId (many candidates share a grade).
const gradeCache = new Map();
async function gradePlayers(gradeID) {
  if (gradeCache.has(gradeID)) return gradeCache.get(gradeID);
  if (!apiCookie) await refreshApiSession();
  const body = { operationName: 'GradePlayerStatistics', variables: { gradeID }, query: GRADE_PLAYERS_QUERY };
  let res;
  try { res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': apiCookie }, body: JSON.stringify(body) }); }
  catch (_) { return { status: 'error', results: [] }; }
  let out;
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    out = (b.includes('DOCTYPE') || b.includes('Request blocked')) ? { status: 'blocked', results: [] } : { status: 'error', results: [] };
  } else if (!res.ok) {
    out = { status: 'error', results: [] };
  } else {
    let json; try { json = await res.json(); } catch (_) { json = null; }
    out = (json && !(json.errors && json.errors.length))
      ? { status: 'ok', results: (json.data || json)?.gradePlayerStatistics?.results || [] }
      : { status: 'error', results: [] };
  }
  if (out.status === 'ok') gradeCache.set(gradeID, out); // only cache successes
  return out;
}

async function profileSearchLookup(fullName) {
  if (!apiCookie) await refreshApiSession();
  const body = { operationName: 'ProfileSearch', variables: { fullName }, query: PROFILE_SEARCH_QUERY };
  let res;
  try { res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': apiCookie }, body: JSON.stringify(body) }); }
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

// spectator game(id) — cached per game (many candidates share a game).
const spectatorCache = new Map();
async function gqlSpectator(gameId) {
  if (spectatorCache.has(gameId)) return spectatorCache.get(gameId);
  if (!spectatorCookie) await refreshSpectatorSession();
  const query = `query game($id: ID!) {
    game(id: $id) {
      id status
      statistics {
        home { players { profileID name playerNumber } }
        away { players { profileID name playerNumber } }
      }
    }
  }`;
  let result = null;
  try {
    let res = await doFetch(SPECTATOR_URL, { headers: { ...HEADERS_SPECTATOR, 'request-id': crypto.randomUUID(), Cookie: spectatorCookie }, body: JSON.stringify({ operationName: 'game', variables: { id: gameId }, query }) });
    if (res.status === 403) {
      await refreshSpectatorSession();
      res = await doFetch(SPECTATOR_URL, { headers: { ...HEADERS_SPECTATOR, 'request-id': crypto.randomUUID(), Cookie: spectatorCookie }, body: JSON.stringify({ operationName: 'game', variables: { id: gameId }, query }) });
    }
    if (res.status === 200) {
      const j = await res.json().catch(() => null);
      if (j && !j.errors) result = j.data?.game || null;
    }
  } catch (_) { result = null; }
  spectatorCache.set(gameId, result);
  return result;
}

function nameForUuidInGame(gameData, uuid) {
  const home = gameData?.statistics?.home?.players || [];
  const away = gameData?.statistics?.away?.players || [];
  const hit = home.find(p => p.profileID === uuid) || away.find(p => p.profileID === uuid);
  return hit ? hit.name : null;
}

// ─── Step 2: classify each sampled uuid ───────────────────────────────────────
async function classifyOne(uuid, appr) {
  const stored = await publicProfileStatistics(uuid);
  if (stored.status === 'blocked') return { class: 'blocked' };
  if (stored.status === 'error')   return { class: 'error' };
  if (stored.status === 'ok')      return { class: 'already-public' };

  // stored id is not-found -- attempt recovery via the real spectator name.
  const gameData = await gqlSpectator(appr.gameId);
  if (gameData === null) return { class: 'unrecoverable-noname' }; // could also be transport issue; treated conservatively
  const name = nameForUuidInGame(gameData, uuid);
  if (isPlaceholderName(name)) return { class: 'unrecoverable-noname' };

  let apiId = null, via = null;
  if (appr.gradeId && appr.tid) {
    const g = await gradePlayers(appr.gradeId);
    if (g.status === 'blocked') return { class: 'blocked' };
    const m = matchFromGrade(g.results, { name, tid: appr.tid });
    if (m) { apiId = m; via = 'grade'; }
  }
  if (!apiId) {
    const sr = await profileSearchLookup(name);
    if (sr.status === 'blocked') return { class: 'blocked' };
    let m = matchFromSearch(sr.result, { name, orgId: null });
    let tag = 'search';
    if (!m) {
      const orgId = orgIdForSid(appr.sid);
      if (orgId) {
        m = matchFromSearch(sr.result, { name, orgId });
        if (m) tag = 'search-org'; // only recovered once org disambiguated a name collision
      }
    }
    if (m) { apiId = m; via = tag; }
  }
  if (!apiId || apiId === uuid) return { class: 'genuinely-private', name };

  const check = await publicProfileStatistics(apiId);
  if (check.status === 'blocked') return { class: 'blocked' };
  if (check.status === 'ok') return { class: 'diverged-recoverable', name, apiId, via };
  return { class: 'genuinely-private', name }; // recovered id itself dead -- don't overclaim
}

async function main() {
  await refreshApiSession();
  const tally = {};
  const viaTally = { grade: 0, search: 0, 'search-org': 0 };
  // Was a grade attempt even possible (had gradeId+tid), and did it fail before
  // falling to search? Distinguishes "grade wasn't tried" from "grade tried, missed".
  const gradeAttemptTally = { attempted: 0, hit: 0, missedThenSearchHit: 0, noGradeContext: 0 };
  const examples = { 'diverged-recoverable': [], 'genuinely-private': [], 'already-public': [], 'unrecoverable-noname': [] };
  let done = 0;

  for (const uuid of sample) {
    const appr = pool.get(uuid);
    const hadGradeContext = !!(appr.gradeId && appr.tid);
    const res = await classifyOne(uuid, appr);
    tally[res.class] = (tally[res.class] || 0) + 1;
    if (res.class === 'diverged-recoverable') {
      viaTally[res.via] = (viaTally[res.via] || 0) + 1;
      if (hadGradeContext) {
        gradeAttemptTally.attempted++;
        if (res.via === 'grade') gradeAttemptTally.hit++;
        else gradeAttemptTally.missedThenSearchHit++;
      } else {
        gradeAttemptTally.noGradeContext++;
      }
    }
    if (examples[res.class] && examples[res.class].length < 5) {
      examples[res.class].push({ uuid, ...res });
    }
    done++;
    if (res.class === 'blocked') {
      console.log(`  ⛔ CloudFront block at ${done}/${sample.length} — stopping early.`);
      break;
    }
    if (done % 50 === 0) console.log(`  ...${done}/${sample.length} classified`);
  }

  console.log('\n══ classification result ═══════════════════════════════════');
  console.log(`  Sample size (attempted)     : ${done} of ${sample.length} planned (pool=${pool.size.toLocaleString()})`);
  for (const k of ['already-public', 'diverged-recoverable', 'genuinely-private', 'unrecoverable-noname', 'error', 'blocked']) {
    const n = tally[k] || 0;
    console.log(`    ${k.padEnd(22)}: ${n}  (${done ? (n / done * 100).toFixed(1) : '0.0'}%)`);
  }
  const projected = pool.size && done ? Math.round((tally['diverged-recoverable'] || 0) / done * pool.size) : 0;
  console.log(`\n  Projected diverged-recoverable across full pool (${pool.size.toLocaleString()}): ~${projected.toLocaleString()}`);

  const recTotal = (tally['diverged-recoverable'] || 0);
  console.log(`\n  ── recovery path breakdown (of ${recTotal} diverged-recoverable) ──`);
  console.log(`    via gradePlayerStatistics       : ${viaTally.grade}  (${recTotal ? (viaTally.grade / recTotal * 100).toFixed(1) : '0.0'}%)`);
  console.log(`    via profileSearch (no collision): ${viaTally.search}  (${recTotal ? (viaTally.search / recTotal * 100).toFixed(1) : '0.0'}%)`);
  console.log(`    via profileSearch + orgId        : ${viaTally['search-org']}  (${recTotal ? (viaTally['search-org'] / recTotal * 100).toFixed(1) : '0.0'}%)  <- ONLY recovered because org disambiguated a name collision`);
  console.log(`\n  NOTE: "via profileSearch + orgId" is the direct measure of the undercount from the`);
  console.log(`        previous run (which passed orgId:null always). It shows how many additional`);
  console.log(`        players move from "genuinely-private" to "diverged-recoverable" with org context.`);
  console.log(`\n  ── grade-attempt detail (only for recoverable candidates that HAD gradeId+tid) ──`);
  console.log(`    had grade context, attempted gradePlayerStatistics : ${gradeAttemptTally.attempted}`);
  console.log(`      ├─ grade match hit directly                     : ${gradeAttemptTally.hit}`);
  console.log(`      └─ grade missed, search recovered it instead    : ${gradeAttemptTally.missedThenSearchHit}`);
  console.log(`    no grade context at all (search was the only path): ${gradeAttemptTally.noGradeContext}`);
  console.log('  NOTE: a "grade missed" case usually means the player was outside the 50-cap');
  console.log('        (gradePlayerStatistics returns only the highest-appearance players).');

  for (const k of Object.keys(examples)) {
    if (!examples[k].length) continue;
    console.log(`\n  examples — ${k}:`);
    for (const e of examples[k]) {
      console.log(`    ${e.uuid}${e.name ? `  name="${e.name}"` : ''}${e.apiId ? `  -> apiId=${e.apiId} (via ${e.via})` : ''}`);
    }
  }
  console.log('\nDone (nothing was written).');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
