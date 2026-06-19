// scripts/rebuild-player-stats.js
// Fetches publicProfileStatistics for all players using the exact patterns
// from fetch-playhq.js (getSession, gqlAuth, MOBILE_HEADERS) and the query
// from playhq_api_reference.md. No deviations.
//
// Options: --force, --dry-run, --concurrency=N (default 5), --stats-only

import fs     from 'fs';
import path   from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

const args        = process.argv.slice(2);
const FORCE       = args.includes('--force');
const DRY_RUN     = args.includes('--dry-run');
const STATS_ONLY  = args.includes('--stats-only');
const CONCURRENCY = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '5');
const COMMIT_N    = 2000;
const PROGRESS    = path.join(ROOT, 'scripts', '.rebuild-player-stats-progress.json');

console.log(`rebuild-player-stats | concurrency=${CONCURRENCY} force=${FORCE} dry=${DRY_RUN}\n`);

// ─── Copied exactly from fetch-playhq.js MOBILE_HEADERS ──────────────────────
const MOBILE_HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};
const API_URL = 'https://api.playhq.com/graphql';

// ─── Copied exactly from fetch-playhq.js getSession ──────────────────────────
let _sessionCookie = null;
async function getSession() {
  if (_sessionCookie) return _sessionCookie;
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({
      operationName: 'ProfileSearch',
      variables:     { fullName: 'test user' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id __typename } } }',
    }),
  });
  const raw = res.headers.get('set-cookie');
  if (raw) {
    _sessionCookie = raw.split(';')[0];
    console.log(`  ✓ Session cookie obtained (${_sessionCookie.slice(0, 24)}...)\n`);
  } else {
    throw new Error('Could not obtain session cookie');
  }
  return _sessionCookie;
}

// ─── Copied exactly from fetch-playhq.js gqlAuth ─────────────────────────────
async function gqlAuth(operationName, query, variables) {
  const cookie = await getSession();
  if (!cookie) return null;
  while (true) {
    const res = await fetch(API_URL, {
      method:  'POST',
      headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
      body:    JSON.stringify({ operationName, query, variables }),
    });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue; }
    if (!res.ok) return null;
    const json = await res.json();
    if (json.errors) return null;
    return json.data;
  }
}

