# sports-players-stats

Player-centric database for PlayHQ basketball competitions. Builds a searchable database of every player across all Basketball Victoria competitions — career stats, season registrations, game results, venue data, and team registrations — served via the StatTrack HTML PWA at `markjovic.github.io/stattrack`.

---

## Current state (July 2026)

| Metric | Value |
|--------|-------|
| Seasons | 2,792 (418 active, 2,374 locked) |
| Player index entries | 369,428 |
| Player detail files | 369,437 |
| Total games | 2,248,309 |
| Forfeit games | 23,868+ |
| Unique venues | 532 |
| Search shards | ~630 files / name-prefix keyed |
| StatTrack | Beta 0.57+ live at `markjovic.github.io/stattrack` |
| publicProfileStatistics | Full matrix run completed June 2026 |
| Nightly crawl | Active — cron 01:00 AEST daily |
| Win/loss records | Active — nightly delta + weekly full |
| Repo size | ~8.6 GB (post-cleanup June 2026) |

---

## Architecture overview

The system has three data layers, each with a single authoritative writer:

### Layer 1 — Game data
Written exclusively by `nightly-crawl.js`. Contains everything from games: scores, fixtures, venues, player lists, box scores.

Files: `games/bv/`, `team-stats/bv/`, `venue-lookup/`, `date-venue-index/`

### Layer 2 — Player data
Written by:
- `fetch-profile-stats.js` (matrix) — all career + per-reg stats + player name
- `nightly-crawl.js` — new player stubs and new reg entries only
- `build-win-loss.js` — wins/losses/draws/winPct from game files
- `build-finals-stats.js` — finals/gfApps/gfWins/finalsPerSeason from game files
- `build-foulout-stats.js` — foulOuts from API

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
    │
    ├── nightly-crawl.js (Phase 3)
    │       spectator game(id) for FINAL games
    │       → games/bv/{sid}.json (box scores, p[], hp/ap, spc:1)
    │       → players/{xx}/{uuid}.json (new regs for existing players)
    │       → players/indexes/{xx}.json (index history)
    │       → needs-matrix-shards.json
    │       → clears statsChecked on players who appeared tonight
    │
    ├── nightly-crawl.js (Phase 4)
    │       → players/{xx}/{uuid}.json (new player stubs with name from spectator)
    │       → players/indexes/{xx}.json (new index entries)
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
    build-leaderboards.js   → leaderboard/all-time.json, leaderboard/season/
    build-search-index.js   → search/players/{xx}.json
    build-records.js        → records/all-time.json
