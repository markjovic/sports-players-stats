#!/usr/bin/env node
// find-missing-team-players.js

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; })
);

const CONCURRENCY  = parseInt(ARGS.concurrency || '32', 10);
const PLAYERS_DIR  = path.join(__dirname, 'players');
const OUTPUT_FILE  = path.join(__dirname, 'missing-team-players.json');

function loadSeasonIds(file) {
  if (!fs.existsSync(file)) { console.warn(`  ⚠ ${file} not found, skipping`); return new Map(); }
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = new Map();
  for (const s of arr) map.set(s.id, { id: s.id, name: s.name, org: s.org, comp: s.comp });
  return map;
}

const zeroTeamSeasons  = loadSeasonIds(path.join(__dirname, 'zero-team-seasons.json'));
const noLadderSeasons  = loadSeasonIds(path.join(__dirname, 'no-ladder-seasons.json'));
const targetSeasons = new Map([...zeroTeamSeasons, ...noLadderSeasons]);

console.log(`\n🔍 Find Missing Team Players`);
console.log(`   Unique target seasons: ${targetSeasons.size.toLocaleString()}\n`);

if (targetSeasons.size === 0) {
  console.log('❌ No target seasons found — check input files');
  process.exit(1);
}

console.log('   Scanning hex shard folders (00 to ff)...');

const allFiles = [];
if (fs.existsSync(PLAYERS_DIR)) {
  const shards = fs.readdirSync(PLAYERS_DIR);
  for (const shard of shards) {
    const shardPath = path.join(PLAYERS_DIR, shard);
    if (shard.length === 2 && fs.statSync(shardPath).isDirectory()) {
      const files = fs.readdirSync(shardPath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          allFiles.push(path.join(shardPath, file));
        }
      }
    }
  }
}

console.log(`   Found ${allFiles.length.toLocaleString()} total player files across shards\n`);

// ─── Unique Season Tracking ──────────────────────────────────────────────────
const matchesBySeason = new Map(); // Key: sid -> Value: player details
let processed = 0;

async function processFile(filePath) {
  // Performance optimization: If we have already filled all target seasons, 
  // we can stop reading the remaining files in the queue entirely.
  if (matchesBySeason.size >= targetSeasons.size) return;

  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const player = JSON.parse(raw);
    const uuid   = player.uuid;
    const name   = player.name;

    if (!uuid || !Array.isArray(player.seasons)) return;

    for (const season of player.seasons) {
      const sid = season.sid;
      if (!targetSeasons.has(sid)) continue;

      // ─── CRITICAL CHANGE: FIRST PLAYER PER SEASON ID ONLY ───
      // If we already have a sample player for this season, skip it completely
      if (matchesBySeason.has(sid)) continue;

      const meta = targetSeasons.get(sid);
      matchesBySeason.set(sid, {
        uuid,
        name,
        sid,
        sn:     season.sn   || meta.name,
        club:   season.club || null,
        org:    meta.org    || null,
        comp:   meta.comp   || null,
        source: [
          zeroTeamSeasons.has(sid)  ? 'zero-team'  : null,
          noLadderSeasons.has(sid)  ? 'no-ladder'  : null,
        ].filter(Boolean),
      });
    }
  } catch (e) {}
}

async function worker(iterator) {
  for (const filePath of iterator) {
    // Early exit worker loop if all possible seasons are matched
    if (matchesBySeason.size >= targetSeasons.size) break;

    await processFile(filePath);
    processed++;
    if (processed % 10000 === 0 || processed === allFiles.length) {
      const pct = ((processed / allFiles.length) * 100).toFixed(1);
      process.stdout.write(`   Progress: ${processed.toLocaleString()}/${allFiles.length.toLocaleString()} (${pct}%) — ${matchesBySeason.size} seasons anchored\r`);
    }
  }
}

async function runPool() {
  const iterator = allFiles[Symbol.iterator]();
  const pool = Array(CONCURRENCY).fill(iterator).map(worker);
  await Promise.all(pool);
  
  console.log(`\n\n✅ Scan complete. Finalizing output...`);

  // Convert map values to array list
  const finalizedMatches = Array.from(matchesBySeason.values());

  // Sort logically by season name then player name
  finalizedMatches.sort((a, b) => {
    const s = (a.sn || '').localeCompare(b.sn || '');
    return s !== 0 ? s : (a.name || '').localeCompare(b.name || '');
  });

  const output = {
    generatedAt:   new Date().toISOString(),
    targetSeasons: targetSeasons.size,
    seasonsFound:  finalizedMatches.length,
    players:       finalizedMatches,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`   ✓ Clean summary file saved to ${OUTPUT_FILE}`);

  try {
    execSync('git add missing-team-players.json', { stdio: 'pipe' });
    const diff = execSync('git diff --staged --stat', { stdio: 'pipe' }).toString().trim();
    if (diff) {
      execSync(`git commit -m "Find missing unique team anchor players: ${finalizedMatches.length} seasons mapped"`, { stdio: 'pipe' });
      execSync('git pull --rebase=false --no-edit -X ours', { stdio: 'pipe' });
      execSync('git push', { stdio: 'pipe' });
      console.log('   ✓ Changes committed and cleanly pushed');
    } else {
      console.log('   (no changes to commit)');
    }
  } catch (e) {
    console.warn(`   Local git warning: ${e.message}`);
  }
}

runPool().catch(e => { console.error(`\n❌ Fatal: ${e.message}`); process.exit(1); });