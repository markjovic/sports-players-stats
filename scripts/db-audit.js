// scripts/db-audit.js
//
// Combined database audit, game report, and repo size report.
// Replaces: db-audit.js, db-report.js, repo-size.js
//
// Usage:
//   node scripts/db-audit.js              — full audit (file/data audit + repo size)
//   node scripts/db-audit.js --no-size    — file/data audit only (sections 1-13), skip repo size
//   node scripts/db-audit.js --size-only  — repo size only (section 14), skip file/data audit
//   node scripts/db-audit.js --verbose    — per-season game breakdown (top 20); only applies
//                                            when the file/data audit runs
//
// --no-size and --size-only are mutually exclusive — together they'd skip everything.

'use strict';

const fs   = require('fs');
const path = require('path');
const { isPlaceholderName } = require('./lib/namespace-resolve.cjs');
const normName = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

const ROOT      = path.join(__dirname, '..');
const ARGS      = new Set(process.argv.slice(2));
const VERBOSE   = ARGS.has('--verbose');
const NO_SIZE   = ARGS.has('--no-size');
const SIZE_ONLY = ARGS.has('--size-only');

if (NO_SIZE && SIZE_ONLY) {
  console.error('❌ --no-size and --size-only are mutually exclusive (combined, they skip the entire audit). Pick one, or neither to run both.');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function fmt(n)      { return Number(n).toLocaleString(); }
function pct(n, d)   { return d === 0 ? '—' : (n / d * 100).toFixed(1) + '%'; }
function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576)    return (b / 1048576).toFixed(2)    + ' MB';
  if (b >= 1024)       return (b / 1024).toFixed(1)       + ' KB';
  return b + ' B';
}

function section(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function row(label, value, note) {
  const lpad = label.padEnd(36, '.');
  const vpad = String(value).padStart(14);
  console.log(`  ${lpad} ${vpad}${note ? '  ' + note : ''}`);
}

function dirSize(dirPath) {
  let total = 0, count = 0;
  if (!fs.existsSync(dirPath)) return { total, count };
  const queue = [dirPath];
  while (queue.length) {
    const cur = queue.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else { total += fs.statSync(full).size; count++; }
    }
  }
  return { total, count };
}

console.log('\n📊 Sports Players Stats — DB Audit');
console.log('═'.repeat(60));
console.log(`  Generated: ${new Date().toISOString()}`);
console.log(`  Mode: ${SIZE_ONLY ? 'repo size only' : NO_SIZE ? 'file/data audit only' : 'full (file/data audit + repo size)'}`);

if (!SIZE_ONLY) {
// ─── 1. sports-index.json ─────────────────────────────────────────────────────

section('1 · sports-index.json');
const sportsIndex = readJSON(path.join(ROOT, 'data', 'sports-index.json'));
if (!sportsIndex) {
  console.log('  ❌ MISSING');
} else {
  const seasons   = Object.values(sportsIndex.seasons || {});
  const locked    = seasons.filter(s => s.locked);
  const active    = seasons.filter(s => !s.locked);
  const activeSids = new Set(active.map(s => s.id));
  const totalGrades = seasons.reduce((a, s) => a + (s.grades ? s.grades.length : 0), 0);
  row('Total seasons',         fmt(seasons.length));
  row('  Locked',              fmt(locked.length));
  row('  Active (not locked)', fmt(active.length));
  row('Total grade entries',   fmt(totalGrades));
}

// ─── 2. Player index files ────────────────────────────────────────────────────

section('2 · players/indexes/{00-ff}.json  (256 shards)');
const indexDir = path.join(ROOT, 'players', 'indexes');
let indexFiles = 0, indexEntries = 0;
const indexMissing = [];

if (fs.existsSync(indexDir)) {
  const files = fs.readdirSync(indexDir).filter(f => f.endsWith('.json'));
  indexFiles = files.length;
  for (const f of files) {
    const data = readJSON(path.join(indexDir, f));
    if (data) indexEntries += Object.keys(data).length;
  }
  for (let i = 0; i < 256; i++) {
    const hex = i.toString(16).padStart(2, '0');
    if (!fs.existsSync(path.join(indexDir, `${hex}.json`))) indexMissing.push(hex);
  }
} else {
  indexMissing.push('DIRECTORY MISSING');
}

row('Index shard files',    fmt(indexFiles),   indexFiles === 256 ? '✅' : `❌ expected 256`);
row('Index entries (UUIDs)', fmt(indexEntries));
if (indexMissing.length) row('Missing shards', indexMissing.length, indexMissing.slice(0, 5).join(', ') + (indexMissing.length > 5 ? '…' : ''));

// ─── 3. Player detail files — FULL SCAN ──────────────────────────────────────

section('3 · players/{00-ff}/{uuid}.json  (detail files — full scan)');
const playersDir = path.join(ROOT, 'players');
let detailCount = 0, processed = 0;
let withStatsChecked = 0, withFoulOuts = 0, foulOutsNonZero = 0;
let withMaxGamePTS = 0, withMaxGameThreePt = 0, withRecords = 0;
let noSportsField = 0, withTeams = 0, withGames = 0;

// Finals stats
let withFinals = 0, withGfApps = 0, withGfWins = 0, withFinalsPerSeason = 0;
let finalsNonZero = 0, gfAppsNonZero = 0, gfWinsNonZero = 0;
let finalsPerSeasonGtOne = 0; // data integrity check — should never happen

// foulOuts integrity
let foulOutsIsObject = 0;       // correct — { seasonId: count }
let foulOutsIsWrongType = 0;    // wrong — number or other

// maxGamePTS / maxGameThreePt breakdown
let maxGamePTSIsNumber = 0, maxGamePTSIsNull = 0;
let maxGameThreePtIsNumber = 0, maxGameThreePtIsNull = 0;

// per-reg stats presence (from seasons[].regs[].stats)
let regsTotal = 0, regsWithGp = 0, regsWithPts = 0;
let regsWithFouls = 0, regsWithThreePt = 0, regsWithFg = 0, regsWithFt = 0;
let regsWithFoulOuts = 0, regsWithFoulOutsGtZero = 0;
let regsWithFinals = 0, regsWithGfApps = 0, regsWithGfWins = 0;

let playersWithSeasons = 0;

// api-canonical migration invariants (2026-07-16) — see section 3b
const fileKeys = new Set();          // every player-file key (filename uuid)
let withApiIdField = 0;              // OLD STRUCTURE: apiId field = not yet folded
const apiIdSample = [];
let uuidFieldMismatch = 0;           // uuid field != filename — hard violation
const uuidMismatchSample = [];
let withSpectatorIds = 0;
let privateTrue = 0;

// player-name quality (publicProfile population + season-name contamination, 2026-07-17)
let nameReal = 0, namePlaceholder = 0, nameMissing = 0;
let seasonNameContaminated = 0; const contaminatedSample = [];
// §B3 name-heal counters — declared HERE with their siblings, not at the reporting
// site: the scan loop below increments them, and a `let` declared after that loop is
// in the temporal dead zone when the loop runs. `node --check` does NOT catch that.
let nameHealGaveUp = 0, nameHealInFlight = 0; const nameHealSample = [];
let privateWithRealName = 0, privateWithPlaceholder = 0;

const shardDirs = fs.existsSync(playersDir)
  ? fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d))
  : [];

