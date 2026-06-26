# sports-players-stats

Player-centric database for PlayHQ basketball competitions. Builds a searchable database of every player across all Basketball Victoria competitions — career stats, season registrations, game results, venue data, and team registrations — served via the StatTrack HTML PWA at `markjovic.github.io/stattrack`.

---

## Current state (June 2026)

| Metric | Value |
|--------|-------|
| Seasons | 2,792 (418 active, 2,374 locked) |
| Player index entries | 369,428 |
| Player detail files | 369,437 |
| Total games | 2,247,971 |
| Forfeit games | 23,846 |
| Unique venues | 532 |
| Search shards | ~630 files / name-prefix keyed |
| StatTrack | Beta 0.35 live at `markjovic.github.io/stattrack` |
| publicProfileStatistics | Full matrix run completed June 2026 |
| Nightly crawl | Active — cron 01:00 AEST daily |

---

## Architecture overview

The system has three data layers, each with a single authoritative writer:

### Layer 1 — Game data
Written exclusively by `nightly-crawl.js`. Contains everything that happened in games: scores, fixtures, venues, player lists, box scores.

Files: `games/bv/`, `team-stats/bv/`, `venue-lookup/`, `date-venue-index/`

### Layer 2 — Player data
Written exclusively by `fetch-profile-stats.js` (via the matrix workflow) for all stats. New player stubs and new season/reg entries are added by `nightly-crawl.js` Phase 4. No other script writes to player files.

Files: `players/{xx}/{uuid}.json`, `players/indexes/{xx}.json`

### Layer 3 — Derived/index data
Written by downstream build scripts after player data is updated. Never written directly from game or API data.

Files: `leaderboard/`, `search/`, `records/`, `sports-index.json`, `team-index.json`, `venue-index.json`, `season-venue-index.json`

### Data flow

```
PlayHQ API
    │
    ├── nightly-crawl.js (Phase 1-2)
    │       discoverGrade + discoverFixtureByRound
    │       → games/bv/{sid}.json (scores, fixtures, venues)
    │
    ├── nightly-crawl.js (Phase 3)
    │       spectator game(id) for FINAL games
    │       → games/bv/{sid}.json (box scores, p[], spc:1)
    │       → players/{xx}/{uuid}.json (new regs for existing players)
    │       → players/indexes/{xx}.json (index history)
    │       → needs-matrix-shards.json (which shards to re-fetch)
    │       → clears statsChecked on all players who appeared tonight
    │
    ├── nightly-crawl.js (Phase 4)
    │       → players/{xx}/{uuid}.json (new player stubs)
    │       → players/indexes/{xx}.json (new index entries)
    │
    └── fetch-profile-stats.js (matrix — targeted shards nightly, full force periodically)
            publicProfileStatistics per player
            → players/{xx}/{uuid}.json (ALL career + per-reg stats)
            → players/indexes/{xx}.json (history)
            → sets statsChecked

Nightly downstream (parallel after crawl):
    build-team-stats.js     → team-stats/bv/{sid}.json
    update-team-index.js    → team-index.json
    update-venue-lookup.js  → venue-lookup/{vid}/
    build-venue-indexes.js  → date-venue-index/, venue-lookup/{vid}/dates.json

Matrix downstream (on matrix completion):
    build-leaderboards.js   → leaderboard/all-time.json, leaderboard/season/
    build-search-index.js   → search/players/{xx}.json
    build-records.js        → records/all-time.json
```

---

## Repository structure

```
sports-players-stats/
├── sports-index.json              # All season metadata (2,792 seasons)
├── team-index.json                # Team search index by season/year
├── venue-index.json               # 532 venue entries
├── season-venue-index.json        # { seasonId: [venueId, ...] }
├── forfeit-games.json             # Sorted array of forfeit game IDs
├── needs-matrix-shards.json       # Written by nightly; consumed by matrix trigger
├── records/
│   └── all-time.json              # Single-game records (team + player)
├── scripts/                       # All pipeline scripts (see Scripts section)
├── search/players/{xx}.json       # ~630 name-prefix search shards
├── team-stats/bv/{seasonId}.json  # Team rosters + fixtures per season
├── leaderboard/
│   ├── all-time.json              # 2,000 per category, 15 categories
│   └── season/{seasonId}.json     # Normalized per-season leaderboard
├── venue-lookup/
│   ├── {venueId}/dates.json       # Sorted list of dates with games at venue
│   └── {venueId}/{YYYY-MM-DD}.json # Games at venue on that date
├── date-venue-index/
│   └── {YYYY-MM-DD}.json          # All venues with games on that date
├── games/bv/{seasonId}.json       # All games for a season
└── players/
    ├── indexes/{00-ff}.json       # 256 player index shards
    └── {00-ff}/{uuid}.json        # 369,437 player detail files
```

---

## JSON schemas

