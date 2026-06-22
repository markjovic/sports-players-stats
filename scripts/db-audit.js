// scripts/db-audit.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function fmt(n) { return Number(n).toLocaleString(); }
function pct(n, d) { return d === 0 ? '0.0%' : (n / d * 100).toFixed(1) + '%'; }

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

// ─── 1. sports-index.json ───────────────────────────────────────────────────

section('1 · sports-index.json');
const sportsIndex = readJSON(path.join(ROOT, 'sports-index.json'));
if (!sportsIndex) {
  console.log('  ❌ MISSING');
} else {
  const seasons = Object.values(sportsIndex.seasons || {});
  const locked = seasons.filter(s => s.locked);
  const active = seasons.filter(s => !s.locked);
  const withGrades = seasons.filter(s => s.grades && s.grades.length > 0);
  const totalGrades = seasons.reduce((a, s) => a + (s.grades ? s.grades.length : 0), 0);
  row('Total seasons', fmt(seasons.length));
  row('  Locked', fmt(locked.length));
  row('  Active (not locked)', fmt(active.length));
  row('  With grades array', fmt(withGrades.length));
  row('Total grade entries', fmt(totalGrades));
}

// ─── 2. Player index files ──────────────────────────────────────────────────

section('2 · players/indexes/{00-ff}.json  (256 shards)');
const indexDir = path.join(ROOT, 'players', 'indexes');
let indexFiles = 0;
let indexEntries = 0;
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

row('Index shard files', fmt(indexFiles), indexFiles === 256 ? '✅' : `❌ expected 256`);
row('Index entries (UUIDs)', fmt(indexEntries));
if (indexMissing.length) {
  row('Missing shards', indexMissing.length,
      indexMissing.slice(0, 5).join(', ') + (indexMissing.length > 5 ? '…' : ''));
}

// ─── 3. Player detail files — FULL SCAN ─────────────────────────────────────

section('3 · players/{00-ff}/{uuid}.json  (detail files — full scan)');
const playersDir = path.join(ROOT, 'players');
let detailCount = 0;
let withStatsChecked = 0;
let withFoulOuts = 0;
let withMaxGamePTS = 0;
let withMaxGameThreePt = 0;
let withRecords = 0;
let noSportsField = 0;
let withTeams = 0;
let withTeamsUpdatedAt = 0;

// foulOuts breakdown: players where foulOuts > 0 vs present but zero
let foulOutsNonZero = 0;

const shardDirs = fs.existsSync(playersDir)
  ? fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d))
  : [];

row('Shard directories', fmt(shardDirs.length), shardDirs.length === 256 ? '✅' : '❌ expected 256');

let processed = 0;
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

    if (p.sports) {
      const bk = p.sports.Basketball;
      if (bk) {
        if (bk.statsChecked !== undefined) withStatsChecked++;
        if (bk.foulOuts !== undefined) {
          withFoulOuts++;
          // foulOuts is an object keyed by seasonId — check if any season has > 0
          if (bk.foulOuts && typeof bk.foulOuts === 'object') {
            const hasAny = Object.values(bk.foulOuts).some(v =>
              typeof v === 'number' ? v > 0
              : typeof v === 'object' && v !== null && Object.values(v).some(x => x > 0)
            );
            if (hasAny) foulOutsNonZero++;
          } else if (typeof bk.foulOuts === 'number' && bk.foulOuts > 0) {
            foulOutsNonZero++;
          }
        }
        if (bk.maxGamePTS     !== undefined) withMaxGamePTS++;
        if (bk.maxGameThreePt !== undefined) withMaxGameThreePt++;
      }
    } else {
      noSportsField++;
    }
    if (p.records !== undefined) withRecords++;
    if (p.teams && p.teams.length > 0) withTeams++;
    if (p.teamsUpdatedAt) withTeamsUpdatedAt++;
  }

  if (shardDirs.indexOf(shard) % 32 === 31) {
    process.stderr.write(`  scanning players... ${shardDirs.indexOf(shard) + 1}/256 shards\r`);
  }
}
process.stderr.write('\n');

