// scripts/probe-wrong-rosters.js
//
// READ-ONLY. No writes, no git, no lock.
//
// THE QUESTION. 970,068 appearances sit in games where the roster holds the
// player's OWN 13-char id and the player was registered to NEITHER team. No alias
// resolution is involved — something wrote that id into that game. 1,115,014 of
// 1,115,172 wrong appearances came through the spc (spectator) path. And PlayHQ's
// own box score for one such game (Max Thomson, Ballarat, 2026-08-18) names twelve
// players, none of them him.
//
// Two explanations remain and they are distinguishable by asking PlayHQ again:
//   A. WE STORED THE WRONG GAME'S ROSTER. A response was associated with a
//      different game id than the one it describes. Then the live roster for that
//      id will be a DIFFERENT SET OF PEOPLE from what we hold — and, tellingly,
//      our stored set will match some OTHER game.
//   B. PLAYHQ CHANGED. The box score we captured was correct then and has since
//      been edited. Then the live roster will overlap ours substantially and
//      differ only at the edges.
// Overlap is the discriminator: near-zero says A, high says B.
//
// It also re-checks the 145,049 appearances delivered by an ALIAS id (9,091
// distinct aliases). Those are a SECOND fault, not noise — one in eight of the
// wrong ones — and the same fetch answers whether the alias's own id appears in
// the live roster at all.
//
// Usage:
//   node scripts/probe-wrong-rosters.js --sample=60
//   node scripts/probe-wrong-rosters.js --uuid=<player uuid>   # that player only
//
// NO setup-node in the workflow (this fetches playhq.com — absolute rule).

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
const SAMPLE = num('sample', 60);
const SEED   = num('seed', 20260818);
const ONLY   = (args.find(x => x.startsWith('--uuid=')) || '').split('=')[1] || '';

// The endpoints the copied block calls. Both are defined ABOVE the extraction
// point in spectator-backfill.js, so the copy did not bring them — and because
// refreshSession wraps its attempt in `catch (_) {}`, an undefined API_URL threw
// silently ten times and reported "Failed to obtain session after 10 attempts".
// A misleading error, not a missing endpoint.
const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';

// Defined HERE, not inherited. It lives ABOVE the block copied out of
// spectator-backfill.js, so the copy did not bring it — and the first test harness
// happened to define its own, which hid the fault instead of exposing it. A stub
// that supplies a missing dependency tests the stub, not the file.
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function doFetch(url, bodyObj, headers) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify(bodyObj);
    const parsed = new URL(url);
    const h      = { ...headers, 'request-id': crypto.randomUUID(),
                     'content-length': Buffer.byteLength(body) };
    const req    = https.request(
      { hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
        headers: h, agent: new https.Agent({ keepAlive: false }) },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = JSON.parse(rawText); } catch (_) { body = null; }
          resolve({
            status:     res.statusCode,
            rawCookies: res.headers['set-cookie'],
            body,
            rawText,
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Session — nightly-crawl.js, verbatim ─────────────────────────────────────

const HEADERS_MAIN = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};
const HEADERS_SPECTATOR = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'bv', 'x-phq-tenant': 'bv', 'content-type': 'application/json',
};

let sessionCookie = null;

async function refreshSession() {
  const body = { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const { rawCookies } = await doFetch(API_URL, body, HEADERS_MAIN);
      if (!rawCookies) continue;
      const arr = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
        .map(c => c.split(';')[0].trim());
      const get = n => arr.find(p => p.startsWith(n + '=')) || null;
      const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
      if (tier && session && sub) {
        sessionCookie = `${tier}; ${session}; ${sub}`;
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    } catch (_) {}
  }
  throw new Error('Failed to obtain session after 10 attempts');
}

// ─── Spectator query — nightly-crawl.js, verbatim ─────────────────────────────

