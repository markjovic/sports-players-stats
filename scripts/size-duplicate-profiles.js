// scripts/size-duplicate-profiles.js
//
// READ-ONLY, offline, zero API calls. No writes, no git, no lock.
//
// WHY THIS EXISTS. On 2026-08-21 two StatTrack pages were opened side by side:
//   Tahlia Parker  gp=389  games=1    Kilsyth Basketball
//   Tahlia Parker  gp=388  games=386  Mt Lilydale Lakers (MLBC)
// One person, TWO PlayHQ api ids, nothing linking them. Lara Hansen is the same
// shape (15 credited on one identity, 357 on the other) and playhq_api_reference.md
// already records "api id believed unique but untested" as a live risk.
//
// THIS IS NOT A GAP, AND REPAIRING IT MAKES IT WORSE. probe-player reported 388
// "roster gaps" for the games=1 identity — her id genuinely absent from those
// team sheets. But her OTHER identity IS in them. Appending therefore puts TWO ids
// for one human into the same roster, build-player-games resolves each to a
// different player record, and the game lands in BOTH games[] arrays. That is a
// duplicated appearance in every count downstream. The repair campaign was
// re-admitting exactly these players via --retry-open.
//
// WHAT IT MEASURES, and the limits are stated rather than assumed:
//   1. THE SHAPE. Players with a large credited gp and a near-empty games[] — the
//      identity that holds the credit but not the appearances.
//   2. THE PARTNER. For each, another player file with the SAME normalised name
//      whose games[] is large. Name matching is a HEURISTIC, not proof: common
//      names collide, and two real people can share one. Every pair is printed so
//      it can be judged, and the summary separates pairs corroborated by a shared
//      season from name-only matches.
//   3. THE DAMAGE. If reports/repair-batch-progress.json is present, how many of
//      these players the campaign has already appended to.
//
// Usage: node scripts/size-duplicate-profiles.js

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.env.SCAN_ROOT || path.join(__dirname, '..');
const TOP = Number(process.env.TOP || 40);

const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';

