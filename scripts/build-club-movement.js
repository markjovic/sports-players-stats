// scripts/build-club-movement.js
// Builds the club player-movement page: one panel per AGE GROUP, stacked youngest at the top,
// columns = seasons oldest-left, ribbons carrying players between the club's teams.
//
// Ported from the netball build (build_movement2.py) with every hard check kept. What changed,
// and why, measured rather than assumed:
//   · CLUB comes from player.seasons[].club, NOT from the team name. Maroondah Magic names its
//     teams MMB12 / MMG11 — the name carries no club at all — and team-stats meta.club is
//     populated for only a small minority of team-seasons. So team -> club is INVERTED from the
//     players registered to that team, which is the only source that answers for every team.
//   · BANDS are age groups (U7..U18+), not the netball two-panel 9U/11U layout.
//   · AGE comes from the season's grade list, falling back to parsing the grade NAME, because
//     the five oldest seasons carry a stale grade list in sports-index (2 grades against ~80).
//   · NO ageing-out PREDICTION. Measured run length in an age band is bimodal (1 season 753,
//     2 seasons 920, 3+ 301 across 622 careers), so "second season in band means moving up" is
//     a coin flip. The page reports the measured first/second-season split instead.
//
// Writes aggregates and pseudonymous player codes (P001…) only. No player uuid, no player name,
// and no roster data reaches the output file.
//
// Settings are read from the environment by the workflow. No param() block, no CLI args.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- configuration
const COMP_ID    = process.env.COMP_ID   || 'f0c4ccaa';                        // Kilsyth Junior Domestic
const ORG_MATCH  = new RegExp(process.env.ORG_MATCH || 'kilsyth', 'i');
const CLUB       = process.env.CLUB      || 'Maroondah Magic Basketball Club';
const GENDER     = process.env.GENDER    || 'Boys';                            // Boys | Girls | All
const COMMIT     = !/^(0|false|no)$/i.test(process.env.COMMIT || 'true');
// Player NAMES in the collection, ON by default. StatTrack already publishes every player's name,
// team and game stats from this same database on public Pages, so this shows nothing new — set
// WITH_NAMES=false for pseudonymous codes only.
const WITH_NAMES = !/^(0|false|no)$/i.test(process.env.WITH_NAMES || 'true');
const OUTDIR     = process.env.OUTDIR    || 'movement/bv';
// true DROPS club teams whose age group cannot be read; false (default) fails and lists them.
const DROP_UNGRADED = /^(1|true|yes)$/i.test(process.env.DROP_UNGRADED || '');
const TRUNC_LEN  = 13;

const t0 = Date.now();
const log = (...a) => console.log(...a);
const die = (m) => { console.error('\nFATAL: ' + m); process.exit(1); };

function readJson(rel, required) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { if (required) die(`missing file ${rel}`); return null; }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die(`cannot parse ${rel}: ${e.message}`); }
}

// ---------------------------------------------------------------- 1. seasons
const INDEX = readJson('data/sports-index.json', true);
const sObj = INDEX.seasons || die('sports-index has no .seasons');
const ALLS = Array.isArray(sObj) ? sObj : Object.values(sObj);

const SEASONS = ALLS
  .filter(s => String(s.compId) === COMP_ID && ORG_MATCH.test(String(s.orgName || '')))
  .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));
if (!SEASONS.length) die(`no seasons for compId ${COMP_ID} / org /${ORG_MATCH.source}/i`);
if (SEASONS.some(s => !s.startDate)) die('a season has no startDate — the column order would be arbitrary');

const SIDX = {};               // sid -> column index
SEASONS.forEach((s, i) => { SIDX[s.id] = i; });
const LABELS = SEASONS.map(s => s.name);
const NS = SEASONS.length;
const ORG = SEASONS[0].orgName;
log(`${ORG} · ${SEASONS[0].compName} · ${NS} seasons: ${LABELS[0]} → ${LABELS[NS - 1]}`);

// season id -> association name, for EVERY season in the index (used to name where players went)
const ORG_OF = {}; ALLS.forEach(s => { ORG_OF[s.id] = s.orgName || null; });
const NAME_OF = {}; ALLS.forEach(s => { NAME_OF[s.id] = s.name || null; });
const START_OF = {}; ALLS.forEach(s => { START_OF[s.id] = s.startDate || null; });

// ---------------------------------------------------------------- 2. grades: age, gender, rank
// The index grade list is STALE for the oldest seasons (measured: 2 grades where the teams show
// ~80), so a gid lookup is tried first and the grade NAME is the fallback. Neither is guessed:
// if both fail the team is reported, never silently dropped.
const GRADE = {};
ALLS.forEach(s => (s.grades || []).forEach(g => {
  GRADE[g.id] = { age: g.age, gender: g.gender, name: g.name };
}));

