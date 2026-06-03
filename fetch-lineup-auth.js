// fetch-lineup-auth.js
/**
 * Uses an auth token to fetch player lineups for all games in a grade.
 * Run immediately — token expires ~1 hour after generation.
 *
 * Usage:
 *   node fetch-lineup-auth.js --token="Bearer eyJ..."  [--grade=<id>] [--tenant=<tenant>]
 */

const fs   = require('fs');
const path = require('path');

const _ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const TOKEN    = _ARGS.token;
const TENANT   = _ARGS.tenant || 'bv';
const GRADE_ID = _ARGS.grade  || '5afff92b';
const API_URL  = 'https://api.playhq.com/graphql';
const INDEX_FILE  = path.join(__dirname, 'sports-index.json');
const PLAYERS_DIR = path.join(__dirname, 'players');
const OUTPUT_FILE = path.join(__dirname, 'lineup-result.html');

if (!TOKEN) {
  console.error('❌ --token is required');
  process.exit(1);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gql(operationName, query, variables, auth) {
  const headers = {
    'Content-Type': 'application/json',
    'tenant': TENANT,
    'origin': 'https://www.playhq.com',
  };
  if (auth) headers['authorization'] = auth;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operationName, query, variables }),
  });
  const body = await res.text(); if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0,300)}`);
  const json = JSON.parse(body);
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const Q_FIXTURE = `
query gradeAllRounds($gradeID: ID!) {
  discoverGradeFixture(gradeID: $gradeID) {
    id name
    games {
      id
      home { ... on DiscoverTeam { id name } ... on ProvisionalTeam { name } }
      away { ... on DiscoverTeam { id name } ... on ProvisionalTeam { name } }
    }
  }
}`;

const Q_GAME_VIEW = `
query gameView($gameId: ID!) {
  discoverGame(gameID: $gameId) {
    id publishLineup
    home { ... on DiscoverTeam { id name } }
    away { ... on DiscoverTeam { id name } }
    statistics {
      home { players { playerNumber player {
        ... on DiscoverParticipant { id profile { id firstName lastName } hasSeasonPermit }
        ... on DiscoverParticipantFillInPlayer { id profile { id firstName lastName } hasSeasonPermit }
        ... on DiscoverGamePermitFillInPlayer { id profile { id firstName lastName } }
        ... on DiscoverAnonymousParticipant { id name hasSeasonPermit }
      }}}
      away { players { playerNumber player {
        ... on DiscoverParticipant { id profile { id firstName lastName } hasSeasonPermit }
        ... on DiscoverParticipantFillInPlayer { id profile { id firstName lastName } hasSeasonPermit }
        ... on DiscoverGamePermitFillInPlayer { id profile { id firstName lastName } }
        ... on DiscoverAnonymousParticipant { id name hasSeasonPermit }
      }}}
    }
  }
}`;

// ─── Player index lookup ──────────────────────────────────────────────────────

let _index = null;
function lookupPlayer(uuid) {
  if (!uuid) return null;
  if (!_index) {
    if (fs.existsSync(PLAYERS_DIR)) {
      _index = {};
      const prefix = uuid.slice(0, 2);
      const shardFile = path.join(PLAYERS_DIR, prefix, `${uuid}.json`);
      // Load on demand per UUID — don't load all shards
    }
    if (!_index && fs.existsSync(INDEX_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
        _index = raw.players || {};
      } catch (e) { _index = {}; }
    }
    if (!_index) _index = {};
  }
  return _index[uuid] || null;
}

function lookupPlayerFile(uuid) {
  if (!uuid) return null;
  // Try players/{xx}/{uuid}.json first
  const prefix = uuid.slice(0, 2);
  const detailFile = path.join(PLAYERS_DIR, prefix, `${uuid}.json`);
  if (fs.existsSync(detailFile)) {
    try { return JSON.parse(fs.readFileSync(detailFile, 'utf8')); } catch (e) {}
  }
  // Fall back to sports-index
  return lookupPlayer(uuid);
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function profileUrl(uuid) {
  return `https://www.playhq.com/public/profile/${uuid}/statistics?tenant=bv`;
}

