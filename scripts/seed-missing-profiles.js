// scripts/seed-missing-profiles.js
//
// WRITES when --apply. Takes the data-write lock. DRY RUN BY DEFAULT.
//
// THE PROBLEM, established over three probes on 2026-08-24.
//
// 40 alias entries send a real PlayHQ profile id to a DIFFERENT player. The box
// score proves it — for every one, the profileID it returns is simply the alias id
// expanded to 36 characters:
//
//     alias id      20b7995f-d708
//     PlayHQ says   20b7995f-d708-429c-97d8-c6f3b3601fb3   ← the SAME id
//     alias sends it to  66e58ba9-b69a-461e-8c90-04d4f062d9c0   ← someone else
//
// So the alias should be DELETED, not repointed: with no entry the id resolves to
// itself. But `probe-selfalias-check` found that NONE of the 40 full uuids has a
// player file — so deleting first would ORPHAN every one of those appearances.
//
// WHY THEY HAVE NO FILE. They are real profiles our pipeline has never fetched.
// `fetch-profile-stats` works from `players/indexes/{shard}.json` and they are not
// in it; `spectator-backfill` now refuses to stub anything it cannot confirm is an
// api profile (T36). The alias was papering over that gap by pointing them at a
// same-named player who HAD been fetched.
//
// WHAT THIS DOES, in the only safe order:
//   1. Fetch the real name from `publicProfile` on the ACCOUNT tenant — the
//      canonical id→name lookup, never a box-score name.
//   2. Write a SEED player file and an index entry, so the id resolves to itself.
//   3. Delete the alias, now that deleting cannot orphan anything.
//
// It does NOT fetch statistics. `fetch-profile-stats` fills those in on its next
// pass now the player is indexed, and `build-player-games` populates games[] from
// the rosters. This tool only closes the gap that makes deletion unsafe.
//
// REVERSIBLE: every alias removed is recorded in reports/seeded-profiles.json with
// what it pointed at, BEFORE anything is written.
//
// Usage:
//   node scripts/seed-missing-profiles.js
//   node scripts/seed-missing-profiles.js --apply

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
const { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

// ⚠ The block below is copied VERBATIM from fetch-profile-stats.js and depends on
// globals that script declares from its own command line. They are declared here
// explicitly rather than left to resolve by accident — copying a block means
// copying its dependencies (2026-08-24 directive A). None of the code paths that
// use them are reachable from this tool, but an undeclared reference would throw
// the moment one was.
const SHARD = null;               // this tool works from a uuid list, not a shard
const FORCE = false;
const RECHECK_PRIVATE = false;
const HEAL_NAMES = false;
const HEAL_SEASON_NAMES = false;
const MAX = 0;
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
// normName v2 (2026-08-02) — matches lib/namespace-resolve.cjs EXACTLY. Six copies repo-wide; one pass.
const normName = s => String(s == null ? '' : s).normalize('NFKC').replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2010-\u2015\u2212]/g, '-').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
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
  // ─── Name heal, with BOUNDED RETRY (OUTSTANDING §B3, decided 2026-07-31) ─────
  // The problem this solves: statsChecked is written whether the heal succeeded or
  // not, and no scheduled run ever re-reads a player carrying statsChecked. So a
  // single TRANSIENT failure was PERMANENT — one bad second on 2026-06-27 left a
  // player named "Winter 2026" for 34 days, found only by a full-repo audit.
  //
  // Option (a) of three: a persisted attempt counter. Retries transients, caps
  // permanents. Withholding statsChecked instead (option b) would have re-fetched a
  // genuinely unresolvable id every run forever — the exact anti-pattern
  // markNotObtainable exists to kill.
  //
  // Reset rules matter as much as the cap:
  //   - success        -> counter DELETED (a later regression gets a fresh 3)
  //   - --force        -> counter DELETED before trying (an explicit human retry
  //                       must not be silently refused by an old give-up)
  //   - gave up        -> counter left at MAX, no fetch, counted in the summary
  // A stale counter on a player whose name is fine is inert: the heal only fires
  // for missing / placeholder / contaminated names. It is deliberately NOT cleared
  // in that case, because deleting the field would dirty the file and cause a write
  // on every run for no benefit.
  const curName      = player.name;
  // TWO TESTS. The self-match alone is what let players named "Winter 2026" survive
  // every pass: it only fires when the name equals a season string ON THIS FILE, and
  // a file whose own seasons are unnamed — which was most of them until 2026-08-22
  // — has nothing to match against. The shape test catches a season label whoever
  // carries it, and is shared with scan-season-name-contamination through
  // lib/namespace-resolve.cjs so the two cannot drift apart again.
  const selfMatch    = !!curName && (player.seasons || []).some(sn => normName(sn.sn) === normName(curName));
  const contaminated = selfMatch || looksLikeSeasonName(curName);
  if (!curName || isPlaceholderName(curName) || contaminated) {
    if (FORCE && player.nameHealAttempts !== undefined) delete player.nameHealAttempts;
    const attempts = Number(player.nameHealAttempts) || 0;

    if (attempts >= NAME_HEAL_MAX_ATTEMPTS) {
      stats.nameHealGaveUp++;
      console.log(`${prefix} ⊘ ${short} name heal GAVE UP after ${attempts} attempts — name left as ${curName ? `"${curName}"` : '(absent)'}. Re-dispatch with force=true to retry.`);
    } else {
      // Use the SAME id the stats fetch used (queryId = player.apiId || uuid, L783).
      // player.apiId is assigned before the recovery path calls finishOk, so this
      // mirrors it on both paths. Previously this always passed the file uuid, even
      // when recovery had just PROVEN that id dead in the api namespace and handed
      // back a working apiId.
      const nameId   = player.apiId || uuid;
      const realName = await fetchPublicProfileName(nameId);
      if (realName) {
        player.name = realName;
        if (player.nameHealAttempts !== undefined) delete player.nameHealAttempts;
        if (contaminated) {
          stats.nameHealed++;
          console.log(`${prefix} ✎ ${short} name repaired: "${curName}" -> "${realName}"`);
        }
      } else {
        // Persist the attempt so the NEXT run retries rather than writing this
        // player off. This is the whole point of §B3 — the counter is what makes a
        // transient failure survivable.
        player.nameHealAttempts = attempts + 1;
        stats.nameHealFailed++;
        const detail = `publicProfile(${String(nameId).slice(0, 8)}) gave nothing: ${lastPublicProfileFail || 'unknown'}`;
        if (contaminated) {
          console.log(`${prefix} ⚠ ${short} name STILL contaminated ("${curName}") — attempt ${attempts + 1}/${NAME_HEAL_MAX_ATTEMPTS} — ${detail}`);
        } else {
          console.log(`${prefix} · ${short} name unresolved — attempt ${attempts + 1}/${NAME_HEAL_MAX_ATTEMPTS} — ${detail}`);
        }
      }
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
  // ⚠ THIS BLOCK USED TO WRITE `{ tid }` AND NOTHING ELSE — fixed 2026-08-21.
  //
  // The query above already asks for `seasonStatistics.name`, `team { id name }`
  // and `grade { id name }`. Every one of them was fetched, parsed and thrown away,
  // so a season written by this back-fill carried a season id and a team id and no
  // words at all. StatTrack renders those rows as "." and "?" because there is
  // nothing to render.
  //
  // Tahlia Parker (20b2df06-37f4-48a9-8477-1f6185bc7533) is the case that exposed
  // it: 30 seasons, ONE with names — the one the nightly crawl happened to see in a
  // spectator game — and 29 blank ones from this path. PlayHQ's own website shows
  // teams and grades for all 389 of her games, so the data was never missing; we
  // discarded it at the point of writing.
  //
  // NEVER OVERWRITE what the crawl wrote. The crawl sees the game and has the club
  // and the team's display name; this response has the season and grade names. Fill
  // only what is ABSENT, so a richer existing record is never degraded by a later
  // stats fetch.
  if (!player.seasons) player.seasons = [];
  for (const season of (result.data.publicProfileStatistics?.seasonStatistics || [])) {
    const seasonName = season?.name || null;         // e.g. "Winter 2026"
    for (const reg of (season.statistics || [])) {
      const sid = reg?.season?.id;
      if (!sid) continue;
      for (const teamStat of (reg.teamStatistics || [])) {
        const tid = teamStat.team?.id;
        if (!tid) continue;
        const teamName = teamStat.team?.name || null;
        // A team can appear in several grades in one season (regrading). Join the
        // names rather than picking one, and never invent an order.
        const gradeNames = [...new Set((teamStat.gradeStatistics || [])
          .map(g => g?.grade?.name).filter(Boolean))];
        const gradeIds = [...new Set((teamStat.gradeStatistics || [])
          .map(g => g?.grade?.id).filter(Boolean))];
        let existingSeason = player.seasons.find(s => s.sid === sid);
        if (!existingSeason) {
          existingSeason = { sid, regs: [] };
          player.seasons.push(existingSeason);
        }
        if (!existingSeason.sn && seasonName) existingSeason.sn = seasonName;
        if (!existingSeason.regs) existingSeason.regs = [];
        let r = existingSeason.regs.find(x => x.tid === tid);
        if (!r) { r = { tid }; existingSeason.regs.push(r); }
        if (!r.tn && teamName) r.tn = teamName;
        if (!r.gn && gradeNames.length) r.gn = gradeNames.join(' / ');
        if (!r.gid && gradeIds.length === 1) r.gid = gradeIds[0];
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

  // Track heal attempts so an UNHEALABLE player stops being re-offered — this is
  // what lets the matrix chain reach zero writes and stop.
  if (HEAL_SEASON_NAMES) {
    if (needsSeasonNames(player)) player.seasonHealAttempts = ((player.seasonHealAttempts || 0) + 1);
    else if (player.seasonHealAttempts !== undefined) delete player.seasonHealAttempts;
  }

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


// ── The tool ────────────────────────────────────────────────────────────────
const APPLY_SEED = process.argv.slice(2).includes('--apply');
const _GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const nfmt = (x) => Number(x || 0).toLocaleString();

async function main() {
  console.log('seed-missing-profiles — ' + (APPLY_SEED ? 'APPLY (writes and commits)' : 'DRY RUN (writes nothing)'));

  let audit;
  try { audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'unresolved-alias-audit.json'), 'utf8')); }
  catch (e) { console.error('ABORT: reports/unresolved-alias-audit.json not readable — ' + e.message); process.exit(1); }

  // Only entries where the box-score id IS the alias id expanded. Anything else is
  // a different problem and is left alone.
  const work = [];
  for (const e of (audit.entries || [])) {
    const pids = [...new Set((e.box || []).map(b => b && b.profileID).filter(Boolean))];
    if (pids.length !== 1) continue;
    const pid = pids[0];
    if (!(pid.startsWith(e.id) || e.id.startsWith(pid.slice(0, 13)))) continue;
    work.push({ aliasId: e.id, uuid: pid, target: e.target, boxName: e.name });
  }
  console.log('  self-expansion entries : ' + nfmt(work.length));

  const already = work.filter(w => fs.existsSync(path.join(ROOT, 'players', w.uuid.slice(0, 2), w.uuid + '.json')));
  const todo = work.filter(w => !already.includes(w));
  console.log('  already have a file    : ' + nfmt(already.length));
  console.log('  to seed                : ' + nfmt(todo.length));
  console.log('');
  if (!todo.length && !already.length) { console.log('  nothing to do'); return; }

  // ── 1. The canonical name ─────────────────────────────────────────────────
  console.log('  ══ FETCHING THE REAL NAME FROM publicProfile ══════════════════════');
  console.log('  The ACCOUNT-tenant publicProfile endpoint is the canonical id→name');
  console.log('  lookup. The box-score name is NOT used — it is a display string.');
  const seeded = [];
  for (const w of todo) {
    const name = await fetchPublicProfileName(w.uuid);
    w.realName = name;
    w.nameFail = name ? null : (lastPublicProfileFail || 'unknown');
    console.log('    ' + w.uuid + '  ' + (name ? JSON.stringify(name) : 'NO NAME (' + w.nameFail + ')') +
                (name && w.boxName && name !== w.boxName ? '   box score said ' + JSON.stringify(w.boxName) : ''));
    if (name) seeded.push(w);
    await sleep(400);
  }
  console.log('');
  console.log('    name obtained : ' + nfmt(seeded.length) + '   ← these can be seeded');
  console.log('    no name       : ' + nfmt(todo.length - seeded.length) + '   ← NOT seeded; a profile with no obtainable name is not written');
  console.log('');

  for (const w of seeded) {
    console.log('    SEED  ' + w.uuid + '  ' + JSON.stringify(w.realName));
    console.log('        then DELETE alias ' + w.aliasId + ' which currently sends it to ' + w.target);
  }
  console.log('');
  if (!APPLY_SEED) { console.log('  DRY RUN — nothing written. Re-run with --apply.'); return; }
  if (!seeded.length) { console.log('  nothing to write'); return; }

  // ── 2. Record BEFORE writing ──────────────────────────────────────────────
  const logPath = path.join(ROOT, 'reports', 'seeded-profiles.json');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify({ applied: new Date().toISOString(),
    note: 'to undo: delete the seeded player file and index entry, and restore each alias to its `was` value',
    entries: seeded.map(w => ({ uuid: w.uuid, name: w.realName, aliasId: w.aliasId, was: w.target })) }, null, 1));
  console.log('  recorded ' + nfmt(seeded.length) + ' change(s) in reports/seeded-profiles.json BEFORE touching anything');

  // ── 3. Seed the player file and the index ─────────────────────────────────
  const touched = new Set();
  for (const w of seeded) {
    const dir = path.join(ROOT, 'players', w.uuid.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    // A SEED, deliberately minimal: identity only. statsChecked is NOT set, so
    // fetch-profile-stats treats it as never fetched and fills it on its next pass.
    // games[] stays empty until build-player-games derives it from the rosters —
    // writing games here would be inventing data this tool has not verified.
    const seed = { uuid: w.uuid, name: w.realName, sports: {}, seasons: [], teams: [],
                   spectatorIds: [w.uuid.slice(0, 13)], updatedAt: new Date().toISOString(),
                   private: false, games: [] };
    fs.writeFileSync(path.join(dir, w.uuid + '.json'), JSON.stringify(seed), 'utf8');
    touched.add('players/' + w.uuid.slice(0, 2));

    const idxPath = path.join(ROOT, 'players', 'indexes', w.uuid.slice(0, 2) + '.json');
    let idx = {};
    try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch (e) {}
    if (!idx[w.uuid]) idx[w.uuid] = { name: w.realName, history: {} };
    const sorted = {};
    for (const k of Object.keys(idx).sort()) sorted[k] = idx[k];
    fs.mkdirSync(path.dirname(idxPath), { recursive: true });
    fs.writeFileSync(idxPath, JSON.stringify(sorted), 'utf8');
    touched.add('players/indexes/' + w.uuid.slice(0, 2) + '.json');
  }
  console.log('  seeded ' + nfmt(seeded.length) + ' player file(s) and index entrie(s)');

  // ── 4. NOW it is safe to delete the alias ─────────────────────────────────
  let removed = 0;
  const byShard = new Map();
  for (const w of seeded) {
    const sh = w.aliasId.slice(0, 2) + '.json';
    if (!byShard.has(sh)) byShard.set(sh, []);
    byShard.get(sh).push(w);
  }
  for (const [sh, list] of byShard) {
    const p = path.join(ROOT, 'players', 'aliases', sh);
    let m; try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
    for (const w of list) {
      if (m[w.aliasId] !== w.target) { console.log('  ⚠ ' + w.aliasId + ' changed under us — left alone'); continue; }
      delete m[w.aliasId];
      removed++;
    }
    const sorted = {};
    for (const k of Object.keys(m).sort()) sorted[k] = m[k];
    fs.writeFileSync(p, JSON.stringify(sorted), 'utf8');
  }
  console.log('  removed ' + nfmt(removed) + ' alias entrie(s) — those ids now resolve to themselves');

  // ── 5. Commit ─────────────────────────────────────────────────────────────
  for (const p of [...touched, 'players/aliases', 'reports/seeded-profiles.json']) {
    try { execSync('git add -- ' + p, _GIT); } catch (e) {}
  }
  const staged = execSync('git diff --staged --shortstat', _GIT).toString().trim();
  if (!staged) { console.log('  nothing staged'); return; }
  console.log('  staging: ' + staged);
  execSync('git commit -q -m "seed-missing-profiles: seeded ' + seeded.length + ' profiles and removed ' + removed + ' self-redirecting aliases"', _GIT);
  for (let a = 1; a <= 40; a++) {
    try { execSync('git merge --abort', _GIT); } catch (e) {}
    try {
      console.log('  … fetch/merge/push (attempt ' + a + ')');
      execSync('git fetch origin main', _GIT);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', _GIT);
      execSync('git push origin main', _GIT);
      console.log('  ✔ pushed');
      break;
    } catch (e) {
      if (a === 40) throw new Error('push failed after 40 attempts');
      const w2 = 1 + Math.floor(Math.random() * 60);
      console.log('  … push attempt ' + a + ' failed, retrying in ' + w2 + 's');
      try { execSync('sleep ' + w2, { stdio: 'pipe', timeout: (w2 + 30) * 1000 }); } catch (e2) {}
    }
  }
  console.log('');
  console.log('  NEXT, in order:');
  console.log('    1. fetch-profile-stats for the seeded shards — fills in their statistics');
  console.log('    2. build-player-games — derives games[] from the rosters');
  console.log('  Until both run, the seeded players exist but hold no games.');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