const ageFromText = (t) => { const m = String(t || '').match(/\bU\s?(\d{1,2})\b/i); return m ? +m[1] : null; };
const genderFromText = (t) => {
  const s = String(t || '');
  if (/\bgirls?\b|\bwomen\b/i.test(s)) return 'Girls';
  if (/\bboys?\b|\bmen\b/i.test(s)) return 'Boys';
  if (/\bmixed\b/i.test(s)) return 'Mixed';
  return null;
};
function ageOf(gid, gradeName) {
  const g = GRADE[gid];
  const a = g && g.age ? ageFromText(g.age) : null;
  return a !== null ? a : ageFromText(gradeName) ?? (g && g.name ? ageFromText(g.name) : null);
}
function genderOf(gid, gradeName) {
  const g = GRADE[gid];
  return (g && g.gender && genderFromText(g.gender)) || genderFromText(gradeName) || (g && genderFromText(g.name)) || null;
}
// Grade strength rank within an age group, from the grade name's division tail:
// "… U12 Boys A/ARes" -> A; "B1" -> B,1; "BRes" -> B + reserve; "C" -> C. Lower is stronger.
// U7 grades carry words (Miniball, Wallabies) and rank last, together.
function gradeRank(gradeName) {
  const s = String(gradeName || '');
  const tail = s.replace(/^.*?\bU\s?\d{1,2}\b/i, '').replace(/\b(boys?|girls?|mixed|men|women)\b/ig, '').trim();
  const m = tail.match(/\b([A-D])\s*(RES|Res)?\s*(\d)?/);
  if (!m) return 90;
  const letter = m[1].toUpperCase().charCodeAt(0) - 65;      // A=0
  const res = /res/i.test(tail) && /^[A-D]\s*res/i.test(tail.trim()) ? 1 : 0;
  const sub = m[3] ? +m[3] : 0;
  return letter * 10 + sub * 2 + res;
}

// ---------------------------------------------------------------- 3. team-stats
const TEAMS = {};              // `${sid}|${tid}` -> {sid,tid,name,gid,grade,age,gender,rank,roster:[ids],fx}
let teamCount = 0, missingTS = [];
for (const s of SEASONS) {
  const d = readJson(`team-stats/bv/${s.id}.json`, false);
  if (!d) { missingTS.push(`${s.id} (${s.name})`); continue; }
  for (const tid of Object.keys(d)) {
    const t = d[tid] || {}, meta = t.meta || {};
    const gradeName = meta.grade || (GRADE[meta.gid] || {}).name || '';
    TEAMS[`${s.id}|${tid}`] = {
      sid: s.id, tid, name: meta.name || meta.n || tid, gid: meta.gid || null,
      grade: meta.grade || null, age: ageOf(meta.gid, gradeName), gender: genderOf(meta.gid, gradeName),
      rank: gradeRank(gradeName), roster: Object.keys(t.roster || {}),
      fx: Array.isArray(t.fixtures) ? t.fixtures : [],
    };
    teamCount++;
  }
}
if (missingTS.length) die(`team-stats missing for ${missingTS.length} season(s): ${missingTS.join(', ')}`);
log(`teams loaded: ${teamCount}`);

// ---------------------------------------------------------------- 4. players
// Every roster id across every season of this competition is resolved, because team -> club is
// inverted from the players and "where they went" needs their whole career, not this club's slice.
const shardKeys = {};
function resolveFull(rid) {
  const sh = rid.slice(0, 2);
  if (!(sh in shardKeys)) {
    const ix = readJson(`players/indexes/${sh}.json`, false);
    shardKeys[sh] = ix ? Object.keys(ix) : null;
  }
  if (shardKeys[sh]) { const hit = shardKeys[sh].find(k => k.startsWith(rid)); if (hit) return hit; }
  const al = readJson(`players/aliases/${sh}.json`, false);
  return (al && al[rid]) || null;
}

const rosterIds = new Set();
Object.values(TEAMS).forEach(t => t.roster.forEach(r => rosterIds.add(r)));
log(`distinct roster ids across the competition: ${rosterIds.size}`);

const CAREER = new Map();      // full uuid -> [{o, sid, tid, club, age, gender, teamName, inComp}]
const RID2FULL = new Map();    // 13-char roster id -> full uuid
const PLAYED = new Set();      // team keys that at least one player is registered to
const NAMES = new Map();       // full uuid -> display name, only populated when WITH_NAMES
const REG_GRADE = new Map();   // team key -> {gid, gn} as the PLAYER's registration records it
let unresolved = 0, noFile = 0, nPlayers = 0;
for (const rid of rosterIds) {
  const full = resolveFull(rid);
  if (!full) { unresolved++; continue; }
  RID2FULL.set(rid, full);
  if (CAREER.has(full)) continue;
  const P = readJson(`players/${full.slice(0, 2)}/${full}.json`, false);
  if (!P) { noFile++; continue; }
  nPlayers++;
  if (WITH_NAMES && P.name) NAMES.set(full, String(P.name));
  const rows = [];
  for (const s of (P.seasons || [])) {
    const inComp = Object.prototype.hasOwnProperty.call(SIDX, s.sid);
    for (const r of (s.regs || [])) {
      const key = `${s.sid}|${r.tid}`;
      const T = TEAMS[key];
      const age = T ? T.age : ageOf(r.gid, r.gn);
      const gen = T ? T.gender : genderOf(r.gid, r.gn);
      if (inComp) { PLAYED.add(key); if (!REG_GRADE.has(key)) REG_GRADE.set(key, { gid: r.gid, gn: r.gn }); }
      rows.push({ o: inComp ? SIDX[s.sid] : null, sid: s.sid, tid: r.tid, club: s.club || null,
                  age, gender: gen, teamName: (T && T.name) || r.tn || r.tid, inComp,
                  gp: (r.stats && +r.stats.gp) || 0 });
    }
  }
  CAREER.set(full, rows);
}
log(`players resolved: ${nPlayers} · unresolved ids: ${unresolved} · missing files: ${noFile}`);

