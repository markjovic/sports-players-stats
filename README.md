# sports-players-stats

Player-centric scraper for PlayHQ basketball competitions. Builds a database of every player across all Basketball Victoria competitions — player histories, career stats, season-by-season registrations, and game results — for use in search, leaderboards, and "played against" lookups.

---

## Data files

| File | Purpose |
|------|---------|
| `sports-index.json` | Slim index: seasons metadata + player count (~1MB post-migration) |
| `players-index/{xx}.json` | Sharded player slim records by first 2 UUID chars — career totals, name, gender |
| `players/{xx}/{uuid}.json` | Full player detail — all seasons, registrations, per-game history |
| `games/bv/{seasonId}.json` | Per-season game index: game metadata + player→game mappings + team scores (post-backfill) |
| `queue-bv-priority.json` | Seasons pending crawl (2023+) |
| `queue-bv-backlog.json` | Seasons pending crawl (pre-2023) |
| `seasons-discovered.json` | Metadata for all known seasons (crawled + queued) |
| `seasons-invalid.json` | Confirmed invalid season IDs with reason + HTTP status |
| `seasons-skipped.json` | Seasons that failed during crawl (recorded, added to invalid automatically) |
| `run-summary.json` | Stats from last crawl run — read by Summary workflow step |
| `backfill-progress.json` | Resume state for game score backfill |

---

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **PlayHQ Sports Scraper** | Manual / self-triggering | Crawl one season per run, chain continues until queue exhausted |
| **Backfill Game Scores** | Manual | Enrich all stored game IDs with home/away team names and scores via `discoverGame` |
| **Explore PlayHQ Auth** | Manual | Test authenticated API endpoints and discover available data |
| **Recover Discovered Seasons** | Manual | Fill `seasons-discovered.json` metadata, validate unknown IDs, clean queues |
| **Migrate Player Index** | Manual (one-off) | Split players from `sports-index.json` into `players-index/` shards |

---

## Crawl architecture

- **One season per run** — GitHub Actions job checks out, scrapes, commits, triggers next run
- **Self-triggering chain** — `modeCrawlAll` calls GitHub API to dispatch next workflow run
- **Two-tier queue** — priority (2023+) exhausted first, then backlog (pre-2023)
- **200 concurrent requests** — grade page fetches and player profile fetches both parallelised
- **Auto-lock** — historical seasons (year < current) locked after crawl; games files never rewritten
- **Stub discovery** — new season IDs found in player histories written as stubs to index, queued for crawl
- **Invalid + skipped tracking** — failed seasons recorded in both `seasons-invalid.json` and `seasons-skipped.json`; never re-stubbed or re-queued
- **Error handling** — code errors exit(1) so Actions run shows ❌; skippable errors (not found, HTTP 4xx) recorded and chain continues

---

## Games file structure

```json
{
  "games": {
    "gameId": {
      "d":  "2026-04-17",
      "rn": "Round 7",
      "on": "Opponent Team Name",
      "o":  "oppTeamId",
      "h":  "homeTeamId",
      "hn": "Home Team Name",
      "a":  "awayTeamId",
      "an": "Away Team Name",
      "hs": 72,
      "as": 58
    }
  },
  "playerGames": {
    "player-uuid": ["gameId1", "gameId2"]
  }
}
```

`hs`/`as` (home/away scores) are added by the Backfill Game Scores workflow. Run after crawl-all completes.

---

## What can be queried from this dataset

**From slim index (330k+ players, loaded in full):**
- Player search by name
- Career leaderboards: most points, most games, most 3-pointers, most fouls, best PPG

**From player detail files (per-player):**
- Season-by-season stat breakdown
- Club history
- Per-game stats — opponent, date, individual pts/fouls/ft/fg/3pt per game
- "Played against" — all games vs a given opponent team

**From games files (post-backfill):**
- Highest team score in a game
- Biggest score margin
- Home vs away win rates
- Team score averages by season

**"Played against" feature:**
Given two teams in a future fixture, find all registered players on each team, cross-reference their game IDs to find when they've previously faced each other, and show those game results with scores.

---

## PlayHQ API

All requests require the mobile user-agent — requests without it get HTTP 403.

```javascript
const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
  'request-id':   crypto.randomUUID(),
};
```

**Authentication:** a `phq_session` cookie is obtained by making any valid API call with mobile headers. The server sets it automatically. Cookie TTL is ~5 hours. Add `Cookie: phq_session=...` header for authenticated endpoints.

See `playhq_api_reference.md` for full endpoint documentation.

---

## Player index sharding

Post-migration, players are split into 256 shard files `players-index/xx.json` by first 2 UUID chars. `sports-index.json` contains seasons only (~1MB). The scraper is backward-compatible — if `players-index/` doesn't exist it reads the monolithic index.

Run **Migrate Player Index** workflow once. Do not run while crawl-all is active.

---

## Key data integrity rules

1. **Never allow one sport's crawl to overwrite another sport's player detail data.** The `existingDetail` merge in `fetchPlayerProfile` must preserve seasons from other sports. Currently safe to skip merge on fetch failure only because basketball is the only sport. When AFL/cricket are added, a failed GitHub raw fetch MUST abort the player write.

2. **Never re-stub or re-queue invalid/skipped season IDs.** Both `seasons-invalid.json` and `seasons-skipped.json` are checked before writing stubs and before routing to queues.

---

## Cron schedule

Disabled during initial crawl. Re-enable in `fetch-playhq.yml` once `crawl-all` completes:

```yaml
schedule:
  - cron: '0 20 * * 0,3'  # Monday and Thursday 6am AEST
```
