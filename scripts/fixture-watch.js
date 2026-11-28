// scripts/fixture-watch.js
//
// Follows PLAYERS, across SPORTS. Alerts on anything that happens to the fixtures
// of the teams those players are currently registered to.
//
// ─── WHAT IT ALERTS ON ───────────────────────────────────────────────────────
//   · a game added
//   · a game's date, time, venue, court or opponent changed
//   · a game removed or withdrawn
//   · a REGRADE — the team's games now carry a different grade id
//   · a team appearing on, or disappearing from, a player's profile
//   · a team's fixture dropping to ZERO — louder, because it usually means the
//     regrade was made as a NEW team entry and the real fixture is somewhere else
//   · the first time a team is seen: ONE baseline summary per player, never one
//     alert per existing game
//
// ─── THE RULE THAT OUTRANKS EVERY OTHER RULE HERE ────────────────────────────
// A FAILED FETCH MUST NEVER LOOK LIKE AN EMPTY OR CHANGED FIXTURE.
//
// A 403, a GraphQL error, a timeout or a refused session produces NO alert about
// games, does NOT overwrite the saved state for that team, and does not advance
// anything. Every PlayHQ call returns a TYPED outcome and "I could not ask" is never
// stored as "the answer is none". The run goes red and sends ONE separate
// "watcher failed" alert, rate-limited so a PlayHQ outage does not empty the phone
// battery. A CloudFront hard block (403 with an HTML body) is reported as a
// different thing from an application 403, because they mean different things and
// need different responses.
//
// ─── FAST PUBLISH ON FINAL ───────────────────────────────────────────────────
// When a watched team's game flips to FINAL, dispatch StatTrack's
// publish-final-game.yml so the result, the box score and the players' profile
// stats are live within minutes instead of waiting for the 01:00 nightly.
//
// ⚠️ THIS WAS DELETED BY A WHOLESALE REWRITE ON 2026-11-24 AND RESTORED ON
//    2026-11-27. It was live from 2026-11-23 (commit 6f09a113) and three uploads
//    on the 24th replaced the file without it, so every FINAL in between waited
//    for the nightly. If you are about to rewrite this file rather than patch it,
//    diff against `main` first.
//
// ⚠️ ABSENT CONFIG MEANS OFF. No `publishOnFinal` block, or no
//    STATTRACK_DISPATCH_TOKEN in the environment, and this does nothing at all.
//    Failure direction is always "no dispatch", never "a dispatch we did not mean".
//
// ⚠️ IT IS PER SPORT. publish-final-game.yml lives in the BASKETBALL repo and
//    takes a basketball season, grade and round. A footy FINAL dispatched there
//    would send afl ids into sports-players-stats. So the config hangs off the
//    sport, not the run, and a sport without one never dispatches.
//
// ⚠️ Scores are still NOT watched (§6 of the project notes). This hangs off `st`,
//    which has been in FIELDS and diffed since the first version — a game going
//    PENDING/UPCOMING → FINAL is a STATUS change, not a score change, and it fires
//    once per game rather than once per score update.
//
// ─── SPORTS ARE CONFIGURATION, NOT CODE ──────────────────────────────────────
// watch.json carries a `sports` block; each sport names a PlayHQ tenant and the
// shape of its alert link. Footy was added on 2026-11-24 and needed no new fixture
// logic at all: the basketball query shapes port to tenant `afl` verbatim.
//
// ⚠️ ONE SESSION PER TENANT, AND IT IS NOT OPTIONAL.
// The PlayHQ session cookie is obtained with the `tenant` header already set, so it
// is TENANT-SCOPED. The cookie, its single-flight promise and its budget guard used
// to be module-level singletons; with two tenants in one pass that sends a
// basketball cookie to the afl tenant, which comes back looking exactly like an
// authentication fault and says nothing about tenants in the log. They are now
// owned by a per-tenant client — see createTenantClient() — and the budget is
// counted per tenant, which is also the correct reading of the ~290-call limit.
//
// ⚠️ A TENANT FAILING ENTIRELY MUST NOT STOP THE OTHER. Each sport's failures are
// typed and labelled exactly as a team's are; the loop moves on to the next sport.
//
// ─── POLLING NEVER "COMPLETES" DURING A SEASON ───────────────────────────────
// Detecting a complete fixture is unreliable and stopping would miss regrades and
// finals. So:
//   The cadence is decided by FIXTURE COVERAGE, not by the calendar.
//
//   `discoverGrade` returns the grade's whole round list the moment the grade is
//   set up — `rounds { id name number isFinalsRound }`. So "has this team got a
//   game in every round that exists?" is answerable, and it is the right question:
//   a team with a game in every non-finals round has nothing left to be published
//   until finals, and a team missing rounds is mid-way through a fixture block.
//
//   REDUCED — every Nth slot (`completeFixtureSlotsEvery`). ONLY a team that has a
//             game in EVERY non-finals round of its current grade AND still has a
//             game in the future AND has not changed in the last
//             `activeChangeWindowDays`. There is nothing left to publish for it
//             right now. NEVER stopped.
//   FULL    — every slot. Everything else, and in particular:
//             · a team missing rounds — the next fixture block is being published;
//             · a team whose LAST SCHEDULED GAME HAS PASSED — this is the finals
//               hunt, and it is the moment the watcher matters most;
//             · a team whose grade round list could not be fetched, or whose grade
//               is unknown. Every unknown falls to FULL. The failure direction is
//               more checking, never less.
//
//   ⚠️ IF A BYE ROUND DOES NOT APPEAR IN A TEAM'S FIXTURE, coverage never reaches
//   complete and the team simply stays on FULL for ever. That costs call volume and
//   nothing else — it can never cause a missed alert. The log names the missing
//   rounds on every check so the cause is visible rather than guessed at.
//   ⚠️ BYES ARE REAL IN FOOTY AND MEASURED: Norwood U11 returned 16 rounds and 15
//   games. Footy teams will therefore mostly sit on FULL. That is the safe
//   direction and the coverage rule is NOT to be loosened to make REDUCED engage.
//   STOP    — only when the team leaves the player's profile, the player is removed
//             from watch.json, or `stopAfterSeasonEndDays` have passed since the
//             season's endDate. A season with NO endDate is NEVER stopped on age:
//             808 seasons in the sibling database have no endDate and a missing date
//             is not an ended season.
//             ⚠️ FOOTY SEASONS STRADDLE THE CALENDAR YEAR — 2026 ran 2025-10-01 to
//             2026-09-30 — so startDate can be in the previous year. The arithmetic
//             here is on endDate alone and is unaffected. Nothing to "fix".
//
// ─── IDENTITY ────────────────────────────────────────────────────────────────
// A team can hold two grades in one season. The identity of a registration is
// (tid, gid), NEVER tid alone. The grade is tracked per GAME, which is the only
// place a grade carries a date, and a change in the set of grades across a team's
// games is a REGRADE.
//
// State files are keyed by TEAM ID, which is globally unique across tenants, so
// adding a sport cannot collide with an existing file. Each state file's `reg`
// block records which sport it belongs to.
//
// ─── PROVENANCE OF EVERY PLAYHQ-FACING LINE ──────────────────────────────────
// HEADERS_BASE, COOKIE_QUERIES, refreshSession(), doFetch(), isWafBlock,
// Q_PROFILE_TEAMS and Q_TEAM_FIXTURE are COPIED VERBATIM from the live scripts in
// markjovic/sports-players-stats — never written from scratch, never trimmed:
//   · HEADERS_BASE, COOKIE_QUERIES, refreshSession, doFetch, isWafBlock,
//     Q_PROFILE_TEAMS   → scripts/discover-seasons.js  (staged copy 2026-10-13)
//   · Q_TEAM_FIXTURE    → scripts/discover-fixtures.js (staged copy 2026-10-13)
//   · lib/playhq-session.cjs → copied as a whole file, unmodified
// The ONE adaptation to refreshSession: the source branches on a matrix-shard flag
// that does not exist here, so it takes the non-shard branch. No query, header or
// client behaviour is changed. Between tenants ONLY the `tenant` header value
// differs — accept, origin, user-agent and content-type are identical, and that was
// measured on tenant `afl` on 2026-11-24: fetch() obtained a session first attempt
// and all three query shapes answered unchanged.
//
// ⚠️ fetch() ONLY. Never https.request, never a hand-set content-length — measured
//    on one runner ten seconds apart, same URL and headers: fetch() granted,
//    https.request refused.
// ⚠️ NEVER actions/setup-node in a job that calls api.playhq.com.
// ⚠️ Request volume is deliberately small: one profile call per player PER SPORT,
//    then one fixture call per team to check, sequential, with a delay between
//    calls. Footy adds +1 call a pass out of season and roughly +3 in season,
//    against ~9 a pass and a ~290-call per-tenant session budget.
//
// USAGE
//   node scripts/fixture-watch.js [--dry-run] [--force] [--no-alerts]
//                                 [--players=<uuid>,...] [--sports=footy,...]
//                                 [--delay=600]
//     --dry-run    do everything, write and commit nothing, print the alerts
//     --force      ignore the Melbourne-time slot gate and run now
//     --no-alerts  suppress Pushover entirely (still writes state)
//     --players    restrict this run to these uuids (must be in watch.json)
//     --sports     restrict this run to these sports (must be in watch.json)

'use strict';

const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const { execFileSync } = require('child_process');
const { createSessionGuard } = require('./lib/playhq-session.cjs');
const { slotDecision }       = require('./lib/schedule-gate.cjs');
const pushover               = require('./lib/pushover.cjs');
const { teamUrlFor, urlTitleFor } = require('./lib/team-links.cjs');
const netballClient          = require('./lib/netball-connect.cjs');
const nb                     = require('./lib/netball-watch.cjs');

const ROOT       = path.join(__dirname, '..');
const STATE_DIR  = path.join(ROOT, 'state');
const CONFIG     = path.join(ROOT, 'watch.json');
const PLAYERS_ST = path.join(STATE_DIR, '_players.json');
// ⚠️ NETBALL STATE LIVES IN state/, NOT IN watch.json.
// The spec (§7) puts it in watch.json. That is the one place the spec is wrong
// about THIS repo, and the deviation is deliberate: watch.json is hand-edited in
// the GitHub web UI and never written by the bot, while every push here goes out
// with `merge -X ours`. A bot write to watch.json racing a hand edit would discard
// the hand edit silently. The spec's actual rule is about CONTENT — "committed
// state must not identify the child" — and that is satisfied identically here.
// Everything else in §7 (alias keys, HMAC state keys, the stored field list) is
// implemented exactly as written.
const NETBALL_ST = path.join(STATE_DIR, '_netball.json');
const META_ST    = path.join(STATE_DIR, '_meta.json');

// ─── Arguments ────────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const argOf = (name, dflt) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a === undefined ? dflt : a.slice(name.length + 3).trim();
};
const DRY_RUN   = args.includes('--dry-run');
const FORCE     = args.includes('--force');
const NO_ALERTS = args.includes('--no-alerts');
const ONLY      = (argOf('players', '') || '').split(/[\s,]+/).filter(Boolean);
const ONLY_SPORTS = (argOf('sports', '') || '').split(/[\s,]+/).filter(Boolean);
const NC_NOW      = args.includes('--nc-now');   // ignore the Netball Connect cadence gate
const DELAY_MS  = (() => { const n = parseInt(argOf('delay', '600'), 10); return Number.isFinite(n) && n >= 0 ? n : 600; })();

