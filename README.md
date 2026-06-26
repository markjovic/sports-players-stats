# sports-players-stats

Player-centric database for PlayHQ basketball competitions. Builds a searchable database of every player across all Basketball Victoria competitions — career stats, season registrations, game results, venue data, and team registrations — served via the StatTrack HTML PWA.

---

## Current state (June 2026)

| Metric | Value |
|--------|-------|
| Seasons | 2,792 (418 active, 2,374 locked) |
| Player index entries | 369,428 |
| Player detail files | 369,437 |
| Total games | 2,247,971 |
| Forfeit games | 23,839 |
| Unique venues | 532 |
| Search shards | ~630 files / name-prefix keyed |
| StatTrack | Beta 0.35 live at `markjovic.github.io/stattrack` |
| publicProfileStatistics | Matrix force run in progress (~100% on completion) |
| Nightly crawl | Running — CONCURRENCY_GRADES=500, CONCURRENCY_FIXTURES=500 |

**Game classification:**

| Flag | Count | Meaning |
|------|-------|---------|
| *(none — normal)* | ~1.66M | Full data |
| `hidden: true` | ~424,700 | Admin-hidden grade |
| `profileOnly: true` | 131,633 | Pre-e-score era |
| `legacy: true` | ~3,400 | All routes exhausted — spectator returned null |
| `forfeit: true` | 23,839 | Won by forfeit |
| `cancelled: true` | ~3,400 | Cancelled |
| `abandoned: true` | ~539 | Abandoned |

---

## Repository structure

```
sports-players-stats/
├── sports-index.json              # Season metadata (2,792 seasons)
├── team-index.json                # Team search by season name
├── venue-index.json               # 532 venues
├── season-venue-index.json        # { seasonId: [venueId, ...] }
├── forfeit-games.json             # 23,839 sorted forfeit game IDs
├── needs-matrix-shards.json       # Written by nightly; consumed by matrix trigger
├── records/
│   └── all-time.json              # Single-game records
├── scripts/                       # All pipeline scripts
├── search/players/{xx}.json       # ~630 name-prefix search shards
├── team-stats/bv/{seasonId}.json  # Team rosters + fixtures (2,792 files)
├── leaderboard/
│   ├── all-time.json              # 2,000 per category, 15 categories
│   └── season/{seasonId}.json    # Normalized schema (see below)
├── venue-lookup/
│   ├── {venueId}/dates.json
│   └── {venueId}/{YYYY-MM-DD}.json
├── date-venue-index/{YYYY-MM-DD}.json
├── games/bv/{seasonId}.json
└── players/
    ├── indexes/{00-ff}.json       # 256 shards
    └── {00-ff}/{uuid}.json        # 369,437 files
```

---

## JSON schemas

### sports-index.json
```json
{
  "seasons": {
    "10107609": {
      "id": "10107609", "name": "Summer 2021/22",
      "fullName": "Domestic — Summer 2021/22",
      "compName": "Domestic", "compId": "9bc0c89d",
      "orgName": "Moe Basketball Association", "orgId": "7d61a534",
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
  "t1": "teamId1", "t1n": "Team Name 1",
  "t2": "teamId2", "t2n": "Team Name 2",
  "gid": "5afff92b", "gn": "Boys Under 14 D3",
  "hp": [{"profileID": "uuid", "name": "Sam B", "number": 7, "pts": 12, "pt1": 0, "pt2": 4, "pt3": 1, "fouls": 2}],
  "ap": [...],
  "p": [{"id": "uuid", "n": "Sam B"}]
}
```

**Team field rules:**
- `h`/`hn` + `a`/`an` = absolute orientation (never both with t1/t2)
- `t1`/`t1n` + `t2`/`t2n` = unknown orientation (hidden grades)
- `gid`/`gn` on all games

**Game URL shortcut:** `https://www.playhq.com/basketball-victoria/org/a/a/a/game-centre/{gameId}` — only the gameId matters; other path segments are irrelevant fillers. Confirmed for BV.

