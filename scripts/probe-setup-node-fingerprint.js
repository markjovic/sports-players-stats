// scripts/probe-setup-node-fingerprint.js
//
// CONTROLLED TEST for the "setup-node changes the runner's outbound fingerprint
// and CloudFront 403s every PlayHQ request" rule. Runs the EXACT proven session
// acquisition (COOKIE_QUERIES + HEADERS_BASE, copied verbatim from
// backfill-missing-players.js) and reports, per attempt, the HTTP status and
// whether a set-cookie came back.
//
// The experiment is in the WORKFLOW (probe-setup-node-fingerprint.yml): two
// parallel jobs run THIS script on identical runners, differing in ONE thing —
// one job has an actions/setup-node step, the other does not. Compare the two
// jobs' output:
//   - If the no-setup-node job gets 200+cookie and the setup-node job gets 403
//     → the rule holds; setup-node IS the cause; keep it off fetch workflows.
//   - If BOTH get 200+cookie → the rule is over-broad; setup-node is harmless
//     here and the three noncompliant workflows can be left alone.
//   - If BOTH 403 → something else is blocking (IP reputation, headers) and
//     setup-node is not the variable; investigate separately.
//
// READ-ONLY. One tiny POST per attempt (max ~4 requests). No writes, no git,
// no repo data needed. Prints a machine-readable RESULT= line for the workflow
// to surface in the run summary.

'use strict';

const crypto = require('crypto');

const API_URL = 'https://api.playhq.com/graphql';

// Copied VERBATIM from backfill-missing-players.js — do not "simplify".
const HEADERS_BASE = {
  'accept': '*/*', 'origin': 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant': 'basketball-victoria', 'content-type': 'application/json',
};

// Both cookie-warm-up queries, in order, exactly as the proven refresh uses.
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

const LABEL = process.env.PROBE_LABEL || (process.argv[2] || 'unlabelled');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function probeOnce(body) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { ...HEADERS_BASE, 'request-id': crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const rawCookie = res.headers.get('set-cookie');
  return { status: res.status, gotCookie: !!rawCookie };
}

async function main() {
  console.log(`probe-setup-node-fingerprint.js — label="${LABEL}"`);
  console.log(`  node ${process.version}  |  ${API_URL}`);
  console.log('─'.repeat(60));

  const results = [];
  // Mirror the real refresh loop: up to a few attempts, both queries each.
  for (let attempt = 1; attempt <= 2; attempt++) {
    for (const q of COOKIE_QUERIES) {
      let r;
      try {
        r = await probeOnce(q);
      } catch (e) {
        r = { status: 'ERR', gotCookie: false, err: e.message };
      }
      results.push({ attempt, query: q.operationName, ...r });
      console.log(`  attempt ${attempt}  ${q.operationName.padEnd(14)} → status=${r.status}  cookie=${r.gotCookie}${r.err ? '  err=' + r.err : ''}`);
      await sleep(500);
    }
    if (results.some(r => r.gotCookie)) break; // got a session — no need to keep going
  }

  const anyCookie = results.some(r => r.gotCookie);
  const any403    = results.some(r => r.status === 403);
  const verdict = anyCookie ? 'SESSION_OK' : (any403 ? 'BLOCKED_403' : 'NO_COOKIE_OTHER');

  console.log('─'.repeat(60));
  console.log(`  VERDICT (${LABEL}): ${verdict}`);
  // Machine-readable line for the workflow to grep into the summary.
  console.log(`RESULT=${LABEL}:${verdict}`);

  if (process.env.GITHUB_OUTPUT) {
    require('fs').appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\n`);
  }
}

main().catch(e => { console.error('FATAL:', e.message); console.log(`RESULT=${LABEL}:FATAL`); process.exit(1); });
