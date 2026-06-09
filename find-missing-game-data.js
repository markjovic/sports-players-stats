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

const CONCURRENCY = parseInt(ARGS.concurrency || '64', 10);
const GAMES_DIR   = path.join(__dirname, 'games', 'bv');
const OUTPUT_FILE = path.join(__dirname, 'missing-game-data.json');

console.log(`\n🔍 Locating Missing Game Attributes`);

if (!fs.existsSync(GAMES_DIR)) {
  console.error(`❌ Target path missing: ${GAMES_DIR}`);
  process.exit(1);
}

const seasonFiles = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
console.log(`   Found ${seasonFiles.length.toLocaleString()} season files to process.\n`);

const missingReport = {}; 
let totalSeasonsWithMissing = 0;
let totalGamesWithMissing   = 0;
let processed = 0;

// Essential data keys that must exist and not be empty strings/null for a completed match
const CORE_FIELDS = ['d', 'rn', 'h', 'hn', 'a', 'an', 'hs', 'as', 'vid', 'vn', 'ct', 't', 'url', 'st'];

async function processSeasonFile(file) {
  const seasonId = path.basename(file, '.json');
  try {
    const raw = await fs.promises.readFile(path.join(GAMES_DIR, file), 'utf8');
    const data = JSON.parse(raw);
    
    const games = data.games || {};
    const playerGames = data.playerGames || {};

    const seasonMissingGames = {};

    for (const [gameId, game] of Object.entries(games)) {
      // Exclude future unplayed fixtures cleanly
      if (game.st === 'UPCOMING' || !game.st) continue;

      const missingFields = {};
      let hasMissing = false;

      for (const field of CORE_FIELDS) {
        const val = game[field];
        if (val === undefined || val === null || val === '') {
          missingFields[field] = null; // Track only the explicit fields that are empty
          hasMissing = true;
        }
      }

      if (hasMissing) {
        seasonMissingGames[gameId] = missingFields;
        totalGamesWithMissing++;
      }
    }

    // If this season has games with gaps, find an anchor player UUID who participated
    if (Object.keys(seasonMissingGames).length > 0) {
      let anchorPlayerUuid = null;
      
      // Look through player histories to catch an active member
      for (const [playerUuid, associatedGameIds] of Object.entries(playerGames)) {
        if (Array.isArray(associatedGameIds) && associatedGameIds.length > 0) {
          anchorPlayerUuid = playerUuid;
          break; // Grab the first stable anchor player instance
        }
      }

      missingReport[seasonId] = {
        seasonId,
        anchorPlayerUuid,
        missingGamesCount: Object.keys(seasonMissingGames).length,
        games: seasonMissingGames
      };
      totalSeasonsWithMissing++;
    }

  } catch (e) {
    // Skip broken season JSON trees safely
  }
}

async function worker(iterator) {
  for (const file of iterator) {
    await processSeasonFile(file);
    processed++;
    if (processed % 100 === 0 || processed === seasonFiles.length) {
      const pct = ((processed / seasonFiles.length) * 100).toFixed(1);
      process.stdout.write(`   Progress: ${processed.toLocaleString()}/${seasonFiles.length.toLocaleString()} (${pct}%) — ${totalGamesWithMissing.toLocaleString()} partial games tracked\r`);
    }
  }
}

async function runPool() {
  const iterator = seasonFiles[Symbol.iterator]();
  const pool = Array(CONCURRENCY).fill(iterator).map(worker);
  await Promise.all(pool);

  console.log(`\n\n✅ Audit complete. Compiling metrics layout...`);

  const output = {
    generatedAt: new Date().toISOString(),
    totalSeasonsAudited: seasonFiles.length,
    seasonsWithMissingData: totalSeasonsWithMissing,
    totalGamesWithMissingData: totalGamesWithMissing,
    report: missingReport
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`   ✓ Complete breakdown safely saved to: ${OUTPUT_FILE}`);

  // Git Automation Block
  try {
    execSync('git add missing-game-data.json', { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (diff) {
      execSync(`git commit -m "Audit missing data maps: ${totalGamesWithMissing} partially incomplete matches tracked"`, { stdio: 'pipe' });
      execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log('   ✓ Metrics updated and synced to GitHub repository origin.');
    } else {
      console.log('   (No tracking adjustments required to commit)');
    }
  } catch (e) {
    console.warn(`   Local git tracking warning: ${e.message}`);
  }
}

runPool().catch(e => { console.error(`\n❌ Fatal operational crash: ${e.message}`); process.exit(1); });