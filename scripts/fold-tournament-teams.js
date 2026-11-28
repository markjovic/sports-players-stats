// scripts/fold-tournament-teams.js
//
// FOLDS TOURNAMENT/ASSOCIATION-ENTERED TEAMS INTO THEIR OWNING CLUB.
// OFFLINE. No PlayHQ request, no network of any kind. Every input is already on
// disk and already published.
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
// A player card reads `142 GP · 958 PTS` with
// `includes 2 GP matched by team name from Nunawading Spectres Tournament`,
// while Club Leaders for the same club reads 140 and 948. The card folds at
// RENDER time from the player's own registrations (index.html ~L3302); Club
// Leaders builds from clubs/{cid}.json `seasons`, which is PlayHQ's
// `organisation` — and a tournament-entered team carries the TOURNAMENT as its
// organisation, so its tid sits under the tournament's club file and Club
// Leaders never sees it. Confirmed 2026-11-27: clubs/c39ce5dd.json (Spirit Magic)
// holds 22 seasons and 647 teams, and season 0869ea69 (Nunawading Spectres
// Tournament 2026) is absent from it.
//
// ── INPUTS — ALL LOCAL ──────────────────────────────────────────────────────
//   data/club-index.json      [{ id, n, ty, t, s }]              0.07 MB
//   clubs/{orgId}.json        { id, n, ty, seasons: { sid: [tid] } }
//   team-stats/bv/{sid}.json  { tid: { meta: { name }, roster, fixtures } }
//
// ⚠️ data/team-index.json IS 47.97 MB (measured 2026-11-27) AND IS NOT USED HERE.
// It is not needed by this design and must not be introduced into it.
//
// ⚠️ team-stats/bv/{sid}.json IS TID-KEYED AT THE TOP LEVEL. There is NO `teams`
// wrapper. build-team-stats.js L282 is `return teams;` and the object is written
// whole; index.html L6441 reads `ts[tid]`. An earlier draft of this design said
// `teams[tid].meta.name`, which would have resolved undefined for every team,
// declined all of them, and reported a clean run that published nothing.
//
// ── OUTPUT ──────────────────────────────────────────────────────────────────
//   clubs/{clubId}.json gains  tseasons: { sid: { tid: { from, name } } }
//
// ⚠️ PLAYHQ'S OWN `seasons` KEY IS NEVER TOUCHED. The two attributions stay
// separate, distinguishable and auditable, and a fold judged wrong can be dropped
// without rebuilding PlayHQ's half.
//
// ⚠️ build-club-index.js MUST CARRY `tseasons` THROUGH ITS MERGE. Its club-file
// merge (L481-483) constructs an object literal of exactly { id, n, ty, seasons },
// so before 2026-11-28 any `tseasons` key was DROPPED on the next Build Club Index
// run, with no error and no log line. That script was patched in the same commit
// as this file. If someone reverts it, this fold works once a week and is erased
// by the next club-index run, silently.
//
// ⚠️ THE SUITE THAT ASSERTS THAT PASSTHROUGH IS NOT IN THIS REPOSITORY.
// test-club-fold.js (35 assertions, pure node) and render-test-club-fold.js
// (16 Chromium assertions) were written and run green on 2026-11-28 and are held
// in staging, deliberately unuploaded: nothing in CI runs any of the suites in
// scripts/tests/, and an unrun test does not belong in the repo. So the merge
// passthrough has NO automated guard here. If you change mergeClubIndexFile,
// you are the guard.
//
// ⚠️ THE PLAYER CARD IS NOT MODIFIED. It keeps its own render-time fold and keeps
// printing "includes N GP matched by team name from <org>". Club Leaders gets its
// own equivalent note. FOLDED GAMES ARE NEVER INVISIBLE INSIDE A TOTAL.
//
// ⚠️ THIS IS NOT ONLY ABOUT TOURNAMENTS, DESPITE THE FILE NAME. The rule folds any
// organisation whose published type is ASSOCIATION, because that is exactly what
// the player card does and the two must agree. VJBL alone owns 10,371 teams as an
// ASSOCIATION. So the movement when this first runs is much larger than the 2 GP
// that reported the defect. Run --dry-run first and read the per-organisation
// table; it exists for precisely this reason.
//
// Usage:
//   node scripts/fold-tournament-teams.js --dry-run
//   node scripts/fold-tournament-teams.js
//   node scripts/fold-tournament-teams.js --season=0869ea69
//   node scripts/fold-tournament-teams.js --org=1a2b3c4d
//
// NO actions/setup-node restriction applies — this job fetches nothing.

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CF = require('./lib/club-fold.cjs');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const has  = (f) => args.includes('--' + f);
const val  = (f, d) => { const a = args.find(x => x.startsWith('--' + f + '=')); return a ? a.split('=').slice(1).join('=') : d; };

