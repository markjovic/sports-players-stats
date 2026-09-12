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
//
// ─── EMPTY SHELLS (added 2026-09-11) ─────────────────────────────────────────
// A player file holding a non-zero career (gp > 0) with an EMPTY games[] is the
// signature of one person split across two files. Worked example, verified by
// probe-player on both sides:
//
//   11fdc0c2 Jade Chow   gp 373  pts 2969  games[] 372   ← spectator-namespace id,
//                                                          the one in every roster
//   692caea1 Jade Chow   gp 373  pts 2969  games[] 0     ← api-namespace profile
//
// IDENTICAL totals, because both were written from the SAME PlayHQ profile.
// games[] is built only from roster ids (build-player-games phase 1), the rosters
// carry the spectator id, so every game lands on one file and none on the other.
// The shell's `c` is then the whole career — 374 entries — which is arithmetic,
// not a capture gap. This is the Jordan Uppal shape recorded in claude_context.md
// 2026-09-05/06, surfacing through `c` instead of `x`.
//
// ⚠ gp > 0 WITH games[] EMPTY IS A CANDIDATE, NOT A VERDICT. The same shape is
// produced by a player whose games genuinely were never captured — seasons we do
// not hold, or holes a capture sweep has not filled. Counting the shape alone
// would report those as splits.
//
// The discriminator is UUID-ONLY and needs no names: take the shell's `c` — the
// games PlayHQ credits it — and ask whether those games are ALREADY HELD with a
// NON-EMPTY ROSTER. If they are, the appearances exist in the database under some
// other id and this file is a duplicate. If they are not held, nothing was ever
// captured and it is a capture gap. That is the same test the Uppal case used:
// game-id set overlap between files, no name comparison anywhere.

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

// ─── Pass 1: which games are HELD with a non-empty roster ────────────────────
// Same shape as build-player-games.js phase 1 (L168-208) but cheaper: it only
// needs to know a game EXISTS and has someone in it, so no p[] id resolution and
// no players/indexes lookups. Gids only.
const GAMES_DIR = path.join(ROOT, 'games', 'bv');
const heldWithRoster = new Set();
let gameFiles = 0, gamesSeen = 0, gamesEmptyRoster = 0;
if (fs.existsSync(GAMES_DIR)) {
  for (const fname of fs.readdirSync(GAMES_DIR)) {
    if (!fname.endsWith('.json')) continue;
    gameFiles++;
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); } catch { continue; }
    for (const [gid, g] of Object.entries(gf.games || {})) {
      gamesSeen++;
      if (g && Array.isArray(g.p) && g.p.length) heldWithRoster.add(gid);
      else gamesEmptyRoster++;
    }
  }
  console.log(`  games/bv: ${gameFiles.toLocaleString()} season file(s), ${gamesSeen.toLocaleString()} games, ${heldWithRoster.size.toLocaleString()} with a non-empty roster`);
} else {
  console.log('  ⚠ games/bv not present — empty-shell classification will be skipped');
}

const prefixes = fs.readdirSync(PLAYERS_DIR)
  .filter(f => /^[0-9a-f]{2}$/.test(f))
  .sort();

let total = 0, withChecked = 0, withoutChecked = 0, errors = 0;
let checkedBefore = 0, checkedAfter = 0, checkedUnparseable = 0;
let withC = 0, cEntries = 0, withX = 0, xEntries = 0;
// Empty shells: gp > 0 and games[] empty or absent.
let shells = 0, shellsNoC = 0, shellsHeld = 0, shellsUnheld = 0, shellsMixed = 0;
let shellGp = 0;
const shellList = [];
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

      // ── Empty shell classification (uuid/gid only — no names) ──────────────
      const gp = Number(bk?.gp) || 0;
      const gamesHeld = Array.isArray(player.games) ? player.games.length : 0;
      if (gp > 0 && gamesHeld === 0) {
        shells++;
        shellGp += gp;
        if (!c || !c.length) {
          // No credited list to test against — cannot be classified either way.
          shellsNoC++;
        } else {
          let held = 0;
          for (const gid of c) if (heldWithRoster.has(gid)) held++;
          const all = held === c.length;
          const none = held === 0;
          if (all)       shellsHeld++;
          else if (none) shellsUnheld++;
          else           shellsMixed++;
          shellList.push({ uuid: fname.replace(/\.json$/, ''), name: player.name || '?', gp, c: c.length, held });
        }
      }
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
console.log(`  EMPTY SHELLS  —  gp > 0 with an EMPTY games[]`);
console.log(`    Total shells:           ${shells.toLocaleString()}   (${shellGp.toLocaleString()} games played credited to files holding no games)`);
console.log(`    ├─ every \`c\` game HELD:  ${shellsHeld.toLocaleString()}   ← DUPLICATE FILE: the appearances exist under another id`);
console.log(`    ├─ some held, some not: ${shellsMixed.toLocaleString()}   ← mixed; needs reading one at a time`);
console.log(`    ├─ NO \`c\` game held:    ${shellsUnheld.toLocaleString()}   ← genuine capture gap: nothing was ever captured`);
console.log(`    └─ no \`c\` at all:       ${shellsNoC.toLocaleString()}   ← cannot be classified from files`);
console.log('');
console.log(`    "every c game HELD" is the Jade Chow / Jordan Uppal shape: one person,`);
console.log(`    two player files, stats written to both from the same PlayHQ profile,`);
console.log(`    and every appearance filed under the OTHER uuid. The game files are`);
console.log(`    CORRECT for these — nothing is missing from any roster and nothing`);
console.log(`    should be appended. It is the player files that carry a duplicate.`);
if (shellList.length) {
  const dup = shellList.filter(s2 => s2.held === s2.c).sort((a, b) => b.c - a.c).slice(0, 15);
  if (dup.length) {
    console.log('');
    console.log(`    LARGEST DUPLICATE-FILE SHELLS`);
    console.log(`      ${'uuid'.padEnd(15)}${'gp'.padStart(6)}${'c'.padStart(6)}  name`);
    for (const s2 of dup) {
      console.log(`      ${s2.uuid.slice(0, 13).padEnd(15)}${String(s2.gp).padStart(6)}${String(s2.c).padStart(6)}  ${s2.name}`);
    }
  }
  const gap = shellList.filter(s2 => s2.held === 0).sort((a, b) => b.c - a.c).slice(0, 10);
  if (gap.length) {
    console.log('');
    console.log(`    LARGEST GENUINE-CAPTURE-GAP SHELLS (nothing of theirs is held)`);
    for (const s2 of gap) {
      console.log(`      ${s2.uuid.slice(0, 13).padEnd(15)}${String(s2.gp).padStart(6)}${String(s2.c).padStart(6)}  ${s2.name}`);
    }
  }
}
console.log('─'.repeat(64));
console.log(`  Read-only — nothing was written.`);
