// scripts/fold-diverged-players.js
//
// THE FOLD — post-migration maintenance for the api-canonical invariant
// (one file per person, keyed by api id, no apiId fields).
//
// After the 3b-2 migration, new divergences still occur: the nightly crawl
// stubs a brand-new player under their observed spectator id; the matrix's
// recovery later discovers the real api id, writes the alias redirect, sets
// player.apiId, and fetches their full stats. That leaves a correct,
// functional, but WRONGLY-KEYED file. This job folds those stragglers into
// place, exactly as rekey-apply did for the original 2,300 — but incremental,
// plan-less, and with NO network (the matrix already fetched their stats via
// player.apiId, so both sides of any merge carry identical career data).
//
// Per diverged file (any players/{2hex}/*.json with an apiId field):
//   target absent  -> PROMOTE: rewrite at players/{apiPrefix}/{apiId}.json
//                     with uuid=apiId, apiId field dropped, spectatorIds
//                     unioned; delete the old file.
//   target exists  -> MERGE: scaffolds/games/teams/gameTids unioned either way;
//                     the STATS BLOCK goes to whichever record actually holds
//                     stats (see statsRank), tie -> the fresher statsChecked,
//                     then the api-keyed record; stats NEVER summed; old file
//                     deleted.
//                     CHANGED 2026-08-31. The keeper used to be whichever record
//                     had more games[] entries. That is a captured-side count
//                     being used to decide ownership of credited-side data, and
//                     in the population it actually meets it is inverted: across
//                     the 528 cases seed-apiid-from-playhq-pairs.js had to refuse,
//                     the spectator-keyed stub held a median of 68 games and the
//                     real api-keyed profile held 1. games[] is assigned by
//                     build-player-games resolving rosters through the alias
//                     index, so before an alias exists the stub collects
//                     everything — the count measures which key the resolver
//                     favoured, not which record is richer. The stub therefore
//                     won, and because only seasons/games/teams/gameTids/name are
//                     unioned, the real profile's stats, records and private flag
//                     were dropped and its statsChecked replaced. Marked checked
//                     and api-keyed, fetch-profile-stats then never re-fetched it
//                     (its skip test is !p?.sports?.Basketball?.statsChecked),
//                     so the loss was silent and permanent while games[] looked
//                     correct.
//   index          -> entry moved old key -> api id, enriched fields carried,
//                     entry-internal uuid re-pointed, histories unioned.
// Aliases DO need work here. 2026-07-30: the comment that used to sit here said
// "aliases need nothing — the redirect was written at discovery". That is true for
// exactly ONE alias per folded player (trunc(oldKey) -> apiId, written by
// fetch-profile-stats.js recordAliasDiscovery) and FALSE for every OTHER alias
// entry whose VALUE is that old key. A player can carry several spectatorIds, each
// with its own alias entry aimed at the same file. This job deletes that file on
// BOTH paths (promote and merge), so those other aliases are left pointing at
// nothing. The 2026-07-30 fold of 2,263 players left 268 such dangling aliases
// (16 -> 284); of the ten sampled, 10/10 were files this script had deleted, split
// 6 promotes / 4 merges — so it was never merge-specific.
// An alias entry is { <13-char spectator id>: <36-char full uuid> } living in the
// shard named by the first two hex chars of its KEY. Repointing rewrites only the
// VALUE, so no entry ever changes shard.
//
// Idempotent: a second run finds zero apiId fields and exits 0. Ends with a
// full re-scan asserting exactly that before committing. Single commit,
// explicit paths, proven push pattern. Safe to run on a schedule.
//
// Usage:
//   node scripts/fold-diverged-players.js            # fold + commit
//   node scripts/fold-diverged-players.js --dry-run  # report only
//   node scripts/fold-diverged-players.js --repoint-only
//       Repair ONLY the alias values orphaned by a PREVIOUS fold. Needed because
//       the fold is idempotent — after it has run there is nothing left to detect,
//       so a corrected script cannot self-heal.
//       It reconstructs the mapping from the PLAYER FILES (buildSpectatorMap:
//       every file's spectatorIds[] plus trunc of its own key), NOT from
//       reports/fold-diverged.json. It therefore READS every player file and
//       WRITES only alias shards.
//       ⚠️ Corrected 2026-07-31: this block previously said repoint-only used the
//       oldKey -> apiId pairs in reports/fold-diverged.json and that no player
//       files were read. Both were untrue from the T6 rewrite onward — see
//       repointOnlyMode() / buildSpectatorMap() below, whose own comments say so.
//       The usage block was simply never updated to match the code 300 lines down:
//       the N-1 stale-doc pattern occurring inside a SINGLE file.
// Env: FOLD_NO_GIT=1 disables git (local testing only).

