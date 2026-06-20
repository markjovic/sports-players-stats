// scripts/test-failed-uuids.js
// Run immediately after fetch-player-profiles to re-test failed UUIDs via proxy.
// Reads /tmp/failed-uuids.txt written by fetch-player-profiles.js

import crypto from 'crypto';
import fs from 'fs';

const PROXY_URL    = 'https://playhq-profile-proxy.insanoflash.workers.dev';
const PROXY_SECRET = process.env.PLAYHQ_PROXY_SECRET;
const HEADERS = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};
const API_URL = 'https://api.playhq.com/graphql';
const Q = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics { statistics { season { id } } }
  }
}`;

if (!fs.existsSync('/tmp/failed-uuids.txt')) {
  console.log('No failed UUIDs file found.'); process.exit(0);
}
const uuids = fs.readFileSync('/tmp/failed-uuids.txt', 'utf8').split('\n').filter(Boolean).slice(0, 30);
console.log(`\nImmediate re-test of ${uuids.length} failed UUIDs via same proxy\n`);

const authRes = await fetch(API_URL, {
  method: 'POST',
  headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
  body: JSON.stringify({ operationName: 'ProfileSearch', variables: { fullName: 'a' },
    query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' }),
});
const raw = authRes.headers.get('set-cookie');
const cookie = raw.split(',').map(c => c.trim().split(';')[0]).join('; ');
console.log(`Cookie: ${cookie.split(';').map(p => p.trim().split('=')[0]).join(', ')}\n`);

let present = 0, notFound = 0, f403 = 0, other = 0;
for (const uuid of uuids) {
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Proxy-Secret': PROXY_SECRET },
    body: JSON.stringify({ cookie, graphql: { operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: Q } }),
  });
  let result;
  if (res.status === 403) { result = '403'; f403++; }
  else {
    try {
      const j = await res.json();
      if (j.errors) { result = `NOT_FOUND`; notFound++; }
      else if (j?.data?.publicProfileStatistics) { result = `PRESENT(${j.data.publicProfileStatistics.seasonStatistics?.length}s)`; present++; }
      else { result = 'NULL'; other++; }
    } catch { result = 'PARSE_ERR'; other++; }
  }
  const icon = result.startsWith('PRESENT') ? '✓' : result === 'NOT_FOUND' ? '○' : '✗';
  console.log(`  ${icon} ${uuid} → ${result} HTTP ${res.status}`);
}

console.log(`\nRe-test results: PRESENT:${present} NOT_FOUND:${notFound} 403:${f403} OTHER:${other}`);
if (present > 0) console.log(`  ⚠ ${present} UUIDs that failed in fetch script returned PRESENT immediately — WAF window issue confirmed`);
if (f403 > 0)   console.log(`  ✓ ${f403} UUIDs still returning 403 — genuine private profiles`);
