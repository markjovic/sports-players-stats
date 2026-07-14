// scripts/verify-enrich.js
//
// READ-ONLY validity scan of every player file. Detects the failure mode a bad
// enrich write could actually cause: a file that no longer parses (truncated /
// corrupt) or lost its core structure. Reads the working tree directly (fast fs),
// so the workflow does a normal shallow checkout — NO sparse-checkout (which makes
// a blobless clone and fetches every file over the network, ~1s each).
//
// It does NOT diff against a baseline: holding both the current and baseline 8.6GB
// trees on one runner isn't practical, and reversion isn't possible here (enrich
// committed disjoint per-bucket dirs with no other writer, so -X ours reverted
// nothing). Corruption is what this catches, and that needs only the current file.
//
// Writes ONLY reports/verify-enrich-report.json.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const NAME_RE = /^[0-9a-f-]{36}\.json$/;

function main() {
  const dist = { total: 0, unparseable: 0, missingUuid: 0, missingSports: 0, hasSeasons: 0, hasGames: 0, hasSpectatorIds: 0, privateStubs: 0 };
  const bad = [];

  const buckets = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d));
  for (const bucket of buckets) {
    const dir = path.join(PLAYERS_DIR, bucket);
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    for (const fname of files) {
      if (!NAME_RE.test(fname)) continue;
      dist.total++;
      const fpath = path.join(dir, fname);
      let obj;
      try { obj = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
      catch (e) { dist.unparseable++; bad.push({ file: `players/${bucket}/${fname}`, problem: 'does NOT parse (corrupt/truncated)' }); continue; }

      const uuid = fname.slice(0, -5);
      if (obj.uuid !== uuid) { dist.missingUuid++; bad.push({ file: `players/${bucket}/${fname}`, problem: `uuid mismatch (${obj.uuid})` }); }
      if (!obj.sports || typeof obj.sports !== 'object') dist.missingSports++;
      if (Array.isArray(obj.seasons) && obj.seasons.length) dist.hasSeasons++;
      if (Array.isArray(obj.games) && obj.games.length) dist.hasGames++;
      if (Array.isArray(obj.spectatorIds) && obj.spectatorIds.length) dist.hasSpectatorIds++;
      if (obj.private === true) dist.privateStubs++;
    }
    process.stderr.write(`  ${bucket}: total=${dist.total} unparseable=${dist.unparseable}\n`);
  }

  const flaggedCount = dist.unparseable + dist.missingUuid;
  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'verify-enrich-report.json'), JSON.stringify({ dist, flaggedCount, bad }, null, 2));

  const md = ['## verify-enrich validity scan (read-only)', '', '| metric | value |', '|---|---|',
    `| player files | ${dist.total} |`,
    `| **corrupt / unparseable** | ${dist.unparseable} |`,
    `| **uuid mismatch** | ${dist.missingUuid} |`,
    `| with seasons | ${dist.hasSeasons} |`,
    `| with games | ${dist.hasGames} |`,
    `| with spectatorIds | ${dist.hasSpectatorIds} |`,
    `| private stubs | ${dist.privateStubs} |`,
    `| no sports object | ${dist.missingSports} |`];
  md.push('', flaggedCount === 0
    ? '**Every player file parses and has its uuid — no enrich corruption.**'
    : `**${flaggedCount} file(s) flagged** (listed in reports/verify-enrich-report.json):`);
  if (bad.length) md.push(...bad.slice(0, 50).map(b => `- \`${b.file}\` — ${b.problem}`));
  if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n'); } catch (e) {} }
  process.stderr.write(`\nDONE. total=${dist.total} flagged=${flaggedCount}\n`);
}
main();
