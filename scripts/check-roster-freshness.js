// scripts/check-roster-freshness.js
//
// §A3 roster same-morning check, automated. Answers one question:
//   "Did a game played last night make it into its team's team-stats/bv roster,
//    and does that roster agree with the player files?"
//
// READ-ONLY. No writes, no commits, no pushes. The only mutating git command it
// runs is `git sparse-checkout set` (worktree materialisation only) so it can
// pull in the handful of files it needs from a blobless clone.
//
// Why team-stats can be stale: roster stat lines are sourced from player reg
// stats (players/{xx}/*.json seasons[].regs[].stats), which the profile-stats
// matrix writes. The nightly's own team-stats job runs BEFORE the matrix is
// triggered, so it can never see tonight's stats — the matrix TERMINAL dispatch
// of build-team-stats.yml is what closes the gap (2026-07-21 roster-lag fix).
// If that dispatch is lost (e.g. the HTTP 500 on 2026-07-27), team-stats lags
// the player view by a day and this script says so.
//
// Strategy:
//   1. Candidate seasons come from COMMIT HISTORY, not a scan:
//      `git log --since=<window> --name-only -- games/bv` is the set of season
//      files the nightly actually committed. A green job is not proof of
//      persistence; the commit history is.
//   2. Sparse-expand to those games/bv + team-stats/bv files.
//   3. Pick ONE representative game: target date, real (not cancelled/bye/
//      forfeit), both scores present, most players in p[].
//   4. Sparse-expand to that game's player files.
//   5. Verify, three ways:
//        a. the game appears in BOTH teams' fixtures[] with a score
//        b. every resolvable player in the game is present in their team roster
//        c. each roster stat line EQUALS that player's reg stats for the season
//           (team-stats is derived from the player files, so any disagreement
//            means team-stats was built before the player data landed)
//   6. Compare the last commit touching the team-stats file against the last
//      `fetch-profile-stats: matrix run` commit. Roster older = stale.
//
// Field shapes are taken from build-team-stats.js / build-win-loss.js /
// build-finals-stats.js — game teams `h||t1`/`a||t2`, scores `hs??s1`/`as??s2`,
// date `d`, round `rn`, game uuid `id`, per-game players `p[]` ({id}) with
// `hp[]`/`ap[]` ({profileID,name}) carrying side info when present. Roster keys
// are TRUNC_LEN-truncated uuids.
//
// Usage:
//   node scripts/check-roster-freshness.js                    # last night (AEST)
//   node scripts/check-roster-freshness.js --date=2026-07-27  # explicit date
//   node scripts/check-roster-freshness.js --season=<sid>     # skip history lookup
//   node scripts/check-roster-freshness.js --since='60 hours ago'
//   node scripts/check-roster-freshness.js --no-sparse        # full checkout already present

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const { truncateUuid, resolveToFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const TARGET_SID = ARGS.season || null;
const SINCE      = ARGS.since  || '40 hours ago';
const NO_SPARSE  = !!ARGS['no-sparse'];

const GAMES_DIR      = path.join(ROOT, 'games', 'bv');
const TEAM_STATS_DIR = path.join(ROOT, 'team-stats', 'bv');
const PLAYERS_DIR    = path.join(ROOT, 'players');

// Roster stat keys written by build-team-stats.js addPlayerToRoster().
const STAT_KEYS = ['gp', 'pts', 'fg', 'ft', 'threePt', 'fouls'];

const failures = [];
function fail(msg)  { failures.push(msg); }
function line(s='') { console.log(s); }

// ─── Target date ──────────────────────────────────────────────────────────────
// Games are local fixtures, so "last night" is yesterday in Melbourne time, not
// yesterday UTC — the nightly runs ~02:00 AEST, i.e. already the next UTC day.

function melbourneDateOffset(days) {
  const now = new Date(Date.now() + days * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const TARGET_DATE = ARGS.date || melbourneDateOffset(-1);

// ─── git helpers (read-only except sparse-checkout worktree expansion) ────────

function git(cmd, opts = {}) {
  return execSync(`git ${cmd}`, {
    stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024, ...opts,
  }).toString();
}

function gitQuiet(cmd) {
  try { return git(cmd); } catch (_) { return null; }
}

// Expand the sparse-checkout set. On a blobless clone this triggers a promisor
// object fetch, which the remote can reset mid-transfer ("curl 56 Recv failure"
// / "fatal: early EOF" — seen 2026-07-26). The command is idempotent, so retry.
const sparsePaths = new Set(['scripts', 'data/sports-index.json', 'players/indexes', 'players/aliases']);

function sparseAdd(paths) {
  if (NO_SPARSE) return;
  const before = sparsePaths.size;
  for (const p of paths) sparsePaths.add(p);
  if (sparsePaths.size === before) return;

  const list = [...sparsePaths].join(' ');
  const MAX = 6;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      git(`sparse-checkout set --no-cone ${list}`);
      return;
    } catch (e) {
      const msg = e.stderr?.toString().slice(0, 200) || e.message.slice(0, 200);
      if (attempt === MAX) {
        console.error(`✗ sparse-checkout failed after ${MAX} attempts: ${msg}`);
        process.exit(1);
      }
      const s = 1 + Math.floor(Math.random() * 91);
      console.error(`  … sparse-checkout/promisor fetch failed — retry ${attempt + 1}/${MAX} in ${s}s`);
      execSync(`sleep ${s}`, { stdio: 'pipe', cwd: ROOT });
    }
  }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return null; }
}

