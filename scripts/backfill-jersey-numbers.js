// scripts/backfill-jersey-numbers.js
//
// Backfills jersey numbers into team-stats/bv/{sid}.json roster entries.
//
// Source: hp/ap arrays in games/bv/{sid}.json — each entry has:
//   { profileID, name, number, pts, pt1, pt2, pt3, fouls }
//
// Jersey numbers are per-team — the same player can wear different numbers
// for different teams. Map key is uuid+tid.
//
// Strategy:
//   1. Scan all games/bv/{sid}.json files chronologically (by game date)
//   2. For each game with hp/ap box score data, record the number seen for
//      each (profileID, teamId) pair — later dates overwrite earlier ones
//      (most recently seen number wins)
//   3. For each team-stats/bv/{sid}.json, write number into matching roster entry
//      — null if no number ever seen for this (uuid, tid) pair
//
// Games files are processed in date order within each season file so that
// the most recent game's number is the final value written.
//
// Progress: committed every 100 season files. Resume supported.
// Run: node scripts/backfill-jersey-numbers.js
// Dry run: node scripts/backfill-jersey-numbers.js --dry-run

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT          = path.join(__dirname, '..');
const DRY_RUN       = process.argv.includes('--dry-run');
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.backfill-jersey-progress.json');
const COMMIT_INTERVAL = 100;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
}

function gitCommit(message, dirs) {
  try {
    execSync(`git add ${dirs.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ committed: ${message}`);
  } catch (e) {
    console.error(`  ✗ git error: ${e.message}`);
  }
}

// ─── step 1: build (uuid, tid) → number map from all game box scores ─────────
//
// Games within each season file are sorted by date so the last-seen number
// per (uuid, tid) pair is the most recent.
// Key format: `${uuid}::${tid}`

console.log('Scanning games/bv/ for box score jersey numbers...');
const gamesDir  = path.join(ROOT, 'games', 'bv');
const gameFiles = fs.readdirSync(gamesDir).filter(f => f.endsWith('.json')).sort();

// uuid::tid → number (most recently seen, null if explicitly null)
const numberMap = new Map();

let gamesWithBoxScore = 0;
let numbersSeen       = 0;

for (const fname of gameFiles) {
  let gf;
  try { gf = readJson(path.join(gamesDir, fname)); } catch { continue; }

  // Sort game entries by date so later dates overwrite earlier ones
  const sorted = Object.entries(gf.games || {}).sort(([, a], [, b]) => {
    const da = a.d || '';
    const db = b.d || '';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  for (const [, g] of sorted) {
    // Determine team IDs for home and away box score sides
    // h/a = absolute orientation; t1/t2 = unknown orientation
    const hTid = g.h  || g.t1 || null;
    const aTid = g.a  || g.t2 || null;

    const sides = [];
    if (Array.isArray(g.hp) && hTid) sides.push({ players: g.hp, tid: hTid });
    if (Array.isArray(g.ap) && aTid) sides.push({ players: g.ap, tid: aTid });

    if (sides.length === 0) continue;
    gamesWithBoxScore++;

    for (const { players, tid } of sides) {
      for (const p of players) {
        const uuid   = p.profileID;
        const number = p.number ?? null;
        if (!uuid) continue;
        const key = `${uuid}::${tid}`;
        // Always overwrite — later game date wins
        numberMap.set(key, number);
        numbersSeen++;
      }
    }
  }
}

console.log(`  ${gamesWithBoxScore} games with box score data`);
console.log(`  ${numberMap.size} unique (player, team) pairs`);
console.log(`  ${numbersSeen} total player-game entries scanned`);

// ─── step 2: load progress ───────────────────────────────────────────────────

let doneSids = new Set();
if (fs.existsSync(PROGRESS_FILE)) {
  const raw = readJson(PROGRESS_FILE);
  doneSids = new Set(raw.done || []);
  console.log(`\nResuming — ${doneSids.size} season files already done`);
}

function saveProgress() {
  writeJson(PROGRESS_FILE, { done: [...doneSids] });
}

// ─── step 3: write numbers into team-stats roster entries ────────────────────

console.log('\nWriting jersey numbers into team-stats/bv/...');
const teamStatsDir  = path.join(ROOT, 'team-stats', 'bv');
const tsFiles       = fs.readdirSync(teamStatsDir).filter(f => f.endsWith('.json')).sort();

let filesProcessed  = 0;
let filesSkipped    = 0;
let numbersWritten  = 0;
let sinceLastCommit = 0;

for (const fname of tsFiles) {
  const sid = fname.replace('.json', '');

  if (doneSids.has(sid)) { filesSkipped++; continue; }

  let tsData;
  try { tsData = readJson(path.join(teamStatsDir, fname)); } catch { continue; }

  let modified = false;

  for (const [tid, team] of Object.entries(tsData)) {
    const roster = team.roster || {};
    for (const [uuid, entry] of Object.entries(roster)) {
      const key    = `${uuid}::${tid}`;
      const number = numberMap.has(key) ? numberMap.get(key) : null;
      // Only write if changed or not yet set
      if (entry.number !== number) {
        entry.number = number;
        modified     = true;
        if (number !== null) numbersWritten++;
      }
    }
  }

  if (modified && !DRY_RUN) {
    writeJson(path.join(teamStatsDir, fname), tsData);
  }

  doneSids.add(sid);
  filesProcessed++;
  sinceLastCommit++;

  if (sinceLastCommit >= COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      saveProgress();
      gitCommit(
        `backfill-jersey-numbers: ${filesProcessed} season files done`,
        ['team-stats/bv/', 'scripts/.backfill-jersey-progress.json']
      );
    }
    sinceLastCommit = 0;
    console.log(`  progress: ${filesProcessed} files, ${numbersWritten} numbers written`);
  }
}

// final commit
if (!DRY_RUN && sinceLastCommit > 0) {
  saveProgress();
  gitCommit(
    `backfill-jersey-numbers: complete — ${filesProcessed} files, ${numbersWritten} numbers`,
    ['team-stats/bv/', 'scripts/.backfill-jersey-progress.json']
  );
}

console.log('\n─── Summary ────────────────────────────────────────────────');
console.log(`  Season files processed   : ${filesProcessed}`);
console.log(`  Season files skipped     : ${filesSkipped} (already done)`);
console.log(`  (player, team) pairs     : ${numberMap.size}`);
console.log(`  Numbers written (non-null): ${numbersWritten}`);
console.log(`  Mode                     : ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
