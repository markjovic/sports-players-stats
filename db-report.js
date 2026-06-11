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
console.log(`  Detail files (full history):   ${INCLUDE_PLAYERS ? playerDetailCount.toLocaleString() : '(run with --include-players to count)'}`);

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

let total = 0, scored = 0, withVenue = 0;
let forfeit = 0, hidden = 0, legacy = 0, bye = 0, postponed = 0;
let stFinal = 0, stUpcoming = 0, stPostponed = 0, stBye = 0, stOther = 0, stNone = 0;
let stNone_active = 0, stNone_locked = 0;
let nullScore = 0, nullScore_active = 0, nullScore_locked = 0;
let nullScore_final = 0, nullScore_upcoming = 0, nullScore_nostatus = 0;
// Team field structure counters
let teamHA = 0, teamOOnly = 0, teamBoth = 0, teamNeither = 0;
// Has s/sn (source team — post-normalise)
let hasSField = 0;
const otherStatuses = {};
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
      if (g.vid)     withVenue++;
      if (g.forfeit) forfeit++;
      if (g.hidden)  hidden++;
      if (g.legacy)  legacy++;
      if (g.bye)     bye++;
      if (g.s)       hasSField++;

      // Team field structure
      const hasH = !!g.h;
      const hasO = !!g.o;
      if      (hasH && hasO)  teamBoth++;
      else if (hasH)          teamHA++;
      else if (hasO)          teamOOnly++;
      else                    teamNeither++;

      const st = g.st || '';
      if      (st === 'FINAL')     stFinal++;
      else if (st === 'UPCOMING')  stUpcoming++;
      else if (st === 'POSTPONED') stPostponed++;
      else if (st === 'BYE')       stBye++;
      else if (st === '')          { stNone++; if (isActive) stNone_active++; else stNone_locked++; }
      else                         { stOther++; otherStatuses[st] = (otherStatuses[st] || 0) + 1; }

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
        scored:   games.filter(g => typeof g.hs === 'number').length,
        venue:    games.filter(g => g.vid).length,
        forfeit:  games.filter(g => g.forfeit).length,
        hidden:   games.filter(g => g.hidden).length,
        legacy:   games.filter(g => g.legacy).length,
        bye:      games.filter(g => g.bye).length,
        upcoming: games.filter(g => g.st === 'UPCOMING').length,
        noStatus: games.filter(g => !g.st).length,
      });
    }
  }
}

// ─── Derived counts ───────────────────────────────────────────────────────────
//
// Score eligibility:
//   Hidden games DO have scores — they stay in the eligible pool.
//   Forfeits, legacy, bye, postponed have no score by nature — excluded.
//   UPCOMING not yet played — excluded.
//
// Venue eligibility:
//   Hidden games do NOT have venues — excluded.
//   Forfeits MAY have a venue (scraped before forfeit) — kept in eligible pool.
//   Legacy, bye, postponed — excluded.
//   UPCOMING — excluded.

const noScoreByNature    = forfeit + legacy + bye + postponed;
const eligibleForScore   = total - stUpcoming - noScoreByNature;
const scored_pct         = eligibleForScore > 0 ? ((scored / eligibleForScore) * 100).toFixed(1) : 'N/A';
const scoreGap           = eligibleForScore - scored;

// For venue: hidden games never have venue, so they're out of eligible pool
// Forfeits may have a venue so they stay in — gap will reflect forfeits without venue
const noVenueByNature    = hidden + legacy + bye + postponed;
const eligibleForVenue   = total - stUpcoming - noVenueByNature;
const missingVenue       = eligibleForVenue - withVenue;
const venue_pct          = eligibleForVenue > 0 ? ((withVenue / eligibleForVenue) * 100).toFixed(1) : 'N/A';

// ─── Index sync check ─────────────────────────────────────────────────────────

const DISC_FILE = path.join(__dirname, 'seasons-discovered.json');
const disc      = fs.existsSync(DISC_FILE) ? JSON.parse(fs.readFileSync(DISC_FILE, 'utf8')) : {};

const gameFiles = fs.existsSync(GAMES_DIR)
  ? fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
  : [];

const notInIndex      = gameFiles.filter(id => !seasons[id]);
const inDiscovered    = notInIndex.filter(id => !!disc[id]);
const notInDiscovered = notInIndex.filter(id => !disc[id]);

// ─── Output ───────────────────────────────────────────────────────────────────

console.log('\n🔍 INDEX SYNC CHECK');
console.log(`  Season game files on disk:       ${gameFiles.length.toLocaleString()}`);
console.log(`  Seasons in sports-index.json:    ${seasonList.length.toLocaleString()}`);
console.log(`  Game files NOT in index:         ${notInIndex.length.toLocaleString()}`);
if (notInIndex.length > 0) {
  console.log(`    - Also in seasons-discovered:  ${inDiscovered.length.toLocaleString()}`);
  console.log(`    - Not in either file:          ${notInDiscovered.length.toLocaleString()}`);
  if (notInIndex.length <= 20) console.log(`  Missing IDs: ${notInIndex.join(', ')}`);
  else console.log(`  Sample missing IDs: ${notInIndex.slice(0, 5).join(', ')} ...`);
}

