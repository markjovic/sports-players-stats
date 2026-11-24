#!/usr/bin/env node
// scripts/tests/test-emit-apply.js
// REVISION 2026-11-24a — first version.
//
// Asserts the apply half of the --emit/--apply split: a changeset is replayed onto
// the files as they are IN THIS CHECKOUT, and anything that would make the replay
// write the wrong thing is refused loudly instead.
//
// WHY THE SPLIT EXISTS. Measured 2026-11-10 and 2026-11-22: the sweep holds the
// data-write lock for 5h 50m and 6h 42m and spends 4.2 and 5.1 minutes of it
// committing. 83% of each run is a 90-second WAF pause. The reads need no lock; only
// the commit does.
//
// ⚠ RUNS THE REAL COMMAND. Each case spawns
//     node scripts/discover-fixtures.js --current-only --apply=<file>
// in a repository-shaped temp tree with `git` and `sleep` stubbed on PATH — the exact
// command the workflow's commit job runs, so the mode flags, the progress key they
// derive and the exit code are all the shipped ones. --apply returns before any
// PlayHQ call, so no network and no API stub.
//
// Case 0 runs the EMIT half too, end to end, by preloading a module that replaces
// globalThis.fetch with canned PlayHQ answers (`node --require`). That stubs the
// transport only — the queries, the session handling, the sweep loop, the apply rules
// and both exit paths are the shipped ones. It is the one place a changeset is
// produced by the real sweep rather than written by hand.
//
// Run:  node scripts/tests/test-emit-apply.js

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..');
const SID = 'tst00003';

let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l}${d !== undefined ? `  -> ${d}` : ''}`); } };
const eq = (a, b, l) => ok(a === b, l, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const GIT_STUB = `#!/bin/sh
while [ "$1" = "-c" ]; do shift 2; done
verb="$1"; shift
case "$verb" in
  add)    exit 0 ;;
  diff)   echo " 2 files changed, 2 insertions(+)"; exit 0 ;;
  commit) shift; while [ "$1" != "-m" ] && [ -n "$1" ]; do shift; done; echo "$2" >> "$DF_T_DIR/commits"; exit 0 ;;
  merge)  if [ "$1" = "--abort" ]; then exit 128; fi; exit 0 ;;
  fetch)  exit 0 ;;
  push)   echo push >> "$DF_T_DIR/pushes"; exit 0 ;;
  *) exit 0 ;;
