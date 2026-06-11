#!/usr/bin/env node
// backfill-missing-players.js
'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');

// ─── Args ─────────────────────────────────────────────────────────────────────

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const TENANT      = ARGS.tenant      || 'bv';
const TENANT_FULL = { bv: 'basketball-victoria' }[TENANT] || TENANT;
const CONCURRENCY = parseInt(ARGS.concurrency || '80', 10);
const SAVE_EVERY  = parseInt(ARGS['save-every'] || '500', 10);

// ─── Paths ────────────────────────────────────────────────────────────────────

const API_URL       = 'https://api.playhq.com/graphql';
const PLAYERS_DIR   = path.join(__dirname, 'players');
const PLAYERS_IDX   = path.join(__dirname, 'players-index');
const GAMES_DIR     = path.join(__dirname, 'games', TENANT);
const COOKIE_FILE   = path.join(__dirname, 'backfill-missing-players-cookie.json');
const PROGRESS_FILE = path.join(__dirname, 'backfill-missing-players-progress.json');

// ─── Headers ──────────────────────────────────────────────────────────────────

const HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT_FULL,
  'content-type': 'application/json',
};

// ─── Query ────────────────────────────────────────────────────────────────────

const Q_PROFILE = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      name
      statistics {
        season { id name }
        club { id name }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          gradeStatistics {
            grade { id name }
            gameStatistics {
              game {
                id date
                round { name isFinalsRound }
                home { ... on DiscoverTeam { id name } }
                away { ... on DiscoverTeam { id name } }
              }
              statistics { count details { value } }
            }
          }
        }
      }
    }
  }
}`;

// ─── Session ──────────────────────────────────────────────────────────────────

let _refreshPromise = null;

async function getSession(force = false) {
  if (_refreshPromise) return _refreshPromise;
  try {
    if (!force && fs.existsSync(COOKIE_FILE)) {
      const d = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      if (Date.now() - d.fetchedAt < 23 * 60 * 60 * 1000) return d;
    }
  } catch (e) {}
  _refreshPromise = (async () => {
    console.log('\n  Fetching session cookie...');
    let raw = null;
    const queries = [
      { operationName: 'TenantConfig', variables: {},
        query: 'query TenantConfig { tenantConfiguration { label } }' },
    ];
    for (let attempt = 1; attempt <= 5 && !raw; attempt++) {
      if (attempt > 1) await new Promise(r => setTimeout(r, attempt * 3000));
      for (const body of queries) {
        let res;
        try {
          res = await fetch(API_URL, {
            method: 'POST',
            headers: { ...HEADERS, 'request-id': crypto.randomUUID() },
            body: JSON.stringify(body),
          });
        } catch (e) { continue; }
        raw = res.headers.get('set-cookie');
        if (raw) { console.log(`  ✓ Cookie (attempt ${attempt})`); break; }
      }
    }
    if (!raw) throw new Error('No Set-Cookie after 5 attempts');
    const session = raw.match(/phq_session=([^;]+)/)[1];
    const data = { sessionCookie: `phq_session=${session}`, fetchedAt: Date.now() };
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(data));
    return data;
  })().finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

let _safeRefresh = null;
async function safeRefresh() {
  if (_safeRefresh) return _safeRefresh;
  _safeRefresh = getSession(true).finally(() => { _safeRefresh = null; });
  return _safeRefresh;
}

// ─── Parse profile response into detail file structure ────────────────────────

function parseProfile(uuid, data) {
  const seasonStats = data?.publicProfileStatistics?.seasonStatistics || [];
  let name = null;
  const sportTotals = {};
  const seasons = [];

  for (const ss of seasonStats) {
    if (ss.name && !name) name = ss.name;

    for (const reg of (ss.statistics || [])) {
      const season = reg.season;
      if (!season?.id) continue;

      const sport = 'Basketball';
      if (!sportTotals[sport]) sportTotals[sport] = { gp:0, pts:0, fouls:0, fg:0, ft:0, threePt:0 };

      const seasonEntry = {
        sid: season.id,
        sn:  season.name || null,
        club: reg.club?.name || null,
        sport,
        regs: [],
      };

      for (const team of (reg.teamStatistics || [])) {
        for (const grade of (team.gradeStatistics || [])) {
          const stats = { gp:0, pts:0, fouls:0, fg:0, ft:0, threePt:0 };
          for (const gs of (grade.gameStatistics || [])) {
            let hasScore = false;
            for (const s of (gs.statistics || [])) {
              const v = s.count || 0;
              switch (s.details?.[0]?.value || '') {
                case 'TOTAL_SCORE':   stats.pts    += v; hasScore = true; break;
                case 'TOTAL_FOULS':  stats.fouls  += v; break;
                case '2_POINT_SCORE': stats.fg     += v; break;
                case '1_POINT_SCORE': stats.ft     += v; break;
                case '3_POINT_SCORE': stats.threePt+= v; break;
              }
            }
            if (hasScore) stats.gp++;
          }
          seasonEntry.regs.push({
            tid:   team.team?.id   || null,
            tn:    team.team?.name || null,
            gid:   grade.grade?.id   || null,
            gn:    grade.grade?.name || null,
            stats,
          });
          sportTotals[sport].gp      += stats.gp;
          sportTotals[sport].pts     += stats.pts;
          sportTotals[sport].fouls   += stats.fouls;
          sportTotals[sport].fg      += stats.fg;
          sportTotals[sport].ft      += stats.ft;
          sportTotals[sport].threePt += stats.threePt;
        }
      }
      if (seasonEntry.regs.length) seasons.push(seasonEntry);
    }
  }

  return {
    uuid, name, gender: null,
    sports: sportTotals,
    seasons,
    updatedAt: new Date().toISOString(),
  };
}

// ─── Write player detail file ──────────────────────────────────────────────────

function writePlayerFile(uuid, detail) {
  const prefix = uuid.slice(0, 2);
  const dir    = path.join(PLAYERS_DIR, prefix);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uuid}.json`), JSON.stringify(detail));
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      return { done: new Set(p.done || []), failed: new Set(p.failed || []) };
    }
  } catch (e) {}
  return { done: new Set(), failed: new Set() };
}

