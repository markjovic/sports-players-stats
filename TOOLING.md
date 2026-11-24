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
- `build-club-index.js`
- `build-club-movement.js`
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
- `scripts/lib/git-exec.cjs`
      Exports: `GIT_TIMEOUT_MS`, `GIT_MAXBUF`, `MAX_FETCH_STALLS`, `MAX_ATTEMPTS`, `gitOpts`,
      `sleepOpts`, `backoffSeconds`, `isStall`, `gitSaid`, `classifyGitError`, `fatalReason`,
      `isNothingToCommit`, `makeStallTracker`, `retryMessage`, `stallExhaustedMessage`,
      `fatalMessage`, `attemptsExhaustedMessage`.
      ⚠ The git timeout and the stall ceiling live HERE and nowhere else. A script that
      spells either number itself is the defect this file exists to stop (T104).
      ⚠ It runs NOTHING — no `child_process`, no exec, no side effects — so every predicate
      is testable without a repository, a network or a git binary. Keep it that way.
      ⚠ `classifyGitError` tests `isStall` FIRST: a timeout-killed child carries no stderr and
      would otherwise be counted as contention it never ran.
- `scripts/lib/namespace-resolve.cjs`
- `scripts/lib/playhq-session.cjs`
- `scripts/lib/round-refresh.cjs`
      Exports: `sha12`, `hashRoundList`, `hashIdSet`, `isPlayedGame`, `loadFingerprints`,
      `saveFingerprints`, `pruneFingerprints`, `groupStoredByRound`, `planGrade`, `planGradeFull`,
      `detectGradeChange`, `computeRoundDeletions`, `assessGradeCoverage`, `withholdLiveElsewhere`,
      `makeDeletionBudget`, `sideIds`, `teamsInRounds`, `findSameDayGradeConflicts`,
      `findSameDayNameConflicts`, `findStaleFixtureGrades`, `playedGamesByTeamDay`,
      `findSupersedingGame`, `computeSupersededFlags`.
      ⚠ `sideIds(g)` is the ONLY correct way to read a game's two team ids — `g.h ?? g.t1`,
      `g.a ?? g.t2`. `hTid`/`aTid` do not exist in `games/bv` (T103). Never re-derive it.
      ⚠ `playedGamesByTeamDay` + `findSupersedingGame` are the single shared definition of
      "superseded", used by BOTH the stale report and the `sup` flag so the two cannot drift.
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

- `audit-aliases-against-playhq.js`
- `audit-git-timeouts.js`
      Parses every `exec(File)?Sync` call in `scripts/`, resolves named options constants, and
      reports untimed git calls. `--strict` exits 1. Anything it cannot resolve is counted and
      printed as `unresolved` / `unparsed`, never as guarded.
      ⚠ Run this, not a grep. A line-level grep has produced a wrong count twice: 2026-08-20
      (one options spelling) and 2026-11-24 (62/354 vs the real 24/98, because 36 scripts guard
      through a shared constant no line test can see).
- `audit-grade-coverage.js`
- `audit-nonfinal-games.js`
- `audit-pending-games-vs-playhq.js`
- `audit-seasons-gaps.js`
- `audit-team-fixtures.js`
- `audit-tooling-inventory.js`
- `audit-uuid-collisions.js`
- `build-alias-worklist.js`
- `census-wrongly-keyed-players.js`
- `clear-stats-checked.js`
- `correct-wrong-aliases.js`
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
- `find-players-by-name.js`
- `find-shell-aliases.js`
- `fix-merge-aliases.js`
- `measure-playhq-limits.js`
- `probe-alias-credits.js`
- `probe-alias-names.js`
- `probe-api-limits.js`
- `probe-credited-snapshot.js`
- `probe-my-aliases.js`
- `probe-player.js`
- `probe-regrade-shape.js`
- `probe-selfalias-check.js`
- `probe-shared-name-aliases.js`
- `probe-squad-evidence.js`
- `probe-unresolved-aliases.js`
- `probe-verdict-conflict.js`
- `prune-credited-snapshot.js`
- `rebuild-player-index.js`
- `recheck-forfeit-games.js`
- `recheck-private-profiles.js`
- `refresh-team-grades.js`
- `repair-duplicate-regs.js`
- `repair-forfeit-score.js`
- `repair-legacy-flags.js`
- `publish-final-game.js`
- `repair-player.js`
- `repair-players-batch.js`
- `repair-reg-sibling-sync.js`
- `repair-season-names.js`
- `repoint-aliases.js`
- `report-alias-index.js`
- `restore-withdrawn-games.js`
- `scan-complete-rounds.js`
- `scan-roster-id-forms.js`
- `seed-missing-profiles.js`
- `set-shell-apiid.js`
- `size-opposition-index.js`
- `size-report.js`
- `synthesize-missing-games.js`
- `test-api.js`
- `scripts/tests/make-sup-fixtures.js`            — regenerates the `sup` fixtures FROM the real builder
- `scripts/tests/render-test-sup-consumers.js`    — 31 Chromium assertions on the four `sup` consumers in index.html (needs Playwright; SKIPS without it)
- `scripts/tests/test-emit-apply.js`             — 55 assertions on the --emit/--apply split, including one end-to-end sweep with the fetch transport stubbed; the rest run the real `--apply` command and cover every refusal (wrong progress key, tenant, version, absent or unparseable changeset)
- `scripts/tests/test-flush-merge.js`            — 63 assertions on the re-read-and-merge flush: another writer's changes between read and flush survive, a game that became played is left as history, existing-wins, and a corrupt or shapeless file is refused rather than overwritten (runs the real `applyGame`/`flushGameFiles`)
- `scripts/tests/test-git-stall-cap.js`           — 24 assertions on the consecutive-stall cap in discover-fixtures' push-retry loop (runs the real `gitCommitPush`; `git` and `sleep` stubbed on PATH, no PlayHQ); ⚠ POSIX-only — the stubs are `#!/bin/sh`, so it SKIPS on win32 rather than reporting a false red (`GIT_STALL_CAP_FORCE=1` runs it anyway)
- `scripts/tests/test-refresh-team-grades-t105.js` — 15 assertions on the played-game grade rule (runs the real script)
- `scripts/tests/test-git-exec.js`                 — 70 assertions on `lib/git-exec.cjs`;
      pure predicates, no repo, no network, no git binary needed
