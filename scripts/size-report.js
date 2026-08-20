// scripts/size-report.js
//
// READ-ONLY, offline, zero API calls. Sections selected by the SECTIONS env var
// (all, or a comma-separated list); TOP controls how many rows each ranked table
// prints. Run by .github/workflows/size-report.yml.
//
// MOVED OUT OF THE WORKFLOW 2026-08-19. It lived as a heredoc inside the YAML,
// which meant GitHub Actions echoed the entire ~1,000-line script into the run log
// before executing it — every dispatch, ahead of any output worth reading. A file
// on disk is not echoed.
//
// `scripts/size-report.js`, not `scripts/lib/*.cjs`: `scripts/lib` is for the two
// LIBRARIES (uuid-prefix.cjs, namespace-resolve.cjs) and the manifest says those
// are the only ones. This is an executable a workflow runs, so it sits beside the
// other executables — and takes their extension. `size-appearance-gaps.js` is the
// direct precedent: read-only sizing, `.js`, CommonJS `require`. There is no
// package.json setting `type: module`, so `.js` is CommonJS by default and the
// `.cjs` extension bought nothing.

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.env.SCAN_ROOT || '.';
const TOP = Number(process.env.TOP || 15);
const rawSections = String(process.env.SECTIONS || 'all').toLowerCase().trim();
const ALL = ['misses', 'resweep', 'rosters', 'gaps', 'consolidation', 'collisions', 'grades'];
// Old names still work — three of these tools were dispatched by name for
// weeks and a rename should not silently run nothing.
const ALIAS = { 'negative-gap': 'gaps', 'gap-players': 'gaps', 'repair-rosters': 'rosters' };
const WANT = new Set((rawSections === 'all' || rawSections === ''
  ? ALL
  : rawSections.split(',').map(s => s.trim()).filter(Boolean)).map(s => ALIAS[s] || s));
for (const s of WANT) if (!ALL.includes(s)) console.log('  ⚠ unknown section "' + s + '" — ignored. Known: ' + ALL.join(', '));
const want = (s) => WANT.has(s);
const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';

