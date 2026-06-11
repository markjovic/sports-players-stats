#!/usr/bin/env node
// normalise-game-structure.js
'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const TENANT        = process.argv[2] || 'bv';
const GAMES_DIR     = path.join(__dirname, 'games', TENANT);
const PLAYERS_DIR   = path.join(__dirname, 'players');
const SAVE_EVERY    = 50; // season files between commits (game files are large)

console.log('\n🔧 Normalise Game Structure');
console.log('─'.repeat(60));
console.log(`  Tenant: ${TENANT}`);
console.log('  Operations:');
console.log('    1. Strip redundant o/on from games that have h/a');
console.log('    2. Rename o→t1, on→t1n for games without h/a');
console.log('    3. Reconstruct t2/t2n from playerGames → player files');
console.log('    4. Delete legacy s/sn fields if present\n');

if (!fs.existsSync(GAMES_DIR)) { console.error(`❌ ${GAMES_DIR} not found`); process.exit(1); }
if (!fs.existsSync(PLAYERS_DIR)) { console.error(`❌ ${PLAYERS_DIR} not found`); process.exit(1); }

// ─── Player file cache ────────────────────────────────────────────────────────
// Cache team ID lookups to avoid re-reading the same player file repeatedly

const _teamCache = new Map(); // uuid → Map<seasonId, tid/tn>

function getPlayerTeamForSeason(uuid, seasonId) {
  if (!_teamCache.has(uuid)) {
    const file = path.join(PLAYERS_DIR, uuid.slice(0, 2), `${uuid}.json`);
    if (!fs.existsSync(file)) { _teamCache.set(uuid, null); return null; }
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      const seasonMap = new Map();
      for (const s of (p.seasons || [])) {
        for (const r of (s.regs || [])) {
          if (!seasonMap.has(s.sid)) {
            seasonMap.set(s.sid, { tid: r.tid, tn: r.tn });
          }
        }
      }
      _teamCache.set(uuid, seasonMap);
    } catch (e) { _teamCache.set(uuid, null); return null; }
  }
  const seasonMap = _teamCache.get(uuid);
  return seasonMap ? (seasonMap.get(seasonId) || null) : null;
}

// ─── Git ──────────────────────────────────────────────────────────────────────

function gitCommit(msg) {
  try {
    execSync('git add games/', { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${msg}"`, { stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('\n  ✓ Committed');
  } catch (e) { console.warn(`\n  ⚠ Git: ${e.message}`); }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));

let processed = 0, filesModified = 0, sinceLastCommit = 0;
let nStripped = 0;   // o/on removed from games with h/a
let nRenamed  = 0;   // o/on renamed to t1/t1n
let nT2Added  = 0;   // t2/t2n reconstructed from player files
let nT2Miss   = 0;   // t1 present but no t2 source found
let nSCleaned = 0;   // s/sn legacy fields removed
let nBare     = 0;   // games with no team fields at all after processing

for (const file of files) {
  const filePath = path.join(GAMES_DIR, file);
  const seasonId = file.replace('.json', '');
  let sg;
  try { sg = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { processed++; continue; }

  const games       = sg.games       || {};
  const playerGames = sg.playerGames || {};

  // Build inverted index: gameId → [playerUUIDs]
  const gameToPlayers = new Map();
  for (const [uuid, gids] of Object.entries(playerGames)) {
    for (const gid of gids) {
      if (!gameToPlayers.has(gid)) gameToPlayers.set(gid, []);
      gameToPlayers.get(gid).push(uuid);
    }
  }

  let dirty = false;

  for (const [gameId, game] of Object.entries(games)) {

    // 1. Clean legacy s/sn fields
    if (game.s !== undefined || game.sn !== undefined) {
      delete game.s; delete game.sn;
      nSCleaned++; dirty = true;
    }

    // 2. Strip redundant o/on from games that already have h/a
    if (game.h && (game.o !== undefined || game.on !== undefined)) {
      delete game.o; delete game.on;
      nStripped++; dirty = true;
      continue; // h/a present — no further work needed for this game
    }

    // 3. For games without h/a: rename o→t1, on→t1n
    if (!game.h && game.o !== undefined) {
      game.t1  = game.o;
      game.t1n = game.on || null;
      delete game.o; delete game.on;
      nRenamed++; dirty = true;
    }

    // 4. Reconstruct t2/t2n if t1 is set but t2 is absent
    if (!game.h && game.t1 && !game.t2) {
      const players = gameToPlayers.get(gameId) || [];
      let found = false;
      for (const uuid of players) {
        const reg = getPlayerTeamForSeason(uuid, seasonId);
        if (!reg || !reg.tid) continue;
        // This player's team is different from t1 — they're on the other side
        if (reg.tid !== game.t1) {
          game.t2  = reg.tid;
          game.t2n = reg.tn || null;
          nT2Added++; dirty = true;
          found = true;
          break;
        }
        // Player is on same team as t1 — try next player to find other side
      }
      if (!found) nT2Miss++;
    }

    // Track bare games (no team fields at all)
    if (!game.h && !game.t1) nBare++;
  }

  if (dirty) {
    fs.writeFileSync(filePath, JSON.stringify(sg));
    filesModified++;
    sinceLastCommit++;
  }

  processed++;
  if (sinceLastCommit >= SAVE_EVERY) {
    gitCommit(`normalise-game-structure: ${nStripped} stripped, ${nRenamed} renamed, ${nT2Added} t2 added`);
    sinceLastCommit = 0;
  }

  if (processed % 100 === 0 || processed === files.length) {
    process.stdout.write(
      `  ${processed}/${files.length} seasons — ` +
      `stripped:${nStripped} renamed:${nRenamed} t2:${nT2Added} miss:${nT2Miss} bare:${nBare}\r`
    );
  }
}

if (sinceLastCommit > 0) {
  gitCommit(`normalise-game-structure complete: ${nStripped} stripped, ${nRenamed} renamed, ${nT2Added} t2 added`);
}

console.log('\n\n✅ Normalise complete');
console.log(`   Files scanned:    ${files.length.toLocaleString()}`);
console.log(`   Files modified:   ${filesModified.toLocaleString()}`);
console.log(`   o/on stripped:    ${nStripped.toLocaleString()} (redundant — game had h/a)`);
console.log(`   o/on → t1/t1n:   ${nRenamed.toLocaleString()} (renamed for games without h/a)`);
console.log(`   t2/t2n added:     ${nT2Added.toLocaleString()} (reconstructed from player files)`);
console.log(`   t2 not found:     ${nT2Miss.toLocaleString()} (t1 present but no player on other side in DB)`);
console.log(`   s/sn cleaned:     ${nSCleaned.toLocaleString()} (legacy fields removed)`);
console.log(`   Bare (no teams):  ${nBare.toLocaleString()} (no team fields — legacy/forfeit stubs)`);
console.log();
