// probe-team-members.js
/**
 * Calls profileHistory with auth and expands the DiscoverTeam branch
 * to see if it exposes other registered team members.
 *
 * Usage:
 *   node probe-team-members.js --token="Bearer eyJ..."
 *
 * Output: probe-team-members.html
 */

const fs   = require('fs');
const path = require('path');

const _ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const TOKEN       = _ARGS.token;
const TENANT      = _ARGS.tenant || 'bv';
const API_URL     = 'https://api.playhq.com/graphql';
const INDEX_FILE  = path.join(__dirname, 'sports-index.json');
const PLAYERS_DIR = path.join(__dirname, 'players');
const OUTPUT_FILE = path.join(__dirname, 'probe-team-members.html');

if (!TOKEN) {
  console.error('❌ --token is required');
  process.exit(1);
}

async function gql(operationName, query, variables = {}, auth = null) {
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
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  const json = JSON.parse(body);
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// Maximally expanded profileHistory — try every possible field on DiscoverTeam
// that might expose other participants
const Q_PROFILE_HISTORY = `
query profileHistory {
  account {
    id
    profile {
      ...HistoryFragment
      dependants {
        ...HistoryFragment
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment HistoryFragment on Profile {
  id
  registrationHistory {
    ... on DiscoverTeam {
      id
      name
      preferredGrade
      registeredDate
      season {
        ... on DiscoverSeason {
          id
          name
          competition {
            id
            name
            organisation { id name __typename }
            __typename
          }
          availableRegistrations {
            id
            type
            registrationCode
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    ... on Participant {
      id
      type
      displayName
      gender
      dateOfBirth
      teamName
      registeredAt
      cancelledAt
      registrationStatus { name value __typename }
      seasonRegistration {
        id
        type
        registrationCode
        season {
          ... on DiscoverSeason {
            id
            name
            competition {
              id
              name
              organisation { id name __typename }
              __typename
            }
            __typename
          }
          __typename
        }
        organisation { id name __typename }
        __typename
      }
      __typename
    }
    __typename
  }
  __typename
}`;

// Also try discoverTeam with the team ID we know
const Q_DISCOVER_TEAM = `
query discoverTeam($teamID: ID!) {
  discoverTeam(teamID: $teamID) {
    id
    name
    grade { id name __typename }
    season {
      id
      name
      competition {
        id
        name
        organisation { id name __typename }
        __typename
      }
      __typename
    }
    organisation { id name __typename }
    __typename
  }
}`;

// Try teamRoster if it exists
const Q_TEAM_ROSTER = `
query teamRoster($teamID: ID!) {
  discoverTeamRoster(teamID: $teamID) {
    participants {
      id
      profile { id firstName lastName __typename }
      __typename
    }
    __typename
  }
}`;

// Try discoverTeamParticipants
const Q_TEAM_PARTICIPANTS = `
query discoverTeamParticipants($teamID: ID!) {
  discoverTeamParticipants(teamID: $teamID) {
    id
    profile { id firstName lastName __typename }
    __typename
  }
}`;

// Try teamMembers
const Q_TEAM_MEMBERS = `
query teamMembers($teamID: ID!) {
  teamMembers(teamID: $teamID) {
    id
    profile { id firstName lastName __typename }
    __typename
  }
}`;

function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function lookupPlayerFile(uuid) {
  if (!uuid) return null;
  const prefix = uuid.slice(0, 2);
  const detailFile = path.join(PLAYERS_DIR, prefix, `${uuid}.json`);
  if (fs.existsSync(detailFile)) {
    try { return JSON.parse(fs.readFileSync(detailFile, 'utf8')); } catch (e) {}
  }
  // Fall back to sports-index
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      return raw.players?.[uuid] || null;
    } catch (e) {}
  }
  return null;
}

