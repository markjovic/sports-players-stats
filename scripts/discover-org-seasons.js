// scripts/discover-org-seasons.js
//
// TOP-DOWN season discovery. Asks every organisation what competitions it runs
// and what seasons each has, and adds any season sports-index.json does not hold.
//
// WHY THIS EXISTS ALONGSIDE discover-seasons.js
// ─────────────────────────────────────────────
// discover-seasons.js works BOTTOM-UP: it probes players' publicProfileTeams and
// reads season ids off their registrations. That was the only route known to work
// - playhq_api_reference.md records "discoverOrganisation for BV: returns null for
// guest sessions" and "team roster before first game: not accessible - reconstruct
// BOTTOM-UP from individual players' UPCOMING regs".
//
// That note is about discoverOrganisation. `discoverCompetitions(organisationID)`
// is a different query and it works on a guest session. Captured 2026-09-07
// against Kilsyth Basketball (5433b0e3): it returned five competitions with every
// season each has ever run, INCLUDING two with status UPCOMING - Junior Domestic
// Summer 2026/27 (5e26f10f, starts 2026-10-06) and Senior Domestic Summer 2026/27
// (8f43ff68, starts 2026-09-20).
//
// The difference that matters: the bottom-up probe cannot see a season until a
// player has registered in it. This sees it the moment the association creates it,
// with no registrations at all. One request per organisation - a few hundred -
// against 418,000 player probes.
//
// It does NOT replace discover-seasons.js. That one also backfills player rosters
// and resolves grades from registrations; this only finds seasons.
//
// WHERE ORG IDS COME FROM
// ───────────────────────
// data/sports-index.json - every season already recorded carries orgId. So the
// org list is whatever associations we already know about, which is every one BV
// has ever run a season for. A brand-new association appears only once one of its
// seasons is found some other way; that is a real limit and it is stated here
// rather than hidden.
//
// EVERY REQUEST SHAPE IS COPIED FROM discover-seasons.js, NOT REWRITTEN. Headers,
// cookie queries, the promise-locked session, doFetch with keepAlive:false, the
// 403/429 ladder, and gitCommit. Those run against the real API on a schedule, so
// a wrong shape fails loudly there; a hand-written one fails quietly here.
//
// THE GUARD, ADDED 2026-09-08
// ───────────────────────────
// The first live run wrote 80 COMPLETED seasons as removed:true because their
// grade lookup was CloudFront-blocked, not because PlayHQ has no grades. The old
// discoverSeason returned null for "answered with nothing", "forbidden" and
// "errored" alike, so buildEntry could not tell an answer from the absence of one
// and recorded the failure as a fact. removed:true is permanent — the grade
// refresh in discover-seasons.js selects locked:false only, so nothing re-asks.
//
// lookupSeason now returns a tagged outcome and buildEntry refuses to write a
// season it got no answer about. Those are left out and re-found by the next daily
// run, which is exactly what discover-seasons.js does. A run with unanswered
// seasons reports itself INCOMPLETE rather than clean.
//
// THE REPAIR, --repair-removed
// ────────────────────────────
// Undoes the 80. Re-asks each and repairs only those that come back with grades.
// Sized first by audit-removed-org-seasons.js, live on 2026-09-08: 52 have grades
// (239 total), 28 genuinely have none, 0 unanswered. The 28 are correctly flagged
// and are left alone. The 274 removed:true stubs from other sources are outside
// the selector and asserted untouched before anything commits.
//
// Run:
//   node scripts/discover-org-seasons.js --dry-run
//   node scripts/discover-org-seasons.js
//   node scripts/discover-org-seasons.js --season=5e26f10f     (one season, direct)
//   node scripts/discover-org-seasons.js --org=5433b0e3        (one organisation)
//   node scripts/discover-org-seasons.js --repair-removed --dry-run
//   node scripts/discover-org-seasons.js --repair-removed
//   node scripts/discover-org-seasons.js --backfill-dates --dry-run
//   node scripts/discover-org-seasons.js --backfill-dates

'use strict';

const fs           = require('fs');
const path         = require('path');
const https        = require('https');
const crypto       = require('crypto');
const { execSync } = require('child_process');

const ROOT           = path.join(__dirname, '..');
const INDEX_FILE     = path.join(ROOT, 'data', 'sports-index.json');
const INDEX_FILE_REL = 'data/sports-index.json';
const API_URL        = 'https://api.playhq.com/graphql';

const args   = process.argv.slice(2);
const argVal = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const DRY_RUN     = args.includes('--dry-run');
const REPAIR      = args.includes('--repair-removed');
const BACKFILL    = args.includes('--backfill-dates');
const ONE_SEASON  = argVal('season', '');
const ONE_ORG     = argVal('org', '');
const CONCURRENCY = Math.max(1, parseInt(argVal('concurrency', '8'), 10) || 8);

