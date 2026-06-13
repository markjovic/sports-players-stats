#!/usr/bin/env node
// find-game-id.js
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const GAME_ID   = process.argv[2] || '53968080';
const GAMES_DIR = path.join(ROOT, 'games', 'bv');

console.log(`\nSearching for game ID: ${GAME_ID}\n`);

for (const file of fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'))) {
  let sg;
  try { sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8')); } catch (e) { continue; }
  if (sg.games?.[GAME_ID]) {
    const g = sg.games[GAME_ID];
    console.log(`Found in: ${file}`);
    console.log(`  hidden:${g.hidden} h:${g.h} rn:${g.rn} noProfile:${JSON.stringify(g.noProfile)} noVenue:${JSON.stringify(g.noVenue)} vid:${g.vid} hs:${g.hs}`);
  }
}
console.log('\nDone.');
