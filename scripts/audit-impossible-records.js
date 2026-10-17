// scripts/audit-impossible-records.js
//
// READ-ONLY. Finds every player whose STORED single-game record is impossible:
// a maxGamePTS higher than any team scored in the game the record was set in,
// or a maxGameThreePt above that score divided by three. Writes nothing to data,
// commits nothing, makes no PlayHQ calls.
//
// ── WHY (REPO_MANIFEST §6.84) ────────────────────────────────────────────────
// build-leaderboards.js now refuses to PUBLISH these, which fixes the board. It
// does not fix the player files: `maxGamePTS` is written once by
// fetch-profile-stats.js and never recomputed, and `statsChecked` stops the
// player being fetched again. So a contaminated 102 stays on the player file,
// and on their StatTrack profile, indefinitely. fetch-profile-stats.js now drops
// impossible lines at parse time — but only on a FETCH. This produces the list
// of players that need one.
//
// ── TWO PASSES, AND WHY IT IS NOT ONE ────────────────────────────────────────
// ⚠️ THE FIRST VERSION OF THIS SCRIPT CHECKED EACH RECORD AS IT MET IT. That asks
// for a different season on almost every player, and the game-score lookup holds
// 12 seasons out of 3,554 — a cache miss, and a full season game file re-read and
// re-parsed, per record. Run 2026-10-17 it reached 100,000 of 434,059 players in
// 90 minutes and was killed by the job timeout having written nothing. The work
// was never the player walk; it was ~200,000 redundant season-file parses.
//
// Pass 1 reads players/ and touches NO game file: it collects (uuid, name, cat,
// v, sid, gk) for every stored record. Pass 2 groups those by sid and resolves
// them a season at a time, so every season file is read AT MOST ONCE — which is
// why the lookup is built with cacheSeasons: 1. ~3,554 reads instead of ~200,000,
// and the order is what makes a cache of one sufficient.
//
// Both passes print elapsed time. If this job ever slows down again, the phase
// timings say immediately which half did it.
//
// ── OUTPUT ───────────────────────────────────────────────────────────────────
// reports/impossible-records.csv — uuid,name,category,stored,ceiling,
// game_max_score,gameKey,sid. The uuid column feeds populate-players.js
// --from-csv=, which clears statsChecked for exactly those players.
//
// The CSV is written even when the offender list is EMPTY, and even when pass 2
// is interrupted — a header-only file is a result ("nothing impossible"), the
// absence of a file is a failure, and the two must not look alike.
//
// A record whose game cannot be checked (no gameKey, season file not held, hs/as
// not both numbers) is NOT an offender. It is unverifiable, counted separately
// and never written to the CSV.
//
// Usage:
//   node scripts/audit-impossible-records.js
//   node scripts/audit-impossible-records.js --limit=40
//   node scripts/audit-impossible-records.js --min=0

'use strict';

const fs   = require('fs');
const path = require('path');
const { makeLookup } = require('./lib/game-scores.cjs');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const LIMIT = Math.max(1, parseInt(ARGS.limit || '40', 10));
// An overage of 0 means stored === ceiling, which is legal: a player can score
// every point their team scored. Only a STRICTLY greater value is impossible.
const MIN_OVER = Math.max(0, parseInt(ARGS.min || '0', 10));
// Games whose top team score is below this are treated as UNVERIFIABLE rather than
// as a cap. A stored 0 is already null in game-scores.cjs (an absent scoreline, not
// a played game); this raises the floor above that. 2026-10-17 the first full run
// reported caps of 2 and 4 behind 43- and 40-point records — a basketball game that
// finished 2-0 is a scoreline problem, not a stats problem, and the two must not be
// reported as the same thing. The default stays 1 (trust every non-zero scoreline)
// because where the real floor sits is a judgement about this corpus; the cap
// distribution printed at the end is the evidence for choosing it.
const MIN_CAP  = Math.max(1, parseInt(ARGS['min-cap'] || '1', 10));

const PLAYERS_DIR = path.join(ROOT, 'players');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_CSV     = path.join(REPORTS_DIR, 'impossible-records.csv');

