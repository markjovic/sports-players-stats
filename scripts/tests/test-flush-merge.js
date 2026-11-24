#!/usr/bin/env node
// scripts/tests/test-flush-merge.js
// REVISION 2026-11-24a — first version.
//
// Asserts that discover-fixtures.js writes its findings onto the season file AS IT
// IS ON DISK at flush time, not over a copy read hours earlier.
//
// WHY IT EXISTS. `flushGameFiles` used to write `_gameFileCache[seasonId]` back
// whole. That object is filled by `loadGameFile` when the season is FIRST touched,
// and the 10 Nov sweep ran for 5h 50m, so a season read in the first minute was
// written back nearly six hours later — over anything another writer had put in
// the file meanwhile, with `merge -X ours` in the push loop making the loss silent.
// It was safe only because the data-write lock guaranteed no other writer, which is
// the guarantee the read/write split has to stop needing.
//
// ⚠ RUNS THE REAL FUNCTIONS. The shipped script is copied into a repository-shaped
// temp tree and require()d, so `ROOT` resolves inside the tree and `applyGame`,
// `mergeFixture` and `flushGameFiles` are the ones that ship (T103). Each scenario
// gets its own tree and therefore its own module instance, because the pending map
// and the file cache are module state. No network, no git, nothing written outside
// the temp dir.
//
// ⚠ NOT EXERCISED: the shrink guard in flushGameFiles. The merge has no deletion
// path, so no input to this function can make a file lose a game — the guard exists
// for a future change that introduces one, and saying it is tested would be a lie.
//
// Run:  node scripts/tests/test-flush-merge.js

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..');
const SID = 'tst00002';

