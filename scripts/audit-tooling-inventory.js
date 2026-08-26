// scripts/audit-tooling-inventory.js
//
// Inventories scripts/ and .github/workflows/ and classifies every file, so a
// deletion list is AGREED FROM EVIDENCE rather than remembered. It deletes
// nothing and proposes no commit to those paths — deletion stays with
// cleanup-repo.yml, which already has the dry-run, the pre-cleanup tag and the
// ordering gates. Building a second deleter would be the exact duplication this
// audit exists to find.
//
// WHY. 163 workflow files, 37 added or amended in seven days. The pattern is
// that each question gets its own script and workflow, they ship as a pair, and
// nothing is ever retired — so a week of debugging leaves dozens of permanent
// artefacts for a handful of durable answers. A one-question diagnostic should
// be deleted in the same commit that records its answer.
//
// WHAT IT DECIDES, AND WHAT IT REFUSES TO DECIDE. It reports facts: whether a
// script is referenced by a workflow, whether a workflow calls a script that
// exists, whether anything requires or imports it, whether REPO_MANIFEST.md
// mentions it, and when it was last committed. It classifies on those facts
// alone. It NEVER proposes deleting anything whose findings are not already
// written down somewhere — an undocumented one-off is flagged
// DOCUMENT-THEN-DELETE, not DELETE, because deleting it loses the answer it was
// built to get.
//
// REFERENCE DETECTION IS DELIBERATELY GENEROUS. A script counts as referenced if
// ANY workflow mentions its filename anywhere, not merely in a `node scripts/x.js`
// line — a workflow may call it through a shell variable, a case statement or a
// composite step. Over-counting a reference leaves a dead file in the repo;
// under-counting one puts a LIVE file on a delete list. Those costs are not
// symmetrical, so the bias runs one way on purpose.
//
// DATES NEED HISTORY. `git log` on a depth-1 checkout returns nothing, so the
// workflow uses a blobless full-history checkout sparse to scripts/ and
// .github/workflows/ — the same pattern cleanup-repo.yml already uses for the
// same reason. If history is unavailable the date is reported as null and the
// classification does not depend on it.
//
// WRITES: reports/tooling-inventory.json and reports/tooling-delete-list.txt.
// Nothing else. The delete list is text ready to paste into cleanup-repo.yml.

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; })
);

const DAYS   = ARGS.days ? Math.max(1, parseInt(ARGS.days, 10)) : 14;
const DRY    = !ARGS.commit;          // default: print and write locally, commit only with --commit
const SCRIPTS_DIR   = path.join(ROOT, 'scripts');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const REPORTS_DIR   = path.join(ROOT, 'reports');
const OUT_JSON      = path.join(REPORTS_DIR, 'tooling-inventory.json');
const OUT_LIST      = path.join(REPORTS_DIR, 'tooling-delete-list.txt');
const OUT_JSON_REL  = path.relative(ROOT, OUT_JSON);
const OUT_LIST_REL  = path.relative(ROOT, OUT_LIST);
const MANIFEST      = path.join(ROOT, 'REPO_MANIFEST.md');
const CONTEXT       = path.join(ROOT, 'claude_context.md');
const TASKS         = path.join(ROOT, 'OUTSTANDING_TASKS.md');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// gitCommit below is copied verbatim from discover-game-backfill.js, and that
// script gates it on a DRY_RUN const of its own. This file has no dry-run of
// that kind, so the constant is declared here rather than editing the copied
// block — an edited copy stops being verbatim and stops being checkable against
// its source. It cost a full dispatch on 2026-08-26 when the census crashed at
// its first commit AFTER a 419,427-file scan had completed.
const DRY_RUN = false;
// ─── Git commit — discover-game-backfill.js, verbatim ─────────────────────────

const GIT_MAXBUF     = 512 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

