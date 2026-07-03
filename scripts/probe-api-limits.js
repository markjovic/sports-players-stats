// scripts/probe-api-limits.js
//
// Standalone PlayHQ API concurrency/failure probe. NO repo data, NO writes, NO git.
// Characterises the CloudFront rate-limit behaviour so we can size the crawl safely.
//
// Seeds real IDs from the API (discoverSeason -> grades) across one or more seasons,
// then exercises the main API. Implements the typed-result pattern (see
// playhq_api_reference.md "Failure handling"): every call is classified
// ok | empty | transient | blocked and NEVER retried, so raw behaviour is visible.
//
// THREE MODES (pick via flags; precedence: duration > cycles > sweep):
//   sweep      (default)  — step through --levels, measure fail%/latency/firstBlock at each
//   escalation --cycles=N — repeat [flood until block -> recover], report if recovery GROWS
//   endurance  --duration=SEC --burst=N --rest=MS — rehearse burst-and-rest to expose a long-term cap
//
// Usage:
//   node scripts/probe-api-limits.js --season=<id> [--seasons=<id,id,..>] [--op=grade|fixture]
//       [--levels=25,50,100] [--calls=400] [--cooldown=10000]         (sweep)
//       [--cycles=6] [--conc=25]                                       (escalation)
//       [--duration=3600 --burst=1000 --rest=90000 --conc=25]          (endurance)
//       [--recover --recover-interval=5000 --recover-max=60] [--target=1]

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
const seasonList = []
  .concat(args.season ? [args.season] : [])
  .concat(args.seasons ? args.seasons.split(',').map(s => s.trim()).filter(Boolean) : []);
const GRADES   = args.grades ? args.grades.split(',').map(s => s.trim()).filter(Boolean) : null;
const OP       = (args.op || 'grade').toLowerCase();
const LEVELS   = (args.levels || '25,50,100,200,400').split(',').map(n => parseInt(n, 10)).filter(Boolean);
const CALLS    = parseInt(args.calls || '400', 10);
const COOLDOWN = parseInt(args.cooldown || '10000', 10);
const TARGET   = parseFloat(args.target || '1');
const CYCLES   = parseInt(args.cycles || '0', 10);
const DURATION = parseInt(args.duration || '0', 10);   // seconds
const BURST    = parseInt(args.burst || '1000', 10);
const REST     = parseInt(args.rest || '90000', 10);   // ms
const CONC     = parseInt(args.conc || '25', 10);
const RECOVER  = 'recover' in args;
const RECOVER_INTERVAL = parseInt(args['recover-interval'] || '5000', 10);
const RECOVER_MAX      = parseInt(args['recover-max'] || '60', 10);

if (!seasonList.length && !GRADES) {
  console.error('Usage: node scripts/probe-api-limits.js --season=<id> [--seasons=..] [--op=] [--cycles=|--duration=] ...');
  process.exit(1);
}
if (!['grade', 'fixture'].includes(OP)) { console.error(`Bad --op=${OP}`); process.exit(1); }

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
const callSeed    = id => (OP === 'fixture' ? callFixture(id) : callGrade(id));

