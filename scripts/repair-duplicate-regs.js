// scripts/repair-duplicate-regs.js
//
// ONE-OFF REPAIR — merge regs that duplicate the same (team, grade) registration.
//
// ── The finding (2026-08-01) ─────────────────────────────────────────────────
// Measured by audit-seasons-gaps.js across 412,058 players / 4,151,876 regs:
//   1,330,231 regs share a `tid` with a sibling in the same season, of which
//     1,296,352  distinct real grades  -> REGRADING, correct data, NOT touched here
//         2,188  >=1 sibling has gid null
//        27,666  the SAME (tid, gid) twice  <- what this script merges
//
// ── Why they exist ───────────────────────────────────────────────────────────
// Three writers disagreed about what a reg is keyed on:
//   nightly-crawl.js        L1011  (tid AND gid) -> appends when the grade differs
//   fetch-profile-stats.js  L1039  (tid)         -> skips
//   discover-seasons.js     L962   (tid)         -> MUTATED gid in place
// The mutation was the generator: rewriting one reg's grade could make it collide
// with a sibling the nightly had already appended, producing a pair sharing
// (tid, gid) that neither other writer could create, since both check and skip.
// Fixed at source 2026-08-01 (decision A: a reg IS a (team, grade) registration;
// discover-seasons now matches on both and never overwrites a real grade), so this
// set is STATIC. There is no generator left to race.
//
// ── Merge rule ───────────────────────────────────────────────────────────────
// Per stat key, take the MAX across the copies. The 20 sampled divergent pairs
// differed in exactly one key — `foulOuts`, present on one copy and absent from
// the other — because foulOuts is maintained by nightly/build-finals-stats, which
// update whichever duplicate they find FIRST and leave the twin stale on that field.
// Max is lossless for a key that is merely ABSENT from some copies.
//
// It is NOT lossless if a key is PRESENT on every copy with genuinely different
// values, because then one value is real and max() just picks the bigger. This
// script therefore REFUSES those groups: it leaves them untouched and lists them,
// rather than silently choosing. Run it, read the refusals, decide separately.
//
// Non-stat fields are merged by preferring a populated value over an empty one
// (tn, gn, age, div), so the surviving reg is never less complete than its copies.
//
// NOT MERGED, deliberately:
//   - regrades (same tid, DIFFERENT real grades) — correct data under decision A
//   - null-gid regs — a reg whose grade was never published is not provably the
//     same registration as one with a known grade. discover-seasons now completes
//     those in place; forcing them together here would be a guess.
//
// Usage:
//   node scripts/repair-duplicate-regs.js --dry-run     # report only (workflow default)
//   node scripts/repair-duplicate-regs.js               # merge + single commit
//   node scripts/repair-duplicate-regs.js --shard=0a    # one shard (rehearsal)
// Env: REPAIR_NO_GIT=1 disables git (local testing only).

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const DRY    = !!ARGS['dry-run'];
const SHARD  = ARGS.shard || null;
const NO_GIT = process.env.REPAIR_NO_GIT === '1';
// Flush a commit once this many changed files have accumulated. ~3k keeps each
// staging call fast while bounding what a cancellation can cost.
const COMMIT_EVERY = parseInt(ARGS['commit-every'], 10) || 3000;

function log(m) { console.log(`[dup-regs] ${m}`); }

// Zero-valued stat keys are stripped on write, so {} and {pts:0} are the same
// record. Compare and merge on non-zero entries only.
function liveStats(r) {
  const out = new Map();
  for (const [k, v] of Object.entries(r.stats || {})) {
    if (v !== 0 && v !== null && v !== undefined) out.set(k, v);
  }
  return out;
}

// Returns { merged } or { conflict:[keys] } — never both.
function mergeGroup(group) {
  const maps = group.map(liveStats);
  const keys = new Set(maps.flatMap(m => [...m.keys()]));
  const conflict = [];
  for (const k of keys) {
    const vals = maps.map(m => m.get(k));
    const present = vals.filter(v => v !== undefined);
    // Present on EVERY copy with more than one distinct value = a real conflict.
    if (present.length === vals.length && new Set(present).size > 1) conflict.push(k);
  }
  if (conflict.length) return { conflict: conflict.sort() };

  const merged = { ...group[0] };
  const stats = {};
  for (const k of keys) {
    const vals = maps.map(m => m.get(k)).filter(v => v !== undefined);
    stats[k] = vals.reduce((a, b) => (typeof a === 'number' && typeof b === 'number') ? Math.max(a, b) : (a ?? b));
  }
  merged.stats = stats;
  // Prefer a populated descriptive field over an empty one.
  for (const f of ['tn', 'gn', 'age', 'div']) {
    for (const r of group) {
      if ((merged[f] === undefined || merged[f] === null || merged[f] === '') &&
          r[f] !== undefined && r[f] !== null && r[f] !== '') { merged[f] = r[f]; break; }
    }
  }
  return { merged };
}

