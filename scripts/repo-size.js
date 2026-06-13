#!/usr/bin/env node
// repo-size.js
/**
 * Reports repo disk usage by folder and top N files by size.
 * Run via the Repo Size workflow or locally: node repo-size.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const TOP_N    = parseInt(process.argv.find(a => a.startsWith('--top='))?.split('=')[1] || '20', 10);
const ROOT_DIR = path.resolve(__dirname);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(2)    + ' MB';
  if (bytes >= 1024)       return (bytes / 1024).toFixed(1)       + ' KB';
  return bytes + ' B';
}

function fmtPct(part, total) {
  return total ? ((part / total) * 100).toFixed(1) + '%' : '—';
}

function pad(str, len, right = false) {
  str = String(str);
  return right ? str.padStart(len) : str.padEnd(len);
}

// Iteratively sum size of all files under a directory
function dirSize(dirPath) {
  let total = 0, count = 0;
  if (!fs.existsSync(dirPath)) return { total, count };
  const queue = [dirPath];
  while (queue.length) {
    const current = queue.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
        count++;
      }
    }
  }
  return { total, count };
}

// Walk all files iteratively (avoid stack overflow on large trees)
function walkFiles(dirPath, skipDirs = new Set()) {
  const results = [];
  const queue = [dirPath];
  while (queue.length) {
    const current = queue.pop();
    if (!fs.existsSync(current)) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel  = path.relative(dirPath, full);
      if (entry.isDirectory()) {
        const topLevel = rel.split('/')[0];
        if (!skipDirs.has(topLevel)) queue.push(full);
      } else if (entry.isFile()) {
        results.push({ path: rel, size: fs.statSync(full).size });
      }
    }
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('=== Repo Size Report ===\n');

  // Top-level entries to measure (folders + root-level files)
  const entries = fs.readdirSync(ROOT_DIR, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules');

  // Measure each
  const rows = [];
  let repoTotal = 0;
  let repoCount = 0;

  for (const entry of entries) {
    const full = path.join(ROOT_DIR, entry.name);
    if (entry.isDirectory()) {
      const { total, count } = dirSize(full);
      rows.push({ name: entry.name + '/', size: total, count, isDir: true });
      repoTotal += total;
      repoCount += count;
    } else {
      const size = fs.statSync(full).size;
      rows.push({ name: entry.name, size, count: 1, isDir: false });
      repoTotal += size;
      repoCount++;
    }
  }

  rows.sort((a, b) => b.size - a.size);

  // ── Folder/file summary ──
  console.log('📁 Size by folder / file (repo root):');
  console.log('─'.repeat(62));
  console.log(`  ${pad('Name', 32)} ${pad('Size', 10, true)}  ${pad('Files', 8, true)}  % of repo`);
  console.log('─'.repeat(62));
  for (const row of rows) {
    const icon = row.isDir ? '📂' : '📄';
    console.log(`  ${icon} ${pad(row.name, 30)} ${pad(fmtBytes(row.size), 10, true)}  ${pad(row.count.toLocaleString(), 8, true)}  ${fmtPct(row.size, repoTotal)}`);
  }
  console.log('─'.repeat(62));
  console.log(`  ${pad('TOTAL', 32)} ${pad(fmtBytes(repoTotal), 10, true)}  ${pad(repoCount.toLocaleString(), 8, true)}`);

  // ── Top N largest files — skip massive dirs, show their sub-breakdown instead ──
  const SKIP_DIRS = new Set(
    rows.filter(r => r.isDir && r.size > 50 * 1024 * 1024).map(r => r.name.replace(/\/$/, ''))
  );

  console.log(`\n🏆 Top ${TOP_N} largest files (excluding large data dirs):`);
  if (SKIP_DIRS.size > 0) console.log(`   (skipping: ${[...SKIP_DIRS].join(', ')} — shown by sub-folder below)`);
  console.log('─'.repeat(72));

  const allFiles = walkFiles(ROOT_DIR, SKIP_DIRS)
    .filter(f => !f.path.startsWith('.git') && !f.path.startsWith('node_modules'))
    .sort((a, b) => b.size - a.size)
    .slice(0, TOP_N);

  for (let i = 0; i < allFiles.length; i++) {
    const f = allFiles[i];
    console.log(`  ${pad(i + 1, 3, true)}.  ${pad(fmtBytes(f.size), 10, true)}  ${f.path}`);
  }
  console.log('─'.repeat(72));

  // ── Sub-folder breakdown for large dirs ──
  const largeDirs = rows.filter(r => r.isDir && r.size > 10 * 1024 * 1024); // >10MB
  for (const dir of largeDirs) {
    const dirPath = path.join(ROOT_DIR, dir.name.replace(/\/$/, ''));
    const subEntries = fs.readdirSync(dirPath, { withFileTypes: true });
    const subRows = [];
    for (const sub of subEntries) {
      const full = path.join(dirPath, sub.name);
      if (sub.isDirectory()) {
        const { total, count } = dirSize(full);
        subRows.push({ name: sub.name + '/', size: total, count });
      } else {
        subRows.push({ name: sub.name, size: fs.statSync(full).size, count: 1 });
      }
    }
    subRows.sort((a, b) => b.size - a.size);
    const top10 = subRows.slice(0, 10);

    console.log(`\n  📂 ${dir.name} breakdown (top 10 sub-entries):`);
    console.log('  ' + '─'.repeat(56));
    for (const sub of top10) {
      console.log(`    ${pad(sub.name, 30)} ${pad(fmtBytes(sub.size), 10, true)}  ${pad(sub.count.toLocaleString(), 8, true)} files  ${fmtPct(sub.size, dir.size)}`);
    }
    console.log('  ' + '─'.repeat(56));
  }

  console.log('\n✅ Done');
}

main();
