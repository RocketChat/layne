import 'dotenv/config';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { Worker } from 'bullmq';
import { redis, scanQueue } from './queue.js';
import { getInstallationToken } from './auth.js';
import { startCheckRun, completeCheckRun, ensureLabelsExist, setLabels, getMergeBaseSha } from './github.js';
import { createWorkspace, setupRepo, getChangedFiles, getChangedLineRanges, checkoutFiles, cleanupWorkspace } from './fetcher.js';
import { createScanContext, filterFindingsToChangedLines } from './scan-context.js';
import { dispatch } from './dispatcher.js';
import { suppressFindings } from './suppressor.js';
import { validateFindingLocations } from './location-validator.js';
import { buildAnnotations } from './reporter.js';
import { loadScanConfig } from './config.js';
import { notify } from './notifiers/index.js';
import { postComment } from './commenter.js';
import { validateEnv } from './env.js';
import { debug } from './debug.js';
import { generateFindingId, loadExceptions, buildExceptionSummary } from './exception-approvals.js';
import {
  registry,
  scanTotal,
  scanDuration,
  scanTimeoutsTotal,
  scanRetriesTotal,
  findingTotal,
  findingPlacementTotal,
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

function isActionableFinding(finding) {
  if (finding.annotationEligible === false) return false;
  if (finding.tool === 'claude' && finding.locationValidated !== true) return false;
  return true;
}

function appendDiscardedCandidateSummary(summary, discardedCount) {
  if (discardedCount === 0) return summary;
  return `${summary} Omitted ${discardedCount} finding candidate(s) that could not be resolved to a precise code location.`;
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

    // Resolve the merge base so the diff matches GitHub's PR view (three-dot diff).
    // pull_request.base.sha is the tip of the base branch, which may have advanced
    // since the PR was opened — diffing directly against it would include files
    // changed in the base branch that the PR never touched.
    const mergeBaseSha = await getMergeBaseSha({ installationId, owner, repo, base: baseSha, head: headSha });
    debug('worker', `merge base resolved: ${mergeBaseSha}`);

    workspacePath = await createWorkspace(job.id);

    await setupRepo({ token, cloneUrl, headSha, baseSha: mergeBaseSha, workspacePath });
    const rawChanged   = await getChangedFiles({ workspacePath, baseSha: mergeBaseSha, headSha });
    const changedLineRanges = await getChangedLineRanges({ workspacePath, baseSha: mergeBaseSha, headSha });
    const changedFiles = await checkoutFiles({ workspacePath, headSha, files: rawChanged });

    const scanConfig = await loadScanConfig({ owner, repo });

    const scanContext = await createScanContext({ workspacePath, changedFiles, baseSha: mergeBaseSha, headSha, scanConfig });
    debug('worker', `dispatching ${scanContext.scanFiles.length} file(s) to scanners (mode: ${scanContext.mode})`);

    const rawFindings = await dispatch({ scanContext, changedLineRanges, owner, repo });
    const diffFilteredFindings = filterFindingsToChangedLines(rawFindings, scanContext);
    const validatedFindings = await validateFindingLocations(diffFilteredFindings, { workspacePath: scanContext.repoWorkspacePath, changedFiles, changedLineRanges });
    logFindingPlacement(validatedFindings, { owner, repo, prNumber });
    const findings = await suppressFindings(validatedFindings, { workspacePath: scanContext.repoWorkspacePath, baseSha: mergeBaseSha, headSha });
    const actionableFindings = findings.filter(isActionableFinding);
    const discardedCount = findings.length - actionableFindings.length;
    console.log(`[worker] ${actionableFindings.length} actionable finding(s) for ${owner}/${repo} PR #${prNumber} across all tools:`);
    for (const f of actionableFindings) {
      console.log(`[worker]   ${f.tool} ${f.severity.toUpperCase()} ${f.file}:${f.startLine ?? f.line}-${f.endLine ?? f.line} [${f.ruleId}] ${f.message}`);
      findingTotal.inc({ severity: f.severity, tool: f.tool, owner, repo });
    }
    if (discardedCount > 0) {
      console.log(`[worker] Omitted ${discardedCount} finding candidate(s) from check/comment/notification output because they could not be resolved to a precise code location.`);
    }

    for (const f of actionableFindings) f._findingId = generateFindingId(f);

    const result = buildAnnotations(actionableFindings);
    let summary = appendDiscardedCandidateSummary(result.summary, discardedCount);
    conclusion = result.conclusion;

    let exceptionApproval = null;
    const { exceptionApprovers } = scanConfig;

    if (exceptionApprovers?.users?.length || exceptionApprovers?.teams?.length) {
      const blockingIds = actionableFindings
        .filter(f => f.severity === 'critical' || f.severity === 'high')
        .map(f => f._findingId);

      const exceptions = blockingIds.length > 0
        ? await loadExceptions({ owner, repo, prNumber, headSha, findingIds: blockingIds })
            .catch(err => { console.error(`[worker] Failed to load exceptions: ${err.message}`); return new Map(); })
        : new Map();

      const override = buildExceptionSummary({ findings: actionableFindings, exceptions, baseSummary: appendDiscardedCandidateSummary(result.summary, discardedCount) });
      conclusion = override.conclusion;
      summary    = override.summary;

      if (conclusion === 'success' && exceptions.size > 0) {
        const approvers = [...new Set([...exceptions.values()].map(e => e.approver))].join(', ');
        exceptionApproval = { approved: true, approver: approvers };
        console.log(`[worker] Exception approved by @${approvers} for ${owner}/${repo} PR #${prNumber}`);
      }
    }

    await completeCheckRun({ installationId, owner, repo, checkRunId, conclusion, annotations: result.annotations, summary });

    console.log(`[worker] Completed scan for ${owner}/${repo} PR #${prNumber} — ${conclusion}`);

    const { comment: commentConfig } = scanConfig;
    if (commentConfig.enabled) {
      await postComment({ findings: actionableFindings, owner, repo, prNumber, installationId, conclusion, commentConfig })
        .catch(err => console.error('[worker] PR comment error:', err.message));
    }

    scanTotal.inc({ conclusion, owner, repo });
    findingsPerScan.observe({ conclusion }, actionableFindings.length);

    // Label management — errors never affect the scan result.
    const { labels: labelConfig } = scanConfig;
    let toAdd, toRemove;
    
    if (exceptionApproval?.approved) {
      toAdd = labelConfig.onException ?? [];
      toRemove = labelConfig.removeOnException ?? [];
    } else if (conclusion === 'failure') {
      toAdd = labelConfig.onFailure ?? [];
      toRemove = labelConfig.removeOnFailure ?? [];
    } else {
      toAdd = labelConfig.onSuccess ?? [];
      toRemove = labelConfig.removeOnSuccess ?? [];
    }

    if (toAdd.length || toRemove.length) {
      await ensureLabelsExist({ installationId, owner, repo, labelNames: toAdd })
        .catch(err => console.error('[worker] ensureLabelsExist error:', err.message));
      await setLabels({ installationId, owner, repo, prNumber, add: toAdd, remove: toRemove })
        .catch(err => console.error('[worker] setLabels error:', err.message));
    }

    const prevCount = await getNotifyCount(owner, repo, prNumber);
    await setNotifyCount(owner, repo, prNumber, actionableFindings.length);

    // Always notify on exception approval, otherwise only on new findings
    if (exceptionApproval?.approved || actionableFindings.length > prevCount) {
      await notify({ findings: actionableFindings, owner, repo, prNumber, notificationConfig: scanConfig.notifications, exceptionApproval })
        .catch(err => console.error('[worker] notification dispatch error:', err.message));
    }
  } finally {
    if (workspacePath) {
      await cleanupWorkspace(workspacePath);
    }
    stopTimer({ conclusion });
  }
}

