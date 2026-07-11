// scripts/diagnose-profile-identity-namespace.js
//
// READ-ONLY. No git writes at all -- console output only.
//
// WHAT THIS TESTS: comparing api.playhq.com's discoverGame query against
// spectator.playhq.com's game-statistics query for the same game (bv season
// 81545684, gameId a2e4b6c2), most players' identity uuid matches across
// both endpoints, but three real, named players' uuids do NOT match at all:
//
//   William Mallen  -- api.playhq.com profile.id = 50705b28-20b1-4fcd-bed4-fa01f90f3d87
//                       spectator.playhq.com profileID = 9c8403ae-23cd-4a79-a852-a495ad0ce7a9
//   Charlie Raynor  -- api.playhq.com profile.id = 69e32567-5a8d-425d-8fda-6f654d29ab7e
//                       spectator.playhq.com profileID = 408c3c6e-67c3-46fb-8d79-0a38ce6c3447
//   Jack Delaney    -- api.playhq.com profile.id = 1cf5a2ba-98c0-43d6-b1dd-9c3dbb2251c5
//                       spectator.playhq.com profileID = 0000ed35-3510-4267-bf4f-db65588b6d99
//
// Our own capture (nightly-crawl.js / backfill-missing-players.js's
// spectator fetch) only ever sees spectator.playhq.com's profileID, but the
// separate profile-stats backfill in both scripts queries api.playhq.com's
// publicProfileStatistics using that same spectator-namespace uuid. If that
// query only recognizes its own namespace, every player whose ids have
// diverged this way gets a false "private"/"not found" result -- unrelated
// to any actual privacy setting or CloudFront block.
//
// FIX (this version): the previous version tried to route through
// solitary-snowflake-cb3e.insanoflash.workers.dev, which is the wrong
// worker -- that one only proxies box scores/spectator data. The actual
// dedicated profile proxy is playhq-profile-proxy.insanoflake.workers.dev
// (source supplied by Mark), which is a pure passthrough: it requires an
// ALREADY-OBTAINED cookie in its request body (POST {cookie, graphql}) plus
// an X-Proxy-Secret header matching the PLAYHQ_PROXY_SECRET GitHub Actions
// secret, and forwards to api.playhq.com from Cloudflare's own egress IP.
// It does NOT do cookie acquisition itself -- that step still happens
// directly against api.playhq.com from this runner, same as every other
// script in this project. Only the actual publicProfileStatistics call
// (the one with the documented strict ~50-calls/window rate limit) is
// routed through Cloudflare's IP; cookie acquisition is unchanged.
//
// Session-acquisition code copied verbatim from backfill-missing-players.js
// (proven, not reinvented), including full CDN-header/body diagnostics on
// failure.

'use strict';

const https  = require('https');
const crypto = require('crypto');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function doFetch(url, options) {
  return new Promise(function (resolve, reject) {
    const parsed = new URL(url);
    const body = options.body || '';
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'POST',
      headers: Object.assign({}, options.headers, { 'content-length': Buffer.byteLength(body) }),
      agent: new https.Agent({ keepAlive: false }),
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          rawCookies: res.headers['set-cookie'],
          headers: res.headers,
          text: function () { return Promise.resolve(rawBody); },
          json: function () { try { return Promise.resolve(JSON.parse(rawBody)); } catch (e) { return Promise.reject(e); } },
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function logDiagnostics(label, res, fullBody) {
  const h = res.headers || {};
  console.log('  ----- ' + label + ': status=' + res.status + ' -----');
  console.log('    x-cache      : ' + (h['x-cache'] || '(absent)'));
  console.log('    via          : ' + (h['via'] || '(absent)'));
  console.log('    x-amz-cf-id  : ' + (h['x-amz-cf-id'] || '(absent)'));
  console.log('    x-amz-cf-pop : ' + (h['x-amz-cf-pop'] || '(absent)'));
  console.log('    server       : ' + (h['server'] || '(absent)'));
  console.log('    content-type : ' + (h['content-type'] || '(absent)'));
  console.log('  ----- ' + label + ': body (' + fullBody.length + ' chars) -----');
  console.log(fullBody);
  console.log('  ----- ' + label + ': end -----');
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
        res = await doFetch(API_URL, { headers: Object.assign({}, HEADERS_BASE, { 'request-id': crypto.randomUUID() }), body: JSON.stringify(q) });
      } catch (err) {
        console.log('  [session attempt ' + attempt + ', ' + q.operationName + '] request threw: ' + err.message);
        continue;
      }
      const raw = res.rawCookies;
      if (!raw) {
        let fullBody = '';
        try { fullBody = await res.text(); } catch (_) {}
        console.log('  [session attempt ' + attempt + ', ' + q.operationName + '] no set-cookie header. status=' + res.status);
        logDiagnostics('profile-session attempt ' + attempt + ' (' + q.operationName + ')', res, fullBody);
        if (res.status !== 200) {
          throw new Error('Session request failed with status ' + res.status + ' and no cookies -- see full body logged above.');
        }
        continue;
      }
      const parts = (Array.isArray(raw) ? raw : [raw]).map(function (c) { return c.split(';')[0].trim(); });
      const get = function (name) { return parts.find(function (c) { return c.startsWith(name + '='); }) || null; };
      const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
      if (!tier || !session || !sub) {
        console.log('  [session attempt ' + attempt + ', ' + q.operationName + '] set-cookie present but missing tier/session/sub.');
        continue;
      }
      profileCookie = tier + '; ' + session + '; ' + sub;
      console.log('  Profile session refreshed (attempt ' + attempt + ')');
      return;
    }
  }
  throw new Error('Failed to obtain profile session after 10 attempts');
}

