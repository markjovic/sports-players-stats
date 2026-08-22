// scripts/fix-merge-aliases.js
//
// WRITES when --apply. Takes the data-write lock. Dry-run by default.
//
// WHAT THIS IS FOR. merge-phantom-profiles wrote alias entries on 2026-08-22 to
// point 2,482 phantom players' ids at their real profile, and it did NOT record
// which entries it created. probe-my-aliases could therefore only guess at the
// population — it saw 4,342 candidates against the 3,024 the merge reported, and
// measured a 13.6% foreign rate against a 4.2% repo baseline without being able to
// say which entries that rate belonged to.
//
// This removes the guessing. THE ALIAS TABLE BEFORE THE MERGE IS IN GIT HISTORY,
// so the exact set of added entries is recoverable by diff. No estimation, no
// self-mapping confusion, no attribution argument.
//
// HOW IT FINDS THE BASELINE. It walks git log for the merge commit by its own
// message and takes its FIRST PARENT — the tree as it stood immediately before.
// If several merge commits exist (it was run more than once), the EARLIEST is used
// so the baseline predates all of them.
//
// WHAT IT TESTS. For each added entry, every appearance it delivers is checked
// against the keeper's own registrations, and each is one of:
//   IN-ROSTER    the keeper is registered to a side of that game — correct
//   UNMEASURABLE we hold no registration for that season — says nothing either way
//                (a season with `regs: []` is NOT a registration; build-player-games
//                back-fills those for every season a player has games in)
//   FOREIGN      we hold their registrations for that season and neither team
//                matched — the population that might be wrong
//
// AN ENTRY IS REMOVED only when EVERY appearance it delivers is FOREIGN and it
// delivers at least --min-foreign of them. A mixed entry is left alone: an alias
// delivering real appearances plus some fill-ins is doing its job, and fill-ins are
// real games that PlayHQ itself marks "Fill-in".
//
// REMOVAL IS REVERSIBLE. The removed entries are written to
// reports/removed-merge-aliases.json before anything is deleted, so the exact map
// can be restored by hand. Nothing in players/ or games/ is touched — only
// players/aliases — and build-player-games re-derives every player file from the
// alias table on its next run.
//
// Usage:
//   node scripts/fix-merge-aliases.js                       # dry run
//   node scripts/fix-merge-aliases.js --apply
//   node scripts/fix-merge-aliases.js --apply --min-foreign=5

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
// Dependencies of the spectator stack copied below — caught by the T31 check
// (when copying a block from another script, diff its dependencies).
const crypto = require('crypto');
const https  = require('https');
const API_URL = 'https://api.playhq.com/graphql';

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const numArg = (f, d) => {
  const a = args.find(x => x.startsWith('--' + f + '='));
  const v = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : d;
};
// An entry delivering ONE foreign appearance and nothing else is far more likely a
// fill-in than a bad mapping. Require a few before removing.
const MIN_FOREIGN = numArg('min-foreign', 3);
const MERGE_MSG = 'merge-phantom-profiles';

const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';
const MAX_INSPECT = numArg('max-inspect', 0);      // 0 = put every candidate to PlayHQ
const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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


// Ask PlayHQ who this id actually is, from the box score of games the alias
// delivered. The box carries profileID AND name, so this is PlayHQ's own answer
// rather than an inference from counts.
//   'same'      -> one person; the appearance is a FILL-IN and the alias is right
//   'different' -> the id is somebody else; the alias is wrong
//   'unknown'   -> no box available; not evidence either way
async function whoIsThisId(aliasId, keeperName, gids) {
  const want = norm(keeperName);
  const seen = [];
  for (const gid of gids.slice(0, 3)) {
    const r = await gqlSpectator(gid);
    await sleep(1200);
    if (!r.ok) continue;
    for (const side of [r.game?.statistics?.home?.players || [], r.game?.statistics?.away?.players || []]) {
      for (const p of side) {
        const pid = String(p.profileID || '');
        if (!pid || pid.slice(0, 13) !== aliasId) continue;
        const nm = String(p.name || '').trim();
        seen.push({ gid, name: nm });
        if (nm && want && norm(nm) === want) return { verdict: 'same', seen };
        if (nm && want) return { verdict: 'different', seen };
      }
    }
  }
  return { verdict: 'unknown', seen };
}

