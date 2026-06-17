// scripts/cleanup-player-pgstats.js
//
// Removes the redundant threePtPG and foulsPG fields written to player files
// by an earlier version of build-foulout-stats.js. These are now computed
// on the fly in build-leaderboards.js from reg.stats.threePt and reg.stats.fouls.
//
// Only touches files that actually have these fields — skips all others.
// Safe to re-run.
//
// Run:     node scripts/cleanup-player-pgstats.js
// Dry run: node scripts/cleanup-player-pgstats.js --dry-run

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT             = path.join(__dirname, '..');
const DRY_RUN          = process.argv.includes('--dry-run');
const COMMIT_INTERVAL  = 2000;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

function gitCommit(message, dirs) {
  try {
    execSync(`git add ${dirs.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ committed: ${message}`);
  } catch (e) {
    console.error(`  ✗ git error: ${e.message}`);
  }
}

const playersDir = path.join(ROOT, 'players');
const prefixDirs = fs.readdirSync(playersDir)
  .filter(d => /^[0-9a-f]{2}$/.test(d)).sort();

let scanned = 0;
let cleaned = 0;
let sinceLastCommit = 0;

console.log('Scanning player files for redundant threePtPG / foulsPG fields...');

for (const prefix of prefixDirs) {
  const prefixDir = path.join(playersDir, prefix);
  const files = fs.readdirSync(prefixDir).filter(f => f.endsWith('.json'));

  for (const fname of files) {
    const fpath = path.join(prefixDir, fname);
    let player;
    try { player = readJson(fpath); } catch { scanned++; continue; }

    let modified = false;

    // Remove from career stats
    const bball = player.sports?.Basketball;
    if (bball) {
      if ('threePtPG' in bball) { delete bball.threePtPG; modified = true; }
      if ('foulsPG'   in bball) { delete bball.foulsPG;   modified = true; }
    }

    // Remove from every reg.stats
    for (const season of (player.seasons || [])) {
      for (const reg of (season.regs || [])) {
        if (!reg.stats) continue;
        if ('threePtPG' in reg.stats) { delete reg.stats.threePtPG; modified = true; }
        if ('foulsPG'   in reg.stats) { delete reg.stats.foulsPG;   modified = true; }
      }
    }

    if (modified) {
      if (!DRY_RUN) writeJson(fpath, player);
      cleaned++;
      sinceLastCommit++;

      if (sinceLastCommit >= COMMIT_INTERVAL) {
        if (!DRY_RUN) {
          gitCommit(
            `cleanup-player-pgstats: ${cleaned} files cleaned`,
            ['players/']
          );
        }
        sinceLastCommit = 0;
        console.log(`  ${cleaned} files cleaned...`);
      }
    }

    scanned++;
  }
}

if (!DRY_RUN && sinceLastCommit > 0) {
  gitCommit(
    `cleanup-player-pgstats: complete — ${cleaned} files cleaned`,
    ['players/']
  );
}

console.log('\n─── Summary ────────────────────────────────────────────────');
console.log(`  Players scanned  : ${scanned}`);
console.log(`  Files cleaned    : ${cleaned}`);
console.log(`  Mode             : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
