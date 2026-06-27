// scripts/fix-corrupt-player-names.js
//
// Finds player files where the `name` field contains a season name string
// (e.g. "Winter 2022", "Summer 2022/23") — a data corruption from early crawl scripts.
//
// Action: clears the name field (sets to undefined/removes it) so the player
// appears as a private/unnamed profile rather than polluting leaderboards.
//
// Usage:
//   node scripts/fix-corrupt-player-names.js --dry-run            (count only)
//   node scripts/fix-corrupt-player-names.js --dry-run --verbose  (list all UUIDs)
//   node scripts/fix-corrupt-player-names.js                      (fix and commit)

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT       = path.join(__dirname, '..');
const PLAYERS    = path.join(ROOT, 'players');
const DRY_RUN    = process.argv.includes('--dry-run');
const VERBOSE    = process.argv.includes('--verbose');
const SEASON_RE  = /^(Winter|Summer|Spring|Autumn|Fall)\s+\d{4}/i;

function gitCommit(msg) {
  try {
    execSync('git add players/', { cwd: ROOT, stdio: 'pipe' });
    const staged = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!staged) { console.log('  Nothing staged.'); return; }
    execSync(`git commit -m "${msg}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git stash', { cwd: ROOT, stdio: 'pipe' });
    execSync('git fetch origin main', { cwd: ROOT, stdio: 'pipe' });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { cwd: ROOT, stdio: 'pipe' });
    execSync('git stash pop', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push origin main', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  Committed: ${msg}`);
  } catch (e) {
    console.error('  git error:', e.message);
  }
}

async function main() {
  console.log(`\nfix-corrupt-player-names.js${DRY_RUN ? ' [DRY RUN]' : ''}${VERBOSE ? ' [VERBOSE]' : ''}`);
  console.log('─'.repeat(60));

  const prefixes = fs.readdirSync(PLAYERS).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  let scanned = 0, fixed = 0;
  const corrupt = [];
  const byName = {};

  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS, prefix);
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      scanned++;
      const fpath = path.join(dir, fname);
      let player;
      try { player = JSON.parse(fs.readFileSync(fpath, 'utf8')); } catch { continue; }

      if (!player.name || !SEASON_RE.test(player.name)) continue;

      corrupt.push({ uuid: player.uuid, name: player.name });
      byName[player.name] = (byName[player.name] || 0) + 1;

      if (!DRY_RUN) {
        delete player.name;
        fs.writeFileSync(fpath, JSON.stringify(player), 'utf8');
        fixed++;
      }
    }
  }

  console.log(`\n  Scanned:  ${scanned.toLocaleString()}`);
  console.log(`  Corrupt:  ${corrupt.length.toLocaleString()}`);
  console.log(`\n  Breakdown by name:`);
  for (const [name, count] of Object.entries(byName).sort((a,b) => b[1]-a[1])) {
    console.log(`    ${String(count).padStart(6)}  "${name}"`);
  }

  if (VERBOSE) {
    console.log(`\n  All corrupt UUIDs:`);
    corrupt.forEach(({uuid, name}) => console.log(`    ${uuid}  "${name}"`));
  }

  if (!DRY_RUN) {
    console.log(`\n  Fixed:    ${fixed.toLocaleString()}`);
    if (fixed > 0) gitCommit(`fix-corrupt-player-names: cleared name field on ${fixed} players`);
  }
  console.log('\n' + '─'.repeat(60));
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
