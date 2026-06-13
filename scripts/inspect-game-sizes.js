#!/usr/bin/env node
// inspect-game-sizes.js
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const GAMES_DIR = path.join(ROOT, 'games', 'bv');
const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));

let totalSize = 0;
let totalGames = 0;
let hiddenGames = 0, normalGames = 0, profileOnlyGames = 0;
let hiddenBytes = 0, normalBytes = 0;
let sampleHidden = null, sampleNormal = null;
let seasonSizes = [];

for (const file of files) {
  const filePath = path.join(GAMES_DIR, file);
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  totalSize += fileSize;

  let sg;
  try { sg = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { continue; }

  const games = Object.values(sg.games || {});
  totalGames += games.length;

  let fileHidden = 0, fileNormal = 0;

  for (const g of games) {
    if (g.hidden) {
      hiddenGames++;
      fileHidden++;
    } else if (!g.profileOnly && !g.legacy && !g.forfeit && !g.cancelled && !g.abandoned) {
      normalGames++;
      fileNormal++;
    } else {
      profileOnlyGames++;
    }

    // Sample individual game entry sizes
    const gameStr = JSON.stringify(g);
    if (g.hidden && !sampleHidden) {
      sampleHidden = { size: gameStr.length, keys: Object.keys(g), hasHp: !!g.hp, hpLen: g.hp?.length };
    }
    if (!g.hidden && !g.profileOnly && !g.legacy && !g.forfeit && typeof g.hs === 'number' && !sampleNormal) {
      sampleNormal = { size: gameStr.length, keys: Object.keys(g), hasHp: !!g.hp };
    }
  }

  seasonSizes.push({ file, fileSize, games: games.length, hidden: fileHidden, normal: fileNormal });
}

// Sort by file size descending
seasonSizes.sort((a, b) => b.fileSize - a.fileSize);

console.log('\n📊 Game File Size Analysis');
console.log('─'.repeat(60));
console.log(`  Total game files:      ${files.length.toLocaleString()}`);
console.log(`  Total size (games/bv): ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
console.log(`  Total games:           ${totalGames.toLocaleString()}`);
console.log(`  Hidden games:          ${hiddenGames.toLocaleString()}`);
console.log(`  Normal games:          ${normalGames.toLocaleString()}`);
console.log(`  ProfileOnly+other:     ${profileOnlyGames.toLocaleString()}`);

console.log('\n  Sample hidden game entry:');
if (sampleHidden) {
  console.log(`    Size: ${sampleHidden.size} bytes`);
  console.log(`    Keys: ${sampleHidden.keys.join(', ')}`);
  console.log(`    Has hp/ap: ${sampleHidden.hasHp} (${sampleHidden.hpLen || 0} players)`);
}

console.log('\n  Sample normal game entry:');
if (sampleNormal) {
  console.log(`    Size: ${sampleNormal.size} bytes`);
  console.log(`    Keys: ${sampleNormal.keys.join(', ')}`);
  console.log(`    Has hp/ap: ${sampleNormal.hasHp}`);
}

console.log('\n  Largest season files (top 10):');
for (const s of seasonSizes.slice(0, 10)) {
  console.log(`    ${s.file.padEnd(20)} ${(s.fileSize/1024).toFixed(0).padStart(8)}KB  ${s.games} games  (${s.hidden} hidden, ${s.normal} normal)`);
}

console.log('\n  Average season file size:', (totalSize / files.length / 1024).toFixed(1), 'KB');
console.log('─'.repeat(60));
