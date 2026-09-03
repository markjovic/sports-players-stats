// scripts/diagnose-unregistered-appearances.js
//
// READ-ONLY. No PlayHQ calls, no session, no rate limit. Files only.
// Writes one report and commits it. Touches nothing else.
//
// THE QUESTION
// ────────────
// player.u lists appearances where the player holds registrations for that
// season and neither playing team is among their registered team ids.
// StatTrack renders each one as an appearance for a team the player never
// registered with.
//
// FIRST CAUSE, FOUND AND FIXED 2026-09-01. build-player-games.js L175 read only
// g.h/g.a when building gameMeta. Hidden games carry t1/t2 instead (README.md
// L266), so both came back null, the registration test could not pass, and every
// appearance in a season the player holds a registration for was emitted as
// unregistered. u fell from 1,115,172 to 39,178 — 96.5% of the field was that bug.
//
// A SECOND CAUSE REMAINS, and it is what this script now exists to find. Measured
// against the live API on 2026-09-02 over 1,194 u-holders and 6,332 residual
// entries: 6,055 — 95.63% — are STILL credited by PlayHQ. Zero forfeits. PlayHQ
// credits only through a registration, so it holds registrations we do not. About
// 37,500 of the remaining 39,178 rows are still wrong, and about 1,700 are real.
//
// The 95/5 shape matters: the first cause was a field null on ~97% of games, an
// all-or-nothing failure. This one leaves a minority matching, which is what an id
// namespace split looks like when the two spaces happen to agree sometimes.
//
// This script finds out WHY, without spending a single API call.
//
// WHAT IT DOES NOT USE
// ────────────────────
// The third field of a `u` entry looks like the team the player appeared for.
// It is not. build-player-games.js line 289 writes `${gid}|${gsid}|${h ?? a ?? ''}`
// — always the HOME side, whichever team the player was actually on. The comment
// above it says it records "the team they appeared FOR where it can be told
// apart"; the code never tells them apart. So that field identifies nothing about
// the player and is only checked here to confirm it is what it looks like.
//
// THE DISCRIMINATOR
// ─────────────────
// For a player and one season, take every game of theirs in that season. Some are
// in `u` and some are not. A game is NOT in u precisely when one of its two team
// ids matches one of the player's registered team ids. So:
//
//   MIXED    some games in that season match a registered tid and some do not.
//            The team ids are being read correctly for that season, so the u
//            games genuinely involve two teams the player is not registered to —
//            a fill-in for another team. PlayHQ crediting them then means it holds
//            a registration we do not, and the fix is on the registration side.
//
//   ALL-U    NOT ONE game in that season matches any registered tid, yet we hold
//            a registration for that season. The registration's team id and the
//            game's team ids cannot be the same string space. That is the same
//            two-namespace split this whole system exists to handle, showing up
//            in team ids instead of player ids — and `u` would then be measuring
//            nothing about registration at all.
//
// Those two want completely different fixes, which is why guessing between them
// is not good enough.
//
// Secondary checks, all free once the game is in hand:
//   - is the game in games/bv under the sid the u entry claims?
//   - is either team id among the player's registered tids for a DIFFERENT
//     season? (season-id drift rather than team-id divergence)
//   - is either team id anywhere in player.teams at all?
//   - does player.gameTids hold a tid for this game, and does it match?
//
// Run:
//   node scripts/diagnose-unregistered-appearances.js
//   node scripts/diagnose-unregistered-appearances.js --players=800 --per-player=8

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const REPORT_REL  = 'reports/unregistered-appearances-diagnosis.json';
const REPORT_FILE = path.join(ROOT, REPORT_REL);

