// scripts/recheck-forfeit-games.js
//
// Probes games with exactly 20-0 or 0-20 scores that are NOT currently
// marked forfeit:true, using discoverGame to check the outcome value.
// Updates game files and forfeit-games.json for confirmed forfeits.
//
// Run AFTER build-forfeit-index.js.
//
// Usage:
//   node scripts/recheck-forfeit-games.js
//   node scripts/recheck-forfeit-games.js --dry-run

'use strict';
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT         = path.join(__dirname, '..');
const DRY_RUN      = process.argv.includes('--dry-run');
const GAMES_DIR    = path.join(ROOT, 'games', 'bv');
const FORFEIT_FILE = path.join(ROOT, 'data', 'forfeit-games.json');
const REQUEST_DELAY  = 100;
const COMMIT_EVERY   = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const HEADERS = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

const API_URL = 'https://api.playhq.com/graphql';

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
// ⚠️ 2026-10-05 §6.62 — FORCED CHANGES FROM THE CONVERSION, both named in the report:
//   · the old client's hand-rolled `timeout: 15000` is gone. fetch() has no built-in
//     timeout; re-adding one would mean editing the pasted client, which is the one
//     thing that must not drift. A hung request now hangs rather than erroring at 15s.
//   · the old client REJECTED when the body was not JSON. This one returns body:null,
//     so every caller that tested `body.errors` now tests `!body || body.errors`.

let sessionCookie = null;
async function refreshSession() {
  const body = { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const { rawCookies, status, rawText } = await doFetch(API_URL, body, HEADERS);
      if (!rawCookies) {
        // 2026-10-05 §6.62 — closes the 2026-09-29 instrumentation gap. Logging only.
        const blocked = /cloudfront|Request blocked|ERROR: The request could not be satisfied/i.test(rawText || '');
        const detail = blocked
          ? `CLOUDFRONT-BLOCK (${(rawText || '').length}b HTML)`
          : (rawText || '').slice(0, 160).replace(/\s+/g, ' ');
        console.log(`  \u26a0 session attempt ${attempt} ${body.operationName}: HTTP ${status}, NO set-cookie, body: ${detail || '(empty)'}`);
        continue;
      }
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

async function gitCommit(msg) {
  if (DRY_RUN) { console.log(`  [dry-run] ${msg}`); return; }
  try {
    execSync('git add games/ data/forfeit-games.json', { stdio: 'pipe', cwd: ROOT });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim();
    if (!diff) { return; }
    execSync(`git commit -m "${msg.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT });
    execSync('git fetch origin main', { stdio: 'pipe', cwd: ROOT });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
    execSync('git push origin main', { stdio: 'pipe', cwd: ROOT });
    console.log(`  ✓ ${msg}`);
  } catch (e) { console.error(`  git error: ${e.message}`); }
}

// Read a game file from disk (no caching)
function readGameFile(sid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${sid}.json`), 'utf8'));
  } catch (_) {
    return null;
  }
}

// Write a game file to disk immediately
function writeGameFile(sid, gf) {
  if (DRY_RUN) return;
  fs.writeFileSync(path.join(GAMES_DIR, `${sid}.json`), JSON.stringify(gf));
}

