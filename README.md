# sports-players-stats

Player-centric database for PlayHQ basketball competitions. Builds a searchable database of every player across all Basketball Victoria competitions — career stats, season registrations, game results, venue data, and team registrations — served via the StatTrack HTML PWA at `markjovic.github.io/stattrack`.

---

## Current state (July 2026)

> **Updated 2026-07-29.** Counts are the 2026-07-16 audit unless noted. This file was materially out of date until then — it still described the api-canonical migration as unbuilt eleven days after it shipped. If a statement here conflicts with `REPO_MANIFEST.md` or `claude_context.md`, those two are authoritative and this file is the one to fix.

**Counts below are from the 2026-08-02 06:07 UTC audit** (search-shard figures are from the
shardKey-v2 rebuild later that same day). Date-stamped deliberately: this table previously carried
2026-07-16 figures with no date on it, so it read as current and quietly rotted for two weeks.
Re-run `db-audit.js` and update the stamp, or the same thing happens again.

| Metric | Value |
|--------|-------|
| Seasons (sports-index.json) | 3,227 (579 active / 2,648 locked at the 07-31 audit) |
| Player index entries | 412,100 |
| Player detail files | 412,100 | (1:1 with index entries, both ways — 0 orphans either direction)
| Total games (games/bv/) | 2,314,197 across 2,898 season files |
| Team-stats files | 2,898 |
| Leaderboard season files | 2,853 |
| Forfeit games | 26,470 |
| Unique venues | 536 |
| Search shards | 506 files / 724,407 keys (post 08-02 shardKey-v2 rebuild — was 641 incl. 135 two-month-stale orphans, since deleted) |
| Repo size | 6.13 GB / 527,900 files |
| Structural invariants | ✅ OK (256+256 shards, uuid==filename, index↔files 1:1, aliases consistent) |
| StatTrack | **Beta 0.68** live at `markjovic.github.io/stattrack` — and MIRRORED at the repo-root `index.html`, which Pages also serves; update both in the same pass (Mark maintains both copies). On the api-canonical contract (`player.private` boolean, alias-aware resolver, `TRUNC_LEN = 13`) — all three VERIFIED against the deployed file 2026-07-31. Recent releases: 0.62 renderMode legacy-vs-score; 0.63 season-leaderboard key guard; 0.64 winPct/lossPct decided-games denominator; 0.65/0.66 opposition h2h + prior lines; 0.67 normName v2; 0.68 search shardKey v2; **0.69 season-row regrade dedupe (per-stat MAX across same-tid siblings — never sum, T20); 0.70 Finals panel; 0.71 single-row layout (no Career repeat, "—" not fake zeros); 0.72 column-aligned with the career strip (`.cstat` is `flex:1`, so alignment IS cell-count parity — the finals row mirrors the strip's conditional cells with blanks); 0.73 client-side finals box-score hydration via `fetchBox(gid)` from the stored `finalsStats.gids` — zero storage cost, the 0.65/0.66 opposition pattern**. Runtime dependency: Pages must serve `players/indexes/` AND `players/aliases/`. **No open StatTrack work items (closed 2026-08-03).** |
| Nightly crawl | Active — cron 01:00 AEST daily |
| `discover-seasons-matrix.yml` | Active, self-triggering — season discovery + roster backfill (fixed 2026-07-09) |
| Namespace backfill | ✅ COMPLETE (2026-07-12/13) — ~81,806 un-indexed spectator ids → 0; ~40,330 collision mappings recorded to `reports/backfill-collisions/` as the migration seed (that directory has since been DELETED — cleanup 2026-07-16; the live inverse is `players/aliases/`) |
| Season-name contamination | ✅ **RESOLVED (2026-07-30/31).** 40,034 files repaired; the write bug is dead (`parseProfileStats` no longer derives names); the one straggler (a 34-day carrier re-written after the repair) was fixed by targeted forced re-fetch, and the defect that made a transient heal failure permanent is CLOSED — bounded name-heal retry (`nameHealAttempts`, cap 3, reset on success/`--force`), with db-audit in-flight/gave-up rows. Audit reads 0 contaminated. |
| `legacy` game flags | ✅ **FINAL STATE (2026-08-02): population is exactly 3, permanently** — all genuinely scoreless locked-season FINALs. 08-01 cleared 3,114 scored games; 08-02 cleared the remaining 139, which were `st=UPCOMING` future fixtures the dead classifier had mis-stamped (lifetime accuracy 3/3,262 = 0.09%; no rebuild — no-flag is the terminal state). Nothing writes the flag; db-audit holds `legacy + score ✅ none` as a standing invariant. |
| Code search | ❌ **UNAVAILABLE.** GitHub refuses to index this repo: *"markjovic/sports-players-stats cannot be searched because it is too large"* (2026-07-31, 6.13 GB). A search that cannot run returns "0 files", which reads like "no matches". Use `find-code-refs.yml` instead. First CONFIRMED cost of repo size. |
| api-canonical migration | ✅ **COMPLETE AND LIVE (2026-07-15/16).** Every player file is keyed by api id; `players/aliases/` is live (452,958+ entries, ~9.5% redirects); the resolver, the nightly and the matrix are all alias-aware; the event-driven fold restores the invariant after every matrix cycle. **The "target shape" below IS the current shape.** |
| Career W/L | ✅ **REPAIRED 2026-08-05** — full `build-win-loss` run updated 244,736 players; the per-reg regrade double-count (T20) is fixed in both modes. Verified live: a 99-GP specimen went from 85W/70L to 51W/48L/1D, W+L+D now equalling GP. |
| Finals performance | ✅ **LIVE 2026-08-05.** Career `finalsStats{gp,boxedGp,pts,threePt,fouls,wins,losses,draws,gids}` + per-reg `fstats`. Finals W/L is complete; finals SCORING is hydrated client-side by StatTrack 0.73 from the Worker using the stored `gids` (box lines are not persisted — ~0.15% of games carry them), so unboxed finals render "—" rather than zeros. ⚠️ **Finals FLAGS are attributed per SEASON, not per team** — a player who reached finals with one team is medalled on every team row that season (OUTSTANDING §2.4, fix pending). |
| Publishing lag | ⚠️ **A commit is not a publication.** Pages deploys only when the Deploy Pages action runs, and it is chained to the SCHEDULED nightly — NOT to manually dispatched rebuilds. Dispatch Deploy Pages after any manual rebuild, or StatTrack keeps serving the last published snapshot (this produced three phantom bug hunts on 2026-08-05 — trap T23). |
| Publishing | ✅ **CLOSED 2026-08-03 (Mark): repo size does NOT block publishing.** The old "BLOCKS publishing" claim (§D8) is retired — Pages serves the repo fine at 6.13 GB. The ONE confirmed cost of size remains code search (row above). Size is no longer a forcing constraint on any planned work. |

**The identity layer (was missing from this file entirely):** a game carries only a truncated
spectator id, so every game→player lookup goes through `players/aliases/{spectatorPrefix}.json`
to reach the api id. `spectatorIds[]` inside the player file is the source of truth; the alias
shards are its rebuildable inverse; `fold-diverged-players.js` restores the invariant after each
matrix cycle, and `fetch-profile-stats.js` records new alias discoveries as it finds them. Nothing
that resolves a player id may skip the alias step.

**Known gap — PREMISE CORRECTED 2026-08-03/04:** the old claim here (locked seasons never get
game data; the gap grows every sweep) was WRONG in the way that mattered: the season-vs-game-file
arithmetic never subtracted the 274 `removed:true` stubs, and sizing v1 measured the "file-less
locked" set as EMPTY (the other 65 file-less seasons are new ACTIVE seasons the weekly sweep
covers). The REAL residual is incomplete-locked data — 836 seasons with registered-but-gameless
teams, 15 no-`rn` seasons, ~2.3k pending COVID-era games — being closed by the **locked re-sweep
(RUNNING 2026-08-04; OUTSTANDING §2.2)**: all 2,374 locked seasons re-fetched via
discoverTeamFixture, frozen scores untouched. Known residue: no-LADDER comps (tournaments,
one-grade juniors) are unreachable by ladder enumeration and get a Phase-4 rescue pass.