const log = (m) => console.log(`[org-seasons] ${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Organisations PlayHQ no longer serves ───────────────────────────────────
// The org list is rebuilt from the orgId on every recorded season, so an
// organisation stays in the sweep for as long as ANY of its seasons is in the index
// — even a removed:true stub. 59363a37 "Testing Basketball Association 1" was
// deleted at PlayHQ's end: discoverCompetitions answers "Organisation could not be
// found" on every single run, and has done since at least 2026-09-08.
//
// Its four seasons are PlayHQ's own test fixtures — "Comp Dan test", "Shim Test",
// "00 Dal domestic comp with players", "Finals Eligibility Comp" — all already
// removed:true, locked:true, zero grades. They hold nothing.
//
// SKIPPED HERE RATHER THAN DELETED FROM THE INDEX. Deleting the four stubs would
// stop the error today and not tomorrow: the list is rebuilt from the index every
// run, so any future discovery that re-recorded one of those seasons would bring the
// organisation straight back. Skipping the org id is the durable fix, and it is
// reversible by deleting one line.
//
// REPORTED, NEVER SILENT. A permanent unexplained error line trains everyone to
// ignore the error line, which is the real harm — the failure itself is harmless.
// An entry here is a claim that an organisation is gone; it should be re-checked if
// the count ever changes unexpectedly.
const DEAD_ORGS = new Map([
  ['59363a37', 'Testing Basketball Association 1 — deleted at PlayHQ; its 4 seasons are test fixtures, all removed:true stubs'],
]);

// Named explicitly with --org, a dead organisation is still asked. The skip is for
// the automatic sweep; an operator asking directly should get the real answer.
function pruneDeadOrgs(orgList) {
  const kept = orgList.filter(([id]) => !DEAD_ORGS.has(id));
  for (const [id, why] of DEAD_ORGS) {
    if (orgList.some(([oid]) => oid === id)) log(`skipping dead organisation ${id} — ${why}`);
  }
  return kept;
}

// ─── Headers: the full set, never split. Copied from discover-seasons.js L150. ─
const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── Session: promise-locked, copied from discover-seasons.js L161-236 ────────
let sessionCookie = null, sessionPromise = null, sessionAt = 0;
const SESSION_MAX_AGE_MS = 15 * 60 * 1000;
// \u26a0\ufe0f 2026-09-29 — ORDER REVERSED. TenantConfig WAS BEING REFUSED, AND THE
// ProfileSearch THAT FOLLOWED IT ON THE SAME CONNECTION WAS REFUSED TOO.
//
// On 2026-09-28/29 every attempt here failed with HTTP 403, no set-cookie, CloudFront
// block page, on BOTH queries — while discover-fixtures.js and the profile matrix hit
// the same API from the same runner in the same hours and succeeded, bootstrapping
// with ProfileSearch ALONE. Headers identical, runner image identical. The only
// difference was TenantConfig going first, which is why ProfileSearch failing HERE
// and working THERE is what needs explaining rather than ProfileSearch being broken.
//
// ProfileSearch now goes first. TenantConfig is kept as a fallback rather than
// deleted: the evidence is behavioural and PlayHQ may change it back.
const COOKIE_QUERIES = [
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
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
          res = await doFetch(API_URL, { method: 'POST', headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() }, body: JSON.stringify(body) });
        } catch (err) {
          console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: fetch threw ${err.code || ''} ${err.message}`);
          throw err;
        }
        const raw = res.headers.get('set-cookie');
        if (!raw) {
          // The same instrumentation discover-seasons.js carries: a silent continue
          // here is where a CloudFront block page vanishes without trace.
          let b = ''; try { b = await res.text(); } catch {}
          const sniff = b.includes('Request blocked') ? `CLOUDFRONT-BLOCK (${b.length}b HTML)`
                      : b.includes('DOCTYPE')         ? `HTML page (${b.length}b): ${b.slice(0, 80)}`
                      : (b.slice(0, 120) || '(empty body)');
          console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: HTTP ${res.status}, NO set-cookie, body: ${sniff.replace(/\s+/g, ' ')}`);
          continue;
        }
        const parts = raw.split(',').map(c => c.trim().split(';')[0]);
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

// ─── doFetch: copied from discover-seasons.js L515. keepAlive:false is what keeps
//     CloudFront's per-connection rate limiting off us - do not pool. ───────────
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

// ─── AIMD, copied from discover-seasons.js L293-418 ──────────────────────────
// The 2026-09-07 run resolved grades in a plain for-loop with a fixed 120ms sleep
// and NO backoff. It got 14 seasons through, hit the CloudFront wall, and then
// asked 164 more times at a steady 130ms apart — every one blocked. The seasons
// were still created, but 84 landed with grades:[] because the lookup was refused,
// not because PlayHQ has none. Compare the ones that got through first: Bendigo 72
// grades, Altona Bay 38, Swan Hill 16.
//
// aimdRun requeues a blocked item to the BACK of the queue instead of dropping it,
// cuts concurrency to 60% on any blocked batch, lowers the cap after three
// consecutive blocked batches, backs off 5s × consecutive blocked batches, and
// recovers +10 after two clean ones. Nothing here is tuned differently - the
// numbers are the ones already proven against this API.
const AIMD_MIN         = 3;
const AIMD_CUT         = 0.6;
const AIMD_RECOVER     = 10;
const AIMD_CLEAN_BATCHES_TO_RECOVER = 2;
const AIMD_BLOCKED_BATCHES_TO_LOWER_CAP = 3;
const AIMD_BACKOFF_MS  = 5000;

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
        // A ceiling, so a permanently-refused item cannot spin the queue forever.
        // Giving up is REPORTED, never silent: a season left without grades because
        // we stopped asking must not look like a season with no grades.
        if (n >= (opts.maxAttempts || 4)) { givenUp++; done++; continue; }
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

// ─── The query ────────────────────────────────────────────────────────────────
// Reduced to the fields this needs from the shape captured off PlayHQ's own site
// on 2026-09-07. Their version also pulls OrganisationDetails, logos, contacts and
// tenantConfiguration; none of that is used here and asking for it would be a
// bigger response for nothing. The competitions/seasons selection is unchanged.
//
// organisationID and organisationCode are the SAME value in the captured call
// (both "5433b0e3"), so only organisationID is needed once discoverOrganisation is
// dropped.
const Q_ORG_COMPETITIONS = {
  operationName: 'discoverCompetitions',
  query: `query discoverCompetitions($organisationID: ID!) {
  discoverCompetitions(organisationID: $organisationID) {
    id
    name
    seasons(organisationID: $organisationID) {
      id
      name
      startDate
      endDate
      status { name value }
    }
    organisation { id name }
  }
}`,
};

// discoverSeason, for --season and for resolving grades on a newly found season.
// Copied from discover-seasons.js L258.
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
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify(body),
    });
  } catch (err) { return { kind: 'error', err }; }

  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch {}
    // A CloudFront block is a transport problem; an application 403 is an answer.
    // Conflating them is how a blocked run gets recorded as "nothing found".
    if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { kind: 'blocked' };
    return { kind: 'forbidden' };
  }
  if (res.status === 429 || res.status === 503) return { kind: 'blocked' };
  if (!res.ok) return { kind: 'error', err: new Error(`HTTP ${res.status} (${label})`) };

  let json; try { json = await res.json(); } catch (err) { return { kind: 'error', err }; }
  if (json.errors?.length) return { kind: 'error', err: new Error(json.errors[0]?.message || 'gql') };
  return { kind: 'ok', data: json.data || json };
}

// ─── THE GUARD. Returns a TAGGED outcome, never a bare null. ─────────────────
// The previous version returned null for THREE different things — PlayHQ answered
// with nothing, the request was forbidden, and the request errored — so the caller
// could not tell an answer from the absence of one. buildEntry then read "no
// grades came back" as "this season has no grades", and on 2026-09-07 that wrote
// 80 COMPLETED seasons as removed:true off the back of a CloudFront block. That
// state is permanent: discover-seasons.js's grade-refresh selects locked:false
// only, so nothing ever re-asks.
//
// `answered` is the field that decides whether a result may be written at all.
// A season we never got an answer about is left out of the index entirely and
// re-found by the next daily run — which is what discover-seasons.js does.
//
// Verified live 2026-09-08 by audit-removed-org-seasons.js: 80 lookups, 0 blocked,
// 0 unanswered, and it split the 80 cleanly into 52 with grades and 28 without.
async function lookupSeason(id) {
  const r = await gql({ ...Q_DISCOVER_SEASON, variables: { id } }, 'discoverSeason');
  if (r.kind === 'blocked')   return { answered: false, blocked: true,  reason: 'cloudfront-block' };
  if (r.kind === 'forbidden') return { answered: false, blocked: false, reason: 'forbidden (application 403)' };
  if (r.kind === 'error')     return { answered: false, blocked: false, reason: `error: ${(r.err && r.err.message) || '?'}` };
  // ok with a null season IS an answer: PlayHQ was asked and served nothing.
  return { answered: true, blocked: false, season: (r.data && r.data.discoverSeason) || null };
}

// ─── git: copied from discover-seasons.js L465 ────────────────────────────────
const GIT_OPTS = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const PUSH_ATTEMPTS = 60;

function gitCommit(msg, paths = []) {
  if (DRY_RUN) return;
  const uniq = [...new Set(paths)].filter(Boolean);
  if (!uniq.length) { log('nothing to commit (no paths given).'); return; }
  let addFailures = 0;
  for (const p of uniq) {
    try { execSync(`git add -- ${p}`, GIT_OPTS); }
    catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      if (/did not match any file/i.test(detail)) continue;
      addFailures++;
      console.error(`  ⚠ git add FAILED "${p}": ${detail}`);
    }
  }
  const staged = execSync('git diff --staged --shortstat', GIT_OPTS).toString().trim();
  if (!staged) {
    if (addFailures) throw new Error(`gitCommit: nothing staged and ${addFailures} path(s) failed to stage — refusing to report a clean no-op ("${msg}")`);
    log('nothing to commit.'); return;
  }
  log(`staging: ${staged}`);
  execSync(`git commit -q -m "${msg}"`, GIT_OPTS);
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try { execSync('git merge --abort', GIT_OPTS); } catch {}
    try {
      execSync('git fetch origin main', GIT_OPTS);
      execSync('git merge -q -X ours FETCH_HEAD --no-edit --no-stat', GIT_OPTS);
      execSync('git push origin main', GIT_OPTS);
      log(`pushed${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      if (attempt === PUSH_ATTEMPTS) throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${e.message.split('\n')[0]}`);
      execSync(`sleep ${1 + Math.floor(Math.random() * 91)}`, { stdio: 'pipe' });
    }
  }
}

// ─── Build a season entry ─────────────────────────────────────────────────────
// Same shape and the same locked/removed rules as discover-seasons.js L562-587,
// so an entry created here is indistinguishable from one created there.
//
// THE GUARD APPLIES HERE. `outcome.answered === false` means we never learned
// anything about this season's grades, and an entry must NOT be built from that.
// Writing one turns a transport failure into a recorded answer — for a COMPLETED
// season, permanently. The season is left out and the next daily run re-finds it.
function buildEntry(sid, meta, outcome) {
  if (!outcome || outcome.answered !== true) return { entry: null, kind: 'unresolved' };
  const ds = outcome.season || null;
  const grades  = (ds?.grades || []).map(g => ({ id: g.id, name: g.name, age: g.age?.name, gender: g.gender?.name }));
  const compName = ds?.competition?.name || meta.compName || '';
  const orgName  = ds?.competition?.organisation?.name || meta.orgName || '';
  const base = {
    id: sid,
    name: ds?.name || meta.name,
    fullName: `${compName} — ${ds?.name || meta.name}`,
    compName,
    compId: ds?.competition?.id || meta.compId,
    orgName,
    orgId: ds?.competition?.organisation?.id || meta.orgId,
    tenant: 'bv',
    status: meta.status || null,
    startDate: meta.startDate || null,
    endDate: meta.endDate || null,
    discoveredBy: 'org',        // provenance: which route found it
  };
  if (grades.length > 0) return { entry: { ...base, grades, locked: false, addedAt: new Date().toISOString() }, kind: 'created' };
  // Everything below is a real ANSWER of "no grades" - PlayHQ was asked and told
  // us. That is now the only way to reach removed:true.
  //
  // COMPLETED with no grades is not crawlable - record existence only. Anything
  // else with no grades is a pre-allocation: live, awaiting grades. That is the
  // normal state of an UPCOMING season and exactly what this tool is for.
  if (meta.status === 'COMPLETED') return { entry: { ...base, grades: [], locked: true, removed: true, addedAt: new Date().toISOString() }, kind: 'removed' };
  return { entry: { ...base, grades: [], locked: false, addedAt: new Date().toISOString() }, kind: 'pre-allocated' };
}

// ─── BACKFILL MODE ────────────────────────────────────────────────────────────
// Fills status / startDate / endDate on seasons ALREADY in the index.
//
// WHY THIS EXISTS. The sweep in main() asks all 183 organisations for every season
// they have ever run, and discoverCompetitions returns status, startDate and
// endDate for every one of them - confirmed on Kilsyth 2026-09-08, with seasons
// going back to Summer 2020/21. Line 483 then throws all of that away for any
// season id already known. Measured the same day: only 639 of 3,431 seasons carry
// an endDate, and 418 of the 703 UNLOCKED seasons have never had their status
// asked at all - between them holding 8,106 grades, 85% of what the nightly
// fetches every night.
//
// So the dates were never missing from PlayHQ. They were being fetched daily and
// discarded. This costs no extra requests: the same 183 calls, read properly.
//
// METADATA ONLY. It writes status, startDate and endDate and NOTHING else.
// It does not lock, unlock, add, remove, or touch grades - even when PlayHQ says a
// season is COMPLETED and we hold it unlocked. Acting on that is the season
// lifecycle rule, which is a separate deliberate piece. Four assertions below
// enforce that before anything commits.
async function backfillDates() {
  log(`backfill-dates${DRY_RUN ? '  (DRY RUN)' : ''}${ONE_ORG ? `  org=${ONE_ORG}` : ''}`);
  console.log('─'.repeat(70));

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  index.seasons = index.seasons || {};
  const before = Object.values(index.seasons);
  const countBefore   = before.length;
  const lockedBefore  = before.filter(s => s.locked === true).length;
  const removedBefore = before.filter(s => s.removed === true).length;
  const gradesBefore  = before.reduce((t, s) => t + (s.grades || []).length, 0);
  const missingBefore = before.filter(s => !s.endDate).length;

  console.log(`  seasons in index          : ${countBefore}`);
  console.log(`  already carrying endDate  : ${countBefore - missingBefore}`);
  console.log(`  MISSING endDate           : ${missingBefore}`);

  const orgs = new Map();
  for (const se of before) if (se.orgId && !orgs.has(se.orgId)) orgs.set(se.orgId, se.orgName || se.orgId);
  const orgList = ONE_ORG ? [[ONE_ORG, orgs.get(ONE_ORG) || ONE_ORG]] : pruneDeadOrgs([...orgs]);
  log(`organisations to ask: ${orgList.length}`);

  // Captured BEFORE the sweep. `before` holds the SAME object references as
  // index.seasons, so mutating an entry mutates it in `before` too — reading
  // "did this have an endDate?" from there after the fact always says yes, and
  // the filled counter could never fire. Verified 2026-09-08: it reported 0
  // filled while filling five.
  const hadEndDate = new Set(before.filter(s => s.endDate).map(s => s.id));

  const seen = new Set();
  let filled = 0, changed = 0, same = 0, newSeen = 0, blocked = 0, errors = 0, done = 0;
  const changes = [];

  for (let i = 0; i < orgList.length; i += CONCURRENCY) {
    const batch = orgList.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async ([orgId, orgName]) => {
      const r = await gql({ ...Q_ORG_COMPETITIONS, variables: { organisationID: orgId } }, 'discoverCompetitions');
      return { orgId, orgName, r };
    }));
    for (const { orgId, orgName, r } of results) {
      done++;
      if (r.kind === 'blocked')   { blocked++; continue; }
      if (r.kind === 'forbidden') { continue; }
      if (r.kind !== 'ok')        { errors++; console.log(`  ⚠ ${orgId} ${orgName}: ${r.err?.message}`); continue; }

      for (const comp of (r.data.discoverCompetitions || [])) {
        for (const se of (comp.seasons || [])) {
          if (!se?.id) continue;
          const e = index.seasons[se.id];
          // A season this sweep returns that we do not hold is NEW. Counted and
          // reported, never added here - adding is the discover task's job, and
          // it resolves grades before writing. Adding one here would create an
          // entry with no grades and no lookup behind it.
          if (!e) { newSeen++; continue; }
          seen.add(se.id);

          const want = { status: se.status?.value || null, startDate: se.startDate || null, endDate: se.endDate || null };
          const diffs = [];
          for (const k of ['status', 'startDate', 'endDate']) {
            if (want[k] == null) continue;                      // never overwrite with nothing
            if (e[k] === want[k]) continue;
            diffs.push(`${k} ${e[k] === undefined ? '(absent)' : JSON.stringify(e[k])} → ${JSON.stringify(want[k])}`);
            e[k] = want[k];
          }
          if (!diffs.length) { same++; continue; }
          if (e.endDate && !hadEndDate.has(se.id)) filled++; else changed++;
          if (changes.length < 40) changes.push(`  ↻ ${se.id}  ${(e.fullName || e.name || '').slice(0, 46).padEnd(46)}  ${diffs.join('; ')}`);
        }
      }
    }
    if (done % 50 === 0 || done === orgList.length) log(`asked ${done}/${orgList.length} organisations`);
    if (i + CONCURRENCY < orgList.length) await sleep(300);
  }

  const neverSeen = before.filter(s => !seen.has(s.id));
  const neverSeenNoDate = neverSeen.filter(s => !s.endDate);

  if (changes.length) { console.log(''); for (const c of changes) console.log(c); if (filled + changed > changes.length) console.log(`  … and ${filled + changed - changes.length} more`); }

  // ── Assertions. This is a metadata backfill. If it has altered lifecycle state
  //    in any way, that is a bug and nothing may be committed.
  const after = Object.values(index.seasons);
  if (after.length !== countBefore)                                        throw new Error(`ABORT: season count changed ${countBefore} → ${after.length}. Nothing committed.`);
  if (after.filter(s => s.locked === true).length !== lockedBefore)         throw new Error(`ABORT: locked count changed. This mode must never lock or unlock. Nothing committed.`);
  if (after.filter(s => s.removed === true).length !== removedBefore)       throw new Error(`ABORT: removed count changed. Nothing committed.`);
  if (after.reduce((t, s) => t + (s.grades || []).length, 0) !== gradesBefore) throw new Error(`ABORT: grade total changed. This mode must never touch grades. Nothing committed.`);

  const missingAfter = after.filter(s => !s.endDate).length;
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  endDate filled in        : ${filled}`);
  console.log(`  values corrected         : ${changed}`);
  console.log(`  already correct          : ${same}`);
  console.log(`  seasons PlayHQ returned  : ${seen.size} of ${countBefore}`);
  console.log(`  NEVER RETURNED by any org: ${neverSeen.length}   (${neverSeenNoDate.length} of them still have no endDate)`);
  console.log(`  new seasons seen, NOT added: ${newSeen}   ← run task=discover for these`);
  console.log(`  blocked organisations    : ${blocked}   ← NOT an answer`);
  console.log(`  errored organisations    : ${errors}`);
  console.log(`  ${'-'.repeat(66)}`);
  console.log(`  MISSING endDate          : ${missingBefore} → ${missingAfter}`);
  console.log(`  assertions               : PASSED — locked, removed, grades and count all unchanged`);
  console.log(`${'═'.repeat(70)}`);

  if (neverSeenNoDate.length) {
    console.log(`\n  ${neverSeenNoDate.length} season(s) no organisation returned and that still have no endDate.`);
    console.log(`  discoverCompetitions may not reach far enough back, or the competition is`);
    console.log(`  archived at PlayHQ. Oldest few by season name:`);
    for (const s of neverSeenNoDate.slice(0, 8)) console.log(`    ${s.id}  ${(s.fullName || s.name || '').slice(0, 54)}`);
  }
  if (blocked) console.log(`\n  \u26a0 ${blocked} organisation(s) blocked — this backfill is INCOMPLETE. Re-run.`);

  if (!(filled + changed)) { log('nothing to write.'); return; }
  if (DRY_RUN) { log('dry run — sports-index.json not written.'); return; }
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
  gitCommit(`discover-org-seasons: backfilled dates on ${filled + changed} season(s)`, [INDEX_FILE_REL]);
  log('metadata only — no season was locked, unlocked, added or removed.');
}

