// scripts/diagnose-win-loss.js
//
// Diagnoses why players are missing W/L/D records after build-win-loss.
// Samples players with no wins/losses/draws but with reasonable GP,
// then traces why their games produced no results.
//
// Usage:
//   node scripts/diagnose-win-loss.js
//   node scripts/diagnose-win-loss.js --sample 20   (default 10)

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const SAMPLE_SIZE = parseInt(process.argv.find(a => a.startsWith('--sample='))?.split('=')[1] || '10');
const MIN_GP      = 5; // only examine players with at least this many GP

const sportsIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'sports-index.json'), 'utf8'));
const allSids     = new Set(Object.keys(sportsIndex.seasons || {}));

// ── Categorise skipped games ──────────────────────────────────────────────────

const SKIP_REASONS = {
  NO_PLAYERS:   'no players in game (no p[], hp[], ap[])',
  NO_SCORE:     'scores missing (hs/as null)',
  FORFEIT:      'forfeit',
  NO_GAME_FILE: 'season game file missing from games/bv/',
  TID_MISMATCH: 'player tid not found in g.h or g.a',
  AMBIGUOUS:    'player has regs for both teams in this game',
  NO_REG:       'player has no reg for this season',
};

function resultForTeam(g, tid) {
  if (g.h !== tid && g.a !== tid) return null;
  if (g.hs == null || g.as == null) return 'NO_SCORE';
  if (g.forfeit) return 'FORFEIT';
  return 'OK';
}

// ── Pre-pass: build uuid → { sid → Set<tid> } ─────────────────────────────────

console.log('Pre-pass: building player→season→team map…');
const playerTids   = new Map();
const noWinLoss    = []; // candidates: has Basketball, GP >= MIN_GP, no wins/losses
const prefixes     = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();

for (const prefix of prefixes) {
  const dir = path.join(PLAYERS_DIR, prefix);
  for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
    const uuid = fname.replace('.json', '');
    let player;
    try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
    const bk = player.sports?.Basketball;
    if (!bk) continue;

    const sidMap = new Map();
    for (const season of (player.seasons || [])) {
      if (!allSids.has(season.sid)) continue;
      for (const reg of (season.regs || [])) {
        if (!reg.tid) continue;
        if (!sidMap.has(season.sid)) sidMap.set(season.sid, new Set());
        sidMap.get(season.sid).add(reg.tid);
      }
    }
    if (sidMap.size > 0) playerTids.set(uuid, sidMap);

    // Candidate: no W/L/D written but has enough GP
    if (!bk.wins && !bk.losses && !bk.draws && (bk.gp || 0) >= MIN_GP) {
      noWinLoss.push({ uuid, gp: bk.gp, seasons: player.seasons || [], fpath: path.join(dir, fname) });
    }
  }
}

console.log(`Pre-pass complete. ${noWinLoss.length} players with GP>=${MIN_GP} and no W/L/D.\n`);

// ── Sample and diagnose ───────────────────────────────────────────────────────

// Sort by GP descending — most likely to be a real gap
noWinLoss.sort((a, b) => b.gp - a.gp);
const sample = noWinLoss.slice(0, SAMPLE_SIZE);

// Aggregate skip reason counts across all games/all seasons
const globalReasonCounts = {};
for (const r of Object.keys(SKIP_REASONS)) globalReasonCounts[r] = 0;
let globalGamesChecked = 0;

for (const { uuid, gp, seasons } of sample) {
  console.log(`─── ${uuid}  GP=${gp} ─────────────────────────────────`);

  const reasonCounts = {};
  for (const r of Object.keys(SKIP_REASONS)) reasonCounts[r] = 0;
  let gamesChecked = 0;
  let gamesFound   = 0;

  for (const season of seasons) {
    const sid = season.sid;
    if (!allSids.has(sid)) continue;

    const gfPath = path.join(GAMES_DIR, `${sid}.json`);
    if (!fs.existsSync(gfPath)) {
      reasonCounts.NO_GAME_FILE++;
      globalReasonCounts.NO_GAME_FILE++;
      continue;
    }

    let gf;
    try { gf = JSON.parse(fs.readFileSync(gfPath, 'utf8')); } catch { continue; }
    const games = gf.games || {};

    const myTids = playerTids.get(uuid)?.get(sid);

    for (const g of Object.values(games)) {
      // Is this player in the game?
      const inP  = (g.p  || []).some(x => x.id === uuid);
      const inHp = (g.hp || []).some(x => x.profileID === uuid);
      const inAp = (g.ap || []).some(x => x.profileID === uuid);
      if (!inP && !inHp && !inAp) continue;

      gamesFound++;
      gamesChecked++;
      globalGamesChecked++;

      const hasHpAp = (g.hp?.length > 0) || (g.ap?.length > 0);

      if (hasHpAp) {
        // Player was in hp/ap — check score/forfeit
        const tid = inHp ? g.h : g.a;
        const r = resultForTeam(g, tid);
        if (r === 'NO_SCORE')  { reasonCounts.NO_SCORE++;  globalReasonCounts.NO_SCORE++;  }
        else if (r === 'FORFEIT') { reasonCounts.FORFEIT++; globalReasonCounts.FORFEIT++; }
        // else OK — should have been counted, something else wrong
      } else if (inP) {
        // g.p[] only
        if (!myTids) {
          reasonCounts.NO_REG++;
          globalReasonCounts.NO_REG++;
        } else {
          const inHome = myTids.has(g.h);
          const inAway = myTids.has(g.a);
          if (!inHome && !inAway) {
            reasonCounts.TID_MISMATCH++;
            globalReasonCounts.TID_MISMATCH++;
          } else if (inHome && inAway) {
            reasonCounts.AMBIGUOUS++;
            globalReasonCounts.AMBIGUOUS++;
          } else {
            // Should have been scoreable — check score
            const tid = inHome ? g.h : g.a;
            const r = resultForTeam(g, tid);
            if (r === 'NO_SCORE')  { reasonCounts.NO_SCORE++;  globalReasonCounts.NO_SCORE++;  }
            else if (r === 'FORFEIT') { reasonCounts.FORFEIT++; globalReasonCounts.FORFEIT++; }
            // else OK — should have been counted
          }
        }
      }
    }
  }

  console.log(`  Games found: ${gamesFound}`);
  for (const [r, count] of Object.entries(reasonCounts)) {
    if (count > 0) console.log(`  ${SKIP_REASONS[r]}: ${count}`);
  }
  console.log();
}

// ── Global summary ────────────────────────────────────────────────────────────

console.log('═'.repeat(60));
console.log(`GLOBAL SUMMARY — ${noWinLoss.length} players with no W/L/D (GP>=${MIN_GP})`);
console.log(`Games checked across sample of ${sample.length}: ${globalGamesChecked}`);
for (const [r, count] of Object.entries(globalReasonCounts)) {
  if (count > 0) console.log(`  ${SKIP_REASONS[r]}: ${count}`);
}
console.log('═'.repeat(60));
