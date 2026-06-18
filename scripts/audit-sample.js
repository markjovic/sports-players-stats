// scripts/audit-sample.js
//
// Data integrity audit. Takes truly random samples from stored data files,
// fetches the same data live from PlayHQ, and outputs a comparison report
// with clickable PlayHQ links for manual verification.
//
// Samples three categories:
//   1. Player season stats  — stored reg.stats vs live publicProfileStatistics
//   2. Game scores          — stored hs/as vs live discoverGame
//   3. Game box scores      — stored hp/ap vs live spectator endpoint
//
// Output:
//   - Console: full comparison with MATCH / MISMATCH flags
//   - audit-report-{timestamp}.json: machine-readable full report
//
// Run:  node scripts/audit-sample.js [--samples N] [--types player,score,box]
//
// Defaults: 20 samples per type, all types

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Parse args
const args        = process.argv.slice(2);
const SAMPLES     = parseInt(args.find(a => a.startsWith('--samples='))?.split('=')[1] ?? '20');
const TYPES_ARG   = args.find(a => a.startsWith('--types='))?.split('=')[1] ?? 'player,score,box';
const RUN_TYPES   = new Set(TYPES_ARG.split(',').map(s => s.trim()));

console.log(`\nAudit configuration: ${SAMPLES} samples per type | types: ${[...RUN_TYPES].join(', ')}\n`);

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Fisher-Yates shuffle — truly random
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pick(arr, n) {
  return shuffle([...arr]).slice(0, n);
}

function slugify(str) {
  if (!str) return '';
  return str.toLowerCase()
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}

// ─── Headers ─────────────────────────────────────────────────────────────────

const HEADERS_API = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

const HEADERS_SPECTATOR = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'bv', 'x-phq-tenant': 'bv', 'content-type': 'application/json',
};

// ─── Session ──────────────────────────────────────────────────────────────────

