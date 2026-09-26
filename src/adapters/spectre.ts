import { readFile } from 'fs/promises';
import { join } from 'path';
import { DEFAULT_CONFIG } from '../config.js';
import { debug } from '../debug.js';
import {
  buildSpectreSystemPrompt,
  buildSpectreUserMessage,
  runSpectreCore,
  type SpectreSourceInput,
} from '../spectre-core.js';
import {
  getSpectreGovernor,
  spectreGovernorOptionsFromEnv,
  type SpectreGovernor,
} from '../spectre-governor.js';
import { createRedisSpectreGovernorRegistry } from '../spectre-redis-governor.js';
import { createProductionSpectreCache, type SpectreResponseCache } from '../spectre-cache.js';
import {
  spectreCircuitState,
  spectreGovernorDecisionsTotal,
  spectreGovernorInFlightRequests,
} from '../metrics.js';
import { isSpectreProvider, validateSpectreProviderConfig } from '../spectre-provider.js';
import { redis } from '../queue.js';
import { getSpectreModel } from '../spectre-models.js';
import {
  SPECTRE_HIGH_RISK_SCORE,
  shouldSkipSpectreFile,
} from '../spectre-signals.js';
import { routeSpectreSignals, type SpectreStructuralAnalyzer } from '../spectre-routing.js';
import type { SpectreTransport } from '../spectre-transport.js';
import { createPiAiSpectreTransport } from '../spectre-transports/pi-ai.js';
import type {
  LineRange,
  LineRangesByFile,
  PullRequestMetadata,
  SpectreConfig,
  SpectreCacheContext,
  SpectreRawFinding,
  SpectreScanResult,
  SpectreScanStatus,
  UnifiedDiff,
} from '../types.js';

const MAX_HIGH_RISK_CAPPED_DETAILS = 10;

export { buildSpectreSystemPrompt, buildSpectreUserMessage };
export { shouldSkipSpectreFile } from '../spectre-signals.js';

const getRedisGovernor = createRedisSpectreGovernorRegistry({
  ...spectreGovernorOptionsFromEnv(),
  client: redis,
});

function circuitStateValue(state: ReturnType<SpectreGovernor['getState']>['state']): number {
  return state === 'closed' ? 0 : state === 'open' ? 1 : 2;
}

type GovernorBackend = 'in_process' | 'redis';

function governorBackend(): GovernorBackend {
  const backend = process.env.SPECTRE_GOVERNOR_BACKEND ?? 'in_process';
  if (backend !== 'in_process' && backend !== 'redis') {
    throw new Error(`Invalid SPECTRE_GOVERNOR_BACKEND: ${backend}`);
  }
  return backend;
}

function governorRefusalReason(error: unknown): 'rate_limited' | 'concurrency_timeout' | 'circuit_open' | 'cancelled' | 'unknown' {
  const reason = typeof error === 'object' && error !== null ? (error as { reason?: unknown }).reason : undefined;
  return reason === 'rate_limited' || reason === 'concurrency_timeout' || reason === 'circuit_open' || reason === 'cancelled'
    ? reason
    : 'unknown';
}

function instrumentGovernor(governor: SpectreGovernor, provider: string, backend: GovernorBackend): SpectreGovernor {
  const updateState = (): void => {
    const current = governor.getState();
    const labels = { provider, backend };
    (spectreCircuitState as { set(labels: Record<string, string>, value: number): void })
      .set(labels, circuitStateValue(current.state));
    (spectreGovernorInFlightRequests as { set(labels: Record<string, string>, value: number): void })
      .set(labels, current.inFlight);
  };

  return {
    async acquire(signal?: AbortSignal) {
      try {
        const lease = await governor.acquire(signal);
        spectreGovernorDecisionsTotal.inc({ provider, backend, outcome: 'acquired', reason: 'none' });
        updateState();
        return {
          async succeed() {
            try {
              await lease.succeed();
            } finally {
              updateState();
            }
          },
          async fail() {
            try {
              await lease.fail();
            } finally {
              updateState();
            }
          },
          async release() {
            try {
              await lease.release();
            } finally {
              updateState();
            }
          },
        };
      } catch (error) {
        spectreGovernorDecisionsTotal.inc({
          provider,
          backend,
          outcome: 'denied',
          reason: governorRefusalReason(error),
        });
        updateState();
        throw error;
      }
    },
    getState: () => governor.getState(),
  };
}

function configuredGovernor(provider: string, backend: GovernorBackend): SpectreGovernor {
  return backend === 'redis'
    ? getRedisGovernor(provider)
    : getSpectreGovernor(provider);
}

function rangesForFile(ranges: LineRangesByFile | Record<string, LineRange[]>, file: string): LineRange[] {
  return ranges instanceof Map ? (ranges.get(file) ?? []) : (ranges[file] ?? []);
}

