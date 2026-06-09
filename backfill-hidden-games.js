#!/usr/bin/env node
// backfill-hidden-games.js
'use strict';
const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);
const TENANT        = ARGS.tenant      || 'bv';
const TENANT_FULL   = { bv: 'basketball-victoria' }[TENANT] || TENANT;
const CONCURRENCY   = parseInt(ARGS.concurrency || '100', 10);
const TARGET_SEASON = ARGS.season      || null;
const REVIEW_LEGACY   = !!ARGS['review-legacy'];
const REVIEW_UNSCORED = !!ARGS['review-unscored'];
const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const GAMES_DIR     = path.join(__dirname, 'games', TENANT);
const COOKIE_FILE   = path.join(__dirname, 'backfill-hidden-cookie.json');
const PROGRESS_FILE = path.join(__dirname, 'backfill-hidden-progress.json');
const NO_VENUE_FILE = path.join(__dirname, 'no-venue-seasons.json');
const VENUE_DIR     = path.join(__dirname, 'venue-lookup');
const HEADERS_API = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT_FULL,
  'content-type': 'application/json',
};
const HEADERS_SPECTATOR = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT,
  'x-phq-tenant': TENANT,
  'content-type': 'application/json',
};
// ─── Session cookie ───────────────────────────────────────────────────────────
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
    console.log('\n  Fetching fresh session cookie...');
    const cookieQueries = [
      { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
      { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
    ];
    let res;
    for (const body of cookieQueries) {
      res = await fetch(API_URL, { method: 'POST', headers: { ...HEADERS_API, 'request-id': crypto.randomUUID() }, body: JSON.stringify(body) });
      if (res.headers.get('set-cookie')) { console.log(`  ✓ Got cookie via ${body.operationName}`); break; }
    }
    const rawCookie = res.headers.get('set-cookie');
    if (!rawCookie) throw new Error('No Set-Cookie header from API');
    const sessionMatch = rawCookie.match(/phq_session=([^;]+)/);
    if (!sessionMatch) throw new Error('phq_session not found in Set-Cookie header');
    const sessionToken  = sessionMatch[1];
    const sessionCookie = `phq_session=${sessionToken}`;
    let sub = '';
    try { const payload = JSON.parse(Buffer.from(sessionToken.split('.')[1], 'base64').toString()); sub = payload.sub || payload.jti || ''; } catch (e) {}
    const allCookies  = sub ? `${sessionCookie}; phq_sub=${sub}; phq_tier=cookie-no-jwt` : sessionCookie;
    const sessionData = { sessionCookie, allCookies, sub, fetchedAt: Date.now() };
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(sessionData));
    console.log(`  ✓ Cookie obtained (sub: ${sub || 'none'})`);
    return sessionData;
  })().finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}
