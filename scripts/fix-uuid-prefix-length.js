// scripts/fix-uuid-prefix-length.js
//
// ONE-OFF: upgrades existing games/bv/{sid}.json data from the old, flawed
// 10-char uuid prefix (9 real hex digits / 36 bits -- a uuid's first hyphen
// sits at string index 8, so slice(0,10) captures that hyphen as one of its
// "10 characters") to the corrected 13-char prefix (12 real hex digits / 48
// bits). See scripts/lib/uuid-prefix.cjs's header comment for the full math.
//
// Self-contained: does NOT read TRUNC_LEN from scripts/lib/uuid-prefix.cjs.
// That module's TRUNC_LEN is being changed to the NEW length as part of this
// same fix, and this script needs to keep resolving the OLD length
// regardless of what the module currently says. OLD_LEN and NEW_LEN below
// are both hardcoded and explicit, on purpose.
//
// For every p[].id / hp[].profileID / ap[].profileID field currently at
// OLD_LEN (10) characters:
//   1. Resolve it to a full uuid via players/indexes/{shard}.json (built
//      fresh per shard here, same collision-safe approach as the shared
//      resolver, pinned to OLD_LEN).
//   2. If resolution is unambiguous: re-truncate the resolved full uuid to
//      NEW_LEN (13) and write that back.
//   3. If resolution fails: leave the field UNCHANGED and record it in the
//      unresolved report -- never guess which of two real people a field
//      actually belonged to.
//
// 2026-07-10, after first live run: 30,100,994 upgraded / 2,623,011
// unresolved (~8%) -- far more than the 3 known collisions (see
// audit-uuid-collisions.js) can explain, and the raw per-occurrence report
// was 204.97MB, which GitHub rejected outright (100MB file limit), so the
// unresolved detail from that run was lost. Root cause of the 8% is still
// being diagnosed (scripts/diagnose-unresolved-prefixes.js) -- separate from
// this script. This version fixes the report-writing bug regardless of that
// diagnosis: the unresolved list is now deduped by DISTINCT PREFIX with a
// capped sample of real occurrences, not one raw record per field
// occurrence, so it can never again produce an oversized file.
//
// Fields already at NEW_LEN or FULL_LEN are left untouched. Idempotent and
// resumable -- same progress-file pattern as migrate-uuid-truncation.js.
//
// IMPORTANT -- deploy order (nightly-crawl + weekly-indexes keep running on
// their own schedule and are NOT paused for this):
//   1. Run this script FIRST, while scripts/lib/uuid-prefix.cjs on main still
//      says TRUNC_LEN=10. It does not need the module updated to run -- see
//      "self-contained" above.
//   2. THEN upload the corrected scripts/lib/uuid-prefix.cjs (TRUNC_LEN=13).
//      From that point on, nightly-crawl.js and every consumer script write
//      and expect 13-char prefixes.
//   3. Run this script ONCE MORE (safe -- it's idempotent, already-13-char
//      and already-36-char fields are skipped) to mop up anything written at
//      the old length by a crawl that ran in the gap between steps 1 and 2.
//   4. Rebuild the three fully-regenerated directories:
//      node scripts/build-leaderboards.js --force
//      node scripts/build-team-stats.js
//      node scripts/build-search-index.js
//
// Run:     node scripts/fix-uuid-prefix-length.js
// Dry run: node scripts/fix-uuid-prefix-length.js --dry-run
// Force:   node scripts/fix-uuid-prefix-length.js --force   (ignore progress, start over)

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT            = path.join(__dirname, '..');
const GAMES_DIR       = path.join(ROOT, 'games', 'bv');
const PLAYERS_IDX     = path.join(ROOT, 'players', 'indexes');
const DRY_RUN         = process.argv.includes('--dry-run');
const FORCE           = process.argv.includes('--force');
const COMMIT_EVERY    = 100; // season files per commit
const PROGRESS_FILE   = path.join(ROOT, 'scripts', '.fix-uuid-prefix-length-progress.json');
const UNRESOLVED_FILE = path.join(ROOT, 'reports', 'uuid-prefix-length-unresolved.json');
const SAMPLE_PER_PREFIX = 5; // cap per distinct prefix -- what blew the report up last time was one record per FIELD OCCURRENCE (2.6M of them), not per distinct prefix

