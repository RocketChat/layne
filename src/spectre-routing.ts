import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import * as metrics from './metrics.js';
import {
  compileSpectreBoostPatterns,
  extractSpectreSignals,
  extractSpectreSignalsWithStructuralFacts,
  selectSpectreFiles,
  type SpectreRoutingContext,
  type SpectreSelection,
  type SpectreSignalInputFile,
} from './spectre-signals.js';
import {
  analyzeSpectreStructuralSignals,
  analyzeSpectreStructuralSignalsIsolated,
  DEFAULT_SPECTRE_STRUCTURAL_LIMITS,
  type SpectreStructuralInputFile,
  type SpectreStructuralOptions,
  type SpectreStructuralParserOutcome,
  type SpectreStructuralResult,
} from './spectre-structural-signals.js';
import type { SpectreAstSignalsConfig, SpectreConfig } from './types.js';

const MAX_DIAGNOSTIC_PATHS = 20;

export type SpectreStructuralAnalyzer = (
  files: readonly SpectreStructuralInputFile[],
  options: SpectreStructuralOptions & { timeoutMs?: number },
) => Promise<SpectreStructuralResult>;

export interface SpectreSelectionDelta {
  selectedAddedCount: number;
  selectedRemovedCount: number;
  primaryAddedCount: number;
  primaryRemovedCount: number;
  selectedAdded: string[];
  selectedRemoved: string[];
}

export interface SpectreStructuralRoutingDiagnostics {
  mode: SpectreAstSignalsConfig['mode'];
  outcome: 'off' | 'complete' | 'partial' | 'failed';
  files: number;
  outcomes: Partial<Record<SpectreStructuralParserOutcome, number>>;
  inputBytes: number;
  facts: number;
  durationMs: number;
  budgetExceeded: boolean;
  fallbackReason?: 'analyzer-failed';
  selectionDelta: SpectreSelectionDelta;
}

export interface SpectreRoutingResult {
  context: SpectreRoutingContext;
  selection: SpectreSelection;
  lexicalContext: SpectreRoutingContext;
  lexicalSelection: SpectreSelection;
  augmentedContext?: SpectreRoutingContext;
  augmentedSelection?: SpectreSelection;
  diagnostics: SpectreStructuralRoutingDiagnostics;
}

export interface RouteSpectreSignalsInput {
  files: readonly SpectreSignalInputFile[];
  config: SpectreConfig;
  signal?: AbortSignal;
  analyzer?: SpectreStructuralAnalyzer;
}

function astConfig(config: SpectreConfig): SpectreAstSignalsConfig {
  return config.astSignals ?? {
    mode: 'off',
    maxFiles: 200,
    maxTotalBytes: 2 * 1024 * 1024,
    timeoutSeconds: 3,
  };
}

function delta(lexical: SpectreSelection, augmented: SpectreSelection): SpectreSelectionDelta {
  const lexicalSelected = new Set(lexical.selected);
  const augmentedSelected = new Set(augmented.selected);
  const lexicalPrimary = new Set(lexical.primary);
  const augmentedPrimary = new Set(augmented.primary);
  const selectedAdded = augmented.selected.filter(file => !lexicalSelected.has(file));
  const selectedRemoved = lexical.selected.filter(file => !augmentedSelected.has(file));
  return {
    selectedAddedCount: selectedAdded.length,
    selectedRemovedCount: selectedRemoved.length,
    primaryAddedCount: augmented.primary.filter(file => !lexicalPrimary.has(file)).length,
    primaryRemovedCount: lexical.primary.filter(file => !augmentedPrimary.has(file)).length,
    selectedAdded: selectedAdded.slice(0, MAX_DIAGNOSTIC_PATHS),
    selectedRemoved: selectedRemoved.slice(0, MAX_DIAGNOSTIC_PATHS),
  };
}

function recordSelectionDelta(mode: 'shadow' | 'enabled', selectionDelta: SpectreSelectionDelta): void {
  (metrics.spectreStructuralSelectionDelta as { observe?(labels: Record<string, string>, value: number): void } | undefined)
    ?.observe?.({ mode, direction: 'added' }, selectionDelta.selectedAddedCount);
  (metrics.spectreStructuralSelectionDelta as { observe?(labels: Record<string, string>, value: number): void } | undefined)
    ?.observe?.({ mode, direction: 'removed' }, selectionDelta.selectedRemovedCount);
}

function recordResultMetrics(
  mode: 'shadow' | 'enabled',
  outcome: 'complete' | 'partial' | 'failed',
  result: SpectreStructuralResult | undefined,
  durationMs: number,
  inputBytes: number,
  inputFiles: number,
): void {
  if (result) {
    for (const file of result.files) {
      (metrics.spectreStructuralFilesTotal as { inc?(labels: Record<string, string>): void } | undefined)
        ?.inc?.({ mode, outcome: file.outcome });
    }
  } else {
    (metrics.spectreStructuralFilesTotal as { inc?(labels: Record<string, string>, value: number): void } | undefined)
      ?.inc?.({ mode, outcome: 'worker-failed' }, inputFiles);
  }
  (metrics.spectreStructuralDuration as { observe?(labels: Record<string, string>, value: number): void } | undefined)
    ?.observe?.({ mode, outcome }, durationMs / 1_000);
  (metrics.spectreStructuralInputBytes as { observe?(labels: Record<string, string>, value: number): void } | undefined)
    ?.observe?.({ mode }, result?.bytes ?? inputBytes);
  (metrics.spectreStructuralFacts as { observe?(labels: Record<string, string>, value: number): void } | undefined)
    ?.observe?.({ mode }, result?.facts.length ?? 0);
}

