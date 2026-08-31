// scripts/measure-credited-coverage.js
//
// READ-ONLY MEASUREMENT. Writes nothing to players/, games/ or data/.
// The only file it commits is its own progress/report file under reports/.
//
// THE QUESTION IT ANSWERS
// ───────────────────────
// The proposal in proposal-store-playhq-credited-games.md wants to store the
// per-game list PlayHQ credits (`gamesAPI`) so that "captured but not credited"
// becomes inspectable per game rather than as a bare count.
//
// But `player.u` ALREADY stores captured appearances the player holds no
// registration for, and PlayHQ can only credit a game through a registration
// (seasonStatistics[].statistics[].teamStatistics[].gradeStatistics[].gameStatistics[]).
// So every entry in `u` should already be a game PlayHQ does not credit.
// `u` costs 2.2 MB. A full second game list costs an estimated 300+ MB.
//
// This script measures how much of the captured-not-credited set is ALREADY
// explained by fields that exist today, and how much is left over. The leftover
// is the only part a new stored array would add.
//
// Every captured game PlayHQ does not credit is put in exactly one bucket,
// tested in this order:
//
//   forfeit       the game is in data/forfeit-games.json. fetch-profile-stats.js
//                 line 393 skips these before the dedup, so they can NEVER appear
//                 on the credited side. Not a finding — an artefact of the filter.
//   inU           the game id appears in player.u. Already stored today.
//   noRegSeason   we hold no registration for that game's season at all. This is
//                 build-player-games.js's `unmeasurable` bucket (137,455 repo-wide,
//                 line 249) — deliberately not emitted into `u` because absence of
//                 evidence is not evidence of absence.
//   notInGamesBv  the game is in player.games and NOT in games/bv. games[] is
//                 GENERATED from games/bv (trap T24), so in a consistent repo this
//                 is zero. Anything here means games[] is stale against games/bv —
//                 a weekly-rebuild lag reading, and it must NOT be blended into
//                 noRegSeason, which is a statement about registrations.
//   residue       none of the above. ◄── THIS IS THE NUMBER THAT DECIDES IT.
//
// And the reverse direction, which nothing in the repo can currently answer
// offline and which is the whole content of the cheap alternative:
//
//   gameAbsent    PlayHQ credits it, games/bv has no such game.
//   gameHeld      PlayHQ credits it, games/bv HAS the game, but it is not in this
//                 player's captured list — a roster gap or an unregistered alias.
//                 Splitting those two apart needs playerIdSet()/rosterIdMatches()
//                 from scripts/lib/namespace-resolve.cjs and is NOT attempted here.
//
// THE ID-FORM GUARD
// ─────────────────
// fetch-profile-stats.js performs no truncation: it writes the API's raw
// game.id into gameTids and records.gameKey and matches it against
// forfeit-games.json. player.games holds games/bv keys. If those two are not the
// same string space then this whole comparison is meaningless — and so are
// gameTids lookups, records.gameKey and the forfeit filter.
//
// So the script checks. After the first batch, if not one sampled player has a
// single game in common between the two sides, it ABORTS and prints an example
// of each form. A zero overlap is not a finding about the data, it is proof the
// two lists are not comparable, and continuing would produce a confident report
// made entirely of an id mismatch.
//
// EVERY API BLOCK BELOW IS COPIED FROM fetch-profile-stats.js, NOT REWRITTEN.
// Headers, cookie queries, session lock, PROFILE_QUERY, doFetch, the 403/504/
// NOT_FOUND ladder, the batch-of-30 loop with a session refresh per batch. The
// authority for those shapes is that they are exercised against the real API
// every matrix run. Line references are to the version read on 2026-08-31.
//
// Run:
//   node scripts/measure-credited-coverage.js --sample=1200
//   node scripts/measure-credited-coverage.js --sample=600 --stratum=withu
//   node scripts/measure-credited-coverage.js --fresh
//
// Resume: re-dispatch. Players already in the progress file are never re-fetched,
// so a CloudFront block costs the rest of that run and nothing else.

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const https        = require('https');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  if (!a) return dflt;
  return a.slice(name.length + 3);
};

const SAMPLE       = Math.max(1, parseInt(argVal('sample', '1200'), 10) || 1200);
const SEED         = parseInt(argVal('seed', '20260831'), 10) || 20260831;
const STRATUM      = String(argVal('stratum', 'all')).toLowerCase();
const COMMIT_EVERY = Math.max(1, parseInt(argVal('commit-every', '100'), 10) || 100);
const FRESH        = args.includes('--fresh');
const DRY_RUN      = args.includes('--dry-run');   // no git, everything else identical

if (!['all', 'withu', 'nou'].includes(STRATUM)) {
  console.error(`Usage: node scripts/measure-credited-coverage.js [--sample=N] [--seed=N] [--stratum=all|withu|nou] [--commit-every=N] [--fresh] [--dry-run]`);
  process.exit(1);
}

