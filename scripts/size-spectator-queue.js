// scripts/size-spectator-queue.js
// READ-ONLY. Counts the games we ALREADY HOLD that carry a score but no player list.
//
// Why this exists: size-appearance-gaps measured 775,703 missing appearances and
// estimated ~64k missing games by dividing by ~12 attendees. That estimate conflates
// two populations that need completely different work:
//   (a) games we do NOT hold        — hidden/grading rounds, undiscoverable
//   (b) games we DO hold with no p[] — the re-sweep added 23,264 fixture-only games
//                                      (scores, no players), plus any the nightly's
//                                      spectator phase has not reached
// (b) is not an estimate — it is a direct count, and it is the exact spectator work
// queue. The top appearance-gap season being EDJBA Winter 2026 (current, has a game
// file, not zero-team) is the tell that (b) dominates.
//
// The spc flag splits (b) again, and this is the decision-making split:
//   spc absent, no p[]  -> NEVER spectator-processed. Fetchable. THE QUEUE.
//   spc set,    no p[]  -> processed and returned nothing. Genuinely unavailable;
//                          re-fetching these burns budget for zero return.
//
// No API calls, no writes. Samples beside every counter (T15).

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT = '/tmp/size-spectator-queue-report.json';

function main() {
  const t0 = Date.now();
  const gamesDir = path.join(ROOT, 'games', 'bv');
  const seasons = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sports-index.json'), 'utf8')).seasons || {};
  let zeroTeamSids = new Set();
  const ztPath = path.join(ROOT, 'zero-team-seasons.json');
  if (fs.existsSync(ztPath)) zeroTeamSids = new Set(JSON.parse(fs.readFileSync(ztPath, 'utf8')).map((z) => z.id));

  let total = 0, scored = 0, forfeits = 0, withP = 0;
  let queueable = 0, processedEmpty = 0, unscored = 0;
  const perSeason = new Map();
  const sample = [];

  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = f.replace('.json', '');
    let sg;
    try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch { continue; }
    let q = 0, pe = 0, s = 0;
    for (const [gid, g] of Object.entries(sg.games || {})) {
      if (!g) continue;
      total++;
      if (g.forfeit === true) { forfeits++; continue; }          // no game played, nothing to fetch
      const hasScore = g.hs !== undefined && g.hs !== null && g.as !== undefined && g.as !== null;
      if (!hasScore) { unscored++; continue; }                    // future/unplayed
      scored++; s++;
      const hasPlayers = (g.p && g.p.length > 0) || (g.hp && g.hp.length > 0) || (g.ap && g.ap.length > 0);
      if (hasPlayers) { withP++; continue; }
      if (g.spc) { processedEmpty++; pe++; }                      // asked already, nothing there
      else {
        queueable++; q++;
        if (sample.length < 12) sample.push({ gid, sid, d: g.d || null, rn: g.rn || null, hs: g.hs, as: g.as });
      }
    }
    if (q > 0 || pe > 0) {
      perSeason.set(sid, {
        sid, queueable: q, processedEmpty: pe, scored: s,
        name: (seasons[sid] && seasons[sid].name) || '', org: (seasons[sid] && seasons[sid].orgName) || '',
        locked: !!(seasons[sid] && seasons[sid].locked), zeroTeam: zeroTeamSids.has(sid),
      });
    }
  }

  const rows = [...perSeason.values()].sort((a, b) => b.queueable - a.queueable);
  const qLocked = rows.filter((r) => r.locked).reduce((n, r) => n + r.queueable, 0);
  const qActive = rows.filter((r) => !r.locked).reduce((n, r) => n + r.queueable, 0);
  const qZT     = rows.filter((r) => r.zeroTeam).reduce((n, r) => n + r.queueable, 0);

  const line = (l, v) => console.log(`  ${l.padEnd(52, '.')} ${v}`);
  console.log('════════════════════════════════════════════════════════════');
  console.log('  size-spectator-queue — games held WITHOUT player lists');
  console.log('════════════════════════════════════════════════════════════');
  line('Games on file', total.toLocaleString());
  line('  forfeits (nothing to fetch)', forfeits.toLocaleString());
  line('  unscored / future', unscored.toLocaleString());
  line('  scored', scored.toLocaleString());
  line('    with a player list already', withP.toLocaleString());
  console.log('────────────────────────────────────────────────────────────');
  line('QUEUEABLE (scored, no players, spc unset)', queueable.toLocaleString());
  line('  in ACTIVE seasons', qActive.toLocaleString());
  line('  in LOCKED seasons', qLocked.toLocaleString());
  line('  in zero-team seasons', qZT.toLocaleString());
  line('Spectator calls / wall @15/s', `${queueable.toLocaleString()} / ${(queueable/15/3600).toFixed(1)} h`);
  console.log('────────────────────────────────────────────────────────────');
  line('Processed but EMPTY (spc set, no players)', processedEmpty.toLocaleString());
  console.log('    (already asked; re-fetching returns nothing — exclude from the queue)');
  console.log('────────────────────────────────────────────────────────────');
  console.log('  SAMPLES — 12 queueable games:');
  for (const s of sample) console.log(`    ${s.gid}  ${s.sid}  ${s.d || '?'}  ${s.hs}-${s.as}  ${s.rn || ''}`);
  console.log('  SAMPLES — 10 seasons by queueable games:');
  for (const r of rows.slice(0, 10)) {
    console.log(`    ${r.sid}  q=${String(r.queueable).padStart(6)}  empty=${String(r.processedEmpty).padStart(6)}  of ${String(r.scored).padStart(6)} scored  locked=${r.locked} zt=${r.zeroTeam}  ${r.name} — ${r.org}`);
  }
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  fs.writeFileSync(REPORT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: { total, forfeits, unscored, scored, withP, queueable, processedEmpty, qActive, qLocked, qZT },
    seasons: rows, sample,
  }, null, 2));
  console.log(`  Report written: ${REPORT}`);
}

main();