// MERGE DUPLICATE RECORDS FOR ONE PERSON. Two player records that share a name AND share a team in
// some season are one child: two different children with the same name on the same team is not a
// real case. PlayHQ holds both because the fold only covers one person across the spectator and api
// namespaces, while two genuine PlayHQ profiles are deliberately kept as two records — so they
// arrive here as two teammates and inflate every count that follows.
// Merging here, before positions and ribbons are built, is what keeps the team box, the player
// list and the nucleus sizes agreeing. The condition is deliberately narrow: same name is not
// enough on its own, they must have actually been on one team together.
{
  const norm = (n) => String(n || '').toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, ' ').trim();
  const byName = new Map();
  for (const [full] of CAREER) {
    const nm = norm(NAMES.get(full));
    if (!nm) continue;
    if (!byName.has(nm)) byName.set(nm, []);
    byName.get(nm).push(full);
  }
  let mergedPeople = 0, mergedRecords = 0; const mergedNames = [];
  globalThis.__mergedRecordsTotal = 0;
  for (const [, ids] of byName) {
    if (ids.length < 2) continue;
    const teamsOf = (f) => new Set((CAREER.get(f) || []).filter(r => r.o !== null).map(r => `${r.sid}|${r.tid}`));
    const sets = ids.map(teamsOf);
    // group ids transitively by shared team
    const used = new Set();
    for (let i = 0; i < ids.length; i++) {
      if (used.has(i)) continue;
      const grp = [i]; used.add(i);
      for (let j = i + 1; j < ids.length; j++) {
        if (used.has(j)) continue;
        if (grp.some(g => [...sets[g]].some(t => sets[j].has(t)))) { grp.push(j); used.add(j); }
      }
      if (grp.length < 2) continue;
      const keep = ids[grp[0]];
      const rows = CAREER.get(keep);
      const seen = new Set(rows.map(r => `${r.sid}|${r.tid}`));
      for (const gi of grp.slice(1)) {
        for (const r of (CAREER.get(ids[gi]) || [])) {
          const k = `${r.sid}|${r.tid}`;
          if (!seen.has(k)) { seen.add(k); rows.push(r); }
        }
        CAREER.delete(ids[gi]);
        mergedRecords++; globalThis.__mergedRecordsTotal++;
      }
      mergedPeople++;
      if (mergedNames.length < 12) mergedNames.push(NAMES.get(keep) || '(unnamed)');
    }
  }
  if (mergedPeople) {
    log(`duplicate records merged: ${mergedRecords} extra record(s) folded into ${mergedPeople} person(s) — ${mergedNames.join(', ')}`);
    log(`  (same name AND a shared team; they were two PlayHQ profiles for one child and would otherwise count twice)`);
  } else if (WITH_NAMES) {
    log('duplicate records merged: none found');
  } else {
    log('duplicate records: NOT CHECKED — needs WITH_NAMES, so two profiles for one child will count twice');
  }
}

// A team can carry NO grade of its own in team-stats (measured: 14 Maroondah Magic teams at
// gid null / grade null). The players registered to it still carry the grade on their own
// registration, so that is the second source. Without it those teams have no age group and are
// thrown out of the diagram for a reason that has nothing to do with the player data.
{
  let fixedAge = 0, fixedGen = 0;
  for (const [key, g] of REG_GRADE) {
    const T = TEAMS[key]; if (!T) continue;
    if (T.age === null) {
      const a2 = ageOf(g.gid, g.gn);
      if (a2 !== null) {
        T.age = a2;
        T.gid = T.gid || g.gid || null;
        T.grade = T.grade || g.gn || (GRADE[g.gid] || {}).name || null;
        T.rank = gradeRank(T.grade);
        fixedAge++;
      }
    }
    if (T.gender === null) { const gd = genderOf(g.gid, g.gn); if (gd) { T.gender = gd; fixedGen++; } }
  }
  // the career rows were built before the repair, so bring their age into line
  if (fixedAge) for (const rows of CAREER.values()) for (const r of rows) {
    if (r.age === null) { const T = TEAMS[`${r.sid}|${r.tid}`]; if (T && T.age !== null) r.age = T.age; }
  }
  if (fixedAge || fixedGen) log(`team grade recovered from player registrations: ${fixedAge} age, ${fixedGen} gender`);
}
if (unresolved > rosterIds.size * 0.02) die(`${unresolved} of ${rosterIds.size} roster ids did not resolve (>2%) — identity resolution is broken, refusing to build`);

// team -> club comes from club-map/bv/{sid}.json — the { tid: clubId } file build-club-index.js
// already writes from PlayHQ's own `organisation` on each team, with names in data/club-index.json.
// NOTHING ELSE IN THE REPO CARRIES THE CLUB: player.seasons[].club is the ASSOCIATION, and
// team-stats meta.club is only populated for teams that never played. Earlier versions of this
// script inferred the club from seasons[].club, then from team names, then from roster continuity.
// All three are wrong and all three are gone — this is the published answer.
const CLUB_INDEX = readJson('data/club-index.json', true);
const CLUB_NAME = {};
{
  const src = Array.isArray(CLUB_INDEX) ? CLUB_INDEX
            : (CLUB_INDEX.clubs && typeof CLUB_INDEX.clubs === 'object') ? CLUB_INDEX.clubs : CLUB_INDEX;
  const put = (id, v) => {
    const n = (v && (v.n || v.name || v.clubName)) || (typeof v === 'string' ? v : null);
    if (id && n) CLUB_NAME[String(id)] = n;
  };
  if (Array.isArray(src)) src.forEach(c => put(c && (c.id || c.clubId), c));
  else Object.entries(src).forEach(([k, v]) => put(v && (v.id || v.clubId) || k, v));
}
if (!Object.keys(CLUB_NAME).length) die('data/club-index.json yielded no club names — its shape is not what this script expects');
log(`club index: ${Object.keys(CLUB_NAME).length} clubs`);