function generateHtml({ results, profileData, generatedAt }) {
  const sections = results.map(r => {
    const statusClass = r.status === 200 ? 'ok' : r.status === 'ERR' ? 'err' : 'other';
    const statusLabel = r.status === 200 ? '✅ Success' : r.status === 'ERR' ? '💥 Error' : `⚠️ ${r.status}`;
    return `
    <details class="result-block" ${r.hasData ? 'open' : ''}>
      <summary>
        <span class="query-name">${escapeHtml(r.name)}</span>
        <span class="status status-${statusClass}">${statusLabel}</span>
        ${r.hasData ? '<span class="badge-data">📊 Has data</span>' : ''}
      </summary>
      <pre class="body">${escapeHtml(r.body)}</pre>
    </details>`;
  }).join('');

  // Extract tournament registrations from profileHistory
  const tournamentRegs = [];
  try {
    const profiles = [
      profileData?.account?.profile,
      ...(profileData?.account?.profile?.dependants || [])
    ].filter(Boolean);

    for (const profile of profiles) {
      for (const reg of profile.registrationHistory || []) {
        if (reg.__typename === 'Participant' &&
            reg.seasonRegistration?.season?.id === '0869ea69') {
          tournamentRegs.push({ profileId: profile.id, reg });
        }
      }
    }
  } catch (e) {}

  const regRows = tournamentRegs.map(({ profileId, reg }) => {
    const dbEntry = lookupPlayerFile(profileId);
    const bball = dbEntry?.sports?.Basketball || {};
    const d = v => v != null ? v : '–';
    return `<tr>
      <td><a href="https://www.playhq.com/public/profile/${escapeHtml(profileId)}/statistics?tenant=bv" target="_blank">${escapeHtml(dbEntry?.name || profileId)}</a></td>
      <td>${escapeHtml(reg.teamName || '–')}</td>
      <td>${escapeHtml(reg.registrationStatus?.name || '–')}</td>
      <td>${dbEntry ? '✅' : '❌'}</td>
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
<title>Team Members Probe</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; background: #f4f6f8; color: #1a1a2e; padding: 24px 16px 48px; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  h2 { font-size: 1rem; font-weight: 700; margin: 24px 0 10px; padding-bottom: 4px; border-bottom: 2px solid #2563eb; }
  .meta { color: #888; font-size: 0.8rem; margin-bottom: 24px; }
  .result-block { background: #fff; border-radius: 8px; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.07); overflow: hidden; }
  .result-block summary { display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; flex-wrap: wrap; }
  .result-block summary:hover { background: #f8fafc; }
  .query-name { font-weight: 600; font-family: monospace; flex: 1; }
  .status { font-size: 0.75rem; }
  .status-ok { color: #166534; }
  .status-err { color: #dc2626; }
  .status-other { color: #92400e; }
  .badge-data { background: #dcfce7; color: #166534; padding: 1px 7px; border-radius: 4px; font-size: 0.72rem; font-weight: 600; }
  pre.body { font-family: monospace; font-size: 0.72rem; padding: 12px 14px; background: #f8fafc; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 500px; overflow-y: auto; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.07); overflow: hidden; font-size: 0.8rem; }
  th { background: #1e293b; color: #fff; text-align: left; padding: 7px 12px; font-size: 0.72rem; text-transform: uppercase; }
  th.num, td.num { text-align: right; }
  td { padding: 6px 12px; border-bottom: 1px solid #f1f5f9; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #f8fafc; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #888; font-style: italic; padding: 10px; }
</style>
</head>
<body>
<h1>Team Members Probe</h1>
<div class="meta">Generated: ${escapeHtml(generatedAt)}</div>

${tournamentRegs.length > 0 ? `
<h2>Your registrations in season 0869ea69</h2>
<table>
  <thead><tr>
    <th>Player</th><th>Team</th><th>Status</th><th>In DB</th>
    <th class="num">GP</th><th class="num">PTS</th><th class="num">FG</th>
    <th class="num">FT</th><th class="num">3P</th><th class="num">Fouls</th>
  </tr></thead>
  <tbody>${regRows}</tbody>
</table>` : ''}

<h2>Query Results</h2>
${sections}
</body>
</html>`;
}

async function main() {
  console.log('🔬 Team Members Probe');
  console.log(`   Tenant: ${TENANT}`);

  const results = [];
  let profileData = null;

  // 1. profileHistory with auth
  console.log('\n1. profileHistory (auth)...');
  try {
    profileData = await gql('profileHistory', Q_PROFILE_HISTORY, {}, TOKEN);

    // Find Spirit Magic team ID from registrationHistory DiscoverTeam entries
    const profiles = [
      profileData?.account?.profile,
      ...(profileData?.account?.profile?.dependants || [])
    ].filter(Boolean);

    const teamRegs = profiles.flatMap(p =>
      (p.registrationHistory || []).filter(r => r.__typename === 'DiscoverTeam')
    );
    console.log(`   DiscoverTeam entries in registrationHistory: ${teamRegs.length}`);
    teamRegs.forEach(t => console.log(`     Team: ${t.name} (${t.id}), season: ${t.season?.id}`));

    // Find tournament participant registrations
    const tournRegs = profiles.flatMap(p =>
      (p.registrationHistory || []).filter(r =>
        r.__typename === 'Participant' && r.seasonRegistration?.season?.id === '0869ea69'
      )
    );
    console.log(`   Tournament registrations found: ${tournRegs.length}`);
    tournRegs.forEach(r => console.log(`     Team: ${r.teamName}, status: ${r.registrationStatus?.name}`));

    results.push({
      name: 'profileHistory',
      status: 200,
      hasData: true,
      body: JSON.stringify(profileData, null, 2),
    });
  } catch (e) {
    console.warn(`   ⚠ ${e.message}`);
    results.push({ name: 'profileHistory', status: 'ERR', hasData: false, body: e.message });
  }

  // Extract Spirit Magic team ID if present in DiscoverTeam branch
  let spiritMagicTeamId = null;
  try {
    const profiles = [
      profileData?.account?.profile,
      ...(profileData?.account?.profile?.dependants || [])
    ].filter(Boolean);
    const teamEntry = profiles.flatMap(p =>
      (p.registrationHistory || []).filter(r =>
        r.__typename === 'DiscoverTeam' && r.name?.toLowerCase().includes('spirit magic')
      )
    )[0];
    spiritMagicTeamId = teamEntry?.id;
  } catch (e) {}

  // Use known team ID from fixture if not found above
  // Spirit Magic was in the fixture — we need its team ID
  // Fetch it from discoverGradeFixture
  if (!spiritMagicTeamId) {
    console.log('\n   Fetching team ID from fixture...');
    try {
      const fix = await gql('gradeAllRounds', `
        query gradeAllRounds($gradeID: ID!) {
          discoverGradeFixture(gradeID: $gradeID) {
            games {
              home { ... on DiscoverTeam { id name } }
              away { ... on DiscoverTeam { id name } }
            }
          }
        }`, { gradeID: '5afff92b' });
      const allTeams = fix.discoverGradeFixture.flatMap(r =>
        r.games.flatMap(g => [g.home, g.away].filter(t => t?.name))
      );
      const spiritMagic = allTeams.find(t => t.name?.toLowerCase().includes('spirit magic'));
      spiritMagicTeamId = spiritMagic?.id;
      console.log(`   Spirit Magic team ID: ${spiritMagicTeamId || 'not found'}`);
    } catch (e) {
      console.warn(`   Could not fetch fixture: ${e.message}`);
    }
  }

  // 2. discoverTeam (no auth needed)
  if (spiritMagicTeamId) {
    console.log(`\n2. discoverTeam(${spiritMagicTeamId}) (no auth)...`);
    try {
      const data = await gql('discoverTeam', Q_DISCOVER_TEAM, { teamID: spiritMagicTeamId });
      console.log(`   OK: ${JSON.stringify(data).slice(0, 100)}`);
      results.push({ name: 'discoverTeam (no auth)', status: 200, hasData: true, body: JSON.stringify(data, null, 2) });
    } catch (e) {
      console.warn(`   ⚠ ${e.message}`);
      results.push({ name: 'discoverTeam (no auth)', status: 'ERR', hasData: false, body: e.message });
    }

    // 3. discoverTeamRoster (auth)
    console.log(`\n3. discoverTeamRoster(${spiritMagicTeamId}) (auth)...`);
    try {
      const data = await gql('teamRoster', Q_TEAM_ROSTER, { teamID: spiritMagicTeamId }, TOKEN);
      console.log(`   OK: ${JSON.stringify(data).slice(0, 150)}`);
      results.push({ name: 'discoverTeamRoster (auth)', status: 200, hasData: !!data.discoverTeamRoster, body: JSON.stringify(data, null, 2) });
    } catch (e) {
      console.warn(`   ⚠ ${e.message}`);
      results.push({ name: 'discoverTeamRoster (auth)', status: 'ERR', hasData: false, body: e.message });
    }

    // 4. discoverTeamParticipants (auth)
    console.log(`\n4. discoverTeamParticipants(${spiritMagicTeamId}) (auth)...`);
    try {
      const data = await gql('discoverTeamParticipants', Q_TEAM_PARTICIPANTS, { teamID: spiritMagicTeamId }, TOKEN);
      console.log(`   OK: ${JSON.stringify(data).slice(0, 150)}`);
      results.push({ name: 'discoverTeamParticipants (auth)', status: 200, hasData: !!data.discoverTeamParticipants, body: JSON.stringify(data, null, 2) });
    } catch (e) {
      console.warn(`   ⚠ ${e.message}`);
      results.push({ name: 'discoverTeamParticipants (auth)', status: 'ERR', hasData: false, body: e.message });
    }

    // 5. teamMembers (auth)
    console.log(`\n5. teamMembers(${spiritMagicTeamId}) (auth)...`);
    try {
      const data = await gql('teamMembers', Q_TEAM_MEMBERS, { teamID: spiritMagicTeamId }, TOKEN);
      console.log(`   OK: ${JSON.stringify(data).slice(0, 150)}`);
      results.push({ name: 'teamMembers (auth)', status: 200, hasData: !!data.teamMembers, body: JSON.stringify(data, null, 2) });
    } catch (e) {
      console.warn(`   ⚠ ${e.message}`);
      results.push({ name: 'teamMembers (auth)', status: 'ERR', hasData: false, body: e.message });
    }
  } else {
    console.warn('   Could not determine Spirit Magic team ID — skipping team queries');
  }

  // Generate HTML
  console.log('\n📄 Generating HTML...');
  const html = generateHtml({
    results,
    profileData,
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
