// scripts/diagnose-win-loss-ambiguous.js
//
// Investigates players who are 'ambiguous' in build-win-loss — i.e. have regs
// for both teams in every game they appear in for a given season.
// Loads team-lookup data to show team names, grades, and org names so we can
// understand why a player is registered to both competing teams.
//
// Usage:
//   node scripts/diagnose-win-loss-ambiguous.js
//   node scripts/diagnose-win-loss-ambiguous.js --sample=20

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');
const LOOKUP_DIR  = path.join(ROOT, 'team-lookup');
const SAMPLE_SIZE = parseInt(process.argv.find(a => a.startsWith('--sample='))?.split('=')[1] || '10');
const MIN_GP      = 5;

const sportsIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sports-index.json'), 'utf8'));
const allSids     = new Set(Object.keys(sportsIndex.seasons || {}));

// ── Team lookup ───────────────────────────────────────────────────────────────

const _shards = {};
function lookupTeam(tid) {
  if (!tid) return null;
  const prefix = tid.slice(0, 2);
  if (!_shards[prefix]) {
    const f = path.join(LOOKUP_DIR, `${prefix}.json`);
    try { _shards[prefix] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; }
    catch { _shards[prefix] = {}; }
  }
  return _shards[prefix][tid] || null;
}

function teamLabel(tid) {
  const t = lookupTeam(tid);
  if (!t) return `${tid} (unknown)`;
  return `${t.name || '?'} | grade=${t.gn || '?'} | org=${t.orgName || '?'}`;
}

// ── Game file cache ───────────────────────────────────────────────────────────

const gfCache = new Map();
function loadGameFile(sid) {
  if (gfCache.has(sid)) return gfCache.get(sid);
  const f = path.join(GAMES_DIR, `${sid}.json`);
  if (!fs.existsSync(f)) { gfCache.set(sid, null); return null; }
  try { const gf = JSON.parse(fs.readFileSync(f, 'utf8')); gfCache.set(sid, gf); return gf; }
  catch { gfCache.set(sid, null); return null; }
}

// ── Pre-pass ──────────────────────────────────────────────────────────────────

console.log('Pre-pass: scanning player files for ambiguous candidates…');
const candidates = [];
const prefixes   = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();

for (const prefix of prefixes) {
  const dir = path.join(PLAYERS_DIR, prefix);
  for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
    const uuid = fname.replace('.json', '');
    let player;
    try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
    const bk = player.sports?.Basketball;
    if (!bk || bk.wins || bk.losses || bk.draws) continue;
    if ((bk.gp || 0) < MIN_GP) continue;
    if (!(player.seasons?.length > 0)) continue;

    // Check if any season has multiple tids
    let hasMultiTid = false;
    for (const season of player.seasons) {
      if (!allSids.has(season.sid)) continue;
      const tids = new Set((season.regs || []).map(r => r.tid).filter(Boolean));
      if (tids.size > 1) { hasMultiTid = true; break; }
    }
    if (hasMultiTid) candidates.push({ uuid, gp: bk.gp, player });
  }
}

candidates.sort((a, b) => b.gp - a.gp);
const sample = candidates.slice(0, SAMPLE_SIZE);
console.log(`Found ${candidates.length} ambiguous candidates. Showing top ${sample.length}.\n`);

// ── Investigate each player ───────────────────────────────────────────────────

for (const { uuid, gp, player } of sample) {
  console.log('─'.repeat(70));
  console.log(`UUID: ${uuid}  GP=${gp}  name=${player.name || '(private)'}`);

  for (const season of (player.seasons || [])) {
    const sid = season.sid;
    if (!allSids.has(sid)) continue;
    const regs   = season.regs || [];
    const tids   = new Set(regs.map(r => r.tid).filter(Boolean));
    if (tids.size <= 1) continue; // only care about multi-tid seasons

    const sn = sportsIndex.seasons?.[sid]?.name || sid;
    console.log(`\n  Season: ${sn} (${sid})`);
    console.log(`  Regs (${regs.length}):`);
    for (const reg of regs) {
      const t = lookupTeam(reg.tid);
      console.log(`    tid=${reg.tid}  team="${t?.name || '?'}"  grade="${t?.gn || '?'}"  org="${t?.orgName || '?'}"  gp=${reg.stats?.gp || 0}`);
    }

    // Load game file and find games where both tids appear as h and a
    const gf = loadGameFile(sid);
    if (!gf) { console.log('  No game file'); continue; }

    const games = Object.values(gf.games || {});
    let ambigGames = 0, sampleShown = 0;

    for (const g of games) {
      const inP  = (g.p  || []).some(x => x.id === uuid);
      const inHp = (g.hp || []).some(x => x.profileID === uuid);
      const inAp = (g.ap || []).some(x => x.profileID === uuid);
      if (!inP && !inHp && !inAp) continue;

      const inHome = tids.has(g.h);
      const inAway = tids.has(g.a);
      if (!inHome || !inAway) continue; // not ambiguous
      ambigGames++;

      if (sampleShown < 3) {
        sampleShown++;
        const ht = lookupTeam(g.h);
        const at = lookupTeam(g.a);
        console.log(`  Ambiguous game sample:`);
        console.log(`    h=${g.h} "${ht?.name || '?'}" (grade: ${ht?.gn || '?'})`);
        console.log(`    a=${g.a} "${at?.name || '?'}" (grade: ${at?.gn || '?'})`);
        console.log(`    hs=${g.hs} as=${g.as}  inP=${inP} inHp=${inHp} inAp=${inAp}`);
      }
    }
    console.log(`  Total ambiguous games in season: ${ambigGames}/${games.length}`);
  }
  console.log();
}
