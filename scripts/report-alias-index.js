// scripts/report-alias-index.js
//
// Read-only report over an ALREADY-BUILT alias index (players/aliases/*.json).
// Does NOT rebuild anything — just tallies what build-alias-index already
// committed, so you can verify a completed full run without re-running it.
//
// Writes reports/alias-index-report.json and (in Actions) a Summary-panel table.
// Commit is handled by the workflow, not here.

'use strict';

const fs = require('fs');
const path = require('path');
const { TRUNC_LEN } = require('./lib/uuid-prefix.cjs'); // same source of truth as build

const ROOT = path.join(__dirname, '..');
const ALIASES_DIR = path.join(ROOT, 'players', 'aliases');
const REPORT_FILE = path.join(ROOT, 'reports', 'alias-index-report.json');

function main() {
  if (!fs.existsSync(ALIASES_DIR)) {
    process.stderr.write('No players/aliases/ found — run build-alias-index first.\n');
    process.exit(1);
  }
  const files = fs.readdirSync(ALIASES_DIR).filter(f => f.endsWith('.json')).sort();

  let total = 0, identity = 0, redirect = 0;
  const samples = [];
  for (const f of files) {
    const map = JSON.parse(fs.readFileSync(path.join(ALIASES_DIR, f), 'utf8'));
    for (const [k, v] of Object.entries(map)) {
      total++;
      if (String(v).slice(0, TRUNC_LEN) === k) identity++;
      else { redirect++; if (samples.length < 10) samples.push(`${k} -> ${v}`); }
    }
  }

  const rep = {
    buckets: files.length,
    total, identity, redirect,
    generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(rep, null, 2));

  const md = [
    '## Alias index report (over already-built shards)',
    '',
    '| metric | value |',
    '|---|---|',
    `| bucket shards | ${files.length} |`,
    `| total aliases | ${total} |`,
    `| identity (spectator id == api id) | ${identity} |`,
    `| redirect (diverged spectator -> api) | ${redirect} |`,
  ];
  if (samples.length) md.push('', 'Sample diverged redirects:', ...samples.map(s => `- \`${s}\``));
  const report = md.join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report); } catch (e) { /* non-fatal */ }
  }

  process.stderr.write(`\nDONE. shards=${files.length} total=${total} identity=${identity} redirect=${redirect}\n`);
}

main();
