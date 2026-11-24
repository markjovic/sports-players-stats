// scripts/probe-stale-grade-membership.js
// REVISION 2026-11-24a — first version.
//
// READ-ONLY. No writes, no git, no lock, no deletions. One question:
//
//   For a team that still holds UNPLAYED FUTURE fixtures in a grade, does
//   PlayHQ's ladder for that grade still list the team?
//
// WHY IT EXISTS. The `sup` flag marks a stale fixture when the team has a PLAYED
// game elsewhere that DAY. It therefore cannot touch fixtures in the FUTURE: on
// 2026-11-24, B11 Spirit Magic 1 had moved to BR by 20 Nov and still held grade-D
// fixtures for Rounds 9-16 (Dec-Mar). Those inflate "still to play" and no rule
// based on same-day evidence can ever see them.
//
// The retired display pass inferred them from shape — "the team's last played
// grade is BR, so the D fixtures are residue". That inference was deleted on
// purpose, and B11 Raptors 1 shows why it is unsafe: that team went B -> AR -> B,
// so leaving a grade does not mean it will not return.
//
// So this probe asks whether a NON-inferential signal exists. If PlayHQ drops a
// regraded team from the old grade's ladder while still serving its residual
// fixtures, that absence is a measurement and a rule can stand on it. If PlayHQ
// still lists the team, there is no such signal and the idea is dead — which is
// equally an answer.
//
// ⚠⚠ THE CONTROL IS THE POINT, NOT THE SUSPECTS. An "absent" result means nothing
// on its own: the ladder could simply be incomplete, which is exactly what
// probe-grade-ladder.js was written to investigate in August (it found grades
// returning NO ladder at all). So this also checks teams whose LAST PLAYED game
// is in that grade — teams that unambiguously belong. If the control teams are
// absent too, the ladder is not a membership signal and nothing may be built on
// it. A measurement without a control is a hope.
//
// The session bootstrap, headers, DiscoverGrade query and gql() below are COPIED
// VERBATIM from scripts/probe-grade-ladder.js, which took them from
// discover-fixtures.js. Nothing here sends anything different.
//
// Usage:
//   node scripts/probe-stale-grade-membership.js --season=3d25b666
//   node scripts/probe-stale-grade-membership.js --season=3d25b666 --grades=6
//
// NO setup-node in the workflow (fetches api.playhq.com — absolute rule).

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (f, d) => { const a = args.find(x => x.startsWith('--' + f + '=')); return a ? a.split('=')[1] : d; };
const SEASON   = arg('season', '');
const MAXG     = Number(arg('grades', '8')) || 8;
const TODAY    = arg('today', new Date().toISOString().slice(0, 10));
// ⚠ --no-playhq: do the LOCAL half only and contact nothing. Added because the
// local half answers "how big is this population" on its own, and that is worth
// knowing before spending a PlayHQ run on it. It is also the only part that can
// be exercised off-network: the copied session bootstrap retries 10 times with
// escalating backoff (~4 minutes) before giving up, which is right for the
// nightly and looks like a hang in a diagnostic.
const NO_PLAYHQ = args.includes('--no-playhq');
// ⚠ --null-control=N : the control for the NULL answer. ADDED 2026-11-25.
// The 2026-11-24 run returned `discoverGrade is NULL` for the two grades holding
// 13 of the 15 suspects. That looks like a strong signal — PlayHQ does not know
// the grade id, so the fixtures we hold in it are residue of a grade that no
// longer exists under that id — and it is UNINTERPRETABLE on its own, for the
// same reason ladder absence was: nobody has measured whether a healthy,
// currently-played grade can also return NULL.
//
// This pass measures that, from TWO independent endpoints:
//   (a) DiscoverSeason — one call, returns PlayHQ's own grade list for the
//       season. Its control is built in: the grades that DO match.
//   (b) DiscoverGrade on up to N grades that are unambiguously live (a game was
//       PLAYED in them within --live-days). Same endpoint that returned NULL,
//       so it tests that endpoint rather than a different one.
// A NULL from any live grade kills the signal. 0 disables the pass entirely.
const NULL_CONTROL = Math.max(0, Number(arg('null-control', '0')) || 0);
const LIVE_DAYS    = Math.max(1, Number(arg('live-days', '14')) || 14);
// ⚠ --seasons=all | a,b,c : THE SWEEP. ADDED 2026-11-25, and it exists because
// of a correction from Mark, not a finding of mine.
//
// The 2026-11-24 run found 3 grades in 3d25b666 absent from DiscoverSeason. Two
// were regrade residue. The third, fb2c151b "Friday U13 Boys E", was 12 games,
// ALL PLAYED, 0 unplayed — a COMPLETED grade that PlayHQ has dropped from the
// season list. Competitions hide completed grading rounds, and showing them is a
// major reason StatTrack exists. "Absent from DiscoverSeason" therefore does NOT
// mean "regraded away"; it means PlayHQ will not serve this grade again, and the
// data we hold may be the only copy.
//
// So the sweep classifies every dead grade by a LOCAL fact that cannot be got
// wrong by an endpoint:
//   COMPLETED-HIDDEN — 0 unplayed games. Pure played history. ⚠ NEVER TOUCH.
//   RESIDUE          — holds unplayed fixtures. Only these can be stale.
// One DiscoverSeason call per season. A season whose call FAILS is counted and
// named, never folded in with the clean ones.
const SWEEP_RAW = arg('seasons', '');
const SWEEP     = SWEEP_RAW ? SWEEP_RAW.split(',').map(s => s.trim()).filter(Boolean) : [];
const SLEEP_MS  = Math.max(0, Number(arg('sleep-ms', '250')) || 0);
// ⚠ --offset / --limit : shard the sweep. ADDED 2026-11-25 after a full sweep was
// killed by the job's 30-minute timeout at 1850 of 3194 seasons. games/bv holds
// 3194 season files, not the 480 quoted in the build-team-stats notes, which
// count something else. At ~1s per season a whole sweep is ~50 minutes.
const OFFSET    = Math.max(0, Number(arg('offset', '0')) || 0);
const LIMIT     = Math.max(0, Number(arg('limit', '0')) || 0);   // 0 = no limit
const GAMES_DIR = path.join(ROOT, 'games', 'bv');