---

## Two identity namespaces + api-canonical target

PlayHQ runs **two identity namespaces for the same human**:

- **spectator** (`spectator.playhq.com`) — live scoring / box scores. Games in `games/bv` reference players by a spectator `profileID` in `p[]`/`hp[]`/`ap[]`.
- **api** (`api.playhq.com`) — profiles/statistics. `publicProfileStatistics`/`publicProfileTeams` expect an id from THIS namespace.

For many players the two differ. Feeding a spectator id to the api returns NOT_FOUND, which historically made real public players look private/missing. See `playhq_api_reference.md` for the recovery mechanics and verified validators.

**Session findings (2026-07-12/13):** the ~81,806 un-indexed spectator ids are fully backfilled. ~93% of *recovered* ids turned out to be already-indexed under their api id (collisions — recorded, not duplicated); the ~45–48% direct-hit share were genuinely-new players and were written. Spectator-multiplicity is 19.8% (benign); api-instability is 0.09% (no evidence a person has two api profiles).

### The api-canonical shape — ✅ LIVE since 2026-07-15/16

> **This section previously said "NOT YET BUILT — do not code against the target shape until the
> migration ships." That instruction was exactly inverted from 2026-07-16 onward and is withdrawn.**
> The shape below is the CURRENT shape. Code against it. StatTrack 0.61 is deployed on it, and the
> old first-seen/spectator-keyed contract is gone.

One file per player keyed by the **stable api id**, with spectator aliases folded in:

```
players/{apiPrefix}/{apiId}.json        # { uuid: apiId, spectatorIds:[...], name, private, sports, seasons, records, games }
players/aliases/{spectatorPrefix}.json  # { spectatorIdTrunc: apiId } — sharded by SPECTATOR prefix (not api prefix)
players/indexes/{apiPrefix}.json        # keyed by api id
```

A game carries only a (truncated, `TRUNC_LEN=13`) spectator id, so game→player resolution goes: truncate → `players/aliases/{spectatorPrefix}.json[idTrunc]` → api id → open the player file. The in-file `spectatorIds[]` is the source of truth; `players/aliases/*` is its rebuildable inverse. Migration seed (HISTORICAL — the migration ran 2026-07-15/16): the `apiId` field that was then stored on records, plus `reports/backfill-collisions/*`. **That directory was DELETED in the 2026-07-16 cleanup** — the live inverse is `players/aliases/`, rebuildable from each player's `spectatorIds[]`.

---

---

## Architecture overview

The system has three data layers, each with a single authoritative writer:

### Layer 1 — Game data
Written exclusively by `nightly-crawl.js`. Contains everything from games: scores, fixtures, venues, player lists, box scores. Skips locked seasons (see gap above).

Files: `games/bv/`, `team-stats/bv/`, `venue-lookup/`, `date-venue-index/`

### Layer 2 — Player data
Written by:
- `fetch-profile-stats.js` (matrix) — all career + per-reg stats + player name
- `nightly-crawl.js` — new player stubs and new reg entries only
- `discover-seasons.js` (matrix, `discover-seasons-matrix.yml`) — season discovery + pre-season/historical roster registrations
- `build-win-loss.js` — wins/losses/draws/winPct from game files
- `build-finals-stats.js` — finals/gfApps/gfWins/finalsPerSeason from game files
- ~~`build-foulout-stats.js`~~ — **DELETED 2026-07-16** (REPO_MANIFEST §6.4). foulOuts are written by `fetch-profile-stats.js`.

