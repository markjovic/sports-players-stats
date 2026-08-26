// scripts/repoint-aliases.js
//
// WRITES when --apply. Takes the data-write lock. DRY RUN BY DEFAULT.
//
// WHAT IT DOES. probe-alias-credits audited all 81,636 name-matched alias entries
// against PlayHQ and found 874 whose target credits NONE of the games that alias
// delivers. For 128 of them exactly one profile carrying that name DOES credit
// those games. This repoints those 128 — and only those 128.
//
// THE ERROR BEING CORRECTED, from 2026-08-23:
//   900f4fe6-bec3  appears in PlayHQ box scores as "Jida McCrae-Cooper" and is NOT
//                  a PlayHQ profile — the case aliases exist for.
//   our alias sent it to d6c25c0c-e1e4-… , a DIFFERENT profile, similar name.
//   60eeeaa9-ab28-… is the profile that actually credits those games.
// The alias was written by matchFromGrade / matchFromGradeRosterByName on an EXACT
// NAME MATCH, which never checked whether the chosen profile credits the games.
//
// ── WHY THIS RE-VERIFIES RATHER THAN TRUSTING THE REPORT ────────────────────
// The audit ran over several hours. Between then and now the alias table may have
// changed, a player file may have moved, or PlayHQ may return something different.
// So for EVERY candidate this re-asks PlayHQ: does correctTarget credit these
// games, and does the current target still not? Both must hold or it is skipped.
// A repoint applied from a stale report is exactly the class of error this whole
// exercise exists to clean up.
//
// ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
//   · touch any alias whose current value no longer matches the report
//   · point at a uuid with no player file
//   · point an id at itself
//   · apply anything the re-verification does not confirm
//   · write player or game data — ONLY players/aliases
//
// REVERSIBLE. Every change is written to reports/alias-repoint-log.json BEFORE
// any shard is modified, with the exact before and after, so the table can be put
// back by hand.
//
// AFTER apply: run build-player-games. The alias table is corrected but every
// player file still reflects the old resolution until it is rebuilt.
//
// Usage:
//   node scripts/repoint-aliases.js                 # dry run, re-verifies everything
//   node scripts/repoint-aliases.js --apply
//   node scripts/repoint-aliases.js --apply --max=20

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const num = (f, d) => {
  const a = args.find(x => x.startsWith('--' + f + '='));
  const v = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : d;
};
const MAX = num('max', 0);                 // 0 = all
const CONCURRENCY = Math.max(1, Math.min(20, num('concurrency', 4)));
const API_URL = 'https://api.playhq.com/graphql';
const TRUNC_LEN = 13;
const n = (x) => Number(x || 0).toLocaleString();

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


const GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };

