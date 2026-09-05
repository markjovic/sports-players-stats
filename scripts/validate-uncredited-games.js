// scripts/validate-uncredited-games.js
//
// READ-ONLY. No PlayHQ calls, no session, no rate limit, no writes to players/.
// Reads players/ and games/bv, writes one report, commits it.
//
// THE QUESTION
// ────────────
// sports.Basketball.x lists games we hold that PlayHQ's publicProfileStatistics
// does not credit, forfeits excluded on both sides. It is 9% of players and about
// 80,000 games repo-wide. Before anything is built on it, it needs to be known
// what an entry MEANS, and there are two very different answers:
//
//   A player NAMED but who did not take the court. p[] is the team sheet, hp/ap
//   are the box-score rows. A player can be in the first and not the second, and
//   PlayHQ would be right not to credit a game they did not play. `x` would then
//   be accurate but badly labelled - it should say "named, did not play".
//
//   Or a PLAYHQ UNDERCOUNT. The player IS in PlayHQ's own box score, with real
//   numbers, and PlayHQ's own career totals still leave the game out. Verified on
//   one case 2026-09-05: Toby Jovic (0afc7690), game c7a6db82, 02 Aug 2025 v MLBC
//   B32 - PlayHQ's box score gives him 2 points and 3 fouls, PlayHQ's profile page
//   skips that round and totals the season at 14 games.
//
// One case is one case. This settles which shape dominates.
//
// HOW IT DECIDES, WITHOUT A SINGLE API CALL
// ─────────────────────────────────────────
// games/bv stores the box-score sides as hp/ap alongside the team sheet p[]. So
// for a game that HAS a stored box score, whether the player is in it is already
// on disk. Four buckets, and the two "cannot tell" ones are reported rather than
// folded into the others:
//
//   undercount     stored box score exists AND the player has a row in it.
//   namedNotPlayed stored box score exists AND the player has no row in it.
//   noBoxStored    no hp/ap on the game. Undecidable from files; the Worker would
//                  be needed. NOT counted as either answer.
//   unresolved     the game is in no season on the player's profile.
//
// ID MATCHING USES scripts/lib/uuid-prefix.cjs, NOT A LOCAL COPY. Roster and box
// score ids appear as full uuids, 13-char truncations and legacy 10-char
// prefixes, and resolveToFullUuid is the one implementation that handles the
// trunc-13 cross-namespace collisions. Reimplementing it is how three separate
// findings went wrong earlier in this campaign.
//
// Run:
//   node scripts/validate-uncredited-games.js
//   node scripts/validate-uncredited-games.js --players=800 --dry-run

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const { resolveToFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const REPORT_REL  = 'reports/uncredited-games-validation.json';
const REPORT_FILE = path.join(ROOT, REPORT_REL);

const args   = process.argv.slice(2);
const argVal = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const MAX_PLAYERS = Math.max(1, parseInt(argVal('players', '600'), 10) || 600);
const SEED        = parseInt(argVal('seed', '20260905'), 10) || 20260905;
const DRY_RUN     = args.includes('--dry-run');

const log = (m) => console.log(`[validate-x] ${new Date().toISOString()} ${m}`);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Resolve any stored id to the canonical uuid, tolerating the failures the
// library documents. A null return is a real, expected case (index miss or
// collision) and must not be treated as "not this player".
const _rcache = new Map();
function resolve(id) {
  if (typeof id !== 'string' || !id) return null;
  if (_rcache.has(id)) return _rcache.get(id);
  let out = null;
  try { out = resolveToFullUuid(id, ROOT); }
  catch (_) { out = null; }   // unexpected length: the library throws, we record a miss
  _rcache.set(id, out);
  return out;
}

// Is this player in this list of roster/box-score entries?
// Returns true, false, or null when every entry failed to resolve — which is NOT
// the same as "absent" and must not be counted as one.
function inList(entries, uuid, idField) {
  if (!Array.isArray(entries) || !entries.length) return false;
  let resolvedAny = false;
  for (const e of entries) {
    const raw = e && (e[idField] ?? e.id ?? e.profileID);
    const full = resolve(raw);
    if (full) { resolvedAny = true; if (full === uuid) return true; }
  }
  return resolvedAny ? false : null;
}

function main() {
  log(`validate-uncredited-games  players=${MAX_PLAYERS}  seed=${SEED}${DRY_RUN ? '  DRY RUN' : ''}`);
  console.log('─'.repeat(70));

  // ── Pass 1: sample players carrying x ──────────────────────────────────────
  const rng = mulberry32(SEED);
  const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  for (let i = prefixes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [prefixes[i], prefixes[j]] = [prefixes[j], prefixes[i]];
  }
  // A cap per shard, not first-come: filling from whichever directories are
  // reached first draws adjacent uuids, which are not independent draws.
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
      if (scanned % 100000 === 0) log(`scanned ${scanned.toLocaleString()} files`);
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, prefix, fname), 'utf8')); } catch { continue; }
      const bk = p.sports && p.sports.Basketball;
      const x = bk && Array.isArray(bk.x) ? bk.x : null;
      if (!x || !x.length) continue;
      withX++; fromShard++;

      const sids = [...new Set((p.seasons || []).map(s => s.sid).filter(Boolean))];
      for (const sid of sids) {
        if (!neededBySid.has(sid)) neededBySid.set(sid, new Set());
        for (const gid of x) neededBySid.get(sid).add(gid);
      }
      sampled.push({ uuid: fname.replace(/\.json$/, ''), name: p.name || null, x, sids });
    }
  }
  log(`scanned ${scanned.toLocaleString()} | ${withX.toLocaleString()} carried x | sampled ${sampled.length.toLocaleString()}`);
  if (!sampled.length) { console.error('FATAL: no players carrying x. Has the sweep run?'); process.exit(1); }
  log(`season files to open: ${neededBySid.size.toLocaleString()}`);

  // ── Pass 2: resolve each x game, one season file read at most once ─────────
  const gameAt = new Map();     // `${sid}:${gid}` -> game object
  let opened = 0;
  for (const [sid, gids] of neededBySid) {
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${sid}.json`), 'utf8')); } catch { continue; }
    opened++;
    const games = gf.games || {};
    for (const gid of gids) if (games[gid]) gameAt.set(`${sid}:${gid}`, games[gid]);
    if (opened % 200 === 0) log(`opened ${opened} season files…`);
  }
  log(`opened ${opened.toLocaleString()} season files`);

  // ── Pass 3: classify ───────────────────────────────────────────────────────
  const R = {
    generatedAt: new Date().toISOString(), seed: SEED,
    playersScanned: scanned, playersWithX: withX, playersSampled: sampled.length,
    xEntries: 0,
    undercount: 0, namedNotPlayed: 0, noBoxStored: 0, unresolved: 0, idUnresolvable: 0,
    onTeamSheet: 0, notOnTeamSheet: 0,
    examples: { undercount: [], namedNotPlayed: [], noBoxStored: [], unresolved: [] },
  };
  const ex = (k, o) => { if (R.examples[k].length < 12) R.examples[k].push(o); };

  for (const s of sampled) {
    for (const gid of s.x) {
      R.xEntries++;
      let hit = null, hitSid = null;
      for (const sid of s.sids) { const g = gameAt.get(`${sid}:${gid}`); if (g) { hit = g; hitSid = sid; break; } }
      if (!hit) { R.unresolved++; ex('unresolved', { uuid: s.uuid, name: s.name, gid }); continue; }

      const sheet = inList(hit.p, s.uuid, 'id');
      if (sheet === true) R.onTeamSheet++; else if (sheet === false) R.notOnTeamSheet++;

      const hasBox = (Array.isArray(hit.hp) && hit.hp.length) || (Array.isArray(hit.ap) && hit.ap.length);
      if (!hasBox) {
        R.noBoxStored++;
        ex('noBoxStored', { uuid: s.uuid, name: s.name, gid, sid: hitSid, hasScore: typeof hit.hs === 'number' });
        continue;
      }
      const inH = inList(hit.hp, s.uuid, 'profileID');
      const inA = inList(hit.ap, s.uuid, 'profileID');
      if (inH === true || inA === true) {
        R.undercount++;
        const row = [...(hit.hp || []), ...(hit.ap || [])].find(e => resolve(e.profileID) === s.uuid) || {};
        ex('undercount', { uuid: s.uuid, name: s.name, gid, sid: hitSid, date: hit.d || null, stats: { pts: row.pts ?? null, fouls: row.f ?? row.fouls ?? null } });
      } else if (inH === null && inA === null) {
        // Every id on both sides failed to resolve. That is a matching failure,
        // not evidence the player was absent, and is counted apart from both.
        R.idUnresolvable++;
      } else {
        R.namedNotPlayed++;
        ex('namedNotPlayed', { uuid: s.uuid, name: s.name, gid, sid: hitSid, date: hit.d || null, onTeamSheet: sheet });
      }
    }
  }

  const decided = R.undercount + R.namedNotPlayed;
  const pct = (n, d) => d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';

  console.log(`\n  players sampled        : ${R.playersSampled.toLocaleString()}`);
  console.log(`  x entries examined     : ${R.xEntries.toLocaleString()}`);
  console.log(`\n  ── DECIDABLE FROM FILES (${decided.toLocaleString()}) ──`);
  console.log(`    PLAYHQ UNDERCOUNT      : ${R.undercount.toLocaleString()}  ${pct(R.undercount, decided)}   in PlayHQ's own box score, not in its career totals`);
  console.log(`    named, did not play    : ${R.namedNotPlayed.toLocaleString()}  ${pct(R.namedNotPlayed, decided)}   on the team sheet, no box-score row`);
  console.log(`\n  ── NOT DECIDABLE ──`);
  console.log(`    no box score stored    : ${R.noBoxStored.toLocaleString()}`);
  console.log(`    game in no season      : ${R.unresolved.toLocaleString()}`);
  console.log(`    no id on either side resolved : ${R.idUnresolvable.toLocaleString()}`);
  console.log(`\n  on the team sheet      : ${R.onTeamSheet.toLocaleString()} of ${(R.onTeamSheet + R.notOnTeamSheet).toLocaleString()} resolvable`);

  if (decided > 0) {
    const share = R.undercount / decided;
    console.log('');
    if (share > 0.8)      console.log('    \u2192 Overwhelmingly a PlayHQ undercount. Its own box score has the player,\n      its own career totals leave the game out. The NOT CREDITED badge is right.');
    else if (share < 0.2) console.log('    \u2192 Overwhelmingly named-but-did-not-play. `x` is accurate but the label is\n      wrong: PlayHQ is right not to credit a game the player did not take part in.');
    else                  console.log('    \u2192 Both shapes present in quantity. The examples below need reading before\n      any single label can be put on this field.');
  }

  for (const k of ['undercount', 'namedNotPlayed', 'noBoxStored', 'unresolved']) {
    console.log(`\n  ── examples: ${k} ──`);
    for (const e of R.examples[k]) {
      console.log(`    ${e.uuid.slice(0, 8)}  ${e.gid}  ${(e.date || '').slice(0, 10)}  ${e.stats ? `pts=${e.stats.pts} f=${e.stats.fouls}  ` : ''}${(e.name || '').slice(0, 24)}`);
    }
    if (!R.examples[k].length) console.log('    —');
  }

  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(R, null, 2), 'utf8');
  console.log(`\n  Report: ${REPORT_REL}`);
  if (DRY_RUN) { log('dry run - not committing.'); return; }

  // Report-only tool: 5 push attempts, not 60. The report regenerates in a couple
  // of minutes and no player file is at risk, so waiting 45 minutes to preserve it
  // is a bad trade - the mistake that left a 20-minute hang on 2026-09-04.
  const GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
  execSync(`git add -- ${REPORT_REL}`, GIT);
  const staged = execSync('git diff --staged --shortstat', GIT).toString().trim();
  if (!staged) { log('report unchanged, nothing to commit.'); return; }
  log(`staging: ${staged}`);
  execSync(`git commit -q -m "validate-uncredited-games: ${R.undercount} undercount / ${R.namedNotPlayed} not played of ${R.xEntries} examined"`, GIT);
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
      if (attempt === 5) { log('giving up on the commit. Nothing was written to players/; re-run to regenerate.'); return; }
      execSync(`sleep ${1 + Math.floor(Math.random() * 15)}`, { stdio: 'pipe' });
    }
  }
}

main();
