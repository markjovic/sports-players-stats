// scripts/test-grade-concurrency.js
//
// Tests concurrency limits for discoverGrade API calls.
// No writes, no checkout needed — just measures throughput and failure rate.
// Gradually increases concurrency, backing off on failures.
//
// Run: node scripts/test-grade-concurrency.js
//
// Uses a sample of grade IDs from sports-index.json.

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

const Q_GRADE_ROUNDS = {
  operationName: 'DiscoverGrade',
  query: `query DiscoverGrade($gradeID: ID!) {
    discoverGrade(gradeID: $gradeID) {
      id name
      rounds { id name }
    }
  }`,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getSession() {
  const res = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({
      operationName: 'TenantConfig',
      variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }',
    }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No Set-Cookie');
  const match = raw.match(/phq_session=([^;]+)/);
  if (!match) throw new Error('No phq_session in cookie');
  return `phq_session=${match[1]}`;
}

async function callGrade(gradeId, cookie) {
  const start = Date.now();
  const res = await fetch('https://api.playhq.com/graphql', {
    method:  'POST',
    headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
    body:    JSON.stringify({ ...Q_GRADE_ROUNDS, variables: { gradeID: gradeId } }),
  });
  const elapsed = Date.now() - start;
  if (res.status === 403) return { status: 403, elapsed };
  if (res.status === 429) return { status: 429, elapsed };
  if (!res.ok)            return { status: res.status, elapsed };
  const data = await res.json();
  if (data.errors)        return { status: 'gql_error', elapsed };
  return { status: 200, elapsed };
}

async function runBatch(gradeIds, cookie, concurrency) {
  const results = await Promise.allSettled(
    gradeIds.slice(0, concurrency).map(id => callGrade(id, cookie))
  );
  const statuses = results.map(r =>
    r.status === 'fulfilled' ? r.value.status : 'rejected'
  );
  const elapsed = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value.elapsed);
  const avgMs = elapsed.length
    ? Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length)
    : 0;
  const failures = statuses.filter(s => s !== 200).length;
  return { statuses, failures, avgMs };
}

async function main() {
  console.log('test-grade-concurrency.js');
  console.log('─'.repeat(60));

  // Load grade IDs from sports-index.json
  const index    = JSON.parse(fs.readFileSync(path.join(ROOT, 'sports-index.json'), 'utf8'));
  const gradeIds = [];
  for (const season of Object.values(index.seasons || {})) {
    if (season.locked) continue;
    for (const grade of (season.grades || [])) {
      if (grade.id) gradeIds.push(grade.id);
    }
  }
  console.log(`  ${gradeIds.length} active grade IDs available\n`);

  // Shuffle so we don't always test the same grades
  for (let i = gradeIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [gradeIds[i], gradeIds[j]] = [gradeIds[j], gradeIds[i]];
  }

  console.log('  Fetching session...');
  const cookie = await getSession();
  console.log('  Session OK\n');

  console.log('  Concurrency test — doubling on success, +50% backoff on failure');
  console.log('  ─'.repeat(55));
  console.log(`  ${'Concurrency'.padEnd(14)} ${'Failures'.padEnd(10)} ${'Avg ms'.padEnd(10)} Result`);
  console.log('  ─'.repeat(55));

  let concurrency = 1;
  let lastGood    = 1;
  let idx         = 0;

  while (concurrency <= 1000) {
    // Use a fresh slice of grade IDs for each test (wrap around if needed)
    const batch = [];
    for (let i = 0; i < concurrency; i++) {
      batch.push(gradeIds[(idx + i) % gradeIds.length]);
    }
    idx = (idx + concurrency) % gradeIds.length;

    const { failures, avgMs, statuses } = await runBatch(batch, cookie, concurrency);
    const failRate = concurrency > 0 ? (failures / concurrency * 100).toFixed(1) : '0.0';
    const success  = failures === 0;

    console.log(
      `  ${String(concurrency).padEnd(14)} ${String(failures).padEnd(10)} ${String(avgMs + 'ms').padEnd(10)} ` +
      (success ? '✓' : `✗ (${statuses.filter(s => s !== 200).join(', ')})`)
    );

    if (success) {
      lastGood    = concurrency;
      const next  = Math.min(Math.round(concurrency * 2), 1000);
      if (next === concurrency) break;  // hit 1000
      concurrency = next;
    } else {
      // Back off: midpoint between lastGood and current
      const next = Math.round(lastGood + (concurrency - lastGood) * 0.5);
      if (next <= lastGood || next === concurrency) {
        console.log(`\n  ✓ Settled: safe concurrency = ${lastGood}`);
        break;
      }
      concurrency = next;
    }

    // Brief pause between tests to avoid state bleed
    await sleep(500);
  }

  if (concurrency > 1000) {
    console.log(`\n  ✓ No failures up to 1000 — safe to use concurrency=1000`);
  }

  console.log('─'.repeat(60));
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
