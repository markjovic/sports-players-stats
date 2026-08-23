// scripts/probe-alias-credits.js
//
// READ-ONLY. No writes to player or game data. Writes one report. No lock.
//
// THE QUESTION. players/aliases holds 498,546 entries mapping a spectator-namespace
// id to an api profile. Every one was written by matchFromGrade or
// matchFromGradeRosterByName in lib/namespace-resolve.cjs, which decide by EXACT
// NAME — plus team id in the first, name alone within one grade in the second.
// Neither ever checked whether the profile it picked actually CREDITS the games
// that alias delivers.
//
// That is not hypothetical. On 2026-08-23:
//   900f4fe6-bec3  is in PlayHQ box scores as "Jida McCrae-Cooper" and is NOT a
//                  PlayHQ profile (the url does not load) — exactly the case
//                  aliases exist for.
//   Our alias points it at d6c25c0c-e1e4-...  — a DIFFERENT PlayHQ profile with a
//                  similar name and different statistics.
//   60eeeaa9-ab28-... is the profile that actually credits those games (310 of
//                  them), and the repair campaign appended it to 248 rosters.
// So the alias delivers ~198 appearances to the wrong player. size-report already
// listed it third in "worst alias offenders" and the reason was never established.
//
// THE TEST THIS APPLIES, which the matcher should have used in the first place:
// for each alias, take games it delivers and ask PlayHQ whether the TARGET
// profile's publicProfileStatistics credits them.
//   CREDITED      the target credits these games. The alias is supported.
//   NOT CREDITED  the target does not credit ANY of them. The alias is
//                 unsupported — those appearances are on the wrong player.
//   NO ANSWER     private profile, throttled, or no games located. No verdict.
//
// It writes reports/alias-credit-audit.json and CHANGES NOTHING. Deciding what to
// do with an unsupported alias is a separate step and a separate tool.
//
// Usage:
//   node scripts/probe-alias-credits.js --sample=200
//   node scripts/probe-alias-credits.js --all --pace=1000

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const num = (f, d) => {
  const a = args.find(x => x.startsWith('--' + f + '='));
  const v = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : d;
};
const ALL     = args.includes('--all');
const SAMPLE  = num('sample', 200);
const PACE_MS = num('pace', 0);   // legacy serial pacing; 0 = rely on concurrency
// ── CONCURRENCY, not a serial sleep ─────────────────────────────────────────
// The first version looped one call at a time with a 1s sleep, which made an
// 81,632-alias audit a 23-hour job. That pace was carried over from a probe
// against spectator.playhq.com, where 700ms hit CloudFront. THIS endpoint is
// api.playhq.com/graphql, where the documented behaviour is entirely different:
// start high, cap 1000, back off on 429. repair-players-batch runs 8 profile
// fetches concurrently as a matter of course and fetch-profile-stats runs 30.
//
// Chunked rather than a sliding window, copied from repair-players-batch: a chunk
// boundary is a natural place to back off, the in-flight count is obvious, and
// there is no queue to reason about. Backs off to 60% on transport trouble and
// recovers after two clean chunks.
const CONCURRENCY = Math.max(1, Math.min(50, num('concurrency', 8)));
const SEED    = num('seed', 20260823);
const API_URL = 'https://api.playhq.com/graphql';
const TRUNC_LEN = 13;
const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';
function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const GAMES_DIR     = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR   = path.join(ROOT, 'players');
const INDEX_DIR     = path.join(ROOT, 'players', 'indexes');
const INDEX_FILE    = path.join(ROOT, 'data', 'sports-index.json');

