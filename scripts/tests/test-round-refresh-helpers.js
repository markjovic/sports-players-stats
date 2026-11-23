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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
