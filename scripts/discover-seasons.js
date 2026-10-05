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
// Session bookkeeping (count, age, single-flight rotation) is scripts/lib/
// playhq-session.cjs since 2026-10-05; refreshSession() here is only the fetcher.
// A block is never treated as a bad cookie (matches fetch-profile-stats.js).
// Headers are the same five keys as every other script. doFetch is the nightly's
// fetch() client, copied verbatim from nightly-crawl.js on 2026-10-05 — see the
// note above it for why https.request had to go. Queries are copied from fetch-playhq.js /
// playhq_api_reference.md — never write PlayHQ queries from scratch.
//
// Modes:
//   node scripts/discover-seasons.js --shard=XX --cursor=N --out=discover-shard-XX.json
//                                                       # MAP: burst-probe from cursor, stop dead at wall
//   node scripts/discover-seasons.js --reduce --in=<dir>
//                                                       # REDUCE: merge artifacts + cursors → index + progress
//   node scripts/discover-seasons.js --all-players      # (map) probe every player, not just current-season
//   node scripts/discover-seasons.js                    # legacy standalone (single-IP AIMD; walls at scale)
//   node scripts/discover-seasons.js --concurrency=N    # burst batch size (shard) / AIMD cap (standalone), default 25
//   node scripts/discover-seasons.js --uuid=<id>        # manual escape hatch: probe one player
//   node scripts/discover-seasons.js --dry-run          # report only, no writes/commit
//   node scripts/discover-seasons.js --backfill-teams   # extract pre-season rosters into players/ (team-lookup/ writes disabled — no consumer)
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
const { execSync } = require('child_process');
const { createSessionGuard } = require('./lib/playhq-session.cjs');

const ROOT        = path.join(__dirname, '..');
const API_URL     = 'https://api.playhq.com/graphql';
const INDEX_FILE  = path.join(ROOT, 'data', 'sports-index.json');
const INDEX_FILE_REL = 'data/sports-index.json';
const PROGRESS_FILE = path.join(ROOT, 'data', 'discover-progress.json');   // per-shard cursor/done (matrix resume state)
const PROGRESS_FILE_REL = 'data/discover-progress.json';
// ─── Reg upsert (DECISION A, 2026-08-01) ──────────────────────────────────────
// A reg IS a (team, grade) registration, so BOTH fields are the key. Three writers
// previously disagreed and the data reflected all three:
//   nightly-crawl.js  L1011  matches (tid AND gid) -> appends when grade differs
//   fetch-profile-stats.js L1039  matches (tid)    -> skips
//   discover-seasons.js (here)   matched (tid)     -> MUTATED gid in place
// That mutation was the exact-duplicate generator: rewriting one reg's grade could
// make it collide with a sibling the nightly had already appended, producing two
// regs sharing (tid, gid) — 27,666 of them, which neither other writer can create
// because both check and skip. It also fought the nightly in a loop: this script
// collapsed a regrade to one reg with the latest grade, the nightly met a game in
// the older grade, found no (tid,gid) match, and appended it straight back.
//
// Rules:
//   - match on (tid, gid); never overwrite one REAL grade with a different one
//   - a reg whose grade was never published IS the same registration seen before
//     the grade existed — COMPLETE it rather than adding a second row
//   - when the API gives no grade, never add a less-informative row beside one that
//     already names a grade (publicProfileTeams returns grade=NULL for COMPLETED
//     registrations — the source of 110,232 null-gid regs)
// Returns true when the player file was actually changed.
function upsertReg(seasonObj, { tid, tn, gid, gn }) {
  if (!tid) return false;
  const newGid = gid || null;
  if (!seasonObj.regs) seasonObj.regs = [];
  const regs = seasonObj.regs;

  const exact = regs.find(r => r.tid === tid && (r.gid || null) === newGid);
  if (exact) {
    let changed = false;
    if (tn && !exact.tn) { exact.tn = tn; changed = true; }
    if (gn && !exact.gn) { exact.gn = gn; changed = true; }
    return changed;
  }

  if (newGid) {
    const incomplete = regs.find(r => r.tid === tid && !r.gid);
    if (incomplete) {
      incomplete.gid = newGid;
      if (gn) incomplete.gn = gn;
      if (tn && !incomplete.tn) incomplete.tn = tn;
      return true;
    }
    regs.push({ tid, tn: tn || '', gid: newGid, gn: gn || null, stats: {} });
    return true;
  }

  if (regs.some(r => r.tid === tid)) return false;
  regs.push({ tid, tn: tn || '', gid: null, gn: null, stats: {} });
  return true;
}

const PLAYERS_DIR = path.join(ROOT, 'players');

// TEAM_LOOKUP_DIR disabled — team-lookup/ files are not consumed by any downstream script.
// Re-enable if a consumer is added.
// const TEAM_LOOKUP_DIR = path.join(process.cwd(), 'team-lookup', 'bv');
// if (!fs.existsSync(TEAM_LOOKUP_DIR)) fs.mkdirSync(TEAM_LOOKUP_DIR, { recursive: true });

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const BACKFILL_TEAMS = args.includes('--backfill-teams');
// If backfill is on, force ALL_PLAYERS to true so it scans everyone
const ALL_PLAYERS = args.includes('--all-players') || BACKFILL_TEAMS;   
const NO_PRUNE = process.argv.includes('--no-prune');
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
// How a REFUSED bootstrap is handled: wait one full penalty window, then one retry.
// In SHARD mode there is no retry at all — the map job has a 10-minute limit, so a
// 15-minute wait would only get the job killed before it wrote its artifact; and the
// refusal is fleet-wide, so the canary in discover-seasons-matrix.yml's
// generate-shards job is where the waiting belongs. The shard writes its artifact
// with noSession:true and exits so the reduce can see why the sweep stopped.
const BOOTSTRAP_REFUSED_WAIT_MS = 15 * 60 * 1000;
const BOOTSTRAP_REFUSED_RETRIES = SHARD ? 0 : 1;
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

function syncTeams(player) {
    const teams = [];
    const seen = new Set();
    for (const s of (player.seasons || [])) {
        for (const r of (s.regs || [])) {
            if (r.tid && !seen.has(`${r.tid}-${s.sid}`)) {
                teams.push({ tid: r.tid, sid: s.sid, status: s.status?.value || 'ACTIVE' });
                seen.add(`${r.tid}-${s.sid}`);
            }
        }
    }
    player.teams = teams;
    player.teamsUpdatedAt = new Date().toISOString();
    return player;
}

