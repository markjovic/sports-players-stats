// scripts/diagnose-null-profiles.js
//
// Finds players who returned null from publicProfileStatistics (identified by
// absence of player.records which rebuild-player-stats writes on success) but
// who have meaningful stats stored in their player files.
//
// Outputs a sample for manual API testing to diagnose why they return null.
//
// Run: node scripts/diagnose-null-profiles.js [--sample=N] [--min-gp=N]

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

const args      = process.argv.slice(2);
const SAMPLE_N  = parseInt(args.find(a => a.startsWith('--sample='))?.split('=')[1]  ?? '30');
const MIN_GP    = parseInt(args.find(a => a.startsWith('--min-gp='))?.split('=')[1]  ?? '5');

console.log(`\ndiagnose-null-profiles | sample=${SAMPLE_N} min-gp=${MIN_GP}\n`);

const playersDir = path.join(ROOT, 'players');
const prefixes   = fs.readdirSync(playersDir).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();

let scanned = 0, withRecords = 0, nullWithStats = [];

for (const prefix of prefixes) {
  const prefDir = path.join(playersDir, prefix);
  for (const fname of fs.readdirSync(prefDir).filter(f => f.endsWith('.json'))) {
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(prefDir, fname), 'utf8')); } catch { continue; }
    scanned++;

    const bball = p.sports?.Basketball;
    if (!bball) continue;

    const gp   = bball.gp  ?? 0;
    const pts  = bball.pts ?? 0;
    const seasons = (p.seasons ?? []).length;

    if (p.statsChecked) {
      withRecords++;
      continue; // statsChecked = publicProfileStatistics returned data for this player
    }

    if (gp < MIN_GP) continue; // skip players with too few games

    nullWithStats.push({
      uuid:    p.uuid,
      name:    `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || '(no name)',
      gp,
      pts,
      fouls:   bball.fouls ?? 0,
      threePt: bball.threePt ?? 0,
      foulOuts:bball.foulOuts ?? 0,
      seasons,
      regs:    (p.seasons ?? []).flatMap(s => s.regs ?? []).length,
    });
  }
}

console.log(`Scanned           : ${scanned.toLocaleString()} players`);
console.log(`  statsChecked (API returned data) : ${withRecords.toLocaleString()}`);
console.log(`Null + stats≥${MIN_GP}gp: ${nullWithStats.length.toLocaleString()} players`);
console.log(`Null rate (est.)  : ${((scanned - withRecords) / scanned * 100).toFixed(1)}%\n`);

// Sort by gp descending — most active players first
nullWithStats.sort((a, b) => b.gp - a.gp);

// Sample: take from different points in the list for variety
const step    = Math.max(1, Math.floor(nullWithStats.length / SAMPLE_N));
const sample  = nullWithStats.filter((_, i) => i % step === 0).slice(0, SAMPLE_N);

console.log(`── Sample of ${sample.length} null-returning players with ≥${MIN_GP} recorded games ──\n`);
console.log('UUID                                  Name                    GP    PTS   Fouls  FO  Ssns');
console.log('─'.repeat(95));

for (const p of sample) {
  const name = p.name.padEnd(22).slice(0, 22);
  console.log(
    `${p.uuid}  ${name}  ${String(p.gp).padStart(4)}  ${String(p.pts).padStart(5)}  ` +
    `${String(p.fouls).padStart(5)}  ${String(p.foulOuts).padStart(2)}  ${String(p.seasons).padStart(4)}`
  );
}

console.log('\n── 10 UUIDs to manually test against publicProfileStatistics ────────────\n');
nullWithStats.slice(0, 10).forEach(p => console.log(`${p.uuid}  (${p.name}, ${p.gp} games, ${p.seasons} seasons)`));

console.log(`\n── Breakdown by games played ────────────────────────────────────────────\n`);
const buckets = { '1-4': 0, '5-9': 0, '10-19': 0, '20-49': 0, '50-99': 0, '100+': 0 };
for (const p of nullWithStats) {
  if      (p.gp < 5)   buckets['1-4']++;
  else if (p.gp < 10)  buckets['5-9']++;
  else if (p.gp < 20)  buckets['10-19']++;
  else if (p.gp < 50)  buckets['20-49']++;
  else if (p.gp < 100) buckets['50-99']++;
  else                  buckets['100+']++;
}
for (const [range, count] of Object.entries(buckets)) {
  console.log(`  ${range.padEnd(6)} games: ${count.toLocaleString()}`);
}
