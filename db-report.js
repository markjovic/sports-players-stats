#!/usr/bin/env node
// db-report.js
'use strict';

const fs   = require('fs');
const path = require('path');

const ARGS = Object.fromEntries(
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
const activeSids = new Set(seasonList.filter(s => s.locked === false).map(s => s.id));
const lockedSids = new Set(seasonList.filter(s => s.locked !== false).map(s => s.id));

console.log('📅 SEASONS');
console.log(`  Total:    ${seasonList.length.toLocaleString()}`);
console.log(`  Active:   ${activeSids.size.toLocaleString()} (locked: false)`);
console.log(`  Locked:   ${lockedSids.size.toLocaleString()} (completed)`);

// ─── Players ──────────────────────────────────────────────────────────────────

let playerIndexCount = 0, playerDetailCount = 0;
if (fs.existsSync(PLAYERS_IDX)) {
  for (const f of fs.readdirSync(PLAYERS_IDX).filter(f => f.endsWith('.json'))) {
    try { playerIndexCount += Object.keys(JSON.parse(fs.readFileSync(path.join(PLAYERS_IDX, f), 'utf8'))).length; } catch (e) {}
  }
}
if (INCLUDE_PLAYERS && fs.existsSync(PLAYERS_DIR)) {
  for (const shard of fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/i.test(d))) {
    try { playerDetailCount += fs.readdirSync(path.join(PLAYERS_DIR, shard)).filter(f => f.endsWith('.json')).length; } catch (e) {}
  }
}
console.log('\n👤 PLAYERS');
console.log(`  Index entries (career stats):  ${playerIndexCount.toLocaleString()}`);
console.log(`  Detail files (full history):   ${INCLUDE_PLAYERS ? playerDetailCount.toLocaleString() : '(run with include_players=true to count)'}`);

// ─── Teams ────────────────────────────────────────────────────────────────────

let teamCount = 0;
if (fs.existsSync(TEAM_DIR)) {
  for (const f of fs.readdirSync(TEAM_DIR).filter(f => f.endsWith('.json'))) {
    try { teamCount += Object.keys(JSON.parse(fs.readFileSync(path.join(TEAM_DIR, f), 'utf8'))).length; } catch (e) {}
  }
}
console.log('\n🏀 TEAMS');
console.log(`  Unique team IDs in lookup: ${teamCount.toLocaleString()}`);

// ─── Venues ───────────────────────────────────────────────────────────────────

let venueCount = 0, courtCount = 0;
if (fs.existsSync(VENUE_DIR)) {
  for (const f of fs.readdirSync(VENUE_DIR).filter(f => f.endsWith('.json'))) {
    try {
      for (const v of Object.values(JSON.parse(fs.readFileSync(path.join(VENUE_DIR, f), 'utf8')))) {
        venueCount++;
        courtCount += Object.keys(v.courts || {}).length;
      }
    } catch (e) {}
  }
}
console.log('\n📍 VENUES');
console.log(`  Unique venues: ${venueCount.toLocaleString()}`);
console.log(`  Unique courts: ${courtCount.toLocaleString()}`);

// ─── Games ────────────────────────────────────────────────────────────────────

// Counters — split by active vs locked season where relevant
let total = 0, scored = 0, withVenue = 0;
let forfeit = 0, hidden = 0, legacy = 0;
let stFinal = 0, stUpcoming = 0, stOther = 0, stNone = 0;
let stNone_active = 0, stNone_locked = 0;
let nullScore = 0, nullScore_active = 0, nullScore_locked = 0;
let nullScore_final = 0, nullScore_upcoming = 0, nullScore_nostatus = 0;
const seasonBreakdown = [];