- `scripts/tests/test-round-refresh-helpers.js`   — 86 assertions on the round-refresh lib
- `scripts/tests/test-team-stats-sup.js`          — 26 assertions on sup propagation, T105 and the schema marker (runs the real builder)
- `scripts/tests/test-superseded-wiring.js`       — 13 assertions running nightly-crawl's own apply loop
- `scripts/tests/test-wave-scan.js`               — 17 assertions on the change→rescan→expand wave loop
- `trace-player-game.js`
- `verify-enrich.js`
- `verify-p-redundancy.js`
- `verify-players-against-playhq.js`

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
- `probe-team-club-fields.js`
- `probe-notfound.js`
- `probe-registrations.js`
- `probe-roster-sources.js`
- `probe-session-throwaway.js`
- `probe-stattrack-shapes.cjs`
- `probe-stattrack-shapes.js`
- `probe-wrong-rosters.js`
- `prove-player-files-intact.js`
- `size-locked-backfill.js`

**2026-10-05 (REPO_MANIFEST §6.62).** Fourteen of the names in the 2026-09-11 list above are
STILL PRESENT in scripts/, and thirteen of the names in §3.4 are still present in
.github/workflows/. The record and the directory disagree. Nothing has been re-classified here
and no name has been moved: §2.3 stays as written. REPO_MANIFEST §2.5 states what is on disk.
All fourteen fetch api.playhq.com and were moved to the fetch() client on 2026-10-05, because a
file that is present can be dispatched, and one on https.request is now refused from cold.

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
- `publish-final-game.yml`
- `rebuild-chain.yml`
- `recheck-private-profiles.yml`
- `restore-withdrawn-games.yml`
- `requeue-repointed-players.yml`
- `revert-alias-repoints.yml`
- `size-locked-split.yml`
- `size-pages-artifact.yml`
- `verify-outstanding-claims.yml`
- `weekly-indexes.yml`

### 3.2 Build-trigger workflows

- `build-club-index.yml`
- `build-club-movement.yml`
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

- `audit-aliases-against-playhq.yml`
- `audit-grade-coverage.yml`
- `audit-nonfinal-games.yml`
- `audit-pending-games-vs-playhq.yml`
- `audit-removed-org-seasons.yml`
- `audit-team-fixtures.yml`
- `audit-tooling-inventory.yml`
- `audit-uuid-collisions.yml`
- `build-alias-worklist.yml`
- `census-wrongly-keyed-matrix.yml`
- `census-wrongly-keyed-players.yml`
- `cleanup-repo.yml`
- `clear-stats-checked.yml`
- `correct-wrong-aliases.yml`
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
- `find-players-by-name.yml`
- `find-root-json-refs.yml`
- `find-shell-aliases.yml`
- `generate-roster.yml`
- `measure-playhq-limits.yml`
- `overnight-chain.yml`
- `probe-api-limits.yml`
- `probe-regrade-shape.yml`
- `probe-squad-evidence.yml`
- `prune-credited-snapshot.yml`
- `rebuild-player-index.yml`
- `recheck-forfeit-games.yml`
- `refresh-rosters.yml`
- `refresh-team-grades.yml`
- `repair-forfeit-score.yml`
- `repair-legacy-flags.yml`
- `repair-season-names.yml`
- `report-alias-index.yml`
- `restore-deleted-file.yml`
- `salvage-spectator-names.yml`
- `scan-complete-rounds.yml`
- `set-shell-apiid.yml`
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
- `verify-players-against-playhq.yml`
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
- `probe-team-club-fields.yml`
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
- `name-search-input.json`
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


---

## 6 · Fields written into `games/bv/{sid}.json` by the nightly