'use strict';

const fs = require('fs');
const os = require('os');            // 2026-08-08: batched git-add list file
const path = require('path');
const { execFileSync } = require('child_process');
const { TRUNC_LEN, isFullUuid } = require('./lib/uuid-prefix.cjs');
const { isPlaceholderName } = require('./lib/namespace-resolve.cjs');

const ROOT = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const INDEX_DIR = path.join(ROOT, 'players', 'indexes');
const ALIAS_DIR = path.join(ROOT, 'players', 'aliases');
// ⚠️ ADVISORY ONLY — write-only from this script's point of view, deliberately.
// It is a SINGLE path overwritten by every run, so a 1-player fold destroys the
// record of a 2,263-player one. That is not hypothetical: it happened 2026-07-30,
// and the repair that trusted this file then fixed 0 of 284 dangling aliases
// (claude_context.md trap T6). Nothing in this script reads it, and nothing else
// should build a repair, check or audit on it. To learn what a past fold did,
// reconstruct from the data (see repointOnlyMode / buildSpectatorMap) or read the
// commit history. Kept only as a human-readable record of the run that just ran.
const OUT_REPORT = path.join(ROOT, 'reports', 'fold-diverged.json');

const DRY = process.argv.includes('--dry-run');
// --repoint-only: skip the fold entirely and just repair alias values using the
// oldKey -> apiId pairs recorded in reports/fold-diverged.json. Needed because the
// fold is idempotent: once it has run, a corrected script finds zero apiId fields
// and will never revisit the aliases the earlier run orphaned.
const REPOINT_ONLY = process.argv.includes('--repoint-only');
const NO_GIT = process.env.FOLD_NO_GIT === '1';

const HEX = '0123456789abcdef';
const ALL_BUCKETS = [];
for (const a of HEX) for (const b of HEX) ALL_BUCKETS.push(a + b);

