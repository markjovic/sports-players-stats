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
// Probing is CONCURRENT (bounded worker pool). publicProfileTeams has no per-call
// quota (only ProfileSeasonStatistics does — see playhq_api_reference.md) and tested
// clean to 200 concurrent, so the only real constraint is the ~30-40min cookie TTL:
// the session is refreshed on AGE (concurrency-safe via the promise lock), not on
// call count. Default --concurrency=25 sweeps ~220k current-season players in well
// under the workflow's 5h cap (sequential took ~21h). --uuid forces concurrency 1.
//
// Session/WAF machinery, headers, cookie handling and doFetch are copied verbatim
// from fetch-profile-stats.js. Queries are copied from fetch-playhq.js /
// playhq_api_reference.md — never write PlayHQ queries from scratch.
//
// Modes:
//   node scripts/discover-seasons.js                 # scan current-season players, self-terminating
//   node scripts/discover-seasons.js --full          # probe every current-season player (no early stop)
//   node scripts/discover-seasons.js --concurrency=N # parallel probe workers (default 25)
//   node scripts/discover-seasons.js --limit=200     # probe at most N (cheap test run)
//   node scripts/discover-seasons.js --uuid=<id>     # manual escape hatch: probe one player
//   node scripts/discover-seasons.js --dry-run       # report only, no writes/commit
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
const PLAYERS_DIR = path.join(ROOT, 'players');

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const DEBUG_TEAMS = args.includes('--debug-teams');  // dump raw grade/season per registration
const FULL      = args.includes('--full');
const ONE_UUID  = (args.find(a => a.startsWith('--uuid=')) || '').replace('--uuid=', '').trim() || null;
const LIMIT     = (() => { const a = args.find(a => a.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : Infinity; })();
const STOP_AFTER = (() => { const a = args.find(a => a.startsWith('--stop-after=')); return a ? parseInt(a.split('=')[1], 10) : 1000; })();
const CONCURRENCY = (() => { const a = args.find(a => a.startsWith('--concurrency=')); const n = a ? parseInt(a.split('=')[1], 10) : 25; return Number.isFinite(n) && n > 0 ? n : 25; })();
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

// Session freshness: publicProfileTeams has NO per-call quota (only
// ProfileSeasonStatistics does — playhq_api_reference.md); the sole constraint is
// the ~30-40min cookie TTL. So refresh on AGE, not on call count — which is also
// concurrency-safe, because the promise lock in refreshSession coalesces every
// simultaneous refresh into a single fetch. 15min keeps us well inside the TTL.
const SESSION_MAX_AGE_MS = 15 * 60 * 1000;
async function ensureSession() {
  if (sessionCookie && (Date.now() - sessionAt) < SESSION_MAX_AGE_MS) return;
  await refreshSession();
}

// Fleet-wide WAF backoff: when any worker sees `blocked` (CloudFront rate WAF,
// per-IP), pause the WHOLE fleet so the rate window recovers, then resume + retry.
// (publicProfileTeams is friendly — 200 concurrent tested clean — so at the default
// concurrency this should never fire; it's a safety net against a stampede.)
let pauseUntil = 0;
async function waitIfPaused() {
  while (Date.now() < pauseUntil) await sleep(Math.min(3000, pauseUntil - Date.now() + 1));
}

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
function currentSeasonPlayers(activeSids) {
  const uuids = [];
  const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS_DIR, prefix);
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
      const uuid = fname.replace('.json', '');
      let player; try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
      const inActive = (player.seasons || []).some(s => activeSids.has(s.sid) && (s.regs || []).length > 0);
      if (inActive) uuids.push(uuid);
    }
  }
  return uuids;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Bounded worker pool: `concurrency` workers pull from a shared cursor until the
// list is drained or shouldStop() returns true (in which case workers finish their
// in-flight item, then exit — no half-processed state).
async function runPool(items, concurrency, worker, shouldStop = () => false) {
  let cursor = 0;
  const runner = async () => {
    while (true) {
      if (shouldStop()) return;
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, runner));
}

