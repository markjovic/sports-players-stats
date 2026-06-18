// scripts/fix-game-boxscore.js
//
// Investigates and fixes box score data for a specific game.
//
// For each player stored in hp/ap for the given game, fetches their
// publicProfileStatistics from PlayHQ and extracts the per-game stats
// for that specific game ID. Compares with stored data. Optionally
// updates the stored hp/ap with the correct values.
//
// Also re-fetches from the spectator endpoint to compare what it returns now.
//
// Run: node scripts/fix-game-boxscore.js <gameId> [--fix] [--dry-run]
//
// Arguments:
//   <gameId>    Game key from games/bv/{sid}.json (e.g. 7cdd49b8)
//   --fix       Write corrected data back to the game file
//   --dry-run   Show comparison only, do not write

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT    = path.join(__dirname, '..');
const gameId  = process.argv[2];
const FIX     = process.argv.includes('--fix');
const DRY_RUN = process.argv.includes('--dry-run') || !FIX;

if (!gameId) {
  console.error('Usage: node scripts/fix-game-boxscore.js <gameId> [--fix] [--dry-run]');
  process.exit(1);
}

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

const HEADERS_API = {
  'accept':        '*/*',
  'origin':        'https://www.playhq.com',
  'user-agent':    'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':        'basketball-victoria',
  'content-type':  'application/json',
};

const HEADERS_SPECTATOR = {
  'accept':        '*/*',
  'origin':        'https://www.playhq.com',
  'user-agent':    'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':        'bv',
  'x-phq-tenant': 'bv',
  'content-type':  'application/json',
};

// ─── Session cookie ───────────────────────────────────────────────────────────

async function getSession() {
  const cookieQueries = [
    { operationName: 'TenantConfig', variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }' },
    { operationName: 'ProfileSearch', variables: { fullName: 'a' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
  ];
  let raw = null;
  for (let attempt = 1; attempt <= 5 && !raw; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, attempt * 3000));
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
  const payload = JSON.parse(Buffer.from(session.split('.')[1], 'base64').toString());
  const sub = payload.sub || payload.jti;
  console.log(`  ✓ Session cookie obtained`);
  return {
    sessionCookie: `phq_session=${session}`,
    allCookies:    `phq_session=${session}; phq_sub=${sub}; phq_tier=cookie-no-jwt`,
  };
}

// ─── Stat type mapping ────────────────────────────────────────────────────────
// Maps PlayHQ stat type values to stored field names

function statTypeToField(typeValue) {
  switch (typeValue) {
    case 'FREE_THROW':
    case 'ONE_POINT_FIELD_GOAL': return 'pt1';
    case 'FIELD_GOAL':
    case 'TWO_POINT_FIELD_GOAL': return 'pt2';
    case 'THREE_POINT_FIELD_GOAL': return 'pt3';
    case 'PERSONAL_FOUL': return 'fouls';
    case 'TOTAL_SCORE':
    case 'POINTS': return 'pts_direct';
    default: return null;
  }
}

// ─── publicProfileStatistics query ───────────────────────────────────────────

const Q_PROFILE = `
query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      statistics {
        season { id }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          gradeStatistics {
            grade { id name }
            gameStatistics {
              game {
                id
                round { name isFinalsRound }
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
}`;

// ─── spectator game(id) query ─────────────────────────────────────────────────

const Q_SPECTATOR = `
query game($id: ID!) {
  game(id: $id) {
    id status updatedAt
    statistics {
      home {
        players {
          id profileID name playerNumber
          statistics { type { value } count }
        }
      }
      away {
        players {
          id profileID name playerNumber
          statistics { type { value } count }
        }
      }
    }
  }
}`;

async function fetchProfile(uuid, sessionCookie) {
  const res = await fetch('https://api.playhq.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS_API, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
    body: JSON.stringify({ operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: Q_PROFILE }),
  });
  const data = await res.json();
  return data?.data?.publicProfileStatistics;
}

async function fetchSpectator(gid, allCookies) {
  const res = await fetch('https://spectator.playhq.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS_SPECTATOR, 'request-id': crypto.randomUUID(), 'Cookie': allCookies },
    body: JSON.stringify({ operationName: 'game', variables: { id: gid }, query: Q_SPECTATOR }),
  });
  const data = await res.json();
  return data?.data?.game;
}

