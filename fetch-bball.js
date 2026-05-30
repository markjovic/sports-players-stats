#!/usr/bin/env node
/**
 * fetch-bball.js — Basketball player scraper for PlayHQ GraphQL API
 *
 * MODES:
 *   node fetch-bball.js --mode=crawl --season=<id>   # add a new season, discover its players
 *   node fetch-bball.js --mode=update                # re-fetch all active (unlocked) seasons
 *   node fetch-bball.js --mode=lock --season=<id>    # mark a season as historical (no further updates)
 *   node fetch-bball.js --mode=discover              # just enumerate grades/players, no profile fetch
 *
 * OUTPUT FILES:
 *   bball-data.json       — main data store (players, seasons, comps)
 *   bball-progress.json   — resume state (survives interruptions)
 *
 * TENANT: bv (Basketball Victoria) — change TENANT constant if targeting another org
 *
 * STAT FIELD DISCOVERY:
 *   On first run, unknown stat field names are logged to console with [UNKNOWN STAT].
 *   Update STAT_FIELDS map below once you see what the API actually returns.
 */

const fs   = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const TENANT         = 'bv';               // Basketball Victoria — change if needed
const API_URL        = 'https://api.playhq.com/graphql';
const DELAY_MS       = 400;               // ms between API requests (be polite)
const DATA_FILE      = path.join(__dirname, 'bball-data.json');
const PROGRESS_FILE  = path.join(__dirname, 'bball-progress.json');
const PAGE_SIZE      = 50;               // max players per page from gradePlayerStatistics

/**
 * Known basketball stat field names from the PlayHQ API.
 * On first run these will be discovered and logged — update this map from the logs.
 * Keys = API value strings, values = our internal field names.
 *
 * AFL equivalents for reference: APPEARANCE, GOAL_COUNT, BEST_PLAYER
 * Basketball likely uses something like: APPEARANCE, POINT_COUNT, FOUL_COUNT,
 * FIELD_GOAL, FIELD_GOAL_ATTEMPT, THREE_POINT, THREE_POINT_ATTEMPT,
 * FREE_THROW, FREE_THROW_ATTEMPT, etc.
 */
const STAT_FIELDS = {
  // Populated from logs after first discovery run.
  // Format: 'API_VALUE_STRING': 'ourFieldName'
  // e.g. 'APPEARANCE':          'gp',
  //      'POINT_COUNT':         'pts',
  //      'FOUL_COUNT':          'fouls',
  //      'FIELD_GOAL':          'fg',
  //      'FIELD_GOAL_ATTEMPT':  'fga',
  //      'THREE_POINT':         'threePt',
  //      'THREE_POINT_ATTEMPT': 'threePtA',
  //      'FREE_THROW':          'ft',
  //      'FREE_THROW_ATTEMPT':  'ftA',
};

// ─── GraphQL Queries ──────────────────────────────────────────────────────────

const Q_SEASON = `
query gradeListDiscoverSeason($id: ID!) {
  discoverSeason(seasonID: $id) {
    id
    name
    competition {
      id
      name
      type
      organisation { id name }
    }
    grades {
      id
      name
      age { name }
      gender { name }
    }
  }
}`;

const Q_PLAYERS = `
query publicGradeStatistics($gradeID: ID!, $filter: GradePlayerStatisticsFilter) {
  gradePlayerStatistics(gradeID: $gradeID, filter: $filter) {
    meta { page totalPages totalRecords }
    results {
      profile { id firstName lastName }
      team { name }
      statistics {
        count
        details { value }
      }
    }
  }
}`;

const Q_PROFILE = `
query publicProfileStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      name
      statistics {
        season { id name }
        club { id name }
        totalStatistics {
          count
          details { value }
        }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          gradeStatistics {
            grade { id name }
            totalStatistics { count details { value } }
            gameStatistics {
              game {
                id
                round { name }
                date
                home { ... on DiscoverTeam { id name } }
                away { ... on DiscoverTeam { id name } }
              }
              statistics { count details { value } }
            }
          }
        }
      }
    }
  }
  publicProfile(profileID: $profileID) {
    id firstName lastName
  }
}`;

// ─── API helpers ──────────────────────────────────────────────────────────────

async function gql(operationName, query, variables) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'tenant':       TENANT,
      'origin':       'https://www.playhq.com',
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${operationName}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL error in ${operationName}: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Stat parsing ─────────────────────────────────────────────────────────────

const _unknownStatsSeen = new Set();

