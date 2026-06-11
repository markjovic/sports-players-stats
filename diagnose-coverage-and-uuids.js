#!/usr/bin/env node
// diagnose-coverage-and-uuids.js
'use strict';

const fs   = require('fs');
const path = require('path');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const TENANT        = ARGS.tenant      || 'bv';
const SAMPLE_SEASON = ARGS.season      || null;   // limit to one season for speed
const UUID_SAMPLE   = parseInt(ARGS['uuid-sample'] || '50000', 10);

const GAMES_DIR   = path.join(__dirname, 'games', TENANT);
const PLAYERS_DIR = path.join(__dirname, 'players');
const INDEX_FILE  = path.join(__dirname, 'sports-index.json');

console.log('\n🔬 Coverage & UUID Diagnostic');
console.log('═'.repeat(60));
console.log(`  Generated: ${new Date().toISOString()}`);
if (SAMPLE_SEASON) console.log(`  Season filter: ${SAMPLE_SEASON}`);
console.log();

// ─── Load index ───────────────────────────────────────────────────────────────

const index   = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
const seasons = index.seasons || {};

// ─── Phase 0: Population reconciliation ──────────────────────────────────────
// Three populations:
//   A — Player index (players-index/{xx}.json) — career stats entries
//   B — Player detail files (players/{xx}/{uuid}.json) — full history files
//   C — Player UUIDs referenced in playerGames across all game files

console.log('📋 PHASE 0 — Player Population Reconciliation');
console.log('─'.repeat(50));

// A — Player index
const PLAYERS_IDX = path.join(__dirname, 'players-index');
const indexUUIDs  = new Set();
if (fs.existsSync(PLAYERS_IDX)) {
  for (const f of fs.readdirSync(PLAYERS_IDX).filter(f => f.endsWith('.json'))) {
    try {
      const shard = JSON.parse(fs.readFileSync(path.join(PLAYERS_IDX, f), 'utf8'));
      for (const uuid of Object.keys(shard)) indexUUIDs.add(uuid);
    } catch (e) {}
  }
}
console.log(`  A — Player index entries:    ${indexUUIDs.size.toLocaleString()}`);

// B — Player detail files
const detailUUIDs = new Set();
if (fs.existsSync(PLAYERS_DIR)) {
  for (const shard of fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/i.test(d))) {
    try {
      for (const f of fs.readdirSync(path.join(PLAYERS_DIR, shard)).filter(f => f.endsWith('.json'))) {
        detailUUIDs.add(f.replace('.json', ''));
      }
    } catch (e) {}
  }
}
console.log(`  B — Player detail files:     ${detailUUIDs.size.toLocaleString()}`);

// C — Player UUIDs in playerGames across all game files
console.log(`  C — Scanning game files for playerGames UUIDs...`);
const gamePlayerUUIDs = new Set();
const gameFiles0 = fs.existsSync(GAMES_DIR)
  ? fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'))
  : [];
const targetFiles0 = SAMPLE_SEASON
  ? gameFiles0.filter(f => f === `${SAMPLE_SEASON}.json`)
  : gameFiles0;
