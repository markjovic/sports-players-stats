// scripts/audit-pending-games-vs-playhq.js
//
// READ-ONLY. Answers one question, and the whole season-lifecycle design depends
// on the answer:
//
//   Games we hold as PENDING in seasons PlayHQ calls COMPLETED — does PlayHQ
//   still call them pending too, or does it have finished games with scores that
//   we never captured?
//
// WRITES NOTHING. No fs.writeFileSync, no git, no commit. Safe to run twice.
//
// WHY IT DECIDES THE DESIGN
// ─────────────────────────
// audit-finished-unlocked-seasons.js measured, 2026-09-08, across the 138
// COMPLETED-but-unlocked seasons: 7,086 games, of which 2,503 read PENDING and 10
// read IN_PROGRESS. Several seasons are wholly unresolved - a9fcd2a0 is 387 of 387
// with an end date of 2020-09-20; 63ef78f5 is 195 of 195; 1c6ddc98 is 194 of 194;
// 39965012 is 104 of 104 and ended 2022-04-03. In an earlier pass those same
// seasons showed zero scored games.
//
// So PlayHQ says the SEASON is complete while a third of its GAMES read pending.
// Both cannot be the whole truth, and only two worlds are possible:
//
//   A. PlayHQ closed these seasons without ever finalising the games. The results
//      do not exist and never will. Locking on age is safe, and the pending rows
//      are simply what an abandoned or paper-scored competition looks like.
//
//   B. PlayHQ holds finished games with scores and our crawl never captured them.
//      Then ANY timer-based lock buries real, recoverable data permanently, and
//      the job is a backfill rather than a lifecycle rule.
//
// This asks PlayHQ and reports which. It does not guess, and it does not average
// the two - a season is reported as one or the other, per game.
//
// THE CALL IS THE NIGHTLY'S OWN
// ─────────────────────────────
// The question is not "what does PlayHQ know" in the abstract, it is "what would
// nightly-crawl.js get if it ran on this season today". So this makes the same two
// calls the nightly makes, in the same order, with the same headers, session and
// failure handling, all copied from nightly-crawl.js and not rewritten:
//   gradeRounds(gradeID)            -> nightly-crawl.js L238, used at L787
//   discoverFixtureByRound(roundID) -> nightly-crawl.js L247, used in phase 2
// A hand-written query here would answer a different question from the one that
// matters.
//
// A 403 that is CloudFront HTML is a transport failure and is reported as such. A
// failure to ASK is never recorded as an ANSWER - that rule is what this whole
// evening was spent undoing.
//
// Run:
//   node scripts/audit-pending-games-vs-playhq.js
//   node scripts/audit-pending-games-vs-playhq.js --seasons=a9fcd2a0,39965012
//   node scripts/audit-pending-games-vs-playhq.js --max-seasons=6 --max-grades=3

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT       = path.join(__dirname, '..');
const INDEX_FILE = path.join(ROOT, 'data', 'sports-index.json');
const GAMES_DIR  = path.join(ROOT, 'games', 'bv');
const API_URL    = 'https://api.playhq.com/graphql';

