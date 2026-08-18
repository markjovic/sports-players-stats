// scripts/probe-alias-stats.js
//
// READ-ONLY. No writes, no git, no lock. Sizes ONE question:
//
//   When a player carries spectator aliases, does PlayHQ credit games to those
//   ALIAS profiles that we never count, because fetch-profile-stats.js queries
//   only ONE identity?
//
// WHY (2026-08-16). Lara Hansen, api id 2cd399a3: our record holds 368 games,
// her api profile credits 15, and her alias 33125d97 — already recorded in her
// own spectatorIds — credits 357. fetch-profile-stats.js line 839 reads
// `const queryId = player.apiId || uuid;` and never fetches an alias. So every
// player whose appearances are split across two identities has an understated
// career total, which:
//   · inflates size-negative-gap's "more games than PlayHQ credits" population
//     (26,834 players, 57,953 appearances) for no real reason, and
//   · understates the gap used to RANK the repair campaign, so such players may
//     never have entered a worklist at all.
//
// 15 + 357 = 372 against 368 held. Four unaccounted for. That is why this probe
// compares GAME-ID SETS and never sums totals: summing double-counts any game
// both identities credit, and the union is exact.
//
// THE OBSTACLE, AND WHY IT IS NOT A NAME MATCH. spectatorIds are stored
// TRUNCATED at 13 chars ("33125d97-2f97"), and PlayHQ needs a full uuid. So the
// full id is recovered via profileSearch on the player's name — but a returned
// profile is only accepted when its first 13 chars EQUAL a stored alias. That is
// an exact id comparison; the name only narrows the search space. Two people
// sharing a name cannot be conflated by it.
//
// Usage:
//   node scripts/probe-alias-stats.js                       # 400 players
//   node scripts/probe-alias-stats.js --sample=1000 --concurrency=4
//
// NO setup-node in the workflow (this fetches api.playhq.com — absolute rule).

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
// Required, not retyped: this lib is the authority for the search query and the
// match helper, and it is what fetch-profile-stats.js itself uses.
const { PROFILE_SEARCH_QUERY } = require('./lib/namespace-resolve.cjs');
const { TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const num = (flag, dflt) => {
  const a = args.find(x => x.startsWith('--' + flag + '='));
  const v = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const SAMPLE      = num('sample', 400);
const CONCURRENCY = Math.max(1, Math.min(8, num('concurrency', 4)));
const SEED        = num('seed', 20260816);
// Named players, comma-separated. Run the KNOWN-TRUE case first and confirm the
// tool reproduces it before believing anything a sample says. The first run lost
// 318 of 400 players to unrecorded failures and still printed a percentage.
const ONLY = (args.find(x => x.startsWith('--uuid=')) || '').split('=')[1] || '';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Deterministic sampling so a re-run examines the SAME players and the numbers
// can be compared between dispatches rather than merely re-rolled.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Counted HERE, not in the copied stack — the stack carries no counter, which is
// why the first run reported 82 requests after making roughly 480.
let requestCount = 0;

// Every failure is tallied BY STATUS with examples. A bare failure count cannot
// tell a private profile from a CloudFront block, and those mean opposite things:
// one is an answer about that player, the other means we were throttled and the
// sample is void.
const tally = new Map();
const tallyEx = new Map();
function note(key, example) {
  tally.set(key, (tally.get(key) || 0) + 1);
  if (!tallyEx.has(key)) tallyEx.set(key, []);
  const arr = tallyEx.get(key);
  if (arr.length < 5 && example) arr.push(example);
}
function showTally(heading) {
  console.log('  ' + heading);
  const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  if (!rows.length) { console.log('    (none)'); return; }
  for (const [k, v] of rows) {
    console.log('    ' + String(v).padStart(6) + '  ' + k);
    for (const ex of (tallyEx.get(k) || [])) console.log('             e.g. ' + ex);
  }
}

const API_URL = 'https://api.playhq.com/graphql';
let sessionCookie = null;
let sessionPromise = null;

const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};


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

  // 2026-07-30 — TWO bugs fixed here, both exposed by a 413k forced sweep:
  //
  // (1) A socket-level failure ESCAPED the 10-attempt loop entirely. The retry
  //     loop only ever retried the "response arrived but carried no usable
  //     cookies" case (`continue`). An exception from doFetch — ECONNRESET,
  //     socket hang up, DNS — propagated out of BOTH for-loops, rejected the
  //     promise and killed the shard with `FATAL: read ECONNRESET`. A normal
  //     nightly refreshes a handful of times; a forced sweep refreshes every 28
  //     batches across 256 shards, so a rare reset became near-certain somewhere.
  //     Network errors are now caught per request and treated as a failed
  //     attempt, so all 10 attempts are actually used.
  //
  // (2) `sessionPromise` was NOT cleared on the throw path — the assignment at
  //     the end of the loop was skipped when doFetch threw, leaving a REJECTED
  //     promise cached in the lock. Every later refreshSession() would return
  //     that same rejected promise from the `if (sessionPromise)` fast path, so
  //     the shard could never recover even if the caller retried. Now cleared in
  //     a `.finally()`, which runs on success, throw AND rejection.
  sessionPromise = (async () => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (attempt > 1) await sleep(attempt * 5000);
      for (const body of COOKIE_QUERIES) {
        let res;
        try {
          res = await doFetch(API_URL, {
            method:  'POST',
            headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() },
            body:    JSON.stringify(body),
          });
        } catch (err) {
          lastErr = err;
          console.log(`  … session refresh attempt ${attempt} network error: ${err.code || err.message} — retrying`);
          continue;
        }
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
        // NOTE: the exact string "Session refreshed (attempt N)" is used as
        // verification evidence in OUTSTANDING §A — do not reword it.
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    }
    throw new Error(`Failed to obtain session cookie after 10 attempts${lastErr ? ` (last network error: ${lastErr.code || lastErr.message})` : ''}`);
  })().finally(() => { sessionPromise = null; });

  return sessionPromise;
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

