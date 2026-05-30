# Basketball Players

A player-centric data scraper for PlayHQ basketball competitions. Collects full match and stat history for every player across all reachable competitions, storing everything in a single JSON database for querying and display.

---

## Architecture

### Core concept

The scraper is **player-centric, history-first**. Starting from one or more competition season IDs, it:

1. Enumerates all grades in the season
2. Collects every player UUID from every grade
3. Fetches each player's **full PlayHQ history** — every season, every comp, every team, every game
4. Stores it all in `bball-data.json`

Because `publicProfileStatistics` returns a player's entire cross-sport history (not just the seeded comp), the database naturally grows to cover all competitions those players have ever participated in. New season IDs discovered in player histories are flagged for subsequent crawl runs.

### Data model

```
bball-data.json
├── players: { [uuid]: PlayerRecord }
│   └── PlayerRecord
│       ├── uuid, name, updatedAt
│       └── seasons: [ SeasonEntry ]
│           ├── seasonId, seasonName, clubName
│           └── registrations: [ Registration ]
│               ├── teamId, teamName, gradeId, gradeName
│               ├── ageGroup (parsed), division (parsed)
│               ├── stats: { gp, pts, fg, ... }
│               └── games: [ GameEntry ]
│                   ├── gameId, date, round
│                   ├── home, away (id + name)
│                   ├── oppTeamId, oppName  ← key for "played against"
│                   └── stats: { per-game stats }
└── seasons: { [seasonId]: SeasonMeta }
    ├── id, name, fullName, compName, orgName
    ├── grades: [ { id, name, age, gender } ]
    └── locked: boolean  ← true = historical, never re-fetched
```

### Key design decisions

- **One player record per UUID** — a player on 3 teams across 2 comps has one record with multiple season/registration entries
- **Full history stored** — not filtered to the seeded comp; everything PlayHQ knows about the player
- **`oppTeamId` pre-computed** — each game stores which team the player was *not* on, enabling O(1) "played against" lookups
- **Locked seasons never re-fetched** — historical data is immutable once locked
- **Resume-capable** — `bball-progress.json` tracks per-player progress; interrupted runs continue from where they stopped

---

## Setup

Node.js 18+ required (uses native `fetch`).

```bash
git clone https://github.com/markjovic/basketball-players
cd basketball-players
# No npm install needed — uses Node built-ins only
```

---

## Usage

### First run — crawl a new season

```bash
node fetch-bball.js --mode=crawl --season=8ff9f39e
```

This will:
- Fetch all grades for the season
- Collect all player UUIDs
- Fetch full profile history for each player
- Log any new season IDs discovered in player histories
- Save to `bball-data.json` with resume support via `bball-progress.json`

### Crawl additional seasons (in order)

```bash
# Run each season separately — each adds to the existing database
node fetch-bball.js --mode=crawl --season=68f8c050   # Kilsyth After School Autumn 2026
node fetch-bball.js --mode=crawl --season=8ff9f39e   # Kilsyth Junior Domestic Winter 2026
node fetch-bball.js --mode=crawl --season=15908988   # MEBA Saturday Winter 2026
node fetch-bball.js --mode=crawl --season=43448c02   # MEBA Mon-Fri Winter 2026
```

After running all four, check the output for `💡 season IDs found in player histories` — these are additional comps discovered through player histories. Run each one to expand the database.

### Update active seasons (routine)

```bash
node fetch-bball.js --mode=update
```

Re-fetches all unlocked seasons. Run this after each round of games.

### Lock a completed season (end of year)

```bash
node fetch-bball.js --mode=lock --season=8ff9f39e
```

Marks the season as historical. It will never be re-fetched by `--mode=update`.

### Discover only (no profile fetches)

```bash
node fetch-bball.js --mode=discover --season=8ff9f39e
```

Enumerates grades and player UUIDs only — fast, no per-player API calls. Useful for checking what a season contains before committing to a full crawl.

---

## Stat field discovery

On first run, any stat field names returned by the API that aren't in the `STAT_FIELDS` map will be logged:

```
[UNKNOWN STAT] API returned stat field: "POINT_COUNT" (count: 14)
  → Add to STAT_FIELDS map: 'POINT_COUNT': 'yourFieldName'
```

Update the `STAT_FIELDS` map at the top of `fetch-bball.js` based on these logs. Typical basketball fields expected:

| API value | Our field |
|-----------|-----------|
| `APPEARANCE` | `gp` |
| `POINT_COUNT` | `pts` |
| `FOUL_COUNT` | `fouls` |
| `FIELD_GOAL` | `fg` |
| `FIELD_GOAL_ATTEMPT` | `fga` |
| `THREE_POINT` | `threePt` |
| `THREE_POINT_ATTEMPT` | `threePtA` |
| `FREE_THROW` | `ft` |
| `FREE_THROW_ATTEMPT` | `ftA` |

*(Exact strings TBC from first run logs)*

---

## Tenant header

The scraper uses `tenant: bv` (Basketball Victoria). If targeting a different basketball organisation, update the `TENANT` constant at the top of `fetch-bball.js`.

---

## Season IDs — initial four comps

| Competition | Season | Season ID |
|-------------|--------|-----------|
| Kilsyth Basketball — After School | Autumn 2026 | `68f8c050` |
| Kilsyth Basketball — Junior Domestic | Winter 2026 | `8ff9f39e` |
| MEBA — Junior Domestic Saturday (GEBC) | Winter 2026 | `15908988` |
| MEBA — Junior Domestic Mon-Fri | Winter 2026 | `43448c02` |

---

## Output files

| File | Purpose |
|------|---------|
| `bball-data.json` | Main database — players, seasons, metadata |
| `bball-progress.json` | Resume state — deleted on clean completion |

---

## Planned: viewer dashboard (`bball-index.html`)

- Player search with leaderboards (games, points, fouls, FG, 3PT, FT) filterable by comp / season / age group / grade
- "This is me" — nominate yourself as a player
- Team fixture view — season schedule and results for your team
- Fixture drill-down — roster of the opponent team, with highlights showing anyone you've ever played against in any comp or season