// ONE FILE PER STRATUM. The first version used a single fixed path, so a second
// stratum could only run by discarding the first stratum's result — 1,200 API
// calls thrown away to answer a different question. The parameter guard below
// still refuses to blend two different sample/seed values WITHIN a stratum.
const REPORT_REL  = `reports/measure-credited-coverage-${STRATUM}.json`;
const REPORT_FILE = path.join(ROOT, REPORT_REL);
// Written by the first version, before the path was keyed on stratum.
const LEGACY_REL  = 'reports/measure-credited-coverage.json';
const LEGACY_FILE = path.join(ROOT, LEGACY_REL);
let legacyAdopted = false;

// ─── Config, copied from fetch-profile-stats.js ──────────────────────────────

const API_URL     = 'https://api.playhq.com/graphql';
const BATCH_SIZE  = 30;     // fetch-profile-stats.js L1401 — do not raise
const BATCH_DELAY = 1000;   // fetch-profile-stats.js L1426

// Forfeit index — fetch-profile-stats.js L176-183, same file, same match.
const FORFEIT_FILE   = path.join(ROOT, 'data', 'forfeit-games.json');
const forfeitGameIds = new Set();
try {
  const ids = JSON.parse(fs.readFileSync(FORFEIT_FILE, 'utf8'));
  for (const id of (Array.isArray(ids) ? ids : [])) forfeitGameIds.add(id);
  console.log(`  Forfeit index loaded: ${forfeitGameIds.size} games`);
} catch (_) {
  console.log('  ⚠ Forfeit index could not be read — forfeit bucket will be empty and the residue OVERSTATED.');
}

// ─── Headers — full set, never split, never modified ─────────────────────────
// Verbatim from fetch-profile-stats.js L196-202.

const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── Session cookie ───────────────────────────────────────────────────────────
// Verbatim from fetch-profile-stats.js L204-287. Promise-locked so concurrent
// workers cannot trigger simultaneous refreshes; cleared in .finally() so a
// rejected promise can never be cached in the lock.

let sessionCookie  = null;
let sessionPromise = null;

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
  if (sessionPromise) return sessionPromise;

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
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    }
    throw new Error(`Failed to obtain session cookie after 10 attempts${lastErr ? ` (last network error: ${lastErr.code || lastErr.message})` : ''}`);
  })().finally(() => { sessionPromise = null; });

  return sessionPromise;
}

// ─── GraphQL query ────────────────────────────────────────────────────────────
// Verbatim from fetch-profile-stats.js L294-321. Not trimmed. A minimal version
// of a working query breaks silently and costs a dispatch.

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

// ─── The credited set ─────────────────────────────────────────────────────────
// This mirrors fetch-profile-stats.js L373-433 EXACTLY in the two respects that
// decide membership — the forfeit skip at L393 and the seenGameKeys dedup at
// L396/397 — and drops everything about stat values, which this script does not
// need. The traversal order and the null guards are otherwise unchanged, so a
// game counted here is a game counted there.
function creditedGameKeys(data) {
  const seasonStats = data?.publicProfileStatistics?.seasonStatistics;
  if (!seasonStats) return null;   // withheld — NOT the same as "credits nothing"

  const seenGameKeys = new Set();

  for (const season of seasonStats) {
    for (const reg of (season.statistics || [])) {
      const seasonId = reg?.season?.id;
      if (!seasonId) continue;
      for (const teamStat of (reg.teamStatistics || [])) {
        for (const gradeStat of (teamStat.gradeStatistics || [])) {
          for (const gameStat of (gradeStat.gameStatistics || [])) {
            const gameKey = gameStat.game?.id || null;
            if (!gameKey) continue;
            if (forfeitGameIds.has(gameKey)) continue;   // L393
            seenGameKeys.add(gameKey);                   // L396/397
          }
        }
      }
    }
  }
  return seenGameKeys;
}

// ─── API fetch ────────────────────────────────────────────────────────────────
// Verbatim from fetch-profile-stats.js L508-584, minus the write-side logging.
// The four outcomes are kept DISTINCT on purpose: a transport failure is not a
// dead profile, and a failure to ASK must never be recorded as an ANSWER.

let requestCount = 0;

