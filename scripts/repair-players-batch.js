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
// Usage:
//   node scripts/repair-players-batch.js --min-gap=100            # DRY RUN
//   node scripts/repair-players-batch.js --min-gap=100 --apply
//   optional: --max-players=N  (safety cap per run)

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
    try { execFileSync('git', ['add', '--', p], { stdio: 'pipe', cwd: ROOT }); }
    catch (e) {
      addFailures++;
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      // "did not match any files" on a per-path add is benign — see the note below.
      if (!/did not match any files/i.test(detail)) hardAddFailures++;
      console.error(`  ⚠ git add ${/did not match any files/i.test(detail) ? 'skipped' : 'FAILED'} for "${p}": ${detail}`);
    }
  }

  const staged = (() => {
    try { return execFileSync('git', ['diff', '--staged', '--shortstat'], { stdio: 'pipe', cwd: ROOT }).toString().trim(); }
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
  try { execFileSync('git', [...IDENT, 'commit', '-q', '-m', message], { stdio: 'pipe', cwd: ROOT }); }
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
    try { execFileSync('git', ['merge', '--abort'], { stdio: 'pipe', cwd: ROOT }); } catch (_) { /* none in progress */ }

    try {
      execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'pipe', cwd: ROOT });
    } catch (e) {
      if (attempt === MAX) throw e;
      const s = 1 + Math.floor(Math.random() * 91);
      console.log(`  fetch failed (attempt ${attempt}/${MAX}), retrying in ${s}s`);
      await sleep(s * 1000);
      continue;
    }

    // A merge failure is a config or content problem, not a race — fatal.
    execFileSync('git', [...IDENT, 'merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat'], { stdio: 'pipe', cwd: ROOT });

    try {
      execFileSync('git', ['push', 'origin', 'HEAD:main'], { stdio: 'pipe', cwd: ROOT });
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

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return { done: {}, dead: {} }; }
}

async function main() {
  console.log(`repair-players-batch ${APPLY ? '[APPLY]' : '[dry-run]'} — min-gap=${MIN_GAP}${MAX_PLAYERS ? ` max-players=${MAX_PLAYERS}` : ''}`);
  const progress = loadProgress();

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

  // gameIndex (populated by inspectP) doubles as the write cache: the append
  // mutates the same parsed object the verdict was read from.
  const dirtySids = new Set();
  let doneCount = 0, totalAppends = 0, totalAlias = 0, totalAbsent = 0, totalDead = 0, sinceCommit = 0;

  const flushAndCommit = async (label) => {
    if (DRY_RUN) { dirtySids.clear(); return; }
    for (const sid of dirtySids) {
      fs.writeFileSync(path.join(gamesDir, `${sid}.json`), JSON.stringify(gameIndex.get(sid)));
    }
    fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
    dirtySids.clear();
    await gitCommit(label, ['games/bv', 'reports/repair-batch-progress.json']);
  };

  for (const t of targets) {
    const specIds = new Set(t.specIds);
    const uuid13 = t.uuid.slice(0, TRUNC_LEN);
    const r = await fetchProfile(t.uuid);
    if (r.status !== 'ok') {
      progress.dead[t.uuid] = r.status;
      totalDead++;
      console.log(`  ✗ ${t.uuid} "${t.name}" gap=${t.gap} — API status=${r.status}, recorded dead`);
      await sleep(1000);
      continue;
    }
    let appended = 0, alias = 0, absent = 0, pts = 0;
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
              if (insp.verdict === 'PRESENT-canonical') continue;
              if (insp.verdict !== 'GENUINELY-ABSENT') { alias++; continue; }
              const entry = gameIndex.get(heldSid).games[gameId];
              const g = gs.game;
              const side = g.home?.id === tid ? 'HOME' : g.away?.id === tid ? 'AWAY' : null;
              entry.p = entry.p || []; entry.p.push({ id: uuid13 });
              if (side === 'HOME') { entry.hp = entry.hp || []; entry.hp.push(buildStatLine(uuid13, gs.statistics)); }
              else if (side === 'AWAY') { entry.ap = entry.ap || []; entry.ap.push(buildStatLine(uuid13, gs.statistics)); }
              dirtySids.add(heldSid);
              appended++; pts += statValue(gs.statistics, 'TOTAL_SCORE');
            }
          }
        }
      }
    }
    progress.done[t.uuid] = { gap: t.gap, appended, alias, absent, pts };
    doneCount++; totalAppends += appended; totalAlias += alias; totalAbsent += absent; sinceCommit++;
    console.log(`  ✓ ${t.uuid} "${t.name}" gap=${t.gap} → appended=${appended} (${pts} pts), alias-skipped=${alias}, game-absent=${absent}`);
    if (sinceCommit >= COMMIT_EVERY) {
      await flushAndCommit(`repair-players-batch: ${doneCount}/${targets.length} players, ${totalAppends} appends so far (min-gap=${MIN_GAP})`);
      sinceCommit = 0;
    }
    await sleep(1000);
  }

  await flushAndCommit(`repair-players-batch: COMPLETE ${doneCount}/${targets.length} players, ${totalAppends} appends (min-gap=${MIN_GAP})`);

  console.log('\n════════════════════════════════════════════════════');
  console.log(`  players processed : ${doneCount}${APPLY ? '' : ' (dry-run — nothing written or committed)'}`);
  console.log(`  appends           : ${totalAppends}`);
  console.log(`  alias-skipped     : ${totalAlias}   ← fold problems, never touched`);
  console.log(`  game-absent       : ${totalAbsent}   ← synthesize-missing-games territory`);
  console.log(`  dead profiles     : ${totalDead}   ← API refused; recorded, never retried`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
