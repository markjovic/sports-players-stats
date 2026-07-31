// scripts/repair-legacy-flags.js
//
// ONE-OFF REPAIR — remove the stale `legacy: true` flag from games that
// demonstrably hold data.
//
// ── The finding (2026-07-31) ─────────────────────────────────────────────────
// `legacy: true` is documented (README L268) as "pre-history game, no further
// data obtainable" — the terminal state of the three-step classification probe,
// reached only when discoverGame AND spectator game(id) AND the profile lookup
// ALL return nothing.
//
// Measured against the live corpus by find-flag-collisions.js:
//   3,262 games carry legacy
//   3,120 of them (95.6%) carry a SCORE
//   3,071 carry a score and no second flag
//      49 carry a score and a forfeit flag (the long-standing "flag collisions")
//       0 are dated 2020 or earlier
//   peak year is 2026 (955), i.e. the flag skews toward the PRESENT
//
// A game holding hs/as is a game some fixture-or-game query answered for. The
// flag and the data contradict each other, and the data wins: scores are written
// by discoverFixtureByRound (nightly Phase 2) and discoverTeamFixture
// (discover-fixtures.js), both of which merge over the existing entry and never
// touch flags — so a stale legacy rides through every subsequent write forever.
//
// ── Why this is safe to run as a one-off ─────────────────────────────────────
// NOTHING WRITES THE FLAG ANY MORE. Verified 2026-07-31 by grepping all of
// scripts/ and .github/workflows/ (find-code-refs.yml, needed because GitHub
// refuses to index this repo for code search): every one of the 55 matches is a
// read, a display string, or an unrelated sense of the word ("legacy 10-char
// ids", "legacy standalone path", "legacy private signal"). No classifier
// remains — it went in the 2026-07-16 cleanup. The population is FROZEN at
// 3,262: there is no writer to race, and the repair cannot be undone by a later
// pass.
//
// Downstream consumers were checked in the same grep: build-win-loss,
// build-team-stats, build-finals-stats, build-records and build-player-games do
// not mention legacy at all, so these games were never excluded from stats. The
// harm is confined to StatTrack, whose render tree tests `legacy` BEFORE the
// score test and therefore shows 3,120 scored games as "Data unavailable".
//
// ── What it does, exactly ────────────────────────────────────────────────────
// For every game with legacy === true:
//   carries a score (hs or as is a number)  -> DELETE the legacy key
//   no score                                -> LEAVE IT ALONE
// The ~142 scoreless ones are the only games for which the flag is unfalsified;
// for them "no further data obtainable" is still the honest answer.
//
// It deletes the key rather than setting it false: flag-present-means-true is
// the schema, and a stripped field must not be re-added as `false`.
//
// NOT IN SCOPE, deliberately: the one game whose `fo` disagrees with its
// scoreline (ba9d21fe, season 68f8c050, 2026-06-05 — fo names away, score says
// 10-0 home). That is a forfeit-data question, not a flag question, and folding
// an unrelated single-record edit into a 3,120-row repair is how a clean repair
// becomes unreviewable.
//
// ── Guards ───────────────────────────────────────────────────────────────────
//  - per game: the before/after objects are diffed by key, and the run ABORTS if
//    anything other than `legacy` changed. No blind writes.
//  - per file: the game COUNT must be identical before and after, or that file
//    is refused (same reasoning as nightly-crawl's flushGameFiles shrink guard).
//  - post-check: a full re-scan asserts zero legacy+score games remain before
//    the commit is allowed.
//
// Usage:
//   node scripts/repair-legacy-flags.js --dry-run        # report only (default in the workflow)
//   node scripts/repair-legacy-flags.js                  # apply + single commit
//   node scripts/repair-legacy-flags.js --season=<sid>   # one season (rehearsal)
//   node scripts/repair-legacy-flags.js --limit=N        # stop after N repairs (rehearsal)
// Env: REPAIR_NO_GIT=1 disables git (local testing only).

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT      = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games', 'bv');

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const DRY    = !!ARGS['dry-run'];
const SEASON = ARGS.season || null;
const LIMIT  = ARGS.limit ? parseInt(ARGS.limit, 10) : Infinity;
const NO_GIT = process.env.REPAIR_NO_GIT === '1';

