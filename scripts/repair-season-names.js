// scripts/repair-season-names.js
//
// Repairs player files whose top-level `name` is one of their own seasons[].sn
// (the parseProfileStats seasonStatistics[0].name bug). Quantum defined by
// scan-season-name-contamination.js: 40,034 files, all spectator-keyed
// (hasApiId:false), every one with a non-empty games[].
//
// The real name lives NOWHERE on disk (game files omit `n`, the api profile
// query has no player-name field). The only source is a live spectator
// game(id) fetch, which returns statistics.home/away.players[].{profileID,name}
// -- exactly what nightly-crawl.js Phase 3 uses. So this re-fetches the
// spectator rosters and reads the real name from there.
//
// ALL spectator/session primitives below (doFetch, HEADERS_*, refreshSession,
// gqlSpectator, parseSpectatorPlayers, gitCommit, runPool, the player IO
// helpers) are COPIED VERBATIM from scripts/nightly-crawl.js -- not rewritten.
//
// Efficiency: contaminated teammates share games, so each unique game(id) is
// fetched once and its whole roster cached (profileID -> name); many players
// resolve from one fetch.
//
// Match: a player file is keyed by its FULL spectator id (hasApiId:false), and
// the spectator roster returns FULL profileID, so match is roster.profileID ===
// player uuid.
//
// Fallback: a player whose every game is unreachable (blocked/private/deleted)
// gets the `Player #<prefix>` placeholder -- so NO season string survives,
// recoverable or not.
//
// Resume-safe: a progress file records done uuids and is committed WITH the
// player writes at every checkpoint (in-memory progress is lost on timeout).
//
// Usage:
//   node scripts/repair-season-names.js            # full repair
//   node scripts/repair-season-names.js --dry-run  # scan + resolve, no writes/commits
//   node scripts/repair-season-names.js --max=500  # cap players processed (testing)

'use strict';

const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const { TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const INDEX_DIR   = path.join(ROOT, 'players', 'indexes');
const PROGRESS    = path.join(ROOT, 'reports', 'season-name-repair-progress.json');

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const DRY_RUN = !!ARGS['dry-run'];
const MAX     = ARGS.max ? parseInt(ARGS.max, 10) : Infinity;

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';

const CONCURRENCY_SPECTATOR = 3;    // verbatim from nightly-crawl.js
const COMMIT_EVERY          = 200;  // commit players + progress every N resolved
const MAX_DEFER             = 4;    // unreachable passes before accepting a placeholder, so a
                                    // genuinely dead profile+games converges instead of looping
const PUBLIC_PROFILE_QUERY  =
  'query publicProfile($profileID: ID!) { publicProfile(profileID: $profileID) { id firstName lastName __typename } }';

const HEX = '0123456789abcdef';
const ALL_BUCKETS = [];
for (const a of HEX) for (const b of HEX) ALL_BUCKETS.push(a + b);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log(`[repair] ${new Date().toISOString()} ${msg}`); }

// normName — verbatim from lib/namespace-resolve.cjs (v2, 2026-08-02)
function normName(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")   // curly/low/prime apostrophes -> '
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')          // curly double quotes -> "
    .replace(/[\u2010-\u2015\u2212]/g, '-')                     // hyphen family + minus -> -
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')           // strip combining accents
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
// isPlaceholderName — verbatim from lib/namespace-resolve.cjs
function isPlaceholderName(name) {
  return !name || /^player\s*#/i.test(String(name).trim());
}
function placeholderFor(uuid) { return `Player #${uuid.slice(0, TRUNC_LEN)}`; }

// ─── HTTP — verbatim from nightly-crawl.js ──────────────────────────────────────
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
          let parsedBody = null;
          try { parsedBody = JSON.parse(rawText); } catch (_) { parsedBody = null; }
          resolve({ status: res.statusCode, rawCookies: res.headers['set-cookie'], body: parsedBody, rawText });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Session + headers — verbatim from nightly-crawl.js ─────────────────────────
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

let sessionCookie  = null;
let sessionPromise = null;   // promise-lock: concurrent workers wait on one in-flight refresh

// Promise-locked refresh (the documented pattern, as in fetch-profile-stats.js).
// Without this, the 3 spectator workers each fire their own refresh on a 403 and
// stampede — the storm of "Session refreshed" lines the first dry-run showed.
async function refreshSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const body = { operationName: 'TenantConfig', variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }' };
    try {
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
    } finally {
      sessionPromise = null;
    }
  })();
  return sessionPromise;
}

