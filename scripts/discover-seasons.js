// scripts/discover-seasons.js
//
// PIECE 1 — season DETECTION (find new seasons early, self-terminating).
//
// Probes current-season players' publicProfileTeams registrations for season IDs
// not yet in sports-index.json, and creates them (locked:false) so the nightly
// crawl picks them up. This is the pre-round-1 discovery path: publicProfileTeams
// returns UPCOMING/ACTIVE registrations, so a player who has registered for next
// season surfaces it before any game is played — the tool's USP.
//
// One player suffices to discover a season (it appears on every re-registered
// player), so the probe shuffles current-season players and STOPS once it has
// gone --stop-after probes with no new season — self-terminating.
//
// Probing uses TWO strategies depending on mode:
//   SHARD mode (matrix MAP role) — BURST + CURSOR. Proven: a fresh runner IP probes
//   clean (~17/s) for ~300+ calls, then the per-IP WAF wall drops it to a crawl that
//   doesn't recover on that IP. So we probe in fixed batches and STOP DEAD at the
//   first walled batch — no backoff, no grind — saving a cursor (players/total for
//   this shard) into an artifact. The matrix workflow's control loop re-triggers
//   with a FRESH runner (fresh IP) to continue from the cursor, until the shard is
//   fully swept. This is faster and cleaner than grinding a spent IP, and should
//   eliminate most of the elevated error rate seen when a wall degrades responses.
//   Whole-population mode (standalone --full / --uuid, single IP, no shard) — ADAPTIVE
//   CONCURRENCY (AIMD): can't rotate IPs on one runner, so it backs off and grinds
//   through instead (cuts to 60% + backs off on a blocked batch, recovers on clean
//   ones, re-queues blocked items — never drops them). Kept for manual/adhoc use.
// Session is refreshed on AGE (~30-40min TTL; concurrency-safe via the promise lock),
// never on a block (a per-IP WAF block is not a bad cookie — matches fetch-profile-
// stats.js). Headers, cookie handling and doFetch are copied verbatim from
// fetch-profile-stats.js. Queries are copied from fetch-playhq.js /
// playhq_api_reference.md — never write PlayHQ queries from scratch.
//
// Modes:
//   node scripts/discover-seasons.js --shard=XX --cursor=N --out=discover-shard-XX.json
//                                                      # MAP: burst-probe from cursor, stop dead at wall
//   node scripts/discover-seasons.js --reduce --in=<dir>
//                                                      # REDUCE: merge artifacts + cursors → index + progress
//   node scripts/discover-seasons.js --all-players   # (map) probe every player, not just current-season
//   node scripts/discover-seasons.js                 # legacy standalone (single-IP AIMD; walls at scale)
//   node scripts/discover-seasons.js --concurrency=N # burst batch size (shard) / AIMD cap (standalone), default 25
//   node scripts/discover-seasons.js --uuid=<id>     # manual escape hatch: probe one player
//   node scripts/discover-seasons.js --dry-run       # report only, no writes/commit
//   node scripts/discover-seasons.js --backfill-teams # extract pre-season rosters into players/ and team-lookup/
//
// PRODUCTION PATH is the sharded matrix (discover-seasons-matrix.yml): shard MAP jobs
// each get a fresh runner IP, burst-probe until walled, save a cursor; a control loop
// self-triggers remaining (not-yet-done) shards on fresh runners until all 256 are
// swept; one REDUCE job (per trigger) merges + resolves grades + writes the index and
// progress file. The legacy standalone path is kept for --uuid / adhoc.
//
// Piece 2 (roster-fill, triggered when new seasons are found) is a separate step.

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const https        = require('https');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const API_URL     = 'https://api.playhq.com/graphql';
const INDEX_FILE  = path.join(ROOT, 'data', 'sports-index.json');
const PROGRESS_FILE = path.join(ROOT, 'data', 'discover-progress.json');   // per-shard cursor/done (matrix resume state)
const PLAYERS_DIR = path.join(ROOT, 'players');

