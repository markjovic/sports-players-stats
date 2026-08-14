// scripts/probe-player.js
//
// READ-ONLY single-player deep reconciliation. For ONE player, fetch their full
// profile from the mobile API (the same endpoint the app renders career/seasons/
// teams from — the website's statistics view can error on profiles the API still
// serves) and print the COMPLETE picture, no display limit:
//   - every game the API credits them with, classified:
//       OK            — they are in the roster under their own id AND the game
//                       is in their games[]: nothing to do
//       LAG           — they are in the roster under their own id but the game
//                       is NOT in games[] yet: the next build-player-games run
//                       closes this, no tool needed
//       ALIAS-OK      — they are in the roster under an alias that games[]
//                       already resolved: nothing to do
//       ALIAS-GAP     — in the roster under an UNRESOLVED id: genuine fold work,
//                       and appending would create a second identity
//       NOT-IN-P[]    — we hold the game and the roster genuinely lacks them:
//                       this is what a repair can append
//       UNCAPTURED    — we hold the game and its roster is EMPTY: no sweep has
//                       ever captured it, so it needs a CAPTURE, not a repair.
//                       Counted apart from NOT-IN-P[] so the recovery estimate
//                       below matches what repair-players-batch would actually
//                       do — the batch has skipped these since 2026-08-13
//       GAME-ABSENT   — the game is not in games/bv at all
//     each with round, teams, side, and their personal stat line
//
// 2026-08-14 (OUTSTANDING §2.16): OK used to be decided by games[] alone, and
// anything else that came back PRESENT — INCLUDING the player being there under
// their OWN id — was printed as an alias/fold case. So every game a repair had
// appended on an earlier pass was reported back as a fold problem on the next
// run. Own-id presence is now its own verdict, and the games[] test only decides
// between OK and LAG.
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
  //
  // 2026-08-14 (OUTSTANDING §2.16) — "present under their OWN id" now returns
  // SELF-PRESENT, where it used to return PRESENT-canonical. The RENAME is the
  // fix, not a cosmetic change: probe-player bucketed verdicts with
  // `verdict.startsWith('PRESENT')`, so a game this family of tools had appended
  // on an earlier pass came back on the next pass counted as an alias/fold case.
  // A verdict that does not begin with "PRESENT" cannot be swept up by that test
  // here or in anything written later. (Correction to the note in OUTSTANDING
  // §2.16: only probe-player ever did this. repair-player.js counted it as `ok`
  // and repair-players-batch.js skipped it before its alias counter, so the
  // batch's alias figures were never inflated by it — which is why they are being
  // measured rather than explained away.)
  // NOTE: this block is therefore NO LONGER byte-identical to the copy in
  // probe-missing-games.js, which still uses the old verdict name. Deliberate,
  // and recorded here so the divergence is not later mistaken for drift.
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
    if (ids.has(pref)) return { verdict: 'SELF-PRESENT', n: ids.size };
    for (const s of specIds) if (ids.has(s)) return { verdict: 'PRESENT-as-alias', alias: s, n: ids.size };
    const pref10 = uuid.slice(0, 10);
    for (const id of ids) if (id.startsWith(pref10)) return { verdict: 'PRESENT-legacy-10char', alias: id, n: ids.size };
    // dg carried alongside spc so an append can report WHICH capture path built
    // the roster it is being added to — a roster with neither flag was written by
    // a previous repair, not by a sweep (OUTSTANDING §2.15).
    return { verdict: 'GENUINELY-ABSENT', n: ids.size, spc: g.spc || 0, dg: g.dg || 0 };
  };

  const r = await fetchProfile(UUID);
  if (r.status !== 'ok') {
    console.log(`\n  API status: ${r.status} — the mobile API does not serve this profile; the route is dead for this player.`);
    return;
  }
  const seasonStats = r.data?.publicProfileStatistics?.seasonStatistics || [];
  if (!seasonStats.length) { console.log('\n  API returned OK but no seasonStatistics — nothing to reconcile.'); return; }

  let ok = 0, lag = 0, aliasOk = 0, aliasGap = 0, gaps = 0, uncap = 0, absent = 0, odd = 0, noSide = 0;
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
          let sOk = 0, sLag = 0, sAliasOk = 0, sAliasGap = 0, sGap = 0, sUncap = 0, sAbsent = 0, sOdd = 0;
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
            if (heldSid) {
              const insp = inspectP(heldSid, gameId, UUID, specIds);
              const inGames = localGids.has(gameId);
              if (insp.verdict === 'SELF-PRESENT') {
                // Present under their own id. games[] then decides whether this
                // is finished or simply waiting for the weekly rebuild — the two
                // need different answers and used to be the same number.
                if (inGames) { ok++; sOk++; }
                else {
                  lag++; sLag++;
                  rows.push(`    LAG         ${gameId}  ${g.round?.name ?? '?'}  ${vs}  — in the roster under their own id, not yet in games[]; build-player-games closes this`);
                }
              } else if (insp.verdict === 'PRESENT-as-alias' || insp.verdict === 'PRESENT-legacy-10char') {
                // Present under a different id. If games[] holds the game the
                // alias index already resolved it and nothing is wrong; if not,
                // the alias is unregistered and this is real fold work. Either
                // way it is never an append target — a second id for the same
                // person in one roster is a duplicate, not a repair.
                if (inGames) {
                  aliasOk++; sAliasOk++;
                  rows.push(`    ALIAS-OK    ${gameId}  ${g.round?.name ?? '?'}  → ${insp.verdict}${insp.alias ? ` (${insp.alias})` : ''} — already resolved into games[], nothing to do`);
                } else {
                  aliasGap++; sAliasGap++;
                  rows.push(`    ALIAS-GAP   ${gameId}  ${g.round?.name ?? '?'}  → ${insp.verdict}${insp.alias ? ` (${insp.alias})` : ''} — UNRESOLVED: fold work, NOT an append target`);
                }
              } else if (insp.verdict === 'GENUINELY-ABSENT' && !insp.n) {
                // An empty p[] is not a roster with a gap in it — it is a game no
                // sweep has captured. repair-players-batch skips these, so
                // counting them as recoverable here would promise appends that
                // will never happen.
                uncap++; sUncap++;
                rows.push(`    UNCAPTURED  ${gameId}  ${g.round?.name ?? '?'}  ${vs}  — EMPTY roster (spc=${insp.spc}, dg=${insp.dg}): needs a CAPTURE sweep, not a repair`);
              } else if (insp.verdict === 'GENUINELY-ABSENT') {
                gaps++; sGap++;
                recoverPts += statValue(st,'TOTAL_SCORE'); recoverApps += statValue(st,'APPEARANCE') || 1;
                rows.push(`    NOT-IN-P[]  ${gameId}  ${g.round?.name ?? '?'}  ${vs}  side=${side}  ${line}  [roster n=${insp.n}, spc=${insp.spc}, dg=${insp.dg}]`);
              } else {
                odd++; sOdd++;
                rows.push(`    ODD         ${gameId}  → ${insp.verdict}`);
              }
              continue;
            }
            absent++; sAbsent++;
            rows.push(`    GAME-ABSENT ${gameId}  ${g.round?.name ?? '?'}  ${vs}  side=${side}  ${line}  (synthesis territory — OUTSTANDING §2.2 tool)`);
          }
          const total = sOk + sLag + sAliasOk + sAliasGap + sGap + sUncap + sAbsent + sOdd;
          if (total === 0) continue;
          perSeason.push({ sid, sName, tName, grade: gradeStat.grade?.name || '?', total, sOk, sLag, sAliasOk, sAliasGap, sGap, sUncap, sAbsent, sOdd });
          console.log(`\n── ${sName} | ${tName} | ${gradeStat.grade?.name || '?'} (sid=${sid}) ──`);
          console.log(`    API games=${total}  ok=${sOk}  lag=${sLag}  alias-ok=${sAliasOk}  alias-gap=${sAliasGap}  roster-gaps=${sGap}  uncaptured=${sUncap}  game-absent=${sAbsent}  odd=${sOdd}`);
          for (const row of rows) console.log(row);
        }
      }
    }
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(`  API game credits      : ${ok + lag + aliasOk + aliasGap + gaps + uncap + absent + odd}`);
  console.log(`  already correct       : ${ok}   ← own id in the roster, and in games[]`);
  console.log(`  alias already resolved: ${aliasOk}   ← another id in the roster, but games[] has the game: nothing to do`);
  console.log(`  waiting on the rebuild: ${lag}   ← own id in the roster, not yet in games[]; build-player-games closes these`);
  console.log(`  roster gaps (append)  : ${gaps}   ← genuinely absent from held games' p[]`);
  console.log(`  alias gaps (FOLD)     : ${aliasGap}   ← present under an UNRESOLVED id; appending would DUPLICATE`);
  console.log(`  uncaptured games      : ${uncap}   ← EMPTY roster; needs a capture sweep, and a repair will skip them`);
  console.log(`  games absent entirely : ${absent}   ← synthesis territory`);
  if (odd) console.log(`  ⚠ unreadable seasons  : ${odd}   ← a fault to look at, not a finding about the data`);
  if (noSide) console.log(`  ⚠ side unresolved     : ${noSide}`);
  console.log(`  a targeted repair for THIS player would recover ~${recoverApps} appearances / ${recoverPts} pts`);
  console.log(`  (read-only run — nothing was written)`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
