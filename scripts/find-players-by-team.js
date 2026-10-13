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
// Discovery mode. A name filter you have to GUESS is the reason a search comes
// back empty and gets read as "no data". --list-teams takes the season(s) and
// reports every distinct team name in them, so the name filter is chosen from
// what is actually there rather than from what a club calls itself in public.
const LIST_TEAMS      = has('list-teams');
// ⚠️ --since and --history-name were ONE argument until 2026-10-13, matching a
// date OR a name substring. Two unrelated jobs in one flag: "2025" then meant
// both "seasons ending after 2025" and "seasons whose name contains 2025", and
// the two answers differ. Split, and each does one thing.
const SINCE           = strArg('--since=');                              // date only, YYYY-MM-DD
const HIST_NAMES      = listArg('--history-name=').map(s => s.toLowerCase());
const LIMIT_ROWS      = parseInt(strArg('--limit=') || '400', 10);

// There is NO flag in the data that says "this season is rep". The club index
// types an organisation CLUB or ASSOCIATION, but a registration carries neither —
// it carries tid, tn, gid, gn and stats. The season NAME is the only practical
// handle, which is why this is an argument the operator supplies rather than a
// rule the script decides. VJBL seasons are named "VJBL <year>" or
// "Victorian Junior Basketball League — <year>"; other rep paths (Big V, CBL,
// tournaments) are named differently again, so pass what you mean.

if (!targetTeams.length && !targetSeasons.length && !targetGradeIds.length && !targetNames.length) {
  console.error('✗ Give at least one filter: --teams=, --team-name=, --seasons= or --grade-ids=');
  console.error('  To see what is IN a season before filtering: --seasons=<sid> --list-teams');
  process.exit(1);
}
if (LIST_TEAMS && !targetSeasons.length && !targetNames.length && !targetGradeIds.length) {
  console.error('✗ --list-teams needs a --seasons= (or --team-name=/--grade-ids=) to scope it.');
  console.error('  Unscoped it would list every team in the database.');
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

// ⚠️ A SEASON ID IN --teams RETURNS ZERO, AND ZERO LOOKS LIKE AN ANSWER.
// 2026-10-13: a run passed two VJBL SEASON ids to --teams. No registration can
// ever carry a season id as its tid, so the scan read 432,992 players and
// reported "0 matched" — indistinguishable from "those players are not on file",
// and the next move would have been to re-crawl data that was already there.
// Both id kinds are 8 hex characters, so they are not told apart by shape; they
// ARE told apart by the season index, which is already loaded.
if (sportIdx) {
  const sidsInTeams = targetTeams.filter(t => sportIdx[t]);
  if (sidsInTeams.length) {
    console.error('');
    console.error(`✗ ${sidsInTeams.length} value(s) passed as TEAM ids are SEASON ids:`);
    for (const t of sidsInTeams) console.error(`    ${t}  "${sportIdx[t].name || ''}"`);
    console.error('  Pass these as season_ids / --seasons=, not team_ids / --teams=.');
    console.error('  Refusing to run: this filter can only ever return zero, and a zero here');
    console.error('  reads as "these players are not on file", which would be wrong.');
    process.exit(1);
  }
  const unknownSeasons = targetSeasons.filter(x => !sportIdx[x]);
  if (unknownSeasons.length) {
    console.log(`⚠ ${unknownSeasons.length} season id(s) are not in sports-index: ${unknownSeasons.join(', ')}`);
    console.log('  Continuing — the index can lag — but a zero result here may just mean the id is wrong.');
  }
}

const matchedTeamNames = new Map();   // tid -> name, every distinct team swept in
const teamPlayers      = new Map();   // tid -> {n:Set(uuid), sids:Set(sid)}
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
      if (reg.tid) {
        matchedTeamNames.set(reg.tid, reg.tn || '(no team name on reg)');
        let c = teamPlayers.get(reg.tid);
        if (!c) teamPlayers.set(reg.tid, c = { n: new Set(), sids: new Set() });
        c.n.add(data.uuid); c.sids.add(season.sid);
      }
      hits.add([reg.tid || 'unknown', season.sid, reg.gid || '', reg.gn || '', reg.tn || ''].join('|'));
    }
  }
  if (!hits.size) return;
  playersMatched++;
  if (LIST_TEAMS) return;          // team names only — no squad rows, no history

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
        if (SINCE && seasonSort(season.sid) < SINCE) continue;
        if (HIST_NAMES.length && !HIST_NAMES.some(n => label.toLowerCase().includes(n))) continue;
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
console.log(`  mode       : ${LIST_TEAMS ? 'LIST TEAMS — team names only, no player rows' : 'squads'}`);
console.log(`  landed     : ${LANDED && !LIST_TEAMS ? 'YES — full registration history per matched player' : 'no'}`);
if (HIST_NAMES.length) console.log(`  history    : seasons whose NAME contains ${HIST_NAMES.join(' or ')}`);
if (SINCE) console.log(`  since      : seasons ending on/after ${SINCE}`);
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

