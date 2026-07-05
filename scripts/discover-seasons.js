// scripts/discover-seasons.js
//
// PIECE 1 — season DETECTION (find new seasons early, self-terminating).
//
// Probes current-season players' publicProfileTeams registrations for season IDs
// not yet in sports-index.json, and creates them (locked:false) so the nightly
// crawl picks them up. This is the pre-round-1 discovery path: publicProfileTeams
// returns UPCOMING/ACTIVE registrations, so a player who has registered for next
// season surfaces it before any game is played — the tool's USP.
//
// One player suffices to discover a season (it appears on every re-registered
// player), so the probe shuffles current-season players and STOPS once it has
// gone --stop-after consecutive players with no new season — self-terminating.
//
// Session/WAF machinery, headers, cookie handling and doFetch are copied verbatim
// from fetch-profile-stats.js. Queries are copied from fetch-playhq.js /
// playhq_api_reference.md — never write PlayHQ queries from scratch.
//
// Modes:
//   node scripts/discover-seasons.js                 # scan current-season players, self-terminating
//   node scripts/discover-seasons.js --full          # probe every current-season player (no early stop)
//   node scripts/discover-seasons.js --limit=200     # probe at most N (cheap test run)
//   node scripts/discover-seasons.js --uuid=<id>     # manual escape hatch: probe one player
//   node scripts/discover-seasons.js --dry-run       # report only, no writes/commit
//
// Piece 2 (roster-fill, triggered when new seasons are found) is a separate step.

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const https        = require('https');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const API_URL     = 'https://api.playhq.com/graphql';
const INDEX_FILE  = path.join(ROOT, 'data', 'sports-index.json');
const PLAYERS_DIR = path.join(ROOT, 'players');

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const DEBUG_TEAMS = args.includes('--debug-teams');  // dump raw grade/season per registration
const FULL      = args.includes('--full');
const ONE_UUID  = (args.find(a => a.startsWith('--uuid=')) || '').replace('--uuid=', '').trim() || null;
const LIMIT     = (() => { const a = args.find(a => a.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : Infinity; })();
const STOP_AFTER = (() => { const a = args.find(a => a.startsWith('--stop-after=')); return a ? parseInt(a.split('=')[1], 10) : 1000; })();
const CHECK_SEASONS = (args.find(a => a.startsWith('--check-seasons=')) || '').replace('--check-seasons=', '').split(',').filter(Boolean);
const CHECK_KNOWN   = (() => { const a = args.find(a => a.startsWith('--check-known=')); return a ? parseInt(a.split('=')[1], 10) : 0; })();

// ─── Headers — full set, never split, never modified (copied verbatim) ────────
const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── Session cookie (promise-locked; copied verbatim from fetch-profile-stats) ─
let sessionCookie  = null;
let sessionPromise = null;
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

async function refreshSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (attempt > 1) await sleep(attempt * 5000);
      for (const body of COOKIE_QUERIES) {
        const res = await doFetch(API_URL, {
          method: 'POST',
          headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() },
          body: JSON.stringify(body),
        });
        const raw = res.headers.get('set-cookie');
        if (!raw) continue;
        const parts = raw.split(',').map(c => c.trim().split(';')[0]);
        const get = (name) => parts.find(c => c.startsWith(name + '=')) || null;
        const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
        if (!tier || !session || !sub) continue;
        sessionCookie = `${tier}; ${session}; ${sub}`;
        sessionPromise = null;
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    }
    sessionPromise = null;
    throw new Error('Failed to obtain session cookie after 10 attempts');
  })();
  return sessionPromise;
}

// ─── Queries (copied: publicProfileTeams from fetch-playhq.js; ───────────────
//     gradeListDiscoverSeason from fetch-playhq.js — grades carry age+gender to
//     match the sports-index entry shape) ──────────────────────────────────────
const Q_PROFILE_TEAMS = {
  operationName: 'PublicProfileTeams',
  query: `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    id name
    organisation { id name }
    grade { id name }
    season {
      id name startDate endDate
      status { name value }
      competition { id name organisation { id name } }
    }
  }
}`,
};

const Q_DISCOVER_SEASON = {
  operationName: 'gradeListDiscoverSeason',
  query: `query gradeListDiscoverSeason($id: String!) {
  discoverSeason(seasonID: $id) {
    id name
    competition { id name type organisation { id name } }
    grades { id name age { name } gender { name } }
  }
}`,
};

const REFRESH_EVERY = 30;   // publicProfileTeams shares the profile endpoint's per-session quota
let requestCount = 0;

// ─── Typed probe: publicProfileTeams → { kind, teams } ────────────────────────
async function probeTeams(profileID) {
  if (!sessionCookie) await refreshSession();
  requestCount++;
  if (requestCount % REFRESH_EVERY === 0) { sessionCookie = null; await refreshSession(); }

  const body = { ...Q_PROFILE_TEAMS, variables: { profileID } };
  let res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify(body),
    });
  } catch (err) { return { kind: 'error', err }; }

  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch {}
    if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { kind: 'blocked' };
    return { kind: 'private' };   // application 403 — inaccessible profile
  }
  if (!res.ok) return { kind: 'error', err: new Error(`HTTP ${res.status}`) };

  let json; try { json = await res.json(); } catch (err) { return { kind: 'error', err }; }
  if (json.errors?.length) return { kind: 'error', err: new Error(json.errors[0]?.message || 'gql') };
  const teams = (json.data || json)?.publicProfileTeams;
  return { kind: 'ok', teams: Array.isArray(teams) ? teams : [] };
}

