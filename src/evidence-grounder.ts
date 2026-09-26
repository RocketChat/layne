import type { EvidenceStatus, LineRange } from './types.js';

export interface EvidenceLocation {
  startLine: number;
  endLine: number;
}

export interface EvidenceMatch {
  status: EvidenceStatus;
  location: EvidenceLocation | null;
}

export interface EvidenceLineHint {
  startLine?: number;
  endLine?: number;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function isSpanContainedInRanges(location: EvidenceLocation, ranges: readonly LineRange[]): boolean {
  for (let line = location.startLine; line <= location.endLine; line++) {
    if (!ranges.some(range => line >= range.start && line <= range.end)) return false;
  }
  return true;
}

function hintedMatch(matches: readonly EvidenceLocation[], hint: EvidenceLineHint | undefined): EvidenceLocation | null {
  if (!hint || (hint.startLine === undefined && hint.endLine === undefined)) return null;
  const matching = matches.filter(location =>
    (hint.startLine === undefined || location.startLine === hint.startLine)
    && (hint.endLine === undefined || location.endLine === hint.endLine)
  );
  return matching.length === 1 ? matching[0]! : null;
}

export function locateExactEvidence(
  rawContent: string,
  rawEvidence: string,
  changedRanges?: readonly LineRange[],
  hint?: EvidenceLineHint,
): EvidenceMatch {
  const content = normalizeLineEndings(rawContent);
  const evidence = normalizeLineEndings(rawEvidence);
  if (!evidence.trim()) return { status: 'missing', location: null };

  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  const offsetToLine = (target: number): number => {
    let low = 0;
    let high = lineOffsets.length - 1;
    let answer = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if ((lineOffsets[middle] ?? 0) <= target) {
        answer = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return answer + 1;
  };

  const matches: EvidenceLocation[] = [];
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const matchIndex = content.indexOf(evidence, searchFrom);
    if (matchIndex === -1) break;
    matches.push({
      startLine: offsetToLine(matchIndex),
      endLine: offsetToLine(matchIndex + evidence.length - 1),
    });
    searchFrom = matchIndex + evidence.length;
  }

  const eligible = changedRanges
    ? matches.filter(location => isSpanContainedInRanges(location, changedRanges))
    : matches;
  if (eligible.length === 1) return { status: 'unique', location: eligible[0]! };
  if (eligible.length > 1) {
    const selected = hintedMatch(eligible, hint);
    return selected ? { status: 'unique', location: selected } : { status: 'ambiguous', location: null };
  }

  if (matches.length === 1) return { status: 'unique', location: matches[0]! };
  if (matches.length > 1) {
    const selected = hintedMatch(matches, hint);
    return selected ? { status: 'unique', location: selected } : { status: 'ambiguous', location: null };
  }
  return { status: 'not-found', location: null };
}
