#!/usr/bin/env node
// classify-games.js
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

const TENANT        = ARGS.tenant      || 'bv';
const TENANT_FULL   = { bv: 'basketball-victoria' }[TENANT] || TENANT;
const CONCURRENCY   = parseInt(ARGS.concurrency  || '80',  10);
const TARGET_SEASON = ARGS.season      || null;
const SAVE_EVERY    = parseInt(ARGS['save-every'] || '500', 10);

// ─── Paths ────────────────────────────────────────────────────────────────────

const API_URL       = 'https://api.playhq.com/graphql';
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const GAMES_DIR     = path.join(__dirname, 'games', TENANT);
const PLAYERS_DIR   = path.join(__dirname, 'players');
const VENUE_DIR     = path.join(__dirname, 'venue-lookup');
const INDEX_FILE    = path.join(__dirname, 'sports-index.json');
const COOKIE_FILE   = path.join(__dirname, 'classify-games-cookie.json');
const PROGRESS_FILE = path.join(__dirname, 'classify-games-progress.json');

// ─── Headers ──────────────────────────────────────────────────────────────────

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

// ─── Non-terminal statuses — re-probe regardless of lock state ────────────────

const NONTERMINAL_STATUSES = new Set(['LIVE', 'IN_PROGRESS', 'PRE_GAME', 'PENDING']);

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
    console.log('\n  Fetching fresh session cookie...');
    const cookieQueries = [
      { operationName: 'TenantConfig', variables: {},
        query: 'query TenantConfig { tenantConfiguration { label } }' },
      { operationName: 'ProfileSearch', variables: { fullName: 'a' },
        query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
    ];
    let res;
    for (const body of cookieQueries) {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { ...HEADERS_API, 'request-id': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      if (res.headers.get('set-cookie')) { console.log(`  ✓ Cookie via ${body.operationName}`); break; }
    }
    const raw = res.headers.get('set-cookie');
    if (!raw) throw new Error('No Set-Cookie from API');
    const sessionMatch = raw.match(/phq_session=([^;]+)/);
    if (!sessionMatch) throw new Error('phq_session not found');
    const token  = sessionMatch[1];
    const cookie = `phq_session=${token}`;
    let sub = '';
    try { const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()); sub = p.sub || p.jti || ''; } catch (e) {}
    const allCookies = sub ? `${cookie}; phq_sub=${sub}; phq_tier=cookie-no-jwt` : cookie;
    const data = { sessionCookie: cookie, allCookies, sub, fetchedAt: Date.now() };
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(data));
    console.log(`  ✓ Cookie obtained (sub: ${sub || 'none'})`);
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

// ─── Queries ──────────────────────────────────────────────────────────────────

const Q_DISCOVER = `query DiscoverGame($gameId: ID!) {
  discoverGame(gameID: $gameId) {
    id date
    status { name value }
    round { id name isFinalsRound }
    home { ... on DiscoverTeam { id name logo { sizes { url dimensions { width } } } } }
    away { ... on DiscoverTeam { id name logo { sizes { url dimensions { width } } } } }
    result {
      winner { value }
      outcome { name value }
      home { outcome { name value } gameOutcomeDescription statistics { count type { value } } }
      away { outcome { name value } statistics { count type { value } } }
    }
    allocation {
      dateTimeList { date time }
      court {
        id name abbreviatedName
        venue { id name abbreviatedName latitude longitude address suburb state postcode country }
      }
    }
  }
}`;

const Q_SPECTATOR = `query Game($id: ID!) {
  game(id: $id) {
    id status updatedAt
    result {
      home {
        statistics { count type { value } }
        periods(scope: BY_PERIOD) { period { value } overtimeSequenceNo statistics { count type { value } } }
      }
      away {
        statistics { count type { value } }
        periods(scope: BY_PERIOD) { period { value } overtimeSequenceNo statistics { count type { value } } }
      }
    }
    statistics {
      home { players { profileID playerNumber name id statistics { count type { value } } } }
      away { players { profileID playerNumber name id statistics { count type { value } } } }
    }
  }
}`;

