// scripts/spectator-backfill.js
//
// Runs the nightly crawl's spectator step over the games it has never reached.
//
// WHY THIS EXISTS (2026-08-06): probe-missing-games proved that 100 of 100 sampled
// "missing appearance" cases are games we already hold whose player list is incomplete,
// and every single one has spc unset — the spectator step has never run on them. The
// nightly skips locked seasons by design and tournament comps fall outside its round
// window, so those games' player lists came from earlier population steps and were
// never completed. The fix is not a new mechanism: it is the EXISTING spectator step,
// pointed at the games it missed.
//
// Everything that talks to PlayHQ, touches git, or writes player/game files below is
// COPIED VERBATIM from scripts/nightly-crawl.js — the live script making the same
// class of call (house rule). The build step asserts byte-identity.
//
// DELIBERATE differences from the nightly, each with a reason:
//   - The queue comes from a LOCAL scan of games/bv, INCLUDING locked seasons,
//     instead of Phase 1/2 discover calls. This run makes ZERO main-api calls
//     beyond the session cookie.
//   - statsChecked is NOT cleared and reg discovery is SKIPPED. Player career and
//     per-reg stats come from profiles (fetch-profile-stats.js), and profiles have
//     ALWAYS counted these games — that data is already correct. Clearing would only
//     queue a pointless six-figure matrix sweep.
//   - NEW players found in fetched rosters still get stubs + alias identities
//     (Phase 4 logic verbatim), so every p[] id resolves.
//   - Progress IS the data: spc:1 is written per game and committed every
//     COMMIT_EVERY_GAMES games. Resume by re-dispatching — the scan skips spc-set
//     games. No progress file (trap T22).
//   - The game-file cache is EVICTED after each periodic flush. The nightly touches
//     a few hundred active seasons; this can touch 2,000+, and caching them all
//     would exhaust runner memory. The queue is sorted by season so eviction is
//     nearly free.
//
// The spectator endpoint leaves misses UNMARKED (faithful to the nightly: spc is set
// only on a response). Games the endpoint has no data for are re-tried on the next
// dispatch — the queue only ever shrinks by real answers.
//
// Usage:
//   node scripts/spectator-backfill.js --dry-run          # scan + report the queue, nothing else
//   node scripts/spectator-backfill.js                    # fetch up to --max-games (default 100000)
//   node scripts/spectator-backfill.js --season=<sid>     # one season only
//   node scripts/spectator-backfill.js --min-age-days=30   # (DEFAULT) skip games younger than 30
//                                                          # days — the fresh tail self-drains later;
//                                                          # =0 disables the guard entirely
//   node scripts/spectator-backfill.js --locked-only       # optional extra restriction to locked seasons
//   node scripts/spectator-backfill.js --include-partial   # ALSO re-fetch partial-roster games
//   node scripts/spectator-backfill.js --retry-covered=95  # one-off: re-admit retired misses in
//                                                          # seasons >=95% captured (transport
//                                                          # failures, not empty boxes)
//                                                          # (the 2026-08-07 completion re-sweep)

'use strict';

function isFinal(rn) {
  if (!rn) return false;
  return rn.toLowerCase().includes('final');
}
function isGrandFinal(rn) {
  if (!rn) return false;
  const r = rn.toLowerCase();
  return r.includes('grand final') || r === 'gf';
}


