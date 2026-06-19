// scripts/rebuild-player-stats.js
//
// Single-pass publicProfileStatistics fetch — authoritative PlayHQ source.
// Fixed concurrency: no ramp-up. PlayHQ silently returns null when rate-limited
// so hold a steady low rate. Use --concurrency=10 (default) for safe operation.
//
// Options:
//   --stats-only    Only update player files (skip hp/ap game file corrections)
//   --scores-only   Only fix hp/ap (skip player stat updates)
//   --active-only   Only process players in active (unlocked) seasons
//   --dry-run       No writes
//   --force         Ignore progress file
//   --concurrency=N Parallel requests (default: 10)

import fs     from 'fs';
import path   from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

// ─── Configuration ────────────────────────────────────────────────────────────
const FOUL_THRESHOLD  = 5;
const PLAYER_COMMIT_N = 2000;
const GAME_COMMIT_N   = 200;
const PROGRESS_FILE   = path.join(ROOT, 'scripts', '.rebuild-player-stats-progress.json');
const CORRECTIONS_FILE= path.join(ROOT, 'scripts', '.rebuild-player-stats-corrections.json');
const P2_PROGRESS_FILE= path.join(ROOT, 'scripts', '.rebuild-player-stats-p2-progress.json');

const args        = process.argv.slice(2);
const DRY_RUN     = args.includes('--dry-run');
const FORCE       = args.includes('--force');
const STATS_ONLY  = args.includes('--stats-only');
const SCORES_ONLY = args.includes('--scores-only');
const ACTIVE_ONLY = args.includes('--active-only');
const CONCURRENCY = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '10');
const DO_STATS    = !SCORES_ONLY;
const DO_SCORES   = !STATS_ONLY && !ACTIVE_ONLY;

console.log(`\nrebuild-player-stats | concurrency=${CONCURRENCY} stats=${DO_STATS} scores=${DO_SCORES} active=${ACTIVE_ONLY} dry=${DRY_RUN} force=${FORCE}\n`);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readJson(p)    { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p,d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }
function delay(ms)      { return new Promise(r => setTimeout(r, ms)); }

function gitCommit(message, dirs) {
  if (DRY_RUN) return;
  try {
    execSync(`git add ${dirs.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ ${message}`);
  } catch (e) { console.error(`  ✗ git: ${e.message.split('\n')[0]}`); }
}

// ─── Stat field mapping ───────────────────────────────────────────────────────
const TOTAL_STAT_FIELDS = ['personalFouls','technicalFouls','unsFouls','disFouls','benchFouls','bestPlayer'];
const ALL_NEW_FIELDS    = [...TOTAL_STAT_FIELDS, 'foulOuts'];

function statField(v) {
  switch (v) {
    case 'APPEARANCE':            return 'gp';
    case 'TOTAL_SCORE':           return 'pts';
    case '1_POINT_SCORE':
    case 'FREE_THROW':            return 'pt1';
    case '2_POINT_SCORE':
    case 'FIELD_GOAL':            return 'pt2';
    case '3_POINT_SCORE':
    case 'THREE_POINT_FIELD_GOAL':return 'pt3';
    case 'TOTAL_FOULS':           return 'fouls';
    case 'PERSONAL_FOUL':         return 'personalFouls';
    case 'TECHNICAL_FOUL':        return 'technicalFouls';
    case 'UNSPORTSMANLIKE_FOUL':  return 'unsFouls';
    case 'DISQUALIFYING_FOUL':    return 'disFouls';
    case 'BENCH_TECHNICAL_FOUL':  return 'benchFouls';
    case 'BEST_PLAYER':           return 'bestPlayer';
    default:                      return null;
  }
}

function toStr(details) {
  if (!details) return '';
  if (Array.isArray(details)) return details[0]?.value ?? '';
  return details.value ?? '';
}

// ─── Session ──────────────────────────────────────────────────────────────────
const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

async function getSession() {
  console.log('  Fetching session cookie...');
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await delay(attempt * 3000);
    const res = await fetch('https://api.playhq.com/graphql', {
      method: 'POST',
      headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
      body: JSON.stringify({
        operationName: 'ProfileSearch',
        variables: { fullName: 'a' },
        query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
      }),
    });
    const raw = res.headers.get('set-cookie');
    if (raw) {
      const cookie = raw.split(';')[0];
      console.log(`  ✓ Session obtained (${cookie.slice(0,24)}...)\n`);
      return cookie;
    }
  }
  throw new Error('No Set-Cookie after 5 attempts');
}

