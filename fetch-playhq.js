#!/usr/bin/env node
/**
 * fetch-playhq.js — Basketball player scraper for PlayHQ GraphQL API
 *
 * MODES:
 *   node fetch-playhq.js --mode=crawl --season=<id>   # add a new season, discover its players
 *   node fetch-playhq.js --mode=update                # re-fetch all active (unlocked) seasons
 *   node fetch-playhq.js --mode=lock --season=<id>    # mark a season as historical (no further updates)
 *   node fetch-playhq.js --mode=discover              # just enumerate grades/players, no profile fetch
 *
 * OUTPUT FILES:
 *   sports-index.json    — main data store (players, seasons, comps)
 *   games-{tenant}-{seasonId}.json — per-season game index
 *   progress-{tenant}.json  — resume state (survives interruptions)
 *
 * TENANT/SPORT: passed as CLI args (--tenant=bv --sport=basketball)
 * Supported tenants: bv (basketball), afl (footy), ca (cricket)
 *
 * STAT FIELD DISCOVERY:
 *   On first run, unknown stat field names are logged to console with [UNKNOWN STAT].
 *   Update STAT_FIELDS map below once you see what the API actually returns.
 */

const fs   = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

// Tenant and sport are set from CLI args (--tenant=bv --sport=basketball)
// Defaults to Basketball Victoria if not specified
const API_URL        = 'https://api.playhq.com/graphql';
const DELAY_MS       = 50;               // ms between API requests (be polite)
const INDEX_FILE     = path.join(__dirname, 'sports-index.json');
// PROGRESS_FILE and gamesFile() are defined after CLI args so TENANT is available
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
  // Confirmed from first crawl run (MEBA Winter 2026)
  'APPEARANCE':    'gp',
  'TOTAL_SCORE':   'pts',
  'TOTAL_FOULS':   'fouls',
  '1_POINT_SCORE': 'ft',      // free throws (1 pt each)
  '2_POINT_SCORE': 'fg',      // field goals (2 pt each)
  '3_POINT_SCORE': 'threePt', // 3-pointers (speculative — may appear in older/rep grades)
};

// ─── Self-trigger support ────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO  = process.env.GITHUB_REPOSITORY || '';  // e.g. "markjovic/sports-players-stats"

async function triggerSelf(mode, tenant, sport) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.log('  ⚠ No GITHUB_TOKEN/GITHUB_REPOSITORY — cannot self-trigger');
    return false;
  }
  const [owner, repo] = GITHUB_REPO.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/fetch-playhq.yml/dispatches`;
  // Pass the final cap as the concurrency for the next run
  const nextConcurrency = String(CONCURRENCY_CAP);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: { mode, tenant, sport, season: '', concurrency: nextConcurrency },
      }),
    });
    if (res.ok || res.status === 204) {
      console.log(`  ✅ Triggered new workflow run (${mode} / ${tenant} / ${sport})`);
      return true;
    } else {
      const body = await res.text();
      console.log(`  ⚠ Self-trigger failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
      return false;
    }
  } catch (e) {
    console.log(`  ⚠ Self-trigger error: ${e.message}`);
    return false;
  }
}

// ─── CLI args (parsed early so TENANT/SPORT are available as constants) ─────

const _RAW_ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const TENANT = _RAW_ARGS.tenant || 'bv';
const SPORT  = _RAW_ARGS.sport  || 'basketball';

// These depend on TENANT so must come after CLI arg parsing
const PROGRESS_FILE  = path.join(__dirname, `progress-${TENANT}.json`);
const PLAYERS_DIR    = path.join(__dirname, 'players');
const SKIPPED_FILE   = path.join(__dirname, 'seasons-skipped.json');

// Tenant → sport name mapping (avoids unreliable API field)
const TENANT_SPORT = {
  'bv':  'Basketball',
  'afl': 'Australian Rules Football',
  'ca':  'Cricket',
};
const SPORT_NAME = TENANT_SPORT[TENANT] || SPORT;