const API_URL = 'https://api.playhq.com/graphql';
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso  = () => new Date().toISOString();

// ─── Config ───────────────────────────────────────────────────────────────────
if (!fs.existsSync(CONFIG)) { console.error(`FATAL: ${CONFIG} does not exist.`); process.exit(2); }
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
catch (err) { console.error(`FATAL: watch.json does not parse: ${err.message}`); process.exit(2); }

// ⚠️ THE TOP-LEVEL `tenant` / `sport` / `stattrackBase` KEYS STILL WORK.
// They are the pre-footy shape and they are deliberately kept as a fallback: a
// half-finished edit to the `sports` block must never leave the watcher quietly
// watching nothing. If `sports` is missing or empty, the old keys rebuild the
// single-sport configuration exactly as it was.
const LEGACY_SPORT  = cfg.sport || 'basketball';
const LEGACY_TENANT = cfg.tenant || 'basketball-victoria';

const SPORTS = {};
{
  const raw = (cfg.sports && typeof cfg.sports === 'object' && !Array.isArray(cfg.sports)) ? cfg.sports : null;
  const entries = raw && Object.keys(raw).length
    ? Object.entries(raw)
    : [[LEGACY_SPORT, { tenant: LEGACY_TENANT, link: { kind: 'stattrack', base: cfg.stattrackBase || null } }]];
  for (const [key, s] of entries) {
    const sp = (s && typeof s === 'object') ? s : {};
    // publishOnFinal belongs to the SPORT. A top-level block is read only for the
    // legacy sport, the same fallback the tenant and link keys use, so the
    // pre-footy config keeps working untouched.
    const rawPub = (sp.publishOnFinal && typeof sp.publishOnFinal === 'object') ? sp.publishOnFinal
                 : (key === LEGACY_SPORT && cfg.publishOnFinal && typeof cfg.publishOnFinal === 'object') ? cfg.publishOnFinal
                 : null;
    SPORTS[key] = {
      key,
      label:  sp.label || (key.charAt(0).toUpperCase() + key.slice(1)),
      tenant: sp.tenant || LEGACY_TENANT,
      link:   sp.link || (key === LEGACY_SPORT && cfg.stattrackBase ? { kind: 'stattrack', base: cfg.stattrackBase } : {}),
      orgShortCodes: sp.orgShortCodes || {},
      publish: rawPub ? {
        repo:      rawPub.repo ? String(rawPub.repo) : '',
        workflow:  rawPub.workflow ? String(rawPub.workflow) : 'publish-final-game.yml',
        ref:       rawPub.ref ? String(rawPub.ref) : 'main',
        // A regrade can flip a whole block of games at once. Grouping by
        // (grade, round) collapses most of that, but a run that wants more rounds
        // than this dispatches NONE and says so: the nightly already handles bulk
        // correctly, and a burst of dispatches from a watcher is the kind of thing
        // that is noticed only after it has happened.
        maxRounds: Number.isFinite(rawPub.maxRoundsPerPass) ? rawPub.maxRoundsPerPass : 6,
        enabled:   rawPub.enabled !== false,
      } : null,
    };
  }
}

// The PAT. GITHUB_TOKEN cannot create a workflow run in another repository, so a
// token with actions:write on the target repo is required.
const PUB_TOKEN = process.env.STATTRACK_DISPATCH_TOKEN || '';
for (const key of Object.keys(SPORTS)) {
  const sp = SPORTS[key];
  if (!sp.publish) continue;
  sp.publish.active = !!(sp.publish.enabled && sp.publish.repo && PUB_TOKEN);
  if (!sp.publish.active) {
    console.log(`[fixture-watch] ${sp.label}: publish-on-FINAL configured but INACTIVE — ${!sp.publish.repo ? 'publishOnFinal.repo is empty' : !PUB_TOKEN ? 'STATTRACK_DISPATCH_TOKEN is not set' : 'publishOnFinal.enabled is false'}.`);
  } else {
    console.log(`[fixture-watch] ${sp.label}: publish-on-FINAL ACTIVE → ${sp.publish.repo} ${sp.publish.workflow}@${sp.publish.ref} (max ${sp.publish.maxRounds} round(s) per pass)`);
  }
}
let SPORT_KEYS = Object.keys(SPORTS);
if (ONLY_SPORTS.length) {
  const unknown = ONLY_SPORTS.filter(s => !SPORTS[s]);
  if (unknown.length) { console.error(`FATAL: --sports names ${unknown.join(', ')}, which is not in watch.json. Known: ${SPORT_KEYS.join(', ')}`); process.exit(2); }
  SPORT_KEYS = SPORT_KEYS.filter(s => ONLY_SPORTS.includes(s));
}
if (!SPORT_KEYS.length) { console.error('FATAL: no sports to watch.'); process.exit(2); }

const REDUCED_EVERY   = Number.isFinite(cfg.completeFixtureSlotsEvery) && cfg.completeFixtureSlotsEvery > 0 ? cfg.completeFixtureSlotsEvery : 4;
const ROUNDS_REFRESH_H = Number.isFinite(cfg.gradeRoundsRefreshHours) ? cfg.gradeRoundsRefreshHours : 12;
const CHANGE_WINDOW_D = Number.isFinite(cfg.activeChangeWindowDays) ? cfg.activeChangeWindowDays : 7;
const STOP_AFTER_D    = Number.isFinite(cfg.stopAfterSeasonEndDays) ? cfg.stopAfterSeasonEndDays : 21;
const FAIL_COOLDOWN_H = Number.isFinite(cfg.failureAlertCooldownHours) ? cfg.failureAlertCooldownHours : 6;
const MAX_ALERT_CHARS = Number.isFinite(cfg.maxAlertChars) ? cfg.maxAlertChars : 1000;

// A player's uuid PER SPORT. T72 — a profile can have a different api-namespace id
// on a different tenant. ⚠️ It does NOT apply to Toby: his single uuid resolved on
// both basketball-victoria and afl, measured 2026-11-24. The override exists for
// the general case and should stay empty until a profile actually needs one.
const uuidFor = (p, sport) => (p.uuids && p.uuids[sport]) || p.uuid;

// pinnedTeams is a fallback and is never mandatory (see §5 of the project note).
// An object keyed by sport is the full form; a bare array belongs to the player's
// FIRST sport, which is how the pre-footy config is read.
function pinnedFor(p, sport) {
  const pin = p.pinnedTeams;
  if (!pin) return [];
  if (Array.isArray(pin)) return (p.sports && p.sports[0]) === sport || (!p.sports && sport === LEGACY_SPORT) ? pin : [];
  return Array.isArray(pin[sport]) ? pin[sport] : [];
}

let WATCHED = Array.isArray(cfg.players) ? cfg.players.filter(p => p && p.uuid) : [];
if (ONLY.length) WATCHED = WATCHED.filter(p => ONLY.includes(p.uuid) || Object.values(p.uuids || {}).some(u => ONLY.includes(u)));
for (const p of WATCHED) {
  p.sports = (Array.isArray(p.sports) && p.sports.length ? p.sports : [LEGACY_SPORT]).filter(s => SPORTS[s]);
}
if (!WATCHED.length) { console.error('FATAL: no players to watch. watch.json has none, or --players matched none of them.'); process.exit(2); }
for (const p of WATCHED) {
  for (const s of p.sports) {
    const u = uuidFor(p, s);
    if (!u || u.length !== 36) {
      console.error(`FATAL: ${p.name || 'a player'}'s ${s} uuid is ${u ? `${u.length} characters` : 'missing'}. publicProfileTeams needs the FULL api-namespace uuid (the one in the StatTrack player URL). A spectator or truncated id returns NOT_FOUND, and NOT_FOUND must never be read as "no teams".`);
      process.exit(2);
    }
  }
}
if (!WATCHED.some(p => p.sports.some(s => SPORT_KEYS.includes(s)))) {
  console.error(`FATAL: no player in watch.json is signed up to any of: ${SPORT_KEYS.join(', ')}`);
  process.exit(2);
}

// ─── Slot gate ────────────────────────────────────────────────────────────────
const slot = slotDecision();
if (!slot.run && !FORCE) {
  console.log(`[fixture-watch] off-slot — ${slot.local} — ${slot.why}. Nothing to do.`);
  process.exit(0);
}
console.log(`[fixture-watch] ${slot.local} — ${slot.why}${FORCE && !slot.run ? ' (OVERRIDDEN by --force)' : ''}  slot #${slot.slotOrdinal}`);
console.log(`[fixture-watch] sports: ${SPORT_KEYS.map(k => `${SPORTS[k].label} → tenant ${SPORTS[k].tenant}`).join('; ')}`);
const CHECK_REDUCED = (slot.slotOrdinal % REDUCED_EVERY) === 0;
console.log(`[fixture-watch] complete-fixture teams ${CHECK_REDUCED ? 'ARE' : 'are NOT'} checked this slot (every ${REDUCED_EVERY} slots). Every other team is checked EVERY slot.`);

// ─── Headers — full set, never split, never modified (copied verbatim) ────────
// ⚠️ ONLY the `tenant` value differs between sports. Nothing else about the request
// changes, because nothing else about it may change: the header set IS the
// fingerprint CloudFront judges.
const headersFor = (tenant) => ({
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       tenant,
  'content-type': 'application/json',
});

const BOOTSTRAP_REFUSED_WAIT_MS = 15 * 60 * 1000;
const BOOTSTRAP_REFUSED_RETRIES = 1;
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

class SessionUnavailable extends Error {}

// ─── doFetch — copied verbatim. fetch() ONLY, resolves on ANY status. ────────
// ⚠️ ONE DELIBERATE DEVIATION FROM THE VERBATIM COPY: the abort signal.
// `fetch` has NO default timeout. A request that hangs rather than answering would
// stall the pass, and because a pass runs inside a five-hour daemon leg there is
// nothing underneath to cut it short except the job timeout — so one hung socket
// could cost the rest of the leg. 2026-11-21 showed PlayHQ answering slowly enough
// to matter: a pass that normally takes 9 seconds took 106 while two calls ground
// their way to an HTTP 504. The signal changes no header and no TLS behaviour, so
// it cannot affect the outbound fingerprint CloudFront judges us on.
const REQUEST_TIMEOUT_MS = 60000;
async function doFetch(url, bodyObj, headers) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { ...headers, 'request-id': crypto.randomUUID() },
    body:    JSON.stringify(bodyObj),
    signal:  AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const rawText = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(rawText); } catch (_) { body = null; }
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return { status: res.status, rawCookies: cookies.length ? cookies : undefined, body, rawText };
}

const isWafBlock = (rawText) => /cloudfront|Request blocked|ERROR: The request could not be satisfied/i.test(rawText || '') || (rawText || '').includes('DOCTYPE');

// ─── Transient failures are retried INSIDE the pass ──────────────────────────
// Added 2026-11-21, after PlayHQ returned HTTP 504 on two of four teams in one
// pass. Nothing was lost — their state was left untouched and the next pass
// re-asked — but that is a 30-minute hole on a Saturday morning with games on, for
// a gateway hiccup that a five-second retry would have ridden out.
//
// ⚠️ DELIBERATELY NARROW. Only a thrown fetch (socket error, or the abort above)
// and HTTP 502/504 are retried: a gateway that could not reach PlayHQ at all.
// 403, 429 and 503 are NOT retried and keep the classification the live scripts
// use — 403 is the WAF-versus-application distinction, and 429/503 are a rate
// signal that must be backed off, never hammered. Retrying those would turn a
// polite refusal into the burst that keeps the penalty window open.
const TRANSIENT_STATUS  = new Set([502, 504]);
const RETRY_ATTEMPTS    = 3;                 // the first try plus two retries
const RETRY_BACKOFF_MS  = [5000, 15000];