const PROFILE_QUERY = {
  operationName: 'ProfileSeasonStatistics',
  query: 'query ProfileSeasonStatistics($profileID: ID!) {\n' +
    '  publicProfileStatistics(profileID: $profileID) {\n' +
    '    seasonStatistics {\n' +
    '      name\n' +
    '      statistics {\n' +
    '        season { id }\n' +
    '        teamStatistics {\n' +
    '          gradeStatistics {\n' +
    '            gameStatistics { game { id } }\n' +
    '          }\n' +
    '        }\n' +
    '      }\n' +
    '    }\n' +
    '  }\n' +
    '}',
};

const PROXY_HOST = 'playhq-profile-proxy.insanoflake.workers.dev';
const PROXY_SECRET = process.env.PLAYHQ_PROXY_SECRET;

async function queryProfileViaProxy(profileID) {
  if (!PROXY_SECRET) {
    return { verdict: 'missing-proxy-secret', detail: 'PLAYHQ_PROXY_SECRET env var not set' };
  }
  if (!profileCookie) await refreshProfileSession();

  const body = JSON.stringify({
    cookie: profileCookie,
    graphql: Object.assign({}, PROFILE_QUERY, { variables: { profileID: profileID } }),
  });

  let res;
  try {
    res = await doFetch('https://' + PROXY_HOST + '/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Proxy-Secret': PROXY_SECRET },
      body: body,
    });
  } catch (err) {
    return { verdict: 'proxy-request-error', detail: err.message };
  }

  if (res.status === 401) return { verdict: 'proxy-unauthorized', detail: 'X-Proxy-Secret did not match worker env' };
  if (res.status !== 200) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    return { verdict: 'proxy-http-' + res.status, detail: b.slice(0, 300) };
  }

  let json;
  try { json = await res.json(); } catch (err) { return { verdict: 'proxy-bad-json', detail: err.message }; }

  if (json.errors && json.errors.length) {
    return { verdict: 'upstream-graphql-error', detail: json.errors[0].message || JSON.stringify(json.errors) };
  }
  const stats = json.data && json.data.publicProfileStatistics;
  if (!stats) return { verdict: 'upstream-null-publicProfileStatistics' };
  const seasonList = stats.seasonStatistics || [];
  return { verdict: 'ok', seasonCount: seasonList.length, nameReturned: (seasonList[0] && seasonList[0].name) || null };
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
  console.log('Cookie acquisition: direct to api.playhq.com (unchanged, proven mechanism).');
  console.log('Profile query: routed through ' + PROXY_HOST + ' (Cloudflare egress IP).\n');

  for (const caseEntry of CASES) {
    const name = caseEntry[0], spectatorId = caseEntry[1], apiId = caseEntry[2];

    console.log('='.repeat(70));
    console.log('  ' + name);
    console.log('='.repeat(70));

    console.log('  [spectator-namespace] ' + spectatorId);
    const rSpec = await queryProfileViaProxy(spectatorId);
    console.log('    ' + JSON.stringify(rSpec));

    await sleep(1000);

    console.log('  [api-namespace]       ' + apiId);
    const rApi = await queryProfileViaProxy(apiId);
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

    await sleep(1000);
  }

  console.log('Done.');
}

main().catch(function (err) { console.error('FATAL:', err); process.exit(1); });
