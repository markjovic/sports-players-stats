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

async function probeSeason(seasonId) {
  const RETRIES   = 3;
  const RETRY_GAP = 2000;  // ms between retries
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(PLAYHQ_ENDPOINT, {
        method: 'POST',
        headers: PLAYHQ_HEADERS,
        body: JSON.stringify({ query: Q_PROBE, variables: { id: seasonId } }),
      });
      if (!res.ok) {
        if (attempt < RETRIES) { await new Promise(r => setTimeout(r, RETRY_GAP)); continue; }
        return { result: null, attempts: attempt };
      }
      const json = await res.json();
      const season = json?.data?.discoverSeason || null;
      if (season) return { result: season, attempts: attempt };
      // null result = season not found — no point retrying
      return { result: null, attempts: attempt };
    } catch (e) {
      if (attempt < RETRIES) { await new Promise(r => setTimeout(r, RETRY_GAP)); continue; }
      return { result: null, attempts: attempt };
    }
  }
  return { result: null, attempts: RETRIES };
}

async function probeSeasonDelay(seasonId, delay) {
  await new Promise(r => setTimeout(r, delay));
  return probeSeason(seasonId);
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

  // Also probe queued seasons that have no metadata yet
  const metaFile = path.join(__dirname, 'seasons-discovered.json');
  const existingMeta = fs.existsSync(metaFile)
    ? JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    : {};

  // Seed existingMeta with crawled seasons from the index (full metadata already known)
  for (const [sid, s] of Object.entries(index.seasons || {})) {
    if (!existingMeta[sid]) {
      existingMeta[sid] = {
        id:       sid,
        name:     s.name     || '',
        compName: s.compName || '',
        orgName:  s.orgName  || '',
        queue:    'crawled',
        locked:   s.locked   || false,
        grades:   (s.grades || []).length,
      };
    }
  }

  const indexSeasons = new Set(Object.keys(index.seasons || {}));
  const allQueuedIds = [
    ...JSON.parse(fs.readFileSync(QUEUE_PRIORITY_FILE, 'utf8')),
    ...JSON.parse(fs.readFileSync(QUEUE_BACKLOG_FILE, 'utf8')),
  ];
  const missingMeta = allQueuedIds.filter(sid =>
    !indexSeasons.has(sid) && !existingMeta[sid]
  );
  console.log(`  Queue entries missing metadata: ${missingMeta.length}`);

  // Merge into candidates (deduped)
  const allCandidatesSet = new Set([...candidates, ...missingMeta]);
  candidates.length = 0;
  candidates.push(...allCandidatesSet);
  console.log(`  Total to validate: ${candidates.length}\n`);

  if (candidates.length === 0) {
    console.log('✅ Nothing to validate');
    return;
  }

  // Validate each candidate against PlayHQ API
  console.log('🏀 Validating candidates against PlayHQ API...\n');
  const toAddPriority = [];
  const toAddBacklog  = [];
  const invalid       = [];
  const validSeasons  = [];  // { id, season } for metadata file
  let   retriedSuccess = 0;  // count of seasons that passed only after retry
  const BATCH = 10;
  const DELAY = 300;  // ms between requests

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((id, j) => probeSeasonDelay(id, j * DELAY))
    );
    for (let j = 0; j < batch.length; j++) {
      const id              = batch[j];
      const { result: season, attempts } = results[j];
      const retryNote       = attempts > 1 ? ` (attempt ${attempts})` : '';
      if (season) {
        const name     = season.name || '';
        const orgName  = season.competition?.organisation?.name || '';
        const compName = season.competition?.name || '';
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
    // Brief pause between batches
    if (i + BATCH < candidates.length) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n📊 Results:`);
  console.log(`  Valid → priority:  ${toAddPriority.length}`);
  console.log(`  Valid → backlog:   ${toAddBacklog.length}`);
  console.log(`  Invalid (skip):    ${invalid.length}`);
  console.log(`  Passed on retry:   ${retriedSuccess} (would have been lost without retry logic)`);

  if (toAddPriority.length === 0 && toAddBacklog.length === 0) {
    console.log('\n✅ No valid new seasons found');
    return;
  }

  // Add to queues
  priority.push(...toAddPriority);
  backlog.push(...toAddBacklog);

  fs.writeFileSync(QUEUE_PRIORITY_FILE, JSON.stringify(priority));
  fs.writeFileSync(QUEUE_BACKLOG_FILE,  JSON.stringify(backlog));

  // Save metadata for all valid seasons to a review file (reuse existingMeta loaded above)
  for (const { id, season } of validSeasons) {
    existingMeta[id] = {
      id,
      name:     season.name || '',
      compName: season.competition?.name || '',
      orgName:  season.competition?.organisation?.name || '',
      queue:    toAddPriority.includes(id) ? 'priority' : 'backlog',
    };
  }
  fs.writeFileSync(metaFile, JSON.stringify(existingMeta));

  console.log(`\n✅ Queue files updated`);
  console.log(`   Priority: ${priority.length} seasons`);
  console.log(`   Backlog:  ${backlog.length} seasons`);
  console.log(`   Metadata saved to seasons-discovered.json`);
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
