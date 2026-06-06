#!/usr/bin/env node
// inspect-failed-games.js
/**
 * Inspects failed games from backfill-progress.json.
 * Looks up each game ID in the games/ files to show metadata:
 * season, date, round, opponent, team names.
 *
 * Usage:
 *   node inspect-failed-games.js                    # sample 50 random failed games
 *   node inspect-failed-games.js --sample=200       # larger sample
 *   node inspect-failed-games.js --all              # all failed games (slow)
 *   node inspect-failed-games.js --season=<id>      # only failed games in a specific season
 *   node inspect-failed-games.js --csv              # output as CSV for spreadsheet analysis
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const TENANT        = process.argv.find(a => a.startsWith('--tenant='))?.split('=')[1] || 'bv';
const SAMPLE        = parseInt(process.argv.find(a => a.startsWith('--sample='))?.split('=')[1] || '50', 10);
const ALL           = process.argv.includes('--all');
const CSV           = process.argv.includes('--csv');
const FILTER_SEASON = process.argv.find(a => a.startsWith('--season='))?.split('=')[1] || null;

const GAMES_DIR      = path.join(__dirname, 'games', TENANT);
const PROGRESS_FILE  = path.join(__dirname, 'backfill-progress.json');

// ─── Load progress ────────────────────────────────────────────────────────────

if (!fs.existsSync(PROGRESS_FILE)) {
  console.error(`❌ ${PROGRESS_FILE} not found`);
  process.exit(1);
}

const prog   = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
const failed = new Set(prog.failed || []);
console.log(`Failed games in progress file: ${failed.size.toLocaleString()}\n`);

if (failed.size === 0) {
  console.log('No failed games to inspect.');
  process.exit(0);
}

// ─── Build reverse index: gameId → { seasonId, seasonFile, game } ─────────────

console.log('Building game index from season files...');
const gameIndex = {};  // gameId → { seasonId, file, game }

const seasonFiles = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
for (const file of seasonFiles) {
  const seasonId = file.replace('.json', '');
  if (FILTER_SEASON && seasonId !== FILTER_SEASON) continue;
  let sg;
  try {
    sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8'));
  } catch (e) { continue; }
  for (const [gameId, game] of Object.entries(sg.games || {})) {
    if (failed.has(gameId)) {
      gameIndex[gameId] = { seasonId, file, game };
    }
  }
}

const indexed    = Object.keys(gameIndex).length;
const notInFiles = failed.size - indexed;
console.log(`Found in game files:  ${indexed.toLocaleString()}`);
if (notInFiles > 0) console.log(`Not in any game file: ${notInFiles.toLocaleString()} (game IDs with no file entry)`);
console.log();

// ─── Select sample ────────────────────────────────────────────────────────────

const allEntries = Object.entries(gameIndex);
let sample;

if (ALL) {
  sample = allEntries;
} else {
  // Random sample — shuffle and take first N
  const shuffled = allEntries.sort(() => Math.random() - 0.5);
  sample = shuffled.slice(0, Math.min(SAMPLE, allEntries.length));
}

// ─── Analyse and report ───────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);

if (CSV) {
  console.log('gameId,seasonId,date,round,homeTeam,awayTeam,opponent,isPast');
  for (const [gameId, { seasonId, game }] of sample) {
    const isPast = !game.d || game.d <= today;
    const home   = game.hn || game.h || '';
    const away   = game.an || game.a || '';
    const opp    = game.on || '';
    const round  = (game.rn || '').replace(/,/g, ';');
    console.log(`${gameId},${seasonId},${game.d || ''},${round},"${home}","${away}","${opp}",${isPast}`);
  }
  process.exit(0);
}

// Group by season for readable output
const bySeason = {};
for (const [gameId, { seasonId, file, game }] of sample) {
  if (!bySeason[seasonId]) bySeason[seasonId] = { file, games: [] };
  bySeason[seasonId].games.push({ gameId, game });
}

// Summary stats across all failed games (not just sample)
const roundTypes = {};
const yearDist   = {};
let futureCount  = 0;
let noRound      = 0;
let noDate       = 0;

for (const [, { game }] of allEntries) {
  const rn = (game.rn || '').toUpperCase();
  const yr = game.d ? game.d.slice(0, 4) : null;
  if (!game.d) { noDate++; }
  else if (game.d > today) { futureCount++; }
  if (!rn) { noRound++; }
  else {
    const type = rn.includes('GRAND FINAL') ? 'Grand Final'
               : rn.includes('FINAL')       ? 'Finals'
               : rn.includes('BYE')         ? 'Bye'
               : 'Regular';
    roundTypes[type] = (roundTypes[type] || 0) + 1;
  }
  if (yr) yearDist[yr] = (yearDist[yr] || 0) + 1;
}

console.log('=== Summary of ALL failed games ===');
console.log(`Total: ${indexed.toLocaleString()}`);
console.log();
console.log('By round type:');
for (const [type, count] of Object.entries(roundTypes).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${type.padEnd(15)} ${count.toLocaleString()}`);
}
if (noRound) console.log(`  ${'No round'.padEnd(15)} ${noRound.toLocaleString()}`);
console.log();
console.log('By year:');
for (const yr of Object.keys(yearDist).sort()) {
  const bar = '█'.repeat(Math.round(yearDist[yr] / 200));
  console.log(`  ${yr}: ${String(yearDist[yr]).padStart(6)}  ${bar}`);
}
if (noDate)     console.log(`  No date: ${noDate}`);
if (futureCount) console.log(`  Future:  ${futureCount} (stored with future date but in failed set)`);

console.log();
console.log(`=== Sample of ${sample.length} failed games ===`);
console.log();

for (const [seasonId, { file, games }] of Object.entries(bySeason)) {
  console.log(`Season: ${seasonId} (${file})`);
  console.log('─'.repeat(80));
  for (const { gameId, game } of games) {
    const dateStr  = game.d || 'no date';
    const roundStr = game.rn || 'no round';
    const past     = !game.d || game.d <= today ? '(past)' : '(FUTURE)';
    const home     = game.hn ? `${game.hn} vs ${game.an}` : `opp: ${game.on || '?'}`;
    const hasScore = game.hs !== undefined ? `${game.hs}–${game.as}` : 'no score';
    console.log(`  ${gameId}  ${dateStr} ${past}  ${roundStr.padEnd(20)}  ${home}  [${hasScore}]`);
  }
  console.log();
}
