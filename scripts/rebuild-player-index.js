// scripts/rebuild-player-index.js
//
// 3b-3 of the api-canonical migration: rebuild players/indexes/{2hex}.json so
// every entry is keyed by the api id — i.e. by the player file's actual
// filename, which post-3b-2 IS the api id for everyone.
//
// Why a full rebuild rather than a patch: the index is the resolution backbone
// (resolveToFullUuid resolves game-file id prefixes against index keys) and it
// still carries pre-migration keys for the 2,300 re-keyed people — their old
// keys point at deleted files, and their api ids are missing. Deriving every
// entry fresh from the player files makes index and tree correspond 1:1 by
// construction.
//
// Entry shape (confirmed from both construction sites in nightly-crawl.js,
// Phase 3-cont L977-982 and Phase 4 L1090-1095):
//   index[uuid] = { name, history }        history = { sid: [tid, ...] }
// derived here as: name = player.name (fallback: old entry's name, then the
// stub placeholder format), history = per-season unique reg tids (season
// omitted when it has no tids — matching nightly's only-on-push semantics).
//
// Unknown-field safety: entries are rebuilt as
//   { ...(old entry under the SAME key, if any), name, history }
// so any field this script doesn't know about survives for every player whose
// key didn't change (~409k). The 2,300 re-keyed people get fresh entries. A
// field census of the old index is reported so unknown fields are SEEN, not
// assumed away — check it in --dry-run before committing.
//
// No git here — the workflow commits once.
//
// Usage:
//   node scripts/rebuild-player-index.js            # rebuild + write shards + report
//   node scripts/rebuild-player-index.js --dry-run  # derive + census + report only

'use strict';

