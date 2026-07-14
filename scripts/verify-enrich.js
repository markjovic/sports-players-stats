// scripts/verify-enrich.js
//
// READ-ONLY data-integrity check for the rekey-enrich commits. Diffs a baseline
// (default: parent of the OLDEST "rekey-enrich: spectatorIds" commit) against
// HEAD across players/{hex}/*.json and, for every changed file, confirms the
// current version still parses and retains ALL of the baseline's data — seasons,
// games, teams, records, sports totals, and every existing top-level key. The
// only permitted difference is an added spectatorIds field (and reformatting).
//
// Reads git objects via `git cat-file --batch` (no working-tree checkout needed,
// so no slow full checkout). Writes ONLY reports/verify-enrich-report.json.

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const git = a => execFileSync('git', a, { cwd: ROOT, maxBuffer: 1 << 30 }).toString();

const PLAYER_RE = /^players\/[0-9a-f]{2}\/[0-9a-f-]{36}\.json$/;
const SPORT_KEYS = ['gp', 'pts', 'fouls', 'fg', 'ft', 'threePt', 'finals', 'gfApps', 'gfWins', 'wins', 'losses', 'draws'];
const HEX = '0123456789abcdef';
const ALL_BUCKETS = []; for (const a of HEX) for (const b of HEX) ALL_BUCKETS.push(a + b);

function detectBaseline() {
  const out = git(['log', '--reverse', '--format=%H%x1f%P', '--grep=rekey-enrich: spectatorIds']).trim();
  if (!out) throw new Error('no "rekey-enrich: spectatorIds" commits found — pass --baseline <sha>');
  const [, parents] = out.split('\n')[0].split('\x1f');
  return parents.split(' ')[0]; // first parent of the earliest enrich commit
}

// Read many git objects in one process. refs like "SHA:path". Returns array
// aligned to refs; null for missing/unparseable.
function catFileBatch(refs) {
  const buf = execFileSync('git', ['cat-file', '--batch'], { cwd: ROOT, input: refs.join('\n') + '\n', maxBuffer: 1 << 30 });
  const out = []; let i = 0;
  while (i < buf.length && out.length < refs.length) {
    const nl = buf.indexOf(0x0a, i);
    const header = buf.toString('utf8', i, nl); i = nl + 1;
    if (header.endsWith(' missing')) { out.push(null); continue; }
    const size = parseInt(header.slice(header.lastIndexOf(' ') + 1), 10);
    out.push(buf.toString('utf8', i, i + size)); i += size + 1;
  }
  return out;
}
function parse(s) { if (s == null) return undefined; try { return JSON.parse(s); } catch (e) { return null; } }

function checkFile(oldO, newO) {
  const p = [];
  if (newO === null) return ['current version does NOT parse (corrupt/truncated)'];
  if (!oldO) return [];                                    // no baseline version → nothing to lose
  const oS = Array.isArray(oldO.seasons) ? oldO.seasons : [];
  const nS = Array.isArray(newO.seasons) ? newO.seasons : [];
  if (nS.length < oS.length) p.push(`seasons ${oS.length}->${nS.length}`);
  const oRegs = oS.reduce((n, s) => n + (Array.isArray(s.regs) ? s.regs.length : 0), 0);
  const nRegs = nS.reduce((n, s) => n + (Array.isArray(s.regs) ? s.regs.length : 0), 0);
  if (nRegs < oRegs) p.push(`regs ${oRegs}->${nRegs}`);
  const og = Array.isArray(oldO.games) ? oldO.games.length : 0, ng = Array.isArray(newO.games) ? newO.games.length : 0;
  if (ng < og) p.push(`games ${og}->${ng}`);
  const ot = Array.isArray(oldO.teams) ? oldO.teams.length : 0, nt = Array.isArray(newO.teams) ? newO.teams.length : 0;
  if (nt < ot) p.push(`teams ${ot}->${nt}`);
  for (const k of (oldO.records ? Object.keys(oldO.records) : [])) if (!newO.records || !(k in newO.records)) p.push(`records.${k} missing`);
  const ob = oldO.sports && oldO.sports.Basketball, nb = newO.sports && newO.sports.Basketball;
  if (ob) { if (!nb) p.push('sports.Basketball missing'); else for (const k of SPORT_KEYS) if (k in ob && ob[k] !== nb[k]) p.push(`sports.${k} ${ob[k]}->${nb[k]}`); }
  for (const k of Object.keys(oldO)) {
    if (k === 'spectatorIds') continue;
    if (!(k in newO)) { p.push(`top-level "${k}" removed`); continue; }
    if (JSON.stringify(oldO[k]) !== JSON.stringify(newO[k])) p.push(`"${k}" changed`);
  }
  for (const k of Object.keys(newO)) if (k !== 'spectatorIds' && !(k in oldO)) p.push(`unexpected new key "${k}"`);
  return p;
}

function main() {
  const baseline = val('--baseline', null) || detectBaseline();
  process.stderr.write(`baseline = ${baseline}\n`);
  let checked = 0, flagged = 0; const bad = [];
  for (const bucket of ALL_BUCKETS) {
    const names = git(['diff', '--name-only', baseline, 'HEAD', '--', `players/${bucket}/`])
      .trim().split('\n').filter(x => PLAYER_RE.test(x));
    if (!names.length) continue;
    const refs = []; for (const f of names) { refs.push(`${baseline}:${f}`, `HEAD:${f}`); }
    const blobs = catFileBatch(refs);
    for (let j = 0; j < names.length; j++) {
      checked++;
      const problems = checkFile(parse(blobs[2 * j]), parse(blobs[2 * j + 1]));
      if (problems.length) { flagged++; bad.push({ file: names[j], problems }); }
    }
  }
  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'verify-enrich-report.json'), JSON.stringify({ baseline, checked, flagged, bad }, null, 2));
  const md = ['## verify-enrich (read-only)', '', `baseline: \`${baseline}\``, '', '| metric | value |', '|---|---|',
    `| player files changed since baseline | ${checked} |`, `| files with possible DATA LOSS | ${flagged} |`];
  if (bad.length) md.push('', 'Flagged files (first 50):', ...bad.slice(0, 50).map(b => `- \`${b.file}\` — ${b.problems.join('; ')}`));
  else md.push('', '**All changed player files retained their data. No loss.**');
  if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n'); } catch (e) {} }
  process.stderr.write(`\nDONE. checked=${checked} flagged=${flagged}\n`);
}
main();
