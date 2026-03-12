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
}));

vi.mock('../config.js', () => ({
  loadScanConfig: vi.fn(),
}));

vi.mock('../metrics.js', () => ({
  registry:      null,
  webhooksTotal: { inc: vi.fn() },
}));

const { redis, scanQueue }                           = await import('../queue.js');
const { createCheckRun, completeCheckRun,
        skipCheckRun, findPullRequestBySha }         = await import('../github.js');
const { loadScanConfig }                             = await import('../config.js');
const { webhooksTotal }                              = await import('../metrics.js');
const { app, verifySignature, processWebhookRequest } = await import('../server.js');

const PR_TRIGGER_CONFIG       = { trigger: { on: 'pull_request' } };
const WORKFLOW_TRIGGER_CONFIG = { trigger: { on: 'workflow_run', workflow: 'Tests Done', conclusions: ['success'] } };

function sign(body) {
  return 'sha256=' + crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET)
    .update(Buffer.isBuffer(body) ? body : Buffer.from(body))
    .digest('hex');
}

function prPayload(action = 'opened') {
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
} = {}) {
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

function webhookRequest(body, { event = 'pull_request', signature } = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    event,
    signature: signature ?? sign(bodyStr),
    rawBody:   Buffer.from(bodyStr),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  createCheckRun.mockResolvedValue(99);
  completeCheckRun.mockResolvedValue(undefined);
  skipCheckRun.mockResolvedValue(undefined);
  findPullRequestBySha.mockResolvedValue(null);
  redis.set.mockResolvedValue('OK');
  redis.eval.mockResolvedValue(1);
  redis.get.mockResolvedValue(null);
  scanQueue.add.mockResolvedValue({ id: 'job-1' });
  scanQueue.getJob.mockResolvedValue(null);
  loadScanConfig.mockResolvedValue(PR_TRIGGER_CONFIG);
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

  it('ignores non-pull_request / non-workflow_run events', async () => {
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
    createCheckRun.mockReturnValueOnce(checkRun.promise);
    scanQueue.add.mockReturnValueOnce(enqueue.promise);

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

    const [eventName, jobData] = scanQueue.add.mock.calls[0];
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

    const [, , opts] = scanQueue.add.mock.calls[0];
    expect(opts.jobId).toBe('org/my-repo#42@abc123');
  });

  it('does not create a second check run when the job already exists', async () => {
    scanQueue.getJob.mockResolvedValueOnce({ id: 'org/my-repo#42@abc123' });

    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('does not create a second check run while another request is accepting the same webhook', async () => {
    redis.set.mockResolvedValueOnce(null);

    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('returns 500 and skips enqueueing when createCheckRun fails', async () => {
    createCheckRun.mockRejectedValueOnce(new Error('GitHub unavailable'));

    const res = await processWebhookRequest(webhookRequest(prPayload('opened')));

    expect(res).toEqual({ status: 500, body: 'Failed to accept webhook' });
    expect(scanQueue.add).not.toHaveBeenCalled();
    expect(completeCheckRun).not.toHaveBeenCalled();
  });

  it('returns 500 and fails the queued check run when enqueueing fails', async () => {
    scanQueue.add.mockRejectedValueOnce(new Error('Redis unavailable'));

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
      loadScanConfig.mockResolvedValue(PR_TRIGGER_CONFIG);
      await processWebhookRequest(webhookRequest(prPayload('opened')));
      expect(webhooksTotal.inc).toHaveBeenCalledWith({ action: 'opened', deduplicated: 'false' });
    });

    it('increments webhooksTotal with deduplicated=true when a duplicate webhook is received', async () => {
      loadScanConfig.mockResolvedValue(PR_TRIGGER_CONFIG);
      scanQueue.getJob.mockResolvedValueOnce({ id: 'existing-job' });
      await processWebhookRequest(webhookRequest(prPayload('opened')));
      expect(webhooksTotal.inc).toHaveBeenCalledWith({ action: 'opened', deduplicated: 'true' });
    });
  });
});

// ---------------------------------------------------------------------------
// workflow_run trigger — pull_request events deferred
// ---------------------------------------------------------------------------

describe('workflow_run trigger — pull_request event', () => {
  beforeEach(() => {
    loadScanConfig.mockResolvedValue(WORKFLOW_TRIGGER_CONFIG);
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

    const cached = JSON.parse(redis.set.mock.calls[0][1]);
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
    skipCheckRun.mockRejectedValueOnce(new Error('GitHub API error'));

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
    loadScanConfig.mockResolvedValue(WORKFLOW_TRIGGER_CONFIG);
    redis.get.mockResolvedValue(CACHED_PR);
  });

  it('enqueues a scan when the workflow run matches config', async () => {
    const res = await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(createCheckRun).toHaveBeenCalledOnce();
    expect(scanQueue.add).toHaveBeenCalledOnce();
  });

  it('enqueues with the correct job payload from the cached PR data', async () => {
    await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    const [, jobData] = scanQueue.add.mock.calls[0];
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

    const [, , opts] = scanQueue.add.mock.calls[0];
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
    loadScanConfig.mockResolvedValue(PR_TRIGGER_CONFIG);

    const res = await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    expect(res).toEqual({ status: 200, body: 'Event ignored' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('deduplicates: does not enqueue when the job already exists', async () => {
    scanQueue.getJob.mockResolvedValueOnce({ id: 'org/my-repo#42@abc123' });

    const res = await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('returns 200 with "PR not found" when cache is cold and GitHub API returns nothing', async () => {
    redis.get.mockResolvedValue(null);
    findPullRequestBySha.mockResolvedValue(null);

    const res = await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    expect(res).toEqual({ status: 200, body: 'PR not found' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('falls back to GitHub API when cache is cold and enqueues from API data', async () => {
    redis.get.mockResolvedValue(null);
    findPullRequestBySha.mockResolvedValue({
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
    redis.get.mockResolvedValue(null);
    findPullRequestBySha.mockRejectedValue(new Error('API error'));

    const res = await processWebhookRequest(webhookRequest(workflowRunPayload(), { event: 'workflow_run' }));

    expect(res).toEqual({ status: 200, body: 'PR not found' });
    expect(scanQueue.add).not.toHaveBeenCalled();
  });

  it('enqueues with configured non-default conclusions', async () => {
    loadScanConfig.mockResolvedValue({
      trigger: { on: 'workflow_run', workflow: 'Tests Done', conclusions: ['success', 'failure'] },
    });

    const res = await processWebhookRequest(webhookRequest(
      workflowRunPayload({ conclusion: 'failure' }), { event: 'workflow_run' }
    ));

    expect(res).toEqual({ status: 200, body: 'Accepted' });
    expect(scanQueue.add).toHaveBeenCalledOnce();
  });
});
