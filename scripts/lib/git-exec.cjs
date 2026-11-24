// git-exec.cjs — the shared git-call guard: ONE timeout, ONE maxBuffer, ONE stall
// vocabulary for every script in this repository that commits.
//
// WHY THIS FILE EXISTS (T104, 2026-11-24)
// ---------------------------------------
// `gitCommit` was copied by hand into 74 scripts. On 2026-11-24 an audit found 98
// git calls across 24 of them carrying `maxBuffer` and NO `timeout`, five months
// after the same defect was fixed in six other writers. A constant copied 74 times
// is a constant that will be wrong in some of them, and the only durable fix is for
// the number to live in one place.
//
// ⚠ THIS FILE DELIBERATELY RUNS NOTHING. It exports constants and predicates only —
// no execSync, no execFileSync, no require('child_process'). Each caller keeps its
// own gitCommit, because the copies genuinely differ (per-path add lists, benign-
// absent exemptions, `HEAD:main` vs `main`, `-c user.name` IDENT args) and
// collapsing them into one function would be a behaviour change in every chain
// writer at once. What is shared here is the part that must NOT differ.
//
// Having no side effects also makes every predicate below unit-testable without a
// repository, a network, or a git binary.
//
// THE MEASUREMENTS BEHIND THE NUMBERS (2026-11-24, from 24 Actions log archives
// spanning 2026-08-28 to 2026-11-24 — see claude/t104-git-timeout-investigation.md)
// ----------------------------------------------------------------------------
//   In-script git round trip (commit + fetch + merge + push), n = 1,858:
//     median 3 s · p90 5 s · max 162 s
//   actions/checkout shallow fetch (--depth=1) of this repo, n = 101:
//     2026-08 median 3.9 m · 2026-09 4.5 m · 2026-10 4.9 m · 2026-11 5.2 m (max 6.5 m)
//
// So GIT_TIMEOUT_MS = 10 min is ~222x the median round trip and 3.7x the worst
// legitimate one ever observed. It is NOT generous against the checkout figure,
// which is growing ~0.4 min/month on a repository the API now reports at 19.6 GB
// (every note in this repo still says "6 GB" — that figure is stale).
//
// ⚠ DO NOT RAISE THIS NUMBER TO "FIX" A STALL. On 2026-11-24 discover-fixtures.js
// had six consecutive fetches killed at exactly 10:00 each, burning 58 minutes of
// the `data-write` lock. Raising the timeout would have made that 60 attempts of
// whatever the new number is. The bound that makes a stall safe is
// MAX_FETCH_STALLS, not the timeout.

'use strict';

// ── The numbers ──────────────────────────────────────────────────────────────

// Overridable so scripts/tests/test-git-stall-cap.js can exercise a stall at 1 s
// instead of 10 min. NEVER set this in a workflow to work around a slow fetch.
const GIT_TIMEOUT_MS = parseInt(process.env.GIT_TIMEOUT_MS || String(10 * 60 * 1000), 10);

// 2026-08-09 (T26): execFileSync's default maxBuffer is 1 MB. A merge across 25,593
// changed files printed 1,051,036 bytes of "Auto-merging …" lines — 2,460 bytes over
// — and Node SIGTERMed git MID-MERGE, after the commit and before the push. Every
// merge also passes `-q --no-stat` so those lines are never emitted in the first
// place; this is the second line of defence, not the first.
const GIT_MAXBUF = 512 * 1024 * 1024;

// Consecutive stalls — fetches killed by the timeout with no fetch answering in
// between — before the loop gives up and throws. 3 bounds the lock-hold at roughly
// 30 minutes instead of the 10 hours that 60 uncapped attempts would allow.
// A fetch that ANSWERS, however it answered, resets the count: that is ordinary
// contention, which is exactly what the retry loop exists for.
const MAX_FETCH_STALLS = parseInt(process.env.GIT_MAX_FETCH_STALLS || '3', 10);

// The house retry count. Unchanged from the hand-copied pattern.
const MAX_ATTEMPTS = 60;

// ── Options ──────────────────────────────────────────────────────────────────

/**
 * Options for a git call. Pass the repository root; merge extras if a call needs
 * them (e.g. a different stdio shape).
 *
 * ⚠ Use this for GIT calls only. The backoff `sleep` in a retry loop is NOT a git
 * call and must keep its own, shorter timeout — a sleep wrapped in GIT_TIMEOUT_MS
 * would mask a wedged sleep for ten minutes. See sleepOpts().
 */
