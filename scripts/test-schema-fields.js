// scripts/test-schema-fields.js
// Tests plausible GraphQL field names on discoverTeam and discoverOrganisation
// to find team roster and org→seasons queries without needing a traffic capture.
// Relies on GraphQL returning schema validation errors (not 403s) for unknown fields.
//
// Usage:
//   node scripts/test-schema-fields.js --teamId=<teamId> --orgId=<orgId>
//
// Find a teamId from any games/bv/{seasonId}.json entry's h or a field.
// Find an orgId from sports-index.json any season's orgId field.

'use strict';

const https  = require('https');
const crypto = require('crypto');

const args   = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const TEAM_ID = args.teamId || args.teamid || args.team;
const ORG_ID  = args.orgId  || args.orgid  || args.org;

if (!TEAM_ID && !ORG_ID) {
  console.error('Usage: node scripts/test-schema-fields.js --teamId=<id> --orgId=<id>');
  console.error('  At least one of --teamId or --orgId is required.');
  process.exit(1);
}

const API_URL = 'https://api.playhq.com/graphql';

const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── HTTP helper (new connection per request — avoids CloudFront per-connection limit) ──

function doFetch(body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.playhq.com',
      path:     '/graphql',
      method:   'POST',
      headers:  {
        ...HEADERS_BASE,
        'request-id':    crypto.randomUUID(),
        'content-length': Buffer.byteLength(bodyStr),
      },
      agent: new https.Agent({ keepAlive: false }),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Session cookie ──────────────────────────────────────────────────────────

async function getSession() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      operationName: 'TenantConfig',
      variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }',
    });
    const req = https.request({
      hostname: 'api.playhq.com',
      path:     '/graphql',
      method:   'POST',
      headers:  { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'content-length': Buffer.byteLength(body) },
      agent:    new https.Agent({ keepAlive: false }),
    }, (res) => {
      const raw = res.headers['set-cookie'];
      if (!raw) { reject(new Error('No set-cookie')); return; }
      const parts = (Array.isArray(raw) ? raw.join(', ') : raw)
        .split(',').map(c => c.trim().split(';')[0]);
      const get = name => parts.find(p => p.startsWith(name + '=')) || null;
      const cookie = [get('phq_tier'), get('phq_session'), get('phq_sub')].filter(Boolean).join('; ');
      resolve(cookie);
      res.resume();
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Test a single field on discoverTeam ────────────────────────────────────

async function testTeamField(teamId, fieldName, cookie) {
  // Build a minimal sub-selection — try id first, fall back to empty
  const subFields = ['{ id }', '{ id firstName lastName }', '{ id name }', '{ value }', ''];
  
  for (const sub of subFields) {
    const query = `query T($id: ID!) { discoverTeam(teamID: $id) { id ${fieldName} ${sub} } }`;
    try {
      const res = await doFetch({
        operationName: 'T',
        variables: { id: teamId },
        query,
        headers: cookie ? { Cookie: cookie } : {},
      });
      
      if (res.errors) {
        const msg = res.errors[0]?.message || '';
        // Schema validation error = field doesn't exist or wrong sub-selection
        if (msg.includes('Cannot query field') || msg.includes('Unknown argument')) {
          return { exists: false, reason: msg };
        }
        if (msg.includes('must have a selection') || msg.includes('Field') && msg.includes('selection set')) {
          // Field exists but needs sub-fields — try next sub-selection
          continue;
        }
        return { exists: false, reason: msg };
      }
      
      const val = res.data?.discoverTeam?.[fieldName];
      return { exists: true, value: val, sub };
    } catch (e) {
      return { exists: false, reason: e.message };
    }
  }
  return { exists: false, reason: 'all sub-selections failed' };
}

// ─── Test a field on discoverOrganisation ───────────────────────────────────

async function testOrgQuery(orgId, queryName, argName, fieldName, subField, cookie) {
  const query = `query O($id: ID!) { ${queryName}(${argName}: $id) { id ${fieldName} { ${subField} } } }`;
  try {
    const res = await doFetch({
      operationName: 'O',
      variables: { id: orgId },
      query,
    });
    if (res.errors) {
      return { exists: false, reason: res.errors[0]?.message };
    }
    const val = res.data?.[queryName]?.[fieldName];
    return { exists: true, value: val };
  } catch (e) {
    return { exists: false, reason: e.message };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('test-schema-fields.js — probing PlayHQ GraphQL schema\n');

  console.log('Getting session cookie...');
  let cookie = null;
  try {
    cookie = await getSession();
    console.log('  Session obtained\n');
  } catch (e) {
    console.log('  Could not get session — continuing without cookie\n');
  }

  // ── 1. discoverTeam field candidates ──────────────────────────────────────
  if (TEAM_ID) {
    console.log(`━━━ discoverTeam fields  (teamId: ${TEAM_ID}) ━━━\n`);

    const teamFields = [
      'players',
      'registrations',
      'participants',
      'roster',
      'members',
      'athletes',
      'profiles',
      'teamRegistrations',
      'playerRegistrations',
      'teamPlayers',
    ];

    for (const field of teamFields) {
      const result = await testTeamField(TEAM_ID, field, cookie);
      if (result.exists) {
        const preview = JSON.stringify(result.value)?.slice(0, 120);
        console.log(`  ✅ ${field.padEnd(22)} EXISTS  sub="${result.sub}"  value=${preview}`);
      } else {
        const reason = result.reason?.slice(0, 80) || 'unknown';
        console.log(`  ❌ ${field.padEnd(22)} ${reason}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // ── 2. Org-level season query candidates ──────────────────────────────────
  if (ORG_ID) {
    console.log(`\n━━━ Organisation→seasons queries  (orgId: ${ORG_ID}) ━━━\n`);

    const orgQueries = [
      { queryName: 'discoverOrganisation',       argName: 'organisationID', fieldName: 'seasons',      subField: 'id name' },
      { queryName: 'discoverOrganisation',       argName: 'organisationID', fieldName: 'competitions', subField: 'id name' },
      { queryName: 'publicOrganisation',         argName: 'organisationID', fieldName: 'seasons',      subField: 'id name' },
      { queryName: 'discoverOrganisationSeasons',argName: 'organisationID', fieldName: 'seasons',      subField: 'id name' },
    ];

    for (const q of orgQueries) {
      try {
        const query = `query O($id: ID!) { ${q.queryName}(${q.argName}: $id) { id ${q.fieldName} { ${q.subField} } } }`;
        const res = await doFetch({ operationName: 'O', variables: { id: ORG_ID }, query });
        if (res.errors) {
          const msg = res.errors[0]?.message?.slice(0, 80) || 'error';
          console.log(`  ❌ ${q.queryName}.${q.fieldName.padEnd(14)} ${msg}`);
        } else {
          const val = res.data?.[q.queryName]?.[q.fieldName];
          const preview = JSON.stringify(val)?.slice(0, 120);
          console.log(`  ✅ ${q.queryName}.${q.fieldName.padEnd(14)} EXISTS  value=${preview}`);
        }
      } catch (e) {
        console.log(`  ❌ ${q.queryName}.${q.fieldName.padEnd(14)} ${e.message?.slice(0, 60)}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
