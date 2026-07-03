// scripts/test-api.js
//
// Consolidated API test tool. Replaces:
//   test-grade-concurrency.js, test-profile-query.js, test-discover-game.js,
//   test-schema-fields.js, test-gps-count.js
//
// Modes:
//   node scripts/test-api.js concurrency             — test discoverGrade concurrency ceiling
//   node scripts/test-api.js profile  <uuid>         — test publicProfileStatistics for a UUID
//   node scripts/test-api.js game     <gameId>       — call discoverGame for a game ID
//   node scripts/test-api.js schema   [--grade=ID] [--season=ID]  — probe schema fields
//   node scripts/test-api.js gps      <gradeId>      — fetch gradePlayerStatistics for a grade
//   node scripts/test-api.js fixture  --grade=<id> [--round=<id>]  — reproduce nightly-crawl Phase 2 discoverFixtureByRound path

'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MODE = process.argv[2];
const ARG  = process.argv[3];

if (!MODE || !['concurrency', 'profile', 'game', 'schema', 'gps', 'fixture'].includes(MODE)) {
  console.error([
    'Usage:',
    '  node scripts/test-api.js concurrency              — test discoverGrade concurrency ceiling',
    '  node scripts/test-api.js profile  <uuid>          — test publicProfileStatistics for UUID',
    '  node scripts/test-api.js game     <gameId>        — call discoverGame for a game ID',
    '  node scripts/test-api.js schema   [--grade=ID] [--season=ID]  — probe schema fields',
    '  node scripts/test-api.js gps      <gradeId>       — gradePlayerStatistics for a grade',
    '  node scripts/test-api.js fixture  --grade=<id> [--round=<id>]  — reproduce nightly-crawl fixture path',
  ].join('\n'));
  process.exit(1);
}

// ─── shared headers ──────────────────────────────────────────────────────────

const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── session helpers ──────────────────────────────────────────────────────────

// Returns full cookie string (phq_tier; phq_session; phq_sub) using native fetch.
async function getSessionFetch() {
  const res = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({ operationName: 'TenantConfig', variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }' }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No Set-Cookie');
  const parts = raw.split(',').map(c => c.trim().split(';')[0].trim());
  const get   = n => parts.find(p => p.startsWith(n + '=')) || null;
  const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
  if (!tier || !session || !sub) throw new Error(`Incomplete cookies: ${parts.join(' | ')}`);
  return `${tier}; ${session}; ${sub}`;
}

// Returns full cookie string using https.request (for CJS modules that can't use top-level await).
function getSessionHttps() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ operationName: 'TenantConfig', variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }' });
    const req = https.request(
      { hostname: 'api.playhq.com', path: '/graphql', method: 'POST',
        headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'content-length': Buffer.byteLength(body) },
        agent: new https.Agent({ keepAlive: false }) },
      res => {
        const raw = res.headers['set-cookie'];
        if (!raw) { reject(new Error('No cookie')); return; }
        const parts = (Array.isArray(raw) ? raw.join(', ') : raw).split(',').map(c => c.trim().split(';')[0]);
        const get   = n => parts.find(p => p.startsWith(n + '=')) || null;
        const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
        if (!tier || !session || !sub) { reject(new Error(`Incomplete cookies: ${parts.join(' | ')}`)); return; }
        resolve(`${tier}; ${session}; ${sub}`);
        res.resume();
      }
    );
    req.on('error', reject); req.write(body); req.end();
  });
}

// https.request-based GQL call (for concurrency/schema/gps modes that need CJS)
function gqlHttps(body, cookie) {
  return new Promise((resolve, reject) => {
    const s = JSON.stringify(body);
    const h = { ...HEADERS, 'request-id': crypto.randomUUID(), 'content-length': Buffer.byteLength(s) };
    if (cookie) h['Cookie'] = cookie;
    const req = https.request(
      { hostname: 'api.playhq.com', path: '/graphql', method: 'POST',
        headers: h, agent: new https.Agent({ keepAlive: false }) },
      res => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(c).toString()) }); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject); req.write(s); req.end();
  });
}