// 2026-08-14 — THIS FUNCTION HAD NO TIMEOUT, AND THAT HUNG A RUN FOR GOOD.
// `req.on('error')` catches a socket that FAILS. It does not catch a socket that
// opens and then goes silent — which is what a CloudFront throttle or a dropped
// connection looks like from here. No 'error', no 'end', so the promise never
// settled, and Node sets no default timeout on https.request. The min-gap=1 run
// stopped dead at 5,752 of 10,000 and sat there until it was killed.
//
// Sequential code had the same hole; running eight fetches in one Promise.all
// only made it eight times more likely to be hit, because ONE silent socket
// stalls the whole chunk and therefore the whole run.
//
// Two timers, because they catch different failures. IDLE fires when the socket
// goes quiet for 45s — the throttle case. HARD is an absolute ceiling on the
// whole request, for a response that dribbles bytes slowly enough to keep
// resetting the idle timer but never finishes. Both destroy the request, which
// raises 'error' and rejects, and `finish` guarantees the promise settles
// exactly once no matter which path gets there first.
const IDLE_TIMEOUT_MS = 45 * 1000;
const HARD_TIMEOUT_MS = 180 * 1000;

// doFetch: wraps https.request with keepAlive:false to force a new TCP connection
// per request. This prevents CloudFront per-connection rate limiting.
function doFetch(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body   = options.body || '';
    let settled = false;
    let hardTimer = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      fn(v);
    };
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  { ...options.headers, 'content-length': Buffer.byteLength(body) },
      agent:    new https.Agent({ keepAlive: false }),
      timeout:  IDLE_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        // Build a headers.get() shim matching the Fetch API.
        // Node's https module stores set-cookie as an array; join with ', '
        // so our existing cookie-parsing code works unchanged.
        const hdrs = res.headers;
        const headers = {
          get(name) {
            const val = hdrs[name.toLowerCase()];
            if (val === undefined || val === null) return null;
            return Array.isArray(val) ? val.join(', ') : val;
          },
        };
        finish(resolve, {
          status:  res.statusCode,
          ok:      res.statusCode >= 200 && res.statusCode < 300,
          headers,
          text:    () => Promise.resolve(rawBody),
          json:    () => Promise.resolve(JSON.parse(rawBody)),
        });
      });
      res.on('error', (e) => finish(reject, e));
    });
    req.on('timeout', () => {
      const e = new Error(`request idle for ${IDLE_TIMEOUT_MS / 1000}s`);
      e.code = 'ETIMEDOUT';
      req.destroy(e);
    });
    req.on('error', (e) => finish(reject, e));
    hardTimer = setTimeout(() => {
      const e = new Error(`request exceeded ${HARD_TIMEOUT_MS / 1000}s`);
      e.code = 'ETIMEDOUT';
      try { req.destroy(e); } catch (_) { /* already gone */ }
      finish(reject, e);
    }, HARD_TIMEOUT_MS);
    req.write(body);
    req.end();
  });
}


