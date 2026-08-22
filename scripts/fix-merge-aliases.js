// scripts/fix-merge-aliases.js
//
// WRITES when --apply. Takes the data-write lock. Dry-run by default.
//
// WHAT THIS IS FOR. merge-phantom-profiles wrote alias entries on 2026-08-22 to
// point 2,482 phantom players' ids at their real profile, and it did NOT record
// which entries it created. probe-my-aliases could therefore only guess at the
// population — it saw 4,342 candidates against the 3,024 the merge reported, and
// measured a 13.6% foreign rate against a 4.2% repo baseline without being able to
// say which entries that rate belonged to.
//
// This removes the guessing. THE ALIAS TABLE BEFORE THE MERGE IS IN GIT HISTORY,
// so the exact set of added entries is recoverable by diff. No estimation, no
// self-mapping confusion, no attribution argument.
//
// HOW IT FINDS THE BASELINE. It walks git log for the merge commit by its own
// message and takes its FIRST PARENT — the tree as it stood immediately before.
// If several merge commits exist (it was run more than once), the EARLIEST is used
// so the baseline predates all of them.
//
// WHAT IT TESTS. For each added entry, every appearance it delivers is checked
// against the keeper's own registrations, and each is one of:
//   IN-ROSTER    the keeper is registered to a side of that game — correct
//   UNMEASURABLE we hold no registration for that season — says nothing either way
//                (a season with `regs: []` is NOT a registration; build-player-games
//                back-fills those for every season a player has games in)
//   FOREIGN      we hold their registrations for that season and neither team
//                matched — the population that might be wrong
//
// AN ENTRY IS REMOVED only when EVERY appearance it delivers is FOREIGN and it
// delivers at least --min-foreign of them. A mixed entry is left alone: an alias
// delivering real appearances plus some fill-ins is doing its job, and fill-ins are
// real games that PlayHQ itself marks "Fill-in".
//
// REMOVAL IS REVERSIBLE. The removed entries are written to
// reports/removed-merge-aliases.json before anything is deleted, so the exact map
// can be restored by hand. Nothing in players/ or games/ is touched — only
// players/aliases — and build-player-games re-derives every player file from the
// alias table on its next run.
//
// Usage:
//   node scripts/fix-merge-aliases.js                       # dry run
//   node scripts/fix-merge-aliases.js --apply
//   node scripts/fix-merge-aliases.js --apply --min-foreign=5

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const numArg = (f, d) => {
  const a = args.find(x => x.startsWith('--' + f + '='));
  const v = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : d;
};
// An entry delivering ONE foreign appearance and nothing else is far more likely a
// fill-in than a bad mapping. Require a few before removing.
const MIN_FOREIGN = numArg('min-foreign', 3);
const MERGE_MSG = 'merge-phantom-profiles';

const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';

// execSync is SYNCHRONOUS and blocks the event loop; every call needs a timeout
// or a stalled git hangs the job with no output (T35).
const GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const git = (cmd) => execSync(cmd, GIT).toString();

