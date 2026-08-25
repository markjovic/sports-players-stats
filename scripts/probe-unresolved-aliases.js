// scripts/probe-unresolved-aliases.js
//
// Fetches PlayHQ box scores. Writes and COMMITS one report. No data-write lock.
//
// THE LAST 40. probe-shared-name-aliases examined the 87 aliases whose name is
// shared by several players and settled 47 of them from registrations alone:
// 24 CONFIRMED, 23 REPOINTED (applied 2026-08-24). It could not settle:
//
//   4 AMBIGUOUS  — two same-named candidates BOTH hold registrations fitting the
//                  games. Zachary Price, Samara Ballis, and — note — Ethan Belcher
//                  and Harrison Belcher, who look like brothers on one team, which
//                  is exactly why both fit.
//   36 NONE-FIT  — NO candidate holds a registration for those seasons, so our
//                  registration data is incomplete for them. That says nothing
//                  about whether the alias is right.
//
// Neither group is unsettleable. They are unsettleable BY THE TESTS BUILT SO FAR.
// The evidence that settles them is the one that settled Jida McCrae-Cooper by
// hand: open a box score for a game the alias delivers and read what PlayHQ calls
// that id, alongside every candidate and what each was registered to.
//
// THIS PRINTS EVERYTHING NEEDED TO DECIDE, IN ONE SCREEN PER ALIAS:
//   · the PlayHQ NAME and jersey NUMBER for the alias id, per game sampled
//   · which team the id was on in that game, and whether that is home or away
//   · every same-named candidate, their registration for THAT season and team,
//     their career size, and their PlayHQ profile link
//   · a VERDICT where the evidence is decisive, and a plain statement of what is
//     missing where it is not
//
// It NEVER writes an alias. Anything it settles goes through repoint-aliases,
// which re-verifies independently.
//
// Usage:
//   node scripts/probe-unresolved-aliases.js                 # all 40
//   node scripts/probe-unresolved-aliases.js --games=4       # sample more games each

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const num = (f, d) => {
  const a = args.find(x => x.startsWith('--' + f + '='));
  const v = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : d;
};
const GAMES_PER = num('games', 3);
const API_URL = 'https://api.playhq.com/graphql';
const TRUNC_LEN = 13;
const n = (x) => Number(x || 0).toLocaleString();

const normName = s => String(s == null ? '' : s).normalize('NFKC')
  .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
  .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, '-')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const GAMES_DIR     = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR   = path.join(ROOT, 'players');
const INDEX_DIR     = path.join(ROOT, 'players', 'indexes');
const INDEX_FILE    = path.join(ROOT, 'data', 'sports-index.json');