// publicProfileStatistics — full game-level breakdown including home/away/round
// Used as Step 3 when both discoverGame and spectator return null.
// Returns per-game home/away IDs, round name, isFinalsRound, and this player's stats.
const Q_PROFILE_STATS = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      statistics {
        season { id }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          gradeStatistics {
            grade { id name }
            gameStatistics {
              game {
                id
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

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchDiscover(gameId, session) {
  try {
    const res = await fetch(API_URL, {
      method:  'POST',
      headers: { ...HEADERS_API, 'request-id': crypto.randomUUID(), 'Cookie': session.sessionCookie },
      body:    JSON.stringify({ operationName: 'DiscoverGame', variables: { gameId }, query: Q_DISCOVER }),
    });
    if (res.status === 401 || res.status === 403 || res.status === 429) return { _auth: true };
    if (!res.ok) return { _transient: true };
    const json = await res.json();
    if (json.errors) return { _graphql: true };
    return json;
  } catch (e) { return { _transient: true }; }
}

// Spectator 403 handling:
// A 403 from spectator means the cookie is not accepted by that endpoint —
// either the allCookies string is missing phq_sub/phq_tier, or the session
// has been invalidated. On 403 we attempt ONE refresh then return _notfound
// (skip this game) rather than retrying indefinitely. Spectator 403s should
// NOT loop — hammering a 403 risks IP block. Rate 429s get the same treatment.
async function fetchSpectator(gameId, session) {
  try {
    const res = await fetch(SPECTATOR_URL, {
      method:  'POST',
      headers: { ...HEADERS_SPECTATOR, 'request-id': crypto.randomUUID(), 'Cookie': session.allCookies },
      body:    JSON.stringify({ operationName: 'Game', variables: { id: String(gameId) }, query: Q_SPECTATOR }),
    });
    if (res.status === 401 || res.status === 403 || res.status === 429) return { _spectatorAuth: true };
    if (!res.ok) return { _transient: true };
    const json = await res.json();
    if (json.errors) {
      const msg = json.errors[0]?.message || '';
      if (msg.includes('could not be found') || msg.includes('not electronically scored')) return { _notfound: true };
      return { _graphql: true };
    }
    return json;
  } catch (e) { return { _transient: true }; }
}

async function fetchProfileStats(profileId, session) {
  try {
    const res = await fetch(API_URL, {
      method:  'POST',
      headers: { ...HEADERS_API, 'request-id': crypto.randomUUID(), 'Cookie': session.sessionCookie },
      body:    JSON.stringify({ operationName: 'ProfileSeasonStatistics', variables: { profileID: profileId }, query: Q_PROFILE_STATS }),
    });
    if (res.status === 401 || res.status === 403 || res.status === 429) return { _auth: true };
    if (!res.ok) return { _transient: true };
    const json = await res.json();
    if (json.errors) return { _graphql: true };
    return json;
  } catch (e) { return { _transient: true }; }
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseScore(stats) {
  return stats?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;
}

function parseLogo(logoObj) {
  const sizes = logoObj?.sizes || [];
  const s32 = sizes.find(s => s.dimensions?.width === 32);
  return (s32 || sizes[0])?.url || null;
}

function parseQuarters(periods) {
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

function parsePlayers(players) {
  if (!players?.length) return null;
  return players.map(p => ({
    profileID: p.profileID,
    name:      p.name,
    number:    p.playerNumber,
    pts:       parseScore(p.statistics),
    pt1:       p.statistics?.find(s => s.type?.value === '1_POINT_SCORE')?.count  ?? 0,
    pt2:       p.statistics?.find(s => s.type?.value === '2_POINT_SCORE')?.count  ?? 0,
    pt3:       p.statistics?.find(s => s.type?.value === '3_POINT_SCORE')?.count  ?? 0,
    fouls:     p.statistics?.find(s => s.type?.value === 'TOTAL_FOULS')?.count    ?? 0,
  }));
}

// Parse a player's publicProfileStatistics response to find a specific game.
// Returns { h, hn, a, an, rn, isFinalsRound } or null.
function findGameInProfile(profileStats, gameId, seasonId) {
  const seasons = profileStats?.data?.publicProfileStatistics?.seasonStatistics || [];
  for (const season of seasons) {
    for (const reg of (season.statistics || [])) {
      if (reg.season?.id !== seasonId) continue;
      for (const team of (reg.teamStatistics || [])) {
        for (const grade of (team.gradeStatistics || [])) {
          for (const gs of (grade.gameStatistics || [])) {
            if (gs.game?.id !== gameId) continue;
            return {
              h:            gs.game.home?.id   || null,
              hn:           gs.game.home?.name || null,
              a:            gs.game.away?.id   || null,
              an:           gs.game.away?.name || null,
              rn:           gs.game.round?.name || null,
              isFinalsRound: gs.game.round?.isFinalsRound || false,
            };
          }
        }
      }
    }
  }
  return null;
}

// ─── Venue shard cache ────────────────────────────────────────────────────────

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
    shard[venue.id] = {
      name: venue.name, abbr: venue.abbreviatedName || null,
      lat:  venue.latitude || null, lng: venue.longitude || null,
      address: venue.address || null, suburb: venue.suburb || null,
      state: venue.state || null, postcode: venue.postcode || null,
      country: venue.country || null, courts: {},
    };
    _dirtyVenues.add(prefix);
  }
  if (court?.id && !shard[venue.id].courts[court.id]) {
    shard[venue.id].courts[court.id] = { name: court.name, abbr: court.abbreviatedName || null };
    _dirtyVenues.add(prefix);
  }
}

function flushVenues() {
  if (!fs.existsSync(VENUE_DIR)) fs.mkdirSync(VENUE_DIR, { recursive: true });
  for (const prefix of _dirtyVenues) {
    fs.writeFileSync(path.join(VENUE_DIR, `${prefix}.json`), JSON.stringify(_venueShards[prefix]));
  }
  _dirtyVenues.clear();
}

// ─── Player file lookup ───────────────────────────────────────────────────────

// Load a player detail file. Returns null on any failure.
function loadPlayerFile(uuid) {
  try {
    const prefix = uuid.slice(0, 2);
    const file   = path.join(PLAYERS_DIR, prefix, `${uuid}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch (e) { return null; }
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      return { done: new Set(p.done || []) };
    }
  } catch (e) {}
  return { done: new Set() };
}

function saveProgress(prog) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
    done:    [...prog.done],
    savedAt: new Date().toISOString(),
  }));
}

// ─── Git ──────────────────────────────────────────────────────────────────────

function gitCommit(msg) {
  try {
    execSync('git add games/ venue-lookup/ classify-games-progress.json', { stdio: 'pipe', shell: true });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (!diff) return;
    execSync(`git commit -m "${msg}"`, { stdio: 'pipe' });
    execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('\n  ✓ Committed');
  } catch (e) { console.warn(`\n  ⚠ Git: ${e.message}`); }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Classify one game — three-step probe ─────────────────────────────────────
//
// Result types:
//   scored      — discoverGame returned score
//   forfeit     — discoverGame returned FORFEIT outcome
//   cancelled   — discoverGame returned CANCELLED status
//   abandoned   — discoverGame returned ABANDONED status
//   bye         — discoverGame returned BYE status
//   hidden      — discoverGame null, spectator returned score data
//   profileOnly — both null, publicProfileStatistics has structural data
//   legacy      — all three routes exhausted, no data accessible
//   skip        — transient error, retry next run
//
// MANDATORY: discoverGame null → spectator probe → profile probe.
// Never write legacy without exhausting all three steps.
//
// playerGameUUIDs: array of player UUIDs from playerGames[gameId] in the game file.
// seasonId: used to filter the profile stats response to the right season.

async function classifyGame(gameId, seasonId, playerGameUUIDs, session) {

  // ── Step 1: discoverGame ───────────────────────────────────────────────────
  let attempts = 0;
  let dgResp;
  while (attempts < 3) {
    dgResp = await fetchDiscover(gameId, session);
    if (!dgResp._auth) break;
    attempts++;
    await delay(attempts * 2000);
    try { session = await safeRefresh(); } catch (e) {}
  }

  if (dgResp._transient || dgResp._graphql) return { type: 'skip', session };

  const dg = dgResp?.data?.discoverGame;

  if (dg) {
    const statusVal  = dg.status?.value || '';
    const outcomeVal = dg.result?.outcome?.value || '';
    const hs         = parseScore(dg.result?.home?.statistics);
    const as_        = parseScore(dg.result?.away?.statistics);
    const court      = dg.allocation?.court;
    const venue      = court?.venue;
    const time       = dg.allocation?.dateTimeList?.[0]?.time?.slice(0, 5) || null;

    const base = {
      session,
      h:  dg.home?.id   || null, hn: dg.home?.name   || null,
      a:  dg.away?.id   || null, an: dg.away?.name    || null,
      hl: parseLogo(dg.home?.logo), al: parseLogo(dg.away?.logo),
      rn: dg.round?.name || null,
      isFinalsRound: dg.round?.isFinalsRound || false,
      st: statusVal,
      venue, court, time,
    };

    if (outcomeVal.includes('FORFEIT')) {
      return { ...base, type: 'forfeit',
        fo:   dg.result?.winner?.value || null,
        desc: dg.result?.home?.gameOutcomeDescription || null,
      };
    }
    if (statusVal === 'CANCELLED') return { ...base, type: 'cancelled' };
    if (statusVal === 'ABANDONED') return { ...base, type: 'abandoned' };
    if (statusVal === 'BYE')       return { ...base, type: 'bye' };
    return { ...base, type: 'scored', hs, as: as_ };
  }

  // ── Step 2: spectator game(id) ─────────────────────────────────────────────
  // On 403 from spectator: attempt ONE cookie refresh then skip this game.
  // Do NOT retry 403 in a loop — spectator 403s can indicate IP-level blocking
  // and hammering them risks escalating to a full block.
  let spResp = await fetchSpectator(gameId, session);

  if (spResp._spectatorAuth) {
    // One refresh attempt
    try { session = await safeRefresh(); } catch (e) {}
    spResp = await fetchSpectator(gameId, session);
    // If still auth error after refresh, skip to step 3 — don't retry further
    if (spResp._spectatorAuth) {
      // Fall through to step 3 — treat as if spectator returned null
      spResp = { _notfound: true };
    }
  }

  if (spResp._transient || spResp._graphql) return { type: 'skip', session };

  const sp = spResp?.data?.game;
  if (sp) {
    // Spectator returned data — hidden game with score
    const hs  = parseScore(sp.result?.home?.statistics);
    const as_ = parseScore(sp.result?.away?.statistics);
    const hq  = parseQuarters(sp.result?.home?.periods);
    const aq  = parseQuarters(sp.result?.away?.periods);
    const hp  = parsePlayers(sp.statistics?.home?.players);
    const ap  = parsePlayers(sp.statistics?.away?.players);
    return { type: 'hidden', session, hs, as: as_, hq, aq, hp, ap, updatedAt: sp.updatedAt || null };
  }

  // ── Step 3: publicProfileStatistics ───────────────────────────────────────
  // Both discoverGame and spectator returned null (or spectator 403'd after refresh).
  // Try any player from playerGames to recover structural metadata.
  // We only need ONE successful response — stop as soon as we find the game.
  if (playerGameUUIDs?.length) {
    // Try up to 3 players to handle missing/deleted profiles
    const candidates = playerGameUUIDs.slice(0, 3);
    for (const uuid of candidates) {
      let prResp;
      attempts = 0;
      while (attempts < 2) {
        prResp = await fetchProfileStats(uuid, session);
        if (!prResp._auth) break;
        attempts++;
        await delay(attempts * 2000);
        try { session = await safeRefresh(); } catch (e) {}
      }
      if (prResp._transient || prResp._graphql || prResp._auth) continue;

      const found = findGameInProfile(prResp, gameId, seasonId);
      if (found) {
        return { type: 'profileOnly', session, ...found };
      }
      // Profile returned but game not in it — try next player
    }
  }

  // All three steps exhausted
  return { type: 'legacy', session };
}

// ─── Apply result to game entry ───────────────────────────────────────────────

function applyResult(entry, result) {
  const clearFlags = () => {
    delete entry.legacy;
    delete entry.profileOnly;
    delete entry.hidden;
    delete entry.forfeit;
    delete entry.cancelled;
    delete entry.abandoned;
    delete entry.bye;
  };

  const writeTeams = (r) => {
    if (r.h) {
      entry.h  = r.h;  entry.a  = r.a;
      entry.hn = r.hn; entry.an = r.an;
      // h/a supersedes relative fields
      delete entry.o; delete entry.on;
      delete entry.s; delete entry.sn;
    }
    if (r.hl) entry.hl = r.hl;
    if (r.al) entry.al = r.al;
    if (r.rn && !entry.rn) entry.rn = r.rn;
    if (r.isFinalsRound)   entry.finals = true;
  };

  const writeVenue = (r) => {
    if (r.venue?.id) {
      storeVenue(r.venue, r.court);
      entry.vid = r.venue.id;
      entry.vn  = r.venue.name;
      if (r.court?.name) entry.ct = r.court.name;
      if (r.time)        entry.t  = r.time;
    }
    // Never delete existing venue if new result has none
  };

  switch (result.type) {

    case 'scored':
      clearFlags();
      writeTeams(result);
      writeVenue(result);
      if (result.st) entry.st = result.st;
      if (['FINAL', 'CANCELLED', 'ABANDONED', 'BYE', 'PENDING'].includes(result.st)) {
        entry.hs = result.hs !== null ? result.hs : null;
        entry.as = result.as !== null ? result.as : null;
      } else if (result.hs !== null) {
        entry.hs = result.hs;
        entry.as = result.as;
      }
      break;

    case 'forfeit':
      clearFlags();
      entry.forfeit = true;
      entry.fo      = result.fo;
      if (result.desc) entry.desc = result.desc;
      writeTeams(result);
      writeVenue(result);
      if (result.st) entry.st = result.st;
      break;

    case 'cancelled':
      clearFlags();
      entry.cancelled = true;
      writeTeams(result);
      writeVenue(result);
      entry.st = 'CANCELLED';
      break;

    case 'abandoned':
      clearFlags();
      entry.abandoned = true;
      writeTeams(result);
      writeVenue(result);
      entry.st = 'ABANDONED';
      break;

    case 'bye':
      clearFlags();
      entry.bye = true;
      writeTeams(result);
      entry.st = 'BYE';
      break;

    case 'hidden':
      // Preserve any h/a already on the entry (scored-then-hidden case)
      entry.hidden = true;
      if (result.hs !== null && result.hs !== undefined) entry.hs = result.hs;
      if (result.as !== null && result.as !== undefined) entry.as = result.as;
      if (result.hq) entry.hq = result.hq;
      if (result.aq) entry.aq = result.aq;
      if (result.hp?.length) entry.hp = result.hp;
      if (result.ap?.length) entry.ap = result.ap;
      if (result.updatedAt)  entry.updatedAt = result.updatedAt;
      // Do NOT remove o/on — normalise script handles s/sn for hidden games
      break;

    case 'profileOnly':
      // discoverGame and spectator both null.
      // publicProfileStatistics returned structural data.
      // No score, no venue — but we now have absolute h/a and round name.
      clearFlags();
      entry.profileOnly = true;
      writeTeams(result);
      // h/a now written — remove old relative fields
      // (writeTeams already deletes o/on/s/sn when h is present)
      if (result.st) entry.st = result.st;
      break;

    case 'legacy':
      // All three routes exhausted. Preserve whatever is already on the entry.
      entry.legacy = true;
      delete entry.profileOnly; // can't be both
      break;
  }

  return entry;
}

// ─── Determine if a game needs probing ───────────────────────────────────────

function needsProbe(game, isLocked) {
  const st = game.st || '';

  // Never probe upcoming games
  if (st === 'UPCOMING') return false;

  // Non-terminal statuses always need probe
  if (NONTERMINAL_STATUSES.has(st)) return true;

  // No score, no definitive flag
  if (game.hs === undefined && !game.forfeit && !game.hidden && !game.legacy &&
      !game.cancelled && !game.abandoned && !game.bye && !game.profileOnly) return true;

  // Null score — was checked before, re-check
  if (game.hs === null && !game.forfeit && !game.hidden && !game.legacy &&
      !game.cancelled && !game.abandoned && !game.bye && !game.profileOnly) return true;

  // Legacy — may have been flagged before three-step rule; re-probe for profileOnly
  if (game.legacy) return true;

  // Hidden games without venue in locked seasons — try discoverGame for venue recovery
  if (game.hidden && isLocked && !game.vid) return true;

  // profileOnly — already has best available data, do not re-probe
  // (re-probing would just call publicProfileStatistics again and get same result)

  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔍 Classify Games — Three-Step Sweep');
  console.log(`   Tenant:      ${TENANT} (${TENANT_FULL})`);
  console.log(`   Concurrency: ${CONCURRENCY}`);
  console.log(`   Save every:  ${SAVE_EVERY} games`);
  if (TARGET_SEASON) console.log(`   Target:      ${TARGET_SEASON}`);

  const index   = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const seasons = index.seasons || {};
  const prog    = loadProgress();
  let   session = await getSession();

  if (prog.done.size > 0) console.log(`\n  ↻ Resuming — ${prog.done.size.toLocaleString()} games already done`);

  // ── Build work queue ───────────────────────────────────────────────────────

  console.log('\n  Building work queue...');

  // todo items carry the playerUUIDs for the game so classifyGame can do step 3
  // without needing to re-read the game file inside the async batch
  const todo = []; // [{ seasonId, gameId, isLocked, playerUUIDs }]

  const seasonIds = TARGET_SEASON ? [TARGET_SEASON] : Object.keys(seasons);

  for (const seasonId of seasonIds) {
    const gameFile = path.join(GAMES_DIR, `${seasonId}.json`);
    if (!fs.existsSync(gameFile)) continue;
    let sg;
    try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); } catch (e) { continue; }

    const isLocked    = seasons[seasonId]?.locked !== false;
    const playerGames = sg.playerGames || {};

    for (const [gameId, game] of Object.entries(sg.games || {})) {
      if (prog.done.has(gameId))        continue;
      if (!needsProbe(game, isLocked))  continue;
      // Collect up to 3 player UUIDs for this game (for step 3)
      const playerUUIDs = Object.keys(playerGames)
        .filter(uuid => playerGames[uuid].includes(gameId))
        .slice(0, 3);
      todo.push({ seasonId, gameId, isLocked, playerUUIDs });
    }
  }

  console.log(`  Queue: ${todo.length.toLocaleString()} games to probe\n`);
  if (todo.length === 0) { console.log('✅ Nothing to do'); return; }

  // ── Group by season — load one file at a time to bound memory ─────────────

  const bySeason = new Map();
  for (const item of todo) {
    if (!bySeason.has(item.seasonId)) bySeason.set(item.seasonId, []);
    bySeason.get(item.seasonId).push(item);
  }

  // ── Counters ───────────────────────────────────────────────────────────────

  let totalDone = 0, totalSkipped = 0;
  let nScored = 0, nForfeit = 0, nCancelled = 0, nAbandoned = 0,
      nBye = 0, nHidden = 0, nProfileOnly = 0, nLegacy = 0, nVenueRecovered = 0;
  let sinceLastSave = 0;
  const total = todo.length;

  // ── Process season by season ───────────────────────────────────────────────

  for (const [seasonId, items] of bySeason) {
    const gameFile = path.join(GAMES_DIR, `${seasonId}.json`);
    if (!fs.existsSync(gameFile)) { totalDone += items.length; continue; }
    let sg;
    try { sg = JSON.parse(fs.readFileSync(gameFile, 'utf8')); } catch (e) { totalDone += items.length; continue; }
    let dirty = false;

    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const batch = items.slice(i, i + CONCURRENCY);

      const results = await Promise.all(batch.map(async ({ gameId, playerUUIDs }, j) => {
        await delay(j * 5);
        const result = await classifyGame(gameId, seasonId, playerUUIDs, session);
        if (result.session) session = result.session;
        return { gameId, result };
      }));

      for (const { gameId, result } of results) {
        totalDone++;
        sinceLastSave++;

        if (result.type === 'skip') { totalSkipped++; continue; }

        const wasHidden = !!sg.games[gameId]?.hidden;
        const hadVenue  = !!sg.games[gameId]?.vid;

        sg.games[gameId] = applyResult(sg.games[gameId] || {}, result);
        prog.done.add(gameId);
        dirty = true;

        switch (result.type) {
          case 'scored':      nScored++;      break;
          case 'forfeit':     nForfeit++;     break;
          case 'cancelled':   nCancelled++;   break;
          case 'abandoned':   nAbandoned++;   break;
          case 'bye':         nBye++;         break;
          case 'hidden':      nHidden++;      break;
          case 'profileOnly': nProfileOnly++; break;
          case 'legacy':      nLegacy++;      break;
        }

        if (wasHidden && !hadVenue && sg.games[gameId].vid) nVenueRecovered++;
      }

      if (sinceLastSave >= SAVE_EVERY) {
        if (dirty) { fs.writeFileSync(gameFile, JSON.stringify(sg)); dirty = false; }
        flushVenues();
        saveProgress(prog);
        sinceLastSave = 0;
        gitCommit(
          `classify-games: ${nScored} scored, ${nHidden} hidden, ${nProfileOnly} profileOnly, ` +
          `${nLegacy} legacy, ${nForfeit} forfeit, ${nCancelled} cancelled, ${nAbandoned} abandoned, ${nBye} bye`
        );
      }

      const pct = ((totalDone / total) * 100).toFixed(1);
      process.stdout.write(
        `  ${totalDone.toLocaleString()}/${total.toLocaleString()} (${pct}%) — ` +
        `✓ ${nScored} scored  🔒 ${nHidden} hidden  👤 ${nProfileOnly} profileOnly  ` +
        `📜 ${nLegacy} legacy  🏳 ${nForfeit} forfeit  ✗ ${nCancelled} cancelled  ` +
        `💥 ${nAbandoned} abandoned  ☕ ${nBye} bye  ⚠ ${totalSkipped} skip\r`
      );

      if (i + CONCURRENCY < items.length) await delay(50);
    }

    if (dirty) fs.writeFileSync(gameFile, JSON.stringify(sg));
    // sg out of scope — GC reclaims before next season
  }

  flushVenues();
  saveProgress(prog);

  console.log('\n\n✅ Classify complete');
  console.log(`   ✓  Scored:      ${nScored.toLocaleString()}`);
  console.log(`   🔒 Hidden:      ${nHidden.toLocaleString()}`);
  console.log(`   👤 ProfileOnly: ${nProfileOnly.toLocaleString()}`);
  console.log(`   📜 Legacy:      ${nLegacy.toLocaleString()}`);
  console.log(`   🏳 Forfeit:     ${nForfeit.toLocaleString()}`);
  console.log(`   ✗  Cancelled:   ${nCancelled.toLocaleString()}`);
  console.log(`   💥 Abandoned:   ${nAbandoned.toLocaleString()}`);
  console.log(`   ☕ Bye:         ${nBye.toLocaleString()}`);
  console.log(`   🏟 Venue recovered (hidden): ${nVenueRecovered.toLocaleString()}`);
  console.log(`   ⚠  Skipped:    ${totalSkipped.toLocaleString()}`);
  console.log(`   Total probed:  ${totalDone.toLocaleString()}`);

  gitCommit(
    `classify-games complete: ${nScored} scored, ${nHidden} hidden, ${nProfileOnly} profileOnly, ` +
    `${nLegacy} legacy, ${nForfeit} forfeit, ${nCancelled} cancelled, ${nAbandoned} abandoned, ${nBye} bye`
  );
}

main().catch(e => { console.error(`\n❌ Fatal: ${e.message}\n${e.stack}`); process.exit(1); });
