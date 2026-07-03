// scripts/probe-api-limits.js
//
// Standalone PlayHQ API concurrency/failure probe. NO repo data, NO writes, NO git.
// Purpose: find the sustainable concurrency for non-profile operations
// (discoverGrade / discoverFixtureByRound) by sweeping concurrency levels and
// measuring the failure rate + latency at each, so we can pick the level that
// maximises throughput without shedding calls.
//
// It seeds real IDs from the API (discoverSeason -> grades), then re-requests
// them at escalating concurrency. Re-requesting the same IDs is fine for a load
// test — we are measuring transport behaviour, not collecting data.
//
// Implements the typed-result pattern (see playhq_api_reference.md "Failure
// handling"): every call is classified ok | empty | transient | blocked and
// NEVER retried, so the raw failure behaviour is visible.
//
// Usage:
//   node scripts/probe-api-limits.js --season=<id> [--op=grade|fixture]
//       [--levels=25,50,100,200,400] [--calls=400] [--cooldown=10000] [--target=1]
//   node scripts/probe-api-limits.js --grades=<id,id,...> [...]

'use strict';

const crypto = require('crypto');
const https  = require('https');

const API_URL = 'https://api.playhq.com/graphql';

// ─── args ─────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);
const SEASON   = args.season || null;
const GRADES   = args.grades ? args.grades.split(',').map(s => s.trim()).filter(Boolean) : null;
const OP       = (args.op || 'grade').toLowerCase();       // grade | fixture
const LEVELS   = (args.levels || '25,50,100,200,400').split(',').map(n => parseInt(n, 10)).filter(Boolean);
const CALLS    = parseInt(args.calls || '400', 10);
const COOLDOWN = parseInt(args.cooldown || '10000', 10);   // ms rest between levels
const TARGET   = parseFloat(args.target || '1');           // acceptable fail % for the recommendation

