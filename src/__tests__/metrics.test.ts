import { describe, it, expect, vi, beforeEach } from 'vitest';

// Metrics module is stateful — reset between tests so METRICS_ENABLED changes take effect.
describe('metrics (METRICS_ENABLED not set — default)', () => {
  let metrics: typeof import('../metrics.js');

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    metrics = await import('../metrics.js');
  });

  it('exports a null registry when disabled', () => {
    expect(metrics.registry).toBeNull();
  });

  it('scanTotal.inc() is a no-op and does not throw', () => {
    expect(() => metrics.scanTotal.inc({ conclusion: 'success', owner: 'org', repo: 'repo' })).not.toThrow();
  });

  it('scanDuration.startTimer() returns a callable that does not throw', () => {
    const stop = metrics.scanDuration.startTimer();
    expect(() => stop({ conclusion: 'success' })).not.toThrow();
  });

  it('scanDuration.observe() is a no-op and does not throw', () => {
    expect(() => (metrics.scanDuration as { observe(l: Record<string, string>, v: number): void }).observe({ conclusion: 'failure' }, 5)).not.toThrow();
  });

  it('scanTimeoutsTotal.inc() is a no-op and does not throw', () => {
    expect(() => metrics.scanTimeoutsTotal.inc()).not.toThrow();
  });

  it('scanRetriesTotal.inc() is a no-op and does not throw', () => {
    expect(() => metrics.scanRetriesTotal.inc()).not.toThrow();
  });

  it('findingTotal.inc() is a no-op and does not throw', () => {
    expect(() => metrics.findingTotal.inc({ severity: 'high', tool: 'semgrep', owner: 'org', repo: 'repo' })).not.toThrow();
  });

  it('findingPlacementTotal.inc() is a no-op and does not throw', () => {
    expect(() => metrics.findingPlacementTotal.inc({ tool: 'claude', outcome: 'inlineable', reason: 'validated-claimed-range' })).not.toThrow();
  });

  it('findingsPerScan.observe() is a no-op and does not throw', () => {
    expect(() => (metrics.findingsPerScan as { observe(l: Record<string, string>, v: number): void }).observe({ conclusion: 'success' }, 3)).not.toThrow();
  });

  it('webhooksTotal.inc() is a no-op and does not throw', () => {
    expect(() => metrics.webhooksTotal.inc({ action: 'opened', deduplicated: 'false' })).not.toThrow();
  });

  it('queueWaiting.set() is a no-op and does not throw', () => {
    expect(() => metrics.queueWaiting.set(5)).not.toThrow();
  });

  it('queueActive.set() is a no-op and does not throw', () => {
    expect(() => metrics.queueActive.set(2)).not.toThrow();
  });

  it('queueFailed.set() is a no-op and does not throw', () => {
    expect(() => metrics.queueFailed.set(0)).not.toThrow();
  });
});

describe('metrics (METRICS_ENABLED=true)', () => {
  let metrics: typeof import('../metrics.js');

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('METRICS_ENABLED', 'true');
    metrics = await import('../metrics.js');
  });

  it('exports a non-null registry when enabled', () => {
    expect(metrics.registry).not.toBeNull();
  });

  it('scanTotal is a real Counter (has inc method)', () => {
    expect(typeof metrics.scanTotal.inc).toBe('function');
  });

  it('scanDuration is a real Histogram (has startTimer method)', () => {
    expect(typeof metrics.scanDuration.startTimer).toBe('function');
  });

  it('registry.metrics() returns a string with layne_ metrics', async () => {
    const output = await metrics.registry!.metrics();
    expect(output).toContain('layne_scans_total');
    expect(output).toContain('layne_scan_duration_seconds');
    expect(output).toContain('layne_findings_total');
    expect(output).toContain('layne_finding_placements_total');
    expect(output).toContain('layne_webhooks_total');
    expect(output).toContain('layne_queue_waiting');
  });
});
