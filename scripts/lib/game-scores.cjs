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
//   in it, hs/as are not both numbers, or the top score is below the trusted floor
//   (a stored 0-0, 1-0 or 2-0 is a placeholder, not a scoreline — see
//   MIN_TRUSTED_SCORE below). A caller must decide what unknown
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
const { resolveToFullUuid } = require('./uuid-prefix.cjs');

const CACHE_SEASONS = 12;

// ⚠️ THE CACHE SIZE IS A CONTRACT WITH THE CALLER'S ACCESS ORDER, NOT A TUNING KNOB.
// 2026-10-17: audit-impossible-records.js walked 434,059 player files asking for a
// different season on almost every record. With 3,554 seasons behind a 12-entry LRU
// that is a miss every time — it re-read and re-parsed a whole season game file per
// lookup, and the job was killed at 90 minutes having reached 100,000 players with
// nothing written. build-leaderboards.js never saw it because it makes ~4,000
// lookups, after its heap is final.
//
// A caller doing more lookups than the cache can hold MUST order them by sid and ask
// for cacheSeasons: 1, which turns the whole job into one sequential pass over the
// season files it actually needs. A caller doing a bounded number of scattered
// lookups keeps the default. There is no size that makes scattered access over 3,554
// seasons cheap, so do not try to fix this by raising the number.
// ⚠️ THE FLOOR IS A SAFETY DEFAULT, AND IT IS 20 FOR A MEASURED REASON.
// 2026-10-19, audit-impossible-records over 636,166 stored records:
//   --min-cap=1    726 "impossible"
//   --min-cap=20   215 "impossible", and 25,694 records sitting behind a stored
//                  top team score UNDER 20
// Those 25,694 are not fabrications. Their game files carry 0, 1 or 2 where the
// scoreline belongs — 333 at exactly 2 in one run, clustered by season, which is a
// per-season ingest fault and not something a player did. Every offender at or
// above the floor lands on exactly 20 (156/20, 102/20, 101/20, 100/20, 78/20,
// 67/20 x5 …), which is this corpus's forfeit convention — a real recorded figure.
// 20 is therefore the lowest value we have positive evidence is a scoreline at all.
//
// WHY IT HAS TO LIVE HERE AND NOT IN ONE CALLER. The floor was added to
// audit-impossible-records.js first, and that left fetch-profile-stats.js — which
// DROPS an impossible stat line rather than merely withholding a board row —
// applying no floor at all. On the next fetch of each affected player it would have
// deleted 25,694 real stat lines, with their points, games and career totals, on
// the authority of a game file that says the winning team scored 2. A shared
// predicate with one caller opted out is not a shared predicate (T83).
//
// Raising it costs withheld rows and nothing else; lowering it risks deletion. It
// is deliberately not wired to an env var: a floor that can be lowered by accident
// in a workflow input is the same hazard again.
const MIN_TRUSTED_SCORE = 20;

