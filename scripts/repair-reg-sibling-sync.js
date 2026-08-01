// scripts/repair-reg-sibling-sync.js
//
// ONE-OFF REPAIR — make regs that share a (season, team) hold identical stats.
//
// ── Why they should be identical ─────────────────────────────────────────────
// A regraded team produces two or more regs in one season, one per grade
// (decision A, 2026-08-01). Their STATS are not per-grade: the PlayHQ profile
// reports per-TEAM season totals and repeats them on every grade registration.
// Both writers already behave that way and key on (sid, tid), never on gid:
//   fetch-profile-stats.js L985-996  for (const reg of season.regs) ...
//                                    regKey = `${sid}:${reg.tid}`
//   build-win-loss.js      L271/313  for (const reg of season.regs) ...
//                                    playerRecords[season.sid][reg.tid]
// Both loop EVERY sibling and write the same value to each. Measured across
// ~913,000 regrade groups, 744,117 are already byte-identical — the writers do
// their job.
//
// ── So why do any differ? STALENESS, not a keying bug ────────────────────────
// A sibling only diverges when a group has not been rewritten since the values
// changed. Measured 2026-08-01:
//   168,765 groups differ ONLY in `foulOuts`  (nightly / build-finals-stats)
//       465 groups differ in a CORE box-score field:
//             ~300  fg/fouls/ft/gp/pts/threePt   (matrix, heals on re-fetch)
//             ~108  wins/losses/draws            (build-win-loss)
// The wins/losses ones persist because the nightly runs build-win-loss with
// --active-only, and 97%+ of the affected groups sit in LOCKED seasons that the
// active-only scope never revisits. Frozen, not wrong.
//
// ── Merge rule: per-key MAX across the group ─────────────────────────────────
// Season totals only ever grow — a stale copy is a mid-season snapshot, the fresh
// one is the final total, so the larger value is the more complete one. Max is
// therefore the correct choice AND is idempotent: re-running changes nothing.
//
// This is NOT the ambiguous case that `repair-duplicate-regs.js` refuses. There,
// two regs shared the SAME (tid, gid) — one registration recorded twice — so a
// foulOuts split of 2 vs 1 could legitimately mean 3. Here the siblings are
// DIFFERENT grades of one team registration whose totals are defined to be the
// same number, so a difference can only be staleness and max is not a guess.
//
// ── Guards ───────────────────────────────────────────────────────────────────
//  - no reg is added or removed; group sizes are asserted unchanged
//  - only `stats` is touched; every other reg field is left exactly as it was
//  - no stat value may DECREASE for any reg — the run aborts if one would
//
// Usage:
//   node scripts/repair-reg-sibling-sync.js --dry-run    # report only (workflow default)
//   node scripts/repair-reg-sibling-sync.js              # sync + batched commits
//   node scripts/repair-reg-sibling-sync.js --shard=0a   # one shard (rehearsal)
//   node scripts/repair-reg-sibling-sync.js --core-only  # only groups differing in a CORE field
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
const DRY       = !!ARGS['dry-run'];
const SHARD     = ARGS.shard || null;
const CORE_ONLY = !!ARGS['core-only'];
const NO_GIT    = process.env.REPAIR_NO_GIT === '1';
const COMMIT_EVERY = parseInt(ARGS['commit-every'], 10) || 3000;

// Fields the profile matrix and build-win-loss own. A difference in any of these
// is a real leaderboard-visible discrepancy; a difference in only `foulOuts` etc.
// is cosmetic, since the season leaderboard shows one row per (player, team).
const CORE = new Set(['gp', 'pts', 'fg', 'ft', 'threePt', 'fouls', 'wins', 'losses', 'draws']);

function log(m) { console.log(`[sibling-sync] ${m}`); }

// Zero-valued keys are stripped on write, so {} and {pts:0} are the same record.
function live(stats) {
  const m = new Map();
  for (const [k, v] of Object.entries(stats || {})) {
    if (v !== 0 && v !== null && v !== undefined) m.set(k, v);
  }
  return m;
}

