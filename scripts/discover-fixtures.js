#!/usr/bin/env node
// scripts/discover-fixtures.js
/**
 * Discovers fixtures for all teams using discoverTeamFixture — which works for
 * ALL seasons (including historical), returns all rounds in one call per team,
 * and includes venue, court, time, scores, and team details.
 *
 * Strategy:
 *   1. For each season in sports-index.json, get team IDs from discoverGrade.ladder
 *   2. For each team, call discoverTeamFixture(teamID)
 *   3. Write/update game entries in games/bv/{seasonId}.json with:
 *      - Scores (hs, as), venue (vid, vn, ct, t), round name (rn)
 *      - Team IDs and names (h, hn, a, an), game status (st)
 *      - Constructed PlayHQ URL (url)
 *   4. Populate venue-lookup/{prefix}.json shards
 *
 * Safe to re-run — deduplicates by game ID, skips already-complete entries.
 *
 * Usage:
 *   node discover-fixtures.js                       # active seasons only (locked: false)
 *   node discover-fixtures.js --all-seasons         # all seasons including completed
 *   node discover-fixtures.js --locked-resweep      # locked && !removed — §2.2 historical re-sweep
 *   node discover-fixtures.js --current-only        # weekly mode: skip finished seasons
 *   node discover-fixtures.js --season=<id>         # single season (no progress file)
 *   node discover-fixtures.js --concurrency=20      # team fetches in parallel
 *
 * 2026-08-03 hardening (§2.2 Phase 0 findings):
 *   - Progress file is MODE-KEYED BY FILENAME (discover-fixtures-progress-{mode}.json) so a
 *     weekly --current-only run can never resume over — or clear — a cancelled historical
 *     sweep's checkpoint. The old unkeyed file is removed on the next successful run.
 *   - loadGameFile THROWS when an existing season file fails to parse (matches nightly-crawl);
 *     the old {games:{}} fallback would have rewritten a corrupt file as fixture-only data.
 *   - A season where EVERY enumeration call returned null is TRANSIENT (API failure, WAF
 *     block), not zero-team: it is retried in a second pass, and anything still failing turns
 *     the run red AFTER committing — never silently recorded as done-with-no-teams.
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

// ─── Config ───────────────────────────────────────────────────────────────────

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const TENANT        = ARGS.tenant      || 'bv';
const TENANT_FULL   = { bv: 'basketball-victoria', afl: 'afl' }[TENANT] || TENANT;
const CONCURRENCY   = parseInt(ARGS.concurrency || '20', 10);
const TARGET_SEASON = ARGS.season      || null;
const ALL_SEASONS   = !!ARGS['all-seasons'];
const DRY_RUN       = !!ARGS['dry-run'];   // resolve everything, write/commit nothing
const CURRENT_ONLY  = !!ARGS['current-only']; // skip finished seasons (weekly mode)
const LOCKED_RESWEEP = !!ARGS['locked-resweep']; // §2.2: locked && !removed historical re-sweep

if (LOCKED_RESWEEP && (ALL_SEASONS || CURRENT_ONLY || TARGET_SEASON)) {
  console.error('--locked-resweep is exclusive with --all-seasons / --current-only / --season');
  process.exit(1);
}

// Progress-file mode key: every distinct target-selection gets its own file.
const MODE = TARGET_SEASON ? 'single'
  : LOCKED_RESWEEP ? 'locked-resweep'
  : (ALL_SEASONS ? 'all' : 'active') + (CURRENT_ONLY ? '-current' : '');

const API_URL     = 'https://api.playhq.com/graphql';
const GAMES_DIR   = path.join(ROOT, 'games', TENANT);
const VENUE_DIR   = path.join(ROOT, 'venue-lookup');
const INDEX_FILE  = path.join(ROOT, 'data', 'sports-index.json');
const COOKIE_FILE = path.join(ROOT, `cookie-${TENANT}.json`);

// ─── Headers ──────────────────────────────────────────────────────────────────

const MOBILE_HEADERS = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT_FULL,
  'content-type': 'application/json',
};

// ─── Cookie ───────────────────────────────────────────────────────────────────

let _cookie = null;

async function getSession() {
  if (_cookie) return _cookie;
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const d = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      if (Date.now() - d.fetchedAt < 5 * 60 * 60 * 1000) { _cookie = d.cookie; return _cookie; }
    }
  } catch (e) {}
  console.log('  Fetching session cookie...');
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID() },
    body: JSON.stringify({
      operationName: 'ProfileSearch',
      variables:     { fullName: 'test player' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
    }),
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No Set-Cookie');
  _cookie = raw.split(';')[0];
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie: _cookie, fetchedAt: Date.now() }));
  console.log('  ✓ Cookie obtained');
  return _cookie;
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gql(operationName, query, variables) {
  const cookie = await getSession();
  let attempts = 0;
  while (true) {
    try {
      const res = await fetch(API_URL, {
        method:  'POST',
        headers: { ...MOBILE_HEADERS, 'request-id': crypto.randomUUID(), 'Cookie': cookie },
        body:    JSON.stringify({ operationName, variables, query }),
      });
      if (res.status === 429) { await delay(10000); continue; }
      if (!res.ok) { if (attempts++ < 2) { await delay(5000); continue; } return null; }
      const json = await res.json();
      if (json.errors) return null;
      return json.data;
    } catch (e) {
      if (attempts++ < 2) { await delay(3000); continue; }
      return null;
    }
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const Q_GRADE_TEAMS = `
query DiscoverGrade($id: ID!) {
  discoverGrade(gradeID: $id) {
    id name
    ladder {
      pool { name }
      standings { team { id name } }
    }
  }
}`;

const Q_TEAM_FIXTURE = `
query TeamFixture($teamID: ID!) {
  discoverTeam(teamID: $teamID) {
    id
    grade { id name }
    season {
      id name
      competition { id name organisation { id name } }
      status { value }
    }
    organisation { id name }
  }
  discoverTeamFixture(teamID: $teamID) {
    id name isFinalsRound
    grade {
      id name
      season {
        id name
        competition { id name organisation { id name } }
      }
    }
    fixture {
      games {
        id dates
        status { value }
        home {
          ... on DiscoverTeam {
            id name
            logo { sizes { url dimensions { width } } }
            organisation { id name }
          }
        }
        away {
          ... on DiscoverTeam {
            id name
            logo { sizes { url dimensions { width } } }
            organisation { id name }
          }
        }
        result {
          home { statistics { count type { value } } }
          away { statistics { count type { value } } }
        }
        allocation {
          dateTimeList { date time }
          court {
            id name abbreviatedName
            venue {
              id name abbreviatedName
              latitude longitude
              address suburb state postcode country
            }
          }
        }
      }
    }
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[()]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
}

function buildGameUrl(gameId, orgName, compName, seasonName, gradeName) {
  const org   = slugify(orgName);
  const comp  = slugify(`${compName} ${seasonName}`);
  const grade = slugify(gradeName);
  if (!org || !comp || !grade) return null;
  return `https://www.playhq.com/${TENANT_FULL}/org/${org}/${comp}/${grade}/game-centre/${gameId}`;
}

function smallestLogo(logo) {
  if (!logo?.sizes?.length) return null;
  return logo.sizes.sort((a, b) => (a.dimensions?.width || 999) - (b.dimensions?.width || 999))[0]?.url || null;
}

function parseScore(statistics) {
  return statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;
}

// ─── Venue lookup shards ──────────────────────────────────────────────────────

const _venueShards = {};
const _dirtyVenues = new Set();

function loadVenueShard(venueId) {
  const prefix = venueId.slice(0, 2);
  if (!_venueShards[prefix]) {
    const f = path.join(VENUE_DIR, `${prefix}.json`);
    try { _venueShards[prefix] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; }
    catch (e) { _venueShards[prefix] = {}; }
  }
  return _venueShards[prefix];
}

function storeVenue(venue, court) {
  if (!venue?.id) return;
  const prefix = venue.id.slice(0, 2);
  const shard  = loadVenueShard(venue.id);
  if (!shard[venue.id]) {
    shard[venue.id] = {
      name: venue.name, abbr: venue.abbreviatedName || null,
      lat: venue.latitude || null, lng: venue.longitude || null,
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

function flushVenueShards() {
  if (DRY_RUN) return 0;
  if (!fs.existsSync(VENUE_DIR)) fs.mkdirSync(VENUE_DIR, { recursive: true });
  let count = 0;
  for (const prefix of _dirtyVenues) {
    fs.writeFileSync(path.join(VENUE_DIR, `${prefix}.json`), JSON.stringify(_venueShards[prefix]));
    count++;
  }
  _dirtyVenues.clear();
  return count;
}

// ─── Game file helpers ────────────────────────────────────────────────────────

const _gameFileCache = {};
const _dirtySeasons  = new Set();   // only season files with a real change get written

function loadGameFile(seasonId) {
  if (_gameFileCache[seasonId]) return _gameFileCache[seasonId];
  if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });
  const f = path.join(GAMES_DIR, `${seasonId}.json`);
  if (!fs.existsSync(f)) { _gameFileCache[seasonId] = { games: {} }; return _gameFileCache[seasonId]; }
  // An EXISTING file that fails to parse THROWS (matches nightly-crawl's guard). The old
  // {games:{}} fallback meant one corrupt file would be silently rewritten as fixture-only
  // data — losing p[]/spc/hidden games. 2026-08-02 sizing measured 0 parse failures live.
  try { _gameFileCache[seasonId] = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { throw new Error(`loadGameFile: ${seasonId}.json exists but failed to parse (${e.message}) — refusing the empty fallback`); }
  return _gameFileCache[seasonId];
}

function flushGameFiles() {
  if (DRY_RUN) return 0;
  let count = 0;
  for (const seasonId of _dirtySeasons) {
    const sg = _gameFileCache[seasonId];
    if (!sg) continue;
    fs.writeFileSync(path.join(GAMES_DIR, `${seasonId}.json`), JSON.stringify(sg));
    count++;
  }
  _dirtySeasons.clear();
  return count;
}

// Mode-keyed BY FILENAME: the hazard was not just cross-mode resume but cross-mode DELETION —
// a weekly run's clearProgress() would have destroyed a cancelled historical sweep's checkpoint.
const PROGRESS_FILE        = path.join(ROOT, `discover-fixtures-progress-${MODE}.json`);
const LEGACY_PROGRESS_FILE = path.join(ROOT, 'discover-fixtures-progress.json'); // pre-2026-08-03 unkeyed

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) return new Set(JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')).done || []);
  } catch (e) {}
  return new Set();
}

function saveProgress(done) {
  if (DRY_RUN || TARGET_SEASON) return;   // single-season runs keep no checkpoint
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ mode: MODE, done: [...done], savedAt: new Date().toISOString() }));
}

function clearProgress() {
  if (DRY_RUN || TARGET_SEASON) return;
  try { fs.unlinkSync(PROGRESS_FILE); } catch (e) {}
  try { fs.unlinkSync(LEGACY_PROGRESS_FILE); } catch (e) {}   // one-time cleanup of the unkeyed file
}

// ─── Git ──────────────────────────────────────────────────────────────────────

function gitCommitPush(message) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }

  // ── Per-path add (directive 9) ────────────────────────────────────────────
  // `git add` is ATOMIC across pathspecs. The previous form passed all five in
  // ONE call wrapped in an empty catch, so a single non-matching pathspec exited
  // 128, staged NOTHING, and the catch swallowed it — every commit then printed
  // "(no changes to commit)" while a full run's work sat unstaged. That is the
  // 2026-07-19 failure exactly: 30,426 games fetched across 25,448 teams in 28
  // minutes, ZERO committed, job green.
  //
  // REPO_MANIFEST §2.2 and §6.8 record this as fixed on 2026-07-21. It was not
  // fixed in the deployed file — verified 2026-07-31 by reading it and by
  // reproducing the failure with this exact pathspec list.
  //
  // `team-lookup/` is retained in the list because team-lookup-utils still
  // writes it, but it is precisely the pathspec that made this dangerous:
  // README L186 recommends DELETING that directory, and under the old combined
  // add that deletion would have silently broken every commit this script makes.
  // Per-path, its absence now skips only itself.
  const PATHS = [
    'games/',
    'venue-lookup/',
    'team-lookup/',
    path.basename(PROGRESS_FILE),          // mode-keyed checkpoint
    'discover-fixtures-progress.json',     // legacy unkeyed name — stages its one-time deletion
    'zero-team-seasons.json',
  ];
  // A pathspec that matches nothing is BENIGN here (team-lookup/ is gone; the progress and
  // zero-team files only exist sometimes) — git says "did not match any files" and that must
  // not count toward the silent-loss guard below, or a clean no-op with optional paths absent
  // would throw. Anything else from `git add` is a real staging failure and does count.
  let addFailures = 0;
  for (const p of PATHS) {
    try { execFileSync('git', ['add', '--', p], { stdio: 'pipe', cwd: ROOT }); }
    catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      if (/did not match any file/i.test(detail)) continue;   // benign-absent, not a failure
      addFailures++;
      console.error(`  ⚠ git add FAILED "${p}": ${detail}`);
    }
  }

  let staged = '';
  try { staged = execFileSync('git', ['diff', '--staged', '--shortstat'], { stdio: 'pipe', cwd: ROOT }).toString().trim(); }
  catch (e) {}

  if (!staged) {
    // Nothing staged AFTER a staging failure is the silent-loss signature, not a
    // clean no-op — refuse to report it as success. All adds clean and nothing
    // staged is genuinely nothing to do.
    if (addFailures) {
      throw new Error(`gitCommitPush: nothing staged and ${addFailures} path(s) failed to stage — refusing to report a clean no-op ("${message}")`);
    }
    console.log('  (no changes to commit)');
    return;
  }
  console.log(`  staging: ${staged}`);   // directive 9: prove what was staged

  // Identity inline on commit AND merge: a missing committer identity otherwise
  // surfaces only as a merge failure and burns the whole retry budget on a
  // config problem retrying cannot fix.
  const IDENT = ['-c', 'user.name=github-actions[bot]',
                 '-c', 'user.email=github-actions[bot]@users.noreply.github.com'];

  // execFileSync with an argument array — the message is no longer interpolated
  // into a shell string, so the `"` -> `'` escaping hack is gone with it.
  try { execFileSync('git', [...IDENT, 'commit', '-q', '-m', message], { stdio: 'pipe', cwd: ROOT }); }
  catch (e) {
    const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
    throw new Error(`gitCommitPush: commit failed for "${message}" — ${detail}`);
  }

  // ── Push with retry (house pattern) ───────────────────────────────────────
  // 60 attempts, pure random 1-91s jitter, `merge --abort` before each attempt,
  // THROW on total failure. The previous loop ended in `console.warn` + `return`,
  // so a run could push NOTHING and still exit 0 — the same swallow closed on
  // build-team-stats.js (2026-07-29) and on nightly-crawl.js (2026-07-31).
  // Only genuine contention is retried; anything else (auth, branch protection,
  // hook rejection) fails fast with git's real error instead of being buried
  // under 60 identical lines.
  const MAX_ATTEMPTS = 60;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try { execFileSync('git', ['merge', '--abort'], { stdio: 'pipe', cwd: ROOT }); } catch (_) { /* none in progress */ }

    try {
      execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'pipe', cwd: ROOT });
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) throw e;
      const waitSec = 1 + Math.floor(Math.random() * 91);
      console.log(`  fetch failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${waitSec}s`);
      try { execFileSync('sleep', [String(waitSec)], { stdio: 'pipe' }); } catch (_) {}
      continue;
    }

    // A merge failure is a config or content problem, not a race — fatal.
    execFileSync('git', [...IDENT, 'merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat'], { stdio: 'pipe', cwd: ROOT });

    try {
      execFileSync('git', ['push', 'origin', 'HEAD:main'], { stdio: 'pipe', cwd: ROOT });
      console.log(`  ✓ Committed and pushed (attempt ${attempt})`);
      return;
    } catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
      const contention = /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(detail);
      if (!contention) {
        console.error(`  push failed — NOT contention, failing fast. git said:\n${detail}`);
        throw e;
      }
      if (attempt === MAX_ATTEMPTS) {
        console.error(`  push still rejected after ${MAX_ATTEMPTS} attempts. git said:\n${detail}`);
        throw e;
      }
      const waitSec = 1 + Math.floor(Math.random() * 91);
      console.log(`  push attempt ${attempt}/${MAX_ATTEMPTS} rejected (remote advanced), re-syncing in ${waitSec}s`);
      try { execFileSync('sleep', [String(waitSec)], { stdio: 'pipe' }); } catch (_) {}
    }
  }
  throw new Error(`gitCommitPush: exhausted ${MAX_ATTEMPTS} push attempts for "${message}"`);
}

