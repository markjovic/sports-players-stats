// scripts/verify-backfill.js
//
// Verifies scripts/backfill.js and scripts/fetch-results.js by EXECUTING them,
// with only the network stubbed. storage_ingestion_design.md §6.1.
//
// It copies the real backfill.js, fetch-results.js, lib/results-engine.js and
// lib/store.js into a temporary tree, stubs lib/playhq.js with canned GraphQL
// responses, and runs each script as a child process. Everything except the
// network is the committed code, so this tests what actually runs rather than a
// reimplementation of it. The repository's own data/ and config.json are never
// opened.
//
// Covers the success path and the failure paths. Every guard is deliberately
// tripped: a live season, a season with compName null, an unknown organisation,
// an unknown season, and phase B.
//
// Run: node scripts/verify-backfill.js     Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'verify-backfill v1 2026-08-12';
console.log(`=== ${VERSION} ===`);

const SCRIPTS = __dirname;
for (const f of ['backfill.js', 'fetch-results.js', 'lib/results-engine.js', 'lib/store.js']) {
  if (!fs.existsSync(path.join(SCRIPTS, f))) {
    console.error(`FATAL: scripts/${f} not found. Run from the repository root.`);
    process.exit(1);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-verify-'));
const ORGS = path.join(TMP, 'data', 'orgs');
const CORE = path.join(TMP, 'data', 'core.json');
const GRADES = path.join(TMP, 'data', 'grades.json');
const EFNL_CUR = path.join(ORGS, '383836bb-current.json');
const EFNL_ARC = path.join(ORGS, '383836bb-archive.json');
const YJFL_CUR = path.join(ORGS, '4f9a099e-current.json');

fs.mkdirSync(path.join(TMP, 'scripts', 'lib'), { recursive: true });
for (const f of ['backfill.js', 'fetch-results.js']) {
  fs.copyFileSync(path.join(SCRIPTS, f), path.join(TMP, 'scripts', f));
}
for (const f of ['results-engine.js', 'store.js']) {
  fs.copyFileSync(path.join(SCRIPTS, 'lib', f), path.join(TMP, 'scripts', 'lib', f));
}

// ── The stub. Only the network. ──────────────────────────────────────────────
// Two seasons of one grade. 2025 is completed and its dates are in the past, so
// it exercises the season-ended bypass; 2026 is current and would pass the guard
// anyway. Round 1 of each has two final games.
fs.writeFileSync(path.join(TMP, 'scripts', 'lib', 'playhq.js'), `
'use strict';
const SEASONS = {
  '75d8a232': { year: '2025', gradeId: '1debae74', dates: ['2025-04','2025-08'], current: false },
  'ca9cc98b': { year: '2024', gradeId: '25a4f589', dates: ['2024-04','2024-08'], current: false },
  '2dcbf383': { year: '2026', gradeId: '6f964e7b', dates: ['2026-04','2026-08'], current: true  },
  'cda2f0ec': { year: '2026', gradeId: '9a9a9a9a', dates: ['2026-04','2026-08'], current: true  },
};
const byGrade = {};
for (const [sid, s] of Object.entries(SEASONS)) byGrade[s.gradeId] = { sid, ...s };

function logo(code) {
  return { sizes: [{ url: 'https://x/production/afl/' + code + '-1111-2222-3333-444455556666/logo.png',
                     dimensions: { width: 64, height: 64 } }] };
}
function team(name, code) { return { id: name, name, logo: logo(code) }; }
function stats(g, b, s) {
  return { statistics: [ { count: g, type: { value: 'TOTAL_GOALS' } },
                         { count: b, type: { value: 'TOTAL_BEHINDS' } },
                         { count: s, type: { value: 'TOTAL_SCORE' } } ] };
}

async function gqlPost(query, vars) {
  if (query.includes('gradeListDiscoverSeason')) {
    const s = SEASONS[vars.id];
    if (!s) throw new Error('stub: unknown seasonID ' + vars.id);
    return { data: { discoverSeason: { id: vars.id, name: s.year,
      competition: { organisation: { name: 'EFNL', logo: logo('383836bb') } },
      grades: [{ id: s.gradeId, name: 'U12 Mixed A', age: { name: 'U12', value: 'U12' },
                 gender: { name: 'Mixed', value: 'MIXED' } }] } } };
  }
  if (query.includes('gradeRounds')) {
    const g = byGrade[vars.gradeID];
    if (!g) throw new Error('stub: unknown gradeID ' + vars.gradeID);
    // Lets a test drive a mid-loop failure without touching the real code.
    if (process.env.STUB_FAIL_SEASON && process.env.STUB_FAIL_SEASON === g.sid) {
      throw new Error('stub: forced failure for season ' + g.sid);
    }
    return { data: { discoverGrade: { id: vars.gradeID, name: 'U12 Mixed A', dates: g.dates,
      rounds: [{ id: 'r1-' + g.gradeId, name: 'Round 1', abbreviatedName: null, number: '1',
                 current: g.current, isFinalsRound: false, provisionalDates: [] }] } } };
  }
  if (query.includes('discoverFixtureByRound')) {
    return { data: { discoverFixtureByRound: { games: [
      { id: 'g1', home: team('Blackburn U12', '383836bb'), away: team('Norwood U12', 'aaaa1111'),
        result: { home: stats(10, 5, 65), away: stats(8, 3, 51) },
        status: { value: 'FINAL' }, date: '2025-04-05',
        allocation: { court: { venue: { name: 'Morton Park', suburb: 'Blackburn',
          state: 'VIC', latitude: -37.8, longitude: 145.1 } } } },
      { id: 'g2', home: team('Vermont U12', 'bbbb2222'), away: team('Mitcham U12', 'cccc3333'),
        result: { home: stats(12, 6, 78), away: stats(4, 2, 26) },
        status: { value: 'FINAL' }, date: '2025-04-05',
        allocation: { court: { venue: { name: 'Vermont Reserve', suburb: 'Vermont',
          state: 'VIC', latitude: -37.8, longitude: 145.2 } } } },
    ] } } };
  }
  throw new Error('stub: unexpected query');
}
module.exports = {
  gqlPost,
  refreshSession: async () => {},
  sleep: async () => {},
  logSummary: () => {},
};
`);

const MANIFEST = () => ([
  { org: '383836bb', orgName: 'EFNL', seasonId: '2dcbf383', seasonName: '2026',
    compName: 'EFNL 2026', status: 'ACTIVE', retired: false, endDate: '2026-09-30',
    file: 'data/orgs/383836bb-current.json', phases: { results: false, players: false } },
  { org: '383836bb', orgName: 'EFNL', seasonId: '75d8a232', seasonName: '2025',
    compName: 'EFNL 2025', status: 'COMPLETED', retired: true, endDate: '2025-09-30',
    file: 'data/orgs/383836bb-archive.json', phases: { results: false, players: false } },
  { org: '383836bb', orgName: 'EFNL', seasonId: 'ca9cc98b', seasonName: '2024',
    compName: 'EFNL 2024', status: 'COMPLETED', retired: true, endDate: '2024-10-13',
    file: 'data/orgs/383836bb-archive.json', phases: { results: false, players: false } },
  { org: '4f9a099e', orgName: 'YJFL', seasonId: 'cda2f0ec', seasonName: '2026',
    compName: 'YJFL 2026', status: 'ACTIVE', retired: false, endDate: '2026-09-30',
    file: 'data/orgs/4f9a099e-current.json', phases: { results: false, players: false } },
  { org: '0f20da4f', orgName: 'Unnamed org', seasonId: 'ffff9999', seasonName: '2024',
    compName: null, status: 'COMPLETED', retired: true, endDate: '2024-09-30',
    file: 'data/orgs/0f20da4f-archive.json', phases: { results: false, players: false } },
]);

function reset(manifest) {
  fs.rmSync(path.join(TMP, 'data'), { recursive: true, force: true });
  fs.mkdirSync(ORGS, { recursive: true });
  fs.writeFileSync(CORE, JSON.stringify({
    manifest: manifest || MANIFEST(),
    clubs: {}, teamClub: {}, teamOrg: {},
    // Two competitions' worth of each collision-prone core key, so a scoped run
    // that replaces rather than merges is visible.
    compLogos: { 'EFNL 2026': 'http://x/efnl.png', 'YJFL 2026': 'http://x/yjfl.png' },
    lastRound: { 'U12|A': 14, 'U14|B': 16 },
    teamLogos: { 'Ivanhoe': 'http://x/iv.png' },
  }, null, 2));
  fs.writeFileSync(CONFIG(), JSON.stringify({
    competitions: [
      { name: 'EFNL 2026', seasonID: '2dcbf383', vip: true,  excludeGrades: [] },
      { name: 'YJFL 2026', seasonID: 'cda2f0ec', vip: false, excludeGrades: [] },
    ],
    organisationCodes: ['383836bb', '4f9a099e'],
  }, null, 2));
  fs.writeFileSync(EFNL_CUR, JSON.stringify({
    meta: { org: '383836bb', kind: 'current', seasons: ['2dcbf383'] },
    matches: [], players: [], roster: {}, gradeMeta: {},
  }));
  fs.writeFileSync(YJFL_CUR, JSON.stringify({
    meta: { org: '4f9a099e', kind: 'current', seasons: ['cda2f0ec'] },
    matches: [{ id: 'YJFL 2026|U14|B|16|Ivanhoe|Kew', compName: 'YJFL 2026',
                age: 'U14', rawGrade: 'B', round: 16 }],
    players: [], roster: { 'YJFL 2026|Ivanhoe|U14': { grade: 'B' } },
    gradeMeta: { 'YJFL 2026|U14|B': { r: 1 } },
  }));
}
const CONFIG = () => path.join(TMP, 'config.json');

function run(script, env) {
  const r = spawnSync(process.execPath, [`scripts/${script}`], {
    cwd: TMP, encoding: 'utf8', env: { ...process.env, ...env },
  });
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── 1. The backfill writes a completed season into the archive ───────────────
console.log('\n1  Backfilling EFNL 2025 creates the archive');
reset();
let r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: '2025' });
ok('exit 0 (changed)', r.code === 0, `exit ${r.code}`);
ok('version line printed', /backfill v2 2026-08-12/.test(r.out));
ok('season-ended guard reported as bypassed', /season-ended guard BYPASSED/.test(r.out));
ok('the completed season was fetched anyway',
  /fetching anyway \(backfill\)/.test(r.out), 'the guard would have skipped it');
ok('archive created', fs.existsSync(EFNL_ARC));
const arc = fs.existsSync(EFNL_ARC) ? read(EFNL_ARC) : { matches: [], meta: {} };
ok('archive holds the 2025 matches',
  arc.matches.length === 2 && arc.matches.every(m => m.compName === 'EFNL 2025'),
  `${arc.matches.length} matches`);
ok('match id carries the right compName',
  (arc.matches[0] || {}).id && arc.matches[0].id.startsWith('EFNL 2025|U12|A|1|'),
  (arc.matches[0] || {}).id);
ok('archive carries a 2025 roster', Object.keys(arc.roster || {}).some(k => k.startsWith('EFNL 2025|')));
ok('archive carries 2025 gradeMeta', !!(arc.gradeMeta || {})['EFNL 2025|U12|A']);
ok('per-season completeness recorded',
  (arc.meta.phases || {})['75d8a232'] && arc.meta.phases['75d8a232'].results === true &&
  arc.meta.phases['75d8a232'].players === false,
  JSON.stringify((arc.meta.phases || {})['75d8a232']));

// ── 2. It did not damage anything outside its scope ──────────────────────────
console.log('\n2  Nothing outside the backfilled season was touched');
const core1 = read(CORE);
ok('YJFL file still has its match', read(YJFL_CUR).matches.length === 1);
ok('lastRound NOT written — 2026 value intact',
  core1.lastRound['U12|A'] === 14, JSON.stringify(core1.lastRound));
ok("lastRound kept YJFL's entry", core1.lastRound['U14|B'] === 16);
ok('compLogos kept both competitions',
  Object.keys(core1.compLogos).length >= 2, JSON.stringify(Object.keys(core1.compLogos)));
ok('grades.json holds the 2025 grades',
  fs.existsSync(GRADES) && read(GRADES).some(g => g.seasonID === '75d8a232'));

// ── 3. Idempotency ───────────────────────────────────────────────────────────
console.log('\n3  Re-running the same backfill duplicates nothing');
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: '2025' });
ok('exit 2 (no change)', r.code === 2, `exit ${r.code}`);
ok('still 2 matches, not 4', read(EFNL_ARC).matches.length === 2,
  `${read(EFNL_ARC).matches.length} matches`);