const CONCURRENCY_SPECTATOR = 3;       // unchanged (spectator.playhq.com)
const COMMIT_EVERY_GAMES    = Math.max(1, parseInt(process.env.SB_COMMIT_EVERY || '', 10) || 2000);    // flush + commit spc/p[] progress every N games (env override exists for crash-consistency testing only)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Identity alias for brand-new players (api-canonical, 2026-07-16) ─────────
// Every player file key must have an alias entry (trunc13(key) -> key), or the
// index gap the 3b-2 repair closed re-opens with every stub. Written at stub
// time; the matrix's recovery later REPLACES it with a redirect if the player
// turns out diverged. Format matches build-alias-index.js: sorted, minified.
// Covered by gitCommit(['players/']) — players/aliases sits under players/.
function writeAliasIdentity(uuid) {
  const bucket = uuid.slice(0, 2).toLowerCase();
  const aliasPath = path.join(ROOT, 'players', 'aliases', `${bucket}.json`);
  let map = {};
  try { map = JSON.parse(fs.readFileSync(aliasPath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const key = uuid.slice(0, TRUNC_LEN);
  if (map[key] !== undefined) return; // never clobber an existing (possibly redirect) entry
  map[key] = uuid;
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
  fs.writeFileSync(aliasPath, JSON.stringify(sorted));
}

// ─── HTTP — nightly-crawl.js, verbatim ────────────────────────────────────────

function doFetch(url, bodyObj, headers) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify(bodyObj);
    const parsed = new URL(url);
    const h      = { ...headers, 'request-id': crypto.randomUUID(),
                     'content-length': Buffer.byteLength(body) };
    const req    = https.request(
      { hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
        headers: h, agent: new https.Agent({ keepAlive: false }) },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = JSON.parse(rawText); } catch (_) { body = null; }
          resolve({
            status:     res.statusCode,
            rawCookies: res.headers['set-cookie'],
            body,
            rawText,
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Session — nightly-crawl.js, verbatim ─────────────────────────────────────

const HEADERS_MAIN = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};
const HEADERS_SPECTATOR = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'bv', 'x-phq-tenant': 'bv', 'content-type': 'application/json',
};

// ⚠ SESSION LOCK — copied VERBATIM from repair-players-batch.js.
// The first version had no lock: 8 concurrent calls each saw a missing cookie and
// each fired its own refresh. The 2026-08-23 run printed "Session refreshed" eight
// times in a row before collapsing to concurrency 1, because the refreshes were
// invalidating each other. This is exactly what the promise lock exists to prevent
// and it is documented in the project notes; I did not copy it.
let sessionCookie = null;
let sessionPromise = null;

const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};


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


// ─── Spectator query — nightly-crawl.js, verbatim ─────────────────────────────

// 2026-08-10: returns a CLASSIFIED outcome, never a bare null. Previously every
// failure mode collapsed to null, so a 403 that survived its retry, a 429, a 502
// and a dropped connection were indistinguishable from "this game genuinely has
// no box score" — and with --miss-attempts=1 one bad moment retired a game
// FOREVER. Proven by spot-check 2026-08-10: of four retired misses in seasons
// with >95% capture, THREE had full box scores on playhq.com. Contract:
//   { ok:true,  game }                    → fetched; caller decides empty vs not
//   { ok:false, permanent:true }          → 404, or a 200 whose game is null:
//                                           not on the spectator endpoint at all.
//                                           Counts toward retirement.
//   { ok:false, permanent:false }         → 403-after-retry / 429 / 5xx / GraphQL
//                                           error / network fault. TRANSPORT, not
//                                           data: must NEVER count toward
//                                           retirement, or the weekly cron will
//                                           quietly delete games from the queue
//                                           on every bad network minute.
// ── IS THIS ID AN API PROFILE? ───────────────────────────────────────────────
// The stub decision below used to be: resolveToFullUuid() returned the id
// unchanged, therefore the id is canonical, therefore create a player file for it.
// That is a lookup in players/aliases, and ABSENCE FROM A TABLE IS NOT EVIDENCE OF
// ANYTHING. Since the alias builders (build-alias-index.js, build-alias-inverse.js)
// were deleted as migration-era tools, the only thing that writes new aliases is
// fetch-profile-stats.js — so discovery routinely runs ahead of aliasing, and every
// spectator id that arrived first became a player file.
//
// Measured 2026-08-21: 2,895 pairs of same-named player files, 122,866 duplicated
// appearances. Tahlia Parker is the worked example — 378 of her 385 shared games
// carry BOTH `20b2df06-37f4` (her real api profile) and `f806d1b6-f87f` (a spectator
// id that got stubbed) in the same p[]. PlayHQ serves the first and returns
// "There was a problem getting the profile" for the second.
//
// The design was always one file per API-CANONICAL uuid, with spectator ids
// recorded on it so their appearances resolve to the right person. This restores
// that: ASK PlayHQ before manufacturing a person. One call per genuinely-new id
// (115 in the 2026-08-20 sweep), and only for ids never seen before.
const PROFILE_EXISTS_QUERY = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) { seasonStatistics { name } }
}`;

// 'api' | 'not-api' | 'unknown'. `unknown` is a TRANSPORT outcome and must never be
// treated as either answer — on unknown the id is deferred, not stubbed and not
// aliased, so a throttle can never invent or discard a player.
async function isApiProfile(uuid) {
  if (!sessionCookie) await refreshSession();
  let res;
  try {
    res = await doFetch(API_URL,
      { operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: PROFILE_EXISTS_QUERY },
      { ...HEADERS_MAIN, 'Cookie': sessionCookie });
  } catch (e) { return 'unknown'; }
  // doFetch returns `body` ALREADY PARSED (null when the response is not JSON) and
  // the unparsed text as `rawText` — read both from the right field.
  const raw = res.rawText || '';
  if (res.status === 403) {
    // A private profile EXISTS — it just withholds statistics. Treat as api, or
    // every private player would be refused a file. CloudFront blocks are HTML.
    if (/DOCTYPE|Request blocked/i.test(raw)) return 'unknown';
    return 'api';
  }
  if (res.status === 404) return 'not-api';
  if (res.status < 200 || res.status >= 300) return 'unknown';
  const j = res.body;
  if (!j) return 'unknown';
  if (j.errors && j.errors.length) {
    const m = String(j.errors[0].message || '');
    if (/NOT_FOUND|failed to find profile/i.test(m)) return 'not-api';
    return 'unknown';
  }
  return (j.data && j.data.publicProfileStatistics !== undefined) ? 'api' : 'not-api';
}

async function gqlSpectator(gameId) {
  if (!sessionCookie) await refreshSession();
  const query = `query game($id: ID!) {
    game(id: $id) {
      id status
      statistics {
        home { players { profileID name playerNumber statistics { type { value } count } } }
        away { players { profileID name playerNumber statistics { type { value } count } } }
      }
    }
  }`;
  try {
    const { status, body } = await doFetch(
      SPECTATOR_URL,
      { operationName: 'game', variables: { id: gameId }, query },
      { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
    );
    if (status === 403) {
      // Single refresh then retry — do not loop
      await refreshSession();
      const retry = await doFetch(
        SPECTATOR_URL,
        { operationName: 'game', variables: { id: gameId }, query },
        { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
      );
      if (retry.status === 404) return { ok: false, permanent: true, why: '404' };
      if (retry.status !== 200 || retry.body.errors) return { ok: false, permanent: false, why: '403-retry-' + retry.status };
      const g403 = retry.body.data?.game;
      return g403 ? { ok: true, game: g403 } : { ok: false, permanent: true, why: 'no-game' };
    }
    if (status === 404) return { ok: false, permanent: true, why: '404' };
    if (status !== 200) return { ok: false, permanent: false, why: 'http-' + status };
    if (body.errors) {
      // 2026-08-11: log WHAT the error says. The first version returned a bare
      // 'graphql-error', and a 200-game probe of re-admitted misses came back
      // 200/200 with that label — which distinguishes nothing. The message and
      // extensions.code separate a permanent NOT_FOUND (the endpoint cannot serve
      // this game id at all — retirement was CORRECT) from an auth/permission or
      // throttle error (genuinely transient). Sampled id shapes suggest the former:
      // the missed games' ids are overwhelmingly all-numeric, i.e. a legacy id
      // format, while captured games' ids are hex.
      const e0 = body.errors[0] || {};
      const code = (e0.extensions && (e0.extensions.code || e0.extensions.errorType)) || '';
      const msg  = String(e0.message || '').slice(0, 80);
      // 2026-08-20: THE PATTERN MISSED PLAYHQ'S ACTUAL WORDING AND CREATED A
      // PERMANENT LIMBO. The live message is
      //   "game could not be found or was not electronically scored"
      // with NO extensions.code at all (logged as `graphql:nocode:`). None of the
      // patterns above match "could not be found", so `permanent` came back FALSE
      // and the game was classed a TRANSPORT failure — nothing written, no spcm.
      //
      // That is the worst possible outcome, because the two paper-scored routes are
      // wired in series: spectator-backfill re-queues the game on every run for
      // ever, and discover-game-backfill selects on `spcm > 0` so it can NEVER see
      // it. On 2026-08-20 a full sweep produced 2,935 games in exactly that state
      // and the chained canonical-record run reported "Queue empty — nothing to do".
      //
      // "was not electronically scored" is a DATA FACT, not a network condition:
      // the box was kept on paper and the live-scoring service will never have it.
      // It belongs to the canonical record, and marking spcm is what hands it over.
      const perm = /NOT_FOUND|NOT FOUND|does not exist|no such|invalid.*id|BAD_USER_INPUT|could not be found|not electronically scored/i.test(code + ' ' + msg);
      return { ok: false, permanent: perm, why: 'graphql:' + (code || 'nocode') + ':' + (msg || 'nomsg') };
    }
    const g = body.data?.game;
    return g ? { ok: true, game: g } : { ok: false, permanent: true, why: 'no-game' };
  } catch (e) { return { ok: false, permanent: false, why: 'network-' + (e.code || e.message || 'err') }; }
}

// ─── Stat parsing — nightly-crawl.js, verbatim ────────────────────────────────

function spectatorStatValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const s = statistics.find(x => x.type?.value === typeValue);
  return s ? (s.count || 0) : 0;
}

function parseSpectatorPlayers(players) {
  if (!Array.isArray(players)) return [];
  return players
    .filter(p => p && p.profileID)
    .map(p => ({
      profileID: p.profileID,
      name:      p.name  || null,
      number:    p.playerNumber ?? null,
      pts:       spectatorStatValue(p.statistics, 'TOTAL_SCORE'),
      pt1:       spectatorStatValue(p.statistics, '1_POINT_SCORE'),
      pt2:       spectatorStatValue(p.statistics, '2_POINT_SCORE'),
      pt3:       spectatorStatValue(p.statistics, '3_POINT_SCORE'),
      fouls:     spectatorStatValue(p.statistics, 'TOTAL_FOULS'),
    }));
}

// ─── Concurrency pool — nightly-crawl.js, verbatim ────────────────────────────

// Which game ids does this api profile actually credit? One call, paginated by
// PlayHQ's own season blocks.
const CREDITS_QUERY = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      statistics {
        teamStatistics { gradeStatistics { gameStatistics { game { id } } } }
      }
    }
  }
}`;

