// scripts/build-search-index.js
//
// Rebuilds search/players/{xx}.json shards from player index and detail files.
//
// Each shard key is a player name token — "First Last" and "Last, First".
// Each value is an array of { id, c, t } where c = most recent club, t = most recent team.
// Private players (name starts with "Player #") get c: null, t: null.
//
// Usage:
//   node scripts/build-search-index.js            # rebuild all 256 shards
//   node scripts/build-search-index.js --dry-run  # no writes or commits

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT     = path.join(__dirname, '..');
const DRY_RUN  = process.argv.includes('--dry-run');

const INDEX_DIR  = path.join(ROOT, 'players', 'indexes');
const PLAYER_DIR = path.join(ROOT, 'players');
const SEARCH_DIR = path.join(ROOT, 'search', 'players');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gitCommit(message) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  try { execSync('git add search/', { stdio: 'pipe', cwd: ROOT }); } catch (_) {}
  const staged = (() => {
    try { return execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim(); }
    catch (_) { return ''; }
  })();
  if (!staged) { console.log('  Nothing to commit'); return; }
  try { execSync(`git commit -m "${message.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT }); }
  catch (_) { return; }
  const MAX = 10;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      execSync('git fetch origin main',                   { stdio: 'pipe', cwd: ROOT });
      execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main',                   { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✓ Committed: ${message}`);
      return;
    } catch (_) {
      if (attempt === MAX) { console.error(`  Push failed after ${MAX} attempts`); return; }
      await sleep(Math.floor(Math.random() * 15000) + attempt * 3000);
    }
  }
}

// Extract most recent club and team from a player detail file.
// Walks seasons newest-first (assumes they're stored newest-last — reverse iterate).
function extractClubTeam(player) {
  const seasons = player.seasons || [];
  for (let i = seasons.length - 1; i >= 0; i--) {
    const s = seasons[i];
    const club = s.club || null;
    const regs = s.regs || [];
    // Pick the most recent registration in this season
    const lastReg = regs[regs.length - 1];
    if (lastReg && lastReg.tn) {
      return { c: club, t: lastReg.tn };
    }
    if (club) return { c: club, t: null };
  }
  return { c: null, t: null };
}

// Produce search index entries for a player.
// Returns array of [key, entry] pairs — "First Last" and "Last, First".
function searchEntries(playerName, uuid, c, t) {
  const name = (playerName || '').trim();
  if (!name) return [];

  const entry = { id: uuid, c: c || null, t: t || null };
  const pairs = [];

  // "First Last" key
  pairs.push([name, entry]);

  // "Last, First" key — only if name has at least two words and isn't a "Player #" stub
  if (!name.startsWith('Player #')) {
    const parts = name.split(/\s+/);
    if (parts.length >= 2) {
      const lastName  = parts[parts.length - 1];
      const firstPart = parts.slice(0, -1).join(' ');
      const reversed  = `${lastName}, ${firstPart}`;
      if (reversed !== name) pairs.push([reversed, entry]);
    }
  }

  return pairs;
}

async function main() {
  const startTime = Date.now();
  console.log('build-search-index.js');
  if (DRY_RUN) console.log('  ⚠  DRY RUN — no writes or commits');
  console.log('─'.repeat(50));

  if (!fs.existsSync(SEARCH_DIR)) fs.mkdirSync(SEARCH_DIR, { recursive: true });

  // Process each shard independently — read index, read player files, build shard
  const shards = [];
  for (let i = 0; i < 256; i++) {
    shards.push(i.toString(16).padStart(2, '0'));
  }

  let totalKeys    = 0;
  let totalPlayers = 0;
  let shardsWritten = 0;

  for (const shard of shards) {
    const indexFile = path.join(INDEX_DIR, `${shard}.json`);
    if (!fs.existsSync(indexFile)) continue;

    let index;
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); }
    catch (_) { continue; }

    // shard output: { "Name": [{ id, c, t }, ...], "Last, First": [...] }
    const shardData = {};

    for (const [uuid, indexEntry] of Object.entries(index)) {
      totalPlayers++;
      const playerName = indexEntry.name || '';
      const playerFile = path.join(PLAYER_DIR, shard, `${uuid}.json`);

      let c = null, t = null;
      if (fs.existsSync(playerFile)) {
        try {
          const player = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
          const ct = extractClubTeam(player);
          c = ct.c; t = ct.t;
        } catch (_) {}
      }

      for (const [key, entry] of searchEntries(playerName, uuid, c, t)) {
        if (!shardData[key]) shardData[key] = [];
        // Avoid duplicates — same uuid shouldn't appear twice under the same key
        if (!shardData[key].some(e => e.id === uuid)) {
          shardData[key].push(entry);
        }
      }
    }

    const keyCount = Object.keys(shardData).length;
    totalKeys += keyCount;

    if (!DRY_RUN) {
      fs.writeFileSync(path.join(SEARCH_DIR, `${shard}.json`), JSON.stringify(shardData));
    }
    shardsWritten++;

    if (shardsWritten % 32 === 0 || shardsWritten === 256) {
      process.stdout.write(`  ${shardsWritten}/256 shards  ${totalPlayers} players  ${totalKeys} keys\r`);
    }
  }

  console.log(`\n  ${shardsWritten}/256 shards written`);
  console.log(`  Players indexed:  ${totalPlayers}`);
  console.log(`  Total keys:       ${totalKeys}`);

  await gitCommit(`build-search-index: ${totalPlayers} players, ${totalKeys} keys`);

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('─'.repeat(50));
  console.log(`  Elapsed: ${elapsed}s`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
