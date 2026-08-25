// scripts/probe-selfalias-check.js
//
// READ-ONLY, offline, ZERO API calls. Prints a report. Writes nothing.
//
// WHAT probe-unresolved-aliases ACTUALLY FOUND, once its output was read properly.
// In ALL 40 of the aliases nothing had settled, the box-score profileID is simply
// THE ALIAS ID EXPANDED TO ITS FULL 36 CHARACTERS:
//
//     alias id      20b7995f-d708
//     PlayHQ says   20b7995f-d708-429c-97d8-c6f3b3601fb3   ← the SAME id
//     alias sends it to  66e58ba9-b69a-461e-8c90-04d4f062d9c0   ← someone else
//
// These are NOT spectator ids needing an alias. They are real PlayHQ profile ids in
// their own right, and the alias is redirecting them to a different player. That is
// a different fault from the Jida McCrae-Cooper case, where 900f4fe6-bec3 genuinely
// was not a profile.
//
// So the correction is to DELETE the alias, not repoint it: with no entry the id
// resolves to itself, which is right.
//
// THE ONE THING THAT DECIDES WHETHER THAT IS SAFE, and the reason this runs before
// anything is written: does a player file exist for the full uuid? If yes, deleting
// the alias sends those appearances to the correct player immediately. If NO file
// exists, the id resolves to nothing and the appearances are ORPHANED until a
// profile fetch creates one — so those must be fetched first, not deleted first.
//
// Usage: node scripts/probe-selfalias-check.js

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.env.SCAN_ROOT || path.join(__dirname, '..');
const TRUNC_LEN = 13;
const n = (x) => Number(x || 0).toLocaleString();

function main() {
  let audit;
  try { audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'unresolved-alias-audit.json'), 'utf8')); }
  catch (e) { console.error('ABORT: reports/unresolved-alias-audit.json not readable — ' + e.message); process.exit(1); }

  const rows = [];
  for (const e of (audit.entries || [])) {
    const pids = [...new Set((e.box || []).map(b => b && b.profileID).filter(Boolean))];
    if (!pids.length) { rows.push({ ...e, kind: 'no box score', pid: null }); continue; }
    if (pids.length > 1) { rows.push({ ...e, kind: 'MULTIPLE ids in the box', pid: pids.join(' ') }); continue; }
    const pid = pids[0];
    // Is the box-score id the alias id expanded, or a genuinely different person?
    const selfExpansion = pid.startsWith(e.id) || e.id.startsWith(pid.slice(0, TRUNC_LEN));
    const fileExists = fs.existsSync(path.join(ROOT, 'players', pid.slice(0, 2), pid + '.json'));
    let held = null, gp = null, nm = null;
    if (fileExists) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'players', pid.slice(0, 2), pid + '.json'), 'utf8'));
        held = (p.games || []).length; gp = p.sports?.Basketball?.gp ?? null; nm = p.name || null;
      } catch (err) {}
    }
    rows.push({ ...e, kind: selfExpansion ? 'self-expansion' : 'different person', pid, fileExists, held, gp, nm });
  }

  const self = rows.filter(r => r.kind === 'self-expansion');
  const withFile = self.filter(r => r.fileExists);
  const without = self.filter(r => !r.fileExists);

  console.log('  entries examined                        : ' + n(rows.length));
  console.log('    box-score id is the alias id EXPANDED : ' + n(self.length) + '   ← delete the alias, do not repoint');
  console.log('    box-score id is a DIFFERENT person    : ' + n(rows.filter(r => r.kind === 'different person').length));
  console.log('    no box score / multiple ids           : ' + n(rows.filter(r => r.kind.startsWith('no box') || r.kind.startsWith('MULT')).length));
  console.log('');
  console.log('  ══ IS IT SAFE TO DELETE THE ALIAS? ════════════════════════════════');
  console.log('    player file EXISTS for the full uuid  : ' + n(withFile.length) + '   ← SAFE. Deleting sends the appearances to the right player.');
  console.log('    NO player file for the full uuid      : ' + n(without.length) + '   ← NOT SAFE YET. Deleting orphans them; fetch the profile FIRST.');
  console.log('');

  if (withFile.length) {
    console.log('  ── SAFE TO DELETE ────────────────────────────────────────────────');
    for (const r of withFile) {
      console.log('    ' + r.id + '  ' + JSON.stringify(r.name));
      console.log('        alias currently sends it to : ' + r.target);
      console.log('        the id IS                   : ' + r.pid);
      console.log('        that player file holds ' + n(r.held) + ' game(s), PlayHQ gp ' + (r.gp ?? '—') + ', name ' + JSON.stringify(r.nm));
    }
    console.log('');
  }
  if (without.length) {
    console.log('  ── NEEDS A PROFILE FETCH FIRST ───────────────────────────────────');
    console.log('  Run fetch-profile-stats for the shard of each uuid below, THEN delete.');
    for (const r of without) {
      console.log('    ' + r.id + '  ' + JSON.stringify(r.name) + '   uuid ' + r.pid + '   (shard ' + r.pid.slice(0, 2) + ')');
    }
    console.log('');
  }
  const shards = [...new Set(without.map(r => r.pid.slice(0, 2)))].sort();
  if (shards.length) console.log('  shards to fetch: ' + shards.join(' '));
}

main();
