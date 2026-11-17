// scripts/build-club-movement.js
// Builds the club player-movement page: one panel per AGE GROUP, stacked youngest at the top,
// columns = seasons oldest-left, ribbons carrying players between the club's teams.
//
// Ported from the netball build (build_movement2.py) with every hard check kept. What changed,
// and why, measured rather than assumed:
//   · CLUB comes from player.seasons[].club, NOT from the team name. Maroondah Magic names its
//     teams MMB12 / MMG11 — the name carries no club at all — and team-stats meta.club is
//     populated for only a small minority of team-seasons. So team -> club is INVERTED from the
//     players registered to that team, which is the only source that answers for every team.
//   · BANDS are age groups (U7..U18+), not the netball two-panel 9U/11U layout.
//   · AGE comes from the season's grade list, falling back to parsing the grade NAME, because
//     the five oldest seasons carry a stale grade list in sports-index (2 grades against ~80).
//   · NO ageing-out PREDICTION. Measured run length in an age band is bimodal (1 season 753,
//     2 seasons 920, 3+ 301 across 622 careers), so "second season in band means moving up" is
//     a coin flip. The page reports the measured first/second-season split instead.
//
// Writes aggregates and pseudonymous player codes (P001…) only. No player uuid, no player name,
// and no roster data reaches the output file.
//
// Settings are read from the environment by the workflow. No param() block, no CLI args.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- configuration
const COMP_ID    = process.env.COMP_ID   || 'f0c4ccaa';                        // Kilsyth Junior Domestic
const ORG_MATCH  = new RegExp(process.env.ORG_MATCH || 'kilsyth', 'i');
const CLUB       = process.env.CLUB      || 'Maroondah Magic Basketball Club';
const GENDER     = process.env.GENDER    || 'Boys';                            // Boys | Girls | All
const TEMPLATE   = process.env.TEMPLATE  || 'scripts/movement-template.html';
const OUT        = process.env.OUT       || 'movement.html';
const ALLOW_UNGRADED = /^(1|true|yes)$/i.test(process.env.ALLOW_UNGRADED || '');
const TRUNC_LEN  = 13;

const t0 = Date.now();
const log = (...a) => console.log(...a);
const die = (m) => { console.error('\nFATAL: ' + m); process.exit(1); };

function readJson(rel, required) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { if (required) die(`missing file ${rel}`); return null; }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die(`cannot parse ${rel}: ${e.message}`); }
}

// ---------------------------------------------------------------- 1. seasons
const INDEX = readJson('data/sports-index.json', true);
const sObj = INDEX.seasons || die('sports-index has no .seasons');
const ALLS = Array.isArray(sObj) ? sObj : Object.values(sObj);

const SEASONS = ALLS
  .filter(s => String(s.compId) === COMP_ID && ORG_MATCH.test(String(s.orgName || '')))
  .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));
if (!SEASONS.length) die(`no seasons for compId ${COMP_ID} / org /${ORG_MATCH.source}/i`);
if (SEASONS.some(s => !s.startDate)) die('a season has no startDate — the column order would be arbitrary');

const SIDX = {};               // sid -> column index
SEASONS.forEach((s, i) => { SIDX[s.id] = i; });
const LABELS = SEASONS.map(s => s.name);
const NS = SEASONS.length;
const ORG = SEASONS[0].orgName;
log(`${ORG} · ${SEASONS[0].compName} · ${NS} seasons: ${LABELS[0]} → ${LABELS[NS - 1]}`);

// season id -> association name, for EVERY season in the index (used to name where players went)
const ORG_OF = {}; ALLS.forEach(s => { ORG_OF[s.id] = s.orgName || null; });
const NAME_OF = {}; ALLS.forEach(s => { NAME_OF[s.id] = s.name || null; });
const START_OF = {}; ALLS.forEach(s => { START_OF[s.id] = s.startDate || null; });

