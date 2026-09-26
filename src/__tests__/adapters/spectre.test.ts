import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSpectreGovernor } from '../../spectre-governor.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCompleteSimple = vi.fn();
const mockGetModel       = vi.fn((): Record<string, unknown> => ({ id: 'claude-haiku-4-5-20251001', api: 'anthropic-messages' }));
const mockReadFile       = vi.fn();
const mockRedisEval      = vi.fn();

vi.mock('../../spectre-models.js', () => ({
  getSpectreModel:      mockGetModel,
  completeSpectreModel: mockCompleteSimple,
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}));

vi.mock('../../queue.js', () => ({
  redis: { eval: mockRedisEval },
}));

vi.mock('../../config.js', () => ({
  DEFAULT_CONFIG: Object.freeze({
    spectre: Object.freeze({
      enabled:          false,
      model:            'claude-haiku-4-5-20251001',
      fileCap:          20,
      secondaryFileCap: 20,
      maxDiffLines:     400,
      minSeverity:      'high',
      concurrency:      2,
      skipPaths:        [],
      skipExtensions:   [],
      prompt:           null,
      boostPatterns:    [],
    }),
  }),
}));

const { runSpectre: runSpectreImpl, runSpectreWithStatus: runSpectreWithStatusImpl } = await import('../../adapters/spectre.js');
let testGovernor: ReturnType<typeof createSpectreGovernor>;
const runSpectre = (args: Parameters<typeof runSpectreImpl>[0]) => runSpectreImpl({ governor: testGovernor, ...args });
const runSpectreWithStatus = (args: Parameters<typeof runSpectreWithStatusImpl>[0]) => runSpectreWithStatusImpl({ governor: testGovernor, ...args });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE = '/tmp/ws';

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled:          true,
    provider:         'anthropic',
    model:            'claude-haiku-4-5-20251001',
    fileCap:          20,
    secondaryFileCap: 20,
    maxDiffLines:     400,
    minSeverity:      'high' as const,
    concurrency:      1,
    skipPaths:        [],
    skipExtensions:   [],
    prompt:           null,
    boostPatterns:    [],
    astSignals:       { mode: 'off' as const, maxFiles: 100, maxTotalBytes: 2 * 1024 * 1024, timeoutSeconds: 3 },
    maxRepairCallsPerPullRequest: 0,
    ...overrides,
  };
}

// Clean LLM response — no findings.
function toolResponse(argumentsValue: unknown) {
  return {
    stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'call-1', name: 'report_findings', arguments: argumentsValue }],
  };
}

function noFindings() {
  return toolResponse({ findings: [] });
}

