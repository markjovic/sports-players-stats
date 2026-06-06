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

// Recursively sum size of all files under a directory
function dirSize(dirPath) {
  let total = 0;
  let count = 0;
  if (!fs.existsSync(dirPath)) return { total, count };
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = dirSize(full);
      total += sub.total;
      count += sub.count;
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
      count++;
    }
  }
  return { total, count };
}

// Walk all files recursively, returning { path, size }[]
function walkFiles(dirPath, rel = '') {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, relPath));
    } else if (entry.isFile()) {
      results.push({ path: relPath, size: fs.statSync(full).size });
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

  // ── Top N largest files ──
  console.log(`\n🏆 Top ${TOP_N} largest files:`);
  console.log('─'.repeat(72));

  // Walk the whole repo to find largest files (skip .git)
  const allFiles = walkFiles(ROOT_DIR)
    .filter(f => !f.path.startsWith('.git/') && !f.path.startsWith('node_modules/'))
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
