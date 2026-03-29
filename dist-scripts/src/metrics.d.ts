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
import { Registry, Counter, Histogram, Gauge } from 'prom-client';
declare const noopCounter: {
    inc: (_labels?: Record<string, string | number>) => void;
};
declare const noopHistogram: {
    observe: (_labels: Record<string, string | number> | number, _value?: number) => void;
    startTimer: (_labels?: Record<string, string | number>) => () => void;
};
declare const noopGauge: {
    set: (_labels: Record<string, string | number> | number, _value?: number) => void;
};
export declare let registry: Registry | null;
export declare let scanTotal: Counter | typeof noopCounter;
export declare let scanDuration: Histogram | typeof noopHistogram;
export declare let scanTimeoutsTotal: Counter | typeof noopCounter;
export declare let scanRetriesTotal: Counter | typeof noopCounter;
export declare let findingTotal: Counter | typeof noopCounter;
export declare let findingPlacementTotal: Counter | typeof noopCounter;
export declare let findingsPerScan: Histogram | typeof noopHistogram;
export declare let webhooksTotal: Counter | typeof noopCounter;
export declare let queueWaiting: Gauge | typeof noopGauge;
export declare let queueActive: Gauge | typeof noopGauge;
export declare let queueFailed: Gauge | typeof noopGauge;
export {};
//# sourceMappingURL=metrics.d.ts.map