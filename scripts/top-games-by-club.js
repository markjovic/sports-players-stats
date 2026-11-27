// scripts/top-games-by-club.js
// REVISION 2026-11-27a — first version.
//
// MOST GAMES PLAYED, FOR ONE CLUB. Offline. Walks players/ and sums games per
// player across every registration whose team belongs to that club. No PlayHQ
// calls, no network, no writes, no git, no lock.
//
// ⚠️ THE CLUB IS THE REAL CLUB, NOT THE ASSOCIATION. `club` elsewhere in this
// repo is sports-index `orgName` — the association (EDJBA, Camberwell) — and
// build-leaderboards.js carries that under the name `club` on every entry. The
// real club is PlayHQ's team `organisation`, captured by build-club-index.js
// into clubs/{clubId}.json as { seasons: { sid: [tid] } }. This script resolves
// through THAT, so a team whose name does not contain the club's name is still
// counted and a team from another club that happens to share a word is not.
//
// ⚠⚠ TRAP T20 — NEVER SUM REGISTRATIONS. THIS SCRIPT DID, AND IT WAS WRONG.
// index.html L3481, verbatim: "Several registrations under one tid are a
// regrade, so per-stat MAX, never a sum (T20); different tids in one season are
// genuinely different teams and DO sum." Sibling regs under one tid carry
// IDENTICAL season-cumulative blocks by design, so summing them multiplies a
// regraded player's season by the number of times they were regraded.
// The first live run of this script reported Louis SQUIRE at 602 games for one
// club against a PlayHQ career total of 275 — 2.2x, which is what that bug
// looks like. Grouping is now (sid, tid) → MAX, summed across tids and seasons,
// which is the same rule the season cards and the career grid already apply.
//
// ⚠ TWO NUMBERS FOR ONE CONCEPT, ON PURPOSE.
//   credited  PlayHQ's own gp from the registration stats, T20-grouped.
//   held      games WE hold for this club's teams, counted from games[] through
//             gameTids ({gid: tid}) — derived from an entirely different part of
//             the player file.
// They measure different things and are not expected to be equal: `held` is
// short where a game was never captured, and `credited` is short where PlayHQ
// left a registration blank. But a `credited` that runs far AHEAD of `held` is
// the signature of the double-count above, and that is now visible in every run
// instead of needing someone to check a career total by hand.
// Registrations with no gp are counted and reported separately rather than
// being silently treated as zero — a missing stat and a genuine nought are
// different facts.
//
// ⚠️ A CLUB WITH NO clubs/{id}.json FILE IS A FAILED LOOKUP, NOT AN EMPTY CLUB.
// build-club-index.js has to have run for the seasons in question. The script
// says so and exits 2 rather than printing an empty leaderboard.
//
// Usage:
//   node scripts/top-games-by-club.js --club-name="Spirit Magic"
//   node scripts/top-games-by-club.js --club-name="Spirit Magic" --top=40
//   node scripts/top-games-by-club.js --club=18d29132 --since=2025
//   node scripts/top-games-by-club.js --club-name=Kilsyth --comp="Junior Domestic"
//   node scripts/top-games-by-club.js --list-clubs=spirit

'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT        = process.cwd();
const PLAYERS_DIR = path.join(ROOT, 'players');
const CLUBS_DIR   = path.join(ROOT, 'clubs');
const CLUB_INDEX  = path.join(ROOT, 'data', 'club-index.json');
const SPORTS_IDX  = path.join(ROOT, 'data', 'sports-index.json');

const args   = process.argv.slice(2);
const strArg = (f, d) => { const a = args.find(x => x.startsWith('--' + f + '=')); return a ? a.slice(f.length + 3) : d; };
const CLUB_ID   = strArg('club', '');
const CLUB_NAME = strArg('club-name', '').toLowerCase();
const LIST      = strArg('list-clubs', '').toLowerCase();
const TOP       = Math.max(1, Number(strArg('top', '25')) || 25);
const SINCE     = strArg('since', '');
const COMP      = strArg('comp', '').toLowerCase();

console.log('=== top-games-by-club.js [READ-ONLY, offline] ===');

// ── the club list ───────────────────────────────────────────────────────────
let clubIdx = [];
try { clubIdx = JSON.parse(fs.readFileSync(CLUB_INDEX, 'utf8')) || []; }
catch (e) {
  console.error(`data/club-index.json could not be read (${e.message}).`);
  console.error('build-club-index.js writes it. Without it a club cannot be resolved by name.');
  process.exit(2);
}
console.log(`  club index: ${clubIdx.length} club(s) on file`);

if (LIST) {
  const hits = clubIdx.filter(c => String(c.n || '').toLowerCase().includes(LIST));
  console.log(`\n  ${hits.length} club(s) matching "${LIST}":`);
  for (const c of hits) console.log(`    ${c.id}  ${c.ty || '?'}  ${c.n}   (${c.t ?? '?'} team(s), ${c.s ?? '?'} season(s))`);
  if (!hits.length) console.log('    none — try a shorter fragment, or --list-clubs= with no value is not supported.');
  process.exit(0);
}

