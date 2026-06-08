# sports-players-stats

Player-centric scraper and database for PlayHQ basketball competitions. Builds a searchable database of every player across all Basketball Victoria competitions — player histories, career stats, season registrations, game results, venue data, and team registrations — for use in the StatTrack HTML viewer tool.

---

## Current state (June 2026)

| Metric | Value |
|--------|-------|
| Seasons | 2,792 (418 active, 2,374 completed) |
| Players (index) | 369,428 |
| Player detail files | ~329k |
| Unique teams | 357,284 |
| Unique venues | 532 |
| Total games | 2,247,971 |
| Scored games | 1,700,408 (81.5% of eligible) |
| Games with venue | 1,627,016 (78.0% of eligible) |

**Score gap explained:**
- ~380k games in zero-team/no-ladder seasons — `discoverGame` confirmed no score available, flagged `legacy: true`
- 1,948 forfeit games — no score by nature, flagged `forfeit: true`
- 86,964 admin-hidden grading rounds — score via spectator endpoint, no venue, flagged `hidden: true`
- 7,779 genuinely orphaned — no data via any API route, flagged `legacy: true`

---

## Repository structure

```
sports-players-stats/
├── fetch-playhq.js               # Main player crawl
├── discover-fixtures.js          # Fixture/venue discovery (discoverTeamFixture)
├── backfill-hidden-games.js      # Hidden/forfeit/legacy game detection
├── backfill-game-scores.js       # Score backfill (complete)
├── backfill-venue.js             # Venue backfill (complete)
├── bootstrap-fixture-progress.js # Generate diagnostic reports
├── recover-missing-seasons.js    # Recover seasons missing from index
├── fix-game-status.js            # Set st:FINAL on completed games
├── db-report.js                  # Full database state report
├── roster-lookup.js              # Pre-season team roster lookup
├── probe-games.js                # Diagnostic: inspect game IDs
├── find-season-players.js        # Find players by season/game ID
├── team-lookup-utils.js          # Shared team-lookup shard utilities
├── playhq_api_reference.md       # Full PlayHQ GraphQL API reference
├── sports-index.json             # Season metadata index (2,792 seasons)
├── seasons-discovered.json       # All known seasons with comp/org metadata
├── seasons-skipped.json          # Seasons that failed during crawl
├── seasons-invalid.json          # Confirmed invalid season IDs
├── discover-fixtures-progress.json # Permanent done list for --all-seasons runs
├── backfill-hidden-progress.json # Resume state for hidden game backfill
├── no-venue-seasons.json         # Seasons with missing venue (bootstrap output)
├── zero-team-seasons.json        # Seasons with no ladder data (bootstrap output)
├── players/                      # Full player detail files (~988MB)
│   └── {xx}/{uuid}.json
├── players-index/                # Slim player records sharded by UUID prefix (~87MB)
│   └── {xx}.json
├── games/bv/                     # Per-season game files (~800MB+)
│   └── {seasonId}.json
├── team-lookup/                  # Team/comp/org metadata by team ID prefix (~122MB)
│   └── {xx}.json
└── venue-lookup/                 # Venue address/courts by venue ID prefix (~172KB)
    └── {xx}.json
```

---

## Data files

### Player detail file structure
```json
{
  "uuid": "94b31aeb-...",
  "name": "Player Name",
  "gender": "Male",
  "sports": { "Basketball": { "gp": 123, "pts": 804, "fouls": 200, "fg": 345, "ft": 105, "threePt": 3 } },
  "seasons": [{
    "sid": "635c2c74", "sn": "Autumn 2026", "club": "Spirit Magic", "sport": "Basketball",
    "regs": [{ "tid": "9977add9", "tn": "Spirit Magic U14 Boys", "gid": "5afff92b",
               "gn": "Boys Under 14 D3", "age": "U14", "div": null,
               "stats": { "gp": 6, "pts": 42, "fouls": 8, "fg": 18, "ft": 4, "threePt": 2 } }]
  }],
  "teams": [{ "tid": "9977add9", "sid": "0869ea69", "status": "UPCOMING" }],
  "teamsUpdatedAt": "2026-06-06T...", "updatedAt": "2026-06-06T..."
}
```

