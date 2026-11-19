// scripts/probe-credited-snapshot.js
//
// READ-ONLY. Writes nothing to the repository. No PlayHQ calls. No git.
//
// WHAT IT ANSWERS
//   `sports.<sport>.c` is the set of games PlayHQ credits to a player that
//   `player.games[]` did not hold AT THE MOMENT THE PLAYER WAS LAST FETCHED.
//   It is written by fetch-profile-stats.js at fetch time and is never revisited
//   until the next fetch of that player. StatTrack renders it as
//   "Games we are missing — Credited by PlayHQ, not in our record".
//
//   This probe measures how much of every stored `c` list is NO LONGER TRUE,
//   and splits the remainder by WHY it is still true. The split is the point:
//   a `c` entry that is wrong and a `c` entry that is a genuine capture gap are
//   indistinguishable in the stored field and have opposite consequences.
//
// THE TEST, AND WHY IT IS NOT THE ONE ALREADY IN verify-outstanding-claims.js
//   README.md records a membership test — "a `c` entry present in `games[]` is
//   stale" — and verify-outstanding-claims.js counts it (59,878 entries across
//   57,689 players, 2026-09-07). That test is correct but NARROWER than the
//   fault StatTrack displays. `games[]` is rebuilt only by build-player-games.js
//   (weekly), while StatTrack's season card renders from `games/bv` directly.
//   So a game captured into `games/bv` but not yet folded into `games[]` ALSO
//   renders twice on a profile, and the membership test does not see it.
//
//   The test here is therefore: is the credited game HELD IN games/bv WITH THE
//   PLAYER ON ITS ROSTER. That is the condition under which StatTrack shows the
//   game as played, and therefore the condition under which listing it as
//   missing is wrong.
//
// BUCKETS (every `c` entry lands in exactly one)
//   in_games            gid is in player.games[].                      WRONG
//   held_in_roster      gid is in games/bv, roster non-empty, player   WRONG
//                       resolves to one of its p[] ids, but games[]
//                       does not hold it yet (build-player-games lag).
//   held_not_in_roster  gid is in games/bv, roster non-empty, player   CORRECT
//                       is not on it. A genuine appearance gap.
//   held_roster_empty   gid is in games/bv, p[] is EMPTY — the game    CORRECT
//                       has never been captured by any sweep. Per the
//                       2026-08-13 rule, an empty roster is not a gap
//                       in the roster, it is an uncaptured game.
//   absent              gid is in no games/bv season file at all.      CORRECT
//                       A discovery gap.
//
//   wrong = in_games + held_in_roster. That sum is the real size of the fault
//   v1.41 masks client-side.
//
// ROSTER MATCHING — resolveToFullUuid, not a fresh comparison (T37)
//   "The player is on this game's roster" must mean EXACTLY what it means to
//   build-player-games.js, because that is the relation which decides games[].
//   build-player-games.js L~199 does `resolveToFullUuid(entry.id, ROOT)` on every
//   p[] id and keys the result; this probe calls the same helper from the same
//   module and compares the result to the player's uuid. Nothing is
//   reimplemented.
//
//   An earlier version of this file built its own id set from player.uuid plus
//   player.spectatorIds and consulted players/aliases/ directly. Reading
//   lib/uuid-prefix.cjs showed three ways that is NOT the same relation, each of
//   which would have understated the fault by filing a matched player as an
//   appearance gap:
//     · roster ids also exist at the LEGACY 10-char length, which that id set
//       could never match;
//     · resolveToFullUuid is index-first with SELF WINS, so a full id that is a
//       known player is never redirected to someone sharing its 13-char prefix;
//     · an ambiguous prefix resolves to null rather than to a guess.
//   T37 says not to write a fresh comparison. This is why.
//
//   resolveToFullUuid THROWS on an id that is not 10, 13 or 36 chars. That is
//   caught per id and counted as `malformed_roster_id`, never swallowed, and
//   getCollisions() is reported at the end — a collision means some roster ids
//   resolved to null, so a match may be a false negative.
//
// EXAMPLES are capped PER BUCKET, never globally (T59), and every counter
// prints samples beside it (T15).
//
// USAGE
//   node --max-old-space-size=6144 scripts/probe-credited-snapshot.js
//   node --max-old-space-size=6144 scripts/probe-credited-snapshot.js --shards=00,01
//   node --max-old-space-size=6144 scripts/probe-credited-snapshot.js --examples=12 --out=/tmp/report.json
//
//   --shards=XX,YY   limit the PLAYER scan to these shard directories (smoke test).
//                    games/bv is always scanned in full; a partial games scan
//                    would report held games as absent, which is the one error
//                    this probe must never make.
//   --examples=N     per-bucket example cap (default 8).
//   --out=PATH       JSON report path (default /tmp/credited-snapshot-probe.json).
//                    Nothing is written inside the repository.

