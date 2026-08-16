// scripts/repair-players-batch.js
//
// Batched roster repair for the appearance-gap backlog (staged plan, 2026-08-07):
// self-contained — at run start it recomputes the per-player gap ranking OFFLINE
// (profile-derived career gp minus roster-derived games[] length, the arithmetic
// size-gap-players validated against the 775k reference), selects every player at
// or above --min-gap not already settled in the progress file, then repairs each
// through the SAME per-game path as repair-player.js: profile fetch, and append
// ONLY where the alias inspection says GENUINELY-ABSENT (PRESENT-as-alias /
// PRESENT-legacy-10char are fold problems — never touched). Games absent from
// games/bv are counted, not synthesized.
//
// Long-running discipline (house rules):
//   - progress file reports/repair-batch-progress.json — { done:{uuid:summary},
//     dead:{uuid:status} } — COMMITTED at every save interval, never memory-only
//   - game files + progress committed every COMMIT_EVERY players (gitCommit below
//     is COPIED VERBATIM from nightly-crawl.js — per-path add, identity inline,
//     60-attempt jitter push, throw on exhaustion)
//   - resume = re-dispatch; done/dead players are skipped, ranking is recomputed
//     so anyone whose gap has since resolved drops out on their own
//   - sequential profile fetches with a 1s pause (the probe's cadence); this is
//     ~N minutes for N players, not a matrix-scale fan-out
//
// Staging is the --min-gap input: 100 first (the ~1,060 worst, ~200k appearances),
// then 50, then 20, per the agreed plan. The systematic capture-at-source change
// (active players, current + future) is a separate design; THIS tool exists
// because that change can never reach players the matrix will never fetch again.
//
// 2026-08-14 — THIS TOOL IS ALSO THE MEASUREMENT (OUTSTANDING §2.18). Every game
// credit the API returns is now classified into one of eight buckets rather than
// three, the result is stored per player in the progress file, and the campaign
// rollup is recomputed FROM THAT FILE and printed at every commit window — so a
// timeout costs the run's log and never the measurement. The buckets that matter
// for "how far can appending get us" are:
//   appended  — genuinely absent from a captured roster; appended here
//   self      — already in p[] under their own id AND in their games[]: correct
//   lag       — already in p[] under their own id but NOT in games[] yet; this
//               resolves itself on the next build-player-games run, no action
//   aliasOk   — in p[] under an alias that games[] already resolved: correct
//   aliasGap  — in p[] under an alias that games[] did NOT resolve: REAL fold /
//               alias backlog, the number the fold has to close
//   uncap     — genuinely absent but the roster is EMPTY: needs a capture sweep
//   absent    — the game is not in games/bv at all
//   odd       — the season file would not parse; a fault, not a finding
// Split by gap band, so whether the ratio holds as gaps get shallower is visible
// rather than assumed. Deep gaps are NOT a random sample of shallow ones.
//
// Usage:
//   node scripts/repair-players-batch.js --min-gap=100            # DRY RUN
//   node scripts/repair-players-batch.js --min-gap=100 --apply
//   optional: --max-players=N   (safety cap per run; 0 / omitted = no cap)
//   optional: --retry-dead      (re-admit players retired on a TRANSPORT failure)

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const MIN_GAP = Number((args.find(a => a.startsWith('--min-gap=')) || '').replace('--min-gap=', '') || '100');
const MAX_PLAYERS = Number((args.find(a => a.startsWith('--max-players=')) || '').replace('--max-players=', '') || '0');
const APPLY = args.includes('--apply');
const RETRY_DEAD = args.includes('--retry-dead');
// Per-player lines every N players instead of every player. A 10,000-player run
// wrote 10,000 player lines plus a full campaign table every 25, which buried the
// one thing that mattered — whether the run had finished. Dead profiles and
// transport skips are ALWAYS printed whatever this is set to: they are rare, and
// they are the lines you would actually go looking for.
const LOG_EVERY = Math.max(1, Number((args.find(a => a.startsWith('--log-every=')) || '').split('=')[1]) || 100);
// Profile fetches only. Classification, appends and every write stay strictly
// serial — see the chunk loop for why.
const CONCURRENCY = Math.max(1, Math.min(25, Number((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) || 1));
const DRY_RUN = !APPLY;   // gitCommit (verbatim) keys on DRY_RUN
const TRUNC_LEN = 13;
const COMMIT_EVERY = 25;
const PROGRESS_FILE = path.join(ROOT, 'reports', 'repair-batch-progress.json');

if (!Number.isFinite(MIN_GAP) || MIN_GAP < 1) { console.error('--min-gap must be >= 1'); process.exit(1); }

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

// ─── Stat helper (same shape as the deployed parser) ─────────────────────────
function statValue(stats, type) {
  for (const s of (stats || [])) {
    const v = s?.details?.value;
    if (v === type) return s.count || 0;
  }
  return 0;
}

// 2026-08-09: execFileSync's DEFAULT maxBuffer is 1 MB, and exceeding it SIGTERMs
// the child MID-OPERATION. fold-diverged-players died exactly this way on a
// 25,593-file commit: `git merge` printed 1,051,036 bytes of per-file
// "Auto-merging …" lines (1 MB = 1,048,576), Node killed git, and an
// already-made commit was never pushed. Every git call here scales its output
// with the number of changed files, so all of them get the larger buffer; `-q`
// on the merge suppresses the per-file lines at the source.
const GIT_MAXBUF = 512 * 1024 * 1024;

// 2026-08-14 — the git calls had maxBuffer but NO timeout. execFileSync is
// SYNCHRONOUS: it blocks the Node process, event loop included, so the 45s/180s
// guards on doFetch cannot fire while the process is parked inside git. `fetch`
// and `push` talk to the network against a 6 GB repo. A timeout makes
// execFileSync throw, which the push-retry loop already handles — the attempt
// simply fails and is retried, instead of the run stopping dead with no output.
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

// ── GIT AUTH, ESTABLISHED BY US RATHER THAN ASSUMED ────────────────────────────
// 2026-08-16: a run died at player 4,184 with
//   fatal: could not read Username for 'https://github.com'
// after ~167 successful pushes in the same job. The credential actions/checkout
// persists had stopped working partway through. WHY IS NOT ESTABLISHED — and
// three freezes today were each diagnosed by naming a plausible mechanism, two of
// which were wrong. So this does not theorise: it sets the credential itself at
// run start and sets it again on any auth failure, which makes the cause
// irrelevant. Same mechanism actions/checkout uses (an http.extraheader carrying
// basic auth), so it replaces like with like rather than introducing a new scheme.
//
// The header VALUE is never logged, and never appears in a git error message,
// which is why this is preferred over putting the token in the remote URL.
const PUSH_TOKEN = process.env.GH_PUSH_TOKEN || '';
// Reports the SHAPE of the local git credential state — key names, remote host,
// header length — and never a value. Called at run start and again on any auth
// failure, so "the credential was there and then it wasn't" becomes something
// visible in the log with a timestamp on it, rather than two people reasoning
// about which of GitHub or this script moved it.
//
// The specific question this exists to answer, from the 2026-08-16 failure: was
// the extraheader actions/checkout persists PRESENT at run start and MISSING at
// the point of failure (something removed it mid-job), or absent all along (the
// push worked on something else entirely until it didn't)?
function reportGitAuthState(when) {
  const line = (label, value) => console.log(`  git-auth[${when}] ${label}: ${value}`);
  try {
    const names = execFileSync('git', ['config', '--local', '--name-only', '--list'],
                               { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS })
      .toString().split('\n').map(x => x.trim()).filter(Boolean);
    const http = names.filter(n => /^(http|credential|url)\./i.test(n));
    line('http/credential keys', http.length ? http.join(' · ') : 'NONE');
  } catch (e) {
    line('config list failed', String(e.stderr || e.message).slice(0, 120));
  }
  // Length only. A present-but-truncated header and a missing one look different,
  // and neither reveals the credential.
  try {
    const v = execFileSync('git', ['config', '--local', '--get', 'http.https://github.com/.extraheader'],
                           { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS })
      .toString().trim();
    line('extraheader', `present, ${v.length} chars, starts "${v.slice(0, 21)}"`);
  } catch (_) {
    line('extraheader', 'ABSENT');
  }
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'],
                             { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS })
      .toString().trim();
    // A token embedded in the remote URL would appear here, so strip userinfo.
    line('origin', url.replace(/\/\/[^@/]*@/, '//<redacted>@'));
  } catch (e) {
    line('origin', `unavailable: ${String(e.stderr || e.message).slice(0, 80)}`);
  }
}

