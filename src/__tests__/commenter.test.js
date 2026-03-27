import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../auth.js', () => ({
  getInstallationOctokit: vi.fn(),
}));

const { getInstallationOctokit } = await import('../auth.js');
const { postComment }             = await import('../commenter.js');

const COMMENT_MARKER = '<!-- layne-security-scan -->';

const FINDING_HIGH = {
  file: 'src/app.js', line: 10, severity: 'high',
  message: 'SQL injection', ruleId: 'semgrep/sql-injection', tool: 'semgrep',
};

const FINDING_MEDIUM = {
  file: 'src/utils.js', line: 5, severity: 'medium',
  message: 'Weak hash function', ruleId: 'semgrep/weak-hash', tool: 'semgrep',
};

const BASE = {
  owner:          'acme',
  repo:           'frontend',
  prNumber:       42,
  installationId: 1,
  commentConfig:  { enabled: true, template: null },
};

function makeOctokit({ existingComments = [] } = {}) {
  const createComment = vi.fn().mockResolvedValue({});
  const updateComment = vi.fn().mockResolvedValue({});

  // paginate returns the full list of comment objects
  const paginate = vi.fn().mockResolvedValue(existingComments);

  const octokit = {
    paginate,
    issues: { listComments: {}, createComment, updateComment },
  };

  getInstallationOctokit.mockResolvedValue(octokit);
  return { octokit, createComment, updateComment, paginate };
}

