// scripts/redirect-exposure.js
//
// READ-ONLY diagnostic (2026-07-16). The retrofitted nightly reported
// "redirected = 0" across 15,224 players, against a naive base-rate
// expectation of ~9.5% (43k redirect entries / 452k aliases). Two hypotheses:
//   H1: the resolver's redirect path silently fails in production.
//   H2: divergence is legacy-skewed — currently ACTIVE players are ~0%
//       diverged, so zero redirects at runtime is correct.
// This script discriminates them from data: for every distinct player id in
// ACTIVE-season game files (p[].id, hp[]/ap[].profileID — the exact fields
// the nightly and the builders consume), classify its alias entry:
//   redirect  -> alias maps it to a DIFFERENT api id  (H1 evidence if many)
//   identity  -> alias maps it to itself
//   missing   -> no alias entry at this key
// Also cross-checks each redirect via resolveToFullUuid() itself, so a
// nonzero redirect population with a broken resolver is caught directly.
//
// Writes nothing, commits nothing. Summary to stdout + GITHUB_STEP_SUMMARY.
//
// Usage: node scripts/redirect-exposure.js [--all-seasons]

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveToFullUuid, TRUNC_LEN } = require('./lib/uuid-prefix.cjs');

const ROOT = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games', 'bv');
const ALIASES_DIR = path.join(ROOT, 'players', 'aliases');
const ALL_SEASONS = process.argv.includes('--all-seasons');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function log(msg) { console.log(`[exposure] ${new Date().toISOString()} ${msg}`); }

function main() {
  const sportsIndex = readJson(path.join(ROOT, 'data', 'sports-index.json'));
  const seasons = Object.values(sportsIndex.seasons || {});
  const targetSids = ALL_SEASONS
    ? seasons.map(s => s.id)
    : seasons.filter(s => s.locked === false).map(s => s.id);
  log(`seasons: ${targetSids.length} (${ALL_SEASONS ? 'all' : 'active only'})`);

  // 1) collect distinct ids from game files (both truncated p[] ids and
  //    full hp/ap profileIDs appear here — keep them as observed)
  const ids = new Set();
  let gameFiles = 0, games = 0;
  for (const sid of targetSids) {
    const f = path.join(GAMES_DIR, `${sid}.json`);
    if (!fs.existsSync(f)) continue;
    let gf;
    try { gf = readJson(f); } catch { continue; }
    gameFiles++;
    for (const g of Object.values(gf.games || {})) {
      games++;
      for (const e of (g.p || [])) if (e && typeof e.id === 'string') ids.add(e.id);
      for (const e of (g.hp || [])) if (e && typeof e.profileID === 'string') ids.add(e.profileID);
      for (const e of (g.ap || [])) if (e && typeof e.profileID === 'string') ids.add(e.profileID);
    }
  }
  log(`game files: ${gameFiles}, games: ${games}, distinct ids observed: ${ids.size}`);

  // 2) load the full alias index once (forward map, trunc13 keys)
  const aliases = new Map();
  for (const f of fs.readdirSync(ALIASES_DIR).filter(f => /^[0-9a-f]{2}\.json$/.test(f))) {
    const m = readJson(path.join(ALIASES_DIR, f));
    for (const [k, v] of Object.entries(m)) aliases.set(k, v);
  }
  log(`alias entries loaded: ${aliases.size}`);

  // 3) classify every observed id + verify the resolver agrees on redirects
  let redirect = 0, identity = 0, missing = 0, badLen = 0;
  let resolverAgrees = 0, resolverDisagrees = 0;
  const redirectSample = [], disagreeSample = [];

  for (const id of ids) {
    const key = id.length >= TRUNC_LEN ? id.slice(0, TRUNC_LEN) : null;
    const v = key ? aliases.get(key) : undefined;
    if (!key) { badLen++; continue; }
    if (v === undefined) {
      // legacy 10-char ids won't hit a 13-char key directly — prefix-scan
      if (id.length < TRUNC_LEN) {
        let hit;
        for (const [k2, v2] of aliases) {
          if (k2.startsWith(id)) { hit = hit === undefined ? v2 : (hit === v2 ? hit : null); }
        }
        if (hit === undefined) { missing++; continue; }
        if (hit === null) { badLen++; continue; } // ambiguous
        if (hit.slice(0, id.length) === id) { identity++; continue; }
        redirect++;
        if (redirectSample.length < 15) redirectSample.push(`${id} -> ${hit}`);
        const r = resolveToFullUuid(id, ROOT);
        if (r === hit) resolverAgrees++;
        else { resolverDisagrees++; if (disagreeSample.length < 10) disagreeSample.push(`${id}: alias=${hit} resolver=${r}`); }
        continue;
      }
      missing++;
      continue;
    }
    if (v.slice(0, key.length) === key) { identity++; continue; }
    redirect++;
    if (redirectSample.length < 15) redirectSample.push(`${id} -> ${v}`);
    // the critical cross-check: does the RESOLVER return the redirect target?
    const r = resolveToFullUuid(id, ROOT);
    if (r === v) resolverAgrees++;
    else { resolverDisagrees++; if (disagreeSample.length < 10) disagreeSample.push(`${id}: alias=${v} resolver=${r}`); }
  }

  const L = [];
  L.push(`## redirect exposure — ${ALL_SEASONS ? 'ALL' : 'ACTIVE'} seasons`);
  L.push('');
  L.push('| metric | value |');
  L.push('| --- | --- |');
  L.push(`| distinct ids in game files | ${ids.size.toLocaleString()} |`);
  L.push(`| identity (id == api id) | ${identity.toLocaleString()} |`);
  L.push(`| **redirect (diverged)** | **${redirect.toLocaleString()}** |`);
  L.push(`| missing from aliases | ${missing.toLocaleString()} |`);
  L.push(`| bad/ambiguous length | ${badLen.toLocaleString()} |`);
  L.push(`| resolver agrees on redirects | ${resolverAgrees.toLocaleString()} |`);
  L.push(`| **resolver DISAGREES** | **${resolverDisagrees.toLocaleString()}** |`);
  L.push('');
  if (redirect === 0) {
    L.push('**Verdict: H2** — no diverged ids exist in these game files at all; the nightly\'s redirected=0 is correct, divergence is legacy-skewed.');
  } else if (resolverDisagrees === 0) {
    L.push(`**Verdict: resolver healthy** — ${redirect.toLocaleString()} redirects exist and the resolver returns the right target for every one. If the nightly still printed redirected=0, the diverged players simply did not play that night (check redirect count vs active-player overlap).`);
  } else {
    L.push('**Verdict: H1 — RESOLVER BUG.** Redirects exist that the resolver does not follow. Samples below; do not unfreeze.');
  }
  if (redirectSample.length) {
    L.push('', '### redirect samples', '```', ...redirectSample, '```');
  }
  if (disagreeSample.length) {
    L.push('', '### resolver disagreements (BUG evidence)', '```', ...disagreeSample, '```');
  }
  const summary = L.join('\n') + '\n';
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary); } catch (_) {}
  }
}

main();
