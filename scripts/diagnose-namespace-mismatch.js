// scripts/diagnose-namespace-mismatch.js
//
// DRY-RUN / READ-ONLY diagnostic (no writes, no commits, no data-write lock).
// Phase 0 of the phantom-UUID fix: the spectator endpoint (spectator.playhq.com
// game(id)) and the api endpoint (api.playhq.com) sometimes issue DIFFERENT
// profile ids for the same real player. We only ever capture and store the
// spectator-namespace id, then feed it to publicProfileStatistics (api namespace),
// where a diverged player comes back NOT_FOUND and is falsely marked "private".
//
// This script does NOT change anything. It answers two questions before any
// production script is touched:
//
//   JOB 1 — Does the recovery mechanism actually work? Validates the 3 players
//     confirmed by hand:
//       (a) publicProfileStatistics(spectatorId) must be NOT_FOUND (id is dead
//           in the api namespace),
//       (b) publicProfileStatistics(apiId) must return data (id is live),
//       (c) gradePlayerStatistics(grade of game a2e4b6c2) + team.id/name match
//           must recover exactly the expected apiId.
//     If (b)/(c) fail, the whole approach is wrong and nothing downstream ships.
//
//   JOB 2 — How big is the problem? Over a sample of private:true players,
//     attempts recovery (gradePlayerStatistics by reg tid+name, profileSearch
//     fallback), verifies any recovered id actually resolves, and tallies
//     recoverable-vs-genuinely-private so we can decide whether a full re-pass
//     is worth running.
//
// Queries are copied verbatim, never hand-written:
//   - session recipe + doFetch + ProfileSeasonStatistics : from fetch-profile-stats.js
//   - gradePlayerStatistics + profileSearch               : from playhq_api_reference.md
//                                                           (via lib/namespace-resolve.cjs)
//   - spectator game(id)                                  : from nightly-crawl.js
//
// Usage:
//   node scripts/diagnose-namespace-mismatch.js --sample-shards=00,01 --max-per-shard=50
//   node scripts/diagnose-namespace-mismatch.js --known-only

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
const {
  GRADE_PLAYERS_QUERY, PROFILE_SEARCH_QUERY,
  matchFromGrade, matchFromSearch, isPlaceholderName,
} = require('./lib/namespace-resolve.cjs');

const ROOT             = path.join(__dirname, '..');
const GAMES_DIR        = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR      = path.join(ROOT, 'players');
const SPORT_INDEX_FILE = path.join(ROOT, 'data', 'sports-index.json');

// ─── CLI ────────────────────────────────────────────────────────────────────
const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const SAMPLE_SHARDS = String(ARGS['sample-shards'] || '00,01')
  .split(',').map(s => s.trim().toLowerCase()).filter(s => /^[0-9a-f]{2}$/.test(s));
const MAX_PER_SHARD = Math.max(1, parseInt(ARGS['max-per-shard'] || '50', 10));
const KNOWN_ONLY    = !!ARGS['known-only'];

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';

// The three players confirmed diverged by hand (from the session prompt).
const KNOWN = [
  { name: 'William Mallen', spectatorId: '9c8403ae-23cd-4a79-a852-a495ad0ce7a9', apiId: '50705b28-20b1-4fcd-bed4-fa01f90f3d87' },
  { name: 'Charlie Raynor', spectatorId: '408c3c6e-67c3-46fb-8d79-0a38ce6c3447', apiId: '69e32567-5a8d-425d-8fda-6f654d29ab7e' },
  { name: 'Jack Delaney',   spectatorId: '0000ed35-3510-4267-bf4f-db65588b6d99', apiId: '1cf5a2ba-98c0-43d6-b1dd-9c3dbb2251c5' },
];
const KNOWN_SEASON = '81545684';
const KNOWN_GAME   = 'a2e4b6c2';

let sportIndex = { seasons: {} };
try { sportIndex = JSON.parse(fs.readFileSync(SPORT_INDEX_FILE, 'utf8')); } catch (_) {}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP transport (copied from fetch-profile-stats.js) ──────────────────────
// keepAlive:false forces a new TCP connection per request.
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

