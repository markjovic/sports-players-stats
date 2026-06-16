// scripts/reaudit-game-grades.js
//
// Re-fetches the grade name (gn) for game entries from the PlayHQ discoverGame API.
// Fixes cases where augment-game-grades.js assigned the team's final registration grade
// rather than the grade the specific game was actually played in (regraded teams).
//
// For each game entry in games/bv/{sid}.json:
//   - If the game has a PlayHQ game ID (the games/ key), call discoverGame(id)
//   - Use the returned grade.name as the authoritative gn
//   - Update gid from grade.id if it differs from stored gid
//
// Scope flags:
//   --active-only   Process only active seasons (locked: false) — fastest, covers regraded cases
//   --all           Process all 2,247,971 games across all seasons (long crawl)
//   (default)       Same as --active-only
//
// Progress: committed every 50 season files. Resume supported via progress file.
// Rate limiting: 200ms between API calls to avoid hammering PlayHQ.
//
// Run: node scripts/reaudit-game-grades.js
//      node scripts/reaudit-game-grades.js --all
//      node scripts/reaudit-game-grades.js --dry-run

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT          = path.join(__dirname, '..');
const DRY_RUN       = process.argv.includes('--dry-run');
const ALL_SEASONS   = process.argv.includes('--all');
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.reaudit-game-grades-progress.json');
const COMMIT_INTERVAL = 50;   // season files
const RATE_LIMIT_MS   = 200;  // ms between API calls

const PLAYHQ_API = 'https://api.playhq.com/graphql';
const HEADERS = {
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'origin':       'https://www.playhq.com',
  'content-type': 'application/json',
  'request-id':   '', // set per request
};

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
}

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── PlayHQ API call ─────────────────────────────────────────────────────────

function fetchDiscoverGame(gameId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      operationName: 'DiscoverGame',
      variables: { id: gameId },
      query: `query DiscoverGame($id: ID!) {
        discoverGame(id: $id) {
          grade { id name }
        }
      }`,
    });

    const reqHeaders = {
      ...HEADERS,
      'request-id': require('crypto').randomUUID(),
      'content-length': Buffer.byteLength(body).toString(),
    };

    const options = {
      hostname: 'api.playhq.com',
      path:     '/graphql',
      method:   'POST',
      headers:  reqHeaders,
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const grade = json?.data?.discoverGame?.grade;
          resolve(grade || null); // null if game not found or no grade
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── load sports-index ───────────────────────────────────────────────────────

console.log(`Mode: ${ALL_SEASONS ? 'ALL SEASONS' : 'ACTIVE ONLY'}${DRY_RUN ? ' + DRY RUN' : ''}`);
console.log('Loading sports-index.json...');
const sportsIndex = readJson(path.join(ROOT, 'sports-index.json'));

const activeSids = new Set(
  Object.values(sportsIndex.seasons)
    .filter(s => !s.locked)
    .map(s => s.id)
);
console.log(`  ${Object.keys(sportsIndex.seasons).length} total seasons, ${activeSids.size} active`);

// ─── load progress ───────────────────────────────────────────────────────────

let doneSids = new Set();
if (fs.existsSync(PROGRESS_FILE)) {
  const raw = readJson(PROGRESS_FILE);
  doneSids = new Set(raw.done || []);
  console.log(`Resuming — ${doneSids.size} season files already done`);
}

function saveProgress() {
  writeJson(PROGRESS_FILE, { done: [...doneSids] });
}

// ─── main loop ───────────────────────────────────────────────────────────────

const gamesDir  = path.join(ROOT, 'games', 'bv');
const gameFiles = fs.readdirSync(gamesDir)
  .filter(f => f.endsWith('.json'))
  .filter(f => ALL_SEASONS || activeSids.has(f.replace('.json', '')))
  .sort();

console.log(`\nProcessing ${gameFiles.length} season files...`);

let filesProcessed  = 0;
let gamesUpdated    = 0;
let gamesUnchanged  = 0;
let gamesNotFound   = 0;
let gamesErrored    = 0;
let sinceLastCommit = 0;

async function main() {
  for (const fname of gameFiles) {
    const sid = fname.replace('.json', '');

    if (doneSids.has(sid)) { continue; }

    let gf;
    try { gf = readJson(path.join(gamesDir, fname)); } catch { continue; }

    let fileModified = false;

    for (const [gameId, g] of Object.entries(gf.games || {})) {
      // Skip games with no gid (unresolvable) or profileOnly/forfeit/bye (no discoverGame entry)
      if (g.profileOnly || g.forfeit || g.bye || g.cancelled || g.abandoned) continue;

      let grade;
      try {
        grade = await fetchDiscoverGame(gameId);
        await sleep(RATE_LIMIT_MS);
      } catch (err) {
        gamesErrored++;
        continue;
      }

      if (!grade) {
        gamesNotFound++;
        continue;
      }

      const gnChanged  = grade.name && grade.name !== g.gn;
      const gidChanged = grade.id   && grade.id   !== g.gid;

      if (gnChanged || gidChanged) {
        if (grade.name) g.gn  = grade.name;
        if (grade.id)   g.gid = grade.id;
        gamesUpdated++;
        fileModified = true;
      } else {
        gamesUnchanged++;
      }
    }

    if (fileModified && !DRY_RUN) {
      writeJson(path.join(gamesDir, fname), gf);
    }

    doneSids.add(sid);
    filesProcessed++;
    sinceLastCommit++;

    if (sinceLastCommit >= COMMIT_INTERVAL) {
      if (!DRY_RUN) {
        saveProgress();
        gitCommit(
          `reaudit-game-grades: ${filesProcessed} season files done, ${gamesUpdated} grades corrected`,
          ['games/bv/', 'scripts/.reaudit-game-grades-progress.json']
        );
      }
      sinceLastCommit = 0;
      console.log(`  progress: ${filesProcessed} files, ${gamesUpdated} updated, ${gamesNotFound} not found, ${gamesErrored} errors`);
    }
  }

  // final commit
  if (!DRY_RUN && sinceLastCommit > 0) {
    saveProgress();
    gitCommit(
      `reaudit-game-grades: complete — ${filesProcessed} files, ${gamesUpdated} grades corrected`,
      ['games/bv/', 'scripts/.reaudit-game-grades-progress.json']
    );
  }

  console.log('\n─── Summary ────────────────────────────────────────────────');
  console.log(`  Season files processed : ${filesProcessed}`);
  console.log(`  Games grade updated    : ${gamesUpdated}`);
  console.log(`  Games unchanged        : ${gamesUnchanged}`);
  console.log(`  Games not found        : ${gamesNotFound}`);
  console.log(`  Games errored          : ${gamesErrored}`);
  console.log(`  Mode                   : ${ALL_SEASONS ? 'ALL' : 'ACTIVE ONLY'}${DRY_RUN ? ' + DRY RUN' : ''}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
