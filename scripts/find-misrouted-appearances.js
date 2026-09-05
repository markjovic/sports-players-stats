// scripts/find-misrouted-appearances.js
//
// READ-ONLY. No PlayHQ calls. Reads players/, players/aliases/ and games/bv,
// writes one report, commits it. Changes no player file and no alias.
//
// THE BUG THIS LOOKS FOR
// ──────────────────────
// Found 2026-09-05 on Jordan Uppal, who exists as TWO PlayHQ profiles:
//
//   8a30488e-5554-4926-8780-10377baa2b7f  "Jordan singh Uppal"  gp 34,  games 150, x 116
//   296747c1-bd13-464e-94b6-c89ad797ce42  "Jordan Uppal"        gp 184, games 184, x 0
//
// All 116 of the first profile's x games are in the second profile's games, and
// the second credits every one of them. players/aliases/88.json maps the
// spectator id 88f43f9d-ddb4 to the FIRST profile. PlayHQ credits those games to
// the SECOND. So the alias points at the wrong one of two profiles belonging to
// the same person, and build-player-games has been faithfully routing 116
// appearances by that instruction ever since.
//
// The 34 games PlayHQ does credit to the first profile are exactly the 34 that
// are NOT in the second. The split is clean: each profile credits its own set.
//
// NOTHING IN THE FOLD WOULD CATCH THIS. Both records are real, separate PlayHQ
// profiles with their own credited stats. Nothing merged them. The keeper rule
// decides which record's stats survive a merge; it has no opinion on whether two
// records are the same person.
//
// NO RATIO FILTER, DELIBERATELY. A player with 116 x entries and a player with 1
// are the same bug at different scales, and no threshold separates a misroute
// from a genuine PlayHQ gap - only the check does. The x-to-games ratio is
// REPORTED as an observation and never used to decide anything.
//
// THE CHECK, PER x ENTRY
// ──────────────────────
//   1. Find the game in games/bv across the player's own seasons.
//   2. Resolve every id in its roster p[] to a full uuid.
//   3. For each candidate that is not this player, open that player file: does it
//      hold this game in games[] AND not list it in x[]? That means PlayHQ
//      credits the game to THEM.
//   3b. AND IS IT THE SAME PERSON. This step was missing in the first version and
//      the omission invalidated the whole run: "another profile holds this game
//      and is credited for it" is true of EVERY TEAMMATE, so a normal ten-player
//      roster produced nine claimants. 466 of 840 entries landed in `ambiguous`
//      and the 40 called misrouted were simply games with rosters small enough to
//      leave one. The synthetic test passed only because it used two-player
//      rosters - it confirmed my own construction rather than the logic.
//      A duplicate profile shares a NAME with the player. A teammate does not.
//   4. If exactly one such claimant exists, this entry is a misroute and the
//      report names the claimant and the alias entry that caused it.
//      If none exists, nobody is credited with the game: a genuine PlayHQ gap.
//
// GROUPED BY CLAIMANT, NOT COUNTED. The signature of a misroute is the SAME
// claimant across a player's x entries - Uppal's 116 all point at one profile.
// Five x entries pointing at five different claimants is something else entirely,
// and a count would hide that difference.
//
// ID MATCHING USES scripts/lib/uuid-prefix.cjs. Roster ids appear as full uuids,
// 13-char truncations and legacy 10-char prefixes. Reimplementing that matching
// is how several findings in this campaign went wrong.
//
// Run:
//   node scripts/find-misrouted-appearances.js
//   node scripts/find-misrouted-appearances.js --players=400 --dry-run

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const { resolveToFullUuid } = require('./lib/uuid-prefix.cjs');
// normName has a ONE-PASS INVARIANT in namespace-resolve.cjs: five verbatim
// copies already exist and a sixth must not be made. Imported, never rewritten.
const { normName, isPlaceholderName } = require('./lib/namespace-resolve.cjs');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const ALIAS_DIR   = path.join(PLAYERS_DIR, 'aliases');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const REPORT_REL  = 'reports/misrouted-appearances.json';
const REPORT_FILE = path.join(ROOT, REPORT_REL);

const args   = process.argv.slice(2);
const argVal = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const MAX_PLAYERS = Math.max(1, parseInt(argVal('players', '400'), 10) || 400);
const SEED        = parseInt(argVal('seed', '20260905'), 10) || 20260905;
const DRY_RUN     = args.includes('--dry-run');

