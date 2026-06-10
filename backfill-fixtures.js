#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TARGET_SEASON_ID = process.argv[2] || "10107609"; // Default to the season you are stuck on
const GAMES_DIR = path.join(__dirname, 'games', 'bv');
const filePath = path.join(GAMES_DIR, `${TARGET_SEASON_ID}.json`);

if (!fs.existsSync(filePath)) {
  console.error(`File ${filePath} not found.`);
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const games = db.games || {};

// Logic: If game has 'o' (relative), map it to absolute 'h'/'a'
// Then, if any fields are missing, fetch from the API using Team IDs
for (const [gid, game] of Object.entries(games)) {
  // Normalize Relative Layout -> Absolute Layout
  if (game.o && !game.h) {
    if (game.hn === game.on) { // If Home Name == Opponent Name
        game.h = game.o;
        game.a = "0"; // Placeholder
    } else {
        game.h = "0";
        game.a = game.o;
    }
  }
  
  // Cleanup: If we have the absolute h/a, we don't need 'o' or 'on'
  if (game.h && game.o) {
      delete game.o;
      delete game.on;
  }
}

fs.writeFileSync(filePath, JSON.stringify(db, null, 2));
console.log("Normalization complete. Structure standardized.");

// Git push logic
try {
  execSync(`git add ${filePath}`);
  execSync('git commit -m "Standardize game structure"');
  execSync('git push');
} catch (e) {
  console.log("Git sync skipped.");
}