// ─── fixed pool (verbatim from nightly-crawl.js) ───────────────────────────────
async function runPool(tasks, concurrency) {
  let i = 0;
  async function worker() { while (i < tasks.length) { await tasks[i++](); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}
function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

let seedIds = [];

// Fire `count` calls at `conc`. If stopOnBlock, short-circuit remaining once a
// cloudfront block is seen (so we stop hammering a closed gate).
async function fireBatch(count, conc, { stopOnBlock = false } = {}) {
  const c = { ok: 0, empty: 0, blocked: 0, transient: 0 };
  const reasons = {}; const lat = [];
  let completed = 0, firstBlockAt = 0, stop = false;
  const tasks = Array.from({ length: count }, (_, k) => async () => {
    if (stop) return;
    const r = await callSeed(seedIds[k % seedIds.length]);
    completed++;
    if (!firstBlockAt && (r.kind === 'transient' || r.kind === 'blocked')) firstBlockAt = completed;
    if (r.kind === 'blocked' && stopOnBlock) stop = true;
    c[r.kind]++;
    if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    if (r.ms) lat.push(r.ms);
  });
  const t0 = Date.now();
  await runPool(tasks, conc);
  lat.sort((a, b) => a - b);
  return { c, reasons, lat, firstBlockAt, completed, secs: (Date.now() - t0) / 1000 };
}

async function recoverPoll(intervalMs, maxAttempts) {
  const t0 = Date.now();
  for (let a = 1; a <= maxAttempts; a++) {
    const r = await callSeed(seedIds[0]);
    if (r.kind === 'ok' || r.kind === 'empty') return { recovered: true, secs: (Date.now() - t0) / 1000, attempts: a };
    await sleep(intervalMs);
  }
  return { recovered: false, secs: (Date.now() - t0) / 1000, attempts: maxAttempts };
}

// ─── seeding ────────────────────────────────────────────────────────────────────
async function seed() {
  let gradeIds = GRADES;
  if (!gradeIds) {
    gradeIds = [];
    for (const sid of seasonList) {
      const res = await doFetch(API_URL, {
        method: 'POST',
        headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
        body: JSON.stringify({ operationName: 'DiscoverSeason', variables: { id: sid }, query: Q_DISCOVER_SEASON }),
      });
      let season; try { season = (await res.json()).data?.discoverSeason; } catch (_) {}
      const gs = (season?.grades || []).map(g => g.id);
      console.log(`  season ${sid} "${season?.name || '?'}": ${gs.length} grades`);
      gradeIds.push(...gs);
    }
  }
  gradeIds = [...new Set(gradeIds)];
  console.log(`  Total unique grades: ${gradeIds.length}`);
  if (!gradeIds.length) { console.error('  No grade IDs.'); process.exit(1); }

  if (OP === 'fixture') {
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
  } else {
    seedIds = gradeIds;
  }
  if (!seedIds.length) { console.error('  No seed IDs.'); process.exit(1); }
}

// ─── MODE: sweep ─────────────────────────────────────────────────────────────
async function sweep() {
  console.log(`\nSweep: levels=[${LEVELS.join(', ')}] calls/level=${CALLS} cooldown=${COOLDOWN}ms target<=${TARGET}%\n`);
  const rows = [];
  for (let li = 0; li < LEVELS.length; li++) {
    const L = LEVELS[li];
    const b = await fireBatch(CALLS, L, { stopOnBlock: false });
    const fail = b.c.transient + b.c.blocked;
    const failPct = fail / CALLS * 100, okPct = b.c.ok / CALLS * 100, thru = CALLS / b.secs;
    const reasonStr = Object.entries(b.reasons).filter(([k]) => k !== 'null-payload').map(([k, v]) => `${k}:${v}`).join(' ') || '-';
    console.log(
      `conc=${String(L).padStart(4)} | ok=${String(b.c.ok).padStart(4)} (${okPct.toFixed(1)}%) empty=${String(b.c.empty).padStart(3)} ` +
      `fail=${String(fail).padStart(4)} (${failPct.toFixed(1)}%) firstBlock@${b.firstBlockAt || '-'} | thru=${thru.toFixed(1)}/s ` +
      `p50=${pct(b.lat, 50)}ms p95=${pct(b.lat, 95)}ms max=${b.lat[b.lat.length - 1] || 0}ms | ${reasonStr}`
    );
    rows.push({ L, okPct, failPct, thru });
    if (li < LEVELS.length - 1 && COOLDOWN > 0) await sleep(COOLDOWN);
  }
  if (RECOVER && rows.some(r => r.failPct > 0)) {
    console.log(`\nRecovery probe: 1 request every ${RECOVER_INTERVAL}ms until success (max ${RECOVER_MAX})...`);
    const rec = await recoverPoll(RECOVER_INTERVAL, RECOVER_MAX);
    console.log(rec.recovered ? `  Recovered after ${rec.secs.toFixed(1)}s (${rec.attempts} attempts)` : `  No recovery within ~${Math.round(RECOVER_MAX * RECOVER_INTERVAL / 1000)}s`);
  }
  console.log('\n─────────────────────────────────────────────');
  const clean = rows.filter(r => r.failPct <= TARGET);
  if (clean.length) {
    const best = clean.reduce((a, b) => (b.thru > a.thru ? b : a));
    console.log(`Highest clean level: ${best.L} (${best.failPct.toFixed(1)}% fail, ${best.thru.toFixed(1)}/s). Rested between levels — sustained ceiling is lower.`);
  } else {
    console.log('No clean level — the limit is cumulative (rate-window WAF), not a concurrency ceiling. Use escalation/endurance modes.');
  }
}

// ─── MODE: escalation ────────────────────────────────────────────────────────
async function escalation() {
  console.log(`\nEscalation: ${CYCLES} cycles of [flood until block -> recover] at conc=${CONC}. Watching whether recovery GROWS.\n`);
  const recs = [];
  for (let cy = 1; cy <= CYCLES; cy++) {
    const b = await fireBatch(5000, CONC, { stopOnBlock: true });
    if (b.c.blocked === 0) {
      console.log(`  cycle ${cy}: no block within ${b.completed} calls (budget > ${b.completed})`);
      recs.push({ budget: b.completed, recovery: 0 });
      continue;
    }
    const rec = await recoverPoll(RECOVER_INTERVAL, RECOVER_MAX);
    console.log(`  cycle ${cy}: budget=${b.firstBlockAt}  recovery=${rec.recovered ? rec.secs.toFixed(1) + 's (' + rec.attempts + ' attempts)' : '>' + rec.secs.toFixed(0) + 's (no recovery)'}`);
    recs.push({ budget: b.firstBlockAt, recovery: rec.secs });
  }
  console.log('\n─────────────────────────────────────────────');
  console.log('Budget trend:  ', recs.map(r => r.budget).join(' → '));
  console.log('Recovery trend:', recs.map(r => r.recovery.toFixed(0) + 's').join(' → '));
  const withBlock = recs.filter(r => r.recovery > 0);
  if (withBlock.length >= 2 && withBlock[withBlock.length - 1].recovery > withBlock[0].recovery * 1.5) {
    console.log('⚠ Recovery GROWS with repeated trips — escalating penalty. Burst-and-rest must NEVER trip: size well under budget, or shard + self-trigger.');
  } else if (withBlock.length) {
    console.log('✓ Recovery is stable across trips — an occasional trip is safe (rest and resume). Burst-and-rest is viable.');
  }
}

// ─── MODE: endurance ─────────────────────────────────────────────────────────
async function endurance() {
  console.log(`\nEndurance: burst-and-rest for ${DURATION}s — burst=${BURST} @ conc=${CONC}, rest=${REST}ms. Exposes any long-term/hourly cap.\n`);
  const start = Date.now();
  const cum = { ok: 0, empty: 0, blocked: 0, transient: 0 };
  let n = 0, everBlocked = false, firstBlockBurst = 0;
  while ((Date.now() - start) / 1000 < DURATION) {
    n++;
    const b = await fireBatch(BURST, CONC, { stopOnBlock: true });
    for (const k of ['ok', 'empty', 'blocked', 'transient']) cum[k] += b.c[k];
    const tsec = ((Date.now() - start) / 1000).toFixed(0);
    console.log(`  [t+${String(tsec).padStart(4)}s] burst ${String(n).padStart(3)}: ok=${String(b.c.ok).padStart(4)} blocked=${String(b.c.blocked).padStart(4)} firstBlock@${b.firstBlockAt || '-'} (${b.secs.toFixed(1)}s) | cumOk=${cum.ok}`);
    if (b.c.blocked > 0) {
      if (!everBlocked) { everBlocked = true; firstBlockBurst = n; }
      const rec = await recoverPoll(RECOVER_INTERVAL, RECOVER_MAX);
      console.log(`      tripped → ${rec.recovered ? 'recovered after ' + rec.secs.toFixed(1) + 's' : 'NOT recovered within ~' + Math.round(RECOVER_MAX * RECOVER_INTERVAL / 1000) + 's'}`);
    } else {
      await sleep(REST);
    }
  }
  console.log('\n─────────────────────────────────────────────');
  console.log(`Endurance done: ${n} bursts, cumOk=${cum.ok}, cumBlocked=${cum.blocked}, everBlocked=${everBlocked}${everBlocked ? ` (first at burst ${firstBlockBurst})` : ''}`);
  if (!everBlocked) console.log('✓ No blocks across the whole run — this burst/rest pacing is safe at production scale.');
  else if (firstBlockBurst > 3) console.log('⚠ Blocks appeared only later — points to a longer-term (e.g. hourly) cap. The crawl must self-trigger to continue in a fresh run.');
  else console.log('⚠ Blocks throughout — burst too large or rest too short; lower burst / raise rest.');
}

// ─── main ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log('probe-api-limits.js');
  console.log(`  op=${OP}  mode=${DURATION > 0 ? 'endurance' : CYCLES > 0 ? 'escalation' : 'sweep'}`);
  await refreshSession();
  await seed();
  if (DURATION > 0)      await endurance();
  else if (CYCLES > 0)   await escalation();
  else                   await sweep();
  console.log('\nDone.');
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
