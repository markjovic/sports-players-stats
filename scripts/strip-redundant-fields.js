// scripts/strip-redundant-fields.js
//
// One-off migration to strip redundant fields from player files and game files.
//
// Player files — removes:
//   season.sport       — always "Basketball", derivable from context
//   reg.stats.foulOuts = 0   — zero values add no information
//   reg.stats.finals   = 0
//   reg.stats.gfApps   = 0
//   reg.stats.gfWins   = 0
//
// Game files — removes:
//   g.url              — PlayHQ game URL, unused in StatTrack
//   g.p[].n            — player name in participant list, unused in StatTrack
//
// Usage:
//   node scripts/strip-redundant-fields.js
//   node scripts/strip-redundant-fields.js --dry-run

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const DRY_RUN     = process.argv.includes('--dry-run');
const COMMIT_EVERY = 5000;

if (DRY_RUN) console.log('DRY RUN — no files will be written\n');

function gitCommit(msg) {
  if (DRY_RUN) return;
  try {
    execSync('git fetch origin main',                  { stdio: 'pipe', cwd: ROOT });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
    execSync('git add players/ games/',                { stdio: 'pipe', cwd: ROOT, maxBuffer: 512*1024*1024 });
    const staged = execSync('git diff --staged --shortstat', { stdio: 'pipe', cwd: ROOT, maxBuffer: 10*1024*1024 }).toString().trim();
    if (!staged) { console.log('  Nothing to commit.'); return; }
    execSync(`git commit -m "${msg}"`,  { stdio: 'pipe', cwd: ROOT });
    execSync('git push origin main',    { stdio: 'pipe', cwd: ROOT });
    console.log(`  ✓ ${msg}`);
  } catch (e) {
    console.error('  git error:', e.stderr?.toString().slice(0,200) || e.message.slice(0,200));
  }
}

// ── Player files ──────────────────────────────────────────────────────────────

console.log('── Player files ────────────────────────────────────────────────');
const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();

let pScanned = 0, pModified = 0, pSkipped = 0, sinceCommit = 0;
let sportStripped = 0, zeroStripped = 0;

for (const prefix of prefixes) {
  const dir = path.join(PLAYERS_DIR, prefix);
  for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
    const fpath = path.join(dir, fname);
    let player; try { player = JSON.parse(fs.readFileSync(fpath, 'utf8')); } catch { continue; }
    pScanned++;

    let modified = false;

    for (const season of (player.seasons || [])) {
      // Strip sport
      if ('sport' in season) { delete season.sport; modified = true; sportStripped++; }

      for (const reg of (season.regs || [])) {
        // age retained — used in StatTrack for grade filter, team-lookup not loaded client-side

        // Strip zero stat values
        if (reg.stats) {
          for (const f of ['foulOuts', 'finals', 'gfApps', 'gfWins']) {
            if (f in reg.stats && reg.stats[f] === 0) {
              delete reg.stats[f]; modified = true; zeroStripped++;
            }
          }
          // Clean up empty stats object
          if (Object.keys(reg.stats).length === 0) delete reg.stats;
        }
      }
    }

    if (modified) {
      if (!DRY_RUN) fs.writeFileSync(fpath, JSON.stringify(player), 'utf8');
      pModified++;
      sinceCommit++;
      if (sinceCommit >= COMMIT_EVERY) {
        gitCommit(`strip-redundant-fields: ${pModified} player files stripped`);
        sinceCommit = 0;
        console.log(`  Progress: ${pModified} player files modified`);
      }
    } else {
      pSkipped++;
    }

    if (pScanned % 50000 === 0) process.stdout.write(`  ${pScanned} players scanned…\r`);
  }
}

if (sinceCommit > 0) gitCommit(`strip-redundant-fields: player files complete — ${pModified} modified`);

console.log(`\n  Player files scanned:  ${pScanned.toLocaleString()}`);
console.log(`  Modified:              ${pModified.toLocaleString()}`);
console.log(`  Skipped (clean):       ${pSkipped.toLocaleString()}`);
console.log(`  sport fields removed:  ${sportStripped.toLocaleString()}`);
console.log(`  age fields removed:    ${ageStripped.toLocaleString()}`);
console.log(`  zero stat values removed: ${zeroStripped.toLocaleString()}`);

// ── Game files ────────────────────────────────────────────────────────────────

console.log('\n── Game files ──────────────────────────────────────────────────');
const gameFiles = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort();

let gfScanned = 0, gfModified = 0, gfSkipped = 0;
let urlStripped = 0, nameStripped = 0;
sinceCommit = 0;

for (const fname of gameFiles) {
  const fpath = path.join(GAMES_DIR, fname);
  let gf; try { gf = JSON.parse(fs.readFileSync(fpath, 'utf8')); } catch { continue; }
  gfScanned++;

  let modified = false;
  for (const g of Object.values(gf.games || {})) {
    // Strip url
    if ('url' in g) { delete g.url; modified = true; urlStripped++; }

    // Strip n from p[]
    for (const p of (g.p || [])) {
      if ('n' in p) { delete p.n; modified = true; nameStripped++; }
    }
  }

  if (modified) {
    if (!DRY_RUN) fs.writeFileSync(fpath, JSON.stringify(gf), 'utf8');
    gfModified++;
    sinceCommit++;
    if (sinceCommit >= 100) {
      gitCommit(`strip-redundant-fields: ${gfModified} game files stripped`);
      sinceCommit = 0;
      console.log(`  Progress: ${gfModified} game files modified`);
    }
  } else {
    gfSkipped++;
  }

  if (gfScanned % 500 === 0) process.stdout.write(`  ${gfScanned}/${gameFiles.length} game files…\r`);
}

if (sinceCommit > 0) gitCommit(`strip-redundant-fields: game files complete — ${gfModified} modified`);

console.log(`\n  Game files scanned:    ${gfScanned.toLocaleString()}`);
console.log(`  Modified:              ${gfModified.toLocaleString()}`);
console.log(`  Skipped (clean):       ${gfSkipped.toLocaleString()}`);
console.log(`  url fields removed:    ${urlStripped.toLocaleString()}`);
console.log(`  p[].n removed:         ${nameStripped.toLocaleString()}`);

console.log('\n── Done ────────────────────────────────────────────────────────');
