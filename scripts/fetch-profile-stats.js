// scripts/fetch-profile-stats.js
//
// Fetches publicProfileStatistics for all players in a single index shard.
// Run one shard at a time — the workflow uses sparse checkout so only
// players/indexes/{shard}.json and players/{shard}/ are on disk.
//
// Usage:
//   node scripts/fetch-profile-stats.js --shard=3a
//   node scripts/fetch-profile-stats.js --shard=3a --force
//
// Writes to each players/{shard}/{uuid}.json:
//   sports.Basketball.gp             — career games played
//   sports.Basketball.pts            — career points
//   sports.Basketball.fg             — career field goals
//   sports.Basketball.ft             — career free throws
//   sports.Basketball.threePt        — career 3-pointers
//   sports.Basketball.fouls          — career fouls
//   sports.Basketball.foulOuts       — { [seasonId]: count }
//   sports.Basketball.maxGamePTS     — number | null
//   sports.Basketball.maxGameThreePt — number | null
//   sports.Basketball.statsChecked   — ISO timestamp
//   seasons[].regs[].stats.gp/pts/fg/ft/threePt/fouls — per-reg totals
//   private                          — true | false (explicit flag, added 2026-07-10)
//
// statsChecked is ONLY written on a real data response.
// A 403 that persists after a session refresh = truly inaccessible profile.
// A 403 that resolves after a session refresh = session expiry (retry succeeds).
// All stats use seenGameKeys dedup — no double-counting across multiple regs.
//
// private flag (2026-07-10): previously "private" was inferred only from the
// `Player #<prefix>` name convention, which is ambiguous (a real player who
// never scored looks identical in storage to a confirmed-403 profile). This
// now writes an explicit player.private boolean on every outcome, so the two
// cases are distinguishable and so private<->public transitions are tracked:
//   - 403/not-found  -> private = true.  Name is left untouched (if a real
//     name is already on file from before the profile went private, we keep
//     showing it — the user's requirement is "we still know their name but
//     mark them as private", not "forget the name").
//   - real data ("ok") -> private = false. The name write below was also
//     fixed to OVERWRITE a placeholder `Player #...` name once a real one is
//     available (previously `if (parsed.playerName && !player.name)` could
//     never fire again once a placeholder name existed at all — a private
//     stub that later went public would keep its placeholder name forever).
//
// One git commit after all writes for the shard.

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');
const https = require('https');
const {
  GRADE_PLAYERS_QUERY, gradePageFilter, PROFILE_SEARCH_QUERY,
  matchFromGrade, matchFromGradeRosterByName, matchFromSearch, isPlaceholderName,
} = require('./lib/namespace-resolve.cjs');

const ROOT = path.join(__dirname, '..');

// ─── CLI args ────────────────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const SHARD = (args.find(a => a.startsWith('--shard=')) || '').replace('--shard=', '').toLowerCase().trim();
const FORCE = args.includes('--force');
const MAX   = (() => { const a = args.find(a => a.startsWith('--max=')); return a ? parseInt(a.split('=')[1]) : Infinity; })();

if (!SHARD || !/^[0-9a-f]{2}$/.test(SHARD)) {
  console.error('Usage: node scripts/fetch-profile-stats.js --shard=<00-ff> [--force]');
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const API_URL     = 'https://api.playhq.com/graphql';

// Load forfeit games index — skip these when computing per-game max stats
const FORFEIT_FILE   = path.join(ROOT, 'data', 'forfeit-games.json');
const forfeitGameIds = new Set();
try {
  const ids = JSON.parse(fs.readFileSync(FORFEIT_FILE, 'utf8'));
  for (const id of (Array.isArray(ids) ? ids : [])) forfeitGameIds.add(id);
  console.log(`  Forfeit index loaded: ${forfeitGameIds.size} games`);
} catch (_) {}

// Load sports-index.json — orgId per season, used to disambiguate profileSearch
// name collisions during namespace-mismatch recovery (see attemptNamespaceRecovery).
const SPORT_INDEX_FILE = path.join(ROOT, 'data', 'sports-index.json');
let sportIndex = { seasons: {} };
try { sportIndex = JSON.parse(fs.readFileSync(SPORT_INDEX_FILE, 'utf8')); } catch (_) {}

const BATCH_DELAY   = 1000; // ms between batches
const RETRY_BASE  = 2000; // ms, multiplied by attempt number

// ─── Headers — full set, never split, never modified ─────────────────────────

const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── Session cookie ───────────────────────────────────────────────────────────
// Promise-locked so concurrent workers don't trigger multiple simultaneous refreshes.

let sessionCookie   = null;
let sessionPromise  = null;

const COOKIE_QUERIES = [
  {
    operationName: 'TenantConfig',
    variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }',
  },
  {
    operationName: 'ProfileSearch',
    variables: { fullName: 'a' },
    query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
  },
];

