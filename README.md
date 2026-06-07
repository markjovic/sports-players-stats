# sports-players-stats

Player-centric scraper for PlayHQ basketball competitions. Builds a searchable database of every player across all Basketball Victoria competitions — player histories, career stats, season-by-season registrations, game results, venue data, and team registrations — for use in the StatTrack HTML viewer tool.

---

## Current state

- ~336k players crawled across ~1,953 seasons (Basketball Victoria, 2020–2026)
- All seasons 2020+ discovered and crawled — pre-2020 not available (BV migrated to PlayHQ ~2020)
- Game scores backfilled for ~1.08M games via `discoverGame`
- Team registration data (`publicProfileTeams`) stored on all player files as slim refs
- `team-lookup/` shards contain full team/comp/org metadata for 356k unique team IDs
- `venue-lookup/` shards being populated by `discover-fixtures.js`
- Fixture discovery (venue, court, time, URL) in progress for active seasons

---

## Repository structure

```
sports-players-stats/
├── fetch-playhq.js              # Main crawl script
├── backfill-game-scores.js      # Score backfill via discoverGame
├── discover-fixtures.js         # Fixture/venue discovery via discoverFixtureByRound
├── roster-lookup.js             # Pre-season team roster lookup
├── migrate-team-lookup.js       # One-off: slim player teams data → team-lookup shards
├── inspect-failed-games.js      # Diagnostic: inspect failed backfill games
├── repo-size.js                 # Diagnostic: repo size by folder
├── team-lookup-utils.js         # Shared: team-lookup shard read/write
├── playhq_api_reference.md      # Full PlayHQ GraphQL API reference
├── sports-index.json            # Season metadata index
├── seasons-discovered.json      # All known seasons with queue status
├── seasons-invalid.json         # Confirmed invalid season IDs
├── seasons-skipped.json         # Seasons that failed during crawl
├── backfill-progress.json       # Resume state for score backfill
├── run-summary.json             # Stats from last crawl run
├── players/                     # Full player detail files (329k files, ~1GB)
│   └── {xx}/{uuid}.json
├── players-index/               # Slim player records sharded by UUID prefix (87MB)
│   └── {xx}.json
├── games/bv/                    # Per-season game files (560MB+)
│   └── {seasonId}.json
├── team-lookup/                 # Team/comp/org metadata by team ID prefix (116MB)
│   └── {xx}.json
└── venue-lookup/                # Venue and court metadata by venue ID prefix
    └── {xx}.json
```

---

## Data files

| File/Folder | Purpose | Size |
|-------------|---------|------|
| `sports-index.json` | Season metadata — id, name, comp, org, grades, locked status | ~3MB |
| `players-index/{xx}.json` | Sharded slim player records — name, gender, career totals | ~87MB total |
| `players/{xx}/{uuid}.json` | Full player detail — seasons, regs, per-game stats, team refs | ~988MB total |
| `games/bv/{seasonId}.json` | Per-season: game metadata, scores, venue refs, URLs | ~560MB+ |
| `team-lookup/{xx}.json` | Team name, logo URL, org, comp, grade, season dates | ~116MB total |
| `venue-lookup/{xx}.json` | Venue name, address, lat/lng, courts | growing |
| `seasons-discovered.json` | All known seasons with name, comp, org, queue status | ~500KB |
| `backfill-progress.json` | Done/failed game IDs for score backfill resume | ~6MB |

---

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **PlayHQ Sports Scraper** | Manual / self-triggering | Crawl one season per run, chain continues until queue exhausted |
| **Backfill Game Scores** | Manual | Enrich game files with scores via `discoverGame`; also has review-failed mode |
| **Discover Fixtures** | Manual | Populate game files with venue/court/time/URL for active seasons via `discoverFixtureByRound` |
| **Roster Lookup** | Manual | Find registered players for a grade/team/comp before games are played |
| **Add Player** | Manual | Add a single player by UUID to the database |
| **Migrate Team Lookup** | Manual (one-off) | Convert bloated teams data on player files to slim refs + team-lookup shards |
| **Inspect Failed Games** | Manual | Analyse failed backfill games — round type, year distribution, sample URLs |
| **Repo Size Report** | Manual | Disk usage breakdown by folder and top N largest files |
| **Explore PlayHQ Auth** | Manual | Test API endpoints and discover available data |
| **Recover Discovered Seasons** | Manual | Fill seasons-discovered.json metadata, validate unknown IDs, clean queues |

