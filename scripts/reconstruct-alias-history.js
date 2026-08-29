// scripts/reconstruct-alias-history.js
//
// Rebuilds the change record for alias repoints that were applied WITHOUT a log.
//
// WHY. The handover describes 124 repoints in three rounds: 88, 23 and 13.
// reports/alias-repoint-log.json holds 13 entries. reports/boxscore-repoint-log.json
// HAS NEVER EXISTED (confirmed 2026-08-27). So 111 changes to players/aliases/ have
// no reversal record and cannot be reviewed, reversed, or even listed by reading any
// file in the repo.
//
// They are not lost. Every alias shard is committed, so the commits that applied
// those rounds are in git history and their diffs ARE the record. This reads them.
//
// HOW, AND WHY NOT A TEXT DIFF. Alias shards are stored MINIFIED — the whole map is
// one line — so a line-based diff says "one line changed" and nothing more. This
// instead parses the file on BOTH sides of each commit and compares the maps key by
// key, which yields the exact {key, from, to} a repoint log would have held.
//
// TWO MODES:
//   --list                shows every commit touching players/aliases/ with its date,
//                         subject and how many shards it changed. Nothing is parsed.
//                         Start here: the commit subjects identify the rounds.
//   --commit=SHA[,SHA]    parses those commits and emits every alias entry they
//                         added, removed or REPOINTED, with both values.
//
// It writes only to reports/ and never touches players/, games/ or aliases.
// It reverses nothing — it produces the record that should have been written at the
// time, so a decision about reversal can be made from evidence.
//
// NEEDS FULL HISTORY. A depth-1 checkout has no past commits to read, so the
// workflow uses a blobless full-history checkout sparse to players/aliases, scripts
// and reports — the same pattern cleanup-repo.yml uses.

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; })
);

const LIST     = !!ARGS.list;
const COMMITS  = typeof ARGS.commit === 'string' ? ARGS.commit.split(',').map(x => x.trim()).filter(Boolean) : null;
const SINCE    = typeof ARGS.since === 'string' ? ARGS.since : null;
const UNTIL    = typeof ARGS.until === 'string' ? ARGS.until : null;
const MAX_LIST = ARGS['max-list'] ? Math.max(1, parseInt(ARGS['max-list'], 10)) : 200;
// Parses EVERY commit that touched players/aliases in the range, not only the ones
// whose subject says "repoint-aliases". Added 2026-08-27 after exactly that
// assumption was made: three commits were picked by their message and called the
// full set. But recordAliasDiscovery in fetch-profile-stats.js writes into the same
// map with map[key] = value, so any nightly, matrix, backfill or fold run can
// overwrite an existing key — a repoint that names itself nothing and was never
// logged. A commit subject is a claim about intent; the diff is the fact.
const ALL      = !!ARGS.all;
const RESET    = !!ARGS.reset;
// Commit progress every N commits. A 2026-08-27 sweep died at a 60-minute timeout
// with 207 of 530 commits parsed and lost all of it, because nothing was written
// until the end. Progress is now committed as it goes and the next run resumes.
const SAVE_EVERY = ARGS['save-every'] ? Math.max(1, parseInt(ARGS['save-every'], 10)) : 25;
const MAX_COMMITS = ARGS['max-commits'] ? Math.max(1, parseInt(ARGS['max-commits'], 10)) : 400;

const ALIAS_DIR   = 'players/aliases';
const REPORTS_DIR = path.join(ROOT, 'reports');
const GIT = { cwd: ROOT, stdio: 'pipe', maxBuffer: 512 * 1024 * 1024, timeout: 10 * 60 * 1000 };

function git(args) { return execFileSync('git', args, GIT).toString(); }

// ─── Listing ──────────────────────────────────────────────────────────────────

