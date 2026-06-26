// scripts/backfill-hidden-boxscores.js
//
// Targets hidden FINAL games that were reclassified (hidden:true set by nightly
// Phase 1b) but have no box score stored (no hp/ap arrays, no spc:1).
//
// For each: probes spectator, writes hs/as scores + hp/ap box scores + p[] + spc:1.
// Clears statsChecked on players so the matrix re-fetches their stats.
// Marks games as legacy:true if spectator returns no data.
//
// Safe to re-run — skips games already having spc:1, legacy:1, or hp/ap.
//
// Run:     node scripts/backfill-hidden-boxscores.js
// Dry run: node scripts/backfill-hidden-boxscores.js --dry-run

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');

const ROOT          = path.join(__dirname, '..');
const DRY_RUN       = process.argv.includes('--dry-run');
const GAMES_DIR     = path.join(ROOT, 'games', 'bv');
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.backfill-hidden-boxscores-progress.json');
const CONCURRENCY   = 3;
const COMMIT_EVERY  = 200;

const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const API_URL       = 'https://api.playhq.com/graphql';

const HEADERS_SPECTATOR = {
  'accept':       'application/json',
  'content-type': 'application/json',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'x-phq-tenant': 'bv',
  'tenant':       'bv',
};
const HEADERS_MAIN = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d), 'utf8'); }

