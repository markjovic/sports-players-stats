// scripts/build-records.js
//
// Builds all-time single-game records across two phases:
//
// Phase 1 — game file scan (no API, covers ALL 2.2M games):
//   teamPTS       — most points scored by one team in a single game
//   highestCombined — highest combined score (both teams)
//   largestMargin   — largest winning margin
//   closestGame     — closest non-draw game by min/max score ratio
//   teamThreePt   — most 3-pointers by one team (box-score limited, noted)
//   Also builds gameId → {d,hs,as,hn,an,sid} lookup for phase 2
//
// Phase 2 — publicProfileStatistics API fetch (covers all public players
//            in ALL their games, not limited to stored box scores):
//   playerPTS     — most points in a single game by one player
//   playerThreePt — most 3-pointers in a single game by one player
//
// Output: records/all-time.json
// Each category is an array of up to TOP_N entries, ranked.
//
// Run:     node scripts/build-records.js
// Dry run: node scripts/build-records.js --dry-run
// Force:   node scripts/build-records.js --force

'use strict';

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));


const ROOT             = path.join(__dirname, '..');
const DRY_RUN          = process.argv.includes('--dry-run');
const FORCE            = process.argv.includes('--force');
const TOP_N            = 50;
const GAME_COMMIT_INTERVAL   = 200;
const PROGRESS_FILE    = path.join(ROOT, 'scripts', '.records-progress.json');
const OUT_FILE         = path.join(ROOT, 'records', 'all-time.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8'); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function gitCommit(message, dirs) {
  try {
    execSync('git add -A', { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git fetch origin main', { cwd: ROOT, stdio: 'pipe' });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push origin main', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ committed: ${message}`);
  } catch (e) {
    console.error(`  ✗ git error: ${e.message}`);
  }
}

function insertTop(arr, entry, sortKey = 'v') {
  arr.push(entry);
  arr.sort((a, b) => b[sortKey] - a[sortKey]);
  if (arr.length > TOP_N) arr.length = TOP_N;
}

function rankArray(arr, sortKey = 'v') {
  let rank = 1;
  for (let i = 0; i < arr.length; i++) {
    if (i > 0 && arr[i][sortKey] < arr[i - 1][sortKey]) rank = i + 1;
    arr[i].rank = rank;
  }
  return arr;
}

const EMPTY_RECORDS = () => ({
  playerPTS:       [],  // phase 2 — API
  playerThreePt:   [],  // phase 2 — API
  teamPTS:         [],  // phase 1 — all games
  teamThreePt:     [],  // phase 1 — box scores only (noted in output)
  highestCombined: [],  // phase 1 — all games
  largestMargin:   [],  // phase 1 — all games
  closestGame:     [],  // phase 1 — all games
});

const recordsDir = path.join(ROOT, 'records');
if (!fs.existsSync(recordsDir)) fs.mkdirSync(recordsDir, { recursive: true });

// Load progress
let progress = { scannedSids: [], records: EMPTY_RECORDS() };
if (!FORCE && fs.existsSync(PROGRESS_FILE)) {
  try { progress = readJson(PROGRESS_FILE); } catch {}
} else if (FORCE) {
  console.log('  --force: clearing progress\n');
}
const scannedSids  = new Set(progress.scannedSids  || []);
const records      = { ...EMPTY_RECORDS(), ...progress.records };
for (const key of Object.keys(EMPTY_RECORDS())) {
  if (!Array.isArray(records[key])) records[key] = [];
}

// ─── Phase 1: game file scan ──────────────────────────────────────────────────

console.log(`── Phase 1: Game file scan (team/game records — all games) ─────────`);

const gamesDir = path.join(ROOT, 'games', 'bv');
const sids = fs.readdirSync(gamesDir)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''))
  .sort();

const sidsToScan = sids.filter(s => !scannedSids.has(s));
console.log(`  ${sids.length} season files, ${scannedSids.size} already scanned, ${sidsToScan.length} remaining`);

// gameLookup: gameId → {d, hs, as, hn, an, sid} — built fresh each run (fast, local only)
// Only need entries that might appear in player profile game stats
const gameLookup = new Map();

// First pass: rebuild gameLookup from all season files (always — needed for phase 2)
console.log('  Building game lookup table...');
let lookupCount = 0;
for (const fname of fs.readdirSync(gamesDir).filter(f => f.endsWith('.json'))) {
  let gf;
  try { gf = readJson(path.join(gamesDir, fname)); } catch { continue; }
  const sid = fname.replace('.json', '');
  for (const [gameId, g] of Object.entries(gf.games || {})) {
    gameLookup.set(gameId, { d: g.d, hs: g.hs, as: g.as, hn: g.hn, an: g.an,
      h: g.h || g.t1, a: g.a || g.t2, sid });
    lookupCount++;
  }
}
console.log(`  ${lookupCount} games in lookup table`);

// Second pass: only unseen sids for records
let sinceLastCommit = 0;
let gamesChecked = 0;
let boxScoreGames = 0;

for (const sid of sidsToScan) {
  let gf;
  try { gf = readJson(path.join(gamesDir, `${sid}.json`)); } catch { scannedSids.add(sid); continue; }

  for (const [gameId, g] of Object.entries(gf.games || {})) {
    if (g.forfeit) continue;
    const hs  = g.hs ?? null;
    const as_ = g.as ?? null;
    const date = g.d || '';
    const hn   = g.hn || '';
    const an   = g.an || '';
    gamesChecked++;

    if (hs != null && as_ != null && hs > 0 && as_ > 0) {
      const combined = hs + as_;
      const margin   = Math.abs(hs - as_);
      const ratio    = Math.min(hs, as_) / Math.max(hs, as_);
      const scoreStr = `${hs}–${as_}`;

      if (combined > (records.highestCombined.at(-1)?.v ?? 0) || records.highestCombined.length < TOP_N)
        insertTop(records.highestCombined, { v: combined, gameKey: gameId, sid, date,
          home: `${hn} ${hs}`, away: `${an} ${as_}` });

      if (margin > (records.largestMargin.at(-1)?.v ?? 0) || records.largestMargin.length < TOP_N) {
        const winnerName = hs > as_ ? hn : an;
        const loserName  = hs > as_ ? an : hn;
        insertTop(records.largestMargin, { v: margin, gameKey: gameId, sid, date,
          winner: winnerName, loser: loserName, score: scoreStr });
      }

      if (hs !== as_ && (ratio > (records.closestGame.at(-1)?.ratio ?? 0) || records.closestGame.length < TOP_N))
        insertTop(records.closestGame, { ratio: Math.round(ratio * 100000) / 100000,
          gameKey: gameId, sid, date, score: scoreStr, home: hn, away: an }, 'ratio');
    }

    if (hs != null && (hs > (records.teamPTS.at(-1)?.v ?? 0) || records.teamPTS.length < TOP_N))
      insertTop(records.teamPTS, { v: hs, gameKey: gameId, sid, date,
        name: hn, tid: g.h || g.t1 || null, vs: an, score: `${hs}–${as_ ?? '?'}` });

    if (as_ != null && (as_ > (records.teamPTS.at(-1)?.v ?? 0) || records.teamPTS.length < TOP_N))
      insertTop(records.teamPTS, { v: as_, gameKey: gameId, sid, date,
        name: an, tid: g.a || g.t2 || null, vs: hn, score: `${hs ?? '?'}–${as_}` });

    // teamThreePt — box scores only
    for (const [key, teamName, tid, vsName] of [
      ['hp', hn, g.h || g.t1, an],
      ['ap', an, g.a || g.t2, hn],
    ]) {
      const box = g[key];
      if (!Array.isArray(box) || !box.length) continue;
      boxScoreGames++;
      const teamThreePt = box.reduce((s, e) => s + (e.pt3 ?? 0), 0);
      const scoreStr = `${hs ?? '?'}–${as_ ?? '?'}`;
      if (teamThreePt > 0 && (teamThreePt > (records.teamThreePt.at(-1)?.v ?? 0) || records.teamThreePt.length < TOP_N))
        insertTop(records.teamThreePt, { v: teamThreePt, gameKey: gameId, sid, date,
          name: teamName, tid, vs: vsName, score: scoreStr });
    }
  }

  scannedSids.add(sid);
  sinceLastCommit++;

  if (sinceLastCommit >= GAME_COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      writeJson(PROGRESS_FILE, { scannedSids: [...scannedSids], records });
      writeJson(OUT_FILE, records);
      gitCommit(`build-records: phase 1 — ${scannedSids.size}/${sids.length} seasons`,
        ['scripts/.records-progress.json', 'records/all-time.json']);
    }
    sinceLastCommit = 0;
    console.log(`  ${scannedSids.size}/${sids.length} seasons — teamPTS: ${records.teamPTS[0]?.v ?? 0}, combined: ${records.highestCombined[0]?.v ?? 0}`);
  }
}

console.log(`  Phase 1 complete: ${gamesChecked} games checked, ${boxScoreGames} with box scores`);

// ─── Phase 2: publicProfileStatistics for player records ─────────────────────

console.log('\n── Phase 2: Player records via API (all public players, all games) ──');

const HEADERS_API = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};


// ─── Phase 2: player single-game records (local — no API calls) ───────────────
// Sources leaderboard/all-time.json maxGamePTS / maxGameThreePt entries,
// then reads player.records for the gameKey to look up game context.

console.log(`\n── Phase 2: Player records (from leaderboard + player files) ──────`);

const LB_PATH = path.join(ROOT, 'leaderboard', 'all-time.json');
let lbData = null;
try { lbData = readJson(LB_PATH); } catch {}

if (!lbData) {
  console.log('  leaderboard/all-time.json not found — skipping playerPTS/playerThreePt');
  console.log('  Run build-leaderboards.js first.');
} else {
  for (const [lbCat, recCat] of [['maxGamePTS', 'playerPTS'], ['maxGameThreePt', 'playerThreePt']]) {
    const entries = (lbData[lbCat] || []).slice(0, TOP_N * 2); // take extra in case some have no gameKey
    console.log(`  ${lbCat}: ${entries.length} leaderboard entries to process`);

    for (const entry of entries) {
      if (records[recCat].length >= TOP_N) break;

      const uuid       = entry.uuid;
      const playerFile = path.join(ROOT, 'players', uuid.slice(0, 2), `${uuid}.json`);
      let rec = null;
      try {
        const p = readJson(playerFile);
        rec = p.records?.[lbCat] || null;
      } catch {}

      const v       = rec?.v ?? entry.v;
      const gameKey = rec?.gameKey || null;
      const sid     = rec?.sid    || null;
      const info    = gameKey ? gameLookup.get(gameKey) : null;

      // Determine opponent from gameLookup if we have the gameKey
      let vs = '', score = '', date = '';
      if (info) {
        date  = info.d || '';
        score = `${info.hs ?? '?'}–${info.as ?? '?'}`;
        vs    = info.an || info.hn || '';
      }

      insertTop(records[recCat], {
        v, uuid,
        name:    entry.name || uuid,
        gameKey: gameKey || undefined,
        sid:     sid     || undefined,
        date,
        vs,
        score,
      });
    }

    console.log(`  ${recCat}: ${records[recCat].length} entries`);
  }
}



// Assign ranks and write final output
for (const key of Object.keys(records)) {
  const sortKey = key === 'closestGame' ? 'ratio' : 'v';
  rankArray(records[key], sortKey);
}

// Note box-score limitation on teamThreePt
records._notes = {
  teamThreePt: 'Based on stored box scores only — not all games have box score data stored',
};

if (!DRY_RUN) {
  writeJson(OUT_FILE, records);
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
  gitCommit(`build-records: complete — top ${TOP_N} per category`,
    ['records/all-time.json', 'scripts/.records-progress.json']);
}

console.log(`\n─── Top 1 per category ──────────────────────────────────────────────`);
console.log(`  Player PTS      : ${records.playerPTS[0]?.v ?? 0} — ${records.playerPTS[0]?.name} (${records.playerPTS[0]?.date}) [all public players]`);
console.log(`  Player 3PT      : ${records.playerThreePt[0]?.v ?? 0} — ${records.playerThreePt[0]?.name} (${records.playerThreePt[0]?.date}) [all public players]`);
console.log(`  Team PTS        : ${records.teamPTS[0]?.v ?? 0} — ${records.teamPTS[0]?.name} (${records.teamPTS[0]?.date}) [all games]`);
console.log(`  Team 3PT        : ${records.teamThreePt[0]?.v ?? 0} — ${records.teamThreePt[0]?.name} (${records.teamThreePt[0]?.date}) [box scores only]`);
console.log(`  Highest combined: ${records.highestCombined[0]?.v ?? 0} [all games]`);
console.log(`  Largest margin  : ${records.largestMargin[0]?.v ?? 0} [all games]`);
console.log(`  Closest game    : ${records.closestGame[0]?.score} ratio ${records.closestGame[0]?.ratio} [all games]`);
console.log(`  Games checked   : ${gamesChecked} | Box score games: ${boxScoreGames} | Players fetched: ${fetched}`);
console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