function log(msg) { console.log(`[fold] ${new Date().toISOString()} ${msg}`); }
function trunc(id) { return String(id).slice(0, TRUNC_LEN); }
function playerPath(uuid) { return path.join(PLAYERS_DIR, uuid.slice(0, 2), `${uuid}.json`); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function readPlayer(uuid) { return readJson(playerPath(uuid)); }
// Write format verbatim from fetch-profile-stats.js writePlayer(): minified.
function writePlayer(uuid, player) {
  fs.mkdirSync(path.dirname(playerPath(uuid)), { recursive: true });
  fs.writeFileSync(playerPath(uuid), JSON.stringify(player), 'utf8');
}
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
function gamesCount(p) { return Array.isArray(p.games) ? p.games.length : 0; }

// ─── Which record actually holds stats ────────────────────────────────────────
// The merge keeper decides every field unionScaffold does NOT touch: the whole
// sports.Basketball block, records, private, u. None of that is reconstructible
// from games[], so games[] must not be what decides it.
//
// Ranks, lowest to highest:
//   0  private — PlayHQ withholds this profile, there is nothing to keep
//   1  never fetched — no statsChecked, so fetch-profile-stats still owes it a run
//   2  fetched, PlayHQ credits nothing — a real answer, but an empty one
//   3  fetched, real stats
// A record can only lose the stats block to one that ranks at least as high.
function statsRank(p) {
  if (!p) return 1;
  if (p.private === true) return 0;
  const bk = p.sports && p.sports.Basketball;
  if (!bk || !bk.statsChecked) return 1;
  return (Number(bk.gp) > 0) ? 3 : 2;
}

// statsChecked as a sortable number. 0 when absent, so a record that was never
// fetched never wins a recency tie-break.
function checkedAt(p) {
  const t = p && p.sports && p.sports.Basketball && p.sports.Basketball.statsChecked;
  const n = t ? Date.parse(t) : NaN;
  return Number.isFinite(n) ? n : 0;
}

// ─── Scaffold union — copied VERBATIM from rekey-apply.js (proven at 2,300) ───
function unionScaffold(target, source) {
  if (!target.seasons) target.seasons = [];
  for (const s of (source.seasons || [])) {
    let t = target.seasons.find(x => x.sid === s.sid);
    if (!t) {
      target.seasons.push(clone(s));
      continue;
    }
    if (!t.regs) t.regs = [];
    for (const r of (s.regs || [])) {
      const tr = t.regs.find(x => x.tid === r.tid);
      if (!tr) {
        t.regs.push(clone(r));
      } else {
        for (const k of Object.keys(r)) {
          if (tr[k] === undefined) tr[k] = clone(r[k]);
        }
      }
    }
  }
  if (Array.isArray(source.games) && source.games.length) {
    const g = new Set(Array.isArray(target.games) ? target.games : []);
    for (const id of source.games) g.add(id);
    target.games = [...g].sort();
  }
  if (Array.isArray(source.teams) && source.teams.length) {
    if (!Array.isArray(target.teams)) target.teams = [];
    const seen = new Set(target.teams.map(t => JSON.stringify(t)));
    for (const t of source.teams) {
      const k = JSON.stringify(t);
      if (!seen.has(k)) { seen.add(k); target.teams.push(t); }
    }
  }
  if (source.gameTids) {
    if (!target.gameTids) target.gameTids = {};
    for (const [g, t] of Object.entries(source.gameTids)) {
      if (target.gameTids[g] === undefined) target.gameTids[g] = t;
    }
  }
  if (source.name && (!target.name || (isPlaceholderName(target.name) && !isPlaceholderName(source.name)))) {
    target.name = source.name;
  }
}

// ─── Index shard IO (lazy, dirty-tracked) ─────────────────────────────────────
const indexCache = new Map();
const indexDirty = new Set();
function loadIndexShard(shard) {
  if (indexCache.has(shard)) return indexCache.get(shard);
  let m = {};
  try { m = readJson(path.join(INDEX_DIR, `${shard}.json`)); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  indexCache.set(shard, m);
  return m;
}
function flushIndexShards() {
  const written = [];
  for (const shard of indexDirty) {
    const m = indexCache.get(shard);
    const sorted = {};
    for (const k of Object.keys(m).sort()) sorted[k] = m[k];
    fs.writeFileSync(path.join(INDEX_DIR, `${shard}.json`), JSON.stringify(sorted));
    written.push(path.join(INDEX_DIR, `${shard}.json`));
  }
  return written;
}

// Move an index entry oldKey -> apiId, carrying enriched fields (gender etc.),
// re-pointing an entry-internal uuid, and unioning history into any existing
// target entry (merge case) — target's fields win, old fills gaps.
function moveIndexEntry(oldKey, apiId) {
  const oldShard = oldKey.slice(0, 2).toLowerCase();
  const newShard = apiId.slice(0, 2).toLowerCase();
  const oldIdx = loadIndexShard(oldShard);
  const newIdx = loadIndexShard(newShard);
  const oldEntry = oldIdx[oldKey];
  if (oldEntry) {
    const existing = newIdx[apiId];
    if (existing) {
      const merged = { ...oldEntry, ...existing };
      const h = { ...(oldEntry.history || {}) };
      for (const [sid, tids] of Object.entries(existing.history || {})) {
        h[sid] = [...new Set([...(h[sid] || []), ...tids])];
      }
      merged.history = h;
      if ('uuid' in merged) merged.uuid = apiId;
      newIdx[apiId] = merged;
    } else {
      const entry = { ...oldEntry };
      if ('uuid' in entry) entry.uuid = apiId;
      newIdx[apiId] = entry;
    }
    delete oldIdx[oldKey];
    indexDirty.add(oldShard);
    indexDirty.add(newShard);
  }
}

// ─── Alias repoint ────────────────────────────────────────────────────────────
// Follow a chain in case one run's apiId is another entry's oldKey. Capped and
// cycle-guarded; the pre-pass already rejects apiId === key, so chains are short.
function resolveThroughMap(target, map) {
  let cur = target;
  const seen = new Set();
  for (let i = 0; i < 10 && map[cur] !== undefined; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    cur = map[cur];
  }
  return cur;
}

// Rewrite every alias VALUE that points at a file this run deleted.
// Key order is preserved rather than re-sorted: the only intended diff is the
// changed values, and re-sorting would rewrite shards that need no change.
function repointAliases(map) {
  const written = [];
  let entries = 0, repointed = 0, shardsTouched = 0;
  for (const bucket of ALL_BUCKETS) {
    const p = path.join(ALIAS_DIR, `${bucket}.json`);
    let m;
    try { m = readJson(p); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    let dirty = false;
    for (const [k, v] of Object.entries(m)) {
      entries++;
      if (typeof v !== 'string' || map[v] === undefined) continue;
      const nv = resolveThroughMap(v, map);
      if (nv === v) continue;
      m[k] = nv;
      dirty = true;
      repointed++;
    }
    if (dirty) {
      shardsTouched++;
      if (!DRY) { fs.writeFileSync(p, JSON.stringify(m)); written.push(p); }
    }
  }
  log(`aliases: ${entries} entries scanned, ${repointed} repointed across ${shardsTouched} shard(s)`);
  return { written, entries, repointed, shardsTouched };
}

// Post-check input. `map` scopes blame: a dangling target this run created is a
// bug and must block the commit; one that predates the run is reported only.
function scanDanglingAliases(map) {
  let total = 0, dangling = 0, mine = 0;
  const samples = [];
  for (const bucket of ALL_BUCKETS) {
    const p = path.join(ALIAS_DIR, `${bucket}.json`);
    let m;
    try { m = readJson(p); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const [k, v] of Object.entries(m)) {
      if (typeof v !== 'string' || v.length !== 36) continue;
      total++;
      if (fs.existsSync(playerPath(v))) continue;
      dangling++;
      if (map && map[v] !== undefined) mine++;
      if (samples.length < 20) samples.push(`${k} -> ${v}`);
    }
  }
  return { total, dangling, mine, samples };
}

// ─── Git — in-script single commit, proven push pattern ───────────────────────
// maxBuffer: execFileSync's DEFAULT IS 1 MB, and exceeding it SIGTERMs the child
// mid-operation. 2026-08-09: a 5,727-player fold's `git merge` printed 1,051,036
// bytes of per-file "Auto-merging …" lines (11,259 files) — Node killed git
// during the merge, the run crashed, and an already-made commit was never
// pushed. `-q` on the merge below suppresses those lines at the source; this
// buffer is the belt to that braces, since ANY git output here scales with the
// number of changed files.
const GIT_MAXBUF = 512 * 1024 * 1024;
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: GIT_MAXBUF }).toString();
}
function gitCommitPush(paths, message) {
  if (NO_GIT || DRY) return;
  // Per-path add (house rule / directive 9). `git add` is ATOMIC across pathspecs:
  // one unmatched path in a batch stages NOTHING for that entire batch. The old
  // form batched 500 per call, so a single bad path could discard up to 499 good
  // ones — and because git() throws on a non-zero exit, it would have aborted a
  // fold that had already completed every write. Staged individually, a miss skips
  // only itself and is REPORTED rather than swallowed (the empty-catch version of
  // this same hazard silently discarded a 30,426-game discover-fixtures run).
  // Cost: one git invocation per path — a 2,263-player fold stages ~5k paths, a
  // few minutes inside the workflow's 120-minute timeout.
  // ⚠️ 2026-08-08: the per-path loop below was replaced by BATCHED staging with a
  // per-path fallback. A 13,675-player fold stages ~27,600 paths; one `git add`
  // process per path against this repo's ~537k-file (~50 MB) index costs ~250 ms
  // each — the 2026-08-08 run spent 1h54m in this loop and was killed by the
  // 120-minute timeout with every write complete and NOTHING committed (the
  // 'staging:' line never printed). Per-path `git add` has a scale ceiling.
  // The safety property that motivated per-path is preserved exactly: `git add`
  // is ATOMIC across pathspecs, so a batch containing one unmatched path stages
  // NOTHING for that batch — therefore a failing batch is retried PER PATH, which
  // isolates the offender, skips only itself, and reports it. Common case: ~28
  // git invocations instead of ~27,600.
  let addFailures = 0;
  const addFailedSamples = [];
  const noteFailure = (p, e) => {
    addFailures++;
    if (addFailedSamples.length < 10) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      addFailedSamples.push(`${p}: ${detail}`);
    }
  };
  const ADD_BATCH = 1000;
  const listFile = path.join(os.tmpdir(), `fold-add-${process.pid}.txt`);
  for (let i = 0; i < paths.length; i += ADD_BATCH) {
    const batch = paths.slice(i, i + ADD_BATCH);
    try {
      fs.writeFileSync(listFile, batch.join('\n') + '\n');
      git(['add', '--pathspec-from-file', listFile, '--']);
    } catch (_) {
      // Atomic failure: nothing in this batch staged. Isolate per path.
      for (const p of batch) {
        try { git(['add', '--', p]); } catch (e2) { noteFailure(p, e2); }
      }
    }
  }
  try { fs.unlinkSync(listFile); } catch (_) { /* best effort */ }
  if (addFailures) {
    log(`WARNING: ${addFailures} of ${paths.length} path(s) failed to stage`);
    for (const s of addFailedSamples) log(`  ADD FAILED: ${s}`);
  }
  const staged = git(['diff', '--cached', '--shortstat']).trim(); // never --stat
  if (!staged) { log('nothing staged, skip commit'); return; }
  log(`staging: ${staged}`); // directive 9: prove in the log what was actually staged
  const IDENT = ['-c', 'user.name=github-actions[bot]',
                 '-c', 'user.email=github-actions[bot]@users.noreply.github.com'];
  git([...IDENT, 'commit', '-m', message]);
  // Only genuine contention is retried: a rejected push (remote advanced) or a
  // transient fetch. A merge failure — bad identity, a real conflict — is NOT a
  // push race, so it fails fast instead of being masked behind 60 retries (which
  // is exactly what a missing committer identity did: 60 attempts / 47 minutes).
  for (let attempt = 1; attempt <= 60; attempt++) {
    try { git(['merge', '--abort']); } catch (_) { /* none in progress */ }
    try {
      git(['fetch', 'origin', 'main']);
    } catch (e) {
      if (attempt === 60) throw e;
      const s = 1 + Math.floor(Math.random() * 91);
      log(`fetch failed (attempt ${attempt}), retrying in ${s}s`);
      execFileSync('sleep', [String(s)]);
      continue;
    }
    // Merge creates a merge commit, so it carries the identity inline too. A
    // failure here is fatal — retrying can't fix a config or content problem.
    // -q + --no-stat: without them git prints one "Auto-merging <path>" line per
    // file, which is what overflowed the 1 MB default buffer on 2026-08-09.
    git([...IDENT, 'merge', '-q', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat']);
    try {
      git(['push', 'origin', 'HEAD:main']);
      log(`pushed on attempt ${attempt}`);
      return;
    } catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
      // A non-fast-forward / rejected push is genuine contention — retry. Anything
      // else (auth, branch protection, size, hook rejection) is NOT fixed by
      // retrying, so print the real git error and fail fast instead of masking it
      // behind 60 identical "push attempt failed" lines.
      const contention = /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(detail);
      if (!contention) {
        log(`push failed — NOT contention, failing fast. git said:\n${detail}`);
        throw e;
      }
      if (attempt === 60) { log(`push still rejected after 60 attempts. git said:\n${detail}`); throw e; }
      const s = 1 + Math.floor(Math.random() * 91);
      log(`push attempt ${attempt} rejected (remote advanced), re-syncing in ${s}s`);
      execFileSync('sleep', [String(s)]);
    }
  }
}

