// probe-lineup.js
/**
 * Fetches all scheduled games in a grade, then queries gameView for each
 * looking for published lineups with player profileIDs.
 *
 * Usage:
 *   node probe-lineup.js [--grade=<gradeID>] [--tenant=<tenant>]
 *
 * Output: probe-lineup.html
 */

const fs   = require('fs');
const path = require('path');

const _ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const TENANT      = _ARGS.tenant || 'bv';
const GRADE_ID    = _ARGS.grade  || '5afff92b';
const API_URL     = 'https://api.playhq.com/graphql';
const OUTPUT_FILE = path.join(__dirname, 'probe-lineup.html');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gql(operationName, query, variables) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'tenant': TENANT, 'origin': 'https://www.playhq.com' },
    body: JSON.stringify({ operationName, query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const Q_FIXTURE = `
query gradeAllRounds($gradeID: ID!) {
  discoverGradeFixture(gradeID: $gradeID) {
    id
    name
    games {
      id
      date
      status { name value }
      home {
        ... on DiscoverTeam { id name }
        ... on ProvisionalTeam { name }
      }
      away {
        ... on DiscoverTeam { id name }
        ... on ProvisionalTeam { name }
      }
    }
  }
}`;

const Q_GAME_VIEW = `
query gameView($gameId: ID!, $gameStatisticsFilter: GameStatisticsFilter!) {
  discoverGame(gameID: $gameId) {
    id
    publishLineup
    status { name value }
    statistics {
      home {
        players {
          playerNumber
          player {
            ... on DiscoverParticipant {
              id
              profile { id firstName lastName }
              hasSeasonPermit
            }
            ... on DiscoverParticipantFillInPlayer {
              id
              profile { id firstName lastName }
            }
            ... on DiscoverGamePermitFillInPlayer {
              id
              profile { id firstName lastName }
            }
            ... on DiscoverAnonymousParticipant {
              id
              name
              hasSeasonPermit
            }
          }
        }
      }
      away {
        players {
          playerNumber
          player {
            ... on DiscoverParticipant {
              id
              profile { id firstName lastName }
              hasSeasonPermit
            }
            ... on DiscoverParticipantFillInPlayer {
              id
              profile { id firstName lastName }
            }
            ... on DiscoverGamePermitFillInPlayer {
              id
              profile { id firstName lastName }
            }
            ... on DiscoverAnonymousParticipant {
              id
              name
              hasSeasonPermit
            }
          }
        }
      }
    }
  }
}`;

// ─── HTML ─────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function generateHtml({ gradeId, tenant, gameResults, generatedAt }) {
  const totalPlayers = gameResults.reduce((n, g) => n + g.players.length, 0);
  const uniqueUuids  = new Set(gameResults.flatMap(g => g.players.map(p => p.uuid).filter(Boolean)));

  const gameBlocks = gameResults.map(g => {
    const playerRows = g.players.map(p => `
      <tr>
        <td>${escapeHtml(p.side)}</td>
        <td>${escapeHtml(p.number || '–')}</td>
        <td>${p.uuid
          ? `<a href="https://www.playhq.com/public/profile/${escapeHtml(p.uuid)}/statistics?tenant=bv" target="_blank">${escapeHtml(p.name)}</a>`
          : escapeHtml(p.name)}</td>
        <td class="mono">${escapeHtml(p.uuid || '(no profileID)')}</td>
        <td>${escapeHtml(p.type)}</td>
      </tr>`).join('');

    return `
    <details class="game-block" ${g.players.length > 0 ? 'open' : ''}>
      <summary>
        <span class="game-label">${escapeHtml(g.roundName)} — ${escapeHtml(g.home)} vs ${escapeHtml(g.away)}</span>
        <span class="game-status">${escapeHtml(g.status)}</span>
        <span class="game-lineup ${g.publishLineup ? 'lineup-yes' : 'lineup-no'}">${g.publishLineup ? '📋 Lineup published' : '📋 No lineup'}</span>
        <span class="player-count">${g.players.length} players</span>
      </summary>
      ${g.players.length > 0 ? `
      <table>
        <thead><tr><th>Side</th><th>#</th><th>Player</th><th>Profile UUID</th><th>Type</th></tr></thead>
        <tbody>${playerRows}</tbody>
      </table>` : '<p class="empty">No player data returned for this game.</p>'}
      ${g.rawJson ? `<details class="raw"><summary>Raw JSON</summary><pre>${escapeHtml(g.rawJson)}</pre></details>` : ''}
    </details>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lineup Probe — ${escapeHtml(gradeId)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; background: #f4f6f8; color: #1a1a2e; padding: 24px 16px 48px; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .meta { color: #888; font-size: 0.8rem; margin-bottom: 16px; }
  .stats-bar { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat-card { background: #fff; border-radius: 8px; padding: 10px 18px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); text-align: center; }
  .stat-card .val { font-size: 1.6rem; font-weight: 700; color: #2563eb; }
  .stat-card .lbl { font-size: 0.72rem; color: #888; }
  .game-block { background: #fff; border-radius: 8px; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.07); overflow: hidden; }
  .game-block summary { display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; flex-wrap: wrap; }
  .game-block summary:hover { background: #f8fafc; }
  .game-label { font-weight: 600; flex: 1; }
  .game-status { font-size: 0.75rem; color: #64748b; }
  .game-lineup { font-size: 0.75rem; }
  .lineup-yes { color: #166534; }
  .lineup-no  { color: #94a3b8; }
  .player-count { font-size: 0.75rem; background: #e0e7ff; color: #3730a3; padding: 1px 7px; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin: 0 14px 14px; width: calc(100% - 28px); }
  th { background: #1e293b; color: #fff; text-align: left; padding: 6px 10px; font-size: 0.75rem; text-transform: uppercase; }
  td { padding: 5px 10px; border-bottom: 1px solid #f1f5f9; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #f8fafc; }
  td.mono { font-family: monospace; font-size: 0.72rem; color: #64748b; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #888; font-style: italic; padding: 10px 14px; }
  details.raw summary { font-size: 0.75rem; color: #888; cursor: pointer; padding: 4px 14px; }
  details.raw pre { font-size: 0.7rem; padding: 10px 14px; background: #f8fafc; overflow-x: auto; max-height: 300px; overflow-y: auto; }
</style>
</head>
<body>
<h1>Lineup Probe</h1>
<div class="meta">Grade: <strong>${escapeHtml(gradeId)}</strong> &nbsp;·&nbsp; Tenant: <strong>${escapeHtml(tenant)}</strong> &nbsp;·&nbsp; Generated: ${escapeHtml(generatedAt)}</div>

<div class="stats-bar">
  <div class="stat-card"><div class="val">${gameResults.length}</div><div class="lbl">Games probed</div></div>
  <div class="stat-card"><div class="val">${gameResults.filter(g => g.publishLineup).length}</div><div class="lbl">Lineups published</div></div>
  <div class="stat-card"><div class="val">${totalPlayers}</div><div class="lbl">Player records</div></div>
  <div class="stat-card"><div class="val">${uniqueUuids.size}</div><div class="lbl">Unique UUIDs</div></div>
</div>

${gameBlocks || '<p style="color:#888;font-style:italic">No games found in this grade.</p>'}
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔬 Lineup Probe');
  console.log(`   Grade:  ${GRADE_ID}`);
  console.log(`   Tenant: ${TENANT}`);

  // 1. Fetch all games in grade
  console.log('\n📋 Fetching grade fixture...');
  const fixtureData = await gql('gradeAllRounds', Q_FIXTURE, { gradeID: GRADE_ID });
  const rounds = fixtureData.discoverGradeFixture || [];
  const allGames = rounds.flatMap(r => (r.games || []).map(g => ({ ...g, roundName: r.name })));
  console.log(`   Rounds: ${rounds.length}, Games: ${allGames.length}`);

  // 2. Query gameView for each game
  console.log('\n🔍 Probing each game for lineup data...');
  const gameResults = [];

  for (const game of allGames) {
    await delay(150);
    const homeName = game.home?.name || 'TBD';
    const awayName = game.away?.name || 'TBD';
    console.log(`   ${game.roundName} — ${homeName} vs ${awayName} (${game.id})`);

    let publishLineup = false;
    let players = [];
    let rawJson = null;

    try {
      const data = await gql('gameView', Q_GAME_VIEW, {
        gameId: game.id,
        gameStatisticsFilter: { classification: 'TOTAL' },
      });
      const dg = data.discoverGame;
      publishLineup = dg?.publishLineup || false;
      rawJson = JSON.stringify(dg, null, 2);

      // Extract players from both sides
      for (const [side, sideData] of [['Home', dg?.statistics?.home], ['Away', dg?.statistics?.away]]) {
        for (const p of sideData?.players || []) {
          const player = p.player;
          if (!player) continue;
          const uuid  = player.profile?.id || null;
          const name  = player.profile ? `${player.profile.firstName} ${player.profile.lastName}` : (player.name || 'Unknown');
          const type  = player.__typename || '';
          players.push({ side, number: p.playerNumber, uuid, name, type });
        }
      }

      console.log(`     publishLineup: ${publishLineup}, players: ${players.length}`);
    } catch (e) {
      console.warn(`     ⚠ Error: ${e.message}`);
      rawJson = `Error: ${e.message}`;
    }

    gameResults.push({
      id: game.id,
      roundName: game.roundName,
      home: homeName,
      away: awayName,
      status: game.status?.name || '?',
      publishLineup,
      players,
      rawJson,
    });
  }

  // 3. Summary
  const withLineup  = gameResults.filter(g => g.publishLineup);
  const withPlayers = gameResults.filter(g => g.players.length > 0);
  console.log(`\n📊 Summary:`);
  console.log(`   Games with publishLineup=true: ${withLineup.length}`);
  console.log(`   Games with player data:        ${withPlayers.length}`);
  console.log(`   Total player records:          ${gameResults.reduce((n, g) => n + g.players.length, 0)}`);

  // 4. Generate HTML
  console.log('\n📄 Generating HTML...');
  const html = generateHtml({
    gradeId: GRADE_ID,
    tenant: TENANT,
    gameResults,
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
