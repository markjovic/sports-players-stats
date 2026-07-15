// scripts/repair-aliases.js
//
// 3b-2 pre-step: repair the two alias-index coverage gaps the reconcile found,
// so players/aliases (+ its inverse) is complete and correct BEFORE the migration
// touches any files. READ-ONLY over player files; writes only players/aliases/*.
// No git here — the workflow commits once (aggregator pattern).
//
// Driven verbatim by reports/reconcile-people.json (same discipline APPLY will
// use with rekey-merges.json). Two cases, both from onlyInFilesDetail:
//
//   source === 'file-key'   -> non-diverged api-keyed player missing its identity
//                              alias (post-3a addition). Add trunc(apiId) -> apiId
//                              in bucket apiId[:2]. GUARD: if that key is already
//                              held by a DIFFERENT apiId, that's a real trunc-13
//                              collision — log and skip, never clobber.
//
//   source === 'apiId-field'-> diverged player whose alias was recorded as a stale
//                              identity (apiId set on the file AFTER 3a ran).
//                              spectator = basename(files[0]); rewrite
//                              trunc(spectator) -> real apiId in bucket spectator[:2].
//                              GUARD: only rewrite if the current value is the stale
//                              identity (== spectator) or already correct; anything
//                              else is unexpected — log and skip.
//
// The inverse's bogus keys (e.g. 3d8fb4d6 with no backing file) are NOT touched
// here — build-alias-inverse.js regenerates the whole inverse from the fixed
// aliases in the next workflow step, which drops them automatically.
//
// Usage:
//   node scripts/repair-aliases.js            # apply
//   node scripts/repair-aliases.js --dry-run  # compute + report, no alias writes

'use strict';

