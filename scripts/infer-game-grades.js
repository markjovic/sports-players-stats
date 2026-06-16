// scripts/infer-game-grades.js
//
// Infers per-game grade for regraded teams using local data only — no API calls.
//
// Problem: augment-game-grades.js assigned a team's FINAL grade to all games.
// Teams regraded mid-season have early games labelled with the wrong grade.
//
// Algorithm:
//   A regraded team played N games split into consecutive blocks by grade.
//   Sorting games by date, the split point t divides: games[0..t-1] in gradeA,
//   games[t..N-1] in gradeB. For each player with two regs (gradeA gp=X, gradeB gp=Y),
//   their appearances in [0..t-1] must equal X and in [t..N-1] must equal Y.
//   We find the t that maximises the number of players satisfying this constraint.
//
// Steps:
//   1. Load multi-grade season IDs from sports-index.json
//   2. Scan all player detail files — build playerRegs: uuid → {sid → regs[]}
//      for multi-grade seasons only (one pass, ~25s)
//   3. For each multi-grade season, load games file:
//      a. Group games by team (h/a), sort by date
//      b. For each team, collect multi-reg players from p arrays
//      c. Find split point(s) via constraint satisfaction
//      d. Assign gid/gn to each game block
//   4. Write updated games files, commit every 100 seasons
//
// Only updates games that currently have an incorrect or missing grade.
// Games already correctly graded (single-grade seasons, verified games) are skipped.
// Leaves games unchanged where no confident split can be determined.
//
// Run: node scripts/infer-game-grades.js
// Dry run: node scripts/infer-game-grades.js --dry-run

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const COMMIT_INTERVAL = 100;
// Minimum weighted score to accept a split point (sum of gp values of matching players)
// Low threshold means we accept even one matching player — raise if too many false positives
const MIN_SCORE = 1;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data), 'utf8'); }

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

// ─── step 1: load sports-index ───────────────────────────────────────────────

console.log('Loading sports-index.json...');
const sportsIndex = readJson(path.join(ROOT, 'sports-index.json'));

// sid → grades[] for multi-grade seasons only
const multiGradeSeasons = {};
for (const [sid, s] of Object.entries(sportsIndex.seasons)) {
  if ((s.grades || []).length > 1) {
    multiGradeSeasons[sid] = s.grades; // [{id, name}]
  }
}
console.log(`  ${Object.keys(multiGradeSeasons).length} multi-grade seasons`);

// ─── step 2: scan player detail files ────────────────────────────────────────
// Build: uuid → { [sid]: [{tid, gid, gn, gp}] }  — only for multi-grade seasons

console.log('Scanning player detail files for multi-grade season regs...');
const playerRegs = new Map(); // uuid → { sid → [{tid, gid, gn, gp}] }

const playersDir = path.join(ROOT, 'players');
const prefixDirs = fs.readdirSync(playersDir)
  .filter(d => /^[0-9a-f]{2}$/.test(d)).sort();

let playersScanned = 0;
let multiRegPlayers = 0;

for (const prefix of prefixDirs) {
  const prefixDir = path.join(playersDir, prefix);
  const files = fs.readdirSync(prefixDir).filter(f => f.endsWith('.json'));
  for (const fname of files) {
    let player;
    try { player = readJson(path.join(prefixDir, fname)); } catch { continue; }

    const uuid = player.uuid;
    const seasonMap = {};

    for (const season of (player.seasons || [])) {
      const sid = season.sid;
      if (!multiGradeSeasons[sid]) continue;
      if (!season.regs || season.regs.length === 0) continue;

      // Store all regs for this season — even single-reg players are useful
      // (they confirm which grade block a game belongs to)
      seasonMap[sid] = season.regs.map(r => ({
        tid: r.tid,
        gid: r.gid,
        gn:  r.gn,
        gp:  r.stats?.gp || 0,
      })).filter(r => r.tid && r.gid && r.gn);
    }

    if (Object.keys(seasonMap).length > 0) {
      playerRegs.set(uuid, seasonMap);
      multiRegPlayers++;
    }

    playersScanned++;
    if (playersScanned % 50000 === 0) console.log(`  ${playersScanned} players scanned...`);
  }
}

console.log(`  ${playersScanned} players scanned`);
console.log(`  ${multiRegPlayers} players with multi-grade season data stored`);

// ─── step 3: process games by season ─────────────────────────────────────────

console.log('\nProcessing multi-grade season game files...');
const gamesDir = path.join(ROOT, 'games', 'bv');

let seasonsProcessed  = 0;
let gamesUpdated      = 0;
let gamesSkipped      = 0;
let teamsInferred     = 0;
let teamsAmbiguous    = 0;
let sinceLastCommit   = 0;

