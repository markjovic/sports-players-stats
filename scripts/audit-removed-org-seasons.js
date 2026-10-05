// scripts/audit-removed-org-seasons.js
//
// READ-ONLY. Sizes the repair of the seasons that discover-org-seasons.js wrote
// as removed:true on 2026-09-07 because their grade lookup was CloudFront-blocked
// rather than because PlayHQ has no grades for them.
//
// WRITES NOTHING. No fs.writeFileSync, no git, no commit. Safe to run twice.
//
// WHAT WENT WRONG
// ───────────────
// discover-org-seasons.js resolved grades in a plain loop with a fixed 120ms sleep
// and no backoff. 14 seasons got through, CloudFront walled, and the remaining 164
// lookups were all blocked. buildEntry then treated "no grades came back" as "this
// season has no grades", and for a COMPLETED season that means:
//
//     { grades: [], locked: true, removed: true }
//
// 80 seasons landed there. That combination is permanent: discover-seasons.js's
// grade-refresh selects `locked === false` only (L602), so it will never re-ask,
// and claude_context.md's standing rule forbids re-queueing any removed:true
// season. A transport failure became a recorded answer — the exact failure class
// written up on 2026-08-14.
//
// WHAT THIS MEASURES
// ──────────────────
// Re-asks PlayHQ for each of the 80 and sorts them into four buckets that are NOT
// the same thing and must never be collapsed:
//
//   repairable    season served, grades > 0   → the removed:true flag is WRONG
//   truly empty   season served, grades == 0  → the removed:true flag is CORRECT
//   not served    ok response, season is null → PlayHQ will not serve this id
//   no answer     blocked / forbidden / error → we still do not know
//
// The number that decides the next step is the total grade count across the
// repairable bucket, because that is what a repair would add to every nightly run
// until something locks those seasons again — and nothing currently does.
//
// THE LOOKUP IS THE BUG GUARD, TESTED EARLY
// ─────────────────────────────────────────
// discover-org-seasons.js's discoverSeason returns null for three different
// things: PlayHQ answered with nothing, the request was forbidden, and the request
// errored. The caller cannot tell an answer from the absence of one, which is the
// root cause above. lookupSeason below returns a tagged outcome instead. It is the
// same change the bug guard will make, run against the live API here first.
//
// EVERY REQUEST SHAPE IS COPIED, NOT REWRITTEN. Headers, cookie queries, the
// promise-locked session, doFetch with keepAlive:false, the 403 ladder and aimdRun
// all come from discover-org-seasons.js, which took them from discover-seasons.js.
//
// Run:
//   node scripts/audit-removed-org-seasons.js
//   node scripts/audit-removed-org-seasons.js --limit=5        (smoke test first)
//   node scripts/audit-removed-org-seasons.js --concurrency=8

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT       = path.join(__dirname, '..');
const INDEX_FILE = path.join(ROOT, 'data', 'sports-index.json');
const API_URL    = 'https://api.playhq.com/graphql';

const args   = process.argv.slice(2);
const argVal = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const LIMIT       = Math.max(0, parseInt(argVal('limit', '0'), 10) || 0);
const CONCURRENCY = Math.max(1, parseInt(argVal('concurrency', '8'), 10) || 8);

const log   = (m) => console.log(`[audit-removed] ${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Headers: the full set, never split. From discover-org-seasons.js L72. ─────
const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── Session: promise-locked. From discover-org-seasons.js L80-134. ───────────
let sessionCookie = null, sessionPromise = null, sessionAt = 0;
const SESSION_MAX_AGE_MS = 15 * 60 * 1000;
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

async function ensureSession() {
  if (sessionCookie && (Date.now() - sessionAt) < SESSION_MAX_AGE_MS) return;
  await refreshSession();
}

async function refreshSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (attempt > 1) await sleep(attempt * 5000);
      for (const body of COOKIE_QUERIES) {
        let res;
        try {
          res = await doFetch(API_URL, body, HEADERS_BASE);
        } catch (err) {
          console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: fetch threw ${err.code || ''} ${err.message}`);
          throw err;
        }
        const raw = res.rawCookies;
        if (!raw) {
          // A silent continue here is where a CloudFront block page vanishes
          // without trace. Same instrumentation the live scripts carry.
          const b = res.rawText || '';
          const sniff = b.includes('Request blocked') ? `CLOUDFRONT-BLOCK (${b.length}b HTML)`
                      : b.includes('DOCTYPE')         ? `HTML page (${b.length}b): ${b.slice(0, 80)}`
                      : (b.slice(0, 120) || '(empty body)');
          console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: HTTP ${res.status}, NO set-cookie, body: ${sniff.replace(/\s+/g, ' ')}`);
          continue;
        }
        const parts = (Array.isArray(raw) ? raw : [raw]).flatMap(c => c.split(',')).map(c => c.trim().split(';')[0]).filter(Boolean);
        const get = (n) => parts.find(c => c.startsWith(n + '=')) || null;
        const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
        if (!tier || !session || !sub) {
          console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: set-cookie PRESENT but missing phq_* — names seen: ${parts.map(c => c.split('=')[0]).join(', ')}`);
          continue;
        }
        sessionCookie = `${tier}; ${session}; ${sub}`;
        sessionAt = Date.now(); sessionPromise = null;
        log(`session refreshed (attempt ${attempt})`);
        return;
      }
    }
    sessionPromise = null;
    throw new Error('Failed to obtain session cookie after 10 attempts');
  })();
  return sessionPromise;
}

