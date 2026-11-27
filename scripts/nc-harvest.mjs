// nc-harvest.mjs (Playwright) — harvest 9U competition results incl per-quarter scores.
// Concurrent, two-phase, polite. All calls run inside a Chromium page (WAF gate); token from
// localStorage; no credentials. gameSummary needs a non-empty competitionUniqueKey but returns
// each match's real competition regardless, so we filter by competitionName.
//
// WHY A SCAN: a comp's matches sit in several id blocks (created per weekly batch), scattered
// across the national id space. round/matches only seeds the recent/visible rounds, so earlier
// rounds are found by a coarse scan over [SCAN_LO..SCAN_HI], then each hit is expanded to grab
// its whole block. Fetches run CONC at a time (with a small delay between batches) so a wide scan
// completes inside the job timeout without hammering the API.
//
// MULTI-COMP: set COMP_NAMES to a comma-separated list to collect several competitions from one
// scan pass (any whose matches fall in the scanned id range). One matches-<compId>.json per comp.
// COMP_ID/COMP_KEY/COMP_NAME remain the "primary": used for round/matches seeds + the gameSummary key.
//
// Phase 1: collect match ids (round/matches seeds + expand, + coarse scan). Phase 2: periodScores.
// Flushes each matches-<compId>.json periodically so a timeout never loses data.
//
// Env: COMP_ID, COMP_KEY, COMP_NAME, COMP_NAMES (optional comma list, defaults to COMP_NAME),
//   ORG_KEY, BOOT_KEY, SCAN_LO, SCAN_HI, COARSE_STEP (default 6), CONC (default 8),
//   BATCH_DELAY ms between batches (default 120), GAP (default 60), MAX_CALLS (default 60000), OUT_DIR.
// Exit 0 ran / 1 boot/token / 3 crash.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://registration.netballconnect.com';
const LIVE = 'https://api-netball.squadi.com/livescores';
const ORG_KEY = (process.env.ORG_KEY || 'ab63c5b3-fd1a-41a6-a1a2-326989b20247').trim();
const COMP_ID = (process.env.COMP_ID || '5232').trim();
const COMP_KEY = (process.env.COMP_KEY || '8819433a-2375-4c6a-9039-4658036b083d').trim();
const COMP_NAME = (process.env.COMP_NAME || 'MENA - Club Competition SPRING FRI 9 & U NETSETGO').trim();
const COMP_NAMES = (process.env.COMP_NAMES || COMP_NAME).split(',').map((s) => s.trim()).filter(Boolean);
const NAME_SET = new Set(COMP_NAMES);
const BOOT_KEY = (process.env.BOOT_KEY || COMP_KEY).trim();
const SCAN_LO = parseInt(process.env.SCAN_LO || '0', 10);
const SCAN_HI = parseInt(process.env.SCAN_HI || '0', 10);
const COARSE_STEP = parseInt(process.env.COARSE_STEP || '6', 10);
const CONC = parseInt(process.env.CONC || '8', 10);
const BATCH_DELAY = parseInt(process.env.BATCH_DELAY || '120', 10);
const GAP = parseInt(process.env.GAP || '60', 10);
const MAX_CALLS = parseInt(process.env.MAX_CALLS || '60000', 10);
const OUT = process.env.OUT_DIR || 'harvest-out';
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || '';
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT || '20000', 10); // abort a single stalled fetch (ms)
const BATCH_TIMEOUT = parseInt(process.env.BATCH_TIMEOUT || '60000', 10); // hard cap per batch so a hung page can never stall the run (ms)
// SURVEY mode: coarse-scan [SCAN_LO..SCAN_HI] with NO name filter, tally every competition seen
// (id range + date range) so finished/hidden comps can be located. No expand, no periodScores.
const SURVEY = /^(1|true|yes|on)$/i.test((process.env.SURVEY || '').trim());
// PROBE mode: diagnostic gameSummary scoping test. PROBE_IDS = comma match ids; KEYS = comma comp keys.
const PROBE_IDS = (process.env.PROBE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const KEYS = (process.env.KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
// RAW mode: dump raw bodies of arbitrary endpoints (;;-separated) for structure inspection.
const RAW_URLS = (process.env.RAW_URLS || '').split(';;').map((s) => s.trim()).filter(Boolean);
const RAW_MAX = parseInt(process.env.RAW_MAX || '80000', 10); // RAW: bytes of each body kept (length always records the full size)
// USER_SCAN mode: scan a userId range on /stats/v2/summaryScoringByUser (public), keep netball
// players, bucket by team. COMP_FILTER = optional comma comp-ids to keep (e.g. the 9U comps).
const USER_LO = parseInt(process.env.USER_LO || '0', 10);
const USER_HI = parseInt(process.env.USER_HI || '0', 10);
const USER_CENTER = parseInt(process.env.USER_CENTER || '0', 10);
const USER_RADIUS = parseInt(process.env.USER_RADIUS || '0', 10);
const SPORT_REF = parseInt(process.env.SPORT_REF || '1', 10);
const COMP_FILTER = new Set((process.env.COMP_FILTER || '').split(',').map((s) => s.trim()).filter(Boolean));
const RUN_BUDGET_MIN = parseInt(process.env.RUN_BUDGET_MIN || '0', 10); // wall-clock stop (0 = off)
const BACKOFF_MIN = parseInt(process.env.BACKOFF_MIN || '10', 10);      // WAF pause, lengthens per break
const TEST_ID = parseInt(process.env.TEST_ID || '15890707', 10);        // known-good id for recovery test
// USER_IDS mode (variant of USER_SCAN): fetch an EXACT list of userIds instead of a range. Source:
// USER_IDS_FILE (set by the workflow after downloading a previous run's artifact) else USER_IDS =
// a path to a .json file (users-scan.json shape players[].userId, or a plain array) or comma ids.
// Output users-careers.json = each user's FULL comp history (no comp filter unless COMP_FILTER set).
// Names are never stored in this mode. Failed fetches are retried; if any still fail, only
// users-careers_PARTIAL.json is written so a failed collection never looks like a complete one.
const USER_IDS_SRC = (process.env.USER_IDS_FILE || process.env.USER_IDS || '').trim();
// FULL_HISTORY (USER_SCAN): every kept player's FULL netball history is stored (all comps), names never.
// With COMP_FILTER, the filter decides WHO is kept; without it, EVERY netball player in the range is kept. Failed ids are tracked + retried like USER_IDS mode; output
// users-history.json only when complete, else users-history_PARTIAL.json.
const FULL_HISTORY = /^(1|true|yes|on)$/i.test((process.env.FULL_HISTORY || '').trim());

let calls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => (s || 'unknown').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase();
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
// schema confirm: keys + raw matchData of the first recorded hit (so we verify field names, not guess)
let schemaSample = null;
const firstVal = (o, keys) => { for (const k of keys) { const v = o && o[k]; if (v != null && v !== '' && typeof v !== 'object') return v; } return ''; };
const objVal = (o, keys, prop) => { for (const k of keys) { const v = o && o[k]; if (v && typeof v === 'object' && v[prop] != null) return v[prop]; } return ''; };

async function loadUserIds() {
  if (!USER_IDS_SRC) return null;
  let ids = [], src;
  if (/\.json$/i.test(USER_IDS_SRC)) {
    src = `file ${USER_IDS_SRC}`;
    const j = JSON.parse((await fs.readFile(USER_IDS_SRC, 'utf8')).replace(/^\uFEFF/, ''));
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.players) ? j.players : null);
    if (!arr) throw new Error(`USER_IDS file has no players[] or top-level array: ${USER_IDS_SRC}`);
    ids = arr.map((x) => (x && typeof x === 'object' ? x.userId : x));
  } else {
    src = 'inline list';
    ids = USER_IDS_SRC.split(/[\s,;]+/);
  }
  ids = [...new Set(ids.map((x) => parseInt(String(x), 10)).filter((n) => Number.isFinite(n) && n > 0))];
  // Squadi userIds are ~8 digits; a 10+ digit number is a GitHub run id typed without the run: prefix.
  const runLike = ids.filter((n) => n >= 1e9);
  if (runLike.length) throw new Error(`${runLike.join(',')} looks like a GitHub run id, not a userId — enter it as run:${runLike[0]}`);
  return { ids, src };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  let EXPLICIT = null;
  if (USER_IDS_SRC) {
    try { EXPLICIT = await loadUserIds(); } catch (e) { EXPLICIT = { ids: [], src: USER_IDS_SRC, err: e.message || String(e) }; }
    if (!EXPLICIT.ids.length) {
      const o = `# User ids\n\n**FAILED: no usable userIds from ${EXPLICIT.src}${EXPLICIT.err ? ` (${EXPLICIT.err})` : ''}**\n`;
      await fs.writeFile(path.join(OUT, 'SUMMARY.md'), o); if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, o); console.log(o); process.exit(1);
    }
    log(`USER_IDS: ${EXPLICIT.ids.length} distinct userIds from ${EXPLICIT.src}`);
  }
  const FULL = FULL_HISTORY && !EXPLICIT;
  const KEEP_ALL = FULL && !COMP_FILTER.size;   // full_history with no comp_filter: keep every netball player found
  const TRACK = !!EXPLICIT || FULL;   // track + retry failed ids, no names stored
  const notes = [];
  log(`mode: ${SURVEY ? 'SURVEY (locate comps, no harvest)' : 'HARVEST'}`);
  log(`config: primary comp ${COMP_ID} "${COMP_NAME}"`);
  log(`collecting ${COMP_NAMES.length} comp name(s): ${COMP_NAMES.map((n) => `"${n}"`).join(', ')}`);
  log(`scan ${SCAN_LO}..${SCAN_HI} step ${COARSE_STEP} | conc ${CONC} delay ${BATCH_DELAY}ms gap ${GAP} maxCalls ${MAX_CALLS}`);
  const browser = await chromium.launch();
  const found = new Map();           // id -> record (carries compId, compName)
  const visited = new Set();
  let capped = false;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();
    let loadStatus = null;
    try { const r = await page.goto(`${SITE}/livescoreSeasonFixture?yearId=8&organisationKey=${ORG_KEY}&competitionUniqueKey=${BOOT_KEY}&divisionId=All`, { waitUntil: 'networkidle', timeout: 60000 }); loadStatus = r ? r.status() : null; } catch (e) { return fail(browser, `boot load failed: ${e.message || e}`); }
    await page.waitForTimeout(6000);
    const tokenLen = await page.evaluate(() => (localStorage.getItem('token') || '').length);
    if (!tokenLen) return fail(browser, `no token after boot (HTTP ${loadStatus})`);
    log(`booted, token ok (HTTP ${loadStatus})`);

    // Each fetch is aborted after FETCH_TIMEOUT so one stalled request can't wedge the batch; the whole
    // batch is additionally raced against BATCH_TIMEOUT, so even a dead/hung page returns (as status 0s)
    // instead of blocking forever — the earlier bug that let a hang sit idle until the job timeout.
    const batchGet = async (urls) => {
      calls += urls.length;
      const evalP = page.evaluate(async ({ list, ft }) => {
        const tok = localStorage.getItem('token') || '';
        return Promise.all(list.map(async (u) => {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), ft);
          try { const r = await fetch(u.url, { headers: { accept: 'application/json', authorization: tok }, signal: ctrl.signal }); const body = await r.text(); clearTimeout(to); return { id: u.id, status: r.status, body }; }
          catch (e) { clearTimeout(to); return { id: u.id, status: 0, body: '' }; }
        }));
      }, { list: urls, ft: FETCH_TIMEOUT }).catch(() => null);
      let res;
      try {
        res = await Promise.race([evalP, new Promise((resolve) => setTimeout(() => resolve(null), BATCH_TIMEOUT))]);
      } catch (e) { res = null; }
      if (!Array.isArray(res)) res = urls.map((u) => ({ id: u.id, status: 0, body: '' }));
      if (BATCH_DELAY > 0) await sleep(BATCH_DELAY);
      return res;
    };

    // RAW: diagnostic. Fetch each URL in RAW_URLS (;;-separated; relative paths resolve against the
    // squadi api host) and dump raw bodies to raw.json. For inspecting endpoint structure/fields.
    if (RAW_URLS.length) {
      log(`RAW dump of ${RAW_URLS.length} url(s)`);
      const out = [];
      for (const u of RAW_URLS) {
        const url = /^https?:\/\//i.test(u) ? u : `https://api-netball.squadi.com${u.startsWith('/') ? '' : '/'}${u}`;
        const r = (await batchGet([{ id: 0, url }]))[0];
        out.push({ url, status: r.status, length: (r.body || '').length, body: (r.body || '').slice(0, RAW_MAX) });
        log(`[${r.status}] len ${(r.body || '').length} — ${url}`);
      }
      await fs.writeFile(path.join(OUT, 'raw.json'), JSON.stringify(out, null, 1));
      await writeSummary(['# Raw endpoint dump', '', ...out.map((o) => `- [${o.status}] len ${o.length} — ${o.url}`)]);
      await browser.close();
      process.exit(0);
    }

    // USER_SCAN: scan userIds on the public summaryScoringByUser endpoint, keep netball players,
    // bucket by team. Order: outward from USER_CENTER (±USER_RADIUS) so the densest/known region is
    // covered first; else linear USER_LO..USER_HI. Unattended-safe: wall-clock RUN_BUDGET_MIN stop,
    // flush every 10 batches, and WAF backoff — on a mostly-403/0/503 batch, flush + pause
    // BACKOFF_MIN*attempt minutes (capped 30), run one known-good test, retry the slice on recovery,
    // give up after 6 breaks. Names are null for 9U; isHidden carried through when present.
    if (EXPLICIT || (USER_CENTER > 0 && USER_RADIUS > 0) || (USER_LO && USER_HI && USER_HI >= USER_LO)) {
      const order = [];
      if (EXPLICIT) { order.push(...EXPLICIT.ids); }
      else if (USER_CENTER > 0 && USER_RADIUS > 0) { order.push(USER_CENTER); for (let d = 1; d <= USER_RADIUS; d++) { if (USER_CENTER + d > 0) order.push(USER_CENTER + d); if (USER_CENTER - d > 0) order.push(USER_CENTER - d); } }
      else { for (let id = USER_LO; id <= USER_HI; id++) order.push(id); }
      const LABEL = EXPLICIT ? `explicit ${EXPLICIT.ids.length} ids (${EXPLICIT.src})` : (USER_CENTER > 0 ? `center ${USER_CENTER} +/-${USER_RADIUS}` : `${USER_LO}..${USER_HI}`);
      log(`USER_SCAN ${LABEL} sport ${SPORT_REF}${COMP_FILTER.size ? ` filter ${[...COMP_FILTER].join(',')}` : ''} budget ${RUN_BUDGET_MIN || 'inf'}m backoff ${BACKOFF_MIN}m — ${order.length} ids`);
      const players = [];
      const rosters = new Map(); // teamId -> {..., userIds:Set}
      const total = order.length, CHUNK = 400, t0 = Date.now();
      const budgetMs = RUN_BUDGET_MIN > 0 ? RUN_BUDGET_MIN * 60000 : 0;
      let done = 0, batchNo = 0, stop = false, stopReason = '';
      const buildRosterOut = () => [...rosters.values()].map((r) => ({ teamId: r.teamId, teamName: r.teamName, competitionId: r.competitionId, competitionName: r.competitionName, divisionName: r.divisionName, players: r.userIds.size, userIds: [...r.userIds] })).sort((a, b) => b.players - a.players);
      // explicit mode: failedIds = non-200/unparseable (retried at the end); emptyIds = 200 but no rows.
      const failedIds = new Set(), emptyIds = new Set();
      let rowSchema = null;
      // explicit mode flushes to the _PARTIAL name; the clean name is written only after a complete run.
      let outName = EXPLICIT ? 'users-careers_PARTIAL.json' : (FULL ? 'users-history_PARTIAL.json' : 'users-scan.json');
      let emptyCount = 0;
      const seenIds = new Set();
      const writeUsers = async () => { await fs.writeFile(path.join(OUT, outName), JSON.stringify({ label: LABEL, center: USER_CENTER || null, radius: USER_RADIUS || null, lo: USER_LO || null, hi: USER_HI || null, scanned: done, found: players.length, teams: rosters.size, calls, elapsedMin: Math.round((Date.now() - t0) / 60000), ...(EXPLICIT ? { requested: order.length, failedIds: [...failedIds], emptyIds: [...emptyIds], rowSchema } : {}), ...(FULL ? { fullHistory: true, compFilter: [...COMP_FILTER], failedIds: [...failedIds], rowSchema } : {}), players, rosters: buildRosterOut() }, null, FULL ? 0 : 1)); };
      const testUrl = `${LIVE}/stats/v2/summaryScoringByUser?userId=${TEST_ID}&playerId=&aggregate=CAREER&sportRefId=${SPORT_REF}`;
      const recover = async () => {
        for (let attempt = 1; attempt <= 6; attempt++) {
          const mins = Math.min(BACKOFF_MIN * attempt, 30);
          log(`WAF block suspected — flush + pause ${mins}m (break ${attempt}/6) @ ${calls} calls`);
          await writeUsers();
          await sleep(mins * 60000);
          if (budgetMs && Date.now() - t0 > budgetMs) return false;
          const t = (await batchGet([{ id: TEST_ID, url: testUrl }]))[0];
          let ok = false; try { const a = JSON.parse(t.body); ok = t.status === 200 && Array.isArray(a) && a.length > 0; } catch {}
          if (ok) { log(`recovered after ${attempt} break(s)`); return true; }
          log(`still blocked (test status ${t.status})`);
        }
        return false;
      };
      let i = 0;
      while (i < order.length && calls < MAX_CALLS && !stop) {
        if (budgetMs && Date.now() - t0 > budgetMs) { stopReason = `run budget ${RUN_BUDGET_MIN}m`; log(stopReason + ' reached'); break; }
        const slice = order.slice(i, i + CHUNK);
        const res = await batchGet(slice.map((id) => ({ id, url: `${LIVE}/stats/v2/summaryScoringByUser?userId=${id}&playerId=&aggregate=CAREER&sportRefId=${SPORT_REF}` })));
        const blocked = res.filter((r) => r.status === 403 || r.status === 0 || r.status === 503).length;
        if (blocked > res.length * 0.5) { if (await recover()) continue; stop = true; stopReason = 'WAF unrecovered'; break; }
        absorb(res);
        i += CHUNK; done += slice.length;
        if (++batchNo % (FULL ? 50 : 10) === 0) await writeUsers();
        if (batchNo % 5 === 0) log(`userscan ${done}/${total} (${Math.round(done / total * 100)}%, ${Math.round((Date.now() - t0) / 60000)}m) — ${players.length} players, ${rosters.size} teams, ${calls} calls`);
      }
      // explicit mode: retry failures (up to 3 passes, small slices, with a pause between passes)
      for (let pass = 1; TRACK && !stop && failedIds.size && pass <= 3; pass++) {
        const retry = [...failedIds];
        log(`retry pass ${pass}: ${retry.length} failed id(s)`);
        await sleep(pass * 20000);
        for (let k = 0; k < retry.length; k += 50) {
          const sl = retry.slice(k, k + 50);
          sl.forEach((id) => failedIds.delete(id));
          absorb(await batchGet(sl.map((id) => ({ id, url: `${LIVE}/stats/v2/summaryScoringByUser?userId=${id}&playerId=&aggregate=CAREER&sportRefId=${SPORT_REF}` }))));
        }
      }
      if (TRACK && (i < order.length || stop)) for (const id of order.slice(i)) failedIds.add(id); // never-fetched ids count as failed
      function absorb(res) {
        for (const r of res) {
          if (r.status !== 200) { if (TRACK) failedIds.add(r.id); continue; }
          let arr = null; try { arr = JSON.parse(r.body); } catch { if (TRACK) failedIds.add(r.id); continue; }
          if (!Array.isArray(arr)) { if (TRACK) failedIds.add(r.id); continue; }
          if (!arr.length) { if (EXPLICIT) emptyIds.add(r.id); else emptyCount++; continue; }
          const keepAll = FULL && (KEEP_ALL || arr.some((x) => COMP_FILTER.has(String(x.competitionId))));
          if (FULL && !keepAll) continue;
          if (TRACK && !rowSchema) { const s0 = arr.find((x) => String(x.competitionId) !== '-1') || arr[0]; rowSchema = Object.keys(s0 || {}); }
          const comps = [];
          let isHidden = null, firstName = null, lastName = null;
          for (const row of arr) {
            if (String(row.competitionId) === '-1') continue; // skip the Career total row
            if (COMP_FILTER.size && !keepAll && !COMP_FILTER.has(String(row.competitionId))) continue;
            comps.push({ competitionId: String(row.competitionId), competitionName: row.competitionName || '', teamId: row.teamId, teamName: row.teamName || '', divisionId: row.divisionId, divisionName: row.divisionName || '', games: row.games, ...(TRACK ? { isHidden: row.isHidden != null ? row.isHidden : null } : {}) });
            if (row.isHidden != null) isHidden = isHidden === true ? true : row.isHidden; // hidden on ANY row = hidden
            if (!TRACK && row.firstName) firstName = row.firstName; // names never stored in USER_IDS / full-history modes
            if (!TRACK && row.lastName) lastName = row.lastName;
          }
          if (!comps.length) { if (EXPLICIT) emptyIds.add(r.id); continue; }
          if (seenIds.has(r.id)) { const prev = players.findIndex((p) => p.userId === r.id); if (prev >= 0) players.splice(prev, 1); } // a retried id must not duplicate
          seenIds.add(r.id);
          players.push(TRACK ? { userId: r.id, isHidden, comps } : { userId: r.id, isHidden, firstName, lastName, comps });
          for (const c of comps) { if (c.teamId == null) continue; if (FULL && !COMP_FILTER.has(c.competitionId)) continue; /* rosters: filtered comps only */ const k = String(c.teamId); let ro = rosters.get(k); if (!ro) { ro = { teamId: c.teamId, teamName: c.teamName, competitionId: c.competitionId, competitionName: c.competitionName, divisionName: c.divisionName, userIds: new Set() }; rosters.set(k, ro); } ro.userIds.add(r.id); }
        }
      }
      if (calls >= MAX_CALLS && !stopReason) stopReason = 'MAX_CALLS';
      await writeUsers();
      // explicit mode: zero players with rows is never a success (wrong ids / wrong list), so it stays PARTIAL and exits 1.
      // range scan (FULL): a range with no netball players is a valid result (e.g. past the newest ids). Every
      // non-200 / unparseable / never-fetched id is in failedIds, so no failures + no stop = every id answered.
      const complete = FULL ? (!failedIds.size && !stopReason)
        : (!EXPLICIT || (!failedIds.size && !stopReason && players.length > 0 && players.length + emptyIds.size === order.length));
      if (EXPLICIT && complete) { outName = 'users-careers.json'; await writeUsers(); await fs.rm(path.join(OUT, 'users-careers_PARTIAL.json'), { force: true }); }
      if (FULL && complete) { outName = 'users-history.json'; await writeUsers(); await fs.rm(path.join(OUT, 'users-history_PARTIAL.json'), { force: true }); }
      const byFilterComp = {};
      if (FULL) for (const p of players) for (const c of p.comps) if (COMP_FILTER.has(c.competitionId)) byFilterComp[c.competitionId + ' ' + c.competitionName] = (byFilterComp[c.competitionId + ' ' + c.competitionName] || 0) + 1;
      const rosterOut = buildRosterOut();
      const byComp = {};
      for (const p of players) for (const c of p.comps) byComp[c.competitionName] = (byComp[c.competitionName] || 0) + 1;
      const lines = [`# User ${EXPLICIT ? 'careers' : 'scan'} ${LABEL} (sport ${SPORT_REF})`, '',
        ...(EXPLICIT ? [complete ? `- **COMPLETE** — all ${order.length} ids fetched → users-careers.json` : (players.length === 0 && !failedIds.size ? `- **FAILED** — no id returned any netball rows (wrong id list?) → users-careers_PARTIAL.json only` : `- **PARTIAL** — ${failedIds.size} id(s) failed/unfetched → users-careers_PARTIAL.json only (re-run)`),
          `- with rows: ${players.length}; returned empty: ${emptyIds.size}; failed: ${failedIds.size}`,
          `- row fields: ${rowSchema ? rowSchema.join(', ') : '(none)'}`, ''] : []),
        ...(FULL ? [complete ? `- **COMPLETE** — no failed ids → users-history.json (${(await fs.stat(path.join(OUT, 'users-history.json'))).size} bytes; full history for ${KEEP_ALL ? 'EVERY netball player in range' : 'players in ' + [...COMP_FILTER].join(',')})` : `- **PARTIAL** — ${failedIds.size} id(s) failed/unfetched${stopReason ? `, stopped: ${stopReason}` : ''} → users-history_PARTIAL.json only (re-run)`,
          `- empty ids: ${emptyCount}; failed: ${failedIds.size}`, '', '## players per filter competition', '', '| competition | players |', '|---|---|',
          ...(KEEP_ALL ? ['| (no comp_filter: every player kept) | ' + players.length + ' |'] : []), ...Object.entries(byFilterComp).sort().map(([n, c]) => `| ${n.replace(/\|/g, '/')} | ${c} |`), ''] : []),
        `- scanned ${done} ids in ${calls} calls over ${Math.round((Date.now() - t0) / 60000)} min${stopReason ? ` **(stopped: ${stopReason})**` : ''}`,
        `- netball players found: ${players.length} (hit rate ${(players.length / Math.max(1, done) * 100).toFixed(2)}%)`,
        `- distinct teams: ${rosters.size}`, '',
        '## players per competition', '', '| competition | player-rows |', '|---|---|',
        ...Object.entries(byComp).sort((a, b) => b[1] - a[1]).filter(([n], k) => k < 40 || /MENA/i.test(n)).map(([n, c]) => `| ${(n || '(none)').replace(/\|/g, '/')} | ${c} |`),
        ...(Object.keys(byComp).length > 40 ? [`| (${Object.keys(byComp).length} competitions in total; top 40 + all MENA shown) | |`] : []), '',
        '## biggest team buckets', '', '| teamId | team | comp | players |', '|---|---|---|---|',
        ...rosterOut.slice(0, 40).map((r) => `| ${r.teamId} | ${(r.teamName || '').replace(/\|/g, '/')} | ${r.competitionId} | ${r.players} |`)];
      await writeSummary(lines);
      await browser.close();
      process.exit(complete ? 0 : 1);
    }

    // PROBE: diagnostic. For each PROBE_IDS x each KEYS, fetch gameSummary and report status +
    // competitionName; also keyless periodScores length. Answers: is gameSummary scoped to the key?
    if (PROBE_IDS.length) {
      const keys = KEYS.length ? KEYS : [COMP_KEY];
      log(`PROBE ${PROBE_IDS.length} id(s) x ${keys.length} key(s)`);
      const rows = [];
      for (const id of PROBE_IDS) {
        for (const k of keys) {
          const r = (await batchGet([{ id, url: `${LIVE}/matches/public/gameSummary?matchId=${id}&competitionUniqueKey=${k}` }]))[0];
          let name = '', keysSeen = ''; try { const j = JSON.parse(r.body); const md = j && j.matchData; if (md) { name = md.competitionName || ''; keysSeen = Object.keys(md).join(' '); } } catch {}
          rows.push({ id, key: k.slice(0, 8), status: r.status, name, keysSeen });
        }
        const ps = (await batchGet([{ id, url: `${LIVE}/matches/periodScores?matchId=${id}` }]))[0];
        let plen = 'err'; try { const a = JSON.parse(ps.body); plen = Array.isArray(a) ? String(a.length) : 'non-array'; } catch {}
        rows.push({ id, key: '(periodScores, no key)', status: ps.status, name: `periods=${plen}`, keysSeen: '' });
      }
      await fs.writeFile(path.join(OUT, 'probe.json'), JSON.stringify(rows, null, 1));
      const lines = ['# Probe — gameSummary key scoping', '', `| matchId | key | status | competitionName / periods |`, `|---|---|---|---|`,
        ...rows.map((r) => `| ${r.id} | ${r.key} | ${r.status} | ${(r.name || '').replace(/\|/g, '/')} |`), '',
        `matchData keys (first non-empty): ${(rows.find((r) => r.keysSeen) || {}).keysSeen || '(none)'}`];
      await writeSummary(lines);
      await browser.close();
      process.exit(0);
    }

    // SURVEY: locate every competition in a range (no name filter, no expand, no periodScores)
    if (SURVEY) {
      if (!(SCAN_LO && SCAN_HI && SCAN_HI > SCAN_LO)) return fail(browser, 'SURVEY needs SCAN_LO and SCAN_HI');
      const comps = new Map(); // competitionName -> {name, compId, count, idLo, idHi, dateLo, dateHi}
      const sample = [];
      for (let id = SCAN_LO; id <= SCAN_HI; id += COARSE_STEP) sample.push(id);
      log(`SURVEY ${SCAN_LO}..${SCAN_HI} step ${COARSE_STEP} — ${sample.length} sample ids`);
      const CHUNK = 600;
      for (let i = 0; i < sample.length && calls < MAX_CALLS; i += CHUNK) {
        const chunk = sample.slice(i, i + CHUNK).filter((id) => id > 0);
        const res = await batchGet(chunk.map((id) => ({ id, url: `${LIVE}/matches/public/gameSummary?matchId=${id}&competitionUniqueKey=${COMP_KEY}` })));
        for (const r of res) {
          if (r.status !== 200) continue;
          let j = null; try { j = JSON.parse(r.body); } catch { continue; }
          const md = j && j.matchData; if (!md || !md.competitionName) continue;
          const d = (md.startTime || '').slice(0, 10);
          let c = comps.get(md.competitionName);
          if (!c) { c = { name: md.competitionName, compId: md.competitionId != null ? String(md.competitionId) : '', count: 0, idLo: r.id, idHi: r.id, dateLo: d || '', dateHi: d || '' }; comps.set(md.competitionName, c); }
          c.count++; c.idLo = Math.min(c.idLo, r.id); c.idHi = Math.max(c.idHi, r.id);
          if (d) { if (!c.dateLo || d < c.dateLo) c.dateLo = d; if (!c.dateHi || d > c.dateHi) c.dateHi = d; }
        }
        const done = Math.min(i + CHUNK, sample.length);
        log(`survey ${done}/${sample.length} (${Math.round(done / sample.length * 100)}%) — ${comps.size} comps, ${calls} calls`);
      }
      const list = [...comps.values()].sort((a, b) => a.idLo - b.idLo);
      await fs.writeFile(path.join(OUT, 'survey.json'), JSON.stringify({ range: [SCAN_LO, SCAN_HI], step: COARSE_STEP, calls, comps: list }, null, 1));
      const lines = [`# Survey ${SCAN_LO}..${SCAN_HI} (step ${COARSE_STEP})`, '', `- ${list.length} competitions seen in ${calls} api calls${calls >= MAX_CALLS ? ' **(MAX_CALLS hit)**' : ''}`, '',
        `| idLo | idHi | hits | dates | competition |`, `|---|---|---|---|---|`,
        ...list.map((c) => `| ${c.idLo} | ${c.idHi} | ${c.count} | ${c.dateLo}..${c.dateHi} | ${c.name.replace(/\|/g, '/')} |`)];
      await writeSummary(lines);
      await browser.close();
      process.exit(0);
    }

    const recordIfComp = (id, body) => {
      let j = null; try { j = JSON.parse(body); } catch { return false; }
      const md = j && j.matchData; if (!md || !NAME_SET.has(md.competitionName)) return false;
      if (!schemaSample) schemaSample = { fromMatchId: id, matchDataKeys: Object.keys(md), teamDataKeys: Object.keys(j.teamData || {}), sampleMatchData: md };
      const td = j.teamData || {};
      // division (= grade/pool) and round — probe likely field names defensively; verify via _schema.json
      const divisionId = firstVal(md, ['divisionId', 'competitionDivisionId', 'divisionGradeId']) || objVal(md, ['division', 'competitionDivision', 'grade'], 'id');
      const division = firstVal(md, ['divisionName', 'competitionDivisionName', 'gradeName']) || objVal(md, ['division', 'competitionDivision', 'grade'], 'name') || (typeof md.division === 'string' ? md.division : '');
      const round = firstVal(md, ['roundName', 'roundNumber', 'round', 'matchRound']) || objVal(md, ['round'], 'name') || objVal(md, ['round'], 'roundNumber');
      found.set(id, { id, compId: md.competitionId != null ? String(md.competitionId) : '', compName: md.competitionName,
        divisionId: divisionId !== '' ? String(divisionId) : '', division: division || '', round: round !== '' ? String(round) : '',
        startTime: md.startTime, status: md.matchStatus, venue: md.venueName, court: md.venueCourtName,
        team1: td.team1 && td.team1.name, team1Id: td.team1 && td.team1.id, team2: td.team2 && td.team2.name, team2Id: td.team2 && td.team2.id,
        t1: md.team1Score, t2: md.team2Score });
      return true;
    };

    const probeMany = async (ids) => {
      const todo = ids.filter((id) => !visited.has(id) && id > 0);
      const hits = [];
      for (let i = 0; i < todo.length && !capped; i += CONC) {
        if (calls >= MAX_CALLS) { capped = true; break; }
        const chunk = todo.slice(i, i + CONC);
        chunk.forEach((id) => visited.add(id));
        const res = await batchGet(chunk.map((id) => ({ id, url: `${LIVE}/matches/public/gameSummary?matchId=${id}&competitionUniqueKey=${COMP_KEY}` })));
        for (const r of res) if (r.status === 200 && recordIfComp(r.id, r.body)) hits.push(r.id);
      }
      return hits;
    };

    // walk one direction from an id in CONC-sized batches; stop after GAP consecutive misses
    const expandDir = async (fromId, dir) => {
      let miss = 0, cur = fromId;
      while (miss < GAP && !capped) {
        const batch = [];
        for (let k = 1; k <= CONC; k++) { const id = cur + dir * k; if (id > 0) batch.push(id); }
        if (!batch.length) break;
        const before = found.size;
        await probeMany(batch);
        cur += dir * CONC;
        if (found.size > before) miss = 0; else miss += CONC;
      }
    };
    const expandAround = async (seedIds) => {
      for (const id of [...new Set(seedIds)]) { if (capped) break; await expandDir(id, -1); await expandDir(id, 1); }
    };

    // group found records by competition and write one file per comp. gameSummary has no
    // competitionId and the key scopes the scan to one comp, so fall back to COMP_ID (not a slug).
    const groups = () => {
      const g = new Map();
      for (const r of found.values()) { const key = r.compId || COMP_ID || slug(r.compName); if (!g.has(key)) g.set(key, []); g.get(key).push(r); }
      return g;
    };
    const flush = async (phase) => {
      for (const [key, arr] of groups()) {
        arr.sort((a, b) => a.id - b.id);
        await fs.writeFile(path.join(OUT, `matches-${key}.json`), JSON.stringify({ compId: key, compName: arr[0].compName, harvestedAt: new Date().toISOString(), count: arr.length, phase, matches: arr }, null, 1));
      }
    };

    // Phase 1a: seeds from round/matches (primary comp) + expand. Also harvest the division (grade)
    // map and per-round team->division from the visible rounds (fallback for grade/regrade analysis).
    const rm = (await batchGet([{ id: 0, url: `${LIVE}/round/matches?competitionId=${COMP_ID}&divisionId=&teamIds=&ignoreStatuses=[1]` }]))[0];
    const seedIds = [];
    // SEED_IDS (comma list): known match ids of this comp (the weekly job passes the recent rounds from the
    // committed data), so the harvest still finds this week's games if round/matches returns nothing.
    const extraSeeds = (process.env.SEED_IDS || '').split(',').map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0);
    const divisionsFromRounds = {}; // divisionId -> name
    const roundDivisionTeams = [];  // {round, divisionId, division, matchId, team1Id, team2Id}
    try {
      const j = JSON.parse(rm.body);
      if (j && Array.isArray(j.rounds)) for (const r of j.rounds) {
        const rName = r.name != null ? String(r.name) : (r.roundNumber != null ? String(r.roundNumber) : '');
        for (const m of (r.matches || [])) {
          if (typeof m.id === 'number') seedIds.push(m.id);
          const dId = firstVal(m, ['divisionId', 'competitionDivisionId']) || objVal(m, ['division'], 'id');
          const dName = firstVal(m, ['divisionName']) || objVal(m, ['division'], 'name') || (typeof m.division === 'string' ? m.division : '');
          if (dId !== '' && dName) divisionsFromRounds[String(dId)] = dName;
          roundDivisionTeams.push({ round: rName, divisionId: dId !== '' ? String(dId) : '', division: dName || '',
            matchId: m.id, team1Id: m.team1 && m.team1.id, team2Id: m.team2 && m.team2.id });
        }
      }
    } catch {}
    const rmInfo = `round/matches HTTP ${rm.status}, ${(rm.body || '').length} bytes`;
    notes.push(`round/matches seeds: ${seedIds.length} (${rmInfo}); known-id seeds: ${extraSeeds.length}; divisions in visible rounds: ${Object.keys(divisionsFromRounds).length}`);
    log(`phase 1a: ${seedIds.length} seed ids from round/matches (${rmInfo}) + ${extraSeeds.length} known ids`);
    for (const id of extraSeeds) if (!seedIds.includes(id)) seedIds.push(id);
    if (seedIds.length) { await probeMany(seedIds); await expandAround(seedIds); await flush('ids'); log(`phase 1a done: ${found.size} matches so far`); }

    // Phase 1b: coarse scan
    if (SCAN_LO && SCAN_HI && SCAN_HI > SCAN_LO) {
      notes.push(`coarse scan ${SCAN_LO}..${SCAN_HI} step ${COARSE_STEP} conc ${CONC}`);
      const sample = [];
      for (let id = SCAN_LO; id <= SCAN_HI; id += COARSE_STEP) sample.push(id);
      log(`phase 1b: coarse scan — ${sample.length} sample ids to check`);
      const CHUNK = 600;
      for (let i = 0; i < sample.length && !capped; i += CHUNK) {
        const hits = await probeMany(sample.slice(i, i + CHUNK));
        if (hits.length) await expandAround(hits);
        await flush('ids');
        const done = Math.min(i + CHUNK, sample.length);
        log(`scan ${done}/${sample.length} (${Math.round(done / sample.length * 100)}%) — found ${found.size} matches, ${calls} api calls`);
      }
    }
    if (capped) { notes.push(`**MAX_CALLS ${MAX_CALLS} hit** — narrow range / raise cap to resume`); log(`CAPPED at MAX_CALLS ${MAX_CALLS}`); }

    // Phase 2: periodScores for every collected id
    const ids = [...found.keys()];
    log(`phase 2: per-quarter scores for ${ids.length} matches`);
    for (let i = 0; i < ids.length && !capped; i += CONC) {
      if (calls >= MAX_CALLS) { capped = true; break; }
      const chunk = ids.slice(i, i + CONC);
      const res = await batchGet(chunk.map((id) => ({ id, url: `${LIVE}/matches/periodScores?matchId=${id}` })));
      for (const r of res) { if (r.status !== 200) continue; let ps = null; try { ps = JSON.parse(r.body); } catch {} if (Array.isArray(ps)) found.get(r.id).periods = ps.map((p) => ({ q: p.period, t1: p.team1Score, t2: p.team2Score })); }
      if ((i / CONC) % 25 === 0) log(`periods ${Math.min(i + CONC, ids.length)}/${ids.length}`);
    }

    for (const r of found.values()) if (!r.periods) r.periods = [];
    await flush('complete');

    // reference outputs: schema confirm + visible-round division map (grade / regrade analysis)
    if (schemaSample) await fs.writeFile(path.join(OUT, '_schema.json'), JSON.stringify(schemaSample, null, 1));
    await fs.writeFile(path.join(OUT, `_divisions-${COMP_ID}.json`), JSON.stringify({ compId: COMP_ID, divisionsFromRounds, roundDivisionTeams }, null, 1));

    // summary: per-comp breakdown
    const lines = [`# Harvest — ${COMP_NAMES.length} competition(s)`, '', `- total matches ${found.size}; api calls ${calls}${capped ? ' **(CAPPED)**' : ''}`, ''];
    for (const [key, arr] of groups()) {
      arr.sort((a, b) => a.id - b.id);
      const scored = arr.filter((m) => (m.t1 || 0) || (m.t2 || 0));
      const withQ = arr.filter((m) => m.periods.length);
      const withDiv = arr.filter((m) => m.division);
      const dates = [...new Set(arr.map((m) => (m.startTime || '').slice(0, 10)).filter(Boolean))].sort();
      const divs = [...new Set(arr.map((m) => m.division).filter(Boolean))].sort();
      const blocks = [];
      for (const m of arr) { const last = blocks[blocks.length - 1]; if (last && m.id - last.hi <= GAP) last.hi = m.id; else blocks.push({ lo: m.id, hi: m.id }); }
      lines.push(`## ${arr[0].compName} (matches-${key}.json)`,
        `- matches ${arr.length} (scored ${scored.length}, byes/0-0 ${arr.length - scored.length}); per-quarter ${withQ.length}; with division/grade ${withDiv.length}`,
        `- divisions/grades seen (${divs.length}): ${divs.join(' | ') || '—'}`,
        `- game dates (${dates.length}): ${dates.join(', ') || '—'}`,
        `- id blocks ${blocks.length}: ${blocks.map((b) => b.lo === b.hi ? `${b.lo}` : `${b.lo}-${b.hi}`).join(', ')}`, '');
    }
    lines.push(`- gameSummary matchData keys: ${schemaSample ? schemaSample.matchDataKeys.join(', ') : '(none recorded)'}`);
    lines.push(`- notes: ${notes.join('; ')}`);
    await writeSummary(lines);
  } finally {
    await browser.close();
  }
  process.exit(0);

  async function writeSummary(linesArr) { const o = linesArr.join('\n') + '\n'; await fs.writeFile(path.join(OUT, 'SUMMARY.md'), o); if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, o); console.log(o); }
}
async function fail(browser, msg) { const o = `# Harvest ${COMP_ID}\n\n**FAILED: ${msg}**\n`; await fs.writeFile(path.join(OUT, 'SUMMARY.md'), o); if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, o); console.log(o); await browser.close(); process.exit(1); }

main().catch(async (e) => { console.error('UNEXPECTED', (e && e.stack) || e); try { await fs.writeFile(path.join(OUT, 'crash.txt'), String((e && e.stack) || e)); } catch {} process.exit(3); });