// ─── discoverSeason → grades + competition (for creating the season entry) ────
async function discoverSeason(seasonID) {
  if (!sessionCookie) await refreshSession();
  requestCount++;
  const body = { ...Q_DISCOVER_SEASON, variables: { id: seasonID } };
  let res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify(body),
    });
  } catch { return null; }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch {}
    if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { blocked: true };
    return null;
  }
  if (!res.ok) return null;
  let json; try { json = await res.json(); } catch { return null; }
  if (json.errors?.length) return null;
  return (json.data || json)?.discoverSeason || null;
}

// ─── Build current-season player list from player files ───────────────────────
function currentSeasonPlayers(activeSids) {
  const uuids = [];
  const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS_DIR, prefix);
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
      const uuid = fname.replace('.json', '');
      let player; try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
      const inActive = (player.seasons || []).some(s => activeSids.has(s.sid) && (s.regs || []).length > 0);
      if (inActive) uuids.push(uuid);
    }
  }
  return uuids;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function gitCommit(msg) {
  if (DRY_RUN) return;
  try {
    execSync('git add data/sports-index.json', { cwd: ROOT, stdio: 'pipe' });
    const staged = execSync('git diff --staged --shortstat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!staged) { console.log('  Nothing to commit.'); return; }
    execSync('git fetch origin main', { cwd: ROOT, stdio: 'pipe' });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { cwd: ROOT, stdio: 'pipe' });
    execSync(`git commit -m "${msg}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git push origin main', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ ${msg}`);
  } catch (e) {
    console.error('  ✗ git:', (e.stderr?.toString() || e.message).slice(0, 200));
  }
}

