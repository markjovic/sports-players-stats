// scripts/diagnose-api-stability.js
//
// READ-ONLY. Local only — NO API, NO network, NO writes, NO git. Reads
// players/indexes/*.json and asks: how many DISTINCT indexed records are
// near-certainly the SAME person?
//
// Signal: two indexed records that share a normalised NAME *and* share a
// (season, team) roster slot — i.e. history[sid] lists the same tid for both —
// are almost certainly one human. A team cannot field two identically-named
// players in the same grade/season, so name + shared (sid,tid) is a
// near-definitive same-person match (far stronger than name alone, which
// collides for common names).
//
// WHAT THIS MEASURES / DOESN'T:
//   - It measures the TOTAL same-person duplicate-record rate in the index.
//     That is the UPPER BOUND on api-instability duplication.
//   - It does NOT by itself separate the two causes of a duplicate:
//       (a) spectator-id multiplicity — one person indexed under two DIFFERENT
//           spectator ids. The api-canonical migration FIXES these (both fold
//           to one apiId). Independently measured at ~6.2% of collision api ids
//           (backfill-collision-stats.js).
//       (b) api-id instability — one person with two DIFFERENT api profiles.
//           The migration does NOT fix these (they fold to two apiIds). THIS is
//           the dangerous case.
//   - Interpretation by triangulation: if the total duplicate rate here is
//     ~consistent with the known spectator-multiplicity rate, api instability
//     is negligible. A large EXCESS over spectator multiplicity is the
//     api-instability signal. A definitive per-pair split needs each record's
//     `apiId` field (in the player files) — a heavier follow-up only worth
//     doing if this probe shows a worrying excess.
//
// Best run AFTER the backfill completes (more of both profiles indexed → more
// detectable), but valid any time.
//
// Usage:
//   node scripts/diagnose-api-stability.js [--examples=20]

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const INDEX_DIR = path.join(ROOT, 'players', 'indexes');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const MAX_EXAMPLES = ARGS.examples ? parseInt(ARGS.examples, 10) : 20;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

// Records whose `name` is actually a SEASON name (the known parseProfileStats
// bug: seasonStatistics[0].name is the season, not the player) must be excluded
// — they falsely cluster as one "person" because they all share the same
// season/team slots. The artifacts are season-word + YEAR ("winter 2023",
// "summer 2024/25", "term 3 2024"). Requiring a year avoids eating REAL names
// like "Winter Smith" / "Summer Jones" (a bare season word alone must NOT be
// filtered). Also match a standalone year, and obvious grade tokens.
const YEAR = /(19|20)\d\d(\/\d\d)?/;
const SEASON_WORD = /\b(summer|winter|spring|autumn|fall|term|season)\b/i;
function isSeasonName(nm) {
  if (SEASON_WORD.test(nm) && YEAR.test(nm)) return true;       // "winter 2023", "term 3 2024"
  if (/^(19|20)\d\d(\/\d\d)?$/.test(nm)) return true;           // bare "2023" / "2024/25"
  if (/^(u\d+|under\s*\d+|div(ision)?\b|grade\b|round\b)/i.test(nm) && YEAR.test(nm)) return true;
  return false;
}

console.log('diagnose-api-stability.js  (READ-ONLY — no API, no network, no writes)');
console.log('─'.repeat(64));

let shardFiles = [];
try { shardFiles = fs.readdirSync(INDEX_DIR).filter(f => /^[0-9a-f]{2}\.json$/i.test(f)); }
catch (e) { console.error(`Cannot read ${INDEX_DIR}: ${e.message}`); process.exit(1); }

// name -> [ { key, history } ]
const byName = new Map();
let totalRecords = 0;
let seasonNameArtifacts = 0;

for (const f of shardFiles) {
  let idx;
  try { idx = readJson(path.join(INDEX_DIR, f)); } catch (_) { continue; }
  for (const [key, rec] of Object.entries(idx)) {
    totalRecords++;
    const nm = normName(rec && rec.name);
    if (!nm) continue; // no name → can't name-match (placeholder / private without real name)
    if (isSeasonName(nm)) { seasonNameArtifacts++; continue; } // parseProfileStats season-name bug — not a real name
    if (!byName.has(nm)) byName.set(nm, []);
    byName.get(nm).push({ key, history: (rec && rec.history) || {} });
  }
}

