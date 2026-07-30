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
// g.p[].id is stored TRUNCATED at TRUNC_LEN = 13 (see scripts/lib/uuid-prefix.cjs).
// It is resolved back to a full uuid in phase 1 before being used as the
// playerGames map key, since phase 2 looks entries up by the FULL uuid taken
// from each player file's own filename. resolveToFullUuid is alias-aware
// (players/indexes first, players/aliases fallback at trunc-13 and the legacy
// 10-char length, self-wins on full ids).
//   2026-07-30: this comment previously said "truncated 10-char uuid prefix".
//   10 chars is only 9 real hex digits (the first hyphen sits at index 8) = 36
//   bits ≈ 63% birthday-collision probability at ~370k players, which is exactly
//   why TRUNC_LEN was moved to 13. The 10-char path survives only as the
//   resolver's legacy fallback.

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
const PUSH_ATTEMPTS   = 60;
const PROGRESS_FILE   = path.join(ROOT, 'scripts', '.build-player-games-progress.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

// ─── House git pattern ────────────────────────────────────────────────────────
// Stage per-path → print the staged shortstat → COMMIT FIRST → fetch/merge -X
// ours/push with a 60-attempt random-jitter retry → THROW when exhausted.
//
// Per-path staging: `git add` is ATOMIC across pathspecs. One combined
// `git add a b` where ANY pathspec matches nothing (absent AND untracked) exits
// 128 and stages NOTHING — including the valid paths beside it. That is the
// shape that discarded a whole 28-minute discover-fixtures run (30,426 games,
// 2026-07-19). Staging each path in its own try/catch means a miss skips only
// itself, and the printed shortstat proves what actually staged.
//
// THROW on exhausted push: the old version caught every git failure, printed one
// stderr line and returned, so a lost push under contention discarded that
// commit's ~11,600 player files while the job stayed green. This script writes
// players/ — the most contended path in the repo — so it needs the same retry
// the other player-file writers use. A red job beats silently discarded work.
function gitCommit(message, paths) {
  if (DRY_RUN) return;

  let staged = 0;
  for (const p of paths) {
    try {
      execSync(`git add -- ${p}`, { cwd: ROOT, stdio: 'pipe' });
      staged++;
    } catch (e) {
      // Absent AND untracked (or ignored) — skip this path only.
      console.log(`  · not staged: ${p} — ${e.message.split('\n')[0]}`);
    }
  }
  if (!staged) {
    console.log(`  · nothing staged, skipping commit: ${message}`);
    return;
  }

  // --shortstat, not --stat: --stat prints a per-file line and scales with
  // file count (confirmed empirically 2026-07-10 — real ENOBUFS risk on a
  // repo this size), --shortstat stays a single small summary line.
  const diff = execSync('git diff --staged --shortstat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
  if (!diff) {
    // Legitimate: a player file already carrying the correct games[] is
    // rewritten byte-identically and therefore has nothing to commit.
    console.log(`  · no changes to commit: ${message}`);
    return;
  }
  console.log(`  staging: ${diff}`);

  // COMMIT BEFORE MERGE — merging over uncommitted changes fails outright when
  // concurrent pushes touch the same files.
  execSync(`git commit -q -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    // Clear any wedged MERGE_HEAD before each attempt; a no-op when not mid-merge.
    try { execSync('git merge --abort', { cwd: ROOT, stdio: 'pipe' }); } catch {}
    try {
      execSync('git fetch origin main', { cwd: ROOT, stdio: 'pipe' });
      // --no-stat: git merge prints a full diffstat by default (same ENOBUFS
      // class as --stat above) — scales with what's landed on main since the
      // last fetch, not with what this run is committing.
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', { cwd: ROOT, stdio: 'pipe' });
      execSync('git push origin main', { cwd: ROOT, stdio: 'pipe' });
      console.log(`  ✔ ${message}${attempt > 1 ? ` (push attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      if (attempt === PUSH_ATTEMPTS) {
        throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${e.message.split('\n')[0]}`);
      }
      // Pure random jitter, not linear/exponential — decorrelates concurrent writers.
      const wait = 1 + Math.floor(Math.random() * 91);
      console.log(`  … push attempt ${attempt} failed, retrying in ${wait}s`);
      try { execSync(`sleep ${wait}`, { stdio: 'pipe' }); } catch {}
    }
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
