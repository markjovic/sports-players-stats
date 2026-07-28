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
//
// 2026-07-10: team-stats/bv/{sid}.json roster keys are truncated to a
// TRUNC_LEN (13) char uuid prefix (see scripts/lib/uuid-prefix.cjs) — part of
// the UUID-storage migration. (Comments previously said 10-char; the runtime
// always used truncateUuid(), so keys were already TRUNC_LEN — only the
// placeholder label hardcoded 10. Both corrected 2026-07-21.) Player uuids
// sourced from game.hp[]/ap[].profileID may be
// truncated (existing games/bv/*.json data was rewritten by the one-off
// migration script) so they're resolved back to a full uuid via
// resolveToFullUuid() before being used to read a player file; uuids sourced
// from players/indexes/ (sidTidPlayerMap) are always full-length already.

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const { truncateUuid, resolveToFullUuid, TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

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
const INDEX_DIR      = path.join(ROOT, 'players', 'indexes');
const PLAYERS_DIR    = path.join(ROOT, 'players');
const TEAM_STATS_DIR = path.join(ROOT, 'team-stats', 'bv');
const INDEX_FILE     = path.join(ROOT, 'data', 'sports-index.json');

const COMMIT_EVERY = 50;

function gitCommit(message, dirs) {
  // House pattern, copied from build-finals-stats.js / build-win-loss.js.
  // 2026-07-28: replaced this script's own 10-attempt/linear-backoff version —
  // the last remaining outlier (OUTSTANDING_TASKS §A6). The old one ALSO
  // swallowed a total push failure (console.error + return), so a run could
  // print "complete — N files" and go green having pushed nothing. THROW now:
  // a red job beats silently discarded work.
  // Staging: PER-PATH adds — `git add` is ATOMIC across pathspecs, so one
  // combined add with any unmatched pathspec stages NOTHING (this exact bug
  // silently discarded a whole discover-fixtures run, 2026-07-19). Staged
  // shortstat is printed so the log proves what was staged. COMMIT FIRST, then
  // fetch/merge/push with 60 attempts, random 1-91s jitter, merge --abort
  // cleanup, merge -X ours --no-stat.
  if (!dirs || !dirs.length) { console.error('  gitCommit: no paths given — refusing blanket add'); return; }
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  try {
    for (const dir of dirs) {
      try {
        execSync(`git add ${dir}`, { stdio: 'pipe', cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
      } catch (e) {
        console.error(`  staging miss (skipped): ${dir} — ${e.stderr?.toString().slice(0, 120) || e.message.slice(0, 120)}`);
      }
    }
    const staged = execSync('git diff --staged --shortstat',
      { stdio: 'pipe', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).toString().trim();
    if (!staged) { console.log('  nothing to commit'); return; }
    console.log(`  staging: ${staged}`);
    execSync(`git commit -q -m "${message.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT });
  } catch (e) {
    console.error('  git error (stage/commit):', e.stderr?.toString().slice(0, 200) || e.message.slice(0, 200));
    return;
  }
  for (let attempt = 1; attempt <= 60; attempt++) {
    try { execSync('git merge --abort', { stdio: 'pipe', cwd: ROOT }); } catch (_) { /* none in progress */ }
    try {
      execSync('git fetch origin main',                            { stdio: 'pipe', cwd: ROOT });
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', { stdio: 'pipe', cwd: ROOT });
      execSync('git push origin main',                             { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✔ committed: ${message}`);
      return;
    } catch (e) {
      if (attempt === 60) {
        console.error('  git push failed after 60 attempts:', e.stderr?.toString().slice(0, 200) || e.message.slice(0, 200));
        throw e;
      }
      const s = 1 + Math.floor(Math.random() * 91);
      execSync(`sleep ${s}`, { stdio: 'pipe', cwd: ROOT });
    }
  }
}

// Build sid|tid → [uuid] map from player index history shards.
// Covers ALL registrations including normal grade players (not just hp/ap hidden games).
// Uuids here always come from players/indexes/{shard}.json keys, which are
// full-length — unaffected by the games-file truncation migration.
function buildSidTidPlayerMap() {
  const map = new Map();
  for (const fname of fs.readdirSync(INDEX_DIR).filter(f => f.endsWith('.json')).sort()) {
    let shard;
    try { shard = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, fname), 'utf8')); }
    catch (_) { continue; }
    for (const [uuid, entry] of Object.entries(shard)) {
      for (const [sid, tids] of Object.entries(entry.history || {})) {
        for (const tid of tids) {
          const key = `${sid}|${tid}`;
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(uuid);
        }
      }
    }
  }
  return map;
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
function buildSeasonTeamStats(sid, seasonMeta, sidTidPlayerMap) {
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

  // Helper — add a player to the team roster. uuid must always be the FULL
  // player uuid by the time it reaches here (callers resolve truncated
  // hp/ap.profileID values first) — readPlayer() needs the full uuid to
  // build a valid players/{shard}/{uuid}.json path. The roster is keyed by
  // the truncated TRUNC_LEN (13) prefix, matching the games/leaderboard/search
  // truncation everywhere else on disk.
  function addPlayerToRoster(tid, sid, uuid, name) {
    if (!uuid || !teams[tid]) return;
    const key = truncateUuid(uuid);
    if (teams[tid].roster[key]) return;  // already added

    const player = readPlayer(uuid);
    const stats  = player ? extractRegStats(player, sid, tid) : null;

    teams[tid].roster[key] = {
      name:    name || (player?.name) || `Player #${uuid.slice(0, TRUNC_LEN)}`,
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

    // NOTE: game.p[] is deliberately NOT used for roster attribution — it
    // carries no side info, so a p[] entry cannot be assigned to a team here.
    // Rosters come from hp[]/ap[] below plus the player index (sidTidPlayerMap).
    // (A dead loop that iterated p[] and did nothing was removed 2026-07-28 —
    // OUTSTANDING_TASKS §A6.)

    // For hidden games, use hp/ap for player attribution. profileID may be a
    // truncated prefix (existing data rewritten by the one-off
    // migration) or a full uuid (data written before the migration) —
    // resolveToFullUuid() handles both transparently and returns null if a
    // truncated prefix has no match in the player index (skip in that case).
    for (const p of (game.hp || [])) {
      if (hid && p.profileID) {
        const full = resolveToFullUuid(p.profileID, ROOT);
        if (full) addPlayerToRoster(hid, sid, full, p.name || null);
      }
    }
    for (const p of (game.ap || [])) {
      if (aid && p.profileID) {
        const full = resolveToFullUuid(p.profileID, ROOT);
        if (full) addPlayerToRoster(aid, sid, full, p.name || null);
      }
    }
  }

  // Populate rosters from player index — covers all normal and hidden grade players
  for (const [tid, teamData] of Object.entries(teams)) {
    const uuids = sidTidPlayerMap ? (sidTidPlayerMap.get(`${sid}|${tid}`) || []) : [];
    for (const uuid of uuids) {
      addPlayerToRoster(tid, sid, uuid, null);
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

  // Build player index map once upfront — avoids scanning 256 shards per season
  console.log('  Building player index map from shards...');
  const sidTidPlayerMap = buildSidTidPlayerMap();
  console.log(`  ${sidTidPlayerMap.size} sid|tid combinations indexed`);

  let processed = 0, written = 0, sinceCommit = 0;

  for (const season of seasons) {
    playerCache.clear();  // clear cache between seasons to avoid unbounded growth

    const stats = buildSeasonTeamStats(season.id, season, sidTidPlayerMap);
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
      gitCommit(`build-team-stats: ${written} files written (${processed}/${seasons.length} seasons)`, ['team-stats/']);
      sinceCommit = 0;
    }
  }

  console.log(`\n  ${processed}/${seasons.length} seasons processed  ${written} files written`);
  gitCommit(`build-team-stats: complete — ${written} files for ${processed} seasons`, ['team-stats/']);

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('─'.repeat(50));
  console.log(`  Elapsed: ${elapsed}s`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
