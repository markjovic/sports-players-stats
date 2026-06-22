// scripts/test-schema-fields.js
'use strict';

const https  = require('https');
const crypto = require('crypto');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const TEAM_ID  = args.teamId  || args.teamid  || args.team;
const ORG_ID   = args.orgId   || args.orgid   || args.org;
const GRADE_ID = args.gradeId || args.gradeid || args.grade;
const SEASON_ID = args.seasonId || args.seasonid || args.season;

const API_URL = 'https://api.playhq.com/graphql';

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
  await new Promise(r => setTimeout(r, 300));
  try {
    const res = await doFetch({ operationName: 'T', variables, query }, cookie);
    if (res.errors) {
      const msg = res.errors[0]?.message || '';
      console.log(`  ❌ ${label.padEnd(50)} ${msg.slice(0, 90)}`);
      return { ok: false, msg };
    }
    const preview = JSON.stringify(res.data)?.slice(0, 150);
    console.log(`  ✅ ${label.padEnd(50)} ${preview}`);
    return { ok: true, data: res.data };
  } catch (e) {
    console.log(`  ❌ ${label.padEnd(50)} ${e.message?.slice(0, 60)}`);
    return { ok: false, msg: e.message };
  }
}

async function main() {
  console.log('test-schema-fields.js — round 2\n');
  console.log('Getting session...');
  let cookie = null;
  try { cookie = await getSession(); console.log('  Session obtained\n'); }
  catch (e) { console.log('  No session\n'); }

  // ── 1. discoverOrganisation — find correct argument name ─────────────────
  if (ORG_ID) {
    console.log(`━━━ discoverOrganisation argument names  (orgId: ${ORG_ID}) ━━━\n`);
    const argNames = ['id', 'orgID', 'orgId', 'organisationId', 'organisationID', 'routingCode'];
    for (const arg of argNames) {
      await probe(
        `discoverOrganisation(${arg}: $id) { id name }`,
        `query T($id: ID!) { discoverOrganisation(${arg}: $id) { id name } }`,
        { id: ORG_ID }, cookie
      );
    }

    // Once we find the right arg, probe for seasons/competitions sub-fields
    console.log('\n  ── discoverOrganisation sub-fields (trying all arg names) ──\n');
    const subFields = ['seasons { id name }', 'competitions { id name }', 'currentSeasons { id name }', 'activeSeasons { id name }'];
    for (const arg of ['id', 'orgID', 'organisationId']) {
      for (const sub of subFields) {
        await probe(
          `discoverOrganisation(${arg}) { ${sub} }`,
          `query T($id: ID!) { discoverOrganisation(${arg}: $id) { id ${sub} } }`,
          { id: ORG_ID }, cookie
        );
      }
    }
  }

  // ── 2. Root-level team player queries ────────────────────────────────────
  if (TEAM_ID) {
    console.log(`\n━━━ Root-level team player queries  (teamId: ${TEAM_ID}) ━━━\n`);
    const rootQueries = [
      ['discoverTeamPlayers',        `query T($id: ID!) { discoverTeamPlayers(teamID: $id) { id firstName lastName } }`],
      ['teamPlayerStatistics',       `query T($id: ID!) { teamPlayerStatistics(teamID: $id) { results { profile { id firstName lastName } } } }`],
      ['publicTeamPlayers',          `query T($id: ID!) { publicTeamPlayers(teamID: $id) { id firstName lastName } }`],
      ['discoverTeamRegistrations',  `query T($id: ID!) { discoverTeamRegistrations(teamID: $id) { id profile { id firstName lastName } } }`],
      ['discoverTeamRoster',         `query T($id: ID!) { discoverTeamRoster(teamID: $id) { id firstName lastName } }`],
      ['teamRoster',                 `query T($id: ID!) { teamRoster(teamID: $id) { id firstName lastName } }`],
      ['publicTeamRegistrations',    `query T($id: ID!) { publicTeamRegistrations(teamID: $id) { id profile { id firstName lastName } } }`],
    ];
    for (const [label, q] of rootQueries) {
      await probe(label, q, { id: TEAM_ID }, cookie);
    }
  }

  // ── 3. Season-level team/player queries ───────────────────────────────────
  if (SEASON_ID) {
    console.log(`\n━━━ Season-level queries  (seasonId: ${SEASON_ID}) ━━━\n`);
    const seasonQueries = [
      ['discoverSeasonTeams',    `query T($id: ID!) { discoverSeasonTeams(seasonID: $id) { id name } }`],
      ['discoverSeasonPlayers',  `query T($id: ID!) { discoverSeasonPlayers(seasonID: $id) { id firstName lastName } }`],
      ['discoverSeasonRoster',   `query T($id: ID!) { discoverSeasonRoster(seasonID: $id) { id firstName lastName } }`],
      // discoverSeason with teams sub-field
      ['discoverSeason.teams',   `query T($id: ID!) { discoverSeason(seasonID: $id) { id name teams { id name } } }`],
      ['discoverSeason.players', `query T($id: ID!) { discoverSeason(seasonID: $id) { id name players { id } } }`],
      ['discoverSeason.registrations', `query T($id: ID!) { discoverSeason(seasonID: $id) { id name registrations { id profile { id firstName } } } }`],
    ];
    for (const [label, q] of seasonQueries) {
      await probe(label, q, { id: SEASON_ID }, cookie);
    }
  }

  // ── 4. Grade-level — extend gradePlayerStatistics ────────────────────────
  if (GRADE_ID) {
    console.log(`\n━━━ Grade-level player queries  (gradeId: ${GRADE_ID}) ━━━\n`);
    // gradePlayerStatistics is confirmed — test if it returns UPCOMING players
    await probe(
      'gradePlayerStatistics — check for UPCOMING players',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, pageSize: 5) { totalCount results { profile { id firstName lastName } team { id name } totalStatistics { count details { value } } } } }`,
      { id: GRADE_ID }, cookie
    );
    // Also try gradeRegistrations or similar
    const gradeQueries = [
      ['gradeRegistrations',     `query T($id: ID!) { gradeRegistrations(gradeID: $id) { id profile { id firstName lastName } team { id name } } }`],
      ['discoverGradeRoster',    `query T($id: ID!) { discoverGradeRoster(gradeID: $id) { id firstName lastName } }`],
      ['gradeTeamRegistrations', `query T($id: ID!) { gradeTeamRegistrations(gradeID: $id) { id profile { id firstName lastName } } }`],
    ];
    for (const [label, q] of gradeQueries) {
      await probe(label, q, { id: GRADE_ID }, cookie);
    }
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