if (!SEASON && !SWEEP.length) { console.error('--season=<sid> is required (or --seasons=all)'); process.exit(2); }

// sideIds and isPlayedGame come from the shared lib — one predicate, never a
// second copy (T103/T105).
const { sideIds, isPlayedGame } = require('./lib/round-refresh.cjs');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
          res = await doFetch(API_URL, body, { ...HEADERS_BASE });
        } catch (err) {
          lastErr = err;
          console.log(`  … session refresh attempt ${attempt} network error: ${err.code || err.message} — retrying`);
          continue;
        }
        const raw = res.rawCookies;
        if (!raw) continue;
        // Extract each named cookie value, then reassemble in the exact order
        // the mobile client sends them: phq_tier first, phq_session, phq_sub.
        // (The server returns them in a different order in set-cookie headers.)
        const parts = (Array.isArray(raw) ? raw : [raw]).flatMap(c => c.split(',')).map(c => c.trim().split(';')[0]).filter(Boolean);
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
    : (res.rawCookies ? [res.rawCookies] : []);
  return {
    status:     res.status,
    rawCookies: cookies.length ? cookies : undefined,
    body,
    rawText,
  };
}


async function fetchProfile(profileID) {
  if (!sessionCookie) await refreshSession();
  const body = { ...PROFILE_QUERY, variables: { profileID } };
  let res;
  try {
    res = await doFetch(API_URL, body, { ...HEADERS_BASE, 'Cookie': sessionCookie });
  } catch (err) {
    // A timeout gets its own status so the log says "this request never came
    // back" rather than the catch-all "error". Both are transport, both are
    // retried, but only one of them tells you the endpoint went quiet on you.
    return { status: err && err.code === 'ETIMEDOUT' ? 'timeout' : 'error', err };
  }
  if (res.status === 403) {
    let b = res.rawText || '';
    if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { status: 'cloudfront-block' };
    return { status: 'private' };
  }
  if (res.status === 404) return { status: 'notfound' };
  if (res.status < 200 || res.status >= 300) return { status: `http-${res.status}` };
  const json = res.body;
  if (!json) { return { status: 'bad-json' }; }
  if (json.errors) return { status: 'gql-error', errors: json.errors };
  return { status: 'ok', data: json.data };
}


// Queries copied VERBATIM from discover-fixtures.js — the point is to reproduce
// what that script sends, not to send something better.
const Q_GRADE_TEAMS = `
query DiscoverGrade($id: ID!) {
  discoverGrade(gradeID: $id) {
    id name
    ladder {
      pool { name }
      standings { team { id name } }
    }
  }
}`;
const Q_SEASON = `query DiscoverSeason($id: String!) { discoverSeason(seasonID: $id) { id name grades { id name } } }`;

async function gql(opName, query, variables) {
  if (!sessionCookie) await refreshSession();
  let res;
  try {
    res = await doFetch(API_URL, { operationName: opName, variables: variables, query: query }, { ...HEADERS_BASE, 'Cookie': sessionCookie });
  } catch (err) { return { err: 'transport: ' + err.message }; }
  if (res.status === 403) {
    let b = res.rawText || '';
    return { err: (b.includes('DOCTYPE') || b.includes('Request blocked')) ? 'cloudfront-block' : 'http-403' };
  }
  if (res.status < 200 || res.status >= 300) {
    let b = (res.rawText || '').slice(0, 400);
    return { err: 'http-' + res.status + ': ' + b.replace(/\s+/g, ' ') };
  }
  const json = res.body;
  if (!json) { return { err: 'bad-json' }; }
  if (json.errors && json.errors.length) return { err: 'gql: ' + json.errors.map(e => e.message).join(' | ').slice(0, 300) };
  return { data: json.data || json };
}

