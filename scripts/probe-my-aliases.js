// scripts/probe-my-aliases.js
//
// READ-ONLY, offline, zero API calls. No writes, no git, no lock.
//
// THE QUESTION. merge-phantom-profiles wrote 3,024 alias entries on 2026-08-22,
// each pointing a phantom's ids at the real PlayHQ profile. size-report then found
// 165,626 appearances arriving via an alias into a roster the player was not in,
// across 9,751 distinct alias ids.
//
// Those two facts are not connected by anything. This connects them: it reads the
// pairs merge-phantom-profiles acted on, works out exactly which alias entries it
// wrote, and checks each one against the rosters.
//
// FOR EACH ALIAS I WROTE, three outcomes:
//   CORRECT      the id appears in rosters and every game it delivers is one the
//                keeper's registrations cover, or the keeper is genuinely in it.
//   NO EFFECT    the id appears in no roster at all — the alias changed nothing.
//   SUSPECT      the id delivers appearances into games the keeper has no
//                registration for. Not proof of error (fill-ins are real), but it
//                is the population to inspect, and every one is listed.
//
// A wrong alias is REVERSIBLE: delete the entry from players/aliases and re-run
// build-player-games. Nothing here writes; it tells you which entries to remove.
//
// Usage: node scripts/probe-my-aliases.js [--show=40]

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.env.SCAN_ROOT || path.join(__dirname, '..');
const args = process.argv.slice(2);
const SHOW = Number((args.find(a => a.startsWith('--show=')) || '').split('=')[1]) || 40;
const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';