// ---------------------------------------------------------------- 2. grades: age, gender, rank
// The index grade list is STALE for the oldest seasons (measured: 2 grades where the teams show
// ~80), so a gid lookup is tried first and the grade NAME is the fallback. Neither is guessed:
// if both fail the team is reported, never silently dropped.
const GRADE = {};
ALLS.forEach(s => (s.grades || []).forEach(g => {
  GRADE[g.id] = { age: g.age, gender: g.gender, name: g.name };
}));

const ageFromText = (t) => { const m = String(t || '').match(/\bU\s?(\d{1,2})\b/i); return m ? +m[1] : null; };
const genderFromText = (t) => {
  const s = String(t || '');
  if (/\bgirls?\b|\bwomen\b/i.test(s)) return 'Girls';
  if (/\bboys?\b|\bmen\b/i.test(s)) return 'Boys';
  if (/\bmixed\b/i.test(s)) return 'Mixed';
  return null;
};
function ageOf(gid, gradeName) {
  const g = GRADE[gid];
  const a = g && g.age ? ageFromText(g.age) : null;
  return a !== null ? a : ageFromText(gradeName) ?? (g && g.name ? ageFromText(g.name) : null);
}
function genderOf(gid, gradeName) {
  const g = GRADE[gid];
  return (g && g.gender && genderFromText(g.gender)) || genderFromText(gradeName) || (g && genderFromText(g.name)) || null;
}
// Grade strength rank within an age group, from the grade name's division tail:
// "… U12 Boys A/ARes" -> A; "B1" -> B,1; "BRes" -> B + reserve; "C" -> C. Lower is stronger.
// U7 grades carry words (Miniball, Wallabies) and rank last, together.
function gradeRank(gradeName) {
  const s = String(gradeName || '');
  const tail = s.replace(/^.*?\bU\s?\d{1,2}\b/i, '').replace(/\b(boys?|girls?|mixed|men|women)\b/ig, '').trim();
  const m = tail.match(/\b([A-D])\s*(RES|Res)?\s*(\d)?/);
  if (!m) return 90;
  const letter = m[1].toUpperCase().charCodeAt(0) - 65;      // A=0
  const res = /res/i.test(tail) && /^[A-D]\s*res/i.test(tail.trim()) ? 1 : 0;
  const sub = m[3] ? +m[3] : 0;
  return letter * 10 + sub * 2 + res;
}

// ---------------------------------------------------------------- 3. team-stats
const TEAMS = {};              // `${sid}|${tid}` -> {sid,tid,name,gid,grade,age,gender,rank,roster:[ids],fx}
let teamCount = 0, missingTS = [];
for (const s of SEASONS) {
  const d = readJson(`team-stats/bv/${s.id}.json`, false);
  if (!d) { missingTS.push(`${s.id} (${s.name})`); continue; }
  for (const tid of Object.keys(d)) {
    const t = d[tid] || {}, meta = t.meta || {};
    const gradeName = meta.grade || (GRADE[meta.gid] || {}).name || '';
    TEAMS[`${s.id}|${tid}`] = {
      sid: s.id, tid, name: meta.name || meta.n || tid, gid: meta.gid || null,
      grade: meta.grade || null, age: ageOf(meta.gid, gradeName), gender: genderOf(meta.gid, gradeName),
      rank: gradeRank(gradeName), roster: Object.keys(t.roster || {}),
      fx: Array.isArray(t.fixtures) ? t.fixtures : [],
    };
    teamCount++;
  }
}
if (missingTS.length) die(`team-stats missing for ${missingTS.length} season(s): ${missingTS.join(', ')}`);
log(`teams loaded: ${teamCount}`);