async function readSelectionContent(
  file: string,
  workspacePath: string,
  contentByFile: Map<string, string | null>,
): Promise<string | null> {
  if (contentByFile.has(file)) return contentByFile.get(file) ?? null;
  try {
    const content = await readFile(join(workspacePath, file), 'utf8');
    contentByFile.set(file, content);
    return content;
  } catch {
    contentByFile.set(file, null);
    return null;
  }
}

function filesFromDiff(diff: UnifiedDiff | null | undefined): string[] {
  if (!diff) return [];
  return diff.files
    .filter(file => file.change.newKind === 'regular')
    .flatMap(file => file.change.newPath ?? [])
    .filter((file, index, all) => all.indexOf(file) === index);
}

function addedLinesForFile(diff: UnifiedDiff | null | undefined, file: string): Array<{ line: number; content: string }> | undefined {
  if (!diff) return undefined;
  const entry = diff.files.find(item => item.change.newPath === file && item.change.newKind === 'regular');
  return entry?.hunks.flatMap(hunk => hunk.lines.flatMap(line =>
    line.type === 'addition' ? [{ line: line.newLine, content: line.content }] : []
  ));
}

function newModeForFile(diff: UnifiedDiff | null | undefined, file: string): string | undefined {
  return diff?.files.find(item => item.change.newPath === file)?.change.newMode;
}

function emptyResult(outcome: SpectreScanStatus['outcome'], reason?: string, skipped = 0): SpectreScanResult {
  return {
    findings: [],
    status: {
      outcome,
      selected: 0,
      scanned: 0,
      skipped,
      oversized: 0,
      capped: 0,
      truncated: 0,
      failed: 0,
      invalidResponses: 0,
      cancelled: 0,
      rateLimited: 0,
      concurrencyLimited: 0,
      circuitOpen: 0,
      rejectedFindings: 0,
      plannedChunks: 0,
      attemptedChunks: 0,
      completedChunks: 0,
      cappedChunks: 0,
      truncatedHunks: 0,
      reason,
    },
  };
}

export interface RunSpectreInput {
  workspacePath: string;
  changedFiles?: string[] | null;
  changedLineRanges?: LineRangesByFile | Record<string, LineRange[]>;
  promptFiles?: Array<{ file: string; content: string }>;
  unifiedDiff?: UnifiedDiff | null;
  pullRequestMetadata?: PullRequestMetadata | null;
  toolConfig?: SpectreConfig;
  signal?: AbortSignal;
  governor?: SpectreGovernor;
  transport?: SpectreTransport;
  cacheContext?: SpectreCacheContext;
  cache?: SpectreResponseCache;
  owner?: string;
  repo?: string;
  structuralAnalyzer?: SpectreStructuralAnalyzer;
}

