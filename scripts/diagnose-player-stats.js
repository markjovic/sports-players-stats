// scripts/diagnose-player-stats.js
//
// Investigates per-season stat aggregation for a specific player UUID.
// Compares:
//   1. Career totals from player detail file (sports.Basketball)
//   2. Per-season/reg totals from player detail file (seasons[].regs[].stats)
//   3. Per-season totals from team-stats/bv/{sid}.json roster entry
//   4. Individual game scores summed from games/bv/{sid}.json (hp/ap box scores)
//
// Outputs a full diagnostic report to stdout and writes a JSON report file.
//
// Run: node scripts/diagnose-player-stats.js <uuid>

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const uuid = process.argv[2];

if (!uuid) {
  console.error('Usage: node scripts/diagnose-player-stats.js <uuid>');
  process.exit(1);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function fmt(stats) {
  if (!stats) return '(null)';
  return `gp=${stats.gp ?? '?'} pts=${stats.pts ?? '?'} fg=${stats.fg ?? '?'} ft=${stats.ft ?? '?'} 3pt=${stats.threePt ?? '?'} f=${stats.fouls ?? '?'}`;
}

function sumStats(games) {
  const s = { gp: 0, pts: 0, fg: 0, ft: 0, threePt: 0, fouls: 0 };
  for (const g of games) {
    s.gp     += 1;
    s.pts    += g.pts    ?? 0;
    s.fg     += (g.pt2   ?? 0) + (g.pt3 ?? 0); // fg = 2pt + 3pt makes
    s.ft     += g.pt1    ?? 0;
    s.threePt+= g.pt3    ?? 0;
    s.fouls  += g.fouls  ?? 0;
  }
  return s;
}

const report = { uuid, player: null, seasons: [] };

// ─── 1. Load player detail file ──────────────────────────────────────────────

const playerPath = path.join(ROOT, 'players', uuid.slice(0, 2), `${uuid}.json`);
if (!fs.existsSync(playerPath)) {
  console.error(`Player file not found: ${playerPath}`);
  process.exit(1);
}

const player = readJson(playerPath);
report.player = player;

console.log('═'.repeat(70));
console.log(`PLAYER: ${player.name || uuid} (${uuid})`);
console.log(`Gender: ${player.gender || '?'}`);
console.log('─'.repeat(70));

const career = player.sports?.Basketball;
console.log(`\nCAREER TOTALS (player file → sports.Basketball):`);
console.log(`  ${fmt(career)}`);

// ─── 2. Per-season analysis ───────────────────────────────────────────────────

const teamStatsDir = path.join(ROOT, 'team-stats', 'bv');
const gamesDir     = path.join(ROOT, 'games', 'bv');

for (const season of (player.seasons || [])) {
  const sid = season.sid;
  const sn  = season.sn || sid;

  console.log('\n' + '─'.repeat(70));
  console.log(`SEASON: ${sn} (${sid})  club: ${season.club || '?'}`);

  const seasonReport = { sid, sn, club: season.club, regs: [], teamStats: [], gameSums: [] };

  // ── 2a. Regs from player file ─────────────────────────────────────────────
  for (const reg of (season.regs || [])) {
    console.log(`\n  REG: tid=${reg.tid} tn="${reg.tn}" gn="${reg.gn}" age=${reg.age}`);
    console.log(`    player file stats: ${fmt(reg.stats)}`);
    seasonReport.regs.push({ tid: reg.tid, tn: reg.tn, gn: reg.gn, stats: reg.stats });

    // ── 2b. Team-stats roster entry ─────────────────────────────────────────
    const tsPath = path.join(teamStatsDir, `${sid}.json`);
    let tsEntry = null;
    if (fs.existsSync(tsPath)) {
      try {
        const tsData = readJson(tsPath);
        const team   = tsData[reg.tid];
        if (team) {
          tsEntry = team.roster?.[uuid] || null;
          console.log(`    team-stats roster: ${fmt(tsEntry)}`);
        } else {
          console.log(`    team-stats: tid ${reg.tid} not found in ${sid}.json`);
        }
      } catch (e) {
        console.log(`    team-stats: error reading ${sid}.json — ${e.message}`);
      }
    } else {
      console.log(`    team-stats: file not found for sid ${sid}`);
    }
    seasonReport.teamStats.push({ tid: reg.tid, entry: tsEntry });

    // ── 2c. Sum individual game box scores ───────────────────────────────────
    // Look for hp/ap arrays in games where player appears in p[]
    const gfPath = path.join(gamesDir, `${sid}.json`);
    if (fs.existsSync(gfPath)) {
      try {
        const gf = readJson(gfPath);
        const playerGames  = [];
        const missingBoxScore = [];

        for (const [gameId, g] of Object.entries(gf.games || {})) {
          // Check if player is in this game's p array
          const inGame = (g.p || []).some(p => p.id === uuid);
          if (!inGame) continue;

          // Determine which side (home or away) based on team id
          const hTid = g.h || g.t1;
          const aTid = g.a || g.t2;
          const isHome = hTid === reg.tid;
          const isAway = aTid === reg.tid;

          // Try hp/ap box score
          const boxSide = isHome ? g.hp : isAway ? g.ap : null;
          const playerBoxEntry = (boxSide || []).find(p => p.profileID === uuid);

          if (playerBoxEntry) {
            playerGames.push({
              gameId,
              date: g.d,
              pts:    playerBoxEntry.pts    ?? 0,
              pt1:    playerBoxEntry.pt1    ?? 0,
              pt2:    playerBoxEntry.pt2    ?? 0,
              pt3:    playerBoxEntry.pt3    ?? 0,
              fouls:  playerBoxEntry.fouls  ?? 0,
            });
          } else {
            missingBoxScore.push({ gameId, date: g.d, flags: {
              hidden: g.hidden || false,
              profileOnly: g.profileOnly || false,
              forfeit: g.forfeit || false,
              legacy: g.legacy || false,
            }});
          }
        }

        const gameSum = sumStats(playerGames);
        console.log(`    game box scores: ${playerGames.length} games with data, ${missingBoxScore.length} missing`);
        console.log(`    game sum:        ${fmt(gameSum)}`);

        // Compare
        const regStats = reg.stats || {};
        const diffs = [];
        for (const k of ['gp','pts','fouls']) {
          const a = regStats[k] ?? 0;
          const b = gameSum[k]  ?? 0;
          if (a !== b) diffs.push(`${k}: playerFile=${a} gameSum=${b} diff=${a-b}`);
        }
        if (diffs.length) {
          console.log(`    ⚠ MISMATCHES: ${diffs.join(' | ')}`);
        } else if (playerGames.length > 0) {
          console.log(`    ✓ player file stats match game sums`);
        }

        if (missingBoxScore.length > 0) {
          const flagCounts = {};
          for (const m of missingBoxScore) {
            for (const [f, v] of Object.entries(m.flags)) {
              if (v) flagCounts[f] = (flagCounts[f] || 0) + 1;
            }
          }
          console.log(`    missing box score breakdown: ${JSON.stringify(flagCounts)}`);
        }

        seasonReport.gameSums.push({
          tid: reg.tid,
          gamesWithData: playerGames.length,
          gamesMissingBoxScore: missingBoxScore.length,
          gameSum,
          missingGames: missingBoxScore,
        });

      } catch (e) {
        console.log(`    games: error reading ${sid}.json — ${e.message}`);
      }
    } else {
      console.log(`    games: file not found for sid ${sid}`);
    }
  }

  report.seasons.push(seasonReport);
}

// ─── 3. Career total cross-check ─────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log('CAREER CROSS-CHECK:');

const regSum = { gp: 0, pts: 0, fouls: 0 };
for (const season of (player.seasons || [])) {
  for (const reg of (season.regs || [])) {
    regSum.gp    += reg.stats?.gp    ?? 0;
    regSum.pts   += reg.stats?.pts   ?? 0;
    regSum.fouls += reg.stats?.fouls ?? 0;
  }
}

console.log(`  Sum of all reg stats:   gp=${regSum.gp} pts=${regSum.pts} fouls=${regSum.fouls}`);
console.log(`  Career (sports.Bball):  ${fmt(career)}`);

const careerDiffs = [];
for (const k of ['gp','pts','fouls']) {
  const a = career?.[k] ?? 0;
  const b = regSum[k]   ?? 0;
  if (a !== b) careerDiffs.push(`${k}: career=${a} regSum=${b} diff=${a-b}`);
}
if (careerDiffs.length) {
  console.log(`  ⚠ CAREER vs REG SUM MISMATCHES: ${careerDiffs.join(' | ')}`);
} else {
  console.log(`  ✓ career total matches sum of reg stats`);
}

// ─── 4. Write JSON report ─────────────────────────────────────────────────────

const outPath = path.join(ROOT, `diagnose-${uuid}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(`\nFull report written to: diagnose-${uuid}.json`);
