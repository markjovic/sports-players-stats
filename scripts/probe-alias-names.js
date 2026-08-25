// scripts/probe-alias-names.js
//
// READ-ONLY. Writes one report, commits it. No data-write lock.
//
// THE LAST 760. probe-alias-credits checked all 81,636 name-matched aliases against
// PlayHQ: 77,142 confirmed correct, 88 repointable, and about 760 where the target
// profile is not credited with the games the alias delivers AND no other profile
// with that name is either. The credit test cannot settle those — it has run out
// of evidence.
//
// THIS ASKS A DIFFERENT QUESTION, and it is the one that settled Jida McCrae-Cooper
// by hand: PlayHQ's spectator box score returns each roster entry's profileID AND
// NAME. So for an alias id we can ask PlayHQ directly "who is this?" and compare
// that name against the player the alias points at.
//
//   SAME NAME       PlayHQ calls this id the same person the alias targets. The
//                   alias is right; the missing credits are PlayHQ's own gaps,
//                   which we have seen all day.
//   DIFFERENT NAME  PlayHQ calls this id somebody else. The alias is WRONG and
//                   those appearances are on the wrong player — the exact
//                   900f4fe6-bec3 -> d6c25c0c error.
//   NO NAME         the box has no entry for this id, or is not retained. No
//                   verdict; never counted against the alias.
//
// Name comparison uses normName from lib/namespace-resolve.cjs, the same fold used
// to CREATE these aliases — so a difference here is a real difference, not a
// curly-quote or hyphen variant.
//
// It writes reports/alias-name-audit.json and changes nothing else. Acting on a
// DIFFERENT NAME verdict is a separate tool and a separate decision.
//
// Usage:
//   node scripts/probe-alias-names.js --sample=50
//   node scripts/probe-alias-names.js --all --concurrency=3

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const num = (f, d) => {
  const a = args.find(x => x.startsWith('--' + f + '='));
  const v = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : d;
};
const ALL = args.includes('--all');
const SAMPLE = num('sample', 50);
// The SPECTATOR endpoint, not the main API — it has different 403 behaviour and
// tolerates far less. spectator-backfill runs 3.
const CONCURRENCY = Math.max(1, Math.min(10, num('concurrency', 3)));
const SAVE_EVERY = num('save-every', 50);
const API_URL = 'https://api.playhq.com/graphql';
const TRUNC_LEN = 13;
const n = (x) => Number(x || 0).toLocaleString();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '0.0';

// normName v2 — matches lib/namespace-resolve.cjs EXACTLY. The aliases under audit
// were created with this fold, so comparing with anything looser or tighter would
// manufacture disagreements that the matcher never saw.
const normName = s => String(s == null ? '' : s).normalize('NFKC')
  .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
  .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, '-')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const GAMES_DIR     = path.join(ROOT, 'games', 'bv');
const PLAYERS_DIR   = path.join(ROOT, 'players');
const INDEX_DIR     = path.join(ROOT, 'players', 'indexes');
const INDEX_FILE    = path.join(ROOT, 'data', 'sports-index.json');

