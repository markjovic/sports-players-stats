// scripts/test/harness.js
//
// THE REGRESSION HARNESS. Runs scripts/fixture-watch.js UNMODIFIED, in a throwaway
// git repo with a throwaway bare remote, against a faked PlayHQ and a faked
// Pushover (scripts/test/mock-playhq.cjs, preloaded with --require).
//
// ⚠️ `node --check` IS NOT A TEST. It proves syntax and nothing else — it did not
// catch a constant copied without its definition (TERMINAL, 2026-11-24). Every
// scenario here actually executes the watcher end to end, including the real git
// commit and push, and asserts on what came out: the Pushover messages, the state
// files on disk and the process exit code.
//
// USAGE
//   node scripts/test/harness.js [name-fragment ...]
//
// The basketball watcher is LIVE and alerting on Mark's phone. A footy regression
// there is worse than footy arriving late, so every pre-footy scenario is kept
// here unchanged and is expected to behave exactly as it did before the sports
// block existed.

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const links = require('../lib/team-links.cjs');
const nbw   = require('../lib/netball-watch.cjs');

const REPO  = path.join(__dirname, '..', '..');
const ONLY  = process.argv.slice(2);
const DAY   = 86400000;
const isoD  = (ms) => new Date(ms).toISOString().slice(0, 10);
const FUT1  = isoD(Date.now() + 30 * DAY);
const FUT2  = isoD(Date.now() + 37 * DAY);
const PAST  = isoD(Date.now() - 30 * DAY);
const TODAY = isoD(Date.now());

const UUID  = '0afc7690-c2db-4644-b039-af1c34520af3';
const BB    = 'basketball-victoria';
const AFL   = 'afl';
const FOOTY_BASE = 'https://markjovic.github.io/junior-footy-dashboard/index.html';
const ST_BASE    = 'https://markjovic.github.io/stattrack/';

let passed = 0, failed = 0;
const problems = [];
function check(scenario, label, ok, detail) {
  if (ok) { passed++; return; }
  failed++;
  problems.push(`${scenario} › ${label}${detail ? `\n      ${detail}` : ''}`);
}

// ─── Config used by every scenario ───────────────────────────────────────────
function cfgFor(sports) {
  return {
    sports,
    tenant: BB, sport: 'basketball', stattrackBase: ST_BASE,
    players: [{ uuid: UUID, name: 'Toby', sports: Object.keys(sports), pinnedTeams: {} }],
    completeFixtureSlotsEvery: 4,
    gradeRoundsRefreshHours: 12,
    activeChangeWindowDays: 7,
    stopAfterSeasonEndDays: 21,
    failureAlertCooldownHours: 6,
    maxAlertChars: 1000,
  };
}
const PUB = { enabled: true, repo: 'markjovic/sports-players-stats', workflow: 'publish-final-game.yml', ref: 'main', maxRoundsPerPass: 6 };
const SPORT_BB = { basketball: { label: 'Basketball', tenant: BB, link: { kind: 'stattrack', base: ST_BASE, urlTitle: 'Open in StatTrack' } } };
const SPORT_FOOTY = {
  label: 'Footy', tenant: AFL,
  link: { kind: 'footy-dashboard', base: FOOTY_BASE, urlTitle: 'Open in the footy dashboard' },
  orgShortCodes: { '383836bb': 'EFNL', '4c8b472e': 'WFNL', '1cf85e52': 'SEJ', '0f20da4f': 'SER', '4f9a099e': 'YJFL' },
};

// ─── PlayHQ response builders ────────────────────────────────────────────────
function pteam(o) {
  return {
    id: o.id, name: o.name,
    organisation: { id: o.clubId || 'club-1', name: o.club || 'Spirit' },
    grade: o.gradeId ? { id: o.gradeId, name: o.gradeName } : null,
    season: {
      id: o.sid || 'season-1', name: o.seasonName || '2026',
      startDate: o.startDate || '2026-01-01', endDate: o.endDate === undefined ? null : o.endDate,
      status: { name: 'In progress', value: o.seasonStatus || 'IN_PROGRESS' },
      competition: { id: 'comp-1', name: o.comp || 'Winter 2026', organisation: { id: o.orgId || 'assoc-1', name: o.assoc || 'Association' } },
    },
  };
}
function game(o) {
  return {
    id: o.id, dates: [o.date], status: { value: o.status || 'SCHEDULED' },
    home: { id: o.homeId, name: o.homeName },
    away: { id: o.awayId, name: o.awayName },
    result: null,
    allocation: { dateTimeList: [{ date: o.date, time: o.time || '09:00:00' }], court: { id: 'crt-1', name: o.court || 'Court 1', venue: { id: 'ven-1', name: o.venue || 'Stadium' } } },
  };
}
function round(o) {
  return {
    id: o.id, name: o.name, isFinalsRound: !!o.finals,
    grade: { id: o.gradeId, name: o.gradeName || 'Grade', season: { id: 'season-1', name: '2026', competition: { id: 'comp-1', name: 'Winter 2026', organisation: { id: 'assoc-1', name: 'Association' } } } },
    fixture: { games: o.games || [] },
  };
}
function fixtureData(o) {
  return {
    discoverTeam: {
      id: o.tid,
      grade: o.gradeId ? { id: o.gradeId, name: o.gradeName } : null,
      season: { id: o.sid || 'season-1', name: o.seasonName || '2026', competition: { id: 'comp-1', name: 'Winter 2026', organisation: { id: o.orgId || 'assoc-1', name: o.assoc || 'Association' } }, status: { value: 'IN_PROGRESS' } },
      organisation: { id: 'club-1', name: o.club || 'Spirit' },
    },
    discoverTeamFixture: o.rounds || [],
  };
}
function gradeData(o) {
  return { discoverGrade: { id: o.gid, name: o.name || 'Grade', hideScores: false, rounds: o.rounds, season: { id: 'season-1', competition: { id: 'comp-1', organisation: { id: 'assoc-1', name: 'Association' } } } } };
}
const roundList = (n, currentIdx) => Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, name: `Round ${i + 1}`, abbreviatedName: `R${i + 1}`, number: i + 1, current: i === currentIdx, isFinalsRound: false }));

// A normalised game, as normaliseGames() would have stored it. Used to prefill state.
function ng(o) {
  return { d: o.d, t: o.t || '09:00', v: o.v || 'Stadium', c: o.c || 'Court 1', opp: o.opp || 'Rivals', oppId: o.oppId || 'opp-1', home: o.home === undefined ? true : o.home, st: o.st || 'SCHEDULED', gid: o.gid || 'grade-1', gn: o.gn || 'Grade', rn: o.rn || 'Round 1', finals: false };
}
function teamState(o) {
  return {
    tid: o.tid,
    reg: { tid: o.tid, sport: o.sport || 'basketball', name: o.name, club: 'Spirit', sid: 'season-1', seasonName: '2026', seasonStatus: 'IN_PROGRESS', endDate: o.endDate === undefined ? null : o.endDate, comp: 'Winter 2026', assoc: 'Association', assocId: o.orgId || 'assoc-1', currentGid: o.gid || 'grade-1', currentGrade: o.gradeName || 'Grade' },
    players: [UUID],
    games: o.games || {},
    rounds: null,
    coverage: o.coverage === undefined ? { gid: o.gid || 'grade-1', complete: false, covered: 1, nonFinalsRounds: 3, fromRound: 1, missing: ['Round 2'], lastGameDate: o.lastGameDate || FUT1, finalsRoundsInGrade: 0, checkedAt: new Date().toISOString() } : o.coverage,
    firstSeenAt: new Date(Date.now() - 60 * DAY).toISOString(),
    lastChangeAt: new Date(Date.now() - 60 * DAY).toISOString(),
    lastCheckedAt: new Date(Date.now() - DAY).toISOString(),
  };
}

