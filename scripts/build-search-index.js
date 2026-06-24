// scripts/build-search-index.js
//
// Rebuilds search/players/{prefix}.json shards from player index + detail files.
//
// Sharding: first 2 characters of the ENTRY KEY (player name, lowercase).
// e.g. "Sam Burdan" → shard "sa", "Burdan, Sam" → shard "bu"
// This matches how StatTrack fetches search results.
//
// Each shard: { "Name": [{ id, c, t }, ...], "Last, First": [...] }
// where c = most recent club, t = most recent team name.
//
// Usage:
//   node scripts/build-search-index.js            # rebuild all shards
//   node scripts/build-search-index.js --dry-run  # no writes or commits

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT       = path.join(__dirname, '..');
const DRY_RUN    = process.argv.includes('--dry-run');

const INDEX_DIR  = path.join(ROOT, 'players', 'indexes');
const PLAYER_DIR = path.join(ROOT, 'players');
const SEARCH_DIR = path.join(ROOT, 'search', 'players');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gitCommit(message) {
  if (DRY_RUN) { console.log(`  [dry-run] ${message}`); return; }
  try {
    execSync('git add -A', { stdio: 'pipe', cwd: ROOT });
    const staged = execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim();
    if (!staged) { console.log('  Nothing to commit'); return; }
    execSync(`git commit -m "${message.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT });
    execSync('git fetch origin main', { stdio: 'pipe', cwd: ROOT });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
    execSync('git push origin main', { stdio: 'pipe', cwd: ROOT });
    console.log(`  ✓ ${message}`);
  } catch (e) { console.error(`  git error: ${e.message}`); }
}

// Extract most recent club and team from a player detail file.
function extractClubTeam(player) {
  const seasons = player.seasons || [];
  for (let i = seasons.length - 1; i >= 0; i--) {
    const s    = seasons[i];
    const club = s.club || null;
    const regs = s.regs || [];
    const lastReg = regs[regs.length - 1];
    if (lastReg?.tn) return { c: club, t: lastReg.tn };
    if (club) return { c: club, t: null };
  }
  return { c: null, t: null };
}

// Name → shard key: first 2 chars of name, lowercase, letters only fallback to '__'
function shardKey(name) {
  const clean = name.toLowerCase().replace(/[^a-z]/g, '');
  return clean.length >= 2 ? clean.slice(0, 2) : (clean + '_').slice(0, 2);
}

async function main() {
  const startTime = Date.now();
  console.log('build-search-index.js');
  if (DRY_RUN) console.log('  ⚠  DRY RUN');
  console.log('─'.repeat(50));

  if (!DRY_RUN) fs.mkdirSync(SEARCH_DIR, { recursive: true });

  // Build the full shard map in memory — keyed by 2-char name prefix
  // Memory: ~369k players × ~150 bytes/entry = ~55MB, manageable
  const shards = new Map();  // "sa" → { "Sam Burdan": [{id, c, t}], "Burdan, Sam": [...] }

  function addEntry(nameKey, entry) {
    const sk = shardKey(nameKey);
    if (!shards.has(sk)) shards.set(sk, {});
    const shard = shards.get(sk);
    if (!shard[nameKey]) shard[nameKey] = [];
    if (!shard[nameKey].some(e => e.id === entry.id)) {
      shard[nameKey].push(entry);
    }
  }

  // Read all UUID prefix shards (00-ff) from the player index
  let totalPlayers = 0;

  for (let i = 0; i < 256; i++) {
    const prefix    = i.toString(16).padStart(2, '0');
    const indexFile = path.join(INDEX_DIR, `${prefix}.json`);
    if (!fs.existsSync(indexFile)) continue;

    let index;
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); }
    catch (_) { continue; }

    for (const [uuid, indexEntry] of Object.entries(index)) {
      totalPlayers++;
      const playerName = (indexEntry.name || '').trim();
      if (!playerName) continue;

      // Read player detail file for club/team
      let c = null, t = null;
      const playerFile = path.join(PLAYER_DIR, prefix, `${uuid}.json`);
      if (fs.existsSync(playerFile)) {
        try {
          const player = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
          const ct = extractClubTeam(player);
          c = ct.c; t = ct.t;
        } catch (_) {}
      }

      const entry = { id: uuid, c: c || null, t: t || null };

      // Forward: "Sam Burdan"
      addEntry(playerName, entry);

      // Reversed: "Burdan, Sam" (skip private player stubs)
      if (!playerName.startsWith('Player #')) {
        const parts = playerName.split(/\s+/);
        if (parts.length >= 2) {
          const lastName  = parts[parts.length - 1];
          const firstPart = parts.slice(0, -1).join(' ');
          const reversed  = `${lastName}, ${firstPart}`;
          if (reversed !== playerName) addEntry(reversed, entry);
        }
      }
    }

    if ((i + 1) % 32 === 0 || i === 255)
      process.stdout.write(`  ${i + 1}/256 UUID shards scanned (${totalPlayers} players)\r`);
  }

  console.log(`\n  Players indexed: ${totalPlayers}`);
  console.log(`  Name-prefix shards to write: ${shards.size}`);

  // Write shards
  let totalKeys = 0;
  for (const [prefix, data] of shards) {
    totalKeys += Object.keys(data).length;
    if (!DRY_RUN) {
      fs.writeFileSync(path.join(SEARCH_DIR, `${prefix}.json`), JSON.stringify(data));
    }
  }

  // Remove any stale UUID-prefix shard files that don't correspond to name prefixes
  // (leftover from the previous incorrect build-search-index.js run)
  const hexPattern = /^[0-9a-f]{2}\.json$/;
  let staleRemoved = 0;
  if (!DRY_RUN) {
    for (const file of fs.readdirSync(SEARCH_DIR)) {
      if (!hexPattern.test(file)) continue;
      const prefix = file.replace('.json', '');
      // If this shard file doesn't have any entries in our new name-based map, it's stale
      if (!shards.has(prefix)) {
        fs.unlinkSync(path.join(SEARCH_DIR, file));
        staleRemoved++;
      }
    }
  }

  console.log(`  Name-based shards written: ${shards.size}`);
  console.log(`  Total search keys: ${totalKeys}`);
  if (staleRemoved > 0) console.log(`  Stale UUID-prefix files removed: ${staleRemoved}`);

  await gitCommit(
    `build-search-index: ${totalPlayers} players, ${shards.size} shards, ${totalKeys} keys`
  );

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('─'.repeat(50));
  console.log(`  Elapsed: ${elapsed}s`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
