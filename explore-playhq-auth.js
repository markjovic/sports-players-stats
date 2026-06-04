#!/usr/bin/env node
// explore-playhq-auth.js
/**
 * Explores authenticated PlayHQ API endpoints using the phq_session cookie
 * obtained from a guest session call (mobile app user-agent trick).
 *
 * Cookie is refreshed automatically when expired (24h TTL).
 * Results written to explore-results/ directory.
 *
 * Usage:
 *   node explore-playhq-auth.js
 *   node explore-playhq-auth.js --tenant=bv --profile=<uuid>
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ENDPOINT = 'https://api.playhq.com/graphql';
const OUT_DIR  = path.join(__dirname, 'explore-results');
const COOKIE_FILE = path.join(__dirname, 'explore-cookie.json');

// Use bv by default — change via --tenant arg
const TENANT = process.argv.find(a => a.startsWith('--tenant='))?.split('=')[1] || 'bv';
const TENANT_FULL = { bv: 'basketball-victoria', afl: 'afl', ca: 'cricket-australia' }[TENANT] || TENANT;

// Test profile UUIDs — override via --profile=
const TEST_PROFILE = process.argv.find(a => a.startsWith('--profile='))?.split('=')[1]
  || '94b31aeb-647e-4f5d-80ea-cdeccf1370cd'; // from PS1 script

// Test season/grade IDs for bv
const TEST_SEASON  = '15908988'; // MEBA Junior Domestic Saturday Winter 2026
const TEST_GRADE   = 'a5cf799b'; // U14 Boys VJL1 — Kilsyth (has ladder)

// ─── Mobile app headers (trigger guest session cookie) ────────────────────────

const MOBILE_HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT_FULL,  // full name needed for cookie + auth calls
  'content-type': 'application/json',
};

// All requests use mobile headers — the user-agent is required

// ─── Cookie management ────────────────────────────────────────────────────────

function loadCookie() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const data = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      const age  = Date.now() - data.fetchedAt;
      if (age < 23 * 60 * 60 * 1000) { // use if < 23h old
        console.log(`  ✓ Using cached cookie (${Math.round(age/3600000)}h old)`);
        return data.cookie;
      }
      console.log('  ↻ Cookie expired — refreshing');
    }
  } catch (e) {}
  return null;
}

function saveCookie(cookie) {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie, fetchedAt: Date.now() }));
}

async function fetchCookie() {
  console.log('  Fetching guest session cookie...');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({
      operationName: 'ProfileSearch',
      variables: { fullName: 'test' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id firstName lastName __typename } __typename } }',
    }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No Set-Cookie header in response');
  const cookie = raw.split(';')[0]; // isolate phq_session=...
  console.log(`  ✓ Got cookie: ${cookie.slice(0, 40)}...`);
  saveCookie(cookie);
  return cookie;
}

async function getSession() {
  return loadCookie() || await fetchCookie();
}

// ─── GraphQL helper ───────────────────────────────────────────────────────────

async function gql(operationName, query, variables, cookie) {
  const headers = { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() };
  if (cookie) headers['Cookie'] = cookie;

  const res = await fetch(ENDPOINT, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ operationName, variables, query }),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) { return { _error: `HTTP ${res.status}`, _body: text.slice(0, 500) }; }

  if (json.errors) return { _errors: json.errors, _data: json.data };
  return json.data || {};
}

// ─── Result writer ────────────────────────────────────────────────────────────

function save(name, data) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`    → Saved to explore-results/${name}.json`);
}

function summarise(data) {
  if (!data || typeof data !== 'object') return String(data);
  if (data._error) return `❌ ${data._error}`;
  if (data._errors) return `❌ GraphQL errors: ${data._errors.map(e => e.message).join(', ')}`;
  const keys = Object.keys(data);
  return `✓ Keys: ${keys.join(', ')}`;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

const TESTS = [

  // ── Already working (no cookie needed) ──────────────────────────────────────

  {
    name: '01-public-profile-statistics',
    desc: 'Full player career + game breakdown (no auth)',
    auth: false,
    op:   'publicProfileStatistics',
    vars: { profileID: TEST_PROFILE },
    query: `query publicProfileStatistics($profileID: ID!) {
      publicProfileStatistics(profileID: $profileID) {
        seasonStatistics {
          name
          statistics {
            season { id name }
            club { id name }
            totalStatistics { count details { value } }
            teamStatistics {
              team { ... on DiscoverTeam { id name } }
              gradeStatistics {
                grade { id name }
                totalStatistics { count details { value } }
                gameStatistics {
                  game { id round { name } date
                    home { ... on DiscoverTeam { id name } }
                    away { ... on DiscoverTeam { id name } }
                  }
                  statistics { count details { value } }
                }
              }
            }
          }
        }
      }
      publicProfile(profileID: $profileID) { id firstName lastName }
    }`,
  },

  // ── Authenticated (phq_session cookie) ──────────────────────────────────────

  {
    name: '02-profile-full-authenticated',
    desc: 'Full Profile query from PS1 — highlights, milestones, career stats, teams',
    auth: true,
    op:   'Profile',
    vars: { profileID: TEST_PROFILE },
    query: `query Profile($profileID: ID!) {
      publicProfile(profileID: $profileID) {
        firstName id lastName
        highlights(input: { limit: 5 }) {
          nodes { id __typename }
        }
        lastInteractedOrganisation { id name logo { sizes { url dimensions { height width } } } }
      }
      discoverMilestones(input: { profileID: $profileID }) {
        gameCount
      }
      publicProfileStatistics(profileID: $profileID) {
        careerStatistics {
          totalStatistics { count details { value } gameFormat }
          clubStatistics {
            id
            club { id name logo { sizes { url dimensions { height width } } } }
            statistics { count details { value } gameFormat }
          }
        }
        seasonStatistics {
          name
          player { hasGamePermit }
          statistics {
            season { id name competition { id name organisation { id name } } }
            role club { id name }
            totalStatistics { count details { value } gameFormat }
            teamStatistics {
              team { ... on DiscoverTeam { id name } }
              totalStatistics { count details { value } gameFormat }
            }
          }
        }
      }
      publicProfileTeams(profileID: $profileID) {
        id name
        logo { sizes { url dimensions { height width } } }
        organisation { id name }
        grade { id name }
        season { id name startDate endDate
          status { name value }
          competition { id name }
        }
      }
      tenantConfiguration {
        label
        statistics {
          enabled
          careerStatisticsMeta { value name shortName isDisplayable statisticType }
        }
      }
    }`,
  },

  {
    name: '03-profile-search',
    desc: 'Search players by name',
    auth: true,
    op:   'ProfileSearch',
    vars: { fullName: 'smith' },
    query: `query ProfileSearch($fullName: String!) {
      profileSearch(fullName: $fullName) {
        result { id firstName lastName }
      }
    }`,
  },

  {
    name: '04-discover-team',
    desc: 'Team details and roster',
    auth: true,
    op:   'DiscoverTeam',
    vars: { gradeID: TEST_GRADE },
    query: `query DiscoverTeam($gradeID: ID!) {
      discoverGrade(gradeID: $gradeID) {
        id name
        teams {
          id name
          logo { sizes { url dimensions { height width } } }
          players {
            profile { id firstName lastName }
            statistics { count details { value } }
          }
        }
      }
    }`,
  },

  {
    name: '05-grade-ladder',
    desc: 'Ladder/standings for a grade',
    auth: true,
    op:   'GradeLadder',
    vars: { gradeID: TEST_GRADE },
    query: `query GradeLadder($gradeID: ID!) {
      discoverGrade(gradeID: $gradeID) {
        id name
        ladder {
          position
          team { id name }
          played won lost drawn
          pointsFor pointsAgainst pointsDifference
          points
          percentage
        }
      }
    }`,
  },

  {
    name: '06-team-roster-authenticated',
    desc: 'Team roster with full player list',
    auth: true,
    op:   'TeamRoster',
    vars: { gradeID: TEST_GRADE },
    query: `query TeamRoster($gradeID: ID!, $filter: GradePlayerStatisticsFilter) {
      gradePlayerStatistics(gradeID: $gradeID, filter: $filter) {
        meta { page totalPages totalRecords }
        results {
          profile { id firstName lastName }
          team { name }
          statistics { count details { value } }
        }
      }
    }`,
    vars: { gradeID: TEST_GRADE, filter: { sort: [{ column: 'APPEARANCE', direction: 'DESC' }], pagination: { page: 1, limit: 10 } } },
  },

  {
    name: '07-profile-highlights',
    desc: 'Player highlights/achievements',
    auth: true,
    op:   'ProfileHighlights',
    vars: { profileID: TEST_PROFILE },
    query: `query ProfileHighlights($profileID: ID!) {
      publicProfile(profileID: $profileID) {
        id firstName lastName
        highlights(input: { limit: 10 }) {
          nodes {
            id __typename
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`,
  },

  {
    name: '08-discover-milestones',
    desc: 'Player milestones / game count',
    auth: true,
    op:   'DiscoverMilestones',
    vars: { profileID: TEST_PROFILE },
    query: `query DiscoverMilestones($profileID: ID!) {
      discoverMilestones(input: { profileID: $profileID }) {
        gameCount
      }
    }`,
  },

  {
    name: '09-public-profile-teams',
    desc: 'Teams the player is currently registered with',
    auth: true,
    op:   'PublicProfileTeams',
    vars: { profileID: TEST_PROFILE },
    query: `query PublicProfileTeams($profileID: ID!) {
      publicProfileTeams(profileID: $profileID) {
        id name
        logo { sizes { url dimensions { height width } } }
        organisation { id name }
        grade { id name }
        season {
          id name startDate endDate
          status { name value }
          competition { id name organisation { id name } }
        }
      }
    }`,
  },

  {
    name: '10-tenant-configuration',
    desc: 'Tenant stat metadata — what stats are available and displayable',
    auth: true,
    op:   'TenantConfiguration',
    vars: {},
    query: `query TenantConfiguration {
      tenantConfiguration {
        label
        statistics {
          enabled
          careerStatisticsMeta {
            value name shortName isDisplayable statisticType
          }
        }
      }
    }`,
  },

  {
    name: '11-game-stats-by-game',
    desc: 'Per-game stats using real game ID — field is statistics not playerStatistics',
    auth: true,
    op:   'GameStats',
    vars: { gameID: '5c44eb0f' }, // real game ID from Eddie Pels profile
    query: `query GameStats($gameID: ID!) {
      discoverGame(gameID: $gameID) {
        id
        round { name }
        date
        home { ... on DiscoverTeam { id name } }
        away { ... on DiscoverTeam { id name } }
        result {
          home { statistics { count type { value } } }
          away { statistics { count type { value } } }
        }
        statistics {
          __typename
          entries {
            __typename
          }
        }
      }
    }`,
  },

  {
    name: '11b-ladder-pool-introspect',
    desc: 'Introspect LadderPool type to find correct field names',
    auth: true,
    op:   'GradeLadder',
    vars: { gradeID: TEST_GRADE },
    query: `query GradeLadder($gradeID: ID!) {
      discoverGrade(gradeID: $gradeID) {
        id name
        ladder {
          pool {
            __typename
            entries {
              __typename
            }
          }
        }
      }
    }`,
  },

  {
    name: '11c-profile-search-fullname',
    desc: 'Profile search with first and last name',
    auth: true,
    op:   'ProfileSearch',
    vars: { fullName: 'eddie pels' },
    query: `query ProfileSearch($fullName: String!) {
      profileSearch(fullName: $fullName) {
        result { id firstName lastName }
      }
    }`,
  },

  {
    name: '11d-foul-breakdown',
    desc: 'Test if personal/technical/unsportsmanlike fouls are in gameStatistics',
    auth: true,
    op:   'publicProfileStatistics',
    vars: { profileID: TEST_PROFILE },
    query: `query publicProfileStatistics($profileID: ID!) {
      publicProfileStatistics(profileID: $profileID) {
        seasonStatistics {
          name
          statistics {
            season { id name }
            teamStatistics {
              team { ... on DiscoverTeam { id name } }
              gradeStatistics {
                grade { id name }
                gameStatistics {
                  game { id date round { name } }
                  statistics { count details { value } }
                }
              }
            }
          }
        }
      }
    }`,
  },

  {
    name: '12-season-standings',
    desc: 'Season-level standings across all grades',
    auth: true,
    op:   'SeasonStandings',
    vars: { seasonID: TEST_SEASON },
    query: `query SeasonStandings($seasonID: String!) {
      discoverSeason(seasonID: $seasonID) {
        id name
        grades {
          id name
          ladder {
            position
            team { id name }
            played won lost drawn points percentage
          }
        }
      }
    }`,
  },

  {
    name: '13-organisation-seasons',
    desc: 'All seasons for an organisation',
    auth: true,
    op:   'OrganisationSeasons',
    vars: { orgID: '87b2f13c' }, // MEBA org ID
    query: `query OrganisationSeasons($orgID: ID!) {
      discoverOrganisation(organisationID: $orgID) {
        id name
        seasons {
          id name
          competition { id name }
          status { value }
          startDate endDate
        }
      }
    }`,
  },

];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 PlayHQ API Explorer`);
  console.log(`   Tenant:  ${TENANT} (${TENANT_FULL})`);
  console.log(`   Profile: ${TEST_PROFILE}`);
  console.log(`   Output:  explore-results/\n`);

  let cookie = null;

  const results = [];

  for (const test of TESTS) {
    console.log(`\n[${test.name}] ${test.desc}`);

    if (test.auth && !cookie) {
      try {
        cookie = await getSession();
      } catch (e) {
        console.log(`  ❌ Could not get session cookie: ${e.message}`);
      }
    }

    try {
      const data = await gql(test.op, test.query, test.vars, test.auth ? cookie : null);
      const summary = summarise(data);
      console.log(`  ${summary}`);
      save(test.name, data);
      results.push({ test: test.name, desc: test.desc, auth: test.auth, status: summary });
    } catch (e) {
      console.log(`  ❌ Error: ${e.message}`);
      results.push({ test: test.name, desc: test.desc, auth: test.auth, status: `❌ ${e.message}` });
    }
  }

  // Summary table
  console.log('\n\n═══════════════════════════════════════════════════════');
  console.log('RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════════');
  for (const r of results) {
    const auth = r.auth ? '🔐' : '🔓';
    console.log(`${auth} ${r.test}: ${r.status}`);
  }
  console.log('\nFull results in explore-results/ directory');
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
