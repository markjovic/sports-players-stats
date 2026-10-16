// scripts/lib/game-scores.cjs
//
// Per-game scoreline lookup, shared by fetch-profile-stats.js and
// build-leaderboards.js.
//
// ── WHY THIS EXISTS (REPO_MANIFEST §6.84, 2026-10-15) ────────────────────────
// Until now the ONLY defence against junk stats entered in the on-court app was
// data/forfeit-games.json — a BLOCKLIST, populated in exactly one place
// (nightly-crawl.js L815-824) by testing a LABEL:
//
//     const isForfeit = outcomeValue.includes('FORFEIT');
//
// Nothing anywhere looked at the numbers. A finals game at Coburg on 2026-10-13
// shipped six player lines of 102/102/101/100/100/102 PTS into the all-time
// Best Game PTS board behind a 20-0 scoreline. Every line reconciled internally
// (34x3=102, 50x2=100, 1x2+33x3=101, 4x2+30x3+2=100) so no arithmetic check
// could catch them, and they summed to exactly the 607 the app recorded as the
// period total. The one thing that is impossible is the thing nothing tested:
//
//     A PLAYER CANNOT SCORE MORE POINTS THAN ANY TEAM SCORED IN THAT GAME.
//
// 102 against a game whose highest team score is 20. That test needs no label,
// no blocklist, no probe and no lag, and it is the test implemented here.
//
// maxScore() returns the HIGHER of the two team scores, deliberately. Using the
// player's own team's score would need the side, which means resolving the tid,
// which is exactly the fragile step (T44: h/a vs t1/t2) this avoids. The higher
// of the two is a strictly weaker bound and still catches every case worth
// catching — nobody outscores the winning team either.
//
// ── CONTRACT ─────────────────────────────────────────────────────────────────
// maxScore(sid, gameId) -> number | null
//   null means UNKNOWN, never zero: the season file is absent, the game is not
//   in it, or hs/as are not both numbers. A caller must decide what unknown
//   means for it; it must never be read as "cap of 0". Both callers document
//   their choice at the call site, and they differ on purpose:
//     · fetch-profile-stats  — unknown KEEPS the stat line. Dropping a line on
//       missing data would delete real career totals, which is the overwrite-
//       good-data-with-bad failure this repo exists to avoid.
//     · build-leaderboards   — unknown DROPS the single-game record entry, and
//       says so in the run output. It costs one row on one board, and an
//       unverifiable record is what produced the complaint above.
//
// isForfeit(sid, gameId) -> boolean
//   The game file's own forfeit flag. Independent of data/forfeit-games.json,
//   which only ever receives ids the nightly labelled.
//
// ── MEMORY ───────────────────────────────────────────────────────────────────
// Season files are parsed once, reduced IMMEDIATELY to a compact
// Map<gameId, {m, f}> and the parsed JSON dropped. An LRU of CACHE_SEASONS
// bounds the resident set: build-leaderboards.js is explicitly OOM-paranoid
// (its two-pass design exists for that reason) and must not acquire an
// unbounded cache through this module.

'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_SEASONS = 12;

function makeLookup(root) {
  const GAMES_DIR = path.join(root, 'games', 'bv');
  const cache = new Map();   // sid -> Map<gameId, {m:number|null, f:boolean}>
  const stats = { seasonsRead: 0, seasonsMissing: 0 };

  function season(sid) {
    if (!sid) return null;
    if (cache.has(sid)) {
      const hit = cache.get(sid);          // refresh LRU position
      cache.delete(sid); cache.set(sid, hit);
      return hit;
    }
    let games = null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${sid}.json`), 'utf8'));
      games = raw && raw.games ? raw.games : null;
    } catch (_) { games = null; }

    const map = new Map();
    if (games) {
      stats.seasonsRead++;
      for (const [gid, g] of Object.entries(games)) {
        const hs = typeof g.hs === 'number' ? g.hs : null;
        const as = typeof g.as === 'number' ? g.as : null;
        map.set(gid, {
          m: (hs === null || as === null) ? null : Math.max(hs, as),
          f: g.forfeit === true,
        });
      }
    } else {
      stats.seasonsMissing++;
    }

    cache.set(sid, map);
    if (cache.size > CACHE_SEASONS) cache.delete(cache.keys().next().value);
    return map;
  }

  return {
    maxScore(sid, gameId) {
      if (!sid || !gameId) return null;
      const s = season(sid);
      if (!s) return null;
      const e = s.get(gameId);
      return e ? e.m : null;
    },
    isForfeit(sid, gameId) {
      if (!sid || !gameId) return false;
      const s = season(sid);
      if (!s) return false;
      const e = s.get(gameId);
      return !!(e && e.f);
    },
    stats,
  };
}

module.exports = { makeLookup };
