// scripts/set-shell-apiid.js
//
// Writes ONE field — `apiId` — onto the player file that holds a shell's games,
// so that fold-diverged-players.js can do the actual repair. Nothing else is
// touched. No PlayHQ calls. Dry run unless --apply is given.
//
// ─── WHY THIS EXISTS, AND WHY IT IS THIS SMALL ───────────────────────────────
// 591 player files hold a non-zero career with an EMPTY games[]. Confirmed against
// PlayHQ's canonical record for two players in two associations:
//
//   Jade Chow      shell 692caea1-e6dd-…  holder 11fdc0c2-2994  game f4a62985
//   Mackenzie Wurfel shell 0722240b-e5e7-… holder 2e9151e6-edfa  game f3ba6c75
//
// In both, PlayHQ's own team sheet names the SHELL's uuid as profile.id, and
// 0722240b's profile page serves her live 466-game career. The shell is the
// API-namespace profile. The holder is a SPECTATOR-namespace id whose alias points
// at ITSELF — it was registered as a player, a file was created under it, and
// build-player-games routed every appearance there.
//
// fold-diverged-players.js ALREADY DOES THE WHOLE REPAIR. Its header, lines 15-23:
// a file carrying `apiId` is merged into players/{apiPrefix}/{apiId}.json, the old
// file is DELETED, moveIndexEntry moves the search-index entry, and repointAliases
// rewrites every alias value that pointed at the deleted file. It is idempotent.
// So the only thing missing is the `apiId` field, and that is all this writes.
//
// ⚠ IT DOES NOT WRITE AN ALIAS AND IT DOES NOT TOUCH games/bv. The rosters are
// already correct by PlayHQ's team sheets. An append would duplicate a person —
// which is what the 2026-08-21 campaign did, appending one player's id to 388
// rosters, and the later reading was that the shared games were damage rather than
// evidence.
//
// ⚠ IT DOES NOT TRUST THE REPORT. reports/shell-aliases.json is advisory only.
// Every pair is RECOMPUTED here from the files on disk before anything is written,
// for the reason recorded at fold-diverged-players.js L97: trusting a report is
// what made the 2026-07-30 repair fix 0 of 284 dangling aliases. The report is used
// for nothing but --only convenience.
//
// ⚠ NOT THE SAGE HORN CASE. On 2026-08-26 it was settled that two genuine PlayHQ
// profiles = two records, and merging them was refused. That rule is untouched:
// this acts only where the holder's alias points at ITSELF, which is the signature
// of a spectator id registered as a player, not of a second profile.
//
// AFTER THIS RUNS: dispatch fold-diverged-players in mode=dry-run and READ ITS
// SUMMARY before letting apply run. Its merge keeper can delete statsChecked on a
// tie-break (L652), which queues a re-fetch — expected, not a fault, but it means
// this many extra profile fetches ride along on the next matrix cycle.

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const ALIASES_DIR = path.join(ROOT, 'players', 'aliases');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');

const { TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

const argOf = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const has   = (n) => process.argv.includes(`--${n}`);

const APPLY     = has('apply');
const ONLY      = argOf('only', '');
const LIMIT     = parseInt(argOf('limit', '0'), 10) || 0;
const MIN_GAMES = Math.max(1, parseInt(argOf('min-games', '5'), 10) || 5);
const TOP_SHARE = Math.min(1, Math.max(0, parseFloat(argOf('top-share', '0.9')) || 0.9));
const MARGIN    = Math.min(1, Math.max(0, parseFloat(argOf('margin', '0.2')) || 0.2));

const t13 = (s) => String(s == null ? '' : s).slice(0, TRUNC_LEN);

console.log(`set-shell-apiid — ${APPLY ? 'APPLY (WILL WRITE)' : 'DRY RUN (writes nothing)'}`);
console.log(`  only=${ONLY || '(all)'}  limit=${LIMIT || 'all'}  min-games=${MIN_GAMES}  top-share=${TOP_SHARE}  margin=${MARGIN}\n`);

// ─── aliases ─────────────────────────────────────────────────────────────────
const aliasOf = new Map();
for (const fn of fs.existsSync(ALIASES_DIR) ? fs.readdirSync(ALIASES_DIR) : []) {
  if (!fn.endsWith('.json')) continue;
  let a; try { a = JSON.parse(fs.readFileSync(path.join(ALIASES_DIR, fn), 'utf8')); } catch { continue; }
  for (const [k, v] of Object.entries(a || {})) aliasOf.set(t13(k), String(v));
}

// ─── players ─────────────────────────────────────────────────────────────────
const byTrunc = new Map();
const shells  = [];
for (const prefix of fs.readdirSync(PLAYERS_DIR).filter(f => /^[0-9a-f]{2}$/.test(f)).sort()) {
  const dir = path.join(PLAYERS_DIR, prefix);
  for (const fn of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const uuid = fn.replace(/\.json$/, '');
    byTrunc.set(t13(uuid), path.join(prefix, fn));
    if (ONLY && uuid !== ONLY) continue;
    let p; try { p = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8')); } catch { continue; }
    const bk = p.sports && p.sports.Basketball;
    if (!bk) continue;
    if ((Number(bk.gp) || 0) > 0 && !(Array.isArray(p.games) && p.games.length) && Array.isArray(bk.c) && bk.c.length) {
      shells.push({ uuid, name: p.name || '?', gp: Number(bk.gp) || 0, c: bk.c.slice() });
    }
  }
}
shells.sort((a, b) => b.c.length - a.c.length);
const work = LIMIT ? shells.slice(0, LIMIT) : shells;
console.log(`  ${work.length} shell(s) to examine`);

// ─── rosters for the needed games ────────────────────────────────────────────
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

// ─── recompute, gate, write ──────────────────────────────────────────────────
const wrote = [], skipped = [];
for (const s of work) {
  const selfT = t13(s.uuid);
  const held = s.c.filter(g => rosterOf.has(g) && rosterOf.get(g).size);
  const skip = (why) => skipped.push({ shell: s.uuid, name: s.name, why });
  if (held.length < MIN_GAMES) { skip(`only ${held.length} held credited game(s)`); continue; }

  const seen = new Map();
  for (const g of held) for (const id of rosterOf.get(g)) { if (id !== selfT) seen.set(id, (seen.get(id) || 0) + 1); }
  const ranked = [...seen.entries()].map(([id, n]) => ({ id, share: n / held.length })).sort((a, b) => b.share - a.share);
  if (!ranked.length) { skip('no roster ids at all'); continue; }
  const top = ranked[0], runner = ranked[1] || { share: 0 };
  if (top.share < TOP_SHARE)             { skip(`best holder only ${(top.share * 100).toFixed(0)}% of team sheets`); continue; }
  if (top.share - runner.share < MARGIN) { skip(`tie: ${(top.share * 100).toFixed(0)}% vs ${(runner.share * 100).toFixed(0)}%`); continue; }

  const holderT = top.id;
  const al = aliasOf.get(holderT);
  // THE GATE. Only an alias pointing at ITSELF marks a spectator id registered as
  // a player. Anything else is either a real mapping or an unknown, and acting on
  // it would move appearances between real people's records.
  if (!al)                       { skip(`holder ${holderT} has no alias entry`); continue; }
  if (!al.startsWith(holderT))   { skip(`holder ${holderT} alias points at ${al.slice(0, 13)}, not itself`); continue; }

  const rel = byTrunc.get(holderT);
  if (!rel) { skip(`holder ${holderT} has no player file`); continue; }
  const holderPath = path.join(PLAYERS_DIR, rel);
  let holder; try { holder = JSON.parse(fs.readFileSync(holderPath, 'utf8')); } catch { skip('holder file unreadable'); continue; }

  // Never overwrite an apiId that is already there — the fold is mid-flight or
  // something else set it, and clobbering it would redirect a merge.
  if (holder.apiId) { skip(`holder already carries apiId=${String(holder.apiId).slice(0, 13)}`); continue; }
  // The holder must actually hold the games. If it does not, the scoring found the
  // wrong file and nothing should be written.
  if (!(Array.isArray(holder.games) && holder.games.length)) { skip('holder holds no games'); continue; }
  // The shell must still exist as a file for the fold to merge into.
  if (!byTrunc.get(selfT)) { skip('shell has no player file'); continue; }

  const row = {
    holder: holderT, holderPath: rel, holderGames: holder.games.length,
    apiId: s.uuid, shellGp: s.gp, credited: s.c.length, held: held.length,
    share: +top.share.toFixed(3), sample: held[0], name: s.name,
  };

  if (APPLY) {
    holder.apiId = s.uuid;          // minified — never `null, 2`
    fs.writeFileSync(holderPath, JSON.stringify(holder));
  }
  wrote.push(row);
}

// ─── report ──────────────────────────────────────────────────────────────────
const L = '─'.repeat(78);
console.log(`\n${L}`);
console.log(`  ${APPLY ? 'WROTE apiId on' : 'WOULD WRITE apiId on'} ${wrote.length} holder file(s)`);
console.log(`  skipped ${skipped.length}`);
console.log(L);
if (wrote.length) {
  console.log(`    ${'holder'.padEnd(15)}${'games'.padStart(7)}${'sheet%'.padStart(8)}  ${'sample game'.padEnd(13)}  apiId := shell`);
  for (const r of wrote.slice(0, 40)) {
    console.log(`    ${r.holder.padEnd(15)}${String(r.holderGames).padStart(7)}${((r.share * 100).toFixed(0) + '%').padStart(8)}  ${String(r.sample).padEnd(13)}  ${r.apiId}  ${r.name}`);
  }
  if (wrote.length > 40) console.log(`    … and ${wrote.length - 40} more`);
}
if (skipped.length) {
  console.log(`\n  SKIPPED — every one of these is a refusal, not a failure`);
  for (const r of skipped.slice(0, 25)) console.log(`    ${r.shell.slice(0, 13)}  ${r.why}  (${r.name})`);
  if (skipped.length > 25) console.log(`    … and ${skipped.length - 25} more`);
}

console.log(`\n${L}`);
if (!APPLY) {
  console.log(`  DRY RUN — nothing was written.`);
} else if (wrote.length) {
  // Per-path staging only. `git add` is atomic across pathspecs, so one unmatched
  // path stages NOTHING, silently, and the run reports success having committed
  // nothing — which discarded a complete 30,426-game run once already.
  let staged = 0;
  for (const r of wrote) {
    try { execSync(`git add -- "players/${r.holderPath}"`, { cwd: ROOT, stdio: 'pipe' }); staged++; }
    catch (e) { console.log(`  ⚠ could not stage players/${r.holderPath}: ${e.message}`); }
  }
  console.log(`  staged ${staged}/${wrote.length} file(s)`);
  console.log(`  Commit and push are the workflow's job, not this script's.`);
}
console.log(`  NEXT: dispatch fold-diverged-players with mode=dry-run and read its summary.`);
console.log(`  It merges each pair into the api-keyed file, DELETES the holder file,`);
console.log(`  moves the index entry and repoints the aliases. Only let apply run after.`);
console.log(L);
