// scripts/find-players-by-team.js
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
const targetGrades  = parseArg('--grades=');

if (targetTeams.length === 0 && targetSeasons.length === 0 && targetGrades.length === 0) {
  console.error("❌ Error: You must provide at least one filter criterion (Team, Season, or Grade).");
  process.exit(1);
}

// Prepare dynamic result buckets
const results = {};
targetTeams.forEach(tid => { results[tid] = []; });

const PLAYERS_DIR = path.join(process.cwd(), 'players');
let filesScanned = 0;

// 2. Core matching engine logic
function processFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    
    if (!data.seasons) return;

    // Use a unique tracking set per file to avoid multi-match duplication row records
    const uniqueMatches = new Set();

    for (const season of data.seasons) {
      // Filter 1: Season ID Intersection
      if (targetSeasons.length > 0 && !targetSeasons.includes(season.sid)) continue;
      if (!season.regs) continue;

      for (const reg of season.regs) {
        // Filter 2: Team ID Intersection
        if (targetTeams.length > 0 && !targetTeams.includes(reg.tid)) continue;
        
        // Filter 3: Grade Name Intersection (reg.gn maps directly to grade string)
        if (targetGrades.length > 0 && !targetGrades.includes(reg.gn)) continue;

        // Create a unique composite key for the matching criteria string
        const matchKey = `${reg.tid || 'unknown'}|${season.sid}|${reg.gn || 'unknown'}`;
        uniqueMatches.add(matchKey);
      }
    }

    // Process matched registrations back to the output payload
    uniqueMatches.forEach(key => {
      const [tid, sid, grade] = key.split('|');
      if (!results[tid]) results[tid] = [];
      
      results[tid].push({
        uuid: data.uuid,
        name: data.name,
        season: sid,
        grade: grade
      });
    });

  } catch (err) {
    // Ignore corrupted file schemas safely
  }
}

// 3. Flat synchronous file tree traversal
function walkDir(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath);
    } else if (entry.name.endsWith('.json')) {
      processFile(fullPath);
      filesScanned++;
      if (filesScanned % 50000 === 0) console.log(`Scanned ${filesScanned} players...`);
    }
  }
}

// 4. Execution Initialization
console.log('🚀 Running Filter Matrix Scan...');
if (targetTeams.length > 0)   console.log(`   • Teams   : ${targetTeams.join(', ')}`);
if (targetSeasons.length > 0) console.log(`   • Seasons : ${targetSeasons.join(', ')}`);
if (targetGrades.length > 0)  console.log(`   • Grades  : ${targetGrades.join(', ')}`);
console.log('');

walkDir(PLAYERS_DIR);

// 5. Build Markdown Summary for GitHub Actions Panel UI
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  let markdown = `# 🏀 Filtered Player Search Results\n\n`;
  markdown += `**Active Filters:**\n`;
  markdown += `* **Teams:** ${targetTeams.length ? `\`${targetTeams.join('`, `')}\`` : '_None (All)_'}\n`;
  markdown += `* **Seasons:** ${targetSeasons.length ? `\`${targetSeasons.join('`, `')}\`` : '_None (All)_'}\n`;
  markdown += `* **Grades:** ${targetGrades.length ? `\`${targetGrades.join('`, `')}\`` : '_None (All)_'}\n\n`;
  markdown += `**Total Records Evaluated:** ${filesScanned}\n\n`;

  const keys = Object.keys(results);
  if (keys.length === 0 || keys.every(k => results[k].length === 0)) {
    markdown += `### ⚠️ No matching records found.\nVerify your query spelling matches your player history keys exactly.`;
  } else {
    for (const tid of keys) {
      if (results[tid].length === 0) continue;
      markdown += `### Team Key: \`${tid}\` (${results[tid].length} Matches)\n`;
      markdown += `| Player Name | Player UUID | Season | Grade |\n`;
      markdown += `| :--- | :--- | :--- | :--- |\n`;
      results[tid].forEach(p => {
        markdown += `| **${p.name}** | \`${p.uuid}\` | \`${p.season}\` | ${p.grade} |\n`;
      });
      markdown += `\n`;
    }
  }
  fs.writeFileSync(summaryPath, markdown);
}

console.log(`\n✅ Scan Complete. Total files verified: ${filesScanned}`);