// ─── Query copied exactly from playhq_api_reference.md ───────────────────────
const Q_PROFILE = `query ProfileSeasonStatistics($profileID: ID!) {
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

async function fetchProfile(uuid) {
  const data = await gqlAuth('ProfileSeasonStatistics', Q_PROFILE, { profileID: uuid });
  return data?.publicProfileStatistics ?? null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readJson(p)    { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p,d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

function gitCommit(msg, dirs) {
  if (DRY_RUN) return;
  try {
    execSync(`git add ${dirs.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    if (!execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim()) return;
    execSync(`git commit -m "${msg}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { cwd: ROOT, stdio: 'pipe' });
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
    console.log(`  ✔ ${msg}`);
  } catch(e) { console.error(`  ✗ git: ${e.message.split('\n')[0]}`); }
}

// ─── Load UUIDs ───────────────────────────────────────────────────────────────
const indexDir = path.join(ROOT, 'players', 'indexes');
const allUUIDs = [];
for (const f of fs.readdirSync(indexDir).filter(f => f.endsWith('.json')))
  for (const uuid of Object.keys(readJson(path.join(indexDir, f)))) allUUIDs.push(uuid);

let progress = { done: [] };
if (!FORCE && fs.existsSync(PROGRESS)) try { progress = readJson(PROGRESS); } catch {}
const done    = new Set(progress.done ?? []);
const toFetch = allUUIDs.filter(u => !done.has(u));

console.log(`${allUUIDs.length.toLocaleString()} total | ${done.size.toLocaleString()} done | ${toFetch.length.toLocaleString()} remaining\n`);

// ─── Initialise session before batch loop ─────────────────────────────────────
await getSession();

// ─── Main loop ────────────────────────────────────────────────────────────────
const playersDir = path.join(ROOT, 'players');
const FOUL_LIMIT = 5;
const today      = new Date().toISOString().slice(0, 10);
let fetched = 0, nulls = 0, updated = 0, sinceCommit = 0;
const nullSample = [];

for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
  const batch = toFetch.slice(i, i + CONCURRENCY);

  await Promise.all(batch.map(async uuid => {
    const profile = await fetchProfile(uuid);
    done.add(uuid); fetched++;

    if (!profile) {
      nulls++;
      if (nullSample.length < 10) {
        try {
          const p = readJson(path.join(playersDir, uuid.slice(0,2), `${uuid}.json`));
          const gp = p.sports?.Basketball?.gp ?? 0;
          if (gp >= 10) nullSample.push(`${uuid} (${p.firstName ?? ''} ${p.lastName ?? ''}, ${gp} gp)`);
        } catch {}
      }
      return;
    }

    if (!STATS_ONLY) return;

    const playerPath = path.join(playersDir, uuid.slice(0,2), `${uuid}.json`);
    let player;
    try { player = readJson(playerPath); } catch { return; }

    let modified = false;
    if (player.statsChecked !== today) { player.statsChecked = today; modified = true; }

    // Extract foulOuts and records from gameStatistics
    for (const sEntry of (profile.seasonStatistics ?? [])) {
      for (const tEntry of (sEntry.statistics ?? [])) {
        const sid = tEntry.season?.id;
        if (!sid) continue;
        for (const team of (tEntry.teamStatistics ?? [])) {
          const tid = team.team?.id;
          if (!tid) continue;
          for (const grade of (team.gradeStatistics ?? [])) {
            const gid = grade.grade?.id;
            if (!gid) continue;

            let foulOuts = 0;
            let maxPTS = 0, maxPTSgame = null;
            let maxPT3 = 0, maxPT3game = null;

            for (const gameStat of (grade.gameStatistics ?? [])) {
              const gameId = gameStat.game?.id;
              let gameFouls = 0, gamePTS = 0, gamePT3 = 0;
              for (const stat of (gameStat.statistics ?? [])) {
                const val = stat.details?.value;
                const cnt = stat.count ?? 0;
                if (val === 'TOTAL_FOULS')   gameFouls += cnt;
                if (val === 'TOTAL_SCORE')   gamePTS    = cnt;
                if (val === '3_POINT_SCORE') gamePT3    = cnt;
                if (val === '2_POINT_SCORE' && !gamePTS) gamePTS += cnt * 2;
                if (val === '1_POINT_SCORE' && !gamePTS) gamePTS += cnt;
              }
              if (gameFouls >= FOUL_LIMIT) foulOuts++;
              if (gamePTS > maxPTS) { maxPTS = gamePTS; maxPTSgame = { v: gamePTS, gameKey: gameId, sid }; }
              if (gamePT3 > maxPT3) { maxPT3 = gamePT3; maxPT3game = { v: gamePT3, gameKey: gameId, sid }; }
            }

            // Update matching reg
            for (const season of (player.seasons ?? [])) {
              if (season.sid !== sid) continue;
              for (const reg of (season.regs ?? [])) {
                if (reg.tid !== tid || reg.gid !== gid) continue;
                if (!reg.stats) reg.stats = {};
                if ((reg.stats.foulOuts ?? 0) !== foulOuts) {
                  if (foulOuts === 0) delete reg.stats.foulOuts;
                  else reg.stats.foulOuts = foulOuts;
                  modified = true;
                }
              }
            }

            if (maxPTSgame?.v > 0) {
              if (!player.records) player.records = {};
              if (!player.records.maxGamePTS || maxPTSgame.v > (player.records.maxGamePTS?.v ?? 0)) {
                player.records.maxGamePTS = maxPTSgame; modified = true;
              }
            }
            if (maxPT3game?.v > 0) {
              if (!player.records) player.records = {};
              if (!player.records.maxGameThreePt || maxPT3game.v > (player.records.maxGameThreePt?.v ?? 0)) {
                player.records.maxGameThreePt = maxPT3game; modified = true;
              }
            }
          }
        }
      }
    }

    // Career foulOuts
    if (player.sports?.Basketball) {
      let careerFO = 0;
      for (const s of (player.seasons ?? []))
        for (const r of (s.regs ?? [])) careerFO += r.stats?.foulOuts ?? 0;
      if ((player.sports.Basketball.foulOuts ?? 0) !== careerFO) {
        if (careerFO === 0) delete player.sports.Basketball.foulOuts;
        else player.sports.Basketball.foulOuts = careerFO;
        modified = true;
      }
    }

    if (modified) { if (!DRY_RUN) writeJson(playerPath, player); updated++; }
  }));

  sinceCommit += batch.length;
  if (fetched % 5000 === 0 || i + CONCURRENCY >= toFetch.length) {
    const pct = (fetched / toFetch.length * 100).toFixed(1);
    console.log(`  ${fetched.toLocaleString()}/${toFetch.length.toLocaleString()} (${pct}%) | updated: ${updated} | null: ${nulls}`);
  }

  if (sinceCommit >= COMMIT_N) {
    if (!DRY_RUN) {
      writeJson(PROGRESS, { done: [...done] });
      gitCommit(`rebuild-player-stats: ${fetched}/${toFetch.length} fetched, ${updated} updated`, ['players/', 'scripts/.rebuild-player-stats-progress.json']);
    }
    sinceCommit = 0;
  }
}

if (!DRY_RUN) {
  writeJson(PROGRESS, { done: [...done] });
  gitCommit(`rebuild-player-stats: complete — ${updated} updated`, ['players/', 'scripts/.rebuild-player-stats-progress.json']);
  fs.unlinkSync(PROGRESS);
  gitCommit('rebuild-player-stats: remove progress', ['scripts/.rebuild-player-stats-progress.json']);
}

console.log(`\nDone | fetched: ${fetched} | null: ${nulls} | updated: ${updated}`);
if (nullSample.length) { console.log('\nNull sample (≥10 gp):'); nullSample.forEach(s => console.log(' ', s)); }
