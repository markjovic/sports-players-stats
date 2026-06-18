// scripts/audit-sample.js
//
// Data integrity audit. Takes truly random samples from stored data files,
// fetches the same data live from PlayHQ, and outputs a comparison report
// with clickable PlayHQ links for manual verification.
//
// Samples three categories:
//   1. player — stored reg.stats vs live publicProfileStatistics
//   2. score  — stored hs/as vs live discoverGame
//   3. box    — stored hp/ap vs live spectator endpoint
//
// Run: node scripts/audit-sample.js [--samples=N] [--types=player,score,box]

import fs     from 'fs';
import path   from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

const args      = process.argv.slice(2);
const SAMPLES   = parseInt(args.find(a => a.startsWith('--samples='))?.split('=')[1] ?? '20');
const TYPES_ARG = args.find(a => a.startsWith('--types='))?.split('=')[1] ?? 'player,score,box';
const RUN_TYPES = new Set(TYPES_ARG.split(',').map(s => s.trim()));

console.log(`\nAudit: ${SAMPLES} samples per type | types: ${[...RUN_TYPES].join(', ')}\n`);

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function pick(arr, n) { return shuffle([...arr]).slice(0, n); }

function slugify(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[()]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
}

// ─── Headers ─────────────────────────────────────────────────────────────────

const HEADERS_API = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};
const HEADERS_SPEC = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'bv', 'x-phq-tenant': 'bv', 'content-type': 'application/json',
};

// ─── Session ──────────────────────────────────────────────────────────────────

let _session = null;
async function getSession() {
  if (_session) return _session;
  const bodies = [
    { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
    { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
  ];
  let raw = null;
  for (let attempt = 1; attempt <= 5 && !raw; attempt++) {
    if (attempt > 1) await delay(attempt * 3000);
    for (const body of bodies) {
      const res = await fetch('https://api.playhq.com/graphql', {
        method: 'POST', headers: { ...HEADERS_API, 'request-id': crypto.randomUUID() }, body: JSON.stringify(body),
      });
      raw = res.headers.get('set-cookie');
      if (raw) break;
    }
  }
  if (!raw) throw new Error('No Set-Cookie after 5 attempts');
  const session = raw.match(/phq_session=([^;]+)/)[1];
  const payload = JSON.parse(Buffer.from(session.split('.')[1], 'base64').toString());
  const sub = payload.sub || payload.jti;
  _session = { cookie: `phq_session=${session}`, allCookies: `phq_session=${session}; phq_sub=${sub}; phq_tier=cookie-no-jwt` };
  console.log('  ✓ Session obtained\n');
  return _session;
}

// ─── Stat helpers ─────────────────────────────────────────────────────────────

function toArray(v) { if (!v) return []; return Array.isArray(v) ? v : [v]; }

function parseStatField(v) {
  switch (v) {
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
      const f = parseStatField(detail.value);
      if (f) out[f] = (out[f] || 0) + (stat.count ?? 0);
    }
  }
  if (out.pts === 0) out.pts = out.pt1 + out.pt2 * 2 + out.pt3 * 3;
  return out;
}

function parseSpectatorStats(statistics) {
  const out = { pt1: 0, pt2: 0, pt3: 0, fouls: 0, pts: 0 };
  for (const s of (statistics || [])) {
    const f = parseStatField(s.type?.value);
    if (f && f !== 'gp') out[f] = (out[f] || 0) + (s.count ?? 0);
  }
  if (out.pts === 0) out.pts = out.pt1 + out.pt2 * 2 + out.pt3 * 3;
  return out;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

const Q_PROFILE = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics { statistics { season { id }
      teamStatistics { team { ... on DiscoverTeam { id } }
        gradeStatistics { grade { id }
          gameStatistics { game { id } statistics { count details { value } } }
        }
      }
    } }
  }
}`;

const Q_GAME = `query DiscoverGame($gameId: ID!) {
  discoverGame(gameID: $gameId) {
    id date status { value } round { name }
    home { ... on DiscoverTeam { id name organisation { id name } } }
    away { ... on DiscoverTeam { id name } }
    result {
      home { statistics { count type { value } } }
      away { statistics { count type { value } } }
    }
  }
}`;

const Q_SPEC = `query game($id: ID!) {
  game(id: $id) { id status updatedAt
    statistics {
      home { players { id profileID name statistics { type { value } count } } }
      away { players { id profileID name statistics { type { value } count } } }
    }
  }
}`;

async function apiPost(query, variables, cookie) {
  const res = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS_API, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) return null;
  const d = await res.json();
  return d?.data;
}

async function specPost(query, variables, allCookies) {
  const res = await fetch('https://spectator.playhq.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS_SPEC, 'request-id': crypto.randomUUID(), 'Cookie': allCookies },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) return null;
  const d = await res.json();
  return d?.data;
}

// ─── URL builders ─────────────────────────────────────────────────────────────

function playerURL(uuid) { return `https://www.playhq.com/basketball-victoria/public/profile/${uuid}/statistics`; }

