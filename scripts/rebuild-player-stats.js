// scripts/rebuild-player-stats.js

import fs     from 'fs';
import path   from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

const args        = process.argv.slice(2);
const FORCE       = args.includes('--force');
const DRY_RUN     = args.includes('--dry-run');
const STATS_ONLY  = args.includes('--stats-only');
const CONCURRENCY = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '3');
const COMMIT_N    = 2000;
const PROGRESS    = path.join(ROOT, 'scripts', '.rebuild-player-stats-progress.json');

console.log(`rebuild-player-stats | concurrency=${CONCURRENCY} force=${FORCE} dry=${DRY_RUN}\n`);

const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};
const API_URL = 'https://api.playhq.com/graphql';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let _sessionCookie = null;
let _sessionPromise = null;

async function getSession(forceRefresh = false) {
  if (forceRefresh) {
    _sessionCookie = null;
    _sessionPromise = null;
  }
  
  if (_sessionCookie && !forceRefresh) return _sessionCookie;
  if (_sessionPromise) return _sessionPromise;
  
  _sessionPromise = (async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) await delay(attempt * 2000);
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
          body: JSON.stringify({
            operationName: 'ProfileSearch',
            variables: { fullName: 'test user' },
            query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id __typename } } }',
          }),
        });
        
        // Updated logic to capture all cookies correctly
        const raw = res.headers.get('set-cookie');
        if (raw) {
          // Combine phq_session, phq_sub, and phq_tier into a single string
          _sessionCookie = raw.split(',').map(c => c.trim().split(';')[0]).join('; ');
          console.log(`  ✓ Session obtained (${_sessionCookie.slice(0, 24)}...)\n`);
          return _sessionCookie;
        }
      } catch (err) {
        console.error(`  Session fetch error: ${err.message}`);
      }
    }
    throw new Error('No Set-Cookie after 5 attempts');
  })().finally(() => { _sessionPromise = null; });
  
  return _sessionPromise;
}

const Q_PROFILE = `query Profile($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    careerStatistics {
      totalStatistics { count details { value __typename } gameFormat __typename }
      clubStatistics {
        id
        club { id name __typename }
        statistics { count details { value __typename } gameFormat __typename }
        __typename
      }
      __typename
    }
    seasonStatistics {
      name
      player { hasGamePermit __typename }
      statistics {
        season { id name competition { id name organisation { id name __typename } __typename } __typename }
        role
        club { id name __typename }
        totalStatistics { count details { value __typename } gameFormat __typename }
        teamStatistics {
          team { ... on DiscoverTeam { id name __typename } __typename }
          totalStatistics { count details { value __typename } gameFormat __typename }
          gradeStatistics {
            grade { id name __typename }
            gameStatistics {
              game {
                id
                round { name isFinalsRound __typename }
                home { ... on DiscoverTeam { id name __typename } __typename }
                away { ... on DiscoverTeam { id name __typename } __typename }
              }
              statistics { count details { value __typename } }
            }
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

async function fetchProfile(uuid, retryCount = 0) {
  if (retryCount > 3) return null;
  
  const cookie = await getSession();
  
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
    body:    JSON.stringify({ operationName: 'Profile', variables: { profileID: uuid }, query: Q_PROFILE }),
  });
  
  if (res.status === 429) { await delay(10000); return fetchProfile(uuid, retryCount + 1); }
  if (res.status === 403) {
    await delay(60000);
    await getSession(true);
    return fetchProfile(uuid, retryCount + 1);
  }
  
  if (!res.ok) return null;
  
  let json;
  try { json = await res.json(); } catch { return null; }
  
  if (json.errors) {
    const errText = JSON.stringify(json.errors).toLowerCase();
    if (errText.includes('unauthorized') || errText.includes('expired') || errText.includes('forbidden')) {
      await getSession(true);
      return fetchProfile(uuid, retryCount + 1);
    }
    return null;
  }
  
  return json?.data?.publicProfileStatistics ?? null;
}

// ... (Rest of your existing helper functions and main loop logic remains the same)
