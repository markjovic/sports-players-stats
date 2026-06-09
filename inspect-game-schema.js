#!/usr/bin/env node
// inspect-game-schema.js
'use strict';

const fs = require('fs');
const path = require('path');

const GAMES_DIR = path.join(__dirname, 'games', 'bv');

console.log(`\n🔍 Schema Discovery Pass...`);
if (!fs.existsSync(GAMES_DIR)) {
  console.error(`❌ Games directory not found at ${GAMES_DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
console.log(`   Scanning ${files.length.toLocaleString()} season files...`);

const globalUniqueKeys = new Set();
let sampleValuesMap = {};
let totalGamesScanned = 0;

for (const file of files) {
  try {
    const raw = fs.readFileSync(path.join(GAMES_DIR, file), 'utf8');
    const seasonData = JSON.parse(raw);
    const games = seasonData.games || {};

    for (const [gameId, game] of Object.entries(games)) {
      totalGamesScanned++;
      for (const key of Object.keys(game)) {
        if (!globalUniqueKeys.has(key)) {
          globalUniqueKeys.add(key);
          sampleValuesMap[key] = {
            sampleValue: game[key],
            foundInSeason: file,
            foundInGame: gameId
          };
        }
      }
    }
  } catch (e) {}
}

console.log(`\n✅ Discovery Complete! Scanned ${totalGamesScanned.toLocaleString()} games.`);
console.log(`📊 All unique properties discovered across your database files:\n`);

console.log(JSON.stringify({
  uniqueKeysFound: Array.from(globalUniqueKeys),
  detailedSchemaSamples: sampleValuesMap
}, null, 2));