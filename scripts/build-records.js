// scripts/build-records.js
//
// Scans all games/bv/{sid}.json files to find all-time single-game records.
// Tracks top N for each category rather than just the single best.
//
// Player records (from hp/ap box score arrays):
//   playerPTS     — most points in a single game
//   playerThreePt — most 3-pointers in a single game
//
// Team records:
//   teamPTS       — most points scored by one team in a single game
//   teamThreePt   — most 3-pointers by one team in a single game
//
// Game records:
//   highestCombined — highest combined score (both teams)
//   largestMargin   — largest winning margin
//   closestGame     — closest non-draw game by min/max score ratio
//
// Output: records/all-time.json
// Each category is an array of up to TOP_N entries sorted best first.
//
// Run:     node scripts/build-records.js
// Dry run: node scripts/build-records.js --dry-run
// Force:   node scripts/build-records.js --force  (ignore resume progress)

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT            = path.join(__dirname, '..');
const DRY_RUN         = process.argv.includes('--dry-run');
const FORCE           = process.argv.includes('--force');
const TOP_N           = 50;
const COMMIT_INTERVAL = 200;
const PROGRESS_FILE   = path.join(ROOT, 'scripts', '.records-progress.json');
const OUT_FILE        = path.join(ROOT, 'records', 'all-time.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8'); }

function gitCommit(message, dirs) {
  try {
    execSync(`git add ${dirs.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ committed: ${message}`);
  } catch (e) {
    console.error(`  ✗ git error: ${e.message}`);
  }
}

// Insert entry into top-N array sorted descending by sortKey
// Entries with identical sort values are both kept until the array exceeds TOP_N
function insertTop(arr, entry, sortKey = 'v') {
  arr.push(entry);
  arr.sort((a, b) => b[sortKey] - a[sortKey]);
  if (arr.length > TOP_N) arr.length = TOP_N;
}

// Add rank field to each entry in a top-N array (handles ties)
function rankArray(arr, sortKey = 'v') {
  let rank = 1;
  for (let i = 0; i < arr.length; i++) {
    if (i > 0 && arr[i][sortKey] < arr[i - 1][sortKey]) rank = i + 1;
    arr[i].rank = rank;
  }
  return arr;
}

const EMPTY_RECORDS = () => ({
  playerPTS:       [],
  playerThreePt:   [],
  teamPTS:         [],
  teamThreePt:     [],
  highestCombined: [],
  largestMargin:   [],
  closestGame:     [],
});

// Ensure output directory exists
const recordsDir = path.join(ROOT, 'records');
if (!fs.existsSync(recordsDir)) fs.mkdirSync(recordsDir, { recursive: true });

// Load progress
let progress = { scannedSids: [], records: EMPTY_RECORDS() };
if (!FORCE && fs.existsSync(PROGRESS_FILE)) {
  try { progress = readJson(PROGRESS_FILE); } catch {}
} else if (FORCE) {
  console.log('  --force: clearing progress, full re-scan');
}
const scannedSids = new Set(progress.scannedSids || []);
const records     = { ...EMPTY_RECORDS(), ...progress.records };

// Ensure all arrays exist (in case new categories added)
for (const key of Object.keys(EMPTY_RECORDS())) {
  if (!Array.isArray(records[key])) records[key] = [];
}

// Scan game files
const gamesDir = path.join(ROOT, 'games', 'bv');
const sids = fs.readdirSync(gamesDir)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''))
  .sort();

const sidsToScan = sids.filter(s => !scannedSids.has(s));
console.log(`── Scanning game files for top-${TOP_N} single-game records ────────────`);
console.log(`  ${sids.length} season files, ${scannedSids.size} already scanned, ${sidsToScan.length} remaining`);

let sinceLastCommit = 0;
let gamesChecked    = 0;
let boxScoreGames   = 0;

