import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';

vi.mock('../queue.js', () => ({
  redis: { set: vi.fn(), eval: vi.fn(), get: vi.fn() },
  scanQueue: { add: vi.fn(), getJob: vi.fn() },
}));

vi.mock('../github.js', () => ({
  createCheckRun:              vi.fn(),
  completeCheckRun:            vi.fn(),
  skipCheckRun:                vi.fn(),
  findPullRequestBySha:        vi.fn(),
  getLatestCheckRun:           vi.fn(),
  getPullRequest:              vi.fn(),
  createPrComment:             vi.fn(),
}));

vi.mock('../exception-approvals.js', () => ({
  isReviewerAuthorized:  vi.fn(),
  parseExceptionCommand: vi.fn(),
  storeExceptions:       vi.fn(),
}));

vi.mock('../config.js', () => ({
  loadScanConfig: vi.fn(),
}));

vi.mock('../metrics.js', () => ({
  registry:      null,
  webhooksTotal: { inc: vi.fn() },
}));

const { redis, scanQueue }                                  = await import('../queue.js');
const { createCheckRun, completeCheckRun,
        skipCheckRun, findPullRequestBySha,
        getLatestCheckRun, getPullRequest,
        createPrComment }                                   = await import('../github.js');
const { loadScanConfig }                                    = await import('../config.js');
const { webhooksTotal }                                     = await import('../metrics.js');
const { isReviewerAuthorized, parseExceptionCommand,
        storeExceptions }                                   = await import('../exception-approvals.js');
const { app, verifySignature, processWebhookRequest }       = await import('../server.js');

const PR_TRIGGER_CONFIG           = { trigger: { on: 'pull_request' } };
const WORKFLOW_TRIGGER_CONFIG     = { trigger: { on: 'workflow_run', workflow: 'Tests Done', conclusions: ['success'] } };
const WORKFLOW_JOB_TRIGGER_CONFIG = { trigger: { on: 'workflow_job', job: 'security-scan', conclusions: ['success'] } };
const EXCEPTION_CONFIG            = { trigger: { on: 'pull_request' }, exceptionApprovers: { users: ['alice'], teams: [] } };

function sign(body: Buffer | string): string {
  return 'sha256=' + crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!)
    .update(Buffer.isBuffer(body) ? body : Buffer.from(body))
    .digest('hex');
}

function prPayload(action = 'opened'): string {
  return JSON.stringify({
    action,
    number: 42,
    pull_request: {
      number: 42,
      head: { sha: 'abc123', ref: 'feature/login', repo: {} },
      base: { sha: 'def456', ref: 'main' },
      labels: [{ name: 'bug' }],
    },
    repository: {
      name:       'my-repo',
      full_name:  'org/my-repo',
      clone_url:  'https://github.com/org/my-repo.git',
      owner:      { login: 'org' },
    },
    installation: { id: 987 },
  });
}

function workflowRunPayload({
  action      = 'completed',
  workflowName = 'Tests Done',
  conclusion  = 'success',
  headSha     = 'abc123',
} = {}): string {
  return JSON.stringify({
    action,
    workflow_run: {
      name:       workflowName,
      conclusion,
      head_sha:   headSha,
    },
    repository: {
      name:       'my-repo',
      full_name:  'org/my-repo',
      clone_url:  'https://github.com/org/my-repo.git',
      owner:      { login: 'org' },
    },
    installation: { id: 987 },
  });
}

function workflowJobPayload({
  action   = 'completed',
  jobName  = 'security-scan',
  conclusion = 'success',
  headSha  = 'abc123',
} = {}): string {
  return JSON.stringify({
    action,
    workflow_job: {
      name:       jobName,
      conclusion,
      head_sha:   headSha,
    },
    repository: {
      name:       'my-repo',
      full_name:  'org/my-repo',
      clone_url:  'https://github.com/org/my-repo.git',
      owner:      { login: 'org' },
    },
    installation: { id: 987 },
  });
}

