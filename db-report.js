#!/usr/bin/env node
// db-report.js
'use strict';

const fs   = require('fs');
const path = require('path');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k,...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const VERBOSE           = !!ARGS.verbose;
const INCLUDE_PLAYERS   = !!ARGS['include-players'];
const VERIFY_MIGRATION  = !!ARGS['verify-migration'];
const TENANT            = ARGS.tenant || 'bv';

const GAMES_DIR        = path.join(__dirname, 'games', TENANT);
const PLAYERS_DIR      = path.join(__dirname, 'players');
const PLAYERS_IDX      = path.join(__dirname, 'players-index');
const PLAYERS_IDX_NEW  = path.join(__dirname, 'players', 'indexes');
const VENUE_DIR        = path.join(__dirname, 'venue-lookup');
const TEAM_DIR         = path.join(__dirname, 'team-lookup');
const TEAM_INDEX_FILE  = path.join(__dirname, 'team-index.json');
const VENUE_INDEX_FILE = path.join(__dirname, 'venue-index.json');
const INDEX_FILE       = path.join(__dirname, 'sports-index.json');

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
let forfeit = 0, hidden = 0, legacy = 0, profileOnly = 0, noProfile = 0, noVenue = 0, bye = 0, postponed = 0;
let hiddenWithVenue = 0;    // hidden games that have venue data (crawled before grade was hidden)
let venueEligibleCount = 0; // games in venue eligible pool
let venueEligibleWithVenue = 0; // eligible games that have venue
let noProfileOldest = null, noVenueOldest = null;
let flagCollisions = 0; // games with legacy + another definitive flag
let inProgress = 0;    // LIVE + PRE_GAME + IN_PROGRESS + PENDING — not yet finished
let stFinal = 0, stUpcoming = 0, stPostponed = 0, stBye = 0, stOther = 0, stNone = 0;
let stNone_active = 0, stNone_locked = 0;
let nullScore = 0, nullScore_active = 0, nullScore_locked = 0;
let nullScore_final = 0, nullScore_upcoming = 0, nullScore_nostatus = 0;
// Team field structure counters
let teamHA = 0, teamOOnly = 0, teamBoth = 0, teamNeither = 0;
let teamT1Only = 0, teamT1T2 = 0;
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
      if (g.bye)         bye++;
      if (g.profileOnly) profileOnly++;
      if (['LIVE','PRE_GAME','IN_PROGRESS','PENDING'].includes(g.st || '')) inProgress++;
      if (g.hidden && g.vid) hiddenWithVenue++;
      // Track venue coverage on eligible games only
      const isVenueEligible = g.st !== 'UPCOMING' && !g.hidden && !g.legacy && !g.profileOnly && !g.bye &&
        !['LIVE','PRE_GAME','IN_PROGRESS','PENDING','POSTPONED','CANCELLED','ABANDONED'].includes(g.st || '');
      if (isVenueEligible) {
        venueEligibleCount++;
        if (g.vid) venueEligibleWithVenue++;
      }
      if (g.noProfile) {
        noProfile++;
        if (!noProfileOldest || g.noProfile < noProfileOldest) noProfileOldest = g.noProfile;
      }
      if (g.noVenue) {
        noVenue++;
        if (!noVenueOldest || g.noVenue < noVenueOldest) noVenueOldest = g.noVenue;
      }
      // Flag collision detection — legacy should not coexist with definitive classification
      if (g.legacy && (g.hidden || g.profileOnly || g.cancelled || g.abandoned || g.forfeit || g.bye)) {
        flagCollisions++;
      }
      if (g.s)           hasSField++;

      // Team field structure
      const hasH  = !!g.h;
      const hasO  = !!g.o;
      const hasT1 = !!g.t1;
      if      (hasH && hasO)      teamBoth++;
      else if (hasH)              teamHA++;
      else if (hasO)              teamOOnly++;
      else if (hasT1 && !!g.t2)  teamT1T2++;
      else if (hasT1)             teamT1Only++;
      else                        teamNeither++;

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
        bye:         games.filter(g => g.bye).length,
        profileOnly: games.filter(g => g.profileOnly).length,
        upcoming:    games.filter(g => g.st === 'UPCOMING').length,
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

