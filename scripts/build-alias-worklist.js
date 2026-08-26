// scripts/build-alias-worklist.js
//
// READ-ONLY, offline, ZERO API calls. Writes and COMMITS two files.
//
// TURNS THE LAST 40 ALIASES INTO TWO THINGS YOU CAN ACT ON, with no report to
// read and no ids to copy out by hand.
//
// probe-squad-evidence settles what the season evidence can settle. Whatever is
// left is ONE question, not two: WHICH OF THE PROFILES DOES THIS ALIAS BELONG TO?
//
// ⚠ AN EARLIER VERSION SPLIT THESE IN TWO and wrote a "merge candidates" file for
// the cases where two records scored identically, on the reading that they were
// one person split across two records. That was wrong on the project's own rule:
// TWO PLAYHQ PROFILES ARE TWO RECORDS, whatever the truth about the human behind
// them. Sage Horn genuinely has two profiles and there is nothing to merge. The
// scores were identical only because the teammate count was career-wide, so two
// profiles of one human matched equally by construction.
//
// This writes a numbered checklist: the exact game URL to open, the name and
// jersey to look for, the club it should be, the profiles to compare, and the one
// line to write down.
//
// The game URL needs nothing but the game id — `playhq_api_reference.md` §Game URL
// construction: "Only the gameId matters", so org/competition/grade can be `a/a/a`.
//
// Usage: node scripts/build-alias-worklist.js

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = process.env.SCAN_ROOT || path.join(__dirname, '..');
const n = (x) => Number(x || 0).toLocaleString();

// EVERY file this tool writes. commitReport stages all of them — a helper that is
// right for one file and silently wrong for a second is how the
// manual-alias-decisions stub was nearly lost (directive B).
const DECISIONS = 'reports/manual-alias-decisions.json';
// Every file this tool writes. Indexing into this array is how the stub path
// silently became the wrong element when the merge list was removed — the paths
// are named constants now.
const REPORTS = [DECISIONS];
const gameUrl = (gid) => 'https://www.playhq.com/basketball-victoria/org/a/a/a/game-centre/' + gid;
const profileUrl = (u) => 'https://www.playhq.com/public/profile/' + u + '/statistics';

