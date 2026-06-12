// migrate-phase1.js
// Performs Migration Phase 1 for the sports-players-stats repo:
//   1. Build `p` array for every game in games/bv/, delete playerGames
//   2. Build team-index.json (grouped by season name)
//   3. Build venue-index.json (deduplicated flat array)
//   4. Add `history` map to all players/indexes/ shards
//
// NOTE: players-index/ → players/indexes/ rename is done manually via GitHub UI
// (GitHub Actions cannot move files across directories with git mv). This script
// reads from players-index/ and writes enriched copies to players/indexes/.
//
// Progress is saved to migrate-phase1-progress.json and committed every
// COMMIT_EVERY seasons so a timeout/cancel can resume safely.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── config ────────────────────────────────────────────────────────────────────

const GAMES_DIR       = 'games/bv';
const PLAYERS_DIR     = 'players';
const INDEX_IN_DIR    = 'players-index';
const INDEX_OUT_DIR   = 'players/indexes';
const VENUE_LOOKUP    = 'venue-lookup';
const SPORTS_INDEX    = 'sports-index.json';
const TEAM_INDEX_OUT  = 'team-index.json';
const VENUE_INDEX_OUT = 'venue-index.json';
const PROGRESS_FILE   = 'migrate-phase1-progress.json';
const COMMIT_EVERY    = 50; // seasons per mid-run commit

// ── helpers ───────────────────────────────────────────────────────────────────

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