// ─── Spectator game fetch — verbatim from nightly-crawl.js ───────────────────────
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
      await refreshSession();
      const retry = await doFetch(
        SPECTATOR_URL,
        { operationName: 'game', variables: { id: gameId }, query },
        { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
      );
      if (retry.status !== 200 || retry.body.errors) return null;
      return retry.body.data?.game || null;
    }
    if (status !== 200 || body.errors) return null;
    return body.data?.game || null;
  } catch (_) { return null; }
}

// parseSpectatorPlayers — verbatim shape from nightly-crawl.js (name is what we need)
function parseSpectatorPlayers(players) {
  if (!Array.isArray(players)) return [];
  return players
    .filter(p => p && p.profileID)
    .map(p => ({ profileID: p.profileID, name: p.name || null }));
}

// Direct id -> name via publicProfile (api.playhq.com, ACCOUNT tenant).
// Primary path: one call per player, returns the real name regardless of whether
// they ever recorded stats -- so it also covers players the game-roster scan can't
// (no stat line -> absent from every statistics roster). tenant MUST be 'account'
// (cross-sport identity): publicProfileStatistics under the basketball tenant
// NOT_FOUNDs spectator-keyed ids, but publicProfile under 'account' resolves them.
// Request shape copied from a live capture. Returns { name, reached }; reached=false
// is a transient failure (403-after-refresh / error) the caller DEFERS, never freezes.
async function gqlPublicProfile(profileID) {
  if (!sessionCookie) await refreshSession();
  const headers = () => ({ ...HEADERS_MAIN, 'tenant': 'account', 'Cookie': sessionCookie });
  const body = { operationName: 'publicProfile', variables: { profileID }, query: PUBLIC_PROFILE_QUERY };
  const readName = res => {
    if (!res || res.status !== 200 || !res.body || res.body.errors) return undefined; // not a clean answer
    const pr = res.body.data && res.body.data.publicProfile;
    if (!pr) return null;                                    // reached, but no such public profile
    const nm = `${pr.firstName || ''} ${pr.lastName || ''}`.trim();
    return nm || null;                                       // reached; real name, or reached-but-empty
  };
  try {
    let res = await doFetch(API_URL, body, headers());
    if (res.status === 403) { await refreshSession(); res = await doFetch(API_URL, body, headers()); }
    const val = readName(res);
    return (val === undefined) ? { name: null, reached: false } : { name: val, reached: true };
  } catch (_) { return { name: null, reached: false }; }
}

// ─── Concurrency pool — verbatim from nightly-crawl.js ──────────────────────────
async function runPool(tasks, concurrency) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) { await tasks[i++](); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// ─── git commit — 60-attempt / 1–91s jitter (project heavy-contention pattern) ──
async function gitCommit(message, dirs) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  const paths = (dirs && dirs.length ? dirs : ['.']).join(' ');
  try { execSync(`git add -- ${paths}`, { stdio: 'pipe', cwd: ROOT }); } catch (_) {}
  let staged = '';
  try { staged = execSync('git diff --staged --shortstat', { stdio: 'pipe', cwd: ROOT }).toString().trim(); } catch (_) {}
  if (!staged) return;
  try { execSync(`git commit -q -m "${message.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT }); }
  catch (_) { return; }
  const MAX_ATTEMPTS = 60;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      try { execSync('git merge --abort', { stdio: 'pipe', cwd: ROOT }); } catch (_) {}
      execSync('git fetch origin main',                            { stdio: 'pipe', cwd: ROOT });
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main',                             { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✓ Committed: ${message}`);
      return;
    } catch (_) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`Push failed after ${MAX_ATTEMPTS} attempts`);
      await sleep(1000 + Math.floor(Math.random() * 91000));
    }
  }
}