async function refreshSession() {
  // If a refresh is already in flight, wait for it rather than firing another
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (attempt > 1) await sleep(attempt * 5000);
      for (const body of COOKIE_QUERIES) {
        const res = await doFetch(API_URL, {
          method:  'POST',
          headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() },
          body:    JSON.stringify(body),
        });
        const raw = res.headers.get('set-cookie');
        if (!raw) continue;
        // Extract each named cookie value, then reassemble in the exact order
        // the mobile client sends them: phq_tier first, phq_session, phq_sub.
        // (The server returns them in a different order in set-cookie headers.)
        const parts = raw.split(',').map(c => c.trim().split(';')[0]);
        const get = (name) => {
          const p = parts.find(c => c.startsWith(name + '='));
          return p || null;
        };
        const tier    = get('phq_tier');
        const session = get('phq_session');
        const sub     = get('phq_sub');
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

// ─── GraphQL query ────────────────────────────────────────────────────────────
// ProfileSeasonStatistics — returns per-game stat lines via gradeStatistics.
// This is the correct query for deriving foulOuts, maxGamePTS, maxGameThreePt.
// Confirmed working from mobile traffic (request_7.txt).

const PROFILE_QUERY = {
  operationName: 'ProfileSeasonStatistics',
  query: `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      name
      statistics {
        season { id }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          gradeStatistics {
            grade { id name }
            gameStatistics {
              game {
                id
                round { name number isFinalsRound abbreviatedName }
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
}`,
};

// ─── Stat helpers ─────────────────────────────────────────────────────────────
// Response stat entries: { count, details: { value } }

function statValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const match = statistics.find(s => s?.details?.value === typeValue);
  return match ? (match.count || 0) : 0;
}

// Derive foulOuts, maxGamePTS, maxGameThreePt from per-game stat lines.
// Returns null if publicProfileStatistics is absent (inaccessible profile).
//
// foulOuts: { [seasonId]: count } — number of games with >= 5 fouls
// maxGamePTS: highest TOTAL_SCORE in any single game across career
// maxGameThreePt: highest 3_POINT_SCORE in any single game across career
function parseProfileStats(data) {
  const seasonStats = data?.publicProfileStatistics?.seasonStatistics;
  if (!seasonStats) return null;

  // Player display name from first seasonStatistics entry
  const playerName = seasonStats[0]?.name || null;

  const seenGameKeys = new Set();  // deduplicate games appearing in multiple registrations
  const foulOuts     = {};
  let maxGamePTS     = null;
  let maxGameThreePt = null;
  let maxGamePTSKey  = null;   // { gameKey, sid } for the game where PTS record was set
  let maxGameThreePtKey = null; // { gameKey, sid } for the game where 3PT record was set

  // Per-reg stats keyed by sid:tid:gid — gp, pts, fg, ft, threePt, fouls
  // These are per-game aggregations, deduped via seenGameKeys
  const regStats = new Map(); // key → { gp, pts, fg, ft, threePt, fouls }

  // gameTids: gameId → tid — which team the player was on for each game.
  // Only populated for players with multiple tids in the same season, where
  // game files alone can't determine side. Used by build-win-loss and StatTrack.
  const gameTids = {}; // gameId → tid
  // Track whether any season has multiple tids (to decide whether to write gameTids)
  const sidTids  = {}; // seasonId → Set<tid>

  for (const season of seasonStats) {
    for (const reg of (season.statistics || [])) {
      const seasonId = reg?.season?.id;
      if (!seasonId) continue;

      for (const teamStat of (reg.teamStatistics || [])) {
        const tid = teamStat.team?.id || null;
        if (tid && seasonId) {
          if (!sidTids[seasonId]) sidTids[seasonId] = new Set();
          sidTids[seasonId].add(tid);
        }

        for (const gradeStat of (teamStat.gradeStatistics || [])) {
          const gid    = gradeStat.grade?.id || null; // eslint-disable-line no-unused-vars
          // regKey: sid:tid only — per-grade breakdown not needed, avoids reg.gid mismatch
          const regKey = `${seasonId}:${tid}`;

          for (const gameStat of (gradeStat.gameStatistics || [])) {
            const stats   = gameStat.statistics || [];
            const gameKey = gameStat.game?.id || null;
            if (gameKey && forfeitGameIds.has(gameKey)) continue;  // skip forfeit games
            // Record game→tid mapping before dedup check — we need it even for dupes
            if (gameKey && tid) gameTids[gameKey] = tid;
            if (gameKey && seenGameKeys.has(gameKey)) continue;    // skip duplicate games (multiple regs)
            if (gameKey) seenGameKeys.add(gameKey);

            const fouls   = statValue(stats, 'TOTAL_FOULS');
            const pts     = statValue(stats, 'TOTAL_SCORE');
            const three   = statValue(stats, '3_POINT_SCORE');
            const fg      = statValue(stats, '2_POINT_SCORE');
            const ft      = statValue(stats, '1_POINT_SCORE');
            const gp_val  = statValue(stats, 'APPEARANCE') || 1; // 1 game per gameStat entry

            // Foul-out = 5 or more fouls in a single game
            if (fouls >= 5) {
              foulOuts[seasonId] = (foulOuts[seasonId] || 0) + 1;
            }

            if (pts > (maxGamePTS ?? 0)) {
              maxGamePTS    = pts;
              maxGamePTSKey = gameKey ? { gameKey, sid: seasonId } : null;
            }
            if (three > (maxGameThreePt ?? 0)) {
              maxGameThreePt    = three;
              maxGameThreePtKey = gameKey ? { gameKey, sid: seasonId } : null;
            }

            // Accumulate per-reg stats
            if (!regStats.has(regKey)) regStats.set(regKey, { gp: 0, pts: 0, fg: 0, ft: 0, threePt: 0, fouls: 0 });
            const rs = regStats.get(regKey);
            rs.gp     += gp_val;
            rs.pts    += pts;
            rs.fg     += fg;
            rs.ft     += ft;
            rs.threePt += three;
            rs.fouls  += fouls;
          }
        }
      }
    }
  }

  // Only include gameTids if any season has multiple tids — otherwise unnecessary
  const hasAmbiguousSeason = Object.values(sidTids).some(s => s.size > 1);
  return { playerName, foulOuts, maxGamePTS, maxGamePTSKey, maxGameThreePt, maxGameThreePtKey, regStats, gameTids: hasAmbiguousSeason ? gameTids : null, sidTids };
}

