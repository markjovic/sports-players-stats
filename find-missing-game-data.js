#!/usr/bin/env node
// find-missing-game-data.js

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const CONCURRENCY   = parseInt(ARGS.concurrency || '64', 10);
const GAMES_DIR     = path.join(__dirname, 'games', 'bv');
const MAIN_OUT      = path.join(__dirname, 'missing-game-data.json');
const BOX_OUT       = path.join(__dirname, 'missing-box-scores.json');
const QUARTER_OUT   = path.join(__dirname, 'missing-quarter-scores.json');

console.log(`\n🔍 Locating Missing Game Attributes (Deep Field Breakdown Matrix)`);

if (!fs.existsSync(GAMES_DIR)) {
  console.error(`❌ Target path missing: ${GAMES_DIR}`);
  process.exit(1);
}

const seasonFiles = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
console.log(`   Found ${seasonFiles.length.toLocaleString()} season files to process.\n`);

const mainMissingReport = {};
const globalMissingBoxScores = [];
const globalMissingQuarterScores = [];

let totalEligibleGames = 0;
let totalGamesWithGaps   = 0;
let processed = 0;

// Explicit Mandatory Keys Lists
const MANDATORY_CORE   = ['d', 'rn', 'h', 'hn', 'a', 'an', 'url', 'st'];
const MANDATORY_VENUE  = ['vid', 'vn', 'ct', 't'];

// Individual Key Counters
const fieldTally = {
  // Core Details
  d: 0, rn: 0, h: 0, hn: 0, a: 0, an: 0, url: 0, st: 0,
  // Venue Details
  vid: 0, vn: 0, ct: 0, t: 0,
  // Main Numeric Scores
  hs: 0, as: 0,
  // Complex Arrays
  hq: 0, aq: 0, hp: 0, ap: 0
};

async function processSeasonFile(file) {
  const seasonId = path.basename(file, '.json');
  try {
    const raw = await fs.promises.readFile(path.join(GAMES_DIR, file), 'utf8');
    const data = JSON.parse(raw);
    
    const games = data.games || {};
    const playerGames = data.playerGames || {};
    const seasonMissingGames = {};

    for (const [gameId, game] of Object.entries(games)) {
      if (game.st === 'UPCOMING' || !game.st) continue;

      totalEligibleGames++;
      const gapFields = {};
      let hasMainGap = false;

      // 1. Core Metadata Individual Key Verifications
      for (const field of MANDATORY_CORE) {
        const val = game[field];
        if (val !== undefined && val !== null && val !== '') {
          fieldTally[field]++;
        } else {
          gapFields[field] = null;
          hasMainGap = true;
        }
      }

      // 2. Segregated Venue Individual Key Verifications
      for (const field of MANDATORY_VENUE) {
        const val = game[field];
        if (val !== undefined && val !== null && val !== '') {
          fieldTally[field]++;
        } else {
          gapFields[field] = null;
          hasMainGap = true;
        }