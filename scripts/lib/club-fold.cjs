// scripts/lib/club-fold.cjs
//
// Tournament/association -> club attribution. PURE. No disk, no network, no git.
// scripts/fold-tournament-teams.js is the only consumer.
//
// ⚠️ UNGUARDED IN THIS REPOSITORY. A 35-assertion suite driving THESE functions —
// not a copy of them (T103) — was written and run green on 2026-11-28, but it is
// held in staging and NOT uploaded, because nothing in CI runs any suite in
// scripts/tests/. Every warning below is therefore enforced by reading, not by a
// test. Treat them as load-bearing.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// PlayHQ's team `organisation` is whoever created the team. A team entered in a
// tournament, or a rep team entered by its league, carries the TOURNAMENT or the
// ASSOCIATION as its organisation, not the club the players come from. Measured
// 2026-10-12 on season 0869ea69 (Nunawading Spectres Tournament 2026): 1,010 teams
// read the host org, 311 read a real club. Across data/club-index.json, 23
// tournament organisations hold 10,220 of 408,784 teams.
//
// probe-team-club-fields.js tested every candidate field on DiscoverTeam and the
// schema rejected all of them: club, entity, owner, ownerOrganisation,
// parentOrganisation, delegatedOrganisation, registeringOrganisation,
// sourceOrganisation, association, tenant, shortName, abbreviation, externalId,
// externalRef, homeVenue, contacts, status, type. `grade.season.competition.
// organisation` is the tournament too.
//
// ⚠️ SO THE OWNING CLUB IS NOT RETRIEVABLE FROM THE API. The team NAME is the only
// route, and `organisation.type` (CLUB vs ASSOCIATION) is the published, 100%/100%
// discriminator for WHICH teams have the problem. See
// claude/tournament-team-club-attribution.md.
//
// ⚠️ THE MATCHING RULE IS COPIED FROM index.html, DELIBERATELY, CHARACTER FOR
// CHARACTER (normClubName / clubKeyOf / buildClubKeys / inferClubFromName, ~L3302).
// The player card already folds at render time and prints
// "includes N GP matched by team name from <tournament>". Club Leaders reading a
// DIFFERENT rule is how the card says 142 GP and the leaders table says 140 — the
// exact defect this file exists to close. If the page's rule changes, this changes
// with it in the same commit, or the two disagree again.
//
// ⚠️ NOT A GLOBAL REPLACE, AND THE ALTERNATION ORDER MATTERS. The regex in
// clubKeyOf has no /g and its branches are ordered longest-first so
// " basketball club " is consumed before " basketball ". Adding /g, reordering the
// branches, or "tidying" the spaces changes which clubs resolve. Do not.
//
// ⚠️ WHOLE-WORD CONTAINMENT. normClubName pads both ends with a space and the
// needle is padded too, so " stars " can never match inside " rocketstars ". That
// padding was the fix for the single residual error in the 2026-10-12 measurement.
//
// ⚠️ MEASURED COVERAGE IS A PROPERTY OF EACH ORGANISATION'S NAMING, NOT OF THIS
// CODE. Nunawading writes "Spirit Magic U14 Boys" and 75.5% resolve;
// Eltham-Dandenong writes "Westgate B12.1" and 7.6% do. 27% overall, 0 errors.
// Loosening the match to catch abbreviated forms reintroduces the Club-vs-
// Association ambiguity the CLUB-only candidate rule removes. DECLINING IS THE
// CORRECT BEHAVIOUR. 27% coverage at 0 errors beats 80% coverage at any error rate,
// because a wrong club is indistinguishable from a right one once it is published.

'use strict';

// A key shorter than this matches far too much once it is padded and scanned
// against every team name in the estate. Not a measurement — a guard.
const MIN_KEY_LEN = 5;