// ─── Scan for diverged files ──────────────────────────────────────────────────
function scanDiverged() {
  const diverged = [];
  let files = 0;
  for (const bucket of ALL_BUCKETS) {
    const dir = path.join(PLAYERS_DIR, bucket);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const key = f.slice(0, -5);
      if (!isFullUuid(key)) continue;
      files++;
      const p = readJson(path.join(dir, f));
      if (typeof p.apiId === 'string' && p.apiId) {
        diverged.push({ key, apiId: p.apiId });
      }
      if (files % 100000 === 0) log(`scanned ${files} files`);
    }
  }
  log(`scan complete: ${files} files, ${diverged.length} diverged`);
  return { diverged, files };
}

// Repair-only path for aliases orphaned by an EARLIER fold.
//
// 2026-07-31: this originally read reports/fold-diverged.json for the
// oldKey -> apiId pairs. That FAILED in production: OUT_REPORT is a single path
// rewritten by every run, so a later 1-player fold had already overwritten the
// 2,263-entry report from the run that caused the damage. The map loaded with one
// pair, matched nothing, and repointed zero of 284.
//
// It no longer needs the report. The mapping is recoverable from the player files
// themselves: the fold unions BOTH records' spectatorIds into the survivor (and
// adds trunc(oldKey) explicitly), so the file that absorbed a deleted one still
// claims the deleted file's spectator ids. For a dangling alias K -> V, the right
// target is therefore the player file whose spectatorIds contains K. trunc(V) is
// the fallback, since the fold always adds it.
// Ambiguity is never guessed: if two files claim the same id, it is reported.
function buildSpectatorMap() {
  const m = new Map();
  const ambiguous = new Set();
  let files = 0;
  for (const bucket of ALL_BUCKETS) {
    const dir = path.join(PLAYERS_DIR, bucket);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const key = f.slice(0, -5);
      if (!isFullUuid(key)) continue;
      files++;
      let p;
      try { p = readJson(path.join(dir, f)); } catch (_) { continue; }
      const ids = new Set(Array.isArray(p.spectatorIds) ? p.spectatorIds : []);
      ids.add(trunc(key));
      for (const id of ids) {
        const prev = m.get(id);
        if (prev !== undefined && prev !== key) ambiguous.add(id);
        else m.set(id, key);
      }
      if (files % 100000 === 0) log(`spectator map: scanned ${files} files`);
    }
  }
  log(`spectator map: ${files} files, ${m.size} ids, ${ambiguous.size} ambiguous`);
  return { map: m, ambiguous };
}

