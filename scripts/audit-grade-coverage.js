// scripts/audit-grade-coverage.js
//
// READ-ONLY. No PlayHQ calls, no writes, no commit, no lock. Reads the game
// files already in the checkout and prints to the job log.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// `gn` (grade name) and `gid` (grade id) are what StatTrack groups fixtures by.
// A game without `gn` falls into the "Grade not recorded" bucket on the Clubs
// tab and shows no age band — the fault Mark reported on 2026-10-11 ("future
// fixtures for the saturday comp is not showing age bands").
//
// discover-fixtures.js was fixed on 2026-10-12 to write both on every entry and
// to TRACK them, so an existing fixture is backfilled on the next sweep. The
// sweep then reported `0 new, 0 updated` on every season, which READS like the
// fix never ran. It is not: spot-checked against main on 2026-10-12,
//
//     2e623bd2  Fratelli Frankston JD Winter 2026   5,835 games   100% gn
//     3f8e0029  Junior Domestic Winter 2026         6,547 games   100% gn  (244/244 upcoming)
//     e26f328b  Junior Domestic Summer 2025/26      6,501 games   100% gn
//
// — so `0 updated` was the CORRECT answer for those seasons. The backfill is
// real but PARTIAL, and the seasons that still need it are further down a queue
// of 427 that the sweep will not reach inside its timeout:
//
//     1ae60211  EDJBA Winter 2026                  12,842 games    41% gn
//     96c25259  After School Spring 2026              983 games    48% gn  (48/556 upcoming)
//
// ⚠️ SO THE PROBLEM IS NOT THE SCRIPT, IT IS THE ORDER. Grinding 447 seasons to
// reach the dozen that are short is what the 403 storm makes impossible. This
// audit produces the worklist so those seasons can be dispatched BY ID, which
// costs one sweep per season instead of one sweep per repository.
//
// ⚠️ MAIN REPO ONLY. Locked seasons' game files live in the ARCHIVE repo
// (§6.44, the active/locked split), so a season absent from games/bv here is
// reported as ABSENT and never as 0% — a file this audit cannot see is not a
// season with no grades.
//
// Usage:
//   node scripts/audit-grade-coverage.js
//   node scripts/audit-grade-coverage.js --threshold=95
//   node scripts/audit-grade-coverage.js --threshold=100 --upcoming-only
//   node scripts/audit-grade-coverage.js --limit=40 --include-locked
//
// NO setup-node in the workflow is not required here — this makes no PlayHQ
// call — but it is omitted anyway to match every other job in this repo.

'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg  = (f, d) => { const a = args.find(x => x.startsWith('--' + f + '=')); return a ? a.split('=')[1] : d; };
const has  = (f) => args.includes('--' + f);

const THRESHOLD      = Math.max(0, Math.min(100, parseFloat(arg('threshold', '100'))));
const LIMIT          = Math.max(1, parseInt(arg('limit', '60'), 10) || 60);
const UPCOMING_ONLY  = has('upcoming-only');
const INCLUDE_LOCKED = has('include-locked');

