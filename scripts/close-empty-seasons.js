// scripts/close-empty-seasons.js
//
// Closes seasons that are finished, still unlocked, hold no games on disk, and
// which PlayHQ confirms have no games either.
//
// IT ASKS BEFORE IT CLOSES. That is the whole design. A season with no games file
// is NOT evidence that no games exist - it is equally consistent with a capture
// failure, and closing one of those buries recoverable data permanently. This is
// the same mistake as writing removed:true off a CloudFront block, in the other
// direction, and it is the reason this tool makes 2 API calls per grade rather
// than reading a date and deciding.
//
// WHAT IT WRITES, AND WHY THOSE FIELDS
// ────────────────────────────────────
//   locked: true      stops the nightly crawling it. The functional change.
//   closedAt          when. Additive; nothing reads it.
//   closedReason      why. Additive.
//
// NOT removed:true. That flag means a stub with grades:[] that must never be
// re-examined, and these seasons hold real grade lists - reusing it would corrupt
// a flag other code tests. Not bare locked:true either: that makes them
// indistinguishable from the 2,676 seasons already locked, and closedAt/
// closedReason are the selector if this ever has to be reversed. The repair on
// 2026-09-08 was only possible because discoveredBy:'org' gave exactly such a
// selector for the 80 damaged seasons.
//
// WHAT IT MEASURED FIRST (2026-09-08)
// ───────────────────────────────────
// audit-finished-unlocked-seasons.js: 138 COMPLETED seasons sat unlocked, of which
// 78 held NO games file at all, carrying 531 grades between them - 6a36400d with
// 65 grades and d0543eab with 32, both finished in 2020 with hundreds of nightly
// runs behind them.
//
// audit-pending-games-vs-playhq.js established that games we hold as PENDING are
// still PENDING at PlayHQ - 685 asked, 0 finished. That is World A, and it is why
// closing on evidence is safe. But it says NOTHING about seasons with no file at
// all: different population, question still open per season. Hence this.
//
// THE THREE OUTCOMES, WHICH MUST NEVER BE COLLAPSED
// ─────────────────────────────────────────────────
//   empty at PlayHQ   every grade asked, zero games returned  → CLOSE
//   has games         PlayHQ returned games we never captured → DO NOT CLOSE.
//                     This is a capture gap and a backfill job.
//   no answer         blocked / errored / no grades to ask    → leave, report,
//                     run again. A failure to ask is not an answer.
//
// RECENTLY TOUCHED SEASONS ARE SKIPPED. A season added or repaired in the last few
// days is empty because no nightly has reached it yet, not because it is hollow.
// The repair on 2026-09-08 unlocked 52 seasons hours before the first nightly that
// could fill them; closing those would have been wrong by a matter of hours.
//
// THE CALLS ARE THE NIGHTLY'S OWN. gradeRounds then discoverFixtureByRound, with
// nightly-crawl.js's headers, session and failure handling, copied not rewritten.
// "Does PlayHQ have games" must mean "would the nightly find games", or the answer
// is about a different question.
//
// NO actions/setup-node in the workflow: this fetches api.playhq.com.
//
// Run:
//   node scripts/close-empty-seasons.js --list-paths          (phase 1)
//   node scripts/close-empty-seasons.js --dry-run             (ask, report, write nothing)
//   node scripts/close-empty-seasons.js                       (ask, close, commit)
//   node scripts/close-empty-seasons.js --dry-run --min-age-days=14
//   node scripts/close-empty-seasons.js --seasons=6a36400d,d0543eab

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT           = path.join(__dirname, '..');
const INDEX_FILE     = path.join(ROOT, 'data', 'sports-index.json');
const INDEX_FILE_REL = 'data/sports-index.json';
const GAMES_DIR      = path.join(ROOT, 'games', 'bv');
const API_URL        = 'https://api.playhq.com/graphql';

