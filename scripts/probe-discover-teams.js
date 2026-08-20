// scripts/probe-discover-teams.js
//
// READ-ONLY. No writes, no git, no lock. A handful of API calls.
//
// THE QUESTION. `discover-fixtures.js` resolves a season's teams from
// `discoverGrade.ladder`. A GRADING grade returns `ladder: []` — not an error,
// grading rounds are not a competition — so a season whose indexed grades are all
// grading grades enumerates ZERO teams and no fixture is ever fetched for it.
// Measured offline 2026-08-19: 7 seasons are in that state, 6 of them ACTIVE,
// including EDJBA Winter 2026 (1ae60211, 55 grading grades against 263 live).
//
// The junior-footy-dashboard import records `discoverTeams(filter:{seasonID})` as
// returning every team in a season WITHOUT going through a ladder, and working on
// COMPLETED seasons where discoverFixtureByRound does not. If that holds on
// basketball-victoria it makes the grading problem moot — the sweep stops caring
// what the grade list says. **It is explicitly recorded as UNTESTED on this
// tenant**, and the reference also records `discoverOrganisation` working on `afl`
// while returning null here, so cross-tenant behaviour is not assumed.
//
// This tests it on the seasons that are actually broken, alongside a control
// season known to enumerate fine, and prints raw responses. It also compares what
// comes back against the grade list we store, since the import says each team
// carries its grade and owning club — both currently inferred.
//
// Usage:
//   node scripts/probe-discover-teams.js --seasons=1ae60211,aacc7335,7ccb2e98
//
// NO setup-node in the workflow (fetches api.playhq.com — absolute rule).

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (f, d) => { const a = args.find(x => x.startsWith('--' + f + '=')); return a ? a.split('=')[1] : d; };
const SEASONS = arg('seasons', '1ae60211,aacc7335,7ccb2e98').split(',').map(x => x.trim()).filter(Boolean);

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


// Query copied from the junior-footy-dashboard import in playhq_api_reference.md.
// organisationID is optional there; seasonID alone is the point of the call.
const Q_TEAMS = `query discoverTeamsBySeason($seasonId: ID!) {
  discoverTeams(filter: {seasonID: $seasonId}) {
    id name
    gender { value }
    ageGroup { value }
    grade { id name }
    organisation { id name }
  }
}`;

// The variable type is a guess in ONE direction only: the import shows ID!, but
// discoverSeason on this tenant needs String! where most fields take ID!. Rather
// than assume either, try ID! and fall back — and SAY which worked, so the
// reference can record it instead of the next person guessing again.
const Q_TEAMS_STR = Q_TEAMS.replace('$seasonId: ID!', '$seasonId: String!');
let workingType = null;

async function discoverTeams(seasonId) {
  if (!sessionCookie) await refreshSession();
  const variants = workingType ? [workingType] : [['ID!', Q_TEAMS], ['String!', Q_TEAMS_STR]];
  let last = '';
  for (const v of variants) {
    const [label, query] = v;
    let res;
    try {
      res = await doFetch(API_URL, {
        method: 'POST',
        headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
        body: JSON.stringify({ operationName: 'discoverTeamsBySeason', variables: { seasonId: seasonId }, query: query }),
      });
    } catch (err) { return { status: 'error', detail: err.message }; }
    if (res.status === 403) {
      let b = ''; try { b = await res.text(); } catch (e) {}
      return { status: (b.includes('DOCTYPE') || b.includes('Request blocked')) ? 'cloudfront-block' : 'http-403' };
    }
    if (!res.ok) {
      let b = ''; try { b = (await res.text()).slice(0, 300); } catch (e) {}
      last = label + ' → HTTP ' + res.status + ': ' + b.replace(/\s+/g, ' ');
      continue;
    }
    let json; try { json = await res.json(); } catch (e) { last = label + ' → bad-json'; continue; }
    if (json.errors && json.errors.length) {
      last = label + ' → gql: ' + json.errors.map(e => e.message).join(' | ').slice(0, 250);
      continue;
    }
    if (!workingType) { workingType = v; console.log('  variable type that works: ' + label); }
    const raw = (json.data || json)?.discoverTeams;
    return { status: 'ok', teams: Array.isArray(raw) ? raw : [], type: label };
  }
  return { status: 'failed', detail: last };
}

