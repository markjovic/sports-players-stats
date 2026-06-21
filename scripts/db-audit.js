// scripts/db-audit.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ─── helpers ────────────────────────────────────────────────────────────────

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

// ─── 3. Player detail files ─────────────────────────────────────────────────

section('3 · players/{00-ff}/{uuid}.json  (detail files)');
const playersDir = path.join(ROOT, 'players');
let detailCount = 0;
let sampleTotal = 0;
let withStatsChecked = 0;
let withFoulOuts = 0;
let withMaxGamePTS = 0;
let noSportsField = 0;
let withTeams = 0;
let withTeamsUpdatedAt = 0;

const shardDirs = fs.existsSync(playersDir)
  ? fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d))
  : [];

row('Shard directories', fmt(shardDirs.length), shardDirs.length === 256 ? '✅' : '❌ expected 256');

// Count all detail files across all shards (directory listing only — fast)
for (const shard of shardDirs) {
  const shardPath = path.join(playersDir, shard);
  try {
    const files = fs.readdirSync(shardPath).filter(f => f.endsWith('.json'));
    detailCount += files.length;
  } catch { /* skip */ }
}
row('Detail files (count)', fmt(detailCount));

// Deep sample: read first 4 shards fully for field-presence stats
const sampleShards = shardDirs.slice(0, 4);
for (const shard of sampleShards) {
  const shardPath = path.join(playersDir, shard);
  const files = fs.readdirSync(shardPath).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const p = readJSON(path.join(shardPath, f));
    if (!p) continue;
    sampleTotal++;
    if (p.sports) {
      const bk = p.sports.Basketball;
      if (bk) {
        if (bk.statsChecked !== undefined) withStatsChecked++;
        if (bk.foulOuts !== undefined)     withFoulOuts++;
        if (bk.maxGamePTS !== undefined)   withMaxGamePTS++;
      }
    } else {
      noSportsField++;
    }
    if (p.teams && p.teams.length > 0)  withTeams++;
    if (p.teamsUpdatedAt)               withTeamsUpdatedAt++;
  }
}

if (sampleTotal > 0) {
  console.log(`\n  ── Field presence (sample: first 4 shards, n=${fmt(sampleTotal)}) ──`);
  row('  sports.Basketball.statsChecked', fmt(withStatsChecked),
      pct(withStatsChecked, sampleTotal) + ' of sample');
  row('  sports.Basketball.foulOuts', fmt(withFoulOuts),
      pct(withFoulOuts, sampleTotal) + ' of sample');
  row('  sports.Basketball.maxGamePTS', fmt(withMaxGamePTS),
      pct(withMaxGamePTS, sampleTotal) + ' of sample');
  row('  No sports field at all', fmt(noSportsField),
      pct(noSportsField, sampleTotal) + ' of sample');
  row('  Has teams[] (non-empty)', fmt(withTeams),
      pct(withTeams, sampleTotal) + ' of sample');
  row('  Has teamsUpdatedAt', fmt(withTeamsUpdatedAt),
      pct(withTeamsUpdatedAt, sampleTotal) + ' of sample');
}

// ─── 4. games/bv/{seasonId}.json ───────────────────────────────────────────

section('4 · games/bv/{seasonId}.json');
const gamesDir = path.join(ROOT, 'games', 'bv');
let gameFiles = 0;
let totalGames = 0;
let gamesNormal = 0;
let gamesHidden = 0;
let gamesProfileOnly = 0;
let gamesLegacy = 0;
let gamesForfeit = 0;
let gamesCancelled = 0;
let gamesAbandoned = 0;
let gamesBye = 0;
let gamesNoProfile = 0;
let gamesNoVenue = 0;
let gamesWithScore = 0;
let gamesWithVenue = 0;
let gamesWithP = 0;
let gamesWithGid = 0;
let gamesEmptyGid = 0;