### sports-index.json
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
  }
}
```

### games/bv/{seasonId}.json

Every game for a season keyed by game ID. Fields vary by game type.

**Normal game (full data):**
```json
{
  "games": {
    "a613abfa": {
      "d": "2026-05-30",
      "rn": "Round 5",
      "h": "89eed543", "hn": "Vermont Vultures U14 Boys 8",
      "a": "502c83d9", "an": "Spirit Magic U14 Boys 2",
      "hs": 37, "as": 36,
      "hq": [10, 8, 11, 8], "aq": [9, 10, 7, 10],
      "st": "FINAL",
      "vid": "e5970e55-...", "vn": "The Rings (Ringwood)", "ct": "Court 2", "t": "10:15",
      "gid": "5afff92b", "gn": "Boys Under 14 D3",
      "p": [{"id": "uuid1", "n": "Sam Burdan"}],
      "spc": 1
    }
  }
}
```

**Hidden game (admin-hidden grade, box score stored):**
```json
{
  "hidden": true,
  "hs": 45, "as": 38,
  "t1": "teamId1", "t1n": "Team Name 1",
  "t2": "teamId2", "t2n": "Team Name 2",
  "gid": "5afff92b", "gn": "Boys Under 14 D3",
  "hp": [{"profileID": "uuid", "name": "Sam B", "number": 7, "pts": 12, "pt1": 0, "pt2": 4, "pt3": 1, "fouls": 2}],
  "ap": [...],
  "p": [{"id": "uuid", "n": "Sam B"}],
  "spc": 1
}
```

**Game flags:**

| Flag | Score? | Venue? | Teams? | Notes |
|------|--------|--------|--------|-------|
| *(none)* | ✅ | ✅ | `h`/`a` | Full game card |
| `hidden: true` | ✅ via spectator | ❌ | `t1`/`t2` (unknown orientation) | Box score from spectator. Scores preserved on reclassification — never deleted. |
| `profileOnly: true` | ❌ | ❌ | `h`/`a` | Pre-e-score era, no box score available |
| `forfeit: true` | ❌ | maybe | `h`/`a` | `fo` = winning team ID |
| `legacy: true` | ❌ | ❌ | partial | All routes exhausted — too old for spectator |
| `cancelled: true` | ❌ | maybe | `h`/`a` | Game cancelled |
| `abandoned: true` | maybe | maybe | `h`/`a` | Game abandoned mid-play |
| `spc: 1` | — | — | — | Spectator already processed — never re-fetch |

**Team field contract:**
- `h`/`hn` + `a`/`an` = known home/away orientation (never simultaneously with `t1`/`t2`)
- `t1`/`t1n` + `t2`/`t2n` = unknown orientation (hidden grades only)
- `gid`/`gn` on all games

**Game URL:** `https://www.playhq.com/basketball-victoria/org/a/a/a/game-centre/{gameId}` — only the gameId matters. All other path segments are irrelevant fillers. Confirmed for BV. The `url` field in older game entries is redundant and will be removed in a future cleanup.

**Game counts (June 2026):**

| Flag | Count |
|------|-------|
| Normal (no flag) | ~1,660,000 |
| `hidden: true` | ~425,300 |
| `profileOnly: true` | 131,633 |
| `forfeit: true` | 23,846 |
| `cancelled: true` | ~3,400 |
| `legacy: true` | ~3,263 |
| `abandoned: true` | ~539 |

### players/{xx}/{uuid}.json

```json
{
  "uuid": "0afc7690-c2db-4644-b039-af1c34520af3",
  "name": "Toby Jovic",
  "gender": "Boys",
  "sports": {
    "Basketball": {
      "gp": 83,
      "pts": 371,
      "fg": 169,
      "ft": 24,
      "threePt": 3,
      "fouls": 129,
      "finals": 2,
      "gfApps": 2,
      "gfWins": 2,
      "finalsPerSeason": 0.29,
      "foulOuts": {"e26f328b": 1, "f1fdda91": 2},
      "maxGamePTS": 16,
      "maxGameThreePt": 1,
      "statsChecked": "2026-06-26T10:00:00.000Z"
    }
  },
  "records": {
    "maxGamePTS":     {"v": 16, "gameKey": "4c48f539", "sid": "68f8c050"},
    "maxGameThreePt": {"v": 1,  "gameKey": "d1d4a7ae", "sid": "68f8c050"}
  },
  "seasons": [{
    "sid": "15908988",
    "sn": "Winter 2026",
    "club": "Spirit Magic Basketball Club",
    "sport": "Basketball",
    "regs": [{
      "tid": "502c83d9",
      "tn": "B13 Spirit Magic 2",
      "gid": "2b1f7042",
      "gn": "Saturday U13 Boys D",
      "age": "U13",
      "div": null,
      "stats": {
        "gp": 4, "pts": 19, "fg": 9, "ft": 1, "threePt": 0, "fouls": 6,
        "foulOuts": 0, "finals": 0, "gfApps": 0, "gfWins": 0
      }
    }]
  }],
  "games": ["gameId1", "gameId2"],
  "teams": [{"tid": "502c83d9", "sid": "15908988", "status": "ACTIVE"}],
  "updatedAt": "2026-06-26T10:00:00.000Z"
}
```

