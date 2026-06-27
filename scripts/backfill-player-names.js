// scripts/backfill-player-names.js
//
// ONE-TIME script: fetches real player names from PlayHQ for all player files
// where player.name is missing (cleared by fix-corrupt-player-names.js).
//
// Uses publicProfileStatistics — same endpoint as fetch-profile-stats.js.
// Only writes the name field. Does not touch stats, seasons, or any other field.
//
// Usage:
//   node scripts/backfill-player-names.js
//   node scripts/backfill-player-names.js --dry-run

'use strict';

const fs           = require('fs');
const path         = require('path');
const https        = require('https');
const crypto       = require('crypto');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const DRY_RUN     = process.argv.includes('--dry-run');
const CONCURRENCY = 500;
const COMMIT_EVERY = 5000;
const PROGRESS_FILE = path.join(ROOT, 'scripts', '.backfill-names-progress.json');

// ─── Required headers — copy exactly from playhq_api_reference.md ────────────
const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',
  'content-type': 'application/json',
};

// ─── Session ──────────────────────────────────────────────────────────────────

let sessionCookie = null;
let sessionLock   = null;

async function refreshSession() {
  if (sessionLock) return sessionLock;
  sessionLock = (async () => {
    const body = JSON.stringify({ operationName: 'TenantConfig', variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }' });
    const res = await httpRequest('api.playhq.com', '/graphql', body, null);
    const raw = res.headers['set-cookie'];
    if (!raw) throw new Error('No Set-Cookie on session refresh');
    const parts = (Array.isArray(raw) ? raw.join(', ') : raw).split(',').map(c => c.trim().split(';')[0]);
    const get = n => parts.find(p => p.startsWith(n + '=')) || null;
    const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
    if (!tier || !session || !sub) throw new Error('Incomplete session cookies');
    sessionCookie = `${tier}; ${session}; ${sub}`;
    console.log('  Session refreshed');
  })().finally(() => { sessionLock = null; });
  return sessionLock;
}

function httpRequest(hostname, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const h = { ...HEADERS, 'request-id': crypto.randomUUID(),
                'content-length': Buffer.byteLength(body) };
    if (cookie) h['Cookie'] = cookie;
    const req = https.request(
      { hostname, path: urlPath, method: 'POST', headers: h,
        agent: new https.Agent({ keepAlive: false }) },
      res => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
          body: Buffer.concat(c).toString() }));
      }
    );
    req.on('error', reject);
    req.write(body); req.end();
  });
}

const QUERY = {
  operationName: 'ProfileSeasonStatistics',
  query: `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics { name }
  }
}`,
};

async function fetchName(uuid) {
  if (!sessionCookie) await refreshSession();
  const body = JSON.stringify({ ...QUERY, variables: { profileID: uuid } });
  let res;
  try {
    res = await httpRequest('api.playhq.com', '/graphql', body, sessionCookie);
  } catch (e) {
    return { status: 'error', err: e };
  }
  if (res.status === 403) return { status: 'inaccessible' };
  if (res.status !== 200) return { status: 'error', err: new Error(`HTTP ${res.status}`) };
  let json;
  try { json = JSON.parse(res.body); } catch (e) { return { status: 'error', err: e }; }
  const name = json?.data?.publicProfileStatistics?.seasonStatistics?.[0]?.name || null;
  return { status: 'ok', name };
}

// ─── Git ──────────────────────────────────────────────────────────────────────

async function gitCommit(msg) {
  if (DRY_RUN) return;
  try {
    execSync('git add players/', { cwd: ROOT, stdio: 'pipe' });
    const staged = execSync('git diff --staged --stat', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    if (!staged) return;
    execSync(`git stash`, { cwd: ROOT, stdio: 'pipe' });
    execSync(`git fetch origin main`, { cwd: ROOT, stdio: 'pipe' });
    execSync(`git merge -X ours FETCH_HEAD --no-edit`, { cwd: ROOT, stdio: 'pipe' });
    execSync(`git stash pop`, { cwd: ROOT, stdio: 'pipe' });
    execSync(`git commit -m "${msg}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync(`git push origin main`, { cwd: ROOT, stdio: 'pipe' });
    console.log(`  Committed: ${msg}`);
  } catch (e) {
    console.error('  git error:', e.message.slice(0, 200));
  }
}

function saveProgress(done) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ done: [...done] }), 'utf8');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nbackfill-player-names.js${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log('─'.repeat(60));

  // Load progress
  const done = new Set();
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      for (const u of (p.done || [])) done.add(u);
      console.log(`  Resuming — ${done.size} already processed`);
    } catch {}
  }

  // Collect all players missing a name
  console.log('  Scanning player files for missing names…');
  const nameless = [];
  const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS_DIR, prefix);
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const uuid = fname.replace('.json', '');
      if (done.has(uuid)) continue;
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
      if (!p.name) nameless.push(uuid);
    }
  }
  console.log(`  ${nameless.length} players need names (${done.size} already done)\n`);
  if (!nameless.length) { console.log('  Nothing to do.'); return; }

  await refreshSession();

  let written = 0, inaccessible = 0, errors = 0, sinceCommit = 0;
  let requestCount = 0;
  const REFRESH_EVERY = 30;

  async function processOne(uuid) {
    requestCount++;
    if (requestCount % REFRESH_EVERY === 0) {
      sessionCookie = null;
      await refreshSession();
    }

    const result = await fetchName(uuid);

    if (result.status === 'inaccessible') {
      inaccessible++;
      done.add(uuid);
      return;
    }
    if (result.status === 'error') {
      errors++;
      console.log(`  ✗ ${uuid.slice(0, 8)} ERROR: ${result.err?.message?.slice(0, 80)}`);
      return;
    }

    done.add(uuid);

    if (!result.name) {
      // Profile accessible but no name — private or unnamed
      inaccessible++;
      return;
    }

    if (!DRY_RUN) {
      const fpath = path.join(PLAYERS_DIR, uuid.slice(0, 2), `${uuid}.json`);
      try {
        const p = JSON.parse(fs.readFileSync(fpath, 'utf8'));
        p.name = result.name;
        fs.writeFileSync(fpath, JSON.stringify(p), 'utf8');
        written++;
        sinceCommit++;
      } catch (e) {
        errors++;
        console.log(`  ✗ ${uuid.slice(0, 8)} write error: ${e.message}`);
        return;
      }
    } else {
      written++;
    }
  }

  // Run with concurrency pool
  let idx = 0;
  async function worker() {
    while (idx < nameless.length) {
      const uuid = nameless[idx++];
      await processOne(uuid);

      // Periodic progress save + commit
      if (!DRY_RUN && sinceCommit >= COMMIT_EVERY) {
        saveProgress(done);
        await gitCommit(`backfill-player-names: ${written} names written`);
        sinceCommit = 0;
        console.log(`  Progress: ${idx}/${nameless.length} processed, ${written} names written`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, worker);
  await Promise.all(workers);

  // Final commit
  if (!DRY_RUN && written > 0) {
    saveProgress(done);
    await gitCommit(`backfill-player-names: complete — ${written} names written`);
  }

  // Clean up progress file on completion
  if (!DRY_RUN && fs.existsSync(PROGRESS_FILE)) {
    try { fs.unlinkSync(PROGRESS_FILE); } catch {}
  }

  console.log('\n─'.repeat(60));
  console.log(`  Written:      ${written}`);
  console.log(`  Inaccessible: ${inaccessible}`);
  console.log(`  Errors:       ${errors}`);
  console.log('─'.repeat(60));
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
