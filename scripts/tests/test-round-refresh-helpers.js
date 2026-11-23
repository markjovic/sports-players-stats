// scripts/tests/test-round-refresh-helpers.js
const RR = require('../lib/round-refresh.cjs');
let pass=0, fail=0;
const t=(n,c)=>{ if(c){pass++;} else {fail++; console.log('  FAIL:',n);} };

// planGradeFull
const grade={ rounds:[{id:'r1',name:'Round 1'},{id:'r2',name:'Round 2'},{name:'Round 3'},{id:'r2',name:'Round 4'},{id:'r5',name:'Round 5'}] };
let pf=RR.planGradeFull({grade, fetchedRoundNames:new Set(['Round 1'])});
t('full: skips fetched', !pf.fetch.some(f=>f.roundName==='Round 1'));
t('full: takes R2 and R5', pf.fetch.map(f=>f.roundName).join(',')==='Round 2,Round 5');
t('full: id-less reported', pf.unfetchable.includes('Round 3'));
t('full: dup id reported', pf.unfetchable.includes('Round 4'));
t('full: nothing silently dropped', pf.fetch.length+pf.unfetchable.length===4);

// detectGradeChange
const rr=new Map([['G|Round 1',{ids:['a','b'],answered:true}],['G|Round 2',{ids:['c'],answered:true}],['H|Round 1',{ids:['z'],answered:true}]]);
const h=(ids)=>RR.hashIdSet(ids);
t('change: baseline not changed', RR.detectGradeChange({stored:null,gid:'G',roundResults:rr,roundListHash:'x'}).changed===false);
t('change: identical -> no change',
  RR.detectGradeChange({stored:{rl:'L',r:{'Round 1':h(['a','b']),'Round 2':h(['c'])}},gid:'G',roundResults:rr,roundListHash:'L'}).changed===false);
let d=RR.detectGradeChange({stored:{rl:'L',r:{'Round 1':h(['a']),'Round 2':h(['c'])}},gid:'G',roundResults:rr,roundListHash:'L'});
t('change: id-set differs', d.changed && d.rounds.join()==='Round 1');
d=RR.detectGradeChange({stored:{rl:'L',r:{'Round 1':h(['a','b'])}},gid:'G',roundResults:rr,roundListHash:'L'});
t('change: unseen round counts', d.changed && d.rounds.join()==='Round 2');
t('change: other grade ignored',
  !RR.detectGradeChange({stored:{rl:'L',r:{'Round 1':h(['a','b']),'Round 2':h(['c'])}},gid:'G',roundResults:rr,roundListHash:'L'}).rounds.length);
t('change: round list hash differs',
  RR.detectGradeChange({stored:{rl:'OLD',r:{'Round 1':h(['a','b']),'Round 2':h(['c'])}},gid:'G',roundResults:rr,roundListHash:'NEW'}).changed===true);
t('change: unanswered ignored',
  RR.detectGradeChange({stored:{rl:'L',r:{'Round 1':h(['a','b'])}},gid:'G',roundResults:new Map([['G|Round 9',{ids:[],answered:false}]]),roundListHash:'L'}).changed===false);

// teamsInRounds — both side shapes
const byRound=new Map([
  ['Round 6',[{g:{h:'T1',a:'T2'}},{g:{t1:'T3',t2:'T4'}}]],
  ['Round 7',[{g:{h:'T5'}}]],
]);
let tm=RR.teamsInRounds({byRound, roundNames:['Round 6']});
t('teams: h/a', tm.has('T1')&&tm.has('T2'));
t('teams: t1/t2', tm.has('T3')&&tm.has('T4'));
t('teams: scoped to round', !tm.has('T5'));

