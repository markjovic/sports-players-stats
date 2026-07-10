// scripts/build-player-games.js
//
// Adds a `games: [gid, ...]` field to each player detail file containing
// every game ID the player appeared in, sourced from p[] arrays in game files.
// Used by StatTrack for cross-roster opposition lookup — no new files, no API.
//
// Phase 1: scan all game files and build uuid→gids map in memory (~1 min, ~250MB RAM)
// Phase 2: write games field to player files, one prefix dir at a time
//
// Progress tracks completed prefix dirs only — the map is never written to disk.
// If interrupted during phase 2, phase 1 re-runs on resume (fast) then
// continues phase 2 from the first unwritten prefix.
//
// Run:     node scripts/build-player-games.js
// Dry run: node scripts/build-player-games.js --dry-run
// Force:   node scripts/build-player-games.js --force
//
// 2026-07-10: g.p[].id may be a truncated 10-char uuid prefix (see
// scripts/lib/uuid-prefix.cjs) — part of the UUID-storage migration. It's
// resolved back to a full uuid in phase 1 before being used as the
// playerGames map key, since phase 2 looks entries up by the FULL uuid
// taken from each player file's own filename.

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { resolveToFullUuid } from './lib/uuid-prefix.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const DRY_RUN         = process.argv.includes('--dry-run');
const FORCE           = process.argv.includes('--force');
const COMMIT_INTERVAL = 8;    // commit every N prefix dirs written (8 × ~1450 players = ~11,600 per commit)
const PROGRESS_FILE   = path.join(ROOT, 'scripts', '.build-player-games-progress.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

function gitCommit(message, dirs) {
  if (DRY_RUN) return;
  try {
    execSync(`git add ${dirs.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    // --shortstat, not --stat: --stat prints a per-file line and scales with
    // file count (confirmed empirically 2026-07-10 — real ENOBUFS risk on a
    // repo this size), --shortstat stays a single small summary line.
    const diff = execSync('git diff --staged --shortstat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -q -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git fetch origin main',                   { cwd: ROOT, stdio: 'pipe' });
    // --no-stat: git merge prints a full diffstat by default (same ENOBUFS
    // class as --stat above) — scales with what's landed on main since the
    // last fetch, not with what this run is committing.
    execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat',  { cwd: ROOT, stdio: 'pipe' });
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ ${message}`);
  } catch (e) {
    console.error(`  ✗ git: ${e.message.split('\n')[0]}`);
  }
}

// ─── Load progress (prefix dirs only — never the full game map) ───────────────
let progress = { donePrefixes: [] };
if (!FORCE && fs.existsSync(PROGRESS_FILE)) {
  try { progress = readJson(PROGRESS_FILE); } catch {}
} else if (FORCE) {
  console.log('  --force: starting fresh\n');
}
const donePrefixes = new Set(progress.donePrefixes ?? []);

// ─── Phase 1: scan ALL game files → build uuid→gids map in memory ─────────────
// Always runs — takes ~1 min, never written to disk.
console.log('── Phase 1: Scanning game files (always runs, ~1 min) ───────────────');

const gamesDir = path.join(ROOT, 'games', 'bv');
const sids = fs.readdirSync(gamesDir).filter(f => f.endsWith('.json'));

// Map<uuid, Set<gid>> — uuid is always FULL length here (resolved below)
const playerGames = new Map();
let totalGames = 0, totalAppearances = 0, unresolved = 0;

for (const fname of sids) {
  let gf;
  try { gf = readJson(path.join(gamesDir, fname)); } catch { continue; }
  for (const [gameId, g] of Object.entries(gf.games ?? {})) {
    if (!g.p?.length) continue;
    totalGames++;
    for (const entry of g.p) {
      const rawId = entry.id;
      if (!rawId) continue;
      const uuid = resolveToFullUuid(rawId, ROOT);
      if (!uuid) { unresolved++; continue; }
      if (!playerGames.has(uuid)) playerGames.set(uuid, new Set());
      playerGames.get(uuid).add(gameId);
      totalAppearances++;
    }
  }
}

console.log(`  ${sids.length} seasons | ${totalGames.toLocaleString()} games | ${playerGames.size.toLocaleString()} players | ${totalAppearances.toLocaleString()} appearances`);
if (unresolved > 0) console.log(`  ⚠ ${unresolved.toLocaleString()} p[] entries could not be resolved to a player (stale/missing index entry)`);

// ─── Phase 2: write games field to player files, one prefix at a time ─────────
console.log('\n── Phase 2: Writing games field to player files ─────────────────────');

const playersDir = path.join(ROOT, 'players');
const allPrefixes = fs.readdirSync(playersDir)
  .filter(d => /^[0-9a-f]{2}$/.test(d))
  .sort();

const pendingPrefixes = allPrefixes.filter(p => !donePrefixes.has(p));
console.log(`  ${allPrefixes.length} prefix dirs | ${donePrefixes.size} already done | ${pendingPrefixes.length} remaining`);

let updated = 0, skipped = 0, sinceCommit = 0;

for (const prefix of pendingPrefixes) {
  const prefixDir = path.join(playersDir, prefix);
  const files = fs.readdirSync(prefixDir).filter(f => f.endsWith('.json'));

  for (const fname of files) {
    const uuid = fname.replace('.json', '');
    const gids = playerGames.get(uuid);
    const playerPath = path.join(prefixDir, fname);

    let player;
    try { player = readJson(playerPath); } catch { skipped++; continue; }

    const sorted = gids ? [...gids].sort() : [];
    const existing = player.games;

    // Skip if already identical
    if (Array.isArray(existing) &&
        existing.length === sorted.length &&
        existing.every((g, i) => g === sorted[i])) {
      skipped++;
      continue;
    }

    if (sorted.length > 0) player.games = sorted;
    else delete player.games;

    if (!DRY_RUN) writeJson(playerPath, player);
    updated++;
  }

  donePrefixes.add(prefix);
  sinceCommit++;

  if (sinceCommit >= COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      writeJson(PROGRESS_FILE, { donePrefixes: [...donePrefixes] });
      gitCommit(
        `build-player-games: ${donePrefixes.size}/${allPrefixes.length} prefix dirs done, ${updated.toLocaleString()} files updated`,
        ['players/', 'scripts/.build-player-games-progress.json']
      );
    }
    sinceCommit = 0;
    console.log(`  ${donePrefixes.size}/${allPrefixes.length} prefixes done — ${updated.toLocaleString()} updated`);
  }
}

if (!DRY_RUN && sinceCommit > 0) {
  gitCommit(
    `build-player-games: complete — ${updated.toLocaleString()} player files updated`,
    ['players/']
  );
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
if (!DRY_RUN && fs.existsSync(PROGRESS_FILE)) {
  fs.unlinkSync(PROGRESS_FILE);
  gitCommit('build-player-games: remove progress file', ['scripts/.build-player-games-progress.json']);
}

console.log('\n─── Summary ─────────────────────────────────────────────────────────');
console.log(`  Seasons scanned      : ${sids.length.toLocaleString()}`);
console.log(`  Games processed      : ${totalGames.toLocaleString()}`);
console.log(`  Player appearances   : ${totalAppearances.toLocaleString()}`);
console.log(`  Unresolved p[] ids   : ${unresolved.toLocaleString()}`);
console.log(`  Player files updated : ${updated.toLocaleString()}`);
console.log(`  Player files skipped : ${skipped.toLocaleString()}`);
console.log(`  Mode                 : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