async function gitCommit(message) {
  if (DRY_RUN) { console.log(`  [dry-run] ${message}`); return; }
  try {
    execSync('git add -A', { stdio: 'pipe', cwd: ROOT });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe', cwd: ROOT }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message.replace(/"/g, "'")}"`, { stdio: 'pipe', cwd: ROOT });
    execSync('git fetch origin main', { stdio: 'pipe', cwd: ROOT });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { stdio: 'pipe', cwd: ROOT });
    execSync('git push origin main', { stdio: 'pipe', cwd: ROOT });
    console.log(`  ✓ ${message}`);
  } catch (e) { console.error(`  git error: ${e.message}`); }
}

// ── Session ───────────────────────────────────────────────────────────────────

let sessionCookie = null;
let sessionLock   = null;

async function refreshSession() {
  if (sessionLock) return sessionLock;
  sessionLock = (async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) await sleep(attempt * 3000);
      try {
        const res = await fetch(API_URL, {
          method:  'POST',
          headers: { ...HEADERS_MAIN, 'request-id': crypto.randomUUID() },
          body:    JSON.stringify({ operationName: 'TenantConfig', variables: {},
                     query: 'query TenantConfig { tenantConfiguration { label } }' }),
        });
        const raw = res.headers.get('set-cookie');
        if (!raw) continue;
        const parts = raw.split(',').map(c => c.trim().split(';')[0]);
        const get = n => parts.find(p => p.startsWith(n + '=')) || null;
        const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
        if (tier && session && sub) {
          sessionCookie = `${tier}; ${session}; ${sub}`;
          console.log(`  Session refreshed (attempt ${attempt})`);
          return;
        }
      } catch (_) {}
    }
    throw new Error('Failed to obtain session after 5 attempts');
  })();
  await sessionLock;
  sessionLock = null;
}

// ── Spectator ─────────────────────────────────────────────────────────────────

const Q_SPECTATOR = `query game($id: ID!) {
  game(id: $id) {
    id
    statistics {
      home {
        score
        players { profileID name playerNumber statistics { type { value } count } }
      }
      away {
        score
        players { profileID name playerNumber statistics { type { value } count } }
      }
    }
  }
}`;

async function probeSpectator(gameId) {
  if (!sessionCookie) await refreshSession();
  const body = JSON.stringify({ operationName: 'game', variables: { id: gameId }, query: Q_SPECTATOR });
  try {
    const res = await fetch(SPECTATOR_URL, {
      method:  'POST',
      headers: { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie },
      body,
    });
    if (res.status === 403) {
      await refreshSession();
      const retry = await fetch(SPECTATOR_URL, {
        method:  'POST',
        headers: { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie },
        body,
      });
      if (!retry.ok) return null;
      const data = await retry.json();
      return data?.data?.game || null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.game || null;
  } catch (_) { return null; }
}

function statValue(statistics, typeValue) {
  for (const s of (statistics || [])) {
    if (s.type?.value === typeValue) return s.count ?? 0;
  }
  return 0;
}

function parsePlayers(players) {
  return (players || [])
    .filter(p => p.profileID)
    .map(p => ({
      profileID: p.profileID,
      name:      p.name || `Player #${p.profileID.slice(0, 10)}`,
      number:    p.playerNumber ?? null,
      pts:       statValue(p.statistics, 'TOTAL_SCORE'),
      pt1:       statValue(p.statistics, '1_POINT_SCORE'),
      pt2:       statValue(p.statistics, '2_POINT_SCORE'),
      pt3:       statValue(p.statistics, '3_POINT_SCORE'),
      fouls:     statValue(p.statistics, 'TOTAL_FOULS'),
    }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('backfill-hidden-boxscores.js');
  if (DRY_RUN) console.log('  ⚠  DRY RUN');
  console.log('─'.repeat(50));

  // Load progress
  let done = new Set();
  if (fs.existsSync(PROGRESS_FILE)) {
    try { done = new Set(readJson(PROGRESS_FILE).done || []); } catch (_) {}
  }

  // Scan for targets: hidden FINAL games without box scores
  console.log('Scanning game files for targets...');
  const targets = [];
  const sids = fs.readdirSync(GAMES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));

  for (const sid of sids) {
    let gf;
    try { gf = readJson(path.join(GAMES_DIR, `${sid}.json`)); } catch (_) { continue; }
    for (const [gameId, game] of Object.entries(gf.games || {})) {
      if (done.has(gameId))                    continue; // already processed
      if (!game.hidden)                        continue; // only hidden games
      if (game.spc || game.legacy)             continue; // already handled
      if (game.forfeit || game.cancelled || game.abandoned) continue;
      if (game.st !== 'FINAL')                 continue; // not final
      if (game.hp && game.hp.length > 0)       continue; // already has box score
      if (game.ap && game.ap.length > 0)       continue;
      targets.push({ gameId, seasonId: sid });
    }
  }

  console.log(`  ${sids.length} season files scanned`);
  console.log(`  ${targets.length} hidden games need box scores (${done.size} already done)`);
  console.log();

  if (targets.length === 0) {
    console.log('Nothing to do.');
    if (fs.existsSync(PROGRESS_FILE)) {
      fs.unlinkSync(PROGRESS_FILE);
      await gitCommit('backfill-hidden-boxscores: remove progress file (complete)');
    }
    return;
  }

  await refreshSession();

  let hits = 0, legacy = 0, errors = 0, sinceCommit = 0;

  let taskIdx = 0;
  async function worker() {
    while (taskIdx < targets.length) {
      const { gameId, seasonId } = targets[taskIdx++];

      const game = await probeSpectator(gameId);
      done.add(gameId);

      const gfPath = path.join(GAMES_DIR, `${seasonId}.json`);
      let gf;
      try { gf = readJson(gfPath); } catch (_) { errors++; continue; }
      if (!gf.games[gameId]) { errors++; continue; }

      if (!game?.statistics) {
        // No spectator data — mark legacy
        gf.games[gameId].legacy = true;
        legacy++;
      } else {
        const homePlayers = parsePlayers(game.statistics?.home?.players);
        const awayPlayers = parsePlayers(game.statistics?.away?.players);
        const allPlayers  = [...homePlayers, ...awayPlayers];

        // Write scores
        const hs = game.statistics?.home?.score ?? null;
        const as_ = game.statistics?.away?.score ?? null;
        if (hs !== null) gf.games[gameId].hs = hs;
        if (as_ !== null) gf.games[gameId].as = as_;

        // Write box scores
        if (homePlayers.length > 0) gf.games[gameId].hp = homePlayers;
        if (awayPlayers.length > 0) gf.games[gameId].ap = awayPlayers;

        // Write p[] player list
        gf.games[gameId].p = allPlayers.map(p => ({
          id: p.profileID,
          n:  p.name,
        }));

        // Set spc:1
        gf.games[gameId].spc = 1;

        hits++;
      }

      if (!DRY_RUN) writeJson(gfPath, gf);
      sinceCommit++;

      const total = hits + legacy + errors;
      if (total % 50 === 0 || total === targets.length) {
        process.stdout.write(`  ${total}/${targets.length} — hits: ${hits}  legacy: ${legacy}  errors: ${errors}\r`);
      }

      if (sinceCommit >= COMMIT_EVERY && !DRY_RUN) {
        writeJson(PROGRESS_FILE, { done: [...done] });
        await gitCommit(
          `backfill-hidden-boxscores: ${hits} hits, ${legacy} legacy, ${done.size} total done`
        );
        sinceCommit = 0;
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker);
  await Promise.all(workers);

  console.log(`\n  Done`);

  // Final commit + cleanup
  if (!DRY_RUN && sinceCommit > 0) {
    writeJson(PROGRESS_FILE, { done: [...done] });
    await gitCommit(
      `backfill-hidden-boxscores: complete — ${hits} hits, ${legacy} legacy`
    );
    if (fs.existsSync(PROGRESS_FILE)) {
      fs.unlinkSync(PROGRESS_FILE);
      await gitCommit('backfill-hidden-boxscores: remove progress file');
    }
  }

  console.log('─'.repeat(50));
  console.log(`  Spectator hits:  ${hits}`);
  console.log(`  Marked legacy:   ${legacy}`);
  console.log(`  Errors:          ${errors}`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
