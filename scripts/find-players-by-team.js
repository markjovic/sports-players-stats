// scripts/find-players-by-team.js
const fs = require('fs');
const path = require('path');

// 1. Parse arguments
const args = process.argv.slice(2);
const teamArg = args.find(a => a.startsWith('--teams='));

if (!teamArg) {
  console.error("Usage: node find-players-by-team.js --teams=tid1,tid2");
  process.exit(1);
}

// Clean and prepare the target team IDs
const targetTeams = teamArg.split('=')[1].split(',').map(t => t.trim()).filter(Boolean);
const results = {};
targetTeams.forEach(t => results[t] = []);

const PLAYERS_DIR = path.join(process.cwd(), 'players');
let filesScanned = 0;

// 2. Process a single player file
function processFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    
    if (!data.seasons) return;

    // Track teams matched for this specific player to avoid duplicates 
    // if they played for the same team across multiple grades
    const matchedTeams = new Set(); 

    for (const season of data.seasons) {
      if (!season.regs) continue;
      for (const reg of season.regs) {
        if (targetTeams.includes(reg.tid)) {
          matchedTeams.add(reg.tid);
        }
      }
    }

    // Add player to results
    matchedTeams.forEach(tid => {
      results[tid].push({ uuid: data.uuid, name: data.name });
    });

  } catch (err) {
    // Gracefully ignore unparseable or corrupted files
  }
}

// 3. Recursive directory walker
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
      
      // Log progress so GitHub Actions doesn't look stalled
      if (filesScanned % 50000 === 0) {
        console.log(`Scanned ${filesScanned} files...`);
      }
    }
  }
}

// 4. Execute Search
console.log(`Searching ${PLAYERS_DIR} for Team IDs: ${targetTeams.join(', ')}\n`);
walkDir(PLAYERS_DIR);
console.log(`\nFinished! Total files scanned: ${filesScanned}\n`);

// 5. Output to Console
console.log('─── Results ─────────────────────────────────────────────');
for (const tid of targetTeams) {
  console.log(`\nTeam ID: ${tid}`);
  console.log(`Total Players Found: ${results[tid].length}`);
  results[tid].forEach(p => {
    console.log(`  - ${p.uuid} | ${p.name}`);
  });
}

// 6. Write to GitHub Actions Step Summary (UI integration)
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  let markdown = `# 🏀 Team Player Search Results\n\n`;
  markdown += `**Searched Teams:** \`${targetTeams.join('`, `')}\`  \n`;
  markdown += `**Files Scanned:** ${filesScanned}\n\n`;

  for (const tid of targetTeams) {
    markdown += `### Team ID: \`${tid}\` (${results[tid].length} players)\n`;
    if (results[tid].length > 0) {
      markdown += `| Player Name | UUID |\n`;
      markdown += `| :--- | :--- |\n`;
      results[tid].forEach(p => {
        markdown += `| ${p.name} | \`${p.uuid}\` |\n`;
      });
    } else {
      markdown += `*No players found for this team ID.*\n`;
    }
    markdown += `\n`;
  }
  fs.appendFileSync(summaryPath, markdown);
}