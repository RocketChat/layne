import 'dotenv/config';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
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
import { generateFindingId, loadExceptions, filterStaleExceptions, resolveDriftedExceptions, buildExceptionSummary } from './exception-approvals.js';
import type { ProcessedFinding, JobData } from './types.js';
import type { ExceptionApprovalInfo } from './notifiers/types.js';
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

const NOTIFY_COUNT_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const METRICS_ENABLED  = process.env.METRICS_ENABLED === 'true';
const METRICS_PORT     = parseInt(process.env.METRICS_PORT ?? '9091', 10);

function notifyCountKey(owner: string, repo: string, prNumber: number): string {
  return `layne:scan:count:${owner}/${repo}#${prNumber}`;
}

async function getNotifyCount(owner: string, repo: string, prNumber: number): Promise<number> {
  try {
    const val = await redis.get(notifyCountKey(owner, repo, prNumber));
    return val === null ? 0 : parseInt(val, 10);
  } catch (err) {
    console.warn(`[worker] Failed to read notification count from Redis: ${(err as Error).message} — treating as 0`);
    return 0;
  }
}

async function setNotifyCount(owner: string, repo: string, prNumber: number, count: number): Promise<void> {
  try {
    await redis.set(notifyCountKey(owner, repo, prNumber), count, 'EX', NOTIFY_COUNT_TTL);
  } catch (err) {
    console.warn(`[worker] Failed to write notification count to Redis: ${(err as Error).message}`);
  }
}

/**
 * Strips installation tokens from error messages before they appear in logs
 * or GitHub check run summaries.
 */
function sanitizeError(message: string): string {
  return (message ?? '').replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@');
}

function isActionableFinding(finding: ProcessedFinding): boolean {
  if (finding.annotationEligible === false) return false;
  if (finding.tool === 'claude' && finding.locationValidated !== true) return false;
  return true;
}

function appendDiscardedCandidateSummary(summary: string, discardedCount: number): string {
  if (discardedCount === 0) return summary;
  return `${summary} Omitted ${discardedCount} finding candidate(s) that could not be resolved to a precise code location.`;
}

/**
 * Core job processor — exported so tests can invoke it directly
 * without needing a live BullMQ worker or Redis connection.
 */
