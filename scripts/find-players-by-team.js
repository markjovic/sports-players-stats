// scripts/find-players-by-team.js
//
// Who was in these teams — and, with --landed, WHERE THEY ARE NOW.
//
// Offline. Walks players/ and matches registrations. No PlayHQ calls, no network.
//
// Usage:
//   node scripts/find-players-by-team.js --teams=83e3d989,1f0c2a44
//   node scripts/find-players-by-team.js --team-name=Ringwood --landed
//   node scripts/find-players-by-team.js --team-name="Ringwood Hawks" --seasons=5e26f10f
//   node scripts/find-players-by-team.js --teams=83e3d989 --landed --since=2024
//
// ⚠️ A NEW SEASON HOLDS NOTHING UNTIL ITS GAMES EXIST. Teams, rosters and
// registrations for a season nobody has played yet are not on file, so a rep
// season that was announced last week cannot be searched. The way to find this
// year's squad is to search LAST year's team and follow the players forward,
// which is what --landed is for.
//
// ⚠️ --team-name IS A SUBSTRING MATCH AND IT IS BLUNT. "Ringwood" matches
// "Ringwood Hawks", "Ringwood Lady Hawks" and anything else carrying the word.
// Every distinct team name that matched is listed in its own section with its
// tid, so you can see exactly what was swept in rather than trusting the filter.
// It reads `reg.tn`, the team name stored on the registration itself.
//
// ⚠️ IT NEVER PICKS A PERSON OR A TEAM. Every match is reported. Narrowing is
// the reader's job, done by looking at what came back.

const fs = require('fs');
const path = require('path');

const ROOT         = process.cwd();
const PLAYERS_DIR  = path.join(ROOT, 'players');
const SPORTS_IDX   = path.join(ROOT, 'data', 'sports-index.json');
const REPORTS_DIR  = path.join(ROOT, 'reports');

const args = process.argv.slice(2);
const listArg = (prefix) => {
  const found = args.find(a => a.startsWith(prefix));
  if (!found) return [];
  const val = found.slice(prefix.length);
  return val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
};
const strArg = (prefix) => {
  const found = args.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : '';
};
const has = (flag) => args.includes('--' + flag);

const targetTeams     = listArg('--teams=');
const targetSeasons   = listArg('--seasons=');
const targetGradeIds  = listArg('--grade-ids=');
const targetNames     = listArg('--team-name=').map(s => s.toLowerCase());
const LANDED          = has('landed');
const SINCE           = strArg('--since=');          // season name/date prefix filter on the history
const LIMIT_ROWS      = parseInt(strArg('--limit=') || '400', 10);

if (!targetTeams.length && !targetSeasons.length && !targetGradeIds.length && !targetNames.length) {
  console.error('✗ Give at least one filter: --teams=, --team-name=, --seasons= or --grade-ids=');
  process.exit(1);
}

// ── Season labels. A missing index is NAMED, never silently degraded into sids
// that read like a different kind of answer. ───────────────────────────────────
let sportIdx = null, idxWhy = '';
try {
  sportIdx = JSON.parse(fs.readFileSync(SPORTS_IDX, 'utf8')).seasons || null;
} catch (e) { idxWhy = e.code === 'ENOENT' ? 'not in this checkout' : e.message; }
if (!sportIdx) {
  console.log(`⚠ data/sports-index.json ${idxWhy || 'unreadable'} — seasons will show as ids, not names.`);
  console.log('  If this run was meant to be readable, add `data` to the workflow\'s sparse-checkout.');
}
const seasonName = sid => (sportIdx && sportIdx[sid] && sportIdx[sid].name) || sid || '(unknown season)';
// endDate first: a season's END is what orders a player's path through clubs.
// Seasons with neither date sort last rather than being dropped.
const seasonSort = sid => {
  const se = (sportIdx && sportIdx[sid]) || {};
  return se.endDate || se.startDate || '0000-00-00';
};

const matchedTeamNames = new Map();   // tid -> name, every distinct team swept in
const results = {};                   // tid -> [row]
const landed  = new Map();            // uuid -> {name, regs:[...]}
let filesScanned = 0, playersMatched = 0;

