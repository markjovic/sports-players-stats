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

const changedFiles = diff.split('\n').map(f => f.trim()).filter(f => f.startsWith('games/bv/'));
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
      { cwd: ROOT, stdio: 'pipe', maxBuffer: 500 * 1024 * 1024 }
    ).toString();
    before = JSON.parse(beforeRaw);
  } catch (e) {
    console.log(`  [before] read failed: ${e.message.slice(0, 80)}`);
    before = { games: {} };
  }
  try {
    const afterRaw = execSync(
      `git show ${commitHash}:${filePath}`,
      { cwd: ROOT, stdio: 'pipe', maxBuffer: 500 * 1024 * 1024 }
    ).toString();
    after = JSON.parse(afterRaw);
  } catch (e) {
    console.log(`  [after] read failed: ${e.message.slice(0, 80)}`);
    continue;
  }

  // Find games that gained hidden:true
  const reclassified = [];
  const afterGames  = after.games  || after  || {};  // handle both { games: {} } and flat
  const beforeGames = before.games || before || {};

  // Debug: sample the structure
  const afterKeys   = Object.keys(afterGames).slice(0, 2);
  if (afterKeys.length > 0) {
    const sample = afterGames[afterKeys[0]];
    console.log(`  Structure check: hidden=${sample.hidden}, keys=${Object.keys(sample).slice(0,6).join(',')}`);
  } else {
    console.log(`  WARNING: afterGames empty — top-level keys: ${Object.keys(after).join(',')}`);
  }

  for (const [gameId, game] of Object.entries(afterGames)) {
    if (!game.hidden) continue;
    const wasHidden = beforeGames[gameId]?.hidden;
    if (wasHidden) continue;
    reclassified.push({ gameId, game });
  }

  if (reclassified.length === 0) continue;

  const seasonName = seasonNames[sid] || sid;
  console.log(`\nProcessing: ${filePath} (${seasonName})`);
  console.log(`  Before read: ${Object.keys(before.games || before || {}).length} games`);
  console.log(`  After read:  ${Object.keys(after.games  || after  || {}).length} games`);
  console.log(`\n── ${seasonName} (${sid}) — ${reclassified.length} games ─────────`);

  // Group by grade
  const byGrade = {};
  for (const { gameId, game } of reclassified) {
    const gid = game.gid || 'unknown';
    if (!byGrade[gid]) byGrade[gid] = [];
    byGrade[gid].push({ gameId, game });
  }

  for (const [gid, games] of Object.entries(byGrade)) {
    console.log(`  Grade: ${gradeName} (gid=${gid})`);
      for (const { gameId, game } of games) {
        const date  = game.d  || '?';
        const rn    = game.rn || '?';
        const home  = game.hn || game.t1n || '?';
        const away  = game.an || game.t2n || '?';
        console.log(`    gameId=${gameId}  date=${date}  rn=${rn}  ${home} vs ${away}`);
      }
    totalFound += games.length;
  }
}

console.log(`\n── Total reclassified games found: ${totalFound} ─────────────`);