// ─── MODE: concurrency ────────────────────────────────────────────────────────
// Tests discoverGrade concurrency ceiling by doubling until failures appear.

async function modeConcurrency() {
  console.log('test-api.js — concurrency mode');
  console.log('─'.repeat(60));

  const index    = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sports-index.json'), 'utf8'));
  const gradeIds = [];
  for (const season of Object.values(index.seasons || {})) {
    if (season.locked) continue;
    for (const grade of (season.grades || [])) {
      if (grade.id) gradeIds.push(grade.id);
    }
  }
  console.log(`  ${gradeIds.length} active grade IDs\n`);

  for (let i = gradeIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [gradeIds[i], gradeIds[j]] = [gradeIds[j], gradeIds[i]];
  }

  console.log('  Fetching session...');
  const cookie = await getSessionHttps();
  console.log('  Session OK\n');

  console.log('  Concurrency test — doubling on success, midpoint backoff on failure');
  console.log(`  ${'Concurrency'.padEnd(14)} ${'Failures'.padEnd(10)} ${'Avg ms'.padEnd(10)} Result`);
  console.log('  ' + '─'.repeat(50));

  const Q = { operationName: 'DiscoverGrade',
    query: `query DiscoverGrade($gradeID: ID!) { discoverGrade(gradeID: $gradeID) { id name rounds { id name } } }` };

  async function callGrade(gradeId) {
    const start = Date.now();
    try {
      const { status } = await gqlHttps({ ...Q, variables: { gradeID: gradeId } }, cookie);
      return { status, elapsed: Date.now() - start };
    } catch (e) {
      return { status: 'rejected', elapsed: Date.now() - start };
    }
  }

  let concurrency = 1, lastGood = 1, idx = 0;

  while (concurrency <= 1000) {
    const batch = Array.from({ length: concurrency }, (_, i) => gradeIds[(idx + i) % gradeIds.length]);
    idx = (idx + concurrency) % gradeIds.length;

    const results  = await Promise.allSettled(batch.map(id => callGrade(id)));
    const statuses = results.map(r => r.status === 'fulfilled' ? r.value.status : 'rejected');
    const elapsed  = results.filter(r => r.status === 'fulfilled').map(r => r.value.elapsed);
    const avgMs    = elapsed.length ? Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length) : 0;
    const failures = statuses.filter(s => s !== 200).length;
    const success  = failures === 0;

    console.log(`  ${String(concurrency).padEnd(14)} ${String(failures).padEnd(10)} ${String(avgMs + 'ms').padEnd(10)} ` +
      (success ? '✓' : `✗ (${[...new Set(statuses.filter(s => s !== 200))].join(', ')})`));

    if (success) {
      lastGood = concurrency;
      const next = Math.min(Math.round(concurrency * 2), 1000);
      if (next === concurrency) break;
      concurrency = next;
    } else {
      const next = Math.round(lastGood + (concurrency - lastGood) * 0.5);
      if (next <= lastGood || next === concurrency) {
        console.log(`\n  ✓ Settled: safe concurrency = ${lastGood}`);
        break;
      }
      concurrency = next;
    }

    await sleep(500);
  }

  if (concurrency > 1000) console.log(`\n  ✓ No failures up to 1000`);
  console.log('─'.repeat(60));
}

// ─── MODE: profile ────────────────────────────────────────────────────────────
// Tests publicProfileStatistics for a UUID using two query variants.

