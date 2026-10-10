#!/usr/bin/env node
// scripts/find-players.js
//
// Searches a list of names across every season this repo holds, and reports what
// we have on each of them plus how they connect to one target player.
//
// ⚠️ READ-ONLY, AND IT COMMITS NOTHING. No PlayHQ session, no API call, nothing
// written into the repo. The three CSVs go out as a run ARTIFACT — this is a
// personal tool, not part of the dashboard, and its output names children.
//
// Report shape deliberately mirrors the basketball tool of the same name so the
// two read side by side. Footy equivalents: a "season" is a competition year
// (EFNL 2026) and a "team" is the full team name PlayHQ serves.
//
// ⚠️ IT NEVER PICKS A PERSON. A name can belong to several children. Every
// candidate is listed with its uuid and nothing is resolved. An ambiguous TARGET
// fails the run rather than guessing whose report this is.
//
// ⚠️ GENDER DESCRIBES THE GRADE, NOT THE CHILD. `grades.json` carries PlayHQ's
// own `genderName`. We store no gender against a person. A Mixed grade reports
// `Mixed` and that is an answer, not missing data.
//
// ⚠️ WHAT THE GAME EVIDENCE CAN AND CANNOT SEE. Opponents and shared games come
// from the per-game player lines. A season with no lines file contributes NO game
// evidence, and the run names those seasons. Team-mates also come from the
// ROSTER, so a child on the same team sheet who never got a game is still found.
//
// Env: FP_NAMES (data/name-search.txt), FP_TARGET ("Jovic, Toby"),
//      FP_TARGET_UUID, FP_OUT (reports).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./lib/store');

const VERSION = 'find-players v5 2026-10-10';

const ROOT = path.resolve(__dirname, '..');
const NAMES_PATH = path.join(ROOT, process.env.FP_NAMES || 'data/name-search.txt');
const OUT_DIR = path.join(ROOT, process.env.FP_OUT || 'reports');
const TARGET_NAME = (process.env.FP_TARGET || 'Jovic, Toby').trim();
const TARGET_UUID = (process.env.FP_TARGET_UUID || '').trim();

const log = (...a) => console.log(...a);
const die = (m, c = 1) => { console.error(`FATAL: ${m}`); process.exit(c); };
const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);
const short = (u) => String(u || '').slice(0, 13);