// ─── git (house pattern; batch staging, per-path only to isolate) ─────────────
function git(a) { return execFileSync('git', a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
function gitCommitPush(paths, message) {
  if (NO_GIT || DRY) return;
  let addFailures = 0;
  const listFile = path.join(ROOT, '.repair-sibling-sync-paths.tmp');
  try {
    fs.writeFileSync(listFile, paths.join('\n') + '\n');
    git(['add', '--pathspec-from-file', listFile]);
  } catch (e) {
    console.error(`  batch add failed (${((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0]}) — falling back to per-path to isolate`);
    for (const p of paths) {
      try { git(['add', '--', p]); }
      catch (e2) { addFailures++; console.error(`  git add failed for "${p}"`); }
    }
  } finally { try { fs.unlinkSync(listFile); } catch {} }

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
      if (!/non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(d)) {
        console.error(`  push failed — NOT contention:\n${d}`); throw e;
      }
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
  log(`repair-reg-sibling-sync${DRY ? ' (DRY RUN — nothing will be written)' : ''}${CORE_ONLY ? ' [core-only]' : ''}`);
  if (SHARD) log(`scope: shard ${SHARD}`);

  let shards = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  if (SHARD) shards = shards.filter(d => d === SHARD);
  if (!shards.length) { log('no shards in scope'); return; }

  const written = [];
  let players = 0, playersChanged = 0, groupsSeen = 0, groupsSynced = 0, regsUpdated = 0;
  let coreGroups = 0, cosmeticGroups = 0;
  const keyHisto = new Map();
  const samples = [];

  for (const shard of shards) {
    const dir = path.join(PLAYERS_DIR, shard);
    for (const fname of fs.readdirSync(dir)) {
      if (!fname.endsWith('.json')) continue;
      const fpath = path.join(dir, fname);
      let p;
      try { p = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
      catch (e) { throw new Error(`Refusing to proceed: ${fname} exists but failed to parse (${e.message}).`); }
      players++;
      const uuid = fname.replace('.json', '');
      let changed = false;

      for (const season of (p.seasons || [])) {
        const regs = season.regs || [];
        if (regs.length < 2) continue;
        const countBefore = regs.length;

        const byTid = new Map();
        for (const r of regs) {
          if (!r || !r.tid) continue;
          if (!byTid.has(r.tid)) byTid.set(r.tid, []);
          byTid.get(r.tid).push(r);
        }

        for (const [tid, group] of byTid) {
          if (group.length < 2) continue;
          groupsSeen++;

          const maps = group.map(r => live(r.stats));
          const keys = new Set(maps.flatMap(m => [...m.keys()]));
          const diffKeys = [];
          for (const k of keys) {
            const vals = maps.map(m => m.get(k));
            const present = vals.filter(v => v !== undefined);
            if (present.length !== vals.length || new Set(present).size > 1) diffKeys.push(k);
          }
          if (!diffKeys.length) continue;

          const isCore = diffKeys.some(k => CORE.has(k));
          if (isCore) coreGroups++; else cosmeticGroups++;
          if (CORE_ONLY && !isCore) continue;

          // Per-key max. Season totals only grow, so the larger value is the more
          // complete one and this is idempotent.
          const merged = {};
          for (const k of keys) {
            const vals = maps.map(m => m.get(k)).filter(v => v !== undefined);
            merged[k] = vals.reduce((a, b) => (typeof a === 'number' && typeof b === 'number') ? Math.max(a, b) : (a ?? b));
          }

          for (const r of group) {
            const before = live(r.stats);
            // Guard: nothing may DECREASE. If it would, the max rule does not hold
            // for this data and the run stops rather than quietly losing a value.
            for (const [k, v] of before) {
              if (typeof v === 'number' && typeof merged[k] === 'number' && merged[k] < v) {
                throw new Error(`ABORT: ${uuid} sid=${season.sid} tid=${tid} key=${k} would DECREASE ${v} -> ${merged[k]}. Nothing further written.`);
              }
            }
            let regChanged = false;
            for (const [k, v] of Object.entries(merged)) {
              if (r.stats?.[k] !== v) regChanged = true;
            }
            if (regChanged) {
              r.stats = { ...merged };
              regsUpdated++;
              changed = true;
            }
          }

          groupsSynced++;
          const sig = diffKeys.sort().join('+');
          keyHisto.set(sig, (keyHisto.get(sig) || 0) + 1);
          if (isCore && samples.length < 20) {
            samples.push(`${uuid} sid=${season.sid} tid=${tid} keys=[${diffKeys.join(', ')}] -> ${JSON.stringify(merged)}`);
          }
        }

        if (countBefore !== (season.regs || []).length) {
          throw new Error(`ABORT: ${uuid} sid=${season.sid} reg count changed ${countBefore} -> ${season.regs.length}. Nothing further written.`);
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

    if (!DRY && written.length >= COMMIT_EVERY) {
      gitCommitPush(written.slice(), `repair-reg-sibling-sync: partial — ${written.length} players (through shard ${shard})`);
      written.length = 0;
    }
  }

  const L = [];
  L.push('');
  L.push(`players scanned            : ${players}`);
  L.push(`players changed            : ${playersChanged}`);
  L.push(`sibling groups seen (>=2)  : ${groupsSeen}`);
  L.push(`groups synced              : ${groupsSynced}`);
  L.push(`regs updated               : ${regsUpdated}`);
  L.push('');
  L.push(`  groups differing in a CORE field   : ${coreGroups}   (gp pts fg ft threePt fouls wins losses draws)`);
  L.push(`  groups differing only cosmetically : ${cosmeticGroups}   (foulOuts, finals, gfApps, gfWins)`);
  if (CORE_ONLY) L.push('  --core-only: cosmetic groups were counted but NOT written.');
  L.push('');
  L.push('WHICH KEYS DIFFERED (before the sync):');
  for (const [k, n] of [...keyHisto.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    L.push(`  ${String(n).padStart(8)}  ${k}`);
  }
  if (samples.length) {
    L.push('');
    L.push('CORE samples:');
    for (const s of samples) L.push(`  ${s}`);
  }
  const out = L.join('\n');
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + out + '\n```\n'); } catch {}
  }

  if (DRY) { log('DRY RUN — nothing written.'); return; }
  if (!written.length) { log('no residual files to commit.'); return; }
  gitCommitPush(written, `repair-reg-sibling-sync: synced ${groupsSynced} sibling groups, ${regsUpdated} regs across ${playersChanged} players`);
  log('complete.');
}

main();
