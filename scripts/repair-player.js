// scripts/repair-player.js
//
// Per-player TARGETED roster repair (built 2026-08-07, from probe-player's proven
// route). For ONE player: fetch their profile, and for every game the API credits
// them with that we HOLD but whose roster lacks them, append them — id into p[],
// stat line into hp/ap by side — ONLY when the alias inspection says
// GENUINELY-ABSENT. PRESENT-as-alias / PRESENT-legacy-10char are fold problems:
// appending would create a duplicate identity, so they are listed and NEVER
// touched (the guard probe-missing-games proved decisive). Games absent from
// games/bv entirely are listed for synthesize-missing-games — not this tool's
// business. Real crawl data is modified ONLY by adding this one player.
//
// Downstream (nothing else to run by hand): games[]/appearances/aggregates and
// W/L rebuild from games/bv via the normal builders on the next post-drain
// chain. Locked seasons: the workflow tail dispatches Deploy Archive Pages on
// apply (split invariant); active-season writes publish with tonight's chain.
//
// The query, headers, session handling, doFetch, fetchProfile, statValue and
// the p[] inspection are COPIED VERBATIM from scripts/probe-missing-games.js
// (asserted byte-identical at build). This is deliberately PER-PLAYER: the
// 2026-08-06 decision against bulk-rewriting 2M working rosters stands.
//
// Usage:
//   node scripts/repair-player.js --uuid=<uuid>            # DRY RUN (default)
//   node scripts/repair-player.js --uuid=<uuid> --apply    # write files
//
// No git here — the workflow's commit step does it once (house pattern).

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const UUID = (args.find(a => a.startsWith('--uuid=')) || '').replace('--uuid=', '').trim();
const APPLY = args.includes('--apply');
const TRUNC_LEN = 13;
if (!UUID) { console.error('Usage: node scripts/repair-player.js --uuid=<uuid> [--apply]'); process.exit(1); }

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

function buildStatLine(uuid13, st) {
  return {
    profileID: uuid13,
    pts:   statValue(st, 'TOTAL_SCORE'),
    pt1:   statValue(st, '1_POINT_SCORE'),
    pt2:   statValue(st, '2_POINT_SCORE'),
    pt3:   statValue(st, '3_POINT_SCORE'),
    fouls: statValue(st, 'TOTAL_FOULS'),
  };
}

async function main() {
  console.log(`repair-player ${APPLY ? '[APPLY]' : '[dry-run]'} — ${UUID}`);
  const uuid13 = UUID.slice(0, TRUNC_LEN);

  const gamesDir = path.join(ROOT, 'games', 'bv');
  const gidToSid = new Map();
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = path.basename(f, '.json');
    try {
      const sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8'));
      for (const g of Object.keys(sg.games || {})) gidToSid.set(g, sid);
    } catch { /* ignore */ }
  }
  console.log(`  known gids on file: ${gidToSid.size.toLocaleString()}`);

  const playerFileOf = (uuid) => {
    const p = path.join(ROOT, 'players', uuid.slice(0, 2), `${uuid}.json`);
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  };
  const pf = playerFileOf(UUID);
  const specIds = new Set(Array.isArray(pf?.spectatorIds) ? pf.spectatorIds : []);
  console.log(`  our player file : ${pf ? `"${pf.name || '?'}"${pf.private === true ? ' [PRIVATE]' : ''}, spectatorIds=${[...specIds].join(',') || 'none'}` : 'NOT FOUND'}`);

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

  const r = await fetchProfile(UUID);
  if (r.status !== 'ok') {
    console.log(`  API status: ${r.status} — the mobile API does not serve this profile; nothing to repair.`);
    return;
  }
  const seasonStats = r.data?.publicProfileStatistics?.seasonStatistics || [];

  // The season file cache MUST be shared with inspectP's gameIndex so the append
  // mutates the same object the verdict was read from — and so a season file is
  // parsed once. inspectP populated gameIndex above; we reuse it directly.
  const changedSids = new Set();
  const appended = [], aliasSkipped = [], absent = [], noSide = [];
  let ok = 0, recoverPts = 0;

  for (const season of seasonStats) {
    for (const reg of (season.statistics || [])) {
      const sid = reg?.season?.id;
      if (!sid) continue;
      for (const teamStat of (reg.teamStatistics || [])) {
        const tid = teamStat.team?.id || null;
        for (const gradeStat of (teamStat.gradeStatistics || [])) {
          for (const gs of (gradeStat.gameStatistics || [])) {
            const gameId = gs.game?.id || null;
            if (!gameId) continue;
            const heldSid = gidToSid.get(gameId) || null;
            if (!heldSid) { absent.push(`${gameId} sid=${sid} ${gs.game?.round?.name ?? '?'}`); continue; }
            const insp = inspectP(heldSid, gameId, UUID, specIds);
            if (insp.verdict === 'PRESENT-canonical') { ok++; continue; }
            if (insp.verdict.startsWith('PRESENT')) {
              aliasSkipped.push(`${gameId} sid=${heldSid} → ${insp.verdict}${insp.alias ? ` (${insp.alias})` : ''}`);
              continue;
            }
            if (insp.verdict !== 'GENUINELY-ABSENT') { aliasSkipped.push(`${gameId} sid=${heldSid} → ${insp.verdict} (not touched)`); continue; }
            const sg = gameIndex.get(heldSid);
            const entry = sg.games[gameId];
            const g = gs.game;
            const side = g.home?.id === tid ? 'HOME' : g.away?.id === tid ? 'AWAY' : null;
            entry.p = entry.p || []; entry.p.push({ id: uuid13 });
            if (side === 'HOME') { entry.hp = entry.hp || []; entry.hp.push(buildStatLine(uuid13, gs.statistics)); }
            else if (side === 'AWAY') { entry.ap = entry.ap || []; entry.ap.push(buildStatLine(uuid13, gs.statistics)); }
            else noSide.push(gameId);
            changedSids.add(heldSid);
            recoverPts += statValue(gs.statistics, 'TOTAL_SCORE');
            appended.push(`${gameId} sid=${heldSid}  ${g.round?.name ?? '?'}  ${g.home?.name ?? '?'} vs ${g.away?.name ?? '?'}  side=${side || '?? (p[] only)'}  pts=${statValue(gs.statistics,'TOTAL_SCORE')}`);
          }
        }
      }
    }
  }

  let written = 0;
  for (const sid of changedSids) {
    const sg = gameIndex.get(sid);
    if (APPLY) { fs.writeFileSync(path.join(gamesDir, `${sid}.json`), JSON.stringify(sg)); }
    written++;
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(`  already correct        : ${ok}`);
  console.log(`  APPENDED (${APPLY ? 'written' : 'dry-run'})    : ${appended.length}  recovering ${recoverPts} pts`);
  for (const a of appended) console.log(`    ${a}`);
  console.log(`  alias/other cases SKIPPED (fold problems, never touched): ${aliasSkipped.length}`);
  for (const a of aliasSkipped) console.log(`    ${a}`);
  console.log(`  games absent from games/bv (synthesize-missing-games territory): ${absent.length}`);
  for (const a of absent) console.log(`    ${a}`);
  if (noSide.length) console.log(`  ⚠ side unresolved (p[] appended, no stat line): ${noSide.length} — ${noSide.join('; ')}`);
  console.log(`  season files ${APPLY ? 'written' : 'to write'}: ${written}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
