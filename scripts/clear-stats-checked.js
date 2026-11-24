// scripts/clear-stats-checked.js
//
// Clears statsChecked from player files so the matrix re-fetches them.
//
// Modes:
//   node scripts/clear-stats-checked.js
//     Clears ALL players — used before a force matrix run.
//
//   node scripts/clear-stats-checked.js --fix-corrupt-names
//     Finds players with corrupt season names ("Winter 2022" etc),
//     deletes the corrupt name, and clears statsChecked so the matrix
//     re-fetches them and writes their real name from the API.

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const GX = require('./lib/git-exec.cjs');   // T104: the git timeout lives in ONE place

const ROOT          = path.join(__dirname, '..');
const PLAYERS_DIR   = path.join(ROOT, 'players');
const FIX_CORRUPT = process.argv.includes('--fix-corrupt-names');
const SEASON_RE     = /^(Winter|Summer|Spring|Autumn|Fall)\s+\d{4}/i;

// ─── git (house pattern) ──────────────────────────────────────────────────────
// REWRITTEN 2026-11-24 (T104). Two faults beyond the missing timeout:
//
//   1. COMMIT AFTER MERGE. The old order was fetch → merge → commit → push, and the
//      comment claimed merging first made the push succeed. It does the opposite:
//      merging over UNCOMMITTED changes fails outright the moment a concurrent push
//      touches the same files, which on this repo is most nights. Commit first.
//   2. NO push retry at all. One contended push lost the whole run's work on a
//      repository with many writers on one branch.
//
// The single `players/` pathspec is kept deliberately: the per-path rule exists so
// one unmatched path cannot silently discard the valid paths beside it, and with one
// pathspec there is nothing beside it to discard. `--no-stat` added to the merge so
// the per-file "Auto-merging …" lines can never approach maxBuffer (T26).
function gitCommit(message) {
  execSync('git add -- players/', GX.gitOpts(ROOT));
  // --shortstat avoids ENOBUFS from large diff output
  const staged = execSync('git diff --staged --shortstat', GX.gitOpts(ROOT)).toString().trim();
  if (!staged) { console.log('  Nothing to commit.'); return; }
  console.log(`  staging: ${staged}`);
  try { execSync(`git commit -q -m "${message.replace(/"/g, "'")}"`, GX.gitOpts(ROOT)); }
  catch (e) {
    if (GX.isNothingToCommit(e)) { console.log('  Nothing to commit.'); return; }
    throw new Error(`commit failed — ${GX.gitSaid(e) || e.message}`);
  }
  const MAX = GX.MAX_ATTEMPTS;
  const stalls = GX.makeStallTracker();
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try { execSync('git merge --abort', GX.gitOpts(ROOT)); } catch (_) { /* none in progress */ }
    try { execSync('git fetch origin main', GX.gitOpts(ROOT)); stalls.note('ok'); }
    catch (e) {
      const kind = GX.classifyGitError(e);
      const st = stalls.note(kind);
      if (kind === 'fatal') throw new Error(GX.fatalMessage('fetch', e));
      if (st.exhausted) throw new Error(GX.stallExhaustedMessage('fetch', st));
      if (attempt === MAX) throw new Error(GX.attemptsExhaustedMessage('fetch', MAX, e));
      const s = GX.backoffSeconds(true);
      console.log(GX.retryMessage('fetch', e, attempt, MAX, s, st));
      try { execSync(`sleep ${s}`, GX.sleepOpts(s)); } catch (_) {}
      continue;
    }
    execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GX.gitOpts(ROOT));
    try {
      execSync('git push origin main', GX.gitOpts(ROOT));
      console.log(`  \u2713 ${message} (attempt ${attempt})`);
      return;
    } catch (e) {
      const kind = GX.classifyGitError(e);
      const st = stalls.note(kind);
      if (kind === 'fatal') throw new Error(GX.fatalMessage('push', e));
      if (st.exhausted) throw new Error(GX.stallExhaustedMessage('push', st));
      if (attempt === MAX) throw new Error(GX.attemptsExhaustedMessage('push', MAX, e));
      const s = GX.backoffSeconds(true);
      console.log(GX.retryMessage('push', e, attempt, MAX, s, st));
      try { execSync(`sleep ${s}`, GX.sleepOpts(s)); } catch (_) {}
    }
  }
  throw new Error(`exhausted ${MAX} push attempts`);
}

async function main() {
  const start = Date.now();
  console.log('clear-stats-checked.js' + (FIX_CORRUPT ? ' [fix-corrupt-names]' : ''));
  console.log('─'.repeat(50));

  const prefixes = fs.readdirSync(PLAYERS_DIR)
    .filter(f => /^[0-9a-f]{2}$/.test(f))
    .sort();

  let cleared = 0, namesFixed = 0, skipped = 0, total = 0;

  for (const prefix of prefixes) {
    const dir   = path.join(PLAYERS_DIR, prefix);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

    for (const fname of files) {
      total++;
      const fpath = path.join(dir, fname);
      let player;
      try { player = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
      catch (_) { skipped++; continue; }

      const bk = player.sports?.Basketball;

      if (FIX_CORRUPT) {
        // Only touch players with a corrupt season name
        if (!player.name || !SEASON_RE.test(player.name)) { skipped++; continue; }
        delete player.name;
        namesFixed++;
        if (bk?.statsChecked) { delete bk.statsChecked; cleared++; }
        fs.writeFileSync(fpath, JSON.stringify(player), 'utf8');
      } else {
        if (!bk?.statsChecked) { skipped++; continue; }
        delete bk.statsChecked;
        fs.writeFileSync(fpath, JSON.stringify(player), 'utf8');
        cleared++;
      }
    }

    if ((prefixes.indexOf(prefix) + 1) % 32 === 0)
      process.stdout.write(`  ${prefix} — ${namesFixed || cleared} processed so far\r`);
  }

  console.log(`\n  ${total} files scanned`);
  if (FIX_CORRUPT) {
    console.log(`  Corrupt names deleted:  ${namesFixed}`);
    console.log(`  statsChecked cleared:   ${cleared}`);
  } else {
    console.log(`  statsChecked cleared:   ${cleared}`);
  }
  console.log(`  Skipped:                ${skipped}`);
  console.log('\n  Committing...');

  if (!FIX_CORRUPT) {
    fs.writeFileSync(
      path.join(ROOT, 'matrix-force-pending.json'),
      JSON.stringify({ clearedAt: new Date().toISOString(), count: cleared })
    );
  }

  const msg = FIX_CORRUPT
    ? `clear-stats-checked: ${namesFixed} corrupt names deleted, ${cleared} queued for matrix`
    : `clear-stats-checked: ${cleared} players cleared for matrix re-fetch`;

  gitCommit(msg);
  console.log(`  Elapsed: ${Math.round((Date.now() - start) / 1000)}s`);
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
