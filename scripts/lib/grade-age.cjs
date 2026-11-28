// scripts/lib/grade-age.cjs
//
// The AGE GROUP carried in a grade or team name. PURE. No disk, no network.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// build-leaderboards.js wrote `age: reg.age || ''` and PlayHQ's registrations
// carry no age group, so EVERY leaderboard entry's `age` was an empty string.
// The age filter on StatTrack's Leaderboards view was therefore built from an
// array of empty strings and the select held nothing but "All ages" — the
// filter had never worked. Found 2026-11-28.
//
// StatTrack v2.04 patched it in the browser by deriving the age from the grade
// name at render time (`lbAgeOf`, index.html ~L8270). That is a workaround: the
// field is empty AT SOURCE, so every other consumer of these files still sees
// nothing. This is the fix at source.
//
// ⚠️ THE RULE IS COPIED FROM index.html's `grParse` (~L2226), CHARACTER FOR
// CHARACTER, and must stay that way. `lbAgeOf` prefers the PUBLISHED `age` and
// falls back to parsing the name, so once this ships the page takes the builder's
// answer — and if the two rules disagree, the age a player is filed under changes
// the moment a file is rebuilt. Both halves of that comparison have to give the
// same string. Verified by extracting the page's own function and running both
// over the same inputs.
//
// ⚠️ "U09" AND "U9" ARE ONE AGE GROUP. The number is parsed and re-formatted, so
// both normalise to `U9`. Returning the matched text verbatim would split one age
// group into two filter options that each hold half the players — which is also
// why the page sorts its options by `ageNum` rather than alphabetically.
//
// ⚠️ NOT A GLOBAL REGEX AND THE TWO FORMS ARE ORDERED. `U12` is tried before
// `12U`. Both appear in Basketball Victoria grade names.

'use strict';

// index.html L2200, verbatim.
function grNorm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

// The age half of index.html's grParse, verbatim. Returns 'U12' or null — never
// an empty string, so a caller can tell "no age in this name" from a parse that
// produced one.
function ageFromName(name) {
  const s = grNorm(name);
  let m = /\b(?:u|under\s*)(\d{1,2})\b/i.exec(s);
  if (m) return 'U' + Number(m[1]);
  m = /\b(\d{1,2})u\b/i.exec(s);
  if (m) return 'U' + Number(m[1]);
  return null;
}

// The age to publish on a leaderboard entry, in the same precedence order the
// page's lbAgeOf uses: whatever PlayHQ gave us, then the GRADE name, then the
// TEAM name.
//
// ⚠️ Grade before team. A team is named for its club and number ("Spirit Magic
// U14 Boys 2"), a grade for the competition it sits in ("Friday U17 Boys A"), and
// where they disagree the grade is the one the player actually played in. An
// under-age player in an older grade is common and the grade is the right answer.
function leaderboardAge(publishedAge, gradeName, teamName) {
  if (publishedAge) return String(publishedAge);
  return ageFromName(gradeName) || ageFromName(teamName) || '';
}

module.exports = { grNorm, ageFromName, leaderboardAge };
