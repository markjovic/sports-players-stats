// scripts/build-finals-stats.js
//
// Scans all games/bv/{sid}.json files for finals games (any game where rn
// contains "final" case-insensitive), then counts per player per season:
//
//   finals      — total finals appearances (SF, PF, GF, etc.)
//   gfApps      — Grand Final appearances specifically
//   gfWins      — Grand Final wins
//
// Career stats additionally compute:
//   finalsPerSeason — career finals / seasons with at least one game
//
// Team assignment (needed for win determination) is resolved from
// team-stats/bv/{sid}.json — no API calls needed.
//
// Writes results to:
//   - player files: reg.stats.{finals, gfApps, gfWins}
//   - player files: reg.stats.fstats = {gp, pts, tp, f}   (per-SEASON finals box totals)
//   - player files: player.sports.Basketball.{finals, gfApps, gfWins, finalsPerSeason}
//   - player files: player.sports.Basketball.finalsStats = {gp, pts, threePt, fouls}
//
// 2026-08-04 — FINALS PERFORMANCE BLOCK. The finals/gfApps/gfWins flags say a player
// WAS THERE; finalsStats says how they PLAYED: gp counts finals games appeared in
// (forfeits excluded, matching fetch-profile-stats and build-leaderboards), and
// pts/threePt/fouls sum the hp/ap box lines for those games. StatTrack renders the
// career-vs-finals comparison from it (0.70). Same pass also widened appearance
// counting from g.p[] alone to g.p[] UNION hp/ap — a player with a box-score line in
// a finals game undeniably appeared in it, and p[] has missed players before.
//
// After this runs, rebuild leaderboards:
//   node scripts/build-leaderboards.js --force
//
// Run:         node scripts/build-finals-stats.js
// Active only: node scripts/build-finals-stats.js --active-only
//              (unlocked seasons scan-authoritative; locked seasons' regs are
//               NEVER modified and their existing flags are preserved in the
//               career totals — see Phase 2)
// Dry run:     node scripts/build-finals-stats.js --dry-run
// Resume:      NONE — Phase 1 always scans from zero (2026-08-05). The old committed
//              progress file serialised the ENTIRE finalsMap and scaled with finals
//              data: the v2 fields pushed it to 110MB, past GitHub's HARD 100MB cap,
//              killing a full run mid-flight. The commit-your-progress rule protects
//              API BUDGET on fetch jobs; this is pure local compute — a lost scan
//              costs a ~1h re-scan, nothing else — so it follows the
//              build-player-games pattern: the map lives in memory, full stop.
//              (Historical note — the removed mechanism was MODE-KEYED so a full-run
//              file was discarded by
//              an active-only run and vice versa)
//
// 2026-07-10: g.p[].id and g.hp[]/ap[].profileID may be truncated 10-char
// uuid prefixes (see scripts/lib/uuid-prefix.cjs) — part of the UUID-storage
// migration. Both are resolved back to full uuids before being used as
// finalsMap keys or membership-test sets, since finalsMap is ultimately
// written out keyed by the FULL uuid (player file lookups need it).

'use strict';

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { resolveToFullUuid } from './lib/uuid-prefix.cjs';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));


const ROOT             = path.join(__dirname, '..');
const DRY_RUN          = process.argv.includes('--dry-run');
const ACTIVE_ONLY      = process.argv.includes('--active-only');
const MODE             = ACTIVE_ONLY ? 'active' : 'full';
const GAME_COMMIT_INTERVAL   = 200;
const PLAYER_COMMIT_INTERVAL = 2000;
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.finals-progress.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

