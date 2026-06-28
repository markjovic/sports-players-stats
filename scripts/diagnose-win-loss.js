// scripts/diagnose-win-loss.js
//
// Diagnoses why players are missing W/L/D records after build-win-loss.
// For each sampled player, loads their actual season/reg data and game files
// to trace exactly why each game produced no W/L/D result.
//
// Usage:
//   node scripts/diagnose-win-loss.js
//   node scripts/diagnose-win-loss.js --sample=20

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const SAMPLE_SIZE = parseInt(process.argv.find(a => a.startsWith('--sample='))?.split('=')[1] || '10');
const MIN_GP      = 5;

const sportsIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'sports-index.json'), 'utf8'));
const allSids     = new Set(Object.keys(sportsIndex.seasons || {}));

// ── Pre-pass: collect candidates and build uuid→sid→tids map ─────────────────

console.log('Pre-pass: scanning player files…');
const candidates = [];
const playerTids = new Map(); // uuid → Map<sid, Set<tid>>
const prefixes   = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();

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

    if (!bk.wins && !bk.losses && !bk.draws && (bk.gp || 0) >= MIN_GP) {
      candidates.push({ uuid, gp: bk.gp, player });
    }
  }
}

candidates.sort((a, b) => b.gp - a.gp);
const sample = candidates.slice(0, SAMPLE_SIZE);
console.log(`Pre-pass complete. ${candidates.length} candidates with GP>=${MIN_GP} and no W/L/D.`);
console.log(`Diagnosing top ${sample.length} by GP…\n`);

// ── Game file cache ───────────────────────────────────────────────────────────

const gfCache = new Map();
function loadGameFile(sid) {
  if (gfCache.has(sid)) return gfCache.get(sid);
  const f = path.join(GAMES_DIR, `${sid}.json`);
  if (!fs.existsSync(f)) { gfCache.set(sid, null); return null; }
  try {
    const gf = JSON.parse(fs.readFileSync(f, 'utf8'));
    gfCache.set(sid, gf);
    return gf;
  } catch { gfCache.set(sid, null); return null; }
}

// ── Diagnose each player ──────────────────────────────────────────────────────

const globalCounts = {
  seasonsInIndex:    0,
  seasonsNotInIndex: 0,
  gameFileMissing:   0,
  gameFilePresent:   0,
  appearsInGame:     0,
  notInAnyGame:      0,
  // For games where player appears:
  resultOK:          0,
  noScore:           0,
  forfeit:           0,
  tidMismatch:       0,
  ambiguous:         0,
  noReg:             0,
};

