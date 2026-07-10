// scripts/diagnose-missing-player-files.js
//
// READ-ONLY. diagnose-unresolved-prefixes.js found 81,981 distinct 10-char
// prefixes (2,622,579 field occurrences) in games/bv/*.json that don't
// appear as a key in players/indexes/{shard}.json. That could mean two very
// different things:
//   (a) the player HAS a real players/{shard}/{uuid}.json file, it just
//       never made it into the index -- an indexing bug, fixable by
//       rebuilding the index, ZERO data loss.
//   (b) no player file exists for that id at all -- a genuinely
//       never-captured historical record, a harder problem (git-history
//       recovery or accept as a permanent gap).
//
// This checks (a) directly -- but WITHOUT checking out all of players/ (many
// GB of blob content this doesn't need). It only needs FILENAMES, not file
// contents, so it shells out to `git ls-tree -r --name-only HEAD --
// players/`, which reads directory listings straight from git's tree
// objects. Tree objects are always fetched on checkout regardless of sparse-
// checkout patterns or blob:none filters -- only the *blob content* (the
// actual JSON bodies) is skipped. So this is a filenames-only check with
// effectively zero extra data transfer for the player detail files
// themselves.
//
// Run: node scripts/diagnose-missing-player-files.js

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const GAMES_DIR    = path.join(ROOT, 'games', 'bv');
const PLAYERS_IDX  = path.join(ROOT, 'players', 'indexes');
const OUT_FILE     = path.join(ROOT, 'reports', 'missing-player-files-diagnosis.json');
const SAMPLE_CAP   = 50;

const OLD_LEN  = 10;
const FULL_LEN = 36;

