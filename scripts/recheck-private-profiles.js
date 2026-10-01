// scripts/recheck-private-profiles.js
//
// Re-checks players previously marked as private/inaccessible.
// Identified by: player.private === true (explicit flag, added 2026-07-10)
// OR the legacy signal (statsChecked present AND maxGamePTS === null), for
// players written before the flag existed. Both are checked — the OR keeps
// this script working on the existing population without needing a one-off
// migration pass over 370k+ files just to backfill the flag retroactively.
//
// If now accessible: writes full stats (foulOuts, maxGamePTS, maxGameThreePt,
//                    records, statsChecked) — same as fetch-profile-stats.js.
//                    Also writes private: false, and replaces a placeholder
//                    `Player #...` name with the real one now that the
//                    profile is confirmed public (see wasPrivate below —
//                    without it, a private stub going public would keep its
//                    placeholder name forever, since name is otherwise only
//                    ever written when previously absent. wasPrivate also
//                    falls back to the legacy signal so a legacy-private
//                    player going public gets the reveal on the very FIRST
//                    check after this flag was introduced, not one cycle
//                    later).
// If still inaccessible: updates statsChecked timestamp and sets
//                        private: true, so we know when it was last
//                        confirmed private. Name is left untouched — if a
//                        real name is already on file from before the
//                        profile went private, we keep showing it.
//
// Run monthly. Safe to re-run — only touches private-marked players.
//
// Usage:
//   node scripts/recheck-private-profiles.js
//   node scripts/recheck-private-profiles.js --dry-run
//   node scripts/recheck-private-profiles.js --shard=06   # single shard

'use strict';

const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT  = path.join(__dirname, '..');
const ARGS  = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const DRY_RUN     = !!ARGS['dry-run'];
const SHARD_FILTER = ARGS.shard || null;

const PLAYERS_DIR   = path.join(ROOT, 'players');
const REQUEST_DELAY = 800;
const REFRESH_EVERY = 28;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP / session ───────────────────────────────────────────────────────────

const HEADERS_BASE = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

// ⚠️ 2026-09-29 — REWRITTEN FROM https.request TO fetch(). THIRD INSTANCE OF THIS
// FAULT; see nightly-crawl.js and discover-org-seasons.js for the full evidence.
//
// Short version: a PlayHQ 403 that survives correct headers, a correct query and a
// known-good runner is about the HTTP CLIENT. https.request with a hand-set
// content-length is refused by the CloudFront WAF; fetch() is not. Proven in two
// steps on nightly-crawl: switching only its session bootstrap to fetch() obtained a
// cookie on attempt 1, and every REAL call through https.request still came back
// blocked. Same class as the standing rule that actions/setup-node must never appear
// in a job fetching api.playhq.com — that is about the runtime's outbound
// fingerprint; this is the same idea one level down, in the client library.
//
// ⚠️ DO NOT PUT https.request BACK AND DO NOT SET content-length BY HAND.
//
// THE CONTRACT IS UNCHANGED, INCLUDING ITS SHARP EDGE. This function REJECTS when the
// body will not parse as JSON, and callers rely on that. It is also why the 403s were
// invisible here: a CloudFront HTML page became a JSON syntax error with no status
// attached, so ten attempts printed nothing and the run died on the FATAL alone. The
// rejection is kept, but the error now carries `.status` and `.rawText` so the next
// failure says what came back.
async function doFetch(bodyObj, extraHeaders) {
  const res = await fetch('https://api.playhq.com/graphql', {
    method:  'POST',
    headers: { ...HEADERS_BASE, ...extraHeaders, 'request-id': crypto.randomUUID() },
    body:    JSON.stringify(bodyObj),
  });
  const rawText = await res.text().catch(() => '');
  // undici exposes each Set-Cookie separately; the joined header is the fallback for
  // older runtimes. Callers expect an array or undefined, never an empty array.
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  let body;
  try { body = JSON.parse(rawText); }
  catch (e) {
    const blocked = /cloudfront|Request blocked|ERROR: The request could not be satisfied/i.test(rawText);
    const err = new Error(`HTTP ${res.status}, body did not parse${blocked ? ' — CLOUDFRONT-BLOCK (' + rawText.length + 'b HTML)' : ''}`);
    err.status = res.status;
    err.rawText = rawText;
    throw err;
  }
  return { status: res.status, rawCookies: cookies.length ? cookies : undefined, body };
}