async function creditedGameIds(uuid) {
  if (!sessionCookie) await refreshSession();
  let res;
  try {
    res = await doFetch(API_URL,
      { operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: CREDITS_QUERY },
      { ...HEADERS_MAIN, 'Cookie': sessionCookie });
  } catch (e) { return null; }
  if (res.status === 403 || res.status === 404) return null;
  const j = res.body;
  if (!j || j.errors) return null;
  const out = new Set();
  for (const s of (j.data?.publicProfileStatistics?.seasonStatistics || [])) {
    for (const st of (s.statistics || [])) {
      for (const ts of (st.teamStatistics || [])) {
        for (const gs of (ts.gradeStatistics || [])) {
          for (const g of (gs.gameStatistics || [])) {
            const id = g?.game?.id;
            if (id) { out.add(String(id)); out.add(String(id).slice(0, 8)); out.games = (out.games || 0) + 1; }
          }
        }
      }
    }
  }
  return out;
}

// ── WHICH PROFILE SHOULD THIS ALIAS POINT AT? ───────────────────────────────
// Finding a bad alias is half a job: 900f4fe6-bec3 is a REAL spectator id for a
// REAL person, so deleting the entry orphans their appearances. It has to be
// REPOINTED, and this works out at what.
//
// profileSearch(fullName:) returns every profile carrying that name — exactly the
// candidate set the original matcher chose from, except this time the choice is
// made on EVIDENCE: which candidate's publicProfileStatistics actually credits the
// games this alias delivers.
//
// Returns the winning uuid ONLY when exactly one candidate credits them. Two
// candidates crediting the same games, or none, returns null — never a guess, the
// same discipline as the matchers in lib/namespace-resolve.cjs.
const SEARCH_QUERY = `query ProfileSearch($fullName: String!) {
  profileSearch(fullName: $fullName) { result { id firstName lastName } }
}`;