function log(m) { console.log(`[repair-legacy] ${m}`); }

// Never `new Date()` for date parsing — split YYYY-MM-DD (house rule).
function yearOf(d) {
  if (typeof d !== 'string') return 'no-date';
  const p = d.split('-');
  return (p.length >= 3 && /^\d{4}$/.test(p[0])) ? p[0] : 'no-date';
}

function hasScore(g) {
  return typeof g.hs === 'number' || typeof g.as === 'number';
}

// The ONLY permitted mutation. Returns the list of keys that actually changed,
// so the caller can assert it is exactly ['legacy'] and nothing else.
function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diff.push(k);
  }
  return diff.sort();
}

// ─── git (house pattern: per-path add, staged shortstat, 60 attempts, THROW) ──
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}
function gitCommitPush(paths, message) {
  if (NO_GIT || DRY) return;
  let addFailures = 0;
  for (const p of paths) {
    try { git(['add', '--', p]); }
    catch (e) {
      addFailures++;
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      console.error(`  ⚠ git add failed for "${p}": ${detail}`);
    }
  }
  const staged = (() => { try { return git(['diff', '--cached', '--shortstat']).trim(); } catch (_) { return ''; } })();
  if (!staged) {
    if (addFailures) throw new Error(`nothing staged and ${addFailures} path(s) failed to stage — refusing to report a clean no-op`);
    log('nothing staged, skip commit');
    return;
  }
  log(`staging: ${staged}`);
  const IDENT = ['-c', 'user.name=github-actions[bot]',
                 '-c', 'user.email=github-actions[bot]@users.noreply.github.com'];
  try { git([...IDENT, 'commit', '-q', '-m', message]); }
  catch (e) {
    const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
    throw new Error(`commit failed — ${detail}`);
  }
  const MAX = 60;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try { git(['merge', '--abort']); } catch (_) { /* none in progress */ }
    try { git(['fetch', 'origin', 'main']); }
    catch (e) {
      if (attempt === MAX) throw e;
      const s = 1 + Math.floor(Math.random() * 91);
      log(`fetch failed (attempt ${attempt}/${MAX}), retrying in ${s}s`);
      try { execFileSync('sleep', [String(s)]); } catch (_) {}
      continue;
    }
    git([...IDENT, 'merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat']);
    try {
      git(['push', 'origin', 'HEAD:main']);
      log(`pushed on attempt ${attempt}`);
      return;
    } catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
      const contention = /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(detail);
      if (!contention) { console.error(`  push failed — NOT contention, failing fast. git said:\n${detail}`); throw e; }
      if (attempt === MAX) { console.error(`  push still rejected after ${MAX} attempts. git said:\n${detail}`); throw e; }
      const s = 1 + Math.floor(Math.random() * 91);
      log(`push attempt ${attempt}/${MAX} rejected (remote advanced), re-syncing in ${s}s`);
      try { execFileSync('sleep', [String(s)]); } catch (_) {}
    }
  }
  throw new Error(`exhausted ${MAX} push attempts`);
}

