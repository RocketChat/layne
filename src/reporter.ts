import type { ProcessedFinding, Annotation, AnnotationLevel, ReportResult } from './types.js';

// Maps internal severity levels to GitHub's annotation_level values.
// GitHub accepts: 'failure' | 'warning' | 'notice'
const SEVERITY_TO_LEVEL: Record<string, AnnotationLevel> = {
  critical: 'failure',
  high:     'failure',
  medium:   'warning',
  low:      'notice',
  info:     'notice',
};

/**
 * Converts raw tool findings into GitHub Check Run annotations
 * and decides the overall scan conclusion.
 */
export function buildAnnotations(findings: ProcessedFinding[]): ReportResult {
  const inlineableFindings = findings.filter(f => f.annotationEligible !== false);

  const annotations: Annotation[] = inlineableFindings.map(f => {
    const startLine = f.annotationStartLine ?? f.startLine ?? f.line;
    const endLine = f.annotationEndLine ?? f.annotationStartLine ?? f.endLine ?? f.startLine ?? f.line;

    // Build line range prefix: [R49-R60] or [R49] for single line
    const linePrefix = startLine === endLine
      ? `[R${startLine}] `
      : `[R${startLine}-R${endLine}] `;

    return {
      path:             f.file,
      start_line:       startLine,
      end_line:         endLine,
      annotation_level: SEVERITY_TO_LEVEL[f.severity] ?? 'notice',
      title:            `[${f.tool}] ${f.ruleId}`,
      message:          `${linePrefix}${f.message}`,
    };
  });

  // Only critical and high severity findings fail the check.
  const hasBlockingFindings = findings.some(
    f => f.severity === 'critical' || f.severity === 'high'
  );

  const conclusion: 'success' | 'failure' = hasBlockingFindings ? 'failure' : 'success';

  const summary = findings.length === 0
    ? 'No issues found.'
    : `Found ${findings.length} issue(s): ` +
      `${count(findings, 'critical')} critical, ` +
      `${count(findings, 'high')} high, ` +
      `${count(findings, 'medium')} medium, ` +
      `${count(findings, 'low')} low.` +
      `${inlineableFindings.length === findings.length ? '' : ` ${findings.length - inlineableFindings.length} finding(s) could not be placed inline.`}`;

  return { annotations, conclusion, summary };
}

function count(findings: ProcessedFinding[], severity: string): number {
  return findings.filter(f => f.severity === severity).length;
}
