// scripts/verify-p-redundancy.js
//
// One-off diagnostic (read-only — no git writes) for the flagged-but-unverified
// question in README.md/claude_context.md: is g.p[] fully redundant with
// g.hp[]+g.ap[] for games where a box score has been fetched (spc:1)? This
// scans EVERY game in EVERY games/bv/{seasonId}.json file by default — not a
// sample — so the answer is a real population-wide count, not an N=1 guess.
//
// It also separately measures games where p[] is populated WITHOUT a box
// score yet (spc !== 1) — the case the docs flag as the reason p[] can't be
// blindly dropped everywhere even if it looks redundant elsewhere.
//
// Usage:
//   node scripts/verify-p-redundancy.js                — full scan, every season file
//   node scripts/verify-p-redundancy.js --seasons=5     — only first 5 season files (quick smoke test)
//   node scripts/verify-p-redundancy.js --examples=5    — raw example games kept per category (default 5)
//
// Writes p-redundancy-examples.json (raw sample games per category) to ROOT
// for the workflow to upload as a build artifact — this script does not commit
// anything, it's a diagnostic only.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);

function argNum(name, def) {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? parseInt(hit.split('=')[1], 10) : def;
}

const SEASON_LIMIT = argNum('seasons', Infinity);
const EXAMPLES_PER_CATEGORY = argNum('examples', 5);

const gamesDir = path.join(ROOT, 'games', 'bv');
let seasonFiles = fs.readdirSync(gamesDir).filter((f) => f.endsWith('.json'));
if (Number.isFinite(SEASON_LIMIT)) seasonFiles = seasonFiles.slice(0, SEASON_LIMIT);

let totalGames = 0;
let boxScoreGames = 0; // spc === 1
let boxScoreWithP = 0; // spc===1 && p[] present
let exactMatch = 0; // p ids === hp+ap ids exactly
let pSupersetOnly = 0; // p has every hp+ap id, plus extras
let hpApSupersetOnly = 0; // hp+ap has every p id, plus extras (p is missing some)
let mismatch = 0; // neither side is a subset of the other
let noBoxScoreWithP = 0; // spc !== 1 && p[] present — the case that blocks a blind drop
let noBoxScoreNoP = 0; // spc !== 1 && no p[] at all

const examples = { exactMatch: [], pSupersetOnly: [], hpApSupersetOnly: [], mismatch: [], noBoxScoreWithP: [] };

function pushExample(category, seasonId, gameId, g) {
  if (examples[category].length < EXAMPLES_PER_CATEGORY) {
    examples[category].push({ seasonId, gameId, game: g });
  }
}

for (const file of seasonFiles) {
  const seasonId = file.replace('.json', '');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(gamesDir, file), 'utf8'));
  } catch {
    continue;
  }
  if (!data || !data.games) continue;

  for (const [gameId, g] of Object.entries(data.games)) {
    totalGames++;
    const hasP = Array.isArray(g.p) && g.p.length > 0;
    const hasBoxScore = g.spc === 1;

    if (hasBoxScore) {
      boxScoreGames++;
      if (hasP) {
        boxScoreWithP++;
        const pIds = new Set(g.p.map((x) => x && x.id).filter(Boolean));
        const hpApIds = new Set([
          ...(g.hp || []).map((x) => x && x.profileID).filter(Boolean),
          ...(g.ap || []).map((x) => x && x.profileID).filter(Boolean),
        ]);
        const pExtra = [...pIds].filter((id) => !hpApIds.has(id));
        const hpApExtra = [...hpApIds].filter((id) => !pIds.has(id));

        if (pExtra.length === 0 && hpApExtra.length === 0) {
          exactMatch++;
          pushExample('exactMatch', seasonId, gameId, g);
        } else if (pExtra.length > 0 && hpApExtra.length === 0) {
          pSupersetOnly++;
          pushExample('pSupersetOnly', seasonId, gameId, g);
        } else if (pExtra.length === 0 && hpApExtra.length > 0) {
          hpApSupersetOnly++;
          pushExample('hpApSupersetOnly', seasonId, gameId, g);
        } else {
          mismatch++;
          pushExample('mismatch', seasonId, gameId, g);
        }
      }
    } else if (hasP) {
      noBoxScoreWithP++;
      pushExample('noBoxScoreWithP', seasonId, gameId, g);
    } else {
      noBoxScoreNoP++;
    }
  }
}

function pct(n, d) {
  return d === 0 ? '—' : ((n / d) * 100).toFixed(1) + '%';
}

console.log('\n📋 p[] vs hp[]+ap[] redundancy check');
console.log('═'.repeat(60));
console.log(`  Season files scanned................  ${seasonFiles.length}`);
console.log(`  Total games..........................  ${totalGames}`);
console.log('');
console.log(`  Games with box score (spc:1).........  ${boxScoreGames}  (${pct(boxScoreGames, totalGames)})`);
console.log(`    ...and also have p[]...............  ${boxScoreWithP}  (${pct(boxScoreWithP, boxScoreGames)} of box-score games)`);
console.log(`      Exact match (p === hp+ap)..........  ${exactMatch}  (${pct(exactMatch, boxScoreWithP)})`);
console.log(`      p[] has extras beyond hp+ap........  ${pSupersetOnly}  (${pct(pSupersetOnly, boxScoreWithP)})`);
console.log(`      hp+ap has extras beyond p[]........  ${hpApSupersetOnly}  (${pct(hpApSupersetOnly, boxScoreWithP)})`);
console.log(`      Genuine mismatch (both sides)......  ${mismatch}  (${pct(mismatch, boxScoreWithP)})`);
console.log('');
console.log(`  Games WITHOUT box score (spc!==1)....  ${totalGames - boxScoreGames}`);
console.log(`    ...but p[] IS populated..............  ${noBoxScoreWithP}  ⚠️  these need p[] — can't blindly drop it`);
console.log(`    ...and p[] is empty/absent too........  ${noBoxScoreNoP}`);
console.log('');
console.log('  Verdict:');
if (mismatch === 0 && pSupersetOnly === 0 && noBoxScoreWithP === 0) {
  console.log('  ✅ p[] appears FULLY redundant with hp[]+ap[] whenever a box score exists, and');
  console.log('     no games were found with p[] populated ahead of a box score.');
} else {
  console.log('  ⚠️  p[] is NOT safely droppable everywhere — see counts above for why.');
}
console.log('═'.repeat(60));

// Raw example games per category, written for the workflow to upload as a
// build artifact — for a human/LLM to sanity-check the aggregate counts
// against real structure, not just trust the tally blind. Not committed.
const outPath = path.join(ROOT, 'p-redundancy-examples.json');
fs.writeFileSync(outPath, JSON.stringify(examples, null, 2));
const exampleCount = Object.values(examples).reduce((a, e) => a + e.length, 0);
console.log(`\n  Wrote ${exampleCount} raw example games to ${path.relative(ROOT, outPath)}`);
console.log('  (uploaded as a workflow artifact — this script does not commit anything)');
