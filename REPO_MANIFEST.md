# REPO_MANIFEST.md — Basketball Victoria Stats System

**Canonical reference for `markjovic/sports-players-stats` and `markjovic/stattrack`.**
Generated 2026-07-16 from a full read of all 78 scripts + 88 workflows, with the JSON
writer→reader graph derived mechanically (grep of every `readFileSync`/`writeFileSync`/
`unlinkSync` call), not from memory. This file is intended to replace re-uploading scripts
into each new conversation: it documents every file's purpose, trigger, schedule, reads,
writes, and how the pieces chain together.

> **Confidence markers:** every entry here was read in full ([V]-grade in the audit).
> The only files NOT documented are ~40 already-deleted files listed on `cleanup-repo.yml`'s
> manifest that never existed in any working tree during this audit — they are gone, not missing.

---

## 0. HOW TO READ THIS DOCUMENT

- **§1 Live core** — what actually runs on a schedule and how the jobs chain. Read this first.
- **§2 Scripts** — every `scripts/*.js|*.cjs`, grouped by role, with reads/writes/trigger.
- **§3 Workflows** — every `.github/workflows/*.yml`, with trigger, schedule, and the script it runs.
- **§4 JSON / data files** — the writer→reader graph: who writes each file, who reads it, is it needed.
- **§5 Progress files** — the resumable-checkpoint dotfiles and their delete-on-success behaviour.
- **§6 Known issues & open decisions** — live bugs, contradictions, and design calls awaiting Mark.
- **§7 Conventions** — the non-negotiable git/workflow/code rules this repo enforces.

Legend for verdicts: **LIVE** (runs in steady state) · **TOOL** (on-demand ops utility, keep) ·
**FIX** (live but has a bug to correct). Files that were completed one-offs have been DELETED (see the
"removed in cleanup" records in §2.3 / §3.4 / §4.3); they are not listed as live files.

---

## 1. THE LIVE CORE (what runs automatically)

### 1.1 Schedules
| Workflow | Schedule (UTC) | Local (AEST) | Purpose |
|---|---|---|---|
| `nightly-crawl.yml` | `0 15 * * *` daily | 01:00 daily | Ingest new/changed games, chain downstream builds |
| `weekly-indexes.yml` | `0 2 * * 0` Sunday | 12:00 Sun | Full-population team-stats, player-games, win-loss; + fold-diverged backstop |
| `recheck-private-profiles.yml` | `0 2 1 * *` monthly | 12:00 1st | Re-probe private profiles for newly-public data |
| `discover-seasons-matrix.yml` | *(no cron)* — fired by nightly on Sundays when crawl drains | — | Sharded season/grade discovery |
| `fetch-profile-stats-matrix.yml` | *(no cron)* — fired by nightly when new players / rechecks exist | — | Per-shard profile stats fetch |
| `fold-diverged-players.yml` | *(no cron)* — fired by the matrix on terminal completion | — | Fold re-diverged players onto api ids |
| `discover-fixtures.yml` | *(no cron)* — fired by nightly on Mondays when crawl drains (2026-07-21) | — | Weekly future-fixtures sweep (`--current-only`); chains finals→leaderboards via `chain_stats` |
| `build-finals-stats.yml` | *(no cron)* — fired by discover-fixtures' chain-stats job (2026-07-21) | — | Weekly `active_only=true`; chains leaderboards via `chain_leaderboards` |
| `build-leaderboards.yml` | *(no cron)* — fired by build-finals-stats' chain job (2026-07-21) | — | Weekly `active_only=true` |
| `post-drain-chain.yml` | *(no cron)* — fired by the matrix terminal at drain, OR by nightly directly on matrix-skipped nights (2026-08-07) | — | Sequential derived-data builds under ONE data-write acquisition (T19 structural fix); dispatches fold + Deploy Pages + Graduate Seasons |
| `graduate-seasons.yml` | *(no cron)* — fired by post-drain-chain's tail, unconditionally (2026-08-07; moved there from the nightly the same day — §2.7) | — | Season graduation for the active/locked split; 28-day grace lives HERE ONLY (`grace_days` input default) |
| `weekly-indexes.yml` | **cron 02:00 UTC Sun** (12:00 AEST Sun) | — | ⚠ CHAIN ORDER MATTERS (2026-08-13): `discover-fixtures → team-stats → win-loss → player-games → fold-diverged`, serialised by `needs`. Workflow-level `data-write` does NOT serialise a workflow's own jobs (T28), and `build-player-games` derives `games[]` entirely from `games/bv` (T29) — anything added that WRITES games/bv must be placed BEFORE `player-games`. Its `discover-fixtures` job passes `--concurrency=40`, the proven value |
| `discover-seasons-matrix.yml` | **cron 20:00 UTC Sun** (06:00 Mon AEST) — MOVED here 2026-08-10 from nightly-crawl's terminal fan-out | — | Weekly season + pre-game-roster discovery. Schedule mode resolves `backfill_teams=true` (T27) |
| `discover-fixtures.yml` | **cron 20:00 UTC Mon** (06:00 Tue AEST) — MOVED here 2026-08-10 | — | Weekly future-fixtures sweep; schedule mode = `--current-only` + stats chain (T27) |
| `spectator-backfill.yml` | cron 10:00 UTC Sat — **COMMENTED OUT for the re-sweep campaign** (2026-08-08); re-enable at campaign end (OUTSTANDING §2.9) | — | Permanent weekly tail: sweeps games that aged past the 30-day guard |
| `deploy-archive-pages.yml` | **cron 18:00 UTC Sat** (04:00 Sun AEST) + dispatched by graduation and backfill tails | — | **Lives in `markjovic/sports-players-stats-archive`**, builds the ARCHIVE origin from THIS repo's checkout (locked OR archivedAt — union rule) |

`deploy-pages.yml` trigger location, recorded precisely (2026-08-07 — the imprecision cost a session
detour): `workflow_dispatch` + `workflow_run` on five workflow **NAMES** (Weekly Indexes, Build
Leaderboards (Full), Build Search Index, Build Single-Game Records, Fold diverged players) — the
dispatch is NOT in nightly-crawl.yml; the chaining happens via those terminals' completions, plus
explicit dispatches from post-drain-chain and graduate-seasons.

Everything else is `workflow_dispatch` (manual) only.

### 1.2 The nightly chain (topology)
```
nightly-crawl (cron 15:00 UTC daily)  [concurrency: data-write]
│
├─ crawl ─────────────► nightly-crawl.js: Phase 2 fetches ROUND FIXTURES itself
│                       (discoverFixtureByRound; 2026-07-21: `--rounds-forward=N|all`
│                       adds FUTURE rounds — default 0 = nightly unchanged; grades with
│                       NO current round now fetch their first unsettled round instead
│                       of being skipped), writes games/bv/{sid}.json,
│                       roundsComplete markers, .nightly-status.json,
│                       needs-matrix-shards.json ; outputs: games_remaining,
│                       games_processed, new_players, stats_rechecks
│
├─ team-stats ────────► build-team-stats.js --active-only   → team-stats/bv/{sid}.json
├─ team-index ────────► update-team-index.js                → data/team-index.json
├─ venue-lookup ──────► update-venue-lookup.js               → venue-lookup/*
│    (venue-indexes MOVED to post-drain-chain.yml 2026-08-07 — post-drain by construction,
│     so the matrix-storm push contention that was killing it is gone at the source)
├─ win-loss ──────────► build-win-loss.js --active-only      → players/**/*.json (win/loss fields)
│
├─ profile-stats-matrix (if new_players≠0 OR stats_rechecks≠0)
│    └─ gh workflow run fetch-profile-stats-matrix.yml  --field shards=<needs-matrix-shards.json>
│
├─ post-drain-chain (terminal drain AND matrix NOT triggered) ► gh workflow run post-drain-chain.yml
│                                  (mirror gate — matrix-skipped nights previously ran NO post-drain
│                                  builds and published NOTHING; matrix nights: its terminal dispatches)
│
├─ discover-seasons (Sundays only, if games_remaining==0)
│    └─ gh workflow run discover-seasons-matrix.yml --field backfill_teams=true
│       (2026-07-21: weekly pre-game roster capture — mode all+backfill, implies
│        all_players; ~411k probes, ~2× the old current-mode sweep)
│
├─ discover-fixtures-weekly (Mondays only, if games_remaining==0)      ◄── 2026-07-21 §C7 chain
│    └─ gh workflow run discover-fixtures.yml --field current_only=true --field chain_stats=true
│         └─ chain-stats job (success-gated) → gh workflow run build-finals-stats.yml
│              --field active_only=true --field chain_leaderboards=true
│              └─ chain-leaderboards job (success-gated) → gh workflow run
│                   build-leaderboards.yml --field active_only=true
│       (Mon 15:00 UTC nightly = Tue 01:00 AEST; chain lands Tue early AM. Accepted
│        coupling: nightly chain halt ⇒ week's sweep skipped ⇒ manual re-dispatch.)
│
└─ retrigger (if games_remaining≠0; stops after 3 zero-progress runs)
     └─ gh workflow run nightly-crawl.yml (self, consecutive_zeros incremented)
```

### 1.3 The profile-stats matrix and the FOLD (critical operational detail)
```
fetch-profile-stats-matrix (self-retriggers; run cap 150; 3 zero-written runs = "stuck"=DONE)
│  [triggered by nightly with TARGETED shards, or manually with shards=[] for all 256]
│
├─ clear-stats-checked (only if force=true)
├─ generate-shards → fetch (256 matrix, max-parallel 20) → apply-and-commit
│                    each shard: fetch-profile-stats.js --shard=XX
│                    reads: players/indexes/{xx}, players/aliases/{xx}, players/{xx}/*, data/sports-index.json
│                    writes: players/{xx}/*.json (stats), possibly players/aliases/{xx}
│
└─ summary-and-retrigger
     ├─ if written>0 and run<150 → retrigger next run
     ├─ if 3 consecutive zero-written runs → status=STUCK (terminal):
     │     1. gh workflow run build-leaderboards.yml
     │     2. gh workflow run build-search-index.yml
     │     3. gh workflow run build-records.yml
     │     4. gh workflow run fold-diverged-players.yml --field mode=apply   ◄── THE FOLD
     │     5. gh workflow run build-team-stats.yml --field active_only=true   ◄── 2026-07-21
     │        roster-lag fix: roster stats come from player reg stats, which THIS matrix
     │        writes — the nightly's own team-stats job runs before the matrix and can
     │        never see tonight's stats, so rosters lagged the player view by a day
     └─ if run≥150 → max_runs (exit 1, manual intervention)
```

