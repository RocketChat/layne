/**
 * Notification orchestrator — iterates the registry of known notifiers and
 * calls each one that is enabled in the resolved notification config.
 *
 * Adding a new notifier (e.g. Slack) requires two changes here only:
 *   1. Add the import.
 *   2. Add the key to NOTIFIERS.
 * No other files need to change.
 */
import type { NotifyOrchestratorParams } from './types.js';
export declare function notify({ findings, owner, repo, prNumber, notificationConfig, exceptionApproval }: NotifyOrchestratorParams): Promise<void>;
//# sourceMappingURL=index.d.ts.map