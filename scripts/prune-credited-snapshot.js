// scripts/prune-credited-snapshot.js
//
// Reconciles sports.Basketball.c and .x against player.games[].
// DRY RUN BY DEFAULT — writes nothing without --apply.
//
// ─── WHAT IS WRONG, AND WHY THIS EXISTS ──────────────────────────────────────
// fetch-profile-stats.js (L1447-1462) builds the set of games PlayHQ credits to
// a player and diffs it against player.games AS IT STOOD AT THAT MOMENT:
//
//   c  PlayHQ credits it, games[] does not hold it
//   x  games[] holds it, PlayHQ does not credit it, not a forfeit
//
// Both are rewritten in full on every fetch and deleted when empty. The diff is
// correct when it is written and decays immediately, because games[] is rebuilt
// only by build-player-games.js, weekly, while fetches run every night. That
// script's own comment states the contract: "A consumer must treat c as 'worth
// checking', not as 'definitely missing'."
//
// StatTrack renders c under "Games we are missing — Credited by PlayHQ, not in
// our record", which is the stronger claim the field was never written to make.
//
// Measured by probe-credited-snapshot.js on shards 00,01 (2026-11-19):
//   6,697 c entries across 1,761 players
//   2,077 (31.0%) name a game we hold — but across 1,649 players, 93.6% of
//         everyone carrying c
//   1,058 players (60.1%) have a c list consisting of ONE entry we already hold
//   1,503 of the 2,077 were already in games[]; 574 were in games/bv awaiting
//         the weekly rebuild, 99.1% of them under 7 days old
//
// The 1,503 are frozen: a player's c is only recomputed when they are fetched,
// and they are only fetched when they play. For anyone who has stopped playing,
// the wrong panel is permanent. Nothing in the nightly path reaches them.
//
// ─── WHY IT READS ONLY games[] ───────────────────────────────────────────────
// "Do we hold this game for this player" is decided by build-player-games.js,
// which resolves every p[] id in games/bv through resolveToFullUuid and writes
// the result as games[]. AFTER that script has run, games[] IS that answer.
//
// So this tool re-derives nothing. It does not scan games/bv, does not resolve
// roster ids, and holds no second copy of a predicate that lives elsewhere —
// which is the duplication T14 and T24 are about. It reads one field of the
// file it is already opening.
//
// ─── THE ORDERING REQUIREMENT, AND WHY GETTING IT WRONG IS SAFE ──────────────
// It must run AFTER build-player-games.js, chained by `needs:` (T29), with
// `ref: main` on its checkout so it sees that job's pushes (T21).
//
// Run too early — before a rebuild, or while one is mid-flight — and games[] is
// short, so fewer entries qualify and it prunes LESS. It can never prune MORE:
// a gid in games[] is there because the player was resolved onto that game's
// roster in games/bv, so "we hold it" is true by construction. The failure
// direction is under-pruning, never mis-pruning, and a later run finishes the
// job. Nothing here needs the ordering to be right in order to be SAFE; it
// needs it to be COMPLETE.
//
// ─── x IS GUARDED, c IS NOT ──────────────────────────────────────────────────
// A stale c entry is one games[] now holds. A stale x entry is one games[] no
// longer holds — which is also what an EMPTY or ABSENT games[] looks like. A
// player mid-rebuild, or one whose rebuild failed, would have their whole x
// wiped on that reading. So x is skipped entirely when games[] is absent or
// empty, and those players are counted and named. Failing toward doing less
// (T3). c needs no such guard: an empty games[] prunes nothing from c.
//
// x measured 0 stale of 567 on shards 00,01, so this is expected to be a no-op.
// It is here because it is the same test on the same pass and leaving one half
// of a two-sided field unreconciled is how the halves drift apart.
//
// ─── THE INVARIANT CHECK ─────────────────────────────────────────────────────
// Every file this tool writes must differ from what it read in sports.
// Basketball.c and .x and NOWHERE ELSE. That is asserted per player by
// stripping both fields from the before and after images and comparing: a
// player that fails is REFUSED, left untouched, counted and named. A repair
// that can only ever touch two array fields should be able to prove it did.
//
// ─── USAGE ───────────────────────────────────────────────────────────────────
//   node --max-old-space-size=4096 scripts/prune-credited-snapshot.js
//   node --max-old-space-size=4096 scripts/prune-credited-snapshot.js --shards=00,01
//   node --max-old-space-size=4096 scripts/prune-credited-snapshot.js --apply
//
//   --apply       write and commit. Without it NOTHING is written.
//   --shards=XX,YY  limit to these player shard dirs.
//   --examples=N  per-bucket example cap (default 8).
//   --force       ignore the resume file and start from the first shard.
//   --out=PATH    JSON report path (default /tmp/prune-credited-snapshot.json).

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const VERSION = 'prune-credited-snapshot.js v1.1.0 (2026-11-20) — REPLACES v1.0.0: refuses to run on an unrecognised argument. Pruning behaviour is UNCHANGED.';

