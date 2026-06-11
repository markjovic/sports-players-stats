#!/usr/bin/env node
// diagnose-hidden-gaps.js
'use strict';

const fs   = require('fs');
const path = require('path');

const TENANT    = process.argv[2] || 'bv';
const GAMES_DIR = path.join(__dirname, 'games', TENANT);

let hidden = 0, hiddenNoH = 0, hiddenNoRn = 0, hiddenNoHAndNoRn = 0, hiddenHasAll = 0;

for (const file of fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'))) {
  let sg;
  try { sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8')); } catch (e) { continue; }
  for (const g of Object.values(sg.games || {})) {
    if (!g.hidden) continue;
    hidden++;
    const missingH  = !g.h;
    const missingRn = !g.rn;
    if (missingH)  hiddenNoH++;
    if (missingRn) hiddenNoRn++;
    if (missingH && missingRn) hiddenNoHAndNoRn++;
    if (!missingH && !missingRn) hiddenHasAll++;
  }
}

console.log('\n🔍 Hidden game structural gap analysis');
console.log('─'.repeat(50));
console.log(`  Total hidden games:           ${hidden.toLocaleString()}`);
console.log(`  Missing h/a (no team IDs):    ${hiddenNoH.toLocaleString()}`);
console.log(`  Missing rn (no round name):   ${hiddenNoRn.toLocaleString()}`);
console.log(`  Missing both h/a and rn:      ${hiddenNoHAndNoRn.toLocaleString()}`);
console.log(`  Has both h/a and rn:          ${hiddenHasAll.toLocaleString()}`);
console.log('─'.repeat(50));
