# sports-players-stats

Player-centric scraper and database for PlayHQ basketball competitions. Builds a searchable database of every player across all Basketball Victoria competitions — player histories, career stats, season registrations, game results, venue data, and team registrations — served via the StatTrack HTML PWA.

---

## Current state (June 2026 — post-migration)

| Metric | Value |
|--------|-------|
| Seasons | 2,792 (418 active, 2,374 locked) |
| Player index entries | 369,428 |
| Player detail files | 369,437 |
| Unique teams | 357,284 |
| Unique venues | 532 |
| Total games | 2,247,971 |
| Score coverage | 99.8% |
| Venue coverage | 96.1% |
| Search shards | 595 files / 595,879 unique keys |
| Migration | ✅ Complete (Phases 1–3 verified 25/25) |
| StatTrack | ✅ Beta 0.33 live at `markjovic.github.io/stattrack` |
| Forfeit games indexed | 1,984 (in `forfeit-games.json`) |
| Nightly crawl | ✅ Built and ready to enable |

**Game classification:**

| Flag | Count | Meaning |
|------|-------|---------|
| *(none — normal)* | ~1.74M | Full data |
| `hidden: true` | 424,350 | Admin-hidden grade |
| `profileOnly: true` | 131,633 | Pre-e-score era |
| `legacy: true` | 141 | All routes exhausted |
| `forfeit: true` | 1,984 | Won by forfeit |
| `noProfile: <ts>` | 84,050 | Retry after 30d |
| `noVenue: <ts>` | 424,153 | Retry after 30d |

---

## Repository structure