// ─── Profile query ────────────────────────────────────────────────────────────
const Q = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics { statistics {
      season { id }
      teamStatistics {
        team { ... on DiscoverTeam { id } }
        gradeStatistics {
          grade { id }
          totalStatistics { count details { value } }
          gameStatistics { game { id } statistics { count details { value } } }
        }
      }
    }}
  }
}`;

async function fetchProfile(uuid, cookie) {
  try {
    const res = await fetch('https://api.playhq.com/graphql', {
      method:  'POST',
      headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
      body:    JSON.stringify({ operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: Q }),
    });
    if (res.status === 429) { await delay(10000); return fetchProfile(uuid, cookie); }
    if (!res.ok) return null;
    const data = await res.json();
    if (data.errors) return null;
    return data?.data?.publicProfileStatistics ?? null;
  } catch { return null; }
}

// ─── Parse profile ────────────────────────────────────────────────────────────
function parseProfile(profile, hiddenGameIds) {
  if (!profile?.seasonStatistics) return { regStats: new Map(), gameCorrections: new Map(), playerBests: {} };

  const regStats        = new Map();
  const gameCorrections = new Map();
  let maxGamePTS        = null;
  let maxGameThreePt    = null;

  for (const sEntry of profile.seasonStatistics) {
    for (const tEntry of (sEntry.statistics ?? [])) {
      const sid = tEntry.season?.id;
      if (!sid) continue;
      for (const team of (tEntry.teamStatistics ?? [])) {
        const tid = team.team?.id;
        if (!tid) continue;
        for (const grade of (team.gradeStatistics ?? [])) {
          const gid = grade.grade?.id;
          if (!gid) continue;
          const key = `${sid}:${tid}:${gid}`;

          // Season totals
          const totals = {};
          for (const stat of (grade.totalStatistics ?? [])) {
            const f = statField(toStr(stat.details));
            if (f && TOTAL_STAT_FIELDS.includes(f)) totals[f] = (totals[f] ?? 0) + (stat.count ?? 0);
          }

          // Per-game stats
          let foulOuts = 0;
          for (const gameStat of (grade.gameStatistics ?? [])) {
            const gameId = gameStat.game?.id;
            if (!gameId) continue;
            let gameFouls = 0;
            const gs = {};
            for (const stat of (gameStat.statistics ?? [])) {
              const val = toStr(stat.details);
              const cnt = stat.count ?? 0;
              if (val === 'TOTAL_FOULS') gameFouls += cnt;
              const f = statField(val);
              if (f && ['pt1','pt2','pt3','pts','fouls'].includes(f)) gs[f] = (gs[f] ?? 0) + cnt;
            }
            if (gameFouls >= FOUL_THRESHOLD) foulOuts++;

            const pts = gs.pts ?? ((gs.pt1 ?? 0) + (gs.pt2 ?? 0) * 2 + (gs.pt3 ?? 0) * 3);
            const pt3 = gs.pt3 ?? 0;
            if (pts > 0 && (!maxGamePTS     || pts > maxGamePTS.v))    maxGamePTS     = { v: pts, gameKey: gameId, sid };
            if (pt3 > 0 && (!maxGameThreePt || pt3 > maxGameThreePt.v)) maxGameThreePt = { v: pt3, gameKey: gameId, sid };

            if (DO_SCORES && hiddenGameIds.has(gameId)) {
              gameCorrections.set(gameId, {
                pts, pt1: gs.pt1 ?? 0, pt2: gs.pt2 ?? 0, pt3: gs.pt3 ?? 0,
                fouls: gs.fouls ?? gameFouls,
              });
            }
          }

          const existing = regStats.get(key) ?? {};
          regStats.set(key, { ...existing, ...totals, foulOuts: (existing.foulOuts ?? 0) + foulOuts });
        }
      }
    }
  }
  return { regStats, gameCorrections, playerBests: { maxGamePTS, maxGameThreePt } };
}

// ─── Phase 2 resume ───────────────────────────────────────────────────────────
const gamesDir = path.join(ROOT, 'games', 'bv');
if (DO_SCORES && !FORCE && fs.existsSync(CORRECTIONS_FILE)) {
  console.log('── Resuming Phase 2 from saved corrections ──────────────────────────────');
  const flat       = readJson(CORRECTIONS_FILE);
  const p2Progress = fs.existsSync(P2_PROGRESS_FILE) ? readJson(P2_PROGRESS_FILE) : { doneSids: [] };
  const p2Done     = new Set(p2Progress.doneSids ?? []);
  let gamesFixed = 0, entriesFixed = 0, sinceCommit2 = 0;
  const p2DoneNew = new Set(p2Done);
  for (const [sid, gameMap] of Object.entries(flat)) {
    if (p2Done.has(sid)) continue;
    const gamePath = path.join(gamesDir, `${sid}.json`);
    let gf; try { gf = readJson(gamePath); } catch { continue; }
    let fileModified = false;
    for (const [gameId, uuidMap] of Object.entries(gameMap)) {
      const game = gf.games?.[gameId];
      if (!game) continue;
      for (const side of ['hp','ap']) {
        for (const entry of (game[side] ?? [])) {
          const uuid = entry.profileID;
          if (!uuid || !uuidMap[uuid]) continue;
          const c = uuidMap[uuid];
          if (entry.pts !== c.pts || entry.pt1 !== c.pt1 || entry.pt2 !== c.pt2 || entry.pt3 !== c.pt3 || entry.fouls !== c.fouls) {
            Object.assign(entry, c); entriesFixed++; fileModified = true;
          }
        }
      }
      if (fileModified) gamesFixed++;
    }
    if (fileModified) {
      if (!DRY_RUN) writeJson(gamePath, gf);
      p2DoneNew.add(sid); sinceCommit2++;
      if (sinceCommit2 >= GAME_COMMIT_N) {
        if (!DRY_RUN) writeJson(P2_PROGRESS_FILE, { doneSids: [...p2DoneNew] });
        gitCommit(`rebuild-player-stats: hp/ap resume — ${gamesFixed} games`, ['games/bv/', 'scripts/.rebuild-player-stats-p2-progress.json']);
        sinceCommit2 = 0;
      }
    }
  }
  if (!DRY_RUN && sinceCommit2 > 0) gitCommit(`rebuild-player-stats: hp/ap complete — ${gamesFixed} games, ${entriesFixed} entries`, ['games/bv/']);
  if (!DRY_RUN) for (const f of [CORRECTIONS_FILE, P2_PROGRESS_FILE]) if (fs.existsSync(f)) fs.unlinkSync(f);
  console.log(`  ${gamesFixed} games corrected, ${entriesFixed} entries updated`);
  process.exit(0);
}

// ─── Phase 0: scan hidden games ───────────────────────────────────────────────
console.log('── Phase 0: Scanning game files for hidden game IDs ─────────────────');
const hiddenGameIds = new Set();
const hiddenGameSid = new Map();
if (DO_SCORES) {
  for (const fname of fs.readdirSync(gamesDir).filter(f => f.endsWith('.json'))) {
    let gf; try { gf = readJson(path.join(gamesDir, fname)); } catch { continue; }
    const sid = fname.replace('.json','');
    for (const [gameId, g] of Object.entries(gf.games ?? {})) {
      if (g.hidden && (Array.isArray(g.hp) || Array.isArray(g.ap))) {
        hiddenGameIds.add(gameId); hiddenGameSid.set(gameId, sid);
      }
    }
  }
  console.log(`  ${hiddenGameIds.size.toLocaleString()} hidden games with stored box scores\n`);
} else { console.log('  Skipped (--stats-only)\n'); }

// ─── Load progress ────────────────────────────────────────────────────────────
let progress = { done: [] };
if (!FORCE && fs.existsSync(PROGRESS_FILE)) { try { progress = readJson(PROGRESS_FILE); } catch {} }
const done = new Set(progress.done ?? []);

// ─── Load UUIDs ───────────────────────────────────────────────────────────────
console.log('── Loading player UUIDs from index ──────────────────────────────────');
const indexDir = path.join(ROOT, 'players', 'indexes');
let allUUIDs = [];
for (const fname of fs.readdirSync(indexDir).filter(f => f.endsWith('.json'))) {
  try { for (const uuid of Object.keys(readJson(path.join(indexDir, fname)))) allUUIDs.push(uuid); } catch {}
}

if (ACTIVE_ONLY) {
  const sportsIndex = readJson(path.join(ROOT, 'sports-index.json'));
  const activeSids  = new Set(Object.values(sportsIndex.seasons ?? {}).filter(s => !s.locked).map(s => s.id));
  const activeUUIDs = new Set();
  for (const sid of activeSids) {
    const tsPath = path.join(ROOT, 'team-stats', 'bv', `${sid}.json`);
    if (!fs.existsSync(tsPath)) continue;
    try { for (const team of Object.values(readJson(tsPath))) for (const uuid of Object.keys(team.roster ?? {})) activeUUIDs.add(uuid); } catch {}
  }
  allUUIDs = [...activeUUIDs];
  console.log(`  Active-only: ${activeSids.size} seasons → ${allUUIDs.length.toLocaleString()} players`);
}

const toFetch = allUUIDs.filter(u => !done.has(u));
console.log(`  ${allUUIDs.length.toLocaleString()} players in index`);
console.log(`  ${done.size.toLocaleString()} already done, ${toFetch.length.toLocaleString()} remaining\n`);

// ─── Phase 1: Fetch + update ──────────────────────────────────────────────────
console.log('── Phase 1: Fetch publicProfileStatistics + update player files ──────');

const playersDir    = path.join(ROOT, 'players');
const allCorrections= new Map();

let fetched = 0, nulls = 0, updated = 0, skipped = 0;
const nullSample = [];
let sinceCommit = 0;

const cookie = await getSession();

for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
  const batch = toFetch.slice(i, i + CONCURRENCY);

  await Promise.all(batch.map(async uuid => {
    const profile = await fetchProfile(uuid, cookie);
    done.add(uuid);

    if (!profile) {
      nulls++; fetched++;
      if (nullSample.length < 10) {
        try {
          const pp = readJson(path.join(playersDir, uuid.slice(0,2), `${uuid}.json`));
          const gp = pp.sports?.Basketball?.gp ?? 0;
          if (gp >= 10) nullSample.push({ uuid, name: `${pp.firstName ?? ''} ${pp.lastName ?? ''}`.trim(), gp });
        } catch {}
      }
      return;
    }

    const { regStats, gameCorrections, playerBests } = parseProfile(profile, hiddenGameIds);

    // Accumulate hp/ap corrections
    if (DO_SCORES) {
      for (const [gameId, stats] of gameCorrections) {
        const sid = hiddenGameSid.get(gameId);
        if (!sid) continue;
        if (!allCorrections.has(sid)) allCorrections.set(sid, new Map());
        const sidMap = allCorrections.get(sid);
        if (!sidMap.has(gameId)) sidMap.set(gameId, new Map());
        sidMap.get(gameId).set(uuid, stats);
      }
    }

    if (!DO_STATS) { fetched++; return; }

    const playerPath = path.join(playersDir, uuid.slice(0,2), `${uuid}.json`);
    let player;
    try { player = readJson(playerPath); } catch { fetched++; skipped++; return; }

    let modified = false;

    // Stamp successful fetch date
    const today = new Date().toISOString().slice(0, 10);
    if (player.statsChecked !== today) { player.statsChecked = today; modified = true; }

    // Per-reg updates
    for (const season of (player.seasons ?? [])) {
      for (const reg of (season.regs ?? [])) {
        const update = regStats.get(`${season.sid}:${reg.tid}:${reg.gid}`);
        if (!update) continue;
        if (!reg.stats) reg.stats = {};
        for (const field of ALL_NEW_FIELDS) {
          const val = update[field] ?? 0;
          if (val > 0 || reg.stats[field] !== undefined) {
            if ((reg.stats[field] ?? 0) !== val) {
              if (val === 0) delete reg.stats[field]; else reg.stats[field] = val;
              modified = true;
            }
          }
        }
      }
    }

    // Career totals
    const bball = player.sports?.Basketball;
    if (bball) {
      for (const field of ALL_NEW_FIELDS) {
        let total = 0;
        for (const season of (player.seasons ?? []))
          for (const reg of (season.regs ?? []))
            total += reg.stats?.[field] ?? 0;
        if ((bball[field] ?? 0) !== total) {
          if (total === 0) delete bball[field]; else bball[field] = total;
          modified = true;
        }
      }
    }

    // Player records
    if (playerBests.maxGamePTS?.v > 0) {
      if (!player.records) player.records = {};
      if (!player.records.maxGamePTS || playerBests.maxGamePTS.v > (player.records.maxGamePTS?.v ?? 0)) {
        player.records.maxGamePTS = playerBests.maxGamePTS; modified = true;
      }
    }
    if (playerBests.maxGameThreePt?.v > 0) {
      if (!player.records) player.records = {};
      if (!player.records.maxGameThreePt || playerBests.maxGameThreePt.v > (player.records.maxGameThreePt?.v ?? 0)) {
        player.records.maxGameThreePt = playerBests.maxGameThreePt; modified = true;
      }
    }

    if (modified) { if (!DRY_RUN) writeJson(playerPath, player); updated++; }
    fetched++;
  }));

  sinceCommit += batch.length;

  if (fetched % 5000 === 0 || i + CONCURRENCY >= toFetch.length) {
    const pct = ((fetched / toFetch.length) * 100).toFixed(1);
    console.log(`  ${fetched.toLocaleString()}/${toFetch.length.toLocaleString()} (${pct}%) | updated: ${updated} | null: ${nulls} | concurrency: ${CONCURRENCY}`);
  }

  if (sinceCommit >= PLAYER_COMMIT_N) {
    if (!DRY_RUN) {
      writeJson(PROGRESS_FILE, { done: [...done] });
      gitCommit(
        `rebuild-player-stats: ${fetched}/${toFetch.length} fetched, ${updated} updated`,
        ['players/', 'scripts/.rebuild-player-stats-progress.json']
      );
    }
    sinceCommit = 0;
  }
}

if (!DRY_RUN) writeJson(PROGRESS_FILE, { done: [...done], phase1Complete: true });

// ─── Phase 2: hp/ap corrections ───────────────────────────────────────────────
if (DO_SCORES && allCorrections.size > 0) {
  console.log(`\n── Phase 2: Applying hp/ap corrections to game files ──────────────────`);
  console.log(`  ${allCorrections.size} season files to update`);

  if (!DRY_RUN) {
    const flat = {};
    for (const [sid, gameMap] of allCorrections) {
      flat[sid] = {};
      for (const [gameId, uuidMap] of gameMap) flat[sid][gameId] = Object.fromEntries(uuidMap);
    }
    writeJson(CORRECTIONS_FILE, flat);
    writeJson(P2_PROGRESS_FILE, { doneSids: [] });
    gitCommit('rebuild-player-stats: persist phase 2 corrections', ['scripts/.rebuild-player-stats-corrections.json', 'scripts/.rebuild-player-stats-p2-progress.json']);
  }

  let gamesFixed = 0, entriesFixed = 0, sinceCommit2 = 0;
  const p2Done = new Set();

  for (const [sid, gameMap] of allCorrections) {
    const gamePath = path.join(gamesDir, `${sid}.json`);
    let gf; try { gf = readJson(gamePath); } catch { continue; }
    let fileModified = false;
    for (const [gameId, uuidMap] of gameMap) {
      const game = gf.games?.[gameId];
      if (!game) continue;
      for (const side of ['hp','ap']) {
        for (const entry of (game[side] ?? [])) {
          const uuid = entry.profileID;
          if (!uuid) continue;
          const c = uuidMap.get(uuid);
          if (!c) continue;
          if (entry.pts !== c.pts || entry.pt1 !== c.pt1 || entry.pt2 !== c.pt2 || entry.pt3 !== c.pt3 || entry.fouls !== c.fouls) {
            Object.assign(entry, c); entriesFixed++; fileModified = true;
          }
        }
      }
      if (fileModified) gamesFixed++;
    }
    if (fileModified) {
      if (!DRY_RUN) writeJson(gamePath, gf);
      p2Done.add(sid); sinceCommit2++;
      if (sinceCommit2 >= GAME_COMMIT_N) {
        if (!DRY_RUN) writeJson(P2_PROGRESS_FILE, { doneSids: [...p2Done] });
        gitCommit(`rebuild-player-stats: hp/ap — ${gamesFixed} games, ${entriesFixed} entries`, ['games/bv/', 'scripts/.rebuild-player-stats-p2-progress.json']);
        sinceCommit2 = 0;
      }
    }
  }
  if (!DRY_RUN && sinceCommit2 > 0)
    gitCommit(`rebuild-player-stats: hp/ap complete — ${gamesFixed} games, ${entriesFixed} entries`, ['games/bv/']);
  console.log(`  ${gamesFixed} games corrected, ${entriesFixed} entries updated`);
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
if (!DRY_RUN) {
  for (const f of [PROGRESS_FILE, CORRECTIONS_FILE, P2_PROGRESS_FILE]) if (fs.existsSync(f)) fs.unlinkSync(f);
  gitCommit('rebuild-player-stats: remove progress files', ['scripts/.rebuild-player-stats-progress.json', 'scripts/.rebuild-player-stats-corrections.json', 'scripts/.rebuild-player-stats-p2-progress.json']);
}

console.log('\n─── Summary ─────────────────────────────────────────────────────────');
console.log(`  Concurrency          : ${CONCURRENCY}`);
console.log(`  Players fetched      : ${fetched.toLocaleString()}`);
console.log(`  Null/no profile      : ${nulls.toLocaleString()}`);
console.log(`  Player files updated : ${updated.toLocaleString()}`);
console.log(`  Hidden games scanned : ${hiddenGameIds.size.toLocaleString()}`);
console.log(`  Mode                 : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
if (nullSample.length > 0) {
  console.log('\n── Sample null-returning UUIDs with ≥10 stored games ────────────────────');
  for (const p of nullSample) console.log(`  ${p.uuid}  (${p.name || 'no name'}, ${p.gp} gp)`);
}
