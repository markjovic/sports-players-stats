// scripts/probe-club-movement.js
// VERSION 2 — REPLACES the version 1 file of the same name. Version 1 settled the season axis
// and the file shapes and has nothing left to tell us; it is gone, not merged. The first line
// this prints names the version, so a log makes it obvious which code ran (trap T54).
//
// READ-ONLY. Writes nothing, no network calls. It answers:
//   1. which seasons the chosen COMPETITION runs, with team counts and meta.club fill rate
//   2. the real club inventory — meta.club values AND leading team-name tokens, side by side
//   3. which age groups the competition runs, and how many teams each has per season
//   4. whether a finishing POSITION can be derived from the fixtures already on disk
//   5. how age groups actually progress season to season, measured from players rather than assumed
//   6. what seasons[].club means in a player file (association, or the club entering the team)
//
// Section 5 is the one that decides the ageing-out rule. Age is assessed before each season and
// the seasons are not calendar-aligned, so the netball rule (read a calendar year off the season
// label, two-year band) cannot be carried over. This measures the real behaviour instead.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- configuration
const COMP_ID      = process.env.COMP_ID || 'f0c4ccaa';   // Kilsyth Junior Domestic
const ORG_MATCH    = new RegExp(process.env.ORG_MATCH || 'kilsyth', 'i');
// The club to hunt for, across EVERY season of the competition rather than a recent slice.
// Several spellings on purpose: a club's team names are not its name.
const CLUB_MATCH   = new RegExp(process.env.CLUB_MATCH || 'mmb|maroondah|magic', 'i');
const DEEP_SEASONS = 8;      // most recent seasons of that competition to open team-stats for
const CLUB_ROWS    = 90;     // club inventory rows to print
const SAMPLE_PLAYERS = 700;  // players to resolve for the age-progression measurement
const TRUNC_LEN    = 13;

const problems = [];
const note = (m) => { problems.push(m); };
const hr = (t) => console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));
const cut = (s, n) => { const t = JSON.stringify(s); return t.length > n ? t.slice(0, n) + '…' : t; };
const pad = (s, n) => String(s === null || s === undefined ? '—' : s).padEnd(n);

function readJson(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return { ok: false, why: 'ENOENT' };
  try { return { ok: true, data: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { ok: false, why: 'PARSE: ' + e.message }; }
}

console.log('\n#############################################################################');
console.log('###  PROBE CLUB MOVEMENT — VERSION 2 (clubs · age bands · ladder · progression)');
console.log('###  If this banner is absent, an older copy of the script ran.');
console.log('#############################################################################');

const idxR = readJson('data/sports-index.json');
if (!idxR.ok) { console.error(`CANNOT READ data/sports-index.json (${idxR.why})`); process.exit(1); }
const sObj = idxR.data.seasons;
const ALL = Array.isArray(sObj) ? sObj : Object.values(sObj);
const SEASON = {}; ALL.forEach(s => { SEASON[s.id] = s; });

// grade id -> {age, gender, name} for every season, so a reg's gid resolves to an age band
const GRADE = {};
ALL.forEach(s => (s.grades || []).forEach(g => { GRADE[g.id] = { age: g.age, gender: g.gender, name: g.name, sid: s.id }; }));

// ---------------------------------------------------------------- 1. the competition's seasons
hr('1. THE COMPETITION — seasons, teams, meta.club fill rate');
const comp = ALL.filter(s => String(s.compId) === COMP_ID && ORG_MATCH.test(String(s.orgName || '')));
if (!comp.length) {
  console.error(`no season with compId ${COMP_ID} and orgName matching /${ORG_MATCH.source}/i — stopping`);
  const cands = [...new Set(ALL.filter(s => ORG_MATCH.test(String(s.orgName || ''))).map(s => `${s.compId}  ${s.compName}`))].sort();
  cands.forEach(c => console.log('   ' + c));
  process.exit(1);
}
comp.sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));
console.log(`${comp[0].orgName} · ${comp[0].compName} · ${comp.length} seasons\n`);

