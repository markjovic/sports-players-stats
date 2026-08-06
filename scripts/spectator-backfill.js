// scripts/spectator-backfill.js
//
// Runs the nightly crawl's spectator step over the games it has never reached.
//
// WHY THIS EXISTS (2026-08-06): probe-missing-games proved that 100 of 100 sampled
// "missing appearance" cases are games we already hold whose player list is incomplete,
// and every single one has spc unset — the spectator step has never run on them. The
// nightly skips locked seasons by design and tournament comps fall outside its round
// window, so those games' player lists came from earlier population steps and were
// never completed. The fix is not a new mechanism: it is the EXISTING spectator step,
// pointed at the games it missed.
//
// Everything that talks to PlayHQ, touches git, or writes player/game files below is
// COPIED VERBATIM from scripts/nightly-crawl.js — the live script making the same
// class of call (house rule). The build step asserts byte-identity.
//
// DELIBERATE differences from the nightly, each with a reason:
//   - The queue comes from a LOCAL scan of games/bv, INCLUDING locked seasons,
//     instead of Phase 1/2 discover calls. This run makes ZERO main-api calls
//     beyond the session cookie.
//   - statsChecked is NOT cleared and reg discovery is SKIPPED. Player career and
//     per-reg stats come from profiles (fetch-profile-stats.js), and profiles have
//     ALWAYS counted these games — that data is already correct. Clearing would only
//     queue a pointless six-figure matrix sweep.
//   - NEW players found in fetched rosters still get stubs + alias identities
//     (Phase 4 logic verbatim), so every p[] id resolves.
//   - Progress IS the data: spc:1 is written per game and committed every
//     COMMIT_EVERY_GAMES games. Resume by re-dispatching — the scan skips spc-set
//     games. No progress file (trap T22).
//   - The game-file cache is EVICTED after each periodic flush. The nightly touches
//     a few hundred active seasons; this can touch 2,000+, and caching them all
//     would exhaust runner memory. The queue is sorted by season so eviction is
//     nearly free.
//
// The spectator endpoint leaves misses UNMARKED (faithful to the nightly: spc is set
// only on a response). Games the endpoint has no data for are re-tried on the next
// dispatch — the queue only ever shrinks by real answers.
//
// Usage:
//   node scripts/spectator-backfill.js --dry-run          # scan + report the queue, nothing else
//   node scripts/spectator-backfill.js                    # fetch up to --max-games (default 100000)
//   node scripts/spectator-backfill.js --season=<sid>     # one season only

'use strict';

function isFinal(rn) {
  if (!rn) return false;
  return rn.toLowerCase().includes('final');
}
function isGrandFinal(rn) {
  if (!rn) return false;
  const r = rn.toLowerCase();
  return r.includes('grand final') || r === 'gf';
}


const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execFileSync } = require('child_process');
const { truncateUuid, resolveToFullUuid, TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const DRY_RUN       = !!ARGS['dry-run'];
const TARGET_SEASON = ARGS.season || null;
const MAX_GAMES     = ARGS['max-games'] ? Math.max(1, parseInt(ARGS['max-games'], 10)) : 100000;

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const GAMES_DIR     = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR   = path.join(ROOT, 'players');
const INDEX_DIR     = path.join(ROOT, 'players', 'indexes');
const INDEX_FILE    = path.join(ROOT, 'data', 'sports-index.json');

const CONCURRENCY_SPECTATOR = 3;       // unchanged (spectator.playhq.com)
const COMMIT_EVERY_GAMES    = 2000;    // flush + commit spc/p[] progress every N games

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

async function refreshSession() {
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
}

// ─── Spectator query — nightly-crawl.js, verbatim ─────────────────────────────

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
      if (retry.status !== 200 || retry.body.errors) return null;
      return retry.body.data?.game || null;
    }
    if (status !== 200 || body.errors) return null;
    return body.data?.game || null;
  } catch (_) { return null; }
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

