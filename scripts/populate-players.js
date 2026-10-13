// scripts/populate-players.js
//
// Populate a NAMED LIST of players — not a shard, not the corpus.
//
//   node scripts/populate-players.js --from-csv=reports/team-search-landed.csv
//   node scripts/populate-players.js --uuids=0afc7690,e6b76a7d
//   node scripts/populate-players.js --from-csv=... --dry-run
//
// WHAT IT DOES, AND WHY IT IS BUILT THIS WAY
//
// fetch-profile-stats.js is the only thing that fetches publicProfileStatistics,
// and it is scoped to ONE INDEX SHARD (--shard=00..ff, 256 of them over ~433,000
// players). There is no per-player entry point, and `--force` on a shard
// re-fetches every player in it (~1,615) — for forty named kids spread across
// forty shards that is ~65,000 profile fetches to get forty.
//
// This script does NOT reimplement any of that. It does two things:
//   1. deletes `sports.Basketball.statsChecked` on the named players only, which
//      is exactly what puts a player back in fetch-profile-stats.js's work list
//      (see its main(): a player with no statsChecked is selected, with no
//      --force needed);
//   2. runs the real `fetch-profile-stats.js --shard=XX` once per affected shard.
// The fetch, parse, private-flag, alias and name-heal logic is therefore the
// shipped, tested path verbatim — this file never writes a stat of its own.
//
// ⚠️ A SHARD RUN ALSO PICKS UP ANY OTHER PLAYER IN THAT SHARD WITH NO
// statsChecked. That is correct — those players need fetching too — but it means
// the run legitimately does more than the names you gave it. The counts below
// separate "you asked for" from "the shard also owed", so the extra is visible
// rather than silent.
//
// ⚠️ IT CANNOT CREATE A PLAYER. A uuid with no players/{xx}/{uuid}.json has never
// been seen in a game roster, and no profile fetch will invent one — the shard
// work list is built from players/indexes/{xx}.json. Those uuids are reported BY
// ID under MISSING and are a finding, not a no-op: they mean the player must be
// reached by crawling a season they appear in, not by this script.
//
// ⚠️ WHAT THIS DOES NOT DO. It populates PLAYER files. Rosters, team pages,
// search and the published site are built from those files by other jobs, and a
// commit is not a publication (T23). The workflow chains them; run standalone,
// this leaves you with updated players/ and nothing rebuilt.

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const FETCH_JS    = path.join(ROOT, 'scripts', 'fetch-profile-stats.js');

const args   = process.argv.slice(2);
const strArg = p => { const a = args.find(x => x.startsWith(p)); return a ? a.slice(p.length).trim() : ''; };
const has    = f => args.includes('--' + f);

const UUIDS_IN  = strArg('--uuids=');
const FROM_CSV  = strArg('--from-csv=');
const COLUMN    = strArg('--column=') || 'uuid';
const DRY       = has('dry-run');
const NO_FETCH  = has('no-fetch');          // clear only; leave the fetching to a matrix
const MAX_PLAY  = parseInt(strArg('--max-players=') || '2000', 10);
const MAX_PER_SHARD = strArg('--max-per-shard=');   // passed through to fetch-profile-stats --max=

if (!UUIDS_IN && !FROM_CSV) {
  console.error('✗ Give --uuids=<a,b,c> or --from-csv=<path>');
  console.error('  e.g. --from-csv=reports/team-search-landed.csv  (reads the "uuid" column)');
  process.exit(1);
}

// ─── Collect the uuids ────────────────────────────────────────────────────────
// A CSV cell may be quoted and may contain commas, so this is a real parse and
// not a split(','). Getting that wrong would silently truncate the work list.
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const wanted = new Set();
if (UUIDS_IN) for (const u of UUIDS_IN.split(',').map(s => s.trim()).filter(Boolean)) wanted.add(u);
if (FROM_CSV) {
  const p = path.isAbsolute(FROM_CSV) ? FROM_CSV : path.join(ROOT, FROM_CSV);
  if (!fs.existsSync(p)) { console.error(`✗ CSV not found: ${p}`); process.exit(1); }
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) { console.error(`✗ CSV is empty: ${p}`); process.exit(1); }
  const header = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const col = header.indexOf(COLUMN.toLowerCase());
  if (col === -1) {
    console.error(`✗ CSV has no "${COLUMN}" column. Columns present: ${header.join(', ')}`);
    console.error('  Use --column=<name> if the uuid lives under a different heading.');
    process.exit(1);
  }
  for (const line of lines.slice(1)) {
    const v = (parseCsvLine(line)[col] || '').trim();
    if (v) wanted.add(v);
  }
  console.log(`  read ${lines.length - 1} row(s) from ${FROM_CSV}, column "${COLUMN}"`);
}

const uuids = [...wanted];
console.log('=== populate-players.js ===');
console.log(`  players named : ${uuids.length}`);
console.log(`  mode          : ${DRY ? 'DRY RUN — nothing written, nothing fetched' : NO_FETCH ? 'clear only (--no-fetch)' : 'clear + fetch'}`);
if (!uuids.length) { console.error('✗ No uuids collected — nothing to do.'); process.exit(1); }