function gameURL(gameId, orgName, compName, sn, gn) {
  if (!orgName) return `https://www.playhq.com  [game ID: ${gameId}]`;
  return `https://www.playhq.com/basketball-victoria/org/${slugify(orgName)}/${slugify(compName + ' ' + sn)}/${slugify(gn)}/game-centre/${gameId}`;
}

// ─── File pools ───────────────────────────────────────────────────────────────

const playersDir = path.join(ROOT, 'players');
const gamesDir   = path.join(ROOT, 'games', 'bv');

function getAllPlayerFiles() {
  const files = [];
  for (const prefix of fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d)))
    for (const fname of fs.readdirSync(path.join(playersDir, prefix)).filter(f => f.endsWith('.json')))
      files.push(path.join(playersDir, prefix, fname));
  return files;
}

function getAllGameFiles() {
  return fs.readdirSync(gamesDir).filter(f => f.endsWith('.json')).map(f => path.join(gamesDir, f));
}

// ─── Report ───────────────────────────────────────────────────────────────────

const report = { timestamp: new Date().toISOString(), samplesPerType: SAMPLES, results: { player: [], score: [], box: [] }, summary: {} };

function header(t) { console.log('\n' + '═'.repeat(70) + '\n' + t + '\n' + '═'.repeat(70)); }

function printResult(label, match, stored, live, diffs, url) {
  console.log(`\n  ${match ? '✓ MATCH   ' : '✗ MISMATCH'} ${label}`);
  console.log(`  Stored : ${JSON.stringify(stored)}`);
  console.log(`  Live   : ${JSON.stringify(live)}`);
  if (!match) console.log(`  Diffs  : ${diffs.join(' | ')}`);
  console.log(`  Link   : ${url}`);
}

// ─── Type 1: Player stats ─────────────────────────────────────────────────────

