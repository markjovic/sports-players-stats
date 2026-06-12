# sports-players-stats

Player-centric scraper and database for PlayHQ basketball competitions. Builds a searchable database of every player across all Basketball Victoria competitions — player histories, career stats, season registrations, game results, venue data, and team registrations — for use in the StatTrack HTML viewer.

---

## Current state (June 2026)

| Metric | Value |
|--------|-------|
| Seasons | 2,792 (418 active, 2,374 completed) |
| Players (index) | 369,428 |
| Players (detail files) | 369,437 (fully consistent) |
| Unique teams | 357,284 |
| Unique venues | 532 |
| Total games | 2,247,971 |
| FINAL | 2,126,894 |
| UPCOMING | 64,788 |
| POSTPONED | 48,430 |
| BYE | 7,746 |

**Game classification (post classify-games.js sweep):**

| Flag | Count | Meaning |
|------|-------|---------|
| *(none — normal)* | ~1.74M | Full data, score + venue |
| `hidden: true` | 424,350 | Admin-hidden grade — score via spectator, no venue |
| `profileOnly: true` | 131,633 | Pre-e-score era — structure from player profiles, no score |
| `legacy: true` | 141 | All three classification routes exhausted |
| `forfeit: true` | 1,984 | Won by forfeit |
| `cancelled: true` | 3,893 | Cancelled |
| `abandoned: true` | 1,209 | Abandoned |
| `bye: true` | 0 | Bye rounds |
| `noProfile: <ts>` | 84,050 | Hidden, player profiles couldn't supply h/a/rn — retry after 30d |
| `noVenue: <ts>` | 424,153 | Hidden, venue not recoverable — retry after 30d |

---

## Repository structure

### Current (pre-migration)

```
sports-players-stats/
├── sports-index.json              # Season metadata
├── seasons-discovered.json        # All known seasons with comp/org metadata
├── seasons-skipped.json           # Failed crawl seasons
├── seasons-invalid.json           # Confirmed invalid season IDs
├── classify-games-progress.json   # Classification sweep resume state
├── classify-games-cookie.json     # Session cookie cache (24h TTL)
├── players/                       # Full player detail files
│   └── {xx}/{uuid}.json
├── players-index/                 # Career stats shards (→ players/indexes/ post-migration)
│   └── {xx}.json
├── games/bv/                      # Per-season game files
│   └── {seasonId}.json
├── team-lookup/                   # Team/comp/org metadata
│   └── {xx}.json
└── venue-lookup/                  # Venue address/courts
    └── {xx}.json
```

### Post-migration target

```
sports-players-stats/
├── sports-index.json
├── team-index.json                # Boot-time team search (TBD: sharded or flat)
├── venue-index.json               # Boot-time venue search (~20KB flat)
├── search/players/{aa-zz}.json   # 2-letter alpha player search shards
├── team-stats/bv/{seasonId}.json  # Pre-aggregated team rosters + fixtures
├── venue-lookup/{venueId}/{YYYY-MM-DD}.json
├── games/bv/{seasonId}.json       # p array replaces playerGames
└── players/
    ├── indexes/{00-ff}.json       # Career stats + history map
    └── {00-ff}/{uuid}.json
```

---

## Game file structure

```json
{
  "games": {
    "a613abfa": {
      "d":    "2026-05-30",
      "rn":   "Round 5",
      "h":    "89eed543",
      "hn":   "Vermont Vultures U14 Boys 8",
      "a":    "502c83d9",
      "an":   "Spirit Magic U14 Boys 2",
      "hs":   37,
      "as":   36,
      "hq":   [10, 8, 11, 8],
      "aq":   [9, 10, 7, 10],
      "hp":   [{ "profileID": "uuid", "name": "Sam B", "number": 7, "pts": 12, "pt1": 0, "pt2": 4, "pt3": 1, "fouls": 2 }],
      "ap":   [...],
      "st":   "FINAL",
      "vid":  "e5970e55-...",
      "vn":   "The Rings (Ringwood)",
      "ct":   "Court 2",
      "t":    "10:15",
      "url":  "https://www.playhq.com/...",
      "finals": true,
      "p":    ["uuid1", "uuid2"]
    }
  }
}
```

**Team fields — mutual exclusion:**
- `h`/`hn` + `a`/`an` = absolute (orientation known) — takes priority
- `t1`/`t1n` + `t2`/`t2n` = two participants, orientation unknown — used when h/a absent
- `o`/`on` = deprecated, fully removed by normalise-game-structure.js
- `h` supersedes `t1`/`t2` — never both simultaneously

**Flags:**