function logFindingPlacement(findings, { owner, repo, prNumber }) {
  if (findings.length === 0) return;

  const counts = new Map();
  let claudeTotal = 0;
  let claudeInlineable = 0;

  for (const finding of findings) {
    const outcome = finding.annotationEligible === false ? 'not_inlineable' : 'inlineable';
    const reason = finding.annotationEligible === false
      ? (finding.annotationReason ?? finding.locationReason ?? 'unknown')
      : (finding.locationReason ?? 'validated');

    findingPlacementTotal.inc({ tool: finding.tool, outcome, reason });
    counts.set(`${finding.tool}|${outcome}|${reason}`, (counts.get(`${finding.tool}|${outcome}|${reason}`) ?? 0) + 1);

    if (finding.tool === 'claude') {
      claudeTotal++;
      if (finding.annotationEligible !== false) claudeInlineable++;
    }
  }

  const summary = Array.from(counts.entries())
    .map(([key, count]) => {
      const [tool, outcome, reason] = key.split('|');
      return `${tool}:${outcome}:${reason}=${count}`;
    })
    .join(', ');

  console.log(`[worker] Finding placement for ${owner}/${repo} PR #${prNumber}: ${summary}`);

  if (claudeTotal === 0) return;

  console.log(`[worker] Claude placement summary for ${owner}/${repo} PR #${prNumber}: inlineable=${claudeInlineable}/${claudeTotal}`);
  for (const finding of findings.filter(f => f.tool === 'claude')) {
    console.log(
      `[worker]   claude placement ${finding.file}:${finding.startLine ?? finding.line}-${finding.endLine ?? finding.line}` +
      ` evidenceSpan=${finding.evidenceStartLine ?? finding.startLine ?? finding.line}-${finding.evidenceEndLine ?? finding.endLine ?? finding.startLine ?? finding.line}` +
      ` rule=${finding.ruleId}` +
      ` evidence=${finding.evidenceStatus ?? 'n/a'}` +
      ` anchorKind=${finding.anchorKind ?? 'none'}` +
      ` annotation=${finding.annotationStartLine ?? 'none'}` +
      ` suppression=${finding.suppressionLine ?? finding.startLine ?? finding.line ?? 'none'}` +
      ` eligible=${finding.annotationEligible !== false}` +
      ` locationReason=${finding.locationReason ?? 'unknown'}` +
      ` annotationReason=${finding.annotationReason ?? 'unknown'}`
    );
  }
}

function isFinalAttempt(job) {
  const totalAttempts = job.opts?.attempts ?? 1;
  const currentAttempt = (job.attemptsMade ?? 0) + 1;
  return currentAttempt >= totalAttempts;
}

const worker = new Worker('scans', processJob, {
  connection:  redis,
  concurrency: 5,
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
  console.log('[worker] Layne worker started — concurrency: 5');
}
