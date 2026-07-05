// scripts/scan-complete-rounds.js
//
// One-time (re-runnable) OFFLINE backfill. NO API calls. Scans existing game data
// and writes roundsComplete markers for rounds whose games are all terminal, so a
// subsequent high --rounds-back crawl skips settled rounds immediately instead of
// waiting for the 7-day grace to accrue.
//
// Marker key is (gradeId, roundName) — stored games carry gid + rn (round NAME),
// not a round UUID — matching nightly-crawl.js exactly:
//   gf.roundsComplete[gid][roundName] = { at, n }
// Backfilled markers use an OLD `at` sentinel so the live crawl treats them as
// past-grace (skippable) at once. Existing markers (written live, with a real `at`)
// are never modified — the scan only FILLS gaps.
//
// Also prints a scale report: how many rounds in how many seasons are NOT markable,
// split into "live" (UPCOMING/POSTPONED/IN_PROGRESS — expected) vs "suspect"
// (missing status / unattributable games — the go-refetch signal).
//
// Usage:
//   node scripts/scan-complete-rounds.js            # scan all seasons, write markers
//   node scripts/scan-complete-rounds.js --season=<id>
//   node scripts/scan-complete-rounds.js --dry-run  # report only, no writes

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games', 'bv');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; })
);
const DRY_RUN       = !!ARGS['dry-run'];
const TARGET_SEASON = ARGS.season || null;
const DO_UNLOCK     = !!ARGS['unlock'];   // reopen locked seasons proven incomplete (opt-in)
const INDEX_FILE    = path.join(ROOT, 'data', 'sports-index.json');

// Sentinel: older than any grace window, so the live crawl skips these at once.
const BACKFILL_AT = '2000-01-01T00:00:00.000Z';

// MUST match nightly-crawl.js isGameTerminal.
const TERMINAL_STATUS = new Set(['FINAL', 'CANCELLED', 'ABANDONED', 'BYE']);
const LIVE_STATUS     = new Set(['UPCOMING', 'IN_PROGRESS', 'POSTPONED']);
function isGameTerminal(g) {
  return !!g.forfeit || TERMINAL_STATUS.has(g.st);
}

const files = TARGET_SEASON
  ? [`${TARGET_SEASON}.json`]
  : (fs.existsSync(GAMES_DIR) ? fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')) : []);

if (!files.length) { console.error(`No game files in ${GAMES_DIR}`); process.exit(1); }

console.log('scan-complete-rounds.js' + (DRY_RUN ? '  [dry-run]' : ''));
console.log(`  scanning ${files.length} season file(s)\n`);

let seasonsScanned = 0, seasonsWritten = 0;
let roundsTotal = 0, roundsComplete = 0, roundsMarkedNew = 0;
let roundsLive = 0, roundsSuspect = 0;
let seasonsWithIncomplete = 0, seasonsFullyComplete = 0;
let gamesNoRn = 0, seasonsWithNoRn = 0;
const perSeasonIncomplete = [];   // { sid, incomplete }

for (const file of files) {
  const sid = path.basename(file, '.json');
  let gf;
  try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8')); }
  catch { continue; }
  if (!gf || !gf.games) continue;
  seasonsScanned++;

  // Group games by (gid, roundName)
  const rounds = new Map();   // `${gid}\u0000${rn}` -> { gid, rn, games: [] }
  let seasonNoRn = 0;
  for (const g of Object.values(gf.games)) {
    if (!g.rn || !g.gid) { seasonNoRn++; continue; }
    const key = `${g.gid}\u0000${g.rn}`;
    if (!rounds.has(key)) rounds.set(key, { gid: g.gid, rn: g.rn, games: [] });
    rounds.get(key).games.push(g);
  }
  if (seasonNoRn) { gamesNoRn += seasonNoRn; seasonsWithNoRn++; }

  gf.roundsComplete = gf.roundsComplete || {};
  let seasonChanged = false, seasonIncomplete = 0;

  for (const { gid, rn, games } of rounds.values()) {
    roundsTotal++;
    const complete = games.length > 0 && games.every(isGameTerminal);
    if (complete) {
      roundsComplete++;
      const byGrade = gf.roundsComplete[gid] || (gf.roundsComplete[gid] = {});
      if (!byGrade[rn]) {                       // fill gap only — never touch a live marker
        byGrade[rn] = { at: BACKFILL_AT, n: games.length };
        roundsMarkedNew++; seasonChanged = true;
      }
    } else {
      seasonIncomplete++;
      // classify: live (only expected non-terminal) vs suspect (missing/unknown status)
      const nonTerminal = games.filter(g => !isGameTerminal(g));
      const suspect = nonTerminal.some(g => !g.st || (!LIVE_STATUS.has(g.st) && !TERMINAL_STATUS.has(g.st)));
      if (suspect) roundsSuspect++; else roundsLive++;
    }
  }

  if (seasonIncomplete === 0 && rounds.size > 0) seasonsFullyComplete++;
  if (seasonIncomplete > 0) { seasonsWithIncomplete++; perSeasonIncomplete.push({ sid, incomplete: seasonIncomplete }); }

  if (seasonChanged && !DRY_RUN) {
    fs.writeFileSync(path.join(GAMES_DIR, file), JSON.stringify(gf));
    seasonsWritten++;
  } else if (seasonChanged) {
    seasonsWritten++;   // would-write count in dry-run
  }
}

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '0.0');