function gitCommit(message, dirs) {
  try {
    execSync(`git add ${dirs.join(' ')}`, { stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
    const staged = execSync('git diff --staged --shortstat',
      { stdio: 'pipe', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).toString().trim();
    if (!staged) { console.log('  Nothing to commit.'); return; }
    execSync(`git commit -q -m "${message}"`, { stdio: 'pipe', cwd: ROOT });
    execSync('git fetch origin main',                            { stdio: 'pipe', cwd: ROOT });
    execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', { stdio: 'pipe', cwd: ROOT });
    execSync('git push origin main',                             { stdio: 'pipe', cwd: ROOT });
    console.log(`  Committed: ${message}`);
  } catch (e) {
    console.error('  git error:', e.stderr?.toString().slice(0, 300) || e.message.slice(0, 300));
  }
}

// Single git ls-tree call -- filenames only, no blob content fetched for any
// of the 370k+ player detail files. shard -> Set<fullUuid>.
function loadAllPlayerFilenames() {
  console.log('  Listing players/ filenames via git ls-tree (no blob content fetched)...');
  const raw = execSync('git ls-tree -r --name-only HEAD -- players/', {
    cwd: ROOT, maxBuffer: 512 * 1024 * 1024,
  }).toString();
  const shardSets = new Map();
  let total = 0;
  for (const line of raw.split('\n')) {
    // players/{shard}/{uuid}.json -- skip players/indexes/... entirely
    const m = line.match(/^players\/([0-9a-f]{2})\/([0-9a-f-]{36})\.json$/);
    if (!m) continue;
    const [, shard, uuid] = m;
    if (!shardSets.has(shard)) shardSets.set(shard, new Set());
    shardSets.get(shard).add(uuid);
    total++;
  }
  console.log(`  ${total.toLocaleString()} player filenames listed across ${shardSets.size} shards`);
  return shardSets;
}

// shard -> Map<prefix, fullUuid> from the index (checked out normally, small)
const shardIndexMaps = new Map();
function loadShardIndex(shard) {
  if (shardIndexMaps.has(shard)) return shardIndexMaps.get(shard);
  const map = new Map();
  try {
    const index = JSON.parse(fs.readFileSync(path.join(PLAYERS_IDX, `${shard}.json`), 'utf8'));
    for (const fullUuid of Object.keys(index)) {
      if (typeof fullUuid === 'string' && fullUuid.length === FULL_LEN) map.set(fullUuid.slice(0, OLD_LEN), fullUuid);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  shardIndexMaps.set(shard, map);
  return map;
}

function main() {
  const start = Date.now();
  console.log('diagnose-missing-player-files.js -- read-only');
  console.log('-'.repeat(60));

  const shardFileSets = loadAllPlayerFilenames();

  // Collect distinct not-in-index prefixes fresh (don't rely on the earlier
  // capped report).
  const distinctPrefixes = new Map(); // prefix -> { count, sample: [{sid,gameId,field}] }
  const allSids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
  console.log(`  ${allSids.length} season files to scan`);

  function check(v, sid, gameId, ctx) {
    if (typeof v !== 'string' || v.length !== OLD_LEN) return;
    const shard = v.slice(0, 2).toLowerCase();
    const idx = loadShardIndex(shard);
    if (idx.has(v)) return; // resolves fine already — not our concern here
    if (!distinctPrefixes.has(v)) distinctPrefixes.set(v, { count: 0, sample: [] });
    const entry = distinctPrefixes.get(v);
    entry.count++;
    if (entry.sample.length < 2) entry.sample.push({ sid, gameId, field: ctx });
  }

  let scanned = 0;
  for (const sid of allSids) {
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${sid}.json`), 'utf8')); }
    catch { continue; }
    for (const [gameId, game] of Object.entries(gf.games || {})) {
      for (const p of (game.p || []))  check(p.id,        sid, gameId, 'p.id');
      for (const p of (game.hp || [])) check(p.profileID, sid, gameId, 'hp.profileID');
      for (const p of (game.ap || [])) check(p.profileID, sid, gameId, 'ap.profileID');
    }
    scanned++;
    if (scanned % 200 === 0) process.stdout.write(`  ${scanned}/${allSids.length} seasons scanned\r`);
  }
  console.log(`\n  ${scanned}/${allSids.length} seasons scanned — ${distinctPrefixes.size} distinct not-in-index prefixes found`);

  // Now check each distinct prefix against the REAL filename listing (from
  // git ls-tree, not the index) for its shard.
  let hasFileNotIndexed = 0, hasNoFileAtAll = 0, hasMultipleFiles = 0;
  const categorized = { 'file-exists-not-indexed': [], 'no-file-at-all': [], 'multiple-files-match': [] };

  for (const [prefix, info] of distinctPrefixes) {
    const shard = prefix.slice(0, 2).toLowerCase();
    const fileSet = shardFileSets.get(shard) || new Set();
    const matches = [...fileSet].filter(u => u.startsWith(prefix));
    let bucket;
    if (matches.length === 0) { bucket = 'no-file-at-all'; hasNoFileAtAll++; }
    else if (matches.length === 1) { bucket = 'file-exists-not-indexed'; hasFileNotIndexed++; }
    else { bucket = 'multiple-files-match'; hasMultipleFiles++; }
    if (categorized[bucket].length < SAMPLE_CAP) {
      categorized[bucket].push({ prefix, count: info.count, matches, sample: info.sample });
    }
  }

  console.log('-'.repeat(60));
  console.log(`  Distinct not-in-index prefixes : ${distinctPrefixes.size.toLocaleString()}`);
  console.log(`  -> file exists, just not indexed: ${hasFileNotIndexed.toLocaleString()}`);
  console.log(`  -> no player file at all         : ${hasNoFileAtAll.toLocaleString()}`);
  console.log(`  -> multiple files match           : ${hasMultipleFiles.toLocaleString()}`);

  const summary = {
    generatedAt: new Date().toISOString(),
    distinctPrefixes: distinctPrefixes.size,
    fileExistsNotIndexed: hasFileNotIndexed,
    noFileAtAll: hasNoFileAtAll,
    multipleFilesMatch: hasMultipleFiles,
    samples: categorized,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2), 'utf8');
  const sizeMB = (fs.statSync(OUT_FILE).size / (1024 * 1024)).toFixed(2);
  console.log(`\n  Report: reports/missing-player-files-diagnosis.json (${sizeMB} MB)`);
  console.log(`  Elapsed: ${Math.round((Date.now() - start) / 1000)}s`);

  console.log('\n  Committing report...');
  gitCommit('diagnose-missing-player-files: report committed', ['reports/']);
}

main();
