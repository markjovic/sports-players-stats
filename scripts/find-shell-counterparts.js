// scripts/find-shell-counterparts.js
//
// READ-ONLY. No PlayHQ calls, no writes, no commits. Reads players/, players/aliases/
// and games/bv, prints a report and optionally writes one JSON file.
//
// ─── THE PROBLEM ─────────────────────────────────────────────────────────────
// Measured 2026-09-11 by count-stats-checked.js: 591 player files hold a non-zero
// career (gp > 0) with an EMPTY games[]. 422 of them have EVERY game PlayHQ
// credits them already held in games/bv with a non-empty roster, 159 have most of
// them. Those appearances are not missing — they are filed under a DIFFERENT uuid.
//
// Worked example, confirmed against PlayHQ's own pages:
//
//   11fdc0c2-2994…  gp 373  games[] 372   the id that appears in every roster.
//                                         Its PlayHQ page is now PRIVATE and the
//                                         API returns a null publicProfileStatistics.
//   692caea1-e6dd…  gp 373  games[] 0     the id PlayHQ still credits. Its page
//                                         shows 374 games / 2985 points TODAY —
//                                         one game and 16 points more than our
//                                         last fetch, so it is the LIVE side.
//
// The two were tied together by season statistics, not by name: PlayHQ's page for
// 692caea1 gives Winter 2026 / Try Boys as 16 games, 224 points, 27 one-pointers,
// 76 two-pointers, 15 threes, and the 11fdc0c2 file holds gp 16, pts 224, ft 27,
// fg 76, threePt 15 for season c36e5626. Five independent numbers, identical.
//
// Neither existing tool can see these pairs. find-misrouted-appearances.js samples
// players CARRYING x and a shell has none; fold-diverged-players.js acts only on
// files carrying an apiId field, and count-stats-checked measured ZERO shells with
// one. Nothing in the pipeline ever had a reason to suspect a link, because both
// ids returned 200 with real statistics when they were fetched.
//
// ─── WHY NOT MATCH ON NAME ───────────────────────────────────────────────────
// Because a name test cannot settle an identity question — that is what produced
// the Jida McCrae-Cooper error and every alias written on a name alone. It is also
// unnecessary here. PlayHQ credits the shell with a specific LIST OF GAMES, we
// hold those games, and each one carries a team sheet. Intersecting the team
// sheets across the whole list leaves the people who were on every one of them.
//
// A teammate drops out as soon as the team changes. The worked example spans 2020
// to 2026, Bellarine to Geelong United to YMCA to Vic Country, under-12s to senior
// women. Nobody is on all of those team sheets except the player herself.
//
// The test fails honestly in both directions:
//   0 survivors  -> not attributable. Reported, never acted on.
//   2+ survivors -> ambiguous (a sibling or a long-term teammate). Reported.
//   1 survivor   -> a candidate, and then CONFIRMED independently below.
//
// A shell with a c of 1 or 2 cannot produce a safe answer — the intersection is
// most of a team sheet. That is fine: shells carry whole careers by construction,
// and MIN_GAMES below refuses to try.
//
// ─── CONFIRMATION IS SEPARATE FROM IDENTIFICATION ────────────────────────────
// The intersection proposes; the numbers dispose. For each single survivor the
// report compares the six career fields on both files and counts how many of the
// shell's credited games the candidate actually holds. A pair is only reported as
// CONFIRMED when the survivor holds essentially all of them AND the careers agree.
// Where the careers DISAGREE the pair is still reported, separately, because that
// is the Jordan Uppal shape (two real PlayHQ profiles, 34 games and 184) and it
// needs a different answer from a straight merge.
//
// ─── WHAT THIS TOOL DOES NOT DO ──────────────────────────────────────────────
// It writes no alias, no apiId, and nothing in games/bv. The game files are
// already CORRECT for every one of these — the appearances are in the right
// rosters under the other id. Nothing should ever be appended on the strength of
// this report.

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT         = path.join(__dirname, '..');
const PLAYERS_DIR  = path.join(ROOT, 'players');
const ALIASES_DIR  = path.join(ROOT, 'players', 'aliases');
const GAMES_DIR    = path.join(ROOT, 'games', 'bv');
const REPORTS_DIR  = path.join(ROOT, 'reports');
const OUT_PATH     = path.join(REPORTS_DIR, 'shell-counterparts.json');

const { TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

const argOf = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

// Minimum credited games before the intersection is even attempted. Below this
// the surviving set is most of a team sheet rather than one person. 5 is the
// floor, not a tuned value: at 5 games a teammate must have been on all five.
const MIN_GAMES = Math.max(1, parseInt(argOf('min-games', '5'), 10) || 5);
// A candidate must hold at least this share of the shell's credited games to be
// called confirmed. Not 100%: the worked example had 3 games with EMPTY rosters,
// which nobody holds, and a run that demanded perfection would reject it.
const MIN_SHARE = Math.min(1, Math.max(0, parseFloat(argOf('min-share', '0.95')) || 0.95));
const LIMIT     = parseInt(argOf('limit', '0'), 10) || 0;   // 0 = every shell
const WRITE     = !has('no-write');

const CAREER_FIELDS = ['gp', 'pts', 'fg', 'ft', 'threePt', 'fouls'];
const t13 = (s) => String(s == null ? '' : s).slice(0, TRUNC_LEN);

console.log(`find-shell-counterparts — read-only`);
console.log(`  min-games=${MIN_GAMES}  min-share=${MIN_SHARE}  limit=${LIMIT || 'all'}  write=${WRITE}`);
console.log('');

// ─── Pass 1: every player file, once ─────────────────────────────────────────
// Collects the shells, and builds trunc13 -> relative path for every player so a
// roster id can be resolved to a file later without a second directory walk.
const byTrunc = new Map();
const shells  = [];
let scanned = 0;

const prefixes = fs.readdirSync(PLAYERS_DIR).filter(f => /^[0-9a-f]{2}$/.test(f)).sort();
for (const prefix of prefixes) {
  const dir = path.join(PLAYERS_DIR, prefix);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const fname of files) {
    const uuid = fname.replace(/\.json$/, '');
    byTrunc.set(t13(uuid), path.join(prefix, fname));
    scanned++;
    let player;
    try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
    const bk = player.sports && player.sports.Basketball;
    if (!bk) continue;
    const gp = Number(bk.gp) || 0;
    const gamesHeld = Array.isArray(player.games) ? player.games.length : 0;
    if (gp > 0 && gamesHeld === 0 && Array.isArray(bk.c) && bk.c.length) {
      const career = {};
      for (const f of CAREER_FIELDS) career[f] = Number(bk[f]) || 0;
      shells.push({ uuid, name: player.name || '?', career, c: bk.c.slice(), private: player.private === true });
    }
  }
  process.stdout.write(`  players: ${scanned} scanned\r`);
}
console.log(`  players: ${scanned.toLocaleString()} scanned — ${shells.length.toLocaleString()} shell(s) with a credited list`);

shells.sort((a, b) => b.c.length - a.c.length);
const work = LIMIT ? shells.slice(0, LIMIT) : shells;

// ─── Pass 2: rosters, but ONLY for the games the shells need ─────────────────
// games/bv holds ~2.4M games; the shells between them credit a few tens of
// thousands. Collecting the needed gids first keeps this to that subset instead
// of every roster in the repository.
const needed = new Set();
for (const s of work) for (const gid of s.c) needed.add(gid);
console.log(`  ${needed.size.toLocaleString()} distinct game(s) credited across those shells`);

const rosterOf = new Map();        // gid -> Set of trunc13 roster ids
let seasonFiles = 0, emptyRosters = 0;
for (const fname of fs.readdirSync(GAMES_DIR)) {
  if (!fname.endsWith('.json')) continue;
  seasonFiles++;
  let gf;
  try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); } catch { continue; }
  for (const [gid, g] of Object.entries(gf.games || {})) {
    if (!needed.has(gid)) continue;
    const ids = new Set();
    if (g && Array.isArray(g.p)) for (const e of g.p) { const id = e && (e.id || e); if (id) ids.add(t13(id)); }
    if (!ids.size) emptyRosters++;
    rosterOf.set(gid, ids);
  }
  if (seasonFiles % 400 === 0) process.stdout.write(`  games: ${seasonFiles} season files\r`);
}
console.log(`  games: ${seasonFiles.toLocaleString()} season files read — ${rosterOf.size.toLocaleString()} of the needed games held (${emptyRosters.toLocaleString()} with an empty roster)`);

