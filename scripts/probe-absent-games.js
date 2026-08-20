// scripts/probe-absent-games.js
//
// READ-ONLY. No writes, no git, no lock. OUTSTANDING §2.18 follow-up.
//
// THE LAST REAL GAP. 133,459 appearances are still missing across 51,846 players.
// The repair campaign classified them: ~121,852 credits are for games NOT IN
// games/bv AT ALL, and ~39,061 are held games whose roster is empty. No repair
// can touch either — the first needs discovery, the second a capture sweep.
//
// Nothing has measured WHY the absent games are absent. `size-missing-gids` was
// retired as tautological (T24 — it compared games[] to its own source and always
// returned 0), and `synthesize-missing-games` last ran on 2026-08-07 finding just
// 9, which was before the campaign surfaced this population.
//
// This samples players with a positive gap, asks PlayHQ what games it credits
// them with, keeps the ones we do not hold, and characterises them BY SEASON:
//
//   season not in sports-index at all  → a DISCOVERY gap. discover-seasons never
//                                        found the season. Whole competitions
//                                        could be missing.
//   season known, no games/bv file     → discover-fixtures never ran for it.
//   season known, file exists, game    → a FIXTURE gap: we hold the season but
//     absent from it                     not that round or that grade.
//
// Those three have different fixes, and the split decides which tool to point at
// the problem. It also reports whether the seasons are locked, and how many games
// we already hold for them, so a season missing two games reads differently from
// a season missing all of them.
//
// Usage: node scripts/probe-absent-games.js --sample=60
//
// NO setup-node in the workflow (fetches api.playhq.com — absolute rule).

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const num = (f, d) => {
  const a = args.find(x => x.startsWith('--' + f + '='));
  const v = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : d;
};
const SAMPLE = num('sample', 60);
const SEED   = num('seed', 20260819);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

// 2026-08-14 — THIS FUNCTION HAD NO TIMEOUT, AND THAT HUNG A RUN FOR GOOD.
// `req.on('error')` catches a socket that FAILS. It does not catch a socket that
// opens and then goes silent — which is what a CloudFront throttle or a dropped
// connection looks like from here. No 'error', no 'end', so the promise never
// settled, and Node sets no default timeout on https.request. The min-gap=1 run
// stopped dead at 5,752 of 10,000 and sat there until it was killed.
//
// Sequential code had the same hole; running eight fetches in one Promise.all
// only made it eight times more likely to be hit, because ONE silent socket
// stalls the whole chunk and therefore the whole run.
//
// Two timers, because they catch different failures. IDLE fires when the socket
// goes quiet for 45s — the throttle case. HARD is an absolute ceiling on the
// whole request, for a response that dribbles bytes slowly enough to keep
// resetting the idle timer but never finishes. Both destroy the request, which
// raises 'error' and rejects, and `finish` guarantees the promise settles
// exactly once no matter which path gets there first.
const IDLE_TIMEOUT_MS = 45 * 1000;
const HARD_TIMEOUT_MS = 180 * 1000;

// doFetch: wraps https.request with keepAlive:false to force a new TCP connection
// per request. This prevents CloudFront per-connection rate limiting.
function doFetch(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body   = options.body || '';
    let settled = false;
    let hardTimer = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      fn(v);
    };
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  { ...options.headers, 'content-length': Buffer.byteLength(body) },
      agent:    new https.Agent({ keepAlive: false }),
      timeout:  IDLE_TIMEOUT_MS,
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
        finish(resolve, {
          status:  res.statusCode,
          ok:      res.statusCode >= 200 && res.statusCode < 300,
          headers,
          text:    () => Promise.resolve(rawBody),
          json:    () => Promise.resolve(JSON.parse(rawBody)),
        });
      });
      res.on('error', (e) => finish(reject, e));
    });
    req.on('timeout', () => {
      const e = new Error(`request idle for ${IDLE_TIMEOUT_MS / 1000}s`);
      e.code = 'ETIMEDOUT';
      req.destroy(e);
    });
    req.on('error', (e) => finish(reject, e));
    hardTimer = setTimeout(() => {
      const e = new Error(`request exceeded ${HARD_TIMEOUT_MS / 1000}s`);
      e.code = 'ETIMEDOUT';
      try { req.destroy(e); } catch (_) { /* already gone */ }
      finish(reject, e);
    }, HARD_TIMEOUT_MS);
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
  } catch (err) {
    // A timeout gets its own status so the log says "this request never came
    // back" rather than the catch-all "error". Both are transport, both are
    // retried, but only one of them tells you the endpoint went quiet on you.
    return { status: err && err.code === 'ETIMEDOUT' ? 'timeout' : 'error', err };
  }
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


