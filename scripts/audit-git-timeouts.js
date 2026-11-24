// audit-git-timeouts.js — does every git call in scripts/ carry a timeout?
//
// WHY THIS IS A SCRIPT AND NOT A GREP (T104, 2026-11-24)
// -----------------------------------------------------
// This repository has now been audited for untimed git calls three times, and a
// line-level grep got the answer wrong twice:
//
//   2026-08-20  A pass grepping `stdio: 'pipe' }` reported discover-game-backfill
//               and spectator-backfill as clean. They had 7 untimed calls each,
//               under a different options shape.
//   2026-11-24  A pass testing for `timeout:` on the git call's own line reported
//               62 scripts / 354 untimed calls. The real figures were 24 / 98.
//               36 scripts guard every call through a shared `GIT_OPTS` / `GIT` /
//               `_GIT` constant, which no line-level test can see. The arithmetic
//               tell was 74 - 12 = 62: it had found exactly the files that spell
//               the timeout inline.
//
// So this walks the parentheses of each call, reads the actual argument list, and
// RESOLVES named constants. Two further shapes that defeat a line-level test and
// are handled here:
//
//   * the options object on a later line than the call  (19 calls)
//   * the command string on a later line than execSync( (diagnose.js:245 and :257)
//
// ⚠ ANYTHING IT CANNOT RESOLVE IS REPORTED AS unresolved OR unparsed AND COUNTED
// SEPARATELY. It is never assumed guarded. A count that quietly swallows the cases
// it could not classify is how this file came to be needed.
//
// Usage:
//   node scripts/audit-git-timeouts.js
//   node scripts/audit-git-timeouts.js --dir scripts --strict
//   node scripts/audit-git-timeouts.js --json
//
//   --strict  exit 1 if any call is untimed, unresolved or unparsed (for CI)
//   --json    machine-readable output
//   --quiet   totals only

'use strict';

const fs = require('fs');
const path = require('path');

const ARGS = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq > -1) ARGS[a.slice(2, eq)] = a.slice(eq + 1);
  else if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ARGS[a.slice(2)] = process.argv[++i];
  else ARGS[a.slice(2)] = true;
}

const DIR = ARGS.dir ? String(ARGS.dir) : __dirname;
const STRICT = ARGS.strict === true || ARGS.strict === 'true';
const AS_JSON = ARGS.json === true || ARGS.json === 'true';
const QUIET = ARGS.quiet === true || ARGS.quiet === 'true';

// ── Source walking ───────────────────────────────────────────────────────────
// Skips over string literals (including template literals) and comments so a
// brace or paren inside one can never be mistaken for structure.

// Does a `/` at this index begin a regex literal rather than a division?
// ⚠ This matters more than it looks. A regex such as /^['"`]git/ contains a quote
// and a backtick; treating it as code let those characters open a "string" that
// swallowed the next few hundred lines of real code. The first version of the
// comment mask lost 28 genuine git calls that way and still printed a total, which
// would have let a later "0 untimed" be believed.
function regexStartsHere(src, j) {
  let k = j - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (k < 0) return true;
  const prev = src[k];
  if ('(,=:[!&|?{};+-*%~^<>'.indexOf(prev) >= 0) return true;
  if (/[A-Za-z_$0-9]/.test(prev)) {
    let e = k;
    while (e >= 0 && /[A-Za-z_$0-9]/.test(src[e])) e--;
    const word = src.slice(e + 1, k + 1);
    return ['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'new', 'delete', 'void', 'instanceof'].indexOf(word) >= 0;
  }
  return false;
}

function skipRegexLiteral(src, j) {
  let k = j + 1;
  let inClass = false;
  while (k < src.length) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '\n') return -1;          // not a regex after all
    if (inClass) { if (c === ']') inClass = false; k++; continue; }
    if (c === '[') { inClass = true; k++; continue; }
    if (c === '/') return k;
    k++;
  }
  return -1;
}

function skipLiteralOrComment(src, j) {
  const c = src[j];
  if (c === "'" || c === '"' || c === '`') {
    const q = c;
    j++;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === q) return j;
      j++;
    }
    return j;
  }
  if (c === '/' && src[j + 1] === '/') {
    while (j < src.length && src[j] !== '\n') j++;
    return j;
  }
  if (c === '/' && src[j + 1] === '*') {
    j += 2;
    while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
    return j + 1;
  }
  if (c === '/' && regexStartsHere(src, j)) {
    const end = skipRegexLiteral(src, j);
    if (end > 0) return end;
  }
  return -1;
}

