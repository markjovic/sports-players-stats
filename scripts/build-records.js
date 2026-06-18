// scripts/build-records.js
//
// Scans all games/bv/{sid}.json files to find all-time single-game records.
//
// Player records (from hp/ap box score arrays):
//   playerPTS     — most points in a single game
//   playerThreePt — most 3-pointers in a single game
//
// Team records:
//   teamPTS       — most points scored by one team in a single game
//   teamThreePt   — most 3-pointers by one team in a single game (from box scores)
//
// Game records (from hs/as scores):
//   highestCombined — highest combined score (both teams)
//   largestMargin   — largest winning margin
//   closestGame     — closest non-draw game by min/max score ratio
//
// Only completed, non-forfeit games with both scores > 0 count for game records.
// Forfeits and draws are excluded from closestGame.
//
// Output: records/all-time.json
//
// Run:     node scripts/build-records.js
// Dry run: node scripts/build-records.js --dry-run
// Resume:  node scripts/build-records.js  (progress saved every 200 seasons)

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT     = path.join(__dirname, '..');
const DRY_RUN  = process.argv.includes('--dry-run');
const FORCE    = process.argv.includes('--force');
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

// Ensure output directory exists
const recordsDir = path.join(ROOT, 'records');
if (!fs.existsSync(recordsDir)) fs.mkdirSync(recordsDir, { recursive: true });

// ─── Record holders ───────────────────────────────────────────────────────────

const EMPTY_RECORDS = {
  playerPTS:        { v: 0 },
  playerThreePt:    { v: 0 },
  teamPTS:          { v: 0 },
  teamThreePt:      { v: 0 },
  highestCombined:  { v: 0 },
  largestMargin:    { v: 0 },
  closestGame:      { ratio: 0 },
};

// ─── Load progress ────────────────────────────────────────────────────────────

let progress = { scannedSids: [], records: EMPTY_RECORDS };
if (!FORCE && fs.existsSync(PROGRESS_FILE)) {
  try { progress = readJson(PROGRESS_FILE); } catch {}
} else if (FORCE) {
  console.log('  --force: clearing progress, full re-scan');
}
const scannedSids = new Set(progress.scannedSids || []);
const records     = { ...EMPTY_RECORDS, ...progress.records };

// ─── Scan game files ──────────────────────────────────────────────────────────

const gamesDir = path.join(ROOT, 'games', 'bv');
const sids = fs.readdirSync(gamesDir)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''))
  .sort();

const sidsToScan = sids.filter(s => !scannedSids.has(s));
console.log(`── Scanning game files for single-game records ──────────────────────`);
console.log(`  ${sids.length} season files total, ${scannedSids.size} already scanned, ${sidsToScan.length} remaining`);

let sinceLastCommit = 0;
let gamesChecked    = 0;
let boxScoreGames   = 0;

