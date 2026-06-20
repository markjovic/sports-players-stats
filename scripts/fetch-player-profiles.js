// scripts/fetch-player-profiles.js
// Closed-loop JIT auth with stochastic concurrency and differential error handling.
// Options: --force, --dry-run, --concurrency=N (default 10), --stats-only

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
const CONCURRENCY  = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '10');
const BATCH_DELAY  = parseInt(args.find(a => a.startsWith('--batch-delay='))?.split('=')[1] ?? '5000');
const COMMIT_N    = 2000;
const PROGRESS    = path.join(ROOT, 'scripts', '.fetch-player-profiles-progress.json');

console.log(`fetch-player-profiles | concurrency=${CONCURRENCY} batch-delay=${BATCH_DELAY}ms force=${FORCE} dry=${DRY_RUN}\n`);

const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};
const API_URL     = 'https://api.playhq.com/graphql';
// Cloudflare Worker proxy — set these in the workflow secrets to route
// through Cloudflare's distributed IPs instead of the GH Actions runner IP.
// PROXY_URL = Worker URL e.g. https://playhq-profile-proxy.insanoflash.workers.dev
// PROXY_SECRET = shared secret set in the Worker's environment variables
const PROXY_URL = process.env.PLAYHQ_PROXY_URL ?? 'https://playhq-profile-proxy.insanoflash.workers.dev';
const PROXY_SECRET = process.env.PLAYHQ_PROXY_SECRET ?? null;
const USE_PROXY    = !!(PROXY_URL && PROXY_SECRET);
if (USE_PROXY) console.log(`Using proxy: ${PROXY_URL}\n`);

// ─── JIT Auth Provider ────────────────────────────────────────────────────────
// _sessionCookie is lazily evaluated. Any 403 or auth error clears it,
// forcing the next getSession() call to re-authenticate before proceeding.
let _sessionCookie = null;
let _sessionPromise = null;

async function getSession(forceRefresh = false) {
  if (forceRefresh) _sessionCookie = null;
  if (_sessionCookie) return _sessionCookie;
  if (_sessionPromise) return _sessionPromise;

  _sessionPromise = (async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
      try {
        const res = await fetch(API_URL, {
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
          _sessionCookie = raw.split(',').map(c => c.trim().split(';')[0]).join('; ');
          console.log(`  ✓ Session obtained (${_sessionCookie.slice(0, 48)}...)`);
          return _sessionCookie;
        }
      } catch {}
    }
    throw new Error('Could not obtain session after 5 attempts');
  })().finally(() => { _sessionPromise = null; });

  return _sessionPromise;
}

