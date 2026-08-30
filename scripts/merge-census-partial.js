// scripts/merge-census-partial.js
//
// Folds a saved partial census report into the committed full report.
//
// WHY IT EXISTS. On 2026-08-30 a two-shard re-run overwrote a completed
// 254-shard sweep, because the aggregator wrote whatever artifacts THIS run had
// produced. The sweep was restored from git, and the two-shard result was saved
// by hand before the restore. This puts those rows back without re-running the
// shards.
//
// The aggregator itself now merges per shard, so this situation cannot recur and
// this script is a one-off. Delete it once the rows are in.
//
// It appends rows that are not already present, keyed on the player id, and
// adjusts the totals. It never removes a row and never rewrites one that exists —
// if a player is already in the report, the saved copy is ignored.

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; })
);

const TARGET  = path.join(ROOT, ARGS.target || 'reports/wrongly-keyed-census.json');
const PARTIAL = ARGS.partial ? path.join(ROOT, ARGS.partial) : null;
const APPLY   = !!ARGS.apply;

if (!PARTIAL) {
  console.error('FATAL: --partial=<path to the saved partial report> is required');
  process.exit(1);
}

function readJson(p, label) {
  if (!fs.existsSync(p)) { console.error(`FATAL: ${label} not found at ${path.relative(ROOT, p)}`); process.exit(1); }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`FATAL: ${label} is not readable JSON — ${e.message}`); process.exit(1); }
}

const target  = readJson(TARGET,  'target report');
const partial = readJson(PARTIAL, 'partial report');

const tWrong  = Array.isArray(target.wrong) ? target.wrong : [];
const tFailed = Array.isArray(target.recoveryFailed) ? target.recoveryFailed : [];
const pWrong  = Array.isArray(partial.wrong) ? partial.wrong : [];
const pFailed = Array.isArray(partial.recoveryFailed) ? partial.recoveryFailed : [];

console.log(`target  : ${path.relative(ROOT, TARGET)}`);
console.log(`          ${tWrong.length} wrong, ${tFailed.length} recovery-failed`);
console.log(`partial : ${path.relative(ROOT, PARTIAL)}`);
console.log(`          ${pWrong.length} wrong, ${pFailed.length} recovery-failed`);

// A partial that is LARGER than the target is the overwrite going the wrong way.
// Refuse rather than destroy the bigger file a second time.
if (pWrong.length > tWrong.length) {
  console.error(`\nFATAL: the partial holds MORE rows than the target (${pWrong.length} > ${tWrong.length}).`);
  console.error('That is the shape of the accident this script exists to repair, running backwards.');
  console.error('Check that --target is the full sweep and --partial is the small saved file.');
  process.exit(1);
}

const haveWrong  = new Set(tWrong.map(r => r.resolvesTo));
const haveFailed = new Set(tFailed.map(r => r.uuid));

const addWrong  = pWrong.filter(r => r.resolvesTo && !haveWrong.has(r.resolvesTo));
const addFailed = pFailed.filter(r => r.uuid && !haveFailed.has(r.uuid));
const already   = pWrong.length - addWrong.length;

console.log(`\nto add  : ${addWrong.length} wrong, ${addFailed.length} recovery-failed`);
if (already) console.log(`          ${already} row(s) already present and left alone`);
for (const r of addWrong) {
  console.log(`  + ${r.resolvesTo}  ${JSON.stringify(r.ourName || r.name)}  -> ${r.apiId}  by ${r.pairedBy || 'name'}`);
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to write.');
  process.exit(0);
}

target.wrong = [...tWrong, ...addWrong];
target.recoveryFailed = [...tFailed, ...addFailed];
target.totals = target.totals || {};
target.totals.apiIdsRecovered = target.wrong.length;
target.totals.recoveryFailed  = target.recoveryFailed.length;
target.totals.wronglyKeyed    = (target.totals.wronglyKeyed || 0) + ((partial.totals && partial.totals.wronglyKeyed) || 0);
target.totals.wronglyKeyedPrivate = (target.totals.wronglyKeyedPrivate || 0) + ((partial.totals && partial.totals.wronglyKeyedPrivate) || 0);
target.totals.wronglyKeyedPublic  = (target.totals.wronglyKeyedPublic  || 0) + ((partial.totals && partial.totals.wronglyKeyedPublic)  || 0);
// The scan counts too. Leaving these at the target's figures would leave the
// report internally inconsistent — reporting rows from shards whose player files
// it claims never to have scanned.
target.totals.playerFilesScanned = (target.totals.playerFilesScanned || 0) + ((partial.totals && partial.totals.playerFilesScanned) || 0);
target.totals.privateTrue        = (target.totals.privateTrue        || 0) + ((partial.totals && partial.totals.privateTrue)        || 0);
target.totals.candidates         = (target.totals.candidates         || 0) + ((partial.totals && partial.totals.candidates)         || 0);
target.totals.keysUnknown        = Array.isArray(target.unknownKeys) ? target.unknownKeys.length : (target.totals.keysUnknown || 0);
// shardsReported is a count of shards, and the partial covered the ones it did
// not list as missing.
target.totals.shardsReported     = (target.totals.shardsReported || 0) + (Array.isArray(partial.shardsMissing) ? 256 - partial.shardsMissing.length : 0);

// The shards the partial covered are no longer missing. Its shardsMissing lists
// what it did NOT have, so the shards it DID have are the complement — derived,
// not read from a field that might not exist.
const partialHad = [];
for (let i = 0; i < 256; i++) {
  const sh = i.toString(16).padStart(2, '0');
  if (Array.isArray(partial.shardsMissing) && !partial.shardsMissing.includes(sh)) partialHad.push(sh);
}
if (Array.isArray(target.shardsMissing) && partialHad.length) {
  const before = target.shardsMissing.length;
  target.shardsMissing = target.shardsMissing.filter(sh => !partialHad.includes(sh));
  target.totals.shardsMissing = target.shardsMissing.length;
  target.complete = target.shardsMissing.length === 0;
  console.log(`\nshards no longer missing: ${partialHad.join(', ')}  (${before} -> ${target.shardsMissing.length})`);
}

if (Array.isArray(partial.unknownKeys) && partial.unknownKeys.length) {
  const have = new Set(target.unknownKeys || []);
  const add = partial.unknownKeys.filter(k => !have.has(k));
  target.unknownKeys = [...(target.unknownKeys || []), ...add];
  target.totals.keysUnknown = target.unknownKeys.length;
  console.log(`unknown keys carried over: ${add.length}`);
}

target.mergedAt = new Date().toISOString();
fs.writeFileSync(TARGET, JSON.stringify(target, null, 2));
console.log('\n──── TOTALS AFTER MERGE ────');
for (const [k, v] of Object.entries(target.totals)) console.log(`  ${k}: ${typeof v === 'number' ? v.toLocaleString() : v}`);
console.log(`\nwrote ${path.relative(ROOT, TARGET)} — ${target.wrong.length} row(s) for the seeder`);
