import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { redis, scanQueue } from './queue.js';
import { createCheckRun, completeCheckRun, skipCheckRun, findPullRequestBySha } from './github.js';
import { loadScanConfig } from './config.js';
import { validateEnv } from './env.js';
import { debug } from './debug.js';
import { registry, webhooksTotal } from './metrics.js';

const METRICS_ENABLED = process.env.METRICS_ENABLED === 'true';

const app = express();
const PORT = process.env.PORT || 3000;

const ACCEPTED_RESPONSE          = { status: 200, body: 'Accepted' };
const HANDLED_PR_ACTIONS         = new Set(['opened', 'synchronize', 'reopened']);
const WEBHOOK_LOCK_TTL_SECONDS   = 30;
const PR_CACHE_TTL_SECONDS       = 7 * 24 * 60 * 60; // 7 days

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

if (METRICS_ENABLED) {
  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });
}

app.get('/assets/layne-logo.png', (_req, res) => {
  res.sendFile(join(__dirname, '..', 'assets', 'layne-logo.png'));
});

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

function prCacheKey(repoFullName, headSha) {
  return `layne:pr:${repoFullName}:${headSha}`;
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

  if (event !== 'pull_request' && event !== 'workflow_run' && event !== 'workflow_job') {
    return { status: 200, body: 'Event ignored' };
  }

  let payload;
  try {
    payload = parsePayload(rawBody);
  } catch {
    return { status: 400, body: 'Invalid JSON payload' };
  }

  if (event === 'pull_request') {
    return handlePullRequest(payload);
  }
  if (event === 'workflow_job') {
    return handleWorkflowJob(payload);
  }
  return handleWorkflowRun(payload);
}

// ---------------------------------------------------------------------------
// pull_request handler
// ---------------------------------------------------------------------------

async function handlePullRequest(payload) {
  const { action, pull_request, repository, installation } = payload;
  const prNumber = pull_request.number;
  const headSha  = pull_request.head.sha;
  const jobId    = getJobId(repository.full_name, prNumber, headSha);

  debug('server', `pull_request webhook: action=${action} repo=${repository.full_name} PR #${prNumber} sha=${headSha}`);

  if (!HANDLED_PR_ACTIONS.has(action)) {
    debug('server', `ignoring action: ${action}`);
    return { status: 200, body: 'Action ignored' };
  }

  const config = await loadScanConfig({ owner: repository.owner.login, repo: repository.name });

  if (config.trigger.on === 'workflow_run' || config.trigger.on === 'workflow_job') {
    return deferPullRequest({ pull_request, repository, installation, config });
  }

  return enqueueScan({ pull_request, repository, installation, jobId, action });
}

async function deferPullRequest({ pull_request, repository, installation, config }) {
  const headSha  = pull_request.head.sha;
  const cacheKey = prCacheKey(repository.full_name, headSha);

  await redis.set(cacheKey, JSON.stringify({
    prNumber:       pull_request.number,
    headSha,
    headRef:        pull_request.head.ref,
    baseSha:        pull_request.base.sha,
    baseRef:        pull_request.base.ref,
    labels:         pull_request.labels?.map(l => l.name) ?? [],
    installationId: installation.id,
    cloneUrl:       repository.clone_url,
    repoFullName:   repository.full_name,
  }), 'EX', PR_CACHE_TTL_SECONDS);

  const deferSummary = config.trigger.on === 'workflow_job'
    ? `Scan deferred — waiting for CI job "${config.trigger.job}" to complete.`
    : `Scan deferred — waiting for CI workflow "${config.trigger.workflow}" to complete.`;

  await skipCheckRun({
    installationId: installation.id,
    owner:          repository.owner.login,
    repo:           repository.name,
    headSha,
    summary:        deferSummary,
  }).catch(err => {
    console.error(`[server] Failed to create skipped check run: ${err.message}`);
  });

  const deferTarget = config.trigger.on === 'workflow_job'
    ? `job "${config.trigger.job}"`
    : `workflow "${config.trigger.workflow}"`;
  debug('server', `deferred scan for ${repository.full_name} PR #${pull_request.number}: waiting for ${deferTarget}`);
  return { status: 200, body: 'Deferred' };
}

// ---------------------------------------------------------------------------
// workflow_run handler
// ---------------------------------------------------------------------------

