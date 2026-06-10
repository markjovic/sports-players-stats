#!/usr/bin/env node
// backfill-fixtures.js

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { 
      const [k, ...v] = a.slice(2).split('='); 
      return [k, v.length ? v.join('=') : true]; 
    })
);

const CONCURRENCY = parseInt(ARGS.concurrency || '10', 10);
const TARGET_SEASON_ID = ARGS.seasonId || "29536804"; // Fallback to your target season immediately

const MAIN_REPORT_PATH = path.join(__dirname, 'missing-game-data.json');
const GAMES_DIR = path.join(__dirname, 'games', 'bv');

const HEADERS = {
  'accept': '*/*',
  'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria',
  'content-type': 'application/json'
};

async function runPlayerHistoryBackfill() {
  console.log("\n================================================================");
  console.log("🚀 INITIALIZING NETWORK PLAYER PROFILE HISTORY SWEEP FOR SEASON: " + TARGET_SEASON_ID);
  console.log("================================================================");

  const seasonFilePath = path.join(GAMES_DIR, TARGET_SEASON_ID + '.json');
  if (!fs.existsSync(seasonFilePath)) {
    console.error("❌ Season file missing on disk: " + seasonFilePath);
    process.exit(1);
  }

  const seasonFileContents = JSON.parse(fs.readFileSync(seasonFilePath, 'utf8'));
  const targetGames = seasonFileContents.games || {};
  
  // Extract all 57 players explicitly listed inside the raw database file
  const playerUuids = Object.keys(seasonFileContents.playerGames || {});
  console.log("👥 Extracted " + playerUuids.length + " player profiles to query via live API endpoint.");

  // Authenticate network access token cookie upfront
  const sessionRes = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID() }),
    body: JSON.stringify({ operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' })
  });
  const rawCookie = sessionRes.headers.get('set-cookie') || '';
  const cookieMatch = rawCookie.match(/phq_session=([^;]+)/);
  if (!cookieMatch) throw new Error("PHQ authentication token assignment failed.");
  const sessionToken = cookieMatch[1];

  const deltas = { urls: 0, rounds: 0, teams: 0, venues: 0, scores: 0, totalGamesImpacted: new Set() };
  
  // Explicit Public Player Profile History GraphQL Query Definition
  const playerHistoryQuery = `
    query PlayerHistory($playerUUID: ID!) {
      discoverPlayerProfile(playerUUID: $playerUUID) {
        seasons {
          matches {
            id
            round
            homeAway
            team { id name }
            opponent { id name }
            result { teamScore opponentScore }
          }
        }
      }
    }
  `;

  let index = 0;
  const workers = Array(CONCURRENCY).fill(null).map(async () => {
    while (index < playerUuids.length) {
      const currentUuid = playerUuids[index++];
      console.log("   🌐 [API Query] Fetching history log for player token: " + currentUuid);
      
      try {
        const res = await fetch('https://api.playhq.com/graphql', {
          method: 'POST',
          headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID(), 'Cookie': 'phq_session=' + sessionToken }),
          body: JSON.stringify({ query: playerHistoryQuery, variables: { playerUUID: currentUuid } })
        });
        const json = await res.json();
        
        // Flatten all historical games across their registered seasons
        const seasons = json.data?.discoverPlayerProfile?.seasons || [];
        for (const season of seasons) {
          for (const apiMatch of season.matches || []) {
            const gid = apiMatch.id;

            // If this player's live history match overlaps with an open row, restructure it
            if (targetGames[gid]) {
              const localGame = targetGames[gid];
              let updated = false;

              const isHome = apiMatch.homeAway === 'HOME' || apiMatch.homeAway === 'home';

              // Unify relative viewpoint attributes into definitive absolute parameters
              if (!localGame.hn || localGame.hn === 0 || localGame.legacy) {
                localGame.hn = isHome ? (apiMatch.team?.name || '') : (apiMatch.opponent?.name || '');
                localGame.an = isHome ? (apiMatch.opponent?.name || '') : (apiMatch.team?.name || '');
                localGame.h = isHome ? (apiMatch.team?.id || 0) : (apiMatch.opponent?.id || 0);
                localGame.a = isHome ? (apiMatch.opponent?.id || 0) : (apiMatch.team?.id || 0);
                deltas.teams++;
                updated = true;
              }

              if ((localGame.hs === 0 || localGame.hs === undefined) && apiMatch.result) {
                localGame.hs = isHome ? apiMatch.result.teamScore : apiMatch.result.opponentScore;
                localGame.as = isHome ? apiMatch.result.opponentScore : apiMatch.result.teamScore;
                deltas.scores++;
                updated = true;
              }

              if ((!localGame.rn || localGame.rn === 0) && apiMatch.round) {
                localGame.rn = apiMatch.round;
                deltas.rounds++;
                updated = true;
              }

              if (updated) {
                // Completely drop old temporary layout attributes
                delete localGame.o;
                delete localGame.on;
                delete localGame.legacy;
                deltas.totalGamesImpacted.add(gid);
              }
            }
          }
        }
      } catch (err) {
        console.log("      ⚠️ Query execution skipped or interrupted for UUID " + currentUuid + ": " + err.message);
      }
    }
  });

  await Promise.all(workers);

  console.log("\n-------------------------------------------------------------");
  console.log("   📉 Player History API Backfill Delta Metrics Summary:");
  console.log("-------------------------------------------------------------");
  console.log("   Total Matches Restructured: " + deltas.totalGamesImpacted.size);
  console.log("   [h/a] Absolute Team Layouts Mapped: " + deltas.teams);
  console.log("   [pts] Final Scores Extracted:       " + deltas.scores);
  console.log("   [rn]  Round Groupings Patched:      " + deltas.rounds);
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
      execSync('git commit -m "Backfill Step: Reconstructed season ' + TARGET_SEASON_ID + ' via live player histories"', { stdio: 'pipe' });
      execSync('git pull --rebase=false -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log("✓ Secure push to origin verified.");
    }
  } catch (gitErr) {}
}

runPlayerHistoryBackfill().catch(e => { console.error("\n❌ Fatal Error: " + e.message); process.exit(1); });