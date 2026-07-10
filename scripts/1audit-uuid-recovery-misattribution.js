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
// FINAL game, and nothing guarantees the spectator API returns players in
// the same order across two different calls separated by months.
//
// CONFIRMED IN PRACTICE 2026-07-11: Mark manually checked
// 0000ed35-3510-4267-bf4f-db65588b6d99 (recovered into a p[] slot) against
// the real game on playhq.com and it matches NONE of the actual players in
// that game -- exactly the symptom this bug predicts. A first audit run
// reported 0 misattributed out of 2,622,579 fields checked, which flatly
// contradicts that confirmed case -- so a SPOT_CHECK trace was added to
// find out directly whether that exact slot was even touched by recovery.
//
// TWO INDEPENDENT CHECKS, deliberately kept separate because they rely on
// different assumptions:
//
//   1. PREFIX CONSISTENCY (no historical-commit-selection assumptions at
//      all -- just current vs. the immediately-prior value). The new full
//      uuid recoverField wrote should, if it's the right person, still
//      start with the exact truncated prefix that was there before it ran
//      (a truncated id IS just the first N characters of the full one).
//      recoverField never checked this -- it wrote old[field] with no
//      verification against what it was replacing. If curVal's own prefix
//      doesn't match the original truncated value, that's unambiguous,
//      self-contained proof of a wrong substitution -- it doesn't depend on
//      which "pre-migration" commit got picked, only on the immediately
//      preceding value, which is a much smaller trust surface.
//
//   2. CONTENT-MATCH AGAINST PRE-MIGRATION (everything the previous version
//      of this script did): search the pre-migration array for the entry
//      whose truncated form matches the original prefix, and compare that
//      to what's on disk now. This is needed to find out WHO a wrong entry
//      SHOULD be (a prefix alone can't identify anyone) -- but it depends
//      on correctly having identified the true pre-migration commit, which
//      is exactly the part under question. Kept as its own bucket, not
//      blended with check 1, so a problem with commit selection shows up as
//      a disagreement between the two checks rather than being invisible.
//
// Does not write anything to games/. Report only.

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { isFullUuid, isTruncatedPrefix } = require('./lib/uuid-prefix.cjs');

const ROOT              = path.join(__dirname, '..');
const GAMES_DIR          = path.join(ROOT, 'games', 'bv');
const INDEX_DIR          = path.join(ROOT, 'players', 'indexes');
const PRE_MIGRATION_DIR  = path.join(ROOT, 'pre-migration', 'games', 'bv');
const PRE_RECOVERY_DIR   = path.join(ROOT, 'pre-recovery', 'games', 'bv');
const REPORT_FILE        = path.join(ROOT, 'reports', 'uuid-recovery-misattribution-audit.json');
const SAMPLE_CAP         = 50;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// Direct trace for specific known uuids, regardless of which bucket (if any)
// the main loop sorts them into. See header for why this exists.
const SPOT_CHECK_UUIDS = new Set(['0000ed35-3510-4267-bf4f-db65588b6d99']);
const spotCheckResults = [];

