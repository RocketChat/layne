/**
 * Notification orchestrator — iterates the registry of known notifiers and
 * calls each one that is enabled in the resolved notification config.
 *
 * Adding a new notifier (e.g. Slack) requires two changes here only:
 *   1. Add the import.
 *   2. Add the key to NOTIFIERS.
 * No other files need to change.
 */

import { notify as notifyRocketchat } from './rocketchat.js';
import { notify as notifySlack }      from './slack.js';

const NOTIFIERS = {
  rocketchat: notifyRocketchat,
  slack:      notifySlack,
};

/**
 * @param {object} params
 * @param {Array}  params.findings           - All findings from all scanners (non-empty).
 * @param {string} params.owner              - GitHub org/user name.
 * @param {string} params.repo               - Repository name.
 * @param {number} params.prNumber           - Pull request number.
 * @param {object} params.notificationConfig - Merged global + per-repo notification config.
 */
export async function notify({ findings, owner, repo, prNumber, notificationConfig }) {
  for (const [key, notifierFn] of Object.entries(NOTIFIERS)) {
    const toolConfig = notificationConfig[key];
    if (!toolConfig?.enabled) continue;

    await notifierFn({ findings, owner, repo, prNumber, toolConfig });
  }
}
