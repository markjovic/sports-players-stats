// scripts/find-shell-aliases.js
//
// READ-ONLY. No PlayHQ calls, no writes, no commits. Reads players/,
// players/aliases/ and games/bv, prints a report and optionally writes one file.
//
// ─── WHAT THIS IS ────────────────────────────────────────────────────────────
// count-stats-checked.js measured 591 player files holding a non-zero career with
// an EMPTY games[]. The worked case, confirmed against PlayHQ's own canonical
// record for game f4a62985:
//
//   PlayHQ's team sheet, away #4:
//     participant 8b8af34a-…  profile 692caea1-e6dd-4f4b-afc2-b33cf15601bc
//   our p[] for the same game holds:
//     11fdc0c2-2994
//
// 692caea1 is the API-namespace PROFILE id — the id PlayHQ puts on its own team
// sheet and credits 374 games to. 11fdc0c2 is a SPECTATOR-namespace id, captured
// by the nightly from the spectator box score. They are not two profiles. They are
// one person across two namespaces, which is what players/aliases exists to absorb.
//
// And the alias for that spectator id reads:
//
//   "11fdc0c2-2994": "11fdc0c2-2994-413c-9f5c-f123ef521fd0"
//
// It points at ITSELF. The spectator id was registered as a player in its own
// right, a player file was created under it, and build-player-games routed every
// appearance there — leaving the real API profile with a career and no games.
//
// ⚠ THIS IS NOT THE SAGE HORN CASE AND MUST NOT BE TREATED AS ONE. On 2026-08-26
// it was settled that TWO GENUINE PLAYHQ PROFILES = TWO RECORDS, and merging them
// was explicitly refused. That rule stands and this does not touch it: here there
// is ONE profile, plus a spectator id that should have been an alias to it.
// The distinguishing evidence is PlayHQ's own canonical record, not a name and not
// a stats comparison.
//
// ⚠ AND NOTHING IS EVER APPENDED TO A ROSTER. The 2026-08-21 repair campaign
// appended a player's id to 388 rosters and the later reading was that the shared
// games it produced were damage rather than evidence. The rosters here are already
// right by PlayHQ's reckoning. The defect is one value in one alias file.
//
// ─── WHAT IT REPORTS ─────────────────────────────────────────────────────────
// For each shell it finds the file that actually holds the shell's credited games
// (scored by roster frequency, never by name), then classifies the ALIAS on that
// holder's id:
//
//   IDENTITY ALIAS  -> points at itself. The holder is a spectator id registered
//                      as a player. PROPOSED FIX: repoint it at the shell.
//   POINTS ELSEWHERE-> already aimed at some third id. Reported, never proposed.
//   NO ALIAS        -> nothing maps it. Reported.
//   HOLDER IS API   -> the holder's own id appears as a profile id somewhere in
//                      games/bv's captured api ids, if we hold any. Reported apart.
//
// The proposal is a LIST, not an action. Writing aliases moves appearances between
// real people's records and needs its own tool, its own dry run, and your decision.

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const ALIASES_DIR = path.join(ROOT, 'players', 'aliases');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_PATH    = path.join(REPORTS_DIR, 'shell-aliases.json');

const { TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

const argOf = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const has   = (n) => process.argv.includes(`--${n}`);

const MIN_GAMES = Math.max(1, parseInt(argOf('min-games', '5'), 10) || 5);
const TOP_SHARE = Math.min(1, Math.max(0, parseFloat(argOf('top-share', '0.9')) || 0.9));
const MARGIN    = Math.min(1, Math.max(0, parseFloat(argOf('margin', '0.2')) || 0.2));
const LIMIT     = parseInt(argOf('limit', '0'), 10) || 0;
const WRITE     = !has('no-write');

const t13 = (s) => String(s == null ? '' : s).slice(0, TRUNC_LEN);

console.log('find-shell-aliases — read-only, offline');
console.log(`  min-games=${MIN_GAMES}  top-share=${TOP_SHARE}  margin=${MARGIN}  limit=${LIMIT || 'all'}  write=${WRITE}\n`);

// ─── Aliases ─────────────────────────────────────────────────────────────────
// Kept as key -> raw value so an identity alias can be recognised. An identity
// alias is one whose KEY is a prefix of its VALUE: "11fdc0c2-2994" pointing at
// "11fdc0c2-2994-413c-9f5c-f123ef521fd0". That is the same definition
// find-misrouted-appearances.yml uses, and it warns that an earlier version
// treated identity aliases as repointable and would have destroyed the record it
// was repairing. They are the SUBJECT here, not an exclusion — but the definition
// must match exactly or this tool proposes the same destruction.
const aliasOf = new Map();
let aliasEntries = 0, aliasFiles = 0;
if (fs.existsSync(ALIASES_DIR)) {
  for (const fn of fs.readdirSync(ALIASES_DIR)) {
    if (!fn.endsWith('.json')) continue;
    aliasFiles++;
    let a; try { a = JSON.parse(fs.readFileSync(path.join(ALIASES_DIR, fn), 'utf8')); } catch { continue; }
    for (const [k, v] of Object.entries(a || {})) { aliasEntries++; aliasOf.set(t13(k), { value: String(v), file: fn }); }
  }
}
console.log(`  players/aliases: ${aliasFiles} file(s), ${aliasEntries.toLocaleString()} entries`);

// ─── Pass 1: players ─────────────────────────────────────────────────────────
const byTrunc = new Map();
const shells  = [];
let scanned = 0;
for (const prefix of fs.readdirSync(PLAYERS_DIR).filter(f => /^[0-9a-f]{2}$/.test(f)).sort()) {
  const dir = path.join(PLAYERS_DIR, prefix);
  for (const fn of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const uuid = fn.replace(/\.json$/, '');
    byTrunc.set(t13(uuid), path.join(prefix, fn));
    scanned++;
    let p; try { p = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8')); } catch { continue; }
    const bk = p.sports && p.sports.Basketball;
    if (!bk) continue;
    if ((Number(bk.gp) || 0) > 0 && !(Array.isArray(p.games) && p.games.length) && Array.isArray(bk.c) && bk.c.length) {
      shells.push({ uuid, name: p.name || '?', gp: Number(bk.gp) || 0, c: bk.c.slice() });
    }
  }
  process.stdout.write(`  players: ${scanned} scanned\r`);
}
console.log(`  players: ${scanned.toLocaleString()} scanned — ${shells.length.toLocaleString()} shell(s)`);

shells.sort((a, b) => b.c.length - a.c.length);
const work = LIMIT ? shells.slice(0, LIMIT) : shells;

// ─── Pass 2: rosters for the needed games only ───────────────────────────────
const needed = new Set();
for (const s of work) for (const g of s.c) needed.add(g);
const rosterOf = new Map();
for (const fn of fs.readdirSync(GAMES_DIR)) {
  if (!fn.endsWith('.json')) continue;
  let gf; try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fn), 'utf8')); } catch { continue; }
  for (const [gid, g] of Object.entries(gf.games || {})) {
    if (!needed.has(gid)) continue;
    const ids = new Set();
    if (g && Array.isArray(g.p)) for (const e of g.p) { const id = e && (e.id || e); if (id) ids.add(t13(id)); }
    rosterOf.set(gid, ids);
  }
}
console.log(`  games: ${rosterOf.size.toLocaleString()} of ${needed.size.toLocaleString()} credited games held\n`);

// ─── Pass 3: holder, then alias shape ────────────────────────────────────────
const out = { identityAlias: [], pointsElsewhere: [], noAlias: [], ambiguous: [], weak: [], tooFew: [], notHeld: [] };