let _safeRefreshPromise = null;
async function safeRefreshSession() {
  if (_safeRefreshPromise) return _safeRefreshPromise;
  _safeRefreshPromise = getSession(true).finally(() => { _safeRefreshPromise = null; });
  return _safeRefreshPromise;
}
// ─── Queries ──────────────────────────────────────────────────────────────────
const Q_GAME = `query Game($id: ID!) {
  game(id: $id) {
    id status updatedAt break
    clock { period periodValue time status lastUpdatedAt }
    result {
      home {
        statistics { count type { value } }
        periods(scope: BY_PERIOD) { period { value } overtimeSequenceNo statistics { count type { value } } role closureStatus }
      }
      away {
        statistics { count type { value } }
        periods(scope: BY_PERIOD) { period { value } overtimeSequenceNo statistics { count type { value } } role closureStatus }
      }
      currentPeriod { value primarySide }
    }
    statistics {
      home {
        statisticsV2 { type { value } count }
        players { profileID playerNumber name id statistics { count type { value pointValue type } } periodStatistics { period { value } statistics { count type { value } } status displayOrder } }
      }
      away {
        statisticsV2 { type { value } count }
        players { profileID playerNumber name id statistics { count type { value pointValue type } } periodStatistics { period { value } statistics { count type { value } } status displayOrder } }
      }
    }
    liveStreamingEnabled liveStream { url provider videoId }
  }
}`;
const Q_DISCOVER_GAME = `query GameCentre($gameId: ID!) {
  discoverGame(gameID: $gameId) {
    id date
    status { name value }
    round { id name }
    home { ... on DiscoverTeam { id name } }
    away { ... on DiscoverTeam { id name } }
    result {
      winner { value }
      outcome { name value }
      home { outcome { name value } gameOutcomeDescription statistics { count type { value } } }
      away { outcome { name value } statistics { count type { value } } }
    }
    allocation {
      dateTimeList { date time }
      court { id name abbreviatedName venue { id name abbreviatedName latitude longitude address suburb state postcode country } }
    }
  }
}`;
async function fetchGame(gameId, cookieString) {
  try {
    const res = await fetch(SPECTATOR_URL, {
      method: 'POST',
      headers: { ...HEADERS_SPECTATOR, 'request-id': crypto.randomUUID(), 'Cookie': cookieString },
      body: JSON.stringify({ operationName: 'Game', variables: { id: String(gameId) }, query: Q_GAME }),
    });
    if (res.status === 429 || res.status === 401 || res.status === 403) return { _authError: true };
    if (!res.ok) return { _transient: true };
    const json = await res.json();
    if (json.errors?.length) {
      const msg = json.errors[0]?.message || '';
      if (msg.includes('could not be found') || msg.includes('not electronically scored')) return { _legacy: true };
      return { _graphqlError: true };
    }
    return json;
  } catch (e) { return { _transient: true }; }
}
async function fetchDiscoverGame(gameId, session) {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { ...HEADERS_API, 'request-id': crypto.randomUUID(), 'Cookie': session.sessionCookie },
      body: JSON.stringify({ operationName: 'GameCentre', variables: { gameId }, query: Q_DISCOVER_GAME }),
    });
    if (res.status === 429 || res.status === 403 || res.status === 401) return { _authError: true };
    if (!res.ok) return { _transient: true };
    const json = await res.json();
    if (json.errors) return { _graphqlError: true };
    return json;
  } catch (e) { return { _transient: true }; }
}
// ─── Parsers ──────────────────────────────────────────────────────────────────
function parseScore(statistics) {
  return statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;
}
function parseQuarterScores(periods) {
  if (!periods?.length) return null;
  const order = ['FIRST_QTR', 'SECOND_QTR', 'THIRD_QTR', 'FOURTH_QTR'];
  const map = {};
  for (const p of periods) {
    const score = p.statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count;
    if (score !== undefined) map[p.period?.value] = score;
  }
  const qtrs = order.map(q => map[q] ?? null);
  return qtrs.some(q => q !== null) ? qtrs : null;
}
function buildSpectatorResult(gameId, seasonId, game) {
  const hs  = parseScore(game.result?.home?.statistics);
  const as_ = parseScore(game.result?.away?.statistics);
  const hq  = parseQuarterScores(game.result?.home?.periods);
  const aq  = parseQuarterScores(game.result?.away?.periods);
  const homePlayers = (game.statistics?.home?.players || []).map(p => ({
    profileID: p.profileID, name: p.name, number: p.playerNumber,
    pts:   parseScore(p.statistics),
    pt1:   p.statistics?.find(s => s.type?.value === '1_POINT_SCORE')?.count ?? 0,
    pt2:   p.statistics?.find(s => s.type?.value === '2_POINT_SCORE')?.count ?? 0,
    pt3:   p.statistics?.find(s => s.type?.value === '3_POINT_SCORE')?.count ?? 0,
    fouls: p.statistics?.find(s => s.type?.value === 'TOTAL_FOULS')?.count ?? 0,
  }));
  const awayPlayers = (game.statistics?.away?.players || []).map(p => ({
    profileID: p.profileID, name: p.name, number: p.playerNumber,
    pts:   parseScore(p.statistics),
    pt1:   p.statistics?.find(s => s.type?.value === '1_POINT_SCORE')?.count ?? 0,
    pt2:   p.statistics?.find(s => s.type?.value === '2_POINT_SCORE')?.count ?? 0,
    pt3:   p.statistics?.find(s => s.type?.value === '3_POINT_SCORE')?.count ?? 0,
    fouls: p.statistics?.find(s => s.type?.value === 'TOTAL_FOULS')?.count ?? 0,
  }));
  return { gameId, seasonId, outcome: 'hidden', hs, as: as_, hq, aq, homePlayers, awayPlayers, status: game.status, updatedAt: game.updatedAt };
}
// ─── Venue shards ─────────────────────────────────────────────────────────────
const _venueShards = {};
const _dirtyVenues = new Set();
function storeVenue(venue, court) {
  if (!venue?.id) return;
  const prefix = venue.id.slice(0, 2);
  if (!_venueShards[prefix]) {
    const f = path.join(VENUE_DIR, `${prefix}.json`);
    try { _venueShards[prefix] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; } catch (e) { _venueShards[prefix] = {}; }
  }
  const shard = _venueShards[prefix];
  if (!shard[venue.id]) {
    shard[venue.id] = { name: venue.name, abbr: venue.abbreviatedName || null, lat: venue.latitude || null, lng: venue.longitude || null, address: venue.address || null, suburb: venue.suburb || null, state: venue.state || null, postcode: venue.postcode || null, country: venue.country || null, courts: {} };
    _dirtyVenues.add(prefix);
  }
  if (court?.id && !shard[venue.id].courts[court.id]) {
    shard[venue.id].courts[court.id] = { name: court.name, abbr: court.abbreviatedName || null };
    _dirtyVenues.add(prefix);
  }
}
function flushVenueShards() {
  if (!fs.existsSync(VENUE_DIR)) fs.mkdirSync(VENUE_DIR, { recursive: true });
  for (const prefix of _dirtyVenues) fs.writeFileSync(path.join(VENUE_DIR, `${prefix}.json`), JSON.stringify(_venueShards[prefix]));
  _dirtyVenues.clear();
}
// ─── Progress ─────────────────────────────────────────────────────────────────
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      return { done: new Set(p.done || []), legacy: new Set(p.legacy || []) };
    }
  } catch (e) {}
  return { done: new Set(), legacy: new Set() };
}
function saveProgress(prog) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ done: [...prog.done], legacy: [...prog.legacy], savedAt: new Date().toISOString() }));
}
// ─── Git ──────────────────────────────────────────────────────────────────────
function gitCommitPush(message) {
  try {
    execSync('git add games/ venue-lookup/ backfill-hidden-progress.json 2>/dev/null || true', { stdio: 'pipe', shell: true });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('\n  ✓ Committed and pushed');
  } catch (e) { console.warn(`\n  ⚠ Git error: ${e.message}`); }
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔍 Backfill Hidden Games`);
  console.log(`   Tenant:      ${TENANT} (${TENANT_FULL})`);
  console.log(`   Concurrency: ${CONCURRENCY}`);
  if (!fs.existsSync(NO_VENUE_FILE)) { console.error(`❌ ${NO_VENUE_FILE} not found`); process.exit(1); }
  const noVenueSeasons = JSON.parse(fs.readFileSync(NO_VENUE_FILE, 'utf8'));
  const targetSeasons  = TARGET_SEASON ? [{ id: TARGET_SEASON }] : noVenueSeasons;
  console.log(`📋 Seasons to check: ${targetSeasons.length}`);
  const prog = loadProgress();
  if (prog.done.size > 0) console.log(`  ↻ Resuming — ${prog.done.size.toLocaleString()} already done, ${prog.legacy.size.toLocaleString()} flagged legacy\n`);
  let session = await getSession();

  // ─── Review-legacy mode ───────────────────────────────────────────────────
  if (REVIEW_LEGACY) {
    console.log(`\n🔎 Review-legacy mode — re-probing legacy games via discoverGame\n`);
    const legacyTodo = [];
    const sgCache2   = {};
    for (const season of targetSeasons) {
      const gameFile = path.join(GAMES_DIR, `${season.id}.json`);
      if (!fs.existsSync(gameFile)) continue;
      let sg; try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); } catch (e) { continue; }
      sgCache2[season.id] = sg;
      for (const [gameId, game] of Object.entries(sg.games || {})) {
        if (!game.legacy) continue;
        legacyTodo.push({ seasonId: season.id, gameId });
      }
    }
    console.log(`📋 Legacy games to re-probe: ${legacyTodo.length.toLocaleString()}\n`);
    let forfeits = 0, stillLegacy = 0, accessible = 0, legacyFailed = 0, legacySinceLastSave = 0;
    for (let i = 0; i < legacyTodo.length; i += CONCURRENCY) {
      const batch = legacyTodo.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async ({ seasonId, gameId }, j) => {
        await delay(j * 3);
        const resp = await fetchDiscoverGame(gameId, session);
        if (resp?._authError) { try { session = await safeRefreshSession(); } catch (e) {} return { gameId, seasonId, type: 'skip' }; }
        if (resp?._transient || resp?._graphqlError) return { gameId, seasonId, type: 'skip' };
        const dg = resp?.data?.discoverGame;
        if (!dg) return { gameId, seasonId, type: 'stillLegacy' };
        const outcomeVal = dg.result?.outcome?.value || '';
        const isForfeit  = outcomeVal.includes('FORFEIT');
        const hs = parseScore(dg.result?.home?.statistics);
        const as_ = parseScore(dg.result?.away?.statistics);
        const court = dg.allocation?.court;
        const venue = court?.venue;
        return {
          gameId, seasonId, type: isForfeit ? 'forfeit' : 'accessible',
          hs, as: as_, fo: dg.result?.winner?.value?.toLowerCase() || null,
          desc: dg.result?.home?.gameOutcomeDescription || null,
          h: dg.home?.id || null, hn: dg.home?.name || null,
          a: dg.away?.id || null, an: dg.away?.name || null,
          rn: dg.round?.name || null, st: dg.status?.value || null,
          venue, court, time: dg.allocation?.dateTimeList?.[0]?.time?.slice(0, 5) || null,
        };
      }));
      for (const r of results) {
        if (r.type === 'skip') { legacyFailed++; continue; }
        const sg = sgCache2[r.seasonId]; if (!sg) continue;
        const entry = sg.games[r.gameId] || {};
        if (r.type === 'stillLegacy') { stillLegacy++; continue; }
        delete entry.legacy; prog.legacy.delete(r.gameId);
        if (r.h)  entry.h  = r.h; if (r.hn) entry.hn = r.hn;
        if (r.a)  entry.a  = r.a; if (r.an) entry.an = r.an;
        if (r.rn) entry.rn = r.rn; if (r.st) entry.st = r.st;
        if (r.type === 'forfeit') { entry.forfeit = true; entry.fo = r.fo; if (r.desc) entry.desc = r.desc; forfeits++; }
        else { if (r.hs !== null) entry.hs = r.hs; if (r.as !== null) entry.as = r.as; if (r.venue) { storeVenue(r.venue, r.court); entry.vid = r.venue.id; entry.vn = r.venue.name; } if (r.court?.name) entry.ct = r.court.name; if (r.time) entry.t = r.time; accessible++; }
        sg.games[r.gameId] = entry; prog.done.add(r.gameId); legacySinceLastSave++;
      }
      if (legacySinceLastSave >= 5000) {
        for (const [sid, sg] of Object.entries(sgCache2)) fs.writeFileSync(path.join(GAMES_DIR, `${sid}.json`), JSON.stringify(sg));
        flushVenueShards(); saveProgress(prog); legacySinceLastSave = 0;
        gitCommitPush(`Legacy review: ${forfeits} forfeits, ${accessible} accessible, ${stillLegacy} still legacy`);
      }
      const done = Math.min(i + CONCURRENCY, legacyTodo.length);
      process.stdout.write(`  ${done.toLocaleString()}/${legacyTodo.length.toLocaleString()} — 🏳 ${forfeits} forfeits, ✓ ${accessible} accessible, 📜 ${stillLegacy} still legacy, ✗ ${legacyFailed} failed\r`);
      if (i + CONCURRENCY < legacyTodo.length) await delay(50);
    }
    for (const [sid, sg] of Object.entries(sgCache2)) fs.writeFileSync(path.join(GAMES_DIR, `${sid}.json`), JSON.stringify(sg));
    flushVenueShards(); saveProgress(prog);
    console.log(`\n\n✅ Legacy review complete`);
    console.log(`   🏳 Forfeits:   ${forfeits.toLocaleString()}`);
    console.log(`   ✓  Accessible: ${accessible.toLocaleString()}`);
    console.log(`   📜 Still legacy: ${stillLegacy.toLocaleString()}`);
    console.log(`   ✗  Failed:     ${legacyFailed.toLocaleString()}`);
    gitCommitPush(`Legacy review complete: ${forfeits} forfeits, ${accessible} accessible`);
    return;
  }

  // ─── Review-unscored mode ─────────────────────────────────────────────────
  if (REVIEW_UNSCORED) {
    console.log(`\n🔎 Review-unscored mode — probing all unscored unflagged games\n`);
    const INDEX_FILE = path.join(__dirname, 'sports-index.json');
    const allSeasons = fs.existsSync(INDEX_FILE)
      ? Object.keys(JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).seasons || {}).map(id => ({ id }))
      : targetSeasons;
    const reviewSeasons = TARGET_SEASON ? [{ id: TARGET_SEASON }] : allSeasons;

    // Collect IDs only — do NOT cache game files, load per season below
    const todo2 = [];
    for (const season of reviewSeasons) {
      const gameFile = path.join(GAMES_DIR, `${season.id}.json`);
      if (!fs.existsSync(gameFile)) continue;
      let sg; try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); } catch (e) { continue; }
      for (const [gameId, game] of Object.entries(sg.games || {})) {
        if (game.hidden || game.legacy || game.forfeit) continue;
        if (typeof game.hs === 'number' || game.hs === null) continue;
        if (prog.done.has(gameId)) continue;
        todo2.push({ seasonId: season.id, gameId });
      }
      // sg goes out of scope — not retained in memory
    }

    console.log(`📋 Unscored unflagged games to probe: ${todo2.length.toLocaleString()}\n`);

    let forfeits2 = 0, scored2 = 0, hidden2 = 0, nowLegacy2 = 0, failed2 = 0, sinceLastSave2 = 0;
    let totalDone2 = 0;
    const total2 = todo2.length;

    // Group by season — load one file at a time to bound memory
    const bySeason2 = new Map();
    for (const item of todo2) {
      if (!bySeason2.has(item.seasonId)) bySeason2.set(item.seasonId, []);
      bySeason2.get(item.seasonId).push(item.gameId);
    }

    for (const [seasonId, gameIds] of bySeason2) {
      const gameFile = path.join(GAMES_DIR, `${seasonId}.json`);
      if (!fs.existsSync(gameFile)) { totalDone2 += gameIds.length; continue; }
      let sg; try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); } catch (e) { totalDone2 += gameIds.length; continue; }
      let seasonDirty = false;

      for (let i = 0; i < gameIds.length; i += CONCURRENCY) {
        const batchIds = gameIds.slice(i, i + CONCURRENCY);

        const results = await Promise.all(batchIds.map(async (gameId, j) => {
          await delay(j * 5);
          // Step 1: discoverGame — catches forfeits, scored, venue data
          const dgResp = await fetchDiscoverGame(gameId, session);
          if (dgResp?._authError) {
            try { session = await safeRefreshSession(); } catch (e) {}
            return { gameId, seasonId, type: 'skip' };
          }
          if (dgResp?._transient || dgResp?._graphqlError) return { gameId, seasonId, type: 'skip' };

          const dg = dgResp?.data?.discoverGame;
          if (dg) {
            const outcomeVal = dg.result?.outcome?.value || '';
            const hs  = parseScore(dg.result?.home?.statistics);
            const as_ = parseScore(dg.result?.away?.statistics);
            const court = dg.allocation?.court;
            const venue = court?.venue;
            const isForfeit = outcomeVal.includes('FORFEIT');
            return {
              gameId, seasonId,
              type: isForfeit ? 'forfeit' : 'scored',
              hs, as: as_,
              fo:   dg.result?.winner?.value?.toLowerCase() || null,
              desc: dg.result?.home?.gameOutcomeDescription || null,
              h: dg.home?.id || null, hn: dg.home?.name || null,
              a: dg.away?.id || null, an: dg.away?.name || null,
              rn: dg.round?.name || null, st: dg.status?.value || null,
              venue, court, time: dg.allocation?.dateTimeList?.[0]?.time?.slice(0, 5) || null,
            };
          }

          // Step 2: discoverGame returned null — try spectator for hidden games
          let attempts = 0;
          while (attempts < 3) {
            const resp = await fetchGame(gameId, session.allCookies);
            if (resp?._authError) {
              attempts++;
              await delay(attempts * 2000);
              try { session = await safeRefreshSession(); } catch (e) {}
              continue;
            }
            if (resp?._transient || resp?._graphqlError) return { gameId, seasonId, type: 'skip' };
            if (resp?._legacy) return { gameId, seasonId, type: 'legacy' };
            const gameData = resp?.data?.game;
            if (!gameData) return { gameId, seasonId, type: 'legacy' };
            return buildSpectatorResult(gameId, seasonId, gameData);
          }
          return { gameId, seasonId, type: 'skip' };
        }));

        for (const r of results) {
          totalDone2++;
          if (r.type === 'skip') { failed2++; continue; }
          const entry = sg.games[r.gameId] || {};

          if (r.type === 'legacy') {
            entry.legacy = true;
            prog.legacy.add(r.gameId);
            prog.done.add(r.gameId);
            nowLegacy2++;
          } else if (r.type === 'hidden' || r.outcome === 'hidden') {
            entry.hidden = true;
            if (r.hs !== null) entry.hs = r.hs;
            if (r.as !== null) entry.as = r.as;
            if (r.hq) entry.hq = r.hq;
            if (r.aq) entry.aq = r.aq;
            if (r.homePlayers?.length) entry.hp = r.homePlayers;
            if (r.awayPlayers?.length) entry.ap = r.awayPlayers;
            if (r.updatedAt) entry.updatedAt = r.updatedAt;
            hidden2++; scored2++;
            prog.done.add(r.gameId);
          } else if (r.type === 'forfeit') {
            entry.forfeit = true;
            entry.fo = r.fo;
            if (r.desc) entry.desc = r.desc;
            if (r.h)  entry.h  = r.h; if (r.hn) entry.hn = r.hn;
            if (r.a)  entry.a  = r.a; if (r.an) entry.an = r.an;
            if (r.rn) entry.rn = r.rn; if (r.st) entry.st = r.st;
            forfeits2++; scored2++;
            prog.done.add(r.gameId);
          } else if (r.type === 'scored') {
            const terminalStatus = ['FINAL', 'PENDING', 'POSTPONED', 'CANCELLED', 'BYE'];
            if (terminalStatus.includes(r.st)) {
              entry.hs = r.hs !== null ? r.hs : null;
              entry.as = r.as !== null ? r.as : null;
            } else if (r.hs !== null) {
              entry.hs = r.hs; entry.as = r.as;
            }
            if (r.h)  entry.h  = r.h; if (r.hn) entry.hn = r.hn;
            if (r.a)  entry.a  = r.a; if (r.an) entry.an = r.an;
            if (r.rn && !entry.rn) entry.rn = r.rn; if (r.st) entry.st = r.st;
            if (r.venue) { storeVenue(r.venue, r.court); entry.vid = r.venue.id; entry.vn = r.venue.name; }
            if (r.court?.name) entry.ct = r.court.name; if (r.time) entry.t = r.time;
            scored2++;
            prog.done.add(r.gameId);
          }

          sg.games[r.gameId] = entry;
          seasonDirty = true;
          sinceLastSave2++;
        }

        // Flush every 1000 games — survive OOM kills
        if (sinceLastSave2 >= 1000) {
          if (seasonDirty) { fs.writeFileSync(gameFile, JSON.stringify(sg)); seasonDirty = false; }
          flushVenueShards(); saveProgress(prog); sinceLastSave2 = 0;
          gitCommitPush(`Unscored review: ${forfeits2} forfeits, ${hidden2} hidden, ${scored2} scored, ${nowLegacy2} legacy`);
        }

        process.stdout.write(`  ${totalDone2.toLocaleString()}/${total2.toLocaleString()} — 🏳 ${forfeits2} forfeits, 🔒 ${hidden2} hidden, ✓ ${scored2 - hidden2 - forfeits2} scored, 📜 ${nowLegacy2} legacy, ✗ ${failed2} failed\r`);
        if (i + CONCURRENCY < gameIds.length) await delay(50);
      }

      if (seasonDirty) fs.writeFileSync(gameFile, JSON.stringify(sg));
      flushVenueShards(); saveProgress(prog);
      // sg goes out of scope here — GC reclaims before next season
    }

    console.log(`\n\n✅ Unscored review complete`);
    console.log(`   🏳 Forfeits:   ${forfeits2.toLocaleString()}`);
    console.log(`   🔒 Hidden:     ${hidden2.toLocaleString()}`);
    console.log(`   ✓  Scored:     ${(scored2 - hidden2 - forfeits2).toLocaleString()}`);
    console.log(`   📜 Legacy:     ${nowLegacy2.toLocaleString()}`);
    console.log(`   ✗  Failed:     ${failed2.toLocaleString()}`);
    gitCommitPush(`Unscored review complete: ${forfeits2} forfeits, ${hidden2} hidden, ${scored2} scored, ${nowLegacy2} legacy`);
    return;
  }

  // ─── Default mode: spectator probe for hidden games ───────────────────────
  const todo    = [];
  const sgCache = {};
  for (const season of targetSeasons) {
    const gameFile = path.join(GAMES_DIR, `${season.id}.json`);
    if (!fs.existsSync(gameFile)) continue;
    let sg; try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); } catch (e) { continue; }
    sgCache[season.id] = sg;
    for (const [gameId, game] of Object.entries(sg.games || {})) {
      if (game.hs !== undefined || game.hidden || game.legacy || prog.done.has(gameId)) continue;
      todo.push({ seasonId: season.id, gameId });
    }
  }
  console.log(`📋 Games to probe: ${todo.length.toLocaleString()}\n`);
  if (todo.length === 0) { console.log('✅ Nothing to do'); return; }
  let hidden = 0, legacy = 0, failed = 0, sinceLastSave = 0;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async ({ seasonId, gameId }, j) => {
      await delay(j * 5);
      const resp = await fetchGame(gameId, session.allCookies);
      if (resp?._legacy) return { gameId, seasonId, outcome: 'legacy' };
      if (resp?._authError) {
        try { session = await safeRefreshSession(); } catch (e) { return { gameId, seasonId, outcome: 'skip' }; }
        const retry = await fetchGame(gameId, session.allCookies);
        if (retry?._authError || retry?._transient || retry?._graphqlError) return { gameId, seasonId, outcome: 'skip' };
        const rg = retry?.data?.game;
        if (rg) return buildSpectatorResult(gameId, seasonId, rg);
        return { gameId, seasonId, outcome: 'legacy' };
      }
      if (resp?._transient || resp?._graphqlError) return { gameId, seasonId, outcome: 'skip' };
      const game = resp?.data?.game;
      if (game) return buildSpectatorResult(gameId, seasonId, game);
      return { gameId, seasonId, outcome: 'legacy' };
    }));
    for (const r of results) {
      if (r.outcome === 'skip') { failed++; continue; }
      const sg = sgCache[r.seasonId]; if (!sg) continue;
      const entry = sg.games[r.gameId] || {};
      if (r.outcome === 'hidden') {
        if (r.hs !== null) entry.hs = r.hs; if (r.as !== null) entry.as = r.as;
        if (r.hq) entry.hq = r.hq; if (r.aq) entry.aq = r.aq;
        if (r.homePlayers?.length) entry.hp = r.homePlayers;
        if (r.awayPlayers?.length) entry.ap = r.awayPlayers;
        if (r.updatedAt) entry.updatedAt = r.updatedAt;
        entry.hidden = true; hidden++;
      } else if (r.outcome === 'legacy') {
        entry.legacy = true; prog.legacy.add(r.gameId); legacy++;
      }
      sg.games[r.gameId] = entry; prog.done.add(r.gameId); sinceLastSave++;
    }
    if (sinceLastSave >= 5000) {
      for (const [sid, sg] of Object.entries(sgCache)) fs.writeFileSync(path.join(GAMES_DIR, `${sid}.json`), JSON.stringify(sg));
      flushVenueShards(); saveProgress(prog); sinceLastSave = 0;
      gitCommitPush(`Hidden game backfill: ${hidden} hidden, ${legacy} legacy`);
    }
    const done = Math.min(i + CONCURRENCY, todo.length);
    process.stdout.write(`  ${done.toLocaleString()}/${todo.length.toLocaleString()} (${((done/todo.length)*100).toFixed(1)}%) — 🔒 ${hidden} hidden, 📜 ${legacy} legacy, ✗ ${failed} failed\r`);
    if (i + CONCURRENCY < todo.length) await delay(100);
  }
  for (const [sid, sg] of Object.entries(sgCache)) fs.writeFileSync(path.join(GAMES_DIR, `${sid}.json`), JSON.stringify(sg));
  flushVenueShards(); saveProgress(prog);
  console.log(`\n\n✅ Backfill complete`);
  console.log(`   🔒 Hidden: ${hidden.toLocaleString()}`);
  console.log(`   📜 Legacy: ${legacy.toLocaleString()}`);
  console.log(`   ✗  Failed: ${failed.toLocaleString()}`);
  gitCommitPush(`Hidden game backfill complete: ${hidden} hidden, ${legacy} legacy`);
}
main().catch(e => { console.error(`\n❌ Fatal: ${e.message}`); process.exit(1); });