function main() {
  // 1. Which aliases did merge-phantom-profiles write? The report it acted on
  //    names every keep/drop pair; the ids it aliased are the phantom's own
  //    13-char prefix plus its spectatorIds. The phantom FILE is gone, so the
  //    prefix is recoverable but its spectatorIds are not — those are recovered
  //    from the alias table itself by looking for entries pointing at the keeper.
  const reportPath = path.join(ROOT, 'reports', 'duplicate-profile-pairs.json');
  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
  catch (e) { console.error('ABORT: reports/duplicate-profile-pairs.json not readable — ' + e.message); process.exit(1); }
  const acted = (report.actionable || []).filter(x => x && x.keep && x.drop);
  console.log('  pairs merge-phantom-profiles acted on : ' + n(acted.length));

  const keepOf = new Map();          // dropUuid -> keepUuid
  const keepers = new Set();
  for (const x of acted) { keepOf.set(x.drop, x.keep); keepers.add(x.keep); }

  // 2. Load the alias table and pick out entries that point at one of those
  //    keepers. Those are the ones this tool is responsible for.
  const aliasDir = path.join(ROOT, 'players', 'aliases');
  const mine = new Map();            // aliasId -> keeper
  let totalAliases = 0;
  for (const f of fs.readdirSync(aliasDir)) {
    if (!f.endsWith('.json')) continue;
    let m; try { m = JSON.parse(fs.readFileSync(path.join(aliasDir, f), 'utf8')); } catch (e) { continue; }
    for (const [k, v] of Object.entries(m)) {
      totalAliases++;
      if (keepers.has(v)) mine.set(k, v);
    }
  }
  console.log('  alias entries in the table            : ' + n(totalAliases));
  console.log('  entries pointing at one of my keepers : ' + n(mine.size) + '   ← the ones to check');
  console.log('');

  // 3. Every keeper's registered team ids and seasons, so an appearance can be
  //    judged.
  const regOf = new Map();           // keeper -> {tids:Set, sids:Set, name}
  for (const k of keepers) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'players', k.slice(0, 2), k + '.json'), 'utf8'));
      const tids = new Set(), sids = new Set();
      for (const se of (p.seasons || [])) {
        if (se?.sid) sids.add(se.sid);
        for (const r of (se?.regs || [])) if (r?.tid) tids.add(r.tid);
      }
      regOf.set(k, { tids, sids, name: p.name || '?' });
    } catch (e) { /* keeper file missing — reported below */ }
  }

  // 4. Walk games/bv once. For every roster entry matching one of my alias ids,
  //    decide whether the keeper belongs in that game.
  const stat = new Map();            // aliasId -> {seen, ok, foreign, samples:[]}
  const gamesDir = path.join(ROOT, 'games', 'bv');
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = path.basename(f, '.json');
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const [gid, g] of Object.entries(sg.games || {})) {
      const ids = Array.isArray(g.p) ? g.p : [];
      if (!ids.length) continue;
      for (const e of ids) {
        const id = e && e.id;
        if (!id || !mine.has(id)) continue;
        const keeper = mine.get(id);
        const reg = regOf.get(keeper);
        let s = stat.get(id);
        if (!s) { s = { seen: 0, ok: 0, foreign: 0, unmeasurable: 0, keeper, samples: [] }; stat.set(id, s); }
        s.seen++;
        if (!reg) { s.unmeasurable++; continue; }
        const belongs = (g.h && reg.tids.has(g.h)) || (g.a && reg.tids.has(g.a));
        if (belongs) s.ok++;
        else if (!reg.sids.has(sid)) s.unmeasurable++;   // no regs held for that season: says nothing
        else {
          s.foreign++;
          if (s.samples.length < 3) s.samples.push({ gid, sid });
        }
      }
    }
  }

  let correct = 0, noEffect = 0, suspect = 0, unknownKeeper = 0;
  let apOk = 0, apForeign = 0, apUnmeasurable = 0;
  const suspects = [];
  for (const [id, s] of stat) {
    apOk += s.ok; apForeign += s.foreign; apUnmeasurable += s.unmeasurable;
    if (!regOf.has(s.keeper)) { unknownKeeper++; continue; }
    if (s.foreign > 0) { suspect++; suspects.push({ id, ...s }); }
    else correct++;
  }
  noEffect = mine.size - stat.size;

  console.log('  ══ WHAT MY ALIASES ACTUALLY DID ═══════════════════════════════════');
  console.log('    aliases delivering NO appearances at all : ' + n(noEffect) + '   ← changed nothing');
  console.log('    aliases delivering only appearances the keeper is registered for : ' + n(correct) + '   ← correct');
  console.log('    aliases delivering at least one FOREIGN appearance : ' + n(suspect) + '   ← inspect these');
  if (unknownKeeper) console.log('    keeper file missing, cannot judge      : ' + n(unknownKeeper));
  console.log('');
  console.log('    appearances delivered by my aliases     : ' + n(apOk + apForeign + apUnmeasurable));
  console.log('      keeper IS registered to a side       : ' + n(apOk) + '  (' + pct(apOk, apOk + apForeign + apUnmeasurable) + '%)');
  console.log('      FOREIGN (regs held, neither matched)  : ' + n(apForeign) + '  (' + pct(apForeign, apOk + apForeign + apUnmeasurable) + '%)');
  console.log('      unmeasurable (no regs for that season): ' + n(apUnmeasurable));
  console.log('');
  console.log('  ⚠ FOREIGN IS NOT THE SAME AS WRONG. A fill-in plays a real game for a team');
  console.log('    they never registered with, and PlayHQ box scores carry a "Fill-in" row for');
  console.log('    exactly that. The repo-wide foreign rate is 4.2%. Compare the figure above');
  console.log('    against it: MUCH HIGHER means these aliases moved appearances to the wrong');
  console.log('    person; SIMILAR means they behave like every other appearance in the data.');
  console.log('');
  if (suspects.length) {
    suspects.sort((a, b) => b.foreign - a.foreign);
    console.log('  ══ WORST ' + Math.min(SHOW, suspects.length) + ' BY FOREIGN APPEARANCES ═══════════════════════════');
    console.log('  To reverse one: delete its entry from players/aliases/<first two chars>.json');
    console.log('  and re-run build-player-games. Nothing else is needed.');
    for (const s of suspects.slice(0, SHOW)) {
      const r = regOf.get(s.keeper);
      console.log('    ' + s.id + ' -> ' + s.keeper + '  ' + JSON.stringify(r ? r.name : '?'));
      console.log('      delivered ' + s.seen + ': registered ' + s.ok + ' · foreign ' + s.foreign + ' · unmeasurable ' + s.unmeasurable);
      for (const x of s.samples) console.log('        game ' + x.gid + ' in season ' + x.sid);
    }
  } else {
    console.log('  No alias I wrote delivered a single foreign appearance.');
  }
}

main();
