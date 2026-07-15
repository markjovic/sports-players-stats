// scripts/rekey-apply.js
//
// 3b-2 APPLY — THE DESTRUCTIVE STEP of the api-canonical migration.
// Re-keys every diverged player file to its api id (promotes) and collapses
// duplicate files for the same person (merges), re-fetching the authoritative
// publicProfileStatistics for every touched api id. Single job, single
// destructive commit.
//
// Policy (settled 2026-07-15):
//   - Re-fetch scope: merges + promotes (~2,300 api ids). Normals untouched.
//   - Fetch ok      -> union all group members' season/reg scaffold (preserving
//                      every gid), then apply fresh full-career stats on top.
//   - Fetch private -> FALLBACK keep-most-complete: plan's keeper survives with
//                      its existing data; scaffold still unioned; private=true.
//   - Fetch error / CloudFront block -> checkpoint + exit 1; re-run resumes and
//                      retries. Errors never silently fall back.
//   - NEVER sum stats across duplicate records (full-career semantics).
//
// Safety model:
//   - GUARD: re-groups the frozen tree and ABORTS unless the derived merge set
//     is identical (api ids, keepers, drops, per-record games) to the reviewed
//     reports/rekey-merges.json, and derived promotes == EXPECTED_PROMOTES.
//     APPLY does exactly what was reviewed or nothing at all.
//   - Phase 1 (fetch) is resumable: reports/rekey-apply-cache.json is committed
//     as a checkpoint every CHECKPOINT_BATCHES batches (sanctioned progress-file
//     pattern). Re-runs skip already-resolved api ids.
//   - Phase 2 (mutate) only starts once every target is resolved ok/private,
//     mutates the working tree, and lands as ONE commit. A death before that
//     commit loses no repo state — the next run starts from a clean checkout
//     and a committed fetch cache.
//   - Already-applied detection: if the tree shows every plan target in place
//     and all old keys gone, exits 0 without touching anything.
//
// !! POST-APPLY WARNING (record for the future): after this runs, player files
// no longer carry apiId fields, so a naive `build-alias-index --all` rebuild
// would LOSE the 43k diverged redirects (they'd only partially survive via
// reports/backfill-collisions). The mapping is preserved on each player file
// as spectatorIds[] — any future alias rebuild must source redirects from
// spectatorIds, not from apiId fields. Do not re-run build-alias-index --all
// against the post-apply tree as-is.
//
// Fetch layer (HEADERS_BASE, refreshSession, PROFILE_QUERY, doFetch,
// fetchProfile, parseProfileStats, batch-of-30 with per-batch session refresh)
// is copied VERBATIM from scripts/fetch-profile-stats.js. Deviations, each
// deliberate and minimal:
//   - playerPath() takes the shard from uuid.slice(0,2) (this job spans all
//     256 shards; the original hardcoded one --shard).
//   - finishOk() is applied via a compact cached form (applyOk): identical
//     logic and order, reading precomputed parseProfileStats output plus the
//     (sid,tid) pairs the season-backfill loop extracts from the raw response.
//     Raw responses are NOT cached (would be ~50-100 MB of committed history).
//   - attemptNamespaceRecovery is omitted: APPLY queries the known canonical
//     api id directly; private/NOT_FOUND -> fallback, by policy.
//
// Usage:
//   node scripts/rekey-apply.js --dry-run   # guard + action report, no fetch, no writes
//   node scripts/rekey-apply.js             # fetch (resumable) + apply + single commit
// Env: RA_NO_GIT=1 disables all git operations (local testing only).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');
const { TRUNC_LEN, isFullUuid } = require('./lib/uuid-prefix.cjs');
const { isPlaceholderName } = require('./lib/namespace-resolve.cjs');

const ROOT = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const MERGES_FILE = path.join(ROOT, 'reports', 'rekey-merges.json');
const CACHE_FILE = path.join(ROOT, 'reports', 'rekey-apply-cache.json');
const LOG_FILE = path.join(ROOT, 'reports', 'rekey-apply-log.json');
const FORFEIT_FILE = path.join(ROOT, 'data', 'forfeit-games.json');

const DRY = process.argv.includes('--dry-run');
const NO_GIT = process.env.RA_NO_GIT === '1';