function playerFile(uuid) {
  // Shard by first 2 chars of uuid to avoid too many files in one folder
  const shard = uuid.slice(0, 2);
  const dir = path.join(PLAYERS_DIR, shard);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${uuid}.json`);
}

// ─── Concurrency / rate-limit state (module-level so gql() can reference) ────
const _START_CONCURRENCY = parseInt(_RAW_ARGS.concurrency || '50', 10);
let CONCURRENCY     = _START_CONCURRENCY;
let CONCURRENCY_CAP = _START_CONCURRENCY;
let _clean_batches  = 0;  // consecutive clean batches since last 429
let _429_streak     = 0;  // consecutive 429s on current request — drives cap down
let _429_total      = 0;  // total 429s this season — reported in summary
let _429_cap_hits   = 0;  // times cap was lowered this season
const QUEUE_PRIORITY_FILE = path.join(__dirname, `queue-${TENANT}-priority.json`);
const QUEUE_BACKLOG_FILE  = path.join(__dirname, `queue-${TENANT}-backlog.json`);
const GAMES_DIR     = path.join(__dirname, 'games', TENANT);

function gamesFile(seasonId) {
  // Ensure directory exists
  if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });
  return path.join(GAMES_DIR, `${seasonId}.json`);
}

// ─── GraphQL Queries ──────────────────────────────────────────────────────────

const Q_SEASON = `
query gradeListDiscoverSeason($id: String!) {
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
  let attempts = 0;
  while (true) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'tenant':       TENANT,
        'origin':       'https://www.playhq.com',
      },
      body: JSON.stringify({ operationName, query, variables }),
    });

    if (res.status === 429) {
      attempts++;
      _429_streak++;
      _429_total++;
      _clean_batches = 0;

      // Reduce current concurrency immediately
      const prevC = CONCURRENCY;
      CONCURRENCY = Math.max(5, Math.floor(CONCURRENCY * 0.6));

      // If we keep hitting 429s, lower the cap permanently by 5 (floor at 15 first, then 10, then 5)
      if (_429_streak >= 3) {
        const prevCap = CONCURRENCY_CAP;
        CONCURRENCY_CAP = Math.max(5, CONCURRENCY_CAP - 5);
        CONCURRENCY     = Math.min(CONCURRENCY, CONCURRENCY_CAP);
        _429_streak     = 0;
        _429_cap_hits++;
        console.warn(`  ⚠ Repeated 429s — cap lowered ${prevCap} → ${CONCURRENCY_CAP}, concurrency now ${CONCURRENCY}`);
      } else {
        console.warn(`  ⚠ Rate limited (429) — concurrency ${prevC} → ${CONCURRENCY}, retrying in ${attempts * 5}s`);
      }

      await delay(attempts * 5000);
      continue;  // retry this exact request — player is NOT skipped
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '(could not read body)');
      throw new Error(`HTTP ${res.status} for ${operationName}\nResponse body: ${body}`);
    }

    const json = await res.json();
    if (json.errors) throw new Error(`GraphQL error in ${operationName}: ${JSON.stringify(json.errors)}`);
    _429_streak = 0;  // successful response — reset streak
    return json.data;
  }
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
  let index = { players: {}, seasons: {}, lastFetch: null };
  if (fs.existsSync(INDEX_FILE)) {
    try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
    catch (e) { console.warn('⚠ Could not parse sports-index.json, starting fresh'); }
  }
  return { index };
}

function loadSeasonGames(seasonId) {
  const f = gamesFile(seasonId);
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { console.warn(`⚠ Could not parse games file for ${seasonId}`); }
  }
  // Empty season games structure
  return { games: {}, playerGames: {} };
}

function saveData({ index }) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
}

function savePlayerDetail(uuid, detail) {
  fs.writeFileSync(playerFile(uuid), JSON.stringify(detail));
}

function saveSeasonGames(seasonId, seasonGames) {
  fs.writeFileSync(gamesFile(seasonId), JSON.stringify(seasonGames));
}

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      // Ensure all required arrays exist
      p.pendingUuids  = Array.isArray(p.pendingUuids)  ? p.pendingUuids  : [];
      p.doneUuids     = Array.isArray(p.doneUuids)     ? p.doneUuids     : [];
      p.seasonsDone   = Array.isArray(p.seasonsDone)   ? p.seasonsDone   : [];
      return p;
    }
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
  if (!data.index.seasons[seasonId]) {
    data.index.seasons[seasonId] = {
      id:       seasonId,
      name:     season.name,
      fullName,
      compName,
      compId:   season.competition?.id,
      orgName,
      orgId:    season.competition?.organisation?.id,
      tenant:   TENANT,
      grades:   [],
      locked:   false,
      addedAt:  new Date().toISOString(),
    };
  }

  const metaSeason = data.index.seasons[seasonId];
  const discoveredUuids = new Set();
  const uuidGenders = {};  // uuid → inferred gender from grade

  for (const [gi, grade] of season.grades.entries()) {
    console.log(`\n  Grade [${gi+1}/${season.grades.length}]: ${grade.name}`);
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
        const uid = r.profile.id;
        discoveredUuids.add(uid);
        // Tag with gender from this grade for player gender inference
        const g = grade.gender?.name || 'Unknown';
        if (!uuidGenders[uid]) uuidGenders[uid] = g;
        else {
          // Female or Male always wins over Mixed/Unknown
          const cur = uuidGenders[uid];
          if (cur === 'Unknown' || cur === 'Mixed') uuidGenders[uid] = g;
          // If both gendered, keep existing (shouldn't happen but be safe)
        }
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
  return { uuids: [...discoveredUuids], genders: uuidGenders };
}

