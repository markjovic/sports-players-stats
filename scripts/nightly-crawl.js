// scripts/nightly-crawl.js
// Nightly active-season update:
//   Phase 1 — discoverGrade(gradeRounds) for all active grades → round IDs
//   Phase 1b — Detect grades that became hidden; reclassify their game entries
//   Phase 2 — discoverFixtureByRound for current + N previous rounds
//             Commits game files every COMMIT_EVERY seasons
//   Phase 3 — Spectator game(id) for FINAL games without spc flag
//             Commits player files every COMMIT_EVERY_PLAYERS
//   Phase 4 — Stub new players not yet in the index
//
// Usage:
//   node scripts/nightly-crawl.js                   # active seasons, 2 rounds back
//   node scripts/nightly-crawl.js --rounds-back=14  # backfill ~3 weeks
//   node scripts/nightly-crawl.js --season=<id>     # single season
//   node scripts/nightly-crawl.js --dry-run         # no writes or commits

'use strict';

const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

// ─── Constants ────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const DRY_RUN       = !!ARGS['dry-run'];
const TARGET_SEASON = ARGS.season || null;
const ROUNDS_BACK   = Math.max(1, parseInt(ARGS['rounds-back'] || '2', 10));

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const GAMES_DIR     = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR   = path.join(ROOT, 'players');
const INDEX_DIR     = path.join(ROOT, 'players', 'indexes');
const INDEX_FILE    = path.join(ROOT, 'sports-index.json');
const STATUS_FILE   = path.join(ROOT, '.nightly-status.json');

const CONCURRENCY_GRADES    = 8;
const CONCURRENCY_FIXTURES  = 8;
const CONCURRENCY_SPECTATOR = 3;
const COMMIT_EVERY          = 50;  // commit game files every N seasons
const COMMIT_EVERY_PLAYERS  = 200; // commit player files every N players updated

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function doFetch(url, bodyObj, headers) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify(bodyObj);
    const parsed = new URL(url);
    const h      = { ...headers, 'request-id': crypto.randomUUID(),
                     'content-length': Buffer.byteLength(body) };
    const req    = https.request(
      { hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
        headers: h, agent: new https.Agent({ keepAlive: false }) },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({
              status:     res.statusCode,
              rawCookies: res.headers['set-cookie'],
              body:       JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Session ──────────────────────────────────────────────────────────────────

const HEADERS_MAIN = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};
const HEADERS_SPECTATOR = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'bv', 'x-phq-tenant': 'bv', 'content-type': 'application/json',
};

let sessionCookie = null;

async function refreshSession() {
  const body = { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const { rawCookies } = await doFetch(API_URL, body, HEADERS_MAIN);
      if (!rawCookies) continue;
      const arr = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
        .map(c => c.split(';')[0].trim());
      const get = n => arr.find(p => p.startsWith(n + '=')) || null;
      const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
      if (tier && session && sub) {
        sessionCookie = `${tier}; ${session}; ${sub}`;
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    } catch (_) {}
  }
  throw new Error('Failed to obtain session after 10 attempts');
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

async function gqlMain(operationName, query, variables) {
  if (!sessionCookie) await refreshSession();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { status, body } = await doFetch(
        API_URL, { operationName, variables, query },
        { ...HEADERS_MAIN, 'Cookie': sessionCookie }
      );
      if (status === 429) { await sleep(15000); continue; }
      if (status !== 200) { if (attempt < 3) { await sleep(3000); continue; } return null; }
      if (body.errors) return null;
      return body.data;
    } catch (_) {
      if (attempt < 3) await sleep(2000);
    }
  }
  return null;
}

