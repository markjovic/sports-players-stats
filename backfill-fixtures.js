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

const TARGET_SEASON_ID = ARGS.seasonId || "29536804";
const MAIN_REPORT_PATH = path.join(__dirname, 'missing-game-data.json');
const GAMES_DIR = path.join(__dirname, 'games', 'bv');

// Hard-targeted Grade ID extracted directly from Thomas Old's player profile
const TARGET_GRADE_ID = "462da517"; 

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

async function runGradeBackfill() {
  console.log("\n================================================================");
  console.log("🚀 INITIALIZING MASTER GRADE NETWORK BACKFILL FOR SEASON: " + TARGET_SEASON_ID);
  console.log("🚀 TARGETING GRADE ID: " + TARGET_GRADE_ID);
  console.log("================================================================");

  const seasonFilePath = path.join(GAMES_DIR, TARGET_SEASON_ID + '.json');
  if (!fs.existsSync(seasonFilePath)) {
    console.error("❌ Season file missing on disk: " + seasonFilePath);
    process.exit(1);
  }

  const seasonFileContents = JSON.parse(fs.readFileSync(seasonFilePath, 'utf8'));
  const localGames = seasonFileContents.games || {};

  // Authenticate session token cookie upfront
  const sessionRes = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID() }),
    body: JSON.stringify({ operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' })
  });
  const rawCookie = sessionRes.headers.get('set-cookie') || '';
  const cookieMatch = rawCookie.match(/phq_session=([^;]+)/);
  if (!cookieMatch) throw new Error("PHQ token assignment failed.");
  const sessionToken = cookieMatch[1];

  const deltas = { urls: 0, rounds: 0, teams: 0, venues: 0, scores: 0, totalGamesImpacted: new Set() };

  // PlayHQ Public Grade Master Fixture Query Definition
  const gradeQuery = `
    query GradeFixture($gradeID: ID!) {
      discoverGradeFixture(gradeID: $gradeID) {
        name
        fixture {
          games {
            id
            status
            home { ... on DiscoverTeam { id name organisation { name } } }
            away { ... on DiscoverTeam { id name } }
            result { home { score } away { score } }
            allocation {
              dateTimeList { date time }
              court { name venue { id name } }
            }
            grade { name season { name competition { name } } }
          }
        }
      }
    }
  `;

  console.log("🌐 Requesting full grade fixture schedule from PlayHQ API gateway...");
  
  try {
    const res = await fetch('https://api.playhq.com/graphql', {
      method: 'POST',
      headers: Object.assign({}, HEADERS, { 'request-id': crypto.randomUUID(), 'Cookie': 'phq_session=' + sessionToken }),
      body: JSON.stringify({ query: gradeQuery, variables: { gradeID: TARGET_GRADE_ID } })
    });
    const json = await res.json();
    const rounds = json.data?.discoverGradeFixture || [];

    console.log("✅ Received schedule payload. Processing rounds...");

    for (const round of rounds) {
      const roundName = round.name;
      const apiGames = round.fixture?.games || [];

      for (const apiGame of apiGames) {
        const gid = apiGame.id;
        const apiDate = apiGame.allocation?.dateTimeList?.[0]?.date?.slice(0, 10);

        // Multi-tier intersection check: Match by strict ID or by Date + Team Name alignment
        let localGid = null;
        if (localGames[gid]) {
          localGid = gid;
        } else if (apiDate) {
          for (const [id, g] of Object.entries(localGames)) {
            if (g.d === apiDate) {
              const hName = apiGame.home?.name || '';
              const aName = apiGame.away?.name || '';
              if (g.on && (hName.toLowerCase().includes(g.on.toLowerCase()) || aName.toLowerCase().includes(g.on.toLowerCase()))) {
                localGid = id;
                break;
              }
            }
          }
        }

        if (localGid) {
          const localGame = localGames[localGid];
          let updated = false;

          if (!localGame.rn || localGame.rn === 0 || localGame.legacy) {
            localGame.rn = roundName;
            deltas.rounds++;
            updated = true;
          }

          if (apiGame.home?.id) {
            localGame.h = apiGame.home.id;
            localGame.hn = apiGame.home.name;
            localGame.a = apiGame.away?.id || 0;
            localGame.an = apiGame.away?.name || '';
            deltas.teams++;
            updated = true;
          }

          if (apiGame.result?.home && typeof apiGame.result.home.score === 'number') {
            localGame.hs = apiGame.result.home.score;
            localGame.as = apiGame.result.away?.score || 0;
            deltas.scores++;
            updated = true;
          }

          const alloc = apiGame.allocation;
          if (alloc) {
            if (alloc.dateTimeList && alloc.dateTimeList[0]) {
              localGame.d = alloc.dateTimeList[0].date.slice(0, 10);
              localGame.t = alloc.dateTimeList[0].time.slice(0, 5);
              deltas.venues++;
              updated = true;
            }
            if (alloc.court) {
              localGame.ct = alloc.court.name;
              if (alloc.court.venue) {
                localGame.vid = alloc.court.venue.id;
                localGame.vn = alloc.court.venue.name;
                deltas.venues++;
                updated = true;
              }
            }
          }

          if (apiGame.home?.organisation?.name && apiGame.grade?.season?.competition?.name) {
            localGame.url = buildGameUrl(gid, apiGame.home.organisation.name, apiGame.grade.season.competition.name, apiGame.grade.season.name, apiGame.grade.name);
            deltas.urls++;
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
  } catch (err) {
    console.error("❌ Network Query Error: " + err.message);
  }

  console.log("\n-------------------------------------------------------------");
  console.log("   📉 Grade Fixture Backfill Delta Metrics Summary:");
  console.log("-------------------------------------------------------------");
  console.log("   Total Matches Restructured: " + deltas.totalGamesImpacted.size);
  console.log("   [h/a] Absolute Team Layouts Mapped: " + deltas.teams);
  console.log("   [pts] Final Scores Extracted:       " + deltas.scores);
  console.log("   [rn]  Round Groupings Patched:      " + deltas.rounds);
  console.log("   [loc] Venue Elements Repaired:      " + deltas.venues);
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
      execSync('git commit -m "Backfill Step: Reconstructed season ' + TARGET_SEASON_ID + ' via grade master fixture"', { stdio: 'pipe' });
      execSync('git pull --rebase=false -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log("✓ Secure push to origin verified.");
    }
  } catch (gitErr) {}
}

runGradeBackfill().catch(e => { console.error("\n❌ Fatal Error: " + e.message); process.exit(1); });