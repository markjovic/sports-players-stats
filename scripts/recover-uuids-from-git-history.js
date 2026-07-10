// scripts/recover-uuids-from-git-history.js
//
// PREREQUISITE for any API backfill attempt on the 81,974 "no player file
// at all" players found by diagnose-missing-player-files.js. You cannot
// query PlayHQ for a player you can't identify -- and the current on-disk
// data can't identify them: the id is truncated to 10 chars (ambiguous by
// design), and the `name` field was deliberately stripped from hp/ap/p[]
// storage back in June 2026. So the ONLY remaining clue for these players,
// if there is one at all, is whatever full-length uuid existed in this
// file's git history BEFORE truncation was ever applied to it.
//
// Truncation (both the one-off migrate-uuid-truncation.js run and
// nightly-crawl.js writing truncated ids for new games) only started TODAY,
// as part of this session's uuid-storage migration. So for any game that
// existed in this repo before today, its pre-migration commit should still
// show the field at full 36-char length.
//
// 2026-07-10, THIRD live attempt, after two SIGTERM (exit 143) failures at
// roughly the same file count each time:
//   Attempt 1: per-file `git log --follow` walk, no timeouts -- died after
//              an 11-min silent gap. Diagnosed (wrongly, on its own, as it
//              turned out) as the sole cause.
//   Attempt 2: rewrote to a single upfront migrate-uuid-truncation commit
//              map (fast -- finished in seconds) + per-call timeouts. Died
//              again at almost the same file count, immediately, no long
//              gap this time. That rules out the per-file-walk theory --
//              the map build was fast and correct both times.
// Current best explanation (not yet confirmed, hence the instrumentation
// below rather than another confident rewrite): `git show <historical
// commit>:<path>` against a `filter: blob:none` partial clone lazily
// fetches and PERMANENTLY CACHES each historical blob locally. Across
// ~1,200 files needing recovery, on top of the already-checked-out ~2.5GB
// games/, that could plausibly exhaust the runner's disk. Rather than
// guess a third time, this version:
//   1. Logs disk usage (`df -h` on the checkout mount) at every checkpoint,
//      so if it dies again there's actual evidence instead of a bare exit
//      code.
//   2. Persists a progress file (doneSids), matching the pattern already
//      used by migrate-uuid-truncation.js and fix-uuid-prefix-length.js --
//      this script never had one, unlike those, which meant every crash
//      threw away all the "already scanned, nothing to do" work and forced
//      a full re-scan from file #1. Resuming now skips already-done files
//      immediately, no git calls at all for them.
//   3. Commits every 50 files instead of 100, so less work is lost per
//      crash and we get disk-usage data points twice as often.
//
// Run:     node scripts/recover-uuids-from-git-history.js --dry-run
// Then:    node scripts/recover-uuids-from-git-history.js
// Resume:  just run it again -- progress file picks up where it left off.
// Force:   node scripts/recover-uuids-from-git-history.js --force  (ignore progress, start over)

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT           = path.join(__dirname, '..');
const GAMES_DIR      = path.join(ROOT, 'games', 'bv');
const PLAYERS_IDX    = path.join(ROOT, 'players', 'indexes');
const DRY_RUN        = process.argv.includes('--dry-run');
const FORCE          = process.argv.includes('--force');
const REPORT_FILE    = path.join(ROOT, 'reports', 'git-history-recovery-report.json');
const PROGRESS_FILE  = path.join(ROOT, 'scripts', '.recover-uuids-from-git-history-progress.json');
const COMMIT_EVERY   = 50;
const GIT_TIMEOUT_MS = 30000; // any single git call that hangs this long fails loudly instead of hanging silently

const OLD_LEN  = 10;
const NEW_LEN  = 13;
const FULL_LEN = 36;

function git(cmd) {
  return execSync(cmd, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024, timeout: GIT_TIMEOUT_MS }).toString();
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

// Disk usage snapshot -- the actual evidence this version adds instead of
// guessing. Logs both the repo checkout and the runner's overall disk.
function logDiskUsage(label) {
  try {
    const repoSize = git(`du -sh "${ROOT}/.git" 2>/dev/null || true`).trim();
    const dfOut = git(`df -h "${ROOT}" 2>/dev/null || true`).trim().split('\n').slice(-1)[0];
    console.log(`  [disk @ ${label}] .git size: ${repoSize.split('\t')[0] || 'unknown'} | df: ${dfOut}`);
  } catch (e) {
    console.log(`  [disk @ ${label}] could not measure: ${e.message.slice(0, 150)}`);
  }
}

// 2026-07-10, live run: this exact function once hit "cannot lock ref
// 'refs/heads/main': is at X but expected Y" mid-run -- another writer pushed
// to main in the window between our fetch and our push. fetch+merge+push is
// retried up to 4 times against a FRESH fetch each attempt.
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
      if (attempt === MAX_ATTEMPTS) {
        console.error(`  git push error (gave up after ${MAX_ATTEMPTS} attempts):`, msg);
        console.error('  Local commit still exists uncommitted-to-remote -- next periodic commit will retry pushing it too.');
      } else {
        console.error(`  git push conflict (attempt ${attempt}/${MAX_ATTEMPTS}), retrying:`, msg);
      }
    }
  }
}