async function findCorrectTarget(name, gids, creditCache) {
  if (!name || !gids.length) return { uuid: null, why: 'no name or no games' };
  if (!sessionCookie) await refreshSession();
  let res;
  try {
    res = await doFetch(API_URL,
      { operationName: 'ProfileSearch', variables: { fullName: name }, query: SEARCH_QUERY },
      { ...HEADERS_MAIN, 'Cookie': sessionCookie });
  } catch (e) { return { uuid: null, why: 'search failed: ' + e.message }; }
  const j = res && res.body;
  if (!j || j.errors) return { uuid: null, why: 'search error' };
  const cands = (j.data?.profileSearch?.result || []).map(r => r && r.id).filter(Boolean);
  if (!cands.length) return { uuid: null, why: 'no profile carries that name' };

  const winners = [];
  for (const c of cands) {
    let credits = creditCache.get(c);
    if (credits === undefined) {
      credits = await creditedGameIds(c);
      creditCache.set(c, credits);
    }
    if (!credits) continue;
    if (gids.some(g => credits.has(g) || credits.has(String(g).slice(0, 8)))) winners.push(c);
  }
  if (winners.length === 1) return { uuid: winners[0], why: 'sole profile crediting these games', candidates: cands.length };
  if (winners.length > 1) return { uuid: null, why: winners.length + ' profiles credit these games — ambiguous, never guess', candidates: cands.length };
  return { uuid: null, why: 'no profile among ' + cands.length + ' with this name credits these games', candidates: cands.length };
}