console.log(`  Index shards read        : ${shardFiles.length}`);
console.log(`  Total indexed records    : ${totalRecords.toLocaleString()}`);
console.log(`  Season-name artifacts excluded : ${seasonNameArtifacts.toLocaleString()}  (records whose name is a season, per the parseProfileStats bug — not real names)`);
console.log(`  Distinct (real) names    : ${byName.size.toLocaleString()}`);

// For each name group, find records sharing a (sid,tid) roster slot.
// Build (sid|tid) -> Set(keys); any slot with >1 key => those keys are the
// same person. Union those keys into same-person clusters.
let namesWithMultiRecords = 0;
let samePersonClusters = 0;     // clusters of >=2 records that are the same person
let duplicateRecords = 0;       // total records that are a duplicate (cluster size - 1, summed)
let sameNameNoOverlap = 0;      // name shared by >=2 records but NO roster overlap (likely genuinely different people)
const examples = [];

for (const [nm, recs] of byName) {
  if (recs.length < 2) continue;
  namesWithMultiRecords++;

  // slot -> set of keys
  const slotKeys = new Map();
  for (const r of recs) {
    for (const [sid, tids] of Object.entries(r.history)) {
      for (const tid of (Array.isArray(tids) ? tids : [])) {
        const slot = `${sid}|${tid}`;
        if (!slotKeys.has(slot)) slotKeys.set(slot, new Set());
        slotKeys.get(slot).add(r.key);
      }
    }
  }

  // union-find over keys linked by a shared slot
  const parent = new Map(recs.map(r => [r.key, r.key]));
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  let anyOverlap = false;
  for (const [, keys] of slotKeys) {
    if (keys.size < 2) continue;
    anyOverlap = true;
    const arr = [...keys];
    for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
  }

  if (!anyOverlap) { sameNameNoOverlap++; continue; }

  // collect clusters of size >= 2
  const clusters = new Map();
  for (const r of recs) { const root = find(r.key); if (!clusters.has(root)) clusters.set(root, []); clusters.get(root).push(r.key); }
  for (const [, members] of clusters) {
    if (members.length < 2) continue;
    samePersonClusters++;
    duplicateRecords += members.length - 1;
    if (examples.length < MAX_EXAMPLES) examples.push({ name: nm, members });
  }
}

const dupRate = totalRecords ? (duplicateRecords / totalRecords * 100) : 0;

console.log('');
console.log(`  Names shared by >=2 records         : ${namesWithMultiRecords.toLocaleString()}`);
console.log(`    ├─ WITH shared (sid,tid) roster slot (same person) : ${samePersonClusters.toLocaleString()} clusters`);
console.log(`    └─ NO roster overlap (likely different people)     : ${sameNameNoOverlap.toLocaleString()}`);
console.log('');
console.log(`  Duplicate records (same person, extra copies) : ${duplicateRecords.toLocaleString()}`);
console.log(`  Duplicate-record rate vs all indexed          : ${dupRate.toFixed(2)}%`);

console.log('\n  INTERPRETATION:');
console.log('    This is the TOTAL same-person duplication (spectator-multiplicity + any');
console.log('    api-instability combined) — an UPPER BOUND on api-instability.');
console.log('    Compare against the spectator-multiplicity rate from backfill-collision-stats.js:');
console.log('      • duplicate rate ≈ spectator-multiplicity → api ids effectively stable, migration safe.');
console.log('      • duplicate rate >> spectator-multiplicity → an api-instability component exists;');
console.log('        classify the excess by reading the flagged records\' apiId field (player files).');

if (examples.length) {
  console.log('\n  examples (same name + shared roster slot = same person, multiple records):');
  for (const ex of examples) {
    console.log(`    "${ex.name}"  ×${ex.members.length} records:`);
    for (const k of ex.members) console.log(`        ${k}`);
  }
}
console.log('\nDone (nothing was written).');