let club = null;
if (CLUB_ID) club = clubIdx.find(c => String(c.id) === CLUB_ID) || { id: CLUB_ID, n: '(not in the club index)' };
else if (CLUB_NAME) {
  // ⚠ EVERY match is printed before one is chosen. A substring is blunt, and a
  // silent pick of the first hit is how the wrong club gets reported with total
  // confidence.
  const hits = clubIdx.filter(c => String(c.n || '').toLowerCase().includes(CLUB_NAME));
  console.log(`  name match "${CLUB_NAME}": ${hits.length} club(s)`);
  for (const c of hits) console.log(`    ${c.id}  ${c.ty || '?'}  ${c.n}   (${c.t ?? '?'} team(s), ${c.s ?? '?'} season(s))`);
  if (hits.length === 0) { console.error('\nNo club matched. Use --list-clubs=<fragment> to search.'); process.exit(2); }
  if (hits.length > 1)  { console.error(`\n${hits.length} clubs matched — name the one you mean with --club=<id>. Refusing to guess.`); process.exit(2); }
  club = hits[0];
} else {
  console.error('One of --club=<id>, --club-name=<substring> or --list-clubs=<fragment> is required.');
  process.exit(2);
}
console.log(`\n  club: ${club.id}  ${club.n}${club.ty ? '  [' + club.ty + ']' : ''}`);

// ── its teams, per season ───────────────────────────────────────────────────
let rec;
try { rec = JSON.parse(fs.readFileSync(path.join(CLUBS_DIR, `${club.id}.json`), 'utf8')); }
catch (e) {
  console.error(`\nclubs/${club.id}.json could not be read (${e.message}).`);
  console.error('That is a FAILED LOOKUP, not a club with no teams. build-club-index.js');
  console.error('must have run for the seasons in question. Nothing is reported.');
  process.exit(2);
}

let sidx = {};
try { sidx = (JSON.parse(fs.readFileSync(SPORTS_IDX, 'utf8')) || {}).seasons || {}; } catch (_) {}
const sName = sid => (sidx[sid] && (sidx[sid].fullName || sidx[sid].name)) || sid;
const sSort = sid => (sidx[sid] && (sidx[sid].startDate || sidx[sid].endDate)) || '';
const sComp = sid => (sidx[sid] && sidx[sid].compName) || '';

const tidSeason = new Map();     // tid -> sid
let seasonsUsed = 0, seasonsSkipped = 0;
for (const [sid, tids] of Object.entries(rec.seasons || {})) {
  if (SINCE && sSort(sid) && sSort(sid) < SINCE) { seasonsSkipped++; continue; }
  if (COMP && !sComp(sid).toLowerCase().includes(COMP)) { seasonsSkipped++; continue; }
  seasonsUsed++;
  for (const tid of (tids || [])) tidSeason.set(String(tid), sid);
}
console.log(`  seasons: ${seasonsUsed} used, ${seasonsSkipped} filtered out`);
console.log(`  teams  : ${tidSeason.size}`);
if (SINCE) console.log(`  since  : ${SINCE}`);
if (COMP)  console.log(`  comp   : "${COMP}" (substring)`);
if (!tidSeason.size) { console.error('\nNo teams left after filtering. Nothing to report.'); process.exit(2); }

// ── walk the players ────────────────────────────────────────────────────────
const tally = new Map();   // uuid -> { name, games, held, regs, noGp, seasons:Map, teams:Set }
let scanned = 0, unreadable = 0, matched = 0, regsNoGp = 0, siblingGroups = 0;

