#!/usr/bin/env node
/**
 * recover-discovered-seasons.js
 *
 * 1. Fetches ALL workflow run logs (no time limit)
 * 2. Extracts every "New season discovered: XXXXXXXX" line
 * 3. Deduplicates against current index + both queue files
 * 4. Validates each candidate against the PlayHQ API (discoverSeason)
 * 5. Routes valid seasons to priority (2023+) or backlog (pre-2023)
 * 6. Saves updated queue files
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO_OWNER = 'markjovic';
const REPO_NAME  = 'sports-players-stats';
const WORKFLOW   = '285907662';  // PlayHQ Sports Scraper workflow ID
const TENANT     = 'bv';

const INDEX_FILE          = path.join(__dirname, 'sports-index.json');
const QUEUE_PRIORITY_FILE = path.join(__dirname, 'queue-bv-priority.json');
const QUEUE_BACKLOG_FILE  = path.join(__dirname, 'queue-bv-backlog.json');

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('❌ GITHUB_TOKEN not set'); process.exit(1); }

const GH_HEADERS = {
  'Authorization': `Bearer ${TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'sports-players-stats-recovery',
};

const PLAYHQ_HEADERS = {
  'Content-Type': 'application/json',
  'tenant': TENANT,
  'origin': 'https://www.playhq.com',
};

const PLAYHQ_ENDPOINT = 'https://api.playhq.com/graphql';

const Q_PROBE = `query probe($id: String!) {
  discoverSeason(seasonID: $id) {
    id
    name
    competition { name organisation { name } }
  }
}`;

async function ghFetch(url) {
  const res = await fetch(url, { headers: GH_HEADERS });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
  return res.json();
}

async function fetchLogZip(runId) {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs/${runId}/logs`;
  const res = await fetch(url, { headers: GH_HEADERS, redirect: 'follow' });
  if (!res.ok) return null;  // logs may be expired
  return Buffer.from(await res.arrayBuffer());
}

function extractFromZip(buf) {
  const discovered = new Set();

  // Find End of Central Directory to get correct file sizes
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i]===0x50&&buf[i+1]===0x4b&&buf[i+2]===0x05&&buf[i+3]===0x06) { eocd=i; break; }
  }
  if (eocd < 0) return discovered;

  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize   = buf.readUInt32LE(eocd + 12);

  // Walk central directory — extract text from all files
  let pos = cdOffset;
  while (pos < cdOffset + cdSize) {
    if (buf[pos]!==0x50||buf[pos+1]!==0x4b||buf[pos+2]!==0x01||buf[pos+3]!==0x02) break;
    const compression = buf.readUInt16LE(pos + 10);
    const compSize    = buf.readUInt32LE(pos + 20);
    const uncompSize  = buf.readUInt32LE(pos + 24);
    const nameLen     = buf.readUInt16LE(pos + 28);
    const extraLen    = buf.readUInt16LE(pos + 30);
    const commentLen  = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name        = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');

    // Read local file header to find data start
    const lNameLen  = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;

    let text = '';
    try {
      if (compression === 0) {
        text = buf.slice(dataStart, dataStart + uncompSize).toString('utf8');
      } else if (compression === 8) {
        text = zlib.inflateRawSync(buf.slice(dataStart, dataStart + compSize)).toString('utf8');
      }
    } catch (e) {}

    if (text) {
      const matches = text.matchAll(/New season discovered:\s*([0-9a-f]{8})/gi);
      for (const m of matches) discovered.add(m[1]);
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }
  return discovered;
}

async function getAllRuns() {
  const runs = [];
  let page = 1;
  while (true) {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW}/runs?per_page=100&page=${page}`;
    const data = await ghFetch(url);
    if (data.message) { console.error(`  API error: ${data.message}`); break; }
    const batch = data.workflow_runs || data.runs || [];
    if (!batch.length) break;
    runs.push(...batch);
    console.log(`  Page ${page}: ${batch.length} runs (total: ${runs.length})`);
    if (batch.length < 100) break;
    page++;
  }
  return runs;
}

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
  return year === null || year >= 2023;  // unknown year → priority
}

async function probeSeasonDelay(seasonId, delay) {
  await new Promise(r => setTimeout(r, delay));
  try {
    const res = await fetch(PLAYHQ_ENDPOINT, {
      method: 'POST',
      headers: PLAYHQ_HEADERS,
      body: JSON.stringify({ query: Q_PROBE, variables: { id: seasonId } }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.discoverSeason || null;
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log('🔍 Recovering discovered seasons from all workflow run logs\n');

  // Load current state
  const index    = fs.existsSync(INDEX_FILE) ? JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) : { seasons: {} };
  const priority = fs.existsSync(QUEUE_PRIORITY_FILE) ? JSON.parse(fs.readFileSync(QUEUE_PRIORITY_FILE, 'utf8')) : [];
  const backlog  = fs.existsSync(QUEUE_BACKLOG_FILE)  ? JSON.parse(fs.readFileSync(QUEUE_BACKLOG_FILE,  'utf8')) : [];

  const knownSeasons = new Set([
    ...Object.keys(index.seasons || {}),
    ...priority,
    ...backlog,
  ]);

  console.log(`Current state:`);
  console.log(`  Seasons in index:  ${Object.keys(index.seasons || {}).length}`);
  console.log(`  Priority queue:    ${priority.length}`);
  console.log(`  Backlog queue:     ${backlog.length}`);
  console.log(`  Total known:       ${knownSeasons.size}\n`);

  // Fetch all run logs
  console.log('📋 Fetching all workflow runs...');
  const runs = await getAllRuns();
  console.log(`  Total runs: ${runs.length}\n`);

  const allDiscovered = new Set();
  let processed = 0;
  for (const run of runs) {
    process.stdout.write(`  Run #${run.run_number} (${++processed}/${runs.length})...\r`);
    const buf = await fetchLogZip(run.id);
    if (buf) {
      const ids = extractFromZip(buf);
      ids.forEach(id => allDiscovered.add(id));
    }
  }
  console.log(`\n\n  Unique discovered IDs in logs: ${allDiscovered.size}`);

  // Filter to only unknown IDs
  const candidates = [...allDiscovered].filter(id => !knownSeasons.has(id));
  console.log(`  Already known:     ${allDiscovered.size - candidates.length}`);
  console.log(`  Candidates to validate: ${candidates.length}\n`);

  if (candidates.length === 0) {
    console.log('✅ Nothing new to add');
    return;
  }

  // Validate each candidate against PlayHQ API
  console.log('🏀 Validating candidates against PlayHQ API...\n');
  const toAddPriority = [];
  const toAddBacklog  = [];
  const invalid       = [];
  const BATCH = 10;
  const DELAY = 300;  // ms between requests

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((id, j) => probeSeasonDelay(id, j * DELAY))
    );
    for (let j = 0; j < batch.length; j++) {
      const id     = batch[j];
      const season = results[j];
      if (season) {
        const name    = season.name || '';
        const orgName = season.competition?.organisation?.name || '';
        const compName = season.competition?.name || '';
        if (isPriority(name)) {
          toAddPriority.push(id);
          console.log(`  ✓ Priority: ${id} — ${compName} ${name} (${orgName})`);
        } else {
          toAddBacklog.push(id);
          console.log(`  ✓ Backlog:  ${id} — ${compName} ${name} (${orgName})`);
        }
      } else {
        invalid.push(id);
        console.log(`  ✗ Invalid:  ${id}`);
      }
    }
    // Brief pause between batches
    if (i + BATCH < candidates.length) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n📊 Results:`);
  console.log(`  Valid → priority: ${toAddPriority.length}`);
  console.log(`  Valid → backlog:  ${toAddBacklog.length}`);
  console.log(`  Invalid (skip):   ${invalid.length}`);

  if (toAddPriority.length === 0 && toAddBacklog.length === 0) {
    console.log('\n✅ No valid new seasons found');
    return;
  }

  // Add to queues — new seasons go to the front of priority so they're processed soon
  priority.push(...toAddPriority);
  backlog.push(...toAddBacklog);

  fs.writeFileSync(QUEUE_PRIORITY_FILE, JSON.stringify(priority));
  fs.writeFileSync(QUEUE_BACKLOG_FILE,  JSON.stringify(backlog));

  console.log(`\n✅ Queue files updated`);
  console.log(`   Priority: ${priority.length} seasons`);
  console.log(`   Backlog:  ${backlog.length} seasons`);
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