function normClubName(x) {
  return ' ' + String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

function clubKeyOf(n) {
  return normClubName(n)
    .replace(/ basketball club | basketball association | basketball | club | association | tournament | inc /, ' ')
    .trim();
}

// idx is data/club-index.json: [{ id, n, ty, t, s }].
// ONLY ty === 'CLUB' rows become candidates. An ASSOCIATION is never a candidate,
// which is what makes "Blackburn Vikings Basketball Club" vs "... Association"
// unable to collide.
function buildClubKeys(idx) {
  const out = [];
  for (const c of (idx || [])) {
    if (!c || c.ty !== 'CLUB' || !c.n || !c.id) continue;
    const k = clubKeyOf(c.n);
    if (k.length >= MIN_KEY_LEN) out.push({ id: String(c.id), n: String(c.n), k });
  }
  // Longest key first, so the most specific club wins and the first hit can be
  // returned without scanning the rest. Ties broken on id so two runs over the
  // same index can never disagree — Array.prototype.sort is not stable across
  // every engine for equal keys, and an arbitrary winner here is a silent
  // re-attribution between runs.
  return out.sort((a, b) => (b.k.length - a.k.length) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Two different CLUB organisations reducing to the SAME key is an ambiguity the
// page resolves arbitrarily (first hit wins). At build time that would publish an
// arbitrary club id, so the caller is given the list and reports it. Returned, not
// thrown: a duplicate key is a fact about PlayHQ's club names, not a fault here.
function duplicateKeys(keys) {
  const seen = new Map(), dups = new Map();
  for (const c of (keys || [])) {
    if (seen.has(c.k)) {
      if (!dups.has(c.k)) dups.set(c.k, [seen.get(c.k)]);
      dups.get(c.k).push(c);
    } else seen.set(c.k, c);
  }
  return [...dups.entries()].map(([k, members]) => ({ k, members }));
}

function inferClubFromName(teamName, keys) {
  if (!teamName || !keys || !keys.length) return null;
  const t = normClubName(teamName);
  for (const c of keys) if (t.indexOf(' ' + c.k + ' ') !== -1) return c;
  return null;
}

// One season's worth of attribution.
//   need      [{ tid, from }]              from = the ASSOCIATION org id holding it
//   teamStats { tid: { meta: { name } } }  team-stats/bv/{sid}.json, AS WRITTEN
//
// ⚠️ team-stats/bv/{sid}.json is TID-KEYED AT THE TOP LEVEL. There is no `teams`
// wrapper — build-team-stats.js L282 is `return teams;` and the object is written
// whole, which is how index.html L6441 reads it (`ts[tid]`). Reading
// `file.teams[tid]` yields undefined for every team, declines everything, and
// reports a clean run that published nothing.
// Every record returned — hit, decline, noName, selfRef — carries `from`, the
// organisation the team was attributed to. An earlier draft returned bare tids
// for noName and left the caller to recover the organisation with a linear search
// inside the loop: O(n^2) on an association the size of VJBL (10,371 teams).
function foldSeason(opts) {
  const need = (opts && opts.need) || [];
  const teamStats = (opts && opts.teamStats) || null;
  const keys = (opts && opts.keys) || [];
  const hits = [], noName = [], declined = [], selfRef = [];
  for (const item of need) {
    if (!item || !item.tid) continue;
    const t = teamStats ? teamStats[item.tid] : null;
    const name = (t && t.meta && t.meta.name) ? String(t.meta.name) : '';
    // No team-stats row, or a row with no name, is "could not ask" — NOT "no club".
    // Counting it as a decline would bury a missing artifact inside a coverage
    // percentage, which is the conflation that wrote 80 seasons as removed:true.
    if (!name) { noName.push({ tid: item.tid, from: String(item.from) }); continue; }
    const hit = inferClubFromName(name, keys);
    if (!hit) { declined.push({ tid: item.tid, from: String(item.from), name }); continue; }
    // The name resolved to the organisation that already holds the team. Nothing
    // moves, and recording it would make a club appear to have folded itself.
    if (hit.id === item.from) { selfRef.push({ tid: item.tid, from: String(item.from), name }); continue; }
    hits.push({ clubId: hit.id, tid: item.tid, from: String(item.from), name });
  }
  return { hits, noName, declined, selfRef };
}

// Deterministic key order. Two runs that compute the same attribution must
// produce byte-identical JSON, or every run commits a reordered file and the
// shortstat stops meaning anything.
function sortTseasons(ts) {
  const out = {};
  for (const sid of Object.keys(ts).sort()) {
    const inner = {};
    for (const tid of Object.keys(ts[sid]).sort()) inner[tid] = ts[sid][tid];
    out[sid] = inner;
  }
  return out;
}

// Merge computed attribution into an existing clubs/{cid}.json object.
//
// ⚠️ `seasons` IS PLAYHQ'S OWN ATTRIBUTION AND IS NEVER TOUCHED. The fold writes
// a SEPARATE `tseasons` key so the two stay distinguishable and auditable, and so
// a wrong fold can be dropped without rebuilding PlayHQ's half.
//
// ⚠️ STALE ENTRIES ARE REMOVED, NOT LEFT. When PlayHQ later attributes a team to
// its real club, that team leaves the association's `seasons` list and this run
// simply never computes it again — so an entry left behind would be a permanent
// phantom. Every sid this run VISITED is rebuilt wholesale; every sid it did not
// visit is carried through untouched, which is what makes a narrowed run safe.
function mergeClubTseasons(existing, computed, visitedSids) {
  const base = (existing && typeof existing === 'object') ? existing : {};
  const prev = (base.tseasons && typeof base.tseasons === 'object') ? base.tseasons : {};
  const visited = visitedSids || new Set();
  const next = {};
  for (const sid of Object.keys(prev)) if (!visited.has(sid)) next[sid] = prev[sid];
  for (const sid of Object.keys(computed || {})) {
    const m = computed[sid];
    if (m && Object.keys(m).length) next[sid] = m;
  }
  const out = {};
  for (const k of Object.keys(base)) if (k !== 'tseasons') out[k] = base[k];
  const have = Object.keys(next).length > 0;
  if (have) out.tseasons = sortTseasons(next);
  const before = JSON.stringify(base.tseasons || null);
  const after  = JSON.stringify(have ? out.tseasons : null);
  return { obj: out, changed: before !== after };
}

// The clubs/{clubId}.json merge, lifted OUT of build-club-index.js so it can be
// executed by a test instead of pattern-matched (the precedent harness5.cjs set
// for that script). build-club-index.js calls this; it is the ONLY writer of
// `seasons`, and this fold is the only writer of `tseasons`.
//
//   existing  the file on disk, or null
//   fresh     { id, n, ty, seasons: Map<sid, iterable<tid>> } for THIS run
//
// ⚠️ A RUN NEVER BLANKS WHAT IT DID NOT SEE. `n` and `ty` fall back to the stored
// value, and only the sids this run resolved are replaced — that is what makes
// --active-only safe on a club that spans twenty seasons.
//
// ⚠️ `tseasons` IS CARRIED THROUGH. Before 2026-11-28 this merge built an object
// literal of exactly { id, n, ty, seasons }, so the fold's `tseasons` key was
// dropped on the next Build Club Index run — no error, no log line, and Club
// Leaders silently reverted to disagreeing with the player card. Build Club Index
// now runs weekly, so that erasure would have been weekly too. Do not "tidy" this
// back into a literal.
function mergeClubIndexFile(existing, fresh) {
  const hasPrev = !!(existing && typeof existing === 'object' && existing.seasons && typeof existing.seasons === 'object');
  const merged = hasPrev
    ? { id: fresh.id, n: fresh.n || existing.n || '', ty: fresh.ty || existing.ty || '', seasons: { ...existing.seasons } }
    : { id: fresh.id, n: fresh.n || '', ty: fresh.ty || '', seasons: {} };
  for (const [sid, tids] of fresh.seasons) merged.seasons[sid] = [...tids].sort();
  if (hasPrev && existing.tseasons && typeof existing.tseasons === 'object' && Object.keys(existing.tseasons).length) {
    merged.tseasons = existing.tseasons;
  }
  return merged;
}

module.exports = {
  MIN_KEY_LEN,
  normClubName,
  clubKeyOf,
  buildClubKeys,
  duplicateKeys,
  inferClubFromName,
  foldSeason,
  sortTseasons,
  mergeClubTseasons,
  mergeClubIndexFile,
};