row('Shard directories', fmt(shardDirs.length), shardDirs.length === 256 ? '✅' : '❌ expected 256');

for (const shard of shardDirs) {
  const shardPath = path.join(playersDir, shard);
  let files;
  try { files = fs.readdirSync(shardPath).filter(f => f.endsWith('.json')); }
  catch { continue; }
  detailCount += files.length;

  for (const f of files) {
    const p = readJSON(path.join(shardPath, f));
    if (!p) continue;
    processed++;

    if (p.seasons && p.seasons.length > 0) playersWithSeasons++;

    if (p.sports) {
      const bk = p.sports.Basketball;
      if (bk) {
        if (bk.statsChecked !== undefined) withStatsChecked++;
        if (bk.foulOuts !== undefined) {
          withFoulOuts++;
          const hasAny = bk.foulOuts && typeof bk.foulOuts === 'object'
            ? Object.values(bk.foulOuts).some(v => v > 0)
            : typeof bk.foulOuts === 'number' && bk.foulOuts > 0;
          if (hasAny) foulOutsNonZero++;
        }
        if (bk.maxGamePTS !== undefined) {
          withMaxGamePTS++;
          if (typeof bk.maxGamePTS === 'number') maxGamePTSIsNumber++;
          else maxGamePTSIsNull++;
        }
        if (bk.maxGameThreePt !== undefined) {
          withMaxGameThreePt++;
          if (typeof bk.maxGameThreePt === 'number') maxGameThreePtIsNumber++;
          else maxGameThreePtIsNull++;
        }
        if (bk.foulOuts !== undefined) {
          if (bk.foulOuts && typeof bk.foulOuts === 'object' && !Array.isArray(bk.foulOuts)) foulOutsIsObject++;
          else foulOutsIsWrongType++;
        }

        // Finals stats
        if (bk.finals          !== undefined) { withFinals++;         if (bk.finals > 0)          finalsNonZero++; }
        if (bk.gfApps          !== undefined) { withGfApps++;         if (bk.gfApps > 0)           gfAppsNonZero++; }
        if (bk.gfWins          !== undefined) { withGfWins++;         if (bk.gfWins > 0)           gfWinsNonZero++; }
        if (bk.finalsPerSeason !== undefined) {
          withFinalsPerSeason++;
          if (bk.finalsPerSeason > 1) finalsPerSeasonGtOne++; // integrity violation
        }

      }
    } else {
      noSportsField++;
    }
    // api-canonical invariants
    const fileKey = f.slice(0, -5);
    fileKeys.add(fileKey);
    if (typeof p.apiId === 'string' && p.apiId) {
      withApiIdField++;
      if (apiIdSample.length < 10) apiIdSample.push(`${shard}/${fileKey} -> ${p.apiId}`);
    }
    if (typeof p.uuid === 'string' && p.uuid !== fileKey) {
      uuidFieldMismatch++;
      if (uuidMismatchSample.length < 10) uuidMismatchSample.push(`${shard}/${fileKey} has uuid=${p.uuid}`);
    }
    if (Array.isArray(p.spectatorIds) && p.spectatorIds.length) withSpectatorIds++;
    if (p.private === true) privateTrue++;

    // Name quality: real vs placeholder (publicProfile population), and season-name
    // contamination = a non-placeholder name equal to one of the player's own season
    // labels (the old parseProfileStats bug; drains to 0 via repair-season-names.js).
    const nm   = p.name;
    const nmPh = isPlaceholderName(nm);
    if (!nm) nameMissing++;
    if (nmPh) namePlaceholder++; else nameReal++;
    if (!nmPh && (p.seasons || []).some(s => normName(s.sn) === normName(nm))) {
      seasonNameContaminated++;
      if (contaminatedSample.length < 10) contaminatedSample.push(`${shard}/${fileKey} name="${nm}"`);
    }
    if (p.private === true) { if (nmPh) privateWithPlaceholder++; else privateWithRealName++; }

    // OUTSTANDING §B3: fetch-profile-stats.js persists player.nameHealAttempts when
    // its publicProfile name lookup fails, and gives up at NAME_HEAL_MAX_ATTEMPTS (3).
    // Without this row a growing pool of given-up players is invisible — which is
    // exactly how the 34-day "Winter 2026" contamination survived: nothing counted it.
    // in-flight = will be retried next run; gave-up = needs force=true to retry.
    const nha = Number(p.nameHealAttempts) || 0;
    if (nha > 0) {
      if (nha >= 3) {
        nameHealGaveUp++;
        if (nameHealSample.length < 10) nameHealSample.push(`${shard}/${fileKey} attempts=${nha} name=${nm ? `"${nm}"` : '(absent)'}`);
      } else {
        nameHealInFlight++;
      }
    }

    if (p.records !== undefined) withRecords++;
    if (p.teams && p.teams.length > 0) withTeams++;
    if (p.games && p.games.length > 0) withGames++;

    // Per-reg stats scan
    for (const season of (p.seasons || [])) {
      for (const reg of (season.regs || [])) {
        regsTotal++;
        const s = reg.stats || {};
        if (s.gp      !== undefined) regsWithGp++;
        if (s.pts     !== undefined) regsWithPts++;
        if (s.fouls   !== undefined) regsWithFouls++;
        if (s.threePt !== undefined) regsWithThreePt++;
        if (s.fg      !== undefined) regsWithFg++;
        if (s.ft      !== undefined) regsWithFt++;
        if (s.foulOuts !== undefined) {
          regsWithFoulOuts++;
          if (s.foulOuts > 0) regsWithFoulOutsGtZero++;
        }
        if (s.finals  !== undefined) regsWithFinals++;
        if (s.gfApps  !== undefined) regsWithGfApps++;
        if (s.gfWins  !== undefined) regsWithGfWins++;
      }
    }
  }

  if (shardDirs.indexOf(shard) % 32 === 31) {
    process.stderr.write(`  scanning players... ${shardDirs.indexOf(shard) + 1}/256 shards\r`);
  }
}
process.stderr.write('\n');

row('Detail files (count)',      fmt(detailCount));
row('Files successfully parsed', fmt(processed));
row('Players with seasons[]',    fmt(playersWithSeasons), pct(playersWithSeasons, processed));

