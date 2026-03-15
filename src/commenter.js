import { getInstallationOctokit } from './auth.js';
import { buildContext, renderTemplate } from './notifiers/template.js';

const COMMENT_MARKER = '<!-- layne-security-scan -->';

const DEFAULT_FAILURE_TEMPLATE = [
  COMMENT_MARKER,
  '## 🔴 Layne — {{total}} finding(s)',
  '',
  '{{summary}}',
].join('\n');

const SUCCESS_BODY = [
  COMMENT_MARKER,
  '✅ **Layne — scan passed**',
  '',
  'No security issues found on latest push.',
].join('\n');

async function findExistingComment(octokit, owner, repo, prNumber) {
  const comments = await octokit.paginate(octokit.issues.listComments, {
    owner, repo, issue_number: prNumber,
  });
  return comments.find(c => c.body?.includes(COMMENT_MARKER))?.id ?? null;
}

/**
 * Creates or updates a Layne security comment on a PR.
 * On failure: posts/updates with finding summary.
 * On success: updates existing Layne comment to show scan passed; skips if none exists.
 * Never throws.
 */
export async function postComment({ findings, owner, repo, prNumber, installationId, conclusion, commentConfig }) {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const existingId = await findExistingComment(octokit, owner, repo, prNumber);

    let body;
    if (conclusion === 'failure') {
      const ctx = buildContext(findings, owner, repo, prNumber);
      body = renderTemplate(commentConfig.template ?? DEFAULT_FAILURE_TEMPLATE, ctx);
    } else {
      if (!existingId) return; // no prior failure comment — nothing to resolve
      body = SUCCESS_BODY;
    }

    if (existingId) {
      await octokit.issues.updateComment({ owner, repo, comment_id: existingId, body });
    } else {
      await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
    }
  } catch (err) {
    console.error(`[commenter] Failed to post PR comment: ${err.message}`);
  }
}
