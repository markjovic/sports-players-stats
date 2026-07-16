// scripts/probe-stattrack-shapes.cjs
'use strict';
/*
 * READ-ONLY shape/length probe for the StatTrack (#5) rebuild.
 *
 * Establishes, from LIVE on-disk data (no writes to data, no commits), the facts
 * needed to port the resolver + privacy handling into StatTrack correctly instead
 * of guessing field names/lengths:
 *
 *   1. player files: id/uuid field + length, presence & type of `private`,
 *      presence of `apiId` / `spectatorIds`, and the actual `Player #<prefix>`
 *      placeholder format — plus how many `private:true` players carry a REAL
 *      (non-placeholder) name (the exact case task #5 part 1 is about).
 *   2. players/aliases/<xx>: shard shape, how it is SHARDED (by key prefix or
 *      value prefix), key/value lengths, per-shard byte size (client-fetch
 *      viability), total entry count.
 *   3. players/indexes/<xx>: shard shape + how it is keyed (the resolver's
 *      "index-first" step).
 *   4. search/players/<xx>.json: value-entry shape + the `id` length StatTrack
 *      navigates by (loadPlayer path).
 *   5. games/bv/<sid>.json: top-level shape (is there a `.games` wrapper?) and the
 *      game->player DIVERGENCE rate: of distinct game-side ids (p[].id and
 *      hp[]/ap[].profileID), how many resolve by an EXACT canonical file, how many
 *      ONLY via the alias map, how many resolve to neither. This sizes parts 2-4.
 *
 * IMPORTANT: the alias lookup in section 5 is a DESCRIPTIVE measurement only.
 * The production resolver in scripts/lib/uuid-prefix.cjs (index-first -> alias
 * trunc13 + legacy-10 -> self-wins, mid-cycle 404 fallback) is still the thing to
 * port verbatim into StatTrack once its shape is confirmed here.
 *
 * Output: prints a summary to stdout AND writes stattrack-shape-probe.json to the
 * repo root, which the workflow uploads as an artifact. Nothing is committed.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---- config (overridable via --flag=value; the workflow passes these) --------
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const PLAYER_SCAN_CAP   = parseInt(args['player-scan-cap']      || '8000', 10);
const EXAMPLES_PER_CAT  = parseInt(args['examples-per-category'] || '15',  10);
const GAME_FILE_SAMPLE  = parseInt(args['game-file-sample']     || '8',    10);
const GAMES_PER_FILE    = parseInt(args['games-per-file']       || '400',  10);
const ALIAS_EXAMPLES    = 8;

// Candidate truncation lengths to probe (do NOT assume — report which one hits).
const TRUNC_LEN  = 13;
const LEGACY_LEN = 10;

// Descriptive placeholder guess. We DO NOT trust this — we also capture the raw
// name strings of matches so the real on-disk format is visible in the report.
const PLACEHOLDER_RE = /^\s*player\s*#/i;

const report = { generatedAt: new Date().toISOString(), config: {
  PLAYER_SCAN_CAP, EXAMPLES_PER_CAT, GAME_FILE_SAMPLE, GAMES_PER_FILE, TRUNC_LEN, LEGACY_LEN
}, errors: [] };

function safeRead(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { report.errors.push(`read ${path.relative(ROOT, p)}: ${e.message}`); return null; }
}
function listDir(rel) {
  const p = path.join(ROOT, rel);
  try { return fs.existsSync(p) ? fs.readdirSync(p) : null; }
  catch (e) { report.errors.push(`readdir ${rel}: ${e.message}`); return null; }
}
function isHex2(name) { return /^[0-9a-f]{2}$/i.test(name); }
function bump(obj, key) { obj[key] = (obj[key] || 0) + 1; }
function pushCapped(arr, val, cap) { if (arr.length < cap) arr.push(val); }

// ---------------------------------------------------------------------------
// 2. ALIAS shards (built first — section 5 needs the map)
// ---------------------------------------------------------------------------
function buildAliasReport() {
  const out = {
    dirExists: false, shardCount: 0, totalEntries: 0,
    shardByteSizes: { min: null, max: null, medianApprox: null },
    detectedShape: null, shardingKey: null, sampleEntries: [],
    keyLenHistogram: {}, valueLenHistogram: {}, note: ''
  };
  const map = new Map(); // normalized: gameSideKey -> resolvedValue (as found on disk)

  const files = listDir('players/aliases');
  if (!files) { out.note = 'players/aliases missing'; return { out, map }; }
  out.dirExists = true;
  const shardFiles = files.filter(f => f.endsWith('.json'));
  out.shardCount = shardFiles.length;

  const sizes = [];
  let shapeLocked = false;
  for (const f of shardFiles.sort()) {
    const full = path.join(ROOT, 'players/aliases', f);
    let bytes = 0;
    try { bytes = fs.statSync(full).size; } catch (_) {}
    sizes.push(bytes);
    const data = safeRead(full);
    if (data == null) continue;
    const shardPrefix = f.replace(/\.json$/, '');

    // Detect shape once from the first non-empty shard.
    if (!shapeLocked && data && typeof data === 'object') {
      if (Array.isArray(data)) out.detectedShape = 'array';
      else {
        const firstVal = Object.values(data)[0];
        if (firstVal !== undefined) {
          out.detectedShape = (typeof firstVal === 'string')
            ? 'flat-object {key:string}'
            : `nested-object {key:${firstVal && typeof firstVal}}`;
          shapeLocked = true;
        }
      }
    }

    // Extract entries shape-adaptively. Handle the two most plausible shapes:
    //   flat  {spectatorId: apiId}
    //   nested {spectatorId: {apiId|target|to|canonical: "..."}}
    const entries = Array.isArray(data) ? [] : Object.entries(data);
    let keysStartWithShard = 0, valsStartWithShard = 0, counted = 0;
    for (const [k, v] of entries) {
      let resolved = null;
      if (typeof v === 'string') resolved = v;
      else if (v && typeof v === 'object') {
        resolved = v.apiId || v.target || v.to || v.canonical || v.id || null;
      }
      if (resolved == null) continue;
      map.set(k, resolved);
      out.totalEntries++;
      bump(out.keyLenHistogram, String(k).length);
      bump(out.valueLenHistogram, String(resolved).length);
      if (String(k).slice(0, 2).toLowerCase() === shardPrefix.toLowerCase()) keysStartWithShard++;
      if (String(resolved).slice(0, 2).toLowerCase() === shardPrefix.toLowerCase()) valsStartWithShard++;
      counted++;
      pushCapped(out.sampleEntries, { shard: shardPrefix, key: k, keyLen: String(k).length,
        resolved, resolvedLen: String(resolved).length }, ALIAS_EXAMPLES);
    }
    // Sharding-key inference from this shard's own membership.
    if (counted > 0) {
      if (keysStartWithShard === counted && valsStartWithShard !== counted) out.shardingKey = 'by KEY prefix (spectator id) — StatTrack can fetch one shard by game-side prefix';
      else if (valsStartWithShard === counted && keysStartWithShard !== counted) out.shardingKey = 'by VALUE prefix (api id) — StatTrack CANNOT locate a shard from a game-side id alone';
      else if (out.shardingKey == null) out.shardingKey = `ambiguous (keys@prefix=${keysStartWithShard}/${counted}, vals@prefix=${valsStartWithShard}/${counted})`;
    }
  }
  const sorted = sizes.filter(n => n > 0).sort((a, b) => a - b);
  if (sorted.length) {
    out.shardByteSizes.min = sorted[0];
    out.shardByteSizes.max = sorted[sorted.length - 1];
    out.shardByteSizes.medianApprox = sorted[Math.floor(sorted.length / 2)];
  }
  return { out, map };
}

// ---------------------------------------------------------------------------
// 3. INDEX shards
// ---------------------------------------------------------------------------
function buildIndexReport() {
  const out = { dirExists: false, shardCount: 0, sampleShard: null, detectedShape: null,
    sampleEntries: [], keyLenHistogram: {}, note: '' };
  const files = listDir('players/indexes');
  if (!files) { out.note = 'players/indexes missing'; return out; }
  out.dirExists = true;
  const shardFiles = files.filter(f => f.endsWith('.json')).sort();
  out.shardCount = shardFiles.length;
  // Inspect a couple of shards for shape.
  for (const f of shardFiles.slice(0, 3)) {
    const data = safeRead(path.join(ROOT, 'players/indexes', f));
    if (data == null) continue;
    if (!out.sampleShard) out.sampleShard = f;
    if (Array.isArray(data)) {
      out.detectedShape = 'array';
      for (const e of data.slice(0, ALIAS_EXAMPLES)) pushCapped(out.sampleEntries, e, ALIAS_EXAMPLES);
    } else if (data && typeof data === 'object') {
      const ents = Object.entries(data);
      const firstVal = ents[0]?.[1];
      out.detectedShape = out.detectedShape || `object {key: ${firstVal && typeof firstVal}}`;
      for (const [k, v] of ents.slice(0, ALIAS_EXAMPLES)) {
        bump(out.keyLenHistogram, String(k).length);
        pushCapped(out.sampleEntries, { key: k, keyLen: String(k).length,
          value: (v && typeof v === 'object') ? Object.keys(v) : v }, ALIAS_EXAMPLES);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. SEARCH index
// ---------------------------------------------------------------------------
function buildSearchReport() {
  const out = { dirExists: false, sampleShard: null, entryShape: null,
    idLenHistogram: {}, sampleEntries: [], note: '' };
  const files = listDir('search/players');
  if (!files) { out.note = 'search/players missing'; return out; }
  out.dirExists = true;
  const shardFiles = files.filter(f => f.endsWith('.json')).sort();
  const data = shardFiles.length ? safeRead(path.join(ROOT, 'search/players', shardFiles[0])) : null;
  if (data == null) { out.note = 'no readable search shard'; return out; }
  out.sampleShard = shardFiles[0];
  // StatTrack expects { name: [ {id, c, t}, ... ] }
  for (const [name, arr] of Object.entries(data)) {
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      const id = (e && (e.id ?? e.uuid)) ?? null;
      if (id != null) bump(out.idLenHistogram, String(id).length);
      if (!out.entryShape && e && typeof e === 'object') out.entryShape = Object.keys(e);
      pushCapped(out.sampleEntries, { name, entry: e }, ALIAS_EXAMPLES);
    }
    if (out.sampleEntries.length >= ALIAS_EXAMPLES) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. PLAYER files
// ---------------------------------------------------------------------------
function buildPlayerReport() {
  const out = {
    shardDirCount: 0, filesScanned: 0,
    topLevelKeyUnion: {}, // key -> count of files having it
    fnameIdLenHistogram: {}, uuidFieldLenHistogram: {},
    fnameEqualsUuid: { yes: 0, no: 0 },
    privateField: { present: 0, absentButScanned: 0, typeHistogram: {}, trueCount: 0, falseCount: 0 },
    apiIdPresent: 0, spectatorIdsPresent: 0,
    placeholderNameCount: 0, placeholderPrefixLenHistogram: {},
    categories: { normal: 0, private: 0, diverged_apiId: 0 },
    privateWithRealName: 0, privateWithPlaceholderName: 0,
    examples: { private_realName: [], private_placeholderName: [], diverged_apiId: [], normal: [] },
    note: ''
  };
  const players = listDir('players');
  if (!players) { out.note = 'players/ missing'; return out; }
  const shardDirs = players.filter(isHex2).sort();
  out.shardDirCount = shardDirs.length;
  if (!shardDirs.length) { out.note = 'no hex2 shard dirs under players/'; return out; }

  const perShard = Math.max(1, Math.ceil(PLAYER_SCAN_CAP / shardDirs.length));
  outer:
  for (const sd of shardDirs) {
    const dirFiles = listDir(path.join('players', sd));
    if (!dirFiles) continue;
    const jsons = dirFiles.filter(f => f.endsWith('.json'));
    for (const f of jsons.slice(0, perShard)) {
      if (out.filesScanned >= PLAYER_SCAN_CAP) break outer;
      const data = safeRead(path.join(ROOT, 'players', sd, f));
      out.filesScanned++;
      if (data == null || typeof data !== 'object') continue;

      for (const k of Object.keys(data)) bump(out.topLevelKeyUnion, k);

      const fnameId = f.replace(/\.json$/, '');
      bump(out.fnameIdLenHistogram, fnameId.length);
      const uuidVal = data.uuid != null ? String(data.uuid) : null;
      if (uuidVal != null) {
        bump(out.uuidFieldLenHistogram, uuidVal.length);
        (fnameId === uuidVal) ? out.fnameEqualsUuid.yes++ : out.fnameEqualsUuid.no++;
      }

      const hasPrivate = Object.prototype.hasOwnProperty.call(data, 'private');
      if (hasPrivate) {
        out.privateField.present++;
        bump(out.privateField.typeHistogram, typeof data.private);
        if (data.private === true) out.privateField.trueCount++;
        else if (data.private === false) out.privateField.falseCount++;
      } else {
        out.privateField.absentButScanned++;
      }
      const hasApiId = Object.prototype.hasOwnProperty.call(data, 'apiId') && data.apiId;
      if (hasApiId) out.apiIdPresent++;
      if (Object.prototype.hasOwnProperty.call(data, 'spectatorIds')) out.spectatorIdsPresent++;

      const name = data.name != null ? String(data.name) : '';
      const isPlaceholder = PLACEHOLDER_RE.test(name);
      if (isPlaceholder) {
        out.placeholderNameCount++;
        const m = name.match(/#\s*([0-9a-fA-F-]+)/);
        if (m) bump(out.placeholderPrefixLenHistogram, m[1].length);
      }

      // Categorize (a player can be both private and diverged; count independently).
      const isPrivate = data.private === true;
      if (isPrivate) {
        out.categories.private++;
        if (isPlaceholder) { out.privateWithPlaceholderName++;
          pushCapped(out.examples.private_placeholderName, { file: `${sd}/${f}`, name, private: data.private, apiId: data.apiId ?? null, keys: Object.keys(data) }, EXAMPLES_PER_CAT);
        } else { out.privateWithRealName++;
          pushCapped(out.examples.private_realName, { file: `${sd}/${f}`, name, private: data.private, apiId: data.apiId ?? null, keys: Object.keys(data) }, EXAMPLES_PER_CAT);
        }
      } else {
        out.categories.normal++;
        pushCapped(out.examples.normal, { file: `${sd}/${f}`, name, keys: Object.keys(data) }, Math.min(5, EXAMPLES_PER_CAT));
      }
      if (hasApiId) {
        out.categories.diverged_apiId++;
        pushCapped(out.examples.diverged_apiId, { file: `${sd}/${f}`, name, uuid: uuidVal, apiId: String(data.apiId),
          apiIdLen: String(data.apiId).length, uuidLen: uuidVal ? uuidVal.length : null,
          spectatorIds: data.spectatorIds ?? null, private: data.private ?? null }, EXAMPLES_PER_CAT);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. GAMES + divergence resolution
// ---------------------------------------------------------------------------
function playerFileExists(id, len) {
  if (!id) return false;
  const key = len ? String(id).slice(0, len) : String(id);
  const shard = String(id).slice(0, 2);
  return fs.existsSync(path.join(ROOT, 'players', shard, key + '.json'));
}
function classifyGameSideId(id, aliasMap) {
  // Returns the FIRST resolution path that hits, describing how a game-side id
  // maps to a canonical player file. Order mirrors the intended resolver:
  // exact file -> exact trunc file -> alias(map) then file. Purely descriptive.
  if (playerFileExists(id, null))      return 'exact_full';
  if (playerFileExists(id, TRUNC_LEN)) return 'exact_trunc13';
  if (playerFileExists(id, LEGACY_LEN))return 'exact_legacy10';
  // alias hop: try id as-is, then trunc13, then legacy10 as the alias KEY
  for (const [form, key] of [['as-is', id], ['trunc13', String(id).slice(0, TRUNC_LEN)], ['legacy10', String(id).slice(0, LEGACY_LEN)]]) {
    if (aliasMap.has(key)) {
      const target = aliasMap.get(key);
      if (playerFileExists(target, null))       return `alias_${form}->exact_full`;
      if (playerFileExists(target, TRUNC_LEN))  return `alias_${form}->exact_trunc13`;
      return `alias_${form}->target_404`; // resolves in alias map but target file missing (the mid-cycle 404 case)
    }
  }
  return 'unresolved';
}
function buildGamesReport(aliasMap) {
  const out = { dirExists: false, seasonFilesSampled: [], topLevelShape: null,
    gameSideIdLenHistogram: {}, pEntryShape: null, hpEntryShape: null,
    distinctGameSideIds: 0, resolution: {}, examplesUnresolved: [], examplesAliasTarget404: [], note: '' };
  const files = listDir('games/bv');
  if (!files) { out.note = 'games/bv missing'; return out; }
  out.dirExists = true;
  const seasonFiles = files.filter(f => f.endsWith('.json')).sort();
  // Spread the sample across the sorted list.
  const stride = Math.max(1, Math.floor(seasonFiles.length / GAME_FILE_SAMPLE));
  const picked = [];
  for (let i = 0; i < seasonFiles.length && picked.length < GAME_FILE_SAMPLE; i += stride) picked.push(seasonFiles[i]);

  const distinct = new Map(); // id -> source label
  for (const sf of picked) {
    const data = safeRead(path.join(ROOT, 'games/bv', sf));
    if (data == null) continue;
    out.seasonFilesSampled.push(sf);
    // Detect wrapper: {games:{...}} vs flat {gid:{...}}
    const gamesMap = (data.games && typeof data.games === 'object') ? data.games : data;
    if (!out.topLevelShape) out.topLevelShape = (data.games && typeof data.games === 'object')
      ? 'wrapped: {games:{gid:...}, ...}' : 'flat: {gid:...}';
    let n = 0;
    for (const g of Object.values(gamesMap)) {
      if (n++ >= GAMES_PER_FILE) break;
      if (!g || typeof g !== 'object') continue;
      for (const entry of (g.p || [])) {
        const id = (typeof entry === 'string') ? entry : (entry && entry.id);
        if (!out.pEntryShape && entry && typeof entry === 'object') out.pEntryShape = Object.keys(entry);
        else if (!out.pEntryShape && typeof entry === 'string') out.pEntryShape = 'string';
        if (id) { bump(out.gameSideIdLenHistogram, String(id).length); if (!distinct.has(id)) distinct.set(id, 'p[].id'); }
      }
      for (const side of ['hp', 'ap']) {
        for (const entry of (g[side] || [])) {
          const id = entry && entry.profileID;
          if (!out.hpEntryShape && entry && typeof entry === 'object') out.hpEntryShape = Object.keys(entry);
          if (id) { bump(out.gameSideIdLenHistogram, String(id).length); if (!distinct.has(id)) distinct.set(id, side + '[].profileID'); }
        }
      }
    }
  }
  out.distinctGameSideIds = distinct.size;
  for (const [id, src] of distinct) {
    const cls = classifyGameSideId(id, aliasMap);
    bump(out.resolution, cls);
    if (cls === 'unresolved') pushCapped(out.examplesUnresolved, { id, idLen: String(id).length, src }, 15);
    if (cls.endsWith('target_404')) pushCapped(out.examplesAliasTarget404, { id, resolvedTo: aliasMap.get(id) || aliasMap.get(String(id).slice(0, TRUNC_LEN)) || aliasMap.get(String(id).slice(0, LEGACY_LEN)), src }, 15);
  }
  return out;
}

// ---------------------------------------------------------------------------
function pct(part, whole) { return whole ? ((part / whole) * 100).toFixed(1) + '%' : 'n/a'; }

function main() {
  const alias = buildAliasReport();
  report.aliases  = alias.out;
  report.indexes  = buildIndexReport();
  report.search   = buildSearchReport();
  report.players  = buildPlayerReport();
  report.games    = buildGamesReport(alias.map);

  // Human summary to the Actions log.
  const P = report.players, A = report.aliases, G = report.games, I = report.indexes, S = report.search;
  const L = [];
  L.push('===== StatTrack shape probe =====');
  L.push('');
  L.push('[1] PLAYER FILES  (scanned ' + P.filesScanned + ' across ' + P.shardDirCount + ' shard dirs)');
  L.push('    fname id length histogram : ' + JSON.stringify(P.fnameIdLenHistogram));
  L.push('    uuid field length hist    : ' + JSON.stringify(P.uuidFieldLenHistogram));
  L.push('    fname === uuid            : yes=' + P.fnameEqualsUuid.yes + ' no=' + P.fnameEqualsUuid.no);
  L.push('    `private` field present   : ' + P.privateField.present + ' (' + pct(P.privateField.present, P.filesScanned) + '), types=' + JSON.stringify(P.privateField.typeHistogram));
  L.push('                              : true=' + P.privateField.trueCount + ' false=' + P.privateField.falseCount);
  L.push('    apiId present             : ' + P.apiIdPresent + '   spectatorIds present: ' + P.spectatorIdsPresent);
  L.push('    placeholder-name count    : ' + P.placeholderNameCount + ', prefix-len hist=' + JSON.stringify(P.placeholderPrefixLenHistogram));
  L.push('    >> private w/ REAL name   : ' + P.privateWithRealName + '   private w/ placeholder name: ' + P.privateWithPlaceholderName);
  L.push('    top-level keys (union)    : ' + JSON.stringify(P.topLevelKeyUnion));
  L.push('');
  L.push('[2] ALIAS shards  (players/aliases)');
  L.push('    exists=' + A.dirExists + ' shardCount=' + A.shardCount + ' totalEntries=' + A.totalEntries);
  L.push('    detectedShape=' + A.detectedShape + '  shardingKey=' + A.shardingKey);
  L.push('    key len hist=' + JSON.stringify(A.keyLenHistogram) + '  value len hist=' + JSON.stringify(A.valueLenHistogram));
  L.push('    shard bytes min/median/max=' + JSON.stringify(A.shardByteSizes));
  L.push('');
  L.push('[3] INDEX shards  (players/indexes)');
  L.push('    exists=' + I.dirExists + ' shardCount=' + I.shardCount + ' detectedShape=' + I.detectedShape + ' keyLenHist=' + JSON.stringify(I.keyLenHistogram));
  L.push('');
  L.push('[4] SEARCH index  (search/players)');
  L.push('    exists=' + S.dirExists + ' entryShape=' + JSON.stringify(S.entryShape) + ' id len hist=' + JSON.stringify(S.idLenHistogram));
  L.push('');
  L.push('[5] GAMES + DIVERGENCE  (sampled ' + G.seasonFilesSampled.length + ' season files)');
  L.push('    top-level shape           : ' + G.topLevelShape);
  L.push('    p[] entry shape           : ' + JSON.stringify(G.pEntryShape) + '   hp/ap entry shape: ' + JSON.stringify(G.hpEntryShape));
  L.push('    game-side id length hist  : ' + JSON.stringify(G.gameSideIdLenHistogram));
  L.push('    distinct game-side ids    : ' + G.distinctGameSideIds);
  L.push('    resolution breakdown      :');
  const total = G.distinctGameSideIds || 1;
  for (const [k, v] of Object.entries(G.resolution).sort((a, b) => b[1] - a[1])) {
    L.push('        ' + k.padEnd(34) + ' ' + String(v).padStart(7) + '  (' + pct(v, total) + ')');
  }
  if (report.errors.length) { L.push(''); L.push('ERRORS (' + report.errors.length + '): first few:'); report.errors.slice(0, 8).forEach(e => L.push('    - ' + e)); }
  L.push('');
  L.push('Full detail (with examples) written to stattrack-shape-probe.json (artifact).');
  const summary = L.join('\n');
  console.log(summary);
  report.summaryText = summary;

  const outPath = path.join(ROOT, 'stattrack-shape-probe.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('\nWrote ' + path.relative(ROOT, outPath));
}

main();