const CONCURRENCY_SPECTATOR = 3;       // unchanged (spectator.playhq.com)
const COMMIT_EVERY_GAMES    = Math.max(1, parseInt(process.env.SB_COMMIT_EVERY || '', 10) || 2000);    // flush + commit spc/p[] progress every N games (env override exists for crash-consistency testing only)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Identity alias for brand-new players (api-canonical, 2026-07-16) ─────────
// Every player file key must have an alias entry (trunc13(key) -> key), or the
// index gap the 3b-2 repair closed re-opens with every stub. Written at stub
// time; the matrix's recovery later REPLACES it with a redirect if the player
// turns out diverged. Format matches build-alias-index.js: sorted, minified.
// Covered by gitCommit(['players/']) — players/aliases sits under players/.
function writeAliasIdentity(uuid) {
  const bucket = uuid.slice(0, 2).toLowerCase();
  const aliasPath = path.join(ROOT, 'players', 'aliases', `${bucket}.json`);
  let map = {};
  try { map = JSON.parse(fs.readFileSync(aliasPath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const key = uuid.slice(0, TRUNC_LEN);
  if (map[key] !== undefined) return; // never clobber an existing (possibly redirect) entry
  map[key] = uuid;
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
  fs.writeFileSync(aliasPath, JSON.stringify(sorted));
}

// ─── HTTP — nightly-crawl.js, verbatim ────────────────────────────────────────

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

// ⚠ WRAPPED IN A PROMISE LOCK. Concurrent callers each seeing a missing cookie
// would otherwise fire their own refresh and invalidate each other — the failure
// that collapsed probe-alias-credits to concurrency 1 on 2026-08-23.
let sessionPromise = null;
async function refreshSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
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
})().finally(() => { sessionPromise = null; });
  return sessionPromise;
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
// ── IS THIS ID AN API PROFILE? ───────────────────────────────────────────────
// The stub decision below used to be: resolveToFullUuid() returned the id
// unchanged, therefore the id is canonical, therefore create a player file for it.
// That is a lookup in players/aliases, and ABSENCE FROM A TABLE IS NOT EVIDENCE OF
// ANYTHING. Since the alias builders (build-alias-index.js, build-alias-inverse.js)
// were deleted as migration-era tools, the only thing that writes new aliases is
// fetch-profile-stats.js — so discovery routinely runs ahead of aliasing, and every
// spectator id that arrived first became a player file.
//
// Measured 2026-08-21: 2,895 pairs of same-named player files, 122,866 duplicated
// appearances. Tahlia Parker is the worked example — 378 of her 385 shared games
// carry BOTH `20b2df06-37f4` (her real api profile) and `f806d1b6-f87f` (a spectator
// id that got stubbed) in the same p[]. PlayHQ serves the first and returns
// "There was a problem getting the profile" for the second.
//
// The design was always one file per API-CANONICAL uuid, with spectator ids
// recorded on it so their appearances resolve to the right person. This restores
// that: ASK PlayHQ before manufacturing a person. One call per genuinely-new id
// (115 in the 2026-08-20 sweep), and only for ids never seen before.
const PROFILE_EXISTS_QUERY = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) { seasonStatistics { name } }
}`;

// 'api' | 'not-api' | 'unknown'. `unknown` is a TRANSPORT outcome and must never be
// treated as either answer — on unknown the id is deferred, not stubbed and not
// aliased, so a throttle can never invent or discard a player.
async function isApiProfile(uuid) {
  if (!sessionCookie) await refreshSession();
  let res;
  try {
    res = await doFetch(API_URL,
      { operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: PROFILE_EXISTS_QUERY },
      { ...HEADERS_MAIN, 'Cookie': sessionCookie });
  } catch (e) { return 'unknown'; }
  // doFetch returns `body` ALREADY PARSED (null when the response is not JSON) and
  // the unparsed text as `rawText` — read both from the right field.
  const raw = res.rawText || '';
  if (res.status === 403) {
    // A private profile EXISTS — it just withholds statistics. Treat as api, or
    // every private player would be refused a file. CloudFront blocks are HTML.
    if (/DOCTYPE|Request blocked/i.test(raw)) return 'unknown';
    return 'api';
  }
  if (res.status === 404) return 'not-api';
  if (res.status < 200 || res.status >= 300) return 'unknown';
  const j = res.body;
  if (!j) return 'unknown';
  if (j.errors && j.errors.length) {
    const m = String(j.errors[0].message || '');
    if (/NOT_FOUND|failed to find profile/i.test(m)) return 'not-api';
    return 'unknown';
  }
  return (j.data && j.data.publicProfileStatistics !== undefined) ? 'api' : 'not-api';
}

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
      // 2026-08-20: THE PATTERN MISSED PLAYHQ'S ACTUAL WORDING AND CREATED A
      // PERMANENT LIMBO. The live message is
      //   "game could not be found or was not electronically scored"
      // with NO extensions.code at all (logged as `graphql:nocode:`). None of the
      // patterns above match "could not be found", so `permanent` came back FALSE
      // and the game was classed a TRANSPORT failure — nothing written, no spcm.
      //
      // That is the worst possible outcome, because the two paper-scored routes are
      // wired in series: spectator-backfill re-queues the game on every run for
      // ever, and discover-game-backfill selects on `spcm > 0` so it can NEVER see
      // it. On 2026-08-20 a full sweep produced 2,935 games in exactly that state
      // and the chained canonical-record run reported "Queue empty — nothing to do".
      //
      // "was not electronically scored" is a DATA FACT, not a network condition:
      // the box was kept on paper and the live-scoring service will never have it.
      // It belongs to the canonical record, and marking spcm is what hands it over.
      const perm = /NOT_FOUND|NOT FOUND|does not exist|no such|invalid.*id|BAD_USER_INPUT|could not be found|not electronically scored/i.test(code + ' ' + msg);
      return { ok: false, permanent: perm, why: 'graphql:' + (code || 'nocode') + ':' + (msg || 'nomsg') };
    }
    const g = body.data?.game;
    return g ? { ok: true, game: g } : { ok: false, permanent: true, why: 'no-game' };
  } catch (e) { return { ok: false, permanent: false, why: 'network-' + (e.code || e.message || 'err') }; }
}

// ─── Stat parsing — nightly-crawl.js, verbatim ────────────────────────────────

function spectatorStatValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const s = statistics.find(x => x.type?.value === typeValue);
  return s ? (s.count || 0) : 0;
}

function parseSpectatorPlayers(players) {
  if (!Array.isArray(players)) return [];
  return players
    .filter(p => p && p.profileID)
    .map(p => ({
      profileID: p.profileID,
      name:      p.name  || null,
      number:    p.playerNumber ?? null,
      pts:       spectatorStatValue(p.statistics, 'TOTAL_SCORE'),
      pt1:       spectatorStatValue(p.statistics, '1_POINT_SCORE'),
      pt2:       spectatorStatValue(p.statistics, '2_POINT_SCORE'),
      pt3:       spectatorStatValue(p.statistics, '3_POINT_SCORE'),
      fouls:     spectatorStatValue(p.statistics, 'TOTAL_FOULS'),
    }));
}

// ─── Concurrency pool — nightly-crawl.js, verbatim ────────────────────────────
const CREDITS_QUERY = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      statistics {
        teamStatistics { gradeStatistics { gameStatistics { game { id } } } }
      }
    }
  }
}`;

