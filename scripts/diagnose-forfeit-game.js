// scripts/diagnose-forfeit-game.js
//
// READ-ONLY diagnostic — probe ONE game's discoverGame result and compare it to
// the stored record. Writes nothing, commits nothing.
//
// ── Why (OUTSTANDING_TASKS §2.2) ─────────────────────────────────────────────
// ba9d21fe (season 68f8c050, 2026-06-05, Warranwood Warriors vs GSLPS Thunder):
// `fo` names the away team as the forfeit WINNER while the scoreline says 10-0
// to home. One of 26 non-0-0 forfeits; the other 25 agree with themselves.
//
// `fo` semantics were settled from BOTH writers before this was built, not from
// the field name: nightly-crawl.js L686 and recheck-forfeit-games.js both write
// `fo = winner's team id` (winnerSide === 'AWAY' ? awayTeam.id : ...). So the
// record genuinely disagrees with itself, and only the API can say which half is
// right TODAY. nightly-crawl.js L659's entry-build explains how the state can
// arise: hs/as only overlay when non-null, so a stale score can ride beneath a
// fresher forfeit/fo — the same preserved-field mechanics as the legacy flags.
//
// This script probes and REPORTS. It deliberately does not repair: 1 game,
// human decision, and the repair differs depending on which side is wrong
// (fix fo, or fix hs/as, or both — see the verdict text).
//
// Network plumbing (HEADERS / doFetch / refreshSession / Q_DISCOVER_GAME) is
// copied VERBATIM from scripts/recheck-forfeit-games.js — the exercised script
// for this exact call class. Do not "improve" the query here.
//
// Usage:
//   node scripts/diagnose-forfeit-game.js --game=ba9d21fe --season=68f8c050
//
// Exit codes: 0 = probe answered (read the verdict), 1 = could not answer.

'use strict';
const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');

const ROOT      = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games', 'bv');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const GAME_ID = ARGS.game   || null;
const SEASON  = ARGS.season || null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── VERBATIM from recheck-forfeit-games.js — do not edit ─────────────────────
const HEADERS = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