console.log('\n  ── publicProfileStatistics fields ──');
row('  statsChecked',                fmt(withStatsChecked),       pct(withStatsChecked, processed));
row('  foulOuts present',            fmt(withFoulOuts),           pct(withFoulOuts, processed));
row('    correct type (object)',      fmt(foulOutsIsObject),       pct(foulOutsIsObject, withFoulOuts));
row('    wrong type',                fmt(foulOutsIsWrongType),    foulOutsIsWrongType > 0 ? '❌' : '✅');
row('    with at least one > 0',     fmt(foulOutsNonZero),        pct(foulOutsNonZero, processed));
row('  maxGamePTS present',          fmt(withMaxGamePTS),         pct(withMaxGamePTS, processed));
row('    numeric (has a record)',     fmt(maxGamePTSIsNumber),     pct(maxGamePTSIsNumber, withMaxGamePTS));
row('    null (no record)',           fmt(maxGamePTSIsNull),       pct(maxGamePTSIsNull, withMaxGamePTS));
row('  maxGameThreePt present',      fmt(withMaxGameThreePt),     pct(withMaxGameThreePt, processed));
row('    numeric (has a record)',     fmt(maxGameThreePtIsNumber), pct(maxGameThreePtIsNumber, withMaxGameThreePt));
row('    null (no record)',           fmt(maxGameThreePtIsNull),   pct(maxGameThreePtIsNull, withMaxGameThreePt));
row('  records{}',                   fmt(withRecords),            pct(withRecords, processed));

console.log('\n  ── Per-reg stats (seasons[].regs[].stats) ──');
console.log('  gp/pts/fouls/threePt/fg/ft are written by fetch-profile-stats.js (current, active — every matrix run).');
console.log('  foulOuts/finals/gfApps/gfWins are actively maintained by nightly + build-finals-stats.');
row('  Total regs scanned',               fmt(regsTotal));
row('  gp',                               fmt(regsWithGp),             pct(regsWithGp, regsTotal));
row('  pts',                              fmt(regsWithPts),            pct(regsWithPts, regsTotal));
row('  fouls',                            fmt(regsWithFouls),          pct(regsWithFouls, regsTotal));
row('  threePt',                          fmt(regsWithThreePt),        pct(regsWithThreePt, regsTotal));
row('  fg',                               fmt(regsWithFg),             pct(regsWithFg, regsTotal));
row('  ft',                               fmt(regsWithFt),             pct(regsWithFt, regsTotal));
row('  foulOuts [nightly+matrix]',        fmt(regsWithFoulOuts),       pct(regsWithFoulOuts, regsTotal));
row('    foulOuts > 0',                   fmt(regsWithFoulOutsGtZero), pct(regsWithFoulOutsGtZero, regsWithFoulOuts));
row('  finals  [nightly+build-finals]',   fmt(regsWithFinals),         pct(regsWithFinals, regsTotal));
row('  gfApps  [nightly+build-finals]',   fmt(regsWithGfApps),         pct(regsWithGfApps, regsTotal));
row('  gfWins  [nightly+build-finals]',   fmt(regsWithGfWins),         pct(regsWithGfWins, regsTotal));
console.log('  (regs without finals/gfApps/gfWins = player never appeared in a finals game that season — expected)');

console.log('\n  ── Finals stats (build-finals-stats.js) ──');
row('  finals present',            fmt(withFinals),          pct(withFinals, processed));
row('    with finals > 0',         fmt(finalsNonZero),       pct(finalsNonZero, processed));
row('  gfApps present',            fmt(withGfApps),          pct(withGfApps, processed));
row('    with gfApps > 0',         fmt(gfAppsNonZero),       pct(gfAppsNonZero, processed));
row('  gfWins present',            fmt(withGfWins),          pct(withGfWins, processed));
row('    with gfWins > 0',         fmt(gfWinsNonZero),       pct(gfWinsNonZero, processed));
row('  finalsPerSeason present',   fmt(withFinalsPerSeason), pct(withFinalsPerSeason, processed));
if (finalsPerSeasonGtOne > 0) {
  row('  ❌ finalsPerSeason > 1', fmt(finalsPerSeasonGtOne), '⚠️  should never exceed 1');
} else {
  row('  finalsPerSeason all ≤ 1', '✅', '');
}

console.log('\n  ── Fetch completeness ──');
row('  Fully fetched (statsChecked)',      fmt(withStatsChecked),             pct(withStatsChecked, processed));
row('  No statsChecked',                  fmt(processed - withStatsChecked),  pct(processed - withStatsChecked, processed));
row('  No sports field at all',           fmt(noSportsField),                 pct(noSportsField, processed));
row('  Has teams[] (non-empty)',           fmt(withTeams),                     pct(withTeams, processed));
row('  Has games[] (non-empty)',           fmt(withGames),                     pct(withGames, processed));

// ─── 3b. api-canonical migration invariants (2026-07-16) ─────────────────────
// The 3b-2/3b-3 migration established: one file per person, keyed by api id,
// NO apiId fields; players/aliases maps every spectator id (identity or
// redirect) to its api id; players/indexes keyed 1:1 with files. New
// divergences legitimately pass through an apiId-field state between matrix
// recovery and the fold — so apiId>0 is "pending fold", not corruption, and
// must EQUAL the dangling-alias-target count (same players, two views).

console.log('\n  ── Player names (publicProfile population + season-name contamination) ──');
row('  Real name present',        fmt(nameReal),        pct(nameReal, processed));
row('  Placeholder / missing',    fmt(namePlaceholder), pct(namePlaceholder, processed));
row('    of which name absent',   fmt(nameMissing),     pct(nameMissing, processed));
row('  Season-name contaminated', fmt(seasonNameContaminated),
  seasonNameContaminated === 0 ? '✅ none' : '❌ name == own season label — run repair-season-names.js');
for (const s of contaminatedSample) console.log('      ' + s);
row('  Name-heal retries in flight', fmt(nameHealInFlight),
  nameHealInFlight === 0 ? '✅ none' : 'ℹ️  will retry on the next matrix run');
row('  Name-heal GAVE UP (>=3)',     fmt(nameHealGaveUp),
  nameHealGaveUp === 0 ? '✅ none' : '⚠️  no further attempts — re-dispatch matrix with force=true to retry');
for (const s of nameHealSample) console.log('      ' + s);
if (privateTrue > 0) {
  row('  private w/ real name',   fmt(privateWithRealName),    pct(privateWithRealName, privateTrue));
  row('  private w/ placeholder', fmt(privateWithPlaceholder), pct(privateWithPlaceholder, privateTrue));
}

section('3b · api-canonical migration invariants');

row('Files with apiId field (old structure)', fmt(withApiIdField),
  withApiIdField === 0 ? '✅ invariant holds' : '⚠️  pending fold — verify fold triggers');
for (const s of apiIdSample) console.log(`      ${s}`);
row('uuid field ≠ filename',                fmt(uuidFieldMismatch), uuidFieldMismatch === 0 ? '✅' : '❌ HARD VIOLATION');
for (const s of uuidMismatchSample) console.log(`      ${s}`);
row('Files with spectatorIds[]',            fmt(withSpectatorIds),  pct(withSpectatorIds, processed));
row('private: true',                        fmt(privateTrue),       pct(privateTrue, processed));