**Field ownership — who writes what:**

| Field | Written by | When |
|-------|-----------|------|
| `sports.Basketball.gp` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.pts` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.fg` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.ft` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.threePt` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.fouls` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.foulOuts` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.maxGamePTS` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.maxGameThreePt` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.finals` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.gfApps` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.gfWins` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.finalsPerSeason` | `fetch-profile-stats.js` | Matrix run |
| `sports.Basketball.statsChecked` | `fetch-profile-stats.js` | Matrix run (set); `nightly-crawl.js` (cleared) |
| `records.maxGamePTS` | `fetch-profile-stats.js` | Matrix run |
| `records.maxGameThreePt` | `fetch-profile-stats.js` | Matrix run |
| `regs[].stats.*` | `fetch-profile-stats.js` | Matrix run |
| `seasons[]` / `regs[]` structure | `nightly-crawl.js` Phase 3+4 | New player stubs + new reg discovery |
| `games[]` | `build-player-games.js` | Weekly |
| `teams[]` | `nightly-crawl.js` Phase 4 (stub) | New player discovery |

**Key data rules:**
- `foulOuts`: `{ seasonId: count }` — games where TOTAL_FOULS ≥ 5. Never per-reg, always season-keyed on career object.
- `finals`/`gfApps`/`gfWins` per-reg: **boolean per season** (0 or 1, never > 1). Career totals = count of seasons with each.
- `finalsPerSeason`: `seasons_with_finals / seasons_with_regs` — always ≤ 1. Computed from reg count, NOT from `gp` (which would create a circular dependency).
- `statsChecked`: set after every successful matrix fetch. Cleared by nightly for all players who appeared in tonight's games. Matrix only fetches players without `statsChecked`.
- `seenGameKeys` dedup in `fetch-profile-stats.js` prevents double-counting the same game across multiple registrations.
- `fetch-playhq.js` is **permanently retired** — it had double-counting bugs. Do NOT re-run.

### players/indexes/{xx}.json

```json
{
  "0afc7690-c2db-4644-b039-af1c34520af3": {
    "name": "Toby Jovic",
    "history": {
      "15908988": ["502c83d9"],
      "68f8c050": ["ac09183b"]
    }
  }
}
```

`history`: `{ seasonId: [teamId, ...] }` — all team IDs the player has played for in each season. Used by `build-team-stats.js` to populate rosters without API calls.

### leaderboard/all-time.json

```json
{
  "pts": [{"uuid": "...", "name": "...", "org": "...", "gp": 120, "v": 1842}],
  "ppg": [...],
  "gp": [...],
  "threePt": [...],
  "fouls": [...],
  "threePtPG": [...],
  "foulsPG": [...],
  "foulOuts": [...],
  "foulOutsPG": [...],
  "finals": [...],
  "gfApps": [...],
  "gfWins": [...],
  "finalsPerSeason": [...],
  "maxGamePTS": [...],
  "maxGameThreePt": [...]
}
```

2,000 entries per category. 15 categories. Denormalized (player name, org, gp included inline).

### leaderboard/season/{seasonId}.json

```json
{
  "pts": [{"id": "uuid|tid|sid", "v": 222}],
  "ppg": [{"id": "uuid|tid|sid", "v": 27.75}],
  "players": {
    "uuid|tid|sid": {
      "n": "Name", "team": "...", "org": "...", "comp": "...",
      "grade": "Saturday U12 Boys B", "age": "U12", "gender": "Boys",
      "gp": 8, "foulOuts": 0, "foulOutsPG": 0,
      "threePtPG": 0.38, "foulsPG": 2, "finals": 0, "gfApps": 0, "gfWins": 0
    }
  }
}
```

12 season categories (excludes `maxGamePTS`, `maxGameThreePt`, `finalsPerSeason`). No entry cap. StatTrack's `denormSeason()` expands `{id,v}` + players map to full denormalized format before caching.

### team-stats/bv/{seasonId}.json

```json
{
  "9977add9": {
    "meta": {"name": "Spirit Magic U14 Boys", "club": ""},
    "roster": {
      "uuid1": {"name": "Player", "gp": 6, "pts": 42, "fg": 18, "ft": 4, "threePt": 2, "fouls": 8}
    },
    "fixtures": [
      {
        "gameId": "...", "date": "2026-05-30", "rn": "Round 5",
        "oppId": "tid2", "oppName": "Opponent",
        "result": "W", "score": "45-38", "st": "FINAL"
      }
    ]
  }
}
```

