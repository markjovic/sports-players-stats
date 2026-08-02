// scripts/find-flag-collisions.js
//
// READ-ONLY diagnostic. Writes nothing, commits nothing, makes no network calls.
//
// Part 1 — FLAG COLLISIONS: games where legacy:true is set alongside another
//          flag (hidden, profileOnly, forfeit, bye, cancelled, abandoned).
// Part 2 — LEGACY POPULATION BY YEAR.
// Part 3 — LEGACY POPULATION PROFILE: what those games actually contain.
// Part 4 — SURVIVOR SPLIT (2026-08-02): of the games still carrying legacy after
//          the 2026-08-01 repair, how many sit in ACTIVE seasons vs LOCKED ones,
//          plus a month histogram for 2026.
//
// ── Why Part 3 exists (2026-07-31) ───────────────────────────────────────────
// Part 1 found 49 collisions, ALL of them legacy+forfeit, and the extended
// fields settled them: 0 missing from the forfeit index, 47/49 with a valid
// `fo`, 0 with spc:1, and 49/49 CARRYING A SCORE.
//
// That last one is the contradiction. hs/as come from step 1 (discoverGame). If
// step 1 returns a FORFEIT outcome with statistics the classification probe
// STOPS — legacy is only reachable when steps 1, 2 and 3 ALL return null. So a
// legacy game holding step-1 scores was stamped legacy by an EARLIER pass that
// genuinely got nothing, and a LATER pass added forfeit/fo/scores without
// clearing the stale flag.
//
// Part 2 then showed the 49 are not the story: 3,262 games carry legacy, 2,938
// of them dated 2022 or later, peaking at 955 in 2026 — and ZERO dated 2020 or
// earlier. legacy means "pre-history, nothing further obtainable" and BV moved
// to PlayHQ ~2020, so the flag has never once been used for its stated purpose.
//
// The 49 were only VISIBLE because a second flag happened to land beside them.
// Part 3 sizes the invisible population: legacy games that demonstrably reached
// step 1 (they hold a score) but carry no second flag to give them away. If that
// count is large, the 49 are a symptom of something with a 3,000-row blast
// radius and repairing them alone would be fixing N-1.
//
// ── Why Part 4 exists (OUTSTANDING_TASKS §2.5) ───────────────────────────────
// The 2026-08-01 repair cleared 3,114 legacy flags from scored games and KEPT
// 142 scoreless ones, where "nothing further obtainable" is still unfalsified.
// Those 142 are not one population, and which one a game is in decides whether
// §2.1 needs a rebuilt classifier at all:
//
//   ACTIVE season -> nightly fixture passes still reach it. It will fill in a
//                    score and then trip the new `legacy + score` invariant.
//                    TEMPORARY, and self-announcing.
//   LOCKED season -> nightly-crawl.js skips locked seasons and the classifier is
//                    gone, so nothing will ever touch it again. PERMANENT — and
//                    the only games where `legacy` is arguably correct forever.
//
// The month histogram tests the "time-to-fill" reading directly: 139 of the 142
// are dated 2026, and if they cluster just before the 2026-07-16 cleanup that is
// near-decisive for "these are simply young", not "these are genuinely dead".
//
// ⚠️ The two live scripts DISAGREE about a season with no `locked` field:
// nightly-crawl.js L757 uses `s.locked === false` (strict — no field means NOT
// active, so the crawl skips it) while db-audit.js L91 uses `!s.locked` (no field
// means active). Part 4 therefore reports that case as its OWN bucket rather than
// folding it into either, because the two readings imply opposite conclusions
// about whether the game is reachable.
//
// Usage: node scripts/find-flag-collisions.js

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT          = path.join(__dirname, '..');
const GAMES_DIR     = path.join(ROOT, 'games', 'bv');
// data/ prefix: all root JSON lives under data/ (README "CRITICAL" note).
const FORFEIT_INDEX = path.join(ROOT, 'data', 'forfeit-games.json');

