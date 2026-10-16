// scripts/audit-impossible-records.js
//
// READ-ONLY. Finds every player whose STORED single-game record is impossible:
// a maxGamePTS (or maxGameThreePt) higher than any team scored in the game the
// record was set in. Writes nothing, commits nothing, makes no PlayHQ calls.
//
// ── WHY (REPO_MANIFEST §6.84) ────────────────────────────────────────────────
// build-leaderboards.js now refuses to PUBLISH these, which fixes the board.
// It does not fix the player files: `maxGamePTS` is written once by
// fetch-profile-stats.js and never recomputed, and `statsChecked` stops the
// player being fetched again. So a contaminated 102 stays on the player file,
// and on their StatTrack profile, indefinitely.
//
// fetch-profile-stats.js now drops impossible lines at parse time — but only on
// a FETCH. This produces the list of players that need one.
//
// ── OUTPUT ───────────────────────────────────────────────────────────────────
// reports/impossible-records.csv — uuid,name,category,stored,game_max_score,gameKey,sid
// The uuid column feeds populate-players.js --from-csv=, which clears
// statsChecked for exactly those players and re-fetches them.
//
// A record whose game cannot be checked (no gameKey, season file not held,
// hs/as not both numbers) is NOT an offender — it is unverifiable, counted
// separately and never written to the CSV. Re-fetching those would be work
// against an unknown, and build-leaderboards already withholds them from the
// board.
//
// Usage:
//   node scripts/audit-impossible-records.js
//   node scripts/audit-impossible-records.js --limit=40
//   node scripts/audit-impossible-records.js --min=0     # include small overages

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
// An overage of 0 means stored === cap, which is legal (a player can score every
// point their team scored). Only a STRICTLY greater value is impossible; --min
// raises the bar when you want only the egregious ones.
const MIN_OVER = Math.max(0, parseInt(ARGS.min || '0', 10));

const PLAYERS_DIR = path.join(ROOT, 'players');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_CSV     = path.join(REPORTS_DIR, 'impossible-records.csv');

const lookup = makeLookup(ROOT);

const CATS = [
  { key: 'maxGamePTS',     label: 'maxGamePTS' },
  { key: 'maxGameThreePt', label: 'maxGameThreePt' },
];

function main() {
  console.log('audit-impossible-records.js   READ-ONLY');
  console.log('─'.repeat(60));

  const prefixes = fs.readdirSync(PLAYERS_DIR)
    .filter(d => /^[0-9a-f]{2}$/.test(d))
    .sort();
  if (!prefixes.length) { console.error('no player shards found'); process.exit(1); }

  let scanned = 0, withRecord = 0, unverifiable = 0;
  const offenders = [];

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
        const rec = player.records?.[cat.key];
        const v   = rec?.v;
        if (typeof v !== 'number' || v <= 0) continue;
        withRecord++;

        const sid = rec.sid || null;
        const gk  = rec.gameKey || null;
        if (!sid || !gk) { unverifiable++; continue; }

        const cap = lookup.maxScore(sid, gk);
        if (cap === null) { unverifiable++; continue; }

        // maxGameThreePt counts 3-POINTERS, not points, so its ceiling is the
        // team score divided by three. Comparing a 3PT count against the raw
        // score would let a fabricated 34 through on a 20-0 game.
        const ceiling = cat.key === 'maxGameThreePt' ? Math.floor(cap / 3) : cap;
        if (v > ceiling + MIN_OVER) {
          offenders.push({
            uuid: fname.replace('.json', ''),
            name: player.name || '',
            cat:  cat.label,
            v, ceiling, cap, gk, sid,
          });
        }
      }

      if (scanned % 50000 === 0) process.stdout.write(`  ${scanned} players scanned\r`);
    }
  }

  console.log(`  ${scanned.toLocaleString()} players scanned`);
  console.log(`  ${withRecord.toLocaleString()} stored single-game records`);
  console.log(`  ${unverifiable.toLocaleString()} unverifiable (no gameKey/sid, game not held, or no scoreline)`);
  console.log(`  ${offenders.length.toLocaleString()} IMPOSSIBLE`);
  console.log('');

  offenders.sort((a, b) => (b.v - b.ceiling) - (a.v - a.ceiling));
  console.log(`  worst ${Math.min(LIMIT, offenders.length)}:`);
  console.log(`    ${'stored'.padStart(7)} ${'ceiling'.padStart(8)}  ${'cat'.padEnd(15)} name / game`);
  for (const o of offenders.slice(0, LIMIT)) {
    console.log(`    ${String(o.v).padStart(7)} ${String(o.ceiling).padStart(8)}  ${o.cat.padEnd(15)} `
      + `${(o.name || o.uuid)}  game ${o.gk} (season ${o.sid}, top team score ${o.cap})`);
  }
  if (offenders.length > LIMIT) console.log(`    ... and ${offenders.length - LIMIT} more`);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const rows = ['uuid,name,category,stored,ceiling,game_max_score,gameKey,sid'];
  for (const o of offenders) {
    rows.push([o.uuid, JSON.stringify(o.name), o.cat, o.v, o.ceiling, o.cap, o.gk, o.sid].join(','));
  }
  fs.writeFileSync(OUT_CSV, rows.join('\n') + '\n');
  console.log(`\n  Wrote ${path.relative(ROOT, OUT_CSV)} (${offenders.length} rows)`);
  console.log('  Feed it to populate-players.js --from-csv= to clear statsChecked and re-fetch.');
  console.log(`  ${lookup.stats.seasonsRead} season game files read, ${lookup.stats.seasonsMissing} not held`);
}

main();
