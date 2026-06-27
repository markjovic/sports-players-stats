// scripts/clear-stats-checked.js
//
// Clears statsChecked from player files so the matrix re-fetches them.
//
// Modes:
//   node scripts/clear-stats-checked.js
//     Clears ALL players — used before a force matrix run.
//
//   node scripts/clear-stats-checked.js --fix-corrupt-names
//     Finds players with corrupt season names ("Winter 2022" etc),
//     deletes the corrupt name, and clears statsChecked so the matrix
//     re-fetches them and writes their real name from the API.

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT          = path.join(__dirname, '..');
const PLAYERS_DIR   = path.join(ROOT, 'players');
const FIX_CORRUPT = process.argv.includes('--fix-corrupt-names');
const SEASON_RE     = /^(Winter|Summer|Spring|Autumn|Fall)\s+\d{4}/i;

function gitCommit(message) {
  // Stage player files only — avoids staging unrelated changes
  execSync('git add players/', { stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
  // --shortstat avoids ENOBUFS from large diff output
  const staged = execSync('git diff --staged --shortstat',
    { stdio: 'pipe', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).toString().trim();
  if (!staged) { console.log('  Nothing to commit.'); return; }
  // Merge before committing so push succeeds even if other commits landed during the run
  execSync('git fetch origin main',                  { stdio: 'pipe', cwd: ROOT });
  execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
  execSync(`git commit -m "${message}"`,             { stdio: 'pipe', cwd: ROOT });
  execSync('git push origin main',                   { stdio: 'pipe', cwd: ROOT });
  console.log(`  ✓ ${message}`);
}

async function main() {
  const start = Date.now();
  console.log('clear-stats-checked.js' + (FIX_CORRUPT ? ' [fix-corrupt-names]' : ''));
  console.log('─'.repeat(50));

  const prefixes = fs.readdirSync(PLAYERS_DIR)
    .filter(f => /^[0-9a-f]{2}$/.test(f))
    .sort();

  let cleared = 0, namesFixed = 0, skipped = 0, total = 0;

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

      if (FIX_CORRUPT) {
        // Only touch players with a corrupt season name
        if (!player.name || !SEASON_RE.test(player.name)) { skipped++; continue; }
        delete player.name;
        namesFixed++;
        if (bk?.statsChecked) { delete bk.statsChecked; cleared++; }
        fs.writeFileSync(fpath, JSON.stringify(player), 'utf8');
      } else {
        if (!bk?.statsChecked) { skipped++; continue; }
        delete bk.statsChecked;
        fs.writeFileSync(fpath, JSON.stringify(player), 'utf8');
        cleared++;
      }
    }

    if ((prefixes.indexOf(prefix) + 1) % 32 === 0)
      process.stdout.write(`  ${prefix} — ${namesFixed || cleared} processed so far\r`);
  }

  console.log(`\n  ${total} files scanned`);
  if (FIX_CORRUPT) {
    console.log(`  Corrupt names deleted:  ${namesFixed}`);
    console.log(`  statsChecked cleared:   ${cleared}`);
  } else {
    console.log(`  statsChecked cleared:   ${cleared}`);
  }
  console.log(`  Skipped:                ${skipped}`);
  console.log('\n  Committing...');

  if (!FIX_CORRUPT) {
    fs.writeFileSync(
      path.join(ROOT, 'matrix-force-pending.json'),
      JSON.stringify({ clearedAt: new Date().toISOString(), count: cleared })
    );
  }

  const msg = FIX_CORRUPT
    ? `clear-stats-checked: ${namesFixed} corrupt names deleted, ${cleared} queued for matrix`
    : `clear-stats-checked: ${cleared} players cleared for matrix re-fetch`;

  gitCommit(msg);
  console.log(`  Elapsed: ${Math.round((Date.now() - start) / 1000)}s`);
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
