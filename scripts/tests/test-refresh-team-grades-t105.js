// scripts/tests/test-refresh-team-grades-t105.js
// REVISION 2026-11-24a — first version.
//
// Asserts T105 in refresh-team-grades.js: a team's grade in data/team-index.json
// comes from its latest PLAYED game, a `sup` fixture is never a grade source at
// any tier, an unplayed fixture still answers for a team that has no played game,
// and two games on one date and time resolve the same way every run.
//
// ⚠ RUNS THE REAL SCRIPT (T103: a fixture written from the same belief as the
// code tests the belief). Repository-shaped temp tree, actual script copied in,
// `git` stubbed on PATH so gitCommit stops at "nothing staged" instead of
// entering its 60-attempt push loop. No network, nothing written outside the
// temp dir.
//
// Run:  node scripts/tests/test-refresh-team-grades-t105.js

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..');
const SID = 'tst00001';

let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l}${d !== undefined ? `  -> ${d}` : ''}`); } };
const eq = (a, b, l) => ok(a === b, l, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const GAMES = {
  // The real shape: played in A, and an unplayed AR fixture on the SAME DATE at a
  // LATER TIME carrying sup. Date-only ordering resolves this by key order;
  // (date, time) ordering without a played test picks AR. Both are the defect.
  g_played: { d: '2026-11-13', t: '18:30', gid: 'GR_A',  gn: 'Friday U11 Boys A',
              h: 'TEAM1', a: 'TEAM2', st: 'FINAL', hs: 40, as: 30 },
  g_sup:    { d: '2026-11-13', t: '19:30', gid: 'GR_AR', gn: 'Friday U11 Boys AR',
              h: 'TEAM1', a: 'TEAM3', st: 'UPCOMING', sup: 'g_played' },
  // A genuine future fixture, later than the played game: tier 2, must not win.
  g_future: { d: '2026-12-04', t: '18:30', gid: 'GR_A',  gn: 'Friday U11 Boys A',
              h: 'TEAM2', a: 'TEAM1', st: 'UPCOMING' },
  // A team with no played game at all: tier 2 is all there is, and it answers.
  g_pre:    { d: '2027-01-10', t: '09:00', gid: 'GR_B',  gn: 'Friday U11 Boys B',
              h: 'TEAM4', a: 'TEAM5', st: 'UPCOMING' },
  // Two PLAYED games, one date, one time, two grades - a real double-header or a
  // fixture error. Something must win; the point is that the same one always does.
  g_tie_a:  { d: '2026-11-20', t: '18:30', gid: 'GR_A',  gn: 'Friday U11 Boys A',
              h: 'TEAM6', a: 'TEAM2', st: 'FINAL', hs: 1, as: 2 },
  g_tie_b:  { d: '2026-11-20', t: '18:30', gid: 'GR_B',  gn: 'Friday U11 Boys B',
              h: 'TEAM6', a: 'TEAM5', st: 'FINAL', hs: 3, as: 4 },
};

const INDEX = {
  'Test Season': [
    { id: 'TEAM1', sid: SID, grade: 'Friday U11 Boys AR' },
    { id: 'TEAM3', sid: SID, grade: 'Friday U11 Boys AR' },
    { id: 'TEAM4', sid: SID, grade: 'something stale' },
    { id: 'TEAM6', sid: SID, grade: '' },
  ],
};

function buildTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtg-t105-'));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'games', 'bv'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'refresh-team-grades.js'), path.join(root, 'scripts', 'refresh-team-grades.js'));
  for (const f of fs.readdirSync(path.join(SRC, 'lib'))) fs.copyFileSync(path.join(SRC, 'lib', f), path.join(root, 'scripts', 'lib', f));
  fs.writeFileSync(path.join(root, 'data', 'team-index.json'), JSON.stringify(INDEX));
  fs.writeFileSync(path.join(root, 'games', 'bv', `${SID}.json`), JSON.stringify({ games: GAMES }));
  const stub = path.join(root, 'stub');
  fs.mkdirSync(stub);
  fs.writeFileSync(path.join(stub, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return root;
}
const run = (root, extra = []) => execFileSync(process.execPath, [path.join(root, 'scripts', 'refresh-team-grades.js'), ...extra], {
  cwd: root, env: { ...process.env, PATH: `${path.join(root, 'stub')}:${process.env.PATH}` }, encoding: 'utf8',
});
const idx  = (root) => JSON.parse(fs.readFileSync(path.join(root, 'data', 'team-index.json'), 'utf8'))['Test Season'];
const byId = (root) => Object.fromEntries(idx(root).map(e => [e.id, e]));
const num  = (out, label) => { const m = out.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(\\d+)')); return m ? Number(m[1]) : null; };

console.log('test-refresh-team-grades-t105.js');
const root = buildTree();

// A dry run must change nothing on disk.
const outDry = run(root, ['--dry-run']);
eq(byId(root).TEAM1.grade, 'Friday U11 Boys AR', 'dry run writes nothing');

const out = run(root);
const e = byId(root);

eq(e.TEAM1.grade, 'Friday U11 Boys A', 'TEAM1 takes the PLAYED grade, not the later-timed superseded fixture');
eq(e.TEAM1.gradeFrom, '2026-11-13', 'gradeFrom is the played game date');
eq(e.TEAM3.grade, 'Friday U11 Boys AR', 'a team whose only graded game is superseded KEEPS its existing grade, never blanked');
ok(!('gradeFrom' in e.TEAM3), 'and gets no gradeFrom, because no game answered for it');
eq(e.TEAM4.grade, 'Friday U11 Boys B', 'a team with no played game is still graded from an unplayed fixture');

eq(num(out, 'superseded (sup)'), 1, 'one superseded game reported');   // num() escapes the label; do not pre-escape it
eq(num(out, 'graded and PLAYED'), 3, 'three played graded games');
eq(num(out, 'graded and unplayed'), 2, 'two unplayed graded games');
eq(num(out, 'same date AND time'), 1, 'the one genuine tie is counted, not absorbed');
ok(/no graded game found\s*:\s*1/.test(out), 'TEAM3 is reported as unreachable rather than silently skipped');

// Determinism: the tie must resolve identically on a re-run, and from a tree built
// in a different key order - the old failure was key order deciding the answer.
const tie1 = e.TEAM6.grade;
ok(tie1 === 'Friday U11 Boys A' || tie1 === 'Friday U11 Boys B', 'the tie resolved to one of the two real grades');
const root2 = buildTree();
const reordered = {};
for (const k of Object.keys(GAMES).reverse()) reordered[k] = GAMES[k];
fs.writeFileSync(path.join(root2, 'games', 'bv', `${SID}.json`), JSON.stringify({ games: reordered }));
run(root2);
eq(byId(root2).TEAM6.grade, tie1, 'the tie resolves the SAME way with the games in the opposite key order');
eq(byId(root2).TEAM1.grade, 'Friday U11 Boys A', 'and TEAM1 is unaffected by key order too');

// Idempotence: a second run reports nothing to update.
const out3 = run(root);
ok(/grade updated\s*:\s*0/.test(out3), 'a second run updates nothing');

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(root2, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
