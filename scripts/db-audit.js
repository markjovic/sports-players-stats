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
row('  gfWins  [nightly+build-finals]',   fmt(regsWithGfWins),         pct(regsWithGfWins, regsTotal));

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
const otherStatuses = {};
const seasonBreakdown = [];

// UUID footprint — counts every full-length UUID string instance in p[]/hp[]/ap[]
// and what it would cost at a truncated length instead (same precedent already
// used for private-profile display names: 10-char prefix, zero collisions
// confirmed at 369k players).
let uuidInstancesGames = 0, uuidBytesGamesFull = 0;
const TRUNC_LEN = 10;

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
      if (['LIVE','PRE_GAME','IN_PROGRESS','PENDING'].includes(g.st || '')) inProgress++;
      if (g.hs === null) nullScore++;

      // UUID footprint: p[].id, hp[].profileID, ap[].profileID
      for (const uuidField of [
        ...(g.p  || []).map(x => x && x.id),
        ...(g.hp || []).map(x => x && x.profileID),
        ...(g.ap || []).map(x => x && x.profileID),
      ]) {
        if (typeof uuidField === 'string' && uuidField.length > TRUNC_LEN) {
          uuidInstancesGames++;
          uuidBytesGamesFull += Buffer.byteLength(uuidField, 'utf8');
        }
      }

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
if (flagCollisions > 0) row('  ⚠️  Flag collisions', fmt(flagCollisions), 'legacy + another flag');

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
let uuidInstancesSearch = 0, uuidBytesSearchFull = 0;

