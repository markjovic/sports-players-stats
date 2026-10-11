// scripts/build-club-index.js
//
// BUILDS THE CLUB MAP. One `discoverTeams(filter:{seasonID})` request per season.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// There is NO club anywhere in this repository's stored data, and the word is
// already taken. `season.club` everywhere here is sports-index `orgName` — the
// ASSOCIATION (EDJBA, Camberwell), written by nightly-crawl.js L1229/L1346. It is
// rendered as the player header subtitle, the season-card subtitle and the
// leaderboard sub-line. `team-stats` `meta.club` is near-empty for a different
// reason: build-team-stats.js L338-339 passes '' for every team met in the games
// loop, so only registration-only teams (teams with NO games) ever carry one.
//
// The real club is PlayHQ's team `organisation` — 18d29132 "Kilsyth Cobras
// Basketball Club". THREE live scripts already fetch it and throw it away:
// nightly-crawl.js L383/L388, discover-fixtures.js L354/L373/L380, and
// discover-seasons.js L283.
//
// ── THE MEASUREMENT THAT AUTHORISED THIS FILE (2026-10-11) ──────────────────
// probe-discover-teams.js, live, four seasons. Club POPULATED on 100.0% of teams
// in every one, and 100.0% of the teams we hold in data/team-index.json would
// receive a club:
//
//   1ae60211 EDJBA Winter 2026   [active] 2,093 teams · 22 clubs · 1660/1660 held
//   aacc7335 Camberwell Winter   [active]   672 teams · 14 clubs ·  514/514  held
//   7ccb2e98 Altona Winter       [active]   385 teams · 20 clubs ·  374/374  held
//   9358e51a Waverley Spring '23 [LOCKED]   229 teams ·  7 clubs ·  222/222  held
//
// The LOCKED 2023 season answering exactly like the active ones is what makes a
// full historical backfill viable at one request per season. Nothing here is
// inferred from a team name — a name test cannot settle an identity question.
//
// ── CLUB IS AN ATTRIBUTE OF THE TEAM, NOT OF THE GAME ───────────────────────
// So a tid -> clubId map applies to every game that team ever played, history
// included, and NO completed game is rewritten. discover-fixtures.js L735 would
// forbid that anyway ("a game with a score is history").
//
// ── OUTPUTS ────────────────────────────────────────────────────────────────
//   club-map/bv/{sid}.json   { tid: clubId }                     per season
//   clubs/{clubId}.json      { id, n, seasons: { sid: [tid] } }  per club, MERGED
//   data/club-index.json     [{ id, n, t, s }] sorted by name    the search list
//
// Sized from the probe: ~368,000 teams at ~20 bytes is ~7.5 MB for club-map and
// about the same again for clubs/, against a 763 MB Pages artifact. Negligible,
// but stated rather than assumed.
//
// ⚠️ clubs/{clubId}.json MERGES. A club spans seasons, so an --active-only run
// must never delete the historical seasons a full run put there. Only the sids
// this run actually resolved are replaced.
//
// ⚠️ A SEASON WE COULD NOT ASK IS NEVER WRITTEN. A refused request is a failure
// to ASK, and recording it as an ANSWER of "no teams" is the class that wrote 80
// seasons as removed:true off a CloudFront wall (REPO_MANIFEST §6.35). Failed
// seasons are listed and the process exits NON-ZERO.
//
// Every request shape — headers, cookie queries, the single-flight session,
// doFetch, the ID!/String! variable fallback — is copied VERBATIM from
// scripts/probe-discover-teams.js, which ran green against this exact query on
// 2026-10-11. Nothing here is hand-written.
//
// Usage:
//   node scripts/build-club-index.js --dry-run
//   node scripts/build-club-index.js --active-only
//   node scripts/build-club-index.js                      # every season
//   node scripts/build-club-index.js --season=1ae60211
//   node scripts/build-club-index.js --resume
//
// NO actions/setup-node in the workflow (fetches api.playhq.com — absolute rule).

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const has  = (f) => args.includes('--' + f);
const val  = (f, d) => { const a = args.find(x => x.startsWith('--' + f + '=')); return a ? a.split('=').slice(1).join('=') : d; };