async function main() {
  console.log('probe-absent-games [READ-ONLY] — sample=' + SAMPLE + ' seed=' + SEED);

  let idx = {};
  try { idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sports-index.json'), 'utf8')).seasons || {}; } catch (e) {}
  console.log('  seasons in sports-index: ' + Object.keys(idx).length.toLocaleString());

  // Which seasons we hold a games/bv file for, and how many games in each.
  const gamesDir = path.join(ROOT, 'games', 'bv');
  const heldGids = new Set();
  const gamesPerSeason = new Map();
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = path.basename(f, '.json');
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    const keys = Object.keys(sg.games || {});
    gamesPerSeason.set(sid, keys.length);
    for (const g of keys) heldGids.add(g);
  }
  console.log('  seasons with a games/bv file: ' + gamesPerSeason.size.toLocaleString() +
              '  ·  games held: ' + heldGids.size.toLocaleString());

  // Players with a positive gap: PlayHQ credits more than we hold.
  const playersDir = path.join(ROOT, 'players');
  const cand = [];
  for (const shard of fs.readdirSync(playersDir).filter(x => /^[0-9a-f]{2}$/.test(x))) {
    for (const f of fs.readdirSync(path.join(playersDir, shard))) {
      if (!f.endsWith('.json')) continue;
      let p; try { p = JSON.parse(fs.readFileSync(path.join(playersDir, shard, f), 'utf8')); } catch (e) { continue; }
      let gp = 0, has = false;
      for (const s of Object.values(p.sports || {})) if (s && typeof s.gp === 'number') { gp += s.gp; has = true; }
      if (!has) continue;
      const held = Array.isArray(p.games) ? p.games.length : 0;
      if (gp - held <= 0) continue;
      cand.push({ uuid: f.replace(/\.json$/, ''), name: p.name || '?', apiId: p.apiId || null, gap: gp - held });
    }
  }
  console.log('  players with a positive gap: ' + cand.length.toLocaleString());
  if (!cand.length) { console.log('  nothing to probe'); return; }

  const rnd = mulberry32(SEED);
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
  const targets = cand.slice(0, SAMPLE);
  console.log('  probing: ' + targets.length + '\n');

  let ok = 0, failed = 0, credits = 0, absent = 0;
  const byStatus = new Map();
  const cls = new Map();          // classification -> absent credits
  const perSeason = new Map();    // sid -> { absent, known, hasFile, held, locked, name }
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  for (const t of targets) {
    const r = await fetchProfile(t.apiId || t.uuid);
    if (r.status !== 'ok') {
      failed++; bump(byStatus, r.status);
      await sleep(1100);
      continue;
    }
    ok++;
    for (const season of (r.data?.publicProfileStatistics?.seasonStatistics || [])) {
      for (const reg of (season.statistics || [])) {
        const sid = reg.season?.id || null;
        for (const ts of (reg.teamStatistics || [])) {
          for (const gs of (ts.gradeStatistics || [])) {
            for (const g of (gs.gameStatistics || [])) {
              const gid = g?.game?.id;
              if (!gid) continue;
              credits++;
              if (heldGids.has(gid)) continue;
              absent++;
              const known = sid ? !!idx[sid] : false;
              const hasFile = sid ? gamesPerSeason.has(sid) : false;
              const key = !sid ? 'no season id on the credit'
                        : !known ? 'season NOT in sports-index — discovery gap'
                        : !hasFile ? 'season known, NO games/bv file — fixtures never run'
                        : 'season known and held — FIXTURE gap (round or grade missing)';
              bump(cls, key);
              if (sid) {
                let e = perSeason.get(sid);
                if (!e) {
                  e = { absent: 0, known: known, hasFile: hasFile, held: gamesPerSeason.get(sid) || 0,
                        locked: !!(idx[sid] && idx[sid].locked), name: (idx[sid] && (idx[sid].fullName || idx[sid].name)) || '?',
                        org: (idx[sid] && idx[sid].orgName) || '?' };
                  perSeason.set(sid, e);
                }
                e.absent++;
              }
            }
          }
        }
      }
    }
    await sleep(1100);
  }

  const pc = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';
  console.log('\n════════════════════════════════════════════════');
  console.log('  players probed        : ' + ok + '  (failed ' + failed + ')');
  for (const [k, v] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) console.log('      ' + String(v).padStart(4) + '  ' + k);
  console.log('  game credits seen     : ' + credits.toLocaleString());
  console.log('  of those, NOT in games/bv: ' + absent.toLocaleString() + '  (' + pc(absent, credits) + '%)');
  console.log('');
  console.log('  WHY THE GAME IS ABSENT:');
  for (const [k, v] of [...cls.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('    ' + String(v).padStart(7) + '  (' + pc(v, absent).padStart(5) + '%)  ' + k);
  }
  console.log('');
  console.log('  TOP SEASONS BY ABSENT CREDITS:');
  const rows = [...perSeason.entries()].sort((a, b) => b[1].absent - a[1].absent).slice(0, 20);
  for (const [sid, e] of rows) {
    console.log('    ' + sid + '  absent ' + String(e.absent).padStart(5) +
                '  · we hold ' + String(e.held).padStart(6) + ' games' +
                (e.known ? (e.hasFile ? '' : '  [NO games/bv FILE]') : '  [NOT IN INDEX]') +
                (e.locked ? ' [locked]' : '') + '  ' + e.name + ' — ' + e.org);
  }
  console.log('');
  console.log('  HOW TO READ IT:');
  console.log('    "NOT in sports-index" dominating → discover-seasons is missing competitions.');
  console.log('      That is the biggest possible win: whole seasons, not scattered games.');
  console.log('    "NO games/bv file" dominating → the seasons are known but discover-fixtures has');
  console.log('      never run for them. A targeted fixture sweep closes it.');
  console.log('    "FIXTURE gap" dominating → we hold the season but not those rounds or grades.');
  console.log('      Check whether the seasons listed above are ones where we hold FEW games — a');
  console.log('      season with 8,000 held and 3 absent is noise; one with 40 held and 300 absent');
  console.log('      was barely swept at all.');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