function parseStats(statisticsArray) {
  // statisticsArray = [ { count, details: { value } }, ... ]
  // OR it might be a single object depending on API shape — handle both
  const arr = Array.isArray(statisticsArray) ? statisticsArray : [statisticsArray];
  const out = {};
  for (const s of arr) {
    const key = s?.details?.value;
    if (!key) continue;
    if (STAT_FIELDS[key]) {
      out[STAT_FIELDS[key]] = s.count;
    } else {
      if (!_unknownStatsSeen.has(key)) {
        console.log(`[UNKNOWN STAT] API returned stat field: "${key}" (count: ${s.count})`);
        console.log(`  → Add to STAT_FIELDS map: '${key}': 'yourFieldName'`);
        _unknownStatsSeen.add(key);
      }
      // Store raw anyway so we don't lose data
      out[`_raw_${key}`] = s.count;
    }
  }
  return out;
}

// ─── Data file helpers ────────────────────────────────────────────────────────

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch (e) { console.warn('⚠ Could not parse bball-data.json, starting fresh'); }
  }
  return {
    players:  {},  // uuid → player record
    seasons:  {},  // seasonId → season metadata
    lastFetch: null,
  };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
    catch (e) {}
  }
  return { pendingUuids: [], doneUuids: [], seasonsDone: [] };
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function clearProgress() {
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
}

// ─── Phase 1: Enumerate all players in a season ───────────────────────────────

async function discoverSeasonPlayers(seasonId, data) {
  console.log(`\n📋 Discovering season ${seasonId}...`);
  await delay(DELAY_MS);

  const seasonData = await gql('gradeListDiscoverSeason', Q_SEASON, { id: seasonId });
  const season = seasonData.discoverSeason;
  if (!season) throw new Error(`Season ${seasonId} not found`);

  const orgName  = season.competition?.organisation?.name || 'Unknown Org';
  const compName = season.competition?.name || 'Unknown Comp';
  const fullName = `${compName} — ${season.name}`;  // e.g. "Junior Domestic — Winter 2026"

  console.log(`  Organisation: ${orgName}`);
  console.log(`  Competition:  ${compName}`);
  console.log(`  Season:       ${season.name}`);
  console.log(`  Grades:       ${season.grades.length}`);

  // Store season metadata
  if (!data.seasons[seasonId]) {
    data.seasons[seasonId] = {
      id:       seasonId,
      name:     season.name,
      fullName,
      compName,
      compId:   season.competition?.id,
      orgName,
      orgId:    season.competition?.organisation?.id,
      grades:   [],
      locked:   false,
      addedAt:  new Date().toISOString(),
    };
  }

  const metaSeason = data.seasons[seasonId];
  const discoveredUuids = new Set();

  for (const grade of season.grades) {
    console.log(`\n  Grade: ${grade.name}`);
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      await delay(DELAY_MS);
      let result;
      try {
        result = await gql('publicGradeStatistics', Q_PLAYERS, {
          gradeID: grade.id,
          filter: {
            sort: [{ column: 'APPEARANCE', direction: 'DESC' }],
            pagination: { page, limit: PAGE_SIZE },
          },
        });
      } catch (e) {
        console.warn(`    ⚠ Failed page ${page} of grade ${grade.name}: ${e.message}`);
        break;
      }

      const gps = result.gradePlayerStatistics;
      if (!gps || !gps.results) break;

      totalPages = gps.meta.totalPages;
      const records = gps.results.filter(r => r.profile); // skip private players

      for (const r of records) {
        discoveredUuids.add(r.profile.id);
      }

      console.log(`    Page ${page}/${totalPages}: ${records.length} players`);
      page++;
    }

    // Record grade in season metadata (avoid dupes)
    if (!metaSeason.grades.find(g => g.id === grade.id)) {
      metaSeason.grades.push({
        id:     grade.id,
        name:   grade.name,
        age:    grade.age?.name,
        gender: grade.gender?.name,
      });
    }
  }

  console.log(`\n  ✓ Found ${discoveredUuids.size} unique players in ${seasonId}`);
  return [...discoveredUuids];
}

// ─── Phase 2: Fetch full profile history for a player ────────────────────────

