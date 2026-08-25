// scripts/probe-verdict-conflict.js
//
// READ-ONLY, offline, ZERO API calls. Writes one report. No lock.
//
// TWO AUDITS DISAGREE AND THIS ESTABLISHES WHICH IS SOUND.
//
//   probe-both-resolve         said 185 pairs are TWO PEOPLE, because BOTH uuids
//                              appear in the same team sheet.
//   probe-shared-name-aliases  wants to repoint 23 aliases, and several of them —
//                              Jax Reid, Cooper Bailey, Sam Pickering, Marcus
//                              Welsh, Ella McMahon, Riley Sullivan — are pairs
//                              that FIRST audit called two people.
//
// THE WEAKNESS IN THE ROSTER TEST. "Both ids in p[]" counts an id that reached the
// roster THROUGH AN ALIAS. If a wrong alias put a uuid into those team sheets,
// the roster test was reading our own error back as evidence of a second person.
// It cannot see the difference; this can.
//
// For each pair it splits every shared game by HOW each side is present:
//   OWN     the player's own uuid, or its 13-char truncation, is literally in p[]
//   ALIAS   only some other id is, which players/aliases maps to them
//
// Then:
//   BOTH SIDES OWN in some game     → SOUND. Two distinct ids were captured
//                                     independently. The two-people verdict does
//                                     not depend on any alias.
//   ONE SIDE ONLY EVER VIA ALIAS    → CIRCULAR. That side is in the roster solely
//                                     because an alias put it there. If the alias
//                                     is wrong the verdict is wrong, and this is
//                                     exactly the population the repoints touch.
//
// It also flags which conflicted pairs are in reports/shared-name-alias-audit.json
// as repoint candidates, so the overlap is explicit rather than inferred.
//
// Usage: node scripts/probe-verdict-conflict.js [--show=60]

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.env.SCAN_ROOT || path.join(__dirname, '..');
const SHOW = Number((process.argv.slice(2).find(a => a.startsWith('--show=')) || '').split('=')[1]) || 60;
const TRUNC_LEN = 13;
const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';