let idx = {};
try { idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sports-index.json'), 'utf8')).seasons || {}; } catch (e) {}

// ── Game-centre URLs ───────────────────────────────────────────────────────
// VERIFIED 2026-08-16 against a live page: the segments after /org/ are the
// org SLUG, the org ID and the SEASON ID. Every size-* tool previously printed
// the literal "a/a/a" there, so every spot-check link they ever produced was
// dead — which is why "spot-check the URLs" stayed on the list for weeks.
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// CORRECTED AGAIN 2026-08-18, this time against a real Ballarat URL rather
// than a guess. The shape is:
//   /basketball-victoria/org/<org-slug>/<SEASON-slug>/<grade-slug>/game-centre/<gid>
// e.g. .../org/ballarat-basketball-association/
//           smith-and-sons-renovation-and-extensions-junior-domestic-winter-2026/
//           friday-u19-boys-e/game-centre/b4e6cc16
//
// The season slug is the season's FULL name including any sponsor prefix, which
// sports-index carries as `fullName` (e.g. "Junior Domestic — Winter 2026").
// Three earlier attempts put the season ID, then the org ID, in that slot and
// produced dead links every time. The lesson is the one this session keeps
// paying for: I confirmed a NEARBY url (the season page, which does resolve on
// an id) and treated it as confirmation of this one. Only a real game URL,
// clicked through by hand, settled it.
const gradeSlug = new Map();   // gid -> slugified grade name
const gameUrl = (sid, gid) => {
  const meta = idx[sid];
  const gs = gradeSlug.get(gid);
  if (!meta || !meta.orgName) return '(no orgName in sports-index for season ' + sid + ' — game ' + gid + ')';
  const seasonSlug = slugify(meta.fullName || meta.name);
  if (!seasonSlug) return '(no season name in sports-index for ' + sid + ' — game ' + gid + ')';
  if (!gs) return '(no grade name stored on game ' + gid + ' — cannot build a URL)';
  return 'https://www.playhq.com/basketball-victoria/org/' + slugify(meta.orgName) + '/' + seasonSlug + '/' + gs + '/game-centre/' + gid;
};

// ── Flags packed into one integer per game ─────────────────────────────────
// 2.35M games, so a bitmask plus a season INDEX rather than an object and a
// string per game. Same information, a fraction of the heap.
const F_SPC = 1, F_DG = 2, F_PO = 4, F_FORFEIT = 8, F_BYE = 16,
      F_CANCELLED = 32, F_ABANDONED = 64, F_LEGACY = 128, F_NOTFINAL = 256, F_ROSTER = 512;
const UNCOUNTABLE = F_FORFEIT | F_BYE | F_CANCELLED | F_ABANDONED | F_LEGACY | F_NOTFINAL | F_PO;

const sidList = [];
const sidIdx = new Map();
const gameFlags = new Map();   // gid -> flags
const gameSid   = new Map();   // gid -> index into sidList
// Team ids interned to integers: 2.35M games x 2 ids as strings is a lot of
// heap for what is really a few hundred thousand distinct teams.
const tidList = [], tidIdx = new Map();
const internTid = (t) => {
  if (!t) return -1;
  let i = tidIdx.get(t);
  if (i === undefined) { i = tidList.length; tidList.push(t); tidIdx.set(t, i); }
  return i;
};
const gameH = new Map();       // gid -> tid index (home)
const gameA = new Map();       // gid -> tid index (away)
// Grade id referenced by each game, per season — the offline proof of a
// stale grade list (see the `grades` section).
const seasonGradeUse = new Map();   // sid -> Map(gradeId -> games)

// ── ONE PASS over games/bv ────────────────────────────────────────────────
const gamesDir = path.join(ROOT, 'games', 'bv');
if (!fs.existsSync(gamesDir)) { console.error('ABORT: games/bv missing'); process.exit(1); }

let totGames = 0, allSpc = 0, allDg = 0, allPo = 0, allNone = 0;
const missSeasons = [];
const byYearMiss = new Map();
let mFinal = 0, mSpc = 0, mMiss = 0, mProfileOnly = 0;
const attemptHist = new Map();
// resweep: FINAL games with a partial pre-spc roster — p[] present, no spc.
let swGames = 0, swTarget = 0, swNoP = 0, swSpc = 0, swOther = 0, swIds = 0;
const swByYear = new Map();
let rTotRoster = 0, rSpc = 0, rDg = 0, rBoth = 0, rFlagless = 0;
let rTried = 0, rNever = 0, rApsTried = 0, rApsNever = 0;
const rSizeTried = new Map(), rSizeNever = new Map();
const rByYear = new Map();
const rSeasons = [];
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const sizeBucket = (x) => x <= 2 ? '1-2' : x <= 4 ? '3-4' : x <= 8 ? '5-8' : x <= 11 ? '9-11' : x <= 14 ? '12-14' : x <= 19 ? '15-19' : '20+';

console.log('── Scanning games/bv once for every section ──────────────────────────');
for (const f of fs.readdirSync(gamesDir)) {
  if (!f.endsWith('.json')) continue;
  const sid = path.basename(f, '.json');
  let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
  if (!sidIdx.has(sid)) { sidIdx.set(sid, sidList.length); sidList.push(sid); }
  const si = sidIdx.get(sid);
  const meta = idx[sid] || {};

  const mRec = { sid: sid, name: meta.name || '?', org: meta.orgName || '?', final: 0, spc: 0, miss: 0, samples: [] };
  const rRec = { sid: sid, name: meta.name || '?', org: meta.orgName || '?', locked: !!meta.locked,
                 games: 0, flagless: 0, tried: 0, neverTried: 0, aps: 0, samplesTried: [], samplesNever: [] };

  for (const gid of Object.keys(sg.games || {})) {
    const g = sg.games[gid];
    if (!g) continue;
    totGames++; rRec.games++;
    const roster = Array.isArray(g.p) ? g.p.length : 0;

    let fl = 0;
    if (g.spc) fl |= F_SPC;
    if (g.dg) fl |= F_DG;
    if (g.profileOnly) fl |= F_PO;
    if (g.forfeit) fl |= F_FORFEIT;
    if (g.bye) fl |= F_BYE;
    if (g.cancelled) fl |= F_CANCELLED;
    if (g.abandoned) fl |= F_ABANDONED;
    if (g.legacy) fl |= F_LEGACY;
    if (g.st !== 'FINAL') fl |= F_NOTFINAL;
    if (roster) fl |= F_ROSTER;
    gameFlags.set(gid, fl);
    gameSid.set(gid, si);
    if (g.gn) gradeSlug.set(gid, slugify(g.gn));
    if (want('grades') && g.gid) {
      let m = seasonGradeUse.get(sid);
      if (!m) { m = new Map(); seasonGradeUse.set(sid, m); }
      m.set(g.gid, (m.get(g.gid) || 0) + 1);
    }
    if (want('consolidation')) {
      gameH.set(gid, internTid(g.h));
      gameA.set(gid, internTid(g.a));
    }

    if (fl & F_PO) allPo++; else if (fl & F_DG) allDg++; else if (fl & F_SPC) allSpc++; else allNone++;

    // ── misses ──
    if (want('misses') && g.st === 'FINAL' && !(fl & (F_FORFEIT | F_BYE | F_CANCELLED | F_ABANDONED | F_LEGACY))) {
      mRec.final++; mFinal++;
      const y = (g.d || '????').slice(0, 4);
      if (!byYearMiss.has(y)) byYearMiss.set(y, { spc: 0, miss: 0 });
      if (fl & F_SPC) { mRec.spc++; mSpc++; byYearMiss.get(y).spc++; }
      else if ((g.spcm || 0) > 0) {
        mRec.miss++; mMiss++; byYearMiss.get(y).miss++;
        bump(attemptHist, g.spcm);
        if (fl & F_PO) mProfileOnly++;
        if (mRec.samples.length < 3) mRec.samples.push(gid);
      }
    }

    // ── resweep ──
    if (want('resweep')) {
      swGames++;
      if (g.st !== 'FINAL' || (fl & (F_FORFEIT | F_LEGACY))) swOther++;
      else if (fl & F_SPC) swSpc++;
      else if (!roster) swNoP++;
      else {
        swTarget++; swIds += roster;
        const y = (g.d || '????').slice(0, 4);
        swByYear.set(y, (swByYear.get(y) || 0) + 1);
      }
    }

    // ── rosters ──
    if (want('rosters') && roster) {
      rTotRoster++;
      if ((fl & F_SPC) && (fl & F_DG)) { rBoth++; continue; }
      if (fl & F_SPC) { rSpc++; continue; }
      if (fl & F_DG) { rDg++; continue; }
      rFlagless++; rRec.flagless++; rRec.aps += roster;
      const y = (g.d || '????').slice(0, 4);
      if (!rByYear.has(y)) rByYear.set(y, { tried: 0, never: 0 });
      if ((g.spcm || 0) > 0) {
        rTried++; rApsTried += roster; rRec.tried++; bump(rSizeTried, sizeBucket(roster));
        rByYear.get(y).tried++;
        if (rRec.samplesTried.length < 3) rRec.samplesTried.push(gid + '|roster ' + roster + ', spcm ' + g.spcm);
      } else {
        rNever++; rApsNever += roster; rRec.neverTried++; bump(rSizeNever, sizeBucket(roster));
        rByYear.get(y).never++;
        if (rRec.samplesNever.length < 3) rRec.samplesNever.push(gid + '|roster ' + roster);
      }
    }
  }
  if (want('misses') && mRec.final > 0 && mRec.miss > 0) missSeasons.push(mRec);
  if (want('rosters') && rRec.flagless > 0) rSeasons.push(rRec);
}
console.log('  ' + n(totGames) + ' games indexed\n');
const baselineDgPct = totGames ? (100 * allDg / totGames) : 0;

// ══ SECTION: misses ═══════════════════════════════════════════════════════
if (want('misses')) {
  console.log('══ SPECTATOR MISSES ══════════════════════════════════════════════════');
  console.log('  FINAL games considered  : ' + n(mFinal));
  console.log('    box captured (spc)    : ' + n(mSpc) + '  (' + pct(mSpc, mFinal) + '%)');
  console.log('    MISSED (spcm, no spc) : ' + n(mMiss) + '  (' + pct(mMiss, mFinal) + '%)');
  console.log('    of those, profileOnly games we synthesised ourselves: ' + n(mProfileOnly));
  console.log('    attempts histogram    : ' + [...attemptHist.entries()].sort().map(e => e[0] + 'x:' + n(e[1])).join('  '));
  console.log('\n  BY YEAR (spc coverage of FINAL games):');
  for (const e of [...byYearMiss.entries()].sort()) {
    const t = e[1].spc + e[1].miss;
    if (!t) continue;
    console.log('    ' + e[0] + '  captured ' + String(e[1].spc).padStart(8) + '  missed ' + String(e[1].miss).padStart(7) + '   coverage ' + pct(e[1].spc, t) + '%');
  }
  const dead = [], mixed = [], covered = [];
  for (const s of missSeasons) {
    const cov = 100 * s.spc / (s.spc + s.miss);
    (cov < 5 ? dead : cov > 95 ? covered : mixed).push(Object.assign(s, { cov: cov }));
  }
  const sum = (a, k) => a.reduce((x, y) => x + y[k], 0);
  console.log('\n  MISS CLUSTERING — the diagnostic:');
  console.log('    DEAD    (<5% ever captured) : ' + n(dead.length) + ' seasons, ' + n(sum(dead, 'miss')) + ' misses  → no electronic scoring that era. Expected.');
  console.log('    MIXED   (5-95%)             : ' + n(mixed.length) + ' seasons, ' + n(sum(mixed, 'miss')) + ' misses  → partial rollout or per-grade differences.');
  console.log('    COVERED (>95%, yet missed)  : ' + n(covered.length) + ' seasons, ' + n(sum(covered, 'miss')) + ' misses  → ⚠ SUSPICIOUS; likely transient failures.');
  const show = (label, arr) => {
    if (!arr.length) return;
    console.log('\n  ' + label);
    for (const s of arr.sort((a, b) => b.miss - a.miss).slice(0, TOP)) {
      console.log('    ' + s.sid + '  missed ' + String(s.miss).padStart(6) + ' of ' + String(s.final).padStart(6) + '  coverage ' + s.cov.toFixed(1).padStart(5) + '%  ' + s.name + ' — ' + s.org);
      for (const g of s.samples) console.log('          ' + gameUrl(s.sid, g));
    }
  };
  show('TOP COVERED-SEASON OFFENDERS (check these first):', covered);
  show('TOP DEAD SEASONS (expected — sanity-check one or two):', dead);
  console.log('');
}

// ══ SECTION: repair-rosters ═══════════════════════════════════════════════
if (want('resweep')) {
  console.log('══ RE-SWEEP TARGET ═══════════════════════════════════════════════════');
  console.log('  games scanned                                  : ' + n(swGames));
  console.log('    FINAL with spc (already box-captured)        : ' + n(swSpc));
  console.log('    FINAL roster-less, no spc                    : ' + n(swNoP));
  console.log('    non-FINAL / forfeit / legacy                 : ' + n(swOther));
  console.log('  TARGET — FINAL, partial pre-spc p[], no spc    : ' + n(swTarget) + ' games');
  console.log('    p[] entries across them                      : ' + n(swIds) + '  (avg ' + (swTarget ? (swIds / swTarget).toFixed(1) : 0) + '/game)');
  console.log('    by year:');
  for (const e of [...swByYear.entries()].sort()) console.log('      ' + e[0] + '  ' + n(e[1]));
  console.log('    cost: one spectator query per game (backfill pacing applies).');
  console.log('');
}

if (want('rosters')) {
  console.log('══ ROSTERS WITH NO CAPTURE FLAG ══════════════════════════════════════');
  console.log('  games holding a roster    : ' + n(rTotRoster));
  console.log('    flagged spc             : ' + n(rSpc));
  console.log('    flagged dg              : ' + n(rDg));
  console.log('    flagged both            : ' + n(rBoth));
  console.log('    NO FLAG                 : ' + n(rFlagless) + '  (' + pct(rFlagless, rTotRoster) + '% of games holding a roster)');
  console.log('\n  Was spectator ever asked about these games?');
  console.log('    spcm SET, asked and refused : ' + n(rTried) + ' games, ' + n(rApsTried) + ' appearances  (' + pct(rTried, rFlagless) + '%)');
  console.log('    spcm UNSET, never asked     : ' + n(rNever) + ' games, ' + n(rApsNever) + ' appearances  (' + pct(rNever, rFlagless) + '%)');
  console.log('');
  console.log('  ⚠ READ THIS BEFORE THE NUMBERS. The first version of this tool labelled the');
  console.log('    spcm-set group "REPAIR-WRITTEN" on the reasoning that a roster present after');
  console.log('    spectator failed must have been written afterwards. THAT WAS WRONG, and the');
  console.log('    arithmetic disproves it: the entire repair campaign made 812,554 appends');
  console.log('    across all games ever, while that group alone holds ' + n(rApsTried) + ' appearances.');
  console.log('    spcm records THAT spectator failed, never WHEN — a roster captured years');
  console.log('    earlier by another path looks identical. Treat both groups as pre-flag');
  console.log('    captures unless something else says otherwise, and do NOT strip either.');
  const showSizes = (label, m) => {
    const order = ['1-2', '3-4', '5-8', '9-11', '12-14', '15-19', '20+'];
    const t = order.reduce((a, k) => a + (m.get(k) || 0), 0);
    console.log('    ' + label + ':');
    for (const k of order) { const v = m.get(k) || 0; if (v) console.log('      roster ' + k.padEnd(6) + n(v).padStart(9) + '  ' + pct(v, t).padStart(5) + '%'); }
  };
  console.log('\n  ROSTER SIZES (a full two-team complement is 15-20):');
  showSizes('spcm set', rSizeTried);
  showSizes('spcm unset', rSizeNever);
  console.log('\n  BY YEAR:');
  for (const e of [...rByYear.entries()].sort()) console.log('    ' + e[0] + '  spcm-set ' + n(e[1].tried).padStart(8) + '   never-asked ' + n(e[1].never).padStart(8));
  console.log('\n  TOP SEASONS BY FLAGLESS GAMES:');
  for (const s of rSeasons.sort((a, b) => b.flagless - a.flagless).slice(0, TOP)) {
    console.log('    ' + s.sid + '  flagless ' + String(s.flagless).padStart(6) + ' of ' + String(s.games).padStart(6) +
                '  (spcm-set ' + s.tried + ' / never-asked ' + s.neverTried + ')  ' + (s.locked ? '[locked] ' : '[active] ') + s.name + ' — ' + s.org);
    for (const g of s.samplesTried.concat(s.samplesNever).slice(0, 2)) {
      const parts = g.split('|');
      console.log('          ' + gameUrl(s.sid, parts[0]) + '   ' + parts[1]);
    }
  }
  console.log('');
}

// ══ SECTION: negative-gap ═════════════════════════════════════════════════
if (want('gaps')) {
  console.log('══ THE APPEARANCE GAP, BOTH DIRECTIONS ═══════════════════════════════');
  console.log('  gap = credited (sports.*.gp, from the profile) minus held (games[], from');
  console.log('  rosters). Positive = appearances we cannot name. Negative = we hold more than');
  console.log('  PlayHQ credits. One scan, both directions, so the two cannot disagree.');
  console.log('');
  const rows = [], privateRows = [];
  // Positive direction (was size-gap-players.yml)
  const POSB = [[1, 1], [2, 5], [6, 20], [21, 50], [51, 100], [101, Infinity]];
  const posCount = new Array(POSB.length).fill(0);
  let scanned = 0, unreadable = 0, noGp = 0, zeroGap = 0, posPlayers = 0, posSum = 0;
  const posTop = [];
  let players = 0, totalExcess = 0, privatePlayers = 0, privateExcess = 0;
  const buckets = [[1, 1], [2, 5], [6, 20], [21, 100], [101, Infinity]];
  const bcount = new Array(buckets.length).fill(0);

  // Control group: players whose held games EXACTLY match their credited
  // total. If they carry uncountable games at the same rate as the affected,
  // the flag explains nothing.
  const ctrl = { players: 0, withUncountable: 0, uncountable: 0, games: 0 };
  const grp = new Map();   // bucket key -> same shape
  const grpKey = (e) => e === 1 ? 'excess 1' : e <= 5 ? 'excess 2-5' : e <= 20 ? 'excess 6-20' : 'excess 21+';
  for (const k of ['excess 1', 'excess 2-5', 'excess 6-20', 'excess 21+']) grp.set(k, { players: 0, withUncountable: 0, uncountable: 0, games: 0 });

  const playersDir = path.join(ROOT, 'players');
  for (const shard of fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d))) {
    const dir = path.join(playersDir, shard);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      scanned++;
      let p; try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { unreadable++; continue; }
      let gp = 0, has = false;
      for (const s of Object.values(p.sports || {})) if (s && typeof s.gp === 'number') { gp += s.gp; has = true; }
      if (!has) { noGp++; continue; }   // never profile-fetched, or private with no stats
      const gl = Array.isArray(p.games) ? p.games : [];
      const excess = gl.length - gp;
      const uuid = f.replace(/\.json$/, '');

      // Positive direction: appearances PlayHQ credits that we cannot name.
      if (excess < 0) {
        const gap = -excess;
        posPlayers++; posSum += gap;
        for (let i = 0; i < POSB.length; i++) if (gap >= POSB[i][0] && gap <= POSB[i][1]) { posCount[i]++; break; }
        if (posTop.length < 20 || gap > posTop[posTop.length - 1].gap) {
          posTop.push({ gap: gap, uuid: uuid, name: p.name || '?', gp: gp, games: gl.length, priv: p.private === true });
          posTop.sort((a, b) => b.gap - a.gap);
          if (posTop.length > 20) posTop.pop();
        }
      } else if (excess === 0) { zeroGap++; }

      let unc = 0, dg = 0, spc = 0, po = 0, unknown = 0;
      const dgSamples = [];
      for (const gid of gl) {
        const fl = gameFlags.get(gid);
        if (fl === undefined) { unknown++; continue; }
        if (fl & UNCOUNTABLE) unc++;
        if (fl & F_PO) po++; else if (fl & F_DG) { dg++; if (dgSamples.length < 3) dgSamples.push(gid); }
        else if (fl & F_SPC) spc++; else unknown++;
      }

      if (excess <= 0) {
        ctrl.players++; ctrl.games += gl.length; ctrl.uncountable += unc;
        if (unc > 0) ctrl.withUncountable++;
        continue;
      }
      const g = grp.get(grpKey(excess));
      g.players++; g.games += gl.length; g.uncountable += unc;
      if (unc > 0) g.withUncountable++;

      const row = { uuid: uuid, name: p.name || '?', gp: gp, games: gl.length,
                    excess: excess, dg: dg, spc: spc, po: po, unc: unc, unknown: unknown, dgSamples: dgSamples };
      if (p.private === true) { privatePlayers++; privateExcess += excess; privateRows.push(row); continue; }
      players++; totalExcess += excess;
      for (let i = 0; i < buckets.length; i++) if (excess >= buckets[i][0] && excess <= buckets[i][1]) { bcount[i]++; break; }
      rows.push(row);
    }
  }

  console.log('  ── POSITIVE GAP: appearances credited but not held ──');
  console.log('    players scanned                : ' + n(scanned));
  console.log('      unreadable                   : ' + n(unreadable));
  console.log('      no profile gp (unmeasurable) : ' + n(noGp));
  console.log('      gap = 0 (fully captured)     : ' + n(zeroGap));
  console.log('    PLAYERS WITH A POSITIVE GAP    : ' + n(posPlayers) + '  (' + pct(posPlayers, scanned) + '% of scanned)');
  console.log('    total missing appearances      : ' + n(posSum));
  for (let i = 0; i < POSB.length; i++) {
    const a = POSB[i][0], b = POSB[i][1];
    console.log('      gap ' + (b === Infinity ? a + '+' : a === b ? String(a) : a + '-' + b).padEnd(8) + n(posCount[i]).padStart(10) + ' players');
  }
  console.log('    worst 20:');
  for (const t of posTop) console.log('      ' + String(t.gap).padStart(5) + '  ' + t.uuid + '  gp=' + t.gp + ' games=' + t.games + (t.priv ? ' [PRIVATE]' : '') + '  ' + JSON.stringify(t.name));
  console.log('');
  console.log('  ── NEGATIVE GAP: held but not credited ──');
  console.log('  PRIVATE PROFILES (expected, excluded below): ' + n(privatePlayers) + ' players, ' + n(privateExcess) + ' excess appearances');
  console.log('  NOT PRIVATE — the anomaly                 : ' + n(players) + ' players, ' + n(totalExcess) + ' excess appearances');
  for (let i = 0; i < buckets.length; i++) {
    const a = buckets[i][0], b = buckets[i][1];
    console.log('    excess ' + (b === Infinity ? a + '+' : a === b ? String(a) : a + '-' + b).padEnd(8) + n(bcount[i]).padStart(9) + ' players');
  }

  const sum = (k) => rows.reduce((acc, r) => acc + r[k], 0);
  const tot = sum('dg') + sum('spc') + sum('po') + sum('unknown');
  const affectedDgPct = tot ? (100 * sum('dg') / tot) : 0;
  console.log('\n  PROVENANCE OF THEIR GAMES vs the baseline across all games:');
  // Both rows in the same units. The first version printed percentages for
  // dg/spc and RAW COUNTS for profileOnly/no-flag on the affected line, against
  // percentages on the baseline line — two rows that looked comparable and were
  // not.
  console.log('    affected: dg ' + pct(sum('dg'), tot) + '%  ·  spc ' + pct(sum('spc'), tot) + '%  ·  profileOnly ' + pct(sum('po'), tot) + '%  ·  no flag ' + pct(sum('unknown'), tot) + '%   (' + n(tot) + ' games)');
  console.log('    baseline: dg ' + baselineDgPct.toFixed(1) + '%  ·  spc ' + pct(allSpc, totGames) + '%  ·  profileOnly ' + pct(allPo, totGames) + '%  ·  no flag ' + pct(allNone, totGames) + '%');
  if (baselineDgPct === 0) console.log('    → no dg-captured games in this dataset at all: the comparison says nothing.');
  else if (affectedDgPct >= baselineDgPct * 1.5) console.log('    → dg OVER-represented: consistent with the FILL-IN theory.');
  else if (affectedDgPct <= baselineDgPct * 0.67) console.log('    → dg UNDER-represented: argues AGAINST the fill-in theory.');
  else console.log('    → dg in line with baseline: NO signal either way. The fill-in theory is not supported.');

  // ── THE EXCESS-OF-1 TEST ────────────────────────────────────────────────
  console.log('\n  DO THEY HOLD GAMES PLAYHQ WOULD NOT COUNT?');
  console.log('  "Uncountable" = forfeit, bye, cancelled, abandoned, legacy, not-FINAL, or one');
  console.log('  of our own profileOnly synthetic games.');
  // NORMALISED BY GAMES HELD, because the raw rate is confounded. A player
  // with 200 games holds more forfeits than one with 20 AND is likelier to be
  // off by one, so "% holding at least one" rises with squad size whether or
  // not the flag has anything to do with the excess. Per 100 games held is the
  // comparison that controls for it.
  const line = (label, o) => {
    if (!o.players) return;
    const per100 = o.games ? (100 * o.uncountable / o.games) : 0;
    console.log('    ' + label.padEnd(13) + n(o.players).padStart(9) + ' players  ·  ' +
                (o.games / o.players).toFixed(1).padStart(7) + ' games held each  ·  ' +
                (o.uncountable / o.players).toFixed(2).padStart(6) + ' uncountable each  ·  ' +
                per100.toFixed(2).padStart(6) + ' per 100 games  ·  ' +
                pct(o.withUncountable, o.players).padStart(5) + '% hold at least one');
  };
  line('CONTROL', ctrl);
  for (const k of ['excess 1', 'excess 2-5', 'excess 6-20', 'excess 21+']) line(k, grp.get(k));
  // NO AUTOMATIC VERDICT. Twice this tool stated a conclusion more confidently
  // than the data supported — once calling a zero baseline "over-represented",
  // once calling a confounded 59.3%-vs-44.7% "partial". The numbers below are
  // the ones that decide it; the reading is left to whoever is looking.
  const e1 = grp.get('excess 1');
  const ctrlPer100 = ctrl.games ? (100 * ctrl.uncountable / ctrl.games) : 0;
  const e1Per100 = e1.games ? (100 * e1.uncountable / e1.games) : 0;
  const e1Each = e1.players ? (e1.uncountable / e1.players) : 0;
  console.log('');
  console.log('    HOW TO READ IT — two questions, both answered above:');
  console.log('');
  console.log('    1. Is the RATE actually different once squad size is controlled for?');
  console.log('       control ' + ctrlPer100.toFixed(2) + ' uncountable per 100 games held · excess-1 ' + e1Per100.toFixed(2) + ' per 100.');
  console.log('       If those are close, any difference in the raw "% hold at least one" column');
  console.log('       is games-held confounding and nothing more.');
  console.log('');
  console.log('    2. Does the QUANTITY match the excess it is supposed to explain?');
  console.log('       excess-1 players are over by 1 and hold ' + e1Each.toFixed(2) + ' uncountable games each.');
  console.log('       If the flag caused the excess, those two numbers would agree. The control');
  console.log('       group holds ' + (ctrl.players ? (ctrl.uncountable / ctrl.players).toFixed(2) : '0') + ' each and is over by NOTHING, which is the same point');
  console.log('       from the other side: PlayHQ evidently counts these games.');

  console.log('\n  TOP ' + TOP + ' BY EXCESS (non-private):');
  for (const r of rows.sort((a, b) => b.excess - a.excess).slice(0, TOP)) {
    console.log('    ' + String(r.excess).padStart(5) + '  ' + r.uuid + '  gp=' + r.gp + ' games=' + r.games +
                '  [dg=' + r.dg + ' spc=' + r.spc + ' po=' + r.po + ' uncountable=' + r.unc + ']  ' + JSON.stringify(r.name));
    for (const g of r.dgSamples) {
      const si = gameSid.get(g);
      console.log('             ' + (si === undefined ? '(game ' + g + ' not in games/bv)' : gameUrl(sidList[si], g)));
    }
  }
  console.log('');
}