// findSameDayGradeConflicts
const games={
  g1:{d:'2026-11-13',gid:'AR',gn:'Friday U13 Boys AR',h:'M1',a:'V2'},
  g2:{d:'2026-11-13',gid:'A', gn:'Friday U13 Boys A', h:'M1',a:'H1',hs:39,as:42,st:'FINAL'},
  g3:{d:'2026-11-20',gid:'A', h:'M1',a:'V1'},
  g4:{d:'2026-11-13',gid:'A', t1:'S1',t2:'X9'},
};
const c=RR.findSameDayGradeConflicts(games);
const m1=c.find(x=>x.tid==='M1'&&x.date==='2026-11-13');
t('conflict: found M1 two grades same day', !!m1 && m1.grades.length===2);
t('conflict: names both grades', m1 && m1.grades.includes('AR') && m1.grades.includes('A'));
t('conflict: carries game ids', m1 && m1.gameIds.length===2);
t('conflict: carries grade names', m1 && m1.gradeNames.length===2);
t('conflict: carries played flags', m1 && m1.played.length===2);
t('conflict: single-grade day clean', !c.some(x=>x.tid==='S1'));
t('conflict: different days not flagged', !c.some(x=>x.tid==='M1'&&x.date==='2026-11-20'));
t('conflict: names the grades', m1 && m1.gradeNames.includes('Friday U13 Boys AR') && m1.gradeNames.includes('Friday U13 Boys A'));
t('conflict: played side flagged played', m1 && m1.played[m1.grades.indexOf('A')]===true);
t('conflict: unplayed side flagged unplayed', m1 && m1.played[m1.grades.indexOf('AR')]===false);
t('conflict: no gid -> skipped', RR.findSameDayGradeConflicts({x:{d:'2026-01-01',h:'T'}}).length===0);
t('conflict: no date -> skipped', RR.findSameDayGradeConflicts({x:{gid:'A',h:'T'}}).length===0);

// ── REGRESSION GUARD. These names are NOT the shape games/bv uses. The first
// version of sideIds() read them, returned nothing on real data, and passed its
// own tests because the fixtures used the same wrong names. If someone puts
// hTid/aTid back, these two go red instead of the run going quietly empty.
t('GUARD: sideIds reads h/a', RR.sideIds({h:'A1',a:'A2'}).join()==='A1,A2');
t('GUARD: sideIds reads t1/t2', RR.sideIds({t1:'B1',t2:'B2'}).join()==='B1,B2');
t('GUARD: sideIds IGNORES hTid/aTid', RR.sideIds({hTid:'C1',aTid:'C2'}).length===0);
t('GUARD: invariant blind to hTid', RR.findSameDayGradeConflicts({
    z1:{d:'2026-11-13',gid:'AR',hTid:'M1'}, z2:{d:'2026-11-13',gid:'A',hTid:'M1'}}).length===0);
t('GUARD: invariant sees h', RR.findSameDayGradeConflicts({
    z1:{d:'2026-11-13',gid:'AR',h:'M1'}, z2:{d:'2026-11-13',gid:'A',h:'M1'}}).length===1);
t('sideIds: half a pairing still counts', RR.sideIds({h:'D1'}).join()==='D1');
t('sideIds: prefers h over t1 when both present', RR.sideIds({h:'E1',t1:'E9',a:'E2'}).join()==='E1,E2');


// ─── Name-keyed conflicts: the new-team-entry regrade shape ─────────────────
{
  const G = {
    // Same NAME, same day, two grades, DIFFERENT tids — the shape the id pass cannot see
    n1:{d:'2026-11-13',gid:'AR',gn:'U13 Boys AR',h:'TID_OLD',hn:'B13 Maroondah Magic 1',a:'V2',an:'Vultures 2'},
    n2:{d:'2026-11-13',gid:'A', gn:'U13 Boys A', h:'TID_NEW',hn:'B13 Maroondah Magic 1',a:'H1',an:'Hornets 1',hs:39,as:42,st:'FINAL'},
    // Same name, same day, SAME tid — belongs to the id pass, must not appear here
    s1:{d:'2026-12-01',gid:'AR',gn:'U13 Boys AR',h:'TID_SAME',hn:'Team Same',a:'X',an:'X'},
    s2:{d:'2026-12-01',gid:'A', gn:'U13 Boys A', h:'TID_SAME',hn:'Team Same',a:'Y',an:'Y'},
    // Same name, different days — not a conflict
    d1:{d:'2027-01-01',gid:'AR',hn:'Team Days',h:'T1',an:'Z',a:'Z'},
    d2:{d:'2027-01-08',gid:'A', hn:'Team Days',h:'T2',an:'W',a:'W'},
  };
  const nc = RR.findSameDayNameConflicts(G);
  const mm = nc.find(x => x.name === 'B13 Maroondah Magic 1');
  t('name: catches the new-team-entry regrade', !!mm);
  t('name: both grades named', mm && mm.gradeNames.includes('U13 Boys AR') && mm.gradeNames.includes('U13 Boys A'));
  t('name: reports both tids', mm && mm.tids.includes('TID_OLD') && mm.tids.includes('TID_NEW'));
  t('name: played/unplayed split', mm && mm.played.filter(Boolean).length === 1);
  t('name: SAME tid excluded (id pass owns it)', !nc.some(x => x.name === 'Team Same'));
  t('name: different days not flagged', !nc.some(x => x.name === 'Team Days'));
  t('name: id pass is blind to this shape',
    RR.findSameDayGradeConflicts({ n1:G.n1, n2:G.n2 }).length === 0);
  t('name: away side matched too', RR.findSameDayNameConflicts({
      q1:{d:'2026-11-13',gid:'AR',an:'Away Co',a:'TA'}, q2:{d:'2026-11-13',gid:'A',an:'Away Co',a:'TB'} }).length === 1);
  t('name: nameless rows skipped', RR.findSameDayNameConflicts({
      r1:{d:'2026-11-13',gid:'AR',h:'T1'}, r2:{d:'2026-11-13',gid:'A',h:'T2'} }).length === 0);
}

