// scripts/build-leaderboards.js
//
// Generates leaderboard index files for StatTrack.
//
// Output files:
//   leaderboard/all-time.json          — top 2000 per stat category, career totals
//   leaderboard/season/{sid}.json      — { players: { "uuid|tid": {...raw stats} } }
//                                         NO pre-sorted per-category arrays — StatTrack
//                                         computes rankings client-side from raw fields
//                                         (removed ~Jul 2026: 17 redundant {id,v} arrays
//                                         per file were pure overhead — SEASON_LIMIT was
//                                         already "effectively unlimited", so they held
//                                         the same ~500-1500 ids as the players map, just
//                                         repeated up to 17x).
//
// All-time entry:  { uuid, name, club, sport, gp, v }
// Per-season entry (players map): { n, team, org, comp, grade, age, gender, gp,
//   foulOuts, foulOutsPG, threePtPG, foulsPG, finals, gfApps, gfWins,
//   pts, threePt, fouls, wins, losses, draws, club? }
//
// Caps:
//   ALL_TIME_LIMIT = 2000  — deep enough for grade/age/gender filters across every age group
//   Per-season: TopN(5000) — never trims a real season (max ~1500 regs), memory-safe per pass
//
// TWO-PASS STRATEGY (avoids OOM):
//   Pass 1 — all-time: scan all 369k player files once, feed career totals into TopN heap.
//            Write all-time.json. Discard.
//   Pass 2 — per-season: for each season, collect UUIDs from team-stats roster,
//            scan only those player files, build season heaps, write, discard.
//            Only one season's heaps live in memory at a time.
//
// Modes:
//   node scripts/build-leaderboards.js                 — full rebuild
//   node scripts/build-leaderboards.js --active-only   — active seasons only (weekly chain)
//   node scripts/build-leaderboards.js --dry-run       — no writes, no commits
//
// 2026-07-10: uuid values written to all-time entries and season "uuid|tid" map
// keys are truncated via truncateUuid() — TRUNC_LEN, currently 13 (see
// scripts/lib/uuid-prefix.cjs). Comment corrected 2026-07-31: it said "10-char
// prefix", which was the REJECTED length (10 chars is only 9 hex digits — the
// first hyphen sits at index 8 — so ~36 bits and ~63% birthday-collision odds at
// ~370k players). The CODE was always right: L248/L305 call truncateUuid(), and
// every alias key in production is 13 chars. Only this comment was wrong —
// part of the UUID-storage-footprint reduction. Every player uuid used in this
// file is now sourced from the player file's own filename (never player.uuid,
// a body field docs say was stripped in June 2026 — pushAllTime/pushSeason
// used to silently re-derive it from the body instead of the filename their
// callers already had on hand; fixed here to match every other pipeline
// script, which all derive uuid from the filename).

'use strict';

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { truncateUuid } from './lib/uuid-prefix.cjs';
import { makeLookup } from './lib/game-scores.cjs';
// The age group carried in a grade or team name. ⚠️ Its rule is copied from
// index.html's grParse and MUST stay identical — the page's lbAgeOf prefers the
// PUBLISHED `age` and only falls back to parsing the name, so once this ships the
// page takes this builder's answer. If the two rules disagree, a player's age
// group changes the moment a file is rebuilt. See the lib header.
import { leaderboardAge } from './lib/grade-age.cjs';

// Age coverage, reported at the end. ⚠️ An age filter that silently holds nothing
// is how this defect survived: `age` was '' on every entry ever written and no run
// said so. If `resolved` collapses to 0 again, the run now states it loudly.
const ageDerived = { season: 0, allTime: 0 };
const ageEmpty   = { season: 0, allTime: 0 };
// T104: the git timeout, the 512 MB maxBuffer and the stall vocabulary live in
// ONE place. Default import because git-exec.cjs is CommonJS and this file is ESM.
import GX from './lib/git-exec.cjs';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));


const ROOT            = path.join(__dirname, '..');
const DRY_RUN         = process.argv.includes('--dry-run');
const ACTIVE_ONLY     = process.argv.includes('--active-only');
const MODE            = ACTIVE_ONLY ? 'active' : 'full';
const FORCE_FULL      = process.argv.includes('--force'); // ignore progress file, full rebuild
const ALL_TIME_LIMIT  = 2000;
// An entry on a single-game board whose game we cannot check is DROPPED, and the
// count is printed. Pass --keep-unverified-records to restore the old behaviour
// of publishing it. See verifyGameRecords() for why the default is this way.
const KEEP_UNVERIFIED = process.argv.includes('--keep-unverified-records');
// maxGamePTS / maxGameThreePt are verified AFTER the heap is final, so the heap
// must carry spare depth to backfill whatever verification removes. Verification
// cannot run at push time: it needs a game-file read per entry, and pass 1 pushes
// ~370k times per category. Running it on the finished 4,000 costs 4,000 lookups.
const RECORD_CATS     = ['maxGamePTS', 'maxGameThreePt'];
const RECORD_OVERSHOOT = 2;

