// scripts/fix-forfeit-player-records.js
//
// Finds players contaminated by forfeit game stats across ALL leaderboard
// categories and clears their stats so the matrix re-fetches them cleanly.
//
// Contaminated = player appears in any leaderboard AND their records.maxGamePTS
// or records.maxGameThreePt gameKey is a known forfeit game.
//
// For maxGamePTS/maxGameThreePt categories: detects via records.gameKey
// For other categories (pts, gp, etc.): includes ALL players in those leaderboards
//   whose records show forfeit contamination — their career totals may also be wrong.
//
// Clears: maxGamePTS, maxGameThreePt, records, statsChecked
// Effect: matrix re-fetches these players, fetch-profile-stats.js now skips
//         forfeit games → clean stats written.
//
// Run AFTER: build-forfeit-index.js + recheck-forfeit-games.js
//
// Usage:
//   node scripts/fix-forfeit-player-records.js
//   node scripts/fix-forfeit-player-records.js --dry-run

'use strict';
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT          = path.join(__dirname, '..');
const DRY_RUN       = process.argv.includes('--dry-run');
const FORFEIT_FILE  = path.join(ROOT, 'forfeit-games.json');
const LB_FILE       = path.join(ROOT, 'leaderboard', 'all-time.json');
const PLAYERS_DIR   = path.join(ROOT, 'players');
const COMMIT_EVERY  = 200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gitCommit(msg) {
  if (DRY_RUN) { console.log(`  [dry-run] ${msg}`); return; }
  try {
    execSync('git add players/', { stdio: 'pipe', cwd: ROOT });
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
  console.log('fix-forfeit-player-records.js');
  if (DRY_RUN) console.log('  ⚠  DRY RUN');
  console.log('─'.repeat(50));

  // Load forfeit index
  const forfeitIds = new Set();
  try {
    const ids = JSON.parse(fs.readFileSync(FORFEIT_FILE, 'utf8'));
    for (const id of (Array.isArray(ids) ? ids : [])) forfeitIds.add(id);
    console.log(`Forfeit index: ${forfeitIds.size} games`);
  } catch (_) {
    console.error('forfeit-games.json not found — run build-forfeit-index.js first');
    process.exit(1);
  }

  // Load all-time leaderboard — collect every UUID in every category
  let lbData;
  try { lbData = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')); }
  catch (_) { console.error('leaderboard/all-time.json not found'); process.exit(1); }

  // Collect all leaderboard UUIDs
  const allLbUuids = new Set();
  for (const entries of Object.values(lbData)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) { if (e.uuid) allLbUuids.add(e.uuid); }
  }
  console.log(`Leaderboard players (all categories): ${allLbUuids.size}`);

  // Identify contaminated players:
  // Any leaderboard player whose records.maxGamePTS.gameKey or
  // records.maxGameThreePt.gameKey is in the forfeit set
  const contaminated = new Set();
  let checked = 0;

  for (const uuid of allLbUuids) {
    const shard = uuid.slice(0, 2);
    const file  = path.join(PLAYERS_DIR, shard, `${uuid}.json`);
    let player;
    try { player = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { continue; }
    checked++;

    const ptsKey    = player.records?.maxGamePTS?.gameKey;
    const threePtKey = player.records?.maxGameThreePt?.gameKey;

    if ((ptsKey    && forfeitIds.has(ptsKey))    ||
        (threePtKey && forfeitIds.has(threePtKey))) {
      contaminated.add(uuid);
    }
  }

  console.log(`Checked: ${checked}  Contaminated: ${contaminated.size}`);

  if (contaminated.size === 0) {
    console.log('\nNo contaminated players found. Done.');
    return;
  }

  console.log(`\nClearing stats for ${contaminated.size} players…`);

  let cleared = 0, sinceCommit = 0;

  for (const uuid of contaminated) {
    const shard = uuid.slice(0, 2);
    const file  = path.join(PLAYERS_DIR, shard, `${uuid}.json`);
    let player;
    try { player = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { continue; }

    const bk = player.sports?.Basketball;
    if (!bk) continue;

    // Clear all computed stats — matrix will rebuild from scratch
    // skipping forfeit games (fetch-profile-stats.js now loads forfeit-games.json)
    delete bk.maxGamePTS;
    delete bk.maxGameThreePt;
    delete bk.statsChecked;
    delete bk.foulOuts;
    delete player.records;

    if (!DRY_RUN) fs.writeFileSync(file, JSON.stringify(player));
    cleared++;
    sinceCommit++;

    if (sinceCommit >= COMMIT_EVERY) {
      await gitCommit(`fix-forfeit-player-records: ${cleared} players cleared so far`);
      sinceCommit = 0;
    }
  }

  await gitCommit(`fix-forfeit-player-records: ${cleared} contaminated players cleared for re-fetch`);

  console.log('─'.repeat(50));
  console.log(`  Contaminated found:  ${contaminated.size}`);
  console.log(`  Stats cleared:       ${cleared}`);
  console.log(`  Ready for re-fetch:  trigger fetch-profile-stats-matrix.yml`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