// ─── git (house pattern) ──────────────────────────────────────────────────────
function git(a) { return execFileSync('git', a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
function gitCommitPush(paths, message) {
  if (NO_GIT || DRY) return;
  // ── Staging ────────────────────────────────────────────────────────────────
  // NOT per-path. Directive 9 exists so one unmatched pathspec cannot silently
  // discard the rest, and per-path is right at the scales it was written for (the
  // fold stages ~5k paths, the nightly a few hundred). This script stages ~24,500,
  // and git rewrites its ENTIRE index on every invocation — an index covering
  // 527,900 files, roughly 40 MB. 24,534 adds is ~2 TB of index I/O and does not
  // finish: it burned the 120-minute timeout on 2026-08-01 AFTER completing every
  // merge and write, and the run was cancelled with nothing committed.
  //
  // `--pathspec-from-file` is ONE invocation and still fully explicit — never `-A`.
  // It is atomic like any multi-pathspec add, so if it fails we fall back to
  // per-path to ISOLATE the offender and report it, which preserves the rule's
  // intent (a miss skips only itself, loudly) without paying it 24,000 times.
  let addFailures = 0;
  const listFile = path.join(ROOT, '.repair-dup-regs-paths.tmp');
  try {
    fs.writeFileSync(listFile, paths.join('\n') + '\n');
    git(['add', '--pathspec-from-file', listFile]);
  } catch (e) {
    console.error(`  batch add failed (${((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0]}) — falling back to per-path to isolate`);
    for (const p of paths) {
      try { git(['add', '--', p]); }
      catch (e2) {
        addFailures++;
        console.error(`  git add failed for "${p}": ${((e2.stderr && e2.stderr.toString()) || e2.message || '').trim().split('\n')[0]}`);
      }
    }
  } finally {
    try { fs.unlinkSync(listFile); } catch {}
  }
  const staged = (() => { try { return git(['diff', '--cached', '--shortstat']).trim(); } catch { return ''; } })();
  if (!staged) {
    if (addFailures) throw new Error(`nothing staged and ${addFailures} path(s) failed to stage`);
    log('nothing staged, skip commit'); return;
  }
  log(`staging: ${staged}`);
  const IDENT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=github-actions[bot]@users.noreply.github.com'];
  try { git([...IDENT, 'commit', '-q', '-m', message]); }
  catch (e) { throw new Error(`commit failed — ${((e.stderr && e.stderr.toString()) || e.message || '').trim()}`); }
  const MAX = 60;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try { git(['merge', '--abort']); } catch {}
    try { git(['fetch', 'origin', 'main']); }
    catch (e) {
      if (attempt === MAX) throw e;
      const s = 1 + Math.floor(Math.random() * 91);
      log(`fetch failed (${attempt}/${MAX}), retrying in ${s}s`);
      try { execFileSync('sleep', [String(s)]); } catch {}
      continue;
    }
    git([...IDENT, 'merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat']);
    try { git(['push', 'origin', 'HEAD:main']); log(`pushed on attempt ${attempt}`); return; }
    catch (e) {
      const d = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
      const contention = /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(d);
      if (!contention) { console.error(`  push failed — NOT contention:\n${d}`); throw e; }
      if (attempt === MAX) { console.error(`  push rejected after ${MAX}:\n${d}`); throw e; }
      const s = 1 + Math.floor(Math.random() * 91);
      log(`push ${attempt}/${MAX} rejected, re-syncing in ${s}s`);
      try { execFileSync('sleep', [String(s)]); } catch {}
    }
  }
  throw new Error(`exhausted ${MAX} push attempts`);
}

// ─── main ─────────────────────────────────────────────────────────────────────
function main() {
  log(`repair-duplicate-regs${DRY ? ' (DRY RUN — nothing will be written)' : ''}`);
  if (SHARD) log(`scope: shard ${SHARD}`);

  let shards = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  if (SHARD) shards = shards.filter(d => d === SHARD);
  if (!shards.length) { log('no shards in scope'); return; }

  const written = [];
  let players = 0, playersChanged = 0, groupsMerged = 0, regsRemoved = 0;
  let groupsRefused = 0, regsInRefused = 0;
  const refusals = [], samples = [];

  for (const shard of shards) {
    const dir = path.join(PLAYERS_DIR, shard);
    for (const fname of fs.readdirSync(dir)) {
      if (!fname.endsWith('.json')) continue;
      const fpath = path.join(dir, fname);
      let p;
      // A file that exists but will not parse must ABORT, never be skipped and
      // never be rewritten from a fabricated object.
      try { p = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
      catch (e) { throw new Error(`Refusing to proceed: ${fname} exists but failed to parse (${e.message}).`); }
      players++;

      const uuid = fname.replace('.json', '');
      let changed = false;

      for (const season of (p.seasons || [])) {
        const regs = season.regs || [];
        if (regs.length < 2) continue;

        // Group by (tid, gid). Null grades are NOT merged — see the header.
        const byKey = new Map();
        for (const r of regs) {
          if (!r || !r.tid) continue;
          if (r.gid === undefined || r.gid === null) continue;
          const k = `${r.tid}\u0000${r.gid}`;
          if (!byKey.has(k)) byKey.set(k, []);
          byKey.get(k).push(r);
        }
        if (![...byKey.values()].some(g => g.length > 1)) continue;

        const countBefore = regs.length;
        const out = [];
        const done = new Set();
        for (const r of regs) {
          if (!r || !r.tid || r.gid === undefined || r.gid === null) { out.push(r); continue; }
          const k = `${r.tid}\u0000${r.gid}`;
          const group = byKey.get(k);
          if (group.length === 1) { out.push(r); continue; }
          if (done.has(k)) continue;
          done.add(k);

          const res = mergeGroup(group);
          if (res.conflict) {
            groupsRefused++;
            regsInRefused += group.length;
            if (refusals.length < 25) {
              refusals.push(`${uuid} sid=${season.sid} tid=${r.tid} gid=${r.gid} conflicting keys=[${res.conflict.join(', ')}] values=${JSON.stringify(group.map(g => g.stats || {}))}`);
            }
            for (const g of group) out.push(g);   // untouched
            continue;
          }
          out.push(res.merged);
          groupsMerged++;
          regsRemoved += group.length - 1;
          if (samples.length < 15) {
            samples.push(`${uuid} sid=${season.sid} tid=${r.tid} gid=${r.gid} x${group.length} -> 1  stats=${JSON.stringify(res.merged.stats)}`);
          }
          changed = true;
        }

        if (changed) {
          // Guard: the new array must be shorter by exactly the number removed for
          // THIS season, and must never be longer.
          if (out.length > countBefore) {
            throw new Error(`ABORT: ${uuid} sid=${season.sid} regs grew ${countBefore} -> ${out.length}. Nothing further written.`);
          }
          season.regs = out;
        }
      }

      if (changed) {
        playersChanged++;
        if (!DRY) {
          fs.writeFileSync(fpath, JSON.stringify(p));   // minified — house rule
          written.push(path.join('players', shard, fname));
        }
      }
    }
    log(`  shard ${shard} done (${playersChanged} players changed so far)`);

    // Commit periodically. The 2026-08-01 run completed every merge and write and
    // then died in staging at the 120-minute timeout, losing ALL of it — the exact
    // "in-memory progress is lost on cancel" failure the house rule warns about.
    // Committing per batch of shards means a cancellation costs at most one batch,
    // and the script is idempotent so a re-run simply finishes the job.
    if (!DRY && written.length >= COMMIT_EVERY) {
      gitCommitPush(written.slice(), `repair-duplicate-regs: partial — ${written.length} players (through shard ${shard})`);
      written.length = 0;
    }
  }

  const L = [];
  L.push('');
  L.push(`players scanned        : ${players}`);
  L.push(`players changed        : ${playersChanged}`);
  L.push(`duplicate groups merged: ${groupsMerged}`);
  L.push(`regs removed           : ${regsRemoved}`);
  L.push('');
  L.push(`groups REFUSED (a shared key held different values on every copy): ${groupsRefused}`);
  L.push(`  regs left untouched in those groups: ${regsInRefused}`);
  L.push('  These are NOT merged. max() would pick a winner and discard a real value,');
  L.push('  so they are left exactly as they were for a separate decision.');
  for (const r of refusals) L.push(`      ${r}`);
  if (samples.length) {
    L.push('');
    L.push('merged samples:');
    for (const s of samples) L.push(`      ${s}`);
  }
  const out = L.join('\n');
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + out + '\n```\n'); } catch {}
  }

  if (DRY) { log('DRY RUN — nothing written.'); return; }
  if (!written.length) { log('no residual files to commit (periodic commits already pushed everything).'); return; }
  gitCommitPush(written, `repair-duplicate-regs: merged ${groupsMerged} duplicate (tid,gid) groups, removed ${regsRemoved} regs across ${playersChanged} players`);
  log('complete.');
}

main();
