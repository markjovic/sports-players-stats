#!/usr/bin/env node
// bootstrap-fixture-progress.js
/**
 * Pre-populates discover-fixtures-progress.json with all current season IDs
 * so discover-fixtures.js --all-seasons doesn't re-process everything.
 *
 * Also identifies zero-team seasons by checking which seasons have no
 * home/away team IDs in their game files, and writes zero-team-seasons.json.
 *
 * Run this ONCE after a completed --all-seasons discover-fixtures run
 * to avoid having to re-run the full 8+ hour crawl.
 *
 * Usage:
 *   node bootstrap-fixture-progress.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const INDEX_FILE    = path.join(__dirname, 'sports-index.json');
const GAMES_DIR     = path.join(__dirname, 'games', 'bv');
const PROGRESS_FILE = path.join(__dirname, 'discover-fixtures-progress.json');
const ZERO_FILE     = path.join(__dirname, 'zero-team-seasons.json');
const DISC_FILE     = path.join(__dirname, 'seasons-discovered.json');

if (!fs.existsSync(INDEX_FILE)) {
  console.error('sports-index.json not found');
  process.exit(1);
}

const index    = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
const seasons  = index.seasons || {};
const disc     = fs.existsSync(DISC_FILE) ? JSON.parse(fs.readFileSync(DISC_FILE, 'utf8')) : {};

console.log(`Total seasons in index: ${Object.keys(seasons).length}`);
console.log('Scanning game files for zero-team seasons...\n');

const done          = [];
const zeroTeam      = [];
const hasTeams      = [];
let   noGameFile    = 0;

for (const [seasonId, season] of Object.entries(seasons)) {
  const gameFile = path.join(GAMES_DIR, `${seasonId}.json`);

  // Only mark locked (completed) seasons as done
  // Active seasons (locked: false) must always re-run to pick up new scores/fixtures
  if (season.locked !== false) {
    done.push(seasonId);
  }

  if (!fs.existsSync(gameFile)) {
    noGameFile++;
    // No game file at all — definitely zero team data
    const discEntry = disc[seasonId] || {};
    zeroTeam.push({
      id:     seasonId,
      name:   season.fullName || season.name || discEntry.name || '?',
      org:    discEntry.orgName || '?',
      comp:   discEntry.compName || '?',
      grades: (season.grades || []).length,
      reason: 'no game file',
    });
    continue;
  }

  let sg;
  try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); }
  catch (e) { noGameFile++; continue; }

  const games      = Object.values(sg.games || {});
  // A season is "zero-team" if none of its games have a home team ID (h field)
  // This matches what discover-fixtures sees when discoverGrade.ladder returns empty
  const withTeamIds = games.filter(g => g.h).length;

  if (games.length === 0 || withTeamIds === 0) {
    const discEntry = disc[seasonId] || {};
    zeroTeam.push({
      id:     seasonId,
      name:   season.fullName || season.name || discEntry.name || '?',
      org:    discEntry.orgName || '?',
      comp:   discEntry.compName || '?',
      grades: (season.grades || []).length,
      games:  games.length,
      reason: games.length === 0 ? 'empty game file' : 'no home team IDs (ladder not used)',
    });
  } else {
    hasTeams.push(seasonId);
  }
}

// Write progress file
fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
  done,
  savedAt: new Date().toISOString(),
}));

// Write zero-team file sorted by name
zeroTeam.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
fs.writeFileSync(ZERO_FILE, JSON.stringify(zeroTeam, null, 2));

// Also write a separate list of seasons with grades but no h field in games
// These are seasons where the ladder API returns empty — game data exists from
// player crawl (on/o fields) but no home/away team IDs were ever populated
const noLadderFile = path.join(__dirname, 'no-ladder-seasons.json');
const noLadder = [];
for (const [seasonId, season] of Object.entries(seasons)) {
  if ((season.grades || []).length === 0) continue; // no grades, skip
  const gameFile = path.join(GAMES_DIR, `${seasonId}.json`);
  if (!fs.existsSync(gameFile)) continue;
  let sg;
  try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); } catch (e) { continue; }
  const games = Object.values(sg.games || {});
  if (games.length === 0) continue;
  // Has games from player crawl (on field) but no home team ID (h field)
  const withOpponent = games.filter(g => g.on).length;
  const withHomeId   = games.filter(g => g.h).length;
  if (withOpponent > 0 && withHomeId === 0) {
    const discEntry = disc[seasonId] || {};
    noLadder.push({
      id:     seasonId,
      name:   season.fullName || season.name || discEntry.name || '?',
      org:    discEntry.orgName || '?',
      comp:   discEntry.compName || '?',
      grades: (season.grades || []).length,
      games:  games.length,
    });
  }
}
noLadder.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
fs.writeFileSync(noLadderFile, JSON.stringify(noLadder, null, 2));

const activeCount = Object.values(seasons).filter(s => s.locked === false).length;
console.log(`✅ Done`);
console.log(`  Total seasons in index:    ${Object.keys(seasons).length}`);
console.log(`  Locked (marked done):      ${done.length}`);
console.log(`  Active (will always run):  ${activeCount}`);
console.log(`  Seasons with team data:    ${hasTeams.length}`);
console.log(`  Zero-team seasons:         ${zeroTeam.length}`);
console.log(`    - No game file:          ${zeroTeam.filter(z => z.reason === 'no game file').length}`);
console.log(`    - Empty game file:       ${zeroTeam.filter(z => z.reason === 'empty game file').length}`);
console.log(`    - No team IDs in games:  ${zeroTeam.filter(z => z.reason === 'no home team IDs (ladder not used)').length}`);
console.log(`  No-ladder seasons:         ${noLadder.length} (grades exist, games have no home team IDs)`);
console.log();
console.log(`  Written: ${PROGRESS_FILE}`);
console.log(`  Written: ${ZERO_FILE}`);
console.log(`  Written: ${noLadderFile}`);
console.log();
console.log(`  Next discover-fixtures --all-seasons run will skip ${done.length} locked seasons`);
console.log(`  and always re-process ${activeCount} active seasons.`);