// ─── Pass 3: intersect, then confirm ─────────────────────────────────────────
const readPlayer = (trunc) => {
  const rel = byTrunc.get(trunc);
  if (!rel) return null;
  try { return JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, rel), 'utf8')); } catch { return null; }
};

const results = { confirmed: [], careerMismatch: [], lowShare: [], ambiguous: [], noSurvivor: [], tooFew: [], notHeld: [] };

for (const s of work) {
  const selfT = t13(s.uuid);
  const held = s.c.filter(gid => rosterOf.has(gid) && rosterOf.get(gid).size);
  if (!held.length)         { results.notHeld.push({ uuid: s.uuid, name: s.name, c: s.c.length }); continue; }
  if (held.length < MIN_GAMES) { results.tooFew.push({ uuid: s.uuid, name: s.name, c: s.c.length, held: held.length }); continue; }

  // Intersection across every held team sheet. The shell's own id is removed
  // first — it is absent from all of them by definition (that is what makes it a
  // shell), but removing it explicitly means a future partially-repaired file
  // cannot make itself its own counterpart.
  let surviving = null;
  for (const gid of held) {
    const ids = new Set(rosterOf.get(gid));
    ids.delete(selfT);
    if (surviving === null) { surviving = ids; continue; }
    for (const id of [...surviving]) if (!ids.has(id)) surviving.delete(id);
    if (!surviving.size) break;
  }
  surviving = surviving || new Set();

  if (surviving.size === 0) { results.noSurvivor.push({ uuid: s.uuid, name: s.name, c: s.c.length, held: held.length }); continue; }
  if (surviving.size > 1) {
    results.ambiguous.push({
      uuid: s.uuid, name: s.name, c: s.c.length, held: held.length,
      survivors: [...surviving].slice(0, 8),
    });
    continue;
  }

  // Exactly one. Confirm it independently of how it was found.
  const candT = [...surviving][0];
  const cand  = readPlayer(candT);
  if (!cand) { results.noSurvivor.push({ uuid: s.uuid, name: s.name, c: s.c.length, held: held.length, note: 'survivor has no player file' }); continue; }

  const candGames = new Set(Array.isArray(cand.games) ? cand.games : []);
  let holdsCredited = 0;
  for (const gid of s.c) if (candGames.has(gid)) holdsCredited++;
  const share = s.c.length ? holdsCredited / s.c.length : 0;

  const cbk = (cand.sports && cand.sports.Basketball) || {};
  const candCareer = {};
  for (const f of CAREER_FIELDS) candCareer[f] = Number(cbk[f]) || 0;
  const diffs = CAREER_FIELDS.filter(f => candCareer[f] !== s.career[f]);

  const row = {
    shell: s.uuid, shellName: s.name, shellCareer: s.career, credited: s.c.length,
    candidate: candT, candidateName: cand.name || '?', candidateCareer: candCareer,
    candidateGames: candGames.size, holdsCredited, share: +share.toFixed(3),
    careerDiffs: diffs, candidatePrivate: cand.private === true, shellPrivate: s.private,
  };
  // THREE outcomes, not two. A pair whose careers are IDENTICAL but whose share
  // falls short is not a career mismatch and must not be reported under that
  // heading — the difference is how many of the credited games anyone holds,
  // which is a capture question, not an identity one. Found by running this
  // against a shell with 3 empty-roster games out of 33.
  if (share >= MIN_SHARE && !diffs.length)      results.confirmed.push(row);
  else if (diffs.length)                        results.careerMismatch.push(row);
  else                                          results.lowShare.push(row);
}