async function doFetchTransient(url, bodyObj, headers, label) {
  let last = 'unknown';
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const r = await doFetch(url, bodyObj, headers);
      if (!TRANSIENT_STATUS.has(r.status)) return r;
      last = `HTTP ${r.status}`;
    } catch (err) {
      last = `${err.name === 'TimeoutError' ? `no answer in ${REQUEST_TIMEOUT_MS / 1000}s` : (err.code || '')} ${err.message}`.trim();
    }
    if (attempt < RETRY_ATTEMPTS) {
      const wait = RETRY_BACKOFF_MS[attempt - 1];
      console.log(`     ↻ ${label}: ${last} — retrying in ${wait / 1000}s (attempt ${attempt + 1} of ${RETRY_ATTEMPTS})`);
      await sleep(wait);
    }
  }
  // Exhausted. The caller turns this into a typed failure, which leaves state
  // untouched and marks the run red — exactly as before this retry existed.
  throw new Error(`${last}, and still failing after ${RETRY_ATTEMPTS} attempts`);
}

// ─── Queries — copied verbatim ───────────────────────────────────────────────
// ⚠️ MEASURED ON TENANT `afl` 2026-11-24: all three shapes answer unchanged. In
// particular `publicProfileTeams` accepts `grade { id name }` with no inline
// fragment, and `discoverTeamFixture(teamID)` returned 16 rounds / 16 games,
// 16 / 15 (a bye) and 14 / 14. The fixture layer is NOT rebuilt for footy.
const Q_PROFILE_TEAMS = {
  operationName: 'PublicProfileTeams',
  query: `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    id name
    organisation { id name }
    grade { id name }
    season {
      id name startDate endDate
      status { name value }
      competition { id name organisation { id name } }
    }
  }
}`,
};

const Q_TEAM_FIXTURE = {
  operationName: 'TeamFixture',
  query: `query TeamFixture($teamID: ID!) {
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
}`,
};

// Q_GRADE_ROUNDS: scripts/nightly-crawl.js — the grade's whole round list, which
// exists from the moment the grade is set up and carries isFinalsRound per round.
const Q_GRADE_ROUNDS = {
  operationName: 'gradeRounds',
  query: `query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id name hideScores
    rounds { id name abbreviatedName current number isFinalsRound }
    season { id competition { id organisation { id name } } }
  }
}`,
};

// ─── ONE CLIENT PER TENANT ───────────────────────────────────────────────────
// Everything that used to be a module-level singleton lives in here: the cookie,
// the single-flight promise, the budget guard and the "this session is dead" flag.
// Two tenants in one pass therefore hold two independent sessions, which is the
// only correct arrangement — the cookie is issued against the `tenant` header and
// is not valid anywhere else. A tenant whose session dies does not touch any
// other tenant's.
const clients = new Map();
function clientFor(tenant) {
  if (clients.has(tenant)) return clients.get(tenant);

  const HEADERS_BASE = headersFor(tenant);
  let sessionCookie  = null;
  let sessionPromise = null;
  let sessionDead    = false;

  async function refreshSession() {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      // A REFUSED BOOTSTRAP IS RETRIED ONCE, AFTER ONE FULL WINDOW. Every cookieless
      // request made INTO an open penalty window extends it, so a fast retry ladder
      // keeps the window open instead of waiting it out.
      let longWaits = 0, shortWaits = 0;
      for (let attempt = 1; ; attempt++) {
        let refused = false;
        for (const body of COOKIE_QUERIES) {
          let status, rawCookies, rawText;
          try {
            ({ status, rawCookies, rawText } = await doFetch(API_URL, body, HEADERS_BASE));
          } catch (err) {
            console.log(`  ⚠ [${tenant}] session attempt ${attempt} ${body.operationName}: fetch threw ${err.code || ''} ${err.message}`);
            sessionPromise = null;
            throw err;
          }
          if (!rawCookies) {
            const b = rawText || '';
            const sniff = b.includes('Request blocked') ? `CLOUDFRONT-BLOCK (${b.length}b HTML)`
                        : b.includes('DOCTYPE')         ? `HTML page (${b.length}b): ${b.slice(0, 80)}`
                        : (b.slice(0, 120) || '(empty body)');
            console.log(`  ⚠ [${tenant}] session attempt ${attempt} ${body.operationName}: HTTP ${status}, NO set-cookie, body: ${sniff.replace(/\s+/g, ' ')}`);
            if (status === 403) { refused = true; break; }
            continue;
          }
          const parts = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
            .flatMap(c => c.split(',')).map(c => c.trim().split(';')[0]).filter(Boolean);
          const get = (name) => parts.find(c => c.startsWith(name + '=')) || null;
          const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
          if (!tier || !session || !sub) {
            console.log(`  ⚠ [${tenant}] session attempt ${attempt} ${body.operationName}: HTTP ${status}, set-cookie PRESENT but missing phq_tier/phq_session/phq_sub — names seen: ${parts.map(c => c.split('=')[0]).join(', ')}`);
            continue;
          }
          sessionCookie = `${tier}; ${session}; ${sub}`;
          sessionPromise = null;
          console.log(`  Session refreshed for tenant ${tenant} (attempt ${attempt})`);
          return;
        }
        if (refused) {
          if (longWaits >= BOOTSTRAP_REFUSED_RETRIES) break;
          longWaits++;
          console.log(`  ⛔ [${tenant}] bootstrap refused (attempt ${attempt}) — the penalty window is open. Waiting ${Math.round(BOOTSTRAP_REFUSED_WAIT_MS / 60000)} minutes for it to close, then asking once more.`);
          await sleep(BOOTSTRAP_REFUSED_WAIT_MS);
          continue;
        }
        if (shortWaits >= 4) break;
        shortWaits++;
        await sleep(20000 * shortWaits);
      }
      sessionPromise = null;
      throw new Error(`Failed to obtain a session cookie for tenant ${tenant}: ${longWaits ? 'the penalty window did not close' : 'no usable cookie in any answer'} — see per-attempt ⚠ lines above`);
    })();
    return sessionPromise;
  }

  const sessionGuard = createSessionGuard({
    refresh:   refreshSession,
    hasCookie: () => !!sessionCookie,
    clear:     () => { sessionCookie = null; },
  });

  async function ensureSession() {
    if (sessionDead) throw new SessionUnavailable(`PlayHQ refused a session for tenant ${tenant} earlier in this run — not asking again`);
    try { await sessionGuard.ensure(); }
    catch (err) { sessionDead = true; throw new SessionUnavailable(err.message); }
  }

  const authHeaders = () => ({ ...HEADERS_BASE, 'Cookie': sessionCookie });

  // ─── Typed calls ───────────────────────────────────────────────────────────
  async function probeTeams(profileID) {
    try { await ensureSession(); } catch (err) { return { kind: 'no-session', detail: err.message }; }
    let status, json, rawText;
    try { ({ status, body: json, rawText } = await doFetchTransient(API_URL, { ...Q_PROFILE_TEAMS, variables: { profileID } }, authHeaders(), `profile ${profileID.slice(0, 13)} [${tenant}]`)); }
    catch (err) { return { kind: 'error', detail: err.message }; }

    if (status === 403) {
      if (isWafBlock(rawText)) return { kind: 'blocked', detail: `CLOUDFRONT-BLOCK (${(rawText || '').length}b HTML) — PlayHQ's WAF refused us, NOT an application 403` };
      return { kind: 'private', detail: 'application 403 — the profile is inaccessible. This is NOT a CloudFront block.' };
    }
    if (status === 429 || status === 503) return { kind: 'blocked', detail: `HTTP ${status} rate signal` };
    if (status < 200 || status >= 300) return { kind: 'error', detail: `HTTP ${status}` };
    if (!json) return { kind: 'error', detail: `unparseable body: ${(rawText || '').slice(0, 120)}` };
    if (json.errors?.length) {
      const msg = json.errors.map(e => e.message).join(' | ');
      if (/not.?found/i.test(msg)) return { kind: 'notfound', detail: `${msg} — the id did not resolve on tenant ${tenant}. This is NOT "the player has no teams".` };
      return { kind: 'gql-error', detail: msg };
    }
    const teams = (json.data || json)?.publicProfileTeams;
    if (teams == null) return { kind: 'null', detail: 'publicProfileTeams is NULL — profile PRIVATE, or the id does not resolve. This call cannot tell those apart.' };
    // ⚠️ AN EMPTY ARRAY IS A REAL ANSWER AND IS NOT NOT_FOUND. Measured 2026-11-24:
    // a footy profile returned [] on basketball-victoria with no error, meaning
    // "no basketball registrations". That must baseline as zero teams, not fail.
    return { kind: 'ok', teams: Array.isArray(teams) ? teams : [] };
  }

  async function teamFixture(teamID) {
    try { await ensureSession(); } catch (err) { return { kind: 'no-session', detail: err.message }; }
    let status, json, rawText;
    try { ({ status, body: json, rawText } = await doFetchTransient(API_URL, { ...Q_TEAM_FIXTURE, variables: { teamID } }, authHeaders(), `fixture ${teamID} [${tenant}]`)); }
    catch (err) { return { kind: 'error', detail: err.message }; }

    if (status === 403) {
      if (isWafBlock(rawText)) return { kind: 'blocked', detail: `CLOUDFRONT-BLOCK (${(rawText || '').length}b HTML)` };
      return { kind: 'forbidden', detail: 'application 403' };
    }
    if (status === 429 || status === 503) return { kind: 'blocked', detail: `HTTP ${status} rate signal` };
    if (status < 200 || status >= 300) return { kind: 'error', detail: `HTTP ${status}` };
    if (!json) return { kind: 'error', detail: `unparseable body: ${(rawText || '').slice(0, 120)}` };
    if (json.errors?.length) return { kind: 'gql-error', detail: json.errors.map(e => e.message).join(' | ') };

    const data = json.data || json;
    // `data` present with no discoverTeamFixture means the team genuinely holds no
    // rounds — a real answer, and a DIFFERENT thing from a failure to ask.
    return { kind: 'ok', team: data.discoverTeam || null, rounds: Array.isArray(data.discoverTeamFixture) ? data.discoverTeamFixture : [] };
  }

  async function gradeRounds(gradeID) {
    try { await ensureSession(); } catch (err) { return { kind: 'no-session', detail: err.message }; }
    let status, json, rawText;
    try { ({ status, body: json, rawText } = await doFetchTransient(API_URL, { ...Q_GRADE_ROUNDS, variables: { gradeID } }, authHeaders(), `grade rounds ${gradeID} [${tenant}]`)); }
    catch (err) { return { kind: 'error', detail: err.message }; }

    if (status === 403) {
      if (isWafBlock(rawText)) return { kind: 'blocked', detail: `CLOUDFRONT-BLOCK (${(rawText || '').length}b HTML)` };
      return { kind: 'forbidden', detail: 'application 403' };
    }
    if (status === 429 || status === 503) return { kind: 'blocked', detail: `HTTP ${status} rate signal` };
    if (status < 200 || status >= 300) return { kind: 'error', detail: `HTTP ${status}` };
    if (!json) return { kind: 'error', detail: `unparseable body: ${(rawText || '').slice(0, 120)}` };
    if (json.errors?.length) return { kind: 'gql-error', detail: json.errors.map(e => e.message).join(' | ') };

    const g = (json.data || json)?.discoverGrade;
    // ⚠️ A GRADING grade returns an empty ladder and can return an empty round list.
    // That is a real answer, and an empty round list makes coverage meaningless — so
    // it is reported as `empty` and the team stays on FULL rather than being declared
    // complete against zero rounds.
    if (!g) return { kind: 'empty', detail: 'discoverGrade returned nothing for this grade id' };
    const rounds = Array.isArray(g.rounds) ? g.rounds : [];
    if (!rounds.length) return { kind: 'empty', detail: `grade "${g.name || gradeID}" has no rounds yet` };
    return { kind: 'ok', gradeName: g.name || null, rounds };
  }

  const c = { tenant, probeTeams, teamFixture, gradeRounds, stats: () => sessionGuard.stats() };
  clients.set(tenant, c);
  return c;
}

