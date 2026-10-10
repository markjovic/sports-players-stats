#!/usr/bin/env node
// scripts/find-players.js
//
// Searches a supplied list of names across every season this repo holds, and
// reports what we have on each of them plus how they connect to one target
// player. READ-ONLY as far as PlayHQ is concerned: no session, no API call,
// nothing fetched. Everything comes from data already on disk.
//
// Requirements it answers (spec: docs/find_players_spec.md):
//   R1 every season, every competition, not one slice
//   R2 every registration — season, competition, club, team, age, grade
//   R3 who has played AGAINST the target
//   R4 boys / girls / unknown, from PlayHQ's own grade genderName
//   R5 who has been on a TEAM WITH the target — the priority, and NOT limited
//      to the supplied names
//   R6 for R3 and R5, the games, seasons and teams — not just a count
//   R7 gender beside every name in every listing
//
// ⚠️ IT NEVER PICKS A PERSON. A name can belong to several children. Every
// candidate is listed and nothing is resolved silently. The fuzzy team-name join
// that once put U9 scores on a U11 player's card is the reason this repo keys on
// uuids wherever a uuid exists.
//
// ⚠️ A NAME THAT MATCHES NOTHING IS REPORTED AS UNMATCHED, never dropped. A
// figure that could not be computed must never look like one that was.
//
// ⚠️ GENDER DESCRIBES THE GRADE, NOT THE CHILD. `grades.json` carries PlayHQ's
// own `genderName` per grade, which is what this reports. A child in a Mixed
// grade is UNKNOWN — that is an answer, not missing data. We store no gender
// against a person and this does not invent one.
//
// ⚠️ WHAT "PLAYED AGAINST" CAN AND CANNOT SEE. Opponent and team-mate evidence
// comes from the per-game player lines, which exist for 2022–2026 only, and for
// EFNL only from 2024 — PlayHQ serves nothing earlier for that league. A meeting
// outside those windows is INVISIBLE, not absent, and the report says so per
// season rather than leaving a zero to be read as "never happened".
//
// Env: FP_NAMES (data/name-search.txt), FP_TARGET ("Jovic, Toby"),
//      FP_TARGET_UUID (settles an ambiguous target), FP_OUT (data/reports),
//      FP_COMMIT.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./lib/store');

const VERSION = 'find-players v4 2026-10-10 surname-candidates';

const ROOT = path.resolve(__dirname, '..');
const NAMES_PATH = path.join(ROOT, process.env.FP_NAMES || 'data/name-search.txt');
const OUT_DIR = path.join(ROOT, process.env.FP_OUT || 'data/reports');
const TARGET_NAME = (process.env.FP_TARGET || 'Jovic, Toby').trim();
const TARGET_UUID = (process.env.FP_TARGET_UUID || '').trim();
const COMMIT = process.env.FP_COMMIT === 'true';

const log = (...a) => console.log(...a);
const die = (msg, code = 1) => { console.error(`FATAL: ${msg}`); process.exit(code); };