// cacheSeasons: 1 — pass 2 is ordered by sid, so one slot is all it needs, and
// asking for more would invite the scattered-access thrash described above.
const lookup = makeLookup(ROOT, { cacheSeasons: 1 });

const CATS = ['maxGamePTS', 'maxGameThreePt'];

// maxGameThreePt counts 3-POINTERS, not points, so its ceiling is the team score
// divided by three. Comparing a 3PT COUNT against a points total would let a
// fabricated 34 through on a 20-0 game.
function ceilingFor(cat, cap) {
  return cat === 'maxGameThreePt' ? Math.floor(cap / 3) : cap;
}

function hhmmss(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function writeCsv(offenders) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const rows = ['uuid,name,category,stored,ceiling,game_max_score,gameKey,sid'];
  for (const o of offenders) {
    rows.push([o.uuid, JSON.stringify(o.name || ''), o.cat, o.v, o.ceiling, o.cap, o.gk, o.sid].join(','));
  }
  fs.writeFileSync(OUT_CSV, rows.join('\n') + '\n');
}

function main() {
  const t0 = Date.now();
  console.log('audit-impossible-records.js   READ-ONLY');
  console.log('─'.repeat(60));

  const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  if (!prefixes.length) { console.error('no player shards found'); process.exit(1); }

  // ── PASS 1 — players only. No game file is opened here. ───────────────────
  console.log(`Pass 1: collecting stored records from ${prefixes.length} shards (no game files read)`);
  const bySid   = new Map();   // sid -> [{uuid,name,cat,v,gk}]
  let scanned = 0, withRecord = 0, unverifiable = 0;

  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS_DIR, prefix);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (_) { continue; }
    for (const fname of files) {
      let player;
      try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); }
      catch (_) { continue; }
      scanned++;

      for (const cat of CATS) {
        const rec = player.records && player.records[cat];
        const v   = rec && rec.v;
        if (typeof v !== 'number' || v <= 0) continue;
        withRecord++;

        const sid = rec.sid || null;
        const gk  = rec.gameKey || null;
        if (!sid || !gk) { unverifiable++; continue; }

        if (!bySid.has(sid)) bySid.set(sid, []);
        bySid.get(sid).push({ uuid: fname.replace('.json', ''), name: player.name || '', cat, v, gk });
      }

      if (scanned % 50000 === 0) {
        console.log(`  ${scanned.toLocaleString()} players scanned  (${hhmmss(Date.now() - t0)})`);
      }
    }
  }

  const t1 = Date.now();
  const pending = [...bySid.values()].reduce((n, a) => n + a.length, 0);
  console.log(`  ${scanned.toLocaleString()} players scanned, ${withRecord.toLocaleString()} stored records`);
  console.log(`  ${pending.toLocaleString()} checkable across ${bySid.size.toLocaleString()} seasons`
    + `, ${unverifiable.toLocaleString()} carry no sid/gameKey`);
  console.log(`  Pass 1 took ${hhmmss(t1 - t0)}`);

  // ── PASS 2 — one season at a time, each file read at most once. ───────────
  console.log(`\nPass 2: resolving against ${bySid.size.toLocaleString()} season game files`);
  const offenders = [];
  let seasonsDone = 0, lowCap = 0;

  for (const [sid, items] of bySid) {
    for (const it of items) {
      const cap = lookup.maxScore(sid, it.gk);
      if (cap === null) { unverifiable++; continue; }
      if (cap < MIN_CAP) { lowCap++; unverifiable++; continue; }
      const ceiling = ceilingFor(it.cat, cap);
      if (it.v > ceiling + MIN_OVER) {
        offenders.push({ uuid: it.uuid, name: it.name, cat: it.cat, v: it.v, ceiling, cap, gk: it.gk, sid });
      }
    }
    seasonsDone++;
    if (seasonsDone % 500 === 0) {
      console.log(`  ${seasonsDone.toLocaleString()}/${bySid.size.toLocaleString()} seasons`
        + `  ${offenders.length} impossible so far  (${hhmmss(Date.now() - t1)})`);
      writeCsv(offenders);   // partial result survives a timeout
    }
  }

  const t2 = Date.now();
  console.log(`  Pass 2 took ${hhmmss(t2 - t1)}`);
  console.log(`  ${lookup.stats.seasonsRead} season game files read, ${lookup.stats.seasonsMissing} not held`);

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`  ${scanned.toLocaleString()} players scanned`);
  console.log(`  ${withRecord.toLocaleString()} stored single-game records`);
  console.log(`  ${unverifiable.toLocaleString()} unverifiable (no gameKey/sid, game not held, or no scoreline)`);
  console.log(`  ${offenders.length.toLocaleString()} IMPOSSIBLE`);
  console.log('');

  if (lowCap) {
    console.log(`  ${lowCap.toLocaleString()} of those sat behind a scoreline under --min-cap=${MIN_CAP}`);
    console.log('');
  }

  // The cap distribution is the evidence for where --min-cap belongs. A cluster of
  // offenders against caps of 2 or 4 is a scoreline problem in those game files; a
  // cluster against 20 is the forfeit convention carrying fabricated stat lines.
  if (offenders.length) {
    const byCap = new Map();
    for (const o of offenders) byCap.set(o.cap, (byCap.get(o.cap) || 0) + 1);
    const rows = [...byCap.entries()].sort((a, b) => a[0] - b[0]);
    console.log('  offenders by the game\'s top team score:');
    let under = 0, atOrOver = 0;
    for (const [cap, n] of rows) {
      if (cap < 20) under += n; else atOrOver += n;
    }
    // Every cap below 20 is listed in full — truncating this table is what hid the
    // shape on 2026-10-17, where a single bucket held 46% of the offenders.
    for (const [cap, n] of rows.filter(r => r[0] < 20)) {
      console.log(`    top score ${String(cap).padStart(4)}  ${String(n).padStart(6)} record(s)   <- suspect SCORELINE, not stats`);
    }
    console.log(`    top score  >=20  ${String(atOrOver).padStart(6)} record(s)`);
    console.log(`    ── under 20: ${under}   20 and over: ${atOrOver}`);
    console.log('');

    // A scoreline problem is systematic per season; fabricated stat lines are not.
    // Clustering the low-cap offenders by season says which one this is.
    const lowBySeason = new Map();
    for (const o of offenders) {
      if (o.cap >= 20) continue;
      lowBySeason.set(o.sid, (lowBySeason.get(o.sid) || 0) + 1);
    }
    if (lowBySeason.size) {
      const top = [...lowBySeason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      console.log(`  low-scoreline offenders cluster across ${lowBySeason.size} season(s); worst:`);
      for (const [sid, n] of top) console.log(`    ${sid}  ${String(n).padStart(5)} record(s)`);
      console.log('');
    }
  }

  offenders.sort((a, b) => (b.v - b.ceiling) - (a.v - a.ceiling));
  if (!offenders.length) {
    console.log('  No impossible stored records. (A header-only CSV is still written.)');
  } else {
    console.log(`  worst ${Math.min(LIMIT, offenders.length)}:`);
    console.log(`    ${'stored'.padStart(7)} ${'ceiling'.padStart(8)}  ${'cat'.padEnd(15)} name / game`);
    for (const o of offenders.slice(0, LIMIT)) {
      console.log(`    ${String(o.v).padStart(7)} ${String(o.ceiling).padStart(8)}  ${o.cat.padEnd(15)} `
        + `${o.name || o.uuid}  game ${o.gk} (season ${o.sid}, top team score ${o.cap})`);
    }
    if (offenders.length > LIMIT) console.log(`    ... and ${offenders.length - LIMIT} more`);
  }

  writeCsv(offenders);
  console.log(`\n  Wrote ${path.relative(ROOT, OUT_CSV)} (${offenders.length} rows)`);
  console.log('  Feed it to populate-players.js --from-csv= to clear statsChecked and re-fetch.');
  console.log(`  Total ${hhmmss(Date.now() - t0)}`);
}

main();
