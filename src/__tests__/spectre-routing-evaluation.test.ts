import { describe, expect, it } from 'vitest';
import {
  addedLinesFromGitHubPatch,
  aggregateSpectreRoutingScores,
  scoreSpectreRoutingSelection,
} from '../spectre-routing-evaluation.js';

describe('provider-independent Spectre routing evaluation', () => {
  it('separates beneficial promotions from harmful displacement', () => {
    const score = scoreSpectreRoutingSelection(
      ['src/auth.ts', 'src/network.ts', 'src/parser.ts'],
      ['src/auth.ts', 'src/parser.ts', 'test/noise.ts'],
      ['src/auth.ts', 'src/network.ts', 'test/noise.ts'],
    );

    expect(score).toMatchObject({
      lexical: { relevantSelected: 2, recall: 2 / 3 },
      augmented: { relevantSelected: 2, recall: 2 / 3 },
      recallDelta: 0,
      beneficialPromotions: ['src/network.ts'],
      harmfulDisplacements: ['src/parser.ts'],
      harmfulDisplacementRate: 0.5,
      selectionAdded: ['src/network.ts'],
      selectionRemoved: ['src/parser.ts'],
    });
  });

  it('aggregates routing opportunities without depending on provider findings', () => {
    const scores = [
      scoreSpectreRoutingSelection(['a.ts', 'b.ts'], ['a.ts'], ['a.ts', 'b.ts']),
      scoreSpectreRoutingSelection(['c.ts'], ['c.ts'], []),
    ];

    expect(aggregateSpectreRoutingScores(scores)).toEqual({
      cases: 2,
      relevantOpportunities: 3,
      lexical: { relevantSelected: 2, recall: 2 / 3 },
      augmented: { relevantSelected: 2, recall: 2 / 3 },
      recallDelta: 0,
      beneficialPromotions: 1,
      harmfulDisplacements: 1,
      harmfulDisplacementRate: 0.5,
      changedSelections: 2,
    });
  });

  it('reports zero displacement when lexical routing selected no relevant files', () => {
    const score = scoreSpectreRoutingSelection(['relevant.ts'], ['noise.ts'], ['noise.ts']);

    expect(score.harmfulDisplacements).toEqual([]);
    expect(score.harmfulDisplacementRate).toBe(0);
  });

  it('parses added HEAD coordinates from GitHub patch fragments', () => {
    const patch = [
      '@@ -10,3 +10,4 @@ function run() {',
      ' unchanged();',
      '-oldCall();',
      '+firstCall();',
      '+secondCall();',
      ' finish();',
      '@@ -30 +31,2 @@ function next() {',
      '+before();',
      ' existing();',
      '\\ No newline at end of file',
    ].join('\n');

    expect(addedLinesFromGitHubPatch(patch)).toEqual([
      { line: 11, content: 'firstCall();' },
      { line: 12, content: 'secondCall();' },
      { line: 31, content: 'before();' },
    ]);
  });
});
