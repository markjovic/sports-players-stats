// scripts/classify-flagged-merges.js
//
// 3b-2 review aid (READ-ONLY). Buckets every merge group in
// reports/rekey-merges.json so the flagged list can be triaged by shape instead
// of eyeballed row by row. Reads ONLY that one report — no player files — so it
// runs off a sparse checkout of reports/ + scripts/.
//
// Buckets (disjoint, cover all merge groups):
//   CLEAN : not flagged (all records identical) — no review needed
//   C     : flagged AND names disagree after normalization — possible different
//           people under one api id; the real review
//   B     : flagged, names agree, but 2+ records tie at the top game count —
//           no unique most-complete record, keeper is an arbitrary tie-break;
//           re-fetch resolves it (e.g. Xavier Heafield 4/4/4/2)
//   A     : flagged, names agree, keeper strictly beats every drop on games —
//           keep-most-complete is correct
//
// Hint metadata (not buckets): narrowMargin (A where keeper barely beats top
// drop) and apiRecordIsKeeper (false = the canonical api profile is LESS complete
// than a duplicate — a re-fetch signal).

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MERGES_FILE = path.join(ROOT, 'reports', 'rekey-merges.json');
const OUT = path.join(ROOT, 'reports', 'rekey-flagged-classified.json');

const NARROW = 2; // A entries where (keeperGames - maxDropGames) <= NARROW get a hint flag

// Copied VERBATIM from rekey-plan.js — must match the plan's own flagging exactly.
function normName(s) {
  return String(s || '').normalize('NFKC').replace(/[\u2018\u2019]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim();
}

function classify(m) {
  const apiId = m.apiId;
  const recs = [m.keep, ...m.drop];
  const keeperGames = m.keep.games;
  const dropGames = m.drop.map(d => d.games);
  const maxDrop = dropGames.length ? Math.max(...dropGames) : 0;
  const margin = keeperGames - maxDrop;
  const tiedAtMax = recs.filter(r => r.games === keeperGames).length; // includes keeper
  const keeperIsApi = m.keep.key === apiId;
  const apiRec = recs.find(r => r.key === apiId) || null;
  const normNames = [...new Set(recs.map(r => normName(r.name)))];

  let bucket;
  if (!m.flagged) bucket = 'CLEAN';
  else if (!m.namesMatch) bucket = 'C';
  else if (tiedAtMax >= 2) bucket = 'B';
  else bucket = 'A';

  return {
    apiId,
    bucket,
    keeperKey: m.keep.key,
    keeperName: m.keep.name,
    keeperGames,
    keeperIsApi,
    dropCount: m.drop.length,
    dropGames,
    maxDropGames: maxDrop,
    margin,
    narrowMargin: bucket === 'A' && margin <= NARROW,
    tiedAtMax,
    apiRecordPresent: !!apiRec,
    apiRecordGames: apiRec ? apiRec.games : null,
    apiRecordIsKeeper: keeperIsApi,
    normNames,
    gamesMatch: m.gamesMatch,
    namesMatch: m.namesMatch,
  };
}

function main() {
  const merges = JSON.parse(fs.readFileSync(MERGES_FILE, 'utf8'));
  const classified = merges.map(classify);

  const counts = { CLEAN: 0, A: 0, B: 0, C: 0 };
  for (const c of classified) counts[c.bucket]++;
  const flaggedTotal = counts.A + counts.B + counts.C;

  const inBucket = b => classified.filter(c => c.bucket === b);
  const B = inBucket('B');
  const C = inBucket('C');
  const aNarrow = classified.filter(c => c.bucket === 'A' && c.narrowMargin);
  const apiNotKeeperAB = classified.filter(
    c => (c.bucket === 'A' || c.bucket === 'B') && c.apiRecordPresent && !c.apiRecordIsKeeper
  );

  const report = {
    generatedAt: new Date().toISOString(),
    source: 'reports/rekey-merges.json',
    totals: {
      mergeGroups: merges.length,
      clean: counts.CLEAN,
      flagged: flaggedTotal,
      A_dominant_keeper: counts.A,
      B_tied_max_refetch: counts.B,
      C_name_divergent: counts.C,
      A_narrow_margin_hint: aNarrow.length,
      api_record_not_keeper_in_AB: apiNotKeeperAB.length,
    },
    crossCheck: {
      flaggedEqualsMergesMinusClean: flaggedTotal === merges.length - counts.CLEAN,
    },
    B_tied_max: B,
    C_name_divergent: C,
    A_narrow_margin: aNarrow,
    api_record_not_keeper: apiNotKeeperAB.map(c => ({
      apiId: c.apiId, bucket: c.bucket, keeperKey: c.keeperKey,
      keeperGames: c.keeperGames, apiRecordGames: c.apiRecordGames,
    })),
    all: classified,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');

  const L = [];
  L.push('## 3b-2 flagged-merge classification');
  L.push('');
  L.push('| bucket | count | meaning |');
  L.push('| --- | --- | --- |');
  L.push(`| CLEAN | ${counts.CLEAN} | identical records, no review |`);
  L.push(`| A (dominant keeper) | ${counts.A} | keep-most-complete is safe |`);
  L.push(`| B (tied max) | ${counts.B} | **re-fetch** — no unique complete record |`);
  L.push(`| C (name divergent) | ${counts.C} | **review** — possibly different people |`);
  L.push(`| — A narrow-margin hint | ${aNarrow.length} | keeper barely beats top drop (≤${NARROW}g) |`);
  L.push(`| — api record not keeper (A+B) | ${apiNotKeeperAB.length} | canonical profile less complete than a dup |`);
  L.push(`| flagged total (A+B+C) | ${flaggedTotal} | |`);
  L.push(`| reconciles (flagged == merges − clean)? | ${report.crossCheck.flaggedEqualsMergesMinusClean} | |`);

  if (C.length) {
    L.push('', '### C — name divergent (review first)', '');
    L.push('| apiId | normalized names | keeper | drops |');
    L.push('| --- | --- | --- | --- |');
    for (const c of C.slice(0, 60)) {
      L.push(`| ${c.apiId} | ${c.normNames.join(' \\| ')} | ${c.keeperGames}g "${c.keeperName}" | ` +
        c.dropGames.join('/') + 'g |');
    }
    if (C.length > 60) L.push(`| …and ${C.length - 60} more | | | |`);
  } else {
    L.push('', '_No name-divergent (C) cases — every flagged merge is a game-count difference only._');
  }

  if (B.length) {
    L.push('', '### B — tied max (re-fetch candidates)', '');
    L.push('| apiId | name | tied@ | all games | apiRec |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const b of B.slice(0, 60)) {
      L.push(`| ${b.apiId} | ${b.keeperName} | ${b.keeperGames}g ×${b.tiedAtMax} | ` +
        `${b.keeperGames}/${b.dropGames.join('/')} | ${b.apiRecordPresent ? b.apiRecordGames + 'g' : 'absent'} |`);
    }
    if (B.length > 60) L.push(`| …and ${B.length - 60} more | | | | |`);
  }

  const summary = L.join('\n') + '\n';
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary); } catch (_) {}
  }
  process.stderr.write(`\nCLASSIFIED. clean=${counts.CLEAN} A=${counts.A} B=${counts.B} C=${counts.C} ` +
    `(flagged=${flaggedTotal}) narrowA=${aNarrow.length} apiNotKeeper=${apiNotKeeperAB.length}\n`);
}

main();