// ── RESUME AND INCREMENTAL WRITE ────────────────────────────────────────────
// A 54,328-profile audit will not finish inside one 350-minute job. Written the
// obvious way it would hit the ceiling at 90% and lose everything, and a second
// dispatch would start from zero. That is precisely what happened to the first
// duplicate-pair audit: an hour of calls, report written only at the end, runner
// destroyed, nothing to show.
//
// So: verdicts are cached to disk, restored at start, and BOTH files are written
// every SAVE_EVERY profiles. Writes are atomic (temp + rename) because a cache
// killed mid-write was truncated on 2026-08-22 and a corrupt cache defeats the
// whole point. A truncated cache is salvaged on load rather than discarded.
const CACHE_PATH  = path.join(ROOT, 'reports', 'alias-credit-cache.json');
const REPORT_PATH = path.join(ROOT, 'reports', 'alias-credit-audit.json');
const SAVE_EVERY  = num('save-every', 250);

function atomicWrite(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) { console.log('  ⚠ write failed for ' + path.basename(p) + ': ' + e.message); return false; }
}

function loadCache() {
  const out = new Map();
  let raw;
  try { raw = fs.readFileSync(CACHE_PATH, 'utf8'); } catch (e) { return out; }
  let j;
  try { j = JSON.parse(raw); }
  catch (parseErr) {
    // Salvage every complete entry rather than throwing away thousands because
    // the last one was cut short.
    let n2 = 0;
    for (const m of raw.matchAll(/"([0-9a-f-]{36})":\s*(\[[^\]]*\]|null)/g)) {
      try { out.set(m[1], m[2] === 'null' ? null : new Set(JSON.parse(m[2]))); n2++; } catch (e) {}
    }
    console.log('  ⚠ verdict cache was truncated — salvaged ' + n2.toLocaleString() + ' complete entries');
    return out;
  }
  for (const [k, v] of Object.entries(j.credits || {})) out.set(k, v === null ? null : new Set(v));
  return out;
}