// ─── API fetch ────────────────────────────────────────────────────────────────
//
// 403 = profile inaccessible to a guest session. Leave file untouched.
// Session expiry would manifest as all requests failing, not individual 403s.
// We refresh the session proactively after every REFRESH_EVERY successful
// requests to prevent expiry on long runs, but we never refresh on a 403.

const REFRESH_EVERY  = 30;  // refresh session every 30 requests — PlayHQ enforces a per-session quota on ProfileSeasonStatistics
let requestCount = 0;

async function fetchProfile(profileID) {
  if (!sessionCookie) await refreshSession();

  requestCount++;

  const body = { ...PROFILE_QUERY, variables: { profileID } };

  let res;
  try {
    res = await doFetch(API_URL, {
      method:  'POST',
      headers: {
        ...HEADERS_BASE,
        'request-id': crypto.randomUUID(),
        'Cookie':     sessionCookie,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { status: 'error', err };
  }

  if (res.status === 403) {
    let body403 = '';
    try { body403 = await res.text(); } catch { /* ignore */ }
    if (body403.includes('DOCTYPE') || body403.includes('Request blocked')) {
      // CloudFront block — log first 300 chars so we can see what identifier it tracks
      const snippet = body403.replace(/\s+/g, ' ').trim().slice(0, 300);
      console.log(`  ⛔ CloudFront block (req#${requestCount}, uuid=${profileID}): ${snippet}`);
      return { status: 'cloudfront-block' };
    }
    // Application-level 403 — profile genuinely inaccessible (private/deleted).
    // Log it but return a distinct status so processUUID writes statsChecked,
    // preventing infinite retries on future runs.
    console.log(`  — private profile (req#${requestCount}, uuid=${profileID})`);
    return { status: 'private' };
  }

  // 504 = backend overloaded — wait and retry once
  if (res.status === 504) {
    await sleep(15000);
    try {
      res = await doFetch(API_URL, {
        method:  'POST',
        headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
        body:    JSON.stringify(body),
      });
    } catch (err) { return { status: 'error', err }; }
  }

  if (!res.ok) {
    return { status: 'error', err: new Error(`HTTP ${res.status}`) };
  }

  let json;
  try { json = await res.json(); }
  catch (err) { return { status: 'error', err }; }

  // GraphQL errors — check before inspecting data
  if (json.errors && json.errors.length > 0) {
    const msg = json.errors[0]?.message || '';
    if (msg.includes('NOT_FOUND') || msg.includes('failed to find profile')) {
      // Profile UUID is known but unresolvable — permanent, treat like private
      console.log(`  — not-found (req#${requestCount}, uuid=${profileID}): ${msg}`);
      return { status: 'private' };
    }
    // Other GraphQL errors — transient, leave file untouched
    return { status: 'error', err: new Error(`GraphQL error: ${msg}`) };
  }

  const data = json.data || json;

  // Null publicProfileStatistics = inaccessible profile
  if (!data?.publicProfileStatistics) return { status: 'inaccessible' };

  return { status: 'ok', data };
}

// ─── Namespace-mismatch recovery ──────────────────────────────────────────────
// PlayHQ issues a DIFFERENT profile id for the same player under
// spectator.playhq.com vs api.playhq.com. We only ever capture the spectator
// id, so a diverged player's stored id comes back NOT_FOUND/403 here even
// though the player has a live, working api-namespace id. Before accepting
// "private", try to recover that real id — validated live on 3 known cases in
// diagnose-namespace-mismatch.js, and measured at ~46% of a sampled backlog in
// diagnose-uuid-classification.js. Queries copied verbatim from
// playhq_api_reference.md via lib/namespace-resolve.cjs.
//
// gradePlayerStatistics: cheap (cached per grade — many players share a grade)
// but hard-capped at 50 highest-appearance players, and only usable when the
// player has a real tid+gid on a reg (true for existing players and, since the
// nightly-crawl.js Phase 4 fix, for brand-new stubs too — but NOT for players
// whose only regs predate that fix). profileSearch (+ orgId disambiguation) is
// the fallback, and in practice recovers the large majority of this backlog.

// gradePlayerStatistics: CORRECTED 2026-07-11 — previously believed hard-
// capped at 50 with no pagination; that was measured using a query missing
// the $filter argument. It's genuinely paginated (filter.pagination); 50 is
// the per-page limit. Verified live (diagnose-grade-pagination.js) and
// confirmed to matter a lot for this backlog (diagnose-uuid-classification.js:
// full-roster name-only matching alone recovered 96.5% of a sampled batch,
// vs 0% before pagination). gradeCache holds the AGGREGATED all-pages roster,
// keyed by gradeID — many players/candidates share a grade.
async function gradePlayersPage(gradeID, page) {
  if (!sessionCookie) await refreshSession();
  const body = {
    operationName: 'publicGradeStatistics',
    variables: { gradeID, filter: gradePageFilter(page) },
    query: GRADE_PLAYERS_QUERY,
  };
  let res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify(body),
    });
  } catch (_) { return { status: 'error', results: [], meta: null }; }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    return (b.includes('DOCTYPE') || b.includes('Request blocked'))
      ? { status: 'blocked', results: [], meta: null } : { status: 'error', results: [], meta: null };
  }
  if (!res.ok) return { status: 'error', results: [], meta: null };
  let json; try { json = await res.json(); } catch (_) { return { status: 'error', results: [], meta: null }; }
  if (json.errors && json.errors.length) return { status: 'error', results: [], meta: null };
  const data = (json.data || json)?.gradePlayerStatistics;
  return { status: 'ok', results: data?.results || [], meta: data?.meta || null };
}

