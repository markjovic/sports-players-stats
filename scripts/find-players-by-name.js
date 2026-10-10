// scripts/find-players-by-name.js
//
// Takes a list of names and answers three questions about each, from data already
// on disk. No PlayHQ calls, no network.
//
//   1. Every team they have ever been registered to, and the season it was in.
//   2. Whether they have ever shared a game with a nominated player (default
//      Toby Jovic) — as an OPPONENT or as a TEAM-MATE, which are different facts
//      and are reported separately.
//   3. What gender we hold for them, as recorded on the player and as implied by
//      the grade they registered in.
//
// ⚠️ IT NEVER PICKS A PERSON. A name can belong to several players — 420,720 are
// on file — and choosing one silently is the failure this repository has spent
// months undoing (the alias campaign, OUTSTANDING_TASKS §4). Every candidate is
// listed with the rule that matched it, and the reader decides.
//
// ⚠️ A "no" ON THE OPPONENT QUESTION IS WEAK EVIDENCE. 442,939 appearances are
// known missing from our rosters (measured 2026-08-13). A shared game FOUND is
// strong; a shared game NOT found means "not on record", never "did not happen".
//
// Usage:
//   node scripts/find-players-by-name.js
//   node scripts/find-players-by-name.js --input=reports/name-search-input.json
//   node scripts/find-players-by-name.js --names="Smith, Jack
//   Brown, Ava"                                   # newline-separated, no file
//   node scripts/find-players-by-name.js --opponent=0afc7690
//   node scripts/find-players-by-name.js --commit    # commit the CSVs
//   node scripts/find-players-by-name.js --dry-run   # write nothing

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const DRY_RUN   = !!ARGS['dry-run'];
const DO_COMMIT = !!ARGS.commit;
const INPUT     = ARGS.input || 'reports/name-search-input.json';
const INLINE    = typeof ARGS.names === 'string' ? ARGS.names : null;
const OPP_ARG   = ARGS.opponent || null;

const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const SPORTS_IDX  = path.join(ROOT, 'data', 'sports-index.json');
const TEAM_IDX    = path.join(ROOT, 'data', 'team-index.json');
const OUT_TEAMS   = path.join(ROOT, 'reports', 'name-search.csv');
const OUT_VS      = path.join(ROOT, 'reports', 'name-search-vs-opponent.csv');
const OUT_MATES   = path.join(ROOT, 'reports', 'opponent-teammates.csv');

// resolveToFullUuid turns the 13-char truncated key used in team-stats rosters
// back into a real player file path. Same helper build-team-stats.js uses, so the
// truncation rules can never drift between the writer and this reader.
const { resolveToFullUuid } = require('./lib/uuid-prefix.cjs');

// ─── git, house pattern ───────────────────────────────────────────────────────
// Copied from build-team-stats.js: per-path adds (never -A), staged --shortstat
// (never --stat — REPO_MANIFEST L475 records the ENOBUFS kill at 25,593 files),
// commit before merge, 60-attempt push retry with jitter, THROW when exhausted.
// A lost push that exits zero is the silent failure this repo keeps re-finding.
const GIT_OPTS      = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const PUSH_ATTEMPTS = 60;

function gitCommit(message, paths) {
  for (const p of paths) {
    try { execSync(`git add -- ${p}`, GIT_OPTS); }
    catch (e) {
      const detail = (e.stderr || e.stdout || '').toString();
      if (!/did not match any files/i.test(detail)) throw new Error(`git add ${p} failed: ${detail.trim()}`);
    }
  }
  const shortstat = execSync('git diff --staged --shortstat', GIT_OPTS).toString().trim();
  if (!shortstat) { console.log('  staging: no changes — nothing to commit'); return; }
  console.log(`  staging: ${shortstat}`);
  execSync(`git commit -m "${message.replace(/"/g, "'")}"`, GIT_OPTS);
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try {
      execSync('git fetch origin main', GIT_OPTS);
      execSync('git merge -q -X ours FETCH_HEAD --no-edit --no-stat', GIT_OPTS);
      execSync('git push origin main', GIT_OPTS);
      console.log(`  ✔ pushed (attempt ${attempt}): ${message}`);
      return;
    } catch (e) {
      const detail = (e.stderr || e.stdout || '').toString().trim() || e.message;
      if (attempt === PUSH_ATTEMPTS) throw new Error(`push failed after ${PUSH_ATTEMPTS} attempts: ${detail}`);
      const wait = 1 + Math.floor(Math.random() * 90);
      console.log(`  … push contention (attempt ${attempt}) — retry in ${wait}s`);
      execSync(`sleep ${wait}`, { stdio: 'ignore' });
    }
  }
}

