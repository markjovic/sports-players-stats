// scripts/build-alias-index.js
//
// Step 3a of the api-canonical migration. ADDITIVE ONLY: reads existing player
// files + reports/backfill-collisions/*, writes NEW players/aliases/*. Never
// mutates any existing players/{xx}/*.json file.
//
// Output: players/aliases/{spectatorPrefix}.json = { spectatorIdTrunc13: apiId }
// Sharded by SPECTATOR-id prefix (NOT api-id prefix), because a game looks up by
// spectator id. Each bucket XX is self-contained: it reads only
// reports/backfill-collisions/XX.json + players/XX/, so buckets are independent
// and resumable.
//
// ┌─ CONFIRMED against backfill-missing-players.js (session 2026-07-13) ──────────┐
// │ - apiId is a TOP-LEVEL field on the player object (`player.apiId = ...`),     │
// │   set ONLY on recovered/diverged players. Direct-hit & non-diverged players  │
// │   have NO apiId field — for them the filename uuid IS the api id.            │
// │ - `private` is a top-level boolean (`{ uuid, private: false }`).            │
// │ So apiIdOf() = player.apiId, else the filename uuid. No nesting.            │
// │ Minor (fix only if a shard errors): shard width assumed 2 hex chars, and     │
// │ collisions shards assumed { "<spectatorId>": { "apiId": ... } }. trunc() is  │
// │ idempotent, so full-vs-truncated collision keys don't matter.               │
// └──────────────────────────────────────────────────────────────────────────────┘
//
// Usage:
//   node scripts/build-alias-index.js --all           # build every bucket (single runner)
//   node scripts/build-alias-index.js --bucket 3a     # build one bucket (matrix shard)
//   node scripts/build-alias-index.js --all --dry-run # no writes, no commits, print stats
//   node scripts/build-alias-index.js --all --no-commit
//   flags: --batch <n> (commit every n buckets, default 16), --resume

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// Single source of truth — same lib backfill-missing-players.js uses. Never
// hardcode TRUNC_LEN; if it ever changes, this stays aligned automatically.
const { TRUNC_LEN, isFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const ALIASES_DIR = path.join(ROOT, 'players', 'aliases');
const COLLISIONS_DIR = path.join(ROOT, 'reports', 'backfill-collisions');
const CONFLICT_DIR = path.join(ROOT, 'reports', 'alias-conflicts');           // per-bucket (matrix)
const CONFLICT_REPORT_ALL = path.join(ROOT, 'reports', 'alias-conflicts.json'); // single (--all)

const SHARD_PREFIX_LEN = 2;        // playerShard = uuid.slice(0,2), confirmed in backfill

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DRY = has('--dry-run');
const NO_COMMIT = has('--no-commit') || DRY;
const RESUME = has('--resume');
const BATCH = parseInt(val('--batch', '16'), 10);
const ONE_BUCKET = val('--bucket', null);

const HEX = '0123456789abcdef';
const ALL_BUCKETS = [];
for (const a of HEX) for (const b of HEX) ALL_BUCKETS.push(a + b);

function trunc(id) {
  return String(id).slice(0, TRUNC_LEN);
}

// Confirmed from source: apiId is top-level, set only on recovered players.
// Everyone else has no apiId field and their filename uuid IS the api id.
function apiIdOf(player, filenameUuid) {
  if (player && typeof player.apiId === 'string' && player.apiId) return player.apiId;
  return filenameUuid;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function commit(paths, message) {
  if (NO_COMMIT) return;
  const existing = paths.filter(p => fs.existsSync(p));
  if (!existing.length) return;
  git(['add', ...existing]);                    // explicit paths, never -A
  const staged = git(['diff', '--cached', '--shortstat']).trim();
  if (!staged) return;                          // nothing to commit
  git(['commit', '-m', message]);               // single-line message
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      git(['fetch', 'origin', 'main']);
      git(['merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit']); // never rebase
      git(['push', 'origin', 'HEAD:main']);
      return;
    } catch (e) {
      if (attempt === 5) throw e;
    }
  }
}

