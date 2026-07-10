// scripts/lib/uuid-prefix.cjs
//
// Shared helper for the games/leaderboard/team-stats/search UUID truncation
// migration (2026-07-10). Ids stored in those four directories are truncated
// to a prefix of the full 36-char uuid to save space; players/{shard}/{uuid}.json
// still uses the FULL uuid as its filename -- that's the one place a uuid gets
// to be a filename "for free". Anything that needs to go from a stored id
// back to a real player file must resolve the prefix first. This module is
// that resolution step, and nothing else.
//
// Approach: reuse players/indexes/{shard}.json (already built for search,
// already keyed by full uuid) rather than build a brand-new index file.
// Builds a Map<prefix, fullUuid> once per (shard, length) pair on first use
// and caches it for the life of the process -- O(1) lookups after that, not a
// linear scan per call. 256 shards / ~370k players fit comfortably in memory
// alongside this (players/indexes/ is ~158MB total on disk).
//
// 2026-07-10 -- corrected twice the same day:
//
// Round 1: a real collision surfaced in production (shard b0, prefix
// "b0d1fc12-8" matched two distinct full uuids). Collisions are handled as a
// permanent, expected case rather than a fatal error -- see the COLLISION
// sentinel below. A colliding prefix resolves to null (same as "not found")
// instead of throwing and taking the whole build down.
//
// Round 2: TRUNC_LEN was 10, and the "10 hex chars (40 bits)" math used to
// justify that length was wrong. A uuid is formatted 8-4-4-4-12 with hyphens
// (e.g. "28a87f6c-9457-41f1-b4da-a051b49572c2"). slice(0, 10) on that string
// is "28a87f6c-9" -- 10 CHARACTERS, but the 9th one is the literal "-"
// separator, which is identical on every uuid ever generated and carries
// ZERO bits of entropy. A 10-char prefix therefore only ever encodes 9 real
// hex digits (36 bits), not 10 (40 bits). At ~370k players, true
// birthday-paradox collision probability (1 - e^(-n(n-1)/(2*2^36)), not the
// cruder n^2/(2N) approximation, which overstates things once the result
// gets close to 1) is ~63% -- a collision somewhere in the population was
// very likely, not the ~5-6% long shot originally estimated for 40 bits.
// That's exactly what round 1 hit.
//
// TRUNC_LEN is now 13. Because the first hyphen falls at string index 8,
// the first 13 characters of any uuid are 8 hex digits + "-" + 4 more hex
// digits = 12 real hex digits (48 bits), not 13. At the same ~370k players:
// P ~= 0.024%. Still comfortably safe even at 10x today's player count.
//
// Existing games/bv/*.json data already written at the old 10-char length is
// upgraded by scripts/fix-uuid-prefix-length.js (one-off, resumable) -- see
// that script for the upgrade pass, and scripts/audit-uuid-collisions.js for
// a full system-wide collision scan at any given length. Until the upgrade
// has fully run, this module also accepts LEGACY_TRUNC_LEN (10) as a valid
// input length so old, not-yet-upgraded values still resolve correctly
// wherever they aren't ambiguous.
//
// Usage (CJS):  const { resolveToFullUuid, truncateUuid } = require('./lib/uuid-prefix.cjs');
// Usage (ESM):  import { resolveToFullUuid, truncateUuid } from './lib/uuid-prefix.cjs';

'use strict';

const fs = require('fs');
const path = require('path');

const TRUNC_LEN = 13;        // 12 real hex digits (48 bits) -- current, correct length
const LEGACY_TRUNC_LEN = 10; // 9 real hex digits (36 bits) -- old length, read-only support for not-yet-upgraded data
const FULL_LEN = 36;         // e.g. 28a87f6c-9457-41f1-b4da-a051b49572c2

// Sentinel stored in a shard's prefix map when two distinct full uuids
// truncate to the same prefix. Never returned to callers -- resolveToFullUuid
// converts it to null, same as "prefix not found".
const COLLISION = Symbol('uuid-prefix-collision');

function isFullUuid(id) {
  return typeof id === 'string' && id.length === FULL_LEN;
}

function isTruncatedPrefix(id) {
  return typeof id === 'string' && (id.length === TRUNC_LEN || id.length === LEGACY_TRUNC_LEN);
}