const TS = {};   // sid -> team-stats data, for the deep seasons only
const deep = comp.slice(-DEEP_SEASONS);
console.log('  id        season                 start       status      grades  teams   meta.club set   distinct clubs');
for (const s of comp) {
  const isDeep = deep.includes(s);
  let teams = null, clubSet = null, clubs = null;
  if (isDeep) {
    const r = readJson(`team-stats/bv/${s.id}.json`);
    if (!r.ok) { note(`team-stats missing for ${s.id} (${s.name})`); }
    else {
      TS[s.id] = r.data;
      const tids = Object.keys(r.data);
      teams = tids.length;
      const cs = tids.map(t => ((r.data[t] || {}).meta || {}).club).filter(c => c && String(c).trim());
      clubSet = cs.length; clubs = new Set(cs).size;
    }
  }
  console.log(`  ${pad(s.id, 10)}${pad(s.name, 23)}${pad(String(s.startDate || '').slice(0, 10), 12)}${pad(s.status, 12)}` +
    `${pad((s.grades || []).length, 8)}${pad(teams, 8)}${pad(clubSet === null ? null : `${clubSet}`, 16)}${pad(clubs, 8)}`);
}
const anyClub = Object.values(TS).some(d => Object.values(d).some(t => ((t.meta || {}).club || '').trim()));
console.log(`\n  meta.club populated anywhere in the deep seasons: ${anyClub ? 'YES' : 'NO'}`);
// Not a problem — a FINDING. If meta.club is empty the club comes from the team name, which is
// what the netball build did too. It only becomes a problem if the name yields nothing either.

