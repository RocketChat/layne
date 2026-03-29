/**
 * Rocket.Chat notifier — posts security findings to a Rocket.Chat incoming webhook.
 *
 * Conforms to the Layne notifier contract:
 *   export async function notify({ findings, owner, repo, prNumber, toolConfig, exceptionApproval })
 *
 * Never throws. All errors are caught, logged, and swallowed so a notification
 * failure never affects the scan result or the GitHub Check Run.
 */

import { buildContext, renderTemplate } from './template.js';
import type { NotifyParams } from './types.js';

const DEFAULT_TEMPLATE = '🦴 Good boy Layne dug up {{total}} finding(s) in {{prUrl}}';
const EXCEPTION_TEMPLATE = '⚠️ Exception approved by @{{approver}}\n🦴 Found {{total}} issue(s): {{critical}} critical, {{high}} high, {{medium}} medium, {{low}} low\n{{prUrl}}';

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

export async function notify({ findings, owner, repo, prNumber, toolConfig, exceptionApproval }: NotifyParams): Promise<void> {
  const url = resolveUrl(toolConfig.webhookUrl);
  if (!url) return;

  let text: string;

  if (exceptionApproval?.approved) {
    const ctx = {
      ...buildContext(findings, owner, repo, prNumber),
      approver: exceptionApproval.approver ?? '',
    };
    text = renderTemplate(toolConfig.template ?? EXCEPTION_TEMPLATE, ctx);
  } else {
    const ctx = buildContext(findings, owner, repo, prNumber);
    text = renderTemplate(toolConfig.template ?? DEFAULT_TEMPLATE, ctx);
  }

  const avatarUrl = process.env.DOMAIN
    ? `https://${process.env.DOMAIN}/assets/layne-logo.png`
    : undefined;

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        alias:    'Layne',
        ...(avatarUrl && { icon_url: avatarUrl }),
        text,
      }),
    });
    if (!res.ok) {
      console.error(`[rocketchat] notification failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[rocketchat] notification failed: ${(err as Error).message}`);
  }
}
