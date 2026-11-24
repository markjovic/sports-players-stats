// scripts/tests/test-team-stats-sup.js
// REVISION 2026-11-24a — first version.
//
// Asserts that build-team-stats.js carries the `sup` flag into team-stats and
// that T105 holds: a team's grade comes from the latest PLAYED game, never from
// a superseded fixture, and ties are broken deterministically.
//
// ⚠ THIS RUNS THE REAL SCRIPT, NOT A COPY OF ITS LOGIC. T103 is the reason: a
// fixture written from the same belief as the code tests the belief, not the
// behaviour. buildSeasonTeamStats is not exported, so the only honest test is to
// build a repository-shaped tree in a temp dir, copy the actual script and its
// lib into it, run it, and read what it wrote.
//
// `git` is stubbed on PATH so gitCommit's `git diff --staged --shortstat` returns
// empty and it exits at "nothing to commit". Without that, a real run in a tree
// with no origin enters the 60-attempt push loop with 1-91s sleeps. No network,
// no writes outside the temp dir.
//
// Run:  node scripts/tests/test-team-stats-sup.js

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC  = path.join(__dirname, '..');
const SID  = 'tst00001';

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `  -> ${detail}` : ''}`); }
}
function eq(a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }

// ── the fixture ──────────────────────────────────────────────────────────────
// Modelled on the real Kilsyth U11 shape: a team with a PLAYED game in its real
// grade and, on the SAME DATE, an unplayed fixture in the grade it was moved out
// of, flagged `sup` with the id of the game that replaced it.
//
// ⚠ The sup fixture carries a LATER time than the played game on purpose. A rule
// that ordered on (date, time) without preferring a played game would pick the
// superseded grade here, and a rule that ordered on date alone would resolve it
// by object key order. Both are the defect; this fixture catches both.
const GAMES = {
  g_played: { d: '2026-11-13', t: '18:30', gid: 'GR_A',  gn: 'Friday U11 Boys A',
              h: 'TEAM1', hn: 'B11 Test 1', a: 'TEAM2', an: 'B11 Test 2',
              st: 'FINAL', hs: 40, as: 30, rn: 'Round 6' },
  g_sup:    { d: '2026-11-13', t: '19:30', gid: 'GR_AR', gn: 'Friday U11 Boys AR',
              h: 'TEAM1', hn: 'B11 Test 1', a: 'TEAM3', an: 'B11 Test 3',
              st: 'UPCOMING', rn: 'Round 6', sup: 'g_played' },
  g_future: { d: '2026-12-04', t: '18:30', gid: 'GR_A',  gn: 'Friday U11 Boys A',
              h: 'TEAM2', hn: 'B11 Test 2', a: 'TEAM1', an: 'B11 Test 1',
              st: 'UPCOMING', rn: 'Round 9' },
  g_pre:    { d: '2027-01-10', t: '09:00', gid: 'GR_B',  gn: 'Friday U11 Boys B',
              h: 'TEAM4', hn: 'B11 Test 4', a: 'TEAM5', an: 'B11 Test 5',
              st: 'UPCOMING', rn: 'Round 1' },
};

function buildTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-sup-'));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'games', 'bv'), { recursive: true });
  fs.mkdirSync(path.join(root, 'players', 'indexes'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'build-team-stats.js'), path.join(root, 'scripts', 'build-team-stats.js'));
  for (const f of fs.readdirSync(path.join(SRC, 'lib'))) {
    fs.copyFileSync(path.join(SRC, 'lib', f), path.join(root, 'scripts', 'lib', f));
  }
  fs.writeFileSync(path.join(root, 'data', 'sports-index.json'), JSON.stringify({
    seasons: { [SID]: { id: SID, name: 'Test', locked: false, grades: [] } },
  }));
  fs.writeFileSync(path.join(root, 'games', 'bv', `${SID}.json`), JSON.stringify({ games: GAMES }));
  // git stub — see the header.
  const stub = path.join(root, 'stub');
  fs.mkdirSync(stub);
  fs.writeFileSync(path.join(stub, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return root;
}

function run(root, extra) {
  return execFileSync(process.execPath, [path.join(root, 'scripts', 'build-team-stats.js'), `--season=${SID}`, ...extra], {
    cwd: root,
    env: { ...process.env, PATH: `${path.join(root, 'stub')}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}
