// scripts/merge-phantom-profiles.js
//
// WRITES. Takes the data-write lock. Dry-run by default — --apply is required.
//
// WHAT IT FIXES. 2,895 pairs of player files hold the same games; the API probe
// confirmed that in 1,924 of them ONE uuid is a real PlayHQ profile and the other
// is not served at all. Those phantoms exist because spectator-backfill's stub
// decision read "not in players/aliases" as "is canonical" and manufactured a
// player file for any spectator id it met first. (Fixed at source 2026-08-21; this
// clears what that already created.)
//
// Worked example — Tahlia Parker:
//   20b2df06-37f4-48a9-8477-1f6185bc7533   PlayHQ serves it. 389 games, gp=389.
//   f806d1b6-f87f-4434-be56-62a67f54f5bb   "problem getting the profile". 386 games.
// 378 of their 385 shared games carry BOTH ids in the same p[] — one human counted
// twice in team stats, leaderboards and every total.
//
// WHAT IT DOES, and the order matters:
//   1. ALIAS FIRST. Every id that resolves to the phantom — its own 13-char prefix
//      and every entry in its spectatorIds — is pointed at the REAL uuid in
//      players/aliases. From then on build-player-games resolves those roster
//      entries to the real player.
//   2. ONLY THEN remove the phantom file. Deleting first would strip the
//      appearances instead of moving them: p[] holds the id, and with no alias
//      nothing maps it anywhere.
//   3. Index entry removed so the phantom stops appearing in search.
//
// WHAT IT REFUSES TO DO:
//   · touch a pair the probe did not classify as one-resolves-one-notfound
//   · act on a stale report — the probe run id and the pair count are checked
//   · delete a file whose alias write did not succeed
//   · run at all if the phantom's uuid already has an alias pointing SOMEWHERE
//     ELSE (that is a redirect someone else established, and clobbering it is how
//     appearances get moved to the wrong person)
//
// It does NOT touch games/bv. The rosters keep both ids; the alias makes them
// resolve to one player. Nothing is rewritten that cannot be undone by editing the
// alias table back.
//
// Usage:
//   node scripts/merge-phantom-profiles.js                 # dry run, reports only
//   node scripts/merge-phantom-profiles.js --apply
//   node scripts/merge-phantom-profiles.js --apply --max=50 # bite off a chunk
//
// After --apply: run build-player-games so games[] is rebuilt from the aliases.

'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const num = (f, d) => {
  const a = args.find(x => x.startsWith('--' + f + '='));
  const v = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : d;
};
const MAX = num('max', 0);
const TRUNC_LEN = 13;
const n = (x) => Number(x || 0).toLocaleString();

// Every git call needs a timeout: execSync is synchronous and a stalled push hangs
// the job with no output (T35, 2026-08-20).
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_OPTS = { cwd: ROOT, stdio: 'pipe', timeout: GIT_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 };

