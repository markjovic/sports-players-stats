#!/usr/bin/env node
// db-report.js
/**
 * Generates a detailed report on the current state of the sports-players-stats database.
 * Scans all game files, player index shards, and data files to produce accurate counts.
 *
 * Usage:
 *   node db-report.js
 *   node db-report.js --verbose    (show per-season breakdown)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ARGS    = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k,...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const VERBOSE = !!ARGS.verbose;
const TENANT  = ARGS.tenant || 'bv';

const GAMES_DIR      = path.join(__dirname, 'games', TENANT);
const PLAYERS_DIR    = path.join(__dirname, 'players');
const PLAYERS_IDX    = path.join(__dirname, 'players-index');
const VENUE_DIR      = path.join(__dirname, 'venue-lookup');
const TEAM_DIR       = path.join(__dirname, 'team-lookup');
const INDEX_FILE     = path.join(__dirname, 'sports-index.json');
const PROGRESS_FILE  = path.join(__dirname, 'backfill-hidden-progress.json');

console.log('\n📊 Sports Player Stats — Database Report');
console.log('═'.repeat(60));
console.log(`  Generated: ${new Date().toISOString()}`);
console.log(`  Tenant:    ${TENANT}\n`);

// ─── Seasons ──────────────────────────────────────────────────────────────────

const index   = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
const seasons = index.seasons || {};
const seasonList = Object.values(seasons);
const active  = seasonList.filter(s => s.locked === false);
const locked  = seasonList.filter(s => s.locked !== false);

console.log('📅 SEASONS');
console.log(`  Total:    ${seasonList.length.toLocaleString()}`);
console.log(`  Active:   ${active.length.toLocaleString()}`);
console.log(`  Locked:   ${locked.length.toLocaleString()}`);

// ─── Players ──────────────────────────────────────────────────────────────────

let playerCount = 0;
let playerIndexCount = 0;

if (fs.existsSync(PLAYERS_IDX)) {
  for (const file of fs.readdirSync(PLAYERS_IDX).filter(f => f.endsWith('.json'))) {
    try {
      const shard = JSON.parse(fs.readFileSync(path.join(PLAYERS_IDX, file), 'utf8'));
      playerIndexCount += Object.keys(shard).length;
    } catch (e) {}
  }
}

if (fs.existsSync(PLAYERS_DIR)) {
  for (const shard of fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/i.test(d))) {
    const dir = path.join(PLAYERS_DIR, shard);
    try { playerCount += fs.readdirSync(dir).filter(f => f.endsWith('.json')).length; } catch (e) {}
  }
}

console.log('\n👤 PLAYERS');
console.log(`  Player index entries: ${playerIndexCount.toLocaleString()}`);
console.log(`  Player detail files:  ${playerCount.toLocaleString()}`);

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
let upcomingGames = 0, finalGames = 0;
let nullScoreFinal = 0;
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
    const sHidden   = games.filter(g => g.hidden).length;
    const sLegacy   = games.filter(g => g.legacy).length;
    const sUpcoming = games.filter(g => g.st === 'UPCOMING' || (!g.st && !g.hs && !g.forfeit && !g.hidden && !g.legacy)).length;
    const sFinal    = games.filter(g => g.st === 'FINAL').length;
    const sNullFinal = games.filter(g => g.hs === null && g.st === 'FINAL').length;

    totalGames   += sTotal;
    withScore    += sScored;
    withVenue    += sVenue;
    forfeitGames += sForfeit;
    hiddenGames  += sHidden;
    legacyGames  += sLegacy;
    upcomingGames += sUpcoming;
    finalGames   += sFinal;
    nullScoreFinal += sNullFinal;

    if (VERBOSE) {
      const seasonId = file.replace('.json', '');
      const season   = seasons[seasonId];
      seasonBreakdown.push({
        id: seasonId, name: season?.name || seasonId,
        total: sTotal, scored: sScored, venue: sVenue,
        forfeit: sForfeit, hidden: sHidden, legacy: sLegacy,
      });
    }
  }
}

const permanentlyNoVenue = forfeitGames + hiddenGames + legacyGames;
const genuinelyMissingVenue = (totalGames - withVenue) - permanentlyNoVenue;

console.log('\n🎮 GAMES');
console.log(`  Total game entries:         ${totalGames.toLocaleString()}`);
console.log();
console.log(`  By status:`);
console.log(`    FINAL:                    ${finalGames.toLocaleString()}`);
console.log(`    UPCOMING/unplayed:        ${upcomingGames.toLocaleString()}`);
console.log();
console.log(`  Scores:`);
console.log(`    With numeric score:       ${withScore.toLocaleString()}`);
console.log(`    Forfeit (no score):       ${forfeitGames.toLocaleString()}`);
console.log(`    Hidden grading rounds:    ${hiddenGames.toLocaleString()}`);
console.log(`    Legacy (orphaned):        ${legacyGames.toLocaleString()}`);
console.log(`    FINAL with null score:    ${nullScoreFinal.toLocaleString()}`);
console.log(`    Unplayed (no score yet):  ${upcomingGames.toLocaleString()}`);
console.log();
console.log(`  Venues:`);
console.log(`    With venue:               ${withVenue.toLocaleString()}`);
console.log(`    Missing venue total:      ${(totalGames - withVenue).toLocaleString()}`);
console.log(`      Permanently none:       ${permanentlyNoVenue.toLocaleString()} (forfeit/hidden/legacy)`);
console.log(`      Genuinely missing:      ${genuinelyMissingVenue.toLocaleString()} (PlayHQ has no allocation)`);

// ─── Coverage summary ─────────────────────────────────────────────────────────

const scoreCoverage  = ((withScore / (totalGames - hiddenGames - upcomingGames)) * 100).toFixed(1);
const venueCoverage  = ((withVenue / (totalGames - permanentlyNoVenue)) * 100).toFixed(1);

console.log('\n📈 COVERAGE (excluding games that can never have data)');
console.log(`  Score coverage:  ${scoreCoverage}%`);
console.log(`  Venue coverage:  ${venueCoverage}%`);

// ─── Data flags summary ───────────────────────────────────────────────────────

console.log('\n🚩 GAME FLAGS');
console.log(`  forfeit: true    ${forfeitGames.toLocaleString()} games — won by forfeit, no score`);
console.log(`  hidden:  true    ${hiddenGames.toLocaleString()} games — admin-hidden grading rounds, score via spectator`);
console.log(`  legacy:  true    ${legacyGames.toLocaleString()} games — genuinely orphaned, no data accessible`);

// ─── Verbose season breakdown ─────────────────────────────────────────────────

if (VERBOSE && seasonBreakdown.length > 0) {
  console.log('\n📋 PER-SEASON BREAKDOWN (top 20 by game count)');
  seasonBreakdown.sort((a, b) => b.total - a.total).slice(0, 20).forEach(s => {
    console.log(`  ${s.id}  ${s.name.padEnd(45)} ${String(s.total).padStart(6)} games  score:${s.scored} venue:${s.venue} forfeit:${s.forfeit} hidden:${s.hidden} legacy:${s.legacy}`);
  });
}

console.log('\n' + '═'.repeat(60));
