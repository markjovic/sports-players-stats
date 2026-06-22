// scripts/test-profile-query.js
// Tests two query variants against a UUID to diagnose null returns.
// Run: node scripts/test-profile-query.js <uuid>

import crypto from 'crypto';

const uuid = process.argv[2];
if (!uuid) { console.error('Usage: node scripts/test-profile-query.js <uuid>'); process.exit(1); }

const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// Get session cookie
async function getSession() {
  const res = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({ operationName: 'ProfileSearch', variables: { fullName: 'a' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No cookie');
  // set-cookie comes back as comma-joined string in native fetch.
  // Split on ', ' to get individual cookie strings, then extract name=value pairs.
  const parts = raw.split(',').map(c => c.trim().split(';')[0].trim());
  const get = name => parts.find(p => p.startsWith(name + '=')) || null;
  const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
  if (!tier || !session || !sub) throw new Error(`Incomplete cookies — got: ${parts.join(' | ')}`);
  // Cookie order is critical: phq_tier first, then phq_session, then phq_sub
  return `${tier}; ${session}; ${sub}`;
}

// Query A: exact API reference query (no totalStatistics, no __typename)
const Q_REF = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics { statistics {
      season { id }
      teamStatistics {
        team { ... on DiscoverTeam { id name } }
        gradeStatistics {
          grade { id name }
          gameStatistics {
            game { id round { name } }
            statistics { count details { value } }
          }
        }
      }
    }}
  }
}`;

// Query B: current rebuild script query (with totalStatistics + __typename)
const Q_CURRENT = `query S($id:ID!){publicProfileStatistics(profileID:$id){seasonStatistics{statistics{
  season{id}
  teamStatistics{
    team{...on DiscoverTeam{id}}
    gradeStatistics{
      grade{id}
      totalStatistics{count details{value __typename}}
      gameStatistics{game{id}statistics{count details{value __typename}}}
    }
  }
}}}}`;

async function test(label, query, variables, cookie) {
  const res = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
    body: JSON.stringify({ operationName: label, variables, query }),
  });
  const json = await res.json();
  const pps = json?.data?.publicProfileStatistics;
  const seasons = pps?.seasonStatistics?.length ?? 'N/A';
  console.log(`\n[${label}] HTTP ${res.status}`);
  console.log(`  publicProfileStatistics: ${pps === null ? 'NULL' : pps === undefined ? 'UNDEFINED' : 'PRESENT'}`);
  if (pps) console.log(`  seasonStatistics entries: ${seasons}`);
}

console.log(`\nTesting UUID: ${uuid}\n`);
const cookie = await getSession();
console.log('Session obtained');

await test('REF_QUERY',     Q_REF,     { profileID: uuid }, cookie);
await test('CURRENT_QUERY', Q_CURRENT, { id: uuid },        cookie);