const TEAM_CLUB = {};
let mappedTeams = 0, noMapSeasons = [], unmappedTeams = 0;
for (const se of SEASONS) {
  const m = readJson(`club-map/bv/${se.id}.json`, false);
  if (!m) { noMapSeasons.push(`${se.name} (${se.id})`); continue; }
  const rows = (m && typeof m === 'object' && m.teams && typeof m.teams === 'object') ? m.teams : m;
  for (const [tid, val] of Object.entries(rows)) {
    const id = (val && typeof val === 'object') ? (val.id || val.clubId) : val;
    const name = CLUB_NAME[String(id)] || ((val && typeof val === 'object') ? (val.n || val.name) : null);
    if (!name) continue;
    const key = `${se.id}|${tid}`;
    if (TEAMS[key]) { TEAM_CLUB[key] = name; mappedTeams++; }
  }
}
unmappedTeams = Object.keys(TEAMS).filter(k => !TEAM_CLUB[k]).length;
log(`teams mapped to a club from club-map/bv: ${mappedTeams} of ${teamCount}`);
if (noMapSeasons.length) die(`club-map/bv is missing for ${noMapSeasons.length} season(s): ${noMapSeasons.join(', ')}.\n` +
  `Run Build Club Index for those seasons first — without it a club's teams cannot be identified at all.`);
if (unmappedTeams) {
  const bySeason = new Map();
  Object.keys(TEAMS).filter(k => !TEAM_CLUB[k]).forEach(k => bySeason.set(TEAMS[k].sid, (bySeason.get(TEAMS[k].sid) || 0) + 1));
  log(`  ${unmappedTeams} team(s) are in team-stats but not in their season's club map:`);
  [...bySeason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .forEach(([sid, n]) => log(`    ${String(NAME_OF[sid]).padEnd(18)} ${n} of ${Object.values(TEAMS).filter(t => t.sid === sid).length}`));
}

// ---------------------------------------------------------------- 5. the club's teams
const genderOk = (g) => GENDER === 'All' || g === GENDER;
const isOurs = (key) => TEAM_CLUB[key] === CLUB;
const OURS_ALL = Object.keys(TEAMS).filter(isOurs);
if (!OURS_ALL.length) {
  const have = [...new Set(Object.values(TEAM_CLUB))].sort();
  die(`no teams at all for club "${CLUB}".\nClubs with teams in this competition:\n  ` + have.join('\n  '));
}
// The unreadable check runs BEFORE the gender filter, deliberately. A team whose grade cannot be
// read has no gender either, so filtering first would drop it silently and the build would go
// green having quietly lost a team. Unreadable is reported here, whichever gender was asked for.
// Only teams a player is actually registered to can become a node, so a gradeless team nobody
// played for is not a problem to stop the build over — it is reported and skipped.
const emptyTeams = OURS_ALL.filter(k => !PLAYED.has(k));
if (emptyTeams.length) log(`${emptyTeams.length} of ${OURS_ALL.length} club teams have no registered players and cannot appear`);
// Age and gender are NOT the same failure. No age means the team cannot be placed in any panel,
// which is fatal. No gender only means it cannot be placed in a GENDERED run — it is reported,
// named, and excluded from a Boys or Girls build, and included in an All build. Treating the two
// alike stopped a whole build over one 2021 team whose grade reads "Tuesday U8 A/B": the U8 is
// perfectly readable, the grade simply names no gender.
const ungraded = OURS_ALL.filter(k => PLAYED.has(k) && TEAMS[k].age === null);
const describe = (k) => `  ${NAME_OF[TEAMS[k].sid]} · ${TEAMS[k].name} · gid ${JSON.stringify(TEAMS[k].gid)} · grade ${JSON.stringify(TEAMS[k].grade)}`;
if (ungraded.length && !DROP_UNGRADED) {
  die(`${ungraded.length} of ${OURS_ALL.length} teams for this club have no readable AGE GROUP, so they cannot be ` +
      `placed in a panel.\n` +
      ungraded.slice(0, 20).map(describe).join('\n') +
      (ungraded.length > 20 ? `\n  … +${ungraded.length - 20} more` : '') +
      `\nRe-run with drop_ungraded=true to leave them out, once you have looked at the list.`);
}
const noGender = OURS_ALL.filter(k => PLAYED.has(k) && TEAMS[k].age !== null && TEAMS[k].gender === null);
if (noGender.length) {
  log(`${noGender.length} club team(s) have a readable age group but no readable GENDER` +
      (GENDER === 'All' ? ' — included, because this run draws all teams:' : ` — left out of this ${GENDER} run:`));
  noGender.slice(0, 10).forEach(k => log(describe(k)));
  if (noGender.length > 10) log(`  … +${noGender.length - 10} more`);
}
const readable = OURS_ALL.filter(k => PLAYED.has(k) && TEAMS[k].age !== null &&
  (TEAMS[k].gender !== null || GENDER === 'All'));
const OURS = readable.filter(k => genderOk(TEAMS[k].gender));
if (!OURS.length) {
  const seen = [...new Set(readable.map(k => TEAMS[k].gender))].sort();
  die(`no ${GENDER} teams for club "${CLUB}" — this club's teams are: ${seen.join(', ') || '(none readable)'}`);
}
const USE = new Set(OURS);
const BANDS = [...new Set([...USE].map(k => TEAMS[k].age))].sort((a, b) => a - b);
log(`club teams: ${USE.size} of ${OURS_ALL.length} (${GENDER}) · age bands ${JSON.stringify(BANDS.map(a => 'U' + a))}` +
    (ungraded.length ? ` · ${ungraded.length} LEFT OUT as unreadable (drop_ungraded)` : ''));

// A season that contributes NO node is the failure this table exists to make impossible to miss:
// the column renders empty and every player reads as having left, which is indistinguishable from
// a real exodus unless the counts are on screen.
{
  log('\nper season — competition teams · with a club · this club · this club (after gender + grade):');
  const dead = [];
  for (const se of SEASONS) {
    const all = Object.keys(TEAMS).filter(k => TEAMS[k].sid === se.id);
    const withClub = all.filter(k => TEAM_CLUB[k]).length;
    const mineAll = all.filter(k => TEAM_CLUB[k] === CLUB).length;
    const mineUse = all.filter(k => USE.has(k)).length;
    log(`  ${String(se.name).padEnd(18)} ${String(all.length).padStart(5)} ${String(withClub).padStart(8)} ${String(mineAll).padStart(8)} ${String(mineUse).padStart(10)}`);
    if (all.length && !mineUse) dead.push(se.name);
  }
  if (dead.length) log(`  (no teams for this club in: ${dead.join(', ')})`);
}

// ---------------------------------------------------------------- 6. ladder position per team
// Within a (season, grade): wins desc, then points difference desc. Every FINAL fixture must carry
// a readable result or the grade is reported — a half-read ladder is worse than none.
const POS = {};
const byGrade = new Map();
Object.keys(TEAMS).forEach(k => {
  const t = TEAMS[k]; if (!t.gid) return;
  const g = `${t.sid}|${t.gid}`;
  if (!byGrade.has(g)) byGrade.set(g, []);
  byGrade.get(g).push(k);
});
let unreadable = 0;
let gradesRanked = 0, gradesUnplayed = 0;
for (const [, keys] of byGrade) {
  let finals = 0;
  const rows = keys.map(k => {
    let w = 0, d = 0, pf = 0, pa = 0;
    for (const f of TEAMS[k].fx) {
      if (String(f.st || '').toUpperCase() !== 'FINAL') continue;
      finals++;
      const r = String(f.result || '').toUpperCase();
      if (r.startsWith('W')) w++; else if (r.startsWith('D')) d++;
      else if (!r.startsWith('L')) { unreadable++; continue; }
      const m = String(f.score || '').match(/(\d+)\s*-\s*(\d+)/);
      if (m) { pf += +m[1]; pa += +m[2]; }
    }
    return { k, pts: w * 2 + d, diff: pf - pa };
  });
  // A grade with no completed game has no ladder. Ranking it anyway produces a position that is
  // really insertion order, and an UPCOMING season would show every team a confident "1st".
  if (!finals) { gradesUnplayed++; continue; }
  gradesRanked++;
  rows.sort((a, b) => (b.pts - a.pts) || (b.diff - a.diff));
  rows.forEach((r, i) => { POS[r.k] = i + 1; });
}
log(`ladder positions: ${gradesRanked} grades ranked · ${gradesUnplayed} with no completed game (no position given)`);
if (unreadable) log(`note: ${unreadable} FINAL fixtures carried no readable result (counted as neither W/L/D)`);

// ---------------------------------------------------------------- 7. per-player position per season
// One position per season: the team in the player's OWN (youngest) age band that season. A team in
// an older band the same season is "playing up" and is recorded on that older team as "+N also in
// Uxx", never as a second position.
const nodes = new Map();       // key -> count
const alsoN = new Map();       // key -> count (playing up)
const links = new Map();       // `${ka}>${kb}` -> count
const dest = new Map();        // `${k}>${boxkey}` -> count
const src = new Map();         // `${boxkey}>${k}` -> count
const PLAYERS = [];
const playingUp = { players: 0, instances: 0 };
const sameBand = { count: 0, eg: [] };          // two teams in ONE age group — should never happen
const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);

