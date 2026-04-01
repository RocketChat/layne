import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ProcessedFinding, EvidenceStatus, AnchorKind } from './types.js';



interface FileInfo {
  content: string;
  lines: string[];
  lineOffsets: number[];
}

interface EvidenceLocation {
  startLine: number;
  endLine: number;
}

interface EvidenceMatch {
  status: EvidenceStatus;
  location: EvidenceLocation | null;
}

export async function validateFindingLocations(
  findings: ProcessedFinding[],
  { workspacePath, changedFiles = [] }: { workspacePath: string; changedFiles?: string[] },
): Promise<ProcessedFinding[]> {
  if (!findings.length) return [];

  const changedFileSet = new Set(changedFiles);
  const fileCache = new Map<string, FileInfo | null>();

  async function getFileInfo(file: string): Promise<FileInfo | null> {
    if (fileCache.has(file)) return fileCache.get(file)!;

    let info: FileInfo | null = null;
    try {
      const content = await readFile(join(workspacePath, file), 'utf8');
      const lines = content.split('\n');
      const lineOffsets: number[] = [];
      let offset = 0;

      for (const line of lines) {
        lineOffsets.push(offset);
        offset += line.length + 1;
      }

      info = { content, lines, lineOffsets };
    } catch {
      // leave as null
    }

    fileCache.set(file, info);
    return info;
  }

  const validated: ProcessedFinding[] = [];

  for (const finding of findings) {
    if (finding.tool !== 'claude' && finding.tool !== 'pi_agent') {
      const startLine = finding.startLine ?? finding.line;
      const endLine = finding.endLine ?? finding.line;
      validated.push({
        ...finding,
        startLine,
        endLine,
        suppressionLine: startLine,
        locationValidated: true,
        annotationEligible: finding.annotationEligible ?? true,
        locationReason: 'validated-non-claude',
        annotationReason: finding.annotationEligible === false ? 'non-inlineable' : 'anchored',
      });
      continue;
    }

    const next: ProcessedFinding = {
      ...finding,
      evidence: typeof finding.evidence === 'string' ? finding.evidence.trim() : '',
      evidenceStatus: 'missing',
      locationValidated: false,
      annotationEligible: false,
      locationReason: 'unvalidated',
      annotationReason: 'not-evaluated',
    };

    if (!changedFileSet.has(next.file)) {
      next.locationReason = 'file-not-in-diff';
      next.annotationReason = 'file-not-in-diff';
      validated.push(next);
      continue;
    }

    const info = await getFileInfo(next.file);
    if (!info) {
      next.locationReason = 'file-unreadable';
      next.annotationReason = 'file-unreadable';
      validated.push(next);
      continue;
    }

    const evidenceMatch = inspectEvidence(info, next.evidence ?? '');
    next.evidenceStatus = evidenceMatch.status;

    if (!evidenceMatch.location) {
      next.locationReason = failureReasonForEvidenceStatus(evidenceMatch.status);
      next.annotationReason = next.locationReason;
      validated.push(next);
      continue;
    }

    applyEvidenceLocation(next, evidenceMatch.location);
    const annotationLocation = resolveAnnotationLocation(next, info, evidenceMatch.location);
    next.locationValidated = true;
    next.locationReason = 'validated-by-evidence';
    next.startLine = annotationLocation.startLine;
    next.endLine = annotationLocation.endLine;
    next.line = annotationLocation.startLine;
    next.anchorKind = annotationLocation.anchorKind;
    next.anchorLine = annotationLocation.anchorLine;
    next.suppressionLine = annotationLocation.startLine;
    next.annotationStartLine = annotationLocation.startLine;
    next.annotationEndLine = annotationLocation.endLine;
    next.annotationEligible = true;
    next.annotationReason = annotationLocation.reason;

    validated.push(next);
  }

  return validated;
}