// ─── Running one scenario ────────────────────────────────────────────────────
function run(spec) {
  const dir    = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-harness-'));
  const repo   = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { stdio: 'pipe' });
  fs.cpSync(path.join(REPO, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'watch.json'), JSON.stringify(spec.cfg, null, 2) + '\n');
  fs.mkdirSync(path.join(repo, 'state'), { recursive: true });
  for (const [name, obj] of Object.entries(spec.state || {})) {
    fs.writeFileSync(path.join(repo, 'state', name), JSON.stringify(obj, null, 2) + '\n');
  }
  const g = (a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'harness@local']);
  g(['config', 'user.name', 'harness']);
  g(['add', '-A']); g(['commit', '-q', '-m', 'init']);
  g(['remote', 'add', 'origin', remote]); g(['push', '-q', 'origin', 'main']);

  const scenFile = path.join(dir, 'scenario.json');
  const logFile  = path.join(dir, 'calls.json');
  fs.writeFileSync(scenFile, JSON.stringify(spec.net, null, 2));
  fs.writeFileSync(logFile, '[]');

  const r = spawnSync(process.execPath, ['scripts/fixture-watch.js', '--force', '--delay=0'], {
    cwd: repo, encoding: 'utf8', timeout: 180000,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${path.join(REPO, 'scripts', 'test', 'mock-playhq.cjs')}`,
      FW_SCENARIO: scenFile, FW_CALLLOG: logFile, FW_FAST_SLEEP: '1',
      PUSHOVER_TOKEN: 'harness-token', PUSHOVER_USER: 'harness-user',
      STATTRACK_DISPATCH_TOKEN: 'harness-pat',
      ...(spec.env || {}),
    },
  });

  const calls = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  const ctx = {
    code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', calls,
    pushes: calls.filter(c => c.kind === 'pushover'),
    sessions: calls.filter(c => c.kind === 'session'),
    dispatches: calls.filter(c => c.kind === 'dispatch'),
    nc: calls.filter(c => c.kind === 'nc'),
    authed: calls.filter(c => c.kind === 'profile' || c.kind === 'fixture' || c.kind === 'grade'),
    repo,
    stateExists: (f) => fs.existsSync(path.join(repo, 'state', f)),
    stateOf: (f) => { const p = path.join(repo, 'state', f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; },
    titles: () => calls.filter(c => c.kind === 'pushover').map(c => c.title),
  };
  try { spec.assert(ctx, (label, ok, detail) => check(spec.name, label, ok, detail)); }
  catch (err) { check(spec.name, 'assertions threw', false, `${err.message}\n--- stdout ---\n${ctx.stdout.slice(-2500)}\n--- stderr ---\n${ctx.stderr.slice(-1500)}`); }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
//  UNIT TESTS — the footy link builder, against the MEASURED data
// ═══════════════════════════════════════════════════════════════════════════
function unitTests() {
  const S = 'unit \u00b7 footy link';
  const sp = { link: { kind: 'footy-dashboard', base: FOOTY_BASE }, orgShortCodes: SPORT_FOOTY.orgShortCodes };
  const u = (o) => links.teamUrlFor(sp, o);
  const EFNL = '383836bb-1111-2222-3333-444455556666';
  const TID  = 'e2b94c0a-aaaa-bbbb-cccc-ddddeeeeffff';
  // The measured registration: Norwood U12 Purple, grade U12 - B, EFNL, 2026.
  const reg = { tid: TID, hasPlayedGame: true, teamName: 'Norwood U12 Purple', gradeName: 'U12 - B', seasonName: '2026', orgId: EFNL };
  const with_ = (over) => u({ ...reg, ...over });

  check(S, 'the id-keyed link, exactly',
    with_({}) === `${FOOTY_BASE}#y=2026&c=EFNL&a=U12&t=${TID}`, String(with_({})));

  // ⚠️ The dashboard holds a record only for a game marked FINAL, so a team with
  // none cannot be resolved by ANY key. Both pre-season alerts land here.
  check(S, 'no played game means NO link', with_({ hasPlayedGame: false }) === null);
  check(S, 'an absent hasPlayedGame means NO link — it must be opted into',
    u({ tid: TID, teamName: 'Norwood U12 Purple', gradeName: 'U12 - B', seasonName: '2026', orgId: EFNL }) === null);

  check(S, 'no team id means NO link', with_({ tid: null }) === null);
  check(S, 'an unmapped org means NO link', with_({ orgId: '11112222-aaaa' }) === null);
  check(S, 'no age anywhere means NO link', with_({ teamName: 'Norwood Seniors', gradeName: 'Senior Men Division 1' }) === null);
  check(S, 'a non-year season name means NO link', with_({ seasonName: '2026/27' }) === null);
  check(S, 'no org id means NO link', with_({ orgId: null }) === null);

  // `a` is STILL derived here — the id swap removed cleanTeam, not the age.
  check(S, 'grade null falls back to the team-name age token',
    with_({ gradeName: null, teamName: 'Lilydale U13', seasonName: '2027' })
      === `${FOOTY_BASE}#y=2027&c=EFNL&a=U13&t=${TID}`, String(with_({ gradeName: null, teamName: 'Lilydale U13', seasonName: '2027' })));
  check(S, 'a girls grade carries the Girls suffix in `a`',
    with_({ gradeName: 'U12 Girls - B', teamName: 'Norwood U12 Girls Blue' })
      === `${FOOTY_BASE}#y=2026&c=EFNL&a=U12%20Girls&t=${TID}`);
  check(S, 'U17.5 is read from the grade name, not an ageName',
    with_({ gradeName: 'U17.5 Boys A', teamName: 'Mt Eliza JFC U17 Boys Red' })
      === `${FOOTY_BASE}#y=2026&c=EFNL&a=U17.5&t=${TID}`);

  check(S, 'the short code matches on the full uuid too',
    links.shortCodeFor('4c8b472e', SPORT_FOOTY.orgShortCodes) === 'WFNL' &&
    links.shortCodeFor('4c8b472e-0000-0000-0000-000000000000', SPORT_FOOTY.orgShortCodes) === 'WFNL');

  // cleanTeam is retained but NOT wired into the link. These pin the old name form
  // so reverting is one line if the id format ever has to be abandoned, and they
  // keep the U17.5 trap on the record.
  check(S, 'cleanTeam still produces the old name form', links.cleanTeam('Norwood U12 Purple', 'U12') === 'Norwood Purple');
  check(S, 'cleanTeam still refuses to strip U17 for a U17.5 grade', links.cleanTeam('Mt Eliza JFC U17 Boys Red', 'U17.5') === 'Mt Eliza JFC U17 Boys Red');
  check(S, 'and cleanTeam is NOT in the link any more', !with_({}).includes('Norwood'));

  check(S, 'the basketball link is unchanged',
    links.teamUrlFor(SPORT_BB.basketball, { tid: 'T1', sid: 'S1' }) === `${ST_BASE}#t=T1&s=S1`);
  check(S, 'a basketball link with no season id is omitted',
    links.teamUrlFor(SPORT_BB.basketball, { tid: 'T1', sid: null }) === null);
  check(S, 'basketball ignores hasPlayedGame entirely',
    links.teamUrlFor(SPORT_BB.basketball, { tid: 'T1', sid: 'S1', hasPlayedGame: false }) === `${ST_BASE}#t=T1&s=S1`);
  check(S, 'an unknown link kind is omitted, not thrown',
    links.teamUrlFor({ link: { kind: 'something-new' } }, { tid: 'T1', sid: 'S1' }) === null);
}

// ═══════════════════════════════════════════════════════════════════════════
//  SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════
const T1 = 'team-1', T2 = 'team-2', FT = 'footy-team-1';
const G1 = 'grade-1', G2 = 'grade-2', FG = 'footy-grade-1';

const bbProfileOneTeam = {
  [UUID]: { data: { publicProfileTeams: [pteam({ id: T1, name: 'Spirit Magic 3', gradeId: G1, gradeName: 'B13 - 1' })] } },
};
const bbFixtureTwoGames = {
  [T1]: { data: fixtureData({ tid: T1, gradeId: G1, gradeName: 'B13 - 1', rounds: [
    round({ id: 'r1', name: 'Round 1', gradeId: G1, gradeName: 'B13 - 1', games: [game({ id: 'g1', date: FUT1, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] }),
    round({ id: 'r2', name: 'Round 2', gradeId: G1, gradeName: 'B13 - 1', games: [game({ id: 'g2', date: FUT2, time: '11:00:00', homeId: 'opp-2', homeName: 'Others', awayId: T1, awayName: 'Spirit Magic 3' })] }),
    round({ id: 'r3', name: 'Round 3', gradeId: G1, gradeName: 'B13 - 1', games: [] }),
  ] }) },
};
const bbGrade3Rounds = { [G1]: { data: gradeData({ gid: G1, name: 'B13 - 1', rounds: roundList(3, 0) }) } };

// ═══════════════════════════════════════════════════════════════════════════
//  FAST PUBLISH ON FINAL — deleted by a wholesale rewrite 2026-11-24,
//  restored 2026-11-27. These exist so it cannot be lost silently again.
// ═══════════════════════════════════════════════════════════════════════════
const BB_PUB = { basketball: { ...SPORT_BB.basketball, publishOnFinal: PUB } };
const finalFlipState = () => ({ [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, lastGameDate: TODAY, games: {
  g1: ng({ d: TODAY, st: 'SCHEDULED', rn: 'Round 7', gid: G1 }),
} }) });
const finalFlipFixture = (rounds) => ({ [T1]: { data: fixtureData({ tid: T1, gradeId: G1, gradeName: 'B13 - 1', rounds }) } });
const roundWith = (id, name, gs) => round({ id, name, gradeId: G1, gradeName: 'B13 - 1', games: gs });
const finalGame = (id, date) => game({ id, date, status: 'FINAL', homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' });

// ═══════════════════════════════════════════════════════════════════════════
//  NETBALL CONNECT — a third SOURCE. Spec acceptance tests 1-14.
//  The model under test: first sighting alerts, then it is a known data point
//  and never alerts again. Only a change to a watched field, or a disappearance,
//  is news after that.
// ═══════════════════════════════════════════════════════════════════════════
const NC_ENV = {
  NC_EMAIL:     'parent@example.com',
  NC_PASSWORD:  'harness-pw',
  NC_PLAYERS:   JSON.stringify([{ alias: 'p1', userId: 15890707, name: 'Penny' }]),
  NC_STATE_KEY: 'f'.repeat(64),
};
const NC_CFG  = { enabled: true, checkEveryHours: 6, expected: { teams: 2, registrations: 4 }, teamsTabCanary: true, regPageLimit: 10 };
const NC_COMP = 'FRI - 2026 MENA AUTUMN 9U';
const ncTeams = [
  { teamId: '227878', teamName: 'Park Orchards 9U Storm' },
  { teamId: '256686', teamName: 'Park Orchards 9U Storm' },
];
const ncRegRow = (n, over) => ({
  registrationId: `11111111-2222-3333-4444-00000000000${n}`,
  competitionName: `MENA Club Competition ${n}`, membershipType: 'Junior Player',
  membershipProduct: 'NetSetGo', affiliate: 'Park Orchards Netball Club',
  paymentStatus: 'Registered', expiryDate: '2026-12-31', divisionId: 53778,
  teamId: null, alreadyDeRegistered: 0, deRegisterId: null, isFailedRegistration: 0,
  approvalStatusRefId: null, paidByUsers: 'A Parent Name', participantId: 99,
  ...(over || {}),
});
const NC_ROWS = [1, 2, 3, 4].map(n => ncRegRow(n));

const ncKeyT = (id) => nbw.stateKey(NC_ENV.NC_STATE_KEY, 'team', id);
const ncKeyR = (id) => nbw.stateKey(NC_ENV.NC_STATE_KEY, 'reg', id);

// State as it stands AFTER a successful seed, built with the same functions the
// watcher uses so the fixtures cannot drift from the stored shape.
function ncSeeded(mutate) {
  const T = {}, R = {};
  for (const t of nbw.teamRecords(ncTeams.map(x => ({ ...x, competitionName: NC_COMP, roles: 'Player' })), NC_ENV.NC_STATE_KEY)) {
    T[t.stateKey] = { teamName: t.teamName, competitionName: t.competitionName, firstSeen: '2026-11-28' };
  }
  for (const r of nbw.regRecords(NC_ROWS, NC_ENV.NC_STATE_KEY)) {
    R[r.stateKey] = {
      competitionName: r.competitionName, membershipType: r.membershipType,
      paymentStatus: r.paymentStatus, expiryDate: r.expiryDate, divisionId: r.divisionId,
      hasTeam: r.hasTeam, deRegistered: r.deRegistered, deRegisterStarted: r.deRegisterStarted,
      failed: r.failed, approvalStatusRefId: r.approvalStatusRefId, firstSeen: '2026-11-28',
    };
  }
  const st = { players: { p1: { teams: T, registrations: R, teamsTabNonEmpty: false, seeded: true } },
               lastSuccess: null, lastAttempt: null, lastError: null };
  if (mutate) mutate(st);
  return st;
}

// PlayHQ returns nothing in these scenarios, so any alert is netball's.
const ncCfg = (over) => ({ ...cfgFor(SPORT_BB), netballConnect: { ...NC_CFG, ...(over || {}) } });
const ncNet = (nc) => ({
  tenants: { [BB]: { profile: { [UUID]: { data: { publicProfileTeams: [] } } } } },
  nc: { teams: ncTeams, competitionName: NC_COMP, registrations: { rows: NC_ROWS, totalCount: 4 }, ...(nc || {}) },
});
const ncState = (st) => ({ '_netball.json': st });

const SCENARIOS = [

{
  name: '01 baseline — first sight of a team is ONE summary, not one alert per game',
  cfg: cfgFor(SPORT_BB), state: {},
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, fixture: bbFixtureTwoGames, grade: bbGrade3Rounds } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('exactly one alert', c.pushes.length === 1, JSON.stringify(c.titles()));
    ck('it is the baseline summary', /now watching/.test(c.pushes[0].title));
    ck('no per-game ADDED lines', !/\+ ADDED/.test(c.pushes[0].message), c.pushes[0].message);
    ck('the link is StatTrack', c.pushes[0].url === `${ST_BASE}#t=${T1}&s=season-1`, String(c.pushes[0].url));
    ck('state written', !!c.stateOf(`${T1}.json`));
    ck('state records the sport', c.stateOf(`${T1}.json`).reg.sport === 'basketball');
    ck('player state is in the bySport shape', !!c.stateOf('_players.json')[UUID].bySport.basketball.seen);
  },
},

{
  name: '02 change — a future game moving is reported',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: {
    g1: ng({ d: FUT1, t: '09:00', rn: 'Round 1', opp: 'Rivals' }),
    g2: ng({ d: FUT2, t: '11:00', rn: 'Round 2', opp: 'Others', home: false, oppId: 'opp-2' }),
  } }), '_players.json': { [UUID]: { name: 'Toby', bySport: { basketball: { seen: true, teams: { [T1]: { tid: T1, name: 'Spirit Magic 3', sid: 'season-1', seasonName: '2026', endDate: null } } } } } } },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: {
    [T1]: { data: fixtureData({ tid: T1, gradeId: G1, gradeName: 'B13 - 1', rounds: [
      round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g1', date: FUT1, time: '14:30:00', homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] }),
      round({ id: 'r2', name: 'Round 2', gradeId: G1, games: [game({ id: 'g2', date: FUT2, time: '11:00:00', homeId: 'opp-2', homeName: 'Others', awayId: T1, awayName: 'Spirit Magic 3' })] }),
    ] }) },
  } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('one alert', c.pushes.length === 1, JSON.stringify(c.titles()));
    ck('it names the time change', /time 09:00 → 14:30/.test(c.pushes[0].message), c.pushes[0].message);
    ck('state now holds the new time', c.stateOf(`${T1}.json`).games.g1.t === '14:30');
  },
},

