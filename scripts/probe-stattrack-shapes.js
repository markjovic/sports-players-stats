// scripts/probe-stattrack-shapes.js
'use strict';
/*
 * READ-ONLY shape/length probe for the StatTrack (#5) rebuild.
 *
 * Standalone diagnostic entry point (CommonJS), same shape as db-audit.js /
 * diagnose.js / verify-enrich.js: a .js file in scripts/, run as
 * `node scripts/probe-stattrack-shapes.js`. It writes NOTHING to the repo
 * (no commit); the report is uploaded as an artifact and printed to the log.
 *
 * Establishes, from LIVE on-disk data, the facts needed to port the resolver +
 * privacy handling into StatTrack instead of guessing:
 *
 *   1. player files: id/uuid field + length, canonical FILENAME form
 *      (full-36 vs trunc-13), presence & type of `private`, presence of
 *      `apiId` / `spectatorIds`, the actual `Player #<prefix>` placeholder
 *      format, and how many `private:true` players carry a REAL name.
 *   2. players/aliases/<xx>: shard shape, sharding key (by spectator-id prefix
 *      or api-id prefix), key/value lengths, per-shard byte size, entry count.
 *   3. players/indexes/<xx>: shape + key form (the un-truncation source).
 *   4. search/players/<xx>.json: entry shape + the `id` length StatTrack
 *      navigates by.
 *   5. games/bv/<sid>.json: `.games` wrapper? + game->player resolution using
 *      the TWO real mechanisms (index un-truncation for 13/10-char ids;
 *      spectator->api alias hop for full ids), and the spectatorIds-COMPLETENESS
 *      check: of the game-side ids that alias-resolve to a canonical player,
 *      how many are actually listed in that player's spectatorIds[]. If ~all
 *      are, StatTrack can match games from the already-loaded player file and
 *      the client-side alias fetch is unnecessary; if not, it must fetch alias
 *      shards. This settles the architectural fork.
 *
 * The resolution logic below mirrors the documented uuid-prefix.cjs /
 * alias-shard behaviour for MEASUREMENT ONLY. The production resolver
 * (scripts/lib/uuid-prefix.cjs) + isPlaceholderName (scripts/lib/namespace-resolve.cjs)
 * remain the artifacts to port verbatim once confirmed here.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---- config (overridable via --flag=value; the workflow passes these) --------
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const PLAYER_SCAN_CAP   = parseInt(args['player-scan-cap']       || '8000', 10);
const EXAMPLES_PER_CAT  = parseInt(args['examples-per-category'] || '15',   10);
const GAME_FILE_SAMPLE  = parseInt(args['game-file-sample']      || '8',    10);
const GAMES_PER_FILE    = parseInt(args['games-per-file']        || '400',  10);
const ALIAS_EXAMPLES    = 8;

const TRUNC_LEN  = 13; // uuid-prefix.cjs TRUNC_LEN
const LEGACY_LEN = 10; // uuid-prefix.cjs LEGACY_TRUNC_LEN

// Descriptive placeholder guess ONLY. We also capture raw matched names so the
// real on-disk format is visible; the authoritative test is isPlaceholderName.
const PLACEHOLDER_RE = /^\s*player\s*#/i;

const report = {
  generatedAt: new Date().toISOString(),
  config: { PLAYER_SCAN_CAP, EXAMPLES_PER_CAT, GAME_FILE_SAMPLE, GAMES_PER_FILE, TRUNC_LEN, LEGACY_LEN },
  errors: []
};

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
function trunc(id, n) { return String(id).slice(0, n); }

// Does a canonical player file exist for this (full) id? Try both the full-id
// filename and the trunc13 filename, since diverged records may be stored under
// the truncated api id. Returns 'full' | 'trunc13' | false.
function canonicalFileForm(fullId) {
  if (!fullId) return false;
  const s = String(fullId), sh = s.slice(0, 2);
  if (fs.existsSync(path.join(ROOT, 'players', sh, s + '.json'))) return 'full';
  const t = s.slice(0, TRUNC_LEN);
  if (t !== s && fs.existsSync(path.join(ROOT, 'players', sh, t + '.json'))) return 'trunc13';
  return false;
}

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
  const map = new Map(); // key (as found on disk) -> resolved value
  const files = listDir('players/aliases');
  if (!files) { out.note = 'players/aliases missing'; return { out, map }; }
  out.dirExists = true;
  const shardFiles = files.filter(f => f.endsWith('.json')).sort();
  out.shardCount = shardFiles.length;

  const sizes = [];
  let shapeLocked = false;
  for (const f of shardFiles) {
    const full = path.join(ROOT, 'players/aliases', f);
    try { sizes.push(fs.statSync(full).size); } catch (_) {}
    const data = safeRead(full);
    if (data == null) continue;
    const shardPrefix = f.replace(/\.json$/, '').toLowerCase();

    if (!shapeLocked && data && typeof data === 'object' && !Array.isArray(data)) {
      const firstVal = Object.values(data)[0];
      if (firstVal !== undefined) {
        out.detectedShape = (typeof firstVal === 'string')
          ? 'flat-object {key:string}'
          : `nested-object {key:${firstVal && typeof firstVal}}`;
        shapeLocked = true;
      }
    }

    const entries = Array.isArray(data) ? [] : Object.entries(data);
    let keyAtPrefix = 0, valAtPrefix = 0, counted = 0;
    for (const [k, v] of entries) {
      let resolved = (typeof v === 'string') ? v
        : (v && typeof v === 'object') ? (v.apiId || v.target || v.to || v.canonical || v.id || null)
        : null;
      if (resolved == null) continue;
      map.set(String(k), String(resolved));
      out.totalEntries++;
      bump(out.keyLenHistogram, String(k).length);
      bump(out.valueLenHistogram, String(resolved).length);
      if (String(k).slice(0, 2).toLowerCase() === shardPrefix) keyAtPrefix++;
      if (String(resolved).slice(0, 2).toLowerCase() === shardPrefix) valAtPrefix++;
      counted++;
      pushCapped(out.sampleEntries, { shard: shardPrefix, key: k, keyLen: String(k).length, resolved, resolvedLen: String(resolved).length }, ALIAS_EXAMPLES);
    }
    if (counted > 0 && out.shardingKey == null) {
      if (keyAtPrefix === counted && valAtPrefix !== counted) out.shardingKey = 'by KEY prefix (spectator id) — StatTrack CAN fetch one shard from a game-side id';
      else if (valAtPrefix === counted && keyAtPrefix !== counted) out.shardingKey = 'by VALUE prefix (api id) — StatTrack CANNOT locate a shard from a game-side id alone';
    } else if (counted > 0 && out.shardingKey && !out.shardingKey.startsWith('by ')) {
      // keep first decisive verdict
    }
  }
  const sorted = sizes.filter(n => n > 0).sort((a, b) => a - b);
  if (sorted.length) {
    out.shardByteSizes.min = sorted[0];
    out.shardByteSizes.max = sorted[sorted.length - 1];
    out.shardByteSizes.medianApprox = sorted[Math.floor(sorted.length / 2)];
  }
  if (out.shardingKey == null && out.totalEntries > 0) out.shardingKey = 'ambiguous (see key/value length histograms + samples)';
  return { out, map };
}

// ---------------------------------------------------------------------------
// 3. INDEX shards — also used lazily to un-truncate 13/10-char game ids
// ---------------------------------------------------------------------------
const indexShardCache = {}; // shard -> Map<prefix, fullUuid | null(ambiguous)>
function indexPrefixMap(shard) {
  if (indexShardCache[shard] !== undefined) return indexShardCache[shard];
  const data = safeRead(path.join(ROOT, 'players/indexes', shard + '.json'));
  const m = new Map();
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const fullKey of Object.keys(data)) {
      for (const n of [TRUNC_LEN, LEGACY_LEN]) {
        const pfx = fullKey.slice(0, n);
        m.set(pfx, m.has(pfx) && m.get(pfx) !== fullKey ? null : fullKey); // collision -> null
      }
    }
  }
  indexShardCache[shard] = m;
  return m;
}
function indexResolve(truncId) {
  const sh = String(truncId).slice(0, 2);
  const m = indexPrefixMap(sh);
  return m ? (m.get(String(truncId)) || null) : null;
}
function buildIndexReport() {
  const out = { dirExists: false, shardCount: 0, sampleShard: null, detectedShape: null, sampleEntries: [], keyLenHistogram: {}, note: '' };
  const files = listDir('players/indexes');
  if (!files) { out.note = 'players/indexes missing'; return out; }
  out.dirExists = true;
  const shardFiles = files.filter(f => f.endsWith('.json')).sort();
  out.shardCount = shardFiles.length;
  for (const f of shardFiles.slice(0, 3)) {
    const data = safeRead(path.join(ROOT, 'players/indexes', f));
    if (data == null) continue;
    if (!out.sampleShard) out.sampleShard = f;
    if (Array.isArray(data)) { out.detectedShape = 'array'; for (const e of data.slice(0, ALIAS_EXAMPLES)) pushCapped(out.sampleEntries, e, ALIAS_EXAMPLES); }
    else if (data && typeof data === 'object') {
      const ents = Object.entries(data);
      const firstVal = ents[0]?.[1];
      out.detectedShape = out.detectedShape || `object {key: ${firstVal && typeof firstVal}}`;
      for (const [k, v] of ents.slice(0, ALIAS_EXAMPLES)) {
        bump(out.keyLenHistogram, String(k).length);
        pushCapped(out.sampleEntries, { key: k, keyLen: String(k).length, value: (v && typeof v === 'object') ? Object.keys(v) : v }, ALIAS_EXAMPLES);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. SEARCH index
// ---------------------------------------------------------------------------
function buildSearchReport() {
  const out = { dirExists: false, sampleShard: null, entryShape: null, idLenHistogram: {}, sampleEntries: [], note: '' };
  const files = listDir('search/players');
  if (!files) { out.note = 'search/players missing'; return out; }
  out.dirExists = true;
  const shardFiles = files.filter(f => f.endsWith('.json')).sort();
  const data = shardFiles.length ? safeRead(path.join(ROOT, 'search/players', shardFiles[0])) : null;
  if (data == null) { out.note = 'no readable search shard'; return out; }
  out.sampleShard = shardFiles[0];
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
    shardDirCount: 0, filesScanned: 0, topLevelKeyUnion: {},
    filenameForm: { full36: 0, trunc13: 0, other: 0 }, fnameIdLenHistogram: {}, uuidFieldLenHistogram: {}, fnameEqualsUuid: { yes: 0, no: 0 },
    privateField: { present: 0, absentButScanned: 0, typeHistogram: {}, trueCount: 0, falseCount: 0 },
    apiIdPresent: 0, spectatorIdsPresent: 0, spectatorIdsLenHistogram: {},
    placeholderNameCount: 0, placeholderPrefixLenHistogram: {},
    categories: { normal: 0, private: 0, diverged_apiId: 0 },
    privateWithRealName: 0, privateWithPlaceholderName: 0,
    examples: { private_realName: [], private_placeholderName: [], diverged_apiId: [], normal: [] }, note: ''
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
    for (const f of dirFiles.filter(x => x.endsWith('.json')).slice(0, perShard)) {
      if (out.filesScanned >= PLAYER_SCAN_CAP) break outer;
      const data = safeRead(path.join(ROOT, 'players', sd, f));
      out.filesScanned++;
      if (data == null || typeof data !== 'object') continue;

      for (const k of Object.keys(data)) bump(out.topLevelKeyUnion, k);
      const fnameId = f.replace(/\.json$/, '');
      bump(out.fnameIdLenHistogram, fnameId.length);
      if (fnameId.length === 36) out.filenameForm.full36++;
      else if (fnameId.length === TRUNC_LEN) out.filenameForm.trunc13++;
      else out.filenameForm.other++;

      const uuidVal = data.uuid != null ? String(data.uuid) : null;
      if (uuidVal != null) { bump(out.uuidFieldLenHistogram, uuidVal.length); (fnameId === uuidVal) ? out.fnameEqualsUuid.yes++ : out.fnameEqualsUuid.no++; }

      if (Object.prototype.hasOwnProperty.call(data, 'private')) {
        out.privateField.present++; bump(out.privateField.typeHistogram, typeof data.private);
        if (data.private === true) out.privateField.trueCount++; else if (data.private === false) out.privateField.falseCount++;
      } else out.privateField.absentButScanned++;

      const hasApiId = Object.prototype.hasOwnProperty.call(data, 'apiId') && !!data.apiId;
      if (hasApiId) out.apiIdPresent++;
      if (Array.isArray(data.spectatorIds)) { out.spectatorIdsPresent++; bump(out.spectatorIdsLenHistogram, data.spectatorIds.length); }

      const name = data.name != null ? String(data.name) : '';
      const isPlaceholder = PLACEHOLDER_RE.test(name);
      if (isPlaceholder) { out.placeholderNameCount++; const m = name.match(/#\s*([0-9a-fA-F-]+)/); if (m) bump(out.placeholderPrefixLenHistogram, m[1].length); }

      const isPrivate = data.private === true;
      if (isPrivate) {
        out.categories.private++;
        if (isPlaceholder) { out.privateWithPlaceholderName++; pushCapped(out.examples.private_placeholderName, { file: `${sd}/${f}`, name, private: data.private, apiId: data.apiId ?? null, keys: Object.keys(data) }, EXAMPLES_PER_CAT); }
        else { out.privateWithRealName++; pushCapped(out.examples.private_realName, { file: `${sd}/${f}`, name, private: data.private, apiId: data.apiId ?? null, keys: Object.keys(data) }, EXAMPLES_PER_CAT); }
      } else { out.categories.normal++; pushCapped(out.examples.normal, { file: `${sd}/${f}`, name, keys: Object.keys(data) }, Math.min(5, EXAMPLES_PER_CAT)); }

      if (hasApiId) {
        out.categories.diverged_apiId++;
        pushCapped(out.examples.diverged_apiId, { file: `${sd}/${f}`, name, uuid: uuidVal, uuidLen: uuidVal ? uuidVal.length : null, apiId: String(data.apiId), apiIdLen: String(data.apiId).length, spectatorIds: data.spectatorIds ?? null, private: data.private ?? null }, EXAMPLES_PER_CAT);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. GAMES + two-mechanism resolution + spectatorIds completeness
// ---------------------------------------------------------------------------
// Resolve a game-side id to a canonical player id using the DOCUMENTED model:
//  - full (36): self (own file) OR alias-hop aliases[trunc13(id)] -> apiId
//  - trunc (13/10): index un-truncation -> full -> file
// Returns { cls, canonicalId } where canonicalId is the resolved api/player id (or null).
function resolveGameSideId(id, aliasMap) {
  const s = String(id), len = s.length;
  if (len === 36) {
    const selfForm = canonicalFileForm(s);
    if (selfForm) return { cls: 'self_own_file_' + selfForm, canonicalId: s };
    const ak = trunc(s, TRUNC_LEN);
    if (aliasMap.has(ak) || aliasMap.has(s)) {
      const target = aliasMap.get(ak) || aliasMap.get(s);
      const form = canonicalFileForm(target);
      if (form) return { cls: 'alias_to_file_' + form, canonicalId: target };
      return { cls: 'alias_target_404', canonicalId: target };
    }
    return { cls: 'unresolved_full', canonicalId: null };
  }
  if (len === TRUNC_LEN || len === LEGACY_LEN) {
    const full = indexResolve(s);
    if (full) { const form = canonicalFileForm(full); if (form) return { cls: 'untrunc_index_to_file_' + form, canonicalId: full }; return { cls: 'untrunc_index_target_404', canonicalId: full }; }
    if (aliasMap.has(s)) { const target = aliasMap.get(s); const form = canonicalFileForm(target); if (form) return { cls: 'alias_trunc_to_file_' + form, canonicalId: target }; return { cls: 'alias_trunc_target_404', canonicalId: target }; }
    return { cls: 'unresolved_trunc', canonicalId: null };
  }
  return { cls: 'unresolved_len' + len, canonicalId: null };
}

function inSpectatorIds(player, gameSideId) {
  if (!player || !Array.isArray(player.spectatorIds)) return null; // null = no field to check against
  const s = String(gameSideId), t = trunc(s, TRUNC_LEN);
  return player.spectatorIds.some(x => { const xs = String(x); return xs === s || xs === t || trunc(xs, TRUNC_LEN) === t; });
}

function buildGamesReport(aliasMap) {
  const out = {
    dirExists: false, seasonFilesSampled: [], topLevelShape: null,
    gameSideIdLenHistogram: {}, pEntryShape: null, hpEntryShape: null,
    distinctGameSideIds: 0, resolution: {},
    spectatorIdsCompleteness: { aliasResolvedTotal: 0, inSpectatorIds: 0, missingFromSpectatorIds: 0, targetHadNoSpectatorIdsField: 0 },
    examplesUnresolved: [], examplesAliasTarget404: [], examplesMissingFromSpectatorIds: [], note: ''
  };
  const files = listDir('games/bv');
  if (!files) { out.note = 'games/bv missing'; return out; }
  out.dirExists = true;
  const seasonFiles = files.filter(f => f.endsWith('.json')).sort();
  const stride = Math.max(1, Math.floor(seasonFiles.length / GAME_FILE_SAMPLE));
  const picked = [];
  for (let i = 0; i < seasonFiles.length && picked.length < GAME_FILE_SAMPLE; i += stride) picked.push(seasonFiles[i]);

  const distinct = new Map(); // id -> source label
  for (const sf of picked) {
    const data = safeRead(path.join(ROOT, 'games/bv', sf));
    if (data == null) continue;
    out.seasonFilesSampled.push(sf);
    const gamesMap = (data.games && typeof data.games === 'object') ? data.games : data;
    if (!out.topLevelShape) out.topLevelShape = (data.games && typeof data.games === 'object') ? 'wrapped: {games:{gid:...}, ...}' : 'flat: {gid:...}';
    let n = 0;
    for (const g of Object.values(gamesMap)) {
      if (n++ >= GAMES_PER_FILE) break;
      if (!g || typeof g !== 'object') continue;
      for (const entry of (g.p || [])) {
        const id = (typeof entry === 'string') ? entry : (entry && entry.id);
        if (!out.pEntryShape) out.pEntryShape = (typeof entry === 'string') ? 'string' : (entry && typeof entry === 'object') ? Object.keys(entry) : null;
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

  const playerCache = {};
  function loadCanonical(canonId) {
    if (canonId == null) return null;
    if (playerCache[canonId] !== undefined) return playerCache[canonId];
    const s = String(canonId), sh = s.slice(0, 2);
    let p = path.join(ROOT, 'players', sh, s + '.json');
    if (!fs.existsSync(p)) p = path.join(ROOT, 'players', sh, s.slice(0, TRUNC_LEN) + '.json');
    const d = fs.existsSync(p) ? safeRead(p) : null;
    playerCache[canonId] = d; return d;
  }

  for (const [id, src] of distinct) {
    const { cls, canonicalId } = resolveGameSideId(id, aliasMap);
    bump(out.resolution, cls);
    if (cls === 'unresolved_full' || cls === 'unresolved_trunc' || cls.startsWith('unresolved_len')) pushCapped(out.examplesUnresolved, { id, idLen: String(id).length, src }, 15);
    if (cls.endsWith('target_404')) pushCapped(out.examplesAliasTarget404, { id, resolvedTo: canonicalId, src }, 15);

    // Completeness check: for ids that reached a canonical file via the ALIAS hop
    // (i.e. genuinely diverged), is the game-side id present in that player's
    // spectatorIds[]? That's what lets StatTrack skip the alias fetch entirely.
    if (cls.startsWith('alias_to_file') || cls.startsWith('alias_trunc_to_file')) {
      out.spectatorIdsCompleteness.aliasResolvedTotal++;
      const player = loadCanonical(canonicalId);
      const member = inSpectatorIds(player, id);
      if (member === null) out.spectatorIdsCompleteness.targetHadNoSpectatorIdsField++;
      else if (member) out.spectatorIdsCompleteness.inSpectatorIds++;
      else { out.spectatorIdsCompleteness.missingFromSpectatorIds++; pushCapped(out.examplesMissingFromSpectatorIds, { gameSideId: id, canonicalId, src, spectatorIds: (player && player.spectatorIds) || null }, 15); }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
function pct(part, whole) { return whole ? ((part / whole) * 100).toFixed(1) + '%' : 'n/a'; }

function main() {
  const alias = buildAliasReport();
  report.aliases = alias.out;
  report.indexes = buildIndexReport();
  report.search  = buildSearchReport();
  report.players = buildPlayerReport();
  report.games   = buildGamesReport(alias.map);

  const P = report.players, A = report.aliases, G = report.games, I = report.indexes, S = report.search;
  const C = G.spectatorIdsCompleteness;
  const L = [];
  L.push('===== StatTrack shape probe =====', '');
  L.push('[1] PLAYER FILES  (scanned ' + P.filesScanned + ' across ' + P.shardDirCount + ' shard dirs)');
  L.push('    filename form             : full36=' + P.filenameForm.full36 + ' trunc13=' + P.filenameForm.trunc13 + ' other=' + P.filenameForm.other);
  L.push('    uuid field length hist    : ' + JSON.stringify(P.uuidFieldLenHistogram) + '  (fname===uuid yes=' + P.fnameEqualsUuid.yes + ' no=' + P.fnameEqualsUuid.no + ')');
  L.push('    `private` present         : ' + P.privateField.present + ' (' + pct(P.privateField.present, P.filesScanned) + ') types=' + JSON.stringify(P.privateField.typeHistogram) + ' | true=' + P.privateField.trueCount + ' false=' + P.privateField.falseCount);
  L.push('    apiId present             : ' + P.apiIdPresent + '   spectatorIds present: ' + P.spectatorIdsPresent + ' (len hist ' + JSON.stringify(P.spectatorIdsLenHistogram) + ')');
  L.push('    placeholder-name count    : ' + P.placeholderNameCount + '  prefix-len hist=' + JSON.stringify(P.placeholderPrefixLenHistogram));
  L.push('    >> private w/ REAL name   : ' + P.privateWithRealName + '   private w/ placeholder name: ' + P.privateWithPlaceholderName);
  L.push('    top-level keys (union)    : ' + JSON.stringify(P.topLevelKeyUnion), '');
  L.push('[2] ALIAS shards');
  L.push('    exists=' + A.dirExists + ' shardCount=' + A.shardCount + ' totalEntries=' + A.totalEntries);
  L.push('    detectedShape=' + A.detectedShape + '  shardingKey=' + A.shardingKey);
  L.push('    key len hist=' + JSON.stringify(A.keyLenHistogram) + '  value len hist=' + JSON.stringify(A.valueLenHistogram));
  L.push('    shard bytes min/median/max=' + JSON.stringify(A.shardByteSizes), '');
  L.push('[3] INDEX shards : exists=' + I.dirExists + ' shardCount=' + I.shardCount + ' shape=' + I.detectedShape + ' keyLenHist=' + JSON.stringify(I.keyLenHistogram), '');
  L.push('[4] SEARCH index : exists=' + S.dirExists + ' entryShape=' + JSON.stringify(S.entryShape) + ' id len hist=' + JSON.stringify(S.idLenHistogram), '');
  L.push('[5] GAMES + DIVERGENCE  (sampled ' + G.seasonFilesSampled.length + ' season files)');
  L.push('    top-level shape           : ' + G.topLevelShape);
  L.push('    p[] entry shape           : ' + JSON.stringify(G.pEntryShape) + '   hp/ap entry shape: ' + JSON.stringify(G.hpEntryShape));
  L.push('    game-side id length hist  : ' + JSON.stringify(G.gameSideIdLenHistogram));
  L.push('    distinct game-side ids    : ' + G.distinctGameSideIds);
  L.push('    resolution breakdown      :');
  const total = G.distinctGameSideIds || 1;
  for (const [k, v] of Object.entries(G.resolution).sort((a, b) => b[1] - a[1])) L.push('        ' + k.padEnd(30) + ' ' + String(v).padStart(7) + '  (' + pct(v, total) + ')');
  L.push('    >> spectatorIds COMPLETENESS (alias-resolved ids only):');
  L.push('        alias-resolved total          : ' + C.aliasResolvedTotal);
  L.push('        game id IN target.spectatorIds: ' + C.inSpectatorIds + '  (' + pct(C.inSpectatorIds, C.aliasResolvedTotal) + ')');
  L.push('        game id MISSING from it       : ' + C.missingFromSpectatorIds + '  (' + pct(C.missingFromSpectatorIds, C.aliasResolvedTotal) + ')');
  L.push('        target had NO spectatorIds fld: ' + C.targetHadNoSpectatorIdsField);
  L.push('        => if MISSING ~0, StatTrack can match games from the loaded file (no alias fetch).');
  if (report.errors.length) { L.push('', 'ERRORS (' + report.errors.length + ') first few:'); report.errors.slice(0, 8).forEach(e => L.push('    - ' + e)); }
  L.push('', 'Full detail (with examples) written to stattrack-shape-probe.json (artifact).');

  const summary = L.join('\n');
  console.log(summary);
  report.summaryText = summary;
  const outPath = path.join(ROOT, 'stattrack-shape-probe.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('\nWrote ' + path.relative(ROOT, outPath));
}

main();
