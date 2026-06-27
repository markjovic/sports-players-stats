// scripts/fix-player-names.js
//
// Finds all player files where name is missing or corrupt (season name string),
// fetches the real name from PlayHQ publicProfileStatistics, writes it back,
// and commits in batches.
//
// Usage:
//   node scripts/fix-player-names.js             — find, fetch, fix, commit
//   node scripts/fix-player-names.js --dry-run   — report only, no writes

'use strict';

const fs           = require('fs');
const path         = require('path');
const https        = require('https');
const crypto       = require('crypto');
const { execSync } = require('child_process');

const ROOT         = path.join(__dirname, '..');
const PLAYERS_DIR  = path.join(ROOT, 'players');
const DRY_RUN      = process.argv.includes('--dry-run');
const CONCURRENCY  = 500;
const COMMIT_EVERY = 2000;
const PROGRESS     = path.join(ROOT, 'scripts', '.fix-player-names-progress.json');
const SEASON_RE    = /^(Winter|Summer|Spring|Autumn|Fall)\s+\d{4}/i;

// ─── Headers ─────────────────────────────────────────────────────────────────

const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function post(body, cookie) {
  return new Promise((resolve, reject) => {
    const h = { ...HEADERS, 'request-id': crypto.randomUUID(),
                'content-length': Buffer.byteLength(body) };
    if (cookie) h['Cookie'] = cookie;
    const req = https.request(
      { hostname: 'api.playhq.com', path: '/graphql', method: 'POST',
        headers: h, agent: new https.Agent({ keepAlive: false }) },
      res => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode,
          headers: res.headers, body: Buffer.concat(c).toString() }));
      }
    );
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Session ──────────────────────────────────────────────────────────────────
// Single shared session cookie. One lock prevents parallel refresh attempts.
// Workers track requests against a shared counter; when the counter crosses
// a REFRESH_EVERY threshold the first worker to notice triggers a refresh and
// all others wait on the same lock promise.

let sessionCookie   = null;
let sessionLock     = null;
let sessionRequests = 0;          // total requests made on current session
const REFRESH_EVERY = 25;         // refresh session every 25 requests (safely under 30 quota)

async function refreshSession() {
  // If a refresh is already in progress, wait for it
  if (sessionLock) { await sessionLock; return; }

  sessionLock = (async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const body = JSON.stringify({ operationName: 'TenantConfig', variables: {},
          query: 'query TenantConfig { tenantConfiguration { label } }' });
        const res  = await post(body, null);
        const raw  = res.headers['set-cookie'];
        if (!raw) throw new Error('No Set-Cookie header');
        const parts = (Array.isArray(raw) ? raw.join(', ') : raw)
          .split(',').map(c => c.trim().split(';')[0]);
        const get = n => parts.find(p => p.startsWith(n + '=')) || null;
        const tier = get('phq_tier'), sess = get('phq_session'), sub = get('phq_sub');
        if (!tier || !sess || !sub) throw new Error('Incomplete cookies');
        sessionCookie   = `${tier}; ${sess}; ${sub}`;
        sessionRequests = 0;
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      } catch (e) {
        if (attempt === 5) throw e;
        console.log(`  Session refresh failed (attempt ${attempt}): ${e.message} — retrying in ${attempt * 2}s`);
        await sleep(attempt * 2000);
      }
    }
  })();

  try { await sessionLock; }
  finally { sessionLock = null; }
}

// Called by each worker before making a request.
// Only one worker triggers a refresh; others wait.
async function ensureSession() {
  if (sessionLock) { await sessionLock; return; }
  if (!sessionCookie || sessionRequests >= REFRESH_EVERY) {
    await refreshSession();
  }
}

// ─── Name fetch ───────────────────────────────────────────────────────────────

async function fetchName(uuid) {
  await ensureSession();
  sessionRequests++;

  const body = JSON.stringify({
    operationName: 'ProfileSeasonStatistics',
    variables: { profileID: uuid },
    query: `query ProfileSeasonStatistics($profileID: ID!) {
      publicProfileStatistics(profileID: $profileID) {
        seasonStatistics { name }
      }
    }`,
  });

  const res = await post(body, sessionCookie);
  if (res.status === 403) return null;       // private profile
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const json = JSON.parse(res.body);
  return json?.data?.publicProfileStatistics?.seasonStatistics?.[0]?.name || null;
}