/** Index of the paren matching the one at `open`, or -1 when unbalanced. */
function matchParen(src, open) {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const skipped = skipLiteralOrComment(src, j);
    if (skipped >= 0) { j = skipped; continue; }
    if (src[j] === '(') depth++;
    else if (src[j] === ')') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** Index of the brace matching the one at `open`, or -1 when unbalanced. */
function matchBrace(src, open) {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const skipped = skipLiteralOrComment(src, j);
    if (skipped >= 0) { j = skipped; continue; }
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/**
 * A boolean per character: true where the character is CODE, false where it sits
 * inside a string literal or a comment.
 *
 * ⚠ Without this, the scan matches `execSync(` inside its own documentation. Six
 * scripts here mention a git call in a comment, and this file's own usage block
 * does too — all seven were reported as "unbalanced parentheses" until the scan
 * learned to ignore prose. A scanner that reads its own comments as code will
 * always find something.
 */
function codeMask(src) {
  const mask = new Uint8Array(src.length).fill(1);
  for (let j = 0; j < src.length; j++) {
    const end = skipLiteralOrComment(src, j);
    if (end < 0) continue;
    for (let k = j; k <= end && k < src.length; k++) mask[k] = 0;
    j = end;
  }
  return mask;
}

/** Every `const|let|var NAME = { … }` in the file, at any indentation. */
function collectObjectConstants(src) {
  const out = {};
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    const close = matchBrace(src, open);
    if (close < 0) continue;
    out[m[1]] = src.slice(open, close + 1);
  }
  return out;
}


// ── The shared helper (T104) ─────────────────────────────────────────────────
// Pass 1 onward, most guarded calls pass `GX.gitOpts(ROOT)` rather than an object
// literal. That is neither a `timeout:` nor a resolvable constant, so without this
// the sweep would measure as ZERO progress — every fixed call would still read
// UNTIMED, and the obvious "fix" (trust anything called gitOpts) would make the
// tool blind to a helper that stopped setting a timeout.
//
// So provenance is VERIFIED, not assumed: the helper's own source is parsed, and
// only a factory that demonstrably sets `timeout:` counts. If lib/git-exec.cjs is
// missing or its gitOpts stops setting one, every call through it reverts to
// UNTIMED and this tool says so.

const HELPER_REL = path.join('lib', 'git-exec.cjs');

/** Names of option factories in the helper that provably set a timeout. */
function verifiedHelperFactories(dir) {
  const fp = path.join(dir, HELPER_REL);
  let src;
  try { src = fs.readFileSync(fp, 'utf8'); } catch (e) { return { ok: false, factories: new Set(), why: `${HELPER_REL} unreadable: ${e.code || e.message}` }; }
  const factories = new Set();
  const re = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index);
    if (open < 0) continue;
    const close = matchBrace(src, open);
    if (close < 0) continue;
    const body = src.slice(open, close + 1);
    if (/\btimeout\s*:/.test(body)) factories.add(m[1]);
  }
  return { ok: true, factories, why: '' };
}

/**
 * The local names through which this file reaches the helper.
 *
 * Handles BOTH module systems, because this repository has both:
 *   const GX = require('./lib/git-exec.cjs')        CJS namespace
 *   const { gitOpts } = require('./lib/git-exec.cjs')   CJS destructured
 *   import GX from './lib/git-exec.cjs'             ESM default (build-records.js)
 *   import * as GX from './lib/git-exec.cjs'        ESM namespace
 *   import { gitOpts } from './lib/git-exec.cjs'    ESM named
 *
 * ⚠ The first version read `require` only. build-records.js is ESM, so the first
 * swept builder measured as ZERO progress — the second time this tool under-reported
 * the sweep it is checking. Both failures were caught by comparing the count after a
 * single file instead of after a batch; a tool that must track the fix it measures
 * will keep needing that check, so keep making it.
 */
function helperBindings(src) {
  const ns = new Set();
  const direct = new Set();
  const HELPER = "['\"][^'\"]*lib\\/git-exec\\.cjs['\"]";
  let m;

  const reReqNs = new RegExp('\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\(\\s*' + HELPER + '\\s*\\)', 'g');
  while ((m = reReqNs.exec(src))) ns.add(m[1]);

  const reImpNs = new RegExp('\\bimport\\s+(?:\\*\\s+as\\s+)?([A-Za-z_$][\\w$]*)\\s*(?:,\\s*\\{[^}]*\\}\\s*)?from\\s*' + HELPER, 'g');
  while ((m = reImpNs.exec(src))) ns.add(m[1]);

  const reReqDe = new RegExp('\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*' + HELPER + '\\s*\\)', 'g');
  const reImpDe = new RegExp('\\bimport\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*' + HELPER, 'g');
  for (const re of [reReqDe, reImpDe]) {
    while ((m = re.exec(src))) {
      for (const part of m[1].split(',')) {
        const t = part.split(/\sas\s|:/).pop().trim();
        if (t) direct.add(t);
      }
    }
  }
  return { ns, direct };
}