export async function processJob(job: Job<JobData>): Promise<void> {
  const { owner, repo } = job.data;
  const scanConfig = await loadScanConfig({ owner, repo });
  const timeoutMs = scanConfig.timeoutMinutes * 60 * 1000;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutSentinel = Symbol('timeout');
  const timeoutPromise  = new Promise<typeof timeoutSentinel>(resolve => {
    timer = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
  });

  try {
    const result = await Promise.race([runScan(job, scanConfig).then(() => null as null), timeoutPromise]);

    if (result === timeoutSentinel) {
      scanTimeoutsTotal.inc();
      throw new Error(`Scan timed out after ${timeoutMs / 60000} minutes`);
    }
  } catch (err) {
    const safeMessage = sanitizeError((err as Error).message);
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

async function runScan(job: Job<JobData>, scanConfig: Awaited<ReturnType<typeof loadScanConfig>>): Promise<void> {
  const {
    installationId,
    owner,
    repo,
    cloneUrl,
    headSha,
    baseSha,
    baseRef,
    prNumber,
    checkRunId,
  } = job.data;

  let workspacePath: string | null = null;
  let conclusion: 'success' | 'failure' | 'neutral' = 'failure'; // updated to actual value after buildAnnotations
  const stopTimer   = scanDuration.startTimer();

  try {
    debug('worker', `starting scan: ${owner}/${repo} PR #${prNumber} head=${headSha} base=${baseRef}`);

    await startCheckRun({ installationId, owner, repo, checkRunId });
    debug('worker', 'check run marked in_progress');

    const token = await getInstallationToken(installationId);
    debug('worker', 'installation token acquired');

    const mergeBaseSha = await getMergeBaseSha({ installationId, owner, repo, base: baseSha, head: headSha });
    debug('worker', `merge base resolved: ${mergeBaseSha}`);

    workspacePath = await createWorkspace(job.id ?? 'unknown');

    await setupRepo({ token, cloneUrl, headSha, baseSha: mergeBaseSha, workspacePath });
    const rawChanged   = await getChangedFiles({ workspacePath, baseSha: mergeBaseSha, headSha });
    const changedLineRanges = await getChangedLineRanges({ workspacePath, baseSha: mergeBaseSha, headSha });
    const changedFiles = await checkoutFiles({ workspacePath, headSha, files: rawChanged });

    const scanContext = await createScanContext({ workspacePath, changedFiles, baseSha: mergeBaseSha, headSha, scanConfig });
    debug('worker', `dispatching ${scanContext.scanFiles.length} file(s) to scanners (mode: ${scanContext.mode})`);

    const rawFindings = await dispatch({ scanContext, changedLineRanges, owner, repo });
    const diffFilteredFindings = filterFindingsToChangedLines(rawFindings, scanContext);
    const validatedFindings = await validateFindingLocations(
      diffFilteredFindings as ProcessedFinding[],
      { workspacePath: scanContext.repoWorkspacePath, changedFiles },
    );
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

    let exceptionApproval: ExceptionApprovalInfo | null = null;
    const { exceptionApprovers } = scanConfig;

    if (exceptionApprovers?.users?.length || exceptionApprovers?.teams?.length) {
      const blockingIds = actionableFindings
        .filter(f => f.severity === 'critical' || f.severity === 'high')
        .map(f => f._findingId!);

      const loadedExceptions = blockingIds.length > 0
        ? await loadExceptions({ owner, repo, prNumber, findingIds: blockingIds })
            .catch(err => { console.error(`[worker] Failed to load exceptions: ${(err as Error).message}`); return new Map<string, import('./types.js').ExceptionData>(); })
        : new Map<string, import('./types.js').ExceptionData>();

      const freshExceptions = await filterStaleExceptions({
        exceptions:     loadedExceptions,
        findings:       actionableFindings,
        workspacePath:  scanContext.repoWorkspacePath,
        currentHeadSha: headSha,
      }).catch(err => {
        console.error(`[worker] Failed to filter stale exceptions: ${(err as Error).message} — using loaded exceptions as-is`);
        return loadedExceptions;
      });

      const unmatchedBlockingFindings = actionableFindings.filter(f =>
        (f.severity === 'critical' || f.severity === 'high') && !freshExceptions.has(f._findingId!)
      );

      const driftedExceptions = await resolveDriftedExceptions({
        unmatchedFindings:  unmatchedBlockingFindings,
        owner, repo, prNumber,
        workspacePath:      scanContext.repoWorkspacePath,
        currentHeadSha:     headSha,
      }).catch(err => {
        console.error(`[worker] Failed to resolve drifted exceptions: ${(err as Error).message}`);
        return new Map<string, import('./types.js').ExceptionData>();
      });

      const exceptions = driftedExceptions.size > 0
        ? new Map([...freshExceptions, ...driftedExceptions])
        : freshExceptions;

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
        .catch(err => console.error('[worker] PR comment error:', (err as Error).message));
    }

    scanTotal.inc({ conclusion, owner, repo });
    (findingsPerScan as { observe(labels: Record<string, string>, value: number): void }).observe({ conclusion }, actionableFindings.length);

    // Label management — errors never affect the scan result.
    const { labels: labelConfig } = scanConfig;
    let toAdd: string[], toRemove: string[];

    if (exceptionApproval?.approved) {
      toAdd = (labelConfig as Record<string, string[]>)['onException'] ?? [];
      toRemove = (labelConfig as Record<string, string[]>)['removeOnException'] ?? [];
    } else if (conclusion === 'failure') {
      toAdd = labelConfig.onFailure ?? [];
      toRemove = (labelConfig as Record<string, string[]>)['removeOnFailure'] ?? [];
    } else {
      toAdd = labelConfig.onSuccess ?? [];
      toRemove = (labelConfig as Record<string, string[]>)['removeOnSuccess'] ?? [];
    }

    if (toAdd.length || toRemove.length) {
      await ensureLabelsExist({ installationId, owner, repo, labelNames: toAdd })
        .catch(err => console.error('[worker] ensureLabelsExist error:', (err as Error).message));
      await setLabels({ installationId, owner, repo, prNumber, add: toAdd, remove: toRemove })
        .catch(err => console.error('[worker] setLabels error:', (err as Error).message));
    }

    const prevCount = await getNotifyCount(owner, repo, prNumber);
    await setNotifyCount(owner, repo, prNumber, actionableFindings.length);

    // Notify on exception approval (only when this scan was triggered by the approval comment),
    // or when the finding count has increased since the last scan.
    const isExceptionApprovalScan = job.data.triggeredByException === true;
    if ((isExceptionApprovalScan && exceptionApproval?.approved) || actionableFindings.length > prevCount) {
      await notify({ findings: actionableFindings, owner, repo, prNumber, notificationConfig: scanConfig.notifications, exceptionApproval })
        .catch(err => console.error('[worker] notification dispatch error:', (err as Error).message));
    }
  } finally {
    if (workspacePath) {
      await cleanupWorkspace(workspacePath);
    }
    stopTimer({ conclusion });
  }
}

function logFindingPlacement(findings: ProcessedFinding[], { owner, repo, prNumber }: { owner: string; repo: string; prNumber: number }): void {
  if (findings.length === 0) return;

  const counts = new Map<string, number>();
  let claudeTotal = 0;
  let claudeInlineable = 0;

  for (const finding of findings) {
    const outcome = finding.annotationEligible === false ? 'not_inlineable' : 'inlineable';
    const reason = finding.annotationEligible === false
      ? (finding.annotationReason ?? finding.locationReason ?? 'unknown')
      : (finding.locationReason ?? 'validated');

    findingPlacementTotal.inc({ tool: finding.tool, outcome, reason });
    const key = `${finding.tool}|${outcome}|${reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);

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

function isFinalAttempt(job: Job): boolean {
  const totalAttempts = job.opts?.attempts ?? 1;
  const currentAttempt = (job.attemptsMade ?? 0) + 1;
  return currentAttempt >= totalAttempts;
}

const worker = new Worker('scans', processJob, {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection:  redis as any,
  concurrency: 5,
});

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} permanently failed:`, (err as Error).message);
});

// --- metrics HTTP server (only when METRICS_ENABLED=true) ---

let metricsServer: ReturnType<typeof createServer> | null = null;
let queuePoller: ReturnType<typeof setInterval> | null   = null;

if (METRICS_ENABLED) {
  metricsServer = createServer(async (_req, res) => {
    res.setHeader('Content-Type', registry!.contentType);
    res.end(await registry!.metrics());
  });
  metricsServer.listen(METRICS_PORT, () => {
    console.log(`[worker] Metrics server listening on port ${METRICS_PORT}`);
  });

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

export async function shutdown(): Promise<void> {
  console.log('[worker] Shutting down gracefully...');
  if (queuePoller) clearInterval(queuePoller);
  await worker.close();
  if (metricsServer) await new Promise<void>(resolve => metricsServer!.close(() => resolve()));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  validateEnv();
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT',  () => { void shutdown(); });
  console.log('[worker] Layne worker started — concurrency: 5');
}