function repointOnlyMode() {
  const { map: specMap, ambiguous } = buildSpectatorMap();

  const written = [];
  let entries = 0, dangling = 0, repointed = 0, shardsTouched = 0, unresolved = 0;
  const unresolvedSamples = [];

  for (const bucket of ALL_BUCKETS) {
    const ap = path.join(ALIAS_DIR, `${bucket}.json`);
    let m;
    try { m = readJson(ap); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    let dirty = false;
    for (const [k, v] of Object.entries(m)) {
      entries++;
      if (typeof v !== 'string' || v.length !== 36) continue;
      if (fs.existsSync(playerPath(v))) continue;
      dangling++;
      let target = null;
      if (!ambiguous.has(k)) target = specMap.get(k) || null;
      if (!target) {
        const tv = trunc(v);
        if (!ambiguous.has(tv)) target = specMap.get(tv) || null;
      }
      if (!target || !fs.existsSync(playerPath(target))) {
        unresolved++;
        if (unresolvedSamples.length < 20) unresolvedSamples.push(`${k} -> ${v}`);
        continue;
      }
      m[k] = target;
      dirty = true;
      repointed++;
    }
    if (dirty) {
      shardsTouched++;
      if (!DRY) { fs.writeFileSync(ap, JSON.stringify(m)); written.push(ap); }
    }
  }

  log(`aliases: ${entries} scanned, ${dangling} dangling, ${repointed} repointed across ${shardsTouched} shard(s), ${unresolved} unresolvable`);
  for (const smp of unresolvedSamples.slice(0, 10)) log(`  UNRESOLVED: ${smp}`);
  if (DRY) { log('DRY RUN — nothing written.'); return; }
  if (!repointed) { log('nothing to repoint.'); return; }
  writeRefetchShards(DRY ? [] : [...refetchShards].sort(), statsRefetch);

  gitCommitPush(written, `fold-diverged: repoint ${repointed} alias values orphaned by an earlier fold`);
  log('repoint-only complete.');
}

function main() {
  log(`fold-diverged-players ${DRY ? '(DRY RUN)' : ''}${REPOINT_ONLY ? ' (REPOINT-ONLY)' : ''}`);
  if (REPOINT_ONLY) { repointOnlyMode(); return; }
  const { diverged, files } = scanDiverged();

  if (diverged.length === 0) {
    log('invariant holds: zero apiId fields. Nothing to fold.');
    const md = '## fold-diverged: nothing to fold — invariant holds\n';
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md); } catch (_) {}
    }
    return;
  }

  // Pre-pass validation before any write.
  const problems = [];
  for (const d of diverged) {
    if (!isFullUuid(d.apiId)) problems.push(`${d.key}: apiId "${d.apiId}" is not a full uuid`);
    if (d.apiId === d.key) problems.push(`${d.key}: apiId equals its own key`);
  }
  if (problems.length) {
    for (const p of problems.slice(0, 20)) log(`PRE-PASS PROBLEM: ${p}`);
    throw new Error(`pre-pass failed with ${problems.length} problem(s) — nothing written`);
  }

  const written = [], deleted = [], entries = [];
  let promotes = 0, merges = 0, statsRefetch = 0;
  // TWO counters, not one. The first version counted only the direction where the
  // old rule kept the stub and the new one keeps the api file. On fold #76 that
  // reported 5 when 23 merges had actually changed hands — the other 18 went the
  // other way, where the api file held more games but the stub held the fresher
  // answer. A "5" that means "23 decisions moved" is a number that misleads the
  // person reading it, so both directions are reported.
  let stubWouldHaveWon = 0, apiWouldHaveWon = 0;
  // Shard prefixes of every player whose statsChecked this run removes. The
  // workflow turns this into a TARGETED matrix dispatch — see the note at
  // writeRefetchShards() for why nothing else will pick them up.
  const refetchShards = new Set();

  for (const { key, apiId } of diverged) {
    const source = readPlayer(key);
    const targetExists = fs.existsSync(playerPath(apiId));
    let final;
    let keeperIsTarget = null;   // hoisted: the spectatorIds step below needs it

    if (!targetExists) {
      final = clone(source);
      promotes++;
      entries.push({ apiId, action: 'promote', oldKey: key });
    } else {
      const target = readPlayer(apiId);

      // Keeper for the STATS BLOCK ONLY. games/seasons/teams/gameTids/name are
      // unioned below whichever way this goes, so this decides nothing about
      // capture — only about which record's PlayHQ-sourced data survives.
      const sRank = statsRank(source), tRank = statsRank(target);
      if (sRank !== tRank) {
        keeperIsTarget = tRank > sRank;
      } else if (checkedAt(target) !== checkedAt(source)) {
        keeperIsTarget = checkedAt(target) > checkedAt(source);   // fresher answer
      } else {
        keeperIsTarget = true;                                    // api-keyed wins ties
      }

      // Recorded so the dry run can be compared against the old behaviour before
      // anything is applied. The old comparator was `tGames >= sGames`.
      const sGames = gamesCount(source), tGames = gamesCount(target);
      const oldKeeperWasTarget = tGames >= sGames;
      if (oldKeeperWasTarget !== keeperIsTarget) {
        if (keeperIsTarget) stubWouldHaveWon++;   // old kept the stub, new keeps the real profile
        else                apiWouldHaveWon++;    // old kept the api file, new keeps the fresher stub
      }

      final = clone(keeperIsTarget ? target : source);
      const loser = keeperIsTarget ? source : target;
      unionScaffold(final, loser);

      // Both sides are the SAME class of answer and the decision came down to a
      // tie-break, so neither is known to be right for the merged identity.
      // Dropping statsChecked puts the player back in fetch-profile-stats' queue
      // (its skip test is !p?.sports?.Basketball?.statsChecked) and the next
      // matrix run settles it against PlayHQ under the api id. One extra fetch,
      // and the alternative is a number nobody can check.
      //
      // NOT done when the ranks differ. Then the keeper outranks the loser
      // decisively — a real stats block over an empty answer, or over a record
      // that was never fetched or is private — and there is nothing to settle,
      // so the call would be wasted.
      const tieBroken = (sRank === tRank && sRank >= 2);
      if (tieBroken && final.sports && final.sports.Basketball &&
          final.sports.Basketball.statsChecked) {
        delete final.sports.Basketball.statsChecked;
        statsRefetch++;
        refetchShards.add(apiId.slice(0, 2).toLowerCase());   // the file's NEW home
      }

      merges++;
      entries.push({
        apiId, action: 'merge', oldKey: key,
        keeper: keeperIsTarget ? apiId : key,
        sourceRank: sRank, targetRank: tRank,
        sourceGames: sGames, targetGames: tGames,
        oldComparatorKeeper: oldKeeperWasTarget ? apiId : key,
        statsRefetchQueued: tieBroken,
      });
    }

    // spectatorIds: union both records' lists + truncs of both ids
    const spec = new Set(Array.isArray(final.spectatorIds) ? final.spectatorIds : []);
    if (targetExists) {
      // The LOSER's ids. This used to test `final.uuid === apiId`, but final.uuid
      // is not assigned until further down, so on a target-keeper merge it read
      // the target back into itself. Harmless only because the line below unions
      // the source's ids unconditionally. keeperIsTarget says it directly.
      const other = readPlayer(keeperIsTarget ? key : apiId);
      if (Array.isArray(other.spectatorIds)) for (const s of other.spectatorIds) spec.add(s);
    }
    if (Array.isArray(source.spectatorIds)) for (const s of source.spectatorIds) spec.add(s);
    spec.add(trunc(key));
    spec.add(trunc(apiId));
    final.spectatorIds = [...spec].sort();

    final.uuid = apiId;
    delete final.apiId;

    if (!DRY) {
      writePlayer(apiId, final);
      written.push(playerPath(apiId));
      fs.unlinkSync(playerPath(key));
      deleted.push(playerPath(key));
      moveIndexEntry(key, apiId);
    }
  }

  let indexPaths = [];
  if (!DRY) indexPaths = flushIndexShards();

  // Repoint aliases whose value is a file this run just deleted. Runs for BOTH
  // promotes and merges — every folded oldKey has had its file removed.
  const foldMap = {};
  for (const e of entries) foldMap[e.oldKey] = e.apiId;
  const alias = repointAliases(foldMap);

  // Post-check: both invariants must hold.
  if (!DRY) {
    const recheck = scanDiverged();
    if (recheck.diverged.length !== 0) {
      throw new Error(`post-check failed: ${recheck.diverged.length} apiId field(s) remain — NOT committing`);
    }
    // The old post-check asserted apiId-count only, so it PASSED on the run that
    // orphaned 268 aliases. Blame is scoped: a dangling target this run created
    // blocks the commit; one that predates the run is reported and allowed.
    const dang = scanDanglingAliases(foldMap);
    if (dang.mine !== 0) {
      for (const smp of dang.samples.slice(0, 10)) log(`DANGLING: ${smp}`);
      throw new Error(`post-check failed: ${dang.mine} alias value(s) still point at files this run deleted — NOT committing`);
    }
    if (dang.dangling !== 0) {
      log(`NOTE: ${dang.dangling} pre-existing dangling alias value(s) remain — not caused by this run, not blocking. To repair them, dispatch this workflow with mode=repoint-only: it reconstructs the mapping from the player files themselves and needs no report and no arguments. (This line previously said "run with --repoint-only against an older report" — there is no report to run against, and following that advice would have repaired nothing.)`);
    }
  }

  const report = {
    advisory: 'ADVISORY ONLY. This file is a single path overwritten by EVERY fold run, including a 1-player one, so it is not a durable record. Do not build any repair, check or audit on it — reconstruct from the player data instead (spectatorIds[] is the source of truth). See claude_context.md trap T6.',
    generatedAt: new Date().toISOString(),
    dryRun: DRY,
    filesScanned: files,
    folded: diverged.length,
    promotes, merges,
    statsRefetchQueued: statsRefetch,
    refetchShards: [...refetchShards].sort(),
    stubWouldHaveWonUnderOldComparator: stubWouldHaveWon,
    apiWouldHaveWonUnderOldComparator: apiWouldHaveWon,
    keeperChangedTotal: stubWouldHaveWon + apiWouldHaveWon,
    indexShardsTouched: indexPaths.length,
    aliasEntriesScanned: alias.entries,
    aliasValuesRepointed: alias.repointed,
    aliasShardsTouched: alias.shardsTouched,
    entries,
  };
  if (!DRY) {
    fs.mkdirSync(path.dirname(OUT_REPORT), { recursive: true });
    fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2), 'utf8');
  }

  const md = [
    `## fold-diverged${DRY ? ' (DRY RUN)' : ''}`,
    '',
    '| metric | value |', '| --- | --- |',
    `| files scanned | ${files} |`,
    `| diverged folded | ${diverged.length} |`,
    `| promotes | ${promotes} |`,
    `| merges | ${merges} |`,
    `| merges where the keeper CHANGED | ${stubWouldHaveWon + apiWouldHaveWon} |`,
    `|  …old kept the stub, now keeps the real profile | ${stubWouldHaveWon} |`,
    `|  …old kept the api file, now keeps the fresher stub | ${apiWouldHaveWon} |`,
    `| statsChecked dropped (re-fetch queued) | ${statsRefetch} |`,
    `| index shards touched | ${indexPaths.length} |`,
    `| alias values repointed | ${alias.repointed} |`,
    `| alias shards touched | ${alias.shardsTouched} |`,
    `| post-check: zero apiId fields | ${!DRY} |`,
  ].join('\n') + '\n';
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md); } catch (_) {}
  }

  writeRefetchShards(DRY ? [] : [...refetchShards].sort(), statsRefetch);

  gitCommitPush(
    [...written, ...deleted, ...indexPaths, ...alias.written, OUT_REPORT],
    `fold-diverged: ${promotes} promoted, ${merges} merged to api ids`
  );
  log('fold complete.');
}

