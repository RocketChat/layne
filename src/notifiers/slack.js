/**
 * Slack notifier — posts security findings to a Slack incoming webhook.
 *
 * Conforms to the Layne notifier contract:
 *   export async function notify({ findings, owner, repo, prNumber, toolConfig })
 *
 * Never throws. All errors are caught, logged, and swallowed so a notification
 * failure never affects the scan result or the GitHub Check Run.
 */

const DEFAULT_TEMPLATE =
  '🦴 Good boy Layne dug up {{total}} finding(s) in <{{prUrl}}|{{repo}} #{{prNumber}}>';

function buildContext(findings, owner, repo, prNumber) {
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

function renderTemplate(template, ctx) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in ctx ? ctx[key] : `{{${key}}}`));
}

function resolveUrl(webhookUrl) {
  if (!webhookUrl) return null;

  if (webhookUrl.startsWith('$')) {
    const varName = webhookUrl.slice(1);
    const resolved = process.env[varName];
    if (!resolved) {
      console.warn(`[slack] webhookUrl env var $${varName} is not set — skipping notification`);
      return null;
    }
    return resolved;
  }

  return webhookUrl;
}

export async function notify({ findings, owner, repo, prNumber, toolConfig }) {
  const url = resolveUrl(toolConfig.webhookUrl);
  if (!url) return;

  const ctx  = buildContext(findings, owner, repo, prNumber);
  const text = renderTemplate(toolConfig.template ?? DEFAULT_TEMPLATE, ctx);

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`[slack] notification failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[slack] notification failed: ${err.message}`);
  }
}
