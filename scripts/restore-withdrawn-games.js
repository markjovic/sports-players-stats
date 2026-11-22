// scripts/restore-withdrawn-games.js
//
// Puts back games that nightly-crawl's Phase 2R deleted, from the full entries
// it archived to data/withdrawn-games/{sid}.json before removing them.
//
// WHY THIS EXISTS. The deletion caps used to ABORT a run: exceed a flat count
// and nothing was deleted until a human raised a number by hand. First live
// contact showed that was the wrong instrument — MEBA published a fixture,
// regraded, and legitimately withdrew several hundred games from one season, so
// the cap fired on the normal case while a bug deleting fifty WRONG games would
// have passed it untouched. Volume is not evidence of error.
//
// The cap was only ever justified because deletion was irreversible. This is the
// tool that makes it reversible, so the cap could become a warning. It is not a
// nicety: without it "archived" means "recorded somewhere nobody can use", which
// this repository has enough of already.
//
// Usage:
//   node scripts/restore-withdrawn-games.js --list
//   node scripts/restore-withdrawn-games.js --list --season=<sid>
//   node scripts/restore-withdrawn-games.js --season=<sid> --dry-run
//   node scripts/restore-withdrawn-games.js --season=<sid> --apply
//   node scripts/restore-withdrawn-games.js --game=<gameId> --apply
//   node scripts/restore-withdrawn-games.js --since=2026-11-22 --apply
//   node scripts/restore-withdrawn-games.js --season=<sid> --apply --keep-archive
//
// DEFAULT IS A DRY RUN. --apply is required to write anything, because a restore
// is itself a write to games/bv and the failure direction must be "do less".
//
// A restored game is written back ONLY if the id is absent from the season file.
// If something has since recreated it, the live copy wins and the restore says
// so — overwriting current data with an older snapshot is exactly the kind of
// silent loss the archive exists to prevent.
//
// ⚠ AFTER RESTORING, REBUILD. team-stats/bv/{sid}.json is derived from games/bv
// and is rebuilt by the nightly's own team-stats job, so a restore is not
// visible in StatTrack until that runs. build-player-games is unaffected: an
// unplayed game carries no p[] and was never in any player's games[].

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const ARCHIVE_DIR = path.join(ROOT, 'data', 'withdrawn-games');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');

const LIST    = !!ARGS.list;
const APPLY   = !!ARGS.apply;
const SEASON  = ARGS.season ? String(ARGS.season).trim() : null;
const GAME    = ARGS.game   ? String(ARGS.game).trim()   : null;
const SINCE   = ARGS.since  ? String(ARGS.since).trim()  : null;
const KEEP    = !!ARGS['keep-archive'];

const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_MAXBUF     = 512 * 1024 * 1024;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// House git pattern: per-path add, staged shortstat, COMMIT FIRST, then
// fetch / merge -X ours --no-stat / push with a 60-attempt jittered retry that
// THROWS on exhaustion. A red job beats silently discarded work.
function gitCommit(message, paths) {
  let addFailures = 0;
  for (const p of paths) {
    try { execFileSync('git', ['add', '--', p], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF }); }
    catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      if (/did not match any file/i.test(detail)) continue;
      addFailures++;
      console.error(`  ⚠ git add FAILED "${p}": ${detail}`);
    }
  }
  let staged = '';
  try { staged = execFileSync('git', ['diff', '--staged', '--shortstat'], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF }).toString().trim(); }
  catch (_) {}
  if (!staged) {
    if (addFailures) throw new Error(`gitCommit: nothing staged and ${addFailures} path(s) failed to stage — refusing to report a clean no-op`);
    console.log('  (no changes to commit)');
    return;
  }
  console.log(`  staging: ${staged}`);

  const IDENT = ['-c', 'user.name=github-actions[bot]',
                 '-c', 'user.email=github-actions[bot]@users.noreply.github.com'];
  try { execFileSync('git', [...IDENT, 'commit', '-q', '-m', message], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF }); }
  catch (e) {
    throw new Error(`gitCommit: commit failed — ${((e.stderr && e.stderr.toString()) || e.message || '').trim()}`);
  }

  const MAX = 60;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try { execFileSync('git', ['merge', '--abort'], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF }); } catch (_) {}
    try { execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF }); }
    catch (e) {
      if (attempt === MAX) throw e;
      const s = 1 + Math.floor(Math.random() * 91);
      console.log(`  fetch failed (attempt ${attempt}/${MAX}), retrying in ${s}s`);
      try { execFileSync('sleep', [String(s)], { stdio: 'pipe', timeout: (s + 30) * 1000 }); } catch (_) {}
      continue;
    }
    execFileSync('git', [...IDENT, 'merge', '-q', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat'], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF });
    try {
      execFileSync('git', ['push', 'origin', 'HEAD:main'], { stdio: 'pipe', cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF });
      console.log(`  ✓ Committed: ${message} (pushed on attempt ${attempt})`);
      return;
    } catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
      if (!/non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(detail)) {
        console.error(`  push failed — NOT contention, failing fast. git said:\n${detail}`);
        throw e;
      }
      if (attempt === MAX) throw e;
      const s = 1 + Math.floor(Math.random() * 91);
      console.log(`  push attempt ${attempt}/${MAX} rejected, re-syncing in ${s}s`);
      try { execFileSync('sleep', [String(s)], { stdio: 'pipe', timeout: (s + 30) * 1000 }); } catch (_) {}
    }
  }
  throw new Error(`gitCommit: exhausted ${MAX} push attempts`);
}

