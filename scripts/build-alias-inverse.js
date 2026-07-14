// scripts/build-alias-inverse.js
//
// 3b-0 of the api-canonical migration. Inverts the alias index
//   players/aliases/{spectatorPrefix}.json   ( spectatorTrunc -> apiId )
// into
//   players/alias-inverse/{apiPrefix}.json   ( apiId -> [spectatorTrunc, ...] )
// sharded by API-id prefix. This is the driver for 3b-1 (enrich) and
// 3b-2 (relocate/merge): given an api id, it lists every spectator alias.
//
// Read-only over players/aliases (single runner, ~24 MB in memory). Commit is
// handled by the workflow. NO player files are touched.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALIASES_DIR = path.join(ROOT, 'players', 'aliases');
const INVERSE_DIR = path.join(ROOT, 'players', 'alias-inverse');
const DRY = process.argv.includes('--dry-run');

function main() {
  if (!fs.existsSync(ALIASES_DIR)) {
    process.stderr.write('No players/aliases/ — run build-alias-index first.\n');
    process.exit(1);
  }

  // apiPrefix -> Map(apiId -> Set(spectatorTrunc))
  const shards = new Map();
  let pairs = 0;
  for (const f of fs.readdirSync(ALIASES_DIR).filter(f => f.endsWith('.json'))) {
    const map = JSON.parse(fs.readFileSync(path.join(ALIASES_DIR, f), 'utf8'));
    for (const [spectatorTrunc, apiId] of Object.entries(map)) {
      pairs++;
      const p = apiId.slice(0, 2);
      let bucket = shards.get(p);
      if (!bucket) { bucket = new Map(); shards.set(p, bucket); }
      let set = bucket.get(apiId);
      if (!set) { set = new Set(); bucket.set(apiId, set); }
      set.add(spectatorTrunc);
    }
  }

  let apiIds = 0, multi = 0;
  if (!DRY) fs.mkdirSync(INVERSE_DIR, { recursive: true });
  for (const [p, bucket] of shards) {
    const out = {};
    for (const [apiId, set] of bucket) {
      apiIds++;
      if (set.size > 1) multi++;
      out[apiId] = [...set].sort();
    }
    const sorted = {};
    for (const k of Object.keys(out).sort()) sorted[k] = out[k];
    if (!DRY) fs.writeFileSync(path.join(INVERSE_DIR, p + '.json'), JSON.stringify(sorted));
  }

  const md = [
    `## alias-inverse build${DRY ? ' (dry run)' : ''}`,
    '',
    '| metric | value |',
    '|---|---|',
    `| input alias pairs | ${pairs} |`,
    `| distinct api ids | ${apiIds} |`,
    `| api ids with 2+ spectator ids | ${multi} |`,
    `| inverse shards written | ${shards.size} |`,
  ];
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n'); } catch (e) { /* non-fatal */ }
  }
  process.stderr.write(`\nDONE. aliasPairs=${pairs} apiIds=${apiIds} multi=${multi} shards=${shards.size}${DRY ? ' (dry-run)' : ''}\n`);
}

main();