const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execFileSync } = require('child_process');
const { truncateUuid, resolveToFullUuid, TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const DRY_RUN       = !!ARGS['dry-run'];
// COMMA-SEPARATED (2026-08-19). One season per dispatch meant seven checkouts of
// a 6 GB repo — roughly 50 minutes of clone before any work — to sweep the seven
// seasons the grading-grade fault had left empty. A list costs one.
// Single-value `--season=<sid>` still works: it is a list of one.
const TARGET_SEASONS = String(ARGS.season || '')
  .split(',').map(x => x.trim()).filter(Boolean);
const TARGET_SEASON_SET = TARGET_SEASONS.length ? new Set(TARGET_SEASONS) : null;
const MAX_GAMES     = ARGS['max-games'] ? Math.max(1, parseInt(ARGS['max-games'], 10)) : 100000;
// 2026-08-07 (--include-partial): widens the queue to games that ALREADY carry a
// partial roster. This deliberately reverses the 2026-08-06 correction below FOR
// OPTED-IN RUNS ONLY, because its premise fell: 7da945a8 proved (stored p[] a
// strict 12-of-19 subset of the spectator box, verified) that partial lists are
// INCOMPLETE captures of boxes that completed after the round settled — the
// measured source of 757k missing appearances across 102,609 players. Default
// remains the 08-06 behaviour.
const INCLUDE_PARTIAL = !!ARGS['include-partial'];
// 2026-08-07 (--locked-only): restrict the sweep to LOCKED seasons. Active-season
// boxes can still be completing after FINAL (7da945a8 lagged months), and spc:1
// makes a game permanently invisible to every re-query path — sweeping an active
// season can freeze a fresh partial forever. Locked boxes are as complete as they
// will ever get: sweep them first; a final unrestricted pass catches the rest
// once those seasons settle.
const LOCKED_ONLY = !!ARGS['locked-only'];
// 2026-08-07 (--heal-dangling): collect the debt of the CANCELLED 700k run
// (run 3, timed out at ~306k games): its games committed p[] progressively but
// its player phase never ran, leaving truncated p[] ids with NO player behind
// them — and spc hides those games from every normal queue. This mode inverts
// the eligibility test: FINAL games WITH spc whose p[] contains an id that
// resolveToFullUuid cannot resolve (null = unknown to index AND aliases). The
// spectator re-fetch restores the full profileIDs and names, and the (now
// incremental) player phase stubs them. Self-limiting: once stubbed, the ids
// resolve and the game drops out of this queue.
const HEAL_DANGLING = !!ARGS['heal-dangling'];
// Misses are retried on later runs up to this many attempts, then retired from
// the queue (see the miss-marker note in the fetch loop). DEFAULT 1 — measured
// on 2026-08-07: 77,397 re-asks of prior misses converted 2 hits (0.003%);
// misses are dead eras, not flaky responses, so second chances buy nothing.
// The retirement is reversible (spcm, never spc): --miss-attempts=0 disables
// the gate entirely and re-asks everything, and any higher N re-admits games
// below it, if a route to that data ever appears.
const MISS_ATTEMPT_LIMIT = ARGS['miss-attempts'] !== undefined ? Math.max(0, parseInt(ARGS['miss-attempts'], 10) || 0) : 1;
// 2026-08-10 (--retry-covered=N): put ALREADY-RETIRED misses back in the queue for
// seasons whose capture rate is at least N%. Nothing stored says WHY a given miss
// failed, so the only available signal is the one the spot-check used: a season
// that scored electronically all year should not lose scattered games, whereas a
// season at 0% coverage never had box scores at all. Measured 2026-08-10: 951
// seasons above 95% held 18,727 retired misses, and 3 of 4 sampled had full box
// scores live on playhq.com. Use WITH the classification fix in gqlSpectator — on
// its own this would simply re-retire them.
const RETRY_COVERED = ARGS['retry-covered'] !== undefined ? Math.max(1, parseInt(ARGS['retry-covered'], 10) || 95) : 0;
// 2026-08-07 (--min-age-days, superseding locked-only as the DEFAULT safety):
// the spc-freeze risk is a FRESHNESS property, not a lock property — only games
// whose boxes may still be completing are endangered, i.e. the last few weeks.
// Guarding by lock status deferred months of settled current-season data for up
// to a year; guarding by age fixes everything old NOW and defers only the fresh
// tail, which self-drains as games age past the threshold on later dispatches.
// Games with no date are treated as old (they long predate any completion window).
const MIN_AGE_DAYS = ARGS['min-age-days'] !== undefined ? Math.max(0, parseInt(ARGS['min-age-days'], 10) || 0) : 30;
const MIN_AGE_CUTOFF = MIN_AGE_DAYS > 0 ? new Date(Date.now() - MIN_AGE_DAYS * 86400000).toISOString().slice(0, 10) : null;

const API_URL       = 'https://api.playhq.com/graphql';
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

async function runPool(tasks, concurrency) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) { await tasks[i++](); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// ─── Git commit — nightly-crawl.js, verbatim (house pattern) ──────────────────

// commitLock prevents concurrent tasks from triggering simultaneous commits
let commitLock = false;

// dirs: explicit paths only — never -A. This repo is multi-GB with 370k+
// player files and 2,800+ game/team-stats files; -A walks the whole index
// and risks ENOBUFS (confirmed empirically 2026-07-10: a 355k-file operation
// blew Node's execSync 1MB stdout buffer via git's own default per-file
// output — the same class of thing -A risks here at similar or larger scale,
// since it has to diff the ENTIRE working tree, not just what this run touched).
// --shortstat (not --stat) and --no-stat on merge for the same reason — both
// print a per-file line/graph by default, --stat and a real merge diffstat
// scale with file count, --shortstat and --no-stat don't.
// 2026-08-09: execFileSync's DEFAULT maxBuffer is 1 MB, and exceeding it SIGTERMs
// the child MID-OPERATION. fold-diverged-players died exactly this way on a
// 25,593-file commit: `git merge` printed 1,051,036 bytes of per-file
// "Auto-merging …" lines (1 MB = 1,048,576), Node killed git, and an
// already-made commit was never pushed. Every git call here scales its output
// with the number of changed files, so all of them get the larger buffer; `-q`
// on the merge suppresses the per-file lines at the source.
const GIT_MAXBUF = 512 * 1024 * 1024;
// ── EVERY git CALL NEEDS A TIMEOUT ───────────────────────────────────────────
// 2026-08-20 audit, after build-player-games hung with no output. execSync and
// execFileSync are SYNCHRONOUS: they block the whole Node process, event loop
// included, so nothing can time them out from outside. `git fetch` and `git push`
// talk to the network against a 6 GB repo; without a timeout a stalled connection
// hangs the job until the workflow ceiling kills it, with NO output and NO retry.
// A timeout makes the call THROW, which the push-retry loop below already handles.
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

async function gitCommit(message, dirs) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  const paths = (dirs && dirs.length ? dirs : ['.']);

  // ── Per-path add (directive 9) ──────────────────────────────────────────────
  // `git add` is ATOMIC across pathspecs: one unmatched path in a combined add
  // stages NOTHING, exits 128, and the empty `catch (_) {}` this replaces then
  // hid it — leaving "nothing to commit" as the only visible symptom. That is
  // exactly how discover-fixtures.js discarded 30,426 fetched games on a GREEN
  // run (2026-07-19). Staged individually, a miss skips only itself and is
  // reported loudly.
  let addFailures = 0, hardAddFailures = 0;
  for (const p of paths) {
    try { execFileSync('git', ['add', '--', p], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS }); }
    catch (e) {
      addFailures++;
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      // "did not match any files" on a per-path add is benign — see the note below.
      if (!/did not match any files/i.test(detail)) hardAddFailures++;
      console.error(`  ⚠ git add ${/did not match any files/i.test(detail) ? 'skipped' : 'FAILED'} for "${p}": ${detail}`);
    }
  }

  const staged = (() => {
    try { return execFileSync('git', ['diff', '--staged', '--shortstat'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS }).toString().trim(); }
    catch (_) { return ''; }
  })();

  if (!staged) {
    // Previously a bare silent `return`. Nothing staged AFTER a staging failure is
    // the silent-loss signature, so it must not be reported as a clean no-op.
    //
    // But be PRECISE about which failure. With per-path adds, a pathspec that
    // "did not match any files" is provably harmless: it staged nothing AND, unlike
    // the old combined add, took nothing else down with it. That is the ordinary
    // case for an optional path — e.g. needs-matrix-shards.json, which this script
    // deletes when there are no affected shards, and which a forward-mode run
    // (--rounds-forward) legitimately never recreates. Throwing on that would fail
    // a run that did exactly what it should.
    // Any OTHER add error — permissions, a locked index, corruption — is NOT
    // harmless and still throws.
    if (hardAddFailures) {
      throw new Error(`gitCommit: nothing staged and ${hardAddFailures} path(s) failed to stage for a reason other than "did not match any files" — refusing to report this as a clean no-op ("${message}")`);
    }
    if (addFailures) {
      console.log(`  (no changes to commit: ${message}) — ${addFailures} optional path(s) absent, which is not an error here`);
      return;
    }
    console.log(`  (no changes to commit: ${message})`);
    return;
  }
  console.log(`  staging: ${staged}`);   // directive 9: prove what was staged

  // Identity passed inline on commit AND merge: a missing committer identity
  // otherwise surfaces only as a merge failure, and burns the whole retry budget
  // on a config problem no amount of retrying can fix.
  const IDENT = ['-c', 'user.name=github-actions[bot]',
                 '-c', 'user.email=github-actions[bot]@users.noreply.github.com'];

  // execFileSync with an argument array — the message is no longer interpolated
  // into a shell string, so the `"` -> `'` escaping hack is gone with it.
  try { execFileSync('git', [...IDENT, 'commit', '-q', '-m', message], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS }); }
  catch (e) {
    const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
    throw new Error(`gitCommit: commit failed for "${message}" — ${detail}`);
  }

  // ── Push with retry (house pattern, copied from fold-diverged-players.js) ────
  // 60 attempts, pure random 1-91s jitter, `merge --abort` before each attempt,
  // and THROW on total failure. The previous 10-attempt loop ended in
  // `console.error` + `return`, so a run could push NOTHING and still go green —
  // the same defect closed on build-team-stats.js on 2026-07-29, which REPO_MANIFEST
  // §6.9/§6.10 called "the remaining"/"the last" 10-attempt outlier. It was not:
  // this file had it too.
  // Only genuine contention is retried. A non-contention push failure (auth,
  // branch protection, size, hook rejection) is not fixed by waiting, so it fails
  // fast with git's real error rather than being buried under 60 identical lines.
  // NOTE: async sleep, not a blocking one — gitCommit is awaited from inside the
  // Phase 2 paced pool, and blocking here would stall sibling fetch workers.
  const MAX = 60;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try { execFileSync('git', ['merge', '--abort'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS }); } catch (_) { /* none in progress */ }

    try {
      execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS });
    } catch (e) {
      if (attempt === MAX) throw e;
      const s = 1 + Math.floor(Math.random() * 91);
      console.log(`  fetch failed (attempt ${attempt}/${MAX}), retrying in ${s}s`);
      await sleep(s * 1000);
      continue;
    }

    // A merge failure is a config or content problem, not a race — fatal.
    execFileSync('git', [...IDENT, 'merge', '-q', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS });

    try {
      execFileSync('git', ['push', 'origin', 'HEAD:main'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS });
      console.log(`  ✓ Committed: ${message} (pushed on attempt ${attempt})`);
      return;
    } catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
      const contention = /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(detail);
      if (!contention) {
        console.error(`  push failed — NOT contention, failing fast. git said:\n${detail}`);
        throw e;
      }
      if (attempt === MAX) {
        console.error(`  push still rejected after ${MAX} attempts. git said:\n${detail}`);
        throw e;
      }
      const s = 1 + Math.floor(Math.random() * 91);
      console.log(`  push attempt ${attempt}/${MAX} rejected (remote advanced), re-syncing in ${s}s`);
      await sleep(s * 1000);
    }
  }
  throw new Error(`gitCommit: exhausted ${MAX} push attempts for "${message}"`);
}