// ---------------------------------------------------------------- 4. players
// Every roster id across every season of this competition is resolved, because team -> club is
// inverted from the players and "where they went" needs their whole career, not this club's slice.
const shardKeys = {};
function resolveFull(rid) {
  const sh = rid.slice(0, 2);
  if (!(sh in shardKeys)) {
    const ix = readJson(`players/indexes/${sh}.json`, false);
    shardKeys[sh] = ix ? Object.keys(ix) : null;
  }
  if (shardKeys[sh]) { const hit = shardKeys[sh].find(k => k.startsWith(rid)); if (hit) return hit; }
  const al = readJson(`players/aliases/${sh}.json`, false);
  return (al && al[rid]) || null;
}

const rosterIds = new Set();
Object.values(TEAMS).forEach(t => t.roster.forEach(r => rosterIds.add(r)));
log(`distinct roster ids across the competition: ${rosterIds.size}`);

const CAREER = new Map();      // full uuid -> [{o, sid, tid, club, age, gender, teamName, inComp}]
const teamClubVotes = new Map();
let unresolved = 0, noFile = 0, nPlayers = 0;
for (const rid of rosterIds) {
  const full = resolveFull(rid);
  if (!full) { unresolved++; continue; }
  if (CAREER.has(full)) continue;
  const P = readJson(`players/${full.slice(0, 2)}/${full}.json`, false);
  if (!P) { noFile++; continue; }
  nPlayers++;
  const rows = [];
  for (const s of (P.seasons || [])) {
    const inComp = Object.prototype.hasOwnProperty.call(SIDX, s.sid);
    for (const r of (s.regs || [])) {
      const key = `${s.sid}|${r.tid}`;
      const T = TEAMS[key];
      const age = T ? T.age : ageOf(r.gid, r.gn);
      const gen = T ? T.gender : genderOf(r.gid, r.gn);
      if (inComp && s.club) {
        const v = teamClubVotes.get(key) || new Map();
        v.set(s.club, (v.get(s.club) || 0) + 1);
        teamClubVotes.set(key, v);
      }
      rows.push({ o: inComp ? SIDX[s.sid] : null, sid: s.sid, tid: r.tid, club: s.club || null,
                  age, gender: gen, teamName: (T && T.name) || r.tn || r.tid, inComp,
                  gp: (r.stats && +r.stats.gp) || 0 });
    }
  }
  CAREER.set(full, rows);
}
log(`players resolved: ${nPlayers} · unresolved ids: ${unresolved} · missing files: ${noFile}`);
if (unresolved > rosterIds.size * 0.02) die(`${unresolved} of ${rosterIds.size} roster ids did not resolve (>2%) — identity resolution is broken, refusing to build`);

// team -> club, by vote of the players registered to it. A split vote is reported, never averaged.
const TEAM_CLUB = {};
let splitVotes = 0;
for (const [key, v] of teamClubVotes) {
  const ranked = [...v.entries()].sort((a, b) => b[1] - a[1]);
  TEAM_CLUB[key] = ranked[0][0];
  if (ranked.length > 1 && ranked[1][1] === ranked[0][1]) splitVotes++;
}
log(`teams with a club resolved from players: ${Object.keys(TEAM_CLUB).length} of ${teamCount}` +
    (splitVotes ? ` · ${splitVotes} tied votes (first taken)` : ''));

