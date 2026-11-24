// scripts/audit-uuid-collisions.js
//
// READ-ONLY. Scans every players/indexes/{shard}.json (all 256 shards) and
// reports every uuid prefix collision at a given length -- every pair (or
// larger group) of distinct full uuids whose first N characters are
// identical. Touches nothing in games/leaderboard/team-stats/search or any
// player file -- this is a diagnostic only.
//
// Why this exists: the 2026-07-10 uuid-prefix migration used TRUNC_LEN=10,
// which -- because a uuid's first hyphen sits at string index 8 -- is really
// only 9 real hex digits of entropy (36 bits), not 10 (40 bits) as originally
// assumed. True birthday-paradox collision probability at 36 bits across
// ~370k players is ~63%, not the ~5-6% first estimated for 40 bits. This
// script measures the real, current scope of the problem rather than
// guessing at it:
//   node scripts/audit-uuid-collisions.js --len=10   (old length -- how bad was it)
//   node scripts/audit-uuid-collisions.js --len=13   (new length -- confirm the fix holds)
//
// Writes a report to reports/uuid-collisions-len{N}.json and commits it, so
// it's visible in the repo rather than only in a runner's ephemeral log.

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const GX = require('./lib/git-exec.cjs');   // T104: the git timeout lives in ONE place

const ROOT        = path.join(__dirname, '..');
const PLAYERS_IDX = path.join(ROOT, 'players', 'indexes');
const FULL_LEN    = 36;

const lenArg = process.argv.find(a => a.startsWith('--len='));
const LEN = lenArg ? parseInt(lenArg.split('=')[1], 10) : 10;

function isFullUuid(id) { return typeof id === 'string' && id.length === FULL_LEN; }

// ─── git (house pattern) ──────────────────────────────────────────────────────
// REWRITTEN 2026-11-24 (T104). This function previously had THREE faults beyond the
// missing timeout, and they compounded:
//
//   1. `git add ${dirs.join(' ')}` — a COMBINED add. `git add` is atomic across
//      pathspecs, so one unmatched path stages NOTHING, including the valid paths
//      beside it. That is the 2026-07-19 failure exactly: 30,426 games fetched,
//      zero committed, job green.
//   2. NO push retry at all, on a repository where every other writer retries with
//      jitter and every push must merge the others' commits.
//   3. The catch PRINTED AND RETURNED. A lost push left the job GREEN with the work
//      discarded — the swallow that has now been closed three separate times.
//
// ⚠ EXPECT A NEW RED WHERE THERE WAS GREEN if this has been quietly losing pushes.
// That is the fix working, not a regression.
function gitCommit(message, dirs) {
  let addFailures = 0;
  for (const d of dirs) {
    try { execSync(`git add -- ${d}`, GX.gitOpts(ROOT)); }
    catch (e) {
      addFailures++;
      console.error(`  \u26a0 git add failed for "${d}": ${GX.gitSaid(e, 160) || e.message.slice(0, 160)}`);
    }
  }
  const staged = (() => {
    try { return execSync('git diff --staged --shortstat', GX.gitOpts(ROOT)).toString().trim(); }
    catch (_) { return ''; }
  })();
  if (!staged) {
    // "nothing to commit" is legitimate — but not when an add failed, because then
    // "nothing staged" is a symptom, not a result.
    if (addFailures) throw new Error(`nothing staged and ${addFailures} path(s) failed to stage — refusing to report a clean no-op`);
    console.log('  Nothing to commit.');
    return;
  }
  console.log(`  staging: ${staged}`);
  // Commit BEFORE fetch/merge: merging over uncommitted changes fails outright when
  // concurrent pushes touch the same files.
  try { execSync(`git commit -q -m "${message.replace(/"/g, "'")}"`, GX.gitOpts(ROOT)); }
  catch (e) {
    if (GX.isNothingToCommit(e)) { console.log('  Nothing to commit.'); return; }
    throw new Error(`commit failed — ${GX.gitSaid(e) || e.message}`);
  }
  const MAX = GX.MAX_ATTEMPTS;
  const stalls = GX.makeStallTracker();
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try { execSync('git merge --abort', GX.gitOpts(ROOT)); } catch (_) { /* none in progress */ }
    try { execSync('git fetch origin main', GX.gitOpts(ROOT)); stalls.note('ok'); }
    catch (e) {
      const kind = GX.classifyGitError(e);
      const st = stalls.note(kind);
      if (kind === 'fatal') throw new Error(GX.fatalMessage('fetch', e));
      if (st.exhausted) throw new Error(GX.stallExhaustedMessage('fetch', st));
      if (attempt === MAX) throw new Error(GX.attemptsExhaustedMessage('fetch', MAX, e));
      const s = GX.backoffSeconds(true);
      console.log(GX.retryMessage('fetch', e, attempt, MAX, s, st));
      try { execSync(`sleep ${s}`, GX.sleepOpts(s)); } catch (_) {}
      continue;
    }
    execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GX.gitOpts(ROOT));
    try {
      execSync('git push origin main', GX.gitOpts(ROOT));
      console.log(`  \u2714 committed (attempt ${attempt}): ${message}`);
      return;
    } catch (e) {
      const kind = GX.classifyGitError(e);
      const st = stalls.note(kind);
      if (kind === 'fatal') throw new Error(GX.fatalMessage('push', e));
      if (st.exhausted) throw new Error(GX.stallExhaustedMessage('push', st));
      if (attempt === MAX) throw new Error(GX.attemptsExhaustedMessage('push', MAX, e));
      const s = GX.backoffSeconds(true);
      console.log(GX.retryMessage('push', e, attempt, MAX, s, st));
      try { execSync(`sleep ${s}`, GX.sleepOpts(s)); } catch (_) {}
    }
  }
  // THROW on exhaustion. A run that pushed nothing must not exit 0.
  throw new Error(`exhausted ${MAX} push attempts`);
}

