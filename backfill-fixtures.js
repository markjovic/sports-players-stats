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

const CONCURRENCY = parseInt(ARGS.concurrency || '5', 10);
const TARGET_SEASON_ID = ARGS.seasonId || null;

const MAIN_REPORT_PATH = path.join(__dirname, 'missing-game-data.json');
const GAMES_DIR = path.join(__dirname, 'games', 'bv');

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

async function runCleanBackfill() {
  if (!fs.existsSync(MAIN_REPORT_PATH)) {
    console.error("❌ Error: missing-game-data.json not found.");
    process.exit(1);
  }

  // We only READ the manifest to grab a season ID to work on
  const reportData = JSON.parse(fs.readFileSync(MAIN_REPORT_PATH, 'utf8'));
  const reportQueue = reportData.report || {};
  
  let targetSeasonId = TARGET_SEASON_ID;
  if (!targetSeasonId) {
    const keys = Object.keys(reportQueue);
    if (keys.length === 0) {
      console.log("📚 Backlog manifest queue is empty. Task complete!");
      return;
    }
    // Grabs the next season in line
    targetSeasonId = keys[0];
  }

  console.log("\n================================================================");
  console.log("🚀 STARTING BACKFILL PASS FOR SEASON: " + targetSeasonId);
  console.log("================================================================");

  const seasonFilePath = path.join(GAMES_DIR, targetSeasonId + '.json');
  if (!fs.existsSync(seasonFilePath)) {
    console.log(`⚠️ Season JSON file missing on disk: ${seasonFilePath}. Moving on.`);
    return;
  }

  const seasonFileContents = JSON.parse(fs.readFileSync(seasonFilePath, 'utf8'));
  const localGamesDict = seasonFileContents.games || {};
  
  const manifestSeasonBlock = reportQueue[targetSeasonId] || {};
  const manifestGamesTracking = manifestSeasonBlock.games || {};
  
  const gameIdsToRepair = new Set();
  const teamIdsToScan = new Set();

  for (const gid of Object.keys(manifestGamesTracking)) {
    const localGameRecord = localGamesDict[gid];
    
    if (!localGameRecord) continue;

    // Skip if explicitly marked legacy true
    if (localGameRecord.legacy === true) {
      continue;
    }

    gameIdsToRepair.add(gid);
    
    if (localGameRecord.h && localGameRecord.h !== 0) teamIdsToScan.add(localGameRecord.h);
    if (localGameRecord.a && localGameRecord.a !== 0) teamIdsToScan.add(localGameRecord.a);
    if (localGameRecord.o && localGameRecord.o !== 0) teamIdsToScan.add(localGameRecord.o);
  }

  console.log(`📋 Targeted restructurable matches in this season file: ${gameIdsToRepair.size}`);
  if (gameIdsToRepair.size === 0) {
    console.log("ℹ️ No targetable clean rows found in this season block.");
    return;
  }

  const activePlayerUuids = Object.keys(seasonFileContents.playerGames || {});
  console.log(`👥 Isolated player profiles for live history sweep: ${activePlayerUuids.length}`);

  // Authenticate session token
  const sessionRes = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID() }),
    body: JSON.stringify({ operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' })
  });
  const rawCookie = sessionRes.headers.get('set-cookie') || '';
  const cookieMatch = rawCookie.match(/phq_session=([^;]+)/);
  if (!cookieMatch) throw new Error("GraphQL session authentication cookies missing.");
  const sessionToken = cookieMatch[1];

  const deltas = { urls: 0, rounds: 0, teams: 0, venues: 0, scores: 0, totalGamesImpacted: new Set() };

  function patchLocalRecord(gid, apiGame, roundName) {
    const localGame = localGamesDict[gid];
    if (!localGame) {
       console.log(`      ⚠️ ID Mismatch: Found ${gid} in API but not in local file.`);
       return;
    }
    
    // DEBUG: Print the fields we are comparing
    console.log(`      🔍 Comparing local game ${gid} (Date: ${localGame.d}) with API game (Date: ${apiGame.allocation?.dateTimeList?.[0]?.date})`);

    let updated = false;
    const isHome = apiGame.homeAway ? (apiGame.homeAway === 'HOME' || apiGame.homeAway === 'home') : true;

    if (!localGame.rn || localGame.rn === 0) { localGame.rn = roundName; deltas.rounds++; updated = true; }
    if (!localGame.st || localGame.st === 0) { localGame.st = apiGame.status?.value || 'FINAL'; updated = true; }

    const homeId = isHome ? (apiGame.team?.id || apiGame.home?.id) : (apiGame.opponent?.id || apiGame.away?.id);
    const homeName = isHome ? (apiGame.team?.name || apiGame.home?.name) : (apiGame.opponent?.name || apiGame.away?.name);
    const awayId = isHome ? (apiGame.opponent?.id || apiGame.away?.id) : (apiGame.team?.id || apiGame.home?.id);
    const awayName = isHome ? (apiGame.opponent?.name || apiGame.away?.name) : (apiGame.team?.name || apiGame.home?.name);

    if (homeId && (!localGame.h || localGame.h === 0)) { localGame.h = homeId; localGame.hn = homeName; deltas.teams++; updated = true; }
    if (awayId && (!localGame.a || localGame.a === 0)) { localGame.a = awayId; localGame.an = awayName; deltas.teams++; updated = true; }

    let hsScore = null, asScore = null;
    if (typeof apiGame.result?.teamScore === 'number') {
      hsScore = isHome ? apiGame.result.teamScore : apiGame.result.opponentScore;
      asScore = isHome ? apiGame.result.opponentScore : apiGame.result.teamScore;
    } else if (typeof apiGame.result?.home?.score === 'number') {
      hsScore = apiGame.result.home.score;
      asScore = apiGame.result.away?.score || 0;
    }

    if (hsScore !== null && (localGame.hs === 0 || localGame.hs === undefined)) {
      localGame.hs = hsScore;
      localGame.as = asScore;
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

    const orgName = apiGame.home?.organisation?.name || apiGame.grade?.season?.competition?.name;
    if ((!localGame.url || localGame.url === 0) && orgName && apiGame.grade?.name) {
      localGame.url = buildGameUrl(gid, orgName, apiGame.grade.season.competition.name, apiGame.grade.season.name, apiGame.grade.name);
      deltas.urls++;
      updated = true;
    }

    if (updated) {
      delete localGame.o;
      delete localGame.on;
      deltas.totalGamesImpacted.add(gid);
      console.log(`      ✅ Game patched successfully: ID ${gid}`);
    }
  }

  // PASS 1: Live Player Profile Query Sweep
  if (activePlayerUuids.length > 0) {
    console.log("\n🌐 [PASS 1] Executing Network Player Career History Inspection Loop...");
    const playerQuery = `query PlayerHistory($playerUUID: ID!) { discoverPlayerProfile(playerUUID: $playerUUID) { seasons { matches { id round homeAway team { id name } opponent { id name } result { teamScore opponentScore } } } } }`;
    
    let pIdx = 0;
    const playerWorkers = Array(CONCURRENCY).fill(null).map(async () => {
      while (pIdx < activePlayerUuids.length) {
        const uuid = activePlayerUuids[pIdx++];
        try {
          const res = await fetch('https://api.playhq.com/graphql', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID(), 'Cookie': 'phq_session=' + sessionToken }),
            body: JSON.stringify({ query: playerQuery, variables: { playerUUID: uuid } })
          });
          const json = await res.json();
          const seasons = json.data?.discoverPlayerProfile?.seasons || [];

          for (const s of seasons) {
            for (const match of s.matches || []) {
              if (gameIdsToRepair.has(match.id)) {
                patchLocalRecord(match.id, match, match.round);
              }
            }
          }
        } catch (e) {}
      }
    });
    await Promise.all(playerWorkers);
  }

  for (const gid of deltas.totalGamesImpacted) {
    gameIdsToRepair.delete(gid);
  }

  // PASS 2: Team Fixture Query Sweep Fallback
  const teamList = Array.from(teamIdsToScan);
  if (gameIdsToRepair.size > 0 && teamList.length > 0) {
    console.log(`\n🌐 [PASS 2] ${gameIdsToRepair.size} games still open. Fallback to Team Fixture Endpoint queries...`);
    const fixtureQuery = `query TeamFixture($teamID: ID!) { discoverTeamFixture(teamID: $teamID) { name fixture { games { id status home { ... on DiscoverTeam { id name organisation { name } } } away { ... on DiscoverTeam { id name } } result { home { score } away { score } } allocation { dateTimeList { date time } court { id name venue { id name } } } grade { name season { name competition { name } } } } } }`;
    
    let tIdx = 0;
    const teamWorkers = Array(CONCURRENCY).fill(null).map(async () => {
      while (tIdx < teamList.length) {
        const tid = teamList[tIdx++];
        try {
          const res = await fetch('https://api.playhq.com/graphql', {
            method: 'POST',
            headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID(), 'Cookie': 'phq_session=' + sessionToken }),
            body: JSON.stringify({ query: fixtureQuery, variables: { teamID: tid } })
          });
          const json = await res.json();
          const rounds = json.data?.discoverTeamFixture || [];

          for (const round of rounds) {
            for (const apiGame of round.fixture?.games || []) {
              if (gameIdsToRepair.has(apiGame.id)) {
                patchLocalRecord(apiGame.id, apiGame, round.name);
              }
            }
          }
        } catch (e) {}
      }
    });
    await Promise.all(teamWorkers);
  }

  console.log("\n-------------------------------------------------------------");
  console.log("📉 Clean Backfill Execution Results Summary:");
  console.log("-------------------------------------------------------------");
  console.log(`   Total Non-Legacy Matches Modified: ${deltas.totalGamesImpacted.size}`);
  console.log(`   [url] Match Web Links Saved:      ${deltas.urls}`);
  console.log(`   [rn]  Round Context Fields Filled:  ${deltas.rounds}`);
  console.log(`   [h/a] Core Team Elements Unified:  ${deltas.teams}`);
  console.log(`   [loc] Court & Venue Details Fixed: ${deltas.venues}`);
  console.log(`   [pts] Match Final Scores Restored: ${deltas.scores}`);
  console.log("-------------------------------------------------------------");

  // Save changes ONLY to the targeted season file
  fs.writeFileSync(seasonFilePath, JSON.stringify(seasonFileContents, null, 2));
  console.log(`💾 Saved updates to database file: ${seasonFilePath}`);

  // Git commit and push ONLY the specific season file
  try {
    execSync(`git add ${seasonFilePath}`, { stdio: 'pipe' });
    if (execSync('git diff --staged --name-only', { stdio: 'pipe' }).toString().trim()) {
      execSync(`git commit -m "Backfill Pass: Populated metrics for season ${targetSeasonId}"`, { stdio: 'pipe' });
      execSync('git pull --rebase=false -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log("✓ Secure sync to origin verified.");
    } else {
      console.log("ℹ️ No file changes generated during this execution window.");
    }
  } catch (gitErr) {
    console.log("⚠️ Git sync skipped/failed: " + gitErr.message);
  }
}

runCleanBackfill().catch(e => { console.error("\n❌ Fatal Error: " + e.message); process.exit(1); });
