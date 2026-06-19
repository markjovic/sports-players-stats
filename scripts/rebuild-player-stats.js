// scripts/rebuild-player-stats.js
//
// Single-pass publicProfileStatistics fetch — the authoritative PlayHQ source.
// Replaces build-foulout-stats.js. Extracts everything in one API pass per player:
//
// From gradeStatistics.totalStatistics (season totals per grade):
//   foulOuts      — games with TOTAL_FOULS >= 5 (from gameStatistics, not totals)
//   personalFouls — PERSONAL_FOUL season total
//   technicalFouls— TECHNICAL_FOUL season total
//   unsFouls      — UNSPORTSMANLIKE_FOUL season total
//   disFouls      — DISQUALIFYING_FOUL season total
//   benchFouls    — BENCH_TECHNICAL_FOUL season total
//   bestPlayer    — BEST_PLAYER award count
//
// From gradeStatistics.gameStatistics (per-game):
//   foulOuts      — counted here (TOTAL_FOULS >= FOUL_THRESHOLD)
//   hp/ap fix     — corrects stored box scores in hidden game files
//
// Writes:
//   players/{xx}/{uuid}.json  — new reg.stats fields + career totals
//   games/bv/{sid}.json       — corrected hp/ap for hidden games (--scores-only or default)
//
// Options:
//   --stats-only   Only update player files, skip game file corrections
//   --scores-only  Only fix hp/ap, skip player file stat updates
//   --dry-run      No writes, show summary only
//   --force        Ignore progress file, start fresh

import fs   from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ─── Configuration ────────────────────────────────────────────────────────────
const FOUL_THRESHOLD  = 5;
const PLAYER_COMMIT_N = 5000;
const GAME_COMMIT_N   = 200;
const PROGRESS_FILE   = path.join(ROOT, 'scripts', '.rebuild-player-stats-progress.json');

// Adaptive concurrency — starts at configurable value, backs off on 429s,
// recovers aggressively. No artificial API ceiling — 429s discover the real one.
// Practical Node.js upper bound of 1000 prevents socket exhaustion.
const MAX_CONCURRENCY   = 200;
const START_CONCURRENCY = Math.min(MAX_CONCURRENCY, parseInt(
  process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '100'
));
let CONCURRENCY     = START_CONCURRENCY;
let CONCURRENCY_CAP = MAX_CONCURRENCY; // cap = system limit, not assumed API limit
let _cleanBatches        = 0;
let _429total            = 0;
let _429streak           = 0;
let _403count            = 0; // 403s this batch window — high rate = rate limiting
let _403total            = 0; // total 403s across entire run
let _403window           = 0; // batch window counter for 403 detection
let _maxSafeConcurrency  = CONCURRENCY; // highest level with no 429s
const CORRECTIONS_FILE  = path.join(ROOT, 'scripts', '.rebuild-player-stats-corrections.json');
const P2_PROGRESS_FILE  = path.join(ROOT, 'scripts', '.rebuild-player-stats-p2-progress.json');

const args        = process.argv.slice(2);
const DRY_RUN     = args.includes('--dry-run');
const FORCE       = args.includes('--force');
const STATS_ONLY  = args.includes('--stats-only');
const SCORES_ONLY = args.includes('--scores-only');
const ACTIVE_ONLY = args.includes('--active-only');
const DO_STATS    = !SCORES_ONLY;
const DO_SCORES   = !STATS_ONLY && !ACTIVE_ONLY; // box score corrections only on full runs

console.log(`\nrebuild-player-stats | stats=${DO_STATS} scores=${DO_SCORES} active=${ACTIVE_ONLY} dry=${DRY_RUN} force=${FORCE}\n`);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  } catch (e) {
    console.error(`  ✗ git: ${e.message.split('\n')[0]}`);
  }
}