const gradeCache = new Map();
async function gradePlayers(gradeID) {
  if (gradeCache.has(gradeID)) return gradeCache.get(gradeID);
  const p1 = await gradePlayersPage(gradeID, 1);
  if (p1.status !== 'ok') return p1; // error/blocked — don't cache
  let all = p1.results;
  const totalPages = p1.meta?.totalPages || 1;
  for (let page = 2; page <= totalPages; page++) {
    const p = await gradePlayersPage(gradeID, page);
    if (p.status !== 'ok') return p; // error/blocked mid-pagination — don't cache partial
    all = all.concat(p.results);
  }
  const out = { status: 'ok', results: all };
  gradeCache.set(gradeID, out); // only cache successes
  return out;
}

async function profileSearchLookup(fullName) {
  if (!sessionCookie) await refreshSession();
  const body = { operationName: 'ProfileSearch', variables: { fullName }, query: PROFILE_SEARCH_QUERY };
  let res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify(body),
    });
  } catch (_) { return { status: 'error', result: [] }; }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    return (b.includes('DOCTYPE') || b.includes('Request blocked'))
      ? { status: 'blocked', result: [] } : { status: 'error', result: [] };
  }
  if (!res.ok) return { status: 'error', result: [] };
  let json; try { json = await res.json(); } catch (_) { return { status: 'error', result: [] }; }
  if (json.errors && json.errors.length) return { status: 'error', result: [] };
  return { status: 'ok', result: (json.data || json)?.profileSearch?.result || [] };
}

