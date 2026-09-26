import { readFile } from 'fs/promises';
import { describe, expect, it } from 'vitest';
import { routeSpectreSignals } from '../spectre-routing.js';
import { analyzeSpectreStructuralSignals, type SpectreStructuralResult } from '../spectre-structural-signals.js';
import type { SpectreSignalInputFile, SpectreSignalKind } from '../spectre-signals.js';
import type { SpectreConfig } from '../types.js';

interface BattleFile {
  file: string;
  content: string;
}

interface BattleExpected {
  lexicalSignals?: SpectreSignalKind[];
  augmentedSignals?: SpectreSignalKind[];
  lexicalCandidateSelected?: boolean;
  augmentedCandidateSelected?: boolean;
  lexicalSignalsByFile?: Record<string, SpectreSignalKind[]>;
  augmentedSignalsByFile?: Record<string, SpectreSignalKind[]>;
  lexicalSelected?: string[];
  augmentedSelected?: string[];
  outcome: 'parsed' | 'parsed-with-errors';
}

interface BattleCase {
  id: string;
  tags: string[];
  file?: string;
  content?: string;
  files?: BattleFile[];
  aliases: string[];
  addedLineNumbers?: number[];
  config?: { fileCap: number; secondaryFileCap: number };
  expected: BattleExpected;
}

interface BattleCorpus {
  version: 1;
  cases: BattleCase[];
}

function replaceIdentifier(source: string, identifier: string, replacement: string): string {
  return source.replace(new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), replacement);
}

function metamorph(files: readonly BattleFile[], aliases: readonly string[], added: readonly number[] | undefined, index: number): {
  files: BattleFile[];
  added?: number[];
} {
  let transformed = files.map(file => ({ ...file }));
  let transformedAdded = added === undefined ? undefined : [...added];
  if (index >= 1 && index <= 6) {
    for (const alias of aliases) {
      transformed = transformed.map(file => ({
        ...file,
        content: replaceIdentifier(file.content, alias, `${alias}_v${index}`),
      }));
    }
  } else if (index === 7) {
    transformed = transformed.map(file => ({ ...file, content: file.content.split('\n').map(line => `${line}  `).join('\n') }));
  } else if (index === 8) {
    transformed = transformed.map(file => ({ ...file, content: `\n${file.content}` }));
    transformedAdded = transformedAdded?.map(line => line + 1);
  } else if (index === 9) {
    transformed = transformed.map(file => ({ ...file, content: file.content.split('\n').join('\n\n') }));
    transformedAdded = transformedAdded?.map(line => line * 2 - 1);
  }
  return transformedAdded === undefined ? { files: transformed } : { files: transformed, added: transformedAdded };
}

function signalMap(context: { files: Array<{ file: string; signals: SpectreSignalKind[] }> }): Record<string, SpectreSignalKind[]> {
  return Object.fromEntries([...context.files]
    .sort((left, right) => left.file.localeCompare(right.file))
    .map(file => [file.file, file.signals]));
}

function config(test: BattleCase): SpectreConfig {
  return {
    enabled: true,
    provider: 'anthropic',
    model: 'test',
    fileCap: test.config?.fileCap ?? 1,
    secondaryFileCap: test.config?.secondaryFileCap ?? 0,
    astSignals: { mode: 'enabled', maxFiles: 100, maxTotalBytes: 2 * 1024 * 1024, timeoutSeconds: 10 },
  };
}

describe('Spectre AST routing battle corpus', () => {
  it('matches exact lexical and augmented routing across at least 500 deterministic variants without a model', async () => {
    const fixtureUrl = new URL('../../fixtures/spectre-ast-routing-corpus.json', import.meta.url);
    const corpus = JSON.parse(await readFile(fixtureUrl, 'utf8')) as BattleCorpus;
    expect(corpus.version).toBe(1);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(60);
    expect(new Set(corpus.cases.map(test => test.id)).size).toBe(corpus.cases.length);
    expect([...new Set(corpus.cases.flatMap(test => test.tags))]).toEqual(expect.arrayContaining([
      'javascript', 'typescript', 'python', 'go', 'import-alias', 'require', 'from-import', 'alias-chain',
      'comments-strings', 'shadowing', 'secret-network', 'encoded-exec', 'changed-lines', 'malformed', 'saturation',
    ]));

    let analyzedVariants = 0;
    for (const test of corpus.cases) {
      const baseFiles = test.files ?? [{ file: test.file!, content: test.content! }];
      for (let variant = 0; variant < 10; variant++) {
        const transformed = metamorph(baseFiles, test.aliases, test.addedLineNumbers, variant);
        const inputs: SpectreSignalInputFile[] = test.files
          ? transformed.files.map(file => ({ file: file.file, content: file.content }))
          : [
              { file: 'src/000-safe.js', content: 'export const safe = true;' },
              {
                file: transformed.files[0]!.file,
                content: transformed.files[0]!.content,
                ...(transformed.added === undefined ? {} : {
                  addedLines: transformed.added.map(line => ({
                    line,
                    content: transformed.files[0]!.content.split('\n')[line - 1] ?? '',
                  })),
                }),
              },
            ];
        let structural: SpectreStructuralResult | undefined;
        const routed = await routeSpectreSignals({
          files: inputs,
          config: config(test),
          analyzer: async (files, options) => {
            structural = await analyzeSpectreStructuralSignals(files, options);
            return structural;
          },
        });
        const label = `${test.id} variant ${variant}`;
        if (test.files) {
          expect(signalMap(routed.lexicalContext), label).toEqual(test.expected.lexicalSignalsByFile);
          expect(signalMap(routed.augmentedContext!), label).toEqual(test.expected.augmentedSignalsByFile);
          expect(routed.lexicalSelection.selected, label).toEqual(test.expected.lexicalSelected);
          expect(routed.augmentedSelection?.selected, label).toEqual(test.expected.augmentedSelected);
          expect(structural?.files.map(file => file.outcome), label).toEqual(
            transformed.files.map(() => test.expected.outcome),
          );
        } else {
          const lexical = routed.lexicalContext.files.find(file => file.file === test.file)!;
          const augmented = routed.augmentedContext!.files.find(file => file.file === test.file)!;
          expect(routed.lexicalContext.files.find(file => file.file === 'src/000-safe.js')?.signals, label).toEqual([]);
          expect(routed.augmentedContext!.files.find(file => file.file === 'src/000-safe.js')?.signals, label).toEqual([]);
          expect(lexical.signals, label).toEqual(test.expected.lexicalSignals);
          expect(augmented.signals, label).toEqual(test.expected.augmentedSignals);
          expect(routed.lexicalSelection.selected, label).toEqual([
            test.expected.lexicalCandidateSelected ? test.file! : 'src/000-safe.js',
          ]);
          expect(routed.augmentedSelection?.selected, label).toEqual([
            test.expected.augmentedCandidateSelected ? test.file! : 'src/000-safe.js',
          ]);
          expect(structural?.files.find(file => file.file === test.file)?.outcome, label).toBe(test.expected.outcome);
        }
        expect(structural?.files.every(file => !('error' in file)), label).toBe(true);
        analyzedVariants++;
      }
    }
    expect(analyzedVariants).toBeGreaterThanOrEqual(500);
  }, 120_000);
});
