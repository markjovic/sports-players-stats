// scripts/diagnose-win-loss-skipped.js
//
// Diagnoses exactly why build-win-loss pass 2 skipped players.
// Categories:
//   A — no sports.Basketball (stubs, non-basketball players)
//   B — has sports.Basketball, no records in pass 1 (no game files for their seasons)
//   C — has sports.Basketball, has records, but values already matched (correct from prior run)
//   D — has sports.Basketball, has records, wins/losses/draws all zero (all games unscoreable)
//
// Also reports how many players in category B have seasons vs no seasons,
// and for those with seasons, whether game files exist for their sids.
//
// Usage:
//   node scripts/diagnose-win-loss-skipped.js

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');

const sportsIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'sports-index.json'), 'utf8'));
const allSids     = new Set(Object.keys(sportsIndex.seasons || {}));

console.log('Pass 1: scanning game files to rebuild records map…');

// Rebuild records map exactly as build-win-loss does
const playerTids = new Map();
const prefixes   = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();

// Pre-pass
let preCount = 0;
for (const prefix of prefixes) {
  const dir = path.join(PLAYERS_DIR, prefix);
  for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
    const uuid = fname.replace('.json', '');
    let player;
    try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
    if (!player.sports?.Basketball) continue;
    const sidMap = new Map();
    for (const season of (player.seasons || [])) {
      if (!allSids.has(season.sid)) continue;
      for (const reg of (season.regs || [])) {
        if (!reg.tid) continue;
        if (!sidMap.has(season.sid)) sidMap.set(season.sid, new Set());
        sidMap.get(season.sid).add(reg.tid);
      }
    }
    if (sidMap.size > 0) playerTids.set(uuid, sidMap);
    preCount++;
    if (preCount % 50000 === 0) process.stdout.write(`  Pre-pass: ${preCount}…\r`);
  }
}
console.log(`  Pre-pass done: ${preCount} players`);

// Pass 1 — rebuild records
const records = {};
let seasonsScanned = 0;

function accumulate(uuid, sid, tid, res) {
  if (!records[uuid])           records[uuid] = {};
  if (!records[uuid][sid])      records[uuid][sid] = {};
  if (!records[uuid][sid][tid]) records[uuid][sid][tid] = { w: 0, l: 0, d: 0 };
  const r = records[uuid][sid][tid];
  if (res === 'W') r.w++; else if (res === 'L') r.l++; else r.d++;
}

for (const sid of allSids) {
  const f = path.join(GAMES_DIR, `${sid}.json`);
  if (!fs.existsSync(f)) continue;
  let gf;
  try { gf = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  seasonsScanned++;

  for (const g of Object.values(gf.games || {})) {
    const hasHpAp = (g.hp?.length > 0) || (g.ap?.length > 0);
    if (hasHpAp) {
      for (const { players, tid } of [{ players: g.hp || [], tid: g.h }, { players: g.ap || [], tid: g.a }]) {
        if (!tid || !players.length) continue;
        if (g.hs == null || g.as == null || g.forfeit) continue;
        const res = g.hs > g.as ? (tid === g.h ? 'W' : 'L') : g.hs < g.as ? (tid === g.h ? 'L' : 'W') : 'D';
        for (const p of players) { if (p.profileID) accumulate(p.profileID, sid, tid, res); }
      }
    } else if (g.p?.length > 0) {
      for (const p of g.p) {
        const uuid = p.id; if (!uuid) continue;
        const tids = playerTids.get(uuid)?.get(sid); if (!tids) continue;
        const inHome = tids.has(g.h), inAway = tids.has(g.a);
        if (!inHome && !inAway) continue;
        if (inHome && inAway) continue;
        if (g.hs == null || g.as == null || g.forfeit) continue;
        const tid = inHome ? g.h : g.a;
        const res = g.hs > g.as ? (tid === g.h ? 'W' : 'L') : g.hs < g.as ? (tid === g.h ? 'L' : 'W') : 'D';
        accumulate(uuid, sid, tid, res);
      }
    }
  }
  if (seasonsScanned % 200 === 0) process.stdout.write(`  Pass 1: ${seasonsScanned} seasons…\r`);
}
console.log(`  Pass 1 done: ${seasonsScanned} seasons, ${Object.keys(records).length} players with data`);

// Pass 2 analysis — categorise every skipped player
console.log('\nPass 2: categorising all players…\n');

const counts = { A: 0, B_noSeasons: 0, B_hasSeasons: 0, C: 0, D: 0, updated: 0 };
// For B_hasSeasons: breakdown of whether game files exist
let B_sidsInIndex = 0, B_sidsNotInIndex = 0, B_gameFileExists = 0, B_gameFileMissing = 0;

for (const prefix of prefixes) {
  const dir = path.join(PLAYERS_DIR, prefix);
  for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
    const uuid = fname.replace('.json', '');
    let player;
    try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }

    const bk = player.sports?.Basketball;
    if (!bk) { counts.A++; continue; }

    const playerRecords = records[uuid];

    // Compute what build-win-loss would write
    let careerW = 0, careerL = 0, careerD = 0;
    for (const season of (player.seasons || [])) {
      for (const reg of (season.regs || [])) {
        const rec = playerRecords?.[season.sid]?.[reg.tid] || { w: 0, l: 0, d: 0 };
        careerW += rec.w; careerL += rec.l; careerD += rec.d;
      }
    }

    const hasRecords = !!playerRecords;
    const wouldChange = (bk.wins || 0) !== careerW || (bk.losses || 0) !== careerL || (bk.draws || 0) !== careerD;

    if (wouldChange) {
      counts.updated++;
    } else if (!hasRecords) {
      // No records at all — why?
      const seasons = player.seasons || [];
      if (seasons.length === 0) {
        counts.B_noSeasons++;
      } else {
        counts.B_hasSeasons++;
        for (const season of seasons) {
          if (!allSids.has(season.sid)) { B_sidsNotInIndex++; continue; }
          B_sidsInIndex++;
          if (fs.existsSync(path.join(GAMES_DIR, `${season.sid}.json`))) B_gameFileExists++;
          else B_gameFileMissing++;
        }
      }
    } else if (careerW === 0 && careerL === 0 && careerD === 0) {
      counts.D++;
    } else {
      counts.C++;
    }
  }
}

console.log('═'.repeat(60));
console.log('PASS 2 BREAKDOWN');
console.log(`  Would update (records differ from file):  ${counts.updated}`);
console.log(`  A — no sports.Basketball:                 ${counts.A}`);
console.log(`  B — has Basketball, NO records in pass 1:`);
console.log(`      B1 — no seasons on player file:       ${counts.B_noSeasons}`);
console.log(`      B2 — has seasons, sids in index:      ${B_sidsInIndex} season-regs`);
console.log(`           → game file EXISTS:              ${B_gameFileExists}`);
console.log(`           → game file MISSING:             ${B_gameFileMissing}`);
console.log(`      B2 — has seasons, sids NOT in index:  ${B_sidsNotInIndex} season-regs`);
console.log(`  C — records matched existing values:      ${counts.C}`);
console.log(`  D — records all zero (unscoreable games): ${counts.D}`);
console.log('═'.repeat(60));
