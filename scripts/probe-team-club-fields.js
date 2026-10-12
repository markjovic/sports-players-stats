// scripts/probe-team-club-fields.js
//
// READ-ONLY. No writes, no git, no lock. A dozen API calls at most.
//
// ── THE QUESTION ─────────────────────────────────────────────────────────────
// A team entered in a TOURNAMENT carries the TOURNAMENT as its `organisation`,
// not the club that owns it. Measured live against season 0869ea69 (Nunawading
// Spectres Tournament 2026, 1,235 teams) on 2026-10-12:
//
//     mapped to a real club by PlayHQ ....  294
//     mapped to "Nunawading Spectres
//       Tournament" (the host org) ......  941
//
// So it is NOT that tournaments never carry a club — Altona Gators, Diamond
// Valley Eagles, Maroondah Magic and 29 others came through correctly in that
// same season. It is decided per team by whoever created it in PlayHQ: entered
// by the club, it carries the club; entered under the tournament, it carries the
// tournament. Mark's read, confirmed by the split above.
//
// Across data/club-index.json that is 23 tournament organisations holding 10,220
// of 408,784 teams — 2.5%.
//
// The team NAME still carries the club ("Spirit Magic U14 Boys"), and 981 of the
// 1,235 names in that season contain a club that exists in the index. But
// inferring from the name is measurably wrong: on the 294 teams where PlayHQ
// gave a real club AND the name can be checked against it, a longest-match
// resolver disagrees on 68 — Club-vs-Association near-duplicates ("Blackburn
// Vikings Basketball Club" vs "... Association") and development squads whose
// name omits the parent ("Sandringham Future Sabres", "Darebin Future Phoenix").
//
// ⚠️ SO: BEFORE INFERRING ANYTHING FROM A NAME, ESTABLISH WHETHER PLAYHQ HOLDS
// THE OWNING CLUB ON A FIELD WE ARE SIMPLY NOT ASKING FOR. That is this probe's
// only job. Q_TEAMS in probe-discover-teams.js asks for five fields because that
// is what the junior-footy-dashboard import happened to ask for — it was never a
// statement about what the Team type exposes.
//
// ── HOW IT ANSWERS IT ────────────────────────────────────────────────────────
// 1. INTROSPECTION. `__type(name:"Team"){fields{...}}`. If the endpoint allows
//    it this is definitive and the rest is confirmation. Production endpoints
//    often disable introspection, so a refusal here is expected, not a failure.
//
// 2. ERROR-DRIVEN FIELD DISCOVERY. Ask for a superset of candidate fields in one
//    query. GraphQL validation names every unknown field precisely — `Cannot
//    query field "club" on type "Team"` — so each rejected field is dropped and
//    the query re-sent until it validates. What survives is what exists. This
//    needs no introspection and cannot invent a field.
//
// 3. POPULATION. Run the surviving query against the tournament season and
//    report, SEPARATELY for teams whose organisation IS the host org and teams
//    whose organisation is a real club, which fields are populated. A field that
//    exists but is null on exactly the teams we need is not an answer.
//
// 4. SPECIMENS. Dump full team objects side by side — one tournament-attributed,
//    one club-attributed — so the shape is visible rather than described.
//
// A field only counts if it is POPULATED ON THE TOURNAMENT-ATTRIBUTED TEAMS.
// Step 3 is the one that decides; steps 1 and 2 only narrow what to look at.
//
// Usage:
//   node scripts/probe-team-club-fields.js
//   node scripts/probe-team-club-fields.js --season=0869ea69
//   node scripts/probe-team-club-fields.js --season=0869ea69 --host-org=c4f7147a
//   node scripts/probe-team-club-fields.js --specimens=4 --no-introspect
//
// NO setup-node in the workflow (fetches api.playhq.com — absolute rule).

'use strict';
const crypto = require('crypto');

const args = process.argv.slice(2);
const arg  = (f, d) => { const a = args.find(x => x.startsWith('--' + f + '=')); return a ? a.split('=')[1] : d; };
const has  = (f)    => args.includes('--' + f);

// Defaults are the season the 2026-10-12 measurement was taken on, so a bare run
// reproduces it. --host-org is the club id every mis-attributed team maps to; it
// is derived from the data below if not given, never assumed.
const SEASON    = arg('season', '0869ea69');
let   HOST_ORG  = arg('host-org', null);
const SPECIMENS = Math.max(1, Math.min(10, parseInt(arg('specimens', '3'), 10) || 3));
const NO_INTRO  = has('no-introspect');

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
          res = await doFetch(API_URL, body, { ...HEADERS_BASE });
        } catch (err) {
          lastErr = err;
          console.log(`  … session refresh attempt ${attempt} network error: ${err.code || err.message} — retrying`);
          continue;
        }
        const raw = res.rawCookies;
        if (!raw) continue;
        // Extract each named cookie value, then reassemble in the exact order
        // the mobile client sends them: phq_tier first, phq_session, phq_sub.
        // (The server returns them in a different order in set-cookie headers.)
        const parts = (Array.isArray(raw) ? raw : [raw]).flatMap(c => c.split(',')).map(c => c.trim().split(';')[0]).filter(Boolean);
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

