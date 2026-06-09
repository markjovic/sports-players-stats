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

console.log(`\n🔍 Locating Missing Game Attributes (Tri-File Extraction)`);

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

// Segregated Coverage Counters
const stats = {
  coreMeta:   0, // d, rn, h, hn, a, an, url, st
  venueInfo:  0, // vid, vn, ct, t
  scores:     0, // hs, as
  quarters:   0, // hq, aq
  boxScores:  0  // hp, ap
};

// Explicit Mandatory Rules Layouts
const MANDATORY_CORE   = ['d', 'rn', 'h', 'hn', 'a', 'an', 'url', 'st'];
const MANDATORY_VENUE  = ['vid', 'vn', 'ct', 't'];

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

      // 1. Core Metadata Verification
      let coreMetaComplete = true;
      for (const field of MANDATORY_CORE) {
        const val = game[field];
        if (val === undefined || val === null || val === '') {
          gapFields[field] = null;
          hasMainGap = true;
          coreMetaComplete = false;
        }
      }
      if (coreMetaComplete) stats.coreMeta++;

      // 2. Segregated Venue Information Verification
      let venueInfoComplete = true;
      for (const field of MANDATORY_VENUE) {
        const val = game[field];
        if (val === undefined || val === null || val === '') {
          gapFields[field] = null;
          hasMainGap = true;
          venueInfoComplete = false;
        }
      }
      if (venueInfoComplete) stats.venueInfo++;

      // 3. Main Numeric Scores Verification
      if (typeof game.hs === 'number' && typeof game.as === 'number') {
        stats.scores++;
      } else {
        if (game.hs === undefined || game.hs === null || game.hs === '') gapFields['hs'] = null;
        if (game.as === undefined || game.as === null || game.as === '') gapFields['as'] = null;
        hasMainGap = true;
      }

      // 4. Isolated Extraction: Quarter Scores Check
      const hasHq = Array.isArray(game.hq) && game.hq.length > 0;
      const hasAq = Array.isArray(game.aq) && game.aq.length > 0;
      if (hasHq && hasAq) {
        stats.quarters++;
      } else {
        globalMissingQuarterScores.push(gameId);
      }

      // 5. Isolated Extraction: Player Box Scores Check
      const hasHp = Array.isArray(game.hp) && game.hp.length > 0;
      const hasAp = Array.isArray(game.ap) && game.ap.length > 0;
      if (hasHp && hasAp) {
        stats.boxScores++;
      } else {
        globalMissingBoxScores.push(gameId);
      }

      // Append administrative data flags to the main report if core/venue/score flaws exist
      if (hasMainGap) {
        if (game.forfeit) gapFields['forfeit'] = game.forfeit;
        if (game.fo)      gapFields['fo']      = game.fo;
        if (game.desc)    gapFields['desc']    = game.desc;
        if (game.hidden)  gapFields['hidden']  = game.hidden;
        if (game.legacy)  gapFields['legacy']  = game.legacy;

        seasonMissingGames[gameId] = gapFields;
        totalGamesWithGaps++;
      }
    }

    if (Object.keys(seasonMissingGames).length > 0) {
      let anchorPlayerUuid = null;
      for (const [playerUuid, associatedGameIds] of Object.entries(playerGames)) {
        if (Array.isArray(associatedGameIds) && associatedGameIds.length > 0) {
          anchorPlayerUuid = playerUuid;
          break;
        }
      }

      mainMissingReport[seasonId] = {
        seasonId,
        anchorPlayerUuid,
        missingGamesCount: Object.keys(seasonMissingGames).length,
        games: seasonMissingGames
      };
    }

  } catch (e) {}
}

async function worker(iterator) {
  for (const file of iterator) {
    await processSeasonFile(file);
    processed++;
    if (processed % 100 === 0 || processed === seasonFiles.length) {
      const pct = ((processed / seasonFiles.length) * 100).toFixed(1);
      process.stdout.write(`   Progress: ${processed.toLocaleString()}/${seasonFiles.length.toLocaleString()} (${pct}%) — ${totalGamesWithGaps.toLocaleString()} core anomalies logged\r`);
    }
  }
}