// Returns { blocked: true } | null | { apiId, result } (result = a verified
// 'ok' fetchProfile() response for apiId — reused by the caller so we never
// fetch the same recovered id twice).
//
// Three tiers, cheapest/most-precise first:
//   1. grade + tid-based match  — real regs with a real tid (this player's
//      normal case).
//   2. grade + NAME-ONLY roster match — for any reg that has gid but no tid
//      (a much tighter search space than tenant-wide profileSearch).
//   3. profileSearch (+ orgId disambiguation) — final fallback.
async function attemptNamespaceRecovery(uuid, player) {
  if (isPlaceholderName(player.name)) return null; // no real name on file -- can't match

  let orgId = null;
  const regsWithTid = [];
  const allGids = new Set();
  for (const s of (player.seasons || [])) {
    if (!orgId) orgId = sportIndex.seasons?.[s.sid]?.orgId || null;
    for (const r of (s.regs || [])) {
      if (r.gid) allGids.add(r.gid);
      if (r.tid && r.gid) regsWithTid.push({ tid: r.tid, gid: r.gid });
    }
  }

  // Tier 1: tid-based match.
  const tidHits = new Set();
  for (const gid of new Set(regsWithTid.map(r => r.gid))) {
    const g = await gradePlayers(gid);
    if (g.status === 'blocked') return { blocked: true };
    for (const r of regsWithTid.filter(r => r.gid === gid)) {
      const m = matchFromGrade(g.results, { name: player.name, tid: r.tid });
      if (m) tidHits.add(m);
    }
  }
  let candidate = tidHits.size === 1 ? [...tidHits][0] : null;

  // Tier 2: grade-roster name-only match, for any grade we haven't already
  // resolved. gradePlayers() is cached, so a grade already fetched in Tier 1
  // costs nothing extra here.
  if (!candidate) {
    const rosterHits = new Set();
    for (const gid of allGids) {
      const g = await gradePlayers(gid);
      if (g.status === 'blocked') return { blocked: true };
      const m = matchFromGradeRosterByName(g.results, { name: player.name });
      if (m) rosterHits.add(m);
    }
    candidate = rosterHits.size === 1 ? [...rosterHits][0] : null;
  }

  // Tier 3: profileSearch (+ orgId) fallback.
  if (!candidate) {
    const sr = await profileSearchLookup(player.name);
    if (sr.status === 'blocked') return { blocked: true };
    candidate = matchFromSearch(sr.result, { name: player.name, orgId: null })
             || (orgId ? matchFromSearch(sr.result, { name: player.name, orgId }) : null);
  }
  if (!candidate || candidate === uuid) return null;

  const check = await fetchProfile(candidate);
  if (check.status === 'cloudfront-block') return { blocked: true };
  if (check.status !== 'ok') return null; // recovered id itself doesn't resolve -- don't overclaim
  return { apiId: candidate, result: check };
}

// ─── Player file helpers ──────────────────────────────────────────────────────

function playerPath(uuid) {
  return path.join(ROOT, 'players', SHARD, `${uuid}.json`);
}

function readPlayer(uuid) {
  return JSON.parse(fs.readFileSync(playerPath(uuid), 'utf8'));
}

function writePlayer(uuid, player) {
  fs.writeFileSync(playerPath(uuid), JSON.stringify(player), 'utf8');
}

// ─── Process one UUID ─────────────────────────────────────────────────────────