// Settled numbers from the frozen-tree plan run (2026-07-15). The guard aborts
// on any deviation — the tree is frozen, so deviation means something moved.
const EXPECTED_PROMOTES = 1392;
const EXPECTED_MERGES = 908;
const EXPECTED_ELIMINATED = 1135;

const CHECKPOINT_BATCHES = 10; // commit fetch cache every N batches (300 fetches)
const API_URL = 'https://api.playhq.com/graphql';

const HEX = '0123456789abcdef';
const ALL_BUCKETS = [];
for (const a of HEX) for (const b of HEX) ALL_BUCKETS.push(a + b);

function log(msg) { console.log(`[apply] ${new Date().toISOString()} ${msg}`); }
function trunc(id) { return String(id).slice(0, TRUNC_LEN); }

// ─── Forfeit index (needed by parseProfileStats) — as in fetch-profile-stats ──
const forfeitGameIds = new Set();
try {
  const ids = JSON.parse(fs.readFileSync(FORFEIT_FILE, 'utf8'));
  for (const id of (Array.isArray(ids) ? ids : [])) forfeitGameIds.add(id);
  log(`forfeit index loaded: ${forfeitGameIds.size} games`);
} catch (_) {}

// ─── Headers — full set, never split, never modified (verbatim) ───────────────
const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── Session cookie (verbatim, incl. promise lock) ────────────────────────────
let sessionCookie = null;
let sessionPromise = null;

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

// ─── GraphQL query (verbatim) ─────────────────────────────────────────────────
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

// ─── Stat helpers (verbatim) ──────────────────────────────────────────────────
function statValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const match = statistics.find(s => s?.details?.value === typeValue);
  return match ? (match.count || 0) : 0;
}

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

  const regStats = new Map();
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

            const fouls   = statValue(stats, 'TOTAL_FOULS');
            const pts     = statValue(stats, 'TOTAL_SCORE');
            const three   = statValue(stats, '3_POINT_SCORE');
            const fg      = statValue(stats, '2_POINT_SCORE');
            const ft      = statValue(stats, '1_POINT_SCORE');
            const gp_val  = statValue(stats, 'APPEARANCE') || 1;

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

            if (!regStats.has(regKey)) regStats.set(regKey, { gp: 0, pts: 0, fg: 0, ft: 0, threePt: 0, fouls: 0 });
            const rs = regStats.get(regKey);
            rs.gp     += gp_val;
            rs.pts    += pts;
            rs.fg     += fg;
            rs.ft     += ft;
            rs.threePt += three;
            rs.fouls  += fouls;
          }
        }
      }
    }
  }

  const hasAmbiguousSeason = Object.values(sidTids).some(s => s.size > 1);
  return { playerName, foulOuts, maxGamePTS, maxGamePTSKey, maxGameThreePt, maxGameThreePtKey, regStats, gameTids: hasAmbiguousSeason ? gameTids : null, sidTids };
}

// ─── doFetch (verbatim — keepAlive:false, new TCP conn per request) ───────────
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── fetchProfile (verbatim 403/504/CloudFront/NOT_FOUND handling) ────────────
let requestCount = 0;

async function fetchProfile(profileID) {
  if (!sessionCookie) await refreshSession();

  requestCount++;

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
      const snippet = body403.replace(/\s+/g, ' ').trim().slice(0, 300);
      console.log(`  ⛔ CloudFront block (req#${requestCount}, uuid=${profileID}): ${snippet}`);
      return { status: 'cloudfront-block' };
    }
    console.log(`  — private profile (req#${requestCount}, uuid=${profileID})`);
    return { status: 'private' };
  }

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

  if (json.errors && json.errors.length > 0) {
    const msg = json.errors[0]?.message || '';
    if (msg.includes('NOT_FOUND') || msg.includes('failed to find profile')) {
      console.log(`  — not-found (req#${requestCount}, uuid=${profileID}): ${msg}`);
      return { status: 'private' };
    }
    return { status: 'error', err: new Error(`GraphQL error: ${msg}`) };
  }

  const data = json.data || json;

  if (!data?.publicProfileStatistics) return { status: 'inaccessible' };

  return { status: 'ok', data };
}