// ══ SECTION: consolidation ═══════════════════════════════════════════════
if (want('consolidation')) {
  console.log('══ DOES EACH APPEARANCE BELONG TO THE PLAYER IT IS ON? ═══════════════');
  const playersDir2 = path.join(ROOT, 'players');
  let audited = 0, skippedNoRegs = 0, skippedNoGames = 0, privateAudited = 0;
  let apsChecked = 0, apsOk = 0, apsForeign = 0, apsUnknownGame = 0;
  let apsInSeason = 0, apsNoSeason = 0, playersInSeasonForeign = 0;
  // ── DID THE REPAIR CAMPAIGN WRITE WRONG APPEARANCES? ───────────────────
  // The question that matters more than any other here. The campaign appended
  // ~812,554 roster entries between 2026-08-14 and 08-18, and it recorded every
  // player it touched in reports/repair-batch-progress.json. It only ever
  // appended when PlayHQ's own profile listed that game for that player — never
  // by name, never inferred — so a wrong append means either PlayHQ credited a
  // game the player did not play, or a game id resolved to the wrong game.
  //
  // Comparing TOUCHED players against UNTOUCHED ones is the test. If the
  // campaign introduced errors, its players carry a materially higher rate. If
  // the rates match, the wrong appearances predate it and it is not the source.
  // This cannot be settled by reasoning about the code — it appended what a
  // profile told it to, and whether that was right is a fact about the data.
  let repairTouched = null;
  try {
    const prog = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'repair-batch-progress.json'), 'utf8'));
    repairTouched = new Set(Object.keys(prog.done || {}));
    console.log('  repair-campaign progress file: ' + n(repairTouched.size) + ' players processed by it');
  } catch (e) {
    console.log('  repair-campaign progress file: NOT FOUND (' + String(e.message).slice(0, 60) + ') — the touched/untouched split below will be empty');
  }
  const camp = new Map();
  for (const k of ['touched by repair', 'never touched']) camp.set(k, { players: 0, aps: 0, foreign: 0, inSeason: 0 });

  // gid -> the players who wrongly hold it, for the third pass below. Capped
  // per game so a pathological roster cannot blow the heap.
  const wrongPairs = new Map();
  const provForeign = new Map();   // capture path -> wrong appearances written through it
  const provAll = new Map();       // the same paths across ALL checked appearances, as the baseline
  const vPriv = { players: 0, aps: 0, foreign: 0, inSeason: 0, noSeason: 0 };
  const vPub  = { players: 0, aps: 0, foreign: 0, inSeason: 0, noSeason: 0 };
  let playersAllOk = 0, playersAnyForeign = 0;
  const foreignBuckets = new Map();   // count of foreign appearances -> players
  const worst = [];
  // Cross-tab against the gap direction: if foreign appearances cause the
  // over-count, they should concentrate in players who HOLD MORE than credited.
  const xtab = new Map();
  for (const k of ['over-counted', 'exact', 'under-counted', 'no gp']) xtab.set(k, { players: 0, aps: 0, foreign: 0, inSeason: 0 });
  let regTeamsChecked = 0, regTeamsUnseen = 0;

  for (const shard of fs.readdirSync(playersDir2).filter(d => /^[0-9a-f]{2}$/.test(d))) {
    const dir = path.join(playersDir2, shard);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let p; try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
      const gl = Array.isArray(p.games) ? p.games : [];
      if (!gl.length) { skippedNoGames++; continue; }

      // Registrations from BOTH places they are recorded, and the SEASONS
      // those registrations cover — the season set is what makes the foreign
      // count readable (see the three-way split below).
      const regTids = new Set();
      const regSids = new Set();
      for (const t of (Array.isArray(p.teams) ? p.teams : [])) {
        if (t && t.tid) regTids.add(t.tid);
        if (t && t.sid) regSids.add(t.sid);
      }
      for (const se of (Array.isArray(p.seasons) ? p.seasons : [])) {
        if (se && se.sid) regSids.add(se.sid);
        for (const r of (Array.isArray(se.regs) ? se.regs : [])) if (r && r.tid) regTids.add(r.tid);
      }
      if (!regTids.size) { skippedNoRegs++; continue; }
      audited++;
      if (p.private === true) privateAudited++;

      let ok = 0, foreign = 0, unknown = 0;
      // THE THREE-WAY SPLIT. A raw foreign count conflates two things that mean
      // opposite amounts:
      //   inSeason  — we HAVE this player's registrations for that season and
      //               they match neither side. Either a genuine mis-attribution
      //               or a FILL-IN, which PlayHQ labels in the box score and
      //               which is a real appearance for a team you never joined.
      //   noSeason  — we hold NO registration for that season at all, so the
      //               list is incomplete there and the appearance says nothing.
      // The `no gp` row of the first cross-tab is 52.1% foreign purely because
      // nobody ever fetched its registrations. That is the false-positive rate
      // this split exists to strip out.
      let fInSeason = 0, fNoSeason = 0;
      // 2026-08-18: confirmed by eye that at least some of these are REAL
      // mis-attribution — Max Thomson is absent from both team lists of a
      // Ballarat game his record claims, with no "Fill-in" or "Private player"
      // row to account for him. So the next question is which capture path put
      // him there. Provenance is already on every game; tallying it costs
      // nothing and names the suspect instead of leaving it open.
      const seenTeams = new Set();
      const foreignSamples = [];
      for (const gid of gl) {
        const hi = gameH.get(gid), ai = gameA.get(gid);
        if (hi === undefined) { unknown++; continue; }
        const h = hi >= 0 ? tidList[hi] : null;
        const a = ai >= 0 ? tidList[ai] : null;
        const mine = (h && regTids.has(h)) ? h : (a && regTids.has(a)) ? a : null;
        {
          const gfl0 = gameFlags.get(gid) || 0;
          bump(provAll, (gfl0 & F_SPC) && (gfl0 & F_DG) ? 'both' : (gfl0 & F_SPC) ? 'spc (live-scoring)'
                     : (gfl0 & F_DG) ? 'dg (canonical record)' : 'NEITHER flag');
        }
        if (mine) { ok++; seenTeams.add(mine); }
        else {
          foreign++;
          const gsi = gameSid.get(gid);
          const gsid = gsi === undefined ? null : sidList[gsi];
          if (gsid && regSids.has(gsid)) {
            fInSeason++;
            if (foreignSamples.length < 3) foreignSamples.push(gid);
            let ow = wrongPairs.get(gid);
            if (!ow) { ow = []; wrongPairs.set(gid, ow); }
            if (ow.length < 40) ow.push(f.replace(/\.json$/, ''));
            const gfl = gameFlags.get(gid) || 0;
            const key = (gfl & F_SPC) && (gfl & F_DG) ? 'both' : (gfl & F_SPC) ? 'spc (live-scoring)'
                      : (gfl & F_DG) ? 'dg (canonical record)' : 'NEITHER flag';
            bump(provForeign, key);
            if (gfl & F_PO) bump(provForeign, '  ...of which profileOnly (our own synthesis)');
          } else fNoSeason++;
        }
      }
      apsChecked += ok + foreign; apsOk += ok; apsForeign += foreign; apsUnknownGame += unknown;
      apsInSeason += fInSeason; apsNoSeason += fNoSeason;
      if (repairTouched) {
        const c = camp.get(repairTouched.has(f.replace(/\.json$/, '')) ? 'touched by repair' : 'never touched');
        c.players++; c.aps += ok + foreign; c.foreign += foreign; c.inSeason += fInSeason;
      }
      const vis = p.private === true ? vPriv : vPub;
      vis.players++; vis.aps += ok + foreign; vis.foreign += foreign; vis.inSeason += fInSeason; vis.noSeason += fNoSeason;
      if (fInSeason) playersInSeasonForeign++;
      if (foreign) {
        playersAnyForeign++;
        bump(foreignBuckets, foreign <= 1 ? '1' : foreign <= 5 ? '2-5' : foreign <= 20 ? '6-20' : foreign <= 100 ? '21-100' : '101+');
        // Ranked by the MEASURABLE kind, not the raw count: the players worth
        // eyeballing are the ones whose registrations we actually hold.
        if (worst.length < 25 || fInSeason > worst[worst.length - 1].inSeason) {
          worst.push({ uuid: f.replace(/\.json$/, ''), name: p.name || '?', foreign: foreign, ok: ok,
                       inSeason: fInSeason, noSeason: fNoSeason,
                       games: gl.length, priv: p.private === true, samples: foreignSamples });
          worst.sort((x, y) => y.inSeason - x.inSeason);
          if (worst.length > 25) worst.pop();
        }
      } else playersAllOk++;

      // Registered teams we hold games for, in which the player never appears.
      for (const t of regTids) { regTeamsChecked++; if (!seenTeams.has(t)) regTeamsUnseen++; }

      let gp = 0, has = false;
      for (const sp of Object.values(p.sports || {})) if (sp && typeof sp.gp === 'number') { gp += sp.gp; has = true; }
      const key = !has ? 'no gp' : gl.length > gp ? 'over-counted' : gl.length < gp ? 'under-counted' : 'exact';
      const x = xtab.get(key);
      x.players++; x.aps += ok + foreign; x.foreign += foreign; x.inSeason += fInSeason;
    }
  }

  console.log('  players audited                 : ' + n(audited) + (privateAudited ? '  (' + n(privateAudited) + ' of them private)' : ''));
  console.log('    skipped, no games[]           : ' + n(skippedNoGames));
  console.log('    skipped, NO registrations     : ' + n(skippedNoRegs) + '   ← cannot be audited; never profile-fetched, or fetched with none');
  console.log('  appearances checked             : ' + n(apsChecked));
  console.log('    player registered to one side : ' + n(apsOk) + '  (' + pct(apsOk, apsChecked) + '%)');
  console.log('    registered to NEITHER side    : ' + n(apsForeign) + '  (' + pct(apsForeign, apsChecked) + '%)');
  console.log('      ├ we HOLD their regs for that season : ' + n(apsInSeason) + '  (' + pct(apsInSeason, apsChecked) + '% of all appearances)  ← MEASURABLE');
  console.log('      └ no registration for that season    : ' + n(apsNoSeason) + '  (' + pct(apsNoSeason, apsChecked) + '%)  ← list incomplete there; says nothing');
  console.log('');
  console.log('    ⚠ EVEN THE MEASURABLE FIGURE IS NOT ALL ERROR. PlayHQ box scores carry a');
  console.log('      "Fill-in" row: a player turning out for a team they never registered with.');
  console.log('      That is a REAL appearance which this test must call foreign, because the');
  console.log('      registration genuinely does not exist. Confirmed by eye on 2026-08-18 —');
  console.log('      Sean Wright (191 of 197 foreign, not private) is absent from both team lists');
  console.log('      on his sampled games, and those box scores show "Fill-in" and "Private');
  console.log('      player" rows. So treat the measurable figure as an UPPER BOUND on');
  console.log('      mis-attribution, not as a count of it.');
  console.log('');
  console.log('    game not in games/bv          : ' + n(apsUnknownGame) + '   ← cannot be checked either way');
  console.log('  players with zero foreign       : ' + n(playersAllOk) + '  (' + pct(playersAllOk, audited) + '%)');
  console.log('  players with at least one       : ' + n(playersAnyForeign) + '  (' + pct(playersAnyForeign, audited) + '%)');
  for (const k of ['1', '2-5', '6-20', '21-100', '101+']) {
    const v = foreignBuckets.get(k) || 0;
    if (v) console.log('      ' + k.padEnd(8) + n(v).padStart(9) + ' players');
  }
  console.log('  BY PROFILE VISIBILITY (private profiles drove the first run\'s tail):');
  const vis = (label, v) => {
    if (!v.players) return;
    console.log('    ' + label.padEnd(9) + n(v.players).padStart(9) + ' players  ·  ' +
                pct(v.foreign, v.aps).padStart(6) + '% foreign  ·  ' +
                pct(v.inSeason, v.aps).padStart(6) + '% measurable-foreign  ·  ' +
                pct(v.noSeason, v.aps).padStart(6) + '% unmeasurable');
  };
  vis('public', vPub);
  vis('private', vPriv);
  console.log('    players with at least one MEASURABLE foreign appearance: ' + n(playersInSeasonForeign) + '  (' + pct(playersInSeasonForeign, audited) + '% of audited)');
  if (repairTouched) {
    console.log('  DID THE REPAIR CAMPAIGN WRITE WRONG APPEARANCES?');
    const t = camp.get('touched by repair'), u = camp.get('never touched');
    for (const [label, c] of [['touched by repair', t], ['never touched', u]]) {
      if (!c.players) continue;
      console.log('    ' + label.padEnd(19) + n(c.players).padStart(9) + ' players  ·  ' +
                  (c.aps / c.players).toFixed(1).padStart(7) + ' appearances each  ·  ' +
                  pct(c.inSeason, c.aps).padStart(6) + '% wrong  ·  ' +
                  (c.inSeason / c.players).toFixed(2).padStart(7) + ' wrong each');
    }
    const tp = t.aps ? (100 * t.inSeason / t.aps) : 0;
    const up = u.aps ? (100 * u.inSeason / u.aps) : 0;
    console.log('');
    console.log('    Touched ' + tp.toFixed(2) + '% against untouched ' + up.toFixed(2) + '%' +
                (up > 0 ? '  (ratio ' + (tp / up).toFixed(2) + ')' : ''));
    console.log('    Close rates mean the wrong appearances PREDATE the campaign and it is not the');
    console.log('    source. A materially higher touched rate means it wrote them, and the appends');
    console.log('    are recoverable — every one is logged per player in the progress file.');
    console.log('    NOTE: the campaign targeted players who ALREADY had a gap, so its players are');
    console.log('    not a random sample. Read the ratio as a signal, not a proof, and confirm');
    console.log('    against the capture-path table below.');
    console.log('');
  }
  console.log('  WHICH CAPTURE PATH WROTE THE WRONG APPEARANCES?');
  console.log('  Share of measurable-foreign appearances by path, against that path\'s share of');
  console.log('  ALL checked appearances. A path over-represented here is where the fault lives.');
  {
    const totF = [...provForeign.entries()].filter(e => !e[0].startsWith(' ')).reduce((a, e) => a + e[1], 0);
    const totA = [...provAll.values()].reduce((a, v) => a + v, 0);
    const keys = ['spc (live-scoring)', 'dg (canonical record)', 'both', 'NEITHER flag'];
    for (const k of keys) {
      const f = provForeign.get(k) || 0, al = provAll.get(k) || 0;
      if (!f && !al) continue;
      const fp = totF ? (100 * f / totF) : 0, ap = totA ? (100 * al / totA) : 0;
      console.log('    ' + k.padEnd(24) + n(f).padStart(11) + ' wrong  ' + fp.toFixed(1).padStart(6) + '% of wrong  ·  ' +
                  ap.toFixed(1).padStart(6) + '% of all  ·  ratio ' + (ap > 0 ? (fp / ap).toFixed(2) : 'n/a'));
    }
    const po = provForeign.get('  ...of which profileOnly (our own synthesis)') || 0;
    if (po) console.log('    of the above, profileOnly games we synthesised ourselves: ' + n(po));
    console.log('    A ratio near 1.00 means that path is no more likely than any other to carry a');
    console.log('    wrong appearance. Well above 1.00 names the culprit.');
  }
  console.log('');
  console.log('  registrations whose team never appears in their games[]: ' + n(regTeamsUnseen) + ' of ' + n(regTeamsChecked) +
              '  (' + pct(regTeamsUnseen, regTeamsChecked) + '%)   ← the UNDER-count direction');

  console.log('');
  console.log('  CROSS-TAB — if foreign appearances cause the over-count, they concentrate here:');
  for (const k of ['over-counted', 'exact', 'under-counted', 'no gp']) {
    const x = xtab.get(k);
    if (!x.players) continue;
    console.log('    ' + k.padEnd(14) + n(x.players).padStart(9) + ' players  ·  ' +
                pct(x.foreign, x.aps).padStart(6) + '% foreign  ·  ' +
                pct(x.inSeason, x.aps).padStart(6) + '% MEASURABLE-foreign  ·  ' +
                (x.inSeason / x.players).toFixed(2).padStart(7) + ' measurable each');
  }
  console.log('    Read the MEASURABLE column, not the raw one — the raw column is dominated by');
  console.log('    players whose registrations were never fetched (the "no gp" row was 52.1%');
  console.log('    foreign on 2026-08-18 for exactly that reason). And compare the last column');
  console.log('    against how far over-counted players actually are: if they carry several times');
  console.log('    more measurable-foreign appearances than their excess, foreign attribution');
  console.log('    cannot be what is causing the excess.');

  console.log('');
  console.log('  WORST 25 BY MEASURABLE-FOREIGN APPEARANCES (registrations held for that season):');
  for (const w of worst) {
    console.log('    ' + String(w.inSeason).padStart(6) + ' measurable (' + String(w.foreign).padStart(6) + ' foreign of ' + String(w.games).padStart(6) + ')  ' + w.uuid +
                (w.priv ? ' [PRIVATE]' : '') + '  ' + JSON.stringify(w.name));
    for (const g of w.samples) {
      const si2 = gameSid.get(g);
      console.log('             ' + (si2 === undefined ? '(game ' + g + ' not in games/bv)' : gameUrl(sidList[si2], g)));
    }
  }
  console.log('');
  // ── WHICH ID DELIVERED THE WRONG APPEARANCE? ──────────────────────────
  // The last question left. Truncation collisions are ruled out (0 across
  // 421,290 files), so an appearance landing on the wrong player arrived one of
  // two ways:
  //   OWN ID    — the roster literally contains that player's own 13-char
  //               prefix. Nothing resolved it wrongly; the capture wrote them
  //               into a game they were not in.
  //   ALIAS     — the roster contains a spectator id which players/aliases maps
  //               to this player. If that mapping is wrong, every appearance
  //               under that id lands on the wrong person — which is exactly
  //               the observed shape: a scatter across unrelated seasons and
  //               grades, arriving through spc because spectator ids are what
  //               the spectator path writes.
  // Those two have completely different fixes, so the split is the finding.
  //
  // Done as a THIRD pass, over only the games already known to be wrong, so the
  // cost is bounded by the fault rather than by the dataset.
  {
    console.log('  WHICH ID DELIVERED THE WRONG APPEARANCE?');
    const aliasMap = new Map();   // 13-char id -> full uuid it resolves to
    let aliasEntries = 0, aliasCross = 0;
    const aliasDir = path.join(ROOT, 'players', 'aliases');
    try {
      for (const f of fs.readdirSync(aliasDir)) {
        if (!f.endsWith('.json')) continue;
        const sh = JSON.parse(fs.readFileSync(path.join(aliasDir, f), 'utf8'));
        for (const k of Object.keys(sh)) {
          aliasEntries++;
          const v = sh[k];
          if (typeof v !== 'string') continue;
          aliasMap.set(k, v);
          if (v.slice(0, 13) !== k) aliasCross++;
        }
      }
    } catch (e) {
      console.log('    players/aliases unreadable (' + String(e.message).slice(0, 60) + ') — cannot split');
    }
    console.log('    alias entries loaded            : ' + n(aliasEntries) + '  (' + n(aliasCross) + ' map a spectator id to a DIFFERENT player)');

    if (aliasMap.size && wrongPairs.size) {
      // Second read of games/bv, restricted to games already known to be wrong.
      let byOwn = 0, byAlias = 0, byNothing = 0;
      const perAlias = new Map();   // alias id -> wrong appearances it delivered
      for (const f of fs.readdirSync(gamesDir)) {
        if (!f.endsWith('.json')) continue;
        let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
        for (const gid of Object.keys(sg.games || {})) {
          const owners = wrongPairs.get(gid);
          if (!owners) continue;
          const g = sg.games[gid];
          const ids = (Array.isArray(g.p) ? g.p : []).map(x => x && x.id).filter(Boolean);
          for (const uuid of owners) {
            const own = uuid.slice(0, 13);
            if (ids.includes(own)) { byOwn++; continue; }
            let found = null;
            for (const id of ids) { const t = aliasMap.get(id); if (t === uuid) { found = id; break; } }
            if (found) { byAlias++; bump(perAlias, found); }
            else byNothing++;
          }
        }
      }
      const tot2 = byOwn + byAlias + byNothing;
      console.log('    wrong appearances re-checked   : ' + n(tot2));
      console.log('      roster held their OWN id     : ' + n(byOwn) + '  (' + pct(byOwn, tot2) + '%)  ← capture wrote them into a game they were not in');
      console.log('      roster held an ALIAS id      : ' + n(byAlias) + '  (' + pct(byAlias, tot2) + '%)  ← players/aliases points that id at this player');
      console.log('      neither, cannot explain      : ' + n(byNothing) + '  (' + pct(byNothing, tot2) + '%)  ← the appearance has no source in the roster at all');
      if (perAlias.size) {
        const top = [...perAlias.entries()].sort((a, b) => b[1] - a[1]);
        console.log('    distinct alias ids responsible : ' + n(perAlias.size));
        console.log('    worst 15 (a few ids carrying many wrong appearances = a few bad mappings):');
        for (const [id, c] of top.slice(0, 15)) console.log('      ' + id + '  ->  ' + (aliasMap.get(id) || '?') + '   ' + n(c) + ' wrong appearances');
      }
    } else if (!wrongPairs.size) {
      console.log('    no wrong appearances recorded to re-check');
    }
    console.log('');
  }

  console.log('  Spot-check: open a URL above and look at both team lists. Three outcomes, and');
  console.log('  they mean different things:');
  console.log('    named in a team list        → their registration list is incomplete; false positive.');
  console.log('    shown as "Fill-in"          → a real appearance for a team they never joined; expected.');
  console.log('    not present at all          → genuine mis-attribution. THIS is the one that matters.');
  console.log('');
}

