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
// FIX (this version): the first two runs of this script called
// api.playhq.com directly from the GitHub Actions runner and hit a genuine
// CloudFront WAF block (confirmed via full CDN headers -- x-amz-cf-id,
// x-amz-cf-pop, via: cloudfront.net -- not just body text) before a single
// test query could run. Rather than keep fighting GitHub Actions' IP
// reputation, this version routes through the project's existing Cloudflare
// Worker (solitary-snowflake-cb3e.insanoflash.workers.dev), which already
// gets its PlayHQ session from Cloudflare's own network and is already
// tenant-aware. All cookie/session logic is gone from this script entirely
// -- it just calls the Worker's GET /profile/{profileID}?tenant=bv route
// (added alongside this script) and prints the raw upstream status/body for
// each of the 6 known ids. No CloudFront-vs-GitHub-Actions IP question left
// to fight on this script's side at all.

'use strict';

const https = require('https');

const WORKER_HOST = 'solitary-snowflake-cb3e.insanoflash.workers.dev';

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: WORKER_HOST,
      path,
      method: 'GET',
      headers: { 'accept': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, raw, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function queryProfile(profileID) {
  const path = '/profile/' + encodeURIComponent(profileID) + '?tenant=bv';
  let res;
  try {
    res = await get(path);
  } catch (err) {
    return { verdict: 'worker-request-error', detail: err.message };
  }
  if (res.status !== 200) {
    return { verdict: 'worker-http-' + res.status, detail: (res.raw || '').slice(0, 300) };
  }
  if (!res.json) {
    return { verdict: 'worker-bad-json', detail: (res.raw || '').slice(0, 300) };
  }
  if (res.json.error) {
    return { verdict: 'worker-error', detail: res.json.error };
  }
  const upstreamStatus = res.json.upstreamStatus;
  let upstreamJson = null;
  try { upstreamJson = JSON.parse(res.json.upstreamBody); } catch (_) {}
  if (upstreamStatus !== 200) {
    return { verdict: 'upstream-http-' + upstreamStatus, detail: (res.json.upstreamBody || '').slice(0, 300) };
  }
  if (upstreamJson && upstreamJson.errors && upstreamJson.errors.length) {
    return { verdict: 'upstream-graphql-error', detail: upstreamJson.errors[0].message || JSON.stringify(upstreamJson.errors) };
  }
  const stats = upstreamJson && upstreamJson.data && upstreamJson.data.publicProfileStatistics;
  if (!stats) return { verdict: 'upstream-null-publicProfileStatistics' };
  const seasonList = stats.seasonStatistics || [];
  const seasonCount = seasonList.length;
  const nameReturned = (seasonList[0] && seasonList[0].name) || null;
  return { verdict: 'ok', seasonCount: seasonCount, nameReturned: nameReturned };
}

// [label, spectatorNamespaceId, apiNamespaceId] -- both ids for the same
// confirmed real person, from the same single game (sid 81545684, gameId a2e4b6c2).
const CASES = [
  ['William Mallen', '9c8403ae-23cd-4a79-a852-a495ad0ce7a9', '50705b28-20b1-4fcd-bed4-fa01f90f3d87'],
  ['Charlie Raynor', '408c3c6e-67c3-46fb-8d79-0a38ce6c3447', '69e32567-5a8d-425d-8fda-6f654d29ab7e'],
  ['Jack Delaney',   '0000ed35-3510-4267-bf4f-db65588b6d99', '1cf5a2ba-98c0-43d6-b1dd-9c3dbb2251c5'],
];

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function main() {
  console.log('diagnose-profile-identity-namespace.js -- read-only, no writes');
  console.log('Routing all PlayHQ calls through ' + WORKER_HOST + ' -- no direct calls');
  console.log('from this runner to api.playhq.com at all.\n');

  for (const caseEntry of CASES) {
    const name = caseEntry[0];
    const spectatorId = caseEntry[1];
    const apiId = caseEntry[2];

    console.log('='.repeat(70));
    console.log('  ' + name);
    console.log('='.repeat(70));

    console.log('  [spectator-namespace] ' + spectatorId);
    const rSpec = await queryProfile(spectatorId);
    console.log('    ' + JSON.stringify(rSpec));

    await sleep(500);

    console.log('  [api-namespace]       ' + apiId);
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

    await sleep(500);
  }

  console.log('Done.');
}

main().catch(function (err) { console.error('FATAL:', err); process.exit(1); });
