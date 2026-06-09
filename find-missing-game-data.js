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
      }

      // 3. Main Scores Key Verifications
      if (typeof game.hs === 'number') {
        fieldTally['hs']++;
      } else {
        gapFields['hs'] = null;
        hasMainGap = true;
      }

      if (typeof game.as === 'number') {
        fieldTally['as']++;
      } else {
        gapFields['as'] = null;
        hasMainGap = true;
      }

      // 4. Quarter Scores Breakdown Key Verification
      const hasHq = Array.isArray(game.hq) && game.hq.length > 0;
      const hasAq = Array.isArray(game.aq) && game.aq.length > 0;
      if (hasHq) fieldTally['hq']++;
      if (hasAq) fieldTally['aq']++;
      if (!hasHq || !hasAq) {
        globalMissingQuarterScores.push(gameId);
      }

      // 5. Player Box Scores Breakdown Key Verification
      const hasHp = Array.isArray(game.hp) && game.hp.length > 0;
      const hasAp = Array.isArray(game.ap) && game.ap.length > 0;
      if (hasHp) fieldTally['hp']++;
      if (hasAp) fieldTally['ap']++;
      if (!hasHp || !hasAp) {
        globalMissingBoxScores.push(gameId);
      }

      // Track administrative context keys
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
      process.stdout.write(`   Progress: ${processed.toLocaleString()}/${seasonFiles.length.toLocaleString()} (${pct}%) — ${totalGamesWithGaps.toLocaleString()} anomalies logged\r`);
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
  console.log(`================================================================`);
  
  console.log(`\n   📦 Core Details Individual Field Breakdown:`);
  console.log(`   -------------------------------------------------------------`);
  console.log(`   [d]   Date Populated:            ${fieldTally.d.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.d)}%)`);
  console.log(`   [rn]  Round Name Populated:      ${fieldTally.rn.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.rn)}%)`);
  console.log(`   [st]  Game Status Populated:     ${fieldTally.st.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.st)}%)`);
  console.log(`   [url] Match URL Populated:        ${fieldTally.url.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.url)}%)`);
  console.log(`   [h]   Home Team ID Populated:    ${fieldTally.h.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.h)}%)`);
  console.log(`   [hn]  Home Team Name Populated:  ${fieldTally.hn.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.hn)}%)`);
  console.log(`   [a]   Away Team ID Populated:    ${fieldTally.a.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.a)}%)`);
  console.log(`   [an]  Away Team Name Populated:  ${fieldTally.an.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.an)}%)`);

  console.log(`\n   📍 Venue Info Individual Field Breakdown:`);
  console.log(`   -------------------------------------------------------------`);
  console.log(`   [vid] Venue ID Populated:        ${fieldTally.vid.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.vid)}%)`);
  console.log(`   [vn]  Venue Name Populated:      ${fieldTally.vn.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.vn)}%)`);
  console.log(`   [ct]  Court Label Populated:     ${fieldTally.ct.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.ct)}%)`);
  console.log(`   [t]   Time Label Populated:      ${fieldTally.t.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.t)}%)`);

  console.log(`\n   🔢 Main Scores Individual Field Breakdown:`);
  console.log(`   -------------------------------------------------------------`);
  console.log(`   [hs]  Home Score Populated:      ${fieldTally.hs.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.hs)}%)`);
  console.log(`   [as]  Away Score Populated:      ${fieldTally.as.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.as)}%)`);

  console.log(`\n   ⏱️ Quarter Breakdowns Individual Field Breakdown:`);
  console.log(`   -------------------------------------------------------------`);
  console.log(`   [hq]  Home Quarters Array:       ${fieldTally.hq.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.hq)}%)`);
  console.log(`   [aq]  Away Quarters Array:       ${fieldTally.aq.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.aq)}%)`);

  console.log(`\n   🏀 Player Box Scores Individual Field Breakdown:`);
  console.log(`   -------------------------------------------------------------`);
  console.log(`   [hp]  Home Players Roster Array: ${fieldTally.hp.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.hp)}%)`);
  console.log(`   [ap]  Away Players Roster Array: ${fieldTally.ap.toLocaleString().padStart(9)} matches (${calcPct(fieldTally.ap)}%)`);
  
  console.log(`================================================================`);
  console.log(`   Anomalous rows in core report:   ${totalGamesWithGaps.toLocaleString()}\n`);

  const mainPayload = {
    generatedAt: new Date().toISOString(),
    totalSeasonsAudited: seasonFiles.length,
    totalGamesWithCoreOrVenueGaps: totalGamesWithGaps,
    fieldCompletenessMatrix: {
      totalGamesScanned: totalEligibleGames,
      tallies: fieldTally,
      percentages: {
        d: calcPct(fieldTally.d), rn: calcPct(fieldTally.rn), st: calcPct(fieldTally.st), url: calcPct(fieldTally.url),
        h: calcPct(fieldTally.h), hn: calcPct(fieldTally.hn), a: calcPct(fieldTally.a), an: calcPct(fieldTally.an),
        vid: calcPct(fieldTally.vid), vn: calcPct(fieldTally.vn), ct: calcPct(fieldTally.ct), t: calcPct(fieldTally.t),
        hs: calcPct(fieldTally.hs), as: calcPct(fieldTally.as),
        hq: calcPct(fieldTally.hq), aq: calcPct(fieldTally.aq),
        hp: calcPct(fieldTally.hp), ap: calcPct(fieldTally.ap)
      }
    },
    report: mainMissingReport
  };

  fs.writeFileSync(BOX_OUT, JSON.stringify(globalMissingBoxScores));
  fs.writeFileSync(QUARTER_OUT, JSON.stringify(globalMissingQuarterScores));
  fs.writeFileSync(MAIN_OUT, JSON.stringify(mainPayload));

  try {
    execSync('git add missing-game-data.json missing-box-scores.json missing-quarter-scores.json', { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (diff) {
      execSync(`git commit -m "Audit deep loop pass: Detailed key-by-key data gaps tracked"`, { stdio: 'pipe' });
      execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
      execSync('git push',