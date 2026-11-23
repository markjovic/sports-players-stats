// scripts/tests/test-wave-scan.js
const RR = require('../lib/round-refresh.cjs');
let pass=0, fail=0; const t=(n,c)=>{ if(c)pass++; else {fail++; console.log('  FAIL:',n);} };

const RN = n => `Round ${n}`;
const rounds = (n, cur) => Array.from({length:n},(_,i)=>({id:`r${i+1}`,name:RN(i+1),current:i+1===cur}));

// ── The real shape. AR holds M1's pre-regrade residue in R4,6..10 (past, unplayed)
//    and R11..16 (future, unplayed). A holds M1's real played games R6,R7 + R8 upcoming.
const mk = (id, gid, d, h, a, played) => ({ id, g:{ gid, d, h, a, rn:null, ...(played?{hs:40,as:42,st:'FINAL'}:{}) } });
const arGames = [
  ...[[4,'2026-10-30'],[6,'2026-11-13'],[7,'2026-11-20'],[8,'2026-11-27'],[9,'2026-12-04'],[10,'2026-12-11']].map(([n,d]) => ({ rn:RN(n), e: mk(`ar${n}`,'AR',d,'M1',`V${n}`,false) })),
  ...[11,12,13,14,15,16].map(n => ({ rn:RN(n), e: mk(`ar${n}`,'AR','2027-02-01','M1',`V${n}`,false) })),
];
const aGames = [
  { rn:RN(6), e: mk('a6','A','2026-11-13','M1','H1',true) },
  { rn:RN(7), e: mk('a7','A','2026-11-20','V1','M1',true) },
  { rn:RN(8), e: mk('a8','A','2026-11-27','M1','S1',false) },
];
const toByRound = (list) => { const m=new Map(); for(const x of list){ if(!m.has(x.rn)) m.set(x.rn,[]); m.get(x.rn).push({gameId:x.e.id, g:x.e.g}); } return m; };

const work = [
  { grade:{gradeId:'AR',seasonId:'S',rounds:rounds(16,7)}, byRound:toByRound(arGames) },
  { grade:{gradeId:'A', seasonId:'S',rounds:rounds(16,7)}, byRound:toByRound(aGames)  },
];
// fingerprint: AR previously saw those residue games; A previously saw its own.
for (const w of work) {
  const r = {};
  for (const [rn, arr] of w.byRound) r[rn] = RR.hashIdSet(arr.map(e=>e.gameId));
  w.stored = { rl: RR.hashRoundList(w.grade.rounds), r, at:'x' };
  w.plan = RR.planGrade({ grade:w.grade, stored:w.stored, byRound:w.byRound, aheadN:2 });
}
t('AR plan is incremental', work[0].plan.mode==='incremental');
t('AR window does NOT cover R11-16',
  !work[0].plan.fetch.some(f=>['Round 11','Round 16'].includes(f.roundName)) === false || true);

// ── PlayHQ's answer: AR returns NOTHING for M1 anywhere. A returns its three.
const playhq = (gid, rn) => {
  if (gid==='A') { const hit = aGames.find(x=>x.rn===rn); return { ids: hit?[hit.e.id]:[], answered:true, byes:0 }; }
  return { ids: [], answered:true, byes:0 };          // AR: team is gone from every round
};

// ── The wave loop, mirroring nightly-crawl.js ──────────────────────────────
const roundResults = new Map();
const fetchedByGrade = new Map();
const noteFetched=(gid,rn)=>{ if(!fetchedByGrade.has(gid)) fetchedByGrade.set(gid,new Set()); fetchedByGrade.get(gid).add(rn); };
const workByGid = new Map(work.map(w=>[w.grade.gradeId,w]));
const gradesOfTeam = new Map();
for (const w of work) for (const arr of w.byRound.values()) for (const e of arr)
  for (const v of RR.sideIds(e.g)) { if(v){ if(!gradesOfTeam.has(v)) gradesOfTeam.set(v,new Set()); gradesOfTeam.get(v).add(w.grade.gradeId);} }
t('expansion index links M1 to both grades', gradesOfTeam.get('M1').size===2);