// ⚠️ 2026-10-05 — REWRITTEN FROM https.request TO fetch(). THE CLIENT WAS THE KEY.
// measure-playhq-limits.js --mode=compare, one runner, 10 s apart, same URL, same five
// headers, same user-agent: fetch() GRANTED, https.request REFUSED (403 CLOUDFRONT-BLOCK),
// fetch() GRANTED. REPO_MANIFEST §6.61. nightly-crawl.js's doFetch, pasted VERBATIM.
// ⚠️ DO NOT "OPTIMISE" THIS BACK TO https.request, AND DO NOT SET content-length BY HAND.
// Resolves on ANY status — never throws for a 403. Returns { status, rawCookies, body, rawText }.
async function doFetch(url, bodyObj, headers) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { ...headers, 'request-id': crypto.randomUUID() },
    body:    JSON.stringify(bodyObj),
  });
  const rawText = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(rawText); } catch (_) { body = null; }
  // undici exposes each Set-Cookie separately; the joined header is the fallback for
  // older runtimes. Callers expect an array or undefined, never an empty array.
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.rawCookies ? [res.rawCookies] : []);
  return {
    status:     res.status,
    rawCookies: cookies.length ? cookies : undefined,
    body,
    rawText,
  };
}


/* 403 means the SESSION is being refused, not this request — throw the cookie
   away rather than replaying a dead one. discover-fixtures.js's rule, and the
   reason the 2026-10-04 sweep cost four hours. sessionPromise is cleared too:
   leaving an in-flight promise behind would hand the next caller the dead
   cookie it is being invalidated for. */
function invalidateSession() { sessionCookie = null; sessionPromise = null; }

// ── Candidate fields ─────────────────────────────────────────────────────────
// Every plausible route to an owning club. Listed as whole selection-set
// fragments because that is the unit GraphQL validates and rejects. The list is
// deliberately generous: an unknown field costs one extra round trip and is then
// gone, whereas a field we never guessed is invisible forever.
const BASE_FIELDS = ['id', 'name'];
const CANDIDATES = [
  'organisation { id name type }',
  'club { id name }',
  'entity { id name }',
  'owner { id name }',
  'ownerOrganisation { id name }',
  'parentOrganisation { id name }',
  'delegatedOrganisation { id name }',
  'registeringOrganisation { id name }',
  'sourceOrganisation { id name }',
  'association { id name }',
  'tenant { id name }',
  'shortName',
  'abbreviation',
  'externalId',
  'externalRef',
  'logo { sizes { url dimensions { width height } } }',
  'gender { value }',
  'ageGroup { value }',
  'grade { id name season { id name competition { id name organisation { id name } } } }',
  'season { id name competition { id name organisation { id name } } }',
  'homeVenue { id name }',
  'contacts { id name }',
  'status',
  'type',
];

