// scripts/diagnose-redundancy.js
//
// Deep dive into all major data folders to identify redundant, always-null,
// always-zero, and duplicated data patterns across the full dataset.
//
// Folders analysed:
//   players/     — player files (full scan)
//   games/bv/    — game files (full scan)
//   leaderboard/ — season leaderboard files (sample)
//   team-stats/  — team stats files (sample)
//
// Usage:
//   node scripts/diagnose-redundancy.js

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const LB_DIR      = path.join(ROOT, 'leaderboard', 'season');
const TEAMSTATS_DIR = path.join(ROOT, 'team-stats', 'bv');
const LOOKUP_DIR  = path.join(ROOT, 'team-lookup');

const GAME_SAMPLE  = 50;  // game files to fully scan
const LB_SAMPLE    = 20;  // leaderboard season files to sample
const TS_SAMPLE    = 20;  // team-stats files to sample

function pct(n, d) { return d > 0 ? (n/d*100).toFixed(1)+'%' : 'n/a'; }
function fmt(n) { return n.toLocaleString(); }

// ── SECTION 1: Player files ───────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log('1. PLAYER FILES (full scan)');
console.log('═'.repeat(70));

const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();

let P = 0, S = 0, R = 0;

// Player fields
const pf = { uuid:0, name:0, gender:0, gameTids:0 };

// Season fields
const sf = { sn:0, club:0, sport:0, sportValues: new Map() };

// Reg fields
const rf = { tid:0, tn:0, gid:0, gn:0, age:0,
  div_present:0, div_null:0, div_nonNull:0 };

// Reg stat fields
const RS_FIELDS = ['gp','pts','fg','ft','threePt','fouls','foulOuts','finals','gfApps','gfWins','wins','losses','draws'];
const rs = {}; for (const f of RS_FIELDS) rs[f] = {present:0,zero:0,nonzero:0,absent:0};

// Career stat fields
const CS_FIELDS = ['gp','pts','fg','ft','threePt','fouls','foulOuts','maxGamePTS','maxGameThreePt','finals','gfApps','gfWins','finalsPerSeason','wins','losses','draws','winPct','statsChecked'];
const cs = {}; for (const f of CS_FIELDS) cs[f] = {present:0,zero:0,null_:0,absent:0};

for (const prefix of prefixes) {
  const dir = path.join(PLAYERS_DIR, prefix);
  for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
    let player; try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
    P++;
    if (P % 50000 === 0) process.stdout.write(`  ${fmt(P)} players…\r`);

    if ('uuid'    in player) pf.uuid++;
    if ('name'    in player) pf.name++;
    if ('gender'  in player) pf.gender++;
    if (player.gameTids)      pf.gameTids++;

    const bk = player.sports?.Basketball;
    for (const f of CS_FIELDS) {
      if (!bk || !(f in bk)) { cs[f].absent++; continue; }
      cs[f].present++;
      const v = bk[f];
      if (v === null) cs[f].null_++;
      else if (v === 0 || v === '0') cs[f].zero++;
    }

    for (const season of (player.seasons || [])) {
      S++;
      if ('sn'   in season) sf.sn++;
      if ('club' in season) sf.club++;
      if ('sport' in season) {
        sf.sport++;
        const v = season.sport || '(null)';
        sf.sportValues.set(v, (sf.sportValues.get(v)||0)+1);
      }
      for (const reg of (season.regs || [])) {
        R++;
        if ('tid' in reg) rf.tid++;
        if ('tn'  in reg) rf.tn++;
        if ('gid' in reg) rf.gid++;
        if ('gn'  in reg) rf.gn++;
        if ('age' in reg) rf.age++;
        if ('div' in reg) {
          rf.div_present++;
          if (reg.div === null || reg.div === undefined) rf.div_null++; else rf.div_nonNull++;
        }
        for (const f of RS_FIELDS) {
          if (!reg.stats || !(f in reg.stats)) { rs[f].absent++; continue; }
          rs[f].present++;
          if (reg.stats[f] === 0) rs[f].zero++; else rs[f].nonzero++;
        }
      }
    }
  }
}

console.log(`\n  Players: ${fmt(P)}  Seasons: ${fmt(S)}  Regs: ${fmt(R)}\n`);

console.log('  Player-level fields:');
console.log(`    uuid     ${pct(pf.uuid,P).padStart(7)}  — same as filename`);
console.log(`    name     ${pct(pf.name,P).padStart(7)}`);
console.log(`    gender   ${pct(pf.gender,P).padStart(7)}`);
console.log(`    gameTids ${pct(pf.gameTids,P).padStart(7)}  — per-game tid map for ambiguous players`);