function gitCommit(message, dirs) {
  // Staging: PER-PATH adds — `git add` is ATOMIC across pathspecs, so one
  // combined add with any unmatched pathspec stages NOTHING (this exact bug
  // silently discarded a whole discover-fixtures run, 2026-07-19). Per-path,
  // a miss skips only itself and is logged. Staged shortstat is printed so
  // the log proves what was staged. COMMIT FIRST, then fetch/merge/push with
  // the proven retry pattern copied from build-win-loss.js (60 attempts,
  // random 1-91s jitter, merge --abort cleanup, merge -X ours). THROW on
  // total push failure — a red job beats silently discarded work.
  if (!dirs || !dirs.length) { console.error('  gitCommit: no paths given — refusing blanket add'); return; }
  try {
    for (const dir of dirs) {
      try {
        execSync(`git add ${dir}`, { stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
      } catch (e) {
        console.error(`  staging miss (skipped): ${dir} — ${e.stderr?.toString().slice(0, 120) || e.message.slice(0, 120)}`);
      }
    }
    const staged = execSync('git diff --staged --shortstat',
      { stdio: 'pipe', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).toString().trim();
    if (!staged) { console.log('  nothing to commit'); return; }
    console.log(`  staging: ${staged}`);
    execSync(`git commit -q -m "${message}"`, { stdio: 'pipe', cwd: ROOT });
  } catch (e) {
    console.error('  git error (stage/commit):', e.stderr?.toString().slice(0, 200) || e.message.slice(0, 200));
    return;
  }
  for (let attempt = 1; attempt <= 60; attempt++) {
    try { execSync('git merge --abort', { stdio: 'pipe', cwd: ROOT }); } catch (_) { /* none in progress */ }
    try {
      execSync('git fetch origin main',                            { stdio: 'pipe', cwd: ROOT });
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main',                             { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✔ committed: ${message}`);
      return;
    } catch (e) {
      // PERMANENT rejections: retrying cannot succeed. A pre-receive hook declining an
      // oversized file is the git equivalent of an HTTP 4xx — fail fast so the real
      // error is the FIRST thing in the log, not the 60th. (2026-08-05: a 110MB
      // progress file burned all 60 attempts and buried the cause.)
      const errText = (e.stderr?.toString() || '') + (e.message || '');
      if (/exceeds GitHub's file size limit|GH001|Large files detected/i.test(errText)) {
        throw new Error(`push permanently rejected (oversized file) — not retrying: ${errText.split('\n').find(l => /exceeds|GH001/.test(l))?.trim() || errText.slice(0, 200)}`);
      }
      if (attempt === 60) {
        console.error('  git push failed after 60 attempts:', e.stderr?.toString().slice(0, 200) || e.message.slice(0, 200));
        throw e;
      }
      const s = 1 + Math.floor(Math.random() * 91);
      execSync(`sleep ${s}`, { stdio: 'pipe', cwd: ROOT });
    }
  }
}

function isFinal(rn) {
  if (!rn) return false;
  return rn.toLowerCase().includes('final');
}

function isGrandFinal(rn) {
  if (!rn) return false;
  const r = rn.toLowerCase();
  return r.includes('grand final') || r === 'gf';
}

// ─── Pre-pass: build uuid→sid→Set<tid> from player files ────────────────────
// Needed to resolve which team a player was on in g.p[]-only GF games (no hp/ap).

console.log('── Pre-pass: building player→season→team map ───────────────────────');
const playersDir2 = path.join(ROOT, 'players');
const playerTids  = new Map(); // uuid → Map<sid, Set<tid>>
const prefixes2   = fs.readdirSync(playersDir2).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
let preCount = 0;
for (const prefix of prefixes2) {
  const dir = path.join(playersDir2, prefix);
  for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
    const uuid = fname.replace('.json', '');
    let player; try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
    if (!player.sports?.Basketball) continue;
    const sidMap = new Map();
    for (const season of (player.seasons || [])) {
      for (const reg of (season.regs || [])) {
        if (!reg.tid) continue;
        if (!sidMap.has(season.sid)) sidMap.set(season.sid, new Set());
        sidMap.get(season.sid).add(reg.tid);
      }
    }
    if (sidMap.size > 0) playerTids.set(uuid, sidMap);
    preCount++;
    if (preCount % 50000 === 0) process.stdout.write(`  Pre-pass: ${preCount} players…
`);
  }
}
console.log(`  Pre-pass complete: ${preCount} players, ${playerTids.size} with season data`);

// ─── Phase 1: scan game files ─────────────────────────────────────────────────
// finalsMap: Map<uuid, Map<sid, {finals, gfApps, gfWins}>>

console.log('\n── Phase 1: Scanning game files for finals ─────────────────────────');

const gamesDir     = path.join(ROOT, 'games', 'bv');
const teamStatsDir = path.join(ROOT, 'team-stats', 'bv');

const sids = fs.readdirSync(gamesDir)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''))
  .sort();

