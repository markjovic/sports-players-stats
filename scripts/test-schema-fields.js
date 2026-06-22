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
      console.log(`  ❌ ${label.padEnd(60)} ${msg.slice(0, 100)}`);
      return { ok: false, msg };
    }
    const preview = JSON.stringify(res.data)?.slice(0, 250);
    console.log(`  ✅ ${label.padEnd(60)} ${preview}`);
    return { ok: true, data: res.data };
  } catch (e) {
    console.log(`  ❌ ${label.padEnd(60)} ${e.message?.slice(0, 80)}`);
    return { ok: false };
  }
}

async function main() {
  console.log('test-schema-fields.js — round 4\n');
  console.log('Getting session...');
  let cookie = null;
  try { cookie = await getSession(); console.log('  Session obtained\n'); }
  catch (e) { console.log('  No session\n'); }

  // ── 1. discoverOrganisation(code:) — find the right code value ───────────
  console.log('━━━ discoverOrganisation(code: String!) ━━━\n');
  const codesToTry = [
    'bv',
    'basketball-victoria',
    ORG_ID,           // e.g. "5433b0e3"
    'BV',
  ].filter(Boolean);

  for (const code of codesToTry) {
    const r = await probe(
      `discoverOrganisation(code: "${code}") { id name }`,
      `query T { discoverOrganisation(code: "${code}") { id name } }`,
      {}, cookie
    );
    if (r.ok) {
      // Found it — now probe sub-fields
      console.log('\n  Found! Probing sub-fields...\n');
      const subFields = [
        'seasons { id name }',
        'competitions { id name }',
        'currentSeasons { id name }',
        'activeSeasons { id name }',
        'logo { sizes { url } }',
        'type',
        'address { suburb }',
      ];
      for (const sub of subFields) {
        await probe(
          `discoverOrganisation.${sub.split(' ')[0]}`,
          `query T { discoverOrganisation(code: "${code}") { id ${sub} } }`,
          {}, cookie
        );
      }
      break;
    }
  }

  // ── 2. socialTeamRegistration (singular) ─────────────────────────────────
  if (TEAM_ID) {
    console.log(`\n━━━ socialTeamRegistration (singular)  (teamId: ${TEAM_ID}) ━━━\n`);

    // First find what arguments it takes
    const argAttempts = [
      [`teamID: $id`, { id: TEAM_ID }],
      [`teamId: $id`, { id: TEAM_ID }],
      [`id: $id`,     { id: TEAM_ID }],
      [`code: $id`,   { id: TEAM_ID }],
    ];
    for (const [argStr, vars] of argAttempts) {
      await probe(
        `socialTeamRegistration(${argStr}) { id }`,
        `query T($id: ID!) { socialTeamRegistration(${argStr}) { id } }`,
        vars, cookie
      );
    }

    // Try with no args
    await probe(
      'socialTeamRegistration (no args) { id }',
      `query T { socialTeamRegistration { id } }`,
      {}, cookie
    );
  }

  // ── 3. seasonRegistrations — find DiscoverRegistration fields ────────────
  if (SEASON_ID) {
    console.log(`\n━━━ seasonRegistrations fields  (seasonId: ${SEASON_ID}) ━━━\n`);

    // We know seasonID works and returns DiscoverRegistration
    // Try minimal field probes to find what's on DiscoverRegistration
    const fieldCandidates = [
      'id',
      'id status',
      'id status { value }',
      'id player { id firstName lastName }',
      'id participant { id firstName lastName }',
      'id profile { id }',
      'id profileID',
      'id team { id name }',
      'id grade { id name }',
      'id season { id name }',
      'id role',
      'id firstName lastName',
      'id name',
    ];
    for (const fields of fieldCandidates) {
      await probe(
        `seasonRegistrations { ${fields} }`,
        `query T($id: ID!) { seasonRegistrations(seasonID: $id) { ${fields} } }`,
        { id: SEASON_ID }, cookie
      );
    }
  }

  // ── 4. gradePlayerStatistics — find actual return structure ──────────────
  if (GRADE_ID) {
    console.log(`\n━━━ gradePlayerStatistics actual structure  (gradeId: ${GRADE_ID}) ━━━\n`);

    // Try as direct array (no wrapper object)
    await probe(
      'gradePlayerStatistics as array { profile { id } }',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { profile { id firstName lastName } team { id name } } }`,
      { id: GRADE_ID }, cookie
    );

    await probe(
      'gradePlayerStatistics as array { id profile { id } }',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { id profile { id firstName lastName } } }`,
      { id: GRADE_ID }, cookie
    );

    // Maybe it wraps in a different way
    await probe(
      'gradePlayerStatistics { data { profile { id } } }',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { data { profile { id firstName lastName } } } }`,
      { id: GRADE_ID }, cookie
    );

    await probe(
      'gradePlayerStatistics { nodes { profile { id } } }',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { nodes { profile { id firstName lastName } } } }`,
      { id: GRADE_ID }, cookie
    );

    // What fields DOES GradePlayerStatistics have?
    const gpsCandidates = ['profile', 'team', 'statistics', 'totalStatistics', 'id',
                           'firstName', 'lastName', 'rank', 'position', 'count'];
    for (const f of gpsCandidates) {
      await probe(
        `gradePlayerStatistics { ${f}... }`,
        `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { ${f} } }`,
        { id: GRADE_ID }, cookie
      );
    }
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