function resultOutcome(result: SpectreStructuralResult): 'complete' | 'partial' {
  const partialOutcomes = new Set<SpectreStructuralParserOutcome>([
    'file-limit', 'byte-limit', 'budget-exceeded', 'cancelled', 'parse-failed',
  ]);
  return result.budgetExceeded || result.files.some(file => partialOutcomes.has(file.outcome)) ? 'partial' : 'complete';
}

export function defaultSpectreStructuralAnalyzer(): SpectreStructuralAnalyzer {
  const sourceMode = fileURLToPath(import.meta.url).endsWith('.ts');
  return sourceMode ? analyzeSpectreStructuralSignals : analyzeSpectreStructuralSignalsIsolated;
}

export async function routeSpectreSignals({
  files,
  config,
  signal,
  analyzer,
}: RouteSpectreSignalsInput): Promise<SpectreRoutingResult> {
  signal?.throwIfAborted();
  const fileCap = Math.min(config.fileCap ?? 20, 30);
  const secondaryFileCap = Math.min(config.secondaryFileCap ?? 20, 50);
  const customPatterns = compileSpectreBoostPatterns(config.boostPatterns ?? []);
  const lexicalContext = extractSpectreSignals(files, customPatterns);
  const lexicalSelection = selectSpectreFiles(lexicalContext, fileCap, secondaryFileCap);
  const configured = astConfig(config);
  const emptyDelta = delta(lexicalSelection, lexicalSelection);
  if (configured.mode === 'off') {
    return {
      context: lexicalContext,
      selection: lexicalSelection,
      lexicalContext,
      lexicalSelection,
      diagnostics: {
        mode: 'off', outcome: 'off', files: 0, outcomes: {}, inputBytes: 0, facts: 0,
        durationMs: 0, budgetExceeded: false, selectionDelta: emptyDelta,
      },
    };
  }

  const started = performance.now();
  const inputBytes = files.reduce((total, file) => total + (file.content === null ? 0 : Buffer.byteLength(file.content, 'utf8')), 0);
  let structural: SpectreStructuralResult;
  try {
    structural = await (analyzer ?? defaultSpectreStructuralAnalyzer())(files, {
      signal,
      timeoutMs: configured.timeoutSeconds * 1_000,
      limits: {
        ...DEFAULT_SPECTRE_STRUCTURAL_LIMITS,
        maxFiles: configured.maxFiles,
        maxTotalBytes: configured.maxTotalBytes,
        maxTotalMs: configured.timeoutSeconds * 1_000,
      },
    });
    signal?.throwIfAborted();
  } catch (_error) {
    signal?.throwIfAborted();
    const durationMs = performance.now() - started;
    recordResultMetrics(configured.mode, 'failed', undefined, durationMs, inputBytes, files.length);
    recordSelectionDelta(configured.mode, emptyDelta);
    return {
      context: lexicalContext,
      selection: lexicalSelection,
      lexicalContext,
      lexicalSelection,
      diagnostics: {
        mode: configured.mode, outcome: 'failed', files: files.length, outcomes: {}, inputBytes, facts: 0,
        durationMs, budgetExceeded: false, fallbackReason: 'analyzer-failed', selectionDelta: emptyDelta,
      },
    };
  }

  const failedFiles = new Set(structural.files
    .filter(file => file.outcome === 'parse-failed' || file.outcome === 'cancelled')
    .map(file => file.file));
  const augmentedContext = extractSpectreSignalsWithStructuralFacts(
    files,
    customPatterns,
    structural.facts.filter(fact => !failedFiles.has(fact.file)),
  );
  const augmentedSelection = selectSpectreFiles(augmentedContext, fileCap, secondaryFileCap);
  const selectionDelta = delta(lexicalSelection, augmentedSelection);
  const outcome = resultOutcome(structural);
  const durationMs = performance.now() - started;
  const outcomes: Partial<Record<SpectreStructuralParserOutcome, number>> = {};
  for (const file of structural.files) outcomes[file.outcome] = (outcomes[file.outcome] ?? 0) + 1;
  recordResultMetrics(configured.mode, outcome, structural, durationMs, inputBytes, files.length);
  recordSelectionDelta(configured.mode, selectionDelta);
  const enabled = configured.mode === 'enabled';
  return {
    context: enabled ? augmentedContext : lexicalContext,
    selection: enabled ? augmentedSelection : lexicalSelection,
    lexicalContext,
    lexicalSelection,
    augmentedContext,
    augmentedSelection,
    diagnostics: {
      mode: configured.mode,
      outcome,
      files: structural.files.length,
      outcomes,
      inputBytes: structural.bytes,
      facts: structural.facts.length,
      durationMs,
      budgetExceeded: structural.budgetExceeded,
      selectionDelta,
    },
  };
}
