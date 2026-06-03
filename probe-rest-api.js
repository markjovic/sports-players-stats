// probe-rest-api.js
/**
 * Probes PlayHQ REST API endpoints without an API key to see what's accessible.
 * Tests endpoints relevant to finding team rosters before games are played.
 *
 * Usage:
 *   node probe-rest-api.js [--season=<id>] [--grade=<id>] [--tenant=<tenant>]
 *
 * Output: probe-rest-api.html (committed to repo)
 */

const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const _ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const TENANT    = _ARGS.tenant || 'bv';
const SEASON_ID = _ARGS.season || '0869ea69';
const GRADE_ID  = _ARGS.grade  || '5afff92b';
const BASE_URL  = 'https://api.playhq.com';
const OUTPUT_FILE = path.join(__dirname, 'probe-rest-api.html');

// ─── REST probe ───────────────────────────────────────────────────────────────

async function probe(label, url, extraHeaders = {}) {
  console.log(`\n  Testing: ${label}`);
  console.log(`  URL: ${url}`);

  const headers = {
    'x-phq-tenant': TENANT,
    'origin': 'https://www.playhq.com',
    ...extraHeaders,
  };

  const variants = [
    { label: 'no key',              headers: { ...headers } },
    { label: 'tenant header only',  headers: { 'x-phq-tenant': TENANT, 'origin': 'https://www.playhq.com' } },
    { label: 'with fake key',       headers: { ...headers, 'x-api-key': 'public' } },
  ];

  const results = [];

  for (const v of variants) {
    try {
      const res = await fetch(url, { method: 'GET', headers: v.headers });
      let body = '';
      try { body = await res.text(); } catch (e) { body = '(could not read body)'; }

      // Try to pretty-print if JSON
      let bodyDisplay = body;
      let parsed = null;
      try {
        parsed = JSON.parse(body);
        bodyDisplay = JSON.stringify(parsed, null, 2);
      } catch (e) {}

      console.log(`    [${v.label}] HTTP ${res.status} — ${body.slice(0, 120)}`);
      results.push({ variant: v.label, status: res.status, body: bodyDisplay, parsed });
    } catch (e) {
      console.log(`    [${v.label}] Error: ${e.message}`);
      results.push({ variant: v.label, status: 'ERR', body: e.message, parsed: null });
    }

    // Small delay between requests
    await new Promise(r => setTimeout(r, 200));
  }

  return { label, url, results };
}

// ─── HTML generation ──────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusClass(status) {
  if (status === 200) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status === 'ERR') return 'err';
  return 'other';
}

function statusLabel(status) {
  if (status === 200) return '✅ 200 OK';
  if (status === 401) return '🔒 401 Unauthorized';
  if (status === 403) return '🔒 403 Forbidden';
  if (status === 404) return '❌ 404 Not Found';
  if (status === 400) return '⚠️ 400 Bad Request';
  if (status === 'ERR') return '💥 Error';
  return `⚠️ ${status}`;
}