// A cap, because the failure this guards against is a wrong CSV column quietly
// clearing statsChecked across the corpus and triggering a full re-fetch.
if (uuids.length > MAX_PLAY) {
  console.error(`✗ ${uuids.length} players exceeds --max-players=${MAX_PLAY}.`);
  console.error('  That is probably the wrong column or the wrong file. Raise the cap deliberately if it is not.');
  process.exit(1);
}

// ─── Clear statsChecked on the named players only ─────────────────────────────
const missing = [], cleared = [], alreadyPending = [], unreadable = [];
const shards  = new Set();

for (const uuid of uuids) {
  const shard = uuid.slice(0, 2).toLowerCase();
  const fpath = path.join(PLAYERS_DIR, shard, `${uuid}.json`);
  if (!fs.existsSync(fpath)) { missing.push(uuid); continue; }
  let player;
  try { player = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
  catch (e) { unreadable.push(uuid); continue; }

  shards.add(shard);
  const bk = player.sports && player.sports.Basketball;
  if (!bk || !bk.statsChecked) { alreadyPending.push(uuid); continue; }
  if (!DRY) {
    delete bk.statsChecked;
    // Same write form as clear-stats-checked.js — compact, no re-indentation, so
    // the diff is the one field and not the whole file.
    fs.writeFileSync(fpath, JSON.stringify(player), 'utf8');
  }
  cleared.push(uuid);
}

console.log('');
console.log(`  cleared statsChecked : ${cleared.length}`);
console.log(`  already pending      : ${alreadyPending.length}  (no statsChecked — would have been fetched anyway)`);
console.log(`  shards affected      : ${shards.size}`);
if (unreadable.length) {
  console.log(`  ⚠ UNREADABLE          : ${unreadable.length}`);
  for (const u of unreadable.slice(0, 20)) console.log(`      ${u}`);
}
if (missing.length) {
  console.log('');
  console.log(`  ⚠ MISSING — no player file, CANNOT be populated by this script : ${missing.length}`);
  for (const u of missing.slice(0, 40)) console.log(`      ${u}`);
  if (missing.length > 40) console.log(`      … and ${missing.length - 40} more`);
  console.log('    These uuids have never been seen in a game roster. A profile fetch cannot');
  console.log('    reach them: the work list comes from players/indexes/{xx}.json. They need the');
  console.log('    season they played in to be crawled (nightly-crawl.js --season=<sid>).');
}
if (!shards.size) {
  console.error('');
  console.error('✗ Not one named player is on file. Nothing to populate.');
  process.exit(1);
}

if (DRY) {
  console.log('');
  console.log(`  DRY RUN — would fetch shards: ${[...shards].sort().join(', ')}`);
  process.exit(0);
}

// ─── Run the REAL fetcher, once per affected shard ────────────────────────────
if (NO_FETCH) {
  console.log('');
  console.log(`  --no-fetch — shards left for a matrix run: ${[...shards].sort().join(',')}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `shards=${JSON.stringify([...shards].sort())}\n`);
  }
  process.exit(0);
}

if (!fs.existsSync(FETCH_JS)) {
  console.error(`✗ ${path.relative(ROOT, FETCH_JS)} is not in this checkout — it is what does the fetching.`);
  console.error('  Add `scripts` to the workflow checkout.');
  process.exit(1);
}

const sorted = [...shards].sort();
let failed = [];
for (let i = 0; i < sorted.length; i++) {
  const shard = sorted[i];
  console.log('');
  console.log(`── shard ${shard}  (${i + 1}/${sorted.length}) ─────────────────────────────`);
  const a = [FETCH_JS, `--shard=${shard}`];
  if (MAX_PER_SHARD) a.push(`--max=${MAX_PER_SHARD}`);
  try {
    execFileSync(process.execPath, a, { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    // A failed shard is NAMED and the run carries on to the others, then exits
    // non-zero. Swallowing it would leave a partially populated set reporting
    // success, which is the shape this repository keeps being bitten by.
    console.error(`  ✗ shard ${shard} FAILED (exit ${e.status})`);
    failed.push(shard);
  }
}

console.log('');
console.log('=== populate-players.js done ===');
console.log(`  named          : ${uuids.length}`);
console.log(`  cleared        : ${cleared.length}`);
console.log(`  missing        : ${missing.length}`);
console.log(`  shards fetched : ${sorted.length - failed.length}/${sorted.length}`);
if (failed.length) {
  console.error(`  ✗ FAILED SHARDS: ${failed.join(', ')}`);
  console.error('    Those players were NOT populated. Re-run with the same input once the cause is fixed.');
  process.exit(1);
}
console.log('');
console.log('  Player files are updated. NOTHING ELSE IS — rosters, team pages, search and the');
console.log('  published site are built by other jobs. A commit is not a publication (T23).');