const SPORTS_INDEX   = path.join(ROOT, 'data', 'sports-index.json');

const COLLIDING_FLAGS = ['hidden', 'profileOnly', 'forfeit', 'bye', 'cancelled', 'abandoned'];

// The 2026-07-16 cleanup that removed the classifier. Games dated after this can
// not have been stamped by it, so a survivor later than this is inherited state,
// never a fresh classification.
const CLASSIFIER_REMOVED = '2026-07-16';

// ─── forfeit index ────────────────────────────────────────────────────────────
// A missing index is itself a finding, reported loudly rather than silently
// treated as "nothing is a forfeit" — every membership test would come back
// false and manufacture defects that do not exist.
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
  console.log(`⚠️  forfeit index NOT LOADED (${e.message}). Every inForfeitIndex result below is MEANINGLESS — fix this before reading them.`);
}

// ─── season lock state ────────────────────────────────────────────────────────
// Same loud-failure discipline as the forfeit index: a missing or unreadable
// index would make every season read as "unknown", and Part 4 would then be a
// table of zeros that looks like a finding.
const lockBySid = new Map();
let sportsIndexOk = false;
try {
  const raw = JSON.parse(fs.readFileSync(SPORTS_INDEX, 'utf8'));
  const seasons = raw.seasons || {};
  // Accept both addressing forms rather than assuming one: the object KEY and the
  // entry's own `.id`. db-audit.js and build-leaderboards.js both reach these via
  // Object.values(...).id, so `.id` is the form that is actually exercised.
  for (const [key, s] of Object.entries(seasons)) {
    if (!s || typeof s !== 'object') continue;
    const state = s.locked === true ? 'locked' : s.locked === false ? 'active' : 'no-locked-field';
    if (s.id) lockBySid.set(s.id, state);
    if (key)  lockBySid.set(key, state);
  }
  sportsIndexOk = lockBySid.size > 0;
  console.log(`sports-index: ${lockBySid.size} season keys loaded from data/sports-index.json`);
} catch (e) {
  console.log(`⚠️  sports-index NOT LOADED (${e.message}). PART 4 IS MEANINGLESS — every season will read as not-in-index.`);
}

function lockStateOf(sid) {
  return lockBySid.get(sid) || 'not-in-index';
}

// Never `new Date()` for date parsing — split YYYY-MM-DD (house rule).
function monthOf(d) {
  if (typeof d !== 'string') return 'no-date';
  const p = d.split('-');
  if (p.length < 3 || !/^\d{4}$/.test(p[0]) || !/^\d{2}$/.test(p[1])) return 'no-date';
  return `${p[0]}-${p[1]}`;
}

function yearOf(d) {
  if (typeof d !== 'string') return 'no-date';
  const parts = d.split('-');
  if (parts.length < 3 || !/^\d{4}$/.test(parts[0])) return 'no-date';
  return parts[0];
}

function count(v) { return Array.isArray(v) ? v.length : 0; }

// Which of this game's own teams does `fo` name? Normal games carry h/a, hidden
// games carry t1/t2 — check both rather than assuming the shape.
function foPointsAt(g) {
  if (g.fo === undefined || g.fo === null || g.fo === '') return 'ABSENT';
  if (g.fo === g.h || g.fo === g.t1) return 'home';
  if (g.fo === g.a || g.fo === g.t2) return 'away';
  return 'NEITHER-TEAM';
}

// Winner implied by the scoreline, or null when it cannot be read (missing
// scores, or a tie — a 0-0 forfeit records its winner in `fo` alone).
function scorelineWinner(g) {
  if (typeof g.hs !== 'number' || typeof g.as !== 'number') return null;
  if (g.hs === g.as) return null;
  return g.hs > g.as ? 'home' : 'away';
}

// ─── single pass ──────────────────────────────────────────────────────────────
let found = 0;
let gamesScanned = 0, seasonsScanned = 0, unreadable = 0;

