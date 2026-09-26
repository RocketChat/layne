/**
 * Prometheus metrics for Layne.
 *
 * When METRICS_ENABLED=true, this module creates real prom-client metric
 * objects and registers default Node.js process metrics.
 *
 * When disabled (the default), every export is a silent no-op stub so that
 * instrumentation calls throughout the codebase need no conditional guards.
 *
 * The server exposes GET /metrics on the Express app (PORT).
 * The worker exposes GET /metrics on a separate HTTP server (METRICS_PORT).
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

const enabled = process.env.METRICS_ENABLED === 'true';

// --- no-op stubs (used when disabled) ---

const noop        = (): void => {};
const noopTimer   = (): (() => void) => noop;

const noopCounter   = { inc: (_labels?: Record<string, string | number>, _value?: number) => {} };
const noopHistogram = {
  observe: (_labels: Record<string, string | number> | number, _value?: number) => {},
  startTimer: (_labels?: Record<string, string | number>) => noopTimer(),
};
const noopGauge     = {
  set: (_labels: Record<string, string | number> | number, _value?: number) => {},
  inc: (_labels?: Record<string, string | number>) => {},
  dec: (_labels?: Record<string, string | number>) => {},
};

// --- metric declarations ---

export let registry: Registry | null;
export let scanTotal: Counter | typeof noopCounter;
export let scanDuration: Histogram | typeof noopHistogram;
export let scanTimeoutsTotal: Counter | typeof noopCounter;
export let scanRetriesTotal: Counter | typeof noopCounter;
export let findingTotal: Counter | typeof noopCounter;
export let findingPlacementTotal: Counter | typeof noopCounter;
export let findingsPerScan: Histogram | typeof noopHistogram;
export let spectreScansTotal: Counter | typeof noopCounter;
export let spectreProviderRequestDuration: Histogram | typeof noopHistogram;
export let spectreProviderInputBytes: Histogram | typeof noopHistogram;
export let spectreChunksTotal: Counter | typeof noopCounter;
export let spectreRepairAttemptsTotal: Counter | typeof noopCounter;
export let spectreGovernorDecisionsTotal: Counter | typeof noopCounter;
export let spectreProviderFailuresTotal: Counter | typeof noopCounter;
export let spectreInFlightRequests: Gauge | typeof noopGauge;
export let spectreGovernorInFlightRequests: Gauge | typeof noopGauge;
export let spectreCircuitState: Gauge | typeof noopGauge;
export let spectreGovernorLeaseRecoveriesTotal: Counter | typeof noopCounter;
export let spectreGovernorBackendErrorsTotal: Counter | typeof noopCounter;
export let spectreCacheOperationsTotal: Counter | typeof noopCounter;
export let spectreCacheEntryBytes: Histogram | typeof noopHistogram;
export let spectreStructuralFilesTotal: Counter | typeof noopCounter;
export let spectreStructuralDuration: Histogram | typeof noopHistogram;
export let spectreStructuralInputBytes: Histogram | typeof noopHistogram;
export let spectreStructuralFacts: Histogram | typeof noopHistogram;
export let spectreStructuralSelectionDelta: Histogram | typeof noopHistogram;
export let webhooksTotal: Counter | typeof noopCounter;
export let queueWaiting: Gauge | typeof noopGauge;
export let queueActive: Gauge | typeof noopGauge;
export let queueFailed: Gauge | typeof noopGauge;

if (enabled) {
  registry = new Registry();
  collectDefaultMetrics({ register: registry });

  scanTotal = new Counter({
    name:       'layne_scans_total',
    help:       'Total number of scans completed',
    labelNames: ['conclusion', 'owner', 'repo'],
    registers:  [registry],
  });

  scanDuration = new Histogram({
    name:       'layne_scan_duration_seconds',
    help:       'End-to-end scan duration in seconds',
    labelNames: ['conclusion'],
    buckets:    [5, 15, 30, 60, 120, 300, 600],
    registers:  [registry],
  });

  scanTimeoutsTotal = new Counter({
    name:      'layne_scan_timeouts_total',
    help:      'Number of scans that exceeded the 10-minute timeout',
    registers: [registry],
  });

  scanRetriesTotal = new Counter({
    name:      'layne_scan_retries_total',
    help:      'Number of scan jobs that were retried after a non-fatal failure',
    registers: [registry],
  });

  findingTotal = new Counter({
    name:       'layne_findings_total',
    help:       'Cumulative number of findings across all scans',
    labelNames: ['severity', 'tool', 'owner', 'repo'],
    registers:  [registry],
  });

  findingPlacementTotal = new Counter({
    name:       'layne_finding_placements_total',
    help:       'Outcome of inline annotation placement after location validation',
    labelNames: ['tool', 'outcome', 'reason'],
    registers:  [registry],
  });

  findingsPerScan = new Histogram({
    name:       'layne_findings_per_scan',
    help:       'Distribution of finding counts per completed scan',
    labelNames: ['conclusion'],
    buckets:    [0, 1, 5, 10, 25, 50, 100, 250],
    registers:  [registry],
  });

  spectreScansTotal = new Counter({
    name:       'layne_spectre_scans_total',
    help:       'Spectre scan outcomes and coverage counters',
    labelNames: ['provider', 'outcome', 'reason'],
    registers:  [registry],
  });

  spectreProviderRequestDuration = new Histogram({
    name:       'layne_spectre_provider_request_duration_seconds',
    help:       'Spectre provider request duration in seconds',
    labelNames: ['provider', 'outcome'],
    buckets:    [0.25, 0.5, 1, 2, 5, 10, 20, 30],
    registers:  [registry],
  });

  spectreProviderInputBytes = new Histogram({
    name:       'layne_spectre_provider_input_bytes',
    help:       'Spectre provider request input size in bytes',
    labelNames: ['provider'],
    buckets:    [1_024, 4_096, 16_384, 32_768, 65_536, 131_072],
    registers:  [registry],
  });

  spectreChunksTotal = new Counter({
    name:       'layne_spectre_chunks_total',
    help:       'Spectre chunks by terminal outcome',
    labelNames: ['provider', 'outcome'],
    registers:  [registry],
  });

  spectreRepairAttemptsTotal = new Counter({
    name:       'layne_spectre_repair_attempts_total',
    help:       'Spectre targeted response and evidence repair attempts',
    labelNames: ['provider', 'kind', 'outcome'],
    registers:  [registry],
  });

  spectreGovernorDecisionsTotal = new Counter({
    name:       'layne_spectre_governor_decisions_total',
    help:       'Spectre provider governor decisions',
    labelNames: ['provider', 'backend', 'outcome', 'reason'],
    registers:  [registry],
  });

  spectreProviderFailuresTotal = new Counter({
    name:       'layne_spectre_provider_failures_total',
    help:       'Transient Spectre provider failures counted by kind',
    labelNames: ['kind'],
    registers:  [registry],
  });

  spectreInFlightRequests = new Gauge({
    name:      'layne_spectre_inflight_requests',
    help:      'Spectre provider requests currently holding a global governor lease',
    registers: [registry],
  });

  spectreGovernorInFlightRequests = new Gauge({
    name:       'layne_spectre_governor_inflight_requests',
    help:       'Spectre requests currently holding a governor lease by provider and backend',
    labelNames: ['provider', 'backend'],
    registers:  [registry],
  });

  spectreCircuitState = new Gauge({
    name:       'layne_spectre_circuit_state',
    help:       'Spectre circuit state: 0 closed, 1 open, 2 half-open',
    labelNames: ['provider', 'backend'],
    registers:  [registry],
  });

  spectreGovernorLeaseRecoveriesTotal = new Counter({
    name:       'layne_spectre_governor_lease_recoveries_total',
    help:       'Expired Redis Spectre governor leases recovered during acquisition',
    labelNames: ['provider', 'backend'],
    registers:  [registry],
  });

  spectreGovernorBackendErrorsTotal = new Counter({
    name:       'layne_spectre_governor_backend_errors_total',
    help:       'Redis Spectre governor backend operation failures',
    labelNames: ['provider', 'backend', 'operation'],
    registers:  [registry],
  });

  spectreCacheOperationsTotal = new Counter({
    name:       'layne_spectre_cache_operations_total',
    help:       'Spectre response-cache operations and outcomes',
    labelNames: ['operation', 'outcome', 'result'],
    registers:  [registry],
  });

  spectreCacheEntryBytes = new Histogram({
    name:       'layne_spectre_cache_entry_bytes',
    help:       'Serialized Spectre cache entry size in bytes',
    buckets:    [256, 1_024, 4_096, 16_384, 32_768, 65_536, 98_304],
    registers:  [registry],
  });

  spectreStructuralFilesTotal = new Counter({
    name:       'layne_spectre_structural_files_total',
    help:       'Spectre structural signal files by bounded parser outcome',
    labelNames: ['mode', 'outcome'],
    registers:  [registry],
  });

  spectreStructuralDuration = new Histogram({
    name:       'layne_spectre_structural_duration_seconds',
    help:       'Spectre structural signal analysis duration',
    labelNames: ['mode', 'outcome'],
    buckets:    [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 3, 10, 30],
    registers:  [registry],
  });

  spectreStructuralInputBytes = new Histogram({
    name:       'layne_spectre_structural_input_bytes',
    help:       'UTF-8 source bytes parsed by Spectre structural signal analysis',
    labelNames: ['mode'],
    buckets:    [1_024, 16_384, 65_536, 262_144, 1_048_576, 2_097_152, 8_388_608, 67_108_864],
    registers:  [registry],
  });

  spectreStructuralFacts = new Histogram({
    name:       'layne_spectre_structural_facts',
    help:       'Structural signal facts produced per Spectre routing operation',
    labelNames: ['mode'],
    buckets:    [0, 1, 5, 10, 25, 50, 100, 250, 500],
    registers:  [registry],
  });

  spectreStructuralSelectionDelta = new Histogram({
    name:       'layne_spectre_structural_selection_delta',
    help:       'Selected file count difference between lexical and structural-augmented routing',
    labelNames: ['mode', 'direction'],
    buckets:    [0, 1, 2, 5, 10, 20, 30],
    registers:  [registry],
  });

  webhooksTotal = new Counter({
    name:       'layne_webhooks_total',
    help:       'Total webhook events processed',
    labelNames: ['action', 'deduplicated'],
    registers:  [registry],
  });

  queueWaiting = new Gauge({
    name:      'layne_queue_waiting',
    help:      'Number of scan jobs waiting in the queue',
    registers: [registry],
  });

  queueActive = new Gauge({
    name:      'layne_queue_active',
    help:      'Number of scan jobs currently being processed',
    registers: [registry],
  });

  queueFailed = new Gauge({
    name:      'layne_queue_failed',
    help:      'Number of scan jobs in the failed state',
    registers: [registry],
  });
} else {
  registry          = null;
  scanTotal         = noopCounter;
  scanDuration      = noopHistogram;
  scanTimeoutsTotal = noopCounter;
  scanRetriesTotal  = noopCounter;
  findingTotal      = noopCounter;
  findingPlacementTotal = noopCounter;
  findingsPerScan   = noopHistogram;
  spectreScansTotal = noopCounter;
  spectreProviderRequestDuration = noopHistogram;
  spectreProviderInputBytes = noopHistogram;
  spectreChunksTotal = noopCounter;
  spectreRepairAttemptsTotal = noopCounter;
  spectreGovernorDecisionsTotal = noopCounter;
  spectreProviderFailuresTotal = noopCounter;
  spectreInFlightRequests = noopGauge;
  spectreGovernorInFlightRequests = noopGauge;
  spectreCircuitState = noopGauge;
  spectreGovernorLeaseRecoveriesTotal = noopCounter;
  spectreGovernorBackendErrorsTotal = noopCounter;
  spectreCacheOperationsTotal = noopCounter;
  spectreCacheEntryBytes = noopHistogram;
  spectreStructuralFilesTotal = noopCounter;
  spectreStructuralDuration = noopHistogram;
  spectreStructuralInputBytes = noopHistogram;
  spectreStructuralFacts = noopHistogram;
  spectreStructuralSelectionDelta = noopHistogram;
  webhooksTotal     = noopCounter;
  queueWaiting      = noopGauge;
  queueActive       = noopGauge;
  queueFailed       = noopGauge;
}