// ── --list-teams: the discovery pass. Every team name in scope, with how many
// players and which seasons. Read this, pick your name filter, run again. ─────
if (LIST_TEAMS) {
  const rows = [['team', 'tid', 'players', 'seasons']];
  const list = [...matchedTeamNames].map(([tid, tn]) => ({
    tid, tn,
    players: (teamPlayers.get(tid) || { n: new Set() }).n.size,
    sids: [...(teamPlayers.get(tid) || { sids: new Set() }).sids].map(seasonName).sort().join(' | '),
  })).sort((a, b) => a.tn.localeCompare(b.tn));
  for (const t of list) rows.push([t.tn, t.tid, t.players, t.sids]);
  const lp = path.join(REPORTS_DIR, 'team-search-teamlist.csv');
  fs.writeFileSync(lp, rows.map(r => r.map(csv).join(',')).join('\n'));
  console.log(`\n  → ${path.relative(ROOT, lp)}  (${list.length} teams)`);

  const sp0 = process.env.GITHUB_STEP_SUMMARY;
  if (sp0) {
    let md = `# Teams in scope — ${list.length}\n\n`;
    md += `${playersMatched.toLocaleString()} players across them, from ${filesScanned.toLocaleString()} scanned.\n\n`;
    md += `Pick the names you want, then re-run WITHOUT \`list_teams\` and with \`team_name\` set.\n\n`;
    md += `| Team | tid | Players | Seasons |\n| :--- | :--- | ---: | :--- |\n`;
    for (const t of list.slice(0, 500)) md += `| ${t.tn} | \`${t.tid}\` | ${t.players} | ${t.sids} |\n`;
    if (list.length > 500) md += `\n_${list.length - 500} more in \`team-search-teamlist.csv\`._\n`;
    fs.writeFileSync(sp0, md);
  }
  console.log('\nDone. READ-ONLY — nothing was written outside reports/.');
  process.exit(0);
}
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

// ── Destinations. The squads answer "who was here"; the landed history answers
// "where did each one go". Neither answers "where did they ALL go", which is the
// question a rep list is actually read for, so it is rolled up explicitly.
// A player is counted ONCE per team however many seasons they spent there. ─────
let destRows = [];
if (LANDED) {
  const byTeam = new Map();   // "tid|team" -> {team, tid, players:Set, seasons:Set}
  for (const [uuid, p] of landed) {
    for (const r of p.regs) {
      const k = `${r.tid}|${r.team}`;
      let e = byTeam.get(k);
      if (!e) byTeam.set(k, e = { team: r.team, tid: r.tid, players: new Set(), seasons: new Set(), names: new Set() });
      e.players.add(uuid); e.seasons.add(r.season); e.names.add(p.name);
    }
  }
  destRows = [...byTeam.values()].sort((a, b) => b.players.size - a.players.size || a.team.localeCompare(b.team));
  const dp = path.join(REPORTS_DIR, 'team-search-destinations.csv');
  const rows = [['team', 'tid', 'players', 'seasons', 'player_names']];
  for (const d of destRows)
    rows.push([d.team, d.tid, d.players.size, [...d.seasons].sort().join(' | '), [...d.names].sort().join(' | ')]);
  fs.writeFileSync(dp, rows.map(r => r.map(csv).join(',')).join('\n'));
  console.log(`  → ${path.relative(ROOT, dp)}  (${rows.length - 1} teams)`);
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
    if (destRows.length) {
      md += `## Where they landed — ${destRows.length} team(s)\n\n`;
      md += HIST_NAMES.length
        ? `History filtered to seasons named like: \`${HIST_NAMES.join('`, `')}\`\n\n`
        : `⚠️ History is UNFILTERED — this includes domestic as well as rep. Set \`history_name\` to narrow it.\n\n`;
      md += `| Team | Players | Seasons |\n| :--- | ---: | :--- |\n`;
      for (const d of destRows.slice(0, 60))
        md += `| ${d.team} | ${d.players.size} | ${[...d.seasons].sort().join(', ')} |\n`;
      if (destRows.length > 60) md += `\n_${destRows.length - 60} more in \`team-search-destinations.csv\`._\n`;
      md += `\n`;
    }
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
    md += `\nCSV artifacts: \`reports/team-search-squad.csv\`${landedPath ? ', `reports/team-search-landed.csv`, `reports/team-search-destinations.csv`' : ''} — download from the run.\n`;
  }
  fs.writeFileSync(sp, md);
}

console.log('\nDone. READ-ONLY — nothing in players/ or games/ was written.');
