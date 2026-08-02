// scripts/scan-season-name-contamination.js
//
// READ-ONLY. Defines the real quantum of the season-name-in-name-field bug:
// player files whose top-level `name` equals one of that same file's own
// seasons[].sn values (case-insensitive, whitespace-collapsed) -- i.e. a season
// string ("Autumn 2021", "Summer 2021/22") sitting where a person's name should
// be. This is the exact, provable signature of the parseProfileStats
// seasonStatistics[0].name bug (fetch-profile-stats.js ~L218), which writes a
// season name whenever finishOk sees `!player.name || wasPrivate`.
//
// Scans the full tree off local disk in one job (proven fast at ~412k files by
// verify-enrich). Writes NOTHING to player files. Emits one report so the
// repair can be built to the real shape, not a guess. The breakdown answers the
// two questions the repair turns on:
//   - recoverableFromGames: file has a non-empty games[] -> the nightly spectator
//     crawl saw this person, so their real name (p[].name) is recoverable by a
//     re-crawl or a games cross-reference. Repair can restore a real name.
//   - notRecoverable: no games[] and no other real-name signal -> the only honest
//     value is the `Player #<prefix>` placeholder until a future fetch finds one.
//
// normName copied verbatim from lib/namespace-resolve.cjs (the simple, current
// version) so "matches a season name" means exactly what the rest of the system
// means by name-equality.
//
// No git here -- the workflow commits the one report.
//
// Usage:
//   node scripts/scan-season-name-contamination.js

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const OUT = path.join(ROOT, 'reports', 'season-name-contamination.json');

const HEX = '0123456789abcdef';
const ALL_BUCKETS = [];
for (const a of HEX) for (const b of HEX) ALL_BUCKETS.push(a + b);

function log(msg) { console.log(`[scan] ${new Date().toISOString()} ${msg}`); }

// Verbatim from lib/namespace-resolve.cjs (v2, 2026-08-02 — NFKC + quote/dash fold + accent strip).
function normName(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")   // curly/low/prime apostrophes -> '
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')          // curly double quotes -> "
    .replace(/[\u2010-\u2015\u2212]/g, '-')                     // hyphen family + minus -> -
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')           // strip combining accents
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
// Verbatim from lib/namespace-resolve.cjs.
function isPlaceholderName(name) {
  return !name || /^player\s*#/i.test(String(name).trim());
}

function main() {
  let files = 0;
  let contaminated = 0;
  let recoverableFromGames = 0; // has games[] -> real name recoverable via crawl
  let notRecoverable = 0;       // no games[] and no real-name signal
  let alsoPrivate = 0;          // player.private === true
  let hasStatsChecked = 0;      // sports.Basketball.statsChecked present
  let placeholderAlready = 0;   // name already a placeholder (NOT counted as contaminated)

  const bySeasonString = {};    // which season strings show up as names, + counts
  const sample = [];            // up to 50 example records for review

  for (const bucket of ALL_BUCKETS) {
    const dir = path.join(PLAYERS_DIR, bucket);
    if (!fs.existsSync(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch { continue; }
      files++;

      const name = p.name;
      if (isPlaceholderName(name)) { placeholderAlready++; continue; }

      const normedName = normName(name);
      if (!normedName) continue;

      const seasonNames = new Set(
        (p.seasons || []).map(s => normName(s.sn)).filter(Boolean)
      );

      if (!seasonNames.has(normedName)) continue;

      // Contaminated: the display name IS one of this file's season strings.
      contaminated++;

      const hasGames = Array.isArray(p.games) && p.games.length > 0;
      if (hasGames) recoverableFromGames++; else notRecoverable++;
      if (p.private === true) alsoPrivate++;
      if (p.sports && p.sports.Basketball && p.sports.Basketball.statsChecked !== undefined) hasStatsChecked++;

      bySeasonString[name] = (bySeasonString[name] || 0) + 1;

      if (sample.length < 50) {
        sample.push({
          uuid: f.slice(0, -5),
          name,
          seasonNames: [...new Set((p.seasons || []).map(s => s.sn).filter(Boolean))],
          games: hasGames ? p.games.length : 0,
          private: p.private === true,
          statsChecked: p.sports && p.sports.Basketball ? (p.sports.Basketball.statsChecked || null) : null,
          updatedAt: p.updatedAt || null,
          hasApiId: typeof p.apiId === 'string' && !!p.apiId,
        });
      }

      if (files % 50000 === 0) log(`scanned ${files} files, ${contaminated} contaminated so far`);
    }
  }

  const topSeasonStrings = Object.entries(bySeasonString)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([sn, n]) => ({ seasonString: sn, count: n }));

  const report = {
    generatedAt: new Date().toISOString(),
    playerFilesScanned: files,
    contaminated,
    breakdown: {
      recoverableFromGames,   // repair can restore a real name (re-crawl / games cross-ref)
      notRecoverable,         // only honest value is the placeholder
      alsoPrivate,
      hasStatsChecked,
    },
    placeholderAlready,       // files already carrying a `Player #...` name (not contaminated)
    distinctSeasonStringsUsedAsNames: Object.keys(bySeasonString).length,
    topSeasonStrings,
    sample,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');

  const L = [];
  L.push('## Season-name contamination scan (READ-ONLY)');
  L.push('');
  L.push('| metric | value |');
  L.push('| --- | --- |');
  L.push(`| player files scanned | ${files} |`);
  L.push(`| **CONTAMINATED (name == own seasons[].sn)** | **${contaminated}** |`);
  L.push(`| — recoverable from games[] | ${recoverableFromGames} |`);
  L.push(`| — not recoverable (placeholder only) | ${notRecoverable} |`);
  L.push(`| — also private | ${alsoPrivate} |`);
  L.push(`| — has statsChecked | ${hasStatsChecked} |`);
  L.push(`| distinct season strings used as names | ${report.distinctSeasonStringsUsedAsNames} |`);
  L.push(`| files already placeholder (not counted) | ${placeholderAlready} |`);
  if (topSeasonStrings.length) {
    L.push('', '### Most common season strings appearing as names', '');
    L.push('| season string | count |');
    L.push('| --- | --- |');
    for (const t of topSeasonStrings) L.push(`| ${t.seasonString} | ${t.count} |`);
  }
  L.push('', `Full report + 50-record sample: reports/season-name-contamination.json`);
  const summary = L.join('\n') + '\n';
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary); } catch (_) {}
  }
  log(`DONE. scanned=${files} contaminated=${contaminated} recoverable=${recoverableFromGames} notRecoverable=${notRecoverable}`);
}

main();