// aliases: 256 shards, identity/redirect split, dangling-target scan
const aliasDir = path.join(ROOT, 'players', 'aliases');
let aliasShards = 0, aliasEntries = 0, aliasIdentity = 0, aliasRedirect = 0;
let aliasDangling = 0, aliasBadValue = 0;
const danglingSample = [];
if (fs.existsSync(aliasDir)) {
  for (const f of fs.readdirSync(aliasDir).filter(f => /^[0-9a-f]{2}\.json$/.test(f))) {
    const m = readJSON(path.join(aliasDir, f));
    if (!m) continue;
    aliasShards++;
    for (const [k, v] of Object.entries(m)) {
      aliasEntries++;
      if (typeof v !== 'string' || v.length !== 36) { aliasBadValue++; continue; }
      if (v.slice(0, k.length) === k) aliasIdentity++; else aliasRedirect++;
      if (!fileKeys.has(v)) {
        aliasDangling++;
        if (danglingSample.length < 10) danglingSample.push(`${k} -> ${v}`);
      }
    }
  }
}
row('Alias shard files',        fmt(aliasShards),  aliasShards === 256 ? '✅' : '❌ expected 256');
row('Alias entries',            fmt(aliasEntries));
row('  identity',               fmt(aliasIdentity), pct(aliasIdentity, aliasEntries));
row('  redirect (diverged)',    fmt(aliasRedirect), pct(aliasRedirect, aliasEntries));
row('  bad values',             fmt(aliasBadValue), aliasBadValue === 0 ? '✅' : '❌');
row('  dangling targets (no file)', fmt(aliasDangling),
  // 2026-07-31: the failure hint used to say only "pending fold". Since 07-30 we know
  // a second cause: the fold DELETES a merged-away player file and, until it was fixed,
  // left every other alias pointing at that file dangling (284 of them). Both causes
  // named so the next reader does not assume the first.
  aliasDangling === withApiIdField
    ? `✅ equals apiId-field count`
    : `❌ MUST equal apiId-field count (${fmt(withApiIdField)}) — either a fold is pending, or a fold deleted files without repointing aliases (run fold-diverged-players.yml mode=repoint-only)`);
for (const s of danglingSample) console.log(`      ${s}`);

// alias-inverse: migration artifact — regenerated manually, goes stale by design
const invDir = path.join(ROOT, 'players', 'alias-inverse');
let invShards = 0, invApiIds = 0;
if (fs.existsSync(invDir)) {
  for (const f of fs.readdirSync(invDir).filter(f => /^[0-9a-f]{2}\.json$/.test(f))) {
    const m = readJSON(path.join(invDir, f));
    if (!m) continue;
    invShards++;
    invApiIds += Object.keys(m).length;
  }
  row('alias-inverse api ids', fmt(invApiIds),
    `ℹ️  migration artifact — regenerated manually, expected to lag files (${fmt(detailCount)}) as players are added`);
} else {
  // 2026-07-30: was '❌ MISSING'. players/alias-inverse/ was DELIBERATELY deleted in
  // cleanup fe8eedb — the forward alias map (players/aliases/) is the live structure
  // and is audited above. Absence is the expected state, not a fault.
  row('alias-inverse/', 'ℹ️  absent', 'deliberately removed in cleanup fe8eedb — expected');
}

// index <-> files: both-way set equality (keys, not just counts)
let idxKeysNotFiles = 0, filesNotIdx = 0, idxKeysTotal = 0;
const idxOrphanSample = [], fileOrphanSample = [];
if (fs.existsSync(indexDir)) {
  const seen = new Set();
  for (const f of fs.readdirSync(indexDir).filter(f => /^[0-9a-f]{2}\.json$/.test(f))) {
    const m = readJSON(path.join(indexDir, f));
    if (!m) continue;
    for (const k of Object.keys(m)) {
      idxKeysTotal++;
      seen.add(k);
      if (!fileKeys.has(k)) {
        idxKeysNotFiles++;
        if (idxOrphanSample.length < 10) idxOrphanSample.push(k);
      }
    }
  }
  for (const k of fileKeys) {
    if (!seen.has(k)) {
      filesNotIdx++;
      if (fileOrphanSample.length < 10) fileOrphanSample.push(k);
    }
  }
}
row('Index keys total',                 fmt(idxKeysTotal), idxKeysTotal === detailCount ? '✅ equals detail files' : '⚠️');
row('  index keys with NO file',        fmt(idxKeysNotFiles), idxKeysNotFiles === 0 ? '✅' : '❌');
for (const s of idxOrphanSample) console.log(`      ${s}`);
row('  files with NO index entry',      fmt(filesNotIdx),     filesNotIdx === 0 ? '✅' : '❌');
for (const s of fileOrphanSample) console.log(`      ${s}`);

// ─── 4. games/bv/{seasonId}.json ─────────────────────────────────────────────

section('4 · games/bv/{seasonId}.json');
const gamesDir = path.join(ROOT, 'games', 'bv');
let gameFiles = 0, totalGames = 0;
let gamesNormal = 0, gamesHidden = 0, gamesProfileOnly = 0, gamesLegacy = 0;
let gamesForfeit = 0, gamesCancelled = 0, gamesAbandoned = 0, gamesBye = 0;
let gamesNoProfile = 0, gamesNoVenue = 0;
let gamesWithScore = 0, gamesWithVenue = 0, gamesWithP = 0;
let gamesFinalsRound = 0, gamesGrandFinal = 0;
let stFinal = 0, stUpcoming = 0, stPostponed = 0, stOther = 0, stNone = 0;
let nullScore = 0, flagCollisions = 0, inProgress = 0;
// legacy + score: the flag says "pre-history, nothing further obtainable", so a
// legacy game holding a score contradicts itself. Added 2026-07-31 after a
// measurement found 3,120 of 3,262 legacy games carrying one — invisible to
// every prior audit because flagCollisions only ever tested legacy against other
// FLAGS, never against DATA.
let legacyScored = 0;
const otherStatuses = {};
const seasonBreakdown = [];

const activeSids = sportsIndex
  ? new Set(Object.values(sportsIndex.seasons || {}).filter(s => !s.locked).map(s => s.id))
  : new Set();

