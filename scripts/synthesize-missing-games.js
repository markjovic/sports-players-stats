// scripts/synthesize-missing-games.js
//
// One-off (re-runnable) synthesizer for OUTSTANDING §2.2: the 9 games proven by
// probe-missing-games.js (2026-08-06) to be ABSENT from games/bv entirely, with
// round / home / away / grade / player stat line all arriving in profile
// responses. This tool captures exactly what arrives — no discovery, no guessing.
//
// What it writes, per absent game, into games/bv/{sid}.json under the game id:
//   { profileOnly:true, rn, gid (grade id), gn, h/hn/a/an, st:'FINAL',
//     p:[{id: uuid13}], hp/ap:[{profileID: uuid13, pts,pt1,pt2,pt3,fouls}] }
// using the NORMAL h/a shape (the profile names both sides explicitly), flagged
// profileOnly:true — the documented "found only via profile API" flag.
// Deliberately ABSENT because the profile carries none of them: d (date),
// vid/vn/ct/t (venue — a documented dead route), hs/as (team scores). st:'FINAL'
// with no scores is a representable state (the legacy-trio render path).
//
// If a game is already HELD: it is touched ONLY when it carries profileOnly:true
// and this player is absent — then the player is appended (p[] + hp/ap line).
// Real crawl data is never modified; held non-profileOnly games are logged and
// skipped (that population is an alias/fold or p[]-append question, NOT this
// tool's business — probe verdicts, 2026-08-06).
//
// These seasons are LOCKED and ARCHIVED (2022): the matching workflow dispatches
// Deploy Archive Pages at its tail on apply (split invariant — writers of
// locked-season files trigger an archive redeploy; the weekly cron backstops).
//
// The query, headers, session handling, doFetch, fetchProfile and statValue
// below are COPIED VERBATIM from scripts/probe-missing-games.js (itself verbatim
// from the deployed fetch-profile-stats.js) — asserted byte-identical at build.
//
// Usage:
//   node scripts/synthesize-missing-games.js --uuids=<uuid,uuid,...>            # DRY RUN (default)
//   node scripts/synthesize-missing-games.js --uuids=<uuid,uuid,...> --apply    # write files
//
// No git here — the workflow's commit step does it once (house pattern).

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const UUIDS = (args.find(a => a.startsWith('--uuids=')) || '').replace('--uuids=', '')
  .split(',').map(s => s.trim()).filter(Boolean);
const APPLY = args.includes('--apply');
const TRUNC_LEN = 13;

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