// Builds relPath -> parentCommitHash for EVERY file touched by ANY
// migrate-uuid-truncation commit, in one pass -- not per-file traversal.
function buildMigrationCommitMap() {
  const map = new Map();
  let hashes;
  try {
    hashes = git(`git log --all --format=%H --grep="^migrate-uuid-truncation:"`).trim().split('\n').filter(Boolean);
  } catch (e) {
    console.error('  Failed to list migrate-uuid-truncation commits:', e.message.slice(0, 300));
    return { map, actualDepthNeeded: null };
  }
  console.log(`  ${hashes.length} migrate-uuid-truncation commits found -- mapping their files to parent commits...`);
  for (const hash of hashes) {
    let files, parent;
    try { files  = git(`git diff-tree --no-commit-id --name-only -r ${hash}`).trim().split('\n').filter(Boolean); }
    catch { continue; }
    try { parent = git(`git rev-parse ${hash}^`).trim(); }
    catch { continue; }
    for (const f of files) if (!map.has(f)) map.set(f, parent);
  }
  console.log(`  ${map.size} distinct files mapped to a pre-migration commit`);

  let actualDepthNeeded = null;
  if (hashes.length > 0) {
    const oldestHash = hashes[hashes.length - 1];
    try {
      const oldestParent = git(`git rev-parse ${oldestHash}^`).trim();
      actualDepthNeeded = parseInt(git(`git rev-list --count ${oldestParent}..HEAD`).trim(), 10) + 1;
      console.log(`  Actual depth needed to reach the oldest migration commit's parent: ${actualDepthNeeded} commits`);
    } catch (e) {
      console.error('  Could not compute actual depth needed:', e.message.slice(0, 200));
    }
  }

  return { map, actualDepthNeeded };
}

function readFileAtCommit(commit, sidFilePath) {
  try { return JSON.parse(git(`git show ${commit}:"${sidFilePath}"`)); }
  catch { return null; }
}

function isFullUuid(v) { return typeof v === 'string' && v.length === FULL_LEN; }
function truncateNew(v) { return v.slice(0, NEW_LEN); }

