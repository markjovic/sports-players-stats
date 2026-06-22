// scripts/build-team-stats.js
//
// Builds/rebuilds team-stats/bv/{seasonId}.json for each season.
// Each file contains per-team roster stats and fixture list.
//
// Roster stats are sourced from player detail files (seasons[].regs[].stats).
// Players not yet through publicProfileStatistics bootstrap will show zeros.
//
// Usage:
//   node scripts/build-team-stats.js                   # all seasons
//   node scripts/build-team-stats.js --active-only     # active (unlocked) seasons only
//   node scripts/build-team-stats.js --dry-run         # no writes or commits
//   node scripts/build-team-stats.js --season=<id>     # single season

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const ARGS    = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const DRY_RUN     = !!ARGS['dry-run'];
const ACTIVE_ONLY = !!ARGS['active-only'];
const TARGET_SID  = ARGS.season || null;

const GAMES_DIR      = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR    = path.join(ROOT, 'players');
const TEAM_STATS_DIR = path.join(ROOT, 'team-stats', 'bv');
const INDEX_FILE     = path.join(ROOT, 'sports-index.json');

const COMMIT_EVERY = 50;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gitCommit(message) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  try { execSync('git add team-stats/', { stdio: 'pipe', cwd: ROOT }); } catch (_) {}
  const staged = (() => {
    try { return execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim(); }
    catch (_) { return ''; }
  })();
  if (!staged) { return; }
  try { execSync(`git commit -m "${message.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT }); }
  catch (_) { return; }
  const MAX = 10;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      execSync('git fetch origin main',                   { stdio: 'pipe', cwd: ROOT });
      execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main',                   { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✓ Committed: ${message}`);
      return;
    } catch (_) {
      if (attempt === MAX) { console.error(`  Push failed after ${MAX} attempts`); return; }
      await sleep(Math.floor(Math.random() * 15000) + attempt * 3000);
    }
  }
}

// Player file cache — avoid re-reading the same file multiple times per season
const playerCache = new Map();

function readPlayer(uuid) {
  if (playerCache.has(uuid)) return playerCache.get(uuid);
  const shard = uuid.slice(0, 2).toLowerCase();
  const file  = path.join(PLAYERS_DIR, shard, `${uuid}.json`);
  if (!fs.existsSync(file)) { playerCache.set(uuid, null); return null; }
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    playerCache.set(uuid, p);
    return p;
  } catch (_) { playerCache.set(uuid, null); return null; }
}

// Extract per-registration stats for a player in a given season/team
function extractRegStats(player, sid, tid) {
  for (const season of (player.seasons || [])) {
    if (season.sid !== sid) continue;
    for (const reg of (season.regs || [])) {
      if (reg.tid === tid && reg.stats) return reg.stats;
    }
  }
  return null;
}