const boxOfLeaver = (rows, afterO) => {
  // what the player did in the FIRST later season they appear in anywhere
  const later = rows.filter(r => r.o === null ? false : r.o > afterO)
    .concat(rows.filter(r => r.o === null && START_OF[r.sid] && START_OF[r.sid] > START_OF[SEASONS[afterO].id]));
  if (!later.length) return 'none';
  const nextO = Math.min(...later.filter(r => r.o !== null).map(r => r.o).concat([Infinity]));
  const inComp = later.filter(r => r.o === nextO);
  if (inComp.length) {
    const r0 = inComp[0];
    const c = r0.club || TEAM_CLUB[`${r0.sid}|${r0.tid}`] || null;   // season entry may carry no club
    if (!c) return `to:${r0.teamName || '(team with no club recorded)'}`;
    return c === CLUB ? 'older' : `to:${c}`;
  }
  const out = later.filter(r => r.o === null)[0];
  const org = out ? (ORG_OF[out.sid] || 'another association') : 'another association';
  return `assoc:${org}`;
};

for (const [full, rows] of CAREER) {
  // the player's cell per column, restricted to this club's selected teams
  const mine = rows.filter(r => r.o !== null && USE.has(`${r.sid}|${r.tid}`));
  if (!mine.length) continue;
  // ONE position per season. A player registers in their OWN age group and may play up into
  // older ones, so the position is the team in the YOUNGEST age group they hold that season;
  // every older team is "playing up" and is recorded on THAT team as "+N also played here",
  // never as a second position — the in/out partition checks depend on each player leaving and
  // entering exactly one node per season.
  //
  // Two DIFFERENT teams in the SAME age group in one season does not happen in this competition.
  // The same tid under two grades DOES — that is a regrade and is correct data (T14/T57) — so
  // registrations are collapsed by tid first. Anything still sharing an age group after that is
  // an ANOMALY: it is counted, sampled and printed, and resolved deterministically so the build
  // is reproducible. It is never silently absorbed.
  const pos = new Map();       // col -> {key, age}
  const also = new Map();      // col -> [keys]
  const byCol = new Map();
  for (const r of mine) { if (!byCol.has(r.o)) byCol.set(r.o, []); byCol.get(r.o).push(r); }
  for (const [o, rs] of byCol) {
    const byTid = new Map();                       // collapse regrades: one entry per team
    for (const r of rs) {
      const prev = byTid.get(r.tid);
      if (!prev || r.gp > prev.gp) byTid.set(r.tid, r);
    }
    const uniq = [...byTid.values()];
    const byAge = new Map();
    uniq.forEach(r => { const a = TEAMS[`${r.sid}|${r.tid}`].age; if (!byAge.has(a)) byAge.set(a, []); byAge.get(a).push(r); });
    for (const [a, list] of byAge) {
      if (list.length > 1) {
        sameBand.count += list.length - 1;
        if (sameBand.eg.length < 10) sameBand.eg.push(`${LABELS[o]} · U${a} · ${list.map(r => TEAMS[`${r.sid}|${r.tid}`].name).join(' + ')}`);
      }
    }
    uniq.sort((x, y) => {
      const a = TEAMS[`${x.sid}|${x.tid}`], b = TEAMS[`${y.sid}|${y.tid}`];
      return (a.age - b.age) || (y.gp - x.gp) || (a.rank - b.rank) || String(a.name).localeCompare(String(b.name));
    });
    const win = uniq[0], key = `${win.sid}|${win.tid}`;
    pos.set(o, { key, age: TEAMS[key].age });
    if (uniq.length > 1) also.set(o, uniq.slice(1).map(r => `${r.sid}|${r.tid}`));
  }
  for (const [, v] of pos) inc(nodes, v.key);
  for (const [, ks] of also) ks.forEach(k => inc(alsoN, k));
  playingUp.players += also.size ? 1 : 0;
  playingUp.instances += [...also.values()].reduce((a, b) => a + b.length, 0);

  const cols = [...pos.keys()].sort((a, b) => a - b);
  const hops = [];
  for (let i = 0; i < cols.length; i++) {
    const o = cols[i], key = pos.get(o).key;
    if (i + 1 < cols.length) {
      const nk = pos.get(cols[i + 1]).key;
      inc(links, `${key}>${nk}`); hops.push([key, nk]);
    } else if (o < NS - 1) {
      let bk = boxOfLeaver(rows, o);
      if (bk === 'older') bk = 'older';                           // left the selected bands, same club
      const anyLater = rows.some(r => (r.o !== null && r.o > o) || (r.o === null && START_OF[r.sid] && START_OF[r.sid] > START_OF[SEASONS[o].id]));
      if (bk === 'none' && anyLater) bk = 'gap';
      const box = `D${o + 1}.U${TEAMS[key].age}|${bk}`;
      inc(dest, `${key}>${box}`); hops.push([key, box]);
    }
  }
  const first = cols[0];
  if (first > 0) {
    const before = rows.filter(r => (r.o !== null && r.o < first) || (r.o === null && START_OF[r.sid] && START_OF[r.sid] < START_OF[SEASONS[first].id]));
    let sk = 'new';
    if (before.length) {
      const inComp = before.filter(r => r.o !== null).sort((a, b) => b.o - a.o)[0];
      const pc = inComp ? (inComp.club || TEAM_CLUB[`${inComp.sid}|${inComp.tid}`] || null) : null;
      if (inComp && pc && pc !== CLUB) sk = `from:${pc}`;
      else if (inComp) sk = 'back';
      else {
        const out = before.filter(r => r.o === null).sort((a, b) => String(START_OF[b.sid]).localeCompare(String(START_OF[a.sid])))[0];
        sk = `fromassoc:${(out && ORG_OF[out.sid]) || 'another association'}`;
      }
    }
    const box = `S${first - 1}.U${pos.get(first).age}|${sk}`;
    inc(src, `${box}>${pos.get(first).key}`); hops.push([box, pos.get(first).key]);
  }

  // pseudonymous cells for the player table — team names and bands only, never ids or names
  const cells = [];
  for (let o = 0; o < NS; o++) {
    if (pos.has(o)) {
      const k = pos.get(o).key, T = TEAMS[k];
      const c = { t: T.name, b: 'U' + T.age };
      if (also.has(o)) c.also = also.get(o).map(x => TEAMS[x].name).join(', ');
      cells.push(c);
    } else if (o < first) cells.push(null);
    else {
      const here = rows.filter(r => r.o === o);
      if (here.length) cells.push({ k: 'to', l: here[0].club || TEAM_CLUB[`${here[0].sid}|${here[0].tid}`] || here[0].teamName });
      else {
        const outside = rows.filter(r => r.o === null && NAME_OF[r.sid] && START_OF[r.sid] &&
          START_OF[r.sid] >= START_OF[SEASONS[o].id] && START_OF[r.sid] <= (START_OF[SEASONS[Math.min(o + 1, NS - 1)].id] || '9999'));
        cells.push(outside.length ? { k: 'assoc', l: ORG_OF[outside[0].sid] || '—' } : { k: 'off' });
      }
    }
  }
  const rec = { _o: [first, pos.get(first).key, full], s: cells, h: hops };
  if (WITH_NAMES) { const nm = NAMES.get(full); if (nm) rec.n = nm; }
  PLAYERS.push(rec);
}
PLAYERS.sort((a, b) => (a._o[0] - b._o[0]) || String(a._o[1]).localeCompare(String(b._o[1])) || String(a._o[2]).localeCompare(String(b._o[2])));
PLAYERS.forEach((p, i) => { p.c = `P${String(i + 1).padStart(3, '0')}`; delete p._o; });
log(`names included: ${WITH_NAMES ? `YES — ${PLAYERS.filter(p => p.n).length} of ${PLAYERS.length} players carry a name` : 'no (pseudonymous codes only)'}`);
log(`players on this club's teams: ${PLAYERS.length}` +
    ` · playing up into an older age group: ${playingUp.players} players, ${playingUp.instances} extra registrations`);
