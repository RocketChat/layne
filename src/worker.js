import 'dotenv/config';
import { fileURLToPath } from 'url';
import { Worker } from 'bullmq';
import { redis } from './queue.js';
import { getInstallationToken } from './auth.js';
import { startCheckRun, completeCheckRun } from './github.js';
import { createWorkspace, cloneRepo, fetchBase, getChangedFiles, cleanupWorkspace } from './fetcher.js';
import { dispatch } from './dispatcher.js';
import { buildAnnotations } from './reporter.js';
import { validateEnv } from './env.js';

const SCAN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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
  // Use a resolving sentinel rather than a rejecting promise so there is
  // no risk of an unhandled rejection if the race settles before handlers attach.
  let timer;
  const timeoutSentinel = Symbol('timeout');
  const timeoutPromise  = new Promise(resolve => {
    timer = setTimeout(() => resolve(timeoutSentinel), SCAN_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([runScan(job).then(() => null), timeoutPromise]);

    if (result === timeoutSentinel) {
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

    // Keep the check run open for retryable failures so the next attempt can
    // continue the same check instead of flipping it to failed too early.
    if (finalAttempt) {
      const { installationId, owner, repo, checkRunId } = job.data;
      await completeCheckRun({
        installationId,
        owner,
        repo,
        checkRunId,
        conclusion:  'failure',
        annotations: [],
        summary:     `Layne encountered an internal error: ${safeMessage}`,
      }).catch(() => {});
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

  try {
    // Signal to GitHub that we've started — PR check moves from "queued" to "in progress"
    await startCheckRun({ installationId, owner, repo, checkRunId });

    const token = await getInstallationToken(installationId);
    workspacePath = await createWorkspace(job.id);

    await cloneRepo({ token, cloneUrl, headSha, workspacePath });
    await fetchBase({ workspacePath, baseRef });
    const changedFiles = await getChangedFiles({ workspacePath });

    const findings = await dispatch({ workspacePath, baseSha, baseRef, changedFiles, labels, owner, repo });
    const { annotations, conclusion, summary } = buildAnnotations(findings);

    await completeCheckRun({ installationId, owner, repo, checkRunId, conclusion, annotations, summary });

    console.log(`[worker] Completed scan for ${owner}/${repo} PR #${prNumber} — ${conclusion}`);
  } finally {
    // Always clean up — code must not linger on disk after a scan finishes.
    if (workspacePath) {
      await cleanupWorkspace(workspacePath);
    }
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

/**
 * Gracefully stops the worker — finishes any in-flight job then exits.
 * Called on SIGTERM (Docker stop) and SIGINT (Ctrl-C) so that the PR check
 * run is never left stuck in "in_progress" due to a hard kill.
 */
export async function shutdown() {
  console.log('[worker] Shutting down gracefully…');
  await worker.close();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  validateEnv();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
  console.log('[worker] Layne worker started — concurrency: 3');
}