// ── 4. The scheduled run still works, and keeps its guard ────────────────────
console.log('\n4  fetch-results.js is unchanged in behaviour');
reset();
r = run('fetch-results.js', { VIP_ONLY: 'true' });
ok('exit 0', r.code === 0, `exit ${r.code}`);
ok('engine version printed', /engine v1 2026-08-12/.test(r.out));
ok('season-ended guard NOT bypassed', !/season-ended guard BYPASSED/.test(r.out));
ok('2026 matches written to current', read(EFNL_CUR).matches.length === 2,
  `${read(EFNL_CUR).matches.length} matches`);
const core4 = read(CORE);
// A VIP-only run cannot see the other competitions, and lastRound's key has no
// competition in it, so it leaves the map alone. It used to rebuild it from
// EFNL alone and delete every key EFNL did not have.
ok('VIP-only run leaves lastRound untouched',
  core4.lastRound['U12|A'] === 14 && core4.lastRound['U14|B'] === 16,
  JSON.stringify(core4.lastRound));
ok('compLogos MERGED — YJFL entry survived a VIP-only run',
  core4.compLogos['YJFL 2026'] === 'http://x/yjfl.png', 'this is the second fix');

// ── 4a. A full run rebuilds lastRound, and must not ratchet ─────────────────
console.log('\n4a  A full run rebuilds lastRound from every competition');
reset();
r = run('fetch-results.js', {});   // no VIP_ONLY — covers both competitions
ok('exit 0', r.code === 0, `exit ${r.code}`);
const core4a = read(CORE);
ok('lastRound rebuilt from this season, not ratcheted up',
  core4a.lastRound['U12|A'] === 1,
  `${JSON.stringify(core4a.lastRound)} — 14 here would mean a stale value survived`);
