import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  analyzeSpectreStructuralSignals,
  analyzeSpectreStructuralSignalsIsolated,
  type SpectreStructuralInputFile,
} from '../spectre-structural-signals.js';

function dataWorker(source: string): URL {
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

describe('Spectre structural parser and worker stress', () => {
  it('bounds a large mixed batch deterministically by sorted path and file count', async () => {
    const files: SpectreStructuralInputFile[] = Array.from({ length: 100 }, (_, index) => ({
      file: `src/file-${String(99 - index).padStart(3, '0')}.ts`,
      content: `export const value${index} = ${index};`,
    }));

    const result = await analyzeSpectreStructuralSignals(files, {
      limits: { maxFiles: 25, maxTotalMs: 10_000 },
    });

    expect(result.files).toHaveLength(100);
    expect(result.files.slice(0, 25).every(file => file.outcome === 'parsed')).toBe(true);
    expect(result.files.slice(25).every(file => file.outcome === 'file-limit')).toBe(true);
    expect(result.files.map(file => file.file)).toEqual([...result.files.map(file => file.file)].sort());
    expect(result).toMatchObject({ budgetExceeded: true, cancelled: false });
  });

  it('stops pathological traversal and total-byte pressure with bounded outcomes', async () => {
    const deeplyNested = `const value = ${'('.repeat(400)}input${')'.repeat(400)};`;
    const traversal = await analyzeSpectreStructuralSignals([{ file: 'deep.ts', content: deeplyNested }], {
      limits: { maxNodesPerFile: 16, maxParseMsPerFile: 1_000, maxTotalMs: 1_000 },
    });
    expect(traversal.files[0]).toMatchObject({ outcome: 'budget-exceeded', budgetExceeded: true });

    const bytes = await analyzeSpectreStructuralSignals([
      { file: 'a.ts', content: 'x'.repeat(60) },
      { file: 'b.ts', content: 'x'.repeat(60) },
      { file: 'c.ts', content: 'x'.repeat(60) },
    ], { limits: { maxFileBytes: 100, maxTotalBytes: 100 } });
    expect(bytes.files.map(file => file.outcome)).toEqual(['parsed', 'byte-limit', 'byte-limit']);
    expect(bytes.bytes).toBe(60);
  });

  it('terminates a non-responsive worker at the wall-clock deadline', async () => {
    const started = performance.now();
    await expect(analyzeSpectreStructuralSignalsIsolated(
      [{ file: 'hang.ts', content: 'export const value = 1;' }],
      { workerUrl: dataWorker('while (true) {}'), timeoutMs: 30 },
    )).rejects.toThrow('structural-worker-timeout');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('normalizes worker crashes without exposing worker diagnostics', async () => {
    await expect(analyzeSpectreStructuralSignalsIsolated(
      [{ file: 'crash.ts', content: 'export const value = 1;' }],
      { workerUrl: dataWorker("throw new Error('sensitive worker detail')"), timeoutMs: 1_000 },
    )).rejects.toThrow('structural-worker-failed');
  });

  it('cancels and terminates an in-flight worker promptly', async () => {
    const controller = new AbortController();
    const pending = analyzeSpectreStructuralSignalsIsolated(
      [{ file: 'cancel.ts', content: 'export const value = 1;' }],
      { workerUrl: dataWorker('while (true) {}'), timeoutMs: 5_000, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
