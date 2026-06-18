// scripts/cleanup-empty-cats.js
//
// Removes leaderboard categories that have no data because the underlying
// stat types are not returned by publicProfileStatistics (isDisplayable:false).
//
// Removes from leaderboard/all-time.json and all leaderboard/season/{sid}.json:
//   bestPlayer, personalFouls, technicalFouls, unsFouls, disFouls, benchFouls
//
// Also removes those CATS from build-leaderboards.js so future runs don't
// produce empty entries for them.
//
// Run: node scripts/cleanup-empty-cats.js

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const EMPTY_CATS = ['bestPlayer','personalFouls','technicalFouls','unsFouls','disFouls','benchFouls'];

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

function gitCommit(message, dirs) {
  try {
    execSync(`git add ${dirs.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ ${message}`);
  } catch (e) {
    console.error(`  ✗ git: ${e.message.split('\n')[0]}`);
  }
}

// ─── 1. Patch build-leaderboards.js ──────────────────────────────────────────
console.log('── Patching build-leaderboards.js ──────────────────────────────────');
const lbPath = path.join(ROOT, 'scripts', 'build-leaderboards.js');
let lb = fs.readFileSync(lbPath, 'utf8');

const oldCats = "'bestPlayer', 'personalFouls', 'technicalFouls', 'unsFouls', 'disFouls', 'benchFouls'";
if (lb.includes(oldCats)) {
  lb = lb.replace(`, ${oldCats}`, '');
  // Remove computed vars
  for (const [old, ] of [
    [`      const bestPlayer      = reg.stats?.bestPlayer     ?? 0;\n`, ''],
    [`      const personalFouls   = reg.stats?.personalFouls  ?? 0;\n`, ''],
    [`      const technicalFouls  = reg.stats?.technicalFouls ?? 0;\n`, ''],
    [`      const unsFouls        = reg.stats?.unsFouls       ?? 0;\n`, ''],
    [`      const disFouls        = reg.stats?.disFouls       ?? 0;\n`, ''],
    [`      const benchFouls      = reg.stats?.benchFouls     ?? 0;\n`, ''],
    [`        bestPlayer,\n`, ''],
    [`        personalFouls,\n`, ''],
    [`        technicalFouls,\n`, ''],
    [`        unsFouls,\n`, ''],
    [`        disFouls,\n`, ''],
    [`        benchFouls,\n`, ''],
    [`  if (bestPlayer    > 0) buckets.bestPlayer  .push({ ...base, v: bestPlayer });\n`, ''],
    [`  if (personalFouls > 0) buckets.personalFouls.push({ ...base, v: personalFouls });\n`, ''],
    [`  if (technicalFouls > 0) buckets.technicalFouls.push({ ...base, v: technicalFouls });\n`, ''],
    [`  if (unsFouls      > 0) buckets.unsFouls    .push({ ...base, v: unsFouls });\n`, ''],
    [`  if (disFouls      > 0) buckets.disFouls    .push({ ...base, v: disFouls });\n`, ''],
    [`  if (benchFouls    > 0) buckets.benchFouls  .push({ ...base, v: benchFouls });\n`, ''],
    [`      if (bestPlayer    > 0) buckets.bestPlayer  .push({ ...base, v: bestPlayer });\n`, ''],
    [`      if (personalFouls > 0) buckets.personalFouls.push({ ...base, v: personalFouls });\n`, ''],
    [`      if (technicalFouls > 0) buckets.technicalFouls.push({ ...base, v: technicalFouls });\n`, ''],
    [`      if (unsFouls      > 0) buckets.unsFouls    .push({ ...base, v: unsFouls });\n`, ''],
    [`      if (disFouls      > 0) buckets.disFouls    .push({ ...base, v: disFouls });\n`, ''],
    [`      if (benchFouls    > 0) buckets.benchFouls  .push({ ...base, v: benchFouls });\n`, ''],
    // allTime career vars
    [`  const careerBestPlayer      = bball.bestPlayer       ?? 0;\n`, ''],
    [`  const careerPersonalFouls   = bball.personalFouls    ?? 0;\n`, ''],
    [`  const careerTechFouls       = bball.technicalFouls   ?? 0;\n`, ''],
    [`  const careerUnsFouls        = bball.unsFouls         ?? 0;\n`, ''],
    [`  const careerDisFouls        = bball.disFouls         ?? 0;\n`, ''],
    [`  const careerBenchFouls      = bball.benchFouls       ?? 0;\n`, ''],
    [`    bestPlayer: careerBestPlayer, personalFouls: careerPersonalFouls,\n`, ''],
    [`    technicalFouls: careerTechFouls, unsFouls: careerUnsFouls,\n`, ''],
    [`    disFouls: careerDisFouls, benchFouls: careerBenchFouls };`, '};'],
    [`  if (careerBestPlayer      > 0) buckets.bestPlayer     .push({ ...base, v: careerBestPlayer });\n`, ''],
    [`  if (careerPersonalFouls   > 0) buckets.personalFouls  .push({ ...base, v: careerPersonalFouls });\n`, ''],
    [`  if (careerTechFouls       > 0) buckets.technicalFouls .push({ ...base, v: careerTechFouls });\n`, ''],
    [`  if (careerUnsFouls        > 0) buckets.unsFouls       .push({ ...base, v: careerUnsFouls });\n`, ''],
    [`  if (careerDisFouls        > 0) buckets.disFouls       .push({ ...base, v: careerDisFouls });\n`, ''],
    [`  if (careerBenchFouls      > 0) buckets.benchFouls     .push({ ...base, v: careerBenchFouls });\n`, ''],
  ]) {
    lb = lb.replaceAll(old, '');
  }
  fs.writeFileSync(lbPath, lb, 'utf8');
  console.log('  build-leaderboards.js patched');
} else {
  console.log('  build-leaderboards.js already clean');
}

// ─── 2. Clean leaderboard output files ───────────────────────────────────────
console.log('\n── Cleaning leaderboard output files ───────────────────────────────');

const lbDir = path.join(ROOT, 'leaderboard');
let filesPatched = 0;

// all-time.json
const allTimePath = path.join(lbDir, 'all-time.json');
if (fs.existsSync(allTimePath)) {
  const data = readJson(allTimePath);
  let modified = false;
  for (const cat of EMPTY_CATS) {
    if (cat in data) { delete data[cat]; modified = true; }
  }
  if (modified) { writeJson(allTimePath, data); filesPatched++; }
}

// season files
const seasonDir = path.join(lbDir, 'season');
if (fs.existsSync(seasonDir)) {
  for (const fname of fs.readdirSync(seasonDir).filter(f => f.endsWith('.json'))) {
    const fpath = path.join(seasonDir, fname);
    let data;
    try { data = readJson(fpath); } catch { continue; }
    let modified = false;
    for (const cat of EMPTY_CATS) {
      if (cat in data) { delete data[cat]; modified = true; }
    }
    if (modified) { writeJson(fpath, data); filesPatched++; }
  }
}

console.log(`  ${filesPatched} leaderboard files cleaned`);

// ─── 3. Commit ────────────────────────────────────────────────────────────────
gitCommit(
  `cleanup-empty-cats: remove 6 non-displayable stat categories`,
  ['scripts/build-leaderboards.js', 'leaderboard/']
);

console.log('\nDone. build-leaderboards.js and all leaderboard files cleaned.');