// Same normalisation the pipeline's own name matching uses: lowercase, strip
// everything that is not a letter or digit. Deliberately aggressive — the point is
// to CATCH candidates, and every one is printed for judgement.
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function main() {
  const playersDir = path.join(ROOT, 'players');
  if (!fs.existsSync(playersDir)) { console.error('ABORT: players/ not found'); process.exit(1); }

  const byName = new Map();     // normalised name -> [{uuid, gp, games, sids, club, priv, name}]
  let scanned = 0, unreadable = 0;

  for (const shard of fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d))) {
    const dir = path.join(playersDir, shard);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      scanned++;
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { unreadable++; continue; }
      const key = normName(p.name);
      if (!key) continue;
      let gp = 0, has = false;
      for (const s of Object.values(p.sports || {})) if (s && typeof s.gp === 'number') { gp += s.gp; has = true; }
      const games = Array.isArray(p.games) ? p.games.length : 0;
      const sids = new Set();
      for (const se of (Array.isArray(p.seasons) ? p.seasons : [])) if (se && se.sid) sids.add(se.sid);
      const clubs = new Set();
      for (const se of (Array.isArray(p.seasons) ? p.seasons : [])) if (se && se.club) clubs.add(se.club);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push({ uuid: f.replace(/\.json$/, ''), name: p.name || '?', gp: has ? gp : null,
                             games, sids, clubs, priv: p.private === true });
    }
  }
  console.log('  players scanned : ' + n(scanned) + (unreadable ? '  (unreadable ' + n(unreadable) + ')' : ''));
  console.log('  distinct names  : ' + n(byName.size));

  // Which players has the repair campaign already appended to?
  let appendedTo = new Map();
  try {
    const prog = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'repair-batch-progress.json'), 'utf8'));
    for (const [uuid, rec] of Object.entries(prog.done || {})) {
      const a = (rec && rec.appended) || 0;
      if (a > 0) appendedTo.set(uuid, a);
    }
    console.log('  repair campaign : ' + n(appendedTo.size) + ' players have had appends written');
  } catch (e) {
    console.log('  repair campaign : progress file not readable — the damage column will be empty');
  }

  // ── THE SHAPE ──────────────────────────────────────────────────────────────
  // A credit-holding identity: PlayHQ credits it with games it does not hold. The
  // threshold is deliberately loose; the PAIRING below is what makes a candidate.
  let shapeOnly = 0;
  const pairs = [];
  let sharedSeason = 0, nameOnly = 0, damaged = 0, damagedAppends = 0;

  for (const [key, list] of byName) {
    if (list.length < 2) continue;
    const holders  = list.filter(x => x.gp !== null && x.gp >= 20 && x.games <= x.gp * 0.15);
    const partners = list.filter(x => x.games >= 20);
    if (!holders.length || !partners.length) continue;
    for (const h of holders) {
      for (const q of partners) {
        if (q.uuid === h.uuid) continue;
        const shared = [...h.sids].filter(s => q.sids.has(s));
        const sameClub = [...h.clubs].some(c => q.clubs.has(c));
        const app = appendedTo.get(h.uuid) || 0;
        if (app) { damaged++; damagedAppends += app; }
        if (shared.length || sameClub) sharedSeason++; else nameOnly++;
        pairs.push({ key, h, q, shared: shared.length, sameClub, app });
      }
    }
  }
  for (const [, list] of byName) for (const x of list) if (x.gp !== null && x.gp >= 20 && x.games <= x.gp * 0.15) shapeOnly++;

  console.log('');
  console.log('  ── THE SHAPE: identities credited with games they do not hold ──');
  console.log('    players with gp>=20 and games[] <= 15% of gp : ' + n(shapeOnly));
  console.log('      (that alone is NOT a duplicate — it is also what an uncaptured or');
  console.log('       undiscovered season looks like. The pairing below is the test.)');
  console.log('');
  console.log('  ── THE PAIRING: same normalised name, one holds the appearances ──');
  console.log('    candidate pairs                    : ' + n(pairs.length));
  console.log('      corroborated by a shared season or club: ' + n(sharedSeason) + '  (' + pct(sharedSeason, pairs.length) + '%)  ← strong');
  console.log('      name match only                       : ' + n(nameOnly) + '  (' + pct(nameOnly, pairs.length) + '%)  ← WEAK, common names collide');
  console.log('');
  console.log('  ── THE DAMAGE: pairs the repair campaign has already appended to ──');
  console.log('    credit-holding identities appended to : ' + n(damaged));
  console.log('    appends written to them               : ' + n(damagedAppends));
  console.log('    Every one is a second id added to a roster that ALREADY contains this');
  console.log('    person under another id. build-player-games then puts the game in BOTH');
  console.log('    players\' games[] — a duplicated appearance in every downstream count.');
  console.log('');
  console.log('  ── WORST ' + TOP + ' PAIRS BY SIZE OF THE HOLDING IDENTITY ──');
  pairs.sort((a, b) => (b.h.gp - b.h.games) - (a.h.gp - a.h.games));
  for (const p of pairs.slice(0, TOP)) {
    console.log('    ' + JSON.stringify(p.h.name));
    console.log('      credit-holder : ' + p.h.uuid + '  gp=' + p.h.gp + ' games=' + p.h.games +
                (p.h.priv ? ' [PRIVATE]' : '') + (p.app ? '  ⚠ REPAIR APPENDED ' + p.app : ''));
    console.log('      appearances in: ' + p.q.uuid + '  gp=' + (p.q.gp === null ? '—' : p.q.gp) + ' games=' + p.q.games +
                (p.q.priv ? ' [PRIVATE]' : ''));
    console.log('      corroboration : ' + (p.shared ? p.shared + ' shared season(s)' : '') +
                (p.sameClub ? (p.shared ? ' · ' : '') + 'same club' : '') +
                (!p.shared && !p.sameClub ? 'NAME ONLY — treat with suspicion' : ''));
  }
  console.log('');
  console.log('  HOW TO READ IT: the corroborated count is the population that matters. A');
  console.log('  name-only match on a common name is not evidence. Nothing here proves two');
  console.log('  ids are one person — only PlayHQ can, and it does not expose the link —');
  console.log('  but a pair sharing a season AND a club, where one holds the credit and the');
  console.log('  other holds the appearances, is not a coincidence worth ignoring.');
}

main();