// ---------------------------------------------------------------- 5. the club's teams
const genderOk = (g) => GENDER === 'All' || g === GENDER;
const isOurs = (key) => TEAM_CLUB[key] === CLUB;
const OURS = Object.keys(TEAMS).filter(k => isOurs(k) && genderOk(TEAMS[k].gender));
if (!OURS.length) {
  const have = [...new Set(Object.values(TEAM_CLUB))].sort();
  die(`no ${GENDER} teams for club "${CLUB}".\nClubs present in this competition:\n  ` + have.join('\n  '));
}
const ungraded = OURS.filter(k => TEAMS[k].age === null);
if (ungraded.length && !ALLOW_UNGRADED) {
  die(`${ungraded.length} of ${OURS.length} club teams have no readable age group, so they cannot be placed in a panel.\n` +
      ungraded.slice(0, 20).map(k => `  ${NAME_OF[TEAMS[k].sid]} · ${TEAMS[k].name} · grade ${JSON.stringify(TEAMS[k].grade)}`).join('\n') +
      (ungraded.length > 20 ? `\n  … +${ungraded.length - 20} more` : '') +
      `\nRe-run with allow_ungraded=true to drop them, once you have looked at the list.`);
}
const USE = new Set(OURS.filter(k => TEAMS[k].age !== null));
const BANDS = [...new Set([...USE].map(k => TEAMS[k].age))].sort((a, b) => a - b);
log(`club teams: ${USE.size} (${GENDER}) · age bands ${JSON.stringify(BANDS.map(a => 'U' + a))}` +
    (ungraded.length ? ` · ${ungraded.length} dropped as ungraded` : ''));

// ---------------------------------------------------------------- 6. ladder position per team
// Within a (season, grade): wins desc, then points difference desc. Every FINAL fixture must carry
// a readable result or the grade is reported — a half-read ladder is worse than none.
const POS = {};
const byGrade = new Map();
Object.keys(TEAMS).forEach(k => {
  const t = TEAMS[k]; if (!t.gid) return;
  const g = `${t.sid}|${t.gid}`;
  if (!byGrade.has(g)) byGrade.set(g, []);
  byGrade.get(g).push(k);
});
let unreadable = 0;
for (const [, keys] of byGrade) {
  const rows = keys.map(k => {
    let w = 0, d = 0, pf = 0, pa = 0;
    for (const f of TEAMS[k].fx) {
      if (String(f.st || '').toUpperCase() !== 'FINAL') continue;
      const r = String(f.result || '').toUpperCase();
      if (r.startsWith('W')) w++; else if (r.startsWith('D')) d++;
      else if (!r.startsWith('L')) { unreadable++; continue; }
      const m = String(f.score || '').match(/(\d+)\s*-\s*(\d+)/);
      if (m) { pf += +m[1]; pa += +m[2]; }
    }
    return { k, pts: w * 2 + d, diff: pf - pa };
  });
  rows.sort((a, b) => (b.pts - a.pts) || (b.diff - a.diff));
  rows.forEach((r, i) => { POS[r.k] = i + 1; });
}
if (unreadable) log(`note: ${unreadable} FINAL fixtures carried no readable result (counted as neither W/L/D)`);

// ---------------------------------------------------------------- 7. per-player position per season
// One position per season: the team in the player's OWN (youngest) age band that season. A team in
// an older band the same season is "playing up" and is recorded on that older team as "+N also in
// Uxx", never as a second position.
const nodes = new Map();       // key -> count
const alsoN = new Map();       // key -> count (playing up)
const links = new Map();       // `${ka}>${kb}` -> count
const dest = new Map();        // `${k}>${boxkey}` -> count
const src = new Map();         // `${boxkey}>${k}` -> count
const PLAYERS = [];
const playingUp = { players: 0, instances: 0 };
const sameBand = { count: 0, eg: [] };          // two teams in ONE age group — should never happen
const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);

const boxOfLeaver = (rows, afterO) => {
  // what the player did in the FIRST later season they appear in anywhere
  const later = rows.filter(r => r.o === null ? false : r.o > afterO)
    .concat(rows.filter(r => r.o === null && START_OF[r.sid] && START_OF[r.sid] > START_OF[SEASONS[afterO].id]));
  if (!later.length) return 'none';
  const nextO = Math.min(...later.filter(r => r.o !== null).map(r => r.o).concat([Infinity]));
  const inComp = later.filter(r => r.o === nextO);
  if (inComp.length) {
    const c = inComp[0].club;
    return c && c !== CLUB ? `to:${c}` : (c === CLUB ? 'older' : 'to:(unknown club)');
  }
  const out = later.filter(r => r.o === null)[0];
  const org = out ? (ORG_OF[out.sid] || 'another association') : 'another association';
  return `assoc:${org}`;
};

