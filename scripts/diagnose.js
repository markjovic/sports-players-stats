// scripts/diagnose.js
//
// Consolidated diagnostic tool. Replaces:
//   inspect-player-file.js, inspect-hidden-reclassified.js,
//   diagnose-player-stats.js, find-game-id.js
//
// Modes:
//   node scripts/diagnose.js player   <uuid>    — inspect raw player file structure
//   node scripts/diagnose.js stats    <uuid>    — deep stat cross-check (player/team-stats/game sums)
//   node scripts/diagnose.js hidden              — show games reclassified as hidden in recent commits
//   node scripts/diagnose.js game     <gameId>  — find game ID across all season files

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT      = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games', 'bv');

const MODE = process.argv[2];
const ARG  = process.argv[3];

if (!MODE || !['player', 'stats', 'hidden', 'game'].includes(MODE)) {
  console.error([
    'Usage:',
    '  node scripts/diagnose.js player  <uuid>   — inspect raw player file structure',
    '  node scripts/diagnose.js stats   <uuid>   — deep stat cross-check',
    '  node scripts/diagnose.js hidden           — show recently reclassified hidden games',
    '  node scripts/diagnose.js game    <gameId> — find game across all season files',
  ].join('\n'));
  process.exit(1);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ─── MODE: player ────────────────────────────────────────────────────────────
// Inspect the raw structure of a player file.

function modePlayer(uuid) {
  if (!uuid) { console.error('Usage: node scripts/diagnose.js player <uuid>'); process.exit(1); }

  const file = path.join(ROOT, 'players', uuid.slice(0, 2), `${uuid}.json`);
  if (!fs.existsSync(file)) { console.error(`Not found: ${file}`); process.exit(1); }

  const p = readJson(file);

  console.log('\nPlayer:', p.name || '(private)');
  console.log('UUID:', p.uuid);
  console.log('Top-level keys:', Object.keys(p).join(', '));
  console.log('Season count:', (p.seasons || []).length);

  const career = p.sports?.Basketball;
  if (career) {
    console.log('\nCareer (sports.Basketball):');
    console.log(' ', JSON.stringify(career, null, 2).replace(/\n/g, '\n  '));
  }

  const s = (p.seasons || [])[0];
  if (!s) { console.log('No seasons'); return; }

  console.log('\nFirst season:', s.sid, s.sn);
  console.log('Season keys:', Object.keys(s).join(', '));

  const r = (s.regs || [])[0];
  if (!r) { console.log('No regs'); return; }

  console.log('\nFirst reg keys:', Object.keys(r).join(', '));
  console.log('Reg stats:', JSON.stringify(r.stats));

  if (r.games?.length) {
    console.log('\nGames array present:', r.games.length, 'entries');
    console.log('games[0]:', JSON.stringify(r.games[0]));
  } else {
    console.log('\nNo games array on reg — only aggregate stats');
  }
}

// ─── MODE: stats ─────────────────────────────────────────────────────────────
// Deep cross-check: player file vs team-stats roster vs game box score sums.

function fmtStats(stats) {
  if (!stats) return '(null)';
  return `gp=${stats.gp ?? '?'} pts=${stats.pts ?? '?'} fg=${stats.fg ?? '?'} ft=${stats.ft ?? '?'} 3pt=${stats.threePt ?? '?'} f=${stats.fouls ?? '?'}`;
}

function sumBoxScores(games) {
  const s = { gp: 0, pts: 0, fg: 0, ft: 0, threePt: 0, fouls: 0 };
  for (const g of games) {
    s.gp     += 1;
    s.pts    += g.pts   ?? 0;
    s.fg     += (g.pt2  ?? 0) + (g.pt3 ?? 0);
    s.ft     += g.pt1   ?? 0;
    s.threePt+= g.pt3   ?? 0;
    s.fouls  += g.fouls ?? 0;
  }
  return s;
}

function modeStats(uuid) {
  if (!uuid) { console.error('Usage: node scripts/diagnose.js stats <uuid>'); process.exit(1); }

  const playerPath = path.join(ROOT, 'players', uuid.slice(0, 2), `${uuid}.json`);
  if (!fs.existsSync(playerPath)) { console.error(`Player file not found: ${playerPath}`); process.exit(1); }

  const player = readJson(playerPath);
  const career = player.sports?.Basketball;

  console.log('═'.repeat(70));
  console.log(`PLAYER: ${player.name || uuid} (${uuid})`);
  console.log(`Gender: ${player.gender || '?'}`);
  console.log('─'.repeat(70));
  console.log(`\nCAREER TOTALS (sports.Basketball):\n  ${fmtStats(career)}`);

  const teamStatsDir = path.join(ROOT, 'team-stats', 'bv');

  for (const season of (player.seasons || [])) {
    const sid = season.sid;
    const sn  = season.sn || sid;

    console.log('\n' + '─'.repeat(70));
    console.log(`SEASON: ${sn} (${sid})  club: ${season.club || '?'}`);

    for (const reg of (season.regs || [])) {
      console.log(`\n  REG: tid=${reg.tid} tn="${reg.tn}" gn="${reg.gn}" age=${reg.age}`);
      console.log(`    player file stats: ${fmtStats(reg.stats)}`);

      // team-stats roster
      const tsPath = path.join(teamStatsDir, `${sid}.json`);
      if (fs.existsSync(tsPath)) {
        try {
          const ts   = readJson(tsPath);
          const team = ts[reg.tid];
          if (team) {
            console.log(`    team-stats roster: ${fmtStats(team.roster?.[uuid])}`);
          } else {
            console.log(`    team-stats: tid ${reg.tid} not found in ${sid}.json`);
          }
        } catch (e) {
          console.log(`    team-stats: error — ${e.message}`);
        }
      } else {
        console.log(`    team-stats: no file for sid ${sid}`);
      }

      // game box score sums
      const gfPath = path.join(GAMES_DIR, `${sid}.json`);
      if (fs.existsSync(gfPath)) {
        try {
          const gf           = readJson(gfPath);
          const playerGames  = [];
          const missingBox   = [];

          for (const [gameId, g] of Object.entries(gf.games || {})) {
            if (!(g.p || []).some(p => p.id === uuid)) continue;

            const hTid     = g.h || g.t1;
            const aTid     = g.a || g.t2;
            const isHome   = hTid === reg.tid;
            const isAway   = aTid === reg.tid;
            const boxSide  = isHome ? g.hp : isAway ? g.ap : null;
            const entry    = (boxSide || []).find(p => p.profileID === uuid);

            if (entry) {
              playerGames.push({ gameId, date: g.d,
                pts: entry.pts ?? 0, pt1: entry.pt1 ?? 0, pt2: entry.pt2 ?? 0,
                pt3: entry.pt3 ?? 0, fouls: entry.fouls ?? 0 });
            } else {
              missingBox.push({ gameId, flags: { hidden: g.hidden || false,
                profileOnly: g.profileOnly || false, forfeit: g.forfeit || false,
                legacy: g.legacy || false } });
            }
          }

          const gameSum = sumBoxScores(playerGames);
          console.log(`    game box scores: ${playerGames.length} with data, ${missingBox.length} missing`);
          console.log(`    game sum: ${fmtStats(gameSum)}`);

          const regStats = reg.stats || {};
          const diffs = ['gp','pts','fouls'].filter(k => (regStats[k] ?? 0) !== (gameSum[k] ?? 0))
            .map(k => `${k}: playerFile=${regStats[k] ?? 0} gameSum=${gameSum[k] ?? 0} diff=${(regStats[k] ?? 0) - (gameSum[k] ?? 0)}`);
          if (diffs.length) {
            console.log(`    ⚠ MISMATCHES: ${diffs.join(' | ')}`);
          } else if (playerGames.length > 0) {
            console.log(`    ✓ player file stats match game sums`);
          }

          if (missingBox.length > 0) {
            const flagCounts = {};
            for (const m of missingBox) {
              for (const [f, v] of Object.entries(m.flags)) {
                if (v) flagCounts[f] = (flagCounts[f] || 0) + 1;
              }
            }
            console.log(`    missing box score breakdown: ${JSON.stringify(flagCounts)}`);
          }
        } catch (e) {
          console.log(`    games: error — ${e.message}`);
        }
      } else {
        console.log(`    games: no file for sid ${sid}`);
      }
    }
  }

  // Career cross-check
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
  console.log(`  Career (sports.Bball):  ${fmtStats(career)}`);

  const careerDiffs = ['gp','pts','fouls'].filter(k => (career?.[k] ?? 0) !== (regSum[k] ?? 0))
    .map(k => `${k}: career=${career?.[k] ?? 0} regSum=${regSum[k] ?? 0} diff=${(career?.[k] ?? 0) - (regSum[k] ?? 0)}`);
  if (careerDiffs.length) {
    console.log(`  ⚠ CAREER vs REG SUM MISMATCHES: ${careerDiffs.join(' | ')}`);
  } else {
    console.log(`  ✓ career total matches sum of reg stats`);
  }

  // Write JSON report
  const outPath = path.join(ROOT, `diagnose-${uuid}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ uuid, player }, null, 2));
  console.log(`\nFull report written to: diagnose-${uuid}.json`);
}

// ─── MODE: hidden ─────────────────────────────────────────────────────────────
// Show games reclassified as hidden in recent git commits.

function modeHidden() {
  const log = execSync(
    'git log --oneline --grep="reclassified as hidden" -5',
    { cwd: ROOT, stdio: 'pipe' }
  ).toString().trim();

  if (!log) { console.log('No recent reclassification commits found.'); return; }

  console.log('Recent reclassification commits:\n' + log + '\n');

  const commitHash = log.split('\n')[0].split(' ')[0];
  console.log(`Inspecting commit: ${commitHash}\n`);

  const diff = execSync(
    `git show --name-only --format="" ${commitHash}`,
    { cwd: ROOT, stdio: 'pipe' }
  ).toString().trim();

  const changedFiles = diff.split('\n').map(f => f.trim()).filter(f => f.startsWith('games/bv/'));
  console.log(`Changed game files: ${changedFiles.length}\n`);

  const sportsIndex = readJson(path.join(ROOT, 'sports-index.json'));
  const seasonNames = {}, gradeNames = {};
  for (const season of Object.values(sportsIndex.seasons || {})) {
    seasonNames[season.id] = season.fullName || season.name;
    for (const grade of (season.grades || [])) gradeNames[grade.id] = grade.name;
  }

  let totalFound = 0;

  for (const filePath of changedFiles) {
    const sid = path.basename(filePath, '.json');

    let before = { games: {} }, after;
    try {
      before = JSON.parse(execSync(`git show ${commitHash}^:${filePath}`,
        { cwd: ROOT, stdio: 'pipe', maxBuffer: 500 * 1024 * 1024 }).toString());
    } catch (e) {
      console.log(`  [before] read failed: ${e.message.slice(0, 80)}`);
    }
    try {
      after = JSON.parse(execSync(`git show ${commitHash}:${filePath}`,
        { cwd: ROOT, stdio: 'pipe', maxBuffer: 500 * 1024 * 1024 }).toString());
    } catch (e) {
      console.log(`  [after] read failed: ${e.message.slice(0, 80)}`);
      continue;
    }

    const afterGames  = after.games  || after  || {};
    const beforeGames = before.games || before || {};

    const reclassified = [];
    for (const [gameId, game] of Object.entries(afterGames)) {
      if (!game.hidden || beforeGames[gameId]?.hidden) continue;
      reclassified.push({ gameId, game });
    }

    if (reclassified.length === 0) continue;

    const seasonName = seasonNames[sid] || sid;
    console.log(`\n── ${seasonName} (${sid}) — ${reclassified.length} games ──`);

    const byGrade = {};
    for (const { gameId, game } of reclassified) {
      const gid = game.gid || 'unknown';
      if (!byGrade[gid]) byGrade[gid] = [];
      byGrade[gid].push({ gameId, game });
    }

    for (const [gid, games] of Object.entries(byGrade)) {
      const gradeName = gradeNames[gid] || games[0]?.game?.gn || gid;
      console.log(`  Grade: ${gradeName} (gid=${gid})`);
      for (const { gameId, game } of games) {
        const home = game.hn || game.t1n || '?';
        const away = game.an || game.t2n || '?';
        console.log(`    gameId=${gameId}  date=${game.d || '?'}  rn=${game.rn || '?'}  ${home} vs ${away}`);
      }
      totalFound += games.length;
    }
  }

  console.log(`\n── Total reclassified: ${totalFound} ──`);
}

// ─── MODE: game ───────────────────────────────────────────────────────────────
// Find a game ID across all season files.

function modeGame(gameId) {
  if (!gameId) { console.error('Usage: node scripts/diagnose.js game <gameId>'); process.exit(1); }

  console.log(`\nSearching for game ID: ${gameId}\n`);
  let found = 0;

  for (const file of fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'))) {
    let sg;
    try { sg = readJson(path.join(GAMES_DIR, file)); } catch (e) { continue; }
    const g = sg.games?.[gameId];
    if (!g) continue;
    found++;
    console.log(`Found in: ${file}`);
    console.log(`  st=${g.st} hidden=${g.hidden} rn=${g.rn} d=${g.d}`);
    console.log(`  h=${g.h} a=${g.a} hs=${g.hs} as=${g.as}`);
    console.log(`  vid=${g.vid} spc=${g.spc}`);
    const flags = ['hidden','profileOnly','forfeit','legacy','cancelled','abandoned'].filter(f => g[f]);
    if (flags.length) console.log(`  flags: ${flags.join(', ')}`);
  }

  if (!found) console.log('Not found in any season file.');
  console.log('\nDone.');
}

// ─── dispatch ─────────────────────────────────────────────────────────────────

switch (MODE) {
  case 'player': modePlayer(ARG); break;
  case 'stats':  modeStats(ARG);  break;
  case 'hidden': modeHidden();    break;
  case 'game':   modeGame(ARG);   break;
}