const indexCache = new Map();
function isKnownIndexedPlayer(uuid) {
  const shard = uuid.slice(0, 2).toLowerCase();
  if (!indexCache.has(shard)) {
    let data = {};
    try { data = readJson(path.join(INDEX_DIR, `${shard}.json`)); } catch (_) {}
    indexCache.set(shard, data);
  }
  return !!indexCache.get(shard)[uuid];
}

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
      console.error(`  FATAL: ${dir} does not exist -- the workflow's ${label} checkout step must run before this script.`);
      process.exit(1);
    }
  }

  const sids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
  console.log(`  ${sids.length} current season files to check\n`);

  const counts = {
    fieldsChecked: 0,
    prefixInconsistent: 0,        // check 1 -- self-contained, no commit-selection trust needed
    prefixInconsistentOntoRealPlayer: 0,
    correctVsPreMigration: 0,     // check 2 -- depends on pre-migration commit selection
    misattributedVsPreMigration: 0,
    misattributedOntoRealPlayer: 0,
    noSourceMatch: 0,
    ambiguousGenuine: 0,          // multiple DIFFERENT candidate values
    ambiguousButAgreeing: 0,      // multiple matches, all the same value -- not really ambiguous
  };
  const samples = {
    prefixInconsistent: [], misattributedVsPreMigration: [], misattributedOntoRealPlayer: [],
    noSourceMatch: [], ambiguousGenuine: [],
  };
  let filesTouchedByRecovery = 0, seasonsScanned = 0;

  for (const sid of sids) {
    seasonsScanned++;
    let cur, preRec, preMig;
    try { cur = readJson(path.join(GAMES_DIR, `${sid}.json`)); } catch { continue; }
    try { preRec = readJson(path.join(PRE_RECOVERY_DIR, `${sid}.json`)); } catch { preRec = null; }
    try { preMig = readJson(path.join(PRE_MIGRATION_DIR, `${sid}.json`)); } catch { preMig = null; }
    if (!preRec) continue;

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

          if (curVal && SPOT_CHECK_UUIDS.has(curVal)) {
            const preRecValRaw = preRecArr[i]?.[key];
            const wasTruncated = isTruncatedPrefix(preRecValRaw);
            const preMigMatches = wasTruncated
              ? preMigArr.filter(e => isFullUuid(e?.[key]) && e[key].slice(0, preRecValRaw.length) === preRecValRaw)
              : [];
            spotCheckResults.push({
              uuid: curVal, sid, gameId, field, index: i,
              preRecoveryValueAtThisSlot: preRecValRaw ?? '(index did not exist pre-recovery)',
              wasThisSlotTouchedByRecovery: wasTruncated,
              prefixConsistent: wasTruncated ? (curVal.slice(0, preRecValRaw.length) === preRecValRaw) : null,
              preMigrationArrayForThisGame: preMigArr.map(e => e?.[key] ?? null),
              contentMatchesFound: preMigMatches.map(m => m[key]),
            });
          }

          if (!isFullUuid(curVal)) continue;

          const preRecVal = preRecArr[i]?.[key];
          if (!isTruncatedPrefix(preRecVal)) continue;

          counts.fieldsChecked++;
          fileTouched = true;

          // ── Check 1: prefix consistency -- no historical-commit trust needed ──
          const prefixOk = curVal.slice(0, preRecVal.length) === preRecVal;
          if (!prefixOk) {
            counts.prefixInconsistent++;
            const ontoReal = isKnownIndexedPlayer(curVal);
            const entry = { sid, gameId, field, index: i, originalPrefix: preRecVal, currentlyWritten: curVal, currentlyWrittenBelongsToRealIndexedPlayer: ontoReal };
            if (samples.prefixInconsistent.length < SAMPLE_CAP) samples.prefixInconsistent.push(entry);
            if (ontoReal) counts.prefixInconsistentOntoRealPlayer++;
          }

          // ── Check 2: content-match against pre-migration snapshot ──
          const matches = preMigArr.filter(e => isFullUuid(e?.[key]) && e[key].slice(0, preRecVal.length) === preRecVal);

          if (matches.length === 0) {
            counts.noSourceMatch++;
            if (samples.noSourceMatch.length < SAMPLE_CAP) {
              samples.noSourceMatch.push({ sid, gameId, field, index: i, originalPrefix: preRecVal, currentlyWritten: curVal });
            }
          } else {
            const distinctValues = [...new Set(matches.map(m => m[key]))];
            if (distinctValues.length > 1) {
              // Genuinely ambiguous -- different real candidates share this prefix in the old array.
              counts.ambiguousGenuine++;
              if (samples.ambiguousGenuine.length < SAMPLE_CAP) {
                samples.ambiguousGenuine.push({ sid, gameId, field, index: i, originalPrefix: preRecVal, currentlyWritten: curVal, candidates: distinctValues });
              }
            } else {
              // One or more matches, all agreeing on the same value -- not actually ambiguous.
              if (matches.length > 1) counts.ambiguousButAgreeing++;
              const correct = distinctValues[0];
              if (correct === curVal) {
                counts.correctVsPreMigration++;
              } else {
                counts.misattributedVsPreMigration++;
                const ontoReal = isKnownIndexedPlayer(curVal);
                const entry = { sid, gameId, field, index: i, originalPrefix: preRecVal, currentlyWritten: curVal, shouldBe: correct, currentlyWrittenBelongsToRealIndexedPlayer: ontoReal };
                if (samples.misattributedVsPreMigration.length < SAMPLE_CAP) samples.misattributedVsPreMigration.push(entry);
                if (ontoReal) {
                  counts.misattributedOntoRealPlayer++;
                  if (samples.misattributedOntoRealPlayer.length < SAMPLE_CAP) samples.misattributedOntoRealPlayer.push(entry);
                }
              }
            }
          }
        }
      }
    }

    if (fileTouched) filesTouchedByRecovery++;
    if (seasonsScanned % 200 === 0) process.stdout.write(`  ${seasonsScanned}/${sids.length} season files checked\r`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('  SPOT CHECK -- known uuid trace');
  console.log('='.repeat(60));
  if (spotCheckResults.length === 0) {
    console.log(`  NOT FOUND anywhere in current games/bv: ${[...SPOT_CHECK_UUIDS].join(', ')}`);
  } else {
    for (const r of spotCheckResults) console.log(JSON.stringify(r, null, 2));
  }
  console.log('='.repeat(60));

  console.log(`\n  ${seasonsScanned}/${sids.length} season files checked`);
  console.log(`  Season files touched by recovery : ${filesTouchedByRecovery.toLocaleString()}`);
  console.log(`  Fields checked (touched by recovery): ${counts.fieldsChecked.toLocaleString()}`);
  console.log('-'.repeat(60));
  console.log('  CHECK 1 -- prefix consistency (no commit-selection trust needed):');
  console.log(`    Prefix INCONSISTENT (definitely wrong)      : ${counts.prefixInconsistent.toLocaleString()}`);
  console.log(`      -- of which onto a REAL, known player     : ${counts.prefixInconsistentOntoRealPlayer.toLocaleString()}`);
  console.log('  CHECK 2 -- content-match against pre-migration snapshot:');
  console.log(`    Correct                                     : ${counts.correctVsPreMigration.toLocaleString()}`);
  console.log(`    MISATTRIBUTED (confirmed wrong)              : ${counts.misattributedVsPreMigration.toLocaleString()}`);
  console.log(`      -- of which onto a REAL, known player      : ${counts.misattributedOntoRealPlayer.toLocaleString()}`);
  console.log(`    No source match in pre-migration             : ${counts.noSourceMatch.toLocaleString()}`);
  console.log(`    Ambiguous, candidates AGREE (not really ambiguous): ${counts.ambiguousButAgreeing.toLocaleString()}`);
  console.log(`    Ambiguous, candidates GENUINELY DISAGREE     : ${counts.ambiguousGenuine.toLocaleString()}`);

  if (counts.prefixInconsistent > 0 && counts.misattributedVsPreMigration === 0) {
    console.log('\n  ⚠ Check 1 found wrong entries that Check 2 did NOT flag as misattributed.');
    console.log('    That disagreement points at a problem with the pre-migration commit');
    console.log('    selection specifically -- Check 1 doesn\'t depend on it and should be trusted first.');
  }

  const report = {
    generatedAt: new Date().toISOString(),
    seasonsScanned, filesTouchedByRecovery,
    counts, samples, spotCheckResults,
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
