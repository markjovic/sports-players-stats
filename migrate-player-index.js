#!/usr/bin/env node
/**
 * migrate-player-index.js
 *
 * One-off migration: splits the existing sports-index.json (which contains
 * full regs data per player) into:
 *
 *   sports-index.json        — slim: uuid, name, gender, sports: {sport: {career totals}}
 *   players/{xx}/{uuid}.json — full: all seasons + regs, fetched on demand
 *
 * Safe to run multiple times — overwrites existing files with correct data.
 * Run locally or via GitHub Actions (migrate-player-index workflow).
 */

const fs   = require('fs');
const path = require('path');

const INDEX_FILE  = path.join(__dirname, 'sports-index.json');
const PLAYERS_DIR = path.join(__dirname, 'players');

// Tenant → sport name (same map as fetch-playhq.js)
const TENANT_SPORT = {
  'bv':  'Basketball',
  'afl': 'Australian Rules Football',
  'ca':  'Cricket',
};

// Stat fields that are valid career total keys
const VALID_STAT_KEYS = new Set(['gp', 'pts', 'fouls', 'fg', 'ft', 'threePt']);

function playerFile(uuid) {
  const shard = uuid.slice(0, 2);
  const dir   = path.join(PLAYERS_DIR, shard);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${uuid}.json`);
}

function inferSport(seasons) {
  // Try to infer sport from season data — fall back to Basketball (bv default)
  // Current data has sport field incorrectly set to season name, so we can't rely on it
  // All existing data is bv (Basketball)
  return 'Basketball';
}

function computeCareerTotals(seasons, sport) {
  const totals = { gp: 0, pts: 0, fouls: 0, fg: 0, ft: 0, threePt: 0 };
  for (const s of seasons) {
    for (const reg of (s.regs || [])) {
      for (const [k, v] of Object.entries(reg.stats || {})) {
        if (VALID_STAT_KEYS.has(k)) totals[k] += v || 0;
      }
    }
  }
  return totals;
}

async function main() {
  console.log('📦 Migrating sports-index.json to split format...');

  if (!fs.existsSync(INDEX_FILE)) {
    console.error('❌ sports-index.json not found');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const players = data.players || {};
  const total   = Object.keys(players).length;

  console.log(`   Players to migrate: ${total}`);
  console.log(`   Seasons in index:   ${Object.keys(data.seasons || {}).length}`);

  const slimPlayers = {};
  let done = 0;

  for (const [uuid, player] of Object.entries(players)) {
    const seasons = player.seasons || [];
    const sport   = inferSport(seasons);

    // Tag each season with correct sport name and strip bad sport field
    const taggedSeasons = seasons.map(s => ({
      sid:  s.sid  || s.seasonId,
      sn:   s.sn   || s.seasonName,
      club: s.club || s.clubName,
      sport,
      regs: s.regs || [],
    }));

    // Compute career totals
    const totals = computeCareerTotals(taggedSeasons, sport);

    // Preserve gender
    const gender = player.gender || 'Unknown';

    // Write full detail file
    const detail = {
      uuid,
      name:     player.name,
      gender,
      sports:   { [sport]: totals },
      seasons:  taggedSeasons,
      updatedAt: player.updatedAt || new Date().toISOString(),
    };
    fs.writeFileSync(playerFile(uuid), JSON.stringify(detail));

    // Build slim index entry
    slimPlayers[uuid] = {
      uuid,
      name:     player.name,
      gender,
      sports:   { [sport]: totals },
      updatedAt: player.updatedAt || new Date().toISOString(),
    };

    done++;
    if (done % 500 === 0) {
      console.log(`   ${done}/${total} migrated...`);
    }
  }

  // Write new slim index
  const newIndex = {
    players:   slimPlayers,
    seasons:   data.seasons || {},
    lastFetch: data.lastFetch || null,
  };
  fs.writeFileSync(INDEX_FILE, JSON.stringify(newIndex));

  console.log(`\n✅ Migration complete`);
  console.log(`   Players migrated: ${done}`);
  console.log(`   Detail files written to: players/`);
  console.log(`   sports-index.json rewritten (slim)`);

  // Size report
  const newSize = fs.statSync(INDEX_FILE).size;
  console.log(`   New index size: ${(newSize/1024/1024).toFixed(1)}MB`);
}

main().catch(e => {
  console.error(`❌ Fatal: ${e.message}`);
  process.exit(1);
});
