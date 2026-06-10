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
const TARGET_SEASON_ID = ARGS.seasonId || "29536804";

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
  console.log("🚀 STARTING DIAGNOSTIC INSPECTION PASS FOR SEASON: " + TARGET_SEASON_ID);
  console.log("================================================================");

  const seasonFilePath = path.join(GAMES_DIR, TARGET_SEASON_ID + '.json');
  if (!fs.existsSync(seasonFilePath)) {
    console.error("❌ Season file missing on disk: " + seasonFilePath);
    process.exit(1);
  }

  const seasonFileContents = JSON.parse(fs.readFileSync(seasonFilePath, 'utf8'));
  const targetGames = seasonFileContents.games || {};
  const playerUuids = Object.keys(seasonFileContents.playerGames || {});
  console.log("👥 Extracted " + playerUuids.length + " player profiles to evaluate.");

  const sessionRes = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID() }),
    body: JSON.stringify({ operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' })
  });
  const rawCookie = sessionRes.headers.get('set-cookie') || '';
  const cookieMatch = rawCookie.match(/phq_session=([^;]+)/);
  if (!cookieMatch) throw new Error("PHQ token assignment failed.");
  const sessionToken = cookieMatch[1];

  let diagnosticDumped = false;
  const deltas = { urls: 0, rounds: 0, teams: 0, venues: 0, scores: 0, totalGamesImpacted: new Set() };
  
  const playerHistoryQuery = `
    query PlayerHistory($playerUUID: ID!) {
      discoverPlayerProfile(playerUUID: $playerUUID) {
        seasons {
          id
          name
          competition { name }
          matches {
            id
            round
            date
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
      try {
        const res = await fetch('https://api.playhq.com/graphql', {
          method: 'POST',
          headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID(), 'Cookie': 'phq_session=' + sessionToken }),
          body: JSON.stringify({ query: playerHistoryQuery, variables: { playerUUID: currentUuid } })
        });
        const json = await res.json();
        const seasons = json.data?.discoverPlayerProfile?.seasons || [];

        // ─── DIAGNOSTIC MATRIX DUMP ───
        // Capture the very first player response that contains data and dump it completely to the logs
        if (!diagnosticDumped && seasons.length > 0) {
          diagnosticDumped = true;
          console.log("\n🔍 [DIAGNOSTIC INSPECTION] Raw GraphQL Response Payload for Player " + currentUuid + ":");
          console.log(JSON.stringify(seasons.slice(0, 2), null, 2));
          console.log("----------------------------------------------------------------\n");
        }

        for (const season of seasons) {
          for (const apiMatch of season.matches || []) {
            const gid = apiMatch.id;
            const isHome = apiMatch.homeAway === 'HOME' || apiMatch.homeAway === 'home';
            const apiDateClean = apiMatch.date ? apiMatch.date.slice(0, 10) : null;

            const homeName = (isHome ? apiMatch.team?.name : apiMatch.opponent?.name) || '';
            const awayName = (isHome ? apiMatch.opponent?.name : apiMatch.team?.name) || '';

            let localGid = null;
            if (targetGames[gid]) {
              localGid = gid;
            } else {
              for (const [id, g] of Object.entries(targetGames)) {
                if (g.d && apiDateClean && g.d !== apiDateClean) continue; 

                const idMatches = (g.o && (g.o === apiMatch.opponent?.id || g.o === apiMatch.team?.id));
                const nameMatches = g.on && (
                  homeName.toLowerCase().includes(g.on.toLowerCase()) || 
                  awayName.toLowerCase().includes(g.on.toLowerCase()) ||
                  g.on.toLowerCase().includes(homeName.toLowerCase()) ||
                  g.on.toLowerCase().includes(awayName.toLowerCase())
                );

                if ((idMatches || nameMatches) && (g.legacy || !g.h || g.h === 0)) {
                  localGid = id;
                  break;
                }
              }
            }

            if (localGid) {
              const localGame = targetGames[localGid];
              let updated = false;

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
                delete localGame.o;
                delete localGame.on;
                delete localGame.legacy;
                deltas.totalGamesImpacted.add(localGid);
              }
            }
          }
        }
      } catch (err) {}
    }
  });

  await Promise.all(workers);

  console.log("\n-------------------------------------------------------------");
  console.log("   📉 Diagnostic Pass Execution Summary:");
  console.log("-------------------------------------------------------------");
  console.log("   Total Matches Restructured: " + deltas.totalGamesImpacted.size);
  console.log("   [h/a] Absolute Team Layouts Mapped: " + deltas.teams);
  console.log("   [pts] Final Scores Extracted:       " + deltas.scores);
  console.log("   [rn]  Round Groupings Patched:      " + deltas.rounds);
  console.log("-------------------------------------------------------------");

  fs.writeFileSync(seasonFilePath, JSON.stringify(seasonFileContents, null, 2));
}

runPlayerHistoryBackfill().catch(e => { console.error("\n❌ Fatal Error: " + e.message); process.exit(1); });