// scripts/count-stats-checked.js
//
// Counts player files with and without statsChecked, and sizes the `c` population.
// No writes. Read-only.
//
// Run: node scripts/count-stats-checked.js
//      node scripts/count-stats-checked.js --c-since=2026-09-01
//
// ─── WHY THE DATE SPLIT (added 2026-09-11) ───────────────────────────────────
// `c` (PlayHQ credits this game, games[] does not hold it) was added to
// fetch-profile-stats.js on 2026-09-01. A player fetched BEFORE that date has no
// `c` no matter how large their gap is, because the field did not exist when they
// were written — and an absent `c` is therefore ambiguous in exactly one way:
//
//   statsChecked >= cutoff, no `c`   → genuinely no gap. Nothing to recover.
//   statsChecked <  cutoff, no `c`   → UNKNOWN. Never asked the question.
//
// The §2.10 recovery design consumes `c` and makes zero API calls, so the second
// group is precisely what that design CANNOT REACH. This script exists in its
// current form to size that blind spot before anything is built on top of `c`.
// Those players stay repair-players-batch territory, which pays the API cost.
//
// The cutoff is an ARGUMENT, not a constant: if `c` is ever recomputed for older
// files, or the field changes meaning again, the split has to move with it.
//
// The size distribution is here because §5 of the design asks whether recovery
// should be staged by size the way repair-players-batch was staged by --min-gap.
// That question cannot be answered without knowing whether the entries are spread
// thinly across many players or concentrated in a few.

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');

const argOf = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const C_SINCE = argOf('c-since', '2026-09-01');
if (!/^\d{4}-\d{2}-\d{2}$/.test(C_SINCE)) {
  console.error(`--c-since must be YYYY-MM-DD, got "${C_SINCE}"`);
  process.exit(1);
}

const prefixes = fs.readdirSync(PLAYERS_DIR)
  .filter(f => /^[0-9a-f]{2}$/.test(f))
  .sort();

let total = 0, withChecked = 0, withoutChecked = 0, errors = 0;
let checkedBefore = 0, checkedAfter = 0, checkedUnparseable = 0;
let withC = 0, cEntries = 0, withX = 0, xEntries = 0;
// Blind spot: fetched before the cutoff, so `c` could never have been written.
let blindSpot = 0;
// Reachable and idle: fetched since the cutoff and carrying no `c` — a real answer
// of "no gap", not an absence of data.
let reachableNoGap = 0;
// Size distribution of `c`, for the staged-rollout question.
const BANDS = [1, 2, 5, 10, 25, 50, 100, 250, 500];
const bands = new Map(BANDS.map(b => [b, 0]));
let bandOver = 0;
const worst = [];   // top few by |c|, for validating a build against real players

for (const prefix of prefixes) {
  const dir   = path.join(PLAYERS_DIR, prefix);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const fname of files) {
    total++;
    try {
      const player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8'));
      const bk = player.sports?.Basketball;
      const sc = bk?.statsChecked;
      if (sc) withChecked++; else withoutChecked++;

      // Compare as ISO date prefixes — statsChecked is a full ISO timestamp and
      // the cutoff is a date, so slice rather than parse. String comparison is
      // correct for ISO-8601 and avoids a Date object per file across ~411k files.
      let before = null;
      if (sc && typeof sc === 'string' && sc.length >= 10) {
        before = sc.slice(0, 10) < C_SINCE;
        if (before) checkedBefore++; else checkedAfter++;
      } else if (sc) {
        checkedUnparseable++;   // present but not a date we can place
      }

      const c = Array.isArray(bk?.c) ? bk.c : null;
      const x = Array.isArray(bk?.x) ? bk.x : null;
      if (c && c.length) {
        withC++;
        cEntries += c.length;
        let placed = false;
        for (const b of BANDS) { if (c.length <= b) { bands.set(b, bands.get(b) + 1); placed = true; break; } }
        if (!placed) bandOver++;
        worst.push({ uuid: fname.replace(/\.json$/, ''), name: player.name || '?', n: c.length });
        if (worst.length > 400) { worst.sort((a, b2) => b2.n - a.n); worst.length = 20; }
      } else if (before === true) {
        blindSpot++;            // fetched pre-cutoff: absence of `c` says nothing
      } else if (before === false) {
        reachableNoGap++;       // fetched post-cutoff with no `c`: a real "no gap"
      }
      if (x && x.length) { withX++; xEntries += x.length; }
    } catch (_) { errors++; }
  }
  if ((prefixes.indexOf(prefix) + 1) % 32 === 0)
    process.stdout.write(`  ${prefix} — ${total} scanned\r`);
}

worst.sort((a, b) => b.n - a.n);

const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : '—';

console.log(`\n${'─'.repeat(64)}`);
console.log(`  Total players:            ${total.toLocaleString()}`);
console.log(`  With statsChecked:        ${withChecked.toLocaleString()}`);
console.log(`  Without statsChecked:     ${withoutChecked.toLocaleString()}`);
console.log(`  Errors:                   ${errors}`);
console.log('─'.repeat(64));
console.log(`  `.padEnd(2) + `SPLIT AT --c-since=${C_SINCE}  (the date \`c\` was added)`);
console.log(`  Checked before cutoff:    ${checkedBefore.toLocaleString()}  (${pct(checkedBefore, withChecked)} of checked)`);
console.log(`  Checked on/after cutoff:  ${checkedAfter.toLocaleString()}  (${pct(checkedAfter, withChecked)} of checked)`);
if (checkedUnparseable) {
  console.log(`  statsChecked unparseable: ${checkedUnparseable.toLocaleString()}  ⚠ present but not a readable date — investigate`);
}
console.log('─'.repeat(64));
console.log(`  Players with a \`c\`:       ${withC.toLocaleString()}`);
console.log(`  Total \`c\` entries:        ${cEntries.toLocaleString()}   ← the §2.10 recovery queue, reachable with NO API calls`);
console.log(`  Players with an \`x\`:      ${withX.toLocaleString()}  (${xEntries.toLocaleString()} entries)`);
console.log('─'.repeat(64));
console.log(`  BLIND SPOT:               ${blindSpot.toLocaleString()}  players checked BEFORE the cutoff with no \`c\``);
console.log(`     These may or may not have gaps — the question was never asked of them.`);
console.log(`     A \`c\`-driven recovery CANNOT SEE THEM. They need the API route`);
console.log(`     (repair-players-batch) or a re-fetch to compute \`c\`.`);
console.log(`  Reachable, no gap:        ${reachableNoGap.toLocaleString()}  checked since the cutoff, \`c\` genuinely empty`);
console.log('─'.repeat(64));
console.log(`  \`c\` SIZE DISTRIBUTION  (for the staged-rollout question)`);
let lower = 0;
for (const b of BANDS) {
  const n = bands.get(b);
  const label = lower + 1 === b ? `${b}` : `${lower + 1}–${b}`;
  console.log(`    ${String(label).padStart(9)} : ${String(n.toLocaleString()).padStart(9)}  (${pct(n, withC)})`);
  lower = b;
}
console.log(`    ${String(`>${lower}`).padStart(9)} : ${String(bandOver.toLocaleString()).padStart(9)}  (${pct(bandOver, withC)})`);
if (worst.length) {
  console.log('─'.repeat(64));
  console.log(`  LARGEST \`c\` (validate any build against these first)`);
  for (const w of worst.slice(0, 10)) {
    console.log(`    ${w.uuid.slice(0, 13)}  ${String(w.n).padStart(5)}  ${w.name}`);
  }
}
console.log('─'.repeat(64));
console.log(`  Read-only — nothing was written.`);
