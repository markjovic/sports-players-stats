// scripts/update-team-index.js
//
// Adds new team entries to team-index.json for teams found in active seasons.
// Only adds teams not already present — never overwrites or removes existing entries.
//
// team-index.json structure:
//   { "Season Name": [{ id, n, sid, comp, grade }] }
//
// Grade is resolved via sports-index.json grades array where possible.
// For multi-grade seasons, grade is derived from the game's gn field.
//
// Usage:
//   node scripts/update-team-index.js           # active seasons
//   node scripts/update-team-index.js --dry-run

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const GAMES_DIR       = path.join(ROOT, 'games', 'bv');
const INDEX_FILE      = path.join(ROOT, 'sports-index.json');
const TEAM_INDEX_FILE = path.join(ROOT, 'team-index.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gitCommit(message) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  try { execSync('git add team-index.json', { stdio: 'pipe', cwd: ROOT }); } catch (_) {}
  const staged = (() => {
    try { return execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim(); }
    catch (_) { return ''; }
  })();
  if (!staged) { console.log('  Nothing to commit'); return; }
  try { execSync(`git commit -m "${message.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT }); }
  catch (_) { return; }
  const MAX = 10;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      execSync('git fetch origin main',                   { stdio: 'pipe', cwd: ROOT });
      execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main',                   { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✓ Committed: ${message}`);
      return;
    } catch (_) {
      if (attempt === MAX) { console.error(`  Push failed after ${MAX} attempts`); return; }
      await sleep(Math.floor(Math.random() * 15000) + attempt * 3000);
    }
  }
}

async function main() {
  const startTime = Date.now();
  console.log('update-team-index.js');
  if (DRY_RUN) console.log('  ⚠  DRY RUN — no writes or commits');
  console.log('─'.repeat(50));

  const sportIndex  = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const allSeasons  = Object.values(sportIndex.seasons || {});
  const activeSeasons = allSeasons.filter(s => s.locked === false);
  console.log(`Active seasons: ${activeSeasons.length}`);

  // Load existing team-index
  let teamIndex = {};
  if (fs.existsSync(TEAM_INDEX_FILE)) {
    try { teamIndex = JSON.parse(fs.readFileSync(TEAM_INDEX_FILE, 'utf8')); }
    catch (_) {}
  }

  // Build a set of existing team IDs for fast lookup
  const existingTids = new Set();
  for (const entries of Object.values(teamIndex)) {
    for (const e of entries) existingTids.add(e.id);
  }
  console.log(`Existing teams in index: ${existingTids.size}`);

  let newTeams = 0;

  for (const season of activeSeasons) {
    const gameFile = path.join(GAMES_DIR, `${season.id}.json`);
    if (!fs.existsSync(gameFile)) continue;

    let gf;
    try { gf = JSON.parse(fs.readFileSync(gameFile, 'utf8')); }
    catch (_) { continue; }

    const seasonName = season.name || season.id;
    const compName   = season.compName || '';
    const isSingleGrade = (season.grades || []).length === 1;
    const singleGrade   = isSingleGrade ? season.grades[0] : null;

    // Collect teams from game entries (h/a fields)
    const teamsInSeason = new Map();  // tid → { name, grade }

    for (const game of Object.values(gf.games || {})) {
      const hid = game.h || null;
      const aid = game.a || null;
      const hn  = game.hn || '';
      const an  = game.an || '';
      const gn  = game.gn || (singleGrade ? singleGrade.name : '');

      if (hid && !teamsInSeason.has(hid)) teamsInSeason.set(hid, { name: hn, grade: gn });
      if (aid && !teamsInSeason.has(aid)) teamsInSeason.set(aid, { name: an, grade: gn });

      // Prefer non-empty grade name if we get more data
      if (hid && teamsInSeason.get(hid)?.grade === '' && gn) teamsInSeason.get(hid).grade = gn;
      if (aid && teamsInSeason.get(aid)?.grade === '' && gn) teamsInSeason.get(aid).grade = gn;
    }

    // Add new teams to team-index
    for (const [tid, { name, grade }] of teamsInSeason) {
      if (existingTids.has(tid)) continue;

      if (!teamIndex[seasonName]) teamIndex[seasonName] = [];
      teamIndex[seasonName].push({
        id:    tid,
        n:     name,
        sid:   season.id,
        comp:  compName,
        grade: grade || '',
      });
      existingTids.add(tid);
      newTeams++;
    }
  }

  console.log(`New teams added: ${newTeams}`);

  if (newTeams > 0 && !DRY_RUN) {
    fs.writeFileSync(TEAM_INDEX_FILE, JSON.stringify(teamIndex));
    await gitCommit(`update-team-index: ${newTeams} new teams added`);
  } else if (newTeams === 0) {
    console.log('  No new teams found');
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('─'.repeat(50));
  console.log(`  Elapsed: ${elapsed}s`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
