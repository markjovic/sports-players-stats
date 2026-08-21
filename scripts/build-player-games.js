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
// ── EVERY git CALL NEEDS A TIMEOUT AND A maxBuffer ───────────────────────────
// 2026-08-20: a run hung after printing `staging: 1353 files changed` and never
// produced another line. That message is emitted between `git diff --staged` and
// `git commit`, so it was stuck inside one of the git commands below — and NOT in
// the retry loop, which would have printed `push attempt N failed`.
//
// execSync is SYNCHRONOUS: it blocks the whole Node process, event loop included,
// so nothing can time it out from the outside. `git fetch` and `git push` talk to
// the network against a 6 GB repo. Without a timeout a stalled connection hangs
// the job until the workflow ceiling kills it, with no output and no retry.
//
// A timeout makes execSync THROW, which the push-retry loop already handles: the
// attempt fails and is retried with jitter. Same fix applied to
// repair-players-batch.js on 2026-08-14 for the identical reason.
//
// maxBuffer too: the default is 1 MB and git output across 421k files can exceed
// it. Not the cause here, but the same class of silent failure and free to close.
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_MAXBUF     = 512 * 1024 * 1024;
const GIT_OPTS       = { cwd: ROOT, stdio: 'pipe', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF };

function gitCommit(message, paths) {
  if (DRY_RUN) return;

  let staged = 0;
  for (const p of paths) {
    try {
      execSync(`git add -- ${p}`, GIT_OPTS);
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
  const diff = execSync('git diff --staged --shortstat', GIT_OPTS).toString().trim();
  if (!diff) {
    // Legitimate: a player file already carrying the correct games[] is
    // rewritten byte-identically and therefore has nothing to commit.
    console.log(`  · no changes to commit: ${message}`);
    return;
  }
  console.log(`  staging: ${diff}`);

  // COMMIT BEFORE MERGE — merging over uncommitted changes fails outright when
  // concurrent pushes touch the same files.
  execSync(`git commit -q -m "${message}"`, GIT_OPTS);

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    // Clear any wedged MERGE_HEAD before each attempt; a no-op when not mid-merge.
    try { execSync('git merge --abort', GIT_OPTS); } catch {}
    try {
      process.stdout.write(`  … fetch/merge/push (attempt ${attempt})\n`);
      execSync('git fetch origin main', GIT_OPTS);
      // --no-stat: git merge prints a full diffstat by default (same ENOBUFS
      // class as --stat above) — scales with what's landed on main since the
      // last fetch, not with what this run is committing.
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT_OPTS);
      execSync('git push origin main', GIT_OPTS);
      console.log(`  ✔ ${message}${attempt > 1 ? ` (push attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      if (attempt === PUSH_ATTEMPTS) {
        throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${e.message.split('\n')[0]}`);
      }
      // Pure random jitter, not linear/exponential — decorrelates concurrent writers.
      const wait = 1 + Math.floor(Math.random() * 91);
      console.log(`  … push attempt ${attempt} failed, retrying in ${wait}s`);
      // Deliberately not GIT_OPTS: this is the backoff, not a git call.
      try { execSync(`sleep ${wait}`, { stdio: 'pipe', timeout: (wait + 30) * 1000 }); } catch {}
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
// Map<gid, [sid, homeTid, awayTid]> — needed ONLY to emit `u` below. Held for the
// gids we actually see, so it is bounded by the same 2.37M games phase 1 walks.
const gameMeta = new Map();
let totalGames = 0, totalAppearances = 0, unresolved = 0;

for (const fname of sids) {
  let gf;
  try { gf = readJson(path.join(gamesDir, fname)); } catch { continue; }
  const sid = fname.replace(/\.json$/, '');
  for (const [gameId, g] of Object.entries(gf.games ?? {})) {
    if (!g.p?.length) continue;
    totalGames++;
    gameMeta.set(gameId, [sid, g.h ?? null, g.a ?? null]);
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
let totalUnreg = 0, playersWithUnreg = 0, totalUnmeasurable = 0;

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

    // ── `u`: appearances the player holds NO REGISTRATION for ────────────────
    // Added 2026-08-21 (design decision in stattrack_html_design.md, View 1).
    //
    // WHY IT MUST BE EMITTED HERE RATHER THAN DERIVED IN THE APP. games[] is a flat
    // list of game IDS WITH NO SEASON, and StatTrack only ever reaches a game
    // season-first: it fetches games/bv/{sid}.json when a season card expands, and
    // season cards are built from seasons[].regs[]. An appearance for a team the
    // player never registered with therefore has no card, no season, and nothing
    // telling the app which file to load. It cannot find those games at all — 82,424
    // of them were simply invisible.
    //
    // Format "gid|sid|tid": 28 bytes, measured. [g,s,t] is 34 and {g,s,t} is 46.
    // Grouping by season/team looks cheapest at ~20 but LOSES at one game per team
    // (37 vs 28) because the ids amortise across nothing, and the real density is
    // 2.07 unregistered appearances per affected player. Whole-repo cost 2.2 MB
    // against the 314 MB games[] already occupies — 0.28% more ids.
    //
    // This is an ID LIST, not a derived statistic. It is rebuilt wholesale with
    // games[] on every run, so it cannot drift the way a stored stat total would —
    // which is exactly why stored `rstats` was rejected and this was not.
    // ⚠ THE SEASON TEST IS THE WHOLE POINT — read this before touching it.
    // The first version checked only whether the player had ANY registration
    // anywhere, and emitted 1,252,627 entries on 2026-08-21. That is the RAW
    // foreign count from the consolidation audit, and the audit splits it for a
    // reason:
    //   1,115,172  we hold this player's registrations FOR THAT SEASON and neither
    //              team matched → genuinely unregistered (fill-in or one-off)
    //     137,455  we hold NO registration for that season at all → the list is
    //              incomplete there and it says NOTHING
    // Emitting the second group labels a real registered season as a fill-in on the
    // player screen — a false accusation, not a gap. Absence of evidence is not
    // evidence of absence, and `u` must only ever carry the measurable kind.
    const regTids = new Set();
    const regSids = new Set();
    for (const t of (Array.isArray(player.teams) ? player.teams : [])) {
      if (t?.tid) regTids.add(t.tid);
      if (t?.sid) regSids.add(t.sid);
    }
    for (const se of (Array.isArray(player.seasons) ? player.seasons : [])) {
      if (se?.sid) regSids.add(se.sid);
      for (const r of (Array.isArray(se.regs) ? se.regs : [])) if (r?.tid) regTids.add(r.tid);
    }
    const unreg = [];
    let unmeasurable = 0;
    // A player with NO registrations at all is unmeasurable, not unregistered —
    // emitting every appearance would be a lie about the 1,908 players whose
    // profile was never fetched.
    if (regTids.size) {
      for (const gid of sorted) {
        const meta = gameMeta.get(gid);
        if (!meta) continue;                       // game not in games/bv this run
        const [gsid, h, a] = meta;
        if (!gsid) continue;
        if ((h && regTids.has(h)) || (a && regTids.has(a))) continue;   // registered: normal card
        // THE SEASON TEST. No registration held for this season → we cannot say the
        // player was unregistered, only that we do not know. Skip it.
        if (!regSids.has(gsid)) { unmeasurable++; continue; }
        // Record the team they appeared FOR where it can be told apart, otherwise
        // the home side. StatTrack shows this as the team name on the row.
        unreg.push(`${gid}|${gsid}|${h ?? a ?? ''}`);
      }
    }
    totalUnmeasurable += unmeasurable;
    const existingU = player.u;

    // Skip only when BOTH fields already match — a player whose games[] is
    // unchanged may still be gaining `u` on the run that introduces it.
    const gamesSame = Array.isArray(existing) &&
        existing.length === sorted.length &&
        existing.every((g, i) => g === sorted[i]);
    const uSame = (unreg.length === 0)
        ? existingU === undefined
        : (Array.isArray(existingU) && existingU.length === unreg.length &&
           existingU.every((x, i) => x === unreg[i]));
    if (gamesSame && uSame) {
      skipped++;
      continue;
    }

    if (sorted.length > 0) player.games = sorted;
    else delete player.games;

    if (unreg.length > 0) player.u = unreg;
    else delete player.u;
    totalUnreg += unreg.length;
    if (unreg.length) playersWithUnreg++;

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
console.log(`  Unregistered (u)     : ${totalUnreg.toLocaleString()} appearances across ${playersWithUnreg.toLocaleString()} players`);
console.log(`  Not emitted (unknown): ${totalUnmeasurable.toLocaleString()} appearances in seasons we hold NO registration for — cannot be called unregistered`);
console.log(`  Player files updated : ${updated.toLocaleString()}`);
console.log(`  Player files skipped : ${skipped.toLocaleString()}`);
console.log(`  Mode                 : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