const OLD_LEN  = 10;
const NEW_LEN  = 13;
const FULL_LEN = 36;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

function gitCommit(message, dirs) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
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

// Per-shard OLD_LEN prefix map, built lazily and cached -- collision-safe
// (a colliding prefix maps to COLLISION and resolves to null), pinned to
// OLD_LEN regardless of whatever scripts/lib/uuid-prefix.cjs currently says.
const shardMaps = new Map();
const COLLISION = Symbol('collision');
function loadOldShardMap(shard) {
  if (shardMaps.has(shard)) return shardMaps.get(shard);
  const map = new Map();
  const indexPath = path.join(PLAYERS_IDX, `${shard}.json`);
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
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  shardMaps.set(shard, map);
  return map;
}

function resolveOld(id) {
  if (typeof id !== 'string' || id.length !== OLD_LEN) return null;
  const shard = id.slice(0, 2).toLowerCase();
  const result = loadOldShardMap(shard).get(id);
  return (result === COLLISION || result === undefined) ? null : result;
}

// unresolved: Map<prefix, { count, sample: [{sid,gameId,field}] }> -- deduped
// by distinct prefix, NOT one record per field occurrence. A single bad
// prefix can appear in thousands of games; that used to mean thousands of
// near-identical records in the report.
function recordUnresolved(unresolved, prefix, sid, gameId, ctx) {
  if (!unresolved.has(prefix)) unresolved.set(prefix, { count: 0, sample: [] });
  const entry = unresolved.get(prefix);
  entry.count++;
  if (entry.sample.length < SAMPLE_PER_PREFIX) entry.sample.push({ sid, gameId, field: ctx });
}

// Upgrades one field in place. Returns 'upgraded' | 'unresolved' | 'skipped'.
function upgradeField(obj, field, sid, gameId, ctx, unresolved) {
  const v = obj[field];
  if (typeof v !== 'string') return 'skipped';
  if (v.length === FULL_LEN) return 'skipped'; // pre-migration data, nothing to do here
  if (v.length === NEW_LEN)  return 'skipped'; // already upgraded (e.g. this is the mop-up re-run)
  if (v.length !== OLD_LEN)  return 'skipped'; // unexpected length — leave alone, don't guess
  const full = resolveOld(v);
  if (!full) {
    recordUnresolved(unresolved, v, sid, gameId, ctx);
    return 'unresolved';
  }
  obj[field] = full.slice(0, NEW_LEN);
  return 'upgraded';
}

function upgradeGameFile(gf, sid, unresolved) {
  let upgraded = 0;
  for (const [gameId, game] of Object.entries(gf.games || {})) {
    for (const p of (game.p || []))  if (upgradeField(p, 'id',        sid, gameId, 'p.id',         unresolved) === 'upgraded') upgraded++;
    for (const p of (game.hp || [])) if (upgradeField(p, 'profileID', sid, gameId, 'hp.profileID', unresolved) === 'upgraded') upgraded++;
    for (const p of (game.ap || [])) if (upgradeField(p, 'profileID', sid, gameId, 'ap.profileID', unresolved) === 'upgraded') upgraded++;
  }
  return upgraded;
}