async function fetchProfile(profileID) {
  if (!sessionCookie) await refreshSession();
  const body = { ...PROFILE_QUERY, variables: { profileID } };
  let res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // A timeout gets its own status so the log says "this request never came
    // back" rather than the catch-all "error". Both are transport, both are
    // retried, but only one of them tells you the endpoint went quiet on you.
    return { status: err && err.code === 'ETIMEDOUT' ? 'timeout' : 'error', err };
  }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch {}
    if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { status: 'cloudfront-block' };
    return { status: 'private' };
  }
  if (res.status === 404) return { status: 'notfound' };
  if (!res.ok) return { status: `http-${res.status}` };
  let json; try { json = await res.json(); } catch (e) { return { status: 'bad-json' }; }
  if (json.errors) return { status: 'gql-error', errors: json.errors };
  return { status: 'ok', data: json.data };
}


// ─── profileSearch: recover a FULL uuid for a truncated alias ────────────────
async function profileSearchLookup(fullName) {
  if (!sessionCookie) await refreshSession();
  requestCount++;
  const body = { operationName: 'ProfileSearch', variables: { fullName }, query: PROFILE_SEARCH_QUERY };
  let res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify(body),
    });
  } catch (err) { return { status: 'error', err }; }
  if (res.status === 403) return { status: 'blocked' };
  if (!res.ok) return { status: 'error', err: new Error('HTTP ' + res.status) };
  let json;
  try { json = await res.json(); } catch (err) { return { status: 'error', err }; }
  if (json.errors && json.errors.length) return { status: 'error', err: new Error(json.errors[0]?.message || 'gql') };
  return { status: 'ok', result: ((json.data || json)?.profileSearch?.result) || [] };
}

// Every game id a profile is credited with. A SET, never a total — see the
// header on why summing is the wrong operation.
function creditedGids(data) {
  const out = new Set();
  for (const season of (data?.publicProfileStatistics?.seasonStatistics || [])) {
    for (const reg of (season.statistics || [])) {
      for (const ts of (reg.teamStatistics || [])) {
        for (const gs of (ts.gradeStatistics || [])) {
          for (const g of (gs.gameStatistics || [])) {
            if (g?.game?.id) out.add(g.game.id);
          }
        }
      }
    }
  }
  return out;
}