for (const { uuid, gp, player } of sample) {
  console.log(`${'─'.repeat(60)}`);
  console.log(`UUID: ${uuid}  GP=${gp}`);

  const seasons = player.seasons || [];
  const myTids  = playerTids.get(uuid); // Map<sid, Set<tid>> — may be undefined

  for (const season of seasons) {
    const sid = season.sid;
    const regs = season.regs || [];
    const tidsInSeason = myTids?.get(sid);
    const inIndex = allSids.has(sid);

    if (!inIndex) {
      globalCounts.seasonsNotInIndex++;
      console.log(`  sid=${sid}  NOT IN sports-index — season unknown`);
      continue;
    }
    globalCounts.seasonsInIndex++;

    const gf = loadGameFile(sid);
    if (!gf) {
      globalCounts.gameFileMissing++;
      console.log(`  sid=${sid}  regs=[${regs.map(r=>r.tid).join(',')}]  NO GAME FILE`);
      continue;
    }
    globalCounts.gameFilePresent++;

    const games = Object.values(gf.games || {});
    const totalGamesInFile = games.length;

    // Check how many games this player appears in
    let appearsCount = 0;
    const skipReasons = { noScore: 0, forfeit: 0, tidMismatch: 0, ambiguous: 0, noReg: 0, ok: 0 };

    // Also sample a few raw games to show structure
    const rawSample = games.slice(0, 3);

    for (const g of games) {
      const inP  = (g.p  || []).some(x => x.id === uuid);
      const inHp = (g.hp || []).some(x => x.profileID === uuid);
      const inAp = (g.ap || []).some(x => x.profileID === uuid);
      if (!inP && !inHp && !inAp) continue;

      appearsCount++;
      globalCounts.appearsInGame++;

      const hasHpAp = (g.hp?.length > 0) || (g.ap?.length > 0);

      if (hasHpAp) {
        const tid = inHp ? g.h : inAp ? g.a : null;
        if (!tid) { skipReasons.noReg++; globalCounts.noReg++; continue; }
        if (g.hs == null || g.as == null) { skipReasons.noScore++; globalCounts.noScore++; continue; }
        if (g.forfeit) { skipReasons.forfeit++; globalCounts.forfeit++; continue; }
        skipReasons.ok++; globalCounts.resultOK++;
      } else if (inP) {
        if (!tidsInSeason) { skipReasons.noReg++; globalCounts.noReg++; continue; }
        const inHome = tidsInSeason.has(g.h);
        const inAway = tidsInSeason.has(g.a);
        if (!inHome && !inAway) { skipReasons.tidMismatch++; globalCounts.tidMismatch++; continue; }
        if (inHome && inAway)   { skipReasons.ambiguous++;   globalCounts.ambiguous++;   continue; }
        if (g.hs == null || g.as == null) { skipReasons.noScore++; globalCounts.noScore++; continue; }
        if (g.forfeit) { skipReasons.forfeit++; globalCounts.forfeit++; continue; }
        skipReasons.ok++; globalCounts.resultOK++;
      }
    }

    if (appearsCount === 0) globalCounts.notInAnyGame++;

    const tidList = tidsInSeason ? [...tidsInSeason].join(', ') : '(none in pre-pass)';
    console.log(`  sid=${sid}  tids=[${tidList}]  gameFile=YES (${totalGamesInFile} games)  appearsIn=${appearsCount}`);
    if (appearsCount > 0) {
      const parts = [];
      if (skipReasons.ok)          parts.push(`ok=${skipReasons.ok}`);
      if (skipReasons.noScore)     parts.push(`noScore=${skipReasons.noScore}`);
      if (skipReasons.forfeit)     parts.push(`forfeit=${skipReasons.forfeit}`);
      if (skipReasons.tidMismatch) parts.push(`tidMismatch=${skipReasons.tidMismatch}`);
      if (skipReasons.ambiguous)   parts.push(`ambiguous=${skipReasons.ambiguous}`);
      if (skipReasons.noReg)       parts.push(`noReg=${skipReasons.noReg}`);
      console.log(`    breakdown: ${parts.join(', ')}`);
    } else {
      // Player doesn't appear in any game in the file — show sample game structure
      const g0 = rawSample[0];
      if (g0) {
        const pCount  = (g0.p  || []).length;
        const hpCount = (g0.hp || []).length;
        const apCount = (g0.ap || []).length;
        console.log(`    sample game: h=${g0.h} a=${g0.a} hs=${g0.hs} as=${g0.as} p[]=${pCount} hp[]=${hpCount} ap[]=${apCount} forfeit=${!!g0.forfeit}`);
        // Check if any of the player's tids appear as h/a across all games
        if (tidsInSeason) {
          const tidMatchCount = games.filter(g => tidsInSeason.has(g.h) || tidsInSeason.has(g.a)).length;
          console.log(`    games where player's tid is h or a: ${tidMatchCount}/${totalGamesInFile}`);
        }
      }
    }
  }
  console.log();
}

// ── Global summary ────────────────────────────────────────────────────────────

console.log('═'.repeat(60));
console.log(`GLOBAL SUMMARY — sample of ${sample.length} players`);
console.log(`  Seasons in sports-index:     ${globalCounts.seasonsInIndex}`);
console.log(`  Seasons NOT in sports-index: ${globalCounts.seasonsNotInIndex}`);
console.log(`  Seasons with game file:      ${globalCounts.gameFilePresent}`);
console.log(`  Seasons with NO game file:   ${globalCounts.gameFileMissing}`);
console.log(`  Seasons where player in ≥1 game: ${globalCounts.appearsInGame > 0 ? '(see per-player)' : 'n/a'}`);
console.log(`  Games where player appears:  ${globalCounts.appearsInGame}`);
console.log(`    → result OK (should have W/L/D): ${globalCounts.resultOK}`);
console.log(`    → no score:                      ${globalCounts.noScore}`);
console.log(`    → forfeit:                       ${globalCounts.forfeit}`);
console.log(`    → tid mismatch:                  ${globalCounts.tidMismatch}`);
console.log(`    → ambiguous (both tids match):   ${globalCounts.ambiguous}`);
console.log(`    → no reg for game:               ${globalCounts.noReg}`);
console.log('═'.repeat(60));
