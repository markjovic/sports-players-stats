// scripts/tests/test-dead-grades.js
// Runs the REAL recordDeadGrades from scripts/lib/dead-grades.cjs against a temp
// tree. No re-implementation (T103), no network, nothing written outside os.tmpdir.
//
// The property that matters most is asymmetric and easy to get wrong:
//   a POSITIVE answer clears an entry; ABSENCE never does.
// A partial run — one season, a blocked batch — must not erase a repo-wide record.

'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const assert = require('assert');

const { recordDeadGrades, deadGradeResidue } = require('../lib/dead-grades.cjs');

let n = 0;
function ok(what, fn) { fn(); n++; process.stdout.write(`  ok  ${what}\n`); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-'));
const FILE = path.join(ROOT, 'data', 'dead-grades.json');
const read = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const byId = () => { const m = new Map(); for (const g of read().grades) m.set(g.id, g); return m; };
const obs = (gone = {}, alive = [], noAnswer = 0) => ({
  gone: new Map(Object.entries(gone)), alive: new Set(alive), noAnswer,
});

// ── first observation ───────────────────────────────────────────────────────
let r = recordDeadGrades(ROOT, obs({ G1: { sid: 'S1', gname: 'U12 Boys Grading' } }));
ok('first denial creates an entry', () => {
  assert.strictEqual(r.added, 1); assert.strictEqual(r.confirmed, 0);
  assert.strictEqual(r.total, 1); assert.strictEqual(r.written, true);
});
ok('entry carries sid, name, runs=1 and both timestamps', () => {
  const e = byId().get('G1');
  assert.strictEqual(e.sid, 'S1');
  assert.strictEqual(e.gn, 'U12 Boys Grading');
  assert.strictEqual(e.runs, 1);
  assert.ok(e.firstSeen && e.lastSeen);
});

// ── repeat observation ──────────────────────────────────────────────────────
r = recordDeadGrades(ROOT, obs({ G1: { sid: 'S1', gname: 'U12 Boys Grading' } }));
ok('second denial increments runs, does not duplicate', () => {
  assert.strictEqual(r.added, 0); assert.strictEqual(r.confirmed, 1);
  assert.strictEqual(r.total, 1);
  assert.strictEqual(byId().get('G1').runs, 2);
});
ok('firstSeen is preserved across runs', () => {
  const e = byId().get('G1');
  assert.notStrictEqual(e.firstSeen, undefined);
  assert.ok(e.lastSeen >= e.firstSeen);
});

// ── ⚠ ABSENCE MUST NOT CLEAR ────────────────────────────────────────────────
r = recordDeadGrades(ROOT, obs({ G9: { sid: 'S9', gname: 'Other' } }));
ok('a run that never asked about G1 leaves it untouched', () => {
  assert.strictEqual(byId().has('G1'), true);
  assert.strictEqual(byId().get('G1').runs, 2, 'runs must not move for a grade not asked about');
  assert.strictEqual(r.total, 2);
});
r = recordDeadGrades(ROOT, obs({}, [], 500));
ok('a wholly blocked run (no answers at all) clears nothing and writes nothing', () => {
  assert.strictEqual(r.written, false);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(byId().size, 2);
});

// ── a POSITIVE answer clears ────────────────────────────────────────────────
r = recordDeadGrades(ROOT, obs({}, ['G1']));
ok('a live answer removes the entry and is counted', () => {
  assert.strictEqual(r.resurrected, 1);
  assert.strictEqual(byId().has('G1'), false);
  assert.strictEqual(byId().has('G9'), true, 'the grade not asked about must survive');
});
ok('runs restarts at 1 when a cleared grade is denied again', () => {
  recordDeadGrades(ROOT, obs({ G1: { sid: 'S1', gname: 'U12 Boys Grading' } }));
  assert.strictEqual(byId().get('G1').runs, 1);
});

// ── a live answer for a grade never recorded is a no-op ─────────────────────
const before = byId().size;
r = recordDeadGrades(ROOT, obs({}, ['NEVER_SEEN']));
ok('a live answer for an unrecorded grade changes nothing and writes nothing', () => {
  assert.strictEqual(r.resurrected, 0);
  assert.strictEqual(r.written, false);
  assert.strictEqual(byId().size, before);
});

// ── no churn: an unchanged run must not rewrite the file ────────────────────
const stamp = read().generatedAt;
recordDeadGrades(ROOT, obs({}, ['NEVER_SEEN']));
ok('generatedAt does not move when nothing changed', () => {
  assert.strictEqual(read().generatedAt, stamp,
    'a state file rewritten nightly with no new information is the defect this guards');
});

// ── a corrupt file announces itself and does not silently start empty ───────
fs.writeFileSync(FILE, '{ this is not json');
const logs = [];
const realLog = console.log; console.log = (...a) => logs.push(a.join(' '));
r = recordDeadGrades(ROOT, obs({ G2: { sid: 'S2', gname: 'X' } }));
console.log = realLog;
ok('a parse failure is announced, not swallowed', () => {
  assert.ok(logs.some(l => /could not be parsed/.test(l)), 'must say the file could not be parsed');
  assert.ok(logs.some(l => /LOST/.test(l)), 'must say what is lost');
  assert.strictEqual(r.parseFailed, true);
});
ok('after a parse failure it writes this run only, and says so rather than appearing empty', () => {
  assert.strictEqual(r.written, true);
  assert.strictEqual(byId().size, 1);
  assert.strictEqual(byId().has('G2'), true);
});

// ── shape of the written file ───────────────────────────────────────────────
ok('file carries count, scope and a note, and count matches the array', () => {
  const j = read();
  assert.strictEqual(j.count, j.grades.length);
  assert.ok(/RECORD ONLY/.test(j.scope));
  assert.ok(/never by absence/i.test(j.note));
});
ok('grades are sorted by id so the file does not churn on map order', () => {
  recordDeadGrades(ROOT, obs({ Z9: { sid: 'S', gname: null }, A1: { sid: 'S', gname: null } }));
  const ids = read().grades.map(g => g.id);
  assert.deepStrictEqual(ids, [...ids].sort());
});

// ── missing metadata must not crash or invent values ────────────────────────
r = recordDeadGrades(ROOT, obs({ NOMETA: {} }));
ok('a denial with no sid or name records nulls, not undefined or a guess', () => {
  const e = byId().get('NOMETA');
  assert.strictEqual(e.sid, null);
  assert.strictEqual(e.gn, null);
});
ok('a later run supplies missing metadata without resetting runs', () => {
  recordDeadGrades(ROOT, obs({ NOMETA: { sid: 'S5', gname: 'Found Later' } }));
  const e = byId().get('NOMETA');
  assert.strictEqual(e.sid, 'S5');
  assert.strictEqual(e.gn, 'Found Later');
  assert.strictEqual(e.runs, 2);
});

// ── creating the file from nothing ──────────────────────────────────────────
const ROOT2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dg2-'));
r = recordDeadGrades(ROOT2, obs({ N1: { sid: 'S', gname: 'n' } }));
ok('creates data/ and the file when neither exists', () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT2, 'data', 'dead-grades.json')), true);
  assert.strictEqual(r.added, 1);
});
const ROOT3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dg3-'));
r = recordDeadGrades(ROOT3, obs({}, [], 12));
ok('no file and nothing observed writes nothing at all', () => {
  assert.strictEqual(r.written, true, 'first run with no prior file still establishes it');
  assert.strictEqual(r.total, 0);
});

