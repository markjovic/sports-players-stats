// quick test — count gradePlayerStatistics results vs meta.totalRecords
'use strict';
const https  = require('https');
const crypto = require('crypto');

const GRADE_ID = process.argv[2];
if (!GRADE_ID) { console.error('Usage: node test-gps-count.js <gradeId>'); process.exit(1); }

const HEADERS = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

function req(body, cookie) {
  return new Promise((resolve, reject) => {
    const s = JSON.stringify(body);
    const h = { ...HEADERS, 'request-id': crypto.randomUUID(), 'content-length': Buffer.byteLength(s) };
    if (cookie) h['Cookie'] = cookie;
    const r = https.request({ hostname: 'api.playhq.com', path: '/graphql', method: 'POST', headers: h, agent: new https.Agent({ keepAlive: false }) },
      res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString()))); });
    r.on('error', reject); r.write(s); r.end();
  });
}

async function main() {
  // get session
  const s = await req({ operationName: 'T', variables: {}, query: 'query T { tenantConfiguration { label } }' });
  // no cookie needed for this — session from set-cookie
  // actually need to get cookie separately
  const cookie = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ operationName: 'T', variables: {}, query: 'query T { tenantConfiguration { label } }' });
    const r = https.request({ hostname: 'api.playhq.com', path: '/graphql', method: 'POST', headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'content-length': Buffer.byteLength(body) }, agent: new https.Agent({ keepAlive: false }) },
      res => {
        const raw = res.headers['set-cookie'];
        if (!raw) { reject(new Error('no cookie')); return; }
        const parts = (Array.isArray(raw) ? raw.join(', ') : raw).split(',').map(c => c.trim().split(';')[0]);
        const get = n => parts.find(p => p.startsWith(n + '=')) || null;
        resolve([get('phq_tier'), get('phq_session'), get('phq_sub')].filter(Boolean).join('; '));
        res.resume();
      });
    r.on('error', reject); r.write(body); r.end();
  });

  const res = await req({
    operationName: 'T',
    variables: { id: GRADE_ID },
    query: `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) {
      meta { totalPages totalRecords }
      results { profile { id firstName lastName } team { id name } statistics { count details { value } } }
    } }`,
  }, cookie);

  if (res.errors) { console.error('Error:', res.errors[0].message); process.exit(1); }
  const gps = res.data.gradePlayerStatistics;
  console.log(`meta.totalRecords : ${gps.meta.totalRecords}`);
  console.log(`meta.totalPages   : ${gps.meta.totalPages}`);
  console.log(`results.length    : ${gps.results.length}`);
  console.log(`\nAll results returned? ${gps.results.length === gps.meta.totalRecords ? '✅ YES' : '❌ NO — missing ' + (gps.meta.totalRecords - gps.results.length)}`);
  if (gps.results.length > 0) {
    console.log('\nFirst 3 players:');
    gps.results.slice(0, 3).forEach(r => console.log(`  ${r.profile.id}  ${r.profile.firstName} ${r.profile.lastName}  team: ${r.team?.name}`));
  }
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
