// scripts/probe-player.js
//
// READ-ONLY single-player deep reconciliation. For ONE player, fetch their full
// profile from the mobile API (the same endpoint the app renders career/seasons/
// teams from — the website's statistics view can error on profiles the API still
// serves) and print the COMPLETE picture, no display limit:
//   - every game the API credits them with, classified:
//       OK            — we hold the game and they are in its roster
//       NOT-IN-P[]    — we hold the game, roster lacks them (with the alias
//                       verdict: PRESENT-as-alias / PRESENT-legacy-10char are
//                       fold problems, NOT append targets)
//       GAME-ABSENT   — the game is not in games/bv at all
//     each with round, teams, side, and their personal stat line
//   - per-season rollup: API games vs our games[] entries for them
//   - a closing summary of what a targeted repair could recover
//
// No writes, no git, no locks. The query, headers, session handling, doFetch,
// fetchProfile, statValue and the p[] inspection are COPIED VERBATIM from
// scripts/probe-missing-games.js (asserted byte-identical at build).
//
// Usage: node scripts/probe-player.js --uuid=<uuid>

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const UUID = (args.find(a => a.startsWith('--uuid=')) || '').replace('--uuid=', '').trim();
if (!UUID) { console.error('Usage: node scripts/probe-player.js --uuid=<uuid>'); process.exit(1); }

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
  const seasons = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sports-index.json'), 'utf8')).seasons || {}; }
    catch { return {}; }
  })();

  const playerFileOf = (uuid) => {
    const p = path.join(ROOT, 'players', uuid.slice(0, 2), `${uuid}.json`);
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  };
  const pf = playerFileOf(UUID);
  const localGids = pf ? new Set(Array.isArray(pf.games) ? pf.games : []) : new Set();
  const specIds = new Set(Array.isArray(pf?.spectatorIds) ? pf.spectatorIds : []);

  console.log(`probe-player — ${UUID}`);
  console.log(`  our player file : ${pf ? `"${pf.name || '?'}"${pf.private === true ? ' [PRIVATE]' : ''}, games[]=${localGids.size}, spectatorIds=${[...specIds].join(',') || 'none'}` : 'NOT FOUND'}`);
  console.log(`  known gids on file: ${gidToSid.size.toLocaleString()}`);

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
    console.log(`\n  API status: ${r.status} — the mobile API does not serve this profile; the route is dead for this player.`);
    return;
  }
  const seasonStats = r.data?.publicProfileStatistics?.seasonStatistics || [];
  if (!seasonStats.length) { console.log('\n  API returned OK but no seasonStatistics — nothing to reconcile.'); return; }

  let ok = 0, gaps = 0, aliasCases = 0, absent = 0, noSide = 0;
  let recoverPts = 0, recoverApps = 0;
  const perSeason = [];

  for (const season of seasonStats) {
    for (const reg of (season.statistics || [])) {
      const sid = reg?.season?.id;
      if (!sid) continue;
      const sName = seasons[sid] ? `${seasons[sid].name || ''} — ${seasons[sid].orgName || ''}` : 'NOT IN sports-index';
      for (const teamStat of (reg.teamStatistics || [])) {
        const tid = teamStat.team?.id || null;
        const tName = teamStat.team?.name || '?';
        for (const gradeStat of (teamStat.gradeStatistics || [])) {
          const rows = [];
          let sOk = 0, sGap = 0, sAlias = 0, sAbsent = 0;
          for (const gs of (gradeStat.gameStatistics || [])) {
            const gameId = gs.game?.id || null;
            if (!gameId) continue;
            const g = gs.game;
            const side = g.home?.id === tid ? 'HOME' : g.away?.id === tid ? 'AWAY' : '??';
            if (side === '??') noSide++;
            const st = gs.statistics || [];
            const line = `pts=${statValue(st,'TOTAL_SCORE')} 1pt=${statValue(st,'1_POINT_SCORE')} 2pt=${statValue(st,'2_POINT_SCORE')} 3pt=${statValue(st,'3_POINT_SCORE')} fouls=${statValue(st,'TOTAL_FOULS')} app=${statValue(st,'APPEARANCE')}`;
            const vs = `${g.home?.name ?? '?'} vs ${g.away?.name ?? '?'}`;
            const heldSid = gidToSid.get(gameId) || null;
            if (heldSid && localGids.has(gameId)) { ok++; sOk++; continue; }
            if (heldSid) {
              const insp = inspectP(heldSid, gameId, UUID, specIds);
              if (insp.verdict === 'GENUINELY-ABSENT') {
                gaps++; sGap++;
                recoverPts += statValue(st,'TOTAL_SCORE'); recoverApps += statValue(st,'APPEARANCE') || 1;
                rows.push(`    NOT-IN-P[]  ${gameId}  ${g.round?.name ?? '?'}  ${vs}  side=${side}  ${line}  [roster n=${insp.n}, spc=${insp.spc}]`);
              } else if (insp.verdict.startsWith('PRESENT')) {
                aliasCases++; sAlias++;
                rows.push(`    ALIAS-CASE  ${gameId}  ${g.round?.name ?? '?'}  → ${insp.verdict}${insp.alias ? ` (${insp.alias})` : ''} — fold problem, NOT an append target`);
              } else {
                rows.push(`    ODD         ${gameId}  → ${insp.verdict}`);
              }
              continue;
            }
            absent++; sAbsent++;
            rows.push(`    GAME-ABSENT ${gameId}  ${g.round?.name ?? '?'}  ${vs}  side=${side}  ${line}  (synthesis territory — OUTSTANDING §2.2 tool)`);
          }
          const total = sOk + sGap + sAlias + sAbsent;
          if (total === 0) continue;
          perSeason.push({ sid, sName, tName, grade: gradeStat.grade?.name || '?', total, sOk, sGap, sAlias, sAbsent });
          console.log(`\n── ${sName} | ${tName} | ${gradeStat.grade?.name || '?'} (sid=${sid}) ──`);
          console.log(`    API games=${total}  ok=${sOk}  roster-gaps=${sGap}  alias-cases=${sAlias}  game-absent=${sAbsent}`);
          for (const row of rows) console.log(row);
        }
      }
    }
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(`  API game credits      : ${ok + gaps + aliasCases + absent}`);
  console.log(`  already correct       : ${ok}`);
  console.log(`  roster gaps (append)  : ${gaps}   ← genuinely absent from held games' p[]`);
  console.log(`  alias cases (fold)    : ${aliasCases}   ← already present under another id; appending would DUPLICATE`);
  console.log(`  games absent entirely : ${absent}   ← synthesis territory`);
  if (noSide) console.log(`  ⚠ side unresolved     : ${noSide}`);
  console.log(`  a targeted repair for THIS player would recover ~${recoverApps} appearances / ${recoverPts} pts`);
  console.log(`  (read-only run — nothing was written)`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
