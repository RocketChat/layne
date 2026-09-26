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

const INCOMPLETE_ALERT =
  '> [!WARNING]\n' +
  '> Layne could not complete every configured security scan. The findings below may be incomplete.';

const INCOMPLETE_BODY = [
  COMMENT_MARKER,
  '⚠️ **Layne — scan incomplete**',
  '',
  'Layne could not analyze all changed content. Review the Check Run summary before merging.',
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
  signal?: AbortSignal,
): Promise<number | null> {
  signal?.throwIfAborted();
  const comments = await octokit.paginate(octokit.issues.listComments, {
    owner, repo, issue_number: prNumber,
    ...(signal && { request: { signal } }),
  }) as Array<{ id: number; body?: string }>;
  signal?.throwIfAborted();
  return comments.find(c => c.body?.includes(COMMENT_MARKER))?.id ?? null;
}

/**
 * Creates or updates a Layne security comment on a PR.
 * Never throws.
 */
export async function postComment({ findings, owner, repo, prNumber, installationId, headSha, conclusion, commentConfig, coverageFailure, signal }: {
  findings: ProcessedFinding[];
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  headSha: string;
  conclusion: string;
  commentConfig: CommentConfig & { warningTemplate?: string | null };
  coverageFailure?: string | null;
  signal?: AbortSignal;
}): Promise<void> {
  try {
    signal?.throwIfAborted();
    const octokit = await getInstallationOctokit(installationId, signal);
    const existingId = await findExistingComment(octokit, owner, repo, prNumber, signal);

    let body: string;
    if (conclusion === 'failure') {
      if (findings.length === 0 && coverageFailure) {
        body = `${COMMENT_MARKER}\n\n> [!CAUTION]\n> Spectre could not scan every high-risk changed file.\n\n${coverageFailure}`;
      } else {
        const ctx = buildContext(findings, owner, repo, prNumber, headSha);
        body = commentConfig.template
          ? renderTemplate(commentConfig.template, ctx)
          : buildDefaultComment(ctx, CAUTION_ALERT);
        if (coverageFailure) body = `${body}\n\n${coverageFailure}`;
      }
    } else if (conclusion === 'neutral') {
      if (findings.length > 0) {
        const ctx = buildContext(findings, owner, repo, prNumber, headSha);
        body = buildDefaultComment(ctx, INCOMPLETE_ALERT);
      } else {
        body = INCOMPLETE_BODY;
      }
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
      signal?.throwIfAborted();
      await octokit.issues.updateComment({ owner, repo, comment_id: existingId, body, ...(signal && { request: { signal } }) });
    } else {
      signal?.throwIfAborted();
      await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body, ...(signal && { request: { signal } }) });
    }
  } catch (err) {
    signal?.throwIfAborted();
    console.error(`[commenter] Failed to post PR comment: ${(err as Error).message}`);
  }
}
