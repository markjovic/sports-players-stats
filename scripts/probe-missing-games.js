// scripts/probe-missing-games.js
//
// READ-ONLY DIAGNOSTIC. Proves (or disproves) that hidden/grading games can be
// reconstructed from data we ALREADY receive, at zero extra API cost.
//
// Background: `size-appearance-gaps` measured 775,703 appearances PlayHQ counts that we
// cannot name locally. `size-spectator-queue` then showed only 18 of those sit in games we
// already hold inside zero-team seasons — so the residue is games ABSENT from games/bv
// entirely. Their ids are not in `player.games[]` (that array is built FROM games/bv, which
// is why the first gid scan was tautological — trap T24).
//
// But every nightly profile response already contains them. `publicProfileStatistics`
// returns `…gradeStatistics[].gameStatistics[]` with `game.id`, `game.round`,
// `game.home`/`game.away` (id + name) and that player's own stat line — and
// `fetch-profile-stats.js` walks exactly this path (L315) to build gameTids and per-reg
// totals, then discards any game we do not hold.
//
// This probe fetches a handful of profiles and reports, per game absent from games/bv:
// round, home/away, the player's team and their stat line. If those come back populated,
// a reconstruction pass needs NO new API calls — only the capture of what is already
// arriving. If they come back empty or null, the whole route is dead and we stop.
//
// Usage: node scripts/probe-missing-games.js --uuids=<uuid,uuid,...> [--limit=40]
//
// The query, headers, session handling and doFetch below are COPIED VERBATIM from the
// deployed scripts/fetch-profile-stats.js — never reconstructed (house rule). No writes,
// no git, no commits.

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const UUIDS = (args.find(a => a.startsWith('--uuids=')) || '').replace('--uuids=', '')
  .split(',').map(s => s.trim()).filter(Boolean);
const LIMIT = (() => { const a = args.find(a => a.startsWith('--limit=')); return a ? parseInt(a.split('=')[1]) : 40; })();

if (!UUIDS.length) {
  console.error('Usage: node scripts/probe-missing-games.js --uuids=<uuid,...> [--limit=N]');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const API_URL = 'https://api.playhq.com/graphql';
let sessionCookie = null;
let sessionPromise = null;

const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};


const COOKIE_QUERIES = [
  {
    operationName: 'TenantConfig',
    variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }',
  },
  {
    operationName: 'ProfileSearch',
    variables: { fullName: 'a' },
    query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
  },
];

async function refreshSession() {
  // If a refresh is already in flight, wait for it rather than firing another
  if (sessionPromise) return sessionPromise;

  // 2026-07-30 — TWO bugs fixed here, both exposed by a 413k forced sweep:
  //
  // (1) A socket-level failure ESCAPED the 10-attempt loop entirely. The retry
  //     loop only ever retried the "response arrived but carried no usable
  //     cookies" case (`continue`). An exception from doFetch — ECONNRESET,
  //     socket hang up, DNS — propagated out of BOTH for-loops, rejected the
  //     promise and killed the shard with `FATAL: read ECONNRESET`. A normal
  //     nightly refreshes a handful of times; a forced sweep refreshes every 28
  //     batches across 256 shards, so a rare reset became near-certain somewhere.
  //     Network errors are now caught per request and treated as a failed
  //     attempt, so all 10 attempts are actually used.
  //
  // (2) `sessionPromise` was NOT cleared on the throw path — the assignment at
  //     the end of the loop was skipped when doFetch threw, leaving a REJECTED
  //     promise cached in the lock. Every later refreshSession() would return
  //     that same rejected promise from the `if (sessionPromise)` fast path, so
  //     the shard could never recover even if the caller retried. Now cleared in
  //     a `.finally()`, which runs on success, throw AND rejection.
  sessionPromise = (async () => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (attempt > 1) await sleep(attempt * 5000);
      for (const body of COOKIE_QUERIES) {
        let res;
        try {
          res = await doFetch(API_URL, {
            method:  'POST',
            headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() },
            body:    JSON.stringify(body),
          });
        } catch (err) {
          lastErr = err;
          console.log(`  … session refresh attempt ${attempt} network error: ${err.code || err.message} — retrying`);
          continue;
        }
        const raw = res.headers.get('set-cookie');
        if (!raw) continue;
        // Extract each named cookie value, then reassemble in the exact order
        // the mobile client sends them: phq_tier first, phq_session, phq_sub.
        // (The server returns them in a different order in set-cookie headers.)
        const parts = raw.split(',').map(c => c.trim().split(';')[0]);
        const get = (name) => {
          const p = parts.find(c => c.startsWith(name + '='));
          return p || null;
        };
        const tier    = get('phq_tier');
        const session = get('phq_session');
        const sub     = get('phq_sub');
        if (!tier || !session || !sub) continue;
        sessionCookie = `${tier}; ${session}; ${sub}`;
        // NOTE: the exact string "Session refreshed (attempt N)" is used as
        // verification evidence in OUTSTANDING §A — do not reword it.
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    }
    throw new Error(`Failed to obtain session cookie after 10 attempts${lastErr ? ` (last network error: ${lastErr.code || lastErr.message})` : ''}`);
  })().finally(() => { sessionPromise = null; });

  return sessionPromise;
}


