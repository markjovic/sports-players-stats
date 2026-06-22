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

  // ── SearchResultMeta — find all fields ────────────────────────────────────
  console.log('━━━ SearchResultMeta fields ━━━\n');
  const metaFields = ['totalPages', 'totalRecords', 'page', 'currentPage',
                      'cursor', 'nextCursor', 'hasMore', 'count', 'total'];
  const workingMetaFields = [];
  for (const f of metaFields) {
    await new Promise(r => setTimeout(r, 300));
    const res = await doReq({
      operationName: 'T', variables: { id: GRADE_ID },
      query: `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { meta { ${f} } } }`,
    }, cookie);
    if (res.errors) {
      console.log(`  ❌ meta.${f.padEnd(15)} ${res.errors[0]?.message?.slice(0, 60)}`);
    } else {
      const val = res.data?.gradePlayerStatistics?.meta?.[f];
      console.log(`  ✅ meta.${f.padEnd(15)} = ${val}`);
      workingMetaFields.push(f);
    }
  }

  // ── Full error messages — no truncation ───────────────────────────────────
  console.log('\n━━━ Full error messages for pagination candidates ━━━\n');
  const candidates = [
    // the 'f...' suggestion from 'after'
    ['filter: {}',       `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, filter: {}) { meta { totalRecords } results { profile { id } } } }`],
    ['filters: {}',      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, filters: {}) { meta { totalRecords } results { profile { id } } } }`],
    // page as String
    ['page: "2"',        `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, page: "2") { meta { totalRecords } results { profile { id } } } }`],
    // try 'after' full error
    ['after: "50"',      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, after: "50") { meta { totalRecords } results { profile { id } } } }`],
    // try meta.page as the cursor to pass back in
    ['cursor from meta', `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { meta { ${workingMetaFields.join(' ')} } results { profile { id } } } }`],
  ];

  for (const [label, query] of candidates) {
    await new Promise(r => setTimeout(r, 350));
    const r = await doReq({ operationName: 'T', variables: { id: GRADE_ID }, query }, cookie);
    if (r.errors) {
      // Print FULL error message — no truncation
      console.log(`  ❌ ${label}`);
      r.errors.forEach(e => console.log(`     ${e.message}`));
    } else {
      const g = r.data?.gradePlayerStatistics;
      console.log(`  ✅ ${label}  results=${g?.results?.length}  meta=${JSON.stringify(g?.meta)}`);
    }
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
