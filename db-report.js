#!/usr/bin/env node
// db-report.js
/**
 * Generates a detailed report on the current state of the sports-players-stats database.
 *
 * Usage:
 *   node db-report.js
 *   node db-report.js --verbose    (show per-season breakdown, top 20)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ARGS    = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k,...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const VERBOSE         = !!ARGS.verbose;
const INCLUDE_PLAYERS = !!ARGS['include-players'];
const TENANT          = ARGS.tenant || 'bv';

const GAMES_DIR   = path.join(__dirname, 'games', TENANT);
const PLAYERS_DIR = path.join(__dirname, 'players');
const PLAYERS_IDX = path.join(__dirname, 'players-index');
const VENUE_DIR   = path.join(__dirname, 'venue-lookup');
const TEAM_DIR    = path.join(__dirname, 'team-lookup');
const INDEX_FILE  = path.join(__dirname, 'sports-index.json');

console.log('\n📊 Sports Player Stats — Database Report');
console.log('═'.repeat(60));
console.log(`  Generated: ${new Date().toISOString()}`);
console.log(`  Tenant:    ${TENANT}\n`);

// ─── Seasons ──────────────────────────────────────────────────────────────────

const index      = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
const seasons    = index.seasons || {};
const seasonList = Object.values(seasons);
const active     = seasonList.filter(s => s.locked === false);
const locked     = seasonList.filter(s => s.locked !== false);

console.log('📅 SEASONS');
console.log(`  Total:    ${seasonList.length.toLocaleString()}`);
console.log(`  Active:   ${active.length.toLocaleString()} (locked: false)`);
console.log(`  Locked:   ${locked.length.toLocaleString()} (locked: true — completed)`);

// ─── Players ──────────────────────────────────────────────────────────────────

let playerIndexCount = 0;
let playerDetailCount = 0;

if (fs.existsSync(PLAYERS_IDX)) {
  for (const file of fs.readdirSync(PLAYERS_IDX).filter(f => f.endsWith('.json'))) {
    try {
      const shard = JSON.parse(fs.readFileSync(path.join(PLAYERS_IDX, file), 'utf8'));
      playerIndexCount += Object.keys(shard).length;
    } catch (e) {}
  }
}

if (INCLUDE_PLAYERS && fs.existsSync(PLAYERS_DIR)) {
  for (const shard of fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/i.test(d))) {
    try { playerDetailCount += fs.readdirSync(path.join(PLAYERS_DIR, shard)).filter(f => f.endsWith('.json')).length; }
    catch (e) {}
  }
}

console.log('\n👤 PLAYERS');
console.log(`  Index entries (career stats):  ${playerIndexCount.toLocaleString()}`);
console.log(`  Detail files (full history):   ${INCLUDE_PLAYERS ? playerDetailCount.toLocaleString() : '(run with include_players=true to count)'}`);

// ─── Teams ────────────────────────────────────────────────────────────────────

let teamCount = 0;
if (fs.existsSync(TEAM_DIR)) {
  for (const file of fs.readdirSync(TEAM_DIR).filter(f => f.endsWith('.json'))) {
    try {
      const shard = JSON.parse(fs.readFileSync(path.join(TEAM_DIR, file), 'utf8'));
      teamCount += Object.keys(shard).length;
    } catch (e) {}
  }
}

console.log('\n🏀 TEAMS');
console.log(`  Unique team IDs in lookup: ${teamCount.toLocaleString()}`);

// ─── Venues ───────────────────────────────────────────────────────────────────

let venueCount = 0, courtCount = 0;
if (fs.existsSync(VENUE_DIR)) {
  for (const file of fs.readdirSync(VENUE_DIR).filter(f => f.endsWith('.json'))) {
    try {
      const shard = JSON.parse(fs.readFileSync(path.join(VENUE_DIR, file), 'utf8'));
      for (const venue of Object.values(shard)) {
        venueCount++;
        courtCount += Object.keys(venue.courts || {}).length;
      }
    } catch (e) {}
  }
}

console.log('\n📍 VENUES');
console.log(`  Unique venues: ${venueCount.toLocaleString()}`);
console.log(`  Unique courts: ${courtCount.toLocaleString()}`);

// ─── Games ────────────────────────────────────────────────────────────────────

let totalGames = 0;
let withScore = 0, withVenue = 0;
let forfeitGames = 0, hiddenGames = 0, legacyGames = 0;
let upcomingGames = 0, finalGames = 0, noStatusGames = 0;
let nullScoreGames = 0;
const seasonBreakdown = [];

if (fs.existsSync(GAMES_DIR)) {
  for (const file of fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'))) {
    let sg;
    try { sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8')); } catch (e) { continue; }
    const games = Object.values(sg.games || {});
    if (games.length === 0) continue;

    const sTotal    = games.length;
    const sScored   = games.filter(g => typeof g.hs === 'number').length;
    const sVenue    = games.filter(g => g.vid).length;
    const sForfeit  = games.filter(g => g.forfeit).length;
    const sHidden   = games.filter(g => g.hidden && g.st !== 'UPCOMING').length;
    const sLegacy   = games.filter(g => g.legacy).length;
    const sUpcoming = games.filter(g => g.st === 'UPCOMING').length;
    const sFinal    = games.filter(g => g.st === 'FINAL').length;
    const sNoStatus = games.filter(g => !g.st).length;
    const sNullScore = games.filter(g => g.hs === null).length;

    totalGames    += sTotal;
    withScore     += sScored;
    withVenue     += sVenue;
    forfeitGames  += sForfeit;
    hiddenGames   += sHidden;
    legacyGames   += sLegacy;
    upcomingGames += sUpcoming;
    finalGames    += sFinal;
    noStatusGames += sNoStatus;
    nullScoreGames += sNullScore;

    if (VERBOSE) {
      const seasonId = file.replace('.json', '');
      const season   = seasons[seasonId];
      seasonBreakdown.push({
        id: seasonId, name: season?.name || seasonId,
        total: sTotal, scored: sScored, venue: sVenue,
        forfeit: sForfeit, hidden: sHidden, legacy: sLegacy,
        upcoming: sUpcoming,
      });
    }
  }
}

// Games that cannot have a score by nature
const permanentlyNoScore  = forfeitGames + hiddenGames + legacyGames;
// Games that cannot have a venue by nature
const permanentlyNoVenue  = forfeitGames + hiddenGames + legacyGames;
// Games that should have a score (played, not forfeit/hidden/legacy)
const shouldHaveScore     = totalGames - upcomingGames - permanentlyNoScore;
// Games that should have a venue (played, not permanently venue-less, not upcoming)
const shouldHaveVenue     = totalGames - permanentlyNoVenue - upcomingGames;
const genuinelyMissingVenue = (totalGames - withVenue) - permanentlyNoVenue - upcomingGames;

const scoreCoverage = shouldHaveScore > 0
  ? ((withScore / shouldHaveScore) * 100).toFixed(1) : 'N/A';
const venueCoverage = shouldHaveVenue > 0
  ? ((withVenue / shouldHaveVenue) * 100).toFixed(1) : 'N/A';

console.log('\n🎮 GAMES');
console.log(`  Total game entries:              ${totalGames.toLocaleString()}`);
console.log();
console.log(`  By status:`);
console.log(`    FINAL:                         ${finalGames.toLocaleString()}`);
console.log(`    UPCOMING:                      ${upcomingGames.toLocaleString()}`);
console.log(`    No status (player crawl only): ${noStatusGames.toLocaleString()}`);
console.log();
console.log(`  Scores:`);
console.log(`    With numeric score:            ${withScore.toLocaleString()}`);
console.log(`    Null score (checked, none):    ${nullScoreGames.toLocaleString()}`);
console.log(`    Forfeit (no score by nature):  ${forfeitGames.toLocaleString()}`);
console.log(`    Hidden grading rounds:         ${hiddenGames.toLocaleString()}`);
console.log(`    Legacy (orphaned):             ${legacyGames.toLocaleString()}`);
console.log(`    UPCOMING (not yet played):     ${upcomingGames.toLocaleString()}`);
console.log();
console.log(`  Venues:`);
console.log(`    With venue:                    ${withVenue.toLocaleString()}`);
console.log(`    Missing venue total:           ${(totalGames - withVenue).toLocaleString()}`);
console.log(`      Permanently none:            ${permanentlyNoVenue.toLocaleString()} (forfeit/hidden/legacy)`);
console.log(`      UPCOMING (not yet played):   ${upcomingGames.toLocaleString()}`);
console.log(`      Genuinely missing:           ${genuinelyMissingVenue.toLocaleString()} (PlayHQ has no allocation)`);

console.log('\n📈 COVERAGE');
console.log(`  Score coverage: ${scoreCoverage}%  (played games with a score, excl. forfeit/hidden/legacy/upcoming)`);
console.log(`  Venue coverage: ${venueCoverage}%  (played games with a venue, excl. permanently none/upcoming)`);

console.log('\n🚩 GAME FLAGS');
console.log(`  forfeit: true    ${forfeitGames.toLocaleString()} — won by forfeit, no score`);
console.log(`  hidden:  true    ${hiddenGames.toLocaleString()} — admin-hidden grading rounds`);
console.log(`  legacy:  true    ${legacyGames.toLocaleString()} — genuinely orphaned, no data accessible`);

console.log('\n⚠️  DATA GAPS');
console.log(`  No-status games needing fix-game-status: ${noStatusGames.toLocaleString()}`);
console.log(`  Genuinely missing venue:                 ${genuinelyMissingVenue.toLocaleString()}`);
console.log(`  Null-score completed games:              ${nullScoreGames.toLocaleString()}`);

if (VERBOSE && seasonBreakdown.length > 0) {
  console.log('\n📋 PER-SEASON BREAKDOWN (top 20 by game count)');
  seasonBreakdown.sort((a, b) => b.total - a.total).slice(0, 20).forEach(s => {
    console.log(`  ${s.id}  ${(s.name||'').padEnd(45)} ${String(s.total).padStart(6)} games  score:${s.scored} venue:${s.venue} up:${s.upcoming} forfeit:${s.forfeit} hidden:${s.hidden} legacy:${s.legacy}`);
  });
}

console.log('\n' + '═'.repeat(60));