for (const file of targetFiles0) {
  let sg;
  try { sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8')); } catch (e) { continue; }
  for (const uuid of Object.keys(sg.playerGames || {})) gamePlayerUUIDs.add(uuid);
}
console.log(`  C — UUIDs in playerGames:    ${gamePlayerUUIDs.size.toLocaleString()}`);

// Cross-checks
const inIndexNotDetail   = [...indexUUIDs].filter(u => !detailUUIDs.has(u));
const inDetailNotIndex   = [...detailUUIDs].filter(u => !indexUUIDs.has(u));
const inGamesNotDetail   = [...gamePlayerUUIDs].filter(u => !detailUUIDs.has(u));
const inGamesNotIndex    = [...gamePlayerUUIDs].filter(u => !indexUUIDs.has(u));
const inDetailNotGames   = [...detailUUIDs].filter(u => !gamePlayerUUIDs.has(u));
const inAllThree         = [...detailUUIDs].filter(u => indexUUIDs.has(u) && gamePlayerUUIDs.has(u));

console.log('\n  Cross-checks:');
console.log(`  In index but NOT in detail files:   ${inIndexNotDetail.length.toLocaleString()} ← index entries with no detail file`);
console.log(`  In detail files but NOT in index:   ${inDetailNotIndex.length.toLocaleString()} ← detail files with no index entry`);
console.log(`  In playerGames but NOT detail files:${inGamesNotDetail.length.toLocaleString()} ← players referenced in games but never crawled`);
console.log(`  In playerGames but NOT index:       ${inGamesNotIndex.length.toLocaleString()} ← players in games but no career stats`);
console.log(`  In detail files but NOT playerGames:${inDetailNotGames.length.toLocaleString()} ← crawled players with no game references`);
console.log(`  In all three (A ∩ B ∩ C):           ${inAllThree.length.toLocaleString()} ← fully consistent entries`);

// Sample the gaps
if (inIndexNotDetail.length > 0) {
  console.log(`\n  Sample — in index, no detail file (up to 5):`);
  for (const u of inIndexNotDetail.slice(0, 5)) console.log(`    ${u}`);
}
if (inGamesNotDetail.length > 0) {
  console.log(`\n  Sample — in playerGames, no detail file (up to 5):`);
  for (const u of inGamesNotDetail.slice(0, 5)) console.log(`    ${u}`);
}
if (inDetailNotGames.length > 0) {
  console.log(`\n  Sample — detail file exists, not in any playerGames (up to 5):`);
  for (const u of inDetailNotGames.slice(0, 5)) console.log(`    ${u}`);
}

console.log('\n');

// ─── Phase 1: UUID Structure & Segment Analysis ──────────────────────────────
// Sample up to UUID_SAMPLE player detail files.
// UUID format: seg1-seg2-seg3-seg4-seg5  (8-4-4-4-12 chars)
// Checks:
//   - Standard v4 format confirmation
//   - Version / variant bit distribution
//   - Per-segment uniqueness — does any segment repeat across players?
//     Repeated segments suggest semantic encoding (org, family, comp, team)
//   - Segment co-occurrence — do players sharing seg1 also share other fields?
//   - Collision rate at various truncation lengths for display ID shortening
//   - Private player UUID structure vs public

console.log('👤 PHASE 1 — UUID Structure & Segment Analysis');
console.log('─'.repeat(50));

const shards = fs.existsSync(PLAYERS_DIR)
  ? fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/i.test(d))
  : [];

let uuidsSampled = 0;
let privateCount = 0;
let v4Count = 0, nonV4Count = 0;
const versionCounts  = {};
const variantCounts  = {};

// Per-segment frequency maps — key: segment value, value: count
// UUID: seg1(8)-seg2(4)-seg3(4)-seg4(4)-seg5(12)
const segFreq = [ new Map(), new Map(), new Map(), new Map(), new Map() ];
const segNames = ['seg1(8)', 'seg2(4)', 'seg3(4)', 'seg4(4)', 'seg5(12)'];

// Co-occurrence: for each seg1 value that appears >1 time,
// record which players share it — then look up their club/team to find pattern
// Map: seg1 → [{ uuid, name, club, team }]
const seg1Players = new Map();

// Collision analysis at different truncation lengths (bare UUID no hyphens)
const prefixSets = { 4: new Set(), 6: new Set(), 8: new Set(), 10: new Set(), 12: new Set() };
const collisions = { 4: 0, 6: 0, 8: 0, 10: 0, 12: 0 };
const totalForLen = { 4: 0, 6: 0, 8: 0, 10: 0, 12: 0 };

// Private player samples
const privateSamples = []; // { uuid, name }

const v4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

outer:
for (const shard of shards) {
  const shardDir = path.join(PLAYERS_DIR, shard);
  let files;
  try { files = fs.readdirSync(shardDir).filter(f => f.endsWith('.json')); } catch (e) { continue; }

  for (const file of files) {
    if (uuidsSampled >= UUID_SAMPLE) break outer;
    const uuid = file.replace('.json', '');
    let player;
    try { player = JSON.parse(fs.readFileSync(path.join(shardDir, file), 'utf8')); } catch (e) { continue; }

    uuidsSampled++;

    const isPrivate = !player.name || player.name === '' || player.private === true;
    if (isPrivate) {
      privateCount++;
      if (privateSamples.length < 10) privateSamples.push({ uuid, name: player.name || '' });
    }

    // v4 format check
    const isV4 = v4Regex.test(uuid);
    if (isV4) v4Count++; else nonV4Count++;

    // Version / variant bits
    const bare = uuid.replace(/-/g, '');
    const versionChar = bare[12];
    const variantChar = bare[16];
    versionCounts[versionChar] = (versionCounts[versionChar] || 0) + 1;
    variantCounts[variantChar] = (variantCounts[variantChar] || 0) + 1;

    // Split into 5 segments and track frequency of each
    const segs = uuid.split('-'); // [8, 4, 4, 4, 12]
    for (let i = 0; i < 5; i++) {
      const s = segs[i];
      segFreq[i].set(s, (segFreq[i].get(s) || 0) + 1);
    }

    // Track seg1 co-occurrence for semantic analysis
    const s1 = segs[0];
    if (!seg1Players.has(s1)) seg1Players.set(s1, []);
    // Only keep entries where seg1 repeats (trim to save memory — cap at 5 per seg1)
    const arr = seg1Players.get(s1);
    if (arr.length < 5) {
      // Get most recent team/club from player seasons
      const lastSeason = (player.seasons || []).slice(-1)[0];
      const lastReg    = (lastSeason?.regs || []).slice(-1)[0];
      arr.push({
        uuid,
        name:  player.name || '(private)',
        club:  lastReg?.club || lastReg?.cn || '',
        team:  lastReg?.tn  || '',
        grade: lastReg?.gn  || '',
      });
    }

    // Truncation collision analysis
    for (const len of [4, 6, 8, 10, 12]) {
      const prefix = bare.slice(0, len);
      totalForLen[len]++;
      if (prefixSets[len].has(prefix)) collisions[len]++;
      else prefixSets[len].add(prefix);
    }
  }
}