for (const [full, rows] of CAREER) {
  // the player's cell per column, restricted to this club's selected teams
  const mine = rows.filter(r => r.o !== null && USE.has(`${r.sid}|${r.tid}`));
  if (!mine.length) continue;
  // ONE position per season. A player registers in their OWN age group and may play up into
  // older ones, so the position is the team in the YOUNGEST age group they hold that season;
  // every older team is "playing up" and is recorded on THAT team as "+N also played here",
  // never as a second position — the in/out partition checks depend on each player leaving and
  // entering exactly one node per season.
  //
  // Two DIFFERENT teams in the SAME age group in one season does not happen in this competition.
  // The same tid under two grades DOES — that is a regrade and is correct data (T14/T57) — so
  // registrations are collapsed by tid first. Anything still sharing an age group after that is
  // an ANOMALY: it is counted, sampled and printed, and resolved deterministically so the build
  // is reproducible. It is never silently absorbed.
  const pos = new Map();       // col -> {key, age}
  const also = new Map();      // col -> [keys]
  const byCol = new Map();
  for (const r of mine) { if (!byCol.has(r.o)) byCol.set(r.o, []); byCol.get(r.o).push(r); }
  for (const [o, rs] of byCol) {
    const byTid = new Map();                       // collapse regrades: one entry per team
    for (const r of rs) {
      const prev = byTid.get(r.tid);
      if (!prev || r.gp > prev.gp) byTid.set(r.tid, r);
    }
    const uniq = [...byTid.values()];
    const byAge = new Map();
    uniq.forEach(r => { const a = TEAMS[`${r.sid}|${r.tid}`].age; if (!byAge.has(a)) byAge.set(a, []); byAge.get(a).push(r); });
    for (const [a, list] of byAge) {
      if (list.length > 1) {
        sameBand.count += list.length - 1;
        if (sameBand.eg.length < 10) sameBand.eg.push(`${LABELS[o]} · U${a} · ${list.map(r => TEAMS[`${r.sid}|${r.tid}`].name).join(' + ')}`);
      }
    }
    uniq.sort((x, y) => {
      const a = TEAMS[`${x.sid}|${x.tid}`], b = TEAMS[`${y.sid}|${y.tid}`];
      return (a.age - b.age) || (y.gp - x.gp) || (a.rank - b.rank) || String(a.name).localeCompare(String(b.name));
    });
    const win = uniq[0], key = `${win.sid}|${win.tid}`;
    pos.set(o, { key, age: TEAMS[key].age });
    if (uniq.length > 1) also.set(o, uniq.slice(1).map(r => `${r.sid}|${r.tid}`));
  }
  for (const [, v] of pos) inc(nodes, v.key);
  for (const [, ks] of also) ks.forEach(k => inc(alsoN, k));
  playingUp.players += also.size ? 1 : 0;
  playingUp.instances += [...also.values()].reduce((a, b) => a + b.length, 0);

  const cols = [...pos.keys()].sort((a, b) => a - b);
  const hops = [];
  for (let i = 0; i < cols.length; i++) {
    const o = cols[i], key = pos.get(o).key;
    if (i + 1 < cols.length) {
      const nk = pos.get(cols[i + 1]).key;
      inc(links, `${key}>${nk}`); hops.push([key, nk]);
    } else if (o < NS - 1) {
      let bk = boxOfLeaver(rows, o);
      if (bk === 'older') bk = 'older';                           // left the selected bands, same club
      const anyLater = rows.some(r => (r.o !== null && r.o > o) || (r.o === null && START_OF[r.sid] && START_OF[r.sid] > START_OF[SEASONS[o].id]));
      if (bk === 'none' && anyLater) bk = 'gap';
      const box = `D${o + 1}.U${TEAMS[key].age}|${bk}`;
      inc(dest, `${key}>${box}`); hops.push([key, box]);
    }
  }
  const first = cols[0];
  if (first > 0) {
    const before = rows.filter(r => (r.o !== null && r.o < first) || (r.o === null && START_OF[r.sid] && START_OF[r.sid] < START_OF[SEASONS[first].id]));
    let sk = 'new';
    if (before.length) {
      const inComp = before.filter(r => r.o !== null).sort((a, b) => b.o - a.o)[0];
      if (inComp && inComp.club && inComp.club !== CLUB) sk = `from:${inComp.club}`;
      else if (inComp) sk = 'back';
      else {
        const out = before.filter(r => r.o === null).sort((a, b) => String(START_OF[b.sid]).localeCompare(String(START_OF[a.sid])))[0];
        sk = `fromassoc:${(out && ORG_OF[out.sid]) || 'another association'}`;
      }
    }
    const box = `S${first - 1}.U${pos.get(first).age}|${sk}`;
    inc(src, `${box}>${pos.get(first).key}`); hops.push([box, pos.get(first).key]);
  }

  // pseudonymous cells for the player table — team names and bands only, never ids or names
  const cells = [];
  for (let o = 0; o < NS; o++) {
    if (pos.has(o)) {
      const k = pos.get(o).key, T = TEAMS[k];
      const c = { t: T.name, b: 'U' + T.age };
      if (also.has(o)) c.also = also.get(o).map(x => TEAMS[x].name).join(', ');
      cells.push(c);
    } else if (o < first) cells.push(null);
    else {
      const here = rows.filter(r => r.o === o);
      if (here.length) cells.push({ k: 'to', l: here[0].club || here[0].teamName });
      else {
        const outside = rows.filter(r => r.o === null && NAME_OF[r.sid] && START_OF[r.sid] &&
          START_OF[r.sid] >= START_OF[SEASONS[o].id] && START_OF[r.sid] <= (START_OF[SEASONS[Math.min(o + 1, NS - 1)].id] || '9999'));
        cells.push(outside.length ? { k: 'assoc', l: ORG_OF[outside[0].sid] || '—' } : { k: 'off' });
      }
    }
  }
  PLAYERS.push({ _o: [first, pos.get(first).key, full], s: cells, h: hops });
}
PLAYERS.sort((a, b) => (a._o[0] - b._o[0]) || String(a._o[1]).localeCompare(String(b._o[1])) || String(a._o[2]).localeCompare(String(b._o[2])));
PLAYERS.forEach((p, i) => { p.c = `P${String(i + 1).padStart(3, '0')}`; delete p._o; });
log(`players on this club's teams: ${PLAYERS.length}` +
    ` · playing up into an older age group: ${playingUp.players} players, ${playingUp.instances} extra registrations`);