// ─── Compact cache form ───────────────────────────────────────────────────────
// Everything applyOk() needs, extracted from a raw 'ok' response so raw
// responses never need committing. sidTidPairs replaces the raw-response
// iteration in finishOk's season-backfill loop (that loop reads ONLY
// season.id + team.id — provably equivalent).
function compactFromResult(data) {
  const parsed = parseProfileStats(data);
  if (!parsed) return null;
  const pairSet = new Set();
  const sidTidPairs = [];
  for (const season of (data.publicProfileStatistics?.seasonStatistics || [])) {
    for (const reg of (season.statistics || [])) {
      const sid = reg?.season?.id;
      if (!sid) continue;
      for (const teamStat of (reg.teamStatistics || [])) {
        const tid = teamStat.team?.id;
        if (!tid) continue;
        const k = `${sid}:${tid}`;
        if (!pairSet.has(k)) { pairSet.add(k); sidTidPairs.push([sid, tid]); }
      }
    }
  }
  const regStats = {};
  for (const [k, v] of parsed.regStats) regStats[k] = v;
  return {
    playerName: parsed.playerName,
    foulOuts: parsed.foulOuts,
    maxGamePTS: parsed.maxGamePTS,
    maxGamePTSKey: parsed.maxGamePTSKey,
    maxGameThreePt: parsed.maxGameThreePt,
    maxGameThreePtKey: parsed.maxGameThreePtKey,
    regStats,
    gameTids: parsed.gameTids,
    sidTidPairs,
  };
}

// ─── applyOk — finishOk copied line-for-line onto the compact form ────────────
const REG_STAT_FIELDS = ['gp', 'pts', 'fg', 'ft', 'threePt', 'fouls'];

function applyOk(player, c) {
  if (!player.sports)            player.sports = {};
  if (!player.sports.Basketball) player.sports.Basketball = {};

  const oldBk       = player.sports.Basketball;
  const wasPrivate  = player.private === true ||
    (oldBk.statsChecked !== undefined && oldBk.maxGamePTS === null);
  if (c.playerName && (!player.name || wasPrivate)) {
    player.name = c.playerName;
  }
  player.private = false;

  const bk = player.sports.Basketball;
  bk.foulOuts       = c.foulOuts;
  bk.maxGamePTS     = c.maxGamePTS;
  bk.maxGameThreePt = c.maxGameThreePt;

  for (const season of (player.seasons || [])) {
    const sid = season.sid;
    for (const reg of (season.regs || [])) {
      const regKey = `${sid}:${reg.tid}`;
      const rs = c.regStats[regKey];
      if (!reg.stats) reg.stats = {};
      for (const field of REG_STAT_FIELDS) {
        const val = rs ? (rs[field] || 0) : 0;
        if (val === 0) delete reg.stats[field];
        else reg.stats[field] = val;
      }
    }
  }

  const career = { gp: 0, pts: 0, fg: 0, ft: 0, threePt: 0, fouls: 0 };
  for (const rs of Object.values(c.regStats)) {
    career.gp     += rs.gp;
    career.pts    += rs.pts;
    career.fg     += rs.fg;
    career.ft     += rs.ft;
    career.threePt += rs.threePt;
    career.fouls  += rs.fouls;
  }
  for (const field of REG_STAT_FIELDS) {
    if (career[field] === 0) delete bk[field];
    else bk[field] = career[field];
  }

  if (c.gameTids && Object.keys(c.gameTids).length > 0) {
    player.gameTids = c.gameTids;
  } else if (player.gameTids) {
    delete player.gameTids;
  }

  if (!player.seasons) player.seasons = [];
  for (const [sid, tid] of (c.sidTidPairs || [])) {
    let existingSeason = player.seasons.find(s => s.sid === sid);
    if (!existingSeason) {
      existingSeason = { sid, regs: [] };
      player.seasons.push(existingSeason);
    }
    if (!existingSeason.regs) existingSeason.regs = [];
    if (!existingSeason.regs.find(r => r.tid === tid)) {
      existingSeason.regs.push({ tid });
    }
  }

  if (!player.records) player.records = {};
  player.records.maxGamePTS = c.maxGamePTSKey
    ? { v: c.maxGamePTS, ...c.maxGamePTSKey }
    : { v: c.maxGamePTS ?? null };
  player.records.maxGameThreePt = c.maxGameThreePtKey
    ? { v: c.maxGameThreePt, ...c.maxGameThreePtKey }
    : { v: c.maxGameThreePt ?? null };
  bk.statsChecked   = new Date().toISOString();
}