if (fs.existsSync(gamesDir)) {
  const files = fs.readdirSync(gamesDir).filter(f => f.endsWith('.json'));
  gameFiles = files.length;
  for (const f of files) {
    const data = readJSON(path.join(gamesDir, f));
    if (!data || !data.games) continue;
    for (const g of Object.values(data.games)) {
      totalGames++;
      // mutually exclusive primary classification
      if      (g.legacy)      gamesLegacy++;
      else if (g.profileOnly) gamesProfileOnly++;
      else if (g.hidden)      gamesHidden++;
      else if (g.forfeit)     gamesForfeit++;
      else if (g.cancelled)   gamesCancelled++;
      else if (g.abandoned)   gamesAbandoned++;
      else if (g.bye)         gamesBye++;
      else                    gamesNormal++;
      // additive retry flags
      if (g.noProfile) gamesNoProfile++;
      if (g.noVenue)   gamesNoVenue++;
      // field coverage
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
row('  Normal (no flag)', fmt(gamesNormal),      pct(gamesNormal, totalGames));
row('  hidden: true', fmt(gamesHidden),          pct(gamesHidden, totalGames));
row('  profileOnly: true', fmt(gamesProfileOnly),pct(gamesProfileOnly, totalGames));
row('  legacy: true', fmt(gamesLegacy),          pct(gamesLegacy, totalGames));
row('  forfeit: true', fmt(gamesForfeit),         pct(gamesForfeit, totalGames));
row('  cancelled: true', fmt(gamesCancelled),     pct(gamesCancelled, totalGames));
row('  abandoned: true', fmt(gamesAbandoned),     pct(gamesAbandoned, totalGames));
row('  bye: true', fmt(gamesBye),                pct(gamesBye, totalGames));

console.log('\n  ── Retry flags (additive, independent of classification) ──');
row('  noProfile: <ts>', fmt(gamesNoProfile), pct(gamesNoProfile, totalGames));
row('  noVenue: <ts>', fmt(gamesNoVenue),     pct(gamesNoVenue, totalGames));

console.log('\n  ── Field coverage ──');
row('  Has score (hs not null/undef)', fmt(gamesWithScore), pct(gamesWithScore, totalGames));
row('  Has venue (vid present)', fmt(gamesWithVenue),       pct(gamesWithVenue, totalGames));
row('  Has p[] player list', fmt(gamesWithP),               pct(gamesWithP, totalGames));
row('  Has gid (resolved grade)', fmt(gamesWithGid),        pct(gamesWithGid, totalGames));
row('  gid is empty string', fmt(gamesEmptyGid),            pct(gamesEmptyGid, totalGames));

// ─── 5. search/players shards ───────────────────────────────────────────────

section('5 · search/players/{xx}.json  (player search shards)');
const searchDir = path.join(ROOT, 'search', 'players');
let searchFiles = 0;
let searchKeys  = 0;
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
  for (const cat of cats) {
    row(`  ${cat} entries`, fmt((lbAllTime[cat] || []).length));
  }
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
let tsFiles    = 0;
let tsTeams    = 0;
let tsWithRoster = 0;
if (fs.existsSync(tsDir)) {
  const files = fs.readdirSync(tsDir).filter(f => f.endsWith('.json'));
  tsFiles = files.length;
  // Sample first 20 files for team/roster presence
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

// ─── 8. venue-lookup ────────────────────────────────────────────────────────

section('8 · venue-lookup/');
const vlDir = path.join(ROOT, 'venue-lookup');
let vlVenues    = 0;
let vlDateFiles = 0;
let vlDatesJSON = 0;
if (fs.existsSync(vlDir)) {
  const vDirs = fs.readdirSync(vlDir);
  vlVenues = vDirs.length;
  for (const v of vDirs) {
    const vPath = path.join(vlDir, v);
    if (!fs.statSync(vPath).isDirectory()) continue;
    const vFiles = fs.readdirSync(vPath);
    if (vFiles.includes('dates.json')) vlDatesJSON++;
    vlDateFiles += vFiles.filter(f => /^\d{4}-\d{2}-\d{2}/.test(f)).length;
  }
}
row('Venue directories', fmt(vlVenues));
row('dates.json files', fmt(vlDatesJSON));
row('Date schedule files', fmt(vlDateFiles));

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

// ─── 11. publicProfileStatistics fetch status ───────────────────────────────

section('11 · publicProfileStatistics coverage (THE missing piece)');
console.log('');
console.log('  These three fields are ONLY populated by publicProfileStatistics.');
console.log('  They are absent from every other data source and pipeline step.');
console.log('');
const fetchPct = sampleTotal > 0 ? (withStatsChecked / sampleTotal) : 0;
const estFetched  = Math.round(fetchPct * indexEntries);
const estUnfetched = indexEntries - estFetched;
row('Players with statsChecked (est.)', fmt(estFetched),   pct(estFetched, indexEntries));
row('Players WITHOUT statsChecked (est.)', fmt(estUnfetched), pct(estUnfetched, indexEntries));
console.log('');
console.log('  What we are missing per-player:');
console.log('    • foulOuts  — foul-out count per season/team/grade registration');
console.log('    • maxGamePTS / maxGameThreePt — single-game career records');
console.log('    • statsChecked — ISO timestamp of last successful profile fetch');
console.log('');
console.log('  What the broken script DID prove:');
console.log('    • ~67% of players have accessible public profiles');
console.log('    • The Cloudflare Worker proxy is live and functional');
console.log('    • The failure is positional (pos 11+) — not UUID-specific, not WAF');
console.log('    • dry-run (no file I/O) still fails → the issue is in script init');

// ─── 12. Summary vs documented baseline ─────────────────────────────────────

section('12 · Summary vs documented baseline (June 2026)');
console.log('');

const baseline = [
  ['Seasons in sports-index',   sportsIndex ? Object.values(sportsIndex.seasons||{}).length : 0, 2792],
  ['Player index entries',       indexEntries,    369428],
  ['Player detail files',        detailCount,     369437],
  ['Total game entries',         totalGames,      2247971],
  ['Search shard files',         searchFiles,     595],
  ['Search unique keys',         searchKeys,      595879],
  ['Venue directories',          vlVenues,        532],
  ['dates.json files',           vlDatesJSON,     532],
  ['Date-venue index files',     dviFiles,        2016],
  ['Leaderboard season files',   lbSeasonFiles,   2793],
  ['game files (bv/)',           gameFiles,       2792],
  ['team-stats files (bv/)',     tsFiles,         2792],
];

let allGood = true;
for (const [label, actual, expected] of baseline) {
  const match = actual === expected;
  const icon  = match ? '✅' : (actual > 0 ? '⚠️ ' : '❌');
  if (!match) allGood = false;
  const diff    = actual - expected;
  const diffStr = diff === 0 ? '' : (diff > 0 ? ` (+${fmt(diff)})` : ` (${fmt(diff)})`);
  row(label, fmt(actual), `${icon} expected ${fmt(expected)}${diffStr}`);
}
console.log('');
if (allGood) {
  console.log('  ✅ All counts match baseline. Database is fully intact.');
} else {
  console.log('  ⚠️  One or more counts differ from baseline. Review above.');
}
console.log('');
