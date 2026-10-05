// scripts/probe-grade-ladder.js
//
// READ-ONLY. No writes, no git, no lock. Prints RAW responses.
//
// WHY. discover-fixtures resolves a season's teams from discoverGrade.ladder. On
// 2026-08-19 it reported "Teams: 0 — no ladder data" for EDJBA Winter 2026
// (1ae60211) across all 55 grades, and 2 teams across 16 grades for Camberwell
// (aacc7335). But the ladder is visibly on PlayHQ:
//   .../edjba-winter-2026/boys-u13-ar/cce1a7da/ladder  — 13 rounds played.
//
// It logged `zero-team`, NOT `transient`, which its own code (L740) reserves for
// every-call-null. So the calls SUCCEEDED and returned no ladder. Two candidate
// faults, needing completely different fixes:
//
//   A. THE GRADE IDS ARE WRONG. sports-index holds grade ids for that season that
//      do not match PlayHQ's. Then discoverGrade answers about nothing and the
//      fault is in discover-seasons, not here.
//   B. THE LADDER FIELD IS WRONG OR EMPTY. The ids are right and
//      discoverGrade.ladder genuinely returns empty for these seasons — a query
//      or schema problem.
//
// This distinguishes them: it queries a KNOWN-GOOD grade id (cce1a7da, whose
// ladder is on the site right now), queries the grade ids sports-index holds for
// the season, asks discoverSeason for its grade list, and prints the raw JSON of
// each. No inference — the responses are printed and the comparison is stated.
//
// Usage:
//   node scripts/probe-grade-ladder.js --season=1ae60211 --grade=cce1a7da
//
// NO setup-node in the workflow (fetches api.playhq.com — absolute rule).

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (f, d) => { const a = args.find(x => x.startsWith('--' + f + '=')); return a ? a.split('=')[1] : d; };
const SEASON = arg('season', '1ae60211');
const GRADE  = arg('grade', '');
const MAXG   = Number(arg('grades', '3')) || 3;

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

function summarise(label, r) {
  if (r.err) { console.log('  ' + label + ' → ERROR: ' + r.err); return null; }
  const g = r.data && r.data.discoverGrade;
  if (!g) { console.log('  ' + label + ' → discoverGrade is NULL (the id is not a grade PlayHQ knows)'); return 0; }
  const pools = Array.isArray(g.ladder) ? g.ladder : [];
  let teams = 0;
  for (const p of pools) teams += ((p && p.standings) || []).length;
  console.log('  ' + label + ' → name=' + JSON.stringify(g.name) + '  ladder pools=' + pools.length + '  teams=' + teams);
  console.log('      RAW: ' + JSON.stringify(g).slice(0, 500));
  return teams;
}

async function main() {
  console.log('probe-grade-ladder [READ-ONLY] — season=' + SEASON + (GRADE ? ' known-good grade=' + GRADE : ''));

  let idx = {};
  try { idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sports-index.json'), 'utf8')).seasons || {}; } catch (e) {}
  const s = idx[SEASON];
  const idxGrades = (s && Array.isArray(s.grades)) ? s.grades : [];
  console.log('  sports-index: ' + (s ? JSON.stringify(s.fullName || s.name) : 'SEASON NOT IN INDEX') +
              '  · grades held: ' + idxGrades.length + (s && s.locked ? ' [locked]' : ''));

  // 1. The known-good grade, straight from a live ladder page.
  if (GRADE) {
    console.log('\n1. KNOWN-GOOD GRADE (its ladder is on playhq.com right now):');
    const teams = summarise(GRADE, await gql('DiscoverGrade', Q_GRADE_TEAMS, { id: GRADE }));
    await sleep(800);
    if (teams === 0) {
      console.log('      ⇒ The query returns NO ladder for a grade that visibly HAS one.');
      console.log('        Fault B: the ladder field/shape is wrong for these seasons, not the ids.');
    } else if (teams > 0) {
      console.log('      ⇒ The query WORKS on a correct grade id. So discover-fixtures was asking');
      console.log('        about grade ids that are not real. Fault A: sports-index grades are wrong.');
    }
    console.log('      Is it in our sports-index grade list for this season? ' +
                (idxGrades.some(g => g && String(g.id).slice(0, 8) === String(GRADE).slice(0, 8)) ? 'YES' : 'NO ← the id we never had'));
  }

  // 2. What discoverSeason says the grades are, vs what we hold.
  console.log('\n2. GRADE IDS — sports-index vs discoverSeason:');
  const sr = await gql('DiscoverSeason', Q_SEASON, { id: SEASON });
  await sleep(800);
  if (sr.err) console.log('  discoverSeason → ERROR: ' + sr.err);
  else {
    const live = ((sr.data.discoverSeason && sr.data.discoverSeason.grades) || []);
    console.log('  discoverSeason returns ' + live.length + ' grades; sports-index holds ' + idxGrades.length);
    const ours = new Set(idxGrades.map(g => String(g && g.id).slice(0, 8)));
    const theirs = new Set(live.map(g => String(g && g.id).slice(0, 8)));
    const missing = [...theirs].filter(x => !ours.has(x));
    const extra = [...ours].filter(x => !theirs.has(x));
    console.log('  grades PlayHQ has that we LACK : ' + missing.length + (missing.length ? '  e.g. ' + missing.slice(0, 6).join(' ') : ''));
    console.log('  grades we hold that PlayHQ does not: ' + extra.length + (extra.length ? '  e.g. ' + extra.slice(0, 6).join(' ') : ''));
    if (live.length) console.log('  first few live grades: ' + live.slice(0, 5).map(g => g.id + ' ' + JSON.stringify(g.name)).join(' · '));
  }

  // 3. The grades discover-fixtures actually queried.
  console.log('\n3. THE GRADES discover-fixtures QUERIED (first ' + MAXG + ' from sports-index):');
  for (const g of idxGrades.slice(0, MAXG)) {
    await sleep(800);
    summarise(String(g.id) + ' ' + JSON.stringify(g.name), await gql('DiscoverGrade', Q_GRADE_TEAMS, { id: g.id }));
  }
  console.log('\n  Read section 1 first: it decides whether the QUERY is broken or the IDS are.');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
