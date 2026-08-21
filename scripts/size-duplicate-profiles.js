// scripts/size-duplicate-profiles.js
//
// READ-ONLY, offline, zero API calls. No writes, no git, no lock.
//
// ⚠ REWRITTEN 2026-08-21. THE FIRST VERSION LOOKED FOR THE WRONG THING AND
// REPORTED ZERO DAMAGE WHILE THE DAMAGE WAS ALREADY DONE.
//
// It keyed on a SHAPE — `gp >= 20 and games[] <= 15% of gp` — the signature of an
// identity credited with games it does not hold. That is the signature of an
// UNREPAIRED duplicate. The moment repair-players-batch appends the missing games,
// games[] fills, the shape vanishes, and the pair reads as two ordinary players.
// So it could only ever find duplicates that had NOT yet been damaged, which is
// exactly backwards. It reported "0 appended to" for Tahlia Parker while her two
// files held 385 of the same games.
//
// THE CORRECT TEST IS SHARED GAMES. If two player files with the same normalised
// name both hold the same game id, one human is counted twice in that game — in
// team stats, leaderboards and every downstream total. That is true before a
// repair and after one, so it cannot be hidden by the repair that caused it.
//
// WHAT WENT WRONG, recorded so it is not repeated:
//   f806d1b6-f87f-4434-be56-62a67f54f5bb  gp=388 games=386  4 spectatorIds
//   20b2df06-37f4-48a9-8477-1f6185bc7533  gp=389 games=389  1 spectatorId (its own)
// Checked against PlayHQ on 2026-08-21: /public/profile/20b2df06... resolves;
// /public/profile/f806d1b6... returns "There was a problem getting the profile".
// So f806d1b6 is NOT an api profile — it is a SPECTATOR-namespace uuid that was
// written as a player file, which the project documents as incorrect. I asserted
// both were real api profiles without checking the second one.
//
// A player file whose uuid PlayHQ does not serve cannot be detected offline, so
// this reports the two signals that CAN be measured here and names the check that
// needs the API.

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.env.SCAN_ROOT || path.join(__dirname, '..');
const TOP = Number(process.env.TOP || 40);

