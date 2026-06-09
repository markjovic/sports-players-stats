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
const TARGET_SEASON_ID = ARGS.seasonId || null;

const MAIN_REPORT_PATH = path.join(__dirname, 'missing-game-data.json');
const GAMES_DIR = path.join(__dirname, 'games', 'bv');
const PLAYERS_DIR = path.join(__dirname, 'players');

const HEADERS = {
  'accept': '*/*',
  'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria',
  'content-type': 'application/json'
};

function slugify(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[()]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
}

function buildGameUrl(gameId, orgName, compName, seasonName, gradeName) {
  return "https://www.playhq.com/basketball-victoria/org/" + 
    slugify(orgName) + "/" + 
    slugify(compName + " " + seasonName) + "/" + 
    slugify(gradeName) + "/game-centre/" + gameId;
}

async function runBackfill() {
  if (!fs.existsSync(MAIN_REPORT_PATH)) {
    console.error("❌ Error: missing-game-data.json not found.");
    process.exit(1);
  }

  const reportData = JSON.parse(fs.readFileSync(MAIN_REPORT_PATH, 'utf8'));
  
  let targetSeasonId = TARGET_SEASON_ID;
  if (!targetSeasonId) {
    const keys = Object.keys(reportData.report || {});
    if (keys.length === 0) {
      console.log("📚 Queue is empty. Backfill complete.");
      return;
    }
    targetSeasonId = keys[0];
  }

  console.log("\n================================================================");
  console.log("🚀 STARTING SELF-AUDITING BACKFILL FOR SEASON: " + targetSeasonId);
  console.log("================================================================");

  const seasonMeta = reportData.report[targetSeasonId] || {};
  console.log("📋 Manifest Metadata Keys found for this season in missing-game-data.json:");
  console.log(JSON.stringify(Object.keys(seasonMeta)));
  console.log("📋 Values content: " + JSON.stringify(seasonMeta));

  const seasonFilePath = path.join(GAMES_DIR, targetSeasonId + '.json');
  if (!fs.existsSync(seasonFilePath)) {
    console.log("❌ Season file missing on disk: " + seasonFilePath);
    delete reportData.report[targetSeasonId];
    fs.writeFileSync(MAIN_REPORT_PATH, JSON.stringify(reportData));
    return;
  }

  const seasonFileContents = JSON.parse(fs.readFileSync(seasonFilePath, 'utf8'));
  
  // Print a sample game layout to see what fields actually exist
  const gameKeys = Object.keys(seasonFileContents.games || {});
  console.log("\n🎮 Total game rows inside season file: " + gameKeys.length);
  if (gameKeys.length > 0) {
    console.log("🎮 Sample Layout of First Game Record (" + gameKeys[0] + "):");
    console.log(JSON.stringify(seasonFileContents.games[gameKeys[0]], null, 2));
  }

  // Extract all player mapping IDs directly from inside the season file
  const localPlayerUuuids = Object.keys(seasonFileContents.playerGames || {});
  console.log("\n👥 Total Player UUIDs mapped inside this season file's 'playerGames' block: " + localPlayerUuuids.length);
  console.log("👥 Top Mapped Player UUIDs: " + JSON.stringify(localPlayerUuuids.slice(0, 10)));

  // Fallback to determine anchor ID from manifest or local file block
  const anchorId = seasonMeta.anchorPlayerUuid || localPlayerUuuids[0] || null;
  console.log("\n🎯 Selected Anchor Player UUID for Extraction: " + anchorId);

  const teamIdsToScan = new Set();
  const deltas = { urls: 0, rounds: 0, teams: 0, venues: 0, scores: 0, totalGamesImpacted: new Set() };

  // Step 1: Local Player file inspection pass
  if (anchorId) {
    const hexFolder = anchorId.slice(0, 2).toLowerCase();
    const playerFilePath = path.join(PLAYERS_DIR, hexFolder, anchorId + '.json');
    console.log("🔍 Checking calculated player document path: " + playerFilePath);

    if (fs.existsSync(playerFilePath)) {
      console.log("   ✅ Target player file exists. Scraping match history...");
      const playerData = JSON.parse(fs.readFileSync(playerFilePath, 'utf8'));
      
      const seasonsArray = playerData.seasons || [];
      for (const s of seasonsArray) {
        if (s.sid === targetSeasonId) {
          const registrations = s.regs || [];
          for (const reg of registrations) {
            if (reg.tid) teamIdsToScan.add(reg.tid);
          }
        }
      }

      const playerGamesBlock = playerData.games || {};
      for (const [gid, pGame] of Object.entries(playerGamesBlock)) {
        if (seasonFileContents.games && seasonFileContents.games[gid]) {
          const localGame = seasonFileContents.games[gid];
          let localUpdated = false;

          if ((localGame.hs === 0 || localGame.hs === undefined) && typeof pGame.teamScore === 'number') {
            const isHome = pGame.isHome || pGame.homeAway === 'HOME';
            localGame.hs = isHome ? pGame.teamScore : (pGame.oppScore || 0);
            localGame.as = isHome ? (pGame.oppScore || 0) : pGame.teamScore;
            deltas.scores++;
            localUpdated = true;
          }

          if ((localGame.hn === 0 || !localGame.hn) && pGame.teamName) {
            const isHome = pGame.isHome || pGame.homeAway === 'HOME';
            localGame.hn = isHome ? pGame.teamName : (pGame.oppName || '');
            localGame.an = isHome ? (pGame.oppName || '') : pGame.teamName;
            if (pGame.teamId) {
              localGame.h = isHome ? pGame.teamId : 0;
              localGame.a = isHome ? 0 : pGame.teamId;
            }
            deltas.teams++;
            localUpdated = true;
          }

          if ((localGame.rn === 0 || !localGame.rn) && pGame.round) {
            localGame.rn = pGame.round;
            deltas.rounds++;
            localUpdated = true;
          }

          if (localUpdated) deltas.totalGamesImpacted.add(gid);
        }
      }
    } else {
      console.log("   ❌ Target player file does not exist at that location.");
    }
  }

  // Harvest any explicitly set team tokens from remaining valid entries
  for (const game of Object.values(seasonFileContents.games || {})) {
    if (game.h && game.h !== 0) teamIdsToScan.add(game.h);
    if (game.a && game.a !== 0) teamIdsToScan.add(game.a);
  }

  const teamList = Array.from(teamIdsToScan);
  console.log("📊 Total Team Targets compiled for API Scraper: " + teamList.length + " -> " + JSON.stringify(teamList));

  if (teamList.length === 0) {
    console.log("❌ No team references could be extracted. Exiting to prevent dead network loops.");
    delete reportData.report[targetSeasonId];
    fs.writeFileSync(MAIN_REPORT_PATH, JSON.stringify(reportData));
    return;
  }

  // Setup Network authentication mapping components
  const sessionRes = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID() }),
    body: JSON.stringify({ operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' })
  });
  const rawCookie = sessionRes.headers.get('set-cookie') || '';
  const cookieMatch = rawCookie.match(/phq_session=([^;]+)/);
  if (!cookieMatch) throw new Error("phq_session authentication challenge token missing.");
  const sessionToken = cookieMatch[1];

  const fixtureQuery = "query TeamFixture($teamID: ID!) { discoverTeamFixture(teamID: $teamID) { name fixture { games { id status home { ... on DiscoverTeam { id name organisation { name } } } away { ... on DiscoverTeam { id name } } result { home { score } away { score } } allocation { dateTimeList { date time } court { id name venue { id name } } } grade { name season { name competition { name } } } } } }";
  let index = 0;

  const workers = Array(CONCURRENCY).fill(null).map(async () => {
    while (index < teamList.length) {
      const currentTeamId = teamList[index++];
      try {
        const res = await fetch('https://api.playhq.com/graphql', {
          method: 'POST',
          headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID(), 'Cookie': 'phq_session=' + sessionToken }),
          body: JSON.stringify({ query: fixtureQuery, variables: { teamID: currentTeamId } })
        });
        const json = await res.json();
        const rounds = json.data?.discoverTeamFixture || [];

        for (const round of rounds) {
          const roundName = round.name;
          for (const apiGame of round.fixture?.games || []) {
            const gid = apiGame.id;
            if (seasonFileContents.games && seasonFileContents.games[gid]) {
              const localGame = seasonFileContents.games[gid];
              let updated = false;

              if ((localGame.rn === 0 || !localGame.rn) && roundName) { localGame.rn = roundName; deltas.rounds++; updated = true; }
              if ((localGame.st === 0 || !localGame.st) && apiGame.status?.value) { localGame.st = apiGame.status.value; updated = true; }
              if (apiGame.home?.id && (!localGame.h || localGame.h === 0)) { localGame.h = apiGame.home.id; localGame.hn = apiGame.home.name; deltas.teams++; updated = true; }
              if (apiGame.away?.id && (!localGame.a || localGame.a === 0)) { localGame.a = apiGame.away.id; localGame.an = apiGame.away.name; deltas.teams++; updated = true; }

              if ((localGame.hs === 0 || localGame.hs === undefined) && typeof apiGame.result?.home?.score === 'number') {
                localGame.hs = apiGame.result.home.score;
                localGame.as = apiGame.result.away?.score || 0;
                deltas.scores++;
                updated = true;
              }

              const alloc = apiGame.allocation;
              if (alloc) {
                if (alloc.dateTimeList && alloc.dateTimeList[0]) {
                  if (!localGame.d || localGame.d === 0) { localGame.d = alloc.dateTimeList[0].date.slice(0, 10); updated = true; }
                  if (!localGame.t || localGame.t === 0) { localGame.t = alloc.dateTimeList[0].time.slice(0, 5); deltas.venues++; updated = true; }
                }
                if (alloc.court) {
                  if (!localGame.ct || localGame.ct === 0) { localGame.ct = alloc.court.name; deltas.venues++; updated = true; }
                  if (alloc.court.venue) {
                    if (!localGame.vid || localGame.vid === 0) { localGame.vid = alloc.court.venue.id; updated = true; }
                    if (!localGame.vn || localGame.vn === 0) { localGame.vn = alloc.court.venue.name; deltas.venues++; updated = true; }
                  }
                }
              }

              if ((localGame.url === 0 || !localGame.url) && apiGame.home?.organisation?.name && apiGame.grade?.season?.competition?.name) {
                localGame.url = buildGameUrl(gid, apiGame.home.organisation.name, apiGame.grade.season.competition.name, apiGame.grade.season.name, apiGame.grade.name);
                deltas.urls++;
                updated = true;
              }

              if (updated) deltas.totalGamesImpacted.add(gid);
            }
          }
        }
      } catch (err) {}
    }
  });

  await Promise.all(workers);

  console.log("\n-------------------------------------------------------------");
  console.log("   📉 Backfill Delta Metrics Summary:");
  console.log("-------------------------------------------------------------");
  console.log("   Total Matches Restructured: " + deltas.totalGamesImpacted.size);
  console.log("   [url] Match URLs Discovered: " + deltas.urls);
  console.log("   [rn]  Round Names Patched:   " + deltas.rounds);
  console.log("   [h/a] Team Elements Unified: " + deltas.teams);
  console.log("   [loc] Venue Gaps Repaired:   " + deltas.venues);
  console.log("   [pts] Final Scores Recovered: " + deltas.scores);
  console.log("-------------------------------------------------------------");

  fs.writeFileSync(seasonFilePath, JSON.stringify(seasonFileContents, null, 2));
  
  delete reportData.report[targetSeasonId];
  reportData.totalGamesWithCoreOrVenueGaps = Object.values(reportData.report).reduce((acc, curr) => acc + (curr.missingGamesCount || 0), 0);
  fs.writeFileSync(MAIN_REPORT_PATH, JSON.stringify(reportData));
  
  console.log("✓ Saved changes. Remaining backlog size: " + Object.keys(reportData.report).length);

  try {
    execSync('git add ' + seasonFilePath + ' ' + MAIN_REPORT_PATH, { stdio: 'pipe' });
    if (execSync('git diff --staged --name-only', { stdio: 'pipe' }).toString().trim()) {
      execSync('git commit -m "Backfill Step: Processed season ' + targetSeasonId + '"', { stdio: 'pipe' });
      execSync('git pull --rebase=false -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log("✓ Secure push to origin verified.");
    }
  } catch (gitErr) {}
}

runBackfill().catch(e => { console.error("\n❌ Fatal Error: " + e.message); process.exit(1); });