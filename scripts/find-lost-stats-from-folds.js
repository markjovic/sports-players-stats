// scripts/find-lost-stats-from-folds.js
//
// Finds player files whose PlayHQ stats were destroyed by a fold that ran before
// the keeper rule was corrected on 2026-09-01, and hands them back to the matrix.
//
// WHAT WENT WRONG
// ───────────────
// fold-diverged-players.js used to pick the merge keeper by whichever record held
// more games[] entries. games[] is assigned by build-player-games resolving
// rosters through the alias index, so before an alias exists the spectator-keyed
// stub collects nearly everything: measured across the 552 pairs the seeder had to
// refuse, the stub held a median of 69 games and the real api-keyed profile held 1.
// The stub therefore won, and because only seasons/games/teams/gameTids/name are
// unioned, the real profile's stats, records and private flag were replaced.
//
// THE SIGNATURE, AND WHY IT IS NARROW
// ───────────────────────────────────
// Work through what the stub actually carried at merge time.
//
//   Stub never fetched     -> no statsChecked, private undefined. The merged file
//                             inherits no statsChecked, so fetch-profile-stats
//                             re-offers it (its skip test is
//                             !p?.sports?.Basketball?.statsChecked) and it healed
//                             on its own. NOT damage.
//   Stub fetched and served -> the stub holds real PlayHQ stats. Fetched under
//                             whichever id worked, so the numbers are real.
//                             NOT damage.
//   Stub fetched, NOT_FOUND -> markNotObtainable wrote private = true AND
//                             statsChecked. The merged file is api-keyed, marked
//                             private, and marked checked. fetch-profile-stats
//                             skips it forever. The real profile's stats are gone
//                             and nothing will ever go back for them. ◄ DAMAGE.
//
// So the signature is: evidence of a merge, plus private === true, plus a
// statsChecked timestamp. All three, or it is one of the harmless cases above.
//
// Evidence of a merge is spectatorIds.length > 1 — the fold unions both records'
// spectator ids and adds the truncation of each key, so a merged file carries at
// least two and a promoted or never-folded file carries at most one.
//
// The guard in seed-apiid-from-playhq-pairs.js recorded targetIsPrivate: false on
// all 552 pairs it refused, so a genuinely private api-keyed profile is NOT the
// expected shape here — which is what makes private === true on a merged file a
// signal rather than a coincidence.
//
// THE REPAIR
// ──────────
// Delete statsChecked. That is all. fetch-profile-stats then re-offers the player,
// queries with the api id the file is now keyed on, and writes whatever PlayHQ
// actually holds — including correcting private if the profile is public after
// all. The same mechanism the fold now uses for its tie-break cases, proven end to
// end on 2026-09-01: fold #76 un-checked 79 players and every one was re-fetched
// within a minute of the dispatch.
//
// private is deliberately LEFT ALONE. This script does not know whether the
// profile is public; fetch-profile-stats finds out. Writing a guess here would be
// the same mistake in the other direction.
//
// Run:
//   node scripts/find-lost-stats-from-folds.js              (report only)
//   node scripts/find-lost-stats-from-folds.js --apply      (un-check and requeue)

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const REPORT_REL  = 'reports/lost-stats-from-folds.json';
const REPORT_FILE = path.join(ROOT, REPORT_REL);
const SHARDS_FILE = path.join(ROOT, 'refetch-shards.json');

const args    = process.argv.slice(2);
const APPLY   = args.includes('--apply');
const argVal  = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
// A merged file with a handful of games has little to lose and is not worth a
// call. Default 5; set to 0 to requeue every match.
const MIN_GAMES = Math.max(0, parseInt(argVal('min-games', '5'), 10) || 0);
// A withheld player whose gp is at least this fraction of their captured games
// still HAS their stats — they are stale, not lost. Default 0.2. Set 0 to disable.
const GP_RATIO  = Math.max(0, parseFloat(argVal('gp-ratio', '0.2')) || 0);

const log = (m) => console.log(`[lost-stats] ${new Date().toISOString()} ${m}`);

