#!/usr/bin/env node
// recover-missing-seasons.js
/**
 * Finds season IDs that have game files on disk but are missing from
 * sports-index.json and seasons-discovered.json, then queries discoverSeason
 * for each to recover their metadata and add them to the index.
 *
 * Usage:
 *   node recover-missing-seasons.js
 *   node recover-missing-seasons.js --dry-run
 *   node recover-missing-seasons.js --concurrency=20
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');

const ARGS        = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k,...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const TENANT      = ARGS.tenant      || 'bv';
const TENANT_FULL = { bv: 'basketball-victoria' }[TENANT] || TENANT;
const DRY_RUN     = !!ARGS['dry-run'];
const CONCURRENCY = parseInt(ARGS.concurrency || '20', 10);

const API_URL    = 'https://api.playhq.com/graphql';
const GAMES_DIR  = path.join(__dirname, 'games', TENANT);
const INDEX_FILE = path.join(__dirname, 'sports-index.json');
const DISC_FILE  = path.join(__dirname, 'seasons-discovered.json');
const COOKIE_FILE = path.join(__dirname, 'recover-seasons-cookie.json');

const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT_FULL,
  'content-type': 'application/json',
};

const PLAYERS_DIR = path.join(__dirname, 'players');
const TEAM_DIR    = path.join(__dirname, 'team-lookup');

// Cache for team-lookup shards
const _teamShards = {};
function getTeamData(tid) {
  if (!tid) return null;
  const prefix = tid.slice(0, 2);
  if (!_teamShards[prefix]) {
    const f = path.join(TEAM_DIR, `${prefix}.json`);
    try { _teamShards[prefix] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; }
    catch (e) { _teamShards[prefix] = {}; }
  }
  return _teamShards[prefix][tid] || null;
}

// Scan player files to find season metadata for missing season IDs
// Returns a map of seasonId -> { name, compName, orgName, grades[] }
function reconstructFromPlayerFiles(missingIds) {
  console.log(`\n  Scanning player files for ${missingIds.length} missing seasons...`);
  const needed  = new Set(missingIds);
  const results = {};

  if (!fs.existsSync(PLAYERS_DIR)) {
    console.log('  ⚠ players/ directory not available in this checkout');
    return results;
  }

  const shards = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/i.test(d));
  let scanned = 0;

  for (const shard of shards) {
    if (needed.size === 0) break;
    const dir = path.join(PLAYERS_DIR, shard);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (e) { continue; }

    for (const file of files) {
      if (needed.size === 0) break;
      let detail;
      try { detail = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (e) { continue; }
      scanned++;

      for (const season of (detail.seasons || [])) {
        if (!needed.has(season.sid)) continue;

        const reg     = season.regs?.[0];
        const tid     = reg?.tid;
        const team    = tid ? getTeamData(tid) : null;

        results[season.sid] = {
          id:            season.sid,
          name:          season.sn || `Unknown ${season.sid}`,
          fullName:      team ? `${team.compName} — ${season.sn}` : season.sn || `Unknown ${season.sid}`,
          locked:        true,
          grades:        season.regs?.map(r => ({ id: r.gid, name: r.gn })).filter(g => g.id) || [],
          compId:        team?.compId     || null,
          compName:      team?.compName   || null,
          orgId:         team?.compOrgId  || null,
          orgName:       team?.compOrgName || null,
          // Store player UUID for API enrichment if comp/org missing
          _playerUuid:   (!team?.compName) ? detail.uuid : null,
          _playerSid:    season.sid,
          reconstructed: 'player-history',
        };
        needed.delete(season.sid);
      }

      if (scanned % 10000 === 0) {
        process.stdout.write(`  Scanned ${scanned.toLocaleString()} player files, ${Object.keys(results).length} seasons found, ${needed.size} still needed...\r`);
      }
    }
  }

  console.log(`\n  Scanned ${scanned.toLocaleString()} player files — found metadata for ${Object.keys(results).length}/${missingIds.length} seasons`);
  return results;
}
console.log(`   Tenant:      ${TENANT}`);
console.log(`   Concurrency: ${CONCURRENCY}`);
console.log(`   Mode:        ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

// ─── Cookie ───────────────────────────────────────────────────────────────────

async function getSession() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const d = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      if (Date.now() - d.fetchedAt < 23 * 60 * 60 * 1000) return d.cookie;
    }
  } catch (e) {}
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({
      operationName: 'TenantConfig',
      variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }',
    }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No Set-Cookie header');
  const cookie = raw.split(';')[0];
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie, fetchedAt: Date.now() }));
  console.log('  ✓ Cookie obtained');
  return cookie;
}

// ─── Query ────────────────────────────────────────────────────────────────────

const Q_SEASON = `query DiscoverSeason($id: String!) {
  discoverSeason(seasonID: $id) {
    id name
    status { value }
    startDate endDate
    competition {
      id name
      organisation { id name type }
    }
    grades { id name }
  }
}`;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchSeason(seasonId, cookie) {
  try {
    const res = await fetch(API_URL, {
      method:  'POST',
      headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
      body:    JSON.stringify({ operationName: 'DiscoverSeason', variables: { id: seasonId }, query: Q_SEASON }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.errors) return null;
    return json.data?.discoverSeason || null;
  } catch (e) {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const index   = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const disc    = fs.existsSync(DISC_FILE) ? JSON.parse(fs.readFileSync(DISC_FILE, 'utf8')) : {};
  const seasons = index.seasons || {};

  const gameFiles  = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  const missingIds = gameFiles.filter(id => !seasons[id] && !disc[id]);

  console.log(`Season game files on disk:   ${gameFiles.length}`);
  console.log(`In sports-index.json:        ${Object.keys(seasons).length}`);
  console.log(`Missing from both:           ${missingIds.length}\n`);

  if (missingIds.length === 0) { console.log('✅ No missing seasons — index is complete'); return; }

  let found = 0, notFound = 0;
  const recovered = [];

  // ── Step 1: Reconstruct from player files (no API calls needed) ──────────────
  const playerMeta = reconstructFromPlayerFiles(missingIds);
  const stillMissing = missingIds.filter(id => !playerMeta[id]);

  console.log(`\n  From player files: ${Object.keys(playerMeta).length} recovered`);
  console.log(`  Still need API:    ${stillMissing.length}\n`);

  // ── Step 1b: Enrich missing comp/org via publicProfileStatistics ──────────────
  const needsEnrichment = Object.values(playerMeta).filter(m => !m.compName && m._playerUuid);
  if (needsEnrichment.length > 0) {
    console.log(`  Enriching ${needsEnrichment.length} seasons with missing comp/org via player API...`);
    const cookie2 = await getSession();
    const Q_PROFILE = `query Profile($id: ID!) { publicProfileStatistics(profileID: $id) { statistics { season { id name competition { id name organisation { id name } } } } } }`;

    for (let i = 0; i < needsEnrichment.length; i += CONCURRENCY) {
      const batch = needsEnrichment.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async meta => {
        try {
          const res  = await fetch(API_URL, {
            method:  'POST',
            headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie2 },
            body:    JSON.stringify({ operationName: 'Profile', variables: { id: meta._playerUuid }, query: Q_PROFILE }),
          });
          const json = await res.json();
          const ss   = json.data?.publicProfileStatistics?.statistics || [];
          const match = ss.find(s => s.season?.id === meta._playerSid);
          if (!match && ss.length > 0 && needsEnrichment.indexOf(meta) === 0) {
            // Log first failure for diagnosis
            console.warn(`\n  DIAG: looking for sid=${meta._playerSid}, got season IDs: ${ss.slice(0,5).map(s=>s.season?.id).join(', ')}`);
          }
          if (match?.season?.competition) {
            const comp = match.season.competition;
            meta.compId   = comp.id;
            meta.compName = comp.name;
            meta.orgId    = comp.organisation?.id;
            meta.orgName  = comp.organisation?.name;
            meta.fullName = `${comp.name} — ${meta.name}`;
          }
        } catch (e) {}
      }));
      if (i + CONCURRENCY < needsEnrichment.length) await delay(100);
    }
    console.log(`  Enrichment complete`);
  }

  for (const [sid, meta] of Object.entries(playerMeta)) {
    // Remove internal fields before storing
    delete meta._playerUuid;
    delete meta._playerSid;
    found++;
    recovered.push({ id: sid, name: meta.name, comp: meta.compName, org: meta.orgName, source: 'player-history' });
    if (!DRY_RUN) {
      disc[sid]    = { id: sid, name: meta.name, compName: meta.compName, orgName: meta.orgName, reconstructed: 'player-history' };
      seasons[sid] = meta;
    }
  }

  // ── Step 2: Try discoverSeason API for remainder ──────────────────────────────
  if (stillMissing.length > 0) {
    const cookie = await getSession();

    for (let i = 0; i < stillMissing.length; i += CONCURRENCY) {
      const batch   = stillMissing.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async id => {
        await delay(Math.random() * 100);
        return { id, season: await fetchSeason(id, cookie) };
      }));

      for (const { id, season } of results) {
        if (season) {
          // Found via API
          found++;
          recovered.push({ id, name: season.name, comp: season.competition?.name, org: season.competition?.organisation?.name });
          if (!DRY_RUN) {
            disc[id] = { id, name: season.name, compName: season.competition?.name, orgName: season.competition?.organisation?.name };
            const isActive = season.status?.value === 'ACTIVE' || season.status?.value === 'UPCOMING';
            seasons[id] = {
              id, name: season.name,
              fullName:  `${season.competition?.name || '?'} — ${season.name}`,
              locked:    !isActive,
              grades:    (season.grades || []).map(g => ({ id: g.id, name: g.name })),
              compId:    season.competition?.id,    compName: season.competition?.name,
              orgId:     season.competition?.organisation?.id, orgName: season.competition?.organisation?.name,
              startDate: season.startDate, endDate: season.endDate,
            };
          }
          continue;
        }

        // ── Step 3: Try team-lookup reconstruction ────────────────────────────
        let reconstructed = null;
        try {
          const games  = Object.values(JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${id}.json`), 'utf8')).games || {});
          const teamId = games.find(g => g.h)?.h || games.find(g => g.o)?.o;
          if (teamId) {
            const team = getTeamData(teamId);
            if (team) {
              reconstructed = {
                id, name: team.sn || id,
                fullName: `${team.compName || '?'} — ${team.sn || id}`,
                locked: true, grades: [],
                compId: team.compId, compName: team.compName,
                orgId: team.compOrgId, orgName: team.compOrgName,
                reconstructed: 'team-lookup',
              };
            }
          }
        } catch (e) {}

        if (reconstructed) {
          found++;
          recovered.push({ id, name: reconstructed.name, comp: reconstructed.compName, org: reconstructed.orgName, source: 'team-lookup' });
          if (!DRY_RUN) {
            disc[id]    = { id, name: reconstructed.name, compName: reconstructed.compName, orgName: reconstructed.orgName, reconstructed: 'team-lookup' };
            seasons[id] = reconstructed;
          }
          continue;
        }

        // ── Step 4: Date-based stub ───────────────────────────────────────────
        try {
          const games = Object.values(JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${id}.json`), 'utf8')).games || {});
          const year  = games.map(g => g.d).filter(Boolean).sort()[0]?.slice(0, 4) || '?';
          const stub  = { id, name: `Unknown Season ${year}`, fullName: `Unknown Competition — ${year}`, locked: true, grades: [], compId: null, compName: null, orgId: null, orgName: null, reconstructed: 'stub' };
          found++;
          recovered.push({ id, name: stub.name, comp: null, org: null, source: 'stub' });
          if (!DRY_RUN) { disc[id] = { id, name: stub.name, reconstructed: 'stub' }; seasons[id] = stub; }
        } catch (e) {
          notFound++;
          if (!DRY_RUN) disc[id] = { id, invalid: true, checkedAt: new Date().toISOString() };
        }
      }

      process.stdout.write(`  ${Math.min(i + CONCURRENCY, stillMissing.length)}/${stillMissing.length} API probed — ✓ ${found} total, ✗ ${notFound}\r`);
      if (i + CONCURRENCY < stillMissing.length) await delay(200);
    }
  }

  console.log(`\n\n✅ Recovery complete`);
  console.log(`   Player history: ${recovered.filter(r => r.source === 'player-history').length}`);
  console.log(`   API:            ${recovered.filter(r => !r.source).length}`);
  console.log(`   Team-lookup:    ${recovered.filter(r => r.source === 'team-lookup').length}`);
  console.log(`   Stub:           ${recovered.filter(r => r.source === 'stub').length}`);
  console.log(`   Not recoverable:${notFound}`);

  if (recovered.length > 0) {
    console.log(`\n  Sample recovered:`);
    recovered.slice(0, 10).forEach(r => {
      const tag = r.source ? ` [${r.source}]` : ' [api]';
      console.log(`    ${r.id}  ${r.name}  (${r.comp || '?'}, ${r.org || '?'})${tag}`);
    });
  }

  if (!DRY_RUN && found > 0) {
    index.seasons = seasons;
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
    fs.writeFileSync(DISC_FILE, JSON.stringify(disc));
    try {
      execSync('git add sports-index.json seasons-discovered.json', { stdio: 'pipe' });
      const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
      if (diff) {
        execSync(`git commit -m "Recover ${found} missing seasons into index"`, { stdio: 'pipe' });
        execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
        execSync('git push', { stdio: 'pipe' });
        console.log('  ✓ Committed and pushed');
      }
    } catch (e) { console.warn(`  ⚠ Git error: ${e.message}`); }
  }
}

main().catch(e => { console.error(`\n❌ Fatal: ${e.message}`); process.exit(1); });