// ─── name normalisation ───────────────────────────────────────────────────────
// Diacritics folded, apostrophes dropped (O'Beirne -> obeirne), every other
// non-alphanumeric run collapsed to one space. That is what makes
// "Weller-McClutchie" and "Weller McClutchie" the same string, and
// "Jonah - Holland" and "Jonah-Holland" too — real cases from
// reports/alias-name-audit.json where punctuation was the only disagreement.
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Short forms, grouped by NAME and never by gender: "alex" legitimately expands
// to both Alexander and Alexandra, and the gender columns are what separate them.
// Guessing a gender from a short form would be inventing a fact. Extend freely —
// this is data, not logic.
const NICK_GROUPS = [
  ['zachary','zach','zac','zack'], ['matthew','matt','matty'], ['benjamin','ben','benji'],
  ['william','will','willy','billy','bill'], ['thomas','tom','tommy'], ['samuel','sam','sammy'],
  ['nicholas','nick','nico'], ['joshua','josh'], ['daniel','dan','danny'], ['jacob','jake'],
  ['christopher','chris'], ['michael','mike','mick','micky'], ['anthony','ant','tony'],
  ['alexander','alex','xander','sandy'], ['andrew','andy','drew'], ['patrick','pat','paddy'],
  ['timothy','tim','timmy'], ['jonathan','jon','jonny','johnny'], ['nathaniel','nathan','nate'],
  ['edward','ed','eddie','ted','teddy'], ['charles','charlie','chaz'], ['harrison','harry','hazza'],
  ['maxwell','max'], ['oliver','ollie','oli'], ['archibald','archie','archer'],
  ['frederick','freddie','fred'], ['theodore','theo'], ['joseph','joe','joey'],
  ['robert','rob','robbie','bob'], ['richard','rich','richie'], ['james','jim','jimmy','jamie'],
  ['lachlan','lachie','lochie'], ['cooper','coop'], ['dominic','dom'], ['gabriel','gabe'],
  ['isaac','zac','ike'], ['xavier','xav'], ['sebastian','seb'], ['vincent','vinnie','vince'],
  ['angus','gus'], ['finlay','finn','fin'], ['elijah','eli'], ['emmett','em'],
  ['isabella','bella','izzy','issy'], ['elizabeth','liz','lizzie','beth','ellie','eliza'],
  ['charlotte','charlie','lottie','char'], ['alexandra','alex','lexi','lexie'],
  ['olivia','liv','livvy','ollie'], ['matilda','tilly','tilda'], ['amelia','milly','millie','mia'],
  ['eleanor','ellie','nell'], ['evelyn','evie'], ['madeline','maddy','maddie'],
  ['samantha','sam','sammy'], ['gabriella','gabby','gabi'], ['victoria','vicky','vicki','tori'],
  ['jessica','jess','jessie'], ['rebecca','bec','becky','bex'], ['stephanie','steph'],
  ['katherine','kate','katie','kat','kitty'], ['abigail','abby','abbie'], ['natalie','nat'],
  ['sophia','sophie','soph'], ['mackenzie','kenzie'], ['jacqueline','jacqui'],
  ['penelope','penny','peppa'], ['georgia','georgie'], ['annabelle','annie','belle','bella'],
  ['scarlett','scarlet'], ['willow','will'], ['imogen','indi','indie'], ['billie','billi','bill'],
  ['melissa','lish'], ['alicia','alisha','lish'], ['aaliyah','aliyah'], ['milana','mila','milly'],
  // Added 2026-10-10 from the first live run's NO MATCH list, where the near-miss
  // net found the child and the nickname table did not: Alisha Cigulov under
  // "Cigulov, Lish", Millie Faletoese under "Faletoese, Melia".
  ['amelia','melia','millie','milly','mia'], ['emily','em','emmy','emi'],
  ['emma','em','emmy'], ['emmerson','em'], ['imogen','indi','indie','india'],
];
const NICK = new Map();
for (const group of NICK_GROUPS) {
  for (const tok of group) {
    if (!NICK.has(tok)) NICK.set(tok, new Set());
    for (const other of group) NICK.get(tok).add(other);
  }
}
const expand = tok => NICK.has(tok) ? NICK.get(tok) : new Set([tok]);

// A name reduced to what identifies it across spellings: the forms its FIRST
// token can take, and its LAST token.
function keyOf(raw) {
  const n = norm(raw);
  if (!n) return null;
  const toks = n.split(' ');
  return { full: n, first: toks[0], last: toks[toks.length - 1], firstSet: expand(toks[0]), toks };
}

// RULE "exact"      — first token matches (allowing a short form) AND the rest of
//                     the name matches with WHITESPACE IGNORED.
// RULE "first+last" — first and last token match, allowing a short form. This is
//                     what carries a query through a middle name on the record.
//
// The surname comparison ignores spaces because PlayHQ holds the same surname
// split both ways. "O'Beirne" normalises to "obeirne" once the apostrophe goes,
// while the same child recorded as "O Beirne" normalises to "o beirne" — and a
// token comparison calls those different people. Squashing closes that, and the
// same move handles "Van Dreumel"/"VanDreumel" and "De Ross"/"DeRoss", all of
// which are in this list. Found by a fixture, not by reasoning: the first version
// of this function reported Flynn O'Beirne as NOT IN THE DATABASE while his file
// sat in the fixture repo.
//
// The rule that fired goes into the CSV, so a loose match is never mistaken for
// a tight one.
function matchRule(q, c) {
  if (!q || !c) return null;
  const firstOk = [...q.firstSet].some(f => c.firstSet.has(f));
  if (!firstOk) return null;
  const squash = toks => toks.slice(1).join('');
  if (squash(q.toks) === squash(c.toks)) return 'exact';
  if (q.last === c.last) return 'first+last';
  return null;
}

// A stored roster id may be a 13-char truncated prefix OR a full uuid — measured
// 2026-08-23 across 29,984,730 p[] entries: 99.24% truncated, 0.76% full, and no
// roster lists the same person under both. Prefix-compare in either direction.
const idMatch = (stored, full) => {
  if (!stored || !full) return false;
  const a = String(stored).toLowerCase(), b = String(full).toLowerCase();
  return a === b || b.startsWith(a) || a.startsWith(b);
};

