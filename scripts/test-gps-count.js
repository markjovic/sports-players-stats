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

  // ── Baseline count ────────────────────────────────────────────────────────
  const res = await doReq({
    operationName: 'T', variables: { id: GRADE_ID },
    query: `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) {
      meta { totalPages totalRecords }
      results { profile { id firstName lastName } team { id name } }
    } }`,
  }, cookie);

  if (res.errors) { console.error('Error:', res.errors[0].message); process.exit(1); }
  const gps = res.data.gradePlayerStatistics;
  console.log(`meta.totalRecords : ${gps.meta.totalRecords}`);
  console.log(`meta.totalPages   : ${gps.meta.totalPages}`);
  console.log(`results.length    : ${gps.results.length}`);
  console.log(gps.results.length === gps.meta.totalRecords
    ? '✅ All results returned in one call'
    : `❌ Missing ${gps.meta.totalRecords - gps.results.length} — need pagination`);

  // ── Pagination argument search ────────────────────────────────────────────
  console.log('\n━━━ Pagination argument candidates ━━━\n');
  const candidates = [
    // int-based page number
    ['page: 2',           `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, page: 2) { meta { totalRecords } results { profile { id } } } }`],
    ['pageNo: 2',         `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, pageNo: 2) { meta { totalRecords } results { profile { id } } } }`],
    ['pageNum: 2',        `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, pageNum: 2) { meta { totalRecords } results { profile { id } } } }`],
    ['currentPage: 2',   `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, currentPage: 2) { meta { totalRecords } results { profile { id } } } }`],
    ['pg: 2',             `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, pg: 2) { meta { totalRecords } results { profile { id } } } }`],
    ['p: 2',              `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, p: 2) { meta { totalRecords } results { profile { id } } } }`],
    ['offset: 50',        `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, offset: 50) { meta { totalRecords } results { profile { id } } } }`],
    ['skip: 50',          `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, skip: 50) { meta { totalRecords } results { profile { id } } } }`],
    ['start: 50',         `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, start: 50) { meta { totalRecords } results { profile { id } } } }`],
    ['first: 50',         `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, first: 50) { meta { totalRecords } results { profile { id } } } }`],
    // string cursor
    ['cursor: "2"',       `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, cursor: "2") { meta { totalRecords } results { profile { id } } } }`],
    ['after: "2"',        `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, after: "2") { meta { totalRecords } results { profile { id } } } }`],
    // input object
    ['input: {page:2}',   `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, input: {page: 2}) { meta { totalRecords } results { profile { id } } } }`],
  ];

  for (const [label, query] of candidates) {
    await new Promise(r => setTimeout(r, 350));
    const r = await doReq({ operationName: 'T', variables: { id: GRADE_ID }, query }, cookie);
    if (r.errors) {
      const msg = r.errors[0]?.message?.slice(0, 80) || 'error';
      console.log(`  ❌ ${label.padEnd(20)} ${msg}`);
    } else {
      const g = r.data?.gradePlayerStatistics;
      console.log(`  ✅ ${label.padEnd(20)} results=${g?.results?.length}  total=${g?.meta?.totalRecords}`);
    }
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
