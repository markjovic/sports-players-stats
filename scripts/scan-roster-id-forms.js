// scripts/scan-roster-id-forms.js
//
// READ-ONLY, offline, zero API calls. No writes, no git, no lock.
//
// THE QUESTION, asked of every roster in the repo rather than one player.
//
// p[] ids are stored in TWO LENGTHS: the 13-char truncation `e9dee630-ab52` and
// the full 36-char uuid `e9dee630-ab52-4056-b1fb-c68bd6bd8b3b`. That is not a
// theory — on 2026-08-23 a single Bailey Walton roster was printed containing both
// forms, and five diagnostics that compared ids literally reported him absent from
// rosters he was plainly in, inventing a "split identity" that never existed.
//
// So: HOW WIDESPREAD IS THE MIXTURE, and does it double-count anybody?
//
//   1. FORMS. How many p[] entries are 13-char, how many 36-char, how many neither.
//      A repo storing one form consistently has no exposure at all.
//   2. SAME PERSON TWICE IN ONE ROSTER. A 13-char id that is a prefix of a 36-char
//      id in the SAME p[] is one human listed twice. That inflates team stats and
//      any count taken from p[] directly.
//   3. WHAT build-player-games DOES WITH IT. It resolves both forms to the same
//      uuid and collects into a Set, so games[] cannot double-count — but anything
//      counting p[] ENTRIES rather than resolved players can and does.
//
// Every number here is a count of stored data. Nothing is inferred.
//
// Usage: node scripts/scan-roster-id-forms.js [--show=30]

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.env.SCAN_ROOT || path.join(__dirname, '..');
const SHOW = Number((process.argv.slice(2).find(a => a.startsWith('--show=')) || '').split('=')[1]) || 30;
const TRUNC = 13;
const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(2) : '0.00';

function main() {
  const gamesDir = path.join(ROOT, 'games', 'bv');
  let games = 0, entries = 0, len13 = 0, len36 = 0, lenOther = 0;
  let gamesWithBothForms = 0, gamesWithDupPerson = 0, dupEntries = 0;
  const otherLens = new Map();
  const dupSamples = [];
  const bySeasonDup = new Map();

  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = path.basename(f, '.json');
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const [gid, g] of Object.entries(sg.games || {})) {
      const ids = (Array.isArray(g.p) ? g.p : []).map(x => x && x.id).filter(Boolean);
      if (!ids.length) continue;
      games++;
      let has13 = false, has36 = false;
      const short = [], long = [];
      for (const id of ids) {
        entries++;
        const L = String(id).length;
        if (L === TRUNC) { len13++; has13 = true; short.push(id); }
        else if (L === 36) { len36++; has36 = true; long.push(id); }
        else { lenOther++; otherLens.set(L, (otherLens.get(L) || 0) + 1); }
      }
      if (has13 && has36) gamesWithBothForms++;
      // THE ONE THAT MATTERS: the same human listed twice in one roster.
      const dupes = [];
      for (const s of short) for (const l of long) if (l.startsWith(s)) dupes.push([s, l]);
      if (dupes.length) {
        gamesWithDupPerson++;
        dupEntries += dupes.length;
        bySeasonDup.set(sid, (bySeasonDup.get(sid) || 0) + dupes.length);
        if (dupSamples.length < SHOW) dupSamples.push({ gid, sid, roster: ids.length, dupes });
      }
    }
  }

  console.log('  games holding a roster : ' + n(games));
  console.log('  p[] entries            : ' + n(entries));
  console.log('');
  console.log('  ══ 1. WHAT FORM ARE THE IDS STORED IN? ════════════════════════════');
  console.log('    13-char truncation : ' + n(len13) + '  (' + pct(len13, entries) + '%)');
  console.log('    full 36-char uuid  : ' + n(len36) + '  (' + pct(len36, entries) + '%)');
  console.log('    neither            : ' + n(lenOther) + '  (' + pct(lenOther, entries) + '%)');
  if (otherLens.size) {
    for (const [L, c] of [...otherLens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log('        length ' + L + ': ' + n(c));
    }
  }
  console.log('    games holding BOTH forms: ' + n(gamesWithBothForms) + '  (' + pct(gamesWithBothForms, games) + '% of games)');
  console.log('');
  console.log('  ══ 2. IS ANYBODY LISTED TWICE IN ONE ROSTER? ══════════════════════');
  console.log('    games where a 13-char id is a PREFIX of a 36-char id in the SAME p[]:');
  console.log('      games            : ' + n(gamesWithDupPerson) + '  (' + pct(gamesWithDupPerson, games) + '% of games)');
  console.log('      duplicate entries: ' + n(dupEntries));
  console.log('');
  if (dupEntries) {
    console.log('    ⚠ THAT IS ONE HUMAN LISTED TWICE. It inflates any count taken from p[]');
    console.log('      ENTRIES — team stats, roster sizes, per-game player counts.');
    console.log('      It does NOT inflate games[]: build-player-games resolves both forms to');
    console.log('      the same uuid and collects into a Set, so the player gets ONE entry.');
    console.log('');
    console.log('    WORST SEASONS:');
    for (const [sid, c] of [...bySeasonDup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log('      ' + sid + '  ' + n(c) + ' duplicate entrie(s)');
    }
    console.log('');
    console.log('    SAMPLES:');
    for (const s of dupSamples) {
      console.log('      game ' + s.gid + ' season ' + s.sid + ' roster ' + s.roster);
      for (const [a, b] of s.dupes) console.log('        ' + a + '  AND  ' + b + '   <- same person, two entries');
    }
  } else {
    console.log('    NONE. No roster in the repo lists the same person under both forms, so');
    console.log('    the mixture of id lengths does not double-count anybody.');
  }
  console.log('');
  console.log('  ══ WHAT THIS DOES AND DOES NOT GUARANTEE ══════════════════════════');
  console.log('    IT DOES establish, by counting every stored roster entry, whether the two');
  console.log('    id forms coexist and whether any human appears twice in one roster.');
  console.log('    IT DOES NOT tell you whether two DIFFERENT ids belong to one person —');
  console.log('    that is the aliasing question and only PlayHQ can answer it.');
}

main();
