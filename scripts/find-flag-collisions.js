// scripts/find-flag-collisions.js
//
// READ-ONLY diagnostic. Writes nothing, commits nothing, makes no network calls.
//
// Part 1 — FLAG COLLISIONS: games where legacy:true is set alongside another
// flag (hidden, profileOnly, forfeit, bye, cancelled, abandoned).
//
// Part 2 — LEGACY POPULATION: a tally of every game carrying legacy:true,
// bucketed by year. legacy means "pre-history game, no further data obtainable"
// and BV migrated to PlayHQ ~2020, so a legacy game dated 2022+ is suspect on
// its face. This shows whether the collisions are the whole problem or the
// visible tip of a wider mis-stamping.
//
// 2026-07-31 — extended from the original 31-line version. The original printed
// flags/date/round/status/teams only, which was enough to establish that all 49
// collisions are the SAME pair (legacy + forfeit) but could not answer the three
// questions that follow from that:
//
//   1. Are these games in data/forfeit-games.json? fetch-profile-stats.js and
//      build-leaderboards.js both read it to EXCLUDE forfeits from stats. A
//      forfeit missing from that index is counting toward player totals and
//      leaderboards. -> inForfeitIndex
//   2. Is `fo` (winning team id) set, and does it point at one of THIS game's
//      teams? forfeit:true without a usable `fo` is an incomplete record, and
//      StatTrack's Mode 5 renders "X won by forfeit" from it. -> fo / foPointsAt
//   3. Could this game legitimately be legacy at all? The three-step probe only
//      reaches legacy when discoverGame AND spectator game(id) AND the profile
//      lookup ALL return nothing. spc:1 means the spectator box score WAS
//      fetched, i.e. step 2 returned data — so legacy was unreachable on that
//      pass and the two flags were written by different passes. Player rows and
//      scores are weaker evidence of the same thing. -> spc / scores / p,hp,ap
//
// Usage: node scripts/find-flag-collisions.js

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT           = path.join(__dirname, '..');
const GAMES_DIR      = path.join(ROOT, 'games', 'bv');
// data/ prefix: all root JSON lives under data/ (README "CRITICAL" note).
const FORFEIT_INDEX  = path.join(ROOT, 'data', 'forfeit-games.json');

const COLLIDING_FLAGS = ['hidden', 'profileOnly', 'forfeit', 'bye', 'cancelled', 'abandoned'];

// ─── forfeit index ────────────────────────────────────────────────────────────
// Sorted array of forfeit game ids. Loaded once into a Set. A missing or
// unreadable index is itself a finding, so it is reported loudly rather than
// silently treated as "nothing is a forfeit" — every membership test would
// otherwise come back false and manufacture 49 fake defects.
let forfeitIndex = new Set();
let forfeitIndexOk = false;
try {
  const raw = JSON.parse(fs.readFileSync(FORFEIT_INDEX, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw.games) ? raw.games : null);
  if (!arr) throw new Error('unexpected shape — expected an array of game ids');
  forfeitIndex = new Set(arr);
  forfeitIndexOk = true;
  console.log(`forfeit index: ${forfeitIndex.size} game ids loaded from data/forfeit-games.json`);
} catch (e) {
  console.log(`⚠️  forfeit index NOT LOADED (${e.message}). inForfeitIndex results below are MEANINGLESS — fix this before reading them.`);
}

// Never `new Date()` for date parsing — split YYYY-MM-DD (house rule).
function yearOf(d) {
  if (typeof d !== 'string') return 'no-date';
  const parts = d.split('-');
  if (parts.length < 3 || !/^\d{4}$/.test(parts[0])) return 'no-date';
  return parts[0];
}

function count(v) { return Array.isArray(v) ? v.length : 0; }

// Which of this game's own teams does `fo` name? Normal games carry h/a,
// hidden games carry t1/t2 — check both rather than assuming the shape.
function foPointsAt(g) {
  if (g.fo === undefined || g.fo === null || g.fo === '') return 'ABSENT';
  if (g.fo === g.h || g.fo === g.t1) return 'home';
  if (g.fo === g.a || g.fo === g.t2) return 'away';
  return 'NEITHER-TEAM';
}

// ─── single pass ──────────────────────────────────────────────────────────────
let found = 0;
let gamesScanned = 0, seasonsScanned = 0, unreadable = 0;

const legacyByYear = new Map();
let legacyTotal = 0;