esac
`;

function tree({ games, changeset, stale, progress, progressKey = 'active-current' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-apply-'));
  for (const d of [['scripts'], ['stub'], ['state'], ['games', 'bv'], ['data'], ['venue-lookup']]) {
    fs.mkdirSync(path.join(root, ...d), { recursive: true });
  }
  fs.copyFileSync(path.join(SRC, 'discover-fixtures.js'), path.join(root, 'scripts', 'discover-fixtures.js'));
  fs.writeFileSync(path.join(root, 'stub', 'git'), GIT_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'stub', 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (games !== undefined) fs.writeFileSync(path.join(root, 'games', 'bv', `${SID}.json`), JSON.stringify(games));
  if (stale !== undefined) fs.writeFileSync(path.join(root, 'data', 'stale-grade-seasons.json'), JSON.stringify(stale));
  if (progress !== undefined) fs.writeFileSync(path.join(root, `discover-fixtures-progress-${progressKey}.json`), JSON.stringify(progress));
  const csFile = path.join(root, 'changeset.json');
  if (changeset !== undefined) fs.writeFileSync(csFile, typeof changeset === 'string' ? changeset : JSON.stringify(changeset));
  return { root, csFile };
}

function apply(t, extraArgs = ['--current-only']) {
  const r = spawnSync(process.execPath,
    [path.join(t.root, 'scripts', 'discover-fixtures.js'), ...extraArgs, `--apply=${t.csFile}`],
    { cwd: t.root, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PATH: `${path.join(t.root, 'stub')}:${process.env.PATH}`, DF_T_DIR: path.join(t.root, 'state') } });
  const read = f => { try { return fs.readFileSync(path.join(t.root, f), 'utf8'); } catch (_) { return null; } };
  return {
    code: r.status,
    out: (r.stdout || '') + (r.stderr || ''),
    commits: (read('state/commits') || '').trim(),
    pushed: !!read('state/pushes'),
    season: () => JSON.parse(read(`games/bv/${SID}.json`)),
    file: read,
    exists: f => fs.existsSync(path.join(t.root, f)),
  };
}

const baseCS = (over = {}) => ({
  v: 1, tenant: 'bv', mode: 'active-current', scope: 'active, current only',
  startedAt: '2026-11-24T04:58:46.000Z', finishedAt: '2026-11-24T10:40:00.000Z',
  message: 'Fixture discovery complete: 300 seasons, 6,890 new games',
  seasons: {
    [SID]: {
      G1: { vn: 'Eltham Stadium', ct: 'Court 3', t: '18:30' },
      G2: { d: '2027-02-01', rn: 'Round 9', h: 'T5', hn: 'Echo', a: 'T6', an: 'Foxtrot', st: 'UPCOMING' },
    },
  },
  gameCount: 2,
  venues: [{ venue: { id: 'V1', name: 'Eltham Stadium', suburb: 'Eltham' }, court: { id: 'C1', name: 'Court 3' } }],
  progressDone: ['s1', 's2'], completed: true,
  zeroTeam: [{ id: 'zz', name: 'Nothing', grades: 0 }],
  staleGrades: [{ id: SID, name: 'Test', indexGrades: 9, liveGrades: 10, missing: 1 }],
  scanned: [SID, 'carried-not'],
  transient: [],
  totals: { seasons: 300, teams: 37415, added: 6890, updated: 978, refusedTeams: 0, blocks: 191 },
  ...over,
});

console.log('test-emit-apply');

// ── 0 · EMIT → APPLY, end to end, with the transport stubbed ────────────────
// The fetch stub answers the four operations a sweep makes. Shapes are taken from
// this script's own query documents, not from memory.
const FETCH_STUB = `'use strict';
const ROUND = {
  id: 'R1', name: 'Round 5', isFinalsRound: false,
  grade: { id: 'GR1', name: 'U12 Boys A', season: { id: 'SEASON1', name: 'Summer 2026/27',
           competition: { id: 'CP1', name: 'Junior Domestic', organisation: { id: 'OR1', name: 'Test BA' } } } },
  fixture: { games: [{
    id: 'GX1', dates: ['2027-02-14'], status: { value: 'UPCOMING' },
    home: { id: 'T1', name: 'Alpha 1', logo: { sizes: [] }, organisation: { id: 'O1', name: 'Club A' } },
    away: { id: 'T2', name: 'Beta 2',  logo: { sizes: [] }, organisation: { id: 'O2', name: 'Club B' } },
    result: { home: { statistics: [] }, away: { statistics: [] } },
    allocation: { dateTimeList: [{ date: '2027-02-14', time: '19:45:00' }],
      court: { id: 'C7', name: 'Court 7', abbreviatedName: 'C7',
        venue: { id: 'V7', name: 'Stub Stadium', abbreviatedName: 'STB', latitude: -37.8,
                 longitude: 145.0, address: '7 Test Rd', suburb: 'Testville', state: 'VIC',
                 postcode: '3000', country: 'AU' } } },
  }] },
};
const DATA = {
  discoverTeamsBySeason: { discoverTeams: [{ id: 'T1', grade: { id: 'GR1', name: 'U12 Boys A' } }] },
  DiscoverGrade:         { discoverGrade: { id: 'GR1', name: 'U12 Boys A', ladder: [] } },
  TeamFixture:           { discoverTeam: { id: 'T1', grade: { id: 'GR1', name: 'U12 Boys A' },
                                           season: { id: 'SEASON1', name: 'Summer 2026/27',
                                             competition: { id: 'CP1', name: 'Junior Domestic', organisation: { id: 'OR1', name: 'Test BA' } },
                                             status: { value: 'IN_PROGRESS' } },
                                           organisation: { id: 'O1', name: 'Club A' } },
                           discoverTeamFixture: [ROUND] },
};
globalThis.fetch = async (url, opts) => {
  const op = JSON.parse(opts.body).operationName;
  if (op === 'ProfileSearch') {
    return { ok: true, status: 200,
      headers: { get: k => (String(k).toLowerCase() === 'set-cookie' ? 'phq_session=stub; Path=/; HttpOnly' : null) },
      json: async () => ({ data: { profileSearch: { result: [] } } }) };
  }
  return { ok: true, status: 200, headers: { get: () => null },
           json: async () => ({ data: DATA[op] || {} }) };
};
`;

{
  const t = tree({ games: { games: {} } });
  fs.writeFileSync(path.join(t.root, 'stub-fetch.js'), FETCH_STUB);
  fs.writeFileSync(path.join(t.root, 'data', 'sports-index.json'), JSON.stringify({
    seasons: { SEASON1: { id: 'SEASON1', name: 'Summer 2026/27', fullName: 'Test BA Junior Domestic',
                          locked: false, grades: [{ id: 'GR1', name: 'U12 Boys A' }] } },
  }));
  const csFile = path.join(t.root, 'cs.json');
  const emit = spawnSync(process.execPath,
    ['--require', path.join(t.root, 'stub-fetch.js'),
     path.join(t.root, 'scripts', 'discover-fixtures.js'), '--current-only', `--emit=${csFile}`],
    { cwd: t.root, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PATH: `${path.join(t.root, 'stub')}:${process.env.PATH}`, DF_T_DIR: path.join(t.root, 'state') } });
  const eout = (emit.stdout || '') + (emit.stderr || '');
  eq(emit.status, 0, '0a the sweep exits 0', eout.slice(-300));
  ok(/changeset written/.test(eout), '0b a changeset was written');
  ok(!fs.existsSync(path.join(t.root, 'games', 'bv', 'SEASON1.json')), '0c and NOTHING was written to games/');
  const commitsFile = path.join(t.root, 'state', 'commits');
  const commits = () => { try { return fs.readFileSync(commitsFile, 'utf8'); } catch (_) { return ''; } };
  eq(commits(), '', '0d nothing was committed');

  const cs = JSON.parse(fs.readFileSync(csFile, 'utf8'));
  eq(cs.v, 1, '0e version');
  eq(cs.mode, 'active-current', '0f progress key from the mode flags');
  eq(cs.gameCount, 1, '0g one game entry');
  eq(cs.seasons.SEASON1.GX1.vn, 'Stub Stadium', '0h carrying what PlayHQ answered');
  eq(cs.seasons.SEASON1.GX1.t, '19:45', '0i time normalised');
  ok(!('hs' in cs.seasons.SEASON1.GX1), '0j and nothing it did not answer');
  eq(cs.venues.length, 1, '0k the venue/court pair travelled');
  eq(cs.completed, true, '0l the run completed');

  // Now the other half, against a checkout that has moved on since.
  fs.writeFileSync(path.join(t.root, 'games', 'bv', 'SEASON1.json'), JSON.stringify({ games: {
    GOTHER: { d: '2027-02-15', rn: 'Round 5', h: 'T8', hn: 'Hotel', a: 'T9', an: 'India', st: 'UPCOMING' },
  } }));
  const ap = spawnSync(process.execPath,
    [path.join(t.root, 'scripts', 'discover-fixtures.js'), '--current-only', `--apply=${csFile}`],
    { cwd: t.root, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PATH: `${path.join(t.root, 'stub')}:${process.env.PATH}`, DF_T_DIR: path.join(t.root, 'state') } });
  eq(ap.status, 0, '0m the apply exits 0', ((ap.stdout || '') + (ap.stderr || '')).slice(-300));
  const written = JSON.parse(fs.readFileSync(path.join(t.root, 'games', 'bv', 'SEASON1.json'), 'utf8')).games;
  eq(written.GX1.vn, 'Stub Stadium', '0n the swept game landed');
  ok(!!written.GOTHER, '0o and the game added to the checkout meanwhile survived');
  ok(fs.existsSync(path.join(t.root, 'venue-lookup', 'V7.json')), '0p the venue shard was written by the apply job');
  ok(commits().includes('Fixture discovery complete'), '0q and it committed');
}

// ── 0b · THE CHECKPOINT. A GitHub-hosted job is killed at 6 hours and the sweep has
// been taking 5h 50m-5h 55m, so emitting only at the end would hand over nothing when
// it overruns. The changeset is rewritten every --emit-every seasons, atomically.
{
  const t = tree({ games: { games: {} } });
  fs.writeFileSync(path.join(t.root, 'stub-fetch.js'), FETCH_STUB);
  fs.writeFileSync(path.join(t.root, 'data', 'sports-index.json'), JSON.stringify({
    seasons: { SEASON1: { id: 'SEASON1', name: 'Summer 2026/27', fullName: 'Test BA Junior Domestic',
                          locked: false, grades: [{ id: 'GR1', name: 'U12 Boys A' }] } },
  }));
  const csFile = path.join(t.root, 'cs.json');
  const r = spawnSync(process.execPath,
    ['--require', path.join(t.root, 'stub-fetch.js'),
     path.join(t.root, 'scripts', 'discover-fixtures.js'), '--current-only',
     '--emit-every=1', `--emit=${csFile}`],
    { cwd: t.root, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PATH: `${path.join(t.root, 'stub')}:${process.env.PATH}`, DF_T_DIR: path.join(t.root, 'state') } });
  const out = (r.stdout || '') + (r.stderr || '');
  eq(r.status, 0, '0r exit 0', out.slice(-300));
  ok(/changeset checkpointed/.test(out), '0s a checkpoint was written mid-sweep, before the end');
  ok(!fs.existsSync(`${csFile}.tmp`), '0t the write-then-rename left no .tmp behind');
  const cs = JSON.parse(fs.readFileSync(csFile, 'utf8'));
  eq(cs.completed, true, '0u the final write marks the run complete');
  eq(cs.gameCount, 1, '0v and carries the game');
  ok(/Fixture discovery complete/.test(cs.message), '0w with the completed message');
}

// 0c · A changeset left behind by a sweep that never finished is a PARTIAL one: it
//      applies, it saves the checkpoint rather than clearing it, and it says so.
{
  const t = tree({ games: { games: {} }, changeset: baseCS({
    completed: false, progressDone: ['s1', 's2', 's3'],
    message: 'Fixture discovery (PARTIAL - sweep did not finish): 140 seasons, 900 new games',
  }) });
  const r = apply(t);
  eq(r.code, 0, '0x a partial changeset applies');
  eq(r.commits, 'Fixture discovery (PARTIAL - sweep did not finish): 140 seasons, 900 new games',
     '0y and the commit message says the sweep did not finish');
  eq(JSON.stringify(JSON.parse(r.file('discover-fixtures-progress-active-current.json')).done),
     '["s1","s2","s3"]', '0z the checkpoint is saved so the next run resumes');
}

// 1 · The happy path, including a game another writer added after the sweep read it.
{
  const t = tree({ games: { games: {
    G1: { d: '2027-01-10', rn: 'Round 5', h: 'T1', hn: 'Alpha', a: 'T2', an: 'Beta', st: 'UPCOMING', p: ['p1'] },
    G9: { d: '2027-01-11', rn: 'Round 5', h: 'T3', hn: 'Gamma', a: 'T4', an: 'Delta', st: 'UPCOMING' },
  } }, changeset: baseCS(), progress: { mode: 'active-current', done: ['s0'] } });
  const r = apply(t);
  eq(r.code, 0, '1a exit 0', r.out.slice(-200));
  const g = r.season().games;
  eq(g.G1.vn, 'Eltham Stadium', '1b the changeset was applied');
  eq(JSON.stringify(g.G1.p), '["p1"]', '1c the roster on the row survived');
  ok(!!g.G9, '1d the game this checkout already had survived');
  ok(!!g.G2, '1e the changeset\'s new game was added');
  eq(r.commits, 'Fixture discovery complete: 300 seasons, 6,890 new games', '1f committed with the sweep\'s message');
  ok(r.pushed, '1g and pushed');
  ok(!r.exists('discover-fixtures-progress-active-current.json'), '1h completed:true clears the checkpoint');
  ok(/"id": "zz"/.test(r.file('zero-team-seasons.json') || ''), '1i zero-team written');
  ok(JSON.parse(r.file('venue-lookup/V1.json')).V1.courts.C1.name === 'Court 3', '1j venue shard written in THIS checkout');
}

// 2 · An incomplete sweep saves the checkpoint instead of clearing it.
{
  const t = tree({ games: { games: {} }, changeset: baseCS({ completed: false }) });
  const r = apply(t);
  eq(r.code, 0, '2a exit 0');
  const prog = JSON.parse(r.file('discover-fixtures-progress-active-current.json'));
  eq(JSON.stringify(prog.done), '["s1","s2"]', '2b the done set from the changeset');
  eq(prog.mode, 'active-current', '2c under the right key');
}

// 3 · THE REFUSAL THAT MATTERS. A changeset emitted under one progress key must not
//     be applied under another — it would save the wrong checkpoint and the next
//     weekly run would skip seasons nobody swept.
{
  const t = tree({ games: { games: { G1: { d: '2027-01-10', rn: 'Round 5' } } }, changeset: baseCS() });
  const before = r0 => r0;
  const r = apply(t, []);            // no --current-only, so MODE is 'active'
  ok(r.code !== 0, '3a refused');
  ok(/progress-key/.test(r.out), '3b and says why', r.out.split('\n').find(l => /Fatal/.test(l)));
  eq(r.commits, '', '3c nothing committed');
  eq(JSON.stringify(r.season().games.G1), '{"d":"2027-01-10","rn":"Round 5"}', '3d the season file is untouched');
}

// 4 · Wrong tenant, wrong version, unreadable, absent — all refuse, none commit.
{
  for (const [label, cs] of [
    ['4a wrong tenant',  baseCS({ tenant: 'afl' })],
    ['4b wrong version', baseCS({ v: 2 })],
    ['4c not json',      '{ nope'],
  ]) {
    const t = tree({ games: { games: {} }, changeset: cs });
    const r = apply(t);
    ok(r.code !== 0 && r.commits === '', label + ' refuses and commits nothing', `code ${r.code}`);
  }
  const t = tree({ games: { games: {} } });   // no changeset at all
  const r = apply(t);
  ok(r.code !== 0 && /no changeset at/.test(r.out), '4d an absent changeset refuses by name');
}

// 5 · The stale-grade worklist merges rather than replacing: a season this sweep did
//     not scan keeps whatever a previous run recorded.
{
  const t = tree({ games: { games: {} }, changeset: baseCS(), stale: { count: 2, seasons: [
    { id: SID, name: 'stale, will be replaced by this run', missing: 99 },
    { id: 'never-scanned', name: 'carried', missing: 3 },
  ] } });
  const r = apply(t);
  eq(r.code, 0, '5a exit 0');
  const st = JSON.parse(r.file('data/stale-grade-seasons.json'));
  eq(st.count, 2, '5b two entries');
  eq(st.carriedForward, 1, '5c one carried forward');
  eq(st.seasons.find(x => x.id === 'never-scanned').missing, 3, '5d the unscanned season kept its finding');
  eq(st.seasons.find(x => x.id === SID).missing, 1, '5e the scanned season took this run\'s');
  eq(st.scope, 'active, current only', '5f scope recorded');
}

// 6 · A sweep that left unreachable seasons commits FIRST, then fails the job.
{
  const t = tree({ games: { games: {} }, changeset: baseCS({ transient: ['s9', 's10'], completed: false }) });
  const r = apply(t);
  eq(r.code, 1, '6a the job goes red');
  ok(r.pushed, '6b but the work was pushed before it did');
  ok(/2 season\(s\) unreachable/.test(r.out), '6c and it says how many');
}

// 7 · A changeset whose season file does not exist yet creates it.
{
  const t = tree({ changeset: baseCS() });   // no games/bv file at all
  const r = apply(t);
  eq(r.code, 0, '7a exit 0');
  eq(Object.keys(r.season().games).sort().join(','), 'G1,G2', '7b both entries written');
}

// 8 · --dry-run with --apply validates and writes nothing.
{
  const t = tree({ games: { games: { G1: { d: '2027-01-10', rn: 'Round 5' } } }, changeset: baseCS() });
  const r = apply(t, ['--current-only', '--dry-run']);
  eq(r.code, 0, '8a exit 0');
  eq(r.commits, '', '8b nothing committed');
  eq(JSON.stringify(r.season().games.G1), '{"d":"2027-01-10","rn":"Round 5"}', '8c and nothing written');
}

// 9 · A played game on disk is still left as history when the changeset is replayed.
{
  const t = tree({ games: { games: {
    G1: { d: '2027-01-10', rn: 'Round 5', t: '17:00', st: 'FINAL', hs: 44, as: 39 },
  } }, changeset: baseCS() });
  const r = apply(t);
  const g = r.season().games.G1;
  eq(g.t, '17:00', '9a the as-played time stands');
  eq(g.hs, 44, '9b and the score');
  ok(/became played since they were read/.test(r.out), '9c and the run says so');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
