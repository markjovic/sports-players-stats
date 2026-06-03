# sports-players-stats

Player-centric scraper for PlayHQ basketball competitions. Builds a database of every player across all Basketball Victoria competitions — player histories, career stats, season-by-season registrations — for use in search, leaderboards, and "played against" lookups.

---

## Data files

| File | Purpose |
|------|---------|
| `sports-index.json` | Slim index: seasons metadata + player count. ~1MB post-migration. |
| `players-index/{xx}.json` | Sharded player slim records (name, gender, career totals) by first 2 UUID chars |
| `players/{xx}/{uuid}.json` | Full player detail — all seasons and registrations |
| `queue-bv-priority.json` | Seasons pending crawl (2023+) |
| `queue-bv-backlog.json` | Seasons pending crawl (pre-2023) |
| `seasons-discovered.json` | Metadata for all known seasons (crawled + queued) |
| `seasons-invalid.json` | Confirmed invalid season IDs with reason + HTTP status |
| `seasons-skipped.json` | Seasons that failed during crawl (recorded for review) |
| `run-summary.json` | Stats from last crawl run — read by Summary workflow step |

---

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **PlayHQ Sports Scraper** | Manual / self-triggering | Crawl one season per run, chain continues until queue exhausted |
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
- **Invalid tracking** — IDs confirmed not found after 3 API retries stored in `seasons-invalid.json`; not re-probed
- **Error handling** — code errors exit(1) so Actions run shows ❌; skippable errors (not found, HTTP 4xx) recorded in `seasons-skipped.json` and chain continues

## Summary step

Each run shows a Summary step between "Run scraper" and "Commit results":

```
🏀 Season just processed
   Season:           Junior Domestic — Winter 2024
   Season ID:        ebd7afa4
   Grades:           24
   Unique players:   1,278
   Total players:    1,732 (incl. duplicates across grades)
   New players:      +56
   New stubs added:  +3 net
   New seasons disc: 12

📊 Database summary
   Players:          166,817
   Seasons crawled:  214
   Seasons (stubs):  1,673 — discovered in player histories, not yet crawled
   Priority queue:   1,447
   Backlog queue:    333
   Known invalid:    700
   Skipped:          1
   Last fetch:       2026-06-01T10:22:44.219Z
```

---

## Player index sharding

`sports-index.json` previously stored all player slim records inline (~45MB+). Post-migration, players are split into 256 shard files `players-index/xx.json` by first 2 UUID chars (~200KB each). `sports-index.json` becomes ~1MB (seasons only).

Run **Migrate Player Index** workflow to perform migration. Do not run while crawl-all is active. The scraper is backward-compatible — if `players-index/` doesn't exist it reads the monolithic index.

---

## PlayHQ API

- **Endpoint:** `https://api.playhq.com/graphql` (POST)
- **Headers:** `tenant: bv`, `origin: https://www.playhq.com`
- **Season ID type:** `String!` for `discoverSeason` on `bv` tenant (not `ID!`)
- **No auth required** for public competition data
- **Rate limits:** not documented; 200 concurrent requests observed clean

---

## Cron schedule

Disabled during initial crawl. Re-enable in `fetch-playhq.yml` once `crawl-all` completes:

```yaml
schedule:
  - cron: '0 20 * * 0,3'  # Monday and Thursday 6am AEST
```