// Extract per-game stats for a specific game ID from publicProfileStatistics
function extractGameStats(profileData, targetGameId) {
  if (!profileData) return null;
  for (const sEntry of (profileData.seasonStatistics || [])) {
    for (const tEntry of (sEntry.statistics || [])) {
      for (const team of (tEntry.teamStatistics || [])) {
        for (const grade of (team.gradeStatistics || [])) {
          for (const gameStat of (grade.gameStatistics || [])) {
            if (gameStat.game?.id !== targetGameId) continue;
            // Found — parse stats
            const out = { pt1: 0, pt2: 0, pt3: 0, fouls: 0, pts: 0, rawTypes: {} };
            for (const stat of (gameStat.statistics || [])) {
              const count = stat.count ?? 0;
              for (const detail of (stat.details || [])) {
                const field = statTypeToField(detail.value);
                out.rawTypes[detail.value] = (out.rawTypes[detail.value] || 0) + count;
                if (field && field !== 'pts_direct') out[field] = (out[field] || 0) + count;
                if (field === 'pts_direct') out.pts = count;
              }
            }
            // Compute pts from components if not directly available
            if (out.pts === 0) out.pts = out.pt1 + out.pt2 * 2 + out.pt3 * 3;
            return out;
          }
        }
      }
    }
  }
  return null; // game not found in profile
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  // Find the game in the games directory
  console.log(`\nSearching for game ${gameId}...`);
  const gamesDir = path.join(ROOT, 'games', 'bv');
  let foundSid = null, foundGame = null, foundFile = null;

  for (const fname of fs.readdirSync(gamesDir).filter(f => f.endsWith('.json'))) {
    let gf;
    try { gf = readJson(path.join(gamesDir, fname)); } catch { continue; }
    if (gf.games?.[gameId]) {
      foundSid  = fname.replace('.json', '');
      foundGame = gf.games[gameId];
      foundFile = path.join(gamesDir, fname);
      break;
    }
  }

  if (!foundGame) {
    console.error(`Game ${gameId} not found in any season file.`);
    process.exit(1);
  }

  console.log(`  Found in sid: ${foundSid}`);
  console.log(`  Date: ${foundGame.d}  Round: ${foundGame.rn}`);
  console.log(`  ${foundGame.hn} ${foundGame.hs} – ${foundGame.as} ${foundGame.an}`);
  console.log(`  hidden: ${foundGame.hidden ?? false}\n`);

  const session = await getSession();

  // ── Step 1: re-fetch from spectator ─────────────────────────────────────────
  console.log('── Spectator endpoint (current) ────────────────────────────────────');
  const spectatorGame = await fetchSpectator(gameId, session.allCookies);
  if (!spectatorGame) {
    console.log('  Game returned null from spectator (legacy or expired)');
  } else {
    console.log(`  Status: ${spectatorGame.status}, updatedAt: ${spectatorGame.updatedAt}`);
    for (const [side, sideKey] of [['Home', 'home'], ['Away', 'away']]) {
      console.log(`  ${side}:`);
      for (const p of (spectatorGame.statistics?.[sideKey]?.players || [])) {
        const stats = {};
        for (const s of (p.statistics || [])) {
          stats[s.type?.value] = s.count;
        }
        console.log(`    ${p.name} (${p.profileID?.slice(0,8)}): ${JSON.stringify(stats)}`);
      }
    }
  }

  // ── Step 2: fetch publicProfileStatistics for each stored player ───────────
  console.log('\n── publicProfileStatistics (per-game) vs stored ────────────────────');

  const allPlayers = [
    ...(foundGame.hp || []).map(p => ({ ...p, side: 'hp' })),
    ...(foundGame.ap || []).map(p => ({ ...p, side: 'ap' })),
  ].filter(p => p.profileID);

  const corrections = { hp: [], ap: [] };
  let hasDiscrepancy = false;

  for (const stored of allPlayers) {
    const uuid = stored.profileID;
    let profileData;
    try { profileData = await fetchProfile(uuid, session.sessionCookie); } catch (e) {
      console.log(`  ${stored.name} (${uuid.slice(0,8)}): fetch error — ${e.message}`);
      continue;
    }

    const actual = extractGameStats(profileData, gameId);

    console.log(`\n  ${stored.name} (${uuid.slice(0,8)}):`);
    console.log(`    stored : pts=${stored.pts} pt1=${stored.pt1} pt2=${stored.pt2} pt3=${stored.pt3} fouls=${stored.fouls}`);

    if (!actual) {
      console.log(`    actual : game not found in profile — cannot verify`);
      corrections[stored.side].push({ ...stored });
      continue;
    }

    console.log(`    actual : pts=${actual.pts} pt1=${actual.pt1} pt2=${actual.pt2} pt3=${actual.pt3} fouls=${actual.fouls}`);
    console.log(`    raw stat types: ${JSON.stringify(actual.rawTypes)}`);

    const differs = stored.pts !== actual.pts || stored.pt1 !== actual.pt1 ||
                    stored.pt2 !== actual.pt2 || stored.pt3 !== actual.pt3 ||
                    stored.fouls !== actual.fouls;

    if (differs) {
      console.log(`    ⚠ DISCREPANCY`);
      hasDiscrepancy = true;
      corrections[stored.side].push({
        profileID: uuid,
        name:   stored.name,
        number: stored.number,
        pts:    actual.pts,
        pt1:    actual.pt1,
        pt2:    actual.pt2,
        pt3:    actual.pt3,
        fouls:  actual.fouls,
      });
    } else {
      console.log(`    ✓ matches`);
      corrections[stored.side].push({ ...stored });
    }
  }

  // ── Step 3: apply corrections ─────────────────────────────────────────────
  console.log('\n── Result ──────────────────────────────────────────────────────────');
  if (!hasDiscrepancy) {
    console.log('  No discrepancies found — stored data matches PlayHQ profile stats.');
    return;
  }

  console.log(`  Discrepancies found.`);
  if (DRY_RUN) {
    console.log('  Dry run — no changes written. Run with --fix to apply corrections.');
    return;
  }

  // Apply corrections to game file
  const gf = readJson(foundFile);
  if (corrections.hp.length) gf.games[gameId].hp = corrections.hp;
  if (corrections.ap.length) gf.games[gameId].ap = corrections.ap;

  writeJson(foundFile, gf);
  gitCommit(`fix-game-boxscore: corrected hp/ap for game ${gameId} in ${foundSid}`, ['games/bv/']);
  console.log('  ✔ Game file updated with correct box score data.');
})();