async function refreshSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    // ⚠️ 2026-10-05 — A REFUSED BOOTSTRAP IS RETRIED ONCE, AFTER ONE FULL WINDOW.
    // The 2026-10-04 cadence (20s, 40s, 60s … 120s, ten attempts, ~13 minutes) made
    // up to ten cookieless requests INTO the penalty window it was waiting out, and
    // every request made into that window extends it. Across 256 matrix shards that
    // was over two thousand cookieless requests in a few minutes — the load that
    // keeps the window open. The scarce resource is new sessions, not calls
    // (REPO_MANIFEST §6.60): Nightly Crawl #129 made 11,317 calls clean and a shard
    // started straight after it could not get a cookie for 13 players.
    //
    // Now: a 403 means the window is open, so wait the full ~15 minutes it lasts and
    // ask ONCE more. A second refusal is final — fail loudly, write nothing. Two
    // cookieless requests instead of ten. Non-403 failures (an answer with no
    // cookie in it) are not the window and keep a short retry.
    let longWaits = 0, shortWaits = 0;
    for (let attempt = 1; ; attempt++) {
      let refused = false;
      for (const body of COOKIE_QUERIES) {
        let status, rawCookies, rawText;
        try {
          ({ status, rawCookies, rawText } = await doFetch(API_URL, body, HEADERS_BASE));
        } catch (err) {
          // INSTRUMENTATION ONLY: log then rethrow — identical control flow to before
          // (an unhandled doFetch rejection always aborted the refresh immediately).
          console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: fetch threw ${err.code || ''} ${err.message}`);
          sessionPromise = null;   // was left set, so every later refresh returned this same rejection
          throw err;
        }
        if (!rawCookies) {
          // INSTRUMENTATION: this silent `continue` is where the 2026-07 shard failures
          // were vanishing — every response in a failed refresh landed here with no
          // status/body recorded. Log both so a CloudFront block page, an application
          // error, and a cookie-scheme change are distinguishable in the run log.
          const b = rawText || '';
          const sniff = b.includes('Request blocked') ? `CLOUDFRONT-BLOCK (${b.length}b HTML)`
                      : b.includes('DOCTYPE')         ? `HTML page (${b.length}b): ${b.slice(0, 80)}`
                      : (b.slice(0, 120) || '(empty body)');
          console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: HTTP ${status}, NO set-cookie, body: ${sniff.replace(/\s+/g, ' ')}`);
          // A 403 is the SOURCE being refused, not this query. Trying the next one
          // immediately only doubles the rate into a block that is already on.
          if (status === 403) { refused = true; break; }
          continue;
        }
        // undici hands back one entry per Set-Cookie; the joined-header fallback holds
        // several in one string, so split that on ',' as the old code did.
        const parts = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
          .flatMap(c => c.split(',')).map(c => c.trim().split(';')[0]).filter(Boolean);
        const get = (name) => parts.find(c => c.startsWith(name + '=')) || null;
        const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
        if (!tier || !session || !sub) {
          // INSTRUMENTATION: set-cookie arrived but not the three phq_* names we need
          // — if PlayHQ renamed/restructured its session cookies, this line is the proof.
          console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: HTTP ${status}, set-cookie PRESENT but missing phq_tier/phq_session/phq_sub — names seen: ${parts.map(c => c.split('=')[0]).join(', ')}`);
          continue;
        }
        sessionCookie = `${tier}; ${session}; ${sub}`;
        sessionPromise = null;
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
      if (refused) {
        if (longWaits >= BOOTSTRAP_REFUSED_RETRIES) { if (SHARD) console.log('  ⛔ bootstrap refused — shard mode does not wait; stopping dead so the artifact records it.'); break; }
        longWaits++;
        console.log(`  ⛔ bootstrap refused (attempt ${attempt}) — the penalty window is open. Waiting ${Math.round(BOOTSTRAP_REFUSED_WAIT_MS / 60000)} minutes for it to close, then asking once more.`);
        await sleep(BOOTSTRAP_REFUSED_WAIT_MS);
        continue;
      }
      if (shortWaits >= 4) break;
      shortWaits++;
      await sleep(20000 * shortWaits);
    }
    sessionPromise = null;
    throw new Error(`Failed to obtain session cookie: ${longWaits ? `refused ${longWaits + 1} times, ${Math.round(BOOTSTRAP_REFUSED_WAIT_MS / 60000)} minutes apart — the penalty window did not close` : (SHARD ? 'refused — the penalty window is open' : 'no usable cookie in any answer')} — see per-attempt ⚠ lines above for HTTP status and body`);
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

// ⚠️ THE SESSION HAS A REQUEST BUDGET, MEASURED AT ROUGHLY 290 CALLS
// (REPO_MANIFEST §6.59). Age alone does not catch it: a burst-heavy shard can spend
// the whole budget inside the 15-minute window and then meet the 403 wall. Rotating
// at 250 is granted instantly; waiting for the refusal costs the penalty window.
// The counting, the age check and the single-flight rotation live in
// scripts/lib/playhq-session.cjs (shared with nightly-crawl and fetch-profile-stats);
// this script only supplies the fetcher. The inline copy that was here under-counted
// concurrent callers — see the 2026-10-05 note at the top of that file.
const sessionGuard = createSessionGuard({
  refresh:   refreshSession,
  hasCookie: () => !!sessionCookie,
  clear:     () => { sessionCookie = null; },
});
// ⚠️ 2026-10-05 — A REFUSED SESSION STOPS THE RUN. IT USED TO BE STEPPED OVER.
// ensureSession() is awaited OUTSIDE the try/catch in probeTeams, so when the
// bootstrap failed the probe REJECTED. burstRun logged the rejection, advanced the
// cursor past the whole batch anyway, moved to the next batch — which asked for a
// session again, ten attempts and thirteen minutes of them — and at the end of the
// shard printed "✔ shard exhausted ... done=true" with "Players probed: 0".
// Reproduced in a sandbox 2026-10-05: 60 players, every bootstrap refused → 30
// cookieless requests, cursor 0 → 60, done=true, exit 0. A 750-player shard did
// that 30 times over, for as long as the job lasted, on every shard in the matrix
// at once. That is the load that has kept the penalty window open since 2026-10-04,
// and the shards it "completed" were never probed.
//
// Now a session failure is a typed result. The first one marks the source dead for
// the rest of the run so no later phase asks again; burstRun stops dead at it with
// the cursor where it was; aimdRun stops and names what it left unprocessed.
class SessionUnavailable extends Error {}
let sessionDead = false;
async function ensureSession() {
  if (sessionDead) throw new SessionUnavailable('PlayHQ refused a session earlier in this run — not asking again');
  try { await sessionGuard.ensure(); }
  catch (err) {
    sessionDead = true;
    throw new SessionUnavailable(err.message);
  }
}

const AIMD_MIN         = 3;
const AIMD_CUT         = 0.6;
const AIMD_RECOVER     = 10;
const AIMD_CLEAN_BATCHES_TO_RECOVER = 2;
const AIMD_BLOCKED_BATCHES_TO_LOWER_CAP = 3;
const AIMD_BACKOFF_MS  = 5000;   // × consecutive blocked batches

// ─── Typed probe: publicProfileTeams → { kind, teams } ────────────────────────
async function probeTeams(profileID) {
  try { await ensureSession(); }
  catch (err) { return { kind: 'no-session', err }; }

  let status, json, rawText;
  try {
    ({ status, body: json, rawText } = await doFetch(API_URL, { ...Q_PROFILE_TEAMS, variables: { profileID } }, { ...HEADERS_BASE, 'Cookie': sessionCookie }));
  } catch (err) { return { kind: 'error', err }; }

  if (status === 403) {
    if (isWafBlock(rawText)) return { kind: 'blocked' };
    return { kind: 'private' };   // application 403 — inaccessible profile
  }
  if (status === 429 || status === 503) return { kind: 'blocked' };   // rate signal → AIMD backs off
  if (status < 200 || status >= 300) return { kind: 'error', err: new Error(`HTTP ${status}`) };

  if (!json) return { kind: 'error', err: new Error(`unparseable body: ${(rawText || '').slice(0, 80)}`) };
  if (json.errors?.length) return { kind: 'error', err: new Error(json.errors[0]?.message || 'gql') };
  const teams = (json.data || json)?.publicProfileTeams;
  return { kind: 'ok', teams: Array.isArray(teams) ? teams : [] };
}

// ─── discoverSeason → grades + competition (for creating the season entry) ────
async function discoverSeason(seasonID) {
  try { await ensureSession(); }
  catch (err) { return { blocked: true, noSession: true, err }; }
  let status, json, rawText;
  try {
    ({ status, body: json, rawText } = await doFetch(API_URL, { ...Q_DISCOVER_SEASON, variables: { id: seasonID } }, { ...HEADERS_BASE, 'Cookie': sessionCookie }));
  } catch { return null; }
  if (status === 403) {
    if (isWafBlock(rawText)) return { blocked: true };
    return null;
  }
  if (status < 200 || status >= 300) return null;
  if (!json || json.errors?.length) return null;
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
      return { item, blocked: !!(r && r.blocked), dead: !!(r && r.dead) };
    }));

    let batchBlocked = 0, dead = false;
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value.blocked) { batchBlocked++; blockedEvents++; queue.push(res.value.item); if (res.value.dead) dead = true; }
      else done++;   // fulfilled-clean, or rejected (worker guards its own errors)
    }
    if (dead) {
      // PlayHQ will not issue a session. Backing off and asking again is what kept
      // the penalty window open; the items left in the queue wait for the next run.
      console.log(`    ⛔ ${label}: no session available — stopping with ${queue.length} item(s) unprocessed`);
      break;
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
  return { done, blockedEvents, unprocessed: queue.length };
}

async function burstRun(items, concurrency, worker) {
  let completed = 0;
  for (let start = 0; start < items.length; start += concurrency) {
    const batch = items.slice(start, start + concurrency);
    const results = await Promise.allSettled(batch.map(async (item) => {
      const r = await probeTeams(item);
      return { item, r };
    }));
    const noSession = results.find(res => res.status === 'fulfilled' && res.value.r.kind === 'no-session');
    if (noSession) {
      // Stop dead with the cursor where it was: nothing in this batch was asked.
      console.log(`  ⛔ no session: ${noSession.value.r.err?.message || noSession.value.r.err} — stopping dead; cursor stays at ${completed}`);
      return { completed, wallHit: true, noSession: true };
    }
    const anyBlocked = results.some(res => res.status === 'fulfilled' && res.value.r.kind === 'blocked');
    if (anyBlocked) return { completed, wallHit: true };
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') { worker(res.value.item, res.value.r); return; }
      // Promise.allSettled preserves input order, so batch[i] is the item whose probe
      // rejected. Print the REASON — the old line read `reason.item`, which never
      // exists on an Error, so every real failure logged as a bare `?` with the
      // actual error discarded (this is exactly how the 2026-07 session failures hid).
      // And RECORD it as an error so it joins the retry list: a rejected probe used to
      // be stepped over by the cursor and never asked again.
      console.log(`  ⚠ unexpected rejection probing ${batch[i]}: ${res.reason?.message || res.reason}`);
      worker(batch[i], { kind: 'error', err: res.reason instanceof Error ? res.reason : new Error(String(res.reason)) });
    });
    completed = start + batch.length;
  }
  return { completed, wallHit: false, noSession: false };
}

// ── git: rewritten to the house pattern 2026-08-20 ───────────────────────────
// The previous version had four faults, found in the exec-call audit:
//
//   1. COMBINED `git add a b c`. git add is ATOMIC across pathspecs — ONE
//      unmatched path exits 128 and stages NOTHING, including the valid paths
//      beside it. That is the 2026-07-19 failure exactly: 30,426 games fetched,
//      zero committed, job green. Now per-path with a benign-absent exemption.
//   2. NO PUSH RETRY. A single contended push lost the run's work. This repo has
//      many writers on one branch; every other writer here retries with jitter.
//   3. COMMIT AFTER MERGE. Merging over uncommitted changes fails outright when
//      concurrent pushes touch the same files. Commit first.
//   4. `catch` PRINTED AND RETURNED. A lost push left the job GREEN with the work
//      discarded — silently. It now THROWS when attempts are exhausted: a broken
//      write must show red.
//
// Plus the timeout the audit was looking for: execSync is SYNCHRONOUS, so a
// stalled fetch or push blocks the whole process with no output and no retry.
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_MAXBUF     = 512 * 1024 * 1024;
const GIT_OPTS       = { cwd: ROOT, stdio: 'pipe', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF };
const PUSH_ATTEMPTS  = 60;

function gitCommit(msg, paths = []) {
  if (DRY_RUN) return;
  const uniquePaths = [...new Set(paths)].filter(Boolean);
  if (!uniquePaths.length) { console.log('  Nothing to commit (no paths given).'); return; }

  // Per-path add. NEVER -A: this repo is ~8.6GB / 369k+ files and -A walks the
  // whole index. A path that matches nothing is benign here (index/progress files
  // may legitimately be absent); anything else is a real staging failure.
  let addFailures = 0;
  for (const p of uniquePaths) {
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
    console.log('  Nothing to commit.');
    return;
  }
  console.log(`  staging: ${staged}`);

  // COMMIT BEFORE MERGE.
  execSync(`git commit -q -m "${msg}"`, GIT_OPTS);

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try { execSync('git merge --abort', GIT_OPTS); } catch (_) { /* none in progress */ }
    try {
      process.stdout.write(`  … fetch/merge/push (attempt ${attempt})\n`);
      execSync('git fetch origin main', GIT_OPTS);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT_OPTS);
      execSync('git push origin main', GIT_OPTS);
      console.log(`  ✔ ${msg}${attempt > 1 ? ` (push attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      if (attempt === PUSH_ATTEMPTS) {
        throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${((e.stderr && e.stderr.toString()) || e.message).split('\n')[0]}`);
      }
      const wait = 1 + Math.floor(Math.random() * 91);   // pure jitter, decorrelates writers
      console.log(`  … push attempt ${attempt} failed, retrying in ${wait}s`);
      try { execSync(`sleep ${wait}`, { stdio: 'pipe', timeout: (wait + 30) * 1000 }); } catch (_) {}
    }
  }
}