// ─── Profile query ────────────────────────────────────────────────────────────
const Q = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics { statistics {
      season { id }
      teamStatistics {
        team { ... on DiscoverTeam { id name } }
        gradeStatistics {
          grade { id name }
          gameStatistics {
            game { id round { name isFinalsRound } }
            statistics { count details { value } }
          }
        }
      }
    }}
  }
}`;

// ─── Closed-loop fetcher with JIT auth and differential error handling ────────
let _fetched = 0, _ok = 0, _null = 0, _err = 0;
const _presentUUIDs = new Set();

async function fetchProfile(uuid, attempt = 0) {
  // Stochastic jitter — randomise dispatch timing to avoid WAF fingerprinting
  await new Promise(r => setTimeout(r, Math.random() * 200));

  // JIT: resolve auth state fresh per request
  const cookie = await getSession();
  const via = USE_PROXY ? 'proxy' : 'direct';
  const t0 = Date.now();

  let res;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000); // 15s timeout
    try {
      if (USE_PROXY) {
        res = await fetch(PROXY_URL, {
          method:  'POST',
          headers: { 'content-type': 'application/json', 'X-Proxy-Secret': PROXY_SECRET },
          body:    JSON.stringify({
            cookie,
            graphql: { operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: Q },
          }),
          signal: ac.signal,
        });
      } else {
        res = await fetch(API_URL, {
          method:  'POST',
          headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
          body:    JSON.stringify({ operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: Q }),
          signal: ac.signal,
        });
      }
    } finally { clearTimeout(timer); }
  } catch(e) {
    const ms = Date.now() - t0;
    console.log(`  [${uuid.slice(0,8)}] ${e.name === 'AbortError' ? 'TIMEOUT' : 'NET ERROR'} via ${via} — ${ms}ms (attempt ${attempt+1})`);
    if (attempt < 3) return fetchProfile(uuid, attempt + 1);
    return null;
  }

  // Stage 1: HTTP transport errors
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
    return fetchProfile(uuid, attempt + 1);
  }
  if (res.status === 403) {
    console.log(`  [403] ${uuid} via ${via} — ${Date.now()-t0}ms`);
    return null;
  }
  if (!res.ok) {
    console.log(`  [${uuid.slice(0,8)}] HTTP ${res.status} via ${via} — ${Date.now()-t0}ms (attempt ${attempt+1})`);
    return null;
  }

  // Stage 2: GraphQL application layer errors
  let json;
  try { json = await res.json(); } catch(e) {
    console.log(`  [${uuid.slice(0,8)}] PARSE ERROR via ${via} — ${e.message}`);
    return null;
  }

  if (json.errors) {
    const errMsg = json.errors[0]?.message?.toLowerCase() ?? '';
    console.log(`  [${uuid.slice(0,8)}] GQL ERROR: ${json.errors[0]?.message} via ${via}`);
    if (errMsg.includes('unauthori') || errMsg.includes('forbidden') || errMsg.includes('expired')) {
      _sessionCookie = null;
      if (attempt < 3) return fetchProfile(uuid, attempt + 1);
    }
    return null;
  }

  const pps = json?.data?.publicProfileStatistics ?? null;
  const ms = Date.now() - t0;
  if (!pps) {
    _null++;
    if (_null <= 5) console.log(`  [${uuid.slice(0,8)}] NULL via ${via} — ${ms}ms`);
  } else {
    _ok++;
    _presentUUIDs.add(uuid);
    if (_ok <= 10) console.log(`  [${uuid.slice(0,8)}] PRESENT (${pps.seasonStatistics?.length}s) via ${via} — ${ms}ms`);
  }
  return pps;
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

await getSession();

// ─── Main loop ────────────────────────────────────────────────────────────────
const playersDir = path.join(ROOT, 'players');
const FOUL_LIMIT = 5;
const today      = new Date().toISOString().slice(0, 10);
let fetched = 0, nulls = 0, updated = 0, sinceCommit = 0;
const nullSample = [];

// Processes one UUID — updates player file if profile found.
async function processUUID(uuid) {
    const profile = await fetchProfile(uuid);
    done.add(uuid); fetched++;

    if (!profile) {
      nulls++;
      if (nullSample.length < 10) {
        try {
          const p = readJson(path.join(playersDir, uuid.slice(0,2), `${uuid}.json`));
          const gp = p.sports?.Basketball?.gp ?? 0;
          if (gp >= 10) {
            nullSample.push(`${uuid} (${p.firstName ?? ''} ${p.lastName ?? ''}, ${gp} gp)`);
            if (nullSample.length === 10) {
              console.log('\n── Null sample ──');
              nullSample.forEach(s => console.log(' ', s));
              console.log('');
            }
          }
        } catch {}
      }

      sinceCommit++;
      await maybeCommit();
      return;
    }

    if (!STATS_ONLY) { sinceCommit++; await maybeCommit(); return; }

    const playerPath = path.join(playersDir, uuid.slice(0,2), `${uuid}.json`);
    let player;
    try { player = readJson(playerPath); } catch { sinceCommit++; await maybeCommit(); return; }

    let modified = false;
    if (player.statsChecked !== today) { player.statsChecked = today; modified = true; }

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
            let foulOuts = 0, maxPTS = 0, maxPTSgame = null, maxPT3 = 0, maxPT3game = null;
            for (const gameStat of (grade.gameStatistics ?? [])) {
              const gameId = gameStat.game?.id;
              let gameFouls = 0, gamePTS = 0, gamePT3 = 0;
              for (const stat of (gameStat.statistics ?? [])) {
                const val = stat.details?.value;
                const cnt = stat.count ?? 0;
                if (val === 'TOTAL_FOULS')   gameFouls += cnt;
                if (val === 'TOTAL_SCORE')   gamePTS    = cnt;
                if (val === '3_POINT_SCORE') gamePT3    = cnt;
              }
              if (gameFouls >= FOUL_LIMIT) foulOuts++;
              if (gamePTS > maxPTS) { maxPTS = gamePTS; maxPTSgame = { v: gamePTS, gameKey: gameId, sid }; }
              if (gamePT3 > maxPT3) { maxPT3 = gamePT3; maxPT3game = { v: gamePT3, gameKey: gameId, sid }; }
            }
            for (const season of (player.seasons ?? [])) {
              if (season.sid !== sid) continue;
              for (const reg of (season.regs ?? [])) {
                if (reg.tid !== tid || reg.gid !== gid) continue;
                if (!reg.stats) reg.stats = {};
                if ((reg.stats.foulOuts ?? 0) !== foulOuts) {
                  if (foulOuts === 0) delete reg.stats.foulOuts; else reg.stats.foulOuts = foulOuts;
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

    if (player.sports?.Basketball) {
      let careerFO = 0;
      for (const s of (player.seasons ?? [])) for (const r of (s.regs ?? [])) careerFO += r.stats?.foulOuts ?? 0;
      if ((player.sports.Basketball.foulOuts ?? 0) !== careerFO) {
        if (careerFO === 0) delete player.sports.Basketball.foulOuts;
        else player.sports.Basketball.foulOuts = careerFO;
        modified = true;
      }
    }

    if (modified) { if (!DRY_RUN) writeJson(playerPath, player); updated++; }
    sinceCommit++;
    await maybeCommit();
}

async function maybeCommit() {
  if (fetched % 1000 === 0 || fetched === toFetch.length) {
    const pct = (fetched / toFetch.length * 100).toFixed(1);
    console.log(`  ${fetched.toLocaleString()}/${toFetch.length.toLocaleString()} (${pct}%) | present: ${_ok} | null: ${_null} | updated: ${updated}`);
  }
  if (sinceCommit >= COMMIT_N) {
    sinceCommit = 0;
    if (!DRY_RUN) {
      writeJson(PROGRESS, { done: [...done] });
      gitCommit(`fetch-player-profiles: ${fetched}/${toFetch.length} fetched, ${updated} updated`, ['players/', 'scripts/.fetch-player-profiles-progress.json']);
    }
  }
}

for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
  const batch = toFetch.slice(i, i + CONCURRENCY);
  await Promise.all(batch.map(uuid => processUUID(uuid)));
  if (BATCH_DELAY > 0 && i + CONCURRENCY < toFetch.length) {
    await new Promise(r => setTimeout(r, BATCH_DELAY));
  }
}

const _failedUUIDs = [...done].filter(u => !_presentUUIDs.has(u));
fs.writeFileSync('/tmp/failed-uuids.txt', _failedUUIDs.slice(0, 50).join('\n'), 'utf8');
console.log(`\n  Wrote ${Math.min(_failedUUIDs.length,50)} failed UUIDs to /tmp/failed-uuids.txt`);

if (!DRY_RUN) {
  writeJson(PROGRESS, { done: [...done] });
  gitCommit(`rebuild-player-stats: complete — ${updated} updated`, ['players/', 'scripts/.fetch-player-profiles-progress.json']);
  try { fs.unlinkSync(PROGRESS); gitCommit('rebuild-player-stats: remove progress', ['scripts/.fetch-player-profiles-progress.json']); } catch {}
}

console.log(`\nDone | fetched: ${fetched} | null: ${nulls} | updated: ${updated}`);
if (nullSample.length && nullSample.length < 10) { console.log('\nNull sample:'); nullSample.forEach(s => console.log(' ', s)); }
