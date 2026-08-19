// scripts/probe-notfound.js
//
// READ-ONLY. No writes, no git, no lock. OUTSTANDING §2.19.
//
// THE QUESTION. On 2026-08-18, 25 of 100 publicProfileTeams calls returned
// `5 NOT_FOUND: failed to find profile`, and a further large minority returned
// FEWER teams than the player file holds — several returning zero for players
// with 1-8 stored registrations. The repair campaign separately retired 637
// players on the identical message. Nobody knows whether that is a handful of
// deleted profiles or a systematic id problem, and until it is measured the
// stored registrations cannot be called sound OR suspect.
//
// THREE THINGS THIS SEPARATES, none of which the last probe could:
//
//   1. IS IT THE ENDPOINT OR THE PROFILE? Each player is asked TWICE — once via
//      publicProfileStatistics (the query the pipeline already lives on) and once
//      via publicProfileTeams. If stats answers and teams does not, the profile
//      exists and the endpoint is the problem. If both fail, the profile is gone.
//
//   2. IS IT THESE PLAYERS OR EVERY PLAYER? A CONTROL group is sampled from
//      players with NO unregistered-team appearances. If the control returns
//      NOT_FOUND at the same rate, 25% is simply the background rate and says
//      nothing about the affected population. Without the control the number is
//      not a measurement — the uncountable-games test on 2026-08-16 produced a
//      confident 59.3%-vs-44.7% "signal" that was entirely squad-size confounding.
//
//   3. WHAT DO THE FAILING PLAYERS LOOK LIKE OFFLINE? private flag, whether gp
//      was ever written, statsChecked age, games held, apiId present. If they
//      share a shape, that names the population.
//
// Usage:
//   node scripts/probe-notfound.js --sample=60
//
// NO setup-node in the workflow (fetches api.playhq.com — absolute rule).

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const num = (f, d) => {
  const a = args.find(x => x.startsWith('--' + f + '='));
  const v = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : d;
};
const SAMPLE = num('sample', 60);
const SEED   = num('seed', 20260819);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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


// ─── publicProfileTeams ───────────────────────────────────────────────────────
// Inline fragment REQUIRED — DiscoverTeam is a union member. The block in
// playhq_api_reference.md omitted it until 2026-08-18 and cost three dispatches;
// the corrected block, and the seven other DiscoverTeam sites in that file, are
// the authority. ID! is correct — do NOT substitute String!.
const PROFILE_TEAMS_QUERY = `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    ... on DiscoverTeam { id name season { id name } organisation { id name } }
  }
}`;

async function fetchProfileTeams(profileID) {
  if (!sessionCookie) await refreshSession();
  let res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify({ operationName: 'PublicProfileTeams', variables: { profileID }, query: PROFILE_TEAMS_QUERY }),
    });
  } catch (err) { return { status: 'error' }; }
  if (res.status === 403) {
    // CloudFront hard-block is a 403 with an HTML body and is NOT an application
    // 403 (fetch-profile-stats.js L458). Conflating them records a throttle as a
    // fact about the player.
    let b = ''; try { b = await res.text(); } catch (e) { b = ''; }
    return (b.includes('DOCTYPE') || b.includes('Request blocked')) ? { status: 'cloudfront-block' } : { status: 'private' };
  }
  if (res.status === 404) return { status: 'notfound' };
  if (!res.ok) return { status: 'http-' + res.status };
  let json; try { json = await res.json(); } catch (e) { return { status: 'bad-json' }; }
  if (json.errors && json.errors.length) {
    const m = String(json.errors[0].message || '');
    return { status: /NOT_FOUND|failed to find profile/i.test(m) ? 'NOT_FOUND' : 'gql-error', detail: m.slice(0, 120) };
  }
  const raw = (json.data || json)?.publicProfileTeams;
  return { status: 'ok', teams: Array.isArray(raw) ? raw : [] };
}