// ─── Phase 2: Fetch full profile history for a player ────────────────────────

async function fetchPlayerProfile(uuid, data, rawGames, inferredGender) {
  await delay(DELAY_MS);
  if (!rawGames) rawGames = {};
  let result;
  try {
    result = await gql('publicProfileStatistics', Q_PROFILE, { profileID: uuid });
  } catch (e) {
    // PlayHQ sometimes returns INTERNAL_SERVER_ERROR for specific bad game records.
    // Log and skip — don't let one bad record block the whole player.
    console.warn(`  ⚠ Profile fetch failed for ${uuid}: ${e.message.slice(0, 120)}`);
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
    for (const reg of (sportSeason.statistics || [])) {
      const seasonId   = reg.season?.id;
      const seasonName = reg.season?.name;
      const clubName   = reg.club?.name;

      if (seasonId && !data.index.seasons[seasonId]) {
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

            // Store gameId, date, oppTeamId, oppTeamName — enough for display + PlayHQ link
            if (game.id && oppTeamId) {
              games.push({
                g:  game.id,                          // gameId
                d:  game.date,                        // date
                o:  oppTeamId,                        // oppTeamId
                on: isHome ? awayName : homeName,     // oppTeamName
              });
            }
          }

          registrations.push({
            tid:   teamId,
            tn:    teamName,
            gid:   gradeId,
            gn:    gradeName,
            age:   ageGroup,
            div:   division,
            stats: totalStats,
          });

          // Accumulate raw games keyed by seasonId for per-season game files
          // Skip locked seasons — their games never change and files are already correct
          const isLocked = data.index.seasons[seasonId]?.locked === true;
          if (games.length > 0 && seasonId && !isLocked) {
            if (!rawGames[seasonId]) rawGames[seasonId] = {};
            if (!rawGames[seasonId][uuid]) rawGames[seasonId][uuid] = [];
            rawGames[seasonId][uuid].push(...games);
          }
        }
      }

      seasons.push({
        sid:  seasonId,
        sn:   seasonName,
        club: clubName,
        regs: registrations,
      });
    }
  }

  // Compute career totals per sport for the index
  const sportTotals = {};
  for (const s of seasons) {
    const sp = SPORT_NAME;  // derived from tenant, not API
    if (!sportTotals[sp]) sportTotals[sp] = { gp: 0, pts: 0, fouls: 0, fg: 0, ft: 0, threePt: 0 };
    for (const reg of (s.regs || [])) {
      for (const [k, v] of Object.entries(reg.stats || {})) {
        if (sportTotals[sp][k] !== undefined) sportTotals[sp][k] += v || 0;
      }
    }
  }

  // Determine gender — preserve stronger signal from previous crawls
  const existing = data.index.players[uuid];
  const gender = (existing?.gender === 'Female' || existing?.gender === 'Male')
    ? existing.gender
    : (inferredGender || 'Unknown');

  // Merge sport totals with any existing sports from other tenants
  const existingSports = existing?.sports || {};
  const mergedSports = { ...existingSports, ...sportTotals };

  // Slim index entry — search + leaderboards only, all sports
  const indexEntry = {
    uuid,
    name,
    gender,
    sports: mergedSports,
    updatedAt: new Date().toISOString(),
  };

  // Load existing player detail to preserve other sports' season data
  let existingDetail = {};
  try {
    const pf = playerFile(uuid);
    if (fs.existsSync(pf)) existingDetail = JSON.parse(fs.readFileSync(pf, 'utf8'));
  } catch (e) {}

  // Merge seasons — keep seasons from other sports, replace current sport's seasons
  const otherSeasons = (existingDetail.seasons || []).filter(s => s.sport && s.sport !== SPORT_NAME);
  const thisSeasons  = seasons.map(s => ({ ...s, sport: SPORT_NAME }));

  // Full detail file — all sports, all seasons, fetched on demand
  const detail = {
    uuid,
    name,
    gender,
    sports: mergedSports,
    seasons: [...otherSeasons, ...thisSeasons],
    updatedAt: new Date().toISOString(),
  };

  data.index.players[uuid] = indexEntry;
  savePlayerDetail(uuid, detail);
  return { player: indexEntry, newSeasonIds: [...newSeasonIds] };
}