const log = (m) => console.log(`[misroute] ${new Date().toISOString()} ${m}`);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Is this the same person? ─────────────────────────────────────────────────
// The Uppal case is "Jordan singh Uppal" against "Jordan Uppal": same surname,
// same first name, one carries an extra middle name. That is the shape a
// duplicate profile takes - PlayHQ holding the same child twice under slightly
// different registration names.
//
// Deliberately CONSERVATIVE. A false positive here would name an innocent alias
// for repointing, which moves a real appearance off a real person's record. So:
// the surnames must match exactly after normalisation, and the first names must
// match or one must be a prefix of the other (Jon/Jonathan, Sam/Samuel). Middle
// names are ignored on both sides. Anything else is not a claimant.
//
// normName is imported rather than reimplemented - see the one-pass invariant.
function sameHuman(a, b) {
  if (isPlaceholderName(a) || isPlaceholderName(b)) return false;
  // Apostrophes stripped FOR THE COMPARISON ONLY. normName normalises the curly
  // forms to ' but does not remove them, so "OBrien" and "O'Brien" - the same
  // child registered twice - would not match. This is a comparison step layered on
  // top of normName, NOT a sixth copy of it.
  const tok = (v) => normName(v).replace(/'/g, '').split(' ').filter(Boolean);
  const A = tok(a), B = tok(b);
  if (A.length < 2 || B.length < 2) return false;
  if (A[A.length - 1] !== B[B.length - 1]) return false;      // surnames must match
  const fa = A[0], fb = B[0];
  if (fa === fb) return true;
  return fa.length >= 3 && fb.length >= 3 && (fa.startsWith(fb) || fb.startsWith(fa));
}

const _res = new Map();
function resolve(id) {
  if (typeof id !== 'string' || !id) return null;
  if (_res.has(id)) return _res.get(id);
  let out = null;
  try { out = resolveToFullUuid(id, ROOT); } catch (_) { out = null; }
  _res.set(id, out);
  return out;
}

// Player files are read once and kept. This is the memory cost of the whole tool
// and it is bounded by how many DISTINCT claimants the sample touches, not by the
// player count.
const _pf = new Map();
function readPlayer(uuid) {
  if (_pf.has(uuid)) return _pf.get(uuid);
  let p = null;
  try { p = JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, uuid.slice(0, 2).toLowerCase(), `${uuid}.json`), 'utf8')); }
  catch (_) { p = null; }
  _pf.set(uuid, p);
  return p;
}

// Alias shards, loaded on demand, inverted so a target uuid can be asked which
// spectator ids redirect to it. That is the direction the fix needs.
const _alias = new Map();
function aliasesPointingAt(uuid) {
  const shardsSeen = [];
  const out = [];
  for (const shard of _aliasShards()) {
    const m = _aliasShard(shard);
    if (!m) continue;
    shardsSeen.push(shard);
    for (const [spec, target] of m) if (target === uuid) out.push({ shard, spec });
  }
  return out;
}
let _shardList = null;
function _aliasShards() {
  if (_shardList) return _shardList;
  try { _shardList = fs.readdirSync(ALIAS_DIR).filter(f => /^[0-9a-f]{2}\.json$/.test(f)).map(f => f.slice(0, 2)); }
  catch (_) { _shardList = []; }
  return _shardList;
}
function _aliasShard(shard) {
  if (_alias.has(shard)) return _alias.get(shard);
  let m = null;
  try {
    const o = JSON.parse(fs.readFileSync(path.join(ALIAS_DIR, `${shard}.json`), 'utf8'));
    m = new Map(Object.entries(o));
  } catch (_) { m = null; }
  _alias.set(shard, m);
  return m;
}

