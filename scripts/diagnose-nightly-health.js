// scripts/diagnose-nightly-health.js
//
// Checks the health of the nightly pipeline by querying the GitHub API for:
//   1. Recent nightly-crawl.yml runs and per-job results
//   2. Most recent commit touching key data directories
//   3. Whether downstream jobs (team-stats, venue-lookup, matrix) ran and succeeded
//
// Usage:
//   node scripts/diagnose-nightly-health.js
//   node scripts/diagnose-nightly-health.js --runs=10   (default: 5)
//
// Requires: GITHUB_TOKEN env var (WORKFLOW_PAT has sufficient scope)

'use strict';

const https  = require('https');
const ROOT   = require('path').join(__dirname, '..');

const REPO       = process.env.GITHUB_REPOSITORY || 'markjovic/sports-players-stats';
const TOKEN      = process.env.GITHUB_TOKEN || process.env.WORKFLOW_PAT;
const MAX_RUNS   = parseInt(process.argv.find(a => a.startsWith('--runs='))?.split('=')[1] || '5');

if (!TOKEN) {
  console.error('FATAL: GITHUB_TOKEN or WORKFLOW_PAT env var required');
  process.exit(1);
}

// ─── GitHub API ───────────────────────────────────────────────────────────────

function ghGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.github.com', path, method: 'GET',
        headers: { 'Authorization': `Bearer ${TOKEN}`, 'User-Agent': 'diagnose-nightly-health',
                   'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } },
      res => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => {
          if (res.statusCode === 404) { resolve(null); return; }
          if (res.statusCode >= 400) { reject(new Error(`GitHub API ${res.statusCode}: ${path}`)); return; }
          try { resolve(JSON.parse(Buffer.concat(c).toString())); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = Date.now();
  const ago = now - d.getTime();
  const mins  = Math.floor(ago / 60000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  const time  = d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Melbourne' });
  const date  = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Melbourne' });
  if (days === 0 && hours < 24) return `${time} AEST (${hours}h ${mins % 60}m ago)`;
  return `${date} ${time} AEST (${days}d ago)`;
}

function statusIcon(conclusion, status) {
  if (status === 'in_progress') return '🔄';
  if (status === 'queued')      return '⏳';
  switch (conclusion) {
    case 'success':   return '✅';
    case 'failure':   return '❌';
    case 'skipped':   return '⏭ ';
    case 'cancelled': return '🚫';
    default:          return '❓';
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const [owner, repo] = REPO.split('/');

  console.log('');
  console.log('═'.repeat(70));
  console.log(`  Nightly Pipeline Health — ${REPO}`);
  console.log(`  Generated: ${new Date().toISOString()}`);
  console.log('═'.repeat(70));

  // ── 1. Recent nightly-crawl runs ─────────────────────────────────────────

  console.log('\n── 1 · Recent nightly-crawl.yml runs ──────────────────────────────────\n');

  const runsData = await ghGet(`/repos/${REPO}/actions/workflows/nightly-crawl.yml/runs?per_page=${MAX_RUNS}`);
  const runs = runsData?.workflow_runs || [];

  if (!runs.length) {
    console.log('  No runs found.');
  }

  const DOWNSTREAM_JOBS = [
    'crawl', 'team-stats', 'team-index', 'venue-lookup', 'venue-indexes', 'profile-stats-matrix', 'retrigger'
  ];

  for (const run of runs) {
    const trigger = run.event === 'schedule' ? '⏰ cron' :
                    run.event === 'workflow_dispatch' ? '▶ manual' :
                    run.event === 'workflow_run' ? '↩ retrigger' : run.event;

    console.log(`  Run #${run.run_number}  [${trigger}]  ${fmt(run.created_at)}`);
    console.log(`    Overall: ${statusIcon(run.conclusion, run.status)} ${run.conclusion || run.status}`);

    // Fetch jobs for this run
    await sleep(200);
    const jobsData = await ghGet(`/repos/${REPO}/actions/runs/${run.id}/jobs`);
    const jobs = jobsData?.jobs || [];

    for (const jobName of DOWNSTREAM_JOBS) {
      const job = jobs.find(j => j.name === jobName);
      if (!job) continue;
      const duration = job.completed_at && job.started_at
        ? `${Math.round((new Date(job.completed_at) - new Date(job.started_at)) / 1000)}s`
        : '—';
      console.log(`    ${statusIcon(job.conclusion, job.status)} ${jobName.padEnd(26)} ${(job.conclusion || job.status || '').padEnd(12)} ${duration}`);
    }

    // Extract crawl summary from job steps if available
    const crawlJob = jobs.find(j => j.name === 'crawl');
    if (crawlJob) {
      const summaryStep = crawlJob.steps?.find(s => s.name?.toLowerCase().includes('summary') || s.name?.toLowerCase().includes('crawl'));
      // Can't get step output text from API — note the run URL instead
    }

    console.log(`    URL: ${run.html_url}`);
    console.log('');
  }

  // ── 2. Recent commits by data area ───────────────────────────────────────

  console.log('── 2 · Most recent commit per data area ────────────────────────────────\n');

  const PATHS_TO_CHECK = [
    { label: 'games/bv/',        path: 'games/bv',        script: 'nightly-crawl' },
    { label: 'team-stats/bv/',   path: 'team-stats/bv',   script: 'build-team-stats' },
    { label: 'venue-lookup/',    path: 'venue-lookup',    script: 'update-venue-lookup' },
    { label: 'venue-indexes',    path: 'date-venue-index',script: 'build-venue-indexes' },
    { label: 'team-index.json',  path: 'team-index.json', script: 'update-team-index' },
    { label: 'players/',         path: 'players',         script: 'fetch-profile-stats (matrix)' },
    { label: 'leaderboard/',     path: 'leaderboard',     script: 'build-leaderboards' },
    { label: 'search/',          path: 'search',          script: 'build-search-index' },
    { label: 'records/',         path: 'records',         script: 'build-records' },
  ];

  for (const check of PATHS_TO_CHECK) {
    await sleep(150);
    const data = await ghGet(`/repos/${REPO}/commits?path=${encodeURIComponent(check.path)}&per_page=1`);
    const commit = data?.[0];
    if (!commit) {
      console.log(`  ${check.label.padEnd(22)} ❓ no commits found`);
      continue;
    }
    const age    = Date.now() - new Date(commit.commit.committer.date).getTime();
    const days   = age / 86400000;
    const icon   = days < 1 ? '✅' : days < 3 ? '⚠️ ' : '❌';
    const msg    = commit.commit.message.split('\n')[0].slice(0, 55);
    console.log(`  ${icon} ${check.label.padEnd(22)} ${fmt(commit.commit.committer.date)}`);
    console.log(`       "${msg}"`);
  }

  // ── 3. Recent matrix runs ────────────────────────────────────────────────

  console.log('\n── 3 · Recent fetch-profile-stats-matrix.yml runs ─────────────────────\n');

  await sleep(200);
  const matrixRuns = await ghGet(`/repos/${REPO}/actions/workflows/fetch-profile-stats-matrix.yml/runs?per_page=5`);
  const mRuns = matrixRuns?.workflow_runs || [];

  if (!mRuns.length) {
    console.log('  No runs found.');
  } else {
    for (const run of mRuns.slice(0, 3)) {
      const trigger = run.event === 'workflow_dispatch' ? '▶ dispatch' : run.event;
      console.log(`  Run #${run.run_number}  [${trigger}]  ${fmt(run.created_at)}  ${statusIcon(run.conclusion, run.status)} ${run.conclusion || run.status}`);
    }
  }

  // ── 4. Staleness summary ─────────────────────────────────────────────────

  console.log('\n── 4 · Staleness summary ───────────────────────────────────────────────\n');

  await sleep(150);
  const allCommits = await ghGet(`/repos/${REPO}/commits?per_page=5`);
  const recentMessages = (allCommits || []).map(c => c.commit.message.split('\n')[0]);

  // Check for signs of the known issues
  const lastNightly = runs[0];
  const lastNightlyAge = lastNightly ? (Date.now() - new Date(lastNightly.created_at).getTime()) / 3600000 : 999;

  if (lastNightlyAge > 25) {
    console.log(`  ❌ Last nightly run was ${Math.round(lastNightlyAge)}h ago — cron may be disabled`);
  } else {
    console.log(`  ✅ Nightly ran ${Math.round(lastNightlyAge)}h ago`);
  }

  // Check if team-stats job succeeded in the last nightly
  if (runs.length > 0) {
    await sleep(200);
    const lastJobsData = await ghGet(`/repos/${REPO}/actions/runs/${runs[0].id}/jobs`);
    const lastJobs = lastJobsData?.jobs || [];
    const teamStatsJob  = lastJobs.find(j => j.name === 'team-stats');
    const venueJob      = lastJobs.find(j => j.name === 'venue-lookup');
    const matrixTrigger = lastJobs.find(j => j.name === 'profile-stats-matrix');

    if (teamStatsJob) {
      const icon = teamStatsJob.conclusion === 'success' ? '✅' : teamStatsJob.conclusion === 'skipped' ? '⏭ ' : '❌';
      console.log(`  ${icon} Last nightly team-stats job: ${teamStatsJob.conclusion || teamStatsJob.status}`);
    }
    if (venueJob) {
      const icon = venueJob.conclusion === 'success' ? '✅' : venueJob.conclusion === 'skipped' ? '⏭ ' : '❌';
      console.log(`  ${icon} Last nightly venue-lookup job: ${venueJob.conclusion || venueJob.status}`);
    }
    if (matrixTrigger) {
      const icon = matrixTrigger.conclusion === 'success' ? '✅' : matrixTrigger.conclusion === 'skipped' ? '⏭ ' : '❌';
      console.log(`  ${icon} Last nightly matrix trigger: ${matrixTrigger.conclusion || matrixTrigger.status}`);
    }
  }

  console.log('');
  console.log('═'.repeat(70));
  console.log('  Done.');
  console.log('═'.repeat(70));
  console.log('');
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
