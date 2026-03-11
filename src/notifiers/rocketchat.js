/**
 * Rocket.Chat notifier — posts security findings to a Rocket.Chat incoming webhook.
 *
 * Conforms to the Layne notifier contract:
 *   export async function notify({ findings, owner, repo, prNumber, toolConfig })
 *
 * Never throws. All errors are caught, logged, and swallowed so a notification
 * failure never affects the scan result or the GitHub Check Run.
 */

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
    total,
    ...counts,
    summary: `Found ${total} issue(s): ${nonZero || 'none'}.`,
  };
}

function renderTemplate(template, ctx) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in ctx ? ctx[key] : `{{${key}}}`));
}

function buildDefaultMessage(findings, ctx) {
  const { repo, prNumber, critical, high, medium, low } = ctx;

  const severityCounts = [
    critical && `${critical} critical`,
    high     && `${high} high`,
    medium   && `${medium} medium`,
    low      && `${low} low`,
  ].filter(Boolean).join(', ');

  // Group findings by tool
  const byTool = {};
  for (const f of findings) {
    if (!byTool[f.tool]) byTool[f.tool] = [];
    byTool[f.tool].push(f);
  }

  const toolSections = Object.entries(byTool)
    .map(([tool, fs]) => {
      const lines = fs.map(
        f => `  • ${f.file}:${f.line} [${f.severity.toUpperCase()}] ${f.ruleId} — ${f.message}`
      );
      return `*${tool}*\n${lines.join('\n')}`;
    })
    .join('\n\n');

  return `:warning: *Security findings in ${repo} PR #${prNumber}*\n• ${severityCounts}\n\n${toolSections}`;
}

function resolveUrl(webhookUrl) {
  if (!webhookUrl) return null;

  if (webhookUrl.startsWith('$')) {
    const varName = webhookUrl.slice(1);
    const resolved = process.env[varName];
    if (!resolved) {
      console.warn(`[rocketchat] webhookUrl env var $${varName} is not set — skipping notification`);
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
  const text = toolConfig.template
    ? renderTemplate(toolConfig.template, ctx)
    : buildDefaultMessage(findings, ctx);

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ alias: 'Security Notifications', text }),
    });
    if (!res.ok) {
      console.error(`[rocketchat] notification failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[rocketchat] notification failed: ${err.message}`);
  }
}
