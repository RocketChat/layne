import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies before importing the worker module.
vi.mock('../queue.js', () => ({
  redis: {},
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function() { return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }; }),
}));

vi.mock('../auth.js', () => ({
  getInstallationToken: vi.fn().mockResolvedValue('fake-token'),
}));

vi.mock('../github.js', () => ({
  startCheckRun:    vi.fn().mockResolvedValue(undefined),
  completeCheckRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../fetcher.js', () => ({
  createWorkspace:   vi.fn().mockResolvedValue('/tmp/layne-test-workspace'),
  cloneRepo:         vi.fn().mockResolvedValue(undefined),
  fetchBase:         vi.fn().mockResolvedValue(undefined),
  getChangedFiles:   vi.fn().mockResolvedValue(['src/app.js']),
  cleanupWorkspace:  vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../dispatcher.js', () => ({
  dispatch: vi.fn().mockResolvedValue([]),
}));

vi.mock('../reporter.js', () => ({
  buildAnnotations: vi.fn().mockReturnValue({
    annotations: [],
    conclusion:  'success',
    summary:     'No issues found.',
  }),
}));

vi.mock('../config.js', () => ({
  loadScanConfig: vi.fn().mockResolvedValue({
    semgrep:       { enabled: true, extraArgs: ['--config', 'auto'] },
    trufflehog:    { enabled: true, extraArgs: [] },
    claude:        { enabled: false, model: 'claude-haiku-4-5-20251001' },
    notifications: {},
  }),
}));