const legacyByYear = new Map();
const legacyScoredByYear = new Map();
let legacyTotal = 0;

// Part 3 — profile of the whole legacy population.
const leg = {
  inForfeitIndex: 0,
  withScore: 0,
  withFo: 0,
  withAnyOtherFlag: 0,
  scoredNoOtherFlag: 0,   // the invisible cousins of the 49
  foDisagreesWithScore: 0,
};
const scoredNoFlagSamples = [];
const foDisagreeSamples = [];

// Part 4 — the post-repair survivors (legacy AND no score).
const survivorsByLock  = new Map();   // 'active' | 'locked' | 'no-locked-field' | 'not-in-index'
const survivorsByMonth = new Map();   // 'YYYY-MM' -> count, survivors only
const survivorSamples  = new Map();   // lock state -> up to 5 sample lines

// Part 1 — collision aggregates.
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
  const sid = fname.replace('.json', '');

  for (const [gameId, g] of Object.entries(gf.games || {})) {
    gamesScanned++;
    if (!g.legacy) continue;

    const others    = COLLIDING_FLAGS.filter(f => g[f]);
    const inIdx     = forfeitIndex.has(gameId);
    const foWhere   = foPointsAt(g);
    const hasScores = typeof g.hs === 'number' || typeof g.as === 'number';
    const year      = yearOf(g.d);

    // ── Parts 2 and 3: every legacy game, collision or not ──
    legacyTotal++;
    legacyByYear.set(year, (legacyByYear.get(year) || 0) + 1);
    if (inIdx)                leg.inForfeitIndex++;
    if (foWhere !== 'ABSENT') leg.withFo++;
    if (others.length)        leg.withAnyOtherFlag++;
    if (!hasScores) {
      // SURVIVOR: still carries legacy after the 2026-08-01 repair. These are the
      // 142 §2.5 is about — the flag is unfalsified for them, so the question is
      // whether anything can ever falsify it.
      const lock = lockStateOf(sid);
      survivorsByLock.set(lock, (survivorsByLock.get(lock) || 0) + 1);
      const mth = monthOf(g.d);
      survivorsByMonth.set(mth, (survivorsByMonth.get(mth) || 0) + 1);
      if (!survivorSamples.has(lock)) survivorSamples.set(lock, []);
      const bucket = survivorSamples.get(lock);
      if (bucket.length < 5) {
        bucket.push(`${gameId} (season ${sid}) ${g.d ?? '?'} rn=${g.rn ?? '?'} st=${g.st ?? '?'} spc=${g.spc ?? '-'}`);
      }
    }

    if (hasScores) {
      leg.withScore++;
      legacyScoredByYear.set(year, (legacyScoredByYear.get(year) || 0) + 1);
      // Reached step 1 (it holds a score) yet carries no second flag to make it
      // visible to Part 1. This is the number that decides whether the 49 are
      // the problem or merely the visible tip of it.
      if (!others.length) {
        leg.scoredNoOtherFlag++;
        if (scoredNoFlagSamples.length < 10) {
          scoredNoFlagSamples.push(`${gameId} (season ${sid}) ${g.d ?? '?'} ${g.hs ?? '?'}-${g.as ?? '?'} inForfeitIndex=${inIdx} fo=${g.fo ?? '(absent)'}`);
        }
      }
    }
    // Generalises the single disagreement found by hand among the 49 (ba9d21fe).
    const sw = scorelineWinner(g);
    if (sw && (foWhere === 'home' || foWhere === 'away') && sw !== foWhere) {
      leg.foDisagreesWithScore++;
      if (foDisagreeSamples.length < 10) {
        foDisagreeSamples.push(`${gameId} (season ${sid}) ${g.d ?? '?'} score ${g.hs}-${g.as} => ${sw} won, but fo names ${foWhere}`);
      }
    }

    // ── Part 1: collisions only ──
    if (!others.length) continue;
    found++;
    const nP = count(g.p), nHp = count(g.hp), nAp = count(g.ap);

    if (!inIdx)                     agg.notInForfeitIndex++;
    if (foWhere === 'ABSENT')       agg.foAbsent++;
    if (foWhere === 'NEITHER-TEAM') agg.foNeitherTeam++;
    if (g.spc)                      agg.withSpc++;
    if (nP + nHp + nAp > 0)         agg.withPlayerRows++;
    if (hasScores)                  agg.withScores++;

    console.log(`\n  gameId: ${gameId}  season: ${sid}`);
    console.log(`  flags:  legacy=true  ${others.map(f => `${f}=true`).join('  ')}`);
    console.log(`  date=${g.d}  rn=${g.rn}  st=${g.st}`);
    console.log(`  home=${g.hn||g.t1n||'?'}  away=${g.an||g.t2n||'?'}`);
    console.log(`  inForfeitIndex=${inIdx}  fo=${g.fo ?? '(absent)'} -> ${foWhere}`);
    console.log(`  spc=${g.spc ?? '(absent)'}  scores=${hasScores ? `${g.hs ?? '?'}-${g.as ?? '?'}` : '(none)'}  p=${nP} hp=${nHp} ap=${nAp}`);
  }
}

