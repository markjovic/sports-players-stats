// scripts/build-win-loss.js
//
// Computes career and per-reg W/L/D records for all players from game files.
// Writes to player.sports.Basketball: { wins, losses, draws, winPct }
// and per reg: reg.stats.{ wins, losses, draws }
//
// No API calls — pure game file computation.
// Run as a nightly downstream job, or one-time via build-win-loss.yml.
//
// Usage:
//   node scripts/build-win-loss.js              -- all players
//   node scripts/build-win-loss.js --active-only -- active seasons only

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT         = path.join(__dirname, '..');
const PLAYERS_DIR  = path.join(ROOT, 'players');
const GAMES_DIR    = path.join(ROOT, 'games', 'bv');
const ACTIVE_ONLY  = process.argv.includes('--active-only');
const COMMIT_EVERY = 5000;

// ─── Load sports-index for active season IDs ──────────────────────────────────

const sportsIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'sports-index.json'), 'utf8'));
const activeSids  = new Set(
  Object.values(sportsIndex.seasons || {})
    .filter(s => !s.locked)
    .map(s => s.id)
);

// ─── Game file cache ──────────────────────────────────────────────────────────

const gameCache = {}; // sid → { gameId: game }

function loadGames(sid) {
  if (gameCache[sid]) return gameCache[sid];
  const f = path.join(GAMES_DIR, `${sid}.json`);
  if (!fs.existsSync(f)) { gameCache[sid] = {}; return {}; }
  try {
    const gf = JSON.parse(fs.readFileSync(f, 'utf8'));
    gameCache[sid] = gf.games || {};
  } catch { gameCache[sid] = {}; }
  return gameCache[sid];
}

// ─── W/L/D from game ─────────────────────────────────────────────────────────

function resultForTeam(g, tid) {
  // Returns 'W', 'L', 'D', or null (no score)
  let myS, oppS;
  if (g.h === tid) { myS = g.hs; oppS = g.as; }
  else if (g.a === tid) { myS = g.as; oppS = g.hs; }
  else return null;
  if (myS == null || oppS == null) return null;
  if (g.forfeit) return null; // forfeits don't count as W/L
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
  console.log(`  Active seasons: ${activeSids.size}`);

  const prefixes = fs.readdirSync(PLAYERS_DIR)
    .filter(d => /^[0-9a-f]{2}$/.test(d)).sort();

  let processed = 0, updated = 0, sinceCommit = 0;

  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS_DIR, prefix);
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      processed++;
      const fpath = path.join(dir, fname);
      let player;
      try { player = JSON.parse(fs.readFileSync(fpath, 'utf8')); } catch { continue; }

      const bk = player.sports?.Basketball;
      if (!bk) continue;

      let careerW = 0, careerL = 0, careerD = 0;
      let modified = false;

      for (const season of (player.seasons || [])) {
        const sid = season.sid;
        if (ACTIVE_ONLY && !activeSids.has(sid)) continue;

        const games = loadGames(sid);

        for (const reg of (season.regs || [])) {
          const tid = reg.tid;
          if (!tid) continue;

          let regW = 0, regL = 0, regD = 0;

          // Find all games for this player in this season/team
          for (const [, g] of Object.entries(games)) {
            // Check player was in this game
            const inGame = (g.p || []).some(p => (p.id || p) === player.uuid) ||
                           (g.hp || []).some(p => p.profileID === player.uuid) ||
                           (g.ap || []).some(p => p.profileID === player.uuid);
            if (!inGame) continue;
            if (g.h !== tid && g.a !== tid) continue;

            const res = resultForTeam(g, tid);
            if (res === 'W') { regW++; careerW++; }
            else if (res === 'L') { regL++; careerL++; }
            else if (res === 'D') { regD++; careerD++; }
          }

          if (!reg.stats) reg.stats = {};
          const prev = `${reg.stats.wins}:${reg.stats.losses}:${reg.stats.draws}`;
          const next = `${regW||undefined}:${regL||undefined}:${regD||undefined}`;
          if (prev !== next) {
            if (regW) reg.stats.wins = regW; else delete reg.stats.wins;
            if (regL) reg.stats.losses = regL; else delete reg.stats.losses;
            if (regD) reg.stats.draws = regD; else delete reg.stats.draws;
            modified = true;
          }
        }
      }

      // Career totals
      const winPct = (careerW + careerL + careerD) > 0
        ? Math.round((careerW / (careerW + careerL + careerD)) * 100) / 100
        : null;

      if (bk.wins !== (careerW || undefined) || bk.losses !== (careerL || undefined) ||
          bk.draws !== (careerD || undefined) || bk.winPct !== (winPct ?? undefined)) {
        if (careerW) bk.wins = careerW; else delete bk.wins;
        if (careerL) bk.losses = careerL; else delete bk.losses;
        if (careerD) bk.draws = careerD; else delete bk.draws;
        if (winPct !== null) bk.winPct = winPct; else delete bk.winPct;
        modified = true;
      }

      if (modified) {
        fs.writeFileSync(fpath, JSON.stringify(player), 'utf8');
        updated++;
        sinceCommit++;
      }

      if (sinceCommit >= COMMIT_EVERY) {
        gitCommit(`build-win-loss: ${updated} players updated`);
        sinceCommit = 0;
        console.log(`  Progress: ${processed} scanned, ${updated} updated`);
      }
    }
  }

  if (sinceCommit > 0) {
    gitCommit(`build-win-loss: complete — ${updated} players updated`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`  Scanned:  ${processed}`);
  console.log(`  Updated:  ${updated}`);
  console.log('─'.repeat(60));
}

main();