row('Detail files (count)', fmt(detailCount));
row('Files successfully parsed', fmt(processed));

console.log('\n  ── Field presence (FULL SCAN — all ' + fmt(processed) + ' players) ──');
row('  sports.Basketball.statsChecked', fmt(withStatsChecked),
    pct(withStatsChecked, processed));
row('  sports.Basketball.foulOuts', fmt(withFoulOuts),
    pct(withFoulOuts, processed));
row('    foulOuts with at least one > 0', fmt(foulOutsNonZero),
    pct(foulOutsNonZero, processed));
row('    foulOuts present but all zero', fmt(withFoulOuts - foulOutsNonZero),
    pct(withFoulOuts - foulOutsNonZero, processed));
row('  sports.Basketball.maxGamePTS', fmt(withMaxGamePTS),
    pct(withMaxGamePTS, processed));
row('  sports.Basketball.maxGameThreePt', fmt(withMaxGameThreePt),
    pct(withMaxGameThreePt, processed));
row('  records (maxGamePTS + maxGameThreePt)', fmt(withRecords),
    pct(withRecords, processed));
row('  No sports field at all', fmt(noSportsField),
    pct(noSportsField, processed));
row('  Has teams[] (non-empty)', fmt(withTeams),
    pct(withTeams, processed));
row('  Has teamsUpdatedAt', fmt(withTeamsUpdatedAt),
    pct(withTeamsUpdatedAt, processed));

console.log('\n  ── Fetch completeness ──');
const fullyFetched   = withStatsChecked;           // statsChecked = proof of complete fetch
const partialFetched = withFoulOuts - withStatsChecked; // has foulOuts but no statsChecked
const notFetched     = processed - withFoulOuts;   // neither field present
row('  Fully fetched (has statsChecked)', fmt(fullyFetched),
    pct(fullyFetched, processed));
row('  Partially fetched (foulOuts, no statsChecked)', fmt(partialFetched),
    pct(partialFetched, processed));
row('  Not fetched at all', fmt(notFetched),
    pct(notFetched, processed));

// ─── 4. games/bv/{seasonId}.json ───────────────────────────────────────────

section('4 · games/bv/{seasonId}.json');
const gamesDir = path.join(ROOT, 'games', 'bv');
let gameFiles = 0;
let totalGames = 0;
let gamesNormal = 0, gamesHidden = 0, gamesProfileOnly = 0, gamesLegacy = 0;
let gamesForfeit = 0, gamesCancelled = 0, gamesAbandoned = 0, gamesBye = 0;
let gamesNoProfile = 0, gamesNoVenue = 0;
let gamesWithScore = 0, gamesWithVenue = 0, gamesWithP = 0, gamesWithGid = 0;
let gamesEmptyGid = 0;

if (fs.existsSync(gamesDir)) {
  const files = fs.readdirSync(gamesDir).filter(f => f.endsWith('.json'));
  gameFiles = files.length;
  for (const f of files) {
    const data = readJSON(path.join(gamesDir, f));
    if (!data || !data.games) continue;
    for (const g of Object.values(data.games)) {
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
      if (g.vid)                               gamesWithVenue++;
      if (g.p && g.p.length > 0)              gamesWithP++;
      if (g.gid !== undefined) {
        if (g.gid === '') gamesEmptyGid++;
        else              gamesWithGid++;
      }
    }
  }
}

