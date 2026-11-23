// scripts/tests/test-superseded-wiring.js
// Simulates the exact wiring in nightly-crawl.js against a realistic game file.
const RR = require('../lib/round-refresh.cjs');
let pass=0, fail=0; const t=(n,c)=>{ if(c)pass++; else {fail++; console.log('  FAIL:',n);} };
const TODAY='2026-11-24';

// Real shapes, including a forfeit and a spectator-roster-only game
const games = {
  ar6:{d:'2026-11-13',t:'17:45',gid:'81ef26d5',gn:'Friday U13 Boys AR',h:'43878738',hn:'B13 Maroondah Magic 1',a:'46bebc52',an:'B13 Vermont Vultures 2',st:'UPCOMING'},
  a6: {d:'2026-11-13',gid:'7d0c2383',gn:'Friday U13 Boys A',h:'549ad9e5',hn:'B13 Blackburn Vikings 5',a:'43878738',an:'B13 Maroondah Magic 1',hs:39,as:42,st:'FINAL'},
  // forfeit counts as played, so it supersedes
  arF:{d:'2026-10-30',gid:'81ef26d5',h:'T9',a:'T8',st:'UPCOMING'},
  aF: {d:'2026-10-30',gid:'7d0c2383',h:'T9',a:'T7',forfeit:true,fo:'T9'},
  // roster-only counts as played
  arR:{d:'2026-10-16',gid:'81ef26d5',h:'T5',a:'T4',st:'UPCOMING'},
  aR: {d:'2026-10-16',gid:'7d0c2383',h:'T5',a:'T3',spc:1},
  // genuine washout
  wo: {d:'2026-10-09',gid:'81ef26d5',h:'T1',a:'T2',st:'PENDING'},
};

// ── apply, exactly as the crawl does
const applyOnce = (gf) => {
  const { set, clear } = RR.computeSupersededFlags(gf, { today: TODAY });
  for (const [id, by] of set) gf[id].sup = by;
  for (const id of clear) delete gf[id].sup;
  return { n: set.size, c: clear.length };
};

let r = applyOnce(games);
t('wire: 3 flags set on first pass', r.n === 3);
t('wire: Maroondah AR flagged by the played A game', games.ar6.sup === 'a6');
t('wire: forfeit supersedes', games.arF.sup === 'aF');
t('wire: roster-only supersedes', games.arR.sup === 'aR');
t('wire: washout untouched', !('sup' in games.wo));
t('wire: played games never flagged', !('sup' in games.a6) && !('sup' in games.aF));

// ── idempotent: a second pass changes nothing
r = applyOnce(games);
t('wire: second pass is a no-op', r.n === 0 && r.c === 0);
t('wire: flag unchanged after re-run', games.ar6.sup === 'a6');

// ── the refetch case: applyRoundFixtures spreads ...existing, so sup survives.
//    Simulate PlayHQ later returning a SCORE for the previously-unplayed game.
games.ar6 = { ...games.ar6, hs: 30, as: 28, st: 'FINAL' };
t('wire: sup survived the simulated refetch (this is the hazard)', games.ar6.sup === 'a6');
r = applyOnce(games);
t('wire: and is CLEARED once played', !('sup' in games.ar6) && r.c === 1);

// ── the superseding game being deleted must clear the flag
delete games.aF;
r = applyOnce(games);
t('wire: cleared when the superseding game is deleted', !('sup' in games.arF));

// ── nothing left to do
r = applyOnce(games);
t('wire: settles', r.n === 0 && r.c === 0);

// ── game count is never changed, so the shrink guard cannot fire on this
const before = Object.keys(games).length;
applyOnce(games);
t('wire: writes no games and deletes none', Object.keys(games).length === before);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
