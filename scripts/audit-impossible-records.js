// scripts/audit-impossible-records.js
//
// READ-ONLY. Finds every player whose STORED single-game record is impossible:
// a maxGamePTS higher than any team scored in the game the record was set in,
// or a maxGameThreePt above that score divided by three. Writes nothing to data,
// commits nothing, makes no PlayHQ calls.
//
// ── WHY (REPO_MANIFEST §6.84) ────────────────────────────────────────────────
// build-leaderboards.js now refuses to PUBLISH these, which fixes the board. It
// does not fix the player files: `maxGamePTS` is written once by
// fetch-profile-stats.js and never recomputed, and `statsChecked` stops the
// player being fetched again. So a contaminated 102 stays on the player file,
// and on their StatTrack profile, indefinitely. fetch-profile-stats.js now drops
// impossible lines at parse time — but only on a FETCH. This produces the list
// of players that need one.
//
// ── TWO PASSES, AND WHY IT IS NOT ONE ────────────────────────────────────────
// ⚠️ THE FIRST VERSION OF THIS SCRIPT CHECKED EACH RECORD AS IT MET IT. That asks
// for a different season on almost every player, and the game-score lookup holds
// 12 seasons out of 3,554 — a cache miss, and a full season game file re-read and
// re-parsed, per record. Run 2026-10-17 it reached 100,000 of 434,059 players in
// 90 minutes and was killed by the job timeout having written nothing. The work
// was never the player walk; it was ~200,000 redundant season-file parses.
//
// Pass 1 reads players/ and touches NO game file: it collects (uuid, name, cat,
// v, sid, gk) for every stored record. Pass 2 groups those by sid and resolves
// them a season at a time, so every season file is read AT MOST ONCE — which is
// why the lookup is built with cacheSeasons: 1. ~3,554 reads instead of ~200,000,
// and the order is what makes a cache of one sufficient.
//
// Both passes print elapsed time. If this job ever slows down again, the phase
// timings say immediately which half did it.
//
// ── OUTPUT ───────────────────────────────────────────────────────────────────
// reports/impossible-records.csv — uuid,name,category,stored,ceiling,
// game_max_score,gameKey,sid. The uuid column feeds populate-players.js
// --from-csv=, which clears statsChecked for exactly those players.
//
// ⚠️ IT COMMITS THAT FILE. The first version did not: the workflow ran at
// `contents: read` and uploaded the CSV as a build artifact, so the only way to
// get it to populate-players.js — whose --from-csv= reads a REPO PATH — was to
// download the artifact and re-upload it by hand between two workflows. A report
// that exists only as an artifact cannot be consumed by the tool it was built to
// feed. It is one file under reports/, which is what audit-uuid-collisions.js and
// audit-aliases-against-playhq.js already do, and --no-commit still produces the
// local file without touching git.
//
// The CSV is written even when the offender list is EMPTY, and even when pass 2
// is interrupted — a header-only file is a result ("nothing impossible"), the
// absence of a file is a failure, and the two must not look alike.
//
// A record whose game cannot be checked (no gameKey, season file not held, hs/as
// not both numbers) is NOT an offender. It is unverifiable, counted separately
// and never written to the CSV.
//
// Usage:
//   node scripts/audit-impossible-records.js
//   node scripts/audit-impossible-records.js --limit=40
//   node scripts/audit-impossible-records.js --min=0

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync }   = require('child_process');
const { makeLookup } = require('./lib/game-scores.cjs');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const LIMIT = Math.max(1, parseInt(ARGS.limit || '40', 10));
// An overage of 0 means stored === ceiling, which is legal: a player can score
// every point their team scored. Only a STRICTLY greater value is impossible.
const MIN_OVER = Math.max(0, parseInt(ARGS.min || '0', 10));
// Games whose top team score is below this are treated as UNVERIFIABLE rather than
// as a cap. A stored 0 is already null in game-scores.cjs (an absent scoreline, not
// a played game); this raises the floor above that. 2026-10-17 the first full run
// reported caps of 2 and 4 behind 43- and 40-point records — a basketball game that
// finished 2-0 is a scoreline problem, not a stats problem, and the two must not be
// reported as the same thing. The default stays 1 (trust every non-zero scoreline)
// because where the real floor sits is a judgement about this corpus; the cap
// distribution printed at the end is the evidence for choosing it.
const MIN_CAP  = Math.max(1, parseInt(ARGS['min-cap'] || '1', 10));
const NO_COMMIT = !!ARGS['no-commit'];
// --ratios: cross-check EVERY stored record against its box score, not only the
// ones that fail the team-score test. 2026-10-19: Ruben Greer's stored
// maxGamePTS of 32 against a box score of 16 in game bc5822b6 — exactly 2x, in a
// game PlayHQ flags HIDDEN GRADE. If regraded games double-count in
// publicProfileStatistics then the inflation is NOT confined to records that
// happen to exceed a team score; it reaches season and career totals for every
// player in every regraded game, and only a full scan can show that.
const RATIOS    = !!ARGS.ratios;