async function gitCommit(message, dirs) {
  if (DRY_RUN) { console.log(`  [dry-run] would commit: ${message}`); return; }
  const paths = (dirs && dirs.length ? dirs : ['.']);

  let addFailures = 0, hardAddFailures = 0;
  for (const p of paths) {
    try { execFileSync('git', ['add', '--', p], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS }); }
    catch (e) {
      addFailures++;
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n')[0];
      if (!/did not match any files/i.test(detail)) hardAddFailures++;
      console.error(`  ⚠ git add ${/did not match any files/i.test(detail) ? 'skipped' : 'FAILED'} for "${p}": ${detail}`);
    }
  }

  const staged = (() => {
    try { return execFileSync('git', ['diff', '--staged', '--shortstat'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS }).toString().trim(); }
    catch (_) { return ''; }
  })();

  if (!staged) {
    if (hardAddFailures) {
      throw new Error(`gitCommit: nothing staged and ${hardAddFailures} path(s) failed to stage for a reason other than "did not match any files" ("${message}")`);
    }
    if (addFailures) {
      console.log(`  (no changes to commit: ${message}) — ${addFailures} optional path(s) absent`);
      return;
    }
    console.log(`  (no changes to commit: ${message})`);
    return;
  }
  console.log(`  staging: ${staged}`);

  const IDENT = ['-c', 'user.name=github-actions[bot]',
                 '-c', 'user.email=github-actions[bot]@users.noreply.github.com'];

  try { execFileSync('git', [...IDENT, 'commit', '-q', '-m', message], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS }); }
  catch (e) {
    const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
    throw new Error(`gitCommit: commit failed for "${message}" — ${detail}`);
  }

  const MAX = 60;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try { execFileSync('git', ['merge', '--abort'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS }); } catch (_) {}

    try {
      execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS });
    } catch (e) {
      if (attempt === MAX) throw e;
      const s = 1 + Math.floor(Math.random() * 91);
      console.log(`  fetch failed (attempt ${attempt}/${MAX}), retrying in ${s}s`);
      await sleep(s * 1000);
      continue;
    }

    execFileSync('git', [...IDENT, 'merge', '-q', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS });

    try {
      execFileSync('git', ['push', 'origin', 'HEAD:main'], { stdio: 'pipe', cwd: ROOT, maxBuffer: GIT_MAXBUF, timeout: GIT_TIMEOUT_MS });
      console.log(`  ✓ Committed: ${message} (pushed on attempt ${attempt})`);
      return;
    } catch (e) {
      const detail = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
      const contention = /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref/i.test(detail);
      if (!contention) {
        console.error(`  push failed — NOT contention, failing fast. git said:\n${detail}`);
        throw e;
      }
      if (attempt === MAX) {
        console.error(`  push still rejected after ${MAX} attempts. git said:\n${detail}`);
        throw e;
      }
      const s = 1 + Math.floor(Math.random() * 91);
      console.log(`  push attempt ${attempt}/${MAX} rejected, re-syncing in ${s}s`);
      await sleep(s * 1000);
    }
  }
  throw new Error(`gitCommit: exhausted ${MAX} push attempts for "${message}"`);
}
// ─── Git helpers ──────────────────────────────────────────────────────────────

function lastCommitISO(relPath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', relPath],
      { cwd: ROOT, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 }).toString().trim();
    return out || null;
  } catch (e) { return null; }
}

function daysAgo(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - Date.parse(iso)) / 86400000);
}

// ─── Read the tree ────────────────────────────────────────────────────────────

