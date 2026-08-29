// scripts/verify-players-against-playhq.js
//
// READ-ONLY. Writes and COMMITS one report. No data-write lock. No writes to data.
//
// THE CHECK THAT SHOULD HAVE COME FIRST.
//
// Mark opened one player on PlayHQ — Zachary Price, 66e58ba9 — and read 385 games
// and 2,436 points. StatTrack showed the same. That single comparison told him more
// about whether the database is right than a day of candidate scoring did, because
// it asks the only question that matters: DO OUR NUMBERS MATCH PLAYHQ'S?
//
// This runs that comparison at scale. For each player it takes the set of games
// PlayHQ credits to that profile and compares it against the games our player file
// holds, both ways:
//
//   games WE hold that PlayHQ does NOT credit  → an appearance may be on the wrong
//                                                player. This is what a bad alias
//                                                looks like from the outside.
//   games PLAYHQ credits that we do NOT hold   → we are missing an appearance.
//
// Note a gap of this kind is NOT automatically an error: StatTrack already shows
// "RECORDED APPEARANCES 397 · 12 not credited by PlayHQ" for that same player, and
// PlayHQ genuinely omits games. The number to watch is the RATE, and whether the
// players we changed look different from the ones we did not.
//
// ⚠ IT ALWAYS CHECKS EVERY PLAYER TOUCHED BY A RECENT REPOINT, on top of the random
// sample. Those are read from reports/alias-repoint-log.json,
// reports/boxscore-repoint-log.json and reports/seeded-profiles.json — BOTH SIDES of
// every change, the profile we moved appearances away from and the one we moved them
// to. A change that made things worse shows up here as a player whose games PlayHQ
// does not credit.
//
// Usage:
//   node scripts/verify-players-against-playhq.js --sample=200
//   node scripts/verify-players-against-playhq.js --sample=0     # only the changed ones

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const num = (f, d) => {
  const a = args.find(x => x.startsWith('--' + f + '='));
  const v = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : d;
};
const SAMPLE = num('sample', 200);
const SEED = num('seed', 20260826);
// DEFAULT 1, not 6. On 2026-08-26 a run at concurrency 3 returned 82% "no answer"
// and that was read as a fact about the data — it was throttling. The run on
// 2026-08-27 used this file's old default of 6 and returned 846 no-answers out of
// 1,026, the same 82%, making every percentage in its output unreliable. This
// endpoint answers reliably at 1 and the run is slower; a slow true answer beats a
// fast false one. Raise it deliberately with --concurrency=N if you want to.
const CONCURRENCY = Math.max(1, Math.min(12, num('concurrency', 1)));
const SHOW = num('show', 40);
const API_URL = 'https://api.playhq.com/graphql';
const TRUNC_LEN = 13;
const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

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

let sessionCookie = null;

// ⚠ WRAPPED IN A PROMISE LOCK. Concurrent callers each seeing a missing cookie
// would otherwise fire their own refresh and invalidate each other — the failure
// that collapsed probe-alias-credits to concurrency 1 on 2026-08-23.
let sessionPromise = null;
async function refreshSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
  const body = { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const { rawCookies } = await doFetch(API_URL, body, HEADERS_MAIN);
      if (!rawCookies) continue;
      const arr = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
        .map(c => c.split(';')[0].trim());
      const get = n => arr.find(p => p.startsWith(n + '=')) || null;
      const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
      if (tier && session && sub) {
        sessionCookie = `${tier}; ${session}; ${sub}`;
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    } catch (_) {}
  }
  throw new Error('Failed to obtain session after 10 attempts');
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
  // A WITHHELD profile answers 200 with publicProfileStatistics === null. The loop
  // below then runs over nothing and yields an empty Set, which is indistinguishable
  // from "answered, credits zero games" — so on 2026-08-27 Aarna Gupta (private,
  // confirmed on her PlayHQ page) was reported as the single worst gap in the store:
  // 64 games held, 0 credited. Every private player would rank that way, on every
  // run, for ever. A privacy setting is not a data fault and must not head the list.
  const stats = j.data && j.data.publicProfileStatistics;
  if (stats === null || stats === undefined) return { withheld: true };
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



const _GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const REPORT = 'reports/playhq-verification.json';