const PROFILE_QUERY = {
  operationName: 'ProfileSeasonStatistics',
  query: `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      name
      statistics {
        season { id }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          gradeStatistics {
            grade { id name }
            gameStatistics {
              game {
                id
                round { name number isFinalsRound abbreviatedName }
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
}`,
};

// doFetch: wraps https.request with keepAlive:false to force a new TCP connection
// per request. This prevents CloudFront per-connection rate limiting.
function doFetch(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body   = options.body || '';
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  { ...options.headers, 'content-length': Buffer.byteLength(body) },
      agent:    new https.Agent({ keepAlive: false }),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        // Build a headers.get() shim matching the Fetch API.
        // Node's https module stores set-cookie as an array; join with ', '
        // so our existing cookie-parsing code works unchanged.
        const hdrs = res.headers;
        const headers = {
          get(name) {
            const val = hdrs[name.toLowerCase()];
            if (val === undefined || val === null) return null;
            return Array.isArray(val) ? val.join(', ') : val;
          },
        };
        resolve({
          status:  res.statusCode,
          ok:      res.statusCode >= 200 && res.statusCode < 300,
          headers,
          text:    () => Promise.resolve(rawBody),
          json:    () => Promise.resolve(JSON.parse(rawBody)),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}


async function fetchProfile(profileID) {
  if (!sessionCookie) await refreshSession();
  const body = { ...PROFILE_QUERY, variables: { profileID } };
  let res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify(body),
    });
  } catch (err) { return { status: 'error', err }; }
  if (res.status === 403) {
    let b = ''; try { b = await res.text(); } catch {}
    if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { status: 'cloudfront-block' };
    return { status: 'private' };
  }
  if (res.status === 404) return { status: 'notfound' };
  if (!res.ok) return { status: `http-${res.status}` };
  let json; try { json = await res.json(); } catch (e) { return { status: 'bad-json' }; }
  if (json.errors) return { status: 'gql-error', errors: json.errors };
  return { status: 'ok', data: json.data };
}

// ─── Stat helper (same shape as the deployed parser) ─────────────────────────
function statValue(stats, type) {
  for (const s of (stats || [])) {
    const v = s?.details?.value;
    if (v === type) return s.count || 0;
  }
  return 0;
}