/** Does this options expression come from a verified helper factory? */
function viaVerifiedHelper(text, bindings, factories) {
  const t = text.trim();
  for (const n of bindings.ns) {
    for (const f of factories) {
      if (new RegExp('\\b' + n + '\\s*\\.\\s*' + f + '\\s*\\(').test(t)) return true;
    }
  }
  for (const f of bindings.direct) {
    if (!factories.has(f)) continue;
    if (new RegExp('\\b' + f + '\\s*\\(').test(t)) return true;
  }
  return false;
}

const IDENT = /[A-Za-z_$][\w$]*/g;

/**
 * Does this options text carry a timeout, following identifier references?
 * Returns 'timed' | 'untimed' | 'unresolved'.
 *
 * 'unresolved' means an identifier was referenced that is not a resolvable object
 * constant in this file — a function parameter, an import, a spread of caller
 * options. Those are reported for a human to read; they are NEVER called guarded.
 */
function optionsCarryTimeout(text, consts, seen) {
  if (/\btimeout\s*:/.test(text)) return 'timed';
  const depth = seen || new Set();
  let unresolved = false;
  let m;
  IDENT.lastIndex = 0;
  while ((m = IDENT.exec(text))) {
    const name = m[0];
    if (depth.has(name)) continue;
    if (KNOWN_NON_OPTIONS.has(name)) continue;
    if (Object.prototype.hasOwnProperty.call(consts, name)) {
      depth.add(name);
      const r = optionsCarryTimeout(consts[name], consts, depth);
      if (r === 'timed') return 'timed';
      if (r === 'unresolved') unresolved = true;
      continue;
    }
    // A bare identifier used as, or spread into, the options object.
    if (new RegExp('(?:\\.\\.\\.|^|[,{(]\\s*)' + name + '\\s*(?:,|\\}|\\)|$)').test(text)) unresolved = true;
  }
  return unresolved ? 'unresolved' : 'untimed';
}

// Identifiers that appear inside an options object as VALUES and are not
// themselves options objects. Listing them keeps 'unresolved' meaningful.
const KNOWN_NON_OPTIONS = new Set([
  'cwd', 'stdio', 'pipe', 'ignore', 'inherit', 'encoding', 'env', 'shell',
  'maxBuffer', 'timeout', 'killSignal', 'uid', 'gid', 'windowsHide', 'input',
  'ROOT', 'process', 'Math', 'String', 'Number', 'undefined', 'null', 'true', 'false',
]);

/** Is the first argument of this call the git binary or a git command string? */
function argsAreGit(args) {
  const t = args.replace(/^\s+/, '');
  return /^['"`]git(?:[\s'"`]|$)/.test(t);
}

/** The options argument: the text after the last top-level comma. */
function lastTopLevelArg(args) {
  let depth = 0;
  let lastComma = -1;
  for (let j = 0; j < args.length; j++) {
    const skipped = skipLiteralOrComment(args, j);
    if (skipped >= 0) { j = skipped; continue; }
    const c = args[j];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) lastComma = j;
  }
  if (lastComma < 0) return '';
  return args.slice(lastComma + 1);
}

function lineOf(src, index) {
  let n = 1;
  for (let j = 0; j < index && j < src.length; j++) if (src[j] === '\n') n++;
  return n;
}

// ── Audit ────────────────────────────────────────────────────────────────────

function auditFile(fp, helper) {
  const src = fs.readFileSync(fp, 'utf8');
  const consts = collectObjectConstants(src);
  const bindings = helperBindings(src);
  const calls = [];
  const mask = codeMask(src);
  const re = /\bexec(?:File)?Sync\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    if (!mask[m.index]) continue;   // the match is inside a comment or a string
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    const line = lineOf(src, m.index);
    if (close < 0) {
      calls.push({ line, git: null, verdict: 'unparsed', note: 'unbalanced parentheses from this call' });
      continue;
    }
    const args = src.slice(open + 1, close);
    if (!argsAreGit(args)) continue;
    const opts = lastTopLevelArg(args);
    if (!opts.trim()) {
      calls.push({ line, git: true, verdict: 'untimed', note: 'no options argument at all' });
      continue;
    }
    let verdict = optionsCarryTimeout(opts, consts);
    if (verdict !== 'timed' && viaVerifiedHelper(opts, bindings, helper.factories)) verdict = 'timed';
    calls.push({
      line,
      git: true,
      verdict,
      hasMaxBuffer: /\bmaxBuffer\s*:/.test(opts) || Object.keys(consts).some(k => new RegExp('\\b' + k + '\\b').test(opts) && /\bmaxBuffer\s*:/.test(consts[k])),
      note: opts.replace(/\s+/g, ' ').trim().slice(0, 90),
    });
  }
  const git = calls.filter(c => c.git);
  return {
    file: path.basename(fp),
    total: git.length,
    timed: git.filter(c => c.verdict === 'timed').length,
    untimed: git.filter(c => c.verdict === 'untimed').length,
    unresolved: git.filter(c => c.verdict === 'unresolved').length,
    unparsed: calls.filter(c => c.verdict === 'unparsed').length,
    noMaxBuffer: git.filter(c => c.hasMaxBuffer === false).length,
    guardConsts: Object.keys(consts).filter(k => /\btimeout\s*:/.test(consts[k])),
    calls,
  };
}