function main() {
  log(`find-lost-stats-from-folds${APPLY ? '' : ' (REPORT ONLY)'}  min-games=${MIN_GAMES}  gp-ratio=${GP_RATIO}`);
  console.log('─'.repeat(64));

  const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  if (!prefixes.length) { console.error('FATAL: no player shards. Checkout incomplete.'); process.exit(1); }

  let scanned = 0, merged = 0;
  const damaged = [];
  // Reported but NOT repaired: a merged file that was served by PlayHQ and told
  // it has no games. That is a real answer, not a lost one, and requeuing it would
  // spend a call to be told the same thing. Counted so the number is visible
  // rather than quietly folded into the healthy pile.
  let mergedCheckedZeroGp = 0;
  // Withheld, but their stats are still on the file. Counted so the population is
  // visible rather than silently dropped by the ratio test.
  let staleButPresent = 0;
  // Merged, public, PlayHQ answered, and it credited nothing — while we hold real
  // captured games. Not a loss, so never repaired here, but 46 of them is not
  // nothing and a bare count cannot be checked against anything.
  const zeroGpRows = [];
  const shards = new Set();

  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS_DIR, prefix);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
    for (const fname of files) {
      scanned++;
      if (scanned % 100000 === 0) log(`scanned ${scanned.toLocaleString()} files`);

      const fpath = path.join(dir, fname);
      let p;
      try { p = JSON.parse(fs.readFileSync(fpath, 'utf8')); } catch { continue; }

      const spec = Array.isArray(p.spectatorIds) ? p.spectatorIds : [];
      if (spec.length <= 1) continue;          // no evidence of a merge
      merged++;

      const bk = p.sports && p.sports.Basketball;
      if (!bk || !bk.statsChecked) continue;   // already re-offered; healed or healing
      const games = Array.isArray(p.games) ? p.games.length : 0;

      if (p.private !== true) {
        if (!(Number(bk.gp) > 0) && games >= MIN_GAMES) {
          mergedCheckedZeroGp++;
          if (zeroGpRows.length < 15) {
            zeroGpRows.push({ uuid: fname.replace(/\.json$/, ''), shard: prefix, name: p.name || null, games, statsChecked: bk.statsChecked });
          }
        }
        continue;
      }
      if (games < MIN_GAMES) continue;

      // ── STALE-BUT-PRESENT IS NOT DAMAGE ─────────────────────────────────────
      // NARROWED 2026-09-04. private + merged + checked was the original
      // signature, and it was right while the fold could still let a NOT_FOUND
      // stub replace a real profile. That population was repaired on 2026-09-03
      // and the corrected keeper rule cannot recreate it.
      //
      // What the signature catches now is the ordinary public-to-private
      // transition. markNotObtainable (fetch-profile-stats.js L944) sets
      // private = true and leaves "any prior capture left intact", so a player who
      // was public when last fetched and is withheld now keeps their real gp. The
      // 2026-09-03 force sweep re-asked all 418k players in one pass and turned up
      // far more of these, so the count ROSE from 16 to 73 — every one of the ten
      // largest carrying gp at or above its games count. Calling that DAMAGED
      // tells the reader there is a fault when there is not.
      //
      // Lost stats look different: the stub that won had no stats to give, so the
      // merged file has no gp at all, or a gp far below what we captured. Isabella
      // Addison at 273 games / gp 275 is fine. Edith Nott at 130 games / gp 5 is
      // not. The ratio is what separates them.
      //
      // 20% is a threshold, so it is a judgement, and it is exposed as --gp-ratio
      // rather than buried. Raising it widens the net; 0 disables the test and
      // restores the old behaviour.
      const gp = Number(bk.gp) || 0;
      if (games > 0 && GP_RATIO > 0 && gp >= games * GP_RATIO) { staleButPresent++; continue; }

      damaged.push({
        uuid: fname.replace(/\.json$/, ''),
        shard: prefix,
        name: p.name || null,
        games,
        gp: Number(bk.gp) || 0,
        statsChecked: bk.statsChecked,
        spectatorIds: spec.length,
      });
      shards.add(prefix);

      if (APPLY) {
        delete bk.statsChecked;
        fs.writeFileSync(fpath, JSON.stringify(p), 'utf8');   // minified, always
      }
    }
  }

  damaged.sort((a, b) => b.games - a.games);

  console.log(`\n  files scanned                       : ${scanned.toLocaleString()}`);
  console.log(`  merged (spectatorIds > 1)           : ${merged.toLocaleString()}`);
  console.log(`  withheld, stats still present       : ${staleButPresent.toLocaleString()}  (gp >= ${(GP_RATIO * 100).toFixed(0)}% of games — stale, NOT lost)`);
  console.log(`  DAMAGED: withheld with stats missing : ${damaged.length.toLocaleString()}`);
  console.log(`  merged, public, checked, gp 0       : ${mergedCheckedZeroGp.toLocaleString()}  (reported only — PlayHQ answered, not a loss)`);
  if (zeroGpRows.length) {
    console.log('    PlayHQ credits them nothing despite real captured games:');
    for (const r of zeroGpRows) {
      console.log(`      ${r.uuid.slice(0, 8)}  ${String(r.games).padStart(4)} games  checked ${String(r.statsChecked).slice(0, 10)}  ${(r.name || '(no name)').slice(0, 28)}`);
    }
  }
  console.log(`  shards affected                     : ${shards.size}`);
  if (damaged.length) {
    const lost = damaged.reduce((n, d) => n + d.games, 0);
    console.log(`  captured games behind those files   : ${lost.toLocaleString()}`);
    console.log('\n  largest 10:');
    for (const d of damaged.slice(0, 10)) {
      console.log(`    ${d.uuid.slice(0, 8)}  ${String(d.games).padStart(4)} games  gp=${d.gp}  ${(d.name || '').slice(0, 28)}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'report-only',
    minGames: MIN_GAMES,
    gpRatio: GP_RATIO,
    staleButPresent,
    mergedPublicCheckedZeroGpExamples: zeroGpRows,
    scanned, merged,
    damaged: damaged.length,
    mergedPublicCheckedZeroGp: mergedCheckedZeroGp,
    shards: [...shards].sort(),
    players: damaged,
  };
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');

  // Always written, always [] outside apply — a report-only run must not be able
  // to cause a dispatch. Same contract as fold-diverged-players.js.
  fs.writeFileSync(SHARDS_FILE, JSON.stringify(APPLY ? [...shards].sort() : []), 'utf8');
  log(APPLY && shards.size
    ? `re-fetch queued: ${damaged.length} player(s) across ${shards.size} shard(s)`
    : 're-fetch queued: none');

  console.log(`\n  Report: ${REPORT_REL}`);

  // ⚠ THE REPORT IS COMMITTED IN BOTH MODES.
  //
  // This used to `return` here when not applying, with the git block below it —
  // so a report-only run wrote the report to the runner's disk and then threw it
  // away when the runner was destroyed. The numbers existed only in the job log,
  // and the copy in the repo stayed at whatever the last APPLY run left behind.
  //
  // Observed 2026-09-03: a report-only pass found 16 damaged and reported it in
  // the log, but reports/lost-stats-from-folds.json in the repo still held the
  // 06:27 apply run's 50. Anyone reading the file got a stale answer with no
  // indication it was stale.
  //
  // Producing a report and discarding it is the whole point of the run defeated.
  // Only the PLAYER-FILE writes are gated on apply — `git add -- players/` below
  // stages nothing in report-only mode because nothing was written there.
  if (!APPLY) log('report only — no player file was modified. Committing the report.');

  // House git pattern: per-path add, --shortstat, fetch then merge -X ours, 60
  // attempts with jitter, THROW on exhaustion. A repair that never lands must not
  // show green.
  // 60 attempts with up to 91s of jitter is the pattern for players/, where many
  // writers collide and a lost commit means lost work. It is wrong here in
  // report-only mode: the ONLY path staged is a report nothing else writes, and it
  // regenerates in about 31 seconds. On 2026-09-04 a report-only run finished its
  // scan in 31s and then sat in this loop for 20 minutes with nothing else running.
  // Waiting 45 minutes to preserve half a minute of work is a bad trade.
  const PUSH_ATTEMPTS = APPLY ? 60 : 5;
  const GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
  if (APPLY) execSync('git add -- players/', GIT);
  execSync(`git add -- ${REPORT_REL}`, GIT);
  const staged = execSync('git diff --staged --shortstat', GIT).toString().trim();
  if (!staged) { log('nothing to commit.'); return; }
  log(`staging: ${staged}`);
  const msg = APPLY
    ? `find-lost-stats-from-folds: un-checked ${damaged.length} players for re-fetch`
    : `find-lost-stats-from-folds: report only, ${damaged.length} damaged found`;
  execSync(`git commit -q -m "${msg}"`, GIT);
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try { execSync('git merge --abort', GIT); } catch {}
    try {
      execSync('git fetch origin main', GIT);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT);
      execSync('git push origin main', GIT);
      log(`pushed${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      const why = e.message.split('\n').slice(0, 3).join(' | ');
      // The reason, every time, not only at the end. A loop that prints "retrying"
      // and nothing else forces whoever is watching to expand 60 log groups to find
      // out what is actually failing.
      log(`push attempt ${attempt}/${PUSH_ATTEMPTS} failed: ${why}`);
      if (attempt === PUSH_ATTEMPTS) {
        if (APPLY) throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${why}`);
        // Report-only: the player files were never touched, so nothing is at risk.
        // Say so and exit clean rather than failing a read-only run over a file
        // that can be regenerated on demand.
        log(`report-only: giving up on the commit after ${PUSH_ATTEMPTS} attempts. No player file was modified; re-run to regenerate the report.`);
        return;
      }
      execSync(`sleep ${1 + Math.floor(Math.random() * (APPLY ? 91 : 15))}`, { stdio: 'pipe' });
    }
  }
}

main();