// Build a single spectator-prefix bucket. Returns { entries, conflicts }.
function buildBucket(bucket) {
  const map = Object.create(null);       // spectatorIdTrunc13 -> apiId
  const conflicts = [];

  const record = (spectatorId, apiId, source) => {
    if (!spectatorId || !apiId) return;
    const key = trunc(spectatorId);
    if (key.length < TRUNC_LEN) return;  // guard against short/garbage ids
    const prev = map[key];
    if (prev && prev !== apiId) {
      conflicts.push({ bucket, key, existing: prev, incoming: apiId, source });
      return;                            // keep first (player-file) value; log
    }
    map[key] = apiId;
  };

  // Source 1: player files keyed by first-seen id in this bucket.
  // Prefix of the filename IS the spectator-side prefix for this shard.
  const shardDir = path.join(PLAYERS_DIR, bucket);
  if (fs.existsSync(shardDir)) {
    for (const fname of fs.readdirSync(shardDir)) {
      if (!fname.endsWith('.json')) continue;
      const uuid = fname.slice(0, -5);
      if (!isFullUuid(uuid)) continue;   // defensive: only full-length uuids are player files
      let player;
      try { player = readJson(path.join(shardDir, fname)); }
      catch (e) { throw new Error(`Unparseable player file ${bucket}/${fname}: ${e.message}`); }
      record(uuid, apiIdOf(player, uuid), 'player-file');
    }
  }

  // Source 2: collision mappings for this bucket (diverged players indexed under
  // their api id — their spectator alias only lives here).
  const collFile = path.join(COLLISIONS_DIR, bucket + '.json');
  if (fs.existsSync(collFile)) {
    let coll;
    try { coll = readJson(collFile); }
    catch (e) { throw new Error(`Unparseable collisions shard ${bucket}.json: ${e.message}`); }
    for (const [spectatorId, info] of Object.entries(coll)) {
      const apiId = info && (info.apiId || info.api || null); // A3-tolerant
      record(spectatorId, apiId, 'collision');
    }
  }

  return { map, conflicts };
}

function writeBucket(bucket, map) {
  if (DRY) return;
  fs.mkdirSync(ALIASES_DIR, { recursive: true });
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k]; // stable diffs
  fs.writeFileSync(path.join(ALIASES_DIR, bucket + '.json'), JSON.stringify(sorted));
}

function main() {
  const buckets = ONE_BUCKET ? [ONE_BUCKET.toLowerCase()] : ALL_BUCKETS;
  let totalEntries = 0;
  const allConflicts = [];
  const pendingCommit = [];

  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    const outFile = path.join(ALIASES_DIR, bucket + '.json');
    if (RESUME && !ONE_BUCKET && fs.existsSync(outFile)) {
      process.stderr.write(`skip ${bucket} (exists, --resume)\n`);
      continue;
    }

    const { map, conflicts } = buildBucket(bucket);
    const n = Object.keys(map).length;
    totalEntries += n;
    allConflicts.push(...conflicts);
    writeBucket(bucket, map);
    pendingCommit.push(outFile);
    process.stderr.write(`bucket ${bucket}: ${n} aliases${conflicts.length ? `, ${conflicts.length} conflicts` : ''}\n`);

    const lastOfBatch = ONE_BUCKET || (pendingCommit.length >= BATCH) || (i === buckets.length - 1);
    if (lastOfBatch && pendingCommit.length) {
      commit(pendingCommit.slice(), `build-alias-index: ${pendingCommit.length} shard(s) up to ${bucket}`);
      pendingCommit.length = 0;
    }
  }

  if (allConflicts.length && !DRY) {
    const conflictFile = ONE_BUCKET
      ? path.join(CONFLICT_DIR, ONE_BUCKET.toLowerCase() + '.json')
      : CONFLICT_REPORT_ALL;
    fs.mkdirSync(path.dirname(conflictFile), { recursive: true });
    fs.writeFileSync(conflictFile, JSON.stringify(allConflicts, null, 2));
    commit([conflictFile], `build-alias-index: ${allConflicts.length} alias conflicts logged`);
  }

  process.stderr.write(`\nDONE. buckets=${buckets.length} aliases=${totalEntries} conflicts=${allConflicts.length}${DRY ? ' (dry-run)' : ''}\n`);
}

main();
