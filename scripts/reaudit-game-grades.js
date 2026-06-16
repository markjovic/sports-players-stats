// scripts/reaudit-game-grades.js
//
// Fixes gn/gid on game entries for regraded teams.
//
// Problem: augment-game-grades.js assigned a team's final registration grade
// to all its games. Teams regraded mid-season had early games incorrectly
// labelled with the final grade rather than the grade they were played in.
//
// Strategy:
//   Phase 1: scan player detail files — collect one UUID per (sid, tid) pair
//            where that season has regs.length > 1 (multiple grades in same season).
//   Phase 2: re-fetch publicProfileStatistics for collected UUIDs with concurrency.
//            Extract gameId → {gid, gn} from gradeStatistics.gameStatistics.
//            Save grade map to disk so phase 3 can resume independently.
//   Phase 3: scan games/bv/{sid}.json, update gn/gid for gameIds in the map.
//
// Makes O(players with multi-reg seasons) API calls — not O(games).
//
// Run: node scripts/reaudit-game-grades.js [--concurrency=20] [--dry-run]
// Resume: re-run — all three phases track progress independently via progress files.

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const _args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);
const CONCURRENCY = parseInt(_args.concurrency || '20', 10);

const PHASE2_PROGRESS = path.join(ROOT, 'scripts', '.reaudit-phase2-progress.json');
const PHASE3_PROGRESS = path.join(ROOT, 'scripts', '.reaudit-phase3-progress.json');
const GRADE_MAP_FILE  = path.join(ROOT, 'scripts', '.reaudit-grade-map.json');
const COMMIT_INTERVAL = 100;

const PLAYHQ_API = 'https://api.playhq.com/graphql';
const MOBILE_HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

const Q_PROFILE = `
query publicProfileStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      statistics {
        season { id }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          gradeStatistics {
            grade { id name }
            gameStatistics {
              game { id }
            }
          }
        }
      }
    }
  }
}`;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data), 'utf8'); }

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

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchProfile(uuid) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(PLAYHQ_API, {
        method:  'POST',
        headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() },
        body:    JSON.stringify({
          operationName: 'publicProfileStatistics',
          variables:     { profileID: uuid },
          query:         Q_PROFILE,
        }),
      });
      if (res.status === 429) { await delay(attempt * 5000); continue; }
      if (!res.ok) return null;
      const json = await res.json();
      return json?.data?.publicProfileStatistics || null;
    } catch {
      if (attempt === 3) return null;
      await delay(2000);
    }
  }
  return null;
}

