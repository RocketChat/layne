/**
 * Shared template helpers used by all notifiers and the PR commenter.
 */

import type { ProcessedFinding, TemplateContext } from '../types.js';

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
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
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

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => (key in ctx ? String(ctx[key]) : `{{${key}}}`));
}