Rosters populated from player index history (covers all grade types including normal grades). Does not require API calls.

### search/players/{xx}.json

```json
{
  "Toby Jovic": [{"id": "0afc7690-...", "c": "Spirit Magic Basketball Club", "t": "B13 Spirit Magic 2"}],
  "Jovic, Toby": [{"id": "0afc7690-...", "c": "Spirit Magic Basketball Club", "t": "B13 Spirit Magic 2"}]
}
```

Shard key = first 2 characters of the entry key (player name), lowercase. ~630 files. Both `Firstname Lastname` and `Lastname, Firstname` formats stored.

### records/all-time.json

```json
{
  "playerPTS": [{"v": 62, "uuid": "...", "name": "...", "date": "...", "vs": "...", "score": "...", "rank": 1}],
  "playerThreePt": [...],
  "teamPTS": [...],
  "teamThreePt": [...],
  "highestCombined": [...],
  "largestMargin": [...],
  "closestGame": [...],
  "_notes": {"teamThreePt": "Based on stored box scores only"}
}
```

Top 50 per category. `playerPTS`/`playerThreePt` sourced from leaderboard `maxGamePTS`/`maxGameThreePt`. Team records from game file scan. Updated automatically after every matrix completion.

---

## Scripts — complete reference

### Nightly chain

#### `nightly-crawl.js`
**Called by:** `nightly-crawl.yml` (cron 01:00 AEST; also self-triggers if gamesRemaining > 0)
**Purpose:** Game data pipeline. Four phases:

- **Phase 1** — `discoverGrade(gradeRounds)` for all 8,106+ active grades at CONCURRENCY=500. Gets current round IDs. Detects grades that became hidden (Phase 1b) and reclassifies their game entries.
- **Phase 2** — `discoverFixtureByRound` for current + N rounds back at CONCURRENCY=500. Writes scores, venues, team names, round names, forfeits to game files. Updates `forfeit-games.json`.
- **Phase 3** — Spectator `game(id)` for all FINAL-status games without `spc:1` at CONCURRENCY=3. Gets box scores (per-player pts/3pt/fouls). Writes `p[]` and sets `spc:1`. For each player who appeared: adds missing season/reg entries to existing player files; clears `statsChecked`. Writes `needs-matrix-shards.json`.
- **Phase 4** — Stubs new players (in game `p[]` but not in index) with a minimal player file and index entry.

**Outputs:** Updated game files, player stubs, new reg entries, `needs-matrix-shards.json`, `.nightly-status.json`

**Key flags:** `--rounds-back=N` (default 2; 6 for catch-up; 15+ for large gap recovery), `--season=ID`, `--dry-run`

#### `build-team-stats.js`
**Called by:** `nightly-crawl.yml` (parallel downstream after crawl), also `full-reset.yml`
**Purpose:** Rebuilds `team-stats/bv/{seasonId}.json` for active (or all) seasons. Roster populated from player index `history` field — no API calls. Fixtures from game files.
**Flags:** `--active-only`

#### `update-team-index.js`
**Called by:** `nightly-crawl.yml` (parallel downstream)
**Purpose:** Updates `team-index.json` with new teams discovered in active seasons.

#### `update-venue-lookup.js`
**Called by:** `nightly-crawl.yml` (parallel downstream)
**Purpose:** Creates/updates per-date files in `venue-lookup/{venueId}/` for venues seen in tonight's games.

#### `build-venue-indexes.js`
**Called by:** `nightly-crawl.yml` (after `update-venue-lookup`)
**Purpose:** Rebuilds `venue-lookup/{venueId}/dates.json` (sorted date list per venue) and `date-venue-index/{date}.json` (venues active on each date).

### Matrix

#### `fetch-profile-stats.js`
**Called by:** `fetch-profile-stats-matrix.yml` (256 shards, max 20 concurrent)
**Purpose:** The authoritative player stats writer. For each player without `statsChecked`:
1. Calls `publicProfileStatistics` API (BATCH_SIZE=30 concurrent, session refresh between batches)
2. Parses all game-level stats with `seenGameKeys` dedup across multiple registrations
3. Computes per-reg stats: `gp`, `pts`, `fg` (2_POINT_SCORE), `ft` (1_POINT_SCORE), `threePt` (3_POINT_SCORE), `fouls` (TOTAL_FOULS) using APPEARANCE for game count
4. Computes career totals by summing across all regs
5. Computes `foulOuts` (games with TOTAL_FOULS ≥ 5, keyed by seasonId)
6. Finds `maxGamePTS` and `maxGameThreePt` with `gameKey`/`sid` for game linking
7. Writes all fields to player file and sets `statsChecked`
8. Skips forfeit games (loaded from `forfeit-games.json`)

