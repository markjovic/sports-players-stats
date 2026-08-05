// scripts/size-appearance-gaps.js
// READ-ONLY sizing v2 for the grading/hidden residue — the NON-CIRCULAR measure.
//
// The first attempt (size-missing-gids) compared player.games[] against games/bv and
// found 0 — correct arithmetic, circular question: build-player-games GENERATES games[]
// from games/bv's own p[] arrays, so the difference is empty by construction.
//
// This scan compares two INDEPENDENT sources, per player per season:
//   PlayHQ's own count  — reg.stats.gp, deduped per tid (T20: same-tid sibling regs
//                         carry identical blocks — MAX per tid, sum across distinct tids)
//   Our local count     — the player's games[] entries attributed to that season via a
//                         gid→sid map built from games/bv
//
// gap = playhqGp − localGp.
//   POSITIVE  = appearances PlayHQ counts that we cannot name: the rescue target. Two
//               known populations feed it — hidden/grading games (never discoverable) and
//               the re-sweep's 23,264 fixture-only games (scores, no p[] yet). Both are
//               recovered by the same per-gid spectator route.
//   NEGATIVE  = we hold MORE games than PlayHQ counts — expected noise: p[] is an
//               attendee list (named-but-DNP players), and forfeit counting differs.
//               Reported separately; never netted against the positive gap.
//
// Every counter prints samples (T15). /tmp report carries the per-season table sorted by
// gap — the rescue priority list — with the zero-team flag for the REAL grading
// correlation. No API calls, no writes.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT = '/tmp/size-appearance-gaps-report.json';

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function main() {
  const t0 = Date.now();

  // ── gid → sid map from every season file ─────────────────────────────────
  console.log('  Building gid→sid map from games/bv…');
  const gamesDir = path.join(ROOT, 'games', 'bv');
  const gidToSid = new Map();
  let seasonFiles = 0;
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    seasonFiles++;
    const sid = f.replace('.json', '');
    const sg = readJson(path.join(gamesDir, f));
    for (const gid of Object.keys(sg.games || {})) gidToSid.set(gid, sid);
  }
  console.log(`  ${seasonFiles.toLocaleString()} season files, ${gidToSid.size.toLocaleString()} gids mapped`);

  // ── season metadata + zero-team set ──────────────────────────────────────
  const seasons = readJson(path.join(ROOT, 'data', 'sports-index.json')).seasons || {};
  let zeroTeamSids = new Set();
  const ztPath = path.join(ROOT, 'zero-team-seasons.json');
  if (fs.existsSync(ztPath)) zeroTeamSids = new Set(readJson(ztPath).map((z) => z.id));
  else console.log('  ⚠ zero-team-seasons.json not found — correlation reads 0');

  // ── per-player comparison ─────────────────────────────────────────────────
  const perSeason = new Map(); // sid -> {playhq, local, posGap, negGap, playersPos}
  const bump = (sid) => {
    if (!perSeason.has(sid)) perSeason.set(sid, { playhq: 0, local: 0, posGap: 0, negGap: 0, playersPos: 0 });
    return perSeason.get(sid);
  };
  let playersScanned = 0, playersWithPosGap = 0, playersWithNegGap = 0;
  let totalPosGap = 0, totalNegGap = 0, unattributedGids = 0;
  const samplePos = [];

  const playersDir = path.join(ROOT, 'players');
  for (const shard of fs.readdirSync(playersDir).sort()) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue;
    const dir = path.join(playersDir, shard);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      playersScanned++;
      if (playersScanned % 50000 === 0) console.log(`  scanned ${playersScanned.toLocaleString()} players…`);
      let p;
      try { p = readJson(path.join(dir, f)); } catch { continue; }

      // local per-sid tallies from games[]
      const localBySid = new Map();
      for (const gid of (Array.isArray(p.games) ? p.games : [])) {
        const sid = gidToSid.get(gid);
        if (!sid) { unattributedGids++; continue; } // impossible per the tautology proof; counted anyway
        localBySid.set(sid, (localBySid.get(sid) || 0) + 1);
      }

      // PlayHQ per-sid gp, deduped per tid (T20)
      let myPos = 0, myNeg = 0;
      for (const season of (p.seasons || [])) {
        const sid = season.sid;
        if (!sid) continue;
        const perTid = new Map(); // tid -> max gp across siblings
        for (const reg of (season.regs || [])) {
          if (!reg.tid) continue;
          const gp = (reg.stats && reg.stats.gp) || 0;
          perTid.set(reg.tid, Math.max(perTid.get(reg.tid) || 0, gp));
        }
        let playhqGp = 0;
        for (const gp of perTid.values()) playhqGp += gp;
        const localGp = localBySid.get(sid) || 0;
        if (playhqGp === 0 && localGp === 0) continue;
        const row = bump(sid);
        row.playhq += playhqGp;
        row.local  += localGp;
        const gap = playhqGp - localGp;
        if (gap > 0) { row.posGap += gap; row.playersPos++; myPos += gap; }
        else if (gap < 0) { row.negGap += -gap; myNeg += -gap; }
      }
      if (myPos > 0) {
        playersWithPosGap++;
        totalPosGap += myPos;
        if (samplePos.length < 10 || myPos > samplePos[samplePos.length - 1].gap) {
          samplePos.push({ uuid: p.uuid || f.replace('.json',''), name: p.name, gap: myPos });
          samplePos.sort((a, b) => b.gap - a.gap);
          if (samplePos.length > 10) samplePos.pop();
        }
      }
      if (myNeg > 0) { playersWithNegGap++; totalNegGap += myNeg; }
    }
  }

  // ── aggregate ─────────────────────────────────────────────────────────────
  const rows = [...perSeason.entries()].map(([sid, r]) => ({
    sid,
    name: (seasons[sid] && (seasons[sid].name || '')) || '',
    org:  (seasons[sid] && (seasons[sid].orgName || '')) || '',
    zeroTeam: zeroTeamSids.has(sid),
    hasGameFile: false, // filled below
    playhq: r.playhq, local: r.local, posGap: r.posGap, negGap: r.negGap, playersPos: r.playersPos,
  }));
  const fileSids = new Set();
  for (const f of fs.readdirSync(gamesDir)) if (f.endsWith('.json')) fileSids.add(f.replace('.json',''));
  for (const r of rows) r.hasGameFile = fileSids.has(r.sid);
  rows.sort((a, b) => b.posGap - a.posGap);

  const posRows = rows.filter((r) => r.posGap > 0);
  const gapInZT = posRows.filter((r) => r.zeroTeam).reduce((n, r) => n + r.posGap, 0);
  const gapNoFile = posRows.filter((r) => !r.hasGameFile).reduce((n, r) => n + r.posGap, 0);
  const AVG_ATTENDEES = 12; // measured: ~28.4M appearances / ~2.34M games
  const estGames = Math.round(totalPosGap / AVG_ATTENDEES);

  const line = (l, v) => console.log(`  ${l.padEnd(54, '.')} ${v}`);
  console.log('════════════════════════════════════════════════════════════');
  console.log('  size-appearance-gaps — PlayHQ gp vs local appearances');
  console.log('════════════════════════════════════════════════════════════');
  line('Players scanned', playersScanned.toLocaleString());
  line('gid→sid map size / unattributed games[] gids', `${gidToSid.size.toLocaleString()} / ${unattributedGids.toLocaleString()}`);
  console.log('────────────────────────────────────────────────────────────');
  line('MISSING APPEARANCES (Σ positive gaps)', totalPosGap.toLocaleString());
  line('  players affected', playersWithPosGap.toLocaleString());
  line('  seasons affected', posRows.length.toLocaleString());
  line('  est. unique missing games (÷12 attendees)', estGames.toLocaleString());
  line('  spectator calls at that estimate / wall @15/s', `${estGames.toLocaleString()} / ${(estGames/15/3600).toFixed(1)} h`);
  console.log('────────────────────────────────────────────────────────────');
  line('Missing appearances inside ZERO-TEAM seasons', `${gapInZT.toLocaleString()} (${totalPosGap ? Math.round(100*gapInZT/totalPosGap) : 0}%)`);
  line('  inside seasons with NO game file at all', gapNoFile.toLocaleString());
  console.log('    (the zero-team % IS the grading-rounds hypothesis, measured directly)');
  console.log('────────────────────────────────────────────────────────────');
  line('Overcount noise (Σ negative gaps, reported not netted)', totalNegGap.toLocaleString());
  line('  players with local > PlayHQ (DNP-attendee noise)', playersWithNegGap.toLocaleString());
  console.log('────────────────────────────────────────────────────────────');
  console.log('  SAMPLES — 10 seasons by missing appearances (rescue priority order):');
  for (const r of rows.slice(0, 10)) {
    console.log(`    ${r.sid}  gap ${String(r.posGap).padStart(6)}  (playhq ${r.playhq} vs local ${r.local})  zt=${r.zeroTeam} file=${r.hasGameFile}  ${r.name} — ${r.org}`);
  }
  console.log('  SAMPLES — 10 players by missing appearances:');
  for (const s of samplePos) console.log(`    ${s.uuid}  gap ${String(s.gap).padStart(4)}  ${s.name || ''}`);
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  fs.writeFileSync(REPORT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: {
      playersScanned, unattributedGids, totalPosGap, playersWithPosGap,
      seasonsWithPosGap: posRows.length, estGames, gapInZeroTeam: gapInZT,
      gapInNoFileSeasons: gapNoFile, totalNegGap, playersWithNegGap,
    },
    seasons: rows, // full table, sorted by posGap — the rescue priority list
    samplePlayers: samplePos,
  }, null, 2));
  console.log(`  Report written: ${REPORT}`);
}

main();
