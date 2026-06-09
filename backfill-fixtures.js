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
  
  // Resolve Target Season
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
  console.log("🚀 STARTING VERBOSE DIAGNOSTICS FOR SEASON: " + targetSeasonId);
  console.log("================================================================");

  const seasonMeta = reportData.report[targetSeasonId] || {};
  const seasonFilePath = path.join(GAMES_DIR, targetSeasonId + '.json');
  
  if (!fs.existsSync(seasonFilePath)) {
    console.log("❌ Season file missing on disk: " + seasonFilePath);
    delete reportData.report[targetSeasonId];
    fs.writeFileSync(MAIN_REPORT_PATH, JSON.stringify(reportData));
    return;
  }

  const seasonFileContents = JSON.parse(fs.readFileSync(seasonFilePath, 'utf8'));
  const teamIdsToScan = new Set();

  // Step 1: Scan Player file exactly via your known layout
  if (seasonMeta.anchorPlayerUuid) {
    const hexFolder = seasonMeta.anchorPlayerUuid.slice(0, 2).toLowerCase();
    const playerFilePath = path.join(PLAYERS_DIR, hexFolder, seasonMeta.anchorPlayerUuid + '.json');
    console.log("🔍 Checking player document: " + playerFilePath);

    if (fs.existsSync(playerFilePath)) {
      const playerData = JSON.parse(fs.readFileSync(playerFilePath, 'utf8'));
      const seasonsArray = playerData.seasons || [];
      for (const season of seasonsArray) {
        if (season.sid === targetSeasonId) {
          const registrations = season.regs || [];
          for (const reg of registrations) {
            if (reg.tid) teamIdsToScan.add(reg.tid);
          }
        }
      }
    } else {
      console.log("❌ Player file missing on disk.");
    }
  }

  // Step 2: Backup Local Games Pass
  for (const game of Object.values(seasonFileContents.games || {})) {
    if (game.h) teamIdsToScan.add(game.h);
    if (game.a) teamIdsToScan.add(game.a);
  }

  const teamList = Array.from(teamIdsToScan);
  console.log("📊 Unique Team IDs Extracted to Scan: " + teamList.length + " -> " + JSON.stringify(teamList));

  if (teamList.length === 0) {
    console.log("❌ No team references could be extracted. Skipping season.");
    delete reportData.report[targetSeasonId];
    fs.writeFileSync(MAIN_REPORT_PATH, JSON.stringify(reportData));
    return;
  }

  // Step 3: Authenticate Cookie Session Token
  const sessionRes = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID() }),
    body: JSON.stringify({ operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' })
  });
  const rawCookie = sessionRes.headers.get('set-cookie') || '';
  const match = rawCookie.match(/phq_session=([^;]+)/);
  if (!match) throw new Error("phq_session pattern missing from endpoint header token exchange.");
  const sessionToken = match[1];

  const deltas = { urls: 0, rounds: 0, teams: 0, venues: 0, totalGamesImpacted: new Set() };
  const fixtureQuery = "query TeamFixture($teamID: ID!) { discoverTeamFixture(teamID: $teamID) { name fixture { games { id status home { ... on DiscoverTeam { id name organisation { name } } } away { ... on DiscoverTeam { id name } } result { home { statistics { count type { value } } } away { ... } } allocation { dateTimeList { date time } court { id name venue { id name } } } grade { name season { name competition { name } } } } } }";

  // Step 4: Simple, Controlled Linear Queue Workers Loop Block
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

  console.log("\n📉 Backfill Delta Metrics Summary:");
  console.log("   Total Matches Restructured: " + deltas.totalGamesImpacted.size);
  console.log("   [url] Match URLs Discovered: " + deltas.urls);
  console.log("   [rn]  Round Names Patched:   " + deltas.rounds);
  console.log("   [h/a] Team Elements Unified: " + deltas.teams);
  console.log("   [loc] Venue Gaps Repaired:   " + deltas.venues);

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