**No git operations** — uploads changed files as tar artifact. Single `apply-and-commit` aggregator job does one commit+push per run.

**403 handling:** `ProfileSeasonStatistics` 403 = private profile (mark done, set `statsChecked`). All other 403s = session expiry (refresh and retry).

#### `clear-stats-checked.js`
**Called by:** `fetch-profile-stats-matrix.yml` pre-job (only when `force=true`)
**Purpose:** Clears `statsChecked` from all 369k+ player files in a single pass with one commit. Enables the full force matrix re-fetch.

#### `count-stats-checked.js`
**Called by:** On demand (diagnostic)
**Purpose:** Reports how many players have/lack `statsChecked`. No writes.

### Matrix workflow (`fetch-profile-stats-matrix.yml`)

Four jobs per run:
1. **`clear-stats-checked`** — only when `force=true`; single writer
2. **`generate-shards`** — builds hex prefix list (all 256, or targeted from `inputs.shards`)
3. **`fetch`** — 256 shard jobs (max 20 concurrent); each sparse-checkouts its own `players/{shard}/`; uploads tar artifact + summary JSON
4. **`apply-and-commit`** — downloads all artifacts; sparse-checkouts only changed shard dirs; applies in one commit+push
5. **`summary-and-retrigger`** — aggregates shard summaries; self-triggers if `written > 0`; on completion (3 consecutive zero-written runs) triggers `build-leaderboards`, `build-search-index`, `build-records`

**Self-triggering:** Continues until 3 consecutive runs with `written=0`. Max 150 runs. CloudFront blocks ~175/256 shards per force run; each re-trigger recovers ~25-30k players.

**Targeted runs:** Pass `shards=["xx","yy"]` to process only specific prefixes. Used by nightly trigger.

### Matrix downstream (triggered on matrix completion)

#### `build-leaderboards.js`
**Called by:** `fetch-profile-stats-matrix.yml` on completion (`--active-only`); `build-leaderboards.yml` for full rebuild (`--force`)
**Purpose:** Builds all-time and per-season leaderboard files from player data. ESM script.
- `--active-only`: only rebuilds seasons not locked in `sports-index.json`
- `--force`: full rebuild of all 2,792 seasons
- Normalized season schema: `{id,v}` arrays + `players` map. StatTrack expands on load.
- Filters forfeit games from `maxGamePTS`/`maxGameThreePt` leaderboard entries

#### `build-search-index.js`
**Called by:** `fetch-profile-stats-matrix.yml` on completion; `build-search-index.yml`
**Purpose:** Rebuilds all search shards. Name-prefix keyed (~630 files). Stores both `Firstname Lastname` and `Lastname, Firstname` formats.

#### `build-records.js`
**Called by:** `fetch-profile-stats-matrix.yml` on completion; `build-records.yml`
**Purpose:** Builds `records/all-time.json` with top 50 per category.
- Phase 1: scans all game files for team records (teamPTS, highestCombined, largestMargin, closestGame, teamThreePt from box scores)
- Phase 2: reads `leaderboard/all-time.json` maxGamePTS/maxGameThreePt for playerPTS/playerThreePt
- `teamThreePt` based on stored box scores only — not all games have box scores

### Periodic

#### `build-player-games.js`
**Called by:** `weekly-indexes.yml` (Sunday)
**Purpose:** Builds `player.games[]` — array of all game IDs a player appeared in, sourced from `p[]` arrays in game files. Phase 1 scans all game files into memory (~1 min). Phase 2 writes to player files. Used by StatTrack for cross-roster opposition lookup.
**Note:** Uses `git pull --rebase=false` — should be updated to fetch+merge pattern.

#### `recheck-private-profiles.js`
**Called by:** `recheck-private-profiles.yml` (monthly, 1st of month)
**Purpose:** Re-probes players marked as private or stale. Active-season threshold: 90 days (should be 7 days for foulOuts to stay current — **known issue, not yet fixed**).

### On demand