function gitOpts(root, extra) {
  const base = {
    cwd: root,
    stdio: 'pipe',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAXBUF,
  };
  if (!extra) return base;
  return Object.assign(base, extra);
}

/** Options for the backoff sleep between attempts. Deliberately not gitOpts(). */
function sleepOpts(waitSec) {
  return { stdio: 'pipe', timeout: (waitSec + 30) * 1000 };
}

/** Pure jitter, as the house pattern uses. apply=false runs are shorter. */
function backoffSeconds(apply) {
  return 1 + Math.floor(Math.random() * (apply ? 91 : 15));
}

// ── Classifying what git did ─────────────────────────────────────────────────

/**
 * Was this child KILLED by our own timeout, as opposed to having answered?
 *
 * ⚠ A timeout kill does not look like a git error. execFileSync/execSync report it
 * as e.killed / e.signal === 'SIGTERM' / e.code === 'ETIMEDOUT', and e.stderr is
 * usually EMPTY — so a handler that only reads stderr sees "no output" and reports
 * a mysterious failure. This predicate is the only correct way to tell the two
 * apart, and getting it wrong is what produced six log lines reading
 * "fetch failed … git said: (no output)" on 2026-11-24.
 */
function isStall(e) {
  if (!e) return false;
  if (e.killed === true) return true;
  if (e.signal === 'SIGTERM') return true;
  return /ETIMEDOUT/i.test(String(e.code || ''));
}