function failureReasonForEvidenceStatus(status: EvidenceStatus): string {
  if (status === 'missing') return 'missing-evidence';
  if (status === 'ambiguous') return 'ambiguous-evidence';
  return 'evidence-not-found';
}

function normalizeForMatch(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

// Minimal declaration patterns for Claude anchor validation
const DECLARATION_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/,
  /^\s*(?:export\s+default\s+)?class\b/,
  /^\s*(?:async\s+)?def\b/,
  /^\s*class\b/,
];

function looksLikeDeclaration(line: string): boolean {
  return DECLARATION_PATTERNS.some(pattern => pattern.test(line));
}

interface AnnotationLocation {
  startLine: number;
  endLine: number;
  anchorKind: AnchorKind;
  anchorLine: number;
  reason: string;
}

function resolveAnnotationLocation(
  finding: ProcessedFinding,
  info: FileInfo,
  evidenceLocation: EvidenceLocation,
): AnnotationLocation {
  // Pi Agent: Always use evidence location only (Option 1 - strict evidence-only positioning)
  if (finding.tool === 'pi_agent') {
    return {
      startLine: evidenceLocation.startLine,
      endLine: evidenceLocation.endLine,
      anchorKind: evidenceLocation.startLine === evidenceLocation.endLine ? 'line' : 'span',
      anchorLine: evidenceLocation.startLine,
      reason: 'anchored-by-evidence',
    };
  }

  // Claude: Use declaration anchoring if provided and valid
  if (finding.anchorKind === 'declaration') {
    const declarationLine = finding.anchorLine;
    if (typeof declarationLine === 'number' && declarationLine > 0 && declarationLine <= evidenceLocation.startLine) {
      // Validate that the line actually looks like a declaration
      const line = info.lines[declarationLine - 1] ?? '';
      if (looksLikeDeclaration(line)) {
        return {
          startLine: declarationLine,
          endLine: Math.max(declarationLine, evidenceLocation.endLine),
          anchorKind: 'declaration',
          anchorLine: declarationLine,
          reason: 'anchored-by-validated-declaration',
        };
      }
    }
  }

  // Default: Use evidence location
  return {
    startLine: evidenceLocation.startLine,
    endLine: evidenceLocation.endLine,
    anchorKind: evidenceLocation.startLine === evidenceLocation.endLine ? 'line' : 'span',
    anchorLine: evidenceLocation.startLine,
    reason: 'anchored-by-evidence',
  };
}

function inspectEvidence(info: FileInfo, evidence: string): EvidenceMatch {
  const needle = normalizeForMatch(evidence);
  if (!needle) {
    return { status: 'missing', location: null };
  }

  const matches: EvidenceLocation[] = [];
  let index = 0;

  while (index < info.content.length) {
    const matchIndex = info.content.indexOf(needle, index);
    if (matchIndex === -1) break;

    matches.push(offsetsToSpan(info.lineOffsets, matchIndex, matchIndex + needle.length - 1));
    index = matchIndex + needle.length;
  }

  if (matches.length === 1) {
    return { status: 'unique', location: matches[0]! };
  }

  if (matches.length > 1) {
    return { status: 'ambiguous', location: null };
  }

  return { status: 'not-found', location: null };
}

function offsetsToSpan(lineOffsets: number[], startOffset: number, endOffset: number): EvidenceLocation {
  return {
    startLine: offsetToLine(lineOffsets, startOffset),
    endLine: offsetToLine(lineOffsets, endOffset),
  };
}

function offsetToLine(lineOffsets: number[], offset: number): number {
  let low = 0;
  let high = lineOffsets.length - 1;
  let answer = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if ((lineOffsets[mid] ?? 0) <= offset) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return answer + 1;
}

function applyEvidenceLocation(finding: ProcessedFinding, relocated: EvidenceLocation): void {
  finding.evidenceStartLine = relocated.startLine;
  finding.evidenceEndLine = relocated.endLine;
}