// Ensure the Layer 1 team lookup directory exists
const TEAM_LOOKUP_DIR = path.join(process.cwd(), 'team-lookup', 'bv');
if (!fs.existsSync(TEAM_LOOKUP_DIR)) fs.mkdirSync(TEAM_LOOKUP_DIR, { recursive: true });

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const BACKFILL_TEAMS = args.includes('--backfill-teams');
// If backfill is on, force ALL_PLAYERS to true so it scans everyone
const ALL_PLAYERS = args.includes('--all-players') || BACKFILL_TEAMS;   
const DRY_RUN = args.includes('--dry-run');
const DEBUG_TEAMS = args.includes('--debug-teams');  // dump raw grade/season per registration
const FULL      = args.includes('--full');
const ONE_UUID  = (args.find(a => a.startsWith('--uuid=')) || '').replace('--uuid=', '').trim() || null;
const LIMIT     = (() => { const a = args.find(a => a.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : Infinity; })();
const STOP_AFTER = (() => { const a = args.find(a => a.startsWith('--stop-after=')); return a ? parseInt(a.split('=')[1], 10) : 1000; })();
const CONCURRENCY = (() => { const a = args.find(a => a.startsWith('--concurrency=')); const n = a ? parseInt(a.split('=')[1], 10) : 25; return Number.isFinite(n) && n > 0 ? n : 25; })();
// Matrix roles: --shard=XX (+ --out=path) is the MAP role (probe one shard's players,
// emit discovered seasons as a JSON artifact — no index write). --reduce (+ --in=dir)
// is the REDUCE role (merge all shard artifacts, resolve grades, write sports-index).
const SHARD       = (args.find(a => a.startsWith('--shard=')) || '').replace('--shard=', '').trim().toLowerCase() || null;
const OUT_FILE    = (args.find(a => a.startsWith('--out=')) || '').replace('--out=', '').trim() || null;
const REDUCE      = args.includes('--reduce');
const IN_DIR      = (args.find(a => a.startsWith('--in=')) || '').replace('--in=', '').trim() || null;
const CURSOR       = (() => { const a = args.find(a => a.startsWith('--cursor=')); const n = a ? parseInt(a.split('=')[1], 10) : 0; return Number.isFinite(n) && n >= 0 ? n : 0; })();
const CHECK_SEASONS = (args.find(a => a.startsWith('--check-seasons=')) || '').replace('--check-seasons=', '').split(',').filter(Boolean);
const CHECK_KNOWN   = (() => { const a = args.find(a => a.startsWith('--check-known=')); return a ? parseInt(a.split('=')[1], 10) : 0; })();
const PROBE_TEAM    = (args.find(a => a.startsWith('--probe-team=')) || '').replace('--probe-team=', '').trim() || null;
const HOLD_CHECK    = (args.find(a => a.startsWith('--hold-check=')) || '').replace('--hold-check=', '').split(',').filter(Boolean);

// ─── Headers — full set, never split, never modified (copied verbatim) ────────
const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── Session cookie (promise-locked; copied verbatim from fetch-profile-stats) ─
let sessionCookie  = null;
let sessionPromise = null;
let sessionAt      = 0;   // epoch ms of the last successful refresh (for age-based refresh)
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

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
        sessionAt = Date.now();
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

// ─── Queries (copied: publicProfileTeams from fetch-playhq.js; ───────────────
//     gradeListDiscoverSeason from fetch-playhq.js — grades carry age+gender to
//     match the sports-index entry shape) ──────────────────────────────────────
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

const Q_TEAM_FIXTURE = {
  operationName: 'TeamFixture',
  query: `query TeamFixture($teamID: ID!) {
  discoverTeam(teamID: $teamID) {
    id
    grade { id name }
    season { id name competition { id name organisation { id name } } status { value } }
    organisation { id name }
  }
  discoverTeamFixture(teamID: $teamID) {
    id name isFinalsRound
    grade { id name season { id name competition { id name organisation { id name } } } }
    fixture { games { id dates status { value } } }
  }
}`,
};

const SESSION_MAX_AGE_MS = 15 * 60 * 1000;
async function ensureSession() {
  if (sessionCookie && (Date.now() - sessionAt) < SESSION_MAX_AGE_MS) return;
  await refreshSession();
}

const AIMD_MIN         = 3;
const AIMD_CUT         = 0.6;
const AIMD_RECOVER     = 10;
const AIMD_CLEAN_BATCHES_TO_RECOVER = 2;
const AIMD_BLOCKED_BATCHES_TO_LOWER_CAP = 3;
const AIMD_BACKOFF_MS  = 5000;   // × consecutive blocked batches

// ─── Typed probe: publicProfileTeams → { kind, teams } ────────────────────────
async function probeTeams(profileID) {
  await ensureSession();

  const body = { ...Q_PROFILE_TEAMS, variables: { profileID } };
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
    if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { kind: 'blocked' };
    return { kind: 'private' };   // application 403 — inaccessible profile
  }
  if (res.status === 429 || res.status === 503) return { kind: 'blocked' };   // rate signal → AIMD backs off
  if (!res.ok) return { kind: 'error', err: new Error(`HTTP ${res.status}`) };

  let json; try { json = await res.json(); } catch (err) { return { kind: 'error', err }; }
  if (json.errors?.length) return { kind: 'error', err: new Error(json.errors[0]?.message || 'gql') };
  const teams = (json.data || json)?.publicProfileTeams;
  return { kind: 'ok', teams: Array.isArray(teams) ? teams : [] };
}

