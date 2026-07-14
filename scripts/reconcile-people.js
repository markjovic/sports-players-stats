// scripts/reconcile-people.js
//
// 3b-2 diagnostic (READ-ONLY except one report file).
//
// Purpose: reconcile the 196-person gap between:
//   - the plan's distinct-people count      = 411,313  (grouped player files by player.apiId || filename)
//   - 3b-0 build-alias-inverse's baseline    = 411,117  (distinct api ids as VALUES in the alias index)
//
// This job re-derives the people set INDEPENDENTLY of reports/rekey-merges.json:
//   A = distinct (player.apiId || filenameStem) over every players/{2hex}/*.json  (must reproduce 411,313)
//   B = distinct api-id keys across players/alias-inverse/*.json                    (must reproduce 411,117)
// then dumps A\B and B\A with per-id provenance so we can classify the ~196.
//
// If A reproduces 411,313 -> the plan grouping is confirmed and the gap is baseline-vs-reality.
// If A differs from 411,313 -> the identity rule itself diverges and that's the first thing to chase.
//
// No git in this script (writer writes the file; the workflow commits once).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLAYERS_DIR = path.join(ROOT, 'players');
const INVERSE_DIR = path.join(PLAYERS_DIR, 'alias-inverse');
const OUT_PATH = path.join(ROOT, 'reports', 'reconcile-people.json');

// Cross-check anchors from the handoff (settled numbers, not re-derived).
const EXPECT_PLAN_PEOPLE = 411313;   // this run's plan output
const EXPECT_INVERSE_PEOPLE = 411117; // 3b-0 alias-inverse baseline

const HEX2 = /^[0-9a-f]{2}$/;

function log(msg) {
  console.log(`[reconcile] ${new Date().toISOString()} ${msg}`);
}

// Best-effort name extraction for the diff dump only (cosmetic; never affects counts).
// Field name is not asserted anywhere in the handoff, so try the common candidates.
function nameOf(p) {
  if (!p || typeof p !== 'object') return null;
  return p.name || p.fullName || p.displayName || null;
}

function listPlayerBuckets(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && HEX2.test(d.name)) // excludes aliases/, alias-inverse/, indexes/
    .map(d => d.name)
    .sort();
}

function scanPlayerFiles() {
  const peopleFiles = new Set();          // A: distinct identity ids from files
  const idToFiles = new Map();            // id -> [{ file, diverged }]  (light; no names held)
  let filesScanned = 0;
  let parseErrors = 0;
  const parseErrorFiles = [];

  const buckets = listPlayerBuckets(PLAYERS_DIR);
  log(`player buckets found: ${buckets.length}`);

  for (const bucket of buckets) {
    const bdir = path.join(PLAYERS_DIR, bucket);
    let names;
    try {
      names = fs.readdirSync(bdir);
    } catch (e) {
      log(`WARN cannot read bucket ${bucket}: ${e.message}`);
      continue;
    }
    for (const fname of names) {
      if (!fname.endsWith('.json')) continue;
      const fpath = path.join(bdir, fname);
      let p;
      try {
        p = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      } catch (e) {
        parseErrors++;
        if (parseErrorFiles.length < 200) parseErrorFiles.push(`${bucket}/${fname}`);
        filesScanned++;
        continue;
      }
      const stem = fname.slice(0, -5); // strip .json
      const diverged = !!(p && p.apiId);
      const id = (diverged ? p.apiId : stem);
      peopleFiles.add(id);
      const rel = `${bucket}/${fname}`;
      const arr = idToFiles.get(id);
      if (arr) arr.push({ file: rel, diverged });
      else idToFiles.set(id, [{ file: rel, diverged }]);

      filesScanned++;
      if (filesScanned % 25000 === 0) {
        log(`scanned ${filesScanned} files, distinct people so far ${peopleFiles.size}`);
      }
    }
  }

  log(`scan complete: filesScanned=${filesScanned} peopleFromFiles=${peopleFiles.size} parseErrors=${parseErrors}`);
  return { peopleFiles, idToFiles, filesScanned, parseErrors, parseErrorFiles };
}

function loadInverseApiIds() {
  const inverse = new Set();
  let shardsRead = 0;
  let names;
  try {
    names = fs.readdirSync(INVERSE_DIR);
  } catch (e) {
    throw new Error(`cannot read alias-inverse dir ${INVERSE_DIR}: ${e.message}`);
  }
  for (const fname of names) {
    if (!fname.endsWith('.json')) continue;
    const fpath = path.join(INVERSE_DIR, fname);
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(fpath, 'utf8'));
    } catch (e) {
      log(`WARN cannot parse inverse shard ${fname}: ${e.message}`);
      continue;
    }
    // shape: { apiId: [spectatorTrunc, ...] }  (keys are the api ids)
    for (const k of Object.keys(obj)) inverse.add(k);
    shardsRead++;
  }
  log(`alias-inverse: shardsRead=${shardsRead} distinctApiIds=${inverse.size}`);
  return { inverse, shardsRead };
}