console.log(`  UUIDs sampled:        ${uuidsSampled.toLocaleString()}`);
console.log(`  Standard v4 format:   ${v4Count.toLocaleString()} (${((v4Count/uuidsSampled)*100).toFixed(1)}%)`);
console.log(`  Non-v4 format:        ${nonV4Count.toLocaleString()}`);
console.log(`  Private players:      ${privateCount.toLocaleString()} (${((privateCount/uuidsSampled)*100).toFixed(1)}%)`);

console.log('\n  Version bits:');
for (const [v, n] of Object.entries(versionCounts).sort())
  console.log(`    version ${v}: ${n.toLocaleString()}`);

console.log('\n  Variant bits:');
for (const [v, n] of Object.entries(variantCounts).sort())
  console.log(`    variant ${v}: ${n.toLocaleString()}`);

// Per-segment uniqueness
console.log('\n  Per-segment uniqueness:');
console.log('  Segment     Total    Unique   Repeated  Max-freq  Entropy?');
for (let i = 0; i < 5; i++) {
  const freq    = segFreq[i];
  const unique  = freq.size;
  const repeated = [...freq.values()].filter(v => v > 1).length;
  let maxFreq = 0; for (const v of freq.values()) if (v > maxFreq) maxFreq = v;
  const isRandom = unique / uuidsSampled > 0.99;
  console.log(
    `  ${segNames[i].padEnd(12)}${String(uuidsSampled).padStart(8)} ` +
    `${String(unique).padStart(8)} ${String(repeated).padStart(9)} ` +
    `${String(maxFreq).padStart(9)}  ${isRandom ? '✅ random' : '⚠ structured'}`
  );
}

// Semantic co-occurrence — find seg1 values shared by multiple players
const sharedSeg1 = [...seg1Players.entries()]
  .filter(([, arr]) => arr.length >= 2)
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 5);

if (sharedSeg1.length > 0) {
  console.log('\n  ⚠ Seg1 values shared by multiple players (top 5) — possible semantic encoding:');
  for (const [seg, players] of sharedSeg1) {
    console.log(`  seg1=${seg} (${players.length} players):`);
    for (const p of players) {
      console.log(`    ${p.uuid}  ${p.name.padEnd(25)} club:${p.club}  team:${p.team}`);
    }
  }
} else {
  console.log('\n  ✅ No repeated seg1 values — seg1 appears random/unique per player');
}

// Private player samples
if (privateSamples.length > 0) {
  console.log('\n  Private player UUID samples:');
  for (const p of privateSamples) {
    const segs = p.uuid.split('-');
    console.log(`    ${p.uuid}  seg1:${segs[0]} seg2:${segs[1]} seg3:${segs[2]} seg4:${segs[3]} seg5:${segs[4]}`);
  }
  console.log('  (Compare segment structure to public players above — any fixed segments suggest encoding)');
}

// Truncation collision analysis
console.log('\n  Display ID truncation — collision analysis (bare UUID, no hyphens):');
console.log('  Chars  Unique   Collisions  Rate       Usable?');
for (const len of [4, 6, 8, 10, 12]) {
  const unique = prefixSets[len].size;
  const col    = collisions[len];
  const rate   = ((col / totalForLen[len]) * 100).toFixed(4);
  const usable = col === 0 ? '✅ zero collisions' : col < 5 ? '⚠ near-zero' : '❌ collisions';
  console.log(`  ${String(len).padEnd(7)}${String(unique).padStart(8)}   ${String(col).padStart(10)}  ${rate.padStart(9)}%  ${usable}`);
}
console.log('  Note: test on full population (--uuid-sample=370000) for definitive result');

// ─── Phase 2: Game coverage analysis ─────────────────────────────────────────
// For each game in scope, count how many players in playerGames have a detail file.
// Coverage = players with detail file / total players in playerGames for that game.
// Bucket games by coverage band.

console.log('\n\n🏀 PHASE 2 — Game Player Coverage Analysis');
console.log('─'.repeat(50));

