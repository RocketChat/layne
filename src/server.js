import 'dotenv/config';
import { fileURLToPath } from 'url';
import express from 'express';
import crypto from 'crypto';
import { scanQueue } from './queue.js';
import { createCheckRun, completeCheckRun } from './github.js';
import { validateEnv } from './env.js';
import { debug } from './debug.js';

const app = express();
const PORT = process.env.PORT || 3000;

const HANDLED_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Raw body required — HMAC verification must run against the exact bytes GitHub sent.
// express.json() would re-serialize and could subtly alter the body.
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

  debug('server', `webhook received: ${event} action=${action} repo=${repository.full_name} PR #${prNumber} sha=${pull_request.head.sha}`);

  if (!HANDLED_ACTIONS.has(action)) {
    debug('server', `ignoring action: ${action}`);
    return { status: 200, body: 'Action ignored' };
  }

  let checkRunId = null;

  try {
    // Only acknowledge the webhook after both the queued check run and the
    // BullMQ job have been created. If either step fails, return 5xx so
    // GitHub retries the delivery instead of silently dropping the scan.
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
      // Deduplicate by repo + PR + commit SHA. If GitHub delivers the same
      // webhook twice (it retries on timeout), the second enqueue is a no-op.
      jobId: `${repository.full_name}#${prNumber}@${pull_request.head.sha}`,
    });

    console.log(`[server] Enqueued scan for ${repository.full_name} PR #${prNumber}`);
    return { status: 200, body: 'Accepted' };
  } catch (err) {
    console.error('[server] Failed to enqueue scan job:', err);

    // If the queued check run exists but the job never made it to BullMQ,
    // fail the check run explicitly so it does not sit in "queued" forever.
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

// Export the app so tests can import it without starting a live server.
export { app, verifySignature };

// Only bind to a port when this file is the process entry point.
// When imported by a test, isMain is false and no port is opened.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  validateEnv();
  app.listen(PORT, () => {
    console.log(`[server] Layne listening on port ${PORT}`);
  });
}
