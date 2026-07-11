// scripts/diagnose-profile-identity-namespace.js
//
// READ-ONLY. No git writes at all -- console output only.
//
// WHAT THIS TESTS: on 2026-07-11, comparing api.playhq.com's discoverGame
// query against spectator.playhq.com's game-statistics query for the SAME
// game (bv season 81545684, gameId a2e4b6c2), Mark found that most players'
// identity uuid matches across both endpoints, but three real, named
// players' uuids do NOT match at all between the two endpoints:
//
//   William Mallen  -- api.playhq.com profile.id = 50705b28-20b1-4fcd-bed4-fa01f90f3d87
//                       spectator.playhq.com profileID = 9c8403ae-23cd-4a79-a852-a495ad0ce7a9
//   Charlie Raynor  -- api.playhq.com profile.id = 69e32567-5a8d-425d-8fda-6f654d29ab7e
//                       spectator.playhq.com profileID = 408c3c6e-67c3-46fb-8d79-0a38ce6c3447
//   Jack Delaney    -- api.playhq.com profile.id = 1cf5a2ba-98c0-43d6-b1dd-9c3dbb2251c5
//                       spectator.playhq.com profileID = 0000ed35-3510-4267-bf4f-db65588b6d99
//
// Mark's hypothesis: these three were originally fill-in players (PlayHQ
// mints a synthetic profile for a fill-in at the time), and were later made
// full team members -- with an admin able to retroactively attribute the
// historical stat line to the now-real profile. If that reattribution only
// propagates through ONE of PlayHQ's two backends, the same person ends up
// with two live, disagreeing uuids depending which endpoint answers.
//
// WHY THIS MATTERS TO US SPECIFICALLY: nightly-crawl.js and
// backfill-missing-players.js's spectator capture ONLY ever sees
// spectator.playhq.com's profileID (confirmed by reading both scripts this
// session -- their GraphQL query literally never requests anything else).
// But fetch-profile-stats.js and backfill-missing-players.js's OWN profile
// backfill logic call publicProfileStatistics(profileID: ...) against
// api.playhq.com -- a DIFFERENT backend -- passing in that same
// spectator-namespace uuid as the argument.
//
// If api.playhq.com's publicProfileStatistics only recognizes its own
// namespace's ids, every player whose two ids have diverged this way would
// get a false "private"/"not found" result from that query -- for a reason
// that has nothing to do with privacy settings or CloudFront blocking, which
// is what every prior failure this week was attributed to. This script tests
// that directly and only that -- it changes nothing.
//
// FIX (this version): the first run of this script (2026-07-11) failed at
// session acquisition with a bare "status=403, no set-cookie" and nothing
// else -- because the diagnostic logging that backfill-missing-players.js
// has (full CDN headers + full response body on failure) was stripped out
// when this script was copied over. That was a mistake: it meant a session
// failure here produced strictly less information than the same failure
// would have produced in backfill-missing-players.js, for no good reason.
// logDiagnostics() is restored below, verbatim, so a repeat failure is
// actually diagnosable instead of just "try again and hope".

'use strict';

