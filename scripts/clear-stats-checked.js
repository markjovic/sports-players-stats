// scripts/clear-stats-checked.js
//
// Clears statsChecked from player files so the matrix re-fetches them.
//
// Modes:
//   node scripts/clear-stats-checked.js                — clears ALL players (force run)
//   node scripts/clear-stats-checked.js --nameless-only — clears only players with no name
//
// --nameless-only: used after fix-corrupt-player-names to queue only the
// affected players for a targeted matrix re-fetch, without forcing a full reset.

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT         = path.join(__dirname, '..');
const PLAYERS_DIR  = path.join(ROOT, 'players');
const NAMELESS_ONLY = process.argv.includes('--nameless-only');

function gitCommit(message) {
  execSync('git add -A', { stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
  // --quiet exits 0 if no staged changes, 1 if there are — produces no output
  try {
    execSync('git diff --staged --quiet', { stdio: 'pipe', cwd: ROOT });
    console.log('  Nothing to commit'); return; // exit 0 = no changes
  } catch (_) {} // exit 1 = changes exist, proceed
  execSync(`git commit -m "${message}"`,             { stdio: 'pipe', cwd: ROOT });
  execSync('git fetch origin main',                  { stdio: 'pipe', cwd: ROOT });
  execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
  execSync('git push origin main',                   { stdio: 'pipe', cwd: ROOT });
  console.log(`  ✓ ${message}`);
}

async function main() {
  const start = Date.now();
  console.log('clear-stats-checked.js' + (NAMELESS_ONLY ? ' [nameless-only]' : ''));
  console.log('─'.repeat(50));

  const prefixes = fs.readdirSync(PLAYERS_DIR)
    .filter(f => /^[0-9a-f]{2}$/.test(f))
    .sort();

  let cleared = 0, skipped = 0, total = 0;
  let namelessWithSC = 0, namelessWithoutSC = 0;
  const sampleWithSC = [], sampleWithoutSC = [];

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
      if (!bk) { skipped++; continue; }

      if (NAMELESS_ONLY) {
        if (player.name) { skipped++; continue; }
        // Track state for diagnostic output
        if (bk.statsChecked) {
          namelessWithSC++;
          if (sampleWithSC.length < 3) sampleWithSC.push(player.uuid);
        } else {
          namelessWithoutSC++;
          if (sampleWithoutSC.length < 3) sampleWithoutSC.push(player.uuid);
        }
        if (!bk.statsChecked) { skipped++; continue; }
        delete bk.statsChecked;
        fs.writeFileSync(fpath, JSON.stringify(player));
        cleared++;
      } else {
        if (!bk.statsChecked) { skipped++; continue; }
        delete bk.statsChecked;
        fs.writeFileSync(fpath, JSON.stringify(player));
        cleared++;
      }
    }

    if ((prefixes.indexOf(prefix) + 1) % 32 === 0) {
      process.stdout.write(`  ${prefix} — ${cleared} cleared so far\r`);
    }
  }

  console.log(`\n  ${total} files scanned`);
  if (NAMELESS_ONLY) {
    console.log(`  Nameless WITH statsChecked:    ${namelessWithSC}  (will be cleared)`);
    console.log(`  Nameless WITHOUT statsChecked: ${namelessWithoutSC}  (already queued)`);
    if (sampleWithSC.length)    console.log(`  Sample WITH:    ${sampleWithSC.join(', ')}`);
    if (sampleWithoutSC.length) console.log(`  Sample WITHOUT: ${sampleWithoutSC.join(', ')}`);
  }
  console.log(`  ${cleared} statsChecked values cleared`);
  console.log(`  ${skipped} already clear or unreadable`);
  console.log('\n  Committing...');

  // Write marker so retrigger knows a force was pending
  // Removed by retrigger job once actual writes are confirmed
  fs.writeFileSync(
    path.join(ROOT, 'matrix-force-pending.json'),
    JSON.stringify({ clearedAt: new Date().toISOString(), count: cleared })
  );

  const commitMsg = NAMELESS_ONLY
    ? `clear-stats-checked: ${cleared} nameless players cleared for matrix re-fetch`
    : `clear-stats-checked: ${cleared} players cleared for matrix re-fetch`;

  gitCommit(commitMsg);

  console.log(`  Elapsed: ${Math.round((Date.now() - start) / 1000)}s`);
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