Files: `players/{xx}/{uuid}.json`, `players/indexes/{xx}.json`

### Layer 3 — Derived/index data
Written by downstream build scripts after player data is updated.

Files: `leaderboard/`, `search/`, `records/`, `data/*.json`

### Data flow

```
PlayHQ API
    │
    ├── nightly-crawl.js (Phase 1-2)
    │       discoverGrade + discoverFixtureByRound
    │       → games/bv/{sid}.json (scores, fixtures, venues)
    │       (skips locked seasons entirely)
    │
    ├── nightly-crawl.js (Phase 3)
    │       spectator game(id) for FINAL games
    │       → games/bv/{sid}.json (box scores, p[], hp/ap, spc:1)
    │       → players/{xx}/{uuid}.json (new regs for existing players)
    │       → players/indexes/{xx}.json (index history)
    │       → needs-matrix-shards.json (written nightly; IS READ — the nightly's
    │          status step counts its length → stats_rechecks)
    │       → clears statsChecked on players who appeared tonight
    │
    ├── nightly-crawl.js (Phase 4)
    │       → players/{xx}/{uuid}.json (new player stubs with name from spectator)
    │       → players/indexes/{xx}.json (new index entries)
    │
    ├── discover-seasons-matrix.yml (self-triggering, on demand)
    │       discover-seasons.js — season discovery + roster backfill
    │       → data/sports-index.json (new season metadata)
    │       → players/{xx}/{uuid}.json (registration deltas — sid/tid/gid/gn)
    │       → data/discover-progress.json (per-shard cursor/done state)
    │
    └── fetch-profile-stats.js (matrix — targeted shards nightly, full force periodically)
            publicProfileStatistics per player
            → players/{xx}/{uuid}.json (ALL career + per-reg stats + gameTids + seasons/regs if missing)
            → sets statsChecked

Nightly downstream (parallel after crawl):
    build-team-stats.js     → team-stats/bv/{sid}.json
    update-team-index.js    → data/team-index.json
    update-venue-lookup.js  → venue-lookup/{vid}/  (UPCOMING + FINAL + POSTPONED)
    build-venue-indexes.js  → date-venue-index/, venue-lookup/{vid}/dates.json
    build-win-loss.js       → players/{xx}/{uuid}.json (wins/losses/draws/winPct, delta mode)

Weekly (Sunday):
    build-player-games.js   → players/{xx}/{uuid}.json (games[] arrays)
    build-win-loss.js       → players/{xx}/{uuid}.json (full recompute)

Matrix downstream (on matrix completion):
    build-leaderboards.js   → leaderboard/all-time.json, leaderboard/season/ (restructured — see schema below)
    build-search-index.js   → search/players/{xx}.json
    build-records.js        → records/all-time.json
```

---

## Repository structure

```
sports-players-stats/
├── data/                              ← Root JSON files
│   ├── sports-index.json              # All season metadata (3,227 seasons)
│   ├── team-index.json                # Team search index by year/season name
│   ├── venue-index.json               # 536 venue entries [{id, n}]
│   ├── season-venue-index.json        # { seasonId: [venueId, ...] }
│   ├── forfeit-games.json             # Sorted array of forfeit game IDs (26,470)
│   ├── discover-progress.json         # Per-shard cursor/done state for discover-seasons-matrix.yml
│   ├── seasons-discovered.json        # Seasons found during discovery
│   ├── seasons-skipped.json           # Seasons skipped (wrong tenant etc.)
│   └── seasons-invalid.json           # Invalid season IDs
├── games/bv/{seasonId}.json           # All games per season (2,898 files, 2,314,197 games)
├── players/
│   ├── indexes/{00-ff}.json           # 256 player index shards
│   └── {00-ff}/{uuid}.json            # 412,100 player detail files, keyed by API ID
├── team-stats/bv/{seasonId}.json      # Team rosters + fixtures (2,898 files)
├── leaderboard/
│   ├── all-time.json                  # 20 categories, 2,000 entries each (top-N heap, unchanged)
│   └── season/{seasonId}.json        # players map ONLY — no per-category arrays (restructured 2026-07-09)
├── search/players/{xx}.json           # 506 name-prefix search shards (shardKey v2, 2026-08-02)
├── venue-lookup/
│   ├── {venueId}/dates.json           # Sorted list of dates with games at venue
│   └── {venueId}/{YYYY-MM-DD}.json   # Games at venue on that date
├── date-venue-index/{YYYY-MM-DD}.json # All venues with games on a date
├── records/all-time.json             # Single-game records
├── (removed) reports/backfill-collisions/  # DELETED in the 2026-07-16 cleanup — it was the migration seed; the live inverse is players/aliases/
├── (removed) team-lookup/             # GONE — provably absent from the current tree (527,900 total files cannot contain a 355k-file directory beside 412k player files); the old "not yet removed" note here was stale (corrected 2026-08-03)
├── discover-reduce-manifest.json      # ⚠️ DEAD — zero consumer (50.99 MB, one file). Presence UNVERIFIED as of 2026-08-03 — check the tree; delete via web UI if still there
├── needs-matrix-shards.json           # Written nightly and READ by nightly-crawl.yml's status step (counts length → stats_rechecks). DO NOT DELETE — rechecks would report 0. (Corrects an earlier 'dead file' claim; see REPO_MANIFEST §4.2.)
├── scripts/                          # All pipeline scripts
└── .github/workflows/               # All GitHub Actions workflows
```