const args   = process.argv.slice(2);
const argVal = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const DRY_RUN      = args.includes('--dry-run');
const LIST_PATHS   = args.includes('--list-paths');
const MIN_AGE_DAYS = Math.max(0, parseInt(argVal('min-age-days', '3'), 10) || 0);
const ONLY_SEASONS = argVal('seasons', '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_SEASONS  = Math.max(1, parseInt(argVal('max-seasons', '200'), 10) || 200);

const GIT_OPTS      = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const PUSH_ATTEMPTS = 60;

const log   = (m) => console.log(`[close-empty] ${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Request machinery: copied VERBATIM from nightly-crawl.js L96-236 ─────────
// ⚠️ 2026-10-05 — REWRITTEN FROM https.request TO fetch(). THE CLIENT WAS THE KEY.
// measure-playhq-limits.js --mode=compare, one runner, 10 s apart, same URL, same five
// headers, same user-agent: fetch() GRANTED, https.request REFUSED (403 CLOUDFRONT-BLOCK),
// fetch() GRANTED. REPO_MANIFEST §6.61. nightly-crawl.js's doFetch, pasted VERBATIM.
// ⚠️ DO NOT "OPTIMISE" THIS BACK TO https.request, AND DO NOT SET content-length BY HAND.
// Resolves on ANY status — never throws for a 403. Returns { status, rawCookies, body, rawText }.
async function doFetch(url, bodyObj, headers) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { ...headers, 'request-id': crypto.randomUUID() },
    body:    JSON.stringify(bodyObj),
  });
  const rawText = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(rawText); } catch (_) { body = null; }
  // undici exposes each Set-Cookie separately; the joined header is the fallback for
  // older runtimes. Callers expect an array or undefined, never an empty array.
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return {
    status:     res.status,
    rawCookies: cookies.length ? cookies : undefined,
    body,
    rawText,
  };
}

const HEADERS_MAIN = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

let sessionCookie = null;

async function refreshSession() {
  const body = { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const { rawCookies, status, rawText } = await doFetch(API_URL, body, HEADERS_MAIN);
      if (!rawCookies) {
        // 2026-10-05 §6.62 — closes the 2026-09-29 instrumentation gap: doFetch resolves
        // on ANY status, so a CloudFront block page was logged as nothing at all. Shape
        // copied from nightly-crawl.js refreshSession(). Logging only; no behaviour change.
        const blocked = /cloudfront|Request blocked|ERROR: The request could not be satisfied/i.test(rawText || '');
        const detail = blocked
          ? `CLOUDFRONT-BLOCK (${(rawText || '').length}b HTML)`
          : (rawText || '').slice(0, 160).replace(/\s+/g, ' ');
        console.log(`  \u26a0 session attempt ${attempt} ${body.operationName}: HTTP ${status}, NO set-cookie, body: ${detail || '(empty)'}`);
        continue;
      }
      const arr = (Array.isArray(rawCookies) ? rawCookies : [rawCookies]).map(c => c.split(';')[0].trim());
      const get = n => arr.find(p => p.startsWith(n + '=')) || null;
      const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
      if (tier && session && sub) {
        sessionCookie = `${tier}; ${session}; ${sub}`;
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
    } catch (_) {}
  }
  throw new Error('Failed to obtain session after 10 attempts');
}

async function gqlMain(operationName, query, variables) {
  if (!sessionCookie) await refreshSession();
  for (let attempt = 1; attempt <= 2; attempt++) {
    let status, body, rawText;
    try {
      ({ status, body, rawText } = await doFetch(API_URL, { operationName, variables, query }, { ...HEADERS_MAIN, 'Cookie': sessionCookie }));
    } catch (_) {
      if (attempt < 2) { await sleep(1000); continue; }
      return { kind: 'transient', data: null };
    }
    if (status === 403) {
      const isWaf = rawText && (rawText.includes('DOCTYPE') || rawText.includes('Request blocked'));
      if (isWaf) return { kind: 'blocked', data: null };
      await refreshSession();
      continue;
    }
    if (status === 429) return { kind: 'transient', data: null };
    if (status !== 200) { if (attempt < 2) { await sleep(1000); continue; } return { kind: 'transient', data: null }; }
    if (body && body.errors) return { kind: 'transient', data: null };
    return { kind: 'ok', data: (body && body.data) || null };
  }
  return { kind: 'transient', data: null };
}

// ─── Queries: copied VERBATIM from nightly-crawl.js L238 and L247 ────────────
const Q_GRADE_ROUNDS = `query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id name hideScores
    rounds { id name abbreviatedName current number isFinalsRound }
    season { id competition { id organisation { id name } } }
  }
}`;

const Q_FIXTURE_BY_ROUND = `query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      id date __typename
      status { value }
      result {
        outcome { name value }
        home { outcome { name value } statistics { count type { value } } }
        away { outcome { name value } statistics { count type { value } } }
      }
    }
  }
}`;


function gitCommit(msg, paths = []) {
  if (DRY_RUN) return;
  const uniq = [...new Set(paths)].filter(Boolean);
  if (!uniq.length) { log('nothing to commit (no paths given).'); return; }
  let addFailures = 0;
  for (const p of uniq) {
    try { execSync(`git add -- ${p}`, GIT_OPTS); }
    catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      if (/did not match any file/i.test(detail)) continue;
      addFailures++;
      console.error(`  ⚠ git add FAILED "${p}": ${detail}`);
    }
  }
  const staged = execSync('git diff --staged --shortstat', GIT_OPTS).toString().trim();
  if (!staged) {
    if (addFailures) throw new Error(`gitCommit: nothing staged and ${addFailures} path(s) failed to stage — refusing to report a clean no-op ("${msg}")`);
    log('nothing to commit.'); return;
  }
  log(`staging: ${staged}`);
  execSync(`git commit -q -m "${msg}"`, GIT_OPTS);
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try { execSync('git merge --abort', GIT_OPTS); } catch {}
    try {
      execSync('git fetch origin main', GIT_OPTS);
      execSync('git merge -q -X ours FETCH_HEAD --no-edit --no-stat', GIT_OPTS);
      execSync('git push origin main', GIT_OPTS);
      log(`pushed${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      if (attempt === PUSH_ATTEMPTS) throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${e.message.split('\n')[0]}`);
      execSync(`sleep ${1 + Math.floor(Math.random() * 91)}`, { stdio: 'pipe' });
    }
  }
}

// ─── Selection ────────────────────────────────────────────────────────────────
// COMPLETED, unlocked, and holding no games on disk. "No games on disk" means the
// file is absent, unreadable, or present with zero entries - all three are the
// same thing for this purpose: nothing was ever captured.
function ageDays(s) {
  const t = s.repairedAt || s.addedAt || null;
  if (!t) return Infinity;                       // no timestamp = not recent
  const d = (Date.now() - Date.parse(t)) / 86400000;
  return Number.isFinite(d) ? d : Infinity;
}

function selectSeasons(index) {
  const all = Object.values(index.seasons || {});
  const out = [], tooRecent = [];
  for (const s of all) {
    if (s.status !== 'COMPLETED' || s.locked !== false) continue;
    if (ONLY_SEASONS.length && !ONLY_SEASONS.includes(s.id)) continue;
    const file = path.join(GAMES_DIR, `${s.id}.json`);
    let n = 0;
    if (fs.existsSync(file)) {
      try { n = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).games || {}).length; } catch { n = 0; }
    }
    if (n > 0) continue;                          // has games — not this tool's business
    // Skipped, not closed. A season repaired hours ago is empty because no nightly
    // has reached it, not because it is hollow. 52 seasons were unlocked on
    // 2026-09-08 before the first nightly that could fill them.
    if (!ONLY_SEASONS.length && ageDays(s) < MIN_AGE_DAYS) { tooRecent.push(s); continue; }
    out.push(s);
  }
  out.sort((a, b) => (b.grades || []).length - (a.grades || []).length);
  return { all, targets: out.slice(0, MAX_SEASONS), tooRecent };
}

// ─── Phase 1 ─────────────────────────────────────────────────────────────────
// games/bv is 1.94 GB across 2,939 files and sparse checkout fetches roughly one
// blob per second, so a cone pattern on `games` is unusable. Name the candidates
// explicitly instead. A file absent after this checkout is genuinely absent.
if (LIST_PATHS) {
  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const ids = Object.values(index.seasons || {})
    .filter(s => s.status === 'COMPLETED' && s.locked === false)
    .map(s => s.id);
  const paths = ids.map(id => `games/bv/${id}.json`);
  const out = process.env.GITHUB_OUTPUT;
  console.error(`[close-empty] ${ids.length} COMPLETED+unlocked season(s) to check`);
  if (out) fs.appendFileSync(out, `game_files<<SPARSEEOF\n${paths.length ? paths.join('\n') + '\n' : ''}SPARSEEOF\n`);
  console.log(paths.join('\n'));
  process.exit(0);
}

// ─── Pacing ──────────────────────────────────────────────────────────────────
// ⚠️ THE FIRST VERSION OF THIS TOOL HAD NONE, AND WAS WALLED. On 2026-09-08 it
// fired 165 grade lookups plus their rounds in 80 seconds behind a fixed 150ms
// sleep with no retry: 5 seasons answered, then every remaining call came back
// CloudFront-blocked. 22 of 27 seasons went unanswered. Same shape as the
// discover-org-seasons run the day before - 14 through, then 164 refused.
//
// This caller is SEQUENTIAL, so the AIMD concurrency ladder used elsewhere does
// not apply; the lever is the gap between calls, not how many run at once. Same
// principles though: back off hard on a block, retry the same call rather than
// discarding it, widen the base gap when blocks cluster, decay it when they stop.
//
// A call that exhausts its retries returns blocked, and the season it belongs to
// is reported as unanswered and left alone. A failure to ask is never an answer.
const PACE_MIN_MS = 150, PACE_MAX_MS = 4000;
const BLOCK_RETRIES = 6, BLOCK_BACKOFF_MS = 5000, BLOCK_BACKOFF_CAP_MS = 60000;
let paceMs = PACE_MIN_MS, consecutiveBlocks = 0, cleanRun = 0;
let totalBlocks = 0, totalRetries = 0;

async function gqlPaced(operationName, query, variables) {
  for (let attempt = 1; attempt <= BLOCK_RETRIES; attempt++) {
    const r = await gqlMain(operationName, query, variables);
    if (r.kind !== 'blocked') {
      consecutiveBlocks = 0;
      if (++cleanRun >= 25 && paceMs > PACE_MIN_MS) {   // earned back slowly
        paceMs = Math.max(PACE_MIN_MS, Math.floor(paceMs * 0.75));
        cleanRun = 0;
        console.log(`    · ${totalBlocks} block(s) so far; pace eased to ${paceMs}ms`);
      }
      await sleep(paceMs);
      return r;
    }
    totalBlocks++; consecutiveBlocks++; cleanRun = 0;
    // Widen the base gap for everything that follows, not just this retry.
    if (consecutiveBlocks >= 2) paceMs = Math.min(PACE_MAX_MS, Math.max(PACE_MIN_MS * 2, paceMs * 2));
    if (attempt < BLOCK_RETRIES) {
      totalRetries++;
      const backoff = Math.min(BLOCK_BACKOFF_CAP_MS, attempt * BLOCK_BACKOFF_MS);
      console.log(`    ⚠ blocked (${operationName}) — retry ${attempt}/${BLOCK_RETRIES - 1} in ${backoff / 1000}s, pace now ${paceMs}ms`);
      await sleep(backoff);
    }
  }
  return { kind: 'blocked', data: null };
}

// ─── Ask PlayHQ ──────────────────────────────────────────────────────────────
// Returns { answered, games, gradesAsked, why }. `answered` false means we never
// learned anything and the season MUST be left alone.
async function askPlayHQ(season) {
  const grades = season.grades || [];
  if (!grades.length) return { answered: false, games: 0, gradesAsked: 0, why: 'no grades in the index to ask about' };

  let games = 0, asked = 0;
  for (const gr of grades) {
    const r1 = await gqlPaced('gradeRounds', Q_GRADE_ROUNDS, { gradeID: gr.id });
    if (r1.kind === 'blocked') return { answered: false, games, gradesAsked: asked, why: `CloudFront blocked after ${BLOCK_RETRIES} attempts` };
    if (r1.kind !== 'ok')      return { answered: false, games, gradesAsked: asked, why: `grade lookup ${r1.kind}` };
    asked++;
    const rounds = (r1.data && r1.data.discoverGrade && r1.data.discoverGrade.rounds) || [];
    for (const rd of rounds) {
      const r2 = await gqlPaced('discoverFixtureByRound', Q_FIXTURE_BY_ROUND, { roundID: rd.id });
      if (r2.kind === 'blocked') return { answered: false, games, gradesAsked: asked, why: `CloudFront blocked mid-round after ${BLOCK_RETRIES} attempts` };
      if (r2.kind !== 'ok')      return { answered: false, games, gradesAsked: asked, why: `round lookup ${r2.kind}` };
      games += ((r2.data && r2.data.discoverFixtureByRound && r2.data.discoverFixtureByRound.games) || []).length;
      // One game is enough to prove the season is not empty. Stop asking.
      if (games > 0) return { answered: true, games, gradesAsked: asked, why: null };
    }
  }
  return { answered: true, games: 0, gradesAsked: asked, why: null };
}

async function main() {
  log(`close-empty-seasons${DRY_RUN ? '  (DRY RUN)' : ''}  min-age-days=${MIN_AGE_DAYS}`);
  console.log('─'.repeat(86));

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const { all, targets, tooRecent } = selectSeasons(index);
  const lockedBefore  = all.filter(s => s.locked === true).length;
  const removedBefore = all.filter(s => s.removed === true).length;
  const gradesBefore  = all.reduce((t, s) => t + (s.grades || []).length, 0);
  const countBefore   = all.length;

  console.log(`  seasons in index              : ${countBefore}`);
  console.log(`  COMPLETED + unlocked + empty  : ${targets.length + tooRecent.length}`);
  console.log(`    too recent to judge (<${MIN_AGE_DAYS}d) : ${tooRecent.length}   ← skipped, not closed`);
  console.log(`    SELECTED to ask about       : ${targets.length}`);
  if (!targets.length) { log('nothing to ask about.'); return; }

  await refreshSession();

  const close = [], hasGames = [], noAnswer = [];
  for (const s of targets) {
    const r = await askPlayHQ(s);
    const gn = (s.grades || []).length;
    if (!r.answered)      { noAnswer.push({ s, why: r.why }); console.log(`  ? no answer     ${s.id}  ${String(gn).padStart(3)}gr  ${(s.fullName || '').slice(0, 44).padEnd(44)}  [${r.why}]`); continue; }
    if (r.games > 0)      { hasGames.push({ s, games: r.games }); console.log(`  ! HAS GAMES     ${s.id}  ${String(gn).padStart(3)}gr  ${(s.fullName || '').slice(0, 44).padEnd(44)}  PlayHQ returned ${r.games}+ — NOT closed`); continue; }
    close.push({ s, gradesAsked: r.gradesAsked });
    console.log(`  ✔ empty         ${s.id}  ${String(gn).padStart(3)}gr  ${(s.fullName || '').slice(0, 44).padEnd(44)}  ${r.gradesAsked} grades asked, 0 games`);
  }

  const now = new Date().toISOString();
  for (const { s, gradesAsked } of close) {
    const e = index.seasons[s.id];
    e.locked = true;
    e.closedAt = now;
    e.closedReason = `playhq-no-games (asked ${gradesAsked} grade(s) ${now.slice(0, 10)})`;
  }

  // ── Assertions. Closing must change ONE thing: locked, by exactly this many.
  const after = Object.values(index.seasons);
  if (after.length !== countBefore)                                            throw new Error(`ABORT: season count changed ${countBefore} → ${after.length}. Nothing committed.`);
  if (after.filter(s => s.removed === true).length !== removedBefore)          throw new Error(`ABORT: removed count changed. This tool must never set removed. Nothing committed.`);
  if (after.reduce((t, s) => t + (s.grades || []).length, 0) !== gradesBefore)  throw new Error(`ABORT: grade total changed. Nothing committed.`);
  const lockedAfter = after.filter(s => s.locked === true).length;
  if (lockedAfter - lockedBefore !== close.length)                             throw new Error(`ABORT: locked rose by ${lockedAfter - lockedBefore} but ${close.length} were closed. Nothing committed.`);

  console.log(`\n${'═'.repeat(86)}`);
  console.log(`  CLOSED (PlayHQ has nothing) : ${close.length}   ${close.reduce((t, x) => t + (x.s.grades || []).length, 0)} grades off the nightly`);
  console.log(`  HAS GAMES AT PLAYHQ         : ${hasGames.length}   ← capture gap, NOT closed`);
  console.log(`  no answer                   : ${noAnswer.length}   ← left alone, re-run`);
  console.log(`  CloudFront blocks absorbed  : ${totalBlocks}   (${totalRetries} retried, final pace ${paceMs}ms)`);
  console.log(`  skipped as too recent       : ${tooRecent.length}`);
  console.log(`  ${'-'.repeat(82)}`);
  console.log(`  locked                      : ${lockedBefore} → ${lockedAfter}`);
  console.log(`  assertions                  : PASSED — count, removed and grades all unchanged`);
  console.log(`${'═'.repeat(86)}`);

  if (hasGames.length) {
    console.log(`\n  ⚠ ${hasGames.length} season(s) hold games at PlayHQ that we never captured. These are the`);
    console.log(`    real find. They are NOT closed — closing them would bury recoverable data.`);
    for (const x of hasGames.slice(0, 20)) console.log(`      ${x.s.id}  ${(x.s.fullName || '').slice(0, 56)}`);
  }
  if (noAnswer.length) console.log(`\n  ⚠ ${noAnswer.length} season(s) unanswered — this run is INCOMPLETE. Re-run.`);

  if (!close.length) { log('nothing closed — index not written.'); return; }
  if (DRY_RUN) { log('dry run — sports-index.json not written.'); return; }
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
  gitCommit(`close-empty-seasons: closed ${close.length} season(s) PlayHQ confirms hold no games`, [INDEX_FILE_REL]);
  log('reopen by clearing locked/closedAt/closedReason on the affected ids.');
}

main().catch(err => { console.error(`FATAL: ${err.stack || err.message}`); process.exit(1); });