// ─── Stat type → field name ───────────────────────────────────────────────────
// Returns field name for reg.stats, or null to ignore.
function statField(value) {
  switch (value) {
    case 'APPEARANCE':            return 'gp';
    case 'TOTAL_SCORE':           return 'pts';
    case '1_POINT_SCORE':
    case 'FREE_THROW':            return 'pt1';        // for hp/ap correction only
    case '2_POINT_SCORE':
    case 'FIELD_GOAL':            return 'pt2';
    case '3_POINT_SCORE':
    case 'THREE_POINT_FIELD_GOAL':return 'pt3';
    case 'TOTAL_FOULS':           return 'fouls';      // displayed "F" stat
    case 'PERSONAL_FOUL':         return 'personalFouls';
    case 'TECHNICAL_FOUL':        return 'technicalFouls';
    case 'UNSPORTSMANLIKE_FOUL':  return 'unsFouls';
    case 'DISQUALIFYING_FOUL':    return 'disFouls';
    case 'BENCH_TECHNICAL_FOUL':  return 'benchFouls';
    case 'BEST_PLAYER':           return 'bestPlayer';
    default:                      return null;
  }
}

// Fields written to reg.stats from totalStatistics
const TOTAL_STAT_FIELDS = ['personalFouls','technicalFouls','unsFouls','disFouls','benchFouls','bestPlayer'];
// Fields written to reg.stats from gameStatistics (derived)
const GAME_STAT_FIELDS  = ['foulOuts'];
// All new fields for career totals
const ALL_NEW_FIELDS    = [...TOTAL_STAT_FIELDS, ...GAME_STAT_FIELDS];

// ─── API setup ────────────────────────────────────────────────────────────────
const HEADERS_API = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

let _cookie        = null;
let _reAuthPromise  = null; // prevents concurrent re-auth attempts
let _sessionPromise = null; // promise lock — prevents concurrent session fetches

async function getSession() {
  if (_cookie) return _cookie;
  // If a re-auth is already in flight, wait for it rather than firing another
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = _doGetSession().finally(() => { _sessionPromise = null; });
  return _sessionPromise;
}

async function _doGetSession() {
  console.log('  Fetching session cookie...');
  let raw = null;
  for (let attempt = 1; attempt <= 5 && !raw; attempt++) {
    if (attempt > 1) await delay(attempt * 3000);
    const res = await fetch('https://api.playhq.com/graphql', {
      method: 'POST',
      headers: { ...HEADERS_API, 'request-id': crypto.randomUUID() },
      body: JSON.stringify({
        operationName: 'ProfileSearch',
        variables: { fullName: 'a' },
        query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
      }),
    });
    raw = res.headers.get('set-cookie');
  }
  if (!raw) throw new Error('No Set-Cookie after 5 attempts');
  _cookie = raw.split(';')[0];
  console.log(`  ✓ Session obtained (${_cookie.slice(0, 24)}...)\n`);
  return _cookie;
}

// Fetches publicProfileStatistics for one UUID. Returns null on any error.
const Q = `query S($id:ID!){publicProfileStatistics(profileID:$id){seasonStatistics{statistics{
  season{id}
  teamStatistics{
    team{...on DiscoverTeam{id}}
    gradeStatistics{
      grade{id}
      totalStatistics{count details{value __typename}}
      gameStatistics{game{id}statistics{count details{value __typename}}}
    }
  }
}}}}`;

