// scripts/salvage-spectator-names.js
'use strict';
// ONE-TIME exhaustive spectator-roster name salvage for the season-name
// stragglers that repair-season-names.js placeholdered via MAX_DEFER. The repair
// gave up on them because it batched all ~250 of their games into single runs
// that blew the spectator per-session quota, so most games came back unreachable
// and the deferral logic (wrongly) froze a Player #<prefix> placeholder.
//
// This job checks EVERY one of their games exactly once, in bounded batches
// (shards of 25 — comfortably inside the ~30-35 spectator calls a fresh session
// allows), each shard on its own runner with its own session. A reconcile step
// then:
//   - applies the real name if ANY game's roster yielded a usable one, and
//   - only treats a player as genuinely nameless (leaving the existing
//     placeholder in place, now justified) when EVERY one of their games was
//     actually reached and none carried a name. If any game went unreached,
//     the player is left untouched and reported — never frozen on a transient
//     miss. That is the guarantee the repair's defer check failed to give.
//
// Modes:
//   --plan            print the shard list (also written to $GITHUB_OUTPUT)
//   --shard=N         fetch batch N's games -> ./name-salvage-shard-N.json (no git)
//   --reconcile       aggregate ./name-salvage-shard-*.json -> player files + index (one commit)
//   --dry-run         reconcile resolves but writes/commits nothing
//
// Spectator/session/git/IO primitives are copied verbatim from
// repair-season-names.js (which took them verbatim from nightly-crawl.js).

