// scripts/audit-uuid-collisions.js
//
// READ-ONLY. Scans every players/indexes/{shard}.json (all 256 shards) and
// reports every uuid prefix collision at a given length -- every pair (or
// larger group) of distinct full uuids whose first N characters are
// identical. Touches nothing in games/leaderboard/team-stats/search or any
// player file -- this is a diagnostic only.
//
// Why this exists: the 2026-07-10 uuid-prefix migration used TRUNC_LEN=10,
// which -- because a uuid's first hyphen sits at string index 8 -- is really
// only 9 real hex digits of entropy (36 bits), not 10 (40 bits) as originally
// assumed. True birthday-paradox collision probability at 36 bits across
// ~370k players is ~63%, not the ~5-6% first estimated for 40 bits. This
// script measures the real, current scope of the problem rather than
// guessing at it:
//   node scripts/audit-uuid-collisions.js --len=10   (old length -- how bad was it)
//   node scripts/audit-uuid-collisions.js --len=13   (new length -- confirm the fix holds)
//
// Writes a report to reports/uuid-collisions-len{N}.json and commits it, so
// it's visible in the repo rather than only in a runner's ephemeral log.

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_IDX = path.join(ROOT, 'players', 'indexes');
const FULL_LEN    = 36;

const lenArg = process.argv.find(a => a.startsWith('--len='));
const LEN = lenArg ? parseInt(lenArg.split('=')[1], 10) : 10;

function isFullUuid(id) { return typeof id === 'string' && id.length === FULL_LEN; }

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

function main() {
  const start = Date.now();
  console.log(`audit-uuid-collisions.js -- prefix length ${LEN}`);
  console.log('-'.repeat(60));

  if (!fs.existsSync(PLAYERS_IDX)) {
    console.error(`  FAILED: ${PLAYERS_IDX} not found -- nothing to scan`);
    process.exit(1);
  }

  const shardFiles = fs.readdirSync(PLAYERS_IDX)
    .filter(f => /^[0-9a-f]{2}\.json$/.test(f))
    .sort();

  let totalPlayers = 0;
  let totalCollisions = 0;
  const report = [];

  for (const file of shardFiles) {
    const shard = file.replace('.json', '');
    let index;
    try { index = JSON.parse(fs.readFileSync(path.join(PLAYERS_IDX, file), 'utf8')); }
    catch (e) { console.error(`  FAILED to read ${file}: ${e.message}`); continue; }

    const map = new Map(); // prefix -> [fullUuid, ...]
    for (const fullUuid of Object.keys(index)) {
      if (!isFullUuid(fullUuid)) continue;
      totalPlayers++;
      const prefix = fullUuid.slice(0, LEN);
      if (!map.has(prefix)) { map.set(prefix, [fullUuid]); continue; }
      map.get(prefix).push(fullUuid);
    }

    for (const [prefix, uuids] of map) {
      if (uuids.length > 1) {
        totalCollisions++;
        report.push({ shard, prefix, uuids });
        console.log(`  COLLISION shard ${shard}: prefix "${prefix}" -- ${uuids.length}-way: ${uuids.join(', ')}`);
      }
    }
  }

  const outPath = path.join(ROOT, 'reports', `uuid-collisions-len${LEN}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    len: LEN,
    generatedAt: new Date().toISOString(),
    totalPlayers,
    totalCollisions,
    report,
  }, null, 2), 'utf8');

  console.log('-'.repeat(60));
  console.log(`  Prefix length   : ${LEN}`);
  console.log(`  Players scanned : ${totalPlayers.toLocaleString()}`);
  console.log(`  Collisions found: ${totalCollisions}`);
  console.log(`  Report          : reports/uuid-collisions-len${LEN}.json`);
  console.log(`  Elapsed         : ${Math.round((Date.now() - start) / 1000)}s`);

  console.log('\n  Committing report...');
  gitCommit(`audit-uuid-collisions: len=${LEN}, ${totalCollisions} collisions found across ${totalPlayers.toLocaleString()} players`, ['reports/']);
}

main();