async function fetchProfile(profileID) {
  if (!sessionCookie) await refreshSession();

  requestCount++;

  const body = { ...PROFILE_QUERY, variables: { profileID } };

  let res;
  try {
    res = await doFetch(API_URL, {
      method:  'POST',
      headers: {
        ...HEADERS_BASE,
        'request-id': crypto.randomUUID(),
        'Cookie':     sessionCookie,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { status: 'error', err };
  }

  if (res.status === 403) {
    let body403 = '';
    try { body403 = await res.text(); } catch { /* ignore */ }
    if (body403.includes('DOCTYPE') || body403.includes('Request blocked')) {
      const snippet = body403.replace(/\s+/g, ' ').trim().slice(0, 300);
      console.log(`  ⛔ CloudFront block (req#${requestCount}, uuid=${profileID}): ${snippet}`);
      return { status: 'cloudfront-block' };
    }
    return { status: 'private' };
  }

  if (res.status === 504) {
    await sleep(15000);
    try {
      res = await doFetch(API_URL, {
        method:  'POST',
        headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie },
        body:    JSON.stringify(body),
      });
    } catch (err) { return { status: 'error', err }; }
  }

  if (!res.ok) return { status: 'error', err: new Error(`HTTP ${res.status}`) };

  let json;
  try { json = await res.json(); }
  catch (err) { return { status: 'error', err }; }

  if (json.errors && json.errors.length > 0) {
    const msg = json.errors[0]?.message || '';
    if (msg.includes('NOT_FOUND') || msg.includes('failed to find profile')) {
      return { status: 'private' };
    }
    return { status: 'error', err: new Error(`GraphQL error: ${msg}`) };
  }

  const data = json.data || json;
  if (!data?.publicProfileStatistics) return { status: 'inaccessible' };

  return { status: 'ok', data };
}

// doFetch — verbatim from fetch-profile-stats.js L1280-1320. keepAlive:false
// forces a new TCP connection per request, which is what keeps CloudFront's
// per-connection rate limiting off us. Do not "optimise" it into an agent pool.
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── House git pattern ────────────────────────────────────────────────────────
// Copied from build-player-games.js L48-143. Per-path staging (git add is atomic
// across pathspecs, so one combined add that misses discards the valid paths
// beside it), commit BEFORE merge, --shortstat not --stat, merge -X ours with
// fetch never rebase, 60 attempts of pure random jitter, THROW when exhausted.
// Timeout and maxBuffer on every git call: execSync is synchronous and blocks
// the event loop, so nothing can time it out from the outside.

const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_MAXBUF     = 512 * 1024 * 1024;
const GIT_OPTS       = { cwd: ROOT, stdio: 'pipe', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF };
const PUSH_ATTEMPTS  = 60;

function gitCommit(message, paths) {
  if (DRY_RUN) return;

  let staged = 0;
  for (const p of paths) {
    try {
      execSync(`git add -- ${p}`, GIT_OPTS);
      staged++;
    } catch (e) {
      console.log(`  · not staged: ${p} — ${e.message.split('\n')[0]}`);
    }
  }
  if (!staged) {
    console.log(`  · nothing staged, skipping commit: ${message}`);
    return;
  }

  const diff = execSync('git diff --staged --shortstat', GIT_OPTS).toString().trim();
  if (!diff) {
    console.log(`  · no changes to commit: ${message}`);
    return;
  }
  console.log(`  staging: ${diff}`);

  execSync(`git commit -q -m "${message}"`, GIT_OPTS);

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try { execSync('git merge --abort', GIT_OPTS); } catch {}
    try {
      process.stdout.write(`  … fetch/merge/push (attempt ${attempt})\n`);
      execSync('git fetch origin main', GIT_OPTS);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT_OPTS);
      execSync('git push origin main', GIT_OPTS);
      console.log(`  ✔ ${message}${attempt > 1 ? ` (push attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      if (attempt === PUSH_ATTEMPTS) {
        throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${e.message.split('\n')[0]}`);
      }
      const wait = 1 + Math.floor(Math.random() * 91);
      console.log(`  … push attempt ${attempt} failed, retrying in ${wait}s`);
      try { execSync(`sleep ${wait}`, { stdio: 'pipe', timeout: (wait + 30) * 1000 }); } catch {}
    }
  }
}

// ─── Deterministic RNG ────────────────────────────────────────────────────────
// mulberry32. A fixed seed means the same sample is drawn on a resume, so a
// blocked run continues the SAME measurement instead of starting a new one that
// silently gets blended into the first one's totals.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Player file helpers ──────────────────────────────────────────────────────
// Shard is the uuid's own first two characters — this tool samples across all
// 256 shards, unlike fetch-profile-stats.js which is given one.

function playerPath(uuid) {
  return path.join(ROOT, 'players', uuid.slice(0, 2).toLowerCase(), `${uuid}.json`);
}

function readPlayerOrNull(uuid) {
  try { return JSON.parse(fs.readFileSync(playerPath(uuid), 'utf8')); }
  catch { return null; }
}

// `u` entries are "gid|sid|tid" — build-player-games.js L289.
function uGidSet(player) {
  const out = new Set();
  for (const e of (Array.isArray(player.u) ? player.u : [])) {
    const gid = String(e).split('|')[0];
    if (gid) out.add(gid);
  }
  return out;
}

// The seasons we hold at least one REGISTRATION for. Replicates the regSids
// construction in build-player-games.js L254-271, including its rule that a
// season entry with an empty regs[] does NOT count — those are the back-filled
// "they played here" entries, and treating them as registration evidence is the
// exact false accusation the season test exists to prevent.
function registeredSids(player) {
  const sids = new Set();
  for (const t of (Array.isArray(player.teams) ? player.teams : [])) {
    if (t?.sid) sids.add(t.sid);
  }
  for (const se of (Array.isArray(player.seasons) ? player.seasons : [])) {
    const regs = Array.isArray(se?.regs) ? se.regs : [];
    if (se?.sid && regs.some(r => r && r.tid)) sids.add(se.sid);
  }
  return sids;
}

// ─── Classification ───────────────────────────────────────────────────────────
// Pulled out as its own function so it can be exercised against a synthetic case
// matrix before delivery rather than reasoned about. Pure: no network, no disk.
//
// BUCKET ORDER IS THE WHOLE POINT AND IS NOT ARBITRARY.
//   forfeit first, because the credited side excludes them by construction
//     (fetch-profile-stats.js L393) — calling one a finding is calling the
//     filter a finding.
//   then inU, because that is the field whose coverage is being measured.
//   then notInGamesBv, because a game we no longer hold cannot be tested for
//     registration at all and would otherwise masquerade as one.
//   then noRegSeason, which is build-player-games.js's `unmeasurable` case:
//     we hold no registration for that season, so we cannot say the player was
//     unregistered, only that we do not know.
//   whatever is left is the residue.
function classifyPlayer(player, credited, gameSid, forfeitSet) {
  const captured = new Set(Array.isArray(player.games) ? player.games : []);
  const uGids    = uGidSet(player);
  const regSids  = registeredSids(player);

  let overlap = 0;
  const cnc = { forfeit: 0, inU: 0, notInGamesBv: 0, noRegSeason: 0, residue: 0 };
  const cnp = { gameAbsent: 0, gameHeld: 0 };
  const examples = { forfeit: [], inU: [], notInGamesBv: [], noRegSeason: [], residue: [], gameAbsent: [], gameHeld: [], uCredited: [] };
  const addEx = (k, gid) => { if (examples[k].length < 3) examples[k].push(gid); };

  // ── THE `u` PARTITION ─────────────────────────────────────────────────────
  // Computed INDEPENDENTLY of the exclusive buckets above, and it has to be.
  // A `u` game that PlayHQ credits lands in `overlap` and a `u` game that is
  // also a forfeit lands in `forfeit`, so neither is visible in the inU bucket.
  // inU therefore has no denominator and cannot answer the question.
  //
  // The question is: `u` is presented in StatTrack as an appearance for a team
  // the player never registered with. If PlayHQ credits those games anyway,
  // then PlayHQ holds a registration we do not, and the field is measuring a
  // gap in OUR capture rather than unregistered play.
  //
  // Forfeits are separated first because the credited side excludes them by
  // construction (fetch-profile-stats.js L393) — leaving them in would push the
  // rate toward "not credited" for a reason that has nothing to do with
  // registrations. The rate that matters is uCredited / (uCredited + uNotCredited).
  const u = { total: 0, credited: 0, notCredited: 0, forfeit: 0, notCaptured: 0 };
  for (const gid of uGids) {
    u.total++;
    if (!captured.has(gid)) u.notCaptured++;   // u is built FROM games[], so this should be 0
    if (forfeitSet.has(gid)) { u.forfeit++; continue; }
    if (credited.has(gid))   { u.credited++; addEx('uCredited', gid); }
    else                     { u.notCredited++; }
  }

  for (const gid of captured) {
    if (credited.has(gid)) { overlap++; continue; }
    if (forfeitSet.has(gid))  { cnc.forfeit++;      addEx('forfeit', gid);      continue; }
    if (uGids.has(gid))       { cnc.inU++;          addEx('inU', gid);          continue; }
    const sid = gameSid.get(gid);
    if (!sid)                 { cnc.notInGamesBv++; addEx('notInGamesBv', gid); continue; }
    if (!regSids.has(sid))    { cnc.noRegSeason++;  addEx('noRegSeason', gid);  continue; }
    cnc.residue++; addEx('residue', gid);
  }

  for (const gid of credited) {
    if (captured.has(gid)) continue;
    if (!gameSid.has(gid)) { cnp.gameAbsent++; addEx('gameAbsent', gid); }
    else                   { cnp.gameHeld++;   addEx('gameHeld', gid); }
  }

  const anyCaptured = captured.values().next();
  const anyCredited = credited.values().next();

  return {
    firstCaptured: anyCaptured.done ? null : anyCaptured.value,
    firstCredited: anyCredited.done ? null : anyCredited.value,
    record: {
      outcome:  'compared',
      captured: captured.size,
      credited: credited.size,
      overlap,
      capturedNotCredited: cnc,
      creditedNotCaptured: cnp,
      u,
      examples,
    },
  };
}

// ─── Progress / report file ───────────────────────────────────────────────────
// THE MEASUREMENT LIVES IN THE PROGRESS FILE, NOT BESIDE IT. The rollup is
// recomputed from `players` at every commit window rather than accumulated in
// memory, so a timeout costs the run's log and never the measurement, and there
// is no second file that can disagree with the first.

function loadReport() {
  if (FRESH) return null;
  try { return JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')); }
  catch { /* fall through to the legacy path */ }
  // One-time migration: adopt the unsuffixed file if it belongs to this stratum.
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
    if (legacy && legacy.stratum === STRATUM) {
      console.log(`  Adopting ${LEGACY_REL} (stratum=${STRATUM}) into ${REPORT_REL}`);
      legacyAdopted = true;
      return legacy;
    }
  } catch { /* no legacy file, or it belongs to another stratum — leave it alone */ }
  return null;
}

function saveReport(report) {
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report), 'utf8');
}

// Paths for gitCommit. On the run that adopts the legacy file, its deletion is
// staged in the SAME commit as the new file, so the two can never both exist
// and disagree about what the measurement says.
function commitPaths() {
  // NOT during a dry run. Deleting the legacy file without committing the
  // deletion would remove a real measurement from the worktree on a run that
  // promised to change nothing.
  if (!DRY_RUN && legacyAdopted && fs.existsSync(LEGACY_FILE)) {
    try { fs.unlinkSync(LEGACY_FILE); } catch { /* already gone */ }
    return [REPORT_REL, LEGACY_REL];
  }
  return [REPORT_REL];
}

// ─── Rollup ───────────────────────────────────────────────────────────────────
// Every bucket carries EXAMPLES beside its count. A counter without examples is
// a number that cannot be checked.

const EXAMPLE_CAP = 20;

function rollup(report) {
  const r = {
    playersRecorded:   0,
    playersCompared:   0,   // an 'ok' fetch with both sides present
    playersWithheld:   0,   // private / inaccessible / already flagged private
    playersNoCaptured: 0,   // ok fetch, but player.games is empty or absent
    capturedTotal:     0,
    creditedTotal:     0,
    overlapTotal:      0,
    capturedNotCredited: { total: 0, forfeit: 0, inU: 0, notInGamesBv: 0, noRegSeason: 0, residue: 0 },
    creditedNotCaptured: { total: 0, gameAbsent: 0, gameHeld: 0 },
    examples: { forfeit: [], inU: [], notInGamesBv: [], noRegSeason: [], residue: [], gameAbsent: [], gameHeld: [], uCredited: [] },
    playersWithResidue: 0,
    // uRecorded is denominated on records that actually CARRY the u partition.
    // Reports written before it existed have none, and reporting a rate over a
    // population that was never measured is how a blank becomes a zero.
    uRecorded: 0, playersWithU: 0,
    u: { total: 0, credited: 0, notCredited: 0, forfeit: 0, notCaptured: 0 },
  };

  for (const [uuid, p] of Object.entries(report.players || {})) {
    r.playersRecorded++;
    if (p.outcome === 'withheld') { r.playersWithheld++; continue; }
    if (p.outcome !== 'compared') continue;
    if (!p.captured) { r.playersNoCaptured++; }
    r.playersCompared++;
    r.capturedTotal += p.captured || 0;
    r.creditedTotal += p.credited || 0;
    r.overlapTotal  += p.overlap  || 0;

    const cnc = p.capturedNotCredited || {};
    r.capturedNotCredited.forfeit      += cnc.forfeit      || 0;
    r.capturedNotCredited.inU          += cnc.inU          || 0;
    r.capturedNotCredited.notInGamesBv += cnc.notInGamesBv || 0;
    r.capturedNotCredited.noRegSeason  += cnc.noRegSeason  || 0;
    r.capturedNotCredited.residue      += cnc.residue      || 0;

    const cnp = p.creditedNotCaptured || {};
    r.creditedNotCaptured.gameAbsent += cnp.gameAbsent || 0;
    r.creditedNotCaptured.gameHeld   += cnp.gameHeld   || 0;

    if ((cnc.residue || 0) > 0) r.playersWithResidue++;

    if (p.u && typeof p.u === 'object') {
      r.uRecorded++;
      if ((p.u.total || 0) > 0) r.playersWithU++;
      r.u.total       += p.u.total       || 0;
      r.u.credited    += p.u.credited    || 0;
      r.u.notCredited += p.u.notCredited || 0;
      r.u.forfeit     += p.u.forfeit     || 0;
      r.u.notCaptured += p.u.notCaptured || 0;
    }

    for (const key of Object.keys(r.examples)) {
      const ex = (p.examples && p.examples[key]) || [];
      for (const gid of ex) {
        if (r.examples[key].length < EXAMPLE_CAP) r.examples[key].push(`${uuid.slice(0, 8)}:${gid}`);
      }
    }
  }

  r.capturedNotCredited.total =
    r.capturedNotCredited.forfeit + r.capturedNotCredited.inU +
    r.capturedNotCredited.notInGamesBv + r.capturedNotCredited.noRegSeason +
    r.capturedNotCredited.residue;
  r.creditedNotCaptured.total =
    r.creditedNotCaptured.gameAbsent + r.creditedNotCaptured.gameHeld;

  return r;
}

function pct(n, d) { return d > 0 ? `${((n / d) * 100).toFixed(2)}%` : '—'; }

function printRollup(r) {
  console.log('\n─── Rollup (recomputed from the report file) ─────────────────────────');
  console.log(`  Players recorded        : ${r.playersRecorded.toLocaleString()}`);
  console.log(`    compared              : ${r.playersCompared.toLocaleString()}`);
  console.log(`    withheld (no answer)  : ${r.playersWithheld.toLocaleString()}`);
  console.log(`    ok but no games[]     : ${r.playersNoCaptured.toLocaleString()}`);
  console.log(`  Captured appearances    : ${r.capturedTotal.toLocaleString()}`);
  console.log(`  Credited appearances    : ${r.creditedTotal.toLocaleString()}`);
  console.log(`  In both                 : ${r.overlapTotal.toLocaleString()}`);

  const c = r.capturedNotCredited;
  console.log(`\n  CAPTURED BUT NOT CREDITED : ${c.total.toLocaleString()}`);
  console.log(`    forfeit (filter artefact) : ${c.forfeit.toLocaleString()}  ${pct(c.forfeit, c.total)}`);
  console.log(`    already in u              : ${c.inU.toLocaleString()}  ${pct(c.inU, c.total)}`);
  console.log(`    not in games/bv (stale)   : ${c.notInGamesBv.toLocaleString()}  ${pct(c.notInGamesBv, c.total)}`);
  console.log(`    no registration season    : ${c.noRegSeason.toLocaleString()}  ${pct(c.noRegSeason, c.total)}`);
  console.log(`    RESIDUE                   : ${c.residue.toLocaleString()}  ${pct(c.residue, c.total)}   ◄ only a new array would surface this`);
  console.log(`    players with any residue  : ${r.playersWithResidue.toLocaleString()} of ${r.playersCompared.toLocaleString()}`);

  const n = r.creditedNotCaptured;
  console.log(`\n  CREDITED BUT NOT CAPTURED : ${n.total.toLocaleString()}   (nothing offline can answer this today)`);
  console.log(`    game absent from games/bv : ${n.gameAbsent.toLocaleString()}  ${pct(n.gameAbsent, n.total)}`);
  console.log(`    game held, not attributed : ${n.gameHeld.toLocaleString()}  ${pct(n.gameHeld, n.total)}`);

  const U = r.u;
  const uTestable = U.credited + U.notCredited;
  console.log(`\n  \u0060u\u0060 SEMANTICS CHECK`);
  if (r.uRecorded === 0) {
    console.log('    no records carry the u partition — this report predates it, re-run with --fresh');
  } else {
    console.log(`    players carrying a u array : ${r.playersWithU.toLocaleString()} of ${r.uRecorded.toLocaleString()} measured`);
    console.log(`    u appearances              : ${U.total.toLocaleString()}`);
    console.log(`      forfeit (untestable)     : ${U.forfeit.toLocaleString()}`);
    console.log(`      CREDITED by PlayHQ       : ${U.credited.toLocaleString()}  ${pct(U.credited, uTestable)}   \u25c4 PlayHQ holds a registration we do not`);
    console.log(`      not credited             : ${U.notCredited.toLocaleString()}  ${pct(U.notCredited, uTestable)}   \u25c4 genuinely unregistered play`);
    if (U.notCaptured > 0) {
      console.log(`      \u26a0 in u but NOT in games[] : ${U.notCaptured.toLocaleString()} — u is built FROM games[], so this should be zero`);
    }
  }

  console.log('\n  Examples (uuid8:gid), capped:');
  for (const [k, v] of Object.entries(r.examples)) {
    console.log(`    ${k.padEnd(12)}: ${v.length ? v.join(' ') : '—'}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nmeasure-credited-coverage  sample=${SAMPLE}  stratum=${STRATUM}  seed=${SEED}  fresh=${FRESH}  dry-run=${DRY_RUN}`);
  console.log('─'.repeat(70));

  // ── Phase 1: game id → season id, from games/bv ────────────────────────────
  // Needed for two buckets: the noRegSeason test, and telling gameAbsent from
  // gameHeld. Same scan shape as build-player-games.js phase 1 but it keeps only
  // the sid, so it is a fraction of that script's memory.
  console.log('\n── Phase 1: scanning games/bv for game → season ──────────────────────');
  const gamesDir = path.join(ROOT, 'games', 'bv');
  const gameSid  = new Map();
  let seasonFiles = 0, gamesSeen = 0;
  for (const fname of fs.readdirSync(gamesDir).filter(f => f.endsWith('.json'))) {
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(gamesDir, fname), 'utf8')); } catch { continue; }
    seasonFiles++;
    const sid = fname.replace(/\.json$/, '');
    for (const gameId of Object.keys(gf.games ?? {})) {
      gameSid.set(gameId, sid);
      gamesSeen++;
    }
  }
  console.log(`  ${seasonFiles} season files | ${gamesSeen.toLocaleString()} games indexed`);
  if (gamesSeen === 0) {
    console.error('  FATAL: games/bv produced no games. Checkout is incomplete — refusing to measure.');
    process.exit(1);
  }

  // ── Load or start the report ────────────────────────────────────────────────
  let report = loadReport();
  if (report && (report.sample !== SAMPLE || report.seed !== SEED || report.stratum !== STRATUM)) {
    console.log(`  ⚠ Existing report was built with sample=${report.sample} seed=${report.seed} stratum=${report.stratum}.`);
    console.log('    Those parameters select a DIFFERENT population, and blending two populations');
    console.log('    into one number is how a measurement becomes meaningless. Re-run with --fresh,');
    console.log('    or with the original parameters to continue it.');
    process.exit(1);
  }
  if (!report) {
    report = { sample: SAMPLE, seed: SEED, stratum: STRATUM, startedAt: new Date().toISOString(), players: {} };
  }
  const alreadyDone = new Set(Object.keys(report.players));
  console.log(`  Already recorded from a previous run: ${alreadyDone.size.toLocaleString()}`);

  // ── Build the candidate pool from the index shards ──────────────────────────
  console.log('\n── Phase 2: drawing the sample ───────────────────────────────────────');
  const idxDir = path.join(ROOT, 'players', 'indexes');
  const allUuids = [];
  for (const fname of fs.readdirSync(idxDir).filter(f => /^[0-9a-f]{2}\.json$/.test(f))) {
    let idx;
    try { idx = JSON.parse(fs.readFileSync(path.join(idxDir, fname), 'utf8')); } catch { continue; }
    for (const uuid of Object.keys(idx)) allUuids.push(uuid);
  }
  console.log(`  Index population: ${allUuids.length.toLocaleString()}`);
  if (allUuids.length === 0) {
    console.error('  FATAL: players/indexes produced no uuids. Refusing to measure.');
    process.exit(1);
  }

  // Fisher-Yates over a seeded RNG, consumed lazily so the stratum filter only
  // opens the files it needs rather than all 411k.
  const rng = mulberry32(SEED);
  const order = allUuids.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const selected = [];
  const cache    = new Map();   // uuid -> player object, reused in the fetch loop
  let scanned = 0, skippedUnreadable = 0, skippedStratum = 0, skippedPrivate = 0;
  for (const uuid of order) {
    if (selected.length >= SAMPLE) break;
    scanned++;
    const player = readPlayerOrNull(uuid);
    if (!player) { skippedUnreadable++; continue; }

    // Already flagged private: PlayHQ withholds them by construction, so a fetch
    // buys nothing but a call. Counted, not fetched, and reported separately so
    // the exclusion is visible rather than silent.
    if (player.private === true) { skippedPrivate++; continue; }

    const hasU = Array.isArray(player.u) && player.u.length > 0;
    if (STRATUM === 'withu' && !hasU) { skippedStratum++; continue; }
    if (STRATUM === 'nou'   &&  hasU) { skippedStratum++; continue; }

    selected.push(uuid);
    cache.set(uuid, player);
  }
  console.log(`  Scanned ${scanned.toLocaleString()} to select ${selected.length.toLocaleString()}`);
  console.log(`    unreadable: ${skippedUnreadable.toLocaleString()} | already private: ${skippedPrivate.toLocaleString()} | wrong stratum: ${skippedStratum.toLocaleString()}`);

  const toFetch = selected.filter(u => !alreadyDone.has(u));
  console.log(`  To fetch this run: ${toFetch.length.toLocaleString()}`);

  if (toFetch.length === 0) {
    console.log('\n  Nothing left to fetch — printing the rollup from the stored report.');
    // Persist even here. Without this, a migration adopted above is discarded
    // and the legacy file is left as the only copy — the run would announce a
    // move it never made.
    report.updatedAt = new Date().toISOString();
    report.rollup    = rollup(report);
    saveReport(report);
    gitCommit(`measure-credited-coverage[${STRATUM}]: ${Object.keys(report.players).length} players recorded (no new fetches)`, commitPaths());
    printRollup(report.rollup);
    return;
  }

  // ── Phase 3: fetch and classify ────────────────────────────────────────────
  console.log('\n── Phase 3: fetching PlayHQ ──────────────────────────────────────────');
  console.log('  Obtaining session…');
  try {
    await refreshSession();
  } catch (err) {
    console.error(`  FATAL: could not obtain session — ${err.message}`);
    process.exit(1);
  }

  let blocked = false, errors = 0, sinceCommit = 0, fetched = 0;
  // The id-form guard: overlap across the first completed batch. Zero overlap
  // means the two id spaces do not match and every number below is an artefact.
  let firstBatchChecked = false;
  let sampleCapturedId = null, sampleCreditedId = null;

  for (let start = 0; start < toFetch.length && !blocked; start += BATCH_SIZE) {
    if (start > 0) {
      console.log(`  ↺ Session refresh before batch ${(start / BATCH_SIZE) + 1}`);
      await refreshSession();
    }
    const batch = toFetch.slice(start, Math.min(start + BATCH_SIZE, toFetch.length));

    const results = await Promise.allSettled(batch.map(async (uuid) => {
      const player = cache.get(uuid) || readPlayerOrNull(uuid);
      if (!player) return { uuid, status: 'unreadable' };

      // Same id the live script queries with — fetch-profile-stats.js L972.
      const queryId = player.apiId || uuid;
      const res = await fetchProfile(queryId);

      if (res.status === 'cloudfront-block') return { uuid, status: 'cloudfront-block' };
      if (res.status === 'error') return { uuid, status: 'error', msg: res.err?.message };

      if (res.status === 'private' || res.status === 'inaccessible') {
        return { uuid, status: 'ok', record: { outcome: 'withheld', reason: res.status } };
      }

      const credited = creditedGameKeys(res.data);
      if (!credited) return { uuid, status: 'ok', record: { outcome: 'withheld', reason: 'null-stats' } };

      const c = classifyPlayer(player, credited, gameSid, forfeitGameIds);
      return { uuid, status: 'ok', ...c };
    }));

    for (const r of results) {
      if (r.status !== 'fulfilled') { errors++; continue; }
      const v = r.value;
      if (v.status === 'cloudfront-block') { blocked = true; continue; }
      if (v.status === 'error' || v.status === 'unreadable') { errors++; continue; }
      report.players[v.uuid] = v.record;
      fetched++; sinceCommit++;
      if (!sampleCapturedId && v.firstCaptured) sampleCapturedId = v.firstCaptured;
      if (!sampleCreditedId && v.firstCredited) sampleCreditedId = v.firstCredited;
    }

    if (blocked) {
      console.log(`\n  ⛔ CloudFront block — stopping cleanly. ${fetched} players recorded this run.`);
      console.log('     Re-dispatch to continue the SAME sample; recorded players are never re-fetched.');
    }

    // ── THE ID-FORM GUARD ────────────────────────────────────────────────────
    if (!firstBatchChecked && fetched > 0) {
      firstBatchChecked = true;
      const r0 = rollup(report);
      if (r0.playersCompared > 0 && r0.overlapTotal === 0 && r0.capturedTotal > 0 && r0.creditedTotal > 0) {
        console.error('\n  ⛔ ABORTING — ZERO overlap between captured and credited across the first batch.');
        console.error('     That is not a finding about the data. It means player.games and the API\'s');
        console.error('     game.id are not the same string space, so this comparison — and gameTids,');
        console.error('     records.gameKey and the forfeit filter — are all keyed differently.');
        console.error(`     example captured id : ${sampleCapturedId} (length ${sampleCapturedId ? sampleCapturedId.length : 0})`);
        console.error(`     example credited id : ${sampleCreditedId} (length ${sampleCreditedId ? sampleCreditedId.length : 0})`);
        console.error('     Settle the id form before running this again.');
        saveReport(report);
        gitCommit(`measure-credited-coverage[${STRATUM}]: aborted on id-form mismatch`, commitPaths());
        process.exit(1);
      }
      console.log(`  ✔ id-form check passed — ${r0.overlapTotal.toLocaleString()} games in common across the first batch`);
    }

    if (sinceCommit >= COMMIT_EVERY || blocked) {
      report.updatedAt = new Date().toISOString();
      report.rollup = rollup(report);
      saveReport(report);
      gitCommit(`measure-credited-coverage[${STRATUM}]: ${Object.keys(report.players).length} players recorded`, commitPaths());
      sinceCommit = 0;
    }

    if (!blocked && start + BATCH_SIZE < toFetch.length) await sleep(BATCH_DELAY);
  }

  report.updatedAt  = new Date().toISOString();
  report.finishedAt = blocked ? null : new Date().toISOString();
  report.rollup     = rollup(report);
  saveReport(report);
  gitCommit(`measure-credited-coverage[${STRATUM}]: ${Object.keys(report.players).length} players recorded${blocked ? ' (blocked)' : ' (complete)'}`, commitPaths());

  console.log('\n─'.repeat(70));
  console.log(`  Fetched this run : ${fetched.toLocaleString()}`);
  console.log(`  Errors           : ${errors.toLocaleString()}  (not recorded — a failure to ask is not an answer)`);
  console.log(`  Blocked          : ${blocked}`);
  printRollup(report.rollup);
  console.log(`\n  Report: ${REPORT_REL}`);
}

// Guarded so the pure helpers above can be required by a test harness without
// firing a run. Directive 17: prove the classification by EXECUTION against a
// synthetic case matrix before delivery, not by reading it back.
if (require.main === module) {
  main().catch(err => {
    console.error(`FATAL: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { classifyPlayer, uGidSet, registeredSids, rollup, creditedGameKeys };