const ROOT = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.prune-credited-snapshot-progress.json');
const BPG_PROGRESS = path.join(ROOT, 'scripts', '.build-player-games-progress.json');

const COMMIT_INTERVAL = 8;   // prefix dirs per commit — build-player-games' value
const PUSH_ATTEMPTS = 60;

// ---------------------------------------------------------------- arguments

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;
const FORCE = process.argv.includes('--force');
const EXAMPLE_CAP = Number(argValue('examples', '8'));
const OUT_PATH = argValue('out', '/tmp/prune-credited-snapshot.json');
const SHARD_FILTER = (() => {
  const raw = argValue('shards', '');
  if (!raw.trim()) return null;
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
})();

if (!Number.isFinite(EXAMPLE_CAP) || EXAMPLE_CAP < 1) {
  console.error(`FATAL: --examples must be a positive number, got "${argValue('examples', '')}"`);
  process.exit(2);
}

// An argument this script does not understand is a FAILURE, not a no-op.
// This one writes, so the stakes are higher than in the probe: a mistyped
// `--shard=00` would be silently ignored and the run would sweep ALL 256
// shards. Refuse instead.
{
  const KNOWN_FLAGS = new Set(['--apply', '--force']);
  const KNOWN_VALUE_ARGS = ['--shards', '--examples', '--out'];
  const unknown = process.argv.slice(2).filter((a) =>
    !KNOWN_FLAGS.has(a) && !KNOWN_VALUE_ARGS.some((k) => a.startsWith(`${k}=`))
  );
  if (unknown.length) {
    console.log(VERSION);
    console.error(`\nFATAL: unrecognised argument(s): ${unknown.join(' ')}`);
    console.error(`Known: ${[...KNOWN_FLAGS].join(' ')} ${KNOWN_VALUE_ARGS.map((k) => k + '=').join(' ')}`);
    console.error('Refusing to run — an ignored flag looks exactly like one that worked.');
    process.exit(2);
  }
}

// ------------------------------------------------------------------ helpers

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
// Player files are stored MINIFIED — JSON.stringify with no indent, exactly as
// fetch-profile-stats.js writePlayer() and build-player-games.js writeJson() do.
// Pretty-printing here would rewrite every byte of every file it touches.
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

function fmt(n) { return n.toLocaleString('en-AU'); }
function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : '0.0%'; }

// ─── House git pattern ────────────────────────────────────────────────────────
// Copied from build-player-games.js, the writer this tool is chained behind, and
// kept byte-equivalent in behaviour: per-path staging in its own try/catch
// (`git add` is ATOMIC across pathspecs — one unmatched path stages NOTHING,
// the shape that discarded a 28-minute discover-fixtures run), printed
// shortstat, COMMIT BEFORE MERGE, 60-attempt pure-jitter push retry, and a
// THROW when exhausted so a lost push is a red job rather than silently
// discarded work.
//
// EVERY git call carries a timeout and a maxBuffer. execSync is SYNCHRONOUS and
// blocks the event loop, so nothing can time it out from outside; a stalled
// fetch or push against a 6 GB repo otherwise hangs until the workflow ceiling
// kills it, with no output and no retry (T35). maxBuffer because git output
// across 418k files exceeds the 1 MB default (T26).
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_MAXBUF = 512 * 1024 * 1024;
const GIT_OPTS = { cwd: ROOT, stdio: 'pipe', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAXBUF };

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

  // --shortstat, never --stat: --stat prints a per-file line and scales with
  // file count, a real ENOBUFS risk on a repo this size.
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
      // --no-stat for the same ENOBUFS reason as --shortstat above.
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

// The invariant: the only thing that may differ between the file read and the
// file written is sports.Basketball.c and .x.
function stripCX(raw) {
  const o = JSON.parse(raw);
  if (o && o.sports && o.sports.Basketball) {
    delete o.sports.Basketball.c;
    delete o.sports.Basketball.x;
  }
  return JSON.stringify(o);
}

