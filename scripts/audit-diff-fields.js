// scripts/audit-diff-fields.js
//
// READ-ONLY. No PlayHQ calls, no writes, no commit. Prints and exits.
//
// Answers one question: did fetch-profile-stats.js actually write the
// sports.Basketball.c and .x exception diff, and does it say what it should?
//
//   c  PlayHQ credits the game, games[] does not hold it. The appearance-gap
//      recovery queue.
//   x  games[] holds it, PlayHQ does not credit it, and it is not a forfeit.
//
// WHY A SCRIPT AND NOT A SPOT CHECK. Both fields are DELETED rather than written
// empty when there is no disagreement, so a player whose capture and credit agree
// carries neither — and most do. Opening one file at random therefore proves
// nothing either way, and there is no way to pick a mismatched player from a
// directory listing. This finds them.
//
// THE CHECK THAT MATTERS is not the counts, it is the cross-check: for every
// player, gp - games.length should equal c.length - x.length. Both sides are
// derived from the same two sets, so if the identity fails on any player the diff
// was computed against something other than what is on the file. That is reported
// as a hard mismatch with examples, not as a percentage.
//
// A player is only in scope if statsChecked is present AND newer than the cutoff:
// a file last fetched before the diff code shipped cannot carry these fields, and
// counting it as a miss would report the deployment date as a fault.
//
// Run:
//   node scripts/audit-diff-fields.js --shard=00
//   node scripts/audit-diff-fields.js --shard=00 --since=2026-09-03

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');

const args   = process.argv.slice(2);
const argVal = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };

const SHARD = String(argVal('shard', '00')).toLowerCase();
const SINCE = argVal('since', '');            // ISO date; blank = no cutoff
const SINCE_MS = SINCE ? Date.parse(SINCE) : NaN;

if (!/^[0-9a-f]{2}$/.test(SHARD)) {
  console.error('Usage: node scripts/audit-diff-fields.js --shard=<2 hex chars> [--since=YYYY-MM-DD]');
  process.exit(1);
}

const dir = path.join(PLAYERS_DIR, SHARD);
if (!fs.existsSync(dir)) { console.error(`FATAL: ${dir} does not exist. Checkout incomplete?`); process.exit(1); }

console.log(`\naudit-diff-fields  shard=${SHARD}${SINCE ? `  since=${SINCE}` : ''}`);
console.log('─'.repeat(68));

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

let total = 0, noStats = 0, tooOld = 0, inScope = 0;
let withC = 0, withX = 0, withBoth = 0, withNeither = 0;
let cEntries = 0, xEntries = 0;
let identityOk = 0, identityBad = 0;
const badRows = [], cRows = [], xRows = [];
const checkedDates = new Map();

