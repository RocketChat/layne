// Maps internal severity levels to GitHub's annotation_level values.
// GitHub accepts: 'failure' | 'warning' | 'notice'
const SEVERITY_TO_LEVEL = {
  critical: 'failure',
  high:     'failure',
  medium:   'warning',
  low:      'notice',
  info:     'notice',
};

/**
 * Converts raw tool findings into GitHub Check Run annotations
 * and decides the overall scan conclusion.
 *
 * Each finding is expected to have the shape:
 *   { file, line, severity, message, ruleId, tool }
 *
 * Returns: { annotations, conclusion, summary }
 */
export function buildAnnotations(findings) {
  const annotations = findings.map(f => ({
    path:             f.file,
    start_line:       f.line,
    end_line:         f.line,
    annotation_level: SEVERITY_TO_LEVEL[f.severity] ?? 'notice',
    title:            `[${f.tool}] ${f.ruleId}`,
    message:          f.message,
  }));

  // Only critical and high severity findings fail the check.
  // Medium and below surface as warnings without blocking merge.
  const hasBlockingFindings = findings.some(
    f => f.severity === 'critical' || f.severity === 'high'
  );

  const conclusion = hasBlockingFindings ? 'failure' : 'success';

  const summary = findings.length === 0
    ? 'No issues found.'
    : `Found ${findings.length} issue(s): ` +
      `${count(findings, 'critical')} critical, ` +
      `${count(findings, 'high')} high, ` +
      `${count(findings, 'medium')} medium, ` +
      `${count(findings, 'low')} low.`;

  return { annotations, conclusion, summary };
}

function count(findings, severity) {
  return findings.filter(f => f.severity === severity).length;
}
