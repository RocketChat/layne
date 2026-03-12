import { describe, it, expect, vi, beforeEach } from 'vitest';

// Build a mock Octokit instance with spies for the methods we use.
const mockChecksCreate          = vi.fn().mockResolvedValue({ data: { id: 42 } });
const mockChecksUpdate          = vi.fn().mockResolvedValue({});
const mockGetLabel               = vi.fn().mockResolvedValue({});
const mockCreateLabel            = vi.fn().mockResolvedValue({});
const mockAddLabels              = vi.fn().mockResolvedValue({});
const mockRemoveLabel            = vi.fn().mockResolvedValue({});
const mockListPRsForCommit       = vi.fn().mockResolvedValue({ data: [] });

const mockOctokit = {
  checks: {
    create: mockChecksCreate,
    update: mockChecksUpdate,
  },
  issues: {
    getLabel:    mockGetLabel,
    createLabel: mockCreateLabel,
    addLabels:   mockAddLabels,
    removeLabel: mockRemoveLabel,
  },
  repos: {
    listPullRequestsAssociatedWithCommit: mockListPRsForCommit,
  },
};

vi.mock('../auth.js', () => ({
  getInstallationOctokit: vi.fn().mockResolvedValue(mockOctokit),
}));

const {
  createCheckRun, startCheckRun, completeCheckRun,
  skipCheckRun, findPullRequestBySha,
  ensureLabelsExist, setLabels,
} = await import('../github.js');

const BASE = {
  installationId: 1,
  owner:          'org',
  repo:           'repo',
  checkRunId:     42,
};

describe('createCheckRun()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a check run in queued status', async () => {
    await createCheckRun({ ...BASE, headSha: 'sha123' });

    expect(mockChecksCreate).toHaveBeenCalledWith(expect.objectContaining({
      owner:    'org',
      repo:     'repo',
      head_sha: 'sha123',
      status:   'queued',
    }));
  });

  it('returns the check run ID from the API response', async () => {
    const id = await createCheckRun({ ...BASE, headSha: 'sha123' });
    expect(id).toBe(42);
  });
});

describe('startCheckRun()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates the check run to in_progress', async () => {
    await startCheckRun(BASE);

    expect(mockChecksUpdate).toHaveBeenCalledWith(expect.objectContaining({
      check_run_id: 42,
      status:       'in_progress',
    }));
  });
});

describe('completeCheckRun()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('completes the check run with success when there are no annotations', async () => {
    await completeCheckRun({ ...BASE, conclusion: 'success', annotations: [], summary: 'All clear.' });

    expect(mockChecksUpdate).toHaveBeenCalledOnce();
    expect(mockChecksUpdate).toHaveBeenCalledWith(expect.objectContaining({
      check_run_id: 42,
      status:       'completed',
      conclusion:   'success',
    }));
  });

  it('completes the check run with failure conclusion', async () => {
    await completeCheckRun({ ...BASE, conclusion: 'failure', annotations: [], summary: 'Found issues.' });

    expect(mockChecksUpdate).toHaveBeenCalledWith(expect.objectContaining({
      conclusion: 'failure',
    }));
  });

  it('sends all annotations in a single call when there are ≤50', async () => {
    const annotations = Array.from({ length: 50 }, (_, i) => ({
      path: `file${i}.js`, start_line: i + 1, end_line: i + 1,
      annotation_level: 'warning', title: 'T', message: 'M',
    }));

    await completeCheckRun({ ...BASE, conclusion: 'failure', annotations, summary: '' });

    // One update call for the single chunk
    expect(mockChecksUpdate).toHaveBeenCalledOnce();
    expect(mockChecksUpdate.mock.calls[0][0].output.annotations).toHaveLength(50);
  });

  it('chunks annotations into batches of 50 when there are >50', async () => {
    const annotations = Array.from({ length: 110 }, (_, i) => ({
      path: `file${i}.js`, start_line: i + 1, end_line: i + 1,
      annotation_level: 'failure', title: 'T', message: 'M',
    }));

    await completeCheckRun({ ...BASE, conclusion: 'failure', annotations, summary: '' });

    // 110 annotations → 3 chunks: 50, 50, 10
    expect(mockChecksUpdate).toHaveBeenCalledTimes(3);
    expect(mockChecksUpdate.mock.calls[0][0].output.annotations).toHaveLength(50);
    expect(mockChecksUpdate.mock.calls[1][0].output.annotations).toHaveLength(50);
    expect(mockChecksUpdate.mock.calls[2][0].output.annotations).toHaveLength(10);
  });

  it('sets status: completed only on the last chunk', async () => {
    const annotations = Array.from({ length: 60 }, (_, i) => ({
      path: `file${i}.js`, start_line: 1, end_line: 1,
      annotation_level: 'notice', title: 'T', message: 'M',
    }));

    await completeCheckRun({ ...BASE, conclusion: 'success', annotations, summary: '' });

    const [firstCall, secondCall] = mockChecksUpdate.mock.calls;
    expect(firstCall[0].status).toBe('in_progress');
    expect(secondCall[0].status).toBe('completed');
  });
});