{
  name: '03 regrade — the grade set changing is its own headline',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1, gid: G1, gn: 'B13 - 1' }) } }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: { [G2]: { data: gradeData({ gid: G2, name: 'B13 - 2', rounds: roundList(3, 0) }) } }, fixture: {
    [T1]: { data: fixtureData({ tid: T1, gradeId: G2, gradeName: 'B13 - 2', rounds: [
      round({ id: 'r1', name: 'Round 1', gradeId: G2, gradeName: 'B13 - 2', games: [game({ id: 'g1', date: FUT1, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] }),
    ] }) },
  } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('the title says REGRADED', c.pushes.some(p => /REGRADED/.test(p.title)), JSON.stringify(c.titles()));
    ck('the body names both grade ids', c.pushes.some(p => p.message.includes(`REGRADE: ${G1} → ${G2}`)), c.pushes.map(p => p.message).join('\n'));
  },
},

{
  name: '04 fixture-to-zero — games disappearing is the loud one',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1 }), g2: ng({ d: FUT2 }) } }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: { [T1]: { data: fixtureData({ tid: T1, gradeId: G1, rounds: [] }) } } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('FIXTURE EMPTY alert', c.pushes.some(p => /FIXTURE EMPTY/.test(p.title)), JSON.stringify(c.titles()));
    ck('it says PlayHQ answered normally', c.pushes.some(p => /not a fetch failure/.test(p.message)));
  },
},

{
  name: '05 fixture-published — zero to a whole season is a summary, not N ADDED lines',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: {}, lastGameDate: null, coverage: null }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: {
    [T1]: { data: fixtureData({ tid: T1, gradeId: G1, gradeName: 'B13 - 1', rounds: [
      round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g1', date: FUT1, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'o1', awayName: 'A' })] }),
      round({ id: 'r2', name: 'Round 2', gradeId: G1, games: [game({ id: 'g2', date: FUT2, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'o2', awayName: 'B' })] }),
      round({ id: 'r3', name: 'Round 3', gradeId: G1, games: [game({ id: 'g3', date: isoD(Date.now() + 44 * DAY), homeId: T1, homeName: 'Spirit Magic 3', awayId: 'o3', awayName: 'C' })] }),
    ] }) },
  } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('FIXTURE OUT alert', c.pushes.some(p => /FIXTURE OUT/.test(p.title)), JSON.stringify(c.titles()));
    const m = (c.pushes.find(p => /FIXTURE OUT/.test(p.title)) || {}).message || '';
    ck('it is a First/Last summary', /First:/.test(m) && /Last:/.test(m), m);
    ck('it is NOT a list of ADDED lines', !/\+ ADDED/.test(m), m);
  },
},

