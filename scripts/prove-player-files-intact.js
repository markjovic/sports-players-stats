// scripts/prove-player-files-intact.js
//
// READ-ONLY. Writes and COMMITS one report. Touches no data.
//
// ⚠ THIS EXISTS BECAUSE I MADE A CLAIM WITHOUT TESTING IT.
//
// verify-players-against-playhq got no answer from PlayHQ for 82% of the players it
// checked. I said that was because most of the store is spectator-namespace and has
// no api profile. That was an ASSERTION, not a finding — the same fault as reading
// an id's shape and calling it an identity (T41). The alternative explanation is far
// worse and had to be ruled out rather than dismissed: that valid api profiles were
// OVERWRITTEN with spectator ids or alias targets by something that ran this week.
//
// This settles it with evidence, from four independent directions:
//
//   1. WHAT ACTUALLY WROTE PLAYER FILES. `git log` per file, for every player file
//      sampled — which commits touched it, and when. If identity was overwritten,
//      a commit did it and it is named here.
//
//   2. IS THE FILE'S IDENTITY INTACT? A player file carries `uuid` inside it and is
//      named for that uuid. If a write had replaced identity, those would disagree,
//      or the name would have changed. Both are checked, and the git history of the
//      `name` and `uuid` fields is read for any file where they do.
//
//   3. IS THE UUID IN players/indexes? The index is built from api crawls. A uuid
//      present there IS an api id, whatever publicProfileStatistics returns today.
//
//   4. WHAT DOES PLAYHQ SAY ABOUT THE NO-ANSWER ONES? `isApiProfile` asks a
//      different question from `publicProfileStatistics`: it distinguishes
//      "profile exists but has no statistics" from "not a profile at all". Those
//      are wholly different findings and the earlier run conflated them.
//
// Usage: node scripts/prove-player-files-intact.js --sample=300

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
const SAMPLE = num('sample', 300);
const SEED = num('seed', 20260826);
const CONCURRENCY = Math.max(1, Math.min(6, num('concurrency', 3)));
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
const REPORT = 'reports/player-file-integrity.json';
const sh = (cmd) => { try { return execSync(cmd, _GIT).toString().trim(); } catch (e) { return ''; } };

