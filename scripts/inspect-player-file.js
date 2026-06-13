#!/usr/bin/env node
// inspect-player-file.js
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// Inspect a specific player file to understand what per-game data is stored
const UUID = process.argv[2] || '366f654d-c574-4317-ba5d-2c8b524b98f8'; // Sam Burdan

const file = path.join(ROOT, 'players', UUID.slice(0, 2), `${UUID}.json`);
if (!fs.existsSync(file)) { console.error(`Not found: ${file}`); process.exit(1); }

const p = JSON.parse(fs.readFileSync(file, 'utf8'));

console.log('\nPlayer:', p.name || '(private)');
console.log('UUID:', p.uuid);
console.log('Top-level keys:', Object.keys(p).join(', '));
console.log('Season count:', (p.seasons || []).length);

// Show first season in detail
const s = (p.seasons || [])[0];
if (!s) { console.log('No seasons'); process.exit(0); }

console.log('\nFirst season:', s.sid, s.sn);
console.log('Season keys:', Object.keys(s).join(', '));

const r = (s.regs || [])[0];
if (!r) { console.log('No regs'); process.exit(0); }

console.log('\nFirst reg keys:', Object.keys(r).join(', '));
console.log('Reg (no games array):', JSON.stringify({ ...r, games: r.games ? `[${r.games.length} entries]` : undefined }));

// Show what games array looks like if present
if (r.games?.length) {
  console.log('\nGames array present:', r.games.length, 'entries');
  console.log('games[0]:', JSON.stringify(r.games[0]));
  console.log('games[1]:', JSON.stringify(r.games[1]));
} else {
  console.log('\nNo games array on reg — only aggregate stats');
}