const fs = require('fs');
const path = require('path');
// Same lib the builder uses — never hardcode TRUNC_LEN.
const { TRUNC_LEN, isFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');
const ALIASES_DIR = path.join(ROOT, 'players', 'aliases');
const RECONCILE_PATH = path.join(ROOT, 'reports', 'reconcile-people.json');
const OUT_PATH = path.join(ROOT, 'reports', 'alias-repair.json');

const SHARD_PREFIX_LEN = 2; // matches build-alias-index.js

const DRY = process.argv.includes('--dry-run');

// Copied verbatim from build-alias-index.js — do not reimplement differently.
function trunc(id) {
  return String(id).slice(0, TRUNC_LEN);
}

function bucketOf(id) {
  return String(id).slice(0, SHARD_PREFIX_LEN).toLowerCase();
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Load a bucket alias file into a plain object (or {} if it doesn't exist yet).
const bucketCache = new Map();
function loadBucket(bucket) {
  if (bucketCache.has(bucket)) return bucketCache.get(bucket);
  const p = path.join(ALIASES_DIR, bucket + '.json');
  let map;
  try {
    map = readJson(p);
  } catch (e) {
    if (e.code === 'ENOENT') map = {};
    else throw new Error(`Unparseable alias bucket ${bucket}.json: ${e.message}`);
  }
  bucketCache.set(bucket, map);
  return map;
}

// Write format identical to build-alias-index.js writeBucket(): sorted keys, minified.
function writeBucket(bucket, map) {
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  fs.mkdirSync(ALIASES_DIR, { recursive: true });
  fs.writeFileSync(path.join(ALIASES_DIR, bucket + '.json'), JSON.stringify(sorted));
}

function specIdFromFile(rel) {
  // rel is "<bucket>/<uuid>.json" as emitted by reconcile-people.js
  const base = rel.split('/').pop();
  return base.endsWith('.json') ? base.slice(0, -5) : base;
}

function main() {
  const report = readJson(RECONCILE_PATH);
  const detail = Array.isArray(report.onlyInFilesDetail) ? report.onlyInFilesDetail : [];

  const result = {
    generatedAt: new Date().toISOString(),
    dryRun: DRY,
    input: {
      reconcileGeneratedAt: report.generatedAt || null,
      onlyInFiles: report.counts ? report.counts.onlyInFiles : null,
      onlyInInverse: report.counts ? report.counts.onlyInInverse : null
    },
    identityAdded: 0,
    identityAlreadyPresent: 0,
    divergedFixed: 0,
    divergedAlreadyCorrect: 0,
    skippedNotFullUuid: [],
    truncCollisions: [],      // real trunc-13 clashes — key held by a different apiId
    unexpectedDiverged: [],   // stale-fix target whose current value is neither identity nor apiId
    changedBuckets: []
  };

  const changed = new Set();

  for (const e of detail) {
    const apiId = e.apiId;
    if (!isFullUuid(apiId)) {
      result.skippedNotFullUuid.push({ apiId, source: e.source });
      continue;
    }

    if (e.source === 'file-key') {
      // Identity add: trunc(apiId) -> apiId in bucket apiId[:2].
      const bucket = bucketOf(apiId);
      const key = trunc(apiId);
      const map = loadBucket(bucket);
      const cur = map[key];
      if (cur === undefined) {
        if (!DRY) map[key] = apiId;
        result.identityAdded++;
        changed.add(bucket);
      } else if (cur === apiId) {
        result.identityAlreadyPresent++;
      } else {
        // Different apiId already holds this 13-char key: genuine truncation collision.
        result.truncCollisions.push({ bucket, key, existing: cur, wanted: apiId });
      }
    } else if (e.source === 'apiId-field') {
      // Diverged stale-identity fix: rewrite trunc(spectator) -> real apiId.
      const files = Array.isArray(e.files) ? e.files : [];
      if (!files.length) {
        result.unexpectedDiverged.push({ apiId, reason: 'no files in detail' });
        continue;
      }
      const spectator = specIdFromFile(files[0]);
      if (!isFullUuid(spectator)) {
        result.skippedNotFullUuid.push({ apiId, spectator, source: e.source });
        continue;
      }
      const bucket = bucketOf(spectator);
      const key = trunc(spectator);
      const map = loadBucket(bucket);
      const cur = map[key];
      if (cur === apiId) {
        result.divergedAlreadyCorrect++;
      } else if (cur === spectator || cur === undefined) {
        // stale identity (points to itself) or absent — safe to set to the real apiId
        if (!DRY) map[key] = apiId;
        result.divergedFixed++;
        changed.add(bucket);
      } else {
        // points somewhere unexpected — do NOT clobber
        result.unexpectedDiverged.push({ bucket, key, spectator, current: cur, wanted: apiId });
      }
    } else {
      result.unexpectedDiverged.push({ apiId, reason: `unknown source "${e.source}"` });
    }
  }

  if (!DRY) {
    for (const bucket of changed) writeBucket(bucket, loadBucket(bucket));
  }
  result.changedBuckets = [...changed].sort();

  // Cross-check: file-key adds + diverged fixes should reconcile against onlyInFiles.
  const handled = result.identityAdded + result.identityAlreadyPresent +
                  result.divergedFixed + result.divergedAlreadyCorrect;
  result.crossCheck = {
    detailEntries: detail.length,
    handled,
    unhandled: result.truncCollisions.length + result.unexpectedDiverged.length + result.skippedNotFullUuid.length,
    reconcilesToOnlyInFiles: report.counts ? (handled + result.truncCollisions.length +
      result.unexpectedDiverged.length + result.skippedNotFullUuid.length === report.counts.onlyInFiles) : null
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2), 'utf8');

  const lines = [];
  lines.push(`## alias repair${DRY ? ' (DRY RUN — no alias writes)' : ''}`);
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| onlyInFiles (input) | ${result.input.onlyInFiles} |`);
  lines.push(`| identity entries added | ${result.identityAdded} |`);
  lines.push(`| identity already present | ${result.identityAlreadyPresent} |`);
  lines.push(`| diverged fixed (stale identity → apiId) | ${result.divergedFixed} |`);
  lines.push(`| diverged already correct | ${result.divergedAlreadyCorrect} |`);
  lines.push(`| **trunc-13 collisions (SKIPPED, review)** | ${result.truncCollisions.length} |`);
  lines.push(`| unexpected diverged targets (SKIPPED) | ${result.unexpectedDiverged.length} |`);
  lines.push(`| not full uuid (SKIPPED) | ${result.skippedNotFullUuid.length} |`);
  lines.push(`| buckets changed | ${result.changedBuckets.length} |`);
  lines.push(`| reconciles to onlyInFiles? | ${result.crossCheck.reconcilesToOnlyInFiles} |`);
  if (result.truncCollisions.length) {
    lines.push('');
    lines.push('### trunc-13 collisions — a different apiId already holds these keys');
    lines.push('');
    lines.push('| bucket | key | existing | wanted |');
    lines.push('| --- | --- | --- | --- |');
    for (const c of result.truncCollisions.slice(0, 50)) {
      lines.push(`| ${c.bucket} | ${c.key} | ${c.existing} | ${c.wanted} |`);
    }
  }
  if (result.unexpectedDiverged.length) {
    lines.push('');
    lines.push('### unexpected diverged targets (not touched)');
    lines.push('');
    lines.push('```');
    lines.push(JSON.stringify(result.unexpectedDiverged.slice(0, 50), null, 2));
    lines.push('```');
  }
  const summary = lines.join('\n') + '\n';
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary); } catch (_) {}
  }

  console.error(`\nDONE. added=${result.identityAdded} fixed=${result.divergedFixed} ` +
    `collisions=${result.truncCollisions.length} unexpected=${result.unexpectedDiverged.length} ` +
    `buckets=${result.changedBuckets.length}${DRY ? ' (dry-run)' : ''}`);
}

main();