row('Season game files', fmt(gameFiles));
row('Total game entries', fmt(totalGames));
console.log('\n  ── Classification (mutually exclusive) ──');
row('  Normal (no flag)', fmt(gamesNormal),       pct(gamesNormal, totalGames));
row('  hidden: true', fmt(gamesHidden),           pct(gamesHidden, totalGames));
row('  profileOnly: true', fmt(gamesProfileOnly), pct(gamesProfileOnly, totalGames));
row('  legacy: true', fmt(gamesLegacy),           pct(gamesLegacy, totalGames));
row('  forfeit: true', fmt(gamesForfeit),          pct(gamesForfeit, totalGames));
row('  cancelled: true', fmt(gamesCancelled),      pct(gamesCancelled, totalGames));
row('  abandoned: true', fmt(gamesAbandoned),      pct(gamesAbandoned, totalGames));
row('  bye: true', fmt(gamesBye),                 pct(gamesBye, totalGames));
console.log('\n  ── Retry flags ──');
row('  noProfile: <ts>', fmt(gamesNoProfile), pct(gamesNoProfile, totalGames));
row('  noVenue: <ts>', fmt(gamesNoVenue),     pct(gamesNoVenue, totalGames));
console.log('\n  ── Field coverage ──');
row('  Has score (hs not null/undef)', fmt(gamesWithScore), pct(gamesWithScore, totalGames));
row('  Has venue (vid present)', fmt(gamesWithVenue),       pct(gamesWithVenue, totalGames));
row('  Has p[] player list', fmt(gamesWithP),               pct(gamesWithP, totalGames));
row('  Has gid (resolved grade)', fmt(gamesWithGid),        pct(gamesWithGid, totalGames));
row('  gid is empty string', fmt(gamesEmptyGid),            pct(gamesEmptyGid, totalGames));

// ─── 5. search/players shards ───────────────────────────────────────────────

section('5 · search/players/{xx}.json');
const searchDir = path.join(ROOT, 'search', 'players');
let searchFiles = 0, searchKeys = 0;
if (fs.existsSync(searchDir)) {
  const files = fs.readdirSync(searchDir).filter(f => f.endsWith('.json'));
  searchFiles = files.length;
  for (const f of files) {
    const data = readJSON(path.join(searchDir, f));
    if (data) searchKeys += Object.keys(data).length;
  }
}
row('Search shard files', fmt(searchFiles));
row('Unique search keys', fmt(searchKeys));

// ─── 6. leaderboard files ───────────────────────────────────────────────────

section('6 · leaderboard/');
const lbDir     = path.join(ROOT, 'leaderboard');
const lbAllTime = readJSON(path.join(lbDir, 'all-time.json'));
row('all-time.json', lbAllTime ? '✅ present' : '❌ MISSING');
if (lbAllTime) {
  const cats = Object.keys(lbAllTime);
  row('  Categories', cats.join(', '));
  for (const cat of cats) row(`  ${cat} entries`, fmt((lbAllTime[cat] || []).length));
}
const lbSeasonDir = path.join(lbDir, 'season');
let lbSeasonFiles = 0;
if (fs.existsSync(lbSeasonDir)) {
  lbSeasonFiles = fs.readdirSync(lbSeasonDir).filter(f => f.endsWith('.json')).length;
}
row('season/{seasonId}.json files', fmt(lbSeasonFiles));

// ─── 7. team-stats files ────────────────────────────────────────────────────

section('7 · team-stats/bv/{seasonId}.json');
const tsDir = path.join(ROOT, 'team-stats', 'bv');
let tsFiles = 0, tsTeams = 0, tsWithRoster = 0;
if (fs.existsSync(tsDir)) {
  const files = fs.readdirSync(tsDir).filter(f => f.endsWith('.json'));
  tsFiles = files.length;
  for (const f of files.slice(0, 20)) {
    const data = readJSON(path.join(tsDir, f));
    if (!data) continue;
    for (const team of Object.values(data)) {
      tsTeams++;
      if (team.roster && Object.keys(team.roster).length > 0) tsWithRoster++;
    }
  }
}
row('Season files', fmt(tsFiles));
row('Teams sampled (first 20 files)', fmt(tsTeams));
if (tsTeams > 0) row('  With non-empty roster', fmt(tsWithRoster), pct(tsWithRoster, tsTeams));

// ─── 8. venue-lookup — FULL INVESTIGATION ───────────────────────────────────

section('8 · venue-lookup/  (full investigation)');
const vlDir = path.join(ROOT, 'venue-lookup');
let vlVenues = 0, vlDateFiles = 0, vlDatesJSON = 0;