async function handleWorkflowRun(payload) {
  const { action, workflow_run, repository, installation } = payload;

  debug('server', `workflow_run webhook: action=${action} workflow="${workflow_run?.name}" repo=${repository.full_name} conclusion=${workflow_run?.conclusion}`);

  if (action !== 'completed') {
    return { status: 200, body: 'Event ignored' };
  }

  const config = await loadScanConfig({ owner: repository.owner.login, repo: repository.name });

  if (config.trigger.on !== 'workflow_run') {
    debug('server', `ignoring workflow_run: repo ${repository.full_name} uses "${config.trigger.on}" trigger`);
    return { status: 200, body: 'Event ignored' };
  }

  if (workflow_run.name !== config.trigger.workflow) {
    debug('server', `ignoring workflow_run: "${workflow_run.name}" doesn't match configured "${config.trigger.workflow}"`);
    return { status: 200, body: 'Event ignored' };
  }

  const conclusions = config.trigger.conclusions ?? ['success'];
  if (!conclusions.includes(workflow_run.conclusion)) {
    debug('server', `ignoring workflow_run: conclusion "${workflow_run.conclusion}" not in [${conclusions.join(', ')}]`);
    return { status: 200, body: 'Event ignored' };
  }

  const headSha  = workflow_run.head_sha;
  const prData   = await resolvePrData({ installation, repository, headSha });

  if (!prData) {
    console.warn(`[server] workflow_run: could not find PR for ${repository.full_name}@${headSha} — scan skipped`);
    return { status: 200, body: 'PR not found' };
  }

  const jobId = getJobId(repository.full_name, prData.prNumber, headSha);

  return enqueueScan({
    pull_request: {
      number: prData.prNumber,
      head:   { sha: headSha, ref: prData.headRef },
      base:   { sha: prData.baseSha, ref: prData.baseRef },
      labels: prData.labels.map(name => ({ name })),
    },
    repository,
    installation: { id: prData.installationId },
    jobId,
    action: 'workflow_run',
  });
}

// ---------------------------------------------------------------------------
// workflow_job handler
// ---------------------------------------------------------------------------

async function handleWorkflowJob(payload) {
  const { action, workflow_job, repository, installation } = payload;

  debug('server', `workflow_job webhook: action=${action} job="${workflow_job?.name}" repo=${repository.full_name} conclusion=${workflow_job?.conclusion}`);

  if (action !== 'completed') {
    return { status: 200, body: 'Event ignored' };
  }

  const config = await loadScanConfig({ owner: repository.owner.login, repo: repository.name });

  if (config.trigger.on !== 'workflow_job') {
    debug('server', `ignoring workflow_job: repo ${repository.full_name} uses "${config.trigger.on}" trigger`);
    return { status: 200, body: 'Event ignored' };
  }

  if (workflow_job.name !== config.trigger.job) {
    debug('server', `ignoring workflow_job: "${workflow_job.name}" doesn't match configured "${config.trigger.job}"`);
    return { status: 200, body: 'Event ignored' };
  }

  const conclusions = config.trigger.conclusions ?? ['success'];
  if (!conclusions.includes(workflow_job.conclusion)) {
    debug('server', `ignoring workflow_job: conclusion "${workflow_job.conclusion}" not in [${conclusions.join(', ')}]`);
    return { status: 200, body: 'Event ignored' };
  }

  const headSha = workflow_job.head_sha;
  const prData  = await resolvePrData({ installation, repository, headSha });

  if (!prData) {
    console.warn(`[server] workflow_job: could not find PR for ${repository.full_name}@${headSha} — scan skipped`);
    return { status: 200, body: 'PR not found' };
  }

  const jobId = getJobId(repository.full_name, prData.prNumber, headSha);

  return enqueueScan({
    pull_request: {
      number: prData.prNumber,
      head:   { sha: headSha, ref: prData.headRef },
      base:   { sha: prData.baseSha, ref: prData.baseRef },
      labels: prData.labels.map(name => ({ name })),
    },
    repository,
    installation: { id: prData.installationId },
    jobId,
    action: 'workflow_job',
  });
}

async function resolvePrData({ installation, repository, headSha }) {
  const cacheKey = prCacheKey(repository.full_name, headSha);
  const cached   = await redis.get(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss: Layne may have been offline when the PR was opened, or Redis
  // was cleared. Fall back to the GitHub API to find the associated PR.
  debug('server', `PR cache miss for ${repository.full_name}@${headSha} — querying GitHub API`);

  try {
    const pr = await findPullRequestBySha({
      installationId: installation.id,
      owner:          repository.owner.login,
      repo:           repository.name,
      headSha,
    });

    if (!pr) return null;

    return {
      prNumber:       pr.number,
      headSha,
      headRef:        pr.head.ref,
      baseSha:        pr.base.sha,
      baseRef:        pr.base.ref,
      labels:         pr.labels?.map(l => l.name) ?? [],
      installationId: installation.id,
      cloneUrl:       repository.clone_url,
      repoFullName:   repository.full_name,
    };
  } catch (err) {
    console.error(`[server] Failed to recover PR from GitHub API: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared enqueue path (used by both pull_request and workflow_run triggers)
// ---------------------------------------------------------------------------

async function enqueueScan({ pull_request, repository, installation, jobId, action }) {
  if (await scanQueue.getJob(jobId)) {
    debug('server', `duplicate webhook ignored: job already exists for ${jobId}`);
    webhooksTotal.inc({ action, deduplicated: 'true' });
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
      webhooksTotal.inc({ action, deduplicated: 'true' });
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
      prNumber:       pull_request.number,
      labels:         pull_request.labels?.map(l => l.name) ?? [],
      checkRunId,
    }, {
      jobId,
    });

    console.log(`[server] Enqueued scan for ${repository.full_name} PR #${pull_request.number}`);
    webhooksTotal.inc({ action, deduplicated: 'false' });
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
