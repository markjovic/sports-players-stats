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
const { processTeams, flushLookupShards, isSlimFormat } = require('./team-lookup-utils');

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
    logo { sizes { url dimensions { width height } } }
    organisation { id name }
    grade { id name }
    season {
      id name startDate endDate
      status { name value }
      competition { id name organisation { id name } }
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
      const hasTeams = Array.isArray(detail.teams) && detail.teams.length > 0 && isSlimFormat(detail.teams);
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
    execSync('git add players/ roster-teams-progress.json team-lookup/', { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) { console.log('  (no changes to commit)'); return; }
    execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
    const stashOut = execSync('git stash', { stdio: 'pipe' }).toString();
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    if (stashOut.includes('Saved')) execSync('git stash pop', { stdio: 'pipe' });
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
        detail.teams          = processTeams(teams);  // slim refs + populates lookup shards
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
      const flushed = flushLookupShards();
      sinceLastSave = 0;
      console.log(`\n  💾 Progress saved (${doneList.length.toLocaleString()} done, ${flushed} lookup shards) — committing to repo...`);
      await gitCommitPush(`Teams fetch progress: ${doneList.length.toLocaleString()}/${toFetch.length.toLocaleString()} players`);
    }

    const done = Math.min(i + _concurrency, pending.length);
    process.stdout.write(`  ${done.toLocaleString()}/${pending.length.toLocaleString()} (${updated} updated, ${errors} errors, concurrency=${_concurrency})\r`);
    if (i + _concurrency < pending.length) await delay(100);
  }

  clearProgress();
  flushLookupShards();
  console.log(`\n  ✓ Done — ${updated} updated, ${errors} errors`);
  await gitCommitPush(`Teams fetch complete: ${updated.toLocaleString()} players updated`);
}

// ─── Phase 4: Cross-reference players against grade teams ────────────────────

function matchPlayers(players, gradeTeams) {
  const { lookupTeam } = require('./team-lookup-utils');
  const targetTeamIds = new Set(gradeTeams.teams.map(t => t.id));
  const roster = Object.fromEntries(gradeTeams.teams.map(t => [t.id, { team: t, players: [] }]));
  let matchedPlayers = 0, noTeamsData = 0;

  for (const p of players) {
    if (!Array.isArray(p.detail?.teams) || p.detail.teams.length === 0) { noTeamsData++; continue; }
    for (const ref of p.detail.teams) {
      if (!ref?.tid) continue;
      if (!targetTeamIds.has(ref.tid)) continue;
      // Verify team belongs to this grade via lookup
      const teamMeta = lookupTeam(ref.tid);
      if (teamMeta && teamMeta.gid && teamMeta.gid !== gradeTeams.gradeId) continue;

      // Build currentRegs from all slim refs, resolved via lookup
      const currentRegs = (p.detail.teams || [])
        .filter(r => r.status !== 'COMPLETED')
        .map(r => {
          const meta = lookupTeam(r.tid) || {};
          return {
            team:     meta.name    || r.tid,
            teamId:   r.tid,
            grade:    meta.gn      || null,
            gradeId:  meta.gid     || null,
            comp:     meta.compName || null,
            compId:   meta.compId  || null,
            season:   meta.sn      || null,
            seasonId: r.sid,
            status:   r.status,
          };
        });

      roster[ref.tid].players.push({
        uuid:         p.uuid,
        name:         p.name,
        seasonId:     ref.sid,
        seasonName:   lookupTeam(ref.tid)?.sn || null,
        seasonStatus: ref.status,
        currentRegs,
      });
      matchedPlayers++;
      break;
    }
  }

  if (noTeamsData > 0) console.log(`  Players with no teams data: ${noTeamsData} (run with --fetch-teams to fill)`);
  return { gradeTeams, roster, matchedPlayers };
}

// ─── Phase 5: Report ──────────────────────────────────────────────────────────

const PLAYHQ_PROFILE_URL = 'https://www.playhq.com/public/profile';

function fmt(n) { return (n ?? 0).toLocaleString(); }