if (fs.existsSync(GAMES_DIR)) {
  for (const file of fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'))) {
    const seasonId = file.replace('.json', '');
    const isActive = activeSids.has(seasonId);
    let sg;
    try { sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8')); } catch (e) { continue; }
    const games = Object.values(sg.games || {});
    if (!games.length) continue;

    for (const g of games) {
      total++;
      if (typeof g.hs === 'number') scored++;
      if (g.vid) withVenue++;
      if (g.forfeit) forfeit++;
      if (g.hidden)  hidden++;
      if (g.legacy)  legacy++;

      const st = g.st || '';
      if      (st === 'FINAL')    stFinal++;
      else if (st === 'UPCOMING') stUpcoming++;
      else if (st === '')         { stNone++; if (isActive) stNone_active++; else stNone_locked++; }
      else                        stOther++;

      if (g.hs === null) {
        nullScore++;
        if (isActive) nullScore_active++; else nullScore_locked++;
        if      (st === 'FINAL')    nullScore_final++;
        else if (st === 'UPCOMING') nullScore_upcoming++;
        else if (st === '')         nullScore_nostatus++;
      }
    }

    if (VERBOSE) {
      const s = seasons[seasonId];
      seasonBreakdown.push({
        id: seasonId, name: s?.name || seasonId, active: isActive,
        total: games.length,
        scored: games.filter(g => typeof g.hs === 'number').length,
        venue:  games.filter(g => g.vid).length,
        forfeit: games.filter(g => g.forfeit).length,
        hidden:  games.filter(g => g.hidden).length,
        legacy:  games.filter(g => g.legacy).length,
        upcoming: games.filter(g => g.st === 'UPCOMING').length,
        noStatus: games.filter(g => !g.st).length,
      });
    }
  }
}

// ─── Derived counts ───────────────────────────────────────────────────────────

const permanentlyNoScore = forfeit + hidden + legacy;
const permanentlyNoVenue = forfeit + hidden + legacy;

// Games that SHOULD have a score: total minus upcoming, minus permanently no-score
const eligibleForScore   = total - stUpcoming - permanentlyNoScore;
// Games that SHOULD have a venue: total minus upcoming, minus permanently no-venue
const eligibleForVenue   = total - stUpcoming - permanentlyNoVenue;
// Genuinely missing venue = missing - permanently none - upcoming
const missingVenue       = total - withVenue;
const genuinelyMissingV  = missingVenue - permanentlyNoVenue - stUpcoming;

const scorePct = eligibleForScore > 0 ? ((scored / eligibleForScore) * 100).toFixed(1) : 'N/A';
const venuePct = eligibleForVenue > 0 ? ((withVenue / eligibleForVenue) * 100).toFixed(1) : 'N/A';

// ─── Output ───────────────────────────────────────────────────────────────────

// ─── Index sync check ─────────────────────────────────────────────────────────

const DISC_FILE = path.join(__dirname, 'seasons-discovered.json');
const disc      = fs.existsSync(DISC_FILE) ? JSON.parse(fs.readFileSync(DISC_FILE, 'utf8')) : {};

const gameFiles = fs.existsSync(GAMES_DIR)
  ? fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
  : [];

const notInIndex     = gameFiles.filter(id => !seasons[id]);
const notInDiscovered = notInIndex.filter(id => !disc[id]);
const inDiscovered   = notInIndex.filter(id => !!disc[id]);

console.log('\n🔍 INDEX SYNC CHECK');
console.log(`  Season game files on disk:       ${gameFiles.length.toLocaleString()}`);
console.log(`  Seasons in sports-index.json:    ${seasonList.length.toLocaleString()}`);
console.log(`  Game files NOT in index:         ${notInIndex.length.toLocaleString()}`);
console.log(`    - Also in seasons-discovered:  ${inDiscovered.length.toLocaleString()}`);
console.log(`    - Not in either file:          ${notInDiscovered.length.toLocaleString()}`);
if (notInIndex.length > 0 && notInIndex.length <= 20) {
  console.log(`  Missing season IDs: ${notInIndex.join(', ')}`);
} else if (notInIndex.length > 0) {
  console.log(`  Sample missing IDs: ${notInIndex.slice(0, 5).join(', ')} ...`);
}
console.log(`  Total game entries:              ${total.toLocaleString()}`);

console.log('\n  By status:');
console.log(`    FINAL:                         ${stFinal.toLocaleString()}`);
console.log(`    UPCOMING:                      ${stUpcoming.toLocaleString()}`);
console.log(`    Other (postponed etc):         ${stOther.toLocaleString()}`);
console.log(`    No status:                     ${stNone.toLocaleString()}`);
console.log(`      - in active seasons:         ${stNone_active.toLocaleString()}`);
console.log(`      - in locked seasons:         ${stNone_locked.toLocaleString()} ⚠ should be 0 after fix-game-status`);

console.log('\n  Scores:');
console.log(`    With numeric score:            ${scored.toLocaleString()}`);
console.log(`    Forfeit (no score):            ${forfeit.toLocaleString()}`);
console.log(`    Hidden grading rounds:         ${hidden.toLocaleString()}`);
console.log(`    Legacy (orphaned):             ${legacy.toLocaleString()}`);
console.log(`    UPCOMING (not yet played):     ${stUpcoming.toLocaleString()}`);
console.log(`    Null score (checked, none):    ${nullScore.toLocaleString()}`);
console.log(`      - in active seasons:         ${nullScore_active.toLocaleString()}`);
console.log(`      - in locked seasons:         ${nullScore_locked.toLocaleString()}`);
console.log(`      - status FINAL:              ${nullScore_final.toLocaleString()}`);
console.log(`      - status UPCOMING:           ${nullScore_upcoming.toLocaleString()}`);
console.log(`      - no status:                 ${nullScore_nostatus.toLocaleString()}`);

console.log('\n  Venues:');
console.log(`    With venue:                    ${withVenue.toLocaleString()}`);
console.log(`    Missing venue total:           ${missingVenue.toLocaleString()}`);
console.log(`      Permanently none:            ${permanentlyNoVenue.toLocaleString()} (forfeit/hidden/legacy)`);
console.log(`      UPCOMING:                    ${stUpcoming.toLocaleString()}`);
console.log(`      Genuinely missing:           ${genuinelyMissingV.toLocaleString()} (PlayHQ has no allocation)`);

console.log('\n📈 COVERAGE (eligible games only)');
console.log(`  Score coverage: ${scorePct}%`);
console.log(`    Eligible: ${eligibleForScore.toLocaleString()} (total minus upcoming/forfeit/hidden/legacy)`);
console.log(`    Scored:   ${scored.toLocaleString()}`);
console.log(`    Gap:      ${(eligibleForScore - scored).toLocaleString()} — breakdown above (null/no-status)`);
console.log(`  Venue coverage: ${venuePct}%`);
console.log(`    Eligible: ${eligibleForVenue.toLocaleString()} (total minus upcoming/permanently-none)`);
console.log(`    With venue: ${withVenue.toLocaleString()}`);
console.log(`    Gap:        ${genuinelyMissingV.toLocaleString()} genuinely missing`);

console.log('\n🚩 GAME FLAGS');
console.log(`  forfeit: true    ${forfeit.toLocaleString()} — won by forfeit, no score`);
console.log(`  hidden:  true    ${hidden.toLocaleString()} — admin-hidden grading rounds`);
console.log(`  legacy:  true    ${legacy.toLocaleString()} — genuinely orphaned, no data accessible`);

if (VERBOSE && seasonBreakdown.length > 0) {
  console.log('\n📋 PER-SEASON BREAKDOWN (top 20 by game count)');
  seasonBreakdown.sort((a, b) => b.total - a.total).slice(0, 20).forEach(s => {
    const flag = s.active ? '🟢' : '🔒';
    console.log(`  ${flag} ${s.id}  ${(s.name||'').padEnd(40)} ${String(s.total).padStart(6)} total  score:${s.scored} venue:${s.venue} up:${s.upcoming} noSt:${s.noStatus} forfeit:${s.forfeit} hidden:${s.hidden} legacy:${s.legacy}`);
  });
}

console.log('\n' + '═'.repeat(60));
