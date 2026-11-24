#!/usr/bin/env node
// scripts/tests/test-git-stall-cap.js
// REVISION 2026-11-24a — first version.
//
// Asserts the consecutive-stall cap in discover-fixtures.js `gitCommitPush`.
//
// WHY IT EXISTS. Run 45326672826 (2026-11-24) spent 68 of its 81 minutes inside
// the push-retry loop: `git fetch origin main` was killed at the 10-minute timeout
// six times in a row, each retry sleeping 1-91s, with the data-write lock held the
// whole time and every other workflow queued behind it. The loop would have made
// 60 such attempts. Contention must still be retried — a rejected push clears —
// but a STALL is the same call failing the same way with nothing to clear.
//
// ⚠ RUNS THE REAL FUNCTION (T103: a fixture built from the same belief as the code
// tests the belief, not the code). The actual script is copied into a
// repository-shaped temp tree and require()d, so `ROOT` resolves inside the tree
// and `gitCommitPush` is the shipped one. NO PlayHQ stub is needed and no sweep
// runs: that is what the require.main guard at the bottom of the script is for.
//
// `git` and `sleep` are both stubbed on PATH — `sleep` because the loop's real
// jitter is 1-91s a turn and these cases take six turns.
//
// Run:  node scripts/tests/test-git-stall-cap.js

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l}${d !== undefined ? `  -> ${d}` : ''}`); } };
const eq = (a, b, l) => ok(a === b, l, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

// ── The git stub ──────────────────────────────────────────────────────────────
// Plans are comma-separated, one entry per call of that verb; the LAST entry
// repeats once the plan is exhausted, so "ok" alone means "always ok".
//   fetch: stall (SIGTERM) | timeout (outlives DF_GIT_TIMEOUT_MS) | fail | ok
//   push:  reject (contention) | fail (not contention) | ok
const GIT_STUB = `#!/bin/sh
# Skip any leading -c key=value pairs so 'git -c user.name=x commit' reads as 'commit'.
while [ "$1" = "-c" ]; do shift 2; done
verb="$1"; shift
bump() { n=$(cat "$DF_T_DIR/count.$1" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$DF_T_DIR/count.$1"; echo "$n"; }
step() { # $1=plan  $2=index -> the Nth entry, last entry repeating
  echo "$1" | tr ',' '\\n' | awk -v i="$2" 'NR<=i{v=$0} END{print v}'
}
case "$verb" in
  add)    exit 0 ;;
  diff)   echo " 1 file changed, 1 insertion(+), 0 deletions(-)"; exit 0 ;;
  commit) exit 0 ;;
  merge)
    if [ "$1" = "--abort" ]; then echo "fatal: There is no merge to abort" >&2; exit 128; fi
    exit 0 ;;
  fetch)
    n=$(bump fetch)
    case "$(step "$DF_T_FETCH" "$n")" in
      stall)   kill -TERM $$; sleep 30 ;;
      timeout) command -p sleep 4 ;;   # NOT bare 'sleep': the stub dir shadows it on PATH
      fail)    echo "fatal: unable to access 'https://github.com/': stub failure" >&2; exit 128 ;;
      *)       exit 0 ;;
    esac ;;
  push)
    n=$(bump push)
    case "$(step "$DF_T_PUSH" "$n")" in
      reject) echo " ! [rejected]        HEAD -> main (fetch first)" >&2; exit 1 ;;
      fail)   echo "remote: Permission denied" >&2; exit 128 ;;
      *)      exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