// 2026-08-10: returns a CLASSIFIED outcome, never a bare null. Previously every
// failure mode collapsed to null, so a 403 that survived its retry, a 429, a 502
// and a dropped connection were indistinguishable from "this game genuinely has
// no box score" — and with --miss-attempts=1 one bad moment retired a game
// FOREVER. Proven by spot-check 2026-08-10: of four retired misses in seasons
// with >95% capture, THREE had full box scores on playhq.com. Contract:
//   { ok:true,  game }                    → fetched; caller decides empty vs not
//   { ok:false, permanent:true }          → 404, or a 200 whose game is null:
//                                           not on the spectator endpoint at all.
//                                           Counts toward retirement.
//   { ok:false, permanent:false }         → 403-after-retry / 429 / 5xx / GraphQL
//                                           error / network fault. TRANSPORT, not
//                                           data: must NEVER count toward
//                                           retirement, or the weekly cron will
//                                           quietly delete games from the queue
//                                           on every bad network minute.
async function gqlSpectator(gameId) {
  if (!sessionCookie) await refreshSession();
  const query = `query game($id: ID!) {
    game(id: $id) {
      id status
      statistics {
        home { players { profileID name playerNumber statistics { type { value } count } } }
        away { players { profileID name playerNumber statistics { type { value } count } } }
      }
    }
  }`;
  try {
    const { status, body } = await doFetch(
      SPECTATOR_URL,
      { operationName: 'game', variables: { id: gameId }, query },
      { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
    );
    if (status === 403) {
      // Single refresh then retry — do not loop
      await refreshSession();
      const retry = await doFetch(
        SPECTATOR_URL,
        { operationName: 'game', variables: { id: gameId }, query },
        { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
      );
      if (retry.status === 404) return { ok: false, permanent: true, why: '404' };
      if (retry.status !== 200 || retry.body.errors) return { ok: false, permanent: false, why: '403-retry-' + retry.status };
      const g403 = retry.body.data?.game;
      return g403 ? { ok: true, game: g403 } : { ok: false, permanent: true, why: 'no-game' };
    }
    if (status === 404) return { ok: false, permanent: true, why: '404' };
    if (status !== 200) return { ok: false, permanent: false, why: 'http-' + status };
    if (body.errors) {
      // 2026-08-11: log WHAT the error says. The first version returned a bare
      // 'graphql-error', and a 200-game probe of re-admitted misses came back
      // 200/200 with that label — which distinguishes nothing. The message and
      // extensions.code separate a permanent NOT_FOUND (the endpoint cannot serve
      // this game id at all — retirement was CORRECT) from an auth/permission or
      // throttle error (genuinely transient). Sampled id shapes suggest the former:
      // the missed games' ids are overwhelmingly all-numeric, i.e. a legacy id
      // format, while captured games' ids are hex.
      const e0 = body.errors[0] || {};
      const code = (e0.extensions && (e0.extensions.code || e0.extensions.errorType)) || '';
      const msg  = String(e0.message || '').slice(0, 80);
      const perm = /NOT_FOUND|NOT FOUND|does not exist|no such|invalid.*id|BAD_USER_INPUT/i.test(code + ' ' + msg);
      return { ok: false, permanent: perm, why: 'graphql:' + (code || 'nocode') + ':' + (msg || 'nomsg') };
    }
    const g = body.data?.game;
    return g ? { ok: true, game: g } : { ok: false, permanent: true, why: 'no-game' };
  } catch (e) { return { ok: false, permanent: false, why: 'network-' + (e.code || e.message || 'err') }; }
}


// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('probe-wrong-rosters [READ-ONLY] — sample=' + SAMPLE + ' seed=' + SEED + (ONLY ? ' uuid=' + ONLY : ''));

  // Aliases, so an appearance can be attributed to the id that delivered it.
  const aliasMap = new Map();
  try {
    const d = path.join(ROOT, 'players', 'aliases');
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      const sh = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      for (const k of Object.keys(sh)) aliasMap.set(k, sh[k]);
    }
  } catch (e) { console.log('  players/aliases unreadable: ' + e.message); }
  console.log('  alias entries: ' + aliasMap.size.toLocaleString());

  // Registrations per player, and the games they hold.
  const playersDir = path.join(ROOT, 'players');
  const regs = new Map();     // uuid -> Set(tid)
  const held = new Map();     // uuid -> [gid]
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
      regs.set(uuid, t);
      held.set(uuid, Array.isArray(p.games) ? p.games : []);
    }
  }
  console.log('  players with registrations: ' + regs.size.toLocaleString());

  // Find wrong appearances: player holds the game, registered to neither side.
  const gamesDir = path.join(ROOT, 'games', 'bv');
  const gameOf = new Map();   // gid -> { sid, h, a, p:[ids], spc, dg }
  const wanted = new Set();
  for (const [, gl] of held) for (const g of gl) wanted.add(g);
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = path.basename(f, '.json');
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const gid of Object.keys(sg.games || {})) {
      if (!wanted.has(gid)) continue;
      const g = sg.games[gid];
      gameOf.set(gid, { sid: sid, h: g.h || null, a: g.a || null, gn: g.gn || '',
                        p: (Array.isArray(g.p) ? g.p : []).map(x => x && x.id).filter(Boolean),
                        spc: !!g.spc, dg: !!g.dg });
    }
  }

  const cases = [];
  for (const [uuid, gl] of held) {
    const t = regs.get(uuid);
    if (!t) continue;
    for (const gid of gl) {
      const g = gameOf.get(gid);
      if (!g) continue;
      if ((g.h && t.has(g.h)) || (g.a && t.has(g.a))) continue;
      const own = uuid.slice(0, TRUNC_LEN);
      const via = g.p.includes(own) ? own : (g.p.find(id => aliasMap.get(id) === uuid) || null);
      if (!via) continue;
      cases.push({ uuid: uuid, gid: gid, via: via, byOwn: via === own, g: g });
    }
  }
  console.log('  wrong appearances found: ' + cases.length.toLocaleString());
  if (!cases.length) { console.log('  nothing to probe'); return; }

  const rnd = mulberry32(SEED);
  for (let i = cases.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cases[i], cases[j]] = [cases[j], cases[i]]; }
  const targets = cases.slice(0, SAMPLE);
  console.log('  probing: ' + targets.length + '\n');

  let fetched = 0, failed = 0, storedIdPresentLive = 0, absentLive = 0;
  let sumOverlap = 0, zeroOverlap = 0, highOverlap = 0;
  const byWhy = new Map();

  for (const c of targets) {
    const r = await gqlSpectator(c.gid);
    if (!r.ok) {
      failed++;
      byWhy.set(r.why, (byWhy.get(r.why) || 0) + 1);
      console.log('  ✗ ' + c.gid + '  fetch failed: ' + r.why);
      await sleep(1200);
      continue;
    }
    fetched++;
    const live = new Set();
    const liveNames = [];
    for (const side of ['home', 'away']) {
      for (const p of ((r.game.statistics && r.game.statistics[side] && r.game.statistics[side].players) || [])) {
        if (!p || !p.profileID) continue;
        live.add(String(p.profileID).slice(0, TRUNC_LEN));
        if (liveNames.length < 30) liveNames.push(p.name || '?');
      }
    }
    const stored = new Set(c.g.p);
    let inter = 0;
    for (const id of stored) if (live.has(id)) inter++;
    const overlap = stored.size ? (100 * inter / stored.size) : 0;
    sumOverlap += overlap;
    if (overlap === 0) zeroOverlap++;
    if (overlap >= 80) highOverlap++;
    const present = live.has(c.via);
    if (present) storedIdPresentLive++; else absentLive++;

    console.log('  ' + (present ? '·' : '⚠') + ' ' + c.gid + '  ' + (c.byOwn ? 'own-id' : 'alias ') +
                '  stored ' + String(stored.size).padStart(3) + '  live ' + String(live.size).padStart(3) +
                '  overlap ' + overlap.toFixed(0).padStart(3) + '%  ' +
                (present ? 'the id IS in the live roster' : 'the id is NOT in the live roster') +
                '  [' + (c.g.spc ? 'spc' : '') + (c.g.dg ? 'dg' : '') + ']');
    await sleep(1200);
  }

  const pc = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';
  console.log('\n════════════════════════════════════════════════');
  console.log('  games fetched                 : ' + fetched + '   (failed ' + failed + ')');
  for (const [w, c] of [...byWhy.entries()].sort((a, b) => b[1] - a[1])) console.log('      ' + String(c).padStart(4) + '  ' + w);
  if (!fetched) { console.log('  nothing fetched — cannot conclude'); return; }
  console.log('  the stored id IS live         : ' + storedIdPresentLive + '  (' + pc(storedIdPresentLive, fetched) + '%)');
  console.log('  the stored id is NOT live     : ' + absentLive + '  (' + pc(absentLive, fetched) + '%)');
  console.log('  mean roster overlap           : ' + (sumOverlap / fetched).toFixed(1) + '%');
  console.log('    games with ZERO overlap     : ' + zeroOverlap + '  (' + pc(zeroOverlap, fetched) + '%)');
  console.log('    games with 80%+ overlap     : ' + highOverlap + '  (' + pc(highOverlap, fetched) + '%)');
  console.log('');
  console.log('  HOW TO READ IT:');
  console.log('    Low overlap  → we stored a DIFFERENT GAME\'s roster against this id. A capture');
  console.log('                   or indexing fault, and the stored rosters belong somewhere else.');
  console.log('    High overlap + the id NOT live → PlayHQ served us this roster and has since');
  console.log('                   changed it, OR it serves a different set to the API than to the');
  console.log('                   website. Ours would then be a stale but once-true record.');
  console.log('    High overlap + the id IS live → the spectator endpoint still returns this player');
  console.log('                   for this game, and the registration data is what is wrong.');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