async function modeProfile(uuid) {
  if (!uuid) { console.error('Usage: node scripts/test-api.js profile <uuid>'); process.exit(1); }

  console.log(`\nTesting UUID: ${uuid}\n`);
  const cookie = await getSessionFetch();
  console.log('Session obtained\n');

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

  async function test(label, query, variables) {
    const res  = await fetch('https://api.playhq.com/graphql', {
      method: 'POST',
      headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
      body: JSON.stringify({ operationName: label, variables, query }),
    });
    const json = await res.json();
    const pps  = json?.data?.publicProfileStatistics;
    console.log(`[${label}] HTTP ${res.status}`);
    console.log(`  publicProfileStatistics: ${pps === null ? 'NULL' : pps === undefined ? 'UNDEFINED' : 'PRESENT'}`);
    if (pps) console.log(`  seasonStatistics entries: ${pps.seasonStatistics?.length ?? 'N/A'}`);
    if (json.errors) console.log(`  errors: ${json.errors[0]?.message}`);
  }

  await test('REF_QUERY',     Q_REF,     { profileID: uuid });
  await test('CURRENT_QUERY', Q_CURRENT, { id: uuid });
}

// ─── MODE: game ───────────────────────────────────────────────────────────────
// Calls discoverGame for a game ID and shows key fields.

async function modeGame(gameId) {
  if (!gameId) { console.error('Usage: node scripts/test-api.js game <gameId>'); process.exit(1); }

  console.log(`\nQuerying discoverGame for: ${gameId}\n`);
  const cookie = await getSessionFetch();
  console.log('Session obtained\n');

  const Q = `query discoverGame($gameID: ID!) {
    discoverGame(gameID: $gameID) {
      id
      status { value }
      forfeit { isForfeit winnerID notes }
      abandoned { isAbandoned notes }
      home { ... on DiscoverTeam { id name } }
      away { ... on DiscoverTeam { id name } }
      result {
        home { statistics { count type { value } } gameOutcomeDescription }
        away { statistics { count type { value } } gameOutcomeDescription }
      }
      round { name number isFinalsRound }
      date
    }
  }`;

  const res  = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
    body: JSON.stringify({ operationName: 'discoverGame', variables: { gameID: gameId }, query: Q }),
  });
  const json = await res.json();

  if (json.errors) {
    console.log('GraphQL errors:', JSON.stringify(json.errors, null, 2));
    return;
  }

  const g = json.data?.discoverGame;
  if (!g) { console.log('discoverGame returned null — game may be hidden or inaccessible'); return; }

  console.log(JSON.stringify(g, null, 2));
  console.log('\n── Key fields ──');
  console.log(`  status:    ${g.status?.value}`);
  console.log(`  forfeit:   ${JSON.stringify(g.forfeit)}`);
  console.log(`  abandoned: ${JSON.stringify(g.abandoned)}`);
  const homeScore = g.result?.home?.statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count;
  const awayScore = g.result?.away?.statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count;
  console.log(`  score:     ${homeScore ?? '?'} – ${awayScore ?? '?'}`);
  console.log(`  home: ${g.result?.home?.gameOutcomeDescription}`);
  console.log(`  away: ${g.result?.away?.gameOutcomeDescription}`);
}

// ─── MODE: schema ─────────────────────────────────────────────────────────────
// Probes schema fields on gradePlayerStatistics and seasonRegistrations.