if (!SEASON && !GRADES) {
  console.error('Usage: node scripts/probe-api-limits.js --season=<id> [--op=grade|fixture] [--levels=..] [--calls=..]');
  process.exit(1);
}
if (!['grade', 'fixture'].includes(OP)) { console.error(`Bad --op=${OP} (grade|fixture)`); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── headers / session (verbatim from fetch-profile-stats.js) ──────────────────
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
let sessionCookie  = null;
let sessionPromise = null;

// verbatim from fetch-profile-stats.js
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
        const headers = { get(name) { const v = hdrs[name.toLowerCase()]; return v == null ? null : (Array.isArray(v) ? v.join(', ') : v); } };
        resolve({
          status: res.statusCode,
          ok:     res.statusCode >= 200 && res.statusCode < 300,
          headers,
          text:   () => Promise.resolve(rawBody),
          json:   () => Promise.resolve(JSON.parse(rawBody)),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// verbatim shape from fetch-profile-stats.js (promise-locked)
async function refreshSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (attempt > 1) await sleep(attempt * 5000);
      for (const body of COOKIE_QUERIES) {
        const res = await doFetch(API_URL, {
          method: 'POST',
          headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() },
          body: JSON.stringify(body),
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

// ─── queries (verbatim from nightly-crawl.js / discover-fixtures.js) ───────────
const Q_DISCOVER_SEASON = `query DiscoverSeason($id: String!) { discoverSeason(seasonID: $id) { id name grades { id name } } }`;

const Q_GRADE_ROUNDS = `query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id name hideScores
    rounds { id name abbreviatedName current number isFinalsRound }
    season { id competition { id organisation { id name } } }
  }
}`;

const Q_FIXTURE_BY_ROUND = `query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    byes { id name __typename organisation { id name } }
    games {
      id date dates __typename
      status { value }
      home { __typename ... on DiscoverTeam { id name organisation { id name } season { id } } ... on ProvisionalTeam { name } }
      away { __typename ... on DiscoverTeam { id name organisation { id name } season { id } } ... on ProvisionalTeam { name } }
      result {
        outcome { name value } winner { name value }
        home { outcome { name value } statistics { count type { value } } gameOutcomeDescription }
        away { outcome { name value } statistics { count type { value } } }
      }
      allocation {
        time dateTimeList { date time }
        court { id name abbreviatedName venue { id name abbreviatedName latitude longitude address suburb state postcode country } }
      }
    }
  }
}`;

// ─── typed call — NEVER retries; classifies the raw outcome ────────────────────
// kinds: ok | empty | transient | blocked   (see playhq_api_reference.md)
async function typedCall(operationName, query, variables, dataKey) {
  const t0 = Date.now();
  let res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify({ operationName, variables, query }),
    });
  } catch (e) {
    return { kind: 'transient', reason: `network:${e.code || e.message}`, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;

  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    const cf = b.includes('DOCTYPE') || b.includes('Request blocked');
    return { kind: 'blocked', reason: cf ? 'cloudfront-403' : 'app-403', ms };
  }
  if (res.status === 429) return { kind: 'transient', reason: '429', ms };
  if (res.status === 504) return { kind: 'transient', reason: '504', ms };
  if (!res.ok)            return { kind: 'transient', reason: `http-${res.status}`, ms };

  let json; try { json = await res.json(); } catch (_) { return { kind: 'transient', reason: 'parse', ms }; }
  if (json.errors && json.errors.length) return { kind: 'transient', reason: 'gql', ms };

  const payload = json.data ? json.data[dataKey] : undefined;
  if (payload == null) return { kind: 'empty', reason: 'null-payload', ms };
  return { kind: 'ok', reason: '', ms };
}

const callGrade   = id => typedCall('gradeRounds', Q_GRADE_ROUNDS, { gradeID: id }, 'discoverGrade');
const callFixture = id => typedCall('discoverFixtureByRound', Q_FIXTURE_BY_ROUND, { roundID: id }, 'discoverFixtureByRound');

// ─── fixed pool (verbatim from nightly-crawl.js) ───────────────────────────────
async function runPool(tasks, concurrency) {
  let i = 0;
  async function worker() { while (i < tasks.length) { await tasks[i++](); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// ─── percentile helper ─────────────────────────────────────────────────────────
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// ─── main ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log('probe-api-limits.js');
  console.log(`  op=${OP}  levels=[${LEVELS.join(', ')}]  calls/level=${CALLS}  cooldown=${COOLDOWN}ms  target<=${TARGET}%\n`);

  await refreshSession();

  // 1) seed grade IDs
  let gradeIds = GRADES;
  if (!gradeIds) {
    const r = await typedCall('DiscoverSeason', Q_DISCOVER_SEASON, { id: SEASON }, 'discoverSeason');
    if (r.kind !== 'ok') { console.error(`  Could not load season ${SEASON}: ${r.kind}/${r.reason}`); process.exit(1); }
    // re-fetch to read the payload (typedCall only classifies) — one plain call
    const res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify({ operationName: 'DiscoverSeason', variables: { id: SEASON }, query: Q_DISCOVER_SEASON }),
    });
    const season = (await res.json()).data?.discoverSeason;
    gradeIds = (season?.grades || []).map(g => g.id);
    console.log(`  Seeded ${gradeIds.length} grades from season "${season?.name || SEASON}"`);
  } else {
    console.log(`  Seeded ${gradeIds.length} grades from --grades`);
  }
  if (!gradeIds.length) { console.error('  No grade IDs to probe.'); process.exit(1); }

  // 2) if op=fixture, resolve one round per grade (current, else highest number)
  let seedIds = gradeIds;
  if (OP === 'fixture') {
    console.log('  Resolving one round per grade for fixture probe...');
    const roundIds = [];
    await runPool(gradeIds.map(gid => async () => {
      try {
        const res = await doFetch(API_URL, {
          method: 'POST',
          headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
          body: JSON.stringify({ operationName: 'gradeRounds', variables: { gradeID: gid }, query: Q_GRADE_ROUNDS }),
        });
        const g = (await res.json()).data?.discoverGrade;
        const rounds = g?.rounds || [];
        const pick = rounds.find(r => r.current) || [...rounds].sort((a, b) => (b.number || 0) - (a.number || 0))[0];
        if (pick) roundIds.push(pick.id);
      } catch (_) {}
    }), 20);
    seedIds = roundIds;
    console.log(`  Resolved ${seedIds.length} round IDs`);
    if (!seedIds.length) { console.error('  No rounds resolved.'); process.exit(1); }
  }

  // 3) sweep
  const rows = [];
  for (let li = 0; li < LEVELS.length; li++) {
    const L = LEVELS[li];
    const c = { ok: 0, empty: 0, blocked: 0, transient: 0 };
    const reasons = {};
    const lat = [];

    const tasks = Array.from({ length: CALLS }, (_, k) => async () => {
      const id = seedIds[k % seedIds.length];
      const r  = OP === 'fixture' ? await callFixture(id) : await callGrade(id);
      c[r.kind]++;
      if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
      if (r.ms) lat.push(r.ms);
    });

    const t0 = Date.now();
    await runPool(tasks, L);
    const elapsed = (Date.now() - t0) / 1000;

    lat.sort((a, b) => a - b);
    const fail = c.transient + c.blocked;
    const failPct = (fail / CALLS) * 100;
    const okPct   = (c.ok / CALLS) * 100;
    const thru    = CALLS / elapsed;

    rows.push({ L, ok: c.ok, okPct, empty: c.empty, fail, failPct, thru, p50: pct(lat, 50), p95: pct(lat, 95), max: lat[lat.length - 1] || 0, reasons: { ...reasons } });

    const reasonStr = Object.entries(reasons).filter(([k]) => k !== 'null-payload').map(([k, v]) => `${k}:${v}`).join(' ') || '-';
    console.log(
      `conc=${String(L).padStart(4)} | ok=${String(c.ok).padStart(4)} (${okPct.toFixed(1)}%) empty=${String(c.empty).padStart(3)} ` +
      `fail=${String(fail).padStart(4)} (${failPct.toFixed(1)}%) | thru=${thru.toFixed(1)}/s ` +
      `p50=${String(pct(lat, 50)).padStart(4)}ms p95=${String(pct(lat, 95)).padStart(5)}ms max=${String(lat[lat.length - 1] || 0).padStart(5)}ms | ${reasonStr}`
    );

    if (li < LEVELS.length - 1 && COOLDOWN > 0) await sleep(COOLDOWN);
  }

  // 4) recommendation
  console.log('\n─────────────────────────────────────────────');
  const clean = rows.filter(r => r.failPct <= TARGET);
  if (clean.length) {
    const best = clean.reduce((a, b) => (b.thru > a.thru ? b : a));
    console.log(`Recommended sustained concurrency: ${best.L}  (fail ${best.failPct.toFixed(1)}% <= ${TARGET}%, ${best.thru.toFixed(1)} calls/s)`);
    console.log('NOTE: levels were tested with cooldown between them, so the API was rested each time.');
    console.log('      The nightly runs SUSTAINED load across thousands of calls — pick a level with margin');
    console.log('      below the first one that shows failures, or shard + self-trigger (see below).');
  } else {
    console.log(`No level held fail <= ${TARGET}%. Lowest failure was at conc=${rows.reduce((a, b) => (b.failPct < a.failPct ? b : a)).L}.`);
    console.log('This points to architecture revision (shard + batch + stop-on-fail + self-trigger), not just a lower constant.');
  }
  console.log('\nDone.');
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
