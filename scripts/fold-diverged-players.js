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
//   target exists  -> MERGE: keeper = more games[] entries (tie -> the
//                     api-keyed record, then larger file — the rekey-plan
//                     comparator); scaffolds/games/teams/gameTids unioned;
//                     stats NEVER summed; old file deleted.
//   index          -> entry moved old key -> api id, enriched fields carried,
//                     entry-internal uuid re-pointed, histories unioned.
// Aliases need nothing here — the redirect was written at discovery
// (fetch-profile-stats.js recordAliasDiscovery).
//
// Idempotent: a second run finds zero apiId fields and exits 0. Ends with a
// full re-scan asserting exactly that before committing. Single commit,
// explicit paths, proven push pattern. Safe to run on a schedule.
//
// Usage:
//   node scripts/fold-diverged-players.js            # fold + commit
//   node scripts/fold-diverged-players.js --dry-run  # report only
// Env: FOLD_NO_GIT=1 disables git (local testing only).

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { TRUNC_LEN, isFullUuid } = require('./lib/uuid-prefix.cjs');
const { isPlaceholderName } = require('./lib/namespace-resolve.cjs');

const ROOT = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const INDEX_DIR = path.join(ROOT, 'players', 'indexes');
const OUT_REPORT = path.join(ROOT, 'reports', 'fold-diverged.json');

const DRY = process.argv.includes('--dry-run');
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

// ─── Git — in-script single commit, proven push pattern ───────────────────────
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}
function gitCommitPush(paths, message) {
  if (NO_GIT || DRY) return;
  for (let i = 0; i < paths.length; i += 500) git(['add', '--', ...paths.slice(i, i + 500)]);
  const staged = git(['diff', '--cached', '--shortstat']).trim(); // never --stat
  if (!staged) { log('nothing staged, skip commit'); return; }
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
    git([...IDENT, 'merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit']);
    try {
      git(['push', 'origin', 'HEAD:main']);
      log(`pushed on attempt ${attempt}`);
      return;
    } catch (e) {
      if (attempt === 60) throw e;
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

function main() {
  log(`fold-diverged-players ${DRY ? '(DRY RUN)' : ''}`);
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
  let promotes = 0, merges = 0;

  for (const { key, apiId } of diverged) {
    const source = readPlayer(key);
    const targetExists = fs.existsSync(playerPath(apiId));
    let final;

    if (!targetExists) {
      final = clone(source);
      promotes++;
      entries.push({ apiId, action: 'promote', oldKey: key });
    } else {
      const target = readPlayer(apiId);
      // keeper: rekey-plan comparator — games desc, api-keyed record, size
      const sGames = gamesCount(source), tGames = gamesCount(target);
      const keeperIsTarget =
        tGames > sGames ||
        (tGames === sGames && true /* api-keyed wins ties */);
      final = clone(keeperIsTarget ? target : source);
      unionScaffold(final, keeperIsTarget ? source : target);
      merges++;
      entries.push({ apiId, action: 'merge', oldKey: key, keeper: keeperIsTarget ? apiId : key });
    }

    // spectatorIds: union both records' lists + truncs of both ids
    const spec = new Set(Array.isArray(final.spectatorIds) ? final.spectatorIds : []);
    if (targetExists) {
      const other = readPlayer(targetExists && final.uuid === apiId ? key : apiId);
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

  // Post-check: invariant must now hold.
  if (!DRY) {
    const recheck = scanDiverged();
    if (recheck.diverged.length !== 0) {
      throw new Error(`post-check failed: ${recheck.diverged.length} apiId field(s) remain — NOT committing`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun: DRY,
    filesScanned: files,
    folded: diverged.length,
    promotes, merges,
    indexShardsTouched: indexPaths.length,
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
    `| index shards touched | ${indexPaths.length} |`,
    `| post-check: zero apiId fields | ${!DRY} |`,
  ].join('\n') + '\n';
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md); } catch (_) {}
  }

  gitCommitPush(
    [...written, ...deleted, ...indexPaths, OUT_REPORT],
    `fold-diverged: ${promotes} promoted, ${merges} merged to api ids`
  );
  log('fold complete.');
}

main();