if (RUN_TYPES.has('player')) {
  header('TYPE 1 — Player Season Stats (reg.stats vs publicProfileStatistics)');
  const session = await getSession();
  let done = 0, matches = 0, mismatches = 0, skipped = 0;

  for (const fpath of pick(getAllPlayerFiles(), SAMPLES * 6)) {
    if (done >= SAMPLES) break;
    let player; try { player = readJson(fpath); } catch { skipped++; continue; }
    const uuid = player.uuid;
    if (!uuid || !player.seasons?.length) { skipped++; continue; }

    const validSeasons = player.seasons.filter(s => s.regs?.some(r => r.stats?.gp > 0));
    if (!validSeasons.length) { skipped++; continue; }
    const season = validSeasons[Math.floor(Math.random() * validSeasons.length)];
    const reg    = season.regs.filter(r => r.stats?.gp > 0)[0];
    if (!reg) { skipped++; continue; }

    const data = await apiPost(Q_PROFILE, { profileID: uuid }, session.cookie);
    const profile = data?.publicProfileStatistics;
    if (!profile) { skipped++; continue; }

    let liveStats = null;
    outer: for (const sEntry of (profile.seasonStatistics || []))
      for (const tEntry of (sEntry.statistics || [])) {
        if (tEntry.season?.id !== season.sid) continue;
        for (const team of (tEntry.teamStatistics || [])) {
          if (team.team?.id !== reg.tid) continue;
          for (const grade of (team.gradeStatistics || [])) {
            if (grade.grade?.id !== reg.gid) continue;
            liveStats = sumStats(grade.gameStatistics.flatMap(g => g.statistics || []));
            break outer;
          }
          liveStats = sumStats(team.gradeStatistics.flatMap(g => g.gameStatistics.flatMap(gs => gs.statistics || [])));
          break outer;
        }
      }

    if (!liveStats) { skipped++; continue; }

    const stored = { gp: reg.stats.gp, pts: reg.stats.pts, pt3: reg.stats.threePt, fouls: reg.stats.fouls };
    const live   = { gp: liveStats.gp, pts: liveStats.pts, pt3: liveStats.pt3, fouls: liveStats.fouls };
    const diffs  = Object.keys(stored).filter(k => (stored[k] ?? 0) !== (live[k] ?? 0)).map(k => `${k}: stored=${stored[k]} live=${live[k]}`);
    const match  = diffs.length === 0;
    if (match) matches++; else mismatches++;

    printResult(`${player.name || uuid} — ${season.sn || season.sid} / ${reg.tn || reg.tid}`, match, stored, live, diffs, playerURL(uuid));
    report.results.player.push({ uuid, name: player.name, season: season.sn, team: reg.tn, stored, live, mismatches: diffs, url: playerURL(uuid) });
    done++;
    await delay(200);
  }

  report.summary.player = { done, matches, mismatches, skipped };
  console.log(`\n  Player: ${done} samples | ${matches} match | ${mismatches} mismatch | ${skipped} skipped`);
}

// ─── Type 2: Game scores ──────────────────────────────────────────────────────

if (RUN_TYPES.has('score')) {
  header('TYPE 2 — Game Scores (stored hs/as vs discoverGame)');
  const session = await getSession();
  let done = 0, matches = 0, mismatches = 0, skipped = 0, nulls = 0;
  let teamIndex = {}; try { teamIndex = readJson(path.join(ROOT, 'team-index.json')); } catch {}

  for (const fpath of pick(getAllGameFiles(), Math.min(SAMPLES * 4, 500))) {
    if (done >= SAMPLES) break;
    let gf; try { gf = readJson(fpath); } catch { continue; }
    const sid = path.basename(fpath, '.json');
    const scored = Object.entries(gf.games || {}).filter(([, g]) => g.hs != null && g.as != null && !g.hidden && !g.forfeit);
    if (!scored.length) continue;
    const [gameId, stored] = scored[Math.floor(Math.random() * scored.length)];

    const data = await apiPost(Q_GAME, { gameId }, session.cookie);
    const live = data?.discoverGame;
    if (!live) { nulls++; skipped++; continue; }

    const liveHs = live.result?.home?.statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;
    const liveAs = live.result?.away?.statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;
    const storedScore = { hs: stored.hs, as: stored.as };
    const liveScore   = { hs: liveHs,    as: liveAs };
    const diffs = Object.keys(storedScore).filter(k => storedScore[k] !== liveScore[k]).map(k => `${k}: stored=${storedScore[k]} live=${liveScore[k]}`);
    const match = diffs.length === 0;
    if (match) matches++; else mismatches++;

    const orgName = live.home?.organisation?.name || '';
    const tid = stored.h || stored.t1;
    const td  = tid ? teamIndex[tid] : null;
    const url = gameURL(gameId, orgName, td?.compName || '', td?.sn || '', stored.gn || td?.gn || '');

    printResult(`${stored.hn} ${stored.hs}–${stored.as} ${stored.an} (${stored.d})`, match, storedScore, liveScore, diffs, url);
    report.results.score.push({ gameId, sid, date: stored.d, home: stored.hn, away: stored.an, stored: storedScore, live: liveScore, mismatches: diffs, url });
    done++;
    await delay(200);
  }

  report.summary.score = { done, matches, mismatches, skipped, nulls };
  console.log(`\n  Score: ${done} samples | ${matches} match | ${mismatches} mismatch | ${nulls} null (hidden/legacy)`);
}