if (fs.existsSync(gamesDir)) {
  const files = fs.readdirSync(gamesDir).filter(f => f.endsWith('.json'));
  gameFiles = files.length;
  for (const f of files) {
    const data = readJSON(path.join(gamesDir, f));
    if (!data || !data.games) continue;
    const sid = f.replace('.json', '');
    const isActive = activeSids.has(sid);
    const games = Object.values(data.games);

    for (const g of games) {
      totalGames++;
      if      (g.legacy)      gamesLegacy++;
      else if (g.profileOnly) gamesProfileOnly++;
      else if (g.hidden)      gamesHidden++;
      else if (g.forfeit)     gamesForfeit++;
      else if (g.cancelled)   gamesCancelled++;
      else if (g.abandoned)   gamesAbandoned++;
      else if (g.bye)         gamesBye++;
      else                    gamesNormal++;

      if (g.noProfile) gamesNoProfile++;
      if (g.noVenue)   gamesNoVenue++;
      if (g.hs !== undefined && g.hs !== null) gamesWithScore++;
      if (g.vid)  gamesWithVenue++;
      if (g.p && g.p.length > 0) gamesWithP++;
      if (g.legacy && (g.hidden || g.profileOnly || g.forfeit || g.bye)) flagCollisions++;
      // Same family as the line above, but tested against DATA rather than other
      // flags. hs/as are supplied by discoverFixtureByRound / discoverTeamFixture,
      // so their presence proves a fixture query answered for this game — which
      // is exactly what `legacy` asserts did not happen.
      if (g.legacy && (typeof g.hs === 'number' || typeof g.as === 'number')) legacyScored++;
      if (['LIVE','PRE_GAME','IN_PROGRESS','PENDING'].includes(g.st || '')) inProgress++;
      if (g.hs === null) nullScore++;

      // Finals detection from round name
      const rn = (g.rn || '').toLowerCase();
      if (rn.includes('final')) {
        gamesFinalsRound++;
        if (rn.includes('grand final') || rn === 'gf') gamesGrandFinal++;
      }

      const st = g.st || '';
      if      (st === 'FINAL')    stFinal++;
      else if (st === 'UPCOMING') stUpcoming++;
      else if (st === 'POSTPONED') stPostponed++;
      else if (st === '')         stNone++;
      else if (!['BYE','LIVE','PRE_GAME','IN_PROGRESS','PENDING'].includes(st)) {
        stOther++;
        otherStatuses[st] = (otherStatuses[st] || 0) + 1;
      }
    }

    if (VERBOSE) {
      seasonBreakdown.push({
        id: sid, name: (sportsIndex?.seasons?.[sid]?.name || sid), active: isActive,
        total: games.length,
        scored:   games.filter(g => typeof g.hs === 'number').length,
        hidden:   games.filter(g => g.hidden).length,
        legacy:   games.filter(g => g.legacy).length,
        forfeit:  games.filter(g => g.forfeit).length,
        finals:   games.filter(g => (g.rn||'').toLowerCase().includes('final')).length,
      });
    }
  }
}

row('Season game files',  fmt(gameFiles));
row('Total game entries', fmt(totalGames));

console.log('\n  ── Classification ──');
row('  Normal (no flag)',     fmt(gamesNormal),      pct(gamesNormal, totalGames));
row('  hidden: true',        fmt(gamesHidden),       pct(gamesHidden, totalGames));
row('  profileOnly: true',   fmt(gamesProfileOnly),  pct(gamesProfileOnly, totalGames));
row('  legacy: true',        fmt(gamesLegacy),       pct(gamesLegacy, totalGames));
row('  forfeit: true',       fmt(gamesForfeit),       pct(gamesForfeit, totalGames));
row('  cancelled: true',     fmt(gamesCancelled),     pct(gamesCancelled, totalGames));
row('  abandoned: true',     fmt(gamesAbandoned),     pct(gamesAbandoned, totalGames));
row('  bye: true',           fmt(gamesBye),           pct(gamesBye, totalGames));

console.log('\n  ── Finals rounds ──');
row('  Finals round games',  fmt(gamesFinalsRound),  pct(gamesFinalsRound, totalGames));
row('  Grand Final games',   fmt(gamesGrandFinal),   pct(gamesGrandFinal, totalGames));

console.log('\n  ── Status ──');
row('  FINAL',    fmt(stFinal));
row('  UPCOMING', fmt(stUpcoming));
row('  POSTPONED', fmt(stPostponed));
row('  No status', fmt(stNone));
if (Object.keys(otherStatuses).length > 0) {
  for (const [st, n] of Object.entries(otherStatuses).sort((a,b) => b[1]-a[1])) {
    row(`  ${st}`, fmt(n));
  }
}

console.log('\n  ── Field coverage ──');
row('  Has score',           fmt(gamesWithScore),  pct(gamesWithScore, totalGames));
row('  Has venue (vid)',     fmt(gamesWithVenue),  pct(gamesWithVenue, totalGames));
row('  Has p[] player list', fmt(gamesWithP),      pct(gamesWithP, totalGames));
row('  noProfile flag',      fmt(gamesNoProfile),  pct(gamesNoProfile, totalGames));
row('  noVenue flag',        fmt(gamesNoVenue),    pct(gamesNoVenue, totalGames));
row('  nullScore',           fmt(nullScore),        pct(nullScore, totalGames));
// Both legacy invariants report ALWAYS, not only when non-zero. A check that can
// only ever print a failure is indistinguishable from a check that is not running
// — the same defect that left the keep-list ✅ unreachable until 2026-07-31.
row('  ⚠️  Flag collisions', fmt(flagCollisions),
  flagCollisions === 0 ? '✅ none' : 'legacy + another flag — run find-flag-collisions.yml');
row('  ⚠️  legacy + score', fmt(legacyScored),
  legacyScored === 0 ? '✅ none' : 'flag claims no data obtainable, yet a score is stored — run repair-legacy-flags.yml');

if (VERBOSE && seasonBreakdown.length > 0) {
  console.log('\n  ── Per-season breakdown (top 20 by game count) ──');
  for (const s of seasonBreakdown.sort((a,b) => b.total - a.total).slice(0, 20)) {
    const flag = s.active ? '🟢' : '🔒';
    console.log(`  ${flag} ${s.id}  ${(s.name).padEnd(36)}  total:${fmt(s.total)}  finals:${s.finals}  hidden:${s.hidden}  legacy:${s.legacy}  forfeit:${s.forfeit}`);
  }
}

// ─── 5. search/players shards ─────────────────────────────────────────────────

section('5 · search/players/{xx}.json');
const searchDir = path.join(ROOT, 'search', 'players');
let searchFiles = 0, searchKeys = 0;
let searchValuesAreArrays = true, searchHasBothFormats = false;
let fnSeen = false, snSeen = false;

if (fs.existsSync(searchDir)) {
  const files = fs.readdirSync(searchDir).filter(f => f.endsWith('.json'));
  searchFiles = files.length;
  const step = Math.max(1, Math.floor(files.length / 20));
  for (let i = 0; i < files.length; i++) {
    const data = readJSON(path.join(searchDir, files[i]));
    if (!data) continue;
    const keys = Object.keys(data);
    searchKeys += keys.length;
    if (i % step === 0) {
      for (const [k, v] of Object.entries(data)) {
        if (!Array.isArray(v)) searchValuesAreArrays = false;
        if (!k.includes(',')) fnSeen = true;
        if (k.includes(','))  snSeen = true;
      }
    }
  }
  searchHasBothFormats = fnSeen && snSeen;
}