function listFiles(dir, filterFn) {
  try { return fs.readdirSync(dir).filter(filterFn).sort(); }
  catch (e) { return []; }
}

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('audit-tooling-inventory — what is in scripts/ and .github/workflows/, and what can go\n');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const scriptFiles   = listFiles(SCRIPTS_DIR, f => f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.mjs') || f.endsWith('.sh'));
  const libFiles      = listFiles(path.join(SCRIPTS_DIR, 'lib'), f => f.endsWith('.cjs') || f.endsWith('.js'));
  const workflowFiles = listFiles(WORKFLOWS_DIR, f => f.endsWith('.yml') || f.endsWith('.yaml'));

  console.log(`  scripts/          : ${scriptFiles.length} files`);
  console.log(`  scripts/lib/      : ${libFiles.length} files`);
  console.log(`  .github/workflows/: ${workflowFiles.length} files\n`);

  const docText = readText(MANIFEST) + '\n' + readText(CONTEXT) + '\n' + readText(TASKS);
  const docsPresent = { manifest: fs.existsSync(MANIFEST), context: fs.existsSync(CONTEXT), tasks: fs.existsSync(TASKS) };
  if (!docsPresent.manifest) console.log('  ⚠ REPO_MANIFEST.md not found — "documented" cannot be assessed and every');
  if (!docsPresent.manifest) console.log('    script will read as undocumented. Treat that column as unknown, not as fact.\n');

  // Workflow bodies, once.
  const wf = workflowFiles.map(f => {
    const body = readText(path.join(WORKFLOWS_DIR, f));
    const nameMatch = body.match(/^name:\s*(.+)$/m);
    // Scripts invoked. Generous on purpose — see header.
    const invoked = new Set();
    for (const m of body.matchAll(/scripts\/([A-Za-z0-9._-]+\.(?:js|cjs|mjs|sh))/g)) invoked.add(m[1]);
    return {
      file: f,
      displayName: nameMatch ? nameMatch[1].trim() : null,
      hasSchedule: /^\s*schedule:/m.test(body),
      hasDispatch: /workflow_dispatch:/.test(body),
      hasRepoDispatch: /repository_dispatch:/.test(body),
      hasWorkflowCall: /workflow_call:/.test(body),
      invokes: [...invoked],
      lastCommit: lastCommitISO(`.github/workflows/${f}`),
      bytes: Buffer.byteLength(body),
      body,
    };
  });

  // Script bodies, once.
  const allScriptNames = [...scriptFiles, ...libFiles.map(f => `lib/${f}`)];
  const scriptBodies = new Map();
  for (const rel of allScriptNames) scriptBodies.set(rel, readText(path.join(SCRIPTS_DIR, rel)));

  // ── Classify scripts ────────────────────────────────────────────────────────
  const scripts = [];
  for (const rel of allScriptNames) {
    const base = path.basename(rel);
    const body = scriptBodies.get(rel) || '';

    const usedByWorkflows = wf.filter(w => w.body.includes(base)).map(w => w.file);
    const requiredBy = [];
    for (const [otherRel, otherBody] of scriptBodies) {
      if (otherRel === rel) continue;
      if (otherBody.includes(base)) requiredBy.push(otherRel);
    }
    const documented = docText.includes(base);
    const lastCommit = lastCommitISO(`scripts/${rel}`);
    const age = daysAgo(lastCommit);
    const scheduled = wf.some(w => w.hasSchedule && w.body.includes(base));

    let klass;
    if (rel.startsWith('lib/'))             klass = requiredBy.length ? 'LIBRARY (required by other scripts)' : 'LIBRARY, UNREFERENCED';
    else if (scheduled)                     klass = 'SCHEDULED';
    else if (usedByWorkflows.length)        klass = 'DISPATCH-ONLY';
    else if (requiredBy.length)             klass = 'CALLED BY ANOTHER SCRIPT (no workflow)';
    else if (documented)                    klass = 'NO WORKFLOW, but documented — review';
    else                                    klass = 'ORPHAN: no workflow, nothing requires it, undocumented';

    scripts.push({ path: `scripts/${rel}`, base, klass, usedByWorkflows, requiredBy, documented,
                   lastCommit, ageDays: age, recent: age !== null && age <= DAYS,
                   bytes: Buffer.byteLength(body) });
  }

  // ── Classify workflows ──────────────────────────────────────────────────────
  const scriptBaseSet = new Set(allScriptNames.map(r => path.basename(r)));
  const workflows = [];
  for (const w of wf) {
    const missing = w.invokes.filter(s => !scriptBaseSet.has(s));
    const age = daysAgo(w.lastCommit);
    let klass;
    if (missing.length && missing.length === w.invokes.length && w.invokes.length)
      klass = `BROKEN: calls script(s) that do not exist — ${missing.join(', ')}`;
    else if (missing.length)
      klass = `PARTLY BROKEN: missing ${missing.join(', ')}`;
    else if (w.hasSchedule)        klass = 'SCHEDULED';
    else if (!w.invokes.length)    klass = 'CALLS NO SCRIPT (composite, dispatcher, or inline shell) — read before judging';
    else                           klass = 'DISPATCH-ONLY';
    workflows.push({ path: `.github/workflows/${w.file}`, displayName: w.displayName, klass,
                     invokes: w.invokes, missingScripts: missing, hasSchedule: w.hasSchedule,
                     lastCommit: w.lastCommit, ageDays: age, recent: age !== null && age <= DAYS,
                     bytes: w.bytes });
  }

  // ── Pairs added recently ────────────────────────────────────────────────────
  const recentScripts   = scripts.filter(s => s.recent);
  const recentWorkflows = workflows.filter(w => w.recent);

  // ── Deletion candidates ─────────────────────────────────────────────────────
  // Two lists, deliberately separate. SAFE = nothing references it and its
  // findings are recorded. DOCUMENT-FIRST = nothing references it but no document
  // mentions it, so deleting it silently discards whatever it established.
  const safeDelete = [], documentFirst = [], brokenWorkflows = [];
  const SELF = 'scripts/audit-tooling-inventory.js';
  for (const s of scripts) {
    // Never list itself. It is dispatched by its own workflow but that workflow
    // mentions it, so the generous reference rule already covers it — this guard
    // is for the case where the audit is run before its workflow is added.
    if (s.path === SELF) continue;
    // 'NO WORKFLOW, but documented' MUST be a candidate. It is the class every
    // retired one-off lands in once its finding has been written down, and the
    // first version of this file excluded it — which made the SAFE list
    // permanently empty for scripts, since the ORPHAN class is undocumented by
    // definition. The audit would have reported "none to delete" against 163
    // workflows and looked like a clean result.
    const candidate = s.klass.startsWith('ORPHAN')
                   || s.klass.startsWith('LIBRARY, UNREF')
                   || s.klass.startsWith('NO WORKFLOW');
    if (!candidate) continue;
    (s.documented ? safeDelete : documentFirst).push(s.path);
  }
  for (const w of workflows) {
    if (w.klass.startsWith('BROKEN')) brokenWorkflows.push(w.path);
  }

  // ── Print ───────────────────────────────────────────────────────────────────
  const tallyBy = (arr, key) => {
    const t = {};
    for (const x of arr) { const k = x[key].split(' —')[0].split(':')[0]; t[k] = (t[k] || 0) + 1; }
    return t;
  };
  console.log('──── SCRIPTS BY CLASS ────');
  for (const [k, v] of Object.entries(tallyBy(scripts, 'klass'))) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log('\n──── WORKFLOWS BY CLASS ────');
  for (const [k, v] of Object.entries(tallyBy(workflows, 'klass'))) console.log(`  ${String(v).padStart(4)}  ${k}`);

  console.log(`\n──── ADDED OR AMENDED IN THE LAST ${DAYS} DAYS ────`);
  console.log(`  ${recentScripts.length} script(s), ${recentWorkflows.length} workflow(s)`);
  for (const s of recentScripts) console.log(`  ${String(s.ageDays).padStart(3)}d  ${s.path}  [${s.klass}]${s.documented ? '' : '  UNDOCUMENTED'}`);
  for (const w of recentWorkflows) console.log(`  ${String(w.ageDays).padStart(3)}d  ${w.path}  [${w.klass}]`);

  console.log('\n──── BROKEN WORKFLOWS (call a script that is not in the repo) ────');
  if (!brokenWorkflows.length) console.log('  none');
  for (const w of workflows.filter(x => x.klass.startsWith('BROKEN') || x.klass.startsWith('PARTLY'))) {
    console.log(`  ${w.path} — missing ${w.missingScripts.join(', ')}`);
  }

  console.log('\n──── ORPHAN SCRIPTS, DOCUMENTED (findings already recorded — safe to delete) ────');
  if (!safeDelete.length) console.log('  none');
  for (const p of safeDelete) console.log(`  ${p}`);

  console.log('\n──── ORPHAN SCRIPTS, UNDOCUMENTED (write the finding down FIRST) ────');
  if (!documentFirst.length) console.log('  none');
  for (const p of documentFirst) console.log(`  ${p}`);

  console.log('\nHOW TO READ THIS. "Referenced" is generous: a script counts as used if ANY');
  console.log('workflow mentions its filename anywhere. That over-counts, on purpose — a missed');
  console.log('reference would put a LIVE file on a delete list, which is the costlier mistake.');
  console.log('Nothing here is deleted. Paste the list into cleanup-repo.yml, dry-run it first.');

  // ── Write the paste-ready list ──────────────────────────────────────────────
  const lines = [
    '# reports/tooling-delete-list.txt',
    `# generated ${new Date().toISOString()} by scripts/audit-tooling-inventory.js`,
    '#',
    '# Paste into the SCRIPTS=( ) / WORKFLOWS=( ) arrays in cleanup-repo.yml.',
    '# Run cleanup-repo with dry_run=true FIRST and read the list it prints.',
    '#',
    '# SAFE — nothing references these and a document already records what they found:',
    ...safeDelete.map(p => `  ${p}`),
    '#',
    '# DOCUMENT FIRST — nothing references these, but NO document mentions them.',
    '# Deleting one discards whatever it established. Write the finding into',
    '# REPO_MANIFEST.md in the same commit, then move the line up into SAFE.',
    ...documentFirst.map(p => `  # ${p}`),
    '#',
    '# BROKEN WORKFLOWS — these call a script that is not in the repo. They cannot',
    '# run. Confirm the script was deleted deliberately, then remove the workflow:',
    ...brokenWorkflows.map(p => `  ${p}`),
    '',
  ];
  fs.writeFileSync(OUT_LIST, lines.join('\n'));

  const out = {
    generatedAt: new Date().toISOString(),
    docsPresent,
    counts: { scripts: scriptFiles.length, libs: libFiles.length, workflows: workflowFiles.length,
              recentScripts: recentScripts.length, recentWorkflows: recentWorkflows.length,
              safeDelete: safeDelete.length, documentFirst: documentFirst.length, brokenWorkflows: brokenWorkflows.length },
    safeDelete, documentFirst, brokenWorkflows,
    scripts, workflows,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT_JSON_REL} and ${OUT_LIST_REL}`);

  if (DRY) console.log('(not committed — re-run with commit enabled to commit the two reports)');
  else await gitCommit(`tooling inventory: ${scriptFiles.length} scripts, ${workflowFiles.length} workflows, ${safeDelete.length} safe to delete`, [OUT_JSON_REL, OUT_LIST_REL]);

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch(e => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
