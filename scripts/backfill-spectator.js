// scripts/backfill-spectator.js
//
// Targets all FINAL games without p[] player lists and probes the spectator
// endpoint for each. Writes p[], spc:1, and player stat updates on success.
// Flags games as legacy:1 if spectator returns no data (game too old).
//
// Safe to re-run — skips games already having spc:1 or legacy:1.
//
// Run:     node scripts/backfill-spectator.js
// Dry run: node scripts/backfill-spectator.js --dry-run

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');

const ROOT           = path.join(__dirname, '..');
const DRY_RUN        = process.argv.includes('--dry-run');
const GAMES_DIR      = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR    = path.join(ROOT, 'players');
const PROGRESS_FILE  = path.join(ROOT, 'scripts', '.backfill-spectator-progress.json');
const CONCURRENCY    = 3;
const COMMIT_EVERY   = 200;  // games per commit

const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
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
const API_URL = 'https://api.playhq.com/graphql';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJson(p, d) {
  fs.writeFileSync(p, JSON.stringify(d), 'utf8');
}

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
          method: 'POST',
          headers: { ...HEADERS_MAIN, 'request-id': crypto.randomUUID() },
          body: JSON.stringify({
            operationName: 'TenantConfig',
            variables: {},
            query: 'query TenantConfig { tenantConfiguration { label } }',
          }),
        });
        const raw = res.headers.get('set-cookie');
        if (!raw) continue;
        const parts = raw.split(',').map(c => c.trim().split(';')[0]);
        sessionCookie = parts.join('; ');
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
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
    id status
    statistics {
      home { players { profileID name playerNumber statistics { type { value } count } } }
      away { players { profileID name playerNumber statistics { type { value } count } } }
    }
  }
}`;

async function probeSpectator(gameId) {
  if (!sessionCookie) await refreshSession();
  try {
    const res = await fetch(SPECTATOR_URL, {
      method: 'POST',
      headers: { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie },
      body: JSON.stringify({ operationName: 'game', variables: { id: gameId }, query: Q_SPECTATOR }),
    });
    if (res.status === 403) {
      await refreshSession();
      const retry = await fetch(SPECTATOR_URL, {
        method: 'POST',
        headers: { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie },
        body: JSON.stringify({ operationName: 'game', variables: { id: gameId }, query: Q_SPECTATOR }),
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

// ── Player file update ────────────────────────────────────────────────────────

function updatePlayerFromSpectator(uuid, seasonId, gameId, pts, pt3, fouls) {
  const shard = uuid.slice(0, 2).toLowerCase();
  const file  = path.join(PLAYERS_DIR, shard, `${uuid}.json`);
  if (!fs.existsSync(file)) return false;
  let player;
  try { player = readJson(file); } catch (_) { return false; }

  if (!player.sports)            player.sports = {};
  if (!player.sports.Basketball) player.sports.Basketball = {};
  const bk = player.sports.Basketball;
  if (!bk.foulOuts || typeof bk.foulOuts !== 'object') bk.foulOuts = {};
  if (bk.maxGamePTS     === undefined) bk.maxGamePTS     = 0;
  if (bk.maxGameThreePt === undefined) bk.maxGameThreePt = 0;
  if (!player.records) player.records = {};

  let changed = false;
  if (pts > (bk.maxGamePTS ?? 0)) {
    bk.maxGamePTS = pts;
    player.records.maxGamePTS = { v: pts, gameKey: gameId, sid: seasonId };
    changed = true;
  }
  if (pt3 > (bk.maxGameThreePt ?? 0)) {
    bk.maxGameThreePt = pt3;
    player.records.maxGameThreePt = { v: pt3, gameKey: gameId, sid: seasonId };
    changed = true;
  }
  if (fouls >= 5) {
    bk.foulOuts[seasonId] = (bk.foulOuts[seasonId] || 0) + 1;
    changed = true;
  }

  if (changed && !DRY_RUN) {
    delete bk.statsChecked; // trigger matrix re-fetch
    writeJson(file, player);
  }
  return changed;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('backfill-spectator.js');
  if (DRY_RUN) console.log('  ⚠  DRY RUN');
  console.log('─'.repeat(50));

  // Load progress
  let done = new Set();
  if (fs.existsSync(PROGRESS_FILE)) {
    try { done = new Set(readJson(PROGRESS_FILE).done || []); }
    catch (_) {}
  }

  // Scan all game files for targets: FINAL, no p[], no spc, no legacy, not forfeit
  console.log('Scanning game files for targets...');
  const targets = []; // { gameId, seasonId }
  const sids = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));

  for (const sid of sids) {
    let gf;
    try { gf = readJson(path.join(GAMES_DIR, `${sid}.json`)); } catch (_) { continue; }
    for (const [gameId, game] of Object.entries(gf.games || {})) {
      if (done.has(gameId))            continue; // already processed
      if (game.spc || game.legacy)     continue; // already handled
      if (game.forfeit || game.cancelled || game.abandoned || game.bye) continue;
      if (game.st !== 'FINAL')         continue; // not final
      if (game.p && game.p.length > 0) continue; // already has players
      targets.push({ gameId, seasonId: sid });
    }
  }

  console.log(`  ${sids.length} season files scanned`);
  console.log(`  ${targets.length} games need spectator probe (${done.size} already done)`);
  console.log();

  if (targets.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  await refreshSession();

  let hits = 0, legacy = 0, errors = 0, playerUpdates = 0, sinceCommit = 0;

  // Process in pool
  let taskIdx = 0;
  async function worker() {
    while (taskIdx < targets.length) {
      const { gameId, seasonId } = targets[taskIdx++];

      const game = await probeSpectator(gameId);
      done.add(gameId);

      // Load game file
      const gfPath = path.join(GAMES_DIR, `${seasonId}.json`);
      let gf;
      try { gf = readJson(gfPath); } catch (_) { errors++; continue; }

      if (!gf.games[gameId]) { errors++; continue; }

      if (!game?.statistics) {
        // Spectator has no data — mark as legacy
        gf.games[gameId].legacy = true;
        legacy++;
      } else {
        const homePlayers = game.statistics?.home?.players || [];
        const awayPlayers = game.statistics?.away?.players || [];
        const allPlayers  = [...homePlayers, ...awayPlayers];

        // Write p[] and spc:1
        gf.games[gameId].p = allPlayers.map(p => ({
          id: p.profileID,
          n:  p.name || `Player #${(p.profileID || '').slice(0, 10)}`,
        })).filter(p => p.id);
        gf.games[gameId].spc = 1;

        // Update player stats
        for (const p of allPlayers) {
          if (!p.profileID) continue;
          const pts   = statValue(p.statistics, 'TOTAL_SCORE');
          const pt3   = statValue(p.statistics, '3_POINT_SCORE');
          const fouls = statValue(p.statistics, 'TOTAL_FOULS');
          if (updatePlayerFromSpectator(p.profileID, seasonId, gameId, pts, pt3, fouls)) {
            playerUpdates++;
          }
        }
        hits++;
      }

      if (!DRY_RUN) writeJson(gfPath, gf);
      sinceCommit++;

      const total = hits + legacy + errors;
      if (total % 50 === 0) {
        process.stdout.write(
          `  ${total}/${targets.length} — hits: ${hits}  legacy: ${legacy}  errors: ${errors}\r`
        );
      }

      if (sinceCommit >= COMMIT_EVERY && !DRY_RUN) {
        writeJson(PROGRESS_FILE, { done: [...done] });
        await gitCommit(
          `backfill-spectator: ${hits} hits, ${legacy} legacy, ${done.size} total done`
        );
        sinceCommit = 0;
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker);
  await Promise.all(workers);

  console.log(`\n  ${targets.length} games processed`);

  // Final commit
  if (!DRY_RUN && sinceCommit > 0) {
    writeJson(PROGRESS_FILE, { done: [...done] });
    await gitCommit(
      `backfill-spectator: complete — ${hits} hits, ${legacy} legacy, ${playerUpdates} player updates`
    );
    // Clean up progress file
    if (fs.existsSync(PROGRESS_FILE)) {
      fs.unlinkSync(PROGRESS_FILE);
      await gitCommit('backfill-spectator: remove progress file');
    }
  }

  console.log('─'.repeat(50));
  console.log(`  Spectator hits:    ${hits}`);
  console.log(`  Marked legacy:     ${legacy}`);
  console.log(`  Errors:            ${errors}`);
  console.log(`  Player updates:    ${playerUpdates}`);
  if (DRY_RUN) console.log('  ⚠  DRY RUN — nothing written');
}

main().catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); });
