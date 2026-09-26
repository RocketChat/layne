import { describe, expect, it, vi } from 'vitest';
import { routeSpectreSignals, type SpectreStructuralAnalyzer } from '../spectre-routing.js';
import { extractSpectreSignals, selectSpectreFiles, type SpectreSignalInputFile } from '../spectre-signals.js';
import type { SpectreStructuralFact, SpectreStructuralResult } from '../spectre-structural-signals.js';
import type { SpectreConfig } from '../types.js';

function config(mode: 'off' | 'shadow' | 'enabled', overrides: Partial<SpectreConfig> = {}): SpectreConfig {
  return {
    enabled: true,
    provider: 'anthropic',
    model: 'test',
    fileCap: 1,
    secondaryFileCap: 0,
    astSignals: { mode, maxFiles: 100, maxTotalBytes: 2 * 1024 * 1024, timeoutSeconds: 3 },
    ...overrides,
  };
}

function structural(files: readonly SpectreSignalInputFile[], facts: SpectreStructuralFact[]): SpectreStructuralResult {
  return {
    files: files.map(file => ({
      file: file.file,
      language: 'javascript',
      outcome: 'parsed',
      facts: facts.filter(fact => fact.file === file.file),
      bytes: Buffer.byteLength(file.content ?? '', 'utf8'),
      elapsedMs: 1,
      nodesVisited: 1,
      budgetExceeded: false,
      factsTruncated: false,
    })),
    facts,
    bytes: files.reduce((total, file) => total + Buffer.byteLength(file.content ?? '', 'utf8'), 0),
    elapsedMs: 1,
    nodesVisited: files.length,
    budgetExceeded: false,
    cancelled: false,
  };
}

describe('Spectre structural routing', () => {
  it('preserves exact legacy routing and selection when mode is off', async () => {
    const files = [
      { file: 'src/a.js', content: 'fetch(url);' },
      { file: 'src/b.js', content: 'const value = 1;' },
    ];
    const analyzer = vi.fn<SpectreStructuralAnalyzer>();
    const legacyContext = extractSpectreSignals(files);
    const legacySelection = selectSpectreFiles(legacyContext, 1, 0);

    const routed = await routeSpectreSignals({ files, config: config('off'), analyzer });

    expect(routed.context).toEqual(legacyContext);
    expect(routed.selection).toEqual(legacySelection);
    expect(routed.diagnostics).toMatchObject({ mode: 'off', outcome: 'off' });
    expect(analyzer).not.toHaveBeenCalled();
  });

  it('reports bounded shadow diagnostics without changing active routing or coverage', async () => {
    const files = [
      { file: 'src/safe.js', content: 'const value = 1;', addedLines: [{ line: 1, content: 'const value = 1;' }] },
      { file: 'src/alias.js', content: "import axios from 'axios';\nconst send = axios.post;\nsend(url);", addedLines: [{ line: 3, content: 'send(url);' }] },
    ];
    const fact: SpectreStructuralFact = {
      file: 'src/alias.js', kind: 'network-access', startLine: 3, endLine: 3, intersectsAddedLine: true,
    };
    const analyzer: SpectreStructuralAnalyzer = async () => structural(files, [fact]);

    const routed = await routeSpectreSignals({ files, config: config('shadow'), analyzer });

    expect(routed.context).toBe(routed.lexicalContext);
    expect(routed.selection).toBe(routed.lexicalSelection);
    expect(routed.selection.selected).toEqual(['src/safe.js']);
    expect(routed.augmentedSelection?.selected).toEqual(['src/alias.js']);
    expect(routed.diagnostics).toMatchObject({
      mode: 'shadow', outcome: 'complete', files: 2, facts: 1,
      selectionDelta: { selectedAddedCount: 1, selectedRemovedCount: 1 },
    });
  });

  it('promotes structurally resolved aliases in enabled mode', async () => {
    const files = [
      { file: 'src/safe.js', content: 'const value = 1;', addedLines: [{ line: 1, content: 'const value = 1;' }] },
      { file: 'src/alias.js', content: "import axios from 'axios';\nconst send = axios.post;\nsend(url);", addedLines: [{ line: 3, content: 'send(url);' }] },
    ];
    const facts: SpectreStructuralFact[] = [{
      file: 'src/alias.js', kind: 'network-access', startLine: 3, endLine: 3, intersectsAddedLine: true,
    }];

    const routed = await routeSpectreSignals({
      files,
      config: config('enabled'),
      analyzer: async () => structural(files, facts),
    });

    expect(routed.selection.selected).toEqual(['src/alias.js']);
    expect(routed.context.files[0]).toMatchObject({ signals: ['network-access'], priorityLines: [3], score: 3 });
  });

  it('does not score a signal twice or admit unchanged primitive facts', async () => {
    const files = [{
      file: 'src/run.js',
      content: "const cp = require('child_process');\ncp.exec(command);",
      addedLines: [{ line: 2, content: 'cp.exec(command);' }],
    }];
    const facts: SpectreStructuralFact[] = [
      { file: 'src/run.js', kind: 'process-execution', startLine: 2, endLine: 2, intersectsAddedLine: true },
      { file: 'src/run.js', kind: 'secret-access', startLine: 1, endLine: 1, intersectsAddedLine: false },
    ];
    const lexical = extractSpectreSignals(files).files[0]!;

    const routed = await routeSpectreSignals({
      files,
      config: config('enabled'),
      analyzer: async () => structural(files, facts),
    });

    expect(routed.context.files[0]?.score).toBe(lexical.score);
    expect(routed.context.files[0]?.signals).toEqual(lexical.signals);
  });

  it('falls back to lexical routing when the analyzer fails', async () => {
    const files = [{ file: 'src/a.js', content: 'fetch(url);' }];
    const routed = await routeSpectreSignals({
      files,
      config: config('enabled'),
      analyzer: async () => { throw new Error('parser internals'); },
    });

    expect(routed.context).toBe(routed.lexicalContext);
    expect(routed.selection).toBe(routed.lexicalSelection);
    expect(routed.diagnostics).toMatchObject({ outcome: 'failed', fallbackReason: 'analyzer-failed' });
  });

  it('propagates parent cancellation instead of falling back', async () => {
    const controller = new AbortController();
    const analyzer: SpectreStructuralAnalyzer = async (_files, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const pending = routeSpectreSignals({
      files: [{ file: 'src/a.js', content: 'fetch(url);' }],
      config: config('enabled'),
      signal: controller.signal,
      analyzer,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