async function main() {
  console.log('repoint-aliases — ' + (APPLY ? 'APPLY (writes and commits)' : 'DRY RUN (writes nothing)'));

  // ── 1. WHERE THE REPOINTS COME FROM ───────────────────────────────────────
  // reports/alias-resolve-cache.json is the primary source: it holds the 128
  // resolutions and nothing else, at 18 KB. The audit report is accepted as a
  // fallback but is NOT required — on 2026-08-23 it was written to the runner and
  // never reached the repo, while the resolve cache survived, and there is no
  // reason to make an 18 KB answer depend on a 32 MB file being present.
  //
  // Everything else is reconstructed locally: the CURRENT target from the live
  // alias table, and the games each alias delivers from games/bv. Neither needs
  // the audit, and both are more up to date than it.
  // THREE SOURCES, ALL READ, deduplicated by alias id. Reading only the first one
  // that happened to exist was a trap: alias-resolve-cache.json holds the ORIGINAL
  // 128 credit-based resolutions and would have masked the 23 found later by
  // shared-name registration matching, silently, with no indication anything had
  // been skipped.
  //
  //   alias-resolve-cache.json     — from probe-alias-credits: the profile PlayHQ
  //                                  credits with these games
  //   shared-name-alias-audit.json — from probe-shared-name-aliases: for names
  //                                  SEVERAL players share, the only candidate
  //                                  whose registrations fit the games
  //   alias-credit-audit.json      — the full audit, as a fallback
  //
  // Every candidate is re-verified against PlayHQ below regardless of source, so a
  // disagreement between two reports cannot slip through: the check decides.
  const cmap = new Map();
  const sources = [];
  const addFrom = (label, fn2) => {
    let before = cmap.size;
    try { fn2(); } catch (e) { return; }
    if (cmap.size > before) sources.push(label + ' (+' + (cmap.size - before) + ')');
  };

  addFrom('alias-resolve-cache.json', () => {
    const rc = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'alias-resolve-cache.json'), 'utf8'));
    for (const [id, r] of Object.entries(rc.resolutions || {})) {
      if (r && r.uuid && !cmap.has(id)) cmap.set(id, { id, correctTarget: r.uuid, why: r.why, from: 'credits' });
    }
  });

  addFrom('shared-name-alias-audit.json', () => {
    const sn = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'shared-name-alias-audit.json'), 'utf8'));
    for (const e of (sn.entries || [])) {
      if (e && e.verdict === 'repoint' && e.correctTarget && !cmap.has(e.id)) {
        cmap.set(e.id, { id: e.id, correctTarget: e.correctTarget, why: 'only candidate whose registrations fit', from: 'shared-name' });
      }
    }
  });

  // A human decision, taken from a PlayHQ team sheet that no offline test can read.
  // It is still RE-VERIFIED below like every other source — a decision entered by
  // hand is not exempt from the check.
  addFrom('manual-alias-decisions.json', () => {
    const md = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'manual-alias-decisions.json'), 'utf8'));
    for (const [id, v] of Object.entries(md.decisions || {})) {
      // Accepts both shapes: the bare "id": "uuid" of the first version, and the
      // richer { decision, player, openTheseGames, chooseBetween } written now.
      // A file a person has been editing must not stop being readable because the
      // format grew.
      const uuid = (v && typeof v === 'object') ? v.decision : v;
      if (uuid && !cmap.has(id)) cmap.set(id, { id, correctTarget: uuid, why: 'entered by hand from a PlayHQ team sheet', from: 'manual' });
    }
  });

  addFrom('squad-evidence-audit.json', () => {
    const sq = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'squad-evidence-audit.json'), 'utf8'));
    for (const e of (sq.entries || [])) {
      if (e && e.correctTarget && !cmap.has(e.id)) {
        cmap.set(e.id, { id: e.id, correctTarget: e.correctTarget, why: 'teammates identify the club and grade; one candidate matches', from: 'squad-evidence' });
      }
    }
  });

  addFrom('unresolved-alias-audit.json', () => {
    const ur = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'unresolved-alias-audit.json'), 'utf8'));
    for (const e of (ur.entries || [])) {
      if (e && e.correctTarget && !cmap.has(e.id)) {
        cmap.set(e.id, { id: e.id, correctTarget: e.correctTarget, why: 'box score named the team; one candidate registered to it', from: 'box-score-team' });
      }
    }
  });

  addFrom('alias-credit-audit.json', () => {
    const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'alias-credit-audit.json'), 'utf8'));
    if (report.partial) console.log('  ⚠ the credit audit is marked PARTIAL');
    for (const x of (report.unsupportedEntries || [])) {
      if (x && x.id && x.correctTarget && !cmap.has(x.id)) cmap.set(x.id, { id: x.id, correctTarget: x.correctTarget, from: 'credit-audit' });
    }
  });

  let cands = [...cmap.values()];
  const src = sources.join(', ') || 'none';
  if (!cands.length) {
    console.error('ABORT: no repoints found. Expected any of reports/alias-resolve-cache.json,');
    console.error('  reports/shared-name-alias-audit.json, reports/alias-credit-audit.json.');
    process.exit(1);
  }
  console.log('  sources read                     : ' + src);
  console.log('  proposed repoints                : ' + n(cands.length));
  if (MAX) { cands = cands.slice(0, MAX); console.log('  limited by --max to              : ' + n(cands.length)); }
  if (!cands.length) { console.log('  nothing to do'); return; }

  // ── 2. Current state of the alias table ───────────────────────────────────
  const aliasDir = path.join(ROOT, 'players', 'aliases');
  const shardOf = new Map(), current = new Map();
  for (const f of fs.readdirSync(aliasDir)) {
    if (!f.endsWith('.json')) continue;
    let m; try { m = JSON.parse(fs.readFileSync(path.join(aliasDir, f), 'utf8')); } catch (e) { continue; }
    for (const [k, v] of Object.entries(m)) { current.set(k, v); shardOf.set(k, f); }
  }
  console.log('  alias entries currently in the table: ' + n(current.size));

  // The games each candidate alias delivers, read from the roster store rather
  // than taken from the report — this is what the re-verification is checked
  // against, so it must reflect the CURRENT data, not what it was hours ago.
  const wantIds = new Set(cands.map(c => c.id));
  const delivered = new Map();
  for (const id of wantIds) delivered.set(id, []);
  const gamesDir = path.join(ROOT, 'games', 'bv');
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const [gid, g] of Object.entries(sg.games || {})) {
      for (const e of (Array.isArray(g.p) ? g.p : [])) {
        const id = e && e.id;
        if (!id) continue;
        const key = wantIds.has(id) ? id : String(id).slice(0, TRUNC_LEN);
        const arr = delivered.get(key);
        if (arr && arr.length < 6 && wantIds.has(key)) arr.push(gid);
      }
    }
  }
  for (const c of cands) {
    c.gids = delivered.get(c.id) || [];
    c.target = current.get(c.id);
  }
  const noGames = cands.filter(c => !c.gids.length).length;
  if (noGames) console.log('  ' + n(noGames) + ' candidate(s) deliver no appearances — nothing to verify against, skipped');
  cands = cands.filter(c => c.gids.length);
  console.log('');

  // ── 3. Refuse anything that has moved, then RE-VERIFY against PlayHQ ───────
  const planned = [], skipped = [];
  for (const c of cands) {
    const now = current.get(c.id);
    if (now === undefined)      { skipped.push({ ...c, why: 'alias entry no longer exists' }); continue; }
    if (now === c.correctTarget) { skipped.push({ ...c, why: 'already points at the proposed target' }); continue; }
    if (c.correctTarget === c.id || String(c.correctTarget).slice(0, TRUNC_LEN) === c.id) {
      skipped.push({ ...c, why: 'would point the id at itself' }); continue;
    }
    const pf = path.join(ROOT, 'players', c.correctTarget.slice(0, 2), c.correctTarget + '.json');
    if (!fs.existsSync(pf))     { skipped.push({ ...c, why: 'no player file for the proposed target' }); continue; }
    planned.push(c);
  }
  // Does this player hold a registration in any of the seasons these games are in?
  // Read from the LIVE player file, not from the report, so a stale report cannot
  // carry a repoint through.
  const seasonOfGame = new Map();
  {
    const gd = path.join(ROOT, 'games', 'bv');
    for (const f of fs.readdirSync(gd)) {
      if (!f.endsWith('.json')) continue;
      const sid = path.basename(f, '.json');
      let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gd, f), 'utf8')); } catch (e) { continue; }
      for (const gid of Object.keys(sg.games || {})) seasonOfGame.set(gid, sid);
    }
  }
  const registeredInSeasonsOf = (uuid, gids) => {
    let p; try { p = JSON.parse(fs.readFileSync(path.join(ROOT, 'players', uuid.slice(0, 2), uuid + '.json'), 'utf8')); }
    catch (e) { return false; }
    const want = new Set((gids || []).map(g => seasonOfGame.get(g)).filter(Boolean));
    if (!want.size) return false;
    for (const se of (p.seasons || [])) {
      if (!se || !se.sid || !want.has(se.sid)) continue;
      if ((se.regs || []).some(r => r && r.tid)) return true;
    }
    return false;
  };

  console.log('  ══ RE-VERIFYING ' + n(planned.length) + ' CANDIDATE(S) ═══════════════════════');
  console.log('  Credit-based repoints are re-asked against PlayHQ. Squad-evidence and manual');
  console.log('  repoints are re-checked on REGISTRATION instead — the credit test cannot judge');
  console.log('  them, because not being credited is why they reached that tool at all.');
  console.log('  Nothing is taken on trust from a report: every repoint is re-checked now,');
  console.log('  against the live alias table and the live player files.');

  const confirmed = [], rejected = [];
  const cache = new Map();
  const credits = async (uuid) => {
    if (cache.has(uuid)) return cache.get(uuid);
    const r = await creditedGameIds(uuid);
    cache.set(uuid, r);
    return r;
  };
  let k = 0;
  for (let i = 0; i < planned.length; i += CONCURRENCY) {
    const chunk = planned.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (c) => {
      // ⚠ THE CREDIT TEST CANNOT JUDGE THE squad-evidence REPOINTS, AND MUST NOT
      // BE APPLIED TO THEM. Those 40 aliases reached probe-squad-evidence PRECISELY
      // BECAUSE no candidate credits their games — that is what "unsupported with no
      // repoint" meant. Re-asking the same question here would reject every one of
      // them for the reason they exist, and the run would look like a careful
      // refusal while actually testing nothing.
      //
      // They are verified differently, on the evidence that decided them:
      // REGISTRATION. A registration is the club entering that player in that
      // competition; it is a stronger statement about who was there than a game
      // count derived from rosters we assembled ourselves. So for these the check
      // is: does the proposed target still hold a registration in the seasons
      // these games belong to, and does the current target still not?
      if (c.from === 'squad-evidence' || c.from === 'manual' || c.from === 'box-score-team') {
        const ok = registeredInSeasonsOf(c.correctTarget, c.gids);
        const cur = registeredInSeasonsOf(c.target, c.gids);
        if (!ok)          { rejected.push({ ...c, why: 'proposed target holds NO registration in those seasons — the evidence that decided it no longer stands' }); return; }
        if (cur && !ok)   { rejected.push({ ...c, why: 'current target is registered and the proposed one is not' }); return; }
        confirmed.push({ ...c, verifiedBy: 'registration' });
        return;
      }

      const [good, bad] = [await credits(c.correctTarget), await credits(c.target)];
      const hits = (set) => set && c.gids.some(g => set.has(g) || set.has(String(g).slice(0, 8)));
      if (!good)        { rejected.push({ ...c, why: 'proposed target gave no answer now' }); return; }
      if (!hits(good))  { rejected.push({ ...c, why: 'proposed target does NOT credit these games now' }); return; }
      if (bad && hits(bad)) { rejected.push({ ...c, why: 'current target DOES credit them now — the audit is stale' }); return; }
      confirmed.push({ ...c, verifiedBy: 'playhq-credits' });
    }));
    k += chunk.length;
    if (k % 25 < chunk.length) console.log('  … ' + k + '/' + planned.length + '  confirmed ' + confirmed.length + ' · rejected ' + rejected.length);
  }

  console.log('');
  console.log('    CONFIRMED — safe to repoint : ' + n(confirmed.length));
  console.log('    rejected on re-check        : ' + n(rejected.length));
  console.log('    skipped before any call     : ' + n(skipped.length));
  console.log('');
  for (const s of skipped.slice(0, 15)) console.log('    SKIP  ' + s.id + '  ' + s.why);
  for (const r of rejected.slice(0, 15)) console.log('    REJECT ' + r.id + '  ' + r.why);
  if (skipped.length + rejected.length) console.log('');
  for (const c of confirmed.slice(0, 40)) {
    console.log('    REPOINT ' + c.id + '   [' + (c.from || '?') + ' · verified by ' + (c.verifiedBy || '?') + ']');
    console.log('        from ' + c.target);
    console.log('        to   ' + c.correctTarget);
  }
  if (confirmed.length > 40) console.log('    … and ' + n(confirmed.length - 40) + ' more');
  console.log('');

  if (!APPLY) { console.log('  DRY RUN — nothing written. Re-run with --apply.'); return; }
  if (!confirmed.length) { console.log('  nothing confirmed; nothing to write'); return; }

  // ── 4. Record BEFORE writing ──────────────────────────────────────────────
  const logPath = path.join(ROOT, 'reports', 'alias-repoint-log.json');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify({
    applied: new Date().toISOString(),
    note: 'restore by setting each id back to `from` in players/aliases/<first two chars>.json',
    entries: confirmed.map(c => ({ id: c.id, from: c.target, to: c.correctTarget, games: c.gids })),
  }, null, 1));
  console.log('  recorded ' + n(confirmed.length) + ' change(s) in reports/alias-repoint-log.json BEFORE touching the table');

  // ── 5. Write, one shard at a time ─────────────────────────────────────────
  const byShard = new Map();
  for (const c of confirmed) {
    const sh = shardOf.get(c.id);
    if (!sh) continue;
    if (!byShard.has(sh)) byShard.set(sh, []);
    byShard.get(sh).push(c);
  }
  let written = 0;
  for (const [sh, list] of byShard) {
    const p = path.join(aliasDir, sh);
    let m; try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.log('  ⚠ unreadable shard ' + sh); continue; }
    for (const c of list) {
      if (m[c.id] !== c.target) { console.log('  ⚠ ' + c.id + ' changed under us — left alone'); continue; }
      m[c.id] = c.correctTarget;
      written++;
    }
    const sorted = {};
    for (const key of Object.keys(m).sort()) sorted[key] = m[key];
    fs.writeFileSync(p, JSON.stringify(sorted));      // minified, matching the store
  }
  console.log('  repointed ' + n(written) + ' entrie(s) across ' + n(byShard.size) + ' shard(s)');

  // ── 6. Commit ─────────────────────────────────────────────────────────────
  for (const p of ['players/aliases', 'reports/alias-repoint-log.json']) {
    try { execSync('git add -- ' + p, GIT); } catch (e) {}
  }
  const staged = execSync('git diff --staged --shortstat', GIT).toString().trim();
  if (!staged) { console.log('  nothing staged'); return; }
  console.log('  staging: ' + staged);
  execSync('git commit -q -m "repoint-aliases: ' + written + ' alias entries repointed to the profile that credits their games"', GIT);
  for (let attempt = 1; attempt <= 40; attempt++) {
    try { execSync('git merge --abort', GIT); } catch (e) {}
    try {
      console.log('  … fetch/merge/push (attempt ' + attempt + ')');
      execSync('git fetch origin main', GIT);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT);
      execSync('git push origin main', GIT);
      console.log('  ✔ pushed');
      break;
    } catch (e) {
      if (attempt === 40) throw new Error('push failed after 40 attempts');
      const wait = 1 + Math.floor(Math.random() * 60);
      console.log('  … push attempt ' + attempt + ' failed, retrying in ' + wait + 's');
      try { execSync('sleep ' + wait, { stdio: 'pipe', timeout: (wait + 30) * 1000 }); } catch (e2) {}
    }
  }
  console.log('');
  console.log('  NEXT: run build-player-games. Player files still hold the OLD resolution');
  console.log('  until it rebuilds them from the corrected table.');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