const CONCURRENCY_SPECTATOR = 3;       // unchanged (spectator.playhq.com)
const COMMIT_EVERY_GAMES    = Math.max(1, parseInt(process.env.SB_COMMIT_EVERY || '', 10) || 2000);    // flush + commit spc/p[] progress every N games (env override exists for crash-consistency testing only)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Identity alias for brand-new players (api-canonical, 2026-07-16) ─────────
// Every player file key must have an alias entry (trunc13(key) -> key), or the
// index gap the 3b-2 repair closed re-opens with every stub. Written at stub
// time; the matrix's recovery later REPLACES it with a redirect if the player
// turns out diverged. Format matches build-alias-index.js: sorted, minified.
// Covered by gitCommit(['players/']) — players/aliases sits under players/.
function writeAliasIdentity(uuid) {
  const bucket = uuid.slice(0, 2).toLowerCase();
  const aliasPath = path.join(ROOT, 'players', 'aliases', `${bucket}.json`);
  let map = {};
  try { map = JSON.parse(fs.readFileSync(aliasPath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const key = uuid.slice(0, TRUNC_LEN);
  if (map[key] !== undefined) return; // never clobber an existing (possibly redirect) entry
  map[key] = uuid;
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
  fs.writeFileSync(aliasPath, JSON.stringify(sorted));
}

// ─── HTTP — nightly-crawl.js, verbatim ────────────────────────────────────────

function doFetch(url, bodyObj, headers) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify(bodyObj);
    const parsed = new URL(url);
    const h      = { ...headers, 'request-id': crypto.randomUUID(),
                     'content-length': Buffer.byteLength(body) };
    const req    = https.request(
      { hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
        headers: h, agent: new https.Agent({ keepAlive: false }) },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = JSON.parse(rawText); } catch (_) { body = null; }
          resolve({
            status:     res.statusCode,
            rawCookies: res.headers['set-cookie'],
            body,
            rawText,
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Session — nightly-crawl.js, verbatim ─────────────────────────────────────

const HEADERS_MAIN = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};
const HEADERS_SPECTATOR = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'bv', 'x-phq-tenant': 'bv', 'content-type': 'application/json',
};

let sessionCookie = null;

// ⚠ WRAPPED IN A PROMISE LOCK. Concurrent callers each seeing a missing cookie
// would otherwise fire their own refresh and invalidate each other — the failure
// that collapsed probe-alias-credits to concurrency 1 on 2026-08-23.
let sessionPromise = null;
async function refreshSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
  const body = { operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' };
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    try {
      const { rawCookies } = await doFetch(API_URL, body, HEADERS_MAIN);
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
})().finally(() => { sessionPromise = null; });
  return sessionPromise;
}

// ─── Spectator query — nightly-crawl.js, verbatim ─────────────────────────────

// 2026-08-10: returns a CLASSIFIED outcome, never a bare null. Previously every
// failure mode collapsed to null, so a 403 that survived its retry, a 429, a 502
// and a dropped connection were indistinguishable from "this game genuinely has
// no box score" — and with --miss-attempts=1 one bad moment retired a game
// FOREVER. Proven by spot-check 2026-08-10: of four retired misses in seasons
// with >95% capture, THREE had full box scores on playhq.com. Contract:
//   { ok:true,  game }                    → fetched; caller decides empty vs not
//   { ok:false, permanent:true }          → 404, or a 200 whose game is null:
//                                           not on the spectator endpoint at all.
//                                           Counts toward retirement.
//   { ok:false, permanent:false }         → 403-after-retry / 429 / 5xx / GraphQL
//                                           error / network fault. TRANSPORT, not
//                                           data: must NEVER count toward
//                                           retirement, or the weekly cron will
//                                           quietly delete games from the queue
//                                           on every bad network minute.
// ── IS THIS ID AN API PROFILE? ───────────────────────────────────────────────
// The stub decision below used to be: resolveToFullUuid() returned the id
// unchanged, therefore the id is canonical, therefore create a player file for it.
// That is a lookup in players/aliases, and ABSENCE FROM A TABLE IS NOT EVIDENCE OF
// ANYTHING. Since the alias builders (build-alias-index.js, build-alias-inverse.js)
// were deleted as migration-era tools, the only thing that writes new aliases is
// fetch-profile-stats.js — so discovery routinely runs ahead of aliasing, and every
// spectator id that arrived first became a player file.
//
// Measured 2026-08-21: 2,895 pairs of same-named player files, 122,866 duplicated
// appearances. Tahlia Parker is the worked example — 378 of her 385 shared games
// carry BOTH `20b2df06-37f4` (her real api profile) and `f806d1b6-f87f` (a spectator
// id that got stubbed) in the same p[]. PlayHQ serves the first and returns
// "There was a problem getting the profile" for the second.
//
// The design was always one file per API-CANONICAL uuid, with spectator ids
// recorded on it so their appearances resolve to the right person. This restores
// that: ASK PlayHQ before manufacturing a person. One call per genuinely-new id
// (115 in the 2026-08-20 sweep), and only for ids never seen before.
const PROFILE_EXISTS_QUERY = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) { seasonStatistics { name } }
}`;

// 'api' | 'not-api' | 'unknown'. `unknown` is a TRANSPORT outcome and must never be
// treated as either answer — on unknown the id is deferred, not stubbed and not
// aliased, so a throttle can never invent or discard a player.
async function isApiProfile(uuid) {
  if (!sessionCookie) await refreshSession();
  let res;
  try {
    res = await doFetch(API_URL,
      { operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: PROFILE_EXISTS_QUERY },
      { ...HEADERS_MAIN, 'Cookie': sessionCookie });
  } catch (e) { return 'unknown'; }
  // doFetch returns `body` ALREADY PARSED (null when the response is not JSON) and
  // the unparsed text as `rawText` — read both from the right field.
  const raw = res.rawText || '';
  if (res.status === 403) {
    // A private profile EXISTS — it just withholds statistics. Treat as api, or
    // every private player would be refused a file. CloudFront blocks are HTML.
    if (/DOCTYPE|Request blocked/i.test(raw)) return 'unknown';
    return 'api';
  }
  if (res.status === 404) return 'not-api';
  if (res.status < 200 || res.status >= 300) return 'unknown';
  const j = res.body;
  if (!j) return 'unknown';
  if (j.errors && j.errors.length) {
    const m = String(j.errors[0].message || '');
    if (/NOT_FOUND|failed to find profile/i.test(m)) return 'not-api';
    return 'unknown';
  }
  return (j.data && j.data.publicProfileStatistics !== undefined) ? 'api' : 'not-api';
}

async function gqlSpectator(gameId) {
  if (!sessionCookie) await refreshSession();
  const query = `query game($id: ID!) {
    game(id: $id) {
      id status
      statistics {
        home { players { profileID name playerNumber statistics { type { value } count } } }
        away { players { profileID name playerNumber statistics { type { value } count } } }
      }
    }
  }`;
  try {
    const { status, body } = await doFetch(
      SPECTATOR_URL,
      { operationName: 'game', variables: { id: gameId }, query },
      { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
    );
    if (status === 403) {
      // Single refresh then retry — do not loop
      await refreshSession();
      const retry = await doFetch(
        SPECTATOR_URL,
        { operationName: 'game', variables: { id: gameId }, query },
        { ...HEADERS_SPECTATOR, 'Cookie': sessionCookie }
      );
      if (retry.status === 404) return { ok: false, permanent: true, why: '404' };
      if (retry.status !== 200 || retry.body.errors) return { ok: false, permanent: false, why: '403-retry-' + retry.status };
      const g403 = retry.body.data?.game;
      return g403 ? { ok: true, game: g403 } : { ok: false, permanent: true, why: 'no-game' };
    }
    if (status === 404) return { ok: false, permanent: true, why: '404' };
    if (status !== 200) return { ok: false, permanent: false, why: 'http-' + status };
    if (body.errors) {
      // 2026-08-11: log WHAT the error says. The first version returned a bare
      // 'graphql-error', and a 200-game probe of re-admitted misses came back
      // 200/200 with that label — which distinguishes nothing. The message and
      // extensions.code separate a permanent NOT_FOUND (the endpoint cannot serve
      // this game id at all — retirement was CORRECT) from an auth/permission or
      // throttle error (genuinely transient). Sampled id shapes suggest the former:
      // the missed games' ids are overwhelmingly all-numeric, i.e. a legacy id
      // format, while captured games' ids are hex.
      const e0 = body.errors[0] || {};
      const code = (e0.extensions && (e0.extensions.code || e0.extensions.errorType)) || '';
      const msg  = String(e0.message || '').slice(0, 80);
      // 2026-08-20: THE PATTERN MISSED PLAYHQ'S ACTUAL WORDING AND CREATED A
      // PERMANENT LIMBO. The live message is
      //   "game could not be found or was not electronically scored"
      // with NO extensions.code at all (logged as `graphql:nocode:`). None of the
      // patterns above match "could not be found", so `permanent` came back FALSE
      // and the game was classed a TRANSPORT failure — nothing written, no spcm.
      //
      // That is the worst possible outcome, because the two paper-scored routes are
      // wired in series: spectator-backfill re-queues the game on every run for
      // ever, and discover-game-backfill selects on `spcm > 0` so it can NEVER see
      // it. On 2026-08-20 a full sweep produced 2,935 games in exactly that state
      // and the chained canonical-record run reported "Queue empty — nothing to do".
      //
      // "was not electronically scored" is a DATA FACT, not a network condition:
      // the box was kept on paper and the live-scoring service will never have it.
      // It belongs to the canonical record, and marking spcm is what hands it over.
      const perm = /NOT_FOUND|NOT FOUND|does not exist|no such|invalid.*id|BAD_USER_INPUT|could not be found|not electronically scored/i.test(code + ' ' + msg);
      return { ok: false, permanent: perm, why: 'graphql:' + (code || 'nocode') + ':' + (msg || 'nomsg') };
    }
    const g = body.data?.game;
    return g ? { ok: true, game: g } : { ok: false, permanent: true, why: 'no-game' };
  } catch (e) { return { ok: false, permanent: false, why: 'network-' + (e.code || e.message || 'err') }; }
}

// ─── Stat parsing — nightly-crawl.js, verbatim ────────────────────────────────

function spectatorStatValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const s = statistics.find(x => x.type?.value === typeValue);
  return s ? (s.count || 0) : 0;
}

function parseSpectatorPlayers(players) {
  if (!Array.isArray(players)) return [];
  return players
    .filter(p => p && p.profileID)
    .map(p => ({
      profileID: p.profileID,
      name:      p.name  || null,
      number:    p.playerNumber ?? null,
      pts:       spectatorStatValue(p.statistics, 'TOTAL_SCORE'),
      pt1:       spectatorStatValue(p.statistics, '1_POINT_SCORE'),
      pt2:       spectatorStatValue(p.statistics, '2_POINT_SCORE'),
      pt3:       spectatorStatValue(p.statistics, '3_POINT_SCORE'),
      fouls:     spectatorStatValue(p.statistics, 'TOTAL_FOULS'),
    }));
}

// ─── Concurrency pool — nightly-crawl.js, verbatim ────────────────────────────
const CREDITS_QUERY = `query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      statistics {
        teamStatistics { gradeStatistics { gameStatistics { game { id } } } }
      }
    }
  }
}`;

async function creditedGameIds(uuid) {
  if (!sessionCookie) await refreshSession();
  let res;
  try {
    res = await doFetch(API_URL,
      { operationName: 'ProfileSeasonStatistics', variables: { profileID: uuid }, query: CREDITS_QUERY },
      { ...HEADERS_MAIN, 'Cookie': sessionCookie });
  } catch (e) { return null; }
  if (res.status === 403 || res.status === 404) return null;
  const j = res.body;
  if (!j || j.errors) return null;
  const out = new Set();
  for (const s of (j.data?.publicProfileStatistics?.seasonStatistics || [])) {
    for (const st of (s.statistics || [])) {
      for (const ts of (st.teamStatistics || [])) {
        for (const gs of (ts.gradeStatistics || [])) {
          for (const g of (gs.gameStatistics || [])) {
            const id = g?.game?.id;
            if (id) { out.add(String(id)); out.add(String(id).slice(0, 8)); out.games = (out.games || 0) + 1; }
          }
        }
      }
    }
  }
  return out;
}



const GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const REPORT = path.join(ROOT, 'reports', 'alias-name-audit.json');

function atomicWrite(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, p);
  } catch (e) { console.log('  ⚠ write failed: ' + e.message); }
}

function commitReport(msg) {
  try {
    execSync('git add -- reports/alias-name-audit.json', GIT);
    const staged = execSync('git diff --staged --shortstat', GIT).toString().trim();
    if (!staged) return;
    console.log('  staging: ' + staged);
    execSync('git commit -q -m "probe-alias-names: ' + msg + '"', GIT);
    for (let a = 1; a <= 40; a++) {
      try { execSync('git merge --abort', GIT); } catch (e) {}
      try {
        console.log('  … fetch/merge/push (attempt ' + a + ')');
        execSync('git fetch origin main', GIT);
        execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT);
        execSync('git push origin main', GIT);
        console.log('  ✔ pushed');
        return;
      } catch (e) {
        if (a === 40) throw new Error('push failed after 40 attempts');
        const w = 1 + Math.floor(Math.random() * 60);
        console.log('  … push attempt ' + a + ' failed, retrying in ' + w + 's');
        try { execSync('sleep ' + w, { stdio: 'pipe', timeout: (w + 30) * 1000 }); } catch (e2) {}
      }
    }
  } catch (e) { console.log('  ⚠ commit failed: ' + e.message); }
}

// Ask PlayHQ who this id is, from the box score of a game the alias delivers.
async function nameFromBox(aliasId, gids) {
  for (const gid of gids.slice(0, 3)) {
    const r = await gqlSpectator(gid);
    if (!r || !r.ok) continue;
    const sides = [r.game?.statistics?.home?.players || [], r.game?.statistics?.away?.players || []];
    for (const side of sides) {
      for (const p of side) {
        const pid = String(p.profileID || '');
        if (!pid) continue;                       // a "Fill-in" row carries NO id
        if (pid === aliasId || pid.slice(0, TRUNC_LEN) === aliasId) {
          const nm = String(p.name || '').trim();
          if (nm) return { name: nm, gid };
        }
      }
    }
  }
  return null;
}

async function main() {
  console.log('probe-alias-names [READ-ONLY] — ' + (ALL ? 'every unresolved alias' : 'sample=' + SAMPLE));

  // ── 1. The population: unsupported, with NO repoint available ─────────────
  let audit;
  try { audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'alias-credit-audit.json'), 'utf8')); }
  catch (e) { console.error('ABORT: reports/alias-credit-audit.json not readable — ' + e.message); process.exit(1); }
  let pop = (audit.unsupportedEntries || []).filter(x => x && x.id && x.target && !x.correctTarget);
  console.log('  unsupported in the audit          : ' + n((audit.unsupportedEntries || []).length));
  console.log('  of those, NO repoint available    : ' + n(pop.length) + '   ← the population the credit test could not settle');

  // Resume: anything already judged is not asked again.
  let prior = {};
  try { prior = JSON.parse(fs.readFileSync(REPORT, 'utf8')).verdicts || {}; } catch (e) {}
  if (Object.keys(prior).length) console.log('  already judged in a previous run  : ' + n(Object.keys(prior).length));
  pop = pop.filter(x => !prior[x.id]);
  if (!ALL) pop = pop.slice(0, SAMPLE);
  console.log('  asking PlayHQ about              : ' + n(pop.length));
  console.log('  concurrency ' + CONCURRENCY + ' (spectator endpoint — deliberately low)');
  console.log('');

  // ── 2. The name each alias target carries ─────────────────────────────────
  const nameOf = (uuid) => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'players', uuid.slice(0, 2), uuid + '.json'), 'utf8')).name || null; }
    catch (e) { return null; }
  };

  // Count how many player files carry each name, once. It is what tells a settled
  // same-name verdict from an unsettleable one.
  const nameCount = new Map();
  {
    const pd = path.join(ROOT, 'players');
    for (const sh of fs.readdirSync(pd)) {
      const dir = path.join(pd, sh);
      let st; try { st = fs.statSync(dir); } catch (e) { continue; }
      if (!st.isDirectory() || sh === 'aliases' || sh === 'indexes') continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const nm = normName(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).name);
          if (nm) nameCount.set(nm, (nameCount.get(nm) || 0) + 1);
        } catch (e) {}
      }
    }
    console.log('  distinct player names indexed     : ' + n(nameCount.size));
  }

  const verdicts = { ...prior };
  let same = 0, diff = 0, noName = 0, done = 0, sinceSave = 0;
  for (const v of Object.values(prior)) {
    if (v.verdict === 'same') same++; else if (v.verdict === 'different') diff++; else noName++;
  }

  for (let i = 0; i < pop.length; i += CONCURRENCY) {
    const chunk = pop.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (c) => {
      const target = nameOf(c.target);
      const got = await nameFromBox(c.id, c.gids || []);
      if (!got)          { verdicts[c.id] = { verdict: 'no-name', target: c.target, targetName: target }; noName++; return; }
      if (!target)       { verdicts[c.id] = { verdict: 'no-name', target: c.target, playhqName: got.name, why: 'no player file for the target' }; noName++; return; }
      const agree = normName(got.name) === normName(target);
      // How many players in OUR store carry this name? A name shared by several is
      // one a name test can never settle — the Jida shape.
      const shared = nameCount.get(normName(got.name)) || 0;
      verdicts[c.id] = { verdict: agree ? 'same' : 'different', target: c.target,
                         targetName: target, playhqName: got.name, gid: got.gid,
                         playersWithThisName: shared };
      if (agree) same++; else diff++;
    }));
    done += chunk.length;
    sinceSave += chunk.length;
    if (sinceSave >= SAVE_EVERY) {
      sinceSave = 0;
      atomicWrite(REPORT, { generated: new Date().toISOString(), partial: true, verdicts });
      commitReport(done + ' judged so far');
    }
    if (done % 25 < chunk.length) console.log('  … ' + n(done) + '/' + n(pop.length) + '  same ' + n(same) + ' · DIFFERENT ' + n(diff) + ' · no name ' + n(noName));
  }

  atomicWrite(REPORT, { generated: new Date().toISOString(), partial: false, verdicts });

  const judged = same + diff;
  console.log('');
  console.log('  ══ WHO DOES PLAYHQ SAY THIS ID IS? ════════════════════════════════');
  console.log('    NAME AGREES with the alias target: ' + n(same) + '  (' + pct(same, judged) + '% of judged)');
  console.log('      → NO CONTRADICTION FOUND. This is NOT proof the alias is right:');
  console.log('        the Jida McCrae-Cooper error was a SAME-NAME case, where two');
  console.log('        PlayHQ profiles carry the name and the alias picked the wrong');
  console.log('        one. See the split below.');
  console.log('    NAME DISAGREES                   : ' + n(diff) + '  (' + pct(diff, judged) + '% of judged)');
  console.log('      → DECISIVE. PlayHQ calls this id somebody else, so those');
  console.log('        appearances are on the wrong player.');
  console.log('    no name available                : ' + n(noName) + '   ← no verdict, never counted against the alias');
  const sameUnique = Object.values(verdicts).filter(v => v.verdict === 'same' && v.playersWithThisName === 1).length;
  const sameShared = Object.values(verdicts).filter(v => v.verdict === 'same' && v.playersWithThisName > 1).length;
  console.log('');
  console.log('    OF THE NAME-AGREES GROUP — this is the split that matters:');
  console.log('      only ONE player carries that name : ' + n(sameUnique) + '   ← SETTLED, there is nobody else it could be');
  console.log('      SEVERAL players carry that name   : ' + n(sameShared) + '   ← STILL UNRESOLVED, the Jida shape');
  console.log('');
  const bad = Object.entries(verdicts).filter(([, v]) => v.verdict === 'different');
  for (const [id, v] of bad.slice(0, 40)) {
    console.log('    WRONG  ' + id + ' -> ' + v.target);
    console.log('        alias says : ' + JSON.stringify(v.targetName));
    console.log('        PlayHQ says: ' + JSON.stringify(v.playhqName) + '   (game ' + v.gid + ')');
  }
  if (bad.length > 40) console.log('    … and ' + n(bad.length - 40) + ' more');
  console.log('');
  console.log('  WRITTEN: reports/alias-name-audit.json');
  commitReport(same + ' same, ' + diff + ' different, ' + noName + ' no name');
}

main()
  .then(async () => { await sleep(300); process.exit(0); })
  .catch(async (e) => { console.error('FATAL:', e.message); await sleep(300); process.exit(1); });