let _session = null;
async function getSession() {
  if (_session) return _session;
  const cookieQueries = [
    { operationName: 'TenantConfig', variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }' },
    { operationName: 'ProfileSearch', variables: { fullName: 'a' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
  ];
  let raw = null;
  for (let attempt = 1; attempt <= 5 && !raw; attempt++) {
    if (attempt > 1) await delay(attempt * 3000);
    for (const body of cookieQueries) {
      const res = await fetch('https://api.playhq.com/graphql', {
        method: 'POST',
        headers: { ...HEADERS_API, 'request-id': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      raw = res.headers.get('set-cookie');
      if (raw) break;
    }
  }
  if (!raw) throw new Error('No Set-Cookie after 5 attempts');
  const session = raw.match(/phq_session=([^;]+)/)[1];
  const payload = JSON.parse(Buffer.from(session.split('.')[1], 'base64').toString());
  const sub = payload.sub || payload.jti;
  _session = {
    cookie:    `phq_session=${session}`,
    allCookies: `phq_session=${session}; phq_sub=${sub}; phq_tier=cookie-no-jwt`,
  };
  console.log('  ✓ Session obtained\n');
  return _session;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

const Q_PROFILE_STATS = `
query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      statistics {
        season { id name }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          gradeStatistics {
            grade { id name }
            statistics { count details { value } }
            gameStatistics {
              game { id }
              statistics { count details { value } }
            }
          }
        }
      }
    }
  }
}`;

const Q_DISCOVER_GAME = `
query DiscoverGame($gameId: ID!) {
  discoverGame(gameID: $gameId) {
    id date
    status { value }
    round { name isFinalsRound }
    home { ... on DiscoverTeam { id name organisation { id name } logo { sizes { url dimensions { width } } } } }
    away { ... on DiscoverTeam { id name } }
    result {
      home { statistics { count type { value } } }
      away { statistics { count type { value } } }
    }
    allocation {
      court { venue { name } }
    }
  }
}`;

const Q_SPECTATOR = `
query game($id: ID!) {
  game(id: $id) {
    id status updatedAt
    statistics {
      home {
        players {
          id profileID name playerNumber
          statistics { type { value } count }
        }
      }
      away {
        players {
          id profileID name playerNumber
          statistics { type { value } count }
        }
      }
    }
  }
}`;

// ─── Stat helpers ─────────────────────────────────────────────────────────────

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function parseStatField(typeValue) {
  switch (typeValue) {
    case 'FREE_THROW': case 'ONE_POINT_FIELD_GOAL': case '1_POINT_SCORE': return 'pt1';
    case 'FIELD_GOAL': case 'TWO_POINT_FIELD_GOAL': case '2_POINT_SCORE': return 'pt2';
    case 'THREE_POINT_FIELD_GOAL': case '3_POINT_SCORE': return 'pt3';
    case 'PERSONAL_FOUL': return 'fouls';
    case 'TOTAL_SCORE': case 'POINTS': return 'pts';
    case 'APPEARANCE': return 'gp';
    default: return null;
  }
}

function sumStats(statsList) {
  const out = { gp: 0, pts: 0, pt1: 0, pt2: 0, pt3: 0, fouls: 0 };
  for (const stat of statsList) {
    for (const detail of toArray(stat.details)) {
      const field = parseStatField(detail.value);
      if (field) out[field] = (out[field] || 0) + (stat.count ?? 0);
    }
  }
  // Compute pts from components if not directly returned
  if (out.pts === 0) out.pts = out.pt1 + out.pt2 * 2 + out.pt3 * 3;
  return out;
}

function parseSpectatorStats(statistics) {
  const out = { pt1: 0, pt2: 0, pt3: 0, fouls: 0, pts: 0 };
  for (const s of (statistics || [])) {
    const field = parseStatField(s.type?.value);
    if (field && field !== 'gp') out[field] = (out[field] || 0) + (s.count ?? 0);
  }
  if (out.pts === 0) out.pts = out.pt1 + out.pt2 * 2 + out.pt3 * 3;
  return out;
}

function compareStats(label, stored, live, fields) {
  const mismatches = [];
  for (const f of fields) {
    const s = stored[f] ?? 0;
    const l = live[f] ?? 0;
    if (s !== l) mismatches.push(`${f}: stored=${s} live=${l}`);
  }
  return mismatches;
}

// ─── PlayHQ URL builders ──────────────────────────────────────────────────────

function playerURL(uuid) {
  return `https://www.playhq.com/basketball-victoria/public/profile/${uuid}/statistics`;
}

function gameURL(gameId, orgName, compName, seasonName, gradeName) {
  if (!orgName) return `https://www.playhq.com (game ID: ${gameId})`;
  return `https://www.playhq.com/basketball-victoria/org/${slugify(orgName)}/${slugify(compName + ' ' + seasonName)}/${slugify(gradeName)}/game-centre/${gameId}`;
}

// ─── Sample collection ────────────────────────────────────────────────────────

const playersDir = path.join(ROOT, 'players');
const gamesDir   = path.join(ROOT, 'games', 'bv');

// Build pool of all player files
function getAllPlayerFiles() {
  const files = [];
  for (const prefix of fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d))) {
    for (const fname of fs.readdirSync(path.join(playersDir, prefix)).filter(f => f.endsWith('.json'))) {
      files.push(path.join(playersDir, prefix, fname));
    }
  }
  return files;
}

// Build pool of all game files
function getAllGameFiles() {
  return fs.readdirSync(gamesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(gamesDir, f));
}

// ─── Report ───────────────────────────────────────────────────────────────────

const report = {
  timestamp: new Date().toISOString(),
  samplesPerType: SAMPLES,
  types: [...RUN_TYPES],
  results: { player: [], score: [], box: [] },
  summary: { player: {}, score: {}, box: {} },
};

function printHeader(title) {
  console.log('═'.repeat(70));
  console.log(title);
  console.log('═'.repeat(70));
}

function printResult(label, match, stored, live, mismatches, url) {
  const flag = match ? '✓ MATCH   ' : '✗ MISMATCH';
  console.log(`\n  ${flag} ${label}`);
  console.log(`  Stored : ${JSON.stringify(stored)}`);
  console.log(`  Live   : ${JSON.stringify(live)}`);
  if (!match) console.log(`  Diffs  : ${mismatches.join(' | ')}`);
  console.log(`  Link   : ${url}`);
}

// ─── Type 1: Player season stats ─────────────────────────────────────────────

if (RUN_TYPES.has('player')) {
  printHeader('TYPE 1 — Player Season Stats (reg.stats vs publicProfileStatistics)');
  const session = await getSession();
  const allFiles = getAllPlayerFiles();
  const sampled  = pick(allFiles, SAMPLES * 5); // oversample to find valid regs

  let done = 0;
  let matches = 0, mismatches = 0, skipped = 0;

  for (const fpath of sampled) {
    if (done >= SAMPLES) break;
    let player;
    try { player = readJson(fpath); } catch { skipped++; continue; }

    const uuid = player.uuid;
    if (!uuid || !player.seasons?.length) { skipped++; continue; }

    // Pick a random season with a reg that has stats
    const validSeasons = player.seasons.filter(s =>
      s.regs?.some(r => r.stats?.gp > 0)
    );
    if (!validSeasons.length) { skipped++; continue; }
    const season = validSeasons[Math.floor(Math.random() * validSeasons.length)];
    const reg    = season.regs.filter(r => r.stats?.gp > 0)[0];
    if (!reg) { skipped++; continue; }

    // Fetch live data
    let profileData;
    try {
      const res = await fetch('https://api.playhq.com/graphql', {
        method: 'POST',
        headers: { ...HEADERS_API, 'request-id': crypto.randomUUID(), 'Cookie': session.cookie },
        body: JSON.stringify({ operationName: 'ProfileSeasonStatistics',
          variables: { profileID: uuid }, query: Q_PROFILE_STATS }),
      });
      const data = await res.json();
      profileData = data?.data?.publicProfileStatistics;
    } catch { skipped++; continue; }

    if (!profileData) { skipped++; continue; }

    // Find matching season+team in live data
    let liveStats = null;
    outer: for (const sEntry of (profileData.seasonStatistics || [])) {
      for (const tEntry of (sEntry.statistics || [])) {
        if (tEntry.season?.id !== season.sid) continue;
        for (const team of (tEntry.teamStatistics || [])) {
          if (team.team?.id !== reg.tid) continue;
          for (const grade of (team.gradeStatistics || [])) {
            if (grade.grade?.id !== reg.gid) continue;
            // Sum all game stats for this grade
            const allStats = grade.gameStatistics.flatMap(g => g.statistics || []);
            liveStats = sumStats(allStats);
            break outer;
          }
          // Grade not matched — try summing all grades for this team in this season
          const allGradeStats = team.gradeStatistics.flatMap(g =>
            g.gameStatistics.flatMap(gs => gs.statistics || [])
          );
          if (allGradeStats.length) { liveStats = sumStats(allGradeStats); break outer; }
        }
      }
    }

    if (!liveStats) { skipped++; continue; }

    const stored = {
      gp: reg.stats.gp, pts: reg.stats.pts, pt1: reg.stats.ft,
      pt2: reg.stats.fg, pt3: reg.stats.threePt, fouls: reg.stats.fouls,
    };
    const fields = ['gp', 'pts', 'pt3', 'fouls'];
    const diffs  = compareStats('', stored, liveStats, fields);
    const match  = diffs.length === 0;
    if (match) matches++; else mismatches++;

    const label = `${player.name || uuid} — ${season.sn || season.sid} (${reg.tn || reg.tid})`;
    printResult(label, match, stored, liveStats, diffs, playerURL(uuid));

    report.results.player.push({
      uuid, name: player.name, season: season.sn, team: reg.tn,
      stored, live: liveStats, mismatches: diffs, url: playerURL(uuid),
    });
    done++;
    await delay(200);
  }

  report.summary.player = { done, matches, mismatches, skipped };
  console.log(`\n  Player summary: ${done} samples | ${matches} match | ${mismatches} mismatch | ${skipped} skipped`);
}

// ─── Type 2: Game scores ──────────────────────────────────────────────────────

if (RUN_TYPES.has('score')) {
  printHeader('\nTYPE 2 — Game Scores (stored hs/as vs discoverGame)');
  const session = await getSession();
  const allFiles = getAllGameFiles();
  const sampledFiles = pick(allFiles, Math.min(SAMPLES * 3, allFiles.length));

  let done = 0;
  let matches = 0, mismatches = 0, skipped = 0;
  let nullGames = 0;

  // Load team-index for URL building
  let teamIndex = {};
  try { teamIndex = readJson(path.join(ROOT, 'team-index.json')); } catch {}

  for (const fpath of sampledFiles) {
    if (done >= SAMPLES) break;
    let gf;
    try { gf = readJson(fpath); } catch { continue; }
    const sid = path.basename(fpath, '.json');

    const gameIds = Object.keys(gf.games || {});
    // Filter to scored games
    const scored = gameIds.filter(id => {
      const g = gf.games[id];
      return g.hs != null && g.as != null && !g.hidden && !g.forfeit;
    });
    if (!scored.length) continue;

    const gameId = scored[Math.floor(Math.random() * scored.length)];
    const stored = gf.games[gameId];

    // Fetch from discoverGame
    let liveGame;
    try {
      const res = await fetch('https://api.playhq.com/graphql', {
        method: 'POST',
        headers: { ...HEADERS_API, 'request-id': crypto.randomUUID(), 'Cookie': session.cookie },
        body: JSON.stringify({ operationName: 'DiscoverGame',
          variables: { gameId }, query: Q_DISCOVER_GAME }),
      });
      const data = await res.json();
      liveGame = data?.data?.discoverGame;
    } catch { skipped++; continue; }

    if (!liveGame) { nullGames++; skipped++; continue; }

    const liveHs = liveGame.result?.home?.statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;
    const liveAs = liveGame.result?.away?.statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;

    const storedScore = { hs: stored.hs, as: stored.as };
    const liveScore   = { hs: liveHs, as: liveAs };
    const diffs = [];
    if (stored.hs !== liveHs) diffs.push(`hs: stored=${stored.hs} live=${liveHs}`);
    if (stored.as !== liveAs) diffs.push(`as: stored=${stored.as} live=${liveAs}`);
    const match = diffs.length === 0;
    if (match) matches++; else mismatches++;

    // Build URL from discoverGame response
    const orgName  = liveGame.home?.organisation?.name || '';
    const tid      = stored.h || stored.t1;
    const teamData = tid ? teamIndex[tid] : null;
    const compName = teamData?.compName || '';
    const sn       = teamData?.sn || '';
    const gn       = stored.gn || teamData?.gn || '';
    const url      = gameURL(gameId, orgName, compName, sn, gn);

    const label = `${stored.hn || '?'} ${stored.hs}–${stored.as} ${stored.an || '?'} (${stored.d})`;
    printResult(label, match, storedScore, liveScore, diffs, url);

    report.results.score.push({
      gameId, sid, date: stored.d, home: stored.hn, away: stored.an,
      stored: storedScore, live: liveScore, mismatches: diffs, url,
    });
    done++;
    await delay(200);
  }

  report.summary.score = { done, matches, mismatches, skipped, nullGames };
  console.log(`\n  Score summary: ${done} samples | ${matches} match | ${mismatches} mismatch | ${nullGames} null (hidden/legacy)`);
}

// ─── Type 3: Box scores ───────────────────────────────────────────────────────

if (RUN_TYPES.has('box')) {
  printHeader('\nTYPE 3 — Game Box Scores (stored hp/ap vs spectator)');
  const session = await getSession();
  const allFiles = getAllGameFiles();
  const sampledFiles = pick(allFiles, Math.min(SAMPLES * 5, allFiles.length));

  let done = 0;
  let matches = 0, mismatches = 0, skipped = 0;

  for (const fpath of sampledFiles) {
    if (done >= SAMPLES) break;
    let gf;
    try { gf = readJson(fpath); } catch { continue; }
    const sid = path.basename(fpath, '.json');

    // Find games with stored box scores
    const withBox = Object.entries(gf.games || {})
      .filter(([, g]) => Array.isArray(g.hp) && g.hp.length > 0);
    if (!withBox.length) continue;

    const [gameId, storedGame] = withBox[Math.floor(Math.random() * withBox.length)];

    // Fetch from spectator
    let spectatorGame;
    try {
      const res = await fetch('https://spectator.playhq.com/graphql', {
        method: 'POST',
        headers: { ...HEADERS_SPECTATOR, 'request-id': crypto.randomUUID(), 'Cookie': session.allCookies },
        body: JSON.stringify({ operationName: 'game', variables: { id: gameId }, query: Q_SPECTATOR }),
      });
      const data = await res.json();
      spectatorGame = data?.data?.game;
    } catch { skipped++; continue; }

    if (!spectatorGame) { skipped++; continue; }

    // Build spectator player map
    const spectatorPlayers = {};
    for (const [sideKey] of [['home'], ['away']]) {
      for (const p of (spectatorGame.statistics?.[sideKey]?.players || [])) {
        if (p.profileID) spectatorPlayers[p.profileID] = parseSpectatorStats(p.statistics);
      }
    }

    // Pick a random player from stored hp who has non-zero stats
    const storedPlayers = [...(storedGame.hp || []), ...(storedGame.ap || [])]
      .filter(p => p.profileID && p.pts > 0);
    if (!storedPlayers.length) { skipped++; continue; }

    const storedPlayer = storedPlayers[Math.floor(Math.random() * storedPlayers.length)];
    const uuid = storedPlayer.profileID;
    const livePlayer = spectatorPlayers[uuid];

    if (!livePlayer) { skipped++; continue; }

    const storedBox = { pts: storedPlayer.pts, pt1: storedPlayer.pt1,
      pt2: storedPlayer.pt2, pt3: storedPlayer.pt3, fouls: storedPlayer.fouls };
    const liveBox = livePlayer;
    const fields  = ['pts', 'pt1', 'pt2', 'pt3', 'fouls'];
    const diffs   = compareStats('', storedBox, liveBox, fields);
    const match   = diffs.length === 0;
    if (match) matches++; else mismatches++;

    const label = `${storedPlayer.name} in ${storedGame.hn} ${storedGame.hs}–${storedGame.as} ${storedGame.an} (${storedGame.d})`;
    printResult(label, match, storedBox, liveBox, diffs,
      playerURL(uuid) + `  [game: ${gameId}]`);

    report.results.box.push({
      gameId, sid, uuid, name: storedPlayer.name, date: storedGame.d,
      stored: storedBox, live: liveBox, mismatches: diffs,
      url: playerURL(uuid), gameId,
    });
    done++;
    await delay(300);
  }

  report.summary.box = { done, matches, mismatches, skipped };
  console.log(`\n  Box score summary: ${done} samples | ${matches} match | ${mismatches} mismatch | ${skipped} skipped`);
}

// ─── Write report ─────────────────────────────────────────────────────────────

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = path.join(ROOT, `audit-report-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

console.log('\n' + '═'.repeat(70));
console.log('OVERALL SUMMARY');
console.log('═'.repeat(70));
for (const type of ['player', 'score', 'box']) {
  const s = report.summary[type];
  if (!s || !s.done) continue;
  const pct = s.done ? Math.round(s.matches / s.done * 100) : 0;
  console.log(`  ${type.padEnd(8)}: ${s.matches}/${s.done} match (${pct}%) | ${s.mismatches} mismatches`);
}
console.log(`\nFull report: audit-report-${ts}.json`);