row('Search shard files',          fmt(searchFiles));
row('Unique search keys',          fmt(searchKeys));
row('Values are arrays',           searchValuesAreArrays ? '✅' : '❌');
row('Both name formats present',   searchHasBothFormats  ? '✅' : '❌');

// ─── 6. leaderboard/ ─────────────────────────────────────────────────────────

section('6 · leaderboard/');
const lbDir     = path.join(ROOT, 'leaderboard');
const lbAllTime = readJSON(path.join(lbDir, 'all-time.json'));
row('all-time.json', lbAllTime ? '✅ present' : '❌ MISSING');
if (lbAllTime) {
  const cats = Object.keys(lbAllTime);
  row('  Categories', cats.length, cats.join(', '));
  for (const cat of cats) {
    const entries = (lbAllTime[cat] || []).length;
    // Integrity check: finalsPerSeason entries should all be ≤ 1
    if (cat === 'finalsPerSeason') {
      const badEntries = (lbAllTime[cat] || []).filter(e => e.v > 1);
      row(`  ${cat}`, fmt(entries), badEntries.length > 0 ? `❌ ${badEntries.length} entries > 1` : '✅ all ≤ 1');
    } else {
      row(`  ${cat}`, fmt(entries));
    }
  }
}
const lbSeasonDir = path.join(lbDir, 'season');
let lbSeasonFiles = 0;
if (fs.existsSync(lbSeasonDir)) {
  const files = fs.readdirSync(lbSeasonDir).filter(f => f.endsWith('.json'));
  lbSeasonFiles = files.length;
  let schemaCheckedPlayersMap = false, schemaCheckedIdvArrays = false;
  for (const f of files) {
    const data = readJSON(path.join(lbSeasonDir, f));
    if (!data) continue;
    if (!schemaCheckedPlayersMap && typeof data.players === 'object' && !Array.isArray(data.players)) schemaCheckedPlayersMap = true;
    for (const [k, v] of Object.entries(data)) {
      if (k === 'players' || !Array.isArray(v)) continue;
      if (v[0]?.id !== undefined) schemaCheckedIdvArrays = true;
    }
  }
  row('season/{seasonId}.json files', fmt(lbSeasonFiles));
  row('  Schema: players map',   schemaCheckedPlayersMap ? '✅' : '❌');
  // 2026-07-30: this assertion was INVERTED. The 2026-07-09 restructure replaced the
  // per-category {id,v} arrays with the `players` map (the change that removed ~922 MB
  // and left leaderboard/ with zero full-length UUIDs — see section 13). Their absence
  // is the goal; their PRESENCE would mean a file predates the restructure.
  row('  Schema: {id,v} arrays', schemaCheckedIdvArrays ? '⚠️  legacy arrays present' : '✅ none (removed 2026-07-09)',
    schemaCheckedIdvArrays ? 'pre-restructure file — should have been migrated' : '');
}

// ─── 7. team-stats files ──────────────────────────────────────────────────────

section('7 · team-stats/bv/{seasonId}.json');
const tsDir = path.join(ROOT, 'team-stats', 'bv');
let tsFiles = 0, tsTeams = 0, tsWithRoster = 0, tsWithFixtures = 0;
if (fs.existsSync(tsDir)) {
  const files = fs.readdirSync(tsDir).filter(f => f.endsWith('.json'));
  tsFiles = files.length;
  for (const f of files.slice(0, 20)) {
    const data = readJSON(path.join(tsDir, f));
    if (!data) continue;
    for (const team of Object.values(data)) {
      tsTeams++;
      if (team.roster && Object.keys(team.roster).length > 0) tsWithRoster++;
      if (team.fixtures && team.fixtures.length > 0) tsWithFixtures++;
    }
  }
}
row('Season files',                      fmt(tsFiles),       tsFiles > 0 ? '✅' : '❌');
row('Teams sampled (first 20 files)',     fmt(tsTeams));
if (tsTeams > 0) {
  row('  With non-empty roster',          fmt(tsWithRoster),   pct(tsWithRoster, tsTeams));
  row('  With fixtures',                  fmt(tsWithFixtures), pct(tsWithFixtures, tsTeams));
}

// ─── 8. venue-lookup ─────────────────────────────────────────────────────────

section('8 · venue-lookup/');
const vlDir = path.join(ROOT, 'venue-lookup');
let vlVenues = 0, vlDateFiles = 0, vlDatesJSON = 0;
const vlNoDatesJSON = [], vlEmpty = [], vlWithDatesOnly = [];

if (fs.existsSync(vlDir)) {
  for (const v of fs.readdirSync(vlDir)) {
    const vPath = path.join(vlDir, v);
    if (!fs.statSync(vPath).isDirectory()) continue;
    vlVenues++;
    const vFiles = fs.readdirSync(vPath);
    const hasDatesJSON = vFiles.includes('dates.json');
    const dateFiles    = vFiles.filter(f => /^\d{4}-\d{2}-\d{2}/.test(f));
    if (hasDatesJSON) vlDatesJSON++;
    vlDateFiles += dateFiles.length;
    if      (vFiles.length === 0)         vlEmpty.push(v);
    else if (!hasDatesJSON)               vlNoDatesJSON.push(v);
    else if (dateFiles.length === 0)      vlWithDatesOnly.push(v);
  }
}

row('Total venue directories',              fmt(vlVenues));
row('  Legitimate (dates.json + dates)',    fmt(vlVenues - vlNoDatesJSON.length - vlEmpty.length - vlWithDatesOnly.length), vlNoDatesJSON.length === 0 && vlEmpty.length === 0 ? '✅' : '⚠️');
row('  dates.json files present',           fmt(vlDatesJSON));
row('  Date schedule files total',          fmt(vlDateFiles));
row('  Empty directories',                  fmt(vlEmpty.length),       vlEmpty.length      ? '⚠️' : '✅');
row('  No dates.json (anomalous)',           fmt(vlNoDatesJSON.length), vlNoDatesJSON.length ? '⚠️' : '✅');
row('  dates.json only (no date files)',     fmt(vlWithDatesOnly.length), vlWithDatesOnly.length ? '⚠️' : '✅');

// ─── 9. date-venue-index ─────────────────────────────────────────────────────

section('9 · date-venue-index/{YYYY-MM-DD}.json');
const dviDir = path.join(ROOT, 'date-venue-index');
let dviFiles = 0;
if (fs.existsSync(dviDir)) {
  dviFiles = fs.readdirSync(dviDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).length;
}
row('Date-venue index files', fmt(dviFiles));

// ─── 10. data/ index files ────────────────────────────────────────────────────
// Moved from ROOT to data/ in the June 2026 migration (see section 1, which
// already correctly reads data/sports-index.json). This section previously
// checked ROOT directly and reported all four as MISSING every run — they were
// never missing, just checked at their pre-migration location.