// ⚠️ 2026-10-05 — REWRITTEN FROM https.request TO fetch(). THE CLIENT WAS THE KEY.
//
// Measured on one runner, 10 s apart, same URL, same five headers, same user-agent
// (measure-playhq-limits.js --mode=compare, REPO_MANIFEST §6.61):
//     fetch()        ProfileSearch  HTTP 200  GRANTED
//     https.request  TenantConfig   HTTP 403  REFUSED  CLOUDFRONT-BLOCK (919b HTML)
//     fetch()        ProfileSearch  HTTP 200  GRANTED
// PlayHQ was issuing sessions ten seconds before and ten seconds after the
// https.request bootstrap and refused only that one. Every script that had been moved
// to fetch() (nightly-crawl, discover-org-seasons, recheck-private-profiles) ran clean
// through the whole 2026-10-04/05 episode; every script still on https.request with a
// hand-built header set — this one, the matrix shards built on it, the measurement
// tool's first two modes — was refused from cold. nightly-crawl.js found the same
// thing on 2026-09-29 and recorded it above its own doFetch; the 2026-10-04 handoff
// ruled the client out on older evidence and was wrong.
//
// This is nightly-crawl.js's doFetch, pasted VERBATIM — not a Response-shaped wrapper
// over fetch(), because a hand-set content-length and a per-request agent were
// exactly what was being refused and nothing of that shape should survive here.
// Callers were moved to its return shape: { status, rawCookies, body, rawText }.
// It resolves on ANY status and never throws for a 403.
//
// ⚠️ DO NOT "OPTIMISE" THIS BACK TO https.request, AND DO NOT SET content-length BY
// HAND. keepAlive: fetch() pools connections, as discover-fixtures has always done at
// concurrency 40 without trouble.
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

