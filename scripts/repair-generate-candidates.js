// scripts/repair-generate-candidates.js
//
// READ-ONLY (writes only bucket files to an output dir). Scans players/indexes
// for records whose `name` is a KNOWN season name (from data/sports-index.json)
// — the parseProfileStats contamination — and buckets those uuids by 2-char
// prefix for the repair matrix. Fast: only reads index shards + sports-index,
// NOT games/bv.
//
// Usage:
//   node scripts/repair-generate-candidates.js [--out=/tmp/repair]
// Writes: {out}/{XX}.json (array of uuids) for each non-empty bucket,
//         {out}/_buckets.json (array of bucket names), and GITHUB_OUTPUT.

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const INDEX_DIR = path.join(ROOT, 'players', 'indexes');
const SPORT_INDEX_FILE = path.join(ROOT, 'data', 'sports-index.json');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const OUT = ARGS.out || '/tmp/repair';

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

console.log('repair-generate-candidates.js');
console.log('─'.repeat(60));

let sportIndex = {};
try { sportIndex = readJson(SPORT_INDEX_FILE); }
catch (e) { console.error(`Cannot read ${SPORT_INDEX_FILE}: ${e.message}`); process.exit(1); }
const knownSeasonNames = new Set();
for (const sid of Object.keys(sportIndex.seasons || {})) {
  const nm = normName(sportIndex.seasons[sid] && sportIndex.seasons[sid].name);
  if (nm) knownSeasonNames.add(nm);
}
if (!knownSeasonNames.size) { console.error('No known season names — aborting.'); process.exit(1); }

fs.mkdirSync(OUT, { recursive: true });

let shardFiles = [];
try { shardFiles = fs.readdirSync(INDEX_DIR).filter(f => /^[0-9a-f]{2}\.json$/i.test(f)); }
catch (e) { console.error(`Cannot read ${INDEX_DIR}: ${e.message}`); process.exit(1); }

const buckets = new Map(); // prefix -> [uuid]
let total = 0;
for (const f of shardFiles) {
  let idx; try { idx = readJson(path.join(INDEX_DIR, f)); } catch (_) { continue; }
  for (const [uuid, rec] of Object.entries(idx)) {
    if (!rec || !knownSeasonNames.has(normName(rec.name))) continue;
    const pfx = uuid.slice(0, 2).toLowerCase();
    if (!buckets.has(pfx)) buckets.set(pfx, []);
    buckets.get(pfx).push(uuid);
    total++;
  }
}

const bucketNames = [];
for (const [pfx, uuids] of buckets) {
  fs.writeFileSync(path.join(OUT, `${pfx}.json`), JSON.stringify(uuids));
  bucketNames.push(pfx);
}
bucketNames.sort();
fs.writeFileSync(path.join(OUT, '_buckets.json'), JSON.stringify(bucketNames));

console.log(`  Known season names       : ${knownSeasonNames.size}`);
console.log(`  Contaminated records     : ${total}`);
console.log(`  Non-empty buckets        : ${bucketNames.length}`);
console.log(`  Wrote bucket files + _buckets.json to ${OUT}`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `buckets=${JSON.stringify(bucketNames)}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `remaining=${total}\n`);
}
console.log('Done.');
console.log(`Remaining contaminated after this run: ${total}`);
