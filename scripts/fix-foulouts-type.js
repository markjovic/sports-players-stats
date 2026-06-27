// scripts/fix-foulouts-type.js
//
// ONE-TIME: finds players where sports.Basketball.foulOuts is not an object
// (e.g. a number from old fetch-playhq.js writes) and converts it.
// A numeric foulOuts value cannot be mapped to seasons, so it is reset to {}.
// The matrix will re-derive correct per-season foulOuts on next fetch.

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const DRY_RUN     = process.argv.includes('--dry-run');

function gitCommit(msg) {
  execSync('git add players/', { stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
  const staged = execSync('git diff --staged --shortstat',
    { stdio: 'pipe', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).toString().trim();
  if (!staged) { console.log('  Nothing to commit.'); return; }
  execSync('git fetch origin main',                  { stdio: 'pipe', cwd: ROOT });
  execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
  execSync(`git commit -m "${msg}"`,                 { stdio: 'pipe', cwd: ROOT });
  execSync('git push origin main',                   { stdio: 'pipe', cwd: ROOT });
  console.log(`  ✓ ${msg}`);
}

function main() {
  console.log(`\nfix-foulouts-type.js${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log('─'.repeat(50));

  let fixed = 0, scanned = 0;

  for (const prefix of fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort()) {
    const dir = path.join(PLAYERS_DIR, prefix);
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      scanned++;
      const fpath = path.join(dir, fname);
      let p;
      try { p = JSON.parse(fs.readFileSync(fpath, 'utf8')); } catch { continue; }

      const bk = p.sports?.Basketball;
      if (!bk) continue;
      if (bk.foulOuts === undefined) continue;
      if (typeof bk.foulOuts === 'object' && bk.foulOuts !== null && !Array.isArray(bk.foulOuts)) continue;

      // Wrong type — reset to empty object so matrix re-derives correctly
      console.log(`  fixing ${p.uuid}  foulOuts was: ${JSON.stringify(bk.foulOuts)}`);
      bk.foulOuts = {};
      // Clear statsChecked so matrix re-fetches and writes correct value
      delete bk.statsChecked;
      if (!DRY_RUN) fs.writeFileSync(fpath, JSON.stringify(p), 'utf8');
      fixed++;
    }
  }

  console.log(`\n  Scanned: ${scanned}`);
  console.log(`  Fixed:   ${fixed}`);

  if (!DRY_RUN && fixed > 0) {
    gitCommit(`fix-foulouts-type: ${fixed} players reset, queued for matrix re-fetch`);
  }
}

main();