function listCommits() {
  const args = ['log', '--format=%H\x1f%cI\x1f%an\x1f%s'];
  if (SINCE) args.push('--since=' + SINCE);
  if (UNTIL) args.push('--until=' + UNTIL);
  args.push('--', ALIAS_DIR);
  let out = '';
  try { out = git(args); }
  catch (e) {
    throw new Error('git log failed — this needs FULL history. A depth-1 checkout has ' +
                    'no past commits to read. (' + ((e.stderr && e.stderr.toString()) || e.message).trim().split('\n')[0] + ')');
  }
  const lines = out.split('\n').filter(Boolean).slice(0, MAX_LIST);
  if (!lines.length) {
    console.log('No commits touch ' + ALIAS_DIR + ' in that range.');
    console.log('If you expected some, the checkout probably has no history — check fetch-depth.');
    return [];
  }
  const rows = [];
  for (const line of lines) {
    const [sha, date, author, subject] = line.split('\x1f');
    let files = [];
    try {
      files = git(['show', '--name-only', '--format=', sha, '--', ALIAS_DIR]).split('\n').filter(Boolean);
    } catch (e) { /* reported as 0 below */ }
    rows.push({ sha, date, author, subject, shardsChanged: files.length });
    console.log(`  ${sha.slice(0, 10)}  ${date}  ${String(files.length).padStart(3)} shard(s)  ${author}`);
    console.log(`      ${subject}`);
  }
  console.log(`\n${rows.length} commit(s) touching ${ALIAS_DIR}.`);
  console.log('Read the subjects: the rounds that applied repoints are named there.');
  console.log('Then re-run with the commit ids to see exactly which aliases each one moved.');
  return rows;
}

// ─── Parsing one commit ───────────────────────────────────────────────────────

function fileAt(rev, filePath) {
  try { return git(['show', `${rev}:${filePath}`]); }
  catch (e) { return null; }         // absent on that side — new or deleted file
}

function parseMap(text, label) {
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch (e) { console.log(`      ⚠ ${label}: unparseable JSON (${e.message.slice(0, 60)}) — skipped`); return undefined; }
}

function diffCommit(sha) {
  console.log(`\n──── ${sha} ────`);
  let header = '';
  try { header = git(['show', '--no-patch', '--format=%cI  %an%n  %s', sha]).trim(); }
  catch (e) { throw new Error(`cannot read commit ${sha}: ${((e.stderr && e.stderr.toString()) || e.message).trim().split('\n')[0]}`); }
  console.log('  ' + header);

  let shards = [];
  try { shards = git(['show', '--name-only', '--format=', sha, '--', ALIAS_DIR]).split('\n').filter(Boolean); }
  catch (e) { console.log('  could not list changed files'); return { sha, error: 'cannot list files' }; }
  console.log(`  ${shards.length} alias shard(s) changed`);

  const changes = [];
  let added = 0, removed = 0, repointed = 0, unchangedShards = 0;

  for (const shard of shards) {
    const beforeText = fileAt(sha + '^', shard);
    const afterText  = fileAt(sha, shard);
    const before = parseMap(beforeText, shard + ' (before)');
    const after  = parseMap(afterText,  shard + ' (after)');
    if (before === undefined || after === undefined) continue;

    const b = before || {}, a = after || {};
    let touched = 0;
    for (const [k, v] of Object.entries(a)) {
      if (!(k in b))      { changes.push({ shard, key: k, kind: 'added',     from: null, to: v }); added++; touched++; }
      else if (b[k] !== v) { changes.push({ shard, key: k, kind: 'repointed', from: b[k], to: v }); repointed++; touched++; }
    }
    for (const [k, v] of Object.entries(b)) {
      if (!(k in a)) { changes.push({ shard, key: k, kind: 'removed', from: v, to: null }); removed++; touched++; }
    }
    if (!touched) unchangedShards++;
  }

  console.log(`  REPOINTED (value changed) : ${repointed}   ← what a repoint log would have recorded`);
  console.log(`  added                     : ${added}`);
  console.log(`  removed                   : ${removed}`);
  if (unchangedShards) console.log(`  (${unchangedShards} shard(s) rewritten with no entry change — formatting or ordering only)`);

  const rep = changes.filter(c => c.kind === 'repointed');
  if (rep.length) {
    console.log('\n  repointed entries:');
    for (const c of rep.slice(0, 60)) {
      console.log(`    ${c.key}   ${c.from}  ->  ${c.to}`);
    }
    if (rep.length > 60) console.log(`    … and ${rep.length - 60} more, all in the report`);
  }
  return { sha, header, shardsChanged: shards.length, counts: { repointed, added, removed }, changes };
}

// ─── Sweep ────────────────────────────────────────────────────────────────────

const SWEEP_FILE = path.join(REPORTS_DIR, 'alias-history-sweep.json');