async function gqlSpectator(gameId) {
  if (!sessionCookie) await refreshSession();
  const query = `query game($id: ID!) {
    game(id: $id) {
      id status
      statistics {
        home { players { profileID name playerNumber statistics { type { value } count } } }
        away { players { profileID name playerNumber statistics { type { value } count } } }
      }
    }
  }`;
  try {
    const { status, body } = await doFetch(
      SPECTATOR_URL,
      { operationName: 'game', variables: { id: gameId }, query },
      { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
    );
    if (status === 403) {
      // Single refresh then retry — do not loop
      await refreshSession();
      const retry = await doFetch(
        SPECTATOR_URL,
        { operationName: 'game', variables: { id: gameId }, query },
        { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
      );
      if (retry.status !== 200 || retry.body.errors) return null;
      return retry.body.data?.game || null;
    }
    if (status !== 200 || body.errors) return null;
    return body.data?.game || null;
  } catch (_) { return null; }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const Q_GRADE_ROUNDS = `query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id name hideScores
    rounds { id name abbreviatedName current number isFinalsRound }
    season { id competition { id organisation { id name } } }
  }
}`;

// __typename is requested explicitly on inline fragments to ensure reliable
// type discrimination in the response, regardless of server defaults.
const Q_FIXTURE_BY_ROUND = `query discoverFixtureByRound($roundID: ID!) {
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
        home { statistics { count type { value } } gameOutcomeDescription }
        away { statistics { count type { value } } }
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

// ─── Stat helpers ─────────────────────────────────────────────────────────────

function parseScore(statistics) {
  if (!Array.isArray(statistics)) return null;
  const s = statistics.find(x => x.type?.value === 'TOTAL_SCORE');
  return s ? (s.count ?? null) : null;
}

function spectatorStatValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const s = statistics.find(x => x.type?.value === typeValue);
  return s ? (s.count || 0) : 0;
}

function parseSpectatorPlayers(players) {
  if (!Array.isArray(players)) return [];
  return players
    .filter(p => p && p.profileID)
    .map(p => ({
      profileID: p.profileID,
      name:      p.name  || null,
      number:    p.playerNumber ?? null,
      pts:       spectatorStatValue(p.statistics, 'TOTAL_SCORE'),
      pt1:       spectatorStatValue(p.statistics, '1_POINT_SCORE'),
      pt2:       spectatorStatValue(p.statistics, '2_POINT_SCORE'),
      pt3:       spectatorStatValue(p.statistics, '3_POINT_SCORE'),
      fouls:     spectatorStatValue(p.statistics, 'TOTAL_FOULS'),
    }));
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function runPool(tasks, concurrency) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) { await tasks[i++](); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// ─── Git commit ───────────────────────────────────────────────────────────────

// commitLock prevents concurrent tasks from triggering simultaneous commits
let commitLock = false;

async function gitCommit(message) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  try { execSync('git add -A', { stdio: 'pipe', cwd: ROOT }); } catch (_) {}
  const staged = (() => {
    try { return execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim(); }
    catch (_) { return ''; }
  })();
  if (!staged) { return; }  // nothing to commit — silent
  try { execSync(`git commit -m "${message.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT }); }
  catch (_) { return; }
  const MAX = 10;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      execSync('git fetch origin main',                    { stdio: 'pipe', cwd: ROOT });
      execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main',                   { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✓ Committed: ${message}`);
      return;
    } catch (_) {
      if (attempt === MAX) { console.error(`  Push failed after ${MAX} attempts`); return; }
      const jitter = Math.floor(Math.random() * 15000) + attempt * 3000;
      await sleep(jitter);
    }
  }
}

// Commit only if not already in progress — safe for concurrent callers
async function tryPeriodicCommit(message) {
  if (commitLock) return;
  commitLock = true;
  try {
    const n = flushGameFiles();
    if (n > 0) await gitCommit(message);
  } finally {
    commitLock = false;
  }
}

// ─── Game file cache ──────────────────────────────────────────────────────────

const gameCache = new Map();   // seasonId → { games: {} }
const gameDirty = new Set();   // seasonIds with pending writes

function loadGameFile(seasonId) {
  if (gameCache.has(seasonId)) return gameCache.get(seasonId);
  const file = path.join(GAMES_DIR, `${seasonId}.json`);
  let data = { games: {} };
  if (fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  }
  if (!data.games) data.games = {};
  gameCache.set(seasonId, data);
  return data;
}

function markGameDirty(seasonId) { gameDirty.add(seasonId); }

