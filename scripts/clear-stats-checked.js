// scripts/clear-stats-checked.js
//
// Clears statsChecked from every player file in a single pass.
// Runs as a pre-step before the sharded matrix when --force is used,
// so each shard sees all players as unprocessed without needing --force itself.
//
// Single writer — one commit, no contention.
//
// Run: node scripts/clear-stats-checked.js

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');

function gitCommit(message) {
  execSync('git add -A',                            { stdio: 'pipe', cwd: ROOT });
  const diff = execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim();
  if (!diff) { console.log('  Nothing to commit'); return; }
  execSync(`git commit -m "${message}"`,            { stdio: 'pipe', cwd: ROOT });
  execSync('git fetch origin main',                 { stdio: 'pipe', cwd: ROOT });
  execSync('git merge -X ours FETCH_HEAD --no-edit',{ stdio: 'pipe', cwd: ROOT });
  execSync('git push origin main',                  { stdio: 'pipe', cwd: ROOT });
  console.log(`  ✓ ${message}`);
}

async function main() {
  const start = Date.now();
  console.log('clear-stats-checked.js');
  console.log('─'.repeat(50));

  const prefixes = fs.readdirSync(PLAYERS_DIR)
    .filter(f => /^[0-9a-f]{2}$/.test(f))
    .sort();

  let cleared = 0, skipped = 0, total = 0;

  for (const prefix of prefixes) {
    const dir   = path.join(PLAYERS_DIR, prefix);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

    for (const fname of files) {
      total++;
      const fpath = path.join(dir, fname);
      let player;
      try { player = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
      catch (_) { skipped++; continue; }

      const bk = player.sports?.Basketball;
      if (!bk?.statsChecked) { skipped++; continue; }

      delete bk.statsChecked;
      fs.writeFileSync(fpath, JSON.stringify(player));
      cleared++;
    }

    if ((prefixes.indexOf(prefix) + 1) % 32 === 0) {
      process.stdout.write(`  ${prefix} — ${cleared} cleared so far\r`);
    }
  }

  console.log(`\n  ${total} files scanned`);
  console.log(`  ${cleared} statsChecked values cleared`);
  console.log(`  ${skipped} already clear or unreadable`);
  console.log('\n  Committing...');

  gitCommit(`clear-stats-checked: ${cleared} players cleared for matrix re-fetch`);

  console.log(`  Elapsed: ${Math.round((Date.now() - start) / 1000)}s`);
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
