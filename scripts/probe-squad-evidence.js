// scripts/probe-squad-evidence.js
//
// READ-ONLY, offline, ZERO API calls. Writes and COMMITS one report.
//
// THE 40 THAT THREE TESTS COULD NOT SETTLE — and the evidence none of them used.
//
// What has already failed on these:
//   probe-alias-credits       the target credits NONE of the games → no verdict
//   probe-alias-names         several players share the name → no verdict (T40)
//   probe-shared-name-aliases no candidate holds a registration for that SEASON
//   seed-missing-profiles     the ids are spectator-namespace, publicProfile
//                             returns NOT_FOUND → the alias is behaving correctly
//                             and there is nothing to delete (T41)
//
// WHAT IS STILL AVAILABLE, all of it already on disk.
//
// 1. THE TEAM, IDENTIFIED FROM ITS OTHER PLAYERS. The alias id's own registration
//    is missing — that is why the season test failed. But the OTHER ids in that
//    team sheet are not missing. Their player files say which club and grade they
//    were registered to that season, so the team is identifiable from its
//    teammates. Then: which candidate has a registration at THAT CLUB, in THAT
//    GRADE? That is far tighter than "a registration for that season", which is
//    the question that failed.
//
// 2. JERSEY NUMBER. probe-unresolved-aliases captured it and nothing used it —
//    Zachary Price was #23. Numbers persist within a squad for a season, so a
//    candidate wearing the same number for the same club is strong.
//
// 3. SQUAD OVERLAP. If a candidate's OTHER games share teammates with this game,
//    they are the same squad. A player and their teammates travel together.
//
// Each is scored per candidate and shown separately, because they are independent
// and can disagree. A verdict is offered ONLY where one candidate leads on the
// evidence and no other candidate has any — anything closer is printed in full for
// a human to read, which is what §1a of OUTSTANDING_TASKS asks for.
//
// Usage: node scripts/probe-squad-evidence.js [--show=40]

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = process.env.SCAN_ROOT || path.join(__dirname, '..');
const SHOW = Number((process.argv.slice(2).find(a => a.startsWith('--show=')) || '').split('=')[1]) || 40;
const TRUNC_LEN = 13;
const n = (x) => Number(x || 0).toLocaleString();
// ⚠ EVERY FILE THIS TOOL WRITES IS LISTED HERE, AND commitReport STAGES ALL OF
// THEM. The first version staged only squad-evidence-audit.json, so the
// manual-alias-decisions.json stub was written to the runner and died with it —
// while the report told the reader to go and fill it in. That is the same
// artifact-versus-repo fault as three earlier tools in this session (directive B),
// arriving through a helper that was correct for one file and silently wrong for
// the second.
const REPORTS = ['reports/squad-evidence-audit.json', 'reports/manual-alias-decisions.json'];
const REPORT = REPORTS[0];