for (const sid of Object.keys(multiGradeSeasons)) {
  const gamesFile = path.join(gamesDir, `${sid}.json`);
  let gf;
  try { gf = readJson(gamesFile); } catch { continue; }

  const games = gf.games || {};

  // Group game IDs by team, collect dates for sorting
  // teamGames: tid → [{gameId, date, gameEntry}]
  const teamGames = new Map();
  for (const [gameId, g] of Object.entries(games)) {
    for (const tid of [g.h, g.a, g.t1, g.t2]) {
      if (!tid) continue;
      if (!teamGames.has(tid)) teamGames.set(tid, []);
      teamGames.get(tid).push({ gameId, date: g.d || '', g });
    }
  }

  // Sort each team's games by date ascending
  for (const [, gList] of teamGames) {
    gList.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  }

  let fileModified = false;

  for (const [tid, gList] of teamGames) {
    const n = gList.length;
    if (n < 2) continue;

    // Collect players with regs for this (sid, tid)
    // playerData: uuid → {regs: [{gid, gn, gp}], appearances: Set<gameIndex>}
    const playerData = new Map();

    for (let i = 0; i < n; i++) {
      const { g } = gList[i];
      for (const pEntry of (g.p || [])) {
        const uuid = pEntry.id;
        if (!uuid) continue;
        const seasonData = playerRegs.get(uuid)?.[sid];
        if (!seasonData) continue;
        // Only care about players registered to this team
        const regsForTeam = seasonData.filter(r => r.tid === tid);
        if (regsForTeam.length === 0) continue;

        if (!playerData.has(uuid)) {
          playerData.set(uuid, { regs: regsForTeam, appearances: new Set() });
        }
        playerData.get(uuid).appearances.add(i);
      }
    }

    // Find players with multiple regs for this team — these constrain the split
    const multiRegForTeam = [...playerData.values()].filter(pd => pd.regs.length > 1);
    if (multiRegForTeam.length === 0) continue; // no regrading evidence for this team

    // ── find best split point ────────────────────────────────────────────────
    // For each candidate split t (0..n), score = sum of gp values of players
    // whose appearance counts exactly match one ordering of their regs.
    // Also track what grade ordering each t implies.

    let bestT    = -1;
    let bestScore = 0;
    // gradeOrderAtT[t] = [{firstGid, firstGn, secondGid, secondGn}] votes
    const gradeOrderVotes = new Array(n + 1).fill(null).map(() => new Map());

    for (let t = 0; t <= n; t++) {
      let score = 0;

      for (const { regs, appearances } of multiRegForTeam) {
        const beforeT = [...appearances].filter(i => i < t).length;
        const afterT  = [...appearances].filter(i => i >= t).length;

        // Try each pair of consecutive regs as the split (handles 2+ regs)
        for (let r = 0; r < regs.length - 1; r++) {
          const regA = regs[r];
          const regB = regs[r + 1];

          // Order 1: regA first, regB second
          if (beforeT === regA.gp && afterT === regB.gp) {
            score += regA.gp + regB.gp;
            const key = `${regA.gid}::${regB.gid}`;
            gradeOrderVotes[t].set(key, (gradeOrderVotes[t].get(key) || 0) + regA.gp + regB.gp);
            break;
          }
          // Order 2: regB first, regA second
          if (beforeT === regB.gp && afterT === regA.gp) {
            score += regA.gp + regB.gp;
            const key = `${regB.gid}::${regA.gid}`;
            gradeOrderVotes[t].set(key, (gradeOrderVotes[t].get(key) || 0) + regA.gp + regB.gp);
            break;
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestT = t;
      }
    }

    if (bestT === -1 || bestScore < MIN_SCORE) {
      teamsAmbiguous++;
      continue;
    }

    // Determine grade ordering from votes at bestT
    const votes = gradeOrderVotes[bestT];
    if (votes.size === 0) { teamsAmbiguous++; continue; }

    // Pick the ordering with the highest vote weight
    let bestOrder = null;
    let bestVote  = 0;
    for (const [orderKey, weight] of votes) {
      if (weight > bestVote) {
        bestVote  = weight;
        bestOrder = orderKey;
      }
    }

    const [firstGid, secondGid] = bestOrder.split('::');

    // Look up grade names from the season's grades or from player regs
    const gradeNames = new Map(); // gid → gn
    for (const grade of (multiGradeSeasons[sid] || [])) {
      gradeNames.set(grade.id, grade.name);
    }
    // Also fill from player regs in case of sub-grades not in sports-index
    for (const pd of playerData.values()) {
      for (const r of pd.regs) {
        if (r.gid && r.gn) gradeNames.set(r.gid, r.gn);
      }
    }

    const firstGn  = gradeNames.get(firstGid)  || '';
    const secondGn = gradeNames.get(secondGid) || '';

    // ── assign grades to games ───────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const { gameId, g } = gList[i];
      const newGid = i < bestT ? firstGid  : secondGid;
      const newGn  = i < bestT ? firstGn   : secondGn;

      if (!newGid || !newGn) continue;
      if (g.gid === newGid && g.gn === newGn) { gamesSkipped++; continue; }

      g.gid = newGid;
      g.gn  = newGn;
      gamesUpdated++;
      fileModified = true;
    }

    teamsInferred++;
  }

  if (fileModified && !DRY_RUN) {
    writeJson(gamesFile, gf);
  }

  seasonsProcessed++;
  sinceLastCommit++;

  if (sinceLastCommit >= COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      gitCommit(
        `infer-game-grades: ${seasonsProcessed} seasons done, ${gamesUpdated} games updated`,
        ['games/bv/']
      );
    }
    sinceLastCommit = 0;
    console.log(`  progress: ${seasonsProcessed} seasons, ${gamesUpdated} games updated, ${teamsInferred} teams inferred, ${teamsAmbiguous} ambiguous`);
  }
}

if (!DRY_RUN && sinceLastCommit > 0) {
  gitCommit(
    `infer-game-grades: complete — ${seasonsProcessed} seasons, ${gamesUpdated} games updated`,
    ['games/bv/']
  );
}

console.log('\n─── Summary ────────────────────────────────────────────────');
console.log(`  Multi-grade seasons processed : ${seasonsProcessed}`);
console.log(`  Games grade updated           : ${gamesUpdated}`);
console.log(`  Games already correct         : ${gamesSkipped}`);
console.log(`  Teams grade inferred          : ${teamsInferred}`);
console.log(`  Teams ambiguous (no update)   : ${teamsAmbiguous}`);
console.log(`  Mode                          : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
