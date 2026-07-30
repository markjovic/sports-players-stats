// scripts/fetch-profile-stats.js
//
// Fetches publicProfileStatistics for all players in a single index shard.
// Run one shard at a time — the workflow uses sparse checkout so only
// players/indexes/{shard}.json and players/{shard}/ are on disk.
//
// Usage:
//   node scripts/fetch-profile-stats.js --shard=3a
//   node scripts/fetch-profile-stats.js --shard=3a --force
//   node scripts/fetch-profile-stats.js --shard=3a --recheck-private   # re-offer
//       players already marked private:true (see RECHECK_PRIVATE below) without
//       the cost of a repo-wide --force.
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
// statsChecked is written on EVERY terminal outcome — a real data response OR a
// confirmed not-obtainable profile (see markNotObtainable). It is NOT written for
// transient outcomes (network/GraphQL error, CloudFront block), so those players
// stay retryable. This header previously claimed "ONLY written on a real data
// response", which was false: the application-403 path has always written it
// (2026-07-29 — the claim also propagated into OUTSTANDING_TASKS §F and
// REPO_MANIFEST §6.9/§6.10, which described 403 as non-persisting).
//
// A 403 that persists after a session refresh = truly inaccessible profile.
// A 403 that resolves after a session refresh = session expiry (retry succeeds).
// All stats use seenGameKeys dedup — no double-counting across multiple regs.
//
// private flag (2026-07-10): previously "private" was inferred only from the
// `Player #<prefix>` name convention, which is ambiguous (a real player who
// never scored looks identical in storage to a confirmed-403 profile). This
// now writes an explicit player.private boolean on every outcome, so the two
// cases are distinguishable and so private<->public transitions are tracked:
//   - withheld (403 / not-found / 200-with-null-stats-object, all via
//     markNotObtainable) -> private = true.  Name is left untouched (if a real
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
const { TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');

// ─── CLI args ────────────────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const SHARD = (args.find(a => a.startsWith('--shard=')) || '').replace('--shard=', '').toLowerCase().trim();
const FORCE = args.includes('--force');
// --recheck-private re-offers players already marked private:true even though they
// carry statsChecked, WITHOUT the cost of a repo-wide --force (411k files). Withheld
// juniors go public between seasons, and statsChecked would otherwise make
// markNotObtainable permanent in practice — reversible only in principle.
// A re-check that comes back still-withheld simply re-marks (non-destructively, see
// markNotObtainable) and costs one write; one that comes back public writes real
// stats and clears private via finishOk, which already sets private = false on
// every successful fetch. Intended cadence: season boundaries.
const RECHECK_PRIVATE = args.includes('--recheck-private');
const MAX   = (() => { const a = args.find(a => a.startsWith('--max=')); return a ? parseInt(a.split('=')[1]) : Infinity; })();

if (!SHARD || !/^[0-9a-f]{2}$/.test(SHARD)) {
  console.error('Usage: node scripts/fetch-profile-stats.js --shard=<00-ff> [--force] [--recheck-private]');
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

  // 2026-07-30 — TWO bugs fixed here, both exposed by a 413k forced sweep:
  //
  // (1) A socket-level failure ESCAPED the 10-attempt loop entirely. The retry
  //     loop only ever retried the "response arrived but carried no usable
  //     cookies" case (`continue`). An exception from doFetch — ECONNRESET,
  //     socket hang up, DNS — propagated out of BOTH for-loops, rejected the
  //     promise and killed the shard with `FATAL: read ECONNRESET`. A normal
  //     nightly refreshes a handful of times; a forced sweep refreshes every 28
  //     batches across 256 shards, so a rare reset became near-certain somewhere.
  //     Network errors are now caught per request and treated as a failed
  //     attempt, so all 10 attempts are actually used.
  //
  // (2) `sessionPromise` was NOT cleared on the throw path — the assignment at
  //     the end of the loop was skipped when doFetch threw, leaving a REJECTED
  //     promise cached in the lock. Every later refreshSession() would return
  //     that same rejected promise from the `if (sessionPromise)` fast path, so
  //     the shard could never recover even if the caller retried. Now cleared in
  //     a `.finally()`, which runs on success, throw AND rejection.
  sessionPromise = (async () => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (attempt > 1) await sleep(attempt * 5000);
      for (const body of COOKIE_QUERIES) {
        let res;
        try {
          res = await doFetch(API_URL, {
            method:  'POST',
            headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() },
            body:    JSON.stringify(body),
          });
        } catch (err) {
          lastErr = err;
          console.log(`  … session refresh attempt ${attempt} network error: ${err.code || err.message} — retrying`);
          continue;
        }
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
        // NOTE: the exact string "Session refreshed (attempt N)" is used as
        // verification evidence in OUTSTANDING §A — do not reword it.
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    }
    throw new Error(`Failed to obtain session cookie after 10 attempts${lastErr ? ` (last network error: ${lastErr.code || lastErr.message})` : ''}`);
  })().finally(() => { sessionPromise = null; });

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

  // NO player name is available from publicProfileStatistics. seasonStatistics[].name
  // is the SEASON label ("Autumn 2021", "Summer 2022/23"), NOT the person — reading
  // [0].name here wrote season strings into player.name for every player who reached
  // finishOk without a prior name (40,034 files; see repair-season-names.js). Never
  // derive a name from this call again.
  //
  // Real names come from two places, neither of them this query:
  //   1. publicProfile on the ACCOUNT tenant — fetchPublicProfileName() below. The
  //      canonical id->name lookup; see playhq_api_reference.md -> publicProfile.
  //   2. The spectator side (nightly-crawl.js Phase 3 rosters).
  // This comment previously named only (2), predating fetchPublicProfileName().
  const playerName = null;

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

