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
const GAMES_DIR = path.join(ROOT, 'games', 'bv');

if (!SEASON) { console.error('--season=<sid> is required'); process.exit(2); }

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

(async () => {
  console.log('probe-stale-grade-membership [READ-ONLY] — no writes, no git, no deletions');
  console.log(`  season: ${SEASON}   today: ${TODAY}   grades examined: up to ${MAXG}`);
  console.log('─'.repeat(78));

  const games = loadGames(SEASON);

  // Per grade: teams holding a FUTURE unplayed fixture (the suspects), and teams
  // whose LAST PLAYED game is in this grade (the control).
  const byGrade = new Map();                 // gid -> { gn, future:Set, lastPlayedHere:Set }
  const lastPlayed = new Map();              // tid -> { d, t, key, gid }
  for (const id of Object.keys(games)) {
    const g = games[id];
    if (!g || !g.gid) continue;
    if (!byGrade.has(g.gid)) byGrade.set(g.gid, { gn: g.gn || null, future: new Set(), control: new Set(), total: 0 });
    const e = byGrade.get(g.gid);
    if (g.gn && !e.gn) e.gn = g.gn;
    e.total++;
    const played = isPlayedGame(g);
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
    if (L.err) { errs++; console.log(`   PlayHQ ladder → ERROR: ${L.err}`); continue; }
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
  console.log('  Nothing was written. No flag, no deletion, no commit.');
})().catch(e => { console.error('FATAL:', e.message, '\n', e.stack); process.exit(1); });