// The stats call reuses fetchProfile from the copied stack, but its NOT_FOUND is
// buried inside the generic gql-error status, so unwrap it the same way.
async function fetchStats(profileID) {
  const r = await fetchProfile(profileID);
  if (r.status === 'gql-error') {
    const m = String((r.errors && r.errors[0] && r.errors[0].message) || '');
    if (/NOT_FOUND|failed to find profile/i.test(m)) return { status: 'NOT_FOUND', detail: m.slice(0, 120) };
    return { status: 'gql-error', detail: m.slice(0, 120) };
  }
  return r;
}

function ageDays(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round((Date.now() - t) / 86400000) : null;
}

async function main() {
  console.log('probe-notfound [READ-ONLY] — sample=' + SAMPLE + ' per group, seed=' + SEED);

  // ── Offline: build the affected set and the control set ────────────────────
  const playersDir = path.join(ROOT, 'players');
  const info = new Map();
  for (const shard of fs.readdirSync(playersDir).filter(x => /^[0-9a-f]{2}$/.test(x))) {
    for (const f of fs.readdirSync(path.join(playersDir, shard))) {
      if (!f.endsWith('.json')) continue;
      const uuid = f.replace(/\.json$/, '');
      let p; try { p = JSON.parse(fs.readFileSync(path.join(playersDir, shard, f), 'utf8')); } catch (e) { continue; }
      const tids = new Set();
      for (const x of (Array.isArray(p.teams) ? p.teams : [])) if (x && x.tid) tids.add(x.tid);
      for (const se of (Array.isArray(p.seasons) ? p.seasons : [])) {
        for (const r of (Array.isArray(se.regs) ? se.regs : [])) if (r && r.tid) tids.add(r.tid);
      }
      if (!tids.size) continue;
      const bk = (p.sports && (p.sports.Basketball || p.sports.basketball)) || {};
      info.set(uuid, {
        uuid: uuid, name: p.name || '?', tids: tids,
        games: Array.isArray(p.games) ? p.games : [],
        priv: p.private === true,
        hasGp: typeof bk.gp === 'number',
        checkedAge: ageDays(bk.statsChecked),
        apiId: p.apiId || null,
        regs: tids.size,
      });
    }
  }

  const gamesDir = path.join(ROOT, 'games', 'bv');
  const gt = new Map();
  const wanted = new Set();
  for (const [, v] of info) for (const g of v.games) wanted.add(g);
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const gid of Object.keys(sg.games || {})) {
      if (!wanted.has(gid)) continue;
      const g = sg.games[gid];
      gt.set(gid, [g.h || null, g.a || null]);
    }
  }

  const affected = [], control = [];
  for (const [, v] of info) {
    let bad = 0;
    for (const gid of v.games) {
      const t = gt.get(gid);
      if (!t) continue;
      if ((t[0] && v.tids.has(t[0])) || (t[1] && v.tids.has(t[1]))) continue;
      bad++;
    }
    (bad > 0 ? affected : control).push(v);
  }
  console.log('  affected (hold unregistered-team appearances): ' + affected.length.toLocaleString());
  console.log('  control  (none)                              : ' + control.length.toLocaleString());

  const rnd = mulberry32(SEED);
  const pick = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, SAMPLE);
  };
  const groups = [['affected', pick(affected)], ['control', pick(control)]];

  const res = new Map();
  for (const [label] of groups) res.set(label, { n: 0, statusPairs: new Map(), notfoundBoth: 0, notfoundTeamsOnly: 0, bothOk: 0, fewer: 0, rows: [] });

  for (const [label, targets] of groups) {
    console.log('\n── ' + label + ' (' + targets.length + ') ──');
    const R = res.get(label);
    for (const v of targets) {
      const qid = v.apiId || v.uuid;
      const st = await fetchStats(qid);
      await sleep(900);
      const tm = await fetchProfileTeams(qid);
      await sleep(900);
      R.n++;
      const key = 'stats=' + st.status + ' teams=' + tm.status;
      R.statusPairs.set(key, (R.statusPairs.get(key) || 0) + 1);
      if (st.status === 'NOT_FOUND' && tm.status === 'NOT_FOUND') R.notfoundBoth++;
      else if (tm.status === 'NOT_FOUND' && st.status === 'ok') R.notfoundTeamsOnly++;
      if (st.status === 'ok' && tm.status === 'ok') {
        R.bothOk++;
        if (tm.teams.length < v.regs) R.fewer++;
      }
      if (st.status === 'NOT_FOUND' || tm.status === 'NOT_FOUND') {
        R.rows.push(v);
        console.log('  ✗ ' + v.uuid + '  ' + key + '  regs=' + v.regs + ' games=' + v.games.length +
                    (v.priv ? ' [PRIVATE]' : '') + (v.hasGp ? '' : ' [no gp]') +
                    (v.checkedAge === null ? ' [never checked]' : ' [checked ' + v.checkedAge + 'd ago]') +
                    (v.apiId ? ' [apiId]' : '') + '  ' + JSON.stringify(v.name));
      }
    }
  }

  const pc = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';
  console.log('\n════════════════════════════════════════════════');
  for (const [label] of groups) {
    const R = res.get(label);
    if (!R.n) continue;
    console.log('  ' + label.toUpperCase() + '  (n=' + R.n + ')');
    console.log('    NOT_FOUND on BOTH endpoints  : ' + R.notfoundBoth + '  (' + pc(R.notfoundBoth, R.n) + '%)   ← the profile is gone');
    console.log('    NOT_FOUND on teams ONLY      : ' + R.notfoundTeamsOnly + '  (' + pc(R.notfoundTeamsOnly, R.n) + '%)   ← profile exists, endpoint refuses');
    console.log('    both answered                : ' + R.bothOk + '  (' + pc(R.bothOk, R.n) + '%)');
    console.log('      of those, teams returned FEWER than we store: ' + R.fewer + '  (' + pc(R.fewer, R.bothOk) + '%)');
    console.log('    outcome pairs:');
    for (const [k, c] of [...R.statusPairs.entries()].sort((a, b) => b[1] - a[1])) console.log('      ' + String(c).padStart(4) + '  ' + k);
    const rows = R.rows;
    if (rows.length) {
      const share = (f) => pc(rows.filter(f).length, rows.length);
      console.log('    SHAPE of the failing players: private ' + share(r => r.priv) + '% · no gp ' + share(r => !r.hasGp) +
                  '% · never stats-checked ' + share(r => r.checkedAge === null) + '% · carries apiId ' + share(r => r.apiId) + '%');
      const ages = rows.map(r => r.checkedAge).filter(x => x !== null).sort((a, b) => a - b);
      if (ages.length) console.log('    statsChecked age (days): min ' + ages[0] + ' median ' + ages[Math.floor(ages.length / 2)] + ' max ' + ages[ages.length - 1]);
    }
    console.log('');
  }
  const A = res.get('affected'), C = res.get('control');
  const aRate = A.n ? (100 * (A.notfoundBoth + A.notfoundTeamsOnly) / A.n) : 0;
  const cRate = C.n ? (100 * (C.notfoundBoth + C.notfoundTeamsOnly) / C.n) : 0;
  console.log('  AFFECTED ' + aRate.toFixed(1) + '% NOT_FOUND against CONTROL ' + cRate.toFixed(1) + '%' +
              (cRate > 0 ? '  (ratio ' + (aRate / cRate).toFixed(2) + ')' : ''));
  console.log('    Close rates → NOT_FOUND is the BACKGROUND rate and says nothing about the');
  console.log('      unregistered-appearance population. It is a separate, general question.');
  console.log('    Affected much higher → the two are related and the missing registrations may');
  console.log('      simply be profiles PlayHQ no longer serves.');
  console.log('    teams-ONLY failures dominating → the profile exists and publicProfileTeams is');
  console.log('      unreliable for it; stored registrations are NOT invalidated by its silence.');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
