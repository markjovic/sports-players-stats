#!/usr/bin/env node
// discover-fixtures.js
/**
 * Discovers fixtures (past and future) for all active/upcoming seasons using
 * discoverFixtureByRound — the most efficient endpoint for bulk game data.
 *
 * For each active/upcoming season in sports-index.json:
 *   1. Calls discoverSeason to get grade list
 *   2. Calls discoverGrade to get rounds
 *   3. Calls discoverFixtureByRound for each round
 *   4. Writes/updates game entries in games/bv/{seasonId}.json with:
 *      - Scores (hs, as)
 *      - Venue (vid, vn, ct, t)
 *      - Team IDs and names (h, hn, a, an)
 *      - Round name (rn)
 *      - Game status
 *      - Constructed PlayHQ URL (url)
 *   5. Populates venue-lookup/{prefix}.json shards
 *
 * Safe to re-run — only updates entries missing venue/time data or unplayed games.
 *
 * Usage:
 *   node discover-fixtures.js                        # all active/upcoming seasons
 *   node discover-fixtures.js --season=<id>          # single season
 *   node discover-fixtures.js --all-seasons          # include completed seasons too
 *   node discover-fixtures.js --concurrency=10
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

const TENANT       = ARGS.tenant   || 'bv';
const TENANT_FULL  = { bv: 'basketball-victoria', afl: 'afl' }[TENANT] || TENANT;
const CONCURRENCY  = parseInt(ARGS.concurrency || '10', 10);
const TARGET_SEASON = ARGS.season  || null;
const ALL_SEASONS  = !!ARGS['all-seasons'];

const API_URL      = 'https://api.playhq.com/graphql';
const GAMES_DIR    = path.join(__dirname, 'games', TENANT);
const VENUE_DIR    = path.join(__dirname, 'venue-lookup');
const INDEX_FILE   = path.join(__dirname, 'sports-index.json');
const COOKIE_FILE  = path.join(__dirname, `cookie-${TENANT}.json`);

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

function loadCookie() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const d = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      if (Date.now() - d.fetchedAt < 5 * 60 * 60 * 1000) return d.cookie;
    }
  } catch (e) {}
  return null;
}

async function getSession() {
  if (_cookie) return _cookie;
  _cookie = loadCookie();
  if (_cookie) return _cookie;
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
  if (!raw) throw new Error('No Set-Cookie — mobile headers may have changed');
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
      if (!res.ok) {
        if (attempts++ < 2) { await delay(5000); continue; }
        return null;
      }
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

const Q_SEASON = `
query DiscoverSeason($id: String!) {
  discoverSeason(seasonID: $id) {
    id name
    competition { id name organisation { id name } }
    grades { id name age { name } gender { name } }
  }
}`;

const Q_GRADE = `
query DiscoverGrade($id: ID!) {
  discoverGrade(gradeID: $id) {
    id name
    rounds { id name number isFinalsRound }
  }
}`;

const Q_FIXTURE = `
query DiscoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    byes
    games {
      id date
      status { value }
      home {
        id name
        logo { sizes { url dimensions { width height } } }
        organisation { id name }
        season { id name competition { id name } }
      }
      away {
        id name
        logo { sizes { url dimensions { width height } } }
        organisation { id name }
        season { id name competition { id name } }
      }
      result {
        home { outcome { value } statistics { count type { value } } }
        away { outcome { value } statistics { count type { value } } }
      }
      allocation {
        time
        court {
          id name abbreviatedName
          venue {
            id name abbreviatedName
            latitude longitude
            address suburb state postcode country
          }
        }
      }
      isStale
    }
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
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

const _venueShards  = {};
const _dirtyVenues  = new Set();

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
  const shard = loadVenueShard(venue.id);
  if (!shard[venue.id]) {
    shard[venue.id] = {
      name:    venue.name,
      abbr:    venue.abbreviatedName || null,
      lat:     venue.latitude  || null,
      lng:     venue.longitude || null,
      address: venue.address   || null,
      suburb:  venue.suburb    || null,
      state:   venue.state     || null,
      postcode: venue.postcode || null,
      country: venue.country   || null,
      courts:  {},
    };
    _dirtyVenues.add(venue.id.slice(0, 2));
  }
  if (court?.id && !shard[venue.id].courts[court.id]) {
    shard[venue.id].courts[court.id] = {
      name: court.name,
      abbr: court.abbreviatedName || null,
    };
    _dirtyVenues.add(venue.id.slice(0, 2));
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

function loadGameFile(seasonId) {
  if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });
  const f = path.join(GAMES_DIR, `${seasonId}.json`);
  try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { games: {} }; }
  catch (e) { return { games: {} }; }
}

function saveGameFile(seasonId, sg) {
  fs.writeFileSync(path.join(GAMES_DIR, `${seasonId}.json`), JSON.stringify(sg));
}

// ─── Git ──────────────────────────────────────────────────────────────────────

function gitCommitPush(message) {
  try {
    execSync('git add games/ venue-lookup/', { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) { console.log('  (no changes to commit)'); return; }
    execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
    const stashOut = execSync('git stash', { stdio: 'pipe' }).toString();
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    if (stashOut.includes('Saved')) execSync('git stash pop', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('  ✓ Committed and pushed');
  } catch (e) {
    console.warn(`  ⚠ Git push failed: ${e.message}`);
  }
}

// ─── Process a single round ───────────────────────────────────────────────────

async function processRound(round, seasonId, gradeName, compName, seasonName, orgName, sgCache) {
  const data = await gql('DiscoverFixtureByRound', Q_FIXTURE, { roundID: round.id });
  if (!data?.discoverFixtureByRound) return { added: 0, updated: 0, skipped: 0 };

  const { games, byes } = data.discoverFixtureByRound;
  const gameCount = (games || []).length;
  if (gameCount === 0) return { added: 0, updated: 0, skipped: 1 };
  const sg = sgCache[seasonId] = sgCache[seasonId] || loadGameFile(seasonId);
  let added = 0, updated = 0, skipped = 0;

  for (const game of (games || [])) {
    if (!game?.id) continue;

    const existing   = sg.games[game.id];
    const homeScore  = parseScore(game.result?.home?.statistics);
    const awayScore  = parseScore(game.result?.away?.statistics);
    const status     = game.status?.value || null;
    const court      = game.allocation?.court;
    const venue      = court?.venue;
    const time       = game.allocation?.time ? game.allocation.time.slice(0, 5) : null;
    const url        = buildGameUrl(game.id, orgName, compName, seasonName, gradeName);

    // Store venue in lookup shard
    if (venue) storeVenue(venue, court);

    // Build updated entry
    const entry = {
      d:   game.date || existing?.d || null,
      rn:  round.name,
      h:   game.home?.id   || existing?.h   || null,
      hn:  game.home?.name || existing?.hn  || null,
      a:   game.away?.id   || existing?.a   || null,
      an:  game.away?.name || existing?.an  || null,
      // Scores — only write if present
      ...(homeScore !== null ? { hs: homeScore } : existing?.hs !== undefined ? { hs: existing.hs } : {}),
      ...(awayScore !== null ? { as: awayScore } : existing?.as !== undefined ? { as: existing.as } : {}),
      // Venue/time
      ...(venue?.id   ? { vid: venue.id }    : existing?.vid ? { vid: existing.vid } : {}),
      ...(venue?.name ? { vn:  venue.name }  : existing?.vn  ? { vn:  existing.vn  } : {}),
      ...(court?.name ? { ct:  court.name }  : existing?.ct  ? { ct:  existing.ct  } : {}),
      ...(time        ? { t:   time }         : existing?.t   ? { t:   existing.t   } : {}),
      ...(url         ? { url }               : existing?.url ? { url: existing.url } : {}),
      ...(status      ? { st: status }        : {}),
    };

    // Also store home/away logo in team-lookup via shared util if available
    // (team-lookup-utils handles dedup, so safe to call repeatedly)
    try {
      const { storeLookupEntry } = require('./team-lookup-utils');
      if (game.home?.id) storeLookupEntry({ ...game.home, season: { id: seasonId, name: seasonName, status: { value: status }, competition: { id: null, name: compName, organisation: { id: null, name: orgName } } }, grade: { id: null, name: gradeName } });
      if (game.away?.id) storeLookupEntry({ ...game.away, season: { id: seasonId, name: seasonName, status: { value: status }, competition: { id: null, name: compName, organisation: { id: null, name: orgName } } }, grade: { id: null, name: gradeName } });
    } catch (e) { /* team-lookup-utils optional */ }

    if (!existing) {
      sg.games[game.id] = entry;
      added++;
    } else {
      sg.games[game.id] = entry;
      updated++;
    }
  }

  return { added, updated, skipped };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== discover-fixtures.js ===');
  console.log(`Tenant:      ${TENANT}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Mode:        ${TARGET_SEASON ? `single season ${TARGET_SEASON}` : ALL_SEASONS ? 'all seasons' : 'active/upcoming only'}\n`);

  if (!fs.existsSync(INDEX_FILE)) {
    console.error('sports-index.json not found');
    process.exit(1);
  }

  const index   = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const seasons = index.seasons || {};

  // Select seasons to process
  let targets = Object.values(seasons);
  if (TARGET_SEASON) {
    targets = targets.filter(s => s.id === TARGET_SEASON || s.seasonId === TARGET_SEASON);
    if (targets.length === 0) {
      // Target might not be in index — add it
      targets = [{ id: TARGET_SEASON, seasonId: TARGET_SEASON }];
    }
  } else if (!ALL_SEASONS) {
    targets = targets.filter(s => !s.discovered && (s.status === 'ACTIVE' || s.status === 'UPCOMING' || !s.status));
  }

  console.log(`Seasons to process: ${targets.length}`);

  let totalAdded = 0, totalUpdated = 0, totalRounds = 0, totalSeasons = 0;
  const sgCache = {};
  let sinceLastCommit = 0;

  // Get session upfront
  await getSession();

  for (const season of targets) {
    const seasonId = season.id || season.seasonId;
    if (!seasonId) continue;

    // Fetch season grade list
    const seasonData = await gql('DiscoverSeason', Q_SEASON, { id: seasonId });
    if (!seasonData?.discoverSeason) {
      console.log(`  ⚠ Season ${seasonId} not found — skipping`);
      continue;
    }

    const s        = seasonData.discoverSeason;
    const compName = s.competition?.name || '';
    const seasonName = s.name || '';
    const orgName  = s.competition?.organisation?.name || '';

    console.log(`\n📅 ${seasonName} — ${compName} (${s.grades.length} grades)`);

    for (const grade of s.grades) {
      // Fetch round list
      const gradeData = await gql('DiscoverGrade', Q_GRADE, { id: grade.id });
      if (!gradeData?.discoverGrade?.rounds?.length) continue;

      const rounds = gradeData.discoverGrade.rounds;
      process.stdout.write(`  Grade: ${grade.name} — ${rounds.length} rounds...`);

      let gradeAdded = 0, gradeUpdated = 0;

      // Process rounds in batches
      for (let i = 0; i < rounds.length; i += CONCURRENCY) {
        const batch = rounds.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(r => processRound(r, seasonId, grade.name, compName, seasonName, orgName, sgCache))
        );
        for (const r of results) {
          gradeAdded   += r.added;
          gradeUpdated += r.updated;
          totalRounds++;
        }
        if (i + CONCURRENCY < rounds.length) await delay(200);
      }

      console.log(` +${gradeAdded} new, ~${gradeUpdated} updated (${rounds.length - gradeAdded - gradeUpdated} empty rounds)`);
      totalAdded   += gradeAdded;
      totalUpdated += gradeUpdated;
    }

    // Save game files for this season
    for (const [sid, sg] of Object.entries(sgCache)) {
      saveGameFile(sid, sg);
      delete sgCache[sid];
    }

    totalSeasons++;
    sinceLastCommit++;

    if (sinceLastCommit >= 5) {
      const vFlushed = flushVenueShards();
      try { const { flushLookupShards } = require('./team-lookup-utils'); flushLookupShards(); } catch (e) {}
      console.log(`\n  💾 Committing after ${sinceLastCommit} seasons (${vFlushed} venue shards)...`);
      gitCommitPush(`Fixture discovery: ${totalSeasons} seasons, +${totalAdded} games`);
      sinceLastCommit = 0;
    }
  }

  // Final flush and commit
  for (const [sid, sg] of Object.entries(sgCache)) saveGameFile(sid, sg);
  const vFlushed = flushVenueShards();
  try { const { flushLookupShards } = require('./team-lookup-utils'); flushLookupShards(); } catch (e) {}

  console.log(`\n✅ Done`);
  console.log(`  Seasons processed: ${totalSeasons}`);
  console.log(`  Rounds processed:  ${totalRounds}`);
  console.log(`  Games added:       ${totalAdded.toLocaleString()}`);
  console.log(`  Games updated:     ${totalUpdated.toLocaleString()}`);
  console.log(`  Venue shards:      ${vFlushed}`);

  gitCommitPush(`Fixture discovery complete: ${totalSeasons} seasons, ${totalAdded.toLocaleString()} new games`);
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