// collision aggregates
const agg = {
  notInForfeitIndex: 0,
  foAbsent: 0,
  foNeitherTeam: 0,
  withSpc: 0,
  withPlayerRows: 0,
  withScores: 0,
};

for (const fname of fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort()) {
  let gf;
  try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); }
  catch { unreadable++; continue; }
  seasonsScanned++;

  for (const [gameId, g] of Object.entries(gf.games || {})) {
    gamesScanned++;

    // Part 2 — every legacy game, collision or not.
    if (g.legacy) {
      legacyTotal++;
      const y = yearOf(g.d);
      legacyByYear.set(y, (legacyByYear.get(y) || 0) + 1);
    }

    // Part 1 — collisions only.
    if (!g.legacy) continue;
    const others = COLLIDING_FLAGS.filter(f => g[f]);
    if (!others.length) continue;
    found++;

    const inIdx     = forfeitIndex.has(gameId);
    const foWhere   = foPointsAt(g);
    const nP        = count(g.p), nHp = count(g.hp), nAp = count(g.ap);
    const hasScores = typeof g.hs === 'number' || typeof g.as === 'number';

    if (!inIdx)                    agg.notInForfeitIndex++;
    if (foWhere === 'ABSENT')      agg.foAbsent++;
    if (foWhere === 'NEITHER-TEAM') agg.foNeitherTeam++;
    if (g.spc)                     agg.withSpc++;
    if (nP + nHp + nAp > 0)        agg.withPlayerRows++;
    if (hasScores)                 agg.withScores++;

    // Original four lines kept verbatim in shape; new evidence appended below
    // them so the output still reads the way it always has.
    console.log(`\n  gameId: ${gameId}  season: ${fname.replace('.json','')}`);
    console.log(`  flags:  legacy=true  ${others.map(f => `${f}=true`).join('  ')}`);
    console.log(`  date=${g.d}  rn=${g.rn}  st=${g.st}`);
    console.log(`  home=${g.hn||g.t1n||'?'}  away=${g.an||g.t2n||'?'}`);
    console.log(`  inForfeitIndex=${inIdx}  fo=${g.fo ?? '(absent)'} -> ${foWhere}`);
    console.log(`  spc=${g.spc ?? '(absent)'}  scores=${hasScores ? `${g.hs ?? '?'}-${g.as ?? '?'}` : '(none)'}  p=${nP} hp=${nHp} ap=${nAp}`);
  }
}

// ─── verdicts ─────────────────────────────────────────────────────────────────
const lines = [];
lines.push('');
lines.push(`Scanned ${gamesScanned} games across ${seasonsScanned} season files${unreadable ? ` (${unreadable} unreadable)` : ''}.`);
lines.push('');
lines.push(`Total flag collisions: ${found}`);
if (found) {
  lines.push('');
  lines.push('COLLISION VERDICTS');
  lines.push(`  missing from data/forfeit-games.json : ${agg.notInForfeitIndex} of ${found}${forfeitIndexOk ? '' : '   ⚠️ INDEX NOT LOADED — this number is meaningless'}`);
  lines.push(`  fo absent                            : ${agg.foAbsent} of ${found}`);
  lines.push(`  fo naming neither of its own teams   : ${agg.foNeitherTeam} of ${found}`);
  lines.push(`  carrying spc:1 (spectator data WAS fetched — legacy was unreachable on that pass) : ${agg.withSpc} of ${found}`);
  lines.push(`  carrying player rows (p/hp/ap)       : ${agg.withPlayerRows} of ${found}`);
  lines.push(`  carrying a score                     : ${agg.withScores} of ${found}`);
}

lines.push('');
lines.push('LEGACY POPULATION (all games carrying legacy:true, collision or not)');
lines.push(`  total: ${legacyTotal}`);
const years = [...legacyByYear.keys()].sort();
let post2021 = 0;
for (const y of years) {
  const n = legacyByYear.get(y);
  if (/^\d{4}$/.test(y) && Number(y) >= 2022) post2021 += n;
  lines.push(`    ${y.padEnd(8)} ${n}`);
}
lines.push(`  dated 2022 or later: ${post2021} of ${legacyTotal}`);
lines.push('  (legacy means "pre-history, nothing further obtainable"; BV migrated to PlayHQ ~2020,');
lines.push('   so a recent-dated legacy game is suspect on its face.)');

const out = lines.join('\n');
console.log(out);

// Same step-summary pattern as fold-diverged-players.js, so the verdicts are
// visible on the run page without opening the log.
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + out + '\n```\n');
  } catch (_) { /* summary is a convenience, never fatal */ }
}
