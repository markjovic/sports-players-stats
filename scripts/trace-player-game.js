// scripts/trace-player-game.js
//
// READ-ONLY, offline, zero API calls. No writes, no git, no lock.
//
// WHY THIS EXISTS. Every diagnostic so far has reasoned about a symptom. This one
// traces a single value: for one player and one game, it prints EVERY id in that
// game's roster, what the alias table maps each to, and therefore whether
// build-player-games could put that game in this player's games[].
//
// THE CASE IT WAS BUILT FOR. Bailey Walton e9dee630-ab52-4056-b1fb-c68bd6bd8b3b
// holds 6 games in games[] whose rosters do NOT contain his id. build-player-games
// writes games[] ONLY from p[], and it has run many times since, yet the entries
// survive. So either an id in those rosters ALIASES to him, or something other
// than build-player-games wrote them. Those are the only two possibilities and
// this distinguishes them.
//
// It prints, per game:
//   · every roster id, its alias target, and whether that target IS this player
//   · whether the game is in the player's games[]
//   · the capture flags, so a pre-flag roster is visible
// and then states plainly which mechanism can and cannot explain what it found.
//
// Usage:
//   node scripts/trace-player-game.js --player=<uuid>
//   node scripts/trace-player-game.js --player=<uuid> --games=833bc466,3a82c039

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.env.SCAN_ROOT || path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (f, d) => { const a = args.find(x => x.startsWith('--' + f + '=')); return a ? a.split('=')[1] : d; };
const PLAYER = arg('player', '');
const ONLY = String(arg('games', '')).split(',').map(x => x.trim()).filter(Boolean);
if (!PLAYER) { console.error('ABORT: need --player=<uuid>'); process.exit(1); }
const TRUNC = 13;
const n = (x) => Number(x || 0).toLocaleString();

function main() {
  const pf = path.join(ROOT, 'players', PLAYER.slice(0, 2), PLAYER + '.json');
  if (!fs.existsSync(pf)) { console.error('ABORT: no player file at ' + pf); process.exit(1); }
  const p = JSON.parse(fs.readFileSync(pf, 'utf8'));
  const held = new Set(Array.isArray(p.games) ? p.games : []);
  console.log('  player : ' + PLAYER + '  ' + JSON.stringify(p.name || '?'));
  console.log('  games[]: ' + n(held.size));
  console.log('  spectatorIds on file: ' + JSON.stringify(p.spectatorIds || []));

  // Every id that resolves to this player: own prefix, spectatorIds, and any alias
  // entry pointing at them. This is exactly what build-player-games resolves with.
  const aliasTo = new Map();
  const aliasDir = path.join(ROOT, 'players', 'aliases');
  let aliasCount = 0;
  try {
    for (const f of fs.readdirSync(aliasDir)) {
      if (!f.endsWith('.json')) continue;
      const m = JSON.parse(fs.readFileSync(path.join(aliasDir, f), 'utf8'));
      for (const [k, v] of Object.entries(m)) { aliasTo.set(k, v); aliasCount++; }
    }
  } catch (e) { console.log('  ⚠ players/aliases unreadable: ' + e.message); }
  const mine = new Set([PLAYER.slice(0, TRUNC)]);
  for (const x of (p.spectatorIds || [])) if (x) mine.add(String(x));
  for (const [k, v] of aliasTo) if (v === PLAYER) mine.add(k);
  console.log('  alias table entries : ' + n(aliasCount));
  console.log('  ids that resolve to THIS player: ' + [...mine].join(' '));
  console.log('');

  const want = ONLY.length ? new Set(ONLY) : held;
  console.log('  tracing ' + n(want.size) + ' game(s)' + (ONLY.length ? ' (from --games)' : ' (every game in games[])'));
  console.log('');

  const gamesDir = path.join(ROOT, 'games', 'bv');
  let found = 0, reachable = 0, unreachable = 0, missing = 0;
  const unreachableGames = [];
  for (const f of fs.readdirSync(gamesDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = path.basename(f, '.json');
    let sg; try { sg = JSON.parse(fs.readFileSync(path.join(gamesDir, f), 'utf8')); } catch (e) { continue; }
    for (const gid of Object.keys(sg.games || {})) {
      if (!want.has(gid)) continue;
      found++;
      const g = sg.games[gid];
      const ids = (Array.isArray(g.p) ? g.p : []).map(x => x && x.id).filter(Boolean);
      const hits = ids.filter(id => mine.has(id));
      const flags = (g.spc ? 'spc ' : '') + (g.dg ? 'dg ' : '') + (!g.spc && !g.dg ? 'NO FLAG' : '');
      if (hits.length) reachable++; else { unreachable++; unreachableGames.push({ gid, sid, ids, flags }); }
      if (ONLY.length || !hits.length) {
        console.log('  game ' + gid + '  season ' + sid + '  roster ' + ids.length + '  [' + flags.trim() + ']' +
                    '  in games[]: ' + (held.has(gid) ? 'YES' : 'no'));
        console.log('    resolves to this player: ' + (hits.length ? hits.join(' ') : 'NOTHING IN THIS ROSTER'));
        // Print the whole roster with alias targets, so a mapping to a DIFFERENT
        // player is visible rather than inferred.
        for (const id of ids) {
          const t = aliasTo.get(id);
          const mark = mine.has(id) ? '  <-- THIS PLAYER' : '';
          console.log('      ' + id + (t ? '  -> ' + t : '  (no alias entry; resolves to itself)') + mark);
        }
        console.log('');
      }
    }
  }
  missing = want.size - found;

  console.log('  ══ WHAT THIS MEANS ════════════════════════════════════════════════');
  console.log('    games traced                 : ' + n(want.size));
  console.log('      not present in games/bv    : ' + n(missing));
  console.log('      roster CONTAINS an id that resolves to this player : ' + n(reachable));
  console.log('      roster contains NO such id : ' + n(unreachable));
  console.log('');
  if (unreachable) {
    console.log('    ' + n(unreachable) + ' game(s) are in this player\'s games[] and NOTHING in their roster');
    console.log('    resolves to them. build-player-games writes games[] ONLY from p[], so it');
    console.log('    CANNOT have written these. Either:');
    console.log('      · another writer sets games[] directly, or');
    console.log('      · an alias entry existed when they were written and has since changed, or');
    console.log('      · the roster itself was rewritten after games[] was built.');
    console.log('    The alias listing above rules the first mechanism in or out by inspection.');
  } else {
    console.log('    Every traced game has an id in its roster that resolves to this player, so');
    console.log('    build-player-games writing them is fully explained. Nothing unaccounted for.');
  }
}

main();
