import { readFile } from 'fs/promises';
import { join } from 'path';
import { isSpanContainedInRanges, locateExactEvidence, type EvidenceLocation } from './evidence-grounder.js';
import type { AdapterStatuses, ProcessedFinding, EvidenceStatus, AnchorKind, LineRangesByFile, LineRange, SpectreScanStatus, Tool } from './types.js';



interface FileInfo {
  content: string;
  lines: string[];
}

export async function validateFindingLocations(
  findings: ProcessedFinding[],
  { workspacePath, changedFiles = [], changedLineRanges, signal }: { workspacePath: string; changedFiles?: string[]; changedLineRanges?: LineRangesByFile | Record<string, LineRange[]>; signal?: AbortSignal },
): Promise<ProcessedFinding[]> {
  signal?.throwIfAborted();
  if (!findings.length) return [];

  const changedFileSet = new Set(changedFiles);
  const fileCache = new Map<string, FileInfo | null>();

  async function getFileInfo(file: string): Promise<FileInfo | null> {
    if (fileCache.has(file)) return fileCache.get(file)!;

    let info: FileInfo | null = null;
    try {
      const content = normalizeLineEndings(await readFile(join(workspacePath, file), 'utf8'));
      signal?.throwIfAborted();
      const lines = content.split('\n');
      info = { content, lines };
    } catch {
      signal?.throwIfAborted();
      // leave as null
    }

    fileCache.set(file, info);
    return info;
  }

  const validated: ProcessedFinding[] = [];

  for (const finding of findings) {
    signal?.throwIfAborted();
    if (finding.tool !== 'claude' && finding.tool !== 'spectre') {
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
      evidence: typeof finding.evidence === 'string' ? finding.evidence : '',
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

    const changedRanges = next.tool === 'spectre' && changedLineRanges
      ? getChangedRanges(next.file, changedLineRanges)
      : undefined;
    const evidenceMatch = locateExactEvidence(
      info.content,
      next.evidence ?? '',
      changedRanges,
      next.tool === 'spectre'
        ? { startLine: next.reportedStartLine, endLine: next.reportedEndLine }
        : undefined,
    );
    next.evidenceStatus = evidenceMatch.status;

    if (!evidenceMatch.location) {
      next.locationReason = failureReasonForEvidenceStatus(evidenceMatch.status);
      next.annotationReason = next.locationReason;
      validated.push(next);
      continue;
    }

    applyEvidenceLocation(next, evidenceMatch.location);
    if (next.tool === 'spectre' && changedLineRanges && !isSpanContainedInRanges(evidenceMatch.location, changedRanges ?? [])) {
      next.locationReason = 'evidence-outside-changed-range';
      next.annotationReason = 'evidence-outside-changed-range';
      validated.push(next);
      continue;
    }
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

export function applyAdapterValidationCoverage(statuses: AdapterStatuses, findings: ProcessedFinding[]): number {
  let rejectedTotal = 0;
  for (const tool of ['claude', 'spectre'] satisfies Tool[]) {
    const status = statuses[tool];
    if (status.outcome === 'disabled') continue;
    const rejected = findings.filter(finding => finding.tool === tool && finding.locationValidated !== true).length;
    if (rejected === 0) continue;
    if (tool === 'spectre') {
      statuses.spectre.rejectedFindings = (statuses.spectre.rejectedFindings ?? 0) + rejected;
    }
    status.outcome = 'incomplete';
    status.reason ??= 'finding-validation-rejected';
    rejectedTotal += rejected;
  }
  return rejectedTotal;
}

/** Spectre simulations operate outside the dispatcher and only have one status. */
export function applySpectreValidationCoverage(status: SpectreScanStatus | undefined, findings: ProcessedFinding[]): number {
  if (!status || status.outcome === 'disabled') return 0;
  const rejected = findings.filter(finding => finding.tool === 'spectre' && finding.locationValidated !== true).length;
  if (rejected === 0) return 0;
  status.rejectedFindings = (status.rejectedFindings ?? 0) + rejected;
  status.outcome = 'incomplete';
  status.reason ??= 'finding-validation-rejected';
  return rejected;
}

function getChangedRanges(
  file: string,
  rangesByFile: LineRangesByFile | Record<string, LineRange[]>,
): LineRange[] {
  return (rangesByFile instanceof Map ? rangesByFile.get(file) : rangesByFile[file]) ?? [];
}

function failureReasonForEvidenceStatus(status: EvidenceStatus): string {
  if (status === 'missing') return 'missing-evidence';
  if (status === 'ambiguous') return 'ambiguous-evidence';
  return 'evidence-not-found';
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
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
  // Spectre: Always use evidence location only (strict evidence-only positioning)
  if (finding.tool === 'spectre') {
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

function applyEvidenceLocation(finding: ProcessedFinding, relocated: EvidenceLocation): void {
  finding.evidenceStartLine = relocated.startLine;
  finding.evidenceEndLine = relocated.endLine;
}
