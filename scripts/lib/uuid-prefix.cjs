// scripts/lib/uuid-prefix.cjs
//
// Shared helper for the games/leaderboard/team-stats/search UUID truncation
// migration (2026-07-10). Ids stored in those four directories are truncated
// to a 10-char prefix (e.g. "28a87f6c-9") to save space; players/{shard}/{uuid}.json
// still uses the FULL 36-char uuid as its filename — that's the one place a
// uuid gets to be a filename "for free". Anything that needs to go from a
// stored id back to a real player file must resolve the prefix first. This
// module is that resolution step, and nothing else.
//
// Approach: reuse players/indexes/{shard}.json (already built for search,
// already keyed by full uuid) rather than build a brand-new index file.
// Builds a Map<prefix10, fullUuid> once per shard on first use and caches
// it for the life of the process — O(1) lookups after that, not a linear
// scan per call. 256 shards / ~370k players fit comfortably in memory
// alongside this (players/indexes/ is ~158MB total on disk).
//
// Usage (CJS):  const { resolveToFullUuid, truncateUuid } = require('./lib/uuid-prefix.cjs');
// Usage (ESM):  import { resolveToFullUuid, truncateUuid } from './lib/uuid-prefix.cjs';

'use strict';

const fs = require('fs');
const path = require('path');

const TRUNC_LEN = 10;
const FULL_LEN = 36; // e.g. 28a87f6c-9457-41f1-b4da-a051b49572c2

function isFullUuid(id) {
  return typeof id === 'string' && id.length === FULL_LEN;
}

function isTruncatedPrefix(id) {
  return typeof id === 'string' && id.length === TRUNC_LEN;
}

// Truncates a full uuid for writing to games/leaderboard/team-stats/search.
// Throws rather than silently truncating something that isn't actually a
// full uuid — a short/malformed input here means a caller bug upstream.
function truncateUuid(fullUuid) {
  if (!isFullUuid(fullUuid)) {
    throw new Error(
      `truncateUuid: expected a ${FULL_LEN}-char uuid, got "${fullUuid}" (${fullUuid == null ? 'n/a' : fullUuid.length} chars)`
    );
  }
  return fullUuid.slice(0, TRUNC_LEN);
}

// shard ("28") -> Map<prefix10, fullUuid>, built once, reused for the life of the process.
const shardPrefixMaps = new Map();

function loadShardPrefixMap(shard, root) {
  if (shardPrefixMaps.has(shard)) return shardPrefixMaps.get(shard);
  const map = new Map();
  const indexPath = path.join(root, 'players', 'indexes', `${shard}.json`);
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const index = JSON.parse(raw);
    for (const fullUuid of Object.keys(index)) {
      if (!isFullUuid(fullUuid)) continue; // defensive — index should only ever hold full uuids
      const prefix = fullUuid.slice(0, TRUNC_LEN);
      if (map.has(prefix) && map.get(prefix) !== fullUuid) {
        // A real collision — should never happen at 10 chars (zero collisions
        // confirmed at 369k players for the same-length private-profile
        // display-name precedent), but never silently pick one over the
        // other if it ever does. Surface it loudly instead.
        throw new Error(
          `uuid-prefix: collision in shard ${shard} — prefix "${prefix}" matches both ${map.get(prefix)} and ${fullUuid}`
        );
      }
      map.set(prefix, fullUuid);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // real parse/collision errors must surface; a missing shard file must not
  }
  shardPrefixMaps.set(shard, map);
  return map;
}

// Resolves any id read from games/leaderboard/team-stats/search back to the
// full uuid needed to read players/{shard}/{uuid}.json. Full-length ids pass
// through unchanged (covers historical data written before this migration
// landed, and any consumer that hasn't been touched by the migration yet).
//
// Returns null (never throws) when a truncated prefix has no match in the
// shard index — callers MUST handle this as a real, expected case (the 2026-07-10
// audit already found a 7-file drift between players/indexes/ and actual
// player file counts), not assume it can never happen.
function resolveToFullUuid(id, root) {
  if (isFullUuid(id)) return id;
  if (!isTruncatedPrefix(id)) {
    throw new Error(
      `resolveToFullUuid: unexpected id length — "${id}" is ${id == null ? 'n/a' : id.length} chars, expected ${TRUNC_LEN} or ${FULL_LEN}`
    );
  }
  const shard = id.slice(0, 2).toLowerCase();
  const map = loadShardPrefixMap(shard, root);
  return map.get(id) || null;
}

module.exports = {
  resolveToFullUuid,
  truncateUuid,
  isFullUuid,
  isTruncatedPrefix,
  TRUNC_LEN,
  FULL_LEN,
};
