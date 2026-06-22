// scripts/update-venue-lookup.js
//
// Adds new venue-lookup entries for games scored in active seasons.
// Incremental — only processes games not already in the venue date files.
//
// For each FINAL game with venue data in active seasons:
//   1. Creates venue-lookup/{vid}/{date}.json if it doesn't exist
//   2. Adds the game entry to the correct court array if not already present
//   3. Updates venue-lookup/{vid}/dates.json with any new dates
//
// Usage:
//   node scripts/update-venue-lookup.js              # active seasons
//   node scripts/update-venue-lookup.js --dry-run    # no writes or commits
//   node scripts/update-venue-lookup.js --season=<id>

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT  = path.join(__dirname, '..');
const ARGS  = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const DRY_RUN    = !!ARGS['dry-run'];
const TARGET_SID = ARGS.season || null;

const GAMES_DIR      = path.join(ROOT, 'games', 'bv');
const VENUE_DIR      = path.join(ROOT, 'venue-lookup');
const INDEX_FILE     = path.join(ROOT, 'sports-index.json');
const COMMIT_EVERY   = 100;  // venue date files written before commit

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gitCommit(message) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  try { execSync('git add venue-lookup/', { stdio: 'pipe', cwd: ROOT }); } catch (_) {}
  const staged = (() => {
    try { return execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim(); }
    catch (_) { return ''; }
  })();
  if (!staged) { return; }
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

// Venue date file cache — { vid/date: { courtName: [gameEntry, ...] } }
const venueFileCache  = new Map();  // `${vid}/${date}` → grid object
const venueDirtyFiles = new Set();  // `${vid}/${date}` keys with pending writes
const venueDatesCache = new Map();  // vid → Set<date>

function loadVenueDateFile(vid, date) {
  const key  = `${vid}/${date}`;
  if (venueFileCache.has(key)) return venueFileCache.get(key);
  const file = path.join(VENUE_DIR, vid, `${date}.json`);
  let grid   = {};
  if (fs.existsSync(file)) {
    try { grid = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  }
  venueFileCache.set(key, grid);
  return grid;
}

function loadVenueDates(vid) {
  if (venueDatesCache.has(vid)) return venueDatesCache.get(vid);
  const file  = path.join(VENUE_DIR, vid, 'dates.json');
  const dates = fs.existsSync(file)
    ? (() => { try { return new Set(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (_) { return new Set(); } })()
    : new Set();
  venueDatesCache.set(vid, dates);
  return dates;
}

function markVenueDirty(vid, date) {
  venueDirtyFiles.add(`${vid}/${date}`);
  const dates = loadVenueDates(vid);
  dates.add(date);
}

function flushVenueFiles() {
  let count = 0;
  for (const key of [...venueDirtyFiles]) {
    const [vid, date] = key.split('/');
    const grid = venueFileCache.get(key);
    if (!grid) continue;

    const venueDir = path.join(VENUE_DIR, vid);
    if (!DRY_RUN) {
      fs.mkdirSync(venueDir, { recursive: true });
      fs.writeFileSync(path.join(venueDir, `${date}.json`), JSON.stringify(grid));
    }
    venueDirtyFiles.delete(key);
    count++;
  }

  // Write updated dates.json for any venues we touched
  for (const [vid, dates] of venueDatesCache) {
    const sortedDates = [...dates].sort();
    if (!DRY_RUN) {
      const datesFile = path.join(VENUE_DIR, vid, 'dates.json');
      if (fs.existsSync(path.join(VENUE_DIR, vid))) {
        fs.writeFileSync(datesFile, JSON.stringify(sortedDates));
      }
    }
  }

  return count;
}

async function main() {
  const startTime = Date.now();
  console.log('update-venue-lookup.js');
  if (TARGET_SID) console.log(`  Season: ${TARGET_SID}`);
  if (DRY_RUN)    console.log('  ⚠  DRY RUN — no writes or commits');
  console.log('─'.repeat(50));

  if (!fs.existsSync(INDEX_FILE)) { console.error('sports-index.json not found'); process.exit(1); }
  const sportIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const allSeasons = Object.values(sportIndex.seasons || {});

  const seasons = TARGET_SID
    ? allSeasons.filter(s => s.id === TARGET_SID)
    : allSeasons.filter(s => s.locked === false);

  console.log(`Active seasons: ${seasons.length}`);

  let gamesChecked = 0, gamesAdded = 0, venueFilesWritten = 0, sinceCommit = 0;

  for (const season of seasons) {
    const gameFile = path.join(GAMES_DIR, `${season.id}.json`);
    if (!fs.existsSync(gameFile)) continue;

    let gf;
    try { gf = JSON.parse(fs.readFileSync(gameFile, 'utf8')); }
    catch (_) { continue; }

    for (const [gameId, game] of Object.entries(gf.games || {})) {
      gamesChecked++;

      // Only process FINAL games with a venue
      if (game.st !== 'FINAL') continue;
      if (!game.vid || !game.vn)  continue;
      if (!game.d)                continue;
      if (!game.ct)               continue;  // need court name for the grid key

      const vid  = game.vid;
      const date = game.d;
      const grid = loadVenueDateFile(vid, date);

      // Check if this game is already in the file
      const court = game.ct;
      if (!grid[court]) grid[court] = [];
      if (grid[court].some(e => e.id === gameId)) continue;

      // Build the venue entry for this game
      const hid = game.h || game.t1 || null;
      const aid = game.a || game.t2 || null;
      const hn  = game.hn || game.t1n || '';
      const an  = game.an || game.t2n || '';

      const entry = {
        id:    gameId,
        t:     game.t   || null,
        hn,
        an,
        ...(hid ? { hid } : {}),
        ...(aid ? { aid } : {}),
        sid:   season.id,
        comp:  season.compName  || '',
        grade: game.gn          || '',
        st:    game.st,
      };

      grid[court].push(entry);
      // Sort games within a court by time
      grid[court].sort((a, b) => (a.t || '').localeCompare(b.t || ''));

      markVenueDirty(vid, date);
      gamesAdded++;
    }

    // Periodic flush
    if (gamesAdded - sinceCommit >= COMMIT_EVERY) {
      const n = flushVenueFiles();
      venueFilesWritten += n;
      sinceCommit = gamesAdded;
      if (n > 0) await gitCommit(`update-venue-lookup: ${venueFilesWritten} files updated (${gamesAdded} games added)`);
    }
  }

  // Final flush
  const n = flushVenueFiles();
  venueFilesWritten += n;

  console.log(`  Games checked: ${gamesChecked}`);
  console.log(`  Games added:   ${gamesAdded}`);
  console.log(`  Venue files:   ${venueFilesWritten}`);

  await gitCommit(`update-venue-lookup: ${gamesAdded} games added across ${venueFilesWritten} venue date files`);

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('─'.repeat(50));
  console.log(`  Elapsed: ${elapsed}s`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
