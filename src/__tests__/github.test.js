import { describe, it, expect, vi, beforeEach } from 'vitest';

// Build a mock Octokit instance with spies for the methods we use.
const mockChecksCreate = vi.fn().mockResolvedValue({ data: { id: 42 } });
const mockChecksUpdate = vi.fn().mockResolvedValue({});

const mockOctokit = {
  checks: {
    create: mockChecksCreate,
    update: mockChecksUpdate,
  },
};

vi.mock('../auth.js', () => ({
  getInstallationOctokit: vi.fn().mockResolvedValue(mockOctokit),
}));

const { createCheckRun, startCheckRun, completeCheckRun } = await import('../github.js');

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