ok('the other competition is present, not deleted',
  core4a.lastRound['U14|B'] === 16, JSON.stringify(core4a.lastRound));
ok('both competitions were fetched', /2 competition-season\(s\)/.test(r.out));

// ── 5. Failure path: a live season ───────────────────────────────────────────
console.log('\n5  Guards must refuse rather than produce something wrong');
reset();
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: '2026' });
ok('refuses a live season', r.code === 1 && /not retired/.test(r.out), `exit ${r.code}`);
ok('wrote no archive', !fs.existsSync(EFNL_ARC));

// ── 6. Failure path: compName is null ────────────────────────────────────────
reset();
r = run('backfill.js', { BACKFILL_ORG: '0f20da4f', BACKFILL_SEASON: '2024' });
ok('refuses a season with compName null', r.code === 1 && /compName: null/.test(r.out),
  `exit ${r.code}`);
ok('wrote no file for it', !fs.existsSync(path.join(ORGS, '0f20da4f-archive.json')));

// ── 7. Failure paths: bad inputs ─────────────────────────────────────────────
reset();
r = run('backfill.js', { BACKFILL_ORG: 'deadbeef', BACKFILL_SEASON: '2025' });
ok('refuses an unknown organisation', r.code === 1 && /no manifest entries/.test(r.out));
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: '1999' });
ok('refuses an unknown season', r.code === 1 && /no season named/.test(r.out));
r = run('backfill.js', { BACKFILL_ORG: 'nope', BACKFILL_SEASON: '2025' });
ok('refuses a malformed organisation code', r.code === 1 && /8-character/.test(r.out));
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: '2025', BACKFILL_PHASE: 'B' });
ok('refuses phase B', r.code === 1 && /not implemented/.test(r.out));