const GAMES_DIR  = path.join(ROOT, 'games', 'bv');
const INDEX_FILE = path.join(ROOT, 'data', 'sports-index.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function main() {
  // A missing index is fatal, not a reason to report every season as unnamed.
  // Guessing here would turn "I could not read the index" into "these seasons
  // have no name", which is the failure class this repo keeps tripping over.
  const idx = readJson(INDEX_FILE);
  if (!idx || !idx.seasons) {
    console.error('✗ data/sports-index.json could not be read — aborting rather than reporting unnamed seasons.');
    process.exit(1);
  }
  if (!fs.existsSync(GAMES_DIR)) {
    console.error('✗ games/bv does not exist in this checkout — nothing to audit.');
    process.exit(1);
  }

  const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
  console.log(`audit-grade-coverage [READ-ONLY] — ${files.length} season file(s) in games/bv`);
  console.log(`threshold ${THRESHOLD}%${UPCOMING_ONLY ? ', UPCOMING games only' : ''}`
            + `${INCLUDE_LOCKED ? ', locked seasons included' : ', locked seasons skipped'}\n`);

  const rows = [];
  let totalGames = 0, totalMissing = 0, skippedLocked = 0, unreadable = [];

  for (const f of files) {
    const sid  = f.replace(/\.json$/, '');
    const meta = idx.seasons[sid] || {};
    if (!INCLUDE_LOCKED && meta.locked === true) { skippedLocked++; continue; }

    const j = readJson(path.join(GAMES_DIR, f));
    // An unreadable file is reported BY NAME, never counted as 0% — a parse
    // failure and a season with no grades must not read the same.
    if (!j) { unreadable.push(sid); continue; }

    const games = j.games || j;
    let n = 0, gn = 0, gid = 0, upN = 0, upGn = 0;
    for (const k of Object.keys(games)) {
      const g = games[k]; if (!g || typeof g !== 'object') continue;
      n++; if (g.gn) gn++; if (g.gid) gid++;
      if (g.st === 'UPCOMING') { upN++; if (g.gn) upGn++; }
    }
    if (!n) continue;

    totalGames += n; totalMissing += (n - gn);
    const basisN  = UPCOMING_ONLY ? upN  : n;
    const basisGn = UPCOMING_ONLY ? upGn : gn;
    if (!basisN) continue;                       // no upcoming games is not a gap
    const pct = 100 * basisGn / basisN;
    if (pct >= THRESHOLD) continue;

    rows.push({
      sid, name: (meta.fullName || meta.name || '(not in index)').slice(0, 44),
      n, gn, gid, upN, upGn, missing: basisN - basisGn, pct,
    });
  }

  rows.sort((a, b) => b.missing - a.missing || b.n - a.n);

  if (!rows.length) {
    console.log(`✓ every season audited is at or above ${THRESHOLD}% — no worklist.`);
  } else {
    console.log('  season    games   gn      gid     upcoming gn   coverage  missing  name');
    console.log('  ' + '-'.repeat(104));
    for (const r of rows.slice(0, LIMIT)) {
      console.log('  ' + r.sid.padEnd(10)
        + String(r.n).padStart(6) + '  '
        + (r.gn + '').padStart(6) + '  '
        + (r.gid + '').padStart(6) + '  '
        + (r.upN ? (r.upGn + '/' + r.upN) : '—').padStart(11) + '  '
        + (r.pct.toFixed(1) + '%').padStart(8) + '  '
        + String(r.missing).padStart(7) + '  '
        + r.name);
    }
    if (rows.length > LIMIT) console.log(`  … and ${rows.length - LIMIT} more below the threshold (raise --limit to see them)`);

    console.log('\n  WORKLIST — dispatch Discover fixtures with `season` set to each of these,');
    console.log('  worst first. One sweep per season; do NOT run the full 447.');
    console.log('\n  ' + rows.slice(0, LIMIT).map(r => r.sid).join(','));
  }

  console.log('\n  SUMMARY');
  console.log('    seasons audited            : ' + (files.length - skippedLocked - unreadable.length));
  console.log('    games seen                 : ' + totalGames.toLocaleString());
  console.log('    games with no grade name   : ' + totalMissing.toLocaleString()
            + (totalGames ? '  (' + (100 * totalMissing / totalGames).toFixed(1) + '%)' : ''));
  console.log('    seasons below threshold    : ' + rows.length);
  if (!INCLUDE_LOCKED) console.log('    locked seasons skipped     : ' + skippedLocked + '  (--include-locked to audit them; their files live in the ARCHIVE repo, so most will read as absent here)');
  if (unreadable.length) {
    console.log('    ⚠ UNREADABLE               : ' + unreadable.length);
    for (const s of unreadable.slice(0, 20)) console.log('        ' + s);
    console.log('      These are NOT counted as 0% — a file that could not be parsed is not a season without grades.');
  }
  console.log('\nDone. READ-ONLY — nothing was written.');
}

main();