// For a small set of ids, re-open one contributing file each to grab a display name.
function enrichNames(ids, idToFiles) {
  const out = [];
  for (const id of ids) {
    const files = idToFiles.get(id) || [];
    const anyDiverged = files.some(f => f.diverged);
    let name = null;
    if (files.length) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, files[0].file), 'utf8'));
        name = nameOf(p);
      } catch (_) { /* name is cosmetic */ }
    }
    out.push({
      apiId: id,
      groupSize: files.length,
      anyDiverged,
      source: anyDiverged ? 'apiId-field' : 'file-key',
      name,
      files: files.map(f => f.file)
    });
  }
  // diverged-source first, then by groupSize desc, then id
  out.sort((a, b) =>
    (Number(b.anyDiverged) - Number(a.anyDiverged)) ||
    (b.groupSize - a.groupSize) ||
    (a.apiId < b.apiId ? -1 : a.apiId > b.apiId ? 1 : 0)
  );
  return out;
}

function main() {
  const { peopleFiles, idToFiles, filesScanned, parseErrors, parseErrorFiles } = scanPlayerFiles();
  const { inverse, shardsRead } = loadInverseApiIds();

  const onlyInFiles = [];
  for (const id of peopleFiles) if (!inverse.has(id)) onlyInFiles.push(id);
  const onlyInInverse = [];
  for (const id of inverse) if (!peopleFiles.has(id)) onlyInInverse.push(id);

  const onlyInFilesDetail = enrichNames(onlyInFiles, idToFiles);
  const onlyInInverseDetail = onlyInInverse
    .map(id => ({ apiId: id, hasFile: idToFiles.has(id) })) // hasFile should be false by construction
    .sort((a, b) => (a.apiId < b.apiId ? -1 : a.apiId > b.apiId ? 1 : 0));

  const report = {
    generatedAt: new Date().toISOString(),
    counts: {
      filesScanned,
      parseErrors,
      peopleFromFiles: peopleFiles.size,
      aliasInverseApiIds: inverse.size,
      aliasInverseShardsRead: shardsRead,
      net_files_minus_inverse: peopleFiles.size - inverse.size,
      onlyInFiles: onlyInFiles.length,
      onlyInInverse: onlyInInverse.length
    },
    crossCheck: {
      expectedPlanPeople: EXPECT_PLAN_PEOPLE,
      peopleFromFilesReproducesPlan: peopleFiles.size === EXPECT_PLAN_PEOPLE,
      expectedInversePeople: EXPECT_INVERSE_PEOPLE,
      inverseReproducesBaseline: inverse.size === EXPECT_INVERSE_PEOPLE
    },
    parseErrorFilesSample: parseErrorFiles,
    onlyInFilesDetail,
    onlyInInverseDetail
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), 'utf8');
  log(`wrote ${OUT_PATH}`);

  // Step summary (never silent; small preview).
  const lines = [];
  lines.push('## 3b-2 reconcile — people count');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| files scanned | ${filesScanned} |`);
  lines.push(`| parse errors | ${parseErrors} |`);
  lines.push(`| people from files (A) | ${peopleFiles.size} |`);
  lines.push(`| alias-inverse api ids (B) | ${inverse.size} |`);
  lines.push(`| A − B (net) | ${peopleFiles.size - inverse.size} |`);
  lines.push(`| only in files (A\\B) | ${onlyInFiles.length} |`);
  lines.push(`| only in inverse (B\\A) | ${onlyInInverse.length} |`);
  lines.push(`| A reproduces plan 411,313? | ${report.crossCheck.peopleFromFilesReproducesPlan} |`);
  lines.push(`| B reproduces baseline 411,117? | ${report.crossCheck.inverseReproducesBaseline} |`);
  lines.push('');
  lines.push('### only-in-files (first 40 — these are the suspect people the alias index never listed)');
  lines.push('');
  lines.push('| apiId | src | grp | name | files |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const d of onlyInFilesDetail.slice(0, 40)) {
    lines.push(`| ${d.apiId} | ${d.source} | ${d.groupSize} | ${d.name || ''} | ${d.files.join(' , ')} |`);
  }
  if (onlyInInverseDetail.length) {
    lines.push('');
    lines.push('### only-in-inverse (first 40 — api ids with no backing player file)');
    lines.push('');
    lines.push('| apiId | hasFile |');
    lines.push('| --- | --- |');
    for (const d of onlyInInverseDetail.slice(0, 40)) {
      lines.push(`| ${d.apiId} | ${d.hasFile} |`);
    }
  }
  const summary = lines.join('\n') + '\n';
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary); } catch (_) {}
  }
}

main();