// ─── Normalising a fixture ───────────────────────────────────────────────────
// Only the fields a human would notice a change in. Scores are deliberately NOT
// tracked: this watches the FIXTURE, and a score arriving on a played game would
// otherwise fire a "changed" alert every Saturday evening.
function normaliseGames(tid, rounds) {
  const games = {};
  for (const round of rounds) {
    const rn  = round?.name || null;
    const gid = round?.grade?.id || null;
    const gn  = round?.grade?.name || null;
    const isFinals = !!round?.isFinalsRound;
    for (const g of (round?.fixture?.games || [])) {
      if (!g?.id) continue;
      const dt    = g.allocation?.dateTimeList?.[0] || null;
      const court = g.allocation?.court || null;
      const venue = court?.venue || null;
      const homeId = g.home?.id || null;
      const awayId = g.away?.id || null;
      // home is null, not false, when neither side resolves — a bye, a placeholder,
      // or a side PlayHQ has not named yet. A boolean would file every one of those
      // as "away" and alert the moment it resolves.
      const isHome = homeId && homeId === tid ? true : (awayId && awayId === tid ? false : null);
      const oppTeam = isHome === true ? g.away : (isHome === false ? g.home : null);
      games[g.id] = {
        d:   dt?.date || (Array.isArray(g.dates) ? g.dates[0] : null) || null,
        t:   dt?.time ? String(dt.time).slice(0, 5) : null,
        v:   venue?.name || null,
        c:   court?.name || null,
        opp: oppTeam?.name || null,
        oppId: oppTeam?.id || null,
        home: isHome,
        st:  g.status?.value || null,
        gid, gn, rn,
        finals: isFinals,
      };
    }
  }
  return games;
}

const FIELDS = [
  ['d',   'date'],
  ['t',   'time'],
  ['v',   'venue'],
  ['c',   'court'],
  ['opp', 'opponent'],
  ['st',  'status'],
  ['gn',  'grade'],
];

function describeGame(g) {
  const bits = [];
  bits.push(g.d || 'no date');
  if (g.t) bits.push(g.t);
  if (g.opp) bits.push(`${g.home === true ? 'v' : g.home === false ? '@' : 'vs'} ${g.opp}`);
  if (g.v) bits.push(g.v + (g.c ? ` ${g.c}` : ''));
  if (g.rn) bits.push(`[${g.rn}]`);
  return bits.join(' ');
}

// ─── Diff ────────────────────────────────────────────────────────────────────
// ⚠️ A GAME THAT HAS BEEN PLAYED IS HISTORY, AND ITS DETAILS CHANGING IS NOT NEWS.
// PlayHQ edits completed games after the fact — most often an archival team rename
// ("ZZ - … - W" and the like) — and there is nothing to act on: the game happened,
// at the time and place it happened. The sibling repo has the same rule in
// discover-fixtures.js, which refuses to rewrite a game once it holds a score.
//
// Added 2026-11-24 after a past game whose opponent was renamed alerted repeatedly.
// Scope is narrow on purpose: only FIELD CHANGES on a game that is historical in
// BOTH the stored and the fetched copy are ignored. A past game being ADDED or
// REMOVED is still reported — a game vanishing from the record is worth knowing
// about whenever it happened.
// Terminal game statuses. Defined HERE rather than lifted with the predicate that
// uses it — the same block in probe-profile-teams.js has its own copy, and relying
// on a constant that lives above the extraction point is how a copied block throws
// a ReferenceError that `node --check` cannot see.
const TERMINAL = new Set(['FINAL', 'CANCELLED', 'ABANDONED', 'FORFEIT']);

// ⚠️ THE FOOTY DASHBOARD ONLY HOLDS GAMES THAT HAVE BEEN PLAYED.
// It stamps a match record — and the team ids on it — only on a game PlayHQ has
// marked FINAL, so no link into a season resolves before that season's round 1,
// whatever keys the link carries. This is the gate that decides whether a footy
// alert carries a link at all; see lib/team-links.cjs.
//
// FINAL ONLY, deliberately narrower than TERMINAL above. A cancelled, abandoned or
// forfeited game is terminal for OUR diffing purposes but produces no result for
// the dashboard to store, so it must not be read as "the dashboard knows this team".
const hasFinalGame = (games) =>
  Object.values(games || {}).some(g => String(g && g.st || '').toUpperCase() === 'FINAL');

const isHistorical = (g, nowMs) => {
  if (!g) return false;
  if (TERMINAL.has(String(g.st || '').toUpperCase())) return true;
  // End of day, so a game played this morning is not called history until tonight.
  return !!(g.d && Date.parse(`${g.d}T23:59:59Z`) < nowMs);
};

function diffFixture(prevGames, nextGames, nowMs = Date.now()) {
  const changes = [];
  const prevIds = Object.keys(prevGames || {});
  const nextIds = Object.keys(nextGames || {});

  for (const id of nextIds) {
    if (!prevGames[id]) { changes.push({ type: 'added', id, game: nextGames[id], line: `+ ADDED  ${describeGame(nextGames[id])}` }); continue; }
    const a = prevGames[id], b = nextGames[id];
    if (isHistorical(a, nowMs) && isHistorical(b, nowMs)) continue;   // history: not news
    const diffs = [];
    for (const [key, label] of FIELDS) {
      if ((a[key] ?? null) !== (b[key] ?? null)) diffs.push(`${label} ${a[key] ?? '—'} → ${b[key] ?? '—'}`);
    }
    if (diffs.length) changes.push({ type: 'changed', id, game: b, line: `~ ${describeGame(b)}\n    ${diffs.join('; ')}` });
  }
  for (const id of prevIds) {
    if (!nextGames[id]) changes.push({ type: 'removed', id, game: prevGames[id], line: `− REMOVED  ${describeGame(prevGames[id])}` });
  }

  // (tid, gid) is the identity. The set of grades across the team's games changing
  // is a REGRADE — reported on its own, because it is the thing most likely to make
  // a Saturday morning go wrong and it is easy to miss among game-level diffs.
  const gidsOf = (gs) => [...new Set(Object.values(gs || {}).map(g => g.gid).filter(Boolean))].sort();
  const prevGids = gidsOf(prevGames), nextGids = gidsOf(nextGames);
  const regrade = prevGids.length && nextGids.length && prevGids.join(',') !== nextGids.join(',');

  return { changes, regrade, prevGids, nextGids };
}