// Subtract collisions from legacy to avoid double-counting in coverage calculations
const legacyForCalc      = legacy - flagCollisions;
// noProfile games are hidden games WITH scores — do not exclude from score eligible
// inProgress (LIVE/PRE_GAME/IN_PROGRESS/PENDING) haven't finished — exclude from eligible
const noScoreByNature    = forfeit + legacyForCalc + profileOnly + bye + postponed + inProgress;
const eligibleForScore   = total - stUpcoming - noScoreByNature;
const scored_pct         = eligibleForScore > 0 ? ((scored / eligibleForScore) * 100).toFixed(1) : 'N/A';
const scoreGap           = eligibleForScore - scored;

// For venue: hidden games never have venue, so they're out of eligible pool
// Forfeits may have a venue so they stay in — gap will reflect forfeits without venue
// noProfile and noVenue are subsets of hidden — hidden already excludes them from venue eligible
const noVenueByNature    = hidden + legacyForCalc + profileOnly + bye + postponed + inProgress;
// noVenue games are hidden games where venue was attempted but not found — already in hidden count
const eligibleForVenue   = total - stUpcoming - noVenueByNature;
const missingVenue       = venueEligibleCount - venueEligibleWithVenue;
const venue_pct          = venueEligibleCount > 0 ? ((venueEligibleWithVenue / venueEligibleCount) * 100).toFixed(1) : 'N/A';

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
console.log(`    forfeit:     true    ${forfeit.toLocaleString()} — forfeit result, no score`);
console.log(`    hidden:      true    ${hidden.toLocaleString()} — admin-hidden grade: score+box via spectator, no venue, may lack h/a/rn`);
console.log(`    profileOnly: true    ${profileOnly.toLocaleString()} — pre-escore era: h/a/rn from player profiles, no score/venue/box`);
console.log(`    legacy:      true    ${legacy.toLocaleString()} — all routes exhausted, no data accessible`);
console.log(`    noProfile:   <ts>     ${noProfile.toLocaleString()} — hidden, profiles exhausted; retried after 30d. Oldest: ${noProfileOldest || 'none'}`);
console.log(`    noVenue:     <ts>     ${noVenue.toLocaleString()} — hidden, venue not recoverable via discoverGame; retried after 30d. Oldest: ${noVenueOldest || 'none'}`);
if (flagCollisions > 0) {
  console.log(`\n  ⚠ FLAG COLLISIONS: ${flagCollisions.toLocaleString()} games have legacy:true alongside a definitive flag.`);
  console.log(`    Run cleanup-flag-collisions.js to fix. These games are double-counted in legacy and their primary flag.`);
} else {
  console.log(`\n  ✓ No flag collisions detected`);
}
console.log(`    bye:         true    ${bye.toLocaleString()} — bye round, no game played`);