```

---

## Repository structure

```
sports-players-stats/
├── data/                              ← Root JSON files (migrated June 2026)
│   ├── sports-index.json              # All season metadata (2,792 seasons)
│   ├── team-index.json                # Team search index by year/season name
│   ├── venue-index.json               # 532 venue entries [{id, n}]
│   ├── season-venue-index.json        # { seasonId: [venueId, ...] }
│   ├── forfeit-games.json             # Sorted array of forfeit game IDs (23,868+)
│   ├── seasons-discovered.json        # Seasons found during discovery
│   ├── seasons-skipped.json           # Seasons skipped (wrong tenant etc.)
│   └── seasons-invalid.json           # Invalid season IDs
├── games/bv/{seasonId}.json           # All games per season (2,792 files)
├── players/
│   ├── indexes/{00-ff}.json           # 256 player index shards
│   └── {00-ff}/{uuid}.json            # 369,437 player detail files
├── team-stats/bv/{seasonId}.json      # Team rosters + fixtures (2,792 files)
├── leaderboard/
│   ├── all-time.json                  # 20 categories, 2,000 entries each
│   └── season/{seasonId}.json        # 17 per-season categories, normalised
├── search/players/{xx}.json           # ~630 name-prefix search shards
├── venue-lookup/
│   ├── {venueId}/dates.json           # Sorted list of dates with games at venue
│   └── {venueId}/{YYYY-MM-DD}.json   # Games at venue on that date
├── date-venue-index/{YYYY-MM-DD}.json # All venues with games on a date
├── records/all-time.json             # Single-game records
├── scripts/                          # All pipeline scripts (~46 files)
└── .github/workflows/               # All GitHub Actions workflows
```

**CRITICAL:** All root JSON files are in `data/`. Any script referencing `path.join(ROOT, 'sports-index.json')` is broken — use `path.join(ROOT, 'data', 'sports-index.json')`.

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
  "playerCount": 369437
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
- `legacy: true` — not found via any API (all three steps null)
- `spc: 1` — spectator data has been stored (hp/ap present)
- `nullScore: true` — game played but scores genuinely 0-0

### players/{xx}/{uuid}.json

```json
{
  "uuid": "0afc7690-c2db-4644-b039-af1c34520af3",
  "name": "Toby Jovic",
  "gender": "Male",
  "sports": {
    "Basketball": {
      "gp": 83, "pts": 371, "fg": 169, "ft": 24, "threePt": 3, "fouls": 129,
      "finals": 2, "gfApps": 2, "gfWins": 2, "finalsPerSeason": 0.29,
      "foulOuts": { "68f8c050": 1 },
      "maxGamePTS": 16, "maxGameThreePt": 1,
      "wins": 45, "losses": 32, "draws": 2, "winPct": 0.58,
      "statsChecked": "2026-06-26T10:00:00.000Z"
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

### leaderboard/all-time.json

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

### leaderboard/season/{seasonId}.json

```json
{
  "players": {
    "uuid1|tid1": {
      "n": "John Smith", "team": "Knox U18 Boys A", "org": "Eastern BV",
      "comp": "Domestic", "grade": "U18 Boys A",
      "age": "U18", "gender": "Male",
      "gp": 14, "foulOuts": 1, "foulOutsPG": 0.071,
      "threePtPG": 0.5, "foulsPG": 2.1,
      "finals": 1, "gfApps": 1, "gfWins": 0,
      "club": "Knox"
    }
  },
  "pts": [{"id": "uuid1|tid1", "v": 180}],
  "wins": [{"id": "uuid1|tid1", "v": 10}],
  "winPct": [{"id": "uuid1|tid1", "v": 71}]
}
```

Note: `id` format is `uuid|tid` (NOT `uuid|tid|sid` — sid stripped June 2026).
`winPct`/`lossPct` stored as integer 0–100.

### search/players/{xx}.json

```json
{
  "john smith": [{"id": "uuid1", "c": "Knox BC", "t": "Knox U18 Boys A"}],
  "smith john": [{"id": "uuid1", "c": "Knox BC", "t": "Knox U18 Boys A"}]
}
```

Both first-name-last-name and last-name-first-name formats stored.
Values are arrays — multiple players can share the same name key.

---

## Scripts reference

| Script | Module | Purpose | Frequency |
|--------|--------|---------|-----------|
| `nightly-crawl.js` | CJS | Phases 1-4: discover → fixture → spectator → stub | Nightly |
| `fetch-profile-stats.js` | CJS | publicProfileStatistics per player (matrix) | Nightly targeted / periodic full |
| `build-team-stats.js` | CJS | Team rosters + fixtures from game files | Nightly downstream |
| `update-team-index.js` | CJS | Adds new teams to team-index.json | Nightly downstream |
| `update-venue-lookup.js` | CJS | Adds venue day files from FINAL+UPCOMING+POSTPONED games | Nightly downstream |
| `build-venue-indexes.js` | CJS | Rebuilds dates.json + date-venue-index from venue-lookup | Nightly downstream |
| `build-win-loss.js` | CJS | Computes W/L/D from game files, writes to player files | Nightly delta / weekly full |
| `build-player-games.js` | CJS | Rebuilds player.games[] arrays | Weekly |
| `build-finals-stats.js` | **ESM** | Finals/GF stats from game files (pre-pass for side resolution) | Manual after finals |
| `build-leaderboards.js` | **ESM** | Full leaderboard rebuild (20 all-time, 17 per-season) | Manual / matrix downstream |
| `build-foulout-stats.js` | CJS | foulOuts from API (TOTAL_FOULS >= 5 per game) | Manual |
| `build-search-index.js` | CJS | Player name search shards | Manual / matrix downstream |
| `build-records.js` | CJS | Single-game records (team + player) | Manual / matrix downstream |
| `discover-fixtures.js` | CJS | Discovers new seasons from PlayHQ | Manual |
| `clear-stats-checked.js` | CJS | Clears statsChecked (bulk or fix-corrupt-names mode) | Manual |
| `recheck-private-profiles.js` | CJS | Re-probes private/stale active-season players | Monthly |
| `recheck-forfeit-games.js` | CJS | Verifies forfeit-games.json | Annual |
| `db-audit.js` | CJS | Full database audit + repo size breakdown | On demand |
| `diagnose.js` | CJS | Player/game/hidden diagnostics (multiple modes) | On demand |
| `test-api.js` | CJS | API diagnostics (concurrency/profile/game/schema/gps modes) | On demand |
| `diagnose-nightly-health.js` | CJS | Pipeline health check via GitHub API | On demand |
| `strip-redundant-fields.js` | CJS | One-off: strip redundant fields from player/game files | One-off (done) |
| `migrate-data-dir.js` | CJS | One-off: moved root JSON to data/ | One-off (done) |

---

## Data integrity rules

1. **`seenGameKeys` in `fetch-profile-stats.js`** — NEVER remove. Prevents double-counting.
2. **`finals`/`gfApps`/`gfWins` per-reg** — boolean per season (max 1). Career = count of qualifying seasons.
3. **`finalsPerSeason`** — always from `seasons_with_regs` count, never from `gp`.
4. **`fetch-playhq.js`** — permanently retired, double-counting bugs. Never re-run.
5. **Spectator before legacy** — always probe spectator before marking `legacy: true`.
6. **Never `git pull --rebase`** — always `git fetch origin main` + `git merge -X ours FETCH_HEAD`.
7. **Progress files** — commit at every interval, not just at end.
8. **Multi-sport integrity** — when AFL added, preserve other sports' seasons in `fetch-profile-stats.js`.
9. **`statsChecked`** — sole mechanism controlling matrix re-fetches.
10. **`forfeit-games.json`** — loaded by `fetch-profile-stats.js` and `build-leaderboards.js`.
11. **`hp`/`ap` vs `g.p[]`** — `g.p[]` has no side info. Cross-reference team-stats roster.
12. **`update-venue-lookup.js`** — must include UPCOMING, POSTPONED, FINAL; update entries when status changes.
13. **`data/` prefix** — all root JSON files now at `data/`. Scripts must use `path.join(ROOT, 'data', 'filename.json')`.
14. **Per-reg W/L/D in StatTrack** — take from `regs[0]` only (all regs same tid have same value; summing duplicates for regraded players).
15. **`gameTids` on player file** — `{gameId: tid}`, written only for players with multiple tids in same season. Used by `build-win-loss.js` and StatTrack to resolve which team per game.

---

## Known issues and outstanding work

### Pending runs (do in order)
1. `build-finals-stats` full (delete `.finals-progress.json` first) — fixes gfWins for 77% of games
2. `build-win-loss` full — recomputes career W/L/D with regraded duplication fix
3. `build-leaderboards` full — populates all 20/17 categories including lossPct, age filter
4. `build-team-stats --active-only` — picks up recent fixtures
5. `update-venue-lookup` → `build-venue-indexes` — picks up upcoming/recent games

### Near-term
- Add `sport: "Basketball"` to each sports-index.json season entry (pre-AFL task)
- Fix `build-search-index.js` — shows first-ever team club, not current
- `backfill-hidden-boxscores.yml` — still needs one run
- GitHub Pages deploy trigger — currently triggers on every push; move to explicit dispatch
- History squash before AFL expansion
- R2 hosting before AFL expansion

### Future
- `build-opposition-index.js` — weekly pre-built per-player opponent W/L/D
- AFL expansion — separate game repo, shared player layer
- Full opponent history tab in StatTrack (needs opposition index)

---

## Maintenance schedule

| Frequency | What |
|-----------|------|
| Nightly 01:00 AEST | nightly-crawl.js → team-stats, venue-lookup, win-loss (active-only), matrix trigger |
| Weekly Sunday | build-player-games.js, build-win-loss.js full |
| Monthly 1st | recheck-private-profiles.js |
| After each finals series | build-finals-stats.js, build-leaderboards.js --force |
| Annually | recheck-forfeit-games.js |