// ─── Git ──────────────────────────────────────────────────────────────────────
// Merge first, then stage changes, then commit.
// No stash — stash/pop drops staged changes when other commits land mid-run.

function gitCommit(msg) {
  if (DRY_RUN) return;
  try {
    // Pull latest so our commit applies cleanly on top
    execSync('git fetch origin main',                   { cwd: ROOT, stdio: 'pipe' });
    execSync('git merge -X ours FETCH_HEAD --no-edit', { cwd: ROOT, stdio: 'pipe' });
    // Stage written player files
    execSync('git add players/',                        { cwd: ROOT, stdio: 'pipe' });
    const staged = execSync('git diff --staged --shortstat',
      { cwd: ROOT, stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 }).toString().trim();
    if (!staged) { console.log('  Nothing to commit.'); return; }
    execSync(`git commit -m "${msg}"`,  { cwd: ROOT, stdio: 'pipe' });
    execSync('git push origin main',    { cwd: ROOT, stdio: 'pipe' });
    console.log(`  Committed: ${msg}`);
  } catch (e) {
    console.error('  git error:', e.stderr?.toString().slice(0, 300) || e.message.slice(0, 300));
  }
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function loadProgress() {
  try { return new Set(JSON.parse(fs.readFileSync(PROGRESS, 'utf8')).done || []); }
  catch { return new Set(); }
}
function saveProgress(done) {
  fs.writeFileSync(PROGRESS, JSON.stringify({ done: [...done] }), 'utf8');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nfix-player-names.js${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log('─'.repeat(60));

  const done = loadProgress();
  if (done.size) console.log(`  Resuming — ${done.size} already done`);

  // Collect targets: players with no name or a corrupt season-name string
  console.log('  Scanning for missing/corrupt names…');
  const targets = [];
  for (const prefix of fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort()) {
    const dir = path.join(PLAYERS_DIR, prefix);
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const uuid = fname.replace('.json', '');
      if (done.has(uuid)) continue;
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
      if (!p.name || SEASON_RE.test(p.name)) targets.push(uuid);
    }
  }

  console.log(`  ${targets.length} players need names\n`);
  if (!targets.length) {
    console.log('  Nothing to do.');
    if (fs.existsSync(PROGRESS)) fs.unlinkSync(PROGRESS);
    return;
  }

  await refreshSession();

  let written = 0, inaccessible = 0, errors = 0, sinceCommit = 0;
  let idx = 0;
  const idxLock = { v: 0 };   // shared index; workers grab next item atomically

  async function worker() {
    while (true) {
      const i = idxLock.v++;
      if (i >= targets.length) break;
      const uuid = targets[i];

      let name = null;
      try {
        name = await fetchName(uuid);
      } catch (e) {
        errors++;
        console.log(`  ✗ ${uuid.slice(0, 8)} ${e.message.slice(0, 80)}`);
        continue;
      }

      done.add(uuid);

      if (!name) { inaccessible++; continue; }

      if (!DRY_RUN) {
        const fpath = path.join(PLAYERS_DIR, uuid.slice(0, 2), `${uuid}.json`);
        try {
          const p = JSON.parse(fs.readFileSync(fpath, 'utf8'));
          p.name = name;
          fs.writeFileSync(fpath, JSON.stringify(p), 'utf8');
        } catch (e) {
          errors++;
          console.log(`  ✗ ${uuid.slice(0, 8)} write: ${e.message.slice(0, 60)}`);
          continue;
        }
      }

      written++;
      sinceCommit++;

      if (!DRY_RUN && sinceCommit >= COMMIT_EVERY) {
        saveProgress(done);
        const remaining = targets.length - idxLock.v;
        gitCommit(`fix-player-names: ${written} names written (${remaining} remaining)`);
        sinceCommit = 0;
        console.log(`  Progress: ${idxLock.v}/${targets.length} — written ${written}, inaccessible ${inaccessible}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (!DRY_RUN) {
    saveProgress(done);
    gitCommit(`fix-player-names: complete — ${written} names written, ${inaccessible} inaccessible`);
    if (fs.existsSync(PROGRESS)) fs.unlinkSync(PROGRESS);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`  Written:      ${written}`);
  console.log(`  Inaccessible: ${inaccessible}`);
  console.log(`  Errors:       ${errors}`);
  console.log('─'.repeat(60));
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