function main() {
  const start = Date.now();
  console.log(`audit-uuid-collisions.js -- prefix length ${LEN}`);
  console.log('-'.repeat(60));

  if (!fs.existsSync(PLAYERS_IDX)) {
    console.error(`  FAILED: ${PLAYERS_IDX} not found -- nothing to scan`);
    process.exit(1);
  }

  const shardFiles = fs.readdirSync(PLAYERS_IDX)
    .filter(f => /^[0-9a-f]{2}\.json$/.test(f))
    .sort();

  let totalPlayers = 0;
  let totalCollisions = 0;
  const report = [];

  for (const file of shardFiles) {
    const shard = file.replace('.json', '');
    let index;
    try { index = JSON.parse(fs.readFileSync(path.join(PLAYERS_IDX, file), 'utf8')); }
    catch (e) { console.error(`  FAILED to read ${file}: ${e.message}`); continue; }

    const map = new Map(); // prefix -> [fullUuid, ...]
    for (const fullUuid of Object.keys(index)) {
      if (!isFullUuid(fullUuid)) continue;
      totalPlayers++;
      const prefix = fullUuid.slice(0, LEN);
      if (!map.has(prefix)) { map.set(prefix, [fullUuid]); continue; }
      map.get(prefix).push(fullUuid);
    }

    for (const [prefix, uuids] of map) {
      if (uuids.length > 1) {
        totalCollisions++;
        report.push({ shard, prefix, uuids });
        console.log(`  COLLISION shard ${shard}: prefix "${prefix}" -- ${uuids.length}-way: ${uuids.join(', ')}`);
      }
    }
  }

  const outPath = path.join(ROOT, 'reports', `uuid-collisions-len${LEN}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    len: LEN,
    generatedAt: new Date().toISOString(),
    totalPlayers,
    totalCollisions,
    report,
  }, null, 2), 'utf8');

  console.log('-'.repeat(60));
  console.log(`  Prefix length   : ${LEN}`);
  console.log(`  Players scanned : ${totalPlayers.toLocaleString()}`);
  console.log(`  Collisions found: ${totalCollisions}`);
  console.log(`  Report          : reports/uuid-collisions-len${LEN}.json`);
  console.log(`  Elapsed         : ${Math.round((Date.now() - start) / 1000)}s`);

  console.log('\n  Committing report...');
  gitCommit(`audit-uuid-collisions: len=${LEN}, ${totalCollisions} collisions found across ${totalPlayers.toLocaleString()} players`, ['reports/']);
}

main();