function gitCommit(msg) {
  if (DRY_RUN) return;
  try {
    execSync('git add data/sports-index.json', { cwd: ROOT, stdio: 'pipe' });
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

// doFetch: https.request with keepAlive:false (copied verbatim) ────────────────
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

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\ndiscover-seasons.js${DRY_RUN ? '  [dry-run]' : ''}${FULL ? '  [full]' : ''}${ONE_UUID ? `  [uuid=${ONE_UUID}]` : ''}`);
  console.log('─'.repeat(60));

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  index.seasons = index.seasons || {};
  const knownSeasonIds = new Set(Object.keys(index.seasons));
  const activeSids = new Set(Object.values(index.seasons).filter(s => !s.locked).map(s => s.id));
  console.log(`  Known seasons: ${knownSeasonIds.size}  (active: ${activeSids.size})`);

  // ── Diagnostic: does a 0-grade season have games via the TEAM path? ─────────
  // Answers removed vs legacy vs recoverable: if discoverTeamFixture returns real
  // games for a team in the season, it's recoverable via the fixture path (not a
  // dead-end stub). Copies the TeamFixture query verbatim from discover-fixtures.js.
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

  // ── Local hold-check (NO API): what do we already hold for these seasons? ────
  // A 0-grade season was never in the index, so a game file almost certainly does
  // NOT exist. The real signal is whether player REGS reference the sid and carry
  // stats (gp/pts) — i.e. played-game evidence we hold even without a game file.
  if (HOLD_CHECK.length) {
    const GAMES_DIR = path.join(ROOT, 'games', 'bv');
    // tally regs per sid from player files
    const tally = new Map();  // sid -> { regs, withStats, games:'?', teams:Set }
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

  // ── Diagnostic: does discoverSeason return grades for KNOWN seasons? ─────────
  // Samples across competitions so we don't infer a rule from one org (N=1).
  if (CHECK_SEASONS.length || CHECK_KNOWN > 0) {
    let ids = [...CHECK_SEASONS];
    if (CHECK_KNOWN > 0) {
      const known = Object.values(index.seasons);
      const completed = known.filter(s => (s.grades || []).length > 0);   // known-good, grades present in index
      // shuffle and take a spread
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

  // Build probe list
  let probeList;
  if (ONE_UUID) {
    probeList = [ONE_UUID];
  } else {
    console.log('  Scanning player files for current-season players…');
    probeList = shuffle(currentSeasonPlayers(activeSids));
    if (Number.isFinite(LIMIT)) probeList = probeList.slice(0, LIMIT);
    console.log(`  Current-season players to probe: ${probeList.length}${FULL ? '' : `  (stop-after ${STOP_AFTER} with no new season)`}`);
  }

  // season.id -> season metadata captured from the discovering registration
  const newSeasonMeta = new Map();
  let probed = 0, blocked = 0, privateN = 0, errors = 0;
  // Saturation signal (default mode): probes since the last NEW season. Converted
  // from the old consecutive-streak so it's order-independent under concurrency —
  // it's a "have we stopped finding anything" heuristic, not a strict run.
  let probesSinceNew = 0, stop = false;

  const total = probeList.length;
  const effConc = ONE_UUID ? 1 : CONCURRENCY;
  const startTime = Date.now();
  let lastLog = startTime;
  if (!ONE_UUID) console.log(`  Probing ${total} player(s) with concurrency ${effConc}…`);

  await runPool(probeList, effConc, async (uuid) => {
    await waitIfPaused();
    let r = await probeTeams(uuid);
    if (r.kind === 'blocked') {
      // WAF hit: pause the WHOLE fleet, refresh, wait out the pause, retry once.
      blocked++;
      pauseUntil = Date.now() + 90000;
      sessionCookie = null;
      await ensureSession();
      await waitIfPaused();
      r = await probeTeams(uuid);
      if (r.kind === 'blocked') { probed++; probesSinceNew++; return; }   // give up on this one
    }
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
      // Sync block (no await): the has/set below is atomic per worker, so two
      // workers can't double-create or double-log the same new season.
      for (const reg of r.teams) {
        const se = reg.season;
        if (!se?.id) continue;
        if (knownSeasonIds.has(se.id) || newSeasonMeta.has(se.id)) continue;
        newSeasonMeta.set(se.id, {
          name: se.name, startDate: se.startDate, endDate: se.endDate,
          status: se.status?.value || null,
          compId: se.competition?.id, compName: se.competition?.name,
          orgId: se.competition?.organisation?.id, orgName: se.competition?.organisation?.name,
        });
        foundNew = true;
        console.log(`  ✦ new season: ${se.id}  ${se.name}  (${se.status?.value || '?'})  via ${uuid}`);
      }
    }
    probesSinceNew = foundNew ? 0 : probesSinceNew + 1;

    // Self-terminating (default mode only): once STOP_AFTER probes have passed with
    // no new season, stop dispatching. runPool lets in-flight workers finish, so a
    // few extra probes may land after this — harmless.
    if (!FULL && !ONE_UUID && probesSinceNew >= STOP_AFTER && !stop) {
      stop = true;
      console.log(`  ⏹ ${STOP_AFTER} probes with no new season — stopping dispatch (probed ${probed}).`);
    }

    // Verbose progress: rate + ETA heartbeat every 15s (the check-and-set is sync,
    // so exactly one worker prints per interval).
    const now = Date.now();
    if (!ONE_UUID && now - lastLog >= 15000) {
      lastLog = now;
      const el = (now - startTime) / 1000;
      const rate = el > 0 ? probed / el : 0;
      const remaining = Math.max(0, total - probed);
      const etaMin = rate > 0 ? remaining / rate / 60 : 0;
      console.log(`    …probed ${probed}/${total} (${(100 * probed / total).toFixed(1)}%)  new=${newSeasonMeta.size}  private=${privateN}  err=${errors}  blocked=${blocked}  rate=${rate.toFixed(1)}/s  eta≈${etaMin.toFixed(1)}m`);
    }
  }, () => stop);

  // Create entries for each new season. Resolve full grade lists (discoverSeason)
  // CONCURRENTLY into a side map, then apply the index writes sequentially so the
  // shared mutation order is deterministic.
  let created = 0, removed = 0;
  const metaEntries = [...newSeasonMeta];
  const dsById = new Map();
  if (metaEntries.length) {
    console.log(`\n  Resolving grades for ${metaEntries.length} new season(s) (concurrency ${CONCURRENCY})…`);
    await runPool(metaEntries, CONCURRENCY, async ([sid]) => { dsById.set(sid, await discoverSeason(sid)); });
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
      // Capture the season-status signal at creation — the future auto-lock wants it.
      status: meta.status || null,
      startDate: meta.startDate || null,
      endDate: meta.endDate || null,
    };
    if (grades.length > 0) {
      // Crawlable season — the nightly crawl will fetch these grades.
      index.seasons[sid] = { ...base, grades, locked: false, addedAt: new Date().toISOString() };
      created++;
      console.log(`  + created ${sid}  ${base.fullName}  (${grades.length} grades)`);
    } else if (meta.status === 'COMPLETED') {
      // Historical (COMPLETED) season with 0 grades and nothing fetchable via any
      // route (discoverSeason, team fixtures, or our own files). We can't populate
      // it — record that it EXISTS as a 'removed' stub, locked so the crawl and all
      // locked-filtering scripts skip it. ONLY historical seasons are stubbed.
      index.seasons[sid] = { ...base, grades: [], locked: true, removed: true, addedAt: new Date().toISOString() };
      removed++;
      console.log(`  ~ removed ${sid}  ${base.fullName}  (COMPLETED, 0 grades — recorded, not crawlable)`);
    } else {
      // UPCOMING/ACTIVE with 0 grades: legitimate pre-allocation state (season
      // created before grades assigned). Create it LIVE — the grade-refresh step
      // below will populate grades once PlayHQ allocates them. Err toward live for
      // any non-COMPLETED status so a real upcoming season is never wrongly locked.
      index.seasons[sid] = { ...base, grades: [], locked: false, addedAt: new Date().toISOString() };
      created++;
      console.log(`  + created ${sid}  ${base.fullName}  (0 grades — pre-allocation, live; awaiting grades)`);
    }
  }

  // ── Grade-refresh: fill grades for active seasons still at grades:[] ──────────
  // The crawl reads grades statically from the index, so a grades:[] live season
  // (pre-allocation, or created grade-less on a prior run) would never be crawled
  // until its grades appear here. Cheap: only touches grade-less active seasons.
  let refreshed = 0;
  const graceless = Object.values(index.seasons).filter(se => se.locked === false && (se.grades || []).length === 0);
  if (graceless.length) {
    console.log(`\n  Grade-refresh: ${graceless.length} active grade-less season(s) to re-check (concurrency ${CONCURRENCY})`);
    const refreshDs = new Map();
    await runPool(graceless, CONCURRENCY, async (se) => { refreshDs.set(se.id, await discoverSeason(se.id)); });
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

  if ((created > 0 || removed > 0 || refreshed > 0) && !DRY_RUN) {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
    gitCommit(`discover-seasons: ${created} new + ${removed} removed + ${refreshed} grade-refreshed`);
  }

  console.log('\n─── Summary ─────────────────────────────────────────────────────────');
  console.log(`  Players probed        : ${probed}`);
  console.log(`  Elapsed / throughput  : ${((Date.now() - startTime) / 60000).toFixed(1)}m  @ ${(probed / Math.max(1, (Date.now() - startTime) / 1000)).toFixed(1)}/s  (concurrency ${effConc})`);
  console.log(`  Private / error       : ${privateN} / ${errors}`);
  console.log(`  Blocked (paced)       : ${blocked}`);
  console.log(`  New seasons found     : ${newSeasonMeta.size}`);
  console.log(`  Seasons created       : ${created}${DRY_RUN ? ' (dry-run — none written)' : ''}`);
  console.log(`  Removed stubs         : ${removed}${DRY_RUN ? ' (dry-run — none written)' : ''}`);
  console.log(`  Grade-refreshed       : ${refreshed}${DRY_RUN ? ' (dry-run — none written)' : ''}`);
  if (newSeasonMeta.size > created + removed) console.log(`  (${newSeasonMeta.size - created - removed} left for next run — grade resolution blocked)`);
  console.log('─'.repeat(60));
  if (created > 0) console.log('\nNext: roster-fill (piece 2) should run for the new season(s) until round 1 completes.');
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