### players/{xx}/{uuid}.json
```json
{
  "uuid": "0afc7690-...", "name": "Toby Jovic", "gender": "Boys",
  "sports": {
    "Basketball": {
      "gp": 83, "pts": 371, "fouls": 129, "fg": 169, "ft": 24, "threePt": 3,
      "finals": 2, "gfApps": 2, "gfWins": 2, "finalsPerSeason": 0.29,
      "foulOuts": {"e26f328b": 1, "f1fdda91": 2},
      "maxGamePTS": 16, "maxGameThreePt": 1,
      "statsChecked": "2026-06-25T11:56:01.450Z"
    }
  },
  "records": {
    "maxGamePTS":     {"v": 16, "gameKey": "4c48f539", "sid": "68f8c050"},
    "maxGameThreePt": {"v": 1,  "gameKey": "d1d4a7ae", "sid": "68f8c050"}
  },
  "seasons": [{
    "sid": "15908988", "sn": "Winter 2026", "club": "Spirit Magic Basketball Club",
    "sport": "Basketball",
    "regs": [{
      "tid": "502c83d9", "tn": "B13 Spirit Magic 2",
      "gid": "2b1f7042", "gn": "Saturday U13 Boys D", "age": "U13", "div": null,
      "stats": {"gp": 4, "pts": 19, "fouls": 6, "fg": 9, "ft": 1, "threePt": 0,
                "foulOuts": 0, "finals": 0, "gfApps": 0, "gfWins": 0}
    }]
  }],
  "games": ["gameId1", "gameId2"],
  "teams": [{"tid": "502c83d9", "sid": "15908988", "status": "ACTIVE"}],
  "updatedAt": "2026-06-03T12:36:42.783Z"
}
```

**Key data rules:**
- `foulOuts`: `{ seasonId: count }` where count = games with TOTAL_FOULS >= 5
- `finals`/`gfApps`/`gfWins` per-reg: **boolean per season** (max 1, never incremented beyond)
- `finalsPerSeason`: seasons_with_finals / total_seasons_with_games (≤ 1 always)
- All career + per-reg stats written by `fetch-profile-stats.js` with `seenGameKeys` dedup
- `statsChecked` cleared when nightly updates stats → triggers matrix re-validation

### players/indexes/{xx}.json
```json
{
  "0afc7690-...": {
    "name": "Toby Jovic",
    "history": {
      "15908988": ["502c83d9"],
      "68f8c050": ["ac09183b"]
    }
  }
}
```
`history`: `{ seasonId: [teamId, ...] }` — built from seasons[].regs[].tid

### leaderboard/all-time.json
Denormalized entries, 2,000 per category, 15 categories:
```json
{
  "pts": [{"uuid": "...", "name": "...", "org": "...", "gp": 120, "v": 1842, ...}]
}
```

### leaderboard/season/{seasonId}.json — normalized schema
```json
{
  "pts": [{"id": "uuid|tid|sid", "v": 222}],
  "ppg": [{"id": "uuid|tid|sid", "v": 12.5}],
  "players": {
    "uuid|tid|sid": {
      "n": "Name", "team": "...", "org": "...", "comp": "...",
      "grade": "Saturday U12 Boys B", "age": "U12", "gender": "Boys",
      "gp": 13, "foulOuts": 1, "foulOutsPG": 0.077,
      "threePtPG": 0, "foulsPG": 1.615, "finals": 0, "gfApps": 0, "gfWins": 0
    }
  }
}
```
12 SEASON_CATS (no maxGamePTS, maxGameThreePt, finalsPerSeason). No entry cap.
StatTrack `denormSeason()` expands `{id,v}` + players map to full denormalized format before caching.

### team-stats/bv/{seasonId}.json
```json
{
  "9977add9": {
    "meta": {"name": "Spirit Magic U14 Boys", "club": ""},
    "roster": {
      "uuid1": {"name": "Player", "gp": 6, "pts": 42, "fg": 18, "ft": 4, "threePt": 2, "fouls": 8}
    },
    "fixtures": [
      {"gameId": "...", "date": "2026-05-30", "rn": "Round 5",
       "oppId": "tid2", "oppName": "Opponent", "result": "W", "score": "45-38", "st": "FINAL"}
    ]
  }
}
```
Rosters populated from player index history (covers all grade types, not just hidden).