async function main() {
  log(`discover-org-seasons${DRY_RUN ? '  (DRY RUN)' : ''}${ONE_SEASON ? `  season=${ONE_SEASON}` : ''}${ONE_ORG ? `  org=${ONE_ORG}` : ''}`);
  console.log('─'.repeat(70));

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  index.seasons = index.seasons || {};
  const known = new Set(Object.keys(index.seasons));
  log(`known seasons: ${known.size}`);

  const found = [];     // { sid, meta }
  let blocked = 0, errors = 0;

  // ── --season: one id, straight to discoverSeason ────────────────────────────
  if (ONE_SEASON) {
    if (known.has(ONE_SEASON)) {
      const e = index.seasons[ONE_SEASON];
      log(`ALREADY KNOWN: ${ONE_SEASON}  ${e.fullName || e.name}  locked=${e.locked}  grades=${(e.grades || []).length}  status=${e.status}`);
      log('nothing to do. If the nightly is not crawling it, locked/grades is where to look.');
      return;
    }
    const o = await lookupSeason(ONE_SEASON);
    if (!o.answered) { console.error(`NO ANSWER for ${ONE_SEASON}: ${o.reason}. Nothing written — try again from a fresh runner.`); process.exit(1); }
    const ds = o.season;
    if (!ds) { console.error(`PlayHQ served nothing for ${ONE_SEASON}. Wrong id, or it will not serve that season.`); process.exit(1); }
    // status stays null here: discoverSeason does not return it, and guessing
    // COMPLETED would risk writing removed:true off an assumption. A null status
    // falls to the pre-allocated branch, which is recoverable either way.
    found.push({ sid: ONE_SEASON, meta: { name: ds.name, compName: ds.competition?.name, compId: ds.competition?.id, orgName: ds.competition?.organisation?.name, orgId: ds.competition?.organisation?.id, status: null, startDate: null, endDate: null }, outcome: o });
    log(`found ${ONE_SEASON}  "${ds.name}"  ${ds.competition?.organisation?.name || ''}  ${(ds.grades || []).length} grades`);
  } else {
    // ── Org sweep ────────────────────────────────────────────────────────────
    const orgs = new Map();
    for (const se of Object.values(index.seasons)) {
      if (se.orgId && !orgs.has(se.orgId)) orgs.set(se.orgId, se.orgName || se.orgId);
    }
    const orgList = ONE_ORG ? [[ONE_ORG, orgs.get(ONE_ORG) || ONE_ORG]] : pruneDeadOrgs([...orgs]);
    log(`organisations to ask: ${orgList.length}`);

    let done = 0;
    for (let i = 0; i < orgList.length; i += CONCURRENCY) {
      const batch = orgList.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async ([orgId, orgName]) => {
        const r = await gql({ ...Q_ORG_COMPETITIONS, variables: { organisationID: orgId } }, 'discoverCompetitions');
        return { orgId, orgName, r };
      }));
      for (const { orgId, orgName, r } of results) {
        done++;
        if (r.kind === 'blocked')   { blocked++; continue; }
        if (r.kind === 'forbidden') { continue; }
        if (r.kind !== 'ok')        { errors++; console.log(`  ⚠ ${orgId} ${orgName}: ${r.err?.message}`); continue; }
        for (const comp of (r.data.discoverCompetitions || [])) {
          for (const se of (comp.seasons || [])) {
            if (!se?.id || known.has(se.id)) continue;
            if (found.some(f => f.sid === se.id)) continue;
            found.push({ sid: se.id, meta: {
              name: se.name, compName: comp.name, compId: comp.id,
              orgName: comp.organisation?.name || orgName, orgId: comp.organisation?.id || orgId,
              status: se.status?.value || null, startDate: se.startDate || null, endDate: se.endDate || null,
            } });
            console.log(`  ✦ new: ${se.id}  ${comp.name} — ${se.name}  (${se.status?.value || '?'}, ${se.startDate || '?'})  ${orgName}`);
          }
        }
      }
      if (done % 50 === 0 || done === orgList.length) log(`asked ${done}/${orgList.length} organisations, ${found.length} new season(s) so far`);
      if (i + CONCURRENCY < orgList.length) await sleep(300);
    }
    if (blocked) log(`⛔ ${blocked} organisation(s) were CloudFront-blocked and were NOT asked — re-run for those.`);
  }

  if (!found.length) {
    log(`no seasons found that are not already in the index.${blocked ? ' NOTE: some orgs were blocked, so this is not a complete answer.' : ''}`);
    return;
  }

  // ── Resolve grades for each new season ─────────────────────────────────────
  const needGrades = found.filter(f => !f.outcome);
  if (needGrades.length) {
    log(`\nresolving grades for ${needGrades.length} new season(s) (AIMD, cap ${CONCURRENCY})…`);
    const r = await aimdRun(needGrades, 'grades', async (f) => {
      const o = await lookupSeason(f.sid);
      if (o.blocked) return { blocked: true };          // requeued, not discarded
      f.outcome = o;                                    // tagged: answered or not
      return { blocked: false };
    }, { cap: CONCURRENCY, key: (f) => f.sid, maxAttempts: 4 });
    const stillNone = needGrades.filter(f => !f.outcome || f.outcome.answered !== true).length;
    log(`grades resolved for ${needGrades.length - stillNone}/${needGrades.length}  (${r.blockedEvents} block events, ${r.givenUp} gave up after 4 attempts)`);
    if (stillNone) {
      // These are now LEFT OUT, not written blind. Previously they were written
      // with grades:[], and for a COMPLETED season that meant removed:true - a
      // transport failure recorded as an answer, permanently.
      log(`⚠ ${stillNone} season(s) got NO ANSWER and will NOT be written. The next daily run re-finds them.`);
    }
  }

  let created = 0, removedN = 0, prealloc = 0, unresolved = 0;
  const byStatus = new Map();
  for (const f of found) {
    const { entry, kind } = buildEntry(f.sid, f.meta, f.outcome);
    if (kind === 'unresolved') {
      unresolved++;
      const why = (f.outcome && f.outcome.reason) || 'blocked out after 4 attempts';
      console.log(`  · ${'NOT WRITTEN'.padEnd(14)} ${f.sid}  ${f.meta.compName || ''} — ${f.meta.name || ''}  (${f.meta.status || '?'})  [${why}]`);
      continue;
    }
    index.seasons[f.sid] = entry;
    if (kind === 'created') created++; else if (kind === 'removed') removedN++; else prealloc++;
    byStatus.set(f.meta.status || '?', (byStatus.get(f.meta.status || '?') || 0) + 1);
    console.log(`  ${kind === 'removed' ? '~' : '+'} ${kind.padEnd(14)} ${f.sid}  ${entry.fullName}  (${(entry.grades || []).length} grades, ${entry.status || '?'})`);
  }

  console.log(`\n  seasons found    : ${found.length}`);
  console.log(`    with grades    : ${created}`);
  console.log(`    pre-allocated  : ${prealloc}  (live, awaiting grades — the UPCOMING case)`);
  console.log(`    recorded only  : ${removedN}  (COMPLETED, PlayHQ ANSWERED "no grades", not crawlable)`);
  console.log(`    NOT WRITTEN    : ${unresolved}  (no answer — left for the next daily run)`);
  console.log(`  by status        : ${[...byStatus].map(([k, v]) => `${k}=${v}`).join('  ') || '(none written)'}`);
  if (unresolved) {
    console.log(`\n  \u26a0 ${unresolved} season(s) went unanswered. This run is INCOMPLETE by design —`);
    console.log(`    writing them blind is what put 80 seasons at removed:true on 2026-09-07.`);
  }

  const written = created + removedN + prealloc;
  if (!written) { log('nothing written.'); return; }
  if (DRY_RUN) { log('dry run — sports-index.json not written.'); return; }
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
  gitCommit(`discover-org-seasons: ${written} new season(s) (${prealloc} pre-allocated, ${unresolved} unanswered)`, [INDEX_FILE_REL]);
  log('the nightly crawl picks up anything with locked:false on its next run.');
}