// ⚠️ 2026-10-05 — REWRITTEN FROM https.request TO fetch(). THE CLIENT WAS THE KEY.
// measure-playhq-limits.js --mode=compare, one runner, 10 s apart, same URL, same five
// headers, same user-agent: fetch() GRANTED, https.request REFUSED (403 CLOUDFRONT-BLOCK),
// fetch() GRANTED. REPO_MANIFEST §6.61. nightly-crawl.js's doFetch, pasted VERBATIM.
// ⚠️ DO NOT "OPTIMISE" THIS BACK TO https.request, AND DO NOT SET content-length BY HAND.
// Resolves on ANY status — never throws for a 403. Returns { status, rawCookies, body, rawText }.
async function doFetch(url, bodyObj, headers) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { ...headers, 'request-id': crypto.randomUUID() },
    body:    JSON.stringify(bodyObj),
  });
  const rawText = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(rawText); } catch (_) { body = null; }
  // undici exposes each Set-Cookie separately; the joined header is the fallback for
  // older runtimes. Callers expect an array or undefined, never an empty array.
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return {
    status:     res.status,
    rawCookies: cookies.length ? cookies : undefined,
    body,
    rawText,
  };
}

// ─── AIMD. From discover-org-seasons.js L184-235, unchanged. ─────────────────
const AIMD_MIN = 3, AIMD_CUT = 0.6, AIMD_RECOVER = 10;
const AIMD_CLEAN_BATCHES_TO_RECOVER = 2;
const AIMD_BLOCKED_BATCHES_TO_LOWER_CAP = 3;
const AIMD_BACKOFF_MS = 5000;

async function aimdRun(items, label, worker, opts = {}) {
  const cap0 = Math.max(AIMD_MIN, opts.cap || 25);
  const queue = items.slice();          // blocked items go to the BACK, never dropped
  let cap = cap0, concurrency = cap0;
  let consecutiveBlocked = 0, cleanBatches = 0;
  let done = 0, blockedEvents = 0, givenUp = 0;
  const attempts = new Map();
  const startTime = Date.now();
  let lastLog = startTime;

  while (queue.length) {
    const batch = queue.splice(0, concurrency);
    const results = await Promise.allSettled(batch.map(async (item) => {
      const r = await worker(item);
      return { item, blocked: !!(r && r.blocked) };
    }));

    let batchBlocked = 0;
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value.blocked) {
        const key = opts.key ? opts.key(res.value.item) : res.value.item;
        const n = (attempts.get(key) || 0) + 1;
        attempts.set(key, n);
        // Giving up is REPORTED, never silent. A season we stopped asking about
        // must not be counted alongside one PlayHQ actually answered.
        if (n >= (opts.maxAttempts || 6)) { givenUp++; done++; continue; }
        batchBlocked++; blockedEvents++; queue.push(res.value.item);
      } else done++;
    }

    if (batchBlocked > 0) {
      consecutiveBlocked++; cleanBatches = 0;
      concurrency = Math.max(AIMD_MIN, Math.floor(concurrency * AIMD_CUT));
      if (consecutiveBlocked >= AIMD_BLOCKED_BATCHES_TO_LOWER_CAP) { cap = Math.max(AIMD_MIN, cap - 5); concurrency = Math.min(concurrency, cap); }
      const backoff = Math.min(60000, consecutiveBlocked * AIMD_BACKOFF_MS);
      console.log(`    ⚠ ${label}: ${batchBlocked} blocked in batch → conc=${concurrency} cap=${cap}, backoff ${backoff / 1000}s (queued ${queue.length})`);
      await sleep(backoff);
    } else {
      consecutiveBlocked = 0; cleanBatches++;
      if (cleanBatches >= AIMD_CLEAN_BATCHES_TO_RECOVER) { concurrency = Math.min(cap, concurrency + AIMD_RECOVER); cleanBatches = 0; }
    }

    const now = Date.now();
    if (now - lastLog >= 15000) {
      lastLog = now;
      const el = (now - startTime) / 1000, rate = el > 0 ? done / el : 0;
      console.log(`    …${label} ${done} done, ${queue.length} queued  conc=${concurrency} cap=${cap}  rate=${rate.toFixed(1)}/s`);
    }
  }
  return { done, blockedEvents, givenUp };
}