Beyond the fixture fields (`d`, `t`, `v`/`vid`/`vn`, `ct`, `rn`, `gid`, `gn`, `h`/`hn`, `a`/`an`,
`hs`/`as`, `st`, `forfeit`/`fo`, `spc`, `p[]`):

- **`sup`** — ADDED 2026-11-24. The **game id** of the fixture that superseded this one. Set when the
  game is past-dated, never played, still served by PlayHQ, and one of its teams has a PLAYED game in
  a **different** grade on that date. Written and **cleared** every run by
  `computeSupersededFlags`; it is derived, and `applyRoundFixtures` spreads `...existing`, so a
  set-only flag would survive every refetch and outlive its condition.
  **CONSUMED since 2026-11-24.** The five consumers below read it; none of them re-derives the rule.
  A superseded fixture is excluded from segments, bands, counts and “still to play”, and is SHOWN
  greyed with a chip carrying the id of the game that replaced it — marked, not hidden, because
  hiding it discards the id at the only place a person would use it and makes a superseded fixture
  look identical to a deleted one.

  The consumers, and what each now does:

  | # | where | what it does |
  |---|---|---|
  | 1 | `grBuild` index.html → `grTeamCard` | grading panel — `sup` apps are split into `t.sups`, out of `t.apps`, so segments, bands and counts are clean by construction. **BOTH inference passes are retired**, not kept alongside the field. The team card shows them greyed, clickable through to the replacing game |
  | 2 | club week view — `clubRowHTML` | greyed row, `↻ SUP` chip, `data-sup` carrying the replacing id; the click handler opens that game instead of a team-vs-team view flagged “upcoming” |
  | 3 | `renderMode` → `renderSheet` | new `superseded` mode and its own `case`, tested AFTER the score tests so a scored game with a stale flag still renders its score |
  | 4 | team card Fixtures tab + its click handler | `data-sup` from team-stats, greyed row, chip in place of the em dash, click opens the replacing game |
  | 5 | `build-team-stats.js` | carries `sup` onto the fixture entry, **only when present**, so an absent key means “not superseded”. Two counts of one concept are printed and checked: flagged games and fixture entries, which must hold 1:2 |

  ⚠ **`team-stats/bv/{sid}.json` now carries `sup` on the fixture entry.** The team card's fixture
  list renders team-stats, not `games/bv`, so no UI-side skip could ever have reached it. It needs no
  clearing pass: `build-team-stats.js` rewrites each season file whole from `games/bv`, so a flag
  cleared upstream is simply not written. The one way a stale flag could have survived was the
  `--resume` skip — see `meta.sv` below.

  ⚠ **`meta.sv` — team-stats schema version, ADDED 2026-11-24, value `2`.** Written on every team.
  `--resume` used to skip a season whose teams carried a `grade` key, which was an exact marker for
  the 2026-10-05 change and a LIE for every change after it: every file written since October
  satisfies it, so a resumed run would have skipped every season and no season would ever have gained
  `sup`, while reporting “skipped” and looking like progress. The test is now the version. **Bump it
  on any future change to what a team or a fixture carries.**

  ⚠ **The player season card does NOT count unplayed games** — it unions by `p[]` or a stored box
  line, so it is not a consumer. Earlier notes in this file and in `REPO_MANIFEST.md` claiming a
  season-card “still to play” were **wrong**: the only “still to play” string in `index.html` is
  L2723, in the grading panel's team card.

  Readers that are safe by construction, because every one requires a PLAYED game: `h2hMapGids`
  L1873, `openDiffGames` L4864, `toggleUnreg` L4992, `toggleGames` L5034, `tcAvail` L5668,
  `tcFoulOuts`/`tcGameLines` L5748, `carLoadRows` L3654, `resolveOppGames` L6927; and the FINAL-gated
  builders `build-win-loss`, `build-records`, `build-leaderboards`, `build-finals-stats`,
  `build-player-games`, `discover-game-backfill`, `spectator-backfill`, `size-report`,
  `publish-final-game`.

  Report-only audits that still count a `sup` game as expected (nothing published, deliberately NOT
  changed in this pass — none of those files was open): `scan-complete-rounds.js` L48–51/L106 (a `sup`
  game sits in `LIVE_STATUS` as “expected” forever), `audit-nonfinal-games.js`,
  `audit-pending-games-vs-playhq.js`, `size-locked-resweep.js` L76,
  `audit-finished-unlocked-seasons.js`, `audit-grade-coverage.js`.

  See `claude/fixture-refresh-and-withdrawals.md` §4.

## 7 · `gitCommit` in `nightly-crawl.js`

All seven `execFileSync` git calls carry `maxBuffer: 512 MB` **and `timeout: 10 min`** (added
2026-11-24, T104 — they previously had no timeout, and a run hung silently for 70+ minutes inside one
call while `timeout-minutes: 300` held the `data-write` lock).

A timeout is **retryable, not fatal**, and is reported as a STALL separately from contention:
`⚠ push STALLED past 10 min and was killed (attempt n/60) — retrying in Ns`.

⚠ The 10-minute git timeout documented against T26/T35 is in `build-player-games.js`, **not** in
`nightly-crawl.js`. Do not assume one script's guard covers another.
