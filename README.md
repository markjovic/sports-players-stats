# sports-players-stats

A player-centric data scraper for PlayHQ sports competitions. Collects full match and stat history for every player across all reachable competitions, storing everything in a structured JSON database for querying and display.

Currently scraping: **Basketball Victoria (bv)**. Designed to support AFL and Cricket Australia with the same codebase.

---

## Architecture

### Core concept

The scraper is **player-centric, history-first**. Starting from one or more competition season IDs, it:

1. Enumerates all grades in the season
2. Collects every player UUID from every grade (with gender inference)
3. Fetches each player's **full PlayHQ history** — every season, every comp, every team, every game
4. Stores stats in a slim searchable index and full detail in per-player files
5. Stores game opponent data in per-season files for "played against" lookups

### Crawl graph

The scraper is self-expanding. Each player's full history reveals season IDs from other competitions. Unknown season IDs are queued and crawled automatically. A single seed comp eventually reaches the entire reachable graph of connected competitions.

### Two-tier queue

Seasons are prioritised by year:
- **Priority queue** (`queue-bv-priority.json`): 2023+ seasons — crawled first
- **Backlog queue** (`queue-bv-backlog.json`): pre-2023 seasons — crawled after priority is exhausted

Seasons with unknown year default to priority. Historical seasons (year < current year) are auto-locked after crawling — their data never changes and won't be re-fetched.

### Self-triggering chain

`crawl-all` mode processes one season per GitHub Actions run, then triggers the next run automatically via the GitHub API. This avoids timeout issues on large seasons and ensures every season is fully committed before moving to the next.

---

## Data model

### `sports-index.json` — slim index (~2MB)

```js
{
  players: {
    [uuid]: {
      uuid, name, gender,
      sports: {
        "Basketball": { gp, pts, fouls, fg, ft, threePt }
      },
      updatedAt
    }
  },
  seasons: {
    [seasonId]: {
      id, name, fullName, compName, compId,
      orgName, orgId, tenant,
      grades: [{ id, name, age, gender }],
      locked: boolean,
      lockedAt
    }
  },
  lastFetch
}
```

### `players/{xx}/{uuid}.json` — full player detail

Sharded by first 2 characters of UUID. One file per player, all sports.

```js
{
  uuid, name, gender,
  sports: { "Basketball": { gp, pts, fouls, fg, ft, threePt } },
  seasons: [
    {
      sid, sn, club, sport,
      regs: [
        { tid, tn, gid, gn, age, div, stats: { gp, pts, fouls, fg, ft, threePt } }
      ]
    }
  ],
  updatedAt
}
```

### `games/bv/{seasonId}.json` — game opponent index

```js
{
  games: {
    [gameId]: { d: date, on: oppTeamName, o: oppTeamId }
  },
  playerGames: {
    [uuid]: [gameId, gameId, ...]
  }
}
```

---

## Repo structure

```
fetch-playhq.js               <- scraper (all modes)
migrate-games.sh              <- one-off: move games-bv-*.json to games/bv/
migrate-player-index.js       <- one-off: split sports-index.json into slim + detail files
sports-index.json             <- slim player index
queue-bv-priority.json        <- pending priority seasons (2023+)
queue-bv-backlog.json         <- pending backlog seasons (pre-2023)
README.md
.github/
  workflows/
    fetch-playhq.yml
    migrate-games.yml
    migrate-player-index.yml
games/
  bv/
    {seasonId}.json
players/
  {xx}/
    {uuid}.json
```

---

## Usage

```bash
node fetch-playhq.js --mode=crawl-all --tenant=bv --sport=basketball
node fetch-playhq.js --mode=crawl    --tenant=bv --sport=basketball --season=8ff9f39e
node fetch-playhq.js --mode=update   --tenant=bv --sport=basketball
node fetch-playhq.js --mode=discover --tenant=bv --sport=basketball --season=8ff9f39e
node fetch-playhq.js --mode=lock     --tenant=bv --sport=basketball --season=8ff9f39e
```

Add `--concurrency=N` to adjust parallel requests (default 30). The scraper self-regulates on 429 responses.

---

## Tenant support

| Sport | Tenant | Status |
|-------|--------|--------|
| Basketball Victoria | `bv` | Active |
| AFL | `afl` | Planned |
| Cricket Australia | `ca` | Planned |

---

## Seed season IDs

| Competition | Season | ID |
|-------------|--------|----|
| Kilsyth Basketball — After School | Autumn 2026 | `68f8c050` |
| Kilsyth Basketball — Junior Domestic | Winter 2026 | `8ff9f39e` |
| MEBA — Junior Domestic Saturday (GEBC) | Winter 2026 | `15908988` |
| MEBA — Junior Domestic Mon-Fri | Winter 2026 | `43448c02` |

---

## Gender inference

- Seen in any Girls grade: `Female` (permanent)
- Seen in any Boys grade: `Male` (permanent)
- Only Mixed grades: `Mixed`
- Never gendered: `Unknown`

Female/Male signals are never downgraded.

---

## Planned: viewer dashboard

- Player search + leaderboards (GP, pts, fouls, FG, 3PT, FT) filterable by comp/season/age/grade
- "This is me" — nominate yourself as a player
- Team fixture view with season schedule
- Fixture drill-down — opponent roster highlighting anyone you have ever played against, with PlayHQ game links