function webhookRequest(body: string, { event = 'pull_request', signature }: { event?: string; signature?: string } = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    event,
    signature: signature ?? sign(bodyStr),
    rawBody:   Buffer.from(bodyStr),
  };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  (createCheckRun as ReturnType<typeof vi.fn>).mockResolvedValue(99);
  (completeCheckRun as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (skipCheckRun as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (findPullRequestBySha as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (getLatestCheckRun as ReturnType<typeof vi.fn>).mockResolvedValue({ conclusion: 'failure' });
  (getPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
    head:   { sha: 'abc123', ref: 'feature/login' },
    base:   { sha: 'def456', ref: 'main' },
    labels: [],
  });
  (createPrComment as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (isReviewerAuthorized as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  (parseExceptionCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);
  (storeExceptions as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (redis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
  (redis.eval as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (scanQueue.add as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'job-1' });
  (scanQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue(PR_TRIGGER_CONFIG);
});

describe('GET /assets/layne-logo.png', () => {
  it('returns 200 with a PNG content-type', async () => {
    const res = await request(app).get('/assets/layne-logo.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });

  it('does not serve arbitrary paths under /assets/', async () => {
    const res = await request(app).get('/assets/other-file.png');
    expect(res.status).toBe(404);
  });
});

describe('verifySignature()', () => {
  it('rejects a missing signature', () => {
    expect(verifySignature(Buffer.from(prPayload()), undefined)).toBe(false);
  });

  it('rejects an invalid signature', () => {
    expect(verifySignature(Buffer.from(prPayload()), 'sha256=badsignature')).toBe(false);
  });

  it('accepts a valid signature', () => {
    const body = Buffer.from(prPayload());
    expect(verifySignature(body, sign(body))).toBe(true);
  });
});

describe('processWebhookRequest()', () => {
  it('rejects invalid signatures', async () => {
    const res = await processWebhookRequest(webhookRequest(prPayload(), {
      signature: 'sha256=badsignature',
    }));

    expect(res).toEqual({ status: 401, body: 'Invalid signature' });
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON payloads', async () => {
    const res = await processWebhookRequest(webhookRequest('{invalid-json'));

    expect(res).toEqual({ status: 400, body: 'Invalid JSON payload' });
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it('ignores events that are not pull_request, workflow_run, workflow_job, or issue_comment', async () => {
    const res = await processWebhookRequest(webhookRequest(JSON.stringify({ action: 'created' }), {
      event: 'push',
    }));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it('ignores pull_request actions outside the handled set', async () => {
    const res = await processWebhookRequest(webhookRequest(prPayload('closed')));

    expect(res).toEqual({ status: 200, body: 'Action ignored' });
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it.each(['opened', 'synchronize', 'reopened'])(
    'accepts action "%s" only after the check run and queue job are created',
    async (action) => {
      const res = await processWebhookRequest(webhookRequest(prPayload(action)));

      expect(res).toEqual({ status: 200, body: 'Accepted' });
      expect(createCheckRun).toHaveBeenCalledOnce();
      expect(scanQueue.add).toHaveBeenCalledOnce();
    }
  );

  it('does not resolve before both persistence steps succeed', async () => {
    const checkRun = deferred();
    const enqueue = deferred();
    (createCheckRun as ReturnType<typeof vi.fn>).mockReturnValueOnce(checkRun.promise);
    (scanQueue.add as ReturnType<typeof vi.fn>).mockReturnValueOnce(enqueue.promise);

    let settled = false;
    const requestPromise = processWebhookRequest(webhookRequest(prPayload())).then(result => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    checkRun.resolve(99);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(scanQueue.add).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    enqueue.resolve({ id: 'job-1' });
    await expect(requestPromise).resolves.toEqual({ status: 200, body: 'Accepted' });
  });

  it('creates the check run with the correct head SHA', async () => {
    await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(createCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      headSha: 'abc123',
      owner:   'org',
      repo:    'my-repo',
    }));
  });

  it('enqueues a job with the correct payload shape', async () => {
    await processWebhookRequest(webhookRequest(prPayload('opened')));

    const [eventName, jobData] = (scanQueue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(eventName).toBe('scan');
    expect(jobData).toMatchObject({
      owner:          'org',
      repo:           'my-repo',
      headSha:        'abc123',
      headRef:        'feature/login',
      baseSha:        'def456',
      baseRef:        'main',
      prNumber:       42,
      labels:         ['bug'],
      installationId: 987,
      checkRunId:     99,
    });
  });

  it('deduplicates jobs by repo + PR number + commit SHA', async () => {
    await processWebhookRequest(webhookRequest(prPayload('opened')));

    const [, , opts] = (scanQueue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown, { jobId: string }];
    expect(opts.jobId).toBe('org/my-repo#42@abc123');
  });

  it('does not create a second check run when the job is already active', async () => {
    (scanQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'org/my-repo#42@abc123', getState: vi.fn().mockResolvedValue('waiting') });

    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('removes the old job and re-enqueues when the existing job is already completed (re-run scenario)', async () => {
    const mockRemove = vi.fn().mockResolvedValue(undefined);
    (scanQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'org/my-repo#42@abc123', getState: vi.fn().mockResolvedValue('completed'), remove: mockRemove });

    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(mockRemove).toHaveBeenCalled();
    expect(createCheckRun).toHaveBeenCalled();
    expect(scanQueue.add).toHaveBeenCalled();
  });

  it('removes the old job and re-enqueues when the existing job is in a failed state (re-run scenario)', async () => {
    const mockRemove = vi.fn().mockResolvedValue(undefined);
    (scanQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'org/my-repo#42@abc123', getState: vi.fn().mockResolvedValue('failed'), remove: mockRemove });

    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(mockRemove).toHaveBeenCalled();
    expect(createCheckRun).toHaveBeenCalled();
    expect(scanQueue.add).toHaveBeenCalled();
  });

  it('does not create a second check run while another request is accepting the same webhook', async () => {
    (redis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('returns 500 and skips enqueueing when createCheckRun fails', async () => {
    (createCheckRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('GitHub unavailable'));

    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 500, body: 'Failed to accept webhook' });
    expect(scanQueue.add).not.toHaveBeenCalled();
    expect(completeCheckRun).not.toHaveBeenCalled();
  });

  it('returns 500 and fails the queued check run when enqueueing fails', async () => {
    (scanQueue.add as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Redis unavailable'));

    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 500, body: 'Failed to accept webhook' });
    expect(completeCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 987,
      owner:          'org',
      repo:           'my-repo',
      checkRunId:     99,
      conclusion:     'failure',
      summary:        expect.stringContaining('failed to accept this scan job'),
    }));
  });

  describe('metrics', () => {
    beforeEach(() => vi.clearAllMocks());

    it('increments webhooksTotal with deduplicated=false when a job is enqueued', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue(PR_TRIGGER_CONFIG);
      await processWebhookRequest(webhookRequest(prPayload('opened')));
      expect((webhooksTotal as { inc: ReturnType<typeof vi.fn> }).inc).toHaveBeenCalledWith({ action: 'opened', deduplicated: 'false' });
    });

    it('increments webhooksTotal with deduplicated=true when a duplicate webhook is received', async () => {
      (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue(PR_TRIGGER_CONFIG);
      (scanQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'existing-job', getState: vi.fn().mockResolvedValue('waiting') });
      await processWebhookRequest(webhookRequest(prPayload('opened')));
      expect((webhooksTotal as { inc: ReturnType<typeof vi.fn> }).inc).toHaveBeenCalledWith({ action: 'opened', deduplicated: 'true' });
    });
  });
});

// ---------------------------------------------------------------------------
// workflow_run trigger — pull_request events deferred
// ---------------------------------------------------------------------------

describe('workflow_run trigger — pull_request event', () => {
  beforeEach(() => {
    (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue(WORKFLOW_TRIGGER_CONFIG);
  });

  it('does not enqueue a scan when the repo uses workflow_run trigger', async () => {
    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 200, body: 'Deferred' });
    expect(scanQueue.add).not.toHaveBeenCalled();
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it('caches PR metadata in Redis with a 7-day TTL', async () => {
    await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(redis.set).toHaveBeenCalledWith(
      'layne:pr:org/my-repo:abc123',
      expect.any(String),
      'EX',
      7 * 24 * 60 * 60
    );

    const cached = JSON.parse((redis.set as ReturnType<typeof vi.fn>).mock.calls[0][1] as string) as Record<string, unknown>;
    expect(cached).toMatchObject({
      prNumber:       42,
      headSha:        'abc123',
      headRef:        'feature/login',
      baseSha:        'def456',
      baseRef:        'main',
      labels:         ['bug'],
      installationId: 987,
    });
  });

  it('creates a skipped check run with the configured workflow name in the summary', async () => {
    await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(skipCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 987,
      owner:          'org',
      repo:           'my-repo',
      headSha:        'abc123',
      summary:        expect.stringContaining('Tests Done'),
    }));
  });

  it('still returns Deferred even if skipCheckRun throws', async () => {
    (skipCheckRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('GitHub API error'));

    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 200, body: 'Deferred' });
  });
});

// ---------------------------------------------------------------------------
// workflow_run trigger — workflow_run events
// ---------------------------------------------------------------------------

describe('workflow_run trigger — workflow_run event', () => {
  const CACHED_PR = JSON.stringify({
    prNumber:       42,
    headSha:        'abc123',
    headRef:        'feature/login',
    baseSha:        'def456',
    baseRef:        'main',
    labels:         ['bug'],
    installationId: 987,
    cloneUrl:       'https://github.com/org/my-repo.git',
    repoFullName:   'org/my-repo',
  });

  beforeEach(() => {
    (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue(WORKFLOW_TRIGGER_CONFIG);
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(CACHED_PR);
  });

  it('enqueues a scan when the workflow run matches config', async () => {
    const res = await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(createCheckRun).toHaveBeenCalledOnce();
    expect(scanQueue.add).toHaveBeenCalledOnce();
  });

  it('enqueues with the correct job payload from the cached PR data', async () => {
    await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    const [, jobData] = (scanQueue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(jobData).toMatchObject({
      owner:          'org',
      repo:           'my-repo',
      headSha:        'abc123',
      headRef:        'feature/login',
      baseSha:        'def456',
      baseRef:        'main',
      prNumber:       42,
      labels:         ['bug'],
      installationId: 987,
      checkRunId:     99,
    });
  });

  it('uses the correct job ID for deduplication', async () => {
    await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    const [, , opts] = (scanQueue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown, { jobId: string }];
    expect(opts.jobId).toBe('org/my-repo#42@abc123');
  });

  it('ignores workflow_run events where action is not "completed"', async () => {
    const res = await processWebhookRequest(webhookRequest(
      workflowRunPayload({ action: 'requested' }), { event: 'workflow_run' }
    ));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('ignores workflow_run events for a different workflow name', async () => {
    const res = await processWebhookRequest(webhookRequest(
      workflowRunPayload({ workflowName: 'Lint' }), { event: 'workflow_run' }
    ));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('ignores workflow_run events with a non-matching conclusion', async () => {
    const res = await processWebhookRequest(webhookRequest(
      workflowRunPayload({ conclusion: 'failure' }), { event: 'workflow_run' }
    ));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('ignores workflow_run events when the repo uses pull_request trigger', async () => {
    (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue(PR_TRIGGER_CONFIG);

    const res = await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('deduplicates: does not enqueue when the job is already active', async () => {
    (scanQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'org/my-repo#42@abc123', getState: vi.fn().mockResolvedValue('active') });

    const res = await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('removes the old job and re-enqueues when the existing job has already completed (re-run scenario)', async () => {
    const mockRemove = vi.fn().mockResolvedValue(undefined);
    (scanQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'org/my-repo#42@abc123', getState: vi.fn().mockResolvedValue('completed'), remove: mockRemove });

    const res = await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(mockRemove).toHaveBeenCalled();
    expect(createCheckRun).toHaveBeenCalled();
    expect(scanQueue.add).toHaveBeenCalled();
  });

  it('returns 200 with "PR not found" when cache is cold and GitHub API returns nothing', async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (findPullRequestBySha as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    expect(res).toEqual({ status: 200, body: 'PR not found' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('falls back to GitHub API when cache is cold and enqueues from API data', async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (findPullRequestBySha as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 42,
      head:   { ref: 'feature/login', sha: 'abc123' },
      base:   { ref: 'main',          sha: 'def456' },
      labels: [{ name: 'bug' }],
    });

    const res = await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(findPullRequestBySha).toHaveBeenCalledWith(expect.objectContaining({
      owner:   'org',
      repo:    'my-repo',
      headSha: 'abc123',
    }));
    expect(scanQueue.add).toHaveBeenCalledOnce();
  });

  it('returns "PR not found" when cache is cold and GitHub API throws', async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (findPullRequestBySha as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));

    const res = await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    expect(res).toEqual({ status: 200, body: 'PR not found' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('enqueues with configured non-default conclusions', async () => {
    (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      trigger: { on: 'workflow_run', workflow: 'Tests Done', conclusions: ['success', 'failure'] },
    });

    const res = await processWebhookRequest(webhookRequest(
      workflowRunPayload({ conclusion: 'failure' }), { event: 'workflow_run' }
    ));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(scanQueue.add).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// workflow_job trigger — pull_request events deferred
// ---------------------------------------------------------------------------

describe('workflow_job trigger — pull_request event', () => {
  beforeEach(() => {
    (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue(WORKFLOW_JOB_TRIGGER_CONFIG);
  });

  it('does not enqueue a scan when the repo uses workflow_job trigger', async () => {
    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 200, body: 'Deferred' });
    expect(scanQueue.add).not.toHaveBeenCalled();
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it('caches PR metadata in Redis with a 7-day TTL', async () => {
    await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(redis.set).toHaveBeenCalledWith(
      'layne:pr:org/my-repo:abc123',
      expect.any(String),
      'EX',
      7 * 24 * 60 * 60
    );

    const cached = JSON.parse((redis.set as ReturnType<typeof vi.fn>).mock.calls[0][1] as string) as Record<string, unknown>;
    expect(cached).toMatchObject({
      prNumber:       42,
      headSha:        'abc123',
      headRef:        'feature/login',
      baseSha:        'def456',
      baseRef:        'main',
      labels:         ['bug'],
      installationId: 987,
    });
  });

  it('creates a skipped check run with the configured job name in the summary', async () => {
    await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(skipCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 987,
      owner:          'org',
      repo:           'my-repo',
      headSha:        'abc123',
      summary:        expect.stringContaining('security-scan'),
    }));
  });

  it('still returns Deferred even if skipCheckRun throws', async () => {
    (skipCheckRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('GitHub API error'));

    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 200, body: 'Deferred' });
  });
});

// ---------------------------------------------------------------------------
// workflow_job trigger — workflow_job events
// ---------------------------------------------------------------------------

describe('workflow_job trigger — workflow_job event', () => {
  const CACHED_PR = JSON.stringify({
    prNumber:       42,
    headSha:        'abc123',
    headRef:        'feature/login',
    baseSha:        'def456',
    baseRef:        'main',
    labels:         ['bug'],
    installationId: 987,
    cloneUrl:       'https://github.com/org/my-repo.git',
    repoFullName:   'org/my-repo',
  });

  beforeEach(() => {
    (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue(WORKFLOW_JOB_TRIGGER_CONFIG);
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(CACHED_PR);
  });

  it('enqueues a scan when the workflow job matches config', async () => {
    const res = await processWebhookRequest(webhookRequest(workflowJobPayload(), { event: 'workflow_job' }));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(createCheckRun).toHaveBeenCalledOnce();
    expect(scanQueue.add).toHaveBeenCalledOnce();
  });

  it('enqueues with the correct job payload from the cached PR data', async () => {
    await processWebhookRequest(webhookRequest(workflowJobPayload(), { event: 'workflow_job' }));

    const [, jobData] = (scanQueue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(jobData).toMatchObject({
      owner:          'org',
      repo:           'my-repo',
      headSha:        'abc123',
      headRef:        'feature/login',
      baseSha:        'def456',
      baseRef:        'main',
      prNumber:       42,
      labels:         ['bug'],
      installationId: 987,
      checkRunId:     99,
    });
  });

  it('uses the correct job ID for deduplication', async () => {
    await processWebhookRequest(webhookRequest(workflowJobPayload(), { event: 'workflow_job' }));

    const [, , opts] = (scanQueue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown, { jobId: string }];
    expect(opts.jobId).toBe('org/my-repo#42@abc123');
  });

  it('ignores workflow_job events where action is not "completed"', async () => {
    const res = await processWebhookRequest(webhookRequest(
      workflowJobPayload({ action: 'in_progress' }), { event: 'workflow_job' }
    ));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('ignores workflow_job events for a different job name', async () => {
    const res = await processWebhookRequest(webhookRequest(
      workflowJobPayload({ jobName: 'lint' }), { event: 'workflow_job' }
    ));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('ignores workflow_job events with a non-matching conclusion', async () => {
    const res = await processWebhookRequest(webhookRequest(
      workflowJobPayload({ conclusion: 'failure' }), { event: 'workflow_job' }
    ));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('ignores workflow_job events when the repo uses pull_request trigger', async () => {
    (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue(PR_TRIGGER_CONFIG);

    const res = await processWebhookRequest(webhookRequest(workflowJobPayload(), { event: 'workflow_job' }));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('deduplicates: does not enqueue when the job is already active', async () => {
    (scanQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'org/my-repo#42@abc123', getState: vi.fn().mockResolvedValue('active') });

    const res = await processWebhookRequest(webhookRequest(workflowJobPayload(), { event: 'workflow_job' }));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('removes the old job and re-enqueues when the existing job has already completed (re-run scenario)', async () => {
    const mockRemove = vi.fn().mockResolvedValue(undefined);
    (scanQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'org/my-repo#42@abc123', getState: vi.fn().mockResolvedValue('completed'), remove: mockRemove });

    const res = await processWebhookRequest(webhookRequest(workflowJobPayload(), { event: 'workflow_job' }));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(mockRemove).toHaveBeenCalled();
    expect(createCheckRun).toHaveBeenCalled();
    expect(scanQueue.add).toHaveBeenCalled();
  });

  it('returns 200 with "PR not found" when cache is cold and GitHub API returns nothing', async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (findPullRequestBySha as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await processWebhookRequest(webhookRequest(workflowJobPayload(), { event: 'workflow_job' }));

    expect(res).toEqual({ status: 200, body: 'PR not found' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('falls back to GitHub API when cache is cold and enqueues from API data', async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (findPullRequestBySha as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 42,
      head:   { ref: 'feature/login', sha: 'abc123' },
      base:   { ref: 'main',          sha: 'def456' },
      labels: [{ name: 'bug' }],
    });

    const res = await processWebhookRequest(webhookRequest(workflowJobPayload(), { event: 'workflow_job' }));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(findPullRequestBySha).toHaveBeenCalledWith(expect.objectContaining({
      owner:   'org',
      repo:    'my-repo',
      headSha: 'abc123',
    }));
    expect(scanQueue.add).toHaveBeenCalledOnce();
  });

  it('returns "PR not found" when cache is cold and GitHub API throws', async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (findPullRequestBySha as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));

    const res = await processWebhookRequest(webhookRequest(workflowJobPayload(), { event: 'workflow_job' }));

    expect(res).toEqual({ status: 200, body: 'PR not found' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('enqueues with configured non-default conclusions', async () => {
    (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      trigger: { on: 'workflow_job', job: 'security-scan', conclusions: ['success', 'failure'] },
    });

    const res = await processWebhookRequest(webhookRequest(
      workflowJobPayload({ conclusion: 'failure' }), { event: 'workflow_job' }
    ));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(scanQueue.add).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// issue_comment handler
// ---------------------------------------------------------------------------

function commentPayload({
  action    = 'created',
  commenter = 'alice',
  body      = '/layne exception-approve LAYNE-a3f29c81 reason: test cred',
  isPR      = true,
} = {}): string {
  return JSON.stringify({
    action,
    issue: {
      number:       42,
      pull_request: isPR ? { url: 'https://api.github.com/repos/org/my-repo/pulls/42' } : undefined,
    },
    comment: {
      body,
      user: { login: commenter },
    },
    repository: {
      name:      'my-repo',
      full_name: 'org/my-repo',
      clone_url: 'https://github.com/org/my-repo.git',
      owner:     { login: 'org' },
    },
    installation: { id: 987 },
  });
}

describe('issue_comment handler', () => {
  const PARSED_OK = { ids: ['LAYNE-a3f29c81'], reason: 'test cred' };

  beforeEach(() => {
    (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue(EXCEPTION_CONFIG);
    (parseExceptionCommand as ReturnType<typeof vi.fn>).mockReturnValue(PARSED_OK);
    (isReviewerAuthorized as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (getLatestCheckRun as ReturnType<typeof vi.fn>).mockResolvedValue({ conclusion: 'failure' });
  });

  it('ignores non-created actions', async () => {
    const res = await processWebhookRequest(webhookRequest(
      commentPayload({ action: 'edited' }), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('ignores comments on issues (not PRs)', async () => {
    const res = await processWebhookRequest(webhookRequest(
      commentPayload({ isPR: false }), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('ignores comments that do not contain the exception command', async () => {
    (parseExceptionCommand as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const res = await processWebhookRequest(webhookRequest(
      commentPayload({ body: 'LGTM!' }), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('ignores when no exception approvers are configured', async () => {
    (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ trigger: { on: 'pull_request' } });

    const res = await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'No exception approvers configured' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('ignores when exception approvers config has empty users and teams', async () => {
    (loadScanConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      trigger:            { on: 'pull_request' },
      exceptionApprovers: { users: [], teams: [] },
    });

    const res = await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'No exception approvers configured' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('posts an error comment and returns Invalid command when parseExceptionCommand returns an error', async () => {
    (parseExceptionCommand as ReturnType<typeof vi.fn>).mockReturnValue({ ids: [], reason: null, error: 'No valid IDs found.' });

    const res = await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'Invalid command' });
    expect(createPrComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('Invalid exception command'),
    }));
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('returns Commenter not authorized when commenter is not in exception approvers', async () => {
    (isReviewerAuthorized as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const res = await processWebhookRequest(webhookRequest(
      commentPayload({ commenter: 'mallory' }), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'Commenter not authorized' });
    expect(createPrComment).not.toHaveBeenCalled();
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('returns PR not found when getPullRequest fails', async () => {
    (getPullRequest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('GitHub API down'));

    const res = await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'PR not found' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('stores exceptions with correct params', async () => {
    await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    expect(storeExceptions).toHaveBeenCalledWith(expect.objectContaining({
      owner:           'org',
      repo:            'my-repo',
      prNumber:        42,
      approvedHeadSha: 'abc123',
      findingIds:      ['LAYNE-a3f29c81'],
      approver:        'alice',
      reason:          'test cred',
    }));
  });

  it('enqueues a scan when the latest check run failed', async () => {
    const res = await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(createCheckRun).toHaveBeenCalledOnce();
    expect(scanQueue.add).toHaveBeenCalledOnce();
  });

  it('does not enqueue when the latest check run did not fail', async () => {
    (getLatestCheckRun as ReturnType<typeof vi.fn>).mockResolvedValue({ conclusion: 'success' });

    const res = await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('does not enqueue when there is no check run', async () => {
    (getLatestCheckRun as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('posts a confirmation comment after storing exceptions', async () => {
    await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    expect(createPrComment).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 987,
      owner:          'org',
      repo:           'my-repo',
      prNumber:       42,
      body:           expect.stringContaining('Exception recorded'),
    }));
  });

  it('includes the commenter name in the confirmation', async () => {
    await processWebhookRequest(webhookRequest(
      commentPayload({ commenter: 'alice' }), { event: 'issue_comment' }
    ));

    const [call] = (createPrComment as ReturnType<typeof vi.fn>).mock.calls as [{ body: string }][];
    expect(call[0].body).toContain('@alice');
  });

  it('passes issuee_comment action to the job', async () => {
    await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    const [eventName] = (scanQueue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(eventName).toBe('scan');
  });

  it('uses the correct job ID for deduplication', async () => {
    await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    const [, , opts] = (scanQueue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown, { jobId: string }];
    expect(opts.jobId).toBe('org/my-repo#42@abc123');
  });

  it('passes correct payload to isReviewerAuthorized', async () => {
    await processWebhookRequest(webhookRequest(
      commentPayload({ commenter: 'alice' }), { event: 'issue_comment' }
    ));

    expect(isReviewerAuthorized).toHaveBeenCalledWith(expect.objectContaining({
      reviewer:       'alice',
      installationId: 987,
      owner:          'org',
      config:         { users: ['alice'], teams: [] },
    }));
  });

  it('returns Commenter not authorized when isReviewerAuthorized throws', async () => {
    (isReviewerAuthorized as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('GitHub API down'));

    const res = await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'Commenter not authorized' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('still returns Accepted when getLatestCheckRun throws (exceptions stored, comment posted)', async () => {
    (getLatestCheckRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('GitHub API down'));

    const res = await processWebhookRequest(webhookRequest(
      commentPayload(), { event: 'issue_comment' }
    ));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(storeExceptions).toHaveBeenCalled();
    expect(createPrComment).toHaveBeenCalled();
    expect(scanQueue.add).not.toHaveBeenCalled();
  });
});
