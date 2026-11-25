// scripts/lib/dead-grades.cjs
// EXTRACTED 2026-11-25 from nightly-crawl.js so it can be tested against the
// REAL implementation rather than a re-write of it (T103). nightly-crawl.js
// requires it; there is no second copy.

'use strict';
const fs   = require('fs');
const path = require('path');

// ─── dead grades — RECORD ONLY ───────────────────────────────────────────────
//
// STAGE 1, 2026-11-25. Nothing reads data/dead-grades.json yet. No flag is
// written onto any game, nothing is hidden and nothing is deleted. This exists so
// the determination becomes DATA that accumulates nightly, instead of a probe
// result someone has to remember to run.
//
// ⚠⚠ WHY THIS RECORDS AND DOES NOT ACT. Measured repo-wide, read-only, on
// 2026-11-25 (claude/dead-grades-and-hidden-history.md): 6,426 grades PlayHQ no
// longer serves hold 93,945 PLAYED games. They are completed grading rounds that
// competitions hide, and showing them is a major reason StatTrack exists — the
// copy here may be the only one. Only 105 of those grades hold any unplayed
// fixture, 976 of them future-dated. A rule acting on "PlayHQ does not know this
// grade" ALONE would destroy 93,945 games to tidy up 976. The class of a grade is
// never decided in this function.
//
// ⚠ EVIDENCE OF LIFE CLEARS AN ENTRY. ABSENCE NEVER DOES. An entry is removed
// only when PlayHQ positively answers for that grade again. A grade this run did
// not ask about — blocked, dropped, outside a --season=<id> run, in a locked
// season — is carried through untouched. A partial run therefore CANNOT erase a
// repository-wide record, which is the rule the fingerprint prune and the
// stale-grade worklist both had to learn the hard way.
//
// `runs` counts consecutive runs in which PlayHQ ANSWERED and denied knowing the
// grade. A run that got no answer neither increments nor resets it. One sighting
// is not a fact, and a consumer should require more than one.
function recordDeadGrades(root, obs) {
  const FILE = path.join(root, 'data', 'dead-grades.json');
  let prev = [], parseFailed = false;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && Array.isArray(j.grades)) prev = j.grades;
  } catch (e) {
    if (fs.existsSync(FILE)) {
      parseFailed = true;
      console.log(`  ⚠ dead-grades.json could not be parsed (${e.message}) — writing this run's`
                + ` observations only; entries for grades this run did not ask about are LOST.`);
    }
  }
  const byId = new Map();
  for (const e of prev) if (e && e.id) byId.set(String(e.id), e);

  const now = new Date().toISOString();
  let added = 0, confirmed = 0, resurrected = 0;

  for (const [gid, meta] of obs.gone) {
    const e = byId.get(String(gid));
    if (e) {
      e.runs = (e.runs || 1) + 1; e.lastSeen = now;
      if (meta.sid) e.sid = meta.sid;
      if (meta.gname) e.gn = meta.gname;
      confirmed++;
    } else {
      byId.set(String(gid), { id: String(gid), sid: meta.sid || null, gn: meta.gname || null,
                              firstSeen: now, lastSeen: now, runs: 1 });
      added++;
    }
  }
  for (const gid of obs.alive) {
    const e = byId.get(String(gid));
    if (!e) continue;
    console.log(`  ↑ grade ${gid}${e.gn ? ` "${e.gn}"` : ''} ANSWERED again after ${e.runs} run(s)`
              + ` denied — entry cleared`);
    byId.delete(String(gid));
    resurrected++;
  }

  // Nothing observed and nothing to correct: do NOT rewrite the file. A state
  // file rewritten and committed nightly carrying no new information is already
  // one of this repo's outstanding complaints; this one will not join it.
  if (!added && !confirmed && !resurrected && !parseFailed && fs.existsSync(FILE)) {
    return { added: 0, confirmed: 0, resurrected: 0, total: byId.size, written: false, parseFailed };
  }

  const grades = [...byId.values()].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({
    generatedAt: now,
    scope: 'nightly-crawl Phase 1 — ACTIVE grades only. RECORD ONLY; nothing reads this yet.',
    note: 'A grade PlayHQ ANSWERED about and denied knowing. Cleared only by a positive answer, never by absence. '
        + 'Most such grades are completed grading rounds that competitions hide — history, not staleness.',
    count: grades.length,
    grades,
  }, null, 2));
  return { added, confirmed, resurrected, total: grades.length, written: true, parseFailed };
}

module.exports = { recordDeadGrades };
