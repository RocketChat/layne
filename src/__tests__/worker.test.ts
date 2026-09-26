import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { AdapterStatuses, JobData, SpectreScanStatus } from '../types.js';

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
    spectreScansTotal: makeCounter(),
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
  getGitChanges:     vi.fn().mockResolvedValue([{ status: 'modified', oldPath: 'src/app.js', newPath: 'src/app.js', oldMode: '100644', newMode: '100644', oldOid: 'a', newOid: 'b', oldKind: 'regular', newKind: 'regular' }]),
  getUnifiedDiff: vi.fn().mockResolvedValue({
    files: [{
      change: { status: 'modified', oldPath: 'src/app.js', newPath: 'src/app.js', oldMode: '100644', newMode: '100644', oldOid: 'a', newOid: 'b', oldKind: 'regular', newKind: 'regular' },
      hunks: [{
        oldStart: 2, oldCount: 0, newStart: 2, newCount: 3, section: '',
        lines: [2, 3, 4].map(newLine => ({ type: 'addition', content: `line ${newLine}`, oldLine: null, newLine })),
      }],
    }],
  }),
  checkoutGitChanges: vi.fn().mockResolvedValue({ changes: [], files: ['src/app.js'], issues: [] }),
  cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../dispatcher.js', () => ({
  dispatch: vi.fn(),
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
    mode:               'changed_files',
    contextLines:       8,
    timeoutMinutes:     10,
    semgrep:            { enabled: true, extraArgs: ['--config', 'auto'] },
    trufflehog:         { enabled: true, extraArgs: [] },
    claude:             { enabled: false, model: 'claude-haiku-4-5-20251001' },
    spectre:            { enabled: true, provider: 'anthropic', model: 'test-model' },
    depDoctor:          { enabled: false, minCveSeverity: 'high', checkAbandoned: true, abandonedDays: 730, checkDeprecated: true, extraArgs: [] },
    notifications:      {},
    labels:             {},
    comment:            { enabled: false, template: null },
    exceptionApprovers: { users: [], teams: [] },
  }),
}));

vi.mock('../scan-context.js', () => ({
  createScanContext: vi.fn().mockResolvedValue({
    mode:              'changed_files',
    contextLines:      8,
    headSha:           'test-head-sha',
    baseSha:           'merge-base-sha',
    repoWorkspacePath: '/tmp/layne-test-workspace',
    scanWorkspacePath: '/tmp/layne-test-workspace',
    sourceFiles:       ['src/app.js'],
    scanFiles:         ['src/app.js'],
    promptFiles:       [],
    changedLineRanges: new Map(),
  }),
  filterFindingsToChangedLines: vi.fn((findings: unknown[]) => findings),
}));

vi.mock('../notifiers/index.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../commenter.js', () => ({
  postComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../suppressor.js', () => ({
  suppressFindings: vi.fn(async (findings: unknown[]) => findings),
}));

vi.mock('../location-validator.js', () => ({
  validateFindingLocations: vi.fn(async (findings: unknown[]) => findings),
  applyAdapterValidationCoverage: vi.fn((statuses: Record<string, Record<string, unknown>>, findings: Array<{ tool?: string; locationValidated?: boolean }>) => {
    let rejectedTotal = 0;
    for (const tool of ['claude', 'spectre']) {
      const status = statuses[tool];
      if (status.outcome === 'disabled') continue;
      const rejected = findings.filter(finding => finding.tool === tool && finding.locationValidated !== true).length;
      if (rejected > 0) {
        if (tool === 'spectre') status.rejectedFindings = Number(status.rejectedFindings ?? 0) + rejected;
        status.outcome = 'incomplete';
        status.reason ??= 'finding-validation-rejected';
        rejectedTotal += rejected;
      }
    }
    return rejectedTotal;
  }),
}));

vi.mock('../exception-approvals.js', () => ({
  generateFindingId:        vi.fn().mockReturnValue('LAYNE-a3f29c81'),
  loadExceptions:           vi.fn().mockResolvedValue(new Map()),
  filterStaleExceptions:    vi.fn(async ({ exceptions }: { exceptions: Map<string, unknown> }) => exceptions),
  materializeBulkExceptionRequest: vi.fn(async ({ findingIds, requestId, approvedHeadSha }: { findingIds: string[]; requestId: string; approvedHeadSha: string }) => ({
    requestId, approvedHeadSha, findingIds, state: 'materialized', approver: 'alice', reason: 'bulk', timestamp: '',
  })),
  resolveDriftedExceptions: vi.fn(async () => new Map()),
  buildExceptionSummary:    vi.fn(({ baseSummary }: { baseSummary: string }) => ({ conclusion: 'failure', summary: baseSummary })),
}));

const { Worker: MockWorker }              = await import('bullmq');
const { getInstallationToken }            = await import('../auth.js');
const { startCheckRun, completeCheckRun, ensureLabelsExist, setLabels, getMergeBaseSha } = await import('../github.js');
const { scanTotal, scanDuration, scanTimeoutsTotal, scanRetriesTotal, findingTotal, findingPlacementTotal, findingsPerScan, spectreScansTotal } = await import('../metrics.js');
const { createWorkspace, setupRepo, getGitChanges, getUnifiedDiff, checkoutGitChanges, cleanupWorkspace } = await import('../fetcher.js');
const { dispatch }                        = await import('../dispatcher.js');
const { buildAnnotations }                = await import('../reporter.js');
const { suppressFindings }               = await import('../suppressor.js');
const { validateFindingLocations }        = await import('../location-validator.js');
const { loadScanConfig }                  = await import('../config.js');
const { notify }                          = await import('../notifiers/index.js');
const { postComment }                     = await import('../commenter.js');
const { generateFindingId, loadExceptions, filterStaleExceptions, materializeBulkExceptionRequest, resolveDriftedExceptions, buildExceptionSummary } = await import('../exception-approvals.js');
const { createScanContext, filterFindingsToChangedLines } = await import('../scan-context.js');
const { processJob, shutdown, startWorker } = await import('../worker.js');

// ---

const baseJob = {
  id:   'job-1',
  attemptsMade: 0,
  opts: { attempts: 2 },
  data: {
    installationId: 1,
    repositoryId:   2,
    owner:          'org',
    repo:           'repo',
    cloneUrl:       'https://github.com/org/repo.git',
    headSha:        'abc123',
    headRef:        'feature/x',
    baseSha:        'def456',
    baseRef:        'main',
    prNumber:       7,
    labels:         [] as string[],
    checkRunId:     99,
  },
} as unknown as Job<JobData, unknown, string>;