for (const sid of sidsToScan) {
  let gf;
  try { gf = readJson(path.join(gamesDir, `${sid}.json`)); } catch { scannedSids.add(sid); continue; }

  for (const [gameId, g] of Object.entries(gf.games || {})) {
    // Skip forfeit games and games without scores
    if (g.forfeit) continue;

    const hs = g.hs ?? null;
    const as = g.as ?? null;
    const date = g.d || '';
    const hn = g.hn || g.n1 || '';
    const an = g.an || g.n2 || '';
    gamesChecked++;

    // ── Game records (require both scores > 0) ────────────────────────────────
    if (hs != null && as != null && hs > 0 && as > 0) {
      const combined = hs + as;
      const margin   = Math.abs(hs - as);
      const ratio    = Math.min(hs, as) / Math.max(hs, as);
      const winScore = Math.max(hs, as);
      const loseScore = Math.min(hs, as);
      const winnerName = hs > as ? hn : an;
      const loserName  = hs > as ? an : hn;
      const scoreStr = `${hs}–${as}`;

      if (combined > records.highestCombined.v) {
        records.highestCombined = {
          v: combined, gid: gameId, sid, date,
          home: `${hn} ${hs}`, away: `${an} ${as}`,
        };
      }

      if (margin > records.largestMargin.v) {
        records.largestMargin = {
          v: margin, gid: gameId, sid, date,
          winner: winnerName, loser: loserName, score: scoreStr,
        };
      }

      // Closest game — exclude draws (ratio === 1.0)
      if (hs !== as && ratio > records.closestGame.ratio) {
        records.closestGame = {
          ratio: Math.round(ratio * 10000) / 10000,
          gid: gameId, sid, date, score: scoreStr,
          home: hn, away: an,
        };
      }
    }

    // ── Team score record (hs/as individually) ────────────────────────────────
    if (hs != null && hs > records.teamPTS.v) {
      records.teamPTS = {
        v: hs, gid: gameId, sid, date,
        name: hn, tid: g.h || g.t1 || null, vs: an, score: `${hs}–${as ?? '?'}`,
      };
    }
    if (as != null && as > records.teamPTS.v) {
      records.teamPTS = {
        v: as, gid: gameId, sid, date,
        name: an, tid: g.a || g.t2 || null, vs: hn, score: `${hs ?? '?'}–${as}`,
      };
    }

    // ── Box score records ─────────────────────────────────────────────────────
    const sides = [
      { key: 'hp', teamName: hn, tid: g.h || g.t1 || null, vsName: an, vsScore: as, myScore: hs },
      { key: 'ap', teamName: an, tid: g.a || g.t2 || null, vsName: hn, vsScore: hs, myScore: as },
    ];

    for (const { key, teamName, tid, vsName, vsScore, myScore } of sides) {
      const box = g[key];
      if (!Array.isArray(box) || box.length === 0) continue;
      boxScoreGames++;

      let teamThreePt = 0;
      const scoreStr  = `${hs ?? '?'}–${as ?? '?'}`;

      for (const entry of box) {
        const uuid    = entry.profileID;
        const name    = entry.name || 'Unknown';
        const pts     = entry.pts    ?? 0;
        const threePt = entry.pt3    ?? 0;
        teamThreePt += threePt;

        if (pts > records.playerPTS.v) {
          records.playerPTS = {
            v: pts, uuid, name, gid: gameId, sid, date,
            vs: vsName, score: scoreStr,
          };
        }
        if (threePt > records.playerThreePt.v) {
          records.playerThreePt = {
            v: threePt, uuid, name, gid: gameId, sid, date,
            vs: vsName, score: scoreStr,
          };
        }
      }

      if (teamThreePt > records.teamThreePt.v) {
        records.teamThreePt = {
          v: teamThreePt, gid: gameId, sid, date,
          name: teamName, tid, vs: vsName, score: scoreStr,
        };
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
    console.log(`  ${scannedSids.size}/${sids.length} seasons — playerPTS: ${records.playerPTS.v} by ${records.playerPTS.name || '?'}, highestCombined: ${records.highestCombined.v}`);
  }
}

// ─── Write final output ───────────────────────────────────────────────────────

if (!DRY_RUN) {
  writeJson(OUT_FILE, records);
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
  gitCommit(
    `build-records: complete`,
    ['records/all-time.json', 'scripts/.records-progress.json']
  );
}

console.log('\n─── Records ─────────────────────────────────────────────────────────');
console.log(`  Player PTS record    : ${records.playerPTS.v} pts — ${records.playerPTS.name} (${records.playerPTS.date})`);
console.log(`  Player 3PT record    : ${records.playerThreePt.v} — ${records.playerThreePt.name} (${records.playerThreePt.date})`);
console.log(`  Team PTS record      : ${records.teamPTS.v} — ${records.teamPTS.name} (${records.teamPTS.date})`);
console.log(`  Team 3PT record      : ${records.teamThreePt.v} — ${records.teamThreePt.name} (${records.teamThreePt.date})`);
console.log(`  Highest combined     : ${records.highestCombined.v} — ${records.highestCombined.home} vs ${records.highestCombined.away} (${records.highestCombined.date})`);
console.log(`  Largest margin       : ${records.largestMargin.v} — ${records.largestMargin.winner} def ${records.largestMargin.loser} ${records.largestMargin.score} (${records.largestMargin.date})`);
console.log(`  Closest game         : ${records.closestGame.score} ratio ${records.closestGame.ratio} (${records.closestGame.date})`);
console.log(`\n  Games checked        : ${gamesChecked}`);
console.log(`  Games with box scores: ${boxScoreGames}`);
console.log(`  Mode                 : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
