import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ProcessedFinding, EvidenceStatus, AnchorKind } from './types.js';

const DECLARATION_SCAN_LIMIT = 20;

const DECLARATION_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/,
  /^\s*(?:export\s+default\s+)?class\b/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:async\s+)?def\b/,
  /^\s*class\b/,
  /^\s*func\b/,
  /^\s*fn\b/,
  /^\s*(?:def|class|module)\b/,
  /^\s*(?:public|private|protected|internal|static|final|abstract|sealed|virtual|override|async)\b.*\([^;]*\)\s*(?:\{|:)/,
  /^\s*(?!if\b|for\b|while\b|switch\b|catch\b|with\b|return\b|else\b|elseif\b|elif\b|try\b|finally\b|do\b)(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^;]*\)\s*\{/,
];

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
  const fallback: AnnotationLocation = {
    startLine: evidenceLocation.startLine,
    endLine: evidenceLocation.endLine,
    anchorKind: evidenceLocation.startLine === evidenceLocation.endLine ? 'line' : 'span',
    anchorLine: evidenceLocation.startLine,
    reason: 'anchored-by-evidence',
  };

  if (finding.anchorKind === 'declaration') {
    const declarationLine = validateDeclarationAnchor(info.lines, finding.anchorLine, evidenceLocation.startLine);
    if (declarationLine !== null) {
      return {
        startLine: declarationLine,
        endLine: declarationLine,
        anchorKind: 'declaration',
        anchorLine: declarationLine,
        reason: 'anchored-by-validated-declaration',
      };
    }
  }

  if (finding.tool === 'pi_agent' && finding.anchorKind === null) {
    const nearestDecl = findNearestDeclarationLine(info.lines, evidenceLocation.startLine);
    if (nearestDecl !== null && (evidenceLocation.startLine - nearestDecl) <= DECLARATION_SCAN_LIMIT) {
      return {
        startLine: nearestDecl,
        endLine: nearestDecl,
        anchorKind: 'declaration',
        anchorLine: nearestDecl,
        reason: 'anchored-by-auto-declaration',
      };
    }
  }

  return fallback;
}

function validateDeclarationAnchor(lines: string[], anchorLine: number | undefined, evidenceStartLine: number): number | null {
  const normalizedAnchorLine = normalizePositiveInt(anchorLine);
  if (normalizedAnchorLine === null) return null;
  if (normalizedAnchorLine > evidenceStartLine) return null;
  if (normalizedAnchorLine > lines.length) return null;

  const line = lines[normalizedAnchorLine - 1] ?? '';
  if (!looksLikeDeclaration(line)) return null;

  const nearestDeclarationLine = findNearestDeclarationLine(lines, evidenceStartLine);
  return nearestDeclarationLine === normalizedAnchorLine ? normalizedAnchorLine : null;
}

function findNearestDeclarationLine(lines: string[], startLine: number): number | null {
  for (let lineNumber = startLine; lineNumber >= 1; lineNumber--) {
    if (looksLikeDeclaration(lines[lineNumber - 1] ?? '')) return lineNumber;
  }
  return null;
}

function looksLikeDeclaration(line: string): boolean {
  return DECLARATION_PATTERNS.some(pattern => pattern.test(line));
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

function normalizePositiveInt(value: number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
