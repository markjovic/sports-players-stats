#!/usr/bin/env node
/**
 * roster-lookup.js — Find registered players for a target grade before games are played
 *
 * WHAT IT DOES:
 *   Phase 1 — Fetch target grade's team list via discoverGrade.ladder (works pre-season)
 *   Phase 2 — Scan player detail files for players with U13/U14 history
 *   Phase 3 — For players lacking a `teams` field, fetch publicProfileTeams and store it
 *   Phase 4 — Cross-reference stored teams against the target grade's team IDs
 *   Phase 5 — Write results: matched players per team
 *
 * USAGE:
 *   node roster-lookup.js --grade=<gradeId>
 *   node roster-lookup.js --grade=<gradeId> --fetch-teams      # also fetch missing teams data
 *   node roster-lookup.js --grade=<gradeId> --force-fetch      # re-fetch teams even if already stored
 *   node roster-lookup.js --grade=<gradeId> --dry-run          # phase 1+2 only, no API calls
 *
 * ARGS:
 *   --grade=<id>       Target grade ID (required). Get from discoverGrade.ladder result.
 *   --fetch-teams      Fetch publicProfileTeams for any U13/U14 player missing teams data
 *   --force-fetch      Re-fetch publicProfileTeams even if already stored (implies --fetch-teams)
 *   --concurrency=N    Max concurrent API requests during fetch phase (default: 20)
 *   --dry-run          Skip all API calls; report coverage from stored data only
 *   --out=<path>       Output file path (default: roster-results/<gradeId>.json)
 *
 * DATA:
 *   Reads:   players/{xx}/{uuid}.json  — player detail files
 *   Writes:  players/{xx}/{uuid}.json  — adds/updates `teams` field
 *            roster-results/<gradeId>.json  — matched player list
 *
 * GRADE TEAM IDs:
 *   Run with --dry-run first to see which team IDs are in the grade, then check
 *   whether your DB has players for those teams in their existing stats.
 *   Run with --fetch-teams to fill in missing publicProfileTeams data.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const _ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const TARGET_GRADE_ID = _ARGS.grade;
if (!TARGET_GRADE_ID) {
  console.error('Error: --grade=<gradeId> is required');
  console.error('  Get grade IDs from discoverGrade.ladder — run a discoverSeason first');
  process.exit(1);
}

const FETCH_TEAMS   = !!(_ARGS['fetch-teams'] ?? _ARGS['force-fetch']);
const FORCE_FETCH   = !!_ARGS['force-fetch'];
const DRY_RUN       = !!_ARGS['dry-run'];
const CONCURRENCY   = parseInt(_ARGS.concurrency || '20', 10);
const OUT_DIR       = path.join(__dirname, 'roster-results');
const OUT_FILE      = _ARGS.out || path.join(OUT_DIR, `${TARGET_GRADE_ID}.json`);

// ─── Paths ────────────────────────────────────────────────────────────────────

const PLAYERS_DIR = path.join(__dirname, 'players');
const COOKIE_FILE = path.join(__dirname, 'explore-cookie.json');
const API_URL     = 'https://api.playhq.com/graphql';

const MOBILE_HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── Age groups and recency filter ────────────────────────────────────────────
// A player qualifies if they have a U13/U14 registration in a RECENT season.
// We extract the year from the season name (e.g. "Winter 2026" → 2026,
// "Summer 2025/26" → 2026, "2025/26" → 2026, "2026" → 2026).
// Players who last played U13/U14 before MIN_SEASON_YEAR are excluded — they've
// aged out and are not relevant to a current team roster search.
const TARGET_AGE_GROUPS = ['U13', 'U14'];
const MIN_SEASON_YEAR   = parseInt(_ARGS['min-year'] || '2024', 10);

function seasonYear(seasonName) {
  if (!seasonName) return 0;
  // "Summer 2025/26" or "2025/26" → take the later year
  const slashMatch = seasonName.match(/(\d{4})\/(\d{2,4})/);
  if (slashMatch) {
    const y1 = parseInt(slashMatch[1]);
    const y2 = slashMatch[2].length === 2 ? Math.floor(y1 / 100) * 100 + parseInt(slashMatch[2]) : parseInt(slashMatch[2]);
    return Math.max(y1, y2);
  }
  // "Winter 2026" or "2026" → take the 4-digit year
  const yearMatch = seasonName.match(/(\d{4})/);
  return yearMatch ? parseInt(yearMatch[1]) : 0;
}

// ─── Cookie ───────────────────────────────────────────────────────────────────

function loadCookie() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const data = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      if (Date.now() - data.fetchedAt < 5 * 60 * 60 * 1000) return data.cookie;
      console.log('  ↻ Cookie expired — refreshing');
    }
  } catch (e) {}
  return null;
}

function saveCookie(cookie) {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie, fetchedAt: Date.now() }));
}

async function fetchCookie() {
  console.log('  Fetching guest session cookie...');
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({
      operationName: 'ProfileSearch',
      variables:     { fullName: 'test user' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id __typename } __typename } }',
    }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No Set-Cookie header — mobile headers may have changed');
  const cookie = raw.split(';')[0];
  console.log(`  ✓ Cookie obtained`);
  saveCookie(cookie);
  return cookie;
}

async function getSession() {
  return loadCookie() || await fetchCookie();
}

// ─── GraphQL helper ───────────────────────────────────────────────────────────

async function gql(operationName, query, variables, cookie) {
  const headers = { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(API_URL, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ operationName, variables, query }),
  });
  if (res.status === 403) throw Object.assign(new Error('403 Forbidden'), { status: 403 });
  if (res.status === 429) throw Object.assign(new Error('429 Rate limit'), { status: 429 });
  const json = await res.json();
  if (json.errors?.length) {
    const msg = json.errors[0].message;
    throw new Error(`GraphQL error: ${msg}`);
  }
  return json.data;
}

// ─── Phase 1: Fetch target grade's teams via ladder ───────────────────────────

const Q_GRADE_LADDER = `
query DiscoverGrade($id: ID!) {
  discoverGrade(gradeID: $id) {
    id
    name
    ladder {
      pool { name }
      standings {
        played
        team { id name }
      }
    }
  }
}`;

async function fetchGradeTeams(gradeId) {
  console.log(`\n📋 Phase 1: Fetching grade teams for grade ${gradeId}...`);
  // Grade ladder is public — no cookie needed
  const data = await gql('DiscoverGrade', Q_GRADE_LADDER, { id: gradeId }, null);
  const grade = data?.discoverGrade;
  if (!grade) throw new Error(`Grade ${gradeId} not found`);

  const teams = [];
  for (const pool of (grade.ladder || [])) {
    for (const entry of (pool.standings || [])) {
      if (entry.team?.id) {
        teams.push({
          id:       entry.team.id,
          name:     entry.team.name,
          pool:     pool.pool?.name || null,
          played:   entry.played,
        });
      }
    }
  }

  console.log(`  Grade: "${grade.name}"`);
  console.log(`  Teams (${teams.length}):`);
  for (const t of teams) {
    const poolStr = t.pool ? ` [${t.pool}]` : '';
    const playedStr = t.played > 0 ? ` — ${t.played} games played` : ' — pre-season';
    console.log(`    ${t.id}  ${t.name}${poolStr}${playedStr}`);
  }

  return { gradeId, gradeName: grade.name, teams };
}

// ─── Phase 2: Scan player files for U13/U14 history ──────────────────────────

function playerFile(uuid) {
  return path.join(PLAYERS_DIR, uuid.slice(0, 2), `${uuid}.json`);
}

function hasRecentTargetAgeHistory(detail) {
  for (const season of (detail.seasons || [])) {
    const yr = seasonYear(season.sn);
    if (yr < MIN_SEASON_YEAR) continue;   // too old — skip
    for (const reg of (season.regs || [])) {
      // reg.age is the parsed age group e.g. "U14"
      if (reg.age && TARGET_AGE_GROUPS.includes(reg.age)) return true;
      // Fallback: check grade name for older records where age may be absent
      if (reg.gn && TARGET_AGE_GROUPS.some(ag => reg.gn.toUpperCase().includes(ag))) return true;
    }
  }
  return false;
}

function scanPlayersDir() {
  console.log(`\n🔍 Phase 2: Scanning player files for ${TARGET_AGE_GROUPS.join('/')} history (${MIN_SEASON_YEAR}+)...`);
  if (!fs.existsSync(PLAYERS_DIR)) {
    console.error(`  ERROR: players/ directory not found at ${PLAYERS_DIR}`);
    process.exit(1);
  }

  const shards = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/i.test(d));
  let total = 0;
  let qualified = 0;
  let hasTeamsStored = 0;
  const players = []; // { uuid, name, detail, hasTeams }

  for (const shard of shards) {
    const shardDir = path.join(PLAYERS_DIR, shard);
    const files = fs.readdirSync(shardDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      total++;
      let detail;
      try {
        detail = JSON.parse(fs.readFileSync(path.join(shardDir, f), 'utf8'));
      } catch (e) {
        continue;
      }
      if (!hasRecentTargetAgeHistory(detail)) continue;
      qualified++;
      const hasTeams = Array.isArray(detail.teams);
      if (hasTeams) hasTeamsStored++;
      players.push({ uuid: detail.uuid, name: detail.name, detail, hasTeams });
    }
  }

  console.log(`  Total players scanned: ${total.toLocaleString()}`);
  console.log(`  With ${TARGET_AGE_GROUPS.join('/')} history (${MIN_SEASON_YEAR}+): ${qualified.toLocaleString()}`);
  console.log(`  Already have teams stored: ${hasTeamsStored.toLocaleString()}`);
  console.log(`  Missing teams data: ${(qualified - hasTeamsStored).toLocaleString()}`);

  return players;
}

// ─── Phase 3: Fetch publicProfileTeams for players missing teams data ─────────

const Q_PROFILE_TEAMS = `
query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    id
    name
    organisation { id name }
    grade { id name }
    season {
      id
      name
      startDate
      endDate
      status { name value }
      competition { id name }
    }
  }
}`;

async function fetchTeamsForPlayer(uuid, cookie) {
  const data = await gql('PublicProfileTeams', Q_PROFILE_TEAMS, { profileID: uuid }, cookie);
  return data?.publicProfileTeams || [];
}

async function fetchMissingTeams(players, cookie) {
  const toFetch = FORCE_FETCH
    ? players
    : players.filter(p => !p.hasTeams);

  if (toFetch.length === 0) {
    console.log('\n⚡ Phase 3: All qualifying players already have teams stored — skipping fetch');
    return;
  }

  console.log(`\n🌐 Phase 3: Fetching publicProfileTeams for ${toFetch.length.toLocaleString()} players...`);
  if (FORCE_FETCH) console.log('  (--force-fetch: re-fetching even already-stored entries)');

  let done = 0;
  let errors = 0;
  let updated = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (p) => {
      try {
        const teams = await fetchTeamsForPlayer(p.uuid, cookie);

        // Reload the detail file to avoid stale data
        const pf = playerFile(p.uuid);
        let detail;
        try {
          detail = JSON.parse(fs.readFileSync(pf, 'utf8'));
        } catch (e) {
          detail = p.detail; // fall back to in-memory copy
        }

        detail.teams = teams;
        detail.teamsUpdatedAt = new Date().toISOString();
        fs.writeFileSync(pf, JSON.stringify(detail));

        // Update in-memory copy so Phase 4 can use it without re-reading
        p.detail = detail;
        p.hasTeams = true;
        updated++;
      } catch (e) {
        // 403 on individual player = profile is private or deleted — not fatal
        if (e.status !== 403) {
          errors++;
          console.warn(`  ⚠ ${p.uuid} (${p.name}): ${e.message}`);
        }
      }
    }));

    done += batch.length;
    if (done % 500 === 0 || done === toFetch.length) {
      process.stdout.write(`  ${done}/${toFetch.length} (${updated} updated, ${errors} errors)\r`);
    }

    // Small delay between batches to avoid hammering the API
    if (i + CONCURRENCY < toFetch.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log(`\n  ✓ Fetched teams for ${updated} players (${errors} errors)`);
}

// ─── Phase 4: Cross-reference teams against target grade ─────────────────────

function matchPlayers(players, gradeTeams) {
  console.log('\n🎯 Phase 4: Cross-referencing stored teams against grade team list...');

  const targetTeamIds = new Set(gradeTeams.teams.map(t => t.id));

  // Map from teamId → team info for quick lookup
  const teamById = Object.fromEntries(gradeTeams.teams.map(t => [t.id, t]));

  // Results: teamId → list of matched players
  const roster = Object.fromEntries(gradeTeams.teams.map(t => [t.id, {
    team: t,
    players: [],
  }]));

  let matchedPlayers = 0;
  let noTeamsData = 0;

  for (const p of players) {
    if (!Array.isArray(p.detail?.teams)) {
      noTeamsData++;
      continue;
    }

    for (const reg of p.detail.teams) {
      if (!reg?.grade?.id) continue;
      if (!targetTeamIds.has(reg.id)) continue; // team ID not in this grade

      // Also check the grade matches (belt and braces — team IDs should be unique per grade/season)
      // but grade.id from publicProfileTeams can differ from our target grade if a team is in
      // multiple grades. We want only registrations for THIS grade.
      // Note: publicProfileTeams returns team+grade per registration, so reg.grade.id is the grade
      // the player is registered in for that team.
      // We check against TARGET_GRADE_ID here.
      if (reg.grade?.id !== TARGET_GRADE_ID) continue;

      roster[reg.id].players.push({
        uuid:      p.uuid,
        name:      p.name,
        seasonId:  reg.season?.id,
        seasonName: reg.season?.name,
        seasonStatus: reg.season?.status?.value,
      });
      matchedPlayers++;
      break; // one match per player per team is enough
    }
  }

  console.log(`  Matched: ${matchedPlayers} player registrations across ${gradeTeams.teams.length} teams`);
  console.log(`  Players with no teams data: ${noTeamsData} (run with --fetch-teams to fill)`);

  return roster;
}

// ─── Phase 5: Report ──────────────────────────────────────────────────────────

function writeResults(gradeTeams, roster, players) {
  const totalMatched = Object.values(roster).reduce((n, t) => n + t.players.length, 0);
  const coverage = players.filter(p => p.hasTeams).length;

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const output = {
    gradeId:    gradeTeams.gradeId,
    gradeName:  gradeTeams.gradeName,
    generatedAt: new Date().toISOString(),
    coverage: {
      qualifyingPlayers: players.length,
      withTeamsData: coverage,
      withoutTeamsData: players.length - coverage,
    },
    roster,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\n📊 Results:`);
  console.log(`  Grade: ${gradeTeams.gradeName} (${gradeTeams.gradeId})`);
  console.log(`  Total matched players: ${totalMatched}`);
  console.log(`  Coverage: ${coverage}/${players.length} qualifying players have teams data`);
  console.log();

  for (const [teamId, entry] of Object.entries(roster)) {
    const { team, players: tp } = entry;
    const poolStr = team.pool ? ` [${team.pool}]` : '';
    console.log(`  ${team.name}${poolStr} (${teamId}) — ${tp.length} player(s)`);
    for (const p of tp) {
      const statusStr = p.seasonStatus === 'UPCOMING' ? ' 📅' : p.seasonStatus === 'ACTIVE' ? ' ✅' : '';
      console.log(`    ${p.uuid}  ${p.name}${statusStr}`);
    }
  }

  console.log(`\n💾 Written to: ${OUT_FILE}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== roster-lookup.js ===');
  console.log(`Target grade:  ${TARGET_GRADE_ID}`);
  console.log(`Fetch teams:   ${FETCH_TEAMS ? (FORCE_FETCH ? 'yes (force)' : 'yes (missing only)') : 'no'}`);
  console.log(`Dry run:       ${DRY_RUN}`);
  console.log(`Concurrency:   ${CONCURRENCY}`);
  console.log(`Age filter:    ${TARGET_AGE_GROUPS.join(', ')} in ${MIN_SEASON_YEAR}+`);

  // Phase 1: get teams in target grade
  let gradeTeams;
  if (DRY_RUN) {
    console.log('\n[DRY RUN] Skipping grade API call — use --grade with a real grade ID');
    gradeTeams = { gradeId: TARGET_GRADE_ID, gradeName: '(dry run)', teams: [] };
  } else {
    gradeTeams = await fetchGradeTeams(TARGET_GRADE_ID);
  }

  if (gradeTeams.teams.length === 0 && !DRY_RUN) {
    console.error('\nNo teams found in this grade. Check the grade ID.');
    process.exit(1);
  }

  // Phase 2: scan player files
  const players = scanPlayersDir();

  if (players.length === 0) {
    console.log('\nNo qualifying players found. DB may be empty or not yet crawled.');
    process.exit(0);
  }

  // Phase 3: fetch missing teams (if requested)
  if (FETCH_TEAMS && !DRY_RUN) {
    const cookie = await getSession();
    await fetchMissingTeams(players, cookie);
  } else if (!FETCH_TEAMS) {
    const missing = players.filter(p => !p.hasTeams).length;
    if (missing > 0) {
      console.log(`\n  ℹ ${missing} players lack teams data. Run with --fetch-teams to populate.`);
    }
  }

  // Phase 4: cross-reference
  const roster = matchPlayers(players, gradeTeams);

  // Phase 5: report
  writeResults(gradeTeams, roster, players);
}

main().catch(e => {
  console.error('\nFatal error:', e.message);
  process.exit(1);
});
