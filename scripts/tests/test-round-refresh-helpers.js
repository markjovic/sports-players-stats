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

// ─── Dead grades: the Friday U11 Boys AR shape ─────────────────────────────
{
  const TODAY = '2026-11-24';
  const G = {
    // AR: five games, all PENDING, all dated in the past, nothing ever played
    ar1:{d:'2026-10-09',gid:'AR',gn:'Friday U11 Boys AR',h:'RAPT',hn:'Raptors 1',a:'MM1',an:'Magic 1',st:'PENDING'},
    ar2:{d:'2026-10-16',gid:'AR',gn:'Friday U11 Boys AR',h:'RAPT',hn:'Raptors 1',a:'EB1',an:'E.Bees 1',st:'PENDING'},
    ar3:{d:'2026-10-23',gid:'AR',gn:'Friday U11 Boys AR',h:'RAPT',hn:'Raptors 1',a:'VH1',an:'Hoopers 1',st:'PENDING'},
    ar4:{d:'2026-11-06',gid:'AR',gn:'Friday U11 Boys AR',h:'MM1',hn:'Magic 1',a:'WPS',an:'Saints 1',st:'PENDING'},
    ar5:{d:'2027-02-05',gid:'AR',gn:'Friday U11 Boys AR',h:'RAPT',hn:'Raptors 1',a:'WAV',an:'Waverley 1',st:'PENDING'},
    // B: the real grade, with real results on the same dates
    b1:{d:'2026-10-23',gid:'B',gn:'Friday U11 Boys B',h:'RAPT',hn:'Raptors 1',a:'MM3',an:'Magic 3',hs:10,as:32,st:'FINAL'},
    b2:{d:'2026-10-09',gid:'B',gn:'Friday U11 Boys B',h:'MM1',hn:'Magic 1',a:'EB1',an:'E.Bees 1',hs:40,as:38,st:'FINAL'},
    b3:{d:'2026-10-16',gid:'B',gn:'Friday U11 Boys B',h:'VH1',hn:'Hoopers 1',a:'WPS',an:'Saints 1',hs:22,as:30,st:'FINAL'},
    // A future-only grade: every game unplayed, but nothing in the past
    f1:{d:'2027-03-05',gid:'FUT',gn:'Autumn U11 A',h:'RAPT',hn:'Raptors 1',a:'MM1',an:'Magic 1',st:'PENDING'},
    f2:{d:'2027-03-12',gid:'FUT',gn:'Autumn U11 A',h:'RAPT',hn:'Raptors 1',a:'EB1',an:'E.Bees 1',st:'PENDING'},
  };
  const dead = RR.findDeadGrades(G, { today: TODAY });
  const ar = dead.find(d => d.gid === 'AR');
  t('dead: AR detected', !!ar);
  t('dead: counts all its games', ar && ar.games === 5);
  t('dead: counts only past-dated ones separately', ar && ar.pastGames === 4);
  t('dead: carries the grade name', ar && ar.gn === 'Friday U11 Boys AR');
  t('dead: date range reported', ar && ar.firstDate === '2026-10-09' && ar.lastDate === '2027-02-05');
  t('dead: corroborated by teams playing elsewhere', ar && ar.teamsAlsoElsewhere >= 4);
  t('dead: the real grade is NOT dead', !dead.some(d => d.gid === 'B'));
  t('dead: a future-only grade is NOT dead', !dead.some(d => d.gid === 'FUT'));
  t('dead: one played game clears a grade',
    !RR.findDeadGrades({ ...G, ar1:{...G.ar1, hs:1, as:2, st:'FINAL'} }, { today: TODAY }).some(d => d.gid === 'AR'));
  t('dead: undated grade is not judged',
    RR.findDeadGrades({ u1:{gid:'U',h:'T1',st:'PENDING'} }, { today: TODAY }).length === 0);
  t('dead: sorted by size', dead.length < 2 || dead[0].games >= dead[dead.length-1].games);
  t('dead: no games at all -> nothing', RR.findDeadGrades({}, { today: TODAY }).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
