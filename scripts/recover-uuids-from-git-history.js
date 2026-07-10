// scripts/recover-uuids-from-git-history.js
//
// PREREQUISITE for any API backfill attempt on the 81,974 "no player file
// at all" players found by diagnose-missing-player-files.js. You cannot
// query PlayHQ for a player you can't identify -- and the current on-disk
// data can't identify them: the id is truncated to 10 chars (ambiguous by
// design), and the `name` field was stripped from hp/ap/p[] storage back in
// June 2026. The only remaining clue is whatever full-length uuid existed in
// games/bv/*.json BEFORE today's truncation rollout.
//
// ARCHITECTURE (rebuilt 2026-07-10 after three failed attempts at a more
// "clever" version that did ~1,200 individual git operations -- one history
// lookup and one content read per file. That's what caused every failure:
// a slow per-file traversal, then two separate SIGTERM kills whose exact
// mechanism was never fully pinned down. None of that per-file git work was
// actually necessary, because every file that needs recovery shares the
// exact same reference point: the single commit from right before
// migrate-uuid-truncation.js ever ran.
//
// So the workflow finds that ONE commit ONCE (a plain bash step, not this
// script) and checks it out as a plain second directory
// (<workspace>/pre-migration/games/bv/) alongside the current one. This
// script then does ZERO git operations for content -- it's a pure
// filesystem diff between two directories of JSON. The only git calls left
// anywhere in this script are the periodic commit/push of the actual fix
// (a real, separate, much simpler concern: other writers may push to main
// while this runs, so that step retries on conflict).
//
// Run:     node scripts/recover-uuids-from-git-history.js --dry-run
// Then:    node scripts/recover-uuids-from-git-history.js
// Resume:  just run it again -- progress file picks up where it left off.
// Force:   node scripts/recover-uuids-from-git-history.js --force

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT           = path.join(__dirname, '..');
const GAMES_DIR       = path.join(ROOT, 'games', 'bv');
const OLD_GAMES_DIR   = path.join(ROOT, 'pre-migration', 'games', 'bv'); // checked out by the workflow, plain files, no git involved here
const PLAYERS_IDX     = path.join(ROOT, 'players', 'indexes');
const DRY_RUN         = process.argv.includes('--dry-run');
const FORCE           = process.argv.includes('--force');
const REPORT_FILE     = path.join(ROOT, 'reports', 'git-history-recovery-report.json');
const PROGRESS_FILE   = path.join(ROOT, 'scripts', '.recover-uuids-from-git-history-progress.json');
const COMMIT_EVERY    = 100;
const GIT_TIMEOUT_MS  = 30000;

const OLD_LEN  = 10;
const NEW_LEN  = 13;
const FULL_LEN = 36;

function readJson(p)      { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d)  { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }
function isFullUuid(v)    { return typeof v === 'string' && v.length === FULL_LEN; }
function truncateNew(v)   { return v.slice(0, NEW_LEN); }

// The only git this script does: committing the actual fix. Retries
// fetch+merge+push against a fresh fetch if another writer pushed to main
// in the meantime -- a real, separate concern from how content gets read.
function gitCommit(message, dirs) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  try {
    execSync(`git add ${dirs.join(' ')}`, { stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
    const staged = execSync('git diff --staged --shortstat',
      { stdio: 'pipe', cwd: ROOT, maxBuffer: 10 * 1024 * 1024, timeout: GIT_TIMEOUT_MS }).toString().trim();
    if (!staged) { console.log('  Nothing to commit.'); return; }
    execSync(`git commit -q -m "${message}"`, { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS });
  } catch (e) {
    console.error('  git add/commit error:', e.stderr?.toString().slice(0, 300) || e.message.slice(0, 300));
    return;
  }
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      execSync('git fetch origin main',                            { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS });
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS });
      execSync('git push origin main',                             { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS });
      console.log(`  Committed: ${message}`);
      return;
    } catch (e) {
      const msg = e.stderr?.toString().slice(0, 300) || e.message.slice(0, 300);
      if (attempt === MAX_ATTEMPTS) console.error(`  git push error (gave up after ${MAX_ATTEMPTS} attempts):`, msg);
      else console.error(`  git push conflict (attempt ${attempt}/${MAX_ATTEMPTS}), retrying:`, msg);
    }
  }
}

