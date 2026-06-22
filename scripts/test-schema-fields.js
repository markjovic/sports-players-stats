// scripts/test-schema-fields.js
'use strict';

const https  = require('https');
const crypto = require('crypto');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const TEAM_ID   = args.teamId   || args.teamid   || args.team;
const ORG_ID    = args.orgId    || args.orgid    || args.org;
const GRADE_ID  = args.gradeId  || args.gradeid  || args.grade;
const SEASON_ID = args.seasonId || args.seasonid || args.season;

const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

function doFetch(body, cookie) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const headers = { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'content-length': Buffer.byteLength(bodyStr) };
    if (cookie) headers['Cookie'] = cookie;
    const req = https.request(
      { hostname: 'api.playhq.com', path: '/graphql', method: 'POST', headers, agent: new https.Agent({ keepAlive: false }) },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function getSession() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' });
    const req = https.request(
      { hostname: 'api.playhq.com', path: '/graphql', method: 'POST', headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'content-length': Buffer.byteLength(body) }, agent: new https.Agent({ keepAlive: false }) },
      (res) => {
        const raw = res.headers['set-cookie'];
        if (!raw) { reject(new Error('No set-cookie')); return; }
        const parts = (Array.isArray(raw) ? raw.join(', ') : raw).split(',').map(c => c.trim().split(';')[0]);
        const get = name => parts.find(p => p.startsWith(name + '=')) || null;
        resolve([get('phq_tier'), get('phq_session'), get('phq_sub')].filter(Boolean).join('; '));
        res.resume();
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function probe(label, query, variables, cookie) {
  await new Promise(r => setTimeout(r, 400));
  try {
    const res = await doFetch({ operationName: 'T', variables, query }, cookie);
    if (res.errors) {
      const msg = res.errors[0]?.message || '';
      console.log(`  ❌ ${label.padEnd(55)} ${msg.slice(0, 100)}`);
      return { ok: false, msg };
    }
    const preview = JSON.stringify(res.data)?.slice(0, 200);
    console.log(`  ✅ ${label.padEnd(55)} ${preview}`);
    return { ok: true, data: res.data };
  } catch (e) {
    console.log(`  ❌ ${label.padEnd(55)} ${e.message?.slice(0, 80)}`);
    return { ok: false };
  }
}

async function main() {
  console.log('test-schema-fields.js — round 3\n');
  console.log('Getting session...');
  let cookie = null;
  try { cookie = await getSession(); console.log('  Session obtained\n'); }
  catch (e) { console.log('  No session\n'); }

  // ── 1. discoverOrganisation with no arguments (tenant-based) ─────────────
  console.log('━━━ discoverOrganisation — no arguments (tenant-based?) ━━━\n');
  await probe(
    'discoverOrganisation { id name }',
    'query T { discoverOrganisation { id name } }',
    {}, cookie
  );
  await probe(
    'discoverOrganisation { id name seasons { id name } }',
    'query T { discoverOrganisation { id name seasons { id name } } }',
    {}, cookie
  );
  await probe(
    'discoverOrganisation { id name competitions { id name } }',
    'query T { discoverOrganisation { id name competitions { id name } } }',
    {}, cookie
  );

  // ── 2. socialTeamRegistrations — suggested twice ──────────────────────────
  if (TEAM_ID) {
    console.log(`\n━━━ socialTeamRegistrations  (teamId: ${TEAM_ID}) ━━━\n`);

    // Try various argument names
    const argNames = ['teamID', 'teamId', 'id'];
    for (const arg of argNames) {
      await probe(
        `socialTeamRegistrations(${arg}) { id profile { id firstName lastName } }`,
        `query T($id: ID!) { socialTeamRegistrations(${arg}: $id) { id profile { id firstName lastName } } }`,
        { id: TEAM_ID }, cookie
      );
    }

    // Try with input wrapper (some PlayHQ queries use input objects)
    await probe(
      'socialTeamRegistrations(input: { teamID }) { id }',
      `query T($id: ID!) { socialTeamRegistrations(input: { teamID: $id }) { id profile { id firstName lastName } } }`,
      { id: TEAM_ID }, cookie
    );

    // Try pagination variants
    await probe(
      'socialTeamRegistrations(teamID, page, limit)',
      `query T($id: ID!) { socialTeamRegistrations(teamID: $id, page: 1, limit: 10) { id profile { id firstName lastName } } }`,
      { id: TEAM_ID }, cookie
    );
  }

  // ── 3. seasonRegistrations — suggested once ───────────────────────────────
  if (SEASON_ID) {
    console.log(`\n━━━ seasonRegistrations  (seasonId: ${SEASON_ID}) ━━━\n`);

    const argNames = ['seasonID', 'seasonId', 'id'];
    for (const arg of argNames) {
      await probe(
        `seasonRegistrations(${arg}) { id profile { id firstName lastName } }`,
        `query T($id: ID!) { seasonRegistrations(${arg}: $id) { id profile { id firstName lastName } } }`,
        { id: SEASON_ID }, cookie
      );
    }

    await probe(
      'seasonRegistrations(seasonID) { totalCount results { ... } }',
      `query T($id: ID!) { seasonRegistrations(seasonID: $id) { totalCount results { id profile { id firstName lastName } team { id name } } } }`,
      { id: SEASON_ID }, cookie
    );

    // discoverSeasonRegistrations
    await probe(
      'discoverSeasonRegistrations(seasonID) { id profile { id } }',
      `query T($id: ID!) { discoverSeasonRegistrations(seasonID: $id) { id profile { id firstName lastName } } }`,
      { id: SEASON_ID }, cookie
    );
  }

  // ── 4. gradePlayerStatistics — fix argument name ──────────────────────────
  if (GRADE_ID) {
    console.log(`\n━━━ gradePlayerStatistics argument variations  (gradeId: ${GRADE_ID}) ━━━\n`);

    // We know gradeID works, pageSize doesn't — try limit, page, first
    const paginationArgs = [
      'page: 1, limit: 5',
      'page: 1',
      'limit: 5',
      'first: 5',
      'take: 5',
    ];
    for (const pag of paginationArgs) {
      await probe(
        `gradePlayerStatistics(gradeID, ${pag})`,
        `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, ${pag}) { totalCount results { profile { id firstName lastName } } } }`,
        { id: GRADE_ID }, cookie
      );
    }

    // Plain with no pagination args (confirmed working — check totalCount)
    await probe(
      'gradePlayerStatistics(gradeID only) — full response',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { totalCount results { profile { id firstName lastName } team { id name } } } }`,
      { id: GRADE_ID }, cookie
    );
  }

  // ── 5. Bonus: discoverSeason fields we haven't tried ─────────────────────
  if (SEASON_ID) {
    console.log(`\n━━━ discoverSeason unexplored sub-fields  (seasonId: ${SEASON_ID}) ━━━\n`);
    const fields = [
      'status { value }',
      'startDate',
      'endDate',
      'organisation { id name }',
      'competition { id name }',
    ];
    const fieldList = fields.join(' ');
    await probe(
      'discoverSeason full metadata',
      `query T($id: ID!) { discoverSeason(seasonID: $id) { id name ${fieldList} grades { id name } } }`,
      { id: SEASON_ID }, cookie
    );
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
