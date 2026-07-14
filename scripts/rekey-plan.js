// scripts/rekey-plan.js
//
// 3b-2 PLAN (READ-ONLY). Computes the relocate/merge plan and the merge AUDIT
// so it can be reviewed before any file is moved, merged, or deleted. Writes
// NOTHING to player files. Two modes:
//   --scan --bucket XX   emit a per-file summary for one bucket (matrix)
//   --plan               group all summaries by api id -> reports/rekey-merges.json
//
// Grouping every file by its api id (player.apiId || filename) reveals:
//   - group size 1, direct (key == apiId)      -> normal, no action
//   - group size 1, diverged (key != apiId)    -> promote (rename to api id)
//   - group size 2+                            -> MERGE (keep most complete, audit)
// A merge is FLAGGED when the source records disagree (game count or name),
// i.e. the ones most likely to be wrong and worth a re-fetch.

'use strict';

const fs = require('fs');
const path = require('path');
const { isFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const SCAN_DIR = path.join(ROOT, 'reports', 'rekey-plan-scan');
const MERGES_FILE = path.join(ROOT, 'reports', 'rekey-merges.json');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

function gamesCount(p) { return Array.isArray(p.games) ? p.games.length : 0; }
// Same normalization 3b will use — NFKC + curly->straight quotes (see docs B2).
function normName(s) {
  return String(s || '').normalize('NFKC').replace(/[\u2018\u2019]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim();
}

function scan(bucket) {
  const dir = path.join(PLAYERS_DIR, bucket);
  const out = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const key = f.slice(0, -5);
      if (!isFullUuid(key)) continue;
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const apiId = (typeof p.apiId === 'string' && p.apiId) ? p.apiId : key;
      out.push({ key, apiId, name: p.name || '', games: gamesCount(p), size: JSON.stringify(p).length, diverged: apiId !== key });
    }
  }
  fs.mkdirSync(SCAN_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCAN_DIR, bucket + '.json'), JSON.stringify(out));
  process.stderr.write(`scan ${bucket}: ${out.length} files\n`);
}

function plan() {
  const groups = new Map(); // apiId -> [summary,...]
  for (const f of fs.readdirSync(SCAN_DIR).filter(f => f.endsWith('.json'))) {
    for (const rec of JSON.parse(fs.readFileSync(path.join(SCAN_DIR, f), 'utf8'))) {
      let g = groups.get(rec.apiId);
      if (!g) { g = []; groups.set(rec.apiId, g); }
      g.push(rec);
    }
  }

  let people = 0, normal = 0, promote = 0, merge = 0, flagged = 0;
  const merges = [];
  for (const [apiId, recs] of groups) {
    people++;
    if (recs.length === 1) {
      if (recs[0].diverged) promote++; else normal++;
      continue;
    }
    // keeper = most games; tie-break: prefer the direct (api-keyed) record; then larger.
    recs.sort((a, b) => (b.games - a.games) || ((a.key === apiId ? -1 : 0) - (b.key === apiId ? -1 : 0)) || (b.size - a.size));
    const keep = recs[0], drop = recs.slice(1);
    const gamesMatch = recs.every(r => r.games === keep.games);
    const namesMatch = recs.every(r => normName(r.name) === normName(keep.name));
    const isFlagged = !gamesMatch || !namesMatch;
    merge++;
    if (isFlagged) flagged++;
    merges.push({
      apiId,
      keep: { key: keep.key, games: keep.games, name: keep.name },
      drop: drop.map(d => ({ key: d.key, games: d.games, name: d.name })),
      gamesMatch, namesMatch, flagged: isFlagged,
    });
  }

  merges.sort((a, b) => (b.flagged - a.flagged)); // flagged first for easy review
  fs.mkdirSync(path.dirname(MERGES_FILE), { recursive: true });
  fs.writeFileSync(MERGES_FILE, JSON.stringify(merges, null, 2));
  const eliminated = merges.reduce((n, m) => n + m.drop.length, 0);

  const md = [
    '## 3b-2 plan (READ-ONLY — no files changed)',
    '',
    '| metric | value |',
    '|---|---|',
    `| distinct people (api ids) | ${people} |`,
    `| normal (api-keyed, single file) | ${normal} |`,
    `| promote (diverged, no existing api file) | ${promote} |`,
    `| merge (2+ files for one person) | ${merge} |`,
    `| — flagged (game count or name differ) | ${flagged} |`,
    `| files eliminated by merges | ${eliminated} |`,
  ];
  const ex = merges.filter(m => m.flagged).slice(0, 10);
  if (ex.length) {
    md.push('', 'Flagged merges (review — likely need a re-fetch):',
      ...ex.map(m => `- \`${m.apiId}\`: keep ${m.keep.games}g "${m.keep.name}" — drop ` +
        m.drop.map(d => `${d.games}g "${d.name}"`).join(', ')));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n'); } catch (e) { /* non-fatal */ }
  }
  process.stderr.write(`\nPLAN. people=${people} normal=${normal} promote=${promote} merge=${merge} flagged=${flagged} eliminated=${eliminated}\n`);
}

if (has('--scan')) {
  const b = val('--bucket', null);
  if (!b) { process.stderr.write('need --bucket XX\n'); process.exit(1); }
  scan(b.toLowerCase());
} else if (has('--plan')) {
  plan();
} else {
  process.stderr.write('use: --scan --bucket XX   |   --plan\n');
  process.exit(1);
}