// ─── main ────────────────────────────────────────────────────────────────────

function loadGames(sid) {
  const f = path.join(GAMES_DIR, `${sid}.json`);
  if (!fs.existsSync(f)) { console.error(`games/bv/${sid}.json not found in this checkout.`); process.exit(2); }
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).games || {}; }
  catch (e) { console.error(`games/bv/${sid}.json did not parse: ${e.message}`); process.exit(2); }
}

// PlayHQ's own grade list for a season. Q_SEASON is already defined above,
// copied verbatim from discover-fixtures.js with the rest of the query set.
// This is the SECOND endpoint: if it omits a grade that DiscoverGrade called
// NULL, two independently-served answers agree, and the grades it does list are
// the control for that reading.
async function seasonGradeIds(sid) {
  const r = await gql('DiscoverSeason', Q_SEASON, { id: sid });
  if (r.err) return { err: r.err };
  const s = r.data && r.data.discoverSeason;
  if (!s) return { err: 'discoverSeason is NULL — PlayHQ does not know this season id' };
  const ids = new Map();
  for (const g of (Array.isArray(s.grades) ? s.grades : [])) {
    if (g && g.id) ids.set(String(g.id), g.name || null);
  }
  return { name: s.name || null, ids };
}

async function ladderTeams(gid) {
  const r = await gql('DiscoverGrade', Q_GRADE_TEAMS, { id: gid });
  if (r.err) return { err: r.err };
  const g = r.data && r.data.discoverGrade;
  if (!g) return { err: 'discoverGrade is NULL — PlayHQ does not know this grade id' };
  const pools = Array.isArray(g.ladder) ? g.ladder : [];
  const ids = new Set();
  for (const p of pools) for (const s of ((p && p.standings) || [])) {
    const id = s && s.team && s.team.id;
    if (id) ids.add(String(id));
  }
  return { name: g.name || null, pools: pools.length, ids };
}

// ONE definition of the per-grade arithmetic, used by BOTH the single-season
// path and the sweep. Two copies of this would be the 47-vs-52 defect again.
function buildByGrade(games) {
  const byGrade = new Map();                 // gid -> grade entry
  const lastPlayed = new Map();              // tid -> { d, t, key, gid }
  for (const id of Object.keys(games)) {
    const g = games[id];
    if (!g || !g.gid) continue;
    if (!byGrade.has(g.gid)) byGrade.set(g.gid, { gn: g.gn || null, future: new Set(), control: new Set(), total: 0, lastPlayedHere: null, played: 0, unplayedFuture: 0, unplayedPast: 0, unplayedUndated: 0, unplayedTids: new Set() });
    const e = byGrade.get(g.gid);
    if (g.gn && !e.gn) e.gn = g.gn;
    e.total++;
    const played = isPlayedGame(g);
    // Most recent PLAYED date in this grade — the test for "this grade is live
    // right now", used only by the --null-control pass.
    if (played && g.d && (!e.lastPlayedHere || g.d > e.lastPlayedHere)) e.lastPlayedHere = g.d;
    // The split that sizes any dead-grade rule. A PLAYED game in a dead grade is
    // real history and is not residue; only the unplayed fixtures are. Counted
    // locally — this costs no API call and is right whatever PlayHQ says.
    if (played) e.played++;
    else {
      if (!g.d) e.unplayedUndated++;
      else if (g.d >= TODAY) e.unplayedFuture++;
      else e.unplayedPast++;
      for (const tid of sideIds(g)) e.unplayedTids.add(tid);
    }
    for (const tid of sideIds(g)) {
      if (!played && g.d && g.d >= TODAY) e.future.add(tid);
      if (played && g.d) {
        const prev = lastPlayed.get(tid);
        const cur = { d: g.d, t: g.t || '', key: id, gid: g.gid };
        if (!prev || cur.d > prev.d || (cur.d === prev.d && cur.t > prev.t) || (cur.d === prev.d && cur.t === prev.t && cur.key > prev.key)) {
          lastPlayed.set(tid, cur);
        }
      }
    }
  }
  for (const [tid, lp] of lastPlayed) {
    const e = byGrade.get(lp.gid);
    if (e) e.control.add(tid);
  }
  return { byGrade, lastPlayed };
}