const COMPLETE_SPECTRE_STATUS = {
  outcome: 'complete',
  selected: 1,
  scanned: 1,
  skipped: 0,
  oversized: 0,
  capped: 0,
  truncated: 0,
  failed: 0,
  invalidResponses: 0,
  cancelled: 0,
  rateLimited: 0,
  concurrencyLimited: 0,
  circuitOpen: 0,
  rejectedFindings: 0,
  plannedChunks: 1,
  attemptedChunks: 1,
  completedChunks: 1,
  cappedChunks: 0,
  truncatedHunks: 0,
  contextGaps: 0,
} satisfies SpectreScanStatus;

type StatusOverrides = {
  [Tool in keyof AdapterStatuses]?: Partial<AdapterStatuses[Tool]>;
};

function dispatchResult(findings: unknown[] = [], overrides: StatusOverrides = {}) {
  return {
    findings,
    statuses: {
      semgrep: { outcome: 'complete', ...overrides.semgrep },
      trufflehog: { outcome: 'complete', ...overrides.trufflehog },
      claude: { outcome: 'disabled', ...overrides.claude },
      spectre: { ...COMPLETE_SPECTRE_STATUS, ...overrides.spectre },
      'dep-doctor': { outcome: 'disabled', ...overrides['dep-doctor'] },
    } satisfies AdapterStatuses,
  };
}

function incompleteSpectreResult() {
  return dispatchResult([], {
    spectre: {
      outcome: 'incomplete',
      scanned: 0,
      failed: 1,
      completedChunks: 0,
      reason: 'provider-or-file-failure',
    },
  });
}

function highRiskCappedSpectreResult(findings: unknown[] = []) {
  return dispatchResult(findings, {
    spectre: {
      outcome: 'incomplete',
      capped: 3,
      highRiskCapped: 3,
      highRiskCappedFiles: [
        { file: 'crates/a/build.rs', score: 36, signals: ['automatic-execution'] },
        { file: '.github/workflows/release.yml', score: 22, signals: [] },
      ],
      reason: 'high-risk-file-cap-exceeded',
    },
  });
}

