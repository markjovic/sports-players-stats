// scripts/size-missing-gids.js
// READ-ONLY sizing for §2.2 Phase 4(b) — the grading/hidden residue.
//
// Premise (Mark's, measured here): grading comps are hidden and ladder-less, so the
// re-sweep's discover path cannot reach them — but every player's games[] array already
// names their game ids career-wide (built from profile gameStatistics). A gid present in
// player.games[] but ABSENT from every games/bv file IS the hidden/grading residue, and
// each one is fetchable per-gid via the spectator route (the same route that built the
// existing hidden-game data). This scan produces the exact target set with ZERO API calls.
//
// Outputs:
//   - unique missing gids (THE Phase 4(b) number) + total references
//   - refs-per-gid histogram (sanity: real games are referenced by ~8-20 players;
//     a long tail of 1-ref gids would smell like id noise, not games)
//   - zero-team correlation: % of referencing players that hold a reg in one of the
//     1,002 zero-team seasons (reads zero-team-seasons.json committed by the sweep)
//   - T15 samples beside every counter
//   - /tmp/size-missing-gids-report.json with the full gid list for the rescue pass
//
// Requires a FULL checkout: games[] lives in the player DETAIL files (~412k), not the
// index shards. Expect the checkout ~7 min and the scan a few minutes more.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT = '/tmp/size-missing-gids-report.json';
const HEX8 = /^[0-9a-f]{8}$/;