// ── Name matching ────────────────────────────────────────────────────────────
// ⚠️ FOLD, DO NOT GUESS. Case, punctuation, apostrophes, hyphens and runs of
// whitespace are folded away, because a club types "O'Beirne" and "OBeirne" and
// "Weller-McClutchie" and "Weller McClutchie" interchangeably. Accents are folded
// for the same reason. Nothing else is altered: no surname-only fallback, no
// Levenshtein, no "closest match" — every one of those picks a person.
const fold = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/['\u2019`]/g, '')
  .replace(/[-_.]/g, ' ')
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Short forms seen in real club registrations. ⚠️ EXPANSION IS ADDITIVE AND
// SYMMETRIC: "Zach" also matches "Zachary", and "Zachary" also matches "Zach".
// It never REPLACES the given name, so a child actually registered as Zach is
// still found.
const NICK = {
  abby: ['abigail'], abi: ['abigail'], alex: ['alexander', 'alexandra'],
  ali: ['alison', 'alice'], anna: ['annabelle'], archie: ['archer'],
  becca: ['rebecca'], bella: ['isabella', 'annabelle'], ben: ['benjamin'],
  billi: ['billie'], billy: ['william'], bk: [], cal: ['callum'],
  charlie: ['charlotte', 'charles'], chris: ['christopher', 'christian'],
  dan: ['daniel'], danny: ['daniel'], dave: ['david'], eddie: ['edward'],
  elle: ['eleanor'], ellie: ['eleanor', 'elouise'], em: ['emily', 'emma', 'emme'],
  emmy: ['emily', 'emma'], evie: ['evelyn'], fin: ['finlay', 'finn', 'finley'],
  finn: ['finlay', 'finley', 'fin'], frank: ['franklin'], gabby: ['gabrielle'],
  harry: ['harrison', 'harold'], indi: ['indiana', 'indigo'], isaac: ['izaac'],
  issy: ['isabella', 'isabelle'], izzy: ['isabella', 'isabelle'],
  jack: ['jackson', 'john'], jake: ['jacob'], jay: ['jayden', 'james'],
  jess: ['jessica'], jim: ['james'], joe: ['joseph'], josh: ['joshua'],
  katie: ['katherine', 'kate'], lew: ['lewis'], lexie: ['alexis', 'alexandra'],
  liv: ['olivia'], livvy: ['olivia'], lish: ['alicia', 'elisha', 'alisha'],
  lizzy: ['elizabeth'], lou: ['louis', 'louise'], matt: ['matthew'],
  max: ['maxwell', 'maximilian'], mia: ['amelia'], mick: ['michael'],
  mike: ['michael'], millie: ['amelia', 'milly'], milly: ['amelia', 'millie'],
  nat: ['nathaniel', 'natalie', 'nathan'], nate: ['nathaniel', 'nathan'],
  nic: ['nicholas'], nick: ['nicholas'], ollie: ['oliver'], ozzy: ['oscar'],
  pip: ['philippa'], rob: ['robert'], sam: ['samuel', 'samantha'],
  steve: ['stephen', 'steven'], tilly: ['matilda'], tim: ['timothy'],
  toby: ['tobias'], tom: ['thomas'], tony: ['anthony'], vicky: ['victoria'],
  will: ['william'], zach: ['zachary', 'zac', 'zack'],
  zac: ['zachary', 'zach', 'zack'], zoe: ['zoey'],
};
// Built once, both ways, so the table above only has to be written in one
// direction.
const NICK2 = (() => {
  const m = new Map();
  const add = (a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const [k, vs] of Object.entries(NICK)) for (const v of vs) { add(k, v); add(v, k); }
  return m;
})();

// Every folded form a supplied name could legitimately appear under.
function variants(first, last) {
  const f = fold(first), l = fold(last);
  const firsts = new Set([f]);
  // Expand only the FIRST token of a multi-word given name ("Muan Pi").
  const head = f.split(' ')[0], tail = f.slice(head.length).trim();
  for (const alt of (NICK2.get(head) || [])) firsts.add((alt + ' ' + tail).trim());
  const out = new Set();
  for (const ff of firsts) { if (ff && l) out.add(`${ff} ${l}`); }
  return out;
}

// ── Load ─────────────────────────────────────────────────────────────────────
function readNames() {
  if (!fs.existsSync(NAMES_PATH)) {
    die(`no name list at ${path.relative(ROOT, NAMES_PATH)}.\n` +
        `Create it with one "Lastname, Firstname" per line. Lines starting with # are ignored.`);
  }
  const rows = [];
  const lines = fs.readFileSync(NAMES_PATH, 'utf8').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const c = line.indexOf(',');
    if (c < 0) {
      // ⚠️ REPORTED, NOT SKIPPED. A line the format does not fit is a defect in
      // the input and the operator has to see it.
      rows.push({ lineNo: i + 1, raw: line, bad: 'no comma — expected "Lastname, Firstname"' });
      return;
    }
    const last = line.slice(0, c).trim(), first = line.slice(c + 1).trim();
    if (!last || !first) { rows.push({ lineNo: i + 1, raw: line, bad: 'empty name part' }); return; }
    rows.push({ lineNo: i + 1, raw: line, first, last,
      display: `${first} ${last}`, keys: variants(first, last) });
  });
  return rows;
}

function loadGrades() {
  const p = path.join(ROOT, 'data', 'grades.json');
  if (!fs.existsSync(p)) die('data/grades.json is missing — gender comes from its genderName.');
  const by = new Map();
  for (const g of JSON.parse(fs.readFileSync(p, 'utf8'))) {
    if (g && g.id) by.set(g.id, g);
  }
  return by;
}

