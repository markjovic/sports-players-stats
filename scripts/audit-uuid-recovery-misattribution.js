// scripts/audit-uuid-recovery-misattribution.js
//
// READ-ONLY. Quantifies a suspected correlation bug in
// recover-uuids-from-git-history.js.
//
// THE BUG: that script's recoverField call site pairs curArr[i] with
// oldArr[i] BY ARRAY INDEX POSITION:
//
//   for (let i = 0; i < curArr.length; i++) {
//     if (curArr[i] && recoverField(curArr[i], oldArr[i], key, stats)) changed = true;
//   }
//
// This assumes position i in the pre-migration snapshot is the SAME PERSON
// as position i today. That's safe for hp[]/ap[] -- frozen legacy fields,
// never rewritten since before the migration, so their array order can't
// have drifted. It is NOT safe for p[] -- nightly-crawl.js overwrites that
// array wholesale from a fresh spectator-API call every time it processes a
// FINAL game (`gf.games[gameId].p = allPlayers.map(...)`), and nothing
// guarantees the spectator API returns players in the same order across two
// different calls separated by months. If the order drifted even once
// between the pre-migration snapshot and now, position-based pairing
// silently attributes the WRONG historical uuid to the current slot.
//
// CONFIRMED IN PRACTICE 2026-07-11: Mark manually checked
// 0000ed35-3510-4267-bf4f-db65588b6d99 (recovered into a p[] slot) against
// the real game on playhq.com and it matches NONE of the actual players in
// that game -- exactly the symptom this bug predicts.
//
// THIS SCRIPT re-validates every field the recovery script touched using a
// CONTENT-based check instead of trusting the position:
//   1. pre-recovery snapshot (the commit right before
//      recover-uuids-from-git-history.js's own commits) gives us back the
//      ORIGINAL truncated prefix that was stored at that slot before
//      recovery ran -- the one piece of information recovery's own commit
//      overwrote and that we can otherwise no longer see.
//   2. pre-migration snapshot (same reference commit the original recovery
//      script used) gives us the full candidate uuids to search.
//   3. For each touched field, search ALL entries in the pre-migration
//      array (not just index i) for the one whose truncated form matches
//      the original prefix from (1). That's the correct answer, independent
//      of array order.
//   4. Compare the correct answer to what's actually on disk now. Mismatch
//      = confirmed misattribution.
//
// Does not write anything to games/. Report only.
//
// Run (workflow only -- needs pre-migration/games/bv/ and
// pre-recovery/games/bv/ checked out first via `git archive`, see the
// companion .yml):
//   node scripts/audit-uuid-recovery-misattribution.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { isFullUuid, isTruncatedPrefix } = require('./lib/uuid-prefix.cjs');