// ─── discoverSeason → grades + competition (for creating the season entry) ────
async function discoverSeason(seasonID) {
  await ensureSession();
  const body = { ...Q_DISCOVER_SEASON, variables: { id: seasonID } };
  let res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify(body),
    });
  } catch { return null; }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch {}
    if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { blocked: true };
    return null;
  }
  if (!res.ok) return null;
  let json; try { json = await res.json(); } catch { return null; }
  if (json.errors?.length) return null;
  return (json.data || json)?.discoverSeason || null;
}

// ─── Build current-season player list from player files ───────────────────────
function currentSeasonPlayers(activeSids, { shard = null, allPlayers = false } = {}) {
  const uuids = [];
  const prefixes = shard ? [shard] : fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS_DIR, prefix);
    if (!fs.existsSync(dir)) continue;
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
      const uuid = fname.replace('.json', '');
      if (allPlayers) { uuids.push(uuid); continue; }   // backlog pass: every player, incl. historical-only
      let player; try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
      const inActive = (player.seasons || []).some(s => activeSids.has(s.sid) && (s.regs || []).length > 0);
      if (inActive) uuids.push(uuid);
    }
  }
  uuids.sort();   // deterministic order — required for the shard cursor to mean the same thing across runs
  return uuids;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function aimdRun(items, label, worker, opts = {}) {
  const cap0 = Math.max(AIMD_MIN, opts.cap || 25);
  const shouldStop = opts.shouldStop || (() => false);
  const progress   = opts.progress   || (() => '');
  const queue = items.slice();          // requeued (blocked) items go to the back
  let cap = cap0, concurrency = cap0;
  let consecutiveBlocked = 0, cleanBatches = 0;
  let done = 0, blockedEvents = 0;
  const startTime = Date.now();
  let lastLog = startTime;

  while (queue.length && !shouldStop()) {
    const batch = queue.splice(0, concurrency);
    const results = await Promise.allSettled(batch.map(async (item) => {
      const r = await worker(item);
      return { item, blocked: !!(r && r.blocked) };
    }));

    let batchBlocked = 0;
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value.blocked) { batchBlocked++; blockedEvents++; queue.push(res.value.item); }
      else done++;   // fulfilled-clean, or rejected (worker guards its own errors)
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
      const eta = rate > 0 ? queue.length / rate / 60 : 0;
      console.log(`    …${label} ${done} done, ${queue.length} queued  conc=${concurrency} cap=${cap}  rate=${rate.toFixed(1)}/s eta≈${eta.toFixed(1)}m${progress()}`);
    }
  }
  return { done, blockedEvents };
}

async function burstRun(items, concurrency, worker) {
  let completed = 0;
  for (let start = 0; start < items.length; start += concurrency) {
    const batch = items.slice(start, start + concurrency);
    const results = await Promise.allSettled(batch.map(async (item) => {
      const r = await probeTeams(item);
      return { item, r };
    }));
    const anyBlocked = results.some(res => res.status === 'fulfilled' && res.value.r.kind === 'blocked');
    if (anyBlocked) return { completed, wallHit: true };
    for (const res of results) {
      if (res.status === 'fulfilled') worker(res.value.item, res.value.r);
      else console.log(`  ⚠ unexpected rejection probing ${res.reason?.item || '?'}`);
    }
    completed = start + batch.length;
  }
  return { completed, wallHit: false };
}

function gitCommit(msg, extraPaths = []) {
  if (DRY_RUN) return;
  try {
    execSync(`git add data/sports-index.json ${extraPaths.join(' ')}`.trim(), { cwd: ROOT, stdio: 'pipe' });
    const staged = execSync('git diff --staged --shortstat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!staged) { console.log('  Nothing to commit.'); return; }
    execSync('git fetch origin main', { cwd: ROOT, stdio: 'pipe' });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { cwd: ROOT, stdio: 'pipe' });
    execSync(`git commit -m "${msg}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git push origin main', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ ${msg}`);
  } catch (e) {
    console.error('  ✗ git:', (e.stderr?.toString() || e.message).slice(0, 200));
  }
}

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

