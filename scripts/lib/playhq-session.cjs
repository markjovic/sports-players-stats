// scripts/lib/playhq-session.cjs
//
// The PlayHQ session's REQUEST BUDGET, in one place.
//
// ─── WHAT THIS IS FOR ────────────────────────────────────────────────────────
// Measured 2026-10-04 (REPO_MANIFEST §6.59): a session cookie is accepted for
// roughly 290 calls and then every request returns 403 CLOUDFRONT-BLOCK. It is not
// a block, not an IP range and not a client fingerprint — the cookie is accepted and
// then stops being accepted. On season 7f7c13f5: clean to team 280, 403; recovered;
// clean again to team 580, 403.
//
// Waiting for that 403 is expensive. A bootstrap requested INSIDE the penalty window
// that follows is itself refused, so the backoff runs before a cookie comes back —
// two minutes in discover-fixtures, and the 2026-10-04 Weekly Indexes run spent
// 4h45m on the first of 378 seasons collecting nothing.
//
// A refresh requested while the current cookie STILL WORKS is granted immediately.
// So the rule is: rotate before the budget runs out, never after.
//
// ─── WHY A GUARD AND NOT A FETCHER ───────────────────────────────────────────
// Every script's refreshSession() differs — different bootstrap queries, different
// cookie shapes (nightly-crawl needs phq_tier/phq_session/phq_sub by name,
// discover-fixtures joins whatever returns), different headers. Those stay where
// they are. What is identical everywhere is the BOOKKEEPING, and that is all this
// owns: count the calls, rotate at the threshold, and make concurrent callers share
// one refresh instead of starting one each.
//
// ⚠️ THE SINGLE-FLIGHT LOCK IS NOT OPTIONAL. Without it, N concurrent callers each
// notice the threshold and each start their own bootstrap — twenty "Fetching session
// cookie..." in a burst, which is ITSELF refused, so the bootstrap returns no cookie
// and the run never escapes. That is a real observed failure, not a precaution.

'use strict';

const DEFAULT_MAX_CALLS = 250;   // under the ~290 budget, with room for calls in flight
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Wrap a script's existing session handling in a budget guard.
 *
 * @param {object}   o
 * @param {function} o.refresh    async () => void. The script's own refreshSession.
 * @param {function} o.hasCookie  () => boolean. True when a usable cookie is held.
 * @param {function} [o.clear]    () => void. Drop the current cookie before refreshing.
 * @param {number}   [o.maxCalls] Rotate after this many calls (default 250).
 * @param {number}   [o.maxAgeMs] Rotate after this long (default 15 minutes).
 * @param {function} [o.log]      (msg) => void.
 * @returns {{ensure: function, note: function, stats: function}}
 */
function createSessionGuard(o) {
  const refresh   = o.refresh;
  const hasCookie = o.hasCookie;
  const clear     = o.clear || (() => {});
  const maxCalls  = o.maxCalls != null ? o.maxCalls : DEFAULT_MAX_CALLS;
  const maxAgeMs  = o.maxAgeMs != null ? o.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const log       = o.log || console.log;

  let calls     = 0;
  let issuedAt  = 0;
  let rotations = 0;
  let inFlight  = null;       // the single-flight lock

  async function doRefresh(why) {
    // Everyone who arrives while a refresh is running waits on THAT refresh.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        if (why) log(`  ↻ ${why} — rotating before it is refused`);
        clear();
        await refresh();
        calls = 0;
        issuedAt = Date.now();
        rotations++;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    /** Call before every request. Refreshes when needed, then counts the call. */
    async ensure() {
      if (!hasCookie()) { await doRefresh(null); calls = 1; return; }
      if (calls >= maxCalls) { await doRefresh(`${calls} calls on this session`); calls = 1; return; }
      if (issuedAt && (Date.now() - issuedAt) > maxAgeMs) {
        await doRefresh(`session ${Math.round((Date.now() - issuedAt) / 60000)} minutes old`);
        calls = 1; return;
      }
      calls++;
    },
    /** For a 403 the caller has already seen: force a rotation, single-flight. */
    async rotateNow(why) { await doRefresh(why || 'refused by PlayHQ'); calls = 0; },
    stats() { return { calls, rotations, ageMs: issuedAt ? Date.now() - issuedAt : 0 }; },
  };
}

module.exports = { createSessionGuard, DEFAULT_MAX_CALLS, DEFAULT_MAX_AGE_MS };