// ── 8. Dry run ───────────────────────────────────────────────────────────────
console.log('\n6  Dry run resolves and stops');
reset();
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: '2025', BACKFILL_DRY_RUN: 'true' });
ok('exit 2', r.code === 2, `exit ${r.code}`);
ok('reported the season it would fetch', /EFNL 2025/.test(r.out));
ok('wrote nothing', !fs.existsSync(EFNL_ARC));

// ── 8. season: all ───────────────────────────────────────────────────────────
console.log('\n8  season "all" does every RETIRED season and skips the live one');
reset();
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: 'all',
                         BACKFILL_SEASON_DELAY_MIN: '0' });
ok('exit 0', r.code === 0, `exit ${r.code}`);
ok('two seasons attempted, not three', /season 1\/2/.test(r.out) && /season 2\/2/.test(r.out),
  'the ACTIVE 2026 season must be excluded');
ok('oldest first', r.out.indexOf('season 1/2: EFNL 2024') < r.out.indexOf('season 2/2: EFNL 2025'));
const arcAll = read(EFNL_ARC);
ok('archive holds both seasons',
  arcAll.meta.seasons.length === 2, JSON.stringify(arcAll.meta.seasons));
ok('both seasons have completeness recorded',
  arcAll.meta.phases['75d8a232'].results === true && arcAll.meta.phases['ca9cc98b'].results === true);
