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

  it('Redis governor metrics are no-ops when disabled', () => {
    expect(() => metrics.spectreGovernorLeaseRecoveriesTotal.inc({ provider: 'anthropic', backend: 'redis' })).not.toThrow();
    expect(() => metrics.spectreGovernorBackendErrorsTotal.inc({ provider: 'anthropic', backend: 'redis', operation: 'acquire' })).not.toThrow();
  });

  it('Spectre provider metrics are no-ops when disabled', () => {
    expect(() => metrics.spectreScansTotal.inc({ provider: 'anthropic', outcome: 'incomplete', reason: 'provider-rate-limited' })).not.toThrow();
    expect(() => (metrics.spectreProviderRequestDuration as { observe(labels: Record<string, string>, value: number): void }).observe({ provider: 'anthropic', outcome: 'complete' }, 1)).not.toThrow();
    expect(() => (metrics.spectreProviderInputBytes as { observe(labels: Record<string, string>, value: number): void }).observe({ provider: 'anthropic' }, 1_024)).not.toThrow();
    expect(() => metrics.spectreChunksTotal.inc({ provider: 'anthropic', outcome: 'complete' })).not.toThrow();
    expect(() => metrics.spectreRepairAttemptsTotal.inc({ provider: 'anthropic', kind: 'evidence', outcome: 'succeeded' })).not.toThrow();
    expect(() => (metrics.spectreGovernorInFlightRequests as { set(labels: Record<string, string>, value: number): void }).set({ provider: 'anthropic', backend: 'redis' }, 1)).not.toThrow();
    expect(() => metrics.spectreCacheOperationsTotal.inc({ operation: 'read', outcome: 'hit', result: 'negative' })).not.toThrow();
    expect(() => (metrics.spectreCacheEntryBytes as { observe(value: number): void }).observe(1_024)).not.toThrow();
    expect(() => metrics.spectreStructuralFilesTotal.inc({ mode: 'shadow', outcome: 'parsed' })).not.toThrow();
    expect(() => (metrics.spectreStructuralDuration as { observe(labels: Record<string, string>, value: number): void }).observe({ mode: 'shadow', outcome: 'complete' }, 0.1)).not.toThrow();
    expect(() => (metrics.spectreStructuralInputBytes as { observe(labels: Record<string, string>, value: number): void }).observe({ mode: 'shadow' }, 1_024)).not.toThrow();
    expect(() => (metrics.spectreStructuralFacts as { observe(labels: Record<string, string>, value: number): void }).observe({ mode: 'shadow' }, 2)).not.toThrow();
    expect(() => (metrics.spectreStructuralSelectionDelta as { observe(labels: Record<string, string>, value: number): void }).observe({ mode: 'shadow', direction: 'added' }, 1)).not.toThrow();
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
    metrics.spectreScansTotal.inc({ provider: 'anthropic', outcome: 'complete', reason: 'none' });
    (metrics.spectreProviderRequestDuration as { observe(labels: Record<string, string>, value: number): void }).observe({ provider: 'anthropic', outcome: 'complete' }, 1);
    (metrics.spectreProviderInputBytes as { observe(labels: Record<string, string>, value: number): void }).observe({ provider: 'anthropic' }, 1_024);
    metrics.spectreChunksTotal.inc({ provider: 'anthropic', outcome: 'complete' });
    metrics.spectreRepairAttemptsTotal.inc({ provider: 'anthropic', kind: 'evidence', outcome: 'succeeded' });
    metrics.spectreGovernorDecisionsTotal.inc({ provider: 'anthropic', backend: 'redis', outcome: 'acquired', reason: 'none' });
    (metrics.spectreGovernorInFlightRequests as { set(labels: Record<string, string>, value: number): void }).set({ provider: 'anthropic', backend: 'redis' }, 1);
    (metrics.spectreCircuitState as { set(labels: Record<string, string>, value: number): void }).set({ provider: 'anthropic', backend: 'redis' }, 0);
    metrics.spectreGovernorLeaseRecoveriesTotal.inc({ provider: 'anthropic', backend: 'redis' });
    metrics.spectreGovernorBackendErrorsTotal.inc({ provider: 'anthropic', backend: 'redis', operation: 'acquire' });
    metrics.spectreCacheOperationsTotal.inc({ operation: 'read', outcome: 'hit', result: 'negative' });
    (metrics.spectreCacheEntryBytes as { observe(value: number): void }).observe(1_024);
    metrics.spectreStructuralFilesTotal.inc({ mode: 'shadow', outcome: 'parsed' });
    (metrics.spectreStructuralDuration as { observe(labels: Record<string, string>, value: number): void }).observe({ mode: 'shadow', outcome: 'complete' }, 0.1);
    (metrics.spectreStructuralInputBytes as { observe(labels: Record<string, string>, value: number): void }).observe({ mode: 'shadow' }, 1_024);
    (metrics.spectreStructuralFacts as { observe(labels: Record<string, string>, value: number): void }).observe({ mode: 'shadow' }, 2);
    (metrics.spectreStructuralSelectionDelta as { observe(labels: Record<string, string>, value: number): void }).observe({ mode: 'shadow', direction: 'added' }, 1);
    const output = await metrics.registry!.metrics();
    expect(output).toContain('layne_scans_total');
    expect(output).toContain('layne_scan_duration_seconds');
    expect(output).toContain('layne_findings_total');
    expect(output).toContain('layne_finding_placements_total');
    expect(output).toContain('layne_webhooks_total');
    expect(output).toContain('layne_queue_waiting');
    expect(output).toContain('layne_spectre_scans_total{provider="anthropic",outcome="complete",reason="none"}');
    expect(output).toContain('layne_spectre_provider_request_duration_seconds');
    expect(output).toContain('layne_spectre_provider_input_bytes');
    expect(output).toContain('layne_spectre_chunks_total');
    expect(output).toContain('layne_spectre_repair_attempts_total');
    expect(output).toContain('layne_spectre_governor_decisions_total');
    expect(output).toContain('layne_spectre_governor_inflight_requests');
    expect(output).toContain('layne_spectre_circuit_state');
    expect(output).toContain('layne_spectre_governor_lease_recoveries_total');
    expect(output).toContain('layne_spectre_governor_backend_errors_total');
    expect(output).toContain('layne_spectre_cache_operations_total');
    expect(output).toContain('layne_spectre_cache_entry_bytes');
    expect(output).toContain('layne_spectre_structural_files_total');
    expect(output).toContain('layne_spectre_structural_duration_seconds');
    expect(output).toContain('layne_spectre_structural_input_bytes');
    expect(output).toContain('layne_spectre_structural_facts');
    expect(output).toContain('layne_spectre_structural_selection_delta');
  });
});