const ROOT              = path.join(__dirname, '..');
const GAMES_DIR          = path.join(ROOT, 'games', 'bv');
const PRE_MIGRATION_DIR  = path.join(ROOT, 'pre-migration', 'games', 'bv');
const PRE_RECOVERY_DIR   = path.join(ROOT, 'pre-recovery', 'games', 'bv');
const REPORT_FILE        = path.join(ROOT, 'reports', 'uuid-recovery-misattribution-audit.json');
const SAMPLE_CAP         = 50;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function gitCommit(message, dirs) {
  try {
    execSync(`git add -- ${dirs.join(' ')}`, { stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
    const staged = execSync('git diff --staged --shortstat', { stdio: 'pipe', cwd: ROOT }).toString().trim();
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
  console.log('audit-uuid-recovery-misattribution.js -- read-only');
  console.log('-'.repeat(60));

  for (const [label, dir] of [['pre-migration', PRE_MIGRATION_DIR], ['pre-recovery', PRE_RECOVERY_DIR]]) {
    if (!fs.existsSync(dir)) {
      console.error(`  FATAL: ${dir} does not exist -- the workflow's ${label} git-archive step must run before this script.`);
      process.exit(1);
    }
  }

  const sids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
  console.log(`  ${sids.length} current season files to check\n`);

  const counts = { correct: 0, misattributed: 0, noSourceMatch: 0, ambiguous: 0, fieldsChecked: 0 };
  const samples = { misattributed: [], noSourceMatch: [], ambiguous: [] };
  let filesTouchedByRecovery = 0, seasonsScanned = 0;

  for (const sid of sids) {
    seasonsScanned++;
    let cur, preRec, preMig;
    try { cur = readJson(path.join(GAMES_DIR, `${sid}.json`)); } catch { continue; }
    try { preRec = readJson(path.join(PRE_RECOVERY_DIR, `${sid}.json`)); } catch { preRec = null; }
    try { preMig = readJson(path.join(PRE_MIGRATION_DIR, `${sid}.json`)); } catch { preMig = null; }
    if (!preRec) continue; // file didn't exist pre-recovery at all -- recovery can't have touched anything in it

    let fileTouched = false;

    for (const [gameId, curGame] of Object.entries(cur.games || {})) {
      const preRecGame = preRec.games?.[gameId];
      if (!preRecGame) continue;
      const preMigGame = preMig?.games?.[gameId] || null;

      for (const field of ['p', 'hp', 'ap']) {
        const key = field === 'p' ? 'id' : 'profileID';
        const curArr    = curGame[field]    || [];
        const preRecArr = preRecGame[field] || [];
        const preMigArr = preMigGame ? (preMigGame[field] || []) : [];

        for (let i = 0; i < curArr.length; i++) {
          const curVal = curArr[i]?.[key];
          if (!isFullUuid(curVal)) continue; // not recovered (or never needed to be)

          const preRecVal = preRecArr[i]?.[key];
          if (!isTruncatedPrefix(preRecVal)) continue; // this exact slot wasn't touched by recovery

          // This field WAS touched by recover-uuids-from-git-history.js.
          // Re-derive the correct answer by CONTENT, not position: search
          // every entry in the pre-migration array for the one whose
          // truncated form equals the ORIGINAL prefix that was here before
          // recovery overwrote it.
          counts.fieldsChecked++;
          fileTouched = true;
          const matches = preMigArr.filter(e => isFullUuid(e?.[key]) && e[key].slice(0, preRecVal.length) === preRecVal);

          if (matches.length === 0) {
            counts.noSourceMatch++;
            if (samples.noSourceMatch.length < SAMPLE_CAP) {
              samples.noSourceMatch.push({ sid, gameId, field, index: i, originalPrefix: preRecVal, currentlyWritten: curVal });
            }
          } else if (matches.length > 1) {
            counts.ambiguous++;
            if (samples.ambiguous.length < SAMPLE_CAP) {
              samples.ambiguous.push({ sid, gameId, field, index: i, originalPrefix: preRecVal, currentlyWritten: curVal, candidates: matches.map(m => m[key]) });
            }
          } else {
            const correct = matches[0][key];
            if (correct === curVal) {
              counts.correct++;
            } else {
              counts.misattributed++;
              if (samples.misattributed.length < SAMPLE_CAP) {
                samples.misattributed.push({ sid, gameId, field, index: i, originalPrefix: preRecVal, currentlyWritten: curVal, shouldBe: correct });
              }
            }
          }
        }
      }
    }

    if (fileTouched) filesTouchedByRecovery++;
    if (seasonsScanned % 200 === 0) process.stdout.write(`  ${seasonsScanned}/${sids.length} season files checked\r`);
  }

  console.log(`\n  ${seasonsScanned}/${sids.length} season files checked`);
  console.log(`  Season files touched by recovery : ${filesTouchedByRecovery.toLocaleString()}`);
  console.log(`  Fields checked (touched by recovery): ${counts.fieldsChecked.toLocaleString()}`);
  console.log('-'.repeat(60));
  console.log(`  Correct (position happened to align) : ${counts.correct.toLocaleString()}`);
  console.log(`  MISATTRIBUTED (confirmed wrong)       : ${counts.misattributed.toLocaleString()}`);
  console.log(`  No source match in pre-migration      : ${counts.noSourceMatch.toLocaleString()}`);
  console.log(`  Ambiguous (multiple candidates)       : ${counts.ambiguous.toLocaleString()}`);

  const pct = counts.fieldsChecked > 0 ? (counts.misattributed / counts.fieldsChecked * 100).toFixed(2) : '0.00';
  console.log(`\n  Misattribution rate: ${pct}% of everything recover-uuids-from-git-history.js touched`);

  const report = {
    generatedAt: new Date().toISOString(),
    seasonsScanned, filesTouchedByRecovery,
    counts, misattributionRatePct: Number(pct),
    samples,
  };
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
  const sizeMB = (fs.statSync(REPORT_FILE).size / (1024 * 1024)).toFixed(2);
  console.log(`\n  Report: reports/uuid-recovery-misattribution-audit.json (${sizeMB} MB)`);
  console.log(`  Elapsed: ${Math.round((Date.now() - start) / 1000)}s`);

  console.log('\n  Committing report...');
  gitCommit('audit-uuid-recovery-misattribution: report committed', ['reports/']);
}

main();
