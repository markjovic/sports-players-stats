// migrate-phase2.js
// Migration Phase 2 for sports-players-stats.
//
// Phase 2A: Read all player detail files → write team-stats/bv/{seasonId}.json
//           with meta + roster per team. No fixtures yet.
// Phase 2B: Read all game files season by season → add fixtures to team-stats
//           files + accumulate venue-lookup entries in memory.
// Phase 2C: Write all venue-lookup/{venueId}/{YYYY-MM-DD}.json files.
//
// Run order: 2A must complete before 2B begins. 2C runs after 2B.
// Progress is saved to migrate-phase2-progress.json and committed at every
// interval so a timeout/cancel can resume safely.

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── config ────────────────────────────────────────────────────────────────────

const PLAYERS_DIR   = 'players';
const GAMES_DIR     = 'games/bv';
const TEAM_STATS    = 'team-stats/bv';
const VENUE_LOOKUP  = 'venue-lookup';
const PROGRESS_FILE = 'migrate-phase2-progress.json';

const COMMIT_EVERY_PLAYER_DIRS = 16;  // commit every 16 player dirs (256 total → 16 commits)
const COMMIT_EVERY_SEASONS     = 100; // commit every 100 seasons in Phase 2B
const COMMIT_EVERY_VENUE_BATCH = 50;  // commit every 50 venues in Phase 2C

// ── helpers ───────────────────────────────────────────────────────────────────

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