// ─── Player file IO — writePlayer format verbatim; path spans all shards ──────
function playerPath(uuid) {
  return path.join(PLAYERS_DIR, uuid.slice(0, 2), `${uuid}.json`);
}
function readPlayer(uuid) {
  return JSON.parse(fs.readFileSync(playerPath(uuid), 'utf8'));
}
function writePlayer(uuid, player) {
  fs.mkdirSync(path.dirname(playerPath(uuid)), { recursive: true });
  fs.writeFileSync(playerPath(uuid), JSON.stringify(player), 'utf8');
}
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

// ─── Scaffold union (merge duplicates' seasons/regs into the keeper) ──────────
// Preserves every sid, every tid, and every gid seen on ANY record for the
// person. Never touches stats (those come from the fetch, or stay the
// keeper's on fallback). Shallow-fills reg fields the target reg lacks.
function unionScaffold(target, source) {
  if (!target.seasons) target.seasons = [];
  for (const s of (source.seasons || [])) {
    let t = target.seasons.find(x => x.sid === s.sid);
    if (!t) {
      target.seasons.push(clone(s));
      continue;
    }
    if (!t.regs) t.regs = [];
    for (const r of (s.regs || [])) {
      const tr = t.regs.find(x => x.tid === r.tid);
      if (!tr) {
        t.regs.push(clone(r));
      } else {
        for (const k of Object.keys(r)) {
          if (tr[k] === undefined) tr[k] = clone(r[k]);
        }
      }
    }
  }
  // games[]: flat array of short game ids from the spectator crawl — the fetch
  // NEVER rebuilds this (finishOk doesn't touch it), so a drop's entries exist
  // nowhere else. Union as opaque strings, sorted (verified schema: Amy Crauford
  // keeper 20 ids / drop 2 ids, disjoint).
  if (Array.isArray(source.games) && source.games.length) {
    const g = new Set(Array.isArray(target.games) ? target.games : []);
    for (const id of source.games) g.add(id);
    target.games = [...g].sort();
  }
  // teams[]: union with value-level dedup (observed empty in production samples,
  // but never silently discard a drop's entries)
  if (Array.isArray(source.teams) && source.teams.length) {
    if (!Array.isArray(target.teams)) target.teams = [];
    const seen = new Set(target.teams.map(t => JSON.stringify(t)));
    for (const t of source.teams) {
      const k = JSON.stringify(t);
      if (!seen.has(k)) { seen.add(k); target.teams.push(t); }
    }
  }
  // gameTids: union (a fresh fetch rebuilds this wholesale; only matters on fallback)
  if (source.gameTids) {
    if (!target.gameTids) target.gameTids = {};
    for (const [g, t] of Object.entries(source.gameTids)) {
      if (target.gameTids[g] === undefined) target.gameTids[g] = t;
    }
  }
  // name: fill if missing, or replace a placeholder with a real captured name
  if (source.name && (!target.name || (isPlaceholderName(target.name) && !isPlaceholderName(source.name)))) {
    target.name = source.name;
  }
}

// ─── Tree scan + grouping (scan fields verbatim from rekey-plan.js) ───────────
function gamesCount(p) { return Array.isArray(p.games) ? p.games.length : 0; }

function scanTree() {
  const groups = new Map(); // apiId -> [{key, apiId, name, games, size, diverged}]
  let files = 0;
  for (const bucket of ALL_BUCKETS) {
    const dir = path.join(PLAYERS_DIR, bucket);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const key = f.slice(0, -5);
      if (!isFullUuid(key)) continue;
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const apiId = (typeof p.apiId === 'string' && p.apiId) ? p.apiId : key;
      const rec = { key, apiId, name: p.name || '', games: gamesCount(p), size: JSON.stringify(p).length, diverged: apiId !== key };
      let g = groups.get(apiId);
      if (!g) { g = []; groups.set(apiId, g); }
      g.push(rec);
      files++;
      if (files % 50000 === 0) log(`scanned ${files} files`);
    }
  }
  log(`scan complete: ${files} files, ${groups.size} people`);
  return { groups, files };
}