// ─── Stale fixtures per grade: the real AR shape (a REAL division) ─────────
{
  const TODAY = '2026-11-24';
  const G = {
    // AR is A-Reserve: a real division with real results AND stale leftovers
    ar_p1:{d:'2026-10-09',gid:'AR',gn:'Friday U11 Boys AR',h:'RAPT',hn:'Raptors 1',a:'WAV',an:'Waverley 1',hs:30,as:28,st:'FINAL'},
    ar_p2:{d:'2026-10-16',gid:'AR',gn:'Friday U11 Boys AR',h:'WAV', hn:'Waverley 1',a:'EB1',an:'E.Bees 1',hs:21,as:40,st:'FINAL'},
    // stale, and the team played in another grade that day -> SUPERSEDED
    ar_s1:{d:'2026-10-23',gid:'AR',gn:'Friday U11 Boys AR',h:'RAPT',hn:'Raptors 1',a:'VH1',an:'Hoopers 1',rn:'Round 3',st:'PENDING'},
    // stale, nobody played anywhere that day -> a washout, NOT superseded
    ar_s2:{d:'2026-10-30',gid:'AR',gn:'Friday U11 Boys AR',h:'WAV', hn:'Waverley 1',a:'EB1',an:'E.Bees 1',rn:'Round 4',st:'PENDING'},
    // future and unplayed -> not stale at all
    ar_f1:{d:'2027-02-05',gid:'AR',gn:'Friday U11 Boys AR',h:'RAPT',hn:'Raptors 1',a:'WAV',an:'Waverley 1',st:'PENDING'},
    // B: Raptors played here on 23 Oct, which is what supersedes ar_s1
    b_p1: {d:'2026-10-23',gid:'B', gn:'Friday U11 Boys B', h:'RAPT',hn:'Raptors 1',a:'MM3',an:'Magic 3',hs:10,as:32,st:'FINAL'},
  };
  const st = RR.findStaleFixtureGrades(G, { today: TODAY });
  const ar = st.find(x => x.gid === 'AR');
  t('stale: AR reported despite holding played games', !!ar);
  t('stale: played games counted, not conflated', ar && ar.played === 2);
  t('stale: two stale games', ar && ar.stale === 2);
  t('stale: future game not counted stale', ar && ar.total === 5 && ar.stale === 2);
  t('stale: superseded counted separately', ar && ar.withPlayedElsewhere === 1);
  t('stale: a washout is NOT marked superseded',
    ar && ar.examples.some(e => e.d === '2026-10-30' && e.superseded === false));
  t('stale: superseded example flagged',
    ar && ar.examples.some(e => e.d === '2026-10-23' && e.superseded === true));
  t('stale: date range of stale games only', ar && ar.firstStale === '2026-10-23' && ar.lastStale === '2026-10-30');
  t('stale: round name carried', ar && ar.examples.some(e => e.rn === 'Round 3'));
  t('stale: a clean grade is absent', !st.some(x => x.gid === 'B'));
  t('stale: minStale filters', RR.findStaleFixtureGrades(G, { today: TODAY, minStale: 3 }).length === 0);
  t('stale: sorted by stale count desc', st.length < 2 || st[0].stale >= st[st.length-1].stale);
  t('stale: no games -> nothing', RR.findStaleFixtureGrades({}, { today: TODAY }).length === 0);
  t('stale: undated unplayed game ignored',
    RR.findStaleFixtureGrades({ u:{gid:'U',h:'T',st:'PENDING'} }, { today: TODAY }).length === 0);
}