// ─── api session (copied from fetch-profile-stats.js) ─────────────────────────
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
let apiCookie = null, apiPromise = null;
async function refreshApiSession() {
  if (apiPromise) return apiPromise;
  apiPromise = (async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (attempt > 1) await sleep(attempt * 5000);
      for (const body of COOKIE_QUERIES) {
        const res = await doFetch(API_URL, {
          headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() },
          body:    JSON.stringify(body),
        });
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

// ─── spectator session (copied from nightly-crawl.js — cookie acquired via the
// main api HEADERS_BASE, then used against spectator with HEADERS_SPECTATOR) ───
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

// ─── publicProfileStatistics (query copied verbatim from fetch-profile-stats.js) ─
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

const REFRESH_EVERY = 30; // publicProfileStatistics JWT quota — refresh every 30 of THOSE calls
let profileCallCount = 0;

// Returns { status: 'ok'|'not-found'|'blocked'|'error', data }.
async function publicProfileStatistics(profileID) {
  if (!apiCookie) await refreshApiSession();
  if (profileCallCount > 0 && profileCallCount % REFRESH_EVERY === 0) {
    apiCookie = null; await refreshApiSession();
  }
  profileCallCount++;
  const body = { ...PROFILE_QUERY, variables: { profileID } };
  let res;
  try {
    res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': apiCookie }, body: JSON.stringify(body) });
  } catch (err) { return { status: 'error', data: null }; }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { status: 'blocked', data: null };
    return { status: 'not-found', data: null }; // application 403 = inaccessible
  }
  if (!res.ok) return { status: 'error', data: null };
  let json; try { json = await res.json(); } catch (_) { return { status: 'error', data: null }; }
  if (json.errors && json.errors.length) {
    const msg = json.errors[0]?.message || '';
    if (msg.includes('NOT_FOUND') || msg.includes('failed to find profile')) return { status: 'not-found', data: null };
    return { status: 'error', data: null };
  }
  const data = json.data || json;
  if (!data?.publicProfileStatistics) return { status: 'not-found', data: null };
  return { status: 'ok', data };
}

// gradePlayerStatistics — returns { status, results }.
async function gradePlayers(gradeID) {
  if (!apiCookie) await refreshApiSession();
  const body = { operationName: 'GradePlayerStatistics', variables: { gradeID }, query: GRADE_PLAYERS_QUERY };
  let res;
  try {
    res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': apiCookie }, body: JSON.stringify(body) });
  } catch (_) { return { status: 'error', results: [] }; }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { status: 'blocked', results: [] };
    return { status: 'error', results: [] };
  }
  if (!res.ok) return { status: 'error', results: [] };
  let json; try { json = await res.json(); } catch (_) { return { status: 'error', results: [] }; }
  if (json.errors && json.errors.length) return { status: 'error', results: [] };
  return { status: 'ok', results: (json.data || json)?.gradePlayerStatistics?.results || [] };
}

// profileSearch — returns { status, result }.
async function profileSearchLookup(fullName) {
  if (!apiCookie) await refreshApiSession();
  const body = { operationName: 'ProfileSearch', variables: { fullName }, query: PROFILE_SEARCH_QUERY };
  let res;
  try {
    res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': apiCookie }, body: JSON.stringify(body) });
  } catch (_) { return { status: 'error', result: [] }; }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { status: 'blocked', result: [] };
    return { status: 'error', result: [] };
  }
  if (!res.ok) return { status: 'error', result: [] };
  let json; try { json = await res.json(); } catch (_) { return { status: 'error', result: [] }; }
  if (json.errors && json.errors.length) return { status: 'error', result: [] };
  return { status: 'ok', result: (json.data || json)?.profileSearch?.result || [] };
}

// spectator game(id) — query copied verbatim from nightly-crawl.js.
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