vi.mock('../notifiers/index.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

const { Worker: MockWorker }              = await import('bullmq');
const { getInstallationToken }            = await import('../auth.js');
const { startCheckRun, completeCheckRun } = await import('../github.js');
const { createWorkspace, cloneRepo, fetchBase, getChangedFiles, cleanupWorkspace } = await import('../fetcher.js');
const { dispatch }                        = await import('../dispatcher.js');
const { loadScanConfig }                  = await import('../config.js');
const { notify }                          = await import('../notifiers/index.js');
const { processJob, shutdown }            = await import('../worker.js');

// ---

const baseJob = {
  id:   'job-1',
  attemptsMade: 0,
  opts: { attempts: 2 },
  data: {
    installationId: 1,
    owner:          'org',
    repo:           'repo',
    cloneUrl:       'https://github.com/org/repo.git',
    headSha:        'abc123',
    headRef:        'feature/x',
    baseSha:        'def456',
    baseRef:        'main',
    prNumber:       7,
    labels:         [],
    checkRunId:     99,
  },
};

describe('shutdown()', () => {
  it('calls close() on the BullMQ worker', async () => {
    const workerInstance = MockWorker.mock.results[0].value;
    await shutdown();
    expect(workerInstance.close).toHaveBeenCalled();
  });
});

describe('processJob()', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('successful scan', () => {
    it('marks the check run as in_progress at the start', async () => {
      await processJob(baseJob);
      expect(startCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        installationId: 1, owner: 'org', repo: 'repo', checkRunId: 99,
      }));
    });

    it('fetches an installation token', async () => {
      await processJob(baseJob);
      expect(getInstallationToken).toHaveBeenCalledWith(1);
    });

    it('creates a workspace and clones the repo into it', async () => {
      await processJob(baseJob);
      expect(createWorkspace).toHaveBeenCalledWith('job-1');
      expect(cloneRepo).toHaveBeenCalledWith(expect.objectContaining({
        token:         'fake-token',
        cloneUrl:      'https://github.com/org/repo.git',
        headSha:       'abc123',
        workspacePath: '/tmp/layne-test-workspace',
      }));
    });

    it('fetches the base branch and gets the list of changed files', async () => {
      await processJob(baseJob);
      expect(fetchBase).toHaveBeenCalledWith(expect.objectContaining({
        workspacePath: '/tmp/layne-test-workspace',
        baseSha:       'def456',
      }));
      expect(getChangedFiles).toHaveBeenCalledWith({ workspacePath: '/tmp/layne-test-workspace' });
    });

    it('runs the dispatcher with the job context including changed files', async () => {
      await processJob(baseJob);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
        workspacePath: '/tmp/layne-test-workspace',
        changedFiles:  ['src/app.js'],
        baseSha:       'def456',
        baseRef:       'main',
        labels:        [],
        owner:         'org',
        repo:          'repo',
      }));
    });

    it('completes the check run with the reporter output', async () => {
      await processJob(baseJob);
      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion:  'success',
        annotations: [],
        summary:     'No issues found.',
        checkRunId:  99,
      }));
    });

    it('cleans up the workspace after a successful scan', async () => {
      await processJob(baseJob);
      expect(cleanupWorkspace).toHaveBeenCalledWith('/tmp/layne-test-workspace');
    });
  });

  describe('token sanitization', () => {
    it('redacts installation tokens from error messages in the check run summary', async () => {
      cloneRepo.mockRejectedValueOnce(
        new Error("fatal: repository 'https://x-access-token:ghs_secrettoken@github.com/org/repo.git' not found")
      );
      await expect(processJob({
        ...baseJob,
        attemptsMade: 1,
      })).rejects.toThrow('not found');
      const summary = completeCheckRun.mock.calls[0][0].summary;
      expect(summary).not.toContain('ghs_secrettoken');
      expect(summary).toContain('[REDACTED]');
    });
  });

  describe('scan timeout', () => {
    it('rethrows timeout errors so BullMQ can retry the job', async () => {
      vi.useFakeTimers();
      cloneRepo.mockImplementationOnce(() => new Promise(() => {})); // never resolves

      const jobPromise = processJob(baseJob);

      // Attach the rejection handler BEFORE advancing timers so it is in place
      // when the timeout fires — prevents a spurious unhandled rejection warning.
      const assertRejection = expect(jobPromise).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      await assertRejection;

      expect(completeCheckRun).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('fails the check run only when the timeout happens on the final attempt', async () => {
      vi.useFakeTimers();
      cloneRepo.mockImplementationOnce(() => new Promise(() => {})); // never resolves

      const jobPromise = processJob({
        ...baseJob,
        attemptsMade: 1,
      });

      const assertRejection = expect(jobPromise).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      await assertRejection;

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'failure',
        summary:    expect.stringContaining('timed out'),
      }));

      vi.useRealTimers();
    });
  });

  describe('retryable failures', () => {
    beforeEach(() => {
      cloneRepo.mockRejectedValueOnce(new Error('git clone failed'));
    });

    it('rethrows the error so BullMQ can retry the job', async () => {
      await expect(processJob(baseJob)).rejects.toThrow('git clone failed');
    });

    it('still cleans up the workspace even when the scan throws', async () => {
      await expect(processJob(baseJob)).rejects.toThrow('git clone failed');
      expect(cleanupWorkspace).toHaveBeenCalledWith('/tmp/layne-test-workspace');
    });

    it('keeps the check run open while BullMQ retries the job', async () => {
      await expect(processJob(baseJob)).rejects.toThrow('git clone failed');
      expect(completeCheckRun).not.toHaveBeenCalled();
    });
  });

  describe('final-attempt failures', () => {
    beforeEach(() => {
      cloneRepo.mockRejectedValueOnce(new Error('git clone failed'));
    });

    it('marks the check run failed on the final attempt', async () => {
      await expect(processJob({
        ...baseJob,
        attemptsMade: 1,
      })).rejects.toThrow('git clone failed');

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'failure',
        summary:    expect.stringContaining('git clone failed'),
      }));
    });

    it('swallows completeCheckRun errors and still propagates the original failure', async () => {
      completeCheckRun.mockRejectedValueOnce(new Error('GitHub API down'));

      await expect(processJob({
        ...baseJob,
        attemptsMade: 1,
      })).rejects.toThrow('git clone failed');
    });
  });

  describe('fetchBase failure', () => {
    it('rethrows when fetchBase throws so BullMQ can retry', async () => {
      fetchBase.mockRejectedValueOnce(new Error('remote not found'));
      await expect(processJob(baseJob)).rejects.toThrow('remote not found');
      expect(completeCheckRun).not.toHaveBeenCalled();
    });

    it('still cleans up the workspace when fetchBase throws', async () => {
      fetchBase.mockRejectedValueOnce(new Error('remote not found'));
      await expect(processJob(baseJob)).rejects.toThrow('remote not found');
      expect(cleanupWorkspace).toHaveBeenCalledWith('/tmp/layne-test-workspace');
    });
  });

  describe('getChangedFiles failure', () => {
    it('rethrows when getChangedFiles throws so BullMQ can retry', async () => {
      getChangedFiles.mockRejectedValueOnce(new Error('git diff failed'));
      await expect(processJob(baseJob)).rejects.toThrow('git diff failed');
      expect(completeCheckRun).not.toHaveBeenCalled();
    });
  });

  describe('no changed files', () => {
    it('passes an empty changedFiles array to dispatch when the PR has no file changes', async () => {
      getChangedFiles.mockResolvedValueOnce([]);
      await processJob(baseJob);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ changedFiles: [] }));
    });

    it('completes the check run successfully when there are no changed files', async () => {
      getChangedFiles.mockResolvedValueOnce([]);
      await processJob(baseJob);
      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'success' }));
    });
  });

  describe('notifications', () => {
    it('does not call notify when there are no findings', async () => {
      dispatch.mockResolvedValueOnce([]);
      await processJob(baseJob);
      expect(notify).not.toHaveBeenCalled();
    });

    it('calls notify after completeCheckRun when there are findings', async () => {
      const finding = { file: 'a.js', line: 1, severity: 'high', message: 'issue', ruleId: 'r/1', tool: 'semgrep' };
      dispatch.mockResolvedValueOnce([finding]);

      const callOrder = [];
      completeCheckRun.mockImplementationOnce(async () => { callOrder.push('completeCheckRun'); });
      notify.mockImplementationOnce(async () => { callOrder.push('notify'); });

      await processJob(baseJob);

      expect(callOrder).toEqual(['completeCheckRun', 'notify']);
    });

    it('passes findings, owner, repo, prNumber, and notificationConfig to notify', async () => {
      const finding = { file: 'a.js', line: 1, severity: 'high', message: 'issue', ruleId: 'r/1', tool: 'semgrep' };
      dispatch.mockResolvedValueOnce([finding]);

      await processJob(baseJob);

      expect(notify).toHaveBeenCalledWith({
        findings:           [finding],
        owner:              'org',
        repo:               'repo',
        prNumber:           7,
        notificationConfig: {},
      });
    });

    it('does not throw and still cleans up the workspace when notify rejects', async () => {
      const finding = { file: 'a.js', line: 1, severity: 'high', message: 'issue', ruleId: 'r/1', tool: 'semgrep' };
      dispatch.mockResolvedValueOnce([finding]);
      notify.mockRejectedValueOnce(new Error('webhook down'));

      await expect(processJob(baseJob)).resolves.toBeUndefined();
      expect(cleanupWorkspace).toHaveBeenCalledWith('/tmp/layne-test-workspace');
    });

    it('still completes the check run before a notify failure', async () => {
      const finding = { file: 'a.js', line: 1, severity: 'high', message: 'issue', ruleId: 'r/1', tool: 'semgrep' };
      dispatch.mockResolvedValueOnce([finding]);
      notify.mockRejectedValueOnce(new Error('webhook down'));

      await processJob(baseJob);

      expect(completeCheckRun).toHaveBeenCalled();
    });

    it('calls loadScanConfig with owner and repo from the job', async () => {
      await processJob(baseJob);
      expect(loadScanConfig).toHaveBeenCalledWith({ owner: 'org', repo: 'repo' });
    });
  });
});
