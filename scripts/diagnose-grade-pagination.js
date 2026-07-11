// scripts/diagnose-grade-pagination.js
//
// READ-ONLY. Verifies a correction to playhq_api_reference.md before trusting
// it: the doc claims gradePlayerStatistics is "Hard cap: 50 results. No
// pagination." Mark's correction says that's wrong — the query just omitted
// the $filter argument; the field is paginated via filter.pagination, and 50
// is the per-page limit, not a total cap.
//
// This does NOT blindly adopt the corrected query text as given. It MERGES
// two verbatim-sourced pieces rather than hand-writing anything:
//   - team { id name } / profile { id firstName lastName } / statistics —
//     this exact selection was already proven live this session (JOB 1 of
//     diagnose-namespace-mismatch.js, against this SAME grade, c952bf59).
//     Mark's corrected query only requested team { name } (no id) — dropping
//     id would break every matcher in this project that filters by team.id,
//     so id is kept rather than silently removed on an unverified assumption.
//   - filter($sort, $pagination) / meta{page totalPages totalRecords} /
//     ranking — new, from Mark's correction, copied verbatim.
//
// Checks, against the known grade c952bf59 ("Wednesday U16 Boys D2"):
//   1. Page 1 with filter — does meta report totalPages/totalRecords, and do
//      the 3 known players (Mallen/Raynor/Delaney) still resolve correctly?
//   2. Page 2 — does it exist, and does it contain genuinely NEW players
//      (rankings 51+) not present on page 1? This is the material question:
//      if true, gradePlayerStatistics stops being capped at the top 50 and
//      becomes usable for far more of the backlog than previously assumed.
//
// Usage:
//   node scripts/diagnose-grade-pagination.js

'use strict';

const https  = require('https');
const crypto = require('crypto');

const API_URL = 'https://api.playhq.com/graphql';
const GRADE_ID = 'c952bf59';

const KNOWN = [
  { name: 'William Mallen', apiId: '50705b28-20b1-4fcd-bed4-fa01f90f3d87' },
  { name: 'Charlie Raynor', apiId: '69e32567-5a8d-425d-8fda-6f654d29ab7e' },
  { name: 'Jack Delaney',   apiId: '1cf5a2ba-98c0-43d6-b1dd-9c3dbb2251c5' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP transport — copied verbatim from fetch-profile-stats.js ───────────
function doFetch(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body   = options.body || '';
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'POST',
      headers:  { ...options.headers, 'content-length': Buffer.byteLength(body) },
      agent:    new https.Agent({ keepAlive: false }),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          rawCookies: res.headers['set-cookie'],
          text: () => Promise.resolve(rawBody),
          json: () => { try { return Promise.resolve(JSON.parse(rawBody)); } catch (e) { return Promise.reject(e); } },
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const HEADERS_BASE = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];
let apiCookie = null;
async function refreshApiSession() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 5000);
    for (const body of COOKIE_QUERIES) {
      const res = await doFetch(API_URL, { headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() }, body: JSON.stringify(body) });
      const raw = res.rawCookies;
      if (!raw) continue;
      const parts = (Array.isArray(raw) ? raw : [raw]).map(c => c.split(';')[0].trim());
      const get = n => parts.find(c => c.startsWith(n + '=')) || null;
      const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
      if (!tier || !session || !sub) continue;
      apiCookie = `${tier}; ${session}; ${sub}`;
      console.log(`  api session refreshed (attempt ${attempt})`);
      return;
    }
  }
  throw new Error('Failed to obtain api session after 10 attempts');
}

// Merged query: proven selection set (team{id name}, profile{...}, statistics)
// + Mark's correction (filter arg, meta, ranking). The auxiliary
// tenantConfiguration.statistics block from Mark's version (used to discover
// valid sort columns) is included too since it's harmless and informative,
// but not required for the pagination mechanics being tested here.
const QUERY = `query publicGradeStatistics($gradeID: ID!, $filter: GradePlayerStatisticsFilter) {
  tenantConfiguration {
    statistics {
      enabled
      publicGradeStatisticsMeta { value name shortName }
    }
  }
  gradePlayerStatistics(gradeID: $gradeID, filter: $filter) {
    meta { page totalPages totalRecords }
    results {
      ranking
      profile { id firstName lastName }
      team { id name }
      statistics { count details { value } }
    }
  }
}`;

