#!/usr/bin/env node
// scripts/diagnose-game-structure.js
'use strict';

const fs   = require('fs');
const path = require('path');

const GAMES_DIR   = path.join(__dirname, 'games', 'bv');
const INDEX_FILE  = path.join(__dirname, 'sports-index.json');

console.log('\n🔬 Game Structure Diagnostic');
console.log('═'.repeat(60));
console.log(`  Generated: ${new Date().toISOString()}\n`);

if (!fs.existsSync(GAMES_DIR)) { console.error('❌ games/bv/ not found'); process.exit(1); }
if (!fs.existsSync(INDEX_FILE)) { console.error('❌ sports-index.json not found'); process.exit(1); }

const index   = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
const seasons = index.seasons || {};

const seasonFiles = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
console.log(`  Season files: ${seasonFiles.length.toLocaleString()}\n`);

// ─── Counters ─────────────────────────────────────────────────────────────────

// Team field structure
let hasHA       = 0;  // has h and a (absolute)
let hasOOnly    = 0;  // has o/on but no h/a
let hasBoth     = 0;  // has both h/a AND o/on (should be 0 after normalise)
let hasNeither  = 0;  // no team fields at all

// playerGames presence
let filesWithPlayerGames    = 0;
let filesWithoutPlayerGames = 0;
let totalPlayerGameEntries  = 0;  // sum of all UUID keys across all files

// Cross-tab: legacy games × playerGames
let legacyGamesTotal             = 0;
let legacyGamesInFilesWithPG     = 0;  // legacy games where the file has playerGames
let legacyGamesInFilesWithoutPG  = 0;

// For sampling: find 5 legacy season IDs with and without playerGames
const legacyWithPG    = [];  // { seasonId, legacyCount, pgCount }
const legacyWithoutPG = [];  // { seasonId, legacyCount }

// o/on-only breakdown by flag
let oOnly_noFlag  = 0;
let oOnly_hidden  = 0;
let oOnly_legacy  = 0;
let oOnly_forfeit = 0;

// Status breakdown for "Other" bucket
const statusCounts = {};

// Null score breakdown
let nullScore_noFlag  = 0;
let nullScore_hidden  = 0;
let nullScore_legacy  = 0;
let nullScore_forfeit = 0;

// Sample: up to 3 raw game entries per structural category (for inspection)
const samples = {
  hasHA_scored:     [],  // h/a + score
  hasHA_noScore:    [],  // h/a + no score + no flag
  oOnly_noFlag:     [],  // o/on only, no flag, no score
  oOnly_legacy:     [],  // o/on + legacy
  neither_legacy:   [],  // no teams, legacy
  neither_noFlag:   [],  // no teams, no flag
  forfeit_sample:   [],  // any forfeit
  hidden_sample:    [],  // any hidden
};
const SAMPLE_MAX = 3;

function addSample(bucket, seasonId, gameId, game) {
  if (samples[bucket] && samples[bucket].length < SAMPLE_MAX) {
    samples[bucket].push({ seasonId, gameId, game: { ...game, _hp: game.hp?.length, _ap: game.ap?.length, hp: undefined, ap: undefined } });
  }
}

let processed = 0;

