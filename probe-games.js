#!/usr/bin/env node
// probe-games.js — probe specific game IDs via discoverGame and show full allocation
// Usage: node probe-games.js --games=75bca1b6,96212a4c,10476874

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const GAMES     = (process.argv.find(a => a.startsWith('--games='))?.split('=')[1] || '').split(',').filter(Boolean);
const TENANT    = process.argv.find(a => a.startsWith('--tenant='))?.split('=')[1] || 'bv';
const TENANT_FULL = { bv: 'basketball-victoria' }[TENANT] || TENANT;
const API_URL   = 'https://api.playhq.com/graphql';
const COOKIE_FILE = path.join(__dirname, `backfill-venue-cookie.json`);

if (!GAMES.length) { console.error('--games=<id1,id2,...> required'); process.exit(1); }

const HEADERS = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': TENANT_FULL, 'content-type': 'application/json',
};

async function getSession() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const d = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      if (Date.now() - d.fetchedAt < 5 * 60 * 60 * 1000) return d.cookie;
    }
  } catch (e) {}
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({ operationName: 'ProfileSearch', variables: { fullName: 'test player' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No Set-Cookie');
  const cookie = raw.split(';')[0];
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie, fetchedAt: Date.now() }));
  return cookie;
}

const Q = `query DiscoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) {
    id date
    round { name }
    status { value }
    home { ... on DiscoverTeam { id name } }
    away { ... on DiscoverTeam { id name } }
    result {
      winner { value }
      outcome { name value }
      home {
        outcome { name value }
        gameOutcomeDescription
        statistics { count type { value } }
      }
      away {
        outcome { name value }
        statistics { count type { value } }
      }
    }
    allocation {
      dateTimeList { date time }
      court {
        id name
        venue { id name address suburb state }
      }
    }
  }
}`;

async function main() {
  const cookie = await getSession();
  console.log(`Probing ${GAMES.length} game IDs...\n`);

  for (const gameId of GAMES) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
      body: JSON.stringify({ operationName: 'DiscoverGame', variables: { gameID: gameId }, query: Q }),
    });
    const json = await res.json();

    console.log(`=== ${gameId} ===`);
    if (json.errors) {
      console.log(`  ERROR: ${json.errors[0].message}`);
    } else {
      const g = json.data?.discoverGame;
      if (!g) {
        console.log(`  NOT FOUND`);
      } else {
        console.log(`  Date:   ${g.date}`);
        console.log(`  Round:  ${g.round?.name || 'none'}`);
        console.log(`  Status: ${g.status?.value || 'none'}`);
        console.log(`  Home:   ${g.home?.name || '?'} (${g.home?.id || '?'})`);
        console.log(`  Away:   ${g.away?.name || '?'} (${g.away?.id || '?'})`);
        const hs = g.result?.home?.statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count;
        const as_ = g.result?.away?.statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count;
        console.log(`  Score:   ${hs ?? 'none'} - ${as_ ?? 'none'}`);
        console.log(`  Outcome: ${g.result?.outcome?.value || 'none'}`);
        console.log(`  Desc:    ${g.result?.home?.gameOutcomeDescription || 'none'}`);
        const venue = g.allocation?.court?.venue;
        console.log(`  Venue:  ${venue ? `${venue.name}, ${venue.suburb}` : 'none'}`);
        console.log(`  Court:  ${g.allocation?.court?.name || 'none'}`);
        console.log(`  Time:   ${g.allocation?.time || 'none'}`);
      }
    }
    console.log();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
