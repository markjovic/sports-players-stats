// scripts/clear-stats-checked.js
//
// Clears statsChecked from player files so the matrix re-fetches them.
//
// Modes:
//   node scripts/clear-stats-checked.js
//     Clears ALL players — used before a force matrix run.
//
//   node scripts/clear-stats-checked.js --nameless-only
//     Fixes corrupt player names (season strings like "Winter 2022") and
//     clears statsChecked for those players so the matrix re-fetches and
//     writes their real names. Does everything in one pass, one commit.

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT          = path.join(__dirname, '..');
const PLAYERS_DIR   = path.join(ROOT, 'players');
const NAMELESS_ONLY = process.argv.includes('--nameless-only');
const SEASON_RE     = /^(Winter|Summer|Spring|Autumn|Fall)\s+\d{4}/i;

function gitCommit(message) {
  execSync('git add players/', { stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
  try {
    execSync('git diff --staged --quiet', { stdio: 'pipe', cwd: ROOT });
    console.log('  Nothing to commit'); return;
  } catch (_) {}
  execSync('git fetch origin main',                  { stdio: 'pipe', cwd: ROOT });
  execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
  execSync(`git commit -m "${message}"`,             { stdio: 'pipe', cwd: ROOT });
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
  let namesFixed = 0;

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

      if (NAMELESS_ONLY) {
        // Target: players with a corrupt season name OR no name at all
        const corrupt = player.name && SEASON_RE.test(player.name);
        const missing = !player.name;
        if (!corrupt && !missing) { skipped++; continue; }

        let modified = false;

        // Clear corrupt name
        if (corrupt) {
          delete player.name;
          namesFixed++;
          modified = true;
        }

        // Clear statsChecked so matrix re-fetches and writes real name
        if (bk?.statsChecked) {
          delete bk.statsChecked;
          cleared++;
          modified = true;
        }

        if (modified) fs.writeFileSync(fpath, JSON.stringify(player), 'utf8');
        else skipped++;

      } else {
        // Normal mode: clear statsChecked from every player
        if (!bk?.statsChecked) { skipped++; continue; }
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
    console.log(`  Corrupt names fixed:       ${namesFixed}`);
    console.log(`  statsChecked cleared:      ${cleared}`);
  } else {
    console.log(`  statsChecked cleared:      ${cleared}`);
  }
  console.log(`  Skipped:                   ${skipped}`);
  console.log('\n  Committing...');

  if (!NAMELESS_ONLY) {
    fs.writeFileSync(
      path.join(ROOT, 'matrix-force-pending.json'),
      JSON.stringify({ clearedAt: new Date().toISOString(), count: cleared })
    );
  }

  const msg = NAMELESS_ONLY
    ? `clear-stats-checked: ${namesFixed} corrupt names cleared, ${cleared} queued for matrix`
    : `clear-stats-checked: ${cleared} players cleared for matrix re-fetch`;

  gitCommit(msg);

  console.log(`  Elapsed: ${Math.round((Date.now() - start) / 1000)}s`);
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
