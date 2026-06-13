// scripts/patch-team-stats-fixtures.js
// One-time patch: adds fixtures: [] to any team entry in team-stats/bv/
// that is missing the fixtures field (teams with registrations but no games).
// Safe to re-run — skips files with no changes.

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TEAM_STATS    = 'team-stats/bv';
const PROGRESS_FILE = 'patch-fixtures-progress.json';
const COMMIT_EVERY  = 200;

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJSON(p, d) { fs.writeFileSync(p, JSON.stringify(d)); }

function gitCommit(msg) {
  try {
    execSync(`git add ${TEAM_STATS} ${PROGRESS_FILE}`, { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${msg}"`, { stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log(`  committed: ${msg}`);
  } catch (e) { console.error('  git error:', e.message); }
}

async function main() {
  console.log('patch-team-stats-fixtures.js');
  console.log('============================');

  let progress = { completed: [] };
  if (fs.existsSync(PROGRESS_FILE)) {
    progress = readJSON(PROGRESS_FILE);
    console.log(`Resuming: ${progress.completed.length} files already patched`);
  }

  const files = fs.readdirSync(TEAM_STATS).filter(f => f.endsWith('.json'));
  let patched = 0, skipped = 0, teamsFixed = 0, sinceCommit = 0;

  for (const file of files) {
    if (progress.completed.includes(file)) { skipped++; continue; }

    const fp = path.join(TEAM_STATS, file);
    const ts = readJSON(fp);
    let changed = false;

    for (const entry of Object.values(ts)) {
      if (!Array.isArray(entry.fixtures)) {
        entry.fixtures = [];
        changed = true;
        teamsFixed++;
      }
    }

    if (changed) writeJSON(fp, ts);
    progress.completed.push(file);
    patched++;
    sinceCommit++;

    if (patched % 200 === 0) console.log(`  ${patched}/${files.length} files processed`);

    if (sinceCommit >= COMMIT_EVERY) {
      writeJSON(PROGRESS_FILE, progress);
      gitCommit(`patch-fixtures: ${patched}/${files.length} files`);
      sinceCommit = 0;
    }
  }

  writeJSON(PROGRESS_FILE, progress);
  gitCommit(`patch-fixtures: complete — ${teamsFixed} teams fixed across ${patched} changed files`);

  console.log(`\nDone. ${teamsFixed} team entries patched across ${patched} files (${skipped} already done).`);
}

main().catch(e => { console.error(e); process.exit(1); });