class Bucket {
  constructor(name) { this.name = name; this.count = 0; this.players = 0; this.examples = []; }
  add(ex, n = 1) {
    this.count += n;
    this.players += 1;
    if (this.examples.length < EXAMPLE_CAP) this.examples.push(ex);
  }
}

// --------------------------------------------------------------------- main

const t0 = Date.now();

console.log(VERSION);
console.log(`mode            : ${APPLY ? 'APPLY — files will be written and committed' : 'DRY RUN — nothing will be written'}`);
console.log(`ROOT            : ${ROOT}`);
console.log(`started         : ${new Date().toISOString()}`);
console.log(`player shards   : ${SHARD_FILTER ? [...SHARD_FILTER].join(',') + '  ⚠ PARTIAL — totals are NOT repo-wide' : 'ALL'}`);
console.log(`example cap     : ${EXAMPLE_CAP} per bucket`);
console.log(`report          : ${OUT_PATH}`);
console.log('');

if (!fs.existsSync(PLAYERS_DIR)) {
  console.error(`FATAL: ${PLAYERS_DIR} is missing. This tool needs a PLAIN FULL checkout.`);
  process.exit(2);
}

// Freshness notice, not a gate. build-player-games.js deletes its progress file
// on success, so its PRESENCE means a rebuild is mid-flight or died partway —
// games[] is then short for some prefixes and this run will simply prune less.
// Printed rather than refused, because under-pruning is not a failure and a
// refusal would make a stalled rebuild block an unrelated repair.
if (fs.existsSync(BPG_PROGRESS)) {
  console.log('⚠ scripts/.build-player-games-progress.json EXISTS — a rebuild is mid-flight or ended early.');
  console.log('  games[] is short for the prefixes it had not reached, so this run will prune LESS.');
  console.log('  That is under-pruning, never mis-pruning. Re-run after the rebuild completes.');
  console.log('');
}

const parseFailures = [];
const invariantRefusals = [];

const allShards = fs
  .readdirSync(PLAYERS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => /^[0-9a-f]{2}$/i.test(n))
  .sort();

if (SHARD_FILTER) {
  const missing = [...SHARD_FILTER].filter((s) => !allShards.includes(s));
  if (missing.length) {
    console.error(`FATAL: --shards named directories that do not exist: ${missing.join(',')}`);
    process.exit(2);
  }
}

// Resume. A list of at most 256 two-character strings — not derived state that
// scales with the data (T22), which is what put a 110 MB progress file through
// GitHub's hard file limit.
let progress = { donePrefixes: [] };
if (!FORCE && !DRY_RUN && fs.existsSync(PROGRESS_FILE)) {
  try { progress = readJson(PROGRESS_FILE); } catch {}
} else if (FORCE) {
  console.log('  --force: starting fresh\n');
}
const donePrefixes = new Set(progress.donePrefixes ?? []);

const shardDirs = allShards
  .filter((n) => !SHARD_FILTER || SHARD_FILTER.has(n.toLowerCase()))
  .filter((n) => DRY_RUN || !donePrefixes.has(n));

console.log(`  ${allShards.length} shard dirs | ${donePrefixes.size} already done | ${shardDirs.length} to scan\n`);

let playersScanned = 0;
let playersWithC = 0;
let playersWithX = 0;
let cEntriesBefore = 0;
let xEntriesBefore = 0;
let cFieldsDeleted = 0;
let xFieldsDeleted = 0;
let filesWritten = 0;

const prunedC = new Bucket('c entries pruned');
const prunedX = new Bucket('x entries pruned');
const xSkipped = new Bucket('x skipped — games[] absent or empty');

let sinceCommit = 0;
let shardsDone = 0;
// Commits are gated on there being something to commit. A weekly run with
// nothing to prune must not write the progress file, commit it, delete it and
// commit again — two no-op commits on a 6 GB repo, every week, for ever.
let writtenAtLastCommit = 0;

