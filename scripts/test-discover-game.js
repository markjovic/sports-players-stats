// scripts/test-discover-game.js
// Tests discoverGame for a specific game ID to check forfeit/abandoned flags.
// Run: node scripts/test-discover-game.js <gameId>
// e.g: node scripts/test-discover-game.js 10591e07

import crypto from 'crypto';

const gameId = process.argv[2];
if (!gameId) { console.error('Usage: node scripts/test-discover-game.js <gameId>'); process.exit(1); }

const HEADERS = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

async function getSession() {
  const res = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({ operationName: 'TenantConfig', variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }' }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No cookie');
  const parts = raw.split(',').map(c => c.trim().split(';')[0].trim());
  const get   = n => parts.find(p => p.startsWith(n + '=')) || null;
  const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
  if (!tier || !session || !sub) throw new Error(`Incomplete cookies — got: ${parts.join(' | ')}`);
  return `${tier}; ${session}; ${sub}`;
}

// Full discoverGame query — captures all status/result fields including forfeit
const Q = `query discoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) {
    id
    status { value }
    forfeit { isForfeit winnerID notes }
    abandoned { isAbandoned notes }
    home {
      ... on DiscoverTeam { id name }
    }
    away {
      ... on DiscoverTeam { id name }
    }
    result {
      home {
        statistics { count type { value } }
        gameOutcomeDescription
      }
      away {
        statistics { count type { value } }
        gameOutcomeDescription
      }
    }
    round { name number isFinalsRound }
    date
  }
}`;

console.log(`\nQuerying discoverGame for: ${gameId}\n`);
const cookie = await getSession();
console.log('Session obtained\n');

const res = await fetch('https://api.playhq.com/graphql', {
  method: 'POST',
  headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
  body: JSON.stringify({ operationName: 'discoverGame',
    variables: { gameID: gameId }, query: Q }),
});

const json = await res.json();
if (json.errors) {
  console.log('GraphQL errors:', JSON.stringify(json.errors, null, 2));
} else {
  const g = json.data?.discoverGame;
  if (!g) {
    console.log('discoverGame returned null — game may be hidden or inaccessible');
  } else {
    console.log('discoverGame result:');
    console.log(JSON.stringify(g, null, 2));

    console.log('\n── Key fields ──');
    console.log(`  status:    ${g.status?.value}`);
    console.log(`  forfeit:   ${JSON.stringify(g.forfeit)}`);
    console.log(`  abandoned: ${JSON.stringify(g.abandoned)}`);
    const homeScore = g.result?.home?.statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count;
    const awayScore = g.result?.away?.statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count;
    console.log(`  score:     ${homeScore ?? '?'} – ${awayScore ?? '?'}`);
    console.log(`  home outcome: ${g.result?.home?.gameOutcomeDescription}`);
    console.log(`  away outcome: ${g.result?.away?.gameOutcomeDescription}`);
  }
}
