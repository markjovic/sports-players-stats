// scripts/size-locked-resweep.js
// READ-ONLY sizing v2 for OUTSTANDING §2.2 (pivoted 2026-08-03: the file-less target set
// measured EMPTY, so the work is a re-sweep of LOCKED seasons to close the incomplete-locked
// populations — the 489, the tournament gaps, the no-`rn` seasons — in one structural pass).
//
// Reads the locked seasons' OWN game files plus players/indexes history and produces:
//   1. Call volume for the re-sweep: discoverGrade per grade + discoverTeamFixture per team.
//      Teams per season = union of h/a (+ t1/t2 hidden) across the season's games, UNION the
//      teams reachable through player-reg history — the ladder count the sweep will actually
//      enumerate sits near this union.
//   2. REGS-ONLY teams per season — teams with registrations but ZERO games on file. The
//      most direct local signal of missing games a locked season can show.
//   3. Free re-measures: seasons with 0% `rn` coverage (the "68 no-rn" population), and
//      pending-looking games (no scores, st != FINAL, no forfeit) inside locked seasons.
//   4. Parse-failure list across every locked game file — discover-fixtures.js currently
//      falls back to {games:{}} on a corrupt file (Phase 0 finding), so any corruption must
//      be known BEFORE a writer runs.
//
// Every counter prints samples (T15). Writes /tmp only — never touches the repo.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPORT = '/tmp/size-locked-resweep-report.json';

function lsSidSet(dir) {
  const out = execSync(`git ls-tree -r --name-only HEAD -- ${dir}`, {
    cwd: ROOT, maxBuffer: 64 * 1024 * 1024,
  }).toString();
  const set = new Set();
  for (const line of out.split('\n')) {
    if (line.endsWith('.json')) set.add(path.basename(line, '.json'));
  }
  return set;
}