async function main() {

  // ─── Check if grade map already built from a previous run ──────────────────

  let gradeMap = null;
  if (fs.existsSync(GRADE_MAP_FILE)) {
    console.log('Grade map found from previous run — skipping phases 1 & 2');
    gradeMap = readJson(GRADE_MAP_FILE);
    console.log(`  ${Object.keys(gradeMap).length} game→grade mappings loaded`);
  }

  if (!gradeMap) {

    // ─── Phase 1: collect one UUID per team in multi-grade seasons ────────────
    //
    // Strategy: multi-grade seasons are the only ones where regrading can happen.
    // For each team in those seasons, collect one representative UUID from the
    // team-stats roster. One profile fetch per team gives all game→grade mappings
    // for that team regardless of whether the player themselves was regraded.

    console.log('Phase 1: collecting team representatives for multi-grade seasons...');

    let phase2Done = new Set();
    if (fs.existsSync(PHASE2_PROGRESS)) {
      phase2Done = new Set((readJson(PHASE2_PROGRESS).done || []));
    }

    // Load sports-index to find multi-grade seasons
    const sportsIndex = readJson(path.join(ROOT, 'sports-index.json'));
    const multiGradeSids = new Set(
      Object.values(sportsIndex.seasons)
        .filter(s => (s.grades || []).length > 1)
        .map(s => s.id)
    );
    console.log(`  ${multiGradeSids.size} multi-grade seasons`);

    // For each multi-grade season, collect one public player UUID per (sid, tid) pair.
    // MUST use players/indexes/ not team-stats rosters — team-stats includes private players
    // (99.6% of roster UUIDs return null from publicProfileStatistics).
    // players/indexes/ only contains confirmed public profiles.
    //
    // Strategy: scan all 256 player index shards, for each player check if any sid in
    // their history is a multi-grade season. Collect one UUID per (sid, tid) pair.

    const indexDir = path.join(ROOT, 'players', 'indexes');
    const indexFiles = fs.readdirSync(indexDir).filter(f => f.endsWith('.json')).sort();

    // sid::tid → uuid (first public player found on this team in this multi-grade season)
    const teamReps = new Map();
    let indexPlayersScanned = 0;

    for (const fname of indexFiles) {
      let shard;
      try { shard = readJson(path.join(indexDir, fname)); } catch { continue; }
      for (const [uuid, entry] of Object.entries(shard)) {
        const history = entry.history || {};
        for (const [sid, tids] of Object.entries(history)) {
          if (!multiGradeSids.has(sid)) continue;
          for (const tid of (tids || [])) {
            const key = `${sid}::${tid}`;
            if (!teamReps.has(key)) teamReps.set(key, uuid);
          }
        }
        indexPlayersScanned++;
      }
    }

    const uuidsToFetch = [...new Set(teamReps.values())]
      .filter(uuid => !phase2Done.has(uuid));

    console.log(`  ${indexPlayersScanned} public players scanned from indexes`);
    console.log(`  ${teamReps.size} (season, team) pairs in multi-grade seasons`);
    console.log(`  ${uuidsToFetch.length + phase2Done.size} unique public UUIDs (${phase2Done.size} already done)`);
    console.log(`  ${uuidsToFetch.length} remaining to fetch`);

    // ─── Phase 2: re-fetch profiles, build gameId→grade map ──────────────────

    console.log(`\nPhase 2: fetching ${uuidsToFetch.length} profiles (concurrency: ${CONCURRENCY})...`);

    gradeMap = {};
    if (fs.existsSync(GRADE_MAP_FILE)) {
      try { Object.assign(gradeMap, readJson(GRADE_MAP_FILE)); } catch {}
    }

    let fetched = 0;
    let nulls   = 0;
    let mapped  = 0;

    for (let i = 0; i < uuidsToFetch.length; i += CONCURRENCY) {
      const batch   = uuidsToFetch.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(uuid => fetchProfile(uuid)));

      for (let j = 0; j < batch.length; j++) {
        const uuid   = batch[j];
        const result = results[j];
        fetched++;

        if (!result) { nulls++; phase2Done.add(uuid); continue; }

        for (const sportSeason of (result.seasonStatistics || [])) {
          for (const reg of (sportSeason.statistics || [])) {
            for (const teamStat of (reg.teamStatistics || [])) {
              for (const gradeStat of (teamStat.gradeStatistics || [])) {
                const gid = gradeStat.grade?.id;
                const gn  = gradeStat.grade?.name;
                if (!gid || !gn) continue;
                for (const gs of (gradeStat.gameStatistics || [])) {
                  const gameId = gs.game?.id;
                  if (!gameId) continue;
                  if (!gradeMap[gameId]) {
                    gradeMap[gameId] = { gid, gn };
                    mapped++;
                  }
                }
              }
            }
          }
        }
        phase2Done.add(uuid);
      }

      if (!DRY_RUN) {
        writeJson(PHASE2_PROGRESS, { done: [...phase2Done] });
        writeJson(GRADE_MAP_FILE, gradeMap);
      }

      if (fetched % 500 === 0 || i + CONCURRENCY >= uuidsToFetch.length) {
        console.log(`  ${fetched}/${uuidsToFetch.length} fetched — ${mapped} game→grade mappings, ${nulls} nulls`);
      }
    }

    if (!DRY_RUN) writeJson(GRADE_MAP_FILE, gradeMap);
    console.log(`  Phase 2 complete: ${Object.keys(gradeMap).length} total game→grade mappings`);
  }

  // ─── Phase 3: update game entries ──────────────────────────────────────────

  console.log('\nPhase 3: updating game entries...');

  let phase3Done = new Set();
  if (fs.existsSync(PHASE3_PROGRESS)) {
    phase3Done = new Set((readJson(PHASE3_PROGRESS).done || []));
    console.log(`  Resuming — ${phase3Done.size} season files already done`);
  }

  const gamesDir  = path.join(ROOT, 'games', 'bv');
  const gameFiles = fs.readdirSync(gamesDir).filter(f => f.endsWith('.json')).sort();

  let filesProcessed  = 0;
  let filesSkipped    = 0;
  let gamesUpdated    = 0;
  let sinceLastCommit = 0;

  for (const fname of gameFiles) {
    const sid = fname.replace('.json', '');
    if (phase3Done.has(sid)) { filesSkipped++; continue; }

    let gf;
    try { gf = readJson(path.join(gamesDir, fname)); } catch { continue; }

    let modified = false;

    for (const [gameId, g] of Object.entries(gf.games || {})) {
      const mapping = gradeMap[gameId];
      if (!mapping) continue;
      if (g.gn === mapping.gn && g.gid === mapping.gid) continue;
      g.gn  = mapping.gn;
      g.gid = mapping.gid;
      gamesUpdated++;
      modified = true;
    }

    if (modified && !DRY_RUN) {
      writeJson(path.join(gamesDir, fname), gf);
    }

    phase3Done.add(sid);
    filesProcessed++;
    sinceLastCommit++;

    if (sinceLastCommit >= COMMIT_INTERVAL) {
      if (!DRY_RUN) {
        writeJson(PHASE3_PROGRESS, { done: [...phase3Done] });
        gitCommit(
          `reaudit-game-grades: ${filesProcessed} season files done, ${gamesUpdated} corrected`,
          ['games/bv/', 'scripts/.reaudit-phase3-progress.json']
        );
      }
      sinceLastCommit = 0;
      console.log(`  progress: ${filesProcessed} files, ${gamesUpdated} games corrected`);
    }
  }

  if (!DRY_RUN && sinceLastCommit > 0) {
    writeJson(PHASE3_PROGRESS, { done: [...phase3Done] });
    gitCommit(
      `reaudit-game-grades: complete — ${filesProcessed} files, ${gamesUpdated} games corrected`,
      ['games/bv/', 'scripts/.reaudit-phase3-progress.json']
    );
  }

  console.log('\n─── Summary ────────────────────────────────────────────────');
  console.log(`  Game→grade mappings      : ${Object.keys(gradeMap).length}`);
  console.log(`  Season files processed   : ${filesProcessed}`);
  console.log(`  Season files skipped     : ${filesSkipped}`);
  console.log(`  Games grade corrected    : ${gamesUpdated}`);
  console.log(`  Mode                     : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
