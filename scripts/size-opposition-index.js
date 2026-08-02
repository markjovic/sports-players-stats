// scripts/size-opposition-index.js
//
// READ-ONLY sizer for the proposed opposition index (player -> opposing-team
// career W/L/D). Writes nothing, commits nothing, makes no network calls.
//
// ── Why this exists before the builder (2026-08-02) ─────────────────────────
// The proposed output is one record per (player, opposing tid) pair, sharded
// opposition/{2hex}.json keyed by full uuid. Back-of-envelope cardinality is
// ~4.1M regs x ~8-15 opponents per grade = tens of millions of pairs, i.e.
// possibly +1 GB of repo — leaderboard/season scale. But this repo's precedent
// for acting on an estimate-of-estimates is the UUID truncation migration:
// estimated ~1.78 GB, MEASURED 57.61 MB, wrong by 27x. So: measure, then build.
//
// What it measures (all from a REAL full-fidelity pass, not sampling the scan):
//   - exact distinct (player, oppTid) pair count, and the W/L/D tallies
//   - players with at least one pair; min/avg/max pairs per player
//   - REAL serialized bytes: 16 of the 256 shards are materialized in the exact
//     proposed output shape and JSON.stringify'd; total projected x16 (uuid hex
//     prefixes are uniform, so even-spread extrapolation is sound)
//   - peak RSS — the builder would hold the same accumulation, so this is also
//     the builder's memory feasibility number
//
// Classification is COPIED from build-win-loss.js (read in full 2026-08-02):
// same pre-pass uuid->sid->Set<tid> map, same hp/ap trusted-side path, same
// g.p[] fallback via the pre-pass map, same gameTids disambiguation for
// players registered to BOTH teams, same resolveToFullUuid on every id, same
// resultForTeam INCLUDING the forfeit exclusion (L55: forfeits contribute
// nothing — the opposition index inherits the W/L policy, deliberately).
// The one difference: the accumulation key is the OPPOSING tid, not the
// player's own, and the opponent's {sid, tn} is captured for display.
//
// Memory strategy (the part the builder will reuse): ids are interned to
// integers and pairs live in ONE Map<number,number> —
//   key   = uuidIdx * 2^20 + tidIdx      (both < 2^20 asserted; product < 2^40 < 2^53)
//   value = w * 2^20 + l * 2^10 + d      (each tally < 1024 asserted)
// ~45 B/entry, so even the pessimistic 33M pairs is ~1.5 GB — inside a runner
// with --max-old-space-size (the workflow sets 12 GB).
//
// Usage: node --max-old-space-size=12288 scripts/size-opposition-index.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { resolveToFullUuid } = require('./lib/uuid-prefix.cjs');

const ROOT        = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const GAMES_DIR   = path.join(ROOT, 'games', 'bv');

const SAMPLE_SHARDS = 16;         // materialize every 16th shard: 00,10,...,f0
const IDX_BITS = 20, IDX_CAP = 1 << IDX_BITS;
const TALLY_BITS = 10, TALLY_CAP = 1 << TALLY_BITS;

// ─── resultForTeam — VERBATIM from build-win-loss.js ─────────────────────────
function resultForTeam(g, tid) {
  let myS, oppS;
  if      (g.h === tid) { myS = g.hs; oppS = g.as; }
  else if (g.a === tid) { myS = g.as; oppS = g.hs; }
  else return null;
  if (myS == null || oppS == null) return null;
  if (g.forfeit) return null;
  if (myS > oppS) return 'W';
  if (myS < oppS) return 'L';
  return 'D';
}

// ─── interning ────────────────────────────────────────────────────────────────
const uuidIdx = new Map(); const uuids = [];
const tidIdx  = new Map(); const tids  = [];
function iUuid(u) { let i = uuidIdx.get(u); if (i === undefined) { i = uuids.length; if (i >= IDX_CAP) throw new Error('uuid intern overflow — raise IDX_BITS'); uuids.push(u); uuidIdx.set(u, i); } return i; }
function iTid(t)  { let i = tidIdx.get(t);  if (i === undefined) { i = tids.length;  if (i >= IDX_CAP) throw new Error('tid intern overflow — raise IDX_BITS');  tids.push(t);  tidIdx.set(t, i); }  return i; }

const pairs   = new Map();   // uuidIdx*2^20+tidIdx -> w*2^20+l*2^10+d
const tidMeta = new Map();   // tidIdx -> { sid, tn }  (latest seen wins)

