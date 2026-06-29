// scripts/diagnose-ambiguous-fresh.js
//
// Fetches fresh publicProfileStatistics from PlayHQ for all ambiguous players
// (those with multiple tids in the same season appearing on both sides of games).
// Prints raw API registration structure so we can see what PlayHQ actually says
// about their team memberships — ground truth vs what's stored in player files.
//
// Usage:
//   node scripts/diagnose-ambiguous-fresh.js

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const LOOKUP_DIR  = path.join(ROOT, 'team-lookup');

const sportsIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sports-index.json'), 'utf8'));
const allSids     = new Set(Object.keys(sportsIndex.seasons || {}));

// ── Headers — copied exactly from fetch-profile-stats.js ─────────────────────

const API_URL    = 'https://api.playhq.com/graphql';
const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ── Session — copied exactly from fetch-profile-stats.js ─────────────────────

let sessionCookie  = null;
let sessionPromise = null;

const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
        resolve({ status: res.statusCode, headers, text: () => Promise.resolve(rawBody), json: () => Promise.resolve(JSON.parse(rawBody)) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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
        const get = (name) => parts.find(c => c.startsWith(name + '=')) || null;
        const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
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

// ── Query — copied exactly from fetch-profile-stats.js ───────────────────────

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

async function fetchProfile(uuid) {
  if (!sessionCookie) await refreshSession();
  const res = await doFetch(API_URL, {
    method:  'POST',
    headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
    body:    JSON.stringify({ ...PROFILE_QUERY, variables: { profileID: uuid } }),
  });
  if (res.status === 403) {
    const text = await res.text();
    if (text.includes('DOCTYPE') || text.includes('Request blocked')) return { status: 'blocked' };
    return { status: 'private' };
  }
  if (res.status < 200 || res.status >= 300) return { status: 'error', code: res.status };
  const json = await res.json();
  if (json.errors?.length) return { status: 'graphql-error', msg: json.errors[0]?.message };
  if (!json.data?.publicProfileStatistics) return { status: 'inaccessible' };
  return { status: 'ok', data: json.data };
}

// ── Team lookup ───────────────────────────────────────────────────────────────

const _shards = {};
function lookupTeam(tid) {
  if (!tid) return null;
  const prefix = tid.slice(0, 2);
  if (!_shards[prefix]) {
    const f = path.join(LOOKUP_DIR, prefix + '.json');
    try { _shards[prefix] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; } catch { _shards[prefix] = {}; }
  }
  return _shards[prefix][tid] || null;
}

// ── Game file loader — no cache, discard after use to avoid OOM ──────────────

function loadGf(sid) {
  const f = path.join(GAMES_DIR, sid + '.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// ── Find ambiguous players ────────────────────────────────────────────────────
// Two-step to avoid loading all game files into memory at once:
// Step 1 — scan player files only for candidates with multiple tids per season.
// Step 2 — for each candidate, load its game files one at a time to confirm.

console.log('Step 1: finding candidates with multiple tids per season…');
const candidates = [];
const prefixes   = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();

for (const prefix of prefixes) {
  const dir = path.join(PLAYERS_DIR, prefix);
  for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
    const uuid = fname.replace('.json', '');
    let player;
    try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
    if (!player.sports?.Basketball || !(player.seasons?.length > 0)) continue;
    const hasMulti = player.seasons.some(s =>
      allSids.has(s.sid) &&
      new Set((s.regs||[]).map(r=>r.tid).filter(Boolean)).size > 1
    );
    if (hasMulti) candidates.push({ uuid, name: player.name, storedSeasons: player.seasons });
  }
}
console.log(`  ${candidates.length} candidates with multi-tid seasons.`);

// Step 2: scan game files once, check all candidates per game.
// Build sid → { uuid → Set<tid> } from candidates so lookup is O(1).
console.log('Step 2: scanning game files once to confirm ambiguity…');

// Build index: sid → Map<uuid, Set<tid>>
const sidUuidTids = new Map(); // sid → Map<uuid, Set<tid>>
for (const { uuid, storedSeasons } of candidates) {
  for (const season of storedSeasons) {
    if (!allSids.has(season.sid)) continue;
    const tids = new Set((season.regs||[]).map(r=>r.tid).filter(Boolean));
    if (tids.size <= 1) continue;
    if (!sidUuidTids.has(season.sid)) sidUuidTids.set(season.sid, new Map());
    sidUuidTids.get(season.sid).set(uuid, tids);
  }
}

const confirmedAmbiguous = new Set();
let sidesScanned = 0;
for (const [sid, uuidTids] of sidUuidTids) {
  const gf = loadGf(sid);
  if (!gf) continue;
  sidesScanned++;
  if (sidesScanned % 100 === 0) process.stdout.write('  Scanned ' + sidesScanned + '/' + sidUuidTids.size + ' seasons\r');
  for (const g of Object.values(gf.games||{})) {
    // For each player in this game, check if they're a candidate for this sid
    const allInGame = [
      ...(g.p||[]).map(x=>x.id),
      ...(g.hp||[]).map(x=>x.profileID),
      ...(g.ap||[]).map(x=>x.profileID),
    ].filter(Boolean);
    for (const uuid of allInGame) {
      if (confirmedAmbiguous.has(uuid)) continue;
      const tids = uuidTids.get(uuid);
      if (!tids) continue;
      if (tids.has(g.h) && tids.has(g.a)) confirmedAmbiguous.add(uuid);
    }
  }
}
console.log('  Scanned ' + sidesScanned + ' seasons. ' + confirmedAmbiguous.size + ' confirmed ambiguous.');

const candidateMap = new Map(candidates.map(c => [c.uuid, c]));
const ambiguous = [...confirmedAmbiguous].map(uuid => candidateMap.get(uuid)).filter(Boolean);

console.log(`Found ${ambiguous.length} ambiguous players. Fetching fresh API data…\n`);

// ── Fetch and compare ─────────────────────────────────────────────────────────

async function main() {
  await refreshSession();

  for (const { uuid, name, storedSeasons } of ambiguous) {
    console.log('═'.repeat(70));
    console.log(`UUID: ${uuid}  name=${name || '(private)'}`);

    const result = await fetchProfile(uuid);
    if (result.status !== 'ok') {
      console.log(`  API result: ${result.status}${result.msg ? ' — ' + result.msg : ''}`);
      console.log();
      continue;
    }

    const seasonStats = result.data.publicProfileStatistics.seasonStatistics;

    // Build API view: sid → { tid → { gradeName, gameCount } }
    const apiSids = new Map();
    for (const season of (seasonStats || [])) {
      for (const reg of (season.statistics || [])) {
        const sid = reg?.season?.id;
        if (!sid) continue;
        for (const teamStat of (reg.teamStatistics || [])) {
          const tid  = teamStat.team?.id;
          const tname = teamStat.team?.name || '?';
          if (!tid) continue;
          for (const gradeStat of (teamStat.gradeStatistics || [])) {
            const gname = gradeStat.grade?.name || '?';
            const gameCount = gradeStat.gameStatistics?.length || 0;
            if (!apiSids.has(sid)) apiSids.set(sid, new Map());
            const tidMap = apiSids.get(sid);
            if (!tidMap.has(tid)) tidMap.set(tid, { tname, gname, gameCount });
            else tidMap.get(tid).gameCount += gameCount;
          }
        }
      }
    }

    // Show only seasons that are ambiguous in stored data
    for (const storedSeason of storedSeasons) {
      const sid  = storedSeason.sid;
      const tids = new Set((storedSeason.regs || []).map(r => r.tid).filter(Boolean));
      if (tids.size <= 1) continue;
      if (!allSids.has(sid)) continue;

      // Check if actually ambiguous
      const gf = loadGf(sid);
      if (!gf) continue;
      let isAmbig = false;
      for (const g of Object.values(gf.games || {})) {
        const inGame = (g.p||[]).some(x=>x.id===uuid)||(g.hp||[]).some(x=>x.profileID===uuid)||(g.ap||[]).some(x=>x.profileID===uuid);
        if (inGame && tids.has(g.h) && tids.has(g.a)) { isAmbig = true; break; }
      }
      if (!isAmbig) continue;

      const sn = sportsIndex.seasons?.[sid]?.name || sid;
      console.log(`\n  Season: ${sn} (${sid})`);

      // Stored regs
      console.log(`  STORED regs (${storedSeason.regs.length}):`);
      for (const reg of storedSeason.regs) {
        const t = lookupTeam(reg.tid);
        console.log(`    tid=${reg.tid}  gp=${reg.stats?.gp||0}  team="${t?.name||'?'}"  grade="${t?.gn||'?'}"`);
      }

      // API regs for same season
      const apiTidMap = apiSids.get(sid);
      if (!apiTidMap || apiTidMap.size === 0) {
        console.log(`  API regs: (none returned for this season)`);
      } else {
        console.log(`  API regs (${apiTidMap.size}):`);
        for (const [tid, info] of apiTidMap) {
          const stored = storedSeason.regs.find(r => r.tid === tid);
          const flag = stored ? '' : '  ← NEW (not in stored data)';
          console.log(`    tid=${tid}  games=${info.gameCount}  team="${info.tname}"  grade="${info.gname}"${flag}`);
        }
        // Check for stored tids missing from API
        for (const reg of storedSeason.regs) {
          if (!apiTidMap.has(reg.tid)) {
            console.log(`    tid=${reg.tid}  ← IN STORED DATA but NOT in API response`);
          }
        }
      }
    }
    console.log();
    await sleep(500);
  }

  console.log('═'.repeat(70));
  console.log('Done.');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
