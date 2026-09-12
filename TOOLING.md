# TOOLING.md

Machine-readable classification of every script and workflow in this repository.

`scripts/audit-tooling-inventory.js` reads this file to decide two things: whether a file
is classified at all, and which category it belongs to. Those two facts drive the
keep/delete verdict, so a file missing from this list will be judged on age alone.

**It deliberately carries NO purpose text, no findings, no method and no history.** Those
live in the operator's own notes, outside this repository. Filenames are already visible
in `scripts/` and `.github/workflows/`, so this file discloses nothing that a directory
listing does not.

**When you add a script or workflow, add its name here in the same commit.** That is the
whole maintenance burden, and skipping it means the inventory cannot tell your new tool
from an abandoned one.

Section 4 does the same job for `reports/`, and `db-audit.js` §11b reads it. Before
2026-09-11 that keep-list was hardcoded inside `db-audit.js`, where two of its ten entries
named files the July cleanup had already deleted and nothing distinguished a spent output
from a report a live script still reads.

### 2.1 Live scripts — run on a schedule or by the nightly chain

- `audit-diff-fields.js`
- `audit-removed-org-seasons.js`
- `build-finals-stats.js`
- `build-leaderboards.js`
- `build-player-games.js`
- `build-records.js`
- `build-search-index.js`
- `build-team-stats.js`
- `build-venue-indexes.js`
- `build-win-loss.js`
- `close-empty-seasons.js`
- `discover-org-seasons.js`
- `discover-seasons.js`
- `fetch-profile-stats.js`
- `find-lost-stats-from-folds.js`
- `find-misrouted-appearances.js`
- `fold-diverged-players.js`
- `lock-quiet-seasons.js`
- `measure-credited-coverage.js`
- `nightly-crawl.js`
- `requeue-repointed-players.js`
- `revert-alias-repoints.js`
- `salvage-spectator-names.js`
- `scripts/lib/namespace-resolve.cjs`
- `scripts/lib/uuid-prefix.cjs`
- `seed-apiid-from-playhq-pairs.js`
- `size-appearance-gaps.js`
- `size-locked-resweep.js`
- `size-missing-gids.js`
- `size-spectator-queue.js`
- `spectator-backfill.js`
- `update-team-index.js`
- `update-venue-lookup.js`
- `verify-outstanding-claims.js`

### 2.2 Kept scripts — on-demand tools, deliberately retained

- `audit-seasons-gaps.js`
- `audit-tooling-inventory.js`
- `audit-uuid-collisions.js`
- `build-alias-worklist.js`
- `clear-stats-checked.js`
- `count-stats-checked.js`
- `db-audit.js`
- `diagnose-forfeit-game.js`
- `diagnose-id-field-lengths.js`
- `diagnose-nightly-health.js`
- `diagnose.js`
- `discover-fixtures.js`
- `discover-game-backfill.js`
- `find-flag-collisions.js`
- `find-players-by-team.js`
- `find-shell-aliases.js`
- `fix-merge-aliases.js`
- `probe-alias-credits.js`
- `probe-alias-names.js`
- `probe-api-limits.js`
- `probe-my-aliases.js`
- `probe-player.js`
- `probe-selfalias-check.js`
- `probe-shared-name-aliases.js`
- `probe-squad-evidence.js`
- `probe-unresolved-aliases.js`
- `probe-verdict-conflict.js`
- `rebuild-player-index.js`
- `recheck-forfeit-games.js`
- `recheck-private-profiles.js`
- `repair-duplicate-regs.js`
- `repair-forfeit-score.js`
- `repair-legacy-flags.js`
- `repair-player.js`
- `repair-players-batch.js`
- `repair-reg-sibling-sync.js`
- `repair-season-names.js`
- `repoint-aliases.js`
- `report-alias-index.js`
- `scan-complete-rounds.js`
- `scan-roster-id-forms.js`
- `seed-missing-profiles.js`
- `size-opposition-index.js`
- `size-report.js`
- `synthesize-missing-games.js`
- `test-api.js`
- `trace-player-game.js`
- `verify-enrich.js`
- `verify-p-redundancy.js`

### 2.3 Scripts removed in an earlier cleanup

- `fetch-player-profiles.js`
- `search-team-stats.js`
- `test-failed-uuids.js`

Removed 2026-09-11:

- `check-roster-freshness.js`
- `drop-stale-playercount.js`
- `merge-phantom-profiles.js`
- `probe-absent-games.js`
- `probe-both-resolve.js`
- `probe-duplicate-profiles.js`
- `probe-grade-ladder.js`
- `probe-missing-games.js`
- `probe-setup-node-fingerprint.js`
- `probe-shared-roster.js`
- `redirect-exposure.js`
- `scan-season-name-contamination.js`
- `size-duplicate-profiles.js`
- `diagnose-alias-conflicts.js`
- `diagnose-nameless-players.js`
- `probe-alias-stats.js`
- `probe-discover-teams.js`
- `probe-notfound.js`
- `probe-registrations.js`
- `probe-roster-sources.js`
- `probe-session-throwaway.js`
- `probe-stattrack-shapes.cjs`
- `probe-stattrack-shapes.js`
- `probe-wrong-rosters.js`
- `prove-player-files-intact.js`
- `size-locked-backfill.js`

### 2.4 Spent scripts — concluded; their findings are recorded outside this repo

None. The eight probes that sat here were deleted on 2026-09-11 and are listed in 2.3.
The twelve held probes were reviewed the same day and are in 2.3 as well; the three
kept out of that group are classified in 2.2.