// Commit only if not already in progress — safe for concurrent callers
async function tryPeriodicCommit(message, dirs) {
  if (commitLock) return;
  commitLock = true;
  try {
    const n = flushGameFiles();
    if (n > 0) await gitCommit(message, dirs);
  } finally {
    commitLock = false;
  }
}

// ─── Game file cache — nightly-crawl.js, verbatim (incl. shrink guard) ────────

const gameCache = new Map();   // seasonId → { games: {} }
const gameDirty = new Set();   // seasonIds with pending writes

function loadGameFile(seasonId) {
  if (gameCache.has(seasonId)) return gameCache.get(seasonId);
  const file = path.join(GAMES_DIR, `${seasonId}.json`);
  let data = { games: {} };
  if (fs.existsSync(file)) {
    // If the file EXISTS but can't be read/parsed, do NOT fall back to an empty
    // object — upserting onto empty and flushing would overwrite the file with
    // only this run's games, destroying existing (often unrecoverable, e.g.
    // API-withheld junior) data on disk. Abort loudly instead.
    const raw = fs.readFileSync(file, 'utf8');   // throws on read error — intended
    try { data = JSON.parse(raw); }
    catch (e) { throw new Error(`Refusing to proceed: ${file} exists but failed to parse (${e.message}). Would risk overwriting existing games.`); }
  }
  if (!data.games) data.games = {};
  gameCache.set(seasonId, data);
  return data;
}