/** git's own words, for a log line. Empty string when git said nothing. */
function gitSaid(e, max) {
  if (!e) return '';
  const cap = typeof max === 'number' ? max : 300;
  const parts = [];
  if (e.stderr) parts.push(String(e.stderr).trim());
  if (e.stdout) parts.push(String(e.stdout).trim());
  const text = parts.filter(Boolean).join(' | ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= cap) return text;
  // Announce the truncation. A cut that hides itself is the same defect as a
  // silent retry.
  return text.slice(0, cap) + ` …[truncated, ${text.length} chars total]`;
}

// Failures that retrying 60 times cannot fix. Retrying them wastes the lock and
// buries the cause under 60 identical lines.
const FATAL_PATTERNS = [
  { re: /GH001|exceeds (?:GitHub's )?file size limit|this exceeds GitHub's file size/i, why: 'oversized file' },
  { re: /GH006|protected branch|required status check/i, why: 'branch protection' },
  { re: /GH013|pre-receive hook declined|hook declined/i, why: 'pre-receive hook declined' },
  { re: /Authentication failed|could not read Username|Invalid username or password|Permission denied \(publickey\)|403 Forbidden|remote: Repository not found/i, why: 'authentication' },
  { re: /refusing to allow (?:an? )?(?:OAuth App|GitHub App|Personal Access Token)/i, why: 'token scope' },
];

/**
 * 'stall' | 'fatal' | 'contention'
 *
 * Order matters: isStall() is checked FIRST, because a killed child carries no
 * stderr and would otherwise fall through to 'contention' and be counted as a
 * lost race it never ran.
 */
function classifyGitError(e) {
  if (isStall(e)) return 'stall';
  const text = [e && e.stderr, e && e.stdout, e && e.message].filter(Boolean).map(String).join(' ');
  for (const p of FATAL_PATTERNS) {
    if (p.re.test(text)) return 'fatal';
  }
  return 'contention';
}

/** Why a 'fatal' is fatal, for the throw message. '' when not fatal. */
function fatalReason(e) {
  const text = [e && e.stderr, e && e.stdout, e && e.message].filter(Boolean).map(String).join(' ');
  for (const p of FATAL_PATTERNS) {
    if (p.re.test(text)) return p.why;
  }
  return '';
}

/**
 * "nothing to commit" is a LEGITIMATE, NON-ERROR outcome and must never be thrown
 * or counted as a failure. A run that had nothing to write is a successful run.
 */
function isNothingToCommit(e) {
  const text = [e && e.stderr, e && e.stdout, e && e.message].filter(Boolean).map(String).join(' ');
  return /nothing to commit|no changes added to commit|nothing added to commit/i.test(text);
}

// ── The stall ceiling ────────────────────────────────────────────────────────

/**
 * Tracks consecutive stalls for one retry loop.
 *
 *   const stalls = makeStallTracker();
 *   ... on a git error:
 *   const kind = classifyGitError(e);
 *   const st = stalls.note(kind);
 *   if (st.exhausted) throw new Error(stallExhaustedMessage('fetch', st));
 *
 * note() takes the classification, not the error, so a caller cannot accidentally
 * count a contention as a stall.
 */
function makeStallTracker(maxStalls) {
  const max = typeof maxStalls === 'number' ? maxStalls : MAX_FETCH_STALLS;
  let consecutive = 0;
  return {
    get max() { return max; },
    get consecutive() { return consecutive; },
    /**
     * Call on EVERY attempt outcome. kind: 'stall' | 'contention' | 'fatal' | 'ok'.
     *
     * ⚠ ONLY 'ok' RESETS. This matches discover-fixtures.js, whose comment reads
     * "a fetch that ANSWERS ends the stall run, however it answered" — and which
     * sets the counter to 0 in the SUCCESS path, not in the catch. A non-stall
     * FAILURE therefore leaves the count standing, which its own test pins:
     * stall/fail/stall/fail/stall gives up on the third stall. Resetting on
     * contention would let a repository alternating between stalls and rejections
     * retry for ever, which is the case the cap exists for.
     */
    note(kind) {
      if (kind === 'stall') consecutive++;
      else if (kind === 'ok') consecutive = 0;
      return {
        kind,
        consecutive,
        max,
        // max <= 0 means uncapped, kept only so a caller can opt out explicitly.
        exhausted: kind === 'stall' && max > 0 && consecutive >= max,
      };
    },
    reset() { consecutive = 0; },
  };
}

// ── Log wording ──────────────────────────────────────────────────────────────
//
// A STALL is reported SEPARATELY from contention, always. They have different
// causes and different fixes, and a log that conflates them sends the next person
// to the wrong place. Wording follows nightly-crawl.js, which is the version that
// was read during the 2026-11-23 incident.

/** The per-attempt retry line. `op` is 'fetch' | 'merge' | 'push'. */
function retryMessage(op, e, attempt, maxAttempts, waitSec, stallState) {
  const kind = stallState && stallState.kind ? stallState.kind : classifyGitError(e);
  const said = gitSaid(e);
  if (kind === 'stall') {
    const cap = stallState && stallState.max > 0
      ? `${stallState.consecutive}/${stallState.max}`
      : `${(stallState && stallState.consecutive) || 1}/∞`;
    return `  ⚠ ${op} STALLED past ${GIT_TIMEOUT_MS / 60000} min and was killed `
      + `(attempt ${attempt}/${maxAttempts}, stall ${cap}) — retrying in ${waitSec}s`;
  }
  return `  … ${op} ${kind === 'fatal' ? 'REFUSED' : 'contention'} `
    + `(attempt ${attempt}/${maxAttempts}) — retrying in ${waitSec}s`
    + ` — git said: ${said || '(no output)'}`;
}

/** The throw message when consecutive stalls hit the ceiling. */
function stallExhaustedMessage(op, stallState) {
  return `git ${op} STALLED past ${GIT_TIMEOUT_MS / 60000} min on `
    + `${stallState.consecutive} consecutive attempts with no ${op} answering in between — `
    + `giving up rather than holding the data-write lock for `
    + `${Math.round((MAX_ATTEMPTS * GIT_TIMEOUT_MS) / 60000)} more minutes. `
    + `This is a network or server-side fault, not contention.`;
}

/** The throw message for a fatal (non-retryable) git refusal. */
function fatalMessage(op, e) {
  return `git ${op} REFUSED (${fatalReason(e) || 'unknown'}) — not retrying: ${gitSaid(e) || '(no output)'}`;
}

/** The throw message when the ordinary attempt budget is exhausted. */
function attemptsExhaustedMessage(op, maxAttempts, e) {
  return `git ${op} failed after ${maxAttempts} attempts: ${gitSaid(e, 200) || '(no output)'}`;
}

module.exports = {
  GIT_TIMEOUT_MS,
  GIT_MAXBUF,
  MAX_FETCH_STALLS,
  MAX_ATTEMPTS,
  gitOpts,
  sleepOpts,
  backoffSeconds,
  isStall,
  gitSaid,
  classifyGitError,
  fatalReason,
  isNothingToCommit,
  makeStallTracker,
  retryMessage,
  stallExhaustedMessage,
  fatalMessage,
  attemptsExhaustedMessage,
};