const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function main() {
  const playersDir = path.join(ROOT, 'players');
  if (!fs.existsSync(playersDir)) { console.error('ABORT: players/ not found'); process.exit(1); }

  // uuid -> {name key, games count, gp, priv, specCount, ownSpecOnly}
  const meta = new Map();
  // gid -> uuids holding it. 29.9M entries, so the value stays a plain array and
  // the map is dropped as soon as the pairing below is built.
  const holders = new Map();
  let scanned = 0, unreadable = 0, totalAppearances = 0;

  for (const shard of fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d))) {
    const dir = path.join(playersDir, shard);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      scanned++;
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { unreadable++; continue; }
      const uuid = f.replace(/\.json$/, '');
      const games = Array.isArray(p.games) ? p.games : [];
      let gp = null;
      for (const s of Object.values(p.sports || {})) if (s && typeof s.gp === 'number') gp = (gp || 0) + s.gp;
      const spec = Array.isArray(p.spectatorIds) ? p.spectatorIds : [];
      meta.set(uuid, {
        key: normName(p.name), name: p.name || '?', games: games.length, gp: gp,
        priv: p.private === true, spec: spec.length,
        // A file whose ONLY spectatorId is its own 13-char prefix has never been
        // linked to anything. Both members of a split pair look like this on one
        // side, so it is a weak signal on its own — reported, not relied on.
        selfOnly: spec.length === 1 && String(spec[0]) === uuid.slice(0, 13),
      });
      for (const g of games) {
        totalAppearances++;
        const a = holders.get(g);
        if (a) a.push(uuid); else holders.set(g, [uuid]);
      }
    }
  }
  console.log('  players scanned      : ' + n(scanned) + (unreadable ? '  (unreadable ' + n(unreadable) + ')' : ''));
  console.log('  appearances indexed  : ' + n(totalAppearances));
  console.log('  distinct games held  : ' + n(holders.size));

  // ── THE TEST: one game, two same-named players ─────────────────────────────
  const pairGames = new Map();      // "uuidA|uuidB" -> shared game count
  let dupAppearances = 0;
  for (const [, list] of holders) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = meta.get(list[i]), b = meta.get(list[j]);
        if (!a || !b || !a.key || a.key !== b.key) continue;
        const k = list[i] < list[j] ? list[i] + '|' + list[j] : list[j] + '|' + list[i];
        pairGames.set(k, (pairGames.get(k) || 0) + 1);
        dupAppearances++;
      }
    }
  }
  holders.clear();

  const pairs = [...pairGames.entries()].map(([k, shared]) => {
    const [ua, ub] = k.split('|');
    return { ua, ub, shared, a: meta.get(ua), b: meta.get(ub) };
  }).sort((x, y) => y.shared - x.shared);

  console.log('');
  console.log('  ══ ONE GAME, TWO SAME-NAMED PLAYER FILES ══════════════════════════');
  console.log('    duplicate PAIRS              : ' + n(pairs.length));
  console.log('    duplicated APPEARANCES       : ' + n(dupAppearances) +
              '  (' + pct(dupAppearances, totalAppearances) + '% of all appearances)');
  console.log('    Each is one human counted TWICE in one game — in team stats, in every');
  console.log('    leaderboard, in every total. This test holds whether or not a repair has');
  console.log('    already filled the emptier file, which the previous shape-based test did not.');
  console.log('');
  if (!pairs.length) {
    console.log('    None found. Note this cannot see a split identity whose two files hold');
    console.log('    DIFFERENT games — that is a gap, not a duplication, and needs the API.');
    return;
  }

  // How lopsided is each pair? A pair where one side holds almost nothing is an
  // untouched split; a pair holding nearly the same set has been repaired into a
  // duplicate.
  let repaired = 0, untouched = 0, partial = 0;
  for (const p of pairs) {
    const small = Math.min(p.a.games, p.b.games), big = Math.max(p.a.games, p.b.games);
    const overlap = big ? p.shared / big : 0;
    if (overlap >= 0.8) repaired++;
    else if (small <= big * 0.15) untouched++;
    else partial++;
  }
  console.log('    STATE OF EACH PAIR:');
  console.log('      both files hold ~the same games (>=80% overlap): ' + n(repaired) + '   ← ALREADY DUPLICATED');
  console.log('      one side nearly empty                          : ' + n(untouched) + '   ← split, not yet duplicated');
  console.log('      partial overlap                                : ' + n(partial));
  console.log('');
  console.log('  ══ WORST ' + TOP + ' BY SHARED GAMES ═══════════════════════════════════════');
  for (const p of pairs.slice(0, TOP)) {
    console.log('    ' + JSON.stringify(p.a.name) + '  \u2014 ' + n(p.shared) + ' games held by BOTH');
    for (const [u, m] of [[p.ua, p.a], [p.ub, p.b]]) {
      console.log('      ' + u + '  gp=' + (m.gp === null ? '\u2014' : m.gp) + ' games=' + m.games +
                  '  spectatorIds=' + m.spec + (m.selfOnly ? ' (own only)' : '') + (m.priv ? ' [PRIVATE]' : ''));
    }
  }
  console.log('');
  console.log('  ══ WHAT THIS CANNOT TELL YOU ═════════════════════════════════════');
  console.log('    WHICH file is the real one. Offline there is no way to know: both are');
  console.log('    36-char uuids and both carry data. On 2026-08-21 the answer for Tahlia');
  console.log('    Parker came from opening playhq.com/public/profile/<uuid>/statistics for');
  console.log('    each — one resolved, the other returned "There was a problem getting the');
  console.log('    profile". THAT is the discriminator, and it needs a request per candidate.');
  console.log('    With ' + n(pairs.length) + ' pairs that is ' + n(pairs.length * 2) + ' calls — small enough to probe.');
}

main();
