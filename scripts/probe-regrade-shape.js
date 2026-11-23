// scripts/probe-regrade-shape.js
//
// READ-ONLY probe. Makes no PlayHQ calls, writes no repo data, runs no git.
// Answers the three questions that decide whether a regrade-flow diagram can be
// built, and answers them from real season files rather than from assumption:
//
//   Q1  Are grading-phase games actually stored in games/bv, and do games carry
//       a grade id at all?
//   Q2  Is there a usable week axis? (rn is a round NAME, not a number — so the
//       date field is the candidate, and this probe DISCOVERS which key holds it
//       rather than assuming a name.)
//   Q3  How many teams change grade mid-season, in which weeks, and what shape
//       do the grade names take?
//
// It prints a full summary to the log and writes reports/regrade-probe.json.
// Nothing downstream reads that report, so it is an artifact, not a commit.
//
// Usage:
//   node scripts/probe-regrade-shape.js --seasons=1ae60211,aacc7335,7ccb2e98
//   node scripts/probe-regrade-shape.js --seasons=<full-uuid> --samples=5
//
// Season tokens may be full ids or unique prefixes; a prefix matching more than
// one season file is reported and skipped rather than guessed at.

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const TEAMSTATS   = path.join(ROOT, 'team-stats', 'bv');
const INDEX_FILE  = path.join(ROOT, 'data', 'sports-index.json');
const REPORT_DIR  = path.join(ROOT, 'reports');
const REPORT_FILE = path.join(REPORT_DIR, 'regrade-probe.json');

// v2 REPLACES v1, which crashed on `index.seasons` because it assumed an array.
// Container shapes are now DISCOVERED and printed, never assumed.
const VERSION = 'probe-regrade-shape v2 (2026-11-23)';

// ---------------------------------------------------------------- args

function arg(name, dflt) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const SEASON_TOKENS = String(arg('seasons', ''))
  .split(',').map(s => s.trim()).filter(Boolean);
const SAMPLES      = Number(arg('samples', 3));
const MAX_EXAMPLES = Number(arg('examples', 8));

if (!SEASON_TOKENS.length) {
  console.error('FATAL: --seasons is required (comma-separated ids or unique prefixes).');
  process.exit(2);
}

// ---------------------------------------------------------------- helpers

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A collection in this repo may be an ARRAY or an OBJECT keyed by id, and the
// project docs record a record's FIELDS without recording its container. So
// never assume: take both, and report which one was found. Returns
// { shape, list } where list is always an array of records, each carrying an id.
function asRecordList(value, idKey) {
  if (Array.isArray(value)) {
    return { shape: 'array', list: value.filter(v => v && typeof v === 'object') };
  }
  if (value && typeof value === 'object') {
    const list = [];
    for (const [k, v] of Object.entries(value)) {
      if (!v || typeof v !== 'object') continue;
      list.push(v[idKey] ? v : Object.assign({}, v, { [idKey]: k }));
    }
    return { shape: 'object keyed by id', list };
  }
  return { shape: value === undefined ? 'ABSENT' : `UNUSABLE (${typeof value})`, list: [] };
}

// Never parse a date string with new Date(). Build from parts, then do the
// day-of-week arithmetic on a UTC timestamp.
function weekStart(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const dow = new Date(t).getUTCDay();          // 0 = Sunday
  const back = (dow + 6) % 7;                   // → preceding Monday
  return new Date(t - back * 86400000).toISOString().slice(0, 10);
}

const isIsoDateish = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);

// T44 — a game carries h/a OR t1/t2 and NEVER both. Either may be a bare id or
// an object. Anything else is reported, never coerced.
function sideIds(g) {
  const pick = v => {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return v.id || v.tid || null;
    return null;
  };
  const home = pick(g.h) != null ? pick(g.h) : pick(g.t1);
  const away = pick(g.a) != null ? pick(g.a) : pick(g.t2);
  return { home, away };
}

function tally(map, key) {
  if (key == null) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => ({ value: k, count: v }));
}

function pct(n, d) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a';
}