const args   = process.argv.slice(2);
const argVal = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const ONLY_SEASONS = argVal('seasons', '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_SEASONS  = Math.max(1, parseInt(argVal('max-seasons', '8'), 10) || 8);
const MAX_GRADES   = Math.max(1, parseInt(argVal('max-grades', '4'), 10) || 4);
const LIST_PATHS   = args.includes('--list-paths');

const log   = (m) => console.log(`[pending-vs-playhq] ${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TERMINAL = new Set(['FINAL', 'CANCELLED', 'ABANDONED', 'FORFEIT']);

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

// ─── Season selection ────────────────────────────────────────────────────────
// The seasons worth asking about are COMPLETED, unlocked, have a games file, and
// hold at least one non-terminal game. Ordered worst-first: a season where every
// game is unresolved is the sharpest test of the two worlds.
function selectSeasons() {
  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const all = Object.values(index.seasons || {});
  const out = [];
  for (const s of all) {
    if (s.status !== 'COMPLETED' || s.locked !== false) continue;
    if (ONLY_SEASONS.length && !ONLY_SEASONS.includes(s.id)) continue;
    const file = path.join(GAMES_DIR, `${s.id}.json`);
    if (!fs.existsSync(file)) continue;
    let games;
    try { games = Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')).games || {}); }
    catch { continue; }
    if (!games.length) continue;
    const pending = games.filter(([, g]) => !TERMINAL.has(String(g.st)));
    if (!pending.length) continue;
    out.push({ s, total: games.length, pending, ratio: pending.length / games.length });
  }
  out.sort((a, b) => (b.ratio - a.ratio) || (b.pending.length - a.pending.length));
  return ONLY_SEASONS.length ? out : out.slice(0, MAX_SEASONS);
}

if (LIST_PATHS) {
  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const ids = Object.values(index.seasons || {})
    .filter(s => s.status === 'COMPLETED' && s.locked === false)
    .map(s => s.id);
  const paths = ids.map(id => `games/bv/${id}.json`);
  const out = process.env.GITHUB_OUTPUT;
  console.error(`[pending-vs-playhq] ${ids.length} candidate season file(s)`);
  if (out) fs.appendFileSync(out, `game_files<<SPARSEEOF\n${paths.length ? paths.join('\n') + '\n' : ''}SPARSEEOF\n`);
  console.log(paths.join('\n'));
  process.exit(0);
}

async function main() {
  log('audit-pending-games-vs-playhq  READ-ONLY');
  console.log('─'.repeat(86));

  const seasons = selectSeasons();
  console.log(`  seasons to ask about : ${seasons.length}  (grades per season capped at ${MAX_GRADES})`);
  if (!seasons.length) { log('nothing selected.'); return; }
  for (const x of seasons) {
    console.log(`    ${x.s.id}  ${String(x.s.endDate || '?').padEnd(10)}  ${String(x.pending.length).padStart(4)}/${String(x.total).padEnd(5)} unresolved  ${(x.s.fullName || '').slice(0, 46)}`);
  }
  console.log('');

  await refreshSession();

  // Totals, kept apart on purpose. "still pending at PlayHQ" and "we never asked"
  // are different answers and collapsing them is the whole failure mode.
  let stillPending = 0, nowFinished = 0, notAtPlayHQ = 0, blocked = 0, transient = 0;
  let partialCoverage = 0;
  const examples = [];

  for (const x of seasons) {
    const gradesTotal = (x.s.grades || []).length;
    const grades = (x.s.grades || []).slice(0, MAX_GRADES);
    if (!grades.length) { console.log(`  ${x.s.id}: no grades in the index — cannot ask`); continue; }

    // Our stored status for every game, by game id.
    const ours = new Map(x.pending.map(([gid, g]) => [gid, g]));
    let sPending = 0, sFinished = 0, sAbsent = 0, sFail = 0, asked = 0, gradesOk = 0;

    for (const gr of grades) {
      const r1 = await gqlMain('gradeRounds', Q_GRADE_ROUNDS, { gradeID: gr.id });
      if (r1.kind === 'blocked')   { blocked++;   sFail++; console.log(`    ⛔ ${x.s.id}/${gr.id}: CloudFront BLOCKED — not an answer`); continue; }
      if (r1.kind !== 'ok')        { transient++; sFail++; console.log(`    ⚠ ${x.s.id}/${gr.id}: ${r1.kind} — not an answer`); continue; }
      const rounds = (r1.data && r1.data.discoverGrade && r1.data.discoverGrade.rounds) || [];

      let roundsOk = true;
      for (const rd of rounds) {
        const r2 = await gqlMain('discoverFixtureByRound', Q_FIXTURE_BY_ROUND, { roundID: rd.id });
        if (r2.kind === 'blocked')   { blocked++;   sFail++; roundsOk = false; continue; }
        if (r2.kind !== 'ok')        { transient++; sFail++; roundsOk = false; continue; }
        const games = (r2.data && r2.data.discoverFixtureByRound && r2.data.discoverFixtureByRound.games) || [];

        for (const g of games) {
          if (!ours.has(g.id)) continue;              // only games we hold as unresolved
          asked++;
          const theirStatus = (g.status && g.status.value) || '(none)';
          const hasResult = !!(g.result && ((g.result.home && g.result.home.statistics && g.result.home.statistics.length) ||
                                            (g.result.outcome && g.result.outcome.value)));
          if (TERMINAL.has(String(theirStatus)) || hasResult) {
            sFinished++; nowFinished++;
            if (examples.length < 12) examples.push({ sid: x.s.id, gid: g.id, ours: ours.get(g.id).st, theirs: theirStatus, hasResult });
          } else {
            sPending++; stillPending++;
          }
          ours.delete(g.id);
        }
      }
      if (roundsOk) gradesOk++;
      await sleep(200);
    }

    // ⚠️ THE NOT-RETURNED COUNT ONLY EXISTS UNDER FULL COVERAGE, AND THIS IS WHY.
    // The first version did `sAbsent = ours.size` unconditionally and printed it as
    // "the fixture no longer exists at PlayHQ". `ours` starts as EVERY unresolved
    // game in the season and only shrinks when PlayHQ returns one — so every game in
    // a grade we never queried, and every game in a grade whose call was refused,
    // was counted as a fixture PlayHQ had dropped.
    //
    // Measured 2026-09-08: a9fcd2a0 has 16 grades against MAX_GRADES=4, so 12 were
    // never asked about — it reported 315 "not returned" against 72 asked. 64bbf12f,
    // 39965012 and f5d8954a each had every grade call blocked, asked NOTHING, and
    // still reported 109, 104 and 74. Of 632 reported across the run, almost all was
    // artefact. That is a failure to ASK printed as an ANSWER, in the very tool
    // built to keep those two apart.
    //
    // The fix is not a cleverer sum. A number that is only correct under conditions
    // the run does not check is worse than no number, because it gets quoted later.
    // So: report it ONLY when every grade in the season was queried and every one of
    // their rounds came back. Otherwise say what coverage was achieved and print no
    // count at all.
    const fullCoverage = (gradesOk === gradesTotal);
    if (fullCoverage) {
      sAbsent = ours.size; notAtPlayHQ += sAbsent;
      console.log(`  ${x.s.id}  asked ${String(asked).padStart(4)}  →  still pending ${String(sPending).padStart(4)}   finished at PlayHQ ${String(sFinished).padStart(4)}   not returned ${String(sAbsent).padStart(4)}   failures ${sFail}`);
    } else {
      partialCoverage++;
      console.log(`  ${x.s.id}  asked ${String(asked).padStart(4)}  →  still pending ${String(sPending).padStart(4)}   finished at PlayHQ ${String(sFinished).padStart(4)}   not returned    —   failures ${sFail}   [COVERAGE ${gradesOk}/${gradesTotal} grades — no count produced]`);
    }
  }

  console.log(`\n${'═'.repeat(86)}`);
  console.log(`  still PENDING at PlayHQ too : ${stillPending}   → world A: the result does not exist`);
  console.log(`  FINISHED at PlayHQ          : ${nowFinished}   → world B: we failed to capture it`);
  console.log(`  not returned by PlayHQ      : ${notAtPlayHQ}   → the fixture no longer exists there (FULLY COVERED seasons only)`);
  console.log(`  seasons with partial cover  : ${partialCoverage}   ← no not-returned count produced for these`);
  console.log(`  CloudFront blocked          : ${blocked}   ← NOT an answer`);
  console.log(`  transient failures          : ${transient}   ← NOT an answer`);
  console.log(`${'═'.repeat(86)}`);

  if (examples.length) {
    console.log(`\n  examples of games PlayHQ has finished and we hold as unresolved:`);
    for (const e of examples) console.log(`    season ${e.sid}  game ${e.gid}   ours=${e.ours}  playhq=${e.theirs}  result=${e.hasResult ? 'yes' : 'no'}`);
  }

  if (partialCoverage) {
    console.log(`\n  ${partialCoverage} season(s) had only some of their grades queried — either capped by`);
    console.log(`  --max-grades or refused mid-run. No "not returned" figure is produced for those,`);
    console.log(`  because a game in a grade we never asked about is not a game PlayHQ dropped.`);
    console.log(`  Raise --max-grades to cover them, at the cost of many more calls.`);
  }
  if (blocked || transient) {
    console.log(`\n  \u26a0 ${blocked + transient} call(s) got no answer. This reading is INCOMPLETE — re-run before deciding.`);
  }
  console.log(`\n  If almost everything is "still pending", a season really is finished a couple of`);
  console.log(`  weeks after its last fixture and a lifecycle rule can lock on age safely.`);
  console.log(`  If a meaningful share is "finished at PlayHQ", locking on age would bury data`);
  console.log(`  that is sitting there right now, and the job is a backfill instead.`);
  log('read-only — nothing written, nothing committed.');
}

main().catch(err => { console.error(`FATAL: ${err.stack || err.message}`); process.exit(1); });