for (const shard of shardDirs) {
  const dir = path.join(PLAYERS_DIR, shard);
  let files;
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (err) {
    parseFailures.push({ file: `players/${shard}/`, error: String(err && err.message) });
    continue;
  }

  for (const fname of files) {
    playersScanned += 1;
    const fpath = path.join(dir, fname);

    let raw;
    let player;
    try {
      raw = fs.readFileSync(fpath, 'utf8');
      player = JSON.parse(raw);
    } catch (err) {
      parseFailures.push({ file: `players/${shard}/${fname}`, error: String(err && err.message) });
      continue;
    }

    const bk = player && player.sports && player.sports.Basketball;
    if (!bk || typeof bk !== 'object') continue;

    const uuid = fname.replace(/\.json$/, '');
    const hasC = Array.isArray(bk.c) && bk.c.length > 0;
    const hasX = Array.isArray(bk.x) && bk.x.length > 0;
    if (!hasC && !hasX) continue;

    const games = Array.isArray(player.games) ? player.games : [];
    const held = new Set(games);

    if (hasC) { playersWithC += 1; cEntriesBefore += bk.c.length; }
    if (hasX) { playersWithX += 1; xEntriesBefore += bk.x.length; }

    let changed = false;

    // ── c: drop anything games[] now holds. A filter of a sorted array stays
    //    sorted, so the field's order is preserved for free.
    if (hasC) {
      const keep = bk.c.filter((g) => !held.has(g));
      if (keep.length !== bk.c.length) {
        const removed = bk.c.length - keep.length;
        prunedC.add({ uuid, removed, before: bk.c.length, after: keep.length, sample: bk.c.find((g) => held.has(g)) }, removed);
        if (keep.length) bk.c = keep;
        else { delete bk.c; cFieldsDeleted += 1; }   // absent, not empty
        changed = true;
      }
    }

    // ── x: guarded. See the header — an absent or empty games[] is
    //    indistinguishable from "we no longer hold any of these", and a
    //    mid-rebuild player would have their whole x wiped on that reading.
    if (hasX) {
      if (games.length === 0) {
        xSkipped.add({ uuid, xEntries: bk.x.length }, bk.x.length);
      } else {
        const keep = bk.x.filter((g) => held.has(g));
        if (keep.length !== bk.x.length) {
          const removed = bk.x.length - keep.length;
          prunedX.add({ uuid, removed, before: bk.x.length, after: keep.length, sample: bk.x.find((g) => !held.has(g)) }, removed);
          if (keep.length) bk.x = keep;
          else { delete bk.x; xFieldsDeleted += 1; }
          changed = true;
        }
      }
    }

    if (!changed) continue;

    // Prove only c and x moved, before anything reaches disk.
    const after = JSON.stringify(player);
    if (stripCX(raw) !== stripCX(after)) {
      invariantRefusals.push({ file: `players/${shard}/${fname}`, uuid });
      continue;   // left exactly as found
    }

    if (!DRY_RUN) writeJson(fpath, player);
    filesWritten += 1;
  }

  shardsDone += 1;
  donePrefixes.add(shard);
  sinceCommit += 1;

  if (sinceCommit >= COMMIT_INTERVAL && filesWritten > writtenAtLastCommit) {
    if (!DRY_RUN) {
      writeJson(PROGRESS_FILE, { donePrefixes: [...donePrefixes] });
      gitCommit(
        `prune-credited-snapshot: ${shardsDone}/${shardDirs.length} shards, ${filesWritten} files, ${prunedC.count} c + ${prunedX.count} x entries pruned`,
        ['players/', 'scripts/.prune-credited-snapshot-progress.json']
      );
    }
    writtenAtLastCommit = filesWritten;
    sinceCommit = 0;
  }

  if (shardsDone % 32 === 0 || shardsDone === shardDirs.length) {
    console.log(
      `  shards ${shardsDone}/${shardDirs.length}  players ${fmt(playersScanned)}  ` +
        `c pruned ${fmt(prunedC.count)}  x pruned ${fmt(prunedX.count)}  files ${fmt(filesWritten)}  ` +
        `(${Math.round((Date.now() - t0) / 1000)}s)`
    );
  }
}

if (!DRY_RUN && filesWritten > writtenAtLastCommit) {
  writeJson(PROGRESS_FILE, { donePrefixes: [...donePrefixes] });
  gitCommit(
    `prune-credited-snapshot: complete — ${filesWritten} files, ${prunedC.count} c + ${prunedX.count} x entries pruned`,
    ['players/', 'scripts/.prune-credited-snapshot-progress.json']
  );
}