// Strip a leading age/gender description off a grade name and return what is
// left. This is for GROUPING and for spotting grading grades. It deliberately
// produces NO strength ordering — rank is the viewer's to judge, not ours.
function gradeSuffix(name) {
  if (!name) return null;
  let s = String(name).trim();
  s = s.replace(/^(boys|girls|mens?|womens?|mixed|open)\s+/i, '');
  s = s.replace(/^(u|under\s*)\d{1,2}\s*/i, '');
  s = s.replace(/^(boys|girls|mens?|womens?|mixed|open)\s+/i, '');
  return s.trim() || null;
}

const isGradingName = name => /\bgrading\b/i.test(String(name || ''));

// ---------------------------------------------------------------- season resolution

function resolveSeasons(tokens) {
  if (!fs.existsSync(GAMES_DIR)) {
    console.error(`FATAL: ${GAMES_DIR} does not exist.`);
    process.exit(2);
  }
  const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
  const ids = files.map(f => f.slice(0, -5));
  const out = [];
  for (const tok of tokens) {
    const hits = ids.filter(id => id === tok || id.startsWith(tok));
    if (hits.length === 1) out.push({ token: tok, sid: hits[0] });
    else if (hits.length === 0) out.push({ token: tok, sid: null, why: 'no games/bv file matches' });
    else out.push({ token: tok, sid: null, why: `ambiguous — ${hits.length} matches: ${hits.slice(0, 5).join(', ')}` });
  }
  return out;
}

// ---------------------------------------------------------------- per-season probe

