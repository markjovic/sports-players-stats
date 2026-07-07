// scripts/search-team-stats.js
const fs = require('fs');
const path = require('path');

// 1. Parse operational arguments
const args = process.argv.slice(2);
const parseArg = (prefix) => {
  const found = args.find(a => a.startsWith(prefix));
  if (!found) return [];
  const val = found.split('=')[1];
  return val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
};

const targetTeams   = parseArg('--teams=');
const targetSeasons = parseArg('--seasons=');

if (targetTeams.length === 0 && targetSeasons.length === 0) {
  console.error("❌ Error: You must provide at least one filter criterion (Team or Season).");
  process.exit(1);
}

// Prepare results tracking
const results = {};
targetTeams.forEach(tid => { results[tid] = []; });

const TEAM_STATS_DIR = path.join(process.cwd(), 'team-stats');
const TEAM_LOOKUP_DIR = path.join(process.cwd(), 'team-lookup');
let filesScanned = 0;

// Helper to look up human-readable team names if available
function getTeamName(teamId) {
  try {
    // Assuming team-lookup holds ID -> Name mappings
    // Fallback gracefully if we can't find it
    const lookupPath = path.join(TEAM_LOOKUP_DIR, 'bv', `${teamId}.json`); // Adjust 'bv' if needed
    if (fs.existsSync(lookupPath)) {
      const data = JSON.parse(fs.readFileSync(lookupPath, 'utf8'));
      return data.name || data.n || teamId;
    }
  } catch (e) {}
  return teamId;
}

// 2. Core matching engine logic for team-stats (Layer 1)
function processSeasonFile(filePath, seasonId) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const seasonData = JSON.parse(content);
    
    // In team-stats, the structure usually maps Team IDs to Roster Arrays
    // e.g., { "teamId1": [ player1, player2 ], "teamId2": ... }
    
    for (const [teamId, roster] of Object.entries(seasonData)) {
      
      // Filter 1: Team ID Match
      if (targetTeams.length > 0 && !targetTeams.includes(teamId)) continue;

      if (!results[teamId]) results[teamId] = [];
      
      // Roster arrays might contain plain strings (UUIDs) or objects { id, n }
      // This handles both dynamically.
      if (Array.isArray(roster)) {
        roster.forEach(player => {
          const playerId = typeof player === 'string' ? player : (player.id || player.uuid || 'unknown');
          const playerName = typeof player === 'object' ? (player.n || player.name || 'Unknown Name') : 'Name in players/ dir';
          
          results[teamId].push({
            uuid: playerId,
            name: playerName,
            season: seasonId
          });
        });
      }
    }
  } catch (err) {
    // Ignore unparseable files
  }
}

// 3. Recursive directory walker (looking for season files)
function walkDir(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath);
    } else if (entry.name.endsWith('.json')) {
      const fileNameId = entry.name.replace('.json', '');
      
      // Filter 2: Season ID Match (assuming file names or paths contain the season ID)
      if (targetSeasons.length > 0 && !targetSeasons.includes(fileNameId)) {
         // Skip if we are filtering by season and this file isn't it
         continue;
      }

      processSeasonFile(fullPath, fileNameId);
      filesScanned++;
    }
  }
}

// 4. Execution Initialization
console.log('🚀 Running Layer 1 (team-stats) Scan...');
if (targetTeams.length > 0)   console.log(`   • Teams   : ${targetTeams.join(', ')}`);
if (targetSeasons.length > 0) console.log(`   • Seasons : ${targetSeasons.join(', ')}`);
console.log('');

walkDir(TEAM_STATS_DIR);

// 5. Build Markdown Summary for GitHub Actions Panel UI
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  let markdown = `# 🏀 Layer 1 Roster Search Results\n\n`;
  markdown += `**Active Filters:**\n`;
  markdown += `* **Teams:** ${targetTeams.length ? `\`${targetTeams.join('`, `')}\`` : '_None (All)_'}\n`;
  markdown += `* **Seasons:** ${targetSeasons.length ? `\`${targetSeasons.join('`, `')}\`` : '_None (All)_'}\n\n`;
  markdown += `**Season Files Evaluated:** ${filesScanned}\n\n`;

  const keys = Object.keys(results);
  if (keys.length === 0 || keys.every(k => results[k].length === 0)) {
    markdown += `### ⚠️ No matching rosters found in \`team-stats/\`.\nIf the nightly crawl just ran, check if the season actually had games scheduled. Teams without scheduled games may not generate rosters yet.`;
  } else {
    for (const tid of keys) {
      if (results[tid].length === 0) continue;
      
      const displayTeamName = getTeamName(tid);
      markdown += `### Team: **${displayTeamName}** (\`${tid}\`) — ${results[tid].length} Players\n`;
      markdown += `| Player ID / UUID | Season File |\n`;
      markdown += `| :--- | :--- |\n`;
      results[tid].forEach(p => {
        // If Layer 1 only stores UUIDs without names, we show what we have.
        const nameDisplay = p.name !== 'Name in players/ dir' ? `**${p.name}**<br/>` : '';
        markdown += `| ${nameDisplay}\`${p.uuid}\` | \`${p.season}\` |\n`;
      });
      markdown += `\n`;
    }
  }
  fs.writeFileSync(summaryPath, markdown);
}

console.log(`\n✅ Scan Complete. Total season files checked: ${filesScanned}`);