describe('shutdown()', () => {
  it('does not create the BullMQ worker until startup is explicit, then closes it', async () => {
    expect(MockWorker).not.toHaveBeenCalled();
    startWorker();
    const workerInstance = (MockWorker as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    await shutdown();
    expect(workerInstance.close).toHaveBeenCalled();
  });
});

describe('processJob()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (dispatch as ReturnType<typeof vi.fn>).mockResolvedValue(dispatchResult());
  });

  describe('successful scan', () => {
    it('marks the check run as in_progress at the start', async () => {
      await processJob(baseJob);
      expect(startCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        installationId: 1, owner: 'org', repo: 'repo', checkRunId: 99,
      }));
    });

    it('fetches an installation token', async () => {
      await processJob(baseJob);
      expect(getInstallationToken).toHaveBeenCalledWith(1, expect.any(AbortSignal));
    });

    it('resolves the merge base before setting up the repo', async () => {
      await processJob(baseJob);
      expect(getMergeBaseSha).toHaveBeenCalledWith(expect.objectContaining({
        installationId: 1,
        owner:          'org',
        repo:           'repo',
        base:           'def456',
        head:           'abc123',
        signal:          expect.any(AbortSignal),
      }));
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
      expect(getGitChanges).toHaveBeenCalledWith(expect.objectContaining({
        workspacePath: '/tmp/layne-test-workspace',
        baseSha:       'merge-base-sha',
        headSha:       'abc123',
        signal:        expect.any(AbortSignal),
      }));
      expect(getUnifiedDiff).toHaveBeenCalledWith(expect.objectContaining({
        workspacePath: '/tmp/layne-test-workspace',
        baseSha:       'merge-base-sha',
        headSha:       'abc123',
        contextLines:   8,
        changes:        expect.any(Array),
        signal:        expect.any(AbortSignal),
      }));
      expect(checkoutGitChanges).toHaveBeenCalledWith(expect.objectContaining({
        workspacePath: '/tmp/layne-test-workspace',
        headSha:       'abc123',
        changes:       expect.any(Array),
      }));
    });

    it('runs the dispatcher with scan context and changed line ranges', async () => {
      await processJob(baseJob);
      expect(createScanContext).toHaveBeenCalledWith(expect.objectContaining({
        signal: expect.any(AbortSignal),
      }));
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
        scanContext: expect.objectContaining({
          mode:              'changed_files',
          scanWorkspacePath: '/tmp/layne-test-workspace',
          scanFiles:         ['src/app.js'],
          repoWorkspacePath: '/tmp/layne-test-workspace',
        }),
        changedLineRanges: new Map([['src/app.js', [{ start: 2, end: 4 }]]]),
        owner: 'org',
        repo:  'repo',
        spectreCacheContext: {
          installationId: 1,
          repositoryId: 2,
          prNumber: 7,
          baseSha: 'merge-base-sha',
        },
      }));
    });

    it('disables Spectre caching for legacy jobs without an immutable repository ID', async () => {
      const legacyJob = {
        ...baseJob,
        data: { ...baseJob.data, repositoryId: undefined },
      } as unknown as Job<JobData, unknown, string>;

      await processJob(legacyJob);

      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ spectreCacheContext: undefined }));
    });

    it('applies diff filter and validates findings using the repo workspace', async () => {
      const rawFindings = [{ file: 'a.js', line: 1, severity: 'high', message: 'x', ruleId: 'r/1', tool: 'semgrep' }];
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult(rawFindings));

      await processJob(baseJob);

      expect(filterFindingsToChangedLines).toHaveBeenCalledWith(rawFindings, expect.objectContaining({ mode: 'changed_files' }));
      expect(validateFindingLocations).toHaveBeenCalledWith(rawFindings, expect.objectContaining({
        workspacePath: '/tmp/layne-test-workspace',
        changedFiles:  ['src/app.js'],
        changedLineRanges: new Map([['src/app.js', [{ start: 2, end: 4 }]]]),
        signal:            expect.any(AbortSignal),
      }));
      expect(suppressFindings).toHaveBeenCalledWith(rawFindings, expect.objectContaining({
        workspacePath: '/tmp/layne-test-workspace',
        baseSha:       'merge-base-sha',
        headSha:       'abc123',
        signal:        expect.any(AbortSignal),
      }));
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
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult(rawFindings));

      await processJob(baseJob);

      expect((findingPlacementTotal as { inc: ReturnType<typeof vi.fn> }).inc).toHaveBeenCalledWith({
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

    it('reports neutral coverage when a changed Git object is unsupported', async () => {
      const change = { status: 'added', oldPath: null, newPath: 'vendor/lib', oldMode: '000000', newMode: '160000', oldOid: '0', newOid: 'b', oldKind: 'absent', newKind: 'submodule' };
      (getGitChanges as ReturnType<typeof vi.fn>).mockResolvedValueOnce([change]);
      (checkoutGitChanges as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        changes: [change], files: [],
        issues: [{ change, disposition: 'unsupported', reason: 'head-submodule' }],
      });

      await processJob(baseJob);

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'neutral',
        summary: expect.stringContaining('1 unsupported'),
      }));
    });
  });

  describe('token sanitization', () => {
    it('redacts installation tokens from error messages in the check run summary', async () => {
      (setupRepo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("fatal: repository 'https://x-access-token:ghs_secrettoken@github.com/org/repo.git' not found")
      );
      await expect(processJob({ ...baseJob, attemptsMade: 1 } as unknown as Job<JobData, unknown, string>)).rejects.toThrow('not found');
      const summary = (completeCheckRun as ReturnType<typeof vi.fn>).mock.calls[0][0].summary as string;
      expect(summary).not.toContain('ghs_secrettoken');
      expect(summary).toContain('[REDACTED]');
    });
  });

  describe('scan timeout', () => {
    it('bounds a hung terminal publication and never races a second terminal update', async () => {
      vi.useFakeTimers();
      (completeCheckRun as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {}));

      const jobPromise = processJob({ ...baseJob, attemptsMade: 1 } as unknown as Job<JobData, unknown, string>);
      const assertRejection = expect(jobPromise).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      await assertRejection;

      expect(completeCheckRun).toHaveBeenCalledTimes(1);
      expect(postComment).not.toHaveBeenCalled();
      expect(setLabels).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({ internalError: expect.objectContaining({ errorId: expect.any(String) }) }),
      }));
      vi.useRealTimers();
    });

    it('bounds final-attempt error publication with an independent timeout', async () => {
      vi.useFakeTimers();
      (setupRepo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('git clone failed'));
      (completeCheckRun as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {}));

      const jobPromise = processJob({ ...baseJob, attemptsMade: 1 } as unknown as Job<JobData, unknown, string>);
      const assertRejection = expect(jobPromise).rejects.toThrow('git clone failed');
      await vi.advanceTimersByTimeAsync(10_001);
      await assertRejection;

      expect(completeCheckRun).toHaveBeenCalledTimes(1);
      const publication = (completeCheckRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as { signal: AbortSignal };
      expect(publication.signal.aborted).toBe(true);
      vi.useRealTimers();
    });

    it('cancels a hung comment after successful publication without retrying', async () => {
      vi.useFakeTimers();
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mode: 'changed_files', contextLines: 8, timeoutMinutes: 10,
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, spectre: { enabled: false }, depDoctor: { enabled: false },
        notifications: {}, labels: {}, comment: { enabled: true, template: null },
        exceptionApprovers: { users: [], teams: [] },
      });
      let commentSignal: AbortSignal | undefined;
      (postComment as ReturnType<typeof vi.fn>).mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => {
        commentSignal = signal;
        return new Promise(() => {});
      });

      const jobPromise = processJob(baseJob);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      await expect(jobPromise).resolves.toBeUndefined();

      expect(completeCheckRun).toHaveBeenCalledTimes(1);
      expect(commentSignal?.aborted).toBe(true);
      expect(setLabels).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it('absorbs notification cancellation while another side effect is hung', async () => {
      vi.useFakeTimers();
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mode: 'changed_files', contextLines: 8, timeoutMinutes: 10,
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, spectre: { enabled: false }, depDoctor: { enabled: false },
        notifications: {}, labels: {}, comment: { enabled: true, template: null },
        exceptionApprovers: { users: [], teams: [] },
      });
      (notify as ReturnType<typeof vi.fn>).mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      (postComment as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {}));

      const jobPromise = processJob(baseJob);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);

      await expect(jobPromise).resolves.toBeUndefined();
      expect(completeCheckRun).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it('cancels hung label management after successful publication without retrying', async () => {
      vi.useFakeTimers();
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mode: 'changed_files', contextLines: 8, timeoutMinutes: 10,
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, spectre: { enabled: false }, depDoctor: { enabled: false },
        notifications: {}, labels: { onSuccess: ['security-ok'] }, comment: { enabled: false, template: null },
        exceptionApprovers: { users: [], teams: [] },
      });
      let labelSignal: AbortSignal | undefined;
      (ensureLabelsExist as ReturnType<typeof vi.fn>).mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => {
        labelSignal = signal;
        return new Promise(() => {});
      });

      const jobPromise = processJob(baseJob);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      await expect(jobPromise).resolves.toBeUndefined();

      expect(completeCheckRun).toHaveBeenCalledTimes(1);
      expect(labelSignal?.aborted).toBe(true);
      expect(setLabels).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it('cancels a hung notification after successful publication without retrying', async () => {
      vi.useFakeTimers();
      const finding = { file: 'a.js', line: 1, severity: 'high', message: 'issue', ruleId: 'r/1', tool: 'semgrep' };
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding]));
      let notificationSignal: AbortSignal | undefined;
      (notify as ReturnType<typeof vi.fn>).mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => {
        notificationSignal = signal;
        return new Promise(() => {});
      });

      const jobPromise = processJob(baseJob);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      await expect(jobPromise).resolves.toBeUndefined();

      expect(completeCheckRun).toHaveBeenCalledTimes(1);
      expect(notificationSignal?.aborted).toBe(true);
      vi.useRealTimers();
    });

    it('rethrows timeout errors so BullMQ can retry the job', async () => {
      vi.useFakeTimers();
      (setupRepo as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {})); // never resolves

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
      (setupRepo as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {})); // never resolves

      const jobPromise = processJob({ ...baseJob, attemptsMade: 1 } as unknown as Job<JobData, unknown, string>);

      const assertRejection = expect(jobPromise).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      await assertRejection;

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'failure',
        summary:    expect.stringContaining('timed out'),
      }));

      vi.useRealTimers();
    });

    it('prevents a detached scan from publishing after the timeout wins', async () => {
      vi.useFakeTimers();
      let resolveDispatch!: (result: ReturnType<typeof dispatchResult>) => void;
      let dispatchSignal: AbortSignal | undefined;
      (dispatch as ReturnType<typeof vi.fn>).mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => new Promise(resolve => {
        dispatchSignal = signal;
        resolveDispatch = resolve;
      }));

      const jobPromise = processJob({ ...baseJob, attemptsMade: 1 } as unknown as Job<JobData, unknown, string>);
      const assertRejection = expect(jobPromise).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      await assertRejection;
      expect(dispatchSignal?.aborted).toBe(true);

      resolveDispatch(dispatchResult());
      vi.useRealTimers();
      await vi.waitFor(() => expect(cleanupWorkspace).toHaveBeenCalledWith('/tmp/layne-test-workspace'));

      expect(completeCheckRun).toHaveBeenCalledTimes(1);
      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
      expect(postComment).not.toHaveBeenCalled();
      expect(setLabels).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({ internalError: expect.objectContaining({ errorId: expect.any(String) }) }),
      }));
    });
  });

  describe('retryable failures', () => {
    beforeEach(() => {
      (setupRepo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('git clone failed'));
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
      (setupRepo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('git clone failed'));
    });

    it('marks the check run failed on the final attempt', async () => {
      await expect(processJob({ ...baseJob, attemptsMade: 1 } as unknown as Job<JobData, unknown, string>)).rejects.toThrow('git clone failed');

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'failure',
        summary:    expect.stringContaining('git clone failed'),
      }));
    });

    it('swallows completeCheckRun errors and still propagates the original failure', async () => {
      (completeCheckRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('GitHub API down'));

      await expect(processJob({ ...baseJob, attemptsMade: 1 } as unknown as Job<JobData, unknown, string>)).rejects.toThrow('git clone failed');
    });
  });

  describe('setupRepo failure', () => {
    it('rethrows when setupRepo throws so BullMQ can retry', async () => {
      (setupRepo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('remote not found'));
      await expect(processJob(baseJob)).rejects.toThrow('remote not found');
      expect(completeCheckRun).not.toHaveBeenCalled();
    });

    it('still cleans up the workspace when setupRepo throws', async () => {
      (setupRepo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('remote not found'));
      await expect(processJob(baseJob)).rejects.toThrow('remote not found');
      expect(cleanupWorkspace).toHaveBeenCalledWith('/tmp/layne-test-workspace');
    });
  });

  describe('getGitChanges failure', () => {
    it('rethrows when getGitChanges throws so BullMQ can retry', async () => {
      (getGitChanges as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('git diff failed'));
      await expect(processJob(baseJob)).rejects.toThrow('git diff failed');
      expect(completeCheckRun).not.toHaveBeenCalled();
    });
  });

  describe('no changed files', () => {
    it('passes a scan context with empty scanFiles to dispatch when the PR has no file changes', async () => {
      (getGitChanges as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (checkoutGitChanges as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ changes: [], files: [], issues: [] });
      (createScanContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mode: 'changed_files', contextLines: 8, headSha: 'test-head-sha',
        repoWorkspacePath: '/tmp/layne-test-workspace',
        scanWorkspacePath: '/tmp/layne-test-workspace',
        scanFiles: [], promptFiles: [], changedLineRanges: new Map(),
      });
      await processJob(baseJob);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
        scanContext: expect.objectContaining({ scanFiles: [] }),
      }));
    });

    it('completes the check run successfully when there are no changed files', async () => {
      (getGitChanges as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (checkoutGitChanges as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ changes: [], files: [], issues: [] });
      await processJob(baseJob);
      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'success' }));
    });
  });

  describe('adapter statuses', () => {
    it('preserves success when every adapter reports complete', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([], {
        claude: { outcome: 'complete' },
        'dep-doctor': { outcome: 'complete' },
      }));

      await processJob(baseJob);

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'success',
        summary: 'No issues found.',
      }));
    });

    it('demotes an otherwise-successful scan when a non-Spectre adapter is incomplete and names it', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([], {
        trufflehog: { outcome: 'incomplete', reason: 'scanner-execution-failed' },
      }));

      await processJob(baseJob);

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'neutral',
        summary: expect.stringContaining('Adapter coverage incomplete: trufflehog (scanner-execution-failed).'),
      }));
    });

    it('keeps blocking findings as failure when an adapter is also incomplete', async () => {
      const finding = { file: 'a.js', line: 1, severity: 'high', message: 'issue', ruleId: 'r/1', tool: 'semgrep' };
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding], {
        semgrep: { outcome: 'incomplete', reason: 'partial-results' },
      }));
      (buildAnnotations as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        annotations: [], conclusion: 'failure', summary: 'Issues found.',
      });

      await processJob(baseJob);

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'failure',
        summary: expect.stringContaining('Adapter coverage incomplete: semgrep (partial-results).'),
      }));
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

    it('makes a clean conclusion neutral when Spectre evidence validation rejects a provider finding', async () => {
      const candidates = [{
        file: 'src/app.js', line: 2, severity: 'high', message: 'candidate', ruleId: 'spectre/backdoor', tool: 'spectre',
        evidence: 'missing();', locationValidated: false, annotationEligible: false, locationReason: 'evidence-not-found',
      }];
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult(candidates));

      await processJob(baseJob);

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'neutral',
        summary: expect.stringContaining('rejected 1'),
      }));
    });

    it('calls notify after completeCheckRun on the first scan with findings', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding]));

      const callOrder: string[] = [];
      (completeCheckRun as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { callOrder.push('completeCheckRun'); });
      (notify as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { callOrder.push('notify'); });

      await processJob(baseJob);

      expect(callOrder).toEqual(['completeCheckRun', 'notify']);
    });

    it('passes the final finding state to the notifier orchestrator', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding]));
      (buildAnnotations as ReturnType<typeof vi.fn>).mockReturnValueOnce({ annotations: [], conclusion: 'failure', summary: 'Found one.' });

      await processJob(baseJob);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({ conclusion: 'failure', findings: [finding] }),
        owner: 'org',
        repo: 'repo',
        prNumber: 7,
        notificationConfig: {},
        signal: expect.any(AbortSignal),
      }));
    });

    it('passes clean states so the orchestrator can reset recurrence deduplication', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult());
      await processJob(baseJob);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({ conclusion: 'success', findings: [] }),
      }));
    });

    it('passes blocking Spectre coverage even when there are no findings', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(highRiskCappedSpectreResult());
      await processJob(baseJob);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({
          conclusion: 'failure',
          coverageIssues: expect.arrayContaining([
            expect.objectContaining({ level: 'blocking', source: 'spectre', reason: 'high-risk-file-cap-exceeded' }),
          ]),
        }),
      }));
    });

    it('passes incomplete adapter coverage', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([], {
        semgrep: { outcome: 'incomplete', reason: 'tool-unavailable' },
      }));
      await processJob(baseJob);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({
          conclusion: 'neutral',
          coverageIssues: expect.arrayContaining([
            expect.objectContaining({ level: 'incomplete', source: 'semgrep', reason: 'tool-unavailable' }),
          ]),
        }),
      }));
    });

    it('filters discarded Claude candidates out of the notification state', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding, discardedClaudeFinding]));

      await processJob(baseJob);

      expect(buildAnnotations).toHaveBeenCalledWith([finding]);
      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'success',
        summary: expect.stringContaining('Omitted 1 finding candidate(s)'),
      }));
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({ findings: [finding] }),
      }));
    });

    it('passes a quiet state when Claude only returns discarded candidates', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([discardedClaudeFinding]));

      await processJob(baseJob);

      expect(buildAnnotations).toHaveBeenCalledWith([]);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({ conclusion: 'success', findings: [] }),
      }));
    });

    it('does not throw and still cleans up the workspace when notify rejects', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding]));
      (notify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('webhook down'));

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
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {},
        labels: { onFailure: ['needs-security-review'], removeOnFailure: ['security-ok'] },
        comment: { enabled: false, template: null },
      });
      // reporter returns failure
      const { buildAnnotations: ba } = await import('../reporter.js');
      (ba as ReturnType<typeof vi.fn>).mockReturnValueOnce({ annotations: [], conclusion: 'failure', summary: 'Issues found.' });

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
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
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

    it('uses incomplete labels instead of success labels for neutral coverage', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mode: 'changed_files', contextLines: 8, timeoutMinutes: 10,
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, exceptionApprovers: { users: [], teams: [] },
        labels: {
          onSuccess: ['security-ok'], removeOnSuccess: ['needs-security-review'],
          onIncomplete: ['security-scan-incomplete'], removeOnIncomplete: ['security-ok'],
        },
        comment: { enabled: false, template: null },
      });
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(incompleteSpectreResult());

      await processJob(baseJob);

      expect(setLabels).toHaveBeenCalledWith(expect.objectContaining({
        add: ['security-scan-incomplete'], remove: ['security-ok'],
      }));
    });

    it('uses failure labels when Spectre leaves high-risk files unscanned', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mode: 'changed_files', contextLines: 8, timeoutMinutes: 10,
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, exceptionApprovers: { users: [], teams: [] },
        labels: {
          onFailure: ['needs-security-review'], removeOnFailure: ['security-ok'],
          onIncomplete: ['security-scan-incomplete'], removeOnIncomplete: [],
        },
        comment: { enabled: false, template: null },
      });
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(highRiskCappedSpectreResult());

      await processJob(baseJob);

      expect(setLabels).toHaveBeenCalledWith(expect.objectContaining({
        add: ['needs-security-review'], remove: ['security-ok'],
      }));
    });

    it('does not call setLabels when both add and remove arrays are empty for the conclusion', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {},
        labels: { onFailure: ['needs-security-review'] }, // only onFailure; conclusion is success
        comment: { enabled: false, template: null },
      });

      await processJob(baseJob); // conclusion defaults to success
      expect(setLabels).not.toHaveBeenCalled();
    });

    it('scan still completes when setLabels throws', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {},
        labels: { onSuccess: ['security-ok'], removeOnSuccess: ['needs-security-review'] },
        comment: { enabled: false, template: null },
      });
      (setLabels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('GitHub API down'));

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
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {},
        comment: { enabled: true, template: null },
      });

      await processJob(baseJob);
      expect(postComment).toHaveBeenCalledOnce();
    });

    it('passes neutral to comments when Spectre coverage is incomplete', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mode: 'changed_files', contextLines: 8, timeoutMinutes: 10,
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {}, exceptionApprovers: { users: [], teams: [] },
        comment: { enabled: true, template: null },
      });
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(incompleteSpectreResult());

      await processJob(baseJob);

      expect(postComment).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'neutral' }));
      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'neutral', summary: expect.stringContaining('Spectre coverage incomplete: selected 1, scanned 0, skipped 0'),
      }));
    });

    it('fails high-risk Spectre overflow while preserving findings and comment details', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mode: 'changed_files', contextLines: 8, timeoutMinutes: 10,
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {}, exceptionApprovers: { users: [], teams: [] },
        comment: { enabled: true, template: null },
      });
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(highRiskCappedSpectreResult([finding]));

      await processJob(baseJob);

      expect(buildAnnotations).toHaveBeenCalledWith([finding]);
      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'failure',
        summary: expect.stringContaining('<code>crates/a/build.rs</code> - score 36 - automatic-execution'),
      }));
      expect(postComment).toHaveBeenCalledWith(expect.objectContaining({
        findings: [finding],
        conclusion: 'failure',
        coverageFailure: expect.stringContaining('1 additional high-risk file(s)'),
      }));
    });

    it('passes findings, owner, repo, prNumber, installationId, conclusion, and commentConfig to postComment', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {},
        comment: { enabled: true, template: null },
      });
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding]));

      await processJob(baseJob);

      expect(postComment).toHaveBeenCalledWith(expect.objectContaining({
        findings:       [finding],
        owner:          'org',
        repo:           'repo',
        prNumber:       7,
        installationId: 1,
        headSha:        'abc123',
        conclusion:     'success',
        commentConfig:  { enabled: true, template: null },
        signal:         expect.any(AbortSignal),
      }));
    });

    it('passes only actionable findings to postComment', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {},
        comment: { enabled: true, template: null },
      });
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding, discardedClaudeFinding]));

      await processJob(baseJob);

      expect(postComment).toHaveBeenCalledWith(expect.objectContaining({
        findings:       [finding],
        owner:          'org',
        repo:           'repo',
        prNumber:       7,
        installationId: 1,
        headSha:        'abc123',
        conclusion:     'success',
        commentConfig:  { enabled: true, template: null },
        signal:         expect.any(AbortSignal),
      }));
    });

    it('does not throw and still completes when postComment rejects', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {},
        comment: { enabled: true, template: null },
      });
      (postComment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('API down'));

      await expect(processJob(baseJob)).resolves.toBeUndefined();
    });
  });

  describe('metrics', () => {
    it('starts a scan duration timer on every job', async () => {
      await processJob(baseJob);
      expect((scanDuration as unknown as { startTimer: ReturnType<typeof vi.fn> }).startTimer).toHaveBeenCalled();
    });

    it('increments scanTotal with conclusion=success on a successful scan', async () => {
      await processJob(baseJob);
      expect((scanTotal as { inc: ReturnType<typeof vi.fn> }).inc).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'success',
        owner:      'org',
        repo:       'repo',
      }));
    });

    it('increments scanTotal with conclusion=failure on the final failed attempt', async () => {
      (setupRepo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('git clone failed'));
      await expect(processJob({ ...baseJob, attemptsMade: 1 } as unknown as Job<JobData, unknown, string>)).rejects.toThrow('git clone failed');
      expect((scanTotal as { inc: ReturnType<typeof vi.fn> }).inc).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
    });

    it('does not increment scanTotal on a non-final failed attempt', async () => {
      (setupRepo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('git clone failed'));
      await expect(processJob(baseJob)).rejects.toThrow('git clone failed');
      expect((scanTotal as { inc: ReturnType<typeof vi.fn> }).inc).not.toHaveBeenCalled();
    });

    it('increments findingTotal for each finding with severity, tool, owner, repo', async () => {
      const finding = { file: 'a.js', line: 1, severity: 'high', message: 'issue', ruleId: 'r/1', tool: 'semgrep' };
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding]));

      await processJob(baseJob);

      expect((findingTotal as { inc: ReturnType<typeof vi.fn> }).inc).toHaveBeenCalledWith({
        severity: 'high',
        tool:     'semgrep',
        owner:    'org',
        repo:     'repo',
      });
    });

    it('does not increment findingTotal for discarded Claude candidates', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([{
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
      }]));
      await processJob(baseJob);

      expect((findingTotal as { inc: ReturnType<typeof vi.fn> }).inc).not.toHaveBeenCalled();
    });

    it('records findingsPerScan with the finding count and conclusion', async () => {
      await processJob(baseJob);
      expect((findingsPerScan as unknown as { observe: ReturnType<typeof vi.fn> }).observe).toHaveBeenCalledWith({ conclusion: 'success' }, 0);
    });

    it('records bounded provider-labelled Spectre outcome and reason', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(incompleteSpectreResult());

      await processJob(baseJob);

      expect((spectreScansTotal as { inc: ReturnType<typeof vi.fn> }).inc).toHaveBeenCalledWith({
        provider: 'anthropic',
        outcome: 'incomplete',
        reason: 'provider-or-file-failure',
      });
    });

    it('records the bounded high-risk file-cap reason', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(highRiskCappedSpectreResult());

      await processJob(baseJob);

      expect((spectreScansTotal as { inc: ReturnType<typeof vi.fn> }).inc).toHaveBeenCalledWith({
        provider: 'anthropic',
        outcome: 'incomplete',
        reason: 'high-risk-file-cap-exceeded',
      });
    });

    it('increments scanTimeoutsTotal on timeout', async () => {
      vi.useFakeTimers();
      (setupRepo as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {}));

      const jobPromise = processJob(baseJob);
      const assertRejection = expect(jobPromise).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      await assertRejection;

      expect((scanTimeoutsTotal as { inc: ReturnType<typeof vi.fn> }).inc).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('increments scanRetriesTotal on a non-final failed attempt', async () => {
      (setupRepo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('git clone failed'));
      await expect(processJob(baseJob)).rejects.toThrow('git clone failed');
      expect((scanRetriesTotal as { inc: ReturnType<typeof vi.fn> }).inc).toHaveBeenCalled();
    });

    it('does not increment scanRetriesTotal on the final failed attempt', async () => {
      (setupRepo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('git clone failed'));
      await expect(processJob({ ...baseJob, attemptsMade: 1 } as unknown as Job<JobData, unknown, string>)).rejects.toThrow('git clone failed');
      expect((scanRetriesTotal as { inc: ReturnType<typeof vi.fn> }).inc).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // exception approvals
  // -------------------------------------------------------------------------

  describe('exception approvals', () => {
    const finding = { file: 'a.js', line: 1, severity: 'high', message: 'issue', ruleId: 'r/1', tool: 'semgrep' };

    beforeEach(() => {
      vi.clearAllMocks();
      (buildAnnotations as ReturnType<typeof vi.fn>).mockReturnValue({ annotations: [], conclusion: 'failure', summary: 'Issues found.' });
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValue(dispatchResult([finding]));
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        semgrep:            { enabled: true, extraArgs: [] },
        trufflehog:         { enabled: true, extraArgs: [] },
        claude:             { enabled: false },
        notifications:      {},
        labels:             {},
        comment:            { enabled: false, template: null },
        exceptionApprovers: { users: ['alice'], teams: [] },
      });
      (generateFindingId as ReturnType<typeof vi.fn>).mockReturnValue('LAYNE-a3f29c81');
      (loadExceptions as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockImplementation(({ baseSummary }: { baseSummary: string }) => ({ conclusion: 'failure', summary: baseSummary }));
    });

    it('stamps _findingId on each actionable finding', async () => {
      await processJob(baseJob);
      expect(generateFindingId).toHaveBeenCalledWith(expect.objectContaining({ file: 'a.js' }));
    });

    it('does not let exception processing turn incomplete adapter coverage into success', async () => {
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([], {
        semgrep: { outcome: 'incomplete', reason: 'scanner-execution-failed' },
      }));
      (buildAnnotations as ReturnType<typeof vi.fn>).mockReturnValueOnce({ annotations: [], conclusion: 'success', summary: 'No issues found.' });
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockImplementationOnce(({ baseSummary }: { baseSummary: string }) => ({ conclusion: 'success', summary: baseSummary }));

      await processJob(baseJob);

      expect(buildExceptionSummary).toHaveBeenCalledWith(expect.objectContaining({
        baseSummary: expect.stringContaining('Adapter coverage incomplete: semgrep (scanner-execution-failed).'),
      }));
      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'neutral', summary: expect.stringContaining('Adapter coverage incomplete: semgrep (scanner-execution-failed).'),
      }));
    });

    it('does not let exceptions waive high-risk Spectre overflow', async () => {
      const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'test', timestamp: '' }]]);
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(highRiskCappedSpectreResult([finding]));
      (loadExceptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(exceptions);
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockImplementationOnce(({ baseSummary }: { baseSummary: string }) => ({ conclusion: 'success', summary: baseSummary }));

      await processJob(baseJob);

      expect(buildExceptionSummary).toHaveBeenCalledWith(expect.objectContaining({
        baseSummary: expect.stringContaining('Spectre coverage failure'),
      }));
      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
    });

    it('does not call loadExceptions when exceptionApprovers is empty', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
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
        findingIds: ['LAYNE-a3f29c81'],
      }));
    });

    it('calls filterStaleExceptions with loaded exceptions after loadExceptions', async () => {
      const loaded = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'ok', timestamp: '', approvedHeadSha: 'abc123' }]]);
      (loadExceptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(loaded);
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted.' });

      await processJob(baseJob);

      expect(filterStaleExceptions).toHaveBeenCalledWith(expect.objectContaining({
        exceptions:     loaded,
        currentHeadSha: 'abc123',
      }));
    });

    it('calls resolveDriftedExceptions with unmatched blocking findings after filterStaleExceptions', async () => {
      // filterStaleExceptions returns empty — no direct exception match for the finding.
      (filterStaleExceptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map());

      await processJob(baseJob);

      expect(resolveDriftedExceptions).toHaveBeenCalledWith(expect.objectContaining({
        unmatchedFindings: expect.arrayContaining([
          expect.objectContaining({ _findingId: 'LAYNE-a3f29c81' }),
        ]),
        currentHeadSha: 'abc123',
      }));
    });

    it('merges drifted exceptions into the exceptions map passed to buildExceptionSummary', async () => {
      (filterStaleExceptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map());
      const drifted = new Map([['LAYNE-a3f29c81', { approver: 'bob', reason: 'drift', timestamp: '' }]]);
      (resolveDriftedExceptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(drifted);
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'success', summary: 'Drift pass.' });

      await processJob(baseJob);

      expect(buildExceptionSummary).toHaveBeenCalledWith(expect.objectContaining({
        exceptions: expect.objectContaining({ size: 1 }),
      }));
    });

    it('does not call loadExceptions when there are no blocking findings', async () => {
      const lowFinding = { ...finding, severity: 'low' };
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([lowFinding]));
      (buildAnnotations as ReturnType<typeof vi.fn>).mockReturnValueOnce({ annotations: [], conclusion: 'success', summary: 'Low only.' });

      await processJob(baseJob);
      expect(loadExceptions).not.toHaveBeenCalled();
    });

    it('overrides conclusion and summary from buildExceptionSummary', async () => {
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted summary.' });

      await processJob(baseJob);

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'success',
        summary:    'Excepted summary.',
      }));
    });

    it('sets exceptionApproval when all blocking findings are excepted (success + exceptions.size > 0)', async () => {
      const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'test', timestamp: '' }]]);
      (loadExceptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(exceptions);
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted.' });

      await processJob(baseJob);

      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({
          exceptionApproval: expect.objectContaining({
            approved: true,
            approver: 'alice',
            findingIds: ['LAYNE-a3f29c81'],
            reason: 'test',
          }),
        }),
      }));
    });

    it('sorts distinct exception reasons in notification state', async () => {
      const secondFinding = { ...finding, file: 'b.js', line: 2 };
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding, secondFinding]));
      (generateFindingId as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce('LAYNE-a3f29c81')
        .mockReturnValueOnce('LAYNE-b7e41d22');
      (loadExceptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map([
        ['LAYNE-a3f29c81', { approver: 'alice', reason: 'zeta', timestamp: '' }],
        ['LAYNE-b7e41d22', { approver: 'bob', reason: 'alpha', timestamp: '' }],
      ]));
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted.' });

      await processJob(baseJob);

      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({
          exceptionApproval: expect.objectContaining({ reason: 'alpha; zeta' }),
        }),
      }));
    });

    it('materializes all for only remaining critical and high findings', async () => {
      const criticalFinding = { ...finding, file: 'critical.js', line: 2, severity: 'critical' };
      const mediumFinding = { ...finding, file: 'medium.js', line: 3, severity: 'medium' };
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding, criticalFinding, mediumFinding]));
      (generateFindingId as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce('LAYNE-high')
        .mockReturnValueOnce('LAYNE-critical')
        .mockReturnValueOnce('LAYNE-medium');
      const existing = { approver: 'bob', reason: 'existing', timestamp: '', approvedHeadSha: 'abc123' };
      const bulk = { approver: 'alice', reason: 'bulk approval', timestamp: '', approvedHeadSha: 'abc123' };
      (loadExceptions as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(new Map([['LAYNE-high', existing]]))
        .mockResolvedValueOnce(new Map([['LAYNE-critical', bulk]]));
      (materializeBulkExceptionRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        requestId: '9001', state: 'materialized', findingIds: ['LAYNE-critical'], ...bulk,
      });
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted.' });
      const bulkJob = {
        ...baseJob,
        data: { ...baseJob.data, exceptionApprovalRequest: { kind: 'all', requestId: '9001' } },
      };

      await processJob(bulkJob as unknown as Job<JobData, unknown, string>);

      expect(materializeBulkExceptionRequest).toHaveBeenCalledWith(expect.objectContaining({
        owner: 'org', repo: 'repo', prNumber: 7, approvedHeadSha: 'abc123', requestId: '9001',
        findingIds: ['LAYNE-critical'],
        expectedExceptions: expect.objectContaining({ size: 1 }),
      }));
      expect(buildExceptionSummary).toHaveBeenCalledWith(expect.objectContaining({
        exceptions: expect.objectContaining({ size: 2 }),
      }));
    });

    it('uses the request stored target list on a materialized retry without expanding it', async () => {
      const secondFinding = { ...finding, file: 'b.js', line: 2 };
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding, secondFinding]));
      (generateFindingId as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce('LAYNE-first')
        .mockReturnValueOnce('LAYNE-new');
      const bulk = { approver: 'alice', reason: 'bulk approval', timestamp: '', approvedHeadSha: 'abc123' };
      (loadExceptions as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(new Map())
        .mockResolvedValueOnce(new Map([['LAYNE-first', bulk]]));
      (materializeBulkExceptionRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        requestId: '9001', state: 'materialized', findingIds: ['LAYNE-first'], ...bulk,
      });
      const bulkJob = {
        ...baseJob,
        data: { ...baseJob.data, exceptionApprovalRequest: { kind: 'all', requestId: '9001' } },
      };

      await processJob(bulkJob as unknown as Job<JobData, unknown, string>);

      expect(materializeBulkExceptionRequest).toHaveBeenCalledWith(expect.objectContaining({
        findingIds: ['LAYNE-first', 'LAYNE-new'],
      }));
      expect(loadExceptions).toHaveBeenNthCalledWith(2, expect.objectContaining({ findingIds: ['LAYNE-first'] }));
    });

    it('fails closed so BullMQ can retry when bulk materialization fails', async () => {
      (materializeBulkExceptionRequest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Redis unavailable'));
      const bulkJob = {
        ...baseJob,
        data: { ...baseJob.data, exceptionApprovalRequest: { kind: 'all', requestId: '9001' } },
      };

      await expect(processJob(bulkJob as unknown as Job<JobData, unknown, string>)).rejects.toThrow('Redis unavailable');
      expect(completeCheckRun).not.toHaveBeenCalled();
    });

    it('fails closed when bulk approvals were disabled before the worker runs', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {}, comment: { enabled: false, template: null },
        exceptionApprovers: { users: [], teams: [] },
      });
      const bulkJob = {
        ...baseJob,
        data: { ...baseJob.data, exceptionApprovalRequest: { kind: 'all', requestId: '9001' } },
      };

      await expect(processJob(bulkJob as unknown as Job<JobData, unknown, string>)).rejects.toThrow('no longer enabled');
      expect(materializeBulkExceptionRequest).not.toHaveBeenCalled();
    });

    it('records and notifies an exception approval while incomplete coverage keeps the conclusion neutral', async () => {
      const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'test', timestamp: '' }]]);
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding], {
        semgrep: { outcome: 'incomplete', reason: 'partial-results' },
      }));
      (loadExceptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(exceptions);
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted.' });
      const exceptionTriggeredJob = { ...baseJob, data: { ...baseJob.data, triggeredByException: true } };
      await processJob(exceptionTriggeredJob as unknown as Job<JobData, unknown, string>);

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'neutral' }));
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({
          conclusion: 'neutral',
          exceptionApproval: expect.objectContaining({ approved: true, approver: 'alice' }),
        }),
      }));
    });

    it('keeps exceptionApproval null when conclusion is failure (partial or no exceptions)', async () => {
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'failure', summary: 'Still failing.' });

      await processJob(baseJob);

      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({ exceptionApproval: null }),
      }));
    });

    it('keeps conclusion as failure when loadExceptions throws (fail closed)', async () => {
      (loadExceptions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Redis down'));
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'failure', summary: 'Issues found.' });

      await processJob(baseJob);

      expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'failure',
      }));
    });

    it('uses onException labels when exception is approved', async () => {
      const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'ok', timestamp: '' }]]);
      (loadExceptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(exceptions);
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted.' });
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
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

    it('uses incomplete labels instead of exception labels when an approved finding has incomplete coverage', async () => {
      const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'ok', timestamp: '' }]]);
      (dispatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(dispatchResult([finding], {
        trufflehog: { outcome: 'incomplete', reason: 'partial-results' },
      }));
      (loadExceptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(exceptions);
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted.' });
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, comment: { enabled: false, template: null },
        exceptionApprovers: { users: ['alice'], teams: [] },
        labels: {
          onIncomplete: ['security-scan-incomplete'],
          removeOnIncomplete: ['security-exception-used'],
          onException: ['security-exception-used'],
          removeOnException: ['needs-review'],
        },
      });

      await processJob(baseJob);

      expect(setLabels).toHaveBeenCalledWith(expect.objectContaining({
        add: ['security-scan-incomplete'],
        remove: ['security-exception-used'],
      }));
    });

    it('notifies when exception is approved and the job was triggered by the approval comment', async () => {
      const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'ok', timestamp: '' }]]);
      (loadExceptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(exceptions);
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted.' });
      const exceptionTriggeredJob = { ...baseJob, data: { ...baseJob.data, triggeredByException: true } };
      await processJob(exceptionTriggeredJob as unknown as Job<JobData, unknown, string>);

      expect(notify).toHaveBeenCalledOnce();
    });

    it('passes effective exceptions on a new commit so delivery can be deduplicated or retried', async () => {
      const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'ok', timestamp: '' }]]);
      (loadExceptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(exceptions);
      (buildExceptionSummary as ReturnType<typeof vi.fn>).mockReturnValueOnce({ conclusion: 'success', summary: 'Excepted.' });
      await processJob(baseJob); // triggeredByException is absent

      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({
          exceptionApproval: expect.objectContaining({ approved: true, findingIds: ['LAYNE-a3f29c81'] }),
        }),
      }));
    });

    it('passes exceptionApproval: null to notify when no exception approvers are configured', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        semgrep: { enabled: true, extraArgs: [] }, trufflehog: { enabled: true, extraArgs: [] },
        claude: { enabled: false }, notifications: {}, labels: {}, comment: { enabled: false, template: null },
        exceptionApprovers: { users: [], teams: [] },
      });
      (buildAnnotations as ReturnType<typeof vi.fn>).mockReturnValueOnce({ annotations: [], conclusion: 'failure', summary: 'Issues found.' });

      await processJob(baseJob);

      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        state: expect.objectContaining({ exceptionApproval: null }),
      }));
    });
  });
});