// doFetch: https.request with keepAlive:false (copied verbatim) ────────────────
function doFetch(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = options.body || '';
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: { ...options.headers, 'content-length': Buffer.byteLength(body) },
      agent: new https.Agent({ keepAlive: false }),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const hdrs = res.headers;
        const headers = { get(name) { const v = hdrs[name.toLowerCase()]; return v == null ? null : (Array.isArray(v) ? v.join(', ') : v); } };
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers, text: () => Promise.resolve(rawBody), json: () => Promise.resolve(JSON.parse(rawBody)) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\ndiscover-seasons.js${DRY_RUN ? '  [dry-run]' : ''}${FULL ? '  [full]' : ''}${ONE_UUID ? `  [uuid=${ONE_UUID}]` : ''}`);
  console.log('─'.repeat(60));

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  index.seasons = index.seasons || {};
  const knownSeasonIds = new Set(Object.keys(index.seasons));
  const activeSids = new Set(Object.values(index.seasons).filter(s => !s.locked).map(s => s.id));
  console.log(`  Known seasons: ${knownSeasonIds.size}  (active: ${activeSids.size})`);

  // ── Diagnostic: does discoverSeason return grades for KNOWN seasons? ─────────
  // Samples across competitions so we don't infer a rule from one org (N=1).
  if (CHECK_SEASONS.length || CHECK_KNOWN > 0) {
    let ids = [...CHECK_SEASONS];
    if (CHECK_KNOWN > 0) {
      const known = Object.values(index.seasons);
      const completed = known.filter(s => (s.grades || []).length > 0);   // known-good, grades present in index
      // shuffle and take a spread
      for (let i = completed.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [completed[i],completed[j]]=[completed[j],completed[i]]; }
      ids.push(...completed.slice(0, CHECK_KNOWN).map(s => s.id));
    }
    console.log(`\n  discoverSeason grade-availability check (${ids.length} seasons):`);
    console.log('  ' + 'sid'.padEnd(12) + 'idxGrades'.padEnd(11) + 'apiGrades'.padEnd(11) + 'org');
    for (const sid of ids) {
      const idxEntry = index.seasons[sid];
      const idxGrades = (idxEntry?.grades || []).length;
      const ds = await discoverSeason(sid);
      const apiGrades = ds?.blocked ? 'BLOCKED' : (ds?.grades?.length ?? 'null');
      const org = ds?.competition?.organisation?.name || idxEntry?.orgName || '?';
      console.log(`  ${String(sid).padEnd(12)}${String(idxGrades).padEnd(11)}${String(apiGrades).padEnd(11)}${org}`);
    }
    console.log('\nDiagnostic done.');
    return;
  }

  // Build probe list
  let probeList;
  if (ONE_UUID) {
    probeList = [ONE_UUID];
  } else {
    console.log('  Scanning player files for current-season players…');
    probeList = shuffle(currentSeasonPlayers(activeSids));
    if (Number.isFinite(LIMIT)) probeList = probeList.slice(0, LIMIT);
    console.log(`  Current-season players to probe: ${probeList.length}${FULL ? '' : `  (stop-after ${STOP_AFTER} with no new season)`}`);
  }

  // season.id -> season metadata captured from the discovering registration
  const newSeasonMeta = new Map();
  let probed = 0, blocked = 0, privateN = 0, errors = 0, noNewStreak = 0;

  for (const uuid of probeList) {
    let r = await probeTeams(uuid);
    if (r.kind === 'blocked') {
      // Pace like the crawl: wait, refresh, retry once; then skip.
      blocked++;
      await sleep(90000);
      sessionCookie = null; await refreshSession();
      r = await probeTeams(uuid);
    }
    probed++;
    if (ONE_UUID) {
      console.log(`  ── probe result for ${uuid}: kind=${r.kind} ──`);
      for (const reg of (r.teams || [])) {
        console.log(`    team=${reg.id} "${reg.name}"  grade=${reg.grade?.id || 'NULL'} "${reg.grade?.name || ''}"  season=${reg.season?.id} "${reg.season?.name}" (${reg.season?.status?.value})`);
      }
    }
    if (r.kind === 'private') { privateN++; }
    else if (r.kind === 'error') { errors++; }
    else if (r.kind === 'ok') {
      if (DEBUG_TEAMS) {
        console.log(`  ── raw publicProfileTeams for ${uuid}: ${r.teams.length} registration(s) ──`);
        for (const reg of r.teams) {
          console.log(`    team=${reg.id} "${reg.name}"  grade=${reg.grade?.id || 'NULL'} "${reg.grade?.name || ''}"  season=${reg.season?.id} "${reg.season?.name}" (${reg.season?.status?.value})`);
        }
      }
      let foundNew = false;
      for (const reg of r.teams) {
        const se = reg.season;
        if (!se?.id) continue;
        if (knownSeasonIds.has(se.id) || newSeasonMeta.has(se.id)) continue;
        newSeasonMeta.set(se.id, {
          name: se.name, startDate: se.startDate, endDate: se.endDate,
          status: se.status?.value || null,
          compId: se.competition?.id, compName: se.competition?.name,
          orgId: se.competition?.organisation?.id, orgName: se.competition?.organisation?.name,
        });
        foundNew = true;
        console.log(`  ✦ new season: ${se.id}  ${se.name}  (${se.status?.value || '?'})  via ${uuid}`);
      }
      noNewStreak = foundNew ? 0 : noNewStreak + 1;
    }

    if (!FULL && !ONE_UUID && noNewStreak >= STOP_AFTER) {
      console.log(`  ⏹ ${STOP_AFTER} consecutive players with no new season — stopping (probed ${probed}).`);
      break;
    }
    if (probed % 200 === 0) console.log(`    …probed ${probed}  new=${newSeasonMeta.size}  blocked=${blocked}`);
  }

  // Create entries for each new season (discoverSeason for full grade list)
  let created = 0;
  for (const [sid, meta] of newSeasonMeta) {
    const ds = await discoverSeason(sid);
    if (ds?.blocked) { console.log(`  ⛔ blocked resolving grades for ${sid} — leaving for next run`); continue; }
    const grades = (ds?.grades || []).map(g => ({ id: g.id, name: g.name, age: g.age?.name, gender: g.gender?.name }));
    const compName = ds?.competition?.name || meta.compName || '';
    const orgName  = ds?.competition?.organisation?.name || meta.orgName || '';
    index.seasons[sid] = {
      id: sid,
      name: ds?.name || meta.name,
      fullName: `${compName} — ${ds?.name || meta.name}`,
      compName,
      compId: ds?.competition?.id || meta.compId,
      orgName,
      orgId: ds?.competition?.organisation?.id || meta.orgId,
      tenant: 'bv',
      grades,
      locked: false,
      addedAt: new Date().toISOString(),
      // Capture the season-status signal at creation — the future auto-lock wants it.
      status: meta.status || null,
      startDate: meta.startDate || null,
      endDate: meta.endDate || null,
    };
    created++;
    console.log(`  + created ${sid}  ${index.seasons[sid].fullName}  (${grades.length} grades)`);
  }

  if (created > 0 && !DRY_RUN) {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
    gitCommit(`discover-seasons: ${created} new season(s) added`);
  }

  console.log('\n─── Summary ─────────────────────────────────────────────────────────');
  console.log(`  Players probed        : ${probed}`);
  console.log(`  Private / error       : ${privateN} / ${errors}`);
  console.log(`  Blocked (paced)       : ${blocked}`);
  console.log(`  New seasons found     : ${newSeasonMeta.size}`);
  console.log(`  Seasons created       : ${created}${DRY_RUN ? ' (dry-run — none written)' : ''}`);
  if (newSeasonMeta.size > created) console.log(`  (${newSeasonMeta.size - created} left for next run — grade resolution blocked)`);
  console.log('─'.repeat(60));
  if (created > 0) console.log('\nNext: roster-fill (piece 2) should run for the new season(s) until round 1 completes.');
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