function armGitAuth(reason) {
  if (!PUSH_TOKEN) {
    console.error(`  git auth NOT armed (${reason}): GH_PUSH_TOKEN is not set in the environment`);
    return false;
  }
  const basic = Buffer.from(`x-access-token:${PUSH_TOKEN}`).toString('base64');
  try {
    execFileSync('git', ['config', '--local', 'http.https://github.com/.extraheader',
                         `AUTHORIZATION: basic ${basic}`],
                 { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS });
    console.log(`  git auth armed (${reason})`);
    return true;
  } catch (e) {
    console.error(`  git auth arm FAILED (${reason}): ${String(e.stderr || e.message).slice(0, 200)}`);
    return false;
  }
}
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
      // An auth failure is not contention and not permanent either — it is a
      // credential that needs re-establishing. Re-arm and retry rather than
      // killing a run that has hours of work behind it.
      const authFail = /could not read Username|Authentication failed|invalid username or password|HTTP 403|remote: Write access/i.test(detail);
      if (authFail && attempt < MAX) {
        console.error(`  push failed on AUTH (attempt ${attempt}/${MAX}) — re-arming the credential and retrying. git said:\n${detail}`);
        reportGitAuthState('at-failure');
        armGitAuth('push auth failure');
        continue;
      }
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


function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return { done: {}, dead: {} }; }
}

// ── A TRANSPORT FAILURE IS NOT A DEAD PROFILE ──────────────────────────────────
// Until 2026-08-14 every non-ok status was written to progress.dead and never
// retried, so ONE CloudFront block permanently retired a perfectly recoverable
// player. That is the same defect corrected in gqlSpectator on 2026-08-11, where
// a bare null for 403/429/5xx/network made a single bad moment retire a game for
// good: classify the outcome, never collapse a failure into an answer.
// Permanent (recorded, never retried): private, notfound, gql-error, and 4xx
// OTHER than 429.
// Transport (nothing recorded, retried on the next dispatch): cloudfront-block,
// socket errors, bad-json, http-5xx and http-429.
//
// 2026-08-14, second pass — 429 was on the wrong side of that line. It is the
// endpoint saying "too fast", which is the most transient answer there is, and
// with the fetch loop now running several profiles at once it is the status most
// likely to appear. Classifying it as permanent would have retired players for
// the sole reason that we asked quickly.
const TRANSPORT_STATUS = new Set(['cloudfront-block', 'error', 'bad-json', 'timeout']);
function isTransportStatus(status) {
  return TRANSPORT_STATUS.has(status) || /^http-(429|5\d\d)$/.test(status || '');
}