// ─── computeSupersededFlags: set AND clear, every run ──────────────────────
{
  const T = '2026-11-24';
  const base = {
    // superseded: past, unplayed, team M1 played in grade A that day
    s1:{d:'2026-11-13',gid:'AR',h:'M1',a:'V2',st:'UPCOMING'},
    p1:{d:'2026-11-13',gid:'A', h:'M1',a:'H1',hs:39,as:42,st:'FINAL'},
    // washout: past, unplayed, nobody played anywhere that day
    w1:{d:'2026-10-30',gid:'AR',h:'WAV',a:'EB1',st:'PENDING'},
    // future and unplayed
    f1:{d:'2027-02-05',gid:'AR',h:'M1',a:'V2',st:'UPCOMING'},
    // played game itself
    p2:{d:'2026-11-20',gid:'A', h:'M1',a:'V1',hs:46,as:52,st:'FINAL'},
  };
  let r = RR.computeSupersededFlags(base, { today: T });
  t('sup: flags the superseded fixture', r.set.get('s1') === 'p1');
  t('sup: only one flag set', r.set.size === 1);
  t('sup: washout not flagged', !r.set.has('w1'));
  t('sup: future game not flagged', !r.set.has('f1'));
  t('sup: played game not flagged', !r.set.has('p2'));
  t('sup: nothing to clear on a clean file', r.clear.length === 0);

  // SAME grade on one day is a double-header, not a regrade
  t('sup: same-grade pair not flagged', RR.computeSupersededFlags({
      x1:{d:'2026-11-13',gid:'A',h:'M1',a:'V2',st:'UPCOMING'},
      x2:{d:'2026-11-13',gid:'A',h:'M1',a:'H1',hs:1,as:2,st:'FINAL'} }, { today: T }).set.size === 0);

  // ── CLEARING. Each of these had a flag that is no longer true.
  const withFlag = (extra) => ({ ...base, s1:{ ...base.s1, sup:'p1' }, ...extra });

  t('sup: idempotent when already correct',
    RR.computeSupersededFlags(withFlag({}), { today: T }).set.size === 0);
  t('sup: idempotent leaves it alone, does not clear',
    RR.computeSupersededFlags(withFlag({}), { today: T }).clear.length === 0);

  let c = RR.computeSupersededFlags(withFlag({ s1:{ ...base.s1, sup:'p1', hs:20, as:18, st:'FINAL' } }), { today: T });
  t('sup: CLEARED once the game is played', c.clear.includes('s1'));

  const noOther = withFlag({}); delete noOther.p1;
  t('sup: CLEARED when the superseding game is gone',
    RR.computeSupersededFlags(noOther, { today: T }).clear.includes('s1'));

  t('sup: CLEARED when the flag points at the wrong game',
    RR.computeSupersededFlags(withFlag({ s1:{ ...base.s1, sup:'WRONG' } }), { today: T }).set.get('s1') === 'p1');

  // A flag on a future game must go — dates move, the flag must not be sticky
  t('sup: CLEARED on a game whose date is still ahead',
    RR.computeSupersededFlags({ ...base, f1:{ ...base.f1, sup:'p1' } }, { today: T }).clear.includes('f1'));

  // The whole point: applyRoundFixtures spreads ...existing, so a stale flag survives a refetch
  t('sup: a stale flag IS detected for clearing, not ignored',
    RR.computeSupersededFlags({ z1:{d:'2026-11-13',gid:'AR',h:'M1',a:'V2',st:'UPCOMING',sup:'gone'} },
      { today: T }).clear.includes('z1'));

  t('sup: away side matches too', RR.computeSupersededFlags({
      a1:{d:'2026-11-13',gid:'AR',a:'TA',h:'ZZ',st:'UPCOMING'},
      a2:{d:'2026-11-13',gid:'A', a:'TA',h:'YY',hs:5,as:6,st:'FINAL'} }, { today: T }).set.size === 1);
  t('sup: t1/t2 shape matches too', RR.computeSupersededFlags({
      b1:{d:'2026-11-13',gid:'AR',t1:'TB',t2:'ZZ',st:'UPCOMING'},
      b2:{d:'2026-11-13',gid:'A', t1:'TB',t2:'YY',hs:5,as:6,st:'FINAL'} }, { today: T }).set.size === 1);
  t('sup: undated game ignored',
    RR.computeSupersededFlags({ u1:{gid:'AR',h:'M1',st:'UPCOMING'} }, { today: T }).set.size === 0);
  t('sup: empty file -> nothing', (() => {
      const e = RR.computeSupersededFlags({}, { today: T });
      return e.set.size === 0 && e.clear.length === 0; })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