function main() {
  // ── 1. The pairs probe-both-resolve called two people ─────────────────────
  let pairs;
  try { pairs = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'both-resolve-pairs.json'), 'utf8')).pairs || []; }
  catch (e) { console.error('ABORT: reports/both-resolve-pairs.json not readable — ' + e.message); process.exit(1); }
  const twoPeople = pairs.filter(p => p && p.leaning && p.leaning.includes('SAME team sheet'));
  console.log('  pairs in the report              : ' + n(pairs.length));
  console.log('  called TWO PEOPLE by the roster  : ' + n(twoPeople.length));

  // ── 2. The alias table ────────────────────────────────────────────────────
  const aliasTo = new Map();
  try {
    const d = path.join(ROOT, 'players', 'aliases');
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      const m = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      for (const [k, v] of Object.entries(m)) aliasTo.set(k, v);
    }
  } catch (e) { console.log('  ⚠ players/aliases unreadable: ' + e.message); }
  console.log('  alias entries                    : ' + n(aliasTo.size));

  // Which ids reach each uuid, split by route.
  const routes = new Map();          // uuid -> { own:Set, alias:Set }
  const need = new Set();
  for (const p of twoPeople) { need.add(p.a); need.add(p.b); }
  for (const u of need) routes.set(u, { own: new Set([u, u.slice(0, TRUNC_LEN)]), alias: new Set() });
  for (const [k, v] of aliasTo) {
    const r = routes.get(v);
    // An id that IS the uuid's own truncation is not an alias route, whatever the
    // table says — that entry is redundant, not a second capture.
    if (r && k !== v.slice(0, TRUNC_LEN) && k !== v) r.alias.add(k);
  }
  // A player file's spectatorIds are its OWN ids, captured directly.
  for (const u of need) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'players', u.slice(0, 2), u + '.json'), 'utf8'));
      for (const x of (p.spectatorIds || [])) if (x) routes.get(u).own.add(String(x));
    } catch (e) {}
  }

  // ── 3. Walk the games and classify each shared appearance ─────────────────
  const key = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  const tally = new Map();
  for (const p of twoPeople) tally.set(key(p.a, p.b), { aOwn: 0, aAlias: 0, bOwn: 0, bAlias: 0, bothOwn: 0, games: 0 });

  const gamesDir = path.join(ROOT, 'games', 'bv');
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const g of Object.values(sg.games || {})) {
      const ids = (Array.isArray(g.p) ? g.p : []).map(x => x && x.id).filter(Boolean);
      if (ids.length < 2) continue;
      const set = new Set(ids);
      for (const p of twoPeople) {
        const ra = routes.get(p.a), rb = routes.get(p.b);
        const aOwn = [...ra.own].some(x => set.has(x));
        const bOwn = [...rb.own].some(x => set.has(x));
        const aAlias = !aOwn && [...ra.alias].some(x => set.has(x));
        const bAlias = !bOwn && [...rb.alias].some(x => set.has(x));
        if (!(aOwn || aAlias) || !(bOwn || bAlias)) continue;   // not a shared game
        const t = tally.get(key(p.a, p.b));
        t.games++;
        if (aOwn) t.aOwn++; else t.aAlias++;
        if (bOwn) t.bOwn++; else t.bAlias++;
        if (aOwn && bOwn) t.bothOwn++;
      }
    }
  }

  // ── 4. Which of these are also repoint candidates? ────────────────────────
  const repointTargets = new Set();
  try {
    const sn = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'shared-name-alias-audit.json'), 'utf8'));
    for (const e of (sn.entries || [])) {
      if (e && e.verdict === 'repoint') { repointTargets.add(e.target); repointTargets.add(e.correctTarget); }
    }
  } catch (e) {}

  let sound = 0, circular = 0, noShared = 0;
  const rows = [];
  for (const p of twoPeople) {
    const t = tally.get(key(p.a, p.b));
    if (!t || !t.games) { noShared++; continue; }
    const aEverOwn = t.aOwn > 0, bEverOwn = t.bOwn > 0;
    const verdict = (aEverOwn && bEverOwn) ? 'sound' : 'circular';
    if (verdict === 'sound') sound++; else circular++;
    rows.push({ ...p, ...t, verdict,
      touchedByRepoint: repointTargets.has(p.a) || repointTargets.has(p.b) });
  }

  console.log('');
  console.log('  ══ DOES THE TWO-PEOPLE VERDICT DEPEND ON AN ALIAS? ════════════════');
  console.log('    SOUND — both sides appear under their OWN id : ' + n(sound) + '  (' + pct(sound, sound + circular) + '%)');
  console.log('      → two ids were captured independently. The verdict stands whatever');
  console.log('        the alias table says.');
  console.log('    CIRCULAR — one side is present ONLY via an alias : ' + n(circular) + '  (' + pct(circular, sound + circular) + '%)');
  console.log('      → that side is in the team sheet BECAUSE AN ALIAS PUT IT THERE. If the');
  console.log('        alias is wrong, so is the two-people verdict. This is our own output');
  console.log('        being read back as evidence.');
  if (noShared) console.log('    no shared games found now                        : ' + n(noShared));
  const overlap = rows.filter(r => r.touchedByRepoint).length;
  console.log('');
  console.log('    of ALL the above, pairs a pending repoint touches: ' + n(overlap));
  console.log('      circular AND touched by a repoint              : ' + n(rows.filter(r => r.verdict === 'circular' && r.touchedByRepoint).length) + '   ← the repoint is very likely right and the verdict wrong');
  console.log('      sound AND touched by a repoint                 : ' + n(rows.filter(r => r.verdict === 'sound' && r.touchedByRepoint).length) + '   ← BOTH may be right: two real people, alias on the wrong one');
  console.log('');

  rows.sort((x, y) => (x.verdict === y.verdict ? y.games - x.games : (x.verdict === 'circular' ? -1 : 1)));
  for (const r of rows.slice(0, SHOW)) {
    console.log('    [' + r.verdict.toUpperCase() + ']' + (r.touchedByRepoint ? ' [REPOINT PENDING]' : '') + '  ' + JSON.stringify(r.name) + '  ' + r.games + ' shared game(s)');
    console.log('        ' + r.a + '   own ' + r.aOwn + ' · via alias ' + r.aAlias);
    console.log('        ' + r.b + '   own ' + r.bOwn + ' · via alias ' + r.bAlias);
    console.log('        both under their own id in ' + r.bothOwn + ' game(s)');
  }
  if (rows.length > SHOW) console.log('    … and ' + n(rows.length - SHOW) + ' more in the report');

  try {
    const out = path.join(ROOT, 'reports', 'verdict-conflict-audit.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), sound, circular, noShared,
      entries: rows }, null, 1));
    console.log('');
    console.log('  WRITTEN: reports/verdict-conflict-audit.json');
  } catch (e) { console.log('  ⚠ could not write report: ' + e.message); }
}

main();