function generateHtml({ tenant, seasonId, gradeId, probes, generatedAt }) {
  const probeBlocks = probes.map(p => {
    const variantRows = p.results.map(r => {
      const sc = statusClass(r.status);
      const truncBody = r.body.length > 3000 ? r.body.slice(0, 3000) + '\n\n... (truncated)' : r.body;
      return `
        <div class="variant variant-${sc}">
          <div class="variant-header">
            <span class="variant-label">${escapeHtml(r.variant)}</span>
            <span class="status status-${sc}">${statusLabel(r.status)}</span>
          </div>
          <pre class="body">${escapeHtml(truncBody)}</pre>
        </div>`;
    }).join('');

    // Determine best result for summary badge
    const best = p.results.find(r => r.status === 200);
    const summaryClass = best ? 'ok' : (p.results.some(r => r.status === 401 || r.status === 403) ? 'auth' : 'other');

    return `
    <details class="probe-block" ${best ? 'open' : ''}>
      <summary>
        <span class="probe-label">${escapeHtml(p.label)}</span>
        <span class="probe-url">${escapeHtml(p.url)}</span>
        <span class="summary-badge badge-${summaryClass}">${best ? '✅ Data returned' : (summaryClass === 'auth' ? '🔒 Auth required' : '❌ No data')}</span>
      </summary>
      <div class="variants">${variantRows}</div>
    </details>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PlayHQ REST API Probe</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; background: #f4f6f8; color: #1a1a2e; padding: 24px 16px 48px; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .meta { color: #888; font-size: 0.8rem; margin-bottom: 24px; }
  h2 { font-size: 1rem; font-weight: 700; margin: 24px 0 10px; padding-bottom: 4px; border-bottom: 2px solid #2563eb; }

  .probe-block { background: #fff; border-radius: 8px; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.07); overflow: hidden; }
  .probe-block summary { display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; user-select: none; flex-wrap: wrap; }
  .probe-block summary:hover { background: #f8fafc; }
  .probe-label { font-weight: 600; font-size: 0.9rem; min-width: 200px; }
  .probe-url { font-family: monospace; font-size: 0.75rem; color: #64748b; flex: 1; }
  .summary-badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
  .badge-ok    { background: #dcfce7; color: #166534; }
  .badge-auth  { background: #fef3c7; color: #92400e; }
  .badge-other { background: #f1f5f9; color: #475569; }

  .variants { padding: 0 14px 14px; display: flex; flex-direction: column; gap: 8px; }
  .variant { border-radius: 6px; overflow: hidden; border: 1px solid #e5e7eb; }
  .variant-ok     { border-color: #86efac; }
  .variant-auth   { border-color: #fde68a; }
  .variant-notfound { border-color: #fca5a5; }
  .variant-err    { border-color: #fca5a5; }
  .variant-other  { border-color: #e5e7eb; }

  .variant-header { display: flex; align-items: center; gap: 10px; padding: 6px 10px; background: #f8fafc; border-bottom: 1px solid #e5e7eb; }
  .variant-label { font-weight: 600; font-size: 0.8rem; }
  .status { font-size: 0.78rem; }
  .status-ok      { color: #166534; }
  .status-auth    { color: #92400e; }
  .status-notfound { color: #dc2626; }
  .status-err     { color: #dc2626; }
  .status-other   { color: #64748b; }

  pre.body { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 0.75rem; padding: 10px; overflow-x: auto; background: #fff; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; color: #1e293b; }
</style>
</head>
<body>
<h1>PlayHQ REST API Probe</h1>
<div class="meta">
  Tenant: <strong>${escapeHtml(tenant)}</strong> &nbsp;·&nbsp;
  Season: <strong>${escapeHtml(seasonId)}</strong> &nbsp;·&nbsp;
  Grade: <strong>${escapeHtml(gradeId)}</strong> &nbsp;·&nbsp;
  Generated: ${escapeHtml(generatedAt)}
</div>

<h2>Results</h2>
${probeBlocks}
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔬 PlayHQ REST API Probe');
  console.log(`   Tenant:    ${TENANT}`);
  console.log(`   Season ID: ${SEASON_ID}`);
  console.log(`   Grade ID:  ${GRADE_ID}`);

  const probes = [];

  // Season endpoints
  probes.push(await probe(
    'Teams for season',
    `${BASE_URL}/v1/seasons/${SEASON_ID}/teams`
  ));
  probes.push(await probe(
    'Grades for season',
    `${BASE_URL}/v1/seasons/${SEASON_ID}/grades`
  ));

  // Grade endpoints
  probes.push(await probe(
    'Player stats by grade (v1)',
    `${BASE_URL}/v1/grades/${GRADE_ID}/profiles/statistics`
  ));
  probes.push(await probe(
    'Fixture for grade (v1)',
    `${BASE_URL}/v1/grades/${GRADE_ID}/games`
  ));
  probes.push(await probe(
    'Fixture for grade (v2)',
    `${BASE_URL}/v2/grades/${GRADE_ID}/games`
  ));
  probes.push(await probe(
    'Ladder for grade (v1)',
    `${BASE_URL}/v1/grades/${GRADE_ID}/ladder`
  ));
  probes.push(await probe(
    'Ladder for grade (v2)',
    `${BASE_URL}/v2/grades/${GRADE_ID}/ladder`
  ));

  // Game summary — try with a known game ID from the fixture if we get one
  // (placeholder — replace with a real game ID if the fixture probe returns one)
  probes.push(await probe(
    'Game summary v2 (public) — placeholder game ID',
    `${BASE_URL}/v2/games/00000000-0000-0000-0000-000000000000/summary`
  ));

  console.log('\n📄 Generating HTML report...');
  const html = generateHtml({
    tenant: TENANT,
    seasonId: SEASON_ID,
    gradeId: GRADE_ID,
    probes,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
  });

  fs.writeFileSync(OUTPUT_FILE, html);
  console.log(`   Written to: ${OUTPUT_FILE}`);
  console.log('\n✅ Done.');
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