// ─── main ─────────────────────────────────────────────────────────────────────
function main() {
  log(`repair-legacy-flags${DRY ? ' (DRY RUN — nothing will be written)' : ''}`);
  if (SEASON) log(`scope: single season ${SEASON}`);
  if (LIMIT !== Infinity) log(`limit: stop after ${LIMIT} repairs`);

  let files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort();
  if (SEASON) files = files.filter(f => f === `${SEASON}.json`);
  if (!files.length) { log('no season files in scope — nothing to do.'); return; }

  const written = [];
  const clearedByYear = new Map();
  const keptByYear = new Map();
  let scanned = 0, legacyTotal = 0, cleared = 0, kept = 0, filesChanged = 0;
  const samples = [];
  let hitLimit = false;

  for (const fname of files) {
    if (hitLimit) break;
    const fpath = path.join(GAMES_DIR, fname);
    let gf;
    // A file that exists but will not parse must ABORT, never be skipped or
    // rewritten from an empty object (nightly-crawl loadGameFile precedent).
    try { gf = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
    catch (e) { throw new Error(`Refusing to proceed: ${fname} exists but failed to parse (${e.message}).`); }

    const games = gf.games || {};
    const countBefore = Object.keys(games).length;
    let fileChanged = 0;

    for (const [gameId, g] of Object.entries(games)) {
      scanned++;
      if (g.legacy !== true) continue;
      legacyTotal++;
      const year = yearOf(g.d);

      if (!hasScore(g)) {
        kept++;
        keptByYear.set(year, (keptByYear.get(year) || 0) + 1);
        continue;
      }
      if (cleared >= LIMIT) { hitLimit = true; break; }

      const before = { ...g };
      delete g.legacy;

      // Assert the ONLY thing that changed is the flag. Anything else means a
      // bug in this script and the run stops before writing a single file.
      const diff = changedKeys(before, g);
      if (diff.length !== 1 || diff[0] !== 'legacy') {
        throw new Error(`ABORT: game ${gameId} in ${fname} changed keys [${diff.join(', ')}] — expected only [legacy]. Nothing written.`);
      }

      cleared++;
      fileChanged++;
      clearedByYear.set(year, (clearedByYear.get(year) || 0) + 1);
      if (samples.length < 10) {
        samples.push(`${gameId} (season ${fname.replace('.json','')}) ${g.d ?? '?'} ${g.hs ?? '?'}-${g.as ?? '?'}${g.forfeit ? ' [forfeit]' : ''}`);
      }
    }

    if (fileChanged > 0) {
      const countAfter = Object.keys(gf.games || {}).length;
      if (countAfter !== countBefore) {
        throw new Error(`ABORT: ${fname} game count changed ${countBefore} -> ${countAfter}. Nothing further written.`);
      }
      filesChanged++;
      if (!DRY) {
        fs.writeFileSync(fpath, JSON.stringify(gf));   // minified, matching every other games/bv writer
        written.push(path.join('games', 'bv', fname));
      }
    }
  }

  // ─── post-check ─────────────────────────────────────────────────────────────
  // Re-read from DISK (not from memory) and assert the invariant this change
  // exists to establish. Skipped on a scoped/limited run, where survivors are
  // expected by definition.
  let postRemaining = null;
  if (!DRY && !SEASON && LIMIT === Infinity) {
    postRemaining = 0;
    for (const fname of files) {
      const gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8'));
      for (const g of Object.values(gf.games || {})) {
        if (g.legacy === true && hasScore(g)) postRemaining++;
      }
    }
    if (postRemaining !== 0) {
      throw new Error(`post-check FAILED: ${postRemaining} legacy+score game(s) remain after the repair — NOT committing`);
    }
  }

  // ─── report ─────────────────────────────────────────────────────────────────
  const L = [];
  L.push('');
  L.push(`games scanned            : ${scanned}`);
  L.push(`carrying legacy:true     : ${legacyTotal}`);
  L.push(`legacy CLEARED (scored)  : ${cleared}`);
  L.push(`legacy KEPT (no score)   : ${kept}`);
  L.push(`season files changed     : ${filesChanged}`);
  if (hitLimit) L.push(`⚠ stopped early at --limit=${LIMIT} — this is a partial run`);
  if (postRemaining !== null) L.push(`post-check legacy+score remaining : ${postRemaining} (must be 0)`);
  L.push('');
  L.push('cleared by year:');
  for (const y of [...clearedByYear.keys()].sort()) L.push(`    ${y.padEnd(9)} ${clearedByYear.get(y)}`);
  L.push('kept by year (flag unfalsified — no score, so "nothing obtainable" still stands):');
  for (const y of [...keptByYear.keys()].sort()) L.push(`    ${y.padEnd(9)} ${keptByYear.get(y)}`);
  if (samples.length) {
    L.push('');
    L.push('samples:');
    for (const s of samples) L.push(`    ${s}`);
  }
  const out = L.join('\n');
  console.log(out);

  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + out + '\n```\n'); } catch (_) {}
  }

  if (DRY) { log('DRY RUN — nothing written.'); return; }
  if (!written.length) { log('no files changed — nothing to commit.'); return; }

  gitCommitPush(written, `repair-legacy-flags: cleared stale legacy from ${cleared} scored games across ${filesChanged} season files`);
  log('complete.');
}

main();
