// reorganise-repo.js
// One-time repo reorganisation: moves all .js and .sh files from repo root
// to scripts/, updates __dirname references in each script, and updates
// .github/workflows/*.yml files to reference the new paths.
//
// Run from repo root: node reorganise-repo.js
// Dry run (no changes):  node reorganise-repo.js --dry-run
// Single-file test:      node reorganise-repo.js --only repo-size.js
// Single-file dry run:   node reorganise-repo.js --only repo-size.js --dry-run

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DRY_RUN   = process.argv.includes('--dry-run');
const ONLY_IDX  = process.argv.indexOf('--only');
const ONLY_FILE = ONLY_IDX !== -1 ? process.argv[ONLY_IDX + 1] : null;
const ROOT_DECL   = "const ROOT = path.join(__dirname, '..');";
const SCRIPTS_DIR = 'scripts';
const WORKFLOWS   = '.github/workflows';

// Extensions to move
const MOVE_EXTS = new Set(['.js', '.sh']);

// Files to leave in root regardless of extension
const KEEP_IN_ROOT = new Set([
  'reorganise-repo.js', // this script itself
]);

// ── transform helpers ─────────────────────────────────────────────────────────

function transformScript(content) {
  if (content.includes(ROOT_DECL)) return content;
  if (!content.includes('path.join(__dirname,')) return content;

  // Replace data path usages first — ROOT_DECL insertion below is not affected
  content = content.replaceAll('path.join(__dirname,', 'path.join(ROOT,');

  // Insert ROOT_DECL after the last require() in the opening require block.
  // Walk lines until the require block ends (first non-blank, non-comment,
  // non-require line), track the last require line seen.
  const lines = content.split('\n');
  let lastRequireIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    if (trimmed.startsWith("'use strict'") || trimmed.startsWith('"use strict"')) continue;
    if (trimmed.includes('require(')) { lastRequireIdx = i; continue; }
    // First substantive non-require line — stop scanning
    if (lastRequireIdx !== -1) break;
  }

  if (lastRequireIdx !== -1) {
    lines.splice(lastRequireIdx + 1, 0, ROOT_DECL);
  } else {
    // No require block found — insert after first line (filename comment)
    lines.splice(1, 0, ROOT_DECL);
  }

  return lines.join('\n');
}

function transformYml(content, scriptNames) {
  for (const name of scriptNames) {
    const escaped = name.replace(/\./g, '\\.');
    content = content.replace(
      new RegExp(`(?<!scripts/)\\b${escaped}\\b`, 'g'),
      `scripts/${name}`
    );
  }
  return content;
}

// ── collect files to move ─────────────────────────────────────────────────────

const rootFiles = fs.readdirSync('.')
  .filter(f => {
    if (KEEP_IN_ROOT.has(f)) return false;
    const ext = path.extname(f);
    if (!MOVE_EXTS.has(ext)) return false;
    if (ONLY_FILE && f !== ONLY_FILE) return false;
    return true;
  })
  .sort();

if (rootFiles.length === 0) {
  console.log(ONLY_FILE ? `File not found in root: ${ONLY_FILE}` : 'No files to move. Already reorganised?');
  process.exit(0);
}

const mode = ONLY_FILE ? ` [SINGLE FILE: ${ONLY_FILE}]` : '';
console.log(`reorganise-repo.js${DRY_RUN ? ' [DRY RUN]' : ''}${mode}`);
console.log('═'.repeat(50));
console.log(`\nFiles to move to scripts/ (${rootFiles.length}):`);
rootFiles.forEach(f => console.log(`  ${f}`));

// ── collect yml files ─────────────────────────────────────────────────────────
// In --only mode, only update the single matching workflow (basename without .js → .yml)

const allYmlFiles = fs.existsSync(WORKFLOWS)
  ? fs.readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml')).map(f => path.join(WORKFLOWS, f))
  : [];

const ymlFiles = ONLY_FILE
  ? allYmlFiles.filter(f => path.basename(f) === ONLY_FILE.replace(/\.[^.]+$/, '.yml'))
  : allYmlFiles;

console.log(`\nWorkflow files to update (${ymlFiles.length}):`);
ymlFiles.forEach(f => console.log(`  ${f}`));