const PLAYERS_DIR = path.join(ROOT, 'players');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_CSV     = path.join(REPORTS_DIR, 'impossible-records.csv');

// cacheSeasons: 1 — pass 2 is ordered by sid, so one slot is all it needs, and
// asking for more would invite the scattered-access thrash described above.
// minScore: 1 — this script reports the raw scoreline and applies MIN_CAP itself,
// because it exists to show the two populations SEPARATELY (fabricated stats vs
// games whose scoreline is a placeholder). Every other caller takes the shared
// MIN_TRUSTED_SCORE default in game-scores.cjs; do not copy this opt-out.
const lookup = makeLookup(ROOT, { cacheSeasons: 1, minScore: 1, box: true });

const CATS = ['maxGamePTS', 'maxGameThreePt'];

// maxGameThreePt counts 3-POINTERS, not points, so its ceiling is the team score
// divided by three. Comparing a 3PT COUNT against a points total would let a
// fabricated 34 through on a 20-0 game.
function ceilingFor(cat, cap) {
  return cat === 'maxGameThreePt' ? Math.floor(cap / 3) : cap;
}

// Commit discipline copied from update-team-index.js L71-104, which is the
// CORRECTED house pattern: one file named explicitly (never `git add -A`),
// --shortstat never --stat, merge with --no-stat, commit BEFORE merge, and a push
// retry that THROWS when exhausted. The version in audit-uuid-collisions.js wraps
// the whole thing in a try/catch that prints and returns — a failed push there
// exits ZERO and the job shows green having written nothing. Do not copy that one.
const GIT_OPTS      = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const PUSH_ATTEMPTS = 60;

