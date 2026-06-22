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
      console.log(`  ❌ ${label.padEnd(65)} ${msg.slice(0, 100)}`);
      return { ok: false, msg };
    }
    const preview = JSON.stringify(res.data)?.slice(0, 300);
    console.log(`  ✅ ${label.padEnd(65)} ${preview}`);
    return { ok: true, data: res.data };
  } catch (e) {
    console.log(`  ❌ ${label.padEnd(65)} ${e.message?.slice(0, 80)}`);
    return { ok: false };
  }
}

async function main() {
  console.log('test-schema-fields.js — round 5\n');
  console.log('Getting session...');
  let cookie = null;
  try { cookie = await getSession(); console.log('  Session obtained\n'); }
  catch (e) { console.log('  No session\n'); }

  // ── 1. seasonRegistrations — find DiscoverRegistration fields ─────────────
  if (SEASON_ID) {
    console.log(`━━━ seasonRegistrations — DiscoverRegistration fields  (seasonId: ${SEASON_ID}) ━━━\n`);

    // __typename to find concrete type name
    await probe(
      'seasonRegistrations { id __typename }',
      `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id __typename } }`,
      { id: SEASON_ID }, cookie
    );

    // gender was suggested
    await probe(
      'seasonRegistrations { id gender }',
      `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id gender } }`,
      { id: SEASON_ID }, cookie
    );

    // season as inline fragment (it's a union/interface)
    await probe(
      'seasonRegistrations { id season { ... on DiscoverSeason { id name } } }',
      `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id season { ... on DiscoverSeason { id name } } } }`,
      { id: SEASON_ID }, cookie
    );

    // More field candidates
    const moreFields = [
      'dateOfBirth',
      'age',
      'person { id firstName lastName }',
      'participant { id }',
      'publicProfile { id firstName lastName }',
      'publicProfileID',
      'registrantID',
      'registrant { id firstName lastName }',
      'memberID',
      'member { id }',
      'athlete { id firstName lastName }',
      'playHQProfileID',
      'profileUUID',
      'externalID',
      'teamRegistration { id team { id name } }',
      'gradeRegistration { id grade { id name } }',
      'organisation { id name }',
      'club { id name }',
    ];
    for (const f of moreFields) {
      await probe(
        `seasonRegistrations { id ${f.split(' ')[0]} }`,
        `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id ${f} } }`,
        { id: SEASON_ID }, cookie
      );
    }
  }

  // ── 2. socialTeamRegistration(code: String!) — try routing code ──────────
  if (TEAM_ID) {
    console.log(`\n━━━ socialTeamRegistration(code: String!)  (teamId: ${TEAM_ID}) ━━━\n`);

    // TEAM_ID might be "ac09183b" — try as the code string directly
    const codeAttempts = [TEAM_ID, TEAM_ID.toUpperCase()];
    for (const code of codeAttempts) {
      const r = await probe(
        `socialTeamRegistration(code: "${code}") { id }`,
        `query T { socialTeamRegistration(code: "${code}") { id } }`,
        {}, cookie
      );
      if (r.ok) {
        console.log('  Found! Probing fields...');
        const fields = [
          '__typename',
          'id profile { id firstName lastName }',
          'id participant { id }',
          'id person { id firstName lastName }',
          'id gender',
          'id status { value }',
          'id team { id name }',
          'id grade { id name }',
          'id season { id name }',
          'id role',
        ];
        for (const f of fields) {
          await probe(
            `socialTeamRegistration { ${f.split(' ')[0]} }`,
            `query T { socialTeamRegistration(code: "${code}") { ${f} } }`,
            {}, cookie
          );
        }
        break;
      }
    }
  }

  // ── 3. gradePlayerStatistics { meta } ────────────────────────────────────
  if (GRADE_ID) {
    console.log(`\n━━━ gradePlayerStatistics meta field  (gradeId: ${GRADE_ID}) ━━━\n`);

    await probe(
      'gradePlayerStatistics { meta { totalCount } }',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { meta { totalCount } } }`,
      { id: GRADE_ID }, cookie
    );
    await probe(
      'gradePlayerStatistics { meta { totalCount hasMore nextCursor } }',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { meta { totalCount hasMore nextCursor } } }`,
      { id: GRADE_ID }, cookie
    );
    await probe(
      'gradePlayerStatistics { meta { __typename } }',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { meta { __typename } } }`,
      { id: GRADE_ID }, cookie
    );

    // Introspect: what fields does GradePlayerStatistics actually have?
    // The only confirmed one is 'meta' — are there others?
    const gpsFields = ['results', 'items', 'entries', 'players', 'registrations',
                       'statistics', 'ladder', 'standings', 'count', '__typename'];
    for (const f of gpsFields) {
      await probe(
        `gradePlayerStatistics { ${f}... }`,
        `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { ${f} { __typename } } }`,
        { id: GRADE_ID }, cookie
      );
    }
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
