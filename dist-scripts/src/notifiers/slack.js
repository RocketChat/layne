/**
 * Slack notifier — posts security findings to a Slack incoming webhook.
 *
 * Conforms to the Layne notifier contract:
 *   export async function notify({ findings, owner, repo, prNumber, toolConfig, exceptionApproval })
 *
 * Never throws. All errors are caught, logged, and swallowed so a notification
 * failure never affects the scan result or the GitHub Check Run.
 */
import { buildContext, renderTemplate } from './template.js';
const DEFAULT_TEMPLATE = '🦴 Good boy Layne dug up {{total}} finding(s) in <{{prUrl}}|{{repo}} #{{prNumber}}>';
const EXCEPTION_TEMPLATE = '⚠️ Exception approved by @{{approver}}\n🦴 Found {{total}} issue(s): {{critical}} critical, {{high}} high, {{medium}} medium, {{low}} low\n<{{prUrl}}|{{repo}} #{{prNumber}}>';
function resolveUrl(webhookUrl) {
    if (!webhookUrl)
        return null;
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
export async function notify({ findings, owner, repo, prNumber, toolConfig, exceptionApproval }) {
    const url = resolveUrl(toolConfig.webhookUrl);
    if (!url)
        return;
    let text;
    if (exceptionApproval?.approved) {
        const ctx = {
            ...buildContext(findings, owner, repo, prNumber),
            approver: exceptionApproval.approver ?? '',
        };
        text = renderTemplate(toolConfig.template ?? EXCEPTION_TEMPLATE, ctx);
    }
    else {
        const ctx = buildContext(findings, owner, repo, prNumber);
        text = renderTemplate(toolConfig.template ?? DEFAULT_TEMPLATE, ctx);
    }
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        });
        if (!res.ok) {
            console.error(`[slack] notification failed: HTTP ${res.status}`);
        }
    }
    catch (err) {
        console.error(`[slack] notification failed: ${err.message}`);
    }
}
//# sourceMappingURL=slack.js.map