// Returns true only when a commit was actually pushed. The caller must not claim
// the CSV is available to populate-players on anything else.
function gitCommit(message) {
  if (NO_COMMIT) { console.log(`  [--no-commit] would commit: ${message}`); return false; }

  // ⚠️ -f IS REQUIRED, AND ITS ABSENCE FAILED SILENTLY. 2026-10-19: the first run
  // wrote 215 rows, uploaded 8,506 bytes as an artifact, printed
  // "staging: no changes — nothing to commit" and then printed the SUCCESS line
  // telling the operator to go and use a file that was never committed. The repo
  // ignores reports/, so a plain `git add` on that path matches nothing and exits
  // ZERO — git does not treat "everything you named is ignored" as an error.
  // Some files under reports/ are tracked from before the rule, which is why the
  // directory looks committed.
  execSync('git add -f -- reports/impossible-records.csv', GIT_OPTS);

  const shortstat = execSync('git diff --staged --shortstat', GIT_OPTS).toString().trim();
  if (!shortstat) {
    // Empty staging has two causes and they are not the same event. Identical
    // content already on main is a clean no-op; a file git is not tracking at all
    // means the add did nothing and the report is unreachable — which must be loud.
    let tracked = true;
    try { execSync('git ls-files --error-unmatch -- reports/impossible-records.csv', GIT_OPTS); }
    catch (_) { tracked = false; }

    if (!tracked) {
      let rule = '';
      try { rule = execSync('git check-ignore -v -- reports/impossible-records.csv', GIT_OPTS).toString().trim(); }
      catch (_) {}
      throw new Error('reports/impossible-records.csv was written but git is not tracking it, '
        + 'so populate-players cannot read it.'
        + (rule ? ` Ignore rule: ${rule}` : ' No ignore rule reported — check the checkout.'));
    }

    console.log('  staging: no changes — the committed CSV is already identical');
    return true;
  }
  console.log(`  staging: ${shortstat}`);

  execSync(`git commit -m "${message.replace(/"/g, "'")}"`, GIT_OPTS);

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try {
      execSync('git fetch origin main', GIT_OPTS);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT_OPTS);
      execSync('git push origin main', GIT_OPTS);
      console.log(`  ✔ pushed (attempt ${attempt}): ${message}`);
      return true;
    } catch (e) {
      const detail = (e.stderr || e.stdout || '').toString().trim() || e.message;
      if (attempt === PUSH_ATTEMPTS) throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${detail}`);
      const wait = 1 + Math.floor(Math.random() * 90);
      console.log(`  … push contention (attempt ${attempt}) — retry in ${wait}s`);
      execSync(`sleep ${wait}`, { stdio: 'ignore' });
    }
  }
}

function hhmmss(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function writeCsv(offenders) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const rows = ['uuid,name,category,stored,ceiling,game_max_score,box_pts,gameKey,sid'];
  for (const o of offenders) {
    rows.push([o.uuid, JSON.stringify(o.name || ''), o.cat, o.v, o.ceiling, o.cap,
               (o.box === null || o.box === undefined) ? '' : o.box, o.gk, o.sid].join(','));
  }
  fs.writeFileSync(OUT_CSV, rows.join('\n') + '\n');
}

function main() {
  const t0 = Date.now();
  console.log('audit-impossible-records.js   READ-ONLY');
  console.log('─'.repeat(60));

  const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  if (!prefixes.length) { console.error('no player shards found'); process.exit(1); }

  // ── PASS 1 — players only. No game file is opened here. ───────────────────
  console.log(`Pass 1: collecting stored records from ${prefixes.length} shards (no game files read)`);
  const bySid   = new Map();   // sid -> [{uuid,name,cat,v,gk}]
  let scanned = 0, withRecord = 0, unverifiable = 0;

  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS_DIR, prefix);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (_) { continue; }
    for (const fname of files) {
      let player;
      try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); }
      catch (_) { continue; }
      scanned++;

      for (const cat of CATS) {
        const rec = player.records && player.records[cat];
        const v   = rec && rec.v;
        if (typeof v !== 'number' || v <= 0) continue;
        withRecord++;

        const sid = rec.sid || null;
        const gk  = rec.gameKey || null;
        if (!sid || !gk) { unverifiable++; continue; }

        if (!bySid.has(sid)) bySid.set(sid, []);
        bySid.get(sid).push({ uuid: fname.replace('.json', ''), name: player.name || '', cat, v, gk });
      }

      if (scanned % 50000 === 0) {
        console.log(`  ${scanned.toLocaleString()} players scanned  (${hhmmss(Date.now() - t0)})`);
      }
    }
  }

  const t1 = Date.now();
  const pending = [...bySid.values()].reduce((n, a) => n + a.length, 0);
  console.log(`  ${scanned.toLocaleString()} players scanned, ${withRecord.toLocaleString()} stored records`);
  console.log(`  ${pending.toLocaleString()} checkable across ${bySid.size.toLocaleString()} seasons`
    + `, ${unverifiable.toLocaleString()} carry no sid/gameKey`);
  console.log(`  Pass 1 took ${hhmmss(t1 - t0)}`);

  // ── PASS 2 — one season at a time, each file read at most once. ───────────
  console.log(`\nPass 2: resolving against ${bySid.size.toLocaleString()} season game files`);
  const offenders = [];
  let seasonsDone = 0, lowCap = 0;
  // Box-score reconciliation. `box` is what the SPECTATOR endpoint recorded for
  // this player in this game; `v` is what publicProfileStatistics gave us. Two
  // independent sources for the same fact, and where they disagree the ratio
  // between them is the diagnostic — an exact small-integer multiple is a
  // double-count, anything else is a different fault.
  const ratioHist = new Map();     // ratio (2dp) -> count, --ratios only
  let ratioChecked = 0, ratioNoBox = 0, ratioExact = 0, ratioViaAlias = 0;
  const perCat = { maxGamePTS: { n: 0, eq: 0 }, maxGameThreePt: { n: 0, eq: 0 } };

  // An exact integer multiple only means something at a magnitude where it is
  // unlikely by chance. 2026-10-19: the first run's "exact multiples" were
  // stored 4 / box 2, stored 8 / box 4, stored 6 / box 2 — small numbers that
  // land on a whole ratio constantly. Flagging those as evidence of
  // double-counting is reading noise. Counted either way, reported separately.
  const RATIO_MIN_BOX = 10;
  const RATIO_SAMPLES = [];
  let multSmall = 0, multLarge = 0;

  function noteRatio(it, sid, line) {
    if (line === null) { ratioNoBox++; return; }
    ratioChecked++;
    if (line.via === 'alias') ratioViaAlias++;

    // Compare like with like: maxGamePTS against the box's POINTS, and
    // maxGameThreePt against its 3-POINTER COUNT. Mixing them is what produced
    // the meaningless 50.0% split on the first run.
    const box = (it.cat === 'maxGameThreePt') ? line.pt3 : line.pts;
    if (box === null || box === undefined) { ratioNoBox++; ratioChecked--; return; }

    const c = perCat[it.cat];
    if (c) c.n++;
    if (box === it.v) { ratioExact++; if (c) c.eq++; return; }
    if (it.cat !== 'maxGamePTS') return;      // ratios only meaningful on points

    const r = box > 0 ? Math.round((it.v / box) * 100) / 100 : null;
    if (r === null) return;
    ratioHist.set(r, (ratioHist.get(r) || 0) + 1);
    if (Number.isInteger(r) && r >= 2) {
      if (box >= RATIO_MIN_BOX) {
        multLarge++;
        if (RATIO_SAMPLES.length < 20) {
          RATIO_SAMPLES.push(`    stored ${String(it.v).padStart(4)}  box ${String(box).padStart(4)}`
            + `  x${r}  ${it.name || it.uuid}  game ${it.gk} (season ${sid})`);
        }
      } else {
        multSmall++;
      }
    }
  }

  for (const [sid, items] of bySid) {
    for (const it of items) {
      if (RATIOS) noteRatio(it, sid, lookup.boxLine(sid, it.gk, it.uuid));
      const cap = lookup.maxScore(sid, it.gk);
      if (cap === null) { unverifiable++; continue; }
      if (cap < MIN_CAP) { lowCap++; unverifiable++; continue; }
      const ceiling = ceilingFor(it.cat, cap);
      if (it.v > ceiling + MIN_OVER) {
        const line = lookup.boxLine(sid, it.gk, it.uuid);
        const box  = line ? (it.cat === 'maxGameThreePt' ? line.pt3 : line.pts) : null;
        offenders.push({ uuid: it.uuid, name: it.name, cat: it.cat, v: it.v, ceiling, cap, gk: it.gk, sid,
                         box: (box === undefined ? null : box), via: line ? line.via : null });
      }
    }
    seasonsDone++;
    if (seasonsDone % 500 === 0) {
      console.log(`  ${seasonsDone.toLocaleString()}/${bySid.size.toLocaleString()} seasons`
        + `  ${offenders.length} impossible so far  (${hhmmss(Date.now() - t1)})`);
      writeCsv(offenders);   // partial result survives a timeout (local file only — gitCommit runs once, at the end)
    }
  }

  const t2 = Date.now();
  console.log(`  Pass 2 took ${hhmmss(t2 - t1)}`);
  console.log(`  ${lookup.stats.seasonsRead} season game files read, ${lookup.stats.seasonsMissing} not held`);

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`  ${scanned.toLocaleString()} players scanned`);
  console.log(`  ${withRecord.toLocaleString()} stored single-game records`);
  console.log(`  ${unverifiable.toLocaleString()} unverifiable (no gameKey/sid, game not held, or no scoreline)`);
  console.log(`  ${offenders.length.toLocaleString()} IMPOSSIBLE`);
  console.log('');

  if (lowCap) {
    console.log(`  ${lowCap.toLocaleString()} of those sat behind a scoreline under --min-cap=${MIN_CAP}`);
    console.log('');
  }

  // The cap distribution is the evidence for where --min-cap belongs. A cluster of
  // offenders against caps of 2 or 4 is a scoreline problem in those game files; a
  // cluster against 20 is the forfeit convention carrying fabricated stat lines.
  if (offenders.length) {
    const byCap = new Map();
    for (const o of offenders) byCap.set(o.cap, (byCap.get(o.cap) || 0) + 1);
    const rows = [...byCap.entries()].sort((a, b) => a[0] - b[0]);
    console.log('  offenders by the game\'s top team score:');
    let under = 0, atOrOver = 0;
    for (const [cap, n] of rows) {
      if (cap < 20) under += n; else atOrOver += n;
    }
    // Every cap below 20 is listed in full — truncating this table is what hid the
    // shape on 2026-10-17, where a single bucket held 46% of the offenders.
    for (const [cap, n] of rows.filter(r => r[0] < 20)) {
      console.log(`    top score ${String(cap).padStart(4)}  ${String(n).padStart(6)} record(s)   <- suspect SCORELINE, not stats`);
    }
    console.log(`    top score  >=20  ${String(atOrOver).padStart(6)} record(s)`);
    console.log(`    ── under 20: ${under}   20 and over: ${atOrOver}`);
    console.log('');

    // A scoreline problem is systematic per season; fabricated stat lines are not.
    // Clustering the low-cap offenders by season says which one this is.
    const lowBySeason = new Map();
    for (const o of offenders) {
      if (o.cap >= 20) continue;
      lowBySeason.set(o.sid, (lowBySeason.get(o.sid) || 0) + 1);
    }
    if (lowBySeason.size) {
      const top = [...lowBySeason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      console.log(`  low-scoreline offenders cluster across ${lowBySeason.size} season(s); worst:`);
      for (const [sid, n] of top) console.log(`    ${sid}  ${String(n).padStart(5)} record(s)`);
      console.log('');
    }
  }

  offenders.sort((a, b) => (b.v - b.ceiling) - (a.v - a.ceiling));
  if (!offenders.length) {
    console.log('  No impossible stored records. (A header-only CSV is still written.)');
  } else {
    // Three-way reconciliation. Comparing a stored record against the TEAM SCORE
    // alone can only say "these disagree"; it cannot say which half is wrong. The
    // box score is a second, independent record of the same player-game, so:
    //   box == stored  -> the player really did score it; the SCORELINE is the bad
    //                     half, and the repair belongs to the game file
    //   box <  stored  -> the stored value is inflated; an exact integer multiple
    //                     points at double-counting in publicProfileStatistics
    //   no box         -> genuinely unverifiable, and must not be called impossible
    const verdictOf = (o) => {
      if (o.box === null)   return 'NO BOX LINE — unverifiable';
      if (o.box === o.v)    return 'box AGREES — scoreline is the bad half';
      const r = o.box > 0 ? o.v / o.box : null;
      if (r && Number.isInteger(r) && r >= 2) return `box ${o.box} — stored is EXACTLY x${r}`;
      return `box ${o.box} — differs (no clean ratio)`;
    };
    console.log(`  worst ${Math.min(LIMIT, offenders.length)}:`);
    console.log(`    ${'stored'.padStart(7)} ${'ceiling'.padStart(8)}  ${'cat'.padEnd(15)} name / game`);
    for (const o of offenders.slice(0, LIMIT)) {
      console.log(`    ${String(o.v).padStart(7)} ${String(o.ceiling).padStart(8)}  ${o.cat.padEnd(15)} `
        + `${o.name || o.uuid}  game ${o.gk} (season ${o.sid}, top team score ${o.cap})`);
      console.log(`    ${' '.repeat(17)} -> ${verdictOf(o)}`);
    }

    const byVerdict = new Map();
    for (const o of offenders) {
      const k = verdictOf(o).replace(/box \d+ /, 'box ').replace(/x\d+/, 'xN');
      byVerdict.set(k, (byVerdict.get(k) || 0) + 1);
    }
    console.log('');
    console.log('  offenders by box-score reconciliation:');
    for (const [k, n] of [...byVerdict.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(6)}  ${k}`);
    }
    if (offenders.length > LIMIT) console.log(`    ... and ${offenders.length - LIMIT} more`);
  }

  if (RATIOS) {
    console.log('');
    console.log('── Box-score cross-check across EVERY stored record ──────────');
    console.log(`  checked against a box score : ${ratioChecked.toLocaleString()}`
      + `   (${ratioViaAlias.toLocaleString()} matched only after alias resolution)`);
    console.log(`  no box line for that player : ${ratioNoBox.toLocaleString()}`);
    console.log(`  stored == box               : ${ratioExact.toLocaleString()}`
      + (ratioChecked ? `  (${(ratioExact / ratioChecked * 100).toFixed(1)}%)` : ''));
    const mism = ratioChecked - ratioExact;
    console.log(`  stored != box               : ${mism.toLocaleString()}`);
    // Split by category, because they are compared against different fields and
    // a combined rate hides which one disagrees.
    for (const [cat, c] of Object.entries(perCat)) {
      if (!c.n) continue;
      const field = cat === 'maxGameThreePt' ? 'box pt3' : 'box pts';
      console.log(`      ${cat.padEnd(15)} vs ${field}: ${c.n.toLocaleString()} checked, `
        + `${c.eq.toLocaleString()} equal (${(c.eq / c.n * 100).toFixed(1)}%)`);
    }
    if (ratioHist.size) {
      const rows = [...ratioHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
      console.log('');
      console.log('  stored/box ratio, most common first (maxGamePTS only):');
      for (const [r, n] of rows) {
        const flag = Number.isInteger(r) && r >= 2 ? '   <- EXACT MULTIPLE' : '';
        console.log(`    x${String(r).padEnd(6)} ${String(n).padStart(7)}${flag}`);
      }
    }
    console.log('');
    console.log(`  exact integer multiples, box >= ${RATIO_MIN_BOX} : ${multLarge.toLocaleString()}`
      + '   <- the only ones that mean anything');
    console.log(`  exact integer multiples, box <  ${RATIO_MIN_BOX} : ${multSmall.toLocaleString()}`
      + '   (small-number coincidence, not evidence)');
    if (RATIO_SAMPLES.length) {
      console.log('');
      console.log(`  samples (box >= ${RATIO_MIN_BOX}):`);
      RATIO_SAMPLES.forEach(l => console.log(l));
    }
    console.log('');
    console.log('  READ THIS AS A DISTRIBUTION, NOT A LIST. Double-counting in the source');
    console.log('  would make x2 DOMINATE the mismatches. A handful of exact multiples');
    console.log('  spread across thousands of distinct ratios is what chance looks like,');
    console.log('  and is evidence AGAINST a systematic multiplier.');
  }

  writeCsv(offenders);
  console.log(`\n  Wrote ${path.relative(ROOT, OUT_CSV)} (${offenders.length} rows)`);
  // ⚠️ THE NEXT-STEP LINE IS GATED ON THE COMMIT ACTUALLY HAPPENING. It used to
  // print unconditionally, directly under "staging: no changes — nothing to
  // commit", telling the operator to run the next workflow against a path that
  // was not on main. A success message over a no-op is the exact failure this
  // repo's own traps are about.
  const committed = gitCommit(`audit-impossible-records: ${offenders.length} impossible (min-cap ${MIN_CAP})`);
  if (committed) {
    console.log('  Now run Populate Players with from_csv=reports/impossible-records.csv — it is committed.');
  } else {
    console.log('  --no-commit: this CSV is NOT on main, so populate-players --from-csv= cannot read it.');
  }
  console.log(`  Total ${hhmmss(Date.now() - t0)}`);
}

main();
