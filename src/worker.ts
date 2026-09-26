import 'dotenv/config';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { redis, scanQueue } from './queue.js';
import { getInstallationToken } from './auth.js';
import { startCheckRun, completeCheckRun, ensureLabelsExist, setLabels, getMergeBaseSha } from './github.js';
import { createWorkspace, setupRepo, getGitChanges, getUnifiedDiff, checkoutGitChanges, cleanupWorkspace } from './fetcher.js';
import { deriveChangedHeadRanges } from './unified-diff.js';
import { createScanContext, filterFindingsToChangedLines } from './scan-context.js';
import { dispatch } from './dispatcher.js';
import { suppressFindings } from './suppressor.js';
import { applyAdapterValidationCoverage, validateFindingLocations } from './location-validator.js';
import { buildAnnotations } from './reporter.js';
import { loadScanConfig, validateConfigFile } from './config.js';
import { notify } from './notifiers/index.js';
import { buildFinalSecurityState, buildInternalErrorState, coverageIssue } from './notification-state.js';
import { postComment } from './commenter.js';
import { validateEnv } from './env.js';
import { closeSpectreCacheClient } from './spectre-cache.js';
import { debug } from './debug.js';
import {
  generateFindingId,
  loadExceptions,
  filterStaleExceptions,
  materializeBulkExceptionRequest,
  resolveDriftedExceptions,
  buildExceptionSummary,
} from './exception-approvals.js';
import type { AdapterStatuses, ExceptionData, ProcessedFinding, JobData, Tool } from './types.js';
import type { ExceptionApprovalInfo, NotificationCoverageIssue } from './notifiers/types.js';
import { isSpectreProvider } from './spectre-provider.js';
import { SPECTRE_HIGH_RISK_SCORE } from './spectre-signals.js';
import {
  registry,
  scanTotal,
  scanDuration,
  scanTimeoutsTotal,
  scanRetriesTotal,
  findingTotal,
  findingPlacementTotal,
  findingsPerScan,
  spectreScansTotal,
  queueWaiting,
  queueActive,
  queueFailed,
} from './metrics.js';

const METRICS_ENABLED  = process.env.METRICS_ENABLED === 'true';
const METRICS_PORT     = parseInt(process.env.METRICS_PORT ?? '9091', 10);
const ERROR_PUBLICATION_TIMEOUT_MS = 10_000;

const SPECTRE_SCAN_REASONS = new Set([
  'none',
  'not-enabled',
  'provider-configuration-invalid',
  'model-initialisation-failed',
  'cancelled',
  'file-cap-exceeded',
  'provider-circuit-open',
  'provider-concurrency-limited',
  'provider-rate-limited',
  'provider-or-file-failure',
  'invalid-provider-response',
  'call-cap-exceeded',
  'input-truncated',
  'file-size-limit-exceeded',
  'high-risk-file-cap-exceeded',
  'finding-validation-rejected',
  'related-context-limit-exceeded',
]);

function spectreProviderMetricLabel(provider: string | undefined): string {
  return provider && isSpectreProvider(provider) ? provider : 'unknown';
}

function spectreReasonMetricLabel(reason: string | undefined): string {
  if (!reason) return 'none';
  return SPECTRE_SCAN_REASONS.has(reason) ? reason : 'unknown';
}

function incompleteAdapterSummary(statuses: AdapterStatuses): string | null {
  const incomplete = (Object.entries(statuses) as Array<[Tool, AdapterStatuses[Tool]]>)
    .filter(([tool, status]) => tool !== 'spectre' && status.outcome === 'incomplete')
    .map(([tool, status]) => `${tool}${status.reason ? ` (${status.reason})` : ''}`);
  return incomplete.length > 0 ? `Adapter coverage incomplete: ${incomplete.join(', ')}.` : null;
}

function highRiskSpectreCoverageSummary(status: AdapterStatuses['spectre']): string | null {
  const count = status.highRiskCapped ?? 0;
  if (count === 0) return null;

  const details = (status.highRiskCappedFiles ?? []).map(file => {
    const boundedPath = file.file.length > 200 ? `${file.file.slice(0, 197)}...` : file.file;
    const safePath = boundedPath
      .replace(/[\r\n]/g, ' ')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `- <code>${safePath}</code> - score ${file.score} - ${file.signals.length > 0 ? file.signals.join(', ') : 'path role'}`;
  });
  const omitted = count - details.length;
  if (omitted > 0) details.push(`- ${omitted} additional high-risk file(s) omitted from this summary`);

  return [
    '### Spectre coverage failure',
    '',
    `${count} high-risk file(s) could not be scanned because Spectre's selected-file capacity was reached.`,
    `High-risk threshold: score >= ${SPECTRE_HIGH_RISK_SCORE}.`,
    ...(details.length > 0 ? ['', 'Highest-risk unscanned files:', ...details] : []),
  ].join('\n');
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
  if ((finding.tool === 'claude' || finding.tool === 'spectre') && finding.locationValidated !== true) return false;
  return true;
}

