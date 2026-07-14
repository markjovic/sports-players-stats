// scripts/rekey-enrich.js
//
// 3b-1 of the api-canonical migration. ADDITIVE ONLY: adds spectatorIds[] to
// player files that are ALREADY keyed by their api id. Never renames, moves, or
// deletes anything. Files that are diverged-new (a top-level apiId that differs
// from the filename) are SKIPPED here — 3b-2 (relocate/merge) handles those.
//
// Idempotent: re-running only rewrites a file whose spectatorIds actually change.
// Matrix-sharded by api prefix: reads players/{bucket}/ + players/alias-inverse/{bucket}.json.
//
// Usage:
//   node scripts/rekey-enrich.js --bucket 3a               # one bucket, commit
//   node scripts/rekey-enrich.js --bucket 3a --dry-run     # count only, no writes/commits
//   node scripts/rekey-enrich.js --bucket 3a --no-commit   # write files, don't commit

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
const BUCKET = val('--bucket', null);

if (!BUCKET) { process.stderr.write('need --bucket XX\n'); process.exit(1); }
const bucket = BUCKET.toLowerCase();

function git(a) { return execFileSync('git', a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
function commit(paths, message) {
  if (NO_COMMIT || !paths.length) return;
  git(['add', ...paths]);                       // explicit paths, never -A
  if (!git(['diff', '--cached', '--shortstat']).trim()) return;
  git(['commit', '-m', message]);               // single-line
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      git(['fetch', 'origin', 'main']);
      git(['merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit']); // never rebase
      git(['push', 'origin', 'HEAD:main']);
      return;
    } catch (e) { if (attempt === 5) throw e; }
  }
}

function main() {
  const shardDir = path.join(PLAYERS_DIR, bucket);
  if (!fs.existsSync(shardDir)) { process.stderr.write(`no players/${bucket}/ — nothing to do\n`); return; }

  const invFile = path.join(INVERSE_DIR, bucket + '.json');
  const inverse = fs.existsSync(invFile) ? JSON.parse(fs.readFileSync(invFile, 'utf8')) : {};

  let scanned = 0, changed = 0, unchanged = 0, skippedDiverged = 0, skippedNonUuid = 0;
  const changedPaths = [];

  for (const fname of fs.readdirSync(shardDir)) {
    if (!fname.endsWith('.json')) continue;
    const uuid = fname.slice(0, -5);
    if (!isFullUuid(uuid)) { skippedNonUuid++; continue; }
    scanned++;

    const fpath = path.join(shardDir, fname);
    const player = JSON.parse(fs.readFileSync(fpath, 'utf8'));

    // diverged-new: this file is keyed by a spectator id, its api id is elsewhere.
    // Leave it for 3b-2; enriching it here would be wrong (wrong key).
    if (player.apiId && player.apiId !== uuid) { skippedDiverged++; continue; }

    const spectators = (inverse[uuid] ? inverse[uuid].slice() : [uuid.slice(0, TRUNC_LEN)]).sort();
    const current = Array.isArray(player.spectatorIds) ? player.spectatorIds.slice().sort() : null;
    if (current && current.length === spectators.length && current.every((v, i) => v === spectators[i])) {
      unchanged++; continue;                      // idempotent no-op
    }

    player.spectatorIds = spectators;
    if (!DRY) fs.writeFileSync(fpath, JSON.stringify(player));
    changedPaths.push(fpath);
    changed++;
  }

  if (changedPaths.length && !NO_COMMIT) {
    commit([shardDir], `rekey-enrich: spectatorIds for ${changed} players in ${bucket}`);
  }

  const md = [
    `## rekey-enrich bucket ${bucket}${DRY ? ' (dry run — no writes)' : ''}`,
    '',
    '| metric | value |',
    '|---|---|',
    `| player files scanned | ${scanned} |`,
    `| enriched (spectatorIds set) | ${changed} |`,
    `| already correct (no-op) | ${unchanged} |`,
    `| skipped: diverged-new (3b-2 handles) | ${skippedDiverged} |`,
  ];
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n'); } catch (e) { /* non-fatal */ }
  }
  process.stderr.write(`\nDONE ${bucket}. scanned=${scanned} changed=${changed} noop=${unchanged} divergedSkipped=${skippedDiverged}${DRY ? ' (dry-run)' : ''}\n`);
}

main();