// Truncates a full uuid for writing to games/leaderboard/team-stats/search.
// Throws rather than silently truncating something that isn't actually a
// full uuid -- a short/malformed input here means a caller bug upstream.
function truncateUuid(fullUuid) {
  if (!isFullUuid(fullUuid)) {
    throw new Error(
      `truncateUuid: expected a ${FULL_LEN}-char uuid, got "${fullUuid}" (${fullUuid == null ? 'n/a' : fullUuid.length} chars)`
    );
  }
  return fullUuid.slice(0, TRUNC_LEN);
}

// (shard, length) -> Map<prefix, fullUuid | COLLISION>, built once per pair,
// reused for the life of the process. Keyed by length too, since this module
// now resolves both TRUNC_LEN and LEGACY_TRUNC_LEN prefixes and those need
// separate maps built off the same underlying index.
const shardPrefixMaps = new Map();
// same key -> [{ prefix, uuids: [a, b] }, ...] -- collisions found while
// building that shard's map, for diagnostics (getCollisions()).
const shardCollisions = new Map();

function loadShardPrefixMap(shard, root, len) {
  const key = `${shard}:${len}`;
  if (shardPrefixMaps.has(key)) return shardPrefixMaps.get(key);
  const map = new Map();
  const collisions = [];
  const indexPath = path.join(root, 'players', 'indexes', `${shard}.json`);
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const index = JSON.parse(raw);
    for (const fullUuid of Object.keys(index)) {
      if (!isFullUuid(fullUuid)) continue; // defensive -- index should only ever hold full uuids
      const prefix = fullUuid.slice(0, len);
      const existing = map.get(prefix);
      if (existing === COLLISION) continue; // already known ambiguous for this shard -- skip
      if (existing !== undefined && existing !== fullUuid) {
        console.error(
          `WARNING uuid-prefix: COLLISION in shard ${shard} (length ${len}) -- prefix "${prefix}" matches both ${existing} and ${fullUuid}. ` +
          `Both are now UNRESOLVABLE via this prefix length (treated as not-found).`
        );
        collisions.push({ prefix, uuids: [existing, fullUuid] });
        map.set(prefix, COLLISION);
        continue;
      }
      map.set(prefix, fullUuid);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // real parse errors must surface; a missing shard file must not
  }
  shardPrefixMaps.set(key, map);
  if (collisions.length) shardCollisions.set(key, collisions);
  return map;
}

// Resolves any id read from games/leaderboard/team-stats/search back to the
// full uuid needed to read players/{shard}/{uuid}.json. Full-length ids pass
// through unchanged. Accepts both TRUNC_LEN (current) and LEGACY_TRUNC_LEN
// (pre-upgrade) inputs -- see the round-2 note at the top of this file.
//
// Returns null (never throws) when a prefix has no unambiguous match in the
// shard index -- callers MUST handle this as a real, expected case.
function resolveToFullUuid(id, root) {
  if (isFullUuid(id)) return id;
  if (!isTruncatedPrefix(id)) {
    throw new Error(
      `resolveToFullUuid: unexpected id length -- "${id}" is ${id == null ? 'n/a' : id.length} chars, expected ${LEGACY_TRUNC_LEN}, ${TRUNC_LEN}, or ${FULL_LEN}`
    );
  }
  const shard = id.slice(0, 2).toLowerCase();
  const map = loadShardPrefixMap(shard, root, id.length);
  const result = map.get(id);
  if (result === COLLISION || result === undefined) return null;
  return result;
}

// Returns every collision found so far across all (shard, length) pairs
// actually loaded in this process. Shape:
// [{ shard, len, prefix, uuids: [a, b] }, ...]. Intended for scripts that
// want to report collisions in their own summary output rather than relying
// solely on the console.error above.
function getCollisions() {
  const out = [];
  for (const [key, list] of shardCollisions) {
    const [shard, len] = key.split(':');
    for (const c of list) out.push({ shard, len: Number(len), ...c });
  }
  return out;
}

module.exports = {
  resolveToFullUuid,
  truncateUuid,
  isFullUuid,
  isTruncatedPrefix,
  getCollisions,
  TRUNC_LEN,
  LEGACY_TRUNC_LEN,
  FULL_LEN,
};
