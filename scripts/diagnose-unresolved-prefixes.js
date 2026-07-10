// scripts/diagnose-unresolved-prefixes.js
//
// READ-ONLY. fix-uuid-prefix-length.js just reported 30,100,994 upgraded /
// 2,623,011 unresolved out of 32,724,005 total 10-char ids in games/bv/*.json
// -- an ~8% failure rate. audit-uuid-collisions.js already proved there are
// only 3 real collisions (6 players) system-wide at length 10, which cannot
// explain anywhere near 2.6M failed field occurrences. Something else is
// going on -- most likely players/indexes/{shard}.json not being a complete
// map of every uuid that ever appears in a game box score (e.g. players
// never fully processed into the index), but this is a hypothesis, not a
// finding yet.
//
// This script re-attempts the exact same resolution fix-uuid-prefix-length.js
// does, but instead of writing a raw record per FAILED FIELD OCCURRENCE
// (which is what produced the 204.97MB report that GitHub rejected), it:
//   1. Dedupes down to DISTINCT failing prefixes (likely a much smaller
//      number than 2.6M -- that count is field occurrences, not unique
//      players).
//   2. Classifies each distinct failing prefix into exactly one bucket:
//        - 'shard-index-missing'  -- players/indexes/{shard}.json doesn't
//                                     exist at all for this prefix's shard
//        - 'known-collision'      -- matches one of the 3 already-confirmed
//                                     collisions from audit-uuid-collisions.js
//        - 'not-in-index'         -- the shard's index file exists and has
//                                     no collision here, the prefix simply
//                                     never appears as a key
//   3. Writes a small summary (counts per bucket + up to SAMPLE_PER_BUCKET
//      examples per bucket, with one real occurrence sid/gameId/field each)
//      -- not the full 2.6M list. This is designed to comfortably fit in a
//      single commit.
//
// Writes NOTHING to games/. Makes no changes to any file this repo serves.
//
// Run: node scripts/diagnose-unresolved-prefixes.js

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT         = path.join(__dirname, '..');
const GAMES_DIR     = path.join(ROOT, 'games', 'bv');
const PLAYERS_IDX   = path.join(ROOT, 'players', 'indexes');
const OUT_FILE      = path.join(ROOT, 'reports', 'unresolved-prefix-diagnosis.json');
const SAMPLE_PER_BUCKET = 25;

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

// shard -> 'missing' | Map<prefix, fullUuid|COLLISION>
const shardMaps = new Map();
const shardMissing = new Set();
const COLLISION = Symbol('collision');

function loadOldShardMap(shard) {
  if (shardMaps.has(shard)) return shardMaps.get(shard);
  const indexPath = path.join(PLAYERS_IDX, `${shard}.json`);
  if (!fs.existsSync(indexPath)) {
    shardMissing.add(shard);
    shardMaps.set(shard, null); // null = shard index file missing entirely
    return null;
  }
  const map = new Map();
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    for (const fullUuid of Object.keys(index)) {
      if (typeof fullUuid !== 'string' || fullUuid.length !== FULL_LEN) continue;
      const prefix = fullUuid.slice(0, OLD_LEN);
      const existing = map.get(prefix);
      if (existing === COLLISION) continue;
      if (existing !== undefined && existing !== fullUuid) { map.set(prefix, COLLISION); continue; }
      map.set(prefix, fullUuid);
    }
  } catch (e) {
    console.error(`  failed to parse ${shard}.json: ${e.message}`);
  }
  shardMaps.set(shard, map);
  return map;
}

// Returns 'resolved' | 'shard-index-missing' | 'known-collision' | 'not-in-index'
function classify(id) {
  const shard = id.slice(0, 2).toLowerCase();
  const map = loadOldShardMap(shard);
  if (map === null) return 'shard-index-missing';
  const result = map.get(id);
  if (result === COLLISION) return 'known-collision';
  if (result === undefined) return 'not-in-index';
  return 'resolved';
}

function main() {
  const start = Date.now();
  console.log('diagnose-unresolved-prefixes.js -- read-only');
  console.log('-'.repeat(60));

  const buckets = {
    'shard-index-missing': new Map(), // prefix -> { count, sample: [{sid,gameId,field}] }
    'known-collision':     new Map(),
    'not-in-index':        new Map(),
  };
  let totalFieldsSeen = 0;
  let totalResolved = 0;
  let totalFailed = 0;

  const allSids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
  console.log(`  ${allSids.length} season files to scan`);

  function checkField(v, sid, gameId, ctx) {
    if (typeof v !== 'string' || v.length !== OLD_LEN) return;
    totalFieldsSeen++;
    const result = classify(v);
    if (result === 'resolved') { totalResolved++; return; }
    totalFailed++;
    const bucket = buckets[result];
    if (!bucket.has(v)) bucket.set(v, { count: 0, sample: [] });
    const entry = bucket.get(v);
    entry.count++;
    if (entry.sample.length < 3) entry.sample.push({ sid, gameId, field: ctx });
  }

  let scanned = 0;
  for (const sid of allSids) {
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${sid}.json`), 'utf8')); }
    catch { continue; }
    for (const [gameId, game] of Object.entries(gf.games || {})) {
      for (const p of (game.p || []))  checkField(p.id,        sid, gameId, 'p.id');
      for (const p of (game.hp || [])) checkField(p.profileID, sid, gameId, 'hp.profileID');
      for (const p of (game.ap || [])) checkField(p.profileID, sid, gameId, 'ap.profileID');
    }
    scanned++;
    if (scanned % 200 === 0) process.stdout.write(`  ${scanned}/${allSids.length} seasons scanned\r`);
  }

  console.log(`\n  ${scanned}/${allSids.length} seasons scanned`);
  console.log('-'.repeat(60));
  console.log(`  Total 10-char fields seen : ${totalFieldsSeen.toLocaleString()}`);
  console.log(`  Resolved                  : ${totalResolved.toLocaleString()}`);
  console.log(`  Failed                    : ${totalFailed.toLocaleString()}`);
  console.log(`  Shards with no index file : ${shardMissing.size}${shardMissing.size ? ' -- ' + [...shardMissing].sort().join(',') : ''}`);
  for (const [name, map] of Object.entries(buckets)) {
    const totalOccurrences = [...map.values()].reduce((s, v) => s + v.count, 0);
    console.log(`  ${name.padEnd(20)}: ${map.size.toLocaleString()} distinct prefixes, ${totalOccurrences.toLocaleString()} field occurrences`);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    totalFieldsSeen,
    totalResolved,
    totalFailed,
    shardsWithNoIndexFile: [...shardMissing].sort(),
    buckets: {},
  };
  for (const [name, map] of Object.entries(buckets)) {
    const entries = [...map.entries()].map(([prefix, v]) => ({ prefix, count: v.count, sample: v.sample }));
    entries.sort((a, b) => b.count - a.count);
    summary.buckets[name] = {
      distinctPrefixes: map.size,
      totalOccurrences: entries.reduce((s, e) => s + e.count, 0),
      topExamples: entries.slice(0, SAMPLE_PER_BUCKET),
    };
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2), 'utf8');
  const sizeMB = (fs.statSync(OUT_FILE).size / (1024 * 1024)).toFixed(2);
  console.log(`\n  Report: reports/unresolved-prefix-diagnosis.json (${sizeMB} MB)`);
  console.log(`  Elapsed: ${Math.round((Date.now() - start) / 1000)}s`);

  console.log('\n  Committing report...');
  gitCommit('diagnose-unresolved-prefixes: report committed', ['reports/']);
}

main();