```
sports-players-stats/
├── sports-index.json              # Season metadata (2,792 seasons)
├── team-index.json                # Team search by season name (comp + grade per entry)
├── venue-index.json               # Venue search list (532 venues)
├── season-venue-index.json        # { seasonId: [venueId, ...] } (1,919 seasons)
├── forfeit-games.json             # sorted array of known forfeit game IDs
├── scripts/                       # All pipeline and utility scripts
│   ├── db-report.js               # Database state report
│   ├── fetch-playhq.js            # Full player crawl
│   ├── classify-games.js          # Three-step classification sweep
│   ├── discover-fixtures.js       # Fixture/venue via discoverTeamFixture
│   ├── augment-venue-lookup.js    # Add sid/hid/aid/comp/grade to venue game entries ✅
│   ├── build-venue-indexes.js     # dates.json, date-venue-index, season-venue-index ✅
│   ├── augment-team-index.js      # Add comp/grade to team-index.json ✅
│   ├── augment-game-grades.js     # Add gid/gn to games/bv/{sid}.json ✅
│   ├── build-leaderboards.js      # Leaderboard files (full + --active-only) ✅
│   ├── normalise-game-structure.js
│   ├── cleanup-flag-collisions.js
│   ├── backfill-missing-players.js
│   ├── backfill-hidden-games.js
│   ├── migrate-phase1.js          ✅ complete
│   ├── migrate-phase2.js          ✅ complete
│   ├── migrate-phase3.js          ✅ complete
│   └── ...
├── records/
│   └── all-time.json              # single-game records (playerPTS, teamPTS, etc.)
├── search/players/{aa-zz}.json    # 595 player search shards
├── team-stats/bv/{seasonId}.json  # Team rosters + fixtures (2,792 files)
├── leaderboard/
│   ├── all-time.json              # Top 200 per stat category, career totals
│   └── season/{seasonId}.json    # Top 200 per stat category, per season (2,793 files)
├── venue-lookup/
│   ├── {venueId}/dates.json       # Sorted date array for this venue (532 files)
│   └── {venueId}/{YYYY-MM-DD}.json  # Court schedule grids (100,173 files)
├── date-venue-index/
│   └── {YYYY-MM-DD}.json          # Venue IDs active on this date (2,016 files)
├── games/bv/{seasonId}.json       # Game data with gid/gn (2,792 files)
└── players/
    ├── indexes/{00-ff}.json       # Career stats + history map (256 shards)
    └── {00-ff}/{uuid}.json        # Full player detail (369,437 files)
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
Post-migration structure — `playerGames` deleted, `p` array and `gid`/`gn` added to every game entry.

**Normal game:**
```json
{
  "games": {
    "a613abfa": {
      "d": "2026-05-30", "rn": "Round 5",
      "h": "89eed543", "hn": "Vermont Vultures U14 Boys 8",
      "a": "502c83d9", "an": "Spirit Magic U14 Boys 2",
      "hs": 37, "as": 36,
      "hq": [10, 8, 11, 8], "aq": [9, 10, 7, 10],
      "st": "FINAL",
      "vid": "e5970e55-...", "vn": "The Rings (Ringwood)", "ct": "Court 2", "t": "10:15",
      "url": "https://www.playhq.com/...",
      "gid": "5afff92b", "gn": "Boys Under 14 D3",
      "p": [{"id": "uuid1", "n": "Sam Burdan"}, {"id": "uuid2", "n": "Player #3253b50e81"}],
      "spc": 1
    }
  }
}
```

**Hidden game (box score stored):**
```json
{
  "hidden": true,
  "hs": 45, "as": 38,
  "hq": [12, 14, 11, 8], "aq": [10, 9, 12, 7],
  "t1": "teamId1", "t1n": "Team Name 1",
  "t2": "teamId2", "t2n": "Team Name 2",
  "gid": "5afff92b", "gn": "Boys Under 14 D3",
  "hp": [{"profileID": "prof-uuid", "name": "Sam B", "number": 7, "pts": 12, "pt1": 0, "pt2": 4, "pt3": 1, "fouls": 2}],
  "ap": [...],
  "p": [{"id": "prof-uuid", "n": "Sam B"}]
}
```

**Team field rules:**
- `h`/`hn` + `a`/`an` = absolute orientation (supersedes t1/t2, never both)
- `t1`/`t1n` + `t2`/`t2n` = orientation unknown
- `hs`/`as` are always the score fields regardless of h/a vs t1/t2
- `gid`/`gn` present on all games; empty string on the 4,422 where grade could not be resolved

### players/{xx}/{uuid}.json
```json
{
  "uuid": "94b31aeb-c3f1-4a82-9de2-7f5e8a1b0c23",
  "name": "Player Name",
  "gender": "Male",
  "sports": {
    "Basketball": {"gp": 123, "pts": 804, "fouls": 200, "fg": 345, "ft": 105, "threePt": 3}
  },
  "seasons": [{
    "sid": "635c2c74", "sn": "Autumn 2026", "club": "Spirit Magic", "sport": "Basketball",
    "regs": [{
      "tid": "9977add9", "tn": "Spirit Magic U14 Boys",
      "gid": "5afff92b", "gn": "Boys Under 14 D3", "age": "U14", "div": null,
      "stats": {"gp": 6, "pts": 42, "fouls": 8, "fg": 18, "ft": 4, "threePt": 2}
    }]
  }],
  "teams": [{"tid": "9977add9", "sid": "0869ea69", "status": "UPCOMING"}],
  "teamsUpdatedAt": "2026-06-06T12:00:00.000Z",
  "updatedAt": "2026-06-06T12:00:00.000Z"
}
```

### players/indexes/{xx}.json
```json
{
  "94b31aeb-c3f1-4a82-9de2-7f5e8a1b0c23": {
    "name": "Player Name",
    "history": {
      "635c2c74": ["9977add9"],
      "a1b2c3d4": ["teamId2"]
    }
  }
}
```
`history` map: `{ seasonId: [teamId, ...] }` — built from `seasons[].regs[].tid`.

### team-stats/bv/{seasonId}.json
One file per season. All teams across all grades in that season.
```json
{
  "9977add9": {
    "meta": {"name": "Spirit Magic U14 Boys", "club": "Spirit Magic"},
    "roster": {
      "94b31aeb-...": {"name": "Sam B", "gp": 6, "pts": 42, "fg": 18, "ft": 4, "threePt": 2, "fouls": 8}
    },
    "fixtures": [
      {"gameId": "a613abfa", "date": "2026-05-30", "rn": "Round 5",
       "oppId": "89eed543", "oppName": "Vermont Vultures", "result": "W", "score": "37-36", "st": "FINAL"}
    ]
  }
}
```
- `roster`: per-player registration stats for this season/team. Empty `{}` if no players indexed.
- `fixtures`: sorted by date ascending. `result`: W/L/D or null. `score`: from this team's perspective.
- Teams with registrations but no games have `fixtures: []`.

### venue-lookup/{venueId}/{YYYY-MM-DD}.json
```json
{
  "Court 1": [
    {
      "id": "gameId1", "t": "09:00",
      "hn": "Home Team", "an": "Away Team",
      "hid": "homeTeamUuid", "aid": "awayTeamUuid",
      "sid": "seasonUuid",
      "comp": "VJBL Junior", "grade": "Boys Under 14 D3",
      "st": "FINAL"
    }
  ],
  "Court 2": [...]
}
```
Games sorted by time within each court. `t` = "HH:MM" string.

### venue-lookup/{venueId}/dates.json
```json
["2026-02-01", "2026-02-08", "2026-02-15"]
```
Sorted ascending. One file per venue (532 files). Used by StatTrack calendar to show only dates with real games.

### date-venue-index/{YYYY-MM-DD}.json
```json
["venueUuid1", "venueUuid2", "venueUuid3"]
```
Array of venue IDs active on this date. 2,016 files. Used by StatTrack venue search date filter.

### season-venue-index.json
```json
{ "seasonUuid1": ["venueUuid1", "venueUuid2"] }
```
1,919 seasons with venue data. Used by StatTrack venue season filter.

### team-index.json
```json
{
  "Summer 2024/25": [
    {"id": "83e3d989", "n": "Hoppers Tigers 7 (U14G)", "sid": "367cf946", "comp": "VJBL Junior", "grade": "Girls Under 14 D3"}
  ]
}
```
60 distinct season names. `comp` and `grade` allow disambiguation when two teams share the same name in the same season.

### venue-index.json
```json
[{"id": "e5970e55-...", "n": "The Rings (Ringwood)"}]
```
532 entries, sorted alphabetically. Loaded at boot (~20KB).

### search/players/{xx}.json
```json
{
  "John Smith": [
    {"id": "uuid1", "c": "Spirit Magic", "t": "Spirit Magic U14 Boys"},
    {"id": "uuid2", "c": "Ringwood", "t": "Ringwood U16 Boys"}
  ],
  "Smith, John": [{"id": "uuid1", "c": "Spirit Magic", "t": "Spirit Magic U14 Boys"}],
  "Player #94b31aeb-c": [{"id": "94b31aeb-...", "c": null, "t": null}]
}
```
- Keys: first-name format and surname-first format. Values: always arrays.
- `c` = most recent club. `t` = most recent team name.
- Private players: `Player #${uuid.slice(0,10)}`, shard `pl`, c/t null.
- Shard key = first 2 chars of search key lowercased. 595 files produced.

