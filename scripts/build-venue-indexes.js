// scripts/build-venue-indexes.js
//
// Generates three new index files from the venue-lookup directory structure:
//
//   1. venue-lookup/{vid}/dates.json
//      Array of YYYY-MM-DD strings for every date with at least one game at this venue.
//
//   2. date-venue-index/{YYYY-MM-DD}.json
//      Array of venue IDs active on that date (at least one game).
//
//   3. season-venue-index.json
//      { seasonId: [venueId, ...] } — venues used in each season.
//      Derived from games/bv/{sid}.json (vid field on game entries).
//
// Run: node scripts/build-venue-indexes.js
// Dry run: node scripts/build-venue-indexes.js --dry-run

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
}

function gitCommit(message, dirs) {
  try {
    execSync(`git add ${dirs.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ committed: ${message}`);
  } catch (e) {
    console.error(`  ✗ git error: ${e.message}`);
  }
}

// ─── part 1 & 2: scan venue-lookup directory ────────────────────────────────
// Build:  vid → Set<date>   (for dates.json per venue)
//         date → Set<vid>   (for date-venue-index)

console.log('Scanning venue-lookup/ directory...');
const venueLookupDir = path.join(ROOT, 'venue-lookup');

// vid → sorted date array
const venueDates = new Map();
// date → Set of vids
const dateVenues = new Map();

const venueIds = fs.readdirSync(venueLookupDir).filter(name => {
  return fs.statSync(path.join(venueLookupDir, name)).isDirectory();
});

let totalDateFiles = 0;

for (const vid of venueIds) {
  const venueDir = path.join(venueLookupDir, vid);
  const dateFiles = fs.readdirSync(venueDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)); // YYYY-MM-DD.json only

  const dates = dateFiles.map(f => f.replace('.json', '')).sort();
  totalDateFiles += dates.length;

  if (dates.length > 0) {
    venueDates.set(vid, dates);
    for (const d of dates) {
      if (!dateVenues.has(d)) dateVenues.set(d, new Set());
      dateVenues.get(d).add(vid);
    }
  }
}

console.log(`  ${venueIds.length} venues, ${totalDateFiles} date files`);
console.log(`  ${dateVenues.size} distinct dates`);

// ─── write venue dates.json files ───────────────────────────────────────────

console.log('\nWriting venue-lookup/{vid}/dates.json...');
let venueIndexCount = 0;

for (const [vid, dates] of venueDates) {
  const outPath = path.join(venueLookupDir, vid, 'dates.json');
  if (!DRY_RUN) writeJson(outPath, dates);
  venueIndexCount++;
}

console.log(`  ${venueIndexCount} dates.json files written`);

// ─── write date-venue-index files ───────────────────────────────────────────

console.log('\nWriting date-venue-index/{date}.json...');
const dateVenueDir = path.join(ROOT, 'date-venue-index');
if (!DRY_RUN) fs.mkdirSync(dateVenueDir, { recursive: true });

let dateIndexCount = 0;

for (const [date, vids] of dateVenues) {
  const sorted = [...vids].sort();
  const outPath = path.join(dateVenueDir, `${date}.json`);
  if (!DRY_RUN) writeJson(outPath, sorted);
  dateIndexCount++;
}

console.log(`  ${dateIndexCount} date-venue-index files written`);

// ─── part 3: season-venue-index from games files ────────────────────────────

console.log('\nBuilding season-venue-index from games/bv/...');
const gamesDir = path.join(ROOT, 'games', 'bv');
const gameFiles = fs.readdirSync(gamesDir).filter(f => f.endsWith('.json'));

// sid → Set<vid>
const seasonVenues = new Map();

for (const fname of gameFiles) {
  const sid = fname.replace('.json', '');
  let gf;
  try { gf = readJson(path.join(gamesDir, fname)); } catch { continue; }

  const vids = new Set();
  for (const g of Object.values(gf.games || {})) {
    if (g.vid) vids.add(g.vid);
  }
  if (vids.size > 0) {
    seasonVenues.set(sid, vids);
  }
}

// serialise: { sid: [vid, ...] } sorted
const seasonVenueIndex = {};
for (const [sid, vids] of [...seasonVenues].sort(([a], [b]) => a.localeCompare(b))) {
  seasonVenueIndex[sid] = [...vids].sort();
}

const svPath = path.join(ROOT, 'data', 'season-venue-index.json');
if (!DRY_RUN) writeJson(svPath, seasonVenueIndex);
console.log(`  ${Object.keys(seasonVenueIndex).length} seasons in season-venue-index.json`);

// ─── commit ─────────────────────────────────────────────────────────────────

if (!DRY_RUN) {
  gitCommit(
    `build-venue-indexes: dates.json per venue, date-venue-index, season-venue-index`,
    ['venue-lookup/', 'date-venue-index/', 'data/season-venue-index.json']
  );
}

// ─── summary ────────────────────────────────────────────────────────────────

console.log('\n─── Summary ────────────────────────────────────────────────');
console.log(`  venue dates.json files   : ${venueIndexCount}`);
console.log(`  date-venue-index files   : ${dateIndexCount}`);
console.log(`  season-venue-index.json  : ${Object.keys(seasonVenueIndex).length} seasons`);
console.log(`  Mode                     : ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