// No persisted progress (see header). One-time hygiene: if a committed progress file
// from the old mechanism is still on disk, remove it and stage the deletion so the
// repo sheds the near-100MB blob at the next Phase 2 commit.
const scannedSids = new Set();
const finalsMap = new Map();
if (fs.existsSync(PROGRESS_FILE)) {
  try { fs.unlinkSync(PROGRESS_FILE); console.log('  Removed legacy committed progress file (deletion staged with the next commit)'); } catch {}
}

let totalFinalsGames = 0;
let totalGFGames     = 0;
let attributedTid    = 0;   // finals appearances attributed to a specific team
let undeterminedTid  = 0;   // ...and those that could not be (the '?' bucket)
let sinceLastCommit  = 0;

// In active-only mode restrict to unlocked seasons
let candidateSids = sids;
if (ACTIVE_ONLY) {
  const sportsIndex = readJson(path.join(ROOT, 'data', 'sports-index.json'));
  const activeSids  = new Set(
    Object.values(sportsIndex.seasons ?? {})
      .filter(s => !s.locked)
      .map(s => s.id)
  );
  candidateSids = sids.filter(s => activeSids.has(s));
  console.log(`  Active-only: ${activeSids.size} active seasons`);
}

const sidsToScan = candidateSids.filter(s => !scannedSids.has(s));
console.log(`  ${sids.length} total seasons, ${candidateSids.length} in scope, ${scannedSids.size} already scanned, ${sidsToScan.length} remaining`);

// Scanned scope for Phase 2: in active-only mode, ONLY these seasons are
// scan-authoritative — every other season's regs must be left untouched and
// their existing flags preserved. null = full mode, everything in scope.
const scopeSet = ACTIVE_ONLY ? new Set(candidateSids) : null;

