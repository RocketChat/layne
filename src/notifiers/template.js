/**
 * Shared template helpers used by all notifiers and the PR commenter.
 */

export function buildContext(findings, owner, repo, prNumber) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f.severity in counts) counts[f.severity]++;
  }
  const total = findings.length;
  const nonZero = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

  return {
    repo:     `${owner}/${repo}`,
    owner,
    repoName: repo,
    prNumber,
    prUrl:    `https://github.com/${owner}/${repo}/pull/${prNumber}`,
    total,
    ...counts,
    summary: `Found ${total} issue(s): ${nonZero || 'none'}.`,
  };
}

export function renderTemplate(template, ctx) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in ctx ? ctx[key] : `{{${key}}}`));
}
