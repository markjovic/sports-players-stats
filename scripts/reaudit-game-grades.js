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
const CONCURRENCY = parseInt(_args.concurrency || '10', 10);

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
      name
      statistics {
        season { id name }
        club { id name }
        totalStatistics { count details { value } }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          gradeStatistics {
            grade { id name }
            totalStatistics { count details { value } }
            gameStatistics {
              game {
                id
                round { name }
                date
                home { ... on DiscoverTeam { id name } }
                away { ... on DiscoverTeam { id name } }
              }
              statistics { count details { value } }
            }
          }
        }
      }
    }
  }
  publicProfile(profileID: $profileID) {
    id firstName lastName
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

// Session cookie — promise-based lock ensures only one fetch happens even with
// 20 concurrent callers. All concurrent getSession() calls await the same promise.
let _sessionPromise = null;

async function getSession() {
  if (!_sessionPromise) {
    _sessionPromise = (async () => {
      console.log('  Fetching session cookie...');
      for (let attempt = 1; attempt <= 5; attempt++) {
        const res = await fetch(PLAYHQ_API, {
          method:  'POST',
          headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() },
          body: JSON.stringify({
            operationName: 'TenantConfig',
            variables:     {},
            query:         'query TenantConfig { tenantConfiguration { label } }',
          }),
        });
        const raw = res.headers.get('set-cookie');
        console.log(`  Cookie attempt ${attempt}: HTTP ${res.status}, Set-Cookie: ${raw ? raw.slice(0, 80) : 'null'}`);
        if (raw) {
          const cookie = raw.split(';')[0];
          console.log(`  ✓ Session cookie obtained`);
          return cookie;
        }
        await delay(attempt * 2000);
      }
      console.warn('  ⚠ Could not obtain session cookie after 5 attempts');
      return null;
    })();
  }
  return _sessionPromise;
}

async function fetchProfile(uuid) {
  const cookie = await getSession();
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      const headers = { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() };
      if (cookie) headers['cookie'] = cookie;
      res = await fetch(PLAYHQ_API, {
        method:  'POST',
        headers,
        body:    JSON.stringify({
          operationName: 'publicProfileStatistics',
          variables:     { profileID: uuid },
          query:         Q_PROFILE,
        }),
      });
    } catch (e) {
      console.warn(`  fetch error for ${uuid}: ${e.message}`);
      if (attempt === 3) return null;
      await delay(2000);
      continue;
    }

    // Log first 5 responses and any unexpected statuses in detail
    if (fetchProfile._logCount < 5 || res.status !== 200) {
      console.log(`  [${uuid.slice(0,8)}] HTTP ${res.status} Set-Cookie: ${res.headers.get('set-cookie') ? 'yes' : 'no'}`);
      fetchProfile._logCount++;
    }

    if (res.status === 429) { await delay(attempt * 5000); continue; }
    if (!res.ok) {
      console.warn(`  HTTP ${res.status} for ${uuid}`);
      return null;
    }

    let json;
    try { json = await res.json(); }
    catch (e) {
      // Non-JSON response (Cloudflare challenge etc) — log first occurrence
      if (!fetchProfile._nonJsonLogged) {
        const text = await res.text().catch(() => '(unreadable)');
        console.warn(`  Non-JSON response for ${uuid}: ${text.slice(0, 200)}`);
        fetchProfile._nonJsonLogged = true;
      }
      if (attempt === 3) return null;
      await delay(2000);
      continue;
    }

    // GraphQL errors — NOT_FOUND is permanent (deleted profile), others may be transient
    if (json.errors) {
      const isNotFound = json.errors.some(e => e.message?.includes('NOT_FOUND') || e.message?.includes('failed to find profile'));
      if (isNotFound) {
        fetchProfile._notFoundCount = (fetchProfile._notFoundCount || 0) + 1;
        return null; // permanent — don't retry
      }
      if ((fetchProfile._errorCount || 0) < 3) {
        console.warn(`  GraphQL errors for ${uuid}: ${JSON.stringify(json.errors).slice(0, 200)}`);
        fetchProfile._errorCount = (fetchProfile._errorCount || 0) + 1;
      }
      if (attempt < 3) { await delay(2000); continue; }
      return null;
    }
    if (!json?.data?.publicProfileStatistics) {
      if ((fetchProfile._nullCount || 0) < 3) {
        console.warn(`  null publicProfileStatistics for ${uuid} — data: ${JSON.stringify(json?.data).slice(0, 200)}`);
        fetchProfile._nullCount = (fetchProfile._nullCount || 0) + 1;
      }
      return null;
    }

    // If publicProfile is null the profile is private — stats will also be null
    if (!json.data.publicProfile) return null;
    return json.data.publicProfileStatistics;
  }
  return null;
}
fetchProfile._logCount      = 0;
fetchProfile._nonJsonLogged = false;
fetchProfile._errorCount    = 0;
fetchProfile._nullCount     = 0;

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

    let consecutiveNullBatches = 0;
    const BATCH_DELAY_MS = 500; // ms between batches — prevents silent rate limiting

    for (let i = 0; i < uuidsToFetch.length; i += CONCURRENCY) {
      const batch   = uuidsToFetch.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(uuid => fetchProfile(uuid)));

      let batchNulls = 0;
      for (let j = 0; j < batch.length; j++) {
        const uuid   = batch[j];
        const result = results[j];
        fetched++;

        if (!result) { nulls++; batchNulls++; phase2Done.add(uuid); continue; }

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

      // Detect silent rate limiting — all nulls in a batch despite prior successes
      if (batchNulls === batch.length) {
        consecutiveNullBatches++;
        if (consecutiveNullBatches >= 3 && mapped > 0) {
          console.warn(`  ⚠ ${consecutiveNullBatches} consecutive all-null batches — backing off 10s`);
          await delay(10000);
          consecutiveNullBatches = 0;
        }
      } else {
        consecutiveNullBatches = 0;
      }

      if (!DRY_RUN) {
        writeJson(PHASE2_PROGRESS, { done: [...phase2Done] });
        writeJson(GRADE_MAP_FILE, gradeMap);
      }

      if (fetched % 500 === 0 || i + CONCURRENCY >= uuidsToFetch.length) {
        const notFound = fetchProfile._notFoundCount || 0;
        console.log(`  ${fetched}/${uuidsToFetch.length} fetched — ${mapped} game→grade mappings, ${nulls} nulls (${notFound} not found)`);
      }

      // Inter-batch delay — prevents PlayHQ silent rate limiting
      if (i + CONCURRENCY < uuidsToFetch.length) await delay(BATCH_DELAY_MS);
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
