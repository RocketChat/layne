import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('../queue.js', () => ({
  redis: { set: vi.fn(), eval: vi.fn() },
  scanQueue: { add: vi.fn(), getJob: vi.fn() },
}));

vi.mock('../github.js', () => ({
  createCheckRun: vi.fn(),
  completeCheckRun: vi.fn(),
}));

const { redis, scanQueue } = await import('../queue.js');
const { createCheckRun, completeCheckRun } = await import('../github.js');
const { verifySignature, processWebhookRequest } = await import('../server.js');

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
  redis.set.mockResolvedValue('OK');
  redis.eval.mockResolvedValue(1);
  scanQueue.add.mockResolvedValue({ id: 'job-1' });
  scanQueue.getJob.mockResolvedValue(null);
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

  it('ignores non-pull_request events', async () => {
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
});