`;

const SLEEP_STUB = '#!/bin/sh\nexit 0\n';

const DRIVER = `'use strict';
const { gitCommitPush } = require('./scripts/discover-fixtures.js');
try { gitCommitPush('stall-cap test'); console.log('RESULT:OK'); }
catch (e) { console.log('RESULT:THROW:' + String(e && e.message).replace(/\\s+/g, ' ')); }
`;

function buildTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-stall-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'stub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'discover-fixtures.js'), path.join(root, 'scripts', 'discover-fixtures.js'));
  fs.writeFileSync(path.join(root, 'stub', 'git'), GIT_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'stub', 'sleep'), SLEEP_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'drive.js'), DRIVER);
  return root;
}

// Returns { result, fetches, pushes, ms, stdout }
function run({ fetchPlan, pushPlan = 'ok', args = [], timeoutMs = 1500 }) {
  const root = buildTree();
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, 'drive.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env,
      PATH: `${path.join(root, 'stub')}:${process.env.PATH}`,
      DF_T_DIR: path.join(root, 'state'),
      DF_T_FETCH: fetchPlan,
      DF_T_PUSH: pushPlan,
      DF_GIT_TIMEOUT_MS: String(timeoutMs) },
  });
  const ms = Date.now() - t0;
  const out = (r.stdout || '') + (r.stderr || '');
  const line = (out.split('\n').find(l => l.startsWith('RESULT:')) || 'RESULT:NONE').trim();
  const num = f => { try { return parseInt(fs.readFileSync(path.join(root, 'state', `count.${f}`), 'utf8'), 10); } catch (_) { return 0; } };
  return { result: line, fetches: num('fetch'), pushes: num('push'), ms, stdout: out, root };
}

console.log('test-git-stall-cap');

// 1 · The measured case: the real timeout branch, three times, nothing else.
{
  const r = run({ fetchPlan: 'timeout' });
  ok(r.result.startsWith('RESULT:THROW:'), '1a three timeouts throw', r.result.slice(0, 120));
  ok(/STALLED past/.test(r.result), '1b the error names the stall, not a generic failure');
  ok(/data-write/.test(r.result), '1c the error names the lock it is refusing to hold');
  eq(r.fetches, 3, '1d gave up after exactly 3 fetches, not 60');
  eq(r.pushes, 0, '1e never reached the push');
  ok(r.ms >= 3500 && r.ms < 11000, '1f the timeout fired: ~3x1.5s, not 3x the stub\'s 4s sleep', `${r.ms}ms`);
}

// 2 · Same cap via a killed process rather than the timeout — one OR'd predicate,
//     both halves exercised.
{
  const r = run({ fetchPlan: 'stall' });
  ok(r.result.startsWith('RESULT:THROW:'), '2a three SIGTERM stalls throw');
  eq(r.fetches, 3, '2b gave up after exactly 3 fetches');
}

// 3 · A fetch that ANSWERS resets the run. Stall, then two clean fetches around a
//     rejected push: three fetches, one stall, no throw.
{
  const r = run({ fetchPlan: 'stall,ok', pushPlan: 'reject,ok' });
  eq(r.result, 'RESULT:OK', '3a a stall followed by a working fetch does not give up');
  eq(r.fetches, 3, '3b fetched three times');
  eq(r.pushes, 2, '3c pushed twice — the rejection was retried');
}

// 4 · A plain fetch failure neither counts toward the cap nor clears it. Stalls on
//     calls 1, 3 and 5 with failures between: the third stall is still the third.
{
  const r = run({ fetchPlan: 'stall,fail,stall,fail,stall' });
  ok(r.result.startsWith('RESULT:THROW:'), '4a stall/fail/stall/fail/stall gives up on the third stall');
  eq(r.fetches, 5, '4b the two failures were retried without counting or resetting');
}

// 5 · Plain failures alone never trip the cap.
{
  const r = run({ fetchPlan: 'fail,fail,fail,fail,ok' });
  eq(r.result, 'RESULT:OK', '5a four non-stall failures then a success completes');
  eq(r.fetches, 5, '5b all four failures retried');
}

// 6 · --max-fetch-stalls=0 restores the old behaviour exactly.
{
  const r = run({ fetchPlan: 'stall,stall,stall,stall,ok', args: ['--max-fetch-stalls=0'] });
  eq(r.result, 'RESULT:OK', '6a cap 0 is unbounded — four stalls then a success completes');
  eq(r.fetches, 5, '6b did not give up');
}

// 7 · An explicit cap is honoured.
{
  const r = run({ fetchPlan: 'stall', args: ['--max-fetch-stalls=2'] });
  ok(r.result.startsWith('RESULT:THROW:'), '7a cap 2 throws');
  eq(r.fetches, 2, '7b after exactly 2 fetches');
}

// 8 · THE CONTENTION PATH IS UNTOUCHED. This is the guard that matters: the loop
//     exists for push rejections and they must still be retried.
{
  const r = run({ fetchPlan: 'ok', pushPlan: 'reject,reject,reject,reject,reject,ok' });
  eq(r.result, 'RESULT:OK', '8a five rejected pushes then a success still completes');
  eq(r.pushes, 6, '8b every rejection retried');
  eq(r.fetches, 6, '8c each attempt re-fetched first');
}

// 9 · A push failure that is NOT contention still fails fast, unchanged.
{
  const r = run({ fetchPlan: 'ok', pushPlan: 'fail' });
  ok(r.result.startsWith('RESULT:THROW:'), '9a a non-contention push failure throws');
  eq(r.pushes, 1, '9b without retrying');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