function processFile(fp) {
  let d;
  try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (_) { unreadable++; return; }
  if (!d || !Array.isArray(d.seasons)) return;

  // ⚠ T20: one entry per (sid, tid), holding the MAX gp of its siblings.
  const groups = new Map();
  const myTids = new Set();
  for (const season of d.seasons) {
    for (const reg of (season.regs || [])) {
      const tid = reg && reg.tid ? String(reg.tid) : '';
      if (!tid || !tidSeason.has(tid)) continue;
      myTids.add(tid);
      const key = season.sid + '|' + tid;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { sid: season.sid, tid, gp: null, regs: 0, noGp: 0 });
      g.regs++;
      const gp = (reg.stats && typeof reg.stats.gp === 'number') ? reg.stats.gp : null;
      if (gp === null) { g.noGp++; regsNoGp++; }
      else g.gp = Math.max(g.gp === null ? 0 : g.gp, gp);
    }
  }
  if (!groups.size) return;
  matched++;

  let games = 0, regs = 0, noGp = 0;
  const seasons = new Map(), teams = new Set();
  for (const g of groups.values()) {
    if (g.regs > 1) siblingGroups++;          // a regrade: the rows a sum would have doubled
    regs += g.regs; noGp += g.noGp; teams.add(g.tid);
    if (!seasons.has(g.sid)) seasons.set(g.sid, 0);
    if (g.gp !== null) { games += g.gp; seasons.set(g.sid, seasons.get(g.sid) + g.gp); }
  }

  // The independent count: games on file whose team is one of this club's.
  const gt = (d && d.gameTids) || {};
  const mine = Array.isArray(d.games) ? d.games : [];
  let held = 0;
  for (const gid of mine) if (myTids.has(String(gt[gid]))) held++;

  tally.set(d.uuid, { name: d.name || '(no name on file)', games, held, regs, noGp, seasons, teams });
}
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.json')) {
      processFile(full);
      if (++scanned % 50000 === 0) console.log(`  scanned ${scanned.toLocaleString()} players...`);
    }
  }
}
if (!fs.existsSync(PLAYERS_DIR)) { console.error('\nplayers/ is not in this checkout. Nothing scanned.'); process.exit(2); }
walk(PLAYERS_DIR);

console.log(`\n  players scanned : ${scanned.toLocaleString()}`);
console.log(`  players matched : ${matched.toLocaleString()}`);
if (unreadable) console.log(`  ⚠ unreadable player files: ${unreadable} — counted, not guessed at`);
if (regsNoGp)   console.log(`  ⚠ registrations with NO gp stat: ${regsNoGp} — counted as unknown, NOT as zero`);
console.log(`  regrade groups  : ${siblingGroups.toLocaleString()} (sid,tid) group(s) hold more than one registration`);
console.log(`                    these are the rows a SUM would have double-counted — T20. MAX is used.`);
if (!matched) { console.log('\nNo player holds a registration with one of this club\'s teams.'); process.exit(0); }

// ── the table ───────────────────────────────────────────────────────────────
const ordered = [...tally.entries()]
  .map(([uuid, v]) => ({ uuid, ...v }))
  // games desc, then seasons desc, then name — a stated, arbitrary tie-break so
  // the order is identical in every run rather than left to Map insertion.
  .sort((a, b) => b.games - a.games || b.seasons.size - a.seasons.size || a.name.localeCompare(b.name));

console.log(`\n${'═'.repeat(78)}`);
console.log(`  MOST GAMES PLAYED — ${club.n}${COMP ? ` · comp contains "${COMP}"` : ''}${SINCE ? ` · since ${SINCE}` : ''}`);
console.log(`${'─'.repeat(78)}`);
console.log(`  ${'#'.padStart(3)}  ${'player'.padEnd(30)} ${'credited'.padStart(8)} ${'held'.padStart(6)} ${'seasons'.padStart(8)} ${'teams'.padStart(6)}`);
ordered.slice(0, TOP).forEach((p, i) => {
  // A credited figure running far ahead of held is the T20 signature. Flagged per
  // row so it cannot hide inside a total.
  const odd = p.held > 0 && p.games > p.held * 1.5;
  console.log(`  ${String(i + 1).padStart(3)}  ${p.name.slice(0, 30).padEnd(30)} ${String(p.games).padStart(8)} ${String(p.held).padStart(6)} ${String(p.seasons.size).padStart(8)} ${String(p.teams.size).padStart(6)}`
            + (p.noGp ? `  ⚠ ${p.noGp} reg(s) no gp` : '')
            + (odd ? `  ⚠ credited runs ahead of held` : ''));
});
if (ordered.length > TOP) console.log(`\n  … and ${ordered.length - TOP} more player(s) (--top=${ordered.length} for all)`);

console.log(`\n${'─'.repeat(78)}`);
console.log('  Season breakdown for the top 10:');
for (const p of ordered.slice(0, 10)) {
  const by = [...p.seasons.entries()].sort((a, b) => (sSort(b[0]) < sSort(a[0]) ? -1 : 1))
    .map(([sid, g]) => `${sName(sid)} ${g}`).join(' · ');
  console.log(`    ${p.name.slice(0, 28).padEnd(28)} ${by}`);
}
const total     = ordered.reduce((a, p) => a + p.games, 0);
const totalHeld = ordered.reduce((a, p) => a + p.held,  0);
console.log(`\n  ${ordered.length} player(s) across ${tidSeason.size} team(s).`);
console.log(`  credited (PlayHQ gp, T20-grouped) : ${total.toLocaleString()}`);
console.log(`  held     (games on file for those teams) : ${totalHeld.toLocaleString()}`);
console.log('  The two are not expected to match: held is short where a game was never');
console.log('  captured, credited is short where PlayHQ left a registration blank. Credited');
console.log('  running far AHEAD of held would mean the T20 grouping has failed.');
console.log('  Nothing was written.');