### 3.1 Live workflows — scheduled

- `add-player.yml`
- `audit-diff-fields.yml`
- `close-empty-seasons.yml`
- `discover-org-seasons.yml`
- `discover-seasons-matrix.yml`
- `fetch-profile-stats-matrix.yml`
- `fetch-profile-stats.yml`
- `find-lost-stats-from-folds.yml`
- `find-misrouted-appearances.yml`
- `fold-diverged-players.yml`
- `graduate-seasons.yml`
- `lock-quiet-seasons.yml`
- `measure-credited-coverage.yml`
- `nightly-crawl.yml`
- `post-drain-chain.yml`
- `rebuild-chain.yml`
- `recheck-private-profiles.yml`
- `requeue-repointed-players.yml`
- `revert-alias-repoints.yml`
- `size-locked-split.yml`
- `size-pages-artifact.yml`
- `verify-outstanding-claims.yml`
- `weekly-indexes.yml`

### 3.2 Build-trigger workflows

- `build-finals-stats.yml`
- `build-leaderboards.yml`
- `build-player-games.yml`
- `build-records.yml`
- `build-search-index.yml`
- `build-team-stats.yml`
- `build-venue-indexes.yml`
- `build-win-loss.yml`
- `deploy-pages.yml`

### 3.3 Kept workflows — on-demand, deliberately retained

- `audit-removed-org-seasons.yml`
- `audit-tooling-inventory.yml`
- `audit-uuid-collisions.yml`
- `build-alias-worklist.yml`
- `cleanup-repo.yml`
- `clear-stats-checked.yml`
- `count-stats-checked.yml`
- `db-audit.yml`
- `diagnose-forfeit-game.yml`
- `diagnose-id-field-lengths.yml`
- `diagnose-nightly-health.yml`
- `diagnose.yml`
- `discover-seasons.yml`
- `find-code-refs.yml`
- `find-flag-collisions.yml`
- `find-players-by-team.yml`
- `find-root-json-refs.yml`
- `find-shell-aliases.yml`
- `generate-roster.yml`
- `overnight-chain.yml`
- `probe-api-limits.yml`
- `probe-squad-evidence.yml`
- `rebuild-player-index.yml`
- `recheck-forfeit-games.yml`
- `repair-forfeit-score.yml`
- `repair-legacy-flags.yml`
- `repair-season-names.yml`
- `report-alias-index.yml`
- `restore-deleted-file.yml`
- `salvage-spectator-names.yml`
- `scan-complete-rounds.yml`
- `size-gap-players.yml`
- `size-misses.yml`
- `size-negative-gap.yml`
- `size-report.yml`
- `size-resweep.yml`
- `test-api.yml`
- `update-team-index.yml`
- `update-venue-lookup.yml`
- `verify-enrich.yml`
- `verify-p-redundancy.yml`
- `weekly-future-fixtures.yml`

### 3.4 Workflows removed in an earlier cleanup

Removed 2026-09-11:

- `backfill.yml`
- `check-roster-freshness.yml`
- `drop-stale-playercount.yml`
- `merge-phantom-profiles.yml`
- `probe-absent-games.yml`
- `probe-both-resolve.yml`
- `probe-duplicate-profiles.yml`
- `probe-grade-ladder.yml`
- `probe-missing-games.yml`
- `probe-setup-node-fingerprint.yml`
- `probe-shared-roster.yml`
- `redirect-exposure.yml`
- `scan-season-name-contamination.yml`
- `size-duplicate-profiles.yml`
- `diagnose-alias-conflicts.yml`
- `probe-alias-stats.yml`
- `probe-discover-teams.yml`
- `probe-notfound.yml`
- `probe-registrations.yml`
- `probe-roster-sources.yml`
- `probe-stattrack-shapes.yml`
- `probe-wrong-rosters.yml`
- `prove-player-files-intact.yml`
- `size-locked-backfill.yml`

### 4.1 Reports kept

Anything in `reports/` not listed here is flagged by `db-audit.js` §11b, which also reports
whether a surviving script or workflow still references it. A report that nothing references
and that is not listed here is residue.

Listed means a deliberate decision to keep, and it holds even if every reference disappears.
Every entry below is either a permanent record or an INPUT — something a surviving script
reads, or a workflow passes as a default. Regenerated outputs are deliberately NOT listed:
they are rewritten on every run, so being referenced is all the protection they need, and
listing them would turn this into an inventory of whatever happens to exist. Reasons for
each entry are recorded outside this repository.

- `alias-credit-audit.json`
- `alias-history-sweep.json`
- `alias-merge-candidates.json`
- `alias-name-audit.json`
- `alias-repoint-log.json`
- `alias-resolve-cache.json`
- `alias-vs-playhq-audit-after-fold.json`
- `alias-vs-playhq-audit-wide.json`
- `alias-vs-playhq-audit.json`
- `both-resolve-pairs.json`
- `census-12-fa.json`
- `census-recovery-diagnosis.json`
- `duplicate-profile-pairs.json`
- `fold-diverged.json`
- `git-history-recovery-report.json`
- `manual-alias-decisions.json`
- `misrouted-appearances.json`
- `rebuild-player-index.json`
- `rekey-apply-log.json`
- `rekey-enrich-report.json`
- `repair-batch-progress.json`
- `season-name-contamination.json`
- `shared-name-alias-audit.json`
- `squad-evidence-audit.json`
- `unresolved-alias-audit.json`
- `unresolved-prefix-diagnosis.json`
- `uuid-collisions-len10.json`
- `wrongly-keyed-census.json`
