// scripts/recover-uuids-from-git-history.js
//
// PREREQUISITE for any API backfill attempt on players with no player file
// at all. You cannot query PlayHQ for a player you can't identify -- and the
// current on-disk data can't identify them: the id is truncated (ambiguous
// by design), and the `name` field was stripped from hp/ap/p[] storage back
// in June 2026. The only remaining clue is whatever full-length uuid existed
// in games/bv/*.json BEFORE today's truncation rollout.
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
// BUG FOUND AND FIXED 2026-07-10 (second pass, after the "final" version
// above ran clean and appeared to succeed): recoverField found the real,
// full-length uuid in the pre-migration snapshot correctly, then immediately
// TRUNCATED it back to 13 characters before writing it back -- on the
// assumption that games/bv should always store truncated ids for
// consistency with the rest of the pipeline. But these players still have
// no players/indexes/ entry, so truncating just reproduces an equally
// unresolvable 13-char prefix and throws away the one thing this whole
// script exists to recover. Confirmed via diagnose-id-field-lengths.js:
// EVERY id/profileID value in games/bv was length 13, zero were full-length,
// and the unresolvable count (2,622,579) matched the pre-recovery figure
// almost exactly -- every run (crashed or "successful") carried this same
// bug, so all any of them ever did was convert already-broken 10-char
// prefixes into equally-broken 13-char prefixes. Fixed by writing the real
// full uuid as-is (no truncation) -- full-length values are already a
// deliberately-supported case in scripts/lib/uuid-prefix.cjs (isFullUuid
// short-circuits resolveToFullUuid), so this isn't a special case, it's
// just using what the rest of the system already expects. Also widened the
// "needs recovery" check to catch already-damaged 13-char unresolvable
// fields, not just 10-char ones -- the existing damage is now stored at
// length 13, and the old OLD_LEN-only check would walk right past it.
//
// Run:     node scripts/recover-uuids-from-git-history.js --dry-run
// Then:    node scripts/recover-uuids-from-git-history.js --force
//          (--force matters this run specifically -- see note above; a
//          stale progress file from the buggy run must not cause any file
//          to be skipped before the fixed logic gets a chance to re-check it.
//          The progress file is deleted on clean completion, so there
//          likely isn't one left, but pass --force anyway to be certain.)
// Resume:  just run it again -- progress file picks up where it left off.

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const { resolveToFullUuid, isFullUuid, isTruncatedPrefix } = require('./lib/uuid-prefix.cjs');

const ROOT           = path.join(__dirname, '..');
const GAMES_DIR       = path.join(ROOT, 'games', 'bv');
const OLD_GAMES_DIR   = path.join(ROOT, 'pre-migration', 'games', 'bv'); // checked out by the workflow, plain files, no git involved here
const DRY_RUN         = process.argv.includes('--dry-run');
const FORCE           = process.argv.includes('--force');
const REPORT_FILE     = path.join(ROOT, 'reports', 'git-history-recovery-report.json');
const PROGRESS_FILE   = path.join(ROOT, 'scripts', '.recover-uuids-from-git-history-progress.json');
const COMMIT_EVERY    = 100;
const GIT_TIMEOUT_MS  = 30000;

function readJson(p)      { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d)  { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

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

// A field needs recovery if it's currently truncated (either length -- 10
// from before the TRUNC_LEN fix, or 13 if it was already run through the
// buggy version of this script) AND doesn't resolve via the current index.
// Full-length fields are already recovered (or never broke) -- leave alone.
function needsRecovery(id) {
  if (!isTruncatedPrefix(id)) return false;
  return resolveToFullUuid(id, ROOT) === null;
}

function fileNeedsRecovery(gf) {
  for (const game of Object.values(gf.games || {})) {
    for (const p of (game.p  || [])) if (needsRecovery(p.id))        return true;
    for (const p of (game.hp || [])) if (needsRecovery(p.profileID)) return true;
    for (const p of (game.ap || [])) if (needsRecovery(p.profileID)) return true;
  }
  return false;
}

function recoverField(cur, old, field, stats) {
  if (!needsRecovery(cur[field])) return false;
  if (old && isFullUuid(old[field])) {
    // Write the REAL full uuid, untruncated. There is no index entry to
    // truncate against yet -- truncating here would just reproduce an
    // equally unresolvable prefix and destroy the recovered identity
    // (this was the 2026-07-10 bug -- see header).
    cur[field] = old[field];
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
