// lookup-grade-players.js
/**
 * Searches all player detail files for registrations in a specific PlayHQ
 * season/competition, then fetches grade info for display context.
 *
 * Usage:
 *   node lookup-grade-players.js [--season=<seasonID>] [--grade=<gradeID>]
 *
 * Defaults to the constants below if args not provided.
 * --grade is used only for the page title/context (fetched from API).
 * --season is the competition season ID to search for in player records.
 */

const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_SEASON_ID = '0869ea69';
const DEFAULT_GRADE_ID  = '5afff92b';   // used for display context only
const TENANT            = 'bv';
const API_URL           = 'https://api.playhq.com/graphql';
const DELAY_MS          = 100;
const PLAYERS_DIR       = path.join(__dirname, 'players');
const SHARDS_DIR        = path.join(__dirname, 'players-index');
const INDEX_FILE        = path.join(__dirname, 'sports-index.json');
const OUTPUT_FILE       = path.join(__dirname, 'grade-lookup-result.html');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const _ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const SEASON_ID = _ARGS.season || DEFAULT_SEASON_ID;
const GRADE_ID  = _ARGS.grade  || DEFAULT_GRADE_ID;

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

// ─── Fetch grade display info ─────────────────────────────────────────────────

async function fetchGradeInfo(gradeID) {
  try {
    const data = await gql('gradeInfo', Q_GRADE_INFO, { gradeID });
    return data.discoverGrade || null;
  } catch (e) {
    console.warn(`  ⚠ Could not fetch grade info: ${e.message}`);
    return null;
  }
}

// ─── Search player detail files ───────────────────────────────────────────────

function getAllPlayerDetailPaths() {
  // players/{xx}/{uuid}.json  — two-level sharding by first 2 chars of UUID
  const paths = [];
  if (!fs.existsSync(PLAYERS_DIR)) return paths;
  for (const shard of fs.readdirSync(PLAYERS_DIR)) {
    const shardPath = path.join(PLAYERS_DIR, shard);
    if (!fs.statSync(shardPath).isDirectory()) continue;
    for (const file of fs.readdirSync(shardPath)) {
      if (file.endsWith('.json')) paths.push(path.join(shardPath, file));
    }
  }
  return paths;
}

function searchPlayersForSeason(seasonId) {
  const allPaths = getAllPlayerDetailPaths();
  console.log(`  Scanning ${allPaths.length} player files...`);

  const found = [];
  let scanned = 0;

  for (const filePath of allPaths) {
    scanned++;
    if (scanned % 10000 === 0) console.log(`  ... ${scanned}/${allPaths.length}`);

    let player;
    try {
      player = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      continue;  // skip unreadable files
    }

    const seasons = player.seasons || [];
    const match = seasons.find(s => s.sid === seasonId);
    if (!match) continue;

    // Collect all registrations for this season
    const regs = match.regs || [];
    found.push({ player, seasonEntry: match, regs });
  }

  return found;
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

function generateHtml({ gradeInfo, found, generatedAt }) {
  const gradeName  = gradeInfo?.name || GRADE_ID;
  const seasonName = gradeInfo?.season?.name || '';
  const compName   = gradeInfo?.season?.competition?.name || '';
  const orgName    = gradeInfo?.season?.competition?.organisation?.name || '';
  const subtitle   = [orgName, compName, seasonName].filter(Boolean).join(' — ');

  const rows = found.map(({ player, regs }) => {
    const url   = profileUrl(player.uuid);
    const bball = player.sports?.Basketball || {};
    const d     = v => (v != null ? v : '–');

    // Team(s) registered in this season
    const teams = [...new Set(regs.map(r => r.tn).filter(Boolean))].join(', ');

    return `
      <tr>
        <td><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(player.name)}</a></td>
        <td>${escapeHtml(teams)}</td>
        <td class="num">${d(bball.gp)}</td>
        <td class="num">${d(bball.pts)}</td>
        <td class="num">${d(bball.fg)}</td>
        <td class="num">${d(bball.ft)}</td>
        <td class="num">${d(bball.threePt)}</td>
        <td class="num">${d(bball.fouls)}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Season Lookup — ${escapeHtml(gradeName)}</title>
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
  .stats-bar { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .stat-card {
    background: #fff; border-radius: 8px; padding: 12px 20px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    text-align: center; min-width: 110px;
  }
  .stat-card .val { font-size: 1.8rem; font-weight: 700; color: #2563eb; }
  .stat-card .lbl { font-size: 0.75rem; color: #888; margin-top: 2px; }
  section { margin-bottom: 32px; }
  h2 { font-size: 1rem; font-weight: 600; margin-bottom: 10px; padding-bottom: 4px; border-bottom: 2px solid #22c55e; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.07); }
  th { background: #1e293b; color: #fff; font-weight: 600; text-align: left; padding: 9px 12px; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  th.num, td.num { text-align: right; }
  td { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; font-size: 0.875rem; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #f8fafc; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #888; font-style: italic; padding: 12px; }
  .note { background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 10px 14px; font-size: 0.8rem; color: #92400e; margin-bottom: 20px; }
</style>
</head>
<body>
<h1>${escapeHtml(gradeName)}</h1>
<div class="subtitle">${escapeHtml(subtitle)}</div>
<div class="meta">Season ID: ${escapeHtml(SEASON_ID)} &nbsp;·&nbsp; Grade ID: ${escapeHtml(GRADE_ID)} &nbsp;·&nbsp; Generated: ${escapeHtml(generatedAt)}</div>

<div class="stats-bar">
  <div class="stat-card"><div class="val">${found.length}</div><div class="lbl">Players found</div></div>
</div>

<p class="note">Stats shown are career totals from your database. This season has not yet commenced.</p>

<section>
  <h2>Players registered in this season</h2>
  ${found.length === 0
    ? '<p class="empty">No players in your database are registered for this season.</p>'
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
    <tbody>${rows}</tbody>
  </table>`}
</section>

</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🏀 Season Player Lookup');
  console.log(`   Season ID: ${SEASON_ID}`);
  console.log(`   Grade ID:  ${GRADE_ID}`);
  console.log(`   Tenant:    ${TENANT}`);
  console.log(`   Players:   ${PLAYERS_DIR}`);

  if (!fs.existsSync(PLAYERS_DIR)) {
    console.error(`❌ players/ directory not found at ${PLAYERS_DIR}`);
    process.exit(1);
  }

  // 1. Fetch grade display info
  console.log('\n📋 Fetching grade info...');
  const gradeInfo = await fetchGradeInfo(GRADE_ID);
  if (gradeInfo) {
    console.log(`   Grade:  ${gradeInfo.name}`);
    console.log(`   Season: ${gradeInfo.season?.name || '?'}`);
    console.log(`   Comp:   ${gradeInfo.season?.competition?.name || '?'}`);
  } else {
    console.log('   (Could not fetch grade metadata — continuing anyway)');
  }

  // 2. Search player detail files for this season
  console.log(`\n🔍 Searching player files for season ${SEASON_ID}...`);
  const found = searchPlayersForSeason(SEASON_ID);
  console.log(`   Found ${found.length} players registered in this season`);

  // 3. Generate HTML
  console.log('\n📄 Generating HTML report...');
  const html = generateHtml({
    gradeInfo,
    found,
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
