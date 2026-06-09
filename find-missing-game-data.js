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

console.log(`\n🔍 Locating Missing Game Attributes (Targeted Audit)`);

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

// ─── Global Coverage Counter Tally ───────────────────────────────────────────
let totalEligibleGames = 0;
const stats = {
  coreMeta:   0, // d, rn, h, hn, a, an, vid, vn, ct, t, url, st
  scores:     0, // hs, as
  quarters:   0, // hq, aq
  boxScores:  0  // hp, ap
};

// Explicit Mandatory Fields
const MANDATORY_CORE = ['d', 'rn', 'h', 'hn', 'a', 'an', 'vid', 'vn', 'ct', 't', 'url', 'st'];

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

      totalEligibleGames++;
      const missingFields = {};
      let hasMissing = false;

      // 1. Tally & Check Core Metadata Coverage
      let coreMetaComplete = true;
      for (const field of MANDATORY_CORE) {
        const val = game[field];
        if (val === undefined || val === null || val === '') {
          missingFields[field] = null;
          hasMissing = true;
          coreMetaComplete = false;
        }
      }
      if (coreMetaComplete) stats.coreMeta++;

      // 2. Tally & Check Numerical Scores
      if (typeof game.hs === 'number' && typeof game.as === 'number') {
        stats.scores++;
      } else {
        if (game.hs === undefined || game.hs === null || game.hs === '') missingFields['hs'] = null;
        if (game.as === undefined || game.as === null || game.as === '') missingFields['as'] = null;
        hasMissing = true;
      }

      // 3. Tally & Check Quarter Score Arrays
      const hasHq = Array.isArray(game.hq) && game.hq.length > 0;
      const hasAq = Array.isArray(game.aq) && game.aq.length > 0;
      if (hasHq && hasAq) {
        stats.quarters++;
      } else {
        if (!hasHq) missingFields['hq'] = null;
        if (!hasAq) missingFields['aq'] = null;
        hasMissing = true;
      }

      // 4. Tally & Check Player Box Score Arrays
      const hasHp = Array.isArray(game.hp) && game.hp.length > 0;
      const hasAp = Array.isArray(game.ap) && game.ap.length > 0;
      if (hasHp && hasAp) {
        stats.boxScores++;
      } else {
        if (!hasHp) missingFields['hp'] = null;
        if (!hasAp) missingFields['ap'] = null;
        hasMissing = true;
      }

      // 5. Rule Override: Passively include Administrative Overrides only if they exist
      if (hasMissing) {
        if (game.forfeit) missingFields['forfeit'] = game.forfeit;
        if (game.fo)      missingFields['fo']      = game.fo;
        if (game.desc)    missingFields['desc']    = game.desc;
        if (game.hidden)  missingFields['hidden']  = game.hidden;
        if (game.legacy)  missingFields['legacy']  = game.legacy;

        seasonMissingGames[gameId] = missingFields;
        totalGamesWithMissing++;
      }
    }

    // If this season contains entries with data gaps, link an anchor player UUID
    if (Object.keys(seasonMissingGames).length > 0) {
      let anchorPlayerUuid = null;
      for (const [playerUuid, associatedGameIds] of Object.entries(playerGames)) {
        if (Array.isArray(associatedGameIds) && associatedGameIds.length > 0) {
          anchorPlayerUuid = playerUuid;
          break;
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

  } catch (e) {}
}

async function worker(iterator) {
  for (const file of iterator) {
    await processSeasonFile(file);
    processed++;
    if (processed % 100 === 0 || processed === seasonFiles.length) {
      const pct = ((processed / seasonFiles.length) * 100).toFixed(1);
      process.stdout.write(`   Progress: ${processed.toLocaleString()}/${seasonFiles.length.toLocaleString()} (${pct}%) — ${totalGamesWithMissing.toLocaleString()} matches flagged\r`);
    }
  }
}

async function runPool() {
  const iterator = seasonFiles[Symbol.iterator]();
  const pool = Array(CONCURRENCY).fill(iterator).map(worker);
  await Promise.all(pool);

  // ─── Calculate Coverage Percentages ────────────────────────────────────────
  const calcPct = (count) => totalEligibleGames ? ((count / totalEligibleGames) * 100).toFixed(2) : '0.00';

  console.log(`\n\n✅ Data Coverage Audit Complete!`);
  console.log(`================================================================`);
  console.log(`   Total Completed Games Evaluated:  ${totalEligibleGames.toLocaleString()}`);
  console.log(`----------------------------------------------------------------`);
  console.log(`   📦 Core Details Populated:        ${stats.coreMeta.toLocaleString().padStart(9)} matches (${calcPct(stats.coreMeta)}%)`);
  console.log(`   🔢 Main Scores Populated:        ${stats.scores.toLocaleString().padStart(9)} matches (${calcPct(stats.scores)}%)`);
  console.log(`   ⏱️ Quarter Scores Populated:     ${stats.quarters.toLocaleString().padStart(9)} matches (${calcPct(stats.quarters)}%)`);
  console.log(`   🏀 Player Box Scores Populated:   ${stats.boxScores.toLocaleString().padStart(9)} matches (${calcPct(stats.boxScores)}%)`);
  console.log(`================================================================`);
  console.log(`   Games with targeted data gaps:   ${totalGamesWithMissing.toLocaleString()}`);

  const output = {
    generatedAt: new Date().toISOString(),
    totalSeasonsAudited: seasonFiles.length,
    seasonsWithMissingData: totalSeasonsWithMissing,
    totalGamesWithMissingData: totalGamesWithMissing,
    globalCompletenessMetrics: {
      totalHistoricalGamesScanned: totalEligibleGames,
      coreMetaPopulatedPercent: calcPct(stats.coreMeta),
      mainScoresPopulatedPercent: calcPct(stats.scores),
      quarterBreakdownsPopulatedPercent: calcPct(stats.quarters),
      playerBoxScoresPopulatedPercent: calcPct(stats.boxScores)
    },
    report: missingReport
  };

  // ─── MINIFIED SAFE FILE WRITE ───
  // Drops formatting indents to save ~45% footprint space, avoiding Git push size ceiling blocks.
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
  console.log(`\n   ✓ Incomplete data profile map safely minified to: ${OUTPUT_FILE}`);

  try {
    execSync('git add missing-game-data.json', { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (diff) {
      execSync(`git commit -m "Audit targeted data loops: ${totalGamesWithMissing} incomplete rows tracked"`, { stdio: 'pipe' });
      execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log('   ✓ Metrics updated and pushed directly to GitHub origin repository.');
    } else {
      console.log('   (No tracking adjustments required to commit)');
    }
  } catch (e) {
    console.warn(`   Local git tracking warning: ${e.message}`);
  }
}

runPool().catch(e => { console.error(`\n❌ Fatal operational crash: ${e.message}`); process.exit(1); });