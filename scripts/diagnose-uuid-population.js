// scripts/diagnose-uuid-population.js
//
// READ-ONLY, NO API, whole-repo count. Sizes the population the namespace-mismatch
// fix actually cares about: full-length uuids that appear in games/bv attendee
// lists. It does NOT classify diverged-vs-private (that needs spectator names +
// the api, done in a later sampled pass) — it only counts, fast, so we can see
// whether the ~86k restored-but-unindexed uuids are really there and how many
// backfill has already turned into placeholder stubs.
//
// Candidate extraction is copied verbatim from backfill-missing-players.js Phase 1
// (same arrays/fields, same isFullUuid filter, same first-two-hex shard, same
// index-membership test) so the counts line up exactly with what backfill sees.
//
// For every DISTINCT full-length uuid found in games/bv p[]/hp[]/ap[]:
//   - indexed + real name        -> already a normal player record
//   - indexed + "Player #…" name -> a placeholder stub (backfill/Phase-4 private)
//   - not indexed                -> no record yet (backfill's pending candidate pool)
//
// Usage:
//   node scripts/diagnose-uuid-population.js
//   node scripts/diagnose-uuid-population.js --samples=25

'use strict';

const fs   = require('fs');
const path = require('path');
const { isFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT      = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games', 'bv');
const INDEX_DIR = path.join(ROOT, 'players', 'indexes');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const N_SAMPLES = Math.max(0, parseInt(ARGS['samples'] || '15', 10));

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function playerShard(uuid) { return uuid.slice(0, 2).toLowerCase(); }
function isPlaceholderName(name) { return !name || /^player\s*#/i.test(String(name).trim()); }

// Lazy per-shard index cache (mirrors backfill's readPlayerIndex).
const indexCache = new Map();
function readPlayerIndex(shard) {
  if (indexCache.has(shard)) return indexCache.get(shard);
  const file = path.join(INDEX_DIR, `${shard}.json`);
  let data = {};
  if (fs.existsSync(file)) { try { data = readJson(file); } catch (_) { data = {}; } }
  indexCache.set(shard, data);
  return data;
}
// Returns the index entry for a uuid, or null.
function indexEntry(uuid) {
  const idx = readPlayerIndex(playerShard(uuid));
  return idx[uuid] || null;
}

console.log('diagnose-uuid-population.js  (READ-ONLY, NO API — whole-repo count)');
console.log('─'.repeat(64));

let sids = [];
try { sids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')); }
catch (e) { console.error(`Cannot read ${GAMES_DIR}: ${e.message}`); process.exit(1); }

let seasonsScanned = 0, gamesScanned = 0, appearancesScanned = 0;

// Distinct full-length uuids -> a single sample appearance (first seen), for
// spot-checking on playhq.com later. We only need one appearance per uuid.
const seen = new Map(); // uuid -> { sid, gid, gradeId, side, teamName }

for (const fname of sids) {
  let gf;
  try { gf = readJson(path.join(GAMES_DIR, fname)); } catch { continue; }
  const sid = fname.replace('.json', '');
  seasonsScanned++;
  for (const [gid, g] of Object.entries(gf.games || {})) {
    gamesScanned++;
    // Track which side each id came from, for the sample appearance only.
    const tagged = [];
    for (const e of (g.p  || [])) { if (e?.id)        tagged.push([e.id, null,  null]); }
    for (const e of (g.hp || [])) { if (e?.profileID) tagged.push([e.profileID, 'home', g.hn || g.h || null]); }
    for (const e of (g.ap || [])) { if (e?.profileID) tagged.push([e.profileID, 'away', g.an || g.a || null]); }
    for (const [uuid, side, teamName] of tagged) {
      if (!isFullUuid(uuid)) continue; // truncated/normal id — not our concern (matches backfill)
      appearancesScanned++;
      if (!seen.has(uuid)) {
        seen.set(uuid, { sid, gid, gradeId: g.gid || null, side, teamName });
      }
    }
  }
}

// Classify each distinct full-length uuid against the index.
let indexedReal = 0, indexedPlaceholder = 0, unindexed = 0;
const unindexedSamples = [];
for (const [uuid, appr] of seen) {
  const entry = indexEntry(uuid);
  if (!entry) {
    unindexed++;
    if (unindexedSamples.length < N_SAMPLES) unindexedSamples.push({ uuid, ...appr });
  } else if (isPlaceholderName(entry.name)) {
    indexedPlaceholder++;
  } else {
    indexedReal++;
  }
}

const distinct = seen.size;
const pct = n => distinct ? (n / distinct * 100).toFixed(1) + '%' : '0%';

console.log(`\nScanned: ${seasonsScanned} season files | ${gamesScanned.toLocaleString()} games | ${appearancesScanned.toLocaleString()} full-uuid appearances`);
console.log('\n══ distinct full-length uuids in games/bv attendee lists ══════');
console.log(`  DISTINCT full-length uuids        : ${distinct.toLocaleString()}`);
console.log(`  ├─ indexed, real name             : ${indexedReal.toLocaleString()}  (${pct(indexedReal)})`);
console.log(`  ├─ indexed, "Player #…" placeholder: ${indexedPlaceholder.toLocaleString()}  (${pct(indexedPlaceholder)})`);
console.log(`  └─ NOT indexed (no record yet)     : ${unindexed.toLocaleString()}  (${pct(unindexed)})`);
console.log('\n  Interpretation:');
console.log('    • NOT-indexed  = backfill\'s pending candidate pool (expected ≈ your 86k).');
console.log('    • placeholder  = full-uuids backfill/Phase-4 already turned into private stubs');
console.log('                     — these are the ones that MIGHT be diverged public players');
console.log('                     mislabelled private; only a spectator-name + api pass can tell.');
console.log('    • real name    = normal resolved records (not our concern).');

if (unindexedSamples.length) {
  console.log(`\n  Sample un-indexed uuids (for manual spot-check on playhq.com):`);
  for (const s of unindexedSamples) {
    console.log(`    ${s.uuid}  season=${s.sid} game=${s.gid} grade=${s.gradeId || '?'}${s.side ? ` ${s.side}=${s.teamName || ''}` : ''}`);
  }
}

console.log('\nDone (nothing was written). Next: sampled spectator-name + api classification of the');
console.log('un-indexed + placeholder buckets to split diverged-recoverable vs genuinely-private.');