---

## Crawl architecture

- **One season per run** — GitHub Actions job checks out, scrapes, commits, triggers next run
- **Self-triggering chain** — `modeCrawlAll` calls GitHub API to dispatch next workflow run
- **Two-tier queue** — priority (2023+, `locked: false`) exhausted first, then backlog (pre-2023)
- **200 concurrent requests** — grade page fetches and player profile fetches both parallelised
- **Auto-lock** — historical seasons (year < current) locked after crawl; games files never rewritten
- **Stub discovery** — new season IDs found in player histories written as stubs, queued for crawl
- **Invalid + skipped tracking** — failed seasons recorded in both `seasons-invalid.json` and `seasons-skipped.json`; never re-stubbed or re-queued
- **Error handling** — code errors exit(1) so Actions run shows ❌; skippable errors recorded and chain continues

---

## Player detail file structure

```json
{
  "uuid": "94b31aeb-...",
  "name": "Player Name",
  "gender": "Male",
  "sports": {
    "Basketball": { "gp": 123, "pts": 804, "fouls": 200, "fg": 345, "ft": 105, "threePt": 3 }
  },
  "seasons": [
    {
      "sid": "635c2c74",
      "sn": "Autumn 2026",
      "club": "Spirit Magic",
      "sport": "Basketball",
      "regs": [
        {
          "tid": "9977add9",
          "tn": "Spirit Magic U14 Boys",
          "gid": "5afff92b",
          "gn": "Boys Under 14 D3",
          "age": "U14",
          "div": null,
          "stats": { "gp": 6, "pts": 42, "fouls": 8, "fg": 18, "ft": 4, "threePt": 2 }
        }
      ]
    }
  ],
  "teams": [
    { "tid": "9977add9", "sid": "0869ea69", "status": "UPCOMING" }
  ],
  "teamsUpdatedAt": "2026-06-06T...",
  "updatedAt": "2026-06-06T..."
}
```

**`teams[]` stores slim refs only** — team name/logo/comp/org resolved from `team-lookup/{prefix}.json` by `tid`.

---

## Games file structure

```json
{
  "games": {
    "a613abfa": {
      "d":   "2026-05-30",
      "rn":  "Round 5",
      "h":   "89eed543",
      "hn":  "Vermont Vultures U14 Boys 8",
      "a":   "502c83d9",
      "an":  "Spirit Magic U14 Boys 2",
      "hs":  37,
      "as":  36,
      "vid": "e5970e55-744c-46fc-bd61-16c72b487939",
      "vn":  "The Rings (Ringwood)",
      "ct":  "Court 2",
      "t":   "10:15",
      "url": "https://www.playhq.com/basketball-victoria/org/..."
    }
  }
}
```

Fields populated at different stages:
- `d`, `rn`, `h/hn/a/an` — from player crawl (`publicProfileStatistics`)
- `hs`, `as` — from score backfill (`discoverGame`) or fixture discovery (`discoverFixtureByRound`)
- `vid`, `vn`, `ct`, `t`, `url` — from fixture discovery (`discoverFixtureByRound`, active seasons only)

---

## Team lookup structure (`team-lookup/{prefix}.json`)