// ---------------------------------------------------------------- 2. club inventory
hr('2. CLUB INVENTORY — who actually enters teams in this competition');
// Teams are named "<Club> <grade/age token> <number>". Strip a trailing age/grade/number tail and
// take what is left as the club token. This is a PROPOSAL to be checked by eye, not a rule yet.
function clubToken(name) {
  let t = String(name || '').replace(/[’']/g, '').trim();
  t = t.replace(/\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+/i, ' ');
  // cut at the first age token (U9 / U12 / 12s) or a trailing grade/number tail
  const m = t.match(/^(.*?)\s+(?:u\s*\/?\s*\d{1,2}|\d{1,2}\s*(?:s|'s|s')\b)/i);
  if (m && m[1].trim()) return m[1].trim();
  return t.replace(/\s+[A-Z]{0,3}\d{1,3}[A-Z]?$/i, '').trim() || t;
}
const byToken = new Map(), byMetaClub = new Map(), egOf = new Map();
for (const sid of Object.keys(TS)) {
  for (const tid of Object.keys(TS[sid])) {
    const meta = TS[sid][tid].meta || {};
    const nm = meta.name || meta.n || '';
    const tok = clubToken(nm);
    if (tok) {
      byToken.set(tok, (byToken.get(tok) || 0) + 1);
      const eg = egOf.get(tok) || new Set();
      if (eg.size < 3) eg.add(nm);
      egOf.set(tok, eg);
    }
    const mc = (meta.club || '').trim();
    if (mc) byMetaClub.set(mc, (byMetaClub.get(mc) || 0) + 1);
  }
}
console.log(`distinct meta.club values: ${byMetaClub.size}`);
[...byMetaClub.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([c, n]) => console.log(`   ${String(n).padStart(5)}  ${c}`));
console.log(`\ndistinct club tokens derived from TEAM NAMES: ${byToken.size} (team-season count, across ${Object.keys(TS).length} seasons)`);
[...byToken.entries()].sort((a, b) => b[1] - a[1]).slice(0, CLUB_ROWS)
  .forEach(([c, n]) => console.log(`   ${String(n).padStart(5)}  ${pad(c, 26)} e.g. ${[...(egOf.get(c) || [])].join(' | ')}`));
if (byToken.size > CLUB_ROWS) console.log(`   … +${byToken.size - CLUB_ROWS} more tokens (long tail — likely one-off name variants)`);

// ---- 2b. the named club, hunted across EVERY season of the competition ----------------------
// Not a recent slice: a club absent from the last few seasons is a finding about those seasons,
// never a finding about the club.
console.log(`\n--- teams matching /${CLUB_MATCH.source}/i across ALL ${comp.length} seasons ---`);
const hits = [];
for (const s of comp) {
  const d = TS[s.id] || (readJson(`team-stats/bv/${s.id}.json`).data) || null;
  if (!d) { continue; }
  for (const tid of Object.keys(d)) {
    const meta = d[tid].meta || {};
    const nm = meta.name || meta.n || '';
    if (CLUB_MATCH.test(nm) || CLUB_MATCH.test(meta.club || '')) {
      hits.push({ s, tid, nm, grade: meta.grade, gid: meta.gid,
                  age: (GRADE[meta.gid] || {}).age, n: Object.keys(d[tid].roster || {}).length });
    }
  }
}
console.log(`matches: ${hits.length}`);
if (!hits.length) {
  note(`no team matched /${CLUB_MATCH.source}/i in any season — widen CLUB_MATCH, the club trades under another name here`);
} else {
  console.log('  season                 age    team                                 grade                          roster');
  hits.slice(0, 120).forEach(h => console.log(
    `  ${pad(h.s.name, 23)}${pad(h.age, 7)}${pad(String(h.nm).slice(0, 36), 37)}${pad(String(h.grade || '').slice(0, 30), 31)}${h.n}`));
  if (hits.length > 120) console.log(`  … +${hits.length - 120} more`);
  const seasonsHit = [...new Set(hits.map(h => h.s.name))];
  const agesHit = [...new Set(hits.map(h => h.age).filter(Boolean))]
    .sort((a, b) => (parseInt(String(a).replace(/\D/g, '') || '99') - parseInt(String(b).replace(/\D/g, '') || '99')));
  console.log(`\n  seasons with at least one such team: ${seasonsHit.length} of ${comp.length}`);
  console.log(`  age groups they field teams in: ${JSON.stringify(agesHit)}`);
  console.log(`  distinct team names: ${cut([...new Set(hits.map(h => h.nm))].slice(0, 40), 1600)}`);
  console.log(`  club token(s) those names reduce to: ${JSON.stringify([...new Set(hits.map(h => clubToken(h.nm)))])}`);
}

// ---------------------------------------------------------------- 3. age groups
hr('3. AGE GROUPS — what this competition runs, and how big each is');
const ages = [...new Set(comp.flatMap(s => (s.grades || []).map(g => g.age)).filter(Boolean))]
  .sort((a, b) => (parseInt(String(a).replace(/\D/g, '') || '99') - parseInt(String(b).replace(/\D/g, '') || '99')));
console.log(`distinct grade.age values: ${JSON.stringify(ages)}\n`);
const recent = deep.filter(s => TS[s.id]);
console.log('  age    ' + recent.map(s => pad(s.name.slice(0, 11), 13)).join(''));
for (const a of ages) {
  const row = recent.map(s => {
    const gids = new Set((s.grades || []).filter(g => g.age === a).map(g => g.id));
    const n = Object.values(TS[s.id]).filter(t => gids.has(((t.meta || {}).gid))).length;
    return pad(n || '', 13);
  });
  console.log('  ' + pad(a, 7) + row.join(''));
}
console.log('\n  (teams per age group per season; blank = none)');
const gnames = [...new Set(recent.flatMap(s => (s.grades || []).map(g => g.name)))].slice(0, 12);
console.log(`  sample grade NAMES: ${cut(gnames, 900)}`);

// ---------------------------------------------------------------- 4. finishing position
hr('4. FINISHING POSITION — can it be derived from the fixtures on disk?');
const done = [...recent].reverse().find(s => s.status === 'COMPLETED');
if (!done) { console.log('no COMPLETED season among the deep set — skipping'); note('position derivability not tested: no completed deep season'); }
else {
  const d = TS[done.id];
  const byGrade = new Map();
  Object.entries(d).forEach(([tid, t]) => {
    const g = (t.meta || {}).gid; if (!g) return;
    if (!byGrade.has(g)) byGrade.set(g, []); byGrade.get(g).push([tid, t]);
  });
  // largest grade, so the test is never skipped just because no grade reached an arbitrary floor
  const pick = [...byGrade.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!pick || pick[1].length < 3) { console.log('no grade with 3+ teams — skipping'); note('position derivability not tested: no grade with 3+ teams'); }
  else {
    const [gid, teams] = pick;
    const gname = (teams[0][1].meta || {}).grade || gid;
    console.log(`${done.name} · grade ${gname} (${gid}) · ${teams.length} teams\n`);
    // print the raw vocabulary first: deciding a result is unreadable without knowing the values
    // the field actually takes is how a complete ladder gets reported as incomplete.
    const vocabR = new Map(), vocabS = new Map();
    Object.values(d).forEach(t => (Array.isArray(t.fixtures) ? t.fixtures : []).forEach(f => {
      vocabR.set(JSON.stringify(f.result), (vocabR.get(JSON.stringify(f.result)) || 0) + 1);
      vocabS.set(JSON.stringify(f.st), (vocabS.get(JSON.stringify(f.st)) || 0) + 1);
    }));
    console.log(`  distinct fixture.result values in this season: ${cut([...vocabR.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12), 700)}`);
    console.log(`  distinct fixture.st values in this season    : ${cut([...vocabS.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12), 700)}\n`);
    console.log('  team                                 fx   final  W   L   D   no-result  score-pairs');
    let unresolved = 0;
    for (const [, t] of teams) {
      const fx = Array.isArray(t.fixtures) ? t.fixtures : [];
      let w = 0, l = 0, dr = 0, nr = 0, sp = 0, fin = 0;
      for (const f of fx) {
        const st = String(f.st || '').toUpperCase();
        if (st === 'FINAL') fin++;
        if (f.score) sp++;
        const r = String(f.result || '').toUpperCase();
        if (r.startsWith('W')) w++; else if (r.startsWith('L')) l++; else if (r.startsWith('D')) dr++;
        else if (st === 'FINAL') nr++;
      }
      unresolved += nr;
      console.log(`  ${pad(((t.meta || {}).name || '').slice(0, 36), 37)}${pad(fx.length, 5)}${pad(fin, 7)}${pad(w, 4)}${pad(l, 4)}${pad(dr, 4)}${pad(nr, 11)}${sp}`);
    }
    console.log(`\n  FINAL games with no readable result across this grade: ${unresolved}`);
    if (unresolved) note(`${unresolved} completed fixtures carry no readable result — a derived ladder would be incomplete for that grade`);
    console.log(`  fixture entry VERBATIM: ${cut((teams[0][1].fixtures || [])[0], 500)}`);
  }
}

// ---------------------------------------------------------------- 5. age progression (the band question)
hr('5. AGE PROGRESSION — measured, not assumed');
const compSids = new Set(comp.map(s => s.id));
const order = {}; comp.forEach((s, i) => { order[s.id] = i; });
const seasonLabel = comp.map(s => s.name);

// collect roster ids from the deep seasons' JUNIOR teams
// Collect EVERY roster id first, then spread the sample across the whole set. Capping the
// collection instead would fill the sample from whichever seasons and grades happen to iterate
// first — a sample that fills from the first match is not a sample (T59).
const pickIds = [];
for (const s of deep) {
  if (!TS[s.id]) continue;
  for (const tid of Object.keys(TS[s.id])) {
    for (const rid of Object.keys(TS[s.id][tid].roster || {})) pickIds.push(rid);
  }
}
const uniq = [...new Set(pickIds)];
// even spread rather than the first N, which would all come from one season/grade
const step = Math.max(1, Math.floor(uniq.length / SAMPLE_PLAYERS));
const sample = uniq.filter((_, i) => i % step === 0).slice(0, SAMPLE_PLAYERS);
console.log(`roster ids seen: ${uniq.length} · sampling ${sample.length} evenly across them\n`);

const shardCache = {};
function resolveFull(rid) {
  const sh = rid.slice(0, 2);
  if (!(sh in shardCache)) {
    const r = readJson(`players/indexes/${sh}.json`);
    shardCache[sh] = r.ok ? Object.keys(r.data) : null;
  }
  if (shardCache[sh]) { const hit = shardCache[sh].find(k => k.startsWith(rid)); if (hit) return hit; }
  const a = readJson(`players/aliases/${rid.slice(0, 2)}.json`);
  return (a.ok && a.data[rid]) || null;
}
const ageNum = (a) => { const m = String(a || '').match(/(\d+)/); return m ? +m[1] : null; };

let resolved = 0, missing = 0;
const stepHist = new Map();       // age delta between consecutive seasons played
const runHist = new Map();        // consecutive seasons spent at the same age
const multiAge = { same: 0, players: 0 };
const careers = [];
for (const rid of sample) {
  const full = resolveFull(rid);
  if (!full) { missing++; continue; }
  const pR = readJson(`players/${full.slice(0, 2)}/${full}.json`);
  if (!pR.ok) { missing++; continue; }
  resolved++;
  const P = pR.data;
  const rows = [];
  for (const s of (P.seasons || [])) {
    if (!compSids.has(s.sid)) continue;
    const agesHere = [...new Set((s.regs || []).map(r => ageNum((GRADE[r.gid] || {}).age)).filter(x => x !== null))];
    if (!agesHere.length) continue;
    if (agesHere.length > 1) multiAge.same++;
    rows.push({ o: order[s.sid], age: Math.min(...agesHere), spread: agesHere.length > 1 });
  }
  if (rows.length > 1 && rows.some(r => r.spread)) multiAge.players++;
  rows.sort((a, b) => a.o - b.o);
  if (rows.length < 2) continue;
  careers.push(rows);
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].o - rows[i - 1].o;
    const key = `${rows[i].age - rows[i - 1].age} (after ${gap} season${gap === 1 ? '' : 's'})`;
    stepHist.set(key, (stepHist.get(key) || 0) + 1);
  }
  let run = 1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].age === rows[i - 1].age) run++;
    else { runHist.set(run, (runHist.get(run) || 0) + 1); run = 1; }
  }
  runHist.set(run, (runHist.get(run) || 0) + 1);
}
console.log(`resolved ${resolved} player files · unresolved ${missing} · careers with 2+ seasons in this competition: ${careers.length}\n`);
if (missing) note(`${missing} sampled roster ids did not resolve to a player file`);