section('10 · data/ index files');
for (const f of ['sports-index.json','team-index.json','venue-index.json','season-venue-index.json']) {
  const p = path.join(ROOT, 'data', f);
  if (!fs.existsSync(p)) { row(f, '❌ MISSING'); continue; }
  const data = readJSON(p);
  if (!data) { row(f, '❌ PARSE ERROR'); continue; }
  const count   = Array.isArray(data) ? data.length : Object.keys(data).length;
  const topKeys = Array.isArray(data) ? 'array' : Object.keys(data).slice(0, 3).join(', ') + '…';
  row(f, fmt(count) + ' entries', `✅  keys: ${topKeys}`);
}

// ─── 11. Misc JSON files ──────────────────────────────────────────────────────

section('11 · Misc files');
const miscFiles = [
  ['data/forfeit-games.json',    null,  true],  // count grows over time — not baselined (moved under data/ June 2026)
  ['records/all-time.json',      null,  true],
  // 2026-07-30: was `false` ("should be deleted") — WRONG, and it was the last
  // surviving copy of a claim already retracted in three docs. nightly-crawl.yml's
  // status step reads this file's LENGTH for stats_rechecks; deleting it makes
  // recheck counts read 0. It is a live working file, so neither presence nor
  // absence is a fault. `null` = informational, no expectation either way.
  // A retracted claim living in code is invisible to every doc grep — which is
  // exactly why this one outlived its own correction.
  ['needs-matrix-shards.json',   null,  null],
  ['matrix-force-pending.json',  null,  false],  // should not exist
  ['reports/rekey-apply-cache.json', null, false],  // 3b-2 migration checkpoint — delete when convenient
];
for (const [f, expected, shouldExist] of miscFiles) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) {
    if (shouldExist === false)     row(f, '✅ absent', '');
    else if (shouldExist === null) row(f, 'ℹ️  absent', 'live working file — absent is normal between cycles');
    else                           row(f, '❌ MISSING');
    continue;
  }
  if (shouldExist === false) { row(f, '⚠️  exists', 'should be deleted'); continue; }
  const data = readJSON(p);
  const count = Array.isArray(data) ? data.length : (data ? Object.keys(data).length : '?');
  if (shouldExist === null) {
    row(f, fmt(count) + ' entries', 'ℹ️  live working file — NOT residue, do not delete');
    continue;
  }
  const note  = expected != null ? (count === expected ? `✅ expected ${fmt(expected)}` : `⚠️  expected ${fmt(expected)}`) : '';
  row(f, fmt(count) + ' entries', note);
}

// ─── 11b. Repo hygiene (added 2026-07-16) ─────────────────────────────────────
// FILE AGES REMOVED 2026-08-02 (OUTSTANDING §2.4). `git checkout` sets mtime to
// checkout time, so on a CI runner EVERY file is always "0d old" — the column
// only ever meant something on a persistent working tree, which is nowhere any
// more. The doc's alternative (git log -1 --format=%ct -- <path>) is no better
// here: db-audit.yml checks out fetch-depth:1, so git sees ONE commit and every
// file would report the same age — the same lie with a different constant.
// Replaced with file SIZE, which statSync reports truthfully regardless of how
// the tree arrived, and which is the actionable number for residue anyway.
// SELF-CLEANUP RULE: any script writing a progress/checkpoint file must delete
// it on successful completion. A dotfile-json at rest in scripts/ is therefore
// either a run in progress, a script that failed to self-clean, or an ORPHAN
// whose owning script was deleted. All are flagged; orphans by name-match.
// reports/ policy: a small permanent keep-list (migration record); everything
// else is a completed investigation's output and should leave with its script.

section('11b · Repo hygiene');

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// scripts/ dotfile-json scan — orphan = no scripts/<stem>.js for .<stem>-progress.json
{
  const scriptsDir = path.join(ROOT, 'scripts');
  const jsSet = new Set(fs.readdirSync(scriptsDir).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)));
  const dotJsons = fs.readdirSync(scriptsDir).filter(f => f.startsWith('.') && f.endsWith('.json'));
  if (dotJsons.length === 0) {
    row('scripts/ dotfile-json files', '✅ none', 'all owners self-cleaned');
  } else {
    for (const f of dotJsons) {
      const stem = f.replace(/^\./, '').replace(/-progress\.json$/, '').replace(/\.json$/, '');
      const owner = jsSet.has(stem) ? stem + '.js' : null;
      const size = fs.statSync(path.join(scriptsDir, f)).size;
      row(`scripts/${f}`, humanSize(size),
        owner ? `⚠️  owner ${owner} exists — mid-run, or failed to self-clean`
              : '❌ ORPHAN — owning script deleted; safe to remove');
    }
  }
}

// reports/ keep-list policy
{
  const reportsDir = path.join(ROOT, 'reports');
  const KEEP = new Set([
    'rekey-apply-log.json',        // permanent migration record; rebuild-player-index depends on it
    'rekey-merges.json',           // the reviewed 3b-2 plan
    'rebuild-player-index.json',
    'rekey-enrich-report.json',
    'rekey-flagged-classified.json',
    'fold-diverged.json',          // live, regenerated each fold
    // Added 2026-07-31. These are EVIDENCE, not leftovers — each is the only
    // surviving record of a measurement or incident this project still cites.
    // Flagging them every run trains you to skim §11b, which is how a real
    // warning gets missed.
    'uuid-collisions-len10.json',      // the measurement behind TRUNC_LEN = 13
                                       // (10 chars = 9 hex digits, ~36 bits,
                                       // ~63% collision odds at ~370k players).
                                       // Delete it and the justification for the
                                       // current truncation length becomes folklore.
    'git-history-recovery-report.json',// record of the 30,426-game recovery
    'season-name-contamination.json',  // the 40,034-file contamination baseline;
                                       // still cited, and the "0 contaminated"
                                       // re-scan that superseded it was WRONG
    'unresolved-prefix-diagnosis.json',// resolver diagnostics, same class
  ]);
  if (fs.existsSync(reportsDir)) {
    let kept = 0, review = 0;
    for (const f of fs.readdirSync(reportsDir)) {
      const p = path.join(reportsDir, f);
      const isDir = fs.statSync(p).isDirectory();
      if (!isDir && KEEP.has(f)) { kept++; continue; }
      review++;
      // Directories get an entry-count instead of a byte size — a dir's own
      // statSync size is filesystem noise, not content.
      const label = isDir ? `${fs.readdirSync(p).length} entries` : humanSize(fs.statSync(p).size);
      row(`reports/${f}${isDir ? '/' : ''}`, label, '⚠️  not on keep-list — delete with its script');
    }
    // 2026-07-31: the old condition was `kept === KEEP.size - (fold-diverged ? 0 : 1)`,
    // which assumed every keep-list entry always exists on disk. Once the list grew to
    // 10 and only 8 were present it could never show ✅ — an unreachable success state
    // is just noise. Now it names WHICH are absent, which is the actionable part
    // (e.g. rebuild-player-index depends on rekey-apply-log.json being there).
    const missingKeep = [...KEEP].filter(f => !fs.existsSync(path.join(reportsDir, f)));
    row('reports/ keep-list files present', `${kept}/${KEEP.size}`,
      missingKeep.length ? `ℹ️  absent: ${missingKeep.join(', ')}` : '✅ all present');
  }
}