function regMatches(reg, sid) {
  if (targetSeasons.length  && !targetSeasons.includes(sid)) return false;
  if (targetTeams.length    && !targetTeams.includes(reg.tid)) return false;
  if (targetGradeIds.length && !targetGradeIds.includes(reg.gid)) return false;
  if (targetNames.length) {
    const tn = (reg.tn || '').toLowerCase();
    if (!tn || !targetNames.some(n => tn.includes(n))) return false;
  }
  return true;
}

function processFile(filePath) {
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return; }                       // unreadable file: counted below, never guessed at
  if (!data || !Array.isArray(data.seasons)) return;

  const hits = new Set();
  for (const season of data.seasons) {
    for (const reg of (season.regs || [])) {
      if (!regMatches(reg, season.sid)) continue;
      if (reg.tid) matchedTeamNames.set(reg.tid, reg.tn || '(no team name on reg)');
      hits.add([reg.tid || 'unknown', season.sid, reg.gid || '', reg.gn || '', reg.tn || ''].join('|'));
    }
  }
  if (!hits.size) return;
  playersMatched++;

  for (const key of hits) {
    const [tid, sid, gid, gradeName, teamName] = key.split('|');
    (results[tid] = results[tid] || []).push({
      uuid: data.uuid, name: data.name || '(no name on file)',
      sid, seasonName: seasonName(sid), gid, gradeName, teamName,
    });
  }

  // --landed: the player's WHOLE registration history, not just the rows that
  // matched. This is the question "where did they go next" — it cannot be
  // answered from the matched rows alone, which is all this script used to give.
  if (LANDED) {
    const regs = [];
    for (const season of data.seasons) {
      for (const reg of (season.regs || [])) {
        const label = seasonName(season.sid);
        if (SINCE && !(seasonSort(season.sid) >= SINCE || label.includes(SINCE))) continue;
        regs.push({
          sid: season.sid, season: label, sort: seasonSort(season.sid),
          team: reg.tn || '(team name not on reg)', tid: reg.tid || '',
          grade: reg.gn || '', gp: (reg.stats && reg.stats.gp) || 0,
        });
      }
    }
    regs.sort((a, b) => (b.sort < a.sort ? -1 : b.sort > a.sort ? 1 : 0));
    landed.set(data.uuid, { name: data.name || '(no name on file)', regs });
  }
}

function walkDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full);
    else if (entry.name.endsWith('.json')) {
      processFile(full);
      if (++filesScanned % 50000 === 0) console.log(`  scanned ${filesScanned.toLocaleString()} players...`);
    }
  }
}

console.log('=== find-players-by-team.js [READ-ONLY, offline] ===');
if (targetTeams.length)    console.log(`  teams      : ${targetTeams.join(', ')}`);
if (targetNames.length)    console.log(`  team name  : ${targetNames.join(', ')}  (substring, case-insensitive)`);
if (targetSeasons.length)  console.log(`  seasons    : ${targetSeasons.join(', ')}`);
if (targetGradeIds.length) console.log(`  grade ids  : ${targetGradeIds.join(', ')}`);
console.log(`  landed     : ${LANDED ? 'YES — full registration history per matched player' : 'no (--landed to add it)'}`);
if (SINCE) console.log(`  since      : ${SINCE}`);
console.log('');

walkDir(PLAYERS_DIR);

console.log('');
console.log(`  players scanned : ${filesScanned.toLocaleString()}`);
console.log(`  players matched : ${playersMatched.toLocaleString()}`);
console.log(`  teams matched   : ${matchedTeamNames.size}`);
if (!playersMatched) {
  console.log('');
  console.log('  NO MATCHES. That is not proof the players are absent — check:');
  console.log('    • a season with no games played yet holds no registrations at all');
  console.log('    • --team-name reads reg.tn, which some older registrations do not carry');
  console.log('    • team ids are per-season; last season\'s tid is not this season\'s');
}

