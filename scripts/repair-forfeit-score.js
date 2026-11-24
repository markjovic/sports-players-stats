// scripts/repair-forfeit-score.js
//
// ONE-OFF REPAIR — correct the scoreline of a single forfeit game whose stored
// score contradicts its own `fo` (forfeit-winner id).
//
// ── The finding (OUTSTANDING_TASKS §2.2, closed by probe 2026-08-02) ─────────
// ba9d21fe, season 68f8c050, 2026-06-05, Warranwood Warriors vs GSLPS Thunder:
// stored 10-0 to HOME while fo names AWAY. diagnose-forfeit-game.js probed
// discoverGame live: outcome=AWAY_TEAM_WON_BY_FORFEIT, winner=AWAY,
// home.outcome=LOST_BY_FORFEIT. fo is RIGHT; the scoreline is the stale half —
// hs/as only overlay when non-null (nightly-crawl.js L659), so a stale score
// rides beneath a fresher forfeit/fo forever.
//
// ── What it does ─────────────────────────────────────────────────────────────
// Rewrites hs/as to the corpus forfeit convention: WINNER 20, LOSER 0 (the
// exact pattern recheck-forfeit-games.js scans for). The winner is taken from
// the record's own fo — which the probe verified — NOT from an argument, so the
// script cannot be pointed at a game and told the wrong side.
//
// ── Guards (repair-legacy-flags.js discipline) ───────────────────────────────
//  - REFUSES unless forfeit === true
//  - REFUSES if fo is absent or names neither of the game's own teams
//  - no-ops (cleanly, exit 0) if the score already matches convention — idempotent
//  - per-game key diff: aborts if anything but hs/as changed
//  - per-file game-count guard
//  - post-check re-reads from DISK and asserts scoreline winner == fo side
//
// NOT in scope: data/forfeit-games.json (the game IS a forfeit — membership is
// correct and untouched) and every other game in the file.
//
// Usage:
//   node scripts/repair-forfeit-score.js --game=ba9d21fe --season=68f8c050 --dry-run
//   node scripts/repair-forfeit-score.js --game=ba9d21fe --season=68f8c050
// Env: REPAIR_NO_GIT=1 disables git (local testing only).

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const GX = require('./lib/git-exec.cjs');   // T104: the git timeout lives in ONE place

const ROOT      = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games', 'bv');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const DRY     = !!ARGS['dry-run'];
const GAME_ID = ARGS.game   || null;
const SEASON  = ARGS.season || null;
const NO_GIT  = process.env.REPAIR_NO_GIT === '1';

const WINNER_SCORE = 20;   // corpus convention — recheck-forfeit-games.js scans 20-0/0-20
const LOSER_SCORE  = 0;

function log(m) { console.log(`[repair-forfeit-score] ${m}`); }

function foSide(g) {
  if (g.fo === undefined || g.fo === null || g.fo === '') return 'ABSENT';
  if (g.fo === g.h || g.fo === g.t1) return 'HOME';
  if (g.fo === g.a || g.fo === g.t2) return 'AWAY';
  return 'NEITHER-TEAM';
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diff.push(k);
  }
  return diff.sort();
}

// ─── git (house pattern: per-path add, staged shortstat, 60 attempts, THROW) ──
// T104: EVERY git operation in this file goes through this one wrapper, so the one
// missing `timeout` here left the whole writer unguarded — a count of "1 untimed
// call" understated it completely. gitOpts() carries the timeout and the 512 MB
// maxBuffer; the stdio shape is this file's own and is preserved.
function git(args) {
  return execFileSync('git', args, GX.gitOpts(ROOT, { stdio: ['ignore', 'pipe', 'pipe'] })).toString();
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
  const stalls = GX.makeStallTracker();   // T104: caps consecutive timeout kills
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try { git(['merge', '--abort']); } catch (_) { /* none in progress */ }
    try { git(['fetch', 'origin', 'main']); stalls.note('ok'); }
    catch (e) {
      // T104: a timeout-killed child carries NO stderr, so it must be classified
      // BEFORE anything reads git's output — otherwise it is filed as contention it
      // never ran. A STALL is retryable but CAPPED: three in a row with no fetch
      // answering in between is fatal, because 60 x 10 min would hold the data-write
      // lock for ten hours and could not succeed. Measured on 2026-11-24: six.
      const kind = GX.classifyGitError(e);
      const st = stalls.note(kind);
      if (kind === 'fatal') throw new Error(GX.fatalMessage('fetch', e));
      if (st.exhausted) throw new Error(GX.stallExhaustedMessage('fetch', st));
      if (attempt === MAX) throw new Error(GX.attemptsExhaustedMessage('fetch', MAX, e));
      const s = GX.backoffSeconds(true);
      log(GX.retryMessage('fetch', e, attempt, MAX, s, st).trim());
      try { execFileSync('sleep', [String(s)], GX.sleepOpts(s)); } catch (_) {}
      continue;
    }
    // Deliberately NOT retried: a merge that fails or stalls is not contention, and
    // retrying it 60 times over a wedged index achieves nothing. It throws — and the
    // timeout in gitOpts means it throws in 10 minutes instead of hanging.
    git([...IDENT, 'merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat']);
    try {
      git(['push', 'origin', 'HEAD:main']);
      log(`pushed on attempt ${attempt}`);
      return;
    } catch (e) {
      const kind = GX.classifyGitError(e);
      const st = stalls.note(kind);
      if (kind === 'stall') {
        if (st.exhausted) throw new Error(GX.stallExhaustedMessage('push', st));
        const s = GX.backoffSeconds(true);
        log(GX.retryMessage('push', e, attempt, MAX, s, st).trim());
        try { execFileSync('sleep', [String(s)], GX.sleepOpts(s)); } catch (_) {}
        continue;
      }
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
      const contention = /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(detail);
      if (!contention) { console.error(`  push failed — NOT contention, failing fast. git said:\n${detail}`); throw e; }
      if (attempt === MAX) { console.error(`  push still rejected after ${MAX} attempts. git said:\n${detail}`); throw e; }
      const s = 1 + Math.floor(Math.random() * 91);
      log(`push attempt ${attempt}/${MAX} rejected (remote advanced), re-syncing in ${s}s`);
      try { execFileSync('sleep', [String(s)], GX.sleepOpts(s)); } catch (_) {}
    }
  }
  throw new Error(`exhausted ${MAX} push attempts`);
}