// ─── Recovery routine ─────────────────────────────────────────────────────────
// candidateRegs: [{ gid, tid }] (gid/tid may be missing on some regs).
// Returns { apiId, via } where via ∈ grade|search|grade-ambiguous|none|no-name|blocked.
async function resolveApiId({ name, regs, orgId }) {
  if (isPlaceholderName(name)) return { apiId: null, via: 'no-name' };
  const gids = [...new Set(regs.map(r => r.gid).filter(Boolean))];
  const found = new Set();
  for (const gid of gids) {
    const g = await gradePlayers(gid);
    if (g.status === 'blocked') return { apiId: null, via: 'blocked' };
    for (const r of regs.filter(r => r.gid === gid && r.tid)) {
      const m = matchFromGrade(g.results, { name, tid: r.tid });
      if (m) found.add(m);
    }
  }
  if (found.size === 1) return { apiId: [...found][0], via: 'grade' };
  if (found.size > 1)  return { apiId: null, via: 'grade-ambiguous' };
  const sr = await profileSearchLookup(name);
  if (sr.status === 'blocked') return { apiId: null, via: 'blocked' };
  const m = matchFromSearch(sr.result, { name, orgId });
  return m ? { apiId: m, via: 'search' } : { apiId: null, via: 'none' };
}

// Pull candidate (gid, tid) pairs and an org id from a player file.
function regsFromPlayer(player) {
  const regs = [];
  let orgId = null;
  for (const s of (player.seasons || [])) {
    const si = sportIndex.seasons?.[s.sid];
    if (!orgId && si?.orgId) orgId = si.orgId;
    for (const r of (s.regs || [])) {
      regs.push({ gid: r.gid || null, tid: r.tid || null });
    }
  }
  return { regs, orgId };
}