```json
{
  "9977add9": {
    "name":        "Spirit Magic U14 Boys",
    "logo":        "https://assets.playhq.com/bv/c39ce5/32_32_logo.png",
    "orgId":       "c39ce5dd",
    "orgName":     "Spirit Magic Basketball Club",
    "gid":         "5afff92b",
    "gn":          "Boys Under 14 D3",
    "sid":         "0869ea69",
    "sn":          "2026",
    "compId":      "42a6a017",
    "compName":    "Junior Domestic - Saturday Competition (GEBC)",
    "compOrgId":   "87b2f13c",
    "compOrgName": "Melbourne East Basketball Association (MEBA)",
    "startDate":   "2026-03-01",
    "endDate":     "2026-10-31"
  }
}
```

---

## Venue lookup structure (`venue-lookup/{prefix}.json`)

```json
{
  "e5970e55-744c-46fc-bd61-16c72b487939": {
    "name":    "The Rings (Ringwood)",
    "abbr":    "TRR",
    "lat":     "-37.8328",
    "lng":     "145.22177",
    "address": "362 - 378 Canterbury Road",
    "suburb":  "Ringwood",
    "state":   "VIC",
    "postcode": "3134",
    "country": "Australia",
    "courts": {
      "48f1d6f1-cbc6-44e3-8da1-198cb8f58337": { "name": "Court 2", "abbr": "Crt2" }
    }
  }
}
```

---

## What can be queried from this dataset

**From player index (slim, 87MB — load shards on demand):**
- Player search by name
- Career leaderboards: most points, most games, most 3-pointers, most fouls, best PPG

**From player detail files (per-player fetch):**
- Season-by-season stat breakdown
- Club history
- Per-game stats — opponent, date, individual pts/fouls/ft/fg/3pt per game
- Current team registrations (via slim refs → team-lookup)
- "Played against" — all games vs a given opponent team

**From games files:**
- Highest team score in a game
- Biggest score margin
- Home vs away win rates
- Venue and court for each game
- Future fixture schedule

**From team-lookup shards:**
- Team metadata, logos, competition context

**From venue-lookup shards:**
- Venue address, coordinates for mapping
- Court breakdown — court-by-court schedule for a venue on a given day

---

## Key data integrity rules

1. **Never allow one sport's crawl to overwrite another sport's player detail data.** When AFL/cricket are added, a failed GitHub raw fetch MUST abort the player write — never proceed with empty `existingDetail` for a multi-sport database.

2. **Never re-stub or re-queue invalid/skipped season IDs.** Both `seasons-invalid.json` and `seasons-skipped.json` are checked before writing stubs and before routing to queues.

3. **Team data on player files must be slim refs only.** Full metadata (name, logo, comp, org) belongs in `team-lookup/` shards. Never store the full `publicProfileTeams` response on player files — it causes ~50KB bloat per player.

4. **Never store more than the smallest logo URL.** Team logos have 6 sizes — only store the 32px URL. Never store the full sizes array.

5. **Never parse game dates or times via `new Date()`** — timezone shifts corrupt values. Always split strings directly: `date.slice(0,10)`, `time.slice(0,5)`.

---

## Mid-run git commit pattern

Any long-running script that writes data incrementally MUST include mid-run git commits. Pattern:
```javascript
execSync('git add <files>', { stdio: 'pipe' });
execSync(`git commit -m "..."`, { stdio: 'pipe' });
const stashOut = execSync('git stash', { stdio: 'pipe' }).toString();
execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
if (stashOut.includes('Saved')) execSync('git stash pop', { stdio: 'pipe' });
execSync('git push', { stdio: 'pipe' });
```

Never rely solely on the workflow's final commit step — if the job times out, uncommitted writes are lost.

---

## Cron schedule

Disabled during initial crawl. Re-enable in `fetch-playhq.yml` once `crawl-all` completes:

```yaml
schedule:
  - cron: '0 20 * * 0,3'  # Monday and Thursday 6am AEST
```

---

## PlayHQ API

See `playhq_api_reference.md` for full endpoint documentation including all discovered queries, response shapes, authentication, and known limitations.

All requests require the mobile user-agent — requests without it get HTTP 403 from CloudFront WAF. Never split into separate public/mobile header objects.
