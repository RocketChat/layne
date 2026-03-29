import { getInstallationOctokit } from './auth.js';
import { buildContext, renderTemplate } from './notifiers/template.js';
import type { ProcessedFinding, CommentConfig } from './types.js';

const COMMENT_MARKER = '<!-- layne-security-scan -->';

const DEFAULT_FAILURE_TEMPLATE = [
  COMMENT_MARKER,
  '## 🔴 Layne — {{total}} finding(s)',
  '',
  '{{summary}}',
].join('\n');

const DEFAULT_WARNING_TEMPLATE = [
  COMMENT_MARKER,
  '## ⚠️ Layne — {{total}} warning(s)',
  '',
  '{{summary}}',
].join('\n');

const SUCCESS_BODY = [
  COMMENT_MARKER,
  '✅ **Layne — scan passed**',
  '',
  'No security issues found on latest push.',
].join('\n');

async function findExistingComment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  octokit: any,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number | null> {
  const comments = await octokit.paginate(octokit.issues.listComments, {
    owner, repo, issue_number: prNumber,
  }) as Array<{ id: number; body?: string }>;
  return comments.find(c => c.body?.includes(COMMENT_MARKER))?.id ?? null;
}

/**
 * Creates or updates a Layne security comment on a PR.
 * Never throws.
 */
export async function postComment({ findings, owner, repo, prNumber, installationId, conclusion, commentConfig }: {
  findings: ProcessedFinding[];
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  conclusion: string;
  commentConfig: CommentConfig & { warningTemplate?: string | null };
}): Promise<void> {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const existingId = await findExistingComment(octokit, owner, repo, prNumber);

    let body: string;
    if (conclusion === 'failure') {
      const ctx = buildContext(findings, owner, repo, prNumber);
      body = renderTemplate(commentConfig.template ?? DEFAULT_FAILURE_TEMPLATE, ctx);
    } else if (findings.length > 0) {
      const ctx = buildContext(findings, owner, repo, prNumber);
      body = renderTemplate(commentConfig.warningTemplate ?? DEFAULT_WARNING_TEMPLATE, ctx);
    } else {
      if (!existingId) return; // no prior comment — nothing to resolve
      body = SUCCESS_BODY;
    }

    if (existingId) {
      await octokit.issues.updateComment({ owner, repo, comment_id: existingId, body });
    } else {
      await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
    }
  } catch (err) {
    console.error(`[commenter] Failed to post PR comment: ${(err as Error).message}`);
  }
}