console.log('\n  Season-level fields:');
console.log(`    sn       ${pct(sf.sn,S).padStart(7)}  — season name (in sports-index)`);
console.log(`    club     ${pct(sf.club,S).padStart(7)}  — club name (in team-lookup)`);
console.log(`    sport    ${pct(sf.sport,S).padStart(7)}  — values: ${[...sf.sportValues.entries()].map(([v,n])=>`${v}(${fmt(n)})`).join(', ')}`);

console.log('\n  Reg-level fields:');
console.log(`    tid      ${pct(rf.tid,R).padStart(7)}`);
console.log(`    tn       ${pct(rf.tn,R).padStart(7)}  — team name (in team-lookup)`);
console.log(`    gid      ${pct(rf.gid,R).padStart(7)}  — grade id (in team-lookup)`);
console.log(`    gn       ${pct(rf.gn,R).padStart(7)}  — grade name (in team-lookup)`);
console.log(`    age      ${pct(rf.age,R).padStart(7)}  — age group (in team-lookup)`);
console.log(`    div      ${pct(rf.div_present,R).padStart(7)}  — null: ${pct(rf.div_null,rf.div_present)}  non-null: ${pct(rf.div_nonNull,rf.div_present)}`);

console.log('\n  Reg stat fields (% of all regs):');
console.log(`    ${'field'.padEnd(12)} ${'present'.padStart(8)} ${'=0'.padStart(8)} ${'≠0'.padStart(8)} ${'absent'.padStart(8)}`);
for (const f of RS_FIELDS) {
  const c = rs[f];
  console.log(`    ${f.padEnd(12)} ${pct(c.present,R).padStart(8)} ${pct(c.zero,R).padStart(8)} ${pct(c.nonzero,R).padStart(8)} ${pct(c.absent,R).padStart(8)}`);
}

console.log('\n  Career stat fields (% of all players):');
console.log(`    ${'field'.padEnd(18)} ${'present'.padStart(8)} ${'=0'.padStart(8)} ${'null'.padStart(8)} ${'absent'.padStart(8)}`);
for (const f of CS_FIELDS) {
  const c = cs[f];
  console.log(`    ${f.padEnd(18)} ${pct(c.present,P).padStart(8)} ${pct(c.zero,P).padStart(8)} ${pct(c.null_,P).padStart(8)} ${pct(c.absent,P).padStart(8)}`);
}

// ── SECTION 2: Game files ─────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log(`2. GAME FILES (sample of ${GAME_SAMPLE} season files)`);
console.log('═'.repeat(70));

const gameFileList = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).slice(0, GAME_SAMPLE);
let GF = 0, G = 0;
const gf_fields = {};
const p_fields  = { id:0, n:0, total:0 };
const hp_fields = { profileID:0, pts:0, pt1:0, pt2:0, pt3:0, fouls:0, total:0 };
let hasHpAp = 0, pOnly = 0, neither = 0;

for (const fname of gameFileList) {
  let gf; try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); } catch { continue; }
  GF++;
  for (const g of Object.values(gf.games || {})) {
    G++;
    // Top-level game fields
    for (const k of Object.keys(g)) {
      gf_fields[k] = (gf_fields[k]||0) + 1;
    }
    // p[] fields
    for (const p of (g.p||[])) {
      p_fields.total++;
      if ('id' in p) p_fields.id++;
      if ('n'  in p) p_fields.n++;
    }
    // hp[]/ap[] fields
    for (const p of [...(g.hp||[]), ...(g.ap||[])]) {
      hp_fields.total++;
      if ('profileID' in p) hp_fields.profileID++;
      if ('pts'  in p) hp_fields.pts++;
      if ('pt1'  in p) hp_fields.pt1++;
      if ('pt2'  in p) hp_fields.pt2++;
      if ('pt3'  in p) hp_fields.pt3++;
      if ('fouls' in p) hp_fields.fouls++;
    }
    const hh = (g.hp?.length||0) + (g.ap?.length||0);
    if (hh > 0) hasHpAp++;
    else if (g.p?.length > 0) pOnly++;
    else neither++;
  }
}

console.log(`\n  Season files sampled: ${GF}  Games: ${fmt(G)}`);
console.log(`  hp/ap present: ${pct(hasHpAp,G)}  p[] only: ${pct(pOnly,G)}  neither: ${pct(neither,G)}`);
console.log('\n  Top-level game fields (% of games):');
const sortedGfFields = Object.entries(gf_fields).sort((a,b)=>b[1]-a[1]);
for (const [k,n] of sortedGfFields) {
  console.log(`    ${k.padEnd(16)} ${pct(n,G).padStart(8)}`);
}
console.log(`\n  p[] entries: ${fmt(p_fields.total)}`);
console.log(`    id present: ${pct(p_fields.id,p_fields.total)}  n present: ${pct(p_fields.n,p_fields.total)}`);
console.log(`\n  hp[]/ap[] entries: ${fmt(hp_fields.total)}`);
for (const f of ['profileID','pts','pt1','pt2','pt3','fouls']) {
  console.log(`    ${f.padEnd(12)} ${pct(hp_fields[f],hp_fields.total).padStart(8)}`);
}

