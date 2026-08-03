// scripts/size-locked-backfill.js
// READ-ONLY sizing for OUTSTANDING §2.2 Phase 0 (the historical/locked-season game-data backfill).
// Measures the DATA side before anything is built (size-opposition-index.js precedent):
//
//   1. The target set: seasons in sports-index that are LOCKED, not `removed:true`, and have
//      NO games/bv/{sid}.json file. These are the seasons with registrations but zero game data.
//   2. Team enumeration per target season from players/indexes/{xx}.json `history` maps
//      ({sid: [tid,...]}). team-index.json CANNOT be the source here — it is derived from
//      team-stats, which derives from game files, which these seasons do not have. Player regs
//      are the only team-id source that exists for a file-less season.
//   3. Projections: discoverTeamFixture is one call per team. Wall time projected at the
//      measured rate from the 2026-07-19 discover-fixtures run (25,448 teams in 28 min ≈ 15/s)
//      and at a conservative 10/s.
//   4. ZERO-TEAM target seasons — seasons no player-index history reaches. These are unreachable
//      by a regs-based team enumeration and need a decision (probe discoverSeason grades/ladder,
//      or accept as unfetchable alongside removed:true).
//
// Every counter prints samples (claude_context T15). Writes its report to /tmp only — this
// script never touches the repo (no git, no writes under ROOT).
//
// Game-file presence is read via `git ls-tree` (tree objects exist even in a blobless sparse
// checkout), NOT via readdir — the workflow's sparse checkout does not materialise games/bv.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPORT = '/tmp/size-locked-backfill-report.json';

