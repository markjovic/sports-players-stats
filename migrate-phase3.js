// migrate-phase3.js
// Migration Phase 3: build search/players/{xx}.json shards.
//
// Each named player produces two entries:
//   - First-name shard: key = "FirstName LastName"  → shard = key.slice(0,2).toLowerCase()
//   - Surname shard:    key = "LastName, FirstName" → shard = key.slice(0,2).toLowerCase()
// Private players (no name) produce one entry: key = "Player #${uuid.slice(0,10)}" → shard "pl"
//
// Value is always an array to handle duplicate names: [{id, c, t}, ...]
//   c = most recent club name
//   t = most recent team name
//
// Data source: players/{xx}/{uuid}.json detail files (369k files, ~5 min read time).
// All shards accumulated in memory then written in one pass — no mid-run commits needed
// since the full run fits well within the 350-minute timeout.

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PLAYERS_DIR = 'players';
const SEARCH_DIR  = 'search/players';

// ── helpers ───────────────────────────────────────────────────────────────────

function shardKey(str) {
  return str.slice(0, 2).toLowerCase();
}

function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

function privateDisplayName(uuid) {
  return `Player #${uuid.slice(0, 10)}`;
}

function mostRecentContext(detail) {
  const season = detail.seasons?.length
    ? detail.seasons[detail.seasons.length - 1]
    : null;
  return {
    c: season?.club || null,
    t: season?.regs?.[0]?.tn || null,
  };
}

function buildSearchEntries(detail) {
  const { uuid } = detail;
  const { c, t } = mostRecentContext(detail);
  const value = { id: uuid, c, t };
  const entries = [];
  const rawName = detail.name;

  if (!rawName) {
    const displayName = privateDisplayName(uuid);
    entries.push({ shard: shardKey(displayName), key: displayName, value });
    return entries;
  }

  // First-name shard
  entries.push({ shard: shardKey(rawName), key: rawName, value });

  // Surname shard (two-part names only)
  const { first, last } = splitName(rawName);
  if (last) {
    const snKey = `${last}, ${first}`;
    entries.push({ shard: shardKey(snKey), key: snKey, value });
  }

  return entries;
}

function addToShards(shards, entries) {
  for (const { shard, key, value } of entries) {
    if (!shards[shard])      shards[shard] = {};
    if (!shards[shard][key]) shards[shard][key] = [];
    shards[shard][key].push(value);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('migrate-phase3.js — Migration Phase 3: search shards');
  console.log('=====================================================');

  const shards = {};
  let playersProcessed = 0;
  let dirsProcessed = 0;

  const playerDirs = fs.readdirSync(PLAYERS_DIR)
    .filter(d => /^[0-9a-f]{2}$/i.test(d))
    .sort();

  console.log(`\nReading ${playerDirs.length} player directories...`);

  for (const dir of playerDirs) {
    const dirPath = path.join(PLAYERS_DIR, dir);
    // Skip players/indexes/ — it's not a hex-prefixed player dir but filter above handles it
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      let detail;
      try { detail = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8')); }
      catch (e) { continue; }
      addToShards(shards, buildSearchEntries(detail));
      playersProcessed++;
    }

    dirsProcessed++;
    if (dirsProcessed % 16 === 0) {
      console.log(`  ${dirsProcessed}/${playerDirs.length} dirs processed (${playersProcessed.toLocaleString()} players)`);
    }
  }

  console.log(`\nAll players read. Writing shards...`);
  fs.mkdirSync(SEARCH_DIR, { recursive: true });

  const shardKeys = Object.keys(shards).sort();
  let totalEntries = 0;

  for (const key of shardKeys) {
    const data = shards[key];
    fs.writeFileSync(path.join(SEARCH_DIR, `${key}.json`), JSON.stringify(data));
    totalEntries += Object.keys(data).length;
  }

  console.log(`  ${shardKeys.length} shard files written`);
  console.log(`  ${totalEntries.toLocaleString()} unique search keys`);
  console.log(`  ${playersProcessed.toLocaleString()} players indexed`);

  // Commit
  try {
    execSync(`git add ${SEARCH_DIR}`, { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (diff) {
      execSync(`git commit -m "migrate-phase3: search shards (${shardKeys.length} files, ${playersProcessed.toLocaleString()} players)"`, { stdio: 'pipe' });
      execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log('  committed.');
    }
  } catch (e) { console.error('  git error:', e.message); }

  console.log('\n✅ Migration Phase 3 complete.');
  console.log('Next step: add spectator route to Cloudflare Worker (Step 3.5)');
}

main().catch(e => { console.error(e); process.exit(1); });