async function applyDiscoveries(index, newSeasonMeta, stats = {}, extraCommitPaths = []) {
  const { probed = 0, blockedEvents = 0, privateN = 0, errors = 0, t0 = Date.now() } = stats;

  let created = 0, removed = 0;
  const metaEntries = [...newSeasonMeta];
  const dsById = new Map();
  if (metaEntries.length) {
    console.log(`\n  Resolving grades for ${metaEntries.length} new season(s) (AIMD cap ${CONCURRENCY})…`);
    await aimdRun(metaEntries, 'grade-resolve', async ([sid]) => {
      const ds = await discoverSeason(sid);
      if (ds && ds.blocked) return { blocked: true };   // requeue — don't store a block as the result
      dsById.set(sid, ds);
      return { blocked: false };
    }, { cap: CONCURRENCY });
  }
  for (const [sid, meta] of metaEntries) {
    const ds = dsById.get(sid);
    if (ds?.blocked) { console.log(`  ⛔ blocked resolving grades for ${sid} — leaving for next run`); continue; }
    const grades = (ds?.grades || []).map(g => ({ id: g.id, name: g.name, age: g.age?.name, gender: g.gender?.name }));
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
    };
    if (grades.length > 0) {
      index.seasons[sid] = { ...base, grades, locked: false, addedAt: new Date().toISOString() };
      created++;
      console.log(`  + created ${sid}  ${base.fullName}  (${grades.length} grades)`);
    } else if (meta.status === 'COMPLETED') {
      index.seasons[sid] = { ...base, grades: [], locked: true, removed: true, addedAt: new Date().toISOString() };
      removed++;
      console.log(`  ~ removed ${sid}  ${base.fullName}  (COMPLETED, 0 grades — recorded, not crawlable)`);
    } else {
      index.seasons[sid] = { ...base, grades: [], locked: false, addedAt: new Date().toISOString() };
      created++;
      console.log(`  + created ${sid}  ${base.fullName}  (0 grades — pre-allocation, live; awaiting grades)`);
    }
  }

  // ── Grade-refresh: fill grades for active seasons still at grades:[] ──────────
  let refreshed = 0;
  const graceless = Object.values(index.seasons).filter(se => se.locked === false && (se.grades || []).length === 0);
  if (graceless.length) {
    console.log(`\n  Grade-refresh: ${graceless.length} active grade-less season(s) to re-check (AIMD cap ${CONCURRENCY})`);
    const refreshDs = new Map();
    await aimdRun(graceless, 'grade-refresh', async (se) => {
      const ds = await discoverSeason(se.id);
      if (ds && ds.blocked) return { blocked: true };   // requeue
      refreshDs.set(se.id, ds);
      return { blocked: false };
    }, { cap: CONCURRENCY });
    for (const se of graceless) {
      const ds = refreshDs.get(se.id);
      if (ds?.blocked) { console.log(`  ⛔ blocked refreshing ${se.id}`); continue; }
      const g = (ds?.grades || []).map(x => ({ id: x.id, name: x.name, age: x.age?.name, gender: x.gender?.name }));
      if (g.length > 0) {
        se.grades = g;
        refreshed++;
        console.log(`  ↻ ${se.id}  ${se.fullName || se.name}  now has ${g.length} grades`);
      }
    }
  }

  if ((created > 0 || removed > 0 || refreshed > 0 || extraCommitPaths.length > 0) && !DRY_RUN) {
    if (created > 0 || removed > 0 || refreshed > 0) fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
    gitCommit(`discover-seasons: ${created} new + ${removed} removed + ${refreshed} grade-refreshed`, extraCommitPaths);
  }

  console.log('\n─── Summary ─────────────────────────────────────────────────────────');
  if (probed) {
    console.log(`  Players probed        : ${probed}`);
    console.log(`  Elapsed / throughput  : ${((Date.now() - t0) / 60000).toFixed(1)}m  @ ${(probed / Math.max(1, (Date.now() - t0) / 1000)).toFixed(1)}/s`);
    console.log(`  Private / error       : ${privateN} / ${errors}`);
    console.log(`  Block events (requeued): ${blockedEvents}`);
  }
  console.log(`  New seasons resolved  : ${newSeasonMeta.size}`);
  console.log(`  Seasons created       : ${created}${DRY_RUN ? ' (dry-run — none written)' : ''}`);
  console.log(`  Removed stubs         : ${removed}${DRY_RUN ? ' (dry-run — none written)' : ''}`);
  console.log(`  Grade-refreshed       : ${refreshed}${DRY_RUN ? ' (dry-run — none written)' : ''}`);
  if (newSeasonMeta.size > created + removed) console.log(`  (${newSeasonMeta.size - created - removed} left for next run — grade resolution blocked)`);
  console.log('─'.repeat(60));
  if (created > 0) console.log('\nNext: roster-fill (piece 2) should run for the new season(s) until round 1 completes.');
  console.log('Done.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\ndiscover-seasons.js${DRY_RUN ? '  [dry-run]' : ''}${FULL ? '  [full]' : ''}${SHARD ? `  [shard=${SHARD}]` : ''}${REDUCE ? '  [reduce]' : ''}${ALL_PLAYERS ? '  [all-players]' : ''}${ONE_UUID ? `  [uuid=${ONE_UUID}]` : ''}`);
  console.log('─'.repeat(60));

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  index.seasons = index.seasons || {};
  const knownSeasonIds = new Set(Object.keys(index.seasons));
  const activeSids = new Set(Object.values(index.seasons).filter(s => !s.locked).map(s => s.id));
  console.log(`  Known seasons: ${knownSeasonIds.size}  (active: ${activeSids.size})`);

  if (REDUCE) {
    if (!IN_DIR || !fs.existsSync(IN_DIR)) { console.error(`--reduce needs --in=<dir> (got ${IN_DIR})`); process.exit(1); }
    const t0 = Date.now();
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('discover-shard-') && e.name.endsWith('.json')) files.push(p);
    } };
    walk(IN_DIR);
    console.log(`  Reduce: reading ${files.length} shard artifact(s) from ${IN_DIR}`);

    let progress = {};
    if (fs.existsSync(PROGRESS_FILE)) { try { progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { progress = {}; } }

    const merged = new Map();
    let shardProbed = 0, wallHits = 0, doneCount = 0, undoneShards = [];
    for (const f of files) {
      let a; try { a = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { console.log(`  ⚠ unreadable artifact ${f} — skipped`); continue; }
      shardProbed += a.probed || 0;
      if (a.wallHit) wallHits++;
      for (const [sid, meta] of Object.entries(a.discovered || {})) {
        if (knownSeasonIds.has(sid) || merged.has(sid)) continue;
        merged.set(sid, meta);
      }
      if (a.shard) {
        progress[a.shard] = { mode: a.mode, cursor: a.cursor, total: a.total, done: a.done, updatedAt: a.at };
        if (a.done) doneCount++; else undoneShards.push(a.shard);
      }
    }
    console.log(`  Merged ${merged.size} distinct new season(s) across ${files.length} shard(s) (probed ${shardProbed}, wall hits ${wallHits}).`);
    console.log(`  Shard progress: ${doneCount} done, ${undoneShards.length} not yet complete this sweep.`);

    if (!DRY_RUN) fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
    await applyDiscoveries(index, merged, { t0 }, [PROGRESS_FILE]);

    console.log(`UNDONE_SHARDS_JSON=${JSON.stringify(undoneShards)}`);
    return;
  }

  if (PROBE_TEAM) {
    if (!sessionCookie) await refreshSession();
    const res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify({ ...Q_TEAM_FIXTURE, variables: { teamID: PROBE_TEAM } }),
    });
    console.log(`  probe-team ${PROBE_TEAM}: HTTP ${res.status}`);
    let json = null; try { json = await res.json(); } catch {}
    const d = json?.data || json;
    const team = d?.discoverTeam;
    const rounds = d?.discoverTeamFixture || [];
    if (team) console.log(`  team: "${team.name || team.id}"  season=${team.season?.id} "${team.season?.name}" (${team.season?.status?.value})  org=${team.organisation?.name}`);
    let totalGames = 0; const byStatus = {};
    for (const r of rounds) for (const g of (r.fixture?.games || [])) { totalGames++; const sv = g.status?.value || '?'; byStatus[sv] = (byStatus[sv] || 0) + 1; }
    console.log(`  rounds returned: ${rounds.length}   games: ${totalGames}   by status: ${JSON.stringify(byStatus)}`);
    console.log(totalGames > 0 ? '  → RECOVERABLE via team path (games exist).' : '  → no games via team path (genuinely unfetchable).');
    console.log('\nProbe done.');
    return;
  }

  if (HOLD_CHECK.length) {
    const GAMES_DIR = path.join(ROOT, 'games', 'bv');
    const tally = new Map();  
    for (const sid of HOLD_CHECK) tally.set(sid, { regs: 0, withStats: 0, teams: new Set() });
    const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
    for (const prefix of prefixes) {
      const dir = path.join(PLAYERS_DIR, prefix);
      for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
        let pl; try { pl = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
        for (const sn of (pl.seasons || [])) {
          const t = tally.get(sn.sid); if (!t) continue;
          for (const reg of (sn.regs || [])) {
            t.regs++;
            if (reg.tid) t.teams.add(reg.tid);
            const st = reg.stats || {};
            if ((st.gp || 0) > 0 || (st.pts || 0) > 0) t.withStats++;
          }
        }
      }
    }
    console.log('\n  Local hold-check (no API):');
    console.log('  ' + 'sid'.padEnd(12) + 'gameFile'.padEnd(10) + 'gamesInFile'.padEnd(13) + 'playerRegs'.padEnd(12) + 'regsWithStats'.padEnd(15) + 'teams');
    for (const sid of HOLD_CHECK) {
      const f = path.join(GAMES_DIR, `${sid}.json`);
      let gf = 'no', games = '-';
      if (fs.existsSync(f)) { gf = 'YES'; try { games = Object.keys(JSON.parse(fs.readFileSync(f,'utf8')).games || {}).length; } catch { games = 'ERR'; } }
      const t = tally.get(sid);
      console.log(`  ${sid.padEnd(12)}${gf.padEnd(10)}${String(games).padEnd(13)}${String(t.regs).padEnd(12)}${String(t.withStats).padEnd(15)}${t.teams.size}`);
    }
    console.log('\n  Reading: regsWithStats>0 means players have played-game evidence for a season');
    console.log('  we have no game file for → real recoverable data on disk. 0 across the board');
    console.log('  → we hold nothing for it either; a stub is genuinely all it can be.');
    console.log('\nHold-check done.');
    return;
  }

  if (CHECK_SEASONS.length || CHECK_KNOWN > 0) {
    let ids = [...CHECK_SEASONS];
    if (CHECK_KNOWN > 0) {
      const known = Object.values(index.seasons);
      const completed = known.filter(s => (s.grades || []).length > 0);
      for (let i = completed.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [completed[i],completed[j]]=[completed[j],completed[i]]; }
      ids.push(...completed.slice(0, CHECK_KNOWN).map(s => s.id));
    }
    console.log(`\n  discoverSeason grade-availability check (${ids.length} seasons):`);
    console.log('  ' + 'sid'.padEnd(12) + 'idxGrades'.padEnd(11) + 'apiGrades'.padEnd(11) + 'org');
    for (const sid of ids) {
      const idxEntry = index.seasons[sid];
      const idxGrades = (idxEntry?.grades || []).length;
      const ds = await discoverSeason(sid);
      const apiGrades = ds?.blocked ? 'BLOCKED' : (ds?.grades?.length ?? 'null');
      const org = ds?.competition?.organisation?.name || idxEntry?.orgName || '?';
      console.log(`  ${String(sid).padEnd(12)}${String(idxGrades).padEnd(11)}${String(apiGrades).padEnd(11)}${org}`);
    }
    console.log('\nDiagnostic done.');
    return;
  }

  // ── SHARD/MAP role: cursor-resumable burst probe. 
  if (SHARD && OUT_FILE) {
    console.log(`  Scanning shard ${SHARD} for ${ALL_PLAYERS ? 'ALL players' : 'current-season players'}…`);
    const full = currentSeasonPlayers(activeSids, { shard: SHARD, allPlayers: ALL_PLAYERS });
    const total = full.length;
    const toProbe = full.slice(CURSOR);
    console.log(`  Shard total: ${total}  cursor: ${CURSOR}  remaining: ${toProbe.length}  burst concurrency: ${CONCURRENCY}`);

    const newSeasonMeta = new Map();
    let probed = 0, privateN = 0, errors = 0;
    const t0 = Date.now();

    const { completed, wallHit } = await burstRun(toProbe, CONCURRENCY, (uuid, r) => {
      probed++;
      if (r.kind === 'private') { privateN++; return; }
      if (r.kind === 'error') { errors++; return; }
      if (r.kind === 'ok') {
        let fileModified = false;
        const filePath = path.join(PLAYERS_DIR, `${uuid.substring(0, 2)}`, `${uuid}.json`);
        let localPlayer = null;

        if (r.teams && r.teams.length > 0) {
          try {
            localPlayer = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!localPlayer.seasons) localPlayer.seasons = [];
          } catch (e) {
            // Ignore
          }
        }

        for (const reg of r.teams || []) {
          const se = reg.season;
          const tm = reg.team;
          if (!se?.id) continue;

          // 1. Track new seasons for the index
          if (!knownSeasonIds.has(se.id) && !newSeasonMeta.has(se.id)) {
            newSeasonMeta.set(se.id, {
              name: se.name, startDate: se.startDate, endDate: se.endDate,
              status: se.status?.value || null,
              compId: se.competition?.id, compName: se.competition?.name,
              orgId: se.competition?.organisation?.id, orgName: se.competition?.organisation?.name,
            });
            console.log(`  ✦ new season: ${se.id}  ${se.name}  (${se.status?.value || '?'})  via ${uuid}`);
          }

          // 2. BACKFILL: Update Team Lookup Directory
          if (BACKFILL_TEAMS && tm?.id && tm?.name && !DRY_RUN) {
            const teamLookupPath = path.join(TEAM_LOOKUP_DIR, `${tm.id}.json`);
            if (!fs.existsSync(teamLookupPath)) {
              fs.writeFileSync(teamLookupPath, JSON.stringify({
                id: tm.id, name: tm.name, seasonId: se.id 
              }, null, 2));
            }
          }

          // 3. BACKFILL: Update the local player's registrations
          if (BACKFILL_TEAMS && localPlayer && tm?.id) {
            let seasonObj = localPlayer.seasons.find(s => s.sid === se.id);
            if (!seasonObj) {
              seasonObj = { sid: se.id, sn: se.name, regs: [] };
              localPlayer.seasons.push(seasonObj);
            }
            const hasTeam = seasonObj.regs.find(r => r.tid === tm.id);
            if (!hasTeam) {
              seasonObj.regs.push({
                tid: tm.id, tn: tm.name, gid: reg.grade?.id || null, gn: reg.grade?.name || null, stats: {} 
              });
              fileModified = true;
              console.log(`   ➕ Added ${localPlayer.name} to ${tm.name} (${se.name})`);
            }
          }
        }

        if (fileModified && localPlayer && !DRY_RUN) {
          fs.writeFileSync(filePath, JSON.stringify(localPlayer, null, 2));
        }
      }
    });

    const newCursor = CURSOR + completed;
    const done = newCursor >= total;
    if (wallHit) console.log(`  ⛔ wall hit after ${completed} clean this run — stopping dead (cursor ${CURSOR} → ${newCursor}/${total}). Fresh runner will resume.`);
    else if (done) console.log(`  ✔ shard exhausted (cursor ${newCursor}/${total}).`);

    const discovered = Object.fromEntries(newSeasonMeta);
    const artifact = {
      shard: SHARD, mode: ALL_PLAYERS ? 'all' : 'current',
      discovered, cursor: newCursor, total, done, wallHit,
      probed, private: privateN, errors, at: new Date().toISOString(),
    };
    fs.writeFileSync(OUT_FILE, JSON.stringify(artifact));

    console.log('\n─── Shard summary ───────────────────────────────────────────────────');
    console.log(`  Shard                 : ${SHARD}`);
    console.log(`  Cursor                : ${CURSOR} → ${newCursor} / ${total}  (done=${done})`);
    console.log(`  Players probed        : ${probed}`);
    console.log(`  Elapsed / throughput  : ${((Date.now() - t0) / 60000).toFixed(1)}m  @ ${(probed / Math.max(1, (Date.now() - t0) / 1000)).toFixed(1)}/s`);
    console.log(`  Private / error       : ${privateN} / ${errors}`);
    console.log(`  New seasons discovered: ${newSeasonMeta.size}`);
    console.log(`  Artifact              : ${OUT_FILE}`);
    console.log('─'.repeat(60));
    console.log('Done.');
    return;
  }

  // ── Whole-population path (standalone: --uuid, --full, adhoc). 
  let probeList;
  if (ONE_UUID) {
    probeList = [ONE_UUID];
  } else {
    console.log('  Scanning all shards for current-season players…');
    probeList = shuffle(currentSeasonPlayers(activeSids, { shard: null, allPlayers: ALL_PLAYERS }));
    if (Number.isFinite(LIMIT)) probeList = probeList.slice(0, LIMIT);
    const selfTerminating = !FULL;
    console.log(`  Players to probe: ${probeList.length}${selfTerminating ? `  (stop-after ${STOP_AFTER} with no new season)` : ''}`);
  }

  const newSeasonMeta = new Map();
  let probed = 0, privateN = 0, errors = 0;
  let probesSinceNew = 0, stop = false;

  const total = probeList.length;
  const t0 = Date.now();
  if (!ONE_UUID) console.log(`  Probing ${total} player(s), AIMD cap ${ONE_UUID ? 1 : CONCURRENCY}…`);

  const probeStats = await aimdRun(probeList, 'probe', async (uuid) => {
    const r = await probeTeams(uuid);
    if (r.kind === 'blocked') return { blocked: true };
    probed++;

    if (ONE_UUID) {
      console.log(`  ── probe result for ${uuid}: kind=${r.kind} ──`);
      for (const reg of (r.teams || [])) {
        console.log(`    team=${reg.id} "${reg.name}"  grade=${reg.grade?.id || 'NULL'} "${reg.grade?.name || ''}"  season=${reg.season?.id} "${reg.season?.name}" (${reg.season?.status?.value})`);
      }
    }

    let foundNew = false;
    if (r.kind === 'private') { privateN++; }
    else if (r.kind === 'error') { errors++; }
    else if (r.kind === 'ok') {
      if (DEBUG_TEAMS) {
        console.log(`  ── raw publicProfileTeams for ${uuid}: ${r.teams.length} registration(s) ──`);
        for (const reg of r.teams) {
          console.log(`    team=${reg.id} "${reg.name}"  grade=${reg.grade?.id || 'NULL'} "${reg.grade?.name || ''}"  season=${reg.season?.id} "${reg.season?.name}" (${reg.season?.status?.value})`);
        }
      }

      let fileModified = false;
      const filePath = path.join(PLAYERS_DIR, `${uuid.substring(0, 2)}`, `${uuid}.json`);
      let localPlayer = null;

      if (r.teams && r.teams.length > 0) {
        try {
          localPlayer = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (!localPlayer.seasons) localPlayer.seasons = [];
        } catch (e) {
          // Ignore
        }
      }

      for (const reg of r.teams) {
        const se = reg.season;
        const tm = reg.team;
        if (!se?.id) continue;
        
        // 1. Track new seasons for the index
        if (!knownSeasonIds.has(se.id) && !newSeasonMeta.has(se.id)) {
          newSeasonMeta.set(se.id, {
            name: se.name, startDate: se.startDate, endDate: se.endDate,
            status: se.status?.value || null,
            compId: se.competition?.id, compName: se.competition?.name,
            orgId: se.competition?.organisation?.id, orgName: se.competition?.organisation?.name,
          });
          foundNew = true;
          console.log(`  ✦ new season: ${se.id}  ${se.name}  (${se.status?.value || '?'})  via ${uuid}`);
        }

        // 2. BACKFILL: Update Team Lookup Directory
        if (BACKFILL_TEAMS && tm?.id && tm?.name && !DRY_RUN) {
          const teamLookupPath = path.join(TEAM_LOOKUP_DIR, `${tm.id}.json`);
          if (!fs.existsSync(teamLookupPath)) {
            fs.writeFileSync(teamLookupPath, JSON.stringify({
              id: tm.id, name: tm.name, seasonId: se.id 
            }, null, 2));
          }
        }

        // 3. BACKFILL: Update the local player's registrations
        if (BACKFILL_TEAMS && localPlayer && tm?.id) {
          let seasonObj = localPlayer.seasons.find(s => s.sid === se.id);
          if (!seasonObj) {
            seasonObj = { sid: se.id, sn: se.name, regs: [] };
            localPlayer.seasons.push(seasonObj);
          }
          const hasTeam = seasonObj.regs.find(r => r.tid === tm.id);
          if (!hasTeam) {
            seasonObj.regs.push({
              tid: tm.id, tn: tm.name, gid: reg.grade?.id || null, gn: reg.grade?.name || null, stats: {} 
            });
            fileModified = true;
            console.log(`   ➕ Added ${localPlayer.name} to ${tm.name} (${se.name})`);
          }
        }
      }

      if (fileModified && localPlayer && !DRY_RUN) {
        fs.writeFileSync(filePath, JSON.stringify(localPlayer, null, 2));
      }
    }
    
    probesSinceNew = foundNew ? 0 : probesSinceNew + 1;

    if (!FULL && !ONE_UUID && !BACKFILL_TEAMS && probesSinceNew >= STOP_AFTER && !stop) {
      stop = true;
      console.log(`  ⏹ ${STOP_AFTER} probes with no new season — stopping dispatch (probed ${probed}).`);
    }
    return { blocked: false };
  }, {
    cap: ONE_UUID ? 1 : CONCURRENCY,
    shouldStop: () => stop,
    progress: () => `  new=${newSeasonMeta.size} priv=${privateN} err=${errors}`,
  });
  const blockedEvents = probeStats.blockedEvents;

  await applyDiscoveries(index, newSeasonMeta, { probed, blockedEvents, privateN, errors, t0 });
}

main().catch(e => { console.error(e); process.exit(1); });
