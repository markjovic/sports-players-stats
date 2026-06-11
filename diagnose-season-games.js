#!/usr/bin/env node
// diagnose-season-games.js
'use strict';

const fs   = require('fs');
const path = require('path');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const SEASON_ID  = ARGS.season  || '01621a80';
const SAMPLE     = parseInt(ARGS.sample || '5', 10);   // games per category
const TENANT     = ARGS.tenant  || 'bv';

const GAMES_DIR   = path.join(__dirname, 'games', TENANT);
const PLAYERS_DIR = path.join(__dirname, 'players');
const INDEX_FILE  = path.join(__dirname, 'sports-index.json');

console.log(`\n🔬 Season Game Detail — ${SEASON_ID}`);
console.log('═'.repeat(70));

// ─── Load season metadata ─────────────────────────────────────────────────────

const index   = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
const season  = index.seasons?.[SEASON_ID];

if (season) {
  console.log(`\n📅 SEASON METADATA`);
  console.log(`  ID:           ${season.id}`);
  console.log(`  Name:         ${season.name || '(none)'}`);
  console.log(`  Competition:  ${season.comp || '(none)'}`);
  console.log(`  Org:          ${season.org  || '(none)'}`);
  console.log(`  Locked:       ${season.locked}`);
  console.log(`  Grades:       ${(season.grades || []).length}`);
  if ((season.grades || []).length) {
    for (const g of season.grades) {
      console.log(`    ${g.id}  ${g.name || ''}`);
    }
  }
} else {
  console.log(`\n⚠ Season ${SEASON_ID} not found in sports-index.json`);
}

// ─── Load game file ───────────────────────────────────────────────────────────

const gameFile = path.join(GAMES_DIR, `${SEASON_ID}.json`);
if (!fs.existsSync(gameFile)) {
  console.error(`\n❌ Game file not found: ${gameFile}`);
  process.exit(1);
}

const sg          = JSON.parse(fs.readFileSync(gameFile, 'utf8'));
const games       = sg.games       || {};
const playerGames = sg.playerGames || {};

const allGames    = Object.entries(games);
const hiddenGames = allGames.filter(([, g]) => g.hidden  && !g.legacy);
const legacyGames = allGames.filter(([, g]) => g.legacy  && !g.hidden);
const scoredGames = allGames.filter(([, g]) => typeof g.hs === 'number' && !g.hidden && !g.legacy);
const otherGames  = allGames.filter(([, g]) => !g.hidden && !g.legacy && typeof g.hs !== 'number');

console.log(`\n📊 GAME FILE SUMMARY`);
console.log(`  Total games:      ${allGames.length.toLocaleString()}`);
console.log(`  Hidden:           ${hiddenGames.length.toLocaleString()}`);
console.log(`  Legacy:           ${legacyGames.length.toLocaleString()}`);
console.log(`  Scored (normal):  ${scoredGames.length.toLocaleString()}`);
console.log(`  Other:            ${otherGames.length.toLocaleString()}`);
console.log(`  playerGames UUIDs: ${Object.keys(playerGames).length.toLocaleString()}`);

// ─── Player lookup helper ─────────────────────────────────────────────────────

const _playerCache = {};

function loadPlayer(uuid) {
  if (_playerCache[uuid]) return _playerCache[uuid];
  const prefix = uuid.slice(0, 2);
  const file   = path.join(PLAYERS_DIR, prefix, `${uuid}.json`);
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    _playerCache[uuid] = p;
    return p;
  } catch (e) { return null; }
}

// For a game ID, find up to N players who played it, return their detail
function getPlayersForGame(gameId, maxPlayers = 6) {
  const uuids = [];
  for (const [uuid, gameIds] of Object.entries(playerGames)) {
    if (Array.isArray(gameIds) && gameIds.includes(gameId)) {
      uuids.push(uuid);
      if (uuids.length >= maxPlayers) break;
    }
  }

  return uuids.map(uuid => {
    const p = loadPlayer(uuid);
    if (!p) return { uuid, name: '(file not found)', team: null, stats: null };

    // Find this season in player's history
    const seasonEntry = (p.seasons || []).find(s => s.sid === SEASON_ID);
    let team = null, stats = null;
    if (seasonEntry) {
      // Find the registration whose games include this gameId
      for (const reg of (seasonEntry.regs || [])) {
        const hasGame = (reg.games || []).some(g =>
          (typeof g === 'string' ? g : g.id) === gameId
        );
        if (hasGame) {
          team  = { tid: reg.tid, tn: reg.tn, gn: reg.gn };
          // Find per-game stats
          const gameStats = (reg.games || []).find(g =>
            typeof g === 'object' && (g.id === gameId)
          );
          if (gameStats) stats = gameStats;
          break;
        }
        // Fallback: team from reg even if no per-game link
        if (!team) team = { tid: reg.tid, tn: reg.tn, gn: reg.gn };
      }
    }

    return { uuid, name: p.name, gender: p.gender, team, stats };
  });
}