// ── SECTION 3: Leaderboard season files ───────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log(`3. LEADERBOARD SEASON FILES (sample of ${LB_SAMPLE})`);
console.log('═'.repeat(70));

const lbFiles = fs.readdirSync(LB_DIR).filter(f => f.endsWith('.json')).slice(0, LB_SAMPLE);
let LB = 0, lbEntries = 0;
const lbPlayerFields = {};
let lbIdHasTid = 0, lbIdHasSid = 0;

for (const fname of lbFiles) {
  let lb; try { lb = JSON.parse(fs.readFileSync(path.join(LB_DIR, fname), 'utf8')); } catch { continue; }
  LB++;
  // Sample first category
  const firstCat = Object.values(lb).find(v => Array.isArray(v));
  if (firstCat) {
    for (const e of firstCat) {
      lbEntries++;
      const parts = (e.id||'').split('|');
      if (parts.length >= 2) lbIdHasTid++;
      if (parts.length >= 3) lbIdHasSid++;
    }
  }
  if (lb.players) {
    for (const p of Object.values(lb.players)) {
      for (const k of Object.keys(p)) {
        lbPlayerFields[k] = (lbPlayerFields[k]||0) + 1;
      }
    }
  }
}

console.log(`\n  Files sampled: ${LB}  Entries in first cat: ${fmt(lbEntries)}`);
console.log(`  id has |tid suffix: ${pct(lbIdHasTid,lbEntries)}  id has |sid suffix: ${pct(lbIdHasSid,lbEntries)}`);
console.log('  players map fields:');
const totalPlayers = Object.values(lbPlayerFields).reduce((a,b)=>a+b,0)/Object.keys(lbPlayerFields).length||1;
for (const [k,n] of Object.entries(lbPlayerFields).sort((a,b)=>b[1]-a[1])) {
  console.log(`    ${k.padEnd(14)} present in ~${pct(n,totalPlayers)}`);
}

// ── SECTION 4: Team-stats files ───────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log(`4. TEAM-STATS FILES (sample of ${TS_SAMPLE})`);
console.log('═'.repeat(70));

const tsFiles = fs.readdirSync(TEAMSTATS_DIR).filter(f => f.endsWith('.json')).slice(0, TS_SAMPLE);
let TS = 0, tsTeams = 0, tsRosters = 0, tsFixtures = 0;
const tsTeamFields = {}, tsRosterFields = {}, tsFixtureFields = {};

for (const fname of tsFiles) {
  let ts; try { ts = JSON.parse(fs.readFileSync(path.join(TEAMSTATS_DIR, fname), 'utf8')); } catch { continue; }
  TS++;
  for (const team of Object.values(ts)) {
    tsTeams++;
    for (const k of Object.keys(team)) tsTeamFields[k] = (tsTeamFields[k]||0)+1;
    const roster = team.roster;
    if (roster && typeof roster === 'object') {
      const rosterEntries = Array.isArray(roster) ? roster : Object.values(roster);
      for (const r of rosterEntries) {
        tsRosters++;
        for (const k of Object.keys(r)) tsRosterFields[k] = (tsRosterFields[k]||0)+1;
      }
    }
    const fixtures = team.fixtures;
    if (fixtures && typeof fixtures === 'object') {
      const fixtureEntries = Array.isArray(fixtures) ? fixtures : Object.values(fixtures);
      for (const fx of fixtureEntries) {
        tsFixtures++;
        for (const k of Object.keys(fx)) tsFixtureFields[k] = (tsFixtureFields[k]||0)+1;
      }
    }
  }
}

console.log(`\n  Files sampled: ${TS}  Teams: ${fmt(tsTeams)}  Roster entries: ${fmt(tsRosters)}  Fixtures: ${fmt(tsFixtures)}`);
console.log('  Team-level fields:');
for (const [k,n] of Object.entries(tsTeamFields).sort((a,b)=>b[1]-a[1])) {
  console.log(`    ${k.padEnd(16)} ${pct(n,tsTeams).padStart(8)}`);
}
console.log('  Roster entry fields:');
for (const [k,n] of Object.entries(tsRosterFields).sort((a,b)=>b[1]-a[1])) {
  console.log(`    ${k.padEnd(16)} ${pct(n,tsRosters).padStart(8)}`);
}
console.log('  Fixture entry fields:');
for (const [k,n] of Object.entries(tsFixtureFields).sort((a,b)=>b[1]-a[1])) {
  console.log(`    ${k.padEnd(16)} ${pct(n,tsFixtures).padStart(8)}`);
}

console.log('\n' + '═'.repeat(70));
console.log('Done.');
console.log('═'.repeat(70));