// shard -> Map<prefix10, fullUuid> from the CURRENT player index -- used to
// skip anything actually resolvable already (this script is only for the
// genuinely unresolvable remainder).
const shardIndexMaps = new Map();
function loadShardIndex(shard) {
  if (shardIndexMaps.has(shard)) return shardIndexMaps.get(shard);
  const map = new Map();
  try {
    const index = readJson(path.join(PLAYERS_IDX, `${shard}.json`));
    for (const fullUuid of Object.keys(index)) {
      if (isFullUuid(fullUuid)) map.set(fullUuid.slice(0, OLD_LEN), fullUuid);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  shardIndexMaps.set(shard, map);
  return map;
}
function alreadyResolvable(id) {
  if (typeof id !== 'string' || id.length !== OLD_LEN) return true;
  return loadShardIndex(id.slice(0, 2).toLowerCase()).has(id);
}

function fileNeedsRecovery(gf) {
  for (const game of Object.values(gf.games || {})) {
    for (const p of (game.p  || [])) if (p.id        && p.id.length        === OLD_LEN && !alreadyResolvable(p.id))        return true;
    for (const p of (game.hp || [])) if (p.profileID && p.profileID.length === OLD_LEN && !alreadyResolvable(p.profileID)) return true;
    for (const p of (game.ap || [])) if (p.profileID && p.profileID.length === OLD_LEN && !alreadyResolvable(p.profileID)) return true;
  }
  return false;
}

function recoverField(cur, old, field, stats) {
  if (typeof cur[field] !== 'string' || cur[field].length !== OLD_LEN) return false;
  if (alreadyResolvable(cur[field])) return false;
  if (old && isFullUuid(old[field])) {
    cur[field] = truncateNew(old[field]);
    stats.recovered++;
    return true;
  }
  stats.stillUnrecoverable++;
  return false;
}

function main() {
  const start = Date.now();
  console.log('recover-uuids-from-git-history.js');
  if (DRY_RUN) console.log('  DRY RUN -- counts only, no writes or commits');
  console.log('-'.repeat(60));

  if (!fs.existsSync(OLD_GAMES_DIR)) {
    console.error(`  FATAL: ${OLD_GAMES_DIR} does not exist -- the workflow's pre-migration checkout step must run before this script.`);
    process.exit(1);
  }

  let progress = { doneSids: [] };
  if (FORCE) {
    console.log('  --force: starting fresh\n');
  } else if (fs.existsSync(PROGRESS_FILE)) {
    try { progress = readJson(PROGRESS_FILE); console.log(`  Resuming -- ${progress.doneSids.length} season files already done`); } catch {}
  }
  const doneSids = new Set(progress.doneSids ?? []);

  const allSids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
  const pendingSids = allSids.filter(s => !doneSids.has(s));
  console.log(`  ${allSids.length} season files total | ${doneSids.size} already done | ${pendingSids.length} remaining\n`);

  const stats = { recovered: 0, stillUnrecoverable: 0 };
  let filesChecked = 0, filesWithUnresolved = 0, filesWithSnapshot = 0, filesModified = 0, sinceCommit = 0;
  const reasonCounts = {};
  const unrecoverableExamples = [];

  for (const sid of pendingSids) {
    filesChecked++;
    let gf;
    try { gf = readJson(path.join(GAMES_DIR, `${sid}.json`)); }
    catch { doneSids.add(sid); continue; }

    if (!fileNeedsRecovery(gf)) { doneSids.add(sid); continue; }
    filesWithUnresolved++;

    let historical = null;
    try { historical = readJson(path.join(OLD_GAMES_DIR, `${sid}.json`)); } catch {}

    if (!historical) {
      reasonCounts['no-pre-migration-snapshot'] = (reasonCounts['no-pre-migration-snapshot'] || 0) + 1;
      if (unrecoverableExamples.length < 30) unrecoverableExamples.push({ sid, reason: 'no-pre-migration-snapshot' });
      doneSids.add(sid);
      continue;
    }
    filesWithSnapshot++;
    reasonCounts['ok'] = (reasonCounts['ok'] || 0) + 1;

    let changed = false;
    for (const [gameId, game] of Object.entries(gf.games || {})) {
      const histGame = historical.games?.[gameId];
      if (!histGame) continue;
      for (const field of ['p', 'hp', 'ap']) {
        const curArr = game[field], oldArr = histGame[field];
        if (!Array.isArray(curArr) || !Array.isArray(oldArr)) continue;
        const key = field === 'p' ? 'id' : 'profileID';
        for (let i = 0; i < curArr.length; i++) {
          if (curArr[i] && recoverField(curArr[i], oldArr[i], key, stats)) changed = true;
        }
      }
    }

    if (changed) {
      if (!DRY_RUN) fs.writeFileSync(path.join(GAMES_DIR, `${sid}.json`), JSON.stringify(gf), 'utf8');
      filesModified++;
      sinceCommit++;
    }
    doneSids.add(sid);

    if (sinceCommit >= COMMIT_EVERY) {
      if (!DRY_RUN) writeJson(PROGRESS_FILE, { doneSids: [...doneSids] });
      gitCommit(`recover-uuids-from-git-history: ${filesModified} files modified, ${stats.recovered.toLocaleString()} ids recovered so far`, ['games/', 'scripts/.recover-uuids-from-git-history-progress.json']);
      sinceCommit = 0;
    }
    if (filesChecked % 200 === 0) process.stdout.write(`  ${filesChecked}/${pendingSids.length} files checked this run\r`);
  }

  if (sinceCommit > 0 && !DRY_RUN) writeJson(PROGRESS_FILE, { doneSids: [...doneSids] });
  gitCommit(`recover-uuids-from-git-history: complete -- ${filesModified} files modified, ${stats.recovered.toLocaleString()} ids recovered`, ['games/', 'scripts/.recover-uuids-from-git-history-progress.json']);

  if (!DRY_RUN && fs.existsSync(PROGRESS_FILE)) {
    fs.unlinkSync(PROGRESS_FILE);
    gitCommit('recover-uuids-from-git-history: remove progress file (run complete)', ['scripts/.recover-uuids-from-git-history-progress.json']);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    filesChecked, filesWithUnresolved, filesWithSnapshot, filesModified,
    recovered: stats.recovered, stillUnrecoverable: stats.stillUnrecoverable,
    reasonCounts, unrecoverableExamples,
  };
  writeJson(REPORT_FILE, report);
  gitCommit('recover-uuids-from-git-history: report committed', ['reports/']);

  console.log('\n' + '-'.repeat(60));
  console.log(`  Season files checked this run : ${filesChecked}`);
  console.log(`  Files with unresolved fields   : ${filesWithUnresolved}`);
  console.log(`  Files with a pre-migration snapshot: ${filesWithSnapshot}`);
  console.log(`  Files modified                 : ${filesModified}`);
  console.log(`  Ids recovered                  : ${stats.recovered.toLocaleString()}`);
  console.log(`  Still unrecoverable             : ${stats.stillUnrecoverable.toLocaleString()}`);
  console.log(`  Reason breakdown               : ${JSON.stringify(reasonCounts)}`);
  console.log(`  Elapsed                        : ${Math.round((Date.now() - start) / 1000)}s`);
  console.log(`  Mode                           : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  if (stats.stillUnrecoverable > 0 || reasonCounts['no-pre-migration-snapshot']) {
    console.log('\n  Some ids have no pre-migration snapshot -- the game was likely created');
    console.log('  after truncation was already live. The only remaining option for those');
    console.log('  is a fresh re-fetch from PlayHQ\'s live API, a separate mechanism.');
  }
}

main();
