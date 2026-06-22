// scripts/test-schema-fields.js
'use strict';

const https  = require('https');
const crypto = require('crypto');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const GRADE_ID  = args.gradeId  || args.gradeid  || args.grade;
const SEASON_ID = args.seasonId || args.seasonid || args.season;

const HEADERS_BASE = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

function doFetch(body, cookie) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const headers = { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'content-length': Buffer.byteLength(bodyStr) };
    if (cookie) headers['Cookie'] = cookie;
    const req = https.request(
      { hostname: 'api.playhq.com', path: '/graphql', method: 'POST', headers, agent: new https.Agent({ keepAlive: false }) },
      (res) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject); req.write(bodyStr); req.end();
  });
}

async function getSession() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' });
    const req = https.request(
      { hostname: 'api.playhq.com', path: '/graphql', method: 'POST', headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'content-length': Buffer.byteLength(body) }, agent: new https.Agent({ keepAlive: false }) },
      (res) => {
        const raw = res.headers['set-cookie'];
        if (!raw) { reject(new Error('No cookie')); return; }
        const parts = (Array.isArray(raw) ? raw.join(', ') : raw).split(',').map(c => c.trim().split(';')[0]);
        const get = n => parts.find(p => p.startsWith(n + '=')) || null;
        resolve([get('phq_tier'), get('phq_session'), get('phq_sub')].filter(Boolean).join('; '));
        res.resume();
      }
    );
    req.on('error', reject); req.write(body); req.end();
  });
}

async function probe(label, query, variables, cookie) {
  await new Promise(r => setTimeout(r, 400));
  try {
    const res = await doFetch({ operationName: 'T', variables, query }, cookie);
    if (res.errors) {
      const msg = res.errors[0]?.message || '';
      console.log(`  ❌ ${label.padEnd(70)} ${msg.slice(0, 100)}`);
      return { ok: false, msg };
    }
    const preview = JSON.stringify(res.data)?.slice(0, 300);
    console.log(`  ✅ ${label.padEnd(70)} ${preview}`);
    return { ok: true, data: res.data };
  } catch (e) {
    console.log(`  ❌ ${label.padEnd(70)} ${e.message?.slice(0, 80)}`);
    return { ok: false };
  }
}

async function main() {
  console.log('test-schema-fields.js — round 6\n');
  let cookie = null;
  try { cookie = await getSession(); console.log('Session obtained\n'); }
  catch (e) { console.log('No session\n'); }

  // ── 1. gradePlayerStatistics.results fields (GradePlayerStatisticsResult) ─
  if (GRADE_ID) {
    console.log(`━━━ GradePlayerStatisticsResult fields  (gradeId: ${GRADE_ID}) ━━━\n`);

    // Confirmed: results array exists. Probe each field on GradePlayerStatisticsResult
    const resultFields = [
      'profile { id firstName lastName }',
      'team { id name }',
      'totalStatistics { count details { value } }',
      'statistics { count details { value } }',
      'id',
      'rank',
      'position',
      'points',
      'gamesPlayed',
      'firstName lastName',
      'name',
      '__typename',
    ];
    for (const f of resultFields) {
      await probe(
        `results { ${f.split(' ')[0]} }`,
        `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { results { ${f} } } }`,
        { id: GRADE_ID }, cookie
      );
    }

    // SearchResultMeta confirmed fields
    console.log('\n  ── SearchResultMeta fields ──\n');
    await probe(
      'meta { totalPages totalRecords }',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { meta { totalPages totalRecords } } }`,
      { id: GRADE_ID }, cookie
    );
    await probe(
      'meta { totalPages totalRecords page hasMore }',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { meta { totalPages totalRecords page hasMore } } }`,
      { id: GRADE_ID }, cookie
    );

    // Full query with pagination — find correct args
    console.log('\n  ── gradePlayerStatistics pagination args ──\n');
    const paginationArgs = ['page: 1', 'page: 2', 'pageSize: 10', 'pageNumber: 1'];
    for (const p of paginationArgs) {
      await probe(
        `gradePlayerStatistics(gradeID, ${p})`,
        `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, ${p}) { meta { totalPages totalRecords } results { __typename } } }`,
        { id: GRADE_ID }, cookie
      );
    }
  }

  // ── 2. seasonRegistrations — remaining field candidates ──────────────────
  if (SEASON_ID) {
    console.log(`\n━━━ seasonRegistrations remaining fields  (seasonId: ${SEASON_ID}) ━━━\n`);

    // ageRestriction was suggested
    await probe(
      'seasonRegistrations { id ageRestriction }',
      `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id ageRestriction } }`,
      { id: SEASON_ID }, cookie
    );
    await probe(
      'seasonRegistrations { id ageRestriction { from to } }',
      `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id ageRestriction { from to } } }`,
      { id: SEASON_ID }, cookie
    );

    // Try organisation sub-fields now we know it works
    await probe(
      'seasonRegistrations { id organisation { id name type } }',
      `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id organisation { id name type } } }`,
      { id: SEASON_ID }, cookie
    );

    // Are there team-level registrations we can reach FROM here?
    await probe(
      'seasonRegistrations { id teams { id name } }',
      `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id teams { id name } } }`,
      { id: SEASON_ID }, cookie
    );
    await probe(
      'seasonRegistrations { id team { id name } }',
      `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id team { id name } } }`,
      { id: SEASON_ID }, cookie
    );

    // How many registrations does this season have?
    await probe(
      'seasonRegistrations count (first 3 ids only)',
      `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id } }`,
      { id: SEASON_ID }, cookie
    );
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