ok('the live season file is untouched — backfill never fetches it',
  read(EFNL_CUR).matches.length === 0, `${read(EFNL_CUR).matches.length} matches`);
ok('no archived record leaked into current',
  !read(EFNL_CUR).matches.some(m => String(m.compName).match(/202[45]/)));
ok('lastRound still untouched', read(CORE).lastRound['U12|A'] === 14);

// ── 8a. A failure part-way through stops and keeps what was written ──────────
console.log('\n8a  A season failing mid-loop stops, and earlier seasons survive');
reset();
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: 'all',
                         BACKFILL_SEASON_DELAY_MIN: '0', STUB_FAIL_SEASON: '75d8a232' });
ok('exit 1', r.code === 1, `exit ${r.code}`);
ok('named the season that failed', /in EFNL 2025/.test(r.out));
ok('reported what is already safe', /Already written and safe: EFNL 2024/.test(r.out));
ok('the earlier season IS on disk',
  fs.existsSync(EFNL_ARC) && read(EFNL_ARC).matches.some(m => m.compName === 'EFNL 2024'));
ok('the failed season is NOT on disk',
  !read(EFNL_ARC).matches.some(m => m.compName === 'EFNL 2025'));

// ── 9. Could these have failed? ──────────────────────────────────────────────
// A suite that passes against an empty fixture proves nothing. Assert the
// fixture really contains what the tests claim to check.
console.log('\n7  The fixture is real');
reset();
ok('core seeded with two compLogos', Object.keys(read(CORE).compLogos).length === 2);
ok('core seeded with two lastRound keys', Object.keys(read(CORE).lastRound).length === 2);
ok('EFNL current starts empty', read(EFNL_CUR).matches.length === 0);
ok('archive genuinely absent', !fs.existsSync(EFNL_ARC));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
