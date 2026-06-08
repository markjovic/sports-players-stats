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

console.log(`\n🔍 Recover Missing Seasons`);
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

  // Find game files not in index
  const gameFiles   = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  const missingIds  = gameFiles.filter(id => !seasons[id] && !disc[id]);

  console.log(`Season game files on disk:   ${gameFiles.length}`);
  console.log(`In sports-index.json:        ${Object.keys(seasons).length}`);
  console.log(`Missing from both:           ${missingIds.length}\n`);

  if (missingIds.length === 0) {
    console.log('✅ No missing seasons — index is complete');
    return;
  }

  const cookie = await getSession();

  let found = 0, notFound = 0, failed = 0;
  const recovered = [];

  for (let i = 0; i < missingIds.length; i += CONCURRENCY) {
    const batch = missingIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async id => {
      await delay(Math.random() * 100);
      const s = await fetchSeason(id, cookie);
      return { id, season: s };
    }));

    for (const { id, season } of results) {
      if (!season) {
        // Try to reconstruct from team-lookup using game file team IDs
        const gameFile = path.join(GAMES_DIR, `${id}.json`);
        let reconstructed = null;
        try {
          const sg    = JSON.parse(fs.readFileSync(gameFile, 'utf8'));
          const games = Object.values(sg.games || {});
          // Find first game with a home team ID
          const sample = games.find(g => g.h);
          if (sample?.h) {
            const prefix = sample.h.slice(0, 2);
            const shardFile = path.join(__dirname, 'team-lookup', `${prefix}.json`);
            if (fs.existsSync(shardFile)) {
              const shard = JSON.parse(fs.readFileSync(shardFile, 'utf8'));
              const team  = shard[sample.h];
              if (team) {
                reconstructed = {
                  id,
                  name:      team.sn || id,
                  fullName:  `${team.compName || '?'} — ${team.sn || id}`,
                  locked:    true,  // if hidden/missing it's completed
                  grades:    [],
                  compId:    team.compId    || null,
                  compName:  team.compName  || null,
                  orgId:     team.compOrgId || null,
                  orgName:   team.compOrgName || null,
                  reconstructed: true,  // flag: metadata came from team-lookup not API
                };
              }
            }
          }
        } catch (e) {}

        if (reconstructed) {
          found++;
          recovered.push({ id, name: reconstructed.name, comp: reconstructed.compName, org: reconstructed.orgName, source: 'team-lookup' });
          if (!DRY_RUN) {
            disc[id] = { id, name: reconstructed.name, compName: reconstructed.compName, orgName: reconstructed.orgName, reconstructed: true };
            seasons[id] = reconstructed;
          }
        } else {
          notFound++;
          if (!DRY_RUN) disc[id] = { id, invalid: true, checkedAt: new Date().toISOString() };
        }
        continue;
      }

      found++;
      recovered.push({ id, name: season.name, comp: season.competition?.name, org: season.competition?.organisation?.name });

      if (!DRY_RUN) {
        // Add to seasons-discovered
        disc[id] = {
          id,
          name:     season.name,
          compId:   season.competition?.id,
          compName: season.competition?.name,
          orgId:    season.competition?.organisation?.id,
          orgName:  season.competition?.organisation?.name,
          status:   season.status?.value,
        };

        // Add to sports-index.json
        const isActive = season.status?.value === 'ACTIVE' || season.status?.value === 'UPCOMING';
        seasons[id] = {
          id,
          name:      season.name,
          fullName:  `${season.competition?.name} — ${season.name}`,
          locked:    !isActive,
          grades:    (season.grades || []).map(g => ({ id: g.id, name: g.name })),
          compId:    season.competition?.id,
          compName:  season.competition?.name,
          orgId:     season.competition?.organisation?.id,
          orgName:   season.competition?.organisation?.name,
          startDate: season.startDate,
          endDate:   season.endDate,
        };
      }
    }

    process.stdout.write(`  ${Math.min(i + CONCURRENCY, missingIds.length)}/${missingIds.length} — ✓ ${found} found, ✗ ${notFound} not found\r`);
    if (i + CONCURRENCY < missingIds.length) await delay(200);
  }

  console.log(`\n\n✅ Recovery complete`);
  console.log(`   Found via API:               ${recovered.filter(r => !r.source).length}`);
  console.log(`   Reconstructed (team-lookup): ${recovered.filter(r => r.source === 'team-lookup').length}`);
  console.log(`   Not recoverable:             ${notFound} (marked invalid in discovered)`);

  if (recovered.length > 0) {
    console.log(`\n  Sample recovered:`);
    recovered.slice(0, 10).forEach(r => console.log(`    ${r.id}  ${r.name}  (${r.comp}, ${r.org})${r.source ? ' [reconstructed]' : ''}`));
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
    } catch (e) {
      console.warn(`  ⚠ Git error: ${e.message}`);
    }
  }
}

main().catch(e => { console.error(`\n❌ Fatal: ${e.message}`); process.exit(1); });