{
  name: '06 team gone — and the pre-footy flat _players.json is migrated, not ignored',
  cfg: cfgFor(SPORT_BB),
  state: {
    [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1 }) } }),
    '_players.json': { [UUID]: { seen: true, name: 'Toby', teams: { [T1]: { tid: T1, name: 'Spirit Magic 3', sid: 'season-1', seasonName: '2026', endDate: null } } } },
  },
  net: { tenants: { [BB]: { profile: { [UUID]: { data: { publicProfileTeams: [] } } } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('TEAM GONE alert', c.pushes.some(p => /TEAM GONE/.test(p.title)), JSON.stringify(c.titles()));
    ck('the state file is removed', !c.stateExists(`${T1}.json`));
    const ps = c.stateOf('_players.json')[UUID];
    ck('player state migrated to bySport', !!ps.bySport && !ps.teams, JSON.stringify(ps));
    ck('and now holds no basketball teams', Object.keys(ps.bySport.basketball.teams).length === 0);
  },
},

{
  name: '07 new team — a second registration appearing on the profile',
  cfg: cfgFor(SPORT_BB),
  state: {
    [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1 }) } }),
    '_players.json': { [UUID]: { name: 'Toby', bySport: { basketball: { seen: true, teams: { [T1]: { tid: T1, name: 'Spirit Magic 3', sid: 'season-1', seasonName: '2026', endDate: null } } } } } },
  },
  net: { tenants: { [BB]: { grade: bbGrade3Rounds,
    profile: { [UUID]: { data: { publicProfileTeams: [
      pteam({ id: T1, name: 'Spirit Magic 3', gradeId: G1, gradeName: 'B13 - 1' }),
      pteam({ id: T2, name: 'Spirit Magic 4', gradeId: G1, gradeName: 'B13 - 1' }),
    ] } } },
    fixture: {
      [T1]: { data: fixtureData({ tid: T1, gradeId: G1, rounds: [round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g1', date: FUT1, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] })] }) },
      [T2]: { data: fixtureData({ tid: T2, gradeId: G1, rounds: [round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g9', date: FUT1, homeId: T2, homeName: 'Spirit Magic 4', awayId: 'opp-9', awayName: 'Zed' })] })] }) },
    } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('NEW TEAM alert', c.pushes.some(p => /NEW TEAM/.test(p.title)), JSON.stringify(c.titles()));
    ck('and a baseline for it', c.pushes.some(p => /now watching Spirit Magic 4/.test(p.title)), JSON.stringify(c.titles()));
    ck('state written for the new team', !!c.stateOf(`${T2}.json`));
  },
},

{
  name: '08 blocked profile — a WAF block is NEVER read as "no teams"',
  cfg: cfgFor(SPORT_BB),
  state: {
    [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1 }) } }),
    '_players.json': { [UUID]: { name: 'Toby', bySport: { basketball: { seen: true, teams: { [T1]: { tid: T1, name: 'Spirit Magic 3', sid: 'season-1', seasonName: '2026', endDate: null } } } } } },
  },
  net: { tenants: { [BB]: { profile: { [UUID]: { waf: true } }, grade: bbGrade3Rounds, fixture: {
    [T1]: { data: fixtureData({ tid: T1, gradeId: G1, rounds: [round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g1', date: FUT1, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] })] }) },
  } } } },
  assert(c, ck) {
    ck('exit 1', c.code === 1, `exit ${c.code}`);
    ck('no TEAM GONE alert', !c.pushes.some(p => /TEAM GONE/.test(p.title)), JSON.stringify(c.titles()));
    ck('a watcher-failed alert was sent', c.pushes.some(p => p.title === 'watcher failed'), JSON.stringify(c.titles()));
    ck('it names the CloudFront block', c.pushes.some(p => /CLOUDFRONT-BLOCK/.test(p.message)));
    ck('the known team is still checked', c.calls.some(x => x.kind === 'fixture' && x.id === T1));
  },
},

{
  name: '09 blocked fixture — state is left EXACTLY as it was',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1 }) } }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, fixture: { [T1]: { waf: true } } } } },
  assert(c, ck) {
    ck('exit 1', c.code === 1, `exit ${c.code}`);
    ck('no fixture alert', !c.pushes.some(p => p.title !== 'watcher failed'), JSON.stringify(c.titles()));
    ck('watcher-failed alert sent', c.pushes.some(p => p.title === 'watcher failed'));
    ck('the one stored game is untouched', Object.keys(c.stateOf(`${T1}.json`).games).join(',') === 'g1');
  },
},

{
  name: '10 Pushover rejection — the state write is HELD BACK so nothing is lost',
  cfg: cfgFor(SPORT_BB), state: {},
  net: { pushover: { mode: 'reject' }, tenants: { [BB]: { profile: bbProfileOneTeam, fixture: bbFixtureTwoGames, grade: bbGrade3Rounds } } },
  assert(c, ck) {
    ck('exit 1', c.code === 1, `exit ${c.code}`);
    ck('the alert was attempted', c.pushes.length >= 1);
    ck('NO state file was written for the team', !c.stateExists(`${T1}.json`), 'the alert never arrived, so the next run must re-detect it');
    ck('the log says it was held back', /holding back state/.test(c.stdout), c.stdout.slice(-800));
  },
},

{
  name: '11 past-game rename — history changing is NOT news',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, lastGameDate: PAST, games: {
    gp: ng({ d: PAST, st: 'FINAL', opp: 'Rivals', oppId: 'opp-1', rn: 'Round 1' }),
  } }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: {
    [T1]: { data: fixtureData({ tid: T1, gradeId: G1, rounds: [
      round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'gp', date: PAST, status: 'FINAL', homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'ZZ - Rivals - W' })] }),
    ] }) },
  } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('NO alert at all', c.pushes.length === 0, JSON.stringify(c.titles()));
    ck('the log says no change', /no change/.test(c.stdout));
  },
},

{
  name: '12 transient 504 — retried inside the pass, and it recovers',
  cfg: cfgFor(SPORT_BB), state: {},
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: {
    [T1]: { transient: 1, data: fixtureData({ tid: T1, gradeId: G1, gradeName: 'B13 - 1', rounds: [
      round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g1', date: FUT1, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] }),
    ] }) },
  } } } },
  assert(c, ck) {
    ck('exit 0 — it recovered', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('the fixture was asked twice', c.calls.filter(x => x.kind === 'fixture').length === 2, String(c.calls.filter(x => x.kind === 'fixture').length));
    ck('the retry is in the log', /retrying in 5s/.test(c.stdout));
    ck('no watcher-failed alert', !c.pushes.some(p => p.title === 'watcher failed'));
    ck('state written', !!c.stateOf(`${T1}.json`));
  },
},

{
  name: '13 timeout — three dead attempts is a typed failure, not an empty fixture',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1 }) } }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, fixture: { [T1]: { throwTimes: 3 } } } } },
  assert(c, ck) {
    ck('exit 1', c.code === 1, `exit ${c.code}`);
    ck('three attempts were made', c.calls.filter(x => x.kind === 'fixture').length === 3, String(c.calls.filter(x => x.kind === 'fixture').length));
    ck('watcher-failed alert sent', c.pushes.some(p => p.title === 'watcher failed'));
    ck('no FIXTURE EMPTY alert', !c.pushes.some(p => /FIXTURE EMPTY/.test(p.title)), JSON.stringify(c.titles()));
    ck('the stored game survives', Object.keys(c.stateOf(`${T1}.json`).games).join(',') === 'g1');
  },
},

