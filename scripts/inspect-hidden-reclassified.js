// scripts/inspect-hidden-reclassified.js
//
// Finds games that were recently reclassified as hidden by checking git log.
// Shows the grade name, season, and game details for any game where
// hidden:true was added in the last N commits.
//
// Run: node scripts/inspect-hidden-reclassified.js

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT      = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games', 'bv');

// Find the commit that added the reclassification
const log = execSync(
  'git log --oneline --grep="reclassified as hidden" -5',
  { cwd: ROOT, stdio: 'pipe' }
).toString().trim();

if (!log) {
  console.log('No recent reclassification commits found.');
  process.exit(0);
}

console.log('Recent reclassification commits:');
console.log(log);
console.log();

// Get the most recent reclassification commit hash
const commitHash = log.split('\n')[0].split(' ')[0];
console.log(`Inspecting commit: ${commitHash}\n`);

// Get the diff for that commit — which files changed
const diff = execSync(
  `git show --name-only --format="" ${commitHash}`,
  { cwd: ROOT, stdio: 'pipe' }
).toString().trim();

const changedFiles = diff.split('\n').filter(f => f.startsWith('games/bv/'));
console.log(`Changed game files: ${changedFiles.length}`);
console.log();

// Load sports-index for season names
const sportsIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'sports-index.json'), 'utf8'));
const seasonNames = {};
const gradeNames  = {};
for (const season of Object.values(sportsIndex.seasons || {})) {
  seasonNames[season.id] = season.fullName || season.name;
  for (const grade of (season.grades || [])) {
    gradeNames[grade.id] = grade.name;
  }
}

// For each changed file, find games with hidden:true that weren't there before
let totalFound = 0;
for (const filePath of changedFiles) {
  const sid = path.basename(filePath, '.json');

  // Get the before/after versions of this file
  let before, after;
  try {
    const beforeRaw = execSync(
      `git show ${commitHash}^:${filePath}`,
      { cwd: ROOT, stdio: 'pipe' }
    ).toString();
    before = JSON.parse(beforeRaw);
  } catch (_) {
    before = { games: {} };
  }
  try {
    const afterRaw = execSync(
      `git show ${commitHash}:${filePath}`,
      { cwd: ROOT, stdio: 'pipe' }
    ).toString();
    after = JSON.parse(afterRaw);
  } catch (_) { continue; }

  // Find games that gained hidden:true
  const reclassified = [];
  for (const [gameId, game] of Object.entries(after.games || {})) {
    if (!game.hidden) continue;
    const wasHidden = before.games?.[gameId]?.hidden;
    if (wasHidden) continue;  // was already hidden
    reclassified.push({ gameId, game });
  }

  if (reclassified.length === 0) continue;

  const seasonName = seasonNames[sid] || sid;
  console.log(`\n── ${seasonName} (${sid}) — ${reclassified.length} games ─────────`);

  // Group by grade
  const byGrade = {};
  for (const { gameId, game } of reclassified) {
    const gid = game.gid || 'unknown';
    if (!byGrade[gid]) byGrade[gid] = [];
    byGrade[gid].push({ gameId, game });
  }

  for (const [gid, games] of Object.entries(byGrade)) {
    const gradeName = gradeNames[gid] || game.gn || gid;
    console.log(`  Grade: ${gradeName} (${gid})`);
    for (const { gameId, game } of games) {
      const date  = game.d  || '?';
      const rn    = game.rn || '?';
      const home  = game.hn || game.t1n || '?';
      const away  = game.an || game.t2n || '?';
      console.log(`    ${gameId}  ${date}  ${rn}  ${home} vs ${away}`);
    }
    totalFound += games.length;
  }
}

console.log(`\n── Total reclassified games found: ${totalFound} ─────────────`);
