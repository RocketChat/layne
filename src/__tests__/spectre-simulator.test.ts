import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadSpectreSimulationCorpus,
  runSpectreSimulation,
  runSpectreSimulationCorpus,
} from '../spectre-simulator.js';

const fixturePath = resolve('fixtures/spectre-simulations.json');

describe('Spectre PR simulator', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  });

  it('runs the deterministic corpus through real Git changes and the provider-neutral core', async () => {
    const report = await runSpectreSimulationCorpus(fixturePath);

    expect(report).toMatchObject({
      total: 9,
      passed: 9,
      failed: 0,
      truePositive: 2,
      falsePositive: 0,
      falseNegative: 0,
      precision: 1,
      recall: 1,
      f1: 1,
    });
    expect(new Set(report.cases.flatMap(result => result.tags))).toEqual(new Set([
      'malicious', 'hard-negative', 'prompt-injection', 'rename', 'deletion', 'multi-hunk', 'capped', 'evidence-validation',
      'multi-file', 'supply-chain', 'prose-filter',
    ]));
    expect(report.cases.find(result => result.id === 'multi-hunk-call-cap')?.actualStatus).toMatchObject({
      outcome: 'incomplete', scanned: 0, plannedChunks: 2, attemptedChunks: 1, cappedChunks: 1,
    });
    expect(report.cases.find(result => result.id === 'discarded-provider-evidence')).toMatchObject({
      actualFindings: [], actualConclusion: 'neutral',
      actualStatus: { outcome: 'incomplete', rejectedFindings: 1, reason: 'finding-validation-rejected' },
    });
    expect(report.cases.find(result => result.id === 'prose-does-not-consume-capacity')).toMatchObject({
      actualRequests: ['whole-pr'],
      actualStatus: { outcome: 'complete', selected: 1, scanned: 1, skipped: 5, capped: 0 },
    });
  }, 15_000);

  it('fails a case when request keys mismatch or scripted responses remain', async () => {
    const corpus = await loadSpectreSimulationCorpus(fixturePath);
    const fixture = structuredClone(corpus.cases.find(item => item.id === 'benign-build-command')!);
    fixture.expectedRequests = ['file:not-the-core-request:chunk:1'];
    fixture.scriptedResponses['unused'] = [{ findings: [] }];

    const result = await runSpectreSimulation(fixture, dirname(fixturePath));

    expect(result.passed).toBe(false);
    expect(result.actualRequests).toEqual(['whole-pr']);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('remain unused'),
      expect.stringContaining('request sequence'),
    ]));
  });

  it('supports directory-backed base and head snapshots', async () => {
    const corpus = await loadSpectreSimulationCorpus(fixturePath);
    const fixture = structuredClone(corpus.cases.find(item => item.id === 'benign-build-command')!);
    const root = await mkdtemp(join(tmpdir(), 'layne-spectre-fixture-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'base'));
    await mkdir(join(root, 'head', 'scripts'), { recursive: true });
    await writeFile(
      join(root, 'head', 'scripts', 'build.js'),
      "import { execSync } from 'node:child_process';\nexecSync('npm run build', { stdio: 'inherit' });\n",
      'utf8',
    );
    fixture.base = { directory: 'base' };
    fixture.head = { directory: 'head' };

    await expect(runSpectreSimulation(fixture, root)).resolves.toMatchObject({ passed: true, errors: [] });
  });

  it('accepts AST signal rollout mode in fixture config without changing shadow coverage', async () => {
    const corpus = await loadSpectreSimulationCorpus(fixturePath);
    const fixture = structuredClone(corpus.cases.find(item => item.id === 'benign-build-command')!);
    fixture.config = { ...fixture.config, astSignals: { mode: 'shadow' } };

    await expect(runSpectreSimulation(fixture, dirname(fixturePath))).resolves.toMatchObject({ passed: true, errors: [] });
  });

  it('rejects PR metadata that exceeds the fixture boundary', async () => {
    const corpus = await loadSpectreSimulationCorpus(fixturePath);
    const raw = structuredClone(corpus) as unknown as { cases: Array<{ pullRequest: { body: string } }> };
    raw.cases[0]!.pullRequest.body = 'x'.repeat(4 * 1024 + 1);
    const root = await mkdtemp(join(tmpdir(), 'layne-spectre-schema-'));
    temporaryDirectories.push(root);
    const path = join(root, 'fixtures.json');
    await writeFile(path, JSON.stringify(raw), 'utf8');

    await expect(loadSpectreSimulationCorpus(path)).rejects.toThrow('pullRequest.body exceeds 4096 UTF-8 bytes');
  });
});