async function fetchProfile(uuid, cookie) {
  try {
    const res = await fetch('https://api.playhq.com/graphql', {
      method: 'POST',
      headers: { ...HEADERS_API, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
      body:    JSON.stringify({ operationName: 'S', variables: { id: uuid }, query: Q }),
    });

    if (res.status === 429) {
      _429total++;
      _429streak++;
      _cleanBatches = 0;
      const prev = CONCURRENCY;
      CONCURRENCY = Math.max(5, Math.floor(CONCURRENCY * 0.6));
      if (_429streak >= 3) {
        CONCURRENCY_CAP = Math.max(5, CONCURRENCY_CAP - 5);
        CONCURRENCY     = Math.min(CONCURRENCY, CONCURRENCY_CAP);
        _429streak      = 0;
        console.warn(`  ⚠ Repeated 429s — cap lowered to ${CONCURRENCY_CAP}, concurrency ${CONCURRENCY}`);
      } else {
        console.warn(`  ⚠ 429 — concurrency ${prev} → ${CONCURRENCY}`);
      }
      await delay(5000);
      return fetchProfile(uuid, cookie); // retry same request
    }

    if (!res.ok) {
      if (res.status === 403) _403total++;
      return null;
    }

    const data = await res.json();
    if (data.errors) return null;
    _429streak = 0;
    return data?.data?.publicProfileStatistics ?? null;
  } catch { connErrors++; return null; }
}

// ─── Parse publicProfileStatistics response ──────────────────────────────────
// Returns { regStats, gameCorrections, playerBests }
// regStats:    Map<'sid:tid:gid', {personalFouls, ..., foulOuts}>
// gameCorrections: Map<gameId, {pt1,pt2,pt3,pts,fouls}>
// playerBests: { maxGamePTS, maxGameThreePt } — { v, gameKey, sid }
function parseProfile(profile, hiddenGameIds) {
  if (!profile?.seasonStatistics) return { regStats: new Map(), gameCorrections: new Map(), playerBests: {} };

  const regStats        = new Map();
  const gameCorrections = new Map();
  let maxGamePTS     = null; // { v, gameKey, sid }
  let maxGameThreePt = null;

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

          // ── totalStatistics → new reg.stats fields ─────────────────────────
          const totals = {};
          for (const stat of (grade.totalStatistics ?? [])) {
            const field = statField(toStr(stat.details));
            if (field && TOTAL_STAT_FIELDS.includes(field)) {
              totals[field] = (totals[field] ?? 0) + (stat.count ?? 0);
            }
          }

          // ── gameStatistics → foulOuts + player bests + hp/ap corrections ───
          let foulOuts = 0;
          for (const gameStat of (grade.gameStatistics ?? [])) {
            const gameId = gameStat.game?.id;
            if (!gameId) continue;

            let gameFouls = 0;
            const gameScoring = {};
            for (const stat of (gameStat.statistics ?? [])) {
              const val = toStr(stat.details);
              const cnt = stat.count ?? 0;
              if (val === 'TOTAL_FOULS') gameFouls += cnt;
              const f = statField(val);
              if (f && ['pt1','pt2','pt3','pts','fouls'].includes(f)) {
                gameScoring[f] = (gameScoring[f] ?? 0) + cnt;
              }
            }
            if (gameFouls >= FOUL_THRESHOLD) foulOuts++;

            // Track personal best single-game records
            const gamePTS = gameScoring.pts ??
              ((gameScoring.pt1 ?? 0) + (gameScoring.pt2 ?? 0) * 2 + (gameScoring.pt3 ?? 0) * 3);
            const gamePT3 = gameScoring.pt3 ?? 0;
            if (gamePTS > 0 && (!maxGamePTS || gamePTS > maxGamePTS.v))
              maxGamePTS = { v: gamePTS, gameKey: gameId, sid };
            if (gamePT3 > 0 && (!maxGameThreePt || gamePT3 > maxGameThreePt.v))
              maxGameThreePt = { v: gamePT3, gameKey: gameId, sid };

            // Collect hp/ap correction for hidden games
            if (DO_SCORES && hiddenGameIds.has(gameId)) {
              const pts = gameScoring.pts ??
                ((gameScoring.pt1 ?? 0) + (gameScoring.pt2 ?? 0) * 2 + (gameScoring.pt3 ?? 0) * 3);
              gameCorrections.set(gameId, {
                pts,
                pt1:   gameScoring.pt1   ?? 0,
                pt2:   gameScoring.pt2   ?? 0,
                pt3:   gameScoring.pt3   ?? 0,
                fouls: gameScoring.fouls ?? gameFouls,
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

// Extract value string from details (object or array)
function toStr(details) {
  if (!details) return '';
  if (Array.isArray(details)) return details[0]?.value ?? '';
  return details.value ?? '';
}

// ─── Phase 2 resume check ────────────────────────────────────────────────────
// If corrections file exists from a previous run, skip straight to phase 2
if (DO_SCORES && !FORCE && fs.existsSync(CORRECTIONS_FILE)) {
  console.log('── Resuming Phase 2 from persisted corrections file ─────────────────────');
  const flat = readJson(CORRECTIONS_FILE);
  const p2Progress = fs.existsSync(P2_PROGRESS_FILE) ? readJson(P2_PROGRESS_FILE) : { doneSids: [] };
  const p2AlreadyDone = new Set(p2Progress.doneSids ?? []);

  let gamesFixed = 0, entriesFixed = 0, sinceCommit2 = 0;
  const p2Done2 = new Set(p2AlreadyDone);

  for (const [sid, gameMap] of Object.entries(flat)) {
    if (p2AlreadyDone.has(sid)) continue;
    const gamePath = path.join(gamesDir, `${sid}.json`);
    let gf; try { gf = readJson(gamePath); } catch { continue; }
    let fileModified = false;

    for (const [gameId, uuidMap] of Object.entries(gameMap)) {
      const game = gf.games?.[gameId];
      if (!game) continue;
      for (const side of ['hp', 'ap']) {
        const box = game[side];
        if (!Array.isArray(box)) continue;
        for (const entry of box) {
          const uuid = entry.profileID;
          if (!uuid) continue;
          const correction = uuidMap[uuid];
          if (!correction) continue;
          const differs = entry.pts !== correction.pts || entry.pt1 !== correction.pt1 ||
            entry.pt2 !== correction.pt2 || entry.pt3 !== correction.pt3 || entry.fouls !== correction.fouls;
          if (differs) {
            Object.assign(entry, correction);
            entriesFixed++; fileModified = true;
          }
        }
      }
      if (fileModified) gamesFixed++;
    }

    if (fileModified) {
      if (!DRY_RUN) writeJson(gamePath, gf);
      p2Done2.add(sid); sinceCommit2++;
      if (sinceCommit2 >= GAME_COMMIT_N) {
        if (!DRY_RUN) writeJson(P2_PROGRESS_FILE, { doneSids: [...p2Done2] });
        gitCommit(`rebuild-player-stats: hp/ap resume — ${gamesFixed} games fixed`,
          ['games/bv/', 'scripts/.rebuild-player-stats-p2-progress.json']);
        sinceCommit2 = 0;
      }
    }
  }

  if (!DRY_RUN && sinceCommit2 > 0) {
    gitCommit(`rebuild-player-stats: hp/ap complete — ${gamesFixed} games, ${entriesFixed} entries`,
      ['games/bv/']);
  }

  if (!DRY_RUN) {
    for (const f of [CORRECTIONS_FILE, P2_PROGRESS_FILE]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    gitCommit('rebuild-player-stats: remove phase 2 progress files',
      ['scripts/.rebuild-player-stats-corrections.json', 'scripts/.rebuild-player-stats-p2-progress.json']);
  }

  console.log(`  ${gamesFixed} games corrected, ${entriesFixed} entries updated`);
  process.exit(0);
}

// ─── Phase 0: scan game files for hidden games with hp/ap ────────────────────
console.log('── Phase 0: Scanning game files for hidden game IDs ─────────────────');
const gamesDir = path.join(ROOT, 'games', 'bv');
const hiddenGameIds = new Set();   // Set<gameId>
const hiddenGameSid = new Map();   // gameId → sid

if (DO_SCORES) {
  const sids = fs.readdirSync(gamesDir).filter(f => f.endsWith('.json'));
  for (const fname of sids) {
    let gf;
    try { gf = readJson(path.join(gamesDir, fname)); } catch { continue; }
    const sid = fname.replace('.json', '');
    for (const [gameId, g] of Object.entries(gf.games ?? {})) {
      if (g.hidden && (Array.isArray(g.hp) || Array.isArray(g.ap))) {
        hiddenGameIds.add(gameId);
        hiddenGameSid.set(gameId, sid);
      }
    }
  }
  console.log(`  ${hiddenGameIds.size.toLocaleString()} hidden games with stored box scores\n`);
} else {
  console.log('  Skipped (--stats-only)\n');
}

// ─── Load progress ────────────────────────────────────────────────────────────
let progress = { done: [] };
if (!FORCE && fs.existsSync(PROGRESS_FILE)) {
  try { progress = readJson(PROGRESS_FILE); } catch {}
}
const done = new Set(progress.done ?? []);

// ─── Load all UUIDs from player index ────────────────────────────────────────
console.log('── Loading player UUIDs from index ──────────────────────────────────');
const indexDir = path.join(ROOT, 'players', 'indexes');
const allUUIDs = [];
for (const fname of fs.readdirSync(indexDir).filter(f => f.endsWith('.json'))) {
  try {
    const shard = readJson(path.join(indexDir, fname));
    for (const uuid of Object.keys(shard)) allUUIDs.push(uuid);
  } catch {}
}
console.log(`  ${allUUIDs.length.toLocaleString()} players in index`);
// In active-only mode, restrict to players in active seasons
let fetchTargets = allUUIDs;
if (ACTIVE_ONLY) {
  const sportsIndex = readJson(path.join(ROOT, 'sports-index.json'));
  const activeSids  = new Set(
    Object.values(sportsIndex.seasons ?? {})
      .filter(s => !s.locked)
      .map(s => s.id)
  );
  const activeUUIDs = new Set();
  for (const sid of activeSids) {
    const tsPath = path.join(ROOT, 'team-stats', 'bv', `${sid}.json`);
    if (!fs.existsSync(tsPath)) continue;
    try {
      const tsData = readJson(tsPath);
      for (const team of Object.values(tsData)) {
        for (const uuid of Object.keys(team.roster ?? {})) activeUUIDs.add(uuid);
      }
    } catch {}
  }
  fetchTargets = [...activeUUIDs];
  console.log(`  Active-only: ${activeSids.size} active seasons → ${activeUUIDs.size.toLocaleString()} players`);
}

const toFetch = fetchTargets.filter(u => !done.has(u));
console.log(`  ${done.size.toLocaleString()} already done, ${toFetch.length.toLocaleString()} remaining\n`);

// ─── Phase 1: fetch + update player files ────────────────────────────────────
console.log('── Phase 1: Fetch publicProfileStatistics + update player files ──────');

const playersDir = path.join(ROOT, 'players');
// Accumulate game corrections by sid for batch writing
// Map<sid, Map<gameId, Map<uuid, {pts,pt1,pt2,pt3,fouls}>>>
const allCorrections = new Map();

let fetched = 0, nulls = 0, connErrors = 0, updated = 0, skipped = 0;
const nullSample = []; // sample of null-returning UUIDs that have significant stored stats
let sinceCommit = 0;

const cookie = await getSession();
console.log(`  Cookie: ${cookie.slice(0, 24)}...\n`);

let _batchStart = 0;
for (let i = 0; i < toFetch.length; i += _batchStart) {
  _batchStart = CONCURRENCY; // capture current value before async ops may change it
  const batch = toFetch.slice(i, i + _batchStart);

  await Promise.all(batch.map(async uuid => {
    const profile = await fetchProfile(uuid, cookie);
    done.add(uuid);

    if (!profile) {
      nulls++; fetched++;
      // Collect a sample of significant players returning null for diagnosis
      if (DO_STATS && nullSample.length < 10) {
        try {
          const pp = readJson(path.join(playersDir, uuid.slice(0,2), `${uuid}.json`));
          const gp = pp.sports?.Basketball?.gp ?? 0;
          if (gp >= 10) nullSample.push({ uuid, name: `${pp.firstName ?? ''} ${pp.lastName ?? ''}`.trim(), gp });
        } catch {}
      }
      return;
    }

    const { regStats, gameCorrections, playerBests } = parseProfile(profile, hiddenGameIds);



    // ── Accumulate game corrections ──────────────────────────────────────────
    if (DO_SCORES && gameCorrections.size > 0) {
      for (const [gameId, stats] of gameCorrections) {
        const sid = hiddenGameSid.get(gameId);
        if (!sid) continue;
        if (!allCorrections.has(sid)) allCorrections.set(sid, new Map());
        const sidMap = allCorrections.get(sid);
        if (!sidMap.has(gameId)) sidMap.set(gameId, new Map());
        sidMap.get(gameId).set(uuid, stats);
      }
    }

    // ── Update player file ───────────────────────────────────────────────────
    if (!DO_STATS) { fetched++; return; }

    const playerPath = path.join(playersDir, uuid.slice(0, 2), `${uuid}.json`);
    let player;
    try { player = readJson(playerPath); } catch { fetched++; skipped++; return; }

    let modified = false;

    // Stamp successful fetch date — distinguishes "null from API" vs "processed, no scoring data"
    const today = new Date().toISOString().slice(0, 10);
    if (player.statsChecked !== today) { player.statsChecked = today; modified = true; }

    // Per-reg updates
    for (const season of (player.seasons ?? [])) {
      const sid = season.sid;
      for (const reg of (season.regs ?? [])) {
        const key = `${sid}:${reg.tid}:${reg.gid}`;
        const update = regStats.get(key);
        if (!update) continue;
        if (!reg.stats) reg.stats = {};
        for (const field of ALL_NEW_FIELDS) {
          const val = update[field] ?? 0;
          // Only write non-zero values (space saving), or overwrite existing
          if (val > 0 || reg.stats[field] !== undefined) {
            if ((reg.stats[field] ?? 0) !== val) {
              if (val === 0) delete reg.stats[field];
              else reg.stats[field] = val;
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
        let careerTotal = 0;
        for (const season of (player.seasons ?? []))
          for (const reg of (season.regs ?? []))
            careerTotal += reg.stats?.[field] ?? 0;
        if ((bball[field] ?? 0) !== careerTotal) {
          if (careerTotal === 0) delete bball[field];
          else bball[field] = careerTotal;
          modified = true;
        }
      }
    }

    // Write personal best single-game records
    if (DO_STATS) {
      if (playerBests.maxGamePTS?.v > 0) {
        if (!player.records) player.records = {};
        if (!player.records.maxGamePTS || playerBests.maxGamePTS.v > (player.records.maxGamePTS?.v ?? 0)) {
          player.records.maxGamePTS = playerBests.maxGamePTS;
          modified = true;
        }
      }
      if (playerBests.maxGameThreePt?.v > 0) {
        if (!player.records) player.records = {};
        if (!player.records.maxGameThreePt || playerBests.maxGameThreePt.v > (player.records.maxGameThreePt?.v ?? 0)) {
          player.records.maxGameThreePt = playerBests.maxGameThreePt;
          modified = true;
        }
      }
    }

    if (modified) {
      if (!DRY_RUN) writeJson(playerPath, player);
      updated++;
    }
    fetched++;
  }));

  sinceCommit += batch.length;

  // Detect 403 rate limiting: if >30% of batch returned 403, back off
  _403window += batch.length;
  if (_403window >= 500) {
    const rate403 = _403count / _403window;
    if (rate403 > 0.30) {
      const prev = CONCURRENCY;
      CONCURRENCY = Math.max(5, Math.floor(CONCURRENCY * 0.6));
      _cleanBatches = 0;
      console.warn(`  ⚠ High 403 rate (${(rate403*100).toFixed(0)}%) — likely rate limiting, concurrency ${prev} → ${CONCURRENCY}, backing off 30s`);
      await delay(30000);
    }
    _403count = 0;
    _403window = 0;
  }

  // Recover concurrency aggressively after clean batches
  _cleanBatches++;
  if (_maxSafeConcurrency < CONCURRENCY) _maxSafeConcurrency = CONCURRENCY;
  if (_cleanBatches >= 2 && CONCURRENCY < CONCURRENCY_CAP) {
    CONCURRENCY = Math.min(CONCURRENCY_CAP, CONCURRENCY + 10);
    _cleanBatches = 0;
    if (CONCURRENCY % 50 === 0)
      console.log(`  📈 Concurrency at ${CONCURRENCY} (max safe so far: ${_maxSafeConcurrency})`);
  }

  if (fetched % 5000 === 0 || i + _batchStart >= toFetch.length) {
    const pct = ((fetched / toFetch.length) * 100).toFixed(1);
    console.log(`  ${fetched.toLocaleString()}/${toFetch.length.toLocaleString()} (${pct}%) | updated: ${updated} | null: ${nulls} | conn-err: ${connErrors} | concurrency: ${CONCURRENCY}`);
  }

  if (sinceCommit >= PLAYER_COMMIT_N) {
    if (!DRY_RUN) {
      writeJson(PROGRESS_FILE, { done: [...done] });
      if (DO_STATS) gitCommit(
        `rebuild-player-stats: ${fetched}/${toFetch.length} fetched, ${updated} updated`,
        ['players/', 'scripts/.rebuild-player-stats-progress.json']
      );
      else gitCommit(
        `rebuild-player-stats: ${fetched}/${toFetch.length} fetched (scores pass)`,
        ['scripts/.rebuild-player-stats-progress.json']
      );
    }
    sinceCommit = 0;
  }

}

// Save final progress
if (!DRY_RUN) writeJson(PROGRESS_FILE, { done: [...done], phase1Complete: true });

// ─── Phase 2: apply hp/ap corrections to game files ──────────────────────────
if (DO_SCORES && allCorrections.size > 0) {
  console.log(`\n── Phase 2: Applying hp/ap corrections to game files ──────────────────`);
  console.log(`  ${allCorrections.size} season files to update`);

  // Persist corrections map so phase 2 can resume if workflow times out
  if (!DRY_RUN) {
    const flat = {};
    for (const [sid, gameMap] of allCorrections) {
      flat[sid] = {};
      for (const [gameId, uuidMap] of gameMap) {
        flat[sid][gameId] = Object.fromEntries(uuidMap);
      }
    }
    writeJson(CORRECTIONS_FILE, flat);
    writeJson(P2_PROGRESS_FILE, { doneSids: [] });
    gitCommit('rebuild-player-stats: persist phase 2 corrections', ['scripts/.rebuild-player-stats-corrections.json', 'scripts/.rebuild-player-stats-p2-progress.json']);
  }

  let gamesFixed = 0, entriesFixed = 0, sidesFixed = 0;
  sinceCommit = 0;
  const p2Done = new Set();

  for (const [sid, gameMap] of allCorrections) {
    const gamePath = path.join(gamesDir, `${sid}.json`);
    let gf;
    try { gf = readJson(gamePath); } catch { continue; }

    let fileModified = false;

    for (const [gameId, uuidMap] of gameMap) {
      const game = gf.games?.[gameId];
      if (!game) continue;

      for (const side of ['hp', 'ap']) {
        const box = game[side];
        if (!Array.isArray(box)) continue;

        for (const entry of box) {
          const uuid = entry.profileID;
          if (!uuid) continue;
          const correction = uuidMap.get(uuid);
          if (!correction) continue;

          // Only update if different
          const differs = entry.pts !== correction.pts ||
            entry.pt1 !== correction.pt1 ||
            entry.pt2 !== correction.pt2 ||
            entry.pt3 !== correction.pt3 ||
            entry.fouls !== correction.fouls;

          if (differs) {
            entry.pts   = correction.pts;
            entry.pt1   = correction.pt1;
            entry.pt2   = correction.pt2;
            entry.pt3   = correction.pt3;
            entry.fouls = correction.fouls;
            entriesFixed++;
            fileModified = true;
          }
        }
      }
      if (fileModified) gamesFixed++;
    }

    if (fileModified) {
      if (!DRY_RUN) writeJson(gamePath, gf);
      sidesFixed++;
      sinceCommit++;

      p2Done.add(sid);
      if (sinceCommit >= GAME_COMMIT_N) {
        if (!DRY_RUN) writeJson(P2_PROGRESS_FILE, { doneSids: [...p2Done] });
        gitCommit(
          `rebuild-player-stats: hp/ap corrected — ${gamesFixed} games, ${entriesFixed} entries`,
          ['games/bv/', 'scripts/.rebuild-player-stats-p2-progress.json']
        );
        sinceCommit = 0;
      }
    }
  }

  if (!DRY_RUN && sinceCommit > 0) {
    gitCommit(
      `rebuild-player-stats: hp/ap corrections complete — ${gamesFixed} games, ${entriesFixed} entries`,
      ['games/bv/']
    );
  }

  console.log(`  ${gamesFixed} games corrected, ${entriesFixed} player entries updated`);
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
if (!DRY_RUN) {
  for (const f of [PROGRESS_FILE, CORRECTIONS_FILE, P2_PROGRESS_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  gitCommit('rebuild-player-stats: remove progress files',
    ['scripts/.rebuild-player-stats-progress.json',
     'scripts/.rebuild-player-stats-corrections.json',
     'scripts/.rebuild-player-stats-p2-progress.json']);
}

console.log('\n─── Summary ─────────────────────────────────────────────────────────');
console.log(`  Starting concurrency : ${START_CONCURRENCY}`);
console.log(`  Max safe concurrency : ${_maxSafeConcurrency}`);
console.log(`  Final concurrency    : ${CONCURRENCY}`);
console.log(`  Total 429s           : ${_429total}`);
console.log(`  Players fetched      : ${fetched.toLocaleString()}`);
console.log(`  Null/no profile      : ${nulls.toLocaleString()}`);
console.log(`  Connection failures  : ${connErrors.toLocaleString()} (retried 5x)`);
console.log(`  Player files updated : ${updated.toLocaleString()}`);
console.log(`  Hidden games scanned : ${hiddenGameIds.size.toLocaleString()}`);
console.log(`  Mode                 : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
if (nullSample.length > 0) {
  console.log('\n── Sample null-returning UUIDs with ≥10 stored games (test these manually) ──');
  for (const p of nullSample)
    console.log(`  ${p.uuid}  (${p.name || 'no name'}, ${p.gp} gp)`);
}
console.log('\nNext: node scripts/build-leaderboards.js --force');