// ─── verdicts ─────────────────────────────────────────────────────────────────
const pct = n => legacyTotal ? ` (${(100 * n / legacyTotal).toFixed(1)}%)` : '';
const L = [];
L.push('');
L.push(`Scanned ${gamesScanned} games across ${seasonsScanned} season files${unreadable ? ` (${unreadable} unreadable)` : ''}.`);
L.push('');
L.push(`Total flag collisions: ${found}`);
if (found) {
  L.push('');
  L.push('PART 1 — COLLISION VERDICTS');
  L.push(`  missing from data/forfeit-games.json : ${agg.notInForfeitIndex} of ${found}${forfeitIndexOk ? '' : '   ⚠️ INDEX NOT LOADED — meaningless'}`);
  L.push(`  fo absent                            : ${agg.foAbsent} of ${found}`);
  L.push(`  fo naming neither of its own teams   : ${agg.foNeitherTeam} of ${found}`);
  L.push(`  carrying spc:1                       : ${agg.withSpc} of ${found}`);
  L.push(`  carrying player rows (p/hp/ap)       : ${agg.withPlayerRows} of ${found}`);
  L.push(`  carrying a score                     : ${agg.withScores} of ${found}`);
}

L.push('');
L.push('PART 2 — LEGACY POPULATION BY YEAR (all games carrying legacy:true)');
L.push(`  total: ${legacyTotal}`);
L.push('  year       legacy   of which hold a score');
const years = [...legacyByYear.keys()].sort();
let post2021 = 0;
for (const y of years) {
  const n = legacyByYear.get(y);
  const s = legacyScoredByYear.get(y) || 0;
  if (/^\d{4}$/.test(y) && Number(y) >= 2022) post2021 += n;
  L.push(`    ${y.padEnd(9)} ${String(n).padStart(6)}   ${String(s).padStart(6)}`);
}
L.push(`  dated 2022 or later: ${post2021} of ${legacyTotal}`);
L.push('  (legacy means "pre-history, nothing further obtainable"; BV migrated to PlayHQ ~2020.)');

