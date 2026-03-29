/**
 * Shared template helpers used by all notifiers and the PR commenter.
 */

import type { ProcessedFinding, TemplateContext } from '../types.js';

export function buildContext(
  findings: ProcessedFinding[],
  owner: string,
  repo: string,
  prNumber: number,
): TemplateContext {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f.severity in counts) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  const total = findings.length;
  const nonZero = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

  const rules = [...new Set(findings.map(f => f.ruleId).filter(Boolean))].join(', ');

  return {
    repo:     `${owner}/${repo}`,
    owner,
    repoName: repo,
    prNumber,
    prUrl:    `https://github.com/${owner}/${repo}/pull/${prNumber}`,
    total,
    ...counts,
    summary: `Found ${total} issue(s): ${nonZero || 'none'}.`,
    rules,
  } as TemplateContext;
}

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => (key in ctx ? String(ctx[key]) : `{{${key}}}`));
}