describe('postComment()', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('failure conclusion — no prior comment', () => {
    it('creates a new comment when there is no existing Layne comment', async () => {
      const { createComment } = makeOctokit({ existingComments: [] });

      await postComment({ ...BASE, findings: [FINDING_HIGH], conclusion: 'failure' });

      expect(createComment).toHaveBeenCalledOnce();
      expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
        owner: 'acme', repo: 'frontend', issue_number: 42,
      }));
    });

    it('includes the comment marker in the created body', async () => {
      const { createComment } = makeOctokit({ existingComments: [] });

      await postComment({ ...BASE, findings: [FINDING_HIGH], conclusion: 'failure' });

      const { body } = createComment.mock.calls[0][0];
      expect(body).toContain(COMMENT_MARKER);
    });

    it('includes the finding count in the created body', async () => {
      const { createComment } = makeOctokit({ existingComments: [] });

      await postComment({ ...BASE, findings: [FINDING_HIGH], conclusion: 'failure' });

      const { body } = createComment.mock.calls[0][0];
      expect(body).toContain('1 finding(s)');
    });
  });

  describe('failure conclusion — existing comment', () => {
    it('updates the existing comment instead of creating a new one', async () => {
      const { createComment, updateComment } = makeOctokit({
        existingComments: [{ id: 99, body: `${COMMENT_MARKER}\nold content` }],
      });

      await postComment({ ...BASE, findings: [FINDING_HIGH], conclusion: 'failure' });

      expect(updateComment).toHaveBeenCalledOnce();
      expect(createComment).not.toHaveBeenCalled();
    });

    it('passes the correct comment_id when updating', async () => {
      const { updateComment } = makeOctokit({
        existingComments: [{ id: 99, body: `${COMMENT_MARKER}\nold content` }],
      });

      await postComment({ ...BASE, findings: [FINDING_HIGH], conclusion: 'failure' });

      expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 99 }));
    });
  });

  describe('success conclusion — existing comment', () => {
    it('updates the existing comment to show scan passed', async () => {
      const { updateComment, createComment } = makeOctokit({
        existingComments: [{ id: 77, body: `${COMMENT_MARKER}\nprevious failure` }],
      });

      await postComment({ ...BASE, findings: [], conclusion: 'success' });

      expect(updateComment).toHaveBeenCalledOnce();
      expect(createComment).not.toHaveBeenCalled();
    });

    it('uses the success body when updating on success', async () => {
      const { updateComment } = makeOctokit({
        existingComments: [{ id: 77, body: `${COMMENT_MARKER}\nprevious failure` }],
      });

      await postComment({ ...BASE, findings: [], conclusion: 'success' });

      const { body } = updateComment.mock.calls[0][0];
      expect(body).toContain(COMMENT_MARKER);
      expect(body).toContain('scan passed');
    });
  });

  describe('success conclusion — no prior comment', () => {
    it('does nothing when there are no findings and no existing comment to resolve', async () => {
      const { createComment, updateComment } = makeOctokit({ existingComments: [] });

      await postComment({ ...BASE, findings: [], conclusion: 'success' });

      expect(createComment).not.toHaveBeenCalled();
      expect(updateComment).not.toHaveBeenCalled();
    });
  });

  describe('success with warnings — no prior comment', () => {
    it('creates a new comment when there are warning findings and no existing comment', async () => {
      const { createComment } = makeOctokit({ existingComments: [] });

      await postComment({ ...BASE, findings: [FINDING_MEDIUM], conclusion: 'success' });

      expect(createComment).toHaveBeenCalledOnce();
      expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
        owner: 'acme', repo: 'frontend', issue_number: 42,
      }));
    });

    it('includes the comment marker and warning count in the body', async () => {
      const { createComment } = makeOctokit({ existingComments: [] });

      await postComment({ ...BASE, findings: [FINDING_MEDIUM], conclusion: 'success' });

      const { body } = createComment.mock.calls[0][0];
      expect(body).toContain(COMMENT_MARKER);
      expect(body).toContain('1 warning(s)');
    });
  });

  describe('success with warnings — existing comment', () => {
    it('updates the existing comment with the warning summary', async () => {
      const { createComment, updateComment } = makeOctokit({
        existingComments: [{ id: 55, body: `${COMMENT_MARKER}\nprevious failure` }],
      });

      await postComment({ ...BASE, findings: [FINDING_MEDIUM], conclusion: 'success' });

      expect(updateComment).toHaveBeenCalledOnce();
      expect(createComment).not.toHaveBeenCalled();
      expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 55 }));
    });
  });

  describe('custom warning template', () => {
    it('uses a custom warning template when provided', async () => {
      const { createComment } = makeOctokit({ existingComments: [] });
      const warningTemplate = `${COMMENT_MARKER}\nWarnings in {{repo}}: {{total}}`;

      await postComment({
        ...BASE,
        findings:      [FINDING_MEDIUM],
        conclusion:    'success',
        commentConfig: { enabled: true, template: null, warningTemplate },
      });

      const { body } = createComment.mock.calls[0][0];
      expect(body).toBe(`${COMMENT_MARKER}\nWarnings in acme/frontend: 1`);
    });
  });

  describe('custom template', () => {
    it('uses a custom failure template when provided', async () => {
      const { createComment } = makeOctokit({ existingComments: [] });
      const template = `${COMMENT_MARKER}\nCustom: {{total}} issues in {{repo}}`;

      await postComment({
        ...BASE,
        findings:      [FINDING_HIGH],
        conclusion:    'failure',
        commentConfig: { enabled: true, template },
      });

      const { body } = createComment.mock.calls[0][0];
      expect(body).toBe(`${COMMENT_MARKER}\nCustom: 1 issues in acme/frontend`);
    });
  });

  describe('error handling', () => {
    it('does not throw when getInstallationOctokit rejects', async () => {
      getInstallationOctokit.mockRejectedValueOnce(new Error('auth failed'));
      await expect(
        postComment({ ...BASE, findings: [FINDING_HIGH], conclusion: 'failure' })
      ).resolves.toBeUndefined();
    });

    it('does not throw when createComment rejects', async () => {
      const { octokit } = makeOctokit({ existingComments: [] });
      octokit.issues.createComment.mockRejectedValueOnce(new Error('API down'));

      await expect(
        postComment({ ...BASE, findings: [FINDING_HIGH], conclusion: 'failure' })
      ).resolves.toBeUndefined();
    });

    it('logs an error when an exception occurs', async () => {
      getInstallationOctokit.mockRejectedValueOnce(new Error('auth failed'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      await postComment({ ...BASE, findings: [FINDING_HIGH], conclusion: 'failure' });

      expect(error).toHaveBeenCalledWith(expect.stringContaining('[commenter]'));
      error.mockRestore();
    });
  });
});