// ─── Report ──────────────────────────────────────────────────────────────────
const L = '─'.repeat(72);
console.log(`\n${L}`);
console.log(`  SHELLS EXAMINED: ${work.length.toLocaleString()}`);
console.log(L);
console.log(`  CONFIRMED pair          : ${results.confirmed.length.toLocaleString()}   one survivor, holds >=${(MIN_SHARE * 100).toFixed(0)}% of the credited games, careers identical`);
console.log(`  one survivor, CAREERS DIFFER: ${results.careerMismatch.length.toLocaleString()}   the Jordan Uppal shape — two real profiles, NOT a straight merge`);
console.log(`  one survivor, careers match but share <${(MIN_SHARE * 100).toFixed(0)}%: ${results.lowShare.length.toLocaleString()}   identity looks right; some credited games are held by nobody`);
console.log(`  AMBIGUOUS (2+ survivors): ${results.ambiguous.length.toLocaleString()}   a sibling or a long-term teammate survived too — never acted on`);
console.log(`  no survivor             : ${results.noSurvivor.length.toLocaleString()}   nobody is on every team sheet`);
console.log(`  too few held games      : ${results.tooFew.length.toLocaleString()}   fewer than ${MIN_GAMES} held; the intersection would be a team sheet`);
console.log(`  none of their games held: ${results.notHeld.length.toLocaleString()}   genuine capture gap, not a duplicate`);
console.log(L);

const show = (rows, title, n = 15) => {
  if (!rows.length) return;
  console.log(`\n  ${title}`);
  console.log(`    ${'shell'.padEnd(15)}${'gp'.padStart(5)}${'cred'.padStart(6)}  ->  ${'counterpart'.padEnd(15)}${'gp'.padStart(5)}${'games'.padStart(7)}${'holds'.padStart(7)}  ${'diffs'.padEnd(22)} name`);
  for (const r of rows.slice(0, n)) {
    console.log(`    ${r.shell.slice(0, 13).padEnd(15)}${String(r.shellCareer.gp).padStart(5)}${String(r.credited).padStart(6)}  ->  ` +
      `${r.candidate.padEnd(15)}${String(r.candidateCareer.gp).padStart(5)}${String(r.candidateGames).padStart(7)}${String(r.holdsCredited).padStart(7)}  ` +
      `${(r.careerDiffs.length ? r.careerDiffs.join(',') : '—').padEnd(22)} ${r.shellName}`);
  }
  if (rows.length > n) console.log(`    … and ${rows.length - n} more in the report`);
};

show(results.confirmed.sort((a, b) => b.credited - a.credited), 'CONFIRMED PAIRS');
show(results.careerMismatch.sort((a, b) => b.credited - a.credited), 'ONE SURVIVOR BUT CAREERS DIFFER — read these individually');
show(results.lowShare.sort((a, b) => b.credited - a.credited), `CAREERS IDENTICAL BUT SHARE BELOW ${(MIN_SHARE * 100).toFixed(0)}% — the shortfall is games nobody holds`);

if (results.ambiguous.length) {
  console.log(`\n  AMBIGUOUS — more than one person on every team sheet`);
  for (const r of results.ambiguous.slice(0, 10)) {
    // NOTE: this bucket stores `uuid`, not `shell` — only the pair buckets carry
    // `shell`. Reading r.shell here threw on the first run that produced an
    // ambiguous row, which node --check cannot catch and no earlier fixture hit.
    console.log(`    ${r.uuid.slice(0, 13)}  ${String(r.held).padStart(4)} held  survivors: ${r.survivors.join(' ')}  ${r.name}`);
  }
  if (results.ambiguous.length > 10) console.log(`    … and ${results.ambiguous.length - 10} more`);
}

console.log(`\n${L}`);
console.log(`  NOTHING WAS WRITTEN to players/, players/aliases/ or games/bv.`);
console.log(`  The game files are already CORRECT for every pair above — the appearances`);
console.log(`  are in the right rosters under the counterpart's id. Nothing should be`);
console.log(`  appended to any roster on the strength of this report.`);
console.log(L);

if (WRITE) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    params: { minGames: MIN_GAMES, minShare: MIN_SHARE, limit: LIMIT },
    counts: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length])),
    ...results,
  }));
  console.log(`  Report written: reports/shell-counterparts.json`);
} else {
  console.log(`  --no-write given: no report file written.`);
}
