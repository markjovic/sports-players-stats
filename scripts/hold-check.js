// scripts/hold-check.js
//
// STANDALONE, LOCAL, NO API. Answers: for a set of season IDs, what do we already
// hold on disk? Reports per season whether a game file exists (and its game count),
// how many player registrations reference the season, and how many of those regs
// carry real played-game stats (gp/pts > 0) — i.e. recoverable evidence we hold
// even when no game file exists and discoverSeason serves nothing.
//
// Reading:
//   regsWithStats > 0, gameFile = no  → players have played-game evidence for a
//     season we hold no game file for → real recoverable data; NOT a dead stub.
//   regsWithStats = 0, gameFile = no  → we hold only bare registrations; combined
//     with an empty API, a stub is genuinely all it can be.
//   gameFile = YES                    → already crawled; not a stub at all.
//
// Usage:
//   node scripts/hold-check.js 68279835,913d1397,ee5d2724
//   node scripts/hold-check.js --sids=68279835,913d1397,ee5d2724

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');

// Accept sids as a bare arg or --sids=
const rawArg = process.argv.slice(2).find(a => !a.startsWith('-')) ||
               (process.argv.slice(2).find(a => a.startsWith('--sids=')) || '').replace('--sids=', '');
const SIDS = (rawArg || '').split(',').map(s => s.trim()).filter(Boolean);

if (!SIDS.length) {
  console.error('Usage: node scripts/hold-check.js <sid1,sid2,...>');
  process.exit(1);
}

console.log(`\nhold-check.js  (local, no API)`);
console.log(`  seasons: ${SIDS.join(', ')}\n`);

// Tally player registrations per sid
const tally = new Map();  // sid -> { regs, withStats, teams:Set, players:Set }
for (const sid of SIDS) tally.set(sid, { regs: 0, withStats: 0, teams: new Set(), players: new Set() });

const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
let scanned = 0;
for (const prefix of prefixes) {
  const dir = path.join(PLAYERS_DIR, prefix);
  for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
    let pl; try { pl = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
    scanned++;
    for (const sn of (pl.seasons || [])) {
      const t = tally.get(sn.sid);
      if (!t) continue;
      for (const reg of (sn.regs || [])) {
        t.regs++;
        t.players.add(fname);
        if (reg.tid) t.teams.add(reg.tid);
        const st = reg.stats || {};
        if ((st.gp || 0) > 0 || (st.pts || 0) > 0) t.withStats++;
      }
    }
  }
  if (scanned % 100000 === 0) process.stdout.write(`  …scanned ${scanned} players\r`);
}

console.log(`  scanned ${scanned} player files\n`);
console.log('  ' + 'sid'.padEnd(12) + 'gameFile'.padEnd(10) + 'gamesInFile'.padEnd(13) + 'players'.padEnd(10) + 'regs'.padEnd(8) + 'regsWithStats'.padEnd(15) + 'teams');
for (const sid of SIDS) {
  const f = path.join(GAMES_DIR, `${sid}.json`);
  let gf = 'no', games = '-';
  if (fs.existsSync(f)) {
    gf = 'YES';
    try { games = Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).games || {}).length; } catch { games = 'ERR'; }
  }
  const t = tally.get(sid);
  console.log('  ' +
    sid.padEnd(12) +
    gf.padEnd(10) +
    String(games).padEnd(13) +
    String(t.players.size).padEnd(10) +
    String(t.regs).padEnd(8) +
    String(t.withStats).padEnd(15) +
    String(t.teams.size));
}

// Surface up to 3 sample team IDs per season with stats — for a correct team probe
console.log('\n  Sample team IDs (for a correct discoverTeamFixture probe):');
for (const sid of SIDS) {
  const t = tally.get(sid);
  if (t.teams.size > 0) console.log(`    ${sid}: ${[...t.teams].slice(0, 3).join(', ')}`);
  else console.log(`    ${sid}: (no team IDs on disk)`);
}

console.log('\nDone.');
