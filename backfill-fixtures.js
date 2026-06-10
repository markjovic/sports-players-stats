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

  const reportData = JSON.parse(fs.readFileSync(MAIN_REPORT_PATH, 'utf8'));
  const reportQueue = reportData.report || {};
  
  let targetSeasonId = TARGET_SEASON_ID;
  if (!targetSeasonId) {
    const keys = Object.keys(reportQueue);
    if (keys.length === 0) {
      console.log("📚 Backlog manifest queue is empty. Task complete!");
      return;
    }
    targetSeasonId = keys[0];
  }

  console.log("\n================================================================");
  console.log("🚀 STARTING PRODUCTION PASS FOR SEASON: " + targetSeasonId);
  console.log("================================================================");

  const seasonFilePath = path.join(GAMES_DIR, targetSeasonId + '.json');
  if (!fs.existsSync(seasonFilePath)) {
    console.log("⚠️ Season JSON database file missing on disk. Skipping entry block.");
    delete reportQueue[targetSeasonId];
    fs.writeFileSync(MAIN_REPORT_PATH, JSON.stringify(reportData, null, 2));
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
    
    if (!localGameRecord) {
      console.log(`   ℹ️ Game ${gid} skipped: Not found in raw database file.`);
      continue;
    }

    // UPDATED GUARDRAIL: Only skip if explicitly marked legacy true. 
    // Non-legacy relative 'o' games are allowed through for recovery.
    if (localGameRecord.legacy === true) {
      console.log(`   ℹ️ Game ${gid} skipped: Explicitly marked as an unresolvable legacy record.`);
      continue;
    }

    gameIdsToRepair.add(gid);
    
    // Harvest any available absolute tokens
    if (localGameRecord.h && localGameRecord.h !== 0) teamIdsToScan.add(localGameRecord.h);
    if (localGameRecord.a && localGameRecord.a !== 0) teamIdsToScan.add(localGameRecord.a);
    if (localGameRecord.o && localGameRecord.o !== 0) teamIdsToScan.add(localGameRecord.o);
  }

  console.log(`📋 Total clean or restructurable matches targeted for backfill: ${gameIdsToRepair.size}`);
  if (gameIdsToRepair.size === 0) {
    console.log("ℹ️ No targetable rows left in this season's manifest block. Cleaning queue entry...");
    delete reportQueue[targetSeasonId];
    fs.writeFileSync(MAIN_REPORT_PATH, JSON.stringify(reportData, null, 2));
    return;
  }

  const activePlayerUuids = Object.keys(seasonFileContents.playerGames || {});
  console.log(`👥 Associated player profiles isolated for live history sweep: ${activePlayerUuids.length}`);

  // Authenticate session token cookie
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
    if (!localGame) return;

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
      localGame.url = buildGameUrl(gid, orgName, apiGame.grade.season.competition.name, apiGame.grade.season.name, apiGame