function main() {
  let files;
  try {
    files = fs.readdirSync(DIR)
      .filter(f => f.endsWith('.js') || f.endsWith('.cjs'))
      .filter(f => f !== path.basename(__filename))   // never audit the auditor
      .sort();
  } catch (e) {
    console.error(`audit-git-timeouts: cannot read ${DIR}: ${e.message}`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error(`audit-git-timeouts: no .js/.cjs files in ${DIR} — refusing to report "0 untimed" on an empty read.`);
    process.exit(2);
  }

  const helper = verifiedHelperFactories(DIR);
  const rows = files.map(f => auditFile(path.join(DIR, f), helper)).filter(r => r.total > 0 || r.unparsed > 0);
  const sum = k => rows.reduce((a, r) => a + r[k], 0);
  const bad = rows.filter(r => r.untimed > 0 || r.unresolved > 0 || r.unparsed > 0);

  const summary = {
    dir: DIR,
    helper: helper.ok ? `${HELPER_REL}: ${[...helper.factories].sort().join(', ') || 'NO factory sets a timeout'}` : helper.why,
    filesScanned: files.length,
    filesWithGitCalls: rows.length,
    gitCalls: sum('total'),
    timed: sum('timed'),
    untimed: sum('untimed'),
    unresolved: sum('unresolved'),
    unparsed: sum('unparsed'),
    noMaxBuffer: sum('noMaxBuffer'),
    filesNeedingWork: bad.length,
    filesFullyGuarded: rows.length - bad.length,
  };

  if (AS_JSON) {
    console.log(JSON.stringify({ summary, files: rows }, null, 2));
  } else {
    console.log('');
    console.log(`audit-git-timeouts — ${DIR}`);
    console.log(`  shared helper          : ${summary.helper}`);
    console.log(`  files scanned          : ${summary.filesScanned}`);
    console.log(`  files with git calls   : ${summary.filesWithGitCalls}`);
    console.log(`  git calls              : ${summary.gitCalls}`);
    console.log(`    timed                : ${summary.timed}`);
    console.log(`    UNTIMED              : ${summary.untimed}`);
    console.log(`    unresolved (read me) : ${summary.unresolved}`);
    console.log(`    unparsed   (read me) : ${summary.unparsed}`);
    console.log(`  calls with no maxBuffer: ${summary.noMaxBuffer}`);
    console.log(`  files needing work     : ${summary.filesNeedingWork}`);
    console.log(`  files fully guarded    : ${summary.filesFullyGuarded}`);
    if (!QUIET) {
      console.log('');
      console.log('── FILES NEEDING WORK ───────────────────────────────────────────');
      for (const r of bad.sort((a, b) => (b.untimed + b.unresolved + b.unparsed) - (a.untimed + a.unresolved + a.unparsed) || a.file.localeCompare(b.file))) {
        console.log(`  ${r.file}  ${r.untimed} untimed / ${r.total} git`
          + (r.unresolved ? `  (+${r.unresolved} unresolved)` : '')
          + (r.unparsed ? `  (+${r.unparsed} UNPARSED)` : ''));
        for (const c of r.calls) {
          if (c.verdict === 'timed') continue;
          console.log(`      L${c.line}  ${c.verdict.toUpperCase()}  ${c.note}`);
        }
      }
      console.log('');
      console.log('── FULLY GUARDED ───────────────────────────────────────────────');
      for (const r of rows.filter(r => !bad.includes(r))) {
        console.log(`  ${r.file}  ${r.total} git`
          + (r.guardConsts.length ? `  via ${r.guardConsts.join(', ')}` : '  (inline)'));
      }
    }
    console.log('');
  }

  if (STRICT && (summary.untimed > 0 || summary.unresolved > 0 || summary.unparsed > 0)) {
    console.error(`audit-git-timeouts: FAILED — ${summary.untimed} untimed, `
      + `${summary.unresolved} unresolved, ${summary.unparsed} unparsed git calls.`);
    process.exit(1);
  }
}

main();
