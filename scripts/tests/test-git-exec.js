#!/usr/bin/env node
// scripts/tests/test-git-exec.js
// REVISION 2026-11-24a — first version.
//
// Unit tests for scripts/lib/git-exec.cjs, the shared git guard (T104).
//
// WHY A SEPARATE SUITE. The lib deliberately runs nothing — no child_process, no
// exec, no side effects — so every predicate in it is testable without a
// repository, a network or a git binary. test-git-stall-cap.js covers the loop in
// discover-fixtures.js by running the real function against a stubbed git; this
// covers the primitives every swept script now shares.
//
// ⚠ The stall-reset semantics are pinned here against discover-fixtures.js, which
// resets only on a fetch that SUCCEEDS. An earlier draft of makeStallTracker reset
// on any non-stall outcome; that silently diverged from the loop these tests exist
// to make uniform, and test-git-stall-cap case 4a is the assertion that caught it.
//
// Run:  node scripts/tests/test-git-exec.js

'use strict';

const path = require('path');
const GX = require(path.join(__dirname, '..', 'lib', 'git-exec.cjs'));

let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l}${d !== undefined ? `  -> ${d}` : ''}`); } };
const eq = (a, b, l) => ok(a === b, l, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

console.log('test-git-exec.js');
console.log('─'.repeat(60));

// ── 1 · the numbers ───────────────────────────────────────────────────────────
console.log('\n1 · constants');
eq(GX.GIT_TIMEOUT_MS, 10 * 60 * 1000, '1a timeout is 10 minutes');
eq(GX.GIT_MAXBUF, 512 * 1024 * 1024, '1b maxBuffer is the 512 MB house value (T26)');
eq(GX.MAX_FETCH_STALLS, 3, '1c stall ceiling is 3');
eq(GX.MAX_ATTEMPTS, 60, '1d attempt budget is 60');

// ── 2 · gitOpts ───────────────────────────────────────────────────────────────
console.log('\n2 · gitOpts');
const o = GX.gitOpts('/repo');
eq(o.cwd, '/repo', '2a cwd is the root it was given');
eq(o.timeout, GX.GIT_TIMEOUT_MS, '2b carries the timeout');
eq(o.maxBuffer, GX.GIT_MAXBUF, '2c carries the maxBuffer');
eq(o.stdio, 'pipe', '2d defaults to piped stdio');
const o2 = GX.gitOpts('/repo', { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 99 });
ok(Array.isArray(o2.stdio), '2e an extra stdio shape overrides the default');
eq(o2.maxBuffer, 99, '2f extras override');
eq(o2.timeout, GX.GIT_TIMEOUT_MS, '2g but the timeout survives extras');
const sl = GX.sleepOpts(30);
ok(sl.timeout < GX.GIT_TIMEOUT_MS, '2h sleepOpts is SHORTER than the git timeout');
eq(sl.timeout, 60 * 1000, '2i sleep gets its wait plus 30s, not the git timeout');
ok(sl.cwd === undefined, '2j sleepOpts carries no cwd — it is not a git call');

// ── 3 · isStall ───────────────────────────────────────────────────────────────
console.log('\n3 · isStall — a killed child carries no stderr');
eq(GX.isStall({ killed: true }), true, '3a killed:true is a stall');
eq(GX.isStall({ signal: 'SIGTERM' }), true, '3b SIGTERM is a stall');
eq(GX.isStall({ code: 'ETIMEDOUT' }), true, '3c ETIMEDOUT is a stall');
eq(GX.isStall({ stderr: 'anything' }), false, '3d a plain error is not');
eq(GX.isStall(null), false, '3e null is not');
eq(GX.isStall(undefined), false, '3f undefined is not');

// ── 4 · classifyGitError ──────────────────────────────────────────────────────
console.log('\n4 · classifyGitError');
eq(GX.classifyGitError({ killed: true }), 'stall', '4a a kill classifies as stall');
eq(GX.classifyGitError({ killed: true, stderr: 'failed to push some refs' }), 'stall',
   '4b ⚠ a kill wins over stderr — a timed-out child must never be filed as contention');
eq(GX.classifyGitError({ stderr: 'failed to push some refs' }), 'contention', '4c a rejected push is contention');
eq(GX.classifyGitError({ stderr: 'remote: error: GH001: Large files detected' }), 'fatal', '4d GH001 is fatal');
eq(GX.classifyGitError({ stderr: 'remote: error: GH006: Protected branch update failed' }), 'fatal', '4e GH006 is fatal');
eq(GX.classifyGitError({ stderr: 'remote: error: pre-receive hook declined' }), 'fatal', '4f a declined hook is fatal');
eq(GX.classifyGitError({ stderr: 'fatal: Authentication failed for https://github.com/x' }), 'fatal', '4g auth is fatal');
eq(GX.classifyGitError({ message: 'something unrecognised' }), 'contention', '4h the unknown case retries');
eq(GX.fatalReason({ stderr: 'GH001: Large files detected' }), 'oversized file', '4i fatalReason names it');
eq(GX.fatalReason({ stderr: 'failed to push some refs' }), '', '4j and is empty when not fatal');

// ── 5 · nothing to commit is NOT an error ─────────────────────────────────────
console.log('\n5 · isNothingToCommit');
eq(GX.isNothingToCommit({ stdout: 'nothing to commit, working tree clean' }), true, '5a recognised on stdout');
eq(GX.isNothingToCommit({ stderr: 'no changes added to commit' }), true, '5b and the other wording');
eq(GX.isNothingToCommit({ stderr: 'fatal: Authentication failed' }), false, '5c an auth failure is not it');

// ── 6 · the stall ceiling ─────────────────────────────────────────────────────
console.log('\n6 · makeStallTracker — pinned against discover-fixtures.js');
let t = GX.makeStallTracker();
eq(t.note('stall').exhausted, false, '6a one stall does not exhaust');
eq(t.note('stall').exhausted, false, '6b two do not');
eq(t.note('stall').exhausted, true,  '6c three do');

t = GX.makeStallTracker();
t.note('stall'); t.note('ok');
eq(t.consecutive, 0, '6d a fetch that SUCCEEDS resets the run');
eq(t.note('stall').exhausted, false, '6e so the count starts again');

t = GX.makeStallTracker();
eq(t.note('stall').consecutive, 1, '6f stall');
eq(t.note('contention').consecutive, 1, '6g ⚠ a non-stall FAILURE does not reset — discover-fixtures resets only on success');
eq(t.note('stall').consecutive, 2, '6h stall');
eq(t.note('contention').consecutive, 2, '6i still held');
eq(t.note('stall').exhausted, true, '6j stall/fail/stall/fail/stall gives up on the third stall (case 4a)');

t = GX.makeStallTracker(0);
for (let i = 0; i < 10; i++) ok(t.note('stall').exhausted === false, `6k-${i} cap 0 is unbounded`);
t = GX.makeStallTracker(2);
t.note('stall');
eq(t.note('stall').exhausted, true, '6l an explicit cap of 2 is honoured');

// ── 7 · log wording — a STALL is never conflated with contention ──────────────
console.log('\n7 · messages');
t = GX.makeStallTracker();
const stallMsg = GX.retryMessage('fetch', { killed: true }, 4, 60, 49, t.note('stall'));
ok(/STALLED past 10 min/.test(stallMsg), '7a a stall says STALLED and names the limit');
ok(/stall 1\/3/.test(stallMsg), '7b and counts itself against the ceiling');
ok(/attempt 4\/60/.test(stallMsg), '7c and names the attempt');
ok(!/contention/.test(stallMsg), '7d ⚠ and never says contention');
const contMsg = GX.retryMessage('push', { stderr: 'failed to push some refs' }, 2, 60, 7, GX.makeStallTracker().note('contention'));
ok(/contention/.test(contMsg), '7e contention says contention');
ok(!/STALL/.test(contMsg), '7f and never says STALL');
ok(/git said: failed to push some refs/.test(contMsg), '7g and quotes git');
ok(/\(no output\)/.test(GX.retryMessage('push', {}, 1, 60, 5, GX.makeStallTracker().note('contention'))),
   '7h an empty error says so rather than printing nothing');
ok(/data-write/.test(GX.stallExhaustedMessage('fetch', { consecutive: 3, max: 3 })),
   '7i the give-up message names the lock it is refusing to hold');
ok(/not retrying/.test(GX.fatalMessage('push', { stderr: 'GH001: Large files detected' })),
   '7j a fatal says it is not retrying');

// ── 8 · gitSaid announces its own truncation ──────────────────────────────────
console.log('\n8 · gitSaid');
eq(GX.gitSaid({ stderr: '  spaced  ' }), 'spaced', '8a trimmed and collapsed');
eq(GX.gitSaid({}), '', '8b empty when git said nothing');
const long = GX.gitSaid({ stderr: 'x'.repeat(5000) });
ok(long.length < 5000, '8c long output is capped');
ok(/truncated, 5000 chars total/.test(long), '8d ⚠ and the truncation ANNOUNCES ITSELF');

// ── 9 · backoff ───────────────────────────────────────────────────────────────
console.log('\n9 · backoffSeconds');
let lo = Infinity, hi = -Infinity;
for (let i = 0; i < 2000; i++) { const v = GX.backoffSeconds(true); lo = Math.min(lo, v); hi = Math.max(hi, v); }
ok(lo >= 1 && hi <= 91, `9a apply jitter stays within 1-91s (saw ${lo}-${hi})`);
lo = Infinity; hi = -Infinity;
for (let i = 0; i < 2000; i++) { const v = GX.backoffSeconds(false); lo = Math.min(lo, v); hi = Math.max(hi, v); }
ok(lo >= 1 && hi <= 15, `9b dry-run jitter stays within 1-15s (saw ${lo}-${hi})`);

console.log('');
console.log('─'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