### Game file structure
```json
{
  "games": {
    "a613abfa": {
      "d":      "2026-05-30",
      "rn":     "Round 5",
      "h":      "89eed543",
      "hn":     "Vermont Vultures U14 Boys 8",
      "a":      "502c83d9",
      "an":     "Spirit Magic U14 Boys 2",
      "hs":     37,
      "as":     36,
      "st":     "FINAL",
      "vid":    "e5970e55-...",
      "vn":     "The Rings (Ringwood)",
      "ct":     "Court 2",
      "t":      "10:15",
      "url":    "https://www.playhq.com/basketball-victoria/org/...",

      "hidden":  true,   // admin-hidden grading round — score via spectator, no venue
      "forfeit": true,   // won by forfeit
      "fo":      "HOME", // forfeit winner: HOME or AWAY
      "desc":    "Team X won by forfeit",
      "legacy":  true    // genuinely orphaned — no data accessible
    }
  }
}
```

**Flag meanings:**

| Flag | Score | Venue | HTML display |
|------|-------|-------|--------------|
| *(none)* | ✅ | ✅ | Normal |
| `hidden: true` | ✅ | ❌ | Show score, "Hidden by competition admin" |
| `forfeit: true` | ❌ | ❌ | "Forfeit — [desc]", winner from `fo` |
| `legacy: true` | ❌ | ❌ | Date/opponent only, "Historical record" |

### Team lookup structure
```json
{
  "9977add9": {
    "name": "Spirit Magic U14 Boys",
    "logo": "https://assets.playhq.com/bv/c39ce5/32_32_logo.png",
    "orgId": "c39ce5dd", "orgName": "Spirit Magic Basketball Club",
    "gid": "5afff92b", "gn": "Boys Under 14 D3",
    "sid": "0869ea69", "sn": "2026",
    "compId": "42a6a017", "compName": "Junior Domestic - Saturday Competition (GEBC)",
    "compOrgId": "87b2f13c", "compOrgName": "Melbourne East Basketball Association (MEBA)",
    "startDate": "2026-03-01", "endDate": "2026-10-31"
  }
}
```

### Venue lookup structure
```json
{
  "e5970e55-...": {
    "name": "The Rings (Ringwood)", "abbr": "TRR",
    "lat": "-37.8328", "lng": "145.22177",
    "address": "362-378 Canterbury Road", "suburb": "Ringwood",
    "state": "VIC", "postcode": "3134", "country": "Australia",
    "courts": { "48f1d6f1-...": { "name": "Court 2", "abbr": "Crt2" } }
  }
}
```

---

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| PlayHQ Sports Scraper | Manual / self-triggering | Crawl one season per run |
| Discover Fixtures | Manual | Fixture/venue via discoverTeamFixture |
| Backfill Hidden Games | Manual | Hidden/forfeit/legacy detection; modes: default, --review-legacy, --review-unscored |
| Backfill Game Scores | Manual (complete) | Score backfill via discoverGame |
| Backfill Venue Data | Manual (complete) | Venue backfill via discoverGame |
| Bootstrap Fixture Progress | Manual | Generate diagnostic files |
| Recover Missing Seasons | Manual | Fix index/game file sync issues |
| Fix Game Status | Manual | Set st:FINAL on completed games |
| Database Report | Manual | Full db state report |
| Roster Lookup | Manual | Pre-season team roster |
| Probe Games | Manual | Inspect specific game IDs |
| Find Season Players | Manual | Find players by season or game ID |

---

## PlayHQ API summary

Two endpoints:
- **`api.playhq.com/graphql`** — main API, tenant: `basketball-victoria`
- **`spectator.playhq.com/graphql`** — live scoring + hidden games, tenant: `bv` + `x-phq-tenant: bv`

Primary fixture query: **`discoverTeamFixture(teamID)`** — works for all seasons. Do NOT use `discoverFixtureByRound` for historical seasons (returns empty).

Hidden game detection:
- `discoverGame` returns null (200 OK) → hidden grade → call `game(id)` on spectator
- `game(id)` also null → legacy flag
- `discoverGame` returns FORFEIT outcome → forfeit flag

See `playhq_api_reference.md` for full documentation.

---

## Data integrity rules

1. **Never allow one sport's crawl to overwrite another sport's data** — when AFL/cricket added, failed GitHub raw fetch MUST abort player write
2. **Never re-stub invalid/skipped season IDs**
3. **`teams[]` on player files = slim refs only** `{ tid, sid, status }` — full metadata in team-lookup shards
4. **Never store more than the smallest logo URL** (32px)
5. **Never parse dates/times via `new Date()`** — split strings directly
6. **`hs: null`** = score confirmed unavailable. **`hs: undefined`** = never checked. Never write null for UPCOMING games.
7. **sports-index.json must stay in sync with games/** — run `recover-missing-seasons` when db-report shows a gap

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

Always commit before pull. Never stash in scripts that flush data before committing. Never `git pull --rebase`.
