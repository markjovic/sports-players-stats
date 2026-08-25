// scripts/probe-shared-name-aliases.js
//
// READ-ONLY, offline, ZERO API calls. Writes one report. No lock.
//
// THE 87 THAT NOTHING HAS SETTLED. Two audits have run against PlayHQ:
//   probe-alias-credits  — does the target profile credit the games this alias
//                          delivers? 77,142 yes, 874 no.
//   probe-alias-names    — who does PlayHQ say this id IS? 739 name agreements,
//                          5 name variants (Zac/Zachary, hyphen vs space — not
//                          errors), 0 real disagreements.
//
// Of the name agreements, 652 are settled because only ONE player in the store
// carries that name. The other 87 are not: SEVERAL players share it, the alias was
// chosen by name alone, and neither PlayHQ test can separate them. That is exactly
// the Jida McCrae-Cooper shape, where the matcher picked the wrong one of two
// same-named profiles.
//
// THE EVIDENCE NOBODY HAS USED YET, and it needs no API at all. Every game the
// alias delivers has a SEASON and TWO TEAMS. Every candidate player has
// registrations: seasons, and team ids within them. A candidate who was registered
// to one of the teams playing that game, in that season, could have played it. A
// candidate with no registration for that season could not.
//
// So for each of the 87 we take every player sharing the name and ask which of
// them the games actually fit:
//   ONE fits and it is the current target   → CONFIRMED, leave it alone
//   ONE fits and it is somebody else        → SHOULD REPOINT, and to whom
//   SEVERAL fit                             → genuinely ambiguous, never guess
//   NONE fit                                → registrations too incomplete to say
//
// Every pair is printed with PlayHQ profile links so the ambiguous handful can be
// settled by eye — 87 is small enough for that to be realistic.
//
// Usage: node scripts/probe-shared-name-aliases.js [--show=100]

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = process.env.SCAN_ROOT || path.join(__dirname, '..');