function saveCache(cache) {
  const credits = {};
  for (const [k, v] of cache) credits[k] = v === null ? null : [...v];
  atomicWrite(CACHE_PATH, { saved: new Date().toISOString(), credits });
}

async function main() {
  console.log('probe-alias-credits [READ-ONLY] — ' + (ALL ? 'ALL aliases' : 'sample=' + SAMPLE));

  // 1. The alias table, minus self-mappings (an id pointing at its own uuid was
  //    never a name-matched decision).
  const aliasDir = path.join(ROOT, 'players', 'aliases');
  const alias = [];
  let selfMappings = 0;
  for (const f of fs.readdirSync(aliasDir)) {
    if (!f.endsWith('.json')) continue;
    let m; try { m = JSON.parse(fs.readFileSync(path.join(aliasDir, f), 'utf8')); } catch (e) { continue; }
    for (const [k, v] of Object.entries(m)) {
      if (k === String(v).slice(0, TRUNC_LEN)) { selfMappings++; continue; }
      alias.push({ id: k, target: v });
    }
  }
  console.log('  alias entries            : ' + n(alias.length + selfMappings));
  console.log('    self-mappings (skipped): ' + n(selfMappings));
  console.log('    name-matched decisions : ' + n(alias.length) + '   ← the population to audit');

  // 2. Which games does each alias id actually deliver? One pass over games/bv.
  const wanted = new Map();
  const seenName = new Map();     // alias id -> the name PlayHQ's roster gives it
  for (const a of alias) wanted.set(a.id, []);
  const gamesDir = path.join(ROOT, 'games', 'bv');
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const [gid, g] of Object.entries(sg.games || {})) {
      for (const e of (Array.isArray(g.p) ? g.p : [])) {
        const id = e && e.id;
        if (!id) continue;
        const key = wanted.has(id) ? id : String(id).slice(0, TRUNC_LEN);
        const arr = wanted.get(key);
        if (arr && arr.length < 6) arr.push(gid);
        // p[] does not store names, so the alias's own display name comes from the
        // TARGET player file — which is the name the original matcher matched on.
        if (arr && !seenName.has(key)) seenName.set(key, null);
      }
    }
  }
  let delivering = alias.filter(a => (wanted.get(a.id) || []).length);
  console.log('    of those, delivering at least one appearance: ' + n(delivering.length));
  console.log('');

  if (!ALL) {
    const rnd = mulberry32(SEED);
    const c = delivering.slice();
    for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
    delivering = c.slice(0, SAMPLE);
  }
  console.log('  auditing ' + n(delivering.length) + ' alias(es), one profile call each, ' + PACE_MS + 'ms pace');
  console.log('');

  // One call per TARGET PROFILE, not per alias — several aliases can point at the
  // same player and the answer is identical for all of them.
  const byTarget = new Map();
  for (const a of delivering) {
    if (!byTarget.has(a.target)) byTarget.set(a.target, []);
    byTarget.get(a.target).push(a);
  }
  const targets = [...byTarget.keys()];
  console.log('  distinct target profiles to ask: ' + n(targets.length) +
              '  (' + n(delivering.length) + ' aliases share them)');
  console.log('  concurrency: ' + CONCURRENCY + ' (backs off on transport trouble, recovers after two clean chunks)');
  console.log('');

  // Restore anything a previous dispatch already answered.
  const creditCache = loadCache();
  if (creditCache.size) console.log('  restored ' + n(creditCache.size) + ' cached profile verdict(s) — these are not asked again');
  let supported = 0, unsupported = 0, noAnswer = 0, done = 0, sinceSave = 0;
  const bad = [];
  let conc = CONCURRENCY, cleanStreak = 0, consecutiveFail = 0, stop = false;

  for (let cursor = 0; cursor < targets.length && !stop; ) {
    const chunk = targets.slice(cursor, cursor + conc);
    cursor += chunk.length;
    // Skip anything already cached from a previous dispatch.
    const toAsk = chunk.filter(t => !creditCache.has(t));
    const asked = await Promise.all(toAsk.map(async (t) => ({ t, credits: await creditedGameIds(t) })));
    const got = chunk.map(t => ({ t, credits: creditCache.has(t) ? creditCache.get(t) : (asked.find(x => x.t === t) || {}).credits }));

    let chunkFail = 0;
    for (const { t, credits } of got) {
      creditCache.set(t, credits === undefined ? null : credits);
      // Only count a FRESH failure against the backoff — a cached null is an old
      // answer, not the endpoint refusing us now.
      if (!credits && toAsk.includes(t)) chunkFail++;
      for (const a of byTarget.get(t)) {
        const gids = wanted.get(a.id) || [];
        if (!credits) { noAnswer++; }
        else {
          const hit = gids.filter(g => credits.has(g) || credits.has(String(g).slice(0, 8)));
          if (hit.length) supported++;
          else { unsupported++; bad.push({ ...a, gids, creditedCount: credits.games || 0 }); }
        }
        done++;
      }
    }

    // A whole chunk failing is the endpoint refusing us, not bad luck. Back off,
    // and stop entirely after three in a row rather than burning the queue while
    // LOOKING like the audit ran.
    // ⚠ TWO BUGS FIXED HERE 2026-08-23, both of which made a stuck run WORSE.
    //
    // (1) RECOVERY COULD NEVER FIRE AT CONCURRENCY 1. cleanChunks only incremented
    //     when a chunk had ZERO failures, but at concurrency 1 a single failure is
    //     a 100% failure — so it backed off, reset the counter, and never climbed
    //     back. The run crawled at one call per five seconds for 54,328 profiles.
    //     Recovery is now driven by a clean STREAK, and a chunk that mostly
    //     succeeds no longer counts as a failure at all.
    //
    // (2) THE HARD STOP WAS EXEMPT AT CONCURRENCY 1. It was guarded by
    //     `chunk.length > 1`, so once collapsed to 1 every failed chunk was
    //     exempt and the run could never stop itself — it would burn the whole
    //     job ceiling achieving nothing while LOOKING like it was working.
    const failRate = chunkFail / chunk.length;

    if (chunkFail === chunk.length) {
      consecutiveFail++;
      if (consecutiveFail >= 10) {
        console.log('\n  ✗ ten consecutive chunks failed outright — the endpoint is refusing us.');
        console.log('    Stopping cleanly rather than burning the job ceiling. Re-dispatch to continue.');
        stop = true;
      }
    } else consecutiveFail = 0;

    // Back off only on a MATERIAL failure rate. One bad call in eight is noise and
    // used to halve the concurrency.
    if (failRate > 0.5) {
      conc = Math.max(1, Math.floor(conc * 0.6));
      cleanStreak = 0;
      console.log('  … backing off to concurrency ' + conc + ' (' + chunkFail + ' of ' + chunk.length + ' failed)');
      await new Promise(r => setTimeout(r, 5000));
    } else {
      cleanStreak++;
      if (cleanStreak >= 3 && conc < CONCURRENCY) {
        conc = Math.min(CONCURRENCY, conc + Math.max(1, Math.floor(conc * 0.5)));
        cleanStreak = 0;
        console.log('  … recovering to concurrency ' + conc);
      }
    }
    // Save BOTH files periodically so a run killed at the job ceiling still
    // yields everything it did, and the next dispatch resumes from it.
    sinceSave += chunk.length;
    if (sinceSave >= SAVE_EVERY) {
      sinceSave = 0;
      saveCache(creditCache);
      atomicWrite(REPORT_PATH, { generated: new Date().toISOString(), partial: true,
        audited: done, supported, unsupported, noAnswer, unsupportedEntries: bad });
    }
    if (PACE_MS) await new Promise(r => setTimeout(r, PACE_MS));
    if (done % 500 < chunk.length) console.log('  … ' + n(done) + '/' + n(delivering.length) + '  supported ' + n(supported) + ' · UNSUPPORTED ' + n(unsupported) + ' · no answer ' + n(noAnswer) + '  (conc ' + conc + ')');
  }

  // ── RESOLVE THE CORRECT TARGET FOR EACH UNSUPPORTED ALIAS ────────────────
  // Without this the audit produces a list of problems and no way to act on them.
  if (bad.length) {
    console.log('');
    console.log('  ══ RESOLVING THE CORRECT TARGET FOR ' + n(bad.length) + ' UNSUPPORTED ALIAS(ES) ══');
    let resolved = 0, ambiguous = 0, unresolved = 0, k = 0;
    for (const b of bad) {
      // The name to search is the one on the file the alias currently points at —
      // that is the name the original matcher used to make the wrong choice.
      let nm = null;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'players', b.target.slice(0, 2), b.target + '.json'), 'utf8'));
        nm = p.name || null;
      } catch (e) {}
      const r = await findCorrectTarget(nm, b.gids, creditCache);
      b.searchedName = nm;
      b.correctTarget = r.uuid;
      b.resolution = r.why;
      if (r.uuid) resolved++; else if (String(r.why).includes('ambiguous')) ambiguous++; else unresolved++;
      if (++k % 25 === 0) console.log('  … ' + k + '/' + bad.length + '  resolved ' + resolved + ' · ambiguous ' + ambiguous + ' · unresolved ' + unresolved);
    }
    console.log('');
    console.log('    REPOINTABLE — one profile credits the games : ' + n(resolved) + '   ← actionable');
    console.log('    ambiguous — several credit them             : ' + n(ambiguous) + '   ← never guess');
    console.log('    no candidate credits them                   : ' + n(unresolved));
  }

  const judged = supported + unsupported;
  console.log('');
  console.log('  ══ DOES THE TARGET PROFILE CREDIT THE GAMES THE ALIAS DELIVERS? ═══');
  console.log('    SUPPORTED    : ' + n(supported) + '  (' + pct(supported, judged) + '% of judged)   ← the alias is backed by PlayHQ');
  console.log('    UNSUPPORTED  : ' + n(unsupported) + '  (' + pct(unsupported, judged) + '% of judged)   ← target credits NONE of them');
  console.log('    no answer    : ' + n(noAnswer) + '   ← private / throttled / no verdict');
  console.log('');
  console.log('  UNSUPPORTED does not prove the alias wrong by itself — a profile can be');
  console.log('  private, or PlayHQ can omit a season. But an alias written on a NAME MATCH');
  console.log('  whose target credits NONE of its games is the exact shape of the');
  console.log('  900f4fe6-bec3 -> d6c25c0c error, and it is the population to inspect.');
  console.log('');


  for (const b of bad.slice(0, 40)) {
    console.log('    ' + b.id + ' -> ' + b.target + '   target credits ' + n(b.creditedCount) + ' games, NONE of these:');
    console.log('        ' + b.gids.join(' '));
    if (b.correctTarget) console.log('        SHOULD POINT AT: ' + b.correctTarget + '  (' + b.resolution + ')');
    else if (b.resolution) console.log('        no repoint: ' + b.resolution);
  }
  if (bad.length > 40) console.log('    … and ' + n(bad.length - 40) + ' more');

  saveCache(creditCache);
  const complete = done >= delivering.length;
  atomicWrite(REPORT_PATH, { generated: new Date().toISOString(), partial: !complete,
    audited: done, ofTotal: delivering.length, supported, unsupported, noAnswer,
    unsupportedEntries: bad });
  console.log('');
  console.log('  WRITTEN: reports/alias-credit-audit.json' + (complete ? '' : '  ⚠ PARTIAL — re-dispatch to continue'));
  console.log('  WRITTEN: reports/alias-credit-cache.json (' + n(creditCache.size) + ' verdicts; the next run skips these)');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
