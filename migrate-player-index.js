// migrate-player-index.js
/**
 * Migrates sports-index.json players section into sharded files.
 *
 * Before: sports-index.json = { players: {uuid: {...}}, seasons: {...} }
 * After:  sports-index.json = { seasons: {...}, lastFetch, playerCount }
 *         players-index/xx.json = { uuid: {...}, ... } for each 2-char prefix
 *
 * The fetch script is updated separately to read/write shards.
 * This script is a one-off migration — safe to re-run (idempotent).
 */

const fs   = require('fs');
const path = require('path');

const INDEX_FILE   = path.join(__dirname, 'sports-index.json');
const SHARDS_DIR   = path.join(__dirname, 'players-index');

async function main() {
  console.log('📦 Migrating player index to sharded files...\n');

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const players = index.players || {};
  const total = Object.keys(players).length;

  console.log(`  Players to migrate: ${total.toLocaleString()}`);
  console.log(`  Seasons to keep:    ${Object.keys(index.seasons || {}).length}`);

  if (total === 0) {
    console.log('  No players in index — nothing to migrate');
    return;
  }

  // Create shards directory
  if (!fs.existsSync(SHARDS_DIR)) fs.mkdirSync(SHARDS_DIR);

  // Group players by first 2 chars of UUID
  const shards = {};
  for (const [uuid, player] of Object.entries(players)) {
    const prefix = uuid.slice(0, 2);
    if (!shards[prefix]) shards[prefix] = {};
    shards[prefix][uuid] = player;
  }

  // Write shard files
  let written = 0;
  for (const [prefix, shard] of Object.entries(shards)) {
    const file = path.join(SHARDS_DIR, `${prefix}.json`);
    fs.writeFileSync(file, JSON.stringify(shard));
    written += Object.keys(shard).length;
    process.stdout.write(`  Writing shard ${prefix}: ${Object.keys(shard).length} players\r`);
  }
  console.log(`\n  ✓ Written ${written.toLocaleString()} players across ${Object.keys(shards).length} shards`);

  // Write slim index (seasons only, no players)
  const slimIndex = {
    seasons:     index.seasons     || {},
    lastFetch:   index.lastFetch   || null,
    playerCount: total,
  };
  fs.writeFileSync(INDEX_FILE, JSON.stringify(slimIndex));
  console.log(`  ✓ sports-index.json updated (slim, seasons only)`);
  console.log(`\n✅ Migration complete`);
  console.log(`   Slim index size: ${(fs.statSync(INDEX_FILE).size / 1024).toFixed(1)} KB`);
  console.log(`   Shards dir:      ${SHARDS_DIR}`);
  console.log(`   Shard count:     ${Object.keys(shards).length}`);
}

main().catch(e => {
  console.error(`❌ Fatal: ${e.message}`);
  process.exit(1);
});
