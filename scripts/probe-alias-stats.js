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
// 2026-08-16, SECOND PASS — THE ALIAS HALF WAS REMOVED, AND WHY.
// The first run tried to recover a full alias uuid via profileSearch on the
// player's name. It resolved 0 of 120, and the diagnostics showed the reason is
// structural, not tuning: EVERY profile the search returned was the player's own
// CANONICAL id ("Emily Shillabeer" wanted 397ece5f-0666, got 3dc5a365-554a —
// her own file). profileSearch indexes the API namespace only; spectator ids are
// not in it. And uuid-prefix.cjs settles the other route — players/aliases maps
// spectatorIdTrunc13 -> full apiId, so the repo stores the alias at 13 chars and
// nowhere at full length. There is no offline route to a full alias id.
//
// So this probe no longer chases aliases. It measures the ONE thing that needs no
// alias and answers the question underneath: does the CANONICAL profile's credit
// count match the games we hold? Of the 78 players the first run did reach, it
// matched almost exactly — 269/269, 346/346, 265/265, 251/251 — which is evidence
// AGAINST a dataset-wide split, and makes Lara Hansen an outlier rather than a
// pattern. This run tests that properly instead of on a collapsed sample.
//
// It also halves the request rate. profileSearch was the second call per player,
// and 78 successes followed by 320 consecutive CloudFront blocks is a burst
// ceiling. One call per player, concurrency 2, and a real pause between chunks.
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
// Capped at 4, not 8: the first run walled at 78 players. One call each now, but
// the ceiling looked like a burst limit rather than a per-request one.
const CONCURRENCY = Math.max(1, Math.min(4, num('concurrency', 2)));
const PAUSE_MS    = num('pause', 1500);
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

      // No profileSearch, no alias fetch. Both are removed, not skipped — see the
      // header. What remains is one call per player and an exact comparison.
      return { t, canonGids, aliasGids: new Set(), foundCount: 0, wantedCount: t.aliases.length, aliasStatus: [] };
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
    await sleep(PAUSE_MS);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const n = (x) => Number(x || 0).toLocaleString();
  const withExtra = rows.filter(r => r.extra > 0);
  const totExtra = rows.reduce((a, r) => a + r.extra, 0);
  const totOverlap = rows.reduce((a, r) => a + r.overlap, 0);

  console.log('\n════════════════════════════════════════════════');
  console.log('  players probed                  : ' + n(rows.length));
  console.log('  canonical fetch failed          : ' + n(canonFailed));
  // Aliases are no longer fetched (see header), so the alias counters that used
  // to print here are gone rather than left showing zero. A zero beside a thing
  // nobody measured reads as a finding.
  console.log('  alias ids carried by these players (NOT fetched): ' + n(rows.reduce((a, r) => a + r.aliases.length, 0)));
  console.log('');
  showTally('WHY THINGS FAILED (a bare count cannot tell a private profile from a block):');

  // Refuse to state a share when most of the sample never returned. The first
  // run printed "0.0% explained" on 78 of 400 players having fetched no alias.
  const coverage = rows.length / (targets.length || 1);
  if (coverage < 0.5) {
    console.log('');
    console.log('  ⚠ THIS RUN DOES NOT ANSWER THE QUESTION.');
    console.log('    probed ' + n(rows.length) + ' of ' + n(targets.length) + ' (' + (100 * coverage).toFixed(0) + '%).');
    console.log('    Read the failure table above and fix the cause first — a share computed over a');
    console.log('    collapsed sample is not a measurement.');
  }
  console.log('');
  // THE MEASUREMENT. held is what our rosters say; canon is what PlayHQ credits
  // the canonical profile with. Equal means there is nothing to explain for that
  // player, whatever aliases they carry.
  const equal  = rows.filter(r => r.held === r.canon).length;
  const short  = rows.filter(r => r.held <  r.canon);   // we are missing appearances
  const excess = rows.filter(r => r.held >  r.canon);   // we hold more than credited
  const bigExcess = excess.filter(r => (r.held - r.canon) > 5);
  console.log('');
  console.log('  HELD GAMES vs WHAT THE CANONICAL PROFILE CREDITS:');
  console.log('    exactly equal                 : ' + n(equal) + '  (' + (100 * equal / (rows.length || 1)).toFixed(1) + '%)');
  console.log('    we hold FEWER than credited   : ' + n(short.length) + '   ← ordinary appearance gap');
  console.log('    we hold MORE than credited    : ' + n(excess.length) + '   ← the size-negative-gap population');
  console.log('      of those, by more than 5    : ' + n(bigExcess.length) + '   ← a Lara-shaped split would land here');
  for (const r of bigExcess.sort((a, b) => (b.held - b.canon) - (a.held - a.canon)).slice(0, 15)) {
    console.log('        +' + String(r.held - r.canon).padStart(5) + '  ' + r.uuid + '  held=' + r.held + ' canon=' + r.canon +
                ' aliases=' + r.aliases.length + (r.priv ? ' [PRIVATE]' : '') + '  ' + JSON.stringify(r.name));
  }
  console.log('');
  console.log('    If "exactly equal" dominates, alias-split career totals are NOT a dataset-wide');
  console.log('    problem and size-negative-gap needs a different explanation. If the big-excess');
  console.log('    group is large, a live spectator box-score fetch to recover full alias ids');
  console.log('    becomes worth building.');
  console.log('\n  requests made: ' + requestCount + '  (one per player probed)');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
