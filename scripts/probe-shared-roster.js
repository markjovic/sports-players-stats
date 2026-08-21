// scripts/probe-shared-roster.js
//
// READ-ONLY, offline, zero API calls. No writes, no git, no lock.
//
// THE QUESTION, and it decides whether the duplicate hunt is even looking at the
// right thing. size-duplicate-profiles pairs two player files when they hold the
// SAME game id. For Tahlia Parker that is 385 games across
//   20b2df06-37f4-48a9-8477-1f6185bc7533  (PlayHQ serves this one)
//   f806d1b6-f87f-4434-be56-62a67f54f5bb  (PlayHQ returns "problem getting profile")
//
// But games[] is built by build-player-games FROM THE ROSTER. So a game can only be
// in both files if BOTH ids are in that game's p[]. And two ids in one p[] is what
// TWO PEOPLE look like — twins on the same team — not what one person with two
// profiles looks like. One person's two ids should appear in DIFFERENT games, never
// both in one.
//
// So either:
//   BOTH ids are in p[]  → something WROTE the second id into rosters that already
//                          had the first. The repair campaign appending 388 games
//                          to the emptier file on 2026-08-21 would do exactly that,
//                          which would make the shared games damage rather than
//                          evidence.
//   ONE id is in p[]     → games[] was populated by some path OTHER than the roster,
//                          and the pairing logic is reading a fiction.
//
// Until that is known, widening or narrowing the duplicate search is guesswork.
// This prints what is actually in the roster, per game, and counts the shapes.
//
// Usage:
//   node scripts/probe-shared-roster.js --a=<uuid> --b=<uuid>
//   node scripts/probe-shared-roster.js --a=20b2df06-... --b=f806d1b6-... --show=15

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.env.SCAN_ROOT || path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (f, d) => { const a = args.find(x => x.startsWith('--' + f + '=')); return a ? a.split('=')[1] : d; };
const A = arg('a', '');
const B = arg('b', '');
const SHOW = Number(arg('show', 20)) || 20;
if (!A || !B) { console.error('ABORT: need --a=<uuid> --b=<uuid>'); process.exit(1); }

const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';

function load(uuid) {
  const p = path.join(ROOT, 'players', uuid.slice(0, 2), uuid + '.json');
  if (!fs.existsSync(p)) { console.error('ABORT: no player file for ' + uuid); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function main() {
  const pa = load(A), pb = load(B);
  const ga = new Set(Array.isArray(pa.games) ? pa.games : []);
  const gb = new Set(Array.isArray(pb.games) ? pb.games : []);
  const shared = [...ga].filter(g => gb.has(g));
  console.log('  A ' + A + '  ' + JSON.stringify(pa.name || '?') + '  games=' + n(ga.size) +
              '  spectatorIds=' + ((pa.spectatorIds || []).length));
  console.log('  B ' + B + '  ' + JSON.stringify(pb.name || '?') + '  games=' + n(gb.size) +
              '  spectatorIds=' + ((pb.spectatorIds || []).length));
  console.log('  shared game ids: ' + n(shared.length));
  if (!shared.length) { console.log('  nothing to inspect'); return; }

  // Which prefixes could resolve to each? p[] holds 13-char truncations, and the
  // alias table maps a spectator prefix to a full api id, so BOTH sides need their
  // own prefix AND every alias pointing at them.
  const aliasTo = new Map();       // prefix -> full uuid it resolves to
  try {
    const d = path.join(ROOT, 'players', 'aliases');
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      const sh = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      for (const k of Object.keys(sh)) aliasTo.set(k, sh[k]);
    }
  } catch (e) { console.log('  players/aliases unreadable: ' + e.message); }
  const prefixesFor = (uuid, p) => {
    const s = new Set([uuid.slice(0, 13)]);
    for (const x of (p.spectatorIds || [])) s.add(String(x));
    for (const [k, v] of aliasTo) if (v === uuid) s.add(k);
    return s;
  };
  const pfA = prefixesFor(A, pa), pfB = prefixesFor(B, pb);
  console.log('  ids that resolve to A: ' + [...pfA].join(' '));
  console.log('  ids that resolve to B: ' + [...pfB].join(' '));

  // Walk games/bv once, looking only at the shared ids.
  const want = new Set(shared);
  const gamesDir = path.join(ROOT, 'games', 'bv');
  const found = new Map();     // gid -> {sid, ids:[...]}
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = path.basename(f, '.json');
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const gid of Object.keys(sg.games || {})) {
      if (!want.has(gid)) continue;
      const g = sg.games[gid];
      found.set(gid, { sid, ids: (Array.isArray(g.p) ? g.p : []).map(x => x && x.id).filter(Boolean),
                       spc: !!g.spc, dg: !!g.dg });
    }
  }
  console.log('  shared games located in games/bv: ' + n(found.size) + ' of ' + n(shared.length));

  let both = 0, onlyA = 0, onlyB = 0, neither = 0;
  const samples = { both: [], onlyA: [], onlyB: [], neither: [] };
  for (const [gid, rec] of found) {
    const hasA = rec.ids.some(id => pfA.has(id));
    const hasB = rec.ids.some(id => pfB.has(id));
    const k = hasA && hasB ? 'both' : hasA ? 'onlyA' : hasB ? 'onlyB' : 'neither';
    if (k === 'both') both++; else if (k === 'onlyA') onlyA++; else if (k === 'onlyB') onlyB++; else neither++;
    if (samples[k].length < SHOW) samples[k].push({ gid, rec, hasA, hasB });
  }

  console.log('');
  console.log('  ══ WHAT THE ROSTER ACTUALLY CONTAINS ══════════════════════════════');
  console.log('    BOTH ids in p[]    : ' + n(both) + '  (' + pct(both, found.size) + '%)   ← two entries for one person, OR two people');
  console.log('    only A             : ' + n(onlyA) + '  (' + pct(onlyA, found.size) + '%)   ← B holds this game WITHOUT being in the roster');
  console.log('    only B             : ' + n(onlyB) + '  (' + pct(onlyB, found.size) + '%)   ← A holds this game WITHOUT being in the roster');
  console.log('    NEITHER            : ' + n(neither) + '  (' + pct(neither, found.size) + '%)   ← both hold a game neither is named in');
  console.log('');
  console.log('  HOW TO READ IT:');
  console.log('    BOTH dominating   → the rosters really do carry two ids. If these are one');
  console.log('      person, something WROTE the second — and a repair appending to the emptier');
  console.log('      file does exactly that. If they are two people (twins), the whole pairing');
  console.log('      test is finding siblings, not duplicates.');
  console.log('    only-A or only-B dominating → games[] was NOT built from the roster for one');
  console.log('      of them, and the pairing logic is comparing something that does not mean');
  console.log('      what it says.');
  console.log('');
  for (const [k, label] of [['both', 'BOTH ids present'], ['onlyA', 'only A present'],
                            ['onlyB', 'only B present'], ['neither', 'NEITHER present']]) {
    if (!samples[k].length) continue;
    console.log('  ── ' + label + ' — first ' + samples[k].length + ' ──');
    for (const s of samples[k]) {
      const mine = s.rec.ids.filter(id => pfA.has(id) || pfB.has(id));
      console.log('    ' + s.gid + '  sid=' + s.rec.sid + '  roster=' + s.rec.ids.length +
                  '  [' + (s.rec.spc ? 'spc' : '') + (s.rec.dg ? 'dg' : '') + (!s.rec.spc && !s.rec.dg ? 'NO FLAG' : '') + ']' +
                  '  matching ids: ' + (mine.join(' ') || '(none)'));
    }
    console.log('');
  }
}

main();