// WHICH TEAM WAS THIS PLAYER ON FOR THIS GAME?
//
// ⚠️ gameTids IS NOT THE ANSWER, and building on it is what made the first run of
// this script report "none on record" for everything. fetch-profile-stats.js L452
// writes gameTids ONLY when a player holds several teams in one season — it is a
// disambiguation hint for the ambiguous minority, not a record of every game. Toby
// Jovic has twelve seasons and no gameTids at all, which is normal, not broken.
//
// So it is used when present and three fallbacks follow it, in the order
// StatTrack's own getTidForGame uses:
//   1. gameTids, when this player is one of the ambiguous ones.
//   2. The BOX SCORE. hp[]/ap[] carry a side; naming the player is proof.
//   3. The REGISTRATION, but only when exactly one side is a team they hold for
//      that season. Two matches is the ambiguity gameTids exists for, and is
//      answered with null rather than a guess.
// p[] is deliberately not consulted: it carries no side information at all
// (build-team-stats.js says so in place), so it can prove presence and never team.
function sideOf(p, uuid, gid, g, sid) {
  const hint = (p.gameTids || {})[gid];
  if (hint) return hint;
  const h = g.h || g.t1 || null, a = g.a || g.t2 || null;
  if ((g.hp || []).some(x => idMatch(x && x.profileID, uuid))) return h;
  if ((g.ap || []).some(x => idMatch(x && x.profileID, uuid))) return a;
  const tids = new Set();
  for (const se of (p.seasons || [])) if (se.sid === sid)
    for (const r of (se.regs || [])) if (r.tid) tids.add(r.tid);
  const hit = [h, a].filter(t => t && tids.has(t));
  return hit.length === 1 ? hit[0] : null;
}