// ─── Hand the un-checked players back to the matrix ───────────────────────────
// Deleting statsChecked is only half a fix. fetch-profile-stats is dispatched by
// nightly-crawl.yml behind this gate:
//
//   if: always() && (needs.crawl.outputs.new_players != '0' ||
//                    needs.crawl.outputs.stats_rechecks != '0')
//
// new_players is that night's newly stubbed players; stats_rechecks is the length
// of needs-matrix-shards.json. NEITHER counts players missing statsChecked. So a
// quiet night dispatches no matrix at all — and on a night that does dispatch, the
// run is TARGETED at the shards in needs-matrix-shards.json and the matrix's own
// retrigger narrows further to shards reporting work. A player this fold un-checks
// in shard 4a is therefore never revisited unless something independent puts 4a on
// that list.
//
// Left alone, those players would hold no stats AND no statsChecked — strictly
// worse than the wrong-keeper bug this change exists to fix, which at least left a
// number behind.
//
// Appending to needs-matrix-shards.json is the obvious repair and is NOT safe:
// nightly-crawl.js rewrites that file every night and whether it merges or
// overwrites is unknown here. So the fold names the shards itself and the workflow
// dispatches the matrix at exactly them.
//
// This cannot loop. The fold acts only on files carrying an apiId field and
// deletes that field as it goes; the post-check above throws unless zero remain.
// The next fold therefore un-checks nobody and writes an empty list.
//
// DRY runs always write an empty list: a dry run must not be able to cause a
// dispatch.
const REFETCH_SHARDS_FILE = path.join(ROOT, 'refetch-shards.json');
function writeRefetchShards(shards, count) {
  try {
    fs.writeFileSync(REFETCH_SHARDS_FILE, JSON.stringify(shards), 'utf8');
  } catch (e) {
    // Not fatal to the fold — the merge work is already done and committed. But it
    // IS a silent stranding, so say so loudly rather than swallowing it.
    log(`WARNING: could not write ${REFETCH_SHARDS_FILE}: ${e.message}`);
    log(`WARNING: ${count} player(s) had statsChecked removed and will NOT be re-fetched automatically.`);
    return;
  }
  if (shards.length) {
    log(`re-fetch queued: ${count} player(s) across ${shards.length} shard(s) -> ${JSON.stringify(shards)}`);
  } else {
    log('re-fetch queued: none');
  }
}

main();