function main() {
  console.log('restore-withdrawn-games.js');
  if (!APPLY && !LIST) console.log('  ⚠ DRY RUN — pass --apply to write anything');
  console.log('─'.repeat(70));

  if (!fs.existsSync(ARCHIVE_DIR)) {
    console.log('data/withdrawn-games/ does not exist — nothing has ever been deleted by the refresh.');
    return;
  }

  let files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json')).sort();
  if (SEASON) files = files.filter(f => f === `${SEASON}.json`);
  if (!files.length) {
    console.error(`No archive found${SEASON ? ` for season ${SEASON}` : ''}.`);
    process.exit(1);
  }

  let totalArchived = 0, totalRestored = 0, totalOccupied = 0, totalFiltered = 0;
  const touchedSeasons = [];

  for (const fname of files) {
    const sid = fname.replace(/\.json$/, '');
    const arch = readJson(path.join(ARCHIVE_DIR, fname));
    const ids = Object.keys(arch);
    totalArchived += ids.length;

    const wanted = ids.filter(id => {
      if (GAME && id !== GAME) return false;
      if (SINCE && !(String(arch[id].at || '') >= SINCE)) return false;
      return true;
    });
    totalFiltered += wanted.length;
    if (!wanted.length) continue;

    if (LIST) {
      console.log(`\n${sid}  —  ${ids.length} archived, ${wanted.length} match`);
      for (const id of wanted.slice(0, 50)) {
        const a = arch[id];
        const e = a.entry || {};
        console.log(`  ${id}  deleted ${String(a.at).slice(0, 19)}  round "${a.rn}"  gid ${String(a.gid).slice(0, 8)}`
                  + `  d=${e.d || '∅'}  ${e.hn || '?'} v ${e.an || '?'}`);
      }
      if (wanted.length > 50) console.log(`  … and ${wanted.length - 50} more`);
      continue;
    }

    const gameFile = path.join(GAMES_DIR, `${sid}.json`);
    if (!fs.existsSync(gameFile)) {
      console.log(`\n${sid}: games/bv file is ABSENT — skipping. A restore must not create a season file from an archive alone.`);
      continue;
    }
    // A file that exists but will not parse THROWS rather than being rebuilt
    // from the archive, which holds only deleted games and would destroy the rest.
    let gf;
    try { gf = readJson(gameFile); }
    catch (e) { throw new Error(`games/bv/${sid}.json exists but failed to parse (${e.message}) — refusing to rewrite it from an archive that holds only deleted games`); }
    if (!gf.games) gf.games = {};

    let restored = 0, occupied = 0;
    for (const id of wanted) {
      if (gf.games[id]) {
        // Something has recreated it since. The live copy wins — an older
        // snapshot must never overwrite current data.
        occupied++;
        console.log(`  · ${sid} ${id} is already present and was NOT overwritten (live copy wins)`);
        continue;
      }
      gf.games[id] = arch[id].entry;
      restored++;
      console.log(`  ↩ RESTORED ${sid} ${id}  round "${arch[id].rn}"  ${(arch[id].entry || {}).d || '∅'}`);
    }
    totalRestored += restored;
    totalOccupied += occupied;

    if (restored && APPLY) {
      fs.writeFileSync(gameFile, JSON.stringify(gf));
      if (!KEEP) {
        for (const id of wanted) delete arch[id];
        if (Object.keys(arch).length) fs.writeFileSync(path.join(ARCHIVE_DIR, fname), JSON.stringify(arch));
        else fs.unlinkSync(path.join(ARCHIVE_DIR, fname));
      }
      touchedSeasons.push(sid);
    }
  }

  console.log('─'.repeat(70));
  console.log(`  Archived entries seen : ${totalArchived}`);
  console.log(`  Matching the filter   : ${totalFiltered}`);
  if (!LIST) {
    console.log(`  Restored              : ${totalRestored}${APPLY ? '' : '  (DRY RUN — nothing written)'}`);
    console.log(`  Already present       : ${totalOccupied}  (live copy kept)`);
  }

  if (APPLY && touchedSeasons.length) {
    gitCommit(`restore-withdrawn-games: ${totalRestored} game(s) restored across ${touchedSeasons.length} season(s)`,
              ['games/', 'data/withdrawn-games']);
    console.log('');
    console.log('  ⚠ team-stats/bv is DERIVED from games/bv and still reflects the deletion.');
    console.log('    Dispatch Build Team Stats, or wait for the next nightly, before judging StatTrack.');
  }
}

main();