function main() {
  log(`find-misrouted-appearances  players=${MAX_PLAYERS}  seed=${SEED}${DRY_RUN ? '  DRY RUN' : ''}`);
  console.log('─'.repeat(72));

  // ── Pass 1: sample players carrying x ──────────────────────────────────────
  const rng = mulberry32(SEED);
  const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  for (let i = prefixes.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [prefixes[i], prefixes[j]] = [prefixes[j], prefixes[i]]; }
  const perShard = Math.max(1, Math.ceil(MAX_PLAYERS / prefixes.length) * 3);

  const sampled = [];
  const neededBySid = new Map();
  let scanned = 0, withX = 0;

  for (const prefix of prefixes) {
    if (sampled.length >= MAX_PLAYERS) break;
    let files;
    try { files = fs.readdirSync(path.join(PLAYERS_DIR, prefix)).filter(f => f.endsWith('.json')); } catch { continue; }
    for (let i = files.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [files[i], files[j]] = [files[j], files[i]]; }
    let fromShard = 0;
    for (const fname of files) {
      if (sampled.length >= MAX_PLAYERS || fromShard >= perShard) break;
      scanned++;
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, prefix, fname), 'utf8')); } catch { continue; }
      const bk = p.sports && p.sports.Basketball;
      const x = bk && Array.isArray(bk.x) ? bk.x : null;
      if (!x || !x.length) continue;
      withX++; fromShard++;
      const uuid = fname.replace(/\.json$/, '');
      _pf.set(uuid, p);
      const sids = [...new Set((p.seasons || []).map(s => s.sid).filter(Boolean))];
      for (const sid of sids) {
        if (!neededBySid.has(sid)) neededBySid.set(sid, new Set());
        for (const gid of x) neededBySid.get(sid).add(gid);
      }
      sampled.push({ uuid, name: p.name || null, x, sids, games: (p.games || []).length, gp: Number(bk.gp) || 0 });
    }
  }
  log(`scanned ${scanned.toLocaleString()} | ${withX.toLocaleString()} carried x | sampled ${sampled.length.toLocaleString()}`);
  if (!sampled.length) { console.error('FATAL: no players carrying x.'); process.exit(1); }

  // ── Pass 2: resolve the games ──────────────────────────────────────────────
  const gameAt = new Map();
  let opened = 0;
  for (const [sid, gids] of neededBySid) {
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${sid}.json`), 'utf8')); } catch { continue; }
    opened++;
    const games = gf.games || {};
    for (const gid of gids) if (games[gid]) gameAt.set(`${sid}:${gid}`, games[gid]);
    if (opened % 300 === 0) log(`opened ${opened} season files…`);
  }
  log(`opened ${opened.toLocaleString()} season files`);

  // ── Pass 3: who does PlayHQ credit each x game to? ─────────────────────────
  const R = {
    generatedAt: new Date().toISOString(), seed: SEED,
    playersSampled: sampled.length, xEntries: 0,
    misrouted: 0, genuineGap: 0, ambiguous: 0, gameNotFound: 0,
    playersWithAnyMisroute: 0, playersFullyMisrouted: 0,
    suspectAliases: [], players: [],
  };

  for (const s of sampled) {
    const byClaimant = new Map();   // claimant uuid -> [gid]
    let gap = 0, notFound = 0, ambiguous = 0;

    for (const gid of s.x) {
      R.xEntries++;
      let g = null;
      for (const sid of s.sids) { const c = gameAt.get(`${sid}:${gid}`); if (c) { g = c; break; } }
      if (!g) { notFound++; R.gameNotFound++; continue; }

      // Everyone on the team sheet, resolved. A game the player is credited for by
      // PlayHQ will have that person's OTHER profile in this list.
      const claimants = [];
      for (const e of (Array.isArray(g.p) ? g.p : [])) {
        const full = resolve(e && (e.id ?? e.profileID));
        if (!full || full === s.uuid) continue;
        const op = readPlayer(full);
        if (!op) continue;
        const obk = op.sports && op.sports.Basketball;
        if (!obk) continue;
        const holds = Array.isArray(op.games) && op.games.includes(gid);
        const alsoUncredited = Array.isArray(obk.x) && obk.x.includes(gid);
        if (!holds || alsoUncredited) continue;
        // SAME PERSON, or it is just a teammate. Placeholder names carry nothing
        // to match on, so a `Player #...` on either side is never a claimant -
        // guessing there would invent duplicates rather than find them.
        if (!sameHuman(s.name, op.name)) continue;
        claimants.push(full);
      }

      if (claimants.length === 1) {
        const c = claimants[0];
        if (!byClaimant.has(c)) byClaimant.set(c, []);
        byClaimant.get(c).push(gid);
        R.misrouted++;
      } else if (claimants.length === 0) {
        gap++; R.genuineGap++;
      } else {
        ambiguous++; R.ambiguous++;
      }
    }

    if (!byClaimant.size && !gap && !notFound && !ambiguous) continue;

    const claims = [...byClaimant.entries()]
      .map(([c, gids]) => ({ claimant: c, name: readPlayer(c)?.name || null, games: gids.length, sample: gids.slice(0, 3) }))
      .sort((a, b) => b.games - a.games);

    if (claims.length) R.playersWithAnyMisroute++;
    // Every x entry accounted for by ONE claimant: the clearest possible signal
    // that a single alias is pointing at the wrong profile.
    const single = claims.length === 1 && claims[0].games === s.x.length;
    if (single) R.playersFullyMisrouted++;

    R.players.push({
      uuid: s.uuid, name: s.name, gp: s.gp, games: s.games, x: s.x.length,
      // Reported, never used to decide. A player with one x is the same bug as a
      // player with 116 if a claimant exists for it.
      xShareOfGames: s.games ? +(s.x.length / s.games).toFixed(3) : null,
      claims, genuineGap: gap, gameNotFound: notFound, ambiguous,
      singleClaimant: single,
    });

    // The alias entries that would have caused it, so the fix is actionable
    // rather than a name to go looking for.
    if (single) {
      for (const a of aliasesPointingAt(s.uuid)) {
        R.suspectAliases.push({ aliasShard: a.shard, spec: a.spec, currentTarget: s.uuid, likelyCorrectTarget: claims[0].claimant, games: claims[0].games });
      }
    }
  }

  R.players.sort((a, b) => (b.claims[0]?.games || 0) - (a.claims[0]?.games || 0));

  const pct = (n, d) => d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
  console.log(`\n  players sampled          : ${R.playersSampled.toLocaleString()}`);
  console.log(`  x entries examined       : ${R.xEntries.toLocaleString()}`);
  console.log(`\n  MISROUTED (another profile holds and is credited) : ${R.misrouted.toLocaleString()}  ${pct(R.misrouted, R.xEntries)}`);
  console.log(`  genuine gap (nobody credited)                     : ${R.genuineGap.toLocaleString()}  ${pct(R.genuineGap, R.xEntries)}`);
  console.log(`  ambiguous (more than one same-name claimant)      : ${R.ambiguous.toLocaleString()}`);
  console.log(`  game not in any season on the profile             : ${R.gameNotFound.toLocaleString()}`);
  console.log(`\n  players with any misroute        : ${R.playersWithAnyMisroute.toLocaleString()} of ${R.playersSampled.toLocaleString()}`);
  console.log(`  players where ONE claimant takes ALL their x      : ${R.playersFullyMisrouted.toLocaleString()}`);
  console.log(`  alias entries implicated         : ${R.suspectAliases.length.toLocaleString()}`);

  console.log('\n  ── worst affected ──');
  for (const p of R.players.slice(0, 15)) {
    const c = p.claims[0];
    console.log(`    ${p.uuid.slice(0, 8)} ${String(p.x).padStart(4)} x of ${String(p.games).padStart(4)} games, gp ${String(p.gp).padStart(4)}  ${c ? `\u2192 ${c.claimant.slice(0, 8)} takes ${c.games}${p.singleClaimant ? ' (ALL)' : ''}  ${(c.name || '').slice(0, 22)}` : `no claimant, ${p.genuineGap} genuine gap`}`);
  }

  if (R.suspectAliases.length) {
    console.log('\n  ── alias entries to repoint ──');
    for (const a of R.suspectAliases.slice(0, 15)) {
      console.log(`    players/aliases/${a.aliasShard}.json  "${a.spec}"  ${a.currentTarget.slice(0, 8)} \u2192 ${a.likelyCorrectTarget.slice(0, 8)}   (${a.games} games)`);
    }
  }

  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(R, null, 2), 'utf8');
  console.log(`\n  Report: ${REPORT_REL}`);
  if (DRY_RUN) { log('dry run - not committing.'); return; }

  const GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
  execSync(`git add -- ${REPORT_REL}`, GIT);
  const staged = execSync('git diff --staged --shortstat', GIT).toString().trim();
  if (!staged) { log('report unchanged.'); return; }
  log(`staging: ${staged}`);
  execSync(`git commit -q -m "find-misrouted-appearances: ${R.misrouted} misrouted, ${R.genuineGap} genuine, ${R.suspectAliases.length} aliases implicated"`, GIT);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { execSync('git merge --abort', GIT); } catch {}
    try {
      execSync('git fetch origin main', GIT);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT);
      execSync('git push origin main', GIT);
      log(`pushed${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      log(`push attempt ${attempt}/5 failed: ${e.message.split('\n').slice(0, 2).join(' | ')}`);
      if (attempt === 5) { log('giving up on the commit. No player file was touched; re-run to regenerate.'); return; }
      execSync(`sleep ${1 + Math.floor(Math.random() * 15)}`, { stdio: 'pipe' });
    }
  }
}

main();