async function main() {
  console.log('recheck-forfeit-games.js');
  if (DRY_RUN) console.log('  ⚠  DRY RUN');
  console.log('─'.repeat(50));

  // Load existing forfeit index
  const forfeitIds = new Set();
  try {
    const existing = JSON.parse(fs.readFileSync(FORFEIT_FILE, 'utf8'));
    for (const id of (Array.isArray(existing) ? existing : [])) forfeitIds.add(id);
    console.log(`Existing forfeit index: ${forfeitIds.size} games`);
  } catch (_) {
    console.log('No existing forfeit-games.json — run build-forfeit-index.js first');
  }

  // Find candidate games: 20-0 or 0-20, not already forfeit-flagged.
  // Only store (gameId, sid) pairs — do NOT cache file contents.
  console.log('\nScanning game files for 20-0 / 0-20 candidates…');
  const candidates = [];  // { gameId, sid }

  const gameFiles = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort();
  let scanned = 0;

  for (const fname of gameFiles) {
    const sid = fname.replace('.json', '');
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); }
    catch (_) { continue; }
    scanned++;
    for (const [gameId, game] of Object.entries(gf.games || {})) {
      if (game.forfeit) continue;
      if (forfeitIds.has(gameId)) continue;
      const hs = game.hs, as_ = game.as;
      if ((hs === 20 && as_ === 0) || (hs === 0 && as_ === 20)) {
        candidates.push({ gameId, sid });
      }
    }
    // Release the parsed object immediately — do not hold a reference
    if (scanned % 500 === 0) console.log(`  ${scanned}/${gameFiles.length}`);
  }

  console.log(`\n  Seasons scanned:  ${scanned}`);
  console.log(`  Candidates:       ${candidates.length}`);

  if (candidates.length === 0) {
    console.log('\nNo candidates to probe. Done.');
    return;
  }

  await refreshSession();

  let probed = 0, confirmed = 0, notForfeit = 0, nullReturned = 0, errors = 0;
  let sinceCommit = 0;

  for (const { gameId, sid } of candidates) {
    if (probed > 0 && probed % 30 === 0) {
      await refreshSession();
    }

    let result;
    try {
      const { status, body } = await doFetch(
        API_URL,
        { operationName: 'discoverGame', variables: { gameID: gameId },
          query: Q_DISCOVER_GAME },
        { ...HEADERS, 'Cookie': sessionCookie }
      );
      if (status !== 200 || !body || body.errors) { errors++; await sleep(REQUEST_DELAY); probed++; continue; }
      result = body.data?.discoverGame;
    } catch (_) { errors++; await sleep(REQUEST_DELAY); probed++; continue; }

    probed++;

    if (!result) {
      nullReturned++;
    } else {
      const outcomeValue = result.result?.outcome?.value || '';
      const isForfeit    = outcomeValue.includes('FORFEIT');

      if (isForfeit) {
        confirmed++;
        forfeitIds.add(gameId);

        // Read → patch → write immediately; no in-memory cache
        const gf = readGameFile(sid);
        if (gf?.games?.[gameId]) {
          const winnerValue = result.result?.winner?.value;
          const game = gf.games[gameId];
          game.forfeit = true;
          const homeId = game.h || game.t1 || null;
          const awayId = game.a || game.t2 || null;
          game.fo = winnerValue === 'HOME' ? homeId : winnerValue === 'AWAY' ? awayId : null;
          writeGameFile(sid, gf);
        }

        sinceCommit++;
      } else {
        notForfeit++;
      }
    }

    if (probed % 100 === 0)
      console.log(`  ${probed}/${candidates.length}  confirmed: ${confirmed}`);

    if (sinceCommit >= COMMIT_EVERY) {
      if (!DRY_RUN) {
        fs.writeFileSync(FORFEIT_FILE, JSON.stringify([...forfeitIds].sort()));
      }
      await gitCommit(`recheck-forfeit-games: ${confirmed} forfeits confirmed (${probed}/${candidates.length} probed)`);
      sinceCommit = 0;
    }

    await sleep(REQUEST_DELAY);
  }

  console.log(`\n  ${probed}/${candidates.length} probed`);

  // Final write
  if (!DRY_RUN) {
    fs.writeFileSync(FORFEIT_FILE, JSON.stringify([...forfeitIds].sort()));
  }
  await gitCommit(`recheck-forfeit-games: complete — ${confirmed} new forfeits confirmed from ${candidates.length} candidates`);

  console.log('─'.repeat(50));
  console.log(`  Candidates probed: ${probed}`);
  console.log(`  Confirmed forfeit: ${confirmed}`);
  console.log(`  Not forfeit:       ${notForfeit}`);
  console.log(`  Null (hidden):     ${nullReturned}`);
  console.log(`  Errors:            ${errors}`);
  console.log(`  Total in index:    ${forfeitIds.size}`);
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