// ─── Type 3: Box scores ───────────────────────────────────────────────────────

if (RUN_TYPES.has('box')) {
  header('TYPE 3 — Box Scores (stored hp/ap vs spectator endpoint)');
  const session = await getSession();
  let done = 0, matches = 0, mismatches = 0, skipped = 0;

  for (const fpath of pick(getAllGameFiles(), Math.min(SAMPLES * 6, 600))) {
    if (done >= SAMPLES) break;
    let gf; try { gf = readJson(fpath); } catch { continue; }
    const withBox = Object.entries(gf.games || {}).filter(([, g]) => Array.isArray(g.hp) && g.hp.some(p => p.pts > 0));
    if (!withBox.length) continue;

    const [gameId, storedGame] = withBox[Math.floor(Math.random() * withBox.length)];
    const data = await specPost(Q_SPEC, { id: gameId }, session.allCookies);
    const specGame = data?.game;
    if (!specGame) { skipped++; continue; }

    const specPlayers = {};
    for (const side of ['home', 'away'])
      for (const p of (specGame.statistics?.[side]?.players || []))
        if (p.profileID) specPlayers[p.profileID] = parseSpectatorStats(p.statistics);

    const candidates = [...(storedGame.hp || []), ...(storedGame.ap || [])].filter(p => p.profileID && p.pts > 0);
    if (!candidates.length) { skipped++; continue; }
    const sp = candidates[Math.floor(Math.random() * candidates.length)];
    const lp = specPlayers[sp.profileID];
    if (!lp) { skipped++; continue; }

    const stored = { pts: sp.pts, pt1: sp.pt1, pt2: sp.pt2, pt3: sp.pt3, fouls: sp.fouls };
    const live   = lp;
    const diffs  = ['pts','pt1','pt2','pt3','fouls'].filter(k => (stored[k] ?? 0) !== (live[k] ?? 0)).map(k => `${k}: stored=${stored[k]} live=${live[k]}`);
    const match  = diffs.length === 0;
    if (match) matches++; else mismatches++;

    printResult(`${sp.name} in ${storedGame.hn} ${storedGame.hs}–${storedGame.as} ${storedGame.an} (${storedGame.d})`, match, stored, live, diffs,
      `${playerURL(sp.profileID)}  [game: ${gameId}]`);
    report.results.box.push({ gameId, uuid: sp.profileID, name: sp.name, date: storedGame.d, stored, live, mismatches: diffs, url: playerURL(sp.profileID) });
    done++;
    await delay(300);
  }

  report.summary.box = { done, matches, mismatches, skipped };
  console.log(`\n  Box: ${done} samples | ${matches} match | ${mismatches} mismatch | ${skipped} skipped`);
}

// ─── Write report ─────────────────────────────────────────────────────────────

const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = path.join(ROOT, `audit-report-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

console.log('\n' + '═'.repeat(70) + '\nOVERALL SUMMARY\n' + '═'.repeat(70));
for (const type of ['player', 'score', 'box']) {
  const s = report.summary[type];
  if (!s?.done) continue;
  const pct = Math.round(s.matches / s.done * 100);
  console.log(`  ${type.padEnd(8)}: ${s.matches}/${s.done} match (${pct}%) | ${s.mismatches} mismatches`);
}
console.log(`\nFull report: audit-report-${ts}.json`);