function markGameDirty(seasonId) { gameDirty.add(seasonId); }

function flushGameFiles() {
  let count = 0;
  for (const seasonId of [...gameDirty]) {
    if (!gameCache.has(seasonId)) continue;
    const file = path.join(GAMES_DIR, `${seasonId}.json`);
    const next = gameCache.get(seasonId);
    const nextN = Object.keys(next.games || {}).length;
    // Shrink guard: never write fewer games than already exist on disk. A stripped/
    // empty API response must never delete existing (possibly unrecoverable) games.
    if (fs.existsSync(file)) {
      let prevN = 0;
      try { prevN = Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')).games) || {}).length; } catch { prevN = Infinity; }
      if (nextN < prevN) {
        console.error(`  ⚠ SHRINK GUARD: ${seasonId} would drop from ${prevN} to ${nextN} games — refusing to write.`);
        gameDirty.delete(seasonId);
        continue;
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next));
    gameDirty.delete(seasonId);
    count++;
  }
  return count;
}

// ─── Player file helpers — nightly-crawl.js, verbatim ─────────────────────────

function playerShard(uuid)    { return uuid.slice(0, 2).toLowerCase(); }
function playerFilePath(uuid) { return path.join(PLAYERS_DIR, playerShard(uuid), `${uuid}.json`); }
function playerIndexPath(s)   { return path.join(INDEX_DIR, `${s}.json`); }

function readPlayer(uuid) {
  const file = playerFilePath(uuid);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writePlayer(uuid, data) {
  if (DRY_RUN) return;
  const file = playerFilePath(uuid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

function readPlayerIndex(shard) {
  const file = playerIndexPath(shard);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

function writePlayerIndex(shard, data) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(playerIndexPath(shard)), { recursive: true });
  fs.writeFileSync(playerIndexPath(shard), JSON.stringify(data));
}


// ─── Backfill queue (local scan — replaces Phase 1/2) ─────────────────────────
// QUEUE = games with NO player list at all. Nothing else. (Corrected 2026-08-06,
// Mark: the first version queued every spc-unset game — 2,050,204 — but ~2.03M of
// those carry partial lists written before the spc flag existed and are doing their
// job. Rewriting them wholesale to chase a ~2.7% appearance gap is exactly the
// churn-for-marginal-data trade this project rejects; per-game data that the normal
// path already serves is not re-fetched. spc's absence does NOT mean unprocessed on
// old games.) Empty-list games contribute nothing to any player's games[]/W-L/finals
// today, so fetching them is new data, not churn: the re-sweep's fixture-only locked
// games and the tournament comps. Remaining rules mirror the nightly's queueing
// sites (status FINAL, !spc, !forfeit, !legacy); a game with BOTH scores but no st
// (older writers) is also taken, reported separately. Hidden games carry t1/t2
// instead of h/a; both shapes are handled, as Phase 1b does.
function buildBackfillQueue(sportIndex) {
  const queue = [];
  const tallies = {
    files: 0, games: 0, spcSet: 0, forfeit: 0, otherTerminal: 0, notFinal: 0,
    queuedFinalSt: 0, queuedScoreNoSt: 0, queuedEmptyList: 0, partialListLeftAlone: 0, queuedPartialList: 0, tooRecent: 0, queuedDangling: 0, danglingIds: 0, retiredMisses: 0, retryCovered: 0, retryCoveredSeasons: 0,
    queuedLocked: 0, queuedActive: 0,
  };
  const perSeason = new Map();
  const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort();
  for (const fname of files) {
    const sid = fname.replace('.json', '');
    if (TARGET_SEASON_SET && !TARGET_SEASON_SET.has(sid)) continue;
    tallies.files++;
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); } catch { continue; }
    const locked = !!(sportIndex.seasons?.[sid]?.locked);
    if (LOCKED_ONLY && !locked) continue;
    // Per-season capture rate, computed from THIS file only (no extra pass), used
    // solely by --retry-covered to decide whether this season's retirements are
    // trustworthy.
    let seasonCovered = false;
    if (RETRY_COVERED > 0) {
      let capt = 0, missed = 0;
      for (const g2 of Object.values(gf.games || {})) {
        if (!g2 || g2.st !== 'FINAL' || g2.forfeit || g2.bye || g2.cancelled || g2.abandoned || g2.legacy) continue;
        if (g2.spc) capt++; else if (g2.spcm) missed++;
      }
      const tot = capt + missed;
      if (tot > 0 && (100 * capt / tot) >= RETRY_COVERED) { seasonCovered = true; tallies.retryCoveredSeasons++; }
    }
    for (const [gameId, g] of Object.entries(gf.games || {})) {
      if (!g) continue;
      tallies.games++;
      if (HEAL_DANGLING) {
        if (g.st !== 'FINAL' || !g.spc) continue;
        const pIds = Array.isArray(g.p) ? g.p : [];
        let dangling = false;
        for (const x of pIds) {
          if (x?.id && resolveToFullUuid(x.id, ROOT) === null) { dangling = true; tallies.danglingIds++; }
        }
        if (!dangling) continue;
        tallies.queuedDangling++;
        if (locked) tallies.queuedLocked++; else tallies.queuedActive++;
        perSeason.set(sid, (perSeason.get(sid) || 0) + 1);
        queue.push({
          gameId,
          seasonId:  sid,
          rn:        g.rn  || null,
          gradeId:   g.gid || null,
          gradeName: g.gn  || null,
          homeTid:   g.h  || g.t1 || null,
          awayTid:   g.a  || g.t2 || null,
          homeScore: g.hs ?? null,
          awayScore: g.as ?? null,
        });
        continue;
      }
      if (g.spc)                                { tallies.spcSet++;        continue; }
      if (g.forfeit)                            { tallies.forfeit++;       continue; }
      if (g.bye || g.cancelled || g.abandoned || g.legacy) { tallies.otherTerminal++; continue; }
      if (MISS_ATTEMPT_LIMIT > 0 && (g.spcm || 0) >= MISS_ATTEMPT_LIMIT) {
        // profileOnly games have no real spectator record and can never succeed —
        // never re-admit them, whatever their season's coverage looks like.
        if (seasonCovered && !g.profileOnly) { tallies.retryCovered++; }
        else { tallies.retiredMisses++; continue; }
      }
      // ISO dates compare lexicographically; absent d = old (pre-dates any window)
      if (MIN_AGE_CUTOFF && g.d && g.d > MIN_AGE_CUTOFF) { tallies.tooRecent++; continue; }
      const finalSt    = g.st === 'FINAL';
      const scoreNoSt  = g.st == null && g.hs != null && g.as != null;
      if (!finalSt && !scoreNoSt)               { tallies.notFinal++;      continue; }
      const nPlayers = ((g.p && g.p.length) || 0) + ((g.hp && g.hp.length) || 0) + ((g.ap && g.ap.length) || 0);
      if (nPlayers > 0 && !INCLUDE_PARTIAL) { tallies.partialListLeftAlone++; continue; }   // has a roster — NOT our business (default)
      if (nPlayers > 0) tallies.queuedPartialList++;
      if (finalSt) tallies.queuedFinalSt++; else tallies.queuedScoreNoSt++;
      if (nPlayers === 0) tallies.queuedEmptyList++;
      if (locked) tallies.queuedLocked++; else tallies.queuedActive++;
      perSeason.set(sid, (perSeason.get(sid) || 0) + 1);
      queue.push({
        gameId,
        seasonId:  sid,
        rn:        g.rn  || null,
        gradeId:   g.gid || null,
        gradeName: g.gn  || null,
        homeTid:   g.h  || g.t1 || null,
        awayTid:   g.a  || g.t2 || null,
        homeScore: g.hs ?? null,
        awayScore: g.as ?? null,
      });
    }
  }
  // Season-sorted so the cache eviction below keeps at most a season or two in memory.
  queue.sort((a, b) => a.seasonId === b.seasonId
    ? (a.gameId < b.gameId ? -1 : 1)
    : (a.seasonId < b.seasonId ? -1 : 1));
  return { queue, tallies, perSeason };
}

// The nightly caches a few hundred active seasons and never needs to let go; this
// tool can touch 2,000+, so after every flush the clean entries are dropped.
function evictCleanSeasons() {
  for (const sid of [...gameCache.keys()]) {
    if (!gameDirty.has(sid)) gameCache.delete(sid);
  }
}


// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('spectator-backfill.js');
  if (TARGET_SEASON_SET) {
    console.log(`  seasons:   ${TARGET_SEASONS.length} — ${TARGET_SEASONS.join(', ')}`);
    // Say which requested ids have no season file at all. A typo in a list of
    // seven is otherwise invisible: the run just sweeps six and reports success.
    const missing = TARGET_SEASONS.filter(x => !fs.existsSync(path.join(GAMES_DIR, `${x}.json`)));
    if (missing.length) console.log(`  ⚠ no games/bv file for: ${missing.join(', ')} — nothing will be swept for these`);
  }
  console.log(`  max-games: ${MAX_GAMES}`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — scan and report only: no API calls, no writes, no commits');
  console.log('─'.repeat(50));

  if (!fs.existsSync(INDEX_FILE)) { console.error('sports-index.json not found'); process.exit(1); }
  const sportIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));

  console.log('Scanning games/bv for never-spectator-processed games…');
  const { queue, tallies, perSeason } = buildBackfillQueue(sportIndex);
  const line = (l, v) => console.log(`  ${l.padEnd(48, '.')} ${v.toLocaleString()}`);
  line('Season files scanned', tallies.files);
  line('Games on file', tallies.games);
  line('  already spectator-processed (spc set)', tallies.spcSet);
  line('  forfeits / byes / cancelled / abandoned', tallies.forfeit + tallies.otherTerminal);
  line('  not FINAL and unscored (future etc.)', tallies.notFinal);
  line('  with a player list already (LEFT ALONE)', tallies.partialListLeftAlone);
  if (MIN_AGE_CUTOFF) line(`  deferred, younger than ${MIN_AGE_DAYS} days (box may still be completing)`, tallies.tooRecent);
  if (MISS_ATTEMPT_LIMIT > 0) line(`  retired misses (${MISS_ATTEMPT_LIMIT}+ failed attempts)`, tallies.retiredMisses);
  if (RETRY_COVERED > 0) {
    line(`  RE-ADMITTED retired misses (seasons >= ${RETRY_COVERED}% captured)`, tallies.retryCovered);
    line(`    ...across seasons`, tallies.retryCoveredSeasons);
  }
  if (HEAL_DANGLING) { line('  HEAL: spc games with dangling p[] ids', tallies.queuedDangling); line('  HEAL: dangling id occurrences', tallies.danglingIds); }
  if (INCLUDE_PARTIAL) line('  QUEUED with partial list (--include-partial)', tallies.queuedPartialList);
  line(INCLUDE_PARTIAL ? 'QUEUE — empty-list + partial-list' : 'QUEUE — no player list at all', queue.length);
  line('  with st=FINAL', tallies.queuedFinalSt);
  line('  scored but no st field (older writers)', tallies.queuedScoreNoSt);
  line('  in LOCKED seasons', tallies.queuedLocked);
  line('  in ACTIVE seasons', tallies.queuedActive);
  console.log('  Top seasons by queued games:');
  for (const [sid, n] of [...perSeason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const s = sportIndex.seasons?.[sid];
    console.log(`    ${sid}  ${String(n).padStart(6)}  locked=${!!s?.locked}  ${s?.name || ''} — ${s?.orgName || ''}`);
  }

  if (DRY_RUN) {
    console.log(`\nDry run complete in ${Math.round((Date.now() - t0) / 1000)}s — nothing fetched, nothing written.`);
    return;
  }

  const needsSpectator = queue.slice(0, MAX_GAMES);
  if (queue.length > needsSpectator.length) {
    console.log(`  Capped to ${needsSpectator.length} this run — re-dispatch to continue (spc-set games are skipped).`);
  }
  if (needsSpectator.length === 0) { console.log('\nQueue empty — nothing to do.'); return; }
  console.log();

  await refreshSession();

  // ── Spectator fetch — nightly-crawl.js Phase 3, verbatim ─────────────────────
  console.log(`Spectator box scores (${needsSpectator.length} games)…`);
  const playerDeltas = new Map();
  let totalStubbed = 0;
  // Incremental player phase (see the crash-consistency note below): no-op on an
  // empty window, otherwise resolve → detect-new → stub for THIS window's deltas.
  let playersSeenWindows = 0;   // summed per window; a player spanning windows counts once per window
  const applyPlayerPhase = async (deltas, sportIndex) => {
    if (deltas.size === 0) return;
    playersSeenWindows += deltas.size;
    await applyPlayerPhaseImpl(deltas, sportIndex);
  };
  let spectatorHits = 0, spectatorMiss = 0, p3Done = 0, transientFail = 0;
  const transientWhy = new Map();

  const p3Tasks = needsSpectator.map(({ gameId, seasonId, rn, gradeId, gradeName, homeTid, awayTid, homeScore, awayScore }) => async () => {
    const res = await gqlSpectator(gameId);
    p3Done++;
    if (p3Done % 50 === 0 || p3Done === needsSpectator.length)
      process.stdout.write(`  ${p3Done}/${needsSpectator.length}  hits: ${spectatorHits}  misses: ${spectatorMiss}  transient: ${transientFail}\r`);

    // TRANSPORT FAILURE — not a data fact. Leave the game exactly as it was: no
    // spc, no spcm increment, still queued for a later run. Counted in-memory
    // only (no per-game write) so a bad network minute leaves no trace in the
    // data at all.
    if (res && res.ok === false && res.permanent === false) {
      transientFail++;
      transientWhy.set(res.why, (transientWhy.get(res.why) || 0) + 1);
      return;
    }
    const game = res && res.ok ? res.game : null;

    if (!game?.statistics) {
      spectatorMiss++;
      // 2026-08-07 miss-marker: misses used to write NOTHING, so every future run
      // re-asked every accumulated miss at its head (the queue is season-sorted) —
      // by run 4 that head-tax was ~2h of re-queries per run and growing. spcm
      // counts attempts durably; at MISS_ATTEMPT_LIMIT the queue retires the game
      // (distinct from spc: retired-miss ≠ box-captured; a heal or a deliberate
      // reset can always revisit). Occasional late-appearing data still gets its
      // chances: the limit is per-game attempts, not a one-strike ban.
      if (!DRY_RUN) {
        const gfm = loadGameFile(seasonId);
        if (gfm.games[gameId]) {
          gfm.games[gameId].spcm = (gfm.games[gameId].spcm || 0) + 1;
          markGameDirty(seasonId);
        }
      }
      return;
    }
    spectatorHits++;

    const homePlayers = parseSpectatorPlayers(game.statistics?.home?.players);
    const awayPlayers = parseSpectatorPlayers(game.statistics?.away?.players);
    const allPlayers  = [...homePlayers, ...awayPlayers];

    // Collect player deltas for later batch processing
    const isFinalsGame = isFinal(rn);
    const isGF         = isGrandFinal(rn);
    const homeWon      = (homeScore !== null && awayScore !== null) ? homeScore > awayScore : null;

    for (const p of allPlayers) {
      if (!p.profileID) continue;
      if (!playerDeltas.has(p.profileID)) {
        playerDeltas.set(p.profileID, { name: p.name, deltas: [] });
      }
      const isHomePlayer = homePlayers.some(hp => hp.profileID === p.profileID);
      const playerTid    = isHomePlayer ? homeTid : awayTid;
      const playerWon    = homeWon === null ? null : (isHomePlayer ? homeWon : !homeWon);
      playerDeltas.get(p.profileID).deltas.push({
        seasonId, gameKey: gameId, pts: p.pts, pt3: p.pt3, fouls: p.fouls,
        isFinalsGame, isGF, playerTid, playerWon,
        gradeId, gradeName,
      });
    }

    // Mark spc:1 and update p[] on the game entry — spc prevents re-processing.
    // p[].id is truncated to a 13-char prefix (uuid-prefix.cjs TRUNC_LEN; the
    // original 2026-07-10 UUID-storage migration used 10, later widened to 13)
    // — this field is only ever an attendee list keyed by id, never resolved
    // back to a player file from within this script, so it's safe to write
    // truncated here. playerDeltas above (used for player-file writes) keeps
    // p.profileID FULL-length throughout — only the on-disk game file field
    // is shortened.
    const gf = loadGameFile(seasonId);
    if (gf.games[gameId] && !DRY_RUN) {
      // DEVIATION from the nightly's verbatim block (2026-08-07, --include-partial
      // era): p[] is replaced only when the fetched id SET differs from what is
      // stored — a widened sweep would otherwise rewrite ~2M entries whose only
      // change is element order, pure churn. spc:1 is ALWAYS set (that is the
      // progress record). All other entry fields are preserved untouched.
      if (allPlayers.length > 0) {
        const fresh = allPlayers.map(p => ({
          id: truncateUuid(p.profileID),
          // n omitted — name not needed in p[], profileID is the key
        }));
        const oldSet = new Set((gf.games[gameId].p || []).map(x => x.id));
        const newSet = new Set(fresh.map(x => x.id));
        const same = oldSet.size === newSet.size && [...newSet].every(x => oldSet.has(x));
        if (!same) gf.games[gameId].p = fresh;
      }
      gf.games[gameId].spc = 1;
      if (gf.games[gameId].spcm !== undefined) delete gf.games[gameId].spcm;
      markGameDirty(seasonId);
    }
  });

  // Periodic progress commits wrapped AROUND the verbatim task body: spc:1 written
  // per game is the progress record, so committing every COMMIT_EVERY_GAMES games
  // makes a timeout cost at most one window. Cache eviction rides the same cadence.
  let sinceCommit = 0;
  const wrappedTasks = p3Tasks.map(t => async () => {
    await t();
    sinceCommit++;
    if (sinceCommit >= COMMIT_EVERY_GAMES) {
      sinceCommit = 0;
      await applyPlayerPhase(playerDeltas, sportIndex);   // stubs THIS window's new players
      await tryPeriodicCommit(`spectator-backfill: progress ${p3Done}/${needsSpectator.length} (${spectatorHits} hits, ${totalStubbed} stubbed)`, ['games/', 'players/']);
      evictCleanSeasons();
    }
  });

  await runPool(wrappedTasks, CONCURRENCY_SPECTATOR);
  console.log(`  ${needsSpectator.length}/${needsSpectator.length} done`
            + `  hits: ${spectatorHits}  misses: ${spectatorMiss}`);

  const flushedSpc = flushGameFiles();
  if (flushedSpc > 0) {
    await gitCommit(`spectator-backfill: spc+p[] written for ${spectatorHits} games`, ['games/']);
  }
  console.log();

  // ── Player phase, INCREMENTAL (2026-08-07 crash-consistency fix) ─────────────
  // Run 3 (max-games=700000) hit the 350-min timeout at ~306k games: its game
  // writes were durable (committed per window) but this phase — previously a
  // single end-of-run pass — died with ~306k games' worth of deltas in memory,
  // stranding never-stubbed players behind spc. "A timeout costs at most one
  // window" was only true for HALF the writes. Now the same pipeline runs per
  // commit window (stubs are cheap: ~84 per 2,000 games in run 1), the window
  // commit carries games/ AND players/ together, and the delta map is cleared —
  // which also fixes the multi-million-entry memory profile of large runs.
  // The pipeline below is otherwise the nightly-crawl.js verbatim lineage.
  await applyPlayerPhase(playerDeltas, sportIndex);

  // ── api-canonical resolution — nightly-crawl.js, verbatim ────────────────────
  async function applyPlayerPhaseImpl(playerDeltas, sportIndex) {
  {
    const canonicalDeltas = new Map();
    let redirected = 0;
    for (const [origId, info] of playerDeltas) {
      const key = resolveToFullUuid(origId, ROOT); // full ids never resolve to null
      if (key !== origId) redirected++;
      const existing = canonicalDeltas.get(key);
      if (existing) existing.deltas.push(...info.deltas);
      else canonicalDeltas.set(key, info);
    }
    playerDeltas.clear();
    for (const [k, v] of canonicalDeltas) playerDeltas.set(k, v);
    if (redirected > 0) console.log(`  Alias-resolved ${redirected} spectator id(s) to canonical api ids`);
  }

  // ── New-player detection ──────────────────────────────────────────────────────
  // The nightly finds genuinely-new players inside its statsChecked-clearing loop.
  // That loop is deliberately SKIPPED here (see header), so the index check runs on
  // its own: any canonical id absent from its shard index gets a stub below.
  const genuinelyNew = new Map();
  {
    const shardIndexCache = new Map();
    for (const [uuid, info] of playerDeltas) {
      const shard = playerShard(uuid);
      if (!shardIndexCache.has(shard)) shardIndexCache.set(shard, readPlayerIndex(shard));
      if (!shardIndexCache.get(shard)[uuid]) {
        genuinelyNew.set(uuid, info.name || `Player #${uuid.slice(0, TRUNC_LEN)}`);
      }
    }
  }

  // ── VERIFY BEFORE MANUFACTURING A PERSON ─────────────────────────────────────
  // Every id here is one the alias table does not know. That is NOT the same as it
  // being an api-canonical profile, and treating the two as equivalent is what
  // produced 2,895 duplicate player files. Ask PlayHQ, once per id.
  //
  //   api      → a real profile. Stub it, exactly as before.
  //   not-api  → a SPECTATOR id. Never gets a file. Its appearances belong to some
  //              api profile we cannot name yet, so it is recorded for the alias
  //              work rather than silently dropped.
  //   unknown  → transport. DEFER: no file, no alias, no record of a decision. It
  //              returns as genuinely-new on the next run and is asked again. A
  //              throttle must never invent a player NOR discard one.
  const verified = new Map();          // uuid -> name, confirmed api profiles only
  const notApi = [];                   // spectator ids that must not become files
  let deferred = 0;
  if (genuinelyNew.size) {
    console.log(`Verifying ${genuinelyNew.size} new id(s) against the profile API…`);
    for (const [uuid, name] of genuinelyNew) {
      const verdict = await isApiProfile(uuid);
      if (verdict === 'api') verified.set(uuid, name);
      else if (verdict === 'not-api') notApi.push({ uuid, name });
      else deferred++;
      await sleep(250);                // one call per NEW player only — 115 in the 2026-08-20 sweep
    }
    console.log(`  confirmed api profiles : ${verified.size}`);
    console.log(`  NOT api profiles       : ${notApi.length}   ← spectator ids; no file written`);
    if (deferred) console.log(`  deferred (transport)   : ${deferred}   ← asked again next run`);
    for (const x of notApi.slice(0, 10)) console.log(`      not-api: ${x.uuid} ${JSON.stringify(x.name)}`);
    if (notApi.length > 10) console.log(`      … and ${notApi.length - 10} more`);
    // Recorded so the alias work has a worklist. A report, never a player file.
    if (notApi.length) {
      try {
        const p = path.join(ROOT, 'reports', 'unaliased-spectator-ids.json');
        let prev = {};
        try { prev = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
        for (const x of notApi) prev[x.uuid] = { name: x.name, seen: new Date().toISOString() };
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(prev, null, 1));
        console.log(`  recorded in reports/unaliased-spectator-ids.json (${Object.keys(prev).length} total)`);
      } catch (e) { console.log(`  ⚠ could not record unaliased ids: ${e.message}`); }
    }
  }
  genuinelyNew.clear();
  for (const [k, v] of verified) genuinelyNew.set(k, v);

  // ── New player stubs — nightly-crawl.js Phase 4, verbatim ────────────────────
  console.log(`New player stubs (${genuinelyNew.size})…`);
  const now       = new Date().toISOString();
  const newByShard = new Map();
  for (const [uuid, name] of genuinelyNew) {
    const shard = playerShard(uuid);
    if (!newByShard.has(shard)) newByShard.set(shard, []);
    newByShard.get(shard).push({ uuid, name });
  }

  let stubbed = 0;
  for (const [shard, entries] of newByShard) {
    const index        = readPlayerIndex(shard);
    let   indexChanged = false;

    for (const { uuid, name } of entries) {
      if (index[uuid]) continue;  // guard — another process may have added it

      // Compute initial stats from the deltas we already collected
      const deltas = playerDeltas.get(uuid)?.deltas || [];
      const bk     = { maxGamePTS: 0, maxGameThreePt: 0, foulOuts: {} };

      // Build seasons/regs from the SAME deltas, using the SAME construction
      // as the existing-player path above (Phase 3 cont., L945-986). Previously
      // new stubs got `seasons: []` — no tid/gid at all — which meant a
      // namespace-mismatch recovery attempt (fetch-profile-stats.js) had
      // nothing to give gradePlayerStatistics for a brand-new player. This
      // also means Phase 3-cont's "New player -> defer to Phase 4" path no
      // longer silently loses that first night's season/team/history data.
      const seasons = [];
      for (const d of deltas) {
        const { seasonId, pts, pt3, fouls, playerTid, gradeId, gradeName } = d;
        if (pts > bk.maxGamePTS)     bk.maxGamePTS     = pts;
        if (pt3 > bk.maxGameThreePt) bk.maxGameThreePt = pt3;
        if (fouls >= 5) bk.foulOuts[seasonId] = (bk.foulOuts[seasonId] || 0) + 1;

        if (!seasonId || !playerTid || !gradeId) continue;
        let season = seasons.find(s => s.sid === seasonId);
        if (!season) {
          const si = sportIndex.seasons?.[seasonId];
          season = { sid: seasonId, sn: si?.name || seasonId, club: si?.orgName || '', regs: [] };
          seasons.push(season);
        }
        if (!season.regs.some(r => r.tid === playerTid && r.gid === gradeId)) {
          season.regs.push({ tid: playerTid, tn: '', gid: gradeId, gn: gradeName || '', div: null, stats: {} });
        }
      }

      const stub = {
        uuid, name,
        sports:    { Basketball: bk },
        seasons,
        teams:     [],
        spectatorIds: [uuid.slice(0, TRUNC_LEN)],
        updatedAt: now,
      };
      writePlayer(uuid, stub);
      writeAliasIdentity(uuid);

      // History — same shape as the existing-player path (season -> unique tids).
      const history = {};
      for (const season of seasons) {
        history[season.sid] = [...new Set(season.regs.map(r => r.tid))];
      }
      index[uuid]    = { name, history };
      indexChanged   = true;
      stubbed++;
    }

    if (indexChanged) writePlayerIndex(shard, index);
  }
  console.log(`  Stubbed: ${stubbed}`);
  console.log();
  totalStubbed += stubbed;
  playerDeltas.clear();
  }

  // terminal commit: the final partial window's games were flushed above; this
  // carries its stubs (windows mid-run committed theirs inside the loop).
  await gitCommit(
    `spectator-backfill: ${spectatorHits} games filled, ${totalStubbed} new players stubbed (this run)`,
    ['players/']
  );

  // ── Summary ───────────────────────────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log('─'.repeat(50));
  console.log(`  Queue total:       ${queue.length}  (this run: ${needsSpectator.length})`);
  console.log(`  Spectator hits:    ${spectatorHits}  misses: ${spectatorMiss}`);
  console.log(`  Transport failures: ${transientFail} — NOT counted as misses, nothing written, still queued`);
  if (transientWhy.size) {
    for (const [why, n] of [...transientWhy.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${why}: ${n}`);
  }
  console.log(`  Players seen:      ${playersSeenWindows} (summed per commit window)`);
  console.log(`  New players:       ${totalStubbed}`);
  console.log(`  Remaining (approx): ${queue.length - spectatorHits} — misses stay queued until spectator answers`);
  console.log(`  Elapsed:           ${elapsed}s`);
  console.log('─'.repeat(50));
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