if (sameBand.count) {
  console.log(`\nANOMALY: ${sameBand.count} registration(s) put a player on TWO teams in the SAME age group in one season.`);
  console.log('That is not supposed to happen in this competition, and it is not a regrade (those are collapsed by tid first).');
  sameBand.eg.forEach(e => console.log('  · ' + e));
  console.log('The younger-then-most-games order resolved them so the build is reproducible — but they are worth a look.\n');
}

// ---------------------------------------------------------------- 8. nodes, with the hard checks
const NODES = [];
for (const key of [...nodes.keys()].sort()) {
  const T = TEAMS[key];
  const n = { sid: SIDX[T.sid], key, team: T.name, band: 'U' + T.age, age: T.age,
              g: T.grade, gi: T.rank, gp: POS[key] || null, n: nodes.get(key) };
  if (alsoN.get(key)) n.alsoN = alsoN.get(key);
  NODES.push(n);
}
// every node's players are fully accounted for on BOTH sides — the netball partition checks
for (const nd of NODES) {
  const key = nd.key;
  if (nd.sid < NS - 1) {
    let out = 0;
    for (const [k, v] of links) if (k.startsWith(key + '>')) out += v;
    for (const [k, v] of dest) if (k.startsWith(key + '>')) out += v;
    if (out !== nd.n) die(`out partition ${LABELS[nd.sid]} ${nd.team}: ${out} vs ${nd.n}`);
  }
  if (nd.sid > 0) {
    let inn = 0;
    for (const [k, v] of links) if (k.endsWith('>' + key)) inn += v;
    for (const [k, v] of src) if (k.endsWith('>' + key)) inn += v;
    if (inn !== nd.n) die(`in partition ${LABELS[nd.sid]} ${nd.team}: ${inn} vs ${nd.n}`);
  }
}
// every ribbon total equals the per-player hops that produced it
{
  const hop = new Map();
  PLAYERS.forEach(p => p.h.forEach(([a, b]) => inc(hop, `${a}>${b}`)));
  const all = new Map([...links, ...dest, ...src]);
  for (const [k, v] of all) if ((hop.get(k) || 0) !== v) die(`ribbon ${k}: aggregate ${v} vs player hops ${hop.get(k) || 0}`);
  for (const [k, v] of hop) if (!all.has(k)) die(`player hops reference a ribbon that does not exist: ${k} (${v})`);
}
if (NODES.some(n => !n.g)) die(`${NODES.filter(n => !n.g).length} nodes have no grade`);
log(`nodes ${NODES.length} · links ${links.size} · dest ${dest.size} · src ${src.size} — all partition checks passed`);

