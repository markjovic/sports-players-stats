// scripts/measure-playhq-limits.js
//
// MEASURE the two PlayHQ limits instead of theorising about them. Writes nothing,
// commits nothing. Every request this script makes is deliberate and counted, and it
// STOPS at the first refusal, because every request made into an open penalty window
// extends that window (REPO_MANIFEST §6.59).
//
// ─── THE TWO QUESTIONS ───────────────────────────────────────────────────────
// Since 2026-10-04 the 256-shard matrix cannot start: every shard's first request,
// from a cold session with nothing spent, comes back 403. Nightly Crawl #129 made
// 11,317 calls clean, then a profile shard started immediately afterwards could not
// get a cookie for 13 players' worth of work. So the scarce thing is NEW SESSIONS,
// and the count that matters is "how many cookieless requests may the fleet make in
// one window". Nobody has measured it. That is mode `bootstrap`.
//
// The ~290-call budget per cookie was measured twice, both times at high
// concurrency, so nobody knows whether it is a LIFETIME count or a RATE. If a cookie
// spent slowly never runs out, the nightly should pace instead of rotate and the
// bootstraps it saves become the matrix's. That is mode `budget`.
//
// ─── MODES ───────────────────────────────────────────────────────────────────
//   --mode=bootstrap   Make one cookieless request every --interval ms, up to --max
//                      of them, and stop at the first 403. The number granted before
//                      the refusal is the answer. Default interval 10 s, max 60.
//   --mode=budget      Bootstrap ONCE, then make one PublicProfileTeams call for
//                      --uuid every --interval ms on that cookie, up to --max, and
//                      stop at the first 403. Default interval 3 s, max 400. If it
//                      reaches --max clean, the budget is not a lifetime count.
//   --interval=MS      Gap between requests.
//   --max=N            Stop after N requests even if none is refused.
//   --uuid=ID          Player to probe in budget mode (required there).
//   --ua=STRING        Replace the user-agent for every request. For the LATER test
//                      of whether the shared key is the user-agent string — not for
//                      the first run.
//
// If the FIRST request is refused, nothing was measured: the window was already
// open when the run started. The script says so and exits 1. Wait an hour with
// every PlayHQ workflow idle, then dispatch again.
//
// Headers, bootstrap queries, cookie parsing and doFetch are copied VERBATIM from
// scripts/discover-seasons.js (the live script that is failing), so this measures
// exactly what that script experiences. Never write PlayHQ API code from scratch.

'use strict';

const crypto = require('crypto');
const https  = require('https');

const API_URL = 'https://api.playhq.com/graphql';

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3).trim() : dflt;
};
const MODE     = (opt('mode', 'bootstrap') || 'bootstrap').toLowerCase();
const UUID     = opt('uuid', '') || null;
const UA       = opt('ua', '') || null;
const INTERVAL = (() => { const n = parseInt(opt('interval', MODE === 'budget' ? '3000' : '10000'), 10); return Number.isFinite(n) && n >= 0 ? n : 10000; })();
const MAX      = (() => { const n = parseInt(opt('max', MODE === 'budget' ? '400' : '60'), 10); return Number.isFinite(n) && n > 0 ? n : 60; })();

if (MODE !== 'bootstrap' && MODE !== 'budget') { console.error(`--mode must be bootstrap or budget (got ${MODE})`); process.exit(2); }
if (MODE === 'budget' && !UUID) { console.error('--mode=budget needs --uuid=<player id> to probe'); process.exit(2); }

// ─── Headers — full set, never split, never modified (copied verbatim) ────────
const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};
if (UA) HEADERS_BASE['user-agent'] = UA;

// Bootstrap queries, copied verbatim. discover-seasons.js sends TenantConfig first,
// so that is the one this script sends.
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];
const BOOTSTRAP_QUERY = COOKIE_QUERIES[0];

// Copied verbatim from discover-seasons.js.
const Q_PROFILE_TEAMS = {
  operationName: 'PublicProfileTeams',
  query: `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    id name
    organisation { id name }
    grade { id name }
    season {
      id name startDate endDate
      status { name value }
      competition { id name organisation { id name } }
    }
  }
}`,
};

