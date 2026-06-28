// scripts/build-win-loss.js
//
// Computes career and per-reg W/L/D records for all players from game files.
// Writes to player.sports.Basketball: { wins, losses, draws, winPct }
// and per reg: reg.stats.{ wins, losses, draws }
//
// No API calls — pure game file computation.
//
// Strategy:
//   Pre-pass — scan all player files to build uuid → { sid → Set<tid> } map.
//              Required to classify g.p[] entries (no side info) by matching
//              the player's known tid for that season against g.h / g.a.
//   Pass 1   — iterate season game files one at a time; accumulate W/L/D per
//              player using hp/ap when present, g.p[] + pre-pass map otherwise.
//   Pass 2   — write accumulated records back to player files.
//
// Usage:
//   node scripts/build-win-loss.js              -- all seasons
//   node scripts/build-win-loss.js --active-only -- active seasons only

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const ACTIVE_ONLY = process.argv.includes('--active-only');
const COMMIT_EVERY = 5000;

// ─── Sports-index ─────────────────────────────────────────────────────────────

const sportsIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'sports-index.json'), 'utf8'));
const allSids     = Object.keys(sportsIndex.seasons || {});
const activeSids  = new Set(Object.values(sportsIndex.seasons || {}).filter(s => !s.locked).map(s => s.id));
const targetSids  = new Set(ACTIVE_ONLY ? [...activeSids] : allSids);

// ─── W/L/D from game ─────────────────────────────────────────────────────────

function resultForTeam(g, tid) {
  let myS, oppS;
  if      (g.h === tid) { myS = g.hs; oppS = g.as; }
  else if (g.a === tid) { myS = g.as; oppS = g.hs; }
  else return null;
  if (myS == null || oppS == null) return null;
  if (g.forfeit) return null;
  if (myS > oppS) return 'W';
  if (myS < oppS) return 'L';
  return 'D';
}

// ─── Git ──────────────────────────────────────────────────────────────────────

