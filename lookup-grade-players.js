// lookup-grade-players.js
/**
 * Fetches all players registered in a specific PlayHQ grade,
 * cross-references them against the local sharded player index,
 * and writes an HTML report to grade-lookup-result.html.
 *
 * Usage:
 *   node lookup-grade-players.js [--grade=<gradeID>]
 *
 * Defaults to GRADE_ID constant below if --grade not provided.
 */

const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_GRADE_ID = '5afff92b';
const TENANT           = 'bv';
const API_URL          = 'https://api.playhq.com/graphql';
const PAGE_SIZE        = 50;
const DELAY_MS         = 100;
const SHARDS_DIR       = path.join(__dirname, 'players-index');
const INDEX_FILE       = path.join(__dirname, 'sports-index.json');
const OUTPUT_FILE      = path.join(__dirname, 'grade-lookup-result.html');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const _ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const GRADE_ID = _ARGS.grade || DEFAULT_GRADE_ID;

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const Q_GRADE_INFO = `
query gradeInfo($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id
    name
    age { name }
    gender { name }
    season {
      id
      name
      competition {
        name
        organisation { name }
      }
    }
  }
}`;

const Q_PLAYERS = `
query publicGradeStatistics($gradeID: ID!, $filter: GradePlayerStatisticsFilter) {
  gradePlayerStatistics(gradeID: $gradeID, filter: $filter) {
    meta { page totalPages totalRecords }
    results {
      profile { id firstName lastName }
      team { name }
      statistics {
        count
        details { value }
      }
    }
  }
}`;

// ─── API helper ───────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function gql(operationName, query, variables) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'tenant':       TENANT,
      'origin':       'https://www.playhq.com',
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${operationName}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL error in ${operationName}: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// ─── Fetch grade info ─────────────────────────────────────────────────────────

async function fetchGradeInfo(gradeID) {
  try {
    const data = await gql('gradeInfo', Q_GRADE_INFO, { gradeID });
    return data.discoverGrade || null;
  } catch (e) {
    console.warn(`  ⚠ Could not fetch grade info: ${e.message}`);
    return null;
  }
}

// ─── Fetch all players in the grade ──────────────────────────────────────────

async function fetchGradePlayers(gradeID) {
  const players = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    await delay(DELAY_MS);
    console.log(`  Fetching page ${page}${totalPages > 1 ? `/${totalPages}` : ''}...`);
    const data = await gql('publicGradeStatistics', Q_PLAYERS, {
      gradeID,
      filter: {
        sort: [{ column: 'APPEARANCE', direction: 'DESC' }],
        pagination: { page, limit: PAGE_SIZE },
      },
    });
    const gps = data.gradePlayerStatistics;
    if (!gps || !gps.results) break;
    totalPages = gps.meta.totalPages;

    for (const r of gps.results) {
      if (!r.profile) continue;  // private profile — skip
      const gp = (r.statistics || []).find(s => s.details?.value === 'APPEARANCE')?.count ?? 0;
      players.push({
        uuid:      r.profile.id,
        firstName: r.profile.firstName,
        lastName:  r.profile.lastName,
        team:      r.team?.name || '',
        gp,
      });
    }
    page++;
  }

  return players;
}

// ─── Load player index (sharded or monolithic) ───────────────────────────────

// Loaded once on first lookup, then cached
let _playerIndex = null;

function loadPlayerIndex() {
  if (_playerIndex) return _playerIndex;

  if (fs.existsSync(SHARDS_DIR)) {
    // Post-migration: sharded players-index/
    console.log('  Loading sharded players-index/...');
    _playerIndex = {};
    for (const file of fs.readdirSync(SHARDS_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const shard = JSON.parse(fs.readFileSync(path.join(SHARDS_DIR, file), 'utf8'));
        Object.assign(_playerIndex, shard);
      } catch (e) {
        console.warn(`  ⚠ Could not parse shard ${file}: ${e.message}`);
      }
    }
    console.log(`  Loaded ${Object.keys(_playerIndex).length} players from shards`);
  } else if (fs.existsSync(INDEX_FILE)) {
    // Pre-migration: monolithic sports-index.json
    console.log('  Loading monolithic sports-index.json...');
    try {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      _playerIndex = raw.players || {};
      console.log(`  Loaded ${Object.keys(_playerIndex).length} players from sports-index.json`);
    } catch (e) {
      console.warn(`  ⚠ Could not parse sports-index.json: ${e.message}`);
      _playerIndex = {};
    }
  } else {
    console.warn('  ⚠ No player index found (no players-index/ and no sports-index.json)');
    _playerIndex = {};
  }

  return _playerIndex;
}