function main() {
  // ── 1. Find the commit immediately before the merge ────────────────────────
  let baseline = null;
  try {
    // The format string goes through a SHELL, so `|` would be read as a pipe —
    // `git log --format=%H|%s` ran %s as a command. Use a separator with no shell
    // meaning, and quote the whole argument.
    const log = git(`git log --format='%H %s' --grep="${MERGE_MSG}" -n 50`).trim();
    const lines = log ? log.split('\n').filter(Boolean) : [];
    if (!lines.length) {
      console.error('ABORT: no commit found whose message contains "' + MERGE_MSG + '".');
      console.error('  Nothing to diff against, so the added entries cannot be identified.');
      process.exit(1);
    }
    // git log is newest-first; the LAST line is the earliest merge commit.
    const earliest = lines[lines.length - 1].split(' ')[0];
    baseline = git(`git rev-parse ${earliest}^`).trim();
    console.log('  merge commits found      : ' + lines.length);
    console.log('  earliest merge commit    : ' + earliest.slice(0, 12) + '  ' + lines[lines.length - 1].slice(41));
    console.log('  baseline (its parent)    : ' + baseline.slice(0, 12));
  } catch (e) {
    console.error('ABORT: could not resolve the baseline commit — ' + e.message);
    process.exit(1);
  }

  // ── 2. The alias table as it was, and as it is ─────────────────────────────
  const before = new Map();
  let beforeShards = 0;
  try {
    const listed = git(`git ls-tree -r --name-only ${baseline} players/aliases`).trim();
    for (const f of (listed ? listed.split('\n') : [])) {
      if (!f.endsWith('.json')) continue;
      beforeShards++;
      let m; try { m = JSON.parse(git(`git show ${baseline}:${f}`)); } catch (e) { continue; }
      for (const [k, v] of Object.entries(m)) before.set(k, v);
    }
  } catch (e) {
    console.error('ABORT: could not read players/aliases at the baseline — ' + e.message);
    process.exit(1);
  }

  const aliasDir = path.join(ROOT, 'players', 'aliases');
  const now = new Map();
  const shardOf = new Map();
  for (const f of fs.readdirSync(aliasDir)) {
    if (!f.endsWith('.json')) continue;
    let m; try { m = JSON.parse(fs.readFileSync(path.join(aliasDir, f), 'utf8')); } catch (e) { continue; }
    for (const [k, v] of Object.entries(m)) { now.set(k, v); shardOf.set(k, f); }
  }

  // ADDED = present now, absent then. CHANGED = present in both, different target.
  const added = new Map(), changed = new Map();
  for (const [k, v] of now) {
    if (!before.has(k)) added.set(k, v);
    else if (before.get(k) !== v) changed.set(k, { from: before.get(k), to: v });
  }
  console.log('  alias entries BEFORE     : ' + n(before.size) + '  (' + beforeShards + ' shards)');
  console.log('  alias entries NOW        : ' + n(now.size));
  console.log('  ADDED since the baseline : ' + n(added.size) + '   ← exactly what the merge wrote');
  console.log('  RETARGETED since         : ' + n(changed.size) + (changed.size ? '   ⚠ an existing entry was pointed elsewhere' : ''));
  console.log('  mode                     : ' + (APPLY ? 'APPLY — removes entries and commits' : 'DRY RUN — nothing written'));
  console.log('');
  if (!added.size && !changed.size) { console.log('  nothing was added; nothing to check'); return; }

  // ── 3. Registrations for every target of an added entry ────────────────────
  const targets = new Set([...added.values(), ...[...changed.values()].map(x => x.to)]);
  const regOf = new Map();
  for (const t of targets) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'players', t.slice(0, 2), t + '.json'), 'utf8'));
      const tids = new Set(), sids = new Set();
      for (const se of (p.seasons || [])) {
        const regs = Array.isArray(se?.regs) ? se.regs : [];
        for (const r of regs) if (r?.tid) tids.add(r.tid);
        // A season with regs:[] is NOT a registration — build-player-games
        // back-fills one for every season a player has games in, so treating it as
        // measurable makes every such appearance look foreign.
        if (se?.sid && regs.some(r => r && r.tid)) sids.add(se.sid);
      }
      regOf.set(t, { tids, sids, name: p.name || '?' });
    } catch (e) { /* target file missing — reported below */ }
  }

  // ── 4. Walk games once and judge every appearance each added entry delivers ─
  const check = new Map();
  for (const k of added.keys()) check.set(k, { target: added.get(k), inRoster: 0, foreign: 0, unmeasurable: 0, samples: [] });
  for (const [k, v] of changed) check.set(k, { target: v.to, retargeted: v.from, inRoster: 0, foreign: 0, unmeasurable: 0, samples: [] });

  const gamesDir = path.join(ROOT, 'games', 'bv');
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = path.basename(f, '.json');
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const [gid, g] of Object.entries(sg.games || {})) {
      for (const e of (Array.isArray(g.p) ? g.p : [])) {
        const id = e && e.id;
        if (!id) continue;
        const c = check.get(id);
        if (!c) continue;
        const reg = regOf.get(c.target);
        if (!reg) { c.unmeasurable++; continue; }
        if ((g.h && reg.tids.has(g.h)) || (g.a && reg.tids.has(g.a))) c.inRoster++;
        else if (!reg.sids.has(sid)) c.unmeasurable++;
        else { c.foreign++; if (c.samples.length < 3) c.samples.push({ gid, sid }); }
      }
    }
  }

  // ── 5. Decide ──────────────────────────────────────────────────────────────
  let allIn = 0, mixed = 0, allForeign = 0, silent = 0, noTarget = 0;
  let apIn = 0, apForeign = 0, apUnmeasurable = 0;
  const remove = [];
  for (const [id, c] of check) {
    apIn += c.inRoster; apForeign += c.foreign; apUnmeasurable += c.unmeasurable;
    if (!regOf.has(c.target)) { noTarget++; continue; }
    const seen = c.inRoster + c.foreign + c.unmeasurable;
    if (!seen) { silent++; continue; }
    if (c.foreign === 0) { allIn++; continue; }
    if (c.inRoster === 0 && c.unmeasurable === 0 && c.foreign >= MIN_FOREIGN) { allForeign++; remove.push({ id, ...c }); }
    else mixed++;
  }

  console.log('  ══ EVERY ENTRY THE MERGE ADDED, JUDGED ════════════════════════════');
  console.log('    delivers nothing at all                 : ' + n(silent) + '   ← harmless');
  console.log('    every appearance is one they belong in  : ' + n(allIn) + '   ← correct');
  console.log('    mixed: some belong, some do not         : ' + n(mixed) + '   ← LEFT ALONE (fill-ins are real)');
  console.log('    EVERY appearance foreign, >=' + MIN_FOREIGN + ' of them  : ' + n(allForeign) + '   ← REMOVE');
  if (noTarget) console.log('    target player file missing              : ' + n(noTarget));
  console.log('');
  console.log('    appearances delivered : ' + n(apIn + apForeign + apUnmeasurable));
  console.log('      belongs             : ' + n(apIn) + '  (' + pct(apIn, apIn + apForeign + apUnmeasurable) + '%)');
  console.log('      foreign             : ' + n(apForeign) + '  (' + pct(apForeign, apIn + apForeign + apUnmeasurable) + '%)   repo baseline is 4.2%');
  console.log('      unmeasurable        : ' + n(apUnmeasurable));
  console.log('    appearances recovered by removing the entries above: ' +
              n(remove.reduce((a, b) => a + b.foreign, 0)));
  console.log('');
  for (const r of remove.slice(0, 30)) {
    const t = regOf.get(r.target);
    console.log('    REMOVE ' + r.id + ' -> ' + r.target + '  ' + JSON.stringify(t ? t.name : '?') +
                '   ' + r.foreign + ' appearance(s), none of them theirs');
    for (const x of r.samples) console.log('        game ' + x.gid + ' season ' + x.sid);
  }
  if (remove.length > 30) console.log('    … and ' + (remove.length - 30) + ' more');
  console.log('');

  if (!APPLY) { console.log('  DRY RUN — nothing written. Re-run with --apply.'); return; }
  if (!remove.length) { console.log('  Nothing to remove.'); return; }

  // ── 6. Record BEFORE deleting, so every removal is reversible ──────────────
  const outPath = path.join(ROOT, 'reports', 'removed-merge-aliases.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    removed: new Date().toISOString(),
    baseline,
    minForeign: MIN_FOREIGN,
    entries: remove.map(r => ({ id: r.id, target: r.target, foreign: r.foreign, samples: r.samples })),
  }, null, 1));
  console.log('  recorded ' + n(remove.length) + ' removals in reports/removed-merge-aliases.json (restore by hand from this)');

  const byShard = new Map();
  for (const r of remove) {
    const sh = shardOf.get(r.id);
    if (!sh) continue;
    if (!byShard.has(sh)) byShard.set(sh, []);
    byShard.get(sh).push(r.id);
  }
  for (const [sh, ids] of byShard) {
    const p = path.join(aliasDir, sh);
    let m; try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
    for (const id of ids) delete m[id];
    const sorted = {};
    for (const k of Object.keys(m).sort()) sorted[k] = m[k];
    fs.writeFileSync(p, JSON.stringify(sorted));
  }
  console.log('  removed from ' + n(byShard.size) + ' alias shard(s)');

  // Per-path staging; never `git add -A` on a 6 GB repo.
  for (const p of ['players/aliases', 'reports/removed-merge-aliases.json']) {
    try { execSync(`git add -- ${p}`, GIT); } catch (e) { /* absent is fine */ }
  }
  const staged = git('git diff --staged --shortstat').trim();
  if (!staged) { console.log('  nothing staged'); return; }
  console.log('  staging: ' + staged);
  execSync(`git commit -q -m "fix-merge-aliases: removed ${remove.length} alias entries delivering only foreign appearances"`, GIT);
  for (let attempt = 1; attempt <= 40; attempt++) {
    try { execSync('git merge --abort', GIT); } catch (e) {}
    try {
      process.stdout.write('  … fetch/merge/push (attempt ' + attempt + ')\n');
      execSync('git fetch origin main', GIT);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT);
      execSync('git push origin main', GIT);
      console.log('  ✔ pushed');
      break;
    } catch (e) {
      if (attempt === 40) throw new Error('push failed after 40 attempts');
      const wait = 1 + Math.floor(Math.random() * 60);
      console.log('  … push attempt ' + attempt + ' failed, retrying in ' + wait + 's');
      try { execSync('sleep ' + wait, { stdio: 'pipe', timeout: (wait + 30) * 1000 }); } catch (e2) {}
    }
  }
  console.log('');
  console.log('  NEXT: run build-player-games. The alias table is corrected but every player');
  console.log('  file still reflects the old resolution until it is rebuilt.');
}

main();
