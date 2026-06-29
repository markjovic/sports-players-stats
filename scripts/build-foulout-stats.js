// scripts/build-foulout-stats.js
//
// Fetches publicProfileStatistics for all public players and counts foul-outs
// (games where PERSONAL_FOUL >= 5) from the per-game statistics returned by
// the PlayHQ API. This covers ALL games for ALL public players — not limited
// to games with stored box scores.
//
// Writes to each player file:
//   reg.stats.foulOuts          — foul-outs in that season (all regs in season get same total)
//   player.sports.Basketball.foulOuts — career foul-outs
//
// threePtPG and foulsPG are computed on the fly in build-leaderboards.js
// from reg.stats.threePt and reg.stats.fouls — no separate fetch needed.
//
// After this runs: node scripts/build-leaderboards.js --force
//
// Run:     node scripts/build-foulout-stats.js
// Dry run: node scripts/build-foulout-stats.js --dry-run
// Resume:  node scripts/build-foulout-stats.js  (progress saved every interval)

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT               = path.join(__dirname, '..');
const DRY_RUN            = process.argv.includes('--dry-run');
const FOUL_THRESHOLD     = 5;
const CONCURRENCY        = 20;
const BATCH_DELAY_MS     = 300;
const COMMIT_INTERVAL    = 2000;
const PROGRESS_FILE      = path.join(ROOT, 'scripts', '.foulout-progress.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

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

const HEADERS_API = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── Session ──────────────────────────────────────────────────────────────────

let _sessionCookie = null;
async function getSession() {
  if (_sessionCookie) return _sessionCookie;
  console.log('  Fetching session cookie...');
  const cookieQueries = [
    { operationName: 'TenantConfig', variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }' },
    { operationName: 'ProfileSearch', variables: { fullName: 'a' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
  ];
  let raw = null;
  for (let attempt = 1; attempt <= 5 && !raw; attempt++) {
    if (attempt > 1) await delay(attempt * 3000);
    for (const body of cookieQueries) {
      const res = await fetch('https://api.playhq.com/graphql', {
        method: 'POST',
        headers: { ...HEADERS_API, 'request-id': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      raw = res.headers.get('set-cookie');
      if (raw) break;
    }
  }
  if (!raw) throw new Error('No Set-Cookie after 5 attempts');
  const session = raw.match(/phq_session=([^;]+)/)[1];
  _sessionCookie = `phq_session=${session}`;
  console.log('  ✓ Session cookie obtained');
  return _sessionCookie;
}

// ─── Query ────────────────────────────────────────────────────────────────────

const Q_PROFILE = `
query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      statistics {
        season { id }
        teamStatistics {
          gradeStatistics {
            gameStatistics {
              statistics { count details { value } }
            }
          }
        }
      }
    }
  }
}`;

async function fetchFoulOuts(uuid, cookie) {
  const res = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS_API, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
    body: JSON.stringify({
      operationName: 'ProfileSeasonStatistics',
      variables: { profileID: uuid },
      query: Q_PROFILE,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.errors) return null;

  const profile = data?.data?.publicProfileStatistics;
  if (!profile) return null;

  // Count foul-outs per season ID
  const foulOutsBySid = {}; // sid → foulOut count

  for (const sEntry of (profile.seasonStatistics || [])) {
    for (const tEntry of (sEntry.statistics || [])) {
      const sid = tEntry.season?.id;
      if (!sid) continue;

      for (const team of (tEntry.teamStatistics || [])) {
        for (const grade of (team.gradeStatistics || [])) {
          for (const gameStat of (grade.gameStatistics || [])) {
            // Sum PERSONAL_FOUL across all stat entries for this game
            let gameFouls = 0;
            for (const stat of (gameStat.statistics || [])) {
              for (const detail of (stat.details || [])) {
                if (detail.value === 'PERSONAL_FOUL') gameFouls += stat.count ?? 0;
              }
            }
            if (gameFouls >= FOUL_THRESHOLD) {
              foulOutsBySid[sid] = (foulOutsBySid[sid] || 0) + 1;
            }
          }
        }
      }
    }
  }

  return foulOutsBySid;
}

// ─── Step 1: collect public UUIDs ─────────────────────────────────────────────

console.log('── Step 1: Collecting public player UUIDs ──────────────────────────');
const indexDir = path.join(ROOT, 'players', 'indexes');
const allUUIDs = new Set();

for (const fname of fs.readdirSync(indexDir).filter(f => f.endsWith('.json'))) {
  try {
    const shard = readJson(path.join(indexDir, fname));
    for (const uuid of Object.keys(shard)) allUUIDs.add(uuid);
  } catch {}
}
console.log(`  ${allUUIDs.size} public players found`);

// Load progress
let progress = { done: [], foulOutMap: {} };
if (fs.existsSync(PROGRESS_FILE)) {
  try { progress = readJson(PROGRESS_FILE); } catch {}
}
const done = new Set(progress.done || []);
const foulOutMap = progress.foulOutMap || {}; // uuid → {sid → count}

const toFetch = [...allUUIDs].filter(u => !done.has(u));
console.log(`  ${done.size} already done, ${toFetch.length} remaining`);

// ─── Step 2: fetch profiles ───────────────────────────────────────────────────

console.log('\n── Step 2: Fetching per-game foul data from PlayHQ ─────────────────');

let fetched = 0;
let withFoulOuts = 0;
let nulls = 0;
let sinceLastCommit = 0;

const cookie = await getSession();

for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
  const batch = toFetch.slice(i, i + CONCURRENCY);

  await Promise.all(batch.map(async uuid => {
    const result = await fetchFoulOuts(uuid, cookie);
    if (result === null) {
      nulls++;
    } else {
      const hasFoulOuts = Object.values(result).some(v => v > 0);
      if (hasFoulOuts) {
        foulOutMap[uuid] = result;
        withFoulOuts++;
      }
    }
    done.add(uuid);
  }));

  fetched += batch.length;
  sinceLastCommit += batch.length;

  if (fetched % 2500 === 0 || i + CONCURRENCY >= toFetch.length) {
    console.log(`  ${fetched}/${toFetch.length} fetched — ${withFoulOuts} players with foul-outs, ${nulls} nulls`);
  }

  if (sinceLastCommit >= 2500 && !DRY_RUN) {
    writeJson(PROGRESS_FILE, { done: [...done], foulOutMap });
    gitCommit(
      `build-foulout-stats: ${fetched}/${toFetch.length} fetched, ${withFoulOuts} players with foul-outs`,
      ['scripts/.foulout-progress.json']
    );
    sinceLastCommit = 0;
  }

  if (i + CONCURRENCY < toFetch.length) await delay(BATCH_DELAY_MS);
}

// Save final fetch progress
if (!DRY_RUN) {
  writeJson(PROGRESS_FILE, { done: [...done], foulOutMap, fetchComplete: true });
}

console.log(`\n  Fetch complete: ${withFoulOuts} players have at least one foul-out`);

// ─── Step 3: write foulOuts to player files ───────────────────────────────────

console.log('\n── Step 3: Writing foulOuts to player files ────────────────────────');
console.log(`  ${Object.keys(foulOutMap).length} player files to update`);

const playersDir = path.join(ROOT, 'players');
let playersUpdated = 0;
let playersSkipped = 0;
sinceLastCommit = 0;

for (const [uuid, sidMap] of Object.entries(foulOutMap)) {
  const prefix     = uuid.slice(0, 2);
  const playerPath = path.join(playersDir, prefix, `${uuid}.json`);

  let player;
  try { player = readJson(playerPath); } catch { playersSkipped++; continue; }

  let modified = false;

  const careerFoulOuts = Object.values(sidMap).reduce((a, b) => a + b, 0);
  const bball = player.sports?.Basketball;
  if (bball && (bball.foulOuts ?? -1) !== careerFoulOuts) {
    bball.foulOuts = careerFoulOuts;
    modified = true;
  }

  for (const season of (player.seasons || [])) {
    const sid     = season.sid;
    const foCount = sidMap[sid] ?? 0;
    for (const reg of (season.regs || [])) {
      if (!reg.stats) reg.stats = {};
      // Only write non-zero foulOuts — omit zeros to save space
      if (foCount > 0) {
        if ((reg.stats.foulOuts ?? 0) !== foCount) { reg.stats.foulOuts = foCount; modified = true; }
      } else if (reg.stats.foulOuts !== undefined) {
        delete reg.stats.foulOuts; modified = true;
      }
    }
  }

  if (!modified) { playersSkipped++; continue; }

  if (!DRY_RUN) writeJson(playerPath, player);
  playersUpdated++;
  sinceLastCommit++;

  if (sinceLastCommit >= COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      gitCommit(`build-foulout-stats: ${playersUpdated} player files updated`, ['players/']);
    }
    sinceLastCommit = 0;
    console.log(`  ${playersUpdated} players updated...`);
  }
}

if (!DRY_RUN && sinceLastCommit > 0) {
  gitCommit(`build-foulout-stats: complete — ${playersUpdated} player files updated`, ['players/']);
}

if (!DRY_RUN && fs.existsSync(PROGRESS_FILE)) {
  fs.unlinkSync(PROGRESS_FILE);
  gitCommit('build-foulout-stats: remove progress file', ['scripts/.foulout-progress.json']);
}

console.log('\n─── Summary ─────────────────────────────────────────────────────────');
console.log(`  Public players fetched       : ${fetched}`);
console.log(`  Players with foul-outs       : ${withFoulOuts}`);
console.log(`  Null/private profiles        : ${nulls}`);
console.log(`  Player files updated         : ${playersUpdated}`);
console.log(`  Player files skipped         : ${playersSkipped}`);
console.log(`  Mode                         : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
console.log('\nNext step: node scripts/build-leaderboards.js --force');
