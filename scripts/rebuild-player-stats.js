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
const FOUL_THRESHOLD    = 5;
const CONCURRENCY       = 20;
const BATCH_DELAY_MS    = 300;
const PLAYER_COMMIT_N   = 2500;   // commit player files every N players processed
const GAME_COMMIT_N     = 200;    // commit game files every N season files corrected
const PROGRESS_FILE     = path.join(ROOT, 'scripts', '.rebuild-player-stats-progress.json');

const args        = process.argv.slice(2);
const DRY_RUN     = args.includes('--dry-run');
const FORCE       = args.includes('--force');
const STATS_ONLY  = args.includes('--stats-only');
const SCORES_ONLY = args.includes('--scores-only');
const DO_STATS    = !SCORES_ONLY;
const DO_SCORES   = !STATS_ONLY;

console.log(`\nrebuild-player-stats | stats=${DO_STATS} scores=${DO_SCORES} dry=${DRY_RUN} force=${FORCE}\n`);

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

let _cookie = null;
async function getSession() {
  if (_cookie) return _cookie;
  console.log('  Fetching session cookie...');
  const probes = [
    { operationName: 'TenantConfig',   variables: {},              query: 'query TenantConfig { tenantConfiguration { label } }' },
    { operationName: 'ProfileSearch',  variables: { fullName:'a'},  query: 'query ProfileSearch($fullName:String!){profileSearch(fullName:$fullName){result{id}}}' },
  ];
  let raw = null;
  for (let attempt = 1; attempt <= 5 && !raw; attempt++) {
    if (attempt > 1) await delay(attempt * 3000);
    for (const body of probes) {
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
  _cookie = `phq_session=${raw.match(/phq_session=([^;]+)/)[1]}`;
  console.log('  ✓ Session obtained\n');
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
      body: JSON.stringify({ operationName: 'S', variables: { id: uuid }, query: Q }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.errors) return null;
    return data?.data?.publicProfileStatistics ?? null;
  } catch { return null; }
}

// ─── Parse publicProfileStatistics response ──────────────────────────────────
// Returns { regStats, gameCorrections }
// regStats:  Map<'sid:tid:gid', {personalFouls, technicalFouls, ..., foulOuts}>
// gameCorrections: Map<gameId, {pt1,pt2,pt3,pts,fouls}> — for hp/ap updates
function parseProfile(profile, hiddenGameIds) {
  if (!profile?.seasonStatistics) return { regStats: new Map(), gameCorrections: new Map() };

  const regStats       = new Map(); // 'sid:tid:gid' → partial reg.stats update
  const gameCorrections = new Map(); // gameId → {pts,pt1,pt2,pt3,fouls}

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

          // ── gameStatistics → foulOuts + hp/ap corrections ──────────────────
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

            // Collect hp/ap correction for hidden games
            if (DO_SCORES && hiddenGameIds.has(gameId)) {
              // pts computed from components if TOTAL_SCORE not returned
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
  return { regStats, gameCorrections };
}

// Extract value string from details (object or array)
function toStr(details) {
  if (!details) return '';
  if (Array.isArray(details)) return details[0]?.value ?? '';
  return details.value ?? '';
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
const toFetch = allUUIDs.filter(u => !done.has(u));
console.log(`  ${done.size.toLocaleString()} already done, ${toFetch.length.toLocaleString()} remaining\n`);

// ─── Phase 1: fetch + update player files ────────────────────────────────────
console.log('── Phase 1: Fetch publicProfileStatistics + update player files ──────');

const playersDir = path.join(ROOT, 'players');
// Accumulate game corrections by sid for batch writing
// Map<sid, Map<gameId, Map<uuid, {pts,pt1,pt2,pt3,fouls}>>>
const allCorrections = new Map();

let fetched = 0, nulls = 0, updated = 0, skipped = 0;
let sinceCommit = 0;

const cookie = await getSession();

for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
  const batch = toFetch.slice(i, i + CONCURRENCY);

  await Promise.all(batch.map(async uuid => {
    const profile = await fetchProfile(uuid, cookie);
    done.add(uuid);

    if (!profile) { nulls++; return; }

    const { regStats, gameCorrections } = parseProfile(profile, hiddenGameIds);

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

    if (modified) {
      if (!DRY_RUN) writeJson(playerPath, player);
      updated++;
    }
    fetched++;
  }));

  sinceCommit += batch.length;

  if (fetched % 5000 === 0 || i + CONCURRENCY >= toFetch.length) {
    console.log(`  ${fetched.toLocaleString()}/${toFetch.length.toLocaleString()} fetched | updated: ${updated} | null: ${nulls}`);
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

  if (i + CONCURRENCY < toFetch.length) await delay(BATCH_DELAY_MS);
}

// Save final progress
if (!DRY_RUN) writeJson(PROGRESS_FILE, { done: [...done], phase1Complete: true });

// ─── Phase 2: apply hp/ap corrections to game files ──────────────────────────
if (DO_SCORES && allCorrections.size > 0) {
  console.log(`\n── Phase 2: Applying hp/ap corrections to game files ──────────────────`);
  console.log(`  ${allCorrections.size} season files to update`);

  let gamesFixed = 0, entriesFixed = 0, sidesFixed = 0;
  sinceCommit = 0;

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

      if (sinceCommit >= GAME_COMMIT_N) {
        gitCommit(
          `rebuild-player-stats: hp/ap corrected — ${gamesFixed} games, ${entriesFixed} entries`,
          ['games/bv/']
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
if (!DRY_RUN && fs.existsSync(PROGRESS_FILE)) {
  fs.unlinkSync(PROGRESS_FILE);
  gitCommit('rebuild-player-stats: remove progress file', ['scripts/.rebuild-player-stats-progress.json']);
}

console.log('\n─── Summary ─────────────────────────────────────────────────────────');
console.log(`  Players fetched      : ${fetched.toLocaleString()}`);
console.log(`  Null/no profile      : ${nulls.toLocaleString()}`);
console.log(`  Player files updated : ${updated.toLocaleString()}`);
console.log(`  Hidden games scanned : ${hiddenGameIds.size.toLocaleString()}`);
console.log(`  Mode                 : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
console.log('\nNext: node scripts/build-leaderboards.js --force');
