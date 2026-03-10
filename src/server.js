import 'dotenv/config';
import { fileURLToPath } from 'url';
import express from 'express';
import crypto from 'crypto';
import { redis, scanQueue } from './queue.js';
import { createCheckRun, completeCheckRun } from './github.js';
import { validateEnv } from './env.js';
import { debug } from './debug.js';

const app = express();
const PORT = process.env.PORT || 3000;

const ACCEPTED_RESPONSE = { status: 200, body: 'Accepted' };
const HANDLED_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);
const WEBHOOK_LOCK_TTL_SECONDS = 30;

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/webhook', express.raw({ type: 'application/json' }));

function verifySignature(rawBody, signature) {
  if (!rawBody || !signature) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  // timingSafeEqual prevents timing attacks that could leak the secret
  // by comparing character-by-character speed
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function parsePayload(rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  return JSON.parse(body);
}

function getJobId(repositoryFullName, prNumber, headSha) {
  return `${repositoryFullName}#${prNumber}@${headSha}`;
}

async function acquireWebhookLock(jobId) {
  const key = `layne:webhook:${jobId}`;
  const token = crypto.randomUUID();
  const acquired = await redis.set(key, token, 'EX', WEBHOOK_LOCK_TTL_SECONDS, 'NX');
  return acquired === 'OK' ? { key, token } : null;
}

async function releaseWebhookLock(lock) {
  if (!lock) return;

  await redis.eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0',
    1,
    lock.key,
    lock.token
  );
}

export async function processWebhookRequest({ event, signature, rawBody }) {
  if (!verifySignature(rawBody, signature)) {
    console.warn('[server] Webhook rejected: invalid signature — check GITHUB_WEBHOOK_SECRET');
    return { status: 401, body: 'Invalid signature' };
  }

  if (event !== 'pull_request') {
    return { status: 200, body: 'Event ignored' };
  }

  let payload;
  try {
    payload = parsePayload(rawBody);
  } catch {
    return { status: 400, body: 'Invalid JSON payload' };
  }

  const { action, pull_request, repository, installation } = payload;
  const prNumber = pull_request.number;
  const jobId = getJobId(repository.full_name, prNumber, pull_request.head.sha);

  debug('server', `webhook received: ${event} action=${action} repo=${repository.full_name} PR #${prNumber} sha=${pull_request.head.sha}`);

  if (!HANDLED_ACTIONS.has(action)) {
    debug('server', `ignoring action: ${action}`);
    return { status: 200, body: 'Action ignored' };
  }

  if (await scanQueue.getJob(jobId)) {
    debug('server', `duplicate webhook ignored: job already exists for ${jobId}`);
    return ACCEPTED_RESPONSE;
  }

  const webhookLock = await acquireWebhookLock(jobId);
  if (!webhookLock) {
    debug('server', `duplicate webhook ignored: another request is already accepting ${jobId}`);
    return ACCEPTED_RESPONSE;
  }

  let checkRunId = null;

  try {
    if (await scanQueue.getJob(jobId)) {
      debug('server', `duplicate webhook ignored after lock: job already exists for ${jobId}`);
      return ACCEPTED_RESPONSE;
    }

    checkRunId = await createCheckRun({
      installationId: installation.id,
      owner:          repository.owner.login,
      repo:           repository.name,
      headSha:        pull_request.head.sha,
    });

    await scanQueue.add('scan', {
      installationId: installation.id,
      owner:          repository.owner.login,
      repo:           repository.name,
      repoFullName:   repository.full_name,
      cloneUrl:       repository.clone_url,
      headSha:        pull_request.head.sha,
      headRef:        pull_request.head.ref,
      baseSha:        pull_request.base.sha,
      baseRef:        pull_request.base.ref,
      prNumber,
      labels:         pull_request.labels?.map(l => l.name) ?? [],
      checkRunId,
    }, {
      jobId,
    });

    console.log(`[server] Enqueued scan for ${repository.full_name} PR #${prNumber}`);
    return ACCEPTED_RESPONSE;
  } catch (err) {
    console.error('[server] Failed to enqueue scan job:', err);

    if (checkRunId !== null) {
      await completeCheckRun({
        installationId: installation.id,
        owner:          repository.owner.login,
        repo:           repository.name,
        checkRunId,
        conclusion:     'failure',
        annotations:    [],
        summary:        'Layne failed to accept this scan job. GitHub will retry the webhook delivery.',
      }).catch(() => {});
    }

    return { status: 500, body: 'Failed to accept webhook' };
  } finally {
    await releaseWebhookLock(webhookLock).catch(() => {});
  }
}

app.post('/webhook', async (req, res) => {
  const result = await processWebhookRequest({
    event:     req.headers['x-github-event'],
    signature: req.headers['x-hub-signature-256'],
    rawBody:   req.body,
  });

  return res.status(result.status).send(result.body);
});

export { app, verifySignature };

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  validateEnv();
  app.listen(PORT, () => {
    console.log(`[server] Layne listening on port ${PORT}`);
  });
}