| Flag | Score | Venue | h/a | Display |
|------|-------|-------|-----|---------|
| *(none)* | ✅ | ✅ | ✅ | Normal |
| `hidden: true` | ✅ | ❌ | maybe | Score + "Hidden grade" |
| `profileOnly: true` | ❌ | ❌ | ✅ | Teams/round + "Historical record" |
| `forfeit: true` | ❌ | maybe | ✅ | "Forfeit — [desc]" |
| `legacy: true` | ❌ | ❌ | maybe t1/t2 | Minimal |
| `cancelled: true` | ❌ | maybe | ✅ | "Cancelled" |
| `abandoned: true` | maybe | maybe | ✅ | "Abandoned" |
| `bye: true` | ❌ | ❌ | ❌ | "Bye" |
| `noProfile: <ts>` | ✅ score | ❌ | ❌ | Score only, retry after 30d |
| `noVenue: <ts>` | ✅ | ❌ | ✅ | Normal except no venue |

---

## Player detail file structure

```json
{
  "uuid": "94b31aeb-...",
  "name": "Player Name",
  "gender": "Male",
  "sports": { "Basketball": { "gp": 123, "pts": 804, "fouls": 200, "fg": 345, "ft": 105, "threePt": 3 } },
  "seasons": [{
    "sid": "635c2c74",
    "sn": "Autumn 2026",
    "club": "Spirit Magic",
    "sport": "Basketball",
    "regs": [{
      "tid": "9977add9",
      "tn": "Spirit Magic U14 Boys",
      "gid": "5afff92b",
      "gn": "Boys Under 14 D3",
      "age": "U14",
      "div": null,
      "stats": { "gp": 6, "pts": 42, "fouls": 8, "fg": 18, "ft": 4, "threePt": 2 }
    }]
  }],
  "teams": [{ "tid": "9977add9", "sid": "0869ea69", "status": "UPCOMING" }],
  "teamsUpdatedAt": "2026-06-06T...",
  "updatedAt": "2026-06-06T..."
}
```

---

## Post-backfill database statistics (June 2026)

| Metric | Value |
|--------|-------|
| Score coverage | 99.8% |
| Venue coverage | 96.1% (62,499 genuinely missing from PlayHQ) |
| Player coverage | 100% across all 2,161,388 analysed games |
| Hidden games with venue preserved | 186 |
| Team field structure | 2,163,915 absolute h/a; 84,042 t1/t2; 10 t1-only; 4 bare |
| Flag collisions | 0 |

---

## Scripts

| Script | Purpose | Trigger |
|--------|---------|---------|
| `classify-games.js` | Three-step game classification sweep | Manual — run to zero queue |
| `normalise-game-structure.js` | Strip o/on, write t1/t2 | Complete ✅ |
| `cleanup-flag-collisions.js` | Remove legacy from hidden/profileOnly/etc games | As needed |
| `backfill-missing-players.js` | Crawl missing player detail files | Complete ✅ |
| `db-report.js` | Full database state report | Anytime |
| `fetch-playhq.js` | Full player crawl | New seasons / annual |
| `discover-fixtures.js` | Fixture/venue via discoverTeamFixture | Nightly (active seasons) |
| `diagnose-coverage-and-uuids.js` | Player coverage + UUID analysis | Complete ✅ |
| `diagnose-game-structure.js` | Structural diagnostic | On demand |
| `diagnose-season-games.js` | Per-season game detail | On demand |
| `diagnose-hidden-gaps.js` | Hidden game gap count | On demand |
| `find-game-id.js` | Find a game ID across all season files | On demand |

---

## Nightly crawl design (pending build)

For active seasons (`locked: false`):
1. `discover-fixtures` — `discoverTeamFixture` for all active teams → scores, venues, upcoming
2. Three-step classify probe for newly scored/status-changed games
3. `publicProfileTeams` for active players — mid-season changes + UPCOMING registrations
4. New season discovery — probe known comp IDs via `discoverSeason`
5. Lock completed seasons

Monthly:
- Re-probe games where `noProfile` or `noVenue` timestamp is >30 days old

Annual:
- Full re-crawl of `publicProfileStatistics` for all players — catches missed registrations

---

## PlayHQ API summary

See `playhq_api_reference.md` for full documentation.

Two endpoints:
- `api.playhq.com/graphql` — tenant: `basketball-victoria` (full name)
- `spectator.playhq.com/graphql` — tenant: `bv` + `x-phq-tenant: bv` + 3 cookies

**Mandatory three-step probe for all game classification.** See api reference.

---

## Data integrity rules

1. Never allow one sport's crawl to overwrite another sport's player data
2. Never re-stub IDs in `seasons-invalid.json` or `seasons-skipped.json`
3. `teams[]` on player files = slim refs only `{ tid, sid, status }` — full metadata in team-lookup
4. Never store more than the 32px logo URL
5. Never parse dates/times via `new Date()` — split strings directly
6. `hs: null` = confirmed unavailable. `hs: undefined` = never checked. Never write null for UPCOMING.
7. `noProfile` and `noVenue` are timestamps, not booleans — retry after 30 days
8. Progress files must be committed at every save interval, not just at run end

---

## Mid-run git commit pattern

```javascript
execSync('git add <dirs>', { stdio: 'pipe' });
const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
if (!diff) return;
execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
execSync('git push', { stdio: 'pipe' });
```

Never stash in scripts that flush data incrementally. Never `git pull --rebase`.
