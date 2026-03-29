/**
 * Rocket.Chat notifier — posts security findings to a Rocket.Chat incoming webhook.
 *
 * Conforms to the Layne notifier contract:
 *   export async function notify({ findings, owner, repo, prNumber, toolConfig, exceptionApproval })
 *
 * Never throws. All errors are caught, logged, and swallowed so a notification
 * failure never affects the scan result or the GitHub Check Run.
 */
import type { NotifyParams } from './types.js';
export declare function notify({ findings, owner, repo, prNumber, toolConfig, exceptionApproval }: NotifyParams): Promise<void>;
//# sourceMappingURL=rocketchat.d.ts.map