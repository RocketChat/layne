/**
 * Shared template helpers used by all notifiers and the PR commenter.
 */

import type { ProcessedFinding, TemplateContext } from '../types.js';
import type { FinalSecurityState, NotificationProjection } from './types.js';

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  high:     '🟠',
  medium:   '🟡',
  low:      '🔵',
  info:     '⚪',
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high:     1,
  medium:   2,
  low:      3,
  info:     4,
};

function buildFindingsTable(
  findings: ProcessedFinding[],
  owner: string,
  repo: string,
  headSha?: string,
): string {
  const header = '| Severity | Scanner | File | Rule | Description |\n|---|---|---|---|---|';
  const sorted = [...findings].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99),
  );
  const rows = sorted.map(f => {
    const emoji   = SEVERITY_EMOJI[f.severity] ?? '⚪';
    const line    = f.startLine ?? f.line;
    const message = f.message.replace(/[\r\n]+/g, ' ').trim().replace(/\|/g, '\\|');
    const ruleId  = (f.ruleId ?? '').replace(/\|/g, '\\|');
    const url     = headSha ? `https://github.com/${owner}/${repo}/blob/${headSha}/${f.file}#L${line}` : null;
    const fileCell = url ? `[\`${f.file}:${line}\`](${url})` : `\`${f.file}:${line}\``;
    return `| ${emoji} ${capitalize(f.severity)} | ${f.tool} | ${fileCell} | ${ruleId} | ${message} |`;
  });
  return [header, ...rows].join('\n');
}

export function buildContext(
  findings: ProcessedFinding[],
  owner: string,
  repo: string,
  prNumber: number,
  headSha?: string,
): TemplateContext {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    if (f.severity in counts) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  const total = findings.length;
  const nonZero = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

  const rules           = [...new Set(findings.map(f => f.ruleId).filter(Boolean))].join(', ');
  const severitySummary = nonZero || 'none';

  return {
    repo:            `${owner}/${repo}`,
    owner,
    repoName:        repo,
    prNumber,
    prUrl:           `https://github.com/${owner}/${repo}/pull/${prNumber}`,
    total,
    ...counts,
    summary:         `Found ${total} issue(s): ${nonZero || 'none'}.`,
    severitySummary,
    findings:        buildFindingsTable(findings, owner, repo, headSha),
    rules,
  } as TemplateContext;
}

export function buildNotificationContext(
  state: FinalSecurityState,
  projection: NotificationProjection,
  owner: string,
  repo: string,
  prNumber: number,
  headSha?: string,
): TemplateContext {
  const ctx = buildContext(state.findings, owner, repo, prNumber, headSha);
  const exceptedIds = new Set(state.exceptionApproval?.findingIds ?? []);
  const blockingTotal = state.findings.filter(finding =>
    (finding.severity === 'critical' || finding.severity === 'high')
    && !exceptedIds.has(finding._findingId ?? '')
  ).length;
  const warningTotal = state.findings.filter(finding =>
    finding.severity === 'medium' || finding.severity === 'low' || finding.severity === 'info'
  ).length;
  const formatCoverage = (level: 'blocking' | 'incomplete') => state.coverageIssues
    .filter(issue => issue.level === level)
    .map(issue => `${issue.source}: ${issue.reason} (${issue.count})`)
    .join(', ');
  const blockingCoverageSummary = projection.events.includes('coverage-failure')
    ? formatCoverage('blocking')
    : '';
  const incompleteCoverageSummary = projection.events.includes('incomplete-scan')
    ? formatCoverage('incomplete')
    : '';
  const coverageSummary = [blockingCoverageSummary, incompleteCoverageSummary].filter(Boolean).join(', ');
  const stateParts: string[] = [];
  if (projection.events.includes('findings') && projection.relevantFindings.length > 0) {
    stateParts.push(`${projection.relevantFindings.length} finding(s) at or above the notification threshold`);
  }
  if (coverageSummary) stateParts.push(`coverage: ${coverageSummary}`);
  if (projection.events.includes('exception-approval') && state.exceptionApproval?.approved) {
    stateParts.push(`exception by @${state.exceptionApproval.approver ?? 'unknown'} for ${(state.exceptionApproval.findingIds ?? []).join(', ')}`);
  }
  if (projection.events.includes('internal-error') && state.internalError) stateParts.push(`internal error ${state.internalError.errorId}`);

  return {
    ...ctx,
    event: projection.primaryEvent ?? '',
    events: projection.events.join(', '),
    conclusion: state.conclusion,
    notificationTotal: projection.relevantFindings.length,
    blockingTotal,
    warningTotal,
    coverageSummary,
    blockingCoverageSummary,
    incompleteCoverageSummary,
    stateSummary: stateParts.join('; '),
    approver: state.exceptionApproval?.approver ?? '',
    approvedFindingIds: (state.exceptionApproval?.findingIds ?? []).join(', '),
    approvalReason: state.exceptionApproval?.reason ?? '',
    errorId: state.internalError?.errorId ?? '',
  };
}

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => (key in ctx ? String(ctx[key]) : `{{${key}}}`));
}