async function main() {
  console.log('probe-discover-teams [READ-ONLY] — seasons: ' + SEASONS.join(', '));

  let idx = {};
  try { idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sports-index.json'), 'utf8')).seasons || {}; } catch (e) {}

  // Grades our held games actually use, so the returned grades can be compared
  // against reality rather than against the (known short) index.
  const usedGrades = new Map();
  const gamesDir = path.join(ROOT, 'games', 'bv');
  for (const sid of SEASONS) {
    const f = path.join(gamesDir, sid + '.json');
    if (!fs.existsSync(f)) continue;
    let sg; try { sg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
    const m = new Map();
    for (const g of Object.values(sg.games || {})) if (g && g.gid) m.set(g.gid, (m.get(g.gid) || 0) + 1);
    usedGrades.set(sid, m);
  }

  for (const sid of SEASONS) {
    const meta = idx[sid] || {};
    const stored = Array.isArray(meta.grades) ? meta.grades : [];
    const gradingN = stored.filter(g => /grading/i.test(String((g && g.name) || ''))).length;
    console.log('\n── ' + sid + '  ' + (meta.fullName || meta.name || 'NOT IN INDEX') + ' — ' + (meta.orgName || '?') +
                (meta.locked ? ' [locked]' : ' [active]'));
    console.log('   index holds ' + stored.length + ' grades' +
                (stored.length && gradingN === stored.length ? ' — ALL GRADING (this season enumerates zero teams today)' :
                 gradingN ? ' (' + gradingN + ' grading)' : ''));

    const r = await discoverTeams(sid);
    await sleep(900);
    if (r.status !== 'ok') {
      console.log('   ✗ discoverTeams → ' + r.status + (r.detail ? ': ' + r.detail : ''));
      continue;
    }
    const teams = r.teams;
    const grades = new Map();
    const orgs = new Set();
    for (const t of teams) {
      const gid = t && t.grade && t.grade.id;
      if (gid) grades.set(gid, (t.grade.name || '?'));
      const oid = t && t.organisation && t.organisation.id;
      if (oid) orgs.add(oid);
    }
    console.log('   ✓ discoverTeams returned ' + teams.length + ' teams · ' + grades.size + ' distinct grades · ' + orgs.size + ' organisations');
    if (teams.length) console.log('     RAW first team: ' + JSON.stringify(teams[0]).slice(0, 300));

    const used = usedGrades.get(sid) || new Map();
    const storedIds = new Set(stored.map(g => String((g && g.id) || '')).filter(Boolean));
    const returned = new Set([...grades.keys()].map(x => String(x).slice(0, 8)));
    const usedIds = new Set([...used.keys()].map(x => String(x).slice(0, 8)));
    const coversUsed = [...usedIds].filter(x => returned.has(x)).length;
    const beyondIndex = [...returned].filter(x => !storedIds.has(x)).length;
    console.log('     grades our games use: ' + usedIds.size + ' · of those, discoverTeams covers ' + coversUsed);
    console.log('     grades it returns that the INDEX lacks: ' + beyondIndex);
    if (teams.length && stored.length && gradingN === stored.length) {
      console.log('     ⇒ THIS SEASON ENUMERATES ZERO TEAMS TODAY, AND THIS CALL RETURNED ' + teams.length + '.');
      console.log('       That is the fix: a route that does not go through a ladder.');
    }
  }

  console.log('\n  READ IT AS: teams returned for the all-grading seasons means discoverTeams');
  console.log('  replaces the ladder route and the grading problem stops mattering. Zero or an');
  console.log('  error means this tenant does not support it and the fix is instead to widen');
  console.log('  the grade-refresh in discover-seasons.js (L542), which currently only re-reads');
  console.log('  seasons sitting at grades:[] and so never revisits one captured mid-grading.');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