// ── Campaign rollup, recomputed from the progress file ─────────────────────────
// The progress file is the single durable record (T14: one writer, one key), so
// there is no second report file to reconcile with it and no way for the two to
// disagree. Entries written before this breakdown existed carry no `v` and are
// reported separately rather than blended in — their `alias` field counted a
// different population, and mixing two populations into one number is exactly
// what made the 1,330,231-surplus-regs figure meaningless (T15).
const BANDS = [
  { key: '1-5',    lo: 1,   hi: 5   },
  { key: '6-20',   lo: 6,   hi: 20  },
  { key: '21-50',  lo: 21,  hi: 50  },
  { key: '51-100', lo: 51,  hi: 100 },
  { key: '101+',   lo: 101, hi: Infinity },
];
function bandOf(gap) {
  for (const b of BANDS) if (gap >= b.lo && gap <= b.hi) return b.key;
  return 'other';
}
const BUCKETS = ['appended', 'self', 'lag', 'aliasOk', 'aliasGap', 'legacy', 'uncap', 'absent', 'odd'];

function summarise(progress, heading) {
  const keys = [...BANDS.map(b => b.key), 'other'];
  const rows = new Map();
  for (const k of keys) {
    const r = { players: 0, gap: 0, old: 0, oldAppended: 0, dead: 0 };
    for (const b of BUCKETS) r[b] = 0;
    rows.set(k, r);
  }
  const deadBy = new Map();

  // Pre-breakdown entries get their OWN row rather than contributing players and
  // sum-gap to a band whose bucket columns exclude them. The first cut counted
  // them in two columns and left them out of the other nine, so the table read as
  // though 422,948 games of gap had produced 1,021 appends — Mark caught it, and
  // he was right: a row that mixes two schemas in different columns is not a
  // summary of anything.
  const oldRow = { players: 0, gap: 0, appended: 0 };
  for (const [, rec] of Object.entries(progress.done || {})) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.v !== 2) {
      oldRow.players++;
      oldRow.gap += Number(rec.gap) || 0;
      oldRow.appended += Number(rec.appended) || 0;
      continue;
    }
    const r = rows.get(bandOf(Number(rec.gap) || 0));
    r.players++;
    r.gap += Number(rec.gap) || 0;
    for (const b of BUCKETS) r[b] += Number(rec[b]) || 0;
  }
  for (const [, rec] of Object.entries(progress.dead || {})) {
    const status = typeof rec === 'string' ? rec : (rec && rec.status) || '?';
    const gap = (rec && typeof rec === 'object' && Number(rec.gap)) || 0;
    rows.get(gap ? bandOf(gap) : 'other').dead++;
    deadBy.set(status, (deadBy.get(status) || 0) + 1);
  }

  const n = (v) => Number(v || 0).toLocaleString();
  const cols = ['players', 'gap', 'appended', 'self', 'lag', 'aliasOk', 'aliasGap', 'legacy', 'uncap', 'absent', 'odd', 'dead'];
  const head = ['band', 'players', 'sum gap', 'appended', 'self', 'lag', 'aliasOk', 'aliasGap', 'legacy', 'uncapt', 'absent', 'odd', 'dead'];
  const W = [8, 9, 11, 11, 9, 8, 9, 9, 8, 8, 10, 7, 7];

  console.log(`\n── campaign to date — ${heading} ──`);
  console.log(head.map((h, i) => h.padStart(W[i])).join(''));
  const tot = { players: 0, gap: 0, old: 0, oldAppended: 0, dead: 0 };
  for (const b of BUCKETS) tot[b] = 0;
  for (const k of keys) {
    const r = rows.get(k);
    if (!r.players && !r.dead) continue;
    console.log([k, ...cols.map(c => n(r[c]))].map((v, i) => String(v).padStart(W[i])).join(''));
    for (const c of cols) tot[c] = (tot[c] || 0) + (r[c] || 0);
  }
  console.log(['TOTAL', ...cols.map(c => n(tot[c]))].map((v, i) => String(v).padStart(W[i])).join(''));
  if (oldRow.players) {
    const dash = () => '—';
    console.log(['pre-8/14', n(oldRow.players), n(oldRow.gap), n(oldRow.appended),
                 dash(), dash(), dash(), dash(), dash(), dash(), dash(), dash(), dash()]
                .map((v, i) => String(v).padStart(W[i])).join(''));
    console.log(`  pre-8/14 = settled before the per-credit breakdown existed: players, gap and appends are known, ` +
                `the nine bucket columns are not. Shown as its own row, never folded into a band, and excluded from the shares below.`);
    console.log(`  campaign appends including that row: ${n(tot.appended + oldRow.appended)}`);
  }
  if (deadBy.size) {
    console.log(`  dead profiles by status: ${[...deadBy.entries()].sort((a, b) => b[1] - a[1]).map(([k2, v]) => `${k2} ${n(v)}`).join(' · ')}`);
  }

  console.log(`\n  share of ACTIONABLE credits (appended + aliasGap + uncapt + absent + odd) — the ratio the route-to-zero decision rests on:`);
  let any = false;
  for (const k of keys) {
    const r = rows.get(k);
    const denom = r.appended + r.aliasGap + r.uncap + r.absent + r.odd;
    if (!denom) continue;
    any = true;
    const pc = (v) => `${((v / denom) * 100).toFixed(1)}%`;
    console.log(`    ${k.padEnd(8)} n=${String(n(denom)).padStart(9)}   ` +
                `appendable ${pc(r.appended).padStart(6)} · alias-blocked ${pc(r.aliasGap).padStart(6)} · ` +
                `uncaptured ${pc(r.uncap).padStart(6)} · game-absent ${pc(r.absent).padStart(6)} · odd ${pc(r.odd).padStart(6)}`);
  }
  if (!any) console.log('    (no v2 entries yet — run with --apply to start recording the breakdown)');
  console.log(`  already correct, no action needed: self ${n(tot.self)} (in games[]) · aliasOk ${n(tot.aliasOk)} (alias already resolved)`);
  console.log(`  pending the next build-player-games run: lag ${n(tot.lag)}`);
}