async function modeSchema() {
  const args     = Object.fromEntries(
    process.argv.slice(3)
      .filter(a => a.startsWith('--'))
      .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
  );
  const GRADE_ID  = args.gradeId  || args.gradeid  || args.grade;
  const SEASON_ID = args.seasonId || args.seasonid || args.season;

  if (!GRADE_ID && !SEASON_ID) {
    console.error('Usage: node scripts/test-api.js schema [--grade=ID] [--season=ID]');
    process.exit(1);
  }

  console.log('test-api.js — schema probe\n');
  const cookie = await getSessionHttps();
  console.log('Session obtained\n');

  async function probe(label, query, variables) {
    await sleep(400);
    try {
      const { data } = await gqlHttps({ operationName: 'T', variables, query }, cookie);
      if (data.errors) {
        console.log(`  ❌ ${label.padEnd(70)} ${data.errors[0]?.message?.slice(0, 100)}`);
        return;
      }
      console.log(`  ✅ ${label.padEnd(70)} ${JSON.stringify(data.data)?.slice(0, 300)}`);
    } catch (e) {
      console.log(`  ❌ ${label.padEnd(70)} ${e.message?.slice(0, 80)}`);
    }
  }

  if (GRADE_ID) {
    console.log(`━━━ GradePlayerStatisticsResult fields  (gradeId: ${GRADE_ID}) ━━━\n`);
    const resultFields = ['profile { id firstName lastName }', 'team { id name }',
      'totalStatistics { count details { value } }', 'statistics { count details { value } }',
      'id', 'rank', 'position', 'points', 'gamesPlayed', 'firstName lastName', 'name', '__typename'];
    for (const f of resultFields) {
      await probe(`results { ${f.split(' ')[0]} }`,
        `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { results { ${f} } } }`,
        { id: GRADE_ID });
    }
    console.log('\n  ── meta fields ──\n');
    await probe('meta { totalPages totalRecords }',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { meta { totalPages totalRecords } } }`,
      { id: GRADE_ID });
    await probe('meta { totalPages totalRecords page hasMore }',
      `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) { meta { totalPages totalRecords page hasMore } } }`,
      { id: GRADE_ID });
    console.log('\n  ── pagination args ──\n');
    for (const p of ['page: 1', 'page: 2', 'pageSize: 10', 'pageNumber: 1']) {
      await probe(`gradePlayerStatistics(gradeID, ${p})`,
        `query T($id: ID!) { gradePlayerStatistics(gradeID: $id, ${p}) { meta { totalPages totalRecords } results { __typename } } }`,
        { id: GRADE_ID });
    }
  }

  if (SEASON_ID) {
    console.log(`\n━━━ seasonRegistrations fields  (seasonId: ${SEASON_ID}) ━━━\n`);
    const probes = [
      ['seasonRegistrations { id ageRestriction }',
       `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id ageRestriction } }`],
      ['seasonRegistrations { id ageRestriction { from to } }',
       `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id ageRestriction { from to } } }`],
      ['seasonRegistrations { id organisation { id name type } }',
       `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id organisation { id name type } } }`],
      ['seasonRegistrations { id teams { id name } }',
       `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id teams { id name } } }`],
      ['seasonRegistrations { id team { id name } }',
       `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id team { id name } } }`],
      ['seasonRegistrations count',
       `query T($id: ID!) { seasonRegistrations(seasonID: $id) { id } }`],
    ];
    for (const [label, query] of probes) {
      await probe(label, query, { id: SEASON_ID });
    }
  }

  console.log('\nDone.');
}

// ─── MODE: gps ────────────────────────────────────────────────────────────────
// Fetch gradePlayerStatistics for a grade and print all results.

async function modeGps(gradeId) {
  if (!gradeId) { console.error('Usage: node scripts/test-api.js gps <gradeId>'); process.exit(1); }

  const cookie = await getSessionHttps();

  const { data } = await gqlHttps({
    operationName: 'T',
    variables: { id: gradeId },
    query: `query T($id: ID!) { gradePlayerStatistics(gradeID: $id) {
      meta { totalPages totalRecords page }
      results {
        profile { id firstName lastName }
        team { id name }
        statistics { count details { value } }
      }
    } }`,
  }, cookie);

  if (data.errors) { console.error('Error:', data.errors[0].message); process.exit(1); }

  const gps = data.data.gradePlayerStatistics;
  console.log(`totalRecords: ${gps.meta.totalRecords}  totalPages: ${gps.meta.totalPages}  page: ${gps.meta.page}`);
  console.log(`returned: ${gps.results.length}\n`);

  gps.results.forEach((r, i) => {
    const pts = r.statistics?.find(s => s.details?.value === 'TOTAL_SCORE')?.count ?? 0;
    const gp  = r.statistics?.find(s => s.details?.value === 'APPEARANCE')?.count ?? 0;
    const fo  = r.statistics?.find(s => s.details?.value === 'TOTAL_FOULS')?.count ?? 0;
    const tp  = r.statistics?.find(s => s.details?.value === '3_POINT_SCORE')?.count ?? 0;
    const name = `${r.profile.firstName} ${r.profile.lastName}`;
    console.log(`  ${String(i+1).padStart(3)}. ${r.profile.id}  ${name.padEnd(25)}  team: ${(r.team?.name || '').padEnd(30)}  gp:${gp}  pts:${pts}  3pt:${tp}  fouls:${fo}`);
  });
}

// ─── MODE: fixture ──────────────────────────────────────────────────────────────
// Reproduces nightly-crawl.js Phase 2 EXACTLY: discoverGrade -> current round ->
// discoverFixtureByRound with the VERBATIM crawl query. Surfaces the raw `errors`
// array (which the crawl's gqlMain discards at `if (body.errors) return null`) and
// prints the shape of games[0], so we can see whether home/away still resolve to
// DiscoverTeam with a non-null season.id.
//
//   node scripts/test-api.js fixture --grade=<gradeId> [--round=<roundId>]

// Verbatim from scripts/nightly-crawl.js Q_GRADE_ROUNDS
const Q_GRADE_ROUNDS_PROBE = `query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id name hideScores
    rounds { id name abbreviatedName current number isFinalsRound }
    season { id competition { id organisation { id name } } }
  }
}`;

// Verbatim from scripts/nightly-crawl.js Q_FIXTURE_BY_ROUND
const Q_FIXTURE_BY_ROUND_PROBE = `query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    byes {
      id name __typename
      organisation { id name }
    }
    games {
      id date dates __typename
      status { value }
      home {
        __typename
        ... on DiscoverTeam { id name organisation { id name } season { id } }
        ... on ProvisionalTeam { name }
      }
      away {
        __typename
        ... on DiscoverTeam { id name organisation { id name } season { id } }
        ... on ProvisionalTeam { name }
      }
      result {
        outcome { name value }
        winner  { name value }
        home {
          outcome { name value }
          statistics { count type { value } }
          gameOutcomeDescription
        }
        away {
          outcome { name value }
          statistics { count type { value } }
        }
      }
      allocation {
        time
        dateTimeList { date time }
        court {
          id name abbreviatedName
          venue { id name abbreviatedName latitude longitude
                  address suburb state postcode country }
        }
      }
    }
  }
}`;

// Minimal query — only the fields the crawl needs to write a game and resolve sides.
// If the full query errors but this succeeds, the break is a specific removed/renamed
// field inside the full query, NOT the fixture path itself.
const Q_FIXTURE_MINIMAL = `query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      id __typename
      status { value }
      home { __typename ... on DiscoverTeam { id name season { id } } ... on ProvisionalTeam { name } }
      away { __typename ... on DiscoverTeam { id name season { id } } ... on ProvisionalTeam { name } }
      result { home { statistics { count type { value } } } away { statistics { count type { value } } } }
    }
  }
}`;

function dumpFirstGames(games) {
  if (!Array.isArray(games) || games.length === 0) { console.log('  (no games to inspect)'); return; }
  games.slice(0, 2).forEach((g, i) => {
    const hSeason = g.home?.season?.id ?? '(none)';
    const aSeason = g.away?.season?.id ?? '(none)';
    console.log(`  game[${i}] id=${g.id} status=${g.status?.value}`);
    console.log(`    home.__typename=${g.home?.__typename}  home.season.id=${hSeason}`);
    console.log(`    away.__typename=${g.away?.__typename}  away.season.id=${aSeason}`);
    console.log(`    raw home: ${JSON.stringify(g.home)}`);
    console.log(`    raw away: ${JSON.stringify(g.away)}`);
  });
}

async function modeFixture() {
  const args = Object.fromEntries(
    process.argv.slice(3)
      .filter(a => a.startsWith('--'))
      .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
  );
  const GRADE_ID = args.gradeId || args.gradeid || args.grade;
  let   ROUND_ID = args.roundId || args.roundid || args.round || null;

  if (!GRADE_ID && !ROUND_ID) {
    console.error('Usage: node scripts/test-api.js fixture --grade=<gradeId> [--round=<roundId>]');
    process.exit(1);
  }

  console.log('test-api.js — fixture probe\n');
  const cookie = await getSessionHttps();
  console.log('Session obtained\n');

  // Step 1: resolve a round to probe (mirrors nightly-crawl Phase 2 selection)
  if (!ROUND_ID) {
    const { status, data } = await gqlHttps(
      { operationName: 'gradeRounds', variables: { gradeID: GRADE_ID }, query: Q_GRADE_ROUNDS_PROBE },
      cookie
    );
    console.log(`discoverGrade — HTTP ${status}`);
    if (data.errors) {
      console.log('  discoverGrade errors:', JSON.stringify(data.errors, null, 2));
      process.exit(1);
    }
    const g = data.data && data.data.discoverGrade;
    if (!g) { console.log('  discoverGrade returned null — bad grade ID or hidden grade.'); process.exit(1); }
    console.log(`  grade: ${g.name}  hideScores: ${g.hideScores}  rounds: ${(g.rounds || []).length}`);
    const rounds = g.rounds || [];
    const current = rounds.find(r => r.current)
                 || [...rounds].sort((a, b) => (b.number || 0) - (a.number || 0))[0];
    if (!current) { console.log('  No rounds on this grade.'); process.exit(1); }
    ROUND_ID = current.id;
    console.log(`  chosen round: "${current.name}" (number ${current.number}, current=${!!current.current})  id=${ROUND_ID}\n`);
  }

  // Step 2: full verbatim crawl query
  console.log('=== discoverFixtureByRound — FULL crawl query (verbatim) ===');
  const full = await gqlHttps(
    { operationName: 'discoverFixtureByRound', variables: { roundID: ROUND_ID }, query: Q_FIXTURE_BY_ROUND_PROBE },
    cookie
  );
  console.log(`HTTP ${full.status}`);
  if (full.data.errors) {
    console.log('TOP-LEVEL errors (this is exactly what nightly-crawl gqlMain discards at line 153):');
    console.log(JSON.stringify(full.data.errors, null, 2));
  } else {
    console.log('no errors array');
  }
  const fullGames = (full.data.data && full.data.data.discoverFixtureByRound && full.data.data.discoverFixtureByRound.games) || null;
  console.log(`games returned: ${fullGames ? fullGames.length : 'null (discoverFixtureByRound null)'}`);
  dumpFirstGames(fullGames);

  // Step 3: minimal query — only if the full query errored or returned null
  if (full.data.errors || !fullGames) {
    console.log('\n=== discoverFixtureByRound — MINIMAL query (isolates field-level break) ===');
    const min = await gqlHttps(
      { operationName: 'discoverFixtureByRound', variables: { roundID: ROUND_ID }, query: Q_FIXTURE_MINIMAL },
      cookie
    );
    console.log(`HTTP ${min.status}`);
    if (min.data.errors) {
      console.log('minimal query ALSO errors:');
      console.log(JSON.stringify(min.data.errors, null, 2));
    } else {
      console.log('minimal query has NO errors — the break is a specific field in the FULL query above');
    }
    const minGames = (min.data.data && min.data.data.discoverFixtureByRound && min.data.data.discoverFixtureByRound.games) || null;
    console.log(`games returned: ${minGames ? minGames.length : 'null'}`);
    dumpFirstGames(minGames);
  }

  console.log('\nDone.');
}

// ─── dispatch ─────────────────────────────────────────────────────────────────

(async () => {
  switch (MODE) {
    case 'concurrency': await modeConcurrency(); break;
    case 'profile':     await modeProfile(ARG);  break;
    case 'game':        await modeGame(ARG);      break;
    case 'schema':      await modeSchema();       break;
    case 'gps':         await modeGps(ARG);       break;
    case 'fixture':     await modeFixture();      break;
  }
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