function gitCommitGames(message) {
  // Phase 1A: only games/bv and progress file exist at this point
  try {
    execSync(`git add ${GAMES_DIR} ${PROGRESS_FILE}`, { stdio: 'pipe' });
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

function gitCommitIndexes(message) {
  // Phase 1C: players/indexes now exists
  try {
    execSync(`git add ${INDEX_OUT_DIR} ${PROGRESS_FILE}`, { stdio: 'pipe' });
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

function privateDisplayName(uuid) {
  return `Player #${uuid.slice(0, 10)}`;
}

// ── load name map from players-index/ shards ──────────────────────────────────
// Returns { uuid: { name } } for all 256 shards

function loadNameMap() {
  console.log('Loading name map from players-index/ shards...');
  const map = {};
  const shards = fs.readdirSync(INDEX_IN_DIR).filter(f => f.endsWith('.json'));
  for (const shard of shards) {
    const data = readJSON(path.join(INDEX_IN_DIR, shard));
    for (const [uuid, entry] of Object.entries(data)) {
      map[uuid] = { name: entry.name || null };
    }
  }
  console.log(`  loaded ${Object.keys(map).length} players`);
  return map;
}

// ── p array builder ───────────────────────────────────────────────────────────

function buildPArray(game, gameId, playerGames, nameMap) {
  if (game.hidden && (game.hp?.length || game.ap?.length)) {
    const seen = new Set();
    const p = [];
    for (const entry of [...(game.hp || []), ...(game.ap || [])]) {
      if (!seen.has(entry.profileID)) {
        seen.add(entry.profileID);
        p.push({ id: entry.profileID, n: entry.name });
      }
    }
    return p;
  }
  const p = [];
  for (const [uuid, gameIds] of Object.entries(playerGames)) {
    if (gameIds.includes(gameId)) {
      const name = nameMap[uuid]?.name || null;
      p.push({ id: uuid, n: name || privateDisplayName(uuid) });
    }
  }
  return p;
}

// ── team collection from a single game ───────────────────────────────────────

function collectTeamsFromGame(game, sid, sn) {
  const teams = [];
  if (game.h && game.hn) {
    teams.push({ id: game.h, n: game.hn, sid });
    if (game.a && game.an) teams.push({ id: game.a, n: game.an, sid });
  } else {
    if (game.t1 && game.t1n) teams.push({ id: game.t1, n: game.t1n, sid });
    if (game.t2 && game.t2n) teams.push({ id: game.t2, n: game.t2n, sid });
  }
  return teams;
}

// ── history map builder ───────────────────────────────────────────────────────

function buildHistoryMap(playerDetail) {
  const history = {};
  for (const season of (playerDetail.seasons || [])) {
    const tids = (season.regs || []).map(r => r.tid).filter(Boolean);
    if (tids.length) history[season.sid] = tids;
  }
  return history;
}

// ── Phase 1A: process game files ──────────────────────────────────────────────

function processGameFiles(nameMap, progress, sportsIndex) {
  console.log('\n── Phase 1A: building p arrays and team-index ──');

  // teamIndex accumulates across all seasons: { seasonName: Map(id → {id,n,sid}) }
  const teamIndex = {};
  const seasonFiles = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
  const total = seasonFiles.length;
  let processed = 0;
  let sinceLastCommit = 0;

  // Build a seasonId → sn lookup from sports-index
  const snLookup = {};
  for (const season of sportsIndex) {
    snLookup[season.id] = season.name || null;
  }

  for (const file of seasonFiles) {
    const sid = file.replace('.json', '');
    if (progress.completedSeasons.includes(sid)) {
      processed++;
      continue;
    }

    const filePath = path.join(GAMES_DIR, file);
    const seasonData = readJSON(filePath);
    const games = seasonData.games || {};
    const playerGames = seasonData.playerGames || {};
    const sn = snLookup[sid] || null;

    // Build p arrays
    for (const [gameId, game] of Object.entries(games)) {
      game.p = buildPArray(game, gameId, playerGames, nameMap);

      // Collect teams for team-index
      if (sn) {
        const teams = collectTeamsFromGame(game, sid, sn);
        if (!teamIndex[sn]) teamIndex[sn] = new Map();
        for (const t of teams) {
          // Key by teamId — deduplicate within season name
          if (!teamIndex[sn].has(t.id)) teamIndex[sn].set(t.id, t);
        }
      }
    }

    // Delete playerGames — no longer needed
    delete seasonData.playerGames;

    // Write minimised output
    writeJSON(filePath, seasonData);

    progress.completedSeasons.push(sid);
    processed++;
    sinceLastCommit++;

    if (processed % 100 === 0) {
      console.log(`  ${processed}/${total} seasons processed`);
    }

    if (sinceLastCommit >= COMMIT_EVERY) {
      writeJSON(PROGRESS_FILE, progress);
      gitCommitGames(`migrate-phase1: p arrays ${processed}/${total} seasons`);
      sinceLastCommit = 0;
    }
  }

  // Final commit for game files
  writeJSON(PROGRESS_FILE, progress);
  gitCommitGames(`migrate-phase1: p arrays complete (${total} seasons)`);

  // Convert teamIndex maps to arrays
  const teamIndexOut = {};
  for (const [sn, teamMap] of Object.entries(teamIndex)) {
    teamIndexOut[sn] = Array.from(teamMap.values());
  }
  return teamIndexOut;
}

// ── Phase 1B: build venue-index.json ─────────────────────────────────────────

function buildVenueIndex() {
  console.log('\n── Phase 1B: building venue-index.json ──');
  const seen = new Set();
  const venues = [];
  const shards = fs.readdirSync(VENUE_LOOKUP).filter(f => f.endsWith('.json'));
  for (const shard of shards) {
    const data = readJSON(path.join(VENUE_LOOKUP, shard));
    for (const [id, venue] of Object.entries(data)) {
      if (!seen.has(id)) {
        seen.add(id);
        venues.push({ id, n: venue.name || venue.n || id });
      }
    }
  }
  venues.sort((a, b) => a.n.localeCompare(b.n));
  console.log(`  ${venues.length} unique venues`);
  return venues;
}

// ── Phase 1C: enrich player index shards with history ─────────────────────────

function enrichPlayerIndexes(progress) {
  console.log('\n── Phase 1C: adding history to player index shards ──');
  fs.mkdirSync(INDEX_OUT_DIR, { recursive: true });

  const shards = fs.readdirSync(INDEX_IN_DIR).filter(f => f.endsWith('.json'));
  let enriched = 0;

  for (const shard of shards) {
    if (progress.completedIndexShards.includes(shard)) continue;

    const indexData = readJSON(path.join(INDEX_IN_DIR, shard));

    for (const [uuid, entry] of Object.entries(indexData)) {
      // Load player detail file for history map
      const prefix = uuid.slice(0, 2);
      const detailPath = path.join(PLAYERS_DIR, prefix, `${uuid}.json`);
      if (fs.existsSync(detailPath)) {
        const detail = readJSON(detailPath);
        entry.history = buildHistoryMap(detail);
      } else {
        entry.history = {};
      }
    }

    writeJSON(path.join(INDEX_OUT_DIR, shard), indexData);
    progress.completedIndexShards.push(shard);
    enriched++;

    if (enriched % 32 === 0) {
      console.log(`  ${enriched}/${shards.length} index shards enriched`);
      writeJSON(PROGRESS_FILE, progress);
      gitCommitIndexes(`migrate-phase1: index shards ${enriched}/${shards.length}`);
    }
  }

  writeJSON(PROGRESS_FILE, progress);
  gitCommitIndexes(`migrate-phase1: index shards complete`);
  console.log(`  done: ${enriched} shards written to ${INDEX_OUT_DIR}/`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('migrate-phase1.js — Migration Phase 1');
  console.log('======================================');

  // Load or init progress
  let progress = { completedSeasons: [], completedIndexShards: [] };
  if (fs.existsSync(PROGRESS_FILE)) {
    progress = readJSON(PROGRESS_FILE);
    console.log(`Resuming: ${progress.completedSeasons.length} seasons done, ${progress.completedIndexShards.length} index shards done`);
  }

  const sportsIndexRaw = readJSON(SPORTS_INDEX);
  const sportsIndex = Object.values(sportsIndexRaw.seasons || sportsIndexRaw);
  const nameMap = loadNameMap();

  // Phase 1A: game files → p arrays + team-index accumulation
  const teamIndexOut = processGameFiles(nameMap, progress, sportsIndex);

  // Write team-index.json
  console.log('\nWriting team-index.json...');
  writeJSON(TEAM_INDEX_OUT, teamIndexOut);
  const totalTeams = Object.values(teamIndexOut).reduce((s, a) => s + a.length, 0);
  console.log(`  ${Object.keys(teamIndexOut).length} season names, ${totalTeams} total team entries`);

  // Phase 1B: venue-index
  const venueIndex = buildVenueIndex();
  writeJSON(VENUE_INDEX_OUT, venueIndex);
  console.log(`  venue-index.json written (${venueIndex.length} venues)`);

  // Commit index files
  try {
    execSync(`git add ${TEAM_INDEX_OUT} ${VENUE_INDEX_OUT}`, { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (diff) {
      execSync(`git commit -m "migrate-phase1: team-index and venue-index"`, { stdio: 'pipe' });
      execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
    }
  } catch (e) {
    console.error('git commit for index files failed:', e.message);
  }

  // Phase 1C: enrich player index shards
  enrichPlayerIndexes(progress);

  console.log('\n✅ Migration Phase 1 complete.');
  console.log('Next steps:');
  console.log('  1. Manually rename players-index/ → players/indexes/ via GitHub UI');
  console.log('     (or add a workflow step: cp -r players-index players/indexes && rm -r players-index)');
  console.log('  2. Run migrate-phase2.js');
}

main().catch(e => { console.error(e); process.exit(1); });
