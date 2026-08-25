// scripts/build-alias-worklist.js
//
// READ-ONLY, offline, ZERO API calls. Writes and COMMITS two files.
//
// TURNS THE LAST 40 ALIASES INTO TWO THINGS YOU CAN ACT ON, with no report to
// read and no ids to copy out by hand.
//
// probe-squad-evidence settled 19 of the 40 — all confirming the alias already in
// place. The other 21 fall into two groups that need completely different actions,
// and neither is "read the report":
//
//   15 IDENTICAL   two candidate records score the SAME on club, grade and squad.
//                  That is the shape of ONE PERSON SPLIT ACROSS TWO RECORDS, not a
//                  choice between two people. It is a MERGE question, and the tool
//                  for it is probe-duplicate-profiles, which needs the pairs in its
//                  own format. This writes that file.
//
//   6 CLOSE        two candidates are near enough that only a PlayHQ team sheet
//                  separates them. This writes a numbered checklist: the exact URL
//                  to open, what to look for on the page, and the one line to fill
//                  in when you have looked.
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
const REPORTS = ['reports/alias-merge-candidates.json', 'reports/manual-alias-decisions.json'];
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
  const identical = entries.filter(e => e.verdict && e.verdict.kind === 'identical');
  const close     = entries.filter(e => e.verdict && (e.verdict.kind === 'close' || e.verdict.kind === 'nothing'));
  console.log('  entries in the audit : ' + n(entries.length));
  console.log('    identical (merge)  : ' + n(identical.length));
  console.log('    close (your eye)   : ' + n(close.length));
  console.log('');

  // ── 1. The merge candidates, in probe-duplicate-profiles' own format ──────
  const pairs = identical.map(e => {
    const [a, b] = e.verdict.pair;
    const ca = (e.candidates || []).find(c => c.uuid === a) || {};
    const cb = (e.candidates || []).find(c => c.uuid === b) || {};
    return { name: e.name, a, b, aGames: ca.careerGames ?? null, bGames: cb.careerGames ?? null,
             viaAlias: e.id, aLink: profileUrl(a), bLink: profileUrl(b) };
  });
  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, REPORTS[0]), JSON.stringify({
    generated: new Date().toISOString(),
    note: 'Pairs whose two records score IDENTICALLY on club, grade and squad — the shape of one person split in two. Feed to probe-duplicate-profiles to ask PlayHQ whether both uuids resolve; if only one does, the other is a phantom and merge-phantom-profiles can absorb it.',
    pairs }, null, 1));

  console.log('  ══ 1. FIFTEEN LIKELY SPLIT IDENTITIES — one dispatch, no reading ══');
  console.log('  WRITTEN: ' + REPORTS[0]);
  console.log('  Run probe-duplicate-profiles against it. It asks PlayHQ whether BOTH uuids');
  console.log('  resolve. If only one does, the other is a phantom and merge-phantom-profiles');
  console.log('  absorbs it — which fixes the alias AND removes a duplicate in one go.');
  console.log('');
  for (const p of pairs) {
    console.log('    ' + JSON.stringify(p.name));
    console.log('      ' + p.a + '  ' + n(p.aGames) + ' game(s)   ' + p.aLink);
    console.log('      ' + p.b + '  ' + n(p.bGames) + ' game(s)   ' + p.bLink);
  }
  console.log('');

  // ⚠ THE FILL-IN FILE IS CREATED BEFORE ANYTHING IS STAGED.
  // The first version wrote it AFTER commitReports ran, so `git add` executed
  // against a path that did not exist yet and the commit carried only the merge
  // list — while the checklist below told the reader to go and edit the missing
  // file. Same class as the stub nearly lost from probe-squad-evidence: staging a
  // file the code has not written yet fails silently.
  // The fill-in file, created only if absent so entered decisions survive.
  const stubPath = path.join(ROOT, REPORTS[1]);
  if (fs.existsSync(stubPath)) {
    console.log('  reports/manual-alias-decisions.json already exists — left untouched');
  } else {
    fs.writeFileSync(stubPath, JSON.stringify({
      note: 'Set each value to the winning player uuid, or leave null if the current alias is already right. repoint-aliases reads this and RE-VERIFIES every entry against PlayHQ before writing.',
      decisions: Object.fromEntries(close.map(e => [e.id, null])) }, null, 1));
    console.log('  WRITTEN: ' + REPORTS[1] + ' — one blank line per case above');
  }

  // ── 2. The checklist: URL, what to look for, what to write down ──────────
  console.log('  ══ 2. SIX TO LOOK AT — the whole job, in order ════════════════════');
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

  commitReports(pairs.length + ' merge candidates, ' + close.length + ' to check by hand');
}

main();
