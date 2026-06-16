// scripts/augment-team-index.js
//
// Adds comp and grade fields to every entry in team-index.json.
//
// Current: { "Autumn 2026": [{ "id": "tid", "n": "Team Name", "sid": "seasonId" }] }
// After:   { "Autumn 2026": [{ "id": "tid", "n": "Team Name", "sid": "seasonId", "comp": "VJBL", "grade": "Boys 13 D3" }] }
//
// Strategy (mirrors augment-venue-lookup.js):
//   1. Load sports-index.json → sid → { compName, grades[] }
//   2. Build tid→{gid, gn} map:
//      - Single-grade seasons: assign directly from grades[0]
//      - Multi-grade seasons: sample first roster player from team-stats,
//        read their detail file, extract regs[].gn where tid+sid match
//   3. Rewrite team-index.json with comp and grade on every entry.
//
// Run: node scripts/augment-team-index.js
// Dry run: node scripts/augment-team-index.js --dry-run

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
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
}

function gitCommit(message, files) {
  try {
    execSync(`git add ${files.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) { console.log('  nothing to commit'); return; }
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
  sidMeta[sid] = { compName: s.compName || '', grades: s.grades || [] };
}
console.log(`  ${Object.keys(sidMeta).length} seasons loaded`);

// ─── step 2: build tid→{gid, gn} ────────────────────────────────────────────

console.log('Building tid→grade map...');
const tidGrade = new Map();

const teamStatsDir = path.join(ROOT, 'team-stats', 'bv');
const tsFiles = fs.readdirSync(teamStatsDir).filter(f => f.endsWith('.json'));

let singleGradeAssigned = 0;
let sampleHit  = 0;
let sampleMiss = 0;

for (const fname of tsFiles) {
  const sid = fname.replace('.json', '');
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

    const roster = team.roster || {};
    const sampleUuid = Object.keys(roster)[0];
    if (!sampleUuid) { sampleMiss++; continue; }

    const prefix = sampleUuid.slice(0, 2);
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

// ─── step 3: rewrite team-index.json ────────────────────────────────────────

console.log('\nLoading team-index.json...');
const teamIndexPath = path.join(ROOT, 'team-index.json');
const teamIndex = readJson(teamIndexPath);

let totalEntries  = 0;
let augmented     = 0;
let missingComp   = 0;
let missingGrade  = 0;

for (const [seasonName, entries] of Object.entries(teamIndex)) {
  for (const entry of entries) {
    totalEntries++;

    const meta = sidMeta[entry.sid];
    entry.comp = meta ? meta.compName : '';
    if (!meta) missingComp++;

    const gradeEntry = tidGrade.get(entry.id);
    entry.grade = gradeEntry ? gradeEntry.gn : '';
    if (!gradeEntry) missingGrade++;

    augmented++;
  }
}

console.log(`  ${totalEntries} entries processed`);
console.log(`  ${augmented} augmented`);
console.log(`  ${missingComp} missing comp (sid not in sports-index)`);
console.log(`  ${missingGrade} missing grade (tid not in grade map)`);

if (!DRY_RUN) {
  writeJson(teamIndexPath, teamIndex);
  gitCommit('augment-team-index: add comp and grade per entry', ['team-index.json']);
}

console.log('\n─── Summary ────────────────────────────────────────────────');
console.log(`  Total entries : ${totalEntries}`);
console.log(`  Augmented     : ${augmented}`);
console.log(`  Missing comp  : ${missingComp}`);
console.log(`  Missing grade : ${missingGrade}`);
console.log(`  Mode          : ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