function generateHtml(allResults, targetId, generatedAt, coverage) {
  // Derive header info from first result
  const first     = allResults[0];
  const isComp    = MODE === 'comp';
  const isTeam    = MODE === 'team';
  const title     = isComp
    ? `Competition Roster — ${first?.gradeTeams?.gradeName?.replace(/\s*\(.*\)/, '') || targetId}`
    : isTeam
    ? `Opposition — ${Object.values(first?.roster || {})[0]?.team?.name || targetId}`
    : first?.gradeTeams?.gradeName || targetId;

  const totalPlayers = allResults.reduce((n, r) => n + r.matchedPlayers, 0);
  const genDate = new Date(generatedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

  // Build grade/team/player HTML
  const gradesHtml = allResults.map(({ gradeTeams, roster }) => {
    const gradeTotal = Object.values(roster).reduce((n, e) => n + e.players.length, 0);
    if (gradeTotal === 0) return '';

    const teamsHtml = Object.values(roster)
      .filter(e => e.players.length > 0)
      .map(({ team, players: tp }) => {
        const poolBadge = team.pool ? `<span class="pool-badge">${team.pool}</span>` : '';
        const statusBadge = team.played > 0
          ? `<span class="status active">${team.played} games played</span>`
          : `<span class="status upcoming">Pre-season</span>`;

        const playersHtml = tp.map(p => {
          const bk = p.detail?.sports?.Basketball || {};
          const profileUrl = `${PLAYHQ_PROFILE_URL}/${p.uuid}/statistics`;

          const regsHtml = (p.currentRegs || []).map(r => {
            const cls = r.status === 'ACTIVE' ? 'active' : 'upcoming';
            return `<span class="reg-tag ${cls}"><span class="rt-comp">${r.comp || '?'}</span><span class="rt-sep">·</span><span class="rt-grade">${r.grade || '?'}</span><span class="rt-sep">·</span><span class="rt-team">${r.team || '?'}</span></span>`;
          }).join('');

          return `
            <tr>
              <td class="player-name">
                <a href="${profileUrl}" target="_blank" rel="noopener">${p.name}</a>
                ${regsHtml ? `<div class="reg-tags">${regsHtml}</div>` : ''}
              </td>
              <td class="stat">${fmt(bk.gp)}</td>
              <td class="stat">${fmt(bk.pts)}</td>
              <td class="stat">${bk.gp ? (bk.pts / bk.gp).toFixed(1) : '—'}</td>
              <td class="stat">${fmt(bk.fg)}</td>
              <td class="stat">${fmt(bk.threePt)}</td>
              <td class="stat">${fmt(bk.ft)}</td>
              <td class="stat">${fmt(bk.fouls)}</td>
            </tr>`;
        }).join('');

        return `
          <div class="team-block">
            <div class="team-header">
              <div class="team-title">
                <h3>${team.name}</h3>
                ${poolBadge}
                ${statusBadge}
              </div>
              <span class="player-count">${tp.length} player${tp.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="table-scroll">
            <table class="roster-table">
              <thead>
                <tr>
                  <th class="player-name">Player</th>
                  <th class="stat" title="Games Played">GP</th>
                  <th class="stat" title="Total Points">PTS</th>
                  <th class="stat" title="Points Per Game">PPG</th>
                  <th class="stat" title="Field Goals (2pt)">2PT</th>
                  <th class="stat" title="Three Pointers">3PT</th>
                  <th class="stat" title="Free Throws">FT</th>
                  <th class="stat" title="Total Fouls">F</th>
                </tr>
              </thead>
              <tbody>${playersHtml}</tbody>
            </table>
            </div>
          </div>`;
      }).join('');

    const gradeHeader = allResults.length > 1
      ? `<div class="grade-header"><h2>${gradeTeams.gradeName}</h2><span class="grade-count">${gradeTotal} players</span></div>`
      : '';

    return `<section class="grade-section">${gradeHeader}${teamsHtml}</section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #0d1117;
      --surface:   #161b22;
      --surface2:  #1c2128;
      --border:    #30363d;
      --accent:    #f7931e;
      --accent2:   #e05c1a;
      --text:      #e6edf3;
      --muted:     #8b949e;
      --active:    #3fb950;
      --upcoming:  #f7931e;
      --radius:    6px;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Barlow', sans-serif;
      font-size: 14px;
      line-height: 1.5;
      min-height: 100vh;
    }

    /* ── Header ── */
    .page-header {
      background: linear-gradient(135deg, #1a2332 0%, #0d1117 60%);
      border-bottom: 3px solid var(--accent);
      padding: 32px 40px 28px;
      position: relative;
      overflow: hidden;
    }
    .page-header::before {
      content: '🏀';
      position: absolute;
      right: 40px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 96px;
      opacity: 0.06;
    }
    .header-eyebrow {
      font-family: 'Barlow Condensed', sans-serif;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 8px;
    }
    h1 {
      font-family: 'Barlow Condensed', sans-serif;
      font-size: clamp(28px, 5vw, 48px);
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: -0.5px;
      line-height: 1;
      margin-bottom: 16px;
    }
    .header-meta {
      display: flex;
      gap: 24px;
      flex-wrap: wrap;
    }
    .meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .meta-item strong { color: var(--text); }

    /* ── Layout ── */
    .content { padding: 32px 40px; max-width: 1100px; }

    /* ── Grade section ── */
    .grade-header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .grade-header h2 {
      font-family: 'Barlow Condensed', sans-serif;
      font-size: 22px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .grade-count {
      font-size: 12px;
      color: var(--muted);
    }

    /* ── Team block ── */
    .team-block {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 16px;
      overflow: hidden;
    }
    .team-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 20px;
      background: var(--surface2);
      border-bottom: 1px solid var(--border);
    }
    .team-title {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .team-title h3 {
      font-family: 'Barlow Condensed', sans-serif;
      font-size: 18px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .player-count {
      font-size: 12px;
      color: var(--muted);
      font-weight: 500;
    }

    /* ── Badges ── */
    .pool-badge {
      background: #21262d;
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 20px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status.active   { background: rgba(63,185,80,0.15); color: var(--active); border: 1px solid rgba(63,185,80,0.3); }
    .status.upcoming { background: rgba(247,147,30,0.15); color: var(--upcoming); border: 1px solid rgba(247,147,30,0.3); }

    /* ── Roster table ── */
    .roster-table {
      width: 100%;
      border-collapse: collapse;
    }
    .roster-table thead tr {
      background: rgba(255,255,255,0.02);
    }
    .roster-table th {
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
    }
    .roster-table th.stat { text-align: center; }
    .roster-table tbody tr {
      border-bottom: 1px solid rgba(48,54,61,0.5);
      transition: background 0.12s;
    }
    .roster-table tbody tr:last-child { border-bottom: none; }
    .roster-table tbody tr:hover { background: rgba(255,255,255,0.03); }
    .roster-table td { padding: 10px 12px; vertical-align: top; }
    .roster-table td.stat {
      text-align: center;
      font-family: 'Barlow Condensed', sans-serif;
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
      vertical-align: middle;
      white-space: nowrap;
    }

    /* ── Player name & reg tags ── */
    td.player-name a {
      color: var(--text);
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
      transition: color 0.12s;
    }
    td.player-name a:hover { color: var(--accent); }
    .reg-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 5px;
    }
    .reg-tag {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 3px;
      font-weight: 500;
      white-space: nowrap;
    }
    .reg-tag.active   { background: rgba(63,185,80,0.12);  color: #3fb950; border: 1px solid rgba(63,185,80,0.25); }
    .reg-tag.upcoming { background: rgba(247,147,30,0.12); color: #f7931e; border: 1px solid rgba(247,147,30,0.25); }

    /* ── Footer ── */
    .page-footer {
      padding: 24px 40px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 12px;
    }

    /* ── Reg tag segments ── */
    .rt-sep { margin: 0 4px; opacity: 0.4; }
    .rt-comp {
      font-weight: 700;
      letter-spacing: 0.2px;
    }
    .rt-grade {
      font-style: italic;
      opacity: 0.85;
    }
    .rt-team {
      font-weight: 400;
      opacity: 0.7;
    }

    /* ── Scrollable table on mobile ── */
    .table-scroll {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .table-scroll::after {
      content: '';
      display: block;
    }
    @media (max-width: 600px) {
      .page-header, .content, .page-footer { padding-left: 16px; padding-right: 16px; }
      .roster-table { min-width: 480px; }
      .roster-table th.player-name,
      .roster-table td.player-name { min-width: 140px; }
    }
  </style>
</head>
<body>
  <header class="page-header">
    <div class="header-eyebrow">Basketball Victoria · PlayHQ Roster</div>
    <h1>${title}</h1>
    <div class="header-meta">
      <div class="meta-item">
        <span>Players found</span>
        <strong>${totalPlayers}</strong>
      </div>
      <div class="meta-item">
        <span>Teams with data</span>
        <strong>${allResults.reduce((n, r) => n + Object.values(r.roster).filter(e => e.players.length > 0).length, 0)} of ${allResults.reduce((n, r) => n + Object.values(r.roster).length, 0)}</strong>
      </div>
      <div class="meta-item">
        <span>Generated</span>
        <strong>${genDate}</strong>
      </div>
    </div>
  </header>

  <main class="content">
    ${gradesHtml}
  </main>

  <footer class="page-footer">
    Career stats sourced from Basketball Victoria / PlayHQ. Data may not reflect the current season.
    Profile links open the player's public PlayHQ page.
  </footer>
</body>
</html>`;
}

function writeResults(allResults, players) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const totalMatched = allResults.reduce((n, r) => n + r.matchedPlayers, 0);
  const coverage     = players.filter(p => p.hasTeams).length;
  const targetId     = TARGET_GRADE_ID || TARGET_TEAM_ID || TARGET_COMP_ID;
  const generatedAt  = new Date().toISOString();

  // JSON output
  const outJson = _ARGS.out || path.join(OUT_DIR, `${targetId}.json`);
  const output  = {
    mode: MODE, targetId, generatedAt,
    coverage: { totalPlayers: players.length, withTeamsData: coverage, withoutTeamsData: players.length - coverage },
    grades: allResults.map(r => ({ gradeId: r.gradeTeams.gradeId, gradeName: r.gradeTeams.gradeName, roster: r.roster })),
  };
  fs.writeFileSync(outJson, JSON.stringify(output, null, 2));

  // HTML output — enrich allResults with player detail for stats
  const enriched = allResults.map(({ gradeTeams, roster, matchedPlayers }) => ({
    gradeTeams, matchedPlayers,
    roster: Object.fromEntries(
      Object.entries(roster).map(([tid, entry]) => [tid, {
        ...entry,
        players: entry.players.map(p => ({
          ...p,
          detail: players.find(pl => pl.uuid === p.uuid)?.detail || {},
        })),
      }])
    ),
  }));

  const outHtml = outJson.replace(/\.json$/, '.html');
  fs.writeFileSync(outHtml, generateHtml(enriched, targetId, generatedAt, coverage));

  // Console output
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

  console.log(`\n💾 JSON: ${outJson}`);
  console.log(`🌐 HTML: ${outHtml}`);
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