async function creditedGameIds(uuid) {
  if (!sessionCookie) await refreshSession();
  let res;
  try {
    res = await doFetch(API_URL,
      { operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: CREDITS_QUERY },
      { ...HEADERS_MAIN, 'Cookie': sessionCookie });
  } catch (e) { return null; }
  if (res.status === 403 || res.status === 404) return null;
  const j = res.body;
  if (!j || j.errors) return null;
  const out = new Set();
  for (const s of (j.data?.publicProfileStatistics?.seasonStatistics || [])) {
    for (const st of (s.statistics || [])) {
      for (const ts of (st.teamStatistics || [])) {
        for (const gs of (ts.gradeStatistics || [])) {
          for (const g of (gs.gameStatistics || [])) {
            const id = g?.game?.id;
            if (id) { out.add(String(id)); out.add(String(id).slice(0, 8)); out.games = (out.games || 0) + 1; }
          }
        }
      }
    }
  }
  return out;
}



const _GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const REPORT = 'reports/unresolved-alias-audit.json';

// A report uploaded only as an artifact does not exist to the next workflow.
function commitReport(message) {
  try {
    execSync('git add -- ' + REPORT, _GIT);
    const staged = execSync('git diff --staged --shortstat', _GIT).toString().trim();
    if (!staged) { console.log('  nothing to commit'); return; }
    console.log('  staging: ' + staged);
    execSync('git commit -q -m "probe-unresolved-aliases: ' + String(message).replace(/"/g, "'") + '"', _GIT);
    for (let a = 1; a <= 40; a++) {
      try { execSync('git merge --abort', _GIT); } catch (e) {}
      try {
        console.log('  … fetch/merge/push (attempt ' + a + ')');
        execSync('git fetch origin main', _GIT);
        execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', _GIT);
        execSync('git push origin main', _GIT);
        console.log('  ✔ pushed');
        return;
      } catch (e) {
        if (a === 40) throw new Error('push failed after 40 attempts');
        const w = 1 + Math.floor(Math.random() * 60);
        console.log('  … push attempt ' + a + ' failed, retrying in ' + w + 's');
        try { execSync('sleep ' + w, { stdio: 'pipe', timeout: (w + 30) * 1000 }); } catch (e2) {}
      }
    }
  } catch (e) { console.log('  ⚠ commit failed: ' + e.message); }
}

async function main() {
  console.log('probe-unresolved-aliases — the 4 ambiguous and 36 none-fit, in full');

  let audit;
  try { audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'shared-name-alias-audit.json'), 'utf8')); }
  catch (e) { console.error('ABORT: reports/shared-name-alias-audit.json not readable — ' + e.message); process.exit(1); }
  const pop = (audit.entries || []).filter(e => e && (e.verdict === 'ambiguous' || e.verdict === 'none-fit'));
  console.log('  ambiguous : ' + n(pop.filter(e => e.verdict === 'ambiguous').length));
  console.log('  none-fit  : ' + n(pop.filter(e => e.verdict === 'none-fit').length));
  if (!pop.length) { console.log('  nothing to do'); return; }

  // Candidate detail: name, career size, and registrations per season.
  const load = (uuid) => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'players', uuid.slice(0, 2), uuid + '.json'), 'utf8'));
      const regs = new Map();
      for (const se of (p.seasons || [])) {
        if (!se || !se.sid) continue;
        const e = { sn: se.sn || null, club: se.club || null, tids: [], tns: [] };
        for (const r of (se.regs || [])) { if (r && r.tid) { e.tids.push(r.tid); e.tns.push(r.tn || r.gn || null); } }
        regs.set(se.sid, e);
      }
      return { uuid, name: p.name || '?', games: (p.games || []).length,
               gp: p.sports?.Basketball?.gp ?? null, private: p.private === true, regs };
    } catch (e) { return { uuid, name: '(no player file)', games: 0, gp: null, regs: new Map() }; }
  };

  // The games each alias delivers, with season and both teams.
  const wantIds = new Set(pop.map(e => e.id));
  const games = new Map();
  for (const id of wantIds) games.set(id, []);
  const gamesDir = path.join(ROOT, 'games', 'bv');
  const teamName = new Map();
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = path.basename(f, '.json');
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const [gid, g] of Object.entries(sg.games || {})) {
      for (const e of (Array.isArray(g.p) ? g.p : [])) {
        const raw = e && e.id;
        if (!raw) continue;
        const key = wantIds.has(raw) ? raw : String(raw).slice(0, TRUNC_LEN);
        const arr = games.get(key);
        if (arr && wantIds.has(key) && arr.length < GAMES_PER) {
          arr.push({ gid, sid, h: g.h, a: g.a, spc: !!g.spc, dg: !!g.dg });
        }
      }
    }
  }

  const out = [];
  let decided = 0, undecided = 0, k = 0;
  for (const e of pop) {
    const gs = games.get(e.id) || [];
    const cands = (e.candidates || []).map(c => load(c.uuid));
    const row = { id: e.id, name: e.name, verdict: e.verdict, target: e.target, games: gs, box: [], candidates: [], decision: null };

    // Ask PlayHQ what it calls this id, in each sampled game.
    for (const g of gs) {
      const r = await gqlSpectator(g.gid);
      if (!r || !r.ok) { row.box.push({ gid: g.gid, error: 'no box score' }); continue; }
      let found = null;
      for (const side of ['home', 'away']) {
        for (const p of (r.game?.statistics?.[side]?.players || [])) {
          const pid = String(p.profileID || '');
          if (!pid) continue;                    // a Fill-in row carries NO id
          // Match in BOTH directions and at either length. A bare
          // `pid.slice(0, 13) === id` is the T37 fault — roster and box-score ids
          // are not one length, and comparing at a fixed offset silently misses.
          if (pid === e.id || pid.startsWith(e.id) || e.id.startsWith(pid)) {
            found = { gid: g.gid, sid: g.sid, side, name: String(p.name || '').trim(),
                      number: p.playerNumber || null, profileID: pid,
                      team: side === 'home' ? g.h : g.a };
          }
        }
      }
      row.box.push(found || { gid: g.gid, sid: g.sid, error: 'id not in the box score' });
    }

    // For each candidate, what did they hold in the seasons these games are in?
    for (const c of cands) {
      const per = gs.map(g => {
        const r = c.regs.get(g.sid);
        if (!r) return { sid: g.sid, held: null };
        const onSide = r.tids.includes(g.h) ? 'home' : r.tids.includes(g.a) ? 'away' : null;
        return { sid: g.sid, held: { sn: r.sn, club: c.regs.get(g.sid).club, tids: r.tids, tns: r.tns, onSide } };
      });
      row.candidates.push({ uuid: c.uuid, name: c.name, games: c.games, gp: c.gp, private: c.private,
                            isCurrent: c.uuid === e.target, perSeason: per,
                            link: 'https://www.playhq.com/public/profile/' + c.uuid + '/statistics' });
    }

    // Decide ONLY where the box score names a team a single candidate was on.
    const sides = row.box.filter(b => b && b.team);
    if (sides.length) {
      const fits = row.candidates.filter(c => c.perSeason.some(p =>
        p.held && p.held.tids.some(t => sides.some(s => s.team === t))));
      if (fits.length === 1) { row.decision = { verdict: 'repoint-or-confirm', uuid: fits[0].uuid,
        why: 'the box score names the TEAM, and only this candidate was registered to it that season' }; decided++; }
      else if (fits.length > 1) { row.decision = { verdict: 'still ambiguous', why: fits.length + ' candidates were registered to that exact team' }; undecided++; }
      else { row.decision = { verdict: 'no candidate registered to that team', why: 'our registration data does not cover it' }; undecided++; }
    } else { row.decision = { verdict: 'no box score', why: 'PlayHQ does not retain one for these games' }; undecided++; }

    out.push(row);
    if (++k % 5 === 0) console.log('  … ' + k + '/' + pop.length + '  decided ' + decided + ' · undecided ' + undecided);
  }

  // ── The full listing ──────────────────────────────────────────────────────
  console.log('');
  console.log('  ══ EVERY UNRESOLVED ALIAS, IN FULL ════════════════════════════════');
  for (const r of out) {
    console.log('');
    console.log('  ─────────────────────────────────────────────────────────────────');
    console.log('  ' + r.id + '   ' + JSON.stringify(r.name) + '   [' + r.verdict + ']');
    console.log('    currently points at : ' + r.target);
    console.log('    PLAYHQ BOX SCORE says this id is:');
    for (const b of r.box) {
      if (b.error) { console.log('      game ' + b.gid + '  — ' + b.error); continue; }
      console.log('      game ' + b.gid + ' (season ' + b.sid + ')  ' + JSON.stringify(b.name) +
                  (b.number ? '  #' + b.number : '') + '  on the ' + b.side + ' team ' + b.team);
    }
    console.log('    CANDIDATES carrying that name:');
    for (const c of r.candidates) {
      console.log('      ' + c.uuid + (c.isCurrent ? '  [CURRENT]' : '') + (c.private ? '  [PRIVATE]' : ''));
      console.log('        name ' + JSON.stringify(c.name) + '  · games held ' + n(c.games) + '  · PlayHQ gp ' + (c.gp ?? '—'));
      for (const p of c.perSeason) {
        if (!p.held) { console.log('        season ' + p.sid + ': NO registration held'); continue; }
        console.log('        season ' + p.sid + ': ' + (p.held.sn || '(unnamed)') +
                    (p.held.club ? ' · ' + p.held.club : '') +
                    ' · teams ' + (p.held.tids.join(', ') || 'none') +
                    (p.held.onSide ? '   ← ON THE ' + p.held.onSide.toUpperCase() + ' TEAM OF THIS GAME' : ''));
        if (p.held.tns.filter(Boolean).length) console.log('              ' + p.held.tns.filter(Boolean).join(' | '));
      }
      console.log('        ' + c.link);
    }
    console.log('    → ' + r.decision.verdict.toUpperCase() + (r.decision.uuid ? ': ' + r.decision.uuid : ''));
    console.log('      ' + r.decision.why);
  }

  console.log('');
  console.log('  ══ SUMMARY ════════════════════════════════════════════════════════');
  console.log('    decided by the box score\'s team : ' + n(decided));
  console.log('    still undecided                  : ' + n(undecided));
  console.log('');
  console.log('    A decided entry names the team from PlayHQ\'s own box score and finds');
  console.log('    exactly ONE candidate registered to that team that season. Feed it to');
  console.log('    repoint-aliases, which re-verifies independently before writing.');

  try {
    fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, REPORT), JSON.stringify({ generated: new Date().toISOString(),
      decided, undecided,
      entries: out.map(r => ({ id: r.id, name: r.name, verdict: r.verdict, target: r.target,
        correctTarget: r.decision.verdict === 'repoint-or-confirm' && r.decision.uuid !== r.target ? r.decision.uuid : null,
        decision: r.decision, box: r.box, candidates: r.candidates, games: r.games })) }, null, 1));
    console.log('');
    console.log('  WRITTEN: ' + REPORT);
    commitReport(decided + ' decided, ' + undecided + ' undecided');
  } catch (e) { console.log('  ⚠ could not write report: ' + e.message); }
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
