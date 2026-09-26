import { readFile } from 'fs/promises';
import { describe, expect, it } from 'vitest';
import { routeSpectreSignals } from '../spectre-routing.js';
import { analyzeSpectreStructuralSignals } from '../spectre-structural-signals.js';
import type { SpectreConfig } from '../types.js';

interface SemanticCase {
  id: string;
  tags: string[];
  file?: string;
  content?: string;
  files?: Array<{ file: string; content: string }>;
  expectedRuleIds: string[];
  expectedFindings: Array<{ file: string; ruleId: string }>;
  routing?: { fileCap?: number; secondaryFileCap?: number };
}

describe('expanded Spectre AST semantic corpus', () => {
  it('is paired, inert, file-attributed, and leaves the baseline corpus separate', async () => {
    const [expandedRaw, baselineRaw] = await Promise.all([
      readFile(new URL('../../fixtures/spectre-ast-corpus.json', import.meta.url), 'utf8'),
      readFile(new URL('../../fixtures/spectre-corpus.json', import.meta.url), 'utf8'),
    ]);
    const expanded = JSON.parse(expandedRaw) as SemanticCase[];
    const baseline = JSON.parse(baselineRaw) as SemanticCase[];
    expect(expanded.length).toBeGreaterThanOrEqual(45);
    expect(expanded.length).toBeLessThanOrEqual(60);
    expect(baseline).toHaveLength(33);
    expect(new Set(expanded.map(test => test.id)).size).toBe(expanded.length);

    const pairs = new Map<string, SemanticCase[]>();
    for (const test of expanded) {
      const supplied = test.files ?? [{ file: test.file!, content: test.content! }];
      expect(supplied.length).toBeGreaterThan(0);
      expect(supplied.every(file => typeof file.content === 'string')).toBe(true);
      const allowed = new Set(supplied.map(file => file.file));
      expect(test.expectedFindings.every(finding => allowed.has(finding.file))).toBe(true);
      expect([...new Set(test.expectedFindings.map(finding => finding.ruleId))].sort()).toEqual([...new Set(test.expectedRuleIds)].sort());
      expect(test.tags).toEqual(expect.arrayContaining([expect.stringMatching(/^pair-(?:js|py|go)-\d{2}$/)]));
      const pair = test.tags.find(tag => tag.startsWith('pair-'))!;
      pairs.set(pair, [...(pairs.get(pair) ?? []), test]);
    }
    expect(pairs.size).toBe(24);
    for (const cases of pairs.values()) {
      expect(cases).toHaveLength(2);
      expect(cases.some(test => test.tags.includes('malicious'))).toBe(true);
      expect(cases.some(test => test.tags.includes('benign'))).toBe(true);
    }
    expect(expanded.filter(test => test.tags.includes('javascript'))).toHaveLength(16);
    expect(expanded.filter(test => test.tags.includes('python'))).toHaveLength(16);
    expect(expanded.filter(test => test.tags.includes('go'))).toHaveLength(16);
  });

  it('includes paired saturation cases that force an AST routing delta', async () => {
    const raw = await readFile(new URL('../../fixtures/spectre-ast-saturation-corpus.json', import.meta.url), 'utf8');
    const corpus = JSON.parse(raw) as SemanticCase[];

    expect(corpus).toHaveLength(6);
    expect(corpus.filter(test => test.tags.includes('malicious'))).toHaveLength(3);
    expect(corpus.filter(test => test.tags.includes('benign'))).toHaveLength(3);
    for (const test of corpus) {
      expect(test.files).toHaveLength(2);
      expect(test.routing).toEqual({ fileCap: 1, secondaryFileCap: 0 });
      expect(test.tags).toContain('ast-saturation');
      expect(test.expectedFindings.every(finding => test.files?.some(file => file.file === finding.file))).toBe(true);
      const files = test.files!.map(file => ({
        ...file,
        addedLines: file.content.trimEnd().split('\n').map((content, index) => ({ line: index + 1, content })),
      }));
      const config: SpectreConfig = {
        enabled: true,
        provider: 'anthropic',
        model: 'test',
        fileCap: 1,
        secondaryFileCap: 0,
        astSignals: { mode: 'enabled', maxFiles: 100, maxTotalBytes: 2 * 1024 * 1024, timeoutSeconds: 10 },
      };
      const routed = await routeSpectreSignals({
        files,
        config,
        analyzer: analyzeSpectreStructuralSignals,
      });
      expect(routed.lexicalSelection.selected, test.id).toEqual([test.files![0]!.file]);
      expect(routed.augmentedSelection?.selected, test.id).toEqual([test.files![1]!.file]);
      expect(routed.diagnostics.selectionDelta, test.id).toMatchObject({ selectedAddedCount: 1, selectedRemovedCount: 1 });
    }
  });
});
