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
  console.log("\n================================================================");
  console.log("🚀 STARTING VERBOSE DIAGNOSTICS FOR SEASON: " + targetSeasonId);
  console.log("================================================================");
  
  console.log("📂 Meta metadata from manifest queue:");
  console.log(JSON.stringify(seasonMeta, null, 2));

  const seasonFilePath = path.join(GAMES_DIR, targetSeasonId + '.json');
  console.log("\n📝 Target Season File Path: " + seasonFilePath);
  
  if (!fs.existsSync(seasonFilePath)) {
    console.log("❌ CRITICAL: Season file missing on disk. Removing from queue manifest.");
    delete reportData.report[targetSeasonId];
    fs.writeFileSync(MAIN_REPORT_PATH, JSON.stringify(reportData));
    return;
  }

  const seasonFileContents = JSON.parse(fs.readFileSync(seasonFilePath, 'utf8'));
  const totalGamesInFile = Object.keys(seasonFileContents.games || {}).length;
  console.log("   ✓ Season file successfully parsed. Total raw game keys present: " + totalGamesInFile);

  const teamIdsToScan = new Set();

  // ─── STEP 1: VERBOSE GRANULAR PLAYER LOOKUP ───
  if (seasonMeta?.anchorPlayerUuid) {
    const hexFolder = seasonMeta.anchorPlayerUuid.slice(0, 2).toLowerCase();
    const playerFilePath = path.join(PLAYERS_DIR, hexFolder, seasonMeta.anchorPlayerUuid + '.json');
    console.log("\n🔍 Step 1: Evaluating Anchor Player Path Target...");
    console.log("   Calculated path: " + playerFilePath);

    if (fs.existsSync(playerFilePath)) {
      console.log("   ✅ Player file exists on disk. Parsing data content...");
      try {
        const playerData = JSON.parse(fs.readFileSync(playerFilePath, 'utf8'));
        console.log("   Player Name in File: " + (playerData.name || "Unknown"));
        
        const seasonsArray = playerData.seasons || [];
        console.log("   Total seasons listed in player profile: " + seasonsArray.length);
        
        for (const season of seasonsArray) {
          console.log(`     - Checking profile season entry [sid: ${season.sid}] vs target [${targetSeasonId}]`);
          if (season.sid === targetSeasonId) {
            console.log("       🎯 MATCH FOUND! Extracting registration sub-records...");
            const registrations = season.regs || [];
            console.log("       Total registrations in this season object: " + registrations.length);
            
            for (const reg of registrations) {
              console.log(`         * Found reg record: [tid: ${reg.tid}, tn: ${reg.tn}]`);
              if (reg.tid) {
                teamIdsToScan.add(reg.tid);
              } else {
                console.log("           ⚠️ Warning: entry is missing a 'tid' field.");
              }
            }
          }
        }
      } catch (e) {
        console.log("   ❌ ERROR parsing player document: " + e.message);
      }
    } else {
      console.log("   ❌ WARNING: Player file does not exist at that path.");
    }
  } else {
    console.log("\n⚠️ No anchorPlayerUuid string found inside the manifest metadata for this season row.");
  }

  // ─── STEP 2: VERBOSE SEASON FILE BACKUP SCAN ───
  console.log("\n🔍 Step 2: Scanning current season dictionary file for existing data strings...");
  let gamesWithH = 0;
  let gamesWithA = 0;
  
  for (const [gid, game] of Object.entries(seasonFileContents.games || {})) {
    if (game.h) { 
      teamIdsToScan.add(game.h); 
      gamesWithH++; 
    }
    if (game.a) { 
      teamIdsToScan.add(game.a); 
      gamesWithA++; 
    }
  }
  console.log(`   Scan complete. Matches with 'h' populated: ${gamesWithH}. Matches with 'a' populated: ${gamesWithA