console.log(`\n  Total game entries: ${total.toLocaleString()}`);

console.log('\n  By status:');
console.log(`    FINAL:       ${stFinal.toLocaleString()}`);
console.log(`    UPCOMING:    ${stUpcoming.toLocaleString()}`);
console.log(`    POSTPONED:   ${stPostponed.toLocaleString()}`);
console.log(`    BYE:         ${stBye.toLocaleString()}`);
console.log(`    No status:   ${stNone.toLocaleString()}${stNone > 0 ? `  (active: ${stNone_active}, locked: ${stNone_locked}${stNone_locked > 0 ? ' ⚠ run fix-game-status' : ''})` : ''}`);
if (Object.keys(otherStatuses).length > 0) {
  console.log(`    Other:`);
  for (const [st, n] of Object.entries(otherStatuses).sort((a,b) => b[1]-a[1])) {
    console.log(`      ${st.padEnd(20)} ${n.toLocaleString()}`);
  }
}

console.log('\n  Flags:');
console.log(`    forfeit: true    ${forfeit.toLocaleString()}`);
console.log(`    hidden:  true    ${hidden.toLocaleString()}`);
console.log(`    legacy:  true    ${legacy.toLocaleString()}`);
console.log(`    bye:     true    ${bye.toLocaleString()}`);

console.log('\n  Team field structure:');
console.log(`    h + a only (absolute):         ${teamHA.toLocaleString()}`);
console.log(`    h + a + o/on (redundant):      ${teamBoth.toLocaleString()}${teamBoth > 0 ? '  ⚠ run normalise-game-structure' : ''}`);
console.log(`    o/on only (relative):          ${teamOOnly.toLocaleString()}`);
console.log(`    neither (bare):                ${teamNeither.toLocaleString()}`);
console.log(`    has s/sn (source team):        ${hasSField.toLocaleString()}`);

console.log('\n  Scores:');
console.log(`    With numeric score:            ${scored.toLocaleString()}`);
console.log(`    Null score (checked, none):    ${nullScore.toLocaleString()}`);
console.log(`      - active seasons:            ${nullScore_active.toLocaleString()}`);
console.log(`      - locked seasons:            ${nullScore_locked.toLocaleString()}`);
console.log(`      - status FINAL:              ${nullScore_final.toLocaleString()}`);
console.log(`      - status UPCOMING:           ${nullScore_upcoming.toLocaleString()}`);
console.log(`      - no status:                 ${nullScore_nostatus.toLocaleString()}`);

console.log('\n  Venues:');
console.log(`    With venue:                    ${withVenue.toLocaleString()}`);

console.log('\n📈 COVERAGE (eligible games only)');
console.log(`  Score coverage: ${scored_pct}%`);
console.log(`    Eligible: ${eligibleForScore.toLocaleString()}`);
console.log(`      = total(${total.toLocaleString()}) − upcoming(${stUpcoming.toLocaleString()}) − forfeit(${forfeit.toLocaleString()}) − legacy(${legacy.toLocaleString()}) − bye(${bye.toLocaleString()}) − postponed(${postponed.toLocaleString()})`);
console.log(`      note: hidden games ARE eligible — they have scores via spectator`);
console.log(`    Scored:   ${scored.toLocaleString()}`);
console.log(`    Gap:      ${scoreGap.toLocaleString()}${scoreGap < 0 ? '  ⚠ gap is negative — hidden scores are being double-counted' : ''}`);
if (scoreGap > 0) {
  console.log(`      null score (checked):        ${nullScore.toLocaleString()}`);
  console.log(`      no status:                   ${stNone.toLocaleString()}`);
  console.log(`      unexplained (FINAL no score no flag): ${total - scored - stUpcoming - noScoreByNature - nullScore - stNone}`);
}
console.log(`  Venue coverage: ${venue_pct}%`);
console.log(`    Eligible: ${eligibleForVenue.toLocaleString()}`);
console.log(`      = total(${total.toLocaleString()}) − upcoming(${stUpcoming.toLocaleString()}) − hidden(${hidden.toLocaleString()}) − legacy(${legacy.toLocaleString()}) − bye(${bye.toLocaleString()}) − postponed(${postponed.toLocaleString()})`);
console.log(`      note: forfeits stay eligible — may have venue if scraped before forfeit`);
console.log(`    With venue: ${withVenue.toLocaleString()}`);
console.log(`    Gap:        ${missingVenue.toLocaleString()}${missingVenue < 0 ? '  ⚠ negative — check logic' : ''}`);

if (VERBOSE && seasonBreakdown.length > 0) {
  console.log('\n📋 PER-SEASON BREAKDOWN (top 20 by game count)');
  seasonBreakdown.sort((a, b) => b.total - a.total).slice(0, 20).forEach(s => {
    const flag = s.active ? '🟢' : '🔒';
    console.log(`  ${flag} ${s.id}  ${(s.name||'').padEnd(40)} ${String(s.total).padStart(6)} total  score:${s.scored} venue:${s.venue} up:${s.upcoming} noSt:${s.noStatus} forfeit:${s.forfeit} hidden:${s.hidden} legacy:${s.legacy} bye:${s.bye}`);
  });
}

console.log('\n' + '═'.repeat(60));