async function fetchPlayerProfile(uuid, data) {
  await delay(DELAY_MS);
  let result;
  try {
    result = await gql('publicProfileStatistics', Q_PROFILE, { profileID: uuid });
  } catch (e) {
    console.warn(`  ⚠ Profile fetch failed for ${uuid}: ${e.message}`);
    return null;
  }

  const profile = result.publicProfile;
  const stats   = result.publicProfileStatistics;
  if (!profile) return null;  // private profile

  const name = `${profile.firstName} ${profile.lastName}`.trim();

  // Also collect all season IDs we haven't seen yet (for crawl mode)
  const newSeasonIds = new Set();

  // Build structured player record
  const seasons = [];
  for (const sportSeason of (stats?.seasonStatistics || [])) {
    // sportSeason.name = sport name e.g. "Basketball"
    for (const reg of (sportSeason.statistics || [])) {
      const seasonId   = reg.season?.id;
      const seasonName = reg.season?.name;
      const clubName   = reg.club?.name;

      if (seasonId && !data.seasons[seasonId]) {
        newSeasonIds.add(seasonId);
      }

      const registrations = [];
      for (const teamStat of (reg.teamStatistics || [])) {
        const teamId   = teamStat.team?.id;
        const teamName = teamStat.team?.name;

        for (const gradeStat of (teamStat.gradeStatistics || [])) {
          const gradeName  = (gradeStat.grade?.name || '').replace(/^[*\s]+/, '');
          const gradeId    = gradeStat.grade?.id;

          // Parse ageGroup and division from grade name
          const ageGroup  = parseAgeGroup(gradeName);
          const division  = parseDivision(gradeName);

          const totalStats = parseStats(gradeStat.totalStatistics);

          const games = [];
          for (const gs of (gradeStat.gameStatistics || [])) {
            const game = gs.game;
            if (!game) continue;

            const homeId   = game.home?.id;
            const homeName = game.home?.name;
            const awayId   = game.away?.id;
            const awayName = game.away?.name;

            // Determine which side the player was on
            const isHome    = homeId === teamId || (homeName && teamName && stripAge(homeName) === stripAge(teamName));
            const oppTeamId = isHome ? awayId : homeId;
            const oppName   = isHome ? awayName : homeName;

            games.push({
              gameId:    game.id,
              date:      game.date,
              round:     game.round?.name,
              home:      { id: homeId,   name: homeName },
              away:      { id: awayId,   name: awayName },
              oppTeamId,
              oppName,
              stats:     parseStats(gs.statistics),
            });
          }

          registrations.push({
            teamId,
            teamName,
            gradeId,
            gradeName,
            ageGroup,
            division,
            stats: totalStats,
            games,
          });
        }
      }

      seasons.push({
        seasonId,
        seasonName,
        clubName,
        registrations,
      });
    }
  }

  const player = {
    uuid,
    name,
    seasons,
    updatedAt: new Date().toISOString(),
  };

  data.players[uuid] = player;
  return { player, newSeasonIds: [...newSeasonIds] };
}

// ─── Grade name parsing ───────────────────────────────────────────────────────

function parseAgeGroup(gradeName) {
  // Matches: U8, U10, U12, U14, U16, U18, U20, U23, Senior, Open, etc.
  const m = gradeName.match(/\bU(\d+(?:\.\d+)?)\b/i);
  if (m) return `U${m[1]}`;
  if (/senior|open|adult/i.test(gradeName)) return 'Senior';
  if (/junior/i.test(gradeName)) return 'Junior';
  return null;
}