function probeSeason(sid, indexSeason) {
  const out = { sid, name: indexSeason ? indexSeason.fullName || indexSeason.name : null };

  // --- grade names, from two independent sources -------------------------
  const gradeFromIndex = new Map();   // gid -> {name, age, gender}
  const gradesFound = asRecordList(indexSeason && indexSeason.grades, 'id');
  out.gradesContainer = gradesFound.shape;
  for (const g of gradesFound.list) {
    if (g && g.id) gradeFromIndex.set(g.id, { name: g.name, age: g.age, gender: g.gender });
  }

  // team-stats meta carries {gid, grade} for a team's MOST RECENT game, which
  // gives a second gid→name source for grades the index list has lost.
  const gradeFromTeamStats = new Map();
  const teamName = new Map();
  const tsFile = path.join(TEAMSTATS, `${sid}.json`);
  out.teamStatsPresent = fs.existsSync(tsFile);
  if (out.teamStatsPresent) {
    try {
      const ts = readJson(tsFile);
      for (const [tid, rec] of Object.entries(ts || {})) {
        const meta = rec && rec.meta;
        if (!meta) continue;
        if (meta.name) teamName.set(tid, meta.name);
        if (meta.gid && meta.grade && !gradeFromTeamStats.has(meta.gid)) {
          gradeFromTeamStats.set(meta.gid, meta.grade);
        }
      }
    } catch (e) {
      out.teamStatsError = String(e.message || e);
    }
  }

  const gradeName = gid => {
    const fromIdx = gradeFromIndex.get(gid);
    if (fromIdx && fromIdx.name) return fromIdx.name;
    if (gradeFromTeamStats.has(gid)) return gradeFromTeamStats.get(gid);
    return null;
  };
  const gradeAge = gid => {
    const fromIdx = gradeFromIndex.get(gid);
    return (fromIdx && fromIdx.age) || null;
  };

  // --- load games --------------------------------------------------------
  const file = path.join(GAMES_DIR, `${sid}.json`);
  let raw;
  try {
    raw = readJson(file);
  } catch (e) {
    out.fatal = `could not read/parse ${file}: ${e.message || e}`;
    return out;
  }

  let gamesMap = null;
  if (raw && typeof raw.games === 'object' && raw.games) {
    gamesMap = raw.games;
    out.container = 'raw.games';
  } else if (raw && typeof raw === 'object') {
    // Report rather than silently accept a different container shape.
    gamesMap = raw;
    out.container = 'FLAT OBJECT — raw.games absent; treated the file itself as the map. VERIFY THIS.';
  }
  const games = Object.entries(gamesMap || {});
  out.gameCount = games.length;
  out.topLevelKeys = Object.keys(raw || {}).slice(0, 20);
  if (!games.length) { out.fatal = 'no games in file'; return out; }

  // --- Q2a: key tally + date-key discovery -------------------------------
  const keyCount = new Map();
  const isoCount = new Map();
  const isoExample = new Map();
  for (const [, g] of games) {
    if (!g || typeof g !== 'object') continue;
    for (const [k, v] of Object.entries(g)) {
      if (v === null || v === undefined || v === '') continue;
      tally(keyCount, k);
      if (isIsoDateish(v)) {
        tally(isoCount, k);
        if (!isoExample.has(k)) isoExample.set(k, v);
      }
    }
  }
  out.keyCoverage = [...keyCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => ({ key: k, present: n, coverage: pct(n, games.length) }));

  out.dateCandidates = [...isoCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => ({ key: k, present: n, coverage: pct(n, games.length), example: isoExample.get(k) }));

  const DATE_KEY = out.dateCandidates.length ? out.dateCandidates[0].key : null;
  out.dateKeyChosen = DATE_KEY;

  // --- samples (p/hp/ap stripped — they are long and carry person ids) ----
  out.samples = games.slice(0, SAMPLES).map(([gid, g]) => {
    const copy = {};
    for (const [k, v] of Object.entries(g || {})) {
      if (k === 'p' || k === 'hp' || k === 'ap') { copy[k] = `[${Array.isArray(v) ? v.length : '?'} entries, omitted]`; continue; }
      copy[k] = v;
    }
    return { gameId: gid, game: copy };
  });

  // --- Q1: grade-id coverage and grading-phase presence ------------------
  let withGid = 0, gidUnknown = 0, gradingGames = 0;
  const gidSeen = new Map();
  const statusCount = new Map();
  const roundNames = new Map();
  const unknownGidExamples = [];
  for (const [id, g] of games) {
    if (!g) continue;
    tally(statusCount, g.st || g.status || '(no status key)');
    tally(roundNames, g.rn == null ? '(no rn)' : String(g.rn));
    if (g.gid) {
      withGid++;
      tally(gidSeen, g.gid);
      const nm = gradeName(g.gid);
      if (!nm) {
        gidUnknown++;
        if (unknownGidExamples.length < MAX_EXAMPLES) unknownGidExamples.push({ gameId: id, gid: g.gid });
      } else if (isGradingName(nm)) {
        gradingGames++;
      }
    }
  }
  out.gid = {
    gamesWithGid: withGid,
    coverage: pct(withGid, games.length),
    distinctGids: gidSeen.size,
    gidsWithNoResolvableName: gidUnknown,
    unknownGidExamples,
    gamesInAGradeNamedGrading: gradingGames,
    gradesInIndex: gradeFromIndex.size,
    gradesRecoveredFromTeamStats: gradeFromTeamStats.size,
  };
  out.statusDistribution = topN(statusCount, 12);
  out.roundNameCount = roundNames.size;
  out.roundNameExamples = topN(roundNames, 12);
  out.roundNamesNumericParseable = [...roundNames.keys()]
    .filter(n => /\d/.test(n)).length;

  // --- Q2b: the week axis -------------------------------------------------
  if (!DATE_KEY) {
    out.weekAxis = { usable: false, why: 'no ISO-dateish key found on any game — a week axis cannot be built from these files' };
  } else {
    const weeks = new Map();
    let undated = 0;
    for (const [, g] of games) {
      const ws = g && g[DATE_KEY] ? weekStart(g[DATE_KEY]) : null;
      if (!ws) { undated++; continue; }
      tally(weeks, ws);
    }
    const ordered = [...weeks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    out.weekAxis = {
      usable: true,
      dateKey: DATE_KEY,
      distinctWeeks: ordered.length,
      undatedGames: undated,
      undatedShare: pct(undated, games.length),
      firstWeek: ordered.length ? ordered[0][0] : null,
      lastWeek: ordered.length ? ordered[ordered.length - 1][0] : null,
      weeks: ordered.map(([w, n]) => ({ week: w, games: n })),
    };
  }

  // --- Q3: per-team grade sequence, and where the changes land -----------
  // A regrade is the same tid appearing under a different gid in a later week.
  const perTeam = new Map();   // tid -> [{week, gid, gameId}]
  let sideUnresolved = 0;
  for (const [id, g] of games) {
    if (!g || !g.gid) continue;
    const ws = DATE_KEY && g[DATE_KEY] ? weekStart(g[DATE_KEY]) : null;
    const { home, away } = sideIds(g);
    for (const tid of [home, away]) {
      if (!tid) { sideUnresolved++; continue; }
      if (!perTeam.has(tid)) perTeam.set(tid, []);
      perTeam.get(tid).push({ week: ws, gid: g.gid, gameId: id });
    }
  }
  out.sidesUnresolved = sideUnresolved;
  out.teamCount = perTeam.size;

  const distinctGidDist = new Map();
  const movers = [];
  const noTransition = [];
  let sameWeekTwoGrades = 0;
  const sameWeekExamples = [];
  const changeWeeks = new Map();           // week -> number of teams changing
  const changesByAge = new Map();          // age -> Map(week -> count)

  for (const [tid, rowsRaw] of perTeam.entries()) {
    const rows = rowsRaw.slice().sort((a, b) => {
      if (a.week && b.week && a.week !== b.week) return a.week < b.week ? -1 : 1;
      if (a.week && !b.week) return -1;
      if (!a.week && b.week) return 1;
      return 0;
    });
    const distinct = new Set(rows.map(r => r.gid));
    tally(distinctGidDist, distinct.size);

    // same week under two grades — an anomaly worth seeing, not smoothing over
    const byWeek = new Map();
    for (const r of rows) {
      if (!r.week) continue;
      if (!byWeek.has(r.week)) byWeek.set(r.week, new Set());
      byWeek.get(r.week).add(r.gid);
    }
    for (const [w, set] of byWeek.entries()) {
      if (set.size > 1) {
        sameWeekTwoGrades++;
        if (sameWeekExamples.length < MAX_EXAMPLES) {
          sameWeekExamples.push({ tid, team: teamName.get(tid) || null, week: w, gids: [...set] });
        }
      }
    }

    if (distinct.size <= 1) continue;

    // collapse to one grade per week (first seen), then read the transitions
    const seq = [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([w, set]) => ({ week: w, gid: [...set][0] }));
    const hops = [];
    for (let i = 1; i < seq.length; i++) {
      if (seq[i].gid !== seq[i - 1].gid) {
        hops.push({ week: seq[i].week, from: seq[i - 1].gid, to: seq[i].gid });
        tally(changeWeeks, seq[i].week);
        const age = gradeAge(seq[i].gid) || gradeAge(seq[i - 1].gid) || '(unknown age)';
        if (!changesByAge.has(age)) changesByAge.set(age, new Map());
        tally(changesByAge.get(age), seq[i].week);
      }
    }
    const rec = {
      tid,
      team: teamName.get(tid) || null,
      distinctGrades: distinct.size,
      hops: hops.map(h => ({
        week: h.week,
        from: gradeName(h.from) || h.from,
        to: gradeName(h.to) || h.to,
      })),
    };
    // Several grades but no week-to-week transition means the grades sit inside
    // one week, or the games are undated. That is a distinct finding, not a
    // mover, and the diagram has to decide what to draw for it.
    if (hops.length) movers.push(rec);
    else noTransition.push(rec);
  }

  out.distinctGradesPerTeam = [...distinctGidDist.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, teams]) => ({ distinctGrades: n, teams }));
  out.teamsThatChangedGrade = movers.length;
  out.teamsThatChangedGradeShare = pct(movers.length, perTeam.size);
  out.teamsMultiGradeNoTransition = noTransition.length;
  out.teamsMultiGradeNoTransitionExamples = noTransition.slice(0, MAX_EXAMPLES);
  out.teamWeeksInTwoGrades = sameWeekTwoGrades;
  out.teamWeeksInTwoGradesExamples = sameWeekExamples;
  out.moverExamples = movers.slice(0, MAX_EXAMPLES);

  const cw = [...changeWeeks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  out.changeWeeks = cw.map(([w, n]) => ({ week: w, teamsChanging: n }));
  out.columnsThatWouldBeDrawn = cw.length;
  out.changeWeeksByAgeGroup = [...changesByAge.entries()].map(([age, m]) => ({
    age,
    weeks: [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([w, n]) => ({ week: w, teamsChanging: n })),
  }));

  // --- grade name shapes (for grouping only — NO strength ordering) ------
  const names = new Map();
  for (const gid of gidSeen.keys()) {
    const nm = gradeName(gid);
    if (!nm) continue;
    names.set(gid, nm);
  }
  const suffixes = new Map();
  for (const nm of names.values()) tally(suffixes, gradeSuffix(nm) || '(empty after stripping)');
  out.gradeNames = {
    resolvable: names.size,
    ofDistinctGids: gidSeen.size,
    gradingGrades: [...names.values()].filter(isGradingName).length,
    suffixShapes: topN(suffixes, 25),
    examples: [...names.values()].slice(0, MAX_EXAMPLES),
  };

  return out;
}

