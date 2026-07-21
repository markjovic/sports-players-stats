// scripts/verify-finals-preservation.js
//
// One-off verification for the 2026-07-21 build-finals-stats --active-only fix
// (OUTSTANDING_TASKS §A1 checkbox 2 — the clobber check).
//
// Premise: leaderboard/all-time.json was last written BEFORE the fixed finals
// run (the chained leaderboards rebuild was skipped), so its per-entry career
// finals / gfApps / gfWins are a PRE-RUN baseline. The pre-fix bug would have
// SHRUNK career totals (veteran with 20 finals → 1) and DELETED locked-season
// reg.stats flags. So, for the top-N finals veterans:
//
//   PASS per player:  current player-file career values >= baseline values,
//                     AND at least one LOCKED season still carries a
//                     reg.stats.finals flag (for players whose baseline finals
//                     span locked seasons — all top-N veterans do).
//   FAIL per player:  any career value SHRANK vs baseline, or zero locked-season
//                     flags remain. Any FAIL → exit 1 (red job) for human review.
//
// Read-only: no writes, no commits, no API calls.
//
// Usage: node scripts/verify-finals-preservation.js [--limit=50]

'use strict';

const fs   = require('fs');
const path = require('path');
const { resolveToFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT  = path.join(__dirname, '..');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 50) : 50;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

console.log(`\nverify-finals-preservation  (top ${LIMIT} per category)`);
console.log('─'.repeat(68));

// Baseline: pre-run all-time.json
const allTime = readJson(path.join(ROOT, 'leaderboard', 'all-time.json'));

// Locked-season set
const sportsIndex = readJson(path.join(ROOT, 'data', 'sports-index.json'));
const lockedSids = new Set(
  Object.values(sportsIndex.seasons || {}).filter(s => s.locked).map(s => s.id)
);
console.log(`  ${lockedSids.size} locked seasons in sports-index`);

// Candidates: top-N of the finals category, plus top-N of gfApps (dedup by uuid).
// Every all-time entry carries finals/gfApps/gfWins base fields regardless of
// category, so each candidate gives us all three baseline values.
const candidates = new Map(); // truncUuid → entry
for (const cat of ['finals', 'gfApps']) {
  for (const e of (allTime[cat] || []).slice(0, LIMIT)) {
    if (!candidates.has(e.uuid)) candidates.set(e.uuid, e);
  }
}
console.log(`  ${candidates.size} distinct veterans to check\n`);

let pass = 0, fail = 0, unresolved = 0;
const failures = [];

for (const [truncUuid, entry] of candidates) {
  // all-time uuids are TRUNC_LEN prefixes — resolve to the full id, house-style.
  const full = resolveToFullUuid(truncUuid, ROOT);
  if (!full) {
    unresolved++;
    console.log(`  ?? ${truncUuid}  ${entry.name} — could not resolve to a full uuid (index gap)`);
    continue;
  }
  let player;
  try {
    player = readJson(path.join(ROOT, 'players', full.slice(0, 2), `${full}.json`));
  } catch {
    unresolved++;
    console.log(`  ?? ${truncUuid}  ${entry.name} — resolved to ${full} but file unreadable`);
    continue;
  }

  const bk = player.sports?.Basketball || {};
  const now  = { finals: bk.finals ?? 0, gfApps: bk.gfApps ?? 0, gfWins: bk.gfWins ?? 0 };
  const base = { finals: entry.finals ?? 0, gfApps: entry.gfApps ?? 0, gfWins: entry.gfWins ?? 0 };

  const shrunk = ['finals', 'gfApps', 'gfWins'].filter(k => now[k] < base[k]);

  // Locked-season flag survival: count locked seasons still carrying finals flags.
  let lockedFlagSeasons = 0;
  for (const season of (player.seasons || [])) {
    if (!lockedSids.has(season.sid)) continue;
    if ((season.regs || []).some(r => (r.stats?.finals ?? 0) > 0)) lockedFlagSeasons++;
  }
  // A veteran whose baseline finals exceed what one active season could supply
  // must still show locked-season flags. Conservative trigger: baseline > 1.
  const expectLocked = base.finals > 1;
  const lockedGone   = expectLocked && lockedFlagSeasons === 0;

  if (shrunk.length === 0 && !lockedGone) {
    pass++;
    const growth = ['finals', 'gfApps', 'gfWins']
      .filter(k => now[k] > base[k]).map(k => `${k} ${base[k]}→${now[k]}`).join(', ');
    console.log(`  ✔ ${entry.name.padEnd(28)} finals ${String(now.finals).padStart(3)}  gfApps ${String(now.gfApps).padStart(3)}  gfWins ${String(now.gfWins).padStart(3)}  lockedFlagSeasons=${lockedFlagSeasons}${growth ? '  (grew: ' + growth + ')' : ''}`);
  } else {
    fail++;
    const detail = shrunk.map(k => `${k} SHRANK ${base[k]}→${now[k]}`).join(', ')
      + (lockedGone ? `${shrunk.length ? ', ' : ''}NO locked-season flags remain` : '');
    failures.push(`${entry.name} (${full}): ${detail}`);
    console.log(`  ✘ ${entry.name.padEnd(28)} ${detail}`);
  }
}

console.log('\n─── Summary ─────────────────────────────────────────────────');
console.log(`  Pass       : ${pass}`);
console.log(`  FAIL       : ${fail}`);
console.log(`  Unresolved : ${unresolved}  (index gaps — investigate separately if > a few)`);
if (fail > 0) {
  console.log('\n  FAILURES (career values shrank or locked flags vanished — the exact');
  console.log('  signature of the pre-fix bug; do NOT proceed to A2 wiring):');
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✔ No career value shrank and locked-season flags survived — A1 checkbox 2 PASSES.');