const DRY_RUN         = has('dry-run');
const ACTIVE_ONLY     = has('active-only');
const INCLUDE_REMOVED = has('include-removed');
const RESUME          = has('resume');
const TARGET_SEASON   = val('season', '');
const CONCURRENCY     = Math.max(1, parseInt(val('concurrency', '1'), 10) || 1);
const GAP_MS          = Math.max(0, parseInt(val('gap-ms', '600'), 10) || 0);
const COMMIT_EVERY    = Math.max(1, parseInt(val('commit-every', '250'), 10) || 250);

// A dead cookie produced four hours of 403s in Weekly Indexes on 2026-10-04.
// Grinding 3,500 seasons through a session that has stopped being accepted is
// the same failure with a bigger blast radius, so the run ABORTS.
const MAX_CONSECUTIVE_FAILURES = Math.max(1, parseInt(val('max-consecutive-failures', '25'), 10) || 25);

const MODE = TARGET_SEASON ? `single-${TARGET_SEASON}` : ACTIVE_ONLY ? 'active' : 'all';

const API_URL       = 'https://api.playhq.com/graphql';
const INDEX_FILE    = path.join(ROOT, 'data', 'sports-index.json');
const CLUB_MAP_DIR  = path.join(ROOT, 'club-map', 'bv');
const CLUBS_DIR     = path.join(ROOT, 'clubs');
const CLUB_INDEX    = path.join(ROOT, 'data', 'club-index.json');
const PROGRESS_FILE = path.join(ROOT, 'data', 'club-index-progress.json');

