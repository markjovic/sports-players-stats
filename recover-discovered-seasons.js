// recover-discovered-seasons.js
/**
 * Fills seasons-discovered.json with metadata for all known seasons:
 * 1. Seeds from crawled seasons in sports-index.json (full metadata already known)
 * 2. Probes queue entries missing metadata via PlayHQ API (with retries)
 * 3. Routes any newly valid seasons to correct queue
 *
 * Run via GitHub Actions: "Recover Discovered Seasons" workflow
 * No longer scans run logs — all IDs already captured in queue files.
 */

const fs   = require('fs');
const path = require('path');

const TENANT     = 'bv';
const PLAYHQ_URL = 'https://api.playhq.com/graphql';

const INDEX_FILE          = path.join(__dirname, 'sports-index.json');
const QUEUE_PRIORITY_FILE = path.join(__dirname, 'queue-bv-priority.json');
const QUEUE_BACKLOG_FILE  = path.join(__dirname, 'queue-bv-backlog.json');
const META_FILE           = path.join(__dirname, 'seasons-discovered.json');

const PLAYHQ_HEADERS = {
  'Content-Type': 'application/json',
  'tenant':        TENANT,
  'origin':        'https://www.playhq.com',
};

const Q_PROBE = `query probe($id: String!) {
  discoverSeason(seasonID: $id) {
    id
    name
    competition { name organisation { name } }
  }
}`;

function parseSeasonYear(name) {
  if (!name) return null;
  const years = [];
  const full = name.match(/20\d\d/g);
  if (full) full.forEach(y => years.push(parseInt(y)));
  const split = name.match(/20\d\d\/(\d\d)/);
  if (split) years.push(2000 + parseInt(split[1]));
  return years.length ? Math.max(...years) : null;
}

function isPriority(name) {
  const year = parseSeasonYear(name);
  return year === null || year >= 2023;
}

async function probeSeason(seasonId) {
  const RETRIES   = 3;
  const RETRY_GAP = 2000;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(PLAYHQ_URL, {
        method:  'POST',
        headers: PLAYHQ_HEADERS,
        body:    JSON.stringify({ query: Q_PROBE, variables: { id: seasonId } }),
      });
      if (!res.ok) {
        if (attempt < RETRIES) { await new Promise(r => setTimeout(r, RETRY_GAP)); continue; }
        return { result: null, attempts: attempt };
      }
      const json   = await res.json();
      const season = json?.data?.discoverSeason || null;
      if (season) return { result: season, attempts: attempt };
      // Log the actual response on first failure to diagnose
      if (attempt === 1 && !season) {
        const preview = JSON.stringify(json).slice(0, 200);
        process.stderr.write(`  DEBUG null response for ${seasonId}: ${preview}\n`);
      }
      // null may be transient — retry
      if (attempt < RETRIES) { await new Promise(r => setTimeout(r, RETRY_GAP)); continue; }
      return { result: null, attempts: attempt };
    } catch (e) {
      if (attempt < RETRIES) { await new Promise(r => setTimeout(r, RETRY_GAP)); continue; }
      return { result: null, attempts: attempt };
    }
  }
  return { result: null, attempts: RETRIES };
}

async function main() {
  console.log('📋 Filling season metadata...\n');

  const index    = fs.existsSync(INDEX_FILE) ? JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) : { seasons: {} };
  const priority = fs.existsSync(QUEUE_PRIORITY_FILE) ? JSON.parse(fs.readFileSync(QUEUE_PRIORITY_FILE, 'utf8')) : [];
  const backlog  = fs.existsSync(QUEUE_BACKLOG_FILE)  ? JSON.parse(fs.readFileSync(QUEUE_BACKLOG_FILE,  'utf8')) : [];
  const meta     = fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf8')) : {};

  // Seed meta with crawled seasons from index
  for (const [sid, s] of Object.entries(index.seasons || {})) {
    meta[sid] = {
      id:       sid,
      name:     s.name     || '',
      compName: s.compName || '',
      orgName:  s.orgName  || '',
      queue:    'crawled',
      locked:   s.locked   || false,
      grades:   (s.grades || []).length,
    };
  }

  const indexSeasons = new Set(Object.keys(index.seasons || {}));
  const allQueued    = [...new Set([...priority, ...backlog])];
  const missing      = allQueued.filter(sid => !indexSeasons.has(sid) && !meta[sid]);

  console.log(`Crawled seasons seeded: ${Object.keys(index.seasons || {}).length}`);
  console.log(`Total queued:           ${allQueued.length}`);
  console.log(`Missing metadata:       ${missing.length}\n`);

  if (missing.length === 0) {
    fs.writeFileSync(META_FILE, JSON.stringify(meta));
    console.log('✅ All metadata already populated');
    return;
  }

  const toAddPriority = [];
  const toAddBacklog  = [];
  const invalid       = [];
  const validSeasons  = [];
  let   retriedSuccess = 0;

  const BATCH = 10;
  const DELAY = 300;

  console.log('🏀 Probing missing seasons...\n');
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch   = missing.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((id, j) => new Promise(r => setTimeout(() => probeSeason(id).then(r), j * DELAY)))
    );
    for (let j = 0; j < batch.length; j++) {
      const id                      = batch[j];
      const { result: season, attempts } = results[j];
      const retryNote               = attempts > 1 ? ` (attempt ${attempts})` : '';
      if (season) {
        const name     = season.name || '';
        const orgName  = season.competition?.organisation?.name || '';
        const compName = season.competition?.name || '';
        meta[id] = { id, name, compName, orgName,
          queue: isPriority(name) ? 'priority' : 'backlog' };
        if (isPriority(name)) {
          toAddPriority.push(id);
          console.log(`  ✓ Priority: ${id} — ${compName} ${name} (${orgName})${retryNote}`);
        } else {
          toAddBacklog.push(id);
          console.log(`  ✓ Backlog:  ${id} — ${compName} ${name} (${orgName})${retryNote}`);
        }
        validSeasons.push({ id, season });
        if (attempts > 1) retriedSuccess++;
      } else {
        invalid.push(id);
        console.log(`  ✗ Invalid:  ${id}`);
      }
    }
    if (i + BATCH < missing.length) await new Promise(r => setTimeout(r, 500));
  }

  // Add newly valid seasons to queues if not already there
  const prioritySet = new Set(priority);
  const backlogSet  = new Set(backlog);
  let added = 0;
  for (const id of toAddPriority) {
    if (!prioritySet.has(id) && !backlogSet.has(id) && !indexSeasons.has(id)) {
      priority.push(id); added++;
    }
  }
  for (const id of toAddBacklog) {
    if (!prioritySet.has(id) && !backlogSet.has(id) && !indexSeasons.has(id)) {
      backlog.push(id); added++;
    }
  }

  fs.writeFileSync(META_FILE,           JSON.stringify(meta));
  fs.writeFileSync(QUEUE_PRIORITY_FILE, JSON.stringify(priority));
  fs.writeFileSync(QUEUE_BACKLOG_FILE,  JSON.stringify(backlog));

  console.log(`\n📊 Results:`);
  console.log(`  Valid → priority:   ${toAddPriority.length}`);
  console.log(`  Valid → backlog:    ${toAddBacklog.length}`);
  console.log(`  Invalid (skip):     ${invalid.length}`);
  console.log(`  Passed on retry:    ${retriedSuccess}`);
  console.log(`  Added to queues:    ${added}`);
  console.log(`\n✅ seasons-discovered.json updated (${Object.keys(meta).length} total seasons)`);
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