**CRITICAL:** All root JSON files are in `data/`. Any script referencing `path.join(ROOT, 'sports-index.json')` is broken — use `path.join(ROOT, 'data', 'sports-index.json')`. (This exact bug was found and fixed in `db-audit.js` on 2026-07-09 — it was checking four of these files at the pre-migration root path and reporting all four as permanently missing.)

---

## JSON schemas

### data/sports-index.json
```json
{
  "seasons": {
    "10107609": {
      "id": "10107609",
      "name": "Summer 2021/22",
      "fullName": "Domestic — Summer 2021/22",
      "compName": "Domestic",
      "compId": "9bc0c89d",
      "orgName": "Moe Basketball Association",
      "orgId": "7d61a534",
      "tenant": "bv",
      "locked": true,
      "grades": [{"id": "fbbebc4a", "name": "Men's A Grade", "age": "Senior", "gender": "Men"}],
      "addedAt": "2026-06-03T12:33:12.854Z",
      "lockedAt": "2026-06-02T04:55:56.123Z"
    }
  },
  "lastFetch": "2026-06-28T15:00:00.000Z",
  "playerCount": 370400
}
```

Pre-AFL task: add `sport: "Basketball"` to each season entry.

### games/bv/{seasonId}.json

```json
{
  "games": {
    "a613abfa": {
      "d": "2026-05-30",
      "rn": "Round 5",
      "gid": "5afff92b", "gn": "Boys Under 14 D3",
      "h": "89eed543", "hn": "Vermont Vultures U14 Boys 8",
      "a": "502c83d9", "an": "Spirit Magic U14 Boys 2",
      "hs": 37, "as": 36,
      "st": "FINAL",
      "vid": "e5970e55-...", "vn": "The Rings (Ringwood)", "ct": "Court 2", "t": "10:15",
      "p": [{"id": "uuid1"}, {"id": "uuid2"}],
      "hp": [{"profileID": "uuid1", "pts": 12, "pt1": 0, "pt2": 4, "pt3": 1, "fouls": 2}],
      "ap": [...],
      "spc": 1
    }
  }
}
```

Hidden game (uses `t1`/`t1n`/`t2`/`t2n` instead of `h`/`a`):
```json
{
  "hidden": true, "hs": 45, "as": 38,
  "t1": "teamId1", "t1n": "Team Name 1",
  "t2": "teamId2", "t2n": "Team Name 2",
  "gid": "5afff92b", "gn": "Boys Under 14 D3",
  "d": "2026-05-30", "rn": "Round 5", "st": "FINAL",
  "vid": "...", "vn": "...", "ct": "...", "t": "...",
  "p": [...], "hp": [...], "ap": [...], "spc": 1
}
```

Game flags:
- `forfeit: true`, `fo: "winning-team-id"` — forfeit
- `cancelled: true` — cancelled
- `abandoned: true` — abandoned
- `bye: true` — bye round
- `hidden: true` — hidden grade (admin-hidden)
- `profileOnly: true` — found only via profile API (step 3)
- `legacy: true` — **population is exactly 3, permanently (final state 2026-08-02).** Historically
  this marked the terminal state of a classification probe that no longer exists (removed in the
  2026-07-16 cleanup); its lifetime record was 3,262 games stamped, 3 correct. The 3,114 scored
  carriers were cleared 08-01 and the 139 `st=UPCOMING` future fixtures 08-02; the 3 survivors are
  genuinely scoreless locked-season FINALs where the original meaning is unfalsified. Nothing
  writes the flag; db-audit holds `legacy + score` as a standing invariant. See OUTSTANDING §4.

**Unverified — do not assume:** whether `p[]` (attendee list, no side info) is fully redundant with `hp[]+ap[]` combined for games with `spc:1`. Flagged 2026-07-09, still unconfirmed against real files (`verify-p-redundancy.js` exists as the tool and has not been run to a verdict). No longer size-motivated (publishing closed 2026-08-03) — verify only if a consumer decision ever depends on it.

### players/{00-ff}/{uuid}.json (excerpt)

```json
{
  "name": "Toby Jovic",
  "gender": "Male",
  "sports": {
    "Basketball": {
      "statsChecked": "2026-06-26T10:00:00.000Z",
      "gp": 45, "pts": 890, "fg": 320, "ft": 210, "threePt": 40, "fouls": 88,
      "foulOuts": {"12840bfc": 1},
      "maxGamePTS": 16, "maxGameThreePt": 1,
      "finals": 3, "gfApps": 1, "gfWins": 1, "finalsPerSeason": {"12840bfc": 1},
      "wins": 30, "losses": 15, "draws": 0, "winPct": 0.667
    }
  },
  "records": {
    "maxGamePTS":     { "v": 16, "gameKey": "4c48f539", "sid": "68f8c050" },
    "maxGameThreePt": { "v": 1,  "gameKey": "d1d4a7ae", "sid": "68f8c050" }
  },
  "gameTids": { "4c48f539": "81f12116" },
  "seasons": [{
    "sid": "12840bfc",
    "regs": [{
      "tid": "81f12116",
      "tn": "Norwood Bulls",
      "gid": "grade-uuid",
      "gn": "Wednesday U14 Boys A",
      "age": "U14",
      "div": null,
      "stats": {
        "gp": 8, "pts": 45, "fg": 20, "ft": 3, "threePt": 0, "fouls": 12,
        "foulOuts": 1, "finals": 1, "gfApps": 1, "gfWins": 1,
        "wins": 5, "losses": 3, "draws": 0
      }
    }]
  }],
  "games": ["4c48f539", "d1d4a7ae"],
  "teams": [{"tid": "81f12116", "sid": "12840bfc", "status": "ACTIVE"}],
  "updatedAt": "2026-06-26T10:00:00.000Z"
}
```