if (fs.existsSync(searchDir)) {
  const files = fs.readdirSync(searchDir).filter(f => f.endsWith('.json'));
  searchFiles = files.length;
  const step = Math.max(1, Math.floor(files.length / 20));
  for (let i = 0; i < files.length; i++) {
    const data = readJSON(path.join(searchDir, files[i]));
    if (!data) continue;
    const keys = Object.keys(data);
    searchKeys += keys.length;
    for (const v of Object.values(data)) {
      for (const entry of (Array.isArray(v) ? v : [])) {
        if (entry && typeof entry.id === 'string' && entry.id.length > TRUNC_LEN) {
          uuidInstancesSearch++;
          uuidBytesSearchFull += Buffer.byteLength(entry.id, 'utf8');
        }
      }
    }
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
let uuidInstancesLb = 0, uuidBytesLbFull = 0;
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
    for (const e of (lbAllTime[cat] || [])) {
      if (e && typeof e.uuid === 'string' && e.uuid.length > TRUNC_LEN) {
        uuidInstancesLb++;
        uuidBytesLbFull += Buffer.byteLength(e.uuid, 'utf8');
      }
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
    // players map keys are "uuid|tid" — the uuid portion is full-length
    for (const key of Object.keys(data.players || {})) {
      const uuidPart = key.split('|')[0];
      if (uuidPart && uuidPart.length > TRUNC_LEN) {
        uuidInstancesLb++;
        uuidBytesLbFull += Buffer.byteLength(uuidPart, 'utf8');
      }
    }
    for (const [k, v] of Object.entries(data)) {
      if (k === 'players' || !Array.isArray(v)) continue;
      if (v[0]?.id !== undefined) schemaCheckedIdvArrays = true;
      for (const e of v) {
        if (e && typeof e.id === 'string') {
          const uuidPart = e.id.split('|')[0];
          if (uuidPart.length > TRUNC_LEN) {
            uuidInstancesLb++;
            uuidBytesLbFull += Buffer.byteLength(uuidPart, 'utf8');
          }
        }
      }
    }
  }
  row('season/{seasonId}.json files', fmt(lbSeasonFiles));
  row('  Schema: players map',   schemaCheckedPlayersMap ? '✅' : '❌');
  row('  Schema: {id,v} arrays', schemaCheckedIdvArrays  ? '✅' : '❌');
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

// Full scan (all files, not just the 20-file sample above) for accurate UUID byte
// tallying — roster is keyed by full player UUID.
let uuidInstancesTs = 0, uuidBytesTsFull = 0;
if (fs.existsSync(tsDir)) {
  for (const f of fs.readdirSync(tsDir).filter(f => f.endsWith('.json'))) {
    const data = readJSON(path.join(tsDir, f));
    if (!data) continue;
    for (const team of Object.values(data)) {
      for (const uuid of Object.keys(team.roster || {})) {
        if (uuid.length > TRUNC_LEN) {
          uuidInstancesTs++;
          uuidBytesTsFull += Buffer.byteLength(uuid, 'utf8');
        }
      }
    }
  }
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
  ['needs-matrix-shards.json',   null,  false],
  ['matrix-force-pending.json',  null,  false],  // should not exist
];
for (const [f, expected, shouldExist] of miscFiles) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) {
    if (shouldExist === false) row(f, '✅ absent', '');
    else row(f, '❌ MISSING');
    continue;
  }
  if (shouldExist === false) { row(f, '⚠️  exists', 'should be deleted'); continue; }
  const data = readJSON(p);
  const count = Array.isArray(data) ? data.length : (data ? Object.keys(data).length : '?');
  const note  = expected != null ? (count === expected ? `✅ expected ${fmt(expected)}` : `⚠️  expected ${fmt(expected)}`) : '';
  row(f, fmt(count) + ' entries', note);
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
const structuralOk = indexFiles === 256 && shardDirs.length === 256;
console.log(structuralOk
  ? '  ✅ Structural invariants OK (256 index shards, 256 player-detail shard dirs).'
  : '  ⚠️  Structural invariant mismatch — see sections 2 and 3 above.');

// ─── 13. UUID storage footprint ───────────────────────────────────────────────
// Measures every place a FULL 36-char UUID is stored as a repeated data value
// (not a filename/directory — players/{shard}/{uuid}.json already encodes it
// for free, and player.uuid is already stripped from the file body, June 2026).
// Compares against the cost at a 10-char prefix — the same precedent already in
// production for private-profile display names (zero collisions confirmed at
// 369k players). This is a measurement only; no migration is applied here.

section('13 · UUID storage footprint (full-length vs 10-char-prefix)');
const uuidSources = [
  ['games/ (p[].id, hp[]/ap[].profileID)', uuidInstancesGames, uuidBytesGamesFull],
  ['leaderboard/ (uuid, uuid|tid keys/ids)', uuidInstancesLb,    uuidBytesLbFull],
  ['team-stats/ (roster keys)',              uuidInstancesTs,    uuidBytesTsFull],
  ['search/ (id field)',                     uuidInstancesSearch, uuidBytesSearchFull],
];
let grandInstances = 0, grandBytesFull = 0;
for (const [label, instances, bytesFull] of uuidSources) {
  const bytesTrunc = instances * TRUNC_LEN;
  const savings = bytesFull - bytesTrunc;
  grandInstances += instances;
  grandBytesFull += bytesFull;
  row(label, fmt(instances) + ' instances', `${fmtBytes(bytesFull)} → ${fmtBytes(bytesTrunc)} if truncated (saves ${fmtBytes(savings)})`);
}
console.log('');
const grandBytesTrunc = grandInstances * TRUNC_LEN;
row('TOTAL', fmt(grandInstances) + ' instances', `${fmtBytes(grandBytesFull)} → ${fmtBytes(grandBytesTrunc)} (saves ${fmtBytes(grandBytesFull - grandBytesTrunc)})`);
console.log('  Note: this is JSON-content bytes, not repo-on-disk bytes (git compression,');
console.log('  whitespace, and history all differ). Treat as a lower-bound signal for');
console.log('  which directories are worth a truncation migration, not a final size delta.');
console.log('  A truncation migration would need every consumer that does exact-string');
console.log('  UUID matching on these fields updated in the same pass — not attempted here.');
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