for (const sid of sidsToScan) {
  // Load game file
  let gf;
  try { gf = readJson(path.join(gamesDir, `${sid}.json`)); } catch { scannedSids.add(sid); continue; }

  // Check if this season has any finals at all before loading team-stats
  // entries(), not values(): the GID is the whole point of the 2026-08-05 change —
  // StatTrack fetches finals box scores per-gid from the Worker at runtime.
  const finalsGames = Object.entries(gf.games || {}).filter(([, g]) => isFinal(g.rn));
  if (finalsGames.length === 0) { scannedSids.add(sid); continue; }

  // Resolve uuid→tid from the game entry itself (h/a team IDs)
  // We determine team from whether player is in homePlayers or awayPlayers below
  // uuidToTid built per-game for GF win determination
  const uuidToTid = new Map();

  for (const [gid, g] of finalsGames) {
    const gf_flag = isGrandFinal(g.rn);
    if (gf_flag) totalGFGames++;
    totalFinalsGames++;

    // Determine winning tid (null = draw or unknown)
    const hs = g.hs ?? g.s1 ?? null;
    const as = g.as ?? g.s2 ?? null;
    let winnerTid = null;
    if (hs != null && as != null) {
      if (hs > as) winnerTid = g.h || g.t1 || null;
      else if (as > hs) winnerTid = g.a || g.t2 || null;
    }

    // Build uuid→tid from p[] + game h/a for win determination
    // p[] has all players but no team — use hp/ap if available, else use game.h/game.a heuristic
    const homeTid = g.h || g.t1 || null;
    const awayTid = g.a || g.t2 || null;
    // hp/ap.profileID may be a truncated prefix (existing games data rewritten
    // by the one-off migration) or a full uuid — resolve before using as a
    // membership-test key, and drop any that can't be resolved. Maps (not Sets):
    // the box entry itself feeds the finals performance accumulation below.
    const homeEntries = new Map();
    for (const p of (g.hp || [])) {
      const u = p.profileID && resolveToFullUuid(p.profileID, ROOT);
      if (u) homeEntries.set(u, p);
    }
    const awayEntries = new Map();
    for (const p of (g.ap || [])) {
      const u = p.profileID && resolveToFullUuid(p.profileID, ROOT);
      if (u) awayEntries.set(u, p);
    }
    // Appearance basis: g.p[] UNION hp/ap. A box-score line is proof of appearance
    // even when p[] missed the player.
    const attendees = new Set([...homeEntries.keys(), ...awayEntries.keys()]);
    for (const pEntry of (g.p || [])) {
      if (!pEntry.id) continue;
      const u = resolveToFullUuid(pEntry.id, ROOT);
      if (u) attendees.add(u);
    }

    for (const uuid of attendees) {
      // WHICH TEAM did this player play THIS final for? Determined ONCE and reused for
      // the accumulator key, the W/L side and the GF-win check.
      //
      // 2026-08-05 — the accumulator used to be keyed per SID, and Phase 2 wrote those
      // flags to EVERY reg in the season. A player who reached finals with one team was
      // therefore medalled on every team row they held that season (found by Mark).
      // Keying per (sid, tid) makes the flag belong to the team that actually played the
      // final. hp/ap membership is authoritative; the pre-pass reg map is the fallback;
      // genuine ambiguity (player registered to BOTH sides, or neither) yields null and
      // lands in the '?' bucket, which Phase 2 still merges into every reg for that
      // season — the old behaviour, now confined to the cases that need it and COUNTED
      // in the summary so its frequency is visible instead of assumed.
      let side = null;
      if (homeEntries.has(uuid)) side = 'h';
      else if (awayEntries.has(uuid)) side = 'a';
      else {
        const tids = playerTids.get(uuid)?.get(sid);
        if (tids) {
          const inHome = homeTid && tids.has(homeTid);
          const inAway = awayTid && tids.has(awayTid);
          if (inHome && !inAway) side = 'h';
          else if (inAway && !inHome) side = 'a';
        }
      }
      const pTid = side === 'h' ? homeTid : side === 'a' ? awayTid : null;
      if (pTid) attributedTid++; else undeterminedTid++;
      const key = `${sid}|${pTid || '?'}`;

      if (!finalsMap.has(uuid)) finalsMap.set(uuid, new Map());
      const sidMap = finalsMap.get(uuid);
      if (!sidMap.has(key)) sidMap.set(key, { sid, tid: pTid, finals: 0, gfApps: 0, gfWins: 0, fgp: 0, fpts: 0, f3pt: 0, ff: 0, fw: 0, fl: 0, fd: 0, bgp: 0, gids: [] });
      const acc = sidMap.get(key);

      acc.finals = 1;
      // Finals performance: forfeits excluded (no game was played — counting one
      // deflates finals PPG), matching the forfeit-games treatment everywhere else.
      if (!g.forfeit) {
        acc.fgp = (acc.fgp || 0) + 1;
        // The gid list is what makes finals SCORING possible at all. Box lines are not
        // stored in the repo (spc:1 games fetch them live from the Worker), so the
        // server cannot sum them — but with the gids on the player file StatTrack can
        // fetch exactly this player's finals box scores on demand and aggregate
        // client-side. Same pattern as the 0.65/0.66 opposition views: zero data cost.
        if (acc.gids.length < 60) acc.gids.push(gid);   // cap: pathological careers
        // Box lines are NOT persisted for normal games (spc:1 = fetched live via the
        // Worker; measured 2026-08-05: 10 of 6,501 games in a live season file carry
        // hp/ap — hidden-game reconstructions only). bgp counts the games where a box
        // line EXISTS, and it is the denominator for finals scoring rates: pts over
        // fgp would slander every player whose finals aren't boxed. The one-off
        // spectator backfill of finals games raises bgp; until then most players
        // render "—" for the scoring cells, never zeros.
        const box = homeEntries.get(uuid) || awayEntries.get(uuid);
        if (box) {
          acc.bgp  = (acc.bgp || 0) + 1;
          acc.fpts += box.pts   || 0;
          acc.f3pt += box.pt3   || 0;
          acc.ff   += box.fouls || 0;
        }
        // Finals W/L/D — computable TODAY for every scored finals game: side from the
        // box entry when present, else the pre-pass reg map (same attribution the GF
        // logic below has always used).
        if (g.hs !== undefined && g.as !== undefined && g.hs !== null && g.as !== null) {
          if (side) {
            const my = side === 'h' ? g.hs : g.as, opp = side === 'h' ? g.as : g.hs;
            if (my > opp) acc.fw++; else if (my < opp) acc.fl++; else acc.fd++;
          }
        }
      }
      if (gf_flag) {
        acc.gfApps = 1;
        // pTid is the same determination this block used to make inline.
        if (pTid && winnerTid && pTid === winnerTid) acc.gfWins = 1;
      }
    }
  }

  scannedSids.add(sid);
  sinceLastCommit++;

  if (sinceLastCommit >= GAME_COMMIT_INTERVAL) {
    sinceLastCommit = 0;
    console.log(`  ${scannedSids.size}/${sids.length} seasons — ${finalsMap.size} players, ${totalFinalsGames} finals games`);
  }
}