console.log('\n  Team field structure:');
console.log(`    h + a only (absolute):         ${teamHA.toLocaleString()}`);
console.log(`    h + a + o/on (redundant):        ${teamBoth.toLocaleString()}${teamBoth > 0 ? '  ⚠ run normalise-game-structure' : ''}`);
console.log(`    o/on only (relative):            ${teamOOnly.toLocaleString()}${teamOOnly > 0 ? '  ⚠ run normalise-game-structure' : ''}`);
console.log(`    t1/t1n + t2/t2n (both sides):    ${teamT1T2.toLocaleString()}`);
console.log(`    t1/t1n only (one side known):    ${teamT1Only.toLocaleString()}`);
console.log(`    neither (bare):                  ${teamNeither.toLocaleString()}`);
console.log(`    has s/sn (legacy field):         ${hasSField.toLocaleString()}${hasSField > 0 ? '  ⚠ run normalise-game-structure' : ''}`);

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
console.log(`      = total(${total.toLocaleString()}) − upcoming(${stUpcoming.toLocaleString()}) − forfeit(${forfeit.toLocaleString()}) − legacy(${legacyForCalc.toLocaleString()}) − profileOnly(${profileOnly.toLocaleString()}) − inProgress(${inProgress.toLocaleString()}) − bye(${bye.toLocaleString()})`);
console.log(`      note: hidden games ARE eligible — they have scores via spectator`);
console.log(`    Scored:   ${scored.toLocaleString()}`);
console.log(`    Gap:      ${scoreGap.toLocaleString()}${scoreGap < 0 ? '  ⚠ gap is negative — hidden scores are being double-counted' : ''}`);
if (scoreGap > 0) {
  console.log(`      null score (checked):        ${nullScore.toLocaleString()}`);
  console.log(`      no status:                   ${stNone.toLocaleString()}`);
  console.log(`      unexplained (FINAL no score no flag): ${Math.max(0, total - scored - stUpcoming - noScoreByNature - nullScore - stNone)}`);
}
console.log(`  Venue coverage: ${venue_pct}%`);
console.log(`    Eligible: ${venueEligibleCount.toLocaleString()}`);
console.log(`      (FINAL/normal status, not hidden/legacy/profileOnly/inProgress/bye/upcoming)`);
console.log(`      note: forfeits stay eligible — may have venue if scraped before forfeit`);
console.log(`    With venue (eligible only): ${venueEligibleWithVenue.toLocaleString()}`);
console.log(`    Gap:        ${missingVenue.toLocaleString()}`);
console.log(`    Hidden games with venue: ${hiddenWithVenue.toLocaleString()} — crawled before grade was hidden, data preserved`);;

if (VERBOSE && seasonBreakdown.length > 0) {
  console.log('\n📋 PER-SEASON BREAKDOWN (top 20 by game count)');
  seasonBreakdown.sort((a, b) => b.total - a.total).slice(0, 20).forEach(s => {
    const flag = s.active ? '🟢' : '🔒';
    console.log(`  ${flag} ${s.id}  ${(s.name||'').padEnd(40)} ${String(s.total).padStart(6)} total  score:${s.scored} venue:${s.venue} up:${s.upcoming} noSt:${s.noStatus} forfeit:${s.forfeit} hidden:${s.hidden} profileOnly:${s.profileOnly} legacy:${s.legacy} bye:${s.bye}`);
  });
}

// ─── Migration Phase 1 Verification ──────────────────────────────────────────

