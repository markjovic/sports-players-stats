// scripts/audit-team-fixtures.js
//
// READ-ONLY. No PlayHQ calls, no writes, no commit, no data-write lock.
// Prints the EXACT stored state of one or more teams' fixtures from the files
// already in the checkout, and the team-stats row derived from them.
//
// WHY IT EXISTS. The stale-fixture work (2026-11-22) needs a BEFORE and an
// AFTER that are measurements rather than descriptions, and the session that
// designed it cannot read this repository at all: raw.githubusercontent.com is
// refused at the egress proxy, `gh api` returns 403 for the repo, and
// markjovic.github.io is blocked by org policy in both browsers. All four were
// retested on 2026-11-22, not assumed (T78). So the only way to establish what
// is on disk is to print it from a dispatch.
//
// It also answers, with real data, the two design questions the code alone
// could not settle:
//   · how many of this team's stored games carry an `rn` — because the deletion
//     scope is (gid, rn) and a game with no `rn` CANNOT be scoped to a round and
//     must therefore never be deleted;
//   · whether the team's games span more than one `gid` — which is what makes
//     build-team-stats' meta.grade (the grade of the LATEST DATED GAME) wrong.
//
// MAIN REPO ONLY. Locked seasons' game files live in the ARCHIVE repo (the
// active/locked split, 2026-08-07), so a season absent from games/bv here is
// reported as ABSENT and never as empty. An unparseable file is NAMED and the
// run goes red — a failure to READ must never be recorded as a finding of
// nothing (the failure-to-ASK class, four strikes).
//
// Usage:
//   node scripts/audit-team-fixtures.js --tid=cd0814a3-....
//   node scripts/audit-team-fixtures.js --tid=<a>,<b> --sid=<seasonId>
//   node scripts/audit-team-fixtures.js --tid=cd0814a3 --unplayed-only
//
// A tid may be given in full or as any unique prefix — team ids are stored
// FULL-LENGTH in games/bv (only PLAYER ids are truncated; see uuid-prefix.cjs),
// so a prefix match here is a convenience for typing, and an ambiguous prefix
// is reported rather than resolved by guessing.

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const GAMES_DIR      = path.join(ROOT, 'games', 'bv');
const TEAM_STATS_DIR = path.join(ROOT, 'team-stats', 'bv');
const INDEX_FILE     = path.join(ROOT, 'data', 'sports-index.json');

const TIDS = String(ARGS.tid || '').split(',').map(s => s.trim()).filter(Boolean);
const SID_FILTER   = ARGS.sid ? String(ARGS.sid).trim() : null;
const UNPLAYED_ONLY = !!ARGS['unplayed-only'];

if (!TIDS.length) {
  console.error('audit-team-fixtures: --tid=<teamId>[,<teamId>...] is required');
  process.exit(1);
}

// Terminal-status allowlist, identical to nightly-crawl.js L749. Tested as an
// allowlist and never as a test for one non-terminal value (T53).
const TERMINAL_STATUS = new Set(['FINAL', 'CANCELLED', 'ABANDONED', 'BYE']);

// A game is PLAYED — and therefore out of scope for any deletion — when it
// carries a score, is FINAL, or is a forfeit. Same predicate discover-fixtures.js
// L924-925 uses to refuse to rewrite history, written once here so the audit and
// the eventual deleting consumer cannot disagree about what "unplayed" means.
function isPlayed(g) {
  return g.hs !== undefined || g.as !== undefined || g.st === 'FINAL' || g.forfeit === true;
}

// ⚠ h/a AND t1/t2. A game carries ONE pair or the other, never both — hidden
// games use t1/t2 (T44). Five places in build-win-loss.js read only h/a for
// months and contributed zero wins for every hidden game. Never write a sixth
// fallback; both pairs, every time.
function sides(g) {
  return {
    hid: g.h  ?? g.t1  ?? null,
    aid: g.a  ?? g.t2  ?? null,
    hn:  g.hn ?? g.t1n ?? '',
    an:  g.an ?? g.t2n ?? '',
  };
}