async function main() {
  console.log('probe-alias-stats [READ-ONLY] — sample=' + SAMPLE + ' concurrency=' + CONCURRENCY + ' seed=' + SEED);

  // ── Find players carrying a REAL alias (one that is not just their own id) ──
  const playersDir = path.join(ROOT, 'players');
  const candidates = [];
  let scanned = 0, withAlias = 0;
  for (const shard of fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d))) {
    const dir = path.join(playersDir, shard);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      scanned++;
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const uuid = f.replace(/\.json$/, '');
      const canonical = p.apiId || uuid;
      const self = canonical.slice(0, TRUNC_LEN);
      const aliases = (Array.isArray(p.spectatorIds) ? p.spectatorIds : []).filter(x => x && x !== self);
      if (!aliases.length) continue;
      withAlias++;
      candidates.push({ uuid, canonical, name: p.name || '', aliases,
                        held: Array.isArray(p.games) ? p.games.length : 0,
                        gp: Object.values(p.sports || {}).reduce((a, s) => a + (Number(s?.gp) || 0), 0),
                        priv: p.private === true });
    }
  }
  console.log('  player files scanned            : ' + scanned.toLocaleString());
  console.log('  carrying a non-self alias       : ' + withAlias.toLocaleString() + '  (' + (100 * withAlias / (scanned || 1)).toFixed(1) + '%)');
  if (!candidates.length) { console.log('  nothing to sample'); return; }

  if (ONLY) {
    const want = new Set(ONLY.split(',').map(x => x.trim()).filter(Boolean));
    const picked = candidates.filter(c => want.has(c.uuid));
    for (const m of [...want].filter(u => !picked.some(c => c.uuid === u))) {
      console.log('  ⚠ --uuid ' + m + ' is not in players/ or carries no non-self alias');
    }
    if (!picked.length) { console.log('  nothing to probe'); return; }
    console.log('  --uuid mode: probing ' + picked.length + ' named player(s)\n');
    await run(picked);
    return;
  }

  const rnd = mulberry32(SEED);
  const pool = candidates.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const targets = pool.slice(0, SAMPLE);
  console.log('  sampled                         : ' + targets.length.toLocaleString() + '\n');
  await run(targets);
}

