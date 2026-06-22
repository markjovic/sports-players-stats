// scripts/backfill-player-records.js
//
// Backfills player.records.maxGamePTS and player.records.maxGameThreePt
// for the 368k players fetched before fetch-profile-stats.js was updated
// to write the records field.
//
// Source: hp[] and ap[] arrays on hidden game entries (local, no API calls).
// These cover ~424k games. For players whose career max came from a normal game
// the gameKey cannot be determined without API calls — those players get
// records written with { v } only (no gameKey/sid).
//
// Phase 1: Scan all game files, build uuid → { pts:{v,gameKey,sid}, threePt:{v,gameKey,sid} }
//          from hp/ap arrays (~1-2 min, ~300MB RAM peak)
// Phase 2: Write player.records to player files where missing (commit every N prefixes)
//
// Usage:
//   node scripts/backfill-player-records.js
//   node scripts/backfill-player-records.js --dry-run
//   node scripts/backfill-player-records.js --force   # overwrite existing records too

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT     = path.join(__dirname, '..');
const DRY_RUN  = process.argv.includes('--dry-run');
const FORCE    = process.argv.includes('--force');

const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR = path.join(ROOT, 'players');
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.backfill-player-records-progress.json');
const COMMIT_EVERY = 8;  // prefix dirs per commit (~8 × 1450 players)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gitCommit(message) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  try { execSync('git add players/', { stdio: 'pipe', cwd: ROOT }); } catch (_) {}
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
      execSync('git fetch origin main',                    { stdio: 'pipe', cwd: ROOT });
      execSync('git merge -X ours FETCH_HEAD --no-edit',  { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main',                    { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✓ ${message}`);
      return;
    } catch (_) {
      if (attempt === MAX) { console.error(`  Push failed after ${MAX} attempts`); return; }
      await sleep(Math.floor(Math.random() * 15000) + attempt * 3000);
    }
  }
}

// ── Phase 1: scan all game files for hp/ap data ──────────────────────────────

console.log('backfill-player-records.js');
if (DRY_RUN) console.log('  ⚠  DRY RUN');
if (FORCE)   console.log('  ⚠  FORCE — will overwrite existing records');
console.log('─'.repeat(50));
console.log('\nPhase 1 — Scanning game files for hp/ap data…');

// uuid → { pts: { v, gameKey, sid }, threePt: { v, gameKey, sid } }
const playerMaxMap = new Map();

function updateMax(uuid, field, v, gameKey, sid) {
  if (!playerMaxMap.has(uuid)) playerMaxMap.set(uuid, {});
  const entry = playerMaxMap.get(uuid);
  if (!entry[field] || v > entry[field].v) {
    entry[field] = { v, gameKey, sid };
  }
}

let gamesScanned = 0, hiddenGames = 0, appearances = 0;
const gameFiles = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort();

for (const fname of gameFiles) {
  const sid = fname.replace('.json', '');
  let gf;
  try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); }
  catch (_) { continue; }

  for (const [gameKey, game] of Object.entries(gf.games || {})) {
    gamesScanned++;
    const hasBoxScore = (game.hp && game.hp.length > 0) || (game.ap && game.ap.length > 0);
    if (!hasBoxScore) continue;
    hiddenGames++;

    for (const players of [game.hp || [], game.ap || []]) {
      for (const p of players) {
        const uuid = p.profileID;
        if (!uuid) continue;
        appearances++;

        // pts: use stored pts field, fall back to computing from components
        const pts   = typeof p.pts === 'number' ? p.pts
                    : (p.pt1 || 0) + (p.pt2 || 0) * 2 + (p.pt3 || 0) * 3;
        const three = typeof p.pt3 === 'number' ? p.pt3 : 0;

        if (pts   > 0) updateMax(uuid, 'pts',    pts,   gameKey, sid);
        if (three > 0) updateMax(uuid, 'threePt', three, gameKey, sid);
      }
    }
  }

  if (gamesScanned % 200 === 0)
    process.stdout.write(`  ${gamesScanned}/${gameFiles.length * 800} games…\r`);
}

console.log(`  Game files: ${gameFiles.length}`);
console.log(`  Total games scanned: ${gamesScanned.toLocaleString()}`);
console.log(`  Games with hp/ap:    ${hiddenGames.toLocaleString()}`);
console.log(`  Player appearances:  ${appearances.toLocaleString()}`);
console.log(`  Players in map:      ${playerMaxMap.size.toLocaleString()}`);
console.log();

// ── Phase 2: write player.records ────────────────────────────────────────────

console.log('Phase 2 — Writing player.records…');

