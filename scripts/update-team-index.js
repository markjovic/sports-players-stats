// scripts/update-team-index.js
//
// Adds new team entries to team-index.json by scanning recently-updated
// player files (default: last 2 days). Sources team data from
// seasons[].regs[] which includes pre-graded teams not yet in game files.
//
// Safe to run with the 2-day filter — any new team registration causes
// publicProfileTeams to update the player file (updatedAt), so recently
// registered players are always caught within 24-48h.
//
// team-index.json structure:
//   { "Season Name": [{ id, n, sid, comp, grade }] }
//
// Usage:
//   node scripts/update-team-index.js            # last 2 days
//   node scripts/update-team-index.js --days=7   # last 7 days
//   node scripts/update-team-index.js --all      # scan all player files
//   node scripts/update-team-index.js --dry-run

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const ARGS    = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const DRY_RUN  = !!ARGS['dry-run'];
const SCAN_ALL = !!ARGS.all;
const DAYS     = SCAN_ALL ? Infinity : Math.max(1, parseInt(ARGS.days || '2', 10));

const PLAYERS_DIR     = path.join(ROOT, 'players');
const INDEX_DIR       = path.join(ROOT, 'players', 'indexes');
const TEAM_INDEX_FILE = path.join(ROOT, 'team-index.json');
const SPORTS_INDEX    = path.join(ROOT, 'sports-index.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gitCommit(message) {
  if (DRY_RUN) { console.log(`  [dry-run] ${message}`); return; }
  try {
    execSync('git add -A', { stdio: 'pipe', cwd: ROOT });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim();
    if (!diff) { console.log('  Nothing to commit'); return; }
    execSync(`git commit -m "${message.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT });
    execSync('git fetch origin main', { stdio: 'pipe', cwd: ROOT });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
    execSync('git push origin main', { stdio: 'pipe', cwd: ROOT });
    console.log(`  ✓ ${message}`);
  } catch (e) { console.error(`  git error: ${e.message}`); }
}

async function main() {
  console.log('update-team-index.js');
  if (SCAN_ALL)  console.log('  Mode: full scan (all player files)');
  else           console.log(`  Mode: recent only (last ${DAYS} day(s))`);
  if (DRY_RUN)   console.log('  ⚠  DRY RUN');
  console.log('─'.repeat(50));

  // Load sports-index for season metadata (name, compName)
  const sportIndex = JSON.parse(fs.readFileSync(SPORTS_INDEX, 'utf8'));
  const sidMeta    = {};
  for (const [sid, s] of Object.entries(sportIndex.seasons || {})) {
    sidMeta[sid] = { name: s.name || sid, compName: s.compName || '' };
  }

  // Load existing team-index — build a Set of all known team IDs
  let teamIndex = {};
  if (fs.existsSync(TEAM_INDEX_FILE)) {
    try { teamIndex = JSON.parse(fs.readFileSync(TEAM_INDEX_FILE, 'utf8')); }
    catch (_) {}
  }
  const existingTids = new Set();
  for (const entries of Object.values(teamIndex)) {
    if (Array.isArray(entries)) {
      for (const e of entries) if (e.id) existingTids.add(e.id);
    }
  }
  console.log(`Existing teams in index: ${existingTids.size}`);

  // Determine cutoff timestamp
  const cutoff = SCAN_ALL ? 0 : Date.now() - DAYS * 24 * 60 * 60 * 1000;

  // Scan player shard indexes, filter by updatedAt, read player files
  const shards = fs.readdirSync(INDEX_DIR)
    .filter(f => /^[0-9a-f]{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''));

  let playersChecked = 0, playersScanned = 0, newTeams = 0;

  for (const shard of shards) {
    let index;
    try { index = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, `${shard}.json`), 'utf8')); }
    catch (_) { continue; }

    for (const uuid of Object.keys(index)) {
      playersChecked++;
      const playerFile = path.join(PLAYERS_DIR, shard, `${uuid}.json`);
      if (!fs.existsSync(playerFile)) continue;

      // Check updatedAt before reading full file
      if (!SCAN_ALL) {
        try {
          const stat = fs.statSync(playerFile);
          if (stat.mtimeMs < cutoff) continue;
        } catch (_) { continue; }
      }

      let player;
      try { player = JSON.parse(fs.readFileSync(playerFile, 'utf8')); }
      catch (_) { continue; }
      playersScanned++;

      // Check updatedAt field in file as well (mtime can be unreliable on some runners)
      if (!SCAN_ALL && player.updatedAt) {
        const updatedMs = new Date(player.updatedAt).getTime();
        if (!isNaN(updatedMs) && updatedMs < cutoff) continue;
      }

      for (const season of (player.seasons || [])) {
        const sid  = season.sid;
        const meta = sidMeta[sid] || { name: sid, compName: '' };

        for (const reg of (season.regs || [])) {
          const tid = reg.tid;
          if (!tid || existingTids.has(tid)) continue;

          // New team — add to index
          const seasonName = meta.name;
          if (!teamIndex[seasonName]) teamIndex[seasonName] = [];
          teamIndex[seasonName].push({
            id:    tid,
            n:     reg.tn  || '',
            sid,
            comp:  meta.compName,
            grade: reg.gn  || '',
          });
          existingTids.add(tid);
          newTeams++;
        }
      }
    }
  }

  console.log(`Players checked: ${playersChecked.toLocaleString()}`);
  console.log(`Players scanned: ${playersScanned.toLocaleString()}`);
  console.log(`New teams added: ${newTeams}`);

  if (newTeams > 0 && !DRY_RUN) {
    fs.writeFileSync(TEAM_INDEX_FILE, JSON.stringify(teamIndex));
    await gitCommit(`update-team-index: ${newTeams} new teams added`);
  } else if (newTeams === 0) {
    console.log('  No new teams found');
  }

  console.log('─'.repeat(50));
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