// Generate file names for testing.
function files(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}.js`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSpectre()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('SPECTRE_GOVERNOR_BACKEND', 'in_process');
    mockGetModel.mockReturnValue({ id: 'claude-haiku-4-5-20251001', api: 'anthropic-messages' });
    mockCompleteSimple.mockResolvedValue(noFindings());
    mockRedisEval.mockImplementation(async (script: string) => {
      if (script.includes('spectre:acquire-v1')) return ['acquired', 'closed', 0, Date.now()];
      if (script.includes('spectre:release-v1') || script.includes('spectre:renew-v1')) return 1;
      return 'closed';
    });
    // By default files have no suspicious keywords → tier3
    mockReadFile.mockResolvedValue('const x = 1;');
    testGovernor = createSpectreGovernor({
      concurrency: 100, requestsPerMinute: 10_000, burst: 10_000, queueTimeoutMs: 10,
      failureThreshold: 3, failureWindowMs: 60_000, cooldownMs: 60_000,
    });
  });

  it('returns empty when disabled', async () => {
    const findings = await runSpectre({
      workspacePath: WORKSPACE,
      changedFiles:  ['src/a.js'],
      toolConfig:    enabledConfig({ enabled: false }),
    });
    expect(findings).toEqual([]);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('reports incomplete when enabled without a provider', async () => {
    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles:  ['src/a.js'],
      toolConfig:    enabledConfig({ provider: undefined }),
    });
    expect(result.status).toMatchObject({ outcome: 'incomplete', reason: 'provider-configuration-invalid' });
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('preserves filtered-file accounting when provider configuration is invalid', async () => {
    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['README.md', 'src/a.js'],
      toolConfig: enabledConfig({ provider: undefined }),
    });

    expect(result.status).toMatchObject({
      outcome: 'incomplete',
      skipped: 1,
      reason: 'provider-configuration-invalid',
    });
  });

  it('treats a prose-only change as complete without initializing a provider', async () => {
    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['README.md', 'AGENTS.md', 'docs/guide.rst', 'notes.txt'],
      toolConfig: enabledConfig({ provider: undefined }),
    });

    expect(result.status).toMatchObject({ outcome: 'complete', selected: 0, scanned: 0, skipped: 4 });
    expect(mockGetModel).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('keeps prose out of routing capacity and provider requests', async () => {
    const changedFiles = [
      ...Array.from({ length: 30 }, (_, index) => `docs/guide-${index}.md`),
      'src/app.ts',
    ];
    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles,
      toolConfig: enabledConfig({ fileCap: 1, secondaryFileCap: 0 }),
    });

    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(mockReadFile).toHaveBeenCalledWith('/tmp/ws/src/app.ts', 'utf8');
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(result.status).toMatchObject({ outcome: 'complete', selected: 1, scanned: 1, skipped: 30, capped: 0 });
  });

  it('retains MDX and known code-bearing text files', async () => {
    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['src/page.mdx', 'CMakeLists.txt', 'requirements-dev.txt', 'constraints.txt'],
      toolConfig: enabledConfig(),
    });

    expect(mockReadFile).toHaveBeenCalledTimes(4);
    expect(mockCompleteSimple).toHaveBeenCalledTimes(4);
    expect(result.status).toMatchObject({ outcome: 'complete', selected: 4, scanned: 4, skipped: 0 });
  });

  it('selects the Redis governor registry when configured', async () => {
    vi.stubEnv('SPECTRE_GOVERNOR_BACKEND', 'redis');
    const result = await runSpectreWithStatusImpl({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js'],
      toolConfig: enabledConfig(),
    });

    expect(result.status.outcome).toBe('complete');
    expect(mockRedisEval.mock.calls.some(([script]) => String(script).includes('spectre:acquire-v1'))).toBe(true);
  });

  it('fails closed on an unknown governor backend when startup validation was bypassed', async () => {
    vi.stubEnv('SPECTRE_GOVERNOR_BACKEND', 'redsi');

    await expect(runSpectreWithStatusImpl({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js'],
      toolConfig: enabledConfig(),
    })).rejects.toThrow('Invalid SPECTRE_GOVERNOR_BACKEND: redsi');
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('awaits instrumented async lifecycle methods', async () => {
    const events: string[] = [];
    const asyncGovernor = {
      acquire: vi.fn(async () => ({
        succeed: async () => {
          await new Promise(resolve => setTimeout(resolve, 1));
          events.push('succeed');
        },
        fail: async () => { events.push('fail'); },
        release: async () => {
          expect(events).toContain('succeed');
          events.push('release');
        },
      })),
      getState: () => ({ state: 'closed' as const, inFlight: 0 }),
    };

    const result = await runSpectreWithStatusImpl({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js'],
      toolConfig: enabledConfig(),
      governor: asyncGovernor,
    });

    expect(result.status.outcome).toBe('complete');
    expect(events).toEqual(['succeed', 'release']);
  });

  it('scans only up to fileCap files when all files are tier3 (no keywords)', async () => {
    const changedFiles = files('src/file', 30);
    const result = await runSpectreWithStatus({ workspacePath: WORKSPACE, changedFiles, toolConfig: enabledConfig() });
    // 30 tier3 files, fileCap 20, no secondary (tier2 overflow is empty)
    expect(mockCompleteSimple).toHaveBeenCalledTimes(20);
    expect(result.status).toMatchObject({ outcome: 'incomplete', capped: 10, reason: 'file-cap-exceeded' });
  });

  it('secondary batch picks up keyword-matching overflow files', async () => {
    // 25 files contain a suspicious keyword → all tier2
    const keywordContent = 'require("child_process").execSync("ls")';
    mockReadFile.mockResolvedValue(keywordContent);

    const changedFiles = files('src/kw', 25);
    await runSpectre({ workspacePath: WORKSPACE, changedFiles, toolConfig: enabledConfig() });

    // primary: 20 tier2 files (fills the cap)
    // secondary: 5 remaining tier2 files (overflow), capped at secondaryFileCap=20
    expect(mockCompleteSimple).toHaveBeenCalledTimes(25);
  });

  it('secondary batch is capped at secondaryFileCap', async () => {
    // 40 keyword-matching files
    mockReadFile.mockResolvedValue('require("child_process").execSync("ls")');
    const changedFiles = files('src/kw', 40);

    await runSpectre({
      workspacePath: WORKSPACE,
      changedFiles,
      toolConfig: enabledConfig({ fileCap: 20, secondaryFileCap: 10 }),
    });

    // primary: 20, secondary: min(20 overflow, cap=10) = 10 → total 30
    expect(mockCompleteSimple).toHaveBeenCalledTimes(30);
  });

  it('supports 5 primary and 50 secondary files', async () => {
    mockReadFile.mockResolvedValue('require("child_process").execSync("ls")');

    await runSpectre({
      workspacePath: WORKSPACE,
      changedFiles: files('src/kw', 55),
      toolConfig: enabledConfig({
        fileCap: 5,
        secondaryFileCap: 50,
        maxCallsPerPullRequest: 60,
      }),
    });

    expect(mockCompleteSimple).toHaveBeenCalledTimes(55);
  });

  it('secondaryFileCap: 0 disables secondary batch entirely', async () => {
    mockReadFile.mockResolvedValue('require("child_process").execSync("ls")');
    const changedFiles = files('src/kw', 30);

    await runSpectre({
      workspacePath: WORKSPACE,
      changedFiles,
      toolConfig: enabledConfig({ secondaryFileCap: 0 }),
    });

    // Only primary 20 scanned, no secondary
    expect(mockCompleteSimple).toHaveBeenCalledTimes(20);
  });

  it('marks unselected score-12-or-higher files as a blocking coverage reason', async () => {
    const changedFiles = Array.from({ length: 13 }, (_, index) => `crates/c${index}/build.rs`);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles,
      toolConfig: enabledConfig({ fileCap: 1, secondaryFileCap: 1 }),
    });

    expect(mockCompleteSimple).toHaveBeenCalledTimes(2);
    expect(result.status).toMatchObject({
      outcome: 'incomplete',
      capped: 11,
      highRiskCapped: 11,
      reason: 'high-risk-file-cap-exceeded',
    });
    expect(result.status.highRiskCappedFiles).toHaveLength(10);
    expect(result.status.highRiskCappedFiles?.[0]).toMatchObject({ file: 'crates/c2/build.rs', score: 36 });
    expect(result.status.highRiskCappedFiles?.[9]).toMatchObject({ file: 'crates/c11/build.rs', score: 36 });
    error.mockRestore();
  });

  it('tier3 overflow files are never included in the secondary batch', async () => {
    // Mix: 5 keyword files + 25 ordinary files
    mockReadFile.mockImplementation(async (path: string) => {
      const fname = String(path).split('/').pop() ?? '';
      return fname.startsWith('kw') ? 'execSync("ls")' : 'const x = 1;';
    });

    const changedFiles = [
      ...files('src/kw', 5),    // tier2
      ...files('src/plain', 25), // tier3
    ];

    await runSpectre({ workspacePath: WORKSPACE, changedFiles, toolConfig: enabledConfig() });

    // primary: 5 tier2 + 15 tier3 = 20; secondary overflow tier2: 0 → total 20
    expect(mockCompleteSimple).toHaveBeenCalledTimes(20);
  });

  it('tier1 files (manifests) consume primary slots before tier2/tier3', async () => {
    // 5 package.json-style tier1 files + 20 keyword files
    mockReadFile.mockResolvedValue('execSync("ls")');

    const tier1Files  = Array.from({ length: 5 }, (_, i) => `pkg${i}/package.json`);
    const tier2Files  = files('src/kw', 20);
    const changedFiles = [...tier1Files, ...tier2Files];

    await runSpectre({ workspacePath: WORKSPACE, changedFiles, toolConfig: enabledConfig() });

    // primary: 5 tier1 + 15 tier2 = 20
    // secondary: remaining 5 tier2, capped at 20 → 5
    // total: 25
    expect(mockCompleteSimple).toHaveBeenCalledTimes(25);
  });

  it('uses bounded provider options and marks malformed model output incomplete', async () => {
    mockCompleteSimple.mockResolvedValueOnce(toolResponse({ findings: [{ severity: 'urgent' }] }));

    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js'],
      toolConfig: enabledConfig({ maxInputBytes: 1024, maxOutputTokens: 123, requestTimeoutSeconds: 7 }),
    });

    expect(result.findings).toEqual([]);
    expect(result.status.outcome).toBe('incomplete');
    expect(result.status.invalidResponses).toBe(1);
    expect(mockCompleteSimple).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ maxTokens: 123, temperature: 0, signal: expect.any(AbortSignal) }));
  });

  it('omits temperature for GPT-5.6 Luna', async () => {
    vi.stubEnv('AWS_REGION', 'us-east-1');
    mockGetModel.mockReturnValueOnce({ id: 'us.vendor.model-v1', api: 'bedrock-converse-stream', reasoning: true });

    await runSpectre({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js'],
      toolConfig: enabledConfig({ provider: 'amazon-bedrock', model: 'us.vendor.model-v1' }),
    });

    const options = mockCompleteSimple.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options).toMatchObject({ maxTokens: 1_200, signal: expect.any(AbortSignal) });
    expect(options).not.toHaveProperty('temperature');
  });

  it('marks a front-truncated file incomplete', async () => {
    mockReadFile.mockResolvedValue('line 1\nline 2\nline 3');
    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js'],
      toolConfig: enabledConfig({ maxDiffLines: 1 }),
    });

    expect(result.status).toMatchObject({ outcome: 'incomplete', truncated: 1, reason: 'input-truncated' });
  });

  it('reports neutral incomplete coverage when the global provider rate is exhausted', async () => {
    const governor = createSpectreGovernor({
      concurrency: 1, requestsPerMinute: 1, burst: 1, queueTimeoutMs: 10,
      failureThreshold: 3, failureWindowMs: 60_000, cooldownMs: 60_000,
    });
    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js', 'src/b.js'],
      toolConfig: enabledConfig({ concurrency: 1 }),
      governor,
    });

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(result.status.outcome).toBe('incomplete');
    expect(result.status.rateLimited).toBe(1);
    expect(result.status.scanned).toBe(1);
  });

  it('reports provider queue saturation separately from rate limiting', async () => {
    const governor = createSpectreGovernor({
      concurrency: 1, requestsPerMinute: 100, burst: 100, queueTimeoutMs: 1,
      failureThreshold: 3, failureWindowMs: 60_000, cooldownMs: 60_000,
    });
    mockCompleteSimple.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return noFindings();
    });

    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js', 'src/b.js'],
      toolConfig: enabledConfig({ concurrency: 2 }),
      governor,
    });

    expect(result.status).toMatchObject({
      outcome: 'incomplete', scanned: 1, concurrencyLimited: 1,
      rateLimited: 0, reason: 'provider-concurrency-limited',
    });
  });

  it.each(['error', 'aborted'] as const)('treats provider stop reason %s as incomplete', async (stopReason) => {
    mockCompleteSimple.mockResolvedValueOnce({
      stopReason,
      errorMessage: stopReason === 'error' ? '429 rate limit exceeded' : 'request aborted',
      content: [{ type: 'text', text: '{"findings":[]}' }],
    });

    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js'],
      toolConfig: enabledConfig(),
    });

    expect(result.findings).toEqual([]);
    expect(result.status.outcome).toBe('incomplete');
    expect(result.status.scanned).toBe(0);
  });

  it('stops dequeuing files when the parent scan is cancelled', async () => {
    const controller = new AbortController();
    mockCompleteSimple.mockImplementationOnce(async () => {
      controller.abort(new Error('scan deadline exceeded'));
      return { stopReason: 'aborted', errorMessage: 'request aborted', content: [] };
    });

    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js', 'src/b.js', 'src/c.js'],
      toolConfig: enabledConfig({ concurrency: 1 }),
      signal: controller.signal,
    });

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(result.status).toMatchObject({ outcome: 'incomplete', cancelled: 3, reason: 'cancelled' });
    expect(testGovernor.getState().inFlight).toBe(0);
  });

  it('rejects output truncated by the provider even when it contains valid JSON', async () => {
    mockCompleteSimple.mockResolvedValueOnce({
      stopReason: 'length',
      content: [{ type: 'text', text: '{"findings":[]}' }],
    });

    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js'],
      toolConfig: enabledConfig(),
    });

    expect(result.status.outcome).toBe('incomplete');
    expect(result.status.invalidResponses).toBe(1);
  });

  it('keeps valid findings when a sibling finding is malformed', async () => {
    mockCompleteSimple.mockResolvedValueOnce(toolResponse({ findings: [
        {
          file: 'src/a.js', startLine: 1, endLine: 1, severity: 'high',
          ruleId: 'backdoor', message: 'Confirmed hidden access path', evidence: 'const x = 1;',
        },
        null,
      ] }));

    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js'],
      toolConfig: enabledConfig(),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.status.outcome).toBe('incomplete');
    expect(result.status.invalidResponses).toBe(1);
  });

  it('accepts exact evidence when optional line hints are omitted', async () => {
    mockCompleteSimple.mockResolvedValueOnce(toolResponse({ findings: [{
        file: 'src/a.js', severity: 'critical', ruleId: 'backdoor',
        message: 'Confirmed hidden access path', evidence: 'const x = 1;',
      }] }));

    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js'],
      toolConfig: enabledConfig({ minSeverity: 'critical' }),
    });

    expect(result.findings).toEqual([expect.objectContaining({ line: 1, severity: 'critical', evidence: 'const x = 1;' })]);
    expect(result.status.outcome).toBe('complete');
  });

  it.each([
    'null',
    '{"findings":[null]}',
    '{"findings":"none"}',
  ])('handles malformed JSON value without throwing: %s', async (text) => {
    mockCompleteSimple.mockResolvedValueOnce(toolResponse(JSON.parse(text)));

    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js'],
      toolConfig: enabledConfig(),
    });

    expect(result.status.outcome).toBe('incomplete');
    expect(result.status.invalidResponses).toBe(1);
  });

  it('returns incomplete before calling the provider for an unknown model', async () => {
    mockGetModel.mockReturnValueOnce(undefined as unknown as Record<string, never>);

    const result = await runSpectreWithStatus({
      workspacePath: WORKSPACE,
      changedFiles: ['README.md', 'src/a.js'],
      toolConfig: enabledConfig({ model: 'missing-model' }),
    });

    expect(result.status).toMatchObject({ outcome: 'incomplete', skipped: 1, reason: 'model-initialisation-failed' });
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });
});