'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 'probe-credited-snapshot.js v1.1.0 (2026-11-19) — READ-ONLY, no writes, no API calls. REPLACES v1.0.0: roster matching now uses lib/uuid-prefix.cjs resolveToFullUuid (v1.0.0 built its own id set and could not match LEGACY 10-char roster ids)';

const ROOT = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR = path.join(ROOT, 'games', 'bv');

const { resolveToFullUuid, getCollisions } = require('./lib/uuid-prefix.cjs');

// ---------------------------------------------------------------- arguments

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const EXAMPLE_CAP = Number(argValue('examples', '8'));
const OUT_PATH = argValue('out', '/tmp/credited-snapshot-probe.json');
const SHARD_FILTER = (() => {
  const raw = argValue('shards', '');
  if (!raw.trim()) return null;
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
})();

if (!Number.isFinite(EXAMPLE_CAP) || EXAMPLE_CAP < 1) {
  console.error(`FATAL: --examples must be a positive number, got "${argValue('examples', '')}"`);
  process.exit(2);
}

// ------------------------------------------------------------------ helpers

function readJson(file) {
  // Parse failures are RECORDED and REPORTED, never swallowed into an empty
  // object. A failed read must not look like an empty one.
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pct(n, d) {
  if (!d) return '0.0%';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function fmt(n) {
  return n.toLocaleString('en-AU');
}

// Per-player totals, kept exact. The buckets' example lists are capped for
// display; these maps are not, so the per-player shape below is a count and
// never an extrapolation from the examples.
const wrongByPlayer = new Map();
const genuineByPlayer = new Map();

class Bucket {
  constructor(name, verdict) {
    this.name = name;
    this.verdict = verdict; // 'wrong' | 'genuine'
    this.count = 0;
    this.players = new Set();
    this.examples = [];
  }
  add(example) {
    this.count += 1;
    this.players.add(example.uuid);
    const m = this.verdict === 'wrong' ? wrongByPlayer : genuineByPlayer;
    m.set(example.uuid, (m.get(example.uuid) || 0) + 1);
    if (this.examples.length < EXAMPLE_CAP) this.examples.push(example);
  }
}

// --------------------------------------------------------------------- main

const t0 = Date.now();

console.log(VERSION);
console.log(`ROOT            : ${ROOT}`);
console.log(`started         : ${new Date().toISOString()}`);
console.log(`example cap     : ${EXAMPLE_CAP} per bucket`);
console.log(`player shards   : ${SHARD_FILTER ? [...SHARD_FILTER].join(',') + '  ⚠ PARTIAL PLAYER SCAN — totals are NOT repo-wide' : 'ALL'}`);
console.log(`report          : ${OUT_PATH}`);
console.log('');

for (const dir of [PLAYERS_DIR, GAMES_DIR]) {
  if (!fs.existsSync(dir)) {
    console.error(`FATAL: required directory missing: ${dir}`);
    console.error('This probe reads the working tree directly and needs a PLAIN FULL checkout.');
    process.exit(2);
  }
}

const parseFailures = [];

// resolveToFullUuid reads players/indexes/ and players/aliases/ lazily and
// caches per shard. Both must exist or every roster id resolves to null and
// the probe would report the whole database as an appearance gap.
for (const dir of [path.join(PLAYERS_DIR, 'indexes'), path.join(PLAYERS_DIR, 'aliases')]) {
  if (!fs.existsSync(dir)) {
    console.error(`FATAL: ${dir} is missing. Roster matching cannot be performed without it.`);
    process.exit(2);
  }
}

let malformedRosterIds = 0;
let unresolvedRosterIds = 0;
const malformedExamples = [];

// --- Pass B: player scan -----------------------------------------------------

const shardDirs = fs
  .readdirSync(PLAYERS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => /^[0-9a-f]{2}$/i.test(n))
  .filter((n) => !SHARD_FILTER || SHARD_FILTER.has(n.toLowerCase()))
  .sort();

if (SHARD_FILTER) {
  const missing = [...SHARD_FILTER].filter((s) => !shardDirs.includes(s));
  if (missing.length) {
    console.error(`FATAL: --shards named directories that do not exist: ${missing.join(',')}`);
    process.exit(2);
  }
}

const buckets = {
  in_games: new Bucket('in_games', 'wrong'),
  held_in_roster: new Bucket('held_in_roster', 'wrong'),
  held_not_in_roster: new Bucket('held_not_in_roster', 'genuine'),
  held_roster_empty: new Bucket('held_roster_empty', 'genuine'),
  absent: new Bucket('absent', 'genuine'),
};

let totalPlayers = 0;
let playersWithC = 0;
let totalCEntries = 0;
let playersWithX = 0;
let totalXEntries = 0;
let staleXEntries = 0;
let playersWithStaleX = 0;
const cLenHistogram = new Map();
const sportCounts = new Map();

// Players carrying at least one `c` entry not yet resolved by games[].
// Only these are retained; everything else is released at the end of its file.
const pending = []; // { uuid, gids:[], sport }
const wanted = new Map(); // gid -> [pending index, ...]

let shardsDone = 0;
for (const shard of shardDirs) {
  const dir = path.join(PLAYERS_DIR, shard);
  let files;
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (err) {
    parseFailures.push({ file: `players/${shard}/`, error: String(err && err.message) });
    continue;
  }

  for (const f of files) {
    totalPlayers += 1;
    let p;
    try {
      p = readJson(path.join(dir, f));
    } catch (err) {
      parseFailures.push({ file: `players/${shard}/${f}`, error: String(err && err.message) });
      continue;
    }

    const sports = p && p.sports && typeof p.sports === 'object' ? p.sports : null;
    if (!sports) continue;

    // The player file's NAME is the authority on its uuid — resolveToFullUuid
    // returns the id a roster entry resolves to, and that is the filename.
    const uuid = f.replace(/\.json$/, '');

    const gamesSet = new Set(Array.isArray(p.games) ? p.games : []);

    let playerHasC = false;
    let playerHasX = false;
    let playerHasStaleX = false;

    for (const [sportName, sport] of Object.entries(sports)) {
      if (!sport || typeof sport !== 'object') continue;

      // ---- x: a stored x entry ABSENT from games[] is stale (README's test).
      if (Array.isArray(sport.x) && sport.x.length) {
        playerHasX = true;
        totalXEntries += sport.x.length;
        for (const gid of sport.x) {
          if (!gamesSet.has(gid)) {
            staleXEntries += 1;
            playerHasStaleX = true;
          }
        }
      }

      // ---- c
      const c = Array.isArray(sport.c) ? sport.c : null;
      if (!c || !c.length) continue;

      playerHasC = true;
      totalCEntries += c.length;
      cLenHistogram.set(c.length, (cLenHistogram.get(c.length) || 0) + 1);
      sportCounts.set(sportName, (sportCounts.get(sportName) || 0) + c.length);

      const unresolved = [];
      for (const gid of c) {
        if (typeof gid !== 'string' || !gid) continue;
        if (gamesSet.has(gid)) {
          buckets.in_games.add({ uuid, gid, sid: null, sport: sportName, rn: null, st: null, rosterSize: null, date: null });
        } else {
          unresolved.push(gid);
        }
      }

      if (unresolved.length) {
        const idx = pending.length;
        pending.push({ uuid, gids: unresolved, sport: sportName });
        for (const gid of unresolved) {
          const list = wanted.get(gid);
          if (list) list.push(idx);
          else wanted.set(gid, [idx]);
        }
      }
    }

    if (playerHasC) playersWithC += 1;
    if (playerHasX) playersWithX += 1;
    if (playerHasStaleX) playersWithStaleX += 1;
  }

  shardsDone += 1;
  if (shardsDone % 32 === 0 || shardsDone === shardDirs.length) {
    console.log(
      `Pass B  shards ${shardsDone}/${shardDirs.length}  players ${fmt(totalPlayers)}  ` +
        `c-entries ${fmt(totalCEntries)}  unresolved gids ${fmt(wanted.size)}  (${Math.round((Date.now() - t0) / 1000)}s)`
    );
  }
}

console.log('');

// --- Pass C: games/bv scan ---------------------------------------------------

const seasonFiles = fs.readdirSync(GAMES_DIR).filter((n) => n.endsWith('.json')).sort();
console.log(`Pass C  season files: ${fmt(seasonFiles.length)}  gids wanted: ${fmt(wanted.size)}`);

const resolved = new Set(); // gids found in games/bv
const gameKeyTally = new Map(); // key -> count, over sampled wanted games
let gameKeySamples = 0;
const dateValues = []; // {gid, value} for whichever date-ish key is found
let dateKey = null;
const DATE_KEY_CANDIDATES = ['d', 'date', 'dt', 'start', 'startTime', 'startDate', 'ts', 'when'];

let seasonsDone = 0;
for (const f of seasonFiles) {
  let obj;
  try {
    obj = readJson(path.join(GAMES_DIR, f));
  } catch (err) {
    parseFailures.push({ file: `games/bv/${f}`, error: String(err && err.message) });
    continue;
  }

  const sid = f.replace(/\.json$/, '');
  const games = obj && obj.games && typeof obj.games === 'object' ? obj.games : null;
  if (!games) {
    parseFailures.push({ file: `games/bv/${f}`, error: 'no .games object' });
    continue;
  }

  for (const gid of Object.keys(games)) {
    const requesters = wanted.get(gid);
    if (!requesters) continue;

    resolved.add(gid);
    const g = games[gid] || {};

    if (gameKeySamples < 200) {
      gameKeySamples += 1;
      for (const k of Object.keys(g)) gameKeyTally.set(k, (gameKeyTally.get(k) || 0) + 1);
    }

    if (dateKey === null) {
      for (const cand of DATE_KEY_CANDIDATES) {
        if (typeof g[cand] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(g[cand])) {
          dateKey = cand;
          break;
        }
      }
    }
    const dateVal = dateKey && typeof g[dateKey] === 'string' ? g[dateKey].slice(0, 10) : null;

    const roster = Array.isArray(g.p) ? g.p : [];
    const rosterIds = [];
    for (const e of roster) {
      const rid = typeof e === 'string' ? e : e && typeof e.id === 'string' ? e.id : null;
      if (rid) rosterIds.push(rid);
    }

    // Resolve the roster ONCE per game, exactly as build-player-games does, and
    // reuse it for every player asking about this game.
    const rosterOwners = new Set();
    for (const rid of rosterIds) {
      let owner = null;
      try {
        owner = resolveToFullUuid(rid, ROOT);
      } catch (err) {
        malformedRosterIds += 1;
        if (malformedExamples.length < EXAMPLE_CAP) {
          malformedExamples.push({ gid, sid, rid, error: String(err && err.message) });
        }
        continue;
      }
      if (owner) rosterOwners.add(owner);
      else unresolvedRosterIds += 1;
    }

    for (const idx of requesters) {
      const rec = pending[idx];
      const example = {
        uuid: rec.uuid,
        gid,
        sid,
        sport: rec.sport,
        rn: typeof g.rn === 'string' ? g.rn : null,
        st: typeof g.st === 'string' ? g.st : null,
        rosterSize: rosterIds.length,
        date: dateVal,
      };

      if (rosterIds.length === 0) {
        buckets.held_roster_empty.add(example);
        continue;
      }

      if (rosterOwners.has(rec.uuid)) {
        buckets.held_in_roster.add(example);
        if (dateVal) dateValues.push(dateVal);
      } else {
        buckets.held_not_in_roster.add(example);
      }
    }
  }

  seasonsDone += 1;
  if (seasonsDone % 500 === 0 || seasonsDone === seasonFiles.length) {
    console.log(
      `Pass C  seasons ${seasonsDone}/${seasonFiles.length}  gids located ${fmt(resolved.size)}  (${Math.round((Date.now() - t0) / 1000)}s)`
    );
  }
}

// anything still unlocated is genuinely absent from games/bv
for (const [gid, requesters] of wanted) {
  if (resolved.has(gid)) continue;
  for (const idx of requesters) {
    const rec = pending[idx];
    buckets.absent.add({ uuid: rec.uuid, gid, sid: null, sport: rec.sport, rn: null, st: null, rosterSize: null, date: null });
  }
}

console.log('');

// --- report ------------------------------------------------------------------

const wrongTotal = buckets.in_games.count + buckets.held_in_roster.count;
const genuineTotal =
  buckets.held_not_in_roster.count + buckets.held_roster_empty.count + buckets.absent.count;
const classified = wrongTotal + genuineTotal;

const wrongPlayers = wrongByPlayer;
const genuinePlayers = genuineByPlayer;

console.log('='.repeat(78));
console.log('RECONCILIATION — every stored `c` entry lands in exactly one bucket');
console.log('='.repeat(78));
console.log(`players scanned                  : ${fmt(totalPlayers)}`);
console.log(`players carrying a non-empty c   : ${fmt(playersWithC)}  (${pct(playersWithC, totalPlayers)})`);
console.log(`c entries stored                 : ${fmt(totalCEntries)}`);
console.log(`c entries classified             : ${fmt(classified)}`);
if (classified !== totalCEntries) {
  console.log(`⚠ MISMATCH of ${fmt(totalCEntries - classified)} — non-string entries were skipped at read. Investigate before using any figure above.`);
}
console.log('');

console.log('='.repeat(78));
console.log('THE ANSWER');
console.log('='.repeat(78));
console.log(`WRONG   (we hold the game; listing it as missing is false) : ${fmt(wrongTotal)}  ${pct(wrongTotal, classified)}  across ${fmt(wrongPlayers.size)} players`);
console.log(`GENUINE (we really do not hold the player's appearance)    : ${fmt(genuineTotal)}  ${pct(genuineTotal, classified)}  across ${fmt(genuinePlayers.size)} players`);
console.log('');

const order = ['in_games', 'held_in_roster', 'held_not_in_roster', 'held_roster_empty', 'absent'];
const verdictOf = {
  in_games: 'WRONG   — already in player.games[]; the stored list is simply out of date',
  held_in_roster: 'WRONG   — in games/bv with the player on the roster; games[] has not been rebuilt yet',
  held_not_in_roster: 'GENUINE — game held, roster captured, player not on it (appearance gap)',
  held_roster_empty: 'GENUINE — game held but its roster has never been captured by any sweep',
  absent: 'GENUINE — game is in no games/bv season file at all (discovery gap)',
};

for (const key of order) {
  const b = buckets[key];
  console.log('-'.repeat(78));
  console.log(`${key.padEnd(20)} ${fmt(b.count).padStart(10)}  ${pct(b.count, classified).padStart(6)}  players ${fmt(b.players.size)}`);
  console.log(`  ${verdictOf[key]}`);
  for (const ex of b.examples) {
    console.log(
      `    ${ex.uuid}  gid=${ex.gid}  sid=${ex.sid || '-'}  sport=${ex.sport}` +
        `  rn=${ex.rn || '-'}  st=${ex.st || '-'}  roster=${ex.rosterSize === null ? '-' : ex.rosterSize}` +
        `  date=${ex.date || '-'}`
    );
  }
  if (b.count > b.examples.length) {
    console.log(`    … ${fmt(b.count - b.examples.length)} more not shown (cap ${EXAMPLE_CAP})`);
  }
}
console.log('-'.repeat(78));
console.log('');

// --- shape of the c lists ----------------------------------------------------

console.log('='.repeat(78));
console.log('SHAPE — is this the universal off-by-one-round, or a long tail?');
console.log('='.repeat(78));
const lens = [...cLenHistogram.entries()].sort((a, b) => a[0] - b[0]);
const lenBuckets = [
  ['1', (n) => n === 1],
  ['2', (n) => n === 2],
  ['3-5', (n) => n >= 3 && n <= 5],
  ['6-20', (n) => n >= 6 && n <= 20],
  ['21-100', (n) => n >= 21 && n <= 100],
  ['101+', (n) => n > 100],
];
console.log('c-list length per player (per sport block):');
for (const [label, test] of lenBuckets) {
  let players = 0;
  let entries = 0;
  for (const [len, count] of lens) {
    if (test(len)) {
      players += count;
      entries += len * count;
    }
  }
  console.log(`  length ${label.padEnd(8)} players ${fmt(players).padStart(9)}  entries ${fmt(entries).padStart(10)}`);
}
const maxLen = lens.length ? lens[lens.length - 1][0] : 0;
console.log(`  longest stored c list: ${fmt(maxLen)}`);
console.log('');

// How many WRONG entries does an affected player carry? If the fault is the
// universal off-by-one-round, this is overwhelmingly 1.
{
  const dist = new Map();
  for (const n of wrongByPlayer.values()) dist.set(n, (dist.get(n) || 0) + 1);
  const rows = [
    ['exactly 1', (n) => n === 1],
    ['2', (n) => n === 2],
    ['3-5', (n) => n >= 3 && n <= 5],
    ['6+', (n) => n >= 6],
  ];
  console.log('WRONG entries per affected player:');
  for (const [label, test] of rows) {
    let players = 0;
    for (const [n, c] of dist) if (test(n)) players += c;
    console.log(`  ${label.padEnd(12)} ${fmt(players).padStart(9)} players  ${pct(players, wrongByPlayer.size)}`);
  }

  // The cleanest statement of Mark's hypothesis: a player whose entire stored
  // c list is one entry we in fact hold.
  let onlyOneWrongAndNothingElse = 0;
  for (const [uuid, n] of wrongByPlayer) {
    if (n === 1 && !genuineByPlayer.has(uuid)) onlyOneWrongAndNothingElse += 1;
  }
  console.log(
    `  players whose ENTIRE c list is one entry we already hold: ${fmt(onlyOneWrongAndNothingElse)}` +
      `  (${pct(onlyOneWrongAndNothingElse, playersWithC)} of players carrying c)`
  );
  console.log('');

  const dist2 = new Map();
  for (const n of genuineByPlayer.values()) dist2.set(n, (dist2.get(n) || 0) + 1);
  console.log('GENUINE entries per affected player:');
  for (const [label, test] of rows) {
    let players = 0;
    for (const [n, c] of dist2) if (test(n)) players += c;
    console.log(`  ${label.padEnd(12)} ${fmt(players).padStart(9)} players  ${pct(players, genuineByPlayer.size)}`);
  }
  console.log('');
}

console.log('c entries by sport:');
for (const [sport, n] of [...sportCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${sport.padEnd(20)} ${fmt(n)}`);
}
console.log('');

// --- recency -----------------------------------------------------------------

console.log('='.repeat(78));
console.log('RECENCY of the held_in_roster bucket (the lag half of the fault)');
console.log('='.repeat(78));
if (!dateKey) {
  console.log('NOT MEASURED — no date field was found on any wanted game.');
  console.log(`Keys present on the ${gameKeySamples} sampled wanted games, with frequency:`);
  for (const [k, n] of [...gameKeyTally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(14)} ${n}/${gameKeySamples}`);
  }
  console.log('Add the real date key to DATE_KEY_CANDIDATES and re-run for the age distribution.');
} else {
  console.log(`date field in use: "${dateKey}"  (detected from the data, not assumed)`);
  const today = new Date().toISOString().slice(0, 10);
  const ageDays = (iso) => {
    const [y1, m1, d1] = iso.split('-').map(Number);
    const [y2, m2, d2] = today.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  };
  const ageBuckets = [
    ['0-7 days', (a) => a >= 0 && a <= 7],
    ['8-14 days', (a) => a > 7 && a <= 14],
    ['15-30 days', (a) => a > 14 && a <= 30],
    ['31-90 days', (a) => a > 30 && a <= 90],
    ['91-365 days', (a) => a > 90 && a <= 365],
    ['over a year', (a) => a > 365],
    ['future date', (a) => a < 0],
  ];
  const ages = dateValues.map(ageDays);
  for (const [label, test] of ageBuckets) {
    const n = ages.filter(test).length;
    console.log(`  ${label.padEnd(14)} ${fmt(n).padStart(10)}  ${pct(n, ages.length)}`);
  }
  console.log(`  (dated entries: ${fmt(ages.length)} of ${fmt(buckets.held_in_roster.count)} in this bucket)`);
}
console.log('');

// --- x, same scan, no extra cost --------------------------------------------

console.log('='.repeat(78));
console.log('SECONDARY — `x` staleness (same membership test, costs nothing here)');
console.log('='.repeat(78));
console.log(`players carrying a non-empty x : ${fmt(playersWithX)}`);
console.log(`x entries stored               : ${fmt(totalXEntries)}`);
console.log(`x entries now STALE            : ${fmt(staleXEntries)}  (${pct(staleXEntries, totalXEntries)}) across ${fmt(playersWithStaleX)} players`);
console.log('  A stored x entry absent from games[] is stale — README.md, `c` and `x` section.');
console.log('');

// --- parse health ------------------------------------------------------------

console.log('='.repeat(78));
console.log('RESOLVER HEALTH — a false negative here understates the fault');
console.log('='.repeat(78));
const collisions = getCollisions();
console.log(`roster ids that threw (not 10/13/36 chars) : ${fmt(malformedRosterIds)}`);
for (const m of malformedExamples) console.log(`    gid=${m.gid} sid=${m.sid} id="${m.rid}" — ${m.error}`);
console.log(`roster ids that resolved to null           : ${fmt(unresolvedRosterIds)}`);
console.log(`prefix collisions reported by the resolver : ${fmt(collisions.length)}`);
for (const c of collisions.slice(0, EXAMPLE_CAP)) {
  console.log(`    shard ${c.shard} len ${c.len} prefix "${c.prefix}" → ${c.uuids.join(' | ')}`);
}
console.log('  Each of these makes a held_in_roster entry capable of being filed as');
console.log('  held_not_in_roster. They bound the error on the GENUINE column.');
console.log('');

console.log('='.repeat(78));
console.log('PARSE HEALTH');
console.log('='.repeat(78));
console.log(`files that failed to read or parse: ${fmt(parseFailures.length)}`);
for (const pf of parseFailures.slice(0, 20)) {
  console.log(`  ${pf.file}: ${pf.error}`);
}
if (parseFailures.length > 20) console.log(`  … ${fmt(parseFailures.length - 20)} more`);
console.log('');

// --- report file -------------------------------------------------------------

const report = {
  version: VERSION,
  generatedAt: new Date().toISOString(),
  partialPlayerScan: SHARD_FILTER ? [...SHARD_FILTER] : null,
  totals: {
    playersScanned: totalPlayers,
    playersWithC,
    cEntriesStored: totalCEntries,
    cEntriesClassified: classified,
    wrong: wrongTotal,
    wrongPlayers: wrongPlayers.size,
    genuine: genuineTotal,
    genuinePlayers: genuinePlayers.size,
    seasonFiles: seasonFiles.length,
  },
  resolver: {
    malformedRosterIds,
    unresolvedRosterIds,
    collisions,
    malformedExamples,
  },
  buckets: Object.fromEntries(
    order.map((k) => [k, { count: buckets[k].count, players: buckets[k].players.size, examples: buckets[k].examples }])
  ),
  cListLengths: Object.fromEntries(lens),
  wrongEntriesPerPlayer: (() => {
    const d = {};
    for (const n of wrongByPlayer.values()) d[n] = (d[n] || 0) + 1;
    return d;
  })(),
  genuineEntriesPerPlayer: (() => {
    const d = {};
    for (const n of genuineByPlayer.values()) d[n] = (d[n] || 0) + 1;
    return d;
  })(),
  sportCounts: Object.fromEntries(sportCounts),
  dateKey,
  x: { playersWithX, totalXEntries, staleXEntries, playersWithStaleX },
  parseFailures: parseFailures.slice(0, 500),
  parseFailureCount: parseFailures.length,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
console.log(`report written: ${OUT_PATH}`);
console.log(`elapsed: ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(VERSION);

// A parse failure is a fault, not a finding. The report above is complete; the
// non-zero exit is how the run says so without masking it.
if (parseFailures.length) {
  console.error(`\nEXIT 3: ${parseFailures.length} file(s) failed to read or parse. Report above is complete.`);
  process.exit(3);
}