function lsSidSet(dir) {
  // Season ids from filenames under dir, via tree objects (works blobless).
  const out = execSync(`git ls-tree -r --name-only HEAD -- ${dir}`, {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
  const set = new Set();
  for (const line of out.split('\n')) {
    if (!line.endsWith('.json')) continue;
    set.add(path.basename(line, '.json'));
  }
  return set;
}

function main() {
  const t0 = Date.now();

  // ── Inputs ────────────────────────────────────────────────────────────────
  const idxPath = path.join(ROOT, 'data', 'sports-index.json');
  const sportsIndex = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const seasons = sportsIndex.seasons || {};
  const gameSids = lsSidSet('games/bv');
  const teamStatSids = lsSidSet('team-stats/bv');

  // ── 1. Classify every season ─────────────────────────────────────────────
  const targets = [];
  let removed = 0, activeCount = 0, lockedWithGames = 0;
  const anomalies = []; // target seasons that somehow HAVE a team-stats file
  for (const [sid, s] of Object.entries(seasons)) {
    if (s.removed === true) { removed++; continue; }
    if (!s.locked) { activeCount++; continue; }
    if (gameSids.has(sid)) { lockedWithGames++; continue; }
    targets.push(sid);
    if (teamStatSids.has(sid)) anomalies.push(sid);
  }
  const targetSet = new Set(targets);

  // ── 2. Team enumeration from players/indexes history ─────────────────────
  const sidTeams = new Map(targets.map((sid) => [sid, new Set()]));
  const sidPlayers = new Map(); // sid -> registered-player count (index entries touching it)
  const idxDir = path.join(ROOT, 'players', 'indexes');
  let shardsRead = 0, playersScanned = 0;
  for (const f of fs.readdirSync(idxDir).sort()) {
    if (!f.endsWith('.json')) continue;
    const shard = JSON.parse(fs.readFileSync(path.join(idxDir, f), 'utf8'));
    shardsRead++;
    for (const rec of Object.values(shard)) {
      playersScanned++;
      const h = rec.history;
      if (!h) continue;
      for (const sid in h) {
        if (!targetSet.has(sid)) continue;
        const set = sidTeams.get(sid);
        for (const tid of h[sid] || []) set.add(tid);
        sidPlayers.set(sid, (sidPlayers.get(sid) || 0) + 1);
      }
    }
  }

  // ── 3. Aggregate ──────────────────────────────────────────────────────────
  const perSeason = targets
    .map((sid) => ({
      sid,
      teams: sidTeams.get(sid).size,
      players: sidPlayers.get(sid) || 0,
      name: seasons[sid].name || '',
      org: seasons[sid].orgName || '',
    }))
    .sort((a, b) => b.teams - a.teams);
  const totalTeams = perSeason.reduce((n, r) => n + r.teams, 0);
  const zeroTeam = perSeason.filter((r) => r.teams === 0);

  const buckets = { '0': 0, '1-10': 0, '11-50': 0, '51-200': 0, '201+': 0 };
  for (const r of perSeason) {
    if (r.teams === 0) buckets['0']++;
    else if (r.teams <= 10) buckets['1-10']++;
    else if (r.teams <= 50) buckets['11-50']++;
    else if (r.teams <= 200) buckets['51-200']++;
    else buckets['201+']++;
  }

  // ── 4. Projections ────────────────────────────────────────────────────────
  // discoverTeamFixture = 1 call per team. Measured 2026-07-19: 25,448 teams / 28 min ≈ 15.1/s.
  const proj = (rate) => {
    const secs = totalTeams / rate;
    return `${(secs / 3600).toFixed(1)} h  (${(secs / 60).toFixed(0)} min)`;
  };

  // ── Report ────────────────────────────────────────────────────────────────
  const line = (l, v) => console.log(`  ${l.padEnd(48, '.')} ${v}`);
  console.log('════════════════════════════════════════════════════════════');
  console.log('  size-locked-backfill — §2.2 Phase 0 data-side sizing');
  console.log('════════════════════════════════════════════════════════════');
  line('Seasons in sports-index', Object.keys(seasons).length.toLocaleString());
  line('  removed:true stubs (excluded)', removed.toLocaleString());
  line('  active (excluded — nightly covers them)', activeCount.toLocaleString());
  line('  locked WITH a game file (excluded pass-1)', lockedWithGames.toLocaleString());
  line('  TARGET: locked, no game file', targets.length.toLocaleString());
  line('Game files present (games/bv)', gameSids.size.toLocaleString());
  line('Player-index shards read / players scanned', `${shardsRead} / ${playersScanned.toLocaleString()}`);
  console.log('────────────────────────────────────────────────────────────');
  line('Teams reachable via player regs (total)', totalTeams.toLocaleString());
  line('  = discoverTeamFixture calls (1 per team)', totalTeams.toLocaleString());
  line('Projected wall @ 15/s (07-19 measured rate)', proj(15));
  line('Projected wall @ 10/s (conservative)', proj(10));
  console.log('  Team-count histogram over target seasons:');
  for (const [k, v] of Object.entries(buckets)) line(`    ${k} teams`, String(v));
  console.log('────────────────────────────────────────────────────────────');
  line('ZERO-TEAM target seasons (regs reach nothing)', zeroTeam.length.toLocaleString());
  line('Anomaly: target has team-stats but no games', String(anomalies.length));
  console.log('────────────────────────────────────────────────────────────');

  // T15: samples beside every counter that matters.
  console.log('  SAMPLES — 10 largest targets (teams / players / season):');
  for (const r of perSeason.slice(0, 10)) {
    console.log(`    ${r.sid}  ${String(r.teams).padStart(4)} t  ${String(r.players).padStart(5)} p  ${r.name} — ${r.org}`);
  }
  const mid = perSeason.filter((r) => r.teams > 0);
  console.log('  SAMPLES — 5 median-zone targets:');
  for (const r of mid.slice(Math.max(0, Math.floor(mid.length / 2) - 2), Math.floor(mid.length / 2) + 3)) {
    console.log(`    ${r.sid}  ${String(r.teams).padStart(4)} t  ${String(r.players).padStart(5)} p  ${r.name} — ${r.org}`);
  }
  console.log('  SAMPLES — up to 10 ZERO-TEAM targets (unreachable via regs):');
  for (const r of zeroTeam.slice(0, 10)) {
    console.log(`    ${r.sid}  ${r.name} — ${r.org}`);
  }
  if (anomalies.length) {
    console.log('  SAMPLES — anomalies (team-stats without games):');
    for (const sid of anomalies.slice(0, 10)) console.log(`    ${sid}  ${seasons[sid].name} — ${seasons[sid].orgName}`);
  }
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('  NOTE: game/byte volume is NOT projected here — it is measured at Phase 1');
  console.log('  rehearsal on real seasons rather than estimated from a ratio.');

  fs.writeFileSync(REPORT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: {
      seasons: Object.keys(seasons).length, removed, active: activeCount,
      lockedWithGames, targets: targets.length, gameFiles: gameSids.size,
      totalTeams, zeroTeamSeasons: zeroTeam.length, anomalies: anomalies.length,
    },
    buckets,
    perSeason,          // full list — sid, teams, players, name, org
    zeroTeam: zeroTeam.map((r) => r.sid),
    anomalies,
  }, null, 2));
  console.log(`  Report written: ${REPORT}`);
}

main();
