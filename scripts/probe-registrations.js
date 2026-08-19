// scripts/probe-registrations.js
//
// READ-ONLY. No writes, no git, no lock.
//
// THE QUESTION. 1,115,172 appearances sit in games where the player holds a
// registration for that SEASON but not for either TEAM in the game. The rosters
// themselves are verified correct against PlayHQ's own API (2026-08-18: 55 games
// re-fetched, zero cases of the live box holding anyone we lack). So the games are
// real and the registration list is short.
//
// fetch-profile-stats.js writes registrations ONLY from
// publicProfileStatistics.seasonStatistics (line ~1023). But that cannot be the
// whole story: Lara Hansen has 51 of 56 registrations carrying a stats block, so
// seasonStatistics clearly does return teams that have only wins and losses. Two
// candidates remain and they need OPPOSITE responses:
//
//   A. PlayHQ HAS the registration and seasonStatistics does not surface it.
//      publicProfileTeams (documented in playhq_api_reference.md) returns every
//      registration — UPCOMING, ACTIVE, COMPLETED — independent of statistics.
//      If it returns the missing teams, the fix is to source registrations there.
//
//   B. The player was a FILL-IN and never registered. PlayHQ marks these in the
//      box score. publicProfileTeams would not list them either, the appearance is
//      real, and the 1.1 million is EXPECTED rather than a gap to close.
//
// This asks both queries for the same players and reports whether the teams from
// the wrong games appear in publicProfileTeams. That is the difference between a
// fix worth building and a number to stop worrying about.
//
// Usage:
//   node scripts/probe-registrations.js --sample=40
//   node scripts/probe-registrations.js --uuid=<player uuid>
//
// NO setup-node in the workflow (fetches api.playhq.com — absolute rule).

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const ROOT = path.join(__dirname, '..');
const TRUNC_LEN = 13;
const args = process.argv.slice(2);
const num = (f, d) => {
  const a = args.find(x => x.startsWith('--' + f + '='));
  const v = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : d;
};
const SAMPLE = num('sample', 40);
const SEED   = num('seed', 20260818);
const ONLY   = (args.find(x => x.startsWith('--uuid=')) || '').split('=')[1] || '';

// Defined here: it sits above the extraction point in repair-players-batch.js,
// so the copied stack does not bring it (T31 — this is the second script in a row
// to need it, and the dependency check caught it before delivery this time).
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


// ─── publicProfileTeams ───────────────────────────────────────────────────────
// SHAPE TAKEN FROM playhq_api_reference.md, INLINE FRAGMENT INCLUDED. The block
// at line 539 of that file omits it and is wrong; the SEVEN other DiscoverTeam
// sites in the same document (lines 214, 271, 321, 343, 432, 441) all use
// `... on DiscoverTeam { ... }`, because DiscoverTeam is a union member. Copying
// the block without checking it against the working examples produced
//   Cannot query field "teams" on type "DiscoverTeam". Did you mean "name"?
// on 100 of 100 players, and my "maybe it's String!" fallback then added a SECOND
// error on top of the real one. ID! was right the whole time.
//
// AND THE CAVEAT AT LINE 643, which decides what this probe can conclude:
//   "publicProfileTeams grade for COMPLETED seasons — Returns NULL (grade only
//    present for the player's CURRENT rego)"
// So grade is requested but never relied on. Team id and season id are what the
// comparison needs, and those are present for completed seasons.
const PROFILE_TEAMS_QUERY = `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    ... on DiscoverTeam {
      id
      name
      season { id name competition { id name } }
      organisation { id name }
    }
  }
}`;

