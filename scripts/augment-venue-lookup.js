// scripts/augment-venue-lookup.js
//
// Adds sid, hid, aid, comp, grade to every game entry in venue-lookup/{vid}/{date}.json.
//
// Strategy:
//   1. Load sports-index.json → build sid→{compName, grades[]} map
//   2. Scan games/bv/{sid}.json → build gameId→{sid, hid, aid} map
//      (hid = h field, aid = a field; falls back to t1/t2 for hidden games)
//   3. Build tid→grade map by sampling one player per team from team-stats rosters
//      → reads players/{xx}/{uuid}.json for first roster member, extracts regs[].gn where tid matches
//      For single-grade seasons, skip the sample — assign that grade directly.
//   4. Rewrite every venue-lookup/{vid}/{date}.json adding the new fields.
//
// Progress: committed every 500 venue files.
// Run: node scripts/augment-venue-lookup.js
// Dry run: node scripts/augment-venue-lookup.js --dry-run

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT     = path.join(__dirname, '..');
const DRY_RUN  = process.argv.includes('--dry-run');
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.augment-venue-progress.json');
const COMMIT_INTERVAL = 1000;

// ─── helpers ────────────────────────────────────────────────────────────────

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
}

function gitCommit(message, dirs) {
  try {
    execSync('git add -A', { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git fetch origin main', { cwd: ROOT, stdio: 'pipe' });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push origin main', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ committed: ${message}`);
  } catch (e) {
    console.error(`  ✗ git error: ${e.message}`);
  }
}

// ─── step 1: load sports-index ──────────────────────────────────────────────

console.log('Loading sports-index.json...');
const sportsIndex = readJson(path.join(ROOT, 'sports-index.json'));
const seasons = sportsIndex.seasons; // { sid: { compName, grades: [{id,name}], ... } }

// sid → { compName, grades: [{id, name}] }
const sidMeta = {};
for (const [sid, s] of Object.entries(seasons)) {
  sidMeta[sid] = { compName: s.compName || '', grades: s.grades || [] };
}
console.log(`  ${Object.keys(sidMeta).length} seasons loaded`);

// ─── step 2: build gameId→{sid, hid, aid} from all games files ──────────────

console.log('Scanning games/bv/ to build game metadata map...');
const gamesDir = path.join(ROOT, 'games', 'bv');
const gameMap  = new Map(); // gameId → { sid, hid, aid }

const gameFiles = fs.readdirSync(gamesDir).filter(f => f.endsWith('.json'));
for (const fname of gameFiles) {
  const sid = fname.replace('.json', '');
  let gf;
  try { gf = readJson(path.join(gamesDir, fname)); } catch { continue; }
  const games = gf.games || {};
  for (const [gid, g] of Object.entries(games)) {
    // home/away IDs: prefer h/a (absolute), fall back to t1/t2 (hidden)
    const hid = g.h || g.t1 || null;
    const aid = g.a || g.t2 || null;
    gameMap.set(gid, { sid, hid, aid });
  }
}
console.log(`  ${gameMap.size} games indexed`);

// ─── step 3: build tid→{gn} (grade name) map ────────────────────────────────
//
// Approach:
//   - For single-grade seasons: every team in that season → that grade.
//   - For multi-grade seasons: sample first roster player per team, read their
//     detail file, find the reg where tid + sid match, extract gn.
//   - tid keys are globally unique per season (same tid won't appear in two
//     seasons), so the map key is just tid.

console.log('Building tid→grade map...');
const tidGrade = new Map(); // tid → { gid, gn }

const teamStatsDir = path.join(ROOT, 'team-stats', 'bv');
const tsFiles = fs.readdirSync(teamStatsDir).filter(f => f.endsWith('.json'));

let singleGradeAssigned = 0;
let samplingRequired    = 0;
let sampleHit           = 0;
let sampleMiss          = 0;

for (const fname of tsFiles) {
  const sid = fname.replace('.json', '');
  const meta = sidMeta[sid];
  if (!meta) continue;

  let tsData;
  try { tsData = readJson(path.join(teamStatsDir, fname)); } catch { continue; }

  const isSingleGrade = meta.grades.length === 1;
  const singleGrade   = isSingleGrade ? meta.grades[0] : null;

  for (const [tid, team] of Object.entries(tsData)) {
    if (tidGrade.has(tid)) continue; // already resolved

    if (isSingleGrade) {
      tidGrade.set(tid, { gid: singleGrade.id, gn: singleGrade.name });
      singleGradeAssigned++;
      continue;
    }

    // Multi-grade season: sample first roster player
    samplingRequired++;
    const roster = team.roster || {};
    const sampleUuid = Object.keys(roster)[0];
    if (!sampleUuid) { sampleMiss++; continue; }

    const prefix = sampleUuid.slice(0, 2);
    const playerFile = path.join(ROOT, 'players', prefix, `${sampleUuid}.json`);
    let player;
    try { player = readJson(playerFile); } catch { sampleMiss++; continue; }

    // Find the reg where tid and sid match
    let found = false;
    for (const season of (player.seasons || [])) {
      if (season.sid !== sid) continue;
      for (const reg of (season.regs || [])) {
        if (reg.tid === tid && reg.gid && reg.gn) {
          tidGrade.set(tid, { gid: reg.gid, gn: reg.gn });
          sampleHit++;
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) sampleMiss++;
  }
}

console.log(`  tid→grade: ${tidGrade.size} entries`);
console.log(`  single-grade assigned: ${singleGradeAssigned}`);
console.log(`  sampling: ${sampleHit} hit, ${sampleMiss} miss`);

// ─── step 4: rewrite venue-lookup files ─────────────────────────────────────

console.log('\nAugmenting venue-lookup files...');
const venueLookupDir = path.join(ROOT, 'venue-lookup');

// load progress
let progress = { done: new Set() };
if (fs.existsSync(PROGRESS_FILE)) {
  const raw = readJson(PROGRESS_FILE);
  progress.done = new Set(raw.done || []);
  console.log(`  Resuming — ${progress.done.size} files already done`);
}

function saveProgress() {
  writeJson(PROGRESS_FILE, { done: [...progress.done] });
}

const venueIds = fs.readdirSync(venueLookupDir).filter(name => {
  return fs.statSync(path.join(venueLookupDir, name)).isDirectory();
});

let filesProcessed = 0;
let filesSkipped   = 0;
let gamesAugmented = 0;
let gamesMissing   = 0;
let sinceLastCommit = 0;

for (const vid of venueIds) {
  const venueDir = path.join(venueLookupDir, vid);
  const dateFiles = fs.readdirSync(venueDir)
    .filter(f => f.endsWith('.json') && f !== 'dates.json');

  for (const dateFile of dateFiles) {
    const filePath = path.join(venueDir, dateFile);
    const relKey   = `${vid}/${dateFile}`;

    if (progress.done.has(relKey)) {
      filesSkipped++;
      continue;
    }

    let grid;
    try { grid = readJson(filePath); } catch { continue; }

    let modified = false;

    for (const [court, games] of Object.entries(grid)) {
      if (!Array.isArray(games)) continue;
      for (const entry of games) {
        if (entry.sid) continue; // already augmented

        const meta = gameMap.get(entry.id);
        if (!meta) { gamesMissing++; continue; }

        const { sid, hid, aid } = meta;
        entry.hid = hid || undefined;
        entry.aid = aid || undefined;
        entry.sid = sid;

        // comp name from sports-index
        const seasonMeta = sidMeta[sid];
        entry.comp  = seasonMeta ? (seasonMeta.compName || '') : '';

        // grade: try hid first, then aid
        let gradeEntry = null;
        if (hid) gradeEntry = tidGrade.get(hid) || null;
        if (!gradeEntry && aid) gradeEntry = tidGrade.get(aid) || null;
        entry.grade = gradeEntry ? gradeEntry.gn : '';

        // clean up undefined fields
        if (entry.hid === undefined) delete entry.hid;
        if (entry.aid === undefined) delete entry.aid;

        gamesAugmented++;
        modified = true;
      }
    }

    if (modified && !DRY_RUN) {
      writeJson(filePath, grid);
    }

    progress.done.add(relKey);
    filesProcessed++;
    sinceLastCommit++;

    if (sinceLastCommit >= COMMIT_INTERVAL) {
      if (!DRY_RUN) {
        saveProgress();
        gitCommit(
          `augment-venue-lookup: ${filesProcessed} files done`,
          ['venue-lookup/', 'scripts/.augment-venue-progress.json']
        );
      }
      sinceLastCommit = 0;
      console.log(`  progress: ${filesProcessed} files, ${gamesAugmented} games augmented`);
    }
  }
}

// final commit
if (!DRY_RUN && sinceLastCommit > 0) {
  saveProgress();
  gitCommit(
    `augment-venue-lookup: complete — ${filesProcessed} files, ${gamesAugmented} games`,
    ['venue-lookup/', 'scripts/.augment-venue-progress.json']
  );
}

console.log('\n─── Summary ───────────────────────────────────────────────');
console.log(`  Venue files processed : ${filesProcessed}`);
console.log(`  Venue files skipped   : ${filesSkipped} (already done)`);
console.log(`  Games augmented       : ${gamesAugmented}`);
console.log(`  Games missing from map: ${gamesMissing}`);
console.log(`  Mode                  : ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