const log = (m) => console.log(`[club-index] ${new Date().toISOString().slice(11, 19)} ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Session — copied VERBATIM from probe-discover-teams.js ──────────────────

let sessionCookie  = null;
let sessionPromise = null;

const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' },
    query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

// ⚠️ fetch(), NOT https.request. §6.61/§6.62: same URL, same five headers, same
// user-agent, 10 s apart — fetch() GRANTED, https.request REFUSED. Do not
// "optimise" this back, and do not set content-length by hand.
// Resolves on ANY status; never throws for a 403.
async function doFetch(url, bodyObj, headers) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { ...headers, 'request-id': crypto.randomUUID() },
    body:    JSON.stringify(bodyObj),
  });
  const rawText = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(rawText); } catch (_) { body = null; }
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.rawCookies ? [res.rawCookies] : []);
  return { status: res.status, rawCookies: cookies.length ? cookies : undefined, body, rawText };
}

async function refreshSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (attempt > 1) await sleep(attempt * 5000);
      for (const body of COOKIE_QUERIES) {
        let res;
        try { res = await doFetch(API_URL, body, { ...HEADERS_BASE }); }
        catch (err) { lastErr = err; log(`  … session refresh attempt ${attempt} network error: ${err.code || err.message}`); continue; }
        const raw = res.rawCookies;
        if (!raw) continue;
        const parts = (Array.isArray(raw) ? raw : [raw]).flatMap(c => c.split(',')).map(c => c.trim().split(';')[0]).filter(Boolean);
        const get = (name) => parts.find(c => c.startsWith(name + '=')) || null;
        const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
        if (!tier || !session || !sub) continue;
        sessionCookie = `${tier}; ${session}; ${sub}`;
        log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    }
    throw new Error(`Failed to obtain session cookie after 10 attempts${lastErr ? ` (last network error: ${lastErr.code || lastErr.message})` : ''}`);
  })().finally(() => { sessionPromise = null; });
  return sessionPromise;
}

// ─── The query ───────────────────────────────────────────────────────────────
// Copied from probe-discover-teams.js. `organisation { id name }` is the TEAM'S
// OWNING CLUB — the whole point of this script. `grade` CAN be null on a returned
// team (EDJBA's first team: z101, U7, grade null — seen again live 2026-10-11).
const Q_TEAMS = `query discoverTeamsBySeason($seasonId: ID!) {
  discoverTeams(filter: {seasonID: $seasonId}) {
    id name
    grade { id name }
    organisation { id name }
  }
}`;
// ID! is PROVEN on this tenant (probe run 2026-10-11: "variable type that works:
// ID!"). The String! fallback costs nothing and is kept because discoverSeason on
// this same tenant needs String! where most fields take ID!.
const Q_TEAMS_STR = Q_TEAMS.replace('$seasonId: ID!', '$seasonId: String!');
let workingType = null;

// Returns a TAGGED outcome. `asked:true` means PlayHQ answered — an empty list is
// then a real answer. `asked:false` means we never got an answer and NOTHING may
// be written for that season.
async function discoverTeams(seasonId, allowRefresh = true) {
  if (!sessionCookie) await refreshSession();
  const variants = workingType ? [workingType] : [['ID!', Q_TEAMS], ['String!', Q_TEAMS_STR]];
  let last = '';
  for (const v of variants) {
    const [label, query] = v;
    let res;
    try { res = await doFetch(API_URL, { operationName: 'discoverTeamsBySeason', variables: { seasonId }, query }, { ...HEADERS_BASE, 'Cookie': sessionCookie }); }
    catch (err) { return { asked: false, status: 'network', detail: err.code || err.message }; }

    if (res.status === 403) {
      const b = res.rawText || '';
      const kind = (b.includes('DOCTYPE') || b.includes('Request blocked')) ? 'cloudfront-block' : 'http-403';
      // A cookie that stopped being accepted cannot be fixed by resending it.
      // Invalidate and re-obtain ONCE, then give up on this season.
      if (allowRefresh) {
        log(`  ${seasonId}: ${kind} — invalidating session and retrying once`);
        sessionCookie = null;
        await refreshSession();
        return discoverTeams(seasonId, false);
      }
      return { asked: false, status: kind };
    }
    if (res.status < 200 || res.status >= 300) {
      last = `${label} → HTTP ${res.status}: ${(res.rawText || '').slice(0, 200).replace(/\s+/g, ' ')}`;
      continue;
    }
    const json = res.body;
    if (!json) { last = `${label} → bad-json`; continue; }
    if (json.errors && json.errors.length) {
      last = `${label} → gql: ${json.errors.map(e => e.message).join(' | ').slice(0, 200)}`;
      continue;
    }
    if (!workingType) { workingType = v; log(`  variable type that works: ${label}`); }
    const raw = (json.data || json)?.discoverTeams;
    return { asked: true, teams: Array.isArray(raw) ? raw : [] };
  }
  return { asked: false, status: 'failed', detail: last };
}

// ─── git — the house pattern ─────────────────────────────────────────────────
// Per-path adds, but T16: above ~2,000 paths a per-path loop is hours of index
// I/O against a 527,900-file index, so batch with --pathspec-from-file and fall
// back to per-path only to isolate a failure. `git add` is ATOMIC across
// pathspecs — one unmatched path stages NOTHING, silently, exit 0 — which is why
// the staged shortstat is printed and an empty stage is reported, never assumed.
const GIT_OPTS      = { cwd: ROOT, stdio: 'pipe', timeout: 20 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const PUSH_ATTEMPTS = 60;
const BATCH_THRESHOLD = 2000;

function gitCommit(message, paths) {
  if (DRY_RUN) { log(`  [dry-run] ${message} (${paths.length} paths)`); return; }
  const unique = [...new Set(paths)].filter(Boolean);
  if (!unique.length) { log('  staging: nothing to stage'); return; }

  if (unique.length > BATCH_THRESHOLD) {
    const listFile = path.join(ROOT, '.club-index-pathspec');
    fs.writeFileSync(listFile, unique.join('\n') + '\n', 'utf8');
    try { execSync(`git add --pathspec-from-file=${JSON.stringify(listFile)}`, GIT_OPTS); }
    catch (e) {
      log(`  batched add failed (${(e.stderr || e.stdout || '').toString().trim().slice(0, 200)}) — isolating per path`);
      for (const p of unique) { try { execSync(`git add -- ${JSON.stringify(p)}`, GIT_OPTS); } catch (_) { log(`    unmatched: ${p}`); } }
    } finally { try { fs.unlinkSync(listFile); } catch (_) {} }
  } else {
    for (const p of unique) { try { execSync(`git add -- ${JSON.stringify(p)}`, GIT_OPTS); } catch (_) { log(`    unmatched: ${p}`); } }
  }

  const shortstat = execSync('git diff --staged --shortstat', GIT_OPTS).toString().trim();
  if (!shortstat) { log('  staging: no changes — nothing to commit'); return; }
  log(`  staging: ${shortstat}`);

  execSync(`git commit -m ${JSON.stringify(message.replace(/"/g, "'"))}`, GIT_OPTS);

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try {
      execSync('git fetch origin main', GIT_OPTS);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT_OPTS);
      execSync('git push origin main', GIT_OPTS);
      log(`  ✔ pushed (attempt ${attempt}): ${message}`);
      return;
    } catch (e) {
      const detail = (e.stderr || e.stdout || '').toString().trim() || e.message;
      if (/GH001|exceeds|too large/i.test(detail)) throw new Error(`push permanently rejected: ${detail}`);
      try { execSync('git merge --abort', GIT_OPTS); } catch (_) {}
      if (attempt === PUSH_ATTEMPTS) throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${detail}`);
      const wait = 1 + Math.floor(Math.random() * 90);
      log(`  … push contention (attempt ${attempt}) — retry in ${wait}s`);
      execSync(`sleep ${wait}`, { stdio: 'ignore' });
    }
  }
}

// ─── Disk helpers ────────────────────────────────────────────────────────────

function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  // A present-but-unreadable file is a FAULT, not an absence. Reading it as the
  // fallback would silently discard whatever it holds on the next write.
  catch (e) { throw new Error(`${path.relative(ROOT, p)} is present but unreadable: ${e.message}`); }
}

function writeJson(p, data) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
}

function loadProgress() {
  if (!RESUME) return null;
  const p = readJson(PROGRESS_FILE, null);
  if (!p || p.mode !== MODE) return null;
  return p;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log(`build-club-index — mode ${MODE}${DRY_RUN ? '  [DRY RUN — no writes, no commits]' : ''}`);
  log(`  concurrency ${CONCURRENCY} · gap ${GAP_MS}ms · commit every ${COMMIT_EVERY} seasons`);

  if (!fs.existsSync(INDEX_FILE)) throw new Error('data/sports-index.json not found');
  const index   = readJson(INDEX_FILE, { seasons: {} });
  const seasons = Object.values(index.seasons || {});
  if (!seasons.length) throw new Error('sports-index holds no seasons — refusing to run');

  let targets = seasons;
  if (TARGET_SEASON) {
    targets = seasons.filter(s => s.id === TARGET_SEASON);
    if (!targets.length) throw new Error(`season ${TARGET_SEASON} is not in sports-index`);
  } else if (ACTIVE_ONLY) {
    targets = seasons.filter(s => s.locked === false);
  }
  // removed:true stubs are unfetchable by design — PlayHQ answered "no grades"
  // for them. Asking wastes a request each and pollutes the failure list.
  if (!INCLUDE_REMOVED && !TARGET_SEASON) targets = targets.filter(s => s.removed !== true);

  const progress = loadProgress();
  const done = new Set(progress ? progress.done || [] : []);
  if (progress) log(`  resuming: ${done.size} season(s) already done in mode ${MODE}`);

  const queue = targets.filter(s => !done.has(s.id));
  log(`  ${targets.length} target season(s), ${queue.length} to ask`);
  if (!queue.length) { log('  nothing to do'); }

  // clubId -> { id, n, seasons: Map<sid, Set<tid>> }, assembled in memory for the
  // sids THIS RUN resolves. Merged onto whatever clubs/ already holds at write
  // time, so a partial run never deletes another run's seasons.
  const clubs = new Map();
  const failures = [];
  const emptySeasons = [];
  const pendingPaths = new Set();
  let askedOk = 0, teamsSeen = 0, teamsWithClub = 0, teamsWithoutClub = 0;
  let consecutiveFailures = 0;
  let sinceCommit = 0;

  function noteTeam(sid, tid, org) {
    teamsSeen++;
    if (!org || !org.id) { teamsWithoutClub++; return; }
    teamsWithClub++;
    const cid = String(org.id);
    let c = clubs.get(cid);
    if (!c) { c = { id: cid, n: org.name || '', seasons: new Map() }; clubs.set(cid, c); }
    if (!c.n && org.name) c.n = org.name;
    if (!c.seasons.has(sid)) c.seasons.set(sid, new Set());
    c.seasons.get(sid).add(String(tid));
  }

  function flushCommit(label) {
    if (!pendingPaths.size) return;
    writeJson(PROGRESS_FILE, { mode: MODE, done: [...done], updatedAt: new Date().toISOString() });
    pendingPaths.add('data/club-index-progress.json');
    gitCommit(label, [...pendingPaths]);
    pendingPaths.clear();
    sinceCommit = 0;
  }

  // Sequential by default. The probe ran this exact query one season at a time
  // and every call was granted; a wider pool is a NEW experiment against a WAF
  // that has refused this repo before, so it is opt-in via --concurrency.
  async function runOne(season) {
    const sid = season.id;
    const r = await discoverTeams(sid);

    if (!r.asked) {
      // A failure to ASK must never become a recorded ANSWER. Nothing is written
      // for this season and its old file, if any, is left untouched.
      failures.push({ sid, name: season.fullName || season.name || sid, status: r.status, detail: r.detail || '' });
      consecutiveFailures++;
      log(`  ✗ ${sid} ${(season.name || '').slice(0, 40)} — ${r.status}${r.detail ? ': ' + r.detail : ''}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`${consecutiveFailures} consecutive seasons could not be asked — aborting rather than grinding the rest of the sweep through a session PlayHQ has stopped accepting (2026-10-04 cost four hours of this)`);
      }
      return;
    }

    consecutiveFailures = 0;
    askedOk++;
    const teams = r.teams;
    const map = {};
    for (const t of teams) {
      if (!t || !t.id) continue;
      noteTeam(sid, t.id, t.organisation);
      if (t.organisation && t.organisation.id) map[String(t.id)] = String(t.organisation.id);
    }

    // An empty answer is a real answer and is recorded as one — but it is
    // reported separately, because a season that genuinely holds no teams and a
    // season we failed to understand should never read the same.
    if (!teams.length) emptySeasons.push(sid);

    writeJson(path.join(CLUB_MAP_DIR, `${sid}.json`), map);
    pendingPaths.add(`club-map/bv/${sid}.json`);
    done.add(sid);
    sinceCommit++;

    const withClub = Object.keys(map).length;
    log(`  ✓ ${sid} ${(season.name || '').slice(0, 40).padEnd(40)} ${String(teams.length).padStart(5)} teams · ${withClub} with a club`);
  }

  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(runOne));
    if (GAP_MS) await sleep(GAP_MS);
    if (sinceCommit >= COMMIT_EVERY) flushCommit(`build-club-index: ${done.size}/${targets.length} seasons`);
  }

  // ── clubs/{clubId}.json — MERGE, never replace ────────────────────────────
  log(`  writing ${clubs.size} club file(s)`);
  for (const c of clubs.values()) {
    const file = path.join(CLUBS_DIR, `${c.id}.json`);
    const existing = readJson(file, null);
    const merged = existing && typeof existing === 'object' && existing.seasons && typeof existing.seasons === 'object'
      ? { id: c.id, n: c.n || existing.n || '', seasons: { ...existing.seasons } }
      : { id: c.id, n: c.n || '', seasons: {} };
    // Only the sids this run RESOLVED are replaced. Every other season this club
    // holds is carried through untouched — that is what makes --active-only safe.
    for (const [sid, tids] of c.seasons) merged.seasons[sid] = [...tids].sort();
    writeJson(file, merged);
    pendingPaths.add(`clubs/${c.id}.json`);
  }

  // ── data/club-index.json — rebuilt from clubs/ on disk ────────────────────
  // Read back from disk rather than from memory, so a partial run still produces
  // a COMPLETE index covering clubs this run never touched.
  let indexRows = [];
  if (!DRY_RUN && fs.existsSync(CLUBS_DIR)) {
    for (const f of fs.readdirSync(CLUBS_DIR).filter(x => x.endsWith('.json'))) {
      const c = readJson(path.join(CLUBS_DIR, f), null);
      if (!c || !c.id) continue;
      const sids = Object.keys(c.seasons || {});
      const teamTotal = sids.reduce((t, s) => t + ((c.seasons[s] || []).length), 0);
      indexRows.push({ id: c.id, n: c.n || '', t: teamTotal, s: sids.length });
    }
  } else {
    for (const c of clubs.values()) {
      indexRows.push({ id: c.id, n: c.n || '', t: [...c.seasons.values()].reduce((t, s) => t + s.size, 0), s: c.seasons.size });
    }
  }
  indexRows.sort((a, b) => (a.n || '').localeCompare(b.n || '') || a.id.localeCompare(b.id));

  // This file only ever grows under a full sweep. If it would SHRINK, the merge
  // lost rows and nothing may be written — the same guard update-team-index.js
  // carries, for the same reason.
  const prevRows = readJson(CLUB_INDEX, null);
  if (Array.isArray(prevRows) && !TARGET_SEASON && !ACTIVE_ONLY && indexRows.length < prevRows.length) {
    throw new Error(`ABORT: club-index would shrink ${prevRows.length} -> ${indexRows.length} clubs. Nothing written.`);
  }
  writeJson(CLUB_INDEX, indexRows);
  pendingPaths.add('data/club-index.json');

  flushCommit(`build-club-index: ${askedOk} seasons, ${indexRows.length} clubs`);

  // ── Report ────────────────────────────────────────────────────────────────
  const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';
  console.log('');
  log('─'.repeat(60));
  log(`seasons asked OK ....... ${askedOk} of ${targets.length}`);
  log(`seasons that answered 0  ${emptySeasons.length}${emptySeasons.length ? '  e.g. ' + emptySeasons.slice(0, 8).join(', ') : ''}`);
  log(`teams seen ............. ${teamsSeen.toLocaleString()}`);
  log(`  with a club .......... ${teamsWithClub.toLocaleString()} (${pct(teamsWithClub, teamsSeen)})`);
  log(`  with NO club ......... ${teamsWithoutClub.toLocaleString()} (${pct(teamsWithoutClub, teamsSeen)})`);
  log(`clubs ................... ${indexRows.length}`);
  if (indexRows.length) {
    log(`largest: ${indexRows.slice().sort((a, b) => b.t - a.t).slice(0, 5).map(c => `${c.n || c.id} (${c.t})`).join(' · ')}`);
  }

  if (failures.length) {
    log('─'.repeat(60));
    log(`⚠ ${failures.length} season(s) COULD NOT BE ASKED. Nothing was written for any of them.`);
    // ⚠️ 2026-10-11 — THIS LINE USED TO DROP `detail`, AND detail IS THE ONLY
    // THING THAT SAYS WHY. The first live dry run reported two seasons as bare
    // `failed` with no cause, and the reason string existed the whole time — on
    // the ✗ line printed hundreds of lines earlier, which is not where anyone
    // reads a failure list. A summary that names a failure without naming its
    // cause is a failure report you cannot act on.
    for (const f of failures.slice(0, 40)) log(`   ${f.sid}  ${f.status.padEnd(16)} ${f.name}${f.detail ? `\n        └─ ${f.detail}` : '  (no detail recorded — see the ✗ line for this season above)'}`);
    if (failures.length > 40) log(`   … and ${failures.length - 40} more`);
    // Status tally, so 300 failures of one cause never read like 300 unrelated ones.
    const byStatus = {};
    for (const f of failures) byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    log(`   by cause: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
    log('Re-run with --resume to retry only these.');
    // The progress file is DELIBERATELY left in place so --resume retries exactly
    // the failures. Delete-on-SUCCESS only.
    throw new Error(`${failures.length} of ${targets.length} seasons could not be asked`);
  }

  if (!DRY_RUN && fs.existsSync(PROGRESS_FILE)) {
    fs.unlinkSync(PROGRESS_FILE);
    gitCommit('build-club-index: complete — progress file removed', ['data/club-index-progress.json']);
  }
  log('complete');
}

main().catch((e) => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
