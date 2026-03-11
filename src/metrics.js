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

const noop        = () => {};
const noopTimer   = () => noop;
const noopCounter   = { inc: noop };
const noopHistogram = { observe: noop, startTimer: noopTimer };
const noopGauge     = { set: noop };

// --- metric declarations ---

export let registry;
export let scanTotal;
export let scanDuration;
export let scanTimeoutsTotal;
export let scanRetriesTotal;
export let findingTotal;
export let findingsPerScan;
export let webhooksTotal;
export let queueWaiting;
export let queueActive;
export let queueFailed;

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

  findingsPerScan = new Histogram({
    name:       'layne_findings_per_scan',
    help:       'Distribution of finding counts per completed scan',
    labelNames: ['conclusion'],
    buckets:    [0, 1, 5, 10, 25, 50, 100, 250],
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
  findingsPerScan   = noopHistogram;
  webhooksTotal     = noopCounter;
  queueWaiting      = noopGauge;
  queueActive       = noopGauge;
  queueFailed       = noopGauge;
}