const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const { TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const INDEX_DIR   = path.join(ROOT, 'players', 'indexes');

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const DRY_RUN = !!ARGS['dry-run'];

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const CONCURRENCY_SPECTATOR = 3;    // verbatim from nightly-crawl.js
const BATCH = 25;                   // games per shard — inside the spectator per-session quota

// The 15 stragglers, hardcoded (one-time job). Their names, if they exist
// anywhere reachable, live only in their old spectator game rosters.
const TARGETS = [
  '01967747-e34d-41e3-aace-5f641a0671a5',
  '0a870259-5dd7-457c-b778-ff48781971c9',
  '1bec6b37-8313-4569-b253-b7cf9a98fe98',
  '1dcf8891-95df-4531-ade1-14451647ff32',
  '2f6958cc-0d21-4aaf-a60c-6be90c9f88bf',
  '3ae113d3-a15f-463d-a5dc-a8404013dbda',
  '4a9385e7-715a-4145-9aa8-148da3b2bc57',
  '55fcc7ea-daa3-4327-80f8-a85facbbc8c2',
  '798addcc-54db-44d5-b640-34843e9bc5cb',
  '9aab8ead-0e71-4ecd-ac2d-3f43ee2c4186',
  'bbdaf17f-0f28-4ca3-b669-a5f4d7eb2c51',
  'ce757e42-1f70-4f54-bf9c-f7be4ec39f3f',
  'e88d432f-8b37-4b48-866d-6cd276500d46',
  'e98f0259-93a2-4ea8-a2c1-6bf9876de962',
  'fa038f8d-a10e-4aa9-9900-05acbc1de469',
];
const TARGET_SET = new Set(TARGETS);

function shardFile(n) { return path.join(ROOT, `name-salvage-shard-${n}.json`); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log(`[salvage] ${new Date().toISOString()} ${msg}`); }

// normName / isPlaceholderName / placeholderFor — verbatim from repair-season-names.js (normName v2, 2026-08-02)
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
function isPlaceholderName(name) { return !name || /^player\s*#/i.test(String(name).trim()); }
function placeholderFor(uuid) { return `Player #${uuid.slice(0, TRUNC_LEN)}`; }

// ─── HTTP — verbatim from repair-season-names.js / nightly-crawl.js ─────────────
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

// ─── Session + headers — verbatim from repair-season-names.js ───────────────────
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
let sessionPromise = null;
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

// gqlSpectator — verbatim shape from repair-season-names.js, but returns a
// { reached, game } pair so the caller can distinguish "checked, no data" (a
// 200 with a null/absent game — archived) from "unreachable" (403/network/error,
// which must NOT count toward exhaustion).
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
  const send = () => doFetch(
    SPECTATOR_URL,
    { operationName: 'game', variables: { id: gameId }, query },
    { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
  );
  try {
    let res = await send();
    if (res.status === 403) { await refreshSession(); res = await send(); }
    if (res.status !== 200 || (res.body && res.body.errors)) return { reached: false, game: null };
    return { reached: true, game: (res.body && res.body.data && res.body.data.game) || null };
  } catch (_) { return { reached: false, game: null }; }
}

function rosterNames(game) {
  // -> Map(profileID -> name) for any roster player that has a name
  const out = new Map();
  const stat = game && game.statistics;
  for (const side of ['home', 'away']) {
    for (const p of ((stat && stat[side] && stat[side].players) || [])) {
      if (p && p.profileID && p.name) out.set(p.profileID, p.name);
    }
  }
  return out;
}

// ─── Concurrency pool — verbatim from nightly-crawl.js ──────────────────────────
async function runPool(tasks, concurrency) {
  let i = 0;
  async function worker() { while (i < tasks.length) { await tasks[i++](); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// ─── git commit — verbatim from repair-season-names.js (60-attempt / 1-91s) ─────
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

// ─── Player IO — verbatim from repair-season-names.js ───────────────────────────
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
function applyName(uuid, player, newName) {
  player.name = newName;
  player.updatedAt = new Date().toISOString();
  writePlayer(uuid, player);
  const shard = playerShard(uuid);
  const idx = readPlayerIndex(shard);
  if (idx[uuid]) { idx[uuid].name = newName; writePlayerIndex(shard, idx); }
}

// ─── Plan: deterministic unique-game list + season labels per target ────────────
// Every mode recomputes this identically from the on-disk player files, so a
// shard needs nothing but its index N — no plan artifact to pass around.
function buildPlan() {
  const seasonNorms = {};   // uuid -> Set(normalised season labels) — to reject season strings
  const gameSet = new Set();
  const perTargetGames = {};
  let missing = 0;
  for (const uuid of TARGETS) {
    const p = readPlayer(uuid);
    if (!p) { missing++; perTargetGames[uuid] = []; seasonNorms[uuid] = new Set(); continue; }
    const games = Array.isArray(p.games) ? p.games.map(String) : [];
    perTargetGames[uuid] = games;
    for (const g of games) gameSet.add(g);
    seasonNorms[uuid] = new Set((p.seasons || []).map(s => normName(s.sn)).filter(Boolean));
  }
  const games = [...gameSet].sort();                    // deterministic order
  const batches = [];
  for (let i = 0; i < games.length; i += BATCH) batches.push(games.slice(i, i + BATCH));
  return { games, batches, perTargetGames, seasonNorms, missing };
}

// ─── Modes ──────────────────────────────────────────────────────────────────────
async function modePlan() {
  const { games, batches, missing } = buildPlan();
  const indices = batches.map((_, i) => i);
  log(`targets ${TARGETS.length}, missing files ${missing}, unique games ${games.length}, shards ${batches.length} (batch ${BATCH})`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `shards_json=${JSON.stringify(indices)}\nnshards=${batches.length}\n`);
  }
  console.log(`shards_json=${JSON.stringify(indices)}`);
}

async function modeShard(n) {
  const { batches } = buildPlan();
  if (n < 0 || n >= batches.length) { log(`shard ${n} out of range (0..${batches.length - 1}); nothing to do`); return; }
  const batch = batches[n];
  log(`shard ${n}: ${batch.length} games`);
  await refreshSession();

  const found = {};                 // uuid -> [{ name, gameId }]
  const reached = [], unreached = [];
  const tasks = batch.map(gameId => async () => {
    const { reached: ok, game } = await gqlSpectator(gameId);
    if (!ok) { unreached.push(gameId); return; }
    reached.push(gameId);
    if (!game) return;              // reached, but archived/empty — legitimately no data
    const names = rosterNames(game);
    for (const uuid of TARGET_SET) {
      if (names.has(uuid)) { (found[uuid] = found[uuid] || []).push({ name: names.get(uuid), gameId }); }
    }
  });
  await runPool(tasks, CONCURRENCY_SPECTATOR);

  const artifact = { shard: n, batchSize: batch.length, reached, unreached, found };
  fs.writeFileSync(shardFile(n), JSON.stringify(artifact));
  log(`shard ${n} done: reached ${reached.length}/${batch.length}, unreached ${unreached.length}, names for ${Object.keys(found).length} target(s)`);
}

function collectShards() {
  // Read every ./name-salvage-shard-*.json present (download-artifact merges them here).
  const files = fs.readdirSync(ROOT).filter(f => /^name-salvage-shard-\d+\.json$/.test(f));
  const shards = [];
  for (const f of files) {
    try { shards.push(JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'))); } catch (_) {}
  }
  return shards;
}

async function modeReconcile() {
  const { batches, perTargetGames, seasonNorms } = buildPlan();
  const nShards = batches.length;
  const shards = collectShards();
  const present = new Set(shards.map(s => s.shard));
  const missingShards = [];
  for (let i = 0; i < nShards; i++) if (!present.has(i)) missingShards.push(i);

  // Aggregate across shards
  const reachedGames = new Set();
  const namesByUuid = {};           // uuid -> [name, name, ...]
  for (const s of shards) {
    for (const g of (s.reached || [])) reachedGames.add(String(g));
    for (const [uuid, hits] of Object.entries(s.found || {})) {
      for (const h of hits) (namesByUuid[uuid] = namesByUuid[uuid] || []).push(h.name);
    }
  }

  const usable = (uuid, cand) => {
    const nc = normName(cand);
    if (!nc) return false;
    return !seasonNorms[uuid].has(nc);          // never accept a season string
  };
  const pickBest = (uuid, names) => {
    const counts = new Map();
    for (const n of names) { if (usable(uuid, n)) counts.set(n, (counts.get(n) || 0) + 1); }
    if (!counts.size) return null;
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];   // most frequent usable
  };

  const stats = { resolved: 0, confirmedPlaceholder: 0, incomplete: 0, alreadyReal: 0, missingFile: 0 };
  const resolvedSample = [], incompleteSample = [];

  for (const uuid of TARGETS) {
    const player = readPlayer(uuid);
    if (!player) { stats.missingFile++; continue; }

    const real = pickBest(uuid, namesByUuid[uuid] || []);
    if (real) {
      applyName(uuid, player, real);
      stats.resolved++;
      if (resolvedSample.length < 20) resolvedSample.push(`${uuid.slice(0, 8)} -> "${real}"`);
      continue;
    }

    // No usable name found. Only *confirm* a placeholder if EVERY one of this
    // player's games was actually reached this campaign. Otherwise leave the file
    // untouched and report — never freeze on an unreached game.
    const myGames = perTargetGames[uuid] || [];
    const unreachedForMe = myGames.filter(g => !reachedGames.has(String(g)));
    if (unreachedForMe.length === 0) {
      // Fully exhausted — every game reached, no usable name anywhere.
      if (isPlaceholderName(player.name)) {
        stats.confirmedPlaceholder++;                    // already placeholdered — no rewrite (avoid churn)
      } else if (seasonNorms[uuid].has(normName(player.name))) {
        applyName(uuid, player, placeholderFor(uuid));   // still a season string — placeholder it, now justified
        stats.confirmedPlaceholder++;
      } else {
        stats.alreadyReal++;                             // has a genuine name already — leave it
      }
    } else {
      stats.incomplete++;
      if (incompleteSample.length < 20) incompleteSample.push(`${uuid.slice(0, 8)} — ${unreachedForMe.length}/${myGames.length} games unreached`);
    }
  }

  if (!DRY_RUN && (stats.resolved || stats.confirmedPlaceholder)) {
    await gitCommit(
      `salvage-spectator-names: ${stats.resolved} real, ${stats.confirmedPlaceholder} confirmed-placeholder, ${stats.incomplete} incomplete`,
      ['players/']
    );
  }

  console.log('─'.repeat(60));
  log(`shards present ${shards.length}/${nShards}` + (missingShards.length ? `  MISSING: ${missingShards.join(', ')}` : ''));
  console.log(`  Real names restored:      ${stats.resolved}`);
  for (const s of resolvedSample) console.log(`      ${s}`);
  console.log(`  Confirmed placeholder:    ${stats.confirmedPlaceholder}  (every game reached, no name anywhere)`);
  console.log(`  Incomplete (left as-is):  ${stats.incomplete}  (some games unreached — re-run the missing shard(s))`);
  for (const s of incompleteSample) console.log(`      ${s}`);
  if (stats.alreadyReal) console.log(`  Already had a real name:  ${stats.alreadyReal}`);
  if (stats.missingFile)  console.log(`  Player file missing:      ${stats.missingFile}`);
  if (missingShards.length) {
    console.log(`  ⚠️  ${missingShards.length} shard artifact(s) missing — coverage incomplete; no player was placeholdered on their account.`);
  }
}

async function main() {
  console.log(`\nsalvage-spectator-names  ${DRY_RUN ? '(dry-run) ' : ''}mode=${ARGS.plan ? 'plan' : ARGS.reconcile ? 'reconcile' : ARGS.shard !== undefined ? `shard=${ARGS.shard}` : 'none'}`);
  console.log('─'.repeat(60));
  if (ARGS.plan)            return modePlan();
  if (ARGS.shard !== undefined) return modeShard(parseInt(ARGS.shard, 10));
  if (ARGS.reconcile)       return modeReconcile();
  console.error('No mode given. Use --plan | --shard=N | --reconcile [--dry-run].');
  process.exit(1);
}
main().catch(e => { console.error('FATAL:', e.message, '\n', e.stack); process.exit(1); });