function generateHtml({ gradeId, tenant, teams, generatedAt }) {
  // teams: Map of teamName -> { teamId, players: [{uuid, name, number, inDb, dbEntry}] }
  const teamBlocks = [...teams.entries()].map(([teamName, { teamId, players }]) => {
    const inDb    = players.filter(p => p.inDb);
    const notInDb = players.filter(p => !p.inDb);

    const rows = players.map(p => {
      const bball = p.dbEntry?.sports?.Basketball || {};
      const d = v => (v != null ? v : '–');
      return `<tr class="${p.inDb ? 'in-db' : 'not-db'}">
        <td>${escapeHtml(p.number || '–')}</td>
        <td>${p.uuid
          ? `<a href="${escapeHtml(profileUrl(p.uuid))}" target="_blank">${escapeHtml(p.name)}</a>`
          : escapeHtml(p.name)}</td>
        <td class="mono">${escapeHtml(p.uuid || '–')}</td>
        <td>${p.inDb ? '✅' : '❌'}</td>
        <td class="num">${d(bball.gp)}</td>
        <td class="num">${d(bball.pts)}</td>
        <td class="num">${d(bball.fg)}</td>
        <td class="num">${d(bball.ft)}</td>
        <td class="num">${d(bball.threePt)}</td>
        <td class="num">${d(bball.fouls)}</td>
      </tr>`;
    }).join('');

    return `
    <div class="team-block">
      <div class="team-header">
        <span class="team-name">${escapeHtml(teamName)}</span>
        <span class="team-counts">
          <span class="badge-db">${inDb.length} in DB</span>
          <span class="badge-new">${notInDb.length} not in DB</span>
          <span class="badge-total">${players.length} total</span>
        </span>
      </div>
      <table>
        <thead><tr>
          <th>#</th><th>Player</th><th class="mono">UUID</th><th>In DB</th>
          <th class="num">GP</th><th class="num">PTS</th><th class="num">FG</th>
          <th class="num">FT</th><th class="num">3P</th><th class="num">Fouls</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  const allPlayers  = [...teams.values()].flatMap(t => t.players);
  const uniqueUuids = new Set(allPlayers.map(p => p.uuid).filter(Boolean));
  const inDbCount   = allPlayers.filter(p => p.inDb).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grade Lineup — ${escapeHtml(gradeId)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; background: #f4f6f8; color: #1a1a2e; padding: 24px 16px 48px; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .meta { color: #888; font-size: 0.8rem; margin-bottom: 16px; }
  .stats-bar { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
  .stat-card { background: #fff; border-radius: 8px; padding: 10px 18px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); text-align: center; }
  .stat-card .val { font-size: 1.6rem; font-weight: 700; color: #2563eb; }
  .stat-card .lbl { font-size: 0.72rem; color: #888; }
  .team-block { background: #fff; border-radius: 8px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.07); overflow: hidden; }
  .team-header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #1e293b; flex-wrap: wrap; }
  .team-name { font-weight: 700; color: #fff; font-size: 1rem; flex: 1; }
  .team-counts { display: flex; gap: 6px; }
  .badge-db   { background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 600; }
  .badge-new  { background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 600; }
  .badge-total{ background: #e0e7ff; color: #3730a3; padding: 2px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th { background: #f1f5f9; color: #475569; text-align: left; padding: 7px 12px; font-size: 0.72rem; text-transform: uppercase; }
  th.num, td.num { text-align: right; }
  td { padding: 6px 12px; border-bottom: 1px solid #f1f5f9; }
  tr:last-child td { border-bottom: none; }
  tr.in-db:hover td { background: #f0fdf4; }
  tr.not-db:hover td { background: #fffbeb; }
  td.mono { font-family: monospace; font-size: 0.7rem; color: #94a3b8; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<h1>Grade Lineup — Boys Under 14 D3</h1>
<div class="meta">Grade: <strong>${escapeHtml(gradeId)}</strong> &nbsp;·&nbsp; Tenant: <strong>${escapeHtml(tenant)}</strong> &nbsp;·&nbsp; Generated: ${escapeHtml(generatedAt)}</div>

<div class="stats-bar">
  <div class="stat-card"><div class="val">${teams.size}</div><div class="lbl">Teams</div></div>
  <div class="stat-card"><div class="val">${uniqueUuids.size}</div><div class="lbl">Unique players</div></div>
  <div class="stat-card"><div class="val">${inDbCount}</div><div class="lbl">In your database</div></div>
  <div class="stat-card"><div class="val">${uniqueUuids.size - inDbCount}</div><div class="lbl">Not in database</div></div>
</div>

${teamBlocks}
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔐 Authenticated Lineup Fetch');
  console.log(`   Grade:  ${GRADE_ID}`);
  console.log(`   Tenant: ${TENANT}`);

  // 1. Fetch fixture to get all game IDs
  console.log('\n📋 Fetching grade fixture...');
  const fixtureData = await gql('gradeAllRounds', Q_FIXTURE, { gradeID: GRADE_ID }, null);
  const rounds = fixtureData.discoverGradeFixture || [];
  const allGames = rounds.flatMap(r =>
    (r.games || []).map(g => ({ ...g, roundName: r.name }))
  );
  console.log(`   ${rounds.length} rounds, ${allGames.length} games`);

  // 2. Fetch gameView for each game using auth token
  console.log('\n🔍 Fetching lineups with auth...');

  // Collect unique players per team
  const teams = new Map(); // teamName -> { teamId, players: [] }

  for (const game of allGames) {
    await delay(150);
    try {
      const data = await gql('gameView', Q_GAME_VIEW, {
        gameId: game.id,
        
      }, TOKEN);

      const dg = data.discoverGame;
      const homeName = dg?.home?.name || game.home?.name || 'Unknown';
      const awayName = dg?.away?.name || game.away?.name || 'Unknown';
      const homeId   = dg?.home?.id || game.home?.id;
      const awayId   = dg?.away?.id || game.away?.id;

      console.log(`   ${game.roundName}: ${homeName} vs ${awayName} — publishLineup: ${dg?.publishLineup}`);

      for (const [side, sideName, sideId, sideData] of [
        ['home', homeName, homeId, dg?.statistics?.home],
        ['away', awayName, awayId, dg?.statistics?.away],
      ]) {
        if (!teams.has(sideName)) teams.set(sideName, { teamId: sideId, players: [] });
        const team = teams.get(sideName);

        for (const p of sideData?.players || []) {
          const player  = p.player;
          if (!player) continue;
          const uuid    = player.profile?.id || null;
          const name    = player.profile
            ? `${player.profile.firstName} ${player.profile.lastName}`
            : (player.name || 'Unknown');

          // Avoid duplicates within a team
          if (uuid && team.players.find(x => x.uuid === uuid)) continue;

          const dbEntry = lookupPlayerFile(uuid);
          team.players.push({
            uuid,
            name,
            number:  p.playerNumber,
            inDb:    !!dbEntry,
            dbEntry,
          });
        }
      }
    } catch (e) {
      console.warn(`   ⚠ ${game.roundName} game ${game.id}: ${e.message}`);
    }
  }

  // 3. Summary
  const allPlayers  = [...teams.values()].flatMap(t => t.players);
  const uniqueUuids = new Set(allPlayers.map(p => p.uuid).filter(Boolean));
  console.log(`\n📊 Summary:`);
  console.log(`   Teams found:    ${teams.size}`);
  console.log(`   Unique players: ${uniqueUuids.size}`);
  console.log(`   In database:    ${allPlayers.filter(p => p.inDb).length}`);

  // 4. Generate HTML
  console.log('\n📄 Generating HTML...');
  const html = generateHtml({
    gradeId: GRADE_ID,
    tenant: TENANT,
    teams,
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