const csvCell = v => {
  const s = String(v === null || v === undefined ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = arr => arr.map(csvCell).join(',');

function main() {
  console.log('find-players-by-name.js');
  console.log('─'.repeat(62));

  // ── input ──────────────────────────────────────────────────────────────────
  let nameList, source, opponentSpec;
  if (INLINE !== null) {
    nameList = INLINE.split(/[\r\n;]+/);
    source   = '--names (inline, nothing committed)';
    opponentSpec = OPP_ARG || 'Toby Jovic';
  } else {
    const inputPath = path.isAbsolute(INPUT) ? INPUT : path.join(ROOT, INPUT);
    if (!fs.existsSync(inputPath)) throw new Error(`input file not found: ${INPUT}`);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(inputPath, 'utf8')); }
    catch (e) { throw new Error(`${INPUT} is not valid JSON: ${e.message}`); }
    nameList = Array.isArray(raw) ? raw : (raw.names || []);
    source   = INPUT;
    opponentSpec = OPP_ARG || raw.opponent || 'Toby Jovic';
  }
  if (!Array.isArray(nameList) || nameList.filter(Boolean).length === 0)
    throw new Error(`no names to search — expected {"names":["Lastname, Firstname", ...]}`);

  // Each entry becomes one or more keys. A COMMA IS AMBIGUOUS: "Smith, Jack" is
  // surname-first and "Jack, Smith" is given-first, and nothing in the string
  // says which. BOTH orders are tried. Only one can match a real record, so the
  // ambiguity is resolved against the data instead of guessed here.
  const queries = [];
  for (const entry of nameList) {
    const s = String(entry || '').trim();
    if (!s) continue;
    const forms = new Set([s]);
    if (s.includes(',')) {
      const [a, ...b] = s.split(',');
      const swapped = (b.join(' ').trim() + ' ' + a.trim()).trim();
      if (swapped) forms.add(swapped);
    }
    const keys = [...forms].map(keyOf).filter(Boolean);
    if (keys.length) queries.push({ raw: s, keys, hits: [] });
  }
  // ── near-miss net ──────────────────────────────────────────────────────────
  // "Not in the database" is only useful if you can tell a child who has never
  // played from one whose name we hold differently. Any player sharing a whole
  // TOKEN with an unmatched query is kept and printed beneath it.
  //
  // ⚠️ THE CAP IS PER TOKEN, NOT PER QUERY, AND THE RANKING IS BY RARITY. The
  // first version capped at 8 per query in SCAN ORDER, which is uuid order and
  // therefore arbitrary: "Chaplin, Em" filled all 8 slots with Chaplins whose
  // given name was not Em, and an "Em Chaplin" sitting later in the shards could
  // never have been shown. Worse, a common given name floods the list — every
  // slot for "Mandis, James" went to a James, none to a Mandis.
  //
  // So each token keeps its own slots, and at print time candidates are scored by
  // the INVERSE FREQUENCY of the tokens they share. A surname is rare and a given
  // name is common, so sharing the surname outranks sharing the given name without
  // either being hardcoded as such — which matters because the list is
  // surname-first and a comma cannot say which half is which.
  const tokenToQueries = new Map();
  const tokenFreq = new Map();                      // query token -> players carrying it
  const NEAR_PER_TOKEN = 6;
  const NEAR_SHOW = 10;
  const addTok = (t, qi) => {
    if (!t || t.length < 3) return;
    if (!tokenToQueries.has(t)) tokenToQueries.set(t, new Set());
    tokenToQueries.get(t).add(qi);
  };

  queries.forEach((q, qi) => { q.near = new Map(); for (const k of q.keys) for (const t of k.toks) addTok(t, qi); });
  console.log(`  Names to find   : ${queries.length}`);
  console.log(`  Source          : ${source}`);
  console.log(`  Opponent        : ${opponentSpec}`);

  // ── indexes ────────────────────────────────────────────────────────────────
  const sportIdx = JSON.parse(fs.readFileSync(SPORTS_IDX, 'utf8')).seasons || {};
  const teamIdx  = JSON.parse(fs.readFileSync(TEAM_IDX, 'utf8'));
  const teamById = new Map();
  for (const entries of Object.values(teamIdx))
    if (Array.isArray(entries)) for (const e of entries) if (e.id) teamById.set(e.id, e);
  const gradeById = new Map();
  for (const se of Object.values(sportIdx))
    for (const g of (se.grades || [])) if (g.id) gradeById.set(g.id, g);
  console.log(`  Seasons indexed : ${Object.keys(sportIdx).length}`);
  console.log(`  Teams indexed   : ${teamById.size}`);

  // ── one pass over players/ ─────────────────────────────────────────────────
  // A regex over the RAW file text decides whether a JSON.parse is worth doing.
  // A file mentioning none of the names cannot match, and skipping its parse is
  // most of the runtime on a 420,000-file corpus.
  const tokens = new Set();
  for (const q of queries) for (const k of q.keys) { tokens.add(k.last); tokens.add(k.first); }
  const oppIsUuid = /^[0-9a-f]{8}/i.test(opponentSpec) && !/\s/.test(opponentSpec);
  const oppKey    = oppIsUuid ? null : keyOf(opponentSpec);
  const oppPrefix = oppIsUuid ? opponentSpec.toLowerCase() : null;
  if (oppKey) { tokens.add(oppKey.last); tokens.add(oppKey.first); }
  const prefilter = new RegExp(
    [...tokens].filter(t => t && t.length > 1).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

  const oppCandidates = [];
  let scanned = 0, parsed = 0;
  const shards = fs.readdirSync(PLAYERS_DIR).filter(f => /^[0-9a-f]{2}$/.test(f)).sort();
  for (const shard of shards) {
    const dir = path.join(PLAYERS_DIR, shard);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (_) { continue; }
    for (const fname of files) {
      scanned++;
      if (scanned % 25000 === 0) process.stdout.write(`  scanned ${scanned} player files (${parsed} parsed)\r`);
      const uuid = fname.replace(/\.json$/, '');
      const uuidHit = oppPrefix && uuid.toLowerCase().startsWith(oppPrefix);
      let text;
      try { text = fs.readFileSync(path.join(dir, fname), 'utf8'); } catch (_) { continue; }
      if (!uuidHit && !prefilter.test(text)) continue;
      let p;
      try { p = JSON.parse(text); } catch (_) { continue; }
      parsed++;
      const ck = keyOf(p.name);
      if (uuidHit || (oppKey && ck && matchRule(oppKey, ck))) oppCandidates.push({ uuid, p });
      if (!ck) continue;
      for (const q of queries) {
        let rule = null;
        for (const k of q.keys) { rule = matchRule(k, ck); if (rule) break; }
        if (rule) q.hits.push({ uuid, p, rule });
      }
      // Near-miss: shares a token with a query but did not match it. Slots are
      // per token so a rare surname can never be crowded out by a common given
      // name, and tokenFreq is counted here so the ranking below has something
      // to rank with.
      const tokSeen = new Set();
      for (const t of ck.toks) {
        if (tokSeen.has(t)) continue;
        tokSeen.add(t);
        const qis = tokenToQueries.get(t);
        if (!qis) continue;
        tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
        for (const qi of qis) {
          const q = queries[qi];
          if (q.hits.some(h => h.uuid === uuid)) continue;
          if (!q.near.has(t)) q.near.set(t, []);
          const slot = q.near.get(t);
          if (slot.length < NEAR_PER_TOKEN)
            slot.push({ name: p.name, uuid, seasons: (p.seasons || []).length, gender: p.gender || 'unknown' });
        }
      }
    }
  }
  console.log(`\n  Player files scanned: ${scanned}   parsed: ${parsed}`);

  // ── resolve the opponent ───────────────────────────────────────────────────
  // Never guessed. Several candidates is a question for a human, so the team and
  // season report is still written and the run then exits NON-ZERO with the
  // candidates named. A half-answer that looks whole is worse than an explicit
  // failure.
  let opponent = null, oppFail = null;
  if (oppCandidates.length === 1) {
    opponent = oppCandidates[0];
  } else if (oppCandidates.length === 0) {
    oppFail = `no player matched the opponent "${opponentSpec}"`;
  } else {
    const withGames = oppCandidates.filter(c => (c.p.games || []).length > 0);
    if (withGames.length === 1) {
      opponent = withGames[0];
      console.log(`  Opponent: ${oppCandidates.length} name matches, exactly ONE with games on record`);
    } else {
      oppFail = `"${opponentSpec}" matches ${oppCandidates.length} players` +
                (withGames.length ? ` (${withGames.length} with games)` : '') +
                ` — re-run with --opponent=<uuid prefix>`;
    }
  }
  if (opponent) {
    // games[] is the real game record and is written for every player. gameTids is
    // printed beside it only so an empty one is never again mistaken for "no games".
    console.log(`  Opponent resolved: ${opponent.p.name}  ${opponent.uuid}`);
    console.log(`    seasons ${(opponent.p.seasons || []).length}   games[] ${(opponent.p.games || []).length}` +
                `   gameTids ${Object.keys(opponent.p.gameTids || {}).length} (a hint for ambiguous seasons only — 0 is normal)`);
    if (!(opponent.p.games || []).length)
      console.log('    ⚠  games[] is EMPTY — nothing can be compared. Run Build Player Games before trusting any "none on record" below.');
  } else {
    console.log(`  ⚠  OPPONENT UNRESOLVED — ${oppFail}`);
    for (const c of oppCandidates.slice(0, 20))
      console.log(`       ${c.uuid}  ${c.p.name}  (${(c.p.seasons || []).length} seasons, ` +
                  `${(c.p.games || []).length} games)`);
  }

  // ── shared games ───────────────────────────────────────────────────────────
  // The intersection is on games[], the bare game-id list build-player-games
  // writes for EVERY player. Sides then come from the game files via sideOf().
  // An earlier version intersected gameTids and reported "none on record" for all
  // 187 names, because the opponent had no gameTids — see the note on sideOf.
  //
  // A game where either side cannot be resolved is counted as SIDE UNKNOWN and
  // reported as its own number. It is not quietly dropped and it is not counted as
  // "did not play against": those are different facts.
  const oppGames = new Set(opponent ? (opponent.p.games || []) : []);
  const gameIndex = new Map();                      // gid -> { sid, g }
  if (opponent && oppGames.size) {
    const sids = new Set((opponent.p.seasons || []).map(x => x && x.sid).filter(Boolean));
    for (const tid of Object.values(opponent.p.gameTids || {})) {
      const te = teamById.get(tid); if (te && te.sid) sids.add(te.sid);
    }
    for (const sid of sids) {
      const f = path.join(GAMES_DIR, `${sid}.json`);
      if (!fs.existsSync(f)) continue;
      let games = null;
      try { games = JSON.parse(fs.readFileSync(f, 'utf8')).games || {}; } catch (_) { continue; }
      for (const gid of oppGames) if (games[gid] && !gameIndex.has(gid)) gameIndex.set(gid, { sid, g: games[gid] });
    }
    const unlocated = [...oppGames].filter(gid => !gameIndex.has(gid)).length;
    console.log(`  Opponent games located: ${gameIndex.size} of ${oppGames.size}` +
                (unlocated ? `   ⚠ ${unlocated} not found in any of his seasons' game files` : ''));
  }

  // gid -> the opponent's own team for that game, resolved once.
  const oppSide = new Map();
  for (const [gid, { sid, g }] of gameIndex) {
    const t = sideOf(opponent.p, opponent.uuid, gid, g, sid);
    if (t) oppSide.set(gid, t);
  }
  if (opponent && gameIndex.size)
    console.log(`  Opponent's own team resolved for ${oppSide.size} of ${gameIndex.size} games`);

  // Shared games for one player, classified. Used for the named list and again
  // for the full team-mate roll-up below.
  function sharedWith(p, uuid) {
    const out = [];
    for (const gid of (p.games || [])) {
      const entry = gameIndex.get(gid);
      if (!entry) continue;
      const oTid = oppSide.get(gid);
      const tTid = sideOf(p, uuid, gid, entry.g, entry.sid);
      out.push({ gid, sid: entry.sid, g: entry.g, theirTid: tTid, oppTid: oTid,
                 same: (tTid && oTid) ? tTid === oTid : null });
    }
    return out;
  }

  const shared = new Map();                         // uuid -> [shared game records]
  if (opponent) {
    for (const q of queries) for (const h of q.hits) {
      if (h.uuid === opponent.uuid) continue;       // he is not his own opponent
      const list = sharedWith(h.p, h.uuid);
      if (list.length) shared.set(h.uuid, list);
    }
  }
  const gameOf = gid => (gameIndex.get(gid) || {}).g || null;

  // ── EVERY TEAM-MATE THE OPPONENT HAS EVER HAD ─────────────────────────────
  // Independent of the name list. The blocks above answer "did these 187 children
  // ever meet Toby"; this answers "who has Toby actually played alongside", which
  // is a different question and does not depend on anyone having guessed the right
  // names in advance.
  //
  // The roster is the source, not the games. team-stats/bv/{sid}.json already
  // holds every team's roster, built from registrations as well as box scores, so
  // it includes a child who was on the team and never got on the floor — which a
  // game-derived list would silently drop. Games shared are then counted from each
  // roster member's own gameTids, so "on the team with him" and "actually played
  // with him" are two columns rather than one conflated number.
  //
  // Cost is a handful of team-stats files plus one player file per roster member.
  const mateRows = [[
    'teammate', 'uuid', 'gender_recorded', 'season', 'season_id', 'competition',
    'association', 'team', 'team_id', 'grade', 'grade_gender', 'grade_age',
    'their_games_for_this_team', 'games_alongside_opponent', 'games_side_unknown', 'in_your_name_list',
  ]];
  const mateTotals = new Map();                     // key -> {name, seasons:Set, together:0}
  if (opponent) {
    // Teams he was registered to, PLUS teams he actually played for. A game can
    // record a team the registration pass never saw (fill-in, late add), and
    // leaving those out would lose exactly the ad-hoc team-mates worth knowing.
    const oppTeams = new Map();                     // tid -> sid
    for (const season of (opponent.p.seasons || []))
      for (const reg of (season.regs || [])) if (reg.tid) oppTeams.set(reg.tid, season.sid);
    for (const tid of Object.values(opponent.p.gameTids || {}))
      if (!oppTeams.has(tid)) { const te = teamById.get(tid); if (te && te.sid) oppTeams.set(tid, te.sid); }

    const listedUuids = new Set(queries.flatMap(q => q.hits).map(h => h.uuid));
    const tsCache = new Map();
    const mateFileCache = new Map();
    let rosterMissing = 0;

    for (const [tid, sid] of oppTeams) {
      if (!tsCache.has(sid)) {
        const f = path.join(ROOT, 'team-stats', 'bv', `${sid}.json`);
        let d = null;
        if (fs.existsSync(f)) { try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { d = null; } }
        tsCache.set(sid, d);
      }
      const team = tsCache.get(sid)?.[tid];
      if (!team) { rosterMissing++; continue; }
      const se = sportIdx[sid] || {};
      const te = teamById.get(tid) || {};
      const reg = (opponent.p.seasons || []).flatMap(x => x.sid === sid ? (x.regs || []) : []).find(r => r.tid === tid);
      const gr = reg && reg.gid ? (gradeById.get(reg.gid) || {}) : {};

      for (const [key, r] of Object.entries(team.roster || {})) {
        let full = null;
        try { full = resolveToFullUuid(key, ROOT); } catch (_) { full = null; }
        if (full && full === opponent.uuid) continue;
        if (!full && (r.name || '') === opponent.p.name) continue;

        let mate = null;
        if (full) {
          if (!mateFileCache.has(full)) {
            const mf = path.join(PLAYERS_DIR, full.slice(0, 2), `${full}.json`);
            let d = null;
            if (fs.existsSync(mf)) { try { d = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (_) { d = null; } }
            mateFileCache.set(full, d);
          }
          mate = mateFileCache.get(full);
        }
        // Games alongside: both hold the same game id under the SAME team. Blank
        // rather than 0 when the player file could not be read — "we could not
        // look" and "we looked and found none" are different answers.
        let together = '', unknownSide = '', theirGames = '';
        if (mate) {
          const sh = sharedWith(mate, full);
          theirGames  = sh.filter(x => x.theirTid === tid).length;
          together    = sh.filter(x => x.same === true  && x.theirTid === tid).length;
          unknownSide = sh.filter(x => x.same === null).length;
        }
        mateRows.push([
          r.name || mate?.name || `#${key}`, full || key, mate?.gender || 'unknown',
          se.name || sid, sid, se.compName || te.comp || '', se.orgName || '',
          reg?.tn || team.meta?.name || te.n || '', tid,
          reg?.gn || team.meta?.grade || gr.name || '', gr.gender || '', gr.age || '',
          theirGames, together, unknownSide, listedUuids.has(full) ? 'yes' : '',
        ]);

        const k = full || key;
        if (!mateTotals.has(k)) mateTotals.set(k, {
          name: r.name || mate?.name || `#${key}`, gender: mate?.gender || 'unknown',
          seasons: new Set(), together: 0, unreadable: false, rows: [],
        });
        const agg = mateTotals.get(k);
        if (agg.gender === 'unknown' && mate?.gender) agg.gender = mate.gender;
        agg.seasons.add(sid);
        agg.rows.push({
          season: se.name || sid,
          team:   reg?.tn || team.meta?.name || te.n || tid,
          grade:  reg?.gn || team.meta?.grade || gr.name || '',
          together: typeof together === 'number' ? together : null,
          theirGames: typeof theirGames === 'number' ? theirGames : null,
        });
        // An unreadable player file must not roll up as a confident zero — that is
        // the same masking the CSV avoids by leaving the cell blank.
        if (typeof together === 'number') agg.together += together; else agg.unreadable = true;
      }
    }
    if (rosterMissing) {
      console.log(`  ⚠  ${rosterMissing} of ${oppTeams.size} of the opponent's teams have NO roster in team-stats/bv.`);
      console.log(`     Their team-mates are missing from the roster report because the file is not`);
      console.log(`     there to read — not because he had none. Rebuild team-stats for those seasons.`);
    }
  }

  // ── how a player is described in the log ──────────────────────────────────
  // Name alone cannot be acted on: three Jack Bakers look identical until you can
  // see which is a U13 boy at Whitehorse and which is a man playing seniors.
  const genderOf = p => (p && p.gender) || 'unknown';
  const teamLabel = tid => {
    const te = teamById.get(tid) || {};
    return te.n || tid || '(unknown team)';
  };
  const seasonLabel = sid => (sportIdx[sid] || {}).name || sid || '(unknown season)';
  const gradeLabel = (sid, tid) => {
    const te = teamById.get(tid) || {};
    return te.grade || '';
  };
  // Shared games, grouped into one line per season and team.
  function groupShared(list, keep) {
    const m = new Map();
    for (const x of list) {
      if (!keep(x)) continue;
      const k = `${x.sid}|${x.theirTid || ''}`;
      if (!m.has(k)) m.set(k, { sid: x.sid, tid: x.theirTid, n: 0 });
      m.get(k).n++;
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  }
  function detailLines(list, keep, indent = '        ') {
    return groupShared(list, keep).map(gp => {
      const gr = gradeLabel(gp.sid, gp.tid);
      return `${indent}${seasonLabel(gp.sid)} · ${teamLabel(gp.tid)}${gr ? ' · ' + gr : ''}` +
             ` — ${gp.n} game${gp.n === 1 ? '' : 's'}`;
    });
  }
  // Up to `max` "Season · Team" pairs straight off a player's registrations,
  // for players we hold no shared games with at all.
  function careerLines(p, max = 3, indent = '        ') {
    const out = [];
    for (const season of (p.seasons || [])) {
      for (const reg of (season.regs || [])) {
        if (out.length >= max) return out;
        out.push(`${indent}${seasonLabel(season.sid)} · ${reg.tn || teamLabel(reg.tid)}` +
                 `${reg.gn ? ' · ' + reg.gn : ''}`);
      }
    }
    return out;
  }

  // ── rows ───────────────────────────────────────────────────────────────────
  const teamRows = [[
    'query', 'matched_name', 'match_rule', 'uuid', 'gender_recorded', 'private',
    'season', 'season_id', 'competition', 'association', 'team', 'team_id',
    'grade', 'grade_gender', 'grade_age', 'games_with_this_team',
    'vs_opponent_games_on_record', 'teammate_games_on_record', 'shared_games_side_unknown',
  ]];
  const vsRows = [[
    'query', 'matched_name', 'uuid', 'relationship', 'season', 'game_id',
    'date', 'round', 'their_team', 'opponent_team', 'score_home_away', 'their_result',
  ]];

  let totalHits = 0;
  const unmatched = [], ambiguous = [];
  for (const q of queries) {
    if (q.hits.length === 0) { unmatched.push(q.raw); continue; }
    if (q.hits.length > 1) ambiguous.push(`${q.raw} → ${q.hits.length} candidates`);
    totalHits += q.hits.length;
    for (const h of q.hits) {
      const sh = shared.get(h.uuid) || [];
      const gamesPerTid = {};
      for (const tid of Object.values(h.p.gameTids || {})) gamesPerTid[tid] = (gamesPerTid[tid] || 0) + 1;

      const seasons = h.p.seasons || [];
      if (!seasons.length) {
        teamRows.push([q.raw, h.p.name || '', h.rule, h.uuid, h.p.gender || 'unknown',
          h.p.private === true ? 'yes' : '', '(no season on record)', '', '', '', '', '', '', '', '', 0, 0, 0]);
      }
      for (const season of seasons) {
        const se = sportIdx[season.sid] || {};
        const regs = season.regs || [];
        if (!regs.length) {
          teamRows.push([q.raw, h.p.name || '', h.rule, h.uuid, h.p.gender || 'unknown',
            h.p.private === true ? 'yes' : '', se.name || season.sid, season.sid,
            se.compName || '', se.orgName || '', '(season on record, no registration)',
            '', '', '', '', 0, 0, 0]);
          continue;
        }
        for (const reg of regs) {
          const te = teamById.get(reg.tid) || {};
          const gr = reg.gid ? (gradeById.get(reg.gid) || {}) : {};
          teamRows.push([
            q.raw, h.p.name || '', h.rule, h.uuid,
            h.p.gender || 'unknown', h.p.private === true ? 'yes' : '',
            se.name || season.sid, season.sid, se.compName || te.comp || '', se.orgName || '',
            reg.tn || te.n || '', reg.tid, reg.gn || gr.name || '', gr.gender || '', gr.age || '',
            gamesPerTid[reg.tid] || 0,
            sh.filter(x => x.same === false && x.theirTid === reg.tid).length,
            sh.filter(x => x.same === true  && x.theirTid === reg.tid).length,
            sh.filter(x => x.same === null).length,
          ]);
        }
      }

      for (const x of sh) {
        const te = teamById.get(x.theirTid) || {};
        const oe = teamById.get(x.oppTid) || {};
        const se = sportIdx[te.sid] || {};
        const g  = gameOf(x.gid) || {};
        const haveScore = g.hs !== undefined && g.hs !== null && g.as !== undefined && g.as !== null;
        const score = haveScore ? `${g.hs}-${g.as}` : '';
        // score_home_away is the game's own home-away scoreline; their_result is
        // that read from THIS player's end, which is the only reading anyone wants
        // and the one a raw scoreline silently gets backwards for an away team.
        let result = '';
        if (haveScore) {
          const theyAreHome = (g.h || g.t1) === x.theirTid;
          const mine = theyAreHome ? g.hs : g.as;
          const them = theyAreHome ? g.as : g.hs;
          result = mine > them ? 'W' : mine < them ? 'L' : 'D';
        }
        vsRows.push([
          q.raw, h.p.name || '', h.uuid,
          x.same === true ? 'team-mate' : x.same === false ? 'opponent' : 'side unknown',
          se.name || te.sid || '', x.gid, g.d || '', g.rn || '',
          te.n || x.theirTid, oe.n || x.oppTid, score, result,
        ]);
      }
    }
  }

  // ── write ──────────────────────────────────────────────────────────────────
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(OUT_TEAMS), { recursive: true });
    fs.writeFileSync(OUT_TEAMS, teamRows.map(csvRow).join('\n') + '\n');
    fs.writeFileSync(OUT_VS,    vsRows.map(csvRow).join('\n') + '\n');
    fs.writeFileSync(OUT_MATES, mateRows.map(csvRow).join('\n') + '\n');
  }

  // ── summary ────────────────────────────────────────────────────────────────
  console.log('─'.repeat(62));
  console.log(`  Names searched   : ${queries.length}`);
  console.log(`  Players matched  : ${totalHits}`);
  console.log(`  Team/season rows : ${teamRows.length - 1}`);
  console.log(`  Shared-game rows : ${vsRows.length - 1}`);

  const genderCount = {};
  for (const q of queries) for (const h of q.hits) {
    const g = h.p.gender || 'unknown';
    genderCount[g] = (genderCount[g] || 0) + 1;
  }
  console.log(`  Gender recorded  : ` +
    Object.entries(genderCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('   ') || '(none)');

  if (unmatched.length) {
    console.log(`\n  NO MATCH (${unmatched.length}) — not in the database under any spelling tried.`);
    console.log(`  Each is followed by every player sharing a word with the name, so you can tell a`);
    console.log(`  child who has never played from one we hold under a different spelling.`);
    for (const q of queries) {
      if (q.hits.length) continue;
      console.log(`\n    ${q.raw}`);
      if (!q.near.size) { console.log('      (nothing in the database shares a word with this name)'); continue; }
      // Score by the rarity of the shared tokens, then by how established the
      // player is. A shared surname outweighs a shared given name because it is
      // rarer, not because anything here decided which half is the surname.
      const byUuid = new Map();
      for (const [t, list] of q.near) for (const n of list) {
        if (!byUuid.has(n.uuid)) byUuid.set(n.uuid, { ...n, score: 0, via: [] });
        const e = byUuid.get(n.uuid);
        e.score += 1 / Math.max(1, tokenFreq.get(t) || 1);
        e.via.push(t);
      }
      const ranked = [...byUuid.values()]
        .sort((a, b) => b.score - a.score || b.seasons - a.seasons)
        .slice(0, NEAR_SHOW);
      for (const n of ranked)
        console.log(`      ? ${String(n.name).padEnd(30)} ${String(n.gender).padEnd(8)}` +
                    ` ${String(n.seasons).padStart(2)} season(s)  ${n.uuid.slice(0, 13)}   via ${n.via.join('+')}`);
    }
  }
  if (ambiguous.length) {
    console.log(`\n  SEVERAL CANDIDATES (${ambiguous.length}) — every one is in the CSV; nothing was chosen for you.`);
    console.log(`  Gender and recent teams are shown so you can tell them apart: a "Men" or "Women"`);
    console.log(`  grade on a junior list is an adult who happens to share the name.`);
    for (const q of queries) {
      if (q.hits.length < 2) continue;
      console.log(`\n    ${q.raw} → ${q.hits.length} candidates`);
      for (const h of q.hits) {
        console.log(`      · ${String(h.p.name || '').padEnd(28)} ${genderOf(h.p).padEnd(8)}` +
                    ` ${String((h.p.seasons || []).length).padStart(2)} season(s)  ${h.uuid.slice(0, 13)}  [${h.rule}]`);
        careerLines(h.p, 2, '          ').forEach(l => console.log(l));
      }
    }
  }

  if (opponent) {
    const recOf  = uuid => (queries.flatMap(q => q.hits).find(h => h.uuid === uuid) || {}).p || null;
    const nameOf = uuid => recOf(uuid)?.name || uuid;
    const vsPlayers = [...shared.entries()].filter(([, l]) => l.some(x => x.same === false));
    const tmPlayers = [...shared.entries()].filter(([, l]) => l.some(x => x.same === true));
    const unkPlayers = [...shared.entries()].filter(([, l]) => l.some(x => x.same === null));
    console.log(`\n  PLAYED AGAINST ${opponent.p.name}:`);
    if (!vsPlayers.length) console.log('    none on record');
    for (const [uuid, list] of vsPlayers.sort((a, b) => b[1].length - a[1].length)) {
      const n = list.filter(x => x.same === false).length;
      console.log(`    ${nameOf(uuid).padEnd(30)} ${genderOf(recOf(uuid)).padEnd(8)} ${String(n).padStart(3)} game(s)  ${uuid.slice(0, 13)}`);
      detailLines(list, x => x.same === false).forEach(l => console.log(l));
    }
    if (tmPlayers.length) {
      console.log(`\n  TEAM-MATES of ${opponent.p.name} (not opponents):`);
      for (const [uuid, list] of tmPlayers.sort((a, b) => b[1].length - a[1].length)) {
        const n = list.filter(x => x.same === true).length;
        console.log(`    ${nameOf(uuid).padEnd(30)} ${genderOf(recOf(uuid)).padEnd(8)} ${String(n).padStart(3)} game(s)  ${uuid.slice(0, 13)}`);
        detailLines(list, x => x.same === true).forEach(l => console.log(l));
      }
    }
    const mates = [...mateTotals.values()].sort((a, b) => b.together - a.together || a.name.localeCompare(b.name));
    console.log(`\n  EVERY TEAM-MATE ${opponent.p.name} HAS EVER HAD: ${mates.length} players across ${new Set([].concat(...mates.map(m => [...m.seasons]))).size} season(s)`);
    for (const m of mates.slice(0, 60)) {
      console.log(`    ${m.name.padEnd(30)} ${String(m.gender).padEnd(8)}` +
                  ` ${(m.unreadable && !m.together ? '  ?' : String(m.together).padStart(3))} game(s) alongside` +
                  `   ${m.seasons.size} season(s)` +
                  (m.unreadable ? '   (player file unreadable — not a zero)' : ''));
      // One line per season and team, sorted by how much of it they shared.
      for (const r of m.rows.slice().sort((a, b) => (b.together || 0) - (a.together || 0))) {
        const tog = r.together === null ? '?' : r.together;
        console.log(`        ${r.season} · ${r.team}${r.grade ? ' · ' + r.grade : ''}` +
                    ` — ${tog} together of ${r.theirGames === null ? '?' : r.theirGames} they played`);
      }
    }
    if (mates.length > 60) console.log(`    … and ${mates.length - 60} more — all of them are in opponent-teammates.csv`);

    if (unkPlayers.length) {
      console.log(`\n  SHARED A GAME, SIDE COULD NOT BE RESOLVED (${unkPlayers.length}) — counted as NEITHER:`);
      for (const [uuid, list] of unkPlayers) {
        const n = list.filter(x => x.same === null).length;
        console.log(`    ${nameOf(uuid).padEnd(30)} ${genderOf(recOf(uuid)).padEnd(8)} ${String(n).padStart(3)} game(s)  ${uuid.slice(0, 13)}`);
        detailLines(list, x => x.same === null).forEach(l => console.log(l));
      }
    }

    console.log(`\n  ⚠  "none on record" is NOT "never happened". 442,939 appearances are known`);
    console.log(`     missing from our rosters, so a shared game FOUND is strong evidence and a`);
    console.log(`     shared game NOT found is weak. See OUTSTANDING_TASKS, appearance gap.`);
  }

  console.log(`\n  Written: ${path.relative(ROOT, OUT_TEAMS)}`);
  console.log(`           ${path.relative(ROOT, OUT_VS)}`);
  console.log(`           ${path.relative(ROOT, OUT_MATES)}`);
  if (DRY_RUN)        console.log('  ⚠  DRY RUN — nothing written');
  else if (DO_COMMIT) gitCommit('find-players-by-name: report',
    ['reports/name-search.csv', 'reports/name-search-vs-opponent.csv', 'reports/opponent-teammates.csv']);
  else                console.log("  (not committed — download them from the run's artifact)");

  if (oppFail) {
    console.error(`\nFATAL: ${oppFail}`);
    console.error('The team and season report above is COMPLETE and was written. The opponent');
    console.error('columns could not be computed and are all zero — do not read them as "no".');
    process.exit(1);
  }
}

try { main(); }
catch (e) { console.error('\nFATAL:', e.message, '\n', e.stack); process.exit(1); }