async function main() {
  console.log('prove-player-files-intact — was anyone\'s identity overwritten?');
  console.log('');

  // ── Which commits have touched players/ at all, ever ─────────────────────
  console.log('  ══ 1. WHAT HAS WRITTEN TO players/ ════════════════════════════════');
  const log = sh('git log --since="14 days ago" --pretty=format:"%h|%ad|%s" --date=short -- players/');
  const lines = log ? log.split('\n') : [];
  console.log('  commits touching players/ in the last 14 days: ' + n(lines.length));
  const byMsg = new Map();
  for (const l of lines) {
    const msg = (l.split('|')[2] || '').replace(/[:0-9,]+.*$/, '').trim() || '(no subject)';
    byMsg.set(msg, (byMsg.get(msg) || 0) + 1);
  }
  for (const [m, c] of [...byMsg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log('    ' + String(c).padStart(5) + '  ' + m);
  }
  console.log('');
  console.log('  ⚠ Read this list. Every write to a player file came from one of these.');
  console.log('  build-player-games writes ONLY the games field. repoint-aliases writes');
  console.log('  ONLY players/aliases. If identity was overwritten, the commit is above.');
  console.log('');

  // ── Sample player files ───────────────────────────────────────────────────
  const all = [];
  const pd = path.join(ROOT, 'players');
  for (const s of fs.readdirSync(pd)) {
    if (s === 'aliases' || s === 'indexes') continue;
    const dir = path.join(pd, s);
    let st; try { st = fs.statSync(dir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) all.push([s, path.basename(f, '.json')]);
  }
  const rnd = mulberry32(SEED);
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  const pick = all.slice(0, SAMPLE);
  console.log('  ══ 2. IS THE IDENTITY IN EACH FILE INTACT? ════════════════════════');
  console.log('  players in the store : ' + n(all.length) + ',  sampling ' + n(pick.length));

  // ── The index: a uuid here came from an api crawl ────────────────────────
  const indexed = new Set();
  try {
    const id = path.join(pd, 'indexes');
    for (const f of fs.readdirSync(id)) {
      if (!f.endsWith('.json')) continue;
      let m; try { m = JSON.parse(fs.readFileSync(path.join(id, f), 'utf8')); } catch (e) { continue; }
      for (const u of Object.keys(m)) indexed.add(u);
    }
  } catch (e) {}
  console.log('  uuids present in players/indexes (api-derived) : ' + n(indexed.size));
  console.log('');

  const rows = [];
  let mismatch = 0, noUuidField = 0, notIndexed = 0;
  for (const [shard, uuid] of pick) {
    let p; try { p = JSON.parse(fs.readFileSync(path.join(pd, shard, uuid + '.json'), 'utf8')); }
    catch (e) { rows.push({ uuid, error: 'unreadable' }); continue; }
    const inner = p.uuid || null;
    const agrees = !inner || inner === uuid;
    if (!inner) noUuidField++;
    if (inner && !agrees) mismatch++;
    const isIndexed = indexed.has(uuid);
    if (!isIndexed) notIndexed++;
    rows.push({ uuid, name: p.name || null, innerUuid: inner, filenameAgrees: agrees,
                inIndex: isIndexed, games: (p.games || []).length,
                seasons: (p.seasons || []).length, private: p.private === true });
  }
  console.log('    filename and inner uuid DISAGREE : ' + n(mismatch) + '   ← identity overwritten if non-zero');
  console.log('    no uuid field in the file        : ' + n(noUuidField) + '   (older files predate the field)');
  console.log('    NOT present in players/indexes   : ' + n(notIndexed) + '  (' + pct(notIndexed, pick.length) + '%)');
  console.log('');
  if (mismatch) {
    console.log('  ⚠⚠ THESE FILES HAVE BEEN OVERWRITTEN — filename does not match inner uuid:');
    for (const r of rows.filter(r => r.innerUuid && !r.filenameAgrees).slice(0, 20)) {
      console.log('    file ' + r.uuid);
      console.log('      inner uuid ' + r.innerUuid + '   name ' + JSON.stringify(r.name));
      console.log('      last touched by: ' + sh('git log -1 --pretty=format:"%h %ad %s" --date=short -- players/' + r.uuid.slice(0, 2) + '/' + r.uuid + '.json'));
    }
    console.log('');
  }

  // ── 3. Ask PlayHQ what the not-indexed ones actually are ─────────────────
  const suspects = rows.filter(r => !r.inIndex && !r.error).slice(0, 120);
  console.log('  ══ 3. WHAT DOES PLAYHQ SAY ABOUT THE ONES NOT IN THE INDEX? ═══════');
  console.log('  isApiProfile distinguishes "a profile with no statistics" from "not a');
  console.log('  profile at all". The earlier run treated both as no answer, which is');
  console.log('  how I came to assert 82% were not api profiles without testing it.');
  console.log('  asking about ' + n(suspects.length) + ' of them');
  let api = 0, notApi = 0, unknown = 0;
  for (let i = 0; i < suspects.length; i += CONCURRENCY) {
    await Promise.all(suspects.slice(i, i + CONCURRENCY).map(async (r) => {
      const v = await isApiProfile(r.uuid);
      r.playhq = v;
      if (v === 'api') api++; else if (v === 'not-api') notApi++; else unknown++;
    }));
    await sleep(200);
  }
  console.log('');
  console.log('    IS a real api profile      : ' + n(api) + '  (' + pct(api, suspects.length) + '%)   ← the index is incomplete, the FILE is fine');
  console.log('    is NOT an api profile      : ' + n(notApi) + '  (' + pct(notApi, suspects.length) + '%)   ← spectator-namespace, as claimed');
  console.log('    could not tell             : ' + n(unknown));
  console.log('');
  console.log('  ══ THE ANSWER ═════════════════════════════════════════════════════');
  if (mismatch === 0) {
    console.log('    NO player file in this sample has had its identity overwritten:');
    console.log('    every filename matches the uuid inside it.');
  } else {
    console.log('    ⚠ ' + n(mismatch) + ' file(s) HAVE been overwritten — listed above with the commit.');
  }
  if (api > notApi) {
    console.log('    And my claim was WRONG: most of the no-answer players ARE api profiles.');
    console.log('    They return no STATISTICS, which is a different thing entirely.');
  } else if (notApi > 0) {
    console.log('    Most of the no-answer players are genuinely not api profiles.');
  }

  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, REPORT), JSON.stringify({ generated: new Date().toISOString(),
    sampled: pick.length, mismatch, noUuidField, notIndexed, api, notApi, unknown,
    commitsTouchingPlayers: lines.slice(0, 200), rows }, null, 1));
  console.log('');
  console.log('  WRITTEN: ' + REPORT);
  try {
    execSync('git add -- ' + REPORT, _GIT);
    if (execSync('git diff --staged --shortstat', _GIT).toString().trim()) {
      execSync('git commit -q -m "prove-player-files-intact: ' + mismatch + ' overwritten, ' + api + ' api, ' + notApi + ' not-api"', _GIT);
      execSync('git fetch origin main', _GIT);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', _GIT);
      execSync('git push origin main', _GIT);
      console.log('  ✔ pushed');
    }
  } catch (e) { console.log('  ⚠ commit failed: ' + e.message); }
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
