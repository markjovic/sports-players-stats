// scripts/tests/make-sup-fixtures.js
// REVISION 2026-11-24a — first version.
//
// Regenerates scripts/tests/fixtures/{games-bv-sup,team-stats-bv-sup}.json by
// running the REAL build-team-stats.js over a repository-shaped temp tree.
//
// WHY IT EXISTS. render-test-sup-consumers.js asserts how the UI renders a
// superseded fixture. If its input were hand-written, it would assert how the UI
// renders what someone BELIEVES the builder writes - which is T103 exactly. The
// fixture is therefore the builder's own output, and the two halves of the change
// are tested against each other.
//
// `git` is stubbed on PATH so gitCommit stops at "nothing staged" instead of
// entering its 60-attempt push loop. No network. Nothing is written outside the
// temp dir and scripts/tests/fixtures/.
//
// Run:  node scripts/tests/make-sup-fixtures.js            (repo root inferred)
//       node scripts/tests/make-sup-fixtures.js <repo>

'use strict';
const fs=require('fs'), os=require('os'), path=require('path'), {execFileSync}=require('child_process');
const REPO=process.argv[2]||path.join(__dirname,'..','..'), SID='tst00001';
const GAMES={
  g_played:{d:'2026-11-13',t:'18:30',gid:'GR_A',gn:'Friday U11 Boys A',h:'TEAM1',hn:'B11 Test 1',a:'TEAM2',an:'B11 Test 2',st:'FINAL',hs:40,as:30,rn:'Round 6',vn:'Test Stadium',ct:'Court 1'},
  g_sup:{d:'2026-11-13',t:'19:30',gid:'GR_AR',gn:'Friday U11 Boys AR',h:'TEAM1',hn:'B11 Test 1',a:'TEAM3',an:'B11 Test 3',st:'UPCOMING',rn:'Round 6',vn:'Test Stadium',ct:'Court 2',sup:'g_played'},
  g_prev:{d:'2026-11-06',t:'18:30',gid:'GR_A',gn:'Friday U11 Boys A',h:'TEAM2',hn:'B11 Test 2',a:'TEAM1',an:'B11 Test 1',st:'FINAL',hs:25,as:31,rn:'Round 5',vn:'Test Stadium',ct:'Court 1'},
  g_future:{d:'2026-12-04',t:'18:30',gid:'GR_A',gn:'Friday U11 Boys A',h:'TEAM2',hn:'B11 Test 2',a:'TEAM1',an:'B11 Test 1',st:'UPCOMING',rn:'Round 9',vn:'Test Stadium',ct:'Court 1'},
};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mkfix-'));
fs.mkdirSync(path.join(root,'scripts','lib'),{recursive:true});
fs.mkdirSync(path.join(root,'data'),{recursive:true});
fs.mkdirSync(path.join(root,'games','bv'),{recursive:true});
fs.mkdirSync(path.join(root,'players','indexes'),{recursive:true});
fs.copyFileSync(path.join(REPO,'scripts','build-team-stats.js'),path.join(root,'scripts','build-team-stats.js'));
for(const f of fs.readdirSync(path.join(REPO,'scripts','lib'))) fs.copyFileSync(path.join(REPO,'scripts','lib',f),path.join(root,'scripts','lib',f));
fs.writeFileSync(path.join(root,'data','sports-index.json'),JSON.stringify({seasons:{[SID]:{id:SID,name:'Test Season',fullName:'Test Season',compName:'Test',orgName:'Test Org',locked:false,grades:[{id:'GR_A',name:'Friday U11 Boys A',age:'Under 11',gender:'Boys'},{id:'GR_AR',name:'Friday U11 Boys AR',age:'Under 11',gender:'Boys'}]}}}));
fs.writeFileSync(path.join(root,'games','bv',SID+'.json'),JSON.stringify({games:GAMES}));
const stub=path.join(root,'stub'); fs.mkdirSync(stub); fs.writeFileSync(path.join(stub,'git'),'#!/bin/sh\nexit 0\n',{mode:0o755});
const out=execFileSync(process.execPath,[path.join(root,'scripts','build-team-stats.js'),'--season='+SID],{cwd:root,env:{...process.env,PATH:stub+':'+process.env.PATH},encoding:'utf8'});
console.log(out.split('\n').filter(l=>/sup:|grade from|not known|ties/.test(l)).join('\n'));
const ts=fs.readFileSync(path.join(root,'team-stats','bv',SID+'.json'),'utf8');
fs.writeFileSync(path.join(REPO,'scripts','tests','fixtures','games-bv-sup.json'),JSON.stringify({games:GAMES},null,1));
fs.writeFileSync(path.join(REPO,'scripts','tests','fixtures','team-stats-bv-sup.json'),ts);
fs.rmSync(root,{recursive:true,force:true});
console.log('\nwrote scripts/tests/fixtures/games-bv-sup.json and team-stats-bv-sup.json');
console.log('TEAM1 fixtures:',JSON.stringify(JSON.parse(ts).TEAM1.fixtures));
console.log('TEAM1 meta    :',JSON.stringify(JSON.parse(ts).TEAM1.meta));
