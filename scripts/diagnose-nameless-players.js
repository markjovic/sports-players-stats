// scripts/diagnose-nameless-players.js
// Checks the actual state of nameless player files:
// how many have statsChecked set vs not

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');

let namelessWithSC    = 0;
let namelessWithoutSC = 0;
let named             = 0;
let total             = 0;
const sampleWith    = [];
const sampleWithout = [];

for (const prefix of fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort()) {
  const dir = path.join(PLAYERS_DIR, prefix);
  for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    total++;
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }

    if (p.name) { named++; continue; }

    const sc = p.sports?.Basketball?.statsChecked;
    if (sc) {
      namelessWithSC++;
      if (sampleWith.length < 5) sampleWith.push({ uuid: p.uuid, statsChecked: sc });
    } else {
      namelessWithoutSC++;
      if (sampleWithout.length < 5) sampleWithout.push({ uuid: p.uuid });
    }
  }
}

console.log(`\nDiagnose nameless players`);
console.log('─'.repeat(50));
console.log(`  Total files scanned:          ${total}`);
console.log(`  Named players:                ${named}`);
console.log(`  Nameless WITH statsChecked:   ${namelessWithSC}`);
console.log(`  Nameless WITHOUT statsChecked:${namelessWithoutSC}`);
console.log(`\n  Sample WITH statsChecked:`);
for (const s of sampleWith)    console.log(`    ${s.uuid}  sc=${s.statsChecked}`);
console.log(`\n  Sample WITHOUT statsChecked:`);
for (const s of sampleWithout) console.log(`    ${s.uuid}`);