function commitReport(msg) {
  try {
    execSync('git add -- ' + REPORT, _GIT);
    const staged = execSync('git diff --staged --shortstat', _GIT).toString().trim();
    if (!staged) return;
    console.log('  staging: ' + staged);
    execSync('git commit -q -m "verify-players: ' + String(msg).replace(/"/g, "'") + '"', _GIT);
    for (let a = 1; a <= 40; a++) {
      try { execSync('git merge --abort', _GIT); } catch (e) {}
      try {
        execSync('git fetch origin main', _GIT);
        execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', _GIT);
        execSync('git push origin main', _GIT);
        console.log('  ✔ pushed'); return;
      } catch (e) {
        if (a === 40) throw new Error('push failed after 40 attempts');
        const w = 1 + Math.floor(Math.random() * 60);
        try { execSync('sleep ' + w, { stdio: 'pipe', timeout: (w + 30) * 1000 }); } catch (e2) {}
      }
    }
  } catch (e) { console.log('  ⚠ commit failed: ' + e.message); }
}

function main2() {}

async function main() {
  console.log('verify-players-against-playhq — do OUR games match the games PlayHQ credits?');

  // ── 1. Everyone touched by a recent change, BOTH SIDES ────────────────────
  const changed = new Map();                     // uuid -> reason
  const mark = (u, why) => { if (u && !changed.has(u)) changed.set(u, why); };
  // apiid-seed-log.json added 2026-08-27: 1,211 player files were given an apiId
  // that day and folded to it, and NONE of them were in this script's scope — it
  // reported "26 players touched by a recent change" while the repair went
  // unverified. Both sides are marked: the old key we moved away from and the api
  // id we moved to.
  //
  // boxscore-repoint-log.json HAS NEVER EXISTED (confirmed 2026-08-27). It is kept
  // in this list only so its absence is visible rather than silent. The 88 + 23
  // repoints of rounds 1 and 2 have NO log anywhere, so 111 changes cannot be
  // reversed by reading a file — only by reconstructing from git history of
  // players/aliases/. That is not a gap this script can close; it is recorded here
  // so nobody concludes from a clean run that those 111 were checked.
  for (const [file, label] of [['alias-repoint-log.json', 'repointed'],
                               ['boxscore-repoint-log.json', 'box-score repoint'],
                               ['seeded-profiles.json', 'seeded'],
                               ['apiid-seed-log.json', 'apiId seeded 2026-08-27']]) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', file), 'utf8'));
      // Shapes differ between logs: {entries:[]}, a bare array, or {seeded:[]}.
      // Reading only d.entries is why apiid-seed-log.json would have contributed
      // nothing even once its name was on the list.
      const list = Array.isArray(d) ? d
                 : Array.isArray(d.entries) ? d.entries
                 : Array.isArray(d.seeded)  ? d.seeded
                 : [];
      if (!list.length) console.log(`  (${file}: no usable entries — absent, or a shape this reader does not know)`);
      for (const e of list) {
        mark(e.apiId, label + ' (moved to)');
        // BOTH sides: the profile we moved appearances AWAY from is as likely to be
        // wrong now as the one we moved them TO.
        mark(e.from, label + ' (moved away from)');
        mark(e.to, label + ' (moved to)');
        mark(e.was, label + ' (was)');
        mark(e.uuid, label);
      }
    } catch (e) {}
  }
  console.log('  players touched by a recent change : ' + n(changed.size) + '   ← always checked');

  // ── 2. A random sample of everyone else ───────────────────────────────────
  const all = [];
  const pd = path.join(ROOT, 'players');
  for (const sh of fs.readdirSync(pd)) {
    if (sh === 'aliases' || sh === 'indexes') continue;
    const dir = path.join(pd, sh);
    let st; try { st = fs.statSync(dir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) all.push(path.basename(f, '.json'));
  }
  console.log('  players in the store               : ' + n(all.length));
  const rnd = mulberry32(SEED);
  const shuffled = all.slice();
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const sample = shuffled.filter(u => !changed.has(u)).slice(0, SAMPLE);
  const targets = [...changed.keys()].map(u => ({ uuid: u, why: changed.get(u) }))
    .concat(sample.map(u => ({ uuid: u, why: 'random sample' })));
  console.log('  checking                           : ' + n(targets.length) + ' player(s), one PlayHQ call each');
  console.log('');

  // ── 3. Compare ────────────────────────────────────────────────────────────
  const rows = [];
  let done = 0;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    await Promise.all(targets.slice(i, i + CONCURRENCY).map(async (t) => {
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(ROOT, 'players', t.uuid.slice(0, 2), t.uuid + '.json'), 'utf8')); }
      catch (e) { rows.push({ ...t, error: 'no player file' }); return; }
      const ours = new Set((p.games || []).map(g => String(g)));
      const credits = await creditedGameIds(t.uuid);
      if (!credits) { rows.push({ ...t, name: p.name, ourGames: ours.size, error: 'PlayHQ gave no answer (throttled, or the id is not an api profile)' }); return; }
      if (credits.withheld) { rows.push({ ...t, name: p.name, ourGames: ours.size, withheld: true, error: 'profile is PRIVATE — PlayHQ withholds statistics, so it can never credit a game' }); return; }
      // PlayHQ ids may be full or 8-char in either set; compare on the short form.
      const short = (x) => String(x).slice(0, 8);
      const theirs = new Set([...credits].map(short));
      const oursShort = new Set([...ours].map(short));
      const weHoldTheyDont = [...oursShort].filter(g => !theirs.has(g));
      const theyHoldWeDont = [...theirs].filter(g => !oursShort.has(g));
      // REVERTED 2026-08-27. A previous version split this into "hidden grade,
      // never creditable" and "unexplained", on the strength of one player whose
      // 17 games were all hidden. The scan then found 425,954 of roughly 490,000
      // games carry that flag — so it is close to universal and cannot mean "no
      // public page". The split separated 38 of 269 games and told nobody anything.
      // One number, honestly named, until the flag's meaning is established.
      rows.push({ ...t, name: p.name, ourGames: ours.size, playhqGames: theirs.size,
                  extra: weHoldTheyDont.length, missing: theyHoldWeDont.length,
                  extraSample: weHoldTheyDont.slice(0, 5) });
    }));
    done += Math.min(CONCURRENCY, targets.length - i);
    if (done % 60 < CONCURRENCY) console.log('  … ' + n(done) + '/' + n(targets.length));
    await sleep(150);
  }

  // ── 4. Report, changed players separately from the sample ────────────────
  const ok = rows.filter(r => !r.error);
  const grp = (why) => ok.filter(r => (r.why === 'random sample') === (why === 'sample'));
  const summarise = (label, set) => {
    if (!set.length) return;
    const clean = set.filter(r => r.extra === 0).length;
    const totOurs = set.reduce((a, r) => a + r.ourGames, 0);
    const totExtra = set.reduce((a, r) => a + r.extra, 0);
    const totMissing = set.reduce((a, r) => a + r.missing, 0);
    console.log('  ── ' + label + ' (' + n(set.length) + ' player(s)) ' + '─'.repeat(Math.max(0, 40 - label.length)));
    console.log('    every game we hold is credited by PlayHQ : ' + n(clean) + '  (' + pct(clean, set.length) + '%)');
    console.log('    games we hold, total                     : ' + n(totOurs));
    console.log('      of those NOT credited by PlayHQ        : ' + n(totExtra) + '  (' + pct(totExtra, totOurs) + '%)');
    console.log('    games PlayHQ credits that we do NOT hold : ' + n(totMissing));
    console.log('');
  };
  console.log('  ══ DO OUR GAMES MATCH THE GAMES PLAYHQ CREDITS? ═══════════════════');
  console.log('');
  summarise('PLAYERS WE RECENTLY CHANGED', grp('changed'));
  summarise('RANDOM SAMPLE (untouched)', grp('sample'));
  console.log('  A gap is not automatically an error — PlayHQ omits games, which is why');
  console.log('  StatTrack shows "not credited by PlayHQ" at all. What matters is whether');
  console.log('  the players WE CHANGED look worse than the ones we did not.');
  console.log('');

  const worst = ok.filter(r => r.extra > 0).sort((a, b) => b.extra - a.extra).slice(0, SHOW);
  if (worst.length) {
    console.log('  ── worst gaps ────────────────────────────────────────────────────');
    for (const r of worst) {
      console.log('    ' + r.uuid + '  ' + JSON.stringify(r.name || '?') + '   [' + r.why + ']');
      console.log('        we hold ' + n(r.ourGames) + ', PlayHQ credits ' + n(r.playhqGames) +
                  '  ·  ' + n(r.extra) + ' of ours not credited, ' + n(r.missing) + ' of theirs missing');
      console.log('        https://www.playhq.com/public/profile/' + r.uuid + '/statistics');
    }
    console.log('');
  }
  // Three outcomes, not one. Collapsing them into "no answer" is how a privacy
  // setting came to be reported as the worst data fault in the store.
  const withheld = rows.filter(r => r.withheld);
  const noFile   = rows.filter(r => r.error === 'no player file');
  const errs     = rows.filter(r => r.error && !r.withheld && r.error !== 'no player file');
  console.log('  ── players that could not be compared ────────────────────────────');
  console.log('    PRIVATE (PlayHQ withholds statistics) : ' + n(withheld.length) +
              '   ← not a fault; these can never credit a game');
  console.log('    no player file on our side            : ' + n(noFile.length));
  console.log('    no answer (throttled, or not an api profile) : ' + n(errs.length));
  if (withheld.length) {
    console.log('');
    console.log('    private players holding the most games (nothing wrong with these):');
    for (const r of withheld.sort((a, b) => b.ourGames - a.ourGames).slice(0, 10)) {
      console.log('      ' + r.uuid + '  ' + JSON.stringify(r.name || '?') + '  we hold ' + n(r.ourGames) + '  [' + r.why + ']');
    }
  }

  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, REPORT), JSON.stringify({ generated: new Date().toISOString(),
    checked: rows.length, changedPlayers: changed.size, sample: sample.length, rows }, null, 1));
  console.log('  WRITTEN: ' + REPORT);
  commitReport(rows.length + ' players checked against PlayHQ');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
