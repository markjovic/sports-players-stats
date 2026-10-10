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
  ['melissa','lish'], ['alicia','alisha'], ['aaliyah','aliyah'], ['milana','mila','milly'],
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
    const withGames = oppCandidates.filter(c => Object.keys(c.p.gameTids || {}).length > 0);
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
    console.log(`  Opponent resolved: ${opponent.p.name}  ${opponent.uuid}` +
                `  (${(opponent.p.seasons || []).length} seasons, ` +
                `${Object.keys(opponent.p.gameTids || {}).length} games with a known team)`);
  } else {
    console.log(`  ⚠  OPPONENT UNRESOLVED — ${oppFail}`);
    for (const c of oppCandidates.slice(0, 20))
      console.log(`       ${c.uuid}  ${c.p.name}  (${(c.p.seasons || []).length} seasons, ` +
                  `${Object.keys(c.p.gameTids || {}).length} games)`);
  }
  const oppTids = opponent ? (opponent.p.gameTids || {}) : {};

  // ── shared games ───────────────────────────────────────────────────────────
  // gameTids maps game id -> the team THAT player was on. Two players holding the
  // same game id under DIFFERENT teams played against each other; under the SAME
  // team they were team-mates. Both are reported, separately, because conflating
  // them answers the wrong question.
  const shared = new Map();                         // uuid -> [{gid, theirTid, oppTid, same}]
  const sidsNeeded = new Set();
  if (opponent) {
    for (const q of queries) for (const h of q.hits) {
      if (h.uuid === opponent.uuid) continue;       // the opponent is in the list; he is not his own opponent
      const list = [];
      for (const [gid, tid] of Object.entries(h.p.gameTids || {})) {
        const oTid = oppTids[gid];
        if (!oTid) continue;
        list.push({ gid, theirTid: tid, oppTid: oTid, same: oTid === tid });
        const te = teamById.get(tid); if (te && te.sid) sidsNeeded.add(te.sid);
        const oe = teamById.get(oTid); if (oe && oe.sid) sidsNeeded.add(oe.sid);
      }
      if (list.length) shared.set(h.uuid, list);
    }
  }
  // Only the seasons those games live in are opened — a handful of files, not the
  // 2.3M-game corpus, because tid -> sid is already in data/team-index.json.
  const gameCache = new Map();
  for (const sid of sidsNeeded) {
    const f = path.join(GAMES_DIR, `${sid}.json`);
    if (!fs.existsSync(f)) continue;
    try { gameCache.set(sid, (JSON.parse(fs.readFileSync(f, 'utf8')).games) || {}); } catch (_) {}
  }
  const gameOf = gid => { for (const games of gameCache.values()) if (games[gid]) return games[gid]; return null; };

  // ── rows ───────────────────────────────────────────────────────────────────
  const teamRows = [[
    'query', 'matched_name', 'match_rule', 'uuid', 'gender_recorded', 'private',
    'season', 'season_id', 'competition', 'association', 'team', 'team_id',
    'grade', 'grade_gender', 'grade_age', 'games_with_this_team',
    'vs_opponent_games_on_record', 'teammate_games_on_record',
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
            sh.filter(x => !x.same && x.theirTid === reg.tid).length,
            sh.filter(x =>  x.same && x.theirTid === reg.tid).length,
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
          q.raw, h.p.name || '', h.uuid, x.same ? 'team-mate' : 'opponent',
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
    console.log(`\n  NO MATCH (${unmatched.length}) — not in the database under any spelling tried:`);
    unmatched.forEach(n => console.log(`    ${n}`));
  }
  if (ambiguous.length) {
    console.log(`\n  SEVERAL CANDIDATES (${ambiguous.length}) — all of them are in the CSV; nothing was chosen for you:`);
    ambiguous.forEach(n => console.log(`    ${n}`));
  }

  if (opponent) {
    const nameOf = uuid => (queries.flatMap(q => q.hits).find(h => h.uuid === uuid) || {}).p?.name || uuid;
    const vsPlayers = [...shared.entries()].filter(([, l]) => l.some(x => !x.same));
    const tmPlayers = [...shared.entries()].filter(([, l]) => l.some(x =>  x.same));
    console.log(`\n  PLAYED AGAINST ${opponent.p.name}:`);
    if (!vsPlayers.length) console.log('    none on record');
    for (const [uuid, list] of vsPlayers.sort((a, b) => b[1].length - a[1].length))
      console.log(`    ${nameOf(uuid).padEnd(30)} ${list.filter(x => !x.same).length} game(s)`);
    if (tmPlayers.length) {
      console.log(`\n  TEAM-MATES of ${opponent.p.name} (not opponents):`);
      for (const [uuid, list] of tmPlayers.sort((a, b) => b[1].length - a[1].length))
        console.log(`    ${nameOf(uuid).padEnd(30)} ${list.filter(x => x.same).length} game(s)`);
    }
    console.log(`\n  ⚠  "none on record" is NOT "never happened". 442,939 appearances are known`);
    console.log(`     missing from our rosters, so a shared game FOUND is strong evidence and a`);
    console.log(`     shared game NOT found is weak. See OUTSTANDING_TASKS, appearance gap.`);
  }

  console.log(`\n  Written: ${path.relative(ROOT, OUT_TEAMS)}`);
  console.log(`           ${path.relative(ROOT, OUT_VS)}`);
  if (DRY_RUN)        console.log('  ⚠  DRY RUN — nothing written');
  else if (DO_COMMIT) gitCommit('find-players-by-name: report', ['reports/name-search.csv', 'reports/name-search-vs-opponent.csv']);
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