// Keeper comparator copied verbatim from rekey-plan.js plan().
function sortGroup(recs, apiId) {
  recs.sort((a, b) => (b.games - a.games) || ((a.key === apiId ? -1 : 0) - (b.key === apiId ? -1 : 0)) || (b.size - a.size));
}

// ─── Guard: derived state must equal the reviewed plan ────────────────────────
function deriveAndVerify(groups) {
  const derivedMerges = new Map(); // apiId -> { keepKey, drops: Map(key->games), keepGames }
  const promotes = [];
  let normal = 0;

  for (const [apiId, recs] of groups) {
    if (recs.length === 1) {
      if (recs[0].diverged) promotes.push({ apiId, oldKey: recs[0].key });
      else normal++;
      continue;
    }
    sortGroup(recs, apiId);
    const keep = recs[0];
    derivedMerges.set(apiId, {
      keepKey: keep.key,
      keepGames: keep.games,
      drops: new Map(recs.slice(1).map(d => [d.key, d.games])),
    });
  }

  const plan = JSON.parse(fs.readFileSync(MERGES_FILE, 'utf8'));
  const mismatches = [];

  if (plan.length !== derivedMerges.size) {
    mismatches.push(`merge count: plan=${plan.length} derived=${derivedMerges.size}`);
  }
  for (const m of plan) {
    const d = derivedMerges.get(m.apiId);
    if (!d) { mismatches.push(`${m.apiId}: in plan, not derived`); continue; }
    if (d.keepKey !== m.keep.key) mismatches.push(`${m.apiId}: keeper plan=${m.keep.key} derived=${d.keepKey}`);
    if (d.keepGames !== m.keep.games) mismatches.push(`${m.apiId}: keeper games plan=${m.keep.games} derived=${d.keepGames}`);
    const dropKeys = new Set(d.drops.keys());
    for (const drop of m.drop) {
      if (!d.drops.has(drop.key)) mismatches.push(`${m.apiId}: drop ${drop.key} in plan, not derived`);
      else if (d.drops.get(drop.key) !== drop.games) mismatches.push(`${m.apiId}: drop ${drop.key} games plan=${drop.games} derived=${d.drops.get(drop.key)}`);
      dropKeys.delete(drop.key);
    }
    for (const extra of dropKeys) mismatches.push(`${m.apiId}: derived drop ${extra} not in plan`);
  }
  for (const apiId of derivedMerges.keys()) {
    if (!plan.find(m => m.apiId === apiId)) mismatches.push(`${apiId}: derived merge not in plan`);
  }
  if (promotes.length !== EXPECTED_PROMOTES) {
    mismatches.push(`promotes: expected ${EXPECTED_PROMOTES}, derived ${promotes.length}`);
  }
  const eliminated = [...derivedMerges.values()].reduce((n, d) => n + d.drops.size, 0);
  if (eliminated !== EXPECTED_ELIMINATED) {
    mismatches.push(`eliminated: expected ${EXPECTED_ELIMINATED}, derived ${eliminated}`);
  }
  if (plan.length !== EXPECTED_MERGES) {
    mismatches.push(`plan merges: expected ${EXPECTED_MERGES}, file has ${plan.length}`);
  }

  return { plan, promotes, normal, mismatches, eliminated };
}

// Already-applied: every plan target in place, every old key gone, zero diverged.
function checkAlreadyApplied(groups, plan) {
  let divergedLeft = 0;
  for (const recs of groups.values()) for (const r of recs) if (r.diverged) divergedLeft++;
  if (divergedLeft > 0) return false;
  for (const m of plan) {
    if (!fs.existsSync(playerPath(m.apiId))) return false;
    if (m.keep.key !== m.apiId && fs.existsSync(playerPath(m.keep.key))) return false;
    // a drop whose key IS the api id is the surviving file's path — it must exist
    for (const d of m.drop) if (d.key !== m.apiId && fs.existsSync(playerPath(d.key))) return false;
  }
  return true;
}

