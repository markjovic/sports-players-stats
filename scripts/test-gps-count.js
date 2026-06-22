// scripts/test-gps-count.js
'use strict';
const https  = require('https');
const crypto = require('crypto');

const GRADE_ID = process.argv[2];
if (!GRADE_ID) { console.error('Usage: node scripts/test-gps-count.js <gradeId>'); process.exit(1); }

const HEADERS = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

function doReq(body, cookie) {
  return new Promise((resolve, reject) => {
    const s = JSON.stringify(body);
    const h = { ...HEADERS, 'request-id': crypto.randomUUID(), 'content-length': Buffer.byteLength(s) };
    if (cookie) h['Cookie'] = cookie;
    const r = https.request(
      { hostname: 'api.playhq.com', path: '/graphql', method: 'POST', headers: h, agent: new https.Agent({ keepAlive: false }) },
      res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString()))); }
    );
    r.on('error', reject); r.write(s); r.end();
  });
}

async function getSession() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ operationName: 'T', variables: {}, query: 'query T { tenantConfiguration { label } }' });
    const r = https.request(
      { hostname: 'api.playhq.com', path: '/graphql', method: 'POST', headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'content-length': Buffer.byteLength(body) }, agent: new https.Agent({ keepAlive: false }) },
      res => {
        const raw = res.headers['set-cookie'];
        if (!raw) { reject(new Error('no cookie')); return; }
        const parts = (Array.isArray(raw) ? raw.join(', ') : raw).split(',').map(c => c.trim().split(';')[0]);
        const get = n => parts.find(p => p.startsWith(n + '=')) || null;
        resolve([get('phq_tier'), get('phq_session'), get('phq_sub')].filter(Boolean).join('; '));
        res.resume();
      }
    );
    r.on('error', reject); r.write(body); r.end();
  });
}

async function main() {
  const cookie = await getSession();

  const res = await doReq({
    operationName: 'T', variables: { id: GRADE_ID },
    query: `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) {
      meta { totalPages totalRecords page }
      results {
        profile { id firstName lastName }
        team { id name }
        statistics { count details { value } }
      }
    } }`,
  }, cookie);

  if (res.errors) { console.error('Error:', res.errors[0].message); process.exit(1); }

  const gps = res.data.gradePlayerStatistics;
  console.log(`totalRecords: ${gps.meta.totalRecords}  totalPages: ${gps.meta.totalPages}  page: ${gps.meta.page}`);
  console.log(`returned: ${gps.results.length}\n`);

  // Print all results — full, no truncation
  gps.results.forEach((r, i) => {
    const pts  = r.statistics?.find(s => s.details?.value === 'TOTAL_SCORE')?.count ?? 0;
    const gp   = r.statistics?.find(s => s.details?.value === 'APPEARANCE')?.count ?? 0;
    const fo   = r.statistics?.find(s => s.details?.value === 'TOTAL_FOULS')?.count ?? 0;
    const tp   = r.statistics?.find(s => s.details?.value === '3_POINT_SCORE')?.count ?? 0;
    console.log(`  ${String(i+1).padStart(2)}. ${r.profile.id}  ${(r.profile.firstName + ' ' + r.profile.lastName).padEnd(25)}  team: ${(r.team?.name || '').padEnd(30)}  gp:${gp}  pts:${pts}  3pt:${tp}  fouls:${fo}`);
  });
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