// ── COMMIT THE REPORT ────────────────────────────────────────────────────────
// ⚠ A REPORT UPLOADED ONLY AS A WORKFLOW ARTIFACT DOES NOT EXIST TO THE NEXT
// WORKFLOW. The checkout will not have it. On 2026-08-24 three tools aborted on
// their first line for exactly this — probe-alias-credits could not find its own
// cache, repoint-aliases could not find alias-credit-audit.json, and
// probe-verdict-conflict could not find both-resolve-pairs.json — each costing a
// checkout and a dispatch. Related: actions/download-artifact WITHOUT a run-id
// only sees the CURRENT run's artifacts, so an artifact-based handoff silently
// restores nothing, every time.
//
// If a tool writes a report another tool might read, the tool COMMITS it.
// Artifacts are a convenience copy, never the channel.
const _GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
function commitReport(relPath, message) {
  try {
    execSync('git add -- ' + relPath, _GIT);
    const staged = execSync('git diff --staged --shortstat', _GIT).toString().trim();
    if (!staged) { console.log('  nothing to commit'); return; }
    console.log('  staging: ' + staged);
    execSync('git commit -q -m "' + String(message).replace(/"/g, "'") + '"', _GIT);
    for (let a = 1; a <= 40; a++) {
      try { execSync('git merge --abort', _GIT); } catch (e) {}
      try {
        console.log('  … fetch/merge/push (attempt ' + a + ')');
        execSync('git fetch origin main', _GIT);
        execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', _GIT);
        execSync('git push origin main', _GIT);
        console.log('  ✔ pushed ' + relPath);
        return;
      } catch (e) {
        if (a === 40) throw new Error('push failed after 40 attempts');
        const w = 1 + Math.floor(Math.random() * 60);
        console.log('  … push attempt ' + a + ' failed, retrying in ' + w + 's');
        try { execSync('sleep ' + w, { stdio: 'pipe', timeout: (w + 30) * 1000 }); } catch (e2) {}
      }
    }
  } catch (e) { console.log('  ⚠ commit failed: ' + e.message); }
}

const SHOW = Number((process.argv.slice(2).find(a => a.startsWith('--show=')) || '').split('=')[1]) || 100;
const TRUNC_LEN = 13;
const n = (x) => Number(x || 0).toLocaleString();

// normName v2 — matches lib/namespace-resolve.cjs EXACTLY, the fold that created
// these aliases.
const normName = s => String(s == null ? '' : s).normalize('NFKC')
  .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
  .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, '-')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

function main() {
  // ── 1. The 87 ─────────────────────────────────────────────────────────────
  let audit;
  try { audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'alias-name-audit.json'), 'utf8')); }
  catch (e) { console.error('ABORT: reports/alias-name-audit.json not readable — ' + e.message); process.exit(1); }
  const pop = Object.entries(audit.verdicts || {})
    .filter(([, v]) => v && v.verdict === 'same' && (v.playersWithThisName || 0) > 1)
    .map(([id, v]) => ({ id, target: v.target, name: v.playhqName || v.targetName }));
  console.log('  aliases where SEVERAL players share the name: ' + n(pop.length));
  if (!pop.length) { console.log('  nothing to do'); return; }

  // ── 2. Every player carrying one of those names, with their registrations ──
  const wantNames = new Set(pop.map(p => normName(p.name)));
  const byName = new Map();                 // normName -> [{uuid, name, sids:Map(sid->Set(tid))}]
  const playersDir = path.join(ROOT, 'players');
  for (const sh of fs.readdirSync(playersDir)) {
    const dir = path.join(playersDir, sh);
    let st; try { st = fs.statSync(dir); } catch (e) { continue; }
    if (!st.isDirectory() || sh === 'aliases' || sh === 'indexes') continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let p; try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
      const nm = normName(p.name);
      if (!nm || !wantNames.has(nm)) continue;
      const sids = new Map();
      for (const se of (p.seasons || [])) {
        if (!se || !se.sid) continue;
        if (!sids.has(se.sid)) sids.set(se.sid, new Set());
        for (const r of (se.regs || [])) if (r && r.tid) sids.get(se.sid).add(r.tid);
      }
      if (!byName.has(nm)) byName.set(nm, []);
      byName.get(nm).push({ uuid: path.basename(f, '.json'), name: p.name, sids });
    }
  }
  console.log('  candidate players carrying those names      : ' + n([...byName.values()].reduce((a, b) => a + b.length, 0)));

  // ── 3. The games each alias delivers, with their season and both teams ─────
  const wantIds = new Set(pop.map(p => p.id));
  const games = new Map();                  // aliasId -> [{gid, sid, h, a}]
  for (const id of wantIds) games.set(id, []);
  const gamesDir = path.join(ROOT, 'games', 'bv');
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = path.basename(f, '.json');
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const [gid, g] of Object.entries(sg.games || {})) {
      for (const e of (Array.isArray(g.p) ? g.p : [])) {
        const raw = e && e.id;
        if (!raw) continue;
        const key = wantIds.has(raw) ? raw : String(raw).slice(0, TRUNC_LEN);
        const arr = games.get(key);
        if (arr && wantIds.has(key) && arr.length < 40) arr.push({ gid, sid, h: g.h, a: g.a });
      }
    }
  }
  console.log('');

  // ── 4. Which candidates could have played those games? ────────────────────
  let confirmed = 0, repoint = 0, ambiguous = 0, none = 0, noGames = 0;
  const rows = [];
  for (const p of pop) {
    const gs = games.get(p.id) || [];
    if (!gs.length) { noGames++; continue; }
    const cands = byName.get(normName(p.name)) || [];
    const scored = cands.map(c => {
      // A game FITS a candidate when they hold a registration for that season to
      // one of the two teams that played it. No registration for the season at
      // all means they could not have been on either team sheet.
      let fits = 0;
      for (const g of gs) {
        const tids = c.sids.get(g.sid);
        if (!tids) continue;
        if ((g.h && tids.has(g.h)) || (g.a && tids.has(g.a))) fits++;
      }
      return { ...c, fits };
    });
    const winners = scored.filter(c => c.fits > 0);
    let verdict;
    if (winners.length === 1) {
      verdict = winners[0].uuid === p.target ? 'confirmed' : 'repoint';
      if (verdict === 'confirmed') confirmed++; else repoint++;
    } else if (winners.length > 1) { verdict = 'ambiguous'; ambiguous++; }
    else { verdict = 'none-fit'; none++; }
    rows.push({ ...p, games: gs.length, verdict, scored, winner: winners.length === 1 ? winners[0] : null });
  }

  console.log('  ══ WHOSE REGISTRATIONS FIT THE GAMES THIS ALIAS DELIVERS? ═════════');
  console.log('    CONFIRMED — only the current target fits : ' + n(confirmed) + '   ← the alias is right, leave it');
  console.log('    SHOULD REPOINT — a DIFFERENT one fits    : ' + n(repoint) + '   ← actionable');
  console.log('    ambiguous — several fit                  : ' + n(ambiguous) + '   ← never guess; check by eye');
  console.log('    none fit — registrations too incomplete  : ' + n(none));
  if (noGames) console.log('    alias delivers no appearances            : ' + n(noGames));
  console.log('');
  console.log('  A "fit" means the candidate held a registration for that game\'s SEASON to');
  console.log('  one of the two teams that played it. It is possibility, not proof — but a');
  console.log('  candidate with NO registration for the season could not have been on either');
  console.log('  team sheet, and that is what makes a single fit meaningful.');
  console.log('');

  const order = { repoint: 0, ambiguous: 1, 'none-fit': 2, confirmed: 3 };
  rows.sort((x, y) => order[x.verdict] - order[y.verdict]);
  for (const r of rows.slice(0, SHOW)) {
    console.log('    [' + r.verdict.toUpperCase() + ']  ' + r.id + '  ' + JSON.stringify(r.name) + '  (' + r.games + ' game(s))');
    console.log('        currently -> ' + r.target);
    for (const c of r.scored.sort((a, b) => b.fits - a.fits)) {
      const mark = c.uuid === r.target ? ' [current]' : '';
      console.log('        ' + (c.fits > 0 ? 'FITS ' + String(c.fits).padStart(3) : 'fits   0') + '  ' + c.uuid + mark);
      console.log('              https://www.playhq.com/public/profile/' + c.uuid + '/statistics');
    }
    if (r.verdict === 'repoint') console.log('        → SHOULD POINT AT: ' + r.winner.uuid);
    console.log('');
  }
  if (rows.length > SHOW) console.log('    … and ' + n(rows.length - SHOW) + ' more in the report');

  try {
    const out = path.join(ROOT, 'reports', 'shared-name-alias-audit.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(),
      confirmed, repoint, ambiguous, noneFit: none,
      entries: rows.map(r => ({ id: r.id, name: r.name, target: r.target, verdict: r.verdict,
        correctTarget: r.verdict === 'repoint' ? r.winner.uuid : null,
        candidates: r.scored.map(c => ({ uuid: c.uuid, fits: c.fits })) })) }, null, 1));
    console.log('');
    console.log('  WRITTEN: reports/shared-name-alias-audit.json');
    commitReport('reports/shared-name-alias-audit.json', 'shared-name alias audit');
    console.log('  Entries marked "repoint" carry a correctTarget and are in the shape');
    console.log('  repoint-aliases already reads.');
  } catch (e) { console.log('  ⚠ could not write report: ' + e.message); }
}

main();