function pad(s, n) { s = String(s ?? ''); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function val(v)     { return (v === undefined || v === null || v === '') ? '∅' : String(v); }

function main() {
  console.log('audit-team-fixtures.js — READ-ONLY, no PlayHQ, no writes');
  console.log(`  tids:   ${TIDS.join(', ')}`);
  if (SID_FILTER)   console.log(`  season: ${SID_FILTER}`);
  if (UNPLAYED_ONLY) console.log('  scope:  UNPLAYED games only');
  console.log('─'.repeat(78));

  if (!fs.existsSync(GAMES_DIR)) {
    console.error(`FATAL: ${GAMES_DIR} not found — wrong checkout?`);
    process.exit(1);
  }

  let seasonNames = {};
  try { seasonNames = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).seasons || {}; }
  catch (e) { console.log(`  ⚠ sports-index.json unreadable (${e.message}) — season names will print as ids`); }

  const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort();
  console.log(`  scanning ${files.length} season files in games/bv\n`);

  // tid -> sid -> [{gameId, game}]
  const hits = new Map();
  // Any full tid a given prefix matched, so an ambiguous prefix is REPORTED.
  const resolved = new Map();
  const unreadable = [];

  for (const fname of files) {
    const sid = fname.replace(/\.json$/, '');
    if (SID_FILTER && sid !== SID_FILTER) continue;

    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); }
    catch (e) { unreadable.push(`${sid}: ${e.message}`); continue; }

    for (const [gameId, g] of Object.entries(gf.games || {})) {
      if (!g) continue;
      const { hid, aid } = sides(g);
      for (const want of TIDS) {
        const matched = (hid && hid.startsWith(want)) ? hid
                      : (aid && aid.startsWith(want)) ? aid
                      : null;
        if (!matched) continue;
        if (!resolved.has(want)) resolved.set(want, new Set());
        resolved.get(want).add(matched);
        if (!hits.has(want)) hits.set(want, new Map());
        const bySid = hits.get(want);
        if (!bySid.has(sid)) bySid.set(sid, []);
        bySid.get(sid).push({ gameId, g });
      }
    }
  }

  // A file that could not be READ is a fault, never a finding of nothing.
  if (unreadable.length) {
    console.log(`⚠ ${unreadable.length} season file(s) could not be parsed — this audit is INCOMPLETE:`);
    for (const u of unreadable.slice(0, 20)) console.log(`    ${u}`);
  }

  let anyFound = false;
  // Tracked separately from anyFound: an ambiguous prefix IS found, just not
  // resolvable, and reporting it as "not found" sends the reader to look for a
  // missing team when the team is right there twice. Caught by running the
  // sandbox case rather than by reading the code (directive 17).
  const ambiguous = [];

  for (const want of TIDS) {
    console.log('═'.repeat(78));
    console.log(`TEAM ${want}`);
    console.log('═'.repeat(78));

    const full = resolved.get(want);
    if (!full || full.size === 0) {
      console.log('  NOT FOUND in games/bv.');
      console.log('  This means one of three different things and the audit cannot tell them apart:');
      console.log('    · the team has no games on file yet (pre-season / draw unpublished);');
      console.log('    · its season is LOCKED, so its game file lives in the archive repo;');
      console.log('    · the tid is wrong.');
      console.log('  Check data/team-index.json for the tid before concluding anything.\n');
      continue;
    }
    if (full.size > 1) {
      console.log(`  ⚠ AMBIGUOUS PREFIX — matches ${full.size} team ids: ${[...full].join(', ')}`);
      console.log('  Re-run with the full id. Nothing below is trustworthy for this entry.\n');
      ambiguous.push(want);
      continue;
    }
    const tid = [...full][0];
    if (tid !== want) console.log(`  resolved prefix → ${tid}`);
    anyFound = true;

    const bySid = hits.get(want);

    for (const [sid, entries] of bySid) {
      const sName = seasonNames[sid]?.fullName || seasonNames[sid]?.name || '(name unknown)';
      const locked = seasonNames[sid]?.locked;
      console.log(`\n── season ${sid}  ${sName}${locked === true ? '  [LOCKED]' : locked === false ? '  [active]' : ''}`);

      const rows = entries
        .filter(e => !UNPLAYED_ONLY || !isPlayed(e.g))
        .sort((a, b) => String(a.g.d || '9999').localeCompare(String(b.g.d || '9999')));

      console.log(`   ${entries.length} game(s) stored${UNPLAYED_ONLY ? `, ${rows.length} unplayed` : ''}`);
      console.log('');
      console.log(`   ${pad('gameId', 38)} ${pad('date', 11)} ${pad('time', 6)} ${pad('round (rn)', 20)} ${pad('status', 11)} ${pad('score', 9)} opponent / grade / venue`);
      console.log(`   ${'-'.repeat(38)} ${'-'.repeat(11)} ${'-'.repeat(6)} ${'-'.repeat(20)} ${'-'.repeat(11)} ${'-'.repeat(9)} ${'-'.repeat(30)}`);

      for (const { gameId, g } of rows) {
        const { hid, aid, hn, an } = sides(g);
        const home    = hid === tid;
        const oppId   = home ? aid : hid;
        const oppName = home ? an  : hn;
        const score   = (g.hs !== undefined && g.as !== undefined)
          ? (home ? `${g.hs}-${g.as}` : `${g.as}-${g.hs}`)
          : '∅';
        const flags = [
          g.forfeit ? 'forfeit' : null,
          g.hidden  ? 'hidden'  : null,
          g.legacy  ? 'legacy'  : null,
          g.spc     ? 'spc'     : null,
          g.dg      ? 'dg'      : null,
          Array.isArray(g.p) ? `p=${g.p.length}` : null,
        ].filter(Boolean).join(' ');

        console.log(`   ${pad(gameId, 38)} ${pad(val(g.d), 11)} ${pad(val(g.t), 6)} ${pad(val(g.rn), 20)} ${pad(val(g.st), 11)} ${pad(score, 9)} ${home ? 'v ' : '@ '}${val(oppName)} [${val(oppId).slice(0, 8)}]`);
        console.log(`   ${' '.repeat(38)} ${' '.repeat(11)} ${' '.repeat(6)} grade: ${val(g.gn)} [${val(g.gid).slice(0, 8)}]   venue: ${val(g.vn)}${g.ct ? ' / ' + g.ct : ''}${flags ? '   flags: ' + flags : ''}`);
      }

      // ── The two facts the deletion design turns on ────────────────────────
      const unplayed = entries.filter(e => !isPlayed(e.g));
      const noRn     = unplayed.filter(e => !e.g.rn);
      const grades   = new Map();   // gid -> {gn, n, latestDate}
      for (const { g } of entries) {
        if (!g.gid) continue;
        const e = grades.get(g.gid) || { gn: g.gn || '', n: 0, latest: null };
        e.n++;
        if (g.d && (!e.latest || g.d > e.latest)) e.latest = g.d;
        if (!e.gn && g.gn) e.gn = g.gn;
        grades.set(g.gid, e);
      }

      console.log('');
      console.log(`   GRADES this team's stored games sit in: ${grades.size}`);
      for (const [gid, e] of [...grades.entries()].sort((a, b) => String(b[1].latest).localeCompare(String(a[1].latest)))) {
        console.log(`     ${pad(gid, 38)} ${pad(e.gn || '(no name)', 26)} ${pad(e.n + ' game(s)', 12)} latest game ${val(e.latest)}`);
      }
      if (grades.size > 1) {
        console.log('     ⚠ MORE THAN ONE GRADE. build-team-stats.js sets meta.grade from the grade of the');
        console.log('       team\'s LATEST DATED GAME, so whichever row is top above is what StatTrack shows.');
        console.log('       If that is the OLD grade, this is the meta.grade fault and the cause is the row');
        console.log('       below it still being on disk.');
      }

      console.log('');
      console.log(`   UNPLAYED games: ${unplayed.length}  (no score, not FINAL, not forfeit — the only ones any deletion may touch)`);
      console.log(`   of those, carrying NO round name (rn): ${noRn.length}`);
      if (noRn.length) {
        console.log('     ⚠ A game with no `rn` cannot be scoped to a round — games/bv stores no round id,');
        console.log('       only the round NAME — so these are OUT OF SCOPE for a (gid, rn) deletion and must');
        console.log('       never be deleted by it. Listing them, because they are the blind spot:');
        for (const { gameId, g } of noRn.slice(0, 20)) {
          console.log(`       ${gameId}  d=${val(g.d)}  gid=${val(g.gid).slice(0, 8)}  st=${val(g.st)}`);
        }
      }

      // Rounds, in the exact (gid, rn) shape the deletion scope will use.
      const roundKeys = new Map();
      for (const { gameId, g } of entries) {
        if (!g.gid || !g.rn) continue;
        const k = `${g.gid}|${g.rn}`;
        const e = roundKeys.get(k) || { gid: g.gid, rn: g.rn, ids: [], unplayed: 0 };
        e.ids.push(gameId);
        if (!isPlayed(g)) e.unplayed++;
        roundKeys.set(k, e);
      }
      console.log('');
      console.log(`   ROUND SCOPES (gid, rn) this team appears in: ${roundKeys.size}`);
      for (const e of [...roundKeys.values()]) {
        console.log(`     ${pad(e.rn, 22)} gid ${pad(e.gid.slice(0, 8), 10)} ${e.ids.length} game(s), ${e.unplayed} unplayed`);
      }

      // ── team-stats, the file StatTrack actually renders ───────────────────
      const tsFile = path.join(TEAM_STATS_DIR, `${sid}.json`);
      console.log('');
      if (!fs.existsSync(tsFile)) {
        console.log(`   team-stats/bv/${sid}.json: ABSENT — StatTrack's team view will say "Team not found".`);
      } else {
        let ts = null;
        try { ts = JSON.parse(fs.readFileSync(tsFile, 'utf8')); }
        catch (e) { console.log(`   ⚠ team-stats/bv/${sid}.json failed to parse (${e.message})`); }
        const t = ts ? ts[tid] : null;
        if (!t) {
          console.log(`   team-stats/bv/${sid}.json: present, but holds NO entry for ${tid}.`);
        } else {
          console.log(`   team-stats/bv/${sid}.json  →  ${tid}`);
          console.log(`     meta.name  : ${val(t.meta?.name)}`);
          console.log(`     meta.club  : ${val(t.meta?.club)}`);
          console.log(`     meta.gid   : ${val(t.meta?.gid)}`);
          console.log(`     meta.grade : ${val(t.meta?.grade)}     ← THIS is what StatTrack's grade filter reads`);
          console.log(`     roster     : ${Object.keys(t.roster || {}).length} player(s)`);
          console.log(`     fixtures   : ${(t.fixtures || []).length}`);

          // Drift between the two files is the thing a rebuild is supposed to clear.
          const gameIds    = new Set(entries.map(e => e.gameId));
          const fixtureIds = new Set((t.fixtures || []).map(f => f.gameId));
          const onlyInTs   = [...fixtureIds].filter(x => !gameIds.has(x));
          const onlyInGames = [...gameIds].filter(x => !fixtureIds.has(x));
          console.log(`     fixtures present in team-stats but NOT in games/bv: ${onlyInTs.length}${onlyInTs.length ? '  ← team-stats is STALE, rebuild it' : ''}`);
          for (const x of onlyInTs.slice(0, 20)) console.log(`       ${x}`);
          console.log(`     games present in games/bv but NOT in team-stats:    ${onlyInGames.length}${onlyInGames.length ? '  ← team-stats is STALE, rebuild it' : ''}`);
          for (const x of onlyInGames.slice(0, 20)) console.log(`       ${x}`);
        }
      }
    }
    console.log('');
  }

  console.log('═'.repeat(78));
  if (unreadable.length) {
    console.error(`FAILING: ${unreadable.length} season file(s) could not be parsed — the scan above did not cover them.`);
    process.exit(1);
  }
  if (ambiguous.length) {
    console.error(`FAILING: ${ambiguous.length} tid(s) given as a prefix that matches more than one team: ${ambiguous.join(', ')}. Re-run with the full ids.`);
    process.exit(1);
  }
  if (!anyFound) {
    console.error('FAILING: none of the requested tids were found in games/bv. See the notes above each team.');
    process.exit(1);
  }
  console.log('Done. Nothing was written.');
}

main();