// Build team-stats for a single season
function buildSeasonTeamStats(sid, seasonMeta) {
  const gameFile = path.join(GAMES_DIR, `${sid}.json`);
  if (!fs.existsSync(gameFile)) return null;

  let gf;
  try { gf = JSON.parse(fs.readFileSync(gameFile, 'utf8')); }
  catch (_) { return null; }

  const games  = gf.games || {};
  const teams  = {};  // tid → { meta, roster, fixtures }

  // Helper — ensure team entry exists
  function ensureTeam(tid, tn, club) {
    if (!teams[tid]) {
      teams[tid] = {
        meta:     { name: tn || tid, club: club || '' },
        roster:   {},
        fixtures: [],
      };
    }
    // Update name/club if we get better data
    if (tn  && !teams[tid].meta.name) teams[tid].meta.name = tn;
    if (club && !teams[tid].meta.club) teams[tid].meta.club = club;
  }

  // Helper — add a player to the team roster
  function addPlayerToRoster(tid, sid, uuid, name) {
    if (!uuid || !teams[tid]) return;
    if (teams[tid].roster[uuid]) return;  // already added

    const player = readPlayer(uuid);
    const stats  = player ? extractRegStats(player, sid, tid) : null;

    teams[tid].roster[uuid] = {
      name:    name || (player?.name) || `Player #${uuid.slice(0, 10)}`,
      gp:      stats?.gp      ?? 0,
      pts:     stats?.pts     ?? 0,
      fg:      stats?.fg      ?? 0,
      ft:      stats?.ft      ?? 0,
      threePt: stats?.threePt ?? 0,
      fouls:   stats?.fouls   ?? 0,
    };
  }

  // Process each game
  for (const [gameId, game] of Object.entries(games)) {
    // Skip non-real games
    if (game.cancelled || game.abandoned || game.bye) continue;
    if (game.hidden && !game.hs && !game.as) continue;

    const hid = game.h || game.t1 || null;
    const aid = game.a || game.t2 || null;
    const hn  = game.hn || game.t1n || '';
    const an  = game.an || game.t2n || '';
    const hs  = game.hs ?? null;
    const as_ = game.as ?? null;

    // Derive club from org — we don't have it directly, use team name heuristics
    if (hid) ensureTeam(hid, hn, '');
    if (aid) ensureTeam(aid, an, '');

    const status = game.st || null;

    // Build fixture entry for each team
    const date  = game.d  || null;
    const rn    = game.rn || null;

    if (hid && aid) {
      // Home team fixture
      if (teams[hid]) {
        let result = null;
        if (hs !== null && as_ !== null) {
          result = hs > as_ ? 'W' : hs < as_ ? 'L' : 'D';
        } else if (game.forfeit) {
          result = game.fo === hid ? 'W' : 'L';
        }
        const score = (hs !== null && as_ !== null) ? `${hs}-${as_}` : null;
        teams[hid].fixtures.push({
          gameId,
          date,
          rn,
          oppId:   aid,
          oppName: an,
          result,
          score,
          st: status,
        });
      }

      // Away team fixture
      if (teams[aid]) {
        let result = null;
        if (hs !== null && as_ !== null) {
          result = as_ > hs ? 'W' : as_ < hs ? 'L' : 'D';
        } else if (game.forfeit) {
          result = game.fo === aid ? 'W' : 'L';
        }
        const score = (hs !== null && as_ !== null) ? `${as_}-${hs}` : null;
        teams[aid].fixtures.push({
          gameId,
          date,
          rn,
          oppId:   hid,
          oppName: hn,
          result,
          score,
          st: status,
        });
      }
    }

    // Add players from p[] to roster
    for (const p of (game.p || [])) {
      if (!p.id) continue;
      // Determine which team this player is on — use hp/ap if available,
      // otherwise we can't tell from p[] alone, so skip team attribution
    }

    // For hidden games, use hp/ap for player attribution
    for (const p of (game.hp || [])) {
      if (hid && p.profileID) addPlayerToRoster(hid, sid, p.profileID, p.name || null);
    }
    for (const p of (game.ap || [])) {
      if (aid && p.profileID) addPlayerToRoster(aid, sid, p.profileID, p.name || null);
    }
  }

  // Sort fixtures by date then round number
  for (const team of Object.values(teams)) {
    team.fixtures.sort((a, b) => {
      if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
      return 0;
    });
  }

  return teams;
}

async function main() {
  const startTime = Date.now();
  console.log('build-team-stats.js');
  if (ACTIVE_ONLY) console.log('  Mode: active seasons only');
  if (TARGET_SID)  console.log(`  Season: ${TARGET_SID}`);
  if (DRY_RUN)     console.log('  ⚠  DRY RUN — no writes or commits');
  console.log('─'.repeat(50));

  if (!fs.existsSync(INDEX_FILE)) { console.error('sports-index.json not found'); process.exit(1); }
  const sportIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const allSeasons = Object.values(sportIndex.seasons || {});

  let seasons;
  if (TARGET_SID) {
    seasons = allSeasons.filter(s => s.id === TARGET_SID);
  } else if (ACTIVE_ONLY) {
    seasons = allSeasons.filter(s => s.locked === false);
  } else {
    seasons = allSeasons;
  }

  console.log(`Seasons to process: ${seasons.length}`);
  fs.mkdirSync(TEAM_STATS_DIR, { recursive: true });

  let processed = 0, written = 0, sinceCommit = 0;

  for (const season of seasons) {
    playerCache.clear();  // clear cache between seasons to avoid unbounded growth

    const stats = buildSeasonTeamStats(season.id, season);
    processed++;

    if (stats && Object.keys(stats).length > 0) {
      const outFile = path.join(TEAM_STATS_DIR, `${season.id}.json`);
      if (!DRY_RUN) {
        fs.writeFileSync(outFile, JSON.stringify(stats));
      }
      written++;
      sinceCommit++;
    }

    if (processed % 25 === 0 || processed === seasons.length)
      process.stdout.write(`  ${processed}/${seasons.length} seasons  ${written} written\r`);

    if (sinceCommit >= COMMIT_EVERY) {
      await gitCommit(`build-team-stats: ${written} files written (${processed}/${seasons.length} seasons)`);
      sinceCommit = 0;
    }
  }

  console.log(`\n  ${processed}/${seasons.length} seasons processed  ${written} files written`);
  await gitCommit(`build-team-stats: complete — ${written} files for ${processed} seasons`);

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('─'.repeat(50));
  console.log(`  Elapsed: ${elapsed}s`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