// ── deadGradeResidue — STAGE 2 selection ────────────────────────────────────
// ⚠ The ratio of history to residue in a dead grade is about 60:1 repo-wide, so
// every one of these guards is load-bearing. A PLAYED game in a dead grade is a
// completed grading round competitions hide, and it must never be selected.
const TODAY = '2026-11-25';
const dead1 = [{ id: 'DEAD', sid: 'S1', gn: 'Friday U11 Boys D', runs: 2 }];
const mkGames = () => ({
  future_dead:  { gid: 'DEAD', d: '2026-12-11', st: 'UPCOMING', h: 't1', a: 't2' },
  future_dead2: { gid: 'DEAD', d: '2027-03-05', st: 'UPCOMING', h: 't1', a: 't3' },
  past_dead:    { gid: 'DEAD', d: '2026-10-30', st: 'UPCOMING', h: 't1', a: 't4' },
  undated_dead: { gid: 'DEAD',                  st: 'UPCOMING', h: 't1', a: 't5' },
  played_dead:  { gid: 'DEAD', d: '2026-10-02', hs: 40, as: 30, st: 'FINAL', p: ['p1'], h: 't1', a: 't6' },
  forfeit_dead: { gid: 'DEAD', d: '2026-10-09', forfeit: true, fo: 't1', h: 't1', a: 't7' },
  future_live:  { gid: 'LIVE', d: '2026-12-11', st: 'UPCOMING', h: 't1', a: 't8' },
});
let r2 = deadGradeResidue({ games: mkGames(), sid: 'S1', dead: dead1, today: TODAY, minRuns: 2 });
ok('selects ONLY future-dated unplayed games in the dead grade', () => {
  assert.deepStrictEqual(r2.residue.map(x => x.gameId).sort(), ['future_dead', 'future_dead2']);
});
ok('a PLAYED game in a dead grade is never selected', () => {
  assert.ok(!r2.residue.some(x => x.gameId === 'played_dead'), 'played game must not be selected');
  assert.strictEqual(r2.kept.played, 2, 'a forfeit counts as played too');
});
ok('a past-dated or undated unplayed game is never selected', () => {
  assert.ok(!r2.residue.some(x => /past|undated/.test(x.gameId)));
  assert.strictEqual(r2.kept.pastOrUndated, 2);
});
ok('a game in a grade that is still alive is untouched', () => {
  assert.ok(!r2.residue.some(x => x.gameId === 'future_live'));
});
ok('the selected rows carry the grade id and date for the deletion log', () => {
  const x = r2.residue.find(y => y.gameId === 'future_dead');
  assert.strictEqual(x.gid, 'DEAD');
  assert.strictEqual(x.d, '2026-12-11');
});