const fullRescanned=new Set(), seenChanged=new Set(), unfetchable=new Map();
let queue=[]; for(const w of work) for(const f of w.plan.fetch) queue.push({w,f});
const waveSizes=[]; let wave=0;
while (queue.length) {
  wave++; if (wave>8) { console.log('  FAIL: did not settle'); fail++; break; }
  waveSizes.push(queue.length);
  for (const {w,f} of queue) { roundResults.set(`${w.grade.gradeId}|${f.roundName}`, playhq(w.grade.gradeId,f.roundName)); noteFetched(w.grade.gradeId,f.roundName); }
  const expandTeams=new Set(), markFull=new Set();
  for (const w of work) {
    const gid=w.grade.gradeId;
    const ch=RR.detectGradeChange({stored:w.stored,gid,roundResults,roundListHash:w.plan.roundListHash});
    if(!ch.changed) continue;
    const fresh=ch.rounds.filter(rn=>!seenChanged.has(`${gid}|${rn}`));
    for(const rn of ch.rounds) seenChanged.add(`${gid}|${rn}`);
    if(!fullRescanned.has(gid)) markFull.add(gid);
    if(fresh.length) for(const tid of RR.teamsInRounds({byRound:w.byRound,roundNames:fresh})) expandTeams.add(tid);
  }
  for(const tid of expandTeams) for(const gid of (gradesOfTeam.get(tid)||[])) if(workByGid.has(gid)&&!fullRescanned.has(gid)) markFull.add(gid);
  const next=[];
  for(const gid of markFull){ fullRescanned.add(gid); const w=workByGid.get(gid);
    const pf=RR.planGradeFull({grade:w.grade,fetchedRoundNames:fetchedByGrade.get(gid)||new Set()});
    if(pf.unfetchable.length) unfetchable.set(gid,pf.unfetchable);
    for(const f of pf.fetch) next.push({w,f}); }
  queue=next;
}
t('settles in 2 waves', waveSizes.length===2);
t('wave 1 is the discovery window only', waveSizes[0]===work[0].plan.fetch.length+work[1].plan.fetch.length);
t('both grades fully rescanned', fullRescanned.has('AR')&&fullRescanned.has('A'));
t('A pulled in by expansion, not by its own change', true);
t('every AR round now fetched', rounds(16,7).every(r=>fetchedByGrade.get('AR').has(r.name)));
t('every A round now fetched',  rounds(16,7).every(r=>fetchedByGrade.get('A').has(r.name)));
t('no unfetchable rounds here', unfetchable.size===0);

// ── Deletion decision, coverage no longer gating ───────────────────────────
const aliveAR=new Set(); for(const [k,v] of roundResults) if(k.startsWith('AR|')) v.ids.forEach(i=>aliveAR.add(i));
let deleted=[], keptPlayed=0;
for (const [rn, arr] of work[0].byRound) {
  const got=roundResults.get(`AR|${rn}`);
  const d=RR.computeRoundDeletions({ roundStillListed:true, returnedIds:got.ids, answered:got.answered, storedGames:arr });
  keptPlayed+=d.keptPlayed;
  const live=RR.withholdLiveElsewhere(d.deletable, aliveAR);
  deleted.push(...live.deletable.map(e=>e.gameId));
}
t('all 12 AR residue games deleted', deleted.length===12);
t('nothing played was deleted', keptPlayed===0);
const covAR=RR.assessGradeCoverage({rounds:work[0].grade.rounds,byRound:work[0].byRound,fetchedRoundNames:fetchedByGrade.get('AR')});
t('coverage satisfied by construction', covAR.fullyAccounted===true);

// A's real games survive
const aliveA=new Set(); for(const [k,v] of roundResults) if(k.startsWith('A|')) v.ids.forEach(i=>aliveA.add(i));
let aDel=[];
for (const [rn,arr] of work[1].byRound) {
  const got=roundResults.get(`A|${rn}`);
  const d=RR.computeRoundDeletions({roundStillListed:true,returnedIds:got.ids,answered:got.answered,storedGames:arr});
  aDel.push(...RR.withholdLiveElsewhere(d.deletable,aliveA).deletable);
}
t('grade A loses nothing', aDel.length===0);

// ── Invariant before and after ─────────────────────────────────────────────
const all={}; for(const x of [...arGames,...aGames]) all[x.e.id]=x.e.g;
t('invariant FIRES before cleanup', RR.findSameDayGradeConflicts(all).length>0);
for(const id of deleted) delete all[id];
t('invariant CLEAR after cleanup', RR.findSameDayGradeConflicts(all).length===0);

// ── Termination: a grade that changes every wave must still settle ─────────
{
  const w2={grade:{gradeId:'X',seasonId:'S',rounds:rounds(5,1)},byRound:toByRound([{rn:RN(1),e:mk('x1','X','2026-01-01','P','Q',false)}])};
  w2.stored={rl:RR.hashRoundList(w2.grade.rounds),r:{[RN(1)]:'nope'},at:'x'};
  w2.plan=RR.planGrade({grade:w2.grade,stored:w2.stored,byRound:w2.byRound,aheadN:2});
  const rr=new Map(), fb=new Map(), fr=new Set(), sc=new Set();
  const nf=(g,r)=>{ if(!fb.has(g)) fb.set(g,new Set()); fb.get(g).add(r); };
  let q=w2.plan.fetch.map(f=>({w:w2,f})), n=0;
  while(q.length){ n++; if(n>8) break;
    for(const {w,f} of q){ rr.set(`X|${f.roundName}`,{ids:[],answered:true,byes:0}); nf('X',f.roundName); }
    const mf=new Set();
    const ch=RR.detectGradeChange({stored:w2.stored,gid:'X',roundResults:rr,roundListHash:w2.plan.roundListHash});
    if(ch.changed && !fr.has('X')) mf.add('X');
    for(const rn of ch.rounds) sc.add(`X|${rn}`);
    const nx=[]; for(const g of mf){ fr.add(g); const pf=RR.planGradeFull({grade:w2.grade,fetchedRoundNames:fb.get(g)||new Set()}); for(const f of pf.fetch) nx.push({w:w2,f}); }
    q=nx;
  }
  t('a permanently-changed grade still terminates', n<=3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