console.log(`\n  Scan complete:`);
console.log(`  ${totalFinalsGames} finals games found`);
console.log(`  ${totalGFGames} Grand Finals found`);
console.log(`  ${finalsMap.size} players with finals appearances`);

// ─── Phase 2: write to player files ──────────────────────────────────────────

console.log('\n── Phase 2: Writing finals stats to player files ───────────────────');
console.log(`  ${finalsMap.size} player files to update`);

const playersDir = path.join(ROOT, 'players');
let playersUpdated = 0;
let playersSkipped = 0;
// Declared HERE, with their siblings and BEFORE the player loop that increments
// them. A `let` declared after the loop is in the temporal dead zone when the loop
// runs, and `node --check` does NOT catch it (hit exactly that in db-audit.js
// on 2026-07-31).
// sidsNotInSeasons: player appeared in a scanned game for a season absent from their
// own seasons[] — the data gap that used to push finalsPerSeason above 1.
let sidsNotInSeasons = 0;
let invariantBreaks  = 0;
sinceLastCommit = 0;

for (const [uuid, sidMap] of finalsMap) {
  const prefix     = uuid.slice(0, 2);
  const playerPath = path.join(playersDir, prefix, `${uuid}.json`);

  let player;
  try { player = readJson(playerPath); } catch { playersSkipped++; continue; }

  let modified = false;

  // Career totals — the scan is authoritative ONLY for in-scope seasons.
  // In active-only mode, out-of-scope (locked) seasons contribute their
  // EXISTING reg.stats flags; recomputing career values from the active-only
  // finalsMap alone would overwrite e.g. a 12-career-finals veteran with
  // finals=1 (the pre-2026-07-21 bug — never shipped live, fixed before its
  // first --active-only run). Pattern mirrors build-win-loss.js active-only
  // Pass 2: locked seasons untouched, their contribution preserved.
  let careerFinals = 0, careerGfApps = 0, careerGfWins = 0;
  const cPerf = { gp: 0, pts: 0, threePt: 0, fouls: 0, wins: 0, losses: 0, draws: 0, boxedGp: 0 };   // career finals performance
  const cGids = [];   // every finals gid across the career — StatTrack hydrates from these
  // 2026-07-31: finalsPerSeason could still exceed 1 (1 player live). The earlier fix
  // here swapped `r.stats.gp > 0` for `regs.length > 0` in the denominator, which
  // addressed stale gp but NOT the actual cause: the numerator is built from sidMap,
  // which comes from the GAME SCAN, while the denominator came only from
  // player.seasons. A sid can be in sidMap and absent from the denominator when the
  // player appeared in a finals game for a season that is missing from their own
  // seasons[], or present there with an empty regs[]. Numerator counts it, denominator
  // does not, ratio > 1.
  //
  // Fixed by construction rather than by clamping: both sides are now SETS of sids,
  // and every sid added to the finals set is added to the played set at the same time.
  // The numerator is therefore a subset of the denominator and the ratio CANNOT exceed
  // 1 — a clamp would have hidden the underlying data gap instead of surfacing it.
  const playedSids = new Set();
  for (const s of (player.seasons || [])) {
    if ((s.regs || []).length > 0) playedSids.add(s.sid);
  }
  const finalsSids = new Set();

  // Buckets are keyed `sid|tid` since 2026-08-05, so the season id comes from the
  // bucket itself. careerFinals is set from finalsSids.size AFTER both loops — counting
  // buckets would report 2 finals for one season in which a player made finals with two
  // teams, changing the meaning of bball.finals from "seasons" to "team-seasons".
  for (const acc of sidMap.values()) {
    const sid = acc.sid;
    // Appearing in a scanned game IS proof the player played that season, whatever
    // player.seasons says. Counted here so it can never be missing from the denominator.
    if (!playedSids.has(sid)) { playedSids.add(sid); sidsNotInSeasons++; }
    if (acc.finals > 0)  finalsSids.add(sid);
    if (acc.gfApps > 0)    careerGfApps++;
    if (acc.gfWins > 0)    careerGfWins++;
    cPerf.gp      += acc.fgp  || 0;
    cPerf.pts     += acc.fpts || 0;
    cPerf.threePt += acc.f3pt || 0;
    cPerf.fouls   += acc.ff   || 0;
    cPerf.wins    += acc.fw   || 0;
    cPerf.losses  += acc.fl   || 0;
    cPerf.draws   += acc.fd   || 0;
    cPerf.boxedGp += acc.bgp  || 0;
    for (const g of (acc.gids || [])) if (!cGids.includes(g)) cGids.push(g);
  }
  if (scopeSet) {
    // Active-only: fold in the preserved flags of every out-of-scope season.
    const counted = new Set();
    const scannedBucketSids = new Set();
    for (const acc of sidMap.values()) scannedBucketSids.add(acc.sid);
    for (const season of (player.seasons || [])) {
      const sid = season.sid;
      // sidMap is keyed `sid|tid`, so membership is tested against the bucket sids.
      if (scopeSet.has(sid) || scannedBucketSids.has(sid) || counted.has(sid)) continue;
      counted.add(sid);
      let exFinals = 0, exGfApps = 0, exGfWins = 0, exPerf = null;
      for (const reg of (season.regs || [])) {
        const st = reg.stats || {};
        if (st.finals > 0) exFinals = 1;
        if (st.gfApps > 0) exGfApps = 1;
        if (st.gfWins > 0) exGfWins = 1;
        // Siblings carry identical fstats blocks — take the first one present.
        if (!exPerf && st.fstats && st.fstats.gp > 0) exPerf = st.fstats;
      }
      if (exFinals) { finalsSids.add(sid); playedSids.add(sid); }   // careerFinals = finalsSids.size below
      if (exGfApps)   careerGfApps++;
      if (exGfWins)   careerGfWins++;
      if (exPerf) {
        cPerf.gp      += exPerf.gp  || 0;
        cPerf.pts     += exPerf.pts || 0;
        cPerf.threePt += exPerf.tp  || 0;
        cPerf.fouls   += exPerf.f   || 0;
        cPerf.wins    += exPerf.w   || 0;
        cPerf.losses  += exPerf.l   || 0;
        cPerf.draws   += exPerf.d   || 0;
        cPerf.boxedGp += exPerf.bg  || 0;
        for (const g of (exPerf.g || [])) if (!cGids.includes(g)) cGids.push(g);
      }
    }
  }

  // finalsPerSeason = fraction of seasons where player appeared in finals (max 1 per season)
  // Seasons, not team-seasons (see the career loop comment).
  careerFinals = finalsSids.size;
  const seasonsWithGames  = playedSids.size;
  const seasonsWithFinals = finalsSids.size;
  const finalsPerSeason = seasonsWithGames > 0
    ? Math.round((seasonsWithFinals / seasonsWithGames) * 100) / 100
    : 0;
  // Belt and braces: finalsSids is a subset of playedSids by construction, so this is
  // unreachable. If it ever fires, the invariant has been broken by a later edit —
  // report it loudly rather than writing a value db-audit will flag as impossible.
  if (finalsPerSeason > 1) {
    console.warn(`  ⚠ INVARIANT BROKEN ${uuid}: finalsPerSeason=${finalsPerSeason} (${seasonsWithFinals}/${seasonsWithGames}) — numerator is not a subset of denominator`);
    invariantBreaks++;
  }

  if (!player.sports)            player.sports = {};
  if (!player.sports.Basketball) player.sports.Basketball = {};
  const bball = player.sports.Basketball;
  if ((bball.finals          ?? -1) !== careerFinals)      { bball.finals          = careerFinals;      modified = true; }
  if ((bball.gfApps          ?? -1) !== careerGfApps)      { bball.gfApps          = careerGfApps;      modified = true; }
  if ((bball.gfWins          ?? -1) !== careerGfWins)      { bball.gfWins          = careerGfWins;      modified = true; }
  if ((bball.finalsPerSeason ?? -1) !== finalsPerSeason)   { bball.finalsPerSeason = finalsPerSeason;   modified = true; }
  // finalsStats: written when the player has any non-forfeit finals game; deleted when
  // stale. Field-wise compare so an unchanged block does not mark the file modified.
  if (cPerf.gp > 0) {
    const ex = bball.finalsStats;
    const gidsSame = ex && Array.isArray(ex.gids) && ex.gids.length === cGids.length && ex.gids.every((g, i) => g === cGids[i]);
    if (!ex || ex.gp !== cPerf.gp || ex.pts !== cPerf.pts || ex.threePt !== cPerf.threePt || ex.fouls !== cPerf.fouls
        || ex.wins !== cPerf.wins || ex.losses !== cPerf.losses || ex.draws !== cPerf.draws || ex.boxedGp !== cPerf.boxedGp
        || !gidsSame) {
      bball.finalsStats = { gp: cPerf.gp, boxedGp: cPerf.boxedGp, pts: cPerf.pts, threePt: cPerf.threePt,
        fouls: cPerf.fouls, wins: cPerf.wins, losses: cPerf.losses, draws: cPerf.draws, gids: cGids };
      modified = true;
    }
  } else if (bball.finalsStats !== undefined) { delete bball.finalsStats; modified = true; }

  // Per-reg: write each TEAM's own finals data to that team's regs (2026-08-05).
  // Lookup is `sid|tid`, merged with the season's '?' bucket — appearances whose team
  // could not be determined keep the old write-to-every-reg behaviour rather than being
  // dropped. Sibling regs sharing a tid still receive identical values (by design; T20).
  // In active-only mode, out-of-scope seasons are SKIPPED entirely — the `?? zeros`
  // fallback below would otherwise DELETE their preserved flags.
  const ZERO_ACC = { finals: 0, gfApps: 0, gfWins: 0, fgp: 0, fpts: 0, f3pt: 0, ff: 0, fw: 0, fl: 0, fd: 0, bgp: 0, gids: [] };
  const mergeAcc = (a, b) => {
    if (!a) return b; if (!b) return a;
    return {
      finals: Math.max(a.finals || 0, b.finals || 0),
      gfApps: Math.max(a.gfApps || 0, b.gfApps || 0),
      gfWins: Math.max(a.gfWins || 0, b.gfWins || 0),
      fgp: (a.fgp || 0) + (b.fgp || 0), fpts: (a.fpts || 0) + (b.fpts || 0),
      f3pt: (a.f3pt || 0) + (b.f3pt || 0), ff: (a.ff || 0) + (b.ff || 0),
      fw: (a.fw || 0) + (b.fw || 0), fl: (a.fl || 0) + (b.fl || 0), fd: (a.fd || 0) + (b.fd || 0),
      bgp: (a.bgp || 0) + (b.bgp || 0),
      gids: [...new Set([...(a.gids || []), ...(b.gids || [])])],
    };
  };
  for (const season of (player.seasons || [])) {
    const sid = season.sid;
    if (scopeSet && !scopeSet.has(sid)) continue;
    const unknownAcc = sidMap.get(`${sid}|?`) || null;
    for (const reg of (season.regs || [])) {
      const acc = mergeAcc(sidMap.get(`${sid}|${reg.tid}`) || null, unknownAcc) || ZERO_ACC;
      if (!reg.stats) reg.stats = {};
      // Only write non-zero values — omit zeros to save space
      if (acc.finals > 0)  { if ((reg.stats.finals ?? 0) !== acc.finals)  { reg.stats.finals  = acc.finals;  modified = true; } }
      else if (reg.stats.finals  !== undefined) { delete reg.stats.finals;  modified = true; }
      if (acc.gfApps > 0)  { if ((reg.stats.gfApps ?? 0) !== acc.gfApps)  { reg.stats.gfApps  = acc.gfApps;  modified = true; } }
      else if (reg.stats.gfApps  !== undefined) { delete reg.stats.gfApps;  modified = true; }
      if (acc.gfWins > 0)  { if ((reg.stats.gfWins ?? 0) !== acc.gfWins)  { reg.stats.gfWins  = acc.gfWins;  modified = true; } }
      else if (reg.stats.gfWins  !== undefined) { delete reg.stats.gfWins;  modified = true; }
      // Per-season finals box totals (compact keys) — same write-every-sibling,
      // omit-when-zero semantics as the flags above.
      if ((acc.fgp || 0) > 0) {
        const nf = { gp: acc.fgp, bg: acc.bgp || 0, pts: acc.fpts || 0, tp: acc.f3pt || 0, f: acc.ff || 0,
                     w: acc.fw || 0, l: acc.fl || 0, d: acc.fd || 0, g: acc.gids || [] };
        const ex = reg.stats.fstats;
        const gSame = ex && Array.isArray(ex.g) && ex.g.length === nf.g.length && ex.g.every((x, i) => x === nf.g[i]);
        if (!ex || ex.gp !== nf.gp || ex.bg !== nf.bg || ex.pts !== nf.pts || ex.tp !== nf.tp || ex.f !== nf.f
            || ex.w !== nf.w || ex.l !== nf.l || ex.d !== nf.d || !gSame) {
          reg.stats.fstats = nf; modified = true;
        }
      } else if (reg.stats.fstats !== undefined) { delete reg.stats.fstats; modified = true; }
    }
  }

  if (!modified) { playersSkipped++; continue; }

  if (!DRY_RUN) writeJson(playerPath, player);
  playersUpdated++;
  sinceLastCommit++;

  if (sinceLastCommit >= PLAYER_COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      gitCommit(
        `build-finals-stats: ${playersUpdated} player files updated`,
        ['players/']
      );
    }
    sinceLastCommit = 0;
    console.log(`  ${playersUpdated} players updated...`);
  }
}

