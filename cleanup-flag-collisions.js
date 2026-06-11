#!/usr/bin/env node
// cleanup-flag-collisions.js
'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const TENANT    = process.argv[2] || 'bv';
const GAMES_DIR = path.join(__dirname, 'games', TENANT);

console.log('\n🧹 Cleanup Flag Collisions');
console.log('─'.repeat(50));
console.log(`  Tenant: ${TENANT}`);
console.log(`  Removing legacy:true from games that also have a`);
console.log(`  definitive classification (hidden/profileOnly/`);
console.log(`  cancelled/abandoned/forfeit/bye)\n`);

if (!fs.existsSync(GAMES_DIR)) {
  console.error(`❌ ${GAMES_DIR} not found`);
  process.exit(1);
}

const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
let totalFixed = 0, filesFixed = 0, processed = 0;

// Superseding flags — any of these + legacy = legacy should be removed
const SUPERSEDES_LEGACY = ['hidden', 'profileOnly', 'cancelled', 'abandoned', 'forfeit', 'bye'];

for (const file of files) {
  const filePath = path.join(GAMES_DIR, file);
  let sg;
  try { sg = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { continue; }

  let dirty = false;
  for (const [gameId, game] of Object.entries(sg.games || {})) {
    if (!game.legacy) continue;
    if (SUPERSEDES_LEGACY.some(flag => game[flag])) {
      delete game.legacy;
      totalFixed++;
      dirty = true;
    }
  }

  if (dirty) {
    fs.writeFileSync(filePath, JSON.stringify(sg));
    filesFixed++;
  }

  processed++;
  if (processed % 200 === 0) {
    process.stdout.write(`  Processed ${processed}/${files.length} — fixed ${totalFixed} games\r`);
  }
}

console.log(`\n  Season files scanned:  ${files.length.toLocaleString()}`);
console.log(`  Season files modified: ${filesFixed.toLocaleString()}`);
console.log(`  Games fixed:           ${totalFixed.toLocaleString()}`);

if (totalFixed > 0) {
  try {
    execSync(`git add games/`, { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (diff) {
      execSync(`git commit -m "cleanup: remove erroneous legacy flag from ${totalFixed} hidden/profileOnly/cancelled/abandoned/forfeit/bye games"`, { stdio: 'pipe' });
      execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log('  ✓ Committed and pushed');
    }
  } catch (e) {
    console.warn(`  ⚠ Git: ${e.message}`);
  }
} else {
  console.log('  ✓ No collisions found — data is clean');
}

console.log('\n  Done.\n');