async function main() {
  // Which gids do we already hold?
  const gamesDir = path.join(ROOT, 'games', 'bv');
  const have = new Set();
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8'));
      for (const gid of Object.keys(sg.games || {})) have.add(gid);
    } catch { /* ignore */ }
  }
  console.log(`  Known gids on file: ${have.size.toLocaleString()}`);
  const seasons = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sports-index.json'), 'utf8')).seasons || {}; }
    catch { return {}; }
  })();

  // Per-player local appearance set = that player's OWN games[] array (built from p[]).
  // Classifying against BOTH sets separates the three populations that the aggregate
  // appearance-gap number conflates.
  const playerFileOf = (uuid) => {
    const p = path.join(ROOT, 'players', uuid.slice(0, 2), `${uuid}.json`);
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  };
  const playerGamesOf = (uuid) => {
    const j = playerFileOf(uuid);
    return j ? new Set(Array.isArray(j.games) ? j.games : []) : null;
  };
  // p[] stores TRUNCATED ids. A player can be present in p[] under a spectator-namespace
  // id that does not resolve to their api-canonical uuid — in which case they are already
  // recorded and the fix is ALIAS RESOLUTION (what fold-diverged-players does), not
  // appending a duplicate entry. Load the game and classify which of the two it is.
  const gameIndex = new Map();   // sid -> parsed season file (lazy)
  const inspectP = (sid, gid, uuid, specIds) => {
    if (!gameIndex.has(sid)) {
      try { gameIndex.set(sid, JSON.parse(fs.readFileSync(path.join(gamesDir, `${sid}.json`), 'utf8'))); }
      catch { gameIndex.set(sid, null); }
    }
    const sg = gameIndex.get(sid);
    const g  = sg && sg.games ? sg.games[gid] : null;
    if (!g) return { verdict: 'game-not-in-that-season-file' };
    const ids = new Set([...(g.p || []).map(x => x.id).filter(Boolean),
                         ...(g.hp || []).map(x => x.profileID).filter(Boolean),
                         ...(g.ap || []).map(x => x.profileID).filter(Boolean)]);
    const pref = uuid.slice(0, 13);
    if (ids.has(pref)) return { verdict: 'PRESENT-canonical', n: ids.size };
    for (const s of specIds) if (ids.has(s)) return { verdict: 'PRESENT-as-alias', alias: s, n: ids.size };
    const pref10 = uuid.slice(0, 10);
    for (const id of ids) if (id.startsWith(pref10)) return { verdict: 'PRESENT-legacy-10char', alias: id, n: ids.size };
    return { verdict: 'GENUINELY-ABSENT', n: ids.size, spc: g.spc || 0 };
  };
  const pVerdicts = new Map();

  let totalGames = 0, totalMissing = 0, totalNotInP = 0, totalOk = 0, shown = 0;
  const missingBySeason = new Map();
  const notInPBySeason  = new Map();

  for (const uuid of UUIDS) {
    console.log(`\n══ ${uuid} ══`);
    const r = await fetchProfile(uuid);
    if (r.status !== 'ok') { console.log(`  status=${r.status} — skipping`); continue; }
    const seasonStats = r.data?.publicProfileStatistics?.seasonStatistics || [];
    if (!seasonStats.length) { console.log('  no seasonStatistics'); continue; }
    const pf = playerFileOf(uuid);
    const localGids = pf ? new Set(Array.isArray(pf.games) ? pf.games : []) : null;
    const specIds = new Set(Array.isArray(pf?.spectatorIds) ? pf.spectatorIds : []);
    if (!localGids) console.log('  ⚠ player file not readable — p[] classification unavailable');
    else console.log(`  local games[] entries: ${localGids.size}  spectatorIds: ${[...specIds].join(',') || 'none'}`);

    for (const season of seasonStats) {
      for (const reg of (season.statistics || [])) {
        const sid = reg?.season?.id;
        if (!sid) continue;
        for (const teamStat of (reg.teamStatistics || [])) {
          const tid = teamStat.team?.id || null;
          for (const gradeStat of (teamStat.gradeStatistics || [])) {
            const gradeName = gradeStat.grade?.name || '?';
            for (const gs of (gradeStat.gameStatistics || [])) {
              totalGames++;
              const gid = gs.game?.id || null;
              if (!gid) continue;
              const gameHeld  = have.has(gid);
              const inPlayerP = localGids ? localGids.has(gid) : true;
              if (gameHeld && inPlayerP) { totalOk++; continue; }
              if (gameHeld) {
                // We HOLD the game — the player is simply absent from its p[].
                // Fixable by appending to p[]; no game synthesis needed.
                totalNotInP++;
                notInPBySeason.set(sid, (notInPBySeason.get(sid) || 0) + 1);
                if (shown >= LIMIT) continue;
                shown++;
                const insp = inspectP(sid, gid, uuid, specIds);
                pVerdicts.set(insp.verdict, (pVerdicts.get(insp.verdict) || 0) + 1);
                console.log(`  NOT-IN-P[] ${gid}  sid=${sid}  round=${gs.game?.round?.name ?? '?'}  tid=${tid}  → ${insp.verdict}${insp.alias ? ` (${insp.alias})` : ''} [p+hp+ap=${insp.n ?? '?'}${insp.spc !== undefined ? `, spc=${insp.spc}` : ''}]`);
                continue;
              }
              totalMissing++;
              missingBySeason.set(sid, (missingBySeason.get(sid) || 0) + 1);
              if (shown >= LIMIT) continue;
              shown++;
              const g = gs.game;
              const side = g.home?.id === tid ? 'HOME' : g.away?.id === tid ? 'AWAY' : '??';
              const st = gs.statistics || [];
              console.log(`  MISSING ${gid}  sid=${sid}${seasons[sid] ? ` (${seasons[sid].name || ''})` : ''}`);
              console.log(`    round : ${g.round?.name ?? 'NULL'} (n=${g.round?.number ?? '?'}, finals=${g.round?.isFinalsRound ?? '?'})`);
              console.log(`    home  : ${g.home?.id ?? 'NULL'} ${g.home?.name ?? ''}`);
              console.log(`    away  : ${g.away?.id ?? 'NULL'} ${g.away?.name ?? ''}`);
              console.log(`    grade : ${gradeName}`);
              console.log(`    player: tid=${tid} side=${side}  pts=${statValue(st,'TOTAL_SCORE')} fg=${statValue(st,'2_POINT_SCORE')} ft=${statValue(st,'1_POINT_SCORE')} 3pt=${statValue(st,'3_POINT_SCORE')} fouls=${statValue(st,'TOTAL_FOULS')} app=${statValue(st,'APPEARANCE')}`);
            }
          }
        }
      }
    }
    await sleep(1000);
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`  Profiles probed          : ${UUIDS.length}`);
  console.log(`  gameStatistics entries   : ${totalGames.toLocaleString()}`);
  console.log(`  already correct          : ${totalOk.toLocaleString()}`);
  console.log(`  GAME ABSENT from games/bv: ${totalMissing.toLocaleString()}  (needs game synthesis)`);
  console.log(`  PLAYER absent from p[]   : ${totalNotInP.toLocaleString()}  (game held — just append to p[])`);
  console.log(`  seasons w/ absent games  : ${missingBySeason.size}`);
  console.log(`  seasons w/ p[] gaps      : ${notInPBySeason.size}`);
  console.log('  Top seasons by missing games:');
  for (const [sid, n] of [...missingBySeason.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 10)) {
    const s = seasons[sid];
    console.log(`    ${sid}  ${String(n).padStart(4)}  ${s ? (s.name || '') + ' — ' + (s.orgName || '') : 'NOT IN sports-index'}`);
  }
  console.log('  p[] gap breakdown — THE decisive split:');
  for (const [v, n] of [...pVerdicts.entries()].sort((a,b)=>b[1]-a[1])) {
    console.log(`    ${v.padEnd(32,'.')} ${String(n).padStart(6)}`);
  }
  console.log('    PRESENT-* = already in the roster under another id → ALIAS/FOLD problem,');
  console.log('    do NOT append. GENUINELY-ABSENT = the roster really lacks them.');
  console.log('  Top seasons by p[] gaps:');
  for (const [sid, n] of [...notInPBySeason.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 10)) {
    const s = seasons[sid];
    console.log(`    ${sid}  ${String(n).padStart(4)}  ${s ? (s.name || '') + ' — ' + (s.orgName || '') : 'NOT IN sports-index'}`);
  }
  console.log('────────────────────────────────────────────────────────────');
  console.log('  VERDICT: if round/home/away/player-stats above are POPULATED, hidden-game');
  console.log('  reconstruction needs NO new API calls — only capturing what already arrives.');
  console.log('  If they are NULL, the route is dead and the residue is unrecoverable this way.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