// ── Name folding ─────────────────────────────────────────────────────────────
// ⚠️ FOLD, DO NOT GUESS. Case, accents, apostrophes, hyphens and whitespace runs
// are folded away, because a club types "O'Beirne", "OBeirne" and "O Beirne"
// interchangeably. Nothing else is altered: no surname-only match and no closest
// match, because both pick a person.
const fold = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/['\u2019`]/g, '')
  .replace(/[-_.]/g, ' ')
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const NICK = {
  abby: ['abigail'], abi: ['abigail'], alex: ['alexander', 'alexandra'],
  ali: ['alison', 'alice'], anna: ['annabelle'], archie: ['archer'],
  becca: ['rebecca'], bella: ['isabella', 'annabelle'], ben: ['benjamin'],
  billi: ['billie'], billy: ['william'], cal: ['callum'],
  charlie: ['charlotte', 'charles'], charli: ['charlotte'],
  chris: ['christopher', 'christian'], dan: ['daniel'], danny: ['daniel'],
  dave: ['david'], eddie: ['edward'], elle: ['eleanor'],
  ellie: ['eleanor', 'elouise'], em: ['emily', 'emma', 'emme'],
  emmy: ['emily', 'emma'], evie: ['evelyn'], fin: ['finlay', 'finn', 'finley'],
  finn: ['finlay', 'finley', 'fin'], gabby: ['gabrielle'],
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
  will: ['william'], zach: ['zachary', 'zac', 'zack', 'zachariah'],
  zac: ['zachary', 'zach', 'zack'], zoe: ['zoey'],
};
const NICK2 = (() => {
  const m = new Map();
  const add = (a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const [k, vs] of Object.entries(NICK)) for (const v of vs) { add(k, v); add(v, k); }
  return m;
})();

function variants(first, last) {
  const f = fold(first), l = fold(last);
  const firsts = new Set([f]);
  const head = f.split(' ')[0], tail = f.slice(head.length).trim();
  for (const alt of (NICK2.get(head) || [])) firsts.add((alt + ' ' + tail).trim());
  const out = new Set();
  for (const ff of firsts) if (ff && l) out.add(`${ff} ${l}`);
  return out;
}
// First token and last token only, so a middle name or one half of a hyphen does
// not stop a match. Reported as [first+last] so it is never mistaken for exact.
const endsKey = (folded) => {
  const t = folded.split(' ');
  return t.length > 1 ? `${t[0]}|${t[t.length - 1]}` : `${t[0]}|${t[0]}`;
};

// ── Input ────────────────────────────────────────────────────────────────────
function readNames() {
  if (!fs.existsSync(NAMES_PATH)) {
    die(`no name list at ${path.relative(ROOT, NAMES_PATH)}.\n` +
      `Create it with one "Lastname, Firstname" per line; # for comments.`);
  }
  const rows = [];
  fs.readFileSync(NAMES_PATH, 'utf8').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const c = line.indexOf(',');
    if (c < 0) { rows.push({ lineNo: i + 1, raw: line, bad: 'no comma' }); return; }
    const last = line.slice(0, c).trim(), first = line.slice(c + 1).trim();
    if (!last || !first) { rows.push({ lineNo: i + 1, raw: line, bad: 'empty name part' }); return; }
    const keys = variants(first, last);
    rows.push({
      lineNo: i + 1, raw: line, first, last, display: `${first} ${last}`, keys,
      ends: new Set([...keys].map(endsKey)),
      words: [...new Set([...fold(last).split(' '), ...fold(first).split(' ')])].filter(w => w.length > 1),
    });
  });
  return rows;
}

