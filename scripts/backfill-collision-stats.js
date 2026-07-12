// scripts/backfill-collision-stats.js
//
// READ-ONLY. Aggregates reports/backfill-collisions/*.json (produced by
// backfill-missing-players.js) to answer one question: how many DISTINCT
// spectator ids map to the same api id? i.e. can a single real player have
// multiple valid spectator ids?
//
// Collision shards are keyed/sharded by SPECTATOR-id prefix, so two spectator
// ids for the same person live in different shards and no single backfill job
// can see both. This script reads every shard and inverts the mapping
// (apiId -> set of spectator ids) to measure the multiplicity directly.
//
// Pure local file read: NO API, NO network, no writes, no git. Safe to run at
// any time, including while a backfill run is still in progress (it simply
// reports on whatever has been recorded so far) and re-run as more accumulates.
//
// Usage:
//   node scripts/backfill-collision-stats.js
//   node scripts/backfill-collision-stats.js --examples=20

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT           = path.join(__dirname, '..');
const COLLISIONS_DIR = path.join(ROOT, 'reports', 'backfill-collisions');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const MAX_EXAMPLES = ARGS.examples ? parseInt(ARGS.examples, 10) : 15;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

console.log('backfill-collision-stats.js  (READ-ONLY — no API, no network, no writes)');
console.log('─'.repeat(64));

let shardFiles = [];
try {
  shardFiles = fs.readdirSync(COLLISIONS_DIR).filter(f => /^[0-9a-f]{2}\.json$/i.test(f));
} catch (_) {
  console.log(`  No collision report directory yet at ${COLLISIONS_DIR}`);
  console.log('  (Nothing recorded — has a real backfill run committed collisions yet?)');
  process.exit(0);
}
if (!shardFiles.length) {
  console.log('  Collision report directory exists but is empty — nothing recorded yet.');
  process.exit(0);
}

// apiId -> { spectatorIds: Set, names: Set }
const byApi = new Map();
let totalMappings = 0;

for (const f of shardFiles) {
  let data;
  try { data = readJson(path.join(COLLISIONS_DIR, f)); } catch (_) { continue; }
  for (const [spectatorId, rec] of Object.entries(data)) {
    const apiId = rec && rec.apiId;
    if (!apiId) continue;
    totalMappings++;
    if (!byApi.has(apiId)) byApi.set(apiId, { spectatorIds: new Set(), names: new Set() });
    const e = byApi.get(apiId);
    e.spectatorIds.add(spectatorId);
    if (rec.name) e.names.add(normName(rec.name));
  }
}

const distinctApiIds = byApi.size;

// Distribution of distinct-spectator-ids-per-apiId.
const hist = new Map(); // count -> number of apiIds with that many spectator ids
let maxCount = 0, maxApi = null;
let apiIdsWithMultiple = 0;
let nameMismatches = 0;
const multiExamples = [];

for (const [apiId, e] of byApi) {
  const n = e.spectatorIds.size;
  hist.set(n, (hist.get(n) || 0) + 1);
  if (n > maxCount) { maxCount = n; maxApi = apiId; }
  if (n >= 2) {
    apiIdsWithMultiple++;
    // If the same apiId's spectator ids carry DIFFERENT names, that's a flag —
    // either PlayHQ name drift, or a mis-match (two different people wrongly
    // reconciled to one apiId). Worth surfacing.
    if (e.names.size > 1) nameMismatches++;
    if (multiExamples.length < MAX_EXAMPLES) {
      multiExamples.push({
        apiId,
        count: n,
        names: [...e.names],
        spectatorIds: [...e.spectatorIds],
      });
    }
  }
}

console.log(`  Collision shards read        : ${shardFiles.length}`);
console.log(`  Total spectator→api mappings : ${totalMappings.toLocaleString()}`);
console.log(`  Distinct api ids             : ${distinctApiIds.toLocaleString()}`);
console.log('');
console.log('  Distinct spectator ids per api id — distribution:');
for (const n of [...hist.keys()].sort((a, b) => a - b)) {
  const apiCount = hist.get(n);
  const bar = '█'.repeat(Math.min(50, Math.round(apiCount / distinctApiIds * 50)));
  console.log(`    ${String(n).padStart(3)} spectator id(s) : ${String(apiCount).padStart(7)} api id(s)  ${bar}`);
}
console.log('');
console.log(`  api ids with >1 spectator id : ${apiIdsWithMultiple.toLocaleString()}  (${distinctApiIds ? (apiIdsWithMultiple / distinctApiIds * 100).toFixed(1) : '0.0'}% of distinct api ids)`);
console.log(`  max spectator ids for one api id : ${maxCount}${maxApi ? `  (apiId ${maxApi.slice(0, 13)})` : ''}`);
console.log(`  api ids whose spectator ids carry DIFFERENT names : ${nameMismatches.toLocaleString()}  <- investigate: name drift or mis-reconciliation`);

console.log('\n  VERDICT:');
if (apiIdsWithMultiple === 0) {
  console.log('    No api id has >1 spectator id in the data so far — consistent with');
  console.log('    spectator ids being 1-per-player (at least among recorded collisions).');
} else {
  console.log(`    CONFIRMED: a single player CAN have multiple valid spectator ids.`);
  console.log(`    ${apiIdsWithMultiple.toLocaleString()} api id(s) are referenced by 2+ distinct spectator ids.`);
  console.log('    This is the mechanism behind much of the un-indexed backlog, and the');
  console.log('    reason keying on spectator id multiplies records for these players.');
}

if (multiExamples.length) {
  console.log('\n  examples (api id ← multiple spectator ids):');
  for (const ex of multiExamples) {
    console.log(`    apiId=${ex.apiId.slice(0, 13)}  ×${ex.count} spectator ids  name(s)=${ex.names.map(n => `"${n}"`).join(', ')}`);
    for (const s of ex.spectatorIds) console.log(`        ← ${s}`);
  }
}
console.log('\nDone (nothing was written).');
