// scripts/backfill-generate-candidates.js
//
// Scans games/bv/*.json EXACTLY ONCE and writes the un-indexed full-length-uuid
// candidate pool, bucketed by the first 2 hex chars of the uuid, so the
// sharded backfill matrix (backfill-missing-players-matrix.yml) can process
// buckets in parallel on separate runners/IPs WITHOUT each job re-scanning the
// whole of games/bv (2.27M games) 256 times.
//
// The discovery logic here is identical to backfill-missing-players.js's own
// games-scan path (same p[]/hp[]/ap[] extraction, same isFullUuid + index
// check) -- deliberately kept in lockstep so both agree on what a "candidate"
// is. The two share lib/uuid-prefix.cjs; if the extraction ever changes, it
// changes in both.
//
// Output:
//   <out-dir>/<bucket>.json   for each non-empty bucket, = { uuid: [appearances] }
//   <out-dir>/_buckets.json   = JSON array of non-empty bucket names (for the
//                               matrix `strategy.matrix.bucket`)
//   also prints `buckets=[...]` to $GITHUB_OUTPUT if GITHUB_OUTPUT is set.
//
// Appearance shape (per uuid, one per game seen):
//   { gid, sid, gradeId, gradeName, h, hn, a, an, forfeit }
// This is everything the resolve phase needs -- it never re-reads games/bv,
// because spectator box scores are fetched live by gameId.
//
// READ-ONLY w.r.t. the repo (writes only to --out-dir, an artifact staging
// path outside the tree). No git operations.
//
// Usage:
//   node scripts/backfill-generate-candidates.js --out-dir=/tmp/candidates

'use strict';

const fs   = require('fs');
const path = require('path');
const { isFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT      = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games', 'bv');
const INDEX_DIR = path.join(ROOT, 'players', 'indexes');
const COLLISIONS_DIR = path.join(ROOT, 'reports', 'backfill-collisions');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const OUT_DIR = ARGS['out-dir'] ? String(ARGS['out-dir']) : '/tmp/candidates';

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function bucketOf(uuid) { return uuid.slice(0, 2).toLowerCase(); }

// Index lookups, cached per shard (same pattern as backfill-missing-players.js).
const indexCache = new Map();
function readPlayerIndex(shard) {
  if (indexCache.has(shard)) return indexCache.get(shard);
  const file = path.join(INDEX_DIR, `${shard}.json`);
  let data = {};
  if (fs.existsSync(file)) { try { data = readJson(file); } catch (_) { data = {}; } }
  indexCache.set(shard, data);
  return data;
}
function isAlreadyKnown(uuid) { return !!readPlayerIndex(bucketOf(uuid))[uuid]; }

// Collision-shard lookups (same sharded layout backfill-missing-players.js
// writes). A recorded collision is an alias of an already-indexed player and
// must be excluded from candidates -- otherwise the matrix's retrigger loop
// would keep re-emitting these ~93% aliases forever and never terminate.
const collisionsCache = new Map();
function readCollisionsShard(shard) {
  if (collisionsCache.has(shard)) return collisionsCache.get(shard);
  const file = path.join(COLLISIONS_DIR, `${shard}.json`);
  let data = {};
  if (fs.existsSync(file)) { try { data = readJson(file); } catch (_) { data = {}; } }
  collisionsCache.set(shard, data);
  return data;
}
function isKnownCollision(uuid) { return !!readCollisionsShard(bucketOf(uuid))[uuid]; }

console.log('backfill-generate-candidates.js');
console.log('─'.repeat(60));
console.log(`Scanning games/bv once, bucketing candidates by uuid prefix → ${OUT_DIR}`);

const sids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
const buckets = new Map(); // bucket -> { uuid: [appearances] }
let seasonsScanned = 0, gamesScanned = 0, appearancesScanned = 0, candidateCount = 0;

for (const fname of sids) {
  let gf;
  try { gf = readJson(path.join(GAMES_DIR, fname)); } catch { continue; }
  const sid = fname.replace('.json', '');
  seasonsScanned++;
  for (const [gid, g] of Object.entries(gf.games || {})) {
    gamesScanned++;
    const ids = new Set();
    for (const e of (g.p  || [])) { if (e?.id)        ids.add(e.id); }
    for (const e of (g.hp || [])) { if (e?.profileID) ids.add(e.profileID); }
    for (const e of (g.ap || [])) { if (e?.profileID) ids.add(e.profileID); }
    for (const uuid of ids) {
      if (!isFullUuid(uuid)) continue;
      appearancesScanned++;
      if (isAlreadyKnown(uuid)) continue;
      if (isKnownCollision(uuid)) continue; // alias of an existing player, already recorded — not a candidate
      const b = bucketOf(uuid);
      if (!buckets.has(b)) buckets.set(b, {});
      const bucket = buckets.get(b);
      if (!bucket[uuid]) { bucket[uuid] = []; candidateCount++; }
      bucket[uuid].push({
        gid, sid,
        gradeId: g.gid || null, gradeName: g.gn || null,
        h: g.h || null, hn: g.hn || null, a: g.a || null, an: g.an || null,
        forfeit: !!g.forfeit,
      });
    }
  }
}

console.log(`  ${seasonsScanned} season files | ${gamesScanned.toLocaleString()} games | ${appearancesScanned.toLocaleString()} full-uuid appearances scanned`);
console.log(`  Candidates: ${candidateCount.toLocaleString()} across ${buckets.size} non-empty buckets`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const bucketNames = [...buckets.keys()].sort();
for (const b of bucketNames) {
  fs.writeFileSync(path.join(OUT_DIR, `${b}.json`), JSON.stringify(buckets.get(b)));
}
fs.writeFileSync(path.join(OUT_DIR, '_buckets.json'), JSON.stringify(bucketNames));

// Emit the bucket list for the matrix (GitHub Actions `strategy.matrix.bucket`).
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `buckets=${JSON.stringify(bucketNames)}\n`);
}

console.log(`  Wrote ${bucketNames.length} bucket files + _buckets.json to ${OUT_DIR}`);
console.log('Done.');