function loadGrades() {
  const p = path.join(ROOT, 'data', 'grades.json');
  if (!fs.existsSync(p)) die('data/grades.json is missing — gender comes from its genderName.');
  const by = new Map();
  for (const g of JSON.parse(fs.readFileSync(p, 'utf8'))) if (g && g.id) by.set(g.id, g);
  return by;
}
function genderOf(gradeID, grades) {
  const g = gradeID && grades.get(gradeID);
  if (!g) return 'unknown';
  const n = String(g.genderName || '').trim();
  if (/^girls?$/i.test(n)) return 'Girls';
  if (/^boys?$/i.test(n)) return 'Boys';
  if (/^women$/i.test(n)) return 'Women';
  if (/^men$/i.test(n)) return 'Men';
  if (/mixed/i.test(n)) return 'Mixed';
  return n || 'unknown';
}
const gradeNameOf = (gradeID, grades) => {
  const g = gradeID && grades.get(gradeID);
  return g && g.name ? g.name : '(grade unknown)';
};

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
  const names = readNames();
  const usable = names.filter(n => !n.bad);
  const grades = loadGrades();
  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = (core.manifest || []).filter(m => m && m.seasonId && m.compName);
  if (!manifest.length) die('no seasons in the manifest.');
  if (!usable.length) die('no usable names.', 2);

  log(`${VERSION}`);
  log('─'.repeat(62));
  log(`  Names to find   : ${usable.length}`);
  log(`  Source          : ${path.relative(ROOT, NAMES_PATH)}`);
  log(`  Opponent        : ${TARGET_NAME}`);
  log(`  Seasons indexed : ${manifest.length}`);
  for (const b of names.filter(n => n.bad)) log(`  ⚠️ line ${b.lineNo}: ${b.bad} — ${b.raw}`);

  const wantExact = new Map(), wantEnds = new Map();
  for (const n of usable) {
    for (const k of n.keys) { if (!wantExact.has(k)) wantExact.set(k, []); wantExact.get(k).push(n); }
    for (const k of n.ends) { if (!wantEnds.has(k)) wantEnds.set(k, []); wantEnds.get(k).push(n); }
  }
  const targetKeys = (() => {
    const c = TARGET_NAME.indexOf(',');
    if (c < 0) die(`FP_TARGET must be "Lastname, Firstname" — got "${TARGET_NAME}"`);
    return variants(TARGET_NAME.slice(c + 1).trim(), TARGET_NAME.slice(0, c).trim());
  })();
  const wantedWords = new Set();
  for (const n of usable) for (const w of n.words) wantedWords.add(w);

  // ── Pass 1: player records ─────────────────────────────────────────────────
  // ⚠️ ONE SEASON AT A TIME AND RELEASED. All eighteen player files at once is
  // 82 MB of JSON parsed into objects, several times that live.
  const hits = new Map();
  const targets = new Map();
  const byWord = new Map();
  const rosterOf = new Map();
  const rosterMeta = new Map();
  const allNames = new Map();
  const teamSet = new Set();
  let playerRows = 0;

  for (const m of manifest) {
    let data;
    try { data = store.load([m.compName], { players: true }); }
    catch (e) { console.error(`  ⚠️ ${m.compName}: ${e.message}`); continue; }
    for (const p of (data.players || [])) {
      playerRows++;
      if (!p || !p.uuid) continue;
      allNames.set(p.uuid, p.name);
      const key = fold(p.name);
      const g = genderOf(p.gradeID, grades);

      // ⚠️ INDEXED ONLY FOR WORDS THE LIST ASKS ABOUT. A full word index of
      // 180,000 records costs memory for nothing.
      for (const w of new Set(key.split(' '))) {
        if (!wantedWords.has(w)) continue;
        if (!byWord.has(w)) byWord.set(w, new Map());
        let e = byWord.get(w).get(p.uuid);
        if (!e) { e = { name: p.name, genders: new Set(), seasons: new Set() }; byWord.get(w).set(p.uuid, e); }
        e.genders.add(g); e.seasons.add(m.compName);
      }

      const isTarget = targetKeys.has(key);
      const exact = wantExact.get(key);
      const ends = exact ? null : wantEnds.get(endsKey(key));
      if (isTarget) targets.set(p.uuid, p.name);
      if (!exact && !ends && !isTarget) continue;

      let rec = hits.get(p.uuid);
      if (!rec) { rec = { uuid: p.uuid, name: p.name, asked: new Set(), how: new Set(), regs: [] }; hits.set(p.uuid, rec); }
      for (const n of (exact || [])) { rec.asked.add(n.display); rec.how.add('exact'); }
      for (const n of (ends || [])) { rec.asked.add(n.display); rec.how.add('first+last'); }
      if (isTarget) rec.asked.add(TARGET_NAME);

      const apps = (p.appearances && p.appearances.length)
        ? p.appearances : [{ gradeID: p.gradeID, teamRaw: p.teamRaw, team: p.team }];
      for (const a of apps) {
        rec.regs.push({
          sid: m.seasonId, comp: m.compName, age: p.age,
          grade: gradeNameOf(a.gradeID, grades), gender: genderOf(a.gradeID, grades),
          club: a.team || p.team, teamRaw: a.teamRaw || p.teamRaw,
          gp: p.gp, goals: p.goals, bp: p.bestPlayer,
        });
      }
    }

    // Rosters are built for EVERY player, not only matched ones — the target's
    // team-mates are mostly not on the supplied list.
    for (const p of (data.players || [])) {
      if (!p || !p.uuid) continue;
      const apps = (p.appearances && p.appearances.length)
        ? p.appearances : [{ gradeID: p.gradeID, teamRaw: p.teamRaw }];
      for (const a of apps) {
        if (!a.teamRaw) continue;
        const rk = `${m.seasonId}|${a.teamRaw}`;
        teamSet.add(rk);
        if (!rosterMeta.has(rk)) rosterMeta.set(rk, { comp: m.compName, grade: gradeNameOf(a.gradeID, grades) });
        if (!rosterOf.has(p.uuid)) rosterOf.set(p.uuid, new Set());
        rosterOf.get(p.uuid).add(rk);
      }
    }
  }
  log(`  Teams indexed   : ${teamSet.size}`);
  log(`  Player records  : ${playerRows}`);

  // ── The target ─────────────────────────────────────────────────────────────
  let targetUuid = TARGET_UUID;
  if (!targetUuid) {
    const ids = [...targets.keys()];
    if (!ids.length) die(`the target "${TARGET_NAME}" matches nobody. Check the spelling or pass FP_TARGET_UUID.`);
    if (ids.length > 1) {
      console.error(`FATAL: "${TARGET_NAME}" matches ${ids.length} people:`);
      for (const id of ids) console.error(`  ${id}  ${targets.get(id)}`);
      die('re-run with FP_TARGET_UUID set to the one you mean.');
    }
    targetUuid = ids[0];
  }
  const targetName = targets.get(targetUuid) || allNames.get(targetUuid) || '(unknown)';
  log(`  Opponent resolved: ${targetName}  ${targetUuid}`);

  // ── Pass 2: games ──────────────────────────────────────────────────────────
  const conn = new Map();        // uuid -> Map(key -> {sid, comp, team, grade, with, against})
  const playedIn = new Map();    // uuid -> Map(sid -> games they played)
  const noLines = [];
  let targetGames = 0, anonLines = 0;

  for (const m of manifest) {
    const f = loadLines(m.seasonId);
    if (!f) { noLines.push(m.compName); continue; }
    const idxOf = new Map();
    (f.players || []).forEach((pp, i) => { if (pp && pp[0]) idxOf.set(String(pp[0]), i); });
    const uuidAt = (i) => { const pp = (f.players || [])[i]; return (pp && pp[0]) || null; };
    const nameAt = (i) => { const pp = (f.players || [])[i]; return (pp && pp[1]) || '(unnamed)'; };
    const tIdx = idxOf.get(targetUuid);

    let md = new Map();
    try {
      const d = store.load([m.compName], { players: false });
      for (const r of (d.matches || [])) if (r.gameId) md.set(r.gameId, r);
    } catch (e) { /* metadata is a nicety; the game id still identifies it */ }

    for (const gid of Object.keys(f.games || {})) {
      const g = f.games[gid];
      if (!g || g.n) continue;
      const sides = { h: g.h || [], a: g.a || [] };
      const rec = md.get(gid) || {};

      for (const side of ['h', 'a']) for (const row of sides[side]) {
        const u = uuidAt(row[0]);
        if (!u) { anonLines++; continue; }
        if (!playedIn.has(u)) playedIn.set(u, new Map());
        const pm = playedIn.get(u);
        pm.set(m.seasonId, (pm.get(m.seasonId) || 0) + 1);
      }
      if (tIdx === undefined) continue;
      const tSide = sides.h.some(r => r[0] === tIdx) ? 'h' : sides.a.some(r => r[0] === tIdx) ? 'a' : null;
      if (!tSide) continue;
      targetGames++;
      const other = tSide === 'h' ? 'a' : 'h';
      const myTeam = tSide === 'h' ? (rec.home || '(team unknown)') : (rec.away || '(team unknown)');
      const vsTeam = tSide === 'h' ? (rec.away || '(team unknown)') : (rec.home || '(team unknown)');
      const gr = [rec.age, rec.rawGrade].filter(Boolean).join(' ') || '(grade unknown)';

      for (const [side, kind, teamName] of [[tSide, 'with', myTeam], [other, 'against', vsTeam]]) {
        for (const row of sides[side]) {
          const u = uuidAt(row[0]);
          // ⚠️ A LINE WITH NO uuid CANNOT BE JOINED TO ANYBODY — a fill-in or an
          // anonymous player, about 1.2% of lines. Counted, never guessed at.
          if (!u || u === targetUuid) continue;
          allNames.set(u, nameAt(row[0]));
          if (!conn.has(u)) conn.set(u, new Map());
          const k = `${m.seasonId}|${teamName}|${gr}`;
          let e = conn.get(u).get(k);
          if (!e) { e = { sid: m.seasonId, comp: m.compName, team: teamName, grade: gr, with: 0, against: 0 }; conn.get(u).set(k, e); }
          e[kind]++;
        }
      }
    }
  }
  log(`  Games involving the target: ${targetGames}`);
  log('─'.repeat(62));

  // ── Classify the supplied names ────────────────────────────────────────────
  const byDisplay = new Map();
  for (const rec of hits.values()) for (const a of rec.asked) {
    if (!byDisplay.has(a)) byDisplay.set(a, []);
    byDisplay.get(a).push(rec);
  }
  const unmatched = usable.filter(n => !byDisplay.has(n.display));
  const multi = usable.filter(n => (byDisplay.get(n.display) || []).length > 1);

  const genderTally = {};
  for (const rec of hits.values()) {
    const s = new Set(rec.regs.map(r => r.gender));
    const label = s.size === 1 ? [...s][0]
      : (s.has('Girls') && !s.has('Boys')) ? 'Girls'
        : (s.has('Boys') && !s.has('Girls')) ? 'Boys' : 'unknown';
    genderTally[label] = (genderTally[label] || 0) + 1;
  }
  const regRowCount = [...hits.values()].reduce((n, r) => n + r.regs.length, 0);

  log(`  Names searched   : ${usable.length}`);
  log(`  Players matched  : ${hits.size}`);
  log(`  Team/season rows : ${regRowCount}`);
  log(`  Shared-game rows : ${[...conn.values()].reduce((n, m2) => n + m2.size, 0)}`);
  log(`  Gender recorded  : ${Object.entries(genderTally).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join('   ')}`);

  const genderOfUuid = (u) => {
    const rec = hits.get(u);
    if (rec && rec.regs.length) {
      const s = new Set(rec.regs.map(r => r.gender));
      return s.size === 1 ? [...s][0] : [...s].filter(x => x !== 'unknown')[0] || 'unknown';
    }
    for (const pool of byWord.values()) {
      const e = pool.get(u);
      if (e) return [...e.genders][0] || 'unknown';
    }
    return 'unknown';
  };

  // ── NO MATCH ───────────────────────────────────────────────────────────────
  if (unmatched.length) {
    log(`\n  NO MATCH (${unmatched.length}) — not in the data under any spelling tried.`);
    log('  Each is followed by every player sharing a word with the name, so you can tell a');
    log('  child who has never played from one we hold under a different spelling.');
    for (const n of unmatched) {
      log(`\n    ${n.raw}`);
      let any = false;
      for (const w of n.words) {
        const pool = byWord.get(w);
        if (!pool || !pool.size) continue;
        any = true;
        for (const [u, e] of [...pool.entries()].sort((a, b) => b[1].seasons.size - a[1].seasons.size).slice(0, 6)) {
          log(`      ? ${pad(e.name, 30)} ${pad([...e.genders][0] || 'unknown', 8)} ` +
            `${String(e.seasons.size).padStart(2)} season(s)  ${short(u)}   via ${w}`);
        }
      }
      if (!any) log('      (nothing in the data shares a word with this name)');
    }
  }

  // ── SEVERAL CANDIDATES ─────────────────────────────────────────────────────
  if (multi.length) {
    log(`\n  SEVERAL CANDIDATES (${multi.length}) — every one is in the CSV; nothing was chosen for you.`);
    log('  Gender and recent teams are shown so you can tell them apart: an adult grade on a');
    log('  junior list is someone who happens to share the name.');
    for (const n of multi) {
      const recs = byDisplay.get(n.display);
      log(`\n    ${n.raw} → ${recs.length} candidates`);
      for (const r of [...recs].sort((a, b) => b.regs.length - a.regs.length)) {
        const seasons = new Set(r.regs.map(x => x.comp));
        log(`      · ${pad(r.name, 28)} ${pad(genderOfUuid(r.uuid), 8)} ${String(seasons.size).padStart(2)} season(s)  ` +
          `${short(r.uuid)}  [${[...r.how][0] || 'exact'}]`);
        for (const reg of r.regs.slice(-2).reverse()) {
          log(`          ${reg.comp} · ${reg.teamRaw} · ${reg.grade}`);
        }
      }
    }
  }

  // ── PLAYED AGAINST ─────────────────────────────────────────────────────────
  const oppRows = [...conn.entries()]
    .map(([u, m2]) => ({ u, rows: [...m2.values()].filter(e => e.against > 0) }))
    .filter(x => x.rows.length)
    .map(x => ({ ...x, total: x.rows.reduce((n, e) => n + e.against, 0) }))
    .sort((a, b) => b.total - a.total ||
      String(allNames.get(a.u)).localeCompare(String(allNames.get(b.u))));

  log(`\n  PLAYED AGAINST ${targetName}:`);
  if (!oppRows.length) log('    (none on record)');
  for (const o of oppRows) {
    log(`    ${pad(allNames.get(o.u) || '(unnamed)', 30)} ${pad(genderOfUuid(o.u), 8)} ` +
      `${String(o.total).padStart(3)} game(s)  ${short(o.u)}`);
    for (const e of [...o.rows].sort((a, b) => b.against - a.against)) {
      log(`        ${e.comp} · ${e.team} · ${e.grade} — ${e.against} game${e.against === 1 ? '' : 's'}`);
    }
  }

  // ── TEAM-MATES (not opponents) ─────────────────────────────────────────────
  const mateRows = [...conn.entries()]
    .map(([u, m2]) => ({ u, rows: [...m2.values()].filter(e => e.with > 0) }))
    .filter(x => x.rows.length)
    .map(x => ({ ...x, total: x.rows.reduce((n, e) => n + e.with, 0),
      alsoOpp: [...conn.get(x.u).values()].some(e => e.against > 0) }))
    .sort((a, b) => b.total - a.total);

  log(`\n  TEAM-MATES of ${targetName} (not opponents):`);
  const purely = mateRows.filter(x => !x.alsoOpp);
  if (!purely.length) log('    (none on record)');
  for (const o of purely) {
    log(`    ${pad(allNames.get(o.u) || '(unnamed)', 30)} ${pad(genderOfUuid(o.u), 8)} ` +
      `${String(o.total).padStart(3)} game(s)  ${short(o.u)}`);
    for (const e of [...o.rows].sort((a, b) => b.with - a.with)) {
      log(`        ${e.comp} · ${e.team} · ${e.grade} — ${e.with} game${e.with === 1 ? '' : 's'}`);
    }
  }

  // ── EVERY TEAM-MATE ────────────────────────────────────────────────────────
  // ⚠️ THE ROSTER MATTERS AS MUCH AS THE GAMES. A child named on the same team
  // sheet who never got a run is a team-mate, and no game line can see them —
  // they appear in no game at all. Those show as 0 together of 0 they played.
  const targetRosters = rosterOf.get(targetUuid) || new Set();
  const everyMate = new Map();
  for (const [u, keys] of rosterOf) {
    if (u === targetUuid) continue;
    for (const rk of keys) {
      if (!targetRosters.has(rk)) continue;
      const [sid, teamRaw] = rk.split('|');
      const meta = rosterMeta.get(rk) || {};
      if (!everyMate.has(u)) everyMate.set(u, new Map());
      const together = [...(conn.get(u) || new Map()).values()]
        .filter(e => e.sid === sid).reduce((n, e) => n + e.with, 0);
      everyMate.get(u).set(rk, {
        comp: meta.comp || sid, team: teamRaw, grade: meta.grade || '',
        together, theirs: (playedIn.get(u) || new Map()).get(sid) || 0,
      });
    }
  }
  // Anyone who shared a game but whose roster key we do not hold still belongs.
  for (const o of mateRows) {
    if (everyMate.has(o.u)) continue;
    const m2 = new Map();
    for (const e of o.rows) m2.set(`${e.sid}|${e.team}`, {
      comp: e.comp, team: e.team, grade: e.grade, together: e.with,
      theirs: (playedIn.get(o.u) || new Map()).get(e.sid) || e.with,
    });
    everyMate.set(o.u, m2);
  }
  const everySorted = [...everyMate.entries()]
    .map(([u, m2]) => ({ u, rows: [...m2.values()], total: [...m2.values()].reduce((n, e) => n + e.together, 0) }))
    .sort((a, b) => b.total - a.total || b.rows.length - a.rows.length);
  const seasonsCovered = new Set();
  for (const o of everySorted) for (const r of o.rows) seasonsCovered.add(r.comp);

  log(`\n  EVERY TEAM-MATE ${targetName} HAS EVER HAD: ${everySorted.length} players across ${seasonsCovered.size} season(s)`);
  for (const o of everySorted) {
    log(`    ${pad(allNames.get(o.u) || '(unnamed)', 30)} ${pad(genderOfUuid(o.u), 8)} ` +
      `${String(o.total).padStart(3)} game(s) alongside  ${String(o.rows.length).padStart(2)} season(s)`);
    for (const r of [...o.rows].sort((a, b) => b.together - a.together)) {
      log(`        ${r.comp} · ${r.team} · ${r.grade} — ${r.together} together of ${r.theirs} they played`);
    }
  }

  // ── Coverage ───────────────────────────────────────────────────────────────
  log('');
  log('  ⚠  "none on record" is NOT "never happened".');
  if (noLines.length) {
    log(`     ${noLines.length} season(s) hold NO per-game player lines, so no shared game in`);
    log('     them can be seen at all:');
    for (const c of noLines) log(`       ${c}`);
  } else {
    log('     Every season here holds per-game player lines, so there is no blind season.');
  }
  log(`     ${anonLines} line(s) carry no player id — a fill-in or an anonymous player — and`);
  log('     cannot be joined to anybody. A side whose sheet was never entered shows no');
  log('     opponents. A shared game FOUND is strong evidence; one NOT found is weak.');

  // ── CSVs ───────────────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const reg = [['asked_as', 'match', 'player', 'uuid', 'season', 'age', 'grade', 'gender',
    'club', 'team', 'games', 'goals', 'best_player']];
  for (const rec of hits.values()) for (const r of rec.regs) {
    reg.push([[...rec.asked].join(' / '), [...rec.how][0] || 'exact', rec.name, rec.uuid,
      r.comp, r.age, r.grade, r.gender, r.club, r.teamRaw, r.gp, r.goals, r.bp]);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'name-search.csv'), csv(reg));

  const vs = [['player', 'uuid', 'gender', 'season', 'their_team', 'grade', 'games_against']];
  for (const o of oppRows) for (const e of o.rows) {
    vs.push([allNames.get(o.u), o.u, genderOfUuid(o.u), e.comp, e.team, e.grade, e.against]);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'name-search-vs-opponent.csv'), csv(vs));

  const tm = [['player', 'uuid', 'gender', 'in_supplied_list', 'season', 'team', 'grade',
    'games_together', 'games_they_played']];
  for (const o of everySorted) for (const r of o.rows) {
    tm.push([allNames.get(o.u), o.u, genderOfUuid(o.u), hits.has(o.u) ? 'yes' : 'no',
      r.comp, r.team, r.grade, r.together, r.theirs]);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'opponent-teammates.csv'), csv(tm));

  const rel = path.relative(ROOT, OUT_DIR);
  log(`\n  Written: ${rel}/name-search.csv`);
  log(`           ${rel}/name-search-vs-opponent.csv`);
  log(`           ${rel}/opponent-teammates.csv`);
  log("  (not committed — download them from the run's artifact)");
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