// Load progress
let donePrefixes = new Set();
if (!FORCE && fs.existsSync(PROGRESS_FILE)) {
  try {
    const prog = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    donePrefixes = new Set(prog.donePrefixes || []);
    if (donePrefixes.size > 0) console.log(`  Resuming — ${donePrefixes.size} prefixes already done`);
  } catch (_) {}
}

const allPrefixes = fs.readdirSync(PLAYERS_DIR)
  .filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
const pending = allPrefixes.filter(p => !donePrefixes.has(p));
console.log(`  ${allPrefixes.length} prefix dirs | ${donePrefixes.size} done | ${pending.length} remaining`);

let written = 0, skipped = 0, noData = 0, sinceCommit = 0;

for (const prefix of pending) {
  const prefixDir = path.join(PLAYERS_DIR, prefix);
  const files = fs.readdirSync(prefixDir).filter(f => f.endsWith('.json'));

  for (const fname of files) {
    const uuid       = fname.replace('.json', '');
    const playerFile = path.join(prefixDir, fname);

    let player;
    try { player = JSON.parse(fs.readFileSync(playerFile, 'utf8')); }
    catch (_) { skipped++; continue; }

    // Skip if records already fully populated (set by fixed fetch-profile-stats.js)
    if (!FORCE && player.records?.maxGamePTS !== undefined && player.records?.maxGameThreePt !== undefined) {
      skipped++;
      continue;
    }

    const bk = player.sports?.Basketball;
    if (!bk) { skipped++; continue; }

    const storedPTS    = bk.maxGamePTS     ?? null;
    const storedThreePt = bk.maxGameThreePt ?? null;

    // Skip players with no meaningful data
    if (storedPTS === null && storedThreePt === null) { noData++; continue; }

    if (!player.records) player.records = {};

    // maxGamePTS record
    if (storedPTS !== null) {
      const mapEntry = playerMaxMap.get(uuid);
      const fromMap  = mapEntry?.pts;
      if (fromMap && fromMap.v === storedPTS) {
        // hp/ap source matches stored value — we have the gameKey
        player.records.maxGamePTS = { v: storedPTS, gameKey: fromMap.gameKey, sid: fromMap.sid };
      } else if (fromMap && fromMap.v > (storedPTS ?? 0)) {
        // hp/ap shows higher value than stored (data inconsistency) — trust stored, no gameKey
        player.records.maxGamePTS = { v: storedPTS };
      } else {
        // Career max came from a normal game — we have the value but not the gameKey
        player.records.maxGamePTS = { v: storedPTS };
      }
    }

    // maxGameThreePt record
    if (storedThreePt !== null) {
      const mapEntry  = playerMaxMap.get(uuid);
      const fromMap   = mapEntry?.threePt;
      if (fromMap && fromMap.v === storedThreePt) {
        player.records.maxGameThreePt = { v: storedThreePt, gameKey: fromMap.gameKey, sid: fromMap.sid };
      } else {
        player.records.maxGameThreePt = { v: storedThreePt };
      }
    }

    if (!DRY_RUN) {
      fs.writeFileSync(playerFile, JSON.stringify(player));
    }
    written++;
  }

  donePrefixes.add(prefix);
  sinceCommit++;

  if (sinceCommit >= COMMIT_EVERY) {
    if (!DRY_RUN) {
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ donePrefixes: [...donePrefixes] }));
      await gitCommit(
        `backfill-player-records: ${donePrefixes.size}/${allPrefixes.length} prefixes done, ${written.toLocaleString()} written`
      );
    }
    sinceCommit = 0;
    console.log(`  ${donePrefixes.size}/${allPrefixes.length} prefixes | written: ${written.toLocaleString()} | skipped: ${skipped.toLocaleString()}`);
  }
}

// Final commit
if (!DRY_RUN && sinceCommit > 0) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ donePrefixes: [...donePrefixes] }));
  await gitCommit(`backfill-player-records: complete — ${written.toLocaleString()} player files updated`);
}

// Clean up progress file
if (!DRY_RUN && fs.existsSync(PROGRESS_FILE)) {
  fs.unlinkSync(PROGRESS_FILE);
  await gitCommit('backfill-player-records: remove progress file');
}

const withGameKey   = [...playerMaxMap.values()].filter(e => e.pts?.gameKey).length;

console.log('\n─'.repeat(50));
console.log(`  Games scanned:         ${gamesScanned.toLocaleString()}`);
console.log(`  Games with hp/ap:      ${hiddenGames.toLocaleString()}`);
console.log(`  Players in hp/ap map:  ${playerMaxMap.size.toLocaleString()}`);
console.log(`  With gameKey resolved: ${withGameKey.toLocaleString()}`);
console.log(`  Player files written:  ${written.toLocaleString()}`);
console.log(`  Skipped (up to date):  ${skipped.toLocaleString()}`);
console.log(`  No stats data:         ${noData.toLocaleString()}`);
if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
