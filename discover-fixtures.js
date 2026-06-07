#!/usr/bin/env node
// discover-fixtures.js
/**
 * Discovers fixtures for all teams using discoverTeamFixture — which works for
 * ALL seasons (including historical), returns all rounds in one call per team,
 * and includes venue, court, time, scores, and team details.
 *
 * Strategy:
 *   1. For each season in sports-index.json, get team IDs from discoverGrade.ladder
 *   2. For each team, call discoverTeamFixture(teamID)
 *   3. Write/update game entries in games/bv/{seasonId}.json with:
 *      - Scores (hs, as), venue (vid, vn, ct, t), round name (rn)
 *      - Team IDs and names (h, hn, a, an), game status (st)
 *      - Constructed PlayHQ URL (url)
 *   4. Populate venue-lookup/{prefix}.json shards
 *
 * Safe to re-run — deduplicates by game ID, skips already-complete entries.
 *
 * Usage:
 *   node discover-fixtures.js                       # active seasons only (locked: false)
 *   node discover-fixtures.js --all-seasons         # all seasons including completed
 *   node discover-fixtures.js --season=<id>         # single season
 *   node discover-fixtures.js --concurrency=20      # team fetches in parallel
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const TENANT        = ARGS.tenant      || 'bv';
const TENANT_FULL   = { bv: 'basketball-victoria', afl: 'afl' }[TENANT] || TENANT;
const CONCURRENCY   = parseInt(ARGS.concurrency || '20', 10);
const TARGET_SEASON = ARGS.season      || null;
const ALL_SEASONS   = !!ARGS['all-seasons'];

const API_URL     = 'https://api.playhq.com/graphql';
const GAMES_DIR   = path.join(__dirname, 'games', TENANT);
const VENUE_DIR   = path.join(__dirname, 'venue-lookup');
const INDEX_FILE  = path.join(__dirname, 'sports-index.json');
const COOKIE_FILE = path.join(__dirname, `cookie-${TENANT}.json`);

// ─── Headers ──────────────────────────────────────────────────────────────────

const MOBILE_HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT_FULL,
  'content-type': 'application/json',
};

// ─── Cookie ───────────────────────────────────────────────────────────────────

let _cookie = null;

async function getSession() {
  if (_cookie) return _cookie;
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const d = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      if (Date.now() - d.fetchedAt < 5 * 60 * 60 * 1000) { _cookie = d.cookie; return _cookie; }
    }
  } catch (e) {}
  console.log('  Fetching session cookie...');
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({
      operationName: 'ProfileSearch',
      variables:     { fullName: 'test player' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
    }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No Set-Cookie');
  _cookie = raw.split(';')[0];
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie: _cookie, fetchedAt: Date.now() }));
  console.log('  ✓ Cookie obtained');
  return _cookie;
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gql(operationName, query, variables) {
  const cookie = await getSession();
  let attempts = 0;
  while (true) {
    try {
      const res = await fetch(API_URL, {
        method:  'POST',
        headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
        body:    JSON.stringify({ operationName, variables, query }),
      });
      if (res.status === 429) { await delay(10000); continue; }
      if (!res.ok) { if (attempts++ < 2) { await delay(5000); continue; } return null; }
      const json = await res.json();
      if (json.errors) return null;
      return json.data;
    } catch (e) {
      if (attempts++ < 2) { await delay(3000); continue; }
      return null;
    }
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const Q_GRADE_TEAMS = `
query DiscoverGrade($id: ID!) {
  discoverGrade(gradeID: $id) {
    id name
    ladder {
      pool { name }
      standings { team { id name } }
    }
  }
}`;

const Q_TEAM_FIXTURE = `
query TeamFixture($teamID: ID!) {
  discoverTeam(teamID: $teamID) {
    id
    grade { id name }
    season {
      id name
      competition { id name organisation { id name } }
      status { value }
    }
    organisation { id name }
  }
  discoverTeamFixture(teamID: $teamID) {
    id name isFinalsRound
    grade {
      id name
      season {
        id name
        competition { id name organisation { id name } }
      }
    }
    fixture {
      games {
        id dates
        status { value }
        home {
          ... on DiscoverTeam {
            id name
            logo { sizes { url dimensions { width } } }
            organisation { id name }
          }
        }
        away {
          ... on DiscoverTeam {
            id name
            logo { sizes { url dimensions { width } } }
            organisation { id name }
          }
        }
        result {
          home { statistics { count type { value } } }
          away { statistics { count type { value } } }
        }
        allocation {
          dateTimeList { date time }
          court {
            id name abbreviatedName
            venue {
              id name abbreviatedName
              latitude longitude
              address suburb state postcode country
            }
          }
        }
      }
    }
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[()]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
}

function buildGameUrl(gameId, orgName, compName, seasonName, gradeName) {
  const org   = slugify(orgName);
  const comp  = slugify(`${compName} ${seasonName}`);
  const grade = slugify(gradeName);
  if (!org || !comp || !grade) return null;
  return `https://www.playhq.com/${TENANT_FULL}/org/${org}/${comp}/${grade}/game-centre/${gameId}`;
}

function smallestLogo(logo) {
  if (!logo?.sizes?.length) return null;
  return logo.sizes.sort((a, b) => (a.dimensions?.width || 999) - (b.dimensions?.width || 999))[0]?.url || null;
}

function parseScore(statistics) {
  return statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;
}

// ─── Venue lookup shards ──────────────────────────────────────────────────────

const _venueShards = {};
const _dirtyVenues = new Set();

function loadVenueShard(venueId) {
  const prefix = venueId.slice(0, 2);
  if (!_venueShards[prefix]) {
    const f = path.join(VENUE_DIR, `${prefix}.json`);
    try { _venueShards[prefix] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; }
    catch (e) { _venueShards[prefix] = {}; }
  }
  return _venueShards[prefix];
}

function storeVenue(venue, court) {
  if (!venue?.id) return;
  const prefix = venue.id.slice(0, 2);
  const shard  = loadVenueShard(venue.id);
  if (!shard[venue.id]) {
    shard[venue.id] = {
      name: venue.name, abbr: venue.abbreviatedName || null,
      lat: venue.latitude || null, lng: venue.longitude || null,
      address: venue.address || null, suburb: venue.suburb || null,
      state: venue.state || null, postcode: venue.postcode || null,
      country: venue.country || null, courts: {},
    };
    _dirtyVenues.add(prefix);
  }
  if (court?.id && !shard[venue.id].courts[court.id]) {
    shard[venue.id].courts[court.id] = { name: court.name, abbr: court.abbreviatedName || null };
    _dirtyVenues.add(prefix);
  }
}

function flushVenueShards() {
  if (!fs.existsSync(VENUE_DIR)) fs.mkdirSync(VENUE_DIR, { recursive: true });
  let count = 0;
  for (const prefix of _dirtyVenues) {
    fs.writeFileSync(path.join(VENUE_DIR, `${prefix}.json`), JSON.stringify(_venueShards[prefix]));
    count++;
  }
  _dirtyVenues.clear();
  return count;
}

// ─── Game file helpers ────────────────────────────────────────────────────────

const _gameFileCache = {};

function loadGameFile(seasonId) {
  if (_gameFileCache[seasonId]) return _gameFileCache[seasonId];
  if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });
  const f = path.join(GAMES_DIR, `${seasonId}.json`);
  try { _gameFileCache[seasonId] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { games: {} }; }
  catch (e) { _gameFileCache[seasonId] = { games: {} }; }
  return _gameFileCache[seasonId];
}

function flushGameFiles() {
  let count = 0;
  for (const [seasonId, sg] of Object.entries(_gameFileCache)) {
    fs.writeFileSync(path.join(GAMES_DIR, `${seasonId}.json`), JSON.stringify(sg));
    count++;
  }
  return count;
}

const PROGRESS_FILE = path.join(__dirname, 'discover-fixtures-progress.json');

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) return new Set(JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')).done || []);
  } catch (e) {}
  return new Set();
}

function saveProgress(done) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }));
}

function clearProgress() {
  try { fs.unlinkSync(PROGRESS_FILE); } catch (e) {}
}

// ─── Git ──────────────────────────────────────────────────────────────────────

function gitCommitPush(message) {
  try {
    // Add and commit all current writes first, then pull, then push
    // Never stash — concurrent writes to same shards cause merge conflicts on pop
    execSync('git add games/ venue-lookup/ team-lookup/ discover-fixtures-progress.json 2>/dev/null || true', { stdio: 'pipe', shell: true });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) { console.log('  (no changes to commit)'); return; }
    execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('  ✓ Committed and pushed');
  } catch (e) {
    console.warn(`  ⚠ Git push failed: ${e.message}`);
  }
}

// ─── Process a single team's fixtures ────────────────────────────────────────

async function processTeam(teamId, seasonId) {
  const data = await gql('TeamFixture', Q_TEAM_FIXTURE, { teamID: teamId });
  if (!data?.discoverTeamFixture) return { added: 0, updated: 0 };

  const team     = data.discoverTeam;
  const rounds   = data.discoverTeamFixture;
  const orgName  = team?.season?.competition?.organisation?.name || '';
  const compName = team?.season?.competition?.name || '';
  const sName    = team?.season?.name || '';
  const gradeName = team?.grade?.name || '';

  // Use grade's season ID if available (more accurate than passed-in seasonId)
  const effectiveSeasonId = rounds[0]?.grade?.season?.id || seasonId;

  // Store team in team-lookup if utils available
  try {
    const { storeLookupEntry, flushLookupShards } = require('./team-lookup-utils');
    if (team?.id) {
      storeLookupEntry({
        id: team.id, name: team.grade?.name ? `${team.id}` : team.id,
        logo: null, organisation: team.organisation,
        grade: team.grade,
        season: team.season,
      });
    }
  } catch (e) {}

  const sg = loadGameFile(effectiveSeasonId);
  let added = 0, updated = 0;

  for (const round of rounds) {
    const roundName    = round.name;
    const isFinalsRound = round.isFinalsRound;
    const roundOrgName  = round.grade?.season?.competition?.organisation?.name || orgName;
    const roundCompName = round.grade?.season?.competition?.name || compName;
    const roundSeasonName = round.grade?.season?.name || sName;
    const roundGradeName  = round.grade?.name || gradeName;

    for (const game of (round.fixture?.games || [])) {
      if (!game?.id) continue;

      const existing  = sg.games[game.id];
      const homeScore = parseScore(game.result?.home?.statistics);
      const awayScore = parseScore(game.result?.away?.statistics);
      const status    = game.status?.value || null;
      const court     = game.allocation?.court;
      const venue     = court?.venue;
      const dt        = game.allocation?.dateTimeList?.[0];
      const time      = dt?.time ? dt.time.slice(0, 5) : null;
      const date      = dt?.date || game.dates?.[0] || existing?.d || null;
      const url       = buildGameUrl(game.id, roundOrgName, roundCompName, roundSeasonName, roundGradeName);

      if (venue) storeVenue(venue, court);

      const entry = {
        d:   date,
        rn:  isFinalsRound ? `Finals — ${roundName}` : roundName,
        h:   game.home?.id   || existing?.h   || null,
        hn:  game.home?.name || existing?.hn  || null,
        a:   game.away?.id   || existing?.a   || null,
        an:  game.away?.name || existing?.an  || null,
        ...(homeScore !== null ? { hs: homeScore } : existing?.hs !== undefined ? { hs: existing.hs } : {}),
        ...(awayScore !== null ? { as: awayScore } : existing?.as !== undefined ? { as: existing.as } : {}),
        ...(venue?.id   ? { vid: venue.id }    : existing?.vid ? { vid: existing.vid } : {}),
        ...(venue?.name ? { vn:  venue.name }  : existing?.vn  ? { vn:  existing.vn  } : {}),
        ...(court?.name ? { ct:  court.name }  : existing?.ct  ? { ct:  existing.ct  } : {}),
        ...(time        ? { t:   time }         : existing?.t   ? { t:   existing.t   } : {}),
        ...(url         ? { url }               : existing?.url ? { url: existing.url } : {}),
        ...(status      ? { st: status }        : {}),
      };

      if (!existing) { sg.games[game.id] = entry; added++; }
      else           { sg.games[game.id] = entry; updated++; }

      // Also store team logo in team-lookup
      try {
        const { storeLookupEntry } = require('./team-lookup-utils');
        const teamSeason = { id: effectiveSeasonId, name: roundSeasonName, status: { value: status },
          competition: { id: null, name: roundCompName, organisation: { id: null, name: roundOrgName } } };
        const teamGrade  = { id: round.grade?.id || null, name: roundGradeName };
        if (game.home?.id) storeLookupEntry({ ...game.home, logo: { sizes: game.home.logo?.sizes }, season: teamSeason, grade: teamGrade });
        if (game.away?.id) storeLookupEntry({ ...game.away, logo: { sizes: game.away.logo?.sizes }, season: teamSeason, grade: teamGrade });
      } catch (e) {}
    }
  }

  return { added, updated };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== discover-fixtures.js ===');
  console.log(`Tenant:      ${TENANT}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Mode:        ${TARGET_SEASON ? `single season ${TARGET_SEASON}` : ALL_SEASONS ? 'all seasons' : 'active only (locked: false)'}\n`);

  if (!fs.existsSync(INDEX_FILE)) { console.error('sports-index.json not found'); process.exit(1); }

  const index   = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const seasons = Object.values(index.seasons || {});

  let targets = seasons;
  if (TARGET_SEASON) {
    targets = seasons.filter(s => s.id === TARGET_SEASON);
    if (targets.length === 0) targets = [{ id: TARGET_SEASON, grades: [] }];
  } else if (!ALL_SEASONS) {
    targets = seasons.filter(s => s.locked === false);
  }

  console.log(`Seasons to process: ${targets.length}`);

  await getSession();

  const doneSeasonsSet = TARGET_SEASON ? new Set() : loadProgress();
  const remaining = targets.filter(s => !doneSeasonsSet.has(s.id));
  if (doneSeasonsSet.size > 0) console.log(`  ↻ Resuming — ${doneSeasonsSet.size} already done, ${remaining.length} remaining`);

  let totalAdded = 0, totalUpdated = 0, totalTeams = 0, seasonsProcessed = 0;
  let sinceLastCommit = 0;

  for (const season of remaining) {
    const seasonId = season.id;
    const grades   = season.grades || [];

    if (grades.length === 0) {
      const data = await gql('DiscoverSeason', `query DiscoverSeason($id: String!) { discoverSeason(seasonID: $id) { id name grades { id name } } }`, { id: seasonId });
      if (data?.discoverSeason?.grades) grades.push(...data.discoverSeason.grades);
    }

    console.log(`\n📅 [${seasonsProcessed + 1}/${remaining.length}] ${season.fullName || season.name || seasonId} (${grades.length} grades)`);

    // Collect all unique team IDs across all grades in this season — parallelised
    const teamIds = new Set();
    for (let i = 0; i < grades.length; i += CONCURRENCY) {
      const batch = grades.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(g => gql('DiscoverGrade', Q_GRADE_TEAMS, { id: g.id })));
      for (const data of results) {
        for (const pool of (data?.discoverGrade?.ladder || [])) {
          for (const s of (pool.standings || [])) {
            if (s.team?.id) teamIds.add(s.team.id);
          }
        }
      }
    }

    console.log(`  Teams: ${teamIds.size}`);

    const teamArr = [...teamIds];
    let seasonAdded = 0, seasonUpdated = 0;

    for (let i = 0; i < teamArr.length; i += CONCURRENCY) {
      const batch = teamArr.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(tid => processTeam(tid, seasonId)));
      for (const r of results) { seasonAdded += r.added; seasonUpdated += r.updated; }
      totalTeams += batch.length;
      process.stdout.write(`  ${Math.min(i + CONCURRENCY, teamArr.length)}/${teamArr.length} teams (${seasonAdded} new, ${seasonUpdated} updated)\r`);
      if (i + CONCURRENCY < teamArr.length) await delay(100);
    }

    console.log(`  ✓ ${seasonAdded} new games, ${seasonUpdated} updated`);
    totalAdded   += seasonAdded;
    totalUpdated += seasonUpdated;
    seasonsProcessed++;
    sinceLastCommit++;
    doneSeasonsSet.add(seasonId);
    saveProgress(doneSeasonsSet);

    if (sinceLastCommit >= 10) {
      const gf = flushGameFiles();
      const vf = flushVenueShards();
      try { const { flushLookupShards } = require('./team-lookup-utils'); flushLookupShards(); } catch (e) {}
      console.log(`\n  💾 Flushed ${gf} game files, ${vf} venue shards — committing...`);
      gitCommitPush(`Fixture discovery: ${seasonsProcessed} seasons, +${totalAdded} games`);
      sinceLastCommit = 0;
    }
  }

  // Final flush
  const gf = flushGameFiles();
  const vf = flushVenueShards();
  try { const { flushLookupShards } = require('./team-lookup-utils'); flushLookupShards(); } catch (e) {}

  console.log(`\n✅ Done`);
  console.log(`  Seasons:  ${seasonsProcessed}`);
  console.log(`  Teams:    ${totalTeams.toLocaleString()}`);
  console.log(`  Added:    ${totalAdded.toLocaleString()}`);
  console.log(`  Updated:  ${totalUpdated.toLocaleString()}`);

  clearProgress();
  gitCommitPush(`Fixture discovery complete: ${seasonsProcessed} seasons, ${totalAdded.toLocaleString()} new games`);
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
