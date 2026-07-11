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

// gradePlayerStatistics — CORRECTED 2026-07-11. The prior version of this
// comment/query claimed "hard cap 50, no pagination" per playhq_api_reference.md
// — that was wrong. The doc's claim was measured using a query that omitted
// the $filter argument. The field IS paginated via filter.pagination; 50 is
// the per-page limit, not a total cap. Verified live (diagnose-grade-
// pagination.js) on grade c952bf59: totalRecords=86, totalPages=2, page 2
// returned 35 players absent from page 1.
//
// This query MERGES two verbatim-sourced pieces rather than inventing
// anything: team{id name} / profile{...} / statistics — already proven live
// this session (diagnose-namespace-mismatch.js JOB 1, same grade) — plus
// filter/meta/ranking, from the correction. team.id was re-verified present
// under the new filter+pagination shape (diagnose-grade-pagination.js) before
// being kept here — the correction's own sample only requested team{name}.
//
// Callers must page: loop `page` 1..meta.totalPages, aggregate results.
const GRADE_PLAYERS_QUERY = `query publicGradeStatistics($gradeID: ID!, $filter: GradePlayerStatisticsFilter) {
  gradePlayerStatistics(gradeID: $gradeID, filter: $filter) {
    meta { page totalPages totalRecords }
    results {
      ranking
      profile { id firstName lastName }
      team { id name }
      statistics { count details { value } }
    }
  }
}`;

// Default filter for a gradePlayerStatistics page request. sort column doesn't
// affect correctness (we consume every page regardless of order), APPEARANCE
// is what's been verified live.
function gradePageFilter(page, limit = 50) {
  return { sort: [{ column: 'APPEARANCE', direction: 'DESC' }], pagination: { page, limit } };
}

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

// Match a player within ONE grade's (aggregated, all-pages) gradePlayerStatistics
// results, by exact team.id AND exact normalised full name. Returns a single
// api-namespace profile.id, or null when there are zero matches OR more than
// one distinct match (ambiguous — never guess). Use when tid is known (the
// matrix's population — existing players with real regs).
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

// Match a player within ONE grade's aggregated (all-pages) roster by NAME
// ALONE — no team.id required. For populations where tid is structurally
// unavailable (backfill's un-indexed games/bv candidates — see
// diagnose-uuid-classification.js: g.p never records team side). A single
// grade's roster (tens of players) is a much tighter search space than a
// tenant-wide profileSearch, so this is tried before that fallback. Still
// conservative: more than one distinct match across the WHOLE grade (i.e. two
// different players sharing a name in the same grade) returns null rather
// than guessing.
function matchFromGradeRosterByName(results, { name }) {
  if (!Array.isArray(results) || isPlaceholderName(name)) return null;
  const target = normName(name);
  if (!target) return null;
  const hits = [];
  for (const r of results) {
    const pid = r && r.profile && r.profile.id;
    if (!pid) continue;
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
  gradePageFilter,
  PROFILE_SEARCH_QUERY,
  normName,
  isPlaceholderName,
  matchFromGrade,
  matchFromGradeRosterByName,
  matchFromSearch,
};
