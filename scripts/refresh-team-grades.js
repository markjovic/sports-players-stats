// scripts/refresh-team-grades.js
// REVISION 2026-09-10a — first version.
//
// Sets the `grade` on every entry in data/team-index.json from that team's MOST
// RECENT GAME, replacing whichever grade happened to be recorded when the team was
// first seen.
//
// WHY THE STORED GRADE IS WRONG
// ─────────────────────────────
// update-team-index.js creates a team entry from a player's registration and never
// revisits it, so `grade` holds whatever the FIRST registration it met happened to
// say — effectively arbitrary. StatTrack renders it at index.html L1640 as the team
// search subtitle, `[t.comp, t.grade].filter(Boolean).join(' · ')`, so a regraded
// team has been showing the wrong division ever since it was added.
//
// AND WHY IT CANNOT BE FIXED FROM REGISTRATIONS
// ────────────────────────────────────────────
// Decision A (2026-08-01): a registration IS a (team, grade) pair, so a team under
// two grades in one season is a REGRADE and correct data — 1,296,352 regs are that
// shape. There is no "current" registration: measured on Toby Jovic (0afc7690),
// across four regrades the RES grade is reg[1] twice and reg[0] twice, so array
// order carries no chronology and a reg has no date. Keying on tid alone and taking
// the last one produced 2,175,659 churning "corrections" across 360,777 teams on
// 2026-09-08 (T57).
//
// Games do have dates. The most recent game a team actually played is the only
// non-arbitrary answer to "what grade is this team in now".
//
// ⚠ T105, 2026-11-24 — THE CODE DID NOT DO WHAT THE PARAGRAPH ABOVE SAYS. It took
// the latest DATED game carrying `gn`, played or not, and `d > prev.d` is strict
// so two games on one date were resolved by whichever key Object.keys() yielded
// first: stable, therefore never self-contradicting, and arbitrary, therefore
// never right on purpose. A `sup` fixture - past-dated, unplayed, the one the
// association replaced when it regraded the team - could therefore hand a team
// back the grade it had just been moved out of, in the field StatTrack renders
// as the team search subtitle.
//
// It now reads, in order:
//   · tier 1, a PLAYED game (isPlayedGame, the same predicate the nightly uses)
//   · tier 2, an unplayed fixture NOT flagged `sup` - a team between allocation
//     and its first game has nothing else, and that case is real
//   · and a `sup` fixture never, at any tier
// Within a tier: date, then time, then game id. The id is not chronology; it is
// an explicit, stated arbitrary tie-break so the answer is identical in every run
// and in every reader. Ties are counted and printed, not absorbed.
//
// A doc comment asserting "actually played" over code with no played test is
// worse than no comment, because it is read instead of the code.
//
// COVERAGE IS PARTIAL AND THAT IS STATED, NOT HIDDEN
// ──────────────────────────────────────────────────
// Only some games carry `gn`. Measured 2026-09-10 on games/bv/26df4252.json: 428 of
// 1,129. The absence is not explained by any flag — hidden, profileOnly, spc and dg
// all appear on both sides — it is simply inconsistent capture. games/bv/fe2002db.json
// carries `gn` on NONE of its 96 games.
//
// That matters far less than it sounds, because a team needs only ONE graded game:
// in 26df4252, 526 of ~530 teams are reachable. A team with no graded game anywhere
// KEEPS ITS EXISTING GRADE and is counted as unreachable. Nothing is ever blanked.
//
// It also writes `gradeFrom`, the date of the game the grade came from, so the next
// person can see how current it is instead of trusting it.
//
// FULL CHECKOUT, NOT SPARSE. team-index spans essentially every season, so naming
// the files is slower than cloning — sparse checkout fetches roughly one blob per
// second and games/bv is 2,966 files.
//
// Run:
//   node scripts/refresh-team-grades.js --dry-run
//   node scripts/refresh-team-grades.js
//   node scripts/refresh-team-grades.js --dry-run --season=26df4252

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
// ONE PREDICATE AND ONE SIDE READER, NOT A SECOND COPY OF EITHER (T103/T105).
// `sideIds` is the only correct way to read a game's two team ids - `g.h ?? g.t1`,
// `g.a ?? g.t2`. `hTid`/`aTid` do not exist as fields in games/bv.
const { isPlayedGame, sideIds } = require('./lib/round-refresh.cjs');

const ROOT       = path.join(__dirname, '..');
const TEAM_INDEX = path.join(ROOT, 'data', 'team-index.json');
const TEAM_REL   = 'data/team-index.json';
const GAMES_DIR  = path.join(ROOT, 'games', 'bv');