async function run(targets) {
  const rows = [];
  let aliasResolved = 0, aliasUnresolved = 0, searchFailed = 0, canonFailed = 0;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);
    const done = await Promise.all(chunk.map(async (t) => {
      requestCount++;
      const canon = await fetchProfile(t.canonical);
      if (canon.status !== 'ok') {
        note('canonical fetch: ' + canon.status, t.canonical + ' ' + JSON.stringify(t.name));
        return { t, err: 'canonical ' + canon.status };
      }
      const canonGids = creditedGids(canon.data);

      requestCount++;
      const sr = await profileSearchLookup(t.name);
      if (sr.status !== 'ok') {
        note('profileSearch: ' + sr.status, JSON.stringify(t.name));
        return { t, canonGids, err: 'search ' + sr.status };
      }

      // EXACT prefix match against a stored alias. The name only narrowed the
      // search; it never decides identity.
      const wanted = new Set(t.aliases);
      const found = [];
      for (const r of sr.result) {
        const id = r && r.id;
        if (!id) continue;
        if (wanted.has(id.slice(0, TRUNC_LEN))) found.push(id);
      }

      // WHY a match failed is exactly what we could not see last time. Record
      // what the search returned against what we were looking for.
      if (!found.length) {
        note('alias not matched (search returned ' + (sr.result.length === 0 ? 'NOTHING' : sr.result.length + ' profiles') + ')',
             JSON.stringify(t.name) + ' wanted[' + [...wanted].join(',') + '] got[' +
             sr.result.slice(0, 6).map(r => String(r && r.id).slice(0, TRUNC_LEN)).join(',') + ']');
      }

      const aliasGids = new Set();
      const aliasStatus = [];
      for (const id of found) {
        requestCount++;
        const res = await fetchProfile(id);
        if (res.status !== 'ok') note('alias fetch: ' + res.status, id);
        aliasStatus.push(id.slice(0, TRUNC_LEN) + ':' + res.status);
        if (res.status !== 'ok') continue;
        for (const g of creditedGids(res.data)) aliasGids.add(g);
        await sleep(200);
      }
      return { t, canonGids, aliasGids, foundCount: found.length, wantedCount: wanted.size, aliasStatus };
    }));

    for (const d of done) {
      if (d.err && d.err.startsWith('canonical')) { canonFailed++; continue; }
      if (d.err && d.err.startsWith('search')) { searchFailed++; continue; }
      aliasResolved += d.foundCount;
      aliasUnresolved += (d.wantedCount - d.foundCount);
      const union = new Set([...d.canonGids, ...d.aliasGids]);
      const extra = [...d.aliasGids].filter(g => !d.canonGids.has(g)).length;
      const overlap = [...d.aliasGids].filter(g => d.canonGids.has(g)).length;
      rows.push({ ...d.t, canon: d.canonGids.size, alias: d.aliasGids.size,
                  extra, overlap, union: union.size, aliasStatus: d.aliasStatus });
    }
    await sleep(500);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const n = (x) => Number(x || 0).toLocaleString();
  const withExtra = rows.filter(r => r.extra > 0);
  const totExtra = rows.reduce((a, r) => a + r.extra, 0);
  const totOverlap = rows.reduce((a, r) => a + r.overlap, 0);

  console.log('\n════════════════════════════════════════════════');
  console.log('  players probed                  : ' + n(rows.length));
  console.log('  alias ids resolved to a full id : ' + n(aliasResolved));
  console.log('  alias ids NOT found by search   : ' + n(aliasUnresolved) + '   ← unmeasured; the real figure is at least what follows');
  console.log('  canonical fetch failed          : ' + n(canonFailed));
  console.log('  profileSearch failed            : ' + n(searchFailed));
  console.log('');
  showTally('WHY THINGS FAILED (a bare count cannot tell a private profile from a block):');

  // Refuse to state a share when most of the sample never returned. The first
  // run printed "0.0% explained" on 78 of 400 players having fetched no alias.
  const coverage = rows.length / (targets.length || 1);
  if (coverage < 0.5 || aliasResolved === 0) {
    console.log('');
    console.log('  ⚠ THIS RUN DOES NOT ANSWER THE QUESTION.');
    console.log('    probed ' + n(rows.length) + ' of ' + n(targets.length) + ' (' + (100 * coverage).toFixed(0) + '%), aliases fetched: ' + n(aliasResolved) + '.');
    console.log('    Read the failure table above and fix the cause first — a share computed over a');
    console.log('    collapsed sample is not a measurement.');
  }
  console.log('');
  console.log('  players whose ALIAS credits games the canonical does not: ' + n(withExtra.length) +
              '  (' + (100 * withExtra.length / (rows.length || 1)).toFixed(1) + '% of probed)');
  console.log('  uncounted credits found         : ' + n(totExtra));
  console.log('  credits BOTH identities carry   : ' + n(totOverlap) + '   ← exactly what summing the two totals would double-count');

  // Does the union explain the negative gap? This is the point of the probe.
  const before = rows.reduce((a, r) => a + Math.max(0, r.held - r.canon), 0);
  const after  = rows.reduce((a, r) => a + Math.max(0, r.held - r.union), 0);
  console.log('');
  console.log('  DOES THE UNION EXPLAIN THE "MORE GAMES THAN CREDITED" ANOMALY?');
  console.log('    excess measured against the CANONICAL profile only : ' + n(before));
  console.log('    excess measured against the UNION of identities    : ' + n(after));
  if (before > 0) console.log('    → ' + (100 * (before - after) / before).toFixed(1) + '% of the excess in this sample is explained by uncounted alias credits.');

  console.log('\n  WORST 25 BY UNCOUNTED CREDITS:');
  for (const r of rows.sort((a, b) => b.extra - a.extra).slice(0, 25)) {
    console.log('    +' + String(r.extra).padStart(5) + '  ' + r.uuid + '  held=' + r.held +
                ' canon=' + r.canon + ' alias=' + r.alias + ' union=' + r.union + ' overlap=' + r.overlap +
                (r.priv ? ' [PRIVATE]' : '') + '  ' + JSON.stringify(r.name));
    if (r.aliasStatus.length) console.log('           alias fetches: ' + r.aliasStatus.join(' · '));
  }
  console.log('\n  requests made: ' + requestCount);
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