// Coverage buckets: 0%, 1-25%, 26-50%, 51-75%, 76-99%, 100%
const buckets = { 0: 0, '1-25': 0, '26-50': 0, '51-75': 0, '76-99': 0, 100: 0 };
let gamesAnalysed = 0, gamesNoPlayerGames = 0;
let totalPlayersExpected = 0, totalPlayersFound = 0;
let fullCoverageGames = 0, zeroCoverageGames = 0;

// Player file existence cache — avoid repeated fs.existsSync per player
const _playerExists = {};
function playerExists(uuid) {
  if (_playerExists[uuid] !== undefined) return _playerExists[uuid];
  const f = path.join(PLAYERS_DIR, uuid.slice(0, 2), `${uuid}.json`);
  return (_playerExists[uuid] = fs.existsSync(f));
}

const seasonFiles = fs.existsSync(GAMES_DIR)
  ? fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'))
  : [];

const targetFiles = SAMPLE_SEASON
  ? seasonFiles.filter(f => f === `${SAMPLE_SEASON}.json`)
  : seasonFiles;

let filesProcessed = 0;

for (const file of targetFiles) {
  let sg;
  try { sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8')); } catch (e) { continue; }

  const games       = sg.games       || {};
  const playerGames = sg.playerGames || {};

  // Build reverse map: gameId → [playerUUIDs]
  const gameToPlayers = {};
  for (const [uuid, gameIds] of Object.entries(playerGames)) {
    for (const gid of gameIds) {
      if (!gameToPlayers[gid]) gameToPlayers[gid] = [];
      gameToPlayers[gid].push(uuid);
    }
  }

  for (const [gameId, game] of Object.entries(games)) {
    // Only analyse scoreable games — skip upcoming, forfeit, cancelled etc
    if (game.st === 'UPCOMING' || game.bye || game.cancelled || game.abandoned) continue;

    const players = gameToPlayers[gameId] || [];
    if (players.length === 0) { gamesNoPlayerGames++; continue; }

    gamesAnalysed++;
    let found = 0;
    for (const uuid of players) {
      if (playerExists(uuid)) found++;
    }

    const expected = players.length;
    totalPlayersExpected += expected;
    totalPlayersFound    += found;

    const pct = (found / expected) * 100;

    if (pct === 0)         { buckets[0]++;       zeroCoverageGames++; }
    else if (pct <= 25)    { buckets['1-25']++; }
    else if (pct <= 50)    { buckets['26-50']++; }
    else if (pct <= 75)    { buckets['51-75']++; }
    else if (pct < 100)    { buckets['76-99']++; }
    else                   { buckets[100]++;      fullCoverageGames++; }
  }

  filesProcessed++;
  if (filesProcessed % 100 === 0) {
    process.stdout.write(`  Scanning ${filesProcessed}/${targetFiles.length} season files...\r`);
  }
}

console.log(`  Season files scanned:      ${filesProcessed.toLocaleString()}`);
console.log(`  Games analysed:            ${gamesAnalysed.toLocaleString()}`);
console.log(`  Games with no playerGames: ${gamesNoPlayerGames.toLocaleString()}`);
console.log(`  Total players expected:    ${totalPlayersExpected.toLocaleString()}`);
console.log(`  Total players found:       ${totalPlayersFound.toLocaleString()}`);
const overallCoverage = totalPlayersExpected > 0
  ? ((totalPlayersFound / totalPlayersExpected) * 100).toFixed(1) : 'N/A';
console.log(`  Overall player coverage:   ${overallCoverage}%`);

console.log('\n  Coverage distribution:');
console.log(`    0% coverage:       ${buckets[0].toLocaleString().padStart(10)}  (no players in our DB)`);
console.log(`    1-25% coverage:    ${buckets['1-25'].toLocaleString().padStart(10)}`);
console.log(`    26-50% coverage:   ${buckets['26-50'].toLocaleString().padStart(10)}`);
console.log(`    51-75% coverage:   ${buckets['51-75'].toLocaleString().padStart(10)}`);
console.log(`    76-99% coverage:   ${buckets['76-99'].toLocaleString().padStart(10)}`);
console.log(`    100% coverage:     ${buckets[100].toLocaleString().padStart(10)}  ← eligible for full box score`);

const eligiblePct = gamesAnalysed > 0
  ? ((fullCoverageGames / gamesAnalysed) * 100).toFixed(1) : 'N/A';
console.log(`\n  Full coverage rate: ${eligiblePct}% of analysed games`);
console.log(`  (${fullCoverageGames.toLocaleString()} games have 100% of their players in our database)`);

console.log('\n' + '═'.repeat(60));
console.log('  Diagnostic complete.\n');