// ── CSV artifacts. A markdown table of several hundred players does not fit in
// a step summary (1 MB cap) and is unreadable long before it is truncated. ────
fs.mkdirSync(REPORTS_DIR, { recursive: true });
const csv = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
const squadPath = path.join(REPORTS_DIR, 'team-search-squad.csv');
const squadRows = [['team_name', 'tid', 'season', 'sid', 'grade', 'player', 'uuid']];
for (const [tid, rows] of Object.entries(results))
  for (const r of rows) squadRows.push([r.teamName || matchedTeamNames.get(tid) || '', tid, r.seasonName, r.sid, r.gradeName, r.name, r.uuid]);
fs.writeFileSync(squadPath, squadRows.map(r => r.map(csv).join(',')).join('\n'));
console.log(`\n  → ${path.relative(ROOT, squadPath)}  (${squadRows.length - 1} rows)`);

let landedPath = null;
if (LANDED) {
  landedPath = path.join(REPORTS_DIR, 'team-search-landed.csv');
  const rows = [['player', 'uuid', 'season', 'sid', 'team', 'tid', 'grade', 'gp']];
  for (const [uuid, p] of landed)
    for (const r of p.regs) rows.push([p.name, uuid, r.season, r.sid, r.team, r.tid, r.grade, r.gp]);
  fs.writeFileSync(landedPath, rows.map(r => r.map(csv).join(',')).join('\n'));
  console.log(`  → ${path.relative(ROOT, landedPath)}  (${rows.length - 1} rows)`);
}

// ── Step summary: the TEAMS that matched in full, and the squads capped. ──────
const sp = process.env.GITHUB_STEP_SUMMARY;
if (sp) {
  let md = `# Player search by team\n\n`;
  md += `**Filters** — teams: ${targetTeams.length ? '`' + targetTeams.join('`, `') + '`' : '_any_'}`;
  md += ` · team name: ${targetNames.length ? '`' + targetNames.join('`, `') + '`' : '_any_'}`;
  md += ` · seasons: ${targetSeasons.length ? '`' + targetSeasons.join('`, `') + '`' : '_any_'}`;
  md += ` · grades: ${targetGradeIds.length ? '`' + targetGradeIds.join('`, `') + '`' : '_any_'}\n\n`;
  md += `${playersMatched.toLocaleString()} players matched across ${matchedTeamNames.size} team(s), from ${filesScanned.toLocaleString()} scanned.\n\n`;

  if (targetNames.length && matchedTeamNames.size) {
    md += `## Teams the name filter swept in\n\n`;
    md += `Check this before trusting the squads below — a substring is blunt.\n\n`;
    md += `| Team name | tid |\n| :--- | :--- |\n`;
    for (const [tid, tn] of [...matchedTeamNames].sort((a, b) => a[1].localeCompare(b[1])))
      md += `| ${tn} | \`${tid}\` |\n`;
    md += `\n`;
  }

  if (!playersMatched) {
    md += `### No matching records\n\nA season with no games played yet holds no registrations — see the console notes.\n`;
  } else {
    md += `## Squads\n\n`;
    let printed = 0;
    for (const [tid, rows] of Object.entries(results)) {
      if (!rows.length) continue;
      md += `### ${matchedTeamNames.get(tid) || '(unnamed)'} — \`${tid}\` (${rows.length})\n\n`;
      md += `| Player | Season | Grade | uuid |\n| :--- | :--- | :--- | :--- |\n`;
      for (const r of rows) {
        if (++printed > LIMIT_ROWS) break;
        md += `| **${r.name}** | ${r.seasonName} | ${r.gradeName} | \`${r.uuid}\` |\n`;
      }
      md += `\n`;
      if (printed > LIMIT_ROWS) { md += `_Row cap ${LIMIT_ROWS} reached — the full list is in the CSV artifact._\n\n`; break; }
    }
    md += `\nCSV artifacts: \`reports/team-search-squad.csv\`${landedPath ? ', `reports/team-search-landed.csv`' : ''} — download from the run.\n`;
  }
  fs.writeFileSync(sp, md);
}

console.log('\nDone. READ-ONLY — nothing in players/ or games/ was written.');
