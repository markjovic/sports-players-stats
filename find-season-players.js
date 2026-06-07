#!/usr/bin/env node
// find-season-players.js — find players who have a given season ID in their history
// Usage: node find-season-players.js --season=0220156b --limit=5

'use strict';
const fs   = require('fs');
const path = require('path');

const SEASON_ID   = process.argv.find(a => a.startsWith('--season='))?.split('=')[1];
const GAME_ID     = process.argv.find(a => a.startsWith('--game='))?.split('=')[1];
const LIMIT       = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '10', 10);
const PLAYERS_DIR = path.join(__dirname, 'players');

if (!SEASON_ID && !GAME_ID) { console.error('--season=<id> or --game=<id> required'); process.exit(1); }

if (GAME_ID) {
  // Find players who have this specific game ID in their game history
  console.log(`Searching for players with game ${GAME_ID}...`);
  const found = [];
  const shards = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/i.test(d));
  outer:
  for (const shard of shards) {
    const dir = path.join(PLAYERS_DIR, shard);
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      let detail;
      try { detail = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (e) { continue; }
      for (const season of (detail.seasons || [])) {
        for (const reg of (season.regs || [])) {
          for (const game of (reg.games || [])) {
            if (game.gid === GAME_ID) {
              found.push({
                uuid:   detail.uuid,
                name:   detail.name,
                url:    `https://www.playhq.com/public/profile/${detail.uuid}/statistics`,
                season: season.sn,
                team:   reg.tn,
                grade:  reg.gn,
                game,
              });
              if (found.length >= LIMIT) break outer;
            }
          }
        }
      }
    }
  }
  console.log(`\nFound ${found.length} players:\n`);
  for (const p of found) {
    console.log(`${p.name} — ${p.team} | ${p.grade} | ${p.season}`);
    console.log(`  ${p.url}`);
    console.log(`  Game: ${p.game.gid} | date=${p.game.d} | opp=${p.game.on} | pts=${p.game.pts}`);
    console.log();
  }
  process.exit(0);
}

console.log(`Searching for players with season ${SEASON_ID}...`);

const found = [];
const shards = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/i.test(d));

outer:
for (const shard of shards) {
  const dir = path.join(PLAYERS_DIR, shard);
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    let detail;
    try { detail = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (e) { continue; }
    for (const season of (detail.seasons || [])) {
      if (season.sid === SEASON_ID) {
        found.push({
          uuid:  detail.uuid,
          name:  detail.name,
          url:   `https://www.playhq.com/public/profile/${detail.uuid}/statistics`,
          regs:  season.regs?.map(r => ({ team: r.tn, grade: r.gn, gp: r.stats?.gp })),
        });
        if (found.length >= LIMIT) break outer;
        break;
      }
    }
  }
}

console.log(`\nFound ${found.length} players:\n`);
for (const p of found) {
  console.log(`${p.name}`);
  console.log(`  ${p.url}`);
  for (const r of (p.regs || [])) {
    console.log(`  ${r.team} | ${r.grade} | ${r.gp} GP`);
  }
  console.log();
}
