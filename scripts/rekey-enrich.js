// scripts/rekey-enrich.js
//
// 3b-1 of the api-canonical migration. ADDITIVE ONLY: adds spectatorIds[] to
// player files already keyed by their api id. Diverged-new files (top-level
// apiId != filename) are SKIPPED — 3b-2 relocates those.
//
// SINGLE JOB: processes all 256 buckets in one process and commits ONCE at the
// end. No matrix, no per-shard pushes, no concurrent-push contention. Idempotent
// (re-running only rewrites a file whose spectatorIds actually change), so it
// safely resumes a partial earlier run.
//
// Usage:
//   node scripts/rekey-enrich.js                # all buckets, one commit
//   node scripts/rekey-enrich.js --dry-run      # count what would change, no writes/commit
//   node scripts/rekey-enrich.js --bucket 3a    # a single bucket (testing)

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { TRUNC_LEN, isFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const INVERSE_DIR = path.join(ROOT, 'players', 'alias-inverse');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = has('--dry-run');
const NO_COMMIT = has('--no-commit') || DRY;
const ONE = val('--bucket', null);

const HEX = '0123456789abcdef';
const ALL_BUCKETS = [];
for (const a of HEX) for (const b of HEX) ALL_BUCKETS.push(a + b);

function git(a) { return execFileSync('git', a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// One commit, one push. Copies the proven fetch-profile-stats jitter, PLUS a
// `git merge --abort` cleanup each attempt — yours doesn't need it (its shards
// touch disjoint dirs so merges never conflict); this one can touch files another
// pusher also changed, so a merge can stick and must be cleared before retrying.
async function commit(paths, message) {
  if (NO_COMMIT || !paths.length) return;
  git(['add', ...paths]);                          // explicit paths, never -A
  if (!git(['diff', '--cached', '--shortstat']).trim()) { process.stderr.write('nothing staged\n'); return; }
  git(['commit', '-m', message]);                  // single-line

  const MAX = 15;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      try { git(['merge', '--abort']); } catch (_) { /* no merge in progress */ }
      git(['fetch', 'origin', 'main']);
      git(['merge', '-X', 'ours', '--no-edit', 'origin/main']); // never rebase
      git(['push', 'origin', 'HEAD:main']);
      return;
    } catch (err) {
      try { git(['merge', '--abort']); } catch (_) { /* leave a clean tree for the next attempt */ }
      if (attempt === MAX) { process.stderr.write(`push failed after ${MAX} attempts: ${err.message}\n`); process.exit(1); }
      const jitter = Math.floor(Math.random() * 15000) + attempt * 3000; // 3–30s, increasing
      await sleep(jitter);
    }
  }
}

function enrichBucket(bucket, totals) {
  const shardDir = path.join(PLAYERS_DIR, bucket);
  if (!fs.existsSync(shardDir)) return false;

  const invFile = path.join(INVERSE_DIR, bucket + '.json');
  const inverse = fs.existsSync(invFile) ? JSON.parse(fs.readFileSync(invFile, 'utf8')) : {};

  let touched = false;
  for (const fname of fs.readdirSync(shardDir)) {
    if (!fname.endsWith('.json')) continue;
    const uuid = fname.slice(0, -5);
    if (!isFullUuid(uuid)) { totals.skippedNonUuid++; continue; }
    totals.scanned++;

    const fpath = path.join(shardDir, fname);
    const player = JSON.parse(fs.readFileSync(fpath, 'utf8'));

    // diverged-new: keyed by a spectator id; its api id is elsewhere. 3b-2 handles it.
    if (player.apiId && player.apiId !== uuid) { totals.skippedDiverged++; continue; }

    const spectators = (inverse[uuid] ? inverse[uuid].slice() : [uuid.slice(0, TRUNC_LEN)]).sort();
    const current = Array.isArray(player.spectatorIds) ? player.spectatorIds.slice().sort() : null;
    if (current && current.length === spectators.length && current.every((v, i) => v === spectators[i])) {
      totals.unchanged++; continue;                // idempotent no-op
    }

    player.spectatorIds = spectators;
    if (!DRY) fs.writeFileSync(fpath, JSON.stringify(player));
    totals.changed++;
    touched = true;
  }
  return touched;
}

async function main() {
  const buckets = ONE ? [ONE.toLowerCase()] : ALL_BUCKETS;
  const totals = { scanned: 0, changed: 0, unchanged: 0, skippedDiverged: 0, skippedNonUuid: 0 };
  const changedDirs = [];

  for (const bucket of buckets) {
    if (enrichBucket(bucket, totals)) changedDirs.push(path.join(PLAYERS_DIR, bucket));
  }

  await commit(changedDirs, `rekey-enrich: spectatorIds for ${totals.changed} players (3b-1)`);

  const md = [
    `## rekey-enrich — overall report${DRY ? ' (dry run — no writes)' : ''}`,
    '',
    '| metric | value |',
    '|---|---|',
    `| buckets processed | ${buckets.length} |`,
    `| player files scanned | ${totals.scanned} |`,
    `| enriched (spectatorIds set) | ${totals.changed} |`,
    `| already correct (no-op) | ${totals.unchanged} |`,
    `| skipped: diverged-new (3b-2 handles) | ${totals.skippedDiverged} |`,
  ];
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n'); } catch (e) { /* non-fatal */ }
  }
  process.stderr.write(`\nDONE. scanned=${totals.scanned} changed=${totals.changed} noop=${totals.unchanged} divergedSkipped=${totals.skippedDiverged}${DRY ? ' (dry-run)' : ''}\n`);
}

main().catch(e => { process.stderr.write(String((e && e.stack) || e) + '\n'); process.exit(1); });