// ⚠️ PlayHQ'S OWN FIELD, not a guess from the grade name. Mixed is UNKNOWN and
// says so; a grade we hold no record for is also unknown, and the two are
// distinguished in the output.
function genderOf(gradeID, grades) {
  const g = gradeID && grades.get(gradeID);
  if (!g) return 'unknown (no grade record)';
  const n = String(g.genderName || '').trim();
  if (!n) return 'unknown (grade has no genderName)';
  if (/^girls?$/i.test(n)) return 'girls';
  if (/^boys?$/i.test(n)) return 'boys';
  if (/mixed/i.test(n)) return 'unknown (mixed grade)';
  return `unknown (${n})`;
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows) => rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';

function loadLines(sid) {
  const p = path.join(store.SEASONS_DIR, `${sid}-lines.json.gz`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8')); }
  catch (e) { console.error(`  ⚠️ ${path.basename(p)}: ${e.message}`); return null; }
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: no PlayHQ session, no API call. Everything is read from disk.\n');

  const names = readNames();
  const usable = names.filter(n => !n.bad);
  log(`name list: ${path.relative(ROOT, NAMES_PATH)} — ${usable.length} name(s)` +
    (names.length - usable.length ? `, ${names.length - usable.length} unreadable` : ''));
  for (const b of names.filter(n => n.bad)) log(`  ⚠️ line ${b.lineNo}: ${b.bad} — ${b.raw}`);
  if (!usable.length) die('no usable names.', 2);

  const grades = loadGrades();
  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = (core.manifest || []).filter(m => m && m.seasonId && m.compName);
  if (!manifest.length) die('no seasons in the manifest.');

  // folded "first last" -> [supplied name rows] (several names can fold alike)
  const wanted = new Map();
  for (const n of usable) for (const k of n.keys) {
    if (!wanted.has(k)) wanted.set(k, []);
    wanted.get(k).push(n);
  }
  const targetKeys = (() => {
    const c = TARGET_NAME.indexOf(',');
    if (c < 0) die(`FP_TARGET must be "Lastname, Firstname" — got "${TARGET_NAME}"`);
    return variants(TARGET_NAME.slice(c + 1).trim(), TARGET_NAME.slice(0, c).trim());
  })();

  // ── Pass 1: registrations, one season at a time ────────────────────────────
  // ⚠️ ONE SEASON AT A TIME AND RELEASED. store.load(null, { players: true })
  // holds all eighteen player files at once — 82 MB of JSON parsed into objects
  // is several times that live. build-player-index.js learned this the hard way.
  log(`\n── searching ${manifest.length} season(s) ──`);
  const hits = new Map();        // uuid -> { uuid, name, regs: [...] }
  // ⚠️ SURNAME INDEX, FOR UNMATCHED NAMES ONLY. The report cannot otherwise tell
  // "never played footy" apart from "the club registered a spelling the list does
  // not carry", and those need different actions from the reader. This is a
  // SHORTLIST, never a match: nothing is resolved and nothing is counted as found.
  const bySurname = new Map();   // folded surname -> Map(uuid -> {name, seasons:Set, teams:Set, genders:Set})
  const targets = new Map();     // uuid -> name, for the target
  // uuid -> Set of roster keys "sid|age|teamRaw", for team-mates by ROSTER
  const rosterOf = new Map();
  let seasonsRead = 0, playerRows = 0;

  for (const m of manifest) {
    let data;
    try { data = store.load([m.compName], { players: true }); }
    catch (e) { console.error(`  ⚠️ ${m.compName}: ${e.message}`); continue; }
    const players = data.players || [];
    if (!players.length) { log(`  ${String(m.compName).padEnd(14)} no player records`); continue; }
    seasonsRead++;
    let found = 0;
    for (const p of players) {
      playerRows++;
      if (!p || !p.uuid) continue;
      const key = fold(p.name);
      // Index on the LAST token, and on the last two, so "de ross" and "van
      // dreumel" are reachable as well as "ross" and "dreumel".
      const toks = key.split(' ');
      for (const sn of new Set([toks[toks.length - 1],
                                toks.slice(-2).join(' ')].filter(x => x && x.includes(' ') === false || x.includes(' ')))) {
        if (!sn) continue;
        if (!bySurname.has(sn)) bySurname.set(sn, new Map());
        const m2 = bySurname.get(sn);
        let e = m2.get(p.uuid);
        if (!e) { e = { name: p.name, seasons: new Set(), teams: new Set(), genders: new Set() }; m2.set(p.uuid, e); }
        e.seasons.add(m.compName);
        if (p.teamRaw) e.teams.add(p.teamRaw);
        e.genders.add(genderOf(p.gradeID, grades));
      }
      const isTarget = targetKeys.has(key);
      const matched = wanted.get(key);
      if (isTarget) targets.set(p.uuid, p.name);
      if (!matched && !isTarget) continue;
      found++;

      let rec = hits.get(p.uuid);
      if (!rec) { rec = { uuid: p.uuid, name: p.name, asked: new Set(), regs: [] }; hits.set(p.uuid, rec); }
      for (const n of (matched || [])) rec.asked.add(n.display);
      if (isTarget) rec.asked.add(`${TARGET_NAME} (target)`);

      // ⚠️ EVERY APPEARANCE, NOT JUST THE PRIMARY ONE. fetch-stats stores one
      // record per GRADE and a `primary` summary on top; a child who played
      // grading and was then placed has two, and both are registrations.
      const apps = (p.appearances && p.appearances.length)
        ? p.appearances
        : [{ gradeID: p.gradeID, teamRaw: p.teamRaw, team: p.team }];
      for (const a of apps) {
        const g = grades.get(a.gradeID);
        rec.regs.push({
          sid: m.seasonId, compName: m.compName, age: p.age,
          gradeID: a.gradeID, grade: g ? g.name : '(unknown grade)',
          club: a.team || p.team, teamRaw: a.teamRaw || p.teamRaw,
          gender: genderOf(a.gradeID, grades),
          gp: p.gp, goals: p.goals, bestPlayer: p.bestPlayer,
        });
        if (a.teamRaw) {
          const rk = `${m.seasonId}|${p.age}|${a.teamRaw}`;
          if (!rosterOf.has(p.uuid)) rosterOf.set(p.uuid, new Set());
          rosterOf.get(p.uuid).add(rk);
        }
      }
    }
    log(`  ${String(m.compName).padEnd(14)} ${String(players.length).padStart(6)} player record(s), ${found} match(es)`);
  }

  if (!seasonsRead) die('no season held any player records — nothing was searched.');
  log(`\n${playerRows} player record(s) read across ${seasonsRead} season(s)`);

  // ── The target ─────────────────────────────────────────────────────────────
  let targetUuid = TARGET_UUID;
  if (!targetUuid) {
    const ids = [...targets.keys()];
    if (!ids.length) die(`the target "${TARGET_NAME}" matches nobody in any season. ` +
      `Check the spelling, or pass FP_TARGET_UUID.`);
    if (ids.length > 1) {
      // ⚠️ NEVER PICK A PERSON. Two children can share a name.
      console.error(`FATAL: "${TARGET_NAME}" matches ${ids.length} different people:`);
      for (const id of ids) console.error(`  ${id}  ${targets.get(id)}`);
      die('re-run with FP_TARGET_UUID set to the one you mean.');
    }
    targetUuid = ids[0];
  }
  log(`target: ${targets.get(targetUuid) || '(name unknown)'}  ${targetUuid}`);

  // ── Pass 2: games, from the per-game lines ─────────────────────────────────
  log(`\n── reading per-game player lines ──`);
  const sidName = new Map(manifest.map(m => [m.seasonId, m.compName]));
  // uuid -> { mates: Map(gameKey->info), opps: Map(gameKey->info) }
  const conn = new Map();
  const touch = (u) => {
    if (!conn.has(u)) conn.set(u, { mates: [], opps: [] });
    return conn.get(u);
  };
  const seasonCoverage = [];
  const peopleSeen = new Map();   // uuid -> name, for R5 beyond the supplied list
  let gamesWithTarget = 0;

  for (const m of manifest) {
    const f = loadLines(m.seasonId);
    if (!f) {
      // ⚠️ A SEASON WITH NO LINES FILE IS INVISIBLE, NOT EMPTY.
      seasonCoverage.push({ comp: m.compName, held: false, games: 0, withTarget: 0 });
      continue;
    }
    const idxOf = new Map();
    (f.players || []).forEach((pp, i) => { if (pp && pp[0]) idxOf.set(String(pp[0]), i); });
    const tIdx = idxOf.get(targetUuid);
    const nameAt = (i) => { const pp = (f.players || [])[i]; return (pp && pp[1]) || '(unnamed)'; };
    const uuidAt = (i) => { const pp = (f.players || [])[i]; return (pp && pp[0]) || null; };

    let games = 0, withT = 0;
    // Match records give the game its date, round and scores.
    let md = new Map();
    try {
      const d = store.load([m.compName], { players: false });
      for (const r of (d.matches || [])) if (r.gameId) md.set(r.gameId, r);
    } catch (e) { /* game metadata is a nicety; absence is reported per row */ }

    for (const gid of Object.keys(f.games || {})) {
      const g = f.games[gid];
      if (!g || g.n) continue;
      games++;
      if (tIdx === undefined) continue;
      const sides = { h: g.h || [], a: g.a || [] };
      const tSide = sides.h.some(r => r[0] === tIdx) ? 'h'
        : sides.a.some(r => r[0] === tIdx) ? 'a' : null;
      if (!tSide) continue;
      withT++; gamesWithTarget++;
      const other = tSide === 'h' ? 'a' : 'h';
      const rec = md.get(gid) || {};
      const info = {
        sid: m.seasonId, comp: m.compName, gameId: gid,
        date: rec.date || '', round: rec.round || '', age: rec.age || '',
        grade: rec.rawGrade || '',
        team: tSide === 'h' ? (rec.home || '') : (rec.away || ''),
        vs: tSide === 'h' ? (rec.away || '') : (rec.home || ''),
        score: (rec.hScore !== undefined && rec.hScore !== null) ? `${rec.hScore}-${rec.aScore}` : '',
        meta: md.has(gid),
      };
      for (const [side, bucket] of [[tSide, 'mates'], [other, 'opps']]) {
        for (const row of sides[side]) {
          const u = uuidAt(row[0]);
          // ⚠️ 1.2% OF LINES HAVE NO uuid — a fill-in or an anonymous player.
          // They cannot be joined to anybody and are counted, not silently
          // dropped; see the summary.
          if (!u || u === targetUuid) continue;
          peopleSeen.set(u, nameAt(row[0]));
          touch(u)[bucket].push(info);
        }
      }
    }
    seasonCoverage.push({ comp: m.compName, held: true, games, withTarget: withT });
    log(`  ${String(m.compName).padEnd(14)} ${String(games).padStart(6)} game(s) with lines, ${withT} involving the target`);
  }

  // ── Output ─────────────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rel = (f) => path.relative(ROOT, path.join(OUT_DIR, f));

  // R2, R4, R7 — every registration of every matched name
  const regRows = [['asked_as', 'player', 'uuid', 'season', 'season_id', 'age',
    'grade', 'gender', 'club', 'team', 'games_played', 'goals', 'best_player']];
  const byDisplay = new Map();
  for (const rec of hits.values()) {
    for (const asked of rec.asked) {
      if (!byDisplay.has(asked)) byDisplay.set(asked, []);
      byDisplay.get(asked).push(rec);
    }
    for (const r of rec.regs) {
      regRows.push([[...rec.asked].join(' / '), rec.name, rec.uuid, r.compName,
        r.sid, r.age, r.grade, r.gender, r.club, r.teamRaw, r.gp, r.goals, r.bestPlayer]);
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'name-search-registrations.csv'), csv(regRows));

  // R3, R5, R6, R7 — connections to the target
  const connRows = [['relationship', 'player', 'uuid', 'gender_seen', 'in_supplied_list',
    'games', 'seasons', 'teams', 'first_game', 'last_game']];
  const genderSeen = new Map();  // uuid -> set of gender strings from registrations
  for (const rec of hits.values()) {
    genderSeen.set(rec.uuid, new Set(rec.regs.map(r => r.gender)));
  }
  const askedUuids = new Set(hits.keys());
  const rowsFor = (u, kind, list) => {
    if (!list.length) return null;
    const seasons = [...new Set(list.map(i => i.comp))].sort();
    const teams = [...new Set(list.map(i => kind === 'opponent' ? i.vs : i.team).filter(Boolean))].sort();
    const dates = list.map(i => i.date).filter(Boolean).sort();
    const gs = genderSeen.get(u);
    return [kind, peopleSeen.get(u) || '(unnamed)', u,
      gs && gs.size ? [...gs].join(' / ') : 'unknown (not in a season we hold)',
      askedUuids.has(u) ? 'yes' : 'no',
      list.length, seasons.join(' | '), teams.join(' | '),
      dates[0] || '', dates[dates.length - 1] || ''];
  };
  const connDetail = [['relationship', 'player', 'uuid', 'season', 'date', 'round',
    'age', 'grade', 'target_team', 'opponent', 'score', 'game_id', 'game_metadata']];
  for (const [u, c] of [...conn.entries()].sort((a, b) =>
    (b[1].mates.length + b[1].opps.length) - (a[1].mates.length + a[1].opps.length))) {
    for (const [kind, list] of [['team-mate', c.mates], ['opponent', c.opps]]) {
      const row = rowsFor(u, kind, list);
      if (row) connRows.push(row);
      for (const i of list) {
        connDetail.push([kind, peopleSeen.get(u) || '(unnamed)', u, i.comp, i.date,
          i.round, i.age, i.grade, i.team, i.vs, i.score, i.gameId,
          i.meta ? 'joined' : 'NO MATCH RECORD — game id only']);
      }
    }
  }
  // ⚠️ R5 IS NOT ONLY ABOUT GAMES. A child named on the same team sheet who never
  // got on the ground is a team-mate, and the per-game lines cannot see them — they
  // appear in no game. The roster keys collected in pass 1 are the only evidence,
  // and they also cover the seasons with no lines file at all.
  const targetRosters = rosterOf.get(targetUuid) || new Set();
  const rosterMates = new Map();   // uuid -> [roster keys shared]
  for (const [u, keys] of rosterOf) {
    if (u === targetUuid) continue;
    const shared = [...keys].filter(k => targetRosters.has(k));
    if (!shared.length) continue;
    // Only those with no game evidence — the rest are already reported as
    // team-mates with their games, which is the stronger statement.
    const c = conn.get(u);
    if (c && c.mates.length) continue;
    rosterMates.set(u, shared);
  }
  for (const [u, shared] of rosterMates) {
    const rec = hits.get(u);
    for (const k of shared) {
      const [sid, age, teamRaw] = k.split('|');
      connDetail.push(['team-mate (roster only)', rec ? rec.name : '(not in a season we hold)',
        u, sidName.get(sid) || sid, '', '', age, '', teamRaw, '', '',
        '', 'NO GAME — same team sheet, never shared a game']);
    }
    const gs = genderSeen.get(u);
    connRows.push(['team-mate (roster only)', rec ? rec.name : '(unnamed)', u,
      gs && gs.size ? [...gs].join(' / ') : 'unknown (not in a season we hold)',
      askedUuids.has(u) ? 'yes' : 'no', 0,
      [...new Set(shared.map(k => sidName.get(k.split('|')[0]) || k.split('|')[0]))].join(' | '),
      [...new Set(shared.map(k => k.split('|')[2]))].join(' | '), '', '']);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const unmatched = usable.filter(n => ![...n.keys].some(k => wanted.has(k) && byDisplay.has(n.display)));
  // ⚠️ CANDIDATES, NOT MATCHES. Same surname only. A reader decides; nothing here
  // is counted as found and none of it reaches the figures above.
  const candRows = [['asked_name', 'line', 'candidate', 'uuid', 'gender_seen',
    'seasons', 'teams']];
  let withCand = 0;
  for (const n of unmatched) {
    const sn = fold(n.last);
    const pool = bySurname.get(sn);
    if (!pool || !pool.size) { candRows.push([n.raw, n.lineNo, '(no player shares this surname)', '', '', '', '']); continue; }
    withCand++;
    for (const [u, e] of pool) {
      candRows.push([n.raw, n.lineNo, e.name, u, [...e.genders].join(' / '),
        [...e.seasons].sort().join(' | '), [...e.teams].sort().join(' | ')]);
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'name-search-candidates.csv'), csv(candRows));

  log(`\n═══ RESULTS ═══`);
  const matchedNames = usable.filter(n => byDisplay.has(n.display));
  log(`\nR1/R2  ${matchedNames.length} of ${usable.length} supplied name(s) matched somebody; ` +
    `${hits.size} distinct player(s); ${regRows.length - 1} registration(s)`);

  const multi = [...byDisplay.entries()].filter(([, v]) => v.length > 1);
  if (multi.length) {
    log(`\n⚠️  ${multi.length} NAME(S) MATCH MORE THAN ONE PERSON. Nothing is resolved —`);
    log('    every candidate is in the CSV and you decide which is yours.');
    for (const [disp, recs] of multi.slice(0, 12)) {
      log(`    ${disp}`);
      for (const r of recs) log(`      ${r.uuid}  ${[...new Set(r.regs.map(x => x.compName))].join(', ')}`);
    }
    if (multi.length > 12) log(`    …and ${multi.length - 12} more in the CSV`);
  }

  if (unmatched.length) {
    log(`\n⚠️  ${unmatched.length} NAME(S) MATCHED NOBODY. Not "no data" — not found:`);
    for (const n of unmatched) log(`    line ${String(n.lineNo).padStart(3)}  ${n.raw}`);
    log('    Short forms are expanded where a club is likely to differ, but a club');
    log('    may have registered a spelling the list does not carry.');
    log(`    ⚠️ ${withCand} of them have someone with the SAME SURNAME in our data —`);
    log('       see name-search-candidates.csv. Those are CANDIDATES, not matches:');
    log('       nothing is resolved and none of it is counted above. It separates');
    log('       "never played footy" from "registered under another spelling",');
    log('       which is the one thing this report otherwise cannot tell you.');
  }

  const g4 = { girls: 0, boys: 0, unknown: 0 };
  for (const rec of hits.values()) {
    const s = new Set(rec.regs.map(r => r.gender));
    if (s.has('girls') && !s.has('boys')) g4.girls++;
    else if (s.has('boys') && !s.has('girls')) g4.boys++;
    else g4.unknown++;
  }
  log(`\nR4/R7  girls ${g4.girls} · boys ${g4.boys} · unknown ${g4.unknown}`);
  log('       ⚠️ This is the GRADE\'s genderName, PlayHQ\'s own field — not a');
  log('       property of the child. A Mixed grade is UNKNOWN, which is an answer.');

  const mates = [...conn.values()].filter(c => c.mates.length).length;
  const opps = [...conn.values()].filter(c => c.opps.length).length;
  log(`\nR5     ${mates} player(s) shared a game with the target, in ${gamesWithTarget} game(s)`);
  log(`       + ${rosterMates.size} more on the same ROSTER who never shared a game —`);
  log('         a child on the team sheet who did not get a run is still a team-mate');
  log(`R3     ${opps} player(s) have played against the target`);
  const connectedInList = [...new Set([...conn.keys(), ...rosterMates.keys()])]
    .filter(u => askedUuids.has(u)).length;
  log(`       ${connectedInList} of the connected players are in your supplied list`);

  log(`\n── coverage, read this before any zero ──`);
  const noLines = seasonCoverage.filter(c => !c.held);
  if (noLines.length) {
    log(`⚠️  ${noLines.length} season(s) have NO per-game lines, so no team-mate or`);
    log('    opponent evidence exists for them at all. A zero for these is INVISIBLE,');
    log('    not "never happened":');
    for (const c of noLines) log(`      ${c.comp}`);
  } else log('  every season holds per-game lines.');

  fs.writeFileSync(path.join(OUT_DIR, 'name-search-connections.csv'), csv(connRows));
  fs.writeFileSync(path.join(OUT_DIR, 'name-search-connections-games.csv'), csv(connDetail));

  log(`\nwritten:`);
  for (const f of ['name-search-registrations.csv', 'name-search-connections.csv',
    'name-search-connections-games.csv', 'name-search-candidates.csv']) {
    const p = path.join(OUT_DIR, f);
    log(`  ${rel(f)}  ${(fs.statSync(p).size / 1024).toFixed(0)} KB`);
  }

  if (COMMIT) {
    try {
      execFileSync('git', ['add', '-A', path.relative(ROOT, OUT_DIR)], { stdio: 'ignore' });
      let staged = false;
      try { execFileSync('git', ['diff', '--staged', '--quiet'], { stdio: 'ignore' }); }
      catch (e) { staged = true; }
      if (staged) {
        execFileSync('git', ['commit', '-q', '-m', 'name search report'], { stdio: 'ignore' });
        const branch = process.env.GITHUB_REF_NAME || 'main';
        execFileSync('git', ['pull', '--rebase', 'origin', branch], { stdio: 'ignore' });
        execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { stdio: 'ignore' });
        log('pushed.');
      } else log('nothing changed.');
    } catch (e) {
      die(`push failed: ${(e.stderr || e.message || '').toString().split('\n')[0]}`);
    }
  }
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
