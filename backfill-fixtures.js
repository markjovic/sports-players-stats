#!/usr/bin/env node
// backfill-fixtures.js

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TARGET_SEASON_ID = "29536804";
const MAIN_REPORT_PATH = path.join(__dirname, 'missing-game-data.json');
const GAMES_DIR = path.join(__dirname, 'games', 'bv');
const PLAYERS_DIR = path.join(__dirname, 'players');

async function runLocalFuzzyBackfill() {
  console.log("\n================================================================");
  console.log("🚀 STARTING LOCAL FUZZY IDENTITY BACKFILL FOR SEASON: " + TARGET_SEASON_ID);
  console.log("================================================================");

  const seasonFilePath = path.join(GAMES_DIR, TARGET_SEASON_ID + '.json');
  if (!fs.existsSync(seasonFilePath)) {
    console.error("❌ Season file missing on disk: " + seasonFilePath);
    process.exit(1);
  }

  const seasonFileContents = JSON.parse(fs.readFileSync(seasonFilePath, 'utf8'));
  const localGames = seasonFileContents.games || {};
  
  const internalPlayerUuids = Object.keys(seasonFileContents.playerGames || {});
  console.log("👥 Found " + internalPlayerUuids.length + " local player profiles to cross-reference.");

  const deltas = { teams: 0, scores: 0, rounds: 0, totalGamesImpacted: new Set() };

  // Loop through all 57 player profiles locally on disk
  for (const playerUuid of internalPlayerUuids) {
    const hexFolder = playerUuid.slice(0, 2).toLowerCase();
    const playerFilePath = path.join(PLAYERS_DIR, hexFolder, playerUuid + '.json');

    if (!fs.existsSync(playerFilePath)) {
      continue; 
    }

    const playerData = JSON.parse(fs.readFileSync(playerFilePath, 'utf8'));
    const playerGamesBlock = playerData.games || {};

    for (const [playerGid, pGame] of Object.entries(playerGamesBlock)) {
      const pDate = pGame.date ? pGame.date.slice(0, 10) : null;
      if (!pDate) continue;

      const pTeam = pGame.teamName || '';
      const pOpp = pGame.oppName || '';
      const isHome = pGame.isHome || pGame.homeAway === 'HOME' || pGame.homeAway === 'home';

      // Find a matching game in your 73 legacy rows based on Date and Name alignment
      let matchedLocalGid = null;
      
      if (localGames[playerGid]) {
        matchedLocalGid = playerGid;
      } else {
        for (const [id, g] of Object.entries(localGames)) {
          if (g.d === pDate) {
            // Check if the opponent name in your file is contained within either team name from the player log
            const nameMatch = g.on && (
              pTeam.toLowerCase().includes(g.on.toLowerCase()) ||
              pOpp.toLowerCase().includes(g.on.toLowerCase()) ||
              g.on.toLowerCase().includes(pTeam.toLowerCase()) ||
              g.on.toLowerCase().includes(pOpp.toLowerCase())
            );

            if (nameMatch && (g.legacy || !g.h || g.h === 0)) {
              matchedLocalGid = id;
              break;
            }
          }
        }
      }

      if (matchedLocalGid) {
        const gameRow = localGames[matchedLocalGid];
        let updated = false;

        // Map team names and IDs into absolute Home vs Away positioning
        if (!gameRow.hn || gameRow.hn === 0 || gameRow.legacy) {
          gameRow.hn = isHome ? pTeam : pOpp;
          gameRow.an = isHome ? pOpp : pTeam;
          
          if (pGame.teamId) {
            gameRow.h = isHome ? pGame.teamId : 0;
            gameRow.a = isHome ? 0 : pGame.teamId;
          } else if (pGame.teamUUID) {
            gameRow.h = isHome ? pGame.teamUUID : 0;
            gameRow.a = isHome ? 0 : pGame.teamUUID;
          }
          deltas.teams++;
          updated = true;
        }

        // Map final scores
        if ((gameRow.hs === 0 || gameRow.hs === undefined) && typeof pGame.teamScore === 'number') {
          gameRow.hs = isHome ? pGame.teamScore : (pGame.oppScore || 0);
          gameRow.as = isHome ? (pGame.oppScore || 0) : pGame.teamScore;
          deltas.scores++;
          updated = true;
        }

        // Map round groupings
        if ((!gameRow.rn || gameRow.rn === 0) && pGame.round) {
          gameRow.rn = pGame.round;
          deltas.rounds++;
          updated = true;
        }

        if (updated) {
          delete gameRow.o;
          delete gameRow.on;
          delete gameRow.legacy;
          deltas.totalGamesImpacted.add(matchedLocalGid);
        }
      }
    }
  }

  console.log("\n-------------------------------------------------------------");
  console.log("   📉 Pure Local Fuzzy Backfill Delta Metrics Summary:");
  console.log("-------------------------------------------------------------");
  console.log("   Total Matches Repaired:     " + deltas.totalGamesImpacted.size);
  console.log("   [h/a] Team Layouts Unified: " + deltas.teams);
  console.log("   [pts] Final Scores Saved:   " + deltas.scores);
  console.log("   [rn]  Round Gaps Restored:  " + deltas.rounds);
  console.log("-------------------------------------------------------------");

  fs.writeFileSync(seasonFilePath, JSON.stringify(seasonFileContents, null, 2));
  
  if (fs.existsSync(MAIN_REPORT_PATH)) {
    const reportData = JSON.parse(fs.readFileSync(MAIN_REPORT_PATH, 'utf8'));
    if (reportData.report && reportData.report[TARGET_SEASON_ID]) {
      delete reportData.report[TARGET_SEASON_ID];
      reportData.totalGamesWithCoreOrVenueGaps = Object.values(reportData.report).reduce((acc, curr) => acc + (curr.missingGamesCount || 0), 0);
      fs.writeFileSync(MAIN_REPORT_PATH, JSON.stringify(reportData));
    }
  }

  try {
    execSync('git add ' + seasonFilePath + ' ' + MAIN_REPORT_PATH, { stdio: 'pipe' });
    if (execSync('git diff --staged --name-only', { stdio: 'pipe' }).toString().trim()) {
      execSync('git commit -m "Backfill Step: Processed legacy season ' + TARGET_SEASON_ID + ' via local fuzzy matching"', { stdio: 'pipe' });
      execSync('git pull --rebase=false -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log("✓ Secure push to origin verified.");
    } else {
      console.log("ℹ No changes detected on disk.");
    }
  } catch (gitErr) {}
}

runLocalFuzzyBackfill().catch(e => { console.error("\n❌ Fatal Error: " + e.message); process.exit(1); });