function accumulate(uuid, oppTid, res, sid, oppName) {
  const ui = iUuid(uuid), ti = iTid(oppTid);
  const key = ui * IDX_CAP + ti;
  let v = pairs.get(key) || 0;
  const w = v >>> IDX_BITS, l = (v >>> TALLY_BITS) & (TALLY_CAP - 1), d = v & (TALLY_CAP - 1);
  if (res === 'W') { if (w + 1 >= TALLY_CAP) throw new Error('tally overflow'); v = (w + 1) * IDX_CAP + l * TALLY_CAP + d; }
  else if (res === 'L') { if (l + 1 >= TALLY_CAP) throw new Error('tally overflow'); v = w * IDX_CAP + (l + 1) * TALLY_CAP + d; }
  else { if (d + 1 >= TALLY_CAP) throw new Error('tally overflow'); v = w * IDX_CAP + l * TALLY_CAP + (d + 1); }
  pairs.set(key, v);
  if (!tidMeta.has(ti) && (sid || oppName)) tidMeta.set(ti, { sid, tn: oppName || null });
}

// ─── main ─────────────────────────────────────────────────────────────────────
function main() {
  const t0 = Date.now();
  console.log('size-opposition-index.js — READ-ONLY, writes nothing');
  console.log('─'.repeat(60));

  const sportsIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sports-index.json'), 'utf8'));
  const allSids = Object.keys(sportsIndex.seasons || {});
  console.log(`  Seasons: ${allSids.length} (FULL scan — career scope)`);

  // Pre-pass — copied shape from build-win-loss.js: uuid -> Map<sid, Set<tid>>
  // (+ gameTids attached), needed to classify g.p[] entries that carry no side.
  console.log('\n  Pre-pass: building player→season→team map…');
  const playerTids = new Map();
  const prefixes = fs.readdirSync(PLAYERS_DIR).filter(d => /^[0-9a-f]{2}$/.test(d)).sort();
  let prePassCount = 0;
  for (const prefix of prefixes) {
    const dir = path.join(PLAYERS_DIR, prefix);
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('index'))) {
      const uuid = fname.replace('.json', '');
      let player;
      try { player = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
      if (!player.sports?.Basketball) continue;
      const sidMap = new Map();
      for (const season of (player.seasons || [])) {
        for (const reg of (season.regs || [])) {
          if (!reg.tid) continue;
          if (!sidMap.has(season.sid)) sidMap.set(season.sid, new Set());
          sidMap.get(season.sid).add(reg.tid);
        }
      }
      if (sidMap.size > 0) {
        sidMap.gameTids = player.gameTids || null;
        playerTids.set(uuid, sidMap);
      }
      prePassCount++;
      if (prePassCount % 50000 === 0) process.stdout.write(`  Pre-pass: ${prePassCount} players…\r`);
    }
  }
  console.log(`  Pre-pass complete: ${prePassCount} players, ${playerTids.size} with regs`);

  // Game pass — build-win-loss.js Pass 1, with the accumulation key flipped to
  // the OPPOSING tid.
  console.log('\n  Game pass: scanning season files…');
  let gamesScanned = 0, seasonsScanned = 0, hpApGames = 0, pFallbackGames = 0, skippedGames = 0, unresolved = 0;

  for (const sid of allSids) {
    const f = path.join(GAMES_DIR, `${sid}.json`);
    if (!fs.existsSync(f)) continue;
    let gf;
    try { gf = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    seasonsScanned++;
    for (const g of Object.values(gf.games || {})) {
      gamesScanned++;
      const hasHpAp = (g.hp && g.hp.length > 0) || (g.ap && g.ap.length > 0);
      if (hasHpAp) {
        hpApGames++;
        for (const { players, tid, oppTid, oppName } of [
          { players: g.hp || [], tid: g.h, oppTid: g.a, oppName: g.an || g.t2n || null },
          { players: g.ap || [], tid: g.a, oppTid: g.h, oppName: g.hn || g.t1n || null },
        ]) {
          if (!tid || !oppTid || !players.length) continue;
          const res = resultForTeam(g, tid);
          if (!res) continue;
          for (const p of players) {
            if (!p.profileID) continue;
            const full = resolveToFullUuid(p.profileID, ROOT);
            if (!full) { unresolved++; continue; }
            accumulate(full, oppTid, res, sid, oppName);
          }
        }
      } else if (g.p && g.p.length > 0) {
        let usedFallback = false;
        for (const p of g.p) {
          if (!p.id) continue;
          const uuid = resolveToFullUuid(p.id, ROOT);
          if (!uuid) { unresolved++; continue; }
          const sidMap = playerTids.get(uuid);
          if (!sidMap) continue;
          const ptids = sidMap.get(sid);
          if (!ptids) continue;
          const inHome = ptids.has(g.h), inAway = ptids.has(g.a);
          if (!inHome && !inAway) continue;
          let matchedTid;
          if (inHome && inAway) {
            const gameId = g.id || null;
            const resolved = gameId && sidMap.gameTids ? (sidMap.gameTids[gameId] || null) : null;
            if (!resolved) continue;
            matchedTid = resolved;
          } else {
            matchedTid = inHome ? g.h : g.a;
          }
          const res = resultForTeam(g, matchedTid);
          if (!res) continue;
          const oppTid  = matchedTid === g.h ? g.a : g.h;
          const oppName = matchedTid === g.h ? (g.an || g.t2n || null) : (g.hn || g.t1n || null);
          if (!oppTid) continue;
          accumulate(uuid, oppTid, res, sid, oppName);
          usedFallback = true;
        }
        if (usedFallback) pFallbackGames++; else skippedGames++;
      } else skippedGames++;
    }
    if (seasonsScanned % 200 === 0) process.stdout.write(`  ${seasonsScanned} seasons, ${pairs.size} pairs…\r`);
  }

  // ── measurement ──
  console.log(`\n  Scanned ${seasonsScanned} seasons, ${gamesScanned} games`);
  console.log(`    hp/ap: ${hpApGames}  p[] fallback: ${pFallbackGames}  skipped: ${skippedGames}  unresolved ids: ${unresolved}`);

  const pairsPerPlayer = new Map();
  for (const key of pairs.keys()) {
    const ui = Math.floor(key / IDX_CAP);
    pairsPerPlayer.set(ui, (pairsPerPlayer.get(ui) || 0) + 1);
  }
  let maxPairs = 0, sumPairs = 0;
  for (const n of pairsPerPlayer.values()) { sumPairs += n; if (n > maxPairs) maxPairs = n; }

  // Materialize every 16th shard in the EXACT proposed output shape and measure
  // real serialized bytes: opposition/{xx}.json = { uuid: { oppTid: {w,l,d,sid,tn} } }
  console.log(`\n  Materializing ${SAMPLE_SHARDS} sample shards for real byte counts…`);
  const sampleShards = new Set();
  for (let i = 0; i < 256; i += 256 / SAMPLE_SHARDS) sampleShards.add(i.toString(16).padStart(2, '0'));
  const shardObjs = new Map([...sampleShards].map(s => [s, {}]));
  for (const [key, v] of pairs) {
    const ui = Math.floor(key / IDX_CAP), ti = key % IDX_CAP;
    const uuid = uuids[ui];
    const shard = uuid.slice(0, 2);
    if (!shardObjs.has(shard)) continue;
    const o = shardObjs.get(shard);
    if (!o[uuid]) o[uuid] = {};
    const meta = tidMeta.get(ti) || {};
    const w = v >>> IDX_BITS, l = (v >>> TALLY_BITS) & (TALLY_CAP - 1), d = v & (TALLY_CAP - 1);
    const rec = {};
    if (w) rec.w = w;
    if (l) rec.l = l;
    if (d) rec.d = d;
    if (meta.sid) rec.sid = meta.sid;
    if (meta.tn)  rec.tn = meta.tn;
    o[uuid][tids[ti]] = rec;
  }
  let sampleBytes = 0, sampleFiles = 0, largest = 0, largestShard = '';
  for (const [s, o] of shardObjs) {
    const b = Buffer.byteLength(JSON.stringify(o));
    sampleBytes += b; sampleFiles++;
    if (b > largest) { largest = b; largestShard = s; }
  }
  const projectedTotal = Math.round(sampleBytes * (256 / sampleFiles));
  const peakRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';

  const L = [];
  L.push('');
  L.push('MEASURED (full-fidelity pass — the builder would produce exactly this):');
  L.push(`  distinct (player, oppTid) pairs   : ${pairs.size.toLocaleString()}`);
  L.push(`  players with >=1 pair             : ${pairsPerPlayer.size.toLocaleString()}`);
  L.push(`  pairs per player (avg / max)      : ${(sumPairs / Math.max(1, pairsPerPlayer.size)).toFixed(1)} / ${maxPairs}`);
  L.push(`  distinct opposing tids            : ${tids.length.toLocaleString()}`);
  L.push('');
  L.push(`  sample shards serialized          : ${sampleFiles} of 256 (every 16th — uuid prefixes are uniform)`);
  L.push(`  sample bytes                      : ${mb(sampleBytes)}   largest shard ${largestShard}: ${mb(largest)}`);
  L.push(`  >> PROJECTED TOTAL (256 shards)   : ${mb(projectedTotal)}`);
  L.push('');
  L.push(`  peak RSS (== builder feasibility) : ${peakRssMb} MB`);
  L.push(`  wall time                         : ${Math.round((Date.now() - t0) / 60000)} min`);
  L.push('');
  L.push('DECISION INPUTS:');
  L.push('  repo is 6.13 GB; leaderboard/season is 944 MB. Compare PROJECTED TOTAL to');
  L.push('  those before building. Per-player average x ~45 B is the per-fetch cost a');
  L.push('  StatTrack shard download would carry.');
  const out = L.join('\n');
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + out + '\n```\n'); } catch (_) {}
  }
}

main();
