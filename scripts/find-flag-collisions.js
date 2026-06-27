// scripts/find-flag-collisions.js
// Finds games where legacy:true is set alongside another flag (hidden, profileOnly, forfeit, bye).
// Run once to identify the game, then fix manually or via diagnose.js game <id>.

'use strict';

const fs   = require('fs');
const path = require('path');

const GAMES_DIR = path.join(__dirname, '..', 'games', 'bv');

let found = 0;

for (const fname of fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort()) {
  let gf;
  try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); } catch { continue; }

  for (const [gameId, g] of Object.entries(gf.games || {})) {
    if (!g.legacy) continue;
    const others = ['hidden','profileOnly','forfeit','bye','cancelled','abandoned'].filter(f => g[f]);
    if (!others.length) continue;
    found++;
    console.log(`\n  gameId: ${gameId}  season: ${fname.replace('.json','')}`);
    console.log(`  flags:  legacy=true  ${others.map(f => `${f}=true`).join('  ')}`);
    console.log(`  date=${g.d}  rn=${g.rn}  st=${g.st}`);
    console.log(`  home=${g.hn||g.t1n||'?'}  away=${g.an||g.t2n||'?'}`);
  }
}

console.log(`\nTotal flag collisions: ${found}`);