Note: `player.uuid` is NOT stored in the file body — it's implicit from the file path (`players/{shard}/{uuid}.json`). Do not re-add it.

`sports.Basketball.gp/pts/fg/ft/threePt/fouls` (career totals) are written by `fetch-profile-stats.js` — current, active, every matrix run. These are NOT simple sums of the per-reg values below — `fetch-profile-stats.js` uses `seenGameKeys` deduplication at the API level that a naive sum of `seasons[].regs[].stats` would not reproduce. Treat career totals and summed per-reg stats as two independently-maintained figures, not redundant copies of each other, unless verified otherwise.

### players/indexes/{xx}.json

```json
{
  "uuid1": {
    "name": "Toby Jovic",
    "history": {
      "12840bfc": ["81f12116"],
      "f1fdda91": ["e1471bf8"]
    }
  }
}
```

`history`: `{sid: [tid, ...]}` — all season+team registrations ever seen.

### team-stats/bv/{seasonId}.json

```json
{
  "tid1": {
    "meta": { "name": "Vermont Vultures", "club": "" },
    "roster": {
      "uuid1": { "name": "Sam B", "gp": 8, "pts": 45, "fg": 20, "ft": 3, "threePt": 0, "fouls": 12 }
    },
    "fixtures": [{
      "gameId": "a613abfa", "date": "2026-05-30", "rn": "Round 5",
      "oppId": "502c83d9", "oppName": "Spirit Magic",
      "result": "W", "score": "37-36", "st": "FINAL"
    }]
  }
}
```

Access: `teamStats[sid][tid]` — NOT `teamStats[sid].teams[tid]`.

### leaderboard/all-time.json (UNCHANGED)

```json
{
  "pts": [
    { "uuid": "uuid1", "name": "John Smith", "v": 5200,
      "club": "Knox", "team": "Knox U18 Boys A", "org": "Eastern BV",
      "gender": "Male", "age": "U18",
      "gp": 312, "finals": 8, "gfApps": 3, "gfWins": 1 }
  ],
  "wins": [...],
  "winPct": [{ "v": 87 }]
}
```

Top-2000-per-category via a real heap over all 370k players — necessary work, not redundancy. Not touched by the 2026-07-09 restructure.

### leaderboard/season/{seasonId}.json — RESTRUCTURED 2026-07-09

```json
{
  "players": {
    "uuid1|tid1": {
      "n": "John Smith", "team": "Knox U18 Boys A", "org": "Eastern BV",
      "comp": "Domestic", "grade": "U18 Boys A",
      "age": "U18", "gender": "Male",
      "gp": 14,
      "foulOuts": 1, "foulOutsPG": 0.071, "threePtPG": 0.5, "foulsPG": 2.1,
      "finals": 1, "gfApps": 1, "gfWins": 0,
      "pts": 180, "threePt": 7, "fouls": 29,
      "wins": 10, "losses": 4, "draws": 0,
      "club": "Knox"
    }
  }
}
```

**No more per-category `{id,v}` arrays.** The old schema had 17 separate pre-sorted arrays (`pts`, `wins`, `winPct`, etc.), each repeating every qualifying player's `uuid|tid` — since season files never actually hit their (effectively unlimited) size cap, those arrays held the same ids as the `players` map, just up to 17x redundantly. That was the single largest source of avoidable size in the repo (`leaderboard/` = 2.82 GB, the biggest directory).

StatTrack now computes rankings client-side from the `players` map alone — `statValueForPlayer(m, stat)` derives the value and inclusion rule per category (matching the old server-side logic exactly: type-check only for `pts`/`gp`/`threePt`/`fouls`/`ppg`; `>0` gate for per-game and finals/gfApps/gfWins/wins/losses/draws; `gp>=10` + non-zero total for `winPct`/`lossPct`).

`id` format inside the map key is `uuid|tid` (sid was already stripped from this in an earlier June 2026 migration). `winPct`/`lossPct` are derived as integer 0–100 client-side, not stored.

### search/players/{xx}.json

```json
{
  "john smith": [{"id": "uuid1", "c": "Knox BC", "t": "Knox U18 Boys A"}],
  "smith john": [{"id": "uuid1", "c": "Knox BC", "t": "Knox U18 Boys A"}]
}
```

Both first-name-last-name and last-name-first-name formats stored. Values are arrays — multiple players can share the same name key.

---

## Scripts reference