{
  name: '14 two tenants — ONE SESSION PER TENANT, and the right cookie on every call',
  cfg: cfgFor({ ...SPORT_BB, footy: SPORT_FOOTY }), state: {},
  net: { tenants: {
    [BB]:  { profile: bbProfileOneTeam, fixture: bbFixtureTwoGames, grade: bbGrade3Rounds },
    [AFL]: {
      profile: { [UUID]: { data: { publicProfileTeams: [pteam({
        id: FT, name: 'Norwood U12 Purple', club: 'Norwood', clubId: '6d405ccb',
        gradeId: FG, gradeName: 'U12 - B',
        sid: 'footy-season-2026', seasonName: '2026', startDate: '2025-10-01', endDate: null,
        comp: 'EFNL 2026', orgId: '383836bb-1111-2222-3333-444455556666', assoc: 'Eastern Football Netball League',
      })] } } },
      fixture: { [FT]: { data: fixtureData({ tid: FT, gradeId: FG, gradeName: 'U12 - B', sid: 'footy-season-2026', club: 'Norwood', orgId: '383836bb-1111-2222-3333-444455556666', assoc: 'Eastern Football Netball League', rounds: [
        round({ id: 'fr1', name: 'Round 1', gradeId: FG, gradeName: 'U12 - B', games: [game({ id: 'fg1', date: FUT1, homeId: FT, homeName: 'Norwood U12 Purple', awayId: 'fopp', awayName: 'Vermont U12 Blue' })] }),
        round({ id: 'fr2', name: 'Round 2', gradeId: FG, gradeName: 'U12 - B', games: [] }),
      ] }) } },
      grade: { [FG]: { data: gradeData({ gid: FG, name: 'U12 - B', rounds: roundList(2, 0) }) } },
    },
  } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-2000)}`);
    const bbS  = c.sessions.filter(s => s.tenant === BB).length;
    const aflS = c.sessions.filter(s => s.tenant === AFL).length;
    ck('exactly one session bootstrap per tenant', bbS === 1 && aflS === 1, `basketball ${bbS}, afl ${aflS}`);
    const wrong = c.authed.filter(x => !String(x.cookie || '').includes(`sess-${x.tenant}`));
    ck('every authed call carried ITS OWN tenant cookie', wrong.length === 0, JSON.stringify(wrong.slice(0, 3)));
    ck('both state files written', !!c.stateOf(`${T1}.json`) && !!c.stateOf(`${FT}.json`));
    ck('each state records its sport', c.stateOf(`${T1}.json`) && c.stateOf(`${FT}.json`) && c.stateOf(`${T1}.json`).reg.sport === 'basketball' && c.stateOf(`${FT}.json`).reg.sport === 'footy');
    ck('both sports appear in player state', Object.keys(c.stateOf('_players.json')[UUID].bySport).sort().join(',') === 'basketball,footy');
    const footyAlert = c.pushes.find(p => /Norwood U12 Purple/.test(p.title));
    ck('the footy alert title carries the sport', !!footyAlert && /^\[Footy\]/.test(footyAlert.title), footyAlert ? footyAlert.title : JSON.stringify(c.titles()));
    ck('the basketball alert title carries the sport', c.pushes.some(p => /^\[Basketball\]/.test(p.title)), JSON.stringify(c.titles()));
    // ⚠️ This team's only game is in the FUTURE, so the dashboard holds no record
    // of it and NO link may be emitted. Basketball is unaffected.
    ck('the footy alert carries NO link — nothing played yet', !!footyAlert && footyAlert.url === null, footyAlert ? String(footyAlert.url) : '(no alert)');
    ck('the basketball alert still links to StatTrack', c.pushes.some(p => String(p.url || '').startsWith(ST_BASE)), JSON.stringify(c.pushes.map(p => p.url)));
  },
},

{
  name: '15 two tenants — a tenant failing entirely does NOT stop the other',
  cfg: cfgFor({ ...SPORT_BB, footy: SPORT_FOOTY }), state: {},
  net: { tenants: {
    [BB]:  { profile: bbProfileOneTeam, fixture: bbFixtureTwoGames, grade: bbGrade3Rounds },
    [AFL]: { session: 'waf' },
  } },
  assert(c, ck) {
    ck('exit 1 — the run is red', c.code === 1, `exit ${c.code}`);
    ck('basketball still completed', !!c.stateOf(`${T1}.json`), c.stdout.slice(-2000));
    ck('basketball still alerted', c.pushes.some(p => /^\[Basketball\]/.test(p.title) && /now watching/.test(p.title)), JSON.stringify(c.titles()));
    ck('the failure is labelled with the sport', c.pushes.some(p => p.title === 'watcher failed' && /Footy ·/.test(p.message)), (c.pushes.find(p => p.title === 'watcher failed') || {}).message);
    ck('the afl session was not retried for ever', c.sessions.filter(s => s.tenant === AFL).length <= 3, String(c.sessions.filter(s => s.tenant === AFL).length));
    ck('no basketball session was wasted on it', c.sessions.filter(s => s.tenant === BB).length === 1);
  },
},

{
  name: '16 footy out of season — three COMPLETED seasons produce SILENCE, not noise',
  cfg: cfgFor({ ...SPORT_BB, footy: SPORT_FOOTY }), state: {},
  net: { tenants: {
    [BB]:  { profile: { [UUID]: { data: { publicProfileTeams: [] } } } },
    [AFL]: { profile: { [UUID]: { data: { publicProfileTeams: [
      pteam({ id: 'e2b94c0a', name: 'Norwood U12 Purple', club: 'Norwood', gradeId: '0fd9befd', gradeName: 'U12 - B', sid: '2dcbf383', seasonName: '2026', startDate: '2025-10-01', endDate: '2026-09-30', seasonStatus: 'COMPLETED', orgId: '383836bb-x' }),
      pteam({ id: 'd382b356', name: 'Norwood U11', club: 'Norwood', gradeId: 'a53bfc56', gradeName: 'U11 - B', sid: '75d8a232', seasonName: '2025', startDate: '2024-10-01', endDate: '2025-09-30', seasonStatus: 'COMPLETED', orgId: '383836bb-x' }),
      pteam({ id: 'f8b540b9', name: 'Norwood U10', club: 'Norwood', gradeId: 'ce193e34', gradeName: 'U10 - Blue', sid: 'ca9cc98b', seasonName: '2024', startDate: '2023-10-01', endDate: '2024-09-30', seasonStatus: 'COMPLETED', orgId: '383836bb-x' }),
    ] } } } },
  } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('NO alerts at all', c.pushes.length === 0, JSON.stringify(c.titles()));
    ck('no fixture call was made', c.calls.filter(x => x.kind === 'fixture').length === 0);
    ck('all three are logged as out of scope', (c.stdout.match(/out of scope, never watched/g) || []).length === 3, c.stdout.slice(-1500));
    ck('footy is recorded as seen, so a 2027 team will alert', c.stateOf('_players.json')[UUID].bySport.footy.seen === true);
  },
},

{
  name: '17 footy new registration — grade null, no fixture, and therefore NO link',
  cfg: cfgFor({ ...SPORT_BB, footy: SPORT_FOOTY }),
  state: { '_players.json': { [UUID]: { name: 'Toby', bySport: { basketball: { seen: true, teams: {} }, footy: { seen: true, teams: {} } } } } },
  net: { tenants: {
    [BB]:  { profile: { [UUID]: { data: { publicProfileTeams: [] } } } },
    [AFL]: {
      profile: { [UUID]: { data: { publicProfileTeams: [pteam({
        id: '6a77a594', name: 'Lilydale U13', club: 'Lilydale', gradeId: null,
        sid: '1c5d3dfb', seasonName: '2027', startDate: '2026-11-01', endDate: '2027-09-19',
        seasonStatus: 'ACTIVE', comp: 'EFNL 2027', orgId: '383836bb-aaaa', assoc: 'Eastern Football Netball League',
      })] } } },
      fixture: { '6a77a594': { data: fixtureData({ tid: '6a77a594', gradeId: null, sid: '1c5d3dfb', seasonName: '2027', club: 'Lilydale', orgId: '383836bb-aaaa', rounds: [] }) } },
    },
  } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    const nt = c.pushes.find(p => /NEW TEAM/.test(p.title));
    ck('a NEW TEAM alert fired', !!nt, JSON.stringify(c.titles()));
    ck('it is labelled Footy', !!nt && /^\[Footy\]/.test(nt.title), nt ? nt.title : '');
    // ⚠️ THE CASE THE WHOLE SUPPRESSION RULE EXISTS FOR. A brand new registration
    // has no games at all, so the dashboard cannot resolve it on any key. The alert
    // must still fire, and must carry NO link.
    ck('the NEW TEAM alert carries NO link', !!nt && nt.url === null, nt ? String(nt.url) : '');
    ck('no grade round call was possible or made', c.calls.filter(x => x.kind === 'grade').length === 0);
    ck('the baseline says no games are scheduled', c.pushes.some(p => /now watching Lilydale U13/.test(p.title) && /No games scheduled ahead/.test(p.message)), JSON.stringify(c.titles()));
  },
},

{
  name: '18 legacy config — a watch.json with NO sports block still works exactly as before',
  cfg: {
    tenant: BB, sport: 'basketball', stattrackBase: ST_BASE,
    players: [{ uuid: UUID, name: 'Toby', pinnedTeams: [] }],
    completeFixtureSlotsEvery: 4, gradeRoundsRefreshHours: 12, activeChangeWindowDays: 7,
    stopAfterSeasonEndDays: 21, failureAlertCooldownHours: 6, maxAlertChars: 1000,
  },
  state: {},
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, fixture: bbFixtureTwoGames, grade: bbGrade3Rounds } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('one baseline alert', c.pushes.length === 1 && /now watching/.test(c.pushes[0].title), JSON.stringify(c.titles()));
    ck('the StatTrack link is intact', c.pushes[0].url === `${ST_BASE}#t=${T1}&s=season-1`, String(c.pushes[0].url));
    ck('only the basketball tenant was contacted', c.calls.every(x => x.kind === 'pushover' || x.tenant === BB));
  },
},

{
  name: '19 footy with a played game — the link is the TEAM ID, not the name',
  cfg: cfgFor({ ...SPORT_BB, footy: SPORT_FOOTY }), state: {},
  net: { tenants: {
    [BB]:  { profile: { [UUID]: { data: { publicProfileTeams: [] } } } },
    [AFL]: {
      profile: { [UUID]: { data: { publicProfileTeams: [pteam({
        id: FT, name: 'Norwood U12 Purple', club: 'Norwood', gradeId: FG, gradeName: 'U12 - B',
        sid: 'footy-season-2027', seasonName: '2027', startDate: '2026-10-01', endDate: null,
        comp: 'EFNL 2027', orgId: '383836bb-1111-2222-3333-444455556666', assoc: 'Eastern Football Netball League',
      })] } } },
      fixture: { [FT]: { data: fixtureData({ tid: FT, gradeId: FG, gradeName: 'U12 - B', sid: 'footy-season-2027', seasonName: '2027', club: 'Norwood', orgId: '383836bb-1111-2222-3333-444455556666', rounds: [
        round({ id: 'fr1', name: 'Round 1', gradeId: FG, gradeName: 'U12 - B', games: [game({ id: 'fg1', date: PAST, status: 'FINAL', homeId: FT, homeName: 'Norwood U12 Purple', awayId: 'fopp', awayName: 'Vermont U12 Blue' })] }),
        round({ id: 'fr2', name: 'Round 2', gradeId: FG, gradeName: 'U12 - B', games: [game({ id: 'fg2', date: FUT1, homeId: 'fopp2', homeName: 'Mitcham U12 Red', awayId: FT, awayName: 'Norwood U12 Purple' })] }),
      ] }) } },
      grade: { [FG]: { data: gradeData({ gid: FG, name: 'U12 - B', rounds: roundList(2, 1) }) } },
    },
  } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    const a = c.pushes.find(p => /Norwood U12 Purple/.test(p.title));
    ck('the footy baseline alert fired', !!a, JSON.stringify(c.titles()));
    ck('the link carries the team ID', !!a && a.url === `${FOOTY_BASE}#y=2027&c=EFNL&a=U12&t=${FT}`, a ? String(a.url) : '(no alert)');
    ck('the team NAME is nowhere in the link', !!a && !String(a.url).includes('Norwood'), a ? String(a.url) : '');
    ck('the button names the dashboard', !!a && a.urlTitle === 'Open in the footy dashboard');
  },
},