function saveProgress(prog) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
    done:    [...prog.done],
    failed:  [...prog.failed],
    savedAt: new Date().toISOString(),
  }));
}

// ─── Git ──────────────────────────────────────────────────────────────────────

function gitCommit(msg) {
  try {
    execSync('git add players/ backfill-missing-players-progress.json', { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${msg}"`, { stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('\n  ✓ Committed');
  } catch (e) { console.warn(`\n  ⚠ Git: ${e.message}`); }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n👤 Backfill Missing Player Detail Files');
  console.log(`   Tenant:      ${TENANT} (${TENANT_FULL})`);
  console.log(`   Concurrency: ${CONCURRENCY}`);
  console.log(`   Save every:  ${SAVE_EVERY} players\n`);

  const prog = loadProgress();
  if (prog.done.size > 0) console.log(`  ↻ Resuming — ${prog.done.size.toLocaleString()} already done`);

  // ── Build UUID set — union of all missing players ─────────────────────────

  console.log('  Building missing player list...');

  const missing = new Set();

  // Group A: in index but no detail file
  if (fs.existsSync(PLAYERS_IDX)) {
    for (const file of fs.readdirSync(PLAYERS_IDX).filter(f => f.endsWith('.json'))) {
      try {
        const shard = JSON.parse(fs.readFileSync(path.join(PLAYERS_IDX, file), 'utf8'));
        for (const uuid of Object.keys(shard)) {
          const detailPath = path.join(PLAYERS_DIR, uuid.slice(0, 2), `${uuid}.json`);
          if (!fs.existsSync(detailPath)) missing.add(uuid);
        }
      } catch (e) {}
    }
  }
  console.log(`  From index (no detail file):     ${missing.size.toLocaleString()}`);

  // Group B: in playerGames but no detail file
  let fromGames = 0;
  if (fs.existsSync(GAMES_DIR)) {
    for (const file of fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'))) {
      let sg;
      try { sg = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8')); } catch (e) { continue; }
      for (const uuid of Object.keys(sg.playerGames || {})) {
        if (!missing.has(uuid)) {
          const detailPath = path.join(PLAYERS_DIR, uuid.slice(0, 2), `${uuid}.json`);
          if (!fs.existsSync(detailPath)) { missing.add(uuid); fromGames++; }
        }
      }
    }
  }
  console.log(`  From playerGames (no detail):    ${fromGames.toLocaleString()}`);
  console.log(`  Total to fetch:                  ${missing.size.toLocaleString()}`);

  // Remove already done or permanently failed
  const todo = [...missing].filter(uuid => !prog.done.has(uuid) && !prog.failed.has(uuid));
  console.log(`  Queue after resume filter:       ${todo.length.toLocaleString()}\n`);

  if (todo.length === 0) { console.log('✅ Nothing to do'); return; }

  let session = await getSession();

  let nWritten = 0, nFailed = 0, nEmpty = 0, sinceLastSave = 0;

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);

    const results = await Promise.all(batch.map(async (uuid, j) => {
      await delay(j * 5);
      let attempts = 0;
      let resp;
      while (attempts < 3) {
        try {
          const res = await fetch(API_URL, {
            method:  'POST',
            headers: { ...HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': session.sessionCookie },
            body:    JSON.stringify({ operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: Q_PROFILE }),
          });
          if (res.status === 401 || res.status === 403 || res.status === 429) {
            attempts++;
            await delay(attempts * 2000);
            try { session = await safeRefresh(); } catch (e) {}
            continue;
          }
          if (!res.ok) { resp = { _transient: true }; break; }
          resp = await res.json();
          break;
        } catch (e) { resp = { _transient: true }; break; }
      }
      return { uuid, resp };
    }));

    for (const { uuid, resp } of results) {
      sinceLastSave++;

      if (resp?._transient) {
        nFailed++;
        // Don't mark as permanently failed — retry next run
        continue;
      }

      const data    = resp?.data;
      const detail  = parseProfile(uuid, data);

      if (!detail.seasons.length) {
        // Profile exists but has no seasons — write minimal file so we don't retry unnecessarily
        nEmpty++;
        prog.done.add(uuid);
        writePlayerFile(uuid, detail);
        continue;
      }

      writePlayerFile(uuid, detail);
      prog.done.add(uuid);
      nWritten++;
    }

    if (sinceLastSave >= SAVE_EVERY) {
      saveProgress(prog);
      sinceLastSave = 0;
      gitCommit(`backfill-missing-players: ${nWritten} written, ${nEmpty} empty, ${nFailed} transient`);
    }

    const pct = ((i + batch.length) / todo.length * 100).toFixed(1);
    process.stdout.write(
      `  ${(i + batch.length).toLocaleString()}/${todo.length.toLocaleString()} (${pct}%) — ` +
      `✓ ${nWritten} written  ∅ ${nEmpty} empty  ⚠ ${nFailed} transient\r`
    );

    await delay(50);
  }

  saveProgress(prog);
  gitCommit(`backfill-missing-players complete: ${nWritten} written, ${nEmpty} empty, ${nFailed} transient`);

  console.log('\n\n✅ Backfill complete');
  console.log(`   ✓ Written:   ${nWritten.toLocaleString()}`);
  console.log(`   ∅ Empty:     ${nEmpty.toLocaleString()} (profile exists, no seasons)`);
  console.log(`   ⚠ Transient: ${nFailed.toLocaleString()} (retry next run)`);
  console.log(`   Total:       ${(nWritten + nEmpty + nFailed).toLocaleString()}`);
}

main().catch(e => { console.error(`\n❌ Fatal: ${e.message}\n${e.stack}`); process.exit(1); });