// Copied verbatim from discover-seasons.js.
function doFetch(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = options.body || '';
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: { ...options.headers, 'content-length': Buffer.byteLength(body) },
      agent: new https.Agent({ keepAlive: false }),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const hdrs = res.headers;
        const headers = { get(name) { const v = hdrs[name.toLowerCase()]; return v == null ? null : (Array.isArray(v) ? v.join(', ') : v); } };
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers, text: () => Promise.resolve(rawBody), json: () => Promise.resolve(JSON.parse(rawBody)) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const since = (t0) => ((Date.now() - t0) / 1000).toFixed(1).padStart(7) + 's';

// Body sniff, same classification discover-seasons.js prints.
function sniffBody(b) {
  return b.includes('Request blocked') ? `CLOUDFRONT-BLOCK (${b.length}b HTML)`
       : b.includes('DOCTYPE')         ? `HTML page (${b.length}b)`
       : (b.slice(0, 80).replace(/\s+/g, ' ') || '(empty body)');
}

// One cookieless request. Returns { status, cookie|null, sniff }.
// Cookie parsing copied verbatim from discover-seasons.js refreshSession().
async function bootstrapOnce() {
  const res = await doFetch(API_URL, {
    method: 'POST',
    headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() },
    body: JSON.stringify(BOOTSTRAP_QUERY),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) {
    let b = ''; try { b = await res.text(); } catch {}
    return { status: res.status, cookie: null, sniff: sniffBody(b) };
  }
  const parts = raw.split(',').map(c => c.trim().split(';')[0]);
  const get = (name) => parts.find(c => c.startsWith(name + '=')) || null;
  const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
  if (!tier || !session || !sub) {
    return { status: res.status, cookie: null, sniff: `set-cookie present but missing phq_tier/phq_session/phq_sub — names seen: ${parts.map(c => c.split('=')[0]).join(', ')}` };
  }
  return { status: res.status, cookie: `${tier}; ${session}; ${sub}`, sniff: 'cookie issued' };
}

// One cookie-bearing probe. Returns { status, kind, sniff }.
async function probeOnce(cookie, profileID) {
  const res = await doFetch(API_URL, {
    method: 'POST',
    headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
    body: JSON.stringify({ ...Q_PROFILE_TEAMS, variables: { profileID } }),
  });
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch {}
    const blocked = b.includes('DOCTYPE') || b.includes('Request blocked');
    return { status: 403, kind: blocked ? 'blocked' : 'private', sniff: sniffBody(b) };
  }
  if (res.status === 429 || res.status === 503) return { status: res.status, kind: 'rate', sniff: `HTTP ${res.status}` };
  if (!res.ok) return { status: res.status, kind: 'error', sniff: `HTTP ${res.status}` };
  let json; try { json = await res.json(); } catch (err) { return { status: res.status, kind: 'error', sniff: `unparseable JSON: ${err.message}` }; }
  if (json.errors?.length) return { status: res.status, kind: 'error', sniff: `GraphQL: ${json.errors[0]?.message || 'error'}` };
  const teams = (json.data || json)?.publicProfileTeams;
  return { status: res.status, kind: 'ok', sniff: `${Array.isArray(teams) ? teams.length : 0} registration(s)` };
}

// A short, non-reversible tag for a cookie so the log can show whether PlayHQ hands
// out a different session each time without printing the cookie itself.
const tag = (cookie) => crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 8);

async function runBootstrapMode() {
  console.log(`\nmeasure-playhq-limits  mode=bootstrap  interval=${INTERVAL}ms  max=${MAX}${UA ? `  ua="${UA}"` : ''}`);
  console.log('One cookieless TenantConfig request per interval. Stops at the first refusal.');
  console.log('─'.repeat(72));
  const t0 = Date.now();
  let granted = 0;
  const tags = new Set();
  for (let i = 1; i <= MAX; i++) {
    if (i > 1) await sleep(INTERVAL);
    let r;
    try { r = await bootstrapOnce(); }
    catch (err) {
      console.log(`  #${String(i).padStart(3)}  ${since(t0)}  transport error: ${err.code || ''} ${err.message}`);
      console.log('\nRESULT: transport failure, not a PlayHQ answer — nothing measured.');
      process.exit(1);
    }
    if (r.cookie) {
      granted++;
      tags.add(tag(r.cookie));
      console.log(`  #${String(i).padStart(3)}  ${since(t0)}  HTTP ${r.status}  cookie issued  session ${tag(r.cookie)}`);
      continue;
    }
    console.log(`  #${String(i).padStart(3)}  ${since(t0)}  HTTP ${r.status}  NO cookie  ${r.sniff}`);
    if (r.status === 403) {
      if (i === 1) {
        console.log('\nRESULT: the FIRST cookieless request was refused. The penalty window was already open');
        console.log('        when this run started, so nothing was measured. Leave every PlayHQ workflow');
        console.log('        idle for an hour and dispatch again.');
        process.exit(1);
      }
      console.log(`\nRESULT: ${granted} cookieless request(s) granted, then refused on request #${i}`);
      console.log(`        after ${since(t0).trim()} at one request every ${INTERVAL / 1000}s.`);
      console.log(`        Distinct sessions issued: ${tags.size} of ${granted}.`);
      console.log('        That is the bootstrap allowance per window at this pace. Stopping here —');
      console.log('        further requests would only extend the window.');
      return;
    }
    // Not a 403 and no cookie: an application answer without a session. Record and continue.
  }
  console.log(`\nRESULT: ${granted} cookieless request(s) granted, NONE refused, over ${since(t0).trim()}`);
  console.log(`        at one request every ${INTERVAL / 1000}s. Distinct sessions issued: ${tags.size} of ${granted}.`);
  console.log('        The allowance at this pace is at least --max. Raise --max or shorten --interval');
  console.log('        to find it, in a later quiet window.');
}