// The WAF block page, as nightly-crawl.js recognises it.
const isWafBlock = (rawText) => /cloudfront|Request blocked|ERROR: The request could not be satisfied/i.test(rawText || '') || (rawText || '').includes('DOCTYPE');

async function applyDiscoveries(index, newSeasonMeta, stats = {}, extraCommitPaths = []) {
  const { probed = 0, blockedEvents = 0, privateN = 0, errors = 0, t0 = Date.now(), playersWritten = 0, teamsWritten = 0 } = stats;

  let created = 0, removed = 0;
  const metaEntries = [...newSeasonMeta];
  const dsById = new Map();
  if (metaEntries.length) {
    console.log(`\n  Resolving grades for ${metaEntries.length} new season(s) (AIMD cap ${CONCURRENCY})…`);
    await aimdRun(metaEntries, 'grade-resolve', async ([sid]) => {
      const ds = await discoverSeason(sid);
      if (ds && ds.noSession) { dsById.set(sid, { blocked: true }); return { blocked: true, dead: true }; }   // left for next run
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

  // ── Grade-refresh ────────────────────────────────────────────────────────────
  // WIDENED 2026-09-08. This used to select ONLY seasons at grades:[], so a season
  // captured mid-grading kept its grading grades forever - it had SOME grades, so
  // it never qualified. discover-fixtures.js has been detecting exactly that and
  // printing it: on 2026-09-07 it found 29 such seasons, EDJBA (1ae60211) holding
  // 55 grades against 263 live, and the comment at its detection site said outright
  // that nothing would correct them.
  //
  // It now also takes anything discover-fixtures recorded in
  // data/stale-grade-seasons.json, which it learns for free from the team list. A
  // season that is locked is skipped regardless: its grades are immutable.
  let refreshed = 0;
  const gradeless = Object.values(index.seasons).filter(se => se.locked === false && (se.grades || []).length === 0);
  let staleFromFixtures = [];
  try {
    const sf = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stale-grade-seasons.json'), 'utf8'));
    const ids = new Set((sf.seasons || []).map(x => x.id));
    staleFromFixtures = Object.values(index.seasons).filter(se =>
      se.locked === false && ids.has(se.id) && (se.grades || []).length > 0);
    if (sf.seasons) console.log(`  stale-grade-seasons.json: ${sf.count} season(s) flagged by discover-fixtures at ${String(sf.generatedAt).slice(0, 19)}`);
  } catch (_) {
    // Absent is normal before discover-fixtures has run once. Not an error, but say
    // so - silence here would look like "nothing was stale".
    console.log('  stale-grade-seasons.json: not present (discover-fixtures has not written one yet)');
  }
  const graceless = [...gradeless, ...staleFromFixtures];
  if (graceless.length) {
    console.log(`\n  Grade-refresh: ${graceless.length} season(s) to re-check — ${gradeless.length} at grades:[], ${staleFromFixtures.length} flagged stale by discover-fixtures (AIMD cap ${CONCURRENCY})`);
    const refreshDs = new Map();
    await aimdRun(graceless, 'grade-refresh', async (se) => {
      const ds = await discoverSeason(se.id);
      if (ds && ds.noSession) { refreshDs.set(se.id, { blocked: true }); return { blocked: true, dead: true }; }   // left for next run
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

  // FORCE COMMIT IF FILES WERE WRITTEN (Even if no new seasons found)
  if ((created > 0 || removed > 0 || refreshed > 0 || playersWritten > 0 || teamsWritten > 0 || extraCommitPaths.length > 0) && !DRY_RUN) {
    if (created > 0 || removed > 0 || refreshed > 0) fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
    gitCommit(`discover-seasons: ${created} new, ${removed} removed, ${refreshed} refreshed, ${playersWritten} players updated`, extraCommitPaths);
  }

  console.log('\n─── Summary ─────────────────────────────────────────────────────────');
  if (probed) {
    console.log(`  Players probed        : ${probed}`);
    console.log(`  Elapsed / throughput  : ${((Date.now() - t0) / 60000).toFixed(1)}m  @ ${(probed / Math.max(1, (Date.now() - t0) / 1000)).toFixed(1)}/s`);
    console.log(`  Private / error       : ${privateN} / ${errors}`);
    // The retry/carried/abandoned lines that were here belong to the SHARD summary
    // (they read variables that only exist in the shard branch of main). On the
    // standalone path they threw "ReferenceError: retryList is not defined" after
    // the commit, so every standalone run that probed anything went red
    // (reproduced 2026-10-05). The standalone path has no cross-run retry.
    console.log(`  Block events (requeued): ${blockedEvents}`);
  }
  console.log(`  New seasons resolved  : ${newSeasonMeta.size}`);
  console.log(`  Seasons created       : ${created}${DRY_RUN ? ' (dry-run — none written)' : ''}`);
  console.log(`  Removed stubs         : ${removed}${DRY_RUN ? ' (dry-run — none written)' : ''}`);
  console.log(`  Grade-refreshed       : ${refreshed}${DRY_RUN ? ' (dry-run — none written)' : ''}`);
  if (playersWritten > 0 || teamsWritten > 0) {
    console.log(`  Players persisted     : ${playersWritten}`);
    console.log(`  Teams persisted       : ${teamsWritten}`);
  }
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
    let shardProbed = 0, wallHits = 0, doneCount = 0, undoneShards = [], noSessionShards = [];
    const mergedDeltas = new Map();   // uuid -> [{sid,sn,tid,tn,gid,gn}, ...] merged across shards
    const modesThisRun = new Set();   // for the progress report below — what THIS run actually processed
    for (const f of files) {
      let a; try { a = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { console.log(`  ⚠ unreadable artifact ${f} — skipped`); continue; }
      shardProbed += a.probed || 0;
      if (a.wallHit) wallHits++;
      if (a.noSession && a.shard) noSessionShards.push(a.shard);
      if (a.mode) modesThisRun.add(a.mode);
      for (const [sid, meta] of Object.entries(a.discovered || {})) {
        if (knownSeasonIds.has(sid) || merged.has(sid)) continue;
        merged.set(sid, meta);
      }
      if (a.shard) {
        // `errored` MUST be carried into progress or the retry is lost between
        // runs — the map role reads it back at the top of the shard branch.
        progress[a.shard] = {
          mode: a.mode, cursor: a.cursor, total: a.total, done: a.done,
          errored: Array.isArray(a.errored) ? a.errored : [],
          abandoned: Array.isArray(a.abandoned) ? a.abandoned : [],
          updatedAt: a.at,
        };
        if (a.done) doneCount++; else undoneShards.push(a.shard);
      }
      // Deltas are collected here but applied AGAINST A FRESH FILE below — never a
      // stale MAP-time snapshot. Each uuid can only appear in one shard's artifact
      // (sharded by uuid prefix), so no cross-shard merge conflict on a single key.
      for (const [uuid, deltas] of Object.entries(a.playerDeltas || {})) {
        if (!mergedDeltas.has(uuid)) mergedDeltas.set(uuid, []);
        mergedDeltas.get(uuid).push(...deltas);
      }
    }
    console.log(`  Merged ${merged.size} distinct new season(s) across ${files.length} shard(s) (probed ${shardProbed}, wall hits ${wallHits}).`);
    console.log(`  Shard progress: ${doneCount} done, ${undoneShards.length} not yet complete this sweep.`);
    if (noSessionShards.length) {
      console.log(`  ⛔ ${noSessionShards.length} shard(s) stopped because PlayHQ would not issue a session: ${noSessionShards.join(' ')}`);
      console.log('     The penalty window is open. Their cursors are unchanged; re-dispatching now would only extend it.');
    }

    // ── Progress report, scoped to THIS RUN'S mode ─────────────────────────────
    // Denominator is the sum of each shard's own `total` (recorded per-shard, per-
    // mode, at probe time) — NOT a global player count. A global count is wrong for
    // any limited-scope run: a 'current'-mode sweep only ever targets ~220k of the
    // ~370k players, so it could never show 100%; an explicit small-shard test run
    // would show a near-zero percentage even at full completion for those shards.
    // Mode is read off the artifacts actually merged this run (not a CLI flag —
    // --reduce doesn't take one — this way the report reflects what really ran).
    const reportMode = modesThisRun.size ? [...modesThisRun][0] : null;
    if (reportMode) {
      if (modesThisRun.size > 1) console.log(`  ⚠ multiple modes in this run's artifacts (${[...modesThisRun].join(', ')}) — reporting against '${reportMode}' only.`);
      const modeEntries = Object.values(progress).filter(p => p.mode === reportMode);
      const shardsDone = modeEntries.filter(p => p.done).length;
      const totalPlayers = modeEntries.reduce((s, p) => s + (p.total || 0), 0);
      const probedPlayers = modeEntries.reduce((s, p) => s + (p.cursor || 0), 0);
      const pct = totalPlayers > 0 ? (probedPlayers / totalPlayers * 100) : 0;
      console.log('\n========================================');
      console.log('📊 MATRIX PROGRESS REPORT');
      console.log(`   Mode            : ${reportMode}`);
      console.log(`   Shards Complete : ${shardsDone} / ${modeEntries.length} tracked  (256 total)`);
      console.log(`   Players Probed  : ${probedPlayers} / ${totalPlayers} (${pct.toFixed(2)}%)`);
      console.log('========================================\n');
    }

    // ── Apply deltas against FRESH files (the workflow must have already expanded ──
    //    its checkout to cover every affected shard before invoking --reduce — see
    //    discover-seasons-matrix.yml's "Expand checkout for affected shards" step).
    //    This is what eliminates the stale-snapshot clobber risk: we read each
    //    player's CURRENT on-disk content right here, not whatever MAP saw earlier.
    let playersWritten = 0, playersMissing = 0;
    let prunedRegs = 0; const prunedPlayers = new Set(); const prunedExamples = [];
    const touchedPlayerDirs = new Set();   // relative paths, e.g. 'players/00' — for explicit git add
    for (const [uuid, deltas] of mergedDeltas) {
      const filePath = path.join(PLAYERS_DIR, uuid.substring(0, 2), `${uuid}.json`);
      let player;
      try { player = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch { playersMissing++; continue; }   // file not checked out or genuinely absent — skip, don't fabricate
      if (!player.seasons) player.seasons = [];
      let fileModified = false;
      for (const d of deltas) {
        let seasonObj = player.seasons.find(s => s.sid === d.sid);
        if (!seasonObj) { seasonObj = { sid: d.sid, sn: d.sn, regs: [] }; player.seasons.push(seasonObj); }
        if (upsertReg(seasonObj, { tid: d.tid, tn: d.tn, gid: d.gid, gn: d.gn })) fileModified = true;
      }

      // ── PRUNE STALE PRE-SEASON REGISTRATIONS (2026-09-17) ────────────────────
      // upsertReg inserts or updates and NEVER REMOVES, and nothing else in this
      // reduce pruned. So a player moved between teams before a season started kept
      // BOTH registrations for ever, and build-team-stats — which builds rosters
      // straight from them — listed the child on both teams.
      //
      // WHAT MAKES THIS SAFE IS THE PAIR OF GUARDS, NOT THE API ANSWER ALONE.
      //
      //   1. `deltas` for this player came from publicProfileTeams on THIS run, so
      //      the tids in them are PlayHQ's current answer for that season. A season
      //      absent from the deltas is never touched — a player who errored, or was
      //      not probed, cannot lose anything.
      //   2. Only a row with NO `stats` AND NO `gid` is removed. That is precisely a
      //      pre-season registration: no grade allocated and no game played. A
      //      FILL-IN APPEARANCE ALWAYS HAS ONE OR THE OTHER, because nightly-crawl
      //      writes regs from games with the grade on them — so a real appearance
      //      that publicProfileTeams happens not to list cannot be deleted here.
      //      This is the guard that makes the difference between pruning a stale
      //      allocation and erasing a game somebody played.
      //
      // In-season moves (a player who transfers mid-season and never plays for the
      // old team) are NOT handled: those rows carry a gid. Deliberately left for a
      // separate decision — see OUTSTANDING.
      if (!NO_PRUNE) {
        const current = new Map();   // sid -> Set(tid) as PlayHQ reports it now
        for (const d of deltas) {
          if (!d.sid || !d.tid) continue;
          if (!current.has(d.sid)) current.set(d.sid, new Set());
          current.get(d.sid).add(d.tid);
        }
        for (const seasonObj of player.seasons) {
          const live = current.get(seasonObj.sid);
          if (!live || !live.size) continue;          // not probed this run — hands off
          const regs = seasonObj.regs || [];
          const keep = regs.filter(r => {
            if (!r || !r.tid) return true;
            if (live.has(r.tid)) return true;
            const noStats = !r.stats || Object.keys(r.stats).length === 0;
            const noGrade = !r.gid;
            if (!(noStats && noGrade)) return true;   // played, or graded — never ours to remove
            prunedRegs++;
            if (prunedExamples.length < 25) {
              prunedExamples.push(`    ${uuid.slice(0, 13)}  ${seasonObj.sid}  left ${r.tid} ${JSON.stringify(r.tn || '')}  -> now ${[...live].join(', ')}`);
            }
            return false;
          });
          if (keep.length !== regs.length) { seasonObj.regs = keep; fileModified = true; prunedPlayers.add(uuid); }
        }
      }
      if (fileModified) {
        syncTeams(player);
        // Minified — house rule. Was `null, 2`: this script pretty-printed every player
        // file it touched while nightly-crawl L497 and fetch-profile-stats L678 write
        // minified, so a player touched by both flipped format every cycle and was
        // rewritten in FULL each time even when no field changed.
        if (!DRY_RUN) fs.writeFileSync(filePath, JSON.stringify(player));
        playersWritten++;
        touchedPlayerDirs.add(`players/${uuid.substring(0, 2)}`);
      }
    }
    if (mergedDeltas.size) {
      console.log(`  Roster backfill: ${playersWritten} player(s) updated, ${playersMissing} not found on disk (not checked out or absent) — of ${mergedDeltas.size} with pending deltas.`);
    }
    if (NO_PRUNE) {
      console.log('  Pre-season prune: DISABLED (--no-prune)');
    } else if (prunedRegs) {
      console.log(`  Pre-season prune: ${prunedRegs} stale registration(s) removed from ${prunedPlayers.size} player(s)`);
      console.log('    (no grade, no stats, and the team is not in PlayHQ\'s current answer for that season)');
      prunedExamples.forEach(l => console.log(l));
      if (prunedRegs > prunedExamples.length) console.log(`    … and ${prunedRegs - prunedExamples.length} more`);
    } else {
      console.log('  Pre-season prune: nothing stale found');
    }

    // Once EVERY tracked shard (across all modes, not just this run's targets) is
    // done, the progress file has no remaining purpose — it exists purely to let
    // this workflow's own retrigger chain resume; nothing else reads it. Delete it
    // rather than leave a stale 256-entry "all done" file sitting in the repo.
    const trackedShards = Object.values(progress);
    const allDone = trackedShards.length > 0 && trackedShards.every(p => p.done === true);
    let progressDeleted = false;
    if (!DRY_RUN) {
      if (allDone) {
        if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
        progressDeleted = true;
        console.log('  ✔ All tracked shards complete — progress file removed (redundant until the next fresh sweep).');
      } else {
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
      }
    }

    // Explicit paths only — index always (no-op if unchanged), progress unless it
    // was just deleted (git add on a path that no longer exists on disk correctly
    // stages the deletion — but only if it was TRACKED before; deleting an already-
    // untracked/never-committed file has nothing to stage, which is fine either way),
    // and every shard directory the delta-apply loop actually touched.
    const commitPaths = [INDEX_FILE_REL, ...(progressDeleted || fs.existsSync(PROGRESS_FILE) ? [PROGRESS_FILE_REL] : []), ...touchedPlayerDirs];
    await applyDiscoveries(index, merged, { t0, playersWritten }, commitPaths);

    console.log(`UNDONE_SHARDS_JSON=${JSON.stringify(undoneShards)}`);
    console.log(`NO_SESSION_SHARDS=${noSessionShards.length}`);
    return;
  }

  if (PROBE_TEAM) {
    if (!sessionCookie) await refreshSession();
    const { status, body: json } = await doFetch(API_URL, { ...Q_TEAM_FIXTURE, variables: { teamID: PROBE_TEAM } }, { ...HEADERS_BASE, 'Cookie': sessionCookie });
    console.log(`  probe-team ${PROBE_TEAM}: HTTP ${status}`);
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
    // Cursor resolution: an explicit --cursor=N wins (manual/adhoc use). Otherwise
    // the map job passes only the shard, and we read this shard's saved cursor from
    // the committed progress file ourselves. This is deliberate — passing cursors
    // through the matrix output made that output grow past the ~8KB size boundary
    // that caused GitHub to resolve the matrix EMPTY and skip the whole map job.
    // Keeping the matrix output to bare shard strings avoids that entirely.
    // ─── ERRORED PLAYERS ARE RETRIED, NOT SKIPPED (2026-09-13) ───────────────
    // The cursor is POSITIONAL over a sorted uuid list, so a player whose probe
    // threw was stepped over and could never be revisited: `errors` was counted,
    // no delta was recorded, the cursor advanced past them and the shard still
    // reported done=true. The next run resumed from that done marker.
    //
    // Measured on the 2026-09-13 backfill: shard 3a returned 313 errors in 750
    // probes (42%), shard 5e 150/750, 199/675 and 54/238 — a fifth to two fifths
    // of every shard silently contributing no registration. Two children on team
    // fa6b5199 were missing from its roster for exactly this reason while a
    // team-mate in another shard came through.
    //
    // An `error` here is a TRANSPORT or GraphQL failure (L312-323): a thrown
    // fetch, a non-OK HTTP status, unparseable JSON, or a GraphQL error array.
    // It is NOT "this player has no teams" — that returns kind 'ok' with an empty
    // list. So an error means the question was never answered and must be asked
    // again.
    //
    // Retries are BOUNDED. A uuid that fails MAX_ERROR_ATTEMPTS times in a row is
    // abandoned and NAMED in the summary, so a permanently broken profile cannot
    // hold a shard open for ever — which would be the opposite failure.
    const MAX_ERROR_ATTEMPTS = 5;
    let prevErrored = [];   // [{ u: uuid, a: attempts }]
    let effectiveCursor = CURSOR;
    const cursorWasExplicit = args.some(a => a.startsWith('--cursor='));
    if (!cursorWasExplicit) {
      try {
        const prog = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
        const p = prog[SHARD];
        const expectedMode = BACKFILL_TEAMS ? 'all+backfill' : (ALL_PLAYERS ? 'all' : 'current');
        // Only resume from a cursor recorded for THIS mode — a cursor from a
        // different mode indexes a different player list and would be meaningless.
        if (p && p.mode === expectedMode && !p.done) effectiveCursor = p.cursor || 0;
        // Carry forward players that FAILED to be probed on an earlier run for this
        // mode. Read even when done=true: a shard can only reach done once its
        // retry list is empty, so a non-empty list here means the shard is not
        // finished no matter what the flag says.
        if (p && p.mode === expectedMode && Array.isArray(p.errored)) prevErrored = p.errored;
      } catch { /* no progress file yet → cursor 0 (fresh) */ }
    }
    console.log(`  Scanning shard ${SHARD} for ${ALL_PLAYERS ? 'ALL players' : 'current-season players'}…`);
    const full = currentSeasonPlayers(activeSids, { shard: SHARD, allPlayers: ALL_PLAYERS });
    const total = full.length;
    const tail = full.slice(effectiveCursor);
    // Only retry uuids that are still in this shard — a deleted or folded player
    // must not keep a shard open.
    const fullSet = new Set(full);
    const attemptsOf = new Map();
    const retryList = [];
    for (const e of prevErrored) {
      const u = typeof e === 'string' ? e : e.u;
      const a = typeof e === 'string' ? 1 : (e.a || 1);
      if (!u || !fullSet.has(u)) continue;
      if (a >= MAX_ERROR_ATTEMPTS) continue;   // abandoned, reported below
      attemptsOf.set(u, a);
      retryList.push(u);
    }
    const abandoned = prevErrored
      .map(e => (typeof e === 'string' ? { u: e, a: 1 } : e))
      .filter(e => e.u && fullSet.has(e.u) && (e.a || 1) >= MAX_ERROR_ATTEMPTS);

    console.log(`  Shard total: ${total}  cursor: ${effectiveCursor}${cursorWasExplicit ? ' (explicit)' : ' (from progress)'}  remaining: ${tail.length}  retrying: ${retryList.length}  burst concurrency: ${CONCURRENCY}`);
    if (abandoned.length) console.log(`  ⚠ ${abandoned.length} player(s) abandoned after ${MAX_ERROR_ATTEMPTS} failed attempts — named in the summary`);

    const newSeasonMeta = new Map();
    const playerDeltas = {};   // uuid -> [{sid, sn, tid, tn, gid, gn}, ...] — NOT a file snapshot.
                                // REDUCE reads the CURRENT file fresh and applies these — this is
                                // what eliminates the stale-snapshot clobber risk: MAP never reads
                                // or writes a player file at all in backfill mode.
    let probed = 0, privateN = 0, errors = 0;
    const t0 = Date.now();

    const erroredNow = new Map();   // uuid -> attempts so far (including this run)

    const onResult = (uuid, r) => {
      probed++;
      if (r.kind === 'private') { privateN++; return; }
      if (r.kind === 'error') {
        errors++;
        // Record WHO failed, with a running attempt count, so the next run can ask
        // again. Previously this was `errors++; return;` and the uuid was lost.
        erroredNow.set(uuid, (attemptsOf.get(uuid) || 0) + 1);
        return;
      }
      if (r.kind === 'ok') {
        for (const reg of r.teams || []) {
          const se = reg.season;
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

          // 2. BACKFILL: record the registration as a DELTA (applied against a fresh
          //    file read in REDUCE, not against whatever MAP happened to see here).
          if (BACKFILL_TEAMS && reg?.id) {
            (playerDeltas[uuid] ||= []).push({
              sid: se.id, sn: se.name, tid: reg.id, tn: reg.name,
              gid: reg.grade?.id || null, gn: reg.grade?.name || null,
            });
          }
        }
      }
    };

    // PHASE 1: previously-failed players. These sit OUTSIDE the cursor window, so
    // they never advance it — the cursor means "how far through the sorted list we
    // have got", and a retry is not progress through that list.
    let retryDone = { completed: 0, wallHit: false };
    if (retryList.length) {
      console.log(`  Retrying ${retryList.length} previously-failed player(s)…`);
      retryDone = await burstRun(retryList, CONCURRENCY, onResult);
    }

    // PHASE 2: the cursor tail. Skipped entirely if the retries hit the wall —
    // continuing would burn the budget on requests that are already being refused.
    let completed = 0, wallHit = retryDone.wallHit;
    if (!retryDone.wallHit && tail.length) {
      const res = await burstRun(tail, CONCURRENCY, onResult);
      completed = res.completed;
      wallHit   = res.wallHit;
    }

    const newCursor = effectiveCursor + completed;
    const stillErrored = [...erroredNow.entries()]
      .filter(([, a]) => a < MAX_ERROR_ATTEMPTS)
      .map(([u, a]) => ({ u, a }));
    const newlyAbandoned = [...erroredNow.entries()]
      .filter(([, a]) => a >= MAX_ERROR_ATTEMPTS)
      .map(([u, a]) => ({ u, a }));
    // ⚠ A SHARD IS NOT DONE WHILE PLAYERS REMAIN UNASKED. This used to be
    // `newCursor >= total` alone, which is what let a 42% error rate report as a
    // completed sweep.
    const done = newCursor >= total && stillErrored.length === 0;
    const noSession = retryDone.noSession || (wallHit && sessionDead);
    if (noSession) console.log(`  ⛔ PlayHQ would not issue a session — stopping dead (cursor ${effectiveCursor} → ${newCursor}/${total}). Nothing in the unasked tail was touched; a later run resumes here.`);
    else if (wallHit) console.log(`  ⛔ wall hit after ${completed} clean this run — stopping dead (cursor ${effectiveCursor} → ${newCursor}/${total}). Fresh runner will resume.`);
    else if (done) console.log(`  ✔ shard exhausted (cursor ${newCursor}/${total}).`);

    const discovered = Object.fromEntries(newSeasonMeta);
    const artifact = {
      shard: SHARD, mode: BACKFILL_TEAMS ? 'all+backfill' : (ALL_PLAYERS ? 'all' : 'current'),
      discovered,
      playerDeltas,   // uuid -> [{sid,sn,tid,tn,gid,gn}, ...] — applied against a FRESH file in REDUCE
      cursor: newCursor, total, done, wallHit, noSession,
      errored: stillErrored,                      // retried by the next run for this mode
      abandoned: [...abandoned, ...newlyAbandoned], // gave up after MAX_ERROR_ATTEMPTS
      probed, private: privateN, errors, at: new Date().toISOString(),
    };
    fs.writeFileSync(OUT_FILE, JSON.stringify(artifact));

    console.log('\n─── Shard summary ───────────────────────────────────────────────────');
    console.log(`  Shard                 : ${SHARD}`);
    console.log(`  Cursor                : ${effectiveCursor} → ${newCursor} / ${total}  (done=${done})`);
    console.log(`  Players probed        : ${probed}`);
    console.log(`  Elapsed / throughput  : ${((Date.now() - t0) / 60000).toFixed(1)}m  @ ${(probed / Math.max(1, (Date.now() - t0) / 1000)).toFixed(1)}/s`);
    console.log(`  Private / error       : ${privateN} / ${errors}`);
    console.log(`  Retried this run      : ${retryList.length}  (${retryDone.completed} completed)`);
    console.log(`  Carried to next run   : ${stillErrored.length}  ← probed and FAILED; they will be asked again`);
    if (abandoned.length + newlyAbandoned.length) {
      console.log(`  Abandoned (${MAX_ERROR_ATTEMPTS}+ fails) : ${abandoned.length + newlyAbandoned.length}`);
      for (const e of [...abandoned, ...newlyAbandoned].slice(0, 20)) console.log(`      ${e.u}  (${e.a} attempts)`);
    }
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
  let probesSinceNew = 0, stop = false, playersWritten = 0, teamsWritten = 0;
  const touchedPlayerDirsStandalone = new Set();

  const total = probeList.length;
  const t0 = Date.now();
  if (!ONE_UUID) console.log(`  Probing ${total} player(s), AIMD cap ${ONE_UUID ? 1 : CONCURRENCY}…`);

  const probeStats = await aimdRun(probeList, 'probe', async (uuid) => {
    const r = await probeTeams(uuid);
    if (r.kind === 'no-session') return { blocked: true, dead: true };
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
        const tm = { id: reg.id, name: reg.name };
          if (DEBUG_TEAMS) {
            console.log(`  DEBUG: Processing team ${tm.name} (${tm.id}) for season ${se.id}`);
          }

          if (localPlayer) {
            let seasonObj = localPlayer.seasons.find(s => s.sid === se.id);
            if (seasonObj) {
              const found = seasonObj.regs.find(r => r.tid === tm.id);
              if (DEBUG_TEAMS) console.log(`  DEBUG: Team found in local file: ${!!found}`);
            } else {
              if (DEBUG_TEAMS) console.log(`  DEBUG: Season ${se.id} not found in player file.`);
            }
          }
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

        // 2. BACKFILL: Update Team Lookup Directory (Direct Write for Standalone mode) — DISABLED
        // team-lookup/ files are not consumed by any downstream script or the HTML.
        // if (BACKFILL_TEAMS && tm?.id && tm?.name && !DRY_RUN) {
        //   const teamLookupPath = path.join(TEAM_LOOKUP_DIR, `${tm.id}.json`);
        //   if (!fs.existsSync(teamLookupPath)) {
        //     fs.writeFileSync(teamLookupPath, JSON.stringify({
        //       id: tm.id, name: tm.name, seasonId: se.id
        //     }, null, 2));
        //     teamsWritten++;
        //   }
        // }

        // 3. BACKFILL: Update the local player's registrations
        if (BACKFILL_TEAMS && localPlayer && tm?.id) {
          let seasonObj = localPlayer.seasons.find(s => s.sid === se.id);
          if (!seasonObj) {
            seasonObj = { sid: se.id, sn: se.name, regs: [] };
            localPlayer.seasons.push(seasonObj);
          }
          const before = seasonObj.regs.length;
          if (upsertReg(seasonObj, { tid: tm.id, tn: tm.name, gid: reg.grade?.id || null, gn: reg.grade?.name || null })) {
            fileModified = true;
            if (seasonObj.regs.length > before) {
              console.log(`   ➕ Added ${localPlayer.name || uuid} to ${tm.name} (${se.name})`);
            } else {
              console.log(`   🆙 Completed reg for ${localPlayer.name || uuid} in ${tm.name} (${se.name})`);
            }
          }
        }
      }

      // Standalone writes directly to disk because it's running locally, not in an ephemeral container
      if (fileModified && localPlayer && !DRY_RUN) {
        syncTeams(localPlayer);
        const root = process.env.GITHUB_WORKSPACE || process.cwd();
        const targetDir = path.join(root, 'players', uuid.substring(0, 2));
        const absolutePath = path.join(targetDir, `${uuid}.json`);

        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        // Minified — house rule (see the note at the other player write above).
        fs.writeFileSync(absolutePath, JSON.stringify(localPlayer));
        playersWritten++;
        touchedPlayerDirsStandalone.add(`players/${uuid.substring(0, 2)}`);
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

  // Pass tracking vars to applyDiscoveries
  await applyDiscoveries(index, newSeasonMeta, { probed, blockedEvents, privateN, errors, t0, playersWritten, teamsWritten }, [INDEX_FILE_REL, ...touchedPlayerDirsStandalone]);
  if (sessionDead) {
    // Whatever was probed and committed above stands; the run itself did not finish
    // its list and has no resume mechanism, so it must show red.
    console.error(`\n✗ PlayHQ would not issue a session: ${probeStats.unprocessed} of ${total} player(s) were never asked. Wait for the penalty window to close before running again.`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