// ─── Git helpers — in-script pattern from build-alias-index.js commit(),  ─────
// upgraded to the proven 60-attempt random-jitter retry with merge --abort
// cleanup (fetch-profile-stats push pattern, per handoff).
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function gitAddPaths(paths) {
  for (let i = 0; i < paths.length; i += 500) {
    git(['add', '--', ...paths.slice(i, i + 500)]); // explicit paths, never -A
  }
}

function gitCommitPush(paths, message) {
  if (NO_GIT || DRY) return;
  gitAddPaths(paths);
  const staged = git(['diff', '--cached', '--shortstat']).trim(); // never --stat
  if (!staged) { log('nothing staged, skip commit'); return; }
  git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
       'commit', '-m', message]); // single-line message
  for (let attempt = 1; attempt <= 60; attempt++) {
    try { git(['merge', '--abort']); } catch (_) { /* no merge in progress */ }
    try {
      git(['fetch', 'origin', 'main']);
      git(['merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit']); // never rebase
      git(['push', 'origin', 'HEAD:main']);
      log(`pushed on attempt ${attempt}`);
      return;
    } catch (e) {
      if (attempt === 60) throw e;
      const jitter = 1000 + Math.floor(Math.random() * 90000); // 1-91s random
      log(`push attempt ${attempt} failed, retrying in ${Math.round(jitter / 1000)}s`);
      execFileSync('sleep', [String(Math.ceil(jitter / 1000))]);
    }
  }
}

// ─── Fetch cache ──────────────────────────────────────────────────────────────
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (_) { return { generatedAt: null, entries: {} }; }
}
function saveCache(cache) {
  cache.generatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
}

// ─── Phase 1: resumable fetch (batch-of-30 loop verbatim from main()) ─────────
async function fetchPhase(targets, cache) {
  const pending = targets.filter(t => {
    const e = cache.entries[t];
    return !(e && (e.status === 'ok' || e.status === 'private'));
  });
  log(`fetch phase: ${targets.length} targets, ${targets.length - pending.length} cached, ${pending.length} to fetch`);
  if (pending.length === 0) return { blocked: false, errors: 0 };

  console.log('\n  Obtaining session…');
  await refreshSession();
  console.log(`\n  Running (batch_size=30)…\n`);

  let blocked = false;
  let errors = 0;
  let batchNum = 0;
  let sinceCheckpoint = 0;

  for (let batchStart = 0; batchStart < pending.length && !blocked; batchStart += 30) {
    if (batchNum > 0) {
      console.log(`  ↺ Session refresh before batch ${batchNum + 1}`);
      await refreshSession();
    }
    batchNum++;

    const batch = pending.slice(batchStart, Math.min(batchStart + 30, pending.length));

    const results = await Promise.allSettled(batch.map(async (apiId) => {
      const r = await fetchProfile(apiId);
      if (r.status === 'ok') {
        const c = compactFromResult(r.data);
        if (c) cache.entries[apiId] = { status: 'ok', c };
        else cache.entries[apiId] = { status: 'private' }; // null parse = inaccessible
      } else if (r.status === 'private' || r.status === 'inaccessible') {
        cache.entries[apiId] = { status: 'private' };
      } else if (r.status === 'error') {
        errors++;
        console.log(`  ✗ ${apiId.slice(0, 8)} ERROR: ${r.err?.message}`);
      }
      return r;
    }));

    const blockIdx = results.findIndex(r =>
      r.status === 'fulfilled' && r.value?.status === 'cloudfront-block'
    );
    if (blockIdx !== -1) {
      console.log(`\n  ⛔ CloudFront block in batch ${batchNum}. Checkpointing — re-run to continue.`);
      blocked = true;
    }

    sinceCheckpoint++;
    const done = Object.keys(cache.entries).length;
    if (sinceCheckpoint >= CHECKPOINT_BATCHES || blocked || batchStart + 30 >= pending.length) {
      saveCache(cache);
      gitCommitPush([CACHE_FILE], `rekey-apply: fetch checkpoint ${done}/${targets.length} (3b-2)`);
      log(`checkpoint: ${done}/${targets.length} resolved`);
      sinceCheckpoint = 0;
    }

    if (!blocked && batchStart + 30 < pending.length) await sleep(1000);
  }

  return { blocked, errors };
}