// Progress file removed on a clean full pass, matching build-player-games.js, so
// its presence always means "a run ended early".
if (!DRY_RUN && !SHARD_FILTER && shardsDone === shardDirs.length && fs.existsSync(PROGRESS_FILE)) {
  fs.unlinkSync(PROGRESS_FILE);
  gitCommit('prune-credited-snapshot: remove progress file', ['scripts/.prune-credited-snapshot-progress.json']);
}

// ------------------------------------------------------------------- report

console.log('');
console.log('='.repeat(78));
console.log(APPLY ? 'RESULT' : 'RESULT — DRY RUN, nothing was written');
console.log('='.repeat(78));
console.log(`players scanned              : ${fmt(playersScanned)}`);
console.log(`players carrying c           : ${fmt(playersWithC)}   entries ${fmt(cEntriesBefore)}`);
console.log(`players carrying x           : ${fmt(playersWithX)}   entries ${fmt(xEntriesBefore)}`);
console.log(`player files ${APPLY ? 'written      ' : 'that WOULD be written'}: ${fmt(filesWritten)}`);
console.log('');

for (const b of [prunedC, prunedX, xSkipped]) {
  console.log('-'.repeat(78));
  console.log(`${b.name.padEnd(40)} entries ${fmt(b.count).padStart(10)}  players ${fmt(b.players)}`);
  for (const ex of b.examples) {
    if (ex.removed !== undefined) {
      console.log(`    ${ex.uuid}  removed ${ex.removed}  ${ex.before} → ${ex.after}  e.g. gid=${ex.sample}`);
    } else {
      console.log(`    ${ex.uuid}  x entries ${ex.xEntries} left untouched (no games list)`);
    }
  }
  if (b.players > b.examples.length) {
    console.log(`    … ${fmt(b.players - b.examples.length)} more players not shown (cap ${EXAMPLE_CAP})`);
  }
}
console.log('-'.repeat(78));
console.log(`c fields deleted (list emptied) : ${fmt(cFieldsDeleted)}`);
console.log(`x fields deleted (list emptied) : ${fmt(xFieldsDeleted)}`);
console.log(`c entries remaining             : ${fmt(cEntriesBefore - prunedC.count)}`);
console.log('  What remains is the genuine population: games PlayHQ credits that we do');
console.log('  not hold — uncaptured rosters, and games discovery has never found.');
console.log('');

console.log('='.repeat(78));
console.log('INTEGRITY');
console.log('='.repeat(78));
console.log(`files refused by the invariant check : ${fmt(invariantRefusals.length)}`);
for (const r of invariantRefusals.slice(0, EXAMPLE_CAP)) console.log(`    ${r.file}`);
console.log('  A refusal means something other than c/x differed. Those files were left');
console.log('  untouched. A non-zero count is a BUG IN THIS SCRIPT, not a finding.');
console.log('');
console.log(`files that failed to read or parse   : ${fmt(parseFailures.length)}`);
for (const p of parseFailures.slice(0, EXAMPLE_CAP)) console.log(`    ${p.file}: ${p.error}`);
console.log('');

const report = {
  version: VERSION,
  generatedAt: new Date().toISOString(),
  mode: APPLY ? 'apply' : 'dry-run',
  partialScan: SHARD_FILTER ? [...SHARD_FILTER] : null,
  playersScanned,
  playersWithC,
  playersWithX,
  cEntriesBefore,
  xEntriesBefore,
  cPruned: prunedC.count,
  xPruned: prunedX.count,
  cPlayersPruned: prunedC.players,
  xPlayersPruned: prunedX.players,
  cFieldsDeleted,
  xFieldsDeleted,
  cEntriesRemaining: cEntriesBefore - prunedC.count,
  filesWritten,
  xSkippedNoGames: { players: xSkipped.players, entries: xSkipped.count, examples: xSkipped.examples },
  examples: { c: prunedC.examples, x: prunedX.examples },
  invariantRefusals,
  parseFailureCount: parseFailures.length,
  parseFailures: parseFailures.slice(0, 500),
};
fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
console.log(`report written: ${OUT_PATH}`);
console.log(`elapsed: ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(VERSION);

// Both of these are faults, not findings. The report above is complete either
// way; the non-zero exit is how the run says so instead of masking it.
if (invariantRefusals.length) {
  console.error(`\nEXIT 4: ${invariantRefusals.length} file(s) failed the c/x-only invariant and were left untouched.`);
  process.exit(4);
}
if (parseFailures.length) {
  console.error(`\nEXIT 3: ${parseFailures.length} file(s) failed to read or parse.`);
  process.exit(3);
}