if (DRY_RUN) {
  console.log('\n── DRY RUN: script transforms ──');
  for (const file of rootFiles.slice(0, 3)) {
    const content = fs.readFileSync(file, 'utf8');
    const transformed = transformScript(content);
    const changed = content !== transformed;
    console.log(`\n  ${file}: ${changed ? 'WILL be transformed' : 'no __dirname changes needed'}`);
    if (changed) {
      const origLines = content.split('\n');
      const newLines  = transformed.split('\n');
      for (let i = 0; i < Math.min(origLines.length, newLines.length, 10); i++) {
        if (origLines[i] !== newLines[i]) {
          console.log(`    - ${origLines[i]}`);
          console.log(`    + ${newLines[i]}`);
        }
      }
    }
  }

  console.log('\n── DRY RUN: yml changes ──');
  let ymlChangedCount = 0;
  for (const ymlPath of ymlFiles) {
    const content    = fs.readFileSync(ymlPath, 'utf8');
    const newContent = transformYml(content, rootFiles);
    if (content === newContent) {
      console.log(`\n  ${ymlPath}: no script references found`);
      continue;
    }
    ymlChangedCount++;
    console.log(`\n  ${ymlPath}: WILL be updated`);
    // Show every changed line with context
    const origLines = content.split('\n');
    const newLines  = newContent.split('\n');
    for (let i = 0; i < Math.max(origLines.length, newLines.length); i++) {
      if (origLines[i] !== newLines[i]) {
        if (origLines[i] !== undefined) console.log(`    - ${origLines[i]}`);
        if (newLines[i]  !== undefined) console.log(`    + ${newLines[i]}`);
      }
    }
  }
  if (ymlChangedCount === 0) console.log('  (no yml files reference these scripts)');

  console.log('\nRe-run without --dry-run to apply changes.');
  process.exit(0);
}

// ── apply changes ─────────────────────────────────────────────────────────────

console.log('\n── Moving and transforming scripts ──');
fs.mkdirSync(SCRIPTS_DIR, { recursive: true });

let moved = 0, transformed = 0;
for (const file of rootFiles) {
  const content    = fs.readFileSync(file, 'utf8');
  const newContent = path.extname(file) === '.js' ? transformScript(content) : content;
  const destPath   = path.join(SCRIPTS_DIR, file);

  fs.writeFileSync(destPath, newContent);
  fs.unlinkSync(file);

  if (newContent !== content) transformed++;
  moved++;

  if (moved % 10 === 0) console.log(`  ${moved}/${rootFiles.length} files moved`);
}
console.log(`  Done. ${moved} files moved, ${transformed} scripts transformed.`);

// ── update yml files ──────────────────────────────────────────────────────────

console.log('\n── Updating workflow yml files ──');
let ymlUpdated = 0;
for (const ymlPath of ymlFiles) {
  const content    = fs.readFileSync(ymlPath, 'utf8');
  const newContent = transformYml(content, rootFiles);
  if (content !== newContent) {
    fs.writeFileSync(ymlPath, newContent);
    console.log(`  updated: ${ymlPath}`);
    ymlUpdated++;
  }
}
console.log(`  ${ymlUpdated}/${ymlFiles.length} workflow files updated.`);

// ── commit ────────────────────────────────────────────────────────────────────

console.log('\n── Committing ──');
try {
  execSync(`git add ${SCRIPTS_DIR} ${WORKFLOWS}`, { stdio: 'pipe' });
  // Stage deletions from root
  for (const file of rootFiles) {
    try { execSync(`git rm --cached ${file} 2>/dev/null || true`, { stdio: 'pipe' }); } catch (e) {}
  }
  const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
  if (diff) {
    execSync(`git commit -m "reorganise: move ${moved} scripts to scripts/, update yml references"`, { stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log(`  Committed and pushed.`);
  } else {
    console.log('  Nothing staged to commit.');
  }
} catch (e) {
  console.error('  Git error:', e.message);
}

console.log('\n✅ Reorganisation complete.');
console.log(`   ${moved} scripts moved to scripts/`);
console.log(`   ${transformed} scripts updated with ROOT constant`);
console.log(`   ${ymlUpdated} workflow files updated`);
console.log('\nNote: delete reorganise-repo.js from root when done (or move it manually).');