// ─── Dispatch to StatTrack ───────────────────────────────────────────────────
// fetch() only, same as every other call in this file. GITHUB_TOKEN cannot create
// a workflow run across repositories, so this needs a PAT with actions:write on
// the target repo, supplied as STATTRACK_DISPATCH_TOKEN.
//
// 204 is the ONLY success. Anything else is reported and treated as a failure by
// the caller, which then holds this team's state back so the next pass re-detects
// the same FINAL and tries again. A lost dispatch must cost one re-ask, never a
// result that silently never publishes.
async function dispatchPublish(pub, { season, grade, round, games }) {
  const url = `https://api.github.com/repos/${pub.repo}/actions/workflows/${pub.workflow}/dispatches`;
  const payload = {
    ref: pub.ref,
    inputs: {
      season: String(season), grade: String(grade), round: String(round),
      games: games.join(','), source: 'fixture-watch',
    },
  };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept':               'application/vnd.github+json',
        'Authorization':        `Bearer ${PUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type':         'application/json',
        'User-Agent':           'fixture-watch',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, detail: `network: ${err && err.message ? err.message : err}` };
  }
  if (res.status === 204) return { ok: true, detail: '204' };
  let text = '';
  try { text = (await res.text() || '').slice(0, 300); } catch (_) {}
  return { ok: false, detail: `HTTP ${res.status}${text ? ` — ${text}` : ''}` };
}

// A game that has just become FINAL: present in both snapshots (or newly added)
// with a status that was not FINAL before and is now. Grouped by (grade, round)
// because that is what publish-final-game.yml takes — one dispatch covers every
// game in the round, so a whole round finishing costs ONE call, not five.
function finalTransitions(prevGames, changes) {
  const byRound = new Map();
  for (const c of changes) {
    if (c.type !== 'changed' && c.type !== 'added') continue;
    const g = c.game || {};
    if (g.st !== 'FINAL') continue;
    const before = (prevGames || {})[c.id];
    if (before && before.st === 'FINAL') continue;   // already final — nothing new
    if (!g.gid || !g.rn) continue;                   // cannot be addressed without both
    const key = `${g.gid}|${g.rn}`;
    if (!byRound.has(key)) byRound.set(key, { grade: g.gid, round: g.rn, games: [] });
    byRound.get(key).games.push(c.id);
  }
  return [...byRound.values()];
}

// ─── State ───────────────────────────────────────────────────────────────────
function readJson(file, dflt) {
  if (!fs.existsSync(file)) return dflt;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    // A state file that will not parse is a FAULT, not an empty state. Treating it
    // as empty would re-baseline the team and swallow every change silently.
    throw new Error(`state file ${path.relative(ROOT, file)} does not parse: ${err.message}`);
  }
}
const teamStateFile = (tid) => path.join(STATE_DIR, `${tid}.json`);
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// ─── Git — the house pattern ─────────────────────────────────────────────────
// Per-path add (this repo stages a handful of files, far below the ~2,000 ceiling
// where --pathspec-from-file becomes necessary). Commit BEFORE fetch/merge.
// 60 push attempts with pure random 1–91s jitter. THROWS when exhausted, because a
// red job beats silently discarded work. Every git call carries a timeout and an
// explicit maxBuffer — execFileSync's 1 MB default SIGTERMs git mid-merge.
const GIT_OPTS = { encoding: 'utf8', stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const git = (a) => execFileSync('git', a, GIT_OPTS);

async function gitCommit(paths, message) {
  if (!paths.length) { console.log('  (nothing to stage)'); return false; }
  const staged = [];
  for (const p of paths) {
    const rel = path.relative(ROOT, p);
    try { git(['add', '--', rel]); staged.push(rel); }
    catch (err) { console.log(`  ⚠ git add failed for ${rel}: ${String(err.stderr || err.message).split('\n')[0]}`); }
  }
  const short = git(['diff', '--staged', '--shortstat']).trim();
  if (!short) { console.log('  (no changes to commit)'); return false; }
  console.log(`  staging: ${short}  [${staged.length} path(s)]`);

  git(['commit', '-m', message]);

  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      git(['fetch', 'origin', 'main']);
      git(['merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat', '-q']);
      git(['push', 'origin', 'HEAD:main']);
      console.log(`  pushed (attempt ${attempt})`);
      return true;
    } catch (err) {
      const msg = String(err.stderr || err.message || '');
      // A size/LFS/hook rejection is the git equivalent of an HTTP 4xx — it can
      // never succeed, so burning 60 attempts on it only buries the real error.
      if (/GH001|exceeds|file size|LFS|pre-receive hook declined|protected branch/i.test(msg)) {
        throw new Error(`push rejected permanently, not retrying: ${msg.slice(0, 300)}`);
      }
      console.log(`  push attempt ${attempt} failed: ${msg.split('\n').filter(Boolean)[0] || 'unknown'}`);
      try { git(['merge', '--abort']); } catch (_) {}
      if (attempt === 60) break;
      await sleep(1000 + Math.floor(Math.random() * 90000));
    }
  }
  throw new Error('push failed after 60 attempts — the run is RED and the state was NOT saved');
}


// ─── Player state, per sport ─────────────────────────────────────────────────
// state/_players.json used to be `uuid -> { seen, name, teams }`. With two sports
// one player has one team list PER SPORT, and a single flat `teams` would mean the
// basketball pass wiping the footy pass's record thirty times a day. The shape is
// now `uuid -> { name, bySport: { <sport>: { seen, teams } } }`, keyed on the
// player's CANONICAL uuid so a per-sport uuid override cannot split the record.
//
// ⚠️ THE OLD FLAT SHAPE IS MIGRATED, NOT IGNORED. A flat entry is read as the
// legacy sport's record and rewritten into bySport on the first pass that touches
// it. Ignoring it would re-baseline the live basketball teams and swallow whatever
// changed in between.
function readPlayerSport(playerState, p, sport) {
  const e = playerState[p.uuid];
  if (!e) return { seen: false, teams: {} };
  if (e.bySport && e.bySport[sport]) {
    const s = e.bySport[sport] || {};
    return { seen: !!s.seen, teams: s.teams || {} };
  }
  if (!e.bySport && e.teams && sport === LEGACY_SPORT) return { seen: !!e.seen, teams: e.teams };
  return { seen: false, teams: {} };
}

function writePlayerSport(playerState, p, sport, data) {
  const e = playerState[p.uuid] || {};
  const bySport = { ...(e.bySport || {}) };
  // Migrate a flat legacy entry in place, once, before this sport overwrites it.
  if (!e.bySport && e.teams) bySport[LEGACY_SPORT] = { seen: !!e.seen, teams: e.teams };
  bySport[sport] = data;
  playerState[p.uuid] = { name: p.name || e.name || null, bySport };
}

// ─── Netball Connect — a third SOURCE ────────────────────────────────────────
// ⚠️ FIRST SIGHTING ALERTS, THEN IT IS A KNOWN DATA POINT AND NEVER ALERTS AGAIN.
// That is the whole model. A team or a registration is recorded under a
// pseudonymous key the moment it is first seen, and from then on only a CHANGE to
// a watched field, or its disappearance, is news. The one exception is the very
// first run for a player: it seeds both lists and sends ONE summary rather than an
// alert per existing item.
//
// ⚠️ ISOLATION IS THE POINT. Separate vendor, separate API, separate login,
// separate state file, separate failure handling. The caller wraps this in a
// try/catch and a failure here is typed exactly like a PlayHQ team's — it can
// never stop the basketball or footy checks, and theirs can never stop this.
//
// ⚠️ ABSENT CONFIG MEANS OFF, the same rule as fast publish. No secrets, no
// `netballConnect` block, or `enabled: false`, and this does nothing at all.
async function runNetballConnect(ctx) {
  const { alerts, failures, pendingWrites, nowMs } = ctx;

  const NC = (cfg.netballConnect && typeof cfg.netballConnect === 'object') ? cfg.netballConnect : null;
  if (!NC || NC.enabled === false) return;

  const email   = process.env.NC_EMAIL    || '';
  const pw      = process.env.NC_PASSWORD || '';
  const rawPl   = process.env.NC_PLAYERS  || '';
  const hmacKey = process.env.NC_STATE_KEY || '';
  if (!email || !pw || !rawPl || !hmacKey) {
    console.log(`\n══ Netball Connect — INACTIVE (${!email || !pw ? 'NC_EMAIL/NC_PASSWORD not set' : !rawPl ? 'NC_PLAYERS not set' : 'NC_STATE_KEY not set'})`);
    return;
  }

  let players;
  try { players = JSON.parse(rawPl); } catch (_) { failures.push('Netball Connect: NC_PLAYERS is not valid JSON'); return; }
  if (!Array.isArray(players) || !players.length) { failures.push('Netball Connect: NC_PLAYERS is not a non-empty array'); return; }
  for (const p of players) {
    if (!p || !p.alias || typeof p.userId !== 'number') { failures.push('Netball Connect: every NC_PLAYERS entry needs an alias and a numeric userId'); return; }
  }

  // ⚠️ TWO NUMBERS, BECAUSE THEY GUARD TWO DIFFERENT THINGS.
  // A healthy check is 3-4 calls and is nearly free, so there is no reason for it
  // to be slower than the PlayHQ cadence — a new registration should land on the
  // phone in half an hour, not six. What is genuinely risky is REPEATED FAILED
  // LOGINS, which is how an account gets locked. So the long wait applies only
  // after an error, and the healthy path runs at the pass cadence.
  // (The spec said a flat 6 hours. That conflated the two.)
  const CHECK_EVERY_MIN = Number.isFinite(NC.checkEveryMinutes) && NC.checkEveryMinutes > 0 ? NC.checkEveryMinutes
                        : Number.isFinite(NC.checkEveryHours) && NC.checkEveryHours > 0 ? NC.checkEveryHours * 60
                        : 30;
  const ERROR_BACKOFF_MIN = Number.isFinite(NC.errorBackoffMinutes) && NC.errorBackoffMinutes > 0 ? NC.errorBackoffMinutes : 360;
  const EXPECTED      = NC.expected || { teams: 2, registrations: 4 };
  const CANARY        = NC.teamsTabCanary !== false;
  const PAGE_LIMIT    = Number.isFinite(NC.regPageLimit) && NC.regPageLimit > 0 ? NC.regPageLimit : 10;

  const state = readJson(NETBALL_ST, null) || { players: {}, lastSuccess: null, lastAttempt: null, lastError: null };
  if (!state.players) state.players = {};

  // ⚠️ THE GATE IS ON lastAttempt, NOT lastSuccess — DELIBERATELY. Gating on
  // success would retry a wrong password every single pass. The interval it is
  // measured against is the one that depends on whether the last run failed.
  const inBackoff   = !!(state.lastError && state.lastError.reason);
  const dueAfterMin = inBackoff ? ERROR_BACKOFF_MIN : CHECK_EVERY_MIN;
  const sinceAttempt = state.lastAttempt ? (nowMs - Date.parse(state.lastAttempt)) : Infinity;
  if (!NC_NOW && Number.isFinite(sinceAttempt) && sinceAttempt < dueAfterMin * 60000) {
    console.log(`\n══ Netball Connect — not due (last attempt ${Math.round(sinceAttempt / 60000)} min ago, every ${dueAfterMin} min${inBackoff ? ' — BACKED OFF after an error' : ''})`);
    return;
  }

  console.log(`\n══ Netball Connect  ·  ${players.length} player(s)  ·  every ${dueAfterMin} min${inBackoff ? ' (error backoff)' : ''} ══`);
  const client = netballClient.createClient({ email, password: pw, log: (m) => console.log(m) });
  const ncAlerts = [];
  const reasons  = [];
  const today    = new Date(nowMs).toISOString().slice(0, 10);

  state.lastAttempt = new Date(nowMs).toISOString();

  const li = await client.login();
  if (li.kind !== 'ok') {
    // A login failure skips BOTH fetches and leaves every player's state untouched.
    reasons.push(li.reason);
    console.log(`  ✖ ${li.reason}`);
  } else {
    console.log('  nc: login ok');

    for (const p of players) {
      const ps = state.players[p.alias] || { teams: {}, registrations: {}, teamsTabNonEmpty: false };
      const seeded = Object.keys(ps.teams || {}).length > 0 || Object.keys(ps.registrations || {}).length > 0 || ps.seeded === true;
      let tCount = null, rCount = null;

      // ── teams (§4) ────────────────────────────────────────────────────────
      const t = await client.teams(p.alias, p.userId);
      if (t.kind !== 'ok') { reasons.push(t.reason); console.log(`  ✖ ${t.reason}`); }
      else {
        const recs = nb.teamRecords(t.rows, hmacKey);
        tCount = recs.length;
        const { events, nextState } = nb.diffTeams(ps.teams || {}, recs, today);
        ps.teams = nextState;
        if (seeded) ncAlerts.push(...events.map(e => ({ ev: e, name: p.name || p.alias })));
      }

      // ── registrations (§8) ────────────────────────────────────────────────
      // A teams error does not block this, and vice versa.
      const r = await client.registrations(p.alias, p.userId, PAGE_LIMIT);
      if (r.kind !== 'ok') { reasons.push(r.reason); console.log(`  ✖ ${r.reason}`); }
      else {
        const recs = nb.regRecords(r.rows, hmacKey);
        rCount = recs.length;
        const { events, nextState } = nb.diffRegs(ps.registrations || {}, recs, today);
        ps.registrations = nextState;
        if (seeded) ncAlerts.push(...events.map(e => ({ ev: e, name: p.name || p.alias })));
      }

      // ── the Teams-tab canary (§4.1) — info only, once, never an error ──────
      if (CANARY && !ps.teamsTabNonEmpty) {
        const tt = await client.teamsTab(p.alias, p.userId);
        if (tt.kind === 'ok' && tt.totalCount > 0) { ps.teamsTabNonEmpty = true; ncAlerts.push({ canary: true }); }
      }

      // ── first run: ONE summary, never an alert per existing item (§5) ──────
      if (!seeded && tCount !== null && rCount !== null) {
        ps.seeded = true;
        alerts.push({ key: 'nc', ...nb.seedAlert(p.name || p.alias, tCount, rCount, EXPECTED) });
        console.log(`  nc[${p.alias}]: seeded — teams=${tCount} regs=${rCount}`);
      } else if (tCount !== null || rCount !== null) {
        console.log(`  nc[${p.alias}]: teams=${tCount === null ? '—' : tCount} regs=${rCount === null ? '—' : rCount} events=${ncAlerts.length}`);
      }

      state.players[p.alias] = ps;
    }
  }

  // ── turn the events into Pushover alerts ───────────────────────────────────
  const canaryFired = ncAlerts.some(a => a.canary);
  const byName = new Map();
  for (const a of ncAlerts) { if (a.canary) continue; if (!byName.has(a.name)) byName.set(a.name, []); byName.get(a.name).push(a.ev); }
  for (const [name, evs] of byName) for (const built of nb.alertsFor(evs, name)) alerts.push({ key: 'nc', ...built });
  if (canaryFired) alerts.push({ key: 'nc', ...nb.canaryAlert() });

  // ── errors: once per failure state, with a 24h reminder (§6) ──────────────
  if (reasons.length) {
    const d = nb.errorDecision(state.lastError, reasons[0], nowMs);
    state.lastError = d.next;
    if (d.alert) alerts.push({ key: 'nc', ...nb.errorAlert(reasons[0]) });
    else console.log('  (Netball Connect error alert suppressed — same reason as last time, under 24h)');
    for (const why of reasons) failures.push(`Netball Connect: ${why}`);
  } else {
    if (state.lastError) { alerts.push({ key: 'nc', ...nb.recoveryAlert() }); console.log('  nc: recovered'); }
    state.lastError = null;
    state.lastSuccess = new Date(nowMs).toISOString();
  }

  // ⚠️ ONE STATE FILE, ONE KEY, ALL OR NOTHING. Every netball alert carries
  // key 'nc', so if any of them is rejected by Pushover the whole write is held
  // back and the next due pass re-detects and re-alerts — the same rule the
  // PlayHQ teams follow. Baselining a change whose alert never arrived is the one
  // failure this repo refuses to allow.
  pendingWrites.set('nc', { file: NETBALL_ST, data: state });
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const started = Date.now();
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // ⚠️ NO TIMESTAMP IN state/_players.json. A "last read at" field changes on every
  // single run, so this file would be committed 34 times a day saying nothing, and
  // the real history of fixture changes would be buried under it. `seen` is a flag:
  // it exists to tell a first run (baseline, no alerts) from a later one, per
  // sport, and nothing else.
  const playerState = readJson(PLAYERS_ST, {});
  const meta        = readJson(META_ST, {});      // { lastFailureAlertAt }
  const failures    = [];
  const alerts      = [];                         // { key, title, lines[], url, urlTitle, priority }
  const touched     = new Set();

  // ⚠️ STATE IS WRITTEN AFTER THE ALERTS ARE SENT, NOT BEFORE.
  // Writing first means that when Pushover rejects a send, the change has already
  // been baselined: the next run sees no difference, and the alert is lost for good.
  // The phone never buzzes and nothing in the repo says anything went wrong. So
  // every write is held here, keyed by the alert it belongs to, and applied only
  // when that alert actually reached Pushover. A held-back write costs one re-ask
  // on the next slot; a lost alert costs the whole point of the repo.
  const pendingWrites  = new Map();   // key -> { file, data }
  const pendingDeletes = new Map();   // key -> { file, tid, alertKey }
  const pendingPlayers = new Map();   // key -> { player, sport, data }
  const pendingDispatch = new Map();  // key -> { pub, rounds:[{ season, grade, round, games[] }] }

  const todayMs = Date.now();

  // The alert link for a registration or a team-meta block, in this sport's shape.
  // Returns null freely — see lib/team-links.cjs: omit rather than approximate.
  //
  // `games` is whatever this run knows about the team's fixture: the freshly
  // normalised games in phase 2, the stored ones for a team that has just left a
  // profile, and NOTHING for a brand new registration — which is correct, because a
  // brand new registration is exactly the case the footy dashboard cannot resolve.
  const linkFor = (sp, reg, games) => teamUrlFor(sp, {
    tid:           reg.tid,
    sid:           reg.sid,
    teamName:      reg.name,
    gradeName:     reg.currentGrade || reg.regGrade || null,
    seasonName:    reg.seasonName,
    orgId:         reg.assocId,
    hasPlayedGame: hasFinalGame(games),
  });

  // ── Phase 1 · profiles, one sport at a time ───────────────────────────────
  // The team list per player per sport. A player whose profile could not be read
  // keeps the team list from last time and contributes NO removals — a failed fetch
  // must never look like a team disappearing.
  const toCheck = new Map();   // tid -> { tid, sport, reg, players:Set, pinned:boolean }

  for (const sportKey of SPORT_KEYS) {
    const sp      = SPORTS[sportKey];
    const members = WATCHED.filter(p => p.sports.includes(sportKey));
    console.log(`\n══ ${sp.label}  ·  tenant ${sp.tenant}  ·  ${members.length} player(s) ══`);
    if (!members.length) continue;
    const client = clientFor(sp.tenant);

    for (const p of members) {
      const uuid = uuidFor(p, sportKey);
      console.log(`\n── ${p.name || uuid} (${uuid}) ──`);
      const r = await client.probeTeams(uuid);
      await sleep(DELAY_MS);

      const prev    = readPlayerSport(playerState, p, sportKey);
      const stKey   = `p:${p.uuid}:${sportKey}`;

      if (r.kind !== 'ok') {
        console.log(`  ✖ profile NOT ANSWERED — ${r.kind}: ${r.detail}`);
        // ⚠️ TYPED PER SPORT. One tenant failing says nothing about the other, and
        // the loop must carry on to it.
        failures.push(`${sp.label} · ${p.name || uuid}: profile ${r.kind} — ${r.detail}`);
        // Keep watching the teams we already know about, so a profile outage does
        // not also blind us to fixture changes. Nothing is removed, nothing added.
        for (const tid of Object.keys(prev.teams || {})) {
          if (!toCheck.has(tid)) toCheck.set(tid, { tid, sport: sportKey, reg: prev.teams[tid], players: new Set(), pinned: false });
          toCheck.get(tid).players.add(p.uuid);
        }
        continue;
      }

      // A registration is CURRENT while its season is not COMPLETED. A COMPLETED
      // season's team is still watched until stopAfterSeasonEndDays — finals
      // fixtures appear after the last round and a season can be marked complete
      // before them.
      const current = {};
      for (const t of r.teams) {
        const s = t.season || {};
        current[t.id] = {
          tid: t.id, name: t.name || null, sport: sportKey,
          club: t.organisation?.name || null, clubId: t.organisation?.id || null,
          sid: s.id || null, seasonName: s.name || null,
          seasonStatus: s.status?.value || null,
          startDate: s.startDate || null, endDate: s.endDate || null,
          comp: s.competition?.name || null,
          assoc: s.competition?.organisation?.name || null,
          // ⚠️ THE ORG ID IS THE FOOTY LINK'S `c` KEY. It is carried on every
          // registration so an alert can be linked without a second call.
          assocId: s.competition?.organisation?.id || null,
          regGid: t.grade?.id || null, regGrade: t.grade?.name || null,
        };
      }
      console.log(`  profile OK — ${Object.keys(current).length} registration(s) on ${sp.tenant}`);

      // Team appeared / disappeared on the profile.
      const prevTids = new Set(Object.keys(prev.teams || {}));
      const nextTids = new Set(Object.keys(current));
      const appeared = [...nextTids].filter(t => !prevTids.has(t));
      const vanished = [...prevTids].filter(t => !nextTids.has(t));

      if (prev.seen) {   // never on the very first run for this player+sport
        for (const tid of appeared) {
          const c = current[tid];
          alerts.push({
            key: stKey,
            title: `[${sp.label}] ${p.name || 'Player'} — NEW TEAM`,
            lines: [`${c.name || tid}`, `${c.club || ''} · ${c.seasonName || ''} ${c.regGrade ? `· ${c.regGrade}` : ''}`.trim(), `${c.comp || ''}`].filter(Boolean),
            // No fixture has been fetched for a team we have only just seen, so a
            // footy link is correctly omitted: a brand new registration is precisely
            // what the dashboard cannot resolve.
            url: linkFor(sp, c, null), urlTitle: urlTitleFor(sp), priority: 1,
          });
        }
        for (const tid of vanished) {
          const c = prev.teams[tid] || {};
          // The team has gone from the profile, so there is nothing to fetch — but
          // the state file still holds its last known fixture, which is what decides
          // whether a link can resolve.
          const f    = teamStateFile(tid);
          const gone = fs.existsSync(f) ? readJson(f, null) : null;
          alerts.push({
            key: stKey,
            title: `[${sp.label}] ${p.name || 'Player'} — TEAM GONE`,
            lines: [`${c.name || tid} is no longer on the profile`, `${c.club || ''} · ${c.seasonName || ''}`.trim(), 'Watching has stopped for this team.'].filter(Boolean),
            url: linkFor(sp, c, gone && gone.games), urlTitle: urlTitleFor(sp), priority: 1,
          });
          // STOP: drop the state file — but only once the alert has been delivered,
          // or a failed send would stop the watching AND never say so.
          if (gone) pendingDeletes.set(`${stKey}|${tid}`, { file: f, tid, alertKey: stKey });
        }
      }

      pendingPlayers.set(stKey, { player: p, sport: sportKey, data: { seen: true, teams: current } });

      for (const tid of Object.keys(current)) {
        if (!toCheck.has(tid)) toCheck.set(tid, { tid, sport: sportKey, reg: current[tid], players: new Set(), pinned: false });
        toCheck.get(tid).players.add(p.uuid);
      }
      for (const tid of pinnedFor(p, sportKey)) {
        if (!toCheck.has(tid)) toCheck.set(tid, { tid, sport: sportKey, reg: { tid, name: null, sid: null, sport: sportKey }, players: new Set(), pinned: true });
        toCheck.get(tid).players.add(p.uuid);
        toCheck.get(tid).pinned = true;
      }
    }
  }

  // ── Phase 2 · fixtures, one sport at a time ───────────────────────────────
  const playerName = (uuid) => (WATCHED.find(w => w.uuid === uuid)?.name) || uuid.slice(0, 8);
  let checked = 0, skippedReduced = 0, stopped = 0, outOfScope = 0;

  for (const sportKey of SPORT_KEYS) {
    const sp     = SPORTS[sportKey];
    const mine   = [...toCheck.values()].filter(i => i.sport === sportKey);
    if (!mine.length) continue;
    const client = clientFor(sp.tenant);
    console.log(`\n══ ${sp.label} fixtures — ${mine.length} team(s) in scope ══`);

    for (const item of mine) {
      const tid   = item.tid;
      const file  = teamStateFile(tid);
      const state = readJson(file, null);
      const reg   = item.reg || {};
      const label = `${reg.name || tid}${reg.club ? ` (${reg.club})` : ''}`;

      // STOP on season age. A missing endDate NEVER stops anything.
      const endDate = reg.endDate || state?.reg?.endDate || null;
      if (!item.pinned && endDate) {
        const endMs = Date.parse(`${endDate}T00:00:00Z`);
        if (Number.isFinite(endMs) && todayMs > endMs + STOP_AFTER_D * 86400000) {
          // A team with no state file was never watched, so there is nothing to
          // stop. Calling that "stopping" reads as though something was switched
          // off, which on a first run would be alarming lines about teams from 2024.
          if (state) {
            console.log(`\n  − ${label}: season ended ${endDate}, more than ${STOP_AFTER_D} days ago — stopping.`);
            if (!DRY_RUN) { fs.rmSync(file); touched.add(file); }   // no alert to lose: nothing to defer
            stopped++;
          } else {
            console.log(`\n  · ${label}: season ended ${endDate} — out of scope, never watched.`);
            outOfScope++;
          }
          continue;
        }
      }

      // ── CADENCE ────────────────────────────────────────────────────────────
      // Decided from the coverage THIS TEAM'S LAST CHECK recorded, because the
      // decision has to be made before we have fetched anything this run.
      //
      // Only one thing earns a reduced cadence: a game in every non-finals round of
      // the grade AND a game still to come. Nothing is left to publish for such a
      // team until finals. Everything else — missing rounds, last game passed,
      // unknown coverage, no state — is FULL. Every unknown falls to FULL.
      const cov             = state?.coverage || null;
      const changedRecently = state?.lastChangeAt ? (todayMs - Date.parse(state.lastChangeAt)) < CHANGE_WINDOW_D * 86400000 : false;
      // Unknown last-game date reads as PASSED, which routes to FULL.
      const lastGamePassed  = cov?.lastGameDate ? todayMs > Date.parse(`${cov.lastGameDate}T23:59:59Z`) : true;
      const full = !state || !cov?.complete || lastGamePassed || changedRecently;
      if (!full && !CHECK_REDUCED) { skippedReduced++; continue; }

      const why = !state ? 'first run'
                : !cov?.complete ? `fixture incomplete${cov?.missing?.length ? ` — missing ${cov.missing.slice(0, 4).join(', ')}${cov.missing.length > 4 ? ` +${cov.missing.length - 4}` : ''}` : ''}`
                : lastGamePassed ? 'last scheduled game has passed — hunting finals'
                : changedRecently ? 'changed recently'
                : 'complete fixture, games still to come';
      console.log(`\n  ${full ? 'FULL   ' : 'REDUCED'} ${label}  (${why})`);
      const f = await client.teamFixture(tid);
      await sleep(DELAY_MS);
      checked++;

      if (f.kind !== 'ok') {
        // ⚠️ NOTHING IS WRITTEN AND NOTHING IS ALERTED. This is the whole rule.
        console.log(`     ✖ NOT ANSWERED — ${f.kind}: ${f.detail}. State left untouched; no fixture alert from this team.`);
        failures.push(`${sp.label} · ${label}: fixture ${f.kind} — ${f.detail}`);
        // ⚠️ `break` LEAVES THIS SPORT ONLY. A dead session on one tenant says
        // nothing about the other, and the next sport gets its own client.
        if (f.kind === 'no-session') { console.log(`     ⛔ no session on tenant ${sp.tenant} — abandoning the rest of ${sp.label} this pass. Other sports continue.`); break; }
        continue;
      }

      const games = normaliseGames(tid, f.rounds);
      const count = Object.keys(games).length;

      // ── COVERAGE ───────────────────────────────────────────────────────────
      // Does this team hold a game in every non-finals round of its CURRENT grade?
      // Coverage is computed against the current grade only: after a regrade the
      // team's games span two grades, and the rounds that matter from here are the
      // new grade's. Rounds are matched on ROUND ID, never on name — names repeat
      // across grades and seasons.
      const curGid = f.team?.grade?.id || [...new Set(Object.values(games).map(g => g.gid).filter(Boolean))].pop() || null;
      let roundsInfo = state?.rounds && state.rounds.gid === curGid ? state.rounds : null;
      const roundsStale = !roundsInfo || !roundsInfo.fetchedAt
        || (todayMs - Date.parse(roundsInfo.fetchedAt)) > ROUNDS_REFRESH_H * 3600000
        || !state?.coverage?.complete          // still filling: the round list may have grown
        || lastGamePassed                      // finals rounds get added after the last round
        || !roundsInfo.list.some(r => r.current); // no current round cached: it has moved on, or was never stored

      if (curGid && roundsStale) {
        const gr = await client.gradeRounds(curGid);
        await sleep(DELAY_MS);
        if (gr.kind === 'ok') {
          roundsInfo = { gid: curGid, fetchedAt: nowIso(), list: gr.rounds.map(r => ({ id: r.id, name: r.name || null, number: r.number ?? null, current: !!r.current, isFinalsRound: !!r.isFinalsRound })) };
        } else {
          // Could not ask. Keep whatever we had, and let coverage fall to unknown if
          // we had nothing — which routes the team to FULL. Not a run-level failure:
          // the fixture itself was answered, so the alerting is unaffected.
          console.log(`     grade rounds NOT ANSWERED — ${gr.kind}: ${gr.detail}. Cadence falls back to FULL for this team.`);
        }
      }

      let coverage = null;
      if (roundsInfo?.list?.length) {
        // ⚠️ A ROUND OBJECT IN THE RESPONSE IS NOT A GAME.
        // discoverTeamFixture returns the GRADE's rounds, including rounds this team
        // holds no game in. Measured on real data 2026-11-15: B13 Spirit Magic 3 came
        // back with 15 round objects for 5 games and was scored 11/15 covered, which
        // is nonsense — 5 games cannot cover 11 rounds. A round counts as covered only
        // when the team actually holds a game in it. A BYE is a game entry, so a bye
        // round still counts as covered — but a footy bye that is NOT entered as a
        // game leaves the round uncovered and the team on FULL for ever, which is
        // the safe direction and is not to be "fixed".
        const teamRoundIds = new Set(
          f.rounds
            .filter(r => (!curGid || r?.grade?.id === curGid) && (r?.fixture?.games || []).some(g => g?.id))
            .map(r => r?.id).filter(Boolean)
        );
        // ⚠️ ONLY ROUNDS FROM THE CURRENT ROUND ONWARD ARE REQUIRED.
        // Two things make "a game in every round of the grade" the wrong test:
        //   1. A REGRADED team's earlier games belong to its OLD grade, so it can
        //      never hold a game in the new grade's early rounds and would sit at
        //      incomplete for ever. Measured on real data 2026-11-15: B13 Spirit
        //      Magic 3 (CR) scored 1/15 against 5 games for exactly this reason.
        //   2. A team that joined late, had a bye, or whose early rounds were washed
        //      out is in the same position, and none of it says anything about
        //      whether the fixture AHEAD has been published.
        // The question that matters is: is every round from here on scheduled?
        // `discoverGrade` flags the current round, so that is the cut.
        const nonFinals    = roundsInfo.list.filter(r => !r.isFinalsRound);
        const currentRound = roundsInfo.list.find(r => r.current);
        const heldNumbers  = nonFinals.filter(r => teamRoundIds.has(r.id)).map(r => r.number).filter(n => Number.isFinite(n));
        // No current round means pre-season or post-season. Fall back to the first
        // round this team actually holds, and to round 1 when it holds none — both of
        // which require MORE rounds, never fewer.
        const fromNumber   = Number.isFinite(currentRound?.number) ? currentRound.number
                           : (heldNumbers.length ? Math.min(...heldNumbers) : 1);
        const needed  = nonFinals.filter(r => !Number.isFinite(r.number) || r.number >= fromNumber);
        const missing = needed.filter(r => !teamRoundIds.has(r.id));
        const dates   = Object.values(games).map(g => g.d).filter(Boolean).sort();
        coverage = {
          gid: curGid,
          roundsInGrade: roundsInfo.list.length,
          fromRound: fromNumber,
          currentRoundName: currentRound?.name || null,
          nonFinalsRoundsInGrade: nonFinals.length,
          nonFinalsRounds: needed.length,
          covered: needed.length - missing.length,
          complete: needed.length > 0 && missing.length === 0,
          missing: missing.map(r => r.name || `round ${r.number ?? '?'}`),
          finalsRoundsInGrade: roundsInfo.list.filter(r => r.isFinalsRound).length,
          lastGameDate: dates.length ? dates[dates.length - 1] : null,
          checkedAt: nowIso(),
        };
        console.log(`     coverage: ${coverage.covered}/${coverage.nonFinalsRounds} round(s) from ${coverage.currentRoundName || `round ${coverage.fromRound}`} onward hold a game${coverage.complete ? ' — COMPLETE' : `, missing ${coverage.missing.slice(0, 4).join(', ')}${coverage.missing.length > 4 ? ` +${coverage.missing.length - 4}` : ''}`} (grade has ${coverage.nonFinalsRoundsInGrade} non-finals${coverage.finalsRoundsInGrade ? ` + ${coverage.finalsRoundsInGrade} finals` : ''}); ${count} game(s); last game ${coverage.lastGameDate || '—'}`);
      } else {
        console.log('     coverage: UNKNOWN (no grade round list) — this team stays on FULL');
      }
      const teamMeta = {
        tid,
        sport: sportKey,
        name: f.team?.id ? (reg.name || state?.reg?.name || null) : (reg.name || null),
        club: reg.club || f.team?.organisation?.name || state?.reg?.club || null,
        sid:  reg.sid  || f.team?.season?.id || state?.reg?.sid || null,
        seasonName: reg.seasonName || f.team?.season?.name || state?.reg?.seasonName || null,
        seasonStatus: reg.seasonStatus || f.team?.season?.status?.value || null,
        endDate: endDate,
        comp: reg.comp || f.team?.season?.competition?.name || null,
        assoc: reg.assoc || f.team?.season?.competition?.organisation?.name || null,
        assocId: reg.assocId || f.team?.season?.competition?.organisation?.id || state?.reg?.assocId || null,
        currentGid: f.team?.grade?.id || null,
        currentGrade: f.team?.grade?.name || null,
      };
      const url      = linkFor(sp, teamMeta, games);
      const urlTitle = urlTitleFor(sp);
      const who      = [...item.players].map(playerName).join(', ');

      if (!state) {
        // FIRST RUN FOR THIS TEAM — baseline, one summary, never one alert per game.
        console.log(`     baseline: ${count} game(s), ${f.rounds.length} round(s)`);
        alerts.push({
          key: `t:${tid}`,
          title: `[${sp.label}] ${who} — now watching ${teamMeta.name || tid}`,
          lines: [
            `${teamMeta.club || ''} · ${teamMeta.seasonName || ''} ${teamMeta.currentGrade ? `· ${teamMeta.currentGrade}` : ''}`.trim(),
            `${count} game(s) on the fixture`,
            ...(() => {
              const future = Object.values(games)
                .filter(g => g.d && Date.parse(`${g.d}T23:59:59Z`) >= todayMs)
                .sort((a, b) => (a.d || '').localeCompare(b.d || ''));
              // Saying nothing here reads as "no games". Say which it is.
              if (!future.length) return [coverage && !coverage.complete ? 'No games scheduled ahead — waiting on the next fixture block.' : 'No games scheduled ahead.'];
              return future.slice(0, 3).map(g => `  ${describeGame(g)}`);
            })(),
          ].filter(Boolean),
          url, urlTitle, priority: 0, baseline: true,
        });
        pendingWrites.set(`t:${tid}`, { file, data: { tid, reg: teamMeta, players: [...item.players], games, rounds: roundsInfo || null, coverage, firstSeenAt: nowIso(), lastChangeAt: nowIso(), lastCheckedAt: nowIso() } });
        continue;
      }

      const prevCount = Object.keys(state.games || {}).length;
      const { changes, regrade, prevGids, nextGids } = diffFixture(state.games || {}, games, todayMs);

      // ── The loud one. A fixture that had games and now has none usually means the
      // regrade was made as a NEW team entry, so the real fixture is somewhere else
      // and this team will quietly never show a game again.
      if (prevCount > 0 && count === 0) {
        console.log(`     ‼ FIXTURE DROPPED TO ZERO (was ${prevCount})`);
        alerts.push({
          key: `t:${tid}`,
          title: `‼ [${sp.label}] ${who} — FIXTURE EMPTY: ${teamMeta.name || tid}`,
          lines: [
            `This team had ${prevCount} game(s) and now has NONE.`,
            'PlayHQ answered normally — this is not a fetch failure.',
            'Most likely a regrade made as a new team entry: the fixture will be under a different team id.',
            `${teamMeta.club || ''} · ${teamMeta.seasonName || ''}`.trim(),
          ].filter(Boolean),
          url, urlTitle, priority: 1,
        });
      } else if (prevCount === 0 && count > 0) {
        // ── THE FIRST FIXTURE. The mirror of the drop-to-zero alert above, and the
        // single most important thing this repo does.
        // MEASURED 2026-11-24: a player registered to a 2027 footy team appears on
        // publicProfileTeams immediately — team present, grade null, fixture empty.
        // So a watched team can sit at zero games for months and then receive its
        // whole season at once. Reporting that as fourteen "+ ADDED" lines truncated
        // at four is the wrong shape for the alert you have been waiting for.
        const sorted = Object.values(games).filter(g => g.d).sort((a, b) => (a.d || '').localeCompare(b.d || ''));
        const first = sorted[0], last = sorted[sorted.length - 1];
        console.log(`     ★ FIXTURE PUBLISHED — ${count} game(s)`);
        alerts.push({
          key: `t:${tid}`,
          title: `★ [${sp.label}] ${who} — FIXTURE OUT: ${teamMeta.name || tid}`,
          lines: [
            `${count} game(s) published${coverage?.nonFinalsRoundsInGrade ? ` across ${coverage.nonFinalsRoundsInGrade} round(s)` : ''}.`,
            `${teamMeta.club || ''} · ${teamMeta.seasonName || ''} ${teamMeta.currentGrade ? `· ${teamMeta.currentGrade}` : ''}`.trim(),
            first ? `First: ${describeGame(first)}` : null,
            last && last !== first ? `Last:  ${describeGame(last)}` : null,
          ].filter(Boolean),
          url, urlTitle, priority: 1,
        });
      } else if (changes.length || regrade) {
        const lines = [];
        if (regrade) lines.push(`REGRADE: ${prevGids.join(',')} → ${nextGids.join(',')}${teamMeta.currentGrade ? ` (${teamMeta.currentGrade})` : ''}`);
        for (const c of changes) lines.push(c.line);
        const counts = ['added', 'changed', 'removed'].map(t => { const n = changes.filter(c => c.type === t).length; return n ? `${n} ${t}` : null; }).filter(Boolean).join(', ');
        console.log(`     ${regrade ? 'REGRADE + ' : ''}${counts || 'no game changes'}`);
        alerts.push({
          key: `t:${tid}`,
          title: `[${sp.label}] ${who} — ${teamMeta.name || tid}${regrade ? ' REGRADED' : ''}`,
          lines: [`${teamMeta.seasonName || ''} ${teamMeta.currentGrade ? `· ${teamMeta.currentGrade}` : ''}`.trim(), ...lines].filter(Boolean),
          url, urlTitle, priority: regrade ? 1 : 0,
        });
      } else {
        console.log(`     no change (${count} game(s))`);
      }

      // ── Queue a fast publish for anything that just went FINAL ──────────────
      // Only reachable on the DIFF path. A team's first pass returns above, so a
      // baseline never dispatches — otherwise every past result in the fixture
      // would fire one the first time a team is seen.
      if (sp.publish && sp.publish.active) {
        const sid    = teamMeta && teamMeta.sid;
        const rounds = finalTransitions(state.games || {}, changes);
        if (rounds.length && !sid) {
          console.log(`     ⚠ ${rounds.length} round(s) went FINAL but this team's state carries no season id — cannot dispatch.`);
        } else if (rounds.length > sp.publish.maxRounds) {
          console.log(`     ⚠ ${rounds.length} round(s) went FINAL in one pass (limit ${sp.publish.maxRounds}) — dispatching NONE.`);
          console.log('       A block that large is a regrade or a backlog, which the nightly already handles correctly.');
          failures.push(`${sp.label} · ${teamMeta.name || tid}: ${rounds.length} rounds went FINAL at once — fast publish skipped, the nightly will pick them up`);
        } else if (rounds.length) {
          for (const r of rounds) {
            console.log(`     → FINAL: grade ${r.grade} "${r.round}" (${r.games.join(', ')}) — queued for fast publish`);
          }
          pendingDispatch.set(`t:${tid}`, { pub: sp.publish, rounds: rounds.map(r => ({ season: sid, ...r })) });
        }
      }

      const changed = changes.length > 0 || regrade || (prevCount > 0 && count === 0);
      {
        const next = {
          tid, reg: teamMeta, players: [...item.players], games,
          rounds: roundsInfo || state.rounds || null,
          coverage: coverage || state.coverage || null,
          firstSeenAt: state.firstSeenAt || nowIso(),
          lastChangeAt: changed ? nowIso() : (state.lastChangeAt || null),
          lastCheckedAt: nowIso(),
        };
        // Coverage carries timestamps that move on every single check. Comparing the
        // whole object would commit on every slot and bury the fixture history, so
        // only the parts a reader or the next run's cadence depends on are compared.
        const covSig = (c) => c ? JSON.stringify([c.gid, c.complete, c.covered, c.nonFinalsRounds, c.fromRound, c.missing, c.lastGameDate, c.finalsRoundsInGrade]) : 'null';
        // Only write when something a reader would care about moved. lastCheckedAt
        // alone is not worth a commit on every slot — that is 34 commits a day of
        // nothing, and it would bury the real history.
        if (changed || JSON.stringify(next.games) !== JSON.stringify(state.games) || JSON.stringify(next.reg) !== JSON.stringify(state.reg) || covSig(next.coverage) !== covSig(state.coverage)) {
          pendingWrites.set(`t:${tid}`, { file, data: next });
        }
      }
    }
  }

  console.log(`\n[fixture-watch] ${checked} team(s) checked, ${skippedReduced} complete-fixture team(s) not due this slot, ${stopped} stopped, ${outOfScope} out of scope (season long over).`);

  // ── Phase 2n · Netball Connect ────────────────────────────────────────────
  // A THIRD SOURCE, not a third PlayHQ tenant: a different vendor, a different
  // API, its own login. The whole thing is wrapped so that NOTHING it does can
  // affect the PlayHQ results above — a throw in here becomes a typed failure and
  // the pass carries on to deliver the basketball and footy alerts.
  try {
    await runNetballConnect({ alerts, failures, pendingWrites, touched, nowMs: todayMs });
  } catch (err) {
    console.log(`  ✖ Netball Connect threw: ${err && err.message ? err.message : 'unknown'}`);
    failures.push(`Netball Connect: unexpected error — ${err && err.message ? err.message : 'see the log'}`);
  }

  // ── Phase 3 · alerts ──────────────────────────────────────────────────────
  const token = process.env.PUSHOVER_TOKEN || '';
  const user  = process.env.PUSHOVER_USER  || '';
  let sendFailed = false;

  const failedKeys = new Set();

  if (NO_ALERTS && alerts.length) {
    // Suppressed on purpose, not failed. The state is written, because the operator
    // asked for no alerts and does not want the same ones again on the next slot.
    console.log(`[fixture-watch] --no-alerts: ${alerts.length} alert(s) suppressed.`);
  } else {
    for (const a of alerts) {
      const body = pushover.buildBody(a.lines, MAX_ALERT_CHARS);
      const r = await pushover.send({ token, user, title: a.title, message: body, url: a.url || undefined, urlTitle: a.urlTitle || 'Open', priority: a.priority, dryRun: DRY_RUN });
      if (!r.ok) {
        console.log(`  ✖ Pushover failed: ${r.detail}`);
        failures.push(`Pushover: ${r.detail}`);
        sendFailed = true;
        if (a.key) failedKeys.add(a.key);
      }
    }
    if (alerts.length && !DRY_RUN && !sendFailed) console.log(`[fixture-watch] ${alerts.length} alert(s) sent.`);
    if (!alerts.length) console.log('[fixture-watch] no alerts.');
  }

  // ── Phase 4 · failure alert, rate limited ─────────────────────────────────
  if (failures.length) {
    const last = meta.lastFailureAlertAt ? Date.parse(meta.lastFailureAlertAt) : 0;
    const due  = !Number.isFinite(last) || (todayMs - last) > FAIL_COOLDOWN_H * 3600000;
    console.log(`\n[fixture-watch] ${failures.length} failure(s):`);
    for (const f of failures) console.log(`  ✖ ${f}`);
    if (due && !NO_ALERTS) {
      const r = await pushover.send({
        token, user,
        title: 'watcher failed',
        message: pushover.buildBody([`${failures.length} failure(s) this run:`, ...failures], MAX_ALERT_CHARS),
        priority: 0, dryRun: DRY_RUN,
      });
      if (r.ok && !DRY_RUN) meta.lastFailureAlertAt = nowIso();
      if (!r.ok) console.log(`  ✖ failure alert could not be sent: ${r.detail}`);
    } else if (!due) {
      console.log(`  (failure alert suppressed — one was sent within the last ${FAIL_COOLDOWN_H}h. The run is still RED.)`);
    }
  }

  // ── Phase 5 · persist ─────────────────────────────────────────────────────
  let held = 0;
  if (!DRY_RUN) {
    for (const [key, w] of pendingWrites) {
      if (failedKeys.has(key)) { held++; console.log(`  ↺ holding back state for ${key} — its alert did not send, so the next run re-detects and re-alerts`); continue; }
      // The dispatch goes BEFORE the state write, for exactly the reason the
      // alerts do: writing first baselines the FINAL, so a refused dispatch would
      // never be retried and the result would quietly never publish early.
      const toDispatch = pendingDispatch.get(key);
      if (toDispatch && toDispatch.rounds.length) {
        let allOk = true;
        for (const d of toDispatch.rounds) {
          const r = await dispatchPublish(toDispatch.pub, d);
          if (r.ok) {
            console.log(`  ⇢ dispatched ${toDispatch.pub.workflow}: ${d.season} ${d.grade} "${d.round}" (${d.games.length} game(s))`);
          } else {
            allOk = false;
            console.log(`  ✖ dispatch FAILED for ${d.season} ${d.grade} "${d.round}": ${r.detail}`);
            failures.push(`${toDispatch.pub.workflow} dispatch failed (${d.grade} ${d.round}): ${r.detail}`);
          }
        }
        if (!allOk) {
          held++;
          console.log(`  ↺ holding back state for ${key} — a dispatch failed, so the next run re-detects the FINAL and re-dispatches`);
          continue;
        }
      }
      writeJson(w.file, w.data); touched.add(w.file);
    }
    for (const [, d] of pendingDeletes) {
      if (failedKeys.has(d.alertKey)) { held++; console.log(`  ↺ holding back the stop for ${d.tid} — its alert did not send`); continue; }
      if (fs.existsSync(d.file)) { fs.rmSync(d.file); touched.add(d.file); console.log(`  − stopped watching ${d.tid} (left the profile)`); }
    }
    for (const [key, pl] of pendingPlayers) {
      if (failedKeys.has(key)) { held++; continue; }
      writePlayerSport(playerState, pl.player, pl.sport, pl.data);
    }

    writeJson(PLAYERS_ST, playerState); touched.add(PLAYERS_ST);
    writeJson(META_ST, meta);           touched.add(META_ST);
    // These two are staged unconditionally and git decides: when their content is
    // unchanged the staged shortstat is empty and nothing is committed. That is what
    // keeps a quiet slot from producing a commit saying nothing.
    await gitCommit([...touched], `fixture-watch: ${alerts.length} alert(s), ${checked} team(s) checked [skip ci]`);
    if (held) console.log(`[fixture-watch] ${held} state write(s) held back because their alert failed.`);
  } else {
    console.log(`\n[fixture-watch] --dry-run: nothing written, nothing committed (${pendingWrites.size} write(s) and ${pendingDeletes.size} stop(s) would have been applied).`);
  }

  for (const [tenant, c] of clients) console.log(`[fixture-watch] session [${tenant}] ${JSON.stringify(c.stats())}`);
  console.log(`[fixture-watch] elapsed ${Math.round((Date.now() - started) / 1000)}s`);

  if (failures.length) {
    console.error('\nFAILED: see the failure list above. State was written ONLY for teams PlayHQ answered AND whose alert was delivered; everything else is untouched, so the next run re-asks and re-alerts. Nothing has been lost.');
    process.exit(1);
  }
  console.log('Done.');
})().catch(err => {
  console.error(`\nFATAL: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