for (const file of seasonFiles) {
  const seasonId = file.replace('.json', '');
  let sg;
  try { sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8')); } catch (e) { continue; }

  const games       = sg.games       || {};
  const playerGames = sg.playerGames || {};
  const pgCount     = Object.keys(playerGames).length;
  const hasPG       = pgCount > 0;

  if (hasPG) { filesWithPlayerGames++;    totalPlayerGameEntries += pgCount; }
  else        { filesWithoutPlayerGames++; }

  const legacyInFile = Object.values(games).filter(g => g.legacy).length;

  if (legacyInFile > 0) {
    if (hasPG) {
      legacyGamesInFilesWithPG += legacyInFile;
      if (legacyWithPG.length < 5) legacyWithPG.push({ seasonId, legacyCount: legacyInFile, pgCount });
    } else {
      legacyGamesInFilesWithoutPG += legacyInFile;
      if (legacyWithoutPG.length < 5) legacyWithoutPG.push({ seasonId, legacyCount: legacyInFile });
    }
  }
  legacyGamesTotal += legacyInFile;

  for (const [gameId, game] of Object.entries(games)) {
    // Status breakdown
    const st = game.st || '';
    if (st && st !== 'FINAL' && st !== 'UPCOMING') {
      statusCounts[st] = (statusCounts[st] || 0) + 1;
    }

    // Skip UPCOMING for structural analysis
    if (st === 'UPCOMING' || !st) continue;

    const hasH  = !!game.h;
    const hasO  = !!game.o;
    const hasHs = typeof game.hs === 'number';

    // Team structure
    if (hasH && hasO)       { hasBoth++;    }
    else if (hasH && !hasO) { hasHA++;      addSample(hasHs ? 'hasHA_scored' : 'hasHA_noScore', seasonId, gameId, game); }
    else if (!hasH && hasO) {
      hasOOnly++;
      if (game.legacy)       { oOnly_legacy++;  addSample('oOnly_legacy',  seasonId, gameId, game); }
      else if (game.hidden)  { oOnly_hidden++;  }
      else if (game.forfeit) { oOnly_forfeit++; }
      else                   { oOnly_noFlag++;  addSample('oOnly_noFlag', seasonId, gameId, game); }
    } else {
      hasNeither++;
      if (game.legacy)  addSample('neither_legacy',  seasonId, gameId, game);
      else if (!game.hidden && !game.forfeit) addSample('neither_noFlag', seasonId, gameId, game);
    }

    // Null score breakdown
    if (game.hs === null) {
      if (game.legacy)       nullScore_legacy++;
      else if (game.hidden)  nullScore_hidden++;
      else if (game.forfeit) nullScore_forfeit++;
      else                   nullScore_noFlag++;
    }

    // Samples for flags
    addSample('forfeit_sample', seasonId, gameId, game);
    if (game.hidden) addSample('hidden_sample', seasonId, gameId, game);
  }

  processed++;
  if (processed % 200 === 0) process.stdout.write(`  Scanning ${processed}/${seasonFiles.length}...\r`);
}

// ─── Report ───────────────────────────────────────────────────────────────────

console.log('\n📐 TEAM FIELD STRUCTURE (non-UPCOMING games)');
console.log('─'.repeat(50));
console.log(`  Has h + a (absolute, normal):     ${hasHA.toLocaleString()}`);
console.log(`  Has h + a AND o/on (both):        ${hasBoth.toLocaleString()} ${hasBoth > 0 ? '⚠ redundant — o/on should be deleted' : '✓'}`);
console.log(`  Has o/on only (relative):         ${hasOOnly.toLocaleString()}`);
console.log(`    - no flag, no score:            ${oOnly_noFlag.toLocaleString()}`);
console.log(`    - hidden:                       ${oOnly_hidden.toLocaleString()}`);
console.log(`    - legacy:                       ${oOnly_legacy.toLocaleString()}`);
console.log(`    - forfeit:                      ${oOnly_forfeit.toLocaleString()}`);
console.log(`  Has neither h/a nor o/on:         ${hasNeither.toLocaleString()}`);

console.log('\n📋 PLAYER GAMES MAP (playerGames key in game files)');
console.log('─'.repeat(50));
console.log(`  Files WITH playerGames populated: ${filesWithPlayerGames.toLocaleString()}`);
console.log(`  Files WITHOUT playerGames:        ${filesWithoutPlayerGames.toLocaleString()}`);
console.log(`  Total playerGames UUID entries:   ${totalPlayerGameEntries.toLocaleString()}`);
console.log(`\n  Legacy games in files WITH playerGames:    ${legacyGamesInFilesWithPG.toLocaleString()}`);
console.log(`  Legacy games in files WITHOUT playerGames: ${legacyGamesInFilesWithoutPG.toLocaleString()}`);
console.log(`  Legacy games total:                        ${legacyGamesTotal.toLocaleString()}`);

if (legacyWithPG.length) {
  console.log('\n  Sample legacy seasons WITH playerGames:');
  for (const s of legacyWithPG) console.log(`    ${s.seasonId}  legacy:${s.legacyCount}  playerGames UUIDs:${s.pgCount}`);
}
if (legacyWithoutPG.length) {
  console.log('\n  Sample legacy seasons WITHOUT playerGames:');
  for (const s of legacyWithoutPG) console.log(`    ${s.seasonId}  legacy:${s.legacyCount}`);
}

console.log('\n🔢 NULL SCORE BREAKDOWN (hs === null)');
console.log('─'.repeat(50));
console.log(`  null score, no flag:    ${nullScore_noFlag.toLocaleString()}`);
console.log(`  null score, hidden:     ${nullScore_hidden.toLocaleString()}`);
console.log(`  null score, legacy:     ${nullScore_legacy.toLocaleString()}`);
console.log(`  null score, forfeit:    ${nullScore_forfeit.toLocaleString()}`);

console.log('\n🚦 STATUS BREAKDOWN (non-FINAL, non-UPCOMING, non-blank)');
console.log('─'.repeat(50));
const sortedStatuses = Object.entries(statusCounts).sort((a, b) => b[1] - a[1]);
if (sortedStatuses.length === 0) console.log('  (none)');
for (const [st, count] of sortedStatuses) console.log(`  ${st.padEnd(20)} ${count.toLocaleString()}`);

console.log('\n🔍 RAW GAME ENTRY SAMPLES');
console.log('─'.repeat(50));
for (const [bucket, entries] of Object.entries(samples)) {
  if (!entries.length) continue;
  console.log(`\n  [${bucket}] (${entries.length} sample${entries.length > 1 ? 's' : ''})`);
  for (const e of entries) {
    const { seasonId, gameId, game } = e;
    const fields = Object.keys(game).filter(k => game[k] !== undefined && k !== 'hp' && k !== 'ap');
    console.log(`    Season: ${seasonId}  Game: ${gameId}`);
    console.log(`    Fields: ${fields.join(', ')}`);
    console.log(`    Data:   ${JSON.stringify(game)}`);
  }
}

console.log('\n' + '═'.repeat(60));
console.log('  Diagnostic complete.\n');