for (const s of work) {
  const selfT = t13(s.uuid);
  const held = s.c.filter(g => rosterOf.has(g) && rosterOf.get(g).size);
  if (!held.length)            { out.notHeld.push({ shell: s.uuid, name: s.name, c: s.c.length }); continue; }
  if (held.length < MIN_GAMES) { out.tooFew.push({ shell: s.uuid, name: s.name, c: s.c.length, held: held.length }); continue; }

  const seen = new Map();
  for (const g of held) for (const id of rosterOf.get(g)) { if (id !== selfT) seen.set(id, (seen.get(id) || 0) + 1); }
  const ranked = [...seen.entries()].map(([id, n]) => ({ id, share: n / held.length })).sort((a, b) => b.share - a.share);
  if (!ranked.length) { out.weak.push({ shell: s.uuid, name: s.name, held: held.length }); continue; }

  const top = ranked[0], runner = ranked[1] || { share: 0 };
  if (top.share < TOP_SHARE)                { out.weak.push({ shell: s.uuid, name: s.name, held: held.length, best: top.id, bestShare: +top.share.toFixed(3) }); continue; }
  if (top.share - runner.share < MARGIN)    { out.ambiguous.push({ shell: s.uuid, name: s.name, held: held.length, top: ranked.slice(0, 5).map(r => `${r.id}(${(r.share * 100).toFixed(0)}%)`) }); continue; }

  const holderT = top.id;
  const holderFile = byTrunc.get(holderT) || null;
  const al = aliasOf.get(holderT) || null;
  const row = {
    shell: s.uuid, name: s.name, gp: s.gp, credited: s.c.length, held: held.length,
    holder: holderT, holderShare: +top.share.toFixed(3), holderHasFile: !!holderFile,
    aliasFile: al ? al.file : null, aliasValue: al ? al.value : null,
  };

  if (!al) { out.noAlias.push(row); continue; }
  // Identity alias: the key is a prefix of the value. Matching the definition in
  // find-misrouted-appearances.yml exactly.
  if (al.value.startsWith(holderT)) {
    row.proposedAliasValue = s.uuid;
    out.identityAlias.push(row);
  } else {
    out.pointsElsewhere.push(row);
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────
const L = '─'.repeat(76);
console.log(L);
console.log(`  SHELLS EXAMINED: ${work.length.toLocaleString()}`);
console.log(L);
console.log(`  IDENTITY ALIAS on the holder : ${out.identityAlias.length.toLocaleString()}   ← a spectator id registered as a player. THE PROPOSED REPOINT.`);
console.log(`  alias points elsewhere       : ${out.pointsElsewhere.length.toLocaleString()}   ← already aimed at a third id. Never proposed.`);
console.log(`  no alias on the holder       : ${out.noAlias.length.toLocaleString()}   ← nothing maps it at all.`);
console.log(`  ambiguous (tie)              : ${out.ambiguous.length.toLocaleString()}   ← two ids score alike. Never resolved.`);
console.log(`  no strong holder             : ${out.weak.length.toLocaleString()}   ← best id below ${(TOP_SHARE * 100).toFixed(0)}% of team sheets.`);
console.log(`  too few held games           : ${out.tooFew.length.toLocaleString()}   ← under ${MIN_GAMES} held; not testable.`);
console.log(`  none of their games held     : ${out.notHeld.length.toLocaleString()}   ← capture gap, not an alias problem.`);
console.log(L);

if (out.identityAlias.length) {
  console.log(`\n  PROPOSED REPOINTS — each is ONE value change in players/aliases/<file>`);
  console.log(`    ${'alias key'.padEnd(15)}${'file'.padEnd(9)}${'gp'.padStart(5)}${'cred'.padStart(6)}${'sheet%'.padStart(8)}  should point at`);
  for (const r of out.identityAlias.slice(0, 25)) {
    console.log(`    ${r.holder.padEnd(15)}${String(r.aliasFile).padEnd(9)}${String(r.gp).padStart(5)}${String(r.credited).padStart(6)}` +
      `${((r.holderShare * 100).toFixed(0) + '%').padStart(8)}  ${r.shell}  ${r.name}`);
  }
  if (out.identityAlias.length > 25) console.log(`    … and ${out.identityAlias.length - 25} more in the report`);
}

if (out.pointsElsewhere.length) {
  console.log(`\n  ALIAS POINTS ELSEWHERE — read individually, never repointed by this list`);
  for (const r of out.pointsElsewhere.slice(0, 10)) {
    console.log(`    ${r.holder}  ->  ${r.aliasValue}   (shell ${r.shell.slice(0, 13)}, ${r.credited} credited)  ${r.name}`);
  }
  if (out.pointsElsewhere.length > 10) console.log(`    … and ${out.pointsElsewhere.length - 10} more`);
}

console.log(`\n${L}`);
console.log(`  NOTHING WAS WRITTEN. No alias, no player file, nothing in games/bv.`);
console.log(`  The rosters are already correct by PlayHQ's own team sheets — an append`);
console.log(`  would duplicate a person, which is what the 2026-08-21 campaign did.`);
console.log(`  A repoint moves appearances between real people's records, so the list`);
console.log(`  above is INPUT TO A DECISION, not an instruction.`);
console.log(`  CONFIRM A SAMPLE AGAINST PLAYHQ FIRST: the canonical record for any of the`);
console.log(`  credited games names the profile id on its team sheet. If that id is the`);
console.log(`  SHELL, the repoint is right. If it is the HOLDER, it is not — and that`);
console.log(`  would be two genuine profiles, which is the 2026-08-26 two-records rule.`);
console.log(L);

if (WRITE) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    params: { minGames: MIN_GAMES, topShare: TOP_SHARE, margin: MARGIN, limit: LIMIT },
    counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])),
    ...out,
  }));
  console.log(`  Report written: reports/shell-aliases.json`);
}
