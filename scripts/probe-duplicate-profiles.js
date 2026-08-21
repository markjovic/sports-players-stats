// scripts/probe-duplicate-profiles.js
//
// READ-ONLY. No writes, no git, no lock.
//
// THE QUESTION. size-duplicate-profiles found 2,895 pairs of same-named player
// files holding the SAME game ids — 122,866 duplicated appearances, one human
// counted twice in every one of them. It cannot tell which file is real, because
// offline both are 36-char uuids carrying data.
//
// PlayHQ can. On 2026-08-21, /public/profile/20b2df06.../statistics resolved and
// /public/profile/f806d1b6.../statistics returned "There was a problem getting the
// profile". This asks the same question through the API for BOTH sides of every
// pair, and sorts the result into the four cases that need different work:
//
//   BOTH RESOLVE   → PlayHQ genuinely has two profiles for one person. Nothing to
//                    delete. Only a merge helps, and a merge on a name match is a
//                    judgement, not a fact.
//   ONE RESOLVES   → the other uuid is not a PlayHQ profile. THAT file should not
//                    exist. This is the case with a clean fix.
//   NEITHER        → both are unknown to PlayHQ. Something invented both.
//   PRIVATE        → 403/private on one or both. Cannot be judged this way at all;
//                    a private profile withholds statistics but still exists.
//
// It reports the counts, and for the ONE-RESOLVES case it names which uuid to keep
// — the only actionable output here. Nothing is written; deciding what to do with
// 2,895 pairs is not a thing to bury inside a probe.
//
// Usage:
//   node scripts/probe-duplicate-profiles.js --sample=200
//   node scripts/probe-duplicate-profiles.js --all
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
const ALL    = args.includes('--all');
const SAMPLE = num('sample', 200);
const SEED   = num('seed', 20260821);
// 700ms cost 834 pairs to CloudFront on the first full run. 1500 is the floor now,
// and --pace= raises it further if the wall is still hit.
const PACE_MS = num('pace', 1500);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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


// Does PlayHQ serve this profile at all? fetchProfile (copied stack) already
// classifies the outcomes; this only needs the verdict, not the data.
async function profileExists(uuid) {
  const r = await fetchProfile(uuid);
  if (r.status === 'ok')        return 'resolves';
  if (r.status === 'private')   return 'private';
  if (r.status === 'notfound')  return 'notfound';
  if (r.status === 'gql-error') {
    const m = String((r.errors && r.errors[0] && r.errors[0].message) || '');
    // NOT_FOUND here means PlayHQ has no such profile. It was re-admitted as
    // "transient" on 2026-08-19 on the strength of one probe; players retired on it
    // then died on it again three times running, so it is treated as an ANSWER here
    // and the count is reported so the assumption stays visible.
    if (/NOT_FOUND|failed to find profile/i.test(m)) return 'notfound';
    return 'gql-error';
  }
  return r.status;
}