let sessionCookie = null;
async function refreshSession() {
  const body = { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const { rawCookies } = await doFetch(body, {});
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

// ─── Query ────────────────────────────────────────────────────────────────────

const PROFILE_QUERY = `query ProfileSeasonStatistics($profileID: ID!) {
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
}`;

function statValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const m = statistics.find(s => s?.details?.value === typeValue);
  return m ? (m.count || 0) : 0;
}

function parseProfileStats(data) {
  const seasonStats = data?.publicProfileStatistics?.seasonStatistics;
  if (!seasonStats) return null;

  const playerName       = seasonStats[0]?.name || null;
  const foulOuts         = {};
  let maxGamePTS         = null, maxGamePTSKey    = null;
  let maxGameThreePt     = null, maxGameThreePtKey = null;

  for (const season of seasonStats) {
    for (const reg of (season.statistics || [])) {
      const sid = reg?.season?.id;
      if (!sid) continue;
      for (const teamStat of (reg.teamStatistics || [])) {
        for (const gradeStat of (teamStat.gradeStatistics || [])) {
          for (const gameStat of (gradeStat.gameStatistics || [])) {
            const gameKey = gameStat.game?.id || null;
            const stats   = gameStat.statistics || [];
            const fouls   = statValue(stats, 'TOTAL_FOULS');
            const pts     = statValue(stats, 'TOTAL_SCORE');
            const three   = statValue(stats, '3_POINT_SCORE');

            if (fouls >= 5) foulOuts[sid] = (foulOuts[sid] || 0) + 1;
            if (pts > (maxGamePTS ?? 0)) {
              maxGamePTS    = pts;
              maxGamePTSKey = gameKey ? { gameKey, sid } : null;
            }
            if (three > (maxGameThreePt ?? 0)) {
              maxGameThreePt    = three;
              maxGameThreePtKey = gameKey ? { gameKey, sid } : null;
            }
          }
        }
      }
    }
  }

  return { playerName, foulOuts, maxGamePTS, maxGamePTSKey, maxGameThreePt, maxGameThreePtKey };
}

// ─── Git commit ───────────────────────────────────────────────────────────────

// ─── git ──────────────────────────────────────────────────────────────────────
// REWRITTEN 2026-09-01 to the house pattern. Four things were wrong:
//
//   --stat, not --shortstat. On a large recheck this can exceed execSync's
//     default 1 MB buffer and throw ENOBUFS, which the catch swallowed into
//     staged='' — a run that had written files would then decide it had nothing
//     to commit and exit clean.
//   No timeout or maxBuffer on any git call. execSync blocks the event loop, so
//     nothing outside can time it out; a hung git hangs the job to its limit.
//   Push exhaustion printed to stderr and RETURNED. The run then completed
//     normally and the job showed green with the work sitting uncommitted on a
//     destroyed runner. A lost commit must show red.
//   Commit failure was swallowed the same way.
//
// 10 attempts also raised to 60 with pure random jitter, matching the other
// writers that share this branch.
const GIT_OPTS      = { stdio: 'pipe', cwd: ROOT, timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const PUSH_ATTEMPTS = 60;

async function gitCommit(message) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }

  execSync('git add -- players/', GIT_OPTS);

  const staged = execSync('git diff --staged --shortstat', GIT_OPTS).toString().trim();
  if (!staged) { console.log('  Nothing to commit — the run changed no files.'); return; }
  console.log(`  staging: ${staged}`);

  execSync(`git commit -q -m "${message.replace(/"/g, "'")}"`, GIT_OPTS);

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try { execSync('git merge --abort', GIT_OPTS); } catch (_) {}
    try {
      execSync('git fetch origin main', GIT_OPTS);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT_OPTS);
      execSync('git push origin main', GIT_OPTS);
      console.log(`  ✓ ${message}${attempt > 1 ? ` (push attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      if (attempt === PUSH_ATTEMPTS) {
        throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${e.message.split('\n')[0]}`);
      }
      await sleep((1 + Math.floor(Math.random() * 91)) * 1000);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log('recheck-private-profiles.js');
  if (DRY_RUN)      console.log('  ⚠  DRY RUN');
  if (SHARD_FILTER) console.log(`  Shard filter: ${SHARD_FILTER}`);
  console.log('─'.repeat(50));

  // Load active season IDs for staleness check
  const INDEX_FILE  = path.join(ROOT, 'data', 'sports-index.json');
  const activeSids  = new Set();
  if (fs.existsSync(INDEX_FILE)) {
    const idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    for (const s of Object.values(idx.seasons || {})) {
      if (s.locked === false) activeSids.add(s.id);
    }
  }

  const now          = Date.now();
  const PRIVATE_DAYS = 30;   // recheck private-marked players monthly
  const ACTIVE_DAYS  = 7;    // recheck active-season players weekly — ensures foulOuts currency

  // Two categories:
  //   A — private-marked: statsChecked present AND maxGamePTS === null, older than PRIVATE_DAYS
  //   B — active-stale:   has real stats (maxGamePTS > 0), playing in active season,
  //                       statsChecked older than ACTIVE_DAYS
  //       Catches players who were previously fetchable but later went private mid-season.
  console.log('Scanning player files…');
  console.log(`  Private-marked threshold: ${PRIVATE_DAYS} days`);
  console.log(`  Active-season threshold:  ${ACTIVE_DAYS} days`);
  const toRecheck = [];
  let countA = 0, countB = 0, skippedPendingFold = 0, skippedNoUuid = 0;

  const shardDirs = fs.readdirSync(PLAYERS_DIR)
    .filter(d => /^[0-9a-f]{2}$/.test(d))
    .filter(d => !SHARD_FILTER || d === SHARD_FILTER)
    .sort();

  for (const shard of shardDirs) {
    const shardDir = path.join(PLAYERS_DIR, shard);
    const files    = fs.readdirSync(shardDir).filter(f => f.endsWith('.json'));
    for (const fname of files) {
      let player;
      try { player = JSON.parse(fs.readFileSync(path.join(shardDir, fname), 'utf8')); }
      catch (_) { continue; }
      const bk = player.sports?.Basketball;
      if (!bk?.statsChecked) continue;

      // ── PENDING FOLD ────────────────────────────────────────────────────────
      // A file carrying apiId is wrongly keyed and waiting for
      // fold-diverged-players.js. Its own uuid is a SPECTATOR id, and the query
      // below sends the file's uuid — so PlayHQ returns NOT_FOUND, and the
      // handler below writes private:true with a fresh statsChecked. That is not
      // a finding about the player, it is the wrong question producing an answer
      // that then gets stored as fact. It is the same mechanism that manufactured
      // the private stubs this campaign has spent the day undoing.
      //
      // On 2026-09-01 there were 541 such files sitting between the seeder and the
      // fold. Skipping them costs nothing: the fold rekeys them within the day and
      // the next pass sees them correctly keyed.
      if (player.apiId) { skippedPendingFold++; continue; }

      // profileID: undefined is a GraphQL error, and the handler below records an
      // error as "still inaccessible". A file with no uuid must not be able to
      // write private:true about itself.
      if (!player.uuid) { skippedNoUuid++; continue; }

      const checkedAge = (now - new Date(bk.statsChecked).getTime()) / (1000 * 60 * 60 * 24);

      // Category A: private-marked, monthly recheck.
      // The legacy maxGamePTS === null signal now applies ONLY where the explicit
      // flag is absent. It was written for files predating the flag, but as an OR
      // it also swept in every public player who has simply never appeared in a
      // box score — private:false and still rechecked monthly as private.
      const legacyPrivate = player.private === undefined && bk.maxGamePTS === null;
      if ((player.private === true || legacyPrivate) && checkedAge >= PRIVATE_DAYS) {
        toRecheck.push({ uuid: player.uuid, shard, fname, category: 'A' });
        countA++;
        continue;
      }

      // Category B: was fetchable, in active season, quarterly recheck
      if (bk.maxGamePTS !== null && checkedAge >= ACTIVE_DAYS) {
        const hasActiveSeason = (player.seasons || []).some(s => activeSids.has(s.sid));
        if (hasActiveSeason) {
          toRecheck.push({ uuid: player.uuid, shard, fname, category: 'B' });
          countB++;
        }
      }
    }
  }

  console.log(`  Skipped, pending fold (carry apiId): ${skippedPendingFold}`);
  console.log(`  Skipped, no uuid field:              ${skippedNoUuid}`);
  console.log(`  Category A (private-marked, >${PRIVATE_DAYS}d old): ${countA}`);
  console.log(`  Category B (active-season,  >${ACTIVE_DAYS}d old):  ${countB}`);
  console.log(`  Total to recheck: ${toRecheck.length}`);
  if (toRecheck.length === 0) { console.log('  Nothing to recheck.'); return; }
  console.log();

  await refreshSession();

  let requestCount = 0;
  let recovered = 0, stillPrivate = 0, errors = 0, notFound = 0;

  for (let i = 0; i < toRecheck.length; i++) {
    const { uuid, shard, fname } = toRecheck[i];
    const short = uuid.slice(0, 8);
    let queryId = uuid;
    try {
      const pre = JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, shard, fname), 'utf8'));
      if (pre.apiId) queryId = pre.apiId;
    } catch (_) { /* re-read failure is not fatal; uuid is the correct default */ }

    if (requestCount > 0 && requestCount % REFRESH_EVERY === 0) {
      console.log(`  ↺ Session refresh at request ${requestCount}`);
      await refreshSession();
    }
    requestCount++;

    let res;
    try {
      // Same id fetch-profile-stats.js queries with (L972). The scan above already
      // skips apiId-bearing files, so this is the second line of defence rather
      // than the first — but a wrong-namespace query here does not fail loudly, it
      // writes private:true, so one guard is not enough.
      res = await doFetch(
        { operationName: 'ProfileSeasonStatistics',
          variables: { profileID: queryId }, query: PROFILE_QUERY },
        { 'Cookie': sessionCookie }
      );
    } catch (e) {
      errors++;
      await sleep(REQUEST_DELAY);
      continue;
    }

    if (res.status === 403) {
      const body = JSON.stringify(res.body || '');
      if (body.includes('DOCTYPE') || body.includes('Request blocked')) {
        console.log(`  ⛔ CloudFront block at request ${requestCount} — stopping`);
        break;
      }
      // Still private — update statsChecked timestamp
      stillPrivate++;
      if (!DRY_RUN) {
        const playerFile = path.join(PLAYERS_DIR, shard, fname);
        const player     = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
        player.sports.Basketball.statsChecked = new Date().toISOString();
        player.private = true;
        fs.writeFileSync(playerFile, JSON.stringify(player));
      }
      await sleep(REQUEST_DELAY);
      continue;
    }

    if (res.status !== 200) {
      errors++;
      await sleep(REQUEST_DELAY);
      continue;
    }

    // Check for NOT_FOUND or other GraphQL errors
    if (res.body.errors && res.body.errors.length > 0) {
      const msg = res.body.errors[0]?.message || '';
      if (msg.includes('NOT_FOUND') || msg.includes('failed to find profile')) notFound++;
      stillPrivate++;
      if (!DRY_RUN) {
        const playerFile = path.join(PLAYERS_DIR, shard, fname);
        const player     = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
        player.sports.Basketball.statsChecked = new Date().toISOString();
        player.private = true;
        fs.writeFileSync(playerFile, JSON.stringify(player));
      }
      if (i < 5 || i % 50 === 0)
        console.log(`  [${i+1}/${toRecheck.length}] — ${short} still inaccessible (${msg.slice(0, 40)})`);
      await sleep(REQUEST_DELAY);
      continue;
    }

    const parsed = parseProfileStats(res.body.data);
    if (!parsed) {
      // publicProfileStatistics is null — still private
      stillPrivate++;
      if (!DRY_RUN) {
        const playerFile = path.join(PLAYERS_DIR, shard, fname);
        const player     = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
        player.sports.Basketball.statsChecked = new Date().toISOString();
        player.private = true;
        fs.writeFileSync(playerFile, JSON.stringify(player));
      }
      await sleep(REQUEST_DELAY);
      continue;
    }

    // Now accessible — write full stats
    recovered++;
    const playerFile = path.join(PLAYERS_DIR, shard, fname);
    const player     = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
    const bk         = player.sports.Basketball;

    // Replace a placeholder name now that the profile is confirmed public.
    // wasPrivate must be captured BEFORE player.private is overwritten below —
    // without it, `Player #...` would never be replaced once set at all,
    // even after the profile went public (name is otherwise only written
    // when completely absent).
    //
    // ALSO falls back to the pre-flag legacy signal (statsChecked present +
    // maxGamePTS still null) for players marked private before this flag
    // existed, so a legacy-private player going public on their very first
    // recheck after this rollout gets their name replaced immediately
    // rather than one cycle later.
    const wasPrivate = player.private === true ||
      (bk.statsChecked !== undefined && bk.maxGamePTS === null);
    if (parsed.playerName && (!player.name || wasPrivate)) {
      player.name = parsed.playerName;
    }
    player.private = false;

    bk.foulOuts       = parsed.foulOuts;
    bk.maxGamePTS     = parsed.maxGamePTS;
    bk.maxGameThreePt = parsed.maxGameThreePt;
    bk.statsChecked   = new Date().toISOString();

    if (!player.records) player.records = {};
    player.records.maxGamePTS     = parsed.maxGamePTSKey
      ? { v: parsed.maxGamePTS,     ...parsed.maxGamePTSKey }
      : { v: parsed.maxGamePTS ?? null };
    player.records.maxGameThreePt = parsed.maxGameThreePtKey
      ? { v: parsed.maxGameThreePt, ...parsed.maxGameThreePtKey }
      : { v: parsed.maxGameThreePt ?? null };

    if (!DRY_RUN) fs.writeFileSync(playerFile, JSON.stringify(player));
    console.log(`  [${i+1}/${toRecheck.length}] ✓ RECOVERED ${short}  pts=${parsed.maxGamePTS ?? 0}`);
    await sleep(REQUEST_DELAY);
  }

  await gitCommit(
    `recheck-private-profiles: ${recovered} recovered, ${stillPrivate} still private, ${errors} errors`
  );

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('\n─'.repeat(50));
  console.log(`  Rechecked:     ${toRecheck.length}`);
  console.log(`  Recovered:     ${recovered}`);
  console.log(`  Still private: ${stillPrivate}`);
  console.log(`    of which NOT_FOUND: ${notFound}`);
  console.log(`  Errors:        ${errors}`);
  // NOT_FOUND means PlayHQ has no profile at that id. For a correctly keyed file
  // that is real (the profile was deleted). For a wrongly keyed one it means we
  // asked with a spectator id. A high rate is the signature of the second, and it
  // is being written to disk as private:true either way.
  if (stillPrivate > 0 && notFound / stillPrivate > 0.5 && stillPrivate >= 20) {
    console.log(`\n  ⚠ ${Math.round((notFound / stillPrivate) * 100)}% of "still private" were NOT_FOUND.`);
    console.log('    That is the shape of querying with the wrong id, not of profiles going private.');
    console.log('    Check for wrongly-keyed files before trusting this run.');
  }
  console.log(`  Elapsed:       ${elapsed}s`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