async function processUUID(uuid, stats, idx) {
  const short = uuid.slice(0, 8);
  const prefix = `  [${String(idx).padStart(4)}/${stats.total}]`;

  // Read the player file up front (not just on the "ok" path as before) — we
  // need it either way now: to get player.apiId (if a prior run already
  // recovered one) and to attempt namespace-mismatch recovery on failure.
  let player;
  try {
    player = readPlayer(uuid);
  } catch (err) {
    stats.errors++;
    console.log(`${prefix} ✗ ${short} ERROR reading player file: ${err.message}`);
    return;
  }

  const queryId = player.apiId || uuid;
  const result = await fetchProfile(queryId);

  if (result.status === 'inaccessible') {
    // Should not normally reach here — kept as safety fallback
    stats.inaccessible++;
    console.log(`${prefix} — ${short} inaccessible`);
    return;
  }

  if (result.status === 'private') {
    // Before accepting "private": the STORED id (spectator-namespace) can be
    // dead in the api namespace even for a real, live, public player — see
    // diagnose-namespace-mismatch.js (validated live on 3 known cases) and
    // diagnose-uuid-classification.js (~46% of a sampled backlog). Only
    // attempt recovery if we're not ALREADY querying a previously-recovered
    // apiId — if that itself now comes back private, the player is genuinely
    // gone and we don't re-attempt recovery indefinitely.
    if (!player.apiId) {
      const recovered = await attemptNamespaceRecovery(uuid, player);
      if (recovered && recovered.blocked) return { status: 'cloudfront-block' };
      if (recovered) {
        player.apiId = recovered.apiId;
        console.log(`${prefix} ⟳ ${short} recovered apiId -> ${recovered.apiId.slice(0, 8)}`);
        return finishOk(uuid, player, recovered.result, stats, prefix, short);
      }
    }

    // Genuine private/deleted profile (or recovery found nothing) — write
    // statsChecked so we never retry.
    stats.inaccessible++;
    try {
      if (!player.sports)            player.sports = {};
      if (!player.sports.Basketball) player.sports.Basketball = {};
      player.sports.Basketball.foulOuts       = {};
      player.sports.Basketball.maxGamePTS     = null;
      player.sports.Basketball.maxGameThreePt = null;
      player.sports.Basketball.statsChecked   = new Date().toISOString();
      if (!player.records) player.records = {};
      player.records.maxGamePTS     = { v: null };
      player.records.maxGameThreePt = { v: null };
      player.private = true; // explicit flag — name/prior stats left untouched
      writePlayer(uuid, player);
      stats.written++; // counts toward completion — won't be retried
    } catch (err) {
      console.log(`${prefix} ✗ ${short} could not write private marker: ${err.message}`);
    }
    console.log(`${prefix} — ${short} private profile (marked done)`);
    return;
  }

  if (result.status === 'cloudfront-block') {
    // Caller handles the wait-and-retry loop
    return result;
  }

  if (result.status === 'error') {
    stats.errors++;
    console.log(`${prefix} ✗ ${short} ERROR: ${result.err?.message}`);
    return;
  }

  return finishOk(uuid, player, result, stats, prefix, short);
}