// ─── Step 1: candidate seasons from commit history ───────────────────────────

function candidateSidsFromHistory() {
  // SINCE reaches a shell via execSync — escape single quotes rather than trust it.
  const since = String(SINCE).replace(/'/g, "'\\''");
  const out = gitQuiet(`log --since='${since}' --name-only --pretty=format: -- games/bv`);
  if (out === null) {
    console.error('✗ `git log` failed — is this a checkout with history (fetch-depth: 0)?');
    process.exit(1);
  }
  const sids = new Set();
  for (const raw of out.split('\n')) {
    const m = raw.trim().match(/^games\/bv\/([^/]+)\.json$/);
    if (m) sids.add(m[1]);
  }
  return [...sids];
}

// ─── Step 3: pick a representative game ──────────────────────────────────────

function isRealScoredGame(g) {
  if (g.cancelled || g.abandoned || g.bye || g.forfeit) return false;
  const hs = g.hs ?? g.s1 ?? null;
  const as = g.as ?? g.s2 ?? null;
  if (hs === null || as === null) return false;
  if (!(g.h || g.t1) || !(g.a || g.t2)) return false;
  return true;
}

function gameDate(g) {
  return g.d ? String(g.d).slice(0, 10) : null;
}

function pickGame(sids) {
  const seen = [];          // for diagnostics when nothing matches
  let best = null;

  for (const sid of sids) {
    const gf = readJson(path.join(GAMES_DIR, `${sid}.json`));
    if (!gf) continue;
    for (const [gameId, g] of Object.entries(gf.games || {})) {
      if (!isRealScoredGame(g)) continue;
      const d = gameDate(g);
      if (seen.length < 5 && d) seen.push(`${sid} ${gameId} d=${JSON.stringify(g.d)} rn=${JSON.stringify(g.rn)}`);
      if (d !== TARGET_DATE) continue;
      const players = (g.p || []).length + (g.hp || []).length + (g.ap || []).length;
      if (!best || players > best.players) best = { sid, gameId, g, players };
    }
  }
  return { best, seen };
}

// ─── Player-side helpers ─────────────────────────────────────────────────────

function readPlayer(uuid) {
  const shard = uuid.slice(0, 2).toLowerCase();
  return readJson(path.join(PLAYERS_DIR, shard, `${uuid}.json`));
}

// Same traversal as build-team-stats.js extractRegStats().
function extractRegStats(player, sid, tid) {
  for (const season of (player.seasons || [])) {
    if (season.sid !== sid) continue;
    for (const reg of (season.regs || [])) {
      if (reg.tid === tid && reg.stats) return reg.stats;
    }
  }
  return null;
}

// Which team did this player turn out for? hp/ap carry side info directly; for
// p[]-only games fall back to the player's own regs for the season matching one
// of the two team ids (same principle as build-win-loss.js Pass 1).
function attributeTeam(player, sid, homeTid, awayTid, sideHint) {
  if (sideHint) return sideHint;
  if (!player) return null;
  const tids = new Set();
  for (const season of (player.seasons || [])) {
    if (season.sid !== sid) continue;
    for (const reg of (season.regs || [])) if (reg.tid) tids.add(reg.tid);
  }
  const inHome = homeTid && tids.has(homeTid);
  const inAway = awayTid && tids.has(awayTid);
  if (inHome && !inAway) return homeTid;
  if (inAway && !inHome) return awayTid;
  return null;  // absent or ambiguous (dual registration) — reported, not failed
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  line('check-roster-freshness.js  —  §A3 roster same-morning check');
  line('─'.repeat(66));
  line(`  Target date (Australia/Melbourne): ${TARGET_DATE}`);
  line(`  History window:                    ${SINCE}`);
  line('');

  // Step 1/2 — candidates
  let sids;
  if (TARGET_SID) {
    sids = [TARGET_SID];
    line(`  Season pinned by --season: ${TARGET_SID}`);
  } else {
    sids = candidateSidsFromHistory();
    line(`  Seasons with games/bv commits in window: ${sids.length}`);
    if (sids.length === 0) {
      line('');
      line('❌ FAIL — no games/bv commits in the window at all.');
      line('   Nothing was ingested, so there is no roster question to ask yet.');
      line('   Check the nightly crawl run first (its own commit history, not just a green job).');
      process.exit(1);
    }
  }

  sparseAdd([
    ...sids.map(s => `games/bv/${s}.json`),
    ...sids.map(s => `team-stats/bv/${s}.json`),
  ]);

  // Step 3 — pick a game
  const { best, seen } = pickGame(sids);
  if (!best) {
    line('');
    line(`❌ FAIL — no real, scored game dated ${TARGET_DATE} in those seasons.`);
    if (seen.length) {
      line('   Sample of scored games seen (check the date FORMAT here before assuming a data gap):');
      for (const s of seen) line(`     ${s}`);
    }
    line('   If the dates above are not YYYY-MM-DD, re-run with --date matching that format.');
    process.exit(1);
  }

  const { sid, gameId, g } = best;
  const homeTid = g.h || g.t1 || null;
  const awayTid = g.a || g.t2 || null;
  const hs = g.hs ?? g.s1 ?? null;
  const as = g.as ?? g.s2 ?? null;

  line('');
  line('  Representative game (most players of those matching the date):');
  line(`    season   ${sid}`);
  line(`    game     ${gameId}${g.id ? `  (uuid ${g.id})` : ''}`);
  line(`    date     ${g.d}   round ${g.rn ?? '—'}`);
  line(`    home     ${g.hn || g.t1n || homeTid}  ${hs}`);
  line(`    away     ${g.an || g.t2n || awayTid}  ${as}`);
  line(`    players  p[]=${(g.p || []).length}  hp[]=${(g.hp || []).length}  ap[]=${(g.ap || []).length}`);

  // Load team-stats for the season
  const tsPath = path.join(TEAM_STATS_DIR, `${sid}.json`);
  const ts = readJson(tsPath);
  if (!ts) {
    line('');
    line(`❌ FAIL — team-stats/bv/${sid}.json missing or unparseable.`);
    line('   build-team-stats has never produced a file for this season.');
    process.exit(1);
  }

  // Check (a) — fixture presence
  line('');
  line('  (a) fixture present with score, both sides');
  for (const [label, tid] of [['home', homeTid], ['away', awayTid]]) {
    const team = ts[tid];
    if (!team) { fail(`team ${tid} (${label}) absent from team-stats`); line(`      ✗ ${label} team ${tid} not in team-stats`); continue; }
    const fx = (team.fixtures || []).find(f => f.gameId === gameId);
    if (!fx)            { fail(`game ${gameId} missing from ${label} fixtures`); line(`      ✗ ${label}: game not in fixtures[]`); }
    else if (!fx.score) { fail(`game ${gameId} in ${label} fixtures without a score`); line(`      ✗ ${label}: in fixtures but score is null`); }
    else                { line(`      ✓ ${label}: ${fx.score} (${fx.result ?? 'no result'}) round ${fx.rn ?? '—'}`); }
  }

  // Resolve the game's players, with side hints from hp/ap where available.
  const sideHint = new Map();  // full uuid → tid
  for (const [arr, tid] of [[g.hp || [], homeTid], [g.ap || [], awayTid]]) {
    for (const p of arr) {
      if (!p.profileID || !tid) continue;
      const full = resolveToFullUuid(p.profileID, ROOT);
      if (full) sideHint.set(full, tid);
    }
  }

  const uuids = new Set(sideHint.keys());
  let unresolved = 0;
  for (const p of (g.p || [])) {
    if (!p.id) continue;
    const full = resolveToFullUuid(p.id, ROOT);
    if (full) uuids.add(full); else unresolved++;
  }

  if (uuids.size === 0) {
    line('');
    line('❌ FAIL — none of this game\'s player ids resolved to a player file.');
    line(`   ${unresolved} unresolved. That is an identity/index problem, not a roster problem.`);
    process.exit(1);
  }

  sparseAdd([...uuids].map(u => `players/${u.slice(0, 2).toLowerCase()}/${u}.json`));

  // Checks (b) and (c)
  line('');
  line(`  (b) roster membership + (c) roster stats vs player reg stats  [${uuids.size} players]`);
  if (unresolved) line(`      note: ${unresolved} p[] ids unresolved (stale/missing index entry) — skipped`);

  let checked = 0, missingPlayerFile = 0, unattributed = 0, notInRoster = 0, mismatched = 0, agreed = 0;

  for (const uuid of uuids) {
    const player = readPlayer(uuid);
    if (!player) { missingPlayerFile++; continue; }

    const tid = attributeTeam(player, sid, homeTid, awayTid, sideHint.get(uuid));
    if (!tid) { unattributed++; continue; }

    const team = ts[tid];
    if (!team) { notInRoster++; fail(`team ${tid} absent from team-stats`); continue; }

    checked++;
    const key   = truncateUuid(uuid);
    const entry = team.roster?.[key];
    const name  = player.name || key;

    if (!entry) {
      notInRoster++;
      fail(`${name} (${key}) played but is absent from team ${tid} roster`);
      line(`      ✗ ${name} — not in roster`);
      continue;
    }

    const reg  = extractRegStats(player, sid, tid) || {};
    const diff = STAT_KEYS
      .filter(k => (entry[k] ?? 0) !== (reg[k] ?? 0))
      .map(k => `${k} roster=${entry[k] ?? 0} player=${reg[k] ?? 0}`);

    if (diff.length) {
      mismatched++;
      fail(`${name} (${key}) roster disagrees with player file: ${diff.join(', ')}`);
      line(`      ✗ ${name} — ${diff.join(', ')}`);
    } else {
      agreed++;
    }
  }

  line(`      players attributed to a team:   ${checked}`);
  line(`      roster agrees with player file: ${agreed}`);
  line(`      roster entry missing:           ${notInRoster}`);
  line(`      roster/player disagreement:     ${mismatched}`);
  if (missingPlayerFile) line(`      player file absent:             ${missingPlayerFile}`);
  if (unattributed)      line(`      team not attributable:          ${unattributed} (absent or dual-registered — not counted as failure)`);

  // Step 6 — commit ordering
  line('');
  line('  (d) commit ordering: team-stats file vs the matrix');
  const rosterCommit = (gitQuiet(`log -1 --format=%cI|%h|%s -- team-stats/bv/${sid}.json`) || '').trim();
  const matrixCommit = (gitQuiet(`log -1 --format=%cI|%h|%s --grep='^fetch-profile-stats: matrix run'`) || '').trim();

  if (!rosterCommit) {
    fail('no commit found touching this season\'s team-stats file');
    line('      ✗ no commit touches team-stats/bv/' + sid + '.json in the fetched history');
  } else {
    const [rIso, rHash, ...rSub] = rosterCommit.split('|');
    line(`      team-stats  ${rIso}  ${rHash}  ${rSub.join('|')}`);
    if (!matrixCommit) {
      line('      matrix      (no matrix-run commit in the fetched history — cannot compare)');
    } else {
      const [mIso, mHash, ...mSub] = matrixCommit.split('|');
      line(`      matrix      ${mIso}  ${mHash}  ${mSub.join('|')}`);
      if (new Date(rIso) < new Date(mIso)) {
        fail('team-stats was committed BEFORE the most recent matrix run — roster is stale by construction');
        line('      ✗ roster predates the matrix run');
      } else {
        line('      ✓ roster commit is newer than the matrix run');
      }
    }
  }

  // Verdict
  line('');
  line('─'.repeat(66));
  if (failures.length === 0) {
    line('✅ PASS — last night\'s game is in the roster and team-stats agrees with the player files.');
    return;
  }
  line(`❌ FAIL — ${failures.length} problem(s):`);
  for (const f of failures.slice(0, 25)) line(`   • ${f}`);
  if (failures.length > 25) line(`   … and ${failures.length - 25} more`);
  line('');
  line('   Most likely cause, in order:');
  line('     1. the matrix terminal never dispatched build-team-stats (lost dispatch / chain broke)');
  line('     2. build-team-stats ran but its push was swallowed — check its commit, not its job status');
  line('     3. build-team-stats ran BEFORE the matrix committed the player stats');
  process.exit(1);
}

main();