// ─── JOB 1: known-case validation ──────────────────────────────────────────────
async function runKnownCases() {
  console.log('\n══ JOB 1 — known-case validation ══════════════════════════════');
  await refreshApiSession();

  console.log('\n  (a/b) publicProfileStatistics on each stored (spectator) id vs expected (api) id:');
  for (const k of KNOWN) {
    const dead = await publicProfileStatistics(k.spectatorId);
    const live = await publicProfileStatistics(k.apiId);
    const okDead = dead.status === 'not-found';
    const okLive = live.status === 'ok';
    console.log(`    ${k.name}`);
    console.log(`      spectator id ${k.spectatorId} -> ${dead.status.padEnd(9)} ${okDead ? 'PASS (dead in api ns, as expected)' : 'UNEXPECTED'}`);
    console.log(`      api id       ${k.apiId} -> ${live.status.padEnd(9)} ${okLive ? 'PASS (resolves)' : 'FAIL (does not resolve!)'}`);
  }

  console.log('\n  (c) gradePlayerStatistics recovery for game ' + KNOWN_GAME + ' (season ' + KNOWN_SEASON + '):');
  let gf = null;
  try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${KNOWN_SEASON}.json`), 'utf8')); } catch (_) {}
  const game = gf?.games?.[KNOWN_GAME] || null;
  if (!game) {
    console.log('    ⚠ game file not checked out or game not present — skipping (c).');
    console.log('      (add games/bv/' + KNOWN_SEASON + '.json to the workflow checkout to enable this check.)');
    return;
  }
  const gradeId = game.gid || null;
  console.log(`    grade for this game (g.gid): ${gradeId || '(none)'}   home tid=${game.h}  away tid=${game.a}`);
  if (!gradeId) { console.log('    ⚠ no grade id on game entry — cannot run (c).'); return; }

  const spec = await gqlSpectator(KNOWN_GAME);
  const homeIds = new Set((spec?.statistics?.home?.players || []).map(p => p.profileID));
  const awayIds = new Set((spec?.statistics?.away?.players || []).map(p => p.profileID));

  const g = await gradePlayers(gradeId);
  if (g.status !== 'ok') { console.log(`    ⚠ gradePlayerStatistics returned status=${g.status} — cannot run (c).`); return; }
  console.log(`    gradePlayerStatistics returned ${g.results.length} results (cap 50).`);

  for (const k of KNOWN) {
    let tid = null;
    if (homeIds.has(k.spectatorId)) tid = game.h;
    else if (awayIds.has(k.spectatorId)) tid = game.a;
    const m = matchFromGrade(g.results, { name: k.name, tid });
    const ok = m && m === k.apiId;
    console.log(`    ${k.name}: side tid=${tid || '(not found in spectator box score)'}  matched=${m || 'null'}  ${ok ? 'PASS (== expected api id)' : (m ? 'MISMATCH vs expected!' : 'no grade match (would need profileSearch fallback)')}`);
  }
}

// ─── JOB 2: scope estimate over sampled private players ──────────────────────────
async function runScopeScan() {
  console.log('\n══ JOB 2 — scope estimate over private:true players ═════════════');
  console.log(`  Sample shards: ${SAMPLE_SHARDS.join(', ')}   max private probed/shard: ${MAX_PER_SHARD}`);
  await refreshApiSession();

  const tally = { probed: 0, grade: 0, search: 0, gradeAmbiguous: 0, none: 0, noName: 0, noGradeContext: 0, recoveredButDead: 0, blocked: 0 };

  for (const shard of SAMPLE_SHARDS) {
    const dir = path.join(PLAYERS_DIR, shard);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (_) { console.log(`  shard ${shard}: directory not present, skipping.`); continue; }
    let probedThisShard = 0, privateSeen = 0;
    for (const f of files) {
      if (probedThisShard >= MAX_PER_SHARD) break;
      let player; try { player = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
      if (player.private !== true) continue;
      privateSeen++;
      const uuid = f.replace(/\.json$/, '');
      const { regs, orgId } = regsFromPlayer(player);
      const hasGradeCtx = regs.some(r => r.gid && r.tid);
      if (!hasGradeCtx) tally.noGradeContext++;

      const res = await resolveApiId({ name: player.name, regs, orgId });
      probedThisShard++; tally.probed++;

      if (res.via === 'blocked') { tally.blocked++; console.log('  ⛔ CloudFront block during scan — stopping scope scan early.'); printScope(tally); return; }
      if (res.via === 'no-name') { tally.noName++; continue; }
      if (res.via === 'grade-ambiguous') { tally.gradeAmbiguous++; continue; }
      if (!res.apiId) { tally.none++; continue; }
      if (res.apiId === uuid) { tally.none++; continue; } // not actually diverged

      // Verify the recovered id actually resolves before counting it recoverable.
      const check = await publicProfileStatistics(res.apiId);
      if (check.status === 'ok') { tally[res.via]++; }
      else if (check.status === 'blocked') { tally.blocked++; console.log('  ⛔ CloudFront block during verify — stopping.'); printScope(tally); return; }
      else { tally.recoveredButDead++; }
    }
    console.log(`  shard ${shard}: ${privateSeen} private seen, ${probedThisShard} probed`);
  }
  printScope(tally);
}

function printScope(t) {
  const recoverable = t.grade + t.search;
  console.log('\n  ── scope result ─────────────────────────────');
  console.log(`    private players probed        : ${t.probed}`);
  console.log(`    recoverable via gradePlayers  : ${t.grade}`);
  console.log(`    recoverable via profileSearch : ${t.search}`);
  console.log(`    RECOVERABLE (total)           : ${recoverable}  (${t.probed ? Math.round(recoverable / t.probed * 100) : 0}% of probed)`);
  console.log(`    genuinely private / no match  : ${t.none}`);
  console.log(`    ambiguous grade match (bailed): ${t.gradeAmbiguous}`);
  console.log(`    placeholder name (unmatchable): ${t.noName}`);
  console.log(`    had NO grade context on file  : ${t.noGradeContext}`);
  console.log(`    recovered id itself was dead  : ${t.recoveredButDead}`);
  console.log(`    cloudfront blocks             : ${t.blocked}`);
  console.log('  ─────────────────────────────────────────────');
  console.log('  NOTE: extrapolate RECOVERABLE% across ~all private players to size a full re-pass.');
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('diagnose-namespace-mismatch.js  (READ-ONLY — no writes, no commits)');
  console.log('─'.repeat(64));
  await runKnownCases();
  if (!KNOWN_ONLY) await runScopeScan();
  console.log('\nDone (nothing was written).');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
