/**
 * Rocket.Chat notifier — posts security findings to a Rocket.Chat incoming webhook.
 *
 * Conforms to the Layne notifier contract:
 *   export async function notify({ findings, owner, repo, prNumber, toolConfig, exceptionApproval })
 *
 * Never throws. All errors are caught, logged, and swallowed so a notification
 * failure never affects the scan result or the GitHub Check Run.
 */

import { buildNotificationContext, renderTemplate } from './template.js';
import type { NotifierAttemptResult, NotifyParams } from './types.js';

const DEFAULT_TEMPLATES = {
  findings: '🦴 Good boy Layne dug up {{notificationTotal}} finding(s) in {{prUrl}}',
  'coverage-failure': '❗ Required scan coverage failed for {{prUrl}}: {{blockingCoverageSummary}}',
  'incomplete-scan': '❗ Scan coverage was incomplete for {{prUrl}}: {{incompleteCoverageSummary}}',
  'internal-error': '🚨 Layne encountered internal error {{errorId}} while scanning {{prUrl}}',
  'exception-approval': 'ℹ️ Exception approved by @{{approver}} for {{prUrl}}',
} as const;

function resolveUrl(webhookUrl: string | undefined): string | null {
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

export async function notify({ state, projection, owner, repo, prNumber, headSha, toolConfig, signal }: NotifyParams): Promise<NotifierAttemptResult> {
  signal?.throwIfAborted();
  const url = resolveUrl(toolConfig.webhookUrl);
  if (!url) return { delivered: false, retryable: false, reason: 'webhook-unavailable' };

  const event = projection.primaryEvent!;
  const ctx = buildNotificationContext(state, projection, owner, repo, prNumber, headSha);
  const customTemplate = toolConfig.templates?.[event] ?? toolConfig.template;
  const text = customTemplate
    ? renderTemplate(customTemplate, ctx)
    : projection.events.map(currentEvent => renderTemplate(DEFAULT_TEMPLATES[currentEvent], ctx)).join('\n');

  const avatarUrl = process.env.DOMAIN
    ? `https://${process.env.DOMAIN}/assets/layne-logo.png`
    : undefined;

  try {
    signal?.throwIfAborted();
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        alias:    'Layne',
        ...(avatarUrl && { icon_url: avatarUrl }),
        text,
      }),
      ...(signal && { signal }),
    });
    if (!res.ok) {
      console.error(`[rocketchat] notification failed: HTTP ${res.status}`);
      return {
        delivered: false,
        retryable: res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500,
        reason: `http-${res.status}`,
      };
    }
    return { delivered: true };
  } catch (err) {
    signal?.throwIfAborted();
    console.error(`[rocketchat] notification failed: ${(err as Error).message}`);
    return { delivered: false, retryable: true, reason: 'network-error' };
  }
}
