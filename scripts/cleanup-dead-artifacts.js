// scripts/cleanup-dead-artifacts.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Confirmed zero-risk deletion targets (README.md repo structure, 2026-07-09):
// both live at repo ROOT, not under data/ — discover-reduce-manifest.json predates/
// is excluded from the June 2026 data/ migration; team-lookup/ has no consumer
// anywhere in StatTrack's fetch paths and is superseded by team-stats/ + team-index.json.
const TARGETS = [
  path.join(ROOT, 'discover-reduce-manifest.json'),
  path.join(ROOT, 'team-lookup'),
];

function dirStats(p) {
  if (!fs.existsSync(p)) return { exists: false, files: 0, bytes: 0 };
  const stat = fs.statSync(p);
  if (stat.isFile()) return { exists: true, files: 1, bytes: stat.size };
  let files = 0;
  let bytes = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        files++;
        bytes += fs.statSync(full).size;
      }
    }
  }
  return { exists: true, files, bytes };
}

function fmtMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function run(cmd) {
  console.log('> ' + cmd);
  // maxBuffer bumped as defense-in-depth, but the real fix is that every
  // command below is invoked in its quiet/no-stat form. git commit (without
  // -q) prints a "delete mode <mode> <path>" line per deleted file, and git
  // merge (without --no-stat) prints a full per-file diffstat by default —
  // both blow well past 1MB of stdout at 355k deletions, which is exactly
  // the ENOBUFS class of bug this project already guards against for
  // `git diff --stat` (use --shortstat instead). Confirmed against a scratch
  // repo before landing this fix: git commit -q and git merge --no-stat both
  // produce near-zero stdout regardless of file count, with identical
  // resulting commit/merge behavior.
  return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 10 * 1024 * 1024 })
    .toString()
    .trim();
}

function gitCommit(targets, message) {
  const relPaths = targets.map((p) => path.relative(ROOT, p));
  run(`git add -- ${relPaths.map((p) => `"${p}"`).join(' ')}`);

  // Read-back diagnostic before doing anything irreversible — prove what's
  // actually staged rather than assuming, per project directive.
  const staged = run('git diff --cached --shortstat');
  console.log('Staged change (shortstat): ' + (staged || '(nothing staged)'));
  if (!staged) {
    console.error('ABORTING — nothing staged after git add. Refusing to commit an empty change.');
    process.exit(1);
  }

  run('git fetch origin main');
  run('git merge -X ours FETCH_HEAD --no-edit --no-stat');
  run(`git commit -q -m "${message}"`);
  run('git log -1 --oneline'); // read-back proof the commit actually landed, cheap and small
  run('git push origin main');
}

function main() {
  console.log('=== cleanup-dead-artifacts: pre-deletion audit ===');
  const before = TARGETS.map((t) => ({ target: t, ...dirStats(t) }));
  for (const b of before) {
    console.log(
      `${path.relative(ROOT, b.target)}: exists=${b.exists} files=${b.files} size=${fmtMB(b.bytes)}`
    );
  }

  const missing = before.filter((b) => !b.exists);
  if (missing.length) {
    console.error('ABORTING — expected target(s) not found on disk. Nothing deleted, nothing committed:');
    missing.forEach((m) => console.error('  ' + path.relative(ROOT, m.target)));
    process.exit(1);
  }

  for (const t of TARGETS) {
    const stat = fs.statSync(t);
    if (stat.isDirectory()) fs.rmSync(t, { recursive: true, force: true });
    else fs.rmSync(t, { force: true });
    console.log(`Deleted from working tree: ${path.relative(ROOT, t)}`);
  }

  console.log('=== post-deletion verification ===');
  for (const t of TARGETS) {
    if (fs.existsSync(t)) {
      console.error(`FAILED TO DELETE (still present): ${path.relative(ROOT, t)}`);
      process.exit(1);
    }
  }

  const totalBytes = before.reduce((sum, b) => sum + b.bytes, 0);
  const totalFiles = before.reduce((sum, b) => sum + b.files, 0);
  const summary = `Remove dead artifacts: discover-reduce-manifest.json + team-lookup/ (${fmtMB(totalBytes)}, ${totalFiles} files)`;
  console.log(`Total recovered from working tree: ${fmtMB(totalBytes)} across ${totalFiles} files`);

  gitCommit(TARGETS, summary);

  console.log('=== done ===');
}

main();