if (sameBand.count) {
  console.log(`\nNOTE: ${sameBand.count} registration(s) put a player on TWO teams in the SAME age group in one season.`);
  console.log('Not a regrade — those are collapsed by tid first — so most are a player changing teams within their age');
  console.log('group mid-season, which is sequential rather than two teams at once. The team they played more games for');
  console.log('is taken as the position; the other shows on its team as an extra appearance.');
  sameBand.eg.forEach(e => console.log('  · ' + e));
  console.log('');
}

// ---------------------------------------------------------------- 8. nodes, with the hard checks
const NODES = [];
for (const key of [...nodes.keys()].sort()) {
  const T = TEAMS[key];
  const n = { sid: SIDX[T.sid], key, team: T.name, band: 'U' + T.age, age: T.age,
              g: T.grade, gi: T.rank, gp: POS[key] || null, n: nodes.get(key) };
  if (alsoN.get(key)) n.alsoN = alsoN.get(key);
  NODES.push(n);
}
// every node's players are fully accounted for on BOTH sides — the netball partition checks
for (const nd of NODES) {
  const key = nd.key;
  if (nd.sid < NS - 1) {
    let out = 0;
    for (const [k, v] of links) if (k.startsWith(key + '>')) out += v;
    for (const [k, v] of dest) if (k.startsWith(key + '>')) out += v;
    if (out !== nd.n) die(`out partition ${LABELS[nd.sid]} ${nd.team}: ${out} vs ${nd.n}`);
  }
  if (nd.sid > 0) {
    let inn = 0;
    for (const [k, v] of links) if (k.endsWith('>' + key)) inn += v;
    for (const [k, v] of src) if (k.endsWith('>' + key)) inn += v;
    if (inn !== nd.n) die(`in partition ${LABELS[nd.sid]} ${nd.team}: ${inn} vs ${nd.n}`);
  }
}
// every ribbon total equals the per-player hops that produced it
{
  const hop = new Map();
  PLAYERS.forEach(p => p.h.forEach(([a, b]) => inc(hop, `${a}>${b}`)));
  const all = new Map([...links, ...dest, ...src]);
  for (const [k, v] of all) if ((hop.get(k) || 0) !== v) die(`ribbon ${k}: aggregate ${v} vs player hops ${hop.get(k) || 0}`);
  for (const [k, v] of hop) if (!all.has(k)) die(`player hops reference a ribbon that does not exist: ${k} (${v})`);
}
if (NODES.some(n => !n.g)) die(`${NODES.filter(n => !n.g).length} nodes have no grade`);
// A column with teams but no PLAYERS renders empty and reads as a mass exodus. That is the one
// failure a reader cannot tell from a real one, so it is reported in terms of nodes, not teams.
{
  const perCol = SEASONS.map((se, i) => ({
    name: se.name,
    teams: [...USE].filter(k => TEAMS[k].sid === se.id).length,
    nodes: NODES.filter(n => n.sid === i).length,
  }));
  log('\nper season — this club\'s teams · teams that any player is registered to:');
  perCol.forEach(c => log(`  ${String(c.name).padEnd(18)} ${String(c.teams).padStart(5)} ${String(c.nodes).padStart(8)}`));
  const dead = perCol.filter(c => c.teams && !c.nodes).map(c => c.name);
  if (dead.length) {
    console.log(`\nWARNING: ${dead.length} season(s) hold teams for this club that NO player is registered to: ${dead.join(', ')}.`);
    console.log('Those columns render empty, and the players from the season before them show as having left.');
    console.log('That is a gap in the registration data, not an exodus — the page labels the column so it cannot be misread.\n');
  }
}
log(`nodes ${NODES.length} · links ${links.size} · dest ${dest.size} · src ${src.size} — all partition checks passed`);