// ─── Season queue helpers ────────────────────────────────────────────────────

function parseSeasonYear(seasonName) {
  // Extract year from season names like "Winter 2023", "Summer 2022/23", "Autumn 2024"
  if (!seasonName) return null;
  // Match full years (e.g. 2025) and short split years (e.g. 2025/26 → extract 26 as 2026)
  const years = [];
  const full = seasonName.match(/20\d\d/g);
  if (full) full.forEach(y => years.push(parseInt(y)));
  const split = seasonName.match(/20\d\d\/(\d\d)/);
  if (split) years.push(2000 + parseInt(split[1]));
  if (years.length === 0) return null;
  return Math.max(...years);
}

function isPriority(seasonName) {
  const year = parseSeasonYear(seasonName);
  return year !== null && year >= 2023;
}

function loadQueues() {
  let priority = null, backlog = null;
  if (fs.existsSync(QUEUE_PRIORITY_FILE)) {
    try { priority = JSON.parse(fs.readFileSync(QUEUE_PRIORITY_FILE, 'utf8')); }
    catch (e) { console.warn('⚠ Could not parse priority queue'); }
  }
  if (fs.existsSync(QUEUE_BACKLOG_FILE)) {
    try { backlog = JSON.parse(fs.readFileSync(QUEUE_BACKLOG_FILE, 'utf8')); }
    catch (e) { console.warn('⚠ Could not parse backlog queue'); }
  }
  return { priority, backlog };
}

function saveQueues(priority, backlog) {
  if (priority !== null) fs.writeFileSync(QUEUE_PRIORITY_FILE, JSON.stringify(priority));
  if (backlog  !== null) fs.writeFileSync(QUEUE_BACKLOG_FILE,  JSON.stringify(backlog));
}

function deleteQueues() {
  if (fs.existsSync(QUEUE_PRIORITY_FILE)) fs.unlinkSync(QUEUE_PRIORITY_FILE);
  if (fs.existsSync(QUEUE_BACKLOG_FILE))  fs.unlinkSync(QUEUE_BACKLOG_FILE);
}