function main() {
  const t0 = Date.now();
  const sportsIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sports-index.json'), 'utf8'));
  const seasons = sportsIndex.seasons || {};
  const gameSids = lsSidSet('games/bv');

  // ── Locked, not removed ──────────────────────────────────────────────────
  const locked = [];
  let lockedNoFile = 0; // sanity — v1 measured this as 0
  for (const [sid, s] of Object.entries(seasons)) {
    if (s.removed === true || !s.locked) continue;
    if (!gameSids.has(sid)) { lockedNoFile++; continue; }
    locked.push(sid);
  }

  // ── Pass 1: game files — teams played, rn coverage, pending, parse health ─
  const per = new Map(); // sid -> record
  const parseFailures = [];
  let filesRead = 0, totalGames = 0;
  for (const sid of locked) {
    const f = path.join(ROOT, 'games', 'bv', `${sid}.json`);
    let sg;
    try { sg = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { parseFailures.push({ sid, error: String(e.message).slice(0, 120) }); continue; }
    filesRead++;
    const teams = new Set();
    let games = 0, withRn = 0, pending = 0;
    for (const g of Object.values(sg.games || {})) {
      if (!g) continue;
      games++;
      if (g.h) teams.add(g.h);
      if (g.a) teams.add(g.a);
      if (g.t1) teams.add(g.t1); // hidden-game team fields
      if (g.t2) teams.add(g.t2);
      if (g.rn) withRn++;
      if (g.hs === undefined && g.as === undefined && g.st !== 'FINAL' && g.forfeit !== true) pending++;
    }
    totalGames += games;
    per.set(sid, {
      sid,
      name: seasons[sid].name || '', org: seasons[sid].orgName || '',
      grades: (seasons[sid].grades || []).length,
      games, playedTeams: teams, regsOnlyTeams: new Set(),
      rnPct: games ? Math.round((withRn / games) * 100) : 0,
      pending,
    });
  }

  // ── Pass 2: players/indexes history — regs-derived teams ────────────────
  const lockedSet = new Set(per.keys());
  const idxDir = path.join(ROOT, 'players', 'indexes');
  let playersScanned = 0;
  for (const f of fs.readdirSync(idxDir).sort()) {
    if (!f.endsWith('.json')) continue;
    const shard = JSON.parse(fs.readFileSync(path.join(idxDir, f), 'utf8'));
    for (const rec of Object.values(shard)) {
      playersScanned++;
      const h = rec.history;
      if (!h) continue;
      for (const sid in h) {
        if (!lockedSet.has(sid)) continue;
        const r = per.get(sid);
        for (const tid of h[sid] || []) {
          if (!r.playedTeams.has(tid)) r.regsOnlyTeams.add(tid);
        }
      }
    }
  }

  // ── Aggregate ────────────────────────────────────────────────────────────
  const rows = [...per.values()].map((r) => ({
    sid: r.sid, name: r.name, org: r.org, grades: r.grades, games: r.games,
    teamsPlayed: r.playedTeams.size, teamsRegsOnly: r.regsOnlyTeams.size,
    teamsUnion: r.playedTeams.size + r.regsOnlyTeams.size,
    rnPct: r.rnPct, pending: r.pending,
  }));
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  const totalGrades = sum('grades');
  const totalTeams = sum('teamsUnion');
  const totalCalls = totalGrades + totalTeams;
  const regsOnlyTotal = sum('teamsRegsOnly');
  const seasonsWithRegsOnly = rows.filter((r) => r.teamsRegsOnly > 0);
  const noRn = rows.filter((r) => r.games > 0 && r.rnPct === 0);
  const withPending = rows.filter((r) => r.pending > 0);
  const proj = (rate) => {
    const secs = totalCalls / rate;
    return `${(secs / 3600).toFixed(1)} h  (${(secs / 60).toFixed(0)} min)`;
  };
  const chunks5h = Math.ceil(totalCalls / 15 / 3600 / 5);

  const line = (l, v) => console.log(`  ${l.padEnd(50, '.')} ${v}`);
  console.log('════════════════════════════════════════════════════════════');
  console.log('  size-locked-resweep — §2.2 sizing v2 (locked re-sweep)');
  console.log('════════════════════════════════════════════════════════════');
  line('Locked seasons (not removed)', (locked.length + lockedNoFile).toLocaleString());
  line('  with a game file (the re-sweep set)', locked.length.toLocaleString());
  line('  WITHOUT a game file (sanity: v1 said 0)', String(lockedNoFile));
  line('  game files parsed / PARSE FAILURES', `${filesRead.toLocaleString()} / ${parseFailures.length}`);
  line('Total games across the set', totalGames.toLocaleString());
  line('Players scanned (indexes)', playersScanned.toLocaleString());
  console.log('────────────────────────────────────────────────────────────');
  line('Grade probes (Σ grades)', totalGrades.toLocaleString());
  line('Team fixtures (Σ played ∪ regs teams)', totalTeams.toLocaleString());
  line('TOTAL CALLS for the re-sweep', totalCalls.toLocaleString());
  line('Projected wall @ 15/s (07-19 measured)', proj(15));
  line('Projected wall @ 10/s (conservative)', proj(10));
  line('Chunks under the 6h cap (5h effective, 15/s)', String(chunks5h));
  console.log('────────────────────────────────────────────────────────────');
  line('REGS-ONLY teams (registered, zero games on file)', regsOnlyTotal.toLocaleString());
  line('  seasons showing >=1 regs-only team', seasonsWithRegsOnly.length.toLocaleString());
  line('No-rn seasons (0% rn, >0 games) [the "68"]', noRn.length.toLocaleString());
  line('Seasons with pending-looking games', withPending.length.toLocaleString());
  line('  pending games total', sum('pending').toLocaleString());
  console.log('────────────────────────────────────────────────────────────');

  const show = (r) => console.log(
    `    ${r.sid}  ${String(r.teamsPlayed).padStart(4)}t+${String(r.teamsRegsOnly).padStart(3)}ro  ` +
    `${String(r.games).padStart(6)}g  rn${String(r.rnPct).padStart(3)}%  ${r.name} — ${r.org}`);
  console.log('  SAMPLES — 10 seasons by regs-only teams (most-incomplete signal):');
  for (const r of [...rows].sort((a, b) => b.teamsRegsOnly - a.teamsRegsOnly).slice(0, 10)) show(r);
  console.log('  SAMPLES — 10 largest by union teams (call-volume drivers):');
  for (const r of [...rows].sort((a, b) => b.teamsUnion - a.teamsUnion).slice(0, 10)) show(r);
  console.log('  SAMPLES — up to 10 no-rn seasons:');
  for (const r of noRn.slice(0, 10)) show(r);
  console.log('  SAMPLES — up to 10 seasons with pending games:');
  for (const r of [...withPending].sort((a, b) => b.pending - a.pending).slice(0, 10)) {
    console.log(`    ${r.sid}  pending ${String(r.pending).padStart(5)}  of ${r.games}g  ${r.name} — ${r.org}`);
  }
  if (parseFailures.length) {
    console.log('  ⚠ PARSE FAILURES (fix before ANY writer touches these):');
    for (const p of parseFailures.slice(0, 20)) console.log(`    ${p.sid}  ${p.error}`);
  }
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  fs.writeFileSync(REPORT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: {
      lockedWithFile: locked.length, lockedNoFile, parseFailures: parseFailures.length,
      totalGames, totalGrades, totalTeams, totalCalls, regsOnlyTotal,
      seasonsWithRegsOnly: seasonsWithRegsOnly.length, noRnSeasons: noRn.length,
      pendingSeasons: withPending.length, pendingGames: sum('pending'), chunks5h,
    },
    rows, parseFailures,
  }, null, 2));
  console.log(`  Report written: ${REPORT}`);
}

main();