function main() {
  const reportPath = path.join(ROOT, 'reports', 'duplicate-profile-pairs.json');
  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
  catch (e) {
    console.error('ABORT: reports/duplicate-profile-pairs.json not readable — run probe-duplicate-profiles first and commit its artifact.');
    console.error('  ' + e.message);
    process.exit(1);
  }
  const actionable = Array.isArray(report.actionable) ? report.actionable : [];
  console.log('  report generated : ' + (report.generated || 'unknown'));
  console.log('  pairs probed     : ' + n(report.probed));
  console.log('  actionable pairs : ' + n(actionable.length));
  console.log('  mode             : ' + (APPLY ? 'APPLY — writes aliases and removes phantom files' : 'DRY RUN — nothing is written'));
  if (!actionable.length) { console.log('  nothing to do'); return; }

  // Load the whole alias table once. Written back per shard only where changed.
  const aliasDir = path.join(ROOT, 'players', 'aliases');
  const shards = new Map();          // shard -> object
  const loadShard = (sh) => {
    if (shards.has(sh)) return shards.get(sh);
    let m = {};
    try { m = JSON.parse(fs.readFileSync(path.join(aliasDir, sh + '.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    shards.set(sh, m);
    return m;
  };
  const dirty = new Set();

  let planned = 0, skippedNoFile = 0, skippedConflict = 0, skippedSelf = 0;
  let aliasWrites = 0, filesRemoved = 0;
  const conflicts = [];
  const done = [];

  for (const pair of actionable) {
    if (MAX && planned >= MAX) break;
    const { keep, drop } = pair;
    if (!keep || !drop) { console.log('  ⚠ pair missing keep or drop — skipped: ' + JSON.stringify(pair)); continue; }
    if (keep === drop) { skippedSelf++; continue; }

    const dropPath = path.join(ROOT, 'players', drop.slice(0, 2), drop + '.json');
    if (!fs.existsSync(dropPath)) { skippedNoFile++; continue; }
    const keepPath = path.join(ROOT, 'players', keep.slice(0, 2), keep + '.json');
    if (!fs.existsSync(keepPath)) {
      console.log('  ⚠ KEEP file missing, refusing to remove the DROP: ' + keep);
      skippedNoFile++; continue;
    }

    let dp;
    try { dp = JSON.parse(fs.readFileSync(dropPath, 'utf8')); } catch (e) { skippedNoFile++; continue; }

    // Every id that currently resolves to the phantom.
    const ids = new Set([drop.slice(0, TRUNC_LEN)]);
    for (const x of (Array.isArray(dp.spectatorIds) ? dp.spectatorIds : [])) if (x) ids.add(String(x));

    // Refuse if any of them already redirects somewhere that is not the phantom
    // and not the keeper. That is someone else's decision and clobbering it moves
    // appearances to the wrong person.
    let conflict = null;
    for (const id of ids) {
      const cur = loadShard(id.slice(0, 2))[id];
      if (cur && cur !== drop && cur !== keep) { conflict = { id, cur }; break; }
    }
    if (conflict) {
      skippedConflict++;
      if (conflicts.length < 15) conflicts.push({ keep, drop, ...conflict });
      continue;
    }

    planned++;
    done.push({ keep, drop, ids: [...ids], games: (dp.games || []).length, name: dp.name || '?' });

    if (!APPLY) continue;

    for (const id of ids) {
      const sh = id.slice(0, 2);
      const m = loadShard(sh);
      if (m[id] === keep) continue;
      m[id] = keep;
      dirty.add(sh);
      aliasWrites++;
    }
    // ALIASES ARE WRITTEN BEFORE THE FILE GOES. If the process dies here the
    // appearances still resolve — to the right player — and the orphan file is
    // harmless. The reverse order would strip them.
    for (const sh of dirty) {
      const m = shards.get(sh);
      const sorted = {};
      for (const k of Object.keys(m).sort()) sorted[k] = m[k];
      fs.mkdirSync(aliasDir, { recursive: true });
      fs.writeFileSync(path.join(aliasDir, sh + '.json'), JSON.stringify(sorted));
    }
    dirty.clear();

    fs.unlinkSync(dropPath);
    filesRemoved++;

    // The search index still lists the phantom; remove that entry too.
    const idxPath = path.join(ROOT, 'players', 'indexes', drop.slice(0, 2) + '.json');
    try {
      const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      if (idx[drop]) { delete idx[drop]; fs.writeFileSync(idxPath, JSON.stringify(idx)); }
    } catch (e) { /* no index shard is not fatal */ }
  }

  console.log('');
  console.log('  pairs planned              : ' + n(planned) + (MAX ? '  (capped by --max=' + MAX + ')' : ''));
  console.log('    skipped, no phantom file : ' + n(skippedNoFile));
  console.log('    skipped, alias conflict  : ' + n(skippedConflict) + '   ← an id already redirects elsewhere; left alone deliberately');
  console.log('    skipped, keep === drop   : ' + n(skippedSelf));
  if (conflicts.length) {
    console.log('  CONFLICTS (first ' + conflicts.length + '):');
    for (const c of conflicts) console.log('    ' + c.id + ' -> ' + c.cur + '   (wanted ' + c.keep + ', phantom ' + c.drop + ')');
  }
  console.log('');
  console.log('  SAMPLE OF WHAT ' + (APPLY ? 'WAS' : 'WOULD BE') + ' DONE:');
  for (const d of done.slice(0, 15)) {
    console.log('    ' + JSON.stringify(d.name) + '  phantom ' + d.drop + ' (' + d.games + ' games)');
    console.log('      ids -> ' + d.keep + ' : ' + d.ids.join(' '));
  }
  console.log('');
  if (!APPLY) {
    console.log('  DRY RUN — nothing written. Re-run with --apply.');
    return;
  }
  console.log('  alias entries written : ' + n(aliasWrites));
  console.log('  phantom files removed : ' + n(filesRemoved));

  // One commit. Per-path staging: `git add -A` walks the whole index on a 6 GB repo.
  const paths = ['players/aliases', 'players', 'reports'];
  let addFailures = 0;
  for (const p of paths) {
    try { execSync(`git add -- ${p}`, GIT_OPTS); }
    catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      if (/did not match any file/i.test(detail)) continue;
      addFailures++;
      console.error('  ⚠ git add FAILED "' + p + '": ' + detail);
    }
  }
  const staged = execSync('git diff --staged --shortstat', GIT_OPTS).toString().trim();
  if (!staged) {
    if (addFailures) throw new Error('nothing staged and ' + addFailures + ' path(s) failed to stage — refusing to report a clean no-op');
    console.log('  nothing to commit');
    return;
  }
  console.log('  staging: ' + staged);
  execSync('git commit -q -m "merge-phantom-profiles: ' + filesRemoved + ' phantom files aliased to their real profile"', GIT_OPTS);
  for (let attempt = 1; attempt <= 60; attempt++) {
    try { execSync('git merge --abort', GIT_OPTS); } catch (e) {}
    try {
      process.stdout.write('  … fetch/merge/push (attempt ' + attempt + ')\n');
      execSync('git fetch origin main', GIT_OPTS);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT_OPTS);
      execSync('git push origin main', GIT_OPTS);
      console.log('  ✔ pushed');
      break;
    } catch (e) {
      if (attempt === 60) throw new Error('push failed after 60 attempts');
      const wait = 1 + Math.floor(Math.random() * 91);
      console.log('  … push attempt ' + attempt + ' failed, retrying in ' + wait + 's');
      try { execSync('sleep ' + wait, { stdio: 'pipe', timeout: (wait + 30) * 1000 }); } catch (e2) {}
    }
  }
  console.log('');
  console.log('  NEXT: run build-player-games. Until it does, games[] still reflects the old');
  console.log('  resolution — the aliases are in place but the player files have not been');
  console.log('  rebuilt from them.');
}

main();