// ─── Change detection ─────────────────────────────────────────────────────────
// Fields this script owns on a game object. A game is only rewritten (and only
// counted/logged as "updated") when one of these actually changes — everything
// else on the object (nightly-crawl's player roster `p`, the `spc` flag, etc.) is
// preserved by merging rather than replacing.
const TRACKED = ['d', 'rn', 'h', 'hn', 'a', 'an', 'hs', 'as', 'vid', 'vn', 'ct', 't', 'st'];

function diffEntry(existing, entry) {
  const changes = [];
  for (const k of TRACKED) {
    const o = existing[k], n = entry[k];
    if (o !== n) changes.push([k, o, n]);
  }
  return changes;
}

function fmtVal(v) {
  if (v === undefined || v === null) return '∅';
  const s = String(v);
  return s.length > 24 ? s.slice(0, 24) + '…' : s;
}

// ─── Process a single team's fixtures ────────────────────────────────────────

async function processTeam(teamId, seasonId) {
  const data = await gql('TeamFixture', Q_TEAM_FIXTURE, { teamID: teamId });
  if (!data?.discoverTeamFixture) return { added: 0, updated: 0, updates: [] };

  const team     = data.discoverTeam;
  const rounds   = data.discoverTeamFixture;
  const orgName  = team?.season?.competition?.organisation?.name || '';
  const compName = team?.season?.competition?.name || '';
  const sName    = team?.season?.name || '';
  const gradeName = team?.grade?.name || '';

  // Use grade's season ID if available (more accurate than passed-in seasonId)
  const effectiveSeasonId = rounds[0]?.grade?.season?.id || seasonId;

  // Store team in team-lookup if utils available
  try {
    const { storeLookupEntry, flushLookupShards } = require('./team-lookup-utils');
    if (team?.id) {
      storeLookupEntry({
        id: team.id, name: team.grade?.name ? `${team.id}` : team.id,
        logo: null, organisation: team.organisation,
        grade: team.grade,
        season: team.season,
      });
    }
  } catch (e) {}

  const sg = loadGameFile(effectiveSeasonId);
  let added = 0, updated = 0; const updates = [];

  for (const round of rounds) {
    const roundName    = round.name;
    const roundOrgName  = round.grade?.season?.competition?.organisation?.name || orgName;
    const roundCompName = round.grade?.season?.competition?.name || compName;
    const roundSeasonName = round.grade?.season?.name || sName;
    const roundGradeName  = round.grade?.name || gradeName;

    for (const game of (round.fixture?.games || [])) {
      if (!game?.id) continue;

      const existing  = sg.games[game.id];
      // A game with a recorded score (or FINAL/forfeit) is history: nightly-crawl
      // captured its as-played teams/venue/time alongside the score, so a later
      // PlayHQ edit must NOT rewrite it. Only manage unplayed fixtures (and games
      // not yet on file). This is also what keeps team-id swaps and archival
      // "ZZ - … - W" renames off completed games.
      if (existing && (existing.hs !== undefined || existing.as !== undefined
                       || existing.st === 'FINAL' || existing.forfeit === true)) continue;
      const homeScore = parseScore(game.result?.home?.statistics);
      const awayScore = parseScore(game.result?.away?.statistics);
      const status    = game.status?.value || null;
      const court     = game.allocation?.court;
      const venue     = court?.venue;
      const dt        = game.allocation?.dateTimeList?.[0];
      const time      = dt?.time ? dt.time.slice(0, 5) : null;
      const date      = dt?.date || game.dates?.[0] || existing?.d || null;
      const url       = buildGameUrl(game.id, roundOrgName, roundCompName, roundSeasonName, roundGradeName);

      if (venue) storeVenue(venue, court);

      const entry = {
        d:   date,
        rn:  roundName,   // BARE round name — matches nightly-crawl (line 570) and
                          // isFinal(rn) detection; a "Finals — " prefix here diverged
                          // from stored data and churned every finals game.
        h:   game.home?.id   || existing?.h   || null,
        hn:  game.home?.name || existing?.hn  || null,
        a:   game.away?.id   || existing?.a   || null,
        an:  game.away?.name || existing?.an  || null,
        ...(homeScore !== null ? { hs: homeScore } : existing?.hs !== undefined ? { hs: existing.hs } : {}),
        ...(awayScore !== null ? { as: awayScore } : existing?.as !== undefined ? { as: existing.as } : {}),
        ...(venue?.id   ? { vid: venue.id }    : existing?.vid ? { vid: existing.vid } : {}),
        ...(venue?.name ? { vn:  venue.name }  : existing?.vn  ? { vn:  existing.vn  } : {}),
        ...(court?.name ? { ct:  court.name }  : existing?.ct  ? { ct:  existing.ct  } : {}),
        ...(time        ? { t:   time }         : existing?.t   ? { t:   existing.t   } : {}),
        // url omitted — PlayHQ game URL not used in StatTrack
        ...(status      ? { st: status }        : existing?.st ? { st: existing.st } : {}),
      };

      if (!existing) {
        sg.games[game.id] = entry;
        added++;
        _dirtySeasons.add(effectiveSeasonId);
      } else {
        // Only touch the game when a fixture field actually changed, and MERGE over
        // the existing object so nightly-crawl's player roster (`p`) and `spc` flag
        // (and anything else on it) survive — a blind replace would wipe them.
        const changes = diffEntry(existing, entry);
        if (changes.length) {
          sg.games[game.id] = { ...existing, ...entry };
          updated++;
          _dirtySeasons.add(effectiveSeasonId);
          updates.push({ gid: game.id, changes });
        }
      }

      // Also store team logo in team-lookup
      try {
        const { storeLookupEntry } = require('./team-lookup-utils');
        const teamSeason = { id: effectiveSeasonId, name: roundSeasonName, status: { value: status },
          competition: { id: null, name: roundCompName, organisation: { id: null, name: roundOrgName } } };
        const teamGrade  = { id: round.grade?.id || null, name: roundGradeName };
        if (game.home?.id) storeLookupEntry({ ...game.home, logo: { sizes: game.home.logo?.sizes }, season: teamSeason, grade: teamGrade });
        if (game.away?.id) storeLookupEntry({ ...game.away, logo: { sizes: game.away.logo?.sizes }, season: teamSeason, grade: teamGrade });
      } catch (e) {}
    }
  }

  return { added, updated, updates };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== discover-fixtures.js ===');
  console.log(`Tenant:      ${TENANT}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Mode:        ${TARGET_SEASON ? `single season ${TARGET_SEASON}` : LOCKED_RESWEEP ? 'locked re-sweep (locked && !removed)' : ALL_SEASONS ? 'all seasons' : 'active only (locked: false)'}${CURRENT_ONLY ? ' [current-only]' : ''}${DRY_RUN ? '   [DRY RUN — no writes/commits]' : ''}  progress-key: ${MODE}\n`);

  if (!fs.existsSync(INDEX_FILE)) { console.error('sports-index.json not found'); process.exit(1); }

  const index   = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const seasons = Object.values(index.seasons || {});

  let targets = seasons;
  if (TARGET_SEASON) {
    targets = seasons.filter(s => s.id === TARGET_SEASON);
    if (targets.length === 0) targets = [{ id: TARGET_SEASON, grades: [] }];
  } else if (LOCKED_RESWEEP) {
    // §2.2: every locked, non-removed season. removed:true stubs are unfetchable by design
    // (bare --all-seasons would waste probes on all 274 of them and pollute zero-team).
    targets = seasons.filter(s => s.locked === true && s.removed !== true);
  } else if (!ALL_SEASONS) {
    targets = seasons.filter(s => s.locked === false);
  }

  if (CURRENT_ONLY && !TARGET_SEASON) {
    // Weekly mode: skip seasons that are clearly finished — no local game dated
    // within the last GRACE_DAYS and none in the future. New/empty seasons (no
    // local games yet) are kept so their fixtures still get discovered. Makes the
    // weekly run scale with current activity instead of all history — no fetch for
    // the seasons it skips.
    const GRACE_DAYS = 21;
    const cutoff = new Date(Date.now() - GRACE_DAYS * 86400000).toISOString().slice(0, 10);
    const before = targets.length;
    targets = targets.filter(s => {
      const sg = loadGameFile(s.id);
      const dates = Object.values(sg.games || {}).map(g => g && g.d).filter(Boolean);
      if (dates.length === 0) return true;                        // never fetched -> keep
      return dates.reduce((a, b) => (a > b ? a : b)) >= cutoff;   // has recent/future game
    });
    console.log(`--current-only: ${targets.length} active of ${before} seasons (skipped ${before - targets.length} finished)`);
  }

  console.log(`Seasons to process: ${targets.length}`);

  await getSession();

  const doneSeasonsSet = TARGET_SEASON ? new Set() : loadProgress();
  const remaining = targets.filter(s => !doneSeasonsSet.has(s.id));
  if (doneSeasonsSet.size > 0) console.log(`  ↻ Resuming — ${doneSeasonsSet.size} already done, ${remaining.length} remaining`);

  let totalAdded = 0, totalUpdated = 0, totalTeams = 0, seasonsProcessed = 0;
  let sinceLastCommit = 0;
  const zeroTeamSeasons = [];

  // Sweep one season. Returns 'ok' | 'zero-team' | 'transient'.
  // TRANSIENT means every enumeration call for the season returned null — that is an API
  // failure (WAF block, network), NOT a season with no ladder, and it must never be marked
  // done: the old behaviour recorded such seasons as done-zero-team, permanently for the run.
  async function sweepSeason(season, tag) {
    const seasonId = season.id;
    const grades   = (season.grades || []).slice();   // never mutate the index object
    let probeCalls = 0, probeNulls = 0;

    if (grades.length === 0) {
      probeCalls++;
      const data = await gql('DiscoverSeason', `query DiscoverSeason($id: String!) { discoverSeason(seasonID: $id) { id name grades { id name } } }`, { id: seasonId });
      if (!data) probeNulls++;
      if (data?.discoverSeason?.grades) grades.push(...data.discoverSeason.grades);
    }

    console.log(`\n📅 ${tag} ${season.fullName || season.name || seasonId} — ${seasonId} (${grades.length} grades)`);

    // Collect all unique team IDs across all grades in this season — parallelised
    const teamIds = new Set();
    for (let i = 0; i < grades.length; i += CONCURRENCY) {
      const batch = grades.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(g => gql('DiscoverGrade', Q_GRADE_TEAMS, { id: g.id })));
      for (const data of results) {
        probeCalls++;
        if (!data) { probeNulls++; continue; }
        for (const pool of (data?.discoverGrade?.ladder || [])) {
          for (const s of (pool.standings || [])) {
            if (s.team?.id) teamIds.add(s.team.id);
          }
        }
      }
    }

    if (teamIds.size === 0) {
      if (probeCalls > 0 && probeNulls === probeCalls) {
        console.log(`  Teams: 0 ⚠ every enumeration call (${probeCalls}) returned null — TRANSIENT, not marking done`);
        return 'transient';
      }
      console.log(`  Teams: 0 ⚠ no ladder data — season ID: ${seasonId}`);
      zeroTeamSeasons.push({ id: seasonId, name: season.fullName || season.name, grades: grades.length });
      return 'zero-team';
    }
    console.log(`  Teams: ${teamIds.size}`);

    const teamArr = [...teamIds];
    let seasonAdded = 0, seasonUpdated = 0; const seasonUpdates = [];

    for (let i = 0; i < teamArr.length; i += CONCURRENCY) {
      const batch = teamArr.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(tid => processTeam(tid, seasonId)));
      for (const r of results) { seasonAdded += r.added; seasonUpdated += r.updated; if (r.updates.length) seasonUpdates.push(...r.updates); }
      totalTeams += batch.length;
      process.stdout.write(`  ${Math.min(i + CONCURRENCY, teamArr.length)}/${teamArr.length} teams (${seasonAdded} new, ${seasonUpdated} updated)\r`);
      if (i + CONCURRENCY < teamArr.length) await delay(100);
    }

    console.log(`  ✓ ${seasonAdded} new games, ${seasonUpdated} updated`);
    // Record exactly what changed (game id + field old→new) — an audit trail, not just a count.
    for (const u of seasonUpdates) {
      console.log(`    ↻ ${u.gid}  ${u.changes.map(([f, o, n]) => `${f} ${fmtVal(o)}→${fmtVal(n)}`).join(', ')}`);
    }
    totalAdded   += seasonAdded;
    totalUpdated += seasonUpdated;
    return 'ok';
  }

  // One pass over a season list; returns the transient leftovers.
  async function runPass(list, label) {
    const leftover = [];
    let n = 0;
    for (const season of list) {
      n++;
      const status = await sweepSeason(season, `[${label} ${n}/${list.length}]`);
      if (status === 'transient') { leftover.push(season); continue; }
      seasonsProcessed++;
      sinceLastCommit++;
      doneSeasonsSet.add(season.id);
      saveProgress(doneSeasonsSet);

      if (sinceLastCommit >= 10) {
        const gf = flushGameFiles();
        const vf = flushVenueShards();
        if (!DRY_RUN) { try { const { flushLookupShards } = require('./team-lookup-utils'); flushLookupShards(); } catch (e) {} }
        console.log(`\n  💾 Flushed ${gf} game files, ${vf} venue shards — committing...`);
        gitCommitPush(`Fixture discovery: ${seasonsProcessed} seasons, +${totalAdded} games`);
        sinceLastCommit = 0;
      }
    }
    return leftover;
  }

  let stillTransient = await runPass(remaining, 'main');
  if (stillTransient.length) {
    console.log(`\n↻ Retry pass — ${stillTransient.length} transient season(s)`);
    stillTransient = await runPass(stillTransient, 'retry');
  }
  if (stillTransient.length) {
    // Survived a full retry pass: mark done so the progress lifecycle stays intact (weekly
    // runs must still clear at end), but do NOT record as zero-team, and turn the run RED
    // after the final commit so it is investigated rather than trusted.
    console.log(`\n⚠ ${stillTransient.length} season(s) still returned null on every call after retry — marking done, NOT recording as zero-team:`);
    for (const s of stillTransient) {
      console.log(`    ${s.id}  ${s.fullName || s.name || ''}`);
      doneSeasonsSet.add(s.id);
    }
    saveProgress(doneSeasonsSet);
  }

  // Final flush
  const gf = flushGameFiles();
  const vf = flushVenueShards();
  if (!DRY_RUN) { try { const { flushLookupShards } = require('./team-lookup-utils'); flushLookupShards(); } catch (e) {} }

  console.log(`\n✅ Done`);
  console.log(`  Seasons:       ${seasonsProcessed}`);
  console.log(`  Teams:         ${totalTeams.toLocaleString()}`);
  console.log(`  Added:         ${totalAdded.toLocaleString()}`);
  console.log(`  Updated:       ${totalUpdated.toLocaleString()}`);
  console.log(`  Zero-team:     ${zeroTeamSeasons.length} (no ladder data — saved to zero-team-seasons.json)`);
  console.log(`  Transient:     ${stillTransient.length} (null on every call, survived retry — run goes RED)`);

  if (zeroTeamSeasons.length > 0 && !DRY_RUN) {
    fs.writeFileSync(path.join(ROOT, 'zero-team-seasons.json'), JSON.stringify(zeroTeamSeasons, null, 2));
  }

  clearProgress();
  gitCommitPush(`Fixture discovery complete: ${seasonsProcessed} seasons, ${totalAdded.toLocaleString()} new games`);

  if (stillTransient.length) {
    console.error(`\n✗ ${stillTransient.length} season(s) unreachable on every attempt — failing the run (work above is committed).`);
    process.exit(1);
  }
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