// ─── Phase 2: single-commit mutate ────────────────────────────────────────────
function mutatePhase(plan, promotes, cache) {
  // Pre-pass validation: every member file exists; promote targets are free.
  const problems = [];
  for (const m of plan) {
    for (const r of [m.keep, ...m.drop]) {
      if (!fs.existsSync(playerPath(r.key))) problems.push(`merge ${m.apiId}: missing file ${r.key}`);
    }
  }
  for (const p of promotes) {
    if (!fs.existsSync(playerPath(p.oldKey))) problems.push(`promote ${p.apiId}: missing file ${p.oldKey}`);
    if (fs.existsSync(playerPath(p.apiId))) problems.push(`promote ${p.apiId}: target already exists`);
  }
  if (problems.length) {
    for (const p of problems.slice(0, 30)) log(`PRE-PASS PROBLEM: ${p}`);
    throw new Error(`pre-pass validation failed with ${problems.length} problem(s) — nothing written`);
  }

  const written = [];
  const deleted = [];
  let newTargets = 0; // target paths that did not exist pre-run
  const logEntries = [];
  let fetchedApplied = 0, fallbackPrivate = 0, processed = 0;

  const buildAndWrite = (apiId, keeperKey, memberKeys) => {
    if (!fs.existsSync(playerPath(apiId))) newTargets++;
    const keeper = readPlayer(keeperKey);
    const base = clone(keeper);

    for (const k of memberKeys) {
      if (k === keeperKey) continue;
      unionScaffold(base, readPlayer(k));
    }

    // spectatorIds: union of every member's list + trunc13 of every id that
    // now resolves to this person (member keys + the api id itself).
    const spec = new Set(Array.isArray(base.spectatorIds) ? base.spectatorIds : []);
    for (const k of memberKeys) {
      const m = k === keeperKey ? keeper : null;
      const arr = m && Array.isArray(m.spectatorIds) ? m.spectatorIds : null;
      if (arr) for (const s of arr) spec.add(s);
      spec.add(trunc(k));
    }
    spec.add(trunc(apiId));
    base.spectatorIds = [...spec].sort();

    base.uuid = apiId;
    delete base.apiId; // filename IS the api id now — the diverged marker must go

    const entry = cache.entries[apiId];
    let outcome;
    if (entry && entry.status === 'ok') {
      applyOk(base, entry.c);
      outcome = 'fetched';
      fetchedApplied++;
    } else {
      // private -> fallback keep-most-complete: keeper's data survives untouched
      base.private = true; // fetch proved currently inaccessible; name/stats left as-is
      outcome = 'fallback-private';
      fallbackPrivate++;
    }

    writePlayer(apiId, base);
    written.push(playerPath(apiId));
    for (const k of memberKeys) {
      if (k === apiId) continue;
      fs.unlinkSync(playerPath(k));
      deleted.push(playerPath(k));
    }
    return outcome;
  };

  for (const m of plan) {
    const memberKeys = [m.keep.key, ...m.drop.map(d => d.key)];
    const outcome = buildAndWrite(m.apiId, m.keep.key, memberKeys);
    logEntries.push({ apiId: m.apiId, action: 'merge', keeper: m.keep.key, dropped: m.drop.map(d => d.key), outcome });
    processed++;
    if (processed % 200 === 0) log(`mutate: ${processed}/${plan.length + promotes.length}`);
  }
  for (const p of promotes) {
    const outcome = buildAndWrite(p.apiId, p.oldKey, [p.oldKey]);
    logEntries.push({ apiId: p.apiId, action: 'promote', oldKey: p.oldKey, outcome });
    processed++;
    if (processed % 200 === 0) log(`mutate: ${processed}/${plan.length + promotes.length}`);
  }

  return { written, deleted, newTargets, logEntries, fetchedApplied, fallbackPrivate };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`rekey-apply ${DRY ? '(DRY RUN)' : '(APPLY)'}`);

  const { groups, files } = scanTree();
  const { plan, promotes, normal, mismatches, eliminated } = deriveAndVerify(groups);

  if (mismatches.length) {
    if (checkAlreadyApplied(groups, plan)) {
      log('Migration already applied — every target in place, all old keys gone. Nothing to do.');
      return;
    }
    log(`GUARD FAILED — derived state does not match the reviewed plan (${mismatches.length} mismatch(es)):`);
    for (const m of mismatches.slice(0, 40)) log(`  ${m}`);
    throw new Error('guard failed: tree does not match reports/rekey-merges.json — NOTHING was written');
  }
  log(`guard OK: files=${files} merges=${plan.length} promotes=${promotes.length} normal=${normal} eliminated=${eliminated}`);

  const targets = [...plan.map(m => m.apiId), ...promotes.map(p => p.apiId)];
  const cache = loadCache();

  if (DRY) {
    let cachedOk = 0, cachedPrivate = 0, uncached = 0;
    for (const t of targets) {
      const e = cache.entries[t];
      if (e && e.status === 'ok') cachedOk++;
      else if (e && e.status === 'private') cachedPrivate++;
      else uncached++;
    }
    const md = [
      '## 3b-2 APPLY — DRY RUN (guard passed, nothing written)', '',
      '| metric | value |', '| --- | --- |',
      `| files scanned | ${files} |`,
      `| merges (== reviewed plan) | ${plan.length} |`,
      `| promotes | ${promotes.length} |`,
      `| files to eliminate | ${eliminated} |`,
      `| fetch targets | ${targets.length} |`,
      `| — cached ok | ${cachedOk} |`,
      `| — cached private (will fallback) | ${cachedPrivate} |`,
      `| — still to fetch | ${uncached} |`,
    ].join('\n') + '\n';
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md); } catch (_) {}
    }
    return;
  }

  // Phase 1 — resumable fetch
  const { blocked, errors } = await fetchPhase(targets, cache);
  if (blocked) throw new Error('CloudFront block — checkpoint committed; re-run to resume');
  if (errors > 0) throw new Error(`${errors} fetch error(s) — checkpoint committed; re-run to retry them`);

  const unresolved = targets.filter(t => !cache.entries[t]);
  if (unresolved.length) throw new Error(`${unresolved.length} target(s) unresolved after fetch — re-run`);

  // Phase 2 — mutate + ONE commit
  const { written, deleted, newTargets, logEntries, fetchedApplied, fallbackPrivate } = mutatePhase(plan, promotes, cache);
  const netEliminated = deleted.length - newTargets; // exact: files_before - files_after

  const report = {
    generatedAt: new Date().toISOString(),
    merges: plan.length,
    promotes: promotes.length,
    filesWritten: written.length,
    filesDeleted: deleted.length,
    eliminatedExpected: EXPECTED_ELIMINATED,
    netEliminated,
    newTargets,
    fetchedApplied,
    fallbackPrivate,
    entries: logEntries,
  };
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(report, null, 2), 'utf8');

  const md = [
    '## 3b-2 APPLY — done', '',
    '| metric | value |', '| --- | --- |',
    `| merges applied | ${plan.length} |`,
    `| promotes applied | ${promotes.length} |`,
    `| files written | ${written.length} |`,
    `| files deleted | ${deleted.length} |`,
    `| re-fetched (authoritative) | ${fetchedApplied} |`,
    `| fallback keep-most-complete (private) | ${fallbackPrivate} |`,
    `| net files eliminated (deleted − new paths) | ${netEliminated} (expect ${EXPECTED_ELIMINATED}) |`,
    `| reconciles? | ${netEliminated === EXPECTED_ELIMINATED} |`,
  ].join('\n') + '\n';
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md); } catch (_) {}
  }
  log(`written=${written.length} deleted=${deleted.length} fetched=${fetchedApplied} fallback=${fallbackPrivate}`);

  if (netEliminated !== EXPECTED_ELIMINATED) {
    throw new Error(`reconcile failed: net eliminated ${netEliminated} != expected ${EXPECTED_ELIMINATED} — working tree mutated but NOT committed; investigate before re-running`);
  }

  gitCommitPush(
    [...written, ...deleted, LOG_FILE, CACHE_FILE],
    `rekey-apply: promote ${promotes.length}, merge ${plan.length}, eliminate ${EXPECTED_ELIMINATED} files (3b-2)`
  );
  log('APPLY complete.');
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
