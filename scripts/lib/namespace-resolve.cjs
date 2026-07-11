// scripts/lib/namespace-resolve.cjs
//
// Shared helpers for recovering the api-namespace profile.id of a player whose
// stored spectator-namespace id fails publicProfileStatistics. This module holds
// ONLY (a) GraphQL query strings copied verbatim from playhq_api_reference.md and
// (b) pure matching functions. It deliberately does NOT do any HTTP or session
// work: each caller (fetch-profile-stats.js, backfill-missing-players.js, the
// diagnostic) keeps its own already-proven transport/session and just feeds the
// query results into the matchers below. That keeps every session mechanism
// exactly as it is today and confines this file to string + pure logic.

'use strict';

// gradePlayerStatistics — copied verbatim from playhq_api_reference.md.
// results[] = { profile { id firstName lastName }, team { id name },
//               statistics { count details { value } } }.
// The profile.id here is the api-namespace id publicProfileStatistics accepts.
// NOTE (documented limitation): hard cap of 50 results, no pagination, returns
// the highest-appearance players — low-appearance players can be absent, which
// is what the profileSearch fallback below is for.
const GRADE_PLAYERS_QUERY = `query GradePlayerStatistics($gradeID: ID!) {
  gradePlayerStatistics(gradeID: $gradeID) {
    meta { totalPages totalRecords page }
    results {
      profile { id firstName lastName }
      team { id name }
      statistics { count details { value } }
    }
  }
}`;

// profileSearch — copied verbatim from playhq_api_reference.md. This is the
// FULLER selection documented there (result { id firstName lastName
// lastInteractedOrganisation { id name } }); note the cookie-warming ProfileSearch
// used by the session recipes only selects result { id } — this is a separate,
// wider query taken straight from the reference, not an edit of that one.
const PROFILE_SEARCH_QUERY = `query ProfileSearch($fullName: String!) {
  profileSearch(fullName: $fullName) {
    result {
      id firstName lastName
      lastInteractedOrganisation { id name }
    }
  }
}`;

// Normalise a display name for comparison: lowercase, collapse internal
// whitespace, trim. Applied identically to the spectator `name` and to
// firstName + ' ' + lastName from the api side.
function normName(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}

// A stub whose name is the `Player #<prefix>` placeholder carries no real name
// to match on, so name-based recovery is impossible for it. Callers should skip.
function isPlaceholderName(name) {
  return !name || /^player\s*#/i.test(String(name).trim());
}

// Match a player within ONE grade's gradePlayerStatistics.results, by exact
// team.id AND exact normalised full name. Returns a single api-namespace
// profile.id, or null when there are zero matches OR more than one distinct
// match (ambiguous — never guess).
function matchFromGrade(results, { name, tid }) {
  if (!Array.isArray(results) || !tid || isPlaceholderName(name)) return null;
  const target = normName(name);
  if (!target) return null;
  const hits = [];
  for (const r of results) {
    const pid  = r && r.profile && r.profile.id;
    const rtid = r && r.team && r.team.id;
    if (!pid || rtid !== tid) continue;
    const full = normName(`${(r.profile.firstName || '')} ${(r.profile.lastName || '')}`);
    if (full && full === target) hits.push(pid);
  }
  const uniq = [...new Set(hits)];
  return uniq.length === 1 ? uniq[0] : null;
}

// Fallback matcher over profileSearch(fullName).result[]. Filters by exact
// normalised name; if more than one survives and an orgId is available,
// narrows by lastInteractedOrganisation.id. Returns a single profile.id or null.
function matchFromSearch(result, { name, orgId }) {
  if (!Array.isArray(result) || isPlaceholderName(name)) return null;
  const target = normName(name);
  if (!target) return null;
  let cands = result.filter(r =>
    r && r.id && normName(`${(r.firstName || '')} ${(r.lastName || '')}`) === target
  );
  if (cands.length > 1 && orgId) {
    const byOrg = cands.filter(r =>
      r.lastInteractedOrganisation && r.lastInteractedOrganisation.id === orgId
    );
    if (byOrg.length) cands = byOrg;
  }
  const uniq = [...new Set(cands.map(r => r.id))];
  return uniq.length === 1 ? uniq[0] : null;
}

module.exports = {
  GRADE_PLAYERS_QUERY,
  PROFILE_SEARCH_QUERY,
  normName,
  isPlaceholderName,
  matchFromGrade,
  matchFromSearch,
};