function makeLookup(root, opts) {
  const maxSeasons = Math.max(1, (opts && opts.cacheSeasons) || CACHE_SEASONS);
  // minScore: 1 means "report the raw scoreline, I apply my own floor" — only
  // audit-impossible-records.js does that, because it reports the two populations
  // separately. Every other caller takes the default.
  const minScore   = Math.max(1, (opts && opts.minScore) || MIN_TRUSTED_SCORE);
  // box: also index each game's SPECTATOR box score (hp[]/ap[]) as
  // profileID -> pts. Opt-in, because it is far more memory than {m,f} and only
  // the reconciliation audit needs it. A game's box score is a SECOND, independent
  // record of what a player scored — sourced from the spectator endpoint rather
  // than publicProfileStatistics — and comparing the two is a stronger test than
  // either against the team score. p[] is only a roster of truncated ids and
  // carries no points; hp/ap are the real box scores and key on full profileID.
  const wantBox    = !!(opts && opts.box);
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
        // ⚠️ A TOP SCORE OF 0 IS AN ABSENT SCORELINE, NOT A CAP OF ZERO.
        // 2026-10-17: the first full audit returned 1,241 "impossible" records, and
        // most of the tail read `top team score 0` — 68 PTS in a game stored 0-0,
        // 52, 47, 45, 44, 43 … A basketball game in which nobody scored did not
        // happen as recorded: those game files carry placeholder zeros, so it is the
        // SCORELINE that is untrustworthy there, not the player's stat line. Treating
        // 0 as an authoritative cap turned a missing-data class into a fabrication
        // class, and in fetch-profile-stats.js — where an impossible line is DROPPED
        // — it would have deleted real career totals. Exactly the failure this repo
        // exists to avoid.
        //
        // 0 therefore returns null (unknown) and each caller applies its own
        // unknown rule. minScore raises that floor for a caller that wants it; the
        // audit exposes it as --min-cap and prints the cap distribution, because
        // where to put the floor above 0 is a judgement about this corpus, not
        // something to hardcode here.
        const top = (hs === null || as === null) ? null : Math.max(hs, as);
        const rec = {
          m: (top === null || top < minScore) ? null : top,
          f: g.forfeit === true,
        };
        if (wantBox) {
          let b = null;
          for (const side of [g.hp, g.ap]) {
            if (!Array.isArray(side)) continue;
            for (const e of side) {
              if (!e || !e.profileID) continue;
              if (!b) b = new Map();
              // BOTH fields. 2026-10-19: the first version indexed `pts` only, and
              // the audit then compared maxGameThreePt — a COUNT of 3-pointers —
              // against a points total. Those can never be equal, roughly half the
              // stored records are that category, and the result was a 50.0%
              // agree/disagree split reported as a finding. Compare like with like
              // (T96, two days after writing it).
              b.set(e.profileID, {
                pts: typeof e.pts === 'number' ? e.pts : null,
                pt3: typeof e.pt3 === 'number' ? e.pt3 : null,
              });
            }
          }
          rec.b = b;   // null when this game has no box score at all
        }
        map.set(gid, rec);
      }
    } else {
      stats.seasonsMissing++;
    }

    cache.set(sid, map);
    if (cache.size > maxSeasons) cache.delete(cache.keys().next().value);
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
    // boxLine(sid, gameId, profileID) -> { pts, pt3, via } | null
    //   null means NO BOX-SCORE ANSWER: the game has no spectator box score, or
    //   the player is not in it under any id we can resolve. Absence is not zero.
    //
    //   ALIAS-AWARE, because the first version was not and it mattered: a player
    //   file's uuid and the profileID in a box score can differ (api-canonical
    //   divergence — fetch-profile-stats logs `recovered apiId -> …` when it hits
    //   one). An exact-match-only lookup reports those as "no box score", which
    //   inflates the absent count with misses that are really present. Resolution
    //   is lazy: exact match first, then the player's own resolved id, then — only
    //   on a miss — resolve this one game's ~20 entries. `via` says which path hit,
    //   so alias recoveries can be counted separately from first-try hits.
    boxLine(sid, gameId, profileID) {
      if (!wantBox) throw new Error('boxLine requires makeLookup(root, { box: true })');
      if (!sid || !gameId || !profileID) return null;
      const s = season(sid);
      if (!s) return null;
      const e = s.get(gameId);
      if (!e || !e.b) return null;

      let hit = e.b.get(profileID);
      if (hit) return { ...hit, via: 'exact' };

      let resolved = null;
      try { resolved = resolveToFullUuid(profileID, root); } catch (_) { resolved = null; }
      if (resolved && resolved !== profileID) {
        hit = e.b.get(resolved);
        if (hit) return { ...hit, via: 'alias' };
      }

      for (const [id, line] of e.b) {
        let r = null;
        try { r = resolveToFullUuid(id, root); } catch (_) { r = null; }
        if (r && (r === profileID || (resolved && r === resolved))) return { ...line, via: 'alias' };
      }
      return null;
    },
    // boxRoster(sid, gameId) -> [profileID] | null
    //   Everyone the spectator box score lists for this game. The candidate list
    //   for any per-game question: a player cannot hold a record for a game they
    //   were not in, so this replaces walking players/ entirely.
    boxRoster(sid, gameId) {
      if (!wantBox) throw new Error('boxRoster requires makeLookup(root, { box: true })');
      if (!sid || !gameId) return null;
      const s = season(sid);
      if (!s) return null;
      const e = s.get(gameId);
      if (!e || !e.b) return null;
      return [...e.b.keys()];
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
