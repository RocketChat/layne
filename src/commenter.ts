import { getInstallationOctokit } from './auth.js';
import { buildContext, renderTemplate } from './notifiers/template.js';
import type { ProcessedFinding, CommentConfig, TemplateContext } from './types.js';

const COMMENT_MARKER = '<!-- layne-security-scan -->';

const CAUTION_ALERT =
  '> [!CAUTION]\n' +
  '> These are security findings reported by the security scanners configured in Layne. ' +
  'Findings may contain false positives - review them and fix what makes sense. ' +
  'If you believe a finding is not valid, contact the security team.';

const WARNING_ALERT =
  '> [!WARNING]\n' +
  '> These are security findings reported by the security scanners configured in Layne. ' +
  'Findings may contain false positives - review them and fix what makes sense.';

const SUCCESS_BODY = [
  COMMENT_MARKER,
  '✅ **Layne — scan passed**',
  '',
  'No security issues found on latest push.',
].join('\n');

function buildDefaultComment(ctx: TemplateContext, alertBlock: string): string {
  return [
    COMMENT_MARKER,
    '',
    alertBlock,
    '',
    `**Layne found ${ctx.severitySummary} issue${ctx.total !== 1 ? 's' : ''} in this PR.**`,
    '',
    '<details>',
    `<summary>View ${ctx.total} finding(s)</summary>`,
    '',
    String(ctx.findings),
    '',
    '</details>',
  ].join('\n');
}

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
export async function postComment({ findings, owner, repo, prNumber, installationId, headSha, conclusion, commentConfig }: {
  findings: ProcessedFinding[];
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  headSha: string;
  conclusion: string;
  commentConfig: CommentConfig & { warningTemplate?: string | null };
}): Promise<void> {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const existingId = await findExistingComment(octokit, owner, repo, prNumber);

    let body: string;
    if (conclusion === 'failure') {
      const ctx = buildContext(findings, owner, repo, prNumber, headSha);
      body = commentConfig.template
        ? renderTemplate(commentConfig.template, ctx)
        : buildDefaultComment(ctx, CAUTION_ALERT);
    } else if (findings.length > 0) {
      const ctx = buildContext(findings, owner, repo, prNumber, headSha);
      body = commentConfig.warningTemplate
        ? renderTemplate(commentConfig.warningTemplate, ctx)
        : buildDefaultComment(ctx, WARNING_ALERT);
    } else {
      if (!existingId) return;
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
