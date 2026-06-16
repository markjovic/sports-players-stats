// scripts/augment-game-grades.js
//
// Adds gid and gn (grade ID and grade name) to every game entry in games/bv/{sid}.json.
//
// Required addition per game entry:
//   { "gid": "gradeUuid", "gn": "U13 Boys C" }
//
// Strategy:
//   1. Load sports-index.json → sid → { grades[] }
//   2. Build tid→{gid, gn} map (same approach as augment-venue-lookup.js):
//      - Single-grade seasons: assign directly from grades[0]
//      - Multi-grade seasons: sample first roster player from team-stats,
//        read their detail file, extract regs[].gid/gn where tid+sid match
//   3. For each games/bv/{sid}.json:
//      - Single-grade season: assign that grade to all games directly (no tid lookup needed)
//      - Multi-grade season: resolve grade via h/a/t1/t2 tid lookup
//   4. Rewrite files in-place, skip already-augmented entries (gid present).
//
// Progress: committed every 100 season files.
// Run: node scripts/augment-game-grades.js
// Dry run: node scripts/augment-game-grades.js --dry-run

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT          = path.join(__dirname, '..');
const DRY_RUN       = process.argv.includes('--dry-run');
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.augment-game-grades-progress.json');
const COMMIT_INTERVAL = 100; // season files (each can be large)

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
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

// ─── step 1: load sports-index ──────────────────────────────────────────────

console.log('Loading sports-index.json...');
const sportsIndex = readJson(path.join(ROOT, 'sports-index.json'));
const sidMeta = {};
for (const [sid, s] of Object.entries(sportsIndex.seasons)) {
  sidMeta[sid] = { grades: s.grades || [] };
}
console.log(`  ${Object.keys(sidMeta).length} seasons loaded`);

// ─── step 2: build tid→{gid, gn} for multi-grade seasons ────────────────────

console.log('Building tid→grade map...');
const tidGrade = new Map(); // tid → { gid, gn }

const teamStatsDir = path.join(ROOT, 'team-stats', 'bv');
const tsFiles = fs.readdirSync(teamStatsDir).filter(f => f.endsWith('.json'));

let singleGradeAssigned = 0;
let sampleHit  = 0;
let sampleMiss = 0;

for (const fname of tsFiles) {
  const sid  = fname.replace('.json', '');
  const meta = sidMeta[sid];
  if (!meta) continue;

  let tsData;
  try { tsData = readJson(path.join(teamStatsDir, fname)); } catch { continue; }

  const isSingleGrade = meta.grades.length === 1;
  const singleGrade   = isSingleGrade ? meta.grades[0] : null;

  for (const [tid, team] of Object.entries(tsData)) {
    if (tidGrade.has(tid)) continue;

    if (isSingleGrade) {
      tidGrade.set(tid, { gid: singleGrade.id, gn: singleGrade.name });
      singleGradeAssigned++;
      continue;
    }

    const roster     = team.roster || {};
    const sampleUuid = Object.keys(roster)[0];
    if (!sampleUuid) { sampleMiss++; continue; }

    const prefix     = sampleUuid.slice(0, 2);
    const playerFile = path.join(ROOT, 'players', prefix, `${sampleUuid}.json`);
    let player;
    try { player = readJson(playerFile); } catch { sampleMiss++; continue; }

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

// ─── step 3: load progress ───────────────────────────────────────────────────

let doneSids = new Set();
if (fs.existsSync(PROGRESS_FILE)) {
  const raw = readJson(PROGRESS_FILE);
  doneSids = new Set(raw.done || []);
  console.log(`\nResuming — ${doneSids.size} season files already done`);
}

function saveProgress() {
  writeJson(PROGRESS_FILE, { done: [...doneSids] });
}

// ─── step 4: rewrite games files ─────────────────────────────────────────────

console.log('\nAugmenting games files...');
const gamesDir  = path.join(ROOT, 'games', 'bv');
const gameFiles = fs.readdirSync(gamesDir).filter(f => f.endsWith('.json')).sort();

let filesProcessed  = 0;
let filesSkipped    = 0;
let gamesAugmented  = 0;
let gamesMissing    = 0;
let sinceLastCommit = 0;

for (const fname of gameFiles) {
  const sid = fname.replace('.json', '');

  if (doneSids.has(sid)) {
    filesSkipped++;
    continue;
  }

  let gf;
  try { gf = readJson(path.join(gamesDir, fname)); } catch { continue; }

  const meta          = sidMeta[sid];
  const isSingleGrade = meta && meta.grades.length === 1;
  const singleGrade   = isSingleGrade ? meta.grades[0] : null;

  let modified = false;

  for (const [gameId, g] of Object.entries(gf.games || {})) {
    if (g.gid) continue; // already augmented

    let gradeEntry = null;

    if (isSingleGrade) {
      gradeEntry = singleGrade;
    } else {
      // try each team id in priority order: h, a, t1, t2
      for (const tid of [g.h, g.a, g.t1, g.t2]) {
        if (tid) {
          gradeEntry = tidGrade.get(tid) || null;
          if (gradeEntry) break;
        }
      }
    }

    if (gradeEntry) {
      g.gid = gradeEntry.id || gradeEntry.gid;
      g.gn  = gradeEntry.name || gradeEntry.gn;
      gamesAugmented++;
      modified = true;
    } else {
      gamesMissing++;
    }
  }

  if (modified && !DRY_RUN) {
    writeJson(path.join(gamesDir, fname), gf);
  }

  doneSids.add(sid);
  filesProcessed++;
  sinceLastCommit++;

  if (sinceLastCommit >= COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      saveProgress();
      gitCommit(
        `augment-game-grades: ${filesProcessed} season files done`,
        ['games/bv/', 'scripts/.augment-game-grades-progress.json']
      );
    }
    sinceLastCommit = 0;
    console.log(`  progress: ${filesProcessed} files, ${gamesAugmented} games augmented`);
  }
}

// final commit
if (!DRY_RUN && sinceLastCommit > 0) {
  saveProgress();
  gitCommit(
    `augment-game-grades: complete — ${filesProcessed} files, ${gamesAugmented} games`,
    ['games/bv/', 'scripts/.augment-game-grades-progress.json']
  );
}

console.log('\n─── Summary ────────────────────────────────────────────────');
console.log(`  Season files processed : ${filesProcessed}`);
console.log(`  Season files skipped   : ${filesSkipped} (already done)`);
console.log(`  Games augmented        : ${gamesAugmented}`);
console.log(`  Games missing grade    : ${gamesMissing}`);
console.log(`  Mode                   : ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