function gitCommit(message, paths) {
  try {
    execSync(`git add ${paths.join(' ')}`, { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log(`  committed: ${message}`);
  } catch (e) {
    console.error('  git commit failed:', e.message);
  }
}

// ── core logic (exported for tests) ──────────────────────────────────────────

function computeResult(myScore, oppScore) {
  if (typeof myScore !== 'number' || typeof oppScore !== 'number') return null;
  if (myScore > oppScore) return 'W';
  if (myScore < oppScore) return 'L';
  return 'D';
}

function gameTeams(game) {
  // Returns [{ id, name, isFirst }]. h/a takes priority over t1/t2.
  const teams = [];
  if (game.h) {
    teams.push({ id: game.h,  name: game.hn,  isFirst: true  });
    if (game.a) teams.push({ id: game.a, name: game.an, isFirst: false });
  } else {
    if (game.t1) teams.push({ id: game.t1, name: game.t1n, isFirst: true  });
    if (game.t2) teams.push({ id: game.t2, name: game.t2n, isFirst: false });
  }
  return teams;
}

function buildFixtureEntry(game, gameId, isFirst) {
  const teams = gameTeams(game);
  if (teams.length === 0) return null;
  const mine = teams.find(t => t.isFirst === isFirst);
  if (!mine) return null;
  const opp = teams.find(t => t.isFirst !== isFirst);

  const myScore  = isFirst ? game.hs : game.as;
  const oppScore = isFirst ? game.as : game.hs;

  return {
    gameId,
    date:    game.d   || null,
    rn:      game.rn  || null,
    oppId:   opp?.id   || null,
    oppName: opp?.name || null,
    result:  computeResult(myScore, oppScore),
    score:   (typeof myScore === 'number' && typeof oppScore === 'number')
               ? `${myScore}-${oppScore}` : null,
    st:      game.st  || null,
  };
}

function buildVenueEntry(game, gameId) {
  if (!game.vid || !game.d) return null;
  const court = game.ct || 'Unknown Court';
  const teams = gameTeams(game);
  return {
    vid:   game.vid,
    date:  game.d,
    court,
    entry: {
      id: gameId,
      t:  game.t   || null,
      hn: teams[0]?.name || null,
      an: teams[1]?.name || null,
      st: game.st  || null,
    },
  };
}

function accumulateRoster(teamStats, playerDetail) {
  for (const season of (playerDetail.seasons || [])) {
    const sid = season.sid;
    if (!sid) continue;
    for (const reg of (season.regs || [])) {
      const tid = reg.tid;
      if (!tid) continue;
      if (!teamStats[sid])      teamStats[sid] = {};
      if (!teamStats[sid][tid]) teamStats[sid][tid] = { meta: { name: null, club: null }, roster: {}, fixtures: [] };
      const entry = teamStats[sid][tid];
      if (!entry.meta.name  && reg.tn)      entry.meta.name  = reg.tn;
      if (!entry.meta.club  && season.club) entry.meta.club  = season.club;
      const s = reg.stats || {};
      entry.roster[playerDetail.uuid] = {
        name:    playerDetail.name || null,
        gp:      s.gp      || 0,
        pts:     s.pts     || 0,
        fg:      s.fg      || 0,
        ft:      s.ft      || 0,
        threePt: s.threePt || 0,
        fouls:   s.fouls   || 0,
      };
    }
  }
}

// ── Phase 2A: player files → team-stats rosters ───────────────────────────────

function phase2A(progress) {
  console.log('\n── Phase 2A: player files → team-stats rosters ──');

  const playerDirs = fs.readdirSync(PLAYERS_DIR)
    .filter(d => /^[0-9a-f]{2}$/i.test(d))
    .sort();

  // teamStats accumulates ALL seasons in memory
  // { [sid]: { [tid]: { meta: {name, club}, roster: {uuid: {stats}} } } }
  const teamStats = {};
  let dirsProcessed = 0;
  let sinceLastCommit = 0;

  for (const dir of playerDirs) {
    if (progress.phase2a_completedDirs.includes(dir)) {
      dirsProcessed++;
      continue;
    }

    const dirPath = path.join(PLAYERS_DIR, dir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      let detail;
      try { detail = readJSON(path.join(dirPath, file)); } catch (e) { continue; }
      accumulateRoster(teamStats, detail);
    }

    progress.phase2a_completedDirs.push(dir);
    dirsProcessed++;
    sinceLastCommit++;

    if (dirsProcessed % 16 === 0) {
      console.log(`  ${dirsProcessed}/${playerDirs.length} player dirs processed`);
    }

    if (sinceLastCommit >= COMMIT_EVERY_PLAYER_DIRS) {
      // Only commit progress file — team-stats not written yet
      writeJSON(PROGRESS_FILE, progress);
      gitCommit(`migrate-phase2a: player dirs ${dirsProcessed}/${playerDirs.length}`, [PROGRESS_FILE]);
      sinceLastCommit = 0;
    }
  }

  // Write all team-stats files (roster only, no fixtures yet)
  console.log(`\n  Writing team-stats files for ${Object.keys(teamStats).length} seasons...`);
  fs.mkdirSync(TEAM_STATS, { recursive: true });
  for (const [sid, teams] of Object.entries(teamStats)) {
    writeJSON(path.join(TEAM_STATS, `${sid}.json`), teams);
  }

  progress.phase2a_complete = true;
  writeJSON(PROGRESS_FILE, progress);
  gitCommit('migrate-phase2a: all team-stats rosters written', [TEAM_STATS, PROGRESS_FILE]);
  console.log('  Phase 2A complete.');
}

// ── Phase 2B: game files → fixtures + venue accumulation ─────────────────────

function phase2B(progress) {
  console.log('\n── Phase 2B: game files → fixtures + venue-lookup ──');

  // venueGames accumulates ALL venue/date/court data in memory
  // { [vid]: { [date]: { [court]: [entry, ...] } } }
  const venueGames = {};

  const seasonFiles = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
  const total = seasonFiles.length;
  let processed = 0;
  let sinceLastCommit = 0;

  for (const file of seasonFiles) {
    const sid = file.replace('.json', '');
    if (progress.phase2b_completedSeasons.includes(sid)) {
      processed++;
      continue;
    }

    let seasonData;
    try { seasonData = readJSON(path.join(GAMES_DIR, file)); } catch (e) { processed++; continue; }
    const games = seasonData.games || {};

    // Load existing team-stats for this season (written in Phase 2A)
    const tsPath = path.join(TEAM_STATS, `${sid}.json`);
    let ts = {};
    if (fs.existsSync(tsPath)) {
      try { ts = readJSON(tsPath); } catch (e) {}
    }

    for (const [gameId, game] of Object.entries(games)) {
      const teams = gameTeams(game);

      // Build fixture entry for each team
      for (const team of teams) {
        const fe = buildFixtureEntry(game, gameId, team.isFirst);
        if (!fe) continue;

        // Ensure team exists in ts — Phase 2A may not have seen it (all-private team)
        if (!ts[team.id]) {
          ts[team.id] = { meta: { name: team.name || null, club: null }, roster: {}, fixtures: [] };
        }
        if (!ts[team.id].fixtures) ts[team.id].fixtures = [];
        // Fill in meta.name if still null
        if (!ts[team.id].meta.name && team.name) ts[team.id].meta.name = team.name;

        ts[team.id].fixtures.push(fe);
      }

      // Venue accumulation
      const ve = buildVenueEntry(game, gameId);
      if (ve) {
        if (!venueGames[ve.vid])              venueGames[ve.vid] = {};
        if (!venueGames[ve.vid][ve.date])     venueGames[ve.vid][ve.date] = {};
        if (!venueGames[ve.vid][ve.date][ve.court]) venueGames[ve.vid][ve.date][ve.court] = [];
        venueGames[ve.vid][ve.date][ve.court].push(ve.entry);
      }
    }

    // Sort fixtures by date asc for each team
    for (const teamEntry of Object.values(ts)) {
      if (teamEntry.fixtures) {
        teamEntry.fixtures.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      }
    }

    writeJSON(tsPath, ts);

    progress.phase2b_completedSeasons.push(sid);
    processed++;
    sinceLastCommit++;

    if (processed % 100 === 0) {
      console.log(`  ${processed}/${total} seasons processed`);
    }

    if (sinceLastCommit >= COMMIT_EVERY_SEASONS) {
      writeJSON(PROGRESS_FILE, progress);
      gitCommit(`migrate-phase2b: fixtures ${processed}/${total} seasons`, [TEAM_STATS, PROGRESS_FILE]);
      sinceLastCommit = 0;
    }
  }

  writeJSON(PROGRESS_FILE, progress);
  gitCommit(`migrate-phase2b: fixtures complete (${total} seasons)`, [TEAM_STATS, PROGRESS_FILE]);
  console.log('  Phase 2B complete.');

  return venueGames;
}

// ── Phase 2C: write venue-lookup files ───────────────────────────────────────

function phase2C(venueGames, progress) {
  console.log('\n── Phase 2C: writing venue-lookup files ──');

  const vids = Object.keys(venueGames);
  let written = 0;
  let sinceLastCommit = 0;

  for (const vid of vids) {
    if (progress.phase2c_completedVenues.includes(vid)) continue;

    const dates = venueGames[vid];
    for (const [date, courts] of Object.entries(dates)) {
      // Sort each court's games by time
      for (const court of Object.keys(courts)) {
        courts[court].sort((a, b) => (a.t || '').localeCompare(b.t || ''));
      }
      const filePath = path.join(VENUE_LOOKUP, vid, `${date}.json`);
      writeJSON(filePath, courts);
    }

    progress.phase2c_completedVenues.push(vid);
    written++;
    sinceLastCommit++;

    if (written % 50 === 0) {
      console.log(`  ${written}/${vids.length} venues written`);
    }

    if (sinceLastCommit >= COMMIT_EVERY_VENUE_BATCH) {
      writeJSON(PROGRESS_FILE, progress);
      gitCommit(`migrate-phase2c: venue-lookup ${written}/${vids.length}`, [VENUE_LOOKUP, PROGRESS_FILE]);
      sinceLastCommit = 0;
    }
  }

  writeJSON(PROGRESS_FILE, progress);
  gitCommit(`migrate-phase2c: venue-lookup complete (${written} venues)`, [VENUE_LOOKUP, PROGRESS_FILE]);
  console.log(`  Phase 2C complete. ${written} venues written.`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('migrate-phase2.js — Migration Phase 2');
  console.log('======================================');

  let progress = {
    phase2a_completedDirs:    [],
    phase2a_complete:         false,
    phase2b_completedSeasons: [],
    phase2b_complete:         false,
    phase2c_completedVenues:  [],
    phase2c_complete:         false,
  };

  if (fs.existsSync(PROGRESS_FILE)) {
    progress = { ...progress, ...readJSON(PROGRESS_FILE) };
    console.log(`Resuming:`);
    console.log(`  2A: ${progress.phase2a_complete ? 'complete' : `${progress.phase2a_completedDirs.length}/256 player dirs`}`);
    console.log(`  2B: ${progress.phase2b_complete ? 'complete' : `${progress.phase2b_completedSeasons.length} seasons`}`);
    console.log(`  2C: ${progress.phase2c_complete ? 'complete' : `${progress.phase2c_completedVenues.length} venues`}`);
  }

  if (!progress.phase2a_complete) {
    phase2A(progress);
  }

  let venueGames = {};
  if (!progress.phase2b_complete) {
    venueGames = phase2B(progress);
    progress.phase2b_complete = true;
    writeJSON(PROGRESS_FILE, progress);
  } else {
    console.log('\n── Phase 2B: already complete, rebuilding venue data from game files ──');
    // If Phase 2B already ran but 2C didn't finish, re-build venueGames from game files
    // (it wasn't persisted to disk — only venue-lookup files are the output)
    const seasonFiles = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
    for (const file of seasonFiles) {
      const sid = file.replace('.json', '');
      if (!progress.phase2c_completedVenues.length) break; // 2C not started yet — no need
      let seasonData;
      try { seasonData = readJSON(path.join(GAMES_DIR, file)); } catch (e) { continue; }
      for (const [gameId, game] of Object.entries(seasonData.games || {})) {
        const ve = buildVenueEntry(game, gameId);
        if (!ve) continue;
        if (progress.phase2c_completedVenues.includes(ve.vid)) continue; // already written
        if (!venueGames[ve.vid])                      venueGames[ve.vid] = {};
        if (!venueGames[ve.vid][ve.date])             venueGames[ve.vid][ve.date] = {};
        if (!venueGames[ve.vid][ve.date][ve.court])   venueGames[ve.vid][ve.date][ve.court] = [];
        venueGames[ve.vid][ve.date][ve.court].push(ve.entry);
      }
    }
  }

  if (!progress.phase2c_complete) {
    phase2C(venueGames, progress);
    progress.phase2c_complete = true;
    writeJSON(PROGRESS_FILE, progress);
  }

  console.log('\n✅ Migration Phase 2 complete.');
  console.log('Next steps:');
  console.log('  1. Run db-report with --verify-migration (after Phase 2 checks are added)');
  console.log('  2. Run migrate-phase3.js (search player shards)');
}

main().catch(e => { console.error(e); process.exit(1); });