async function fetchGradePage(gradeID, page, limit = 50) {
  const body = {
    operationName: 'publicGradeStatistics',
    variables: {
      gradeID,
      filter: { sort: [{ column: 'APPEARANCE', direction: 'DESC' }], pagination: { page, limit } },
    },
    query: QUERY,
  };
  const res = await doFetch(API_URL, {
    headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': apiCookie },
    body: JSON.stringify(body),
  });
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch (_) {}
    return { status: (b.includes('DOCTYPE') || b.includes('Request blocked')) ? 'blocked' : 'error' };
  }
  if (!res.ok) return { status: 'error', http: res.status };
  let json; try { json = await res.json(); } catch (e) { return { status: 'error', err: e.message }; }
  if (json.errors && json.errors.length) return { status: 'error', err: json.errors[0]?.message };
  const data = json.data || json;
  return { status: 'ok', meta: data?.gradePlayerStatistics?.meta || null, results: data?.gradePlayerStatistics?.results || [], sortColumns: data?.tenantConfiguration?.statistics?.publicGradeStatisticsMeta || null };
}

async function main() {
  console.log('diagnose-grade-pagination.js  (READ-ONLY — no writes)');
  console.log('─'.repeat(64));
  console.log(`Verifying corrected gradePlayerStatistics pagination against grade ${GRADE_ID}\n`);

  await refreshApiSession();

  console.log('── Page 1 (filter.pagination = {page:1, limit:50}) ──');
  const p1 = await fetchGradePage(GRADE_ID, 1);
  if (p1.status !== 'ok') {
    console.log(`  ⚠ Page 1 failed: status=${p1.status} ${p1.err || p1.http || ''}`);
    console.log('\nCannot proceed — stopping here.');
    return;
  }
  console.log(`  meta: page=${p1.meta?.page} totalPages=${p1.meta?.totalPages} totalRecords=${p1.meta?.totalRecords}`);
  console.log(`  results returned: ${p1.results.length}`);
  if (p1.sortColumns) {
    console.log(`  valid sort columns (tenantConfiguration.statistics.publicGradeStatisticsMeta): ${p1.sortColumns.map(c => c.value).join(', ')}`);
  }

  console.log('\n  Known-player check (rankings within page 1):');
  const page1Ids = new Set(p1.results.map(r => r.profile?.id));
  for (const k of KNOWN) {
    const hit = p1.results.find(r => r.profile?.id === k.apiId);
    console.log(`    ${k.name}: ${hit ? `FOUND (ranking=${hit.ranking}, team=${hit.team?.name}, team.id=${hit.team?.id || 'MISSING'})` : 'not on page 1'}`);
  }
  const teamIdPresent = p1.results.length > 0 && p1.results.every(r => r.team?.id);
  console.log(`\n  team.id present on every page-1 result: ${teamIdPresent ? 'YES' : 'NO — team.id missing on at least one result!'}`);

  if (!p1.meta?.totalPages || p1.meta.totalPages <= 1) {
    console.log('\n  totalPages <= 1 for this grade — no page 2 to test. Pagination mechanics unconfirmed by this grade alone.');
    return;
  }

  console.log(`\n── Page 2 (filter.pagination = {page:2, limit:50}) ──`);
  const p2 = await fetchGradePage(GRADE_ID, 2);
  if (p2.status !== 'ok') {
    console.log(`  ⚠ Page 2 failed: status=${p2.status} ${p2.err || p2.http || ''}`);
    return;
  }
  console.log(`  meta: page=${p2.meta?.page} totalPages=${p2.meta?.totalPages} totalRecords=${p2.meta?.totalRecords}`);
  console.log(`  results returned: ${p2.results.length}`);
  const rankings = p2.results.map(r => r.ranking).filter(r => r != null);
  console.log(`  ranking range on page 2: ${rankings.length ? `${Math.min(...rankings)}–${Math.max(...rankings)}` : '(no rankings returned)'}`);

  const newOnPage2 = p2.results.filter(r => r.profile?.id && !page1Ids.has(r.profile.id));
  console.log(`  players on page 2 NOT present on page 1: ${newOnPage2.length} of ${p2.results.length}`);
  if (newOnPage2.length) {
    console.log('  sample new players:');
    for (const r of newOnPage2.slice(0, 5)) {
      console.log(`    ranking=${r.ranking}  ${r.profile.firstName} ${r.profile.lastName}  team=${r.team?.name}`);
    }
  }

  console.log('\n══ verdict ══════════════════════════════════════════════════');
  const paginationReal = p1.meta?.totalRecords > 50 && newOnPage2.length > 0;
  console.log(`  totalRecords (${p1.meta?.totalRecords}) > 50 AND page 2 has new players: ${paginationReal ? 'YES — correction CONFIRMED live' : 'NO — correction NOT confirmed by this grade'}`);
  console.log('  Done (nothing was written).');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
