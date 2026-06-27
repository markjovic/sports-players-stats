// scripts/build-win-loss.js
//
// Computes career and per-reg W/L/D records for all players from game files.
// Writes to player.sports.Basketball: { wins, losses, draws, winPct }
// and per reg: reg.stats.{ wins, losses, draws }
//
// No API calls — pure game file computation.
//
// Strategy: iterate season by season (one game file in memory at a time).
// Build a UUID→{seasonId→{tid→{w,l,d}}} accumulator, then write player files.
// This keeps memory constant regardless of how many seasons exist.
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
const targetSids  = ACTIVE_ONLY ? [...activeSids] : allSids;

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
  console.log(`  Target seasons: ${targetSids.length}`);

  // Pass 1: scan all target season game files one at a time.
  // Accumulate per-player, per-season, per-team W/L/D.
  // Structure: records[uuid][sid][tid] = {w, l, d}
  const records = {}; // uuid → { [sid]: { [tid]: {w,l,d} } }
  let gamesScanned = 0, seasonsScanned = 0;

  for (const sid of targetSids) {
    const f = path.join(GAMES_DIR, `${sid}.json`);
    if (!fs.existsSync(f)) continue;
    let gf;
    try { gf = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const games = gf.games || {};
    seasonsScanned++;

    for (const g of Object.values(games)) {
      gamesScanned++;
      // Each game has hp/ap arrays — use them to identify participating players and their side
      const sides = [
        { players: g.hp || [], tid: g.h },
        { players: g.ap || [], tid: g.a },
      ];
      // Also handle p[] when hp/ap absent — players keyed only by id with no side
      // In that case we use h/a team IDs with g.p entries but can't distinguish sides —
      // skip for games without hp/ap since we can't determine which team each player was on
      for (const { players, tid } of sides) {
        if (!tid || !players.length) continue;
        const res = resultForTeam(g, tid);
        if (!res) continue; // no score or forfeit
        for (const p of players) {
          const uuid = p.profileID;
          if (!uuid) continue;
          if (!records[uuid])       records[uuid] = {};
          if (!records[uuid][sid])  records[uuid][sid] = {};
          if (!records[uuid][sid][tid]) records[uuid][sid][tid] = { w: 0, l: 0, d: 0 };
          const r = records[uuid][sid][tid];
          if (res === 'W') r.w++;
          else if (res === 'L') r.l++;
          else r.d++;
        }
      }
    }

    if (seasonsScanned % 100 === 0)
      process.stdout.write(`  Scanned ${seasonsScanned}/${targetSids.length} seasons (${Object.keys(records).length} players seen)\r`);
  }

  console.log(`\n  Scanned ${seasonsScanned} seasons, ${gamesScanned} games, ${Object.keys(records).length} players with W/L/D data`);
  console.log('  Writing player files…');

  // Pass 2: write W/L/D to player files
  const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  let updated = 0, skipped = 0, sinceCommit = 0;

  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS_DIR, prefix);
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const uuid = fname.replace('.json', '');
      const playerRecords = records[uuid];

      const fpath = path.join(dir, fname);
      let player;
      try { player = JSON.parse(fs.readFileSync(fpath, 'utf8')); } catch { continue; }

      const bk = player.sports?.Basketball;
      if (!bk) { skipped++; continue; }

      let careerW = 0, careerL = 0, careerD = 0;
      let modified = false;

      for (const season of (player.seasons || [])) {
        const sid = season.sid;
        if (ACTIVE_ONLY && !activeSids.has(sid)) continue;

        for (const reg of (season.regs || [])) {
          const tid = reg.tid;
          const rec = playerRecords?.[sid]?.[tid] || { w: 0, l: 0, d: 0 };
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
