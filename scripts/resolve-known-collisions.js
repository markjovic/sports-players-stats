// scripts/resolve-known-collisions.js
//
// ONE-OFF: resolves the specific uuid prefixes that audit-uuid-collisions.js
// (at len=10) found to be genuinely ambiguous -- the ones
// fix-uuid-prefix-length.js deliberately left untouched rather than guess at.
//
// This does NOT do a general git-history recovery. It uses a narrower,
// verified-safe shortcut: for every known collision, the two candidate
// players were checked by hand and confirmed to have ZERO overlapping
// seasons (see each player's seasons[].sid / teams[].sid). Since
// games/bv/{sid}.json is one file per season, the FILE'S OWN sid already
// tells us unambiguously which of the two candidates any occurrence
// belongs to -- no guessing, no git archaeology needed, for these specific
// three:
//   029f01ee-5  Yasseen Mohamed (0552afa9)      vs  Daniel Liu (88026885)
//   b0d1fc12-8  Luke Barbieri (7 seasons)       vs  Richard Horton (6 seasons) -- disjoint
//   ddcbc93f-e  Heath Rowley (21 seasons)       vs  Zak Bhikoo (0a3885ab)      -- disjoint
//
// If a future collision does NOT have disjoint seasons between its two
// candidates, this script will correctly refuse to resolve it (both-match or
// neither-match cases are logged, not guessed) -- it only trusts sid
// disjointness, it doesn't assume it.
//
// Reads the collision list from reports/uuid-collisions-len10.json (written
// by audit-uuid-collisions.js --len=10) rather than hardcoding uuids, so this
// stays correct if that report is regenerated. Reads each candidate's own
// players/{shard}/{uuid}.json to build its sid set -- also not hardcoded.
//
// Run:     node scripts/resolve-known-collisions.js
// Dry run: node scripts/resolve-known-collisions.js --dry-run

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const GAMES_DIR    = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR  = path.join(ROOT, 'players');
const COLLISIONS_REPORT = path.join(ROOT, 'reports', 'uuid-collisions-len10.json');
const DRY_RUN      = process.argv.includes('--dry-run');

const OLD_LEN  = 10;
const NEW_LEN  = 13;
const FULL_LEN = 36;

function gitCommit(message, dirs) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  try {
    execSync(`git add ${dirs.join(' ')}`, { stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
    const staged = execSync('git diff --staged --shortstat',
      { stdio: 'pipe', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).toString().trim();
    if (!staged) { console.log('  Nothing to commit.'); return; }
    execSync(`git commit -q -m "${message}"`, { stdio: 'pipe', cwd: ROOT });
    execSync('git fetch origin main',                            { stdio: 'pipe', cwd: ROOT });
    execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', { stdio: 'pipe', cwd: ROOT });
    execSync('git push origin main',                             { stdio: 'pipe', cwd: ROOT });
    console.log(`  Committed: ${message}`);
  } catch (e) {
    console.error('  git error:', e.stderr?.toString().slice(0, 300) || e.message.slice(0, 300));
  }
}

function readPlayerSids(fullUuid) {
  const shard = fullUuid.slice(0, 2).toLowerCase();
  const fpath = path.join(PLAYERS_DIR, shard, `${fullUuid}.json`);
  const sids = new Set();
  try {
    const player = JSON.parse(fs.readFileSync(fpath, 'utf8'));
    for (const s of (player.seasons || [])) if (s.sid) sids.add(s.sid);
    for (const t of (player.teams  || [])) if (t.sid) sids.add(t.sid);
  } catch (e) {
    console.error(`  WARNING: could not read player file for ${fullUuid}: ${e.message}`);
  }
  return sids;
}

function main() {
  const start = Date.now();
  console.log('resolve-known-collisions.js');
  if (DRY_RUN) console.log('  DRY RUN — no writes or commits');
  console.log('-'.repeat(60));

  if (!fs.existsSync(COLLISIONS_REPORT)) {
    console.error(`  FAILED: ${COLLISIONS_REPORT} not found — run audit-uuid-collisions.js --len=10 first`);
    process.exit(1);
  }
  const collisions = JSON.parse(fs.readFileSync(COLLISIONS_REPORT, 'utf8'));
  if (collisions.len !== OLD_LEN) {
    console.error(`  FAILED: ${COLLISIONS_REPORT} was generated for len=${collisions.len}, expected ${OLD_LEN}`);
    process.exit(1);
  }

  // prefix -> [{ uuid, sids: Set }, { uuid, sids: Set }, ...]
  const prefixCandidates = new Map();
  for (const c of collisions.report) {
    const candidates = c.uuids.map(uuid => ({ uuid, sids: readPlayerSids(uuid) }));
    prefixCandidates.set(c.prefix, candidates);
    console.log(`  ${c.prefix}: ${candidates.map(x => `${x.uuid} (${x.sids.size} seasons)`).join('  vs  ')}`);
  }
  console.log(`\n  ${prefixCandidates.size} known collisions loaded from report\n`);

  let resolved = 0, ambiguous = 0, filesModified = 0;
  const ambiguousLog = [];

  const allSids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();

  for (const sid of allSids) {
    const fpath = path.join(GAMES_DIR, `${sid}.json`);
    let gf;
    try { gf = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
    catch { continue; }

    let changed = false;

    function tryResolveField(obj, field) {
      const v = obj[field];
      if (typeof v !== 'string' || v.length !== OLD_LEN) return;
      const candidates = prefixCandidates.get(v);
      if (!candidates) return; // not a known collision prefix — not this script's job
      const matches = candidates.filter(c => c.sids.has(sid));
      if (matches.length === 1) {
        obj[field] = matches[0].uuid.slice(0, NEW_LEN);
        resolved++;
        changed = true;
      } else {
        ambiguous++;
        ambiguousLog.push({ sid, prefix: v, matchCount: matches.length });
      }
    }

    for (const game of Object.values(gf.games || {})) {
      for (const p of (game.p || []))  tryResolveField(p, 'id');
      for (const p of (game.hp || [])) tryResolveField(p, 'profileID');
      for (const p of (game.ap || [])) tryResolveField(p, 'profileID');
    }

    if (changed) {
      if (!DRY_RUN) fs.writeFileSync(fpath, JSON.stringify(gf), 'utf8');
      filesModified++;
    }
  }

  if (!DRY_RUN) gitCommit(`resolve-known-collisions: ${resolved} occurrences resolved via disjoint-season matching, ${filesModified} files modified`, ['games/']);

  console.log('-'.repeat(60));
  console.log(`  Files modified : ${filesModified}`);
  console.log(`  Resolved       : ${resolved}`);
  console.log(`  Ambiguous      : ${ambiguous}${ambiguous ? ' — matched 0 or 2+ candidates, left untouched, see below' : ''}`);
  console.log(`  Elapsed        : ${Math.round((Date.now() - start) / 1000)}s`);
  if (ambiguousLog.length) {
    console.log('\n  Ambiguous occurrences (not resolved — needs git-history recovery):');
    for (const a of ambiguousLog.slice(0, 20)) console.log(`    sid=${a.sid} prefix=${a.prefix} matches=${a.matchCount}`);
    if (ambiguousLog.length > 20) console.log(`    ... and ${ambiguousLog.length - 20} more`);
  }
}

main();
