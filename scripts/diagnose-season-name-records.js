// scripts/diagnose-season-name-records.js
//
// READ-ONLY. Local only — NO API, NO network, NO writes. Counts player records
// whose `name` is actually a SEASON name (the parseProfileStats bug: the
// profile query has no player-name field, only seasonStatistics[].name = the
// season, which got written as the player's name).
//
// METHOD (ground-truth, not a guess): the bug copies a real season name
// verbatim into the record. So we build the set of ALL real season names from
// data/sports-index.json (de-duped), and flag any player record whose name is
// in that set. This catches exactly the contaminated records regardless of
// season-name format, with effectively zero false positives (no real person is
// named "Winter 2023"). A regex is kept ONLY as an audit: names that LOOK
// season-like but are NOT in the known set — those reveal either seasons
// missing from the index, or (rarely) a real name to eyeball.
//
// Provenance: for flagged records, read the player-file `updatedAt` to split
// backfill-era vs pre-backfill (bounded by the number of bad records).
//
// Usage:
//   node scripts/diagnose-season-name-records.js [--cutoff=2026-07-11] [--examples=20]

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const INDEX_DIR   = path.join(ROOT, 'players', 'indexes');
const PLAYERS_DIR = path.join(ROOT, 'players');
const SPORT_INDEX_FILE = path.join(ROOT, 'data', 'sports-index.json');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const CUTOFF = new Date(ARGS.cutoff ? String(ARGS.cutoff) : '2026-07-11T00:00:00Z').getTime();
const MAX_EXAMPLES = ARGS.examples ? parseInt(ARGS.examples, 10) : 20;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

// Audit regex only (NOT the primary detector): season-word + year, bare year,
// grade-token + year. Used to surface season-like names missing from the index.
const YEAR = /(19|20)\d\d(\/\d\d)?/;
const SEASON_WORD = /\b(summer|winter|spring|autumn|fall|term|season)\b/i;
function looksSeasonLike(nm) {
  if (SEASON_WORD.test(nm) && YEAR.test(nm)) return true;
  if (/^(19|20)\d\d(\/\d\d)?$/.test(nm)) return true;
  if (/^(u\d+|under\s*\d+|div(ision)?\b|grade\b|round\b)/i.test(nm) && YEAR.test(nm)) return true;
  return false;
}

function playerShard(uuid)    { return uuid.slice(0, 2).toLowerCase(); }
function playerFilePath(uuid) { return path.join(PLAYERS_DIR, playerShard(uuid), `${uuid}.json`); }

console.log('diagnose-season-name-records.js  (READ-ONLY — no API, no network, no writes)');
console.log('─'.repeat(64));

// Build the ground-truth set of real season names from sports-index.
let sportIndex = {};
try { sportIndex = readJson(SPORT_INDEX_FILE); }
catch (e) { console.error(`Cannot read ${SPORT_INDEX_FILE}: ${e.message}`); process.exit(1); }
const seasons = sportIndex.seasons || {};
const knownSeasonNames = new Set();
for (const sid of Object.keys(seasons)) {
  const nm = normName(seasons[sid] && seasons[sid].name);
  if (nm) knownSeasonNames.add(nm);
}
console.log(`  Known season names (from sports-index, de-duped): ${knownSeasonNames.size.toLocaleString()}`);
console.log(`  Backfill-era cutoff: ${new Date(CUTOFF).toISOString()} (updatedAt >= cutoff ⇒ backfill-era)`);

let shardFiles = [];
try { shardFiles = fs.readdirSync(INDEX_DIR).filter(f => /^[0-9a-f]{2}\.json$/i.test(f)); }
catch (e) { console.error(`Cannot read ${INDEX_DIR}: ${e.message}`); process.exit(1); }

// Phase 1: flag records whose name is a known season name; audit season-like
// names that are NOT known seasons.
const flagged = [];        // name ∈ knownSeasonNames  (definite contamination)
const auditOnly = [];      // looksSeasonLike but NOT a known season name
let totalRecords = 0;
for (const f of shardFiles) {
  let idx;
  try { idx = readJson(path.join(INDEX_DIR, f)); } catch (_) { continue; }
  for (const [uuid, rec] of Object.entries(idx)) {
    totalRecords++;
    const nm = normName(rec && rec.name);
    if (!nm) continue;
    if (knownSeasonNames.has(nm)) flagged.push({ uuid, name: rec.name });
    else if (looksSeasonLike(nm)) auditOnly.push({ uuid, name: rec.name });
  }
}

console.log(`  Total indexed records                 : ${totalRecords.toLocaleString()}`);
console.log(`  Records named after a KNOWN season    : ${flagged.length.toLocaleString()}  (${totalRecords ? (flagged.length / totalRecords * 100).toFixed(2) : '0.00'}%)  <- definite contamination`);
console.log(`  Season-LIKE names NOT in known set    : ${auditOnly.length.toLocaleString()}  <- audit: missing seasons in index, or real names to eyeball`);

// Phase 2: provenance for the definite (known-season) flagged records.
let backfillEra = 0, preBackfill = 0, noTimestamp = 0, fileMissing = 0;
let withApiId = 0, privateCount = 0, publicCount = 0;
const examples = [];
for (const { uuid, name } of flagged) {
  let rec;
  try { rec = readJson(playerFilePath(uuid)); } catch (_) { fileMissing++; continue; }
  const ts = rec.updatedAt ? new Date(rec.updatedAt).getTime() : NaN;
  if (Number.isNaN(ts)) noTimestamp++;
  else if (ts >= CUTOFF) backfillEra++;
  else preBackfill++;
  if (rec.apiId) withApiId++;
  if (rec.private === true) privateCount++; else publicCount++;
  if (examples.length < MAX_EXAMPLES) {
    examples.push({ uuid, name, updatedAt: rec.updatedAt || '(none)', private: rec.private === true, apiId: rec.apiId || null });
  }
}

console.log('');
console.log(`  Provenance of contaminated records (player-file updatedAt):`);
console.log(`    backfill-era (>= cutoff)   : ${backfillEra.toLocaleString()}`);
console.log(`    pre-backfill (< cutoff)    : ${preBackfill.toLocaleString()}  <- via the normal pipeline BEFORE the backfill; if >0 the fix must extend beyond the backfill script`);
console.log(`    no/unparseable timestamp   : ${noTimestamp.toLocaleString()}`);
console.log(`    player file missing        : ${fileMissing.toLocaleString()}`);
console.log('');
console.log(`  Of contaminated records:  private:true=${privateCount.toLocaleString()}  public=${publicCount.toLocaleString()}  have-apiId=${withApiId.toLocaleString()}`);
console.log('    NOTE: "pre-backfill" is a LOWER BOUND — a pre-existing record re-touched by a nightly');
console.log('    run after the cutoff would be counted as backfill-era.');

if (examples.length) {
  console.log('\n  examples (name matches a known season):');
  for (const e of examples) {
    console.log(`    ${e.uuid}  name="${e.name}"  updatedAt=${e.updatedAt}  ${e.private ? 'private' : 'public'}${e.apiId ? '  apiId=' + e.apiId.slice(0, 13) : ''}`);
  }
}
if (auditOnly.length) {
  console.log('\n  AUDIT — season-like names NOT in the known-season set (check: missing seasons vs real names):');
  for (const e of auditOnly.slice(0, MAX_EXAMPLES)) {
    console.log(`    ${e.uuid}  name="${e.name}"`);
  }
  if (auditOnly.length > MAX_EXAMPLES) console.log(`    … and ${(auditOnly.length - MAX_EXAMPLES).toLocaleString()} more`);
}
console.log('\nDone (nothing was written).');