function main() {
  const startTime = Date.now();
  console.log('fix-uuid-prefix-length.js — upgrading 10-char prefixes (9 real hex digits) to 13-char (12 real hex digits)');
  if (DRY_RUN) console.log('  DRY RUN — no writes or commits');
  console.log('-'.repeat(60));

  let progress = { doneSids: [] };
  if (FORCE) {
    console.log('  --force: starting fresh\n');
  } else if (fs.existsSync(PROGRESS_FILE)) {
    try { progress = readJson(PROGRESS_FILE); } catch {}
  }
  const doneSids = new Set(progress.doneSids ?? []);

  const allSids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
  const pendingSids = allSids.filter(s => !doneSids.has(s));
  console.log(`  ${allSids.length} season files | ${doneSids.size} already done | ${pendingSids.length} remaining`);

  let filesModified = 0, idsUpgraded = 0, sinceCommit = 0;
  const unresolved = new Map(); // prefix -> { count, sample }

  for (const sid of pendingSids) {
    const fpath = path.join(GAMES_DIR, `${sid}.json`);
    let gf;
    try { gf = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
    catch (e) { console.error(`  failed to read ${sid}.json: ${e.message}`); doneSids.add(sid); continue; }

    const changed = upgradeGameFile(gf, sid, unresolved);
    if (changed > 0) {
      if (!DRY_RUN) fs.writeFileSync(fpath, JSON.stringify(gf), 'utf8');
      filesModified++;
      idsUpgraded += changed;
    }

    doneSids.add(sid);
    sinceCommit++;

    if (sinceCommit >= COMMIT_EVERY) {
      if (!DRY_RUN) {
        writeJson(PROGRESS_FILE, { doneSids: [...doneSids] });
        gitCommit(
          `fix-uuid-prefix-length: ${doneSids.size}/${allSids.length} season files done, ${idsUpgraded.toLocaleString()} ids upgraded`,
          ['games/', 'scripts/.fix-uuid-prefix-length-progress.json']
        );
      }
      sinceCommit = 0;
      const unresolvedOccurrences = [...unresolved.values()].reduce((s, v) => s + v.count, 0);
      console.log(`  ${doneSids.size}/${allSids.length} seasons done — ${filesModified} modified, ${idsUpgraded.toLocaleString()} ids upgraded, ${unresolved.size} distinct unresolved prefixes (${unresolvedOccurrences.toLocaleString()} occurrences) so far`);
    }
  }

  if (!DRY_RUN && sinceCommit > 0) {
    writeJson(PROGRESS_FILE, { doneSids: [...doneSids] });
    gitCommit(
      `fix-uuid-prefix-length: complete — ${filesModified} files modified, ${idsUpgraded.toLocaleString()} ids upgraded`,
      ['games/', 'scripts/.fix-uuid-prefix-length-progress.json']
    );
  }

  if (!DRY_RUN && fs.existsSync(PROGRESS_FILE)) {
    fs.unlinkSync(PROGRESS_FILE);
    gitCommit('fix-uuid-prefix-length: remove progress file', ['scripts/.fix-uuid-prefix-length-progress.json']);
  }

  const unresolvedOccurrences = [...unresolved.values()].reduce((s, v) => s + v.count, 0);

  if (!DRY_RUN && unresolved.size > 0) {
    const entries = [...unresolved.entries()]
      .map(([prefix, v]) => ({ prefix, count: v.count, sample: v.sample }))
      .sort((a, b) => b.count - a.count);
    writeJson(UNRESOLVED_FILE, {
      generatedAt: new Date().toISOString(),
      distinctPrefixes: unresolved.size,
      totalOccurrences: unresolvedOccurrences,
      entries,
    });
    const sizeMB = (fs.statSync(UNRESOLVED_FILE).size / (1024 * 1024)).toFixed(2);
    console.log(`\n  Unresolved report: reports/uuid-prefix-length-unresolved.json (${sizeMB} MB)`);
    gitCommit(`fix-uuid-prefix-length: ${unresolved.size} distinct unresolved prefixes logged`, ['reports/']);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('\n' + '-'.repeat(60));
  console.log(`  Season files scanned      : ${allSids.length}`);
  console.log(`  Season files modified     : ${filesModified}`);
  console.log(`  Ids upgraded (total)      : ${idsUpgraded.toLocaleString()}`);
  console.log(`  Distinct unresolved prefix: ${unresolved.size}`);
  console.log(`  Unresolved occurrences    : ${unresolvedOccurrences.toLocaleString()}`);
  console.log(`  Elapsed                   : ${elapsed}s`);
  console.log(`  Mode                      : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('-'.repeat(60));
  if (unresolved.size > 0) {
    console.log('\n  Unresolved entries were left at the OLD 10-char value, untouched.');
    console.log('  See reports/uuid-prefix-length-unresolved.json for the distinct prefixes and samples.');
    console.log('  If distinctPrefixes is much larger than 3 (the known collision count from');
    console.log('  audit-uuid-collisions.js), run scripts/diagnose-unresolved-prefixes.js first —');
    console.log('  something other than collisions is likely at play.');
  }
  console.log('\nNext:');
  console.log('  1. Upload the corrected scripts/lib/uuid-prefix.cjs (TRUNC_LEN=13), if not already done.');
  console.log('  2. Run this script once more to mop up anything written at the old length in the gap.');
  console.log('  3. node scripts/build-leaderboards.js --force');
  console.log('  4. node scripts/build-team-stats.js');
  console.log('  5. node scripts/build-search-index.js');
}

main();