if (!DRY_RUN && sinceLastCommit > 0) {
  gitCommit(
    `build-finals-stats: complete — ${playersUpdated} player files updated`,
    ['players/']
  );
}

// Stage the legacy progress file's DELETION. The file is unlinked at startup (Phase 1),
// so existsSync() is already false here — the old `if (existsSync)` guard would never
// fire and the near-100MB blob would stay on main forever. `git add` on a deleted
// TRACKED path stages the deletion; gitCommit no-ops cleanly when nothing is staged.
if (!DRY_RUN) {
  gitCommit('build-finals-stats: remove committed progress file (110MB, exceeded GitHub limit)',
    ['scripts/.finals-progress.json']);
}

console.log('\n─── Summary ─────────────────────────────────────────────────────────');
console.log(`  Finals games found          : ${totalFinalsGames}`);
console.log(`  Grand Finals found          : ${totalGFGames}`);
console.log(`  Players with finals data    : ${finalsMap.size}`);
console.log(`  Player files updated        : ${playersUpdated}`);
console.log(`  Seasons played per game scan but absent from player.seasons[] : ${sidsNotInSeasons}`);
console.log(`  Finals appearances attributed to a team                       : ${attributedTid}`);
console.log(`  ...team UNDETERMINABLE (merged into every reg for the season)  : ${undeterminedTid}`);
if (invariantBreaks > 0) console.log(`  ⚠ finalsPerSeason invariant broken : ${invariantBreaks}`);
console.log(`  Player files skipped        : ${playersSkipped}`);
console.log(`  Mode                        : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
console.log('\nNext step: node scripts/build-leaderboards.js --force');