async function fetchProfileTeams(profileID) {
  if (!sessionCookie) await refreshSession();
  let res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
      body: JSON.stringify({ operationName: 'PublicProfileTeams', variables: { profileID }, query: PROFILE_TEAMS_QUERY }),
    });
  } catch (err) { return { status: 'error', detail: String(err.message).slice(0, 200) }; }
  if (res.status === 403) return { status: 'private' };
  if (res.status === 404) return { status: 'notfound' };
  if (!res.ok) {
    let txt = '';
    try { txt = (await res.text()).slice(0, 300); } catch (e) { txt = '(body unreadable)'; }
    return { status: 'http-' + res.status, detail: txt.replace(/\s+/g, ' ') };
  }
  let json;
  try { json = await res.json(); } catch (err) { return { status: 'bad-json' }; }
  if (json.errors && json.errors.length) {
    return { status: 'gql-error', detail: String(json.errors[0].message || '').slice(0, 200) };
  }
  // The field returns the team list DIRECTLY — no `teams` wrapper. That wrapper
  // is what the reference block got wrong.
  const raw = (json.data || json)?.publicProfileTeams;
  const arr = Array.isArray(raw) ? raw : [];
  return { status: 'ok', teams: arr };
}

async function main() {
  console.log('probe-registrations [READ-ONLY] — sample=' + SAMPLE + ' seed=' + SEED + (ONLY ? ' uuid=' + ONLY : ''));

  // Players and their stored registrations.
  const playersDir = path.join(ROOT, 'players');
  const regsOf = new Map(), heldOf = new Map(), nameOf = new Map();
  for (const shard of fs.readdirSync(playersDir).filter(x => /^[0-9a-f]{2}$/.test(x))) {
    for (const f of fs.readdirSync(path.join(playersDir, shard))) {
      if (!f.endsWith('.json')) continue;
      const uuid = f.replace(/\.json$/, '');
      if (ONLY && uuid !== ONLY) continue;
      let p; try { p = JSON.parse(fs.readFileSync(path.join(playersDir, shard, f), 'utf8')); } catch (e) { continue; }
      const t = new Set();
      for (const x of (Array.isArray(p.teams) ? p.teams : [])) if (x && x.tid) t.add(x.tid);
      for (const se of (Array.isArray(p.seasons) ? p.seasons : [])) {
        for (const r of (Array.isArray(se.regs) ? se.regs : [])) if (r && r.tid) t.add(r.tid);
      }
      if (!t.size) continue;
      regsOf.set(uuid, t);
      heldOf.set(uuid, Array.isArray(p.games) ? p.games : []);
      nameOf.set(uuid, p.name || '?');
    }
  }

  // Games, so the teams of the wrong appearances can be named.
  const gamesDir = path.join(ROOT, 'games', 'bv');
  const gameTeams = new Map();
  const wanted = new Set();
  for (const [, gl] of heldOf) for (const g of gl) wanted.add(g);
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const gid of Object.keys(sg.games || {})) {
      if (!wanted.has(gid)) continue;
      const g = sg.games[gid];
      gameTeams.set(gid, { h: g.h || null, a: g.a || null, hn: g.hn || '', an: g.an || '' });
    }
  }

  // Players holding at least one game whose teams they are not registered to.
  const cand = [];
  for (const [uuid, gl] of heldOf) {
    const t = regsOf.get(uuid);
    const missing = new Map();   // tid -> count
    for (const gid of gl) {
      const g = gameTeams.get(gid);
      if (!g) continue;
      if ((g.h && t.has(g.h)) || (g.a && t.has(g.a))) continue;
      for (const tid of [g.h, g.a]) if (tid) missing.set(tid, (missing.get(tid) || 0) + 1);
    }
    if (missing.size) cand.push({ uuid: uuid, name: nameOf.get(uuid), stored: t, missing: missing });
  }
  console.log('  players with unregistered-team appearances: ' + cand.length.toLocaleString());
  if (!cand.length) { console.log('  nothing to probe'); return; }

  const rnd = mulberry32(SEED);
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
  const targets = cand.slice(0, SAMPLE);
  console.log('  probing: ' + targets.length + '\n');

  let ok = 0, failed = 0;
  let sumStored = 0, sumLive = 0, sumExtra = 0;
  let missingCovered = 0, missingNotCovered = 0;
  let playersFullyExplained = 0, playersPartly = 0, playersNotAtAll = 0;
  const byStatus = new Map();

  for (const c of targets) {
    const r = await fetchProfileTeams(c.uuid);
    if (r.status !== 'ok') {
      failed++;
      byStatus.set(r.status + (r.detail ? ' — ' + r.detail : ''), (byStatus.get(r.status + (r.detail ? ' — ' + r.detail : '')) || 0) + 1);
      console.log('  ✗ ' + c.uuid + '  ' + r.status + (r.detail ? '  ' + r.detail : ''));
      await sleep(1200);
      continue;
    }
    ok++;
    const live = new Set();
    for (const t of r.teams) { const id = t && t.id; if (id) live.add(String(id).slice(0, 8)); }
    // Stored team ids are 8-char; publicProfileTeams returns full uuids.
    const storedShort = new Set([...c.stored].map(x => String(x).slice(0, 8)));
    const extra = [...live].filter(x => !storedShort.has(x));
    sumStored += storedShort.size; sumLive += live.size; sumExtra += extra.length;

    let covered = 0, notCovered = 0;
    for (const [tid] of c.missing) {
      if (live.has(String(tid).slice(0, 8))) covered++; else notCovered++;
    }
    missingCovered += covered; missingNotCovered += notCovered;
    if (covered && !notCovered) playersFullyExplained++;
    else if (covered) playersPartly++;
    else playersNotAtAll++;

    console.log('  ' + (notCovered === 0 ? '✓' : covered ? '~' : '✗') + ' ' + c.uuid + '  ' + JSON.stringify(c.name) +
                '  stored ' + String(storedShort.size).padStart(3) + '  publicProfileTeams ' + String(live.size).padStart(3) +
                '  (+' + extra.length + ' we lack)   unregistered teams: ' + covered + ' listed / ' + notCovered + ' NOT listed');
    await sleep(1200);
  }

  const pc = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';
  console.log('\n════════════════════════════════════════════════');
  console.log('  players probed                 : ' + ok + '   (failed ' + failed + ')');
  for (const [k, v] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) console.log('      ' + String(v).padStart(4) + '  ' + k);
  if (!ok) { console.log('  nothing fetched — cannot conclude'); return; }
  console.log('  registrations we store         : ' + sumStored + '  (' + (sumStored / ok).toFixed(1) + ' per player)');
  console.log('  registrations publicProfileTeams returns: ' + sumLive + '  (' + (sumLive / ok).toFixed(1) + ' per player)');
  console.log('  registrations it has that we LACK      : ' + sumExtra + '  (' + (sumExtra / ok).toFixed(1) + ' per player)');
  console.log('');
  console.log('  THE ANSWER — teams the player appeared for but is not registered to:');
  console.log('    publicProfileTeams DOES list them : ' + missingCovered + '  (' + pc(missingCovered, missingCovered + missingNotCovered) + '%)');
  console.log('    it does NOT list them             : ' + missingNotCovered + '  (' + pc(missingNotCovered, missingCovered + missingNotCovered) + '%)');
  console.log('    players fully explained by it     : ' + playersFullyExplained + ' / partly ' + playersPartly + ' / not at all ' + playersNotAtAll);
  console.log('');
  console.log('  Mostly LISTED  → PlayHQ holds registrations that seasonStatistics never surfaces,');
  console.log('                   and fetch-profile-stats.js should source them from');
  console.log('                   publicProfileTeams instead of inferring them from stats.');
  console.log('  Mostly NOT     → these are FILL-INS, who never registered. The appearances are real,');
  console.log('                   the registration genuinely does not exist, and the 1.1M is expected');
  console.log('                   rather than a gap. Stop treating it as one.');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
