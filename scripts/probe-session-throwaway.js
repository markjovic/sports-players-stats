// scripts/probe-session-throwaway.js
//
// TEMPORARY. Delete this file and its step in nightly-crawl.yml once the
// test below has given an answer -- this is not a permanent part of the
// pipeline.
//
// WHAT THIS TESTS: diagnose-profile-identity-namespace.js's TenantConfig
// session-acquisition call has hit an identical CloudFront block (PHX52-P1,
// generic "Request blocked" body) on every attempt this session, using
// headers/query that are byte-identical to nightly-crawl.js's own
// refreshSession(). nightly-crawl.js acquires this same session
// successfully in production routinely. So: does this exact same call
// (copied verbatim from nightly-crawl.js's HEADERS_MAIN + TenantConfig
// query) succeed or fail on THIS runner, moments before nightly-crawl.js
// makes the identical call itself?
//
//   - This succeeds, nightly-crawl.js's own call also succeeds  -> the block
//     seen in the standalone diagnostic script was bad luck on that
//     specific IP/POP draw, not a structural GitHub-Actions-IP block.
//   - This fails, nightly-crawl.js's own call also fails        -> real
//     evidence of a live, current, structural problem (this is a much
//     bigger deal than a throwaway diagnostic -- would mean the actual
//     nightly crawl is at risk too, not just this side test).
//   - This fails, nightly-crawl.js's own call succeeds moments later
//     (same runner) -> something in the diagnostic script specifically
//     differs, even though no difference has been found so far.
//
// Read-only. No writes, no git, no retries -- single attempt, full CDN
// diagnostics on failure, then exits 0 regardless so it never fails the job.

'use strict';

const https  = require('https');
const crypto = require('crypto');

const API_URL = 'https://api.playhq.com/graphql';

// Copied verbatim from nightly-crawl.js HEADERS_MAIN (lines 109-113) --
// do not edit independently of that file.
const HEADERS_MAIN = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

// Copied verbatim from nightly-crawl.js refreshSession() (lines 122-124).
const BODY = {
  operationName: 'TenantConfig', variables: {},
  query: 'query TenantConfig { tenantConfiguration { label } }',
};

function doFetch(url, bodyObj, headers) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify(bodyObj);
    const parsed = new URL(url);
    const h = { ...headers, 'request-id': crypto.randomUUID(),
                'content-length': Buffer.byteLength(body) };
    const req = https.request(
      { hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
        headers: h, agent: new https.Agent({ keepAlive: false }) },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, rawCookies: res.headers['set-cookie'],
                     headers: res.headers, rawText });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('probe-session-throwaway.js -- single attempt, TenantConfig, HEADERS_MAIN (verbatim from nightly-crawl.js)\n');
  let res;
  try {
    res = await doFetch(API_URL, BODY, HEADERS_MAIN);
  } catch (err) {
    console.log('PROBE RESULT: request threw -- ' + err.message);
    return;
  }
  if (!res.rawCookies) {
    console.log('PROBE RESULT: FAILED -- no set-cookie header. status=' + res.status);
    const h = res.headers || {};
    console.log('  x-cache      : ' + (h['x-cache'] || '(absent)'));
    console.log('  via          : ' + (h['via'] || '(absent)'));
    console.log('  x-amz-cf-id  : ' + (h['x-amz-cf-id'] || '(absent)'));
    console.log('  x-amz-cf-pop : ' + (h['x-amz-cf-pop'] || '(absent)'));
    console.log('  server       : ' + (h['server'] || '(absent)'));
    console.log('  body (' + res.rawText.length + ' chars):');
    console.log(res.rawText);
    return;
  }
  console.log('PROBE RESULT: SUCCESS -- got set-cookie on the first attempt.');
}

main().catch(err => console.error('Unexpected error (should not happen):', err));