{
  name: '20 team gone — the link is judged from the STORED fixture, not a fetch',
  cfg: cfgFor({ ...SPORT_BB, footy: SPORT_FOOTY }),
  state: {
    [`${FT}.json`]: teamState({ tid: FT, sport: 'footy', name: 'Norwood U12 Purple', gid: FG, gradeName: 'U12 - B', orgId: '383836bb-1111-2222-3333-444455556666', lastGameDate: PAST, games: { fg1: ng({ d: PAST, st: 'FINAL', gid: FG, gn: 'U12 - B', rn: 'Round 1' }) } }),
    '_players.json': { [UUID]: { name: 'Toby', bySport: {
      basketball: { seen: true, teams: {} },
      footy: { seen: true, teams: { [FT]: { tid: FT, name: 'Norwood U12 Purple', sid: 'footy-season-2027', seasonName: '2027', endDate: null, regGrade: 'U12 - B', assocId: '383836bb-1111-2222-3333-444455556666' } } } },
    } },
  },
  net: { tenants: {
    [BB]:  { profile: { [UUID]: { data: { publicProfileTeams: [] } } } },
    [AFL]: { profile: { [UUID]: { data: { publicProfileTeams: [] } } } },
  } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    const gone = c.pushes.find(p => /TEAM GONE/.test(p.title));
    ck('a TEAM GONE alert fired', !!gone, JSON.stringify(c.titles()));
    ck('it is labelled Footy', !!gone && /^\[Footy\]/.test(gone.title), gone ? gone.title : '');
    // The team is off the profile so nothing was fetched — the stored fixture is
    // the only evidence that the dashboard can resolve it, and it holds a FINAL game.
    ck('the link is built from the stored FINAL game', !!gone && gone.url === `${FOOTY_BASE}#y=2027&c=EFNL&a=U12&t=${FT}`, gone ? String(gone.url) : '');
    ck('the state file is removed', !c.stateExists(`${FT}.json`));
    ck('no fixture call was made', c.calls.filter(x => x.kind === 'fixture').length === 0);
  },
},

{
  name: '21 FINAL flip — ONE dispatch, with the season, grade and round name',
  cfg: cfgFor(BB_PUB),
  state: finalFlipState(),
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds,
    fixture: finalFlipFixture([roundWith('r1', 'Round 7', [finalGame('g1', TODAY)])]) } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-2000)}`);
    ck('exactly one dispatch', c.dispatches.length === 1, JSON.stringify(c.dispatches));
    const d = c.dispatches[0] || {};
    ck('to the StatTrack repo', d.repo === 'markjovic/sports-players-stats', String(d.repo));
    ck('to publish-final-game.yml', d.workflow === 'publish-final-game.yml', String(d.workflow));
    ck('on ref main', d.ref === 'main', String(d.ref));
    ck('season is the team season id', d.inputs && d.inputs.season === 'season-1', JSON.stringify(d.inputs));
    ck('grade is the grade ID', d.inputs && d.inputs.grade === G1, JSON.stringify(d.inputs));
    ck('round is the round NAME, not an id', d.inputs && d.inputs.round === 'Round 7', JSON.stringify(d.inputs));
    ck('the flipped game is reported', d.inputs && d.inputs.games === 'g1', JSON.stringify(d.inputs));
    ck('source names the dispatcher', d.inputs && d.inputs.source === 'fixture-watch');
    ck('the PAT was sent', d.auth === 'Bearer harness-pat', String(d.auth));
    ck('state was written after the dispatch', c.stateOf(`${T1}.json`).games.g1.st === 'FINAL');
    ck('the log says it dispatched', /dispatched publish-final-game\.yml/.test(c.stdout));
  },
},

{
  name: '22 dispatch refused — the state is HELD BACK so the next pass retries',
  cfg: cfgFor(BB_PUB),
  state: finalFlipState(),
  net: { dispatch: { mode: 'refuse' }, tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds,
    fixture: finalFlipFixture([roundWith('r1', 'Round 7', [finalGame('g1', TODAY)])]) } } },
  assert(c, ck) {
    ck('exit 1', c.code === 1, `exit ${c.code}`);
    ck('the dispatch was attempted', c.dispatches.length === 1);
    ck('state still says SCHEDULED', c.stateOf(`${T1}.json`).games.g1.st === 'SCHEDULED', 'a baselined FINAL would never be retried');
    ck('the log says it was held back', /holding back state .*a dispatch failed/.test(c.stdout), c.stdout.slice(-900));
    // ⚠️ AND IT DOES NOT BUZZ THE PHONE. The dispatch runs in phase 5, AFTER the
    // phase 4 failure alert has already been decided, so a refused dispatch makes
    // the run RED and writes nothing — but sends no Pushover. That is the
    // behaviour as restored from 6f09a113, asserted here rather than quietly
    // changed. The cost is bounded: the state is held, the next pass retries, and
    // the 01:00 nightly publishes regardless. You would notice it only as a red run.
    ck('no watcher-failed push — phase 4 has already run', !c.pushes.some(p => p.title === 'watcher failed'), JSON.stringify(c.titles()));
    ck('but the failure IS in the log', /dispatch FAILED/.test(c.stdout), c.stdout.slice(-900));
  },
},

{
  name: '23 too many rounds at once — dispatch NONE, and say so',
  cfg: cfgFor({ basketball: { ...SPORT_BB.basketball, publishOnFinal: { ...PUB, maxRoundsPerPass: 1 } } }),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, lastGameDate: TODAY, games: {
    g1: ng({ d: TODAY, st: 'SCHEDULED', rn: 'Round 7', gid: G1 }),
    g2: ng({ d: TODAY, st: 'SCHEDULED', rn: 'Round 8', gid: G1 }),
  } }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: finalFlipFixture([
    roundWith('r1', 'Round 7', [finalGame('g1', TODAY)]),
    roundWith('r2', 'Round 8', [finalGame('g2', TODAY)]),
  ]) } } },
  assert(c, ck) {
    ck('exit 1 — the refusal is a failure, not a silent trim', c.code === 1, `exit ${c.code}`);
    ck('NOTHING was dispatched', c.dispatches.length === 0, JSON.stringify(c.dispatches));
    ck('the log says dispatching NONE', /dispatching NONE/.test(c.stdout), c.stdout.slice(-1200));
    ck('the failure names the nightly as the fallback', c.pushes.some(p => p.title === 'watcher failed' && /nightly will pick them up/.test(p.message)));
  },
},

{
  name: '24 a first pass never dispatches, however many FINALs it holds',
  cfg: cfgFor(BB_PUB), state: {},
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: finalFlipFixture([
    roundWith('r1', 'Round 1', [finalGame('g1', PAST)]),
    roundWith('r2', 'Round 2', [finalGame('g2', PAST)]),
  ]) } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('NO dispatch from a baseline', c.dispatches.length === 0, JSON.stringify(c.dispatches));
    ck('it still baselined', !!c.stateOf(`${T1}.json`));
  },
},

{
  name: '25 a FOOTY final NEVER dispatches — the publish repo is basketball-only',
  cfg: cfgFor({ ...BB_PUB, footy: SPORT_FOOTY }),
  state: {
    [`${FT}.json`]: teamState({ tid: FT, sport: 'footy', name: 'Norwood U12 Purple', gid: FG, gradeName: 'U12 - B', orgId: '383836bb-1111-2222-3333-444455556666', lastGameDate: TODAY, games: {
      fg1: ng({ d: TODAY, st: 'SCHEDULED', gid: FG, gn: 'U12 - B', rn: 'Round 7' }),
    } }),
  },
  net: { tenants: {
    [BB]:  { profile: { [UUID]: { data: { publicProfileTeams: [] } } } },
    [AFL]: {
      profile: { [UUID]: { data: { publicProfileTeams: [pteam({
        id: FT, name: 'Norwood U12 Purple', club: 'Norwood', gradeId: FG, gradeName: 'U12 - B',
        sid: 'footy-season-2027', seasonName: '2027', endDate: null,
        orgId: '383836bb-1111-2222-3333-444455556666',
      })] } } },
      fixture: { [FT]: { data: fixtureData({ tid: FT, gradeId: FG, gradeName: 'U12 - B', sid: 'footy-season-2027', seasonName: '2027', orgId: '383836bb-1111-2222-3333-444455556666', rounds: [
        round({ id: 'fr7', name: 'Round 7', gradeId: FG, gradeName: 'U12 - B', games: [game({ id: 'fg1', date: TODAY, status: 'FINAL', homeId: FT, homeName: 'Norwood U12 Purple', awayId: 'fopp', awayName: 'Vermont U12 Blue' })] }),
      ] }) } },
      grade: { [FG]: { data: gradeData({ gid: FG, name: 'U12 - B', rounds: roundList(7, 6) }) } },
    },
  } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-2000)}`);
    ck('NO dispatch — footy has no publishOnFinal', c.dispatches.length === 0, JSON.stringify(c.dispatches));
    ck('the footy change still alerted', c.pushes.some(p => /^\[Footy\]/.test(p.title)), JSON.stringify(c.titles()));
    ck('and the footy state still advanced', c.stateOf(`${FT}.json`).games.fg1.st === 'FINAL');
  },
},