async function main() {
  console.log(`repair-players-batch ${APPLY ? '[APPLY]' : '[dry-run]'} — min-gap=${MIN_GAP}${MAX_PLAYERS ? ` max-players=${MAX_PLAYERS}` : ''}`);
  const progress = loadProgress();

  // Re-admit anyone retired on a TRANSPORT failure by the pre-2026-08-14
  // behaviour, where every non-ok status went to progress.dead and was never
  // retried. Those players are recoverable and were written off by a CloudFront
  // block or a socket error, not by an answer from PlayHQ. Only persists on
  // --apply, because dry-run never writes the progress file.
  if (RETRY_DEAD) {
    let readmitted = 0;
    const sample = [];
    for (const [uuid, rec] of Object.entries(progress.dead || {})) {
      const status = typeof rec === 'string' ? rec : (rec && rec.status) || '';
      if (!isTransportStatus(status)) continue;
      delete progress.dead[uuid];
      readmitted++;
      if (sample.length < 10) sample.push(`${uuid} (${status})`);
    }
    console.log(`  --retry-dead: re-admitted ${readmitted.toLocaleString()} player(s) previously retired on a transport failure`);
    for (const x of sample) console.log(`      e.g. ${x}`);
    if (!APPLY) console.log('      (dry-run — the re-admission is not written back to the progress file)');
  }

  // State BEFORE we touch anything, so what checkout left behind is on the record
  // separately from what this script then does.
  reportGitAuthState('run-start');
  // Arm before the first commit window, not after the first failure.
  armGitAuth('run start');
  reportGitAuthState('after-arming');

  summarise(progress, 'state at run start');

  // ── Offline ranking pass ─────────────────────────────────────────────────────
  const playersDir = path.join(ROOT, 'players');
  const worklist = [];
  for (const shard of fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d))) {
    const dir = path.join(playersDir, shard);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const uuid = f.replace(/\.json$/, '');
      if (progress.done[uuid] || progress.dead[uuid]) continue;
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      let gp = 0, hasGp = false;
      for (const s of Object.values(p.sports || {})) {
        if (s && typeof s.gp === 'number') { gp += s.gp; hasGp = true; }
      }
      if (!hasGp) continue;
      const gap = gp - (Array.isArray(p.games) ? p.games.length : 0);
      if (gap >= MIN_GAP) worklist.push({ uuid, gap, name: p.name || '?', specIds: Array.isArray(p.spectatorIds) ? p.spectatorIds : [] });
    }
  }
  worklist.sort((a, b) => b.gap - a.gap);
  const targets = MAX_PLAYERS > 0 ? worklist.slice(0, MAX_PLAYERS) : worklist;
  console.log(`  players at gap>=${MIN_GAP} not yet settled: ${worklist.length}${MAX_PLAYERS ? ` (capped to ${targets.length})` : ''}`);

  // What is actually DUE this dispatch, by band and by size of the hole. The
  // worklist is recomputed from the CURRENT games[] every run, so this number
  // drops between dispatches as build-player-games catches up with appends
  // already made — which is why it can come out far below the population figure
  // the band was sized at. Print the breakdown rather than one total, so a
  // surprising number can be understood on sight instead of guessed at.
  {
    const due = new Map();
    let dueGap = 0;
    for (const t of targets) {
      const k = bandOf(t.gap);
      due.set(k, (due.get(k) || 0) + 1);
      dueGap += t.gap;
    }
    const order = [...BANDS.map(b => b.key), 'other'].filter(k => due.has(k));
    console.log(`  DUE THIS RUN: ${targets.length.toLocaleString()} players, ${dueGap.toLocaleString()} games of gap between them`);
    console.log(`    by band: ${order.map(k => `${k} ${due.get(k).toLocaleString()}`).join(' · ')}`);
  }
  if (!targets.length) { console.log('  nothing to do'); return; }

  // ── gid -> sid map (once) ────────────────────────────────────────────────────
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

  // gameIndex (populated by inspectP) doubles as the write cache: the append
  // mutates the same parsed object the verdict was read from.
  const dirtySids = new Set();

  // The DURABLE record is the progress file, one entry per player; the campaign
  // figures are recomputed from it at every commit window (see summarise). The
  // counters below are this RUN only, and exist so the log shows what this
  // dispatch did as distinct from what the campaign has done.
  let doneCount = 0, totalAppends = 0, totalDead = 0, sinceCommit = 0;
  // `seen` counts every player the run has REACHED, whatever the outcome —
  // repaired, retired, or skipped on transport. doneCount counts only the ones
  // that produced a breakdown, so it is the wrong thing to show as progress: a
  // run full of dead profiles would look stalled.
  let seen = 0;
  const TOTAL = targets.length;
  const PAD = String(TOTAL).length;
  const START_MS = Date.now();
  const prog = () => `[${String(seen).padStart(PAD)}/${TOTAL}]`;
  const hms = (secs) => {
    if (!isFinite(secs) || secs < 0) return '?';
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m ${Math.floor(secs % 60)}s`;
  };
  let skippedTransport = 0, consecutiveTransport = 0;
  const run = { appended: 0, self: 0, lag: 0, aliasOk: 0, aliasGap: 0, legacy: 0, uncap: 0, absent: 0, odd: 0 };

  // Every counter prints examples beside it (T15): a number nobody can spot-check
  // is a number nobody can catch being wrong. Capped so a long run cannot fill
  // the log with them.
  const SAMPLE_CAP = 15;
  const samples = { aliasGap: [], uncap: [], neither: [] };
  const deadMsgs = new Map();   // first-error message -> count, for the end block
  const keep = (k, line) => { if (samples[k].length < SAMPLE_CAP) samples[k].push(line); };

  // Where the appends are LANDING. A roster that is already a full twelve to
  // nineteen and still missing a credited player is a different story from a
  // roster of four — the first is consistent with the player being present under
  // an id we cannot see, the second with the proven partial-capture mechanism
  // (game 7da945a8: a stored 12 of a live 19). And a roster carrying NEITHER
  // capture flag was built by an earlier repair rather than by a sweep, which is
  // the population OUTSTANDING §2.15 is about. Both are free to record here.
  const rosterHist = { '1-4': 0, '5-8': 0, '9-11': 0, '12-14': 0, '15+': 0 };
  const provenance = { spc: 0, dg: 0, both: 0, neither: 0 };
  const rosterBucket = (n2) => n2 <= 4 ? '1-4' : n2 <= 8 ? '5-8' : n2 <= 11 ? '9-11' : n2 <= 14 ? '12-14' : '15+';

  // One small read per player, not a map held across the run: at min-gap=1 the
  // worklist is ~115,000 players and holding every games[] would be millions of
  // strings in the heap — the shape of the OOM fixed below, rebuilt in a new
  // place. Read it when the player comes up, drop it when they are done.
  const loadGamesSet = (uuid) => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(playersDir, uuid.slice(0, 2), `${uuid}.json`), 'utf8'));
      return new Set(Array.isArray(p.games) ? p.games : []);
    } catch { return new Set(); }
  };

  // 2026-08-11 (OOM fix): inspectP's gameIndex caches every season file it parses
  // and NOTHING evicted them, so a run spanning hundreds of seasons accumulated
  // most of games/bv in the heap — a 468-player dry run died at the 4 GB limit
  // after ~90 players. The commit window is the natural eviction point: by then
  // every touched season has been written (apply) or is irrelevant (dry-run), so
  // the cache can be dropped wholesale. Memory is now bounded by ONE window's
  // worth of seasons instead of the whole run. Cost is re-parsing a season if a
  // later window touches it again, which is cheap next to running out of memory.
  const evictSeasonCache = () => { gameIndex.clear(); };

  const flushAndCommit = async (label) => {
    if (DRY_RUN) { dirtySids.clear(); return; }
    for (const sid of dirtySids) {
      fs.writeFileSync(path.join(gamesDir, `${sid}.json`), JSON.stringify(gameIndex.get(sid)));
    }
    fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
    dirtySids.clear();
    // Announce the phase BEFORE blocking in git, so a freeze inside a commit is
    // distinguishable from a slow player instead of looking identical to one.
    console.log(`  … committing (${label})`);
    await gitCommit(label, ['games/bv', 'reports/repair-batch-progress.json']);
  };

  // ── FETCH IS CONCURRENT, EVERYTHING ELSE IS NOT ─────────────────────────────
  // The 2026-08-14 min-gap=20 run took a whole dispatch to do 2,537 players at one
  // profile per second. The 6-19 band is 18,447 players and everything below it is
  // ~94,000: at that cadence, thirty-plus dispatches. So the FETCH is parallelised
  // and nothing else is.
  //
  // Classification, the p[] append, dirtySids, the progress record and every
  // counter stay strictly serial, in worklist order, exactly as before. That is
  // not caution for its own sake: gameIndex is both the read cache and the write
  // buffer, two players in the same season mutate the same parsed object, and the
  // whole point of the season cache is that a second append SEES the first. Node
  // being single-threaded does not save code that awaits in the middle of a
  // read-modify-write. Parallelising the network is worth roughly an order of
  // magnitude; parallelising the writes would be worth nothing and would risk
  // everything.
  //
  // Chunked rather than a sliding window, deliberately: a chunk boundary is a
  // natural place to read the error rate and adjust, the memory ceiling is
  // obvious (one chunk of profiles in flight), and there is no queue to reason
  // about. Some throughput is left on the table and the design fits in the head.
  const fetchWithRetry = async (t) => {
    // Up to three attempts on a transport failure before giving up on this
    // player for this dispatch. Nothing is recorded either way — an unrecorded
    // player is simply picked up again next time.
    let r = await fetchProfile(t.uuid);
    for (let tries = 1; tries < 3 && r.status !== 'ok' && isTransportStatus(r.status); tries++) {
      const wait = tries * 30;
      console.log(`  … ${t.uuid} transport failure (${r.status}) — attempt ${tries + 1}/3 in ${wait}s`);
      await sleep(wait * 1000);
      r = await fetchProfile(t.uuid);
    }
    return r;
  };

  let conc = CONCURRENCY;
  let cleanChunks = 0, stopRun = false;
  console.log(`  fetch concurrency: ${conc} (backs off on transport failures, recovers after two clean chunks)`);
  // The log states which guards are compiled in, so "is the fix actually
  // deployed?" is answered by reading the run instead of trusting a commit (T12).
  console.log(`  guards: http idle ${IDLE_TIMEOUT_MS / 1000}s · http hard ${HARD_TIMEOUT_MS / 1000}s · git ${GIT_TIMEOUT_MS / 1000}s`);

  for (let cursor = 0; cursor < targets.length && !stopRun; ) {
    const chunk = targets.slice(cursor, cursor + conc);
    cursor += chunk.length;
    const fetched = await Promise.all(chunk.map(async (t) => ({ t, r: await fetchWithRetry(t) })));
    let chunkTransport = 0;

  for (const { t, r } of fetched) {
    seen++;
    const specIds = new Set(t.specIds);
    const uuid13 = t.uuid.slice(0, TRUNC_LEN);
    const heldGids = loadGamesSet(t.uuid);

    if (r.status !== 'ok' && isTransportStatus(r.status)) {
      chunkTransport++;
      skippedTransport++; consecutiveTransport++;
      console.log(`  ~ ${prog()} ${t.uuid} "${t.name}" gap=${t.gap} — ${r.status}; NOT recorded dead, will be retried on the next dispatch`);
      // Five in a row is the endpoint refusing us, not five unlucky players.
      // Carrying on would march through the remaining queue producing nothing
      // and, worse, would make the run LOOK like it had processed them. Stop,
      // commit what exists, let the next dispatch resume.
      if (consecutiveTransport >= 5) {
        console.log(`\n  ✗ ${consecutiveTransport} players in a row failed on transport — stopping cleanly rather than burning the queue.`);
        stopRun = true;
        break;
      }
      continue;
    }
    consecutiveTransport = 0;

    if (r.status !== 'ok') {
      // Store WHY, not just that. 155 players sat in this file as bare
      // "gql-error" with no way to tell a permanent refusal from a server
      // hiccup — a counter with no example again (T15). The message is already
      // in the response; it was simply never written down. Truncated, because
      // this file is committed on every window.
      const msg = Array.isArray(r.errors) && r.errors.length
        ? String(r.errors[0]?.message || '').slice(0, 200)
        : undefined;
      progress.dead[t.uuid] = { v: 2, status: r.status, gap: t.gap, ...(msg ? { msg } : {}) };
      totalDead++; sinceCommit++;
      if (msg && deadMsgs.size < 40 && !deadMsgs.has(msg)) deadMsgs.set(msg, 0);
      if (msg && deadMsgs.has(msg)) deadMsgs.set(msg, deadMsgs.get(msg) + 1);
      console.log(`  ✗ ${prog()} ${t.uuid} "${t.name}" gap=${t.gap} — API status=${r.status}, recorded dead (permanent)${msg ? ` — ${msg}` : ''}`);
      continue;
    }

    let appended = 0, self = 0, lag = 0, aliasOk = 0, aliasGap = 0, legacy = 0, uncap = 0, absent = 0, odd = 0, pts = 0;
    for (const season of (r.data?.publicProfileStatistics?.seasonStatistics || [])) {
      for (const reg of (season.statistics || [])) {
        for (const teamStat of (reg.teamStatistics || [])) {
          const tid = teamStat.team?.id || null;
          for (const gradeStat of (teamStat.gradeStatistics || [])) {
            for (const gs of (gradeStat.gameStatistics || [])) {
              const gameId = gs.game?.id || null;
              if (!gameId) continue;
              const heldSid = gidToSid.get(gameId) || null;
              if (!heldSid) { absent++; continue; }
              const insp = inspectP(heldSid, gameId, t.uuid, specIds);

              // Already in the roster under their own id. Whether that credit is
              // still missing from their games[] is the difference between "done"
              // and "waiting on the weekly rebuild", and it is the only clean
              // measurement of that lag we have.
              if (insp.verdict === 'SELF-PRESENT') {
                if (heldGids.has(gameId)) self++; else lag++;
                continue;
              }

              // In the roster under a DIFFERENT id. If games[] already holds the
              // game, the alias index resolved it and there is nothing to fix. If
              // it does not, the alias is unregistered and this is genuine fold
              // work — appending here would create a second identity in the same
              // roster, which is why it is never touched either way.
              if (insp.verdict === 'PRESENT-as-alias' || insp.verdict === 'PRESENT-legacy-10char') {
                if (insp.verdict === 'PRESENT-legacy-10char') legacy++;
                if (heldGids.has(gameId)) { aliasOk++; }
                else {
                  aliasGap++;
                  keep('aliasGap', `${gameId} sid=${heldSid} player=${t.uuid} → ${insp.verdict}${insp.alias ? ` (${insp.alias})` : ''}`);
                }
                continue;
              }

              // Anything that is not one of the four real verdicts means the
              // season file did not parse. That is a fault to look at, not a
              // finding about the data, so it gets its own bucket instead of
              // being folded into the alias number as it used to be.
              if (insp.verdict !== 'GENUINELY-ABSENT') {
                odd++;
                keep('aliasGap', `${gameId} sid=${heldSid} → ${insp.verdict} (ODD — season file unreadable?)`);
                continue;
              }

              // 2026-08-13 — DO NOT APPEND TO AN UNCAPTURED GAME. An empty p[] is not
              // a roster with a gap in it; it is a game no sweep has ever captured
              // (no spc, no dg). Appending one player there manufactures a roster of
              // ONE, which every consumer — team stats, leaderboards, opposition
              // lookup, StatTrack — reads as the full team. Proven on 43199a27
              // (2026-08-04, Berwick College White): the batch left it with exactly
              // two ids, both of them its own top-ranked repair targets, in a game
              // that should hold a dozen. Same failure class as the hp/ap fragment
              // caught on 2026-08-11: a fragment that LOOKS like real data is worse
              // than absence, because absence makes a consumer go and fetch it.
              // These games need a CAPTURE (spectator or discoverGame sweep), not a
              // repair, so they are counted and skipped here.
              if (!insp.n) {
                uncap++;
                keep('uncap', `${gameId} sid=${heldSid} (empty roster — needs a capture sweep)`);
                continue;
              }

              const entry = gameIndex.get(heldSid).games[gameId];
              const g = gs.game;
              const side = g.home?.id === tid ? 'HOME' : g.away?.id === tid ? 'AWAY' : null;
              // ROSTER ONLY — bare {id}, no stat line (2026-08-10). Writing a
              // hp[]/ap[] entry for a single appended player into a REAL crawled game
              // produces a FRAGMENT that reads as a box score: one scorer, everyone
              // else apparently absent. Completing them all is ~25M stat lines /
              // ~1.9 GB — larger than the dataset and past the Pages ceiling — and
              // stored stats go stale when scorers amend them, while the Worker always
              // serves the current version. House rule: p[] is bare {id}; box scores
              // are Worker-on-demand, never pre-stored; profileOnly (hidden) games are
              // the sole exception and belong to synthesize-missing-games. The
              // appearance is the thing that was missing, and p[] carries it.
              entry.p = entry.p || []; entry.p.push({ id: uuid13 });
              dirtySids.add(heldSid);
              appended++; pts += statValue(gs.statistics, 'TOTAL_SCORE');

              // Roster size is read BEFORE this append (inspectP built the set on
              // entry), but a second append into the SAME game later in the run
              // sees the grown roster — the cache is the write buffer. Reading
              // these numbers as exact per-game sizes would therefore be wrong;
              // they are a shape, not a census.
              rosterHist[rosterBucket(insp.n)]++;
              const key = insp.spc && insp.dg ? 'both' : insp.spc ? 'spc' : insp.dg ? 'dg' : 'neither';
              provenance[key]++;
              if (key === 'neither') keep('neither', `${gameId} sid=${heldSid} roster=${insp.n} (no spc, no dg — repair-written roster)`);
            }
          }
        }
      }
    }

    progress.done[t.uuid] = { v: 2, gap: t.gap, appended, self, lag, aliasOk, aliasGap, legacy, uncap, absent, odd, pts };
    doneCount++; totalAppends += appended; sinceCommit++;
    run.appended += appended; run.self += self; run.lag += lag; run.aliasOk += aliasOk;
    run.aliasGap += aliasGap; run.legacy += legacy; run.uncap += uncap; run.absent += absent; run.odd += odd;
    if (seen % LOG_EVERY === 0 || seen === TOTAL) console.log(`  ✓ ${prog()} ${t.uuid} "${t.name}" gap=${t.gap} → appended=${appended} (${pts} pts) · correct: self=${self} aliasOk=${aliasOk} · pending rebuild: lag=${lag} · blocked: aliasGap=${aliasGap} uncapt=${uncap} absent=${absent} odd=${odd}`);
    if (sinceCommit >= COMMIT_EVERY) {
      await flushAndCommit(`repair-players-batch: ${doneCount}/${targets.length} players, ${totalAppends} appends so far (min-gap=${MIN_GAP})`);
      evictSeasonCache();
      const elapsed = (Date.now() - START_MS) / 1000;
      const perMin = seen / (elapsed / 60);
      const left = perMin > 0 ? ((TOTAL - seen) / perMin) * 60 : Infinity;
      const pct = ((seen / TOTAL) * 100).toFixed(1);
      // An estimate from the run's own average, not a promise: players differ
      // enormously in how many games they carry, and the concurrency moves.
      console.log(`  PROGRESS ${prog()}  ${pct}%  ·  elapsed ${hms(elapsed)}  ·  ${perMin.toFixed(1)} players/min  ·  ~${hms(left)} left at this average  ·  concurrency ${conc}  ·  ${(TOTAL - seen).toLocaleString()} left this run`);
      // The campaign table used to print here too — every 25 players. It is a
      // cumulative figure that barely moves in one window, so it added a screen
      // of output per window and hid the progress line inside it. It prints at
      // run start and run end, where it is actually read.
      sinceCommit = 0;
    }
  }

    // Back off on any transport failure in the chunk and recover slowly. Same
    // shape as the documented main-endpoint policy — reduce hard, recover gently
    // — rather than a second scheme invented here.
    if (chunkTransport) {
      cleanChunks = 0;
      const was = conc;
      conc = Math.max(1, Math.floor(conc * 0.6));
      if (conc !== was) console.log(`  … ${chunkTransport} transport failure(s) in that chunk — concurrency ${was} → ${conc}, pausing 30s`);
      await sleep(30000);
    } else if (conc < CONCURRENCY && ++cleanChunks >= 2) {
      conc = Math.min(CONCURRENCY, conc + 1);
      cleanChunks = 0;
      console.log(`  … two clean chunks — concurrency back up to ${conc}`);
    }
    await sleep(1000);
  }

  await flushAndCommit(`repair-players-batch: COMPLETE ${doneCount}/${targets.length} players, ${totalAppends} appends (min-gap=${MIN_GAP})`);

  console.log('\n════════════════════════════════════════════════════');
  console.log(`  THIS RUN${APPLY ? '' : ' (dry-run — nothing written or committed)'}`);
  console.log(`  players reached          : ${seen} of ${TOTAL} selected${seen < TOTAL ? `  ← ${TOTAL - seen} NOT reached; re-dispatch to resume` : '  ← complete'}`);
  console.log(`  players processed        : ${doneCount} of ${targets.length} selected`);
  console.log(`  elapsed                  : ${hms((Date.now() - START_MS) / 1000)} at ${(seen / (((Date.now() - START_MS) / 1000) / 60)).toFixed(1)} players/min`);
  console.log(`  appends                  : ${run.appended}`);
  console.log(`  already correct          : self=${run.self} (own id, in games[]) · aliasOk=${run.aliasOk} (alias already resolved)`);
  console.log(`  pending weekly rebuild   : lag=${run.lag}   ← own id in the roster, not yet in games[]; build-player-games closes these`);
  console.log(`  alias-blocked            : ${run.aliasGap}   ← in the roster under an UNRESOLVED id: fold work, never appended`);
  console.log(`     of which legacy-10char: ${run.legacy}`);
  for (const x of samples.aliasGap) console.log(`       ${x}`);
  console.log(`  uncaptured games skipped : ${run.uncap}   ← EMPTY roster: needs a sweep, not a repair`);
  for (const x of samples.uncap) console.log(`       ${x}`);
  console.log(`  game-absent              : ${run.absent}   ← synthesize-missing-games territory`);
  console.log(`  odd (unparseable season) : ${run.odd}`);
  console.log(`  dead profiles            : ${totalDead}   ← PlayHQ answered permanently; recorded, never retried`);
  for (const [m, c] of [...deadMsgs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`       ${String(c).padStart(6)} × ${m}`);
  }
  console.log(`  skipped on transport     : ${skippedTransport}   ← NOT recorded; retried on the next dispatch`);

  if (run.appended) {
    console.log(`\n  where the appends landed (roster size BEFORE the append — a shape, not a census):`);
    for (const k of ['1-4', '5-8', '9-11', '12-14', '15+']) {
      const v = rosterHist[k];
      console.log(`    roster ${k.padEnd(6)} ${String(v).padStart(9)}  ${((v / run.appended) * 100).toFixed(1)}%`);
    }
    console.log(`  capture provenance of those games: spc ${provenance.spc} · dg ${provenance.dg} · both ${provenance.both} · NEITHER ${provenance.neither}`);
    console.log(`    "neither" means the roster came from an earlier repair, not from a sweep (OUTSTANDING §2.15):`);
    for (const x of samples.neither) console.log(`       ${x}`);
  }

  summarise(progress, 'end of run');

  // ── TERMINAL MARKER ─────────────────────────────────────────────────────────
  // A run that finished looked identical to a run that was still going, so a
  // completed dispatch was cancelled on the assumption it had hung. This is the
  // line to look for, and it is the last thing printed before the process exits.
  const complete = seen >= TOTAL;
  console.log('\n' + '═'.repeat(64));
  console.log(`  RUN ${complete ? 'COMPLETE' : 'STOPPED EARLY'} — ${seen}/${TOTAL} players reached, ${totalAppends.toLocaleString()} appends`);
  console.log(`  ${complete ? 'Nothing further to do for this dispatch.' : `${TOTAL - seen} not reached — re-dispatch to resume.`}`);
  console.log(`  Everything above is committed and pushed. Safe to close.`);
  console.log('═'.repeat(64));
}

// 2026-08-14 — THE RUN FINISHED AND THE PROCESS DID NOT EXIT.
// The 8,000-player run printed its final commit, its whole end block and the
// campaign table, then sat there until it was cancelled — and GitHub reported it
// as still running for as long as it did. main() had returned; something was
// still holding the event loop open. Node will not exit while a socket or timer
// is pending, however finished the work is.
//
// So: say what is still open, THEN leave. The dump is not decoration — three
// separate freezes have now been diagnosed by guessing, and two of those guesses
// were wrong (the HTTP timeouts could not have helped here, and neither could the
// git ones). One line of evidence in the log beats a fourth theory.
//
// The 500 ms pause before exiting is deliberate: stdout is a PIPE under Actions,
// where writes are asynchronous, and process.exit() would truncate the very
// output this is here to produce.
function activeHandleSummary() {
  try {
    const handles = (process._getActiveHandles && process._getActiveHandles()) || [];
    const requests = (process._getActiveRequests && process._getActiveRequests()) || [];
    const byType = new Map();
    for (const h of handles) {
      const t = (h && h.constructor && h.constructor.name) || typeof h;
      byType.set(t, (byType.get(t) || 0) + 1);
    }
    const parts = [...byType.entries()].map(([t, c]) => `${t} ${c}`).join(' · ') || 'none';
    return `handles: ${parts} · pending requests: ${requests.length}`;
  } catch (e) {
    return `handle inspection unavailable (${e.message})`;
  }
}

main()
  .then(async () => {
    // stdin and the Actions stdout/stderr pipes are always present and are not
    // the culprit; anything else listed here is what kept the run alive.
    console.log(`\n  exiting — ${activeHandleSummary()}`);
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('FATAL:', e.message);
    console.error(`  at exit — ${activeHandleSummary()}`);
    await new Promise(r => setTimeout(r, 500));
    process.exit(1);
  });