// Categories for the extra directories
const vlWithDatesOnly    = [];  // has dates.json, no date files — shouldn't exist
const vlExpected         = [];  // has dates.json + date files — legitimate venue
const vlNoDatesJSON      = [];  // no dates.json — the anomaly
const vlEmpty            = [];  // completely empty directory

if (fs.existsSync(vlDir)) {
  const vDirs = fs.readdirSync(vlDir);
  vlVenues = vDirs.length;
  for (const v of vDirs) {
    const vPath = path.join(vlDir, v);
    if (!fs.statSync(vPath).isDirectory()) continue;
    const vFiles = fs.readdirSync(vPath);
    const hasDatesJSON = vFiles.includes('dates.json');
    const dateFiles    = vFiles.filter(f => /^\d{4}-\d{2}-\d{2}/.test(f));

    if (hasDatesJSON) vlDatesJSON++;
    vlDateFiles += dateFiles.length;

    if (vFiles.length === 0)         vlEmpty.push(v);
    else if (!hasDatesJSON)          vlNoDatesJSON.push({ id: v, files: vFiles.length, sample: vFiles.slice(0, 3) });
    else if (dateFiles.length === 0) vlWithDatesOnly.push(v);
    else                             vlExpected.push(v);
  }
}

row('Total venue directories', fmt(vlVenues));
row('  Legitimate (dates.json + date files)', fmt(vlExpected.length),
    vlExpected.length === 532 ? '✅' : `⚠️  expected 532`);
row('  dates.json files present', fmt(vlDatesJSON), vlDatesJSON === 532 ? '✅' : '⚠️');
row('  Date schedule files', fmt(vlDateFiles));
row('  Empty directories', fmt(vlEmpty.length), vlEmpty.length ? '⚠️' : '✅');
row('  NO dates.json (anomalous)', fmt(vlNoDatesJSON.length), vlNoDatesJSON.length ? '⚠️  SEE BELOW' : '✅');
row('  dates.json only (no date files)', fmt(vlWithDatesOnly.length), vlWithDatesOnly.length ? '⚠️' : '✅');

if (vlNoDatesJSON.length > 0) {
  console.log('\n  ── Anomalous directories (no dates.json) ──');
  console.log(`  Total: ${vlNoDatesJSON.length}`);
  // Show first 20, with their file counts and sample filenames
  for (const d of vlNoDatesJSON.slice(0, 20)) {
    const sampleStr = d.sample.join(', ') + (d.files > 3 ? ` … (+${d.files - 3} more)` : '');
    console.log(`    ${d.id}  [${d.files} file(s)]  ${sampleStr}`);
  }
  if (vlNoDatesJSON.length > 20) {
    console.log(`    … and ${vlNoDatesJSON.length - 20} more`);
  }

  // Check if any of the anomalous dir names look like venue IDs vs something else
  const uuidLike = vlNoDatesJSON.filter(d => /^[0-9a-f]{8}-/.test(d.id));
  const shortHex = vlNoDatesJSON.filter(d => /^[0-9a-f]{8}$/.test(d.id));
  const other    = vlNoDatesJSON.filter(d => !/^[0-9a-f]{8}/.test(d.id));
  console.log(`\n  ── Anomalous dir name patterns ──`);
  row('  UUID-format (xxxxxxxx-xxxx-…)', fmt(uuidLike.length));
  row('  Short hex (8 chars)', fmt(shortHex.length));
  row('  Other format', fmt(other.length));
  if (other.length > 0) {
    console.log('  Other format examples: ' + other.slice(0, 5).map(d => d.id).join(', '));
  }
}

if (vlEmpty.length > 0) {
  console.log('\n  ── Empty directories ──');
  console.log('  ' + vlEmpty.slice(0, 10).join(', ') + (vlEmpty.length > 10 ? '…' : ''));
}

// ─── 9. date-venue-index ────────────────────────────────────────────────────