const readOut = (root) => JSON.parse(fs.readFileSync(path.join(root, 'team-stats', 'bv', `${SID}.json`), 'utf8'));
const num = (out, label) => { const m = out.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(\\d+)')); return m ? Number(m[1]) : null; };

console.log('test-team-stats-sup.js');
const root = buildTree();
const out1 = run(root, []);
const ts   = readOut(root);

// ── 1. the flag reaches team-stats ───────────────────────────────────────────
const t1 = ts.TEAM1, t3 = ts.TEAM3;
ok(!!t1, 'TEAM1 exists in team-stats');
const f1 = Object.fromEntries((t1.fixtures || []).map(f => [f.gameId, f]));
eq(Object.keys(f1).length, 3, 'TEAM1 holds all three of its fixtures (nothing hidden)');
eq(f1.g_sup && f1.g_sup.sup, 'g_played', 'the superseded fixture carries sup = the replacing game id');
ok(f1.g_played && !('sup' in f1.g_played), 'the played game carries no sup key');
ok(f1.g_future && !('sup' in f1.g_future), 'a genuine future fixture carries no sup key');
eq((t3.fixtures || []).filter(f => f.sup).length, 1, 'the opponent side of the superseded fixture carries it too');

// ── 2. the two counts of one concept ─────────────────────────────────────────
eq(num(out1, 'sup: flagged games read'), 1, 'run reports 1 flagged game');
eq(num(out1, 'sup: fixture entries written'), 2, 'run reports 2 fixture entries - one per side');
ok(/sup: 1:2 check\s*:\s*OK/.test(out1), '1:2 check prints OK');
ok(/sup: invariant\s*:\s*OK/.test(out1), 'invariant prints OK - no flagged game reads as played');
ok(!/INVARIANT BROKEN/.test(out1), 'no broken invariant');

// ── 3. T105 — the grade comes from the PLAYED game ───────────────────────────
eq(t1.meta.grade, 'Friday U11 Boys A', 'TEAM1 grade is the grade it PLAYED in, not the superseded one');
eq(t1.meta.gid, 'GR_A', 'TEAM1 gid matches');
eq(ts.TEAM2.meta.grade, 'Friday U11 Boys A', 'TEAM2 grade from its played game, not its later unplayed fixture');
eq(t3.meta.grade, '', 'a team whose ONLY fixture is superseded gets NO grade rather than the dead one');
eq(ts.TEAM4.meta.grade, 'Friday U11 Boys B', 'a pre-season team still gets its grade from an unplayed fixture');
eq(num(out1, 'grade from a PLAYED game'), 2, 'two teams graded from a played game');
eq(num(out1, 'grade from an UNPLAYED one'), 2, 'two pre-season teams graded from an unplayed fixture');
eq(num(out1, 'grade not known'), 1, 'one team left ungraded - correctly');

// ── 4. schema version and --resume ───────────────────────────────────────────
eq(Number(t1.meta.sv), 2, 'every team carries the schema version');
const out2 = run(root, ['--resume']);
ok(/1 skipped/.test(out2), '--resume skips a season already at the current schema');
// A file written under an OLDER schema must be rebuilt, not skipped. This is the
// defect the old `grade in meta` marker had: it could not tell the two apart.
const stale = readOut(root);
for (const k of Object.keys(stale)) delete stale[k].meta.sv;
for (const k of Object.keys(stale)) for (const f of stale[k].fixtures || []) delete f.sup;
fs.writeFileSync(path.join(root, 'team-stats', 'bv', `${SID}.json`), JSON.stringify(stale));
const out3 = run(root, ['--resume']);
ok(!/1 skipped/.test(out3), '--resume does NOT skip a season written under an older schema');
eq(readOut(root).TEAM1.fixtures.find(f => f.gameId === 'g_sup').sup, 'g_played', 'the rebuild restored the flag it had been stripped of');

// ── 5. idempotence: two runs, no crawl between, identical output ─────────────
const a = fs.readFileSync(path.join(root, 'team-stats', 'bv', `${SID}.json`), 'utf8');
run(root, []);
const b = fs.readFileSync(path.join(root, 'team-stats', 'bv', `${SID}.json`), 'utf8');
ok(a === b, 'rebuilding twice with no crawl between produces an identical file');

// ── 6. the flag is recomputed, not merged ────────────────────────────────────
// Clear it upstream exactly as the nightly would, rebuild, and the fixture entry
// must lose it. A set-only consumer would keep it forever.
const cleared = JSON.parse(JSON.stringify(GAMES));
delete cleared.g_sup.sup;
cleared.g_sup.hs = 11; cleared.g_sup.as = 9; cleared.g_sup.st = 'FINAL';
fs.writeFileSync(path.join(root, 'games', 'bv', `${SID}.json`), JSON.stringify({ games: cleared }));
const out4 = run(root, []);
const ts4  = readOut(root);
ok(!('sup' in ts4.TEAM1.fixtures.find(f => f.gameId === 'g_sup')), 'a cleared sup disappears from team-stats on the next build');
eq(num(out4, 'sup: flagged games read'), 0, 'run reports 0 flagged games once the flag is cleared');

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
