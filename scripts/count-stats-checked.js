// scripts/count-stats-checked.js
//
// Counts player files with and without statsChecked.
// No writes. Run: node scripts/count-stats-checked.js

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');

const prefixes = fs.readdirSync(PLAYERS_DIR)
  .filter(f => /^[0-9a-f]{2}$/.test(f))
  .sort();

let total = 0, withChecked = 0, withoutChecked = 0, errors = 0;

for (const prefix of prefixes) {
  const dir   = path.join(PLAYERS_DIR, prefix);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const fname of files) {
    total++;
    try {
      const player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8'));
      if (player.sports?.Basketball?.statsChecked) withChecked++;
      else withoutChecked++;
    } catch (_) { errors++; }
  }
  if ((prefixes.indexOf(prefix) + 1) % 32 === 0)
    process.stdout.write(`  ${prefix} — ${total} scanned\r`);
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`  Total players:        ${total.toLocaleString()}`);
console.log(`  With statsChecked:    ${withChecked.toLocaleString()}`);
console.log(`  Without statsChecked: ${withoutChecked.toLocaleString()}`);
console.log(`  Errors:               ${errors}`);
console.log('─'.repeat(40));