// ─── Real name via publicProfile (ACCOUNT tenant) ─────────────────────────
// The authoritative id->name lookup publicProfileStatistics can't give. Uses the
// ACCOUNT tenant (cross-sport identity), not basketball-victoria, so it resolves
// spectator-keyed ids too. Request shape mirrors fetchProfile (doFetch + HEADERS_BASE
// + session), with tenant overridden. Returns a trimmed name, or null (not found /
// hidden / transient) — on null the caller keeps the existing name and retries later.
const normName = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
const PUBLIC_PROFILE_QUERY = {
  operationName: 'publicProfile',
  query: 'query publicProfile($profileID: ID!) { publicProfile(profileID: $profileID) { id firstName lastName __typename } }',
};
// 2026-07-30: every null return below was previously indistinguishable — no status,
// no reason, no counter. That is why a name-repair that has been failing on the same
// player since 2026-06-27 was invisible for a month: the caller's `if (realName)`
// guard silently keeps the bad name, and statsChecked is written regardless, so the
// player is never re-queued. `lastFailReason` is set on every null path so the caller
// can log WHY (instrumentation before theory — a status code and a body snippet beat
// a hypothesis). Returns a trimmed name, or null.
let lastPublicProfileFail = null;
async function fetchPublicProfileName(profileID) {
  lastPublicProfileFail = null;
  if (!sessionCookie) await refreshSession();
  const mkHeaders = () => ({ ...HEADERS_BASE, 'tenant': 'account', 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie });
  const body = JSON.stringify({ ...PUBLIC_PROFILE_QUERY, variables: { profileID } });
  const readName = async res => {
    if (!res) { lastPublicProfileFail = 'no response'; return null; }
    if (res.status !== 200) {
      let snip = '';
      try { snip = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200); } catch (_) {}
      lastPublicProfileFail = `HTTP ${res.status}${snip ? ` — ${snip}` : ''}`;
      return null;
    }
    let j = null; try { j = await res.json(); } catch (_) { lastPublicProfileFail = 'unparseable JSON'; return null; }
    if (!j) { lastPublicProfileFail = 'empty body'; return null; }
    if (j.errors) {
      lastPublicProfileFail = `graphql: ${String(j.errors[0] && j.errors[0].message).slice(0, 160)}`;
      return null;
    }
    const pr = j.data && j.data.publicProfile;
    // 200 + data.publicProfile === null is the interesting case: the id is simply
    // not resolvable on the ACCOUNT tenant. A folded player is keyed by its api id,
    // which may not be the account/spectator identity this endpoint expects.
    if (!pr) { lastPublicProfileFail = 'publicProfile null (id not on account tenant)'; return null; }
    const nm = `${pr.firstName || ''} ${pr.lastName || ''}`.trim();
    if (!nm) { lastPublicProfileFail = 'profile found but no first/last name'; return null; }
    return nm;
  };
  try {
    let res = await doFetch(API_URL, { method: 'POST', headers: mkHeaders(), body });
    if (res.status === 403) { await refreshSession(); res = await doFetch(API_URL, { method: 'POST', headers: mkHeaders(), body }); }
    return await readName(res);
  } catch (e) {
    lastPublicProfileFail = `exception: ${String(e && e.message).slice(0, 160)}`;
    return null;
  }
}

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
// and genuinely paginated (see the CORRECTED note below — this line previously
// asserted a hard cap of 50, contradicting it). Only usable when the
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