section('9 · date-venue-index/{YYYY-MM-DD}.json');
const dviDir = path.join(ROOT, 'date-venue-index');
let dviFiles = 0;
if (fs.existsSync(dviDir)) {
  dviFiles = fs.readdirSync(dviDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).length;
}
row('Date-venue index files', fmt(dviFiles));

// ─── 10. Root index files ────────────────────────────────────────────────────

section('10 · Root index files');
const rootIndexFiles = [
  'sports-index.json',
  'team-index.json',
  'venue-index.json',
  'season-venue-index.json',
];
for (const f of rootIndexFiles) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { row(f, '❌ MISSING'); continue; }
  const data = readJSON(p);
  if (!data) { row(f, '❌ PARSE ERROR'); continue; }
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  const topKeys = Array.isArray(data) ? 'array' : Object.keys(data).slice(0, 3).join(', ') + '…';
  row(f, fmt(count) + ' entries', `✅  top-level: ${topKeys}`);
}

// ─── 11. publicProfileStatistics coverage ───────────────────────────────────

section('11 · publicProfileStatistics coverage');
console.log('');
console.log('  Fields only populated by publicProfileStatistics:');
console.log('    • foulOuts       — foul-out count per season/team/grade reg');
console.log('    • maxGamePTS     — single-game career points record');
console.log('    • maxGameThreePt — single-game career 3PT record');
console.log('    • statsChecked   — ISO timestamp of last successful fetch');
console.log('');
row('Fully fetched (statsChecked present)', fmt(withStatsChecked),
    pct(withStatsChecked, processed));
row('Partially written (foulOuts, no statsChecked)', fmt(withFoulOuts - withStatsChecked),
    pct(withFoulOuts - withStatsChecked, processed));
row('Not fetched at all', fmt(processed - withFoulOuts),
    pct(processed - withFoulOuts, processed));
console.log('');
const pctFetched = processed > 0 ? (withStatsChecked / processed * 100).toFixed(1) : '0.0';
console.log(`  Coverage: ${pctFetched}% of players have been fully fetched.`);
if (withStatsChecked < processed) {
  const remaining = processed - withStatsChecked;
  console.log(`  ${remaining.toLocaleString()} players still need fetching (no statsChecked).`);
  console.log('  Run fetch-profile-stats-matrix.yml to complete the bootstrap.');
} else {
  console.log('  ✅ Bootstrap complete — all players have been fetched.');
}

// ─── 12. Summary vs baseline ─────────────────────────────────────────────────

section('12 · Summary vs documented baseline (June 2026)');
console.log('');
const baseline = [
  ['Seasons in sports-index',   sportsIndex ? Object.values(sportsIndex.seasons||{}).length : 0, 2792],
  ['Player index entries',       indexEntries,   369428],
  ['Player detail files',        detailCount,    369437],
  ['Total game entries',         totalGames,     2247971],
  ['Search shard files',         searchFiles,    595],
  ['Search unique keys',         searchKeys,     595879],
  ['Venue dirs (legit)',          vlExpected.length, 532],
  ['dates.json files',           vlDatesJSON,    532],
  ['Date-venue index files',     dviFiles,       2016],
  ['Leaderboard season files',   lbSeasonFiles,  2793],
  ['game files (bv/)',           gameFiles,      2792],
  ['team-stats files (bv/)',     tsFiles,        2792],
];

let allGood = true;
for (const [label, actual, expected] of baseline) {
  const match  = actual === expected;
  const icon   = match ? '✅' : (actual > 0 ? '⚠️ ' : '❌');
  if (!match) allGood = false;
  const diff    = actual - expected;
  const diffStr = diff === 0 ? '' : (diff > 0 ? ` (+${fmt(diff)})` : ` (${fmt(diff)})`);
  row(label, fmt(actual), `${icon} expected ${fmt(expected)}${diffStr}`);
}
console.log('');
console.log(allGood
  ? '  ✅ All counts match baseline.'
  : '  ⚠️  One or more counts differ from baseline — review above.');
console.log('');
