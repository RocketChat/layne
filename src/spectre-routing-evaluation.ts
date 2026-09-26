export interface SpectreRoutingSelectionMetrics {
  relevantSelected: number;
  recall: number;
}

export interface SpectreRoutingSelectionScore {
  relevantFiles: string[];
  lexical: SpectreRoutingSelectionMetrics;
  augmented: SpectreRoutingSelectionMetrics;
  recallDelta: number;
  beneficialPromotions: string[];
  harmfulDisplacements: string[];
  harmfulDisplacementRate: number;
  selectionAdded: string[];
  selectionRemoved: string[];
}

export interface SpectreRoutingAggregateScore {
  cases: number;
  relevantOpportunities: number;
  lexical: SpectreRoutingSelectionMetrics;
  augmented: SpectreRoutingSelectionMetrics;
  recallDelta: number;
  beneficialPromotions: number;
  harmfulDisplacements: number;
  harmfulDisplacementRate: number;
  changedSelections: number;
}

function recall(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function uniqueSorted(files: readonly string[]): string[] {
  return [...new Set(files)].sort();
}

/** Scores routing independently of the model provider and its response quality. */
export function scoreSpectreRoutingSelection(
  relevantInput: readonly string[],
  lexicalInput: readonly string[],
  augmentedInput: readonly string[],
): SpectreRoutingSelectionScore {
  const relevantFiles = uniqueSorted(relevantInput);
  const lexicalFiles = uniqueSorted(lexicalInput);
  const augmentedFiles = uniqueSorted(augmentedInput);
  const lexical = new Set(lexicalFiles);
  const augmented = new Set(augmentedFiles);
  const lexicalRelevant = relevantFiles.filter(file => lexical.has(file));
  const augmentedRelevant = relevantFiles.filter(file => augmented.has(file));
  const beneficialPromotions = relevantFiles.filter(file => !lexical.has(file) && augmented.has(file));
  const harmfulDisplacements = relevantFiles.filter(file => lexical.has(file) && !augmented.has(file));

  return {
    relevantFiles,
    lexical: {
      relevantSelected: lexicalRelevant.length,
      recall: recall(lexicalRelevant.length, relevantFiles.length),
    },
    augmented: {
      relevantSelected: augmentedRelevant.length,
      recall: recall(augmentedRelevant.length, relevantFiles.length),
    },
    recallDelta: recall(augmentedRelevant.length, relevantFiles.length) - recall(lexicalRelevant.length, relevantFiles.length),
    beneficialPromotions,
    harmfulDisplacements,
    harmfulDisplacementRate: rate(harmfulDisplacements.length, lexicalRelevant.length),
    selectionAdded: augmentedFiles.filter(file => !lexical.has(file)),
    selectionRemoved: lexicalFiles.filter(file => !augmented.has(file)),
  };
}

export function aggregateSpectreRoutingScores(scores: readonly SpectreRoutingSelectionScore[]): SpectreRoutingAggregateScore {
  const relevantOpportunities = scores.reduce((total, score) => total + score.relevantFiles.length, 0);
  const lexicalRelevant = scores.reduce((total, score) => total + score.lexical.relevantSelected, 0);
  const augmentedRelevant = scores.reduce((total, score) => total + score.augmented.relevantSelected, 0);
  const beneficialPromotions = scores.reduce((total, score) => total + score.beneficialPromotions.length, 0);
  const harmfulDisplacements = scores.reduce((total, score) => total + score.harmfulDisplacements.length, 0);

  return {
    cases: scores.length,
    relevantOpportunities,
    lexical: { relevantSelected: lexicalRelevant, recall: recall(lexicalRelevant, relevantOpportunities) },
    augmented: { relevantSelected: augmentedRelevant, recall: recall(augmentedRelevant, relevantOpportunities) },
    recallDelta: recall(augmentedRelevant, relevantOpportunities) - recall(lexicalRelevant, relevantOpportunities),
    beneficialPromotions,
    harmfulDisplacements,
    harmfulDisplacementRate: rate(harmfulDisplacements, lexicalRelevant),
    changedSelections: scores.filter(score => score.selectionAdded.length > 0 || score.selectionRemoved.length > 0).length,
  };
}

/** Extracts added HEAD lines from the hunk fragments returned by GitHub's files APIs. */
export function addedLinesFromGitHubPatch(patch: string): Array<{ line: number; content: string }> {
  const added: Array<{ line: number; content: string }> = [];
  let newLine: number | null = null;

  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      newLine = Number(header[1]);
      continue;
    }
    if (newLine === null || line === '\\ No newline at end of file') continue;
    if (line.startsWith('+')) {
      added.push({ line: newLine, content: line.slice(1) });
      newLine++;
    } else if (line.startsWith('-')) {
      continue;
    } else if (line.startsWith(' ')) {
      newLine++;
    } else {
      newLine = null;
    }
  }

  return added;
}