async function runPool(tasks, concurrency) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) { await tasks[i++](); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// ─── Git commit — nightly-crawl.js, verbatim (house pattern) ──────────────────

// commitLock prevents concurrent tasks from triggering simultaneous commits
let commitLock = false;

// dirs: explicit paths only — never -A. This repo is multi-GB with 370k+
// player files and 2,800+ game/team-stats files; -A walks the whole index
// and risks ENOBUFS (confirmed empirically 2026-07-10: a 355k-file operation
// blew Node's execSync 1MB stdout buffer via git's own default per-file
// output — the same class of thing -A risks here at similar or larger scale,
// since it has to diff the ENTIRE working tree, not just what this run touched).
// --shortstat (not --stat) and --no-stat on merge for the same reason — both
// print a per-file line/graph by default, --stat and a real merge diffstat
// scale with file count, --shortstat and --no-stat don't.
async function gitCommit(message, dirs) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  const paths = (dirs && dirs.length ? dirs : ['.']);

  // ── Per-path add (directive 9) ──────────────────────────────────────────────
  // `git add` is ATOMIC across pathspecs: one unmatched path in a combined add
  // stages NOTHING, exits 128, and the empty `catch (_) {}` this replaces then
  // hid it — leaving "nothing to commit" as the only visible symptom. That is
  // exactly how discover-fixtures.js discarded 30,426 fetched games on a GREEN
  // run (2026-07-19). Staged individually, a miss skips only itself and is
  // reported loudly.
  let addFailures = 0, hardAddFailures = 0;
  for (const p of paths) {
    try { execFileSync('git', ['add', '--', p], { stdio: 'pipe', cwd: ROOT }); }
    catch (e) {
      addFailures++;
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      // "did not match any files" on a per-path add is benign — see the note below.
      if (!/did not match any files/i.test(detail)) hardAddFailures++;
      console.error(`  ⚠ git add ${/did not match any files/i.test(detail) ? 'skipped' : 'FAILED'} for "${p}": ${detail}`);
    }
  }

  const staged = (() => {
    try { return execFileSync('git', ['diff', '--staged', '--shortstat'], { stdio: 'pipe', cwd: ROOT }).toString().trim(); }
    catch (_) { return ''; }
  })();

  if (!staged) {
    // Previously a bare silent `return`. Nothing staged AFTER a staging failure is
    // the silent-loss signature, so it must not be reported as a clean no-op.
    //
    // But be PRECISE about which failure. With per-path adds, a pathspec that
    // "did not match any files" is provably harmless: it staged nothing AND, unlike
    // the old combined add, took nothing else down with it. That is the ordinary
    // case for an optional path — e.g. needs-matrix-shards.json, which this script
    // deletes when there are no affected shards, and which a forward-mode run
    // (--rounds-forward) legitimately never recreates. Throwing on that would fail
    // a run that did exactly what it should.
    // Any OTHER add error — permissions, a locked index, corruption — is NOT
    // harmless and still throws.
    if (hardAddFailures) {
      throw new Error(`gitCommit: nothing staged and ${hardAddFailures} path(s) failed to stage for a reason other than "did not match any files" — refusing to report this as a clean no-op ("${message}")`);
    }
    if (addFailures) {
      console.log(`  (no changes to commit: ${message}) — ${addFailures} optional path(s) absent, which is not an error here`);
      return;
    }
    console.log(`  (no changes to commit: ${message})`);
    return;
  }
  console.log(`  staging: ${staged}`);   // directive 9: prove what was staged

  // Identity passed inline on commit AND merge: a missing committer identity
  // otherwise surfaces only as a merge failure, and burns the whole retry budget
  // on a config problem no amount of retrying can fix.
  const IDENT = ['-c', 'user.name=github-actions[bot]',
                 '-c', 'user.email=github-actions[bot]@users.noreply.github.com'];

  // execFileSync with an argument array — the message is no longer interpolated
  // into a shell string, so the `"` -> `'` escaping hack is gone with it.
  try { execFileSync('git', [...IDENT, 'commit', '-q', '-m', message], { stdio: 'pipe', cwd: ROOT }); }
  catch (e) {
    const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
    throw new Error(`gitCommit: commit failed for "${message}" — ${detail}`);
  }

  // ── Push with retry (house pattern, copied from fold-diverged-players.js) ────
  // 60 attempts, pure random 1-91s jitter, `merge --abort` before each attempt,
  // and THROW on total failure. The previous 10-attempt loop ended in
  // `console.error` + `return`, so a run could push NOTHING and still go green —
  // the same defect closed on build-team-stats.js on 2026-07-29, which REPO_MANIFEST
  // §6.9/§6.10 called "the remaining"/"the last" 10-attempt outlier. It was not:
  // this file had it too.
  // Only genuine contention is retried. A non-contention push failure (auth,
  // branch protection, size, hook rejection) is not fixed by waiting, so it fails
  // fast with git's real error rather than being buried under 60 identical lines.
  // NOTE: async sleep, not a blocking one — gitCommit is awaited from inside the
  // Phase 2 paced pool, and blocking here would stall sibling fetch workers.
  const MAX = 60;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try { execFileSync('git', ['merge', '--abort'], { stdio: 'pipe', cwd: ROOT }); } catch (_) { /* none in progress */ }

    try {
      execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'pipe', cwd: ROOT });
    } catch (e) {
      if (attempt === MAX) throw e;
      const s = 1 + Math.floor(Math.random() * 91);
      console.log(`  fetch failed (attempt ${attempt}/${MAX}), retrying in ${s}s`);
      await sleep(s * 1000);
      continue;
    }

    // A merge failure is a config or content problem, not a race — fatal.
    execFileSync('git', [...IDENT, 'merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat'], { stdio: 'pipe', cwd: ROOT });

    try {
      execFileSync('git', ['push', 'origin', 'HEAD:main'], { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✓ Committed: ${message} (pushed on attempt ${attempt})`);
      return;
    } catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
      const contention = /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(detail);
      if (!contention) {
        console.error(`  push failed — NOT contention, failing fast. git said:\n${detail}`);
        throw e;
      }
      if (attempt === MAX) {
        console.error(`  push still rejected after ${MAX} attempts. git said:\n${detail}`);
        throw e;
      }
      const s = 1 + Math.floor(Math.random() * 91);
      console.log(`  push attempt ${attempt}/${MAX} rejected (remote advanced), re-syncing in ${s}s`);
      await sleep(s * 1000);
    }
  }
  throw new Error(`gitCommit: exhausted ${MAX} push attempts for "${message}"`);
}

// Commit only if not already in progress — safe for concurrent callers
async function tryPeriodicCommit(message, dirs) {
  if (commitLock) return;
  commitLock = true;
  try {
    const n = flushGameFiles();
    if (n > 0) await gitCommit(message, dirs);
  } finally {
    commitLock = false;
  }
}

// ─── Game file cache — nightly-crawl.js, verbatim (incl. shrink guard) ────────

const gameCache = new Map();   // seasonId → { games: {} }
const gameDirty = new Set();   // seasonIds with pending writes

function loadGameFile(seasonId) {
  if (gameCache.has(seasonId)) return gameCache.get(seasonId);
  const file = path.join(GAMES_DIR, `${seasonId}.json`);
  let data = { games: {} };
  if (fs.existsSync(file)) {
    // If the file EXISTS but can't be read/parsed, do NOT fall back to an empty
    // object — upserting onto empty and flushing would overwrite the file with
    // only this run's games, destroying existing (often unrecoverable, e.g.
    // API-withheld junior) data on disk. Abort loudly instead.
    const raw = fs.readFileSync(file, 'utf8');   // throws on read error — intended
    try { data = JSON.parse(raw); }
    catch (e) { throw new Error(`Refusing to proceed: ${file} exists but failed to parse (${e.message}). Would risk overwriting existing games.`); }
  }
  if (!data.games) data.games = {};
  gameCache.set(seasonId, data);
  return data;
}

function markGameDirty(seasonId) { gameDirty.add(seasonId); }

function flushGameFiles() {
  let count = 0;
  for (const seasonId of [...gameDirty]) {
    if (!gameCache.has(seasonId)) continue;
    const file = path.join(GAMES_DIR, `${seasonId}.json`);
    const next = gameCache.get(seasonId);
    const nextN = Object.keys(next.games || {}).length;
    // Shrink guard: never write fewer games than already exist on disk. A stripped/
    // empty API response must never delete existing (possibly unrecoverable) games.
    if (fs.existsSync(file)) {
      let prevN = 0;
      try { prevN = Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')).games) || {}).length; } catch { prevN = Infinity; }
      if (nextN < prevN) {
        console.error(`  ⚠ SHRINK GUARD: ${seasonId} would drop from ${prevN} to ${nextN} games — refusing to write.`);
        gameDirty.delete(seasonId);
        continue;
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next));
    gameDirty.delete(seasonId);
    count++;
  }
  return count;
}

// ─── Player file helpers — nightly-crawl.js, verbatim ─────────────────────────

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


// ─── Backfill queue (local scan — replaces Phase 1/2) ─────────────────────────
// QUEUE = games with NO player list at all. Nothing else. (Corrected 2026-08-06,
// Mark: the first version queued every spc-unset game — 2,050,204 — but ~2.03M of
// those carry partial lists written before the spc flag existed and are doing their
// job. Rewriting them wholesale to chase a ~2.7% appearance gap is exactly the
// churn-for-marginal-data trade this project rejects; per-game data that the normal
// path already serves is not re-fetched. spc's absence does NOT mean unprocessed on
// old games.) Empty-list games contribute nothing to any player's games[]/W-L/finals
// today, so fetching them is new data, not churn: the re-sweep's fixture-only locked
// games and the tournament comps. Remaining rules mirror the nightly's queueing
// sites (status FINAL, !spc, !forfeit, !legacy); a game with BOTH scores but no st
// (older writers) is also taken, reported separately. Hidden games carry t1/t2
// instead of h/a; both shapes are handled, as Phase 1b does.
function buildBackfillQueue(sportIndex) {
  const queue = [];
  const tallies = {
    files: 0, games: 0, spcSet: 0, forfeit: 0, otherTerminal: 0, notFinal: 0,
    queuedFinalSt: 0, queuedScoreNoSt: 0, queuedEmptyList: 0, partialListLeftAlone: 0,
    queuedLocked: 0, queuedActive: 0,
  };
  const perSeason = new Map();
  const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort();
  for (const fname of files) {
    const sid = fname.replace('.json', '');
    if (TARGET_SEASON && sid !== TARGET_SEASON) continue;
    tallies.files++;
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); } catch { continue; }
    const locked = !!(sportIndex.seasons?.[sid]?.locked);
    for (const [gameId, g] of Object.entries(gf.games || {})) {
      if (!g) continue;
      tallies.games++;
      if (g.spc)                                { tallies.spcSet++;        continue; }
      if (g.forfeit)                            { tallies.forfeit++;       continue; }
      if (g.bye || g.cancelled || g.abandoned || g.legacy) { tallies.otherTerminal++; continue; }
      const finalSt    = g.st === 'FINAL';
      const scoreNoSt  = g.st == null && g.hs != null && g.as != null;
      if (!finalSt && !scoreNoSt)               { tallies.notFinal++;      continue; }
      const nPlayers = ((g.p && g.p.length) || 0) + ((g.hp && g.hp.length) || 0) + ((g.ap && g.ap.length) || 0);
      if (nPlayers > 0) { tallies.partialListLeftAlone++; continue; }   // has a roster — NOT our business
      if (finalSt) tallies.queuedFinalSt++; else tallies.queuedScoreNoSt++;
      tallies.queuedEmptyList++;
      if (locked) tallies.queuedLocked++; else tallies.queuedActive++;
      perSeason.set(sid, (perSeason.get(sid) || 0) + 1);
      queue.push({
        gameId,
        seasonId:  sid,
        rn:        g.rn  || null,
        gradeId:   g.gid || null,
        gradeName: g.gn  || null,
        homeTid:   g.h  || g.t1 || null,
        awayTid:   g.a  || g.t2 || null,
        homeScore: g.hs ?? null,
        awayScore: g.as ?? null,
      });
    }
  }
  // Season-sorted so the cache eviction below keeps at most a season or two in memory.
  queue.sort((a, b) => a.seasonId === b.seasonId
    ? (a.gameId < b.gameId ? -1 : 1)
    : (a.seasonId < b.seasonId ? -1 : 1));
  return { queue, tallies, perSeason };
}

// The nightly caches a few hundred active seasons and never needs to let go; this
// tool can touch 2,000+, so after every flush the clean entries are dropped.
function evictCleanSeasons() {
  for (const sid of [...gameCache.keys()]) {
    if (!gameDirty.has(sid)) gameCache.delete(sid);
  }
}


// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('spectator-backfill.js');
  if (TARGET_SEASON) console.log(`  season:    ${TARGET_SEASON}`);
  console.log(`  max-games: ${MAX_GAMES}`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — scan and report only: no API calls, no writes, no commits');
  console.log('─'.repeat(50));

  if (!fs.existsSync(INDEX_FILE)) { console.error('sports-index.json not found'); process.exit(1); }
  const sportIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));

  console.log('Scanning games/bv for never-spectator-processed games…');
  const { queue, tallies, perSeason } = buildBackfillQueue(sportIndex);
  const line = (l, v) => console.log(`  ${l.padEnd(48, '.')} ${v.toLocaleString()}`);
  line('Season files scanned', tallies.files);
  line('Games on file', tallies.games);
  line('  already spectator-processed (spc set)', tallies.spcSet);
  line('  forfeits / byes / cancelled / abandoned', tallies.forfeit + tallies.otherTerminal);
  line('  not FINAL and unscored (future etc.)', tallies.notFinal);
  line('  with a player list already (LEFT ALONE)', tallies.partialListLeftAlone);
  line('QUEUE — no player list at all', queue.length);
  line('  with st=FINAL', tallies.queuedFinalSt);
  line('  scored but no st field (older writers)', tallies.queuedScoreNoSt);
  line('  in LOCKED seasons', tallies.queuedLocked);
  line('  in ACTIVE seasons', tallies.queuedActive);
  console.log('  Top seasons by queued games:');
  for (const [sid, n] of [...perSeason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const s = sportIndex.seasons?.[sid];
    console.log(`    ${sid}  ${String(n).padStart(6)}  locked=${!!s?.locked}  ${s?.name || ''} — ${s?.orgName || ''}`);
  }

  if (DRY_RUN) {
    console.log(`\nDry run complete in ${Math.round((Date.now() - t0) / 1000)}s — nothing fetched, nothing written.`);
    return;
  }

  const needsSpectator = queue.slice(0, MAX_GAMES);
  if (queue.length > needsSpectator.length) {
    console.log(`  Capped to ${needsSpectator.length} this run — re-dispatch to continue (spc-set games are skipped).`);
  }
  if (needsSpectator.length === 0) { console.log('\nQueue empty — nothing to do.'); return; }
  console.log();

  await refreshSession();

  // ── Spectator fetch — nightly-crawl.js Phase 3, verbatim ─────────────────────
  console.log(`Spectator box scores (${needsSpectator.length} games)…`);
  const playerDeltas = new Map();
  let spectatorHits = 0, spectatorMiss = 0, p3Done = 0;

  const p3Tasks = needsSpectator.map(({ gameId, seasonId, rn, gradeId, gradeName, homeTid, awayTid, homeScore, awayScore }) => async () => {
    const game = await gqlSpectator(gameId);
    p3Done++;
    if (p3Done % 50 === 0 || p3Done === needsSpectator.length)
      process.stdout.write(`  ${p3Done}/${needsSpectator.length}  hits: ${spectatorHits}  misses: ${spectatorMiss}\r`);

    if (!game?.statistics) {
      spectatorMiss++;
      return;
    }
    spectatorHits++;

    const homePlayers = parseSpectatorPlayers(game.statistics?.home?.players);
    const awayPlayers = parseSpectatorPlayers(game.statistics?.away?.players);
    const allPlayers  = [...homePlayers, ...awayPlayers];

    // Collect player deltas for later batch processing
    const isFinalsGame = isFinal(rn);
    const isGF         = isGrandFinal(rn);
    const homeWon      = (homeScore !== null && awayScore !== null) ? homeScore > awayScore : null;

    for (const p of allPlayers) {
      if (!p.profileID) continue;
      if (!playerDeltas.has(p.profileID)) {
        playerDeltas.set(p.profileID, { name: p.name, deltas: [] });
      }
      const isHomePlayer = homePlayers.some(hp => hp.profileID === p.profileID);
      const playerTid    = isHomePlayer ? homeTid : awayTid;
      const playerWon    = homeWon === null ? null : (isHomePlayer ? homeWon : !homeWon);
      playerDeltas.get(p.profileID).deltas.push({
        seasonId, gameKey: gameId, pts: p.pts, pt3: p.pt3, fouls: p.fouls,
        isFinalsGame, isGF, playerTid, playerWon,
        gradeId, gradeName,
      });
    }

    // Mark spc:1 and update p[] on the game entry — spc prevents re-processing.
    // p[].id is truncated to a 13-char prefix (uuid-prefix.cjs TRUNC_LEN; the
    // original 2026-07-10 UUID-storage migration used 10, later widened to 13)
    // — this field is only ever an attendee list keyed by id, never resolved
    // back to a player file from within this script, so it's safe to write
    // truncated here. playerDeltas above (used for player-file writes) keeps
    // p.profileID FULL-length throughout — only the on-disk game file field
    // is shortened.
    const gf = loadGameFile(seasonId);
    if (gf.games[gameId] && !DRY_RUN) {
      if (allPlayers.length > 0) {
        gf.games[gameId].p = allPlayers.map(p => ({
          id: truncateUuid(p.profileID),
          // n omitted — name not needed in p[], profileID is the key
        }));
      }
      gf.games[gameId].spc = 1;
      markGameDirty(seasonId);
    }
  });

  // Periodic progress commits wrapped AROUND the verbatim task body: spc:1 written
  // per game is the progress record, so committing every COMMIT_EVERY_GAMES games
  // makes a timeout cost at most one window. Cache eviction rides the same cadence.
  let sinceCommit = 0;
  const wrappedTasks = p3Tasks.map(t => async () => {
    await t();
    sinceCommit++;
    if (sinceCommit >= COMMIT_EVERY_GAMES) {
      sinceCommit = 0;
      await tryPeriodicCommit(`spectator-backfill: progress ${p3Done}/${needsSpectator.length} (${spectatorHits} hits)`, ['games/']);
      evictCleanSeasons();
    }
  });

  await runPool(wrappedTasks, CONCURRENCY_SPECTATOR);
  console.log(`  ${needsSpectator.length}/${needsSpectator.length} done`
            + `  hits: ${spectatorHits}  misses: ${spectatorMiss}`);
  console.log(`  Players with deltas: ${playerDeltas.size}`);

  const flushedSpc = flushGameFiles();
  if (flushedSpc > 0) {
    await gitCommit(`spectator-backfill: spc+p[] written for ${spectatorHits} games`, ['games/']);
  }
  console.log();

  // ── api-canonical resolution — nightly-crawl.js, verbatim ────────────────────
  {
    const canonicalDeltas = new Map();
    let redirected = 0;
    for (const [origId, info] of playerDeltas) {
      const key = resolveToFullUuid(origId, ROOT); // full ids never resolve to null
      if (key !== origId) redirected++;
      const existing = canonicalDeltas.get(key);
      if (existing) existing.deltas.push(...info.deltas);
      else canonicalDeltas.set(key, info);
    }
    playerDeltas.clear();
    for (const [k, v] of canonicalDeltas) playerDeltas.set(k, v);
    if (redirected > 0) console.log(`  Alias-resolved ${redirected} spectator id(s) to canonical api ids`);
  }

  // ── New-player detection ──────────────────────────────────────────────────────
  // The nightly finds genuinely-new players inside its statsChecked-clearing loop.
  // That loop is deliberately SKIPPED here (see header), so the index check runs on
  // its own: any canonical id absent from its shard index gets a stub below.
  const genuinelyNew = new Map();
  {
    const shardIndexCache = new Map();
    for (const [uuid, info] of playerDeltas) {
      const shard = playerShard(uuid);
      if (!shardIndexCache.has(shard)) shardIndexCache.set(shard, readPlayerIndex(shard));
      if (!shardIndexCache.get(shard)[uuid]) {
        genuinelyNew.set(uuid, info.name || `Player #${uuid.slice(0, TRUNC_LEN)}`);
      }
    }
  }

  // ── New player stubs — nightly-crawl.js Phase 4, verbatim ────────────────────
  console.log(`New player stubs (${genuinelyNew.size})…`);
  const now       = new Date().toISOString();
  const newByShard = new Map();
  for (const [uuid, name] of genuinelyNew) {
    const shard = playerShard(uuid);
    if (!newByShard.has(shard)) newByShard.set(shard, []);
    newByShard.get(shard).push({ uuid, name });
  }

  let stubbed = 0;
  for (const [shard, entries] of newByShard) {
    const index        = readPlayerIndex(shard);
    let   indexChanged = false;

    for (const { uuid, name } of entries) {
      if (index[uuid]) continue;  // guard — another process may have added it

      // Compute initial stats from the deltas we already collected
      const deltas = playerDeltas.get(uuid)?.deltas || [];
      const bk     = { maxGamePTS: 0, maxGameThreePt: 0, foulOuts: {} };

      // Build seasons/regs from the SAME deltas, using the SAME construction
      // as the existing-player path above (Phase 3 cont., L945-986). Previously
      // new stubs got `seasons: []` — no tid/gid at all — which meant a
      // namespace-mismatch recovery attempt (fetch-profile-stats.js) had
      // nothing to give gradePlayerStatistics for a brand-new player. This
      // also means Phase 3-cont's "New player -> defer to Phase 4" path no
      // longer silently loses that first night's season/team/history data.
      const seasons = [];
      for (const d of deltas) {
        const { seasonId, pts, pt3, fouls, playerTid, gradeId, gradeName } = d;
        if (pts > bk.maxGamePTS)     bk.maxGamePTS     = pts;
        if (pt3 > bk.maxGameThreePt) bk.maxGameThreePt = pt3;
        if (fouls >= 5) bk.foulOuts[seasonId] = (bk.foulOuts[seasonId] || 0) + 1;

        if (!seasonId || !playerTid || !gradeId) continue;
        let season = seasons.find(s => s.sid === seasonId);
        if (!season) {
          const si = sportIndex.seasons?.[seasonId];
          season = { sid: seasonId, sn: si?.name || seasonId, club: si?.orgName || '', regs: [] };
          seasons.push(season);
        }
        if (!season.regs.some(r => r.tid === playerTid && r.gid === gradeId)) {
          season.regs.push({ tid: playerTid, tn: '', gid: gradeId, gn: gradeName || '', div: null, stats: {} });
        }
      }

      const stub = {
        uuid, name,
        sports:    { Basketball: bk },
        seasons,
        teams:     [],
        spectatorIds: [uuid.slice(0, TRUNC_LEN)],
        updatedAt: now,
      };
      writePlayer(uuid, stub);
      writeAliasIdentity(uuid);

      // History — same shape as the existing-player path (season -> unique tids).
      const history = {};
      for (const season of seasons) {
        history[season.sid] = [...new Set(season.regs.map(r => r.tid))];
      }
      index[uuid]    = { name, history };
      indexChanged   = true;
      stubbed++;
    }

    if (indexChanged) writePlayerIndex(shard, index);
  }
  console.log(`  Stubbed: ${stubbed}`);
  console.log();

  await gitCommit(
    `spectator-backfill: ${spectatorHits} games filled, ${stubbed} new players stubbed`,
    ['players/']
  );

  // ── Summary ───────────────────────────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log('─'.repeat(50));
  console.log(`  Queue total:       ${queue.length}  (this run: ${needsSpectator.length})`);
  console.log(`  Spectator hits:    ${spectatorHits}  misses: ${spectatorMiss}`);
  console.log(`  Players seen:      ${playerDeltas.size}`);
  console.log(`  New players:       ${stubbed}`);
  console.log(`  Remaining (approx): ${queue.length - spectatorHits} — misses stay queued until spectator answers`);
  console.log(`  Elapsed:           ${elapsed}s`);
  console.log('─'.repeat(50));
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