// ─── the sweep ───────────────────────────────────────────────────────────────
//
// ⚠⚠ THE CLASSIFICATION IS THE POINT, NOT THE COUNT. A grade absent from
// DiscoverSeason is one of two completely different things, and only a LOCAL
// fact separates them:
//
//   COMPLETED-HIDDEN — the grade holds NO unplayed game. It is finished history
//                      that PlayHQ has stopped serving. Competitions do this to
//                      completed grading rounds. Showing them is a reason
//                      StatTrack exists, and the copy we hold may be the only
//                      one. NOTHING may ever be built that touches these.
//   RESIDUE          — the grade holds unplayed fixtures. Only these can be
//                      stale, and only these are category 2.
//
// The split is computed from games/bv, so no endpoint can get it wrong. A season
// whose DiscoverSeason call FAILS is counted and named separately — a failed
// read is not a season with no dead grades, and must never be added to one.
async function sweepSeasons(list) {
  console.log('\n' + '═'.repeat(78));
  console.log(`  SWEEP — dead grades across ${list.length} season(s), ONE DiscoverSeason call each`);
  console.log('─'.repeat(78));
  console.log('  COMPLETED-HIDDEN = 0 unplayed games. Finished history PlayHQ no longer serves.');
  console.log('                     ⚠ This is the data StatTrack exists to keep. Never touch it.');
  console.log('  RESIDUE          = holds unplayed fixtures. Only these are category 2.');
  console.log(`  pacing: ${SLEEP_MS}ms between seasons`);

  const T0 = Date.now();
  let okN = 0, gradesHeld = 0;
  const failed = [];
  const withDead = [];
  let chC = 0, chPlayed = 0, resC = 0, resUnplayed = 0, resFuture = 0;
  const resTeams = new Set();

  for (let i = 0; i < list.length; i++) {
    const sid = list[i];
    if (i && SLEEP_MS) await sleep(SLEEP_MS);
    // ⚠ A RUNNING TALLY, NOT JUST A COUNTER. The first full sweep was killed by
    // the job timeout at 1850 of 3194 and produced NOTHING, because every figure
    // was held until the end. A killed run must still leave usable, and visibly
    // partial, numbers behind.
    if (i && i % 50 === 0) {
      const el = (Date.now() - T0) / 1000;
      const rate = i / el;
      const left = (list.length - i) / (rate || 1);
      console.log(`  … ${i} of ${list.length} scanned  ${el.toFixed(0)}s elapsed, ${rate.toFixed(2)}/s,`
                + ` ~${(left / 60).toFixed(1)} min remaining`);
      console.log(`      PARTIAL TALLY: ok ${okN}, unreadable ${failed.length}, seasons with dead grades ${withDead.length}`
                + ` | COMPLETED-HIDDEN ${chC} (${chPlayed} played) | RESIDUE ${resC} (${resUnplayed} unplayed, ${resFuture} future)`);
    }
    let games;
    try { games = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${sid}.json`), 'utf8')).games || {}; }
    catch (e) { failed.push({ sid, err: 'local read: ' + e.message }); continue; }
    const { byGrade } = buildByGrade(games);
    const S = await seasonGradeIds(sid);
    if (S.err) { failed.push({ sid, err: S.err }); continue; }
    okN++; gradesHeld += byGrade.size;
    const dead = [];
    for (const [gid, e] of byGrade) {
      if (S.ids.has(gid)) continue;
      const un = e.unplayedFuture + e.unplayedPast + e.unplayedUndated;
      const cls = un === 0 ? 'COMPLETED-HIDDEN' : 'RESIDUE';
      if (cls === 'COMPLETED-HIDDEN') { chC++; chPlayed += e.played; }
      else {
        resC++; resUnplayed += un; resFuture += e.unplayedFuture;
        for (const t of e.unplayedTids) resTeams.add(sid + ':' + t);
      }
      dead.push({ gid, gn: e.gn, cls, e, un });
    }
    if (dead.length) withDead.push({ sid, name: S.name, held: byGrade.size, listed: S.ids.size, dead });
  }

  console.log(`\n  sweep finished in ${((Date.now() - T0) / 1000 / 60).toFixed(1)} min — the totals below are COMPLETE`);
  const CAP = 40;
  for (const s of withDead.slice(0, CAP)) {
    console.log(`\n  SEASON ${s.sid} ${JSON.stringify(s.name)}  held ${s.held}, PlayHQ lists ${s.listed}, dead ${s.dead.length}`);
    for (const d of s.dead) {
      if (d.cls === 'COMPLETED-HIDDEN') {
        console.log(`     ${d.gid}${d.gn ? ` "${d.gn}"` : ''}  COMPLETED-HIDDEN  ${d.e.total} game(s), all played   ⚠ never touch`);
      } else {
        console.log(`     ${d.gid}${d.gn ? ` "${d.gn}"` : ''}  RESIDUE  ${d.e.total} game(s): ${d.e.played} played,`
                  + ` ${d.un} unplayed (${d.e.unplayedFuture} future-dated), ${d.e.unplayedTids.size} team(s)`);
      }
    }
  }
  if (withDead.length > CAP) console.log(`\n  … and ${withDead.length - CAP} further season(s) with dead grades (printing capped at ${CAP})`);

  console.log('\n' + '═'.repeat(78));
  console.log(`  seasons scanned OK : ${okN} of ${list.length}`);
  if (failed.length) {
    console.log(`  ⚠ seasons that could NOT be read : ${failed.length} — these are NOT seasons with no`);
    console.log('    dead grades, and are counted in nothing below:');
    for (const f of failed.slice(0, 20)) console.log(`       ${f.sid} : ${f.err}`);
    if (failed.length > 20) console.log(`       … and ${failed.length - 20} more (printing capped at 20)`);
  }
  console.log(`  grades held across the ${okN} season(s) read : ${gradesHeld}`);
  console.log(`  seasons holding at least one dead grade : ${withDead.length}`);
  console.log(`  dead grades : ${chC + resC}`);
  console.log(`     COMPLETED-HIDDEN : ${chC}  holding ${chPlayed} PLAYED game(s)`);
  console.log(`     RESIDUE          : ${resC}  holding ${resUnplayed} unplayed (${resFuture} future-dated)`
            + ` across ${resTeams.size} team-slot(s)`);
  console.log('');
  console.log('  HOW TO READ THIS — and do not read it any other way:');
  console.log(`   · The ${chPlayed} PLAYED game(s) in COMPLETED-HIDDEN grades are finished history that`);
  console.log('     PlayHQ will not serve again. Absence from the season list is NOT evidence that');
  console.log('     anything is stale — it is the hiding behaviour, and the copy here may be the');
  console.log('     only one. Any rule that acts on absence alone would destroy them.');
  console.log(`   · Only the ${resUnplayed} unplayed fixture(s) in RESIDUE grades are category 2, and the`);
  console.log('     split that separates them is local, not an endpoint answer.');
  console.log('   · A dead grade is NOT refetchable: the nightly cannot fetch a grade PlayHQ does');
  console.log('     not know, and a deletion comes only from a fetch that succeeded, so nothing in');
  console.log('     either class can change by itself again.');
  console.log('  Nothing was written. No flag, no deletion, no commit.');
}

// ─── the --null-control pass ─────────────────────────────────────────────────
//
// ⚠⚠ THE CONTROL IS THE POINT HERE TOO. `discoverGrade is NULL` LOOKS like a
// strong grade-level signal. It is worth nothing until somebody has shown that a
// grade being played in right now does not also return it. That is all this
// does. It asks two endpoints, and neither answer is an inference about shape.
async function nullControlPass(sid, byGrade, lastPlayed, interesting, nullGrades, probedGids) {
  console.log('\n' + '═'.repeat(78));
  console.log('  --null-control — IS `discoverGrade is NULL` A SIGNAL, OR IS IT NOISE?');
  console.log('─'.repeat(78));
  if (!nullGrades.length) {
    console.log('  No grade answered NULL above, so this pass has no subject. What follows is a');
    console.log('  baseline reading only.');
  } else {
    const sS = nullGrades.reduce((a, x) => a + x.suspects, 0);
    const gS = nullGrades.reduce((a, x) => a + x.total, 0);
    console.log(`  ${nullGrades.length} grade(s) answered NULL above — ${sS} suspect(s), ${gS} game(s) on file:`);
    for (const g of nullGrades) {
      console.log(`     ${g.gid}${g.gn ? ` "${g.gn}"` : ''}  ${g.total} game(s), ${g.suspects} suspect(s)`);
    }
  }

  // (a) A SECOND, INDEPENDENT ENDPOINT. Its control is built in: the grades it
  //     DOES list. If it omits exactly the grades DiscoverGrade called NULL and
  //     lists all the rest, two separately-served answers agree.
  console.log('\n  (a) DiscoverSeason — PlayHQ\'s own grade list for this season (ONE call)');
  const S = await seasonGradeIds(sid);
  let seasonVerdict = null;
  if (S.err) {
    console.log(`      ERROR: ${S.err}`);
    console.log('      The season list could not be read, so it says nothing either way.');
  } else {
    const ours    = [...byGrade.keys()];
    const missing = ours.filter(g => !S.ids.has(g));
    const extra   = [...S.ids.keys()].filter(g => !byGrade.has(g));
    console.log(`      season=${JSON.stringify(S.name)}  PlayHQ lists ${S.ids.size} grade(s); we hold ${ours.length}`);
    console.log(`      we hold but PlayHQ does NOT list : ${missing.length}`);
    // ⚠ A grade can be missing from the season list WITHOUT having been probed —
    // it only reaches the main loop if it holds suspects. Probe the rest here so
    // every candidate has BOTH endpoints behind it, and print the local split so
    // the size of any rule is a measurement rather than the game count.
    let budget = NULL_CONTROL;
    // Counted over EVERY missing grade, not just the ones the main loop happened
    // to probe — a grade reaches that loop only if it holds suspects, so a
    // verdict counted from `nullGrades` alone silently under-reports.
    let corrob = 0, disagree = 0, unread = 0;
    for (const g of missing.slice(0, 20)) {
      const e = byGrade.get(g);
      let tag;
      if (nullGrades.some(x => x.gid === g)) { corrob++; tag = '   ← NULL on DiscoverGrade (probed above)'; }
      else if (probedGids.has(g)) { disagree++; tag = '   ← but DiscoverGrade ANSWERED for it — the two endpoints DISAGREE'; }
      else if (budget > 0) {
        budget--;
        const L2 = await ladderTeams(g);
        probedGids.add(g);
        if (L2.err && L2.err.indexOf('discoverGrade is NULL') === 0) { corrob++; tag = '   ← NULL on DiscoverGrade too (probed here)'; }
        else if (L2.err) { unread++; tag = `   ← DiscoverGrade could not be read: ${L2.err}`; }
        else { disagree++; tag = `   ← but DiscoverGrade ANSWERED for it (${L2.ids.size} team(s)) — the two endpoints DISAGREE`; }
      } else { unread++; tag = '   ← NOT probed on DiscoverGrade (--null-control budget spent)'; }
      console.log(`         ${g}${e && e.gn ? ` "${e.gn}"` : ''}${tag}`);
      if (e) {
        const un = e.unplayedFuture + e.unplayedPast + e.unplayedUndated;
        console.log(`             ${e.total} game(s): ${e.played} PLAYED (real history — not residue),`
                  + ` ${un} unplayed`);
        console.log(`             of the unplayed: ${e.unplayedFuture} dated today or later,`
                  + ` ${e.unplayedPast} past-dated, ${e.unplayedUndated} undated`);
        console.log(`             teams holding an unplayed fixture here: ${e.unplayedTids.size}`);
      }
    }
    if (missing.length > 20) console.log(`         … and ${missing.length - 20} more (printing capped at 20)`);
    console.log(`      PlayHQ lists but we do NOT hold : ${extra.length}`);
    const nullListedAnyway = nullGrades.filter(g => S.ids.has(g.gid)).length;
    if (nullListedAnyway) disagree += nullListedAnyway;
    if (missing.length > 20) unread += missing.length - 20;
    if (corrob || disagree || unread || nullGrades.length) {
      console.log(`      dead-grade candidates, counted over ALL ${missing.length} missing grade(s):`);
      console.log(`         ${corrob} confirmed by BOTH endpoints (absent from the season list AND NULL on DiscoverGrade)`);
      console.log(`         ${disagree} where the two endpoints DISAGREE`);
      console.log(`         ${unread} not read on DiscoverGrade, so not confirmed either way`);
      if (nullListedAnyway) {
        console.log(`         ⚠ ${nullListedAnyway} grade(s) answered NULL yet ARE in the season list`);
      }
      seasonVerdict = (corrob > 0 && disagree === 0) ? 'agree' : (disagree > 0 ? 'disagree' : null);
    }
  }

  // (b) THE SAME ENDPOINT THAT RETURNED NULL, on grades that are unambiguously
  //     live. A grade a suspect MOVED TO is probed first — it is both live and
  //     directly relevant.
  console.log(`\n  (b) DiscoverGrade on up to ${NULL_CONTROL} grade(s) that are unambiguously LIVE`);
  const cutoff = new Date(Date.parse(TODAY + 'T00:00:00Z') - LIVE_DAYS * 86400000).toISOString().slice(0, 10);
  const destGids = new Set();
  for (const e of interesting) {
    for (const t of e.suspects) { const lp = lastPlayed.get(t); if (lp) destGids.add(lp.gid); }
  }
  const liveAll = [...byGrade.entries()]
    .filter(([gid, e]) => e.lastPlayedHere && e.lastPlayedHere >= cutoff && !probedGids.has(gid))
    .sort((a, b) => {
      const ad = destGids.has(a[0]) ? 0 : 1, bd = destGids.has(b[0]) ? 0 : 1;
      if (ad !== bd) return ad - bd;
      if (a[1].lastPlayedHere !== b[1].lastPlayedHere) return a[1].lastPlayedHere < b[1].lastPlayedHere ? 1 : -1;
      return a[0] < b[0] ? -1 : 1;   // stated arbitrary tie-break, not chronology
    });
  console.log(`      grades with a PLAYED game on or after ${cutoff}, not already probed : ${liveAll.length}`);
  console.log(`      of those, grades a suspect MOVED TO (probed first) : ${liveAll.filter(([g]) => destGids.has(g)).length}`);
  const sample = liveAll.slice(0, NULL_CONTROL);
  let okN = 0, nullN = 0, errN = 0;
  for (const [gid, e] of sample) {
    const L = await ladderTeams(gid);
    const tag = destGids.has(gid) ? 'DEST' : 'live';
    const head = `      ${tag} ${gid}${e.gn ? ` "${e.gn}"` : ''}  last played ${e.lastPlayedHere}`;
    if (L.err) {
      if (L.err.indexOf('discoverGrade is NULL') === 0) { nullN++; console.log(`${head}  → NULL  ⚠`); }
      else { errN++; console.log(`${head}  → ERROR: ${L.err}`); }
    } else { okN++; console.log(`${head}  → ok, ${L.ids.size} team(s) listed`); }
  }
  if (!sample.length) console.log('      (no live grade was available to sample)');

  console.log('\n  HOW TO READ THIS — and do not read it any other way:');
  if (nullN > 0) {
    console.log(`   · ${nullN} LIVE grade(s) ALSO answered NULL. NULL is NOT a membership signal — a`);
    console.log('     grade being played in right now returns it too. Nothing may be built on it.');
  } else if (!sample.length) {
    console.log('   · DiscoverGrade has no control here, because no live grade was sampled.');
    console.log('     Nothing is concluded from NULL.');
  } else if (errN) {
    console.log(`   · ${okN} live grade(s) answered normally and NONE answered NULL, but ${errN} could`);
    console.log('     not be read at all. The sample is weakened — say so before building on it.');
  } else {
    console.log(`   · ${okN} of ${okN} live grade(s) answered normally and NONE answered NULL. On this`);
    console.log('     endpoint, NULL does not happen to a grade that is being played in.');
  }
  if (seasonVerdict === 'agree') {
    console.log('   · DiscoverSeason and DiscoverGrade agree on every candidate they both answered');
    console.log('     for, and the grades the season list DOES carry are that reading\'s');
    console.log('     control. That is a measurement, not an inference about shape.');
  } else if (seasonVerdict === 'disagree') {
    // ⚠ Do NOT name a direction here. A disagreement is EITHER a grade the season
    // list omits that DiscoverGrade answers for, OR one it lists that
    // DiscoverGrade calls NULL, and the counter cannot tell you which. The
    // per-grade tags above say it exactly; this line must not guess.
    console.log('   · The two endpoints DISAGREE on at least one candidate — see the per-grade');
    console.log('     tags above for which, and in which direction. A grade-level test is not');
    console.log('     safe while they disagree.');
  }
  console.log('  Nothing was written. No flag, no deletion, no commit.');
}

(async () => {
  console.log('probe-stale-grade-membership [READ-ONLY] — no writes, no git, no deletions');
  console.log(`  season: ${SEASON}   today: ${TODAY}   grades examined: up to ${MAXG}`);
  if (NULL_CONTROL) {
    console.log(`  --null-control=${NULL_CONTROL}  --live-days=${LIVE_DAYS}`
              + (NO_PLAYHQ ? '   ⚠ IGNORED: --no-playhq contacts nothing' : ''));
  }
  console.log('─'.repeat(78));

  if (SWEEP.length) {
    let list = SWEEP;
    if (SWEEP.length === 1 && SWEEP[0] === 'all') {
      list = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
      console.log(`  --seasons=all → ${list.length} season file(s) in games/bv`);
    }
    // Sharding. The slice is stated in the output, so a sharded run can never be
    // mistaken for a whole one.
    const full = list.length;
    if (OFFSET || LIMIT) {
      list = list.slice(OFFSET, LIMIT ? OFFSET + LIMIT : undefined);
      console.log(`  ⚠ SHARD: seasons ${OFFSET} to ${OFFSET + list.length - 1} of ${full}.`
                + ` THIS IS A PART, NOT THE WHOLE — its totals cover ${list.length} season(s) only.`);
    }
    if (NO_PLAYHQ) {
      console.log('  ⚠ --no-playhq with --seasons contacts nothing, so no grade can be classified.');
      console.log('  Nothing was written. No flag, no deletion, no commit.');
      return;
    }
    await sweepSeasons(list);
    return;
  }

  const games = loadGames(SEASON);
  const { byGrade, lastPlayed } = buildByGrade(games);

  // A grade is interesting when it holds future fixtures for a team whose LAST
  // PLAYED game was in a DIFFERENT grade. That is the category-2 population.
  const interesting = [];
  for (const [gid, e] of byGrade) {
    const suspects = [...e.future].filter(tid => {
      const lp = lastPlayed.get(tid);
      return lp && lp.gid !== gid;
    });
    if (suspects.length) interesting.push({ gid, gn: e.gn, suspects, control: [...e.control], total: e.total });
  }
  interesting.sort((a, b) => b.suspects.length - a.suspects.length);

  console.log(`  grades in this season's game file : ${byGrade.size}`);
  console.log(`  grades holding future fixtures for a team last PLAYED elsewhere : ${interesting.length}`);
  if (!interesting.length) {
    console.log('\n  Nothing to probe: no grade holds a future fixture for a team whose last played');
    console.log('  game was in another grade. Category 2 does not arise in this season.');
    return;
  }

  let ctlPresent = 0, ctlTotal = 0, susPresent = 0, susTotal = 0, errs = 0;
  const nullGrades = [];   // grades DiscoverGrade answered NULL for — the --null-control subjects
  const probedGids = new Set();

  if (!NO_PLAYHQ) {
    console.log(`\n  Contacting PlayHQ for ${Math.min(interesting.length, MAXG)} grade ladder(s) —`
              + ` a stall here is the session bootstrap, which retries 10 times with backoff.`);
  }

  for (const e of interesting.slice(0, MAXG)) {
    console.log(`\n── grade ${e.gid}${e.gn ? ` "${e.gn}"` : ''}  (${e.total} game(s) on file)`);
    if (NO_PLAYHQ) {
      console.log(`   [--no-playhq] ladder NOT read. Local population only:`);
      console.log(`   CONTROL  teams whose last PLAYED game is in this grade : ${e.control.length}`);
      console.log(`   SUSPECT  teams with a FUTURE fixture here but last played elsewhere : ${e.suspects.length}`);
      for (const t of e.suspects.slice(0, 8)) {
        const lp = lastPlayed.get(t);
        console.log(`       ${t}  last played ${lp.d} in grade ${lp.gid}`);
      }
      if (e.suspects.length > 8) console.log(`       … and ${e.suspects.length - 8} more (printing capped at 8)`);
      susTotal += e.suspects.length; ctlTotal += e.control.length;
      continue;
    }
    const L = await ladderTeams(e.gid);
    probedGids.add(e.gid);
    if (L.err) {
      errs++;
      console.log(`   PlayHQ ladder → ERROR: ${L.err}`);
      // Recorded, not interpreted. The --null-control pass is what decides
      // whether NULL means anything at all.
      if (L.err.indexOf('discoverGrade is NULL') === 0) {
        nullGrades.push({ gid: e.gid, gn: e.gn, total: e.total, suspects: e.suspects.length });
      }
      continue;
    }
    console.log(`   PlayHQ ladder → name=${JSON.stringify(L.name)}  pools=${L.pools}  teams listed=${L.ids.size}`);
    if (!L.ids.size) {
      console.log('   ⚠ The ladder lists NO teams. Nothing can be concluded from absence here —');
      console.log('     this is the August finding (probe-grade-ladder.js), not a regrade signal.');
      continue;
    }

    // CONTROL FIRST. These teams played their most recent game in this grade.
    const cIn = e.control.filter(t => L.ids.has(t)).length;
    ctlPresent += cIn; ctlTotal += e.control.length;
    console.log(`   CONTROL  teams whose last PLAYED game is in this grade : ${e.control.length}`
              + `  listed on the ladder: ${cIn}`
              + `  ABSENT: ${e.control.length - cIn}`);

    // Then the suspects.
    const sIn = e.suspects.filter(t => L.ids.has(t)).length;
    susPresent += sIn; susTotal += e.suspects.length;
    console.log(`   SUSPECT  teams with a FUTURE fixture here but last played elsewhere : ${e.suspects.length}`
              + `  listed on the ladder: ${sIn}`
              + `  ABSENT: ${e.suspects.length - sIn}`);
    for (const t of e.suspects.slice(0, 8)) {
      const lp = lastPlayed.get(t);
      console.log(`       ${t}  ${L.ids.has(t) ? 'LISTED  ' : 'absent  '} last played ${lp.d} in grade ${lp.gid}`);
    }
    if (e.suspects.length > 8) console.log(`       … and ${e.suspects.length - 8} more (printing capped at 8)`);
  }

  console.log('\n' + '═'.repeat(78));
  if (NO_PLAYHQ) {
    console.log(`  [--no-playhq] NOTHING was asked of PlayHQ, so nothing is concluded.`);
    console.log(`  Population only: ${susTotal} suspect team-grade pair(s) across`
              + ` ${Math.min(interesting.length, MAXG)} grade(s), against ${ctlTotal} control team(s).`);
    console.log(`  That is the SIZE of category 2 in this season. Whether any of it is stale in`);
    console.log(`  PlayHQ's view needs the ladder, which is this script without --no-playhq.`);
    console.log('  Nothing was written. No flag, no deletion, no commit.');
    return;
  }
  console.log(`  CONTROL: ${ctlPresent} of ${ctlTotal} teams that belong are listed`
            + (ctlTotal ? `  (${Math.round((ctlPresent / ctlTotal) * 100)}%)` : ''));
  console.log(`  SUSPECT: ${susPresent} of ${susTotal} teams with stale future fixtures are listed`
            + (susTotal ? `  (${Math.round((susPresent / susTotal) * 100)}%)` : ''));
  if (errs) console.log(`  ⚠ ${errs} grade(s) could not be read — their absence counts for nothing.`);
  console.log('');
  console.log('  HOW TO READ THIS — and do not read it any other way:');
  console.log('   · CONTROL low  → the ladder is not a membership signal. Absence proves nothing and');
  console.log('                    category 2 cannot be built on it. Stop here.');
  console.log('   · CONTROL high AND SUSPECT low → PlayHQ drops a regraded team from the old grade');
  console.log('                    while still serving its fixtures. That absence is a measurement');
  console.log('                    and a rule may be built on it.');
  console.log('   · CONTROL high AND SUSPECT high → PlayHQ still lists these teams in that grade.');
  console.log('                    There is no signal; the fixtures are not stale in PlayHQ\'s view.');

  if (NULL_CONTROL > 0) {
    await nullControlPass(SEASON, byGrade, lastPlayed, interesting, nullGrades, probedGids);
  } else {
    console.log('  Nothing was written. No flag, no deletion, no commit.');
  }
})().catch(e => { console.error('FATAL:', e.message, '\n', e.stack); process.exit(1); });