// execSync is SYNCHRONOUS and blocks the event loop; every call needs a timeout
// or a stalled git hangs the job with no output (T35).
const GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const git = (cmd) => execSync(cmd, GIT).toString();

async function main() {
  // ── 1. Find the commit immediately before the merge ────────────────────────
  let baseline = null;
  try {
    // The format string goes through a SHELL, so `|` would be read as a pipe —
    // `git log --format=%H|%s` ran %s as a command. Use a separator with no shell
    // meaning, and quote the whole argument.
    const log = git(`git log --format='%H %s' --grep="${MERGE_MSG}" -n 50`).trim();
    const lines = log ? log.split('\n').filter(Boolean) : [];
    if (!lines.length) {
      console.error('ABORT: no commit found whose message contains "' + MERGE_MSG + '".');
      console.error('  Nothing to diff against, so the added entries cannot be identified.');
      process.exit(1);
    }
    // git log is newest-first; the LAST line is the earliest merge commit.
    const earliest = lines[lines.length - 1].split(' ')[0];
    baseline = git(`git rev-parse ${earliest}^`).trim();
    console.log('  merge commits found      : ' + lines.length);
    console.log('  earliest merge commit    : ' + earliest.slice(0, 12) + '  ' + lines[lines.length - 1].slice(41));
    console.log('  baseline (its parent)    : ' + baseline.slice(0, 12));
  } catch (e) {
    console.error('ABORT: could not resolve the baseline commit — ' + e.message);
    process.exit(1);
  }

  // ── 2. The alias table as it was, and as it is ─────────────────────────────
  const before = new Map();
  let beforeShards = 0;
  try {
    const listed = git(`git ls-tree -r --name-only ${baseline} players/aliases`).trim();
    for (const f of (listed ? listed.split('\n') : [])) {
      if (!f.endsWith('.json')) continue;
      beforeShards++;
      let m; try { m = JSON.parse(git(`git show ${baseline}:${f}`)); } catch (e) { continue; }
      for (const [k, v] of Object.entries(m)) before.set(k, v);
    }
  } catch (e) {
    console.error('ABORT: could not read players/aliases at the baseline — ' + e.message);
    process.exit(1);
  }

  const aliasDir = path.join(ROOT, 'players', 'aliases');
  const now = new Map();
  const shardOf = new Map();
  for (const f of fs.readdirSync(aliasDir)) {
    if (!f.endsWith('.json')) continue;
    let m; try { m = JSON.parse(fs.readFileSync(path.join(aliasDir, f), 'utf8')); } catch (e) { continue; }
    for (const [k, v] of Object.entries(m)) { now.set(k, v); shardOf.set(k, f); }
  }

  // ADDED = present now, absent then. CHANGED = present in both, different target.
  const added = new Map(), changed = new Map();
  for (const [k, v] of now) {
    if (!before.has(k)) added.set(k, v);
    else if (before.get(k) !== v) changed.set(k, { from: before.get(k), to: v });
  }
  console.log('  alias entries BEFORE     : ' + n(before.size) + '  (' + beforeShards + ' shards)');
  console.log('  alias entries NOW        : ' + n(now.size));
  console.log('  ADDED since the baseline : ' + n(added.size) + '   ← exactly what the merge wrote');
  console.log('  RETARGETED since         : ' + n(changed.size) + (changed.size ? '   ⚠ an existing entry was pointed elsewhere' : ''));
  console.log('  mode                     : ' + (APPLY ? 'APPLY — removes entries and commits' : 'DRY RUN — nothing written'));
  console.log('');
  if (!added.size && !changed.size) { console.log('  nothing was added; nothing to check'); return; }

  // ── 3. Registrations for every target of an added entry ────────────────────
  const targets = new Set([...added.values(), ...[...changed.values()].map(x => x.to)]);
  const regOf = new Map();
  for (const t of targets) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'players', t.slice(0, 2), t + '.json'), 'utf8'));
      const tids = new Set(), sids = new Set();
      for (const se of (p.seasons || [])) {
        const regs = Array.isArray(se?.regs) ? se.regs : [];
        for (const r of regs) if (r?.tid) tids.add(r.tid);
        // A season with regs:[] is NOT a registration — build-player-games
        // back-fills one for every season a player has games in, so treating it as
        // measurable makes every such appearance look foreign.
        if (se?.sid && regs.some(r => r && r.tid)) sids.add(se.sid);
      }
      regOf.set(t, { tids, sids, name: p.name || '?' });
    } catch (e) { /* target file missing — reported below */ }
  }

  // ── 4. Walk games once and judge every appearance each added entry delivers ─
  const check = new Map();
  for (const k of added.keys()) check.set(k, { target: added.get(k), inRoster: 0, foreign: 0, unmeasurable: 0, samples: [] });
  for (const [k, v] of changed) check.set(k, { target: v.to, retargeted: v.from, inRoster: 0, foreign: 0, unmeasurable: 0, samples: [] });

  const gamesDir = path.join(ROOT, 'games', 'bv');
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = path.basename(f, '.json');
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const [gid, g] of Object.entries(sg.games || {})) {
      for (const e of (Array.isArray(g.p) ? g.p : [])) {
        const id = e && e.id;
        if (!id) continue;
        const c = check.get(id);
        if (!c) continue;
        const reg = regOf.get(c.target);
        if (!reg) { c.unmeasurable++; continue; }
        if ((g.h && reg.tids.has(g.h)) || (g.a && reg.tids.has(g.a))) c.inRoster++;
        else if (!reg.sids.has(sid)) c.unmeasurable++;
        else { c.foreign++; if (c.samples.length < 3) c.samples.push({ gid, sid }); }
      }
    }
  }

  // ── 5. Decide ──────────────────────────────────────────────────────────────
  let allIn = 0, mixed = 0, allForeign = 0, silent = 0, noTarget = 0;
  let apIn = 0, apForeign = 0, apUnmeasurable = 0;
  const candidates = [];   // become removals ONLY if PlayHQ names a different person
  const remove = [];
  for (const [id, c] of check) {
    apIn += c.inRoster; apForeign += c.foreign; apUnmeasurable += c.unmeasurable;
    if (!regOf.has(c.target)) { noTarget++; continue; }
    const seen = c.inRoster + c.foreign + c.unmeasurable;
    if (!seen) { silent++; continue; }
    if (c.foreign === 0) { allIn++; continue; }
    if (c.inRoster === 0 && c.unmeasurable === 0 && c.foreign >= MIN_FOREIGN) { allForeign++; candidates.push({ id, ...c }); }
    else mixed++;
  }

  console.log('  ══ EVERY ENTRY THE MERGE ADDED, JUDGED ════════════════════════════');
  console.log('    delivers nothing at all                 : ' + n(silent) + '   ← harmless');
  console.log('    every appearance is one they belong in  : ' + n(allIn) + '   ← correct');
  console.log('    mixed: some belong, some do not         : ' + n(mixed) + '   ← LEFT ALONE (fill-ins are real)');
  console.log('    EVERY appearance foreign, >=' + MIN_FOREIGN + ' of them  : ' + n(allForeign) + '   ← CANDIDATES, now put to PlayHQ');
  if (noTarget) console.log('    target player file missing              : ' + n(noTarget));
  console.log('');
  console.log('    appearances delivered : ' + n(apIn + apForeign + apUnmeasurable));
  console.log('      belongs             : ' + n(apIn) + '  (' + pct(apIn, apIn + apForeign + apUnmeasurable) + '%)');
  console.log('      foreign             : ' + n(apForeign) + '  (' + pct(apForeign, apIn + apForeign + apUnmeasurable) + '%)   repo baseline is 4.2%');
  console.log('      unmeasurable        : ' + n(apUnmeasurable));
  console.log('');
  const pool = MAX_INSPECT ? candidates.slice(0, MAX_INSPECT) : candidates;
  console.log('  ══ INSPECTING ' + n(pool.length) + ' CANDIDATE(S) AGAINST PLAYHQ ═══════════════════');
  console.log('  Comparing the NAME on the box-score roster entry against the keeper\'s name.');
  console.log('  Only a DIFFERENT name is removed. A matching name is a fill-in and is KEPT.');
  let vSame = 0, vDiff = 0, vUnknown = 0, inspected = 0;
  for (const c of pool) {
    const t = regOf.get(c.target);
    const res = await whoIsThisId(c.id, t ? t.name : '', c.samples.map(x => x.gid));
    c.verdict = res.verdict; c.seenNames = res.seen;
    if (res.verdict === 'same') vSame++;
    else if (res.verdict === 'different') { vDiff++; remove.push(c); }
    else vUnknown++;
    if (++inspected % 25 === 0) console.log('  … ' + inspected + '/' + pool.length + '  same ' + vSame + ' · different ' + vDiff + ' · no answer ' + vUnknown);
  }
  console.log('');
  console.log('    PlayHQ says SAME person (fill-in)   : ' + n(vSame) + '   ← KEPT, the alias is correct');
  console.log('    PlayHQ says DIFFERENT person        : ' + n(vDiff) + '   ← REMOVE, the alias is wrong');
  console.log('    no answer (paper-scored / throttled): ' + n(vUnknown) + '   ← KEPT, an unanswered question is not evidence');
  if (MAX_INSPECT && candidates.length > pool.length) console.log('    NOT inspected (--max-inspect)       : ' + n(candidates.length - pool.length) + '   ← kept');
  console.log('');
  console.log('    appearances recovered by removing the entries above: ' + n(remove.reduce((a, b) => a + b.foreign, 0)));
  console.log('');
  for (const r of remove.slice(0, 30)) {
    const t = regOf.get(r.target);
    console.log('    REMOVE ' + r.id + ' -> ' + r.target + '  keeper is ' + JSON.stringify(t ? t.name : '?'));
    for (const sn of (r.seenNames || [])) console.log('        PlayHQ calls this id ' + JSON.stringify(sn.name) + ' in game ' + sn.gid);
  }
  if (remove.length > 30) console.log('    … and ' + (remove.length - 30) + ' more');
  console.log('');

  if (!APPLY) { console.log('  DRY RUN — nothing written. Re-run with --apply.'); return; }
  if (!remove.length) { console.log('  Nothing to remove.'); return; }

  // ── 6. Record BEFORE deleting, so every removal is reversible ──────────────
  const outPath = path.join(ROOT, 'reports', 'removed-merge-aliases.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    removed: new Date().toISOString(),
    baseline,
    minForeign: MIN_FOREIGN,
    entries: remove.map(r => ({ id: r.id, target: r.target, foreign: r.foreign,
                               verdict: r.verdict, playhqNames: r.seenNames, samples: r.samples })),
  }, null, 1));
  console.log('  recorded ' + n(remove.length) + ' removals in reports/removed-merge-aliases.json (restore by hand from this)');

  const byShard = new Map();
  for (const r of remove) {
    const sh = shardOf.get(r.id);
    if (!sh) continue;
    if (!byShard.has(sh)) byShard.set(sh, []);
    byShard.get(sh).push(r.id);
  }
  for (const [sh, ids] of byShard) {
    const p = path.join(aliasDir, sh);
    let m; try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
    for (const id of ids) delete m[id];
    const sorted = {};
    for (const k of Object.keys(m).sort()) sorted[k] = m[k];
    fs.writeFileSync(p, JSON.stringify(sorted));
  }
  console.log('  removed from ' + n(byShard.size) + ' alias shard(s)');

  // Per-path staging; never `git add -A` on a 6 GB repo.
  for (const p of ['players/aliases', 'reports/removed-merge-aliases.json']) {
    try { execSync(`git add -- ${p}`, GIT); } catch (e) { /* absent is fine */ }
  }
  const staged = git('git diff --staged --shortstat').trim();
  if (!staged) { console.log('  nothing staged'); return; }
  console.log('  staging: ' + staged);
  execSync(`git commit -q -m "fix-merge-aliases: removed ${remove.length} alias entries delivering only foreign appearances"`, GIT);
  for (let attempt = 1; attempt <= 40; attempt++) {
    try { execSync('git merge --abort', GIT); } catch (e) {}
    try {
      process.stdout.write('  … fetch/merge/push (attempt ' + attempt + ')\n');
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
  console.log('  NEXT: run build-player-games. The alias table is corrected but every player');
  console.log('  file still reflects the old resolution until it is rebuilt.');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