for (const sid of sidsToScan) {
  let gf;
  try { gf = readJson(path.join(gamesDir, `${sid}.json`)); } catch { scannedSids.add(sid); continue; }

  for (const [gameId, g] of Object.entries(gf.games || {})) {
    if (g.forfeit) continue;

    const hs   = g.hs ?? null;
    const as_  = g.as ?? null;
    const date = g.d  || '';
    const hn   = g.hn || '';
    const an   = g.an || '';
    gamesChecked++;

    // Game records — require both scores > 0
    if (hs != null && as_ != null && hs > 0 && as_ > 0) {
      const combined  = hs + as_;
      const margin    = Math.abs(hs - as_);
      const ratio     = Math.min(hs, as_) / Math.max(hs, as_);
      const scoreStr  = `${hs}–${as_}`;
      const winnerName = hs > as_ ? hn : an;
      const loserName  = hs > as_ ? an : hn;

      const worstCombined = records.highestCombined.at(-1)?.v ?? 0;
      if (combined > worstCombined || records.highestCombined.length < TOP_N) {
        insertTop(records.highestCombined, {
          v: combined, gid: gameId, sid, date,
          home: `${hn} ${hs}`, away: `${an} ${as_}`,
        });
      }

      const worstMargin = records.largestMargin.at(-1)?.v ?? 0;
      if (margin > worstMargin || records.largestMargin.length < TOP_N) {
        insertTop(records.largestMargin, {
          v: margin, gid: gameId, sid, date,
          winner: winnerName, loser: loserName, score: scoreStr,
        });
      }

      // Closest: exclude draws (ratio === 1.0), sort descending by ratio
      if (hs !== as_) {
        const worstRatio = records.closestGame.at(-1)?.ratio ?? 0;
        if (ratio > worstRatio || records.closestGame.length < TOP_N) {
          insertTop(records.closestGame, {
            ratio: Math.round(ratio * 100000) / 100000,
            gid: gameId, sid, date, score: scoreStr, home: hn, away: an,
          }, 'ratio');
        }
      }
    }

    // Team score record
    if (hs != null) {
      const worstTeamPTS = records.teamPTS.at(-1)?.v ?? 0;
      if (hs > worstTeamPTS || records.teamPTS.length < TOP_N) {
        insertTop(records.teamPTS, {
          v: hs, gid: gameId, sid, date,
          name: hn, tid: g.h || g.t1 || null, vs: an, score: `${hs}–${as_ ?? '?'}`,
        });
      }
    }
    if (as_ != null) {
      const worstTeamPTS = records.teamPTS.at(-1)?.v ?? 0;
      if (as_ > worstTeamPTS || records.teamPTS.length < TOP_N) {
        insertTop(records.teamPTS, {
          v: as_, gid: gameId, sid, date,
          name: an, tid: g.a || g.t2 || null, vs: hn, score: `${hs ?? '?'}–${as_}`,
        });
      }
    }

    // Box score records
    const sides = [
      { key: 'hp', teamName: hn, tid: g.h || g.t1 || null, vsName: an },
      { key: 'ap', teamName: an, tid: g.a || g.t2 || null, vsName: hn },
    ];

    for (const { key, teamName, tid, vsName } of sides) {
      const box = g[key];
      if (!Array.isArray(box) || box.length === 0) continue;
      boxScoreGames++;

      let teamThreePt = 0;
      const scoreStr  = `${hs ?? '?'}–${as_ ?? '?'}`;

      for (const entry of box) {
        const uuid    = entry.profileID;
        if (!uuid) continue;
        const name    = entry.name || 'Unknown';
        const pts     = entry.pts  ?? 0;
        const threePt = entry.pt3  ?? 0;

        teamThreePt += threePt;

        if (pts > 0) {
          const worstPTS = records.playerPTS.at(-1)?.v ?? 0;
          if (pts > worstPTS || records.playerPTS.length < TOP_N) {
            insertTop(records.playerPTS, {
              v: pts, uuid, name, gid: gameId, sid, date, vs: vsName, score: scoreStr,
            });
          }
        }

        if (threePt > 0) {
          const worstThreePt = records.playerThreePt.at(-1)?.v ?? 0;
          if (threePt > worstThreePt || records.playerThreePt.length < TOP_N) {
            insertTop(records.playerThreePt, {
              v: threePt, uuid, name, gid: gameId, sid, date, vs: vsName, score: scoreStr,
            });
          }
        }
      }

      if (teamThreePt > 0) {
        const worstTeamThreePt = records.teamThreePt.at(-1)?.v ?? 0;
        if (teamThreePt > worstTeamThreePt || records.teamThreePt.length < TOP_N) {
          insertTop(records.teamThreePt, {
            v: teamThreePt, gid: gameId, sid, date,
            name: teamName, tid, vs: vsName, score: scoreStr,
          });
        }
      }
    }
  }

  scannedSids.add(sid);
  sinceLastCommit++;

  if (sinceLastCommit >= COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      writeJson(PROGRESS_FILE, { scannedSids: [...scannedSids], records });
      writeJson(OUT_FILE, records);
      gitCommit(
        `build-records: ${scannedSids.size}/${sids.length} seasons scanned`,
        ['scripts/.records-progress.json', 'records/all-time.json']
      );
    }
    sinceLastCommit = 0;
    console.log(`  ${scannedSids.size}/${sids.length} seasons — top playerPTS: ${records.playerPTS[0]?.v ?? 0}, highestCombined: ${records.highestCombined[0]?.v ?? 0}`);
  }
}

// Assign ranks and write final output
for (const key of Object.keys(records)) {
  const sortKey = key === 'closestGame' ? 'ratio' : 'v';
  rankArray(records[key], sortKey);
}

if (!DRY_RUN) {
  writeJson(OUT_FILE, records);
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
  gitCommit(
    `build-records: complete — top ${TOP_N} per category`,
    ['records/all-time.json', 'scripts/.records-progress.json']
  );
}

console.log(`\n─── Top 1 per category ──────────────────────────────────────────────`);
console.log(`  Player PTS      : ${records.playerPTS[0]?.v ?? 0} — ${records.playerPTS[0]?.name} (${records.playerPTS[0]?.date})`);
console.log(`  Player 3PT      : ${records.playerThreePt[0]?.v ?? 0} — ${records.playerThreePt[0]?.name} (${records.playerThreePt[0]?.date})`);
console.log(`  Team PTS        : ${records.teamPTS[0]?.v ?? 0} — ${records.teamPTS[0]?.name} (${records.teamPTS[0]?.date})`);
console.log(`  Team 3PT        : ${records.teamThreePt[0]?.v ?? 0} — ${records.teamThreePt[0]?.name} (${records.teamThreePt[0]?.date})`);
console.log(`  Highest combined: ${records.highestCombined[0]?.v ?? 0} — ${records.highestCombined[0]?.home} vs ${records.highestCombined[0]?.away}`);
console.log(`  Largest margin  : ${records.largestMargin[0]?.v ?? 0} — ${records.largestMargin[0]?.winner} def ${records.largestMargin[0]?.loser} ${records.largestMargin[0]?.score}`);
console.log(`  Closest game    : ${records.closestGame[0]?.score} ratio ${records.closestGame[0]?.ratio}`);
console.log(`\n  Games checked        : ${gamesChecked}`);
console.log(`  Games with box scores: ${boxScoreGames}`);
console.log(`  Mode                 : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