function loadSweep() {
  if (RESET) { console.log('--reset: starting the sweep again'); return null; }
  try {
    const prev = JSON.parse(fs.readFileSync(SWEEP_FILE, 'utf8'));
    if (!Array.isArray(prev.perCommit)) return null;
    console.log(`Resuming: ${prev.perCommit.length} commit(s) already parsed, ${(prev.repoints || []).length} repoint(s) recorded`);
    return prev;
  } catch (e) { return null; }
}

function saveSweep(state) {
  fs.writeFileSync(SWEEP_FILE, JSON.stringify(state, null, 2));
}

function commitProgress(msg) {
  try {
    execFileSync('git', ['add', '--', path.relative(ROOT, SWEEP_FILE)], GIT);
    const staged = execFileSync('git', ['diff', '--staged', '--shortstat'], GIT).toString().trim();
    if (!staged) return;
    execFileSync('git', ['-c', 'user.name=github-actions[bot]',
                         '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
                         'commit', '-q', '-m', msg], GIT);
    for (let i = 1; i <= 20; i++) {
      try {
        execFileSync('git', ['fetch', 'origin', 'main'], GIT);
        execFileSync('git', ['-c', 'user.name=github-actions[bot]',
                             '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
                             'merge', '-q', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat'], GIT);
        execFileSync('git', ['push', 'origin', 'HEAD:main'], GIT);
        console.log(`      progress committed (${msg})`);
        return;
      } catch (e) {
        if (i === 20) { console.log('      ⚠ could not push progress after 20 attempts'); return; }
        execFileSync('sleep', [String(1 + Math.floor(Math.random() * 30))], { stdio: 'pipe' });
      }
    }
  } catch (e) { console.log('      ⚠ progress commit failed: ' + (e.message || '').split('\n')[0]); }
}

function sweepAll() {
  const args = ['log', '--format=%H\x1f%cI\x1f%s'];
  if (SINCE) args.push('--since=' + SINCE);
  if (UNTIL) args.push('--until=' + UNTIL);
  args.push('--', ALIAS_DIR);
  let out = '';
  try { out = git(args); }
  catch (e) {
    throw new Error('git log failed — this needs FULL history (' +
      ((e.stderr && e.stderr.toString()) || e.message).trim().split('\n')[0] + ')');
  }
  const commits = out.split('\n').filter(Boolean).map(l => {
    const [sha, date, subject] = l.split('\x1f');
    return { sha, date, subject };
  });
  console.log(`${commits.length} commit(s) touched ${ALIAS_DIR}` + (SINCE ? ` since ${SINCE}` : '') + '.');
  if (commits.length > MAX_COMMITS) {
    console.log(`⚠ capped at ${MAX_COMMITS}; the rest are NOT examined and this is a partial answer.`);
  }
  const todo = commits.slice(0, MAX_COMMITS);

  const prev = loadSweep();
  const perCommit = (prev && prev.perCommit) || [];
  const allRepoints = (prev && prev.repoints) || [];
  const alreadyDone = new Set(perCommit.map(x => x.sha));
  const remaining = todo.filter(c => !alreadyDone.has(c.sha));
  console.log(`${remaining.length} commit(s) still to parse.\n`);

  // Each shard's parsed map is reused as the "after" of one commit becomes the
  // "before" of the next in the same shard. Halves the blob fetches, which is the
  // whole cost on a blobless clone.
  const mapCache = new Map();
  const cached = (rev, shard) => {
    const k = rev + ':' + shard;
    if (mapCache.has(k)) return mapCache.get(k);
    const v = parseMap(fileAt(rev, shard), shard);
    if (mapCache.size > 400) mapCache.clear();
    mapCache.set(k, v);
    return v;
  };

  let done = 0;
  for (const c of remaining) {
    done++;
    let shards = [];
    try { shards = git(['show', '--name-only', '--format=', c.sha, '--', ALIAS_DIR]).split('\n').filter(Boolean); }
    catch (e) { perCommit.push({ ...c, error: 'cannot list files' }); continue; }

    let repointed = 0, added = 0, removed = 0;
    const reps = [];
    for (const shard of shards) {
      const before = cached(c.sha + '^', shard);
      const after  = cached(c.sha, shard);
      if (before === undefined || after === undefined) continue;
      const b = before || {}, a = after || {};
      for (const [k, v] of Object.entries(a)) {
        if (!(k in b)) added++;
        else if (b[k] !== v) {
          repointed++;
          reps.push({ shard, key: k, from: b[k], to: v });
          allRepoints.push({ sha: c.sha, date: c.date, subject: c.subject, shard, key: k, from: b[k], to: v });
        }
      }
      for (const k of Object.keys(b)) if (!(k in a)) removed++;
    }
    perCommit.push({ ...c, shardsChanged: shards.length, repointed, added, removed });
    const flag = repointed ? '  ← REPOINTS' : '';
    console.log(`  [${String(done).padStart(3)}/${todo.length}] ${c.sha.slice(0, 10)} ${c.date}  ` +
                `repointed ${String(repointed).padStart(4)}  added ${String(added).padStart(5)}  removed ${String(removed).padStart(4)}${flag}`);
    if (repointed) console.log(`        ${c.subject}`);

    if (done % SAVE_EVERY === 0) {
      saveSweep({ generatedAt: new Date().toISOString(), since: SINCE, until: UNTIL,
                  complete: false, commitsExamined: perCommit.length, commitsFound: commits.length,
                  perCommit, repoints: allRepoints });
      commitProgress(`alias history sweep: ${perCommit.length}/${commits.length} commits parsed`);
    }
  }

  // ── Who actually repointed ─────────────────────────────────────────────────
  const byTool = {};
  for (const c of perCommit) {
    if (!c.repointed) continue;
    const tool = String(c.subject || '').split(':')[0].trim() || '(no subject)';
    byTool[tool] = (byTool[tool] || 0) + c.repointed;
  }
  const total = perCommit.reduce((n, c) => n + (c.repointed || 0), 0);

  console.log('\n──── ENTRIES REPOINTED, BY THE TOOL THAT DID IT ────');
  for (const [tool, n] of Object.entries(byTool).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${tool}`);
  }
  console.log(`  ${String(total).padStart(6)}  TOTAL`);
  console.log('\nA repoint means the key already existed and its value CHANGED. New aliases');
  console.log('for new players are counted as "added" and are not in this total.');
  console.log('If tools other than repoint-aliases appear above, they repointed aliases');
  console.log('without saying so and without writing a log.');

  const complete = perCommit.length >= commits.length;
  saveSweep({ generatedAt: new Date().toISOString(), since: SINCE, until: UNTIL,
    complete, commitsExamined: perCommit.length, commitsFound: commits.length,
    totalRepointed: total, byTool, perCommit, repoints: allRepoints });
  console.log(`\nWrote ${path.relative(ROOT, SWEEP_FILE)} — every repoint with its shard, key, from and to.`);
  if (!complete) {
    console.log(`\n⚠ NOT COMPLETE — ${perCommit.length} of ${commits.length} commit(s) parsed.`);
    console.log('   Re-dispatch with the same settings and it resumes where it stopped.');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('reconstruct-alias-history — the record for repoints that were applied without one\n');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  if (ALL) { sweepAll(); return; }

  if (!LIST && !COMMITS) {
    console.log('Nothing asked for. Use the list mode first to see which commits touched');
    console.log(`${ALIAS_DIR}, then pass the commit ids to see what each one moved.`);
    return;
  }

  if (LIST) {
    const rows = listCommits();
    const f = path.join(REPORTS_DIR, 'alias-history-commits.json');
    fs.writeFileSync(f, JSON.stringify({ generatedAt: new Date().toISOString(), since: SINCE, until: UNTIL, commits: rows }, null, 2));
    console.log(`\nWrote ${path.relative(ROOT, f)}`);
    return;
  }

  const results = COMMITS.map(diffCommit);
  const totalRepointed = results.reduce((n, r) => n + ((r.counts && r.counts.repointed) || 0), 0);
  console.log(`\n──── TOTAL ────`);
  console.log(`  commits read      : ${results.length}`);
  console.log(`  entries repointed : ${totalRepointed}`);
  console.log('\nThis is the reversal record: each entry names the shard, the key, the value');
  console.log('before and the value after. Reversing means writing "from" back. Nothing here');
  console.log('does that, and nothing here decides whether any of them SHOULD be reversed.');

  const f = path.join(REPORTS_DIR, 'alias-history-reconstructed.json');
  fs.writeFileSync(f, JSON.stringify({ generatedAt: new Date().toISOString(), commits: results }, null, 2));
  console.log(`\nWrote ${path.relative(ROOT, f)}`);
}

main();