for (const fname of files) {
  total++;
  let p;
  try { p = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
  const bk = p.sports && p.sports.Basketball;
  if (!bk || !bk.statsChecked) { noStats++; continue; }

  const day = String(bk.statsChecked).slice(0, 10);
  checkedDates.set(day, (checkedDates.get(day) || 0) + 1);

  if (Number.isFinite(SINCE_MS) && Date.parse(bk.statsChecked) < SINCE_MS) { tooOld++; continue; }
  inScope++;

  const c = Array.isArray(bk.c) ? bk.c : null;
  const x = Array.isArray(bk.x) ? bk.x : null;
  const games = Array.isArray(p.games) ? p.games.length : 0;
  const gp = Number(bk.gp) || 0;

  if (c) { withC++; cEntries += c.length; }
  if (x) { withX++; xEntries += x.length; }
  if (c && x) withBoth++;
  if (!c && !x) withNeither++;

  // Empty arrays must never be on the file — absent is the contract.
  if ((c && c.length === 0) || (x && x.length === 0)) {
    badRows.push({ uuid: fname.slice(0, 8), why: 'empty array written instead of deleted', gp, games, c: c ? c.length : null, x: x ? x.length : null });
    identityBad++;
    continue;
  }

  // THE CROSS-CHECK. credited - captured == c - x, by construction.
  // gp is PlayHQ's own count of credited games and games.length is ours, so the
  // difference between them must equal the difference between the two lists.
  const lhs = gp - games;
  const rhs = (c ? c.length : 0) - (x ? x.length : 0);
  if (lhs === rhs) identityOk++;
  else {
    identityBad++;
    if (badRows.length < 15) badRows.push({ uuid: fname.slice(0, 8), why: `gp-games=${lhs} but c-x=${rhs}`, gp, games, c: c ? c.length : 0, x: x ? x.length : 0 });
  }

  if (c && cRows.length < 8) cRows.push({ uuid: fname.slice(0, 8), name: p.name, gp, games, c: c.length, sample: c.slice(0, 3) });
  if (x && xRows.length < 8) xRows.push({ uuid: fname.slice(0, 8), name: p.name, gp, games, x: x.length, sample: x.slice(0, 3) });
}

const pct = (n, d) => d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';

console.log(`  files in shard              : ${total.toLocaleString()}`);
console.log(`  no statsChecked (never fetched) : ${noStats.toLocaleString()}`);
if (SINCE) console.log(`  fetched before ${SINCE}   : ${tooOld.toLocaleString()}  (out of scope)`);
console.log(`  in scope                    : ${inScope.toLocaleString()}`);

console.log(`\n  carrying c : ${withC.toLocaleString()}  ${pct(withC, inScope)}   ${cEntries.toLocaleString()} entries`);
console.log(`  carrying x : ${withX.toLocaleString()}  ${pct(withX, inScope)}   ${xEntries.toLocaleString()} entries`);
console.log(`  carrying both    : ${withBoth.toLocaleString()}`);
console.log(`  carrying neither : ${withNeither.toLocaleString()}  ${pct(withNeither, inScope)}  (capture and credit agree exactly)`);

console.log(`\n  CROSS-CHECK  gp - games[] == c - x`);
console.log(`    holds  : ${identityOk.toLocaleString()}  ${pct(identityOk, inScope)}`);
console.log(`    FAILS  : ${identityBad.toLocaleString()}  ${pct(identityBad, inScope)}`);
if (identityBad) {
  console.log('    failures (a failure means the diff was computed against something other than this file):');
  for (const r of badRows) console.log(`      ${r.uuid}  gp=${r.gp} games=${r.games} c=${r.c} x=${r.x}  — ${r.why}`);
}

console.log('\n  players carrying c (PlayHQ credits, we do not hold):');
for (const r of cRows) console.log(`    ${r.uuid}  gp=${String(r.gp).padStart(4)} games=${String(r.games).padStart(4)}  c=${String(r.c).padStart(3)}  ${JSON.stringify(r.sample)}  ${(r.name || '').slice(0, 24)}`);
if (!cRows.length) console.log('    — none');

console.log('\n  players carrying x (we hold, PlayHQ does not credit, not a forfeit):');
for (const r of xRows) console.log(`    ${r.uuid}  gp=${String(r.gp).padStart(4)} games=${String(r.games).padStart(4)}  x=${String(r.x).padStart(3)}  ${JSON.stringify(r.sample)}  ${(r.name || '').slice(0, 24)}`);
if (!xRows.length) console.log('    — none');

// statsChecked dates. If the shard was just force-swept these should cluster on
// one day; a spread means the commit has not landed or the sweep did not cover it.
console.log('\n  statsChecked by day (top 6):');
for (const [d, n] of [...checkedDates].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`    ${d}  ${n.toLocaleString()}`);
}

if (inScope > 0 && withC === 0 && withX === 0) {
  console.log('\n  \u26a0 NOT ONE player in scope carries either field.');
  console.log('    Either the commit from the fetch has not landed yet — check statsChecked');
  console.log('    above, it should read the day of the sweep — or the write path is wrong.');
  process.exitCode = 1;
}