const args   = process.argv.slice(2);
const argVal = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const DRY_RUN    = args.includes('--dry-run');
const ONE_SEASON = argVal('season', '');

const GIT_OPTS      = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const PUSH_ATTEMPTS = 60;
const log = (m) => console.log(`[team-grades] ${new Date().toISOString()} ${m}`);

// House pattern: per-path add, shortstat, commit before merge, merge --abort between
// attempts, retry with jitter, THROW on exhaustion.
function gitCommit(message, paths) {
  let staged = 0;
  for (const p of paths) {
    try { execSync(`git add -- ${p}`, GIT_OPTS); staged++; }
    catch (e) { console.error(`  ⚠ git add FAILED "${p}": ${(e.stderr || e.stdout || '').toString().trim() || e.message}`); }
  }
  if (!staged) throw new Error('git add staged NOTHING — refusing to continue');

  const shortstat = execSync('git diff --staged --shortstat', GIT_OPTS).toString().trim();
  if (!shortstat) { console.log('  staging: no changes — nothing to commit'); return; }
  console.log(`  staging: ${shortstat}`);
  execSync(`git commit -q -m "${message.replace(/"/g, "'")}"`, GIT_OPTS);

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try { execSync('git merge --abort', GIT_OPTS); } catch (_) { /* none in progress */ }
    try {
      execSync('git fetch origin main', GIT_OPTS);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT_OPTS);
      execSync('git push origin main', GIT_OPTS);
      console.log(`  ✔ pushed (attempt ${attempt}): ${message}`);
      return;
    } catch (e) {
      const detail = (e.stderr || e.stdout || '').toString().trim().slice(0, 200) || e.message.slice(0, 200);
      if (attempt === PUSH_ATTEMPTS) throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${detail}`);
      const s = 1 + Math.floor(Math.random() * 91);
      execSync(`sleep ${s}`, { stdio: 'pipe', cwd: ROOT });
    }
  }
}

function main() {
  log(`refresh-team-grades${DRY_RUN ? '  (DRY RUN)' : ''}${ONE_SEASON ? `  season=${ONE_SEASON}` : ''}`);
  console.log('─'.repeat(86));

  const teamIndex = JSON.parse(fs.readFileSync(TEAM_INDEX, 'utf8'));
  const entries = [];
  for (const [seasonName, arr] of Object.entries(teamIndex)) {
    if (!Array.isArray(arr)) continue;
    for (const e of arr) if (e && e.id && e.sid) entries.push({ e, seasonName });
  }
  const totalBefore = entries.length;
  const idsBefore = new Set(entries.map(x => x.e.id));
  console.log(`  team-index entries    : ${totalBefore}`);
  console.log(`  distinct season names : ${Object.keys(teamIndex).length}`);

  // Which seasons we need, and only those.
  const wanted = new Set();
  for (const { e } of entries) if (!ONE_SEASON || e.sid === ONE_SEASON) wanted.add(e.sid);
  console.log(`  seasons to read       : ${wanted.size}`);

  // sid -> Map(tid -> { gn, d })  the LATEST-dated graded game for that team.
  const latest = new Map();
  let filesRead = 0, filesMissing = 0, gamesSeen = 0, gamesGraded = 0;
  let gamesSup = 0, gamesPlayed = 0, gamesUnplayed = 0, ties = 0;

  for (const sid of wanted) {
    const file = path.join(GAMES_DIR, `${sid}.json`);
    if (!fs.existsSync(file)) { filesMissing++; continue; }
    let gf;
    try { gf = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { filesMissing++; continue; }
    filesRead++;

    const m = new Map();
    // Object.ENTRIES, not values: the game id is the stated tie-break and the old
    // loop did not have it in hand.
    for (const [gkey, g] of Object.entries(gf.games || {})) {
      gamesSeen++;
      if (!g.gn) continue;                       // only a graded game can answer this
      gamesGraded++;
      // A superseded fixture is never a grade source - see T105 above.
      if (g.sup) { gamesSup++; continue; }
      const tier = isPlayedGame(g) ? 1 : 2;
      if (tier === 1) gamesPlayed++; else gamesUnplayed++;
      const cur = { gn: g.gn, d: g.d || '', t: g.t || '', key: gkey, tier };
      // T34/T103: sideIds reads h/a OR t1/t2. Never re-derive it here.
      for (const tid of sideIds(g)) {
        const prev = m.get(tid);
        if (!prev) { m.set(tid, cur); continue; }
        // A played game always beats an unplayed fixture, whatever the dates say.
        if (cur.tier !== prev.tier) { if (cur.tier < prev.tier) m.set(tid, cur); continue; }
        if (!cur.d) continue;                       // undated never displaces dated
        if (!prev.d) { m.set(tid, cur); continue; }
        if (cur.d !== prev.d) { if (cur.d > prev.d) m.set(tid, cur); continue; }
        if (cur.t !== prev.t) { if (cur.t > prev.t) m.set(tid, cur); continue; }
        ties++;
        if (cur.key > prev.key) m.set(tid, cur);
      }
    }
    latest.set(sid, m);
  }

  console.log(`  games files read      : ${filesRead}   (missing/unreadable ${filesMissing})`);
  console.log(`  games scanned         : ${gamesSeen}   of which carry a grade name: ${gamesGraded}`);
  console.log(`  graded and PLAYED     : ${gamesPlayed}   ← tier 1, the only non-arbitrary answer`);
  console.log(`  graded and unplayed   : ${gamesUnplayed}   ← tier 2, used only where a team has no played game`);
  console.log(`  superseded (sup)      : ${gamesSup}   ← never a grade source, at any tier`);
  console.log(`  same date AND time    : ${ties}   ← resolved on game id, deterministically`);

  let updated = 0, alreadyRight = 0, unreachable = 0, skipped = 0;
  const changes = [];

  for (const { e } of entries) {
    if (ONE_SEASON && e.sid !== ONE_SEASON) { skipped++; continue; }
    const m = latest.get(e.sid);
    const hit = m && m.get(e.id);
    // No graded game anywhere for this team: KEEP what is there. Never blank a value
    // because the evidence to replace it is missing.
    if (!hit) { unreachable++; continue; }
    if (e.grade === hit.gn) { alreadyRight++; e.gradeFrom = hit.d; continue; }
    if (changes.length < 30) changes.push(`    ${e.id}  ${JSON.stringify(e.grade || '')} → ${JSON.stringify(hit.gn)}   (from the game on ${hit.d})`);
    e.grade = hit.gn;
    e.gradeFrom = hit.d;
    updated++;
  }

  // ── Assertions. Only `grade` and `gradeFrom` may move. ─────────────────────
  const after = [];
  for (const arr of Object.values(teamIndex)) if (Array.isArray(arr)) for (const e of arr) if (e && e.id) after.push(e);
  if (after.length !== totalBefore) throw new Error(`ABORT: entry count changed ${totalBefore} → ${after.length}. Nothing written.`);
  for (const e of after) if (!idsBefore.has(e.id)) throw new Error(`ABORT: entry id ${e.id} appeared from nowhere. Nothing written.`);
  const blanked = after.filter(e => e.grade === '' || e.grade === undefined).length;

  console.log(`\n${'═'.repeat(86)}`);
  console.log(`  grade updated         : ${updated}`);
  console.log(`  already correct       : ${alreadyRight}`);
  console.log(`  no graded game found  : ${unreachable}   ← existing grade KEPT, never blanked`);
  if (skipped) console.log(`  skipped (--season)    : ${skipped}`);
  console.log(`  entries with no grade : ${blanked}   (unchanged by this tool)`);
  console.log(`  assertions            : PASSED — entry count and every id unchanged`);
  console.log(`${'═'.repeat(86)}`);
  if (changes.length) { console.log(`\n  changes:`); changes.forEach(c => console.log(c)); if (updated > changes.length) console.log(`    … and ${updated - changes.length} more`); }

  console.log(`\n  Every updated entry now carries gradeFrom — the date of the game the grade came`);
  console.log(`  from — so how current it is can be read rather than assumed.`);
  if (unreachable) {
    console.log(`\n  ${unreachable} team(s) have no game carrying a grade name anywhere in their season.`);
    console.log(`  Only some games carry gn: 428 of 1,129 in games/bv/26df4252.json, and NONE of`);
    console.log(`  the 96 in fe2002db.json. Their grade is whatever it was and stays that way.`);
  }

  if (!updated) { log('nothing to update.'); return; }
  if (DRY_RUN) { log('dry run — team-index.json not written.'); return; }
  fs.writeFileSync(TEAM_INDEX, JSON.stringify(teamIndex));
  gitCommit(`refresh-team-grades: ${updated} team grade(s) set from the most recent played game`, [TEAM_REL]);
  log('StatTrack team search reads this as its subtitle (index.html L1640).');
}

main();
