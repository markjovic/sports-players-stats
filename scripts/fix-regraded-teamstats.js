// scripts/fix-regraded-teamstats.js
//
// Fixes team-stats/bv/{sid}.json roster entries for players who were regraded
// mid-season but stayed on the same team (same tid). In those cases,
// aggregate-team-stats.js wrote only the LAST reg's stats, overwriting earlier
// regs. This script reads the correct accumulated stats from the player files
// (which are always correct) and patches team-stats accordingly.
//
// No API calls. Pure local data fix.
//
// How it works:
//   1. Scan all player detail files (one pass, ~25s)
//   2. For each player, find any season where two or more regs share the same tid
//   3. For those cases, sum all reg stats across matching tids
//   4. Load team-stats/bv/{sid}.json and update the roster entry with correct totals
//   5. Commit every COMMIT_INTERVAL modified season files
//
// Safe to re-run: if the entry already equals the correct sum, it is left unchanged.
//
// Run: node scripts/fix-regraded-teamstats.js
// Dry run: node scripts/fix-regraded-teamstats.js --dry-run

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT           = path.join(__dirname, '..');
const DRY_RUN        = process.argv.includes('--dry-run');
const COMMIT_INTERVAL = 100;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

function gitCommit(message, dirs) {
  try {
    execSync(`git add ${dirs.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ committed: ${message}`);
  } catch (e) {
    console.error(`  ✗ git error: ${e.message}`);
  }
}

const STAT_KEYS = ['gp', 'pts', 'fg', 'ft', 'threePt', 'fouls'];

function sumRegs(regs) {
  const out = {};
  for (const k of STAT_KEYS) out[k] = 0;
  for (const r of regs) {
    for (const k of STAT_KEYS) {
      out[k] += (r.stats?.[k] ?? 0);
    }
  }
  return out;
}

function statsEqual(a, b) {
  for (const k of STAT_KEYS) {
    if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  }
  return true;
}

// ─── Step 1: scan player files, build correction map ─────────────────────────
// corrections: Map<sid, Map<tid, Map<uuid, {name, correctStats}>>>

console.log('Scanning player files for same-tid multi-reg seasons...');
const playersDir = path.join(ROOT, 'players');
const prefixDirs = fs.readdirSync(playersDir)
  .filter(d => /^[0-9a-f]{2}$/.test(d)).sort();

const corrections = new Map(); // sid → Map<tid, Map<uuid, {name, stats}>>

let scanned = 0;
let affectedPlayers = 0;
let totalCorrectionPairs = 0; // (sid, tid, uuid) triples

for (const prefix of prefixDirs) {
  const prefixDir = path.join(playersDir, prefix);
  const files = fs.readdirSync(prefixDir).filter(f => f.endsWith('.json'));
  for (const fname of files) {
    let player;
    try { player = readJson(path.join(prefixDir, fname)); } catch { continue; }

    const uuid = player.uuid;
    const name = player.name || uuid;
    let playerAffected = false;

    for (const season of (player.seasons || [])) {
      const sid = season.sid;
      if (!sid) continue;

      // Group regs by tid
      const byTid = new Map();
      for (const reg of (season.regs || [])) {
        if (!reg.tid) continue;
        if (!byTid.has(reg.tid)) byTid.set(reg.tid, []);
        byTid.get(reg.tid).push(reg);
      }

      // Only care about tids with 2+ regs
      for (const [tid, regs] of byTid) {
        if (regs.length < 2) continue;

        const correct = sumRegs(regs);

        if (!corrections.has(sid)) corrections.set(sid, new Map());
        const sidMap = corrections.get(sid);
        if (!sidMap.has(tid)) sidMap.set(tid, new Map());
        sidMap.get(tid).set(uuid, { name, stats: correct });

        totalCorrectionPairs++;
        playerAffected = true;
      }
    }

    if (playerAffected) affectedPlayers++;
    scanned++;
    if (scanned % 50000 === 0) console.log(`  ${scanned} players scanned...`);
  }
}

console.log(`  ${scanned} players scanned`);
console.log(`  ${affectedPlayers} affected players`);
console.log(`  ${totalCorrectionPairs} (sid, tid, uuid) corrections to apply`);
console.log(`  ${corrections.size} season files to update`);

if (totalCorrectionPairs === 0) {
  console.log('\nNo corrections needed. Done.');
  process.exit(0);
}

// ─── Step 2: apply corrections to team-stats files ───────────────────────────

const teamStatsDir = path.join(ROOT, 'team-stats', 'bv');
let seasonsUpdated = 0;
let entriesUpdated = 0;
let entriesAlreadyCorrect = 0;
let entriesMissingFromTeamStats = 0;
let sinceLastCommit = 0;

for (const [sid, tidMap] of corrections) {
  const tsPath = path.join(teamStatsDir, `${sid}.json`);
  if (!fs.existsSync(tsPath)) {
    console.log(`  ⚠ team-stats file not found: ${sid}.json — skipping`);
    continue;
  }

  let tsData;
  try { tsData = readJson(tsPath); } catch (e) {
    console.log(`  ⚠ error reading ${sid}.json: ${e.message} — skipping`);
    continue;
  }

  let fileModified = false;

  for (const [tid, uuidMap] of tidMap) {
    const team = tsData[tid];
    if (!team) {
      console.log(`  ⚠ sid=${sid} tid=${tid} not found in team-stats — skipping`);
      continue;
    }
    if (!team.roster) team.roster = {};

    for (const [uuid, { name, stats }] of uuidMap) {
      const existing = team.roster[uuid];
      if (!existing) {
        entriesMissingFromTeamStats++;
        console.log(`  ⚠ ${name} (${uuid.slice(0,8)}) not in roster of tid=${tid.slice(0,8)} sid=${sid.slice(0,8)}`);
        continue;
      }

      if (statsEqual(existing, stats)) {
        entriesAlreadyCorrect++;
        continue;
      }

      // Apply correction — preserve name and number, replace stat fields
      for (const k of STAT_KEYS) {
        existing[k] = stats[k];
      }

      entriesUpdated++;
      fileModified = true;
    }
  }

  if (fileModified) {
    if (!DRY_RUN) writeJson(tsPath, tsData);
    seasonsUpdated++;
    sinceLastCommit++;

    if (sinceLastCommit >= COMMIT_INTERVAL) {
      if (!DRY_RUN) {
        gitCommit(
          `fix-regraded-teamstats: ${seasonsUpdated} seasons fixed, ${entriesUpdated} entries corrected`,
          ['team-stats/bv/']
        );
      }
      sinceLastCommit = 0;
      console.log(`  progress: ${seasonsUpdated} seasons, ${entriesUpdated} entries corrected`);
    }
  }
}

if (!DRY_RUN && sinceLastCommit > 0) {
  gitCommit(
    `fix-regraded-teamstats: complete — ${seasonsUpdated} seasons, ${entriesUpdated} entries corrected`,
    ['team-stats/bv/']
  );
}

console.log('\n─── Summary ─────────────────────────────────────────────────');
console.log(`  Players scanned              : ${scanned}`);
console.log(`  Affected players             : ${affectedPlayers}`);
console.log(`  Correction triples           : ${totalCorrectionPairs}`);
console.log(`  Season files updated         : ${seasonsUpdated}`);
console.log(`  Roster entries corrected     : ${entriesUpdated}`);
console.log(`  Entries already correct      : ${entriesAlreadyCorrect}`);
console.log(`  Entries missing from roster  : ${entriesMissingFromTeamStats}`);
console.log(`  Mode                         : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