// ─── The query. From discover-org-seasons.js L266. ───────────────────────────
const Q_DISCOVER_SEASON = {
  operationName: 'gradeListDiscoverSeason',
  query: `query gradeListDiscoverSeason($id: String!) {
  discoverSeason(seasonID: $id) {
    id name
    competition { id name type organisation { id name } }
    grades { id name age { name } gender { name } }
  }
}`,
};

async function gql(body, label) {
  await ensureSession();
  let res;
  try {
    res = await doFetch(API_URL, body, { ...HEADERS_BASE, 'Cookie': sessionCookie });
  } catch (err) { return { kind: 'error', err }; }

  if (res.status === 403) {
    const b = res.rawText || '';
    // A CloudFront block is a transport problem; an application 403 is an answer.
    if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { kind: 'blocked' };
    return { kind: 'forbidden' };
  }
  if (res.status === 429 || res.status === 503) return { kind: 'blocked' };
  if (res.status < 200 || res.status >= 300) return { kind: 'error', err: new Error(`HTTP ${res.status} (${label})`) };

  const json = res.body;
  if (!json) return { kind: 'error', err: new Error(`unparseable body: ${(res.rawText || '').slice(0, 80)}`) };
  if (json.errors?.length) return { kind: 'error', err: new Error(json.errors[0]?.message || 'gql') };
  return { kind: 'ok', data: json.data || json };
}

// ─── THE BUG GUARD, exercised here before it goes into the discovery script. ──
// The version in discover-org-seasons.js returns null for "answered with nothing",
// "forbidden" and "errored" alike, so the caller cannot tell an answer from the
// absence of one. This returns a tagged outcome. `answered` is the field that
// decides whether a result may be written to the index at all.
async function lookupSeason(id) {
  const r = await gql({ ...Q_DISCOVER_SEASON, variables: { id } }, 'discoverSeason');
  if (r.kind === 'blocked')   return { answered: false, blocked: true,  reason: 'cloudfront-block' };
  if (r.kind === 'forbidden') return { answered: false, blocked: false, reason: 'forbidden (application 403)' };
  if (r.kind === 'error')     return { answered: false, blocked: false, reason: `error: ${(r.err && r.err.message) || '?'}` };
  // ok with a null season IS an answer — PlayHQ was asked and served nothing.
  return { answered: true, blocked: false, season: (r.data && r.data.discoverSeason) || null };
}