| Script | Module | Purpose | Frequency |
|--------|--------|---------|-----------|
| `nightly-crawl.js` | CJS | Phases 1-4: discover → fixture → spectator → stub | Nightly |
| `discover-seasons.js` | CJS | Season discovery + roster backfill (matrix shard/reduce roles + legacy standalone) | On demand via `discover-seasons-matrix.yml` |
| `fetch-profile-stats.js` | CJS | publicProfileStatistics per player (matrix) | Nightly targeted / periodic full |
| `build-team-stats.js` | CJS | Team rosters + fixtures from game files | Nightly downstream |
| `update-team-index.js` | CJS | Adds new teams to team-index.json | Nightly downstream |
| `update-venue-lookup.js` | CJS | Adds venue day files from FINAL+UPCOMING+POSTPONED games | Nightly downstream |
| `build-venue-indexes.js` | CJS | Rebuilds dates.json + date-venue-index from venue-lookup | Nightly downstream |
| `build-win-loss.js` | CJS | Computes W/L/D from game files, writes to player files | Nightly delta / weekly full |
| `build-player-games.js` | **ESM** | Rebuilds player.games[] arrays | Weekly |
| `build-finals-stats.js` | **ESM** | Finals/GF stats from game files (pre-pass for side resolution); `--active-only` scope-safe | Weekly Monday chain (`active_only`) / manual full |
| `build-leaderboards.js` | **ESM** | Full leaderboard rebuild — 20 all-time categories (heap-based top-2000), season files `{players}`-only (restructured 2026-07-09) | Weekly Monday chain (`active_only`) / matrix downstream / manual `--force` full. (The one-time pre-StatTrack-0.61 `--force` this row used to mandate is long DONE.) |
| ~~`build-foulout-stats.js`~~ | — | **DELETED 2026-07-16** — foulOuts now written by `fetch-profile-stats.js` | — |
| `build-search-index.js` | CJS | Player name search shards | Manual / matrix downstream |
| `build-records.js` | **ESM** | Single-game records (team + player) | Manual / matrix downstream |
| `discover-fixtures.js` | CJS | Full-fixture tool via `discoverTeamFixture` (ALL rounds incl. future; works for historical seasons): `--current-only` weekly future-fixtures mode; `--all-seasons`/`--season` historical backfill — the designated tool for OUTSTANDING §2.2. Does NOT discover new seasons (that's `discover-seasons.js`) | Weekly Monday chain (`current_only`) / manual backfill |
| `clear-stats-checked.js` | CJS | Clears statsChecked (bulk or fix-corrupt-names mode) | Manual |
| `recheck-private-profiles.js` | CJS | Re-probes private/stale active-season players | Monthly |
| `recheck-forfeit-games.js` | CJS | Verifies forfeit-games.json | Annual |
| `db-audit.js` | CJS | Full database audit + repo size breakdown. **2026-07-31: gained the `legacy + score` invariant** — the prior flag-collision check only ever compared `legacy` against other FLAGS, never against DATA, which is why a 3,120-game contradiction was invisible to every run. Both legacy rows now report unconditionally so a clean state is reachable. | On demand |
| `find-flag-collisions.js` | CJS | Read-only. Flag collisions, legacy population by year, and a full legacy profile (forfeit-index membership, score presence, `fo` validity, `fo`-vs-scoreline disagreement) | On demand |
| `audit-seasons-gaps.js` | CJS | Read-only. Duplicate regs split by grade (regrade / null-gid / exact), regs missing `gid`, and the `seasons[]` gap across ALL games with an active/locked split | On demand |
| `repair-reg-sibling-sync.js` | CJS | One-off: makes regs sharing a (season, team) hold identical stats (per-key MAX, idempotent, aborts on any decrease) | Once |
| `repair-duplicate-regs.js` | CJS | One-off: merges regs duplicating the same `(tid, gid)`. Max-per-key; refuses groups where a shared key holds different values on every copy. Leaves regrades and null-`gid` regs alone | Once |
| `repair-legacy-flags.js` | CJS | One-off: deletes stale `legacy` from games carrying a score, leaves scoreless ones. Per-game key-diff guard, per-file count guard, full post-check | Once |
| *(no script)* `find-code-refs.yml` | — | Dispatchable grep over `scripts/` + `.github/workflows/` — the replacement for GitHub code search, which cannot index this repo | On demand |
| `lib/namespace-resolve.cjs` | CJS | Shared spectator→api recovery lib — paginated `gradePlayerStatistics`, `matchFromGrade`/`matchFromGradeRosterByName`/`matchFromSearch`, `isPlaceholderName` | Library |
| *(deleted cluster)* `backfill-*`, `diagnose-api-stability.js`, `diagnose-season-name-records.js` | — | Migration/backfill one-offs and concluded diagnostics — **DELETED in the 2026-07-16 cleanup (`fe8eedb`)**, recoverable from git history at `1faecc5`; findings preserved in REPO_MANIFEST §6.7. This table listed them as live for weeks after | Gone |
| `repair-season-names.js` | CJS | Sharded name-repair — RAN TO COMPLETION 2026-07-13 (36,080 files committed, three independent confirmations); since RETIRED (REPO_MANIFEST §6.7). The "Run pending" this row carried for three weeks was stale | Done |
| `diagnose.js` | CJS | Player/game/hidden diagnostics (multiple modes) | On demand |
| `test-api.js` | CJS | API diagnostics (concurrency/profile/game/schema/gps modes) | On demand |
| `diagnose-nightly-health.js` | CJS | Pipeline health check via GitHub API | On demand |
| *(deleted)* `strip-redundant-fields.js`, `migrate-data-dir.js` | — | Completed one-offs, deleted in the cleanup | Gone |

**This table is a summary, not the inventory — `REPO_MANIFEST.md` §2 (generated from a full read of every script) is authoritative.** When this table and the manifest disagree, the manifest wins and this table is what gets fixed.

---

## Data integrity rules

1. **`seenGameKeys` in `fetch-profile-stats.js`** — NEVER remove. Prevents double-counting. Career totals and per-reg-summed totals are NOT guaranteed to match because of this — treat as two independently-maintained figures.
2. **`finals`/`gfApps`/`gfWins` per-reg** — boolean per season (max 1). Career = count of qualifying seasons.
3. **`finalsPerSeason`** — always from `seasons_with_regs` count, never from `gp`.
4. **`fetch-playhq.js`** — permanently retired, double-counting bugs. Never re-run. (Not the same script as `fetch-profile-stats.js`, which IS current and active — these two have been confused in documentation before; check carefully which one a comment is actually about.)
5. **Spectator before legacy** — ⚠️ **ASPIRATIONAL, NOT IMPLEMENTED (corrected 2026-07-31).** This
   rule, and the three-step probe `playhq_api_reference.md` calls MANDATORY, describe a classification
   path that no code performs. Neither writer of `games/bv` (`nightly-crawl.js`, `discover-fixtures.js`)
   calls `discoverGame` to classify; a game that fails everything today simply gets no flag. Kept here
   as the rule that WOULD apply if the probe is rebuilt — do not read it as a description of current
   behaviour. See OUTSTANDING_TASKS §2.1.
6. **Never `git pull --rebase`** — always `git fetch origin main` + `git merge -X ours FETCH_HEAD`.
7. **Progress files** — commit at every interval, not just at end.
8. **Multi-sport integrity** — when AFL added, preserve other sports' seasons in `fetch-profile-stats.js`.
9. **`statsChecked`** — sole mechanism controlling matrix re-fetches.
10. **`forfeit-games.json`** — loaded by `fetch-profile-stats.js` and `build-leaderboards.js`. Lives at `data/forfeit-games.json`, not root.
11. **`hp`/`ap` vs `g.p[]`** — `g.p[]` has no side info. Cross-reference team-stats roster. Possible full redundancy for `spc:1` games — not yet confirmed, do not assume.
12. **`update-venue-lookup.js`** — must include UPCOMING, POSTPONED, FINAL; update entries when status changes.
13. **`data/` prefix** — all root JSON files at `data/`, including `forfeit-games.json`. Scripts must use `path.join(ROOT, 'data', 'filename.json')`.
14. **Per-reg W/L/D in StatTrack** — take from `regs[0]` only.
15. **`gameTids` on player file** — `{gameId: tid}`, written only for players with multiple tids in same season.
16. **`git add [specific path]`, never `-A`** — repo is multi-GB, 370k+ files; `-A` risks ENOBUFS. Live violations found and fixed in `discover-seasons.js` and `build-leaderboards.js` on 2026-07-09 — both had a path parameter that was silently ignored in favor of blanket `-A`. Check for this exact pattern in any `gitCommit`-style function before trusting it.
17. **Self-triggering GitHub Actions matrices** — `generate-shards` must be a true root job (no `needs:`, no `if:`); any pre-work goes in as an earlier step in that same job, not a separate dependency. The matrix-consuming job should rely on default success-gating from `needs:` alone — do not add a custom `if:` re-checking the output value, it's redundant and was the cause of a full day's debugging on 2026-07-09. See `claude_context.md` for the full pattern.
18. **Locked seasons are skipped by `nightly-crawl.js`** — a season discovered via `discover-seasons.js`'s backfill mode gets metadata + registrations but no game data unless it happens to still be active. See Known issues.
19. **Never feed a spectator-namespace id to `publicProfileStatistics`/`publicProfileTeams`** — recover the api id first (`lib/namespace-resolve.cjs`). NOT_FOUND from the api on a game-sourced id is almost always a namespace mismatch, not a private/missing player.
20. **Backfill/creation must collision-skip** — before writing a "new" player, resolve the api id and check the index; ~93% of recovered ids are already indexed under their api id, and writing them creates duplicates at scale. Recovery-to-FILL-STATS on already-indexed players (`fetch-profile-stats.js`) is correct and stays; recovery-to-CREATE must skip+record collisions.
21. **The profile API query has NO player-name field** — its only `name` is the SEASON name. `buildPublicPlayer` must take a real name resolved from the spectator box score, never the season field. (This bug produced 35,824 season-name records during backfill; fixed forward, repair pending.) `node --check` won't catch this — verify the name source.
22. **`actions/setup-node` must NOT appear in any PlayHQ-fetching workflow** — it changes the runner's outbound network fingerprint and CloudFront 403s every request including session acquisition. Use the runner's preinstalled node. Load-bearing; documented in workflow comments.
23. **Self-triggering matrix retrigger/commit gating** — retrigger and apply-and-commit jobs use `if: ${{ !cancelled() }}`, never `always()` (else cancel can't stop the loop); apply-and-commit must not be gated on shard `success` (one failing bucket would skip the commit for all); `gh workflow run` in a retrigger needs `permissions: actions: write`.

---

## Known issues and outstanding work

### This session's chain (namespace / migration track) — ALL CLOSED (annotated 2026-08-03; this list was written 2026-07-09 and every item completed long ago)
1. ✅ Backfill tail verified — 0 remaining (2026-07-12/13).
2. ✅ `repair-season-names-matrix.yml` ran to completion 2026-07-13 — 36,080 files, three independent confirmations. Scripts since retired.
3. ✅ Stop-button audits done: backfill matrix (07-13), stats matrix (07-21), and the LAST holdout, `discover-seasons-matrix.yml`, on 2026-08-03.
4. ✅ api-canonical migration DONE 2026-07-15/16 and live. `normName()` NFKC closed 2026-08-02 (all seven sites in one pass).
5. ✅ StatTrack on the api-canonical contract since 0.61 (verified against the deployed file 2026-07-31).

### Immediately actionable — ⚠️ MOSTLY ALREADY DONE (corrected 2026-07-29)

> This list was written 2026-07-09 and walks through a deploy sequence that completed long ago.
> Items 2 and 3 are DONE — StatTrack **0.61 is live on the api-canonical contract** (see the state
> table at the top of this file), and the leaderboard rebuild they gate finished with it. Reading
> this section as pending work would have you re-run a full leaderboard rebuild and re-deploy a
> client that is already deployed.

1. **RESOLVED IN PART 2026-08-03.** `team-lookup/` is GONE — provable from the current tree's
   arithmetic (527,900 total files cannot contain a 355k-file directory beside 412k player files);
   the deletion evidently happened and this item tracked it as pending for weeks.
   `discover-reduce-manifest.json` (50.99 MB, one file, zero consumer) remains UNVERIFIED — check
   the tree; if present, a web-UI delete closes it.
2. ~~Run `build-leaderboards.js --force`~~ — **DONE** (StatTrack 0.61 era).
3. ~~Deploy updated `index.html`~~ — **DONE**, and five further releases have shipped since (0.68 current).
4. ~~Re-run `db-audit.js`~~ — **DONE, repeatedly** — it runs routinely (latest 2026-08-02 06:07) and the truncation question it was to measure is CLOSED (57.61 MB, rejected).

### Found 2026-07-31
- **Code search is unavailable for this repo** (see the state table). `find-code-refs.yml` replaces it.
  Any process that says "grep across all files" — including this project's own cross-document fact
  rule — now has to go through that workflow.
- **3,262 stale `legacy` flags** — REPAIRED 2026-08-01 (3,114 cleared, 142 kept). OUTSTANDING_TASKS §4.
- **The three-step classification probe is documented as mandatory and does not exist.** OUTSTANDING §2.1.
- **`gitCommit` violations fixed in `nightly-crawl.js` and `discover-fixtures.js`** — combined `git add`
  in an empty catch, and a swallowed total push failure, in both. `REPO_MANIFEST` §6.9/§6.10 had
  recorded `build-team-stats.js` as "the last"/"the remaining" 10-attempt outlier; it was neither.

### Scoped, real work not yet started
- ~~UUID truncation across `games/`, `leaderboard/`, `team-stats/`, `search/`~~ — **CLOSED 2026-07-30: MEASURED AND REJECTED.** The real saving is **57.61 MB** on a 6.13 GB repo (0.9%), with `leaderboard/` holding ZERO full-length UUIDs. Every prior figure (~1.78 GB, ~1.57 GB) was an estimate derived from another estimate, wrong by ~27×. Not worth a migration that must update every exact-string-matching consumer in one pass. `db-audit.js` §13, which produced the measurement, was REMOVED 2026-07-31 — it also carried a full extra scan of `team-stats/` (916 MB) that existed only for the byte tally.
- ~~Historical/locked-season game-data backfill~~ — **DONE in two stages: the locked re-sweep (2026-08-04, +23,264 games) and the spectator backfill (2026-08-06, rosters for 7,844 of the 23,772 roster-less games; 1,095 new players).** Accepted residue, measured and deliberately left: 15,928 games spectator has no data for (paper-scored era), a ~2.7% appearance gap concentrated in partial rosters that predate the spc flag (rewriting 2.03M working rosters was rejected), and 9 games recoverable from profiles (OUTSTANDING §2.1).
- Verify `g.p[]` vs `hp[]+ap[]` redundancy in `games/bv/` before assuming it (`verify-p-redundancy.js` exists, never run to a verdict; no longer size-motivated).
- ~~`needs-matrix-shards.json` — confirmed to have zero consumer currently~~ — **RETRACTED 2026-07-29.** It IS read: `nightly-crawl.yml`'s status step counts its length to report `stats_rechecks`. Deleting it makes recheck counts read 0. See REPO_MANIFEST §4.2.

### Long-standing
- ~~GitHub Pages deploy trigger — currently triggers on every push; move to explicit dispatch.~~ **DONE (confirmed by Mark 2026-08-03): Pages no longer deploys on push — an explicit Deploy Pages action is chained in the scheduled runs.**
- ~~History squash before AFL expansion.~~ ~~R2 hosting before AFL expansion.~~ **RE-FRAMED 2026-08-03:** publishing is verified fine at current size (state table), so neither is a prerequisite for anything. Both remain OPTIONAL pre-AFL choices (squash for clone/runner speed; R2 only if a future constraint appears) — decide at AFL time, not before.
- ~~Season-lock writer + verify~~ / ~~Unlock the 489 provably-incomplete locked seasons~~ / ~~Tournament-gap fix~~ / ~~68 no-`rn` seasons (84,515 games)~~ — **FOLDED INTO OUTSTANDING §2.2 (2026-08-03).** The backfill path fetches locked seasons DIRECTLY via `discoverTeamFixture`, so the July lock-writer→unlock→re-crawl plan is likely obsolete; all four populations are re-measured at §2.2 Phase 4 and only what the sweep leaves behind survives as work.
- Roster-fill: BUILT and working (via `discover-seasons-matrix.yml` backfill mode).
- ~~`build-opposition-index.js` — weekly pre-built per-player opponent W/L/D.~~ **RETIRED 2026-08-02 on measurement** (16.2M pairs / 1,001.4 MB projected for a per-season-tid unit that doesn't support the career framing); everything the feature was for shipped client-side at zero data cost in StatTrack 0.65/0.66. `size-opposition-index.js` kept as the proof. Re-open only if a cross-season team identity ever exists.

### Future
- AFL expansion — separate game repo, shared player layer. (Size is no longer a forcing constraint; the hard prerequisite is the multi-sport merge guard in `fetchPlayerProfile` — see OUTSTANDING §3.)
- ~~Full opponent history tab in StatTrack (needs opposition index)~~ — **SUPERSEDED**: the index is retired (above) and the opposition views shipped client-side (openOpp wired to game-row opponent taps — verified from the deployed file 2026-08-02 — plus 0.65/0.66 h2h and prior lines). No open StatTrack work.

---

## Maintenance schedule

| Frequency | What |
|-----------|------|
| Nightly 01:00 AEST | nightly-crawl.js → team-stats, venue-lookup, win-loss (active-only), matrix trigger |
| Weekly Sunday | build-player-games.js, build-win-loss.js full |
| Monthly 1st | recheck-private-profiles.js |
| Weekly Monday (chained off the nightly) | discover-fixtures --current-only → build-finals-stats --active-only → build-leaderboards --active-only |
| Annually | recheck-forfeit-games.js |
| On demand | discover-seasons-matrix.yml (season discovery + roster backfill) |