### search/players/{xx}.json
```json
{
  "Toby Jovic": [{"id": "0afc7690-...", "c": "Spirit Magic Basketball Club", "t": "B13 Spirit Magic 2"}],
  "Jovic, Toby": [{"id": "0afc7690-...", "c": "Spirit Magic Basketball Club", "t": "B13 Spirit Magic 2"}]
}
```
Shard key = first 2 chars of entry key (player name), lowercase. ~630 files.

---

## Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| **Nightly chain** | | |
| `nightly-crawl.js` | Grade rounds → fixtures → spectator → stubs | CONCURRENCY 500/500/3 |
| `build-leaderboards.js` | Leaderboard files | ESM; normalized season schema |
| `build-search-index.js` | Search shards (name-prefix) | |
| `update-team-index.js` | team-index.json | |
| `update-venue-lookup.js` | Venue date files | |
| `build-venue-indexes.js` | Date/season indexes | |
| `build-team-stats.js` | Team rosters + fixtures | Uses player index history |
| **Matrix** | | |
| `clear-stats-checked.js` | Clear statsChecked (force pre-job) | |
| `fetch-profile-stats.js` | publicProfileStatistics — all stats | BATCH_SIZE=30 |
| **Periodic** | | |
| `build-player-games.js` | Player games[] arrays | Weekly |
| `recheck-private-profiles.js` | Re-probe private/stale players | Monthly |
| **On demand** | | |
| `build-finals-stats.js` | Boolean finals stats from game files | ESM; pending run |
| `recheck-forfeit-games.js` | Expand forfeit-games.json | Annual |
| `build-records.js` | records/all-time.json | Seasonal |
| `backfill-player-records.js` | Backfill records.gameKey | Between seasons |
| **Diagnostics** | | |
| `db-audit.js` / `db-report.js` / `repo-size.js` | Database state | |
| `inspect-hidden-reclassified.js` | Inspect reclassified games from git | |
| `test-grade-concurrency.js` | Test discoverGrade concurrency limits | |
| `test-spectator-concurrency.js` | Test spectator concurrency limits | |
| **Delete (complete/superseded)** | | |
| All `migrate-*.js`, `augment-*.js`, `backfill-*.js`, `cleanup-*.js`, `recover-*.js` | One-time complete | ✅ delete |
| `classify-games.js`, `discover-fixtures.js` | Superseded by nightly | ✅ delete |
| `fetch-player-profiles.js`, `build-foulout-stats.js` | Superseded by fetch-profile-stats.js | ✅ delete |
| `fetch-playhq.js` | Original crawl — double-counting bugs | ✅ delete |
| All `probe-*.js`, `explore-playhq-auth.js`, `fetch-lineup-auth.js` | One-time probes | ✅ delete |
| `backfill-spectator.js`, `fix-*.js` | One-time complete | ✅ delete |

---

## Maintenance schedule

### Nightly (01:00 AEST — `nightly-crawl.yml`)
1. `nightly-crawl.js` — all phases
2. Parallel downstream: team-stats, leaderboards, search-index, team-index, venue-lookup, venue-indexes
3. Triggers targeted matrix for players whose stats changed
4. Self-triggers if gamesRemaining > 0

### Weekly (Sunday — `weekly-indexes.yml`)
- `build-player-games.js`

### Monthly (1st — `recheck-private-profiles.yml`)
- Re-probe private-marked and stale active-season players

### After each finals series
- `build-finals-stats.js` — update finals stats from game files
- `build-leaderboards.js --force` — rebuild leaderboards

---

## PlayHQ API summary

- Main API: `api.playhq.com/graphql` — tenant `basketball-victoria`
- Spectator: `spectator.playhq.com/graphql` — tenant `bv` + `x-phq-tenant: bv`
- Cookie order critical: `phq_tier` → `phq_session` → `phq_sub`
- Rate limits: only `publicProfileStatistics` has a JWT quota (~30-35 calls); all other endpoints unlimited
- Session TTL: ~30-40 min; gqlMain refreshes on 403 for non-profile operations
- See `playhq_api_reference.md` for full query reference

---

## Future: multi-sport expansion

- This repo becomes the shared player layer
- AFL gets its own repo (`afl-players-data` etc.)
- Same UUIDs span sports (PlayHQ profile-level)
- History squash needed before AFL to reduce repo size
- R2 or equivalent hosting needed when combined data exceeds Pages limits