// ─── REPAIR MODE ──────────────────────────────────────────────────────────────
// Undoes the damage the missing guard caused on 2026-09-07. Selects seasons this
// tool wrote as removed:true, re-asks PlayHQ, and repairs only the ones that come
// back WITH grades. Everything else is left exactly as it is.
//
// SIZED BEFORE BUILT. audit-removed-org-seasons.js ran live on 2026-09-08 against
// all 80: 52 have grades (239 in total), 28 genuinely have none, 0 unanswered.
// The 28 are correctly flagged and this must not touch them. Repairing all 80
// would have been as wrong as leaving all 80.
//
// The 274 removed:true stubs that did NOT come from this tool are outside the
// selector and are asserted untouched before anything is committed.
async function repairRemoved() {
  log(`repair-removed${DRY_RUN ? '  (DRY RUN)' : ''}`);
  console.log('─'.repeat(70));

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const all = Object.values(index.seasons || {});
  const targets = all.filter(s => s.discoveredBy === 'org' && s.removed === true);

  const removedBefore = all.filter(s => s.removed === true).length;
  const foreignBefore = removedBefore - targets.length;
  console.log(`  seasons in index          : ${all.length}`);
  console.log(`  removed:true (all)        : ${removedBefore}`);
  console.log(`  removed:true NOT from org : ${foreignBefore}   ← must be unchanged at the end`);
  console.log(`  SELECTED                  : ${targets.length}`);
  if (!targets.length) { log('nothing selected — nothing to repair.'); return; }

  const outcome = new Map();
  const r = await aimdRun(targets, 'repair-lookup', async (s) => {
    const o = await lookupSeason(s.id);
    if (o.blocked) return { blocked: true };            // requeued, not recorded
    outcome.set(s.id, o);
    return { blocked: false };
  }, { cap: CONCURRENCY, key: (s) => s.id, maxAttempts: 6 });

  let repaired = 0, correctlyEmpty = 0, servedNothing = 0, noAnswer = 0, gradesAdded = 0;
  for (const s of targets) {
    const o = outcome.get(s.id);
    if (!o || o.answered !== true) {
      noAnswer++;
      console.log(`  · no answer     ${s.id}  ${s.fullName}  [${(o && o.reason) || 'blocked out after 6 attempts'}]`);
      continue;
    }
    if (!o.season) { servedNothing++; console.log(`  · not served    ${s.id}  ${s.fullName}  (left as removed:true)`); continue; }
    const grades = (o.season.grades || []).map(g => ({ id: g.id, name: g.name, age: g.age?.name, gender: g.gender?.name }));
    if (!grades.length) { correctlyEmpty++; console.log(`  = correct       ${s.id}  ${s.fullName}  (PlayHQ has no grades — left alone)`); continue; }

    // Repair in place. addedAt is preserved because the season really was
    // discovered then; repairedAt records the correction, and is the selector if
    // this ever needs unwinding.
    const e = index.seasons[s.id];
    e.grades = grades;
    e.locked = false;
    delete e.removed;
    e.repairedAt = new Date().toISOString();
    repaired++; gradesAdded += grades.length;
    console.log(`  ↻ repaired      ${s.id}  ${s.fullName}  (${grades.length} grades, now locked:false)`);
  }

  // ── Assertions. A repair that silently hits the wrong rows is worse than none.
  const after = Object.values(index.seasons);
  const removedAfter = after.filter(s => s.removed === true).length;
  const foreignAfter = after.filter(s => s.removed === true && s.discoveredBy !== 'org').length;
  if (foreignAfter !== foreignBefore) throw new Error(`ABORT: removed:true stubs not from this tool changed ${foreignBefore} → ${foreignAfter}. Nothing committed.`);
  if (removedBefore - removedAfter !== repaired) throw new Error(`ABORT: removed:true fell by ${removedBefore - removedAfter} but ${repaired} were repaired. Nothing committed.`);
  if (after.length !== all.length) throw new Error(`ABORT: season count changed ${all.length} → ${after.length}. Nothing committed.`);

  console.log(`\n  repaired        : ${repaired}   (+${gradesAdded} grades, now crawlable)`);
  console.log(`  correctly empty : ${correctlyEmpty}   (left as removed:true)`);
  console.log(`  not served      : ${servedNothing}   (left as removed:true)`);
  console.log(`  no answer       : ${noAnswer}   (left untouched — re-run for these)`);
  console.log(`  ${'-'.repeat(66)}`);
  console.log(`  removed:true    : ${removedBefore} → ${removedAfter}   (foreign stubs ${foreignBefore} → ${foreignAfter}, unchanged)`);
  console.log(`  assertions      : PASSED — count, selector and blast radius all hold`);
  console.log(`  block events    : ${r.blockedEvents}, gave up ${r.givenUp}`);
  if (noAnswer) console.log(`\n  \u26a0 ${noAnswer} unanswered — this repair is INCOMPLETE. Re-run it.`);

  if (!repaired) { log('nothing repaired — index not written.'); return; }
  if (DRY_RUN) { log('dry run — sports-index.json not written.'); return; }
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
  gitCommit(`discover-org-seasons: repaired ${repaired} removed:true season(s), +${gradesAdded} grades`, [INDEX_FILE_REL]);
  log(`the nightly picks these up on its next run — ${gradesAdded} extra grades on a 9,516 baseline.`);
}

const entry = REPAIR ? repairRemoved : (BACKFILL ? backfillDates : main);
entry().catch(err => { console.error(`FATAL: ${err.stack || err.message}`); process.exit(1); });
