// scripts/build-forfeit-index.js
//
// Scans all game files for entries with forfeit:true and writes forfeit-games.json.
// This is the base index — run before recheck-forfeit-games.js.
//
// forfeit-games.json: plain array of game IDs ["10591e07", ...]
//
// Usage:
//   node scripts/build-forfeit-index.js
//   node scripts/build-forfeit-index.js --dry-run

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT       = path.join(__dirname, '..');
const DRY_RUN    = process.argv.includes('--dry-run');
const GAMES_DIR  = path.join(ROOT, 'games', 'bv');
const OUT_FILE   = path.join(ROOT, 'forfeit-games.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gitCommit(msg) {
  if (DRY_RUN) { console.log(`  [dry-run] ${msg}`); return; }
  try {
    execSync('git add forfeit-games.json', { stdio: 'pipe', cwd: ROOT });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim();
    if (!diff) { console.log('  Nothing to commit'); return; }
    execSync(`git commit -m "${msg}"`, { stdio: 'pipe', cwd: ROOT });
    execSync('git fetch origin main', { stdio: 'pipe', cwd: ROOT });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
    execSync('git push origin main', { stdio: 'pipe', cwd: ROOT });
    console.log(`  ✓ ${msg}`);
  } catch (e) { console.error(`  git error: ${e.message}`); }
}

async function main() {
  console.log('build-forfeit-index.js');
  if (DRY_RUN) console.log('  ⚠  DRY RUN');
  console.log('─'.repeat(50));

  const gameFiles  = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort();
  const forfeitIds = new Set();
  let gamesScanned = 0, seasonsScanned = 0;

  for (const fname of gameFiles) {
    seasonsScanned++;
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); }
    catch (_) { continue; }
    for (const [gameId, game] of Object.entries(gf.games || {})) {
      gamesScanned++;
      if (game.forfeit) forfeitIds.add(gameId);
    }
    if (seasonsScanned % 500 === 0)
      process.stdout.write(`  ${seasonsScanned}/${gameFiles.length} seasons\r`);
  }

  console.log(`\n  Seasons scanned: ${seasonsScanned}`);
  console.log(`  Games scanned:   ${gamesScanned.toLocaleString()}`);
  console.log(`  Forfeits found:  ${forfeitIds.size.toLocaleString()}`);

  const sorted = [...forfeitIds].sort();
  if (!DRY_RUN) fs.writeFileSync(OUT_FILE, JSON.stringify(sorted));
  await gitCommit(`build-forfeit-index: ${sorted.length} forfeit games indexed`);
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