// ─── main ─────────────────────────────────────────────────────────────────────
function main() {
  log(`repair-forfeit-score${DRY ? ' (DRY RUN — nothing will be written)' : ''}`);
  if (!GAME_ID || !SEASON) {
    console.error('usage: node scripts/repair-forfeit-score.js --game=<gameId> --season=<sid> [--dry-run]');
    process.exit(1);
  }

  const fpath = path.join(GAMES_DIR, `${SEASON}.json`);
  let gf;
  try { gf = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
  catch (e) { throw new Error(`Refusing to proceed: games/bv/${SEASON}.json failed to read/parse (${e.message}).`); }

  const games = gf.games || {};
  const countBefore = Object.keys(games).length;
  const g = games[GAME_ID];
  if (!g) throw new Error(`game ${GAME_ID} not found in season ${SEASON} — nothing written.`);

  // ── refusals (fail toward doing LESS) ──
  if (g.forfeit !== true) {
    throw new Error(`REFUSING: game ${GAME_ID} does not carry forfeit:true — this repair is for forfeits only.`);
  }
  const side = foSide(g);
  if (side !== 'HOME' && side !== 'AWAY') {
    throw new Error(`REFUSING: fo is ${side} — cannot derive a winner. Fix fo first (probe with diagnose-forfeit-game.js).`);
  }

  const wantHs = side === 'HOME' ? WINNER_SCORE : LOSER_SCORE;
  const wantAs = side === 'AWAY' ? WINNER_SCORE : LOSER_SCORE;

  log(`${g.hn ?? '?'} (home) vs ${g.an ?? '?'} (away)  d=${g.d ?? '?'}`);
  log(`stored score ${g.hs ?? '?'}-${g.as ?? '?'}  fo names ${side}  ->  target ${wantHs}-${wantAs}`);

  if (g.hs === wantHs && g.as === wantAs) {
    log('score already matches convention for the fo side — nothing to do (idempotent no-op).');
    return;
  }

  const before = { ...g };
  g.hs = wantHs;
  g.as = wantAs;

  const diff = changedKeys(before, g);
  const allowed = diff.every(k => k === 'hs' || k === 'as');
  if (!allowed || diff.length === 0) {
    throw new Error(`ABORT: game ${GAME_ID} changed keys [${diff.join(', ')}] — expected only hs/as. Nothing written.`);
  }

  const countAfter = Object.keys(gf.games || {}).length;
  if (countAfter !== countBefore) {
    throw new Error(`ABORT: ${SEASON}.json game count changed ${countBefore} -> ${countAfter}. Nothing written.`);
  }

  const summary = `changed [${diff.join(', ')}]: ${before.hs ?? '?'}-${before.as ?? '?'} -> ${wantHs}-${wantAs} (fo=${g.fo}, ${side} wins by forfeit)`;
  if (DRY) { log(`DRY RUN — would write: ${summary}`); return; }

  fs.writeFileSync(fpath, JSON.stringify(gf));   // minified — house rule

  // ── post-check: re-read from DISK, assert the invariant this exists to fix ──
  const re = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  const rg = re.games?.[GAME_ID];
  const reSide = (typeof rg?.hs === 'number' && typeof rg?.as === 'number' && rg.hs !== rg.as)
    ? (rg.hs > rg.as ? 'HOME' : 'AWAY') : 'NO-WINNER';
  if (!rg || rg.hs !== wantHs || rg.as !== wantAs || reSide !== side) {
    throw new Error(`post-check FAILED: disk holds ${rg?.hs}-${rg?.as} (scoreline ${reSide}, fo ${side}) — NOT committing.`);
  }
  if (Object.keys(re.games || {}).length !== countBefore) {
    throw new Error('post-check FAILED: game count changed on disk — NOT committing.');
  }
  log(`post-check OK: scoreline winner now agrees with fo (${side}).`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + summary + '\n```\n'); } catch (_) {}
  }

  gitCommitPush(
    [path.join('games', 'bv', `${SEASON}.json`)],
    `repair-forfeit-score: ${GAME_ID} ${before.hs}-${before.as} -> ${wantHs}-${wantAs} to match verified fo (${side} won by forfeit)`
  );
  log('complete.');
}

main();
