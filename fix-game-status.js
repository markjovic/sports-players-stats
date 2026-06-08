#!/usr/bin/env node
// fix-game-status.js
/**
 * Sets st: 'FINAL' on all games in locked seasons that have no status field.
 *
 * Games added by the player crawl (publicProfileStatistics) don't have a
 * status field because that endpoint doesn't return game status. Since locked
 * seasons are completed, all their games are definitively FINAL.
 *
 * For active seasons (locked: false), we only mark games as FINAL if they
 * have a score (hs is a number) — unscored active games may still be UPCOMING.
 *
 * Safe to re-run — only modifies games where st is missing.
 *
 * Usage:
 *   node fix-game-status.js
 *   node fix-game-status.js --dry-run    (report only, no writes)
 *   node fix-game-status.js --tenant=bv
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ARGS    = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k,...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const TENANT  = ARGS.tenant  || 'bv';
const DRY_RUN = !!ARGS['dry-run'];

const GAMES_DIR  = path.join(__dirname, 'games', TENANT);
const INDEX_FILE = path.join(__dirname, 'sports-index.json');

console.log(`\n🔧 Fix Game Status`);
console.log(`   Tenant:  ${TENANT}`);
console.log(`   Mode:    ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}\n`);

const index   = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
const seasons = index.seasons || {};

let totalFixed = 0, totalSkipped = 0, totalFiles = 0;
let sinceLastCommit = 0;

const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
console.log(`Processing ${files.length.toLocaleString()} season game files...\n`);

for (const file of files) {
  const seasonId = file.replace('.json', '');
  const season   = seasons[seasonId];
  if (!season) continue;

  const isLocked = season.locked !== false;
  const gameFile = path.join(GAMES_DIR, file);

  let sg;
  try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); } catch (e) { continue; }

  const games = sg.games || {};
  let fileFixed = 0;

  for (const [gameId, game] of Object.entries(games)) {
    if (game.st) continue;  // already has status — skip

    if (isLocked) {
      // Locked season — all games are FINAL
      if (!DRY_RUN) game.st = 'FINAL';
      fileFixed++;
    } else {
      // Active season — only mark FINAL if has a score
      if (typeof game.hs === 'number') {
        if (!DRY_RUN) game.st = 'FINAL';
        fileFixed++;
      }
      // Unscored active games: leave st undefined — discover-fixtures will set UPCOMING
    }
  }

  if (fileFixed > 0) {
    totalFixed += fileFixed;
    totalFiles++;
    if (!DRY_RUN) {
      fs.writeFileSync(gameFile, JSON.stringify(sg));
      sinceLastCommit++;
    }
  } else {
    totalSkipped++;
  }

  if (!DRY_RUN && sinceLastCommit >= 100) {
    try {
      execSync('git add games/', { stdio: 'pipe', shell: true });
      const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
      if (diff) {
        execSync(`git commit -m "Fix game status: ${totalFixed.toLocaleString()} games set to FINAL"`, { stdio: 'pipe' });
        execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
        execSync('git push', { stdio: 'pipe' });
        console.log(`  💾 Committed ${totalFixed.toLocaleString()} fixes so far...`);
      }
    } catch (e) {
      console.warn(`  ⚠ Git error: ${e.message}`);
    }
    sinceLastCommit = 0;
  }

  if (totalFiles % 50 === 0) {
    process.stdout.write(`  ${totalFiles}/${files.length} files, ${totalFixed.toLocaleString()} fixed\r`);
  }
}

console.log(`\n✅ Done`);
console.log(`   Files modified:   ${totalFiles.toLocaleString()}`);
console.log(`   Games fixed:      ${totalFixed.toLocaleString()}`);
console.log(`   Files unchanged:  ${totalSkipped.toLocaleString()}`);

if (DRY_RUN) {
  console.log(`\n   (Dry run — no changes written)`);
} else if (totalFixed > 0) {
  try {
    execSync('git add games/', { stdio: 'pipe', shell: true });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (diff) {
      execSync(`git commit -m "Fix game status complete: ${totalFixed.toLocaleString()} games set to FINAL"`, { stdio: 'pipe' });
      execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log(`   ✓ Committed and pushed`);
    }
  } catch (e) {
    console.warn(`   ⚠ Final commit failed: ${e.message}`);
  }
}