const ALL_TIME_CATS = ['pts','ppg','gp','threePt','fouls','threePtPG','foulsPG','foulOuts','foulOutsPG','finals','gfApps','gfWins','finalsPerSeason','maxGamePTS','maxGameThreePt','wins','losses','draws','winPct','lossPct'];
// SEASON_CATS list moved to StatTrack's client-side statValueForPlayer() — season
// files now ship only the players map (see pushSeason), computed on demand there.
const PASS2_PROGRESS  = path.join(ROOT, 'scripts', '.build-leaderboards-progress.json');
const COMMIT_INTERVAL = 100;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
}

function gitCommit(message, dirs) {
  // Staging: PER-PATH adds — `git add` is ATOMIC across pathspecs, so one
  // combined add with any unmatched pathspec stages NOTHING (this exact bug
  // silently discarded a whole discover-fixtures run, 2026-07-19). Per-path,
  // a miss skips only itself and is logged. --shortstat (never --stat: --stat
  // prints per-file lines and scales with file count — real ENOBUFS risk on a
  // repo this size, confirmed 2026-07-10) is printed so the log proves what
  // was staged. COMMIT FIRST, then fetch/merge/push with the proven retry
  // pattern copied from build-win-loss.js (60 attempts, random 1-91s jitter,
  // merge --abort cleanup, merge -X ours --no-stat — merge's default diffstat
  // is the same ENOBUFS class, scaling with what landed on main since the
  // fetch). THROW on total push failure — a red job beats silently discarded
  // work.
  if (!dirs || !dirs.length) { console.error('  gitCommit: no paths given — refusing blanket add'); return; }
  // T104 — ⚠ THE SWALLOW WAS HERE. The whole stage/commit block sat in one try whose
  // catch printed a truncated stderr line and RETURNED. A failed commit therefore left
  // the job GREEN with the work uncommitted, and the run reported success having
  // written nothing. That is the defect closed three times before this and found a
  // fourth time, in a chain builder. It now THROWS.
  //
  // `--` added to each add: without it a pathspec beginning with `-` is read as an
  // option. Per-path staging is unchanged, and a genuine per-path miss is still
  // skipped and logged rather than aborting the batch.
  let addFailures = 0;
  for (const dir of dirs) {
    try { execSync(`git add -- ${dir}`, GX.gitOpts(ROOT)); }
    catch (e) {
      addFailures++;
      console.error(`  staging miss (skipped): ${dir} — ${GX.gitSaid(e, 120) || e.message.slice(0, 120)}`);
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
    console.log('  nothing to commit');
    return;
  }
  console.log(`  staging: ${staged}`);
  // COMMIT BEFORE MERGE — merging over uncommitted changes fails outright when
  // concurrent pushes touch the same files.
  try { execSync(`git commit -q -m "${message.replace(/"/g, "'")}"`, GX.gitOpts(ROOT)); }
  catch (e) {
    if (GX.isNothingToCommit(e)) { console.log('  nothing to commit'); return; }
    throw new Error(`commit failed — ${GX.gitSaid(e) || e.message}`);
  }
  // T104 — two faults here besides the missing timeout:
  //
  //   1. fetch, merge and push were ONE try block, so a 10-minute STALL in fetch and a
  //      lost race on push produced the same (absent) line. Split, as nightly-crawl.js
  //      and discover-fixtures.js already have them.
  //   2. ⚠ THE RETRY PRINTED NOTHING. It slept 1-91s and went round again in silence,
  //      up to 60 times. Sixty silent attempts are indistinguishable from a hang —
  //      which is exactly how the 2026-11-23 incident presented.
  //
  // The merge is deliberately NOT retried: a merge that fails is not contention, and
  // retrying it over a wedged index achieves nothing.
  const MAX = GX.MAX_ATTEMPTS;
  const stalls = GX.makeStallTracker();   // caps CONSECUTIVE timeout kills at 3
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try { execSync('git merge --abort', GX.gitOpts(ROOT)); } catch (_) { /* none in progress */ }

    try {
      execSync('git fetch origin main', GX.gitOpts(ROOT));
      stalls.note('ok');
    } catch (e) {
      // Classify BEFORE reading stderr: a timeout-killed child carries none, so it
      // would otherwise be filed as contention it never ran.
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
      console.log(`  ✔ committed: ${message}${attempt > 1 ? ` (push attempt ${attempt})` : ''}`);
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
  // Unreachable: every exit above throws or returns. There was NO throw here before,
  // so an edit that removed one would have fallen out of the loop reporting success.
  throw new Error(`push failed after ${MAX} attempts (loop fell through)`);
}

// ─── TopN heap ───────────────────────────────────────────────────────────────

class TopN {
  constructor(n) {
    this.n   = n;
    this.arr = [];
    this.min = -Infinity;
  }
  push(entry) {
    if (this.arr.length >= this.n && entry.v <= this.min) return;
    this.arr.push(entry);
    let i = this.arr.length - 1;
    while (i > 0 && this.arr[i].v > this.arr[i - 1].v) {
      const tmp = this.arr[i]; this.arr[i] = this.arr[i - 1]; this.arr[i - 1] = tmp;
      i--;
    }
    if (this.arr.length > this.n) this.arr.length = this.n;
    this.min = this.arr.length === this.n ? this.arr[this.n - 1].v : -Infinity;
  }
  result() { return this.arr; }
}


function makeBuckets(cats, limit) {
  const b = {};
  for (const cat of cats) {
    b[cat] = new TopN(RECORD_CATS.includes(cat) ? limit * RECORD_OVERSHOOT : limit);
  }
  return b;
}

function serialise(buckets) {
  const out = {};
  for (const [cat, heap] of Object.entries(buckets)) out[cat] = heap.result();
  return out;
}

// ─── single-game record verification ─────────────────────────────────────────
//
// Runs on the FINAL board (after the active-only merge, so entries retained from
// the previous all-time.json are checked too — those are the oldest and the most
// likely to predate gameKey capture). Four verdicts per entry:
//
//   impossible — v exceeds the highest team score in that game. A player cannot
//                outscore every team on the floor. This is the test that catches
//                on-court junk whatever PlayHQ calls the outcome, and it is the
//                reason this function exists: the 2026-10-13 Coburg lines were
//                102 PTS in a game whose scoreline is 20-0.
//   forfeit    — the game file's own forfeit flag, or the id is in
//                data/forfeit-games.json. Kept as a second, independent route.
//   unverified — no sid, no gameKey, season file absent, game absent, or hs/as
//                not both numbers. DROPPED by default: an unverifiable entry on
//                a records board is exactly what produced the complaint, and the
//                cost of dropping it is one row. --keep-unverified-records
//                restores the old behaviour, and the count is printed either way
//                so the size of the unverifiable population is never a surprise.
//   ok         — published.
//
// Entries are never rewritten, only removed, and `_sid`/`_gk` are stripped here
// so the written file keeps its existing shape.
function verifyGameRecords(board, lookup) {
  const summary = {};
  // Collected for the GitHub run summary as well as the log. The four counts are
  // the whole point of the run and they sit ~40,000 log lines into a nested job;
  // GITHUB_STEP_SUMMARY puts them on the run's front page. Same mechanism
  // diagnose-forfeit-game.js already uses. Absent outside Actions, so it no-ops
  // locally.
  const md = [];
  for (const cat of RECORD_CATS) {
    const entries = board[cat];
    if (!Array.isArray(entries)) continue;

    const counts = { ok: 0, impossible: 0, forfeit: 0, unverified: 0 };
    const dropped = [];
    const kept = [];

    for (const e of entries) {
      const sid = e._sid, gk = e._gk;
      let verdict;
      if (!sid || !gk)                                    verdict = 'unverified';
      else if (forfeitGameIds.has(gk))                    verdict = 'forfeit';
      else if (lookup.isForfeit(sid, gk))                 verdict = 'forfeit';
      else {
        const cap = lookup.maxScore(sid, gk);
        if (cap === null)      verdict = 'unverified';
        else if (e.v > cap)    verdict = 'impossible';
        else                   verdict = 'ok';
      }

      counts[verdict]++;
      const publish = verdict === 'ok' || (verdict === 'unverified' && KEEP_UNVERIFIED);
      if (publish) {
        const { _sid, _gk, ...clean } = e;   // eslint-disable-line no-unused-vars
        kept.push(clean);
      } else {
        if (dropped.length < 15) {
          const cap = (sid && gk) ? lookup.maxScore(sid, gk) : null;
          // The sid is printed too: every follow-up tool takes --game= AND --season=
          // (diagnose-forfeit-game.js, repair-forfeit-score.js, recheck-forfeit-games),
          // and a game id alone cannot be looked up in games/bv.
          dropped.push(`    ${String(e.v).padStart(4)}  ${e.name || e.uuid}`
            + `  ${verdict}${cap !== null ? ` (game max score ${cap})` : ''}`
            + `${gk ? `  game ${gk}` : '  no gameKey'}${sid ? ` season ${sid}` : ''}`);
        }
      }
      if (kept.length >= ALL_TIME_LIMIT) break;
    }

    board[cat] = kept;
    summary[cat] = counts;

    const removed = counts.impossible + counts.forfeit
                  + (KEEP_UNVERIFIED ? 0 : counts.unverified);
    const headline = `  ${cat}: ${kept.length} published, ${removed} removed`
      + `  (impossible ${counts.impossible}, forfeit ${counts.forfeit}, unverified ${counts.unverified}`
      + `${KEEP_UNVERIFIED ? ' — PUBLISHED, --keep-unverified-records' : ''})`;
    console.log(headline);
    md.push(`| ${cat} | ${kept.length} | ${counts.impossible} | ${counts.forfeit} | ${counts.unverified} |`);
    if (dropped.length) {
      console.log('    removed (first 15):');
      dropped.forEach(d => console.log(d));
    }
    // A board that ends SHORT of the cap means the heap ran out of depth to
    // backfill what verification removed — the tail is silently missing, which is
    // how the 2026-10-16 run published 1,849 of 2,000. Never let that pass
    // unannounced; raise RECORD_OVERSHOOT if it appears.
    // `entries.length > kept.length` is the real condition: a category with fewer
    // players than the cap is simply small, not short, and warning about it is noise.
    if (kept.length < ALL_TIME_LIMIT && entries.length > kept.length) {
      console.log(`    ⚠ ${cat} is SHORT of the ${ALL_TIME_LIMIT} cap by ${ALL_TIME_LIMIT - kept.length}`
        + ` — the heap had ${entries.length} entries and verification removed ${entries.length - kept.length}.`
        + ` Raise RECORD_OVERSHOOT (currently ${RECORD_OVERSHOOT}) if this persists.`);
    }
    // A board that verification empties is a failure, not a clean result.
    if (entries.length > 0 && kept.length === 0) {
      throw new Error(`ABORT: verification removed EVERY ${cat} entry (${entries.length} in). `
        + `Nothing written. Re-run with --dry-run and read the verdicts above.`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY && md.length) {
    const out = [
      '### Single-game record verification',
      '',
      '| category | published | impossible | forfeit | unverified |',
      '|---|---:|---:|---:|---:|',
      ...md,
      '',
      `Unverified entries are ${KEEP_UNVERIFIED ? '**PUBLISHED** (--keep-unverified-records)' : 'withheld'}.`,
      '',
    ].join('\n');
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n'); } catch (_) {}
  }
  return summary;
}

// ─── load sports-index ───────────────────────────────────────────────────────

console.log(`Mode: ${ACTIVE_ONLY ? 'ACTIVE ONLY' : 'FULL'}${DRY_RUN ? ' + DRY RUN' : ''}`);

// Load team-index to resolve tid → comp
console.log('Loading team-index.json...');
const rawTeamIndex = readJson(path.join(ROOT, 'data', 'team-index.json'));
// Flatten to tid → comp map
const tidToComp = new Map();
for (const entries of Object.values(rawTeamIndex)) {
  for (const entry of entries) {
    if (entry.id && entry.comp) tidToComp.set(entry.id, entry.comp);
  }
}
console.log(`  ${tidToComp.size} team→comp mappings loaded`);

console.log('Loading sports-index.json...');
const sportsIndex = readJson(path.join(ROOT, 'data', 'sports-index.json'));

const activeSids = new Set(
  Object.values(sportsIndex.seasons)
    .filter(s => !s.locked)
    .map(s => s.id)
);
// sid → orgName for org field on leaderboard entries
const sidToOrg = new Map(
  Object.values(sportsIndex.seasons).map(s => [s.id, s.orgName || ''])
);
console.log(`  ${Object.keys(sportsIndex.seasons).length} total seasons, ${activeSids.size} active`);

// Load forfeit games — used to exclude contaminated maxGamePTS/maxGameThreePt entries
const FORFEIT_FILE   = path.join(ROOT, 'data', 'forfeit-games.json');
const forfeitGameIds = new Set();
try {
  const ids = readJson(FORFEIT_FILE);
  for (const id of (Array.isArray(ids) ? ids : [])) forfeitGameIds.add(id);
  console.log(`  ${forfeitGameIds.size} forfeit games loaded`);
} catch (_) {
  console.log('  forfeit-games.json not found — maxGamePTS/maxGameThreePt unfiltered');
}

const targetSids = ACTIVE_ONLY ? activeSids : null; // null = all seasons

// ─── helpers ─────────────────────────────────────────────────────────────────

const playersDir = path.join(ROOT, 'players');
const prefixDirs = fs.readdirSync(playersDir)
  .filter(d => /^[0-9a-f]{2}$/.test(d))
  .sort();

function readPlayer(uuid) {
  const p = path.join(playersDir, uuid.slice(0, 2), `${uuid}.json`);
  try { return readJson(p); } catch { return null; }
}

// uuid is always the FULL player uuid, passed in by the caller (derived from
// the player file's own filename — see the pass 1/pass 2 loops below). Never
// read player.uuid here; that's a body field, not guaranteed present for
// every player file, unlike the filename.
function pushAllTime(buckets, player, uuid) {
  // 2026-07-31: was `uuid.slice(0, 10)` — a hardcoded truncation in a placeholder
  // minter, which the house rule forbids: every minter must use TRUNC_LEN so the
  // same player gets the SAME placeholder name from every script. With a hardcoded
  // 10 here and TRUNC_LEN 13 elsewhere, a player's placeholder name flipped between
  // two forms depending on which script wrote last, dirtying the file every run.
  const name     = player.name || `Player #${truncateUuid(uuid)}`;
  const bball    = player.sports?.Basketball;
  const lastSeason = (player.seasons || []).at(-1);
  const club     = lastSeason?.club || null;
  // Most recently seen team: last reg of last season
  const lastReg  = (lastSeason?.regs || []).at(-1);
  const team     = lastReg?.tn  || null;
  const org      = sidToOrg.get(lastSeason?.sid) || null;
  if (!bball || typeof bball.gp !== 'number' || bball.gp < 1) return;
  // foulOuts may be a number (old format) or { seasonId: count } object (new format)
  const rawFoulOuts    = bball.foulOuts ?? 0;
  const careerFoulOuts = typeof rawFoulOuts === 'object' && rawFoulOuts !== null
    ? Object.values(rawFoulOuts).reduce((a, b) => a + b, 0)
    : (typeof rawFoulOuts === 'number' ? rawFoulOuts : 0);
  const careerFoulOutsPG = bball.gp > 0 ? Math.round((careerFoulOuts / bball.gp) * 1000) / 1000 : 0;
  const careerThreePtPG  = bball.gp > 0 ? Math.round(((bball.threePt ?? 0) / bball.gp) * 100) / 100 : 0;
  const careerFoulsPG    = bball.gp > 0 ? Math.round(((bball.fouls   ?? 0) / bball.gp) * 100) / 100 : 0;
  const careerFinals          = bball.finals          ?? 0;
  const careerGfApps          = bball.gfApps          ?? 0;
  const careerGfWins          = bball.gfWins          ?? 0;
  const careerFinalsPerSeason = bball.finalsPerSeason  ?? 0;
  const gender   = player.gender || '';
  // Age: most recent reg's age group — best single value for a career-spanning player.
  //
  // ⚠️ 2026-11-28 — THIS WAS `lastReg?.age || ''`, AND PlayHQ'S REGISTRATIONS CARRY
  // NO AGE GROUP, so every entry published an empty string and the Leaderboards
  // age filter was built from an array of them. It had never worked. The age lives
  // in the GRADE name ("Friday U17 Boys A"), so it is derived from there and then
  // from the team name. `lastReg.gn` is available here exactly as in the per-season
  // path below — the all-time ENTRY carries no grade, but the registration it is
  // built from does, so this is a better answer than StatTrack v2.04's client-side
  // patch, which had only the team name to work with.
  const age      = leaderboardAge(lastReg?.age, lastReg?.gn, lastReg?.tn);
  if (age) ageDerived.allTime++; else ageEmpty.allTime++;
  const base = { uuid: truncateUuid(uuid), name, club, team, org, sport: 'Basketball', gp: bball.gp,
    foulOuts: careerFoulOuts, foulOutsPG: careerFoulOutsPG,
    threePtPG: careerThreePtPG, foulsPG: careerFoulsPG,
    finals: careerFinals, gfApps: careerGfApps, gfWins: careerGfWins,
    finalsPerSeason: careerFinalsPerSeason,
    gender, age,
  };

  if (typeof bball.pts     === 'number') buckets.pts    .push({ ...base, v: bball.pts });
  if (typeof bball.gp      === 'number') buckets.gp     .push({ ...base, v: bball.gp });
  if (typeof bball.threePt === 'number') buckets.threePt.push({ ...base, v: bball.threePt });
  if (typeof bball.fouls   === 'number') buckets.fouls  .push({ ...base, v: bball.fouls });
  if (careerThreePtPG > 0)  buckets.threePtPG .push({ ...base, v: careerThreePtPG });
  if (careerFoulsPG   > 0)  buckets.foulsPG   .push({ ...base, v: careerFoulsPG });
  if (careerFoulOuts  > 0)  buckets.foulOuts  .push({ ...base, v: careerFoulOuts });
  if (careerFoulOutsPG    > 0) buckets.foulOutsPG    .push({ ...base, v: careerFoulOutsPG });
  if (careerFinals        > 0) buckets.finals        .push({ ...base, v: careerFinals });
  if (careerGfApps        > 0) buckets.gfApps        .push({ ...base, v: careerGfApps });
  if (careerGfWins        > 0) buckets.gfWins        .push({ ...base, v: careerGfWins });
  if (careerFinalsPerSeason  > 0) buckets.finalsPerSeason .push({ ...base, v: careerFinalsPerSeason });
  if (typeof bball.wins    === 'number' && bball.wins > 0)    buckets.wins   .push({ ...base, v: bball.wins });
  if (typeof bball.losses  === 'number' && bball.losses > 0)  buckets.losses .push({ ...base, v: bball.losses });
  if (typeof bball.draws   === 'number' && bball.draws > 0)   buckets.draws  .push({ ...base, v: bball.draws });
  // ── winPct / lossPct: `gp` here means DECIDED games, not career games ────────
  // These two categories are the only ones that MIX SOURCES. wins/losses/draws are
  // counted by build-win-loss.js from games/bv — games we actually hold. `bball.gp`
  // is PlayHQ's appearance count, which includes games we have no result for.
  //
  // So a player with 50 career GP but only 10 games we hold, all won, was showing
  // as 100% while carrying gp:50 — and the browser's minimum-games filter reads
  // `e.gp`, so they survived a "min 50 games" filter on the strength of 10 results.
  // A player who genuinely went 20-0 across 20 known games ranked no better.
  //
  // The percentage itself is NOT touched: 10 wins from 10 decided games IS 100%.
  // What changes is the denominator the FILTER sees. Overriding `gp` to the decided
  // count means the 10-of-50 player only appears at min<=10, and the 20-of-20
  // player appears all the way to min<=20 — which is the ranking that reflects how
  // much we actually know. It also makes the displayed GP honest: the number beside
  // the percentage is now the number the percentage was computed from.
  //
  // Every other category keeps career gp, deliberately. ppg/threePtPG/foulsPG take
  // their numerators from the SAME PlayHQ source as gp, so numerator and denominator
  // describe the same population and there is nothing to correct.
  const decided = (bball.wins || 0) + (bball.losses || 0) + (bball.draws || 0);
  if (typeof bball.winPct === 'number' && decided >= 10) {
    buckets.winPct.push({ ...base, gp: decided, v: Math.round(bball.winPct * 100) });
  }
  if (typeof bball.losses === 'number' && decided >= 10) {
    buckets.lossPct.push({ ...base, gp: decided, v: Math.round((bball.losses / decided) * 100) });
  }
  if (typeof bball.pts     === 'number') {
    buckets.ppg.push({ ...base, v: Math.round((bball.pts / bball.gp) * 10) / 10 });
  }
  // ── Single-game records ────────────────────────────────────────────────────
  // ⚠️ THIS USED TO READ `if (!gameKey || !forfeitGameIds.has(gameKey))` — WHICH
  // PUBLISHES THE ENTRY WHEN THERE IS NO gameKey TO CHECK. That is a fail-open
  // on the one field the check depends on, and it is how the 2026-10-13 Coburg
  // junk lines reached the Best Game PTS board (REPO_MANIFEST §6.84).
  // fetch-profile-stats.js L1472-1474 stores `{ v }` with NO gameKey whenever
  // the game id was absent when the record was captured, so for those players
  // the blocklist could never match and the entry went through unconditionally,
  // forever — a forfeit id arriving in data/forfeit-games.json later changed
  // nothing, because the stored record is never recomputed.
  //
  // The sid and gameKey now RIDE WITH the entry and are checked after the heap
  // is final, against the game's own scoreline, in verifyGameRecords(). Both
  // are stripped before the file is written.
  if (typeof bball.maxGamePTS === 'number' && bball.maxGamePTS > 0) {
    const rec = player.records?.maxGamePTS || {};
    buckets.maxGamePTS.push({ ...base, v: bball.maxGamePTS, _sid: rec.sid || null, _gk: rec.gameKey || null });
  }
  if (typeof bball.maxGameThreePt === 'number' && bball.maxGameThreePt > 0) {
    const rec = player.records?.maxGameThreePt || {};
    buckets.maxGameThreePt.push({ ...base, v: bball.maxGameThreePt, _sid: rec.sid || null, _gk: rec.gameKey || null });
  }
}

// uuid is always the FULL player uuid — see pushAllTime's comment above.
function pushSeason(players, player, sid, uuid) {
  // See L224 — same hardcoded-truncation fix.
  const name   = player.name || `Player #${truncateUuid(uuid)}`;
  const gender = player.gender || null;
  for (const season of (player.seasons || [])) {
    if (season.sid !== sid) continue;
    const sClub = season.club || null;
    for (const reg of (season.regs || [])) {
      const stats = reg.stats || {};
      const gp    = stats.gp;
      if (typeof gp !== 'number' || gp < 1) continue;
      // ⚠️ REVERTED 2026-08-01. This was briefly `${truncateUuid(uuid)}|${reg.tid}|${reg.gid || ''}`
      // on the reasoning that, since a reg is a (team, grade) registration (decision A),
      // a regraded team should produce one season row per grade — and that the old
      // uuid|tid key was silently dropping one of them, because L340 ASSIGNS.
      //
      // MEASURED AFTERWARDS, and the reasoning was wrong: regrade regs hold the SAME
      // team-season totals on every grade. Of ~913,000 regrade groups, the copies are
      // byte-identical apart from `foulOuts`, which lands on whichever copy the
      // foul-out writer matched first. gp/pts/fg/ft/threePt/fouls/wins/losses agree
      // across grades in every sample.
      //
      // So the API reports per-TEAM season totals and repeats them on each grade
      // registration. Keying by grade therefore produces TWO leaderboard rows with
      // identical stats for one player, and the ASSIGN it replaced was not losing
      // anything — both copies said the same thing. uuid|tid is correct.
      const id         = `${truncateUuid(uuid)}|${reg.tid}`;
      const comp       = tidToComp.get(reg.tid) || '';
      const org        = sidToOrg.get(sid) || '';
      const foulOuts   = stats.foulOuts   ?? 0;
      const foulOutsPG = gp > 0 ? Math.round((foulOuts / gp) * 1000) / 1000 : 0;
      const threePtPG  = gp > 0 ? Math.round(((stats.threePt ?? 0) / gp) * 100) / 100 : 0;
      const foulsPG    = gp > 0 ? Math.round(((stats.fouls   ?? 0) / gp) * 100) / 100 : 0;
      const finals     = stats.finals ?? 0;
      const gfApps     = stats.gfApps ?? 0;
      const gfWins     = stats.gfWins ?? 0;
      // Every raw field needed to derive all 17 SEASON_CATS client-side, so the
      // per-category {id,v} arrays below are no longer written at all — this
      // players map is now the ONLY thing a season file contains besides it.
      // ⚠️ See the note on the all-time `age` above: reg.age is empty on every
      // registration PlayHQ serves, so the age comes from the grade name.
      const seasonAge = leaderboardAge(reg.age, reg.gn, reg.tn);
      if (seasonAge) ageDerived.season++; else ageEmpty.season++;
      const playerEntry = {
        n: name, team: reg.tn || '', org, comp,
        grade: reg.gn || '', age: seasonAge, gender: gender || '',
        gp, foulOuts, foulOutsPG, threePtPG, foulsPG, finals, gfApps, gfWins,
        pts: stats.pts, threePt: stats.threePt, fouls: stats.fouls,
        wins: stats.wins, losses: stats.losses, draws: stats.draws,
      };
      // Strip undefined values (e.g. stats.pts missing) rather than serialise
      // them as explicit nulls — keeps the file no larger than it needs to be.
      for (const k of Object.keys(playerEntry)) if (playerEntry[k] === undefined) delete playerEntry[k];
      if (sClub) playerEntry.club = sClub;
      players[id] = playerEntry;
    }
    break;
  }
}

// ─── PASS 1: all-time ────────────────────────────────────────────────────────

console.log('\n── Pass 1: all-time leaderboard ────────────────────────────');
const allTime = makeBuckets(ALL_TIME_CATS, ALL_TIME_LIMIT);
let playerCount = 0;
let skipped     = 0;

for (const prefix of prefixDirs) {
  const prefixDir = path.join(playersDir, prefix);
  const files = fs.readdirSync(prefixDir).filter(f => f.endsWith('.json'));
  for (const fname of files) {
    const uuid = fname.replace('.json', '');
    // In active-only mode still scan all players for all-time (career totals need full history)
    let player;
    try { player = readJson(path.join(prefixDir, fname)); } catch { skipped++; continue; }
    pushAllTime(allTime, player, uuid);
    playerCount++;
    if (playerCount % 50000 === 0) console.log(`  ${playerCount} players scanned...`);
  }
}

console.log(`  ${playerCount} players scanned, ${skipped} skipped`);

// active-only: merge with existing all-time
let allTimeOut;
if (ACTIVE_ONLY) {
  console.log('  Merging with existing all-time.json...');
  const allTimePath = path.join(ROOT, 'leaderboard', 'all-time.json');
  let existing = null;
  try { existing = readJson(allTimePath); } catch {}
  allTimeOut = {};
  const fresh = serialise(allTime);
  for (const cat of ALL_TIME_CATS) {
    const freshUuids = new Set(fresh[cat].map(e => e.uuid));
    const retained   = existing ? (existing[cat] || []).filter(e => !freshUuids.has(e.uuid)) : [];
    // ⚠️ THE OVERSHOOT MUST SURVIVE THE MERGE. Measured 2026-10-16: this line read
    // `new TopN(ALL_TIME_LIMIT)`, so the spare depth the two single-game heaps carry
    // was discarded here, BEFORE verifyGameRecords() ran — and an active-only run
    // published 1,849 of 2,000 maxGamePTS instead of backfilling the 151 it removed.
    // The board silently lost its tail. Verification runs after this block, so the
    // depth has to be here too.
    const merged = new TopN(RECORD_CATS.includes(cat) ? ALL_TIME_LIMIT * RECORD_OVERSHOOT : ALL_TIME_LIMIT);
    for (const e of [...retained, ...fresh[cat]]) merged.push(e);
    allTimeOut[cat] = merged.result();
  }
} else {
  allTimeOut = serialise(allTime);
  for (const [cat, entries] of Object.entries(allTimeOut)) {
    console.log(`  ${cat}: ${entries.length} entries`);
  }
}

// Verify the single-game boards against the games' own scorelines, AFTER the
// active-only merge so retained entries are checked too. See verifyGameRecords().
console.log('\n  Verifying single-game records against game scorelines...');
const gameLookup = makeLookup(ROOT);
verifyGameRecords(allTimeOut, gameLookup);
console.log(`    (${gameLookup.stats.seasonsRead} season game files read`
  + `, ${gameLookup.stats.seasonsMissing} not held)`);

if (!DRY_RUN) writeJson(path.join(ROOT, 'leaderboard', 'all-time.json'), allTimeOut);
console.log('  Wrote leaderboard/all-time.json');

// ─── PASS 2: per-season (one season at a time) ───────────────────────────────

console.log('\n── Pass 2: per-season leaderboards ─────────────────────────');

// Build sid→[uuid] map from player index history — covers ALL 2,792 seasons
// regardless of whether team-stats files are populated. Same source of truth
// as team-stats (both derived from player.seasons[].regs[]) but authoritative.
const indexDir   = path.join(ROOT, 'players', 'indexes');
const sidToUuids = new Map();
console.log('  Building season→player map from index shards...');
for (const fname of fs.readdirSync(indexDir).filter(f => f.endsWith('.json')).sort()) {
  let shard;
  try { shard = readJson(path.join(indexDir, fname)); } catch { continue; }
  for (const [uuid, entry] of Object.entries(shard)) {
    for (const sid of Object.keys(entry.history || {})) {
      if (!sidToUuids.has(sid)) sidToUuids.set(sid, []);
      sidToUuids.get(sid).push(uuid);
    }
  }
}
console.log(`  ${sidToUuids.size} seasons found across index shards`);

const seasonIds = [...(targetSids || new Set(Object.keys(readJson(path.join(ROOT, 'data', 'sports-index.json')).seasons)))];
console.log(`  ${seasonIds.length} season files to process`);

// Load pass 2 progress — resume from last committed point. MODE-KEYED: progress
// from a full run must not gate an active-only run's writes or vice versa.
let doneSids = new Set();
if (FORCE_FULL && fs.existsSync(PASS2_PROGRESS)) {
  if (!DRY_RUN) fs.unlinkSync(PASS2_PROGRESS);
  console.log('  --force: progress file cleared, full rebuild');
} else if (fs.existsSync(PASS2_PROGRESS)) {
  try {
    const loaded = readJson(PASS2_PROGRESS);
    if ((loaded.mode || 'full') === MODE) doneSids = new Set(loaded.done || []);
    else console.log(`  Progress file is from a '${loaded.mode || 'full'}' run — discarding (this run is '${MODE}')`);
  } catch {}
  if (doneSids.size > 0) console.log(`  Resuming — ${doneSids.size} season files already done`);
}

let seasonFilesWritten = 0;
let seasonFilesSkipped = 0;
let sinceLastCommit    = 0;

for (const sid of seasonIds) {
  if (doneSids.has(sid)) { seasonFilesSkipped++; continue; }

  const uuids = sidToUuids.get(sid) || [];
  if (uuids.length === 0) { doneSids.add(sid); seasonFilesSkipped++; continue; }

  const players = {};
  for (const uuid of uuids) {
    const player = readPlayer(uuid);
    if (!player) continue;
    pushSeason(players, player, sid, uuid);
  }

  const out     = { players };
  const hasData = Object.keys(players).length > 0;
  if (!hasData) { doneSids.add(sid); seasonFilesSkipped++; continue; }

  if (!DRY_RUN) writeJson(path.join(ROOT, 'leaderboard', 'season', `${sid}.json`), out);
  doneSids.add(sid);
  seasonFilesWritten++;
  sinceLastCommit++;

  if (sinceLastCommit >= COMMIT_INTERVAL) {
    if (!DRY_RUN) {
      writeJson(PASS2_PROGRESS, { mode: MODE, done: [...doneSids] });
      gitCommit(
        `build-leaderboards: pass 2 — ${seasonFilesWritten} season files written`,
        ['leaderboard/season/', 'scripts/.build-leaderboards-progress.json']
      );
    }
    sinceLastCommit = 0;
    console.log(`  ${seasonFilesWritten + seasonFilesSkipped} of ${seasonIds.length} seasons done (${seasonFilesWritten} written)...`);
  }
}

// Pass 2 completed — delete the progress file (progress files delete on SUCCESS
// only; the mid-run commits above preserve it for resume after a timeout/kill).
// Pre-fix, this file was never deleted, so a completed run left every sid
// marked done and each subsequent run silently no-op'd unless --force was
// passed — fatal for a recurring active-only chain from its second run on.
if (!DRY_RUN && fs.existsSync(PASS2_PROGRESS)) fs.unlinkSync(PASS2_PROGRESS);

// ─── commit ──────────────────────────────────────────────────────────────────

if (!DRY_RUN) {
  const label = ACTIVE_ONLY ? 'active seasons' : 'full rebuild';
  gitCommit(
    `build-leaderboards: ${label} — ${seasonFilesWritten} season files`,
    ['leaderboard/', 'scripts/.build-leaderboards-progress.json']
  );
}

// ─── summary ─────────────────────────────────────────────────────────────────

console.log('\n─── Summary ─────────────────────────────────────────────────');
console.log(`  Mode                     : ${ACTIVE_ONLY ? 'ACTIVE ONLY' : 'FULL'}${DRY_RUN ? ' + DRY RUN' : ''}`);
console.log(`  Players scanned (pass 1) : ${playerCount}`);
console.log(`  Per-season files written : ${seasonFilesWritten}`);
console.log(`  Per-season files skipped : ${seasonFilesSkipped} (no player history)`);
const agePct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';
const ageSeasonTot  = ageDerived.season  + ageEmpty.season;
const ageAllTimeTot = ageDerived.allTime + ageEmpty.allTime;
console.log(`  Age group resolved       : ${ageDerived.season} of ${ageSeasonTot} season entries (${agePct(ageDerived.season, ageSeasonTot)})`
          + `, ${ageDerived.allTime} of ${ageAllTimeTot} all-time (${agePct(ageDerived.allTime, ageAllTimeTot)})`);
// ⚠️ ZERO IS THE OLD BUG RETURNING. Before 2026-11-28 every entry's age was '' and
// nothing said so, so the Leaderboards age filter held one option and nobody knew.
if (ageSeasonTot && !ageDerived.season) {
  console.log('  ⚠ NOT ONE season entry resolved an age group — the Leaderboards age filter will be');
  console.log('    empty. Check scripts/lib/grade-age.cjs against index.html grParse before trusting this run.');
}