const UNKNOWN_FIELD = /Cannot query field ["'`]([^"'`]+)["'`]/gi;
const FIELD_OF      = (frag) => String(frag).trim().split(/[\s{(]/)[0];

function buildQuery(fields) {
  return 'query probeTeamFields($seasonId: ID!) {\n'
       + '  discoverTeams(filter: {seasonID: $seasonId}) {\n    '
       + fields.join('\n    ')
       + '\n  }\n}';
}

async function gql(operationName, query, variables) {
  if (!sessionCookie) await refreshSession();
  let reauths = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res;
    try {
      res = await doFetch(API_URL, { operationName, variables, query }, { ...HEADERS_BASE, 'Cookie': sessionCookie });
    } catch (err) {
      if (attempt === 4) return { status: 'error', detail: err.message };
      await sleep(2000 * attempt); continue;
    }
    if (res.status === 403) {
      const b = res.rawText || '';
      if (b.includes('DOCTYPE') || b.includes('Request blocked')) return { status: 'cloudfront-block' };
      if (reauths < 2) { reauths++; console.log('    … HTTP 403 — session refused, re-authenticating (' + reauths + '/2)'); invalidateSession(); await sleep(2000); continue; }
      return { status: 'http-403' };
    }
    if (res.status < 200 || res.status >= 300) {
      if (attempt === 4) return { status: 'http-' + res.status, detail: (res.rawText || '').slice(0, 200) };
      await sleep(2000 * attempt); continue;
    }
    const json = res.body;
    if (!json) return { status: 'bad-json', detail: (res.rawText || '').slice(0, 200) };
    // ⚠️ PlayHQ returns 5xx INSIDE a GraphQL error body at HTTP 200. A transient
    // server error must never be read as "this field does not exist".
    if (json.errors && json.errors.length) {
      const msgs = json.errors.map(e => e.message || '').join(' | ');
      if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|timed? ?out/i.test(msgs)) {
        if (attempt === 4) return { status: 'transient', detail: msgs.slice(0, 250) };
        console.log('    … transient: ' + msgs.slice(0, 80) + ' — retrying (' + attempt + '/3)');
        await sleep(3000 * attempt); continue;
      }
      return { status: 'gql-error', errors: json.errors, data: (json.data || null) };
    }
    return { status: 'ok', data: json.data };
  }
  return { status: 'failed' };
}

// ── 1. Introspection ─────────────────────────────────────────────────────────
async function introspectTeam() {
  console.log('\n1. INTROSPECTION — __type(name:"Team")');
  const q = `query probeIntrospect { __type(name: "Team") { name fields { name type { kind name ofType { kind name } } } } }`;
  const r = await gql('probeIntrospect', q, {});
  if (r.status !== 'ok') {
    console.log('   introspection unavailable (' + r.status + ')'
      + (r.errors ? ': ' + r.errors.map(e => e.message).join(' | ').slice(0, 160) : '')
      + '\n   EXPECTED on a production endpoint — step 2 does not depend on it.');
    return null;
  }
  const t = r.data && r.data.__type;
  if (!t || !Array.isArray(t.fields)) { console.log('   introspection returned no Team type'); return null; }
  const names = t.fields.map(f => {
    const ty = f.type || {};
    const label = ty.name || (ty.ofType && ty.ofType.name) || ty.kind || '?';
    return f.name + ': ' + label;
  }).sort();
  console.log('   ✓ Team exposes ' + names.length + ' field(s):');
  for (const n of names) console.log('       ' + n);
  return t.fields.map(f => f.name);
}

// ── 2. Error-driven field discovery ──────────────────────────────────────────
async function discoverFields() {
  console.log('\n2. FIELD DISCOVERY — asking for a superset and dropping what is rejected');
  let fields = BASE_FIELDS.concat(CANDIDATES);
  const rejected = [];
  for (let round = 1; round <= 30; round++) {
    const r = await gql('probeTeamFields', buildQuery(fields), { seasonId: SEASON });
    if (r.status === 'ok') {
      console.log('   ✓ query validates after ' + (round - 1) + ' narrowing round(s)');
      return { fields, rejected, data: r.data };
    }
    if (r.status !== 'gql-error') {
      console.log('   ✗ ' + r.status + (r.detail ? ': ' + r.detail : ''));
      return { fields: null, rejected, data: null, fatal: r.status };
    }
    const msgs = r.errors.map(e => e.message || '').join(' ');
    const bad = new Set();
    let m; UNKNOWN_FIELD.lastIndex = 0;
    while ((m = UNKNOWN_FIELD.exec(msgs)) !== null) bad.add(m[1]);
    if (!bad.size) {
      // A validation error naming no field is not something to grind on.
      console.log('   ✗ gql error that names no field — stopping rather than guessing:');
      for (const e of r.errors.slice(0, 4)) console.log('       ' + String(e.message).slice(0, 200));
      return { fields: null, rejected, data: null, fatal: 'gql-error' };
    }
    const before = fields.length;
    fields = fields.filter(f => !bad.has(FIELD_OF(f)));
    for (const b of bad) rejected.push(b);
    console.log('   round ' + round + ': dropped ' + (before - fields.length) + ' — ' + [...bad].join(', '));
    if (fields.length <= BASE_FIELDS.length) {
      console.log('   ✗ every candidate rejected');
      return { fields, rejected, data: null };
    }
    await sleep(400);
  }
  console.log('   ✗ still narrowing after 30 rounds — stopping');
  return { fields: null, rejected, data: null, fatal: 'no-convergence' };
}

// ── 3 & 4. Population and specimens ──────────────────────────────────────────
function walk(obj, prefix, out) {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) { if (obj.length) out.add(prefix); return; }
  if (typeof obj === 'object') { for (const k of Object.keys(obj)) walk(obj[k], prefix ? prefix + '.' + k : k, out); return; }
  if (obj !== '') out.add(prefix);
}

function report(teams, surviving) {
  console.log('\n3. POPULATION — season ' + SEASON + ', ' + teams.length + ' team(s)');

  // The host org is the organisation id held by the most teams in a TOURNAMENT
  // season. Derived, then stated, so the run does not depend on being told.
  if (!HOST_ORG) {
    const tally = new Map();
    for (const t of teams) { const id = t.organisation && t.organisation.id; if (id) tally.set(id, (tally.get(id) || 0) + 1); }
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) { HOST_ORG = top[0]; console.log('   host org derived as ' + top[0] + ' (' + top[1] + ' of ' + teams.length + ' teams)'); }
  }
  const hostName = (teams.find(t => t.organisation && t.organisation.id === HOST_ORG) || {}).organisation;
  console.log('   host org: ' + HOST_ORG + (hostName ? ' — ' + hostName.name : ''));

  const mis  = teams.filter(t => t.organisation && t.organisation.id === HOST_ORG);
  const good = teams.filter(t => t.organisation && t.organisation.id !== HOST_ORG);
  const none = teams.filter(t => !t.organisation || !t.organisation.id);
  console.log('   attributed to the host org : ' + mis.length);
  console.log('   attributed to a real club  : ' + good.length);
  console.log('   no organisation at all     : ' + none.length);

  const pop = (set) => { const c = new Map();
    for (const t of set) { const keys = new Set(); walk(t, '', keys);
      for (const k of keys) c.set(k, (c.get(k) || 0) + 1); } return c; };
  const pm = pop(mis), pg = pop(good);
  const keys = [...new Set([...pm.keys(), ...pg.keys()])].sort();

  console.log('\n   field                                             host-org teams   club teams');
  console.log('   ' + '-'.repeat(78));
  for (const k of keys) {
    const a = pm.get(k) || 0, b = pg.get(k) || 0;
    const pa = mis.length  ? Math.round(100 * a / mis.length)  : 0;
    const pb = good.length ? Math.round(100 * b / good.length) : 0;
    console.log('   ' + k.padEnd(50) + String(pa + '%').padStart(10) + '  ' + String(pb + '%').padStart(11));
  }

  // THE VERDICT. A field is only useful if it is populated on the teams that are
  // mis-attributed AND is not just the host org repeated back.
  console.log('\n   VERDICT');
  const useful = keys.filter(k => {
    if (!k.startsWith('organisation.')) {
      const a = pm.get(k) || 0;
      return mis.length > 0 && a / mis.length >= 0.5 && /club|entity|owner|parent|deleg|registe|source|associat/i.test(k);
    }
    return false;
  });
  if (useful.length) {
    console.log('   ✓ candidate route(s) to the owning club, populated on the mis-attributed teams:');
    for (const k of useful) console.log('       ' + k + '  (' + Math.round(100 * (pm.get(k) || 0) / mis.length) + '% populated)');
    console.log('   Inspect the specimens below before trusting these — a populated field');
    console.log('   that echoes the host org is not the club.');
  } else {
    console.log('   ✗ NO field other than `organisation` carries a club on the mis-attributed');
    console.log('     teams. PlayHQ does not hold the owning club for a team entered under a');
    console.log('     tournament, so the club cannot be recovered from the API — only inferred');
    console.log('     from the team name, with the 68/294 error rate recorded in this header.');
  }
  if (surviving) console.log('\n   fields that validated: ' + surviving.filter(f => !BASE_FIELDS.includes(f)).map(FIELD_OF).join(', '));

  console.log('\n4. SPECIMENS');
  const show = (label, set) => {
    console.log('\n   ── ' + label + ' ' + '─'.repeat(Math.max(0, 60 - label.length)));
    if (!set.length) { console.log('   (none)'); return; }
    for (const t of set.slice(0, SPECIMENS)) console.log(JSON.stringify(t, null, 2).split('\n').map(l => '   ' + l).join('\n'));
  };
  show('ATTRIBUTED TO THE HOST ORG (the problem case)', mis);
  show('ATTRIBUTED TO A REAL CLUB (the control)', good);
}

async function main() {
  console.log('probe-team-club-fields [READ-ONLY] — season ' + SEASON);
  console.log('Asking: does PlayHQ hold a team\'s owning club anywhere other than `organisation`?');

  if (!NO_INTRO) await introspectTeam();
  else console.log('\n1. INTROSPECTION — skipped (--no-introspect)');

  const d = await discoverFields();
  if (!d.fields) { console.error('\n✗ field discovery failed (' + (d.fatal || 'unknown') + ') — nothing measured, exiting non-zero.'); process.exit(1); }
  if (d.rejected.length) console.log('   rejected by the schema: ' + [...new Set(d.rejected)].join(', '));

  const teams = d.data && Array.isArray(d.data.discoverTeams) ? d.data.discoverTeams : null;
  if (!teams) { console.error('\n✗ the validating query returned no team array — nothing measured, exiting non-zero.'); process.exit(1); }
  if (!teams.length) { console.error('\n✗ season ' + SEASON + ' returned ZERO teams. That is an answer about the season, not about the schema — pick a season with teams.'); process.exit(1); }

  report(teams, d.fields);
  console.log('\nDone. READ-ONLY — nothing was written.');
}

main().catch(e => { console.error('\n✗ fatal: ' + (e && e.message)); process.exit(1); });