export async function runSpectreWithStatus({
  workspacePath,
  changedFiles,
  changedLineRanges = new Map(),
  promptFiles = [],
  unifiedDiff,
  pullRequestMetadata,
  toolConfig = DEFAULT_CONFIG.spectre,
  signal,
  governor,
  transport,
  cacheContext,
  cache,
  owner,
  repo,
  structuralAnalyzer,
}: RunSpectreInput): Promise<SpectreScanResult> {
  const inputFiles = changedFiles ?? filesFromDiff(unifiedDiff);
  if (inputFiles.length === 0) return emptyResult('complete');
  if (!toolConfig.enabled) {
    console.log('[spectre] skipping - not enabled for this repo (set "spectre": {"enabled": true, "provider": "..."} in layne.json)');
    return emptyResult('disabled', 'not-enabled');
  }

  const eligible = inputFiles.filter(file => !shouldSkipSpectreFile(file, toolConfig, newModeForFile(unifiedDiff, file)));
  const skippedCount = inputFiles.length - eligible.length;
  if (eligible.length === 0) {
    const complete = emptyResult('complete');
    complete.status.skipped = skippedCount;
    return complete;
  }

  const providerConfigError = validateSpectreProviderConfig(toolConfig);
  if (providerConfigError) {
    console.error(`[spectre] invalid provider configuration: ${providerConfigError}`);
    return emptyResult('incomplete', 'provider-configuration-invalid', skippedCount);
  }

  const provider = toolConfig.provider!;
  const activeBackend = governor ? 'in_process' : governorBackend();
  // Resolve the production model before reading source so invalid deployment
  // configuration retains the existing fail-fast behavior.
  let model: ReturnType<typeof getSpectreModel>;
  try {
    model = getSpectreModel(provider, toolConfig.model);
    if (!model) throw new Error(`unknown provider/model: ${provider}/${toolConfig.model}`);
  } catch (error) {
    console.error(`[spectre] failed to initialise model: ${(error as Error).message}`);
    return emptyResult('incomplete', 'model-initialisation-failed', skippedCount);
  }

  const fileCap = Math.min(toolConfig.fileCap ?? 20, 30);
  const contentByFile = new Map<string, string | null>(promptFiles.map(prompt => [prompt.file, prompt.content]));
  const signalInputs = [];
  for (const file of eligible) {
    if (signal?.aborted) break;
    signalInputs.push({
      file,
      content: await readSelectionContent(file, workspacePath, contentByFile),
      addedLines: addedLinesForFile(unifiedDiff, file),
    });
  }
  if (signal?.aborted) {
    const cancelled = emptyResult('incomplete', 'cancelled');
    cancelled.status.selected = eligible.length;
    cancelled.status.skipped = skippedCount;
    cancelled.status.cancelled = eligible.length;
    return cancelled;
  }

  const routing = await routeSpectreSignals({ files: signalInputs, config: toolConfig, signal, analyzer: structuralAnalyzer });
  const routingContext = routing.context;
  const selection = routing.selection;
  const { primary, secondary, selected } = selection;
  const cappedCount = selection.capped;
  const highRiskCappedCount = selection.highRiskCapped.length;
  const promoted = routingContext.files.filter(file => selected.includes(file.file) && file.signals.length > 0);

  console.log(
    `[spectre] scanning ${primary.length} file(s)`
      + (secondary.length > 0 ? ` + ${secondary.length} risk-triggered` : '')
      + ` with ${provider}/${toolConfig.model}`
      + (skippedCount > 0 ? `, ${skippedCount} skipped by filter` : '')
      + (promoted.length > 0 ? `, ${promoted.length} signal-promoted` : '')
      + (cappedCount > 0 ? `, ${cappedCount} dropped by cap of ${fileCap}` : ''),
  );
  if (promoted.length > 0) {
    debug('spectre', `risk signals: ${promoted.map(file => `${file.file}=${file.score}[${file.signals.join(',')}]`).join('; ')}`);
  }
  if (secondary.length > 0) debug('spectre', `secondary (risk or relation overflow): ${secondary.join(', ')}`);
  if (routing.diagnostics.mode === 'shadow') {
    const diagnostics = routing.diagnostics;
    debug(
      'spectre',
      `structural shadow: outcome=${diagnostics.outcome}, files=${diagnostics.files}, facts=${diagnostics.facts}, selected-added=${diagnostics.selectionDelta.selectedAddedCount}, selected-removed=${diagnostics.selectionDelta.selectedRemovedCount}`,
    );
  } else if (routing.diagnostics.mode === 'enabled' && routing.diagnostics.outcome !== 'complete') {
    console.warn(`[spectre] structural routing ${routing.diagnostics.outcome}; lexical fallback remains active for unavailable facts`);
  }

  const sources: SpectreSourceInput[] = [];
  for (const file of selected) {
    if (signal?.aborted) break;
    const ranges = rangesForFile(changedLineRanges, file);
    sources.push({
      file,
      content: await readSelectionContent(file, workspacePath, contentByFile),
      ...(ranges.length > 0 ? { changedLineRanges: ranges } : {}),
    });
  }

  const maxOutputTokens = Math.min(toolConfig.maxOutputTokens ?? 1_200, 2_000);
  const activeTransport = transport ?? createPiAiSpectreTransport({ model, maxOutputTokens });
  const metricProvider = isSpectreProvider(provider) ? provider : 'unknown';
  const activeGovernor = instrumentGovernor(governor ?? configuredGovernor(provider, activeBackend), metricProvider, activeBackend);
  const activeCache = cache ?? (!transport ? createProductionSpectreCache({
    context: cacheContext,
    provider,
    model: model.id,
    modelApi: model.api,
    maxOutputTokens,
    config: toolConfig,
  }) : undefined);
  const result = await runSpectreCore({
    selectedFiles: selected,
    sources,
    unifiedDiff,
    pullRequestMetadata,
    routingContext,
    transport: activeTransport,
    governor: activeGovernor,
    config: toolConfig,
    signal,
    cache: activeCache,
    cacheContext,
    owner,
    repo,
  });
  result.status.skipped = skippedCount;
  result.status.capped = cappedCount;
  if (highRiskCappedCount > 0) {
    result.status.highRiskCapped = highRiskCappedCount;
    result.status.highRiskCappedFiles = selection.highRiskCapped
      .slice(0, MAX_HIGH_RISK_CAPPED_DETAILS)
      .map(({ file, score, signals }) => ({ file, score, signals }));
    result.status.outcome = 'incomplete';
    result.status.reason = 'high-risk-file-cap-exceeded';
    console.error(
      `[spectre] ${highRiskCappedCount} unscanned file(s) scored at or above ${SPECTRE_HIGH_RISK_SCORE}`,
    );
  } else if (cappedCount > 0) {
    result.status.outcome = 'incomplete';
    result.status.reason ??= 'file-cap-exceeded';
  }

  console.log(`[spectre] ${result.findings.length} finding(s):`);
  for (const finding of result.findings) {
    console.log(`[spectre]   ${finding.severity.toUpperCase()} ${finding.file}:${finding.startLine}-${finding.endLine} [${finding.ruleId}] ${finding.message}`);
  }
  return result;
}

/** Backwards-compatible findings-only adapter entry point. */
export async function runSpectre(args: RunSpectreInput): Promise<SpectreRawFinding[]> {
  return (await runSpectreWithStatus(args)).findings;
}