if (VERIFY_MIGRATION) {
  console.log('\n🔬 MIGRATION PHASE 1 VERIFICATION');
  console.log('─'.repeat(60));

  const checks = [];   // { label, pass, detail }
  const errors = [];   // strings — shown in summary

  function check(label, pass, detail) {
    checks.push({ label, pass, detail });
    if (!pass) errors.push(`FAIL: ${label}${detail ? ' — ' + detail : ''}`);
  }

  // ── 1. Game files: p array present, playerGames absent ─────────────────────

  console.log('\n  [1] Scanning game files for p array / playerGames...');
  let gamesTotal = 0, gamesWithP = 0, gamesWithoutP = 0;
  let gamesWithPlayerGames = 0, seasonFilesWithPlayerGames = 0;
  let pEntriesTotal = 0, gamesWithEmptyP = 0;
  const missingPSamples = [];

  if (fs.existsSync(GAMES_DIR)) {
    for (const file of fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'))) {
      let sg;
      try { sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8')); } catch (e) { continue; }

      if (sg.playerGames) seasonFilesWithPlayerGames++;

      for (const [gid, g] of Object.entries(sg.games || {})) {
        gamesTotal++;
        if (Array.isArray(g.p)) {
          gamesWithP++;
          pEntriesTotal += g.p.length;
          if (g.p.length === 0) gamesWithEmptyP++;
        } else {
          gamesWithoutP++;
          if (missingPSamples.length < 5) missingPSamples.push(`${file.replace('.json','')}/${gid}`);
        }
        // playerGames should never be on a game entry (it's a season-level key)
        // flag any games that somehow have it as a per-game field
        if (g.playerGames !== undefined) gamesWithPlayerGames++;
      }
    }
  }

  check(
    'All game files have p array',
    gamesWithoutP === 0,
    gamesWithoutP > 0
      ? `${gamesWithoutP.toLocaleString()} games missing p. Samples: ${missingPSamples.join(', ')}`
      : `${gamesWithP.toLocaleString()} games verified`
  );
  check(
    'No season files retain playerGames',
    seasonFilesWithPlayerGames === 0,
    seasonFilesWithPlayerGames > 0
      ? `${seasonFilesWithPlayerGames} season files still have playerGames key — migration incomplete`
      : 'playerGames deleted from all season files'
  );
  check(
    'Game total unchanged from report',
    gamesTotal === total,
    gamesTotal !== total
      ? `verify scan found ${gamesTotal.toLocaleString()} vs report total ${total.toLocaleString()}`
      : `${gamesTotal.toLocaleString()} games consistent`
  );

  console.log(`    Total games scanned:           ${gamesTotal.toLocaleString()}`);
  console.log(`    Games with p array:            ${gamesWithP.toLocaleString()}`);
  console.log(`    Games missing p array:         ${gamesWithoutP.toLocaleString()}${gamesWithoutP > 0 ? '  ⚠' : '  ✓'}`);
  console.log(`    Games with empty p (no players): ${gamesWithEmptyP.toLocaleString()}`);
  console.log(`    Total p entries across all games: ${pEntriesTotal.toLocaleString()}`);
  console.log(`    Season files still with playerGames: ${seasonFilesWithPlayerGames.toLocaleString()}${seasonFilesWithPlayerGames > 0 ? '  ⚠' : '  ✓'}`);

  // ── 2. Player index shards: players/indexes/ vs players-index/ ──────────────

  console.log('\n  [2] Comparing player index shards...');

  let oldShardCount = 0, oldPlayerCount = 0;
  const oldUUIDs = new Set();
  if (fs.existsSync(PLAYERS_IDX)) {
    for (const f of fs.readdirSync(PLAYERS_IDX).filter(f => f.endsWith('.json'))) {
      oldShardCount++;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PLAYERS_IDX, f), 'utf8'));
        for (const uuid of Object.keys(data)) { oldUUIDs.add(uuid); oldPlayerCount++; }
      } catch (e) {}
    }
  }

  let newShardCount = 0, newPlayerCount = 0, newWithHistory = 0, newMissingHistory = 0;
  const newUUIDs = new Set();
  const missingHistorySamples = [];
  if (fs.existsSync(PLAYERS_IDX_NEW)) {
    for (const f of fs.readdirSync(PLAYERS_IDX_NEW).filter(f => f.endsWith('.json'))) {
      newShardCount++;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PLAYERS_IDX_NEW, f), 'utf8'));
        for (const [uuid, entry] of Object.entries(data)) {
          newUUIDs.add(uuid);
          newPlayerCount++;
          if (entry.history && typeof entry.history === 'object') {
            newWithHistory++;
          } else {
            newMissingHistory++;
            if (missingHistorySamples.length < 5) missingHistorySamples.push(uuid);
          }
        }
      } catch (e) {}
    }
  }

  // UUIDs in old but not in new
  const onlyInOld = [...oldUUIDs].filter(u => !newUUIDs.has(u));
  // UUIDs in new but not in old (unexpected)
  const onlyInNew = [...newUUIDs].filter(u => !oldUUIDs.has(u));

  const oldExists = oldShardCount > 0;
  const newExists = newShardCount > 0;

  check(
    'players/indexes/ exists and is populated',
    newExists,
    newExists ? `${newShardCount} shards, ${newPlayerCount.toLocaleString()} players` : 'directory missing or empty'
  );
  check(
    'Shard count matches',
    oldShardCount === newShardCount,
    `old: ${oldShardCount}, new: ${newShardCount}`
  );
  check(
    'Player count matches',
    oldPlayerCount === newPlayerCount,
    `old: ${oldPlayerCount.toLocaleString()}, new: ${newPlayerCount.toLocaleString()}`
  );
  check(
    'No UUIDs missing from new index',
    onlyInOld.length === 0,
    onlyInOld.length > 0
      ? `${onlyInOld.length} UUIDs in players-index/ but not in players/indexes/. Samples: ${onlyInOld.slice(0,3).join(', ')}`
      : 'all UUIDs accounted for'
  );
  check(
    'No unexpected UUIDs added to new index',
    onlyInNew.length === 0,
    onlyInNew.length > 0
      ? `${onlyInNew.length} UUIDs in players/indexes/ but not in players-index/`
      : 'no unexpected additions'
  );
  check(
    'All index entries have history field',
    newMissingHistory === 0,
    newMissingHistory > 0
      ? `${newMissingHistory.toLocaleString()} entries missing history. Samples: ${missingHistorySamples.join(', ')}`
      : `${newWithHistory.toLocaleString()} entries verified`
  );

  console.log(`    players-index/     shards: ${oldShardCount}  players: ${oldPlayerCount.toLocaleString()}`);
  console.log(`    players/indexes/   shards: ${newShardCount}  players: ${newPlayerCount.toLocaleString()}${newPlayerCount !== oldPlayerCount ? '  ⚠ COUNT MISMATCH' : '  ✓'}`);
  console.log(`    UUIDs only in old index:   ${onlyInOld.length.toLocaleString()}${onlyInOld.length > 0 ? '  ⚠' : '  ✓'}`);
  console.log(`    UUIDs only in new index:   ${onlyInNew.length.toLocaleString()}${onlyInNew.length > 0 ? '  ⚠' : '  ✓'}`);
  console.log(`    Entries with history:      ${newWithHistory.toLocaleString()}${newMissingHistory > 0 ? `  ⚠ (${newMissingHistory} missing)` : '  ✓'}`);

  // ── 3. team-index.json ──────────────────────────────────────────────────────

  console.log('\n  [3] Checking team-index.json...');

  const distinctSnInIndex = new Set(seasonList.map(s => s.name).filter(Boolean));
  let teamIndexSeasonNames = 0, teamIndexTotalTeams = 0;
  let teamIndexExists = false;

  if (fs.existsSync(TEAM_INDEX_FILE)) {
    teamIndexExists = true;
    try {
      const ti = JSON.parse(fs.readFileSync(TEAM_INDEX_FILE, 'utf8'));
      teamIndexSeasonNames = Object.keys(ti).length;
      for (const arr of Object.values(ti)) teamIndexTotalTeams += arr.length;
    } catch (e) { teamIndexExists = false; }
  }

  check(
    'team-index.json exists',
    teamIndexExists,
    teamIndexExists ? `${teamIndexSeasonNames} season names, ${teamIndexTotalTeams.toLocaleString()} team entries` : 'file missing'
  );
  check(
    'team-index.json has entries',
    teamIndexTotalTeams > 0,
    `${teamIndexTotalTeams.toLocaleString()} entries`
  );
  check(
    'team-index.json season names ≤ distinct sn values in sports-index',
    teamIndexSeasonNames <= distinctSnInIndex.size,
    `team-index: ${teamIndexSeasonNames}, sports-index distinct sn: ${distinctSnInIndex.size}`
  );

  console.log(`    team-index.json season names:  ${teamIndexSeasonNames.toLocaleString()}`);
  console.log(`    Distinct sn in sports-index:   ${distinctSnInIndex.size.toLocaleString()}`);
  console.log(`    Total team entries:            ${teamIndexTotalTeams.toLocaleString()}`);

  // ── 4. venue-index.json ─────────────────────────────────────────────────────

  console.log('\n  [4] Checking venue-index.json...');

  let venueIndexExists = false, venueIndexCount = 0;
  if (fs.existsSync(VENUE_INDEX_FILE)) {
    venueIndexExists = true;
    try {
      const vi = JSON.parse(fs.readFileSync(VENUE_INDEX_FILE, 'utf8'));
      venueIndexCount = Array.isArray(vi) ? vi.length : Object.keys(vi).length;
    } catch (e) { venueIndexExists = false; }
  }

  check(
    'venue-index.json exists',
    venueIndexExists,
    venueIndexExists ? `${venueIndexCount} venues` : 'file missing'
  );
  check(
    'venue-index.json count matches venue-lookup shard count',
    venueIndexCount === venueCount,
    `venue-index: ${venueIndexCount}, venue-lookup shards: ${venueCount}`
  );

  console.log(`    venue-index.json entries:      ${venueIndexCount.toLocaleString()}`);
  console.log(`    venue-lookup shard entries:    ${venueCount.toLocaleString()}${venueIndexCount !== venueCount ? '  ⚠ MISMATCH' : '  ✓'}`);

  // ── 5. team-stats/bv/ ───────────────────────────────────────────────────────

  console.log('\n  [5] Checking team-stats/bv/...');

  const TEAM_STATS_DIR = path.join(__dirname, 'team-stats', TENANT);
  let tsFileCount = 0, tsTeamTotal = 0, tsWithRoster = 0, tsWithFixtures = 0;
  let tsExists = false;
  const tsMissingFixtureSamples = [];
  const tsMissingRosterSamples  = [];

  if (fs.existsSync(TEAM_STATS_DIR)) {
    tsExists = true;
    const tsFiles = fs.readdirSync(TEAM_STATS_DIR).filter(f => f.endsWith('.json'));
    tsFileCount = tsFiles.length;

    // Spot-check up to 200 files evenly spread
    const step = Math.max(1, Math.floor(tsFiles.length / 200));
    for (let i = 0; i < tsFiles.length; i += step) {
      let ts;
      try { ts = JSON.parse(fs.readFileSync(path.join(TEAM_STATS_DIR, tsFiles[i]), 'utf8')); } catch (e) { continue; }
      for (const [tid, entry] of Object.entries(ts)) {
        tsTeamTotal++;
        const hasRoster   = entry.roster   && typeof entry.roster   === 'object';
        const hasFixtures = entry.fixtures && Array.isArray(entry.fixtures);
        if (hasRoster)   tsWithRoster++;
        else if (tsMissingRosterSamples.length < 3) tsMissingRosterSamples.push(`${tsFiles[i]}/${tid}`);
        if (hasFixtures) tsWithFixtures++;
        else if (tsMissingFixtureSamples.length < 3) tsMissingFixtureSamples.push(`${tsFiles[i]}/${tid}`);
      }
    }
  }

  check(
    'team-stats/bv/ exists',
    tsExists,
    tsExists ? `${tsFileCount} files` : 'directory missing'
  );
  check(
    'team-stats file count matches season count',
    tsFileCount === total,
    `team-stats: ${tsFileCount.toLocaleString()}, seasons: ${total.toLocaleString()}`
  );
  check(
    'Sampled team entries have roster field',
    tsMissingRosterSamples.length === 0,
    tsMissingRosterSamples.length > 0
      ? `Missing roster on: ${tsMissingRosterSamples.join(', ')}`
      : `${tsWithRoster.toLocaleString()} entries verified`
  );
  check(
    'Sampled team entries have fixtures array',
    tsMissingFixtureSamples.length === 0,
    tsMissingFixtureSamples.length > 0
      ? `Missing fixtures on: ${tsMissingFixtureSamples.join(', ')}`
      : `${tsWithFixtures.toLocaleString()} entries verified`
  );

  console.log(`    team-stats/bv/ files:          ${tsFileCount.toLocaleString()}  (seasons: ${total.toLocaleString()})${tsFileCount !== total ? '  ⚠ MISMATCH' : '  ✓'}`);
  console.log(`    Sampled team entries:          ${tsTeamTotal.toLocaleString()}`);
  console.log(`    With roster:                   ${tsWithRoster.toLocaleString()}${tsMissingRosterSamples.length > 0 ? '  ⚠' : '  ✓'}`);
  console.log(`    With fixtures:                 ${tsWithFixtures.toLocaleString()}${tsMissingFixtureSamples.length > 0 ? '  ⚠' : '  ✓'}`);

  // ── 6. venue-lookup (new structure) ──────────────────────────────────────────

  console.log('\n  [6] Checking venue-lookup new structure...');

  let newVenueDirs = 0, newVenueDateFiles = 0, newVenueStructureOk = true;
  const newVenueStructureSamples = [];

  if (fs.existsSync(VENUE_DIR)) {
    // New structure: UUID-named subdirectories containing {date}.json files
    // Old structure: {xx}.json flat shards — skip those (2-char names)
    const entries = fs.readdirSync(VENUE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // UUID dirs are 36 chars with hyphens; skip anything that isn't
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)) continue;
      newVenueDirs++;
      const dateFiles = fs.readdirSync(path.join(VENUE_DIR, entry.name)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
      newVenueDateFiles += dateFiles.length;

      // Spot-check first file in this dir
      if (newVenueStructureSamples.length < 3 && dateFiles.length > 0) {
        try {
          const sample = JSON.parse(fs.readFileSync(path.join(VENUE_DIR, entry.name, dateFiles[0]), 'utf8'));
          // Should be { "Court X": [{id, t, hn, an, st}, ...] }
          const courts = Object.values(sample);
          if (courts.length === 0 || !Array.isArray(courts[0]) || !courts[0][0]?.id) {
            newVenueStructureOk = false;
            newVenueStructureSamples.push(`${entry.name}/${dateFiles[0]}`);
          }
        } catch (e) {
          newVenueStructureOk = false;
          newVenueStructureSamples.push(`${entry.name}/${dateFiles[0]} (parse error)`);
        }
      }
    }
  }

  check(
    'venue-lookup UUID subdirs exist',
    newVenueDirs > 0,
    newVenueDirs > 0 ? `${newVenueDirs} venue dirs` : 'no UUID subdirs found'
  );
  check(
    'venue-lookup dir count matches venue-index',
    newVenueDirs === venueIndexCount,
    `venue-lookup dirs: ${newVenueDirs}, venue-index entries: ${venueIndexCount}`
  );
  check(
    'venue-lookup file structure valid (spot-check)',
    newVenueStructureOk,
    newVenueStructureOk
      ? `structure OK in sampled files`
      : `invalid structure in: ${newVenueStructureSamples.join(', ')}`
  );

  console.log(`    New venue dirs (UUID):          ${newVenueDirs.toLocaleString()}${newVenueDirs !== venueIndexCount ? '  ⚠ MISMATCH' : '  ✓'}`);
  console.log(`    venue-index entries:            ${venueIndexCount.toLocaleString()}`);
  console.log(`    Total date files:               ${newVenueDateFiles.toLocaleString()}`);
  console.log(`    File structure:                 ${newVenueStructureOk ? '✓ valid' : '⚠ invalid — check samples'}`);

  // ── Summary ─────────────────────────────────────────────────────────────────

  const phase1Checks = checks.slice(0, 14);
  const phase2Checks = checks.slice(14);
  const passed = checks.filter(c => c.pass).length;
  const failed = checks.filter(c => !c.pass).length;
  const p1fail = phase1Checks.filter(c => !c.pass).length;
  const p2fail = phase2Checks.filter(c => !c.pass).length;

  console.log('\n' + '─'.repeat(60));
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(60));

  if (phase1Checks.length) {
    console.log(`\n  Phase 1 checks (${phase1Checks.length}):`);
    for (const c of phase1Checks) {
      console.log(`  ${c.pass ? '✅' : '❌'} ${c.label}`);
      if (!c.pass && c.detail) console.log(`       ${c.detail}`);
    }
  }
  if (phase2Checks.length) {
    console.log(`\n  Phase 2 checks (${phase2Checks.length}):`);
    for (const c of phase2Checks) {
      console.log(`  ${c.pass ? '✅' : '❌'} ${c.label}`);
      if (!c.pass && c.detail) console.log(`       ${c.detail}`);
    }
  }

  const p1verdict = p1fail === 0 ? '✅ Phase 1 PASSED' : `❌ Phase 1 FAILED (${p1fail})`;
  const p2verdict = p2fail === 0 ? '✅ Phase 2 PASSED' : `❌ Phase 2 FAILED (${p2fail})`;
  console.log(`\n  ${p1verdict} — ${p2verdict}`);
  if (failed === 0) {
    console.log('  ✅ ALL CHECKS PASSED — safe to proceed to Phase 3');
  } else {
    console.log(`  ❌ ${failed} CHECK(S) FAILED — resolve before proceeding`);
  }
}

console.log('\n' + '═'.repeat(60));