function appendDiscardedCandidateSummary(summary: string, discardedCount: number): string {
  if (discardedCount === 0) return summary;
  return `${summary} Omitted ${discardedCount} finding candidate(s) that could not be resolved to a precise code location.`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Layne scan cancelled');
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
  const abortController = new AbortController();
  const timeoutBeforePublication = Symbol('timeout-before-publication');
  const timeoutAfterPublication = Symbol('timeout-after-publication');
  let terminalPublicationClaimed = false;
  let terminalPublished = false;
  let timedOut = false;
  const claimPublication = () => {
    if (terminalPublicationClaimed) return false;
    terminalPublicationClaimed = true;
    return true;
  };
  const markPublicationSucceeded = () => {
    terminalPublished = true;
  };
  const timeoutPromise = new Promise<typeof timeoutBeforePublication | typeof timeoutAfterPublication>(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      abortController.abort(new Error('Layne scan deadline exceeded'));
      resolve(terminalPublished ? timeoutAfterPublication : timeoutBeforePublication);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      runScan(job, scanConfig, abortController.signal, claimPublication, markPublicationSucceeded).then(() => null as null),
      timeoutPromise,
    ]);

    // A completed terminal Check Run is authoritative. The deadline still
    // aborts any remaining best-effort side effects, but must not retry it.
    if (result === timeoutAfterPublication) return;
    if (result === timeoutBeforePublication) throw new Error(`Scan timed out after ${timeoutMs / 60000} minutes`);
  } catch (err) {
    const failure = timedOut
      ? new Error(`Scan timed out after ${timeoutMs / 60000} minutes`)
      : err as Error;
    if (timedOut) scanTimeoutsTotal.inc();
    const safeMessage = sanitizeError(failure.message);
    const finalAttempt = isFinalAttempt(job);
    const attempt = (job.attemptsMade ?? 0) + 1;
    const totalAttempts = job.opts?.attempts ?? 1;
    const retryMessage = finalAttempt ? '' : ` Retrying (${attempt}/${totalAttempts})...`;

    console.error(
      `[worker] Scan failed for ${job.data.owner}/${job.data.repo} PR #${job.data.prNumber}:`,
      `${safeMessage}${retryMessage}`
    );

    if (finalAttempt) {
      const { installationId, owner, repo, checkRunId, prNumber, headSha } = job.data;
      scanTotal.inc({ conclusion: 'failure', owner, repo });
      if (claimPublication()) {
        await publishFailureWithTimeout({
          installationId,
          owner,
          repo,
          checkRunId,
          conclusion:  'failure',
          annotations: [],
          summary:     `Layne encountered an internal error: ${safeMessage}`,
        }).catch(publicationError => {
          console.error(`[worker] Failed to publish terminal scan error: ${(publicationError as Error).message}`);
        });
      }
      if (!terminalPublished) {
        await notifyInternalFailureWithTimeout({
          state: buildInternalErrorState(safeMessage),
          owner,
          repo,
          prNumber,
          headSha,
          scanSequence: job.timestamp ?? Date.now(),
          notificationConfig: scanConfig.notifications,
        });
      }
    } else {
      scanRetriesTotal.inc();
    }

    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

async function runScan(
  job: Job<JobData>,
  scanConfig: Awaited<ReturnType<typeof loadScanConfig>>,
  signal: AbortSignal,
  claimPublication: () => boolean,
  markPublicationSucceeded: () => void,
): Promise<void> {
  const {
    installationId,
    repositoryId,
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
    throwIfAborted(signal);
    debug('worker', `starting scan: ${owner}/${repo} PR #${prNumber} head=${headSha} base=${baseRef}`);

    await startCheckRun({ installationId, owner, repo, checkRunId, signal });
    throwIfAborted(signal);
    debug('worker', 'check run marked in_progress');

    const token = await getInstallationToken(installationId, signal);
    throwIfAborted(signal);
    debug('worker', 'installation token acquired');

    const mergeBaseSha = await getMergeBaseSha({ installationId, owner, repo, base: baseSha, head: headSha, signal });
    throwIfAborted(signal);
    debug('worker', `merge base resolved: ${mergeBaseSha}`);

    workspacePath = await createWorkspace(job.id ?? 'unknown');
    throwIfAborted(signal);

    await setupRepo({ token, cloneUrl, headSha, baseSha: mergeBaseSha, workspacePath, signal });
    throwIfAborted(signal);
    const gitChanges = await getGitChanges({ workspacePath, baseSha: mergeBaseSha, headSha, signal });
    throwIfAborted(signal);
    const diffFiles = gitChanges
      .map(change => change.newPath ?? change.oldPath)
      .filter((path): path is string => path !== null);
    const unifiedDiff = await getUnifiedDiff({
      workspacePath,
      baseSha: mergeBaseSha,
      headSha,
      contextLines: scanConfig.contextLines,
      files: diffFiles,
      changes: gitChanges,
      signal,
    });
    const changedLineRanges = deriveChangedHeadRanges(unifiedDiff);
    throwIfAborted(signal);
    const preparedChanges = await checkoutGitChanges({ workspacePath, headSha, changes: gitChanges, signal });
    const changedFiles = preparedChanges.files;
    throwIfAborted(signal);

    const scanContext = await createScanContext({ workspacePath, changedFiles, baseSha: mergeBaseSha, headSha, scanConfig, changedLineRanges, unifiedDiff, signal });
    throwIfAborted(signal);
    debug('worker', `dispatching ${scanContext.scanFiles.length} file(s) to scanners (mode: ${scanContext.mode})`);

    const dispatchResult = await dispatch({
      scanContext,
      changedLineRanges,
      owner,
      repo,
      pullRequestMetadata: job.data.pullRequestMetadata,
      spectreCacheContext: Number.isSafeInteger(repositoryId) && repositoryId! > 0 ? {
        installationId,
        repositoryId: repositoryId!,
        prNumber,
        baseSha: mergeBaseSha,
      } : undefined,
      signal,
    });
    throwIfAborted(signal);
    const validatedFindings = await validateFindingLocations(
      dispatchResult.findings as ProcessedFinding[],
      { workspacePath: scanContext.repoWorkspacePath, changedFiles, changedLineRanges, signal },
    );
    applyAdapterValidationCoverage(dispatchResult.statuses, validatedFindings);
    throwIfAborted(signal);
    const diffFilteredFindings = filterFindingsToChangedLines(validatedFindings, scanContext);
    logFindingPlacement(diffFilteredFindings, { owner, repo, prNumber });
    const findings = await suppressFindings(diffFilteredFindings, { workspacePath: scanContext.repoWorkspacePath, baseSha: mergeBaseSha, headSha, signal });
    throwIfAborted(signal);
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
    const coverageIssues: NotificationCoverageIssue[] = [];

    const deletedChanges = preparedChanges.issues.filter(issue => issue.disposition === 'not_applicable').length;
    const unsupportedChanges = preparedChanges.issues.filter(issue => issue.disposition === 'unsupported').length;
    const unavailableChanges = preparedChanges.issues.filter(issue => issue.disposition === 'unavailable').length;
    const gitCoverageIncomplete = unsupportedChanges > 0 || unavailableChanges > 0;
    if (preparedChanges.issues.length > 0) {
      summary = `${summary} Git change coverage: ${gitChanges.length} change(s), ${changedFiles.length} regular HEAD file(s) prepared, ${deletedChanges} deletion(s) not applicable, ${unsupportedChanges} unsupported, ${unavailableChanges} unavailable.`;
    }
    for (const issue of preparedChanges.issues.filter(issue => issue.disposition !== 'not_applicable')) {
      coverageIssues.push(coverageIssue(
        'incomplete',
        'git',
        issue.reason,
        1,
        [issue.change.newPath ?? issue.change.oldPath ?? 'unknown'],
      ));
    }
    if (gitCoverageIncomplete && conclusion === 'success') conclusion = 'neutral';

    if ((scanContext.metadataOnlyChanges ?? 0) > 0 || (scanContext.unprojectableChanges ?? 0) > 0) {
      summary = `${summary} Diff projection: ${scanContext.metadataOnlyChanges ?? 0} metadata-only change(s), ${scanContext.unprojectableChanges ?? 0} unprojectable textual change(s).`;
    }
    if ((scanContext.unprojectableChanges ?? 0) > 0) {
      coverageIssues.push(coverageIssue('incomplete', 'diff', 'unprojectable-change', scanContext.unprojectableChanges));
    }
    if ((scanContext.unprojectableChanges ?? 0) > 0 && conclusion === 'success') conclusion = 'neutral';

    const spectreStatus = dispatchResult.statuses.spectre;
    const blockingSpectreCoverage = highRiskSpectreCoverageSummary(spectreStatus);
    if (spectreStatus) {
      spectreScansTotal.inc({
        provider: spectreProviderMetricLabel(scanConfig.spectre?.provider),
        outcome: spectreStatus.outcome,
        reason: spectreReasonMetricLabel(spectreStatus.reason),
      });
    }
    if (spectreStatus && spectreStatus.outcome === 'incomplete') {
      const coverage = `Spectre coverage incomplete: selected ${spectreStatus.selected}, scanned ${spectreStatus.scanned}, skipped ${spectreStatus.skipped}, oversized ${spectreStatus.oversized}, capped ${spectreStatus.capped}, truncated ${spectreStatus.truncated}, failed ${spectreStatus.failed}, invalid ${spectreStatus.invalidResponses}, rejected ${spectreStatus.rejectedFindings ?? 0}, repairs ${spectreStatus.repairAttempts ?? 0}, repaired responses ${spectreStatus.repairedResponses ?? 0}, repaired findings ${spectreStatus.repairedFindings ?? 0}, cancelled ${spectreStatus.cancelled}, rate-limited ${spectreStatus.rateLimited}, concurrency-limited ${spectreStatus.concurrencyLimited}, circuit-open ${spectreStatus.circuitOpen}.${spectreStatus.reason ? ` Reason: ${spectreStatus.reason}.` : ''}`;
      summary = `${summary} ${coverage}`;
      // Do not claim a clean security result when an enabled scanner did not complete.
      if (conclusion === 'success') conclusion = 'neutral';
    }
    if (blockingSpectreCoverage) {
      summary = `${summary}\n\n${blockingSpectreCoverage}`;
      conclusion = 'failure';
      coverageIssues.push(coverageIssue(
        'blocking',
        'spectre',
        'high-risk-file-cap-exceeded',
        spectreStatus.highRiskCapped ?? 0,
        spectreStatus.highRiskCappedFiles?.map(file => file.file),
      ));
    }
    const adapterCoverage = incompleteAdapterSummary(dispatchResult.statuses);
    const adapterCoverageIncomplete = Object.values(dispatchResult.statuses)
      .some(status => status.outcome === 'incomplete');
    if (adapterCoverage) {
      summary = `${summary} ${adapterCoverage}`;
      if (conclusion === 'success') conclusion = 'neutral';
    }
    for (const [tool, status] of Object.entries(dispatchResult.statuses) as Array<[Tool, AdapterStatuses[Tool]]>) {
      if (status.outcome !== 'incomplete') continue;
      if (tool === 'spectre' && blockingSpectreCoverage) continue;
      coverageIssues.push(coverageIssue('incomplete', tool, status.reason ?? 'incomplete'));
    }

    let exceptionApproval: ExceptionApprovalInfo | null = null;
    const { exceptionApprovers } = scanConfig;
    const bulkRequest = job.data.exceptionApprovalRequest?.kind === 'all'
      ? job.data.exceptionApprovalRequest
      : null;

    if (bulkRequest && !exceptionApprovers?.users?.length && !exceptionApprovers?.teams?.length) {
      throw new Error('Bulk exception approval is no longer enabled for this repository');
    }

    if (exceptionApprovers?.users?.length || exceptionApprovers?.teams?.length) {
      const blockingIds = actionableFindings
        .filter(f => f.severity === 'critical' || f.severity === 'high')
        .map(f => f._findingId!);

      const loadedExceptions = blockingIds.length > 0
        ? await loadExceptions({ owner, repo, prNumber, findingIds: blockingIds, signal })
            .catch(err => {
              throwIfAborted(signal);
              if (bulkRequest) throw err;
              console.error(`[worker] Failed to load exceptions: ${(err as Error).message}`);
              return new Map<string, ExceptionData>();
            })
        : new Map<string, ExceptionData>();
      throwIfAborted(signal);

      const freshExceptions = await filterStaleExceptions({
        exceptions:     loadedExceptions,
        findings:       actionableFindings,
        workspacePath:  scanContext.repoWorkspacePath,
        currentHeadSha: headSha,
        signal,
      }).catch(err => {
        throwIfAborted(signal);
        if (bulkRequest) throw err;
        console.error(`[worker] Failed to filter stale exceptions: ${(err as Error).message} — invalidating unverified exceptions`);
        return new Map<string, ExceptionData>();
      });
      throwIfAborted(signal);

      const unmatchedBlockingFindings = actionableFindings.filter(f =>
        (f.severity === 'critical' || f.severity === 'high') && !freshExceptions.has(f._findingId!)
      );

      const driftedExceptions = await resolveDriftedExceptions({
        unmatchedFindings:  unmatchedBlockingFindings,
        owner, repo, prNumber,
        workspacePath:      scanContext.repoWorkspacePath,
        currentHeadSha:     headSha,
        signal,
      }).catch(err => {
        throwIfAborted(signal);
        if (bulkRequest) throw err;
        console.error(`[worker] Failed to resolve drifted exceptions: ${(err as Error).message}`);
        return new Map<string, ExceptionData>();
      });
      throwIfAborted(signal);

      let exceptions = driftedExceptions.size > 0
        ? new Map([...freshExceptions, ...driftedExceptions])
        : freshExceptions;

      if (bulkRequest) {
        const findingIds = blockingIds.filter(findingId => !exceptions.has(findingId));
        const materialized = await materializeBulkExceptionRequest({
          owner,
          repo,
          prNumber,
          approvedHeadSha: headSha,
          requestId: bulkRequest.requestId,
          findingIds,
          expectedExceptions: loadedExceptions,
        });
        throwIfAborted(signal);

        const materializedIds = new Set(materialized.findingIds);
        const currentMaterializedIds = blockingIds.filter(findingId => materializedIds.has(findingId));
        if (currentMaterializedIds.length > 0) {
          const storedMaterialized = await loadExceptions({
            owner, repo, prNumber, findingIds: currentMaterializedIds, signal,
          });
          const freshMaterialized = await filterStaleExceptions({
            exceptions: storedMaterialized,
            findings: actionableFindings,
            workspacePath: scanContext.repoWorkspacePath,
            currentHeadSha: headSha,
            signal,
          });
          exceptions = new Map([...exceptions, ...freshMaterialized]);
        }
      }

      const override = buildExceptionSummary({ findings: actionableFindings, exceptions, baseSummary: summary });
      conclusion = override.conclusion;
      summary    = override.summary;

      // Exceptions waive findings, not scanner coverage failures.
      if (adapterCoverageIncomplete && conclusion === 'success') conclusion = 'neutral';
      if (gitCoverageIncomplete && conclusion === 'success') conclusion = 'neutral';
      if ((scanContext.unprojectableChanges ?? 0) > 0 && conclusion === 'success') conclusion = 'neutral';
      if (blockingSpectreCoverage) conclusion = 'failure';

      if (exceptions.size > 0) {
        const approvers = [...new Set([...exceptions.values()].map(e => e.approver))].sort().join(', ');
        const reasons = [...new Set([...exceptions.values()].map(e => e.reason))].sort().join('; ');
        exceptionApproval = {
          approved: true,
          approver: approvers,
          reason: reasons,
          findingIds: [...exceptions.keys()].sort(),
        };
        console.log(`[worker] ${exceptions.size} effective exception(s) approved by @${approvers} for ${owner}/${repo} PR #${prNumber}`);
      }
    }

    if (!claimPublication()) throwIfAborted(signal);
    throwIfAborted(signal);
    await completeCheckRun({ installationId, owner, repo, checkRunId, conclusion, annotations: result.annotations, summary, signal });
    markPublicationSucceeded();

    console.log(`[worker] Completed scan for ${owner}/${repo} PR #${prNumber} — ${conclusion}`);

    const notificationState = buildFinalSecurityState({
      conclusion,
      findings: actionableFindings,
      coverageIssues,
      exceptionApproval,
    });
    throwIfAborted(signal);
    const notificationPromise = notify({
      state: notificationState,
      owner,
      repo,
      prNumber,
      headSha,
      scanSequence: job.timestamp ?? Date.now(),
      notificationConfig: scanConfig.notifications,
      signal,
    }).catch(err => {
      if (!signal.aborted) console.error('[worker] notification dispatch error:', (err as Error).message);
    });

    const { comment: commentConfig } = scanConfig;
    if (commentConfig.enabled) {
      throwIfAborted(signal);
      await postComment({ findings: actionableFindings, owner, repo, prNumber, installationId, headSha, conclusion, commentConfig, coverageFailure: blockingSpectreCoverage, signal })
        .catch(err => { throwIfAborted(signal); console.error('[worker] PR comment error:', (err as Error).message); });
      throwIfAborted(signal);
    }

    scanTotal.inc({ conclusion, owner, repo });
    (findingsPerScan as { observe(labels: Record<string, string>, value: number): void }).observe({ conclusion }, actionableFindings.length);

    // Label management — errors never affect the scan result.
    const { labels: labelConfig } = scanConfig;
    let toAdd: string[], toRemove: string[];

    if (conclusion === 'failure') {
      toAdd = labelConfig.onFailure ?? [];
      toRemove = (labelConfig as Record<string, string[]>)['removeOnFailure'] ?? [];
    } else if (conclusion === 'neutral') {
      toAdd = labelConfig.onIncomplete ?? [];
      toRemove = labelConfig.removeOnIncomplete ?? [];
    } else if (exceptionApproval?.approved) {
      toAdd = (labelConfig as Record<string, string[]>)['onException'] ?? [];
      toRemove = (labelConfig as Record<string, string[]>)['removeOnException'] ?? [];
    } else {
      toAdd = labelConfig.onSuccess ?? [];
      toRemove = (labelConfig as Record<string, string[]>)['removeOnSuccess'] ?? [];
    }

    if (toAdd.length || toRemove.length) {
      throwIfAborted(signal);
      await ensureLabelsExist({ installationId, owner, repo, labelNames: toAdd, signal })
        .catch(err => { throwIfAborted(signal); console.error('[worker] ensureLabelsExist error:', (err as Error).message); });
      throwIfAborted(signal);
      await setLabels({ installationId, owner, repo, prNumber, add: toAdd, remove: toRemove, signal })
        .catch(err => { throwIfAborted(signal); console.error('[worker] setLabels error:', (err as Error).message); });
      throwIfAborted(signal);
    }

    await notificationPromise;
    throwIfAborted(signal);

  } finally {
    if (workspacePath) {
      await cleanupWorkspace(workspacePath);
    }
    if (!signal.aborted) stopTimer({ conclusion });
  }
}

async function notifyInternalFailureWithTimeout(
  params: Omit<Parameters<typeof notify>[0], 'signal'>,
): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Internal-error notification timed out'));
      resolve();
    }, ERROR_PUBLICATION_TIMEOUT_MS);
  });
  const delivery = notify({ ...params, signal: controller.signal })
    .then(() => undefined)
    .catch(err => console.error(`[worker] Internal-error notification failed: ${(err as Error).message}`));
  try {
    await Promise.race([delivery, timeout]);
    if (timedOut) console.error('[worker] Internal-error notification timed out');
  } finally {
    clearTimeout(timer);
  }
}

