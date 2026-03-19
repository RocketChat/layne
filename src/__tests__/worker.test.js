import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies before importing the worker module.
vi.mock('../queue.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  },
  scanQueue: {
    getJobCounts: vi.fn().mockResolvedValue({ wait: 0, active: 0, failed: 0 }),
  },
}));

vi.mock('../metrics.js', () => {
  const makeCounter   = () => ({ inc: vi.fn() });
  const makeHistogram = () => ({ observe: vi.fn(), startTimer: vi.fn(() => vi.fn()) });
  const makeGauge     = () => ({ set: vi.fn() });
  return {
    registry:          null,
    scanTotal:         makeCounter(),
    scanDuration:      makeHistogram(),
    scanTimeoutsTotal: makeCounter(),
    scanRetriesTotal:  makeCounter(),
    findingTotal:      makeCounter(),
    findingPlacementTotal: makeCounter(),
    findingsPerScan:   makeHistogram(),
    webhooksTotal:     makeCounter(),
    queueWaiting:      makeGauge(),
    queueActive:       makeGauge(),
    queueFailed:       makeGauge(),
  };
});

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function() { return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }; }),
}));

vi.mock('../auth.js', () => ({
  getInstallationToken: vi.fn().mockResolvedValue('fake-token'),
}));

vi.mock('../github.js', () => ({
  startCheckRun:    vi.fn().mockResolvedValue(undefined),
  completeCheckRun: vi.fn().mockResolvedValue(undefined),
  ensureLabelsExist: vi.fn().mockResolvedValue(undefined),
  setLabels:         vi.fn().mockResolvedValue(undefined),
  getMergeBaseSha:   vi.fn().mockResolvedValue('merge-base-sha'),
}));

vi.mock('../fetcher.js', () => ({
  createWorkspace:  vi.fn().mockResolvedValue('/tmp/layne-test-workspace'),
  setupRepo:        vi.fn().mockResolvedValue(undefined),
  getChangedFiles:  vi.fn().mockResolvedValue(['src/app.js']),
  getChangedLineRanges: vi.fn().mockResolvedValue({ 'src/app.js': [{ start: 2, end: 4 }] }),
  checkoutFiles:    vi.fn().mockResolvedValue(['src/app.js']),
  cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
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
    semgrep:            { enabled: true, extraArgs: ['--config', 'auto'] },
    trufflehog:         { enabled: true, extraArgs: [] },
    claude:             { enabled: false, model: 'claude-haiku-4-5-20251001' },
    notifications:      {},
    labels:             {},
    comment:            { enabled: false, template: null },
    exceptionApprovers: { users: [], teams: [] },
  }),
}));

vi.mock('../notifiers/index.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../commenter.js', () => ({
  postComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../suppressor.js', () => ({
  suppressFindings: vi.fn(async (findings) => findings),
}));

vi.mock('../location-validator.js', () => ({
  validateFindingLocations: vi.fn(async findings => findings),
}));

vi.mock('../exception-approvals.js', () => ({
  generateFindingId:    vi.fn().mockReturnValue('LAYNE-a3f29c81'),
  loadExceptions:       vi.fn().mockResolvedValue(new Map()),
  buildExceptionSummary: vi.fn(({ baseSummary }) => ({ conclusion: 'failure', summary: baseSummary })),
}));