// ─── Synthesis ────────────────────────────────────────────────────────────────
function loadSeasonFile(gamesDir, sid) {
  const p = path.join(gamesDir, `${sid}.json`);
  if (!fs.existsSync(p)) return { path: p, data: { games: {} }, created: true };
  return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')), created: false };
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
  if (!UUIDS.length) {
    console.error('Usage: node scripts/synthesize-missing-games.js --uuids=<uuid,...> [--apply]');
    process.exit(1);
  }
  console.log(`synthesize-missing-games ${APPLY ? '[APPLY]' : '[dry-run]'} — ${UUIDS.length} profile(s)`);

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
  console.log(`  Known gids on file: ${gidToSid.size.toLocaleString()}`);

  const seasonFiles = new Map();   // sid -> {path,data,created,changed}
  const created = [], appended = [], skippedHeld = [], noSide = [];

  for (const uuid of UUIDS) {
    console.log(`\n══ ${uuid} ══`);
    const uuid13 = uuid.slice(0, TRUNC_LEN);
    const r = await fetchProfile(uuid);
    if (r.status !== 'ok') { console.log(`  status=${r.status} — skipping profile`); continue; }
    const seasonStats = r.data?.publicProfileStatistics?.seasonStatistics || [];

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
              const g = gs.game;
              const side = g.home?.id === tid ? 'HOME' : g.away?.id === tid ? 'AWAY' : null;

              if (heldSid) {
                // Touch ONLY our own profileOnly entries; real crawl data stays alone.
                if (!seasonFiles.has(heldSid)) seasonFiles.set(heldSid, { ...loadSeasonFile(gamesDir, heldSid), changed: false });
                const sf = seasonFiles.get(heldSid);
                const entry = sf.data.games?.[gameId];
                if (!entry || entry.profileOnly !== true) { if (entry) skippedHeld.push(`${gameId} sid=${heldSid}`); continue; }
                const inP = (entry.p || []).some(x => x.id === uuid13);
                if (inP) continue;
                entry.p = entry.p || []; entry.p.push({ id: uuid13 });
                if (side === 'HOME') { entry.hp = entry.hp || []; entry.hp.push(buildStatLine(uuid13, gs.statistics)); }
                else if (side === 'AWAY') { entry.ap = entry.ap || []; entry.ap.push(buildStatLine(uuid13, gs.statistics)); }
                else noSide.push(`${gameId} tid=${tid}`);
                sf.changed = true;
                appended.push(`${gameId} sid=${heldSid} player=${uuid13} side=${side || '??'}`);
                continue;
              }

              // Absent everywhere: synthesize.
              if (!seasonFiles.has(sid)) seasonFiles.set(sid, { ...loadSeasonFile(gamesDir, sid), changed: false });
              const sf = seasonFiles.get(sid);
              sf.data.games = sf.data.games || {};
              const entry = {
                profileOnly: true,
                rn:  g.round?.name || null,
                gid: gradeStat.grade?.id || null,
                gn:  gradeStat.grade?.name || null,
                h:  g.home?.id || null, hn: g.home?.name || null,
                a:  g.away?.id || null, an: g.away?.name || null,
                st: 'FINAL',
                p:  [{ id: uuid13 }],
              };
              const line = buildStatLine(uuid13, gs.statistics);
              if (side === 'HOME') entry.hp = [line];
              else if (side === 'AWAY') entry.ap = [line];
              else noSide.push(`${gameId} tid=${tid}`);
              sf.data.games[gameId] = entry;
              sf.changed = true;
              gidToSid.set(gameId, sid);   // a second uuid in the same run APPENDS, not re-creates
              created.push(`${gameId} sid=${sid} rn=${entry.rn} ${entry.hn} vs ${entry.an} player=${uuid13} side=${side || '??'}`);
              console.log(`  SYNTH ${gameId} sid=${sid} "${entry.rn}" ${entry.hn} vs ${entry.an}  (no d/vid/hs/as — profile carries none)`);
            }
          }
        }
      }
    }
    await sleep(1000);
  }

  let filesWritten = 0;
  for (const [sid, sf] of seasonFiles) {
    if (!sf.changed) continue;
    if (sf.created) console.log(`  ⚠ season file games/bv/${sid}.json did not exist — creating it (minimal {games:{}} shape)`);
    if (APPLY) { fs.writeFileSync(sf.path, JSON.stringify(sf.data)); filesWritten++; }
    else filesWritten++;
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(`  Games synthesized : ${created.length}${APPLY ? '' : ' (dry-run — nothing written)'}`);
  for (const c of created) console.log(`    ${c}`);
  console.log(`  Players appended to existing profileOnly games: ${appended.length}`);
  for (const a of appended) console.log(`    ${a}`);
  console.log(`  Held REAL games skipped (not this tool's business): ${skippedHeld.length}`);
  for (const s of skippedHeld.slice(0, 10)) console.log(`    ${s}`);
  if (noSide.length) console.log(`  ⚠ side unresolved (p[] only, no stat line): ${noSide.length} — ${noSide.join('; ')}`);
  console.log(`  Season files ${APPLY ? 'written' : 'to write'}: ${filesWritten}`);
  console.log('  Downstream: player games[]/appearances/aggregates rebuild from games/bv via the');
  console.log('  normal builders (post-drain chain, weekly). Locked seasons: the workflow tail');
  console.log('  dispatches Deploy Archive Pages so the archive origin serves the new entries.');
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
module.exports = { buildStatLine, loadSeasonFile };