#### `build-finals-stats.js`
**Called by:** `full-reset.yml` (tonight's one-time run); manually after each finals series
**Purpose:** Historical backfill of finals stats from game files. Two phases:
- Phase 1: scans all game files for finals/GF games, builds `finalsMap` per player per season
- Phase 2: writes `finals`/`gfApps`/`gfWins` to `regs[].stats` and `sports.Basketball` career totals; computes `finalsPerSeason` as `seasons_with_finals / seasons_with_regs` (NOT from `gp` — avoids circular dependency)
- ESM script. Progress file committed at intervals.
- Run after matrix completes; rebuild leaderboards after.

#### `backfill-hidden-boxscores.js`
**Called by:** Once (manual — `backfill-hidden-boxscores.yml`), then never again
**Purpose:** Fixes hidden FINAL games with no box score stored — specifically games that were reclassified as hidden before Phase 1b was corrected (which previously deleted `hs`/`as` scores on reclassification). Probes spectator for each; writes `hs`/`as` + `hp`/`ap` + `p[]` + `spc:1`. Marks `legacy:true` if spectator returns nothing. Does not touch player files — player stats are unaffected since `publicProfileStatistics` returns all games regardless of hidden status. Resumable via progress file. Going forward, Phase 1b queues reclassified games for spectator automatically on the same night they're reclassified.

#### `recheck-forfeit-games.js`
**Called by:** Annually (manual)
**Purpose:** Re-scans game files and API to ensure `forfeit-games.json` is complete and accurate.

#### `backfill-player-records.js`
**Called by:** Between seasons (manual)
**Purpose:** Backfills `records.maxGamePTS.gameKey` and `records.maxGameThreePt.gameKey` for players who have a record value but no game key linking.

### Diagnostics (keep, run on demand)

#### `db-audit.js`
Comprehensive database audit combining former `db-report.js` and `repo-size.js`. Checks:
- sports-index season counts
- Player index shard coverage
- Player detail file full scan: `statsChecked` coverage, `foulOuts` type correctness, `maxGamePTS`/`maxGameThreePt` breakdown, per-reg stat presence and maintenance status, finals stats integrity (`finalsPerSeason` must always be ≤ 1)
- Game file counts and classification breakdown
- Search shard count and schema validation
- Leaderboard file count and schema validation
- Team-stats and venue-lookup integrity
- Repo size breakdown by directory
- Summary vs documented baseline with diff reporting

`--verbose`: per-season game breakdown. `--no-size`: skip repo size (faster).

#### Other diagnostics
- `inspect-hidden-reclassified.js` — shows games reclassified as hidden in recent git history
- `test-grade-concurrency.js` — tests discoverGrade concurrency limits
- `test-spectator-concurrency.js` — tests spectator concurrency limits
- `count-stats-checked.js` — counts players with/without statsChecked
- `diagnose-player-stats.js` — deep diagnostic for a single player UUID: compares player file, team-stats roster, and game box score sums
- `test-profile-query.js`, `test-discover-game.js` — API query testers

### Scripts to delete (one-time complete / superseded)

All of these are safe to delete:

| Script(s) | Reason |
|-----------|--------|
| `migrate-phase1/2/3.js`, `migrate-player-index.js`, `migrate-team-lookup.js` | Migration complete |
| `normalise-game-structure.js` | One-time complete |
| `augment-game-grades.js`, `augment-team-index.js`, `augment-venue-lookup.js` | One-time complete |
| `backfill-fixtures.js`, `backfill-game-scores.js`, `backfill-hidden-games.js` | One-time complete |
| `backfill-jersey-numbers.js`, `backfill-missing-players.js`, `backfill-venue.js` | One-time complete |
| `bootstrap-fixture-progress.js` | One-time complete |
| `cleanup-empty-cats.js`, `cleanup-flag-collisions.js`, `cleanup-player-pgstats.js` | One-time complete |
| `recover-discovered-seasons.js`, `recover-missing-seasons.js` | One-time complete |
| `classify-games.js`, `discover-fixtures.js` | Superseded by nightly |
| `fetch-player-profiles.js`, `build-foulout-stats.js` | Superseded by `fetch-profile-stats.js` |
| `fetch-playhq.js` | **NEVER RE-RUN** — double-counting bugs; superseded |
| `infer-game-grades.js`, `reaudit-game-grades.js` | One-time complete |
| `rebuild-player-stats.js` | Superseded |
| `probe-api-schema.js`, `probe-games.js`, `probe-lineup.js`, `probe-rest-api.js`, `probe-team-members.js` | One-time probes |
| `explore-playhq-auth.js`, `fetch-lineup-auth.js` | One-time probes |
| `backfill-spectator.js` | One-time complete |
| `fix-forfeit-player-records.js`, `fix-game-boxscore.js`, `fix-game-status.js` | One-time complete |
| `fix-null-records.js`, `fix-regraded-teamstats.js` | One-time complete |
| `db-report.js`, `repo-size.js` | Superseded by combined `db-audit.js` |
| `find-missing-game-data.js`, `find-missing-team-players.js`, `find-season-players.js` | One-time complete |
| `lookup-grade-players.js`, `roster-lookup.js`, `team-lookup-utils.js` | No longer needed |
| `audit-sample.js` | One-time diagnostic |
| `fetch-leaderboard-records.js` | Superseded by `build-records.js` + matrix |

### Root files to delete

| File | Reason |
|------|--------|
| `backfill-progress.json` (23MB) | Stale progress file |
| `missing-game-data.json` (75MB) | One-time diagnostic output |
| `missing-quarter-scores.json` (22MB) | One-time diagnostic output |
| `missing-box-scores.json` (22MB) | One-time diagnostic output |
| `backfill-venue-progress.json` (10MB) | Stale progress file |
| `backfill-hidden-progress.json` (6MB) | Stale progress file |
| `classify-games-progress.json` (5MB) | Stale progress file |
| `backfill-missing-players-progress.json` (1.5MB) | Stale progress file |
| `migrate-phase1-progress.json`, `migrate-phase2-progress.json` | Stale progress files |
| `discover-fixtures-progress.json`, `patch-fixtures-progress.json` | Stale progress files |
| `explore-results/` | One-time diagnostic output |
| `roster-results/` | One-time diagnostic output |
| `probe-rest-api.html`, `probe-lineup.html`, `lineup-result.html` | One-time probe output |
| `explore-cookie.json` | One-time probe output |
| `matrix-force-pending.json` | No longer used |
| `missing-team-players.json` | One-time diagnostic output |
| `no-venue-seasons.json`, `zero-team-seasons.json`, `no-ladder-seasons.json` | One-time diagnostic output |
| `run-summary.json` | Stale |
| `stattrack-pwa-spec.md` | Superseded by `stattrack_html_design.md` |

---

## GitHub Actions workflows

| Workflow | Schedule | Purpose |
|----------|----------|---------|
| `nightly-crawl.yml` | 01:00 AEST daily | Crawl + team-stats + team-index + venue-lookup/indexes + targeted matrix trigger |
| `fetch-profile-stats-matrix.yml` | Triggered by nightly or manually | 256-shard player stats matrix; self-triggers; on completion triggers leaderboards + search + records |
| `build-leaderboards.yml` | On demand | Full leaderboard rebuild (`--force`). Nightly uses `--active-only` inline. |
| `build-search-index.yml` | On demand | Full search index rebuild |
| `build-records.yml` | On demand / matrix downstream | records/all-time.json rebuild |
| `weekly-indexes.yml` | Sunday | `build-player-games.js` |
| `recheck-private-profiles.yml` | Monthly (1st) | Re-probe private/stale players |
| `db-audit.yml` | On demand | Full database audit + repo size |
| `test-grade-concurrency.yml` | On demand | Diagnostic |
| `test-spectator-concurrency.yml` | On demand | Diagnostic |
| `inspect-hidden-reclassified.yml` | On demand | Diagnostic |

**Workflows to delete:**
- `backfill-spectator.yml` — one-time complete
- `fix-null-records.yml` — one-time complete
- `db-report.yml` — superseded by `db-audit.yml`
- `repo-size.yml` — superseded by `db-audit.yml`

---

## Maintenance schedule

### Nightly (01:00 AEST — `nightly-crawl.yml`)
1. `nightly-crawl.js` — Phases 1-4: grades → fixtures → spectator → stubs + reg discovery
2. Parallel: `build-team-stats.js --active-only`, `update-team-index.js`, `update-venue-lookup.js` → `build-venue-indexes.js`
3. Triggers targeted matrix for shards in `needs-matrix-shards.json` (players who appeared in tonight's games)
4. Self-triggers if `gamesRemaining > 0` (spectator misses from tonight)
5. Matrix self-triggers until complete, then triggers `build-leaderboards.js --active-only`, `build-search-index.js`, `build-records.js`

### Weekly (Sunday — `weekly-indexes.yml`)
- `build-player-games.js` — rebuilds `player.games[]` arrays for all players

### Monthly (1st — `recheck-private-profiles.yml`)
- Re-probes players marked private and active-season players not seen in 90 days

### After each finals series (manual)
- `build-finals-stats.js` — recomputes finals stats from game files for all seasons
- `build-leaderboards.js --force` — full leaderboard rebuild

### Annually (manual)
- `recheck-forfeit-games.js` — ensures forfeit-games.json is complete

---

## PlayHQ API summary

See `playhq_api_reference.md` for full query reference and headers.

- **Main API:** `api.playhq.com/graphql` — tenant `basketball-victoria` (never `bv`)
- **Spectator:** `spectator.playhq.com/graphql` — tenant `bv` + `x-phq-tenant: bv`
- **Cookie order (critical):** `phq_tier=...; phq_session=...; phq_sub=...` — wrong order = CloudFront 403
- **Session TTL:** ~30-40 min. Always use CONCURRENCY=500 to complete within session window.
- **Rate limits:** Only `publicProfileStatistics` has a JWT quota (~30-35 calls per session). All other endpoints: no practical limit (tested to 1000 concurrent).
- **Game URL:** `https://www.playhq.com/basketball-victoria/org/a/a/a/game-centre/{gameId}` — only gameId matters.

---

## StatTrack display

StatTrack (`markjovic/stattrack`, `index.html`) is a single-file HTML PWA. Data source: `markjovic.github.io/sports-players-stats`.

**Player profile displays:**
- Career stats panel: `gp`, `pts`, `ppg` (pts/gp), `3PT` (threePt), `F` (fouls), `FO` (foulOuts total), `Finals`, `GF` (gfApps), `GFW` (gfWins) — sourced from `sports.Basketball`
- Season history rows: `GP · PPG · PTS · FG · FT · 3PT · F` — summed from `regs[].stats` per season group
- Grade snapshot: org/comp/grade history above season rows
- Medal emoji on GF wins/apps/finals appearances

**Leaderboard displays:**
- All-time: 15 categories, 2,000 entries each, with Min GP filter for per-game stats
- Season: normalized schema, expanded by `denormSeason()` before caching
- `finalsPerSeason` must always be ≤ 1 — values > 1 indicate a bug in `build-finals-stats.js`

**Team page:** roster from `team-stats/bv/{sid}.json`; fixtures with results.

**Venue calendar:** games by venue and date from `venue-lookup/`.

---

## Data integrity rules

1. **`seenGameKeys` in `fetch-profile-stats.js`** — NEVER remove. Prevents double-counting the same game when a player has multiple registrations in the same season.
2. **`finals`/`gfApps`/`gfWins` per-reg** — boolean per season (max 1). Never increment beyond 1.
3. **`finalsPerSeason`** — always computed from `seasons_with_regs` count, never from `gp`. Using `gp` creates a circular dependency (gp is written by the matrix, finalsPerSeason needed before matrix).
4. **`fetch-playhq.js`** — permanently retired, double-counting bugs. Never re-run.
5. **Spectator before legacy** — always probe spectator before marking a game `legacy: true`.
6. **Never `git pull --rebase`** — always `git fetch origin main` + `git merge -X ours FETCH_HEAD`.
7. **Progress files** — committed at every interval, not just at end of run.
8. **Multi-sport integrity** — when AFL or other sports are added, `existingDetail` merge in `fetch-profile-stats.js` MUST preserve other sports' seasons. Currently safe to skip only because Basketball is the only sport. When multi-sport is active, never proceed with empty `existingDetail` — abort the write instead.
9. **`statsChecked`** — the sole mechanism controlling which players the matrix re-fetches. Nightly clears it for all players in tonight's games. Matrix sets it after every successful fetch.
10. **`forfeit-games.json`** — loaded by `fetch-profile-stats.js` to skip forfeit games when computing stats. Loaded by `build-leaderboards.js` to filter `maxGamePTS`/`maxGameThreePt` entries.

---

## Known issues / outstanding work

### Near-term
1. **Remove `url` field from game files** — ~150MB compressed savings. The `url` field in game entries is redundant (game URL constructible from gameId alone). Script needed to strip it.
2. **Remove player names from `p[]`** — ~500MB compressed savings. Only UUIDs needed; names available from player index.
3. **GitHub Pages artifact ~1.9GB** — over the 1GB soft limit. Warns on deploy but still succeeds. Items 1+2 above should bring it under 1GB.
4. **History squash** — required before AFL expansion. Repo contains many historical blobs from one-time scripts.
5. **`recheck-private-profiles.js` threshold** — active-season recheck is 90 days. Should be 7 days to keep foulOuts current for active players.
6. **R2 hosting** — required before AFL adds too much data volume.
7. **Sparse checkout on nightly workflows** — would speed up checkout significantly.
8. **`build-player-games.js` git pattern** — uses `git pull --rebase=false` instead of the standard fetch+merge pattern. Should be fixed.
9. **`regs[]` ordering** — unknown whether chronological or reverse-chronological. Affects BRES/B grade snapshot logic in StatTrack (last-reg-wins assumes chronological). Verify in testing.
10. **Delete stale root files** — ~170MB of abandoned progress/diagnostic JSON files in repo root (listed in Scripts section above).
11. **Delete obsolete scripts** — listed in Scripts section above.
12. **Matrix summary: shard-level written/blocked breakdown** — the `summary-and-retrigger` job currently shows inaccessible profile counts per shard, but not which shards had `written > 0` or were CloudFront-blocked. Add to the Python aggregation loop using existing `written`/`blocked` fields in shard summary JSONs.

### Future
13. **AFL expansion** — separate repo, shared player identity layer. `opponents[]` cross-sport opposition index planned. Multi-sport data integrity rule applies immediately when second sport added.
14. **foulOuts nightly + matrix overlap** — first nightly after a force matrix may double-count foulOuts for games the nightly processes AND the matrix already counted. One-time issue; next matrix re-fetch corrects it.

---

## Future: multi-sport expansion

- This repo becomes the shared player layer (PlayHQ UUID is sport-agnostic)
- AFL gets its own game data repo
- Same UUIDs span sports at the player level
- History squash needed before AFL to reduce repo size
- R2 or equivalent hosting needed when combined data exceeds Pages limits
- **Critical:** when second sport added, `existingDetail` merge in `fetch-profile-stats.js` must preserve other sports' data — never overwrite with empty merge