> **THE FOLD TRIGGER — how it actually fires (corrected 2026-07-16):**
> The fold is the 4th terminal action when the matrix reaches `status=stuck` (3 consecutive
> zero-written runs). Crucially, the matrix **preserves its targeted shard set across self-retriggers**
> (`NEXT_SHARDS = inputs.shards`, line 313), so a nightly-triggered run on a small shard set runs its
> OWN retrigger chain to completion: run 1 fetches the new players (written>0 → retrigger), then the
> next runs find nothing to write, and after 3 consecutive zero-write runs it hits `stuck` and fires
> the rebuilds + fold. **So the fold DOES fire at the tail of each nightly matrix cycle** — not on the
> first run, but at the drain-end of that cycle's self-retrigger chain, which the same invocation
> reaches on its own. (This corrects an earlier overstatement in this session that the fold "does not
> run on the nightly path" — it does.)
>
> **The real residual risk (narrower):** the retrigger chain is a series of SEPARATE `gh workflow run`
> dispatches passing `consecutive_zeros` run-to-run via `--field`, not one durable loop. If any single
> dispatch fails to fire (WORKFLOW_PAT hiccup, Actions queue delay), the chain breaks BEFORE reaching
> `stuck`, and the fold is skipped for that cycle. Also, a cycle that keeps finding just enough to write
> on every run could hit the run cap (150) before stringing 3 zeros — unlikely on a small targeted set.
> Neither is a wiring gap; both are reliability edges of a multi-dispatch chain. See §6.2.

### 1.4 The event-driven fold (steady-state identity maintenance)
`fold-diverged-players.yml` (mode=apply) reads every player file, finds those carrying an `apiId`
(diverged/recovered players whose filename is still their old spectator id), moves them to their
api-id path, relocates the index entry, and commits once. This is permanent steady-state, not
migration residue: PlayHQ mints fresh spectator ids per person over time (the "Micaela Chang" case
had 3), so stub→recover→alias→fold recurs. No schedule; event-driven only.

---

## 1z. SESSION 2026-08-23/24 — THE ALIAS TABLE, VERIFIED

The standing assumption was that `players/aliases` is correct. It had never been tested. Every entry
was written by matching NAMES, and the matcher never checked whether the profile it picked actually
credits the games the alias goes on to deliver.

**Three tiers of evidence, weakest last, each only reached when the one before ran out:**

1. **Credits** (`probe-alias-credits`) — does PlayHQ credit the target with these games?
   81,685 audited: **77,142 supported (98.9%)**, 874 not, 3,517 no answer.
2. **Identity** (`probe-alias-names`) — who does the SPECTATOR box score say the id is?
   746 asked: 739 name agrees, **0 genuine disagreements**, 5 folding artefacts (Zac/Zachary,
   hyphen-vs-space). Of the agreements, **652 settled** and **87 still open** because several players
   carry that name — a name test cannot settle a name collision (T40).
3. **Registrations** (`probe-shared-name-aliases`, OFFLINE) — which same-named candidate held a
   registration for that game's season to one of the two teams playing it?
   87 examined: 24 confirmed, **23 to repoint**, 4 ambiguous, 36 none-fit.

**Applied:** 88 repoints, each re-verified against PlayHQ at apply time, then `build-player-games`
rebuilt 27,373 player files. The 23 from tier 3 are pending §1.1 of OUTSTANDING_TASKS.

**The case that exposed it.** `900f4fe6-bec3` appears in PlayHQ box scores as "Jida McCrae-Cooper" and
is NOT a PlayHQ profile — exactly what aliases exist for. Ours pointed it at `d6c25c0c`, a different
profile with a similar name, while `60eeeaa9-ab28` is the one PlayHQ credits with those games. Roughly
198 appearances sat on the wrong player, and `size-report` had been listing that alias third in its
"worst offenders" table for days.

**How much of the session was wasted, and on what.** Five diagnostics each had their own id comparison
and all five were wrong the same way (T37), producing a false split-identity finding and a false "185
pairs are two people". A five-hour audit resolved almost nothing because the session went stale and
only the main loop refreshed it (T39). Three separate tools aborted on their first line because the
report they read lived in a workflow artifact rather than the repo. Every one of those was the same
fault class fixed one instance at a time. The two checks now at the top of `claude_context.md` exist
to stop that, and they are checks to perform, not principles to hold.

---

## 2. SCRIPTS (`scripts/*.js`, `scripts/lib/*.cjs`)

All scripts use `const ROOT = path.join(__dirname, '..')`. CJS by default; ESM for
build-finals-stats, build-leaderboards, build-player-games, build-records (they use `import`).

### 2.1 Live pipeline (run on schedule / by the nightly chain) — KEEP

| Script | Purpose | Triggered by | Reads | Writes |
|---|---|---|---|---|
| `nightly-crawl.js` | Ingest new/changed games for active seasons; reclassify hidden; stub new players; flag stat-rechecks; **2026-07-21: `--rounds-forward=N|all` fetches future rounds (default 0); no-current-round grades fetch their first unsettled round** **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | nightly-crawl.yml (cron) | games/bv, data/sports-index.json, data/forfeit-games.json, players/indexes | games/bv/{sid}.json, players/{xx}/*, players/indexes/{xx}, `.nightly-status.json`, `needs-matrix-shards.json` |
| `fetch-profile-stats.js` | Fetch career/season stats per player for one shard; alias-aware; writes records field; **populates `player.name` from `publicProfile` (account tenant) when the name is missing / a placeholder / a season string** **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | fetch-profile-stats-matrix.yml, fetch-profile-stats.yml, add-player.yml | players/indexes/{xx}, players/aliases/{xx}, players/{xx}/*, data/sports-index.json, scripts/lib/* | players/{xx}/*.json, players/aliases/{xx} (new aliases), shard-summary-{xx}.json |
| `salvage-spectator-names.js` | ONE-TIME batched spectator-roster name salvage for placeholdered stragglers; `--plan` / `--shard=N` / `--reconcile`; per-game exhaustion — only confirms a placeholder when EVERY game was reached, never freezes on a transient miss **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | salvage-spectator-names.yml (dispatch) | players/{xx}/*, spectator.playhq.com | players/{xx}/*.json, players/indexes/{xx} (reconcile only) |
| `fold-diverged-players.js` | Move apiId-bearing player files to their api-id path; relocate index entries. **2026-09-01: the MERGE keeper changed.** It kept whichever record held more `games[]` entries — a captured-side count deciding ownership of credited-side data, and inverted in the population it meets (stub median 69 games, real profile 1). It now keeps whichever record actually holds stats, drops `statsChecked` on a tie so the next matrix run settles it, and dispatches a targeted re-fetch for those players. Run #77 rescued **533 of 541 merges** | fold-diverged-players.yml (matrix terminal / manual) | players/**, players/indexes | players/{xx}/*, players/indexes/{xx} (moves), refetch-shards.json |
| `discover-seasons.js` | Detect seasons/grades; burst+cursor shard mode; roster backfill. **2026-10-05 (§6.61): moved from `https.request` to nightly-crawl's `fetch()` client, verbatim — the client was what PlayHQ refused; session bookkeeping on `lib/playhq-session.cjs`; a refused bootstrap stops the shard at its cursor with `noSession:true` in the artifact instead of re-asking every batch; a rejected probe joins the retry list instead of being stepped over; the standalone path's `ReferenceError: retryList` after commit fixed** | discover-seasons-matrix.yml, discover-seasons.yml, test-backfill.yml, diagnose-season-grades.yml | data/sports-index.json, data/discover-progress.json, players | data/sports-index.json, data/discover-progress.json, players/{xx}/*, `.discover-*-progress` |
| `build-team-stats.js` | Per-team season stats; --active-only for nightly. **Roster stats sourced from player reg stats (games/bv p[] has NO stat lines)** — hence the matrix-terminal trigger (§1.3). TRUNC_LEN import + placeholder fix 2026-07-21. **2026-07-29: gitCommit upgraded to the house pattern (was the last 10-attempt outlier, and it SWALLOWED total push failure); dead `p[]` loop removed** | nightly-crawl.yml, weekly-indexes.yml, build-team-stats.yml, **matrix terminal (2026-07-21)** | games/bv, players | team-stats/bv/{sid}.json |
| `build-player-games.js` (ESM) | Per-player game index | weekly-indexes.yml, build-player-games.yml | games/bv, players | players/**/*.json, `.build-player-games-progress.json` |
| `seed-apiid-from-playhq-pairs.js` | Writes `player.apiId` on wrongly-keyed players paired to an api id by PlayHQ, so the fold can rekey them. Refuses on surname disagreement and on an unusable name into a merge. **2026-09-01: the `stubWouldOverwriteRealProfile` refusal was REMOVED** — it existed only because the fold's keeper rule let a bigger stub replace a real profile, which is fixed; `keeperOutlook` now mirrors the new rule and its warning block is a drift tripwire that must read 0 **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | seed-apiid-from-playhq-pairs.yml (dispatch) | reports/wrongly-keyed-census.json, PlayHQ | players/{xx}/*.json (apiId only), reports/apiid-seed-log.json |
| `measure-credited-coverage.js` | READ-ONLY. Samples players, fetches PlayHQ's credited game list and buckets every captured-not-credited game: forfeit / already in `u` / not in games/bv / no-registration season / **residue**. Also partitions `u` by whether PlayHQ credits it. One report file per stratum. Aborts if captured and credited share zero game ids — an id-form mismatch, not a finding **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | measure-credited-coverage.yml (dispatch) | players/**, games/bv, data/forfeit-games.json, PlayHQ | reports/measure-credited-coverage-{stratum}.json |
| `audit-diff-fields.js` | READ-ONLY, one shard. Checks `sports.Basketball.c`/`.x` were written and that `gp - games[] == c - x` holds. **Excludes withheld players** — `markNotObtainable` never reaches `finishOk`, so the diff never runs for them and comparing their stale `gp` reports the audit's own missing-field handling as a fault | audit-diff-fields.yml (dispatch) | players/{xx} (sparse) | stdout only |
| `find-lost-stats-from-folds.js` | Finds player files whose stats a pre-2026-09-01 fold destroyed, and un-checks them for re-fetch. **Narrowed 2026-09-04**: private + merged + checked also matches the ordinary public→private transition, so a `gp-ratio` test now separates stale-but-present from actually-lost | find-lost-stats-from-folds.yml (dispatch) | players/** | players/{xx}/*.json (statsChecked only), reports/lost-stats-from-folds.json, refetch-shards.json |
| `find-misrouted-appearances.js` | Finds `x` games another PlayHQ profile of the SAME PERSON is credited for, names the alias that carried them, and repoints it. Attributes games per alias — an alias carrying even one credited game is held back. Also runs the box-score verdict on every genuine gap | find-misrouted-appearances.yml (dispatch) | players/**, players/aliases/**, games/bv, scripts/lib/* | players/aliases/{xx}.json (apply only), reports/misrouted-appearances.json |
| `revert-alias-repoints.js` | Restores the 117 alias entries changed by the 2026-09-05 12:31 apply run. Old values embedded from that run's own report; each re-checked against disk before restoring | revert-alias-repoints.yml (dispatch) | players/aliases (sparse) | players/aliases/{xx}.json |
| `requeue-repointed-players.js` | Clears `statsChecked` on BOTH sides of every alias repoint so their stale `c`/`x` rebuild, then dispatches the matrix at only their shards. ~48 fetches instead of the ~70,000 a forced shard sweep would cost | requeue-repointed-players.yml (dispatch) | reports/misrouted-appearances.json, players/** | players/{xx}/*.json (statsChecked only), refetch-shards.json |
| `discover-org-seasons.js` | TOP-DOWN season discovery: asks every org in sports-index what competitions and seasons it runs via `discoverCompetitions(organisationID)`, adds any season the index lacks. Sees UPCOMING seasons with ZERO registrations, which the bottom-up probe cannot. `--season=<id>` looks one up directly | discover-org-seasons.yml (daily cron + dispatch) | data/sports-index.json, PlayHQ | data/sports-index.json |
| `verify-outstanding-claims.js` | READ-ONLY. Re-measures every documented figure in OUTSTANDING_TASKS/README against the database and prints MATCHES or DRIFT. Claims that cannot be checked from files are printed as unmeasurable rather than omitted — an omitted claim looks verified | verify-outstanding-claims.yml (dispatch) | players/**, reports/ | stdout / --json |
| `size-locked-resweep.js` | READ-ONLY sizing: locked re-sweep call volume, regs-only teams, no-rn/pending re-measures, parse health | size-locked-resweep.yml | games/bv, players/indexes, data | /tmp report only |
| `size-appearance-gaps.js` | READ-ONLY sizing: PlayHQ `reg.stats.gp` (T20-deduped) vs local appearance counts — the residue measure. Independent sources, unlike the retired `size-missing-gids` (T24) | size-appearance-gaps.yml | games/bv, players, data | /tmp report only |
| `size-spectator-queue.js` | READ-ONLY sizing: DIRECT count of scored games with no player list, split `spc`-unset (fetch queue) vs `spc`-set (asked, empty) | size-spectator-queue.yml | games/bv, data | /tmp report only |
| `size-missing-gids.js` | ⚠️ RETIRED 2026-08-05 — TAUTOLOGICAL (compared `games[]` to its own source; always 0). Kept only as the worked example behind trap T24 | — | — | — |
| `rebuild-chain.yml` (workflow only) | One-off sequencer, nightly's shape: player-games → win-loss FULL → finals FULL → search → leaderboards force → Deploy Pages dispatch. Full-ancestry failure gates, start_at resume, workflow-level data-write lock. Ran green 2026-08-06 | — | — | dispatches only |
| `size-pages-artifact.yml` (workflow only) | READ-ONLY: per-directory raw + COMPRESSED artifact composition + largest files. The 2026-08-06 table: players 553M / games 260M / team-stats 159M / leaderboard 126M compressed | — | working tree | /dev/stdout |
| `size-locked-split.yml` (workflow only) | READ-ONLY diagnostic for the split: gzip-9 size of the three per-season dirs split by the `locked` flag. Measured 2026-08-07: locked share 81.2% (82.6/80.1/79.9). Reports MiB (reference table is decimal MB). First version aborted on the real index shape by design — refuses to guess | — | working tree, data/sports-index.json | /dev/stdout |
| `post-drain-chain.yml` (workflow only) | The nightly derived-data builds as SEQUENTIAL jobs under one workflow-level data-write acquisition (T19 structural fix, 2026-08-07): team-stats(--active-only) → venue-indexes → search → records → leaderboards(bare) → Deploy Pages dispatch; fold dispatched fire-and-forget after team-stats (queues behind the chain's lock as the lone waiter). Full-ancestry single-line gates, start_at resume, ref:main everywhere. Chain #1 green 38 min | — | — | dispatches only |
| `graduate-seasons.yml` (workflow only) | Season graduation (split): select (locked, no archivedAt, past `grace_days` — THE central grace variable, default 28), dispatch+poll archive deploy cross-repo (`ARCHIVE_DISPATCH_PAT`), probe every candidate LIVE, flip `archivedAt` (JOB-level data-write — the run waits ~40 min and a workflow-level lock would sit in T19's one-slot queue), dispatch Deploy Pages. `archivedAt` = VERIFIED FACT. Failed probes: flags stay unset, season keeps serving from ACTIVE, retried next nightly dispatch, status job RED. Graduation #1 green 2026-08-07 | — | data/sports-index.json | data/sports-index.json + dispatches |
| `spectator-backfill.js` | One-off/rerunnable: the nightly's spectator step over games with NO roster at all (locked seasons + tournaments the nightly never reached). 13 blocks byte-identical to nightly-crawl.js; skips statsChecked/reg-discovery by design; stubs+aliases new players; progress = spc:1 committed per 2,000 games. **Ran 2026-08-06: 7,844 filled / 15,928 spectator-dead / 1,095 stubbed. A second full pass returned 0/15,928 — the remaining queue is permanently dead; do NOT re-dispatch.** Games with ANY roster are LEFT ALONE — the 2.03M partial lists are not this tool's business **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | spectator-backfill.yml | games/bv, players, data | games/bv, players/**, indexes, aliases |
| ↳ *(2026-08-07/10 additions)* | `--include-partial` (widens the queue to partial-roster games — the re-sweep), `--min-age-days` (default 30; the guard is FRESHNESS, not lock status), `--miss-attempts` (default 1; durable `spcm` counter, retirement REVERSIBLE, measured retry conversion 0.003%), `--heal-dangling` (re-fetch spc games whose `p[]` has unresolvable ids), `--locked-only`. Player phase now runs PER COMMIT WINDOW (crash consistency); `p[]` replaced only when the id SET differs | | | |
| `build-win-loss.js` | Win/loss records per player; --active-only nightly, full weekly. **2026-08-04: career totals deduped once-per-(sid,tid) in BOTH modes (T20 — per-reg iteration doubled every regraded career; deltas compounded nightly). FULL run required once to repair stored values** | nightly-crawl.yml, weekly-indexes.yml, build-win-loss.yml | games/bv, players | players/**/*.json |
| `build-leaderboards.js` (ESM) | All-time + per-season leaderboards. ⚠️ CORRECTED 2026-08-07: the nightly/chain run is BARE (resume, FULL scope) — the old "--active-only nightly" claim here was FALSE (the terminal's `force=false` dispatch adds no flags; the live workflow's header even corrects an older version of the same claim). `--active-only` belongs to the WEEKLY finals chain only | post-drain-chain (bare), weekly finals chain (--active-only), build-leaderboards.yml | players/**, games/bv | leaderboard/*, `.build-leaderboards-progress.json` |
| `build-search-index.js` | Player search index shards | post-drain-chain, build-search-index.yml | players/**, players/indexes | search/players/{xx}.json |
| `build-records.js` (ESM) | Single-game records | post-drain-chain, build-records.yml | games/bv, players | records/*, `.records-progress.json` |
| `build-finals-stats.js` (ESM) | Finals/GF apps+wins per player; resolver-aware. **2026-08-05 (v3): career `finalsStats={gp,boxedGp,pts,threePt,fouls,wins,losses,draws,gids}` + per-reg `fstats={gp,bg,pts,tp,f,w,l,d,g}`. Finals W/L from scores+side; `boxedGp` is the scoring denominator (box lines exist for ~0.15% of games); `gids` let StatTrack hydrate finals scoring client-side from the Worker. Forfeits excluded from finals GP. Appearance basis p[]∪hp∪ap. NO PROGRESS FILE (T22 — the old committed map hit 110MB); push fails fast on size rejections. KNOWN DEFECT: accumulator keyed per SID, so finals flags land on every reg in a season — see OUTSTANDING §2.4** | build-finals-stats.yml | games/bv, team-stats/bv, players | players/**/*.json |
| `build-venue-indexes.js` | Date→venue and season→venue indexes | post-drain-chain (moved from nightly 2026-08-07), build-venue-indexes.yml | venue-lookup, games/bv | date-venue-index/*, data/season-venue-index.json |
| `update-team-index.js` | Add AND correct data/team-index.json entries. ⚠️ **Input corrected 2026-09-08: it reads `players/indexes/` and the player files' `seasons[].regs[]`, NOT `team-stats/bv`** — it never opens team-stats. | nightly team-index job, update-team-index.yml | team-stats/bv | data/team-index.json |
| `update-venue-lookup.js` | Refresh venue-lookup shards | nightly venue-lookup job, update-venue-lookup.yml | games/bv, venue-lookup | venue-lookup/* |
| `scripts/lib/uuid-prefix.cjs` | Single source of truth for TRUNC_LEN (13), isFullUuid, isTruncatedPrefix, alias-aware resolver (index-first → alias trunc13+legacy-10 → self-wins) | required by many | — | — |
| `scripts/lib/namespace-resolve.cjs` | PlayHQ recovery queries + matchers; normName (OLD form, no NFKC); isPlaceholderName (canonical `Player #` test) | fetch-profile-stats, backfill, diagnostics | — | — |
| `scripts/lib/playhq-session.cjs` | PlayHQ session request-budget guard (§6.60): counts calls, rotates at 250 or 15 min, single-flight refresh; does NOT fetch. **2026-10-05 (§6.61): waiters add their own call after a shared refresh (was `calls = 1` each — a "250" session carried 274 at concurrency 25, 289 at 40); `ensure()` returns a generation and `rotateNow(why, gen)` skips when the session already moved on** | nightly-crawl (2 sites), fetch-profile-stats (4 sites), discover-seasons (ensureSession) | — | — |
| `close-empty-seasons.js` | Closes finished, unlocked, game-less seasons — but ASKS PlayHQ first (gradeRounds then discoverFixtureByRound, the nightly's own calls). Three outcomes that are never collapsed: empty at PlayHQ → close; has games → capture gap, do NOT close; no answer → leave and report. Writes `locked`/`closedAt`/`closedReason`, never `removed:true`. **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | close-empty-seasons.yml (cron + dispatch) | data/sports-index.json, games/bv, PlayHQ | data/sports-index.json |
| `audit-removed-org-seasons.js` | READ-ONLY. Sizes the repair of the seasons discover-org-seasons.js wrote `removed:true` on 2026-09-07 because their grade lookup was CloudFront-blocked rather than because PlayHQ has no grades. Carries the AIMD pool and the bug guard before they go into the discovery script. **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | audit-removed-org-seasons.yml (dispatch) | data/sports-index.json, PlayHQ | reports/removed-org-seasons-audit.json |

### 2.2 On-demand tools (keep; not scheduled) — TOOL

| Script | Purpose | Reads | Writes |
|---|---|---|---|
| `probe-unresolved-aliases.js` | **Alias audit, tier 4.** For the 40 nothing settled, prints PlayHQ's box-score name, jersey number and TEAM per game, against every candidate's registration for that season. One screen each **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | reports/shared-name-alias-audit.json, PlayHQ spectator | reports/unresolved-alias-audit.json (COMMITTED) |
| `probe-selfalias-check.js` | Asks whether deleting a self-redirecting alias is safe: does a player file exist for the full uuid? OFFLINE | reports/unresolved-alias-audit.json, players | — |
| `seed-missing-profiles.js` | Seeds a player file + index entry from `publicProfile`, THEN deletes the alias. ⚠ Built on a premise that proved WRONG (T41) — the 40 ids are spectator-namespace and `publicProfile` returns NOT_FOUND, so it correctly seeded NOTHING. Retained for a genuine case **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | reports/unresolved-alias-audit.json, PlayHQ | players/, players/indexes/, players/aliases/ |
| `probe-alias-credits.js` | **Alias audit, tier 1.** Does the target profile CREDIT the games each alias delivers? All 81,685 name-matched entries, 2026-08-24: 77,142 supported (98.9%), 874 not. Resumes from a COMMITTED cache; refreshes the session on a cycle (T39) **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | players/aliases, games/bv, PlayHQ | reports/alias-credit-audit.json + caches (COMMITTED) |
| `probe-alias-names.js` | **Alias audit, tier 2.** For those the credit test could not settle, asks the SPECTATOR box score who the id actually IS. 739 name agrees (652 settled, 87 shared-name), 0 genuine disagreements **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | reports/alias-credit-audit.json, PlayHQ spectator | reports/alias-name-audit.json (COMMITTED) |
| `probe-shared-name-aliases.js` | **Alias audit, tier 3 — OFFLINE.** For names SEVERAL players share, which candidate held a registration for that game's SEASON to one of the two teams playing it? 24 confirmed, 23 repoint, 4 ambiguous, 36 none-fit | reports/alias-name-audit.json, players, games/bv | reports/shared-name-alias-audit.json ⚠️ artifact only |
| `repoint-aliases.js` | Applies confirmed repoints. Merges ALL THREE report sources, RE-VERIFIES every one against PlayHQ at apply time, records before/after BEFORE writing. 88 applied 2026-08-24 **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | the three reports, players/aliases | players/aliases, reports/alias-repoint-log.json |
| `probe-verdict-conflict.js` | **Settles the two-audit disagreement.** Splits each "two people" verdict by whether each side appears under its OWN id or only via an ALIAS — a verdict resting on our own alias is circular (T38) | reports/both-resolve-pairs.json, players/aliases, games/bv | reports/verdict-conflict-audit.json ⚠️ artifact only |
| `trace-player-game.js` | Traces ONE value: for each game in a player's games[], prints every roster id and its alias target, so "how did this get here" is answered by inspection not inference | players, players/aliases, games/bv | — |
| `scan-roster-id-forms.js` | Counts p[] ids by length and finds rosters listing the same person under BOTH forms. 2026-08-24: 99.24% truncated, 0.76% full, ZERO double-listed (T37) | games/bv | — |
| `probe-my-aliases.js` | Checks whether aliases written by a given merge deliver appearances their target is registered for | players/aliases, players, games/bv | reports/ ⚠️ artifact only |
| `fix-merge-aliases.js` | Recovers the exact set of alias entries a merge added by DIFFING GIT HISTORY, then verifies each against PlayHQ before removing any **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | git history, players/aliases, PlayHQ | players/aliases, reports/removed-merge-aliases.json |
| `db-audit.js` | Full DB audit + repo size + repo-hygiene (§11b: orphan progress files, stray reports) — READ-ONLY, flags only | whole tree | reports (audit only) |
| `diagnose.js` | General player/stats/hidden/game inspector (mode+arg) | targeted | diagnose-{arg}.json (artifact) |
| `diagnose-nightly-health.js` | Inspect last N nightly runs via Actions API | Actions API | — |
| `diagnose-id-field-lengths.js` | ID-length histogram in games/bv (checks for any lingering 10-char legacy ids) | games/bv, players/indexes | — |
| `audit-uuid-collisions.js` | Prefix-collision counter at --len=N (10 vs 13) | players/indexes | reports/uuid-collisions-len{N}.json |
| `recheck-forfeit-games.js` | Re-verify forfeit game records **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | games/bv | games/bv/{sid}.json |
| `recheck-private-profiles.js` | Monthly re-probe of private profiles | players | players/**/*.json |
| `find-players-by-team.js` | Player search by team/season/grade | players, scripts | — (report) |
| `find-flag-collisions.js` | Find flag collisions in games (until 49 resolved) | games/bv | — (report) |
| `clear-stats-checked.js` | Clear statsChecked to force re-fetch (--fix-corrupt-names path is dead) | players | players/**/*.json |
| `discover-game-backfill.js` | **SECOND roster capture path (2026-08-11).** Walks games spectator retired (`spcm` set, no `spc`), asks `api.playhq.com/graphql` `gameView` → `discoverGame` — the CANONICAL record, which holds paper-scored games spectator never had — and writes the same bare-id `p[]` plus `dg: 1`. Never writes `spc`, never touches `spcm`; own permanent failures → `dgm`. Query embedded VERBATIM from a browser capture, untrimmed. Profiles arrive as full uuids WITH names, so stubs are born named **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | api.playhq.com | games/bv, players/ | games/bv, players/ |
| `size-negative-gap.yml` (workflow only) | READ-ONLY, offline: players whose `games[]` exceeds the appearances PlayHQ credits. Separates candidate causes by provenance and flags duplicate season registrations. ⚠ Does NOT yet read the `private` flag, so it ranks private profiles as offenders and its `dg`-share conclusion line is worded backwards (OUTSTANDING §2.17) | — | games/bv, players/ | /dev/stdout |
| `size-misses.yml` (workflow only) | READ-ONLY anatomy of spectator misses: totals, per-year coverage, `profileOnly` share, and the clustering diagnostic (DEAD / MIXED / COVERED seasons) with sample game-centre URLs for spot-checking | — | games/bv, sports-index | /dev/stdout |
| `probe-player.js` | READ-ONLY single-player reconciliation against the profile API: every credited game classified ok / NOT-IN-P[] (with alias verdict) / GAME-ABSENT, per-season rollup, recovery estimate. Blocks verbatim from `probe-missing-games.js` **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | api.playhq.com | games/bv, players/, sports-index | /dev/stdout (no writes) |
| `repair-player.js` | Targeted per-player roster repair: appends the player + stat line to held games whose roster genuinely lacks them. **Alias-gated per game** — GENUINELY-ABSENT only; PRESENT-as-alias / PRESENT-legacy are fold problems where appending would DUPLICATE. Dry-run default; archive redeploy at tail **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | api.playhq.com | games/bv, players/ | games/bv |
| `repair-players-batch.js` | The same repair driven down a self-computed gap ranking (`--min-gap`). Progress file `reports/repair-batch-progress.json` committed every 25 players; dead profiles recorded and never retried; resume = re-dispatch. `gitCommit` verbatim from nightly-crawl.js **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | api.playhq.com | players/, games/bv | games/bv, reports/ |
| `synthesize-missing-games.js` | One-off (re-runnable) writer for games absent from games/bv entirely but proven by profile responses — writes `profileOnly` entries (no d/vid/hs/as: the profile carries none). Applied 2026-08-07: 9 synthesized + 69 appends to pre-existing profileOnly entries, 17 files **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | api.playhq.com | games/bv | games/bv |
| `size-gap-players.yml` (workflow only) | READ-ONLY, offline, zero API calls: per-player appearance-gap distribution (profile `gp` minus `games[]` length) with severity buckets and the worst 20 by name. ⚠️ Read ONLY after a `build-player-games` rebuild — its two inputs update on different clocks | — | players/ | /dev/stdout |
| `size-resweep.yml` (workflow only) | READ-ONLY: sizes the spectator re-sweep target (FINAL, partial pre-spc `p[]`, no `spc`) with a per-year breakdown. Baseline 2026-08-07: 2,026,441 games, avg 12.8 ids | — | games/bv | /dev/stdout |
| `scan-complete-rounds.js` | Backfill roundsComplete markers; --unlock reopens locked seasons AND clears `archivedAt` in the same write (split invariant, 2026-08-07) + prints the T23 deploy reminder | games/bv, data/sports-index.json | games/bv, data/sports-index.json |
| `discover-fixtures.js` | **Full-fixture tool via discoverTeamFixture (returns ALL rounds incl. FUTURE)**: `--all-seasons`/`--season` historical backfill + `--current-only` weekly future-fixtures mode (skips seasons with no game in 21 days). ⚠️ **staging bug — recorded here as "fixed 2026-07-21"; the deployed file did NOT have the fix. Corrected 2026-07-31 by reading it AND by reproducing the failure with its exact pathspec list.** One combined `git add` with any unmatched pathspec stages NOTHING (atomic), silently discarding a whole green run (30,426 games, 2026-07-19). ACTUALLY fixed 2026-07-31: per-path adds, `staging:` shortstat, inline identity, fail-fast on non-contention, THROW on exhaustion, and `cwd: ROOT` (which was missing entirely — it relied on `process.cwd()`). Candidate for a weekly cron (§6.8 pending decision). | games/bv, venue-lookup, data | games/bv/{sid}.json, venue-lookup/*, discover-fixtures-progress.json, zero-team-seasons.json |
| `find-code-refs.js` | *(no script — inline grep in `find-code-refs.yml`)* grep over scripts/ + .github/workflows/. **Exists because GitHub REFUSES to index this repo for code search** ("cannot be searched because it is too large", 6.13 GB, 2026-07-31) and returns "0 files" for every query, which is indistinguishable from "no matches". Scope hard-coded so it can never be aimed at games/ or players/ | scripts/, .github/workflows/ | — (report) |
| `audit-seasons-gaps.js` | READ-ONLY. Duplicate regs split by grade (regrade / null-gid / exact), regs missing gid, and the seasons[] gap across ALL games with an active/locked split | players/, games/bv, data/sports-index.json | — (report) |
| `repair-reg-sibling-sync.js` | ONE-OFF: makes regs sharing a (season, team) hold identical stats. Per-key MAX; idempotent; aborts if any value would decrease or a reg count changes. `--core-only` limits it to leaderboard-visible fields | players/ | players/{xx}/*.json |
| `repair-duplicate-regs.js` | ONE-OFF: merges regs duplicating the same `(tid, gid)`. Max-per-key merge; REFUSES groups where a shared key holds different values on every copy. Does NOT touch regrades or null-gid regs | players/ | players/{xx}/*.json |
| `build-search-index.js` shardKey v2 (2026-08-02) | Folds accents to base letters BEFORE stripping non a-z (Álvarez -> 'al', was 'lv'); stale cleanup deletes ANY shard the rebuild didn't produce (was hex-only — the gap that preserved 135 migrate-phase3 orphans for two months). Must stay identical to StatTrack searchPlayers' shard expression | players/indexes, players/ | search/players/{xx}.json |
| `size-opposition-index.js` | READ-ONLY sizer that retired the opposition-index builder: full-fidelity pass (build-win-loss classification), interned-pair accumulation, real serialized sample shards. Measured 2026-08-02: 16.2M pairs, 1,001.4 MB projected — not built. Re-runnable if the question reopens | players/, games/bv | — (report) |
| `db-audit.js` §11b (2026-08-02) | Hygiene rows show SIZE (files) / ENTRY COUNT (dirs), not age — mtime is checkout time in CI and git-log ages collapse at fetch-depth:1 | scripts/, reports/ | — (report) |
| `repair-legacy-flags.js` | ONE-OFF: deletes stale `legacy` from games where the flag is FALSIFIED — a score OR `st === 'UPCOMING'` (2026-08-02; strict equality, absent st clears nothing). Guards: per-game key diff, per-file game-count guard, full disk post-check before commit. `--dry-run`/`--season`/`--limit`. Applied 08-01 (3,114) and 08-02 (139); legacy population now exactly 3 | games/bv | games/bv/{sid}.json |
| `diagnose-forfeit-game.js` | READ-ONLY probe: one game's discoverGame result vs its stored record; verdict on fo-vs-scoreline (fo = WINNER id). Plumbing verbatim from recheck-forfeit-games.js; refuses to guess when the API returns no usable winner **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | games/bv, API | — (report) |
| `repair-forfeit-score.js` | ONE-OFF: rewrites hs/as of a single forfeit to winner-20/loser-0, winner derived from the record's OWN fo (never an input). Refuses non-forfeits and unusable fo; idempotent; key-diff + count + disk post-check. Closed ba9d21fe 2026-08-02 | games/bv | games/bv/{sid}.json |
| `probe-api-limits.js` | AIMD/endurance API concurrency probe **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | — (API) | — |
| `measure-playhq-limits.js` | Measures PlayHQ's limits, read-only, stops at the first refusal. `--mode=compare` (default): the nightly's `fetch()` bootstrap, the old `https.request` bootstrap, `fetch()` again, 10 s apart on one runner — settled 2026-10-05 that the CLIENT is what PlayHQ refuses (§6.61). `--mode=bootstrap`: cookieless requests at an interval until the first 403 (fleet allowance; also the matrix's canary at `--max=1`). `--mode=budget --uuid=`: spend one cookie slowly to settle whether ~290 is a count or a rate. `--ua=` overrides the user-agent. bootstrap/budget exit 1 if the FIRST request is refused — nothing measured. `fetch()` leg copied verbatim from nightly-crawl.js; the `https.request` leg is the client discover-seasons.js USED to have, kept so the comparison stays reproducible | — (API) | — |
| `test-api.js` | API smoke test (concurrency/profile/game/schema/gps/fixture) **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | — (API) | — |
| `report-alias-index.js` | Read-only tally over players/aliases | players/aliases | reports/alias-index-report.json |
| `verify-enrich.js` | Read-only validity scan of every player file | players | reports/verify-enrich-report.json |
| `verify-p-redundancy.js` | One-off p[] redundancy diagnostic (run to close open Q) | games/bv | p-redundancy-examples.json (artifact) |
| `restore-deleted-file.js` | Restore a file from git history | git history | the restored file |
| `count-stats-checked.js` | Count statsChecked across player files | players | — |
| `find-root-json-refs.js` | *(inline in yml, no script)* grep root-json references | — | — |
| `audit-aliases-against-playhq.js` | READ-ONLY. The alias test the project never had: pairs a spectator id with an api id from PlayHQ's OWN two records of one game (spectator box score + gameView), joined on name, or name plus jersey where a name repeats — never by elimination against our own players/ directory. Resumable. **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | games/bv, players/, PlayHQ | reports/alias-vs-playhq-audit.json (COMMITTED), progress file |
| `audit-nonfinal-games.js` | READ-ONLY. Counts every game not in a terminal state (FINAL/CANCELLED/ABANDONED/FORFEIT — an allowlist, never a test for one non-terminal value), splits by whether the season is locked, then asks PlayHQ's canonical record about a sample of the frozen ones. 2026-09-10e spreads the sample across rounds. **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | games/bv, data/sports-index.json, PlayHQ | stdout + step summary |
| `audit-pending-games-vs-playhq.js` | READ-ONLY. Answers the question the season-lifecycle design rests on: games we hold as PENDING in seasons PlayHQ calls COMPLETED — does PlayHQ still call them pending? 685 asked, 0 finished. **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | games/bv, data/sports-index.json, PlayHQ | stdout + step summary |
| `census-wrongly-keyed-players.js` | Finds EVERY player file keyed on a non-api id — not the handful a game sample walks past — and recovers each one's real api id from PlayHQ. Emits the report `seed-apiid-from-playhq-pairs.js` consumes unchanged. Bootstrap hardened for 256-shard contention (two cookie queries, attempt×5000 backoff, per-request network catch, single-flight). **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | players/**, games/bv, PlayHQ | reports/wrongly-keyed-census.json |
| `correct-wrong-aliases.js` | Repairs aliases the audit PROVED wrong, from the audit's own evidence only — the spectator/api pairing, never elimination. **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | reports/alias-vs-playhq-audit.json, players/, PlayHQ | players/aliases/{xx}, reports/alias-correction-log.json |
| `verify-players-against-playhq.js` | READ-ONLY. The check that should have come first: compares a player's credited games and points at PlayHQ against what StatTrack holds, player by player. Writes and COMMITS one report; no data-write lock. **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | players/**, PlayHQ spectator | reports/verify-players-against-playhq.json (COMMITTED) |
| `repair-season-names.js` | Repairs player files whose top-level `name` is one of their own `seasons[].sn` (the `parseProfileStats` seasonStatistics[0].name bug). Quantum from `scan-season-name-contamination.js`: 40,034 files, all spectator-keyed. **2026-10-05 (§6.62): moved to fetch() — the client was the key, §6.61** | players/**, PlayHQ spectator | players/{xx}/*.json (name only) |

### 2.4 Findings of the spent one-off diagnostics (recorded 2026-09-10)

`audit-tooling-inventory.js` splits deletion candidates into SAFE (the finding is already
written down) and DOCUMENT-FIRST (it is not, so deleting the script silently discards
whatever it established). On 2026-09-10 that second list held 22 scripts. This section
exists to move them across — **a probe's value is its answer, not its code.**

Recovered from the project's own chat history. Where a finding could not be recovered it
says so; **an unrecovered entry must NOT be deleted on the strength of this section.**

**The duplicate / phantom-profile campaign (Aug 2026) — CONCLUDED, zero duplicates remain.**
- `size-duplicate-profiles.js` — sized it: **2,895 candidate pairs across 122,866 duplicated
  appearances.**
- `merge-phantom-profiles.js` — **cleared 2,482 phantom profiles**, cutting the candidate set
  to 416 pairs / 6,616 appearances.
- `probe-both-resolve.js` — asked PlayHQ about the survivors: **185 pairs are decisively two
  real people, and ZERO genuine duplicates remain.** Its first run used a broken id-length
  matcher and produced invalid verdicts; that defect is the origin of the shared-matching rule
  below.
- `probe-duplicate-profiles.js` — the four-case classification the above ran on.
- `probe-shared-roster.js` — **reported Bailey Walton as a "split identity" when both his ids
  were present in every roster.** Cause: `p[]` entries exist as 13-character truncations AND
  full 36-character UUIDs, and five separate tools had each written their own matcher handling
  only the truncated form. **Fix, and the surviving value of this probe: `playerIdSet()` and
  `rosterIdMatches()` in `lib/namespace-resolve.cjs`, now used by every tool.**

**The 81,636-alias audit (Aug 2026) — CONCLUDED.**
- `probe-alias-credits.yml` — **98.9% of aliases confirmed correct by PlayHQ, 874 unsupported,
  128 repointable.** `repoint-aliases.yml` was built to apply those 128 with re-verification.
  It ran through several failed iterations first: a session lock permitting 8 simultaneous
  cookie refreshes, a session refreshed only at startup, and an artifact-restore failure —
  `download-artifact` without a `run-id` sees only the CURRENT run's artifacts, so every
  dispatch restarted cold. That last one is a standing trap.
- `probe-alias-names.yml` — for the ~760 unresolvable aliases, compares the name PlayHQ gives
  each id in its spectator box score against the alias target. Decisive when the names differ;
  when they agree it splits into "only one player with that name" (settled) and "several"
  (the Jida McCrae-Cooper shape, still open).

**The grading-round / zero-ladder investigation (Aug 2026) — CONCLUDED.**
- `probe-grade-ladder.js` — **`discoverGrade.ladder` returns EMPTY for grades that visibly
  have a ladder on playhq.com.** 55 grades queried for one season, all answered, none carrying
  a ladder. The population is **1,002 zero-team seasons, 42% of locked seasons**, and Mark
  predicted the cause before the sweep ran: grading rounds and hidden comps, run ladder-less by
  administrators. **The discover path is blind to them BY DESIGN — do not spend fixture calls
  there.** The working route is player profiles → game ids → spectator, and enumeration is
  local and exact: gids in `player.games[]` but absent from `games/bv` ARE the residue.
- `probe-absent-games.js` — emits the absent game ids rather than counting them, because they
  are directly fetchable through `discover-game-backfill`'s path and need no discovery.

**The CloudFront fingerprint investigation — CONCLUDED, and now an absolute rule.**
- `probe-setup-node-fingerprint.js` — proved that `actions/setup-node` changes the runner's
  outbound fingerprint and causes CloudFront 403s on every `api.playhq.com` request, including
  session acquisition. That rule is in every workflow header in this repo. The probe has no
  further use.

**Findings NOT recovered — do not delete these on the strength of this section.**
`probe-alias-stats.js`, `probe-discover-teams.js`, `probe-notfound.js`,
`probe-registrations.js`, `probe-roster-sources.js`, `probe-squad-evidence.js`,
`probe-stattrack-shapes.js` / `.cjs`, `probe-wrong-rosters.js`,
`prove-player-files-intact.js`, `rebuild-player-index.js`, `size-locked-backfill.js`,
`build-alias-worklist.js`, `diagnose-alias-conflicts.js`, `diagnose-nameless-players.js`,
`probe-session-throwaway.js`.
Several have report files under `reports/` that presumably hold their output — that is the
place to look before deleting any of them.

---

### 2.5 Present in `scripts/` but RECORDED AS REMOVED in TOOLING.md §2.3 (added 2026-10-05, §6.62)

TOOLING.md §2.3 and §3.4 record 26 scripts and 24 workflows as "Removed 2026-09-11".
FOURTEEN of those scripts and THIRTEEN of those workflows are still in the repository.
This section does not re-classify them — §2.3 is a record and is left alone — it states
what is actually on disk, because a file that is present can be dispatched, and every one
of these fourteen fetches api.playhq.com. All fourteen were moved to the `fetch()` client
on 2026-10-05 for that reason; see §6.62. Whether they should exist at all is a separate
decision and is NOT taken here.

| Script | Purpose | Reads | Writes |
|---|---|---|---|
| `diagnose-alias-conflicts.js` | Takes the WRONG and duplicateInRoster rows out of an audit report and asks PlayHQ which namespace each id in them actually belongs to. Read-only against games/ and players/. **2026-10-05 (§6.62): moved to fetch(), §6.61** | audit report, games/bv, players/, PlayHQ | one report |
| `probe-absent-games.js` | READ-ONLY, no writes/git/lock. OUTSTANDING §2.18 follow-up — the last real gap: 133,459 appearances still missing across 51,846 players. **2026-10-05 (§6.62): moved to fetch(), §6.61** | players/**, games/bv, PlayHQ | stdout |
| `probe-alias-stats.js` | READ-ONLY. Sizes one question: when a player carries spectator aliases, does PlayHQ credit games to those ALIAS profiles that fetch-profile-stats.js never queries? **2026-10-05 (§6.62): moved to fetch(), §6.61** | players/**, PlayHQ | stdout |
| `probe-both-resolve.js` | READ-ONLY to player data, writes one report. The remaining 416 same-named pairs holding the same games — 6,616 duplicated appearances. **2026-10-05 (§6.62): moved to fetch(), §6.61** | players/**, PlayHQ | reports/both-resolve-pairs.json |
| `probe-discover-teams.js` | READ-ONLY, a handful of API calls. Whether a GRADING grade's empty `discoverGrade.ladder` can be replaced as discover-fixtures' team source. **2026-10-05 (§6.62): moved to fetch(), §6.61** | PlayHQ | stdout |
| `probe-duplicate-profiles.js` | READ-ONLY. The 2,895 same-named pairs holding the SAME game ids — 122,866 duplicated appearances. **2026-10-05 (§6.62): moved to fetch(), §6.61** | players/**, PlayHQ | stdout |
| `probe-grade-ladder.js` | READ-ONLY. Prints RAW discoverGrade responses for the 2026-08-19 "Teams: 0 — no ladder data" case. **2026-10-05 (§6.62): moved to fetch(), §6.61** | PlayHQ | stdout |
| `probe-missing-games.js` | READ-ONLY. Proves or disproves that hidden/grading games can be reconstructed from data already received, at zero extra API cost. **2026-10-05 (§6.62): moved to fetch(), §6.61** | players/**, games/bv, PlayHQ | stdout |
| `probe-notfound.js` | READ-ONLY. OUTSTANDING §2.19 — the `5 NOT_FOUND: failed to find profile` rate on publicProfileTeams. **2026-10-05 (§6.62): moved to fetch(), §6.61** | players/**, PlayHQ | stdout |
| `probe-registrations.js` | READ-ONLY. The 1,115,172 appearances in games where the player holds a SEASON registration but not a TEAM one. **2026-10-05 (§6.62): moved to fetch(), §6.61** | players/**, games/bv, PlayHQ | stdout |
| `probe-roster-sources.js` | READ-ONLY against games/ and players/. Decides which record the game-by-game comparator should treat as the roster. **2026-10-05 (§6.62): moved to fetch(), §6.61** | games/bv, players/**, PlayHQ | reports/roster-source-probe.json (COMMITTED) |
| `probe-session-throwaway.js` | TEMPORARY by its own header — a one-question session test, to be deleted with its nightly-crawl.yml step once answered. **2026-10-05 (§6.62): moved to fetch(), §6.61** | PlayHQ | stdout |
| `probe-wrong-rosters.js` | READ-ONLY. The 970,068 appearances where the roster holds the player's own 13-char id and the player was registered to NEITHER team. **2026-10-05 (§6.62): moved to fetch(), §6.61** | games/bv, players/**, PlayHQ | stdout |
| `prove-player-files-intact.js` | READ-ONLY. Exists because a claim was made without testing it — verify-players-against-playhq got no answer from PlayHQ for 82% of the players it asked about. Writes and COMMITS one report. **2026-10-05 (§6.62): moved to fetch(), §6.61** | players/**, PlayHQ | one report (COMMITTED) |

### 2.3 Removed in cleanup (commit `fe8eedb`, 2026-07-16)

The api-canonical migration one-offs, the concluded diagnostics, the superseded proxy
cluster (`fetch-player-profiles.js`, `test-failed-uuids.js`), and the dead team-search
cluster (`search-team-stats.js`) have all been **deleted** from the repo. They are recoverable
from git history (parent commit `1faecc5`) if ever needed. The *knowledge* from the deleted
diagnostics is preserved in §6.7. There is no remaining "to delete" list — the cleanup is done.

`scripts/lib/uuid-prefix.cjs`, `scripts/lib/namespace-resolve.cjs` and `scripts/lib/playhq-session.cjs` (2026-10-04) are the only libs; all KEEP.

## 3. WORKFLOWS (`.github/workflows/*.yml`)

### 3.1 Live / scheduled — KEEP
| Workflow | Trigger | Runs | Notes |
|---|---|---|---|
| `nightly-crawl.yml` | cron daily 15:00 UTC + dispatch | nightly-crawl.js + chains 6 downstream jobs | data-write lock; the heart. No setup-node in crawl (fetches PlayHQ). |
| `weekly-indexes.yml` | cron Sun 02:00 UTC + dispatch | build-team-stats, build-player-games, build-win-loss(full) | ~~FIX: player-games safety-net step~~ — **DONE 2026-07-16 (§6.1); marker was stale, cleared 2026-07-29** |
| `recheck-private-profiles.yml` | cron monthly + dispatch | recheck-private-profiles.js | — |
| `fetch-profile-stats-matrix.yml` | dispatch (by nightly / add-player / self) | fetch-profile-stats.js × 256; terminal fold+rebuilds+**team-stats (2026-07-21)** | git-add fixed 07-16; stop-button fixed 2026-07-21 (apply/summary gates → `!cancelled()`) |
| `discover-seasons-matrix.yml` | dispatch (by nightly Sundays / self) | discover-seasons.js × shards | setup-node STRIPPED from map+reduce 2026-07-21 (§6.3 resolved); Sunday trigger now backfill_teams=true; **2026-08-03: debug scaffolding stripped (VERBOSE block + verify-output job), self-retrigger on the retry helper, reduce/retrigger gates `!cancelled()`, dry_run gate on the robust boolean form — see §6.24**; **2026-10-05 (§6.61): generate-shards makes ONE cookieless canary request (measure-playhq-limits.js, fetch() client) before the fan-out; `max_parallel` input, default 5 for dispatch, cron and retrigger (20 has no evidence since the 4th); reduce skipped when the canary fails; retrigger gated on `NO_SESSION_SHARDS=0`** |
| `fold-diverged-players.yml` | dispatch (by matrix terminal) | fold-diverged-players.js | clean; event-driven only |
| `fetch-profile-stats.yml` | dispatch | fetch-profile-stats.js (single shard) | manual escape hatch |
| `measure-credited-coverage.yml` | dispatch | measure-credited-coverage.js | READ-ONLY; own concurrency group |
| `audit-diff-fields.yml` | dispatch | audit-diff-fields.js | READ-ONLY; sparse checkout is correct here — one shard, ~1,600 files |
| `find-lost-stats-from-folds.yml` | dispatch | find-lost-stats-from-folds.js | data-write; report committed in BOTH modes |
| `find-misrouted-appearances.yml` | dispatch | find-misrouted-appearances.js | data-write in apply mode; writes aliases |
| `revert-alias-repoints.yml` | dispatch | revert-alias-repoints.js | data-write; sparse (aliases only) |
| `requeue-repointed-players.yml` | dispatch | requeue-repointed-players.js | data-write; dispatches the matrix at the affected shards, force NOT set |
| `discover-org-seasons.yml` | cron 19:00 UTC daily + dispatch | discover-org-seasons.js | data-write; mode resolves to APPLY on a schedule (T40) |
| `verify-outstanding-claims.yml` | dispatch | verify-outstanding-claims.js | READ-ONLY; own concurrency group |
| `add-player.yml` | dispatch | inline stub + trigger matrix for shard | ~~FIX: git stash~~ — **DONE 2026-07-16 (§6.1 item 3): stash replaced with write→add→commit→fetch→merge -X ours→push. Marker was stale, cleared 2026-07-29.** Explicitly kept per cleanup-repo. **2026-10-05 (§6.62): its inline ESM step was the ONLY live `https.request` left in `.github/` — a workflow file, but a real PlayHQ client. `post()` rewritten to `fetch()`; `import https` dropped; the no-cookie throw now names the HTTP status and body.** |

### 3.2 Build triggers (manual full rebuilds) — KEEP (safety-net strip COMPLETE, see §6.1)
`build-team-stats.yml` (clean, model; **data-write lock added 2026-07-21** — was the only team-stats writer outside it), `build-search-index.yml` (clean), `build-win-loss.yml` (clean),
`build-finals-stats.yml` (clean — the ⚠ previously recorded here was stale, its deployed YAML had no
safety-net step; 2026-07-21 second session: **data-write lock** + `chain_leaderboards` input + chain job),
`build-leaderboards.yml` (clean — same stale ⚠; 2026-07-21: `active_only` input added, fictional
"nightly calls --active-only" header corrected),
`build-player-games.yml`, `build-venue-indexes.yml`, `build-records.yml` — all clean.
(The ⚠ markers here flagged the `if: always()` + `git pull -X ours` safety-net step. §6.1 records it
REMOVED from all 6 build workflows and deployed on 2026-07-16; the markers were never updated and
sent readers hunting for bugs that no longer existed. Cleared 2026-07-29.)

### 3.3 On-demand tools — KEEP
`db-audit.yml`, `diagnose.yml`, `diagnose-nightly-health.yml`, `diagnose-id-field-lengths.yml`,
`audit-uuid-collisions.yml`, `recheck-forfeit-games.yml`, `find-players-by-team.yml`,
`find-flag-collisions.yml`, `find-root-json-refs.yml` (inline grep), `clear-stats-checked.yml`,
`scan-complete-rounds.yml`, `size-locked-split.yml` (read-only split diagnostic, 2026-08-07),
`probe-api-limits.yml`, `measure-playhq-limits.yml` (read-only; sparse `scripts` checkout; NOT in `data-write` on purpose — §6.61), `test-api.yml`, `report-alias-index.yml`,
`verify-enrich.yml`, `verify-p-redundancy.yml`, `restore-deleted-file.yml`, `count-stats-checked.yml`,
`update-team-index.yml`, `update-venue-lookup.yml`, `build-team-stats.yml`,
`find-code-refs.yml` (inline grep — the GitHub-code-search replacement), `repair-legacy-flags.yml`
(one-off, `data-write` lock, dry-run default), `generate-roster.yml`,
`diagnose-forfeit-game.yml` (read-only probe, no lock, sparse OK — reads ONE season file),
`repair-forfeit-score.yml` (one-off, `data-write` lock, dry-run default via `apply` boolean).

Added 2026-10-05 (§6.62) — six dispatch-only workflows that were in `.github/workflows/`
but in neither TOOLING.md §3 nor this section, so the inventory judged their scripts on
age alone: `audit-aliases-against-playhq.yml`, `audit-nonfinal-games.yml`,
`audit-pending-games-vs-playhq.yml`, `census-wrongly-keyed-players.yml`
(with `census-wrongly-keyed-matrix.yml`), `correct-wrong-aliases.yml`,
`verify-players-against-playhq.yml`. All `workflow_dispatch` only, no cron; all fetch
api.playhq.com, so none carries `actions/setup-node`.

### 3.4 Removed in cleanup (commit `fe8eedb`, 2026-07-16)

All migration/one-off/throwaway workflows were **deleted** (rekey-*, repair-*, reconcile,
backfill-* one-offs and matrices, recover-uuids, resolve-known-collisions, strip-redundant,
migrate-*, fix-* one-offs, classify-flagged-merges, build-alias-index-matrix, build-alias-inverse,
commit-cleared-names, find-team-players, fetch-player-profiles, reorganise-repo, db-report,
hold-check, diagnose-season-grades, and every concluded diagnose-* workflow). Recoverable from
git history. The two migration matrix templates are gone; the live `fetch-profile-stats-matrix.yml`
is the reference self-triggering-matrix shape going forward.

## 4. JSON / DATA FILES — WRITER → READER GRAPH (derived mechanically)

### 4.1 Live data files (KEEP — actively read and written)
| File | Written by | Read by | Needed? |
|---|---|---|---|
*(Game-entry capture flags, 2026-08-11 — three distinct facts, keep them distinct: `spc:1` roster captured from the LIVE-SCORING service; `spcm:N` that service was asked and could not serve it; `dg:1` roster captured from the CANONICAL record; `dgm:N` the canonical record permanently failed. A game may legitimately carry `spcm` AND `dg`. Any "already captured" check must test `spc` OR `dg`.)*

| `data/sports-index.json` | discover-seasons, scan-complete-rounds, graduate-seasons (`archivedAt`, 2026-08-07) | nightly-crawl, discover-*, fetch-profile-stats, build-*, deploy-pages strip, deploy-archive-pages (archive repo), StatTrack routing, many | **YES — master season registry.** Per-season flags: `locked`/`lockedAt` (crawl state) + `archivedAt` (VERIFIED live on the archive origin; set only by graduate-seasons after probing; cleared with locked by --unlock) |
| `data/discover-progress.json` | discover-seasons (matrix reduce) | discover-seasons, discover-seasons-matrix (generate-shards) | YES — discovery resume state |
| `data/team-index.json` | update-team-index | StatTrack, db tools | YES |
| `data/forfeit-games.json` | nightly-crawl, recheck-forfeit-games | nightly-crawl, fetch-profile-stats, add-player | YES |
| `data/venue-index.json` | **build-venue-indexes** (added 2026-09-08 — it had NO writer at all before that; "(venue build)" was a placeholder, see T56) | StatTrack | YES |
| `data/season-venue-index.json` | build-venue-indexes | StatTrack | YES |
| `players/indexes/{xx}.json` | nightly-crawl, fetch-profile-stats, fold, backfill | resolver (uuid-prefix.cjs), everything | **YES — the player index (256 shards)** |
| `players/aliases/{xx}.json` | fetch-profile-stats, build-alias-index(migration) | resolver alias fallback | **YES — spectator→api redirects (~43k)** |
| `players/{xx}/{uuid}.json` | nightly-crawl, fetch-profile-stats, build-*, fold | StatTrack, all builds | **YES — the player files (~411k)** |
| `games/bv/{sid}.json` | nightly-crawl (Phase 2), discover-fixtures (historical-backfill TOOL) | everything | **YES — the game data** |
| `team-stats/bv/{sid}.json` | build-team-stats | build-finals-stats, update-team-index, StatTrack | YES |
| `leaderboard/*.json` | build-leaderboards | StatTrack | YES |
| `search/players/{xx}.json` | build-search-index | StatTrack search | YES |
| `records/*.json` | build-records | StatTrack | YES |
| `date-venue-index/{date}.json` | build-venue-indexes | StatTrack | YES |
| `venue-lookup/*` | update-venue-lookup, discover-fixtures (tool) | build-venue-indexes | YES |
| `explore-results/` (1.34 MB) | *(ad-hoc, historical)* | — | **KEEP** — output of exploratory API calls made while developing the tooling. Retained as reference for when the docs are unclear. Classified 2026-07-31; previously undocumented. |
| `roster-results/` (216 KB) | *(ad-hoc, historical)* | — | **KEEP** — output of grade-roster lookups. NOTE: `generate-roster.yml` does NOT produce it (that workflow only prints to the job log), so the writer is historical. Classified 2026-07-31. |
| `index.html` (repo root, 127 KB) | *(manual)* | GitHub Pages | **KEEP — MIRROR of `markjovic/stattrack/index.html`.** ⚠️ `markjovic/stattrack` is CANONICAL; this copy must be updated in the same pass or it drifts. Pages serves this repo, so a stale mirror is a stale LIVE app, not just a stale file — the same drift class already open on the fixture generator and the dashboard. Classified 2026-07-31. |
| `zero-team-seasons.json` | discover-fixtures.js | *(none — report)* | YES. ⚠️ OUTSTANDING_TASKS §1.2/§2.3 claimed this "appears nowhere in REPO_MANIFEST". It always did — §2.2 above lists it as a discover-fixtures output and §6.8 names it in the staging-bug pathspec. |

### 4.2 Transient runtime signals (KEEP — short-lived, regenerated)
| File | Written by | Read by | Notes |
|---|---|---|---|
| `.nightly-status.json` | nightly-crawl.js | nightly-crawl.yml status step | Per-run; regenerated each run |
| `needs-matrix-shards.json` | nightly-crawl.js | **nightly-crawl.yml status step (counts length → stats_rechecks)**, profile-stats-matrix trigger | **IS READ — deleting it makes rechecks read 0** (corrects earlier "dead file" claim). Deleted on success by nightly-crawl.js. |
| `matrix-force-pending.json` | (matrix force path) | fetch-profile-stats-matrix.yml (deletes on stuck) | Force-run signal |

### 4.3 Removed in cleanup (commit `fe8eedb`, 2026-07-16)

The migration report JSON (`reports/rekey-merges.json`, `reconcile-people.json`, `alias-repair.json`,
`rekey-flagged-classified.json`, `alias-index-report.json`, `uuid-recovery-misattribution-audit.json`,
`backfill-missing-players-report.json`, `missing-player-files-diagnosis.json`), the entire
`reports/backfill-collisions/` directory (256 shards), `players/alias-inverse/` (256 shards), and the
orphaned `scripts/.*-progress.json` dotfiles were all **deleted**. `reports/verify-enrich-report.json`
remains (it is regenerated by the live verify-enrich tool).

**Note on `players/aliases/`:** this is LIVE and was NOT deleted — it holds the ~43k spectator→api
redirects the resolver depends on. It is now maintained solely by `fetch-profile-stats.js` (which
writes new alias discoveries) and consumed by the alias-aware resolver. The migration-era builders
of it (`build-alias-index.js`, `build-alias-inverse.js`) are gone, so there is no longer any tool
that rebuilds `players/aliases/` from scratch — if a full rebuild is ever needed, it must be written
fresh, sourcing `player.spectatorIds[]` (see §6.7 namespace-divergence note).

## 5. PROGRESS FILES (resumable checkpoints — delete-on-SUCCESS only)

**Verified mechanically:** all 14 progress-file owners call `unlinkSync` gated on the success/allDone
path (or `--force` reset), never in an error handler. A progress file surviving a crash is CORRECT —
that is what enables resume. The standard is **delete on success only**; never treat a surviving
progress file as garbage without checking whether its owner is mid-run.

| Progress file | Owner | Deletes on |
|---|---|---|
| `.build-leaderboards-progress.json` | build-leaderboards.js | success (+ --force reset) — TRUE ONLY SINCE 2026-07-21: the pre-fix script never deleted it, so completed runs silently no-op'd later runs; also mode-keyed now |
| `.build-player-games-progress.json` | build-player-games.js | success |
| `.finals-progress.json` | build-finals-stats.js | success — mode-keyed 2026-07-21 (active/full progress never cross-resumes) |
| `.records-progress.json` | build-records.js | success |
| `discover-fixtures-progress.json` | discover-fixtures.js (TOOL — kept) | success |
| `data/discover-progress.json` | discover-seasons.js | success (allDone) / --fresh_start |

db-audit.js §11b classifies any dotfile-progress in scripts/ as **orphan** (owner deleted → safe remove)
vs **owner-exists** (mid-run / crashed / failed self-clean → surface, never auto-delete).

---

## 6. KNOWN ISSUES & OPEN DECISIONS

### 6.1 Live workflow bugs — FIXED & DEPLOYED (2026-07-16)
All three are resolved in the repo:
1. **Safety-net `git pull -X ours` + `if: always()` step — removed from all 6 build workflows**
   (`weekly-indexes.yml` player-games job, `build-player-games.yml`, `build-finals-stats.yml`,
   `build-venue-indexes.yml`, `build-records.yml`, `build-leaderboards.yml`). Each script already
   commits cleanly, so the redundant step was deleted.
2. **`fetch-profile-stats-matrix.yml`** apply-and-commit `git add -A` → explicit `git add players/ scripts/`.
3. **`add-player.yml`** `git stash`/`stash pop` → write→add→commit→fetch→merge -X ours→push (no stash).
Also deployed: `weekly-indexes.yml` now has a `fold-diverged` backstop job (triggers the fold after its
player-writing jobs, as insurance against a broken matrix retrigger chain — see §6.2); and the
`probe-setup-node-fingerprint` test workflow (see §6.3).

### 6.2 The FOLD reliability question (corrected — see §1.3)
The fold IS wired into the nightly path: the matrix preserves its targeted shards across self-retriggers,
runs its chain to `stuck` (3 consecutive zero-written runs), and fires the fold at the drain-end of each
nightly cycle. So it is NOT a missing-trigger problem (earlier overstatement retracted).
The residual concern is reliability of the multi-dispatch retrigger chain: each retrigger is a separate
`gh workflow run`, so a single failed dispatch breaks the chain before `stuck` and skips the fold for
that cycle. **HARDENING APPLIED (2026-07-16):** option (b) is now built — `weekly-indexes.yml` has a `fold-diverged`
job that triggers `fold-diverged-players.yml --mode=apply` after its player-writing jobs (needs:
team-stats, player-games, win-loss). The fold is idempotent, so this weekly sweep is a no-op when the
nightly chain already folded, and catches anything a broken retrigger chain skipped. Also added:
`probe-setup-node-fingerprint.yml` (+ .js) — a controlled test for the setup-node question (§6.3).

### 6.3 The setup-node × PlayHQ-fetch contradiction — RESOLVED 2026-07-20/21
The rule is CONFIRMED and ABSOLUTE, scoped **per JOB** (not per workflow). Evidence: the
discover-seasons matrix failed session acquisition on every shard for ~10 days; instrumented
per-attempt logging (added to `discover-seasons.js` 2026-07-20) showed `HTTP 403 CLOUDFRONT-BLOCK
(919b HTML)` on attempt 1 from a fresh runner WITH setup-node, while the same-day nightly-crawl
(no setup-node) refreshed its session on attempt 1. A block on request #1 from a zero-traffic IP is
a fingerprint rule, not rate-based. The old "working counterexamples" were environmental and expired
~2026-07-10 (runner image or WAF rule change) — the matrix worked WITH setup-node until ~07-09.
Per-JOB scope proven by `nightly-crawl.yml`'s `win-loss` job, which carries setup-node harmlessly
(build-win-loss.js makes no PlayHQ calls). **Fixed:** setup-node stripped from
`discover-seasons-matrix.yml` (map + reduce — reduce also fetches PlayHQ via discoverSeason) and
standalone `discover-seasons.yml`. `probe-setup-node-fingerprint.yml` (+ .js) is now redundant —
deletion candidate. The per-attempt session instrumentation stays (permanently useful).

### 6.4 Cleanup — DONE (commit `fe8eedb`, 2026-07-16)
The repo cleanup ran live: 111 obsolete files deleted (migration one-offs, concluded diagnostics,
superseded clusters, orphaned progress dotfiles, migration reports, alias-inverse + backfill-collisions
dirs). Restore point: parent commit `1faecc5`. `discover-fixtures.js` was confirmed LIVE (the
`--all-seasons` historical-backfill tool) and kept; `build-foulout-stats.js` was confirmed not-live
and deleted. No outstanding deletions remain.


### 6.5 Data-quality caveats (record; not blocking)
- **p[] recovery misattribution:** `recover-uuids-from-git-history.js` paired p[] slots by array index
  across months; the spectator API doesn't preserve order, so some recovered p[] ids landed on the wrong
  person (Jack Delaney `0000ed35` case). Canonical player data is UNAFFECTED (migration re-fetched records);
  the caveat is scoped to `games/bv` p[] provenance only.
- **normName never upgraded to NFKC at runtime:** rekey-plan's matching used NFKC, but runtime writers
  (fetch-profile-stats via namespace-resolve.cjs, nightly) and StatTrack still use the OLD normName
  (lowercase + collapse-space + trim). Open item #6.

### 6.6 Other outstanding (from prior sessions, still open)
- ~~Add `--active-only` to `build-finals-stats.js`~~ **DONE 2026-07-21 (second session)** — and the premise
  was wrong: BOTH scripts already parsed the flag; finals' implementation was DESTRUCTIVE (never ran live —
  fixed before first use) and leaderboards' was sound but its progress file never self-cleared. See §6.9.
  (The parallel foulout chain is not pursued — build-foulout-stats.js was deleted.)
- ~~`playhq_api_reference.md` correction: `gradePlayerStatistics` pagination~~ **DONE** — the reference now
  documents `filter.pagination {page,limit}` with `meta.totalPages/totalRecords` (verified live grade c952bf59).
  **CORRECTED 2026-07-29:** this previously claimed the `publicProfile` endpoint (account tenant, id→name) and the `seasonStatistics[0].name` season-label correction had been ADDED to `playhq_api_reference.md`. Neither had — the word `account` appeared zero times in that file and the season-name bug was still documented as CORRECT in three places. Both were actually written on 2026-07-29, copied from the deployed `fetch-profile-stats.js` (§6.10).
- ~~StatTrack (`index.html`, Beta 0.58): confirm private-boolean + alias-index resolution~~ **DONE (Beta 0.61,
  July 2026):** checks the `player.private` boolean (grey PRIVATE badge, PlayHQ link hidden for private
  players); resolves game→player via a faithful browser port of `resolveToFullUuid` (`players/indexes` first,
  `players/aliases` fallback, self-wins on full ids, COLLISION sentinel); TRUNC_LEN 13. **Depends on GitHub
  Pages serving BOTH `players/indexes/<xx>.json` AND `players/aliases/<xx>.json`** — a new runtime dependency
  to keep in mind for the repo-size / Pages question.
- UUID truncation saving across games/, leaderboard/, team-stats/, search/ — not yet actioned.
  **The long-quoted ~1.78 GB was computed at a REJECTED 10-char prefix** (36 bits ≈ 63% collision
  probability at ~370k players — the reason `TRUNC_LEN` is 13; see §6.7). First-order estimate at 13
  was **~1.57 GB — SUPERSEDED 2026-07-30 by the actual measurement: 57.61 MB.** The estimate was wrong
  by ~27× because it assumed `leaderboard/` held ~922 MB of full UUIDs; it holds none. §D7 is CLOSED as
  rejected. Historical note only — `db-audit.js` §13 (REMOVED 2026-07-31, question closed) was the figure to
  act on. (Corrected 2026-07-29, last of four sites: this bullet survived the first sweep because the
  bullets immediately above and below it were corrected and this one was not.)
- Repo size **6.18 GB / 529,498 files** (2026-07-30; was 6.03 GB on 07-16, ~8.6 GB before cleanup) — re-verify
  whether it still blocks GitHub Pages before further shrink. Truncation is NOT a lever (§D7 closed, 57.61 MB).

---

### 6.7 FINDINGS FROM CONCLUDED INVESTIGATIONS (knowledge preserved; scripts deleted)

These are the durable results of the diagnostic scripts that were deleted in the cleanup. The scripts
themselves are recoverable from git history if a re-run is ever needed, but the *conclusions* below
are the reason they existed — captured here so deleting the code does not lose the knowledge.

**Profile-identity namespace divergence (diagnose-profile-identity-namespace.js, diagnose-namespace-mismatch.js).**
`api.playhq.com` and `spectator.playhq.com` can return DIFFERENT profileIDs for the SAME real player.
Confirmed directly on 3 of 13 players in one sampled game (William Mallen, Charlie Raynor, Jack Delaney).
The project captures spectator profileIDs; the profile-stats backfill queries api.playhq.com with that
same id, and when the id has diverged the api returns a false "private"/"not found" — unrelated to any
real privacy setting. **This is the root cause the entire alias system + fold exist to handle.** The
recovery path (grade-tid → grade-roster name match → profileSearch) resolves the api id, which is stored
as `player.apiId` and later folded. Steady-state, not migration residue: PlayHQ mints fresh spectator ids
per person over time (the "Micaela Chang" case had 3 distinct ids).

**UUID prefix collision entropy (audit-uuid-collisions.js, diagnose-unresolved-prefixes.js).**
The original truncation used a 10-char prefix — but a uuid's first hyphen sits at index 8, so 10 chars is
only 9 real hex digits = 36 bits, not 40. Birthday-paradox collision probability at 36 bits across ~370k
players is ~63% (not the ~5–6% first assumed for 40 bits). This drove the move to **TRUNC_LEN = 13**
(12 real hex digits, 48 bits). The alias resolver still carries a LEGACY_TRUNC_LEN = 10 fallback for
ids written before the fix — run `diagnose-id-field-lengths.js` to confirm none remain before assuming
the legacy path is dead. The "2.6M unresolved" figure that once alarmed was mostly this legacy-length
mismatch, not true collisions; only 3 genuinely-ambiguous prefixes were ever found (shards 02, b0, dd),
resolved by hand via disjoint season history (resolve-known-collisions.js).

**gradePlayerStatistics DOES paginate (diagnose-grade-pagination.js).**
The old doc claim ("hard cap 50 results, no pagination") was measured with a query missing the `$filter`
argument. Verified live on grade `c952bf59` (86 records, 2 pages): pagination works via
`filter.pagination { page, limit }` with `meta.totalPages` / `meta.totalRecords`. **`playhq_api_reference.md`
must be corrected** (still outstanding, §6.6).

**p[] recovery misattribution (audit-uuid-recovery-misattribution.js).**
`recover-uuids-from-git-history.js` paired current vs pre-migration attendee-array entries BY ARRAY INDEX.
Safe for hp[]/ap[] (frozen legacy fields) but NOT for p[] (nightly rewrites it wholesale from a fresh
spectator call, and the API doesn't preserve player order across months). Result: some recovered p[] ids
landed on the wrong person (confirmed: `0000ed35-…` matched no actual player in its game). **Canonical
player data is UNAFFECTED** (the migration re-fetched records rather than trusting p[]); the caveat is
scoped to `games/bv` p[] provenance only. Two independent checks (prefix-consistency, needing no
commit-selection trust; and content-match vs pre-migration) were built to separate a real substitution
bug from a pre-migration-commit-selection error.

**API stability / same-person duplication (diagnose-api-stability.js, backfill-collision-stats.js).**
A single real player CAN have multiple valid spectator ids (measured directly by inverting the collision
shards: apiId → set of spectator ids). This multiplicity is the mechanism behind much of the un-indexed
backlog and the reason keying on spectator id multiplied records. This measurement was migration Gate 1;
the ~19.8%/name-mismatch figures it produced are the empirical basis for the alias-fold design.

**Candidate-pool sizing (diagnose-uuid-population.js, diagnose-uuid-classification.js).**
The un-indexed full-length-uuid candidate pool was sized at ≈86k before the sampled classification, split
indexed-real / indexed-placeholder / un-indexed. This sized the backfill effort; the backfill has since
completed (0 remaining).

**Season-name-in-name-field bug — RESOLVED (July 2026).**
`parseProfileStats` once read `seasonStatistics[0].name` (which is a SEASON label, e.g. "Winter 2023")
as the player name, writing season strings into `player.name` for ~40,034 files. Root cause fixed in
`fetch-profile-stats.js` — `parseProfileStats` no longer emits a name; names now come from `publicProfile`
(account tenant). Backfilled by `repair-season-names.js`: **39,980 resolved directly via `publicProfile`,
38 via spectator game rosters**; the final ~15 (old spectator-only profiles whose games are archived off
the spectator endpoint) carry `Player #<prefix>` placeholders. An independent read-only scan
(`scan-season-name-contamination.js`) reported **0 contaminated of 411,576 files** — ⚠️ **that result is
WRONG, corrected 2026-07-30**: one file has carried a season label since 2026-06-27 (OUTSTANDING §C14).
The write bug is dead; the self-heal fails silently. See the `publicProfile`
entry in `playhq_api_reference.md`.
NOTE: the retired `repair-season-names.js` originally had two bugs — a `remaining` metric that could never
reach 0 (loop never stopped) and a defer path that froze `Player #` placeholders on transient/unreachable
spectator failures (this placeholdered 15 recoverable players). Both fixed: `remaining` now counts
contaminated-not-done, and after MAX_DEFER it hands the player to `salvage-spectator-names.js` instead of
guessing a placeholder. `salvage-spectator-names.js` then proved the final 15 genuinely unrecoverable
(games archived) and is now dormant.

### 6.8 Session 2026-07-20/21 — future fixtures + roster lag (fixes and their evidence)

**Future fixtures root causes (two, independent):**
1. `nightly-crawl.js` NEVER fetched rounds after the current one (queue builder filtered
   `number < current.number` only) and skipped grades with no current round entirely. Fixed:
   `--rounds-forward=N|all` + first-unsettled-round fetch for no-current grades (default
   behaviour otherwise unchanged).
2. `discover-fixtures.js` — the purpose-built future-fixtures tool (discoverTeamFixture returns
   the FULL fixture incl. future rounds) — had a catastrophic persistence bug: ONE combined
   `git add -- games/ venue-lookup/ team-lookup/ discover-fixtures-progress.json zero-team-seasons.json`
   is ATOMIC across pathspecs; any single non-matching pathspec (team-lookup/ absent,
   zero-team-seasons.json untracked) exits 128 staging NOTHING, the empty catch swallowed it, and
   every commit printed "(no changes to commit)". The 2026-07-19 run fetched **30,426 games across
   25,448 teams in 28 minutes and committed ZERO — job green.** ~~Fixed: per-path `git add` (a miss
   skips only itself) + a `staging:` shortstat line.~~
   ⚠️ **THE FIX WAS RECORDED BUT NOT PRESENT. Corrected 2026-07-31**, by reading the deployed file and
   by re-running its exact pathspec list with `team-lookup/` absent — it printed "(no changes to
   commit)" and staged nothing, exactly as in 2026-07-19. Actually fixed 2026-07-31 (§6.17). The
   lesson is the one this repo keeps relearning: a fix recorded in a document is not a fix in a file.

**Roster-lag fix (team view vs player view):** `games/bv` `p[]` carries bare `{id}` only — NO stat
lines (box scores are Worker-on-demand, never pre-stored) — so `build-team-stats.js` roster stats
come from player reg stats (`seasons[].regs[].stats`), written by the profile-stats matrix. The
nightly's team-stats job runs before the matrix is even dispatched → rosters structurally lagged the
player view (Worker-live per-game + API-side aggregates) by a full day. Fixed: matrix terminal now
also fires `build-team-stats.yml --field active_only=true` (§1.3). Verified: single-season rebuild
of `96c25259` showed the missing round's stats immediately.

**Also this session:** `fetch-profile-stats-matrix.yml` stop-button fixed (`apply-and-commit` +
`summary-and-retrigger` gates `always()` → `!cancelled()`; the "audit other matrices" item is done
for this file — shard-step-level `always()` on artifact upload correctly kept); `build-team-stats.yml`
gained the `data-write` lock (was the only team-stats writer outside it); `build-team-stats.js`
TRUNC_LEN consistency (placeholder was `slice(0,10)`; roster keys were already 13 via truncateUuid —
comments lied); Sunday discovery now runs `backfill_teams=true` (weekly pre-game roster capture).

**PENDING (validation / decision):**
- Corrected discover-seasons matrix: validate with `shards=["00"]` → expect `Session refreshed (attempt 1)`;
  then full sweep to drain the ~10-day discovery backlog.
- Matrix terminal + stop-button: prove via a `shards=["00"]` run to `stuck` (Build Team Stats appears
  among terminal dispatches; cancelling a mid-chain run halts the chain).
- **Future-fixtures architecture decision:** schedule `discover-fixtures.yml --current-only` weekly
  (RECOMMENDED — proven fetch, ~25k team calls / ~24 min, also feeds venue-lookup) vs committing the
  ⚠️ ~~delivered-but-unrun~~ **NOT unrun — see §6.18. Its own cron had been firing every Saturday.**
  `weekly-future-fixtures.yml` (round-based via nightly-crawl `--rounds-forward=all`;
  rests on the unverified assumption that discoverGrade.rounds lists future rounds; 60–90k calls).
  Mark deferred until the fixed discover-fixtures run proved itself — it has.
- First `backfill_teams=true` Sunday sweep: watch volume/duration (fresh progress per mode is expected).
- Known nonconformances flagged, not changed: `build-team-stats.js` gitCommit uses a 10-attempt retry
  (not the 60/1–91s house pattern); its dead `p[]` attribution loop; `discover-fixtures.js` single-cookie
  session style (works).

### 6.9 Session 2026-07-21 (second session) — §A validations closed, weekly chain built

- **§A validations closed with evidence:** `Session refreshed (attempt 1)` on a fresh runner for BOTH
  fixed job types (matrix shard AND reduce); uncapped sweep cycle 1 probed 83,050/231,678 across all
  256 shards (all wall-stopped by design), cycle-2 persistence confirmed; matrix terminal proof
  (`Build Team Stats` among the stuck dispatches) + stop-button confirmed; `statsChecked` gating and
  application-403 non-persistence confirmed across two consecutive runs (same 3 players re-fetched,
  files untouched — retryable by design). ~~Cosmetic: the matrix summary's "Private profiles
  marked: N" is an in-run count, not a persisted write.~~ **SUPERSEDED 2026-07-29, recorded here
  2026-07-30:** the label now reads "Not obtainable (marked)" and the summary explains that these
  are withheld profiles marked done after recovery failed, and are a SUBSET of the writes above.
  (Found by the cross-doc grep, not by the audit that quoted it — this was the SECOND home of the
  claim corrected in OUTSTANDING §F, the same miss the last three passes made.)
- **§B5 decided: weekly future-fixtures CHAINED into the nightly** (not a standalone cron — a cron was
  built first, then discarded when Mark asked why it couldn't ride the nightly like Sunday discovery).
  `discover-fixtures-weekly` job in `nightly-crawl.yml`: terminal-gated, `dow=1` UTC, dispatches
  `current_only=true` + `chain_stats=true`. §B6 done: probe workflow + script deleted.
- **§C7 built** (infer-game-grades confirmed decommissioned — dropped from the chain):
  fixtures → finals (active) → leaderboards (active), each link a success-gated dispatch job.
- **`build-finals-stats.js --active-only` was a data-loss bug caught before first live use** (5 runs
  ever, all argless). Phase 2 recomputed career finals/gfApps/gfWins from the active-only finalsMap
  (clobbering veterans' career totals) and its `?? zeros` per-reg loop DELETED locked-season flags —
  with downstream propagation into all-time.json via leaderboards pass 1. Fix: `scopeSet` — scanned
  seasons scan-authoritative, out-of-scope seasons never touched and their existing flags folded into
  career totals (build-win-loss active-only Pass 2 is the house precedent for this pattern).
- **`build-leaderboards.js`:** progress file never deleted on success (this manifest's §5 claim was
  aspirational — corrected); fixed to delete-on-success. Both scripts' progress files now MODE-KEYED
  (`mode: 'active'|'full'`; cross-mode progress is discarded on load, never resumed).
- **Both scripts' gitCommit upgraded to the house pattern** (copied from `build-win-loss.js`):
  per-path adds, staged `--shortstat` printed, commit-first, 60-attempt/1–91s-jitter push retry,
  THROW on total failure. ~~`build-team-stats.js` (10-attempt retry) is now the remaining outlier.~~
  ⚠️ **WRONG — corrected 2026-07-31.** It was not "the remaining" one. `nightly-crawl.js` AND
  `discover-fixtures.js` both carried the 10-attempt loop with a swallowed total push failure, and
  the nightly is the heart of the system. Both fixed 2026-07-31 (§6.17).
- **Boolean workflow-input gates (corrected same day, proven live):** in job-level expression
  context a boolean input is a real boolean; `== 'true'` string-compares coerce to NaN and SKIP on
  true (this skipped the first chained leaderboards run). Robust form:
  `inputs.x == true || inputs.x == 'true'`. Bash run-step string compares are a different context
  and remain fine. The nightly's `inputs.dry_run != 'true'` job gates are SUSPECT for the inverse
  failure (not skipping on dry_run=true) — verify from a past dry-run's job list.
- **A1 proving COMPLETED same day (late PM):** finals catch-up 41,714 files / 23 retry-pattern
  commits; chained leaderboards proven after the gate fix; leaderboards active-only scoped 572
  (467 written + 105 skipped), mode-keying discarded a REAL stale full-run progress file on load,
  progress deleted on success; clobber check 70/70 top veterans, zero career shrinkage, locked
  flags intact. One-off `verify-finals-preservation.js/.yml` created for the check, then DELETED.
- **Remaining checklist: OUTSTANDING_TASKS.md §A** — A2 wiring commit was due before the Mon
  2026-07-21 15:00 UTC nightly (2026-07-21 WAS a Monday — the first automatic chain fires that
  night if A2 landed, else Mon 07-27); then A3 roster morning + A5 chain morning in one sitting;
  A4 Sunday backfill 07-26.
- Three stale doc/memory items closed by reading current files: API-reference pagination fix and
  claude_context filename-comment rule were already present; migration step 3b-2 was already done.

### 6.10 Session 2026-07-28/29 — first automatic weekly chain, matrix chain-break, A3 automated

- **First automatic weekly chain RAN (Mon 2026-07-27 16:00 UTC nightly → Tue 28 early AM AEST).**
  A2 landed Tue 2026-07-21, i.e. after that week's Monday nightly, so the first chain was the
  07-27 one as designed. Evidence: `discover-fixtures` with `--current-only` in resolved ARGS
  (251 active of 572 seasons), then `Build Finals Stats` #8 at 05:37. NOTE: chain-dispatched runs
  are labelled "Manually run by markjovic" in the Actions list because the dispatch uses
  `WORKFLOW_PAT` — that is NOT a manual run, and reading it as one wastes a morning.
- **Matrix chain BROKE on a lost dispatch (2026-07-27):** `gh workflow run` for the self-retrigger
  returned **HTTP 500**; the step was one-shot, so the chain simply stopped — no retrigger, no
  terminal, no `build-team-stats`. Separately (2026-07-26) `apply-and-commit` died in
  "Expand sparse checkout" with a promisor fetch reset (`curl 56` / `early EOF` /
  `could not fetch ... from promisor remote`); that run's shard writes were never applied, which is
  retryable-by-design, not data loss.
- **`fetch-profile-stats-matrix.yml` HARDENED** (all in one pass): a `/tmp/gh-dispatch.sh` retry
  helper (10 attempts, 10→90s backoff, **fail-fast on HTTP 4xx**, THROW when exhausted) used by all
  SIX dispatch sites; a persistence gate so `written` from shard summaries is NOT counted as
  progress when `apply-and-commit` failed (new `consecutive_apply_failures` input; 3 in a row →
  new `apply_stuck` status that halts WITHOUT firing the terminal or deleting
  `matrix-force-pending.json`); the missing push retry added to `apply-and-commit` (it had NONE)
  and to the pending-file delete step; combined `git add players/ scripts/` split into per-path
  adds; sparse-checkout/promisor retry; terminal fan-out steps gated
  `!cancelled() && status == 'stuck'` so one throwing dispatch cannot skip its siblings; `force`
  job gate and the `NEXT_SHARDS` expression fixed to the robust boolean form (directive 13).
- **Chain proven end to end afterwards:** matrix reached `stuck` at run 4/150 (211 outstanding,
  211 inaccessible, 0 written — application-403 players cannot produce a write, so the
  consecutive-zeros stop is the CORRECT terminal condition here), terminal dispatched
  `build-team-stats.yml --active-only`, which repaired 522 files, and the A3 check then passed
  20/20 on a game played that night.
- **§A3 AUTOMATED — `check-roster-freshness.js` + `.yml` (new, read-only).** Finds last night's
  candidate seasons from COMMIT HISTORY (`git log --since --name-only -- games/bv`, metadata only,
  no blob fetches) rather than scanning 572 season files, sparse-expands to just what it needs,
  picks the game with the most players, and verifies: game in BOTH teams' `fixtures[]` with a
  score; every resolvable player present in their team roster; and each roster stat line EQUAL to
  that player's `seasons[].regs[].stats`.
- **DIAGNOSTIC FINGERPRINT (worth remembering):** the first live run found all 18 players of a game
  behind by EXACTLY ONE GAME (`gp roster = player − 1`, with matching pts/fg/fouls deltas), on both
  teams, zero agreements. A *uniform* whole-roster one-game lag means a LOST TERMINAL DISPATCH —
  the player files were correct throughout. Sporadic per-player differences would mean something
  else entirely.
- **Commit-presence is not evidence of work.** The checker's original commit-ordering test was
  demoted to ADVISORY: a team-stats file that is already correct is rewritten byte-identically and
  therefore never committed (the 522-file repair run staged only ~148 files), and a bounded-depth
  clone cannot see a commit older than its shallow boundary. Comparing live VALUES on both sides is
  strictly stronger evidence than comparing commit timestamps.
- **Known nonconformance closed:** `build-team-stats.js` gitCommit (⚠️ described here as "the last
  10-attempt outlier" — **it was not; see §6.17.** `nightly-crawl.js` and `discover-fixtures.js` both
  still had it on 2026-07-31 —
  and it swallowed a total push failure, so a run could print "complete — N files", go green, and
  have pushed nothing) replaced with the house pattern copied from `build-finals-stats.js`; its
  dead `p[]` attribution loop removed. `discover-fixtures.js` single-cookie style remains, by choice.
- **Open from this session:** ~~the matrix terminal message still says "✅ Matrix complete — All
  players processed", which is FALSE when the sweep ends on inaccessible players~~ — **RETRACTED
  2026-07-30 by reading the deployed YAML: this was fixed on 07-29, in the same pass that wrote
  this bullet.** The message is now defended rather than reworded (withheld profiles get
  `statsChecked` via `markNotObtainable`, so every terminal outcome writes and 0-written across 3
  runs is a true terminal); the summary label reads "Not obtainable (marked)". See OUTSTANDING §C9.
  STILL OPEN: `Errors: 1` in the terminal run is unexplained; 144/256 shards produced summaries
  (expected — shards with nothing outstanding write no summary — but unverified).

---

## 7. CONVENTIONS (non-negotiable, enforced)

### 7.1 Git in scripts
- `git add <explicit path>` — **never `git add -A`**.
- `git diff --shortstat` — **never `--stat`** (ENOBUFS on large diffs).
- **COMMIT before MERGE**, then `git fetch` + `git merge -X ours FETCH_HEAD --no-edit --no-stat` — never `git pull`, never rebase.
- **Never `git stash`/`stash pop`** (wedges the working tree on conflict).
- Single-line commit messages.
- Proven push-with-retry (heavy-contention jobs): 60 attempts, random 1–91s jitter, `git merge --abort`
  before each retry, THROW on total failure. (Reference: repair-aliases.yml, reconcile-people.yml, classify-flagged-merges.yml.)
- **Chain-critical `gh workflow run` dispatches retry like pushes.** A workflow that dispatches the
  next link (self-retrigger, terminal fan-out) must wrap the call: retry transient failures with
  backoff, FAIL FAST on HTTP 4xx (422/404/401/403 are permanent — retrying buries the real error),
  and THROW when exhausted so a broken chain shows red. A one-shot dispatch stopped the matrix
  silently on 2026-07-27 (HTTP 500). Reference: `fetch-profile-stats-matrix.yml` `/tmp/gh-dispatch.sh`.

### 7.2 Workflows
- **No `actions/setup-node` in any JOB that fetches api.playhq.com** (changes outbound fingerprint →
  CloudFront 403 on EVERY request incl. session acquisition). ABSOLUTE and per-JOB — confirmed with
  instrumented evidence 2026-07-20 (§6.3); non-fetching jobs in the same workflow may carry it
  (e.g. nightly's win-loss job). The old "working counterexamples" expired ~2026-07-10.
- Self-triggering matrix: shards do NO git; ONE aggregator (`apply-and-commit`) downloads all shard
  artifacts and does a single commit/push. Retrigger jobs use `if: ${{ !cancelled() }}` (not `always()`).
- `gh workflow run` in a retrigger requires `permissions: actions: write`.
- `workflow_dispatch` inputs are referenced by the description text Mark sees on the form.
- Concurrency group `data-write` shared by every workflow that writes player files / the index, so they
  can never race (nightly-crawl, weekly-indexes, discover-seasons(-matrix) reduce, migration one-offs).
- Reference matrix shape: `fetch-profile-stats-matrix.yml` (live; the canonical self-triggering matrix).

### 7.3 Code style
- ESM: build-finals-stats.js, build-leaderboards.js, build-player-games.js, build-records.js. CJS: all others.
  **VERIFIED 2026-07-29** by reading all four (each opens with `import`). `claude_context.md` and
  `CLAUDE_CODE_PROMPT.md` (being RETIRED — decision 2026-07-29, `git rm` pending) both claimed only
  the first two were ESM; this list was correct and claude_context is now fixed. Evidence:
  `build-player-games.js` L24 and `build-records.js` L27 both open `import fs from 'fs'`. Do not re-open without reading the files.
- `const ROOT = path.join(__dirname, '..')`; all scripts in `scripts/`; workflows call `node scripts/<name>.js`.
- PlayHQ GraphQL queries/headers copied VERBATIM from proven scripts — never hand-written.
  Required headers (ALL api.playhq.com requests): `user-agent: PlayHQ/1.47.2 Android/28 (Android SDK built for x86)`,
  `tenant: basketball-victoria` (never `bv`), `origin: https://www.playhq.com`, `content-type: application/json`,
  `request-id: <uuid>`. Spectator endpoint (`spectator.playhq.com`) uses different headers (`tenant: bv`, `x-phq-tenant: bv`, 3-cookie).
- Player files stored MINIFIED (`JSON.stringify` no indent). Progress files delete on SUCCESS only.
- Long-running scripts commit+push their progress file at each save interval (in-memory progress is lost on timeout).

### 7.4 Delivery rules
- Every delivered file: repo path as line-1 comment (`// scripts/x.js`, `# .github/workflows/x.yml`).
- `node --check` before delivery. `present_files` after. Every script ships with its matching workflow YAML.

---

## 8. TOOLS & ENDPOINTS
- **PlayHQ GraphQL:** `api.playhq.com/graphql` (basketball-victoria tenant). Concurrency: start 500, cap 1000;
  429 → 60% + attempts×5s backoff, 3×429 → permanent −5, 2 clean → +10; 403 → null (not accessible); 404 → skip.
- **Spectator:** `spectator.playhq.com/graphql` (tenant bv; different 403 behaviour; blocks CORS from non-playhq origins).
- **Cloudflare Workers:** `solitary-snowflake-cb3e.insanoflash.workers.dev` (box/quarter scores for StatTrack);
  `playhq-profile-proxy.insanoflash.workers.dev` (profile proxy — DIFFERENT worker, used by the retired proxy fetcher).
- **GitHub Actions:** all automation; 256-bucket matrix for sharded ops. WAF is per-IP/per-shard, not aggregate.

---
### 6.11 · Session of 2026-07-30 (measurement + one real bug)

- **db-audit run (full, 5m 04s checkout).** Repo **6.18 GB / 529,498 files**; **413,577** players
  (index and detail agree exactly, 0 orphans either way); 2,311,358 games across 2,896 season files;
  3,227 seasons. `statsChecked` 99.9%, remainder 213 confirmed withheld.
- **§D7 UUID truncation CLOSED — measured and rejected.** §13 at TRUNC_LEN 13 = **57.61 MB**, not the
  ~1.57 GB estimate. `leaderboard/` holds ZERO full-length UUIDs. 0.9% of the repo; not worth a
  migration that must update every exact-string consumer in one pass. See OUTSTANDING §D7.
- **Season-name contamination is NOT repaired.** One file has carried a season label since
  2026-06-27; the write bug is dead but the self-heal in `finishOk` fails silently when
  `fetchPublicProfileName` returns null. Instrumentation delivered, not committed. See OUTSTANDING §C14.
  Any doc claiming "0 contaminated" is wrong.
- **`db-audit.js` carries the retracted `needs-matrix-shards.json` claim in code** — the fourth copy,
  and the first that no doc grep could reach. Two other stale checks (`alias-inverse/`, leaderboard
  `{id,v}` arrays) flag deliberate design as failures. See OUTSTANDING §C15.
- ~~**16 dangling alias targets** against 0 `apiId` fields — §3b invariant violated.~~ **RESOLVED
  2026-07-31**: grew to 284 after the big fold, then repaired 284/284. Cause was the fold deleting
  player files without repointing aliases. See OUTSTANDING §C16 and §6.12.
- **~140-minute full-checkout figure retired**: measured **5m 04s**. It lived only in session memory,
  never in a doc, and was the implicit justification for the `apply-and-commit` partial clone.
  Recommendation recorded in OUTSTANDING §B2: plain full checkout.
- **House `gitCommit` PROVEN IN PRODUCTION.** A live `build-records.js` run made 15 commits, each
  printing `staging: 2 files changed, …`; the final commit staged `records/all-time.json` plus the
  progress-file DELETION — the exact case §C6b predicted would fail. It did not. `git add` on a
  tracked deleted path stages the deletion; the atomic-add hazard was never firing, and the
  swallowed push was always the real exposure. See OUTSTANDING §C6b.
- **Season-name contamination RESOLVED for the affected file, root cause reclassified.** A targeted
  forced re-fetch repaired it (`"Ryder Fowler"`). The folded-identity hypothesis was WRONG — the api
  id resolves fine on the account tenant. The 2026-07-26 failure was transient. The open defect is
  that a transient heal failure is made PERMANENT by `statsChecked`; decision at OUTSTANDING §B3.
- **Targeted forced re-fetch now exists.** `force=true` previously implied a repo-wide
  `clear-stats-checked` regardless of `shards`, so a "targeted" force run became a 413k re-sweep.
  Now gated; the shard step passes `--force`. See OUTSTANDING §C20.
- **`db-audit.js` fixed (delivered, not committed):** three checks, one of them INVERTED — the
  leaderboard `{id,v}` assertion passed on the LEGACY schema. See OUTSTANDING §C15.
- **Still delivered but NOT committed:** `build-player-games.js` (same `gitCommit`; first full
  256-prefix pass Sunday 02:00 UTC), `db-audit.js`.

### 6.12 · Session of 2026-07-30/31 (the 413k day)

- **413,364 `statsChecked` values wiped by a broken safety gate.** A `>-` folded YAML scalar with a
  more-indented continuation preserved its newline; GitHub could not parse the multi-line `if`, treated
  it as a truthy literal string, and ran `clear-stats-checked` on a dispatch that targeted ONE shard.
  Recovered by a full re-sweep (~40 matrix runs, ~8h). See claude_context §T1–T3.
- **Two `refreshSession` bugs found under that load**: a socket throw escaped a 10-attempt retry loop
  entirely, and `sessionPromise` was left holding a REJECTED promise with no recovery path. Both fixed
  and committed. See §T4–T5.
- **Season-name contamination closed** — repaired to "Ryder Fowler" by a targeted forced re-fetch; the
  folded-identity hypothesis was WRONG (the api id resolves fine on the account tenant), the 07-26
  failure was transient. Audit now reads 0 contaminated. Open defect recorded at OUTSTANDING §B3.
- **Targeted forced re-fetch now exists** and the repo-wide-clear footgun is gated in bash, not only in
  a GitHub expression. See OUTSTANDING §C20.
- **The fold never repointed aliases** — 284 dangling repaired 284/284, root cause and fix at
  OUTSTANDING §C16. Post-check hardened; `--repoint-only` added. Bonus: 457,218 spectator ids,
  **0 ambiguous**, first time measured.
- **`db-audit.js` three stale checks fixed and committed** (one was INVERTED — it asserted the LEGACY
  leaderboard schema as ✅). Verified by the 23:04 audit printing the new strings.
- **§D7 UUID truncation CLOSED** — measured 57.61 MB, not the ~1.57 GB estimate. Do not action.
- **House `gitCommit` proven in production** across 15 `build-records` commits, including the
  post-cleanup commit §C6b predicted would fail. It did not.
- **Standing traps T1–T9 recorded in `claude_context.md`.** That section is the durable output of this
  session; every entry cost either data or hours.

### 6.13 · Session of 2026-07-31 (cleanup day)

- **§B2 DONE** — `apply-and-commit` now does a plain full checkout; 46 lines removed including the
  sparse expansion and its retry. Promisor-fetch and skip-worktree failure classes deleted, not
  mitigated. Shard jobs keep sparse-checkout.
- **§B3 DECIDED (a) and DONE** — bounded name-heal retry via `player.nameHealAttempts`, cap 3, reset
  on success and on `--force`. `db-audit.js` gained in-flight / gave-up rows.
- **§C17 `finalsPerSeason > 1` FIXED BY CONSTRUCTION** — numerator and denominator are now sets, so
  the ratio cannot exceed 1. Surfaced §C22: 218 seasons where a player appeared in a scanned game but
  the season is missing from their own `player.seasons[]`.
- **§C19 blank game context in `records/all-time.json` FIXED** — `leaderboard/all-time.json` stores
  TRUNCATED ids (`truncateUuid`, 13) and `build-records.js` built a player path straight from one,
  failing 100/100. Now resolved via `resolveToFullUuid()`. **db-audit §13 had already measured this**
  ("leaderboard/ … 0 instances" of full-length uuids) a day earlier; the number was never connected
  to the code.
- **§C21 hardcoded `slice(0, 10)`** in `build-leaderboards.js`'s placeholder-NAME minter replaced with
  `truncateUuid()`. No stored id was ever 10 chars — both id sites always used `truncateUuid()`.
- **§C23 bare `gh workflow run`** in `build-finals-stats.yml` replaced with the retry helper, copied
  verbatim from the matrix workflow.
- **Recurring pattern worth naming:** three of today's five bugs were already visible in data or docs
  before they were found — §13's zero-full-uuids line, the L38 "10-char" comment sitting above the
  broken code, and the fold's own header claiming aliases needed nothing. The information was present;
  the join was missing.

### 6.14 · 2026-07-31 late — T9, hygiene decisions, and a memory correction

- **T9 DONE.** The matrix retrigger now narrows to shards with outstanding work. Trap documented:
  empty means ALL 256, so an empty narrowed list falls back to forwarding `inputs.shards`.
- **`db-audit.js` keep-list extended** to four evidence files (`uuid-collisions-len10`,
  `git-history-recovery-report`, `season-name-contamination`, `unresolved-prefix-diagnosis`). Only
  `rekey-apply-cache.json` and `season-name-repair-progress.json` remain flagged — both real residue.
- **Root scripts:** move `fetch-playhq.js` and `find-players-by-team.js` to `scripts/reference/`.
- **⚠️ MEMORY CORRECTION — `fetch-playhq.js` is NOT an API-shape copy source.** A prior session's
  memory said it was; README §4 has always said it is permanently retired with double-counting bugs.
  The PlayHQ copy rule in `claude_context.md` has been rewritten around a principle instead of a file
  list: **authority comes from being exercised.** Copy from the live script that makes the same class
  of call (it runs nightly against the real API, so a wrong query fails loudly); use
  `playhq_api_reference.md` only as a cross-check, never alone (it taught the season-label-as-name bug
  at three sites on 07-29); never copy from anything the pipeline does not run.
- **§C21 verified safe:** `isPlaceholderName` is `/^player\s*#/i` — prefix-only, length-agnostic, so
  changing the placeholder mint length breaks no detection.

### 6.15 · 2026-07-31 — §B1 resolved by ordering

- **A nightly race existed and is now fixed.** `win-loss` and `profile-stats-matrix` both hung off
  `crawl` and ran in parallel; the matrix was dispatched as soon as `team-stats` finished, while
  `build-win-loss.js` could still be writing player files for up to 120 more minutes. The nightly's
  `data-write` lock did not cover it — the matrix is a separate workflow run. Fixed by adding
  `win-loss` to the dispatch job's `needs`. See claude_context §T10.
- **The concurrency lock is NOT the answer to the nightly case** and was not applied: it would make
  the matrix queue behind a workflow that holds the lock for its entire run.
- **Still open, narrower:** the Monday `discover-fixtures -> finals -> leaderboards` chain can overlap
  a still-running matrix chain. Weekly. Recorded in OUTSTANDING §1.1.
- Audit 06:49 confirms `root-level .js files ✅ none`, keep-list at 8, structural invariants OK.

### 6.16 · 2026-07-31 — audit slimmed, stale truncation claims retired

- **db-audit §13 REMOVED.** It measured a UUID-truncation saving for a question closed on 07-30
  (57.61 MB, rejected). Removing it also deleted a full extra scan of `team-stats/` (2,896 files,
  916 MB) that existed only for the byte tally, a per-game loop building three arrays across 2.3M
  games, and per-entry counting across all search shards and leaderboard files. 1,013 -> 999 lines,
  `TRUNC_LEN` import now unused and dropped.
- **Two other db-audit checks were stale.** The keep-list ✅ was UNREACHABLE (the condition assumed
  every keep-list file always exists on disk; once the list grew to 10 with 8 present it could never
  pass) — now reports `n/total` and names which are absent. The dangling-alias hint said only "pending
  fold"; it now names the second cause found on 07-30 (a fold deleting files without repointing
  aliases) and the repair command.
- **Stale truncation claims retired in two docs**, both of which still presented the work as open:
  `README.md` told the reader to "re-measure via db-audit §13", and `claude_context.md` contained a
  paragraph saying "NOT YET DONE" seven lines above an item saying "CLOSED" — the N-1 pattern inside a
  SINGLE document, which is a new variant of it.
- **§B1 closed by ordering, not locking** (see §6.15). Moved out of OUTSTANDING's live sections.

*End of REPO_MANIFEST.md — generated 2026-07-16 from a complete read of the pre-cleanup tree (78 scripts + 88 workflows); updated post-cleanup (commit `fe8eedb`) and post-workflow-fix deployment; updated 2026-07-21 (setup-node resolution, future-fixtures fixes, roster-lag fix, Sunday backfill — see §6.3/§6.8). updated 2026-07-28/29 (matrix hardening, A3 automation, doc-set audit corrections — see §6.10). Reflects the live repo as of 2026-07-29; 2026-07-30 pass retracted the §6.10 terminal-message item (already fixed 07-29) and retired the ~140-minute full-checkout figure — a full checkout is ~7 minutes, the old number lived only in session memory and in no doc.*

### 6.23 · 2026-08-02 evening — normName v2 in one pass, and the stale shard index it exposed

- **normName v2 at all seven comparison sites in a single delivery**: canonical in
  lib/namespace-resolve.cjs (with the one-pass invariant documented at the definition), one-liner
  copy in fetch-profile-stats.js, verbatim copies in repair-season-names / salvage-spectator-names
  / scan-season-name-contamination / db-audit, and StatTrack 0.67's tokenMatch (both operands
  folded at compare time; search-shard selection deliberately untouched at that stage). Fold =
  NFKC, curly/low/prime apostrophes -> ', curly doubles -> ", hyphen family + minus -> -, NFD +
  combining-mark strip, then the original lowercase/collapse/trim. Proof of the pass: normName
  extracted from all six server files and run over one vector — identical everywhere; ASCII
  regression = byte-identical to v1 (no existing match, heal, or contamination decision moved).
  Justification from measurement: the July namespace audit's 43 benign mismatches were exactly
  quote/hyphen/spacing variants; every matcher nulls on >1 hit so looser matching can only
  produce a non-recovery, never a mis-reconciliation.

- **THE SHARD FINDING (why "read the last file" matters):** build-search-index.js's shardKey
  stripped non a-z INCLUDING accents (Álvarez -> shard 'lv'), the client sliced the raw query
  (álvarez -> 'ál.json'), and 135 orphan shards from migrate-phase3's raw-first-two-chars rule
  had survived every rebuild since (cleanup was hex-pattern-only) — so accented and
  apostrophe-position-two queries were being answered from a TWO-MONTH-STALE parallel index:
  wrong club/team, missing every player indexed since June, invisible to db-audit (which counts
  shard files, never generation-checks them). 641 = 506 current + 135 orphans reconciled exactly.
- **Fix shipped and proven**: shardKey v2 folds accents THEN strips (legacy '_' fallback for
  non-Latin names preserved byte-for-byte — consistency is the requirement, not prettiness);
  StatTrack 0.68 mirrors the exact expression (13-case builder/client identity vector executed);
  stale cleanup generalized to "delete anything this rebuild didn't produce" since the fold MOVES
  keys between shards. Rebuild ran 2026-08-02: 412,100 players, 506 shards, 724,407 keys, 135
  stale removed, 55s. Deploy order honoured: index rebuilt BEFORE the 0.68 client commit, so the
  transition window only ever improved results.

### 6.22 · 2026-08-02 later — StatTrack 0.65/0.66, and the opposition index retired by a number

- **The opposition-index question closed the right way round: measured, then not built.**
  New `size-opposition-index.js/.yml` (KEPT — read-only, re-runnable): the builder minus the
  write — classification copied from build-win-loss.js read in full (pre-pass map, hp/ap sides,
  p[] fallback, gameTids disambiguation, forfeit exclusion inherited deliberately), ids interned,
  pairs packed into one Map<number,number>. Live run: **16,195,995 pairs / 404,819 players /
  avg 40 max 437 per player / 1,001.4 MB projected / largest shard 4.2 MB / 3.8 GB RSS / 2 min.**
  Verdict (Mark): 1 GB is too big for a very low value data point — the unit is the per-season
  tid, so the "career vs team" framing aggregates over shirt names, not identities. For once the
  envelope was right (cf. the truncation precedent where it was 27x wrong) — but the point of
  measuring is that nobody had to trust it.

- **StatTrack 0.65** (committed to both copies): (1) season head-to-head line in openOpp —
  player-exact, from fixtures already fetched, zero requests; pure seasonH2H() + h2hLine(),
  8-case matrix incl. missed-meetings split and null path. (2) Career W/L cell centred/nowrap/
  tabular, same for the per-season cell. (3) Column parity: game rows pad to 8 columns when the
  season header carries the W/L cell — including the THIRD buildGameStatRow call site (applyBox
  rewrites #gstats-{gid} on box-score load) found by the structural check after a full read had
  missed it; pad decision stamped on the DOM (ge.dataset.pad) so all three writers agree. Pad
  absent = output byte-identical to 0.64. (4) Season ordering: ord map was
  {Autumn:3,Winter:2,Summer:1,Spring:1} — completed Autumn above running Winter, Spring pinned
  last. Now start-date chronology within end-year: Spring>Winter>Autumn>Summer (Summer files
  under its END year). Mark's exact reported sequence tested. Limitation flagged in-code: start
  date is approximated from the season NAME; true first-round-date ordering needs a tiny
  {sid: firstGameDate} index built data-side if a season ever breaks the four-name pattern.

- **StatTrack 0.66** (committed to both copies): season h2h surfaced on the other two views.
  Fixtures tab: per-row "vs this team this season" PRIOR line — strictly-before-this-date
  meetings so a played row never counts itself; first meetings show nothing. Matchup preview:
  team-level line under the header, or an honest "No completed meetings between these teams
  this season". Load-bearing detail: fixture entries carry oppName only, and a display name is
  not an identity — opponent per row is resolved by gameId JOIN across the season's fixture
  lists (gameTidMap: each game appears in exactly two). Tested with two distinct teams sharing
  the display name "Lions": the impostor contributes nothing. 10-case matrix executed.

### 6.21 · 2026-08-02 — dispatch hardening, the legacy endgame, and one forfeit

- **Five of six bare dispatch sites converted to the retry helper** (§2.6 — which had counted
  four). `nightly-crawl.yml` x4 (matrix trigger, Sunday discovery, Monday fixtures, self-retrigger)
  and `discover-fixtures.yml`'s chain-stats hop — the Monday chain's SECOND hop, where a lost
  dispatch lands the fixtures and silently skips both stat rebuilds with the run green. Helper
  copied VERBATIM from `fetch-profile-stats-matrix.yml` and asserted byte-identical at every
  install; every job-level `if:` asserted byte-identical to the deployed file; every `--field`
  checked against the target's declared inputs (the helper's 4xx fail-fast turns a wrong name into
  a hard stop). Helper EXECUTED against a stubbed `gh`: transient-then-success on attempt 3, 422 in
  one attempt, exhaustion throws after 10. Matrix dispatch args now a bash array (old unquoted
  interpolation would word-split JSON whitespace; byte-identical for well-formed input).
  **`discover-seasons-matrix.yml`'s self-retrigger stays bare deliberately** — convert it when its
  debug scaffolding is stripped, not inside an unrelated commit. *(Done 2026-08-03, in exactly that
  pass — §6.24.)*

- **THE LEGACY FINDING: the 142 survivors were 139 FUTURE FIXTURES + 3 real ones.**
  `find-flag-collisions.js` Part 4 (new: survivor split by season lock state + month histogram;
  the `no-locked-field` case reported as its OWN bucket because nightly-crawl `locked === false`
  and db-audit `!locked` read an absent field oppositely — both buckets came back ZERO) ran live
  over 2,311,828 games: 139 in active seasons, every sample `st=UPCOMING`, dates to 2026-08-26.
  The old classifier probed unplayed games, got nothing (correctly) and stamped them "pre-history,
  nothing further obtainable". Lifetime record: **3,262 stamped, 3 correct — 0.09%.**
  §2.1 decided: NO rebuild; no-flag is the terminal state.

- **`repair-legacy-flags.js` extended and applied:** second criterion
  `flagFalsified = hasScore || st === 'UPCOMING'` (strict equality — absent `st` clears nothing),
  applied at clear decision, disk post-check and report. **139 cleared / 3 kept / 3 files**, dry
  run and apply identical, matching Part 4 from two independently written scans. Without it, each
  of the 139 would have tripped `legacy + score` as it was played (T11 mechanics), and StatTrack
  was rendering all 139 UPCOMING games as "Data unavailable" TODAY. Legacy population now EXACTLY
  3 (2021x2, 2023x1, scoreless locked FINALs), permanently — no writer, unreachable survivors.

- **ba9d21fe closed by live probe, then a one-line repair.** `fo` semantics settled from both
  writers first (fo = WINNER id — nightly-crawl L686, recheck-forfeit-games). New
  `diagnose-forfeit-game.js/.yml` (read-only; plumbing verbatim from recheck-forfeit-games.js;
  verdict function through a 15-case matrix incl. the real record) probed discoverGame:
  **AWAY_TEAM_WON_BY_FORFEIT** — fo RIGHT, scoreline stale (L659 entry-build: hs/as only overlay
  when non-null, so a stale score rides beneath fresher forfeit/fo). New
  `repair-forfeit-score.js/.yml` (winner derived from the record's OWN fo, never an input;
  refusals for non-forfeit/unusable fo; idempotent; key-diff + count + disk post-check; proven
  against a real repo with a bare remote) applied **10-0 -> 0-20**. W/L never contaminated:
  `build-win-loss.js` L55 excludes forfeits — read, not assumed. Both tools kept as on-demand.

- **§1.1 verifications closed from evidence:** leaderboard keys two-segment in live data (the
  `uuid|tid` revert REBUILT); `weekly-future-fixtures.yml` `on:` block holds no `schedule:`.

- **T1 flagged as OVERBROAD, correction pending in claude_context:** all four deployed
  nightly-crawl job gates are `if: |` block scalars WITH newlines and the retrigger gate
  demonstrably works (a truthy-literal gate would self-dispatch every drained nightly forever).
  T1's real case was a `>-` FOLDED scalar with a more-indented continuation. All four gates were
  deliberately left byte-identical this session; narrow the trap before someone "fixes" them.

- **db-audit §11b ages -> sizes (closed the last §2 work item), proven by the live 06:07 audit:**
  mtime is checkout time on a runner, and the git-log alternative is equally dead at
  fetch-depth:1 (one commit, one age for every file). Sizes for files, entry counts for dirs;
  verdicts untouched; executed against all five hygiene cases pre-delivery. The same audit
  confirmed the session's two staked predictions: `legacy: true — 3` and `legacy + score — none`.
  No `legacy + UPCOMING` invariant added — no writer exists, so the check could never fire.

- **find-flag-collisions.yml banner retired** — its "written from conventions, DIFF BEFORE
  COMMITTING" warning was discharged by reading the deployed file (they matched); a discharged
  caveat left standing is T12-shaped.

### 6.20 · 2026-08-01 late — sibling stats sync, and the winPct denominator

- **Every reg sharing a (season, team) must hold the same stats.** Not a new rule — both writers already
  enforce it and neither looks at `gid`: `fetch-profile-stats.js` L985-996 keys `${sid}:${reg.tid}`,
  `build-win-loss.js` L271/L313 uses `playerRecords[sid][tid]`. 169,566 groups had drifted anyway: 798
  in a CORE box-score field, 168,768 in `foulOuts` alone. Cause is STALENESS, not keying — a group only
  diverges when it has not been rewritten since the values changed, and the `wins`/`losses` cases
  persisted because the nightly runs `build-win-loss --active-only` while 97%+ of them sit in LOCKED
  seasons. Synced per-key MAX across 91,716 players / 263,440 regs; verified after at `differ >= 1 key`
  = 0 with an empty key histogram.

- **winPct / lossPct were the only categories mixing data sources**, and it showed. `wins/losses/draws`
  come from `build-win-loss.js` scanning games we HOLD; `gp` is PlayHQ's appearance count including
  games we do not. A 50-GP player with 10 known games, all won, read as 100% while carrying `gp:50`, and
  the browser's minimum-games filter reads `e.gp` — so they outranked a genuine 20-0-from-20 player.
  Fixed by making `gp` mean DECIDED games (`w+l+d`) on those two categories only, in both the server
  build and the client derivation, with the floor moved from `career gp >= 10` to `decided >= 10`. The
  percentage itself is untouched. Every other category keeps career gp: `ppg`/`threePtPG`/`foulsPG` draw
  their numerators from the same PlayHQ source as `gp`, so numerator and denominator already describe
  the same population.

- ⚠️ **A deliberate refusal was silently overturned.** `repair-duplicate-regs.js` refused two `foulOuts`
  2-vs-1 groups because max and sum genuinely disagree there. The sibling sync, written later and
  grouping by `tid` alone, applied max to them. Small (2 players, one foul-out) and probably correct,
  but decided by execution order rather than by a person — recorded as trap T18.

### 6.19 · 2026-08-01 evening — §2.2: three writers, one key, 27,664 duplicates

- ⚠️ **DECISION A (Mark, 2026-08-01): a reg IS a `(team, grade)` registration.** A team appearing under
  two grades in one season is a REGRADE and is CORRECT data — 1,296,352 regs are that. Every writer of
  `player.seasons[].regs[]` must key on `(tid, gid)`.

- **Root cause.** Three writers each used a different identity for a reg: `nightly-crawl.js` L1011
  `(tid AND gid)`, `fetch-profile-stats.js` L1039 `(tid)`, `discover-seasons.js` L962 `(tid)` **while
  mutating `gid` in place**. That mutation could collide an existing reg with a sibling the nightly had
  appended, producing a `(tid, gid)` pair neither other writer could create — both check and skip. It
  also looped: discover-seasons collapsed a regrade to the latest grade, the nightly met a game in the
  older grade and appended it back. One `upsertReg()` helper now serves both discover-seasons write
  sites; 12/12 case matrix including a test that drives the generator directly.

- ⚠️ **`discover-seasons.js` wrote player files PRETTY-PRINTED at both sites** (`JSON.stringify(p, null, 2)`)
  while `nightly-crawl.js` L497 and `fetch-profile-stats.js` L678 minify. A player touched by both
  flipped format every cycle and was rewritten in FULL each time even when no field changed — pure churn
  into the 6.13 GB that already cost code search. Its index/progress/artifact writes were correct all
  along; only the player writes were wrong.

- **27,664 duplicate regs merged, 2 refused.** Max-per-key, lossless where a key is merely absent from a
  copy. The refusals are `foulOuts: 2` vs `1` with every other field identical — a genuine split where
  max and sum disagree, left untouched rather than resolved by guess. Rehearsed on shard `0a`: 57
  players, exactly the dry run's prediction.

- ⚠️ **StatTrack season leaderboards had been rendering EMPTY.** `seasonEntriesForStat` L2040 required
  `id.split('|')[0]` to be >=32 chars, but `build-leaderboards.js` writes `${truncateUuid(uuid)}|${tid}`
  and TRUNC_LEN is 13 (10 before 07-31). Every entry was skipped, silently, because `data` still had one
  key so the "no data" branch never fired. Found only while checking whether adding `|gid` was safe.
  Beta 0.63 accepts a uuid prefix. all-time was never affected — it does not pass through that function.

- ⚠️ **`build-leaderboards.js` season key changed to `uuid|tid|gid`, then REVERTED to `uuid|tid` the
  same day after measuring.** Regrade regs hold the SAME team-season totals on every grade — 744,117
  groups byte-identical, and the 169,230 that "differ" differ ONLY in `foulOuts`. The API reports
  per-TEAM totals and repeats them per grade registration, so keying by grade yields two identical
  rows per player, and the ASSIGN it replaced was losing nothing. The change was shipped on reasoning
  and reverted on measurement — the risk was flagged in advance and built anyway, which is the thing
  to not repeat.

- **The seasons gap itself (the original §2.2) is small and mostly PERMANENT:** 4,361 player+season
  pairs, **97.6% in locked seasons** unreachable by both writers, 105 active. Finals subset exactly 218,
  matching `build-finals-stats.js` from two independently written scans.

- **VERIFIED INDEPENDENTLY.** Re-ran `audit-seasons-gaps.js` after the repair: exact `(tid,gid)`
  duplicates **27,666 -> 2** (the two deliberately refused `foulOuts` pairs, named as the same uuids),
  and total regs **4,151,876 -> 4,124,212 = 27,664 removed** — 27,606 from the full run plus 58 from the
  shard `0a` rehearsal. Null-gid (2,188), Q2 (110,232) and the seasons gap (4,361 / 218) all unchanged,
  as intended. The REGRADE count ROSE 1,296,352 -> 1,300,376, which is correct rather than alarming:
  groups like `[G1, G1, G2]` were classified EXACT while the pair existed and become pure regrade once
  it is merged.

- ⚠️ **The first apply run was CANCELLED at the 120-minute timeout with nothing committed**, after
  completing every merge and every file write. Cause: per-path `git add` for 24,534 paths against a
  527,900-file index — git rewrites the whole ~40 MB index per invocation. Two rules now in
  claude_context as **T16** (per-path add has a scale ceiling; use `--pathspec-from-file` above ~2k
  paths, per-path only as an isolating fallback) and **T17** (a long writer commits in batches during
  the run, never once at the end). Re-run with both fixes completed in ~25 minutes, pushing ~8 batches
  of ~3,100 files, each on attempt 1.

- **Method note, third time in two days:** two predictions wrong, both caught because the detector
  printed the underlying shapes beside the count. A first version keyed duplicates on `tid` alone and
  reported 1,330,231 "surplus" regs — a repair built on that number would have deleted 1.3M legitimate
  registrations.

### 6.18 · 2026-08-01 — the changes RAN, and a retired workflow was found running

- **Nightly green and the `gitCommit` change VERIFIED IN THE LOG**, not merely un-broken: both new
  markers present on every commit (`staging: N files changed…`, `(pushed on attempt N)`), zero add
  failures, zero contention retries, `Games remaining: 0`, 3,512s.

- **Legacy repair APPLIED: 3,114 cleared, 142 kept, 329 files, post-check 0.** Every figure matched
  the dry run's prediction exactly, and two independently written scripts (`find-flag-collisions.js`,
  `repair-legacy-flags.js`) agreed on all six years. db-audit then reported `Flag collisions ✅ none`
  and `legacy + score ✅ none` on the invariant's first run. `legacy` describes reality for the first
  time in the project's history: 142 games, all genuinely scoreless.

- ⚠️ **`weekly-future-fixtures.yml` HAD BEEN RUNNING WEEKLY while two documents recorded it as
  retired.** OUTSTANDING §B5: "retired unrun; probe workflow + script deleted". This manifest:
  "the delivered-but-unrun `weekly-future-fixtures.yml`". Its `schedule: cron '0 0 * * 6'` was live
  the whole time — Saturday 00:00 UTC = **Saturday 10:00 AEST**. It is the approach that LOST the
  §B5 decision (60–90k calls, resting on the still-unverified assumption that `discoverGrade.rounds`
  lists future rounds) running weekly alongside the ~25k-call proven path built to replace it. They
  never collided only because both take `data-write`. **Cron removed 2026-08-01; workflow kept as
  manual-only** and renamed `Future Fixtures (manual — full round-forward sweep)`, since three
  different things were called "weekly" and only one of them was a workflow by that name.
  **T12's third instance in two days, and the first that was a live scheduled job rather than a fix
  that never shipped.** The pattern is now specific enough to state: this repo's documents are
  reliable about DECISIONS and unreliable about whether the decision was EXECUTED.

- **Open, found while reading `nightly-crawl.yml`:** eight jobs gate on
  `if: ${{ inputs.dry_run != 'true' }}` against a `type: boolean` input. GitHub coerces to numbers,
  the string `'true'` becomes NaN, nothing equals NaN, so every gated job runs in a dry run. A dry
  run is not dry. Also: all four `gh workflow run` calls are bare with no retry helper.
  OUTSTANDING §1.1 and §2.8. *(Resolved: the dry_run input was DELETED 2026-08-01; the dispatch
  sites — which were six repo-wide, not four — went through the retry helper 2026-08-02, §6.21.)*

### 6.17 · 2026-07-31 late — §2.2 and §2.5 closed, three gitCommit fixes, and a 3,262-game defect

- **StatTrack VERIFIED against the deployed file, then fixed — Beta 0.62.** Three of the four
  api-canonical claims held up exactly as recorded (`TRUNC_LEN = 13` L492; `isPrivate()` testing the
  `private` BOOLEAN not the name pattern L499, with the PlayHQ link suppressed L967; a faithful
  resolver port fetching `players/aliases/` with index-first, self-wins and a COLLISION sentinel
  L544-575). **This is the rare case where four documents all traced to one session and were still
  right** — worth recording, since the reflex by this point in the day was to expect drift.
  The defect was in a claim nobody had made: `renderMode` (L592) tested `legacy` ABOVE the score
  test, so 3,120 scored games rendered as "⬜ Historical / Data unavailable". Fixed with a guard —
  `if(g.legacy && typeof g.hs!=='number')return'legacy'` — driven through a 13-case matrix. The guard
  is correct whether `repair-legacy-flags` has run or not, so the two changes have no deploy order.
  Committed to BOTH copies (`markjovic/stattrack` and the repo-root mirror) 2026-07-31.

- **§2.5 fold report DEMOTED TO ADVISORY, not timestamped.** `--repoint-only` stopped reading
  `reports/fold-diverged.json` at the T6 rewrite and nothing else reads it, so timestamped filenames
  would have added files to protect a consumer that no longer exists. Three stale texts still told the
  reader it was load-bearing: the script's usage block (contradicting its own code 300 lines below —
  the N-1 pattern inside a SINGLE file), the runtime NOTE on pre-existing dangling aliases, and the
  `mode` input description shown on the dispatch form.

- **§2.2 flag collisions DIAGNOSED, and they turned out to be 1.5% of the real problem.** All 49 are
  legacy+forfeit. Extended `find-flag-collisions.js` answered the three open questions: 0 missing from
  `forfeit-games.json` (leaderboards were never contaminated), 47/49 with a valid `fo`, 0 with `spc:1`,
  and **49/49 carrying a score**. A predicted discriminator (`spc:1`) returned zero and the answer came
  from the line treated as weak evidence — recorded because nominating the wrong evidence and saying so
  is cheaper than quietly re-deriving it.

- **THE FINDING: 3,262 games carry `legacy`, 3,120 hold a score, zero predate 2021.** The flag means
  "pre-history, nothing further obtainable" and peaks in the CURRENT year (955 in 2026). Root cause
  proven by executing the real function: `applyRoundFixtures` (nightly-crawl L567) spreads the existing
  entry and overlays fixture data without touching flags, so a stale `legacy` rides through forever. A
  normal result gives legacy+score; a forfeit gives legacy+forfeit+fo. One defect, two populations.
  **Nothing writes the flag any more** — a full grep found only reads. The classifier went in the
  2026-07-16 cleanup, so the population is FROZEN and the repair is a genuine one-off.

- **Why no audit ever caught it:** `db-audit.js` L531 tested `legacy` against other FLAGS and never
  against DATA. Fixed — new `legacy + score` invariant, and both legacy rows now report unconditionally
  so a clean state is REACHABLE rather than merely silent (the keep-list-✅ defect, again).

- **Three `gitCommit` violations fixed, each proven by running old and new side by side** against a
  real repo with a bare remote:
  `nightly-crawl.js` — combined `git add` in an empty catch, silent no-op return, 10 attempts,
  swallowed push failure. Demonstrated: one bad pathspec left a real change uncommitted, HEAD unmoved,
  and printed NOTHING.
  `discover-fixtures.js` — the same, plus a missing `cwd: ROOT`, plus the 2026-07-19 bug this manifest
  recorded as fixed (§2.2/§6.8).
  `fold-diverged-players.js` — batched 500-pathspec adds; one miss discarded up to 499 good paths and
  would abort a fold that had already completed every write.

- **`find-code-refs.yml` created, and it is now load-bearing.** GitHub REFUSES to index this repo for
  code search. A search that cannot run returns "0 files", indistinguishable from "no matches" — the UI
  actively invites a false negative, which is the same failure class as the 2026-07-28 unearned doc
  verification. The project's own cross-document fact rule ("grep across all files, read the results")
  had no mechanism behind it until this existed. **This is the first CONFIRMED cost of repo size;**
  §D8's "blocks publishing" premise is still separately unverified.

- **`scripts/discover-seasons.js.old` deleted.** A stale duplicate of a live script, invisible to this
  manifest's `scripts/*.js|*.cjs` glob AND to db-audit's root-level `.js` check because of the
  extension — and it polluted the legacy grep with two hits from dead code, which is precisely how a
  retired implementation gets mistaken for a live one.

- **Recurring pattern, third session running:** the information was already present and the join was
  missing. §13's zero-full-uuids line, the L38 "10-char" comment, the fold header claiming aliases
  needed nothing — and now a manifest recording a staging fix that the file never received.

### 6.24 · 2026-08-03 — the last bare dispatch converted, and the matrix that missed the stop-button audit

- **`discover-seasons-matrix.yml` strip-and-harden (DELIVERED; the commit is the execution — T12):**
  the gen-step VERBOSE block (hexdumps, `$GITHUB_OUTPUT` re-parse) and the entire `verify-output`
  job deleted — both existed for the 2026-07-09 fan-out diagnosis, closed the same day they were
  added. The self-retrigger, deliberately left bare in the 2026-08-02 pass (§6.21), is now on
  `/tmp/gh-dispatch.sh`, copied from `fetch-profile-stats-matrix.yml` and **asserted
  byte-identical at build time** (the 1,452 figure recorded here matches NO measurement of the current helper at ANY boundary — every candidate was tested 2026-08-07; the live helper is **1,046 UTF-8 bytes / 1,032 characters**, proven identical across all SEVEN embedded instances; SETTLED 2026-08-07 by measuring two historical commits (fb88a90, ca568de): the helper NEVER changed — the 1,452 figure was wrong when recorded, corresponding to no state of the text; build-team-stats.yml's comment corrected); the job carries `GH_TOKEN`/`GH_REPO` env exactly
  as the reference does and `--repo` moved into the helper. All six chain-critical dispatch sites
  in the repo now retry (fail-fast on 4xx, THROW on exhaustion).
- **Two conformance defects found by the full read, fixed in the same pass:** (1) `reduce` and
  `retrigger` gated on `always()` — the stop-button bug. The 2026-07-21 audit fixed the stats
  matrix and recorded "audit other matrices"; it never reached this file, so cancelling this
  chain did NOT stop it. Both gates now `!cancelled()` (`reduce` keeps running when shards fail —
  the aggregator is never gated on shard success). (2) The retrigger's `inputs.dry_run != 'true'`
  against a `type: boolean` input — the directive-13 NaN coercion, so the gate could never block
  a dry-run's retrigger (dry runs don't shrink `undone`, so a UI dry-run re-dispatched at least
  once). Now `!(inputs.dry_run == true || inputs.dry_run == 'true')`, kept on one line per T1.
- **Stale header comment corrected:** it still described an "object array" output and a `!= '[]'`
  gate — neither true since the 2026-07-09 fix. A stale comment is how a retired mechanism gets
  rebuilt (same class as the L38 "10-char" comment, §6.13).
- **Verification executed, not asserted:** `yaml.safe_load`; every `if:` value printed via
  `repr()` and asserted newline-free (T2); a zero-context diff proving every hunk sits inside the
  four sanctioned edit sites; `generate-shards` still a true root job (no `needs`, no `if`);
  `map` carries no custom `if:`; the `targets`/`undone_shards`/`fromJson` plumbing byte-identical;
  step-level `always()` on the shard artifact upload deliberately KEPT; no `actions/setup-node`
  anywhere in the file.
- **`claude_context.md` T1 NARROWED** (the trap candidate flagged 2026-08-02): the proven failure
  is the FOLDED `>-` scalar with an uneven continuation; the four working `if: |` block-scalar
  gates in `nightly-crawl.yml` are explicitly fenced off from being "fixed"; new/edited gates are
  single-line with T2 `repr()` verification.

### 6.25 · 2026-08-03 (second pass) — the backfill scoped, and the README that rotted quietly

- **Historical/locked-season game-data backfill SCOPED** — full phased plan at OUTSTANDING §2.2.
  Key architectural point: `discover-fixtures.js` (`discoverTeamFixture`) fetches LOCKED seasons
  directly, so the July lock-writer → unlock-the-489 → re-crawl plan is expected obsolete; the 489,
  the tournament gaps and the 68 no-`rn` seasons are re-measured AFTER the sweep and only the
  remainder survives as work. Phase 0's one genuinely open technical question: the team-id source
  for a season with no team-stats file — settle from the code, `zero-team-seasons.json` is the
  existing report of that failure mode.
- **StatTrack backlog CLOSED (Mark).** The "openOpp not wired to game-row taps" entry was already
  FALSE when the 08-02 session verified the deployed file (wired at the opponent-name tap, L1087)
  — the correction was stated in that chat and never landed in the docs. Same-day lesson as T12:
  a verification voiced in a session is not a verification recorded.
- **§D8 CLOSED (Mark): repo size does not block publishing.** Code search remains the single
  confirmed cost of size. History squash / R2 demoted to optional pre-AFL choices.
- **README.md staleness sweep, ~25 corrections** — the worst offenders: the deleted backfill/
  one-off script cluster listed as live; `repair-season-names.js` marked "Run pending" three weeks
  after running to completion (07-13, 36,080 files); `build-player-games.js`/`build-records.js`
  carrying CJS cells against §7.3's verified ESM; `team-lookup/` marked "not yet removed" when the
  tree's own file count proves it gone (527,900 total < 412k players + 355k team-lookup); the
  2026-07-09 migration checklist presented as current; "after each finals series" in the
  maintenance schedule for a chain that has run weekly since 07-21. An authority pointer was added:
  README's script table is a summary; this manifest's §2 is the inventory.
- Still genuinely open from README's long-standing list: only the `discover-reduce-manifest.json`
  presence check. The Pages deploy-trigger item CLOSED same day (Mark): Pages no longer deploys on
  push — an explicit Deploy Pages action is chained in the scheduled runs. Operational consequence:
  a commit is not live until the next chained deploy fires.

### 6.26 · 2026-08-04 — Mark's three finds, the third strike of the regrade class, and the sweep goes live

- **Fold queue-eviction → trap T19 (found by Mark; caused by the 08-02 hardening).** The
  `data-write` pending queue holds ONE run; a new arrival CANCELS the waiter;
  `cancel-in-progress:false` protects only the running slot. Fold + team-stats dispatched in the
  same terminal fan-out second lost Fold deterministically on every night something held the lock
  — greens through Aug 2, 4-second cancellations from the first post-hardening fan-out. Fix
  delivered same day, ordering over locking: Fold out of the fan-out, `chain_fold` through
  `build-team-stats.yml` (success-chained, robust boolean, helper byte-identical). Edit base
  proven by byte-identical re-application against Mark's fresh upload. NEVER put two same-lock
  dispatches in one fan-out.
- **The regrade double-count is a CLASS, now trap T20 — three strikes.** Live specimen
  (2026-08-04): same-tid sibling regs store IDENTICAL season-cumulative blocks by design (sibling
  sync). (1) StatTrack season rows regressed to summing them — 0.69 fixes with per-stat MAX
  across the tid group. (2) `build-win-loss.js` career totals summed per REG over per-(sid,tid)
  records in BOTH modes — a 99-GP player stored 85W/70L against a true 51W/47L/1D, and
  active-only deltas COMPOUNDED nightly. Fixed once-per-(sid,tid); stored careers repair only on
  the next FULL run. (3) Rule 14 (July) was the first strike. The rule: per-(sid,tid) facts are
  consumed once per unique tid per season — Set-dedupe or MAX, never a sum across siblings.
- **Finals performance shipped end to end:** build-finals-stats writes `fstats`/`finalsStats`
  (forfeits excluded from finals GP; appearance basis p[]∪hp∪ap; active-only folds locked
  contributions); StatTrack 0.70 renders Career-vs-Finals with the PPG verdict line, empty until
  the full run populates. Every path E2E-executed: forfeit exclusion, hp-only appearance,
  locked-fold, all four render cases. Career-high chips explored and answered: data already on
  every player file (`records.maxGamePTS/…3Pt` with gameKey+sid) — HTML-only feature, later.
- **§2.3 opened — Monday-night W/L one-game lag.** The game file's commit history DISPROVES the
  fixtures-sweep theory (both scoring commits are nightly-crawl, pre-win-loss); the file provably
  contained score+p[]+Toby before win-loss ran and win-loss still wrote a 3-game record. Suspects:
  win-loss job failed mid-batches (and the matrix dispatches on a FAILED win-loss by design —
  `always()`), or a matrix shard checked out inside the ~1-minute window and `merge -X ours`
  discarded win-loss's write. Two 30-second checks with Mark distinguish them. Self-heals
  nightly; fix waits on evidence.
- **Locked re-sweep RUNNING** (chunk 1, 11:07 AEST) — the hardened discover-fixtures proven
  deployed by its own log (mode line, progress-key, checkpoint pushes). Live finding: zero-team
  seasons are exactly the no-ladder comps (no-rn/tournament/one-grade) — ladder enumeration
  cannot reach them; Phase 4 rescue = regs/game-file team ids straight into discoverTeamFixture,
  one probe decides. Runtime is WAF-bound (~15/s/IP), not code-bound; sharding is the only real
  accelerator and is warranted only if the sweep recurs.

### 6.27 · 2026-08-05 — the rebuild chain lands, finals ships client-side, and three own goals become traps

- **Post-sweep rebuilds complete.** build-win-loss FULL repaired 244,736 players' careers (Toby
  verified live at 51W 48L 1D — W+L finally equals his 99 GP); records rescanned across 2,311,974
  games; player-games, team-stats, finals, search all rebuilt. Leaderboards `force` still queued.
- **Finals performance shipped — and the design was WRONG first.** I proposed storing box scores for
  all 122,319 finals games (~200MB). Mark's screenshot of per-game stats inside an expanded season
  disproved the premise: StatTrack already fetches box scores per game from the Worker
  (`fetchBox(gid)`, cached in `S.boxes`). The shipped design stores only the finals GIDS on each
  player (~45 bytes) and hydrates client-side — the 0.65/0.66 opposition pattern, zero storage cost,
  no backfill needed. LESSON: before proposing a data-layer build, check what the CLIENT can already
  reach.
- **T22 — never commit derived state that scales with the data.** The finals progress file hit
  110.14MB and GitHub rejected it permanently mid-run; the 60-attempt retry then burned every attempt
  on an unretryable error. Progress removed entirely (T17 protects API budget, not local compute —
  `build-player-games` had it right), and size-limit/GH001 rejections now fail fast.
- **T23 — a commit is not a publication.** Pages deploys only when the Deploy Pages action runs,
  chained to the SCHEDULED nightly. Three separate "the feature is broken" hunts on 08-05 were all
  publication lag. Check the last Deploy Pages run BEFORE reading code.
- **T24 — a scan comparing a field to its own source measures nothing.** `size-missing-gids` returned
  a triumphant 0 because `build-player-games` GENERATES `games[]` from `games/bv`'s `p[]`. Designed
  from an assumption rather than from reading the builder. Replaced by `size-appearance-gaps`
  (independent sources: 775,703 missing appearances, 55% in zero-team seasons — Mark's grading-rounds
  hypothesis measured) and `size-spectator-queue` (direct count, no estimation). Also recorded: the
  ÷12 estimate conflated "games we lack" with "games we hold lacking `p[]`", and the near-equal
  negative gap (769,120) shows `p[]`-as-attendance is a noisy participation proxy.
- **StatTrack 0.69 → 0.73** in one day: regrade dedupe in season rows; finals panel; single-row
  layout; column alignment (`.cstat` is `flex:1`, so alignment IS cell-count parity — the finals row
  mirrors the career strip's conditional cells with blanks); client-side box hydration.
- **Fold ordering fix VERIFIED in production** — #29 green, 55m, dispatched on team-stats completion.
- **venue-indexes killed by a 15-minute timeout** after completing all its writes but before
  committing; raised to 45 (full checkout ~7 min + a rescan grown by the sweep).
- **NEW, Mark: inappropriate season medals.** Root cause is server-side per-SID flag attribution
  (finals flags written to every reg in a season, so a finals run with one team medals every team row
  that season), made more visible by the appearance-basis widening. Fix specified at OUTSTANDING §2.4
  and deliberately NOT built same-day — three of today's failures came from acting on unread
  assumptions, and this one deserves confirmation against the actual player file first.

### 6.28 · 2026-08-06 — the appearance gap: closed by running the missing step, not by inventing a new one

- **Mark's framing won the day twice.** First: "we have two endpoints precisely because of these
  private/hidden issues" — the answer was the EXISTING spectator step pointed at games it never ran
  on, not any new mechanism. Second: when the backfill's first draft queued 2,050,204 spc-unset
  games, he killed it — 2.03M of those carry working partial rosters written before the spc flag
  existed, and rewriting them wholesale for a 2.7% gap is exactly the churn this design rejects.
  Final scope: the 23,772 games with NO roster. One 35-minute run: 7,844 filled, 1,095 players
  stubbed, 15,928 confirmed spectator-dead (paper-scored era, accepted residue).
- **spc's absence does not mean unprocessed on old games.** Only 149,578 of 2.34M games carry the
  flag; it postdates most of the corpus. Any future tool keying on "spc unset" must decide whether
  it means "never processed" (recent games) or "predates the flag" (most games) — they need
  opposite handling.
- **`spectator-backfill.js` build pattern worth reusing:** thirteen blocks extracted from
  nightly-crawl.js and asserted byte-identical at build time; the live path proven end-to-end
  against a local mock of both PlayHQ endpoints (hosts-file redirect + self-signed cert) — fetch,
  wholesale p[] rewrite, spc:1, miss-untouched, stub+alias+index, statsChecked untouched, commits
  to a bare origin. That is the verification bar for anything that writes player or game data.
- **Fabrication owned:** the "profile that collected multiple people's registrations" explanation
  for a gap player was invented from an outcome (page fails to load) and retracted when challenged.
  Tournament players genuinely play across 11 associations in a year. Mechanisms come from reading
  code and probing data, not from narrating symptoms.

### 6.29 · 2026-08-06 (evening) — Pages hits its ceiling; the split becomes active/locked

- **The publishing limit is real and measured:** GitHub Pages accepted 1,210.6 MB artifacts and
  rejects 1,211.6 MB — the post-backfill rebuild's ~1 MB crossed it. I initially argued the growth
  was innocent and invented a failure status for a run that succeeded to defend that; corrected by
  Mark, and the corrected record showed his reading was right: the growth tipped it.
- **Everything big is served.** The composition scan + a grep of StatTrack's fetch paths proved the
  artifact has no fat: never-fetched content is ~1 MB of 1.2 GB. The recovery strip ships exactly
  that complement and buys days.
- **Mark's split shape supersedes mine:** ACTIVE origin (small, forever) + ARCHIVE origin (locked
  seasons, near-static because the frozen guard makes locked data immutable). Both origins can
  build from this repo's checkout — no data migration, no writer changes. Design brief with the
  open questions (graduation ordering, backfill-touches-locked redeploys, StatTrack routing by
  sids, the 404-gap failure mode) is OUTSTANDING §2.1; the active-season visual indicator rides
  the same StatTrack change.
- **New tooling this session:** rebuild-chain.yml (needs-chained, 42-case gate matrix),
  size-pages-artifact.yml (per-directory compressed composition), the expanded deploy-pages.yml
  strip. rebuild-chain's build caught the folded-scalar trap T1 live and a transitive-failure gate
  bug — both fixed before delivery by the test matrix.


### 6.30 · 2026-08-07 — the split goes LIVE end to end; T19 gets its structural fix; the day the ceiling stopped mattering

**The headline numbers.** Deploy Pages #89 artifact: **763,124,203 bytes**, against the last
pre-split success of 1,210,614,006 and a measured failure ceiling ~1 MB above it. The 447.5 MB
stripped from the active artifact matches the archive origin's first artifact (447,902,548 bytes)
almost byte-for-byte — two origins accounting for each other exactly. Headroom went from ~1 MB to
~447 MB in one day, and the per-season directories no longer accumulate on the active site at all:
seasons graduate out 28 days after locking, automatically.

**How it was built (order matters — measurement before machinery):**
- **size-locked-split.yml** measured the locked share at 81.2% before anything was committed. Its
  first version aborted on the real sports-index — my shape detection was array-guessing when the
  README's own schema showed `.seasons` as an OBJECT keyed by 8-char short ids all along, and the
  short ids would ALSO have broken the uuid-pattern classifier. Both fixed by reading Mark's paste
  of the live file; the abort-rather-than-guess design did its job.
- **Archive origin:** `markjovic/sports-players-stats-archive` — one workflow + a README,
  permanently; the site is the ARTIFACT, built each deploy from THIS repo's checkout (there is one
  copy of the data, ever). Inclusion is the **union rule** (locked OR archivedAt) after Mark's
  what-if-it's-missing question exposed that a locked-only rule would strand an inconsistent
  archivedAt-without-locked season off BOTH origins. Weekly cron (Sun 04:00 AEST) caps backfill
  staleness; explicit dispatches from graduation and backfill tails make it prompt.
- **graduate-seasons.yml:** candidacy = locked + no archivedAt + past the 28-day grace (the
  `grace_days` input default is deliberately the ONLY site of that number) + files present.
  Ordering guarantee: dispatch+poll the archive deploy cross-repo, probe every candidate LIVE on
  the archive URL, and only then flip `archivedAt` — the flag is a statement of verified fact, so
  "index says archive, archive lacks it" is unreachable. The flip holds data-write at JOB level
  only (a workflow-level hold would spend ~40 waiting minutes in T19's one-slot queue). Failures
  land safe-side by construction: flags stay unset, the season keeps serving from active, the next
  nightly dispatch retries (candidacy IS the absence of the flag), and the status job goes RED so
  persistence can't rot silently. Graduation #1: green, full locked corpus.
- **deploy-pages.yml** gained the archived-season strip (no-op at zero flags, ABORTS on structural
  failure — a wrong artifact must not publish silently). **StatTrack 0.74**: eleven per-season
  fetch sites routed through `sgj(dir,sid)`/`seasonBase(sid)` (the future-sharding choke point),
  one-shot 404 fallback on the other origin (tested against two local origins, both stale-index
  directions), LOCKED pill + muted name keyed on `locked` ONLY — serving origin stays invisible.
  Bonus: 0.73 already checked `rec.private===true`; the standing private-flag verification closed
  with no change needed. **scan-complete-rounds --unlock** clears archivedAt with locked in one
  write. All embedded scripts byte-asserted against tested sources; every helper instance (seven
  across the repo now) proven byte-identical at 1,046 bytes (1,032 characters — my first correction confused the two, and my "other boundary" explanation for the old 1,452 figure was an invented mechanism, retracted when tested: 1,452 matches nothing; §2.8 has the git-history check that settles it) — correcting this section's own 1,452
  figure above.

**T19's structural fix — post-drain-chain.yml.** The 2026-08-06 lock fix was self-defeating: the
matrix terminal's four-dispatch burst put leaderboards/search/records into the one-waiter
data-write queue where each arrival evicted the last — none had run since the 6th. The fix is
rebuild-chain's proven shape applied permanently: the five builds as sequential jobs under ONE
workflow-level acquisition (no waiters exist to evict), invocations copied from the live workflows
they replace — which caught this manifest's own false "--active-only nightly" leaderboards claim;
the terminal's `force=false` dispatch runs the script BARE — fold dispatched fire-and-forget after
team-stats to queue behind the chain's own lock as the lone waiter (the 2026-08-04 ordering, now
uncontested), Deploy Pages dispatched at the tail. The matrix terminal shrank to one dispatch; the
nightly lost venue-indexes (the matrix-storm push contention that was clock-killing it is gone at
the source; the 240-min backstop travelled into the chain) and gained the mirror gate: matrix-
skipped nights — which previously ran NO post-drain builds and fired NO Deploy Pages trigger,
leaving the crawl unpublished — now dispatch the chain at terminal drain. Chain #1 green in 38 min
(first leaderboards/search/records runs since the 6th; venue directories healed in the same pass);
fold #32 waited out the lock and ran clean; Deploy #88 cancelled BY DESIGN when fold's
workflow_run deploy #89 superseded it in the `pages` group — one deploy, capturing everything.
Interim one-at-a-time manual dispatches: retired. Residual: the graduation flip is the only
data-write waiter left outside the chain (rare, safe-side, red-visible) — folding it in is
OUTSTANDING §2.7, polish not a hole.

**Also today:** nightly #61 died at runner acquisition during a confirmed GitHub Actions/Pages
outage (nothing started, nothing to clean — the runner-acquisition error string plus the incident
timeline settled it as not-our-bug). the pending playhq_api_reference correction
(`gradePlayerStatistics` pagination) turned out ALREADY DONE — the July 2026 correction is in the
header note, the section, and the limitations table; the open item was stale, closed by
verification not by editing. Deploy Pages' trigger location recorded precisely in
§1 (workflow_run on five workflow NAMES; the dispatch is NOT in nightly-crawl.yml) — the
imprecision cost a session detour when I asserted the nightly dispatched it, then asserted the
opposite, both without reading. Archive-repo and StatTrack READMEs written. Runway restated with
measured numbers: active residual growers are players/ + search/ + venue-lookup (years); archive
fits ~7 more annual cohorts before era-sharding behind StatTrack's existing `seasonBase()` choke
point.

### 6.31 · 2026-08-07 → 08-10 — the appearance gap: proven, sized, and being swept; plus three latent failures it dragged into the light

**The gap, from anecdote to mechanism.** The 2026-08-06 verdict was right about the cause and wrong
about the cost. Game `7da945a8` (JCC 2026) settled it: the stored `p[]` holds 12 ids and is a
**strict subset** of the live spectator box's 19 — verified programmatically — while PlayHQ's own
game page renders all 19 with the same stat lines the profile API returns. The data was public
throughout; the loss is entirely capture-side. The game was captured while its electronic scoring box
was partially entered, the round then settled, and `nightly-crawl.js` builds its spectator queue only
from rounds it fetches, so nothing ever asked again. Two of my own assertions were corrected en route
by reading code rather than reasoning from it: these games are NOT re-queued nightly, and the
spectator endpoint does not withhold them. A third — that partial `p[]` lists must be alias-fold
cases — was disproven by the probe's own classification (100/100 GENUINELY-ABSENT).

**Measured before built, twice, by independent methods that agreed.** `size-gap-players.yml`
(offline, zero API calls: profile-derived `gp` minus roster-derived `games[]`) returned 102,609
affected players and 757,272 missing appearances — within 2.4% of the 775,703 aggregate probe, which
is what makes both numbers trustworthy. The distribution is bottom-heavy (80% of affected players
miss ≤5 games; ~1,060 miss 100+), and `size-resweep.yml` sized the sweep target at 2,026,441 games
averaging 12.8 stored ids, RISING every year — 152,899 already in 2026 — so this is a live process,
not an inherited scar.

**Tools built, all on the proven lineage.** `probe-player` (read-only, four-way classification per
credited game), `repair-player` (targeted append, alias-gated per game so a divergent-id player is
never duplicated), `repair-players-batch` (self-ranking, progress committed every 25 players, dead
profiles recorded), `synthesize-missing-games` (closing §2.2: 9 games written, plus 69 appends to
pre-existing profileOnly entries across 17 files — more than I had briefed before Mark ran apply,
owned at the time; the arithmetic closed exactly against the probe's 1,637 credits). Every network
and classification block byte-identical to `probe-missing-games.js`; every commit block byte-identical
to `nightly-crawl.js` or `repair-aliases.yml`.

**The campaign.** `spectator-backfill` was widened by opt-in (`--include-partial`) and hardened four
times, each time by a challenge from Mark rather than by design foresight: a `locked_only` default was
replaced with an age guard within an hour of him asking why current seasons would be left incomplete
(the risk is FRESHNESS — `spc` freezes a box forever — not lock status); the weekly cron was added
when he asked how sub-30-day games would ever be corrected, and commented out again when he pointed
out it would fight his own dispatches for the lock; the miss-marker was built only after the queue's
season-sorted re-asking had already cost two runs (~77k re-queries for 2 hits — a 0.003% conversion
that made `--miss-attempts=1` the obvious default); and crash consistency was fixed only after a real
loss. That loss is the entry's centrepiece: a `max_games=700000` dispatch ran ~16 hours against a
350-minute timeout and died at ~306k games with every game write durable and the ENTIRE player phase
— resolve, detect-new, stub — still in memory, stranding ~306k games' worth of players behind `spc`
where no queue could see them. I had scaled the tool 400× without re-deriving its failure modes and
had repeated its own "a timeout costs one window" comment to Mark while it was true for only half the
writes. Fixed by moving the player phase inside the commit window; the debt was collected by a
purpose-built `--heal-dangling` mode (54,920 games, 86,761 references) and verified by a second run
reporting zero.

**Progress at time of writing:** `spc` 158,022 → 725,701; sweep target 2,026,441 → 1,365,259; hit
rates 85–93% in fresh territory; ~14k previously-invisible players discovered and stubbed, each cohort
triggering folds (13,594 merges in one, 5,702 in another).

**Three latent failures the campaign exposed.** First, **T16 was already written in
`claude_context.md` and `fold-diverged-players.js` had never been audited against it**: 82 seconds of
real work followed by 1h54m in a per-path `git add` loop (~27,600 invocations against a ~50 MB index),
killed by its timeout with nothing committed — twice, because the timeout was blamed before the loop
was measured. Batched `--pathspec-from-file` with per-path fallback (preserving the atomicity property
that motivated per-path) took the same commit to 809 ms in test and ~4 minutes live. Second, **T26,
new**: Node's `execFileSync` defaults to a 1 MB output buffer, and a fold's `git merge` emitted
1,051,036 bytes of per-file "Auto-merging" lines — 2,460 over — so Node SIGTERMed git mid-merge and a
commit that had already been made was never pushed. Reproduced at the exact byte size, then fixed
across `fold-diverged-players.js`, `spectator-backfill.js`, `repair-players-batch.js` and
`nightly-crawl.js`; the last three inherit `gitCommit` verbatim, which is precisely how the bug
propagated. Third, **T19's dispatch burst was still live in `nightly-crawl.yml`'s own terminal**,
firing both weekly discovery sweeps at the same instant as post-drain-chain: on 2026-08-09 Discover
Seasons spent 51 minutes queued behind a 41-minute chain and re-attempted twice, its `!cancelled()`
retrigger adding two arrivals each time.

**The overnight pipeline, re-architected.** Both discovery sweeps moved off the nightly onto their own
weekly crons (Sun/Mon 20:00 UTC — six hours clear of the cascade, ~19 hours clear of the next
nightly), which also removed a fragility I had built and Mark rejected: a tail-chained version left
discovery four dispatches deep, where any broken link silently skips a week. `generate-shards`' no-op
`data-write` claim was split into a `fresh_start`-only job, halving that workflow's lock arrivals from
80 to 40 per sweep. **T27, new** — a scheduled run receives NO inputs — was handled at all 12 use
sites, including the self-retrigger's forwarded values, without which run 1 would be correct and run 2
would silently revert to the wrong sweep mode. And `fetch-profile-stats-matrix.yml`, the last repo
writer outside the `data-write` group despite three committing jobs, was locked at those jobs only —
never at workflow level, since its 20-shard fetch fan-out writes nothing and would otherwise hold the
lock for an entire sweep.

**Corrections to this manifest's own record:** the "Manually run by markjovic" label on chained runs
is a PAT artifact and says nothing about who triggered them — I built an argument on that misreading
before Mark corrected it. `CONCURRENCY_SPECTATOR = 3` remains unexplained: the only quota note in
these docs concerns a different tool and does not match this endpoint's measured behaviour
(OUTSTANDING §2.11).


### 6.32 · 2026-08-11 — the sweep finishes, and its leftovers turn out to be a second dataset

**The campaign closed on its numbers.** 2,344,710 games on file; `spc` on 1,943,317 of them (82.9%,
against under 7% four days earlier); 265,194 retired as misses; 44,989 held back by the 30-day age
guard; queue zero. Every tally reconciles against the file count exactly.

**Then the misses were interrogated rather than accepted.** `size-misses.yml` bucketed them by their
own season's capture rate — 446 DEAD seasons holding 175,647, 545 MIXED holding 70,820, and 951
COVERED seasons above 95% capture that had still lost 18,727 scattered games. Mark spot-checked the
suspicious bucket and found three of four had full player statistics live on playhq.com. I built a
re-admission flag on the theory that they were transport failures; a 200-game probe returned 200/200
`"game could not be found or was not electronically scored"` and the Worker agreed with
`{"error":"Game not found"}`, proving the retirement correct and the flag useless. That cost one
minute of endpoint time and changed no data, but it was a wrong theory built before the evidence
supported it.

**What actually cracked it was Mark noticing the page's own words:** "Play by play is not available as
this game was not scored live at the venue." `spectator.playhq.com` is PlayHQ's LIVE-SCORING service
and only holds games scored in real time; `api.playhq.com`'s `gameView` → `discoverGame` is the
canonical record and holds everything, including games scored on paper and entered afterwards. Our
roster capture has read spectator exclusively since it was written, so paper-scored games have never
been visible to any tool we have. It is a scoring-METHOD split, not an era: it shows up at 2.3% in a
season captured 97.7% just as it does at 100% in VJBL 2021. Four of five sampled games from
0%-coverage seasons returned full lineups from the canonical record; the fifth 404s, having been
deleted upstream.

**`discover-game-backfill.js/.yml`** was built on that finding, from `spectator-backfill.js` so the
session handling, commit-window player phase, stubbing and `gitCommit` are inherited verbatim. It
selects only games spectator actually tried and failed on, so it can never run ahead of the sweep.
The `gameView` query is embedded byte-identical to a live browser capture with all six fragments
intact — I trimmed it first, which would have broken it silently, and caught it against the standing
rule. Its flags are deliberately separate from spectator's (`dg`/`dgm` vs `spc`/`spcm`) so provenance
survives and neither path can overwrite the other's record. Two advantages over spectator emerged in
testing: profiles arrive as full uuids with names, so stubs are created already named rather than
waiting for the matrix, and fill-in or anonymous participants carry no profile id and are counted and
skipped rather than guessed at. No cron, deliberately: the backlog is finite, and the recurring case
is OUTSTANDING §2.12.

**Also corrected before anything ran:** `repair-player.js` and `repair-players-batch.js` would have
written `hp[]`/`ap[]` stat lines into real crawled games, against the never-pre-store convention.
Neither had been dispatched. Both are now roster-only, with the reasoning recorded at the write site
— a one-player stat list in a thirteen-player game is a fragment that reads as a box score,
completing them all is ~1.9 GB, and stored stats go stale while the Worker serves the amended
version. The `profileOnly` exception stands and belongs to `synthesize-missing-games` alone.

**A wording correction worth keeping**, because it cost real alarm: I reported the sweep as storing
"box scores", and Mark reasonably read that as a deliberate architectural decision being reversed
behind his back. It was not — the sweep wrote `p[]` ids and a capture flag and nothing else. In these
documents "box score" means the per-player stat lines, which remain Worker-on-demand; the sweep
captured ROSTERS. Also corrected this stretch: I asserted Mark's commit state twice without any
visibility into it, and mislabelled files delivered on the 8th and 9th as "from earlier today".


### 6.33 · 2026-08-13 — the number, and two ordering bugs that hid it for a day

**The verdict.** Missing appearances **757,272 → 442,939**, a 41% reduction across six days. The deep
tiers are effectively gone: players missing 100+ games fell from 1,060 to **13**, the 51–100 band from
764 to **57**, and the worst single record in the database is now 188 games short against 555 on the
Friday. 274,520 players are fully captured. What remains is shallow by construction — 112,682 of
114,959 affected players are short twenty games or fewer.

**`discover-game-backfill` finished the canonical-record sweep:** 133,674 games at ~99.9%, at
concurrency 5. That number was measured rather than chosen: 25 produced a 98% hit rate for ~140 games
and then a sustained 403 wall it never recovered from, while 5 ran 200/200 clean in 52 seconds. The
measurement sits at the constant precisely so nobody raises it later on a hunch. A real limit surfaced
in the same work: about 19% of players in paper-scored games are fill-in or anonymous participants with
no profile id at all, counted and skipped, unrecoverable by any route.

**`repair-players-batch` did the targeted work** — 75,095 appends at min-gap=100 covering 99.6% of
those players' gaps, then 197,397 more before the workflow timeout, then 4,810 at min-gap=25. Two of
its own defects were fixed en route: the season-file cache had NO eviction policy, so a 468-player run
accumulated most of `games/bv` in the heap and died at 4 GB after ~90 players (a leak with a delay);
and it would append a player to a game with an EMPTY roster, which is not a gap but an UNCAPTURED game
— `43199a27` ended up with a two-id roster, both ids the tool's own top-ranked targets, in a game
holding a dozen. Same failure class as the `hp`/`ap` fragment caught on the 11th, and the same rule:
a fragment that looks like real data is worse than absence.

**Then a full day went on two ordering bugs, and the debugging is the part worth remembering.** A
player with 473 roster entries in `games/bv` showed a `games[]` of 30. I proposed six explanations —
fill-in players, mass mis-attribution, the resolver returning null, a missing `uuid` field on index
stubs, a 13-char prefix collision, a broken write path in the batch tool — and every one was wrong.
Each cost Mark a dispatch or a browser check, and every dispatch begins with a five-minute repo
checkout. What actually settled it was reproducing the real `build-player-games.js` in the sandbox
against real uploaded data: one season file, the genuine index shard, the genuine alias shard. The
resolver returned the correct uuid, `getCollisions()` was empty, and Phase 2 flagged the file for
update — proving the code correct by EXECUTION and leaving ordering as the only survivor. Running the
script standalone updated 13,046 files against the weekly's 9,353, and the player came out at 503.

**The bugs themselves (now T28 and T29).** Workflow-level `concurrency` serialises a workflow against
OTHER workflows, not its own jobs against each other — `weekly-indexes.yml` had three player-file
writers running in parallel from separate checkouts, each pushing with `merge -X ours`, which is a
lost-update path rather than merely a staleness one. And `build-player-games` derives `games[]`
entirely from `p[]` in the game files, yet ran alongside `discover-fixtures`' 360-minute window,
deriving from whatever its checkout captured at job start. The chain is now
`discover-fixtures → team-stats → win-loss → player-games → fold-diverged`, and both `setup-node`
steps were removed from that workflow while it was open — harmless there, since neither script fetches
PlayHQ, but one edit away from the CloudFront failure documented everywhere else.

**Two investigations closed by evidence rather than by building anything.** The negative-gap population
(26,445 players) is largely PRIVATE PROFILES: the API returns OK with no `seasonStatistics`, so the
credited total is near-zero by construction while the roster appearances are real — probed live on a
player with `private: true`, gp≈35, games=489. The fill-in theory was refuted by my own diagnostic:
canonical-record games are 5.1% of affected players' games, the same as their share of the database,
where fill-ins would have concentrated. So there is no fill-in tag to build, and the diagnostic needs
to read the `private` flag before it is trusted again.

**And a smaller correction worth keeping:** `discover-fixtures.js` froze the weekly with no output for
five minutes. Node's `fetch` has no default timeout, so a single stalled socket blocked its
`Promise.all` batch and therefore the entire run indefinitely; separately, the 429 branch retried
without incrementing its attempt counter, spinning silently forever. Both fixed, with every retry now
printing. Concurrency 40 was NOT the cause — it is the cron's proven value — and I argued otherwise
twice from my own assumptions instead of from the run log Mark had already pasted.

### 6.34 · 2026-09-01 → 09-06 — a wrong field name, a wrong keeper, and a wrong alias

Four faults, three of them mine, one of them PlayHQ's. Every number below came from a real file in
this repo, not a fixture.

**`g.h`/`g.a` is never sufficient.** A game carries `h`/`a` OR `t1`/`t2` — `README.md` L266 has said
so throughout. `build-player-games.js` L175 read only the first pair, so every hidden game produced
null team ids, the registration test in the `u` block could not pass, and every appearance in a
season the player holds a registration for was written into `u`. **1,115,172 → 39,128.** The same
bug in `build-win-loss.js`, five sites: every hidden game contributed zero wins and losses to every
player in it, silently, because `build-finals-stats.js` had always resolved both pairs and so finals
results were counted for games regular-season results were not. **44,195 players corrected.** And in
nineteen places in StatTrack, the worst being a season card that rendered "No game records found."
for a player who played every game in it. Now trap T34.

**The fold's keeper kept the wrong record.** It chose by `games[]` count — assigned by
`build-player-games` resolving rosters through the alias index, so before an alias exists the stub
collects everything. Across the 552 pairs the seeder had to refuse, the stub held a median of 69
games and the real api-keyed profile held 1. The stub won, and since only seasons/games/teams/
gameTids/name are unioned, the real profile's stats, records and `private` flag were replaced — and
the inherited `statsChecked` meant it was never re-fetched. Keeper now decides by which record holds
stats. **533 of 541 merges rescued.** The seeder's guard, which existed only to work around this,
came out.

**`proposal-store-playhq-credited-games.md` was retired and deleted**, its decision recorded in
`claude_context.md`. It had one number wrong that mattered: "roughly 450 refused seeding cases" was
523, and the guard it named lived in `seed-apiid-from-playhq-pairs.js`, a script written the same
session and never added to this manifest. That is why the guard could not be located from the docs.

**`c` and `x` shipped; `gamesAPI` was measured and rejected.** The full credited list is ~315 MB
against the 314 MB `games[]` already costs and 99.4% the same ids. The disagreements are ~4 MB.
Cross-check `gp - games[] == c - x` verified at 100.0% on shard 00 across 1,591 players.

**`x` found a defect in PlayHQ.** Of the 8,634 entries a stored box score can settle, **8,616 —
99.8% — have the player in PlayHQ's own box score while PlayHQ's own career totals leave the game
out.** Verified first on Toby Jovic (`0afc7690`, game `c7a6db82`), whose PlayHQ profile page skips
the round its own box score records him playing.

**And it found misrouted aliases.** The same child under two PlayHQ profiles with a spectator id
aimed at the wrong one. Jordan Uppal: 116 appearances on the wrong record. 46 aliases repointed, 22
held back, 37 identity aliases excluded, 17 partials left for reading. William Warren 262 → 78 games
against a gp of 78; Ben O'Connor's duplicate collapsed into `b9ca8d79` at 171/171.

**Three traps, all from the alias repair, all mine.** T35: an alias whose key is a prefix of its
target is the player's own id, and the first repair listed those under a heading saying "to repoint".
T36: one claimant holding all the misrouted games does not license repointing every alias — attribute
games to the alias that carried them; 117 candidates became 46 once that was done. T37: "another
profile holds this game and is credited for it" is true of every teammate; the claimant must be the
same person by name.

**T38 — test against real files.** Every one of the above passed a synthetic test first, because the
fixture was built out of the same wrong assumption as the code. Two-player rosters when real rosters
have ten. `h`/`a` games when 97% of that season used `t1`/`t2`.

**Memory, at 418k players.** `find-misrouted-appearances.js` died twice at the 4 GB heap limit. A
per-season map of wanted game ids is a cross product — one flat set and a single sweep of every
season file instead. Do not cache every parsed player file. Do per-player work per player.

---

### 6.35 · 2026-09-08 — three faults of one family, and the dates that were being thrown away

Every fault closed today was the same mistake wearing different clothes: **a failure to ASK
recorded as an ANSWER.**

**`discover-org-seasons.js` — the guard.** Its `discoverSeason` returned `null` for three
different things: PlayHQ answered with nothing, the request was forbidden, and the request
errored. `buildEntry` read "no grades came back" as "this season has no grades", and for a
`COMPLETED` season that wrote `{grades:[], locked:true, removed:true}` — permanent, because the
grade-refresh in `discover-seasons.js` selects `locked === false` only, so nothing ever re-asks.
80 seasons landed there on 2026-09-07 off a CloudFront wall. `lookupSeason` now returns a tagged
outcome and an unanswered season is **not written at all**; the run reports itself INCOMPLETE
rather than clean. Root cause of the divergence between the two scripts: `discover-seasons.js`'s
`aimdRun` has no give-up ceiling, so a blocked item is requeued forever and can never reach the
entry-writing loop — its `if (ds?.blocked) continue;` guard is unreachable belt-and-braces.
`discover-org-seasons.js` added `maxAttempts: 4` and then wrote the entry anyway.

**The repair, sized before built.** `audit-removed-org-seasons.js` (new, read-only) re-asked all
80: **52 have grades (239 total), 28 genuinely have none, 0 unanswered**, in six seconds with zero
blocks. Repairing all 80 would have been as wrong as leaving all 80. Applied via
`--repair-removed`, which selects `discoveredBy === 'org' && removed === true` — exactly 80,
leaving the 274 stubs from other sources untouched and asserting that before committing. Verified
on `55dcd845` and `af72a719`. Two independent live runs 17 minutes apart agreed on all 52 seasons
and the exact grade count of every one.

**`discover-seasons-matrix.yml` — the map fan-out.** Four weeks of green 30-second no-ops. See
T51. Fixed with one key, `map.if`; the parsed job graph was diffed key by key against the
pre-change file to confirm `needs`, `strategy`, permissions, concurrency, the `gen` step and the
whole `reduce` job were byte-identical. Proven by dispatch with `fresh_start` unticked — the exact
broken condition. The sweep then ran to completion across three chained runs: 256/256 shards,
233,617 players at 100%, 48 new seasons, 46 grade lists filled including `8f43ff68` going from a
bare pre-allocation to 42 grades.

**`--backfill-dates` — the dates that were already being fetched.** `discoverCompetitions` returns
`status`, `startDate` and `endDate` for every season an organisation has ever run, reaching back
to at least 2020. Line 483 discarded all of it for any season id already known. Measured before:
only 639 of 3,431 seasons carried an `endDate`, and **418 of the 703 unlocked seasons had never
had their status asked at all — holding 8,106 grades, 85% of the nightly's work.** The backfill
reads the same 183 calls properly: **1,984 filled, 63 corrected, 2,792 → 808 missing, in 17
seconds, no extra requests.** Metadata only — four assertions on count, `locked`, `removed` and
grade totals abort before commit. It does not lock a season even when PlayHQ says COMPLETED.

**`close-empty-seasons.js` (new) — closing on evidence.** 78 seasons held no games file at all. A
missing file is **not** evidence that no games exist; it is equally consistent with a capture
failure, and closing one of those buries recoverable data — the same mistake as `removed:true`,
from the other direction. So the tool asks PlayHQ per grade using the nightly's own `gradeRounds`
→ `discoverFixtureByRound` pair, and closes only what comes back empty. Three outcomes never
collapsed: confirmed empty → `locked:true` + `closedAt` + `closedReason`; PlayHQ holds games →
**not closed**, reported as a backfill job; blocked or errored → untouched, re-run. Seasons
touched in the last 3 days are skipped, which protected the 52 repaired hours earlier. Result:
**26 closed, 304 grades off the nightly, 0 holding games we had missed.** `6a36400d` had all 65 of
its grades asked individually and returned nothing.

**Two read-only audits also built.** `audit-finished-unlocked-seasons.js` — measures
finished-but-unlocked seasons against real game data on disk, two-phase checkout (`games/bv` is
1.94 GB / 2,939 files; a cone pattern is unusable, so phase 1 emits explicit paths and phase 2
takes them by name). `audit-pending-games-vs-playhq.js` — asks whether games we hold as PENDING
are still pending at PlayHQ. Answer: 685 asked, 0 finished. Its `not returned` counter is
defective; see OUTSTANDING_TASKS.

**Own goals, all caught by execution rather than reading, all now traps.** T52: a fixed 150 ms
sleep with no retry got `close-empty-seasons.js` walled after 5 seasons — the comment forbidding
exactly that had been written into `discover-org-seasons.yml` earlier the same session. T53: a
counter that read a mutated object reported 0 filled while filling 1,984; and a classifier that
tested `st === 'UPCOMING'` counted zero unplayed games in a season holding three, because real
data uses `PENDING` and `IN_PROGRESS`. T54: a revised file re-delivered under the same name with
no version marker was silently swapped, and the stale copy was run.

**Tools added:** `scripts/audit-removed-org-seasons.js`, `scripts/audit-finished-unlocked-seasons.js`,
`scripts/audit-pending-games-vs-playhq.js`, `scripts/close-empty-seasons.js` — each with its
workflow, all read-only except the last, all dispatch-only, none using `actions/setup-node`.
**Tools changed:** `scripts/discover-org-seasons.js` (guard + `--repair-removed` +
`--backfill-dates`) and its workflow; `.github/workflows/discover-seasons-matrix.yml` (`map.if`).

---

### 6.36 · 2026-09-08 (later) — the writers that had quietly stopped, and one that never started

Prompted by a simple question: why are the commit dates on files in `data/` months
apart? Three of the quiet files were correct. Two writers were broken.

**`data/venue-index.json` had never been updated once.** Created 2026-06-13 by the
Phase 1 migration — 532 entries against the 532 venue directories of that day — and no
ongoing writer was ever built. The writer→reader graph in §4.1 recorded it as
"(venue build)", which is not a script, and that placeholder was read back as though
it were a fact when the question was first asked. The project's own chat history had
the answer and was not searched until Mark insisted. That is now **T56**.
Fixed in `build-venue-indexes.js`, which already opens every file in `games/bv` for
part 3 and where every game carries `vid` **and** `vn` — the name was one field away
from the id already being collected. It merges rather than replaces, keeps and counts
entries no game mentions, and aborts if the file would ever shrink. First live run:
**532 → 541 venues, 9 added, 2 renamed, 0 orphaned**, pushed on the first attempt.
All 1,795,589 games with a `vid` also carry a `vn`. Two renames were real venue
changes, not noise.

**`build-venue-indexes.js` carried the combined-`git add`.** One add across three
pathspecs; a single unmatched pathspec stages nothing, atomically, exit 0. That is
the §2.2 fault that discarded 30,426 games from `discover-fixtures.js` on 2026-07-19,
fixed there on 2026-07-21 and never fixed here. Its `gitCommit` was also wrapped in a
try/catch that printed and returned, so any git failure exited zero and the job showed
green. Now per-path adds, staged shortstat, 60-attempt push retry with jitter, throws
on exhaustion.

**`update-team-index.js` broke four rules and never corrected a team.** `git add -A`
— the **third** instance of a violation this project explicitly forbids, after
`discover-seasons.js` and `build-leaderboards.js` on 2026-07-09; `--stat` where the
rule says `--shortstat`; `merge` without `--no-stat`; and the same swallowing catch,
with no push retry. Separately, `if (existingTids.has(tid)) continue;` ran BEFORE any
comparison, so a renamed or regraded team kept its original values permanently. It now
compares and corrects, prints each change, and will not let a blank team name from
PlayHQ overwrite a name already held. The §2.2 row describing its input as
`team-stats/bv` was also wrong — it reads player files.

**Two timeouts became wrong the moment the retry loops were added** — `update-team-index.yml`
15 → 150 and the `team-index` job in `nightly-crawl.yml` 15 → 150, with the arithmetic
written next to each number. The nightly's job graph was diffed key by key to prove
exactly one key changed. That is **T55**, and it is the same failure
`build-venue-indexes` suffered at 45 and again at 120 in August.

**Confirmed correct, do not re-investigate:** `zero-team-seasons.json` (a
`discover-fixtures` report), `seasons-discovered/invalid/skipped` (the never-re-queue
lists), and `season-venue-index.json` covering 2,116 of 2,939 seasons — a season only
appears there if one of its games carries a `vid`, and hidden games never do.

**Also fixed:** the `not returned` counter in `audit-pending-games-vs-playhq.js`,
which counted every game in a grade the run never queried as a fixture PlayHQ had
dropped. 632 phantom absences on the first run, 0 after. It now produces a count only
under full coverage.

---

### 6.37 · 2026-09-08 — the season lifecycle rule, and a guard mistaken for a bug

**Nothing had ever locked a season.** After the date backfill made the scale visible:
419 `COMPLETED` seasons unlocked holding 5,873 grades — **59% of everything the
nightly fetched every night** — 334 of them finished more than three months earlier,
41 more than three years, one in December 2019.

**`scripts/lock-quiet-seasons.js` + workflow (new).** Daily, 20:30 UTC, and it
APPLIES. A rule that only fires when someone remembers to dispatch it is a report with
extra steps, and the safety here is the evidence rather than a human in the loop:
PlayHQ says `COMPLETED`, games exist on disk, the season is old enough, and it is
reversible — `lockedAt` and `lockedReason` are the selector, exactly as
`discoveredBy:'org'` made the repair of 80 damaged seasons possible the same day.
Never `removed:true`; that means a `grades:[]` stub, and these hold real grades.

`lock_after_months` ships at **3, equal to `min_age_months`**, so age alone decides.
Drafted at 12, 6 considered; both were caution, not measurement. The fingerprinting
(sha1 over each game's id, status and both scores) still runs and became the CHECK on
that decision rather than a gate: a season locked on age whose fingerprint moved in
the same run was still receiving data when sealed, and is reported as **STILL
CHANGING** with every id named for reopening. That count must stay at zero — if it
does not, three months is too short and the log says so.

**The zero-games floor.** `lock-quiet-seasons` never locks an empty season. Proving
one is truly empty means asking PlayHQ per grade, which is `close-empty-seasons.js` —
given a **weekly cron** the same day, having been dispatch-only, because empty seasons
would otherwise pile up exactly as finished ones had. The two rules now cover the
whole space with nothing left to remember.

First dry run at 12 months: 69 locked, 485 grades off the nightly, 9,953 → 9,468;
238 still settling; 84 too young; 28 with no games; **0 with no endDate**.

**T57 — the guard that was not a bug.** `update-team-index.js` skipped known teams
before comparing them. Treated as a defect and "fixed" to correct `n`, `comp` and
`grade` keyed on `tid`; a `--all` dry run then reported **2,175,659 corrections across
360,777 teams**, the same tid rewritten repeatedly within one run. The skip was
Decision A working: a reg IS a `(team, grade)` pair and the identity is `(tid, gid)`.
This was **T14 rebuilt** in a new script. `grade` is now never corrected, and the
current grade cannot be recovered from registrations at all — measured on `0afc7690`,
the RES grade is `reg[1]` twice and `reg[0]` twice across four regrades, so array
order carries no chronology. `n` and `comp` are safe and the corrected run cleared
**2,628 teams, almost all holding an empty name** since the index was built and
therefore unsearchable in StatTrack.

**Tools added:** `scripts/lock-quiet-seasons.js` + `.github/workflows/lock-quiet-seasons.yml`.
**Tools changed:** `close-empty-seasons.yml` (weekly cron, applies),
`update-team-index.js` (grade excluded from correction),
`audit-pending-games-vs-playhq.js` (coverage-gated `not returned`).
**New data file:** `data/season-activity.json` — per-season games fingerprint and
unchanged-run streak. Written by `lock-quiet-seasons.js` on every run including
`--record-only`. Deleting it costs nothing but the streak history.

---

### 6.38 · 2026-09-10 — half the nightly gone, and a status nobody had ever counted

**The lifecycle rule ran.** 307 seasons locked, 4,927 grades, **9,956 → 5,029**.
`STILL CHANGING` 0 against 391 fingerprints; exactly one season moved between the two
runs (`01ffe236`, ended seven days earlier), which is the canary demonstrating it can
detect activity rather than always returning the same hash. `lock_after_months` is 3,
equal to `min_age_months`, so age alone decides — Mark's call, and the fingerprint is
now the check on it rather than a gate.

**`lock-quiet-seasons.yml` was given `data-write` the next day.** It shipped lockless
on T19 grounds and that reasoning did not survive scrutiny: every writer of
`sports-index.json` uses `merge -X ours`, so concurrent writers do not conflict — the
second to push silently keeps its own copy and discards the other's, which no push
retry can catch. T19's harm was to burst-dispatched workflows where an evicted waiter
loses its run outright; a daily cron that misses a day loses nothing. Prompted by the
2026-09-09 run starting at 22:41 against a 20:30 cron: GitHub queues scheduled runs,
and a two-hour drift closes the ninety-minute gaps between the three index writers.

**`db-audit.js` had been counting five statuses NOWHERE.** The catch-all branch read
`else if (!['BYE','LIVE','PRE_GAME','IN_PROGRESS','PENDING'].includes(st))` — so a
game in any of those fell through every counter. The status section totalled 2,360,109
of 2,424,380: **64,271 games tallied by nothing.** `inProgress` had also been computed
since the script was written and never displayed. Both fixed, plus a reconciliation
line that marks itself against the game total.

**That surfaced `LIVE` at 47,807** — the third-largest status in the database, never
once shown, and every single one inside a locked season. Establishing whether they
were recoverable took **five full runs and two wrong endpoints**, and the answer was
in this repository's own documents throughout (**T58**). The finding:
**nothing frozen is recoverable.** 320 games across 40 seasons asked of the canonical
record, **0 finished at PlayHQ**. 232 are no longer held by PlayHQ at all — the
competition withdrawn upstream, which is why those seasons have no `endDate` and no
organisation lists them; we hold the only surviving copy. 88 are still served and
still non-final, matching the 2026-09-08 PENDING work through a different endpoint.
Locking cost nothing.

**`build-search-index.js` — 79,566 players gained a club.** `extractClubTeam` returned
at the first season holding a team name and used THAT season's club even when the
field was absent, never looking further back, so 19% of the database rendered as
"— · TeamName" in player search. It now orders a player's seasons by their real
`endDate` from `sports-index` and prefers the most recent season holding BOTH a club
and a team, so the pair stays coherent: 261,490 of 265,481 come from a single season.
152,902 still have none, correctly. Its `gitCommit` also printed and returned on
failure — the fourth instance of that swallowing catch found this week.

**Smaller, all measured:** the two dangling aliases removed by
`prune-dangling-aliases.js` after `repoint-only` proved them unresolvable (499,607 →
499,605, §3b now 0); `playerCount` deleted from `sports-index.json` as unmaintained
(369,428 against 418,416 real files, no writer anywhere); organisation `59363a37`
skipped in both org sweeps as deleted upstream; `fold-diverged-players.js` L105
corrected and a `repoint-only-dry` mode added, that branch having been un-previewable.

**Three nightly timeouts corrected against their retry budgets (T55).** `team-index`
15 → 150, `team-stats` 60 → 240, `venue-lookup` 30 → 180. `build-team-stats.js` has
had a 60-attempt loop since 2026-07-28 — roughly 109 minutes for one commit, and it
commits every 50 seasons — inside a 60-minute timeout for six weeks.
`update-venue-lookup.js` was the reverse case: 30 was correct for its old 10-attempt
loop and became wrong the moment that loop was raised to the house pattern. Both
scripts swallowed failures and now throw.

**Tools added:** `scripts/prune-dangling-aliases.js`, `scripts/audit-nonfinal-games.js`
(both with workflows), and the one-off `scripts/drop-stale-playercount.js` which should
be deleted once run.
**Tools changed:** `db-audit.js`, `build-search-index.js`, `update-venue-lookup.js`,
`build-team-stats.js`, `discover-org-seasons.js`, `fold-diverged-players.js` + `.yml`,
`lock-quiet-seasons.yml`, `nightly-crawl.yml`, `audit-pending-games-vs-playhq.js`.

### 6.39 · 2026-09-11 — a fallback tier that overruled the tier above it, and a task that was wrong about its own premise

**The item said NOT BUILT and something had been built.** OUTSTANDING §1a read
"the matcher still writes aliases without checking season activity — NOT YET FIXED".
A check shipped on **2026-08-29** at `fetch-profile-stats.js` L774–799: the recovered
candidate's own profile is fetched, and it is rejected unless its statistics name a
grade the player is registered in. Applied to tiers 2 and 3, skipped for tier 1,
counted as `recoveryRejected`, reported as `recovery_rejected` in the shard summary
and summed by the matrix aggregator. None of that had reached the task list — **T12**
again, the fourth instance.

**The fix the item proposed would have changed nothing.** A grade belongs to exactly
one season, so "the candidate shares a grade with the player" already implies "the
candidate was active in that season". A season-activity predicate is a weaker form
of a test that was already running.

**What was actually wrong.** Tier 2 iterated `allGids` — every grade on every
registration — and matched on name alone. Tier 1 had already searched the subset of
those grades where we hold a team id, requiring the name to match a player on that
team. So a tier 1 failure fell straight into tier 2 re-asking the same question with
the team requirement removed, and the one same-named profile in the grade got the
alias regardless of which team it played for. That is the Jida McCrae-Cooper shape.
The function's own tier list has said since it was written that tier 2 serves a
registration with a grade and no team; the loop never implemented that sentence
(**T60**).

**The 2026-08-29 check could not have caught it.** A tier 2 candidate is drawn from
the roster of a grade the player is registered in, so it shares that grade by
construction and passes. The check is real work for tier 3 only (**T61**).

**The narrowing, and why it keeps two sets.** Tier 2 now collects `rosterHits` from
grades where we hold no team id — the eligible set — and `wideHits` from every grade,
used only as the ambiguity test; a candidate is written when both hold exactly one
id. The second set is not decoration: narrowing the search space also narrows what
counts as a collision, so without it two same-named profiles split across the two
grade types (one the old code refused as ambiguous) would have become a confident
write. The change can therefore only ever decline MORE than before.

**Verified by execution, not by reading.** A sandbox extracts the tier 2 block out of
the delivered file and runs it — the shipped bytes, not a retyped copy — over seven
cases: the Jida shape, a legitimate no-team-grade recovery, a mixed player, the
two-same-named-profiles regression guard, an identical hit in both grade types, no
hit at all, and a blocked grade. Seven of seven as expected. **Grade rosters fetched
were identical old and new in every case**, which is the evidence that no API call,
request count or session budget changed. `node --check` on both scripts at the
delivered path; the workflow parsed and its aggregator extracted and run against
summaries with and without the new field.

**The cost is counted, not estimated.** Every candidate the old code would have
aliased and the new code refuses increments `tier2Suppressed`, prints a named line
for the first 20, and is reported as `tier2_suppressed` per shard and in the
aggregate. **Nobody has ever read either this or `recovery_rejected`** — both are in
the `summary-and-retrigger` job of any run.

**A dead copy, kept in step and marked for deletion.** `seed-missing-profiles.js`
carries ~250 lines copied out of `fetch-profile-stats.js`: `attemptNamespaceRecovery`,
`processUUID`, `finishOk`, `markNotObtainable`, `recordAliasDiscovery`. `main()` calls
`fetchPublicProfileName` and nothing else; `processUUID` is defined and never invoked;
`playerPath()` reads `SHARD`, hard-coded `null`. **No alias has ever been written from
that tool.** Its copy predated the 2026-08-29 check entirely. Both guards were ported
so the two functions now agree — a stale copy is how the next script built the same
way inherits the old behaviour, and that file's own header records the copy going
wrong the first time (**T31**). Deleting the block is OUTSTANDING **§2.23**, on its
own, not folded behind a behaviour change.

**Callers enumerated before delivery, not after.** `find-code-refs` on
`namespace-resolve|matchFromGradeRosterByName`: two scripts call the matcher,
everything else imports `normName` / `isPlaceholderName` / `looksLikeSeasonName` or
mentions the module in a comment. The module header named
`backfill-missing-players.js`, which no longer exists.

**Process failure worth recording.** Asked for evidence that the 2026-08-29 check ever
fires, I sent Mark to find a conditional log line across 938 runs of up to 256 shards
— while the aggregator had been summing and printing that exact number in one job of
every run since the day it was added. The consumer of the counter was in a file I had
not finished reading. **Read the whole consumer before asking a human to go looking.**

**Delivered:** `scripts/fetch-profile-stats.js`, `scripts/seed-missing-profiles.js`,
`.github/workflows/fetch-profile-stats-matrix.yml`, `OUTSTANDING_TASKS.md`
(§1a replaced, §2.23 added). No dispatch required — the change is picked up by the
next chained matrix run.

### 6.40 · 2026-09-11 (later) — the second item that was wrong about its own state, and a lag that is load-bearing

**§2.20 said `discover-seasons.js` "never refreshes a season's grades once it has
any", citing L526/L542.** The refresh was widened on **2026-09-08** and lives at
**L590–635**. It takes two sets: seasons at `grades: []`, as before, plus any season
`discover-fixtures.js` recorded in `data/stale-grade-seasons.json`. Locked seasons are
excluded from both. The stale line numbers were the tell — they were from 2026-08-19.

**What shipped is a better test than the item proposed.** §2.20 wanted seasons whose
stored grades all end in `* Grading` re-read. The shipped version compares the index's
grade count against what `discoverTeams` returns — data the fixtures sweep already
fetches — so it costs no extra API call and catches a grade list stale for ANY reason.

**Both halves are in place and have never met.** Two Discover Seasons reduce logs weeks
apart print `stale-grade-seasons.json: not present`, while the `grades: []` branch works
normally (46 seasons refreshed in one, including a 42-grade and a 39-grade season). Two
theories were raised and BOTH were wrong: that the writer had never been built (it is
there, `discover-fixtures.js` L941, unconditional outside dry-run, staged per-path at
L469), and that sparse checkout was making `git add` silently ignore it (that workflow
uses a plain full checkout). **The cause is a date.** The writer shipped Monday
2026-09-08; the fixtures cron is Monday 20:00 UTC; the 09-08 run started before the
commit. Its log proves it — it printed the detection block, EDJBA `1ae60211` at 55
grades against 263 live among the 29 found, WITHOUT the two `Written to …` lines the
current version prints immediately after. First write **2026-09-15**, first read
**2026-09-20**.

**The six-day lag is structural.** `discover-seasons-matrix.yml` L80 is `0 20 * * 0`
(Sunday 20:00 UTC), `discover-fixtures.yml` is `0 20 * * 1` (Monday) — read from the
crons, not inherited from a header comment, after that exact kind of inherited claim
caused the confusion above. The dependency is a **cycle**: discover-seasons writes the
index discover-fixtures sweeps, and discover-fixtures writes the flags discover-seasons
reads. Whichever order is chosen, one direction gets one day and the other six. Season
discovery holds the fast path deliberately — a season found late costs GAMES, a stale
grade list costs only metadata, because `discover-fixtures` resolves teams via
`discoverTeams` regardless of stored grades. **Do not swap the crons.** Chaining was
considered and rejected 2026-08-10 (discovery ends up several dispatches deep, where a
broken link silently skips a week).

**Delivered (comments and documentation only, no behaviour change):**
`scripts/discover-fixtures.js` — the printed block no longer claims discover-seasons
will not correct these, and states the lag; the note above the write puts the
superseded sentence in the past tense and records the first-overlap dates so a future
`not present` is recognisable as expected. `.github/workflows/discover-fixtures.yml` —
header rewritten with the cycle and the reason not to swap the crons.
`OUTSTANDING_TASKS.md` §2.20 replaced with the verification dates and the condition
that reopens it (if 09-20 reads `0` with the file present, the fault is in the reader).
`node --check` and a YAML parse on both.

**Two in one session is a pattern, not a coincidence** — see **T62**. Both items were
marked NOT BUILT, both carried pre-change line numbers, and in both cases the fix the
item proposed was WEAKER than what had already shipped, so building it would have felt
like progress and changed nothing.

### 6.41 · 2026-09-11 (third) — a stale reading, a private profile, and a risk that did not exist

**§2.22 is closed and its premise was never a measurement.** It named four players
"credited with hundreds of games where we hold ONE". `probe-player` on two of them:
**Tahlia Parker `20b2df06` holds `games[]`=391** — 388 already correct under her own
id, 1 waiting on the weekly rebuild, 2 genuine roster gaps, **zero** alias gaps, zero
uncaptured, zero absent — and **Jade Chow `11fdc0c2` holds 372**. The `games=1`
figures predate a `build-player-games` rebuild. The "identity that was never
connected" theory had nothing under it.

**A 2026 frozen-partial specimen, which §2.10 did not have.** Tahlia's 2 real gaps are
both in `bd5220b0` (2026 BV School Competitions, Lilydale HS), both `spc=1` with a
roster of 17, both credited with an appearance by PlayHQ. Captured once at FINAL,
frozen, never re-asked. Named season, named games, current year.

**Jade Chow has gone private, and the investigation that followed was wrong.**
`probe-player` printed "API returned OK but no seasonStatistics". I read that as PlayHQ
returning an empty `seasonStatistics` ARRAY — truthy, so `parseProfileStats` succeeds
with nothing in it and `finishOk` DELETES all six career fields, empties every
registration, and writes every held game into `x`, silently, counted as a successful
write. A console capture Mark ran **disproved it**: `publicProfileStatistics` is
**NULL**, so `fetchProfile` returns `inaccessible` at L584 and `markNotObtainable` has
always preserved the capture and set `private: true`. **No file has ever been damaged
this way and no damage scan is needed.** The message came from `probe-player`'s own
`fetchProfile` having no null check (**T63**).

**Shipped anyway, honestly labelled: a zero-career guard** in `finishOk`, routed
through `markNotObtainable` rather than a second write path, firing only when the
parse yields a zero career and the file holds a non-zero one. Its comment states
plainly that it is defence on a path NOT shown to be reachable, and its counter is
documented in the script and the aggregate as **expected to stay at zero** — a
non-zero value means a response shape nobody has seen. An earlier version set
`private = false`, reasoning the profile had resolved; that is backwards and was
corrected before delivery. Six sandbox cases against her real file shape, including
one covering two lines I briefly deleted during the edit.

**The went-private-later gap, measured in the file rather than designed around.**
`nightly-crawl.js` **L1145** deletes `statsChecked` for EVERY player in a processed
roster and adds their shard to `needs-matrix-shards.json`. So a private player who
plays again is re-fetched within a day, returns null, and is marked private with their
capture intact — the stamp appears with no new code. A rolling age-based re-check
(~2,300 fetches a night at a 6-month rotation) was designed and **rejected** on Mark's
challenge: it would have paid for what the nightly already does. Residue logged as
**§2.24** — a player who goes private and never plays again keeps `private:false` for
ever, `--recheck-private` cannot find them since it only re-offers `private:true`, and
there is no offline signal for privacy.

**Two diagnostics were telling the wrong story and both are fixed.**
`probe-player.js` now separates three outcomes — null `publicProfileStatistics`
(private or unresolvable, with the page URL to check and a note that it is handled
non-destructively), absent `seasonStatistics`, and an empty array, which says outright
that the shape has never been observed and to record the uuid. Executed against all
four response shapes. `fetchPublicProfileName`'s null reason asserted
`id not on account tenant`; the same console capture shows a private profile returns
null there too, so it now names both causes and says the call cannot separate them —
fixed in `fetch-profile-stats.js` AND `seed-missing-profiles.js`, which carries the
same block and is the one part of that file that runs.

**Log ids moved from 8 characters to `TRUNC_LEN`.** Fourteen instances across the two
scripts, all inside template literals, none a comparison or a key. 8 is a form nothing
is stored under; 13 is what `p[]` rosters and `players/aliases/` keys use, so an id in
a log can now be searched for in the data. The constant is imported, never written
literally. Separately confirmed NOT a bug: `probe-player.js` L316's 10-character scan
runs only AFTER the 13-character test has failed, so it catches a full 36-char roster
id — the compensating fallback for T37, not an instance of it. I called it dangerous
before reading the four lines above it.

**Delivered:** `scripts/fetch-profile-stats.js`, `scripts/seed-missing-profiles.js`,
`scripts/probe-player.js`, `.github/workflows/fetch-profile-stats-matrix.yml`,
`OUTSTANDING_TASKS.md` (§2.22 closed, §2.24 added). New trap **T63**.

### 6.42 · 2026-09-11 (fourth) — 591 empty shells, and three wrong diagnoses before the right one

**The measurement.** `count-stats-checked.js` was extended to census `players/` for
files holding a non-zero `gp` with an EMPTY `games[]`. Across **418,512** players:
**591 shells**, holding **11,678** games played between them. Of those, **422** have
every game PlayHQ credits them already held in `games/bv` with a non-empty roster,
**159** have most of them, exactly **1** is a genuine capture gap, **9** are
unclassifiable. It also established **zero blind spot** — every player has been
fetched since `c` shipped on 2026-09-01, so `c` covers the whole database — and
**zero shells carrying `apiId`**, which is what `fold-diverged-players` acts on.

**Three diagnoses were wrong before the fourth was right. All three are recorded
because each was stated with more confidence than the evidence carried.**

1. **"PlayHQ serves the same statistics under both uuids."** Asserted from one
   number matching. Mark asked "does it, though" — and it does not: 11fdc0c2
   returns a null `publicProfileStatistics` while 692caea1 serves a full career.

2. **"The two are one person split across two files; write `apiId` and let the fold
   merge them."** This ran straight into a decision made on **2026-08-26**, found by
   searching past chats only after Mark said to: *"I explicitly told you that two
   separate profiles = 2 records in our system. why are you still looking to merge
   these??"* — Sage Horn. A merge had already been refused on this shape.

3. **"Use a same-name test to stop a `c`-driven append duplicating someone."**
   Refused outright, and rightly: a name test is what produced the Jida
   McCrae-Cooper error, and **T40** says a name test cannot settle a case caused by
   a name collision. The uuid evidence — `games[]`=0 against `games[]`=372 — was
   already sufficient and had been walked past.

**What it actually is, established from PlayHQ's canonical record.** Mark pasted
`discoverGame` for game `f4a62985`. PlayHQ's own team sheet, away #4: participant
`8b8af34a`, **profile `692caea1-e6dd-4f4b-afc2-b33cf15601bc`**. Our `p[]` for that
game holds `11fdc0c2-2994`. So `692caea1` is the API-namespace PROFILE id — the id
PlayHQ puts on its team sheet — and `11fdc0c2` is a SPECTATOR-namespace id. **Not
two profiles. One person across two namespaces**, which `players/aliases` exists to
absorb. And the alias reads `"11fdc0c2-2994": "11fdc0c2-2994-413c-9f5c-f123ef521fd0"`
— **it points at itself**. The spectator id was registered as a player, a file was
created under it, and `build-player-games` routed every appearance there.

**So the Sage Horn rule is untouched and this is a different fault.** Two genuine
profiles still mean two records. Here there is one profile plus an identity alias
that should have been a mapping.

**A "Private Profile" page is not evidence of privacy.** Mark: PlayHQ renders it for
ANY unrecognised uuid. This retroactively removes the cause claimed by §6.41's
zero-career guard comment, which has been corrected — `private = true` is still the
right FLAG (we cannot obtain statistics and must not delete what we hold) but the
CAUSE is open: privatised, deleted, or wrong namespace, and nothing in
`fetch-profile-stats.js` can separate them.

**Delivered: `scripts/find-shell-aliases.js` + workflow.** Read-only and offline.
Finds the file holding each shell's credited games by ROSTER FREQUENCY — each roster
id scored by the share of the shell's credited team sheets it appears on, with a
margin over the runner-up as the sibling guard — then classifies the alias on that
holder: identity alias (the proposed repoint), points elsewhere, or none. An earlier
version required the holder on EVERY team sheet; across 582 shells that confirmed
ZERO, because one frozen partial capture empties an intersection. Executed against
all four shapes; a permanent teammate correctly came back ambiguous until the
fixture was changed to rotate teammates as real ones do.

**`find-shell-counterparts` was deleted rather than kept** — it asked whether the
careers matched, and the answer was a red herring: every pair differed by exactly
one game, because the shell had been fetched more recently than its counterpart.

**No `discoverGame` clone was written.** `GV_QUERY` in `discover-game-backfill.js` is
a 10KB single line with session renewal, 429 backoff and a measured concurrency of 5.
Transcribing it is how a partial query breaks silently (house rule). If the API
confirmation is wanted it belongs as a mode inside that script.

**`TOOLING.md`** gains `find-shell-aliases.js` (§2.2) and `find-shell-aliases.yml`
(§3.3), both in alphabetical position.

**Nothing was written to players/, players/aliases/ or games/bv in this session.**

### 6.43 · 2026-09-11 (fifth) — confirmed in a second association, and the repair turns out to already exist

**Second confirmation, different association, two independent routes.** Mackenzie
Wurfel. PlayHQ's canonical record for game `f3ba6c75` (Bellarine, Wildcats U16 Girls
Green, #1) names participant `5a977ac2` with **profile `0722240b-e5e7-467a-bc44-
72d61bb0018b`** — the SHELL, not the holder `2e9151e6-edfa`. And `0722240b`'s own
profile page serves a live career of **466 games / 2369 points**, matching our
stored `gp` of 466. Jade Chow was the first, in a different association, via game
`f4a62985`. Two players, two associations, same answer.

**`find-shell-aliases` run across 582 shells:** 27 identity-alias proposals, 1 alias
pointing elsewhere, 0 with no alias, 42 ambiguous, 29 without a strong holder, 482
with too few held games to test, 1 genuine capture gap. In every one of the 27,
`gp` equals the credited count exactly and the holder sits at 94-100% of the team
sheets.

**A defect in that tool, found by using it.** The report carried no game ids, so
checking a proposal meant hunting through PlayHQ for a game — and a game found that
way may not even be in the shell's `c`, which weakens the thing it was meant to
prove. Each proposal now carries three `sampleGames`, all from the shell's credited
list AND held by us, with one printed in the console table.

**THE REPAIR ALREADY EXISTS AND I HAD PROPOSED BUILDING IT.** Earlier in the session
this was framed as two steps — repoint the alias, then somehow remove the leftover
file. Reading `fold-diverged-players.js` rather than guessing: its header L15-23
says a file carrying `apiId` is MERGED into `players/{apiPrefix}/{apiId}.json`, the
old file is **DELETED**, `moveIndexEntry` moves the search-index entry, and
`repointAliases` (L283) rewrites every alias value that pointed at the deleted file.
Idempotent. The whole repair, in a tool that has run before. The only thing missing
for these pairs has always been the `apiId` field.

**Delivered: `scripts/set-shell-apiid.js` + workflow.** It writes exactly one field
and nothing else. Dry run by default, `--only=<shell uuid>` for a single case,
`data-write` concurrency, per-path staging, commit left to the workflow so a staging
failure is visible before anything is recorded.

Five refusals, each a gate rather than an error: holder alias does not point at
itself, holder has no alias entry, holder already carries an `apiId` (never
clobbered — a mid-flight fold must not be redirected), holder holds no games, shell
has no file. Plus the scoring gates, `top-share` and `margin`.

**Verified by execution.** Dry run refuses the three constructed refusal cases and
proposes only the valid pair. Applied: the holder file differs from its backup by
`apiId` ALONE, every other key byte-identical, still minified. A second `--apply`
run writes nothing and reports "already carries apiId".

**The report is advisory only.** Every pair is recomputed from the files on disk
before anything is written — the reason is recorded at `fold-diverged-players.js`
L97, where trusting a report made the 2026-07-30 repair fix 0 of 284 dangling
aliases.

**Known consequence, from the fold's own code.** Its merge keeper can delete
`statsChecked` on a tie-break (L652), which queues a re-fetch. Both sides here hold
identical stats, so that tie-break is the expected path — the pairs acted on will
ride along as extra profile fetches on the next matrix cycle. Expected, not a fault.

**Still open:** the 42 ambiguous and 29 weak shells are untouched, and no sample has
confirmed that the scoring picks the right holder for a shell whose sample game came
from the browser rather than from its own `c` list — Jade's did, Mackenzie's did not.

**`TOOLING.md`** gains `set-shell-apiid.js` (§2.2) and `set-shell-apiid.yml` (§3.3).

**Nothing has been written to players/, players/aliases/ or games/bv in this
session. `set-shell-apiid` has never been run outside a sandbox.**

### 6.44 · 2026-09-13 — a team with no games could not be viewed at all

**The report.** New teams for Summer 2026/27 are visible on PlayHQ. Discover Seasons
found the seasons, the matrix backfill (`backfill_teams=true`) wrote the
registrations into player files, `update-team-index` added 2,530 teams, and
`discover-fixtures --season=5e26f10f` enumerated **492 teams and 0 games** because
the draw is not published. A player's page showed the team; clicking it gave
**"Team not found"**.

**Where it actually broke.** Not the index. `data/team-index.json` held
`{"id":"fa6b5199","n":"U13 MMB08","sid":"5e26f10f","comp":"Junior Domestic",
"grade":""}` and Oscar Gleadow's file held the reg. StatTrack's team view fetches
**team-stats/bv/{sid}** (`index.html` L1652) and renders "Team not found" when the
tid is absent from it (L1654). `team-index.json` is only the SEARCH list.

**And team-stats could never contain it.** `build-team-stats.js`
`buildSeasonTeamStats` opened with `if (!fs.existsSync(gameFile)) return null;`, and
teams were only ever created by `ensureTeam` inside the games loop. No games meant
no file, and no file meant no team page — for every team in the season, not just
one.

**Fixed by sourcing teams and rosters from registrations.** A missing or unreadable
game file now means "no fixtures" rather than "no season". A new `buildRegTeamMap()`
walks player files once per run and builds `sid|tid -> { tn, club, uuids[] }` from
`seasons[].regs[]`; any tid in it that the games loop did not produce is created via
`ensureTeam`, and its roster is filled from those uuids alongside the existing index
map. `addPlayerToRoster` is already idempotent per uuid, so a player in both sources
is added once.

**Why not the index shards alone.** `buildSidTidPlayerMap` reads
`players/indexes/*.json` `history[sid] -> [tid]`, which carries no team NAME and
gives no guarantee a pre-season registration has reached it. A reg carries `tn` and
the season carries `club`, which is exactly what `meta` needs.

**Verified by execution.** A sandbox with one season holding teams and NO game file
at all, and one played season: the pre-season season now yields
`fa6b5199 { meta: { name: "U13 MMB08", club: "Kilsyth Basketball" }, fixtures: [],
roster: 2 }` — the shape `renderTeam` expects, and it already renders "No roster
data" gracefully for an empty one. The played season is unchanged: same team, same
fixture `W 40-30`, same roster stats.

**Cost.** One extra pass over `players/` per run, built once for the whole run, not
per season.

**Still open, and recorded rather than fixed:** `grade` on a pre-season team-index
entry is `""` because the reg has `gid: null, gn: null` — the season has no grades
yet. That compounds the existing note that the `grade` field in `team-index.json` is
ill-defined.

### 6.45 · 2026-09-13 — a 42% error rate reported as a completed sweep

**Found by chasing two missing children.** Team `fa6b5199` "U13 MMB08" in season
`5e26f10f` showed 6 players where PlayHQ shows 8. Alfred Brown (`67c94a1d`) and
Jude Smethurst (`549a84f5`) both have player files, both were probed in the
`all+backfill` sweep, and neither has season `5e26f10f` at all. Their
`teamsUpdatedAt` read **2026-07-09** and **2026-06-05** against a team-mate's
**2026-09-13T03:32**.

**The mechanism.** `discover-seasons.js` shard role: the cursor is POSITIONAL over
a sorted uuid list. A probe returning `kind: 'error'` was counted at L921 and
dropped — no delta, no name recorded — and the cursor advanced past it regardless.
`done` was `newCursor >= total` alone, so the shard reported complete, and the next
run resumed from that done marker and never revisited anyone.

**The rate is not marginal.** From the run logs: shard `3a` **313 errors in 750
probes (42%)**; shard `5e` 150/750, 199/675 and 54/238. So a fifth to two fifths of
every shard contributed no registration, on a sweep that reported 256/256 complete.
An `error` there is a TRANSPORT or GraphQL failure (L312-323) — a thrown fetch, a
non-OK status, unparseable JSON, a GraphQL error array. It is **not** "this player
has no teams", which returns `kind: 'ok'` with an empty list. The question was never
answered.

**Fixed: errored players are now retried, not skipped.** Failures are recorded as
`{ u, a }` with a running attempt count, written into the artifact as `errored`,
carried into `data/discover-progress.json` by the reduce, and read back by the next
map run for that mode. Probing runs in two phases: retries first, then the cursor
tail. **Retries never advance the cursor** — the cursor means progress through the
sorted list and a retry is not that. A wall during retries skips the tail entirely
rather than burning the budget on requests already being refused. And **`done` now
requires `newCursor >= total` AND an empty retry list**, so a shard cannot report
complete while players remain unasked.

**Bounded, so a broken profile cannot hold a shard open for ever.** After
`MAX_ERROR_ATTEMPTS` (5) a uuid is abandoned, excluded from further retries, NAMED
in the shard summary and recorded in `abandoned` — the opposite failure to the one
being fixed, and it is visible rather than silent. A uuid no longer present in the
shard (folded, deleted) is dropped from the retry list without blocking.

**Verified by executing the shipped blocks**, extracted verbatim from the delivered
file and driven by a stubbed probe: errors recorded with the cursor still advancing
and the shard not done; the next run retrying without moving the cursor and
completing the shard; the attempt count incrementing on a repeat failure;
abandonment at the cap with the shard free to finish; an already-abandoned entry
neither retried nor blocking; a departed uuid dropped; a wall during retries
skipping the tail; and `private` correctly treated as an answer rather than an
error. Eight of eight.

**Not yet known: WHY the rate is 20-42%.** That is far above ordinary transport
noise and may be rate limiting at concurrency 25. The retry makes the data recover
across runs; it does not explain the failures. The abandoned list is now the place
that would show a persistent cause.

**Also delivered this session:** `build-team-stats.js` now builds teams and rosters
from registrations when a season has no fixtures (§6.44) — without that, none of
these rosters could be viewed at all.

### 6.46 · 2026-09-13 — a targeted matrix dispatch silently became a full sweep from run 2

**Observed.** `discover-seasons-matrix.yml` dispatched with `shards=["54","67"]`
produced 2 map jobs on run 1 and **256 on every run after it**.

**Cause, in the retrigger step.** It deliberately did not pass the undone shard list
back — correct, and the comment explains why: `generate-shards` recomputes from the
committed progress file, and a shard can become undone again between runs, which a
snapshot would miss. But it passed **no `shards` field at all**, so the next run took
the default `'[]'` (L195), and `'[]'` means "every not-done shard for this mode". The
original targeting existed only on run 1.

**Fixed** by forwarding `inputs.shards` verbatim on retrigger. Safe for both cases
and it changes neither: a full sweep dispatches with the field empty, so `'[]'` is
carried and the recompute happens exactly as before; a targeted sweep keeps its list
until those shards drain. The recompute the original comment protects is untouched —
this only bounds which shards it may choose from.

**Second-order behaviour worth knowing, already in generate-shards (L48).**
`done_here = p.get('done') == True and p.get('mode') == mode and not toks` — the
`and not toks` means an EXPLICIT shard list **bypasses the done check**. So a
targeted dispatch always selects the named shards whether finished or not, and the
chain terminates on `reduce`'s `undone_shards` gate (L410) rather than on the done
markers. That is what makes a targeted run usable for re-probing a shard that is
already marked done — which is exactly the state `54` and `67` are in after the
sweep that dropped 20-42% of its probes (§6.45).

**Consequence to be deliberate about:** because the done check is bypassed, a
targeted run resumes from the STORED CURSOR. A shard sitting at cursor = total has
nothing left to probe and no `errored` list yet (that field only exists from §6.45
onwards), so the run completes having done nothing. `fresh_start=true` is required
on the first targeted dispatch to reset the cursor and re-ask every player with the
retry logic in place. After that first pass the retry list exists and ordinary runs
pick it up.

### 6.47 · 2026-09-13 — the targeted-dispatch fix looped, and the correct list was already being printed

**Observed on runs 175/176.** Shard `54` finished at cursor 1574/1574 with
`done=true`; the very next run restarted it from cursor 0. Meanwhile the reduce
printed `UNDONE_SHARDS_JSON=["67"]` — the right answer, unused.

**Two pre-existing behaviours, brought together by §6.46's fix.**
`generate-shards` L48 reads `done_here = p.get('done') == True and p.get('mode') ==
mode and not toks`, so an EXPLICIT shard list bypasses the done check and a finished
shard is re-selected. The map role then reads the stored cursor only
`if (p && p.mode === expectedMode && !p.done)`, so a finished shard resumes at 0.
Re-selected, then reset: it can never stay done. Before §6.46 the retrigger dropped
the shard list, so run 2 had no `toks`, the done check applied, and the shard fell
out — forwarding the original list verbatim is what closed the loop.

**Corrected: forward the UNDONE list for a targeted sweep, nothing for a full one.**
That is the option rejected in §6.46 on the grounds that a shard can become undone
again between runs and a snapshot would miss it. That objection holds for a FULL
sweep and not for a targeted one, where the set is already bounded by what was asked
for: a finished shard drops out, and the chain ends when the list empties — which is
also the retrigger's own `if:` gate (L410). An empty input still forwards `'[]'` and
`generate-shards` recomputes from the progress file exactly as before.

**Verified** by running the branch: `["54","67"]` with `["67"]` undone forwards
`["67"]`; `["54","67"]` with both undone forwards both; a blank input and a literal
`[]` both forward `[]` regardless of what is undone.

**Left alone deliberately:** the `!p.done` cursor gate and the `and not toks` done
bypass. With the undone list forwarded, a finished shard is never sent again, so the
reset cannot bite. A MANUAL dispatch naming a finished shard still restarts it from
cursor 0, which is a reasonable reading of "re-do this shard" — but it is a sharp
edge and is recorded here rather than assumed to be obvious.

### 6.48 · 2026-09-13 — the W/L/D column vanished for a team with no games, misaligning the card

**Reported from the app.** On a player's season list, a team that has played nothing
("Term 3, 2026 · Triple Trouble") rendered with its stat columns spread wider than
the rows above and below it.

**Cause.** The season header's W/L/D cell was wrapped in `${regW||regL? … :''}` —
with no wins and no losses it emitted NOTHING, so the flex row had seven children
instead of eight and the remaining columns stretched to fill. A pre-season team has
no wins and no losses **by definition**, so every one of the teams built by §6.44
would have rendered misaligned.

**Fixed on both sides of the mirror.** The header cell is now unconditional, showing
an em dash in `var(--text3)` when there is nothing in it — matching how PPG already
renders an empty value. And `padWld`, which the comment at L1551 describes as a
mirror of that same condition, was `!!((_hs?.wins)||(_hs?.losses))` and is now
`true`: the game rows underneath pad to their own header, so leaving it conditional
would have moved the misalignment rather than fixed it.

**Left alone deliberately:** the other `padWld` site (L1507) passes `false` to
`buildGameStatRow` for games with no registration. Those rows render without a
season header above them, so there is no W/L column to align to and the comment says
so. Unchanged.

**Verified by executing the shipped template** — extracted from the delivered file
and rendered with four inputs: 1W/4L, 8W/7L/1D, 0/0/0 and 0/0/2D. Exactly one
`sstat` cell in every case, the win-percentage sub-cell present in every case, and
the empty case showing the em dash.

### 6.49 · 2026-09-13/17 — StatTrack out of beta at v1.0

**Version.** `rail-ver` Beta 0.84 → **v1.0**. The string is a display span, not a
named constant, so it does not turn up in a search for "version" — it is at the
`.rail-ver` element. Bump it in the same commit as any StatTrack change: an
installed PWA caches, and the version in the UI is the only way to tell which build
a phone is running.

**What shipped in that run:**

**0.85 — W/L/D column alignment.** The season header's cell was wrapped in
`${regW||regL? … :''}` and emitted NOTHING when a team had no wins and no losses,
leaving the flex row with seven children instead of eight so every other column
stretched. A pre-season team has no result by definition, so every team built by
§6.44 would have rendered misaligned. The cell is now unconditional with an em dash,
and `padWld` — which its own comment calls a mirror of that condition — became
`true` so the game rows underneath pad to their own header.

**0.86 — the back button was a dead end on mobile.** Every `popstate` branch called
a loader, and every loader began with `history.pushState`. Back ADDED an entry
instead of consuming one: it could never reach home, `showV` never ran with
`view-home`, the rail kept `mob-hide`, and a refresh was the only escape. Loaders
now take `push=false` from the handler. Separately the two opposition views pushed
different state shapes under the SAME `'opp'` type while the handler read
`e.state.tid`, a key neither writes — now `'opp'` and `'teamopp'`, each read with
its own keys. Verified against all eight state shapes.

**0.87 — PWA install and deep links.** Manifest, icons and the iOS meta set copied
from `junior-footy-dashboard`'s proven pattern. `navigate()` now writes the hash as
well as the state (`p=`, `t=&s=`, `v=&vn=`, `o=&s=&f=`, `mo=&o=&s=`), and `boot()`
restores from it — so a link opens the view it was copied from and a refresh no
longer dumps you home. Share links always name `index.html`: a bare directory link
breaks when pasted into apps that append to the path.

**0.88 — the QR encoder was written, verified and REMOVED the same day.** A
byte-mode ECC-M encoder passed every check available offline — finder, timing and
alignment placement, format bits decoding back to ECC M with the chosen mask,
Reed-Solomon syndromes zero against independently built GF(256) tables, payload
round-tripping out of the de-interleaved data, across five payloads — **and would
not scan on a phone.** 274 lines removed, replaced with a static PNG.
**⚠️ None of those checks test what a real decoder rejects. Do not re-add a
generated QR without a scan test.** Consequence, stated in the sheet itself: the
SCAN opens the app, the COPIED LINK opens the exact view.

**0.89 — share copies on open.** Opening the sheet IS the share action; the button
is a retry. The copy runs inside the click handler, which is what keeps it inside a
user gesture — moving it behind an await or a timeout would make the browser refuse
it. Falls back to selecting the URL text where there is no clipboard API.

**0.90 — in-app help, 22 entries across six sections.** Pattern taken from
`junior-footy-dashboard` (2026-09-17 handover): one array, `tip` for hover/tap and
`body` for the panel, in the same object so a term cannot be explained two ways.
`statCell` turned out to be the single choke point for every stat label in the app,
so marking GP/PPG/PTS/FG/FT/3PT/F as tap targets was ONE edit. Content is
StatTrack-specific and written for what people misread: GP differing from the games
listed under it, a `Player #` name being the player's own privacy setting rather
than missing data, a pre-season team whose zeroes are genuinely zero, FG+FT+3PT not
summing to PTS, and a zero in 3PT or F usually meaning the grade does not record it.

**Twenty checks, and two worth recording.** One failed for real and it was the
FIXTURE: `innerHTML` destroys the old nodes in a browser so a stale highlight cannot
survive, but the fake DOM kept the same objects — the fixture was changed to model
the destruction rather than the assertion weakened. And the red check the handover
insists on was done: reintroducing the unknown-id bug produced
`data-help="nope" title="undefined"` and turned two assertions red.

**Not a service worker.** StatTrack has none and offers to install. Chrome removed
the service-worker requirement for installation from the menu in version 108 on
mobile and 112 on desktop; the automatic prompt still wants one, so install-from-menu
working while no banner appears is expected rather than a fault.

**⚠️ v1.0 IS A DECISION, NOT A CLEAN SHEET.** Four items named as beta blockers on
2026-09-13 remain open and are listed in OUTSTANDING_TASKS: the unexplained 20-42%
probe failure rate (§2.25), three named tie cases among the empty shells (§2.26),
five `manual-alias-decisions.json` entries still at `decision: null`, and
`lock_after_months` still set from instinct. Shipping 1.0 does not close them.

### 6.50 · 2026-09-17 — every venue, every date, "? vs ?"

**Reported.** The venue day grid showed `? vs ?` for every game at every venue on
every date, while the competition and grade line beside it rendered correctly.

**Not a data problem.** `update-venue-lookup.js` writes each entry as
`{id, t, hn, an, hid, aid, sid, comp, grade, st}` — the names are there, as `hn`
and `an`.

**StatTrack's `teamNames()` could not see them.** It handled two shapes and gated on
the team id rather than the name:

```js
if(g.h) return[g.hn||'', …];      // games/bv shape
if(g.t1)return[g.t1n||'', …];     // alternate games shape
return['','','',''];
```

A venue entry has neither `h` nor `t1` — its ids are `hid`/`aid` — so every entry
fell through to the empty case. The grade line rendered because it is read directly
off the entry rather than through this function, which is why the rows looked
half-populated rather than blank and made it look like missing data.

**Fixed** by adding the third shape, keyed on the names or ids being present at all
rather than on one specific id field. Seven cases executed against the shipped
function: the real venue entry, both pre-existing shapes unchanged, a genuinely
empty entry still blank, one side named only, and ids without names.

**Version v1.0 → v1.0.1.**

**Worth noting for the future:** three call sites now write three different game
shapes and one reader has to know all of them. If a fourth appears, the reader is
where it breaks, and it will break silently — returning empty rather than throwing.

### 6.51 · 2026-09-17 — a moved player appears on BOTH teams, and a manual rebuild chain

**The question.** Players have been moved between teams for the upcoming season.
When does the app catch up?

**Timing.** `discover-seasons-matrix.yml` runs Sunday 20:00 UTC with
`backfill_teams=true` on a scheduled run; the nightly at 15:00 UTC then rebuilds
team-stats and team-index and the terminal builds publish. So one to eight days.

**But the move is only half applied, and this is the finding.** The reduce's
delta-apply loop (L762-784) calls `upsertReg()`, which matches on `(tid, gid)`,
updates names on an existing row and **pushes a new row otherwise. It never removes
one.** Nothing else in the reduce prunes. So the new registration is added and the
old one stays, `build-team-stats` builds rosters from those registrations, and the
player is listed on BOTH teams indefinitely.

**Pruning is NOT safe by default and was not added.** Registrations come from two
sources: this backfill, and `nightly-crawl.js` writing them from games. A player who
filled in for another team once has a real registration that `publicProfileTeams`
may not list, so a naive prune against the API answer would delete a genuine
appearance record. Any prune needs a guard — plausibly limited to regs carrying no
`stats` and no `gid` — and it is Mark's decision, not an initiative.

**Delivered: `.github/workflows/refresh-rosters.yml`.** Runs the derived-data
rebuilds in order on demand: `update-team-index` (the SEARCH list) then
`build-team-stats` (the TEAM PAGE) then a Pages dispatch. Doing only one of the
first two leaves a team that can be found and not opened, or opened and not found —
they are different files written by different tools.

`update-team-index` defaults to `--all` here rather than its usual 2-day window: that
window filters on player-file mtime, and a sweep running longer than two days leaves
its earliest shards outside it.

**The discovery sweep is deliberately NOT in the chain.** It self-retriggers across
many runs over hours, so a job waiting on it would hit the timeout. `sweep_first`
dispatches it and stops, with the log telling you to re-run without the flag once it
drains.

`data-write` concurrency, per-path git handled by the scripts themselves, dispatch
helper copied verbatim from `fetch-profile-stats-matrix.yml`, and `publish` gated on
`needs: team-stats` succeeding so half-built data cannot go live.

### 6.52 · 2026-09-17 — pre-season registrations are pruned when a player moves team

**The fault (§6.51).** `upsertReg()` inserts or updates and never removes, and
nothing else in the reduce pruned. A player moved between teams before a season
started kept BOTH registrations for ever, and `build-team-stats` listed the child on
both teams.

**Fixed, for pre-season only, behind TWO guards.** In the delta-apply loop: a
registration is removed only when

1. **the team is absent from PlayHQ's current answer** for that season, taken from
   the deltas produced by `publicProfileTeams` on THIS run — a season with no deltas
   is never touched, so a player who errored or was not probed cannot lose anything;
   and
2. **the row carries no `stats` and no `gid`.**

Guard 2 is what makes it safe rather than merely plausible. That combination is
exactly a pre-season allocation: no grade, no game. **A fill-in appearance always has
one or the other**, because `nightly-crawl.js` writes registrations from games with
the grade on them — so a genuine appearance that `publicProfileTeams` happens not to
list cannot be deleted. Without guard 2 the prune would erase games people played.

Every removal is counted and the first 25 are NAMED in the reduce log, with the team
left and the teams now held. `--no-prune` disables it; it is on by default.

**Eleven cases executed against the shipped block**: the move itself; a reg with a
grade surviving; a reg with stats surviving; a season not probed this run untouched;
two legitimate current teams both surviving; nothing stale leaving the file
unmodified; the flag disabling it; a delta carrying no tid pruning nothing; and a reg
with no `stats` key at all being prunable.

**And the red check.** Removing the grade guard — `if (!noStats) return true` —
turned "a reg WITH a grade is never pruned" red, with the fill-in deleted. The
fixture is not decoration.

**In-season moves are NOT handled** and are logged as §2.30. Those rows carry a
`gid`, so guard 2 excludes them by design. They need a different test and carry more
risk, because a graded row is one game away from being real.

### 6.53 · 2026-09-17 — a SKIPPED job is not a CANCELLED one

**Observed on the first dispatch of `refresh-rosters.yml`** with `sweep_first`
ticked: `sweep` ran and `team-index` correctly skipped, and then **`team-stats` ran
anyway** and `publish` queued behind it.

**Cause.** `team-stats` was gated
`if: ${{ !cancelled() && needs.team-index.result != 'cancelled' }}` — copied from
`weekly-indexes.yml`, where every job is meant to run and that guard only protects
against a cancelled predecessor. Here one branch is supposed to skip ENTIRELY, and
**a skipped job is not a cancelled one**: `!cancelled()` was true and
`team-index.result` was `'skipped'`, so both terms passed.

**Consequence.** A dispatch whose only job was to start the sweep rebuilt team-stats
from PRE-SWEEP data and held the `data-write` lock for up to six hours while the
sweep it had just dispatched was writing registrations. Not destructive — it writes
the files the nightly writes — but it publishes stale data and contends for the lock.

**Fixed by gating on the INPUT, not on the upstream result.** The input is what
decides which branch a dispatch is; a job result cannot express "the other branch was
chosen". `team-stats` now tests `sweep_first` directly and excludes both `'cancelled'`
and `'skipped'`; `publish` tests `sweep_first` too, since without it a step-1
dispatch published whatever happened to be on disk.

**Verified by evaluating every job's `if:` for both dispatch shapes**, modelling
GitHub's boolean-versus-string comparison (directive 13): step 1 runs `sweep` alone,
step 2 runs the other three, and `team-stats` refuses to run when `team-index` is
either skipped or cancelled. The first harness written for this was itself broken and
reported errors on every condition — fixed rather than worked around.

**Input labels rewritten.** They described what the code does ("Dispatch the
discovery backfill and STOP") rather than what the operator is doing. Now "STEP 1 —
start the PlayHQ sweep and stop here" and "STEP 2 — …" on the other three, so the
form reads as a sequence rather than four unrelated switches.

### 6.54 · 2026-09-29 — TenantConfig refused; the bootstrap query was the difference

**Symptom.** `nightly-crawl` and `discover-org-seasons` failed every run with
`HTTP 403, NO set-cookie, CLOUDFRONT-BLOCK (919b HTML)` on all ten session attempts.

**Three wrong diagnoses before the right one, all mine, all from reasoning on
fragments instead of reading:**

1. *"The runner image changed."* Ruled out by Mark: the `Image:` and `Version:` lines
   are byte-identical between a working and a failing run.
2. *"The Actions IP range is blocked."* Ruled out by the run list: `Discover fixtures`
   #40 ran for 1h02m against the same API at 10:01, and six `Fetch Profile Stats`
   runs succeeded the same morning.
3. *"Everything is coasting on a cached cookie."* `discover-fixtures.js` does cache
   one in `cookie-${TENANT}.json` for five hours — **but the file is not in the repo
   and never has been**, so nothing was coasting. Stated confidently and wrong.

**The actual difference is the BOOTSTRAP QUERY**, and the evidence is behavioural:
   WORKED  `discover-fixtures.js`, the profile matrix — `ProfileSearch`, only that.
   FAILED  `nightly-crawl.js` — `TenantConfig`, ONLY that.
   FAILED  `discover-org-seasons.js` — `TenantConfig` first, then `ProfileSearch` on
           the same keep-alive connection, and **both** refused.

Nightly Crawl #117 is the clearest single data point: `crawl` failed the session ten
times, and the `profile-stats-matrix` it dispatched went **green** minutes later
against the same API. That the third script's `ProfileSearch` also failed, while the
same query succeeded elsewhere in the same minutes, is why the first refusal marking
the connection is the likelier reading than `ProfileSearch` being broken.

**Fixed** by bootstrapping with `ProfileSearch` first in both scripts, copied from the
implementation that was working that morning. **`TenantConfig` is kept as a fallback
rather than deleted** — the evidence is behavioural, PlayHQ may change it back, and a
query that stops working is not a query that is wrong.

**The cookie shape is not assumed.** `nightly-crawl` needs `phq_tier`, `phq_session`
and `phq_sub` BY NAME while `discover-fixtures` joins whatever returns; a different
operation may not yield the same three. The named extraction is tried first and the
joined form is the fallback, and the log states which was used.

**Six cases executed against the shipped loop**: named cookies accepted from
`ProfileSearch`; the joined fallback when the named set is absent; `TenantConfig`
still reached when `ProfileSearch` yields nothing; a throw after ten attempts having
tried both queries on each (20 calls); and a transport exception falling through to
the next query rather than aborting.

**⚠️ THE THEORY WAS WRONG AND THE NEXT RUN PROVED IT.** Both queries failed. Two
things came out of finally reading `doFetch` rather than reasoning around it:

- **It RESOLVES ON ANY STATUS** — `{status, rawCookies, body, rawText}`, no throw for
  a 403. `refreshSession` read only `rawCookies`, so a CloudFront block page was
  reported as "no set-cookie". The failure LOOKED different after a change that had
  not altered it at all, which is precisely how the reordering came to seem worth
  trying. The bootstrap now logs `HTTP <status>` and the first of the body, matching
  what `discover-org-seasons.js` already printed. Four cases tested: a CloudFront
  403, a 200 carrying no cookie, an empty body, and success staying quiet.
- **Every request builds `new https.Agent({ keepAlive: false })`** — a fresh
  connection per call. So the "first refusal marks the connection" reading was never
  possible for this script, and I should have known that before writing it down.

The reorder is kept: harmless, `ProfileSearch` demonstrably worked elsewhere that
morning, and `TenantConfig` remains as a fallback. But it is NOT the fix.

**THE FIX IS THE TRANSPORT.** With the logging in, the failure is confirmed as
`HTTP 403 … CLOUDFRONT-BLOCK (919b HTML)` on both queries, while
`discover-fixtures.js` kept working against the same API from the same runner in the
same minutes. The one remaining difference between them:

  · `discover-fixtures.js` bootstraps with **`fetch()`**.
  · `nightly-crawl.js` used **`https.request`**, with its own
    `new https.Agent({ keepAlive: false })` and a hand-set `content-length`.

Same URL, same five headers, same query — **different client, therefore a different
TLS and HTTP fingerprint on the wire**, which is what a CloudFront WAF rule keys on.
That is the same class of cause as this repo's standing rule that
`actions/setup-node` must never appear in a job fetching `api.playhq.com`: it changes
the runner's outbound fingerprint and draws 403s on every request. The rule was
written about the runtime; this is the same idea one level down, in the client.

`sessionFetch()` now obtains the session with `fetch()`, copied from the working
implementation rather than approximated. Seven cases tested: the URL, the five house
headers, a `request-id` added, **no hand-set `content-length`**, cookies returned as
an array from `getSetCookie()`, the joined-header fallback for older runtimes, and a
403 with no cookie yielding `undefined`.

**AND IT DID.** The next run: `Session refreshed (attempt 1, ProfileSearch)`, then
`[P1 grades] burst 1: ok=0 empty=0 blocked=25`. Every real call through `doFetch`
refused, with a session in hand. **The refusal follows the CLIENT, not the endpoint
and not the credentials.**

**`doFetch` is now built on `fetch()`.** Signature and return shape unchanged —
`{ status, rawCookies, body, rawText }` — so no caller was touched, and `sessionFetch`
was collapsed onto it rather than left as a second implementation to drift. The
`https.request` path, its `new https.Agent({ keepAlive: false })` and the hand-set
`content-length` are all gone; the comment says not to put them back, because they
are what was being blocked.

Thirteen cases tested: JSON parsed, status returned, cookies as an array from
`getSetCookie()` with the joined-header fallback, `undefined` when there are none,
POST with a string body, caller headers preserved, a fresh `request-id` per call, NO
hand-set `content-length`, a 403 resolving rather than throwing with the block page
kept in `rawText`, and an unparseable body yielding `body: null`.

**Connection reuse is the one behavioural change.** The old agent disabled keep-alive
explicitly; `fetch()` pools. `discover-fixtures.js` has run that way at concurrency 40
without trouble, but if a future block looks connection-shaped rather than
request-shaped, that is the first thing to revisit.

**Four wrong theories preceded this one** — runner image, IP range, bootstrap query,
keep-alive poisoning — and each was proposed before reading the code that would have
settled it. `doFetch` resolving on any status, and building a fresh agent per
request, were both one `sed` away the whole time.

### 6.55 · 2026-09-29 — the same transport fault in discover-org-seasons

**`nightly-crawl` works after the `fetch()` rewrite; `discover-org-seasons` still
failed.** Expected: the earlier change there only reordered the bootstrap queries. It
had its own transport and it had never been read.

**Same fault.** `doFetch` there was a SHIM mimicking fetch's interface — `status`,
`ok`, `headers.get()`, `text()`, `json()` — over `https.request`, with its own
`new https.Agent({ keepAlive: false })` and a hand-set `content-length`. Because the
shim already presented fetch's own interface, `const doFetch = (url, options) =>
fetch(url, options)` is a drop-in and no caller changed.

**A latent cookie fault fixed on the way past.** The session read
`res.headers.get('set-cookie')` and split on `,` — and a cookie carrying
`Expires=Wed, 01 Jan 2027 …` splits in the middle of its own date. It never bit
because the shim joined with `', '` too, so the same wrong assumption sat on both
sides. Real `fetch` exposes `getSetCookie()`, which returns each header separately;
that is now preferred, with the joined header kept as a fallback and the split
widened to newlines as well as commas.

Four cases tested: the array form with a comma inside `Expires`, the joined-header
fallback, no cookie at all naming the CloudFront block page, and cookies present but
without the `phq_*` names reporting which names were seen.

**The rule this establishes, and it is broader than one script:** a PlayHQ 403 that
survives a correct header set, a correct query and a known-good runner is about the
HTTP CLIENT. `https.request` with a hand-set `content-length` is refused;
`fetch()` is not. The standing rule about `actions/setup-node` says the same thing
about the runtime — this is that idea one level down.

### 6.56 · 2026-09-29 — three scripts converted, and the theory that justified it does NOT hold

**What happened.** `nightly-crawl.js`, `discover-org-seasons.js` and
`recheck-private-profiles.js` all failed every session attempt on 28-29 September
with `403 CLOUDFRONT-BLOCK`. All three were converted from `https.request` to
`fetch()`. **All three now work.**

**⚠️ BUT THE EXPLANATION IS WRONG, AND THIS ENTRY EXISTS TO SAY SO.** An earlier
version of it claimed the client was what CloudFront keyed on, listed 30 more files
carrying "the same latent failure", and said each would die in turn. Mark pointed out
the thing that breaks it: **`fetch-profile-stats.js` runs the nightly matrix on
`https.request` every day and never failed once during those two days** — same host,
`api.playhq.com/graphql`; same five headers; the same hand-set `content-length`; the
same `new https.Agent({ keepAlive: false })`. Byte-for-byte the pattern that was
supposedly being refused.

So either the rule is narrower than "the HTTP client" — request rate, burst shape or
connection count are the obvious candidates, and the three that failed are all
burst-heavy openers (5,534 grade lookups; 186 organisations) while the matrix spreads
its work across 256 shards — or the three recoveries are COINCIDENCE with a block
lifting after two days. **Both fit the evidence and nothing here separates them.**

**What was actually established**, as opposed to inferred:
  · the failures were real, reproducible across retries, and identical in three scripts;
  · the runner image was byte-identical between a working and a failing run;
  · the IP range was not blocked — other scripts hit the same API in the same minutes;
  · the bootstrap QUERY was not it — both `ProfileSearch` and `TenantConfig` were refused;
  · keep-alive poisoning was impossible — the old agent disabled pooling per request;
  · `fetch()` works and `https.request` worked too, in a different script, concurrently.

**THE REMAINING 27 FILES ARE NOT BEING CONVERTED.** That would be 27 edits to working
code, each a chance to break a contract, justified by reasoning the profile matrix
contradicts. If a fourth script fails this way, convert that one and record whether it
is burst-heavy — three of three would start to look like a pattern rather than a
coincidence.

**Kept from the conversions**, because they are improvements regardless of cause: the
session logging now reports `HTTP <status>` and names a CloudFront block page instead
of printing "no set-cookie" or rejecting with a bare JSON syntax error; cookies are
read via `getSetCookie()` rather than splitting a joined header on `,`, which broke on
`Expires=Wed, 01 Jan …`; and `recheck-private-profiles.js` still REJECTS on an
unparseable body, as its callers require, but the error now carries `.status` and
`.rawText`.

**⚠️ The shared comment is still wrong wherever it survives.** Fourteen files carry
*"wraps https.request with keepAlive:false … prevents CloudFront per-connection rate
limiting."* Nothing here supports that claim and the matrix contradicts the simple
version of it. Do not treat it as established.

### 6.57 · 2026-10-01 — team roster carries season AND career (v1.01)

**The gap.** The roster in `team-stats/bv/{sid}` holds THAT SEASON with THAT TEAM
only, so a roster row could answer "how are they going this season" and never "how
good is this player". On a pre-season team every number is zero and the page says
nothing at all.

**Each player now has two rows**: season on top as before, career beneath in a
smaller muted line, columns aligned because it is a sibling `<tr>` rather than a
second line inside a cell. Career comes from the player's own file — one fetch each,
cached in `S.players`, which is the SAME cache the player view uses, so opening a
player afterwards is instant and a second visit to the team costs nothing.

**Rendered progressively.** Season rows paint immediately; each career row shows `…`
and fills in as its file lands. A roster is eight to twelve players, most already
cached from browsing. The earlier worry about "fifteen fetches" was wrong twice over
— Mark pointed out the page already fetches for the head-to-head view, and a
basketball team is not fifteen players.

**Sorting re-emits both rows and re-hydrates**, which costs nothing because every
file is cached by then.

Seven cases tested against the shipped row builder: career read from a file, a
missing Basketball block yielding null, a cached player rendering both rows filled, an
uncached one showing the pending marker, the season row keeping the season numbers,
career PPG computed from career totals rather than the season's, and both rows
navigating to the player.

**VERSION FORMAT, set 2026-10-01: `vMAJOR.MINOR` with MINOR always moving in steps of
0.01 — v1.00, v1.01, v1.02.** Not `v1.1`, which this was briefly labelled, and not
three-part `v1.0.1`. One display span, `<span class="rail-ver">`, bumped in the same
commit as any StatTrack change.

**Next, agreed but NOT built:** the opposition view inverted — focus players at the
top expanding to their record against each opposition player, with the opposition's
roster below reusing this same two-row table. Tapping must still expand the
head-to-head detail, so the player-page link needs its own affordance rather than
stealing the row gesture.

### 6.58 · 2026-10-01 — the opposition view was inverted, and now shows the opposition (v1.02)

**Two faults, one screen.**

**It was listing the wrong team's players at the top.** The fixture-row handler called
`openTeamOpp(hTid(g2), aTid(g2), …)` — the HOME team as "my" team. Whenever the team
being viewed was the AWAY side, the whole view inverted: the opposition's players
appeared as the top-level rows with the focus team's players nested beneath them.
That is exactly what the "Vikings U13 B03 vs U13 MMB08" screenshot showed, with MMB08
as the team being viewed. `tid` — the team whose page the fixture row belongs to — is
the focus team by definition, so the sides are now chosen from it. Three cases
tested: focus is home, focus is away, and an unrecognised tid falling back to home.

**And it showed only past results.** Against a team you have never played — every
fixture in a new season — the page said "No completed meetings between these teams
this season" and nothing else. It could not answer "who are we playing".

**The opposition's squad is now listed beneath the head-to-head block**, using the
same two-row table as the team page (§6.57): season on top, career beneath, sorted by
points, hydrated from the player files already being loaded for the encounter
resolution — so no additional fetches.

**No tap conflict, which was the open design question.** Once the view is the right
way round, only the FOCUS player rows expand, to their record against each opposition
player. The opposition rows have nothing to expand, so they link straight to the
player view like any other roster row.

**Still to do on this screen:** the focus-player rows and the opposition squad are two
separately-built lists; the focus side could use the same two-row treatment for
consistency. Not done — the focus rows carry encounter data the roster table has no
column for, and merging them is a redesign rather than a tidy-up.

### 6.59 · 2026-10-04 — the PlayHQ session has a request budget, and the retry loop could not survive it

**Symptom.** Weekly Indexes ran **4h 45m on the FIRST of 378 seasons** and collected
nothing: `TeamFixture: HTTP 403` from team 240 onward, four retries each at five
seconds, then "giving up on this call" — for every remaining team.

**Not the fault chased last week.** `discover-fixtures.js` was ALREADY on `fetch()`,
so this is not the client. The cookie was obtained fine and 240 teams succeeded
before anything failed — the session was accepted and then stopped being accepted.

**It is a REQUEST BUDGET on the session, measured at roughly 290 calls.** On season
`7f7c13f5`: clean to team 280, 403; recovered; clean again to team 580, 403. Twice,
about 300 apart.

**Three faults in the script, each exposed by fixing the one before it:**

1. **`getSession()` was called ONCE, outside the retry loop.** All four retries
   replayed the same dead cookie five seconds apart. A refreshed session could never
   reach the retry that needed it. Fixed: cookie read inside the loop, and a 403 now
   calls `invalidateSession()` (which also DELETES `cookie-basketball-victoria.json`,
   or the five-hour file cache hands the dead one straight back) rather than retrying.

2. **That fix made it worse, and the log showed exactly why.** At concurrency 20,
   twenty callers hit 403, twenty invalidated, and twenty ran their own bootstrap —
   twenty "Fetching session cookie..." in a burst. **That burst is itself refused**,
   so the bootstrap returned `No Set-Cookie`, every caller retried in three seconds,
   and it never escaped. Fixed with a **single-flight promise lock** — the pattern
   `discover-org-seasons.js` has had all along — plus a real backoff on a refused
   bootstrap (20s, 40s, 60s) instead of three seconds.

3. **Reactive refresh costs two minutes.** A bootstrap inside the penalty window is
   refused, so all three backoff steps are consumed before a cookie arrives. Over 648
   teams that is two stalls; over 378 seasons it is hundreds. Fixed by rotating
   **proactively at 250 calls** — a refresh requested while the cookie still works is
   granted instantly. A cookie restored from disk is treated as spent, since its
   mileage is unknown and a 403 should not be how that is discovered.

**Result:** season `7f7c13f5` completed — 648 teams, **291 fixtures**, committed.

**`weekly-indexes.yml` concurrency 40 → 20**, now an input. 250 is tuned for ~20
calls in flight; at 40 the overshoot is twice as large and more calls land past the
line, which is the condition that produced the four-hour run. Raising it needs a
measurement, not an assumption.

**Still carrying the old concurrency:** every other script that sweeps PlayHQ in
bursts. None has the budget-aware session. They will hit this the moment their volume
crosses ~290 calls on one cookie.

### 6.60 · 2026-10-04 — the session budget in one place: scripts/lib/playhq-session.cjs

**Why a shared module.** The budget finding (§6.59) applies to every script that
sweeps PlayHQ, and the handling had to be written three times already — in
`discover-fixtures.js`, `discover-seasons.js` and now the two that matter most.
Each time it was the same bookkeeping around a different refresh. The next time
PlayHQ changes a number it should be one file, not thirty.

**What it owns and what it deliberately does not.** It owns the BOOKKEEPING: count
the calls, rotate at the threshold, rotate on age, and make concurrent callers share
one refresh. It does NOT fetch. Every script's `refreshSession()` differs — different
bootstrap queries, different cookie shapes (`nightly-crawl` needs
`phq_tier`/`phq_session`/`phq_sub` by name; `discover-fixtures` joins whatever
returns), different headers — and those stay where they are.

**⚠️ THE SINGLE-FLIGHT LOCK IS THE POINT, NOT A PRECAUTION.** Without it, N
concurrent callers each notice the threshold and each start their own bootstrap. That
burst is itself refused, so the bootstrap returns no cookie and the run never escapes
— observed live on 2026-10-04 as twenty "Fetching session cookie..." in a row
followed by `No Set-Cookie` on every retry.

**Wired into `nightly-crawl.js` (2 sites) and `fetch-profile-stats.js` (4 sites).**
Both previously refreshed only when holding NO cookie or after a 403 — i.e. they ran
until PlayHQ refused them, which is the expensive path. `if (!sessionCookie) await
refreshSession();` became `await sessionGuard.ensure();` at every site; their own
403 handling is untouched.

**Eight cases tested**: the first bootstrap serving 250 calls, rotation on the 251st
with the reason logged, twenty concurrent cold starts producing ONE bootstrap, twenty
concurrent rotations producing ONE refresh, age-based rotation, three concurrent
403-driven rotations producing one refresh, and a THROWING refresh not wedging the
lock. Plus a resolution test that the `./lib/` require path works from `scripts/`.

**Not yet converted:** `discover-game-backfill.js`, `spectator-backfill.js`,
`close-empty-seasons.js`, `repair-players-batch.js`, `seed-missing-profiles.js` and
the audits. They carry the old behaviour and will meet the budget when their volume
crosses it. `discover-fixtures.js` and `discover-seasons.js` have equivalent logic
inline and could be moved onto the module, but both are now proven in production and
are better left until there is a reason to touch them.

### 6.61 · 2026-10-05 — the client WAS the key; discover-seasons.js moved to fetch(), the matrix completed

**Where it stood.** Since 2026-10-04 the 256-shard player sweep could not start: every
shard's first request, from a cold session, came back `403 CLOUDFRONT-BLOCK`. The
handoff into this session carried the §6.56 ruling forward — "the client is NOT the
cause … do not re-litigate this" — and two measurement runs built on that premise
(count cookieless requests until refused, after an hour's silence) were both refused
on their FIRST request. Meanwhile the nightly took about fifty sessions overnight with
one refusal that cleared in ~45 s, and Discover Org Seasons went green at 09:11 three
minutes after a refused measurement at 09:08.

**The measurement.** `measure-playhq-limits.js --mode=compare`: one runner, three
cookieless requests ten seconds apart, same URL, same five headers, same user-agent.

```
  #1   0.8s  fetch()        ProfileSearch  HTTP 200  GRANTED
  #2  10.8s  https.request  TenantConfig   HTTP 403  REFUSED  CLOUDFRONT-BLOCK (919b HTML)
  #3  21.4s  fetch()        ProfileSearch  HTTP 200  GRANTED
```

PlayHQ was issuing sessions before and after the `https.request` bootstrap and
refused only it. The fleet had split the same way all episode: nightly-crawl,
discover-org-seasons, recheck-private-profiles (all moved to `fetch()` on 09-29) ran
clean; discover-seasons.js, the matrix shards built on it and the measurement tool's
own `https.request` modes were refused from cold. Close Empty Seasons, in §6.60's
not-converted list, failed on the Actions page the same morning.

**§6.56 was right on 09-29 and wrong by 10-04.** Its counterexample — fetch-profile-
stats running the matrix on `https.request` daily without a failure — was real on the
days it was observed. PlayHQ tightened again around 10-04 (§6.59 is the other half of
that tightening) and the same request shape has been refused since. §6.56's own rule
said: if a fourth script fails this way, convert that one and record it.
discover-seasons.js is the fourth, and the compare run is the record. **The standing
rule is now: a PlayHQ-fetching script on `https.request` with a hand-built header set
is expected to be refused from cold; when one fails, run `compare` once to confirm,
then paste in nightly-crawl.js's `doFetch` verbatim.** The 26 others are still not
being converted blind — but §6.56's "coincidence" reading is closed.

**What the shards did while refused made it worse, and is also fixed.** `await
ensureSession()` sat OUTSIDE the try in `probeTeams`, so a refused bootstrap REJECTED
the probe; `burstRun` logged "unexpected rejection", advanced the cursor past the whole
batch anyway, and the next batch asked for a session again — ten attempts over ~13
minutes each. The map job's 10-minute limit killed each shard around its seventh
cookieless request: no artifact, nothing to resume, next shard, same thing. 256
shards, 20 at a time, ~6-7 requests each, for the two-plus hours a run lasted —
roughly 13 cookieless requests a minute against the ~2 a minute the nightly's whole
crawl spends. Reproduced in a sandbox with PlayHQ stubbed to refuse: 60 players → 30
cookieless requests, cursor 0 → 60, `done=true`, "Players probed: 0", exit 0 (that
last outcome needs the job to outlive the retry loop, which the 10-minute limit
prevented for 403s, but a bootstrap that fails FAST reaches it in seconds — and the
same `completed = start + batch.length` line advanced the cursor past players never
asked).

**Second fault, standalone path.** `applyDiscoveries`' summary read `retryList`,
`retryDone`, `stillErrored`, `abandoned`, `newlyAbandoned`, `MAX_ERROR_ATTEMPTS` —
variables that exist only in the shard branch of `main`. Every standalone run that
probed anything threw `ReferenceError: retryList is not defined` AFTER its commit and
went red. Reproduced with `--uuid --dry-run`.

**Third, in the new guard.** Every caller that waited on a shared refresh then set
`calls = 1`: at concurrency 25 a "250" session carried 274 calls, at 40 it would carry
289 — the measured edge. And `rotateNow()` started a second refresh for any caller
whose 403 arrived after the first refresh had finished. Both measured side by side
against the 10-04 module; both fixed.

**Changes.**
- `scripts/discover-seasons.js`: nightly-crawl.js's `doFetch(url, bodyObj, headers)`
  pasted VERBATIM (returns `{status, rawCookies, body, rawText}`, never throws on 403);
  `require('https')` removed; the four call sites moved to that shape; cookie
  extraction takes undici's per-cookie array with the joined-header fallback split on
  `,`. Not a Response-shaped wrapper over `fetch()`: the hand-set `content-length` and
  per-request agent were what was refused and nothing of that shape survives. Inline
  session bookkeeping replaced by `lib/playhq-session.cjs` (same 250 / 15 min).
  A session failure is a typed result (`kind:'no-session'` / `{blocked, noSession}`),
  not a rejection; the first marks the source dead for the run; `burstRun` stops with
  the cursor unchanged and `noSession:true` in the artifact; `aimdRun` stops and names
  what it left; the standalone path exits 1 after its summary; reduce leaves grade
  resolution for the next run and still commits its player writes, and prints
  `NO_SESSION_SHARDS=n`. A refused bootstrap: SHARD mode stops at once (one cookieless
  request); standalone and reduce wait 15 min and ask once more, then fail. A rejected
  probe is recorded as an error. The five shard-only summary lines removed from
  `applyDiscoveries`. A thrown fetch clears `sessionPromise`.
- `scripts/lib/playhq-session.cjs`: the two counting fixes above.
- `scripts/measure-playhq-limits.js` + `.github/workflows/measure-playhq-limits.yml`:
  new. Its first workflow did a full ~7-minute checkout for one file, which pushed its
  first request into an overlapping cron run and wasted a measurement; now the sparse
  `scripts` form generate-shards uses. Its `bootstrap` mode first sent through
  `https.request`, so the matrix's canary refused a run whose shards had just moved to
  `fetch()`; `bootstrap` and `budget` now use the `fetch()` client and `https.request`
  exists only as compare's second leg.
- `.github/workflows/discover-seasons-matrix.yml`: canary in generate-shards (one
  cookieless request, `fetch()` client; refused → run stops with one request spent,
  not 256); `max_parallel` input, default 5 for dispatch, cron fallback and retrigger;
  reduce `if` requires generate-shards success; retrigger additionally gated on
  `NO_SESSION_SHARDS=0`.

**Result.** Shard 00 alone: 760 players in 0.5 min, four bootstraps, one new season.
Full sweep at `max_parallel=5`: run 1, 250/256 shards, 188,344 players, 3 new seasons
created, 0 session refusals, 5 wall hits stopping 6 shards at their cursors; run 2 (the
retrigger), those 6 resumed and finished — 190,874 / 190,874, progress file removed,
no third run. The 54 seasons at `grades:[]` refreshing to nothing is pre-season.

**Three readings this day killed.** (1) "The 10-15 minute penalty window" of §6.59 was
measured while discover-fixtures was itself re-bootstrapping into it; the nightly's one
refusal cleared within `attempt × 3 s` × 5 ≈ 45 s, and the compare run saw sessions
issued ten seconds either side of a refusal. (2) "A quiet hour" — the scheduled
workflows fire every 20-40 minutes; `compare` was built not to need one. (3) An
earlier version of this entry, before the compare run, named the matrix's own
cookieless load as the cause of the cold refusals. The load was real and is fixed, but
it was never why the FIRST request from a fresh runner was refused.

**Still open.** The profile-stats matrix has not been dispatched since the finding.
A repo code search for `https.request` lists the remaining candidates; Close Empty
Seasons is the first to look at. nightly-crawl.js never calls `rotateNow`: on a
non-WAF 403 it calls `refreshSession()` directly, which has no single-flight lock, so
concurrent expiry 403s can each start a bootstrap — one line, not yet changed.

---

## 6.62 — 2026-10-05 · THE CONVERSION §6.56 DECLINED AND §6.61 REOPENED: EVERY PlayHQ CLIENT NOW fetch()

**What was decided, and why it is not a re-opening of the question.** §6.56 ruled the HTTP
client out on 2026-09-29 and wrote "THE REMAINING 27 FILES ARE NOT BEING CONVERTED". That
ruling was correct on the evidence of that day: `fetch-profile-stats.js` was running the
nightly matrix on `https.request` without failing. PlayHQ changed the rule around 10-04.
§6.61 measured it — `measure-playhq-limits.js --mode=compare`, one runner, three cookieless
requests ten seconds apart, same URL, same five headers, same user-agent:

```
  #1      0.8s  fetch()        ProfileSearch  HTTP 200  GRANTED  session dde0882a
  #2     10.8s  https.request  TenantConfig   HTTP 403  REFUSED  CLOUDFRONT-BLOCK (919b HTML)
  #3     21.4s  fetch()        ProfileSearch  HTTP 200  GRANTED  session 2e671563
```

Nothing here re-opens that. This entry is the follow-through.

**What was converted — 44 scripts and one workflow.**

*The five scheduled scripts, first:* `close-empty-seasons.js` (already failing on its own
schedule, 3m 8s on 2026-10-05), `measure-credited-coverage.js`, `salvage-spectator-names.js`,
`seed-apiid-from-playhq-pairs.js`, `spectator-backfill.js`.

*The rest of the list:* `audit-aliases-against-playhq.js`, `audit-nonfinal-games.js`,
`audit-pending-games-vs-playhq.js`, `audit-removed-org-seasons.js`,
`census-wrongly-keyed-players.js`, `correct-wrong-aliases.js`, `diagnose-forfeit-game.js`,
`discover-game-backfill.js`, `fix-merge-aliases.js`, `probe-alias-credits.js`,
`probe-alias-names.js`, `probe-api-limits.js`, `probe-player.js`,
`probe-unresolved-aliases.js`, `recheck-forfeit-games.js`, `repair-player.js`,
`repair-players-batch.js`, `repair-season-names.js`, `repoint-aliases.js`,
`seed-missing-profiles.js`, `synthesize-missing-games.js`, `verify-players-against-playhq.js`.

*`scripts/fetch-profile-stats.js` WAS NOT ALREADY CONVERTED.* The 2026-10-04 handoff said it
was. It was not: it still held a live `https.request` client at L1549 and its two code-search
matches were that client, not comments. It is the nightly profile matrix. It is converted here.

*`.github/workflows/add-player.yml` DOES make a live PlayHQ call.* Not through a workflow
construct — through an inline `node --input-type=module` heredoc with `import https from 'https'`
and its own `post()`. It was the only live `https.request` left anywhere in `.github/`. Converted.

*Fifteen files NOT on the list were found by the same code search and converted too,* because
the task is "every PlayHQ-fetching script" and each of these is one: `diagnose-alias-conflicts.js`,
`probe-absent-games.js`, `probe-alias-stats.js`, `probe-both-resolve.js`,
`probe-discover-teams.js`, `probe-duplicate-profiles.js`, `probe-grade-ladder.js`,
`probe-missing-games.js`, `probe-notfound.js`, `probe-registrations.js`,
`probe-roster-sources.js`, `probe-session-throwaway.js`, `probe-wrong-rosters.js`,
`prove-player-files-intact.js`, `test-api.js`. Fourteen of those fifteen are recorded in
TOOLING.md §2.3 as "Removed 2026-09-11" and are still in the repository — see §2.5.

**Comment-only matches (file unchanged):** none on the list turned out to be comment-only.
Every file named above held a live `https.request` client.

**Left in place deliberately.**
- `scripts/measure-playhq-limits.js` — its `https.request` leg IS the comparison. Untouched.
- `scripts/diagnose-nightly-health.js` — its `https.request` goes to **api.github.com**, not
  PlayHQ. Not a PlayHQ client; untouched, and it is the only non-PlayHQ `https.request` left.
- The seven files §6.54–§6.61 already converted, `scripts/lib/playhq-session.cjs`, and both
  matrix workflows.

**How it was done.** nightly-crawl.js's `doFetch` was pasted verbatim into every file; it was
not re-implemented anywhere. Two client shapes existed:
- *(A) 22 files* already had `doFetch(url, bodyObj, headers)` returning
  `{ status, rawCookies, body, rawText }` — the same shape. A pure function-body swap; not one
  call site changed.
- *(B) 20 files* had a Response-like `doFetch(url, options)` with `.ok`, `.text()`, `.json()`
  and `.headers.get()`. Every call site was mapped per the §6.61 table: `res.ok` →
  `res.status >= 200 && res.status < 300`; `await res.text()` → `res.rawText`; `await res.json()`
  → `res.body` **plus an explicit `if (!json)`**, because the old client threw on a non-JSON body
  and the new one returns `null` — a parse failure must stay a failure, never "no data";
  `res.headers.get('set-cookie')` (one joined string) → `res.rawCookies` (an array), parsed as
  `(Array.isArray(raw) ? raw : [raw]).flatMap(c => c.split(',')).map(...)` so the joined-header
  fallback still works. `https.Agent`, hand-set `content-length` and `keepAlive:false` are gone
  from every converted file; `require('https')` was dropped wherever nothing else used it.

**Forced changes — every one of them, named.**
1. `repair-players-batch.js` lost its 45s IDLE timer. It existed because `https.request` sets no
   timeout and a socket that opens then goes silent never settles (2026-08-14: a run stopped dead
   at 5,752 of 10,000). `fetch()` exposes no socket to time, but undici's own headers/body
   timeouts (300s default) close that hole — later, not never. The 180s HARD ceiling is KEPT, as
   a `Promise.race` in a new `doFetchCapped()` wrapper that rejects with `code: 'ETIMEDOUT'`, so
   `fetchProfile`'s existing catch still reports `timeout` rather than `error`. The pasted client
   was not edited to do it. Its guards log line now says what is actually enforced.
2. `recheck-forfeit-games.js` and `diagnose-forfeit-game.js` lost a hand-rolled `timeout: 15000`
   for the same reason, and are NOT wrapped — they are single-game tools. Their old client also
   REJECTED on a non-JSON body; callers that tested `body.errors` now test `!body || body.errors`.
   Their `doFetch(bodyObj, extraHeaders)` signature became the canonical
   `doFetch(url, bodyObj, headers)` and a `const API_URL` was added.
3. `fetch-profile-stats.js` / `seed-missing-profiles.js`: `fetchPublicProfileName`'s `body` was a
   JSON **string**; it is an object now, because the pasted client stringifies.
4. `census-wrongly-keyed-players.js`: a comment asserting "this one uses https.request and
   returns rawCookies; that one uses fetch" was corrected — both now use the same client.

**Instrumentation added (§4c, logging only, no behaviour change).** 24 bootstraps logged a
silent `if (!rawCookies) continue;` — the 2026-09-29 gap, where a CloudFront block page was
recorded as nothing at all. They now log `HTTP <status>, NO set-cookie` plus the block-page
sniff, in nightly-crawl.js's shape.

**`scripts/nightly-crawl.js` — the one-line fix §6.61 left open.** It called `refreshSession()`
directly on a non-WAF (JSON) 403, in both `gqlMain` and `gqlSpectator`. That function has no
single-flight lock, so N concurrent expiry 403s on one dead cookie started N bootstraps — the
exact burst `lib/playhq-session.cjs` was written to stop, and a burst of bootstraps is itself
refused. Both now call `sessionGuard.rotateNow(why, gen)`, with `gen` captured from the
`sessionGuard.ensure()` at the top of the same function. **Measured, not argued:** five
concurrent expiry-403 `gqlMain` calls against a stubbed endpoint issued **11** cookieless
bootstrap requests before the change and **2** after. The WAF-403 path is untouched.

**What was verified, and how.**
- `node --check` on all 44 scripts and on the extracted ESM body of `add-player.yml`: clean.
  `add-player.yml` also parses as YAML.
- Token grep on all 44: no `https.request(`, no `new https.Agent`, no `'content-length'`, no
  `require('https')` outside comments. Repo-wide, the only live `https.request` calls left are
  `measure-playhq-limits.js` (compare's second leg) and `diagnose-nightly-health.js` (GitHub).
- **Executed**, with `globalThis.fetch` stubbed, in three scenarios — 200 + three `getSetCookie()`
  cookies; 403 on everything; and 403 only on cookie-bearing requests (so the bootstrap succeeds
  and the query is refused). For 40 of the 44: the bootstrap obtained a session and assembled
  `phq_tier=t; phq_session=s; phq_sub=u`; a query returned through the new shape with no
  TypeError; and the script's OWN classifier returned the verdict it returned before —
  `kind:'blocked'`, `status:'cloudfront-block'`, `403-retry-403`, `permanent:false` — never a
  silent empty. Under total 403 every bootstrap threw `Failed to obtain session after 10 attempts`:
  the failure stays explicit. Every stubbed request carried a `request-id` and none carried a
  `content-length`.
- Steps 1 and 2 only, no step 3, for: `probe-session-throwaway.js` (no `refreshSession` — its
  whole client lives in `main()`), `recheck-forfeit-games.js` and `diagnose-forfeit-game.js`
  (bootstrap + client exercised; their query call sites are inside `main()` and need the data
  tree), and `probe-api-limits.js` (its seeding path DID run end to end against the stub and
  printed `season abc123 "S": 0 grades`, then exited on an empty grade list as designed).

**Two unrelated findings, recorded and NOT fixed.**
1. `nightly-crawl.js` `main()` still calls `await refreshSession()` once at startup, outside the
   guard. `issuedAt` therefore stays 0 until the first rotation, so the 15-minute age rotation
   never fires on the FIRST session of a run — only the 250-call rotation does. Single-threaded
   at that point, so it is not the burst above; it is a gap in the age guard. Pre-existing.
2. TOOLING.md §2.3 and §3.4 record 26 scripts and 24 workflows as "Removed 2026-09-11".
   Fourteen of those scripts and thirteen of those workflows are still in the repository. The
   record and the directory disagree; §2.5 states what is on disk without re-classifying them.

**CONFIRMED AGAINST LIVE PlayHQ, 2026-10-05 04:00Z.** `Close Empty Seasons` dispatched
`--dry-run`. It had failed on its own schedule the same morning at 3m 8s, on `https.request`,
from cold. On the `fetch()` client: `Session refreshed (attempt 1)` — granted on the first
attempt — `CloudFront blocks absorbed : 0`, `0 retried`, final pace still at the 150ms floor,
assertions PASSED, index not written. That is the transport finding confirmed in production,
not in a sandbox.

The run's single `no answer` is NOT a refusal: season `19446969` carries `0gr`, so
`askPlayHQ()` returns at L344 (`no grades in the index to ask about`) before any request is
made. Nothing was asked and nothing was blocked.

**Unrelated finding from that run, recorded and NOT fixed.** `close-empty-seasons.js` ends an
incomplete run with `⚠ n season(s) unanswered — this run is INCOMPLETE. Re-run.` for all three
`answered:false` causes. Only two of them — `CloudFront blocked` and `grade lookup <kind>` — are
re-runnable. `no grades in the index to ask about` returns before the first API call, so
re-running cannot ever change it: that season will print the same warning on every future run
and will train the operator to ignore a message that otherwise means a real capture failure.
Whether a 0-grade COMPLETED season is closable on other evidence is a separate decision and is
NOT taken here.

**Still open.** The profile-stats matrix has not run since `fetch-profile-stats.js` was found
unconverted. That is the last outstanding piece of evidence.