### leaderboard/all-time.json
```json
{
  "pts":     [{"uuid": "...", "name": "...", "club": "...", "sport": "Basketball", "gp": 120, "v": 1842}],
  "ppg":     [{"uuid": "...", "name": "...", "club": "...", "sport": "Basketball", "gp": 120, "v": 28.4}],
  "gp":      [...],
  "threePt": [...],
  "fouls":   [...]
}
```
Top 200 per category. All entries include `gp` — required for client-side min-GP filtering on PPG tab. Rebuilt by `build-leaderboards.js` (full) or updated by `--active-only` after nightly crawl.

### leaderboard/season/{seasonId}.json
Same structure as all-time. Per-season entries:
```json
{"uuid": "...", "name": "...", "club": "...", "grade": "Boys Under 14 D3", "age": "U14", "gender": "Male", "gp": 6, "v": 42}
```
One entry **per registration** — a player in two grades in the same season has two entries, each with their own stats. Stats are never aggregated across regs.

---

## Scripts

All scripts live in `scripts/`. Use `const ROOT = path.join(__dirname, '..');` for data paths.
Workflows reference scripts as `node scripts/filename.js`.

| Script | Purpose | Status |
|--------|---------|--------|
| **Nightly / Automated** | | |
| `nightly-crawl.js` | Grade rounds → fixture fetch → spectator → player records → new stubs | Nightly 01:00 AEST |
| `build-leaderboards.js` | Leaderboard files (full or --active-only) | After nightly crawl |
| `build-search-index.js` | Rebuild player search shards | After nightly crawl |
| `update-team-index.js` | Add new teams to team-index.json | After nightly crawl |
| `update-venue-lookup.js` | Add venue date files for scored games | After nightly crawl |
| `build-venue-indexes.js` | dates.json, date-venue-index, season-venue-index | After venue lookup |
| `build-team-stats.js` | Team roster + fixture files (--active-only) | Weekly Sunday |
| `build-player-games.js` | Player games[] arrays for opposition view | Weekly Sunday |
| `recheck-private-profiles.js` | Re-probe private/stale active players | Monthly 1st |
| **Data repair** | | |
| `fetch-profile-stats.js` | publicProfileStatistics matrix (256 shards) | On demand / new players |
| `build-forfeit-index.js` | Scan game files, build forfeit-games.json | One-time ✅ |
| `recheck-forfeit-games.js` | Probe 20-0/0-20 games via discoverGame | One-time |
| `fix-forfeit-player-records.js` | Clear forfeit-contaminated player records | One-time |
| `fetch-leaderboard-records.js` | Backfill gameKey for leaderboard players | One-time |
| `backfill-player-records.js` | Backfill records from hp/ap (between seasons) | Between seasons |
| `build-records.js` | records/all-time.json single-game records | On demand |
| **One-time augmentation (complete)** | | |
| `augment-venue-lookup.js` | Add sid/hid/aid/comp/grade to venue entries | Complete ✅ |
| `augment-team-index.js` | Add comp/grade to team-index.json | Complete ✅ |
| `augment-game-grades.js` | Add gid/gn to game entries | Complete ✅ |
| `migrate-phase1.js` | p arrays, indexes, team/venue index | Complete ✅ |
| `migrate-phase2.js` | team-stats, venue-lookup restructure | Complete ✅ |
| `migrate-phase3.js` | search/players shards | Complete ✅ |
| **Diagnostics** | | |
| `test-discover-game.js` | Test discoverGame for a game ID | On demand |
| `test-profile-query.js` | Test publicProfileStatistics for a UUID | On demand |
| `db-report.js` / `db-audit.js` | Database state report | On demand |