const fs = require('fs');
const path = require('path');
const { isFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const INDEX_DIR = path.join(ROOT, 'players', 'indexes');
const OUT_REPORT = path.join(ROOT, 'reports', 'rebuild-player-index.json');

const DRY = process.argv.includes('--dry-run');

const HEX = '0123456789abcdef';
const ALL_BUCKETS = [];
for (const a of HEX) for (const b of HEX) ALL_BUCKETS.push(a + b);

function log(msg) { console.log(`[reindex] ${new Date().toISOString()} ${msg}`); }

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function main() {
  // ── Load the ENTIRE old index up front: same-key carry-over + field census +
  //    dropped/added accounting. 256 shards, ~small; fine in memory.
  const oldIndex = new Map(); // uuid -> entry
  let oldShards = 0;
  if (fs.existsSync(INDEX_DIR)) {
    for (const f of fs.readdirSync(INDEX_DIR)) {
      if (!/^[0-9a-f]{2}\.json$/.test(f)) continue;
      let shard;
      try { shard = readJson(path.join(INDEX_DIR, f)); }
      catch (e) { throw new Error(`Unparseable index shard ${f}: ${e.message}`); }
      for (const [k, v] of Object.entries(shard)) oldIndex.set(k, v);
      oldShards++;
    }
  }
  log(`old index loaded: ${oldShards} shards, ${oldIndex.size} entries`);

  // Field census of the old index — surface anything beyond {name, history}.
  const extraFieldCounts = {};
  let entriesWithExtras = 0;
  for (const v of oldIndex.values()) {
    if (!v || typeof v !== 'object') continue;
    let hasExtra = false;
    for (const k of Object.keys(v)) {
      if (k === 'name' || k === 'history') continue;
      extraFieldCounts[k] = (extraFieldCounts[k] || 0) + 1;
      hasExtra = true;
    }
    if (hasExtra) entriesWithExtras++;
  }

  // ── Rebuild from player files ────────────────────────────────────────────────
  const newShards = new Map(); // bucket -> { uuid: entry }
  for (const b of ALL_BUCKETS) newShards.set(b, {});

  let files = 0, carried = 0, fresh = 0, apiIdFieldSeen = 0, nameFallbacks = 0;

  for (const bucket of ALL_BUCKETS) {
    const dir = path.join(PLAYERS_DIR, bucket);
    if (!fs.existsSync(dir)) continue;
    const out = newShards.get(bucket);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const uuid = f.slice(0, -5);
      if (!isFullUuid(uuid)) continue;
      const p = readJson(path.join(dir, f));
      files++;

      // Post-3b-2 invariant: no player file carries apiId. Count violations —
      // nonzero means the tree moved since APPLY and this rebuild should stop.
      if (typeof p.apiId === 'string' && p.apiId) apiIdFieldSeen++;

      // history: per-season unique reg tids; omit seasons with none (matches
      // nightly's only-on-push construction).
      const history = {};
      for (const season of (p.seasons || [])) {
        const tids = [...new Set((season.regs || []).map(r => r.tid).filter(Boolean))];
        if (tids.length) history[season.sid] = tids;
      }

      const old = oldIndex.get(uuid);
      let name = p.name;
      if (!name) {
        name = (old && old.name) || `Player #${uuid.slice(0, 10)}`;
        nameFallbacks++;
      }

      out[uuid] = old ? { ...old, name, history } : { name, history };
      if (old) carried++; else fresh++;

      if (files % 50000 === 0) log(`derived ${files} entries`);
    }
  }
  log(`derivation complete: ${files} entries (carried=${carried} fresh=${fresh})`);

  if (apiIdFieldSeen > 0) {
    throw new Error(`${apiIdFieldSeen} player file(s) still carry an apiId field — tree is not post-3b-2; aborting, nothing written`);
  }

  // Dropped/added accounting vs the old index.
  const newKeys = new Set();
  for (const out of newShards.values()) for (const k of Object.keys(out)) newKeys.add(k);
  let dropped = 0;
  const droppedSample = [];
  for (const k of oldIndex.keys()) {
    if (!newKeys.has(k)) {
      dropped++;
      if (droppedSample.length < 20) droppedSample.push(k);
    }
  }
  const added = fresh; // fresh == keys with no same-key old entry

  // ── Write shards + report ────────────────────────────────────────────────────
  if (!DRY) {
    fs.mkdirSync(INDEX_DIR, { recursive: true });
    for (const [bucket, out] of newShards) {
      const sorted = {};
      for (const k of Object.keys(out).sort()) sorted[k] = out[k];
      fs.writeFileSync(path.join(INDEX_DIR, bucket + '.json'), JSON.stringify(sorted));
    }
    log(`wrote ${newShards.size} index shards`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun: DRY,
    playerFiles: files,
    newEntries: newKeys.size,
    oldEntries: oldIndex.size,
    carriedSameKey: carried,
    freshEntries: fresh,
    droppedOldKeys: dropped,
    droppedSample,
    nameFallbacks,
    oldIndexFieldCensus: { extraFieldCounts, entriesWithExtras },
    oneToOne: files === newKeys.size,
  };
  if (!DRY) {
    fs.mkdirSync(path.dirname(OUT_REPORT), { recursive: true });
    fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2), 'utf8');
  }

  const L = [];
  L.push(`## 3b-3 player index rebuild${DRY ? ' (DRY RUN — nothing written)' : ''}`);
  L.push('');
  L.push('| metric | value |');
  L.push('| --- | --- |');
  L.push(`| player files scanned | ${files} |`);
  L.push(`| new index entries | ${newKeys.size} |`);
  L.push(`| 1:1 with files? | ${report.oneToOne} |`);
  L.push(`| old index entries | ${oldIndex.size} |`);
  L.push(`| carried (same key, fields preserved) | ${carried} |`);
  L.push(`| fresh entries (re-keyed people) | ${fresh} |`);
  L.push(`| dropped old keys (dead: deleted files) | ${dropped} |`);
  L.push(`| name fallbacks (file had no name) | ${nameFallbacks} |`);
  L.push(`| old entries with fields beyond name/history | ${entriesWithExtras} |`);
  if (Object.keys(extraFieldCounts).length) {
    L.push('', '### Old-index field census — REVIEW BEFORE APPLY', '');
    L.push('| field | entries |');
    L.push('| --- | --- |');
    for (const [k, n] of Object.entries(extraFieldCounts)) L.push(`| ${k} | ${n} |`);
    L.push('', '_Fields above survive for carried entries but are LOST on the fresh (re-keyed) ones. If any field matters, stop and tell Claude._');
  } else {
    L.push('', '_No fields beyond name/history anywhere in the old index — carry-over risk is nil._');
  }
  if (droppedSample.length) {
    L.push('', `Dropped-key sample (expect old keys of migrated people): ${droppedSample.slice(0, 8).join(', ')}…`);
  }
  const summary = L.join('\n') + '\n';
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary); } catch (_) {}
  }
  log(`DONE. entries=${newKeys.size} carried=${carried} fresh=${fresh} dropped=${dropped}${DRY ? ' (dry-run)' : ''}`);
}

main();
