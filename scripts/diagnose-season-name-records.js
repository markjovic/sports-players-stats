// scripts/diagnose-season-name-records.js
//
// READ-ONLY. Local only — NO API, NO network, NO writes. Counts player records
// whose `name` is actually a SEASON name (the parseProfileStats bug: the
// profile query has no player-name field, only seasonStatistics[].name = the
// season). Reports how many exist and — by reading each flagged record's
// player-file `updatedAt` — whether they are BACKFILL-era or PRE-BACKFILL
// (i.e. produced by the normal pipeline before this session's backfill).
//
// Cheap part: scan players/indexes/* to FLAG season-name records (fast).
// Provenance part: read ONLY the flagged records' player files for updatedAt
// (bounded by the number of bad records, not all ~370k files).
//
// Season-name detection = season-word + YEAR, bare year, or grade-token + year.
// A bare season word ("Winter Smith") is NOT flagged, to avoid eating real
// names. Heuristic — eyeball the examples to confirm it's clean.
//
// Usage:
//   node scripts/diagnose-season-name-records.js [--cutoff=2026-07-11] [--examples=20]

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const INDEX_DIR = path.join(ROOT, 'players', 'indexes');
const PLAYERS_DIR = path.join(ROOT, 'players');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const CUTOFF = new Date(ARGS.cutoff ? String(ARGS.cutoff) : '2026-07-11T00:00:00Z').getTime();
const MAX_EXAMPLES = ARGS.examples ? parseInt(ARGS.examples, 10) : 20;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

const YEAR = /(19|20)\d\d(\/\d\d)?/;
const SEASON_WORD = /\b(summer|winter|spring|autumn|fall|term|season)\b/i;
function isSeasonName(nm) {
  if (SEASON_WORD.test(nm) && YEAR.test(nm)) return true;
  if (/^(19|20)\d\d(\/\d\d)?$/.test(nm)) return true;
  if (/^(u\d+|under\s*\d+|div(ision)?\b|grade\b|round\b)/i.test(nm) && YEAR.test(nm)) return true;
  return false;
}

function playerShard(uuid)    { return uuid.slice(0, 2).toLowerCase(); }
function playerFilePath(uuid) { return path.join(PLAYERS_DIR, playerShard(uuid), `${uuid}.json`); }

console.log('diagnose-season-name-records.js  (READ-ONLY — no API, no network, no writes)');
console.log('─'.repeat(64));
console.log(`  Backfill-era cutoff: ${new Date(CUTOFF).toISOString()} (updatedAt >= cutoff ⇒ backfill-era)`);

let shardFiles = [];
try { shardFiles = fs.readdirSync(INDEX_DIR).filter(f => /^[0-9a-f]{2}\.json$/i.test(f)); }
catch (e) { console.error(`Cannot read ${INDEX_DIR}: ${e.message}`); process.exit(1); }

// Phase 1 (cheap): flag season-name records from the index.
const flagged = []; // { uuid, name }
let totalRecords = 0;
for (const f of shardFiles) {
  let idx;
  try { idx = readJson(path.join(INDEX_DIR, f)); } catch (_) { continue; }
  for (const [uuid, rec] of Object.entries(idx)) {
    totalRecords++;
    const nm = normName(rec && rec.name);
    if (nm && isSeasonName(nm)) flagged.push({ uuid, name: rec.name });
  }
}

console.log(`  Total indexed records        : ${totalRecords.toLocaleString()}`);
console.log(`  Season-name records (flagged): ${flagged.length.toLocaleString()}  (${totalRecords ? (flagged.length / totalRecords * 100).toFixed(2) : '0.00'}%)`);

// Phase 2 (bounded): read each flagged record's player file for provenance.
let backfillEra = 0, preBackfill = 0, noTimestamp = 0, fileMissing = 0;
let withApiId = 0, privateCount = 0, publicCount = 0;
const examples = [];

for (const { uuid, name } of flagged) {
  let rec;
  try { rec = readJson(playerFilePath(uuid)); } catch (_) { fileMissing++; continue; }
  const ts = rec.updatedAt ? new Date(rec.updatedAt).getTime() : NaN;
  if (Number.isNaN(ts)) noTimestamp++;
  else if (ts >= CUTOFF) backfillEra++;
  else preBackfill++;
  if (rec.apiId) withApiId++;
  if (rec.private === true) privateCount++; else publicCount++;
  if (examples.length < MAX_EXAMPLES) {
    examples.push({ uuid, name, updatedAt: rec.updatedAt || '(none)', private: rec.private === true, apiId: rec.apiId || null });
  }
}

console.log('');
console.log(`  Provenance (from player-file updatedAt):`);
console.log(`    backfill-era (>= cutoff)   : ${backfillEra.toLocaleString()}`);
console.log(`    pre-backfill (< cutoff)    : ${preBackfill.toLocaleString()}  <- produced by the normal pipeline, not this session's backfill`);
console.log(`    no/unparseable timestamp   : ${noTimestamp.toLocaleString()}`);
console.log(`    player file missing        : ${fileMissing.toLocaleString()}`);
console.log('');
console.log(`  Of flagged records:`);
console.log(`    private:true  : ${privateCount.toLocaleString()}`);
console.log(`    public        : ${publicCount.toLocaleString()}`);
console.log(`    have apiId    : ${withApiId.toLocaleString()}`);

console.log('\n  INTERPRETATION:');
console.log('    "backfill-era" = records this session\'s backfill wrote with a season name.');
console.log('    "pre-backfill" = the same bug reaching the data via the normal pipeline');
console.log('    (fetch-profile-stats/nightly-crawl) BEFORE the backfill — if this is >0,');
console.log('    the fix must extend beyond the backfill script. NOTE: a pre-existing record');
console.log('    re-touched by a nightly run after the cutoff would be counted as backfill-era,');
console.log('    so "pre-backfill" is a LOWER BOUND on pipeline-origin contamination.');

if (examples.length) {
  console.log('\n  examples:');
  for (const e of examples) {
    console.log(`    ${e.uuid}  name="${e.name}"  updatedAt=${e.updatedAt}  ${e.private ? 'private' : 'public'}${e.apiId ? '  apiId=' + e.apiId.slice(0, 13) : ''}`);
  }
}
console.log('\nDone (nothing was written).');