---

## Cloudflare Worker

Game box scores served on-demand via `solitary-snowflake-cb3e.insanoflash.workers.dev`.

**Route:** `GET /spectator/{gameId}[?tenant=bv]`

**Response:**
```json
{
  "h": [{"profileID": "...", "name": "...", "number": 7, "pts": 12, "pt1": 0, "pt2": 4, "pt3": 1, "fouls": 2}],
  "a": [...],
  "hq": [22, 18, 24, 21],
  "aq": [18, 20, 19, 25]
}
```
- `hq`/`aq` are omitted (not null) when period data is unavailable
- OT supported — arrays can have 5+ elements (Q1→Q2→Q3→Q4→OT1→OT2...)
- CORS allows `https://markjovic.github.io`

**StatTrack flow:**
1. Game entry (score, teams, venue) renders from static data immediately
2. If `hp`/`ap` stored on game entry → render directly, no API call
3. Otherwise → call Worker → spectator `game(id)` → render box score + quarter scores
4. Cache per gameId in session memory

---

## PlayHQ API summary

See `playhq_api_reference.md` for full query reference.

- Main API: `api.playhq.com/graphql` — tenant: `basketball-victoria` (full name, never `bv`)
- Spectator: `spectator.playhq.com/graphql` — tenant: `bv` + `x-phq-tenant: bv` + 3 cookies
- Mandatory three-step probe for all game classification
- Never `new Date()` for date parsing — split strings directly
- Cookie TTL: 24 hours

---

## Maintenance schedule

### Nightly (01:00 AEST — `nightly-crawl.yml`)
1. `nightly-crawl.js` — grade rounds, fixture fetch, spectator box scores, player records, new stubs
2. Downstream jobs in parallel: leaderboards, search-index, team-index, venue-lookup, venue-indexes
3. Triggers matrix for new stubs; self-triggers if gamesRemaining > 0

### Weekly (Sunday 12:00 AEST — `weekly-indexes.yml`)
- `build-team-stats.js --active-only`
- `build-player-games.js`

### Monthly (1st of month — `recheck-private-profiles.yml`)
- Re-probe private-marked players (30-day threshold)
- Re-probe active-season players whose statsChecked is older than 90 days

### Annual / on demand
- `build-leaderboards.js` full rebuild (no `--active-only`)
- `build-records.js --force`

---

## Future: multi-sport expansion

### Architecture (resolved — Option B)
Player identity is shared across sports; game data is per-sport.

- This repo (`sports-players-stats`) becomes the **shared player layer** — `players/`, `search/`, `players/indexes/` serve all sports
- Each new sport gets its own repo (`afl-players-data`, etc.) with sport-namespaced game/team/venue data
- UUIDs are PlayHQ profile-level (sport-agnostic) — the same UUID appears in basketball and AFL datasets for the same person
- StatTrack fans out fetches across sport repos in parallel; no HTML routing changes needed

### Cross-sport opposition index
To support "has this player faced any of these players before, in any sport?" efficiently, player detail files will carry an `opponents` array — every UUID they've shared a `p[]` array with, across all sports. This turns an O(games) scan into an O(1) set intersection. Not built yet — planned after AFL is added.

### Repo size
- History squash before adding AFL — reduces repo size ~60-70% with zero data impact
- Per-sport repos keep each dataset independently manageable
- See `stattrack_html_design.md` Multi-sport architecture section for full design

---

## Data integrity rules

1. Never allow one sport's crawl to overwrite another sport's player data
2. Never re-stub IDs in `seasons-invalid.json` or `seasons-skipped.json`
3. `teams[]` on player files = slim refs only `{tid, sid, status}`
4. Never store more than 32px logo URL
5. Never `new Date()` for date parsing — split strings directly
6. `hs: null` = confirmed unavailable. `hs: undefined` = never checked
7. `noProfile` and `noVenue` are timestamps, not booleans — retry after 30 days
8. Progress files must be committed at every save interval
9. Never `git pull --rebase` — always `--rebase=false -X ours`