{
  name: '26 a game already PAST when it goes FINAL is suppressed — nightly territory',
  cfg: cfgFor(BB_PUB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, lastGameDate: PAST, games: {
    g1: ng({ d: PAST, st: 'SCHEDULED', rn: 'Round 7', gid: G1 }),
  } }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds,
    fixture: finalFlipFixture([roundWith('r1', 'Round 7', [finalGame('g1', PAST)])]) } } },
  assert(c, ck) {
    // ⚠️ DOCUMENTING BEHAVIOUR, NOT ENDORSING IT. The past-game suppression added
    // 2026-11-24 ignores field changes on a game historical in BOTH snapshots, and
    // a late-entered result is exactly that. Saturday results are unaffected — a
    // game is not historical until the end of its date in UTC, which is late
    // morning the next day in Melbourne — so this only bites a result entered days
    // late, which the 01:00 nightly already handles.
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('no dispatch for a late-entered result', c.dispatches.length === 0, JSON.stringify(c.dispatches));
    ck('and no alert either — history is not news', c.pushes.length === 0, JSON.stringify(c.titles()));
  },
},

{
  name: '27 netball seed — ONE summary, never an alert per existing item',
  cfg: ncCfg(), state: {}, env: NC_ENV, net: ncNet(),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-2000)}`);
    ck('exactly one alert', c.pushes.length === 1, JSON.stringify(c.titles()));
    ck('it is the seed summary', /Netball Connect watch started for Penny/.test(c.pushes[0].title), c.pushes[0].title);
    ck('it names the counts', /2 team\(s\), 4 registration\(s\)/.test(c.pushes[0].message), c.pushes[0].message);
    ck('no "expected" warning — the counts match the spec', !/Expected 2 teams/.test(c.pushes[0].message));
    const st = c.stateOf('_netball.json');
    ck('state written', !!st);
    ck('2 teams recorded', st && Object.keys(st.players.p1.teams).length === 2);
    ck('4 registrations recorded', st && Object.keys(st.players.p1.registrations).length === 4);
    ck('lastSuccess set', !!(st && st.lastSuccess));
    ck('one login only', c.nc.filter(x => x.call === 'login').length === 1, JSON.stringify(c.nc.map(x => x.call)));
  },
},

{
  name: '28 netball steady state — a known data point never alerts again',
  cfg: ncCfg(), state: ncState(ncSeeded()), env: NC_ENV, net: ncNet(),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('NO alerts', c.pushes.length === 0, JSON.stringify(c.titles()));
    ck('lastSuccess updated', !!c.stateOf('_netball.json').lastSuccess);
  },
},

{
  name: '29 netball new team allocation — the main purpose',
  cfg: ncCfg(), env: NC_ENV, net: ncNet(),
  state: ncState(ncSeeded(st => { delete st.players.p1.teams[ncKeyT('256686')]; })),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('exactly one alert', c.pushes.length === 1, JSON.stringify(c.titles()));
    ck('it is the new-team alert', c.pushes[0].title === 'Penny - new netball team', c.pushes[0].title);
    ck('it carries the team and competition', /Park Orchards 9U Storm/.test(c.pushes[0].message) && new RegExp(NC_COMP).test(c.pushes[0].message), c.pushes[0].message);
    ck('and the role', /Role: Player/.test(c.pushes[0].message));
    ck('it links to Netball Connect', c.pushes[0].url === 'https://registration.netballconnect.com');
    ck('the team is now known', Object.keys(c.stateOf('_netball.json').players.p1.teams).length === 2);
  },
},

{
  name: '30 netball team renamed — clubs create a team then rename it',
  cfg: ncCfg(), env: NC_ENV, net: ncNet(),
  state: ncState(ncSeeded(st => { st.players.p1.teams[ncKeyT('256686')].teamName = 'Park Orchards 9U TBC'; })),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('one alert', c.pushes.length === 1, JSON.stringify(c.titles()));
    ck('titled renamed', c.pushes[0].title === 'Penny - netball team renamed', c.pushes[0].title);
    ck('old → new', c.pushes[0].message === 'Park Orchards 9U TBC → Park Orchards 9U Storm', c.pushes[0].message);
    ck('state now holds the new name', c.stateOf('_netball.json').players.p1.teams[ncKeyT('256686')].teamName === 'Park Orchards 9U Storm');
  },
},

{
  name: '31 netball team removed — and only from a fetch that validated',
  cfg: ncCfg(), env: NC_ENV, net: ncNet(),
  state: ncState(ncSeeded(st => { st.players.p1.teams['deadbeefdeadbeef'] = { teamName: 'Ghost 9U', competitionName: NC_COMP, firstSeen: '2026-01-01' }; })),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('one alert', c.pushes.length === 1, JSON.stringify(c.titles()));
    ck('titled removed', c.pushes[0].title === 'Penny - removed from netball team', c.pushes[0].title);
    ck('names the ghost team', /Ghost 9U/.test(c.pushes[0].message), c.pushes[0].message);
    ck('and it is gone from state', !c.stateOf('_netball.json').players.p1.teams['deadbeefdeadbeef']);
  },
},

{
  name: '32 netball new registration — the first sign of a new season',
  cfg: ncCfg(), env: NC_ENV, net: ncNet(),
  state: ncState(ncSeeded(st => { delete st.players.p1.registrations[ncKeyR('11111111-2222-3333-4444-000000000003')]; })),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('one alert', c.pushes.length === 1, JSON.stringify(c.titles()));
    ck('titled new registration', c.pushes[0].title === 'Penny - new netball registration', c.pushes[0].title);
    ck('affiliate, competition, product and status', /Park Orchards Netball Club/.test(c.pushes[0].message) && /NetSetGo - Junior Player/.test(c.pushes[0].message) && /Status: Registered/.test(c.pushes[0].message), c.pushes[0].message);
    ck('expiry in Australian format', /valid until 31\/12\/2026/.test(c.pushes[0].message), c.pushes[0].message);
  },
},

{
  name: '33 netball registration changed — a watched field moved',
  cfg: ncCfg(), env: NC_ENV, net: ncNet(),
  state: ncState(ncSeeded(st => { st.players.p1.registrations[ncKeyR('11111111-2222-3333-4444-000000000001')].paymentStatus = 'Pending'; })),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('one alert', c.pushes.length === 1, JSON.stringify(c.titles()));
    ck('titled updated', c.pushes[0].title === 'Penny - netball registration updated', c.pushes[0].title);
    ck('names the field and both values', /paymentStatus: Pending → Registered/.test(c.pushes[0].message), c.pushes[0].message);
  },
},

{
  name: '34 netball registration gains a team — its own headline',
  cfg: ncCfg(), env: NC_ENV,
  net: ncNet({ registrations: { rows: [ncRegRow(1, { teamId: '256686' }), ...NC_ROWS.slice(1)], totalCount: 4 } }),
  state: ncState(ncSeeded()),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('one alert', c.pushes.length === 1, JSON.stringify(c.titles()));
    ck('the title says it has a team', c.pushes[0].title === 'Penny - netball registration now has a team', c.pushes[0].title);
    ck('hasTeam false → true', /hasTeam: false → true/.test(c.pushes[0].message), c.pushes[0].message);
    ck('⚠️ and the teamId is NOT in the message', !/256686/.test(c.pushes[0].message), c.pushes[0].message);
    ck('nor in state', !JSON.stringify(c.stateOf('_netball.json')).includes('256686'));
  },
},

{
  name: '35 netball paging — driven by totalCount, never by nextPage',
  cfg: ncCfg({ regPageLimit: 2 }), env: NC_ENV, net: ncNet(), state: ncState(ncSeeded()),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    const pages = c.nc.filter(x => x.call === 'registration');
    ck('two pages were fetched', pages.length === 2, JSON.stringify(pages));
    ck('offsets 0 then 2', pages[0].offset === 0 && pages[1].offset === 2, JSON.stringify(pages));
    // The mock returns nextPage:10 against totalCount:4, exactly as the real API
    // does. A client that trusted it would keep paging; this one stops at 4.
    ck('NO alerts — all four were already known', c.pushes.length === 0, JSON.stringify(c.titles()));
  },
},

{
  name: '36 netball short page — INCOMPLETE is an error, never three removals',
  cfg: ncCfg(), env: NC_ENV, state: ncState(ncSeeded()),
  net: ncNet({ registrations: { rows: NC_ROWS, totalCount: 4, shortPage: true } }),
  assert(c, ck) {
    ck('exit 1', c.code === 1, `exit ${c.code}`);
    ck('NO "removed" alerts', !c.pushes.some(p => /removed/i.test(p.title)), JSON.stringify(c.titles()));
    ck('one error alert', c.pushes.some(p => p.title === 'fixture-watch: Netball Connect error'), JSON.stringify(c.titles()));
    ck('it says incomplete', c.pushes.some(p => /got 3 of 4 - incomplete/.test(p.message)), JSON.stringify(c.pushes.map(p => p.message)));
    ck('the registrations are untouched', Object.keys(c.stateOf('_netball.json').players.p1.registrations).length === 4);
  },
},

{
  name: '37 netball bad password — one error, no retry, state untouched',
  cfg: ncCfg(), env: NC_ENV, state: ncState(ncSeeded()), net: ncNet({ login: 'bad' }),
  assert(c, ck) {
    ck('exit 1', c.code === 1, `exit ${c.code}`);
    ck('exactly ONE login attempt — a loop here risks a lockout', c.nc.filter(x => x.call === 'login').length === 1, JSON.stringify(c.nc));
    ck('no profile or registration call followed', c.nc.filter(x => x.call !== 'login').length === 0, JSON.stringify(c.nc));
    ck('one error alert', c.pushes.filter(p => p.title === 'fixture-watch: Netball Connect error').length === 1, JSON.stringify(c.titles()));
    ck('it names the likely cause without echoing the password', /rejected \(wrong email\/password\?\)/.test(c.pushes[0].message) && !/harness-pw/.test(c.pushes[0].message), c.pushes[0].message);
    const st = c.stateOf('_netball.json');
    ck('teams and registrations untouched', Object.keys(st.players.p1.teams).length === 2 && Object.keys(st.players.p1.registrations).length === 4);
    ck('lastError recorded so the next run stays quiet', !!(st.lastError && st.lastError.reason));
    ck('lastSuccess NOT advanced', !st.lastSuccess);
    ck('lastAttempt IS advanced — the cadence gate holds off the next login', !!st.lastAttempt);
  },
},

{
  name: '38 netball format change — one fetch fails, the other still diffs',
  cfg: ncCfg(), env: NC_ENV,
  net: ncNet({ personaldetails: { noCompetitions: true } }),
  state: ncState(ncSeeded(st => { delete st.players.p1.registrations[ncKeyR('11111111-2222-3333-4444-000000000002')]; })),
  assert(c, ck) {
    ck('exit 1', c.code === 1, `exit ${c.code}`);
    ck('the teams error is reported', c.pushes.some(p => /Netball Connect error/.test(p.title) && /'competitions' missing - format changed/.test(p.message)), JSON.stringify(c.pushes.map(p => p.message)));
    ck('the registration diff STILL ran', c.pushes.some(p => p.title === 'Penny - new netball registration'), JSON.stringify(c.titles()));
    ck('teams state untouched by the failed fetch', Object.keys(c.stateOf('_netball.json').players.p1.teams).length === 2);
  },
},

{
  name: '39 netball failing does NOT stop PlayHQ — and vice versa',
  cfg: { ...cfgFor(SPORT_BB), netballConnect: NC_CFG }, env: NC_ENV,
  state: {
    '_netball.json': ncSeeded(),
    [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1, t: '09:00', rn: 'Round 1' }) } }),
  },
  net: {
    nc: { login: 'waf' },
    tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: {
      [T1]: { data: fixtureData({ tid: T1, gradeId: G1, gradeName: 'B13 - 1', rounds: [
        round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g1', date: FUT1, time: '14:30:00', homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] }),
      ] }) },
    } } },
  },
  assert(c, ck) {
    ck('exit 1 — the run is red because netball failed', c.code === 1, `exit ${c.code}`);
    ck('the BASKETBALL alert still went out', c.pushes.some(p => /^\[Basketball\]/.test(p.title) && /time 09:00 → 14:30/.test(p.message)), JSON.stringify(c.titles()));
    ck('and its state still advanced', c.stateOf(`${T1}.json`).games.g1.t === '14:30');
    ck('the netball error is reported separately', c.pushes.some(p => /blocked \(WAF\)/.test(p.message)), JSON.stringify(c.pushes.map(p => p.message)));
    ck('netball state was not advanced', !c.stateOf('_netball.json').lastSuccess);
  },
},

{
  name: '40 netball PUBLIC-REPO LEAK CHECK — nothing identifying in state or the log',
  cfg: ncCfg(), env: NC_ENV, net: ncNet(),
  state: ncState(ncSeeded(st => { delete st.players.p1.teams[ncKeyT('227878')]; })),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('an alert did fire, so this is not vacuous', c.pushes.length === 1, JSON.stringify(c.titles()));
    const stateText = JSON.stringify(c.stateOf('_netball.json'));
    const haystacks = { 'committed state': stateText, 'the Actions log': c.stdout };
    // Spec test 13. The child's NAME is allowed in a Pushover message and nowhere
    // else — it must not reach the log or the repo.
    const banned = ['15890707', '15890708', 'Penny', 'parent@example.com', 'BWSA',
                    'NCTOKEN-abc123', 'harness-pw', '227878', '256686', 'dateOfBirth',
                    'paidBy', 'A Parent Name', '1 Example St'];
    for (const [where, hay] of Object.entries(haystacks)) {
      for (const b of banned) ck(`${b} is not in ${where}`, hay.indexOf(b) === -1, `found "${b}"`);
      for (const r of NC_ROWS) ck(`registrationId is not in ${where}`, hay.indexOf(r.registrationId) === -1, r.registrationId);
    }
    // ⚠️ THE STATE FILE MUST HOLD NO UUID AT ALL — every key in it is an HMAC.
    ck('no UUID anywhere in the netball state', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(stateText), stateText.slice(0, 200));
    // The log is a weaker claim ON PURPOSE. It carries the PlayHQ player uuid,
    // which the watcher has always printed and which is public anyway — it is in
    // the committed watch.json and in every StatTrack URL. The netball ids above
    // are the ones that must never appear, and they don't.
    ck('the only uuid in the log is the public PlayHQ one',
      (c.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])
        .every(u => u.toLowerCase() === UUID.toLowerCase()),
      JSON.stringify([...new Set(c.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])]));
    ck('the name IS in the Pushover message, which is allowed', /Penny/.test(c.pushes[0].title), c.pushes[0].title);
    ck('state is keyed by alias', !!c.stateOf('_netball.json').players.p1);
  },
},

{
  name: '41 netball Teams-tab canary — silent at zero, one message when it wakes',
  cfg: ncCfg(), env: NC_ENV, state: ncState(ncSeeded()), net: ncNet({ teamsTabTotal: 3 }),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('one canary message', c.pushes.length === 1 && /Teams tab now returns data/.test(c.pushes[0].title), JSON.stringify(c.titles()));
    ck('and it is recorded so it never fires twice', c.stateOf('_netball.json').players.p1.teamsTabNonEmpty === true);
  },
},

{
  name: '42 netball cadence gate — not due means not even a login',
  cfg: ncCfg({ checkEveryHours: 6 }), env: NC_ENV, net: ncNet(),
  state: ncState(ncSeeded(st => { st.lastAttempt = new Date(Date.now() - 60 * 1000).toISOString(); })),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    // ⚠️ The gate is on the last ATTEMPT, not the last success — otherwise a wrong
    // password would be retried every half hour into an account lockout.
    ck('NO Netball Connect calls at all', c.nc.length === 0, JSON.stringify(c.nc));
    ck('the log says not due', /Netball Connect — not due/.test(c.stdout), c.stdout.slice(-600));
    ck('no alerts', c.pushes.length === 0, JSON.stringify(c.titles()));
  },
},

{
  name: '43 netball cadence — 30 min when healthy, 6 h only after an error',
  cfg: ncCfg({ checkEveryMinutes: 30, errorBackoffMinutes: 360 }), env: NC_ENV, net: ncNet(),
  // Healthy, last attempt 45 min ago: due.
  state: ncState(ncSeeded(st => { st.lastAttempt = new Date(Date.now() - 45 * 60 * 1000).toISOString(); })),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('it checked — 45 min is past the healthy 30', c.nc.some(x => x.call === 'login'), JSON.stringify(c.nc));
    ck('the banner names the healthy interval', /every 30 min ══/.test(c.stdout), c.stdout.slice(-900));
  },
},

{
  name: '44 netball error backoff — a failed login is not retried for 6 hours',
  cfg: ncCfg({ checkEveryMinutes: 30, errorBackoffMinutes: 360 }), env: NC_ENV, net: ncNet(),
  // Same 45 minutes, but the last run failed. The long interval applies.
  state: ncState(ncSeeded(st => {
    st.lastAttempt = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    st.lastError = { reason: 'login: rejected (wrong email/password?)', firstSeen: new Date(Date.now() - 45 * 60 * 1000).toISOString(), lastAlertAt: new Date(Date.now() - 45 * 60 * 1000).toISOString() };
  })),
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    // ⚠️ THE WHOLE POINT. Frequent successful logins are harmless; repeated FAILED
    // ones lock the account. So the backoff hangs off lastError, not off time alone.
    ck('NO login attempt while backed off', c.nc.length === 0, JSON.stringify(c.nc));
    ck('the log says it is backed off', /BACKED OFF after an error/.test(c.stdout), c.stdout.slice(-700));
    ck('no alerts', c.pushes.length === 0, JSON.stringify(c.titles()));
  },
},

];

// ═══════════════════════════════════════════════════════════════════════════
unitTests();
const todo = SCENARIOS.filter(s => !ONLY.length || ONLY.some(f => s.name.includes(f)));
for (const s of todo) {
  process.stdout.write(`▶ ${s.name}\n`);
  run(s);
}

console.log(`\n${'─'.repeat(72)}`);
if (failed) {
  console.log(`FAILED — ${passed} assertion(s) passed, ${failed} FAILED:\n`);
  for (const p of problems) console.log(`  ✖ ${p}`);
  process.exit(1);
}
console.log(`All ${passed} assertions passed across ${todo.length} scenario(s) and the link unit tests.`);
