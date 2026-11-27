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
// ⚠️ GAMES COME FROM reg.stats.gp — THE ONLY PER-TEAM SOURCE THERE IS.
// A player file also carries games[] (every gid they appear in, from
// build-player-games.js), but that is a flat list of game ids with no team on
// it, so it cannot be attributed to a club and is NOT a second opinion here.
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
const tally = new Map();         // uuid -> { name, games, regs, noGp, seasons:Map(sid->games), teams:Set }
let scanned = 0, unreadable = 0, matched = 0, regsNoGp = 0;

function processFile(fp) {
  let d;
  try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (_) { unreadable++; return; }
  if (!d || !Array.isArray(d.seasons)) return;
  let hit = null;
  for (const season of d.seasons) {
    for (const reg of (season.regs || [])) {
      const tid = reg && reg.tid ? String(reg.tid) : '';
      if (!tid || !tidSeason.has(tid)) continue;
      const gp = (reg.stats && typeof reg.stats.gp === 'number') ? reg.stats.gp : null;
      if (gp === null) { regsNoGp++; }
      if (!hit) {
        hit = tally.get(d.uuid);
        if (!hit) tally.set(d.uuid, hit = { name: d.name || '(no name on file)', games: 0, regs: 0, noGp: 0, seasons: new Map(), teams: new Set() });
      }
      hit.regs++;
      if (gp === null) hit.noGp++;
      else {
        hit.games += gp;
        hit.seasons.set(season.sid, (hit.seasons.get(season.sid) || 0) + gp);
      }
      hit.teams.add(reg.tn || tid);
    }
  }
  if (hit) matched++;
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
console.log(`  ${'#'.padStart(3)}  ${'player'.padEnd(30)} ${'games'.padStart(6)} ${'seasons'.padStart(8)}  teams`);
ordered.slice(0, TOP).forEach((p, i) => {
  console.log(`  ${String(i + 1).padStart(3)}  ${p.name.slice(0, 30).padEnd(30)} ${String(p.games).padStart(6)} ${String(p.seasons.size).padStart(8)}  ${p.teams.size}`
            + (p.noGp ? `   ⚠ ${p.noGp} reg(s) with no gp` : ''));
});
if (ordered.length > TOP) console.log(`\n  … and ${ordered.length - TOP} more player(s) (--top=${ordered.length} for all)`);

console.log(`\n${'─'.repeat(78)}`);
console.log('  Season breakdown for the top 10:');
for (const p of ordered.slice(0, 10)) {
  const by = [...p.seasons.entries()].sort((a, b) => (sSort(b[0]) < sSort(a[0]) ? -1 : 1))
    .map(([sid, g]) => `${sName(sid)} ${g}`).join(' · ');
  console.log(`    ${p.name.slice(0, 28).padEnd(28)} ${by}`);
}
const total = ordered.reduce((a, p) => a + p.games, 0);
console.log(`\n  ${ordered.length} player(s), ${total.toLocaleString()} registration-game(s) in total across ${tidSeason.size} team(s).`);
console.log('  Games are the sum of reg.stats.gp. Nothing was written.');
