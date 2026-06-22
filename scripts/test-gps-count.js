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

  console.log('━━━ filter object sub-fields for pagination ━━━\n');

  const filterCandidates = [
    'page: 2',
    'pageNumber: 2',
    'pageNum: 2',
    'pageNo: 2',
    'pg: 2',
    'p: 2',
    'currentPage: 2',
    'offset: 50',
    'skip: 50',
    'cursor: "2"',
    'after: "50"',
    'first: 50',
    'limit: 50, page: 2',
    'limit: 50, offset: 50',
  ];

  for (const f of filterCandidates) {
    await new Promise(r => setTimeout(r, 350));
    const query = `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, filter: { ${f} }) {
      meta { totalPages totalRecords page }
      results { profile { id } }
    } }`;
    const res = await doReq({ operationName: 'T', variables: { id: GRADE_ID }, query }, cookie);
    if (res.errors) {
      console.log(`  ❌ filter { ${f.padEnd(25)} } ${res.errors[0]?.message}`);
    } else {
      const g = res.data?.gradePlayerStatistics;
      const meta = g?.meta;
      const count = g?.results?.length;
      const marker = count === 18 ? ' ✅ PAGE 2!' : count === 68 ? ' ✅ ALL!' : '';
      console.log(`  ✅ filter { ${f.padEnd(25)} } results=${count} page=${meta?.page} total=${meta?.totalRecords}${marker}`);
    }
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