async function publishFailureWithTimeout(params: Omit<Parameters<typeof completeCheckRun>[0], 'signal'>): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      controller.abort(new Error('Final Check Run publication timed out'));
      resolve();
    }, ERROR_PUBLICATION_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      completeCheckRun({ ...params, signal: controller.signal }).then(() => undefined, () => undefined),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
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

let worker: Worker<JobData> | null = null;
let metricsServer: ReturnType<typeof createServer> | null = null;
let queuePoller: ReturnType<typeof setInterval> | null   = null;

export function startWorker(): Worker<JobData> {
  if (worker) return worker;

  worker = new Worker('scans', processJob, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection:  redis as any,
    concurrency: 5,
  });
  worker.on('failed', (job, err) => {
    console.error(`[worker] Job ${job?.id} permanently failed:`, (err as Error).message);
  });

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

  return worker;
}

export async function shutdown(): Promise<void> {
  console.log('[worker] Shutting down gracefully...');
  if (queuePoller) clearInterval(queuePoller);
  if (worker) await worker.close();
  await closeSpectreCacheClient();
  if (metricsServer) await new Promise<void>(resolve => metricsServer!.close(() => resolve()));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  validateEnv();
  await validateConfigFile();
  startWorker();
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT',  () => { void shutdown(); });
  console.log('[worker] Layne worker started — concurrency: 5');
}