function main() {
  const t0 = Date.now();

  // ── 1. Every gid we HAVE, across all season files ─────────────────────────
  const gamesDir = path.join(ROOT, 'games', 'bv');
  const have = new Set();
  let seasonFiles = 0;
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    seasonFiles++;
    const sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8'));
    for (const gid of Object.keys(sg.games || {})) have.add(gid);
  }

  // ── 2. Zero-team season set (committed by the re-sweep) ──────────────────
  let zeroTeamSids = new Set();
  const ztPath = path.join(ROOT, 'zero-team-seasons.json');
  if (fs.existsSync(ztPath)) {
    zeroTeamSids = new Set(JSON.parse(fs.readFileSync(ztPath, 'utf8')).map((z) => z.id));
  } else {
    console.log('  ⚠ zero-team-seasons.json not found — correlation section will read 0');
  }

  // ── 3. Scan every player detail file's games[] ────────────────────────────
  const playersDir = path.join(ROOT, 'players');
  const missingRefs = new Map(); // gid -> ref count
  let playersScanned = 0, playersWithGames = 0, totalRefs = 0, missingRefTotal = 0;
  let playersWithMissing = 0, playersWithMissingAndZT = 0, badGids = 0;
  const samplePlayers = []; // a few example players with many missing gids

  for (const shard of fs.readdirSync(playersDir).sort()) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue;
    const dir = path.join(playersDir, shard);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      playersScanned++;
      if (playersScanned % 50000 === 0) console.log(`  scanned ${playersScanned.toLocaleString()} players…`);
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch (e) { continue; }
      const games = p.games;
      if (!Array.isArray(games) || games.length === 0) continue;
      playersWithGames++;
      let myMissing = 0;
      for (const gid of games) {
        totalRefs++;
        if (typeof gid !== 'string' || !HEX8.test(gid)) { badGids++; continue; }
        if (have.has(gid)) continue;
        missingRefs.set(gid, (missingRefs.get(gid) || 0) + 1);
        missingRefTotal++;
        myMissing++;
      }
      if (myMissing > 0) {
        playersWithMissing++;
        const hasZT = (p.seasons || []).some((s) => zeroTeamSids.has(s.sid));
        if (hasZT) playersWithMissingAndZT++;
        if (samplePlayers.length < 10 || myMissing > samplePlayers[samplePlayers.length - 1].missing) {
          samplePlayers.push({ uuid: p.uuid, name: p.name, missing: myMissing, total: games.length, zeroTeamReg: hasZT });
          samplePlayers.sort((a, b) => b.missing - a.missing);
          if (samplePlayers.length > 10) samplePlayers.pop();
        }
      }
    }
  }

  // ── 4. Aggregate ──────────────────────────────────────────────────────────
  const uniqueMissing = missingRefs.size;
  const buckets = { '1': 0, '2-4': 0, '5-9': 0, '10-19': 0, '20+': 0 };
  for (const n of missingRefs.values()) {
    if (n === 1) buckets['1']++;
    else if (n <= 4) buckets['2-4']++;
    else if (n <= 9) buckets['5-9']++;
    else if (n <= 19) buckets['10-19']++;
    else buckets['20+']++;
  }
  const topGids = [...missingRefs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const multiRef = uniqueMissing - buckets['1'];

  const line = (l, v) => console.log(`  ${l.padEnd(52, '.')} ${v}`);
  console.log('════════════════════════════════════════════════════════════');
  console.log('  size-missing-gids — §2.2 Phase 4(b) grading/hidden residue');
  console.log('════════════════════════════════════════════════════════════');
  line('Season files read / gids on file', `${seasonFiles.toLocaleString()} / ${have.size.toLocaleString()}`);
  line('Players scanned / with games[]', `${playersScanned.toLocaleString()} / ${playersWithGames.toLocaleString()}`);
  line('Total game references', totalRefs.toLocaleString());
  line('  malformed gid entries (skipped)', badGids.toLocaleString());
  console.log('────────────────────────────────────────────────────────────');
  line('UNIQUE MISSING GIDS (the rescue target set)', uniqueMissing.toLocaleString());
  line('  referenced 2+ times (high-confidence games)', multiRef.toLocaleString());
  line('  referenced once (verify before trusting)', buckets['1'].toLocaleString());
  line('Missing-gid references (total)', missingRefTotal.toLocaleString());
  line('Spectator calls for the rescue (1/gid)', uniqueMissing.toLocaleString());
  line('Projected wall @ 15/s', `${(uniqueMissing / 15 / 3600).toFixed(1)} h  (${(uniqueMissing / 15 / 60).toFixed(0)} min)`);
  console.log('  Refs-per-missing-gid histogram:');
  for (const [k, v] of Object.entries(buckets)) line(`    ${k} refs`, v.toLocaleString());
  console.log('────────────────────────────────────────────────────────────');
  line('Players holding >=1 missing gid', playersWithMissing.toLocaleString());
  line('  of those, with a ZERO-TEAM season reg', `${playersWithMissingAndZT.toLocaleString()} (${playersWithMissing ? Math.round(100 * playersWithMissingAndZT / playersWithMissing) : 0}%)`);
  console.log('    (high % = the missing games live in the 1,002 zero-team/grading comps,');
  console.log('     confirming the grading-rounds hypothesis; low % = another source exists)');
  console.log('────────────────────────────────────────────────────────────');
  console.log('  SAMPLES — 10 most-referenced missing gids (refs ≈ players in that game):');
  for (const [gid, n] of topGids) console.log(`    ${gid}  ${n} refs`);
  console.log('  SAMPLES — 10 players with the most missing gids:');
  for (const s of samplePlayers) {
    console.log(`    ${s.uuid}  ${String(s.missing).padStart(4)}/${String(s.total).padStart(4)} missing  zeroTeamReg=${s.zeroTeamReg}  ${s.name || ''}`);
  }
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  fs.writeFileSync(REPORT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: {
      seasonFiles, gidsOnFile: have.size, playersScanned, playersWithGames, totalRefs, badGids,
      uniqueMissing, multiRef, singleRef: buckets['1'], missingRefTotal,
      playersWithMissing, playersWithMissingAndZT,
    },
    buckets,
    topGids: topGids.map(([gid, refs]) => ({ gid, refs })),
    samplePlayers,
    // The rescue pass consumes this directly: every missing gid with its ref count.
    missingGids: Object.fromEntries(missingRefs),
  }, null, 2));
  console.log(`  Report written: ${REPORT} (includes the full gid list for the rescue)`);
}

main();