L.push('');
L.push('PART 3 — LEGACY POPULATION PROFILE');
L.push(`  in data/forfeit-games.json           : ${leg.inForfeitIndex} of ${legacyTotal}${pct(leg.inForfeitIndex)}${forfeitIndexOk ? '' : '   ⚠️ INDEX NOT LOADED — meaningless'}`);
L.push(`  carrying a score (reached step 1)    : ${leg.withScore} of ${legacyTotal}${pct(leg.withScore)}`);
L.push(`  carrying fo (a forfeit winner)       : ${leg.withFo} of ${legacyTotal}${pct(leg.withFo)}`);
L.push(`  carrying any second flag (= Part 1)  : ${leg.withAnyOtherFlag} of ${legacyTotal}${pct(leg.withAnyOtherFlag)}`);
L.push('');
L.push(`  >> SCORED BUT NO SECOND FLAG         : ${leg.scoredNoOtherFlag} of ${legacyTotal}${pct(leg.scoredNoOtherFlag)}`);
L.push('     These reached step 1 (they hold a score, which only discoverGame supplies),');
L.push('     so legacy was unreachable for them too — but with no second flag they are');
L.push('     invisible to Part 1. This is the population behind the 49.');
for (const s of scoredNoFlagSamples) L.push(`       ${s}`);
L.push('');
L.push(`  fo disagreeing with the scoreline     : ${leg.foDisagreesWithScore}`);
for (const s of foDisagreeSamples) L.push(`       ${s}`);

L.push('');
L.push('PART 4 — SURVIVOR SPLIT (games still carrying legacy AND holding no score)');
if (!sportsIndexOk) {
  L.push('  ⚠️ sports-index NOT LOADED — every line below is meaningless. Fix that first.');
}
const survivorTotal = [...survivorsByLock.values()].reduce((a, b) => a + b, 0);
L.push(`  total survivors: ${survivorTotal}`);
L.push('');
L.push('  by season lock state:');
for (const state of ['active', 'locked', 'no-locked-field', 'not-in-index']) {
  const n = survivorsByLock.get(state) || 0;
  const note = {
    'active':          'nightly fixture passes still reach these — TEMPORARY, they will fill in and trip `legacy + score`',
    'locked':          'crawl skips locked seasons and the classifier is gone — PERMANENT, nothing will ever touch these',
    'no-locked-field': '⚠️ nightly (locked === false) treats these as NOT active; db-audit (!locked) treats them as active',
    'not-in-index':    '⚠️ season file exists in games/bv but the season is absent from sports-index.json',
  }[state];
  L.push(`    ${state.padEnd(16)} ${String(n).padStart(5)}   ${note}`);
  for (const s of (survivorSamples.get(state) || [])) L.push(`        ${s}`);
}
L.push('');
L.push('  by month (survivors only). The classifier was removed ' + CLASSIFIER_REMOVED + ':');
L.push('  clustering in the months BEFORE that date supports "these are simply young and');
L.push('  will fill in"; a flat spread across earlier years does not.');
for (const m of [...survivorsByMonth.keys()].sort()) {
  const n = survivorsByMonth.get(m);
  const mark = (m === CLASSIFIER_REMOVED.slice(0, 7)) ? '   <- classifier removed this month' : '';
  L.push(`    ${m.padEnd(9)} ${String(n).padStart(5)}${mark}`);
}
L.push('');
L.push('  READING IT: survivors concentrated in ACTIVE seasons means §2.1 needs no');
L.push('  classifier — the flag clears itself as scores arrive. Concentrated in LOCKED');
L.push('  seasons means the opposite: nothing will ever revisit them, and "accept no-flag');
L.push('  as the terminal state" is a decision about permanently wrong data, not a delay.');

// Sanity: Part 3's second-flag count must equal Part 1's collision count. If
// these ever diverge, the two code paths have drifted and BOTH are suspect.
L.push('');
L.push(`  cross-check: Part 1 collisions (${found}) == Part 3 second-flag count (${leg.withAnyOtherFlag})? ${found === leg.withAnyOtherFlag ? 'YES' : 'NO — the two paths disagree, do not trust either'}`);

const out = L.join('\n');
console.log(out);

// Same step-summary pattern as fold-diverged-players.js, so the verdicts are
// visible on the run page without opening the log.
if (process.env.GITHUB_STEP_SUMMARY) {
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + out + '\n```\n'); }
  catch (_) { /* summary is a convenience, never fatal */ }
}
