// scripts/migrate-data-dir.js
//
// One-off migration: moves root JSON files to data/ and updates all script
// references from path.join(ROOT, 'x.json') to path.join(DATA, 'x.json').
//
// Run AFTER committing updated workflow files.
//
// Usage:
//   node scripts/migrate-data-dir.js --dry-run   # preview only
//   node scripts/migrate-data-dir.js             # live

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT     = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DRY_RUN  = process.argv.includes('--dry-run');

if (DRY_RUN) console.log('DRY RUN — no files will be moved or written\n');

// ── Files to move ─────────────────────────────────────────────────────────────

const FILES = [
  'sports-index.json',
  'team-index.json',
  'forfeit-games.json',
  'venue-index.json',
  'season-venue-index.json',
  'seasons-discovered.json',
  'seasons-skipped.json',
  'seasons-invalid.json',
];

// ── String replacements in scripts ───────────────────────────────────────────
// Each entry: [oldString, newString]
// Applied to every .js file in scripts/

const REPLACEMENTS = [
  // Generic pattern: path.join(ROOT, 'x.json') → path.join(DATA, 'x.json')
  // We introduce a DATA constant at the top of each script that needs it.
  // Rather than introduce a new constant, we just replace the path strings directly.
  [`path.join(ROOT, 'sports-index.json')`,       `path.join(ROOT, 'data', 'sports-index.json')`],
  [`path.join(ROOT, 'team-index.json')`,          `path.join(ROOT, 'data', 'team-index.json')`],
  [`path.join(ROOT, 'forfeit-games.json')`,       `path.join(ROOT, 'data', 'forfeit-games.json')`],
  [`path.join(ROOT, 'venue-index.json')`,         `path.join(ROOT, 'data', 'venue-index.json')`],
  [`path.join(ROOT, 'season-venue-index.json')`,  `path.join(ROOT, 'data', 'season-venue-index.json')`],
  [`path.join(ROOT, 'seasons-discovered.json')`,  `path.join(ROOT, 'data', 'seasons-discovered.json')`],
  [`path.join(ROOT, 'seasons-skipped.json')`,     `path.join(ROOT, 'data', 'seasons-skipped.json')`],
  [`path.join(ROOT, 'seasons-invalid.json')`,     `path.join(ROOT, 'data', 'seasons-invalid.json')`],
  // Also handle INDEX_FILE and FORFEIT_FILE constants that use ROOT directly
  [`const INDEX_FILE     = path.join(ROOT, 'sports-index.json')`,  `const INDEX_FILE     = path.join(ROOT, 'data', 'sports-index.json')`],
  [`const INDEX_FILE  = path.join(ROOT, 'sports-index.json')`,     `const INDEX_FILE  = path.join(ROOT, 'data', 'sports-index.json')`],
  [`const FORFEIT_FILE   = path.join(ROOT, 'forfeit-games.json')`, `const FORFEIT_FILE   = path.join(ROOT, 'data', 'forfeit-games.json')`],
  [`const TEAM_INDEX_FILE = path.join(ROOT, 'team-index.json')`,   `const TEAM_INDEX_FILE = path.join(ROOT, 'data', 'team-index.json')`],
  [`const SPORTS_INDEX    = path.join(ROOT, 'sports-index.json')`,  `const SPORTS_INDEX    = path.join(ROOT, 'data', 'sports-index.json')`],
  [`const FORFEIT_FILE = path.join(ROOT, 'forfeit-games.json')`,   `const FORFEIT_FILE = path.join(ROOT, 'data', 'forfeit-games.json')`],
  // build-venue-indexes writes season-venue-index and venue-index directly
  [`const svPath = path.join(ROOT, 'season-venue-index.json')`,    `const svPath = path.join(ROOT, 'data', 'season-venue-index.json')`],
  // git add references in scripts
  [`'venue-lookup/', 'date-venue-index/', 'season-venue-index.json'`, `'venue-lookup/', 'date-venue-index/', 'data/season-venue-index.json'`],
  [`games/ forfeit-games.json`,                                     `games/ data/forfeit-games.json`],
  // nightly-crawl forfeit path (string literal)
  [`path.join(ROOT, 'forfeit-games.json')`,                         `path.join(ROOT, 'data', 'forfeit-games.json')`],
];

// ── Step 1: Move files ────────────────────────────────────────────────────────

console.log('── Step 1: Moving files to data/ ───────────────────────────────');
if (!DRY_RUN) fs.mkdirSync(DATA_DIR, { recursive: true });

for (const fname of FILES) {
  const src  = path.join(ROOT, fname);
  const dest = path.join(DATA_DIR, fname);
  if (!fs.existsSync(src)) {
    console.log(`  SKIP (not found): ${fname}`);
    continue;
  }
  if (DRY_RUN) {
    console.log(`  WOULD MOVE: ${fname} → data/${fname}`);
  } else {
    fs.renameSync(src, dest);
    console.log(`  Moved: ${fname} → data/${fname}`);
  }
}

// ── Step 2: Update script references ─────────────────────────────────────────

console.log('\n── Step 2: Updating script references ─────────────────────────');
const scriptsDir  = path.join(ROOT, 'scripts');
const scriptFiles = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.js')).sort();

let scriptsModified = 0;
for (const fname of scriptFiles) {
  const fpath = path.join(scriptsDir, fname);
  let content = fs.readFileSync(fpath, 'utf8');
  let modified = false;

  for (const [oldStr, newStr] of REPLACEMENTS) {
    if (content.includes(oldStr)) {
      content = content.split(oldStr).join(newStr);
      modified = true;
    }
  }

  if (modified) {
    if (!DRY_RUN) fs.writeFileSync(fpath, content, 'utf8');
    console.log(`  ${DRY_RUN ? 'WOULD UPDATE' : 'Updated'}: scripts/${fname}`);
    scriptsModified++;
  }
}
console.log(`  ${scriptsModified} script files ${DRY_RUN ? 'would be' : ''} updated`);

// ── Step 3: Commit ────────────────────────────────────────────────────────────

if (!DRY_RUN) {
  console.log('\n── Step 3: Committing ──────────────────────────────────────────');
  try {
    execSync('git fetch origin main',                  { stdio: 'pipe', cwd: ROOT });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
    // Stage moved files — git needs to know about the rename
    for (const fname of FILES) {
      const src  = path.join(ROOT, fname);
      const dest = `data/${fname}`;
      // git rm the old location (may already be gone), git add the new
      try { execSync(`git rm --cached ${fname}`, { stdio: 'pipe', cwd: ROOT }); } catch {}
      try { execSync(`git add ${dest}`, { stdio: 'pipe', cwd: ROOT }); } catch {}
    }
    execSync('git add scripts/', { stdio: 'pipe', cwd: ROOT });
    execSync('git add data/',    { stdio: 'pipe', cwd: ROOT });
    const staged = execSync('git diff --staged --shortstat',
      { stdio: 'pipe', cwd: ROOT, maxBuffer: 10*1024*1024 }).toString().trim();
    if (!staged) { console.log('  Nothing to commit.'); }
    else {
      execSync('git commit -m "migrate: move root JSON files to data/"', { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main', { stdio: 'pipe', cwd: ROOT });
      console.log('  ✓ Committed and pushed');
      console.log(`  ${staged}`);
    }
  } catch (e) {
    console.error('  git error:', e.stderr?.toString().slice(0,300) || e.message.slice(0,300));
  }
}

console.log('\n── Done ────────────────────────────────────────────────────────');
console.log('Next: update StatTrack index.html BASE URLs from /x.json to /data/x.json');
