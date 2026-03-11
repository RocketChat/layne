import 'dotenv/config';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { Worker } from 'bullmq';
import { redis, scanQueue } from './queue.js';
import { getInstallationToken } from './auth.js';
import { startCheckRun, completeCheckRun, ensureLabelsExist, setLabels } from './github.js';
import { createWorkspace, cloneRepo, fetchBase, getChangedFiles, cleanupWorkspace } from './fetcher.js';
import { dispatch } from './dispatcher.js';
import { buildAnnotations } from './reporter.js';
import { loadScanConfig } from './config.js';
import { notify } from './notifiers/index.js';
import { validateEnv } from './env.js';
import { debug } from './debug.js';
import {
  registry,
  scanTotal,
  scanDuration,
  scanTimeoutsTotal,
  scanRetriesTotal,
  findingTotal,
  findingsPerScan,
  queueWaiting,
  queueActive,
  queueFailed,
} from './metrics.js';

const SCAN_TIMEOUT_MS  = 10 * 60 * 1000; // 10 minutes
const NOTIFY_COUNT_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const METRICS_ENABLED  = process.env.METRICS_ENABLED === 'true';
const METRICS_PORT     = parseInt(process.env.METRICS_PORT ?? '9091', 10);

function notifyCountKey(owner, repo, prNumber) {
  return `layne:scan:count:${owner}/${repo}#${prNumber}`;
}

async function getNotifyCount(owner, repo, prNumber) {
  try {
    const val = await redis.get(notifyCountKey(owner, repo, prNumber));
    return val === null ? 0 : parseInt(val, 10);
  } catch (err) {
    console.warn(`[worker] Failed to read notification count from Redis: ${err.message} — treating as 0`);
    return 0;
  }
}

async function setNotifyCount(owner, repo, prNumber, count) {
  try {
    await redis.set(notifyCountKey(owner, repo, prNumber), count, 'EX', NOTIFY_COUNT_TTL);
  } catch (err) {
    console.warn(`[worker] Failed to write notification count to Redis: ${err.message}`);
  }
}

/**
 * Strips installation tokens from error messages before they appear in logs
 * or GitHub check run summaries. Tokens are embedded in git HTTPS URLs as
 * https://x-access-token:<token>@github.com/...
 */
function sanitizeError(message) {
  return (message ?? '').replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@');
}

/**
 * Core job processor — exported so tests can invoke it directly
 * without needing a live BullMQ worker or Redis connection.
 */