// ─── Print game detail ────────────────────────────────────────────────────────

function printGame(gameId, game, label, index) {
  console.log(`\n  [${label} #${index + 1}] Game ID: ${gameId}`);
  console.log(`    Date:       ${game.d   || '(none)'}`);
  console.log(`    Round:      ${game.rn  || '(none)'}`);
  console.log(`    Status:     ${game.st  || '(none)'}`);
  console.log(`    Home team:  ${game.h   || '(none)'}  ${game.hn || ''}`);
  console.log(`    Away team:  ${game.a   || '(none)'}  ${game.an || ''}`);
  console.log(`    Opponent:   ${game.o   || '(none)'}  ${game.on || ''}`);
  console.log(`    Score:      ${game.hs !== undefined ? `${game.hs} – ${game.as}` : '(none)'}`);
  console.log(`    Venue:      ${game.vid || '(none)'}  ${game.vn || ''}`);
  console.log(`    Flags:      ${[game.hidden && 'hidden', game.legacy && 'legacy', game.forfeit && 'forfeit', game.cancelled && 'cancelled', game.abandoned && 'abandoned', game.bye && 'bye'].filter(Boolean).join(', ') || 'none'}`);
  if (game.hp?.length) console.log(`    Box score:  ${game.hp.length} home players, ${game.ap?.length || 0} away players`);

  // Players from playerGames
  const players = getPlayersForGame(gameId, 6);
  if (players.length === 0) {
    console.log(`    Players:    (none in playerGames)`);
  } else {
    console.log(`    Players (${players.length} found in playerGames):`);
    for (const pl of players) {
      const teamStr  = pl.team ? `${pl.team.tn || pl.team.tid} / ${pl.team.gn || ''}` : '(no team found)';
      const statsStr = pl.stats ? `pts:${pl.stats.pts ?? '?'} fg:${pl.stats.fg ?? '?'} ft:${pl.stats.ft ?? '?'}` : '';
      console.log(`      ${pl.uuid.slice(0,8)}  ${(pl.name || '').padEnd(28)}  ${teamStr}  ${statsStr}`);
    }
  }
}

// ─── Round distribution for legacy games ─────────────────────────────────────

function roundDist(gameList, label) {
  const counts = {};
  for (const [, g] of gameList) {
    const rn = g.rn || '(no round)';
    counts[rn] = (counts[rn] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log(`\n  ${label} — round distribution (top 20):`);
  for (const [rn, n] of sorted.slice(0, 20)) {
    console.log(`    ${rn.padEnd(35)} ${n}`);
  }
}

// ─── Date distribution ────────────────────────────────────────────────────────

function dateDist(gameList, label) {
  const counts = {};
  for (const [, g] of gameList) {
    const d = g.d ? g.d.slice(0, 7) : '(no date)'; // YYYY-MM
    counts[d] = (counts[d] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`\n  ${label} — date distribution by month:`);
  for (const [mo, n] of sorted) {
    console.log(`    ${mo}    ${n}`);
  }
}

// ─── Output ───────────────────────────────────────────────────────────────────

roundDist(hiddenGames, 'HIDDEN');
roundDist(legacyGames, 'LEGACY');

dateDist(hiddenGames, 'HIDDEN');
dateDist(legacyGames, 'LEGACY');

console.log(`\n${'─'.repeat(70)}`);
console.log(`\n🔒 HIDDEN GAME SAMPLES (${Math.min(SAMPLE, hiddenGames.length)} of ${hiddenGames.length})`);
for (let i = 0; i < Math.min(SAMPLE, hiddenGames.length); i++) {
  const [gameId, game] = hiddenGames[i];
  printGame(gameId, game, 'HIDDEN', i);
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`\n📜 LEGACY GAME SAMPLES (${Math.min(SAMPLE, legacyGames.length)} of ${legacyGames.length})`);
for (let i = 0; i < Math.min(SAMPLE, legacyGames.length); i++) {
  const [gameId, game] = legacyGames[i];
  printGame(gameId, game, 'LEGACY', i);
}

if (otherGames.length > 0) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`\n❓ OTHER GAME SAMPLES (${Math.min(3, otherGames.length)} of ${otherGames.length})`);
  for (let i = 0; i < Math.min(3, otherGames.length); i++) {
    const [gameId, game] = otherGames[i];
    printGame(gameId, game, 'OTHER', i);
  }
}

console.log('\n' + '═'.repeat(70));
console.log('  Done.\n');