// ─── Alias persistence on divergence discovery (api-canonical, 2026-07-16) ────
// When recovery finds that a spectator-keyed player's real api id differs, the
// discovery MUST be persisted to players/aliases/{bucket}.json or the shared
// resolver (uuid-prefix.cjs) and StatTrack stay blind to it. Bucket == this
// job's --shard (spectator prefix), so concurrent matrix jobs never write the
// same alias file. Write format matches build-alias-index.js exactly: sorted
// keys, minified. The workflow's sparse-checkout must include this path — see
// fetch-profile-stats-matrix.yml.
function recordAliasDiscovery(spectatorUuid, apiId) {
  const bucket = spectatorUuid.slice(0, 2).toLowerCase();
  const aliasPath = path.join(ROOT, 'players', 'aliases', `${bucket}.json`);
  let map = {};
  try { map = JSON.parse(fs.readFileSync(aliasPath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const key = String(spectatorUuid).slice(0, TRUNC_LEN);
  if (map[key] === apiId) return; // already recorded
  map[key] = apiId;
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
  fs.writeFileSync(aliasPath, JSON.stringify(sorted));
}

// ─── Terminal write for a profile whose stats cannot be obtained ─────────────
// Single write path for BOTH not-obtainable statuses, which until 2026-07-29 were
// handled oppositely:
//
//   'private'      — application-403, or GraphQL NOT_FOUND. Always wrote statsChecked.
//   'inaccessible' — HTTP 200 with publicProfileStatistics === null. Wrote NOTHING,
//                    so those players carried no statsChecked and were re-fetched on
//                    EVERY run, forever. `remaining` could never reach 0, and because
//                    they produce no write the matrix's consecutive-zeros rule read
//                    that as a completed sweep (211 players in the 2026-07-28 run).
//
// Both are the server deliberately withholding data, neither is an error, and neither
// resolves on its own — so both are terminal and both are marked done. Recovery is
// still attempted first in processUUID: a stored spectator-keyed id can be dead in the
// api namespace for a live player (~46% of a sampled backlog), and marking without
// attempting recovery would freeze exactly the players the recovery tiers exist for.
//
// private = true is set for both. The null test here is `!publicProfileStatistics`
// (the whole object absent), NOT an empty seasonStatistics array — a registered player
// who never played returns `seasonStatistics: []`, which is truthy and flows through
// finishOk normally. So a null object is the API withholding, not "no games".
// This state is sticky: statsChecked means only a --force sweep re-checks it, exactly
// as for application-403 players today. To keep the flag conservative instead, drop the
// `player.private = true` line below and these players fall back to name-pattern
// inference in StatTrack.
//
// Counters: inaccessible is a REPORTING SUBSET of written (both increment here), so
// `remaining` must subtract written and errors only — never both written and
// inaccessible, which double-counted every 403 player before this change.
function markNotObtainable(uuid, player, stats, prefix, short, reason) {
  try {
    if (!player.sports)            player.sports = {};
    if (!player.sports.Basketball) player.sports.Basketball = {};
    const bk = player.sports.Basketball;

    // DIRTY-CHECK (2026-07-29) — without this, --recheck-private CANNOT TERMINATE.
    // statsChecked used to be rewritten unconditionally, so a re-offered player who
    // was still withheld got a fresh timestamp and nothing else. That is a modified
    // file: packaged, committed, and counted as written. written > 0 resets
    // consecutive_zeros to 0 on every run, recheck_private propagates to the next
    // run, run 2 re-offers the identical population and writes fresh timestamps
    // again — so the chain runs to run_number >= 150, exits max_runs RED, and the
    // terminal fan-out (leaderboards / search-index / records / fold / team-stats)
    // is gated on status == 'stuck' and therefore NEVER FIRES. The cost scales with
    // the private population but the non-termination does not: it happens at any N.
    //
    // Skipping the no-op write also fixes the SEMANTICS rather than just papering
    // over the loop. During a re-check sweep `written` becomes a TRANSITION count:
    // a player who came back public writes real stats via finishOk (which sets
    // private = false, so the flag self-repairs), and a player who stayed withheld
    // writes nothing. "3 consecutive runs with 0 written" then means "no further
    // private -> public transitions found", which is the correct terminal condition
    // for a re-check instead of an accident of timestamp churn.
    //
    // Cost: statsChecked goes stale on players that stay withheld. Functionally
    // harmless — its only job is the eligibility gate in main(), and a
    // stale-but-present value gates identically. Deliberately NOT adding a
    // privateCheckedAt field: bytes across a large population for no functional gain.
    const alreadyMarked = !!bk.statsChecked && player.private === true;
    const needsInit =
      bk.foulOuts       === undefined ||
      bk.maxGamePTS     === undefined ||
      bk.maxGameThreePt === undefined ||
      !player.records                 ||
      player.records.maxGamePTS     === undefined ||
      player.records.maxGameThreePt === undefined;

    if (alreadyMarked && !needsInit) {
      // Nothing to change on disk. Counted separately: NOT written (no write
      // happened), NOT inaccessible (that counter means "newly marked", and must
      // stay a strict subset of written), NOT an error, and NOT remaining (this
      // player WAS reached and needs nothing).
      stats.unchanged++;
      console.log(`${prefix} · ${short} still ${reason} (no change)`);
      return;
    }

    // NON-DESTRUCTIVE (2026-07-29). These five fields are INITIALISED when absent
    // and PRESERVED when already populated. A withheld response must never erase
    // data a previous public fetch captured — claude_context: "withheld/junior data
    // must never be overwritten by an empty API response".
    //
    // Reachable, so not theoretical: statsChecked normally shields an
    // already-fetched player, but `force` is an input on this very workflow and
    // clear-stats-checked.js strips statsChecked repo-wide. On that sweep a player
    // who was public in an earlier season and is withheld today comes back through
    // here — and the unguarded version nulled their captured maxGamePTS, foulOuts
    // and records. The withheld state is real and worth recording; the loss of a
    // prior capture is not, and it is silent.
    //
    // Same rule for --recheck-private sweeps, which deliberately re-offer this
    // exact population.
    if (bk.foulOuts       === undefined) bk.foulOuts       = {};
    if (bk.maxGamePTS     === undefined) bk.maxGamePTS     = null;
    if (bk.maxGameThreePt === undefined) bk.maxGameThreePt = null;
    bk.statsChecked = new Date().toISOString();

    if (!player.records) player.records = {};
    if (player.records.maxGamePTS     === undefined) player.records.maxGamePTS     = { v: null };
    if (player.records.maxGameThreePt === undefined) player.records.maxGameThreePt = { v: null };

    // Always current, never inferred: a withheld response is proof of the CURRENT
    // state even when prior captured stats are retained above.
    player.private = true; // explicit flag — name and any prior capture left intact
    writePlayer(uuid, player);
    stats.inaccessible++;
    stats.written++;
    console.log(`${prefix} — ${short} ${reason} (marked done)`);
  } catch (err) {
    // Write failed: no statsChecked on disk, so the player stays retryable. Counted
    // as an error, never as written — otherwise remaining would over-report progress.
    stats.errors++;
    console.log(`${prefix} ✗ ${short} could not write not-obtainable marker: ${err.message}`);
  }
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

  if (result.status === 'private' || result.status === 'inaccessible') {
    // Before accepting either status as terminal: the STORED id (spectator-
    // namespace) can be dead in the api namespace even for a real, live, public
    // player — see diagnose-namespace-mismatch.js (validated live on 3 known
    // cases) and diagnose-uuid-classification.js (~46% of a sampled backlog).
    // Extended 2026-07-29 to cover 'inaccessible' too: a 200-with-null-object is
    // just as consistent with a namespace mismatch as a 403, and this class was
    // previously marked terminal-but-unwritten without ever being offered to the
    // recovery tiers. Only attempt recovery if we're not ALREADY querying a
    // previously-recovered apiId — if that itself now comes back withheld, the
    // player is genuinely gone and we don't re-attempt recovery indefinitely.
    if (!player.apiId) {
      const recovered = await attemptNamespaceRecovery(uuid, player);
      if (recovered && recovered.blocked) return { status: 'cloudfront-block' };
      if (recovered) {
        player.apiId = recovered.apiId;
        // Persist the discovery: alias entry (resolver/StatTrack) + spectatorIds
        // on the player (source of truth for any future alias rebuild — player
        // files no longer carry apiId after a fold promotes them).
        recordAliasDiscovery(uuid, recovered.apiId);
        const spec = new Set(Array.isArray(player.spectatorIds) ? player.spectatorIds : []);
        spec.add(String(uuid).slice(0, TRUNC_LEN));
        spec.add(String(recovered.apiId).slice(0, TRUNC_LEN));
        player.spectatorIds = [...spec].sort();
        console.log(`${prefix} ⟳ ${short} recovered apiId -> ${recovered.apiId.slice(0, 8)} (alias recorded)`);
        return finishOk(uuid, player, recovered.result, stats, prefix, short);
      }
    }

    // Withheld profile (or recovery found nothing) — write statsChecked so we
    // never retry. Reason distinguishes the two statuses in the log.
    markNotObtainable(
      uuid, player, stats, prefix, short,
      result.status === 'private' ? 'private profile' : 'no stats object returned',
    );
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
async function finishOk(uuid, player, result, stats, prefix, short) {
  const parsed = parseProfileStats(result.data);
  if (!parsed) {
    // Same withheld class as status 'inaccessible' (seasonStatistics absent on an
    // otherwise-ok response). Previously wrote nothing, so these players were
    // re-fetched every run forever — see markNotObtainable.
    markNotObtainable(uuid, player, stats, prefix, short, 'no profile data');
    return;
  }

  if (!player.sports)            player.sports = {};
  if (!player.sports.Basketball) player.sports.Basketball = {};

  // Real name — the authoritative source. publicProfileStatistics carries none, so
  // fetch it directly from publicProfile (account tenant) when the stored name is
  // missing, a placeholder, or a season string left by the old parseProfileStats bug.
  // An established real name is left alone — no extra fetch for players who have one.
  const curName      = player.name;
  const contaminated = !!curName && (player.seasons || []).some(sn => normName(sn.sn) === normName(curName));
  if (!curName || isPlaceholderName(curName) || contaminated) {
    // Use the SAME id the stats fetch used (queryId = player.apiId || uuid, L783).
    // player.apiId is assigned before the recovery path calls finishOk, so this
    // mirrors it on both paths. Previously this always passed the file uuid, even
    // when recovery had just PROVEN that id dead in the api namespace and handed
    // back a working apiId.
    const nameId   = player.apiId || uuid;
    const realName = await fetchPublicProfileName(nameId);
    if (realName) {
      player.name = realName;
      if (contaminated) {
        stats.nameHealed++;
        console.log(`${prefix} ✎ ${short} name repaired: "${curName}" -> "${realName}"`);
      }
    } else if (contaminated) {
      // The repair fired and FAILED. This is the case that went unseen for a month.
      // statsChecked is still written below, so this player will not be re-queued —
      // it needs a full sweep or a targeted re-run to be retried at all.
      stats.nameHealFailed++;
      console.log(`${prefix} ⚠ ${short} name STILL contaminated ("${curName}") — publicProfile(${String(nameId).slice(0, 8)}) gave nothing: ${lastPublicProfileFail || 'unknown'}`);
    }
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

// Players this run never REACHED — the "re-run shard to continue" figure for a
// CloudFront-blocked shard. Not the same as "players still lacking statsChecked":
// an errored player was reached and will be retried next run, but is not remaining.
//
// Subtracts written, errors and unchanged. `inaccessible` is a reporting subset of
// `written` (markNotObtainable increments both when it writes), so the old
//   toFetch - written - inaccessible - errors
// double-subtracted every withheld player. That is why a shard finishing on 211
// unwritten players reported remaining = 0 while none of them had statsChecked —
// the Math.max(0, …) floor hid the negative rather than the miscount.
//
// `unchanged` (2026-07-29) is the dirty-check population: already-marked withheld
// players re-offered by --recheck-private that needed no write. They WERE reached,
// so leaving them in remaining would report `remaining = N` on every run of a
// re-check sweep and contradict this field's definition.
//
// A CloudFront-blocked shard stops mid-list; its unprocessed players are neither
// written, errored nor unchanged, so they correctly fall into remaining.
function remainingCount(stats) {
  return Math.max(0, stats.toFetch - stats.written - stats.errors - stats.unchanged);
}

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
  console.log(`\nfetch-profile-stats  shard=${SHARD}  force=${FORCE}  recheck-private=${RECHECK_PRIVATE}`);
  console.log('─'.repeat(50));

  const indexPath = path.join(ROOT, 'players', 'indexes', `${SHARD}.json`);
  if (!fs.existsSync(indexPath)) {
    console.error(`ERROR: index shard not found: ${indexPath}`);
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const uuids = Object.keys(index);
  console.log(`  UUIDs in shard: ${uuids.length}`);

  let recheckable = 0;
  const allToFetch = FORCE
    ? uuids
    : uuids.filter(uuid => {
        try {
          const p = readPlayer(uuid);
          if (!p?.sports?.Basketball?.statsChecked) return true;
          // statsChecked present. Normally done — unless this is a private
          // re-check sweep and the player is one of the withheld population.
          if (RECHECK_PRIVATE && p.private === true) { recheckable++; return true; }
          return false;
        } catch { return true; }
      });
  const toFetch = allToFetch.slice(0, MAX);

  const stats = {
    total:        Math.min(uuids.length, MAX),
    toFetch:      toFetch.length,
    written:      0,
    inaccessible: 0,
    unchanged:    0,
    skipped:      uuids.length - toFetch.length,
    errors:       0,
    nameHealed:     0,  // contaminated name successfully replaced with a real one
    nameHealFailed: 0,  // contaminated name detected but publicProfile gave nothing
  };

  console.log(`  Already done (statsChecked present): ${stats.skipped}`);
  if (RECHECK_PRIVATE) console.log(`  Re-offered (private:true, statsChecked present): ${recheckable}`);
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
      inaccessible: 0, unchanged: 0, errors: 1, remaining: 0, blocked: false,
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
  console.log(`  Not obtainable: ${stats.inaccessible}  (newly marked — subset of Written)`);
  console.log(`  Still withheld: ${stats.unchanged}  (already marked, nothing to write)`);
  console.log(`  Skipped:       ${stats.skipped}`);
  console.log(`  Errors:        ${stats.errors}`);
  if (stats.nameHealed || stats.nameHealFailed) {
    console.log(`  Name repairs:  ${stats.nameHealed} fixed, ${stats.nameHealFailed} STILL contaminated`);
  }
  if (stats.blocked) {
    console.log(`  Remaining:     ~${remainingCount(stats)} (re-run shard to continue)`);
  }

  // Write shard summary for matrix aggregation
  const summaryPath = path.join(ROOT, `shard-summary-${SHARD}.json`);
  const remaining = remainingCount(stats);
  fs.writeFileSync(summaryPath, JSON.stringify({
    shard:        SHARD,
    total:        stats.total,
    already_done: stats.skipped,
    written:      stats.written,
    inaccessible: stats.inaccessible,
    unchanged:    stats.unchanged,
    errors:       stats.errors,
    name_healed:      stats.nameHealed,
    name_heal_failed: stats.nameHealFailed,
    remaining:    remaining,
    blocked:      stats.blocked || false,
  }));
  // No git operations — changed files are packaged and pushed by the aggregator job
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