// ── the minRuns gate ────────────────────────────────────────────────────────
ok('a grade seen only once is NOT acted on at minRuns=2', () => {
  const once = [{ id: 'DEAD', sid: 'S1', runs: 1 }];
  const r = deadGradeResidue({ games: mkGames(), sid: 'S1', dead: once, today: TODAY, minRuns: 2 });
  assert.strictEqual(r.residue.length, 0);
  assert.strictEqual(r.grades, 0);
});
ok('the same grade IS acted on once it reaches minRuns', () => {
  const twice = [{ id: 'DEAD', sid: 'S1', runs: 2 }];
  const r = deadGradeResidue({ games: mkGames(), sid: 'S1', dead: twice, today: TODAY, minRuns: 2 });
  assert.strictEqual(r.residue.length, 2);
});
ok('an entry with no runs at all is treated as zero, not as confirmed', () => {
  const none = [{ id: 'DEAD', sid: 'S1' }];
  assert.strictEqual(deadGradeResidue({ games: mkGames(), sid: 'S1', dead: none, today: TODAY, minRuns: 1 }).residue.length, 0);
});

// ── season scoping ──────────────────────────────────────────────────────────
ok('a record for a DIFFERENT season does not reach this one', () => {
  const other = [{ id: 'DEAD', sid: 'S_OTHER', runs: 9 }];
  assert.strictEqual(deadGradeResidue({ games: mkGames(), sid: 'S1', dead: other, today: TODAY, minRuns: 2 }).residue.length, 0);
});
ok('a record with no sid applies to any season', () => {
  const anysid = [{ id: 'DEAD', sid: null, runs: 2 }];
  assert.strictEqual(deadGradeResidue({ games: mkGames(), sid: 'S1', dead: anysid, today: TODAY, minRuns: 2 }).residue.length, 2);
});

// ── empty and malformed inputs ──────────────────────────────────────────────
ok('no record means nothing is selected and no grade is counted', () => {
  const r = deadGradeResidue({ games: mkGames(), sid: 'S1', dead: [], today: TODAY, minRuns: 2 });
  assert.strictEqual(r.residue.length, 0);
  assert.strictEqual(r.grades, 0);
});
ok('a game with no gid is skipped rather than throwing', () => {
  const g = mkGames(); g.nogid = { d: '2026-12-11', st: 'UPCOMING' };
  assert.strictEqual(deadGradeResidue({ games: g, sid: 'S1', dead: dead1, today: TODAY, minRuns: 2 }).residue.length, 2);
});
ok('a game dated exactly today is selected - today is not the past', () => {
  const g = mkGames(); g.today_dead = { gid: 'DEAD', d: TODAY, st: 'UPCOMING', h: 't1', a: 't9' };
  const r = deadGradeResidue({ games: g, sid: 'S1', dead: dead1, today: TODAY, minRuns: 2 });
  assert.ok(r.residue.some(x => x.gameId === 'today_dead'));
});

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(ROOT2, { recursive: true, force: true });
fs.rmSync(ROOT3, { recursive: true, force: true });
console.log(`\n  ${n} assertions passed`);
