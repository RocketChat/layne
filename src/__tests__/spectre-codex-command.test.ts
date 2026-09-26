import { EventEmitter } from 'events';
import { stat, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { describe, expect, it, vi } from 'vitest';

const loadCodexModule = async () => {
  // Keep the scripts directory outside tsconfig.test's rootDir while exercising the evaluator module.
  const moduleUrl = new URL('../../scripts/spectre-transports/codex-cli.ts', import.meta.url);
  return await import(moduleUrl.href) as {
    buildCodexArgs(options: { schemaPath: string; outputPath: string; model?: string }): string[];
    buildCodexResponseSchema(schema: import('../spectre-transport.js').JsonValue): import('../spectre-transport.js').JsonValue;
    createCodexCliSpectreTransport(options: Record<string, unknown>): {
       complete(request: {
         key: string;
         prompt: string;
         responseSchema: { readonly [key: string]: string };
         signal?: AbortSignal;
       }): Promise<{ text: string }>;
    };
  };
};

describe('Codex Spectre command', () => {
  it('projects optional properties out of the strict Codex response schema', async () => {
    const { buildCodexResponseSchema } = await loadCodexModule();

    expect(buildCodexResponseSchema({
      type: 'object',
      additionalProperties: false,
      required: ['findings'],
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['file', 'evidence'],
            properties: {
              file: { type: 'string' },
              startLine: { type: 'integer' },
              evidence: { type: 'string' },
            },
          },
        },
      },
    })).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['findings'],
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['file', 'evidence'],
            properties: {
              file: { type: 'string' },
              evidence: { type: 'string' },
            },
          },
        },
      },
    });
  });

  it('uses a shell-free, read-only, non-interactive and isolated invocation', async () => {
    const { buildCodexArgs } = await loadCodexModule();
    const args = buildCodexArgs({
      schemaPath: '/isolated/response-schema.json',
      outputPath: '/isolated/response.json',
      model: 'gpt-test',
    });

    expect(args).toEqual([
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox', 'read-only',
      '--output-schema', '/isolated/response-schema.json',
      '--skip-git-repo-check',
      '--color', 'never',
      '--output-last-message', '/isolated/response.json',
      '--model', 'gpt-test',
      '-',
    ]);
    expect(args).not.toContain('prompt contents');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--full-auto');
    expect(args).not.toContain('--enable');
  });

  it('writes the schema, sends the prompt over stdin, reads the final response, and cleans up', async () => {
    const { createCodexCliSpectreTransport } = await loadCodexModule();
    let capturedCwd = '';
    let capturedPrompt = '';
    let capturedSchema = '';
    const previousSecret = process.env.LAYNE_CODEX_TEST_SECRET;
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.LAYNE_CODEX_TEST_SECRET = 'must-not-leak';
    process.env.OPENAI_API_KEY = 'test-api-key';
    const spawnProcess = vi.fn((command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }) => {
      capturedCwd = options.cwd;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdin.on('data', chunk => { capturedPrompt += chunk.toString(); });

      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        kill: vi.fn(() => true),
      }) as unknown as ChildProcess;
      stdin.once('finish', async () => {
        const schemaPath = args[args.indexOf('--output-schema') + 1];
        const outputPath = args[args.indexOf('--output-last-message') + 1];
        capturedSchema = await (await import('fs/promises')).readFile(schemaPath, 'utf8');
        await writeFile(outputPath, '{"findings":[]}');
        child.emit('close', 0, null);
      });
      expect(command).toBe('codex-test-double');
      expect(options).toMatchObject({
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      expect(options.env).not.toHaveProperty('LAYNE_CODEX_TEST_SECRET');
      expect(options.env.OPENAI_API_KEY).toBe('test-api-key');
      expect(options.env).toMatchObject({
        HOME: expect.stringContaining('layne-spectre-codex-'),
        TMPDIR: expect.stringContaining('layne-spectre-codex-'),
        XDG_CONFIG_HOME: expect.stringContaining('layne-spectre-codex-'),
        CODEX_HOME: expect.stringContaining('layne-spectre-codex-'),
      });
      expect(new Set([
        options.cwd,
        options.env.HOME,
        options.env.TMPDIR,
        options.env.XDG_CONFIG_HOME,
        options.env.CODEX_HOME,
      ]).size).toBe(5);
      return child;
    });
    const transport = createCodexCliSpectreTransport({
      command: 'codex-test-double',
      spawnProcess,
      timeoutMs: 1_000,
    });

    try {
      await expect(transport.complete({
        key: 'case-1',
        prompt: 'untrusted prompt contents',
        responseSchema: { type: 'object' },
      })).resolves.toEqual({ text: '{"findings":[]}' });
    } finally {
      if (previousSecret === undefined) delete process.env.LAYNE_CODEX_TEST_SECRET;
      else process.env.LAYNE_CODEX_TEST_SECRET = previousSecret;
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }

    expect(capturedPrompt).toBe('untrusted prompt contents');
    expect(JSON.parse(capturedSchema)).toEqual({ type: 'object' });
    expect(spawnProcess).toHaveBeenCalledOnce();
    await expect(stat(capturedCwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for close and escalates a timed-out process group before cleanup', async () => {
    vi.useFakeTimers();
    const { createCodexCliSpectreTransport } = await loadCodexModule();
    let capturedCwd = '';
    let child!: ChildProcess;
    let markSpawned!: () => void;
    const spawned = new Promise<void>(resolve => { markSpawned = resolve; });
    const kill = vi.fn(() => true);
    const signalProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    });
    const spawnProcess = vi.fn((_command: string, _args: readonly string[], options: { cwd: string }) => {
      capturedCwd = options.cwd;
      child = Object.assign(new EventEmitter(), {
        pid: 4321,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill,
      }) as unknown as ChildProcess;
      markSpawned();
      return child;
    });
    const transport = createCodexCliSpectreTransport({
      command: 'codex-test-double',
      spawnProcess,
      timeoutMs: 5,
      terminationGraceMs: 10,
      signalProcessGroup,
    });

    const completion = transport.complete({
      key: 'timeout-case',
      prompt: 'bounded prompt',
      responseSchema: { type: 'object' },
    });
    let settled = false;
    const outcome = completion.then(
      value => { settled = true; return value; },
      error => { settled = true; throw error; },
    );
    await spawned;
    await vi.advanceTimersByTimeAsync(5);

    expect(signalProcessGroup).toHaveBeenCalledWith(4321, 'SIGTERM');
    expect(settled).toBe(false);
    await expect(stat(capturedCwd)).resolves.toBeDefined();

    const assertTimeout = expect(outcome).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await assertTimeout;
    expect(signalProcessGroup).toHaveBeenCalledWith(4321, 'SIGKILL');
    expect(kill).not.toHaveBeenCalled();
    await expect(stat(capturedCwd)).rejects.toMatchObject({ code: 'ENOENT' });
    vi.useRealTimers();
  });

  it('waits for process-group close after cancellation before cleanup', async () => {
    const { createCodexCliSpectreTransport } = await loadCodexModule();
    const controller = new AbortController();
    let capturedCwd = '';
    let child!: ChildProcess;
    const signalProcessGroup = vi.fn();
    const spawnProcess = vi.fn((_command: string, _args: readonly string[], options: { cwd: string }) => {
      capturedCwd = options.cwd;
      child = Object.assign(new EventEmitter(), {
        pid: 8765,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      }) as unknown as ChildProcess;
      return child;
    });
    const transport = createCodexCliSpectreTransport({
      command: 'codex-test-double',
      spawnProcess,
      timeoutMs: 1_000,
      terminationGraceMs: 100,
      signalProcessGroup,
    });

    const completion = transport.complete({
      key: 'cancelled-case',
      prompt: 'bounded prompt',
      responseSchema: { type: 'object' },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    controller.abort(new Error('stop'));
    expect(signalProcessGroup).toHaveBeenCalledWith(8765, 'SIGTERM');
    await expect(stat(capturedCwd)).resolves.toBeDefined();

    child.emit('close', null, 'SIGTERM');
    await expect(completion).rejects.toMatchObject({ code: 'cancelled' });
    await expect(stat(dirname(capturedCwd))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the Codex evaluator disabled in CI and tests', async () => {
    const moduleUrl = new URL('../../scripts/evaluate-spectre-codex.ts', import.meta.url);
    const { assertManualCodexEvaluation } = await import(moduleUrl.href) as {
      assertManualCodexEvaluation(env: NodeJS.ProcessEnv): void;
    };

    expect(() => assertManualCodexEvaluation({ CI: 'true' })).toThrow('manual-only');
    expect(() => assertManualCodexEvaluation({ NODE_ENV: 'test' })).toThrow('manual-only');
  });

  it('parses AST mode, repeat, tag filtering, and offset/limit metadata without invoking Codex', async () => {
    const moduleUrl = new URL('../../scripts/evaluate-spectre.ts', import.meta.url);
    const evaluator = await import(moduleUrl.href) as {
      evaluationAstModeFromEnv(env: NodeJS.ProcessEnv): 'off' | 'shadow' | 'enabled' | undefined;
      evaluationRepeatsFromEnv(env: NodeJS.ProcessEnv): number;
      effectiveEvaluationConfig(test: Record<string, unknown>, config: Record<string, unknown>, mode?: string): {
        fileCap?: number;
        secondaryFileCap?: number;
        maxDiffLines?: number;
        astSignals: Record<string, unknown>;
      };
      loadEvaluationCases(env: NodeJS.ProcessEnv): Promise<{
        corpus: Array<{ id: string }>;
        repeats: number;
        tagFilter: string[];
        tagMatchedCases: number;
        offset: number;
        limit: number;
        corpusSha256: string;
      }>;
    };
    const cases = [
      { id: 'one', file: 'one.ts', content: 'one', expectedRuleIds: [], tags: ['go'] },
      { id: 'two', file: 'two.ts', content: 'two', expectedRuleIds: [], tags: ['ast'] },
      { id: 'three', file: 'three.ts', content: 'three', expectedRuleIds: [], tags: ['ast', 'go'] },
    ];

    expect(evaluator.evaluationAstModeFromEnv({ SPECTRE_EVAL_AST_MODE: 'shadow' })).toBe('shadow');
    expect(() => evaluator.evaluationAstModeFromEnv({ SPECTRE_EVAL_AST_MODE: 'invalid' })).toThrow('off, shadow, or enabled');
    expect(evaluator.evaluationRepeatsFromEnv({ SPECTRE_EVAL_REPEATS: '10' })).toBe(10);
    expect(() => evaluator.evaluationRepeatsFromEnv({ SPECTRE_EVAL_REPEATS: '11' })).toThrow('1 to 10');
    expect(evaluator.effectiveEvaluationConfig({
      routing: {
        fileCap: 2,
        secondaryFileCap: 1,
        maxDiffLines: 12,
        astSignals: { mode: 'shadow', maxFiles: 7 },
      },
    }, {
      astSignals: { mode: 'off', maxFiles: 100, maxTotalBytes: 1000, timeoutSeconds: 3 },
    }, 'enabled')).toMatchObject({
      fileCap: 2,
      secondaryFileCap: 1,
      maxDiffLines: 12,
      astSignals: { mode: 'enabled', maxFiles: 7, maxTotalBytes: 1000, timeoutSeconds: 3 },
    });

    const loaded = await evaluator.loadEvaluationCases({
      SPECTRE_FILE_CASES: JSON.stringify(cases),
      SPECTRE_EVAL_TAGS: 'ast',
      SPECTRE_EVAL_OFFSET: '1',
      SPECTRE_EVAL_LIMIT: '1',
      SPECTRE_EVAL_REPEATS: '3',
    });
    expect(loaded).toMatchObject({
      corpus: [{ id: 'three' }],
      repeats: 3,
      tagFilter: ['ast'],
      tagMatchedCases: 2,
      offset: 1,
      limit: 1,
    });
    expect(loaded.corpusSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds reproducibility metadata and compares paired evaluator runs', async () => {
    const evaluatorUrl = new URL('../../scripts/evaluate-spectre.ts', import.meta.url);
    const comparisonUrl = new URL('../../scripts/compare-spectre-evals.ts', import.meta.url);
    const { addEvaluationStability, buildEvaluationReproducibility } = await import(evaluatorUrl.href) as {
      addEvaluationStability(results: Array<Record<string, unknown>>): void;
      buildEvaluationReproducibility(options: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const { compareSpectreEvaluationReports } = await import(comparisonUrl.href) as {
      compareSpectreEvaluationReports(before: unknown, after: unknown): {
        paired: number;
        delta: Record<string, number>;
        changed: Array<{ key: string; routingSelectionChanged: boolean }>;
      };
    };
    const config = {
      enabled: true,
      provider: 'anthropic',
      model: 'test',
      requestTimeoutSeconds: 99,
      astSignals: { mode: 'enabled', maxFiles: 10, maxTotalBytes: 1000, timeoutSeconds: 1 },
    };
    const metadata = await buildEvaluationReproducibility({
      corpusSha256: 'a'.repeat(64), config, astMode: 'enabled', model: 'gpt-test', cliTimeoutMs: 12_345,
    });
    expect(metadata).toMatchObject({
      structuralRulesVersion: expect.any(Number),
      astMode: 'enabled',
      corpusSha256: 'a'.repeat(64),
      configSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      promptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      node: process.version,
      model: 'gpt-test',
      cliTimeoutMs: 12_345,
      spectreRequestTimeoutMs: 30_000,
    });

    const base = {
      id: 'case', baseCaseId: 'case', runIndex: 1, tags: [], expectedRuleIds: ['backdoor'],
      actualRuleIds: [], passed: false, malformed: false,
      expectedFindings: [{ file: 'a.ts', ruleId: 'backdoor' }], actualFindings: [],
      routing: { selectedFiles: ['a.ts'] },
    };
    const repeated: Array<Record<string, unknown> & { stability?: { runs: number; stable: boolean; distinctOutcomes: number } }> = [
      { ...base },
      { ...base, runIndex: 2, actualRuleIds: ['backdoor'], actualFindings: [{ file: 'a.ts', ruleId: 'backdoor' }], passed: true },
    ];
    addEvaluationStability(repeated);
    expect(repeated.map(result => result.stability)).toEqual([
      { runs: 2, stable: false, distinctOutcomes: 2 },
      { runs: 2, stable: false, distinctOutcomes: 2 },
    ]);
    const comparison = compareSpectreEvaluationReports(
      { evaluator: 'codex', model: 'before', results: [base] },
      { evaluator: 'codex', model: 'after', results: [{
        ...base,
        actualRuleIds: ['backdoor'],
        actualFindings: [{ file: 'a.ts', ruleId: 'backdoor' }],
        passed: true,
        routing: { selectedFiles: ['b.ts'] },
      }] },
    );
    expect(comparison).toMatchObject({
      paired: 1,
      delta: { falsePositives: 0, falseNegatives: -1, malformed: 0, errors: 0, passed: 1 },
      changed: [{ key: 'case#1', routingSelectionChanged: true }],
    });
  });
});