const args   = process.argv.slice(2);
const argVal = (n, d) => {
  const a = args.find(x => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const MAX_PLAYERS = Math.max(1, parseInt(argVal('players', '600'), 10) || 600);
const PER_PLAYER  = Math.max(1, parseInt(argVal('per-player', '6'), 10) || 6);
const SEED        = parseInt(argVal('seed', '20260901'), 10) || 20260901;
const DRY_RUN     = args.includes('--dry-run');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Registered team ids and season ids — replicates build-player-games.js L254-271
// EXACTLY, including the rule that a season entry with an empty regs[] is not
// registration evidence. If this drifts from that file the diagnosis describes a
// `u` that does not exist.
function regSets(player) {
  const regTids = new Set(), regSids = new Set();
  const tidsBySid = new Map();
  for (const t of (Array.isArray(player.teams) ? player.teams : [])) {
    if (t?.tid) regTids.add(t.tid);
    if (t?.sid) regSids.add(t.sid);
    if (t?.tid && t?.sid) {
      if (!tidsBySid.has(t.sid)) tidsBySid.set(t.sid, new Set());
      tidsBySid.get(t.sid).add(t.tid);
    }
  }
  for (const se of (Array.isArray(player.seasons) ? player.seasons : [])) {
    const regs = Array.isArray(se?.regs) ? se.regs : [];
    for (const r of regs) {
      if (!r?.tid) continue;
      regTids.add(r.tid);
      if (se?.sid) {
        if (!tidsBySid.has(se.sid)) tidsBySid.set(se.sid, new Set());
        tidsBySid.get(se.sid).add(r.tid);
      }
    }
    if (se?.sid && regs.some(r => r && r.tid)) regSids.add(se.sid);
  }
  return { regTids, regSids, tidsBySid };
}

function main() {
  console.log(`\ndiagnose-unregistered-appearances  players=${MAX_PLAYERS} per-player=${PER_PLAYER} seed=${SEED}`);
  console.log('─'.repeat(72));

  // ── Pass 1: sample u-holding players, collect what we need from their files ──
  console.log('\n── Pass 1: sampling players that hold a u array ──────────────────────');
  const rng      = mulberry32(SEED);
  const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  for (let i = prefixes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [prefixes[i], prefixes[j]] = [prefixes[j], prefixes[i]];
  }

  const sampled = [];          // { uuid, u:[{gid,sid,tid}], games:[], regTids, regSids, tidsBySid, gameTids }
  const neededBySid = new Map();  // sid -> Set(gid)   the games we must resolve
  let scanned = 0, withU = 0;

  // A CAP PER SHARD, not first-come. The first version shuffled the prefix order
  // and then filled from whichever directories it reached first, so the whole
  // sample came from a handful of shards — every example uuid in the 2026-09-01
  // run started d30. Adjacent player ids are not independent draws.
  const perShard = Math.max(1, Math.ceil(MAX_PLAYERS / prefixes.length) * 2);

  for (const prefix of prefixes) {
    if (sampled.length >= MAX_PLAYERS) break;
    const dir = path.join(PLAYERS_DIR, prefix);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
    // shuffle within the shard too, so it is not the first N filenames either
    for (let i = files.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [files[i], files[j]] = [files[j], files[i]];
    }
    let fromThisShard = 0;
    for (const fname of files) {
      if (sampled.length >= MAX_PLAYERS) break;
      if (fromThisShard >= perShard) break;
      scanned++;
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
      if (!Array.isArray(p.u) || p.u.length === 0) continue;
      withU++;

      const { regTids, regSids, tidsBySid } = regSets(p);
      const entries = [];
      for (const raw of p.u.slice(0, PER_PLAYER)) {
        const [gid, sid, tid] = String(raw).split('|');
        if (!gid || !sid) continue;
        entries.push({ gid, sid, tid: tid || null, raw: String(raw) });
        if (!neededBySid.has(sid)) neededBySid.set(sid, new Set());
        neededBySid.get(sid).add(gid);
      }
      if (!entries.length) continue;

      // Every game this player has in the seasons those u entries belong to.
      // Needed for the MIXED / ALL-U discriminator: without the non-u games in
      // the same season there is nothing to compare against.
      const seasonsOfInterest = new Set(entries.map(e => e.sid));
      const allGames = Array.isArray(p.games) ? p.games : [];
      for (const gid of allGames) {
        for (const sid of seasonsOfInterest) {
          if (!neededBySid.has(sid)) neededBySid.set(sid, new Set());
          neededBySid.get(sid).add(gid);   // resolved only if that season holds it
        }
      }

      fromThisShard++;
      sampled.push({
        uuid: fname.replace(/\.json$/, ''),
        u: entries,
        uTotal: p.u.length,
        games: allGames,
        regTids, regSids, tidsBySid,
        gameTids: p.gameTids || null,
      });
    }
  }
  console.log(`  scanned ${scanned.toLocaleString()} files | ${withU.toLocaleString()} held a u array | sampled ${sampled.length.toLocaleString()}`);
  console.log(`  season files to open: ${neededBySid.size.toLocaleString()}`);
  if (!sampled.length) {
    console.error('  FATAL: no players with a u array found. Checkout incomplete?');
    process.exit(1);
  }

  // ── Pass 2: resolve those games, one season file read at most once ──────────
  console.log('\n── Pass 2: resolving games from games/bv ─────────────────────────────');
  const gameInfo = new Map();          // `${sid}:${gid}` -> { h, a }
  const gidToSids = new Map();         // gid -> Set(sid it was actually found in)
  let opened = 0, resolved = 0;
  for (const [sid, gids] of neededBySid) {
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${sid}.json`), 'utf8')); }
    catch { continue; }
    opened++;
    const games = gf.games || {};
    for (const gid of gids) {
      const g = games[gid];
      if (!g) continue;
      // t1/t2 FIRST. A game carries h/a OR t1/t2 and never both — README.md L266,
      // hidden games use t1/t2. The first version of this script read h/a only,
      // copied from build-player-games.js L175, which had the same bug. Every
      // example came back h=null a=null, every comparison was null against a real
      // tid, and it reported a confident 35.5% split built on nothing.
      const h = g.t1 ?? g.h ?? null;
      const a = g.t2 ?? g.a ?? null;
      gameInfo.set(`${sid}:${gid}`, { h, a, pair: (g.t1 || g.t2) ? 't1/t2' : ((g.h || g.a) ? 'h/a' : 'none') });
      if (!gidToSids.has(gid)) gidToSids.set(gid, new Set());
      gidToSids.get(gid).add(sid);
      resolved++;
    }
    if (opened % 250 === 0) console.log(`  opened ${opened} season files…`);
  }
  console.log(`  opened ${opened.toLocaleString()} season files | resolved ${resolved.toLocaleString()} game lookups`);

  // ── ABORT IF THE TEAM IDS ARE NOT THERE ──────────────────────────────────
  // This is the check the first version did not have. If team ids come back null
  // then every comparison below is null-against-a-real-tid, every game "does not
  // match", and the MIXED/ALL-U split is an artefact of the read rather than a
  // finding about the data. A confident percentage built on that is worse than no
  // answer, because it gets acted on.
  let nullPair = 0;
  const pairTally = new Map();
  for (const info of gameInfo.values()) {
    if (info.h === null && info.a === null) nullPair++;
    pairTally.set(info.pair, (pairTally.get(info.pair) || 0) + 1);
  }
  console.log(`  field pair used: ${[...pairTally].map(([k, v]) => `${k}=${v.toLocaleString()}`).join('  ')}`);
  if (resolved > 0 && nullPair / resolved > 0.05) {
    console.error(`\n  \u26d4 ABORTING — ${nullPair.toLocaleString()} of ${resolved.toLocaleString()} resolved games (${((nullPair / resolved) * 100).toFixed(1)}%) carry NO team id on either field pair.`);
    console.error('     Every comparison below would be null against a real tid, so the split');
    console.error('     would measure the read, not the data. Fix the field access first.');
    process.exit(1);
  }

  // ── Pass 3: classify ────────────────────────────────────────────────────────
  console.log('\n── Pass 3: classifying ───────────────────────────────────────────────');
  const R = {
    playersSampled: sampled.length,
    uEntriesExamined: 0,
    entry: {
      gameNotInThatSeason: 0,   // the u entry names a sid the game is not in
      tidIsHomeSide: 0,         // confirms the third field is always g.h
      tidNotHomeSide: 0,
      opponentRegisteredElsewhere: 0,  // h or a IS a registered tid, but for another sid
      teamAppearsInPlayerTeams: 0,     // h or a appears anywhere in player.teams
      gameTidsAgrees: 0,               // player.gameTids[gid] matches h or a
      gameTidsDisagrees: 0,
    },
    // THE DISCRIMINATOR, counted per player+season
    seasons: { mixed: 0, allU: 0, noGamesResolved: 0 },
    mixedShare: null,
    examples: { mixed: [], allU: [] },
  };

  for (const s of sampled) {
    // group this player's u entries by season
    const bySid = new Map();
    for (const e of s.u) {
      if (!bySid.has(e.sid)) bySid.set(e.sid, []);
      bySid.get(e.sid).push(e);
    }

    for (const [sid, entries] of bySid) {
      // every game of this player's that games/bv places in THIS season
      let matched = 0, unmatched = 0;
      for (const gid of s.games) {
        const info = gameInfo.get(`${sid}:${gid}`);
        if (!info) continue;
        const hit = (info.h && s.regTids.has(info.h)) || (info.a && s.regTids.has(info.a));
        if (hit) matched++; else unmatched++;
      }

      if (matched === 0 && unmatched === 0) { R.seasons.noGamesResolved++; }
      else if (matched > 0)                 { R.seasons.mixed++; }
      else                                  { R.seasons.allU++; }

      const bucket = (matched === 0 && unmatched === 0) ? null : (matched > 0 ? 'mixed' : 'allU');

      for (const e of entries) {
        R.uEntriesExamined++;
        const info = gameInfo.get(`${e.sid}:${e.gid}`);
        if (!info) {
          R.entry.gameNotInThatSeason++;
          continue;
        }
        if (e.tid && e.tid === info.h) R.entry.tidIsHomeSide++;
        else                           R.entry.tidNotHomeSide++;

        // is either side a team the player IS registered to, but in another season?
        const eitherRegistered = (info.h && s.regTids.has(info.h)) || (info.a && s.regTids.has(info.a));
        if (eitherRegistered) R.entry.opponentRegisteredElsewhere++;

        const inTeams = (info.h && [...s.tidsBySid.values()].some(set => set.has(info.h))) ||
                        (info.a && [...s.tidsBySid.values()].some(set => set.has(info.a)));
        if (inTeams) R.entry.teamAppearsInPlayerTeams++;

        if (s.gameTids && s.gameTids[e.gid]) {
          const gt = s.gameTids[e.gid];
          if (gt === info.h || gt === info.a) R.entry.gameTidsAgrees++;
          else                                R.entry.gameTidsDisagrees++;
        }

        // Raw examples. A count that cannot be checked against the file it came
        // from is a claim, not a measurement.
        if (bucket && R.examples[bucket].length < 8) {
          R.examples[bucket].push({
            uuid: s.uuid,
            uEntry: e.raw,
            sid,
            game: { gid: e.gid, h: info.h, a: info.a },
            registeredTidsThisSeason: [...(s.tidsBySid.get(sid) || [])],
            registeredTidsAllSeasons: [...s.regTids].slice(0, 12),
            gamesThisSeasonMatchingAReg: matched,
            gamesThisSeasonNotMatching: unmatched,
            gameTidForThisGame: s.gameTids ? (s.gameTids[e.gid] || null) : null,
          });
        }
      }
    }
  }

  const decided = R.seasons.mixed + R.seasons.allU;
  R.mixedShare = decided ? R.seasons.mixed / decided : null;

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log(`\n  players sampled     : ${R.playersSampled.toLocaleString()}`);
  console.log(`  u entries examined  : ${R.uEntriesExamined.toLocaleString()}`);
  console.log(`\n  ── THE DISCRIMINATOR (per player+season) ──`);
  console.log(`    MIXED  (some games in that season DO match a registered tid) : ${R.seasons.mixed.toLocaleString()}`);
  console.log(`    ALL-U  (not one game in that season matches)                 : ${R.seasons.allU.toLocaleString()}`);
  console.log(`    no games resolved                                           : ${R.seasons.noGamesResolved.toLocaleString()}`);
  if (R.mixedShare !== null) {
    console.log(`    MIXED share: ${(R.mixedShare * 100).toFixed(1)}%`);
    console.log('');
    if (R.mixedShare > 0.8) {
      console.log('    → Team ids are being read correctly for these seasons. The u games');
      console.log('      genuinely involve two teams the player is not registered to, so');
      console.log('      PlayHQ crediting them means it holds a registration we do not.');
      console.log('      The fix is on the registration side, not the team-id side.');
    } else if (R.mixedShare < 0.2) {
      console.log('    → We hold a registration for these seasons and NOT ONE of the');
      console.log('      player\'s games in them matches its team id. The registration team');
      console.log('      id and the game team ids are not the same string space — the same');
      console.log('      two-namespace split as player ids, in team ids. u then measures');
      console.log('      nothing about registration at all.');
    } else {
      console.log('    → Neither hypothesis dominates. Both causes are present and the');
      console.log('      examples below need reading individually before any fix.');
    }
  }

  console.log(`\n  ── per-entry checks ──`);
  console.log(`    u's third field == home side : ${R.entry.tidIsHomeSide.toLocaleString()} (vs ${R.entry.tidNotHomeSide.toLocaleString()} not)`);
  console.log(`    game not in the sid u claims : ${R.entry.gameNotInThatSeason.toLocaleString()}`);
  console.log(`    a side IS registered, other season : ${R.entry.opponentRegisteredElsewhere.toLocaleString()}`);
  console.log(`    a side appears in player.teams     : ${R.entry.teamAppearsInPlayerTeams.toLocaleString()}`);
  console.log(`    gameTids agrees / disagrees        : ${R.entry.gameTidsAgrees.toLocaleString()} / ${R.entry.gameTidsDisagrees.toLocaleString()}`);

  for (const k of ['mixed', 'allU']) {
    console.log(`\n  ── raw examples: ${k} ──`);
    for (const ex of R.examples[k]) {
      console.log(`    ${ex.uuid.slice(0, 8)} sid=${ex.sid} game=${ex.game.gid} h=${ex.game.h} a=${ex.game.a}`);
      console.log(`      registered tids this season: ${JSON.stringify(ex.registeredTidsThisSeason)}`);
      console.log(`      this season: ${ex.gamesThisSeasonMatchingAReg} match a reg, ${ex.gamesThisSeasonNotMatching} do not`);
    }
    if (!R.examples[k].length) console.log('    —');
  }

  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(R, null, 2), 'utf8');
  console.log(`\n  Report: ${REPORT_REL}`);

  if (DRY_RUN) { console.log('  --dry-run: not committing.'); return; }

  // House git pattern: per-path add, --shortstat, fetch/merge -X ours, throw on
  // exhaustion. A report that never lands must not show green.
  const GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
  execSync(`git add -- ${REPORT_REL}`, GIT);
  const staged = execSync('git diff --staged --shortstat', GIT).toString().trim();
  if (!staged) { console.log('  Report unchanged, nothing to commit.'); return; }
  console.log(`  staging: ${staged}`);
  execSync('git commit -q -m "diagnose-unregistered-appearances: report"', GIT);
  for (let attempt = 1; attempt <= 60; attempt++) {
    try { execSync('git merge --abort', GIT); } catch {}
    try {
      execSync('git fetch origin main', GIT);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT);
      execSync('git push origin main', GIT);
      console.log(`  \u2713 pushed${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      if (attempt === 60) throw new Error(`push failed after 60 attempts: ${e.message.split('\n')[0]}`);
      execSync(`sleep ${1 + Math.floor(Math.random() * 91)}`, { stdio: 'pipe' });
    }
  }
}

main();