const shardIndexMaps = new Map();
function loadShardIndex(shard) {
  if (shardIndexMaps.has(shard)) return shardIndexMaps.get(shard);
  const map = new Map();
  try {
    const index = JSON.parse(fs.readFileSync(path.join(PLAYERS_IDX, `${shard}.json`), 'utf8'));
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

function main() {
  const start = Date.now();
  console.log('recover-uuids-from-git-history.js');
  if (DRY_RUN) console.log('  DRY RUN -- counts only, no writes or commits');
  console.log('-'.repeat(60));
  logDiskUsage('start');

  let isShallow = false;
  try { isShallow = git('git rev-parse --is-shallow-repository').trim() === 'true'; } catch {}
  console.log(`  Repo is ${isShallow ? 'SHALLOW' : 'a full clone'} -- if many files report 'no-migration-commit-in-history'`);
  if (isShallow) console.log("  below, increase fetch-depth in the workflow and re-run before trusting that count.");

  const { map: migrationMap, actualDepthNeeded } = buildMigrationCommitMap();

  let progress = { doneSids: [] };
  if (FORCE) {
    console.log('  --force: starting fresh\n');
  } else if (fs.existsSync(PROGRESS_FILE)) {
    try { progress = readJson(PROGRESS_FILE); console.log(`  Resuming -- ${progress.doneSids.length} season files already done`); }
    catch {}
  }
  const doneSids = new Set(progress.doneSids ?? []);

  const allSids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
  const pendingSids = allSids.filter(s => !doneSids.has(s));
  console.log(`  ${allSids.length} season files total | ${doneSids.size} already done | ${pendingSids.length} remaining\n`);

  let filesChecked = 0, filesWithUnresolved = 0, filesWithHistory = 0, filesModified = 0;
  let recovered = 0, stillUnrecoverable = 0, sinceCommit = 0;
  const reasonCounts = {};
  const unrecoverableExamples = [];

  for (const sid of pendingSids) {
    filesChecked++;
    const fpath = path.join(GAMES_DIR, `${sid}.json`);
    let gf;
    try { gf = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
    catch { doneSids.add(sid); continue; }

    let needsRecovery = false;
    for (const game of Object.values(gf.games || {})) {
      for (const p of (game.p  || [])) if (p.id        && p.id.length        === OLD_LEN && !alreadyResolvable(p.id))        needsRecovery = true;
      for (const p of (game.hp || [])) if (p.profileID && p.profileID.length === OLD_LEN && !alreadyResolvable(p.profileID)) needsRecovery = true;
      for (const p of (game.ap || [])) if (p.profileID && p.profileID.length === OLD_LEN && !alreadyResolvable(p.profileID)) needsRecovery = true;
      if (needsRecovery) break;
    }
    if (!needsRecovery) { doneSids.add(sid); continue; }
    filesWithUnresolved++;

    const relPath = `games/bv/${sid}.json`;
    const commit = migrationMap.get(relPath) || null;
    const reason = commit ? 'ok' : 'no-migration-commit-in-history';
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;

    if (!commit) {
      stillUnrecoverable++;
      if (unrecoverableExamples.length < 30) unrecoverableExamples.push({ sid, reason });
      doneSids.add(sid);
      continue;
    }
    filesWithHistory++;

    const historical = readFileAtCommit(commit, relPath);
    if (!historical) {
      stillUnrecoverable++;
      if (unrecoverableExamples.length < 30) unrecoverableExamples.push({ sid, reason: 'show-failed' });
      doneSids.add(sid);
      continue;
    }

    let changed = false;
    for (const [gameId, game] of Object.entries(gf.games || {})) {
      const histGame = historical.games?.[gameId];
      if (!histGame) continue;

      function recoverArray(current, hist, field) {
        if (!Array.isArray(current) || !Array.isArray(hist)) return;
        for (let i = 0; i < current.length; i++) {
          const cur = current[i];
          const old = hist[i];
          if (!cur || typeof cur[field] !== 'string' || cur[field].length !== OLD_LEN) continue;
          if (alreadyResolvable(cur[field])) continue;
          if (old && isFullUuid(old[field])) {
            cur[field] = truncateNew(old[field]);
            recovered++;
            changed = true;
          } else {
            stillUnrecoverable++;
          }
        }
      }
      recoverArray(game.p,  histGame.p,  'id');
      recoverArray(game.hp, histGame.hp, 'profileID');
      recoverArray(game.ap, histGame.ap, 'profileID');
    }

    if (changed) {
      if (!DRY_RUN) fs.writeFileSync(fpath, JSON.stringify(gf), 'utf8');
      filesModified++;
      sinceCommit++;
    }

    doneSids.add(sid);

    if (sinceCommit >= COMMIT_EVERY) {
      if (!DRY_RUN) writeJson(PROGRESS_FILE, { doneSids: [...doneSids] });
      gitCommit(`recover-uuids-from-git-history: ${filesModified} files modified, ${recovered.toLocaleString()} ids recovered so far`, ['games/', 'scripts/.recover-uuids-from-git-history-progress.json']);
      sinceCommit = 0;
      logDiskUsage(`${filesChecked} files checked this run`);
    }

    if (filesChecked % 200 === 0) process.stdout.write(`  ${filesChecked}/${pendingSids.length} files checked this run\r`);
  }

  if (sinceCommit > 0 && !DRY_RUN) writeJson(PROGRESS_FILE, { doneSids: [...doneSids] });
  gitCommit(`recover-uuids-from-git-history: complete -- ${filesModified} files modified, ${recovered.toLocaleString()} ids recovered`, ['games/', 'scripts/.recover-uuids-from-git-history-progress.json']);

  if (!DRY_RUN && fs.existsSync(PROGRESS_FILE)) {
    fs.unlinkSync(PROGRESS_FILE);
    gitCommit('recover-uuids-from-git-history: remove progress file (run complete)', ['scripts/.recover-uuids-from-git-history-progress.json']);
  }

  logDiskUsage('end');

  const report = {
    generatedAt: new Date().toISOString(),
    isShallow,
    actualDepthNeeded,
    filesChecked, filesWithUnresolved, filesWithHistory, filesModified,
    recovered, stillUnrecoverable, reasonCounts,
    unrecoverableExamples,
  };
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
  gitCommit('recover-uuids-from-git-history: report committed', ['reports/']);

  console.log('\n' + '-'.repeat(60));
  console.log(`  Season files checked this run  : ${filesChecked}`);
  console.log(`  Files with unresolved fields    : ${filesWithUnresolved}`);
  console.log(`  Files with usable history       : ${filesWithHistory}`);
  console.log(`  Files modified                   : ${filesModified}`);
  console.log(`  Ids recovered                    : ${recovered.toLocaleString()}`);
  console.log(`  Still unrecoverable              : ${stillUnrecoverable.toLocaleString()}`);
  console.log(`  Reason breakdown                 : ${JSON.stringify(reasonCounts)}`);
  console.log(`  Elapsed                          : ${Math.round((Date.now() - start) / 1000)}s`);
  console.log(`  Mode                             : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`  Actual depth needed               : ${actualDepthNeeded ?? 'unknown'}`);
  if (stillUnrecoverable > 0) {
    console.log('\n  Some ids have NO full-length version anywhere in available git history --');
    console.log('  either fetch-depth was insufficient, or the game was created after');
    console.log('  truncation was already live. The only remaining option for those is a');
    console.log('  fresh re-fetch from PlayHQ live API, which is a separate mechanism.');
  }
}

main();
