// scripts/fix-null-records.js
//
// One-time fix: writes { v: null } records to players who have statsChecked
// but no player.records field. These are private/inaccessible players where
// backfill-player-records.js skipped them (both maxGamePTS and maxGameThreePt null).
//
// No API calls — pure file I/O.
//
// Usage:
//   node scripts/fix-null-records.js
//   node scripts/fix-null-records.js --dry-run

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT       = path.join(__dirname, '..');
const DRY_RUN    = process.argv.includes('--dry-run');
const PLAYERS_DIR = path.join(ROOT, 'players');
const INDEX_DIR   = path.join(ROOT, 'players', 'indexes');
const COMMIT_EVERY = 8;  // prefix dirs per commit

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gitCommit(msg) {
  if (DRY_RUN) { console.log(`  [dry-run] ${msg}`); return; }
  try {
    execSync('git add -A', { stdio: 'pipe', cwd: ROOT });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim();
    if (!diff) { return; }
    execSync(`git commit -m "${msg.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT });
    execSync('git fetch origin main', { stdio: 'pipe', cwd: ROOT });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
    execSync('git push origin main', { stdio: 'pipe', cwd: ROOT });
    console.log(`  ✓ ${msg}`);
  } catch (e) { console.error(`  git error: ${e.message}`); }
}

async function main() {
  console.log('fix-null-records.js');
  if (DRY_RUN) console.log('  ⚠  DRY RUN');
  console.log('─'.repeat(50));

  const prefixes = fs.readdirSync(INDEX_DIR)
    .filter(f => /^[0-9a-f]{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort();

  let fixed = 0, skipped = 0, sinceCommit = 0;

  for (const prefix of prefixes) {
    let index;
    try { index = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, `${prefix}.json`), 'utf8')); }
    catch (_) { continue; }

    for (const uuid of Object.keys(index)) {
      const file = path.join(PLAYERS_DIR, prefix, `${uuid}.json`);
      let player;
      try { player = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (_) { continue; }

      // Only fix players with statsChecked but missing records
      const bk = player.sports?.Basketball;
      if (!bk?.statsChecked)       { skipped++; continue; }
      if (player.records !== undefined) { skipped++; continue; }

      player.records = {
        maxGamePTS:     { v: bk.maxGamePTS     ?? null },
        maxGameThreePt: { v: bk.maxGameThreePt ?? null },
      };

      if (!DRY_RUN) fs.writeFileSync(file, JSON.stringify(player));
      fixed++;
    }

    sinceCommit++;
    if (sinceCommit >= COMMIT_EVERY) {
      await gitCommit(`fix-null-records: ${fixed} players fixed so far`);
      sinceCommit = 0;
    }
  }

  await gitCommit(`fix-null-records: complete — ${fixed} players updated`);

  console.log('─'.repeat(50));
  console.log(`  Fixed:   ${fixed}`);
  console.log(`  Skipped: ${skipped}`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