function gitCommit(msg) {
  try {
    execSync('git add players/', { stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
    const staged = execSync('git diff --staged --shortstat',
      { stdio: 'pipe', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).toString().trim();
    if (!staged) { console.log('  Nothing to commit.'); return; }
    execSync('git fetch origin main',                  { stdio: 'pipe', cwd: ROOT });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
    execSync(`git commit -m "${msg}"`,                 { stdio: 'pipe', cwd: ROOT });
    execSync('git push origin main',                   { stdio: 'pipe', cwd: ROOT });
    console.log(`  ✓ ${msg}`);
  } catch (e) {
    console.error('  git error:', e.stderr?.toString().slice(0, 200) || e.message.slice(0, 200));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log(`\nbuild-win-loss.js${ACTIVE_ONLY ? ' [active-only]' : ''}`);
  console.log('─'.repeat(60));
  console.log(`  Target seasons: ${targetSids.size}`);

  // Pre-pass: build uuid → { sid → Set<tid> } from player files.
  // Used to classify g.p[] entries (which carry no side info) by checking
  // whether the player's known tid for that season is the home or away team.
  console.log('\n  Pre-pass: building player→season→team map…');
  const playerTids = new Map(); // uuid → Map<sid, Set<tid>>
  const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  let prePassCount = 0;

  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS_DIR, prefix);
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
      const uuid = fname.replace('.json', '');
      let player;
      try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
      if (!player.sports?.Basketball) continue;

      const sidMap = new Map();
      for (const season of (player.seasons || [])) {
        if (!targetSids.has(season.sid)) continue;
        for (const reg of (season.regs || [])) {
          if (!reg.tid) continue;
          if (!sidMap.has(season.sid)) sidMap.set(season.sid, new Set());
          sidMap.get(season.sid).add(reg.tid);
        }
      }
      if (sidMap.size > 0) {
        // Also attach gameTids map if present — used to resolve ambiguous games
        sidMap.gameTids = player.gameTids || null;
        playerTids.set(uuid, sidMap);
      }
      prePassCount++;
      if (prePassCount % 50000 === 0)
        process.stdout.write(`  Pre-pass: ${prePassCount} players scanned…\r`);
    }
  }
  console.log(`  Pre-pass complete: ${prePassCount} players scanned, ${playerTids.size} with target-season regs`);

  // Pass 1: scan all target season game files one at a time.
  // Accumulate per-player, per-season, per-team W/L/D.
  // Structure: records[uuid][sid][tid] = {w, l, d}
  console.log('\n  Pass 1: scanning game files…');
  const records = {}; // uuid → { [sid]: { [tid]: {w,l,d} } }
  let gamesScanned = 0, seasonsScanned = 0;
  let hpApGames = 0, pFallbackGames = 0, skippedGames = 0;

  function accumulate(uuid, sid, tid, res) {
    if (!records[uuid])           records[uuid] = {};
    if (!records[uuid][sid])      records[uuid][sid] = {};
    if (!records[uuid][sid][tid]) records[uuid][sid][tid] = { w: 0, l: 0, d: 0 };
    const r = records[uuid][sid][tid];
    if (res === 'W') r.w++;
    else if (res === 'L') r.l++;
    else r.d++;
  }

  for (const sid of targetSids) {
    const f = path.join(GAMES_DIR, `${sid}.json`);
    if (!fs.existsSync(f)) continue;
    let gf;
    try { gf = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const games = gf.games || {};
    seasonsScanned++;

    for (const g of Object.values(games)) {
      gamesScanned++;
      const hasHpAp = (g.hp && g.hp.length > 0) || (g.ap && g.ap.length > 0);

      if (hasHpAp) {
        // hp/ap present — reliable side info
        hpApGames++;
        for (const { players, tid } of [{ players: g.hp || [], tid: g.h }, { players: g.ap || [], tid: g.a }]) {
          if (!tid || !players.length) continue;
          const res = resultForTeam(g, tid);
          if (!res) continue;
          for (const p of players) {
            if (p.profileID) accumulate(p.profileID, sid, tid, res);
          }
        }
      } else if (g.p && g.p.length > 0) {
        // Only g.p[] available — determine each player's side from pre-pass map.
        // A player's tid must match either g.h or g.a for this game.
        let usedFallback = false;
        for (const p of g.p) {
          const uuid = p.id;
          if (!uuid) continue;
          const sidMap = playerTids.get(uuid);
          if (!sidMap) continue;
          const tids = sidMap.get(sid);
          if (!tids) continue;
          // Find which of this player's tids for this season is in this game.
          const inHome = tids.has(g.h);
          const inAway = tids.has(g.a);
          if (!inHome && !inAway) continue;
          let matchedTid;
          if (inHome && inAway) {
            // Ambiguous — player has regs for both teams. Check gameTids map
            // written by fetch-profile-stats.js from the API response.
            // gameKey in gameTids is the game UUID stored in g.id.
            const gameId = g.id || null;
            const sidMap2 = playerTids.get(uuid);
            const resolved = gameId && sidMap2?.gameTids ? (sidMap2.gameTids[gameId] || null) : null;
            if (!resolved) continue; // truly unresolvable
            matchedTid = resolved;
          } else {
            matchedTid = inHome ? g.h : g.a;
          }
          const res = resultForTeam(g, matchedTid);
          if (!res) continue;
          accumulate(uuid, sid, matchedTid, res);
          usedFallback = true;
        }
        if (usedFallback) pFallbackGames++;
        else skippedGames++;
      } else {
        skippedGames++;
      }
    }

    if (seasonsScanned % 100 === 0)
      process.stdout.write(`  Scanned ${seasonsScanned}/${targetSids.size} seasons (${Object.keys(records).length} players seen)\r`);
  }

  console.log(`\n  Scanned ${seasonsScanned} seasons, ${gamesScanned} games`);
  console.log(`    hp/ap games: ${hpApGames}, g.p[] fallback: ${pFallbackGames}, skipped (no score/players): ${skippedGames}`);
  console.log(`  ${Object.keys(records).length} players with W/L/D data`);
  console.log('\n  Pass 2: writing player files…');

  // Pass 2: write W/L/D to player files
  let updated = 0, skipped = 0, sinceCommit = 0;

  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS_DIR, prefix);
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
      const uuid = fname.replace('.json', '');
      const playerRecords = records[uuid];

      const fpath = path.join(dir, fname);
      let player;
      try { player = JSON.parse(fs.readFileSync(fpath, 'utf8')); } catch { continue; }

      const bk = player.sports?.Basketball;
      if (!bk) { skipped++; continue; }

      let modified = false;

      if (ACTIVE_ONLY) {
        // Delta mode: start from existing career totals, apply changes from active-season regs only.
        // Locked seasons are untouched — their contribution to career totals is already baked in.
        let careerW = bk.wins || 0;
        let careerL = bk.losses || 0;
        let careerD = bk.draws || 0;

        for (const season of (player.seasons || [])) {
          if (!activeSids.has(season.sid)) continue;
          for (const reg of (season.regs || [])) {
            const rec = playerRecords?.[season.sid]?.[reg.tid] || { w: 0, l: 0, d: 0 };
            const oldW = reg.stats?.wins  || 0;
            const oldL = reg.stats?.losses || 0;
            const oldD = reg.stats?.draws  || 0;
            // Apply delta to career totals
            careerW += rec.w - oldW;
            careerL += rec.l - oldL;
            careerD += rec.d - oldD;
            // Clamp to zero (should never go negative, but guard against stale data)
            careerW = Math.max(0, careerW);
            careerL = Math.max(0, careerL);
            careerD = Math.max(0, careerD);
            // Update per-reg stats
            if (!reg.stats) reg.stats = {};
            if (oldW !== rec.w || oldL !== rec.l || oldD !== rec.d) {
              if (rec.w) reg.stats.wins = rec.w; else delete reg.stats.wins;
              if (rec.l) reg.stats.losses = rec.l; else delete reg.stats.losses;
              if (rec.d) reg.stats.draws = rec.d; else delete reg.stats.draws;
              modified = true;
            }
          }
        }

        // Write updated career totals
        const winPct = (careerW + careerL + careerD) > 0
          ? Math.round((careerW / (careerW + careerL + careerD)) * 100) / 100
          : null;
        if ((bk.wins || 0) !== careerW || (bk.losses || 0) !== careerL ||
            (bk.draws || 0) !== careerD || (bk.winPct ?? null) !== winPct) {
          if (careerW) bk.wins = careerW; else delete bk.wins;
          if (careerL) bk.losses = careerL; else delete bk.losses;
          if (careerD) bk.draws = careerD; else delete bk.draws;
          if (winPct !== null) bk.winPct = winPct; else delete bk.winPct;
          modified = true;
        }

      } else {
        // Full mode: recompute career totals from scratch across all seasons.
        let careerW = 0, careerL = 0, careerD = 0;

        for (const season of (player.seasons || [])) {
          for (const reg of (season.regs || [])) {
            const rec = playerRecords?.[season.sid]?.[reg.tid] || { w: 0, l: 0, d: 0 };
            careerW += rec.w;
            careerL += rec.l;
            careerD += rec.d;
            if (!reg.stats) reg.stats = {};
            if ((reg.stats.wins || 0) !== rec.w || (reg.stats.losses || 0) !== rec.l || (reg.stats.draws || 0) !== rec.d) {
              if (rec.w) reg.stats.wins = rec.w; else delete reg.stats.wins;
              if (rec.l) reg.stats.losses = rec.l; else delete reg.stats.losses;
              if (rec.d) reg.stats.draws = rec.d; else delete reg.stats.draws;
              modified = true;
            }
          }
        }

        const winPct = (careerW + careerL + careerD) > 0
          ? Math.round((careerW / (careerW + careerL + careerD)) * 100) / 100
          : null;
        if ((bk.wins || 0) !== careerW || (bk.losses || 0) !== careerL ||
            (bk.draws || 0) !== careerD || (bk.winPct ?? null) !== winPct) {
          if (careerW) bk.wins = careerW; else delete bk.wins;
          if (careerL) bk.losses = careerL; else delete bk.losses;
          if (careerD) bk.draws = careerD; else delete bk.draws;
          if (winPct !== null) bk.winPct = winPct; else delete bk.winPct;
          modified = true;
        }
      }

      if (modified) {
        fs.writeFileSync(fpath, JSON.stringify(player), 'utf8');
        updated++;
        sinceCommit++;
        if (sinceCommit >= COMMIT_EVERY) {
          gitCommit(`build-win-loss: ${updated} players updated`);
          sinceCommit = 0;
          console.log(`  Progress: ${updated} updated so far`);
        }
      } else {
        skipped++;
      }
    }
  }

  if (sinceCommit > 0) gitCommit(`build-win-loss: complete — ${updated} players updated`);

  console.log('\n' + '─'.repeat(60));
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log('─'.repeat(60));
}

main();