async function runBudgetMode() {
  console.log(`\nmeasure-playhq-limits  mode=budget  uuid=${UUID}  interval=${INTERVAL}ms  max=${MAX}${UA ? `  ua="${UA}"` : ''}`);
  console.log('One bootstrap, then one PublicProfileTeams call per interval on that cookie. Stops at the first refusal.');
  console.log('─'.repeat(72));
  const t0 = Date.now();
  let boot;
  try { boot = await bootstrapOnce(); }
  catch (err) { console.log(`  bootstrap: transport error: ${err.code || ''} ${err.message}`); console.log('\nRESULT: transport failure — nothing measured.'); process.exit(1); }
  if (!boot.cookie) {
    console.log(`  bootstrap: HTTP ${boot.status}  NO cookie  ${boot.sniff}`);
    console.log('\nRESULT: could not obtain a cookie, so the budget could not be measured. If that was a');
    console.log('        403 the window was already open; wait an hour with everything idle and retry.');
    process.exit(1);
  }
  console.log(`  bootstrap: HTTP ${boot.status}  cookie issued  session ${tag(boot.cookie)}`);
  let okN = 0, privateN = 0, errorN = 0;
  for (let i = 1; i <= MAX; i++) {
    if (i > 1) await sleep(INTERVAL);
    let r;
    try { r = await probeOnce(boot.cookie, UUID); }
    catch (err) {
      console.log(`  call #${String(i).padStart(3)}  ${since(t0)}  transport error: ${err.code || ''} ${err.message}`);
      console.log(`\nRESULT: transport failure on call #${i} — ${okN} clean before it. Not a PlayHQ answer.`);
      process.exit(1);
    }
    if (r.kind === 'blocked' || r.kind === 'rate') {
      console.log(`  call #${String(i).padStart(3)}  ${since(t0)}  HTTP ${r.status}  ${r.sniff}`);
      const mins = (Date.now() - t0) / 60000;
      console.log(`\nRESULT: the cookie was refused on call #${i} after ${okN + privateN + errorN} answered calls`);
      console.log(`        (${okN} ok, ${privateN} private, ${errorN} error) in ${mins.toFixed(1)} min — about ${((i - 1) / Math.max(mins, 0.01)).toFixed(0)} calls/min.`);
      console.log('        Compare with the ~290 measured at high concurrency: a similar count at this slower');
      console.log('        pace means a LIFETIME budget; a much larger count means a RATE.');
      return;
    }
    if (r.kind === 'ok') okN++; else if (r.kind === 'private') privateN++; else errorN++;
    if (i === 1 || i % 25 === 0) console.log(`  call #${String(i).padStart(3)}  ${since(t0)}  HTTP ${r.status}  ${r.kind}  ${r.sniff}`);
  }
  const mins = (Date.now() - t0) / 60000;
  console.log(`\nRESULT: ${MAX} calls on ONE cookie, none refused, in ${mins.toFixed(1)} min (about ${(MAX / Math.max(mins, 0.01)).toFixed(0)} calls/min).`);
  console.log(`        ${okN} ok, ${privateN} private, ${errorN} error.`);
  if (MAX > 290) console.log('        That is past the ~290 measured at high concurrency: the budget is a RATE, not a lifetime count.');
  else console.log('        Below 290 so nothing is settled yet; raise --max in a later quiet window.');
}

(MODE === 'bootstrap' ? runBootstrapMode() : runBudgetMode()).catch(e => { console.error(e); process.exit(1); });