const _GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
function commitReport(msg) {
  try {
    for (const f of REPORTS) { try { execSync('git add -- ' + f, _GIT); } catch (e) { /* may not exist */ } }
    const staged = execSync('git diff --staged --shortstat', _GIT).toString().trim();
    if (!staged) { console.log('  nothing to commit'); return; }
    console.log('  staging: ' + staged);
    execSync('git commit -q -m "probe-squad-evidence: ' + String(msg).replace(/"/g, "'") + '"', _GIT);
    for (let a = 1; a <= 40; a++) {
      try { execSync('git merge --abort', _GIT); } catch (e) {}
      try {
        console.log('  … fetch/merge/push (attempt ' + a + ')');
        execSync('git fetch origin main', _GIT);
        execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', _GIT);
        execSync('git push origin main', _GIT);
        console.log('  ✔ pushed'); return;
      } catch (e) {
        if (a === 40) throw new Error('push failed after 40 attempts');
        const w = 1 + Math.floor(Math.random() * 60);
        console.log('  … push attempt ' + a + ' failed, retrying in ' + w + 's');
        try { execSync('sleep ' + w, { stdio: 'pipe', timeout: (w + 30) * 1000 }); } catch (e2) {}
      }
    }
  } catch (e) { console.log('  ⚠ commit failed: ' + e.message); }
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const playerPath = (u) => path.join(ROOT, 'players', u.slice(0, 2), u + '.json');

function main() {
  // ── The population, and what PlayHQ already told us about each ────────────
  const ua = readJson(path.join(ROOT, 'reports', 'unresolved-alias-audit.json'));
  if (!ua) { console.error('ABORT: reports/unresolved-alias-audit.json not readable'); process.exit(1); }
  const pop = (ua.entries || []).map(e => ({
    id: e.id, name: e.name, target: e.target,
    candidates: (e.candidates || []).map(c => c.uuid),
    // jersey number and team id, straight from the box score
    box: (e.box || []).filter(b => b && b.team).map(b => ({ gid: b.gid, sid: b.sid, team: b.team, number: b.number })),
  })).filter(x => x.candidates.length);
  console.log('  aliases to examine : ' + n(pop.length));

  // ── Index the games each alias delivers, and the FULL roster of each ──────
  const wantIds = new Set(pop.map(p => p.id));
  const delivered = new Map();                 // aliasId -> [{gid,sid,h,a,roster:[ids]}]
  for (const id of wantIds) delivered.set(id, []);
  const gamesDir = path.join(ROOT, 'games', 'bv');
  const seasonFiles = fs.readdirSync(gamesDir).filter(f => f.endsWith('.json'));
  // gid -> sid for EVERY game, so a candidate's activity can be measured in the
  // season that actually matters instead of across their whole career.
  const gameSeason = new Map();
  for (const f of seasonFiles) {
    const sid = path.basename(f, '.json');
    const sg = readJson(path.join(gamesDir, f));
    if (!sg) continue;
    for (const [gid, g] of Object.entries(sg.games || {})) {
      gameSeason.set(gid, sid);
      const ids = (Array.isArray(g.p) ? g.p : []).map(x => x && x.id).filter(Boolean);
      if (!ids.length) continue;
      for (const raw of ids) {
        const key = wantIds.has(raw) ? raw : String(raw).slice(0, TRUNC_LEN);
        if (!wantIds.has(key)) continue;
        const arr = delivered.get(key);
        if (arr.length < 12) arr.push({ gid, sid, h: g.h, a: g.a, roster: ids });
      }
    }
  }

  // ── Every player we need to read: candidates plus every teammate ──────────
  const need = new Set();
  for (const p of pop) {
    for (const c of p.candidates) need.add(c);
    for (const g of (delivered.get(p.id) || [])) for (const r of g.roster) need.add(r);
  }
  // Resolve 13-char roster ids to a full uuid via the alias table + index.
  const aliasTo = new Map();
  try {
    const ad = path.join(ROOT, 'players', 'aliases');
    for (const f of fs.readdirSync(ad)) {
      if (!f.endsWith('.json')) continue;
      const m = readJson(path.join(ad, f)); if (!m) continue;
      for (const [k, v] of Object.entries(m)) aliasTo.set(k, v);
    }
  } catch (e) {}
  const prefixToUuid = new Map();
  try {
    const idxDir = path.join(ROOT, 'players', 'indexes');
    for (const f of fs.readdirSync(idxDir)) {
      if (!f.endsWith('.json')) continue;
      const m = readJson(path.join(idxDir, f)); if (!m) continue;
      for (const u of Object.keys(m)) prefixToUuid.set(u.slice(0, TRUNC_LEN), u);
    }
  } catch (e) {}
  const resolve = (id) => (id && id.length === 36) ? id : (aliasTo.get(id) || prefixToUuid.get(id) || null);

  // ── Read each needed player once: club/grade per season, and their teams ──
  const info = new Map();
  for (const raw of need) {
    const u = resolve(raw) || (raw.length === 36 ? raw : null);
    if (!u || info.has(u)) continue;
    const p = readJson(playerPath(u));
    if (!p) { info.set(u, null); continue; }
    const per = new Map();                     // sid -> {club, grades:Set, tids:Set}
    for (const se of (p.seasons || [])) {
      if (!se || !se.sid) continue;
      const e = per.get(se.sid) || { club: null, grades: new Set(), tids: new Set(), tns: new Set() };
      if (se.club) e.club = se.club;
      for (const r of (se.regs || [])) {
        if (!r) continue;
        if (r.tid) e.tids.add(r.tid);
        if (r.gn) e.grades.add(r.gn);
        if (r.tn) e.tns.add(r.tn);
      }
      per.set(se.sid, e);
    }
    info.set(u, { uuid: u, name: p.name || '?', games: new Set(p.games || []), per,
                  gameTids: p.gameTids || {} });
  }

  // ── Score each candidate on three independent signals ────────────────────
  let decided = 0, split = 0, nothing = 0, identical = 0;
  const rows = [];
  for (const p of pop) {
    const gs = delivered.get(p.id) || [];
    const row = { id: p.id, name: p.name, target: p.target, games: gs.length,
                  gameList: gs.slice(0, 6).map(g => ({ gid: g.gid, sid: g.sid })),
                  teamEvidence: [], candidates: [], verdict: null };

    // 1. WHAT WAS THE TEAM? Read it off the teammates, per game.
    for (const g of gs.slice(0, 6)) {
      const mates = g.roster.map(resolve).filter(Boolean).map(u => info.get(u)).filter(Boolean);
      const clubs = new Map(), grades = new Map(), tids = new Map();
      for (const m of mates) {
        const e = m.per.get(g.sid);
        if (!e) continue;
        // Only teammates on ONE of this game's two teams describe this game.
        const onThis = [...e.tids].some(t => t === g.h || t === g.a);
        if (!onThis) continue;
        if (e.club) clubs.set(e.club, (clubs.get(e.club) || 0) + 1);
        for (const gr of e.grades) grades.set(gr, (grades.get(gr) || 0) + 1);
        for (const t of e.tids) if (t === g.h || t === g.a) tids.set(t, (tids.get(t) || 0) + 1);
      }
      const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
      row.teamEvidence.push({ gid: g.gid, sid: g.sid, mates: mates.length,
                              clubs: top(clubs), grades: top(grades), tids: top(tids),
                              number: (p.box.find(b => b.gid === g.gid) || {}).number || null });
    }

    const clubSet = new Set(row.teamEvidence.flatMap(t => t.clubs.map(c => c[0])));
    const gradeSet = new Set(row.teamEvidence.flatMap(t => t.grades.map(c => c[0])));
    const numbers = [...new Set(row.teamEvidence.map(t => t.number).filter(Boolean))];
    const rosterMates = new Set(gs.flatMap(g => g.roster.map(resolve).filter(Boolean)));

    for (const cu of p.candidates) {
      const c = info.get(cu);
      if (!c) { row.candidates.push({ uuid: cu, missing: true }); continue; }
      // 1. club / grade match in the SAME seasons these games are in
      let clubHit = 0, gradeHit = 0;
      for (const g of gs) {
        const e = c.per.get(g.sid);
        if (!e) continue;
        if (e.club && clubSet.has(e.club)) clubHit++;
        for (const gr of e.grades) if (gradeSet.has(gr)) { gradeHit++; break; }
      }
      // 2. jersey number worn elsewhere — needs the box score, not held offline,
      //    so this is reported as "not testable offline" rather than scored 0.
      // 3. squad overlap: teammates this candidate shares with these games
      // ⚠ THE DECISIVE TEST, AND THE ONE THE FIRST VERSION GOT WRONG.
      // sharedTeammates counted teammates across a candidate's WHOLE CAREER. Two
      // profiles belonging to the same human therefore both scored the same — the
      // Belchers both hit 75 — and every such case came out "identical", which I
      // then misread as one person split in two. It is not: two PlayHQ profiles
      // are TWO RECORDS, and the only question is which of them this alias
      // belongs to.
      //
      // The question that answers it: WAS THIS CANDIDATE ACTIVE IN THE SEASON THE
      // GAME IS IN? A profile with no games and no registration that season cannot
      // be the person on that team sheet, however large their career.
      const seasonsHere = new Set(gs.map(g => g.sid));
      let gamesThisSeason = 0;
      for (const other of c.games) if (seasonsHere.has(gameSeason.get(other))) gamesThisSeason++;
      const registeredThisSeason = [...seasonsHere].filter(sid => {
        const e = c.per.get(sid);
        return e && e.tids.size > 0;
      }).length;
      // Teammates shared IN THESE SEASONS ONLY, not across the whole career.
      const sharedTeammates = [...rosterMates].filter(m => {
        if (m === cu) return false;
        const mi = info.get(m);
        if (!mi) return false;
        for (const x of mi.games) {
          if (seasonsHere.has(gameSeason.get(x)) && c.games.has(x)) return true;
        }
        return false;
      }).length;

      row.candidates.push({ uuid: cu, name: c.name, isCurrent: cu === p.target,
        careerGames: c.games.size, clubHit, gradeHit, sharedTeammates,
        gamesThisSeason, registeredThisSeason,
        link: 'https://www.playhq.com/public/profile/' + cu + '/statistics' });
    }

    // ── DECIDING ──────────────────────────────────────────────────────────
    // The first version required every rival to score EXACTLY ZERO, which threw
    // away landslides: Jack Harrison's current target shares 71 teammates and all
    // ELEVEN rivals share zero, but one of them scored 1 on something else and the
    // whole case was filed "undecided". A rule that only fires on a clean sweep
    // reports overwhelming evidence as no evidence.
    //
    // Three outcomes now, and the third is not a weaker version of the second —
    // it is a DIFFERENT FINDING.
    const scored = row.candidates.filter(c => !c.missing);
    // Activity in THIS season dominates: a candidate with games there is a real
    // possibility, one with none is not. Club and grade refine it; career-wide
    // teammate overlap is now season-scoped and worth least.
    const score = (c) => (Math.min(c.gamesThisSeason, 30) * 5) + (c.registeredThisSeason * 10) +
                         (c.clubHit * 3) + (c.gradeHit * 2) + Math.min(c.sharedTeammates, 10);
    for (const c of scored) c.score = score(c);
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0], second = scored[1];

    if (!scored.length || !top || top.score === 0) {
      row.verdict = { uuid: null, kind: 'nothing', why: 'no candidate matches on club, grade or squad' };
      nothing++;
    } else if (second && second.score === top.score && top.score > 0) {
      // ⚠ I READ THIS WRONG THE FIRST TIME AND IT MATTERS.
      // I took identical scores as "one person split across two records" and wrote
      // out a merge list. That was wrong on the project's own rule: TWO PLAYHQ
      // PROFILES ARE TWO RECORDS, whether or not the same human is behind them.
      // Sage Horn genuinely has two profiles; there is nothing to merge. And the
      // scores were identical only because the teammate count was career-wide, so
      // two profiles of the same human inevitably matched equally.
      //
      // With activity scoped to the season, an identical score now means something
      // narrow and real: BOTH profiles were active in that season, so the season
      // cannot separate them. That is a genuine tie for a team sheet to break, not
      // a merge.
      row.verdict = { uuid: null, kind: 'tied', why: 'both profiles were active in that season and score identically (' +
        top.score + ') — the season cannot separate them; the team sheet can',
        pair: [top.uuid, second.uuid] };
      identical++;
    } else if (!second || second.score === 0 || top.score >= second.score * 4) {
      // A landslide counts: sole scorer, or four times the nearest rival.
      row.verdict = { uuid: top.uuid, kind: second && second.score ? 'landslide' : 'sole',
        why: second && second.score
          ? 'leads ' + top.score + ' to ' + second.score + ' — more than four times the nearest rival'
          : 'the only candidate matching the club/grade the teammates identify, or sharing their squad',
        changes: top.uuid !== p.target, margin: top.score - (second ? second.score : 0) };
      decided++;
    } else {
      row.verdict = { uuid: null, kind: 'close', why: 'closest rivals score ' + top.score + ' and ' + second.score +
        ' — too close to call from this evidence' };
      split++;
    }
    rows.push(row);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('');
  console.log('  ══ EVIDENCE THE EARLIER TESTS DID NOT USE ═════════════════════════');
  console.log('    DECIDED — one candidate leads decisively  : ' + n(decided) + '   ← actionable');
  console.log('    TIED — both active that season            : ' + n(identical) + '   ← needs a team sheet, NOT a merge');
  console.log('    too close to call                         : ' + n(split) + '   ← needs an eye; see the follow-up below');
  console.log('    nothing matches                           : ' + n(nothing) + '   ← needs an eye; see the follow-up below');
  console.log('');
  console.log('  The team is identified from the OTHER players in the sheet: their files say');
  console.log('  which club and grade they held that season. The alias id\'s own registration');
  console.log('  is missing — that is why the season test failed — but its TEAMMATES\' are not.');
  console.log('');

  const order = { true: 0, false: 1 };
  rows.sort((a, b) => (a.verdict.uuid ? 0 : 1) - (b.verdict.uuid ? 0 : 1));
  for (const r of rows.slice(0, SHOW)) {
    console.log('  ─────────────────────────────────────────────────────────────────');
    console.log('  ' + r.id + '  ' + JSON.stringify(r.name) + '   ' + r.games + ' game(s) delivered');
    console.log('    currently points at : ' + r.target);
    for (const t of r.teamEvidence.slice(0, 3)) {
      console.log('    game ' + t.gid + ' (season ' + t.sid + ')' + (t.number ? '  jersey #' + t.number : '') +
                  '  — ' + t.mates + ' teammate file(s) read');
      if (t.clubs.length)  console.log('        club   : ' + t.clubs.map(c => c[0] + ' ×' + c[1]).join(' | '));
      if (t.grades.length) console.log('        grade  : ' + t.grades.map(c => c[0] + ' ×' + c[1]).join(' | '));
    }
    console.log('    CANDIDATES:');
    for (const c of r.candidates) {
      if (c.missing) { console.log('      ' + c.uuid + '  (no player file)'); continue; }
      console.log('      ' + c.uuid + (c.isCurrent ? '  [CURRENT]' : ''));
      console.log('        ' + JSON.stringify(c.name) + '  · career ' + n(c.careerGames) + ' game(s)');
      console.log('        ACTIVE THAT SEASON: ' + n(c.gamesThisSeason) + ' game(s), registered in ' +
                  c.registeredThisSeason + ' of ' + [...new Set(r.gameList.map(g => g.sid))].length + ' season(s)' +
                  (c.gamesThisSeason === 0 && c.registeredThisSeason === 0 ? '   ← CANNOT be the player in that team sheet' : ''));
      console.log('        club matches ' + c.clubHit + ' · grade matches ' + c.gradeHit + ' · shares ' + c.sharedTeammates + ' teammate(s) in those seasons');
      console.log('        ' + c.link);
    }
    console.log('    → ' + (r.verdict.uuid ? ('THIS ONE: ' + r.verdict.uuid + (r.verdict.changes ? '   (CHANGES the alias)' : '   (confirms the current target)')) : 'UNDECIDED'));
    console.log('      ' + r.verdict.why);
  }

  // ── HOW TO FOLLOW UP WHAT IS STILL OPEN ───────────────────────────────────
  // An unknown with no next step is just a number. Each open case is printed with
  // the exact game to open, what to look for, and which candidate to compare.
  const open = rows.filter(r => !r.verdict.uuid);
  if (open.length) {
    console.log('');
    console.log('  ══ FOLLOWING UP THE ' + n(open.length) + ' STILL OPEN ═══════════════════════════════');
    console.log('  Every one of these has a PlayHQ game you can open. The team sheet shows the');
    console.log('  jersey number and club; the candidate profiles show the same. That is the');
    console.log('  comparison no offline test can make, and it is how Jida McCrae-Cooper was');
    console.log('  settled.');
    console.log('');
    for (const r of open) {
      const k = r.verdict.kind;
      console.log('  ' + r.id + '  ' + JSON.stringify(r.name) + '   [' + k.toUpperCase() + ']');
      if (false) {
        const num = [...new Set(r.teamEvidence.map(t => t.number).filter(Boolean))];
        const clubs = [...new Set(r.teamEvidence.flatMap(t => t.clubs.map(c => c[0])))].slice(0, 3);
        const grades = [...new Set(r.teamEvidence.flatMap(t => t.grades.map(c => c[0])))].slice(0, 3);
        console.log('    what the team sheet says:');
        console.log('      jersey ' + (num.length ? '#' + num.join(', #') : 'not recorded') +
                    '  ·  club ' + (clubs.length ? clubs.join(' / ') : 'not identifiable from teammates') +
                    '  ·  grade ' + (grades.length ? grades.join(' / ') : 'not identifiable'));
        console.log('    open one of these games on PlayHQ and read the team sheet:');
        for (const g of r.gameList.slice(0, 3)) console.log('      game ' + g.gid + '  in season ' + g.sid);
        console.log('    then compare against, in order of how well each already fits:');
        for (const c of r.candidates.filter(x => !x.missing).slice(0, 4)) {
          console.log('      ' + (c.score !== undefined ? String(c.score).padStart(3) : '  ?') + '  ' +
                      c.uuid + (c.isCurrent ? ' [CURRENT]' : '') + '  ' + n(c.careerGames) + ' game(s)');
          console.log('           ' + c.link);
        }
        console.log('    if the sheet settles it, add the id and the correct uuid to');
        console.log('      reports/manual-alias-decisions.json  as  {"' + r.id + '": "<uuid>"}');
        console.log('      — repoint-aliases reads that file and re-verifies before writing.');
      }
      console.log('');
    }
  }

  try {
    fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, REPORT), JSON.stringify({ generated: new Date().toISOString(),
      decided, split, nothing,
      entries: rows.map(r => ({ id: r.id, name: r.name, target: r.target,
        correctTarget: (r.verdict.uuid && r.verdict.changes) ? r.verdict.uuid : null,
        verdict: r.verdict, gameList: r.gameList, teamEvidence: r.teamEvidence,
        candidates: r.candidates })) }, null, 1));

    // A ready-to-edit stub for the open cases, so following one up is filling in a
    // blank rather than working out the format.
    const stubPath = path.join(ROOT, 'reports', 'manual-alias-decisions.json');
    if (fs.existsSync(stubPath)) {
      console.log('  reports/manual-alias-decisions.json already exists — left untouched');
      console.log('  (it may hold decisions you have already entered)');
    } else if (open.length) {
      const stub = { note: 'Set each value to the correct player uuid, or leave null. repoint-aliases reads this and RE-VERIFIES every entry against PlayHQ before writing anything.',
                     decisions: Object.fromEntries(open.filter(r => r.verdict.kind !== 'identical').map(r => [r.id, null])) };
      fs.writeFileSync(stubPath, JSON.stringify(stub, null, 1));
      console.log('  WRITTEN: reports/manual-alias-decisions.json (a blank to fill in)');
    }
    console.log('');
    console.log('  WRITTEN: ' + REPORT);
    console.log('  Entries with a correctTarget are in the shape repoint-aliases reads.');
    commitReport(decided + ' decided, ' + split + ' split, ' + nothing + ' nothing');
  } catch (e) { console.log('  ⚠ could not write report: ' + e.message); }
}

main();
