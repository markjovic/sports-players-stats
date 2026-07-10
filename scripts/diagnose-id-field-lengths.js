// scripts/diagnose-id-field-lengths.js -- read-only
//
// Investigates why backfill-missing-players.js's discovery phase found ZERO
// full-length (36-char) uuids in games/bv/*.json, when recover-uuids-from-git-history.js
// was believed to have restored ~81,974 of them. Reports a length histogram
// of every p[].id / hp[].profileID / ap[].profileID value across all of
// games/bv, plus resolvability of the 13-char ones (any that DON'T resolve
// via the current player index -- a "stuck" state neither the old
// diagnose-missing-player-files.js (only ever checked truncated prefixes)
// nor backfill-missing-players.js (only ever checks full-length ids) would
// catch).

'use strict';

const fs   = require('fs');
const path = require('path');
const { resolveToFullUuid, isFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT      = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games', 'bv');

const lenCounts = new Map(); // length -> count
const sampleByLen = new Map(); // length -> [example strings] (max 5)
let totalIds = 0;

let resolvable13 = 0, unresolvable13 = 0;
const unresolvableSamples = []; // {sid, gid, field, value}

const sids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
console.log(`Scanning ${sids.length} season files in games/bv...`);

for (const fname of sids) {
  let gf;
  try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); } catch { continue; }
  const sid = fname.replace('.json', '');
  for (const [gid, g] of Object.entries(gf.games || {})) {
    const entries = [
      ...(g.p  || []).map(e => ({ field: 'p.id', value: e?.id })),
      ...(g.hp || []).map(e => ({ field: 'hp.profileID', value: e?.profileID })),
      ...(g.ap || []).map(e => ({ field: 'ap.profileID', value: e?.profileID })),
    ];
    for (const { field, value } of entries) {
      if (!value || typeof value !== 'string') continue;
      totalIds++;
      const len = value.length;
      lenCounts.set(len, (lenCounts.get(len) || 0) + 1);
      if (!sampleByLen.has(len)) sampleByLen.set(len, []);
      if (sampleByLen.get(len).length < 5) sampleByLen.get(len).push(value);

      if (len === 13) {
        const resolved = resolveToFullUuid(value, ROOT);
        if (resolved) resolvable13++;
        else {
          unresolvable13++;
          if (unresolvableSamples.length < 20) unresolvableSamples.push({ sid, gid, field, value });
        }
      }
    }
  }
}

console.log('\n─── Length histogram (all id/profileID values seen) ───────────────');
for (const [len, count] of [...lenCounts.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  length ${len}: ${count.toLocaleString()}  (e.g. ${sampleByLen.get(len).join(', ')})`);
}

console.log('\n─── 13-char resolvability ──────────────────────────────────────────');
console.log(`  Resolvable via index   : ${resolvable13.toLocaleString()}`);
console.log(`  NOT resolvable (stuck) : ${unresolvable13.toLocaleString()}`);
if (unresolvableSamples.length) {
  console.log('\n  Sample unresolvable entries:');
  for (const s of unresolvableSamples) console.log(`    sid=${s.sid} gid=${s.gid} ${s.field}=${s.value}`);
}

console.log(`\nTotal id/profileID values scanned: ${totalIds.toLocaleString()}`);