function buildQueuesFromIndex(data) {
  // Build queues from index using season names already stored in player records.
  // No API calls needed — we already have season names from publicProfileStatistics.
  console.log('  Building season queues from index (one-time scan)...');
  const knownIds  = new Set(Object.keys(data.index.seasons));
  const priority  = [];
  const backlog   = [];
  const seen      = new Set();
  // Build a map of sid → best known season name from player records
  const sidNames  = {};

  for (const player of Object.values(data.index.players)) {
    for (const s of (player.seasons || [])) {
      const sid = s.sid || s.seasonId;
      const sn  = s.sn  || s.seasonName || '';
      if (sid && !knownIds.has(sid)) {
        if (!seen.has(sid)) {
          seen.add(sid);
          sidNames[sid] = sn;
        } else if (!sidNames[sid] && sn) {
          sidNames[sid] = sn;  // fill in name if we now have one
        }
      }
    }
  }

  for (const [sid, sn] of Object.entries(sidNames)) {
    if (isPriority(sn)) {
      priority.push(sid);
    } else if (sn) {
      backlog.push(sid);
    } else {
      // No name available — assume priority so we don't lose recent seasons
      priority.push(sid);
    }
  }

  console.log(`  Priority queue: ${priority.length} seasons (2023+ or unknown year)`);
  console.log(`  Backlog queue:  ${backlog.length} seasons (pre-2023)`);
  return { priority, backlog };
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
  // Reset rate-limit state for this season
  CONCURRENCY     = _START_CONCURRENCY;
  CONCURRENCY_CAP = _START_CONCURRENCY;
  _clean_batches  = 0;
  _429_streak     = 0;
  _429_total      = 0;
  _429_cap_hits   = 0;
  const data = loadData();
  const progress = loadProgress();

  // If no pending work, or progress is for a different season, discover fresh
  let genders = {};  // uuid → inferred gender; populated during discovery, empty on resume
  if (progress.pendingUuids.length === 0 || !progress.currentSeason || progress.currentSeason !== seasonId) {
    if (progress.currentSeason && progress.currentSeason !== seasonId) {
      console.log(`  ⚠ Progress file is for season ${progress.currentSeason}, not ${seasonId} — starting fresh`);
      clearProgress();
      progress.pendingUuids = [];
      progress.doneUuids    = [];
      progress.seasonsDone  = [];
    }
    const discovered = await discoverSeasonPlayers(seasonId, data);
    const uuids = discovered.uuids;
    genders = discovered.genders;
    saveData(data);

    // Apply gender inference to existing player records
    for (const [uuid, gender] of Object.entries(genders)) {
      if (data.index.players[uuid]) {
        const cur = data.index.players[uuid].gender;
        if (!cur || cur === 'Unknown' || cur === 'Mixed') {
          if (gender === 'Female' || gender === 'Male') {
            data.index.players[uuid].gender = gender;
          } else if (!cur) {
            data.index.players[uuid].gender = gender;
          }
        }
      }
    }
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

  // Guard against malformed/stale progress file
  if (!Array.isArray(progress.pendingUuids) || !Array.isArray(progress.doneUuids)) {
    console.warn('  ⚠ Stale or malformed progress file — restarting season from scratch');
    clearProgress();
    return await modeCrawl(seasonId);
  }

  const total = progress.pendingUuids.length + progress.doneUuids.length;
  let done = progress.doneUuids.length;
  while (progress.pendingUuids.length > 0) {
    const batch = progress.pendingUuids.splice(0, CONCURRENCY);
    const batchGames = {};  // rawGames: { seasonId: { uuid: [games] } }

    const results = await Promise.all(batch.map(async (uuid) => {
      const result = await fetchPlayerProfile(uuid, data, batchGames, genders[uuid]);
      return { uuid, result };
    }));

    for (const { uuid, result } of results) {
      done++;
      if (result) {
        console.log(`  [${done}/${total}] ✓ ${result.player.name}`);
        for (const newSeasonId of result.newSeasonIds) {
          if (!data.index.seasons[newSeasonId] && !progress.seasonsDone.includes(newSeasonId)) {
            if (!progress.discoveredSeasons) progress.discoveredSeasons = [];
            if (!progress.discoveredSeasons.includes(newSeasonId)) {
              progress.discoveredSeasons.push(newSeasonId);
              console.log(`    🔍 New season discovered: ${newSeasonId}`);
            }
          }
        }
      } else {
        console.log(`  [${done}/${total}] ⚠ ${uuid} skipped`);
      }
      progress.doneUuids.push(uuid);
    }

    // Merge batch rawGames into per-season game files
    // batchGames structure: { seasonId: { uuid: [{g,d,o,on},...] } }
    for (const [sid, playerMap] of Object.entries(batchGames)) {
      if (!sid) continue;  // skip if seasonId somehow undefined
      const sg = loadSeasonGames(sid);
      for (const [uuid, games] of Object.entries(playerMap)) {
        if (!sg.playerGames[uuid]) sg.playerGames[uuid] = [];
        const existingGames = new Set(sg.playerGames[uuid]);
        for (const game of games) {
          if (!sg.games[game.g]) sg.games[game.g] = { d: game.d, on: game.on, o: game.o };
          if (!existingGames.has(game.g)) {
            sg.playerGames[uuid].push(game.g);
            existingGames.add(game.g);
          }
        }
      }
      saveSeasonGames(sid, sg);
    }

    // Gradually recover concurrency after clean batches, up to current cap
    _clean_batches++;
    if (_clean_batches >= 5 && CONCURRENCY < CONCURRENCY_CAP) {
      CONCURRENCY = Math.min(CONCURRENCY_CAP, CONCURRENCY + 5);
      console.log(`  📈 Concurrency recovered to ${CONCURRENCY} (cap: ${CONCURRENCY_CAP})`);
      _clean_batches = 0;
    }

    // Save index every batch
    saveData(data);
    saveProgress(progress);
    if (done % 50 === 0) {
      console.log(`  💾 ${done}/${total} done, ${progress.pendingUuids.length} remaining`);
    }
  }

  // Print 429 / concurrency summary
  console.log(`\n📊 Rate limit summary for ${seasonId}:`);
  console.log(`   Total 429s:       ${_429_total}`);
  console.log(`   Cap reductions:   ${_429_cap_hits}`);
  console.log(`   Final cap:        ${CONCURRENCY_CAP}`);
  console.log(`   Final concurrency:${CONCURRENCY}`);
  if (_429_total === 0) {
    console.log(`   ✅ No rate limiting — consider increasing CONCURRENCY above 30 for next run`);
  } else if (CONCURRENCY_CAP < 30) {
    console.log(`   ⚠ Recommend starting next run with --concurrency=${CONCURRENCY_CAP}`);
  } else {
    console.log(`   ✅ Rate limiting resolved without cap reduction`);
  }

  // Auto-lock historical seasons (year < current year)
  const seasonMeta = data.index.seasons[seasonId];
  if (seasonMeta && !seasonMeta.locked) {
    const year = parseSeasonYear(seasonMeta.name);
    const currentYear = new Date().getFullYear();
    if (year !== null && year < currentYear) {
      seasonMeta.locked   = true;
      seasonMeta.lockedAt = new Date().toISOString();
      console.log(`  🔒 Auto-locked historical season: ${seasonMeta.fullName} (${year} < ${currentYear})`);
    }
  }

  // Mark season done
  if (!progress.seasonsDone.includes(seasonId)) progress.seasonsDone.push(seasonId);
  data.index.lastFetch = new Date().toISOString();
  saveData(data);

  // Print discovered seasons before clearing progress
  const totalDiscovered = (progress.discoveredSeasons || []).length;
  if (totalDiscovered > 0) {
    console.log(`\n💡 ${totalDiscovered} new season(s) discovered in player histories:`);
    for (const id of progress.discoveredSeasons) {
      console.log(`   node fetch-playhq.js --mode=crawl --season=${id}`);
    }
  }

  clearProgress();

  console.log(`\n✅ Crawl complete for season ${seasonId}`);
  console.log(`   Players in database: ${Object.keys(data.index.players).length}`);
  console.log(`   Seasons in database: ${Object.keys(data.index.seasons).length}`);
  printNewSeasonSuggestions(data);
  return totalDiscovered;
}

async function modeUpdate() {
  console.log(`\n🔄 UPDATE MODE — refreshing active seasons`);
  const data = loadData();

  const activeSeasons = Object.values(data.index.seasons).filter(s => !s.locked);
  if (activeSeasons.length === 0) {
    console.log('No active seasons to update. All seasons are locked.');
    return;
  }

  console.log(`Active seasons: ${activeSeasons.map(s => `${s.fullName} (${s.id})`).join(', ')}`);

  const allUuids = new Set();
  for (const season of activeSeasons) {
    const { uuids } = await discoverSeasonPlayers(season.id, data);
    uuids.forEach(u => allUuids.add(u));
    saveData(data);
  }

  console.log(`\n📥 Fetching ${allUuids.size} unique players across active seasons...`);
  let i = 0;
  const uuidArray = [...allUuids];
  while (i < uuidArray.length) {
    const batch = uuidArray.slice(i, i + CONCURRENCY);
    const batchGames = {};
    const results = await Promise.all(batch.map(uuid => fetchPlayerProfile(uuid, data, batchGames)));
    for (const [idx, result] of results.entries()) {
      i++;
      console.log(result ? `  [${i}/${uuidArray.length}] ✓ ${result.player.name}` : `  [${i}/${uuidArray.length}] ⚠ skipped`);
    }
    for (const [sid, playerMap] of Object.entries(batchGames)) {
      const sg = loadSeasonGames(sid);
      for (const [uuid, games] of Object.entries(playerMap)) {
        if (!sg.playerGames[uuid]) sg.playerGames[uuid] = [];
        const existingGames = new Set(sg.playerGames[uuid]);
        for (const game of games) {
          if (!sg.games[game.g]) sg.games[game.g] = { d: game.d, on: game.on, o: game.o };
          if (!existingGames.has(game.g)) { sg.playerGames[uuid].push(game.g); existingGames.add(game.g); }
        }
      }
      saveSeasonGames(sid, sg);
    }
    saveData(data);
  }

  data.index.lastFetch = new Date().toISOString();
  saveData(data);
  console.log(`\n✅ Update complete — ${Object.keys(data.index.players).length} players in database`);
}

async function modeDiscover(seasonId) {
  console.log(`\n🔍 DISCOVER MODE — enumerate grades and players only (no profile fetch)`);
  const data = loadData();
  const { uuids } = await discoverSeasonPlayers(seasonId, data);
  saveData(data);
  console.log(`\nDiscovered ${uuids.length} player UUIDs. Run with --mode=crawl to fetch full profiles.`);
  printNewSeasonSuggestions(data);
}

function modeLock(seasonId) {
  const data = loadData();
  if (!data.index.seasons[seasonId]) {
    console.error(`Season ${seasonId} not found in database`);
    process.exit(1);
  }
  data.index.seasons[seasonId].locked = true;
  data.index.seasons[seasonId].lockedAt = new Date().toISOString();
  saveData(data);
  console.log(`✅ Season ${seasonId} (${data.index.seasons[seasonId].fullName}) locked as historical`);
}

function printNewSeasonSuggestions(data) {
  // Find season IDs referenced in player histories that we haven't crawled yet
  const knownIds = new Set(Object.keys(data.index.seasons));
  const referenced = new Set();
  for (const player of Object.values(data.index.players)) {
    for (const s of (player.seasons || [])) {
      const sid = s.sid || s.seasonId;  // handle both old and new key
      if (sid && !knownIds.has(sid)) referenced.add(sid);
    }
  }
  if (referenced.size > 0) {
    console.log(`\n💡 ${referenced.size} season IDs found in player histories but not yet crawled:`);
    for (const id of referenced) {
      console.log(`   node fetch-playhq.js --mode=crawl --season=${id}`);
    }
  }
}



// ─── Crawl-all mode — work through all undiscovered seasons from the index ────

async function modeCrawlAll() {
  console.log('\n🏀 CRAWL-ALL MODE — one season per run, self-triggering until complete');
  const data = loadData();

  // Load or build the two-tier queues
  let { priority, backlog } = loadQueues();

  if (!priority && !backlog) {
    // First run — build queues from index with year-based routing
    const queues = await buildQueuesFromIndex(data);
    priority = queues.priority;
    backlog  = queues.backlog;
    saveQueues(priority, backlog);
  } else {
    console.log(`  Priority queue: ${(priority||[]).length} seasons remaining`);
    console.log(`  Backlog queue:  ${(backlog||[]).length} seasons remaining`);
  }

  priority = priority || [];
  backlog  = backlog  || [];

  if (priority.length === 0 && backlog.length === 0) {
    console.log('\n✅ All seasons complete!');
    deleteQueues();
    return;
  }

  // Take from priority first, then backlog
  const fromPriority = priority.length > 0;
  const seasonId     = fromPriority ? priority.shift() : backlog.shift();
  const tier         = fromPriority ? 'priority' : 'backlog';
  console.log(`\n▶ [${tier}] Season ${seasonId} (${priority.length} priority + ${backlog.length} backlog remaining)`);

  let seasonSucceeded    = false;
  let crawlDiscoveredCount = 0;
  try {
    crawlDiscoveredCount = await modeCrawl(seasonId) || 0;
    seasonSucceeded = true;
  } catch (e) {
    console.warn(`  ⚠ Season ${seasonId} failed: ${e.message}`);
    console.warn(e.stack);
    // "not found" = bad season ID, safe to skip and continue
    const isSkippable = e.message.includes('not found') || e.message.includes('HTTP 4');
    if (!isSkippable) {
      console.warn('  ⚠ Self-trigger suppressed — fix the issue before re-running');
      return;
    }
    console.warn('  ⚠ Skipping bad season ID — recording in seasons-skipped.json');
    // Record in seasons-skipped.json for future review
    try {
      const skipped = fs.existsSync(SKIPPED_FILE)
        ? JSON.parse(fs.readFileSync(SKIPPED_FILE, 'utf8'))
        : [];
      // Avoid duplicates
      if (!skipped.find(s => s.id === seasonId)) {
        skipped.push({
          id:        seasonId,
          reason:    e.message,
          skippedAt: new Date().toISOString(),
        });
        fs.writeFileSync(SKIPPED_FILE, JSON.stringify(skipped));
      }
    } catch (writeErr) {
      console.warn(`  ⚠ Could not write to seasons-skipped.json: ${writeErr.message}`);
    }
    // Season already popped from queue via .shift() so it won't be retried
    seasonSucceeded = true;  // treat as success so chain continues
  }

  if (!seasonSucceeded) return;

  // Route newly discovered seasons to the right queue
  // Read from progress file's discoveredSeasons (set during crawl) rather than
  // scanning all player records — player index is now slim with no season detail
  const updatedData   = loadData();
  // alreadyQueued = queue files + all seasons in index (crawled or stub)
  // This prevents re-adding already-crawled seasons to the queue
  const alreadyQueued = new Set([
    ...priority,
    ...backlog,
    ...Object.keys(updatedData.index.seasons).filter(sid => !updatedData.index.seasons[sid]?.discovered),
  ]);

  // Stub seasons = discovered during this crawl, written to index with discovered:true
  const stubs = Object.entries(updatedData.index.seasons)
    .filter(([sid, meta]) => meta?.discovered && sid !== seasonId);

  const alreadyInQueue = stubs.filter(([sid]) => alreadyQueued.has(sid)).length;
  const genuinelyNew   = stubs.filter(([sid]) => !alreadyQueued.has(sid)).length;

  console.log(`\n🔍 Season discovery summary:`);
  console.log(`   Discovered in player histories: ${crawlDiscoveredCount}`);
  console.log(`   New stubs in index:             ${stubs.length}`);
  console.log(`   Already in queue (skip):        ${alreadyInQueue}`);
  console.log(`   Genuinely new → queuing:        ${genuinelyNew}`);

  let added = 0;
  for (const [sid, meta] of stubs) {
    if (!alreadyQueued.has(sid)) {
      const sn = meta?.name || '';
      if (isPriority(sn) || meta?.discovered) {
        priority.push(sid);
        console.log(`  ➕ Priority: ${sid} — ${sn || 'unknown year'}`);
      } else {
        backlog.push(sid);
        console.log(`  ➕ Backlog: ${sid} — ${sn || 'unknown year'}`);
      }
      alreadyQueued.add(sid);
      added++;
    }
  }
  if (added > 0) console.log(`  ➕ Added ${added} to queue (priority: ${priority.length}, backlog: ${backlog.length})`);
  else console.log(`  No new seasons to queue`);

  const totalRemaining = priority.length + backlog.length;
  // Always save queues so next run sees the updated counts
  saveQueues(priority, backlog);

  if (totalRemaining > 0) {
    console.log(`\n📋 ${priority.length} priority + ${backlog.length} backlog remaining — triggering next run`);
    await triggerSelf('crawl-all', TENANT, SPORT);
  } else {
    deleteQueues();
    console.log(`\n✅ All seasons complete!`);
    console.log(`   Players in database: ${Object.keys(updatedData.index.players).length}`);
    console.log(`   Seasons in database: ${Object.keys(updatedData.index.seasons).length}`);
  }
}

// ─── Probe mode — diagnose API schema ────────────────────────────────────────

async function modeProbe() {
  console.log('\n🔬 PROBE MODE — testing API schema');
  const queries = [
    {
      name: 'discoverSeason (AFL-style, seasonID param)',
      op: 'gradeListDiscoverSeason',
      q: `query gradeListDiscoverSeason($id: String!) { discoverSeason(seasonID: $id) { id name } }`,
      v: { id: '15908988' },
    },
    {
      name: 'discoverSeason (id param)',
      op: 'probeSeason2',
      q: `query probeSeason2($id: String!) { discoverSeason(id: $id) { id name } }`,
      v: { id: '15908988' },
    },
    {
      name: '__schema query fields (introspection)',
      op: 'IntrospectionQuery',
      q: `{ __schema { queryType { fields { name } } } }`,
      v: {},
    },
  ];
  for (const probe of queries) {
    await delay(DELAY_MS);
    console.log(`\n  Testing: ${probe.name}`);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'tenant': TENANT, 'origin': 'https://www.playhq.com' },
        body: JSON.stringify({ operationName: probe.op, query: probe.q, variables: probe.v }),
      });
      const text = await res.text();
      console.log(`  HTTP ${res.status}: ${text.slice(0, 800)}`);
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main() {
  const mode     = _RAW_ARGS.mode   || 'crawl';
  const seasonId = _RAW_ARGS.season;

  const sportEmoji = { basketball: '🏀', 'australian-rules': '🏈', cricket: '🏏' }[SPORT] || '🏆';
  console.log(`${sportEmoji} PlayHQ Sports Scraper`);
  console.log(`   Tenant:  ${TENANT}`);
  console.log(`   Sport:   ${SPORT}`);
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
      case 'probe':
        await modeProbe();
        break;
      case 'crawl-all':
        await modeCrawlAll();
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