function flushGameFiles() {
  let count = 0;
  for (const seasonId of [...gameDirty]) {
    if (!gameCache.has(seasonId)) continue;
    const file = path.join(GAMES_DIR, `${seasonId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(gameCache.get(seasonId)));
    gameDirty.delete(seasonId);
    count++;
  }
  return count;
}

// ─── Player file helpers ──────────────────────────────────────────────────────

function playerShard(uuid)    { return uuid.slice(0, 2).toLowerCase(); }
function playerFilePath(uuid) { return path.join(PLAYERS_DIR, playerShard(uuid), `${uuid}.json`); }
function playerIndexPath(s)   { return path.join(INDEX_DIR, `${s}.json`); }

function readPlayer(uuid) {
  const file = playerFilePath(uuid);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writePlayer(uuid, data) {
  if (DRY_RUN) return;
  const file = playerFilePath(uuid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

function readPlayerIndex(shard) {
  const file = playerIndexPath(shard);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

function writePlayerIndex(shard, data) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(playerIndexPath(shard)), { recursive: true });
  fs.writeFileSync(playerIndexPath(shard), JSON.stringify(data));
}

// ─── Apply round fixtures to game cache ───────────────────────────────────────
//
// Returns: { needsSpectator: [{gameId, seasonId}], totalGames: N }
// needsSpectator = games that are FINAL and have no spc flag yet.
// This covers both newly-scored games AND games that went FINAL in a previous
// run that timed out before spectator processing completed.

function applyRoundFixtures(roundData, gradeId, gradeName, roundName) {
  const needsSpectator = [];
  if (!roundData?.discoverFixtureByRound) return { needsSpectator, totalGames: 0 };
  let totalGames = 0;

  for (const game of (roundData.discoverFixtureByRound.games || [])) {
    if (!game?.id) continue;
    totalGames++;

    const homeTeam = (game.home?.__typename === 'DiscoverTeam')     ? game.home : null;
    const awayTeam = (game.away?.__typename === 'DiscoverTeam')     ? game.away : null;
    const homeProv = (game.home?.__typename === 'ProvisionalTeam')  ? game.home : null;
    const awayProv = (game.away?.__typename === 'ProvisionalTeam')  ? game.away : null;

    // Season ID comes from team data — without it we can't write to the right file
    const seasonId = homeTeam?.season?.id || awayTeam?.season?.id || null;
    if (!seasonId) continue;

    const homeScore = parseScore(game.result?.home?.statistics);
    const awayScore = parseScore(game.result?.away?.statistics);
    const status    = game.status?.value || null;
    const court     = game.allocation?.court;
    const venue     = court?.venue;
    const dt        = game.allocation?.dateTimeList?.[0];
    // Use string slicing — never new Date() for time/date parsing
    const time = dt?.time ? dt.time.slice(0, 5)
               : (game.allocation?.time || '').slice(0, 5) || null;
    const date = dt?.date
               || (Array.isArray(game.dates) ? game.dates[0] : null)
               || game.date
               || null;

    const gf       = loadGameFile(seasonId);
    const existing = gf.games[game.id] || null;

    // Build entry — spread existing first, then overlay new values
    const entry = {
      ...(existing || {}),
      ...(date       ? { d:   date }        : {}),
      ...(roundName  ? { rn:  roundName }   : {}),
      gid: gradeId,
      gn:  gradeName,
      ...(homeTeam   ? { h: homeTeam.id, hn: homeTeam.name }
          : homeProv ? { hn: homeProv.name }
          : {}),
      ...(awayTeam   ? { a: awayTeam.id, an: awayTeam.name }
          : awayProv ? { an: awayProv.name }
          : {}),
      ...(homeScore !== null ? { hs: homeScore } : {}),
      ...(awayScore !== null ? { as: awayScore } : {}),
      ...(status     ? { st: status }  : {}),
      ...(venue?.id   ? { vid: venue.id }   : {}),
      ...(venue?.name ? { vn:  venue.name } : {}),
      ...(court?.name ? { ct:  court.name } : {}),
      ...(time        ? { t:   time }        : {}),
    };

    const changed = JSON.stringify(entry) !== JSON.stringify(existing || {});
    if (changed && !DRY_RUN) {
      gf.games[game.id] = entry;
      markGameDirty(seasonId);
    }

    // Queue for spectator if FINAL and not yet processed.
    // Covers both: games newly scored this run, and games that timed out
    // before spectator processing in a previous run.
    if (status === 'FINAL' && !existing?.spc) {
      needsSpectator.push({ gameId: game.id, seasonId });
    }
  }

  return { needsSpectator, totalGames };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log('nightly-crawl.js');
  console.log(`  rounds-back: ${ROUNDS_BACK}`);
  if (TARGET_SEASON) console.log(`  season:      ${TARGET_SEASON}`);
  if (DRY_RUN)       console.log('  ⚠  DRY RUN — no writes or commits');
  console.log('─'.repeat(50));

  if (!fs.existsSync(INDEX_FILE)) {
    console.error('sports-index.json not found'); process.exit(1);
  }
  const sportIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const allSeasons = Object.values(sportIndex.seasons || {});
  const seasons    = TARGET_SEASON
    ? allSeasons.filter(s => s.id === TARGET_SEASON)
    : allSeasons.filter(s => s.locked === false);

  console.log(`\nActive seasons: ${seasons.length}`);

  const gradeEntries = [];
  for (const season of seasons) {
    for (const grade of (season.grades || [])) {
      if (grade.id) gradeEntries.push({ gradeId: grade.id });
    }
  }
  console.log(`Active grades:  ${gradeEntries.length}\n`);

  await refreshSession();

  // ── Phase 1: Grade rounds ────────────────────────────────────────────────────
  console.log('Phase 1/4 — Grade rounds…');
  let p1Done = 0;
  const gradeRoundResults = [];

  const p1Tasks = gradeEntries.map(({ gradeId }) => async () => {
    const data = await gqlMain('gradeRounds', Q_GRADE_ROUNDS, { gradeID: gradeId });
    p1Done++;
    if (p1Done % 250 === 0 || p1Done === gradeEntries.length)
      process.stdout.write(`  ${p1Done}/${gradeEntries.length}\r`);
    if (!data?.discoverGrade) return;
    const g = data.discoverGrade;
    gradeRoundResults.push({
      gradeId:    g.id,
      gradeName:  g.name  || '',
      hideScores: !!g.hideScores,
      seasonId:   g.season?.id || null,
      rounds:     g.rounds || [],
    });
  });

  await runPool(p1Tasks, CONCURRENCY_GRADES);
  console.log(`  ${gradeEntries.length}/${gradeEntries.length} grades done`);

  const normalGrades = gradeRoundResults.filter(g => !g.hideScores);
  const hiddenCount  = gradeRoundResults.filter(g =>  g.hideScores).length;
  console.log(`  Normal: ${normalGrades.length}  Hidden (skipped): ${hiddenCount}\n`);

  // ── Phase 1b: Reclassify games for grades that became hidden ────────────────
  // When a grade's hideScores flips from false to true, its existing game entries
  // in the game file still have no hidden flag. Detect and reclassify them so the
  // nightly spectator queue picks them up for box score fetching.
  const hiddenGrades = gradeRoundResults.filter(g => g.hideScores && g.seasonId);
  let reclassified = 0;
  for (const grade of hiddenGrades) {
    const gf = loadGameFile(grade.seasonId);
    for (const [gameId, game] of Object.entries(gf.games || {})) {
      if (game.gid !== grade.gradeId) continue;
      if (game.hidden) continue;  // already classified
      // Grade is now hidden but game entry isn't marked — reclassify
      game.hidden = true;
      delete game.hs;  // remove scores (hidden games don't expose scores publicly)
      delete game.as;
      markGameDirty(grade.seasonId);
      reclassified++;
    }
  }
  if (reclassified > 0) {
    console.log(`  Reclassified ${reclassified} games as hidden (grade hideScores flipped)`);
    const n = flushGameFiles();
    if (n > 0) await gitCommit(`nightly-crawl: ${reclassified} games reclassified as hidden`);
  }
  console.log(`  Hidden grades checked: ${hiddenGrades.length}  Games reclassified: ${reclassified}\n`);

  // ── Phase 2: Fixture fetches ──────────────────────────────────────────────────
  console.log(`Phase 2/4 — Round fixtures (${ROUNDS_BACK} round(s) back)…`);

  // Build round queue: each grade contributes current round + up to ROUNDS_BACK-1 previous
  const roundQueue = [];
  for (const grade of normalGrades) {
    if (!grade.rounds.length) continue;
    const currentRound = grade.rounds.find(r => r.current);
    if (!currentRound) continue;

    roundQueue.push({ roundId: currentRound.id, roundName: currentRound.name, grade });

    // Previous rounds by descending round number
    const prevRounds = [...grade.rounds]
      .filter(r => r.number < currentRound.number)
      .sort((a, b) => b.number - a.number)
      .slice(0, ROUNDS_BACK - 1);

    for (const r of prevRounds) {
      roundQueue.push({ roundId: r.id, roundName: r.name, grade });
    }
  }
  console.log(`  Round fetches queued: ${roundQueue.length}`);

  let p2Done = 0;
  let seasonsSinceCommit = 0;
  const processedSeasons  = new Set();
  const allNeedsSpectator = [];  // { gameId, seasonId } — deduped after phase

  const p2Tasks = roundQueue.map(({ roundId, roundName, grade }) => async () => {
    const data = await gqlMain('discoverFixtureByRound', Q_FIXTURE_BY_ROUND, { roundID: roundId });
    const { needsSpectator, totalGames } = applyRoundFixtures(
      data, grade.gradeId, grade.gradeName, roundName
    );
    allNeedsSpectator.push(...needsSpectator);
    p2Done++;

    // Count seasons touched for periodic commit — track unique seasons per commit window
    for (const { seasonId } of needsSpectator) {
      if (!processedSeasons.has(seasonId)) {
        processedSeasons.add(seasonId);
        seasonsSinceCommit++;
      }
    }

    if (p2Done % 100 === 0 || p2Done === roundQueue.length)
      process.stdout.write(`  ${p2Done}/${roundQueue.length} rounds  queued-spectator: ${allNeedsSpectator.length}\r`);

    // Periodic commit — lock prevents concurrent tasks both committing
    if (seasonsSinceCommit >= COMMIT_EVERY) {
      seasonsSinceCommit = 0;  // reset immediately before await
      await tryPeriodicCommit(
        `nightly-crawl: game files (${allNeedsSpectator.length} games queued for spectator so far)`
      );
    }
  });

  await runPool(p2Tasks, CONCURRENCY_FIXTURES);
  console.log(`  ${roundQueue.length}/${roundQueue.length} rounds done`);

  // Deduplicate — same game may appear in current + previous round fetches
  const seenGameIds     = new Set();
  const needsSpectator  = allNeedsSpectator.filter(({ gameId }) => {
    if (seenGameIds.has(gameId)) return false;
    seenGameIds.add(gameId);
    return true;
  });

  console.log(`  Games needing spectator: ${needsSpectator.length}`);

  // Final Phase 2 flush
  const flushedGames = flushGameFiles();
  if (flushedGames > 0 || needsSpectator.length > 0) {
    await gitCommit(
      `nightly-crawl: ${needsSpectator.length} games queued, ${flushedGames} season files updated`
    );
  }
  console.log();

  // ── Phase 3: Spectator + player stat updates ──────────────────────────────────
  console.log(`Phase 3/4 — Spectator box scores (${needsSpectator.length} games)…`);

  // playerDeltas: Map<uuid, { name, deltas: [{seasonId, pts, pt3, fouls}] }>
  const playerDeltas = new Map();
  let spectatorHits = 0, spectatorMiss = 0, p3Done = 0;

  const p3Tasks = needsSpectator.map(({ gameId, seasonId }) => async () => {
    const game = await gqlSpectator(gameId);
    p3Done++;
    if (p3Done % 50 === 0 || p3Done === needsSpectator.length)
      process.stdout.write(`  ${p3Done}/${needsSpectator.length}  hits: ${spectatorHits}  misses: ${spectatorMiss}\r`);

    if (!game?.statistics) {
      spectatorMiss++;
      return;
    }
    spectatorHits++;

    const homePlayers = parseSpectatorPlayers(game.statistics?.home?.players);
    const awayPlayers = parseSpectatorPlayers(game.statistics?.away?.players);
    const allPlayers  = [...homePlayers, ...awayPlayers];

    // Collect player deltas for later batch processing
    for (const p of allPlayers) {
      if (!p.profileID) continue;
      if (!playerDeltas.has(p.profileID)) {
        playerDeltas.set(p.profileID, { name: p.name, deltas: [] });
      }
      playerDeltas.get(p.profileID).deltas.push({
        seasonId, gameKey: gameId, pts: p.pts, pt3: p.pt3, fouls: p.fouls,
      });
    }

    // Mark spc:1 and update p[] on the game entry — spc prevents re-processing
    const gf = loadGameFile(seasonId);
    if (gf.games[gameId] && !DRY_RUN) {
      if (allPlayers.length > 0) {
        gf.games[gameId].p = allPlayers.map(p => ({
          id: p.profileID,
          n:  p.name || `Player #${p.profileID.slice(0, 10)}`,
        }));
      }
      gf.games[gameId].spc = 1;
      markGameDirty(seasonId);
    }
  });

  await runPool(p3Tasks, CONCURRENCY_SPECTATOR);
  console.log(`  ${needsSpectator.length}/${needsSpectator.length} done`
            + `  hits: ${spectatorHits}  misses: ${spectatorMiss}`);
  console.log(`  Players with deltas: ${playerDeltas.size}`);

  // Flush game spc + p[] updates
  const flushedSpc = flushGameFiles();
  if (flushedSpc > 0) {
    await gitCommit(`nightly-crawl: spc+p[] written for ${spectatorHits} games`);
  }
  console.log();

  // ── Phase 3 cont.: Apply player stat deltas ────────────────────────────────

  console.log('Phase 3/4 (cont.) — Applying player stat updates…');

  let statsUpdated       = 0;
  let playersSinceCommit = 0;
  const genuinelyNew     = new Map();  // uuid → name — not yet in the player index

  // Group by shard for efficient index reads
  const byShard = new Map();
  for (const [uuid, info] of playerDeltas) {
    const shard = playerShard(uuid);
    if (!byShard.has(shard)) byShard.set(shard, []);
    byShard.get(shard).push({ uuid, ...info });
  }

  for (const [shard, entries] of byShard) {
    const index = readPlayerIndex(shard);

    for (const { uuid, name, deltas } of entries) {
      if (!index[uuid]) {
        // New player — defer to Phase 4 for stubbing
        genuinelyNew.set(uuid, name || `Player #${uuid.slice(0, 10)}`);
        continue;
      }

      const player = readPlayer(uuid);
      if (!player) continue;

      if (!player.sports)            player.sports = {};
      if (!player.sports.Basketball) player.sports.Basketball = {};
      const bk = player.sports.Basketball;

      // Initialise fields that may be absent on older player files
      if (bk.maxGamePTS     === undefined || bk.maxGamePTS     === null) bk.maxGamePTS     = 0;
      if (bk.maxGameThreePt === undefined || bk.maxGameThreePt === null) bk.maxGameThreePt = 0;
      if (!bk.foulOuts || typeof bk.foulOuts !== 'object')               bk.foulOuts       = {};

      let changed = false;
      if (!player.records) player.records = {};
      for (const { seasonId, gameKey, pts, pt3, fouls } of deltas) {
        if (pts > (bk.maxGamePTS ?? 0)) {
          bk.maxGamePTS = pts;
          player.records.maxGamePTS = gameKey ? { v: pts, gameKey, sid: seasonId } : { v: pts };
          changed = true;
        }
        if (pt3 > (bk.maxGameThreePt ?? 0)) {
          bk.maxGameThreePt = pt3;
          player.records.maxGameThreePt = gameKey ? { v: pt3, gameKey, sid: seasonId } : { v: pt3 };
          changed = true;
        }
        if (fouls >= 5) {
          bk.foulOuts[seasonId] = (bk.foulOuts[seasonId] || 0) + 1;
          changed = true;
        }
      }

      if (changed) {
        player.updatedAt = new Date().toISOString();
        writePlayer(uuid, player);
        statsUpdated++;
        playersSinceCommit++;

        if (playersSinceCommit >= COMMIT_EVERY_PLAYERS) {
          await gitCommit(`nightly-crawl: player stats (${statsUpdated} updated so far)`);
          playersSinceCommit = 0;
        }
      }
    }
  }
  console.log(`  Updated: ${statsUpdated}`);
  console.log();

  // ── Phase 4: Stub new players ────────────────────────────────────────────────
  console.log(`Phase 4/4 — New player stubs (${genuinelyNew.size})…`);

  const now       = new Date().toISOString();
  const newByShard = new Map();
  for (const [uuid, name] of genuinelyNew) {
    const shard = playerShard(uuid);
    if (!newByShard.has(shard)) newByShard.set(shard, []);
    newByShard.get(shard).push({ uuid, name });
  }

  let stubbed = 0;
  for (const [shard, entries] of newByShard) {
    const index        = readPlayerIndex(shard);
    let   indexChanged = false;

    for (const { uuid, name } of entries) {
      if (index[uuid]) continue;  // guard — another process may have added it

      // Compute initial stats from the deltas we already collected
      const deltas = playerDeltas.get(uuid)?.deltas || [];
      const bk     = { maxGamePTS: 0, maxGameThreePt: 0, foulOuts: {} };
      for (const { seasonId, pts, pt3, fouls } of deltas) {
        if (pts > bk.maxGamePTS)     bk.maxGamePTS     = pts;
        if (pt3 > bk.maxGameThreePt) bk.maxGameThreePt = pt3;
        if (fouls >= 5) bk.foulOuts[seasonId] = (bk.foulOuts[seasonId] || 0) + 1;
      }

      const stub = {
        uuid, name,
        sports:    { Basketball: bk },
        seasons:   [],
        teams:     [],
        updatedAt: now,
      };
      writePlayer(uuid, stub);

      index[uuid]    = { name, history: {} };
      indexChanged   = true;
      stubbed++;
    }

    if (indexChanged) writePlayerIndex(shard, index);
  }
  console.log(`  Stubbed: ${stubbed}`);
  console.log();

  // Final commit — remaining player + stub writes
  await gitCommit(
    `nightly-crawl: ${statsUpdated} player stats updated, ${stubbed} new players stubbed`
  );

  // ── Status file ───────────────────────────────────────────────────────────────
  // gamesRemaining = FINAL games in fetched rounds that still lack spc.
  // This is the count the workflow uses to decide whether to self-trigger.
  const gamesRemaining = spectatorMiss;  // misses = FINAL games we couldn't process

  if (!DRY_RUN) {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      gamesRemaining,
      gamesProcessed:  spectatorHits,
      statsUpdated,
      stubbed,
      completed:       gamesRemaining === 0,
      timestamp:       new Date().toISOString(),
    }));
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('─'.repeat(50));
  console.log(`  Seasons:           ${seasons.length}`);
  console.log(`  Normal grades:     ${normalGrades.length}`);
  console.log(`  Rounds fetched:    ${roundQueue.length}`);
  console.log(`  Spectator queued:  ${needsSpectator.length}`);
  console.log(`  Spectator hits:    ${spectatorHits}  misses: ${spectatorMiss}`);
  console.log(`  Players updated:   ${statsUpdated}`);
  console.log(`  New players:       ${stubbed}`);
  console.log(`  Games remaining:   ${gamesRemaining}`);
  console.log(`  Elapsed:           ${elapsed}s`);
  console.log('─'.repeat(50));
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing was written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