async function main() {
  log(`audit-removed-org-seasons  READ-ONLY${LIMIT ? `  limit=${LIMIT}` : ''}  concurrency=${CONCURRENCY}`);
  console.log('─'.repeat(78));

  const index   = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const all     = Object.values(index.seasons || {});
  const targets = all.filter(s => s.discoveredBy === 'org' && s.removed === true);

  // The selector's blast radius, printed so it can be checked rather than trusted.
  const removedAll = all.filter(s => s.removed === true).length;
  console.log(`  seasons in index               : ${all.length}`);
  console.log(`  removed:true (all)             : ${removedAll}`);
  console.log(`  removed:true NOT from org      : ${removedAll - targets.length}   ← untouched by this audit`);
  console.log(`  discoveredBy:org               : ${all.filter(s => s.discoveredBy === 'org').length}`);
  console.log(`  SELECTED (org AND removed)     : ${targets.length}`);

  const byStatus = {};
  for (const s of targets) byStatus[s.status || '(null)'] = (byStatus[s.status || '(null)'] || 0) + 1;
  console.log(`  selected by status             : ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`);

  if (!targets.length) { log('nothing selected — nothing to size.'); return; }

  const queue = LIMIT ? targets.slice(0, LIMIT) : targets;
  if (LIMIT) console.log(`  limited to first ${queue.length} for this run`);

  console.log('');
  log(`re-asking PlayHQ for ${queue.length} season(s)…`);

  const outcome = new Map();   // sid -> { answered, season, reason }
  const r = await aimdRun(queue, 'lookup', async (s) => {
    const o = await lookupSeason(s.id);
    if (o.blocked) return { blocked: true };          // requeued, not recorded
    outcome.set(s.id, o);
    return { blocked: false };
  }, { cap: CONCURRENCY, key: (s) => s.id, maxAttempts: 6 });

  const repairable = [], trulyEmpty = [], notServed = [], noAnswer = [];
  for (const s of queue) {
    const o = outcome.get(s.id);
    if (!o)                       { noAnswer.push({ s, why: 'blocked out after 6 attempts' }); continue; }
    if (!o.answered)              { noAnswer.push({ s, why: o.reason }); continue; }
    if (!o.season)                { notServed.push({ s }); continue; }
    const g = (o.season.grades || []).length;
    if (g > 0) repairable.push({ s, grades: g, name: o.season.name });
    else       trulyEmpty.push({ s });
  }

  // ── Per-season detail. A counter without examples is a number you cannot check.
  const row = (x, extra) => `    ${x.s.id}  ${String(x.s.endDate || '?').padEnd(10)}  ${String(extra).padStart(4)}  ${(x.s.fullName || x.s.name || '').slice(0, 58)}`;

  console.log(`\n─── REPAIRABLE — PlayHQ served the season and it HAS grades ─────────────`);
  console.log(`    the removed:true flag on these is WRONG`);
  if (!repairable.length) console.log('    (none)');
  for (const x of repairable.sort((a, b) => b.grades - a.grades)) console.log(row(x, x.grades));

  console.log(`\n─── TRULY EMPTY — PlayHQ served the season and it has NO grades ─────────`);
  console.log(`    the removed:true flag on these is CORRECT; leave them alone`);
  if (!trulyEmpty.length) console.log('    (none)');
  for (const x of trulyEmpty) console.log(row(x, 0));

  console.log(`\n─── NOT SERVED — ok response, discoverSeason returned null ──────────────`);
  console.log(`    PlayHQ will not serve this id at all`);
  if (!notServed.length) console.log('    (none)');
  for (const x of notServed) console.log(row(x, '-'));

  console.log(`\n─── NO ANSWER — still unknown, NOT a finding ────────────────────────────`);
  console.log(`    re-run for these; do not treat them as either of the above`);
  if (!noAnswer.length) console.log('    (none)');
  for (const x of noAnswer) console.log(`${row(x, '?')}   [${x.why}]`);

  // ── The sizing number ──────────────────────────────────────────────────────
  const totalGrades = repairable.reduce((a, x) => a + x.grades, 0);
  const gradeCounts = repairable.map(x => x.grades).sort((a, b) => a - b);
  const median = gradeCounts.length ? gradeCounts[Math.floor(gradeCounts.length / 2)] : 0;

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`  asked                : ${queue.length}   (${r.blockedEvents} block events, ${r.givenUp} gave up after 6 attempts)`);
  console.log(`  repairable           : ${repairable.length}`);
  console.log(`  truly empty          : ${trulyEmpty.length}`);
  console.log(`  not served           : ${notServed.length}`);
  console.log(`  no answer            : ${noAnswer.length}`);
  console.log(`  ${'-'.repeat(74)}`);
  console.log(`  GRADES TO BE ADDED   : ${totalGrades}${LIMIT ? `   (from ${queue.length} of ${targets.length} — scale before deciding)` : ''}`);
  console.log(`  per season           : min ${gradeCounts[0] || 0}, median ${median}, max ${gradeCounts[gradeCounts.length - 1] || 0}`);
  console.log(`${'═'.repeat(78)}`);
  console.log(`\n  That grade total is what a repair would add to EVERY nightly run, not just`);
  console.log(`  the first one: nightly-crawl.js builds its work list from the grades of`);
  console.log(`  every season at locked:false, and it never writes sports-index.json, so`);
  console.log(`  nothing ever locks a COMPLETED season once it has been crawled.`);
  if (noAnswer.length) console.log(`\n  ⚠ ${noAnswer.length} season(s) went unanswered — this sizing is INCOMPLETE. Re-run.`);
  log('read-only — nothing written, nothing committed.');
}

main().catch(err => { console.error(`FATAL: ${err.stack || err.message}`); process.exit(1); });