const _GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
function commitReports(msg) {
  try {
    for (const f of REPORTS) { try { execSync('git add -- ' + f, _GIT); } catch (e) {} }
    const staged = execSync('git diff --staged --shortstat', _GIT).toString().trim();
    if (!staged) { console.log('  nothing to commit'); return; }
    console.log('  staging: ' + staged);
    execSync('git commit -q -m "build-alias-worklist: ' + String(msg).replace(/"/g, "'") + '"', _GIT);
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

function main() {
  let audit;
  try { audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'squad-evidence-audit.json'), 'utf8')); }
  catch (e) { console.error('ABORT: reports/squad-evidence-audit.json not readable — ' + e.message); process.exit(1); }
  const entries = audit.entries || [];
  // ⚠ NO MERGE LIST. An earlier version split these into "identical → merge" and
  // "close → check", on the reading that two records scoring the same were one
  // person split in two. That breaks the project's own rule: TWO PLAYHQ PROFILES
  // ARE TWO RECORDS, whatever the truth about the human. Sage Horn has two real
  // profiles and nothing to merge.
  //
  // Every unresolved case is now ONE question — which of the profiles does this
  // alias belong to — and one checklist.
  const close = entries.filter(e => e.verdict && !e.verdict.uuid);
  console.log('  entries in the audit : ' + n(entries.length));
  console.log('    still unresolved   : ' + n(close.length) + '   ← all ONE question: which profile does the alias belong to?');
  console.log('');

  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });

  // ── THE FILL-IN FILE ──────────────────────────────────────────────────────
  // ⚠ A LIST OF IDS AND NULLS IS USELESS. The first version wrote exactly that —
  // six bare ids to fill in — so using it meant reading the ids, finding each one
  // in the console output, and copying uuids back by hand. Everything needed to
  // decide is written INTO the file: the name, the games to open, the jersey to
  // look for, and each candidate with its link and what is known about it.
  //
  // It is also REBUILT each run rather than left alone once created. The stale
  // version listed six aliases, three of which have since been decided
  // automatically — a file that cannot follow the evidence is worse than none.
  // Decisions already entered are carried across; nothing typed is lost.
  const stubPath = path.join(ROOT, DECISIONS);
  let previous = {};
  try {
    const old = JSON.parse(fs.readFileSync(stubPath, 'utf8'));
    for (const [k, v] of Object.entries(old.decisions || {})) {
      const val = (v && typeof v === 'object') ? v.decision : v;
      if (val) previous[k] = val;
    }
  } catch (e) {}

  const decisions = {};
  for (const e of close) {
    const nums = [...new Set((e.teamEvidence || []).map(t => t.number).filter(Boolean))];
    const clubs = [...new Set((e.teamEvidence || []).flatMap(t => (t.clubs || []).map(c => c[0])))].slice(0, 3);
    const grades = [...new Set((e.teamEvidence || []).flatMap(t => (t.grades || []).map(c => c[0])))].slice(0, 2);
    decisions[e.id] = {
      decision: previous[e.id] || null,
      player: e.name,
      lookFor: JSON.stringify(e.name) + (nums.length ? ' wearing #' + nums.join(' or #') : ' (no jersey recorded)'),
      teamShouldBe: clubs.length ? clubs.join(' / ') : 'not identifiable from teammates',
      grade: grades.length ? grades.join(' / ') : 'not identifiable',
      openTheseGames: (e.gameList || []).slice(0, 3).map(g => gameUrl(g.gid)),
      chooseBetween: (e.candidates || []).filter(c => !c.missing).map(c => ({
        uuid: c.uuid,
        name: c.name,
        isCurrentTarget: !!c.isCurrent,
        activeThatSeason: (c.gamesThisSeason ?? '?') + ' game(s), registered in ' + (c.registeredThisSeason ?? '?') + ' season(s)',
        careerGames: c.careerGames,
        profile: c.link,
      })),
    };
  }
  const carried = Object.keys(previous).filter(k => decisions[k]).length;
  const dropped = Object.keys(previous).filter(k => !decisions[k]);
  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  fs.writeFileSync(stubPath, JSON.stringify({
    note: 'For each entry: open one of openTheseGames, find the player named in lookFor on the team sheet, note the club, then set "decision" to the uuid from chooseBetween that played for that club. Leave null if the current target is already right. repoint-aliases reads this and re-verifies every entry before writing.',
    decisions }, null, 1));
  console.log('  WRITTEN: ' + DECISIONS + ' — ' + n(close.length) + ' entrie(s), each with the games,');
  console.log('  the jersey, the club to look for, and the candidates to choose between');
  if (carried) console.log('  carried across ' + n(carried) + ' decision(s) you had already entered');
  if (dropped.length) console.log('  ⚠ ' + n(dropped.length) + ' previously-entered decision(s) are no longer open: ' + dropped.join(', '));

  // ── 2. The checklist: URL, what to look for, what to write down ──────────
  console.log('  ══ THE WHOLE JOB, IN ORDER ════════════════════════════════════════');
  console.log('  For each: open the GAME url, find the player in the team sheet, note the');
  console.log('  CLUB and JERSEY NUMBER, then open the candidate profiles and see which one');
  console.log('  played for that club. Write the winning uuid into');
  console.log('  reports/manual-alias-decisions.json. Nothing else is needed — repoint-aliases');
  console.log('  reads that file and re-verifies against PlayHQ before it writes anything.');
  console.log('');
  let i = 0;
  for (const e of close) {
    i++;
    const nums = [...new Set((e.teamEvidence || []).map(t => t.number).filter(Boolean))];
    const clubs = [...new Set((e.teamEvidence || []).flatMap(t => (t.clubs || []).map(c => c[0])))];
    const grades = [...new Set((e.teamEvidence || []).flatMap(t => (t.grades || []).map(c => c[0])))];
    console.log('  ── ' + i + ' of ' + close.length + ' ─ ' + JSON.stringify(e.name) + ' ─────────────────────────────');
    console.log('     OPEN THIS GAME:');
    for (const g of (e.gameList || []).slice(0, 2)) console.log('       ' + gameUrl(g.gid));
    console.log('     LOOK FOR: a player called ' + JSON.stringify(e.name) +
                (nums.length ? ' wearing #' + nums.join(' or #') : ' (no jersey number recorded)'));
    if (clubs.length)  console.log('       their team should be one of: ' + clubs.slice(0, 3).join(' / '));
    if (grades.length) console.log('       in the grade: ' + grades.slice(0, 2).join(' / '));
    console.log('     THEN OPEN THESE AND SEE WHICH ONE PLAYED FOR THAT CLUB:');
    for (const c of (e.candidates || []).filter(c => !c.missing).slice(0, 5)) {
      console.log('       ' + profileUrl(c.uuid) + (c.isCurrent ? '   ← the alias points here NOW' : ''));
      console.log('           ' + JSON.stringify(c.name) + ', ' + n(c.careerGames) + ' games, shares ' +
                  n(c.sharedTeammates) + ' teammate(s) with this squad');
    }
    console.log('     WRITE DOWN: in reports/manual-alias-decisions.json set');
    console.log('       "' + e.id + '": "<the winning uuid>"');
    console.log('     IF IT IS ALREADY RIGHT: leave it null — no action needed.');
    console.log('');
  }

  commitReports(close.length + ' to check by hand');
}

main();