const { Worker: MockWorker }              = await import('bullmq');
const { getInstallationToken }            = await import('../auth.js');
const { startCheckRun, completeCheckRun, ensureLabelsExist, setLabels, getMergeBaseSha } = await import('../github.js');
const { scanTotal, scanDuration, scanTimeoutsTotal, scanRetriesTotal, findingTotal, findingPlacementTotal, findingsPerScan } = await import('../metrics.js');
const { createWorkspace, setupRepo, getChangedFiles, getChangedLineRanges, checkoutFiles, cleanupWorkspace } = await import('../fetcher.js');
const { dispatch }                        = await import('../dispatcher.js');
const { buildAnnotations }                = await import('../reporter.js');
const { suppressFindings }               = await import('../suppressor.js');
const { validateFindingLocations }        = await import('../location-validator.js');
const { loadScanConfig }                  = await import('../config.js');
const { notify }                          = await import('../notifiers/index.js');
const { postComment }                     = await import('../commenter.js');
const { redis }                           = await import('../queue.js');
const { generateFindingId, loadExceptions, buildExceptionSummary } = await import('../exception-approvals.js');
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

    it('resolves the merge base before setting up the repo', async () => {
      await processJob(baseJob);
      expect(getMergeBaseSha).toHaveBeenCalledWith({
        installationId: 1,
        owner:          'org',
        repo:           'repo',
        base:           'def456',
        head:           'abc123',
      });
    });

    it('creates a workspace and sets up the partial clone using the merge base', async () => {
      await processJob(baseJob);
      expect(createWorkspace).toHaveBeenCalledWith('job-1');
      expect(setupRepo).toHaveBeenCalledWith(expect.objectContaining({
        token:         'fake-token',
        cloneUrl:      'https://github.com/org/repo.git',
        headSha:       'abc123',
        baseSha:       'merge-base-sha',
        workspacePath: '/tmp/layne-test-workspace',
      }));
    });

    it('gets the changed files and checks them out sparsely', async () => {
      await processJob(baseJob);
      expect(getChangedFiles).toHaveBeenCalledWith({
        workspacePath: '/tmp/layne-test-workspace',
        baseSha:       'merge-base-sha',
        headSha:       'abc123',
      });
      expect(getChangedLineRanges).toHaveBeenCalledWith({
        workspacePath: '/tmp/layne-test-workspace',
        baseSha:       'merge-base-sha',
        headSha:       'abc123',
      });
      expect(checkoutFiles).toHaveBeenCalledWith(expect.objectContaining({
        workspacePath: '/tmp/layne-test-workspace',
        headSha:       'abc123',
        files:         ['src/app.js'],
      }));
    });

    it('runs the dispatcher with the job context including changed files', async () => {
      await processJob(baseJob);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
        workspacePath: '/tmp/layne-test-workspace',
        changedFiles:  ['src/app.js'],
        changedLineRanges: { 'src/app.js': [{ start: 2, end: 4 }] },
        baseSha:       'def456',
        baseRef:       'main',
        labels:        [],
        owner:         'org',
        repo:          'repo',
      }));
    });

    it('calls suppressFindings with dispatch output and mergeBaseSha', async () => {
      const rawFindings = [{ file: 'a.js', line: 1, severity: 'high', message: 'x', ruleId: 'r/1', tool: 'semgrep' }];
      dispatch.mockResolvedValueOnce(rawFindings);

      await processJob(baseJob);

      expect(validateFindingLocations).toHaveBeenCalledWith(rawFindings, {
        workspacePath: '/tmp/layne-test-workspace',
        changedFiles:  ['src/app.js'],
        changedLineRanges: { 'src/app.js': [{ start: 2, end: 4 }] },
      });
      expect(suppressFindings).toHaveBeenCalledWith(rawFindings, {
        workspacePath: '/tmp/layne-test-workspace',
        baseSha:       'merge-base-sha',
      });
    });

    it('records placement outcomes after location validation', async () => {
      const rawFindings = [{
        file: 'src/app.js',
        line: 2,
        startLine: 2,
        endLine: 2,
        severity: 'high',
        message: 'x',
        ruleId: 'claude/rule',
        tool: 'claude',
        locationReason: 'validated-claimed-range',
        annotationReason: 'anchored',
        annotationEligible: true,
      }];
      dispatch.mockResolvedValueOnce(rawFindings);

      await processJob(baseJob);

      expect(findingPlacementTotal.inc).toHaveBeenCalledWith({
        tool: 'claude',
        outcome: 'inlineable',
        reason: 'validated-claimed-range',
      });
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
      setupRepo.mockRejectedValueOnce(
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
      setupRepo.mockImplementationOnce(() => new Promise(() => {})); // never resolves

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
      setupRepo.mockImplementationOnce(() => new Promise(() => {})); // never resolves

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
      setupRepo.mockRejectedValueOnce(new Error('git clone failed'));
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
      setupRepo.mockRejectedValueOnce(new Error('git clone failed'));
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

  describe('setupRepo failure', () => {
    it('rethrows when setupRepo throws so BullMQ can retry', async () => {
      setupRepo.mockRejectedValueOnce(new Error('remote not found'));
      await expect(processJob(baseJob)).rejects.toThrow('remote not found');
      expect(completeCheckRun).not.toHaveBeenCalled();
    });

    it('still cleans up the workspace when setupRepo throws', async () => {
      setupRepo.mockRejectedValueOnce(new Error('remote not found'));
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
      checkoutFiles.mockResolvedValueOnce([]);
      await processJob(baseJob);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ changedFiles: [] }));
    });

    it('completes the check run successfully when there are no changed files', async () => {
      getChangedFiles.mockResolvedValueOnce([]);
      checkoutFiles.mockResolvedValueOnce([]);
      await processJob(baseJob);
      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'success' }));
    });
  });

  describe('notifications', () => {
    const finding = { file: 'a.js', line: 1, severity: 'high', message: 'issue', ruleId: 'r/1', tool: 'semgrep' };
    const discardedClaudeFinding = {
      file: 'src/app.js',
      line: 2,
      startLine: 2,
      endLine: 2,
      severity: 'high',
      message: 'candidate',
      ruleId: 'claude/x',
      tool: 'claude',
      locationValidated: false,
      annotationEligible: false,
      locationReason: 'evidence-not-found',
      annotationReason: 'evidence-not-found',
    };

    it('calls notify after completeCheckRun on the first scan with findings', async () => {
      dispatch.mockResolvedValueOnce([finding]);
      redis.get.mockResolvedValueOnce(null); // no previous count

      const callOrder = [];
      completeCheckRun.mockImplementationOnce(async () => { callOrder.push('completeCheckRun'); });
      notify.mockImplementationOnce(async () => { callOrder.push('notify'); });

      await processJob(baseJob);

      expect(callOrder).toEqual(['completeCheckRun', 'notify']);
    });

    it('does not notify when finding count is the same as the previous scan', async () => {
      dispatch.mockResolvedValueOnce([finding]);
      redis.get.mockResolvedValueOnce('1'); // prev count matches

      await processJob(baseJob);
      expect(notify).not.toHaveBeenCalled();
    });

    it('does not notify when finding count decreases', async () => {
      dispatch.mockResolvedValueOnce([finding]);
      redis.get.mockResolvedValueOnce('5'); // prev count was higher

      await processJob(baseJob);
      expect(notify).not.toHaveBeenCalled();
    });

    it('notifies when finding count increases', async () => {
      dispatch.mockResolvedValueOnce([finding, { ...finding, file: 'b.js' }]);
      redis.get.mockResolvedValueOnce('1'); // prev count was lower

      await processJob(baseJob);
      expect(notify).toHaveBeenCalledOnce();
    });

    it('notifies when findings return after reaching zero', async () => {
      dispatch.mockResolvedValueOnce([finding]);
      redis.get.mockResolvedValueOnce('0'); // prev count was zero

      await processJob(baseJob);
      expect(notify).toHaveBeenCalledOnce();
    });

    it('does not notify when there are no findings and no previous count', async () => {
      dispatch.mockResolvedValueOnce([]);
      redis.get.mockResolvedValueOnce(null);

      await processJob(baseJob);
      expect(notify).not.toHaveBeenCalled();
    });

    it('always updates the stored count after a scan', async () => {
      dispatch.mockResolvedValueOnce([finding]);
      redis.get.mockResolvedValueOnce(null);

      await processJob(baseJob);
      expect(redis.set).toHaveBeenCalledWith(
        'layne:scan:count:org/repo#7',
        1,
        'EX',
        expect.any(Number)
      );
    });

    it('stores zero when there are no findings', async () => {
      dispatch.mockResolvedValueOnce([]);
      redis.get.mockResolvedValueOnce('3');

      await processJob(baseJob);
      expect(redis.set).toHaveBeenCalledWith(
        'layne:scan:count:org/repo#7',
        0,
        'EX',
        expect.any(Number)
      );
    });

    it('treats a Redis read error as prevCount=0 and still notifies', async () => {
      dispatch.mockResolvedValueOnce([finding]);
      redis.get.mockRejectedValueOnce(new Error('Redis unavailable'));

      await processJob(baseJob);
      expect(notify).toHaveBeenCalledOnce();
    });

    it('continues normally when Redis write fails', async () => {
      dispatch.mockResolvedValueOnce([finding]);
      redis.get.mockResolvedValueOnce(null);
      redis.set.mockRejectedValueOnce(new Error('Redis unavailable'));

      await expect(processJob(baseJob)).resolves.toBeUndefined();
      expect(notify).toHaveBeenCalledOnce();
    });

    it('passes findings, owner, repo, prNumber, and notificationConfig to notify', async () => {
      dispatch.mockResolvedValueOnce([finding]);
      redis.get.mockResolvedValueOnce(null);

      await processJob(baseJob);
      expect(notify).toHaveBeenCalledWith({
        findings:           [finding],
        owner:              'org',
        repo:               'repo',
        prNumber:           7,
        notificationConfig: {},
        exceptionApproval:  null,
      });
    });

    it('filters discarded Claude candidates out of annotations, notify payloads, and notify counts', async () => {
      dispatch.mockResolvedValueOnce([finding, discardedClaudeFinding]);
      redis.get.mockResolvedValueOnce(null);

      await processJob(baseJob);

      expect(buildAnnotations).toHaveBeenCalledWith([finding]);
      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'success',
        summary: expect.stringContaining('Omitted 1 finding candidate(s)'),
      }));
      expect(notify).toHaveBeenCalledWith({
        findings:           [finding],
        owner:              'org',
        repo:               'repo',
        prNumber:           7,
        notificationConfig: {},
        exceptionApproval:  null,
      });
      expect(redis.set).toHaveBeenCalledWith(
        'layne:scan:count:org/repo#7',
        1,
        'EX',
        expect.any(Number)
      );
    });

    it('does not notify when Claude only returns discarded candidates', async () => {
      dispatch.mockResolvedValueOnce([discardedClaudeFinding]);
      redis.get.mockResolvedValueOnce(null);

      await processJob(baseJob);

      expect(buildAnnotations).toHaveBeenCalledWith([]);
      expect(notify).not.toHaveBeenCalled();
      expect(redis.set).toHaveBeenCalledWith(
        'layne:scan:count:org/repo#7',
        0,
        'EX',
        expect.any(Number)
      );
    });

    it('does not throw and still cleans up the workspace when notify rejects', async () => {
      dispatch.mockResolvedValueOnce([finding]);
      redis.get.mockResolvedValueOnce(null);
      notify.mockRejectedValueOnce(new Error('webhook down'));

      await expect(processJob(baseJob)).resolves.toBeUndefined();
      expect(cleanupWorkspace).toHaveBeenCalledWith('/tmp/layne-test-workspace');
    });

    it('calls loadScanConfig with owner and repo from the job', async () => {
      await processJob(baseJob);
      expect(loadScanConfig).toHaveBeenCalledWith({ owner: 'org', repo: 'repo' });
    });
  });

  describe('label management', () => {
    it('does not call setLabels when labels config is empty', async () => {
      await processJob(baseJob);
      expect(setLabels).not.toHaveBeenCalled();
    });

    it('adds onFailure labels and removes removeOnFailure labels when conclusion is failure', async () => {
      loadScanConfig.mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {},
        labels: { onFailure: ['needs-security-review'], removeOnFailure: ['security-ok'] },
        comment: { enabled: false, template: null },
      });
      // reporter returns failure
      const { buildAnnotations } = await import('../reporter.js');
      buildAnnotations.mockReturnValueOnce({ annotations: [], conclusion: 'failure', summary: 'Issues found.' });

      await processJob(baseJob);

      expect(ensureLabelsExist).toHaveBeenCalledWith(expect.objectContaining({
        labelNames: ['needs-security-review'],
      }));
      expect(setLabels).toHaveBeenCalledWith(expect.objectContaining({
        add:    ['needs-security-review'],
        remove: ['security-ok'],
        owner:  'org',
        repo:   'repo',
        prNumber: 7,
      }));
    });

    it('adds onSuccess labels and removes removeOnSuccess labels when conclusion is success', async () => {
      loadScanConfig.mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {},
        labels: { onSuccess: ['security-ok'], removeOnSuccess: ['needs-security-review'] },
        comment: { enabled: false, template: null },
      });

      await processJob(baseJob);

      expect(setLabels).toHaveBeenCalledWith(expect.objectContaining({
        add:    ['security-ok'],
        remove: ['needs-security-review'],
      }));
    });

    it('does not call setLabels when both add and remove arrays are empty for the conclusion', async () => {
      loadScanConfig.mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {},
        labels: { onFailure: ['needs-security-review'] }, // only onFailure; conclusion is success
        comment: { enabled: false, template: null },
      });

      await processJob(baseJob); // conclusion defaults to success
      expect(setLabels).not.toHaveBeenCalled();
    });

    it('scan still completes when setLabels throws', async () => {
      loadScanConfig.mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {},
        labels: { onSuccess: ['security-ok'], removeOnSuccess: ['needs-security-review'] },
        comment: { enabled: false, template: null },
      });
      setLabels.mockRejectedValueOnce(new Error('GitHub API down'));

      await expect(processJob(baseJob)).resolves.toBeUndefined();
    });
  });

  describe('PR comment', () => {
    const finding = { file: 'a.js', line: 1, severity: 'high', message: 'issue', ruleId: 'r/1', tool: 'semgrep' };
    const discardedClaudeFinding = {
      file: 'src/app.js',
      line: 2,
      startLine: 2,
      endLine: 2,
      severity: 'high',
      message: 'candidate',
      ruleId: 'claude/x',
      tool: 'claude',
      locationValidated: false,
      annotationEligible: false,
      locationReason: 'evidence-not-found',
      annotationReason: 'evidence-not-found',
    };

    it('does not call postComment when comment.enabled is false (default)', async () => {
      await processJob(baseJob);
      expect(postComment).not.toHaveBeenCalled();
    });

    it('calls postComment when comment.enabled is true', async () => {
      loadScanConfig.mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {},
        comment: { enabled: true, template: null },
      });

      await processJob(baseJob);
      expect(postComment).toHaveBeenCalledOnce();
    });

    it('passes findings, owner, repo, prNumber, installationId, conclusion, and commentConfig to postComment', async () => {
      loadScanConfig.mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {},
        comment: { enabled: true, template: null },
      });
      dispatch.mockResolvedValueOnce([finding]);

      await processJob(baseJob);

      expect(postComment).toHaveBeenCalledWith({
        findings:      [finding],
        owner:         'org',
        repo:          'repo',
        prNumber:      7,
        installationId: 1,
        conclusion:    'success',
        commentConfig: { enabled: true, template: null },
      });
    });

    it('passes only actionable findings to postComment', async () => {
      loadScanConfig.mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {},
        comment: { enabled: true, template: null },
      });
      dispatch.mockResolvedValueOnce([finding, discardedClaudeFinding]);

      await processJob(baseJob);

      expect(postComment).toHaveBeenCalledWith({
        findings:      [finding],
        owner:         'org',
        repo:          'repo',
        prNumber:      7,
        installationId: 1,
        conclusion:    'success',
        commentConfig: { enabled: true, template: null },
      });
    });

    it('does not throw and still completes when postComment rejects', async () => {
      loadScanConfig.mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {},
        comment: { enabled: true, template: null },
      });
      postComment.mockRejectedValueOnce(new Error('API down'));

      await expect(processJob(baseJob)).resolves.toBeUndefined();
    });
  });

  describe('metrics', () => {
    it('starts a scan duration timer on every job', async () => {
      await processJob(baseJob);
      expect(scanDuration.startTimer).toHaveBeenCalled();
    });

    it('increments scanTotal with conclusion=success on a successful scan', async () => {
      await processJob(baseJob);
      expect(scanTotal.inc).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'success',
        owner:      'org',
        repo:       'repo',
      }));
    });

    it('increments scanTotal with conclusion=failure on the final failed attempt', async () => {
      setupRepo.mockRejectedValueOnce(new Error('git clone failed'));
      await expect(processJob({ ...baseJob, attemptsMade: 1 })).rejects.toThrow('git clone failed');
      expect(scanTotal.inc).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
    });

    it('does not increment scanTotal on a non-final failed attempt', async () => {
      setupRepo.mockRejectedValueOnce(new Error('git clone failed'));
      await expect(processJob(baseJob)).rejects.toThrow('git clone failed');
      expect(scanTotal.inc).not.toHaveBeenCalled();
    });

    it('increments findingTotal for each finding with severity, tool, owner, repo', async () => {
      const finding = { file: 'a.js', line: 1, severity: 'high', message: 'issue', ruleId: 'r/1', tool: 'semgrep' };
      dispatch.mockResolvedValueOnce([finding]);
      redis.get.mockResolvedValueOnce(null);

      await processJob(baseJob);

      expect(findingTotal.inc).toHaveBeenCalledWith({
        severity: 'high',
        tool:     'semgrep',
        owner:    'org',
        repo:     'repo',
      });
    });

    it('does not increment findingTotal for discarded Claude candidates', async () => {
      dispatch.mockResolvedValueOnce([{
        file: 'src/app.js',
        line: 2,
        startLine: 2,
        endLine: 2,
        severity: 'high',
        message: 'candidate',
        ruleId: 'claude/x',
        tool: 'claude',
        locationValidated: false,
        annotationEligible: false,
        locationReason: 'evidence-not-found',
        annotationReason: 'evidence-not-found',
      }]);
      redis.get.mockResolvedValueOnce(null);

      await processJob(baseJob);

      expect(findingTotal.inc).not.toHaveBeenCalled();
    });

    it('records findingsPerScan with the finding count and conclusion', async () => {
      await processJob(baseJob);
      expect(findingsPerScan.observe).toHaveBeenCalledWith({ conclusion: 'success' }, 0);
    });

    it('increments scanTimeoutsTotal on timeout', async () => {
      vi.useFakeTimers();
      setupRepo.mockImplementationOnce(() => new Promise(() => {}));

      const jobPromise = processJob(baseJob);
      const assertRejection = expect(jobPromise).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      await assertRejection;

      expect(scanTimeoutsTotal.inc).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('increments scanRetriesTotal on a non-final failed attempt', async () => {
      setupRepo.mockRejectedValueOnce(new Error('git clone failed'));
      await expect(processJob(baseJob)).rejects.toThrow('git clone failed');
      expect(scanRetriesTotal.inc).toHaveBeenCalled();
    });

    it('does not increment scanRetriesTotal on the final failed attempt', async () => {
      setupRepo.mockRejectedValueOnce(new Error('git clone failed'));
      await expect(processJob({ ...baseJob, attemptsMade: 1 })).rejects.toThrow('git clone failed');
      expect(scanRetriesTotal.inc).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // exception approvals
  // -------------------------------------------------------------------------

  describe('exception approvals', () => {
    const finding = { file: 'a.js', line: 1, severity: 'high', message: 'issue', ruleId: 'r/1', tool: 'semgrep' };

    beforeEach(() => {
      vi.clearAllMocks();
      buildAnnotations.mockReturnValue({ annotations: [], conclusion: 'failure', summary: 'Issues found.' });
      dispatch.mockResolvedValue([finding]);
      loadScanConfig.mockResolvedValue({
        semgrep:            { enabled: true, extraArgs: [] },
        trufflehog:         { enabled: true, extraArgs: [] },
        claude:             { enabled: false },
        notifications:      {},
        labels:             {},
        comment:            { enabled: false, template: null },
        exceptionApprovers: { users: ['alice'], teams: [] },
      });
      generateFindingId.mockReturnValue('LAYNE-a3f29c81');
      loadExceptions.mockResolvedValue(new Map());
      buildExceptionSummary.mockImplementation(({ baseSummary }) => ({ conclusion: 'failure', summary: baseSummary }));
    });

    it('stamps _findingId on each actionable finding', async () => {
      await processJob(baseJob);
      expect(generateFindingId).toHaveBeenCalledWith(expect.objectContaining({ file: 'a.js' }));
    });

    it('does not call loadExceptions when exceptionApprovers is empty', async () => {
      loadScanConfig.mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {}, comment: { enabled: false, template: null },
        exceptionApprovers: { users: [], teams: [] },
      });

      await processJob(baseJob);
      expect(loadExceptions).not.toHaveBeenCalled();
      expect(buildExceptionSummary).not.toHaveBeenCalled();
    });

    it('calls loadExceptions with the blocking finding IDs when approvers are configured', async () => {
      await processJob(baseJob);

      expect(loadExceptions).toHaveBeenCalledWith(expect.objectContaining({
        owner:      'org',
        repo:       'repo',
        prNumber:   7,
        headSha:    'abc123',
        findingIds: ['LAYNE-a3f29c81'],
      }));
    });

    it('does not call loadExceptions when there are no blocking findings', async () => {
      const lowFinding = { ...finding, severity: 'low' };
      dispatch.mockResolvedValueOnce([lowFinding]);
      buildAnnotations.mockReturnValueOnce({ annotations: [], conclusion: 'success', summary: 'Low only.' });

      await processJob(baseJob);
      expect(loadExceptions).not.toHaveBeenCalled();
    });

    it('overrides conclusion and summary from buildExceptionSummary', async () => {
      buildExceptionSummary.mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted summary.' });

      await processJob(baseJob);

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'success',
        summary:    'Excepted summary.',
      }));
    });

    it('sets exceptionApproval when all blocking findings are excepted (success + exceptions.size > 0)', async () => {
      const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'test', timestamp: '' }]]);
      loadExceptions.mockResolvedValueOnce(exceptions);
      buildExceptionSummary.mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted.' });

      await processJob(baseJob);

      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        exceptionApproval: expect.objectContaining({ approved: true, approver: 'alice' }),
      }));
    });

    it('keeps exceptionApproval null when conclusion is failure (partial or no exceptions)', async () => {
      buildExceptionSummary.mockReturnValueOnce({ conclusion: 'failure', summary: 'Still failing.' });

      await processJob(baseJob);

      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        exceptionApproval: null,
      }));
    });

    it('keeps conclusion as failure when loadExceptions throws (fail closed)', async () => {
      loadExceptions.mockRejectedValueOnce(new Error('Redis down'));
      buildExceptionSummary.mockReturnValueOnce({ conclusion: 'failure', summary: 'Issues found.' });

      await processJob(baseJob);

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'failure',
      }));
    });

    it('uses onException labels when exception is approved', async () => {
      const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'ok', timestamp: '' }]]);
      loadExceptions.mockResolvedValueOnce(exceptions);
      buildExceptionSummary.mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted.' });
      loadScanConfig.mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, comment: { enabled: false, template: null },
        exceptionApprovers: { users: ['alice'], teams: [] },
        labels: {
          onFailure:         ['needs-review'],
          onException:       ['security-exception-used'],
          removeOnException: ['needs-review'],
        },
      });

      await processJob(baseJob);

      expect(setLabels).toHaveBeenCalledWith(expect.objectContaining({
        add:    ['security-exception-used'],
        remove: ['needs-review'],
      }));
    });

    it('always notifies when exception is approved, even if finding count did not increase', async () => {
      const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'ok', timestamp: '' }]]);
      loadExceptions.mockResolvedValueOnce(exceptions);
      buildExceptionSummary.mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted.' });
      redis.get.mockResolvedValueOnce('1'); // same count as current finding

      await processJob(baseJob);

      expect(notify).toHaveBeenCalledOnce();
    });

    it('passes exceptionApproval: null to notify when no exception approvers are configured', async () => {
      loadScanConfig.mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {}, comment: { enabled: false, template: null },
        exceptionApprovers: { users: [], teams: [] },
      });
      buildAnnotations.mockReturnValueOnce({ annotations: [], conclusion: 'failure', summary: 'Issues found.' });
      redis.get.mockResolvedValueOnce(null); // prevCount = 0, finding count = 1 -> will notify

      await processJob(baseJob);

      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        exceptionApproval: null,
      }));
    });
  });
});
