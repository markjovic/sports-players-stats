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
const PLAYER_INDEX_DIR = path.join(__dirname, 'players', 'indexes');

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

async function getSessionCookie() {
  const payload = {
    operationName: 'TenantConfig',
    variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }'
  };
  
  const res = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID() }),
    body: JSON.stringify(payload)
  });
  
  const rawCookie = res.headers.get('set-cookie');
  if (!rawCookie) throw new Error("Failed to receive guest session token.");
  const match = rawCookie.match(/phq_session=([^;]+)/);
  if (!match) throw new Error("phq_session pattern missing inside header transport.");
  return match[1];
}

async function makeQuery(sessionToken, query, variables) {
  const res = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: Object.assign({}, HEADERS, {
      'request-id': crypto.randomUUID(),
      'Cookie': 'phq_session=' + sessionToken
    }),
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

async function processSingleSeason(targetSeasonId, seasonMeta, sessionToken, reportData) {
  console.log("\n🚀 Processing Season Container: " + targetSeasonId);
  const seasonFilePath = path.join(GAMES_DIR, targetSeasonId + '.json');
  
  if (!fs.existsSync(seasonFilePath)) {
    console.log("   ⚠️ Season file missing on disk. Removing from queue.");
    delete reportData.report[targetSeasonId];
    fs.writeFileSync(MAIN_REPORT_PATH, JSON.stringify(reportData));
    return;
  }

  const seasonFileContents = JSON.parse(fs.readFileSync(seasonFilePath, 'utf8'));
  const teamIdsToScan = new Set();

  if (seasonMeta?.anchorPlayerUuid) {
    const hexShard = seasonMeta.anchorPlayerUuid.slice(0, 2).toLowerCase();
    const shardPath = path.join(PLAYER_INDEX_DIR, hexShard + '.json');

    if (fs.existsSync(shardPath)) {
      try {
        const shardData = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
        const playerProfile = shardData[seasonMeta.anchorPlayerUuid];
        const playerGames = playerProfile?.games || {};
        
        for (const gData of Object.values(playerGames)) {
          if (gData.seasonId === targetSeasonId || gData.sid === targetSeasonId) {
            if (gData.h || gData.teamId) teamIdsToScan.add(gData.h || gData.teamId);
            if (gData.a) teamIdsToScan.add(gData.a);
          }
        }
      } catch (e) {
        console.log("   ⚠️ Player index shard parse error: " + e.message);
      }
    }
  }

  for (const game of Object.values(seasonFileContents.games || {})) {
    if (game.h) teamIdsToScan.add(game.h);
    if (game.a) teamIdsToScan.add(game.a);
  }

  const teamList = Array.from(teamIdsToScan);
  console.log("   Found " + teamList.length + " team references to resolve.");

  if (teamList.length === 0) {
    console.log("   No team targets found. Skipping season execution.");
    delete reportData.report[targetSeasonId];
    fs.writeFileSync(MAIN_REPORT_PATH, JSON.stringify(reportData));
    return;
  }

  // ─── INITIALIZE FIELD RECOVERY COUNTERS ───
  const deltas = { urls: 0, rounds: 0, teams: 0, venues: 0, totalGamesImpacted: new Set() };

  const fixtureQuery = "query TeamFixture($teamID: ID!) { discoverTeamFixture(teamID: $teamID) { name fixture { games { id status home { ... on DiscoverTeam { id name organisation { name } } } away { ... on DiscoverTeam { id name } } result { home { statistics { count type { value } } } away { ... } } allocation { dateTimeList { date time } court { id name venue { id name } } } grade { name season { name competition { name } } } } } } }";

  let index = 0;
  async function taskWorker() {
    while (index < teamList.length) {
      const currentTeamId = teamList[index++];
      try {
        const res = await makeQuery(sessionToken, fixtureQuery, { teamID: currentTeamId });
        const rounds = res.data?.discoverTeamFixture || [];
        
        for (const round of rounds) {
          const roundName = round.name;
          for (const apiGame of round.fixture?.games || []) {
            const gid = apiGame.id;
            
            if (seasonFileContents.games && seasonFileContents.games[gid]) {
              const localGame = seasonFileContents.games[gid];
              let gameWasUpdated = false;
              
              if (!localGame.rn && roundName) { localGame.rn = roundName; deltas.rounds++; gameWasUpdated = true; }
              if (!localGame.st && apiGame.status?.value) { localGame.st = apiGame.status.value; gameWasUpdated = true; }
              
              if (apiGame.home?.id && (!localGame.h || !localGame.hn)) { 
                localGame.h = apiGame.home.id; localGame.hn = apiGame.home.name; 
                deltas.teams++; gameWasUpdated = true; 
              }
              if (apiGame.away?.id && (!localGame.a || !localGame.an)) { 
                localGame.a = apiGame.away.id; localGame.an = apiGame.away.name; 
                deltas.teams++; gameWasUpdated = true; 
              }

              const alloc = apiGame.allocation;
              if (alloc) {
                if (alloc.dateTimeList && alloc.dateTimeList[0]) {
                  if (!localGame.d) { localGame.d = alloc.dateTimeList[0].date.slice(0, 10); gameWasUpdated = true; }
                  if (!localGame.t) { localGame.t = alloc.dateTimeList[0].time.slice(0, 5); deltas.venues++; gameWasUpdated = true; }
                }
                if (alloc.court) {
                  if (!localGame.ct) { localGame.ct = alloc.court.name; deltas.venues++; gameWasUpdated = true; }
                  if (alloc.court.venue) {
                    if (!localGame.vid) { localGame.vid = alloc.court.venue.id; gameWasUpdated = true; }
                    if (!localGame.vn) { localGame.vn = alloc.court.venue.name; deltas.venues++; gameWasUpdated = true; }
                  }
                }
              }

              if (!localGame.url && apiGame.home?.organisation?.name && apiGame.grade?.season?.competition?.name) {
                localGame.url = buildGameUrl(
                  gid,
                  apiGame.home.organisation.name,
                  apiGame.grade.season.competition.name,
                  apiGame.grade.season.name,
                  apiGame.grade.name
                );
                deltas.urls++;
                gameWasUpdated = true;
              }

              if (gameWasUpdated) {
                deltas.totalGamesImpacted.add(gid);
              }
            }
          }
        }
      } catch (err) {}
    }
  }

  const pool = Array(CONCURRENCY).fill(null).map(taskWorker);
  await Promise.all(pool);

  // ─── PRINT RECOVERY METRICS SUMMARY MATRIX ───
  console.log("   -------------------------------------------------------------");
  console.log("   📉 Backfill Delta Metrics Summary:");
  console.log("   -------------------------------------------------------------");
  console.log("   Total Matches Restructured: " + deltas.totalGamesImpacted.size.toLocaleString());
  console.log("   [url] Match URLs Discovered: " + deltas.urls.toLocaleString());
  console.log("   [rn]  Round Names Patched:   " + deltas.rounds.toLocaleString());
  console.log("   [h/a] Team Elements Unified: " + deltas.teams.toLocaleString());
  console.log("   [loc] Venue Gaps Repaired:   " + deltas.venues.toLocaleString());
  console.log("   -------------------------------------------------------------");

  // Write files out to current state layout immediately
  fs.writeFileSync(seasonFilePath, JSON.stringify(seasonFileContents, null, 2));
  
  delete reportData.report[targetSeasonId];
  reportData.totalGamesWithCoreOrVenueGaps = Object.values(reportData.report).reduce((acc, curr) => acc + curr.missingGamesCount, 0);
  fs.writeFileSync(MAIN_REPORT_PATH, JSON.stringify(reportData));
  
  console.log("   ✓ Saved changes. Remaining backlog size: " + Object.keys(reportData.report).length);

  try {
    execSync('git add ' + seasonFilePath + ' ' + MAIN_REPORT_PATH, { stdio: 'pipe' });
    const diffCheck = execSync('git diff --staged --name-only', { stdio: 'pipe' }).toString().trim();
    
    if (diffCheck) {
      execSync('git commit -m "Backfill Step: Processed season ' + targetSeasonId + '"', { stdio: 'pipe' });
      execSync('git pull --rebase=false -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log("   ✓ Secure push to origin verified.");
    }
  } catch (gitErr) {
    console.log("   ⚠️ Git step variation: " + gitErr.message);
  }
}

async function runBackfill() {
  if (!fs.existsSync(MAIN_REPORT_PATH)) {
    console.error("❌ Error: missing-game-data.json not found.");
    process.exit(1);
  }

  const reportData = JSON.parse(fs.readFileSync(MAIN_REPORT_PATH, 'utf8'));
  const sessionToken = await getSessionCookie();

  if (TARGET_SEASON_ID) {
    console.log("🎯 Running isolated test mode for season: " + TARGET_SEASON_ID);
    const seasonMeta = reportData.report[TARGET_SEASON_ID] || {};
    await processSingleSeason(TARGET_SEASON_ID, seasonMeta, sessionToken, reportData);
  } else {
    let seasonsWithGaps = Object.keys(reportData.report || {});
    console.log("📚 Running full backlog cycle mode. Initial size: " + seasonsWithGaps.length);
    
    while (seasonsWithGaps.length > 0) {
      const nextSeasonId = seasonsWithGaps[0];
      const seasonMeta = reportData.report[nextSeasonId];
      
      await processSingleSeason(nextSeasonId, seasonMeta, sessionToken, reportData);
      
      const refreshedReport = JSON.parse(fs.readFileSync(MAIN_REPORT_PATH, 'utf8'));
      seasonsWithGaps = Object.keys(refreshedReport.report || {});
    }
    console.log("🏁 Backlog successfully cleared.");
  }
}

runBackfill().catch(e => { console.error("\n❌ Fatal Operational Interruption: " + e.message); process.exit(1); });