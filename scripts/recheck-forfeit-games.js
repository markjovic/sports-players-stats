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
const https        = require('https');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT       = path.join(__dirname, '..');
const DRY_RUN    = process.argv.includes('--dry-run');
const GAMES_DIR  = path.join(ROOT, 'games', 'bv');
const FORFEIT_FILE = path.join(ROOT, 'forfeit-games.json');
const REQUEST_DELAY  = 200;
const COMMIT_EVERY   = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
        headers: h, agent: new https.Agent({ keepAlive: false }) },
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

async function gitCommit(msg) {
  if (DRY_RUN) { console.log(`  [dry-run] ${msg}`); return; }
  try {
    execSync('git add games/ forfeit-games.json', { stdio: 'pipe', cwd: ROOT });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim();
    if (!diff) { return; }
    execSync(`git commit -m "${msg.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT });
    execSync('git fetch origin main', { stdio: 'pipe', cwd: ROOT });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
    execSync('git push origin main', { stdio: 'pipe', cwd: ROOT });
    console.log(`  ✓ ${msg}`);
  } catch (e) { console.error(`  git error: ${e.message}`); }
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

  // Find candidate games: 20-0 or 0-20, not already forfeit-flagged
  console.log('\nScanning game files for 20-0 / 0-20 candidates…');
  const candidates = [];  // { gameId, sid }
  const gameFileCache = new Map();  // sid → gf (for writing back)

  const gameFiles = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')).sort();
  let scanned = 0;

  for (const fname of gameFiles) {
    const sid = fname.replace('.json', '');
    let gf;
    try { gf = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, fname), 'utf8')); }
    catch (_) { continue; }
    scanned++;
    for (const [gameId, game] of Object.entries(gf.games || {})) {
      if (game.forfeit) continue;            // already flagged
      if (forfeitIds.has(gameId)) continue;  // already in index
      const hs = game.hs, as_ = game.as;
      if ((hs === 20 && as_ === 0) || (hs === 0 && as_ === 20)) {
        candidates.push({ gameId, sid });
        if (!gameFileCache.has(sid)) gameFileCache.set(sid, gf);
      }
    }
    if (scanned % 500 === 0) process.stdout.write(`  ${scanned}/${gameFiles.length}\r`);
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
  const newlyConfirmed = [];

  for (const { gameId, sid } of candidates) {
    if (probed > 0 && probed % 30 === 0) {
      await refreshSession();
    }

    let result;
    try {
      const { status, body } = await doFetch(
        { operationName: 'discoverGame', variables: { gameID: gameId },
          query: Q_DISCOVER_GAME },
        { 'Cookie': sessionCookie }
      );
      if (status !== 200 || body.errors) { errors++; await sleep(REQUEST_DELAY); probed++; continue; }
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
        newlyConfirmed.push(gameId);

        // Update game entry in cache
        const gf = gameFileCache.get(sid);
        if (gf?.games?.[gameId]) {
          const winnerValue = result.result?.winner?.value;
          const game = gf.games[gameId];
          game.forfeit = true;
          const homeId = game.h || game.t1 || null;
          const awayId = game.a || game.t2 || null;
          game.fo = winnerValue === 'HOME' ? homeId : winnerValue === 'AWAY' ? awayId : null;
          sinceCommit++;
        }
      } else {
        notForfeit++;
      }
    }

    if (probed % 100 === 0)
      process.stdout.write(`  ${probed}/${candidates.length}  confirmed: ${confirmed}\r`);

    if (sinceCommit >= COMMIT_EVERY) {
      // Write updated game files
      const dirtySids = new Set(newlyConfirmed.slice(-COMMIT_EVERY).map(id => {
        const c = candidates.find(c => c.gameId === id);
        return c?.sid;
      }).filter(Boolean));

      if (!DRY_RUN) {
        for (const s of dirtySids) {
          const gf = gameFileCache.get(s);
          if (gf) fs.writeFileSync(path.join(GAMES_DIR, `${s}.json`), JSON.stringify(gf));
        }
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
    // Write all dirty game files
    const processedSids = new Set(newlyConfirmed.map(id => candidates.find(c => c.gameId === id)?.sid).filter(Boolean));
    for (const s of processedSids) {
      const gf = gameFileCache.get(s);
      if (gf) fs.writeFileSync(path.join(GAMES_DIR, `${s}.json`), JSON.stringify(gf));
    }
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