function lookupPlayer(uuid) {
  const index = loadPlayerIndex();
  return index[uuid] || null;
}

// ─── HTML generation ──────────────────────────────────────────────────────────

function profileUrl(uuid) {
  return `https://www.playhq.com/public/profile/${uuid}/statistics?tenant=bv`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateHtml({ gradeInfo, gradePlayers, matches, notFound, generatedAt }) {
  const gradeName    = gradeInfo?.name    || GRADE_ID;
  const seasonName   = gradeInfo?.season?.name || '';
  const compName     = gradeInfo?.season?.competition?.name || '';
  const orgName      = gradeInfo?.season?.competition?.organisation?.name || '';
  const subtitle     = [orgName, compName, seasonName].filter(Boolean).join(' — ');

  const matchRows = matches.map(({ gradePlayer, indexEntry }) => {
    const url = profileUrl(gradePlayer.uuid);
    const teamDisplay = gradePlayer.team.replace(/\s+U\d+(?:\.\d+)?\s*/gi, ' ').trim();
    // Career totals live at sports.Basketball on the full detail record
    const bball = indexEntry?.sports?.Basketball || {};
    const d = v => (v != null ? v : '–');
    return `
      <tr>
        <td><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(gradePlayer.firstName)} ${escapeHtml(gradePlayer.lastName)}</a></td>
        <td>${escapeHtml(teamDisplay)}</td>
        <td class="num">${d(bball.gp)}</td>
        <td class="num">${d(bball.pts)}</td>
        <td class="num">${d(bball.fg)}</td>
        <td class="num">${d(bball.ft)}</td>
        <td class="num">${d(bball.threePt)}</td>
        <td class="num">${d(bball.fouls)}</td>
      </tr>`;
  }).join('');

  const notFoundRows = notFound.map(p => {
    const url = profileUrl(p.uuid);
    const teamDisplay = p.team.replace(/\s+U\d+(?:\.\d+)?\s*/gi, ' ').trim();
    return `
      <tr>
        <td><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</a></td>
        <td>${escapeHtml(teamDisplay)}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grade Lookup — ${escapeHtml(gradeName)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    background: #f4f6f8;
    color: #1a1a2e;
    padding: 24px 16px 48px;
  }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .subtitle { color: #555; font-size: 0.9rem; margin-bottom: 6px; }
  .meta { color: #888; font-size: 0.8rem; margin-bottom: 24px; }
  .stats-bar {
    display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px;
  }
  .stat-card {
    background: #fff; border-radius: 8px; padding: 12px 20px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    text-align: center; min-width: 110px;
  }
  .stat-card .val { font-size: 1.8rem; font-weight: 700; color: #2563eb; }
  .stat-card .lbl { font-size: 0.75rem; color: #888; margin-top: 2px; }
  section { margin-bottom: 32px; }
  h2 { font-size: 1rem; font-weight: 600; margin-bottom: 10px; padding-bottom: 4px; border-bottom: 2px solid #e5e7eb; }
  h2.found { border-color: #22c55e; }
  h2.missing { border-color: #f59e0b; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.07); }
  th { background: #1e293b; color: #fff; font-weight: 600; text-align: left; padding: 9px 12px; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  th.num, td.num { text-align: right; }
  td { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; font-size: 0.875rem; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #f8fafc; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .badge-found  { display:inline-block; background:#dcfce7; color:#166534; border-radius:4px; padding:1px 7px; font-size:0.75rem; margin-left:8px; font-weight:600; }
  .badge-miss   { display:inline-block; background:#fef9c3; color:#854d0e; border-radius:4px; padding:1px 7px; font-size:0.75rem; margin-left:8px; font-weight:600; }
  .empty { color: #888; font-style: italic; padding: 12px; }
</style>
</head>
<body>
<h1>${escapeHtml(gradeName)}</h1>
<div class="subtitle">${escapeHtml(subtitle)}</div>
<div class="meta">Grade ID: ${escapeHtml(GRADE_ID)} &nbsp;·&nbsp; Generated: ${escapeHtml(generatedAt)}</div>

<div class="stats-bar">
  <div class="stat-card"><div class="val">${gradePlayers.length}</div><div class="lbl">Players in grade</div></div>
  <div class="stat-card"><div class="val">${matches.length}</div><div class="lbl">In your database</div></div>
  <div class="stat-card"><div class="val">${notFound.length}</div><div class="lbl">Not in database</div></div>
</div>

<section>
  <h2 class="found">In your database <span class="badge-found">${matches.length}</span></h2>
  ${matches.length === 0
    ? '<p class="empty">No players from this grade were found in your database.</p>'
    : `<table>
    <thead>
      <tr>
        <th>Player</th>
        <th>Team</th>
        <th class="num">GP</th>
        <th class="num">PTS</th>
        <th class="num">FG</th>
        <th class="num">FT</th>
        <th class="num">3P</th>
        <th class="num">Fouls</th>
      </tr>
    </thead>
    <tbody>${matchRows}</tbody>
  </table>`}
</section>

<section>
  <h2 class="missing">Not in database <span class="badge-miss">${notFound.length}</span></h2>
  ${notFound.length === 0
    ? '<p class="empty">All players in this grade are already in your database.</p>'
    : `<table>
    <thead>
      <tr>
        <th>Player</th>
        <th>Team</th>
      </tr>
    </thead>
    <tbody>${notFoundRows}</tbody>
  </table>`}
</section>

</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🏀 Grade Player Lookup');
  console.log(`   Grade ID: ${GRADE_ID}`);
  console.log(`   Tenant:   ${TENANT}`);
  console.log(`   Index:    ${fs.existsSync(SHARDS_DIR) ? 'players-index/ (sharded)' : 'sports-index.json (monolithic)'}`);

  if (!fs.existsSync(SHARDS_DIR) && !fs.existsSync(INDEX_FILE)) {
    console.error(`❌ No player index found — expected players-index/ or sports-index.json in ${__dirname}`);
    process.exit(1);
  }

  // 1. Fetch grade metadata
  console.log('\n📋 Fetching grade info...');
  const gradeInfo = await fetchGradeInfo(GRADE_ID);
  if (gradeInfo) {
    console.log(`   Grade:  ${gradeInfo.name}`);
    console.log(`   Season: ${gradeInfo.season?.name || '?'}`);
    console.log(`   Comp:   ${gradeInfo.season?.competition?.name || '?'}`);
  } else {
    console.log('   (Could not fetch grade metadata — continuing anyway)');
  }

  // 2. Fetch all players in the grade
  console.log('\n👥 Fetching grade players...');
  const gradePlayers = await fetchGradePlayers(GRADE_ID);
  console.log(`   Found ${gradePlayers.length} players in grade`);

  // 3. Cross-reference against sharded index
  console.log('\n🔍 Cross-referencing with local player index...');
  const matches  = [];
  const notFound = [];

  for (const p of gradePlayers) {
    const indexEntry = lookupPlayer(p.uuid);
    if (indexEntry) {
      matches.push({ gradePlayer: p, indexEntry });
    } else {
      notFound.push(p);
    }
  }

  console.log(`   ✅ In database:     ${matches.length}`);
  console.log(`   ❓ Not in database: ${notFound.length}`);

  // 4. Generate HTML
  console.log('\n📄 Generating HTML report...');
  const html = generateHtml({
    gradeInfo,
    gradePlayers,
    matches,
    notFound,
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