// ---------------------------------------------------------------- main

function main() {
  console.log(VERSION);
  console.log(`ROOT: ${ROOT}`);

  let index = null;
  try {
    index = readJson(INDEX_FILE);
  } catch (e) {
    console.error(`FATAL: could not read ${INDEX_FILE}: ${e.message || e}`);
    process.exit(2);
  }
  console.log(`sports-index top-level keys: ${Object.keys(index || {}).join(', ') || '(none)'}`);
  const seasonsFound = asRecordList(index && index.seasons, 'id');
  console.log(`sports-index seasons container: ${seasonsFound.shape}`);
  const seasonById = new Map();
  for (const s of seasonsFound.list) if (s && s.id) seasonById.set(s.id, s);
  console.log(`sports-index: ${seasonById.size} seasons\n`);
  if (!seasonById.size) {
    // A shape we cannot read is a failure, not an empty answer.
    console.error('FATAL: no seasons readable from data/sports-index.json — see the container line above.');
    process.exit(2);
  }

  const resolved = resolveSeasons(SEASON_TOKENS);
  const report = { version: VERSION, generatedAt: new Date().toISOString(), seasons: [] };
  let failed = 0;

  for (const r of resolved) {
    console.log('='.repeat(78));
    if (!r.sid) {
      console.log(`SEASON TOKEN "${r.token}" — NOT RESOLVED: ${r.why}`);
      report.seasons.push({ token: r.token, resolved: false, why: r.why });
      failed++;
      continue;
    }
    const meta = seasonById.get(r.sid) || null;
    console.log(`SEASON ${r.sid}`);
    console.log(`  token    : ${r.token}`);
    console.log(`  name     : ${meta ? (meta.fullName || meta.name) : '(NOT IN sports-index.json)'}`);
    console.log(`  locked   : ${meta ? meta.locked : '?'}   status: ${meta ? meta.status : '?'}`);

    const res = probeSeason(r.sid, meta);
    res.token = r.token;
    res.resolved = true;
    report.seasons.push(res);

    if (res.fatal) {
      console.log(`  FATAL: ${res.fatal}`);
      failed++;
      continue;
    }

    console.log(`  container: ${res.container}`);
    console.log(`  games    : ${res.gameCount}`);
    console.log('');
    console.log('  --- Q1  grade ids and grading phase ---');
    console.log(`  games carrying gid        : ${res.gid.gamesWithGid} (${res.gid.coverage})`);
    console.log(`  distinct gids in games    : ${res.gid.distinctGids}`);
    console.log(`  grades in sports-index    : ${res.gid.gradesInIndex}   (container: ${res.gradesContainer})`);
    console.log(`  grades from team-stats    : ${res.gid.gradesRecoveredFromTeamStats}${res.teamStatsPresent ? '' : '   (team-stats file ABSENT)'}`);
    console.log(`  gids with NO name         : ${res.gid.gidsWithNoResolvableName}`);
    console.log(`  games in a "Grading" grade: ${res.gid.gamesInAGradeNamedGrading}`);
    if (res.gid.unknownGidExamples.length) {
      console.log(`  unnamed gid examples      : ${res.gid.unknownGidExamples.map(e => e.gid).join(', ')}`);
    }
    console.log('');
    console.log('  --- Q2  the week axis ---');
    console.log(`  ISO-dateish keys found    : ${res.dateCandidates.map(d => `${d.key} (${d.coverage}, e.g. ${d.example})`).join(' | ') || 'NONE'}`);
    console.log(`  key chosen                : ${res.dateKeyChosen || 'NONE'}`);
    if (res.weekAxis.usable) {
      console.log(`  distinct weeks            : ${res.weekAxis.distinctWeeks}  (${res.weekAxis.firstWeek} .. ${res.weekAxis.lastWeek})`);
      console.log(`  undated games             : ${res.weekAxis.undatedGames} (${res.weekAxis.undatedShare})`);
    } else {
      console.log(`  UNUSABLE: ${res.weekAxis.why}`);
    }
    console.log(`  distinct round names      : ${res.roundNameCount}  (${res.roundNamesNumericParseable} contain a digit)`);
    console.log(`  round name examples       : ${res.roundNameExamples.slice(0, 6).map(e => `${e.value}×${e.count}`).join(', ')}`);
    console.log(`  status distribution       : ${res.statusDistribution.map(e => `${e.value}×${e.count}`).join(', ')}`);
    console.log('');
    console.log('  --- Q3  regrades ---');
    console.log(`  teams seen                : ${res.teamCount}   (unresolved sides: ${res.sidesUnresolved})`);
    console.log(`  teams changing grade      : ${res.teamsThatChangedGrade} (${res.teamsThatChangedGradeShare})`);
    console.log(`  distinct grades per team  : ${res.distinctGradesPerTeam.map(d => `${d.distinctGrades}→${d.teams}`).join(', ')}`);
    console.log(`  multi-grade, NO transition: ${res.teamsMultiGradeNoTransition}   (grades inside one week, or undated games)`);
    console.log(`  team-weeks in 2+ grades   : ${res.teamWeeksInTwoGrades}`);
    console.log(`  COLUMNS THAT WOULD DRAW   : ${res.columnsThatWouldBeDrawn}`);
    if (res.changeWeeks.length) {
      console.log(`  change weeks              : ${res.changeWeeks.map(c => `${c.week}(${c.teamsChanging})`).join(', ')}`);
    }
    for (const ag of res.changeWeeksByAgeGroup.slice(0, 12)) {
      console.log(`    ${String(ag.age).padEnd(8)} : ${ag.weeks.map(w => `${w.week}(${w.teamsChanging})`).join(', ')}`);
    }
    if (res.moverExamples.length) {
      console.log('  example movers:');
      for (const m of res.moverExamples) {
        console.log(`    ${m.team || m.tid}: ${m.hops.map(h => `${h.week} ${h.from} → ${h.to}`).join(' ; ')}`);
      }
    }
    console.log('');
    console.log('  --- grade name shapes (grouping only, no strength order) ---');
    console.log(`  names resolvable          : ${res.gradeNames.resolvable} of ${res.gradeNames.ofDistinctGids} gids`);
    console.log(`  grading grades            : ${res.gradeNames.gradingGrades}`);
    console.log(`  suffix shapes             : ${res.gradeNames.suffixShapes.map(s => `${s.value}×${s.count}`).join(', ')}`);
    console.log(`  full name examples        : ${res.gradeNames.examples.join(' | ')}`);
    console.log('');
    console.log('  --- sample game records (p/hp/ap omitted) ---');
    for (const s of res.samples) {
      console.log(`    ${s.gameId}: ${JSON.stringify(s.game)}`);
    }
    console.log('');
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log('='.repeat(78));
  console.log(`Report written: ${path.relative(ROOT, REPORT_FILE)}`);
  console.log(`Seasons probed OK: ${resolved.length - failed} of ${resolved.length}`);

  // A season that could not be probed is a failure, not an empty answer.
  if (failed) {
    console.error(`\nFAILED on ${failed} season token(s) — see above.`);
    process.exit(1);
  }
}

main();
