// scripts/probe-both-resolve.js
//
// READ-ONLY. No writes to player data. Writes one report. No lock.
//
// THE REMAINING 416. After merge-phantom-profiles cleared 2,482 phantoms, 416 pairs
// of same-named player files still hold the same games — 6,616 duplicated
// appearances. For these, BOTH uuids resolve on PlayHQ, so neither can be called a
// phantom and neither can simply be deleted.
//
// TWO POSSIBILITIES, AND THEY LOOK IDENTICAL OFFLINE:
//   TWO PEOPLE — siblings or same-named teammates. Two REAL profiles, two entries
//     on one team sheet, which is exactly what a shared game means. The detector
//     selects pairs BY shared games, so it preferentially catches these: one
//     person's two profiles split their seasons and share FEW games, while two
//     teammates share NEARLY ALL of them.
//   ONE PERSON — genuinely two PlayHQ accounts, both live.
//
// WHAT DISTINGUISHES THEM, fetched per profile and printed side by side:
//   · gender            — different means two people, full stop
//   · season ID overlap — two profiles of one person rarely cover the SAME season
//                         twice; teammates cover all the same seasons
//   · same-season same-team — two people can share a team; one person appearing
//                         TWICE in one team in one season is a duplicate
//   · date range        — a person who changed accounts shows a clean handover,
//                         one stopping roughly where the other starts
//
// It states a LEANING per pair, never a verdict. Deleting or merging a real
// person because two siblings share a surname is worse than leaving 6,616
// appearances double-counted, and only a human can tell twins apart.
//
// Usage:
//   node scripts/probe-both-resolve.js            # all pairs where both resolve
//   node scripts/probe-both-resolve.js --sample=40

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
const SAMPLE = num('sample', 0);          // 0 = all
const PACE_MS = num('pace', 1000);        // 700 hit CloudFront on 2026-08-21

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';

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
  console.log('probe-both-resolve [READ-ONLY] — pairs where BOTH uuids resolve on PlayHQ');

  // Rebuild the pairs: same normalised name, at least one shared game id.
  const playersDir = path.join(ROOT, 'players');
  const meta = new Map(), holders = new Map();
  for (const shard of fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d))) {
    const dir = path.join(playersDir, shard);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let p; try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
      const uuid = f.replace(/\.json$/, '');
      const games = Array.isArray(p.games) ? p.games : [];
      const sids = new Set(), tids = new Set();
      const sidTeam = new Map();          // sid -> Set(tid), for the same-team test
      for (const se of (Array.isArray(p.seasons) ? p.seasons : [])) {
        if (!se || !se.sid) continue;
        sids.add(se.sid);
        if (!sidTeam.has(se.sid)) sidTeam.set(se.sid, new Set());
        for (const r of (Array.isArray(se.regs) ? se.regs : [])) if (r && r.tid) { tids.add(r.tid); sidTeam.get(se.sid).add(r.tid); }
      }
      meta.set(uuid, { key: normName(p.name), name: p.name || '?', games: games.length,
                       gender: p.gender || null, sids, tids, sidTeam, priv: p.private === true });
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
  console.log('  pairs still sharing games: ' + n(pairs.length));
  if (SAMPLE) pairs = pairs.slice(0, SAMPLE);

  const rows = [];
  let twoPeople = 0, onePerson = 0, unclear = 0, failed = 0, badName = 0;
  const seen = new Map();
  const askGender = async (u) => {
    if (seen.has(u)) return seen.get(u);
    const r = await fetchProfile(u);
    let g = null;
    if (r.status === 'ok') {
      // The profile response carries the seasons; gender is on the player file
      // already, so what the API adds here is CONFIRMATION THE PROFILE IS LIVE and
      // the season list PlayHQ itself reports.
      const ss = r.data?.publicProfileStatistics?.seasonStatistics || [];
      const sids = new Set();
      for (const s of ss) for (const st of (s.statistics || [])) if (st?.season?.id) sids.add(st.season.id);
      g = { live: true, sids };
    } else g = { live: false, status: r.status };
    seen.set(u, g);
    await sleep(PACE_MS);
    return g;
  };

  for (const p of pairs) {
    const la = await askGender(p.ua), lb = await askGender(p.ub);
    if (!la.live || !lb.live) { failed++; continue; }

    // ⚠ GENDER IS AN AGE-GRADE LABEL, NOT A SEX. The 2026-08-22 run reported 52
    // pairs as "two people — different gender" and almost all were Men/Boys or
    // Girls/Women: THE SAME PERSON'S JUNIOR AND SENIOR GRADES. A player who came
    // through juniors carries both, so a raw string comparison flags the single
    // strongest evidence of ONE person as proof of two.
    //
    // Only a genuine conflict counts: male-coded against female-coded. Everything
    // else — the same family, or Unknown/Mixed/absent — says nothing either way.
    const MALE = new Set(['boys', 'men', 'male']);
    const FEMALE = new Set(['girls', 'women', 'female']);
    const fam = (g) => { const x = String(g || '').trim().toLowerCase();
      return MALE.has(x) ? 'M' : FEMALE.has(x) ? 'F' : null; };
    const fa = fam(p.a.gender), fb = fam(p.b.gender);
    const genderDiff = fa && fb && fa !== fb;
    const sharedSids = [...p.a.sids].filter(s => p.b.sids.has(s));
    const sidOverlap = pct(sharedSids.length, Math.min(p.a.sids.size, p.b.sids.size) || 1);
    // Same season AND same team: two people can share a team, but ONE person
    // appearing twice in one team in one season is a duplicate, not a sibling.
    let sameTeamSeasons = 0;
    for (const sid of sharedSids) {
      const ta = p.a.sidTeam.get(sid) || new Set(), tb = p.b.sidTeam.get(sid) || new Set();
      if ([...ta].some(t => tb.has(t))) sameTeamSeasons++;
    }
    const shareRate = pct(p.shared, Math.min(p.a.games, p.b.games) || 1);

    let leaning;
    if (genderDiff) { leaning = 'TWO PEOPLE — ' + p.a.gender + ' vs ' + p.b.gender + ', a real gender conflict'; twoPeople++; }
    else if (sameTeamSeasons > 0) { leaning = 'ONE PERSON? — same team in ' + sameTeamSeasons + ' shared season(s)'; onePerson++; }
    else if (fa && fb && fa === fb && p.a.gender !== p.b.gender) {
      // Same gender family, different label: Boys/Men or Girls/Women. That is a
      // player ageing out of juniors into seniors — one person, two grades.
      leaning = 'ONE PERSON? — ' + p.a.gender + ' vs ' + p.b.gender + ': junior/senior grades of one player';
      onePerson++;
    }
    else if (Number(shareRate) >= 80) { leaning = 'TWO PEOPLE? — ' + shareRate + '% of the smaller career shared: teammates, not a split identity'; twoPeople++; }
    else { leaning = 'UNCLEAR'; unclear++; }

    // "Winter 2026" appeared as a player NAME four times in the 2026-08-22 run.
    // That is a corrupt name field, not a duplicate, and it makes every same-named
    // pair a false match. Flagged rather than silently compared.
    const looksLikeSeason = /^(summer|winter|autumn|spring|term)\b|\b20\d\d(\/\d\d)?$/i.test(String(p.a.name || '').trim());
    if (looksLikeSeason) badName++;
    rows.push({ a: p.ua, b: p.ub, name: p.a.name, badName: looksLikeSeason, shared: p.shared, shareRate,
                gA: p.a.gender, gB: p.b.gender, gamesA: p.a.games, gamesB: p.b.games,
                sidsA: p.a.sids.size, sidsB: p.b.sids.size, sharedSids: sharedSids.length,
                sidOverlap, sameTeamSeasons, leaning });
    if (rows.length % 25 === 0) console.log('  … ' + rows.length + '/' + pairs.length);
  }

  console.log('\n════════════════════════════════════════════════');
  console.log('  pairs examined : ' + n(rows.length) + (failed ? '   (' + failed + ' could not be fetched)' : ''));
  console.log('    two people (real gender conflict)             : ' + n(rows.filter(r => r.leaning.startsWith('TWO PEOPLE —')).length));
  console.log('    two people? (share most of the smaller career): ' + n(rows.filter(r => r.leaning.startsWith('TWO PEOPLE?')).length));
  console.log('    one person? (same team, same season)          : ' + n(onePerson));
  console.log('    unclear                                       : ' + n(unclear));
  if (badName) console.log('    ⚠ pairs whose NAME looks like a season       : ' + n(badName) + '   ← corrupt name field, not a duplicate — fix the name, not the pair');
  console.log('');
  console.log('  ── EVERY PAIR ──');
  for (const r of rows) {
    console.log('    ' + JSON.stringify(r.name) + (r.badName ? '  ⚠ NAME LOOKS LIKE A SEASON' : '') + '  ' + r.leaning);
    console.log('      ' + r.a + '  games=' + r.gamesA + ' seasons=' + r.sidsA + ' gender=' + (r.gA || '—'));
    console.log('      ' + r.b + '  games=' + r.gamesB + ' seasons=' + r.sidsB + ' gender=' + (r.gB || '—'));
    console.log('      shared games ' + r.shared + ' (' + r.shareRate + '% of the smaller career) · shared seasons ' +
                r.sharedSids + ' (' + r.sidOverlap + '%) · same team in ' + r.sameTeamSeasons);
    console.log('      https://www.playhq.com/public/profile/' + r.a + '/statistics');
    console.log('      https://www.playhq.com/public/profile/' + r.b + '/statistics');
  }

  try {
    const out = path.join(ROOT, 'reports', 'both-resolve-pairs.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), pairs: rows }, null, 1));
    console.log('\n  FULL LIST WRITTEN: reports/both-resolve-pairs.json (' + rows.length + ' pairs, uncapped)');
  } catch (e) { console.log('  ⚠ could not write report: ' + e.message); }

  console.log('');
  console.log('  NO ACTION IS TAKEN AND NONE SHOULD BE AUTOMATED. Two siblings sharing a');
  console.log('  surname and a team look exactly like one person with two accounts, and');
  console.log('  merging a real person is worse than leaving 6,616 appearances counted twice.');
  console.log('  The two PlayHQ links per pair are printed so a human can settle each one.');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