// ─── Write a successful ("ok") fetch result to the player file ───────────────
// Extracted from processUUID so a namespace-mismatch recovery (which produces
// its own verified "ok" result against the recovered apiId) can reuse the
// exact same write logic as a direct hit — no behavioural difference between
// a player who resolved on the first try and one recovered via apiId.
function finishOk(uuid, player, result, stats, prefix, short) {
  const parsed = parseProfileStats(result.data);
  if (!parsed) {
    stats.inaccessible++;
    console.log(`${prefix} — ${short} no profile data`);
    return;
  }

  if (!player.sports)            player.sports = {};
  if (!player.sports.Basketball) player.sports.Basketball = {};

  // Write name if missing, OR replace a placeholder name now that the
  // profile is confirmed public (a private stub going public is exactly
  // when player.private is currently true — capture that BEFORE overwriting
  // it below). Without the wasPrivate check, a `Player #...` placeholder
  // name would never be replaced once set, even after the profile went public.
  //
  // wasPrivate ALSO falls back to the pre-flag legacy signal (statsChecked
  // present + maxGamePTS still null) for players marked private before this
  // flag existed. Without this fallback, a legacy-private player who jumps
  // straight to public on their FIRST check after this rollout would not
  // get their placeholder name replaced until a SECOND check (the first
  // would only backfill the flag). Read from player.sports.Basketball
  // directly here, before bk below overwrites maxGamePTS with fresh data.
  const oldBk       = player.sports.Basketball;
  const wasPrivate  = player.private === true ||
    (oldBk.statsChecked !== undefined && oldBk.maxGamePTS === null);
  if (parsed.playerName && (!player.name || wasPrivate)) {
    player.name = parsed.playerName;
  }
  player.private = false; // explicit flag — a successful fetch proves the profile is currently public

  const bk = player.sports.Basketball;
  bk.foulOuts       = parsed.foulOuts;
  bk.maxGamePTS     = parsed.maxGamePTS;
  bk.maxGameThreePt = parsed.maxGameThreePt;

  // Write per-reg stats (gp, pts, fg, ft, threePt, fouls) from per-game data
  // These replace the stale values written by the now-obsolete fetch-playhq.js
  const REG_STAT_FIELDS = ['gp', 'pts', 'fg', 'ft', 'threePt', 'fouls'];
  for (const season of (player.seasons || [])) {
    const sid = season.sid;
    for (const reg of (season.regs || [])) {
      const regKey = `${sid}:${reg.tid}`; // sid:tid — matches parseProfileStats regKey
      const rs = parsed.regStats.get(regKey);
      if (!reg.stats) reg.stats = {};
      for (const field of REG_STAT_FIELDS) {
        const val = rs ? (rs[field] || 0) : 0;
        if (val === 0) delete reg.stats[field];
        else reg.stats[field] = val;
      }
    }
  }

  // Career totals — sum across all regs (seenGameKeys dedup already applied per-game)
  const career = { gp: 0, pts: 0, fg: 0, ft: 0, threePt: 0, fouls: 0 };
  for (const [, rs] of parsed.regStats) {
    career.gp     += rs.gp;
    career.pts    += rs.pts;
    career.fg     += rs.fg;
    career.ft     += rs.ft;
    career.threePt += rs.threePt;
    career.fouls  += rs.fouls;
  }
  for (const field of REG_STAT_FIELDS) {
    if (career[field] === 0) delete bk[field];
    else bk[field] = career[field];
  }

  // Write gameTids — only for players with ambiguous seasons (multiple tids same season).
  // Allows build-win-loss and StatTrack to resolve which team a player was on per game.
  if (parsed.gameTids && Object.keys(parsed.gameTids).length > 0) {
    player.gameTids = parsed.gameTids;
  } else if (player.gameTids) {
    delete player.gameTids; // clean up if no longer ambiguous
  }

  // Write missing seasons and regs from API response.
  // Covers players whose profile stats came from the API but nightly crawl
  // never saw them in a spectator game (so player.seasons was never written).
  if (!player.seasons) player.seasons = [];
  for (const season of (result.data.publicProfileStatistics?.seasonStatistics || [])) {
    for (const reg of (season.statistics || [])) {
      const sid = reg?.season?.id;
      if (!sid) continue;
      for (const teamStat of (reg.teamStatistics || [])) {
        const tid = teamStat.team?.id;
        if (!tid) continue;
        let existingSeason = player.seasons.find(s => s.sid === sid);
        if (!existingSeason) {
          existingSeason = { sid, regs: [] };
          player.seasons.push(existingSeason);
        }
        if (!existingSeason.regs) existingSeason.regs = [];
        if (!existingSeason.regs.find(r => r.tid === tid)) {
          existingSeason.regs.push({ tid });
        }
      }
    }
  }

  // Write records with gameKey context for db-report and StatTrack game linking
  if (!player.records) player.records = {};
  player.records.maxGamePTS = parsed.maxGamePTSKey
    ? { v: parsed.maxGamePTS, ...parsed.maxGamePTSKey }
    : { v: parsed.maxGamePTS ?? null };
  player.records.maxGameThreePt = parsed.maxGameThreePtKey
    ? { v: parsed.maxGameThreePt, ...parsed.maxGameThreePtKey }
    : { v: parsed.maxGameThreePt ?? null };
  bk.statsChecked   = new Date().toISOString();

  writePlayer(uuid, player);
  stats.written++;
  const fo = Object.values(parsed.foulOuts).reduce((a, b) => a + b, 0);
  console.log(`${prefix} ✓ ${short} gp=${career.gp} pts=${career.pts} 3pt=${parsed.maxGameThreePt ?? 0} fo=${fo}`);
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function runPool(tasks, concurrency) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const task = tasks[i++];
      await task();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// ─── Sleep ────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// doFetch: wraps https.request with keepAlive:false to force a new TCP connection
// per request. This prevents CloudFront per-connection rate limiting.
function doFetch(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body   = options.body || '';
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  { ...options.headers, 'content-length': Buffer.byteLength(body) },
      agent:    new https.Agent({ keepAlive: false }),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        // Build a headers.get() shim matching the Fetch API.
        // Node's https module stores set-cookie as an array; join with ', '
        // so our existing cookie-parsing code works unchanged.
        const hdrs = res.headers;
        const headers = {
          get(name) {
            const val = hdrs[name.toLowerCase()];
            if (val === undefined || val === null) return null;
            return Array.isArray(val) ? val.join(', ') : val;
          },
        };
        resolve({
          status:  res.statusCode,
          ok:      res.statusCode >= 200 && res.statusCode < 300,
          headers,
          text:    () => Promise.resolve(rawBody),
          json:    () => Promise.resolve(JSON.parse(rawBody)),
        });
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
  console.log(`\nfetch-profile-stats  shard=${SHARD}  force=${FORCE}`);
  console.log('─'.repeat(50));

  const indexPath = path.join(ROOT, 'players', 'indexes', `${SHARD}.json`);
  if (!fs.existsSync(indexPath)) {
    console.error(`ERROR: index shard not found: ${indexPath}`);
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const uuids = Object.keys(index);
  console.log(`  UUIDs in shard: ${uuids.length}`);

  const allToFetch = FORCE
    ? uuids
    : uuids.filter(uuid => {
        try {
          const p = readPlayer(uuid);
          return !p?.sports?.Basketball?.statsChecked;
        } catch { return true; }
      });
  const toFetch = allToFetch.slice(0, MAX);

  const stats = {
    total:        Math.min(uuids.length, MAX),
    toFetch:      toFetch.length,
    written:      0,
    inaccessible: 0,
    skipped:      uuids.length - toFetch.length,
    errors:       0,
  };

  console.log(`  Already done (statsChecked present): ${stats.skipped}`);
  console.log(`  To fetch: ${stats.toFetch}`);

  if (stats.toFetch === 0) {
    console.log('  Nothing to do.');
    return;
  }

  console.log('\n  Obtaining session…');
  try {
    await refreshSession();
  } catch (err) {
    console.error(`  FATAL: Could not obtain session — ${err.message}`);
    console.log('  Writing empty summary and exiting cleanly.');
    const summaryPath = path.join(ROOT, `shard-summary-${SHARD}.json`);
    fs.writeFileSync(summaryPath, JSON.stringify({
      shard: SHARD, total: 0, already_done: 0, written: 0,
      inaccessible: 0, errors: 1, remaining: 0, blocked: false,
    }));
    process.exit(0);
  }

  console.log(`\n  Running (batch_size=30)…\n`);

  let blocked = false;
  let batchNum = 0;

  for (let batchStart = 0; batchStart < toFetch.length && !blocked; batchStart += 30) {
    // Refresh session before each batch (except first) to reset JWT quota
    if (batchNum > 0) {
      console.log(`  ↺ Session refresh before batch ${batchNum + 1}`);
      await refreshSession();
    }
    batchNum++;

    const batch = toFetch.slice(batchStart, Math.min(batchStart + 30, toFetch.length));

    const results = await Promise.allSettled(
      batch.map((uuid, j) => processUUID(uuid, stats, batchStart + j + 1))
    );

    const blockIdx = results.findIndex(r =>
      r.status === 'fulfilled' && r.value?.status === 'cloudfront-block'
    );

    if (blockIdx !== -1) {
      console.log(`\n  ⛔ CloudFront block in batch ${batchNum} (position ${batchStart + blockIdx + 1}).`);
      console.log(`  ${stats.written} written so far — re-run this shard to continue.`);
      blocked = true;
      break;
    }

    if (batchStart + 30 < toFetch.length) await sleep(1000);
  }

  stats.blocked = blocked;

  console.log('\n' + '─'.repeat(50));
  console.log(`  Written:       ${stats.written}`);
  console.log(`  Inaccessible:  ${stats.inaccessible}  (files untouched)`);
  console.log(`  Skipped:       ${stats.skipped}`);
  console.log(`  Errors:        ${stats.errors}`);
  if (stats.blocked) {
    const remaining = stats.toFetch - stats.written - stats.inaccessible - stats.errors;
    console.log(`  Remaining:     ~${remaining} (re-run shard to continue)`);
  }

  // Write shard summary for matrix aggregation
  const summaryPath = path.join(ROOT, `shard-summary-${SHARD}.json`);
  const remaining = stats.toFetch - stats.written - stats.inaccessible - stats.errors;
  fs.writeFileSync(summaryPath, JSON.stringify({
    shard:        SHARD,
    total:        stats.total,
    already_done: stats.skipped,
    written:      stats.written,
    inaccessible: stats.inaccessible,
    errors:       stats.errors,
    remaining:    Math.max(0, remaining),
    blocked:      stats.blocked || false,
  }));
  // No git operations — changed files are packaged and pushed by the aggregator job
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