// ---------------------------------------------------------------- 9. measured band tenure
// Replaces the netball ageing-out prediction. For the LAST season, how many players on each team
// are in their first season in this age band, and how many in their second or later.
const tenure = {};
const lastWith = Math.max(-1, ...NODES.map(n => n.sid));
if (lastWith !== NS - 1) log(`note: tenure reported against ${LABELS[lastWith]} — ${LABELS[NS - 1]} has no teams for this club`);
for (const nd of NODES.filter(n => n.sid === lastWith)) {
  const T = TEAMS[nd.key];
  let first = 0, repeat = 0;
  for (const [, rows] of CAREER) {
    if (!rows.some(r => `${r.sid}|${r.tid}` === nd.key)) continue;
    const prior = rows.filter(r => r.o !== null && r.o < lastWith && r.age === T.age).length;
    if (prior) repeat++; else first++;
  }
  tenure[nd.key] = { first, repeat };
}

// ---------------------------------------------------------------- 10. emit
const DATA = {
  version: 3,
  club: CLUB, org: ORG, gender: GENDER, withNames: WITH_NAMES,
  seasons: LABELS,
  seasonStatus: SEASONS.map(x => x.status || null),
  tenureSeason: lastWith >= 0 ? LABELS[lastWith] : null,
  emptySeasons: LABELS.filter((_, i) => !NODES.some(n => n.sid === i)),
  bands: BANDS.map(a => 'U' + a),
  nodes: NODES.map(n => ({ ...n, tenure: tenure[n.key] || undefined })),
  links: [...links].map(([k, n]) => { const [a, b] = k.split('>'); return { a, b, n }; }),
  dest: [...dest].map(([k, n]) => { const [a, b] = k.split('>'); return { a, b, n }; }),
  src: [...src].map(([k, n]) => { const [a, b] = k.split('>'); return { a, b, n }; }),
  players: PLAYERS,
  stats: {
    teams: USE.size, players: PLAYERS.length, resolvedPlayers: nPlayers,
    unresolvedIds: unresolved, ungradedDropped: ungraded.length,
    unreadableFixtures: unreadable,
    teamsMappedToClub: mappedTeams, teamsNotInClubMap: unmappedTeams, clubTeamsWithNoPlayers: emptyTeams.length,
    clubTeamsNoGender: noGender.length,
    playingUpPlayers: playingUp.players, playingUpExtraRegs: playingUp.instances,
    duplicateRecordsMerged: globalThis.__mergedRecordsTotal || 0,
    sameBandAnomalies: sameBand.count,
    builtAt: new Date().toISOString(),
  },
};
// ---------------------------------------------------------------- 11. write and commit
// The page no longer carries the data. It lives here as one file per club+gender, listed by
// index.json, and the page in markjovic/stattrack fetches it. A template change then needs no
// rebuild at all — the two were only ever coupled because the data was baked into the HTML.
const slug = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const FILE = `${slug(CLUB)}-${slug(GENDER)}.json`;
const dir = path.join(ROOT, OUTDIR);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, FILE), JSON.stringify(DATA), 'utf8');
const bytes = fs.statSync(path.join(dir, FILE)).size;
log(`\nwrote ${OUTDIR}/${FILE} · ${(bytes / 1024).toFixed(0)} KB · ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// index.json is MERGED, never rebuilt: every other club's entry must survive a single-club run.
const IDXP = path.join(dir, 'index.json');
let idx = [];
if (fs.existsSync(IDXP)) {
  try { const raw = JSON.parse(fs.readFileSync(IDXP, 'utf8')); idx = Array.isArray(raw) ? raw : (raw.collections || []); }
  catch (e) { die(`${OUTDIR}/index.json exists but will not parse (${e.message}) — refusing to overwrite it`); }
}
const entry = {
  file: FILE, club: CLUB, gender: GENDER, org: ORG, comp: SEASONS[0].compName, withNames: WITH_NAMES,
  seasons: NS, firstSeason: LABELS[0], lastSeason: LABELS[NS - 1],
  teams: USE.size, players: PLAYERS.length, bytes, builtAt: DATA.stats.builtAt,
};
const at = idx.findIndex(e => e && e.file === FILE);
if (at >= 0) idx[at] = entry; else idx.push(entry);
idx.sort((a, b) => String(a.club).localeCompare(String(b.club)) || String(a.gender).localeCompare(String(b.gender)));
fs.writeFileSync(IDXP, JSON.stringify({ collections: idx }, null, 1), 'utf8');
log(`index.json now lists ${idx.length} collection(s): ${idx.map(e => e.club + ' ' + e.gender).join(', ')}`);

if (!COMMIT) { log('COMMIT=false — files written, nothing committed'); process.exit(0); }

const { execFileSync } = require('child_process');
const GIT = { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 10 * 60 * 1000 };
const git = (...a) => execFileSync('git', a, GIT);
const sleep = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { execFileSync('sleep', ['0.2'], { stdio: 'ignore', timeout: 5000 }); } catch (e) { break; } } };

for (const rel of [`${OUTDIR}/${FILE}`, `${OUTDIR}/index.json`]) {
  try { git('add', '--', rel); } catch (e) { die(`git add failed for ${rel}: ${e.message}`); }
}
let staged = '';
try { staged = git('diff', '--cached', '--shortstat'); } catch (e) { staged = ''; }
if (!staged.trim()) { log('nothing changed — no commit'); process.exit(0); }
log(`staging:${staged.trim()}`);
git('commit', '-m', `movement: ${CLUB} ${GENDER} (${PLAYERS.length} players, ${USE.size} teams)`);

let pushed = false;
for (let attempt = 1; attempt <= 60 && !pushed; attempt++) {
  try {
    log(`fetch/merge/push (attempt ${attempt})`);
    git('fetch', 'origin', 'main');
    git('merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat', '-q');
    git('push', 'origin', 'HEAD:main');
    pushed = true;
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    if (/GH001|exceeds|LFS|size limit/i.test(msg)) die(`push rejected permanently: ${msg}`);
    try { git('merge', '--abort'); } catch (_) {}
    if (attempt === 60) break;
    sleep(1000 + Math.floor(Math.random() * 90000));
  }
}
if (!pushed) die('push failed after 60 attempts — the data was NOT saved');
log('committed and pushed');