// repo-root stray scripts — .js belongs in scripts/
{
  const rootJs = fs.readdirSync(ROOT).filter(f => f.endsWith('.js'));
  if (rootJs.length === 0) row('root-level .js files', '✅ none');
  else for (const f of rootJs) row(`ROOT/${f}`, '⚠️  exists', 'scripts belong in scripts/ — delete or move');
}

// ─── 12. Summary ───────────────────────────────────────────────────────────────

section('12 · Summary (current counts — not baselined)');
// Every metric below grows continuously via the nightly crawl and discovery —
// there is no "expected" fixed value for any of them without a deliberate
// schema migration changing what's counted. Reported as current state only.
console.log(`  Player index entries................  ${fmt(indexEntries)}`);
console.log(`  Player detail files.................  ${fmt(detailCount)}`);
console.log(`  Total game entries..................  ${fmt(totalGames)}`);
console.log(`  Players with finals > 0.............  ${fmt(finalsNonZero)}  (${pct(finalsNonZero, processed)} of players)`);
console.log(`  statsChecked present................  ${fmt(withStatsChecked)}  (${pct(withStatsChecked, processed)} — remainder are confirmed private/inaccessible)`);
console.log('');
console.log(`  Seasons in sports-index.............  ${fmt(sportsIndex ? Object.values(sportsIndex.seasons||{}).length : 0)}`);
console.log(`  Finals round games...................  ${fmt(gamesFinalsRound)}`);
console.log(`  Grand Final games....................  ${fmt(gamesGrandFinal)}`);
console.log(`  Venue dirs...........................  ${fmt(vlVenues)}`);
console.log(`  Date-venue index files...............  ${fmt(dviFiles)}`);
console.log(`  Leaderboard season files.............  ${fmt(lbSeasonFiles)}`);
console.log(`  Game files (bv/).....................  ${fmt(gameFiles)}`);
console.log(`  Team-stats files (bv/)...............  ${fmt(tsFiles)}`);
console.log('');

// Genuinely structural checks — things that SHOULD be constant regardless of
// DB growth, unlike the counts above. Sections 2 and 3 already flag shard-count
// mismatches (should always be 256); this just re-confirms both agree.
const structuralOk = indexFiles === 256 && shardDirs.length === 256
  && uuidFieldMismatch === 0 && idxKeysNotFiles === 0 && filesNotIdx === 0
  && aliasShards === 256 && aliasBadValue === 0
  && aliasDangling === withApiIdField;
console.log(structuralOk
  ? '  ✅ Structural invariants OK (256+256 shards, uuid==filename, index<->files 1:1, aliases consistent).'
  : '  ⚠️  Structural invariant mismatch — see sections 2, 3 and 3b above.');
if (withApiIdField > 0) {
  console.log(`  ⚠️  ${fmt(withApiIdField)} file(s) pending fold (apiId field present) — normal between matrix recovery and fold; investigate if it persists across cycles.`);
}

// ─── 13. UUID storage footprint ───────────────────────────────────────────────
// Measures every place a FULL 36-char UUID is stored as a repeated data value
// (not a filename/directory — players/{shard}/{uuid}.json already encodes it
// for free, and player.uuid is already stripped from the file body, June 2026).
// §13 (UUID storage footprint) REMOVED 2026-07-31. It measured how much space a
// full-length -> 13-char UUID migration would save. That question is CLOSED: the
// final measurement was 57.61 MB on a 6.13 GB repo (0.9%), with leaderboard/ holding
// ZERO full-length UUIDs — so the migration was rejected as not worth touching every
// exact-string consumer. See OUTSTANDING §D7 and REPO_MANIFEST §6.11 for the number.
// Removing it also deleted a full extra scan of team-stats/ (2,896 files, 916 MB)
// that existed only for the byte tally, plus per-item counting in the games, search
// and leaderboard loops.

} // end: if (!SIZE_ONLY) — file/data audit (sections 1-13)

// ─── 14. Repo size ────────────────────────────────────────────────────────────

if (!NO_SIZE) {
  section('14 · Repo size');
  const entries = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules');

  const rows = [];
  let repoTotal = 0, repoCount = 0;
  for (const entry of entries) {
    const full = path.join(ROOT, entry.name);
    if (entry.isDirectory()) {
      const { total, count } = dirSize(full);
      rows.push({ name: entry.name + '/', size: total, count, isDir: true });
      repoTotal += total; repoCount += count;
    } else {
      const size = fs.statSync(full).size;
      rows.push({ name: entry.name, size, count: 1, isDir: false });
      repoTotal += size; repoCount++;
    }
  }
  rows.sort((a, b) => b.size - a.size);

  console.log(`\n  ${'Name'.padEnd(32)} ${'Size'.padStart(10)}  ${'Files'.padStart(8)}  % of repo`);
  console.log('  ' + '─'.repeat(58));
  for (const r of rows) {
    const icon = r.isDir ? '📂' : '📄';
    console.log(`  ${icon} ${r.name.padEnd(30)} ${fmtBytes(r.size).padStart(10)}  ${r.count.toLocaleString().padStart(8)}  ${pct(r.size, repoTotal)}`);
  }
  console.log('  ' + '─'.repeat(58));
  console.log(`  ${'TOTAL'.padEnd(32)} ${fmtBytes(repoTotal).padStart(10)}  ${repoCount.toLocaleString().padStart(8)}`);

  // Sub-breakdown for large dirs (>100MB)
  const largeDirs = rows.filter(r => r.isDir && r.size > 100 * 1024 * 1024);
  for (const dir of largeDirs) {
    const dirPath = path.join(ROOT, dir.name.replace(/\/$/, ''));
    const subRows = [];
    for (const sub of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, sub.name);
      if (sub.isDirectory()) {
        const { total, count } = dirSize(full);
        subRows.push({ name: sub.name + '/', size: total, count });
      } else {
        subRows.push({ name: sub.name, size: fs.statSync(full).size, count: 1 });
      }
    }
    subRows.sort((a, b) => b.size - a.size);
    console.log(`\n  📂 ${dir.name} breakdown (top 10):`);
    console.log('  ' + '─'.repeat(52));
    for (const sub of subRows.slice(0, 10)) {
      console.log(`    ${sub.name.padEnd(30)} ${fmtBytes(sub.size).padStart(10)}  ${pct(sub.size, dir.size)}`);
    }
  }
}

console.log('\n' + '═'.repeat(60));
console.log('  ✅ Audit complete');
console.log('═'.repeat(60) + '\n');