// ══ SECTION: collisions ═════════════════════════════════════════════════
// DO TWO PLAYERS SHARE A TRUNCATED ID?
//
// Roster entries store the player id truncated to TRUNC_LEN = 13 characters.
// Every appearance is resolved back to a full uuid through that prefix. If two
// people share one, EVERY appearance of both collapses onto whichever record
// the resolver picks — and the loser gets none.
//
// That is the exact shape the consolidation section found on 2026-08-18: one
// player holding games across four or five unrelated seasons and several age
// groups within one association, concentrated in particular associations, and
// 1,115,014 of 1,115,172 wrong appearances arriving through the spectator path
// (the oldest and largest capture route) rather than through the repair
// campaign, which contributed 127.
//
// The 10-character form was abandoned for exactly this reason — the note in
// build-player-games.js puts it at roughly 63% collision probability across
// ~370k players — and 13 was chosen as the replacement. Whether 13 is ENOUGH at
// 421,268 players appears never to have been measured. This measures it.
//
// Zero API calls, one pass over players/, no games scan needed.
if (want('collisions')) {
  console.log('══ DO TWO PLAYERS SHARE A TRUNCATED ID? ══════════════════════════════');
  const TRUNC = 13;
  const byPrefix = new Map();   // 13-char prefix -> [full uuids]
  let total = 0;
  const playersDir3 = path.join(ROOT, 'players');
  for (const shard of fs.readdirSync(playersDir3).filter(d => /^[0-9a-f]{2}$/.test(d))) {
    for (const f of fs.readdirSync(path.join(playersDir3, shard))) {
      if (!f.endsWith('.json')) continue;
      const uuid = f.replace(/\.json$/, '');
      total++;
      const pre = uuid.slice(0, TRUNC);
      const arr = byPrefix.get(pre);
      if (arr) arr.push(uuid); else byPrefix.set(pre, [uuid]);
    }
  }
  const clashes = [];
  let clashedPlayers = 0;
  for (const [pre, arr] of byPrefix) if (arr.length > 1) { clashes.push([pre, arr]); clashedPlayers += arr.length; }

  // The birthday expectation for this many ids over this key space, so the
  // observed figure has something to be judged against rather than just being
  // a number. 13 chars of a uuid is 12 hex digits (the 9th char is a hyphen).
  const space = Math.pow(16, 12);
  const expected = (total * (total - 1)) / (2 * space);
  console.log('  player files                    : ' + n(total));
  console.log('  distinct 13-char prefixes       : ' + n(byPrefix.size));
  console.log('  prefixes shared by 2+ players   : ' + n(clashes.length));
  console.log('  players caught in a collision   : ' + n(clashedPlayers) + '  (' + pct(clashedPlayers, total) + '%)');
  console.log('  expected by chance at this size : ' + expected.toFixed(2) + ' colliding pairs');
  console.log('');
  if (!clashes.length) {
    console.log('  → NO COLLISIONS. Truncation at 13 is not the cause of mis-attributed');
    console.log('    appearances, and the spectator capture path has to be wrong some other way.');
  } else {
    console.log('  → COLLISIONS EXIST. Every appearance of both players in a colliding pair');
    console.log('    resolves to ONE record: one player receives games they never played, the');
    console.log('    other is missing their own. That is the over-count and the under-count from');
    console.log('    a single cause, and it is unfixable by any repair that appends more rows.');
    console.log('');
    console.log('  COLLIDING PREFIXES (up to ' + TOP + '):');
    for (const [pre, arr] of clashes.slice(0, TOP)) {
      console.log('    ' + pre + '  ->  ' + arr.join('  '));
    }
    if (clashes.length > TOP) console.log('    ... and ' + n(clashes.length - TOP) + ' more');
  }
  console.log('');
  console.log('  Note: this counts collisions between player FILES. Ids seen only in rosters —');
  console.log('  spectator-namespace ids that never became a file — are not counted here and');
  console.log('  could collide too, so this is a FLOOR on the problem, not a ceiling.');
  console.log('');
}