function doFetch(bodyObj, extraHeaders) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const h    = { ...HEADERS, ...extraHeaders, 'request-id': crypto.randomUUID(),
                   'content-length': Buffer.byteLength(body) };
    const req  = https.request(
      { hostname: 'api.playhq.com', path: '/graphql', method: 'POST',
        headers: h, agent: new https.Agent({ keepAlive: false }),
        timeout: 15000 },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, rawCookies: res.headers['set-cookie'],
                          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (e) { reject(e); }
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let sessionCookie = null;
async function refreshSession() {
  const body = { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const { rawCookies } = await doFetch(body, {});
      if (!rawCookies) continue;
      const arr = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
        .map(c => c.split(';')[0].trim());
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

const Q_DISCOVER_GAME = `query discoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) {
    id
    result {
      outcome { name value }
      winner { name value }
      home { outcome { name value } }
      away { outcome { name value } }
    }
  }
}`;
// ── end verbatim block ────────────────────────────────────────────────────────

// Which of the game's own teams does the stored fo name? (fo = WINNER id.)
function foSide(g) {
  if (g.fo === undefined || g.fo === null || g.fo === '') return 'ABSENT';
  if (g.fo === g.h || g.fo === g.t1) return 'HOME';
  if (g.fo === g.a || g.fo === g.t2) return 'AWAY';
  return 'NEITHER-TEAM';
}

function scoreSide(g) {
  if (typeof g.hs !== 'number' || typeof g.as !== 'number') return 'NO-SCORE';
  if (g.hs === g.as) return 'TIE';
  return g.hs > g.as ? 'HOME' : 'AWAY';
}

// Pure verdict — exported for the offline test harness (directive 17: logic
// that has not been executed is a theory).
function verdict(stored, api) {
  const L = [];
  const sFo    = foSide(stored);
  const sScore = scoreSide(stored);
  const outcome    = api?.result?.outcome?.value ?? '(null)';
  const apiWinner  = api?.result?.winner?.value  ?? '(null)';   // 'HOME' | 'AWAY'
  const homeOut    = api?.result?.home?.outcome?.value ?? '(null)';
  const awayOut    = api?.result?.away?.outcome?.value ?? '(null)';

  L.push('STORED RECORD');
  L.push(`  ${stored.hn ?? stored.t1n ?? '?'} (home) vs ${stored.an ?? stored.t2n ?? '?'} (away)  d=${stored.d ?? '?'}  st=${stored.st ?? '?'}`);
  L.push(`  score ${stored.hs ?? '?'}-${stored.as ?? '?'}  -> scoreline winner: ${sScore}`);
  L.push(`  forfeit=${stored.forfeit === true}  fo=${stored.fo ?? '(absent)'}  -> fo (winner id) names: ${sFo}`);
  L.push('');
  L.push('API (discoverGame, today)');
  L.push(`  outcome=${outcome}  winner=${apiWinner}  home.outcome=${homeOut}  away.outcome=${awayOut}`);
  L.push('');

  const isForfeit = String(outcome).includes('FORFEIT');
  if (!isForfeit) {
    L.push('VERDICT: API no longer reports a FORFEIT outcome at all.');
    L.push('  Both the stored forfeit flag AND fo are stale; the scoreline is the record.');
    L.push('  Repair: remove forfeit/fo from this game and drop it from data/forfeit-games.json.');
    return { text: L.join('\n'), answered: true, apiWinner, agrees: null };
  }

  if (apiWinner !== 'HOME' && apiWinner !== 'AWAY') {
    L.push('VERDICT: API confirms FORFEIT but reports no usable winner value.');
    L.push('  The probe cannot settle fo-vs-score. Do not guess — leave the record as-is');
    L.push('  and record this outcome in OUTSTANDING §2.2.');
    return { text: L.join('\n'), answered: false, apiWinner, agrees: null };
  }

  const foAgrees    = sFo === apiWinner;
  const scoreAgrees = sScore === apiWinner;
  L.push(`VERDICT: API winner is ${apiWinner}.`);
  L.push(`  stored fo    ${foAgrees    ? 'AGREES'    : 'DISAGREES'} (${sFo})`);
  L.push(`  stored score ${scoreAgrees ? 'AGREES'    : 'DISAGREES'} (${sScore})`);
  if (foAgrees && !scoreAgrees) {
    L.push('  -> fo is RIGHT, the scoreline is the stale half. Repair: correct hs/as to the');
    L.push('     forfeit convention (winner 20, loser 0) or clear them; fo untouched.');
  } else if (!foAgrees && scoreAgrees) {
    L.push('  -> the scoreline is RIGHT, fo is the stale half. Repair: rewrite fo to the');
    L.push(`     ${apiWinner === 'HOME' ? 'home' : 'away'} team id; scores untouched.`);
  } else if (foAgrees && scoreAgrees) {
    L.push('  -> both halves agree with the API — the stored record is NOT self-contradictory');
    L.push('     under fo=winner semantics. Re-check the reading that flagged it.');
  } else {
    L.push('  -> BOTH halves disagree with the API. Repair both from this response.');
  }
  return { text: L.join('\n'), answered: true, apiWinner, agrees: { foAgrees, scoreAgrees } };
}

async function main() {
  if (!GAME_ID || !SEASON) {
    console.error('usage: node scripts/diagnose-forfeit-game.js --game=<gameId> --season=<sid>');
    process.exit(1);
  }

  let gf;
  try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${SEASON}.json`), 'utf8')); }
  catch (e) { console.error(`cannot read games/bv/${SEASON}.json: ${e.message}`); process.exit(1); }
  const stored = gf.games?.[GAME_ID];
  if (!stored) { console.error(`game ${GAME_ID} not found in season ${SEASON}`); process.exit(1); }

  await refreshSession();

  let api = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { status, body } = await doFetch(
        { operationName: 'discoverGame', variables: { gameID: GAME_ID }, query: Q_DISCOVER_GAME },
        { 'Cookie': sessionCookie }
      );
      if (status === 200 && !body.errors) { api = body.data?.discoverGame ?? null; break; }
      console.error(`  probe attempt ${attempt}: HTTP ${status}${body.errors ? ' + GraphQL errors' : ''}`);
    } catch (e) { console.error(`  probe attempt ${attempt}: ${e.message}`); }
    await sleep(attempt * 2000);
  }

  if (api === null) {
    console.log('discoverGame returned NULL (or the probe failed 3x).');
    console.log('A null here means the game is hidden/withdrawn from discovery — the probe');
    console.log('cannot settle fo-vs-score. Nothing written; record the outcome in §2.2.');
    process.exit(1);
  }

  const v = verdict(stored, api);
  console.log('');
  console.log(v.text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + v.text + '\n```\n'); } catch (_) {}
  }
  process.exit(v.answered ? 0 : 1);
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
module.exports = { verdict, foSide, scoreSide };