const DRY_RUN        = has('dry-run');
const STRICT_MISSING = has('strict-missing');
const TARGET_SEASON  = val('season', '');
const TARGET_ORG     = val('org', '');
const COMMIT_EVERY   = Math.max(1, parseInt(val('commit-every', '400'), 10) || 400);

const CLUB_INDEX   = path.join(ROOT, 'data', 'club-index.json');
const CLUBS_DIR    = path.join(ROOT, 'clubs');
const TEAM_STATS   = path.join(ROOT, 'team-stats', 'bv');

const log = (m) => console.log(`[club-fold] ${new Date().toISOString().slice(11, 19)} ${m}`);

// ─── Disk helpers — same contract as build-club-index.js ─────────────────────
// A present-but-unreadable file is a FAULT, not an absence. Reading it as the
// fallback would silently discard whatever it holds on the next write.
function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`${path.relative(ROOT, p)} is present but unreadable: ${e.message}`); }
}
function writeJson(p, data) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
}

// ─── git — copied from build-club-index.js, unchanged ────────────────────────
const GIT_OPTS        = { cwd: ROOT, stdio: 'pipe', timeout: 20 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const PUSH_ATTEMPTS   = 60;
const BATCH_THRESHOLD = 2000;

function gitCommit(message, paths) {
  if (DRY_RUN) { log(`  [dry-run] ${message} (${paths.length} paths)`); return; }
  const unique = [...new Set(paths)].filter(Boolean);
  if (!unique.length) { log('  staging: nothing to stage'); return; }

  if (unique.length > BATCH_THRESHOLD) {
    const listFile = path.join(ROOT, '.club-fold-pathspec');
    fs.writeFileSync(listFile, unique.join('\n') + '\n', 'utf8');
    try { execSync(`git add --pathspec-from-file=${JSON.stringify(listFile)}`, GIT_OPTS); }
    catch (e) {
      log(`  batched add failed (${(e.stderr || e.stdout || '').toString().trim().slice(0, 200)}) — isolating per path`);
      for (const p of unique) { try { execSync(`git add -- ${JSON.stringify(p)}`, GIT_OPTS); } catch (_) { log(`    unmatched: ${p}`); } }
    } finally { try { fs.unlinkSync(listFile); } catch (_) {} }
  } else {
    for (const p of unique) { try { execSync(`git add -- ${JSON.stringify(p)}`, GIT_OPTS); } catch (_) { log(`    unmatched: ${p}`); } }
  }

  // `git add` is ATOMIC across pathspecs — one unmatched path stages NOTHING,
  // silently, exit 0 — so the staged shortstat is printed, never assumed (T16).
  const shortstat = execSync('git diff --staged --shortstat', GIT_OPTS).toString().trim();
  if (!shortstat) { log('  staging: no changes — nothing to commit'); return; }
  log(`  staging: ${shortstat}`);

  execSync(`git commit -m ${JSON.stringify(message.replace(/"/g, "'"))}`, GIT_OPTS);

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try {
      execSync('git fetch origin main', GIT_OPTS);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT_OPTS);
      execSync('git push origin main', GIT_OPTS);
      log(`  ✔ pushed (attempt ${attempt}): ${message}`);
      return;
    } catch (e) {
      const detail = (e.stderr || e.stdout || '').toString().trim() || e.message;
      if (/GH001|exceeds|too large/i.test(detail)) throw new Error(`push permanently rejected: ${detail}`);
      try { execSync('git merge --abort', GIT_OPTS); } catch (_) {}
      if (attempt === PUSH_ATTEMPTS) throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${detail}`);
      const wait = 1 + Math.floor(Math.random() * 90);
      log(`  … push contention (attempt ${attempt}) — retry in ${wait}s`);
      execSync(`sleep ${wait}`, { stdio: 'ignore' });
    }
  }
}

function main() {
  log(`mode: ${DRY_RUN ? 'DRY RUN — nothing written, nothing committed' : 'APPLY'}`);
  if (TARGET_SEASON) log(`season filter: ${TARGET_SEASON}`);
  if (TARGET_ORG)    log(`org filter: ${TARGET_ORG}`);

  // ── 1 · the index, and the gate on `ty` ───────────────────────────────────
  const idx = readJson(CLUB_INDEX, null);
  if (!Array.isArray(idx) || !idx.length) {
    throw new Error('data/club-index.json is missing or empty. Run Build Club Index first.');
  }
  const withTy = idx.filter(r => r && r.ty).length;
  log(`club index: ${idx.length} organisation(s), ${withTy} carrying a published type`);
  // ⚠ NO ty, NO INFERENCE — the same gate index.html states at L3298. A club index
  // without types makes every candidate list empty, which would fold NOTHING while
  // exiting 0. That is a failure to ASK being recorded as an ANSWER of "no club",
  // and it is the class that wrote 80 seasons as removed:true off a CloudFront wall.
  if (!withTy) {
    throw new Error('NOT ONE organisation in data/club-index.json carries `ty`. '
      + 'build-club-index.js has not run since `ty` was added (2026-10-12). '
      + 'Nothing folded, nothing written — run Build Club Index, then re-run this.');
  }

  const keys = CF.buildClubKeys(idx);
  const assocRows = idx.filter(r => r && r.ty === 'ASSOCIATION' && (!TARGET_ORG || String(r.id) === TARGET_ORG));
  log(`candidate CLUB keys: ${keys.length}   source ASSOCIATION organisations: ${assocRows.length}`);
  if (!keys.length) throw new Error('no CLUB organisation produced a usable key — nothing can be folded. Check `ty` in data/club-index.json.');
  if (!assocRows.length) { log('no ASSOCIATION organisations to fold from — nothing to do.'); return; }

  // Ambiguity is a fact about PlayHQ's club names, not a fault here, so it is
  // REPORTED rather than thrown. The page resolves it first-hit-wins and this
  // file does the same, deliberately — but an arbitrary winner that nobody can
  // see is how a wrong attribution becomes permanent.
  const dups = CF.duplicateKeys(keys);
  if (dups.length) {
    log(`⚠ ${dups.length} club key(s) are AMBIGUOUS — two or more CLUB organisations reduce to the same key.`);
    log('  First hit wins, matching the page. Listed so an arbitrary winner is never invisible:');
    for (const d of dups.slice(0, 20)) log(`    "${d.k}" <- ${d.members.map(m => `${m.n} (${m.id})`).join('  |  ')}`);
    if (dups.length > 20) log(`    … and ${dups.length - 20} more`);
  }

  // ── 2 · what to look up, grouped by season ────────────────────────────────
  // Grouped by sid so each team-stats file — the largest artifacts in the repo —
  // is read EXACTLY ONCE, not once per association that holds teams in it.
  const need = new Map();           // sid -> [{ tid, from }]
  const orgName = new Map();        // orgId -> name
  let sourceTeams = 0;
  for (const row of assocRows) {
    const cf = readJson(path.join(CLUBS_DIR, `${row.id}.json`), null);
    orgName.set(String(row.id), row.n || String(row.id));
    if (!cf || !cf.seasons) continue;
    for (const [sid, tids] of Object.entries(cf.seasons)) {
      if (TARGET_SEASON && sid !== TARGET_SEASON) continue;
      if (!Array.isArray(tids) || !tids.length) continue;
      if (!need.has(sid)) need.set(sid, []);
      const bucket = need.get(sid);
      for (const tid of tids) { bucket.push({ tid: String(tid), from: String(row.id) }); sourceTeams++; }
    }
  }
  log(`${sourceTeams.toLocaleString()} association-attributed team(s) across ${need.size.toLocaleString()} season(s) to check`);
  if (!need.size) { log('nothing to check — done.'); return; }

  // ── 3 · the fold, one season file at a time ───────────────────────────────
  const computed = new Map();       // clubId -> { sid: { tid: {from,name} } }
  const visited  = new Set();       // sids whose team-stats file was READ
  const missing  = [];              // sids an association claims teams in, with no team-stats file
  const byOrg    = new Map();       // orgId -> { teams, folded, declined, noName, gp }
  const bump = (org, k, n) => {
    if (!byOrg.has(org)) byOrg.set(org, { teams: 0, folded: 0, declined: 0, noName: 0, gp: 0 });
    byOrg.get(org)[k] += (n === undefined ? 1 : n);
  };

  let done = 0;
  const sids = [...need.keys()].sort();
  for (const sid of sids) {
    done++;
    if (done % 100 === 0 || done === sids.length) log(`  ${done}/${sids.length} seasons`);
    const file = path.join(TEAM_STATS, `${sid}.json`);
    // ⚠ ABSENT IS NOT EMPTY. A season with no team-stats file is one we could not
    // ASK about. It is NOT marked visited, so nothing already attributed for it is
    // deleted — see mergeClubTseasons. Recording it as "no club" is the exact
    // conflation this repo has been bitten by four times.
    if (!fs.existsSync(file)) { missing.push(sid); continue; }
    const ts = readJson(file, null);
    if (!ts || typeof ts !== 'object') { missing.push(sid); continue; }
    visited.add(sid);

    const items = need.get(sid);
    for (const it of items) bump(it.from, 'teams');
    const r = CF.foldSeason({ need: items, teamStats: ts, keys });

    for (const t of r.noName)   bump(t.from, 'noName');
    for (const d of r.declined) bump(d.from, 'declined');
    for (const s2 of r.selfRef) bump(s2.from, 'declined');
    for (const h of r.hits) {
      bump(h.from, 'folded');
      // GP is what the defect was reported in, so the movement is reported in GP.
      // Summed from the SAME roster rows Club Leaders aggregates, so the figure
      // here and the figure on the page come from one source.
      const row = ts[h.tid];
      let gp = 0;
      if (row && row.roster) for (const r2 of Object.values(row.roster)) gp += (r2 && r2.gp) || 0;
      bump(h.from, 'gp', gp);
      if (!computed.has(h.clubId)) computed.set(h.clubId, {});
      const c = computed.get(h.clubId);
      if (!c[sid]) c[sid] = {};
      // `fn` is the SOURCE organisation's display name, carried so the page can
      // print "matched by team name from <org>" without resolving an id against
      // the club index at render time. `name` is the TEAM name that matched —
      // the evidence for the attribution, which is what makes it auditable.
      c[sid][h.tid] = { from: h.from, fn: orgName.get(h.from) || h.from, name: h.name };
    }
  }

  // ── 4 · write ─────────────────────────────────────────────────────────────
  // Every club that HAS a tseasons key must be revisited, not only the clubs this
  // run produced hits for — otherwise a team that PlayHQ has since attributed
  // properly leaves a phantom entry behind for ever.
  const touch = new Set(computed.keys());
  if (fs.existsSync(CLUBS_DIR)) {
    for (const f of fs.readdirSync(CLUBS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const cid = f.slice(0, -5);
      if (touch.has(cid)) continue;
      const cf = readJson(path.join(CLUBS_DIR, f), null);
      if (cf && cf.tseasons && Object.keys(cf.tseasons).length) touch.add(cid);
    }
  }

  const pending = [];
  let written = 0, cleared = 0, foldedTeams = 0, foldedClubs = 0;
  for (const cid of [...touch].sort()) {
    const file = path.join(CLUBS_DIR, `${cid}.json`);
    const existing = readJson(file, null);
    if (!existing) continue;   // a hit pointing at a club with no file is reported below
    const comp = computed.get(cid) || {};
    const { obj, changed } = CF.mergeClubTseasons(existing, comp, visited);
    const n = Object.values(comp).reduce((t, m) => t + Object.keys(m).length, 0);
    if (n) { foldedTeams += n; foldedClubs++; }
    if (!changed) continue;
    if (!obj.tseasons) cleared++;
    writeJson(file, obj);
    pending.push(`clubs/${cid}.json`);
    written++;
    if (pending.length >= COMMIT_EVERY) {
      gitCommit(`fold-tournament-teams: ${written} club file(s) updated`, pending.splice(0, pending.length));
    }
  }
  if (pending.length) gitCommit(`fold-tournament-teams: ${written} club file(s) updated`, pending);

  const orphan = [...computed.keys()].filter(cid => !fs.existsSync(path.join(CLUBS_DIR, `${cid}.json`)));

  // ── 5 · report ────────────────────────────────────────────────────────────
  const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';
  console.log('');
  log('─'.repeat(74));
  log('fold by source organisation (teams PlayHQ attributed to an ASSOCIATION):');
  log('  ' + 'organisation'.padEnd(38) + 'teams'.padStart(8) + 'folded'.padStart(8) + 'cover'.padStart(8) + 'GP moved'.padStart(10));
  const rows = [...byOrg.entries()].map(([id, v]) => ({ id, n: orgName.get(id) || id, ...v }))
    .sort((a, b) => b.folded - a.folded || b.teams - a.teams);
  for (const r of rows.slice(0, 30)) {
    log('  ' + String(r.n).slice(0, 37).padEnd(38) + String(r.teams).padStart(8) + String(r.folded).padStart(8)
      + pct(r.folded, r.teams).padStart(8) + r.gp.toLocaleString().padStart(10));
  }
  if (rows.length > 30) log(`  … and ${rows.length - 30} more organisation(s)`);

  const tot = rows.reduce((a, r) => ({ teams: a.teams + r.teams, folded: a.folded + r.folded, gp: a.gp + r.gp,
                                       declined: a.declined + r.declined, noName: a.noName + r.noName }),
                          { teams: 0, folded: 0, gp: 0, declined: 0, noName: 0 });
  console.log('');
  log('─'.repeat(74));
  log(`seasons checked ........ ${visited.size.toLocaleString()} of ${need.size.toLocaleString()}`);
  log(`teams checked .......... ${tot.teams.toLocaleString()}`);
  log(`  folded into a club ... ${tot.folded.toLocaleString()} (${pct(tot.folded, tot.teams)})`);
  log(`  declined — no match .. ${tot.declined.toLocaleString()} (${pct(tot.declined, tot.teams)})`);
  log(`  no team-stats row .... ${tot.noName.toLocaleString()}`);
  log(`GP moved ............... ${tot.gp.toLocaleString()}`);
  log(`clubs receiving teams .. ${foldedClubs.toLocaleString()}  (${foldedTeams.toLocaleString()} team-season entries)`);
  log(`club files ${DRY_RUN ? 'that WOULD be' : ''} written ... ${written.toLocaleString()}${cleared ? `  (${cleared} had every entry removed)` : ''}`);
  // A low coverage figure is EXPECTED and is not a fault — it is a property of
  // each organisation's team naming. Eltham-Dandenong writes "Westgate B12.1" and
  // 7.6% resolve; Nunawading writes "Spirit Magic U14 Boys" and 75.5% do.
  // Declining is correct: 27% at 0 errors beats 80% at any error rate.
  log('coverage is a property of each organisation\'s naming, not of this code — declining is correct.');

  if (orphan.length) {
    log('─'.repeat(74));
    log(`⚠ ${orphan.length} club(s) matched by name have NO clubs/{id}.json file — nothing written for them.`);
    for (const c of orphan.slice(0, 20)) log(`    ${c}`);
    if (orphan.length > 20) log(`    … and ${orphan.length - 20} more`);
    log('  Build Club Index writes those files; the index is newer than clubs/ if this is non-empty.');
  }

  if (missing.length) {
    log('─'.repeat(74));
    log(`⚠ ${missing.length} season(s) have association-attributed teams but NO readable team-stats/bv/{sid}.json.`);
    log('  These were NOT marked as checked, so nothing already attributed for them was removed.');
    for (const s of missing.slice(0, 40)) log(`    ${s}`);
    if (missing.length > 40) log(`    … and ${missing.length - 40} more`);
    if (STRICT_MISSING) throw new Error(`${missing.length} season(s) could not be read and --strict-missing was set`);
    log('  Run with --strict-missing to make this fatal.');
  }

  log(DRY_RUN ? 'dry run complete — nothing written' : 'complete');
}

try { main(); }
catch (e) { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); }
