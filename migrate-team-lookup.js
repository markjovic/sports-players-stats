#!/usr/bin/env node
// migrate-team-lookup.js
/**
 * Migrates player detail files to use slim team refs instead of full publicProfileTeams data.
 *
 * WHAT IT DOES:
 *   1. Scans all player detail files in players/
 *   2. For each file with a `teams` array:
 *      - Extracts full team metadata into team-lookup/{prefix}.json shards (one entry per unique team ID)
 *      - Replaces the `teams` array on the player file with slim refs: [{tid, sid, status}]
 *   3. Writes all modified player files and team-lookup shards
 *   4. Commits and pushes progress every SAVE_INTERVAL players
 *
 * RESULT:
 *   Before: player file teams[] = 54KB for a 34-season player (full API response with 6 logo URLs)
 *   After:  player file teams[] = ~1.2KB (slim refs only)
 *           team-lookup/ca.json  = one entry per unique team ID, ~300 bytes each
 *
 * SAFE TO RE-RUN — skips player files already migrated (teams[] entries are objects with only tid/sid/status)
 *
 * Usage:
 *   node migrate-team-lookup.js
 *   node migrate-team-lookup.js --dry-run     # report only, no writes
 *   node migrate-team-lookup.js --concurrency=50
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────

const DRY_RUN      = process.argv.includes('--dry-run');
const SAVE_INTERVAL = 5000;  // commit every N players processed
const PLAYERS_DIR  = path.join(__dirname, 'players');
const LOOKUP_DIR   = path.join(__dirname, 'team-lookup');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lookupFile(teamId) {
  return path.join(LOOKUP_DIR, `${teamId.slice(0, 2)}.json`);
}

function playerFile(uuid) {
  const shard = uuid.slice(0, 2);
  const dir   = path.join(PLAYERS_DIR, shard);
  return path.join(dir, `${uuid}.json`);
}

// Extract the smallest logo URL from a logo object (handles both formats)
function extractLogo(logo) {
  if (!logo) return null;
  // Already slimmed to a string URL
  if (typeof logo === 'string') return logo;
  // Full sizes array — pick smallest by width
  if (Array.isArray(logo.sizes)) {
    const sorted = logo.sizes
      .filter(s => s?.url)
      .sort((a, b) => (a.dimensions?.width || 999) - (b.dimensions?.width || 999));
    return sorted[0]?.url || null;
  }
  return null;
}

// Check if a teams array is already migrated (slim refs only)
function isMigrated(teams) {
  if (!Array.isArray(teams) || teams.length === 0) return true;
  const first = teams[0];
  // Slim ref has only tid, sid, status — no name, no logo, no grade object
  return typeof first === 'object'
    && 'tid' in first
    && !('name' in first)
    && !('logo' in first)
    && !('grade' in first);
}

// Extract slim ref from a full team entry
function toSlimRef(team) {
  return {
    tid:    team.id,
    sid:    team.season?.id || null,
    status: team.season?.status?.value || null,
  };
}

// Extract team-lookup entry from a full team entry
function toLookupEntry(team) {
  const logo = extractLogo(team.logo);
  return {
    name:       team.name || null,
    logo:       logo,
    orgId:      team.organisation?.id || null,
    orgName:    team.organisation?.name || null,
    gid:        team.grade?.id || null,
    gn:         team.grade?.name || null,
    sid:        team.season?.id || null,
    sn:         team.season?.name || null,
    compId:     team.season?.competition?.id || null,
    compName:   team.season?.competition?.name || null,
    compOrgId:  team.season?.competition?.organisation?.id || null,
    compOrgName: team.season?.competition?.organisation?.name || null,
    startDate:  team.season?.startDate || null,
    endDate:    team.season?.endDate || null,
  };
}

// ─── Lookup shard management ──────────────────────────────────────────────────

// In-memory lookup shards — loaded on demand, written in bulk
const lookupShards = {};
let   dirtyLookupShards = new Set();

function loadLookupShard(teamId) {
  const prefix = teamId.slice(0, 2);
  if (!lookupShards[prefix]) {
    const f = lookupFile(teamId);
    try {
      lookupShards[prefix] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    } catch (e) {
      lookupShards[prefix] = {};
    }
  }
  return lookupShards[prefix];
}

function setLookupEntry(teamId, entry) {
  const prefix = teamId.slice(0, 2);
  const shard  = loadLookupShard(teamId);
  // Only write if new or if logo is being added/updated
  if (!shard[teamId] || (!shard[teamId].logo && entry.logo)) {
    shard[teamId] = entry;
    dirtyLookupShards.add(prefix);
  }
}

function flushLookupShards() {
  if (!fs.existsSync(LOOKUP_DIR)) fs.mkdirSync(LOOKUP_DIR, { recursive: true });
  let count = 0;
  for (const prefix of dirtyLookupShards) {
    fs.writeFileSync(
      path.join(LOOKUP_DIR, `${prefix}.json`),
      JSON.stringify(lookupShards[prefix])
    );
    count++;
  }
  dirtyLookupShards.clear();
  return count;
}

// ─── Git ──────────────────────────────────────────────────────────────────────

function gitCommitPush(message) {
  try {
    execSync('git add players/ team-lookup/', { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) { console.log('  (no changes to commit)'); return; }
    execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
    const stashOut = execSync('git stash', { stdio: 'pipe' }).toString();
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    if (stashOut.includes('Saved')) execSync('git stash pop', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('  ✓ Committed and pushed');
  } catch (e) {
    console.warn(`  ⚠ Git push failed: ${e.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== migrate-team-lookup.js ===');
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Players dir: ${PLAYERS_DIR}`);
  console.log(`Lookup dir:  ${LOOKUP_DIR}\n`);

  if (!fs.existsSync(PLAYERS_DIR)) {
    console.error('players/ directory not found');
    process.exit(1);
  }

  const shards = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/i.test(d));

  let totalPlayers    = 0;
  let alreadyMigrated = 0;
  let noTeams         = 0;
  let migrated        = 0;
  let errors          = 0;
  let uniqueTeams     = 0;
  let sinceLastSave   = 0;

  for (const shard of shards) {
    const shardDir = path.join(PLAYERS_DIR, shard);
    const files    = fs.readdirSync(shardDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      totalPlayers++;
      const filePath = path.join(shardDir, file);

      let detail;
      try {
        detail = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        errors++;
        console.warn(`  ⚠ Could not read ${filePath}: ${e.message}`);
        continue;
      }

      // Skip if no teams data
      if (!Array.isArray(detail.teams) || detail.teams.length === 0) {
        noTeams++;
        continue;
      }

      // Skip if already migrated
      if (isMigrated(detail.teams)) {
        alreadyMigrated++;
        continue;
      }

      // Process each full team entry
      const slimRefs = [];
      for (const team of detail.teams) {
        if (!team?.id) continue;

        // Add to lookup shard (deduplicated)
        const existing = loadLookupShard(team.id)[team.id];
        if (!existing) uniqueTeams++;
        setLookupEntry(team.id, toLookupEntry(team));

        // Build slim ref
        slimRefs.push(toSlimRef(team));
      }

      // Write updated player file
      detail.teams = slimRefs;
      if (!DRY_RUN) {
        try {
          fs.writeFileSync(filePath, JSON.stringify(detail));
          migrated++;
        } catch (e) {
          errors++;
          console.warn(`  ⚠ Could not write ${filePath}: ${e.message}`);
        }
      } else {
        migrated++;
      }

      sinceLastSave++;

      // Progress
      if (totalPlayers % 10000 === 0) {
        process.stdout.write(`  Scanned ${totalPlayers.toLocaleString()} | migrated ${migrated.toLocaleString()} | skipped ${alreadyMigrated.toLocaleString()} | unique teams ${uniqueTeams.toLocaleString()}\r`);
      }

      // Periodic flush and commit
      if (!DRY_RUN && sinceLastSave >= SAVE_INTERVAL) {
        const flushed = flushLookupShards();
        console.log(`\n  💾 Flushed ${flushed} lookup shards — committing...`);
        gitCommitPush(`Team lookup migration: ${migrated.toLocaleString()} players processed`);
        sinceLastSave = 0;
      }
    }
  }

  // Final flush
  if (!DRY_RUN) {
    const flushed = flushLookupShards();
    if (flushed > 0) {
      console.log(`\n  💾 Final flush: ${flushed} lookup shards`);
      gitCommitPush(`Team lookup migration: complete — ${migrated.toLocaleString()} players migrated`);
    }
  }

  console.log('\n=== Migration Complete ===');
  console.log(`  Total players scanned: ${totalPlayers.toLocaleString()}`);
  console.log(`  Already migrated:      ${alreadyMigrated.toLocaleString()}`);
  console.log(`  No teams data:         ${noTeams.toLocaleString()}`);
  console.log(`  Migrated this run:     ${migrated.toLocaleString()}`);
  console.log(`  Unique teams found:    ${uniqueTeams.toLocaleString()}`);
  console.log(`  Errors:                ${errors}`);
  if (DRY_RUN) console.log('\n  [DRY RUN — no files written]');
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