console.log('══════════════════════════════════════════════════');
console.log(`  Seasons scanned:            ${seasonsScanned}`);
console.log(`  Rounds identified:          ${roundsTotal}`);
console.log(`  Rounds complete:            ${roundsComplete}  (${pct(roundsComplete, roundsTotal)}%)`);
console.log(`  Markers newly written:      ${roundsMarkedNew}${DRY_RUN ? ' (would write)' : ''}`);
console.log(`  Season files ${DRY_RUN ? 'to change' : 'changed'}:       ${seasonsWritten}`);
console.log('  ────────────────────────────────────────────────');
console.log(`  Rounds NOT markable:        ${roundsTotal - roundsComplete}`);
console.log(`    · live (upcoming/postponed/in-progress): ${roundsLive}   ← expected, not a gap`);
console.log(`    · suspect (missing/unknown status):      ${roundsSuspect}   ← likely real gaps`);
console.log(`  Seasons with ≥1 incomplete: ${seasonsWithIncomplete}`);
console.log(`  Seasons fully complete:     ${seasonsFullyComplete}   ← season-lock candidates (verify via API)`);
if (gamesNoRn) console.log(`  Games with no round (rn):   ${gamesNoRn}  across ${seasonsWithNoRn} seasons  ← unattributable`);
console.log('══════════════════════════════════════════════════');

perSeasonIncomplete.sort((a, b) => b.incomplete - a.incomplete);
if (perSeasonIncomplete.length) {
  console.log('  Top seasons by incomplete rounds:');
  for (const { sid, incomplete } of perSeasonIncomplete.slice(0, 10)) {
    console.log(`    ${sid}: ${incomplete}`);
  }
}
// ── High-precision unlock ────────────────────────────────────────────────────
// Reopen any LOCKED season we can PROVE is incomplete (a round with a live/suspect
// game). We can only prove incompleteness from data we hold — we CANNOT prove a
// locked-and-complete-looking season is whole (missing rounds are invisible offline;
// that is the live crawl's API job). So this ONLY ever reopens; it never locks.
const incompleteSids = new Set(perSeasonIncomplete.map(x => x.sid));
if (fs.existsSync(INDEX_FILE)) {
  const raw = fs.readFileSync(INDEX_FILE, 'utf8');
  let idx = null; try { idx = JSON.parse(raw); } catch {}
  if (idx && idx.seasons) {
    const candidates = Object.values(idx.seasons)
      .filter(se => se.locked === true && incompleteSids.has(se.id));
    console.log('  ────────────────────────────────────────────────');
    console.log(`  Locked seasons proven incomplete: ${candidates.length}`);
    for (const se of candidates.slice(0, 20)) console.log(`    ${se.id}  ${se.name || se.fullName || ''}`);
    if (DO_UNLOCK && !DRY_RUN && candidates.length) {
      for (const se of candidates) { se.locked = false; delete se.lockedAt; }
      const m = raw.match(/\n( +)"/);                    // preserve existing indentation
      const indent = m ? m[1].length : 0;
      fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, indent));
      console.log(`  \u2714 Reopened ${candidates.length} season(s) in sports-index.json`);
    } else if (candidates.length) {
      console.log('  (report only — pass --unlock to reopen; first reconcile with whatever sets `locked`, or it may re-lock them)');
    }
  }
} else {
  console.log('  (sports-index.json not in checkout — unlock check skipped)');
}
console.log('══════════════════════════════════════════════════');

console.log('\nDone.');