export async function processJob(job) {
  // Resolving sentinel rather than a rejecting promise so there is no risk of an
  // unhandled rejection if the race settles before handlers attach.
  let timer;
  const timeoutSentinel = Symbol('timeout');
  const timeoutPromise  = new Promise(resolve => {
    timer = setTimeout(() => resolve(timeoutSentinel), SCAN_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([runScan(job).then(() => null), timeoutPromise]);

    if (result === timeoutSentinel) {
      scanTimeoutsTotal.inc();
      throw new Error(`Scan timed out after ${SCAN_TIMEOUT_MS / 60000} minutes`);
    }
  } catch (err) {
    const safeMessage = sanitizeError(err.message);
    const finalAttempt = isFinalAttempt(job);
    const attempt = (job.attemptsMade ?? 0) + 1;
    const totalAttempts = job.opts?.attempts ?? 1;
    const retryMessage = finalAttempt ? '' : ` Retrying (${attempt}/${totalAttempts})...`;

    console.error(
      `[worker] Scan failed for ${job.data.owner}/${job.data.repo} PR #${job.data.prNumber}:`,
      `${safeMessage}${retryMessage}`
    );

    if (finalAttempt) {
      const { installationId, owner, repo, checkRunId } = job.data;
      scanTotal.inc({ conclusion: 'failure', owner, repo });
      // Keep the check run open for retryable failures so the next attempt can update it
      // rather than flipping it to failed prematurely.
      await completeCheckRun({
        installationId,
        owner,
        repo,
        checkRunId,
        conclusion:  'failure',
        annotations: [],
        summary:     `Layne encountered an internal error: ${safeMessage}`,
      }).catch(() => {});
    } else {
      scanRetriesTotal.inc();
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function runScan(job) {
  const {
    installationId,
    owner,
    repo,
    cloneUrl,
    headSha,
    baseSha,
    baseRef,
    prNumber,
    labels,
    checkRunId,
  } = job.data;

  let workspacePath = null;
  let conclusion    = 'failure'; // updated to actual value after buildAnnotations
  const stopTimer   = scanDuration.startTimer();

  try {
    debug('worker', `starting scan: ${owner}/${repo} PR #${prNumber} head=${headSha} base=${baseRef}`);

    await startCheckRun({ installationId, owner, repo, checkRunId });
    debug('worker', 'check run marked in_progress');

    const token = await getInstallationToken(installationId);
    debug('worker', 'installation token acquired');

    workspacePath = await createWorkspace(job.id);

    await cloneRepo({ token, cloneUrl, headSha, workspacePath });
    await fetchBase({ workspacePath, baseSha });
    const changedFiles = await getChangedFiles({ workspacePath });
    debug('worker', `dispatching ${changedFiles.length} file(s) to scanners`);

    const scanConfig = await loadScanConfig({ owner, repo });

    const findings = await dispatch({ workspacePath, baseSha, baseRef, changedFiles, labels, owner, repo });
    console.log(`[worker] ${findings.length} total finding(s) for ${owner}/${repo} PR #${prNumber} across all tools:`);
    for (const f of findings) {
      console.log(`[worker]   ${f.tool} ${f.severity.toUpperCase()} ${f.file}:${f.line} [${f.ruleId}] ${f.message}`);
      findingTotal.inc({ severity: f.severity, tool: f.tool, owner, repo });
    }

    const result = buildAnnotations(findings);
    conclusion = result.conclusion;

    await completeCheckRun({ installationId, owner, repo, checkRunId, conclusion, annotations: result.annotations, summary: result.summary });

    console.log(`[worker] Completed scan for ${owner}/${repo} PR #${prNumber} — ${conclusion}`);

    scanTotal.inc({ conclusion, owner, repo });
    findingsPerScan.observe({ conclusion }, findings.length);

    // Label management — errors never affect the scan result.
    const { labels: labelConfig } = scanConfig;
    const toAdd    = conclusion === 'failure'
      ? (labelConfig.onFailure       ?? [])
      : (labelConfig.onSuccess       ?? []);
    const toRemove = conclusion === 'failure'
      ? (labelConfig.removeOnFailure ?? [])
      : (labelConfig.removeOnSuccess ?? []);

    if (toAdd.length || toRemove.length) {
      await ensureLabelsExist({ installationId, owner, repo, labelNames: toAdd })
        .catch(err => console.error('[worker] ensureLabelsExist error:', err.message));
      await setLabels({ installationId, owner, repo, prNumber, add: toAdd, remove: toRemove })
        .catch(err => console.error('[worker] setLabels error:', err.message));
    }

    const prevCount = await getNotifyCount(owner, repo, prNumber);
    await setNotifyCount(owner, repo, prNumber, findings.length);

    if (findings.length > prevCount) {
      await notify({ findings, owner, repo, prNumber, notificationConfig: scanConfig.notifications })
        .catch(err => console.error('[worker] notification dispatch error:', err.message));
    }
  } finally {
    if (workspacePath) {
      await cleanupWorkspace(workspacePath);
    }
    stopTimer({ conclusion });
  }
}

function isFinalAttempt(job) {
  const totalAttempts = job.opts?.attempts ?? 1;
  const currentAttempt = (job.attemptsMade ?? 0) + 1;
  return currentAttempt >= totalAttempts;
}

const worker = new Worker('scans', processJob, {
  connection:  redis,
  concurrency: 3,
});

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} permanently failed:`, err.message);
});

// --- metrics HTTP server (only when METRICS_ENABLED=true) ---

let metricsServer = null;
let queuePoller   = null;

if (METRICS_ENABLED) {
  metricsServer = createServer(async (_req, res) => {
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });
  metricsServer.listen(METRICS_PORT, () => {
    console.log(`[worker] Metrics server listening on port ${METRICS_PORT}`);
  });

  // Poll BullMQ queue counts every 15 seconds to keep the gauges up to date.
  queuePoller = setInterval(async () => {
    try {
      const counts = await scanQueue.getJobCounts('wait', 'active', 'failed');
      queueWaiting.set(counts.wait   ?? 0);
      queueActive.set(counts.active  ?? 0);
      queueFailed.set(counts.failed  ?? 0);
    } catch {
      // Metrics are best-effort — a Redis hiccup should not crash the worker.
    }
  }, 15_000);
}

// Gracefully stops the worker — finishes any in-flight job before exiting.
// Called on SIGTERM (Docker stop) and SIGINT (Ctrl-C) so that PR check runs are
// never left stuck in "in_progress" due to a hard kill.
export async function shutdown() {
  console.log('[worker] Shutting down gracefully…');
  if (queuePoller) clearInterval(queuePoller);
  await worker.close();
  if (metricsServer) await new Promise(resolve => metricsServer.close(resolve));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  validateEnv();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
  console.log('[worker] Layne worker started — concurrency: 3');
}