function parseDivision(gradeName) {
  // Matches: Division 1, Div 2, Grade A, A1, B2 etc.
  const m = gradeName.match(/(Division\s+\d+|Div\s+\d+|Grade\s+[A-Z]\d*|[A-Z]\d+)\s*$/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function stripAge(name) {
  return (name || '').replace(/\s+U\d+(?:\.\d+)?\s*/gi, '').trim();
}

// ─── Modes ────────────────────────────────────────────────────────────────────

async function modeCrawl(seasonId) {
  console.log(`\n🏀 CRAWL MODE — Season: ${seasonId}`);
  const data = loadData();
  const progress = loadProgress();

  // If no pending work, discover this season first
  if (progress.pendingUuids.length === 0 || !progress.currentSeason) {
    const uuids = await discoverSeasonPlayers(seasonId, data);
    saveData(data);

    // Filter to uuids we haven't fetched yet
    const doneSet = new Set(progress.doneUuids);
    const pending = uuids.filter(u => !doneSet.has(u));
    progress.pendingUuids = pending;
    progress.currentSeason = seasonId;
    progress.seasonsDone = progress.seasonsDone || [];
    saveProgress(progress);
    console.log(`\n📥 ${pending.length} players to fetch (${uuids.length - pending.length} already done)`);
  } else {
    console.log(`\n▶ Resuming from previous run — ${progress.pendingUuids.length} players remaining`);
  }

  const total = progress.pendingUuids.length + progress.doneUuids.length;
  let done = progress.doneUuids.length;

  while (progress.pendingUuids.length > 0) {
    const uuid = progress.pendingUuids[0];
    process.stdout.write(`  [${done + 1}/${total}] ${uuid} ... `);

    const result = await fetchPlayerProfile(uuid, data);

    if (result) {
      console.log(`✓ ${result.player.name} (${result.player.seasons.length} seasons)`);

      // Queue any newly discovered seasons we haven't seen
      for (const newSeasonId of result.newSeasonIds) {
        if (!data.seasons[newSeasonId] && !progress.seasonsDone.includes(newSeasonId)) {
          console.log(`    🔍 New season discovered: ${newSeasonId} — add with --mode=crawl --season=${newSeasonId}`);
        }
      }
    } else {
      console.log(`⚠ skipped (private or failed)`);
    }

    // Advance progress
    progress.pendingUuids.shift();
    progress.doneUuids.push(uuid);
    done++;

    // Save every 10 players
    if (done % 10 === 0) {
      saveData(data);
      saveProgress(progress);
      console.log(`  💾 Saved progress (${done} done, ${progress.pendingUuids.length} remaining)`);
    }
  }

  // Mark season done
  if (!progress.seasonsDone.includes(seasonId)) progress.seasonsDone.push(seasonId);
  data.lastFetch = new Date().toISOString();
  saveData(data);
  clearProgress();

  console.log(`\n✅ Crawl complete for season ${seasonId}`);
  console.log(`   Players in database: ${Object.keys(data.players).length}`);
  console.log(`   Seasons in database: ${Object.keys(data.seasons).length}`);
  printNewSeasonSuggestions(data);
}

async function modeUpdate() {
  console.log(`\n🔄 UPDATE MODE — refreshing active seasons`);
  const data = loadData();

  const activeSeasons = Object.values(data.seasons).filter(s => !s.locked);
  if (activeSeasons.length === 0) {
    console.log('No active seasons to update. All seasons are locked.');
    return;
  }

  console.log(`Active seasons: ${activeSeasons.map(s => `${s.fullName} (${s.id})`).join(', ')}`);

  const allUuids = new Set();
  for (const season of activeSeasons) {
    const uuids = await discoverSeasonPlayers(season.id, data);
    uuids.forEach(u => allUuids.add(u));
    saveData(data);
  }

  console.log(`\n📥 Fetching ${allUuids.size} unique players across active seasons...`);
  let i = 0;
  for (const uuid of allUuids) {
    i++;
    process.stdout.write(`  [${i}/${allUuids.size}] ${uuid} ... `);
    const result = await fetchPlayerProfile(uuid, data);
    console.log(result ? `✓ ${result.player.name}` : '⚠ skipped');
    if (i % 10 === 0) saveData(data);
  }

  data.lastFetch = new Date().toISOString();
  saveData(data);
  console.log(`\n✅ Update complete — ${Object.keys(data.players).length} players in database`);
}

async function modeDiscover(seasonId) {
  console.log(`\n🔍 DISCOVER MODE — enumerate grades and players only (no profile fetch)`);
  const data = loadData();
  const uuids = await discoverSeasonPlayers(seasonId, data);
  saveData(data);
  console.log(`\nDiscovered ${uuids.length} player UUIDs. Run with --mode=crawl to fetch full profiles.`);
  printNewSeasonSuggestions(data);
}

function modeLock(seasonId) {
  const data = loadData();
  if (!data.seasons[seasonId]) {
    console.error(`Season ${seasonId} not found in database`);
    process.exit(1);
  }
  data.seasons[seasonId].locked = true;
  data.seasons[seasonId].lockedAt = new Date().toISOString();
  saveData(data);
  console.log(`✅ Season ${seasonId} (${data.seasons[seasonId].fullName}) locked as historical`);
}

function printNewSeasonSuggestions(data) {
  // Find season IDs referenced in player histories that we haven't crawled yet
  const knownIds = new Set(Object.keys(data.seasons));
  const referenced = new Set();
  for (const player of Object.values(data.players)) {
    for (const s of (player.seasons || [])) {
      if (s.seasonId && !knownIds.has(s.seasonId)) referenced.add(s.seasonId);
    }
  }
  if (referenced.size > 0) {
    console.log(`\n💡 ${referenced.size} season IDs found in player histories but not yet crawled:`);
    for (const id of referenced) {
      console.log(`   node fetch-bball.js --mode=crawl --season=${id}`);
    }
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => a.slice(2).split('='))
  );

  const mode     = args.mode     || 'crawl';
  const seasonId = args.season;

  console.log('🏀 Basketball Player Scraper');
  console.log(`   Tenant:  ${TENANT}`);
  console.log(`   Mode:    ${mode}`);
  if (seasonId) console.log(`   Season:  ${seasonId}`);

  try {
    switch (mode) {
      case 'crawl':
        if (!seasonId) { console.error('--season=<id> required for crawl mode'); process.exit(1); }
        await modeCrawl(seasonId);
        break;
      case 'update':
        await modeUpdate();
        break;
      case 'discover':
        if (!seasonId) { console.error('--season=<id> required for discover mode'); process.exit(1); }
        await modeDiscover(seasonId);
        break;
      case 'lock':
        if (!seasonId) { console.error('--season=<id> required for lock mode'); process.exit(1); }
        modeLock(seasonId);
        break;
      default:
        console.error(`Unknown mode: ${mode}`);
        process.exit(1);
    }
  } catch (e) {
    console.error(`\n❌ Fatal error: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