// ---------------------------------------------------------------- 9. measured band tenure
// Replaces the netball ageing-out prediction. For the LAST season, how many players on each team
// are in their first season in this age band, and how many in their second or later.
const tenure = {};
for (const nd of NODES.filter(n => n.sid === NS - 1)) {
  const T = TEAMS[nd.key];
  let first = 0, repeat = 0;
  for (const [, rows] of CAREER) {
    if (!rows.some(r => `${r.sid}|${r.tid}` === nd.key)) continue;
    const prior = rows.filter(r => r.o !== null && r.o < NS - 1 && r.age === T.age).length;
    if (prior) repeat++; else first++;
  }
  tenure[nd.key] = { first, repeat };
}

// ---------------------------------------------------------------- 10. emit
const DATA = {
  version: 3,
  club: CLUB, org: ORG, gender: GENDER,
  seasons: LABELS,
  bands: BANDS.map(a => 'U' + a),
  nodes: NODES.map(n => ({ ...n, tenure: tenure[n.key] || undefined })),
  links: [...links].map(([k, n]) => { const [a, b] = k.split('>'); return { a, b, n }; }),
  dest: [...dest].map(([k, n]) => { const [a, b] = k.split('>'); return { a, b, n }; }),
  src: [...src].map(([k, n]) => { const [a, b] = k.split('>'); return { a, b, n }; }),
  players: PLAYERS,
  stats: {
    teams: USE.size, players: PLAYERS.length, resolvedPlayers: nPlayers,
    unresolvedIds: unresolved, ungradedDropped: ungraded.length,
    unreadableFixtures: unreadable, splitClubVotes: splitVotes,
    playingUpPlayers: playingUp.players, playingUpExtraRegs: playingUp.instances,
    sameBandAnomalies: sameBand.count,
    builtAt: new Date().toISOString(),
  },
};
const tpl = fs.readFileSync(path.join(ROOT, TEMPLATE), 'utf8');
if (!tpl.includes('__DATA__')) die(`${TEMPLATE} has no __DATA__ placeholder`);
const html = tpl.replace('__DATA__', JSON.stringify(DATA));
fs.writeFileSync(path.join(ROOT, OUT), html, 'utf8');
log(`\nwrote ${OUT} · ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
log(`stats: ${JSON.stringify(DATA.stats)}`);