// ─── Player IO — verbatim from nightly-crawl.js ─────────────────────────────────
function playerShard(uuid)    { return uuid.slice(0, 2).toLowerCase(); }
function playerFilePath(uuid) { return path.join(PLAYERS_DIR, playerShard(uuid), `${uuid}.json`); }
function playerIndexPath(s)   { return path.join(INDEX_DIR, `${s}.json`); }
function readPlayer(uuid) {
  const file = playerFilePath(uuid);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function writePlayer(uuid, data) {
  if (DRY_RUN) return;
  const file = playerFilePath(uuid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}
function readPlayerIndex(shard) {
  const file = playerIndexPath(shard);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}
function writePlayerIndex(shard, data) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(playerIndexPath(shard)), { recursive: true });
  fs.writeFileSync(playerIndexPath(shard), JSON.stringify(data));
}

// ─── Detect the contaminated set (current on-disk state, not the scan file) ─────
function findContaminated() {
  const out = []; // { uuid, games:[...], seasonNorms:Set }
  let scanned = 0;
  for (const bucket of ALL_BUCKETS) {
    const dir = path.join(PLAYERS_DIR, bucket);
    if (!fs.existsSync(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      scanned++;
      const name = p.name;
      if (isPlaceholderName(name)) continue;
      const normedName = normName(name);
      if (!normedName) continue;
      const seasonNorms = new Set((p.seasons || []).map(s => normName(s.sn)).filter(Boolean));
      if (!seasonNorms.has(normedName)) continue;
      out.push({
        uuid: f.slice(0, -5),
        games: Array.isArray(p.games) ? p.games.slice() : [],
        seasonNorms,
      });
    }
    if (scanned % 50000 === 0) log(`detect: scanned ${scanned}, contaminated ${out.length}`);
  }
  return out;
}

// game(id) roster cache: gameId -> Map<profileID,name> | null (unreachable).
// A reachable game with an empty/na roster still returns a Map (possibly with
// entries whose name was null) so callers can tell "couldn't fetch" from
// "fetched but this player isn't here / has no name".
const gameRosterCache = new Map();
async function rosterForGame(gameId) {
  if (gameRosterCache.has(gameId)) return gameRosterCache.get(gameId);
  const game = await gqlSpectator(gameId);
  let map = null;
  if (game && game.statistics) {
    map = new Map();
    for (const side of ['home', 'away']) {
      // Store EVERY roster profileID, mapping to its name (possibly null) so we
      // can distinguish "player not in this game" from "in game but nameless".
      for (const pl of parseSpectatorPlayers(game.statistics?.[side]?.players)) {
        if (pl.profileID) map.set(pl.profileID, pl.name || null);
      }
    }
  }
  gameRosterCache.set(gameId, map);
  return map;
}

async function main() {
  console.log(`\nrepair-season-names  dry_run=${DRY_RUN}  max=${MAX === Infinity ? 'all' : MAX}`);
  console.log('─'.repeat(60));

  // Resume state
  let done = new Set();
  let attempts = new Map();   // uuid -> unreachable-pass count (persisted; drives MAX_DEFER convergence)
  try {
    const prog = JSON.parse(fs.readFileSync(PROGRESS, 'utf8'));
    done = new Set(prog.done || []);
    for (const [k, v] of Object.entries(prog.attempts || {})) attempts.set(k, v);
  } catch (_) {}
  if (done.size || attempts.size) log(`resuming: ${done.size} processed, ${attempts.size} deferred`);

  log('detecting contaminated player files…');
  const all = findContaminated();
  log(`contaminated on disk: ${all.length}`);

  const todo = all.filter(x => !done.has(x.uuid)).slice(0, MAX);
  log(`to process this run: ${todo.length}`);
  if (!todo.length) { log('nothing to do.'); return; }

  await refreshSession();

  const stats = {
    resolvedReal: 0, viaProfile: 0, viaGame: 0,
    placeholder: 0, deferred: 0, processed: 0,
    // placeholder-reason breakdown (only when the answer was DEFINITIVE this run)
    phNotInRoster: 0,   // profile had no name AND uuid not in any reachable roster
    phNameless: 0,      // profile had no name AND uuid in a roster but nameless
    phNoGames: 0,       // profile had no name AND file has no games[]
    phExhausted: 0,     // never reachable after MAX_DEFER passes -> placeholdered to converge
  };
  const phSamples = { notInRoster: [], nameless: [], exhausted: [] };
  let sinceCommit = 0;

  function saveProgress() {
    if (DRY_RUN) return;
    fs.mkdirSync(path.dirname(PROGRESS), { recursive: true });
    fs.writeFileSync(PROGRESS, JSON.stringify({ done: [...done], attempts: Object.fromEntries(attempts) }));
  }
  async function commitCheckpoint(final) {
    saveProgress();
    await gitCommit(
      `repair-season-names: ${stats.resolvedReal} real (${stats.viaProfile} prof/${stats.viaGame} game), `
      + `${stats.placeholder} placeholder, ${stats.deferred} deferred${final ? ' (final)' : ' running'}`,
      ['players/', 'reports/season-name-repair-progress.json']
    );
  }
  // Write a resolved name (real or placeholder) to the player file + index.
  function applyName(uuid, player, newName) {
    player.name = newName;
    player.updatedAt = new Date().toISOString();
    writePlayer(uuid, player);
    const shard = playerShard(uuid);
    const idx = readPlayerIndex(shard);
    if (idx[uuid]) { idx[uuid].name = newName; writePlayerIndex(shard, idx); }
  }
  async function tick() { sinceCommit++; if (sinceCommit >= COMMIT_EVERY) { sinceCommit = 0; await commitCheckpoint(false); } }

  async function processOne(item) {
    const { uuid, games, seasonNorms } = item;
    const usable = cand => {
      if (!cand) return null;
      const nc = normName(cand);
      return (!nc || seasonNorms.has(nc)) ? null : cand;   // never accept a season string
    };

    // 1) Direct profile lookup -- the primary, stat-independent path.
    let realName = null, via = null;
    const prof = await gqlPublicProfile(uuid);
    if (prof.name) { const u = usable(prof.name); if (u) { realName = u; via = 'profile'; } }

    // 2) Fallback: spectator game rosters, only if the profile gave no usable name.
    let anyUnreachableGame = false, foundInRoster = false;
    if (!realName) {
      for (const gameId of games) {
        const roster = await rosterForGame(gameId);
        if (!roster) { anyUnreachableGame = true; continue; }  // unreachable game
        if (!roster.has(uuid)) continue;                       // reachable, player absent
        foundInRoster = true;
        const u = usable(roster.get(uuid));
        if (u) { realName = u; via = 'game'; break; }
      }
    }

    const player = readPlayer(uuid);
    if (!player) { done.add(uuid); attempts.delete(uuid); return; }  // file vanished

    if (realName) {
      applyName(uuid, player, realName);
      stats.resolvedReal++;
      if (via === 'profile') stats.viaProfile++; else stats.viaGame++;
      done.add(uuid); attempts.delete(uuid); stats.processed++;
      await tick();
      return;
    }

    // No name found. Only placeholder on a DEFINITIVE answer (profile reached AND
    // no fallback game was unreachable this run). Otherwise DEFER -- leave the file
    // untouched, don't mark done, and let a later pass retry -- so a transient
    // failure is never frozen as a permanent placeholder.
    const definitive = prof.reached && !anyUnreachableGame;
    if (!definitive) {
      const n = (attempts.get(uuid) || 0) + 1;
      attempts.set(uuid, n);
      if (n < MAX_DEFER) { stats.deferred++; await tick(); return; }
      applyName(uuid, player, placeholderFor(uuid));           // exhausted -> converge
      stats.placeholder++; stats.phExhausted++;
      if (phSamples.exhausted.length < 15) phSamples.exhausted.push(uuid);
      done.add(uuid); attempts.delete(uuid); stats.processed++;
      await tick();
      return;
    }

    applyName(uuid, player, placeholderFor(uuid));             // definitive no-name
    stats.placeholder++;
    if (games.length === 0)  { stats.phNoGames++; }
    else if (!foundInRoster) { stats.phNotInRoster++; if (phSamples.notInRoster.length < 15) phSamples.notInRoster.push({ uuid, games: games.slice(0, 5) }); }
    else                     { stats.phNameless++;   if (phSamples.nameless.length < 15) phSamples.nameless.push(uuid); }
    done.add(uuid); attempts.delete(uuid); stats.processed++;
    await tick();
  }

  // Pool at width 3 (publicProfile is the primary call now; game roster is fallback).
  const tasks = todo.map(item => () => processOne(item));
  await runPool(tasks, CONCURRENCY_SPECTATOR);

  await commitCheckpoint(true);

  const remaining = all.length - done.size;
  console.log('─'.repeat(60));
  console.log(`  Processed this run:  ${stats.processed}`);
  console.log(`  Real names restored: ${stats.resolvedReal}  (profile ${stats.viaProfile}, game ${stats.viaGame})`);
  console.log(`  Placeholders set:    ${stats.placeholder}`);
  console.log(`    — not in any roster: ${stats.phNotInRoster}`);
  console.log(`    — in roster, nameless: ${stats.phNameless}`);
  console.log(`    — no games[] on file:  ${stats.phNoGames}`);
  console.log(`    — exhausted (unreachable ${MAX_DEFER}x): ${stats.phExhausted}`);
  console.log(`  Deferred (retry next run): ${stats.deferred}`);
  console.log(`  Unique games fetched: ${gameRosterCache.size}`);
  console.log(`  Remaining overall:   ${remaining}`);

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    processedThisRun: stats.processed,
    resolvedReal: stats.resolvedReal,
    resolvedVia: { profile: stats.viaProfile, game: stats.viaGame },
    placeholder: stats.placeholder,
    placeholderReasons: {
      notInRoster: stats.phNotInRoster,
      nameless: stats.phNameless,
      noGames: stats.phNoGames,
      exhausted: stats.phExhausted,
    },
    deferred: stats.deferred,
    uniqueGamesFetched: gameRosterCache.size,
    remainingOverall: remaining,
    samples: phSamples,
  };
  try {
    fs.mkdirSync(path.dirname(PROGRESS), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'reports', 'season-name-repair-report.json'), JSON.stringify(report, null, 2));
  } catch (_) {}

  const summary = `## repair-season-names${DRY_RUN ? ' (DRY RUN)' : ''}\n\n`
    + `| metric | value |\n| --- | --- |\n`
    + `| processed this run | ${stats.processed} |\n`
    + `| real names restored | ${stats.resolvedReal} (profile ${stats.viaProfile}, game ${stats.viaGame}) |\n`
    + `| placeholders | ${stats.placeholder} |\n`
    + `| — not in any roster | ${stats.phNotInRoster} |\n`
    + `| — in roster, nameless | ${stats.phNameless} |\n`
    + `| — no games[] on file | ${stats.phNoGames} |\n`
    + `| — exhausted (unreachable ${MAX_DEFER}x) | ${stats.phExhausted} |\n`
    + `| deferred (retry next run) | ${stats.deferred} |\n`
    + `| unique games fetched | ${gameRosterCache.size} |\n`
    + `| remaining overall | ${remaining} |\n`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary); } catch (_) {}
  }
  try { fs.writeFileSync(path.join(ROOT, '.repair-season-names-status.json'), JSON.stringify({ remaining })); } catch (_) {}
  log(`DONE. processed=${stats.processed} real=${stats.resolvedReal}(prof ${stats.viaProfile}) placeholder=${stats.placeholder} deferred=${stats.deferred} remaining=${remaining}`);
}
main().catch(e => { console.error('FATAL:', e.message, '\n', e.stack); process.exit(1); });