async function runPool() {
  const iterator = seasonFiles[Symbol.iterator]();
  const pool = Array(CONCURRENCY).fill(iterator).map(worker);
  await Promise.all(pool);

  const calcPct = (count) => totalEligibleGames ? ((count / totalEligibleGames) * 100).toFixed(2) : '0.00';

  console.log(`\n\n✅ Data Coverage Audit Complete!`);
  console.log(`================================================================`);
  console.log(`   Total Completed Games Evaluated:  ${totalEligibleGames.toLocaleString()}`);
  console.log(`----------------------------------------------------------------`);
  console.log(`   📦 Core Details Populated:        ${stats.coreMeta.toLocaleString().padStart(9)} matches (${calcPct(stats.coreMeta)}%)`);
  console.log(`   📍 Venue Info Populated:         ${stats.venueInfo.toLocaleString().padStart(9)} matches (${calcPct(stats.venueInfo)}%)`);
  console.log(`   🔢 Main Scores Populated:        ${stats.scores.toLocaleString().padStart(9)} matches (${calcPct(stats.scores)}%)`);
  console.log(`   ⏱️ Quarter Scores Populated:     ${stats.quarters.toLocaleString().padStart(9)} matches (${calcPct(stats.quarters)}%)`);
  console.log(`   🏀 Player Box Scores Populated:   ${stats.boxScores.toLocaleString().padStart(9)} matches (${calcPct(stats.boxScores)}%)`);
  console.log(`================================================================`);
  console.log(`   Anomalous rows in core report:   ${totalGamesWithGaps.toLocaleString()}`);

  const mainPayload = {
    generatedAt: new Date().toISOString(),
    totalSeasonsAudited: seasonFiles.length,
    totalGamesWithCoreOrVenueGaps: totalGamesWithGaps,
    globalCompletenessMetrics: {
      totalHistoricalGamesScanned: totalEligibleGames,
      coreMetaPopulatedPercent: calcPct(stats.coreMeta),
      venueInfoPopulatedPercent: calcPct(stats.venueInfo),
      mainScoresPopulatedPercent: calcPct(stats.scores),
      quarterBreakdownsPopulatedPercent: calcPct(stats.quarters),
      playerBoxScoresPopulatedPercent: calcPct(stats.boxScores)
    },
    report: mainMissingReport
  };

  // Write File 1: Isolated Flat Box Score Array
  fs.writeFileSync(BOX_OUT, JSON.stringify(globalMissingBoxScores));
  console.log(`\n   ✓ Saved flat box score gap list to: ${BOX_OUT}`);

  // Write File 2: Isolated Flat Quarter Score Array
  fs.writeFileSync(QUARTER_OUT, JSON.stringify(globalMissingQuarterScores));
  console.log(`\n   ✓ Saved flat quarter score gap list to: ${QUARTER_OUT}`);

  // Write File 3: Core & Venue Attribute Anomalies (Minified)
  fs.writeFileSync(MAIN_OUT, JSON.stringify(mainPayload));
  console.log(`   ✓ Saved minified main gap manifest to: ${MAIN_OUT}`);

  try {
    execSync('git add missing-game-data.json missing-box-scores.json missing-quarter-scores.json', { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (diff) {
      execSync(`git commit -m "Audit split tracking: Core anomalies and flat metric arrays isolated"`, { stdio: 'pipe' });
      execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log('   ✓ Extraction audit reports pushed successfully to GitHub repository origin.');
    } else {
      console.log('   (No tracking adjustments required to commit)');
    }
  } catch (e) {
    console.warn(`   Local git tracking warning: ${e.message}`);
  }
}

runPool().catch(e => { console.error(`\n❌ Fatal operational crash: ${e.message}`); process.exit(1); });