// scripts/probe-club-movement.js
// READ-ONLY probe. Writes nothing to the repo and makes no network calls.
// Answers, from the data actually on disk rather than from documentation, the questions the
// club player-movement diagram needs settled before anything is built:
//   1. which seasons this association runs, and how they are ordered
//   2. how a CLUB is identified on a team (a field, or only the team name)
//   3. the verbatim key shape of a season entry / team-stats entry / meta / roster entry
//   4. whether a team carries a GRADE, and whether a finishing POSITION is derivable
//   5. the verbatim key shape of a player file and of one registration
//   6. whether a player's registrations reach OTHER associations (i.e. "where they went" is answerable)
// Every lookup prints what it found or says plainly that it could not look. Nothing is inferred.
//
// Tuning constants are at the top. No param() / no CLI args beyond the two optional overrides.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- configuration
const ORG_MATCH   = new RegExp(process.env.ORG_MATCH  || 'kilsyth', 'i');
const CLUB_MATCH  = new RegExp(process.env.CLUB_MATCH || 'maroondah|magic', 'i');
const MAX_SEASONS_DEEP = 10;   // how many of the most recent matching seasons to open team-stats for
const MAX_PLAYERS      = 5;    // how many roster players to resolve and inspect
const TRUNC_LEN        = 13;   // the id form stored in rosters and game p[]

const problems = [];
const note = (m) => { problems.push(m); };
const hr   = (t) => console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));
const keysOf = (o) => (o && typeof o === 'object') ? Object.keys(o) : `(not an object: ${typeof o})`;
const cut = (s, n) => { const t = JSON.stringify(s); return t.length > n ? t.slice(0, n) + '…' : t; };

function readJson(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return { ok: false, why: 'ENOENT', path: rel };
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(p, 'utf8')), path: rel,
             bytes: fs.statSync(p).size };
  } catch (e) {
    return { ok: false, why: 'PARSE: ' + e.message, path: rel };
  }
}

// ---------------------------------------------------------------- 1. seasons
hr('1. SEASONS — data/sports-index.json');
const idxR = readJson('data/sports-index.json');
if (!idxR.ok) { console.error(`CANNOT READ data/sports-index.json (${idxR.why})`); process.exit(1); }
const INDEX = idxR.data;
console.log(`file: ${(idxR.bytes / 1048576).toFixed(1)} MB · top-level keys: ${JSON.stringify(keysOf(INDEX))}`);

const seasonsObj = INDEX.seasons;
if (!seasonsObj) { console.error('no .seasons on sports-index — stopping'); process.exit(1); }
const allSeasons = Array.isArray(seasonsObj) ? seasonsObj : Object.values(seasonsObj);
console.log(`seasons in index: ${allSeasons.length}`);
console.log(`season entry keys (first entry): ${JSON.stringify(keysOf(allSeasons[0]))}`);
console.log(`season entry VERBATIM (first entry, grades trimmed):`);
{
  const s0 = { ...allSeasons[0] };
  if (Array.isArray(s0.grades)) s0.grades = s0.grades.slice(0, 2).concat(s0.grades.length > 2 ? ['…+' + (s0.grades.length - 2)] : []);
  console.log('  ' + cut(s0, 900));
}

const mine = allSeasons.filter(s => ORG_MATCH.test(String(s.orgName || '')));
console.log(`\nseasons whose orgName matches /${ORG_MATCH.source}/i: ${mine.length}`);
if (!mine.length) {
  note(`no season matched /${ORG_MATCH.source}/i on orgName`);
  const orgs = [...new Set(allSeasons.map(s => s.orgName).filter(Boolean))].sort();
  console.log(`DISTINCT orgName values in the index (${orgs.length}) — first 60:`);
  orgs.slice(0, 60).forEach(o => console.log('   ' + o));
} else {
  const byDate = [...mine].sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));
  console.log('  id            start       end         status      locked  grades  competition');
  byDate.forEach(s => {
    console.log(`  ${String(s.id).slice(0, TRUNC_LEN).padEnd(14)}${String(s.startDate || '—').slice(0, 10).padEnd(12)}` +
      `${String(s.endDate || '—').slice(0, 10).padEnd(12)}${String(s.status || '—').padEnd(12)}` +
      `${String(!!s.locked).padEnd(8)}${String((s.grades || []).length).padEnd(8)}${s.compName || ''} — ${s.name || ''}`);
  });
  const noDate = mine.filter(s => !s.startDate).length;
  console.log(`\n  seasons with NO startDate (cannot be ordered by date): ${noDate} of ${mine.length}`);
  if (noDate) note(`${noDate} matching seasons have no startDate — season ordering needs another source for those`);

  const comps = [...new Set(mine.map(s => `${s.compId || '?'}  ${s.compName || '?'}`))].sort();
  console.log(`\n  competitions run by this association (${comps.length}):`);
  comps.forEach(c => console.log('   ' + c));

  const ages = [...new Set(mine.flatMap(s => (s.grades || []).map(g => g.age)).filter(Boolean))].sort();
  const gens = [...new Set(mine.flatMap(s => (s.grades || []).map(g => g.gender)).filter(Boolean))].sort();
  console.log(`\n  distinct grade.age values across those seasons (${ages.length}): ${JSON.stringify(ages)}`);
  console.log(`  distinct grade.gender values (${gens.length}): ${JSON.stringify(gens)}`);
  const sampleGrades = (mine.find(s => (s.grades || []).length) || {}).grades || [];
  console.log(`  sample grade entries: ${cut(sampleGrades.slice(0, 6), 700)}`);
}

// ---------------------------------------------------------------- 2. teams / club identity
hr('2. TEAMS AND CLUB IDENTITY — team-stats/bv/{sid}.json');
const recent = [...mine]
  .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')))
  .slice(0, MAX_SEASONS_DEEP);
console.log(`opening team-stats for the ${recent.length} most recent matching seasons\n`);

let shapePrinted = false;
const magicTeams = [];      // {sid, sname, tid, name, grade, gid, rosterN, metaKeys}
const nameTokens = new Map();

for (const s of recent) {
  const r = readJson(`team-stats/bv/${s.id}.json`);
  if (!r.ok) {
    console.log(`  ${String(s.name).padEnd(28)} ${String(s.id).slice(0, TRUNC_LEN)}  NO TEAM-STATS FILE (${r.why})`);
    note(`team-stats missing for season ${s.id} (${s.name})`);
    continue;
  }
  const teams = r.data;
  const tids = Object.keys(teams);
  const withGrade = tids.filter(t => teams[t] && teams[t].meta && teams[t].meta.grade).length;
  console.log(`  ${String(s.name).padEnd(28)} ${String(s.id).slice(0, TRUNC_LEN)}  teams ${String(tids.length).padEnd(5)} with meta.grade ${withGrade}`);

  if (!shapePrinted && tids.length) {
    const t0 = teams[tids[0]];
    console.log(`\n  --- SHAPE, season ${s.id} team ${tids[0]} ---`);
    console.log(`  team entry keys : ${JSON.stringify(keysOf(t0))}`);
    console.log(`  meta keys       : ${JSON.stringify(keysOf(t0.meta))}`);
    console.log(`  meta VERBATIM   : ${cut(t0.meta, 700)}`);
    const rk = keysOf(t0.roster);
    console.log(`  roster keys     : ${Array.isArray(rk) ? rk.length + ' entries, first 3 ' + JSON.stringify(rk.slice(0, 3)) : rk}`);
    if (Array.isArray(rk) && rk.length) {
      console.log(`  roster[0] value : ${cut(t0.roster[rk[0]], 500)}`);
    }
    if (t0.fixtures) {
      const f = Array.isArray(t0.fixtures) ? t0.fixtures[0] : Object.values(t0.fixtures)[0];
      console.log(`  fixtures type   : ${Array.isArray(t0.fixtures) ? 'array len ' + t0.fixtures.length : 'object'}`);
      console.log(`  fixture[0]      : ${cut(f, 600)}`);
    } else {
      console.log('  fixtures        : ABSENT');
    }
    console.log('  ---------------------------------------------\n');
    shapePrinted = true;
  }

  for (const tid of tids) {
    const t = teams[tid] || {};
    const nm = String((t.meta && (t.meta.n || t.meta.name)) || t.name || '');
    if (nm) {
      const tok = nm.split(/\s+/).slice(0, 2).join(' ');
      nameTokens.set(tok, (nameTokens.get(tok) || 0) + 1);
    }
    if (CLUB_MATCH.test(nm)) {
      magicTeams.push({
        sid: s.id, sname: s.name, tid, name: nm,
        grade: (t.meta && t.meta.grade) || null,
        gid: (t.meta && t.meta.gid) || null,
        rosterN: t.roster ? Object.keys(t.roster).length : null,
        metaKeys: keysOf(t.meta),
      });
    }
  }
}

console.log(`\nteams matching /${CLUB_MATCH.source}/i across those seasons: ${magicTeams.length}`);
if (!magicTeams.length) {
  note(`no team name matched /${CLUB_MATCH.source}/i — the club may be named differently`);
  console.log('MOST COMMON leading two words of team names in those seasons (top 40):');
  [...nameTokens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
    .forEach(([t, n]) => console.log(`   ${String(n).padStart(4)}  ${t}`));
} else {
  console.log('  season                       team                                      grade            roster');
  magicTeams.slice(0, 60).forEach(t =>
    console.log(`  ${String(t.sname).padEnd(28)} ${String(t.name).padEnd(41)} ${String(t.grade || '—').padEnd(16)} ${t.rosterN}`));
  if (magicTeams.length > 60) console.log(`  … +${magicTeams.length - 60} more`);
  const noGrade = magicTeams.filter(t => !t.grade).length;
  console.log(`\n  of those, WITHOUT meta.grade: ${noGrade}`);
  if (noGrade) note(`${noGrade} club teams carry no meta.grade — grade ordering needs a rebuild or another source`);
  console.log(`  distinct team meta key sets seen: ${JSON.stringify([...new Set(magicTeams.map(t => JSON.stringify(t.metaKeys)))].slice(0, 4))}`);
  const ageLike = [...new Set(magicTeams.map(t => (t.name.match(/\bU\s?\d{1,2}\b/i) || [])[0]).filter(Boolean))].sort();
  console.log(`  age tokens found in club team NAMES: ${JSON.stringify(ageLike)}`);
}

// ---------------------------------------------------------------- 3. players
hr('3. PLAYERS — players/{xx}/{uuid}.json and players/indexes/{xx}.json');
const seed = magicTeams.filter(t => t.rosterN).slice(0, 3);
if (!seed.length) {
  console.log('no club team with a roster to sample — skipping the player section');
  note('player shape not probed: no club roster found');
} else {
  const picked = [];
  for (const t of seed) {
    const r = readJson(`team-stats/bv/${t.sid}.json`);
    if (!r.ok) continue;
    for (const rid of Object.keys(r.data[t.tid].roster || {})) {
      if (picked.length >= MAX_PLAYERS) break;
      picked.push({ rid, from: `${t.sname} / ${t.name}` });
    }
    if (picked.length >= MAX_PLAYERS) break;
  }
  console.log(`sampling ${picked.length} roster ids (shown truncated)\n`);

  let playerShapePrinted = false;
  for (const { rid, from } of picked) {
    const shard = rid.slice(0, 2);
    const ixR = readJson(`players/indexes/${shard}.json`);
    let full = null, how = null;
    if (ixR.ok) {
      const ix = ixR.data;
      const ks = Object.keys(ix);
      if (!playerShapePrinted) {
        console.log(`  index shard ${shard}: ${ks.length} entries · entry[0] key ${ks[0]} · value ${cut(ix[ks[0]], 300)}`);
      }
      full = ks.find(k => k.startsWith(rid)) || null;
      if (full) how = 'index prefix match';
    }
    if (!full) {
      const alR = readJson(`players/aliases/${shard}.json`);
      if (alR.ok && alR.data[rid]) { full = alR.data[rid]; how = 'alias redirect'; }
    }
    if (!full) {
      console.log(`  ${rid}  UNRESOLVED (no index prefix match, no alias)  [${from}]`);
      note(`roster id ${rid} did not resolve to a player file`);
      continue;
    }
    const pR = readJson(`players/${full.slice(0, 2)}/${full}.json`);
    if (!pR.ok) {
      console.log(`  ${rid} -> ${full.slice(0, TRUNC_LEN)}  PLAYER FILE MISSING (${pR.why})`);
      note(`player file missing for ${full}`);
      continue;
    }
    const P = pR.data;
    const seasons = P.seasons || [];
    const regs = seasons.flatMap(s => s.regs || []);
    console.log(`  ${rid} -> ${full.slice(0, TRUNC_LEN)}  via ${how} · seasons ${seasons.length} · regs ${regs.length} · games ${(P.games || []).length} · ${(pR.bytes / 1024).toFixed(1)} KB  [${from}]`);

    if (!playerShapePrinted && regs.length) {
      console.log(`\n  --- PLAYER SHAPE ---`);
      console.log(`  player top-level keys : ${JSON.stringify(keysOf(P))}`);
      console.log(`  sports keys           : ${JSON.stringify(keysOf(P.sports))}`);
      console.log(`  sports.Basketball keys: ${JSON.stringify(keysOf((P.sports || {}).Basketball))}`);
      console.log(`  seasons[0] keys       : ${JSON.stringify(keysOf(seasons[0]))}`);
      console.log(`  seasons[0] VERBATIM   : ${cut({ ...seasons[0], regs: (seasons[0].regs || []).slice(0, 1) }, 900)}`);
      console.log(`  regs[0] keys          : ${JSON.stringify(keysOf(regs[0]))}`);
      console.log(`  regs[0] VERBATIM      : ${cut(regs[0], 600)}`);
      console.log(`  does any reg carry a club field? ${regs.some(r => r.club || r.clubId || r.clubName) ? 'YES' : 'no'}`);
      console.log(`  does any season carry a club field? ${seasons.some(s => s.club || s.clubId || s.clubName) ? 'YES' : 'no'}`);
      console.log('  --------------------\n');
      playerShapePrinted = true;
    }

    // what this player's history REACHES — the question the diagram depends on
    const sidOf = (r) => r.sid || r.seasonId;
    const seen = new Map();
    for (const s of seasons) {
      for (const r of (s.regs || [])) {
        const sid = sidOf(r) || s.sid || s.id;
        const ent = allSeasons.find(x => x.id === sid || String(x.id).startsWith(String(sid)));
        const label = ent ? `${ent.orgName || '?'}` : `UNKNOWN SEASON ${String(sid).slice(0, TRUNC_LEN)}`;
        seen.set(label, (seen.get(label) || 0) + 1);
      }
    }
    const inIdx = [...seen.entries()].filter(([k]) => !k.startsWith('UNKNOWN'));
    const notIdx = [...seen.entries()].filter(([k]) => k.startsWith('UNKNOWN'));
    console.log(`     associations in this player's registrations: ${inIdx.map(([k, n]) => `${k} ×${n}`).join(' · ') || '(none resolved)'}`);
    if (notIdx.length) {
      console.log(`     registrations whose season is NOT in sports-index: ${notIdx.reduce((a, b) => a + b[1], 0)}`);
      note('some registrations reference a season absent from sports-index');
    }
  }
}

// ---------------------------------------------------------------- 4. verdict
hr('4. WHAT THIS PROBE SETTLED');
console.log(`association seasons found : ${mine.length}`);
console.log(`club teams found          : ${magicTeams.length}`);
console.log(`club teams with a grade   : ${magicTeams.filter(t => t.grade).length}`);
if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length}) — these are things the probe could NOT establish, not things it found to be fine:`);
  problems.forEach(p => console.log('  · ' + p));
} else {
  console.log('\nno problems recorded.');
}
console.log('');
process.exit(problems.length ? 1 : 0);