// ══ SECTION: grades ═════════════════════════════════════════════════════
// CAN A SEASON'S TEAMS BE ENUMERATED AT ALL? Entirely offline, zero API calls.
//
// ⚠️ THIS SECTION REPLACED A BADLY FRAMED ONE ON 2026-08-19, AND THE MISTAKE IS
// WORTH KEEPING. The first version counted seasons whose stored grade list is
// missing grade ids that our own held games reference, and reported 36% of
// seasons "provably stale" with 562,956 games affected. Both numbers were
// correct and the conclusion was worthless: those games ARE ON DISK. They
// arrived because discover-fixtures resolves teams from a ladder and then calls
// discoverTeamFixture PER TEAM, which returns that team's ENTIRE fixture
// regardless of grade. One team found in one indexed grade brings back every
// game it played, including games in grades the index never knew about. A short
// grade list is a bookkeeping inaccuracy, not data loss — and the very output
// that showed the staleness also showed the games present.
//
// WHAT ACTUALLY COSTS DATA is narrower: a season where the indexed grades yield
// NO TEAMS, because then nothing is enumerated and no fixture is ever fetched.
// That is the EDJBA Winter 2026 case (1ae60211): all 55 indexed grades are
// "* Grading" grades, a grading grade returns `ladder: []` because it is not a
// competition, so the sweep found zero teams and logged "no ladder data" every
// week. The 263 real competition grades have never been in the index.
//
// OFFLINE PROXY, and its limits are stated rather than assumed: if NONE of a
// season's indexed grades appears among the grades its held games actually use,
// then nothing we hold came through the indexed path. That is the signature of a
// season whose enumeration route is dead. It cannot see a season where the route
// is dead AND we hold nothing at all — for those the "* Grading" count is the
// only offline signal, and EDJBA is exactly that case.
if (want('grades')) {
  console.log('══ CAN A SEASON\'S TEAMS BE ENUMERATED? ═══════════════════════════════');
  let seasonsWithIdx = 0, noGrades = 0, allGrading = 0, someGrading = 0;
  let deadRoute = 0, deadRouteGames = 0, partial = 0, fine = 0, noGamesHeld = 0;
  const dead = [], grading = [];
  for (const [sid, meta] of Object.entries(idx)) {
    seasonsWithIdx++;
    const gs = Array.isArray(meta && meta.grades) ? meta.grades : [];
    const names = gs.map(g => String((g && g.name) || ''));
    const gradingN = names.filter(n => /grading/i.test(n)).length;
    const isAllGrading = gs.length > 0 && gradingN === gs.length;
    if (isAllGrading) { allGrading++; grading.push({ sid: sid, meta: meta, gs: gs.length }); }
    else if (gradingN) someGrading++;
    if (!gs.length) { noGrades++; continue; }

    const used = seasonGradeUse.get(sid);
    if (!used || !used.size) { noGamesHeld++; continue; }
    const known = new Set(gs.map(g => String((g && g.id) || '')).filter(Boolean));
    let matched = 0, gamesUnderMatched = 0, totalGames = 0;
    for (const [gradeId, nGames] of used) {
      totalGames += nGames;
      if (known.has(gradeId)) { matched++; gamesUnderMatched += nGames; }
    }
    if (matched === 0) {
      deadRoute++; deadRouteGames += totalGames;
      dead.push({ sid: sid, held: gs.length, used: used.size, games: totalGames,
                  allGrading: isAllGrading, locked: !!meta.locked,
                  name: meta.fullName || meta.name || '?', org: meta.orgName || '?' });
    } else if (matched < used.size) partial++;
    else fine++;
  }

  console.log('  seasons in sports-index                    : ' + n(seasonsWithIdx));
  console.log('    no grade list stored                     : ' + n(noGrades));
  console.log('    grade list stored but we hold no games    : ' + n(noGamesHeld));
  console.log('');
  console.log('  OF SEASONS WE HOLD GAMES FOR — does the indexed grade list reach them?');
  console.log('    at least one indexed grade is in use      : ' + n(fine + partial) + '   ← enumeration route WORKS');
  console.log('      of those, index covers only some grades : ' + n(partial) + '   ← harmless: a team found in ONE grade returns its whole fixture');
  console.log('    NO indexed grade is in use                : ' + n(deadRoute) + '  (' + pct(deadRoute, fine + partial + deadRoute) + '%)  ← nothing we hold came through the indexed path');
  console.log('      games in those seasons                  : ' + n(deadRouteGames) + '   (arrived by other routes)');
  console.log('');
  console.log('  SEASONS WHOSE INDEXED GRADES ARE ALL "* Grading": ' + n(allGrading));
  console.log('    A grading grade returns ladder:[] — not an error, it is not a competition.');
  console.log('    These enumerate ZERO teams, so discover-fixtures fetches no fixtures for');
  console.log('    them at all. This is the EDJBA Winter 2026 shape and it is the real fault.');
  for (const g of grading.slice(0, TOP)) {
    console.log('      ' + g.sid + '  ' + g.gs + ' grades, all grading' +
                (g.meta.locked ? ' [locked]' : ' [active]') + '  ' +
                (g.meta.fullName || g.meta.name || '?') + ' — ' + (g.meta.orgName || '?'));
  }
  if (dead.length) {
    console.log('');
    console.log('  SEASONS WHERE NO INDEXED GRADE IS IN USE (worst by games held):');
    for (const d of dead.sort((a, b) => b.games - a.games).slice(0, TOP)) {
      console.log('    ' + d.sid + '  index ' + String(d.held).padStart(4) + ' grades, games use ' +
                  String(d.used).padStart(4) + ', overlap 0  · ' + n(d.games) + ' games held' +
                  (d.allGrading ? ' [all grading]' : '') + (d.locked ? ' [locked]' : ' [active]') +
                  '  ' + d.name + ' — ' + d.org);
    }
  }
  console.log('');
  console.log('  WHAT TO DO WITH THIS: the "* Grading" list is the actionable one — those');
  console.log('  seasons cannot enumerate teams and never will until their grade list is');
  console.log('  re-read. discover-seasons.js only refreshes grades for seasons at grades:[]');
  console.log('  (L542), so a season that had grades at creation is never revisited. The');
  console.log('  import from junior-footy-dashboard suggests discoverTeams(filter:{seasonID})');
  console.log('  as a route that bypasses ladders entirely — UNTESTED on this tenant.');
  console.log('');
}

console.log('── done ──');