async function main() {
  console.log('probe-duplicate-profiles [READ-ONLY] — ' + (ALL ? 'ALL pairs' : 'sample=' + SAMPLE));

  // Rebuild the pairs exactly as size-duplicate-profiles does: same normalised
  // name, at least one game id held by both.
  const playersDir = path.join(ROOT, 'players');
  const meta = new Map();
  const holders = new Map();
  for (const shard of fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d))) {
    const dir = path.join(playersDir, shard);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let p; try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
      const uuid = f.replace(/\.json$/, '');
      const games = Array.isArray(p.games) ? p.games : [];
      let gp = null;
      for (const s of Object.values(p.sports || {})) if (s && typeof s.gp === 'number') gp = (gp || 0) + s.gp;
      meta.set(uuid, { key: normName(p.name), name: p.name || '?', games: games.length, gp,
                       priv: p.private === true, spec: (p.spectatorIds || []).length });
      for (const g of games) { const a = holders.get(g); if (a) a.push(uuid); else holders.set(g, [uuid]); }
    }
  }
  const pairShared = new Map();
  for (const [, list] of holders) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = meta.get(list[i]), b = meta.get(list[j]);
      if (!a || !b || !a.key || a.key !== b.key) continue;
      const k = list[i] < list[j] ? list[i] + '|' + list[j] : list[j] + '|' + list[i];
      pairShared.set(k, (pairShared.get(k) || 0) + 1);
    }
  }
  holders.clear();
  let pairs = [...pairShared.entries()].map(([k, shared]) => {
    const [ua, ub] = k.split('|');
    return { ua, ub, shared, a: meta.get(ua), b: meta.get(ub) };
  }).sort((x, y) => y.shared - x.shared);
  console.log('  pairs found: ' + pairs.length.toLocaleString());

  if (!ALL) {
    const rnd = mulberry32(SEED);
    const c = pairs.slice();
    for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
    pairs = c.slice(0, SAMPLE);
  }
  console.log('  probing    : ' + pairs.length.toLocaleString() + ' pairs (' + (pairs.length * 2).toLocaleString() + ' calls)\n');

  // ── VERDICT CACHE ──────────────────────────────────────────────────────────
  // The 2026-08-21 run asked 5,511 profiles in an hour, hit CloudFront on 834
  // pairs, and threw EVERY verdict away when the runner was destroyed. A re-run
  // therefore starts from zero and re-asks the 4,677 that already answered.
  //
  // Verdicts are cached to disk and reloaded, so a second dispatch asks only the
  // ones that never got an answer. `cloudfront-block` and every other transport
  // outcome are NOT cached — only real answers are, so a block is always retried
  // and never mistaken for a result.
  const CACHE = path.join(ROOT, 'reports', 'duplicate-profile-verdicts.json');
  const seen = new Map();          // uuid -> verdict, so a uuid in two pairs is asked once
  try {
    const prev = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    for (const [u, v] of Object.entries(prev.verdicts || {})) seen.set(u, v);
    console.log('  verdict cache: ' + seen.size.toLocaleString() + ' profile(s) already answered — these will not be asked again');
  } catch (e) { console.log('  verdict cache: none yet (first run)'); }
  const saveCache = () => {
    try {
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify({ saved: new Date().toISOString(),
        verdicts: Object.fromEntries(seen) }, null, 1));
    } catch (e) { console.log('  ⚠ could not save verdict cache: ' + e.message); }
  };
  // Only ANSWERS are cached. A transport outcome must always be retried, or one
  // throttled afternoon becomes a permanent verdict.
  const ANSWERS = new Set(['resolves', 'private', 'notfound']);
  let asked = 0, blocked = 0;
  const ask = async (u) => {
    if (seen.has(u)) return seen.get(u);
    const v = await profileExists(u);
    asked++;
    if (ANSWERS.has(v)) seen.set(u, v);
    else blocked++;
    // Back off hard on a block rather than carrying on into a wall: the previous
    // run lost 834 pairs by pacing straight through one. PACE_MS is the floor,
    // and a block adds a cooling period that decays as clean calls return.
    if (v === 'cloudfront-block' || v === 'http-429') {
      cool = Math.min(30000, (cool || PACE_MS) * 2);
      await sleep(cool);
    } else if (cool > PACE_MS) {
      cool = Math.max(PACE_MS, Math.floor(cool / 2));
    }
    await sleep(Math.max(PACE_MS, cool));
    return v;
  };
  let cool = 0;

  const buckets = new Map();
  const oneResolves = [];
  let done = 0;
  for (const p of pairs) {
    const va = await ask(p.ua), vb = await ask(p.ub);
    const rA = va === 'resolves', rB = vb === 'resolves';
    const nA = va === 'notfound', nB = vb === 'notfound';
    let cls;
    if (rA && rB) cls = 'BOTH resolve — two real PlayHQ profiles';
    else if ((rA && nB) || (rB && nA)) { cls = 'ONE resolves, other NOT FOUND — the other file should not exist'; oneResolves.push({ p, keep: rA ? p.ua : p.ub, drop: rA ? p.ub : p.ua, shared: p.shared }); }
    else if (nA && nB) cls = 'NEITHER resolves — both unknown to PlayHQ';
    else if (va === 'private' || vb === 'private') cls = 'PRIVATE on one or both — cannot be judged this way';
    else cls = 'other: ' + va + ' / ' + vb;
    buckets.set(cls, (buckets.get(cls) || 0) + 1);
    done++;
    if (done % 25 === 0) {
      console.log('  … ' + done + '/' + pairs.length + ' pairs · asked ' + asked +
                  ' · cached ' + seen.size + ' · blocked ' + blocked + (cool > PACE_MS ? ' · cooling ' + cool + 'ms' : ''));
      saveCache();   // survive a timeout: the next dispatch resumes from here
    }
  }

  saveCache();
  const pc = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';
  console.log('\n════════════════════════════════════════════════');
  if (blocked) {
    console.log('  ⚠ ' + blocked.toLocaleString() + ' call(s) were BLOCKED or throttled and got no answer.');
    console.log('    They are NOT cached. Re-dispatch and only those are asked again.');
  }
  console.log('  pairs classified : ' + done.toLocaleString() + '   (profiles asked: ' + seen.size.toLocaleString() + ')');
  for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('    ' + String(v).padStart(6) + '  (' + pc(v, done).padStart(5) + '%)  ' + k);
  }
  console.log('');
  if (oneResolves.length) {
    console.log('  ══ ACTIONABLE: one side is not a PlayHQ profile ══════════════════');
    console.log('  KEEP the resolving uuid; the other file holds appearances that belong to it.');
    // DEFENSIVE, because the 2026-08-21 run printed "Jack Brown (155 shared games)"
    // with NO keep/drop lines under it. A silent gap in a list someone is going to
    // ACT on is worse than a loud one: resolve each side once, say plainly when a
    // side is missing, and never let a hole look like a formatting quirk.
    let printGaps = 0;
    for (const x of oneResolves.slice(0, 40)) {
      const k = meta.get(x.keep), d = meta.get(x.drop);
      const label = (k && k.name) || (d && d.name) || '(name unavailable)';
      console.log('    ' + JSON.stringify(label) + '  (' + x.shared + ' shared games)');
      if (k) console.log('      KEEP : ' + x.keep + '  games=' + k.games + ' gp=' + (k.gp ?? '—'));
      else { console.log('      KEEP : ' + x.keep + '  ⚠ NO PLAYER RECORD LOADED FOR THIS UUID'); printGaps++; }
      if (d) console.log('      DROP : ' + x.drop + '  games=' + d.games + ' gp=' + (d.gp ?? '—'));
      else { console.log('      DROP : ' + x.drop + '  ⚠ NO PLAYER RECORD LOADED FOR THIS UUID'); printGaps++; }
    }
    if (oneResolves.length > 40) console.log('    … and ' + (oneResolves.length - 40) + ' more — the FULL list is in the file below, not truncated');
    if (printGaps) console.log('    ⚠ ' + printGaps + ' side(s) had no loaded player record — investigate before acting on this list');

    // THE LIST MUST NOT ONLY EXIST AS LOG TEXT. The next step (writing aliases so a
    // phantom's appearances move to the real profile before its file is removed)
    // needs this as input, and parsing it back out of a truncated Actions log is
    // how a wrong uuid gets acted on. Written as data, every pair, no cap.
    try {
      const outPath = path.join(ROOT, 'reports', 'duplicate-profile-pairs.json');
      const payload = {
        generated: new Date().toISOString(),
        probed: done,
        classification: Object.fromEntries(buckets),
        actionable: oneResolves.map(x => ({
          keep: x.keep, drop: x.drop, shared: x.shared,
          keepName: (meta.get(x.keep) || {}).name || null,
          dropName: (meta.get(x.drop) || {}).name || null,
          keepGames: (meta.get(x.keep) || {}).games ?? null,
          dropGames: (meta.get(x.drop) || {}).games ?? null,
        })),
      };
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 1));
      console.log('');
      console.log('  FULL LIST WRITTEN: reports/duplicate-profile-pairs.json (' + oneResolves.length + ' actionable pairs)');
      console.log('  READ-ONLY as far as player data goes — this is a report, nothing in players/ or games/ is touched.');
    } catch (e) {
      console.log('  ⚠ could not write reports/duplicate-profile-pairs.json: ' + e.message);
    }
  }
  console.log('');
  console.log('  HOW TO READ IT:');
  console.log('    BOTH resolve dominating → PlayHQ really does issue two profiles per person');
  console.log('      at scale. Nothing can be deleted; only a merge helps, and a merge keyed on');
  console.log('      a NAME MATCH is a judgement. That would need its own design decision.');
  console.log('    ONE resolves dominating → the non-resolving files should not exist, and the');
  console.log('      question becomes what created them — that is a pipeline fault still running.');
  console.log('    PRIVATE dominating → this test cannot answer it and a different one is needed.');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
