// team-lookup-utils.js
/**
 * Shared utilities for reading and writing team-lookup shards.
 *
 * team-lookup/{prefix}.json stores one entry per unique team ID:
 *   {
 *     "caab7ccb": {
 *       name, logo, orgId, orgName, gid, gn,
 *       sid, sn, compId, compName, compOrgId, compOrgName,
 *       startDate, endDate
 *     }
 *   }
 *
 * Player detail files store slim refs only:
 *   teams: [{ tid, sid, status }]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const LOOKUP_DIR = path.join(__dirname, 'team-lookup');

// In-memory cache of loaded shards
const _shards      = {};
const _dirtyShards = new Set();

function lookupFile(teamId) {
  return path.join(LOOKUP_DIR, `${teamId.slice(0, 2)}.json`);
}

function loadShard(teamId) {
  const prefix = teamId.slice(0, 2);
  if (!_shards[prefix]) {
    const f = lookupFile(teamId);
    try {
      _shards[prefix] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    } catch (e) {
      _shards[prefix] = {};
    }
  }
  return _shards[prefix];
}

// Extract smallest logo URL from API logo object
function extractLogo(logo) {
  if (!logo) return null;
  if (typeof logo === 'string') return logo;  // already slimmed
  if (Array.isArray(logo.sizes)) {
    const sorted = logo.sizes
      .filter(s => s?.url)
      .sort((a, b) => (a.dimensions?.width || 999) - (b.dimensions?.width || 999));
    return sorted[0]?.url || null;
  }
  return null;
}

/**
 * Store a full publicProfileTeams entry into the lookup shard.
 * Only writes if the team ID is new or if a logo is being added.
 */
function storeLookupEntry(team) {
  if (!team?.id) return;
  const shard = loadShard(team.id);
  const existing = shard[team.id];
  const logo = extractLogo(team.logo);

  // Skip if already stored and no new logo to add
  if (existing && (existing.logo || !logo)) return;

  shard[team.id] = {
    name:        team.name || null,
    logo:        logo,
    orgId:       team.organisation?.id || null,
    orgName:     team.organisation?.name || null,
    gid:         team.grade?.id || null,
    gn:          team.grade?.name || null,
    sid:         team.season?.id || null,
    sn:          team.season?.name || null,
    compId:      team.season?.competition?.id || null,
    compName:    team.season?.competition?.name || null,
    compOrgId:   team.season?.competition?.organisation?.id || null,
    compOrgName: team.season?.competition?.organisation?.name || null,
    startDate:   team.season?.startDate || null,
    endDate:     team.season?.endDate || null,
  };
  _dirtyShards.add(team.id.slice(0, 2));
}

/**
 * Convert a full publicProfileTeams entry to a slim player ref.
 */
function toSlimRef(team) {
  return {
    tid:    team.id,
    sid:    team.season?.id || null,
    status: team.season?.status?.value || null,
  };
}

/**
 * Process a full publicProfileTeams response:
 * - Stores each team entry in the lookup shard
 * - Returns slim refs array for storage on the player file
 */
function processTeams(teams) {
  if (!Array.isArray(teams)) return [];
  const slimRefs = [];
  for (const team of teams) {
    if (!team?.id) continue;
    storeLookupEntry(team);
    slimRefs.push(toSlimRef(team));
  }
  return slimRefs;
}

/**
 * Flush all dirty lookup shards to disk.
 * Returns count of shards written.
 */
function flushLookupShards() {
  if (!fs.existsSync(LOOKUP_DIR)) fs.mkdirSync(LOOKUP_DIR, { recursive: true });
  let count = 0;
  for (const prefix of _dirtyShards) {
    fs.writeFileSync(
      path.join(LOOKUP_DIR, `${prefix}.json`),
      JSON.stringify(_shards[prefix])
    );
    count++;
  }
  _dirtyShards.clear();
  return count;
}

/**
 * Look up a team by ID from the shard cache (loads shard if needed).
 */
function lookupTeam(teamId) {
  if (!teamId) return null;
  return loadShard(teamId)[teamId] || null;
}

/**
 * Check if a teams array on a player file is already in slim ref format.
 */
function isSlimFormat(teams) {
  if (!Array.isArray(teams) || teams.length === 0) return true;
  const first = teams[0];
  return typeof first === 'object'
    && 'tid' in first
    && !('name' in first)
    && !('logo' in first)
    && !('grade' in first);
}

module.exports = {
  processTeams,
  flushLookupShards,
  lookupTeam,
  isSlimFormat,
  storeLookupEntry,
  toSlimRef,
  extractLogo,
  LOOKUP_DIR,
};
