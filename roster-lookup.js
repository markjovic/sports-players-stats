#!/usr/bin/env node
// roster-lookup.js
/**
 * roster-lookup.js — Find registered players for a grade, team, or competition
 *
 * MODES (exactly one required):
 *   --grade=<id>    Look up a single grade by ID — lists all teams and their registered players
 *   --team=<id>     Look up a single team — finds its active/upcoming grade, then shows all opposition
 *   --comp=<id>     Look up a whole competition (season ID) — shows full roster breakdown for every grade
 *
 * FETCH OPTIONS:
 *   --fetch-teams   Fetch publicProfileTeams for players missing that data
 *   --force-fetch   Re-fetch publicProfileTeams for all players (implies --fetch-teams)
 *   --concurrency=N Max concurrent API requests (default: 200)
 *   --dry-run       Skip all API calls; report coverage from stored data only
 *
 * All players in the DB are scanned regardless of age group or season history.
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const _ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const TARGET_GRADE_ID = _ARGS.grade  || null;
const TARGET_TEAM_ID  = _ARGS.team   || null;
const TARGET_COMP_ID  = _ARGS.comp   || null;

const modeCount = [TARGET_GRADE_ID, TARGET_TEAM_ID, TARGET_COMP_ID].filter(Boolean).length;
if (modeCount === 0) {
  console.error('Error: one of --grade=<id>, --team=<id>, or --comp=<id> is required');
  process.exit(1);
}
if (modeCount > 1) {
  console.error('Error: only one of --grade, --team, --comp may be specified');
  process.exit(1);
}

const MODE        = TARGET_GRADE_ID ? 'grade' : TARGET_TEAM_ID ? 'team' : 'comp';
const FETCH_TEAMS = !!(_ARGS['fetch-teams'] ?? _ARGS['force-fetch']);
const FORCE_FETCH = !!_ARGS['force-fetch'];
const DRY_RUN     = !!_ARGS['dry-run'];
const CONCURRENCY = parseInt(_ARGS.concurrency || '200', 10);
const OUT_DIR     = path.join(__dirname, 'roster-results');

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
  console.log('  Fetching session cookie...');
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({
      operationName: 'ProfileSearch',
      variables:     { fullName: 'test user' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id __typename } } }',
    }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No Set-Cookie header — mobile headers may have changed');
  const cookie = raw.split(';')[0];
  console.log('  ✓ Cookie obtained');
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
  if (json.errors?.length) throw new Error(`GraphQL error: ${json.errors[0].message}`);
  return json.data;
}

// ─── GraphQL queries ──────────────────────────────────────────────────────────

const Q_GRADE_LADDER = `
query DiscoverGrade($id: ID!) {
  discoverGrade(gradeID: $id) {
    id name
    ladder {
      pool { name }
      standings { played team { id name } }
    }
  }
}`;

const Q_DISCOVER_SEASON = `
query DiscoverSeason($id: String!) {
  discoverSeason(seasonID: $id) {
    id name
    grades { id name age { name } gender { name } }
  }
}`;

const Q_PROFILE_TEAMS = `
query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    id name
    organisation { id name }
    grade { id name }
    season {
      id name startDate endDate
      status { name value }
      competition { id name }
    }
  }
}`;

// ─── Phase 1: Resolve target into a list of { gradeId, gradeName, teams[] } ──

async function fetchGradeTeams(gradeId, cookie) {
  const data = await gql('DiscoverGrade', Q_GRADE_LADDER, { id: gradeId }, cookie);
  const grade = data?.discoverGrade;
  if (!grade) throw new Error(`Grade ${gradeId} not found`);
  const teams = [];
  for (const pool of (grade.ladder || [])) {
    for (const entry of (pool.standings || [])) {
      if (entry.team?.id) teams.push({
        id:     entry.team.id,
        name:   entry.team.name,
        pool:   pool.pool?.name || null,
        played: entry.played,
      });
    }
  }
  return { gradeId: grade.id, gradeName: grade.name, teams };
}

async function resolveTargets(cookie) {
  if (MODE === 'grade') {
    console.log(`\n📋 Phase 1: Fetching grade ${TARGET_GRADE_ID}...`);
    const cacheFile = path.join(OUT_DIR, `${TARGET_GRADE_ID}-grade.json`);
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      console.log(`  Using cached data — "${cached.gradeName}" (${cached.teams.length} teams)`);
      return [cached];
    }
    const result = await fetchGradeTeams(TARGET_GRADE_ID, cookie);
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(result));
    printGradeTeams(result);
    return [result];
  }

  if (MODE === 'team') {
    // Resolve team → grade by searching stored teams data on any player registered to this team
    console.log(`\n📋 Phase 1: Resolving team ${TARGET_TEAM_ID} to grade...`);
    const gradeId = resolveGradeFromStoredTeams(TARGET_TEAM_ID);
    if (!gradeId) throw new Error(
      `Could not resolve team ${TARGET_TEAM_ID} to a grade from stored data.\n` +
      `Run with --fetch-teams first to populate teams data, then retry.`
    );
    console.log(`  Resolved to grade ${gradeId} — fetching full grade...`);
    const result = await fetchGradeTeams(gradeId, cookie);
    printGradeTeams(result);
    return [result];
  }

  if (MODE === 'comp') {
    // Resolve comp (season ID) → all grades → all teams
    console.log(`\n📋 Phase 1: Fetching all grades in season/comp ${TARGET_COMP_ID}...`);
    const data = await gql('DiscoverSeason', Q_DISCOVER_SEASON, { id: TARGET_COMP_ID }, cookie);
    const season = data?.discoverSeason;
    if (!season) throw new Error(`Season/comp ${TARGET_COMP_ID} not found`);
    console.log(`  Season: "${season.name}" — ${season.grades.length} grades`);
    const results = [];
    for (const grade of season.grades) {
      process.stdout.write(`  Fetching grade "${grade.name}"...`);
      try {
        const result = await fetchGradeTeams(grade.id, cookie);
        console.log(` ${result.teams.length} teams`);
        results.push(result);
      } catch (e) {
        console.log(` ⚠ ${e.message}`);
      }
    }
    console.log(`  Resolved ${results.length} grades`);
    return results;
  }
}

function resolveGradeFromStoredTeams(teamId) {
  // Scan player files to find a player registered to this team, extract grade ID
  if (!fs.existsSync(PLAYERS_DIR)) return null;
  const shards = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/i.test(d));
  for (const shard of shards) {
    const shardDir = path.join(PLAYERS_DIR, shard);
    for (const f of fs.readdirSync(shardDir).filter(f => f.endsWith('.json'))) {
      let detail;
      try { detail = JSON.parse(fs.readFileSync(path.join(shardDir, f), 'utf8')); } catch (e) { continue; }
      if (!Array.isArray(detail.teams)) continue;
      for (const reg of detail.teams) {
        if (reg.id === teamId && reg.grade?.id) return reg.grade.id;
      }
    }
  }
  return null;
}

function printGradeTeams(gradeTeams) {
  console.log(`  Grade: "${gradeTeams.gradeName}"`);
  console.log(`  Teams (${gradeTeams.teams.length}):`);
  for (const t of gradeTeams.teams) {
    const poolStr   = t.pool   ? ` [${t.pool}]`              : '';
    const playedStr = t.played > 0 ? ` — ${t.played} games played` : ' — pre-season';
    console.log(`    ${t.id}  ${t.name}${poolStr}${playedStr}`);
  }
}

// ─── Phase 2: Scan all player files ───────────────────────────────────────────

function playerFile(uuid) {
  return path.join(PLAYERS_DIR, uuid.slice(0, 2), `${uuid}.json`);
}

function scanPlayersDir() {
  console.log('\n🔍 Phase 2: Scanning player files...');
  if (!fs.existsSync(PLAYERS_DIR)) {
    console.error(`  ERROR: players/ directory not found at ${PLAYERS_DIR}`);
    process.exit(1);
  }

  const shards = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/i.test(d));
  let total = 0, hasTeamsStored = 0;
  const players = [];

  for (const shard of shards) {
    const shardDir = path.join(PLAYERS_DIR, shard);
    for (const f of fs.readdirSync(shardDir).filter(f => f.endsWith('.json'))) {
      total++;
      let detail;
      try { detail = JSON.parse(fs.readFileSync(path.join(shardDir, f), 'utf8')); } catch (e) { continue; }
      const hasTeams = Array.isArray(detail.teams);
      if (hasTeams) hasTeamsStored++;
      players.push({ uuid: detail.uuid, name: detail.name, detail, hasTeams });
    }
  }

  console.log(`  Total players scanned: ${total.toLocaleString()}`);
  console.log(`  Already have teams stored: ${hasTeamsStored.toLocaleString()}`);
  console.log(`  Missing teams data: ${(total - hasTeamsStored).toLocaleString()}`);
  return players;
}

// ─── Phase 3: Fetch publicProfileTeams for players missing teams data ─────────

const PROGRESS_FILE = path.join(__dirname, 'roster-teams-progress.json');
let _concurrency    = CONCURRENCY;
let _concurrencyCap = CONCURRENCY;
let _streak429      = 0;

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (e) {}
  return null;
}

function saveProgress(pending, done) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ pending, done, savedAt: new Date().toISOString() }));
}

function clearProgress() {
  try { fs.unlinkSync(PROGRESS_FILE); } catch (e) {}
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function gitCommitPush(message) {
  try {
    execSync('git add players/ roster-teams-progress.json', { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) { console.log('  (no changes to commit)'); return; }
    execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
    execSync('git stash', { stdio: 'pipe' });
    execSync('git pull --rebase origin main', { stdio: 'pipe' });
    execSync('git stash pop', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('  ✓ Committed and pushed');
  } catch (e) {
    console.warn(`  ⚠ Git commit/push failed: ${e.message}`);
  }
}

async function fetchTeamsWithRetry(uuid, cookie) {
  let attempts = 0;
  while (true) {
    try {
      const data = await gql('PublicProfileTeams', Q_PROFILE_TEAMS, { profileID: uuid }, cookie);
      _streak429 = 0;
      return data?.publicProfileTeams || [];
    } catch (e) {
      if (e.status === 403) throw e;
      if (e.status === 429) {
        attempts++;
        _streak429++;
        _concurrency = Math.max(5, Math.floor(_concurrency * 0.6));
        if (_streak429 >= 3) {
          _concurrencyCap = Math.max(5, _concurrencyCap - 5);
          _concurrency    = Math.min(_concurrency, _concurrencyCap);
          _streak429      = 0;
          console.warn(`\n  ⚠ Repeated 429s — cap lowered to ${_concurrencyCap}, concurrency now ${_concurrency}`);
        } else {
          console.warn(`\n  ⚠ 429 rate limit — concurrency → ${_concurrency}, retrying in ${attempts * 5}s`);
        }
        await delay(attempts * 5000);
        continue;
      }
      if (e.message?.includes('5') && attempts < 1) {
        attempts++;
        console.warn(`\n  ⚠ Server error for ${uuid} — retry 1/1`);
        await delay(10000);
        continue;
      }
      throw Object.assign(e, { transient: true });
    }
  }
}

async function fetchMissingTeams(players, cookie) {
  const toFetch = FORCE_FETCH ? players : players.filter(p => !p.hasTeams);
  if (toFetch.length === 0) {
    console.log('\n⚡ Phase 3: All players already have teams stored — skipping fetch');
    return;
  }
  console.log(`\n🌐 Phase 3: Fetching publicProfileTeams for ${toFetch.length.toLocaleString()} players...`);
  if (FORCE_FETCH) console.log('  (--force-fetch: re-fetching all)');

  const saved   = loadProgress();
  const doneSet = new Set(saved?.done || []);
  if (doneSet.size > 0) console.log(`  ↻ Resuming — ${doneSet.size.toLocaleString()} already done`);

  const pending  = toFetch.filter(p => !doneSet.has(p.uuid));
  const doneList = [...doneSet];
  let updated = 0, errors = 0, sinceLastSave = 0;
  console.log(`  ${pending.length.toLocaleString()} remaining to fetch`);

  for (let i = 0; i < pending.length; i += _concurrency) {
    const batch = pending.slice(i, i + _concurrency);
    await Promise.all(batch.map(async (p) => {
      try {
        const teams = await fetchTeamsWithRetry(p.uuid, cookie);
        const pf = playerFile(p.uuid);
        let detail;
        try { detail = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch (e) { detail = p.detail; }
        detail.teams          = teams;
        detail.teamsUpdatedAt = new Date().toISOString();
        fs.writeFileSync(pf, JSON.stringify(detail));
        p.detail = detail; p.hasTeams = true;
        updated++;
      } catch (e) {
        if (e.status !== 403) { errors++; console.warn(`\n  ⚠ ${p.uuid} (${p.name}): ${e.message}`); }
        if (!e.transient) doneList.push(p.uuid);
        return;
      }
      doneList.push(p.uuid);
      sinceLastSave++;
    }));

    if (sinceLastSave >= Math.max(1000, _concurrency * 25)) {
      saveProgress(pending.slice(i + _concurrency).map(p => p.uuid), doneList);
      sinceLastSave = 0;
      console.log(`\n  💾 Progress saved (${doneList.length.toLocaleString()} done) — committing to repo...`);
      await gitCommitPush(`Teams fetch progress: ${doneList.length.toLocaleString()}/${toFetch.length.toLocaleString()} players`);
    }

    const done = Math.min(i + _concurrency, pending.length);
    process.stdout.write(`  ${done.toLocaleString()}/${pending.length.toLocaleString()} (${updated} updated, ${errors} errors, concurrency=${_concurrency})\r`);
    if (i + _concurrency < pending.length) await delay(100);
  }

  clearProgress();
  console.log(`\n  ✓ Done — ${updated} updated, ${errors} errors`);
  await gitCommitPush(`Teams fetch complete: ${updated.toLocaleString()} players updated`);
}

// ─── Phase 4: Cross-reference players against grade teams ────────────────────

function matchPlayers(players, gradeTeams) {
  const targetTeamIds = new Set(gradeTeams.teams.map(t => t.id));
  const roster = Object.fromEntries(gradeTeams.teams.map(t => [t.id, { team: t, players: [] }]));
  let matchedPlayers = 0, noTeamsData = 0;

  for (const p of players) {
    if (!Array.isArray(p.detail?.teams)) { noTeamsData++; continue; }
    for (const reg of p.detail.teams) {
      if (!reg?.grade?.id) continue;
      if (!targetTeamIds.has(reg.id)) continue;
      if (reg.grade?.id !== gradeTeams.gradeId) continue;

      roster[reg.id].players.push({
        uuid:         p.uuid,
        name:         p.name,
        seasonId:     reg.season?.id,
        seasonName:   reg.season?.name,
        seasonStatus: reg.season?.status?.value,
        currentRegs:  (p.detail.teams || [])
          .filter(r => r.season?.status?.value !== 'COMPLETED')
          .map(r => ({
            team:    r.name,
            teamId:  r.id,
            grade:   r.grade?.name,
            gradeId: r.grade?.id,
            comp:    r.season?.competition?.name,
            compId:  r.season?.competition?.id,
            season:  r.season?.name,
            seasonId: r.season?.id,
            status:  r.season?.status?.value,
          })),
      });
      matchedPlayers++;
      break;
    }
  }

  if (noTeamsData > 0) console.log(`  Players with no teams data: ${noTeamsData} (run with --fetch-teams to fill)`);
  return { gradeTeams, roster, matchedPlayers };
}

// ─── Phase 5: Report ──────────────────────────────────────────────────────────

function writeResults(allResults, players) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const totalMatched = allResults.reduce((n, r) => n + r.matchedPlayers, 0);
  const coverage     = players.filter(p => p.hasTeams).length;

  // Determine output filename
  const targetId  = TARGET_GRADE_ID || TARGET_TEAM_ID || TARGET_COMP_ID;
  const outFile   = _ARGS.out || path.join(OUT_DIR, `${targetId}.json`);
  const output    = {
    mode: MODE, targetId,
    generatedAt: new Date().toISOString(),
    coverage: { totalPlayers: players.length, withTeamsData: coverage, withoutTeamsData: players.length - coverage },
    grades: allResults.map(r => ({ gradeId: r.gradeTeams.gradeId, gradeName: r.gradeTeams.gradeName, roster: r.roster })),
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log(`\n📊 Results:`);
  console.log(`  Mode: ${MODE} | Target: ${targetId}`);
  console.log(`  Total matched players: ${totalMatched}`);
  console.log(`  Coverage: ${coverage.toLocaleString()}/${players.length.toLocaleString()} players have teams data`);

  for (const { gradeTeams, roster } of allResults) {
    const gradeTotal = Object.values(roster).reduce((n, e) => n + e.players.length, 0);
    console.log(`\n  ── ${gradeTeams.gradeName} (${gradeTeams.gradeId}) — ${gradeTotal} player(s) ──`);
    for (const [teamId, entry] of Object.entries(roster)) {
      const { team, players: tp } = entry;
      const poolStr = team.pool ? ` [${team.pool}]` : '';
      console.log(`\n    ${team.name}${poolStr} (${teamId}) — ${tp.length} player(s)`);
      for (const p of tp) {
        const statusStr = p.seasonStatus === 'UPCOMING' ? ' 📅' : p.seasonStatus === 'ACTIVE' ? ' ✅' : '';
        console.log(`      ${p.name}${statusStr}`);
        if (p.currentRegs?.length) {
          for (const r of p.currentRegs) {
            const flag = r.status === 'UPCOMING' ? '📅' : r.status === 'ACTIVE' ? '✅' : '  ';
            console.log(`        ${flag} ${r.comp || '?'} — ${r.grade || '?'} — ${r.team}`);
          }
        } else {
          console.log(`        (no active/upcoming registrations)`);
        }
      }
    }
  }

  console.log(`\n💾 Written to: ${outFile}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== roster-lookup.js ===');
  console.log(`Mode:          ${MODE}`);
  console.log(`Target:        ${TARGET_GRADE_ID || TARGET_TEAM_ID || TARGET_COMP_ID}`);
  console.log(`Fetch teams:   ${FETCH_TEAMS ? (FORCE_FETCH ? 'yes (force)' : 'yes (missing only)') : 'no'}`);
  console.log(`Concurrency:   ${CONCURRENCY}`);
  console.log(`Dry run:       ${DRY_RUN}`);

  const needsApi = !DRY_RUN && (FETCH_TEAMS || MODE !== 'grade' || !fs.existsSync(path.join(OUT_DIR, `${TARGET_GRADE_ID}-grade.json`)));
  const cookie   = needsApi ? await getSession() : null;

  // Phase 1: resolve target(s) into grade team lists
  const gradeTargets = DRY_RUN
    ? [{ gradeId: TARGET_GRADE_ID || 'dry-run', gradeName: '(dry run)', teams: [] }]
    : await resolveTargets(cookie);

  if (gradeTargets.length === 0) {
    console.error('\nNo grades resolved. Check the target ID.');
    process.exit(1);
  }

  // Phase 2: scan all player files
  const players = scanPlayersDir();
  if (players.length === 0) {
    console.log('\nNo players found. DB may be empty.');
    process.exit(0);
  }

  // Phase 3: fetch missing teams data (if requested)
  if (FETCH_TEAMS && !DRY_RUN) {
    await fetchMissingTeams(players, cookie);
  } else {
    const missing = players.filter(p => !p.hasTeams).length;
    if (missing > 0) console.log(`\n  ℹ ${missing.toLocaleString()} players lack teams data — run with mode 1 or 2 to populate`);
  }

  // Phase 4+5: cross-reference each grade and report
  console.log('\n🎯 Phase 4: Cross-referencing players against grade team lists...');
  const allResults = gradeTargets.map(gt => matchPlayers(players, gt));
  writeResults(allResults, players);
}

main().catch(e => {
  console.error('\nFatal error:', e.message);
  process.exit(1);
});