let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l}${d !== undefined ? `  -> ${d}` : ''}`); } };
const eq = (a, b, l) => ok(a === b, l, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

// ── Fixtures shaped from Q_TEAM_FIXTURE's own selection set, not from memory ──
function phqGame(over = {}) {
  const g = {
    id: 'G1',
    dates: ['2027-01-10'],
    status: { value: 'UPCOMING' },
    home: { id: 'T1', name: 'Alpha 1', logo: { sizes: [] }, organisation: { id: 'O1', name: 'Club A' } },
    away: { id: 'T2', name: 'Beta 2',  logo: { sizes: [] }, organisation: { id: 'O2', name: 'Club B' } },
    result: { home: { statistics: [] }, away: { statistics: [] } },
    allocation: {
      dateTimeList: [{ date: '2027-01-10', time: '18:30:00' }],
      court: { id: 'C1', name: 'Court 3', abbreviatedName: 'C3',
               venue: { id: 'V1', name: 'Eltham Stadium', abbreviatedName: 'ELT',
                        latitude: -37.7, longitude: 145.1, address: '1 Main St',
                        suburb: 'Eltham', state: 'VIC', postcode: '3095', country: 'AU' } },
    },
  };
  return { ...g, ...over };
}
function phqRound(over = {}) {
  return { id: 'R1', name: 'Round 5', isFinalsRound: false,
           grade: { id: 'GR1', name: 'U12 Boys A', season: { id: SID, name: 'Summer 2026/27' } },
           ...over };
}
const scored = n => [{ count: n, type: { value: 'TOTAL_SCORE' } }];

// ── One module instance per scenario ─────────────────────────────────────────
function freshModule(seasonFileContent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-flush-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'games', 'bv'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'discover-fixtures.js'), path.join(root, 'scripts', 'discover-fixtures.js'));
  const file = path.join(root, 'games', 'bv', `${SID}.json`);
  if (seasonFileContent !== undefined) fs.writeFileSync(file, seasonFileContent);
  const mod = require(path.join(root, 'scripts', 'discover-fixtures.js'));
  const readDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const writeDisk = o => fs.writeFileSync(file, typeof o === 'string' ? o : JSON.stringify(o));
  return { mod, root, file, readDisk, writeDisk };
}

console.log('test-flush-merge');

// 1 · A new game lands with the shape every consumer has always seen.
{
  const { mod, readDisk } = freshModule(JSON.stringify({ games: {} }));
  const sg = mod.loadGameFile(SID);
  const r  = mod.applyGame(sg, SID, phqGame(), phqRound(), 'U12 Boys A');
  eq(r.added, 1, '1a counted as added');
  eq(mod.flushGameFiles(), 1, '1b one file written');
  const g = readDisk().games.G1;
  eq(g.d, '2027-01-10', '1c date');
  eq(g.rn, 'Round 5', '1d bare round name');
  eq(g.gid, 'GR1', '1e grade id');
  eq(g.gn, 'U12 Boys A', '1f grade name');
  eq(g.h, 'T1', '1g home id');
  eq(g.an, 'Beta 2', '1h away name');
  eq(g.vid, 'V1', '1i venue id');
  eq(g.ct, 'Court 3', '1j court');
  eq(g.t, '18:30', '1k time truncated to HH:MM');
  eq(g.st, 'UPCOMING', '1l status');
  ok(!('hs' in g) && !('as' in g), '1m no scores written for an unplayed fixture');
  eq(Object.keys(g).join(','), 'd,rn,gid,gn,h,hn,a,an,vid,vn,ct,t,st',
     '1n key ORDER matches the literal this replaced — a re-run diffs clean');
}

// 1b · A new row where PlayHQ answers nothing still carries the six, null, in place.
{
  const { mod, readDisk } = freshModule(JSON.stringify({ games: {} }));
  const sg = mod.loadGameFile(SID);
  const bare = phqGame({ dates: [], allocation: null, status: null, home: null,
                         away: { id: 'T2', name: 'Beta 2' } });
  eq(mod.applyGame(sg, SID, bare, phqRound({ name: null, grade: null }), '').added, 1, '1o added');
  mod.flushGameFiles();
  const g = readDisk().games.G1;
  eq(Object.keys(g).join(','), 'd,rn,h,hn,a,an', '1p the six, in order');
  eq(g.d, null, '1q d null');
  eq(g.rn, null, '1r rn null');
  eq(g.h, null, '1s h null');
  eq(g.an, 'Beta 2', '1t and what PlayHQ did answer');
}

// 2 · THE CASE THIS EXISTS FOR. Another writer changes the file between the read
//     and the flush: its new game must survive and its new field must survive.
{
  const { mod, readDisk, writeDisk } = freshModule(JSON.stringify({ games: {
    G1: { d: '2027-01-10', rn: 'Round 5', h: 'T1', hn: 'Alpha 1', a: 'T2', an: 'Beta 2',
          vn: 'Old Stadium', st: 'UPCOMING' },
  } }));
  const sg = mod.loadGameFile(SID);
  const r  = mod.applyGame(sg, SID, phqGame(), phqRound(), 'U12 Boys A');
  eq(r.updated, 1, '2a the sweep sees a change');

  // ... meanwhile, nightly-crawl writes the same file.
  writeDisk({ games: {
    G1: { d: '2027-01-10', rn: 'Round 5', h: 'T1', hn: 'Alpha 1', a: 'T2', an: 'Beta 2',
          vn: 'Old Stadium', st: 'UPCOMING', p: ['p1', 'p2'], spc: true },
    G9: { d: '2027-01-11', rn: 'Round 5', h: 'T3', hn: 'Gamma', a: 'T4', an: 'Delta', st: 'UPCOMING' },
  } });

  eq(mod.flushGameFiles(), 1, '2b flushed');
  const d = readDisk();
  ok(!!d.games.G9, '2c the other writer\'s NEW game survived the flush');
  eq(JSON.stringify(d.games.G1.p), '["p1","p2"]', '2d the roster written after we read survived');
  eq(d.games.G1.spc, true, '2e so did spc');
  eq(d.games.G1.vn, 'Eltham Stadium', '2f and the sweep\'s own field was applied');
}

// 3 · A game that became PLAYED on disk after we read it is left as history.
{
  const { mod, readDisk, writeDisk } = freshModule(JSON.stringify({ games: {
    G1: { d: '2027-01-10', rn: 'Round 5', h: 'T1', hn: 'Alpha 1', a: 'T2', an: 'Beta 2',
          t: '17:00', st: 'UPCOMING' },
  } }));
  const sg = mod.loadGameFile(SID);
  eq(mod.applyGame(sg, SID, phqGame(), phqRound(), 'U12 Boys A').updated, 1, '3a sweep wants to change the time');

  writeDisk({ games: {
    G1: { d: '2027-01-10', rn: 'Round 5', h: 'T1', hn: 'Alpha 1', a: 'T2', an: 'Beta 2',
          t: '17:00', st: 'FINAL', hs: 44, as: 39, p: ['p1'] },
  } });

  mod.flushGameFiles();
  const g = readDisk().games.G1;
  eq(g.st, 'FINAL', '3b the result stands');
  eq(g.hs, 44, '3c the score stands');
  eq(g.t, '17:00', '3d the as-played time was NOT overwritten with the fixture time');
}

// 4 · A file that will not parse at flush time is refused, not overwritten.
{
  const { mod, writeDisk, file } = freshModule(JSON.stringify({ games: {} }));
  const sg = mod.loadGameFile(SID);
  mod.applyGame(sg, SID, phqGame(), phqRound(), 'U12 Boys A');
  writeDisk('{ this is not json');
  let threw = '';
  try { mod.flushGameFiles(); } catch (e) { threw = e.message; }
  ok(/failed to parse/.test(threw), '4a a corrupt file throws', threw.slice(0, 90));
  eq(fs.readFileSync(file, 'utf8'), '{ this is not json', '4b and was not overwritten');
}

// 5 · A file with no games object is refused the same way.
{
  const { mod, writeDisk } = freshModule(JSON.stringify({ games: {} }));
  const sg = mod.loadGameFile(SID);
  mod.applyGame(sg, SID, phqGame(), phqRound(), 'U12 Boys A');
  writeDisk({ somethingElse: 1 });
  let threw = '';
  try { mod.flushGameFiles(); } catch (e) { threw = e.message; }
  ok(/holds no games object/.test(threw), '5a throws', threw.slice(0, 90));
}

// 6 · Existing-wins, for every field PlayHQ did not answer.
{
  const { mod, readDisk } = freshModule(JSON.stringify({ games: {
    G1: { d: '2027-01-10', rn: 'Round 5', gid: 'GRX', gn: 'U12 Boys B', h: 'T1', hn: 'Alpha 1',
          a: 'T2', an: 'OLD NAME', vid: 'V9', vn: 'Kept Stadium', ct: 'Kept Court', t: '09:15',
          st: 'UPCOMING', p: ['p1'], sup: 'G7' },
  } }));
  const sg = mod.loadGameFile(SID);
  // PlayHQ answers with a renamed away team and NOTHING else: no allocation, no grade.
  const bare = phqGame({ allocation: null, away: { id: 'T2', name: 'Beta 2 Renamed' }, status: null });
  const r = mod.applyGame(sg, SID, bare, phqRound({ grade: null }), '');
  eq(r.updated, 1, '6a one change');
  eq(JSON.stringify(r.changes), JSON.stringify([['an', 'OLD NAME', 'Beta 2 Renamed']]), '6b and it is only the name');
  mod.flushGameFiles();
  const g = readDisk().games.G1;
  eq(g.vn, 'Kept Stadium', '6c venue kept');
  eq(g.ct, 'Kept Court', '6d court kept');
  eq(g.t, '09:15', '6e time kept');
  eq(g.gid, 'GRX', '6f grade id kept');
  eq(g.gn, 'U12 Boys B', '6g grade name kept');
  eq(g.st, 'UPCOMING', '6h status kept');
  eq(g.sup, 'G7', '6i sup survives — it is not this script\'s field');
  eq(g.d, '2027-01-10', '6j date kept (dates[] still answered it)');
}

// 7 · The churn that used to run for ever: a stored row with no `h`, and PlayHQ
//     answering no home id, is NOT rewritten. The old literal wrote `h: null` and
//     diffEntry read undefined !== null as a change, every run, on every such row.
{
  const before = JSON.stringify({ games: {
    G1: { d: '2027-01-10', rn: 'Round 5', a: 'T2', an: 'Beta 2', st: 'UPCOMING' },
  } });
  const { mod, file } = freshModule(before);
  const sg = mod.loadGameFile(SID);
  const bare = phqGame({ home: null, allocation: null, status: null,
                         away: { id: 'T2', name: 'Beta 2' } });
  const r = mod.applyGame(sg, SID, bare, phqRound({ grade: null }), '');
  eq(r.added, 0, '7a not added');
  eq(r.updated, 0, '7b and NOT counted as updated');
  eq(mod.flushGameFiles(), 0, '7c nothing flushed');
  eq(fs.readFileSync(file, 'utf8'), before, '7d the file is byte-identical');
}

// 8 · The same game comes back from BOTH its teams. The second pass is a no-op.
{
  const { mod } = freshModule(JSON.stringify({ games: {} }));
  const sg = mod.loadGameFile(SID);
  eq(mod.applyGame(sg, SID, phqGame(), phqRound(), 'U12 Boys A').added, 1, '8a first team adds it');
  const r2 = mod.applyGame(sg, SID, phqGame(), phqRound(), 'U12 Boys A');
  eq(r2.added, 0, '8b second team does not add it again');
  eq(r2.updated, 0, '8c nor update it');
}

// 9 · A season with no file at all is created.
{
  const { mod, readDisk, file } = freshModule(undefined);
  ok(!fs.existsSync(file), '9a no file to start with');
  const sg = mod.loadGameFile(SID);
  mod.applyGame(sg, SID, phqGame(), phqRound(), 'U12 Boys A');
  eq(mod.flushGameFiles(), 1, '9b written');
  eq(Object.keys(readDisk().games).length, 1, '9c one game');
}

// 10 · A PLAYED game already on file is never touched, scores and all.
{
  const { mod, readDisk } = freshModule(JSON.stringify({ games: {
    G1: { d: '2027-01-10', rn: 'Round 5', h: 'T1', hn: 'Alpha 1', a: 'T2', an: 'Beta 2',
          t: '17:00', st: 'FINAL', hs: 50, as: 48 },
  } }));
  const sg = mod.loadGameFile(SID);
  const edited = phqGame({ home: { id: 'TZ', name: 'ZZ - Alpha 1 - W' },
                           result: { home: { statistics: scored(1) }, away: { statistics: scored(2) } } });
  const r = mod.applyGame(sg, SID, edited, phqRound(), 'U12 Boys A');
  eq(r.added + r.updated, 0, '10a a played game is history — no change');
  eq(mod.flushGameFiles(), 0, '10b nothing flushed');
  const g = readDisk().games.G1;
  eq(g.h, 'T1', '10c the archival rename did not reach it');
  eq(g.hs, 50, '10d the score stands');
}

// 11 · Scores DO land on a game that is not yet on file.
{
  const { mod, readDisk } = freshModule(JSON.stringify({ games: {} }));
  const sg = mod.loadGameFile(SID);
  const done = phqGame({ status: { value: 'FINAL' },
                         result: { home: { statistics: scored(61) }, away: { statistics: scored(55) } } });
  eq(mod.applyGame(sg, SID, done, phqRound(), 'U12 Boys A').added, 1, '11a added');
  mod.flushGameFiles();
  const g = readDisk().games.G1;
  eq(g.hs, 61, '11b home score');
  eq(g.as, 55, '11c away score');
  eq(g.st, 'FINAL', '11d status');
}

// 12 · The cache is re-pointed at what was actually written, so the next team in
//      the same season diffs against the file rather than a stale copy.
{
  const { mod, writeDisk } = freshModule(JSON.stringify({ games: {
    G1: { d: '2027-01-10', rn: 'Round 5', h: 'T1', hn: 'Alpha 1', a: 'T2', an: 'Beta 2', st: 'UPCOMING' },
  } }));
  const sg = mod.loadGameFile(SID);
  mod.applyGame(sg, SID, phqGame(), phqRound(), 'U12 Boys A');
  writeDisk({ games: {
    G1: { d: '2027-01-10', rn: 'Round 5', h: 'T1', hn: 'Alpha 1', a: 'T2', an: 'Beta 2', st: 'UPCOMING' },
    G9: { d: '2027-01-11', rn: 'Round 5', h: 'T3', hn: 'Gamma', a: 'T4', an: 'Delta', st: 'UPCOMING' },
  } });
  mod.flushGameFiles();
  const after = mod.loadGameFile(SID);
  ok(!!after.games.G9, '12a the cache now holds the other writer\'s game too');
  eq(after.games.G1.vn, 'Eltham Stadium', '12b and our own write');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