console.log('  age change between consecutive seasons PLAYED:');
[...stepHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
  .forEach(([k, n]) => console.log(`    ${String(n).padStart(6)}  ${k}`));
const tot = [...stepHist.values()].reduce((a, b) => a + b, 0) || 1;
const plus1next = [...stepHist.entries()].filter(([k]) => k.startsWith('1 (after 1 ')).reduce((a, b) => a + b[1], 0);
const zeronext = [...stepHist.entries()].filter(([k]) => k.startsWith('0 (after 1 ')).reduce((a, b) => a + b[1], 0);
console.log(`\n    consecutive seasons, age +1 : ${plus1next} (${(plus1next / tot * 100).toFixed(1)}% of all transitions)`);
console.log(`    consecutive seasons, age +0 : ${zeronext} (${(zeronext / tot * 100).toFixed(1)}%)`);

console.log('\n  consecutive seasons spent in the SAME age group (run length):');
[...runHist.entries()].sort((a, b) => a[0] - b[0])
  .forEach(([k, n]) => console.log(`    ${String(n).padStart(6)}  ${k} season${k === 1 ? '' : 's'}`));
console.log(`\n  players registered in TWO age groups in one season (playing up): ${multiAge.players} players · ${multiAge.same} season-instances`);

// ---------------------------------------------------------------- 6. what seasons[].club means
hr('6. seasons[].club — association, or the club that entered the team?');
let shown = 0;
for (const rid of sample) {
  if (shown >= 6) break;
  const full = resolveFull(rid); if (!full) continue;
  const pR = readJson(`players/${full.slice(0, 2)}/${full}.json`); if (!pR.ok) continue;
  const rows = (pR.data.seasons || []).filter(s => compSids.has(s.sid));
  if (!rows.length) continue;
  shown++;
  rows.slice(0, 3).forEach(s => {
    const tn = (s.regs || []).map(r => r.tn).join(' / ');
    console.log(`  ${pad(full.slice(0, TRUNC_LEN), 15)}${pad(s.sn, 20)}club=${pad(JSON.stringify(s.club), 26)}team=${tn}`);
  });
}
const clubVals = new Set();
for (const rid of sample.slice(0, 200)) {
  const full = resolveFull(rid); if (!full) continue;
  const pR = readJson(`players/${full.slice(0, 2)}/${full}.json`); if (!pR.ok) continue;
  (pR.data.seasons || []).forEach(s => { if (s.club) clubVals.add(s.club); });
}
console.log(`\n  distinct seasons[].club values across the sample (${clubVals.size}): ${cut([...clubVals].slice(0, 25), 1200)}`);

// ---------------------------------------------------------------- verdict
hr('7. WHAT THIS PROBE SETTLED');
console.log(`competition seasons          : ${comp.length}`);
console.log(`club tokens from team names  : ${byToken.size}`);
console.log(`meta.club values             : ${byMetaClub.size}`);
console.log(`age groups                   : ${ages.length}`);
console.log(`careers measured             : ${careers.length}`);
if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length}) — things the probe could NOT establish:`);
  problems.forEach(p => console.log('  · ' + p));
} else { console.log('\nno problems recorded.'); }
console.log('');
process.exit(problems.length ? 1 : 0);