const https   = require('https');
const crypto  = require('crypto');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function doFetch(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body   = options.body || '';
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'POST',
      headers:  { ...options.headers, 'content-length': Buffer.byteLength(body) },
      agent:    new https.Agent({ keepAlive: false }),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          rawCookies: res.headers['set-cookie'],
          headers: res.headers,
          text: () => Promise.resolve(rawBody),
          json: () => { try { return Promise.resolve(JSON.parse(rawBody)); } catch (e) { return Promise.reject(e); } },
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Copied verbatim from backfill-missing-players.js -- prints CDN/WAF-
// identifying headers plus the full response body, so a failure here is
// actually diagnosable rather than just "no cookie, try again".
function logDiagnostics(label, res, fullBody) {
  const h = res.headers || {};
  console.log(`  ----- ${label}: status=${res.status} -----`);
  console.log(`    x-cache      : ${h['x-cache'] || '(absent)'}`);
  console.log(`    via          : ${h['via'] || '(absent)'}`);
  console.log(`    x-amz-cf-id  : ${h['x-amz-cf-id'] || '(absent)'}`);
  console.log(`    x-amz-cf-pop : ${h['x-amz-cf-pop'] || '(absent)'}`);
  console.log(`    server       : ${h['server'] || '(absent)'}`);
  console.log(`    content-type : ${h['content-type'] || '(absent)'}`);
  console.log(`    date (hdr)   : ${h['date'] || '(absent)'}`);
  console.log(`  ----- ${label}: body (${fullBody.length} chars) -----`);
  console.log(fullBody);
  console.log(`  ----- ${label}: end -----`);
}

const API_URL = 'https://api.playhq.com/graphql';
const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

let profileCookie = null;

async function refreshProfileSession() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 5000);
    for (const q of COOKIE_QUERIES) {
      let res;
      try {
        res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() }, body: JSON.stringify(q) });
      } catch (err) {
        console.log(`  [session attempt ${attempt}, ${q.operationName}] request threw: ${err.message}`);
        continue;
      }
      const raw = res.rawCookies;
      if (!raw) {
        let fullBody = '';
        try { fullBody = await res.text(); } catch (_) {}
        console.log(`  [session attempt ${attempt}, ${q.operationName}] no set-cookie header. status=${res.status}`);
        logDiagnostics(`profile-session attempt ${attempt} (${q.operationName})`, res, fullBody);
        if (res.status !== 200) {
          throw new Error(`Session request failed with status ${res.status} and no cookies -- see full body logged above.`);
        }
        continue;
      }
      const parts = (Array.isArray(raw) ? raw : [raw]).map(c => c.split(';')[0].trim());
      const get = (name) => parts.find(c => c.startsWith(name + '=')) || null;
      const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
      if (!tier || !session || !sub) {
        console.log(`  [session attempt ${attempt}, ${q.operationName}] set-cookie present but missing tier/session/sub.`);
        continue;
      }
      profileCookie = `${tier}; ${session}; ${sub}`;
      console.log(`  Profile session refreshed (attempt ${attempt})`);
      return;
    }
  }
  throw new Error('Failed to obtain profile session after 10 attempts');
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
              game { id }
              statistics { count details { value } }
            }
          }
        }
      }
    }
  }
}`,
};

async function queryProfile(profileID) {
  if (!profileCookie) await refreshProfileSession();
  const body = { ...PROFILE_QUERY, variables: { profileID } };
  let res;
  try {
    res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': profileCookie }, body: JSON.stringify(body) });
  } catch (err) {
    return { verdict: 'network-error', detail: err.message };
  }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    logDiagnostics(`query 403 (profileID=${profileID})`, res, b);
    return { verdict: 'http-403', detail: b.slice(0, 300) };
  }
  if (!res.ok) return { verdict: `http-${res.status}` };
  let json;
  try { json = await res.json(); } catch (err) { return { verdict: 'bad-json', detail: err.message }; }
  if (json.errors && json.errors.length > 0) {
    return { verdict: 'graphql-error', detail: json.errors[0]?.message || JSON.stringify(json.errors) };
  }
  const stats = json.data?.publicProfileStatistics;
  if (!stats) return { verdict: 'null-publicProfileStatistics' };
  const seasonCount = (stats.seasonStatistics || []).length;
  const firstName = stats.seasonStatistics?.[0]?.name || null;
  return { verdict: 'ok', seasonCount, nameReturned: firstName };
}

// [label, spectatorNamespaceId, apiNamespaceId] -- both ids for the same
// confirmed real person, from the same single game (sid 81545684, gameId a2e4b6c2).
const CASES = [
  ['William Mallen', '9c8403ae-23cd-4a79-a852-a495ad0ce7a9', '50705b28-20b1-4fcd-bed4-fa01f90f3d87'],
  ['Charlie Raynor', '408c3c6e-67c3-46fb-8d79-0a38ce6c3447', '69e32567-5a8d-425d-8fda-6f654d29ab7e'],
  ['Jack Delaney',   '0000ed35-3510-4267-bf4f-db65588b6d99', '1cf5a2ba-98c0-43d6-b1dd-9c3dbb2251c5'],
];

async function main() {
  console.log('diagnose-profile-identity-namespace.js -- read-only, no writes');
  console.log('Testing publicProfileStatistics(profileID) against api.playhq.com');
  console.log('for both the spectator-namespace and api-namespace uuid of 3 known cases.\n');

  // Acquire the session once, up front, so a failure here is unambiguous
  // and fully diagnosed before any per-case testing starts.
  await refreshProfileSession();

  for (const [name, spectatorId, apiId] of CASES) {
    console.log('='.repeat(70));
    console.log(`  ${name}`);
    console.log('='.repeat(70));

    console.log(`  [spectator-namespace] ${spectatorId}`);
    const rSpec = await queryProfile(spectatorId);
    console.log('    ' + JSON.stringify(rSpec));

    await sleep(1500);

    console.log(`  [api-namespace]       ${apiId}`);
    const rApi = await queryProfile(apiId);
    console.log('    ' + JSON.stringify(rApi));

    console.log();
    if (rSpec.verdict !== 'ok' && rApi.verdict === 'ok') {
      console.log('  >>> CONFIRMED: spectator-namespace id fails, api-namespace id succeeds.');
      console.log('  >>> This is the identity-namespace-mismatch theory, directly demonstrated.\n');
    } else if (rSpec.verdict === 'ok' && rApi.verdict === 'ok') {
      console.log('  >>> Both ids resolve. No mismatch in THIS specific query, for this player.\n');
    } else if (rSpec.verdict !== 'ok' && rApi.verdict !== 'ok') {
      console.log('  >>> Neither id resolves. Inconclusive for this player -- something else is failing too.\n');
    } else {
      console.log('  >>> Unexpected: spectator-namespace succeeded but api-namespace did not.\n');
    }

    await sleep(1500);
  }

  console.log('Done.');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