describe('skipCheckRun()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a check run in completed/skipped state in a single API call', async () => {
    await skipCheckRun({ ...BASE, headSha: 'sha123', summary: 'Waiting for CI.' });

    expect(mockChecksCreate).toHaveBeenCalledOnce();
    expect(mockChecksCreate).toHaveBeenCalledWith(expect.objectContaining({
      owner:      'org',
      repo:       'repo',
      head_sha:   'sha123',
      status:     'completed',
      conclusion: 'skipped',
    }));
  });

  it('includes the summary in the check run output', async () => {
    await skipCheckRun({ ...BASE, headSha: 'sha123', summary: 'Deferred — waiting for Tests Done.' });

    expect(mockChecksCreate).toHaveBeenCalledWith(expect.objectContaining({
      output: expect.objectContaining({ summary: 'Deferred — waiting for Tests Done.' }),
    }));
  });
});

describe('findPullRequestBySha()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls listPullRequestsAssociatedWithCommit with the correct params', async () => {
    await findPullRequestBySha({ ...BASE, headSha: 'sha123' });

    expect(mockListPRsForCommit).toHaveBeenCalledWith(expect.objectContaining({
      owner:      'org',
      repo:       'repo',
      commit_sha: 'sha123',
    }));
  });

  it('returns the first PR when results are found', async () => {
    const pr = { number: 7, head: { ref: 'feat/x', sha: 'sha123' }, base: { ref: 'main', sha: 'base1' }, labels: [] };
    mockListPRsForCommit.mockResolvedValueOnce({ data: [pr, { number: 8 }] });

    const result = await findPullRequestBySha({ ...BASE, headSha: 'sha123' });

    expect(result).toBe(pr);
  });

  it('returns null when no PRs are associated with the commit', async () => {
    mockListPRsForCommit.mockResolvedValueOnce({ data: [] });

    const result = await findPullRequestBySha({ ...BASE, headSha: 'sha123' });

    expect(result).toBeNull();
  });
});

describe('ensureLabelsExist()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing when labelNames is empty', async () => {
    await ensureLabelsExist({ ...BASE, labelNames: [] });
    expect(mockGetLabel).not.toHaveBeenCalled();
  });

  it('checks each label and skips creation when all exist', async () => {
    mockGetLabel.mockResolvedValue({});
    await ensureLabelsExist({ ...BASE, labelNames: ['needs-security-review', 'security-ok'] });
    expect(mockGetLabel).toHaveBeenCalledTimes(2);
    expect(mockCreateLabel).not.toHaveBeenCalled();
  });

  it('creates a label with color ededed when it does not exist (404)', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    mockGetLabel.mockRejectedValueOnce(notFound);

    await ensureLabelsExist({ ...BASE, labelNames: ['needs-security-review'] });

    expect(mockCreateLabel).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'org',
      repo:  'repo',
      name:  'needs-security-review',
      color: 'ededed',
    }));
  });

  it('logs and swallows non-404 errors from getLabel', async () => {
    const err = Object.assign(new Error('API error'), { status: 500 });
    mockGetLabel.mockRejectedValueOnce(err);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ensureLabelsExist({ ...BASE, labelNames: ['label'] })).resolves.toBeUndefined();

    expect(mockCreateLabel).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('logs and swallows createLabel errors', async () => {
    const notFound  = Object.assign(new Error('Not Found'), { status: 404 });
    const createErr = new Error('Unprocessable Entity');
    mockGetLabel.mockRejectedValueOnce(notFound);
    mockCreateLabel.mockRejectedValueOnce(createErr);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ensureLabelsExist({ ...BASE, labelNames: ['label'] })).resolves.toBeUndefined();
    error.mockRestore();
  });
});

describe('setLabels()', () => {
  beforeEach(() => vi.clearAllMocks());

  const LABEL_BASE = { ...BASE, prNumber: 7 };

  it('adds labels to the PR', async () => {
    await setLabels({ ...LABEL_BASE, add: ['needs-security-review'], remove: [] });
    expect(mockAddLabels).toHaveBeenCalledWith(expect.objectContaining({
      owner:        'org',
      repo:         'repo',
      issue_number: 7,
      labels:       ['needs-security-review'],
    }));
  });

  it('does not call addLabels when add is empty', async () => {
    await setLabels({ ...LABEL_BASE, add: [], remove: ['needs-security-review'] });
    expect(mockAddLabels).not.toHaveBeenCalled();
  });

  it('removes each label individually', async () => {
    await setLabels({ ...LABEL_BASE, add: [], remove: ['label-a', 'label-b'] });
    expect(mockRemoveLabel).toHaveBeenCalledTimes(2);
    expect(mockRemoveLabel).toHaveBeenCalledWith(expect.objectContaining({ name: 'label-a' }));
    expect(mockRemoveLabel).toHaveBeenCalledWith(expect.objectContaining({ name: 'label-b' }));
  });

  it('silently ignores 404 when removing a label that is not present', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    mockRemoveLabel.mockRejectedValueOnce(notFound);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(setLabels({ ...LABEL_BASE, add: [], remove: ['missing'] })).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('logs and swallows non-404 removeLabel errors', async () => {
    const err = Object.assign(new Error('Server Error'), { status: 500 });
    mockRemoveLabel.mockRejectedValueOnce(err);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(setLabels({ ...LABEL_BASE, add: [], remove: ['label'] })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[github]'));
    error.mockRestore();
  });

  it('logs and swallows addLabels errors', async () => {
    mockAddLabels.mockRejectedValueOnce(new Error('API down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(setLabels({ ...LABEL_BASE, add: ['label'], remove: [] })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[github]'));
    error.mockRestore();
  });
});
