import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { redis, scanQueue } from './queue.js';
import { createCheckRun, completeCheckRun, skipCheckRun, findPullRequestBySha, getLatestCheckRun, getPullRequest, createPrComment } from './github.js';
import { loadScanConfig, validateConfigFile } from './config.js';
import { validateEnv } from './env.js';
import { debug } from './debug.js';
import { registry, webhooksTotal } from './metrics.js';
import {
  isReviewerAuthorized,
  loadBulkExceptionRequest,
  parseExceptionCommand,
  storeBulkExceptionRequest,
  storeExceptions,
} from './exception-approvals.js';
import type { JobData, PRCacheData, PullRequestMetadata } from './types.js';

const METRICS_ENABLED = process.env.METRICS_ENABLED === 'true';

const app = express();
const PORT = process.env.PORT ?? 3000;

const ACCEPTED_RESPONSE          = { status: 200, body: 'Accepted' };
const HANDLED_PR_ACTIONS         = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);
const WEBHOOK_LOCK_TTL_SECONDS   = 30;
const PR_CACHE_TTL_SECONDS       = 7 * 24 * 60 * 60; // 7 days
const PR_TITLE_MAX_BYTES         = 512;
const PR_BODY_MAX_BYTES          = 8 * 1024;
const PR_AUTHOR_MAX_BYTES        = 128;
const CONTROL_CHARACTERS         = /[\u0000-\u001f\u007f-\u009f]+/g;

class BulkRequestRejectedError extends Error {}

app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

if (METRICS_ENABLED) {
  app.get('/metrics', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', registry!.contentType);
    res.end(await registry!.metrics());
  });
}

app.get('/assets/layne-logo.png', (_req: Request, res: Response) => {
  res.sendFile(join(__dirname, '..', 'assets', 'layne-logo.png'));
});

app.use('/webhook', express.raw({ type: 'application/json' }));

function verifySignature(rawBody: Buffer | string | undefined, signature: string | undefined): boolean {
  if (!rawBody || !signature) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function parsePayload(rawBody: Buffer | string): Record<string, unknown> {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  // JSON.parse result typed as webhook payload
  return JSON.parse(body) as Record<string, unknown>;
}

function getJobId(repositoryFullName: string, prNumber: number, headSha: string): string {
  return `${repositoryFullName}#${prNumber}@${headSha}`;
}

function prCacheKey(repoFullName: string, headSha: string): string {
  return `layne:pr:${repoFullName}:${headSha}`;
}

function trustedRepositoryId(repository: { id?: unknown }): number | undefined {
  return Number.isSafeInteger(repository.id) && (repository.id as number) > 0
    ? repository.id as number
    : undefined;
}

function normalizeUntrustedText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string') return '';

  const normalized = value.replace(CONTROL_CHARACTERS, ' ');
  let result = '';
  let bytes = 0;

  for (const character of normalized) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }

  return result;
}

function normalizePullRequestMetadata(metadata: unknown): PullRequestMetadata {
  const source = metadata !== null && typeof metadata === 'object'
    ? metadata as Record<string, unknown>
    : {};

  return {
    trust:  'untrusted',
    title:  normalizeUntrustedText(source['title'], PR_TITLE_MAX_BYTES),
    body:   normalizeUntrustedText(source['body'], PR_BODY_MAX_BYTES),
    author: normalizeUntrustedText(source['author'], PR_AUTHOR_MAX_BYTES),
  };
}

function metadataFromPullRequest(pullRequest: {
  title?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
}): PullRequestMetadata {
  return normalizePullRequestMetadata({
    title:  pullRequest.title,
    body:   pullRequest.body,
    author: pullRequest.user?.login,
  });
}

async function acquireWebhookLock(jobId: string): Promise<{ key: string; token: string } | null> {
  const key = `layne:webhook:${jobId}`;
  const token = crypto.randomUUID();
  const acquired = await redis.set(key, token, 'EX', WEBHOOK_LOCK_TTL_SECONDS, 'NX');
  return acquired === 'OK' ? { key, token } : null;
}

async function releaseWebhookLock(lock: { key: string; token: string } | null): Promise<void> {
  if (!lock) return;

  await redis.eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0',
    1,
    lock.key,
    lock.token
  );
}

export async function processWebhookRequest({ event, signature, rawBody }: {
  event: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | string | undefined;
}): Promise<{ status: number; body: string }> {
  if (!verifySignature(rawBody, signature)) {
    console.warn('[server] Webhook rejected: invalid signature — check GITHUB_WEBHOOK_SECRET');
    return { status: 401, body: 'Invalid signature' };
  }

  if (event !== 'pull_request' && event !== 'workflow_run' && event !== 'workflow_job' && event !== 'issue_comment') {
    return { status: 200, body: 'Event ignored' };
  }

  let payload: Record<string, unknown>;
  try {
    payload = parsePayload(rawBody!);
  } catch {
    return { status: 400, body: 'Invalid JSON payload' };
  }

  if (event === 'pull_request') {
    return handlePullRequest(payload);
  }
  if (event === 'issue_comment') {
    return handleIssueComment(payload);
  }
  if (event === 'workflow_job') {
    return handleWorkflowJob(payload);
  }
  return handleWorkflowRun(payload);
}

// ---------------------------------------------------------------------------
// pull_request handler
// ---------------------------------------------------------------------------

async function handlePullRequest(payload: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const { action, pull_request, repository, installation } = payload as {
    action: string;
    pull_request: Record<string, unknown>;
    repository: Record<string, unknown>;
    installation: Record<string, unknown>;
  };
  const pr = pull_request as {
    number: number;
    draft?: boolean;
    head: { sha: string };
    base: { sha: string; ref: string };
    title?: unknown;
    body?: unknown;
    user?: { login?: unknown } | null;
  };
  const prNumber = pr.number;
  const headSha  = pr.head.sha;
  const repo = repository as { id?: unknown; full_name: string; owner: { login: string }; name: string };
  const jobId    = getJobId(repo.full_name, prNumber, headSha);

  debug('server', `pull_request webhook: action=${action} repo=${repo.full_name} PR #${prNumber} sha=${headSha}`);

  if (!HANDLED_PR_ACTIONS.has(action)) {
    debug('server', `ignoring action: ${action}`);
    return { status: 200, body: 'Action ignored' };
  }

  const config = await loadScanConfig({ owner: repo.owner.login, repo: repo.name });

  if (pr.draft === true && !config.trigger.scanOnDraft) {
    debug('server', `ignoring draft PR: ${repo.full_name} PR #${prNumber}`);
    return { status: 200, body: 'Draft ignored' };
  }

  if (config.trigger.on === 'workflow_run' || config.trigger.on === 'workflow_job') {
    return deferPullRequest({ pull_request: pr, repository: repo, installation, config });
  }

  return enqueueScan({
    pull_request: pr,
    pullRequestMetadata: metadataFromPullRequest(pr),
    repository: repo,
    installation,
    jobId,
    action,
  });
}

// ---------------------------------------------------------------------------
// issue_comment handler
// ---------------------------------------------------------------------------

async function handleIssueComment(payload: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const { action, issue, comment, repository, installation } = payload as {
    action: string;
    issue: Record<string, unknown>;
    comment: Record<string, unknown>;
    repository: Record<string, unknown>;
    installation: Record<string, unknown>;
  };

  const repo = repository as { id?: unknown; full_name: string; owner: { login: string }; name: string };
  const issueData = issue as { number: number; pull_request?: unknown };
  const commentData = comment as { id?: number | string; created_at?: string; body: string; user: { login: string } };

  debug('server', `issue_comment webhook: action=${action} repo=${repo.full_name} issue #${issueData?.number}`);

  if (action !== 'created') {
    return { status: 200, body: 'Event ignored' };
  }

  if (!issueData.pull_request) {
    return { status: 200, body: 'Event ignored' };
  }

  const parsed = parseExceptionCommand(commentData.body);
  if (!parsed) {
    return { status: 200, body: 'Event ignored' };
  }

  const config = await loadScanConfig({ owner: repo.owner.login, repo: repo.name });
  const approvers = config.exceptionApprovers;
  if (!approvers?.users?.length && !approvers?.teams?.length) {
    debug('server', 'ignoring issue_comment: no exception approvers configured');
    return { status: 200, body: 'No exception approvers configured' };
  }

  if (parsed.error) {
    await createPrComment({
      installationId: (installation as { id: number }).id,
      owner:          repo.owner.login,
      repo:           repo.name,
      prNumber:       issueData.number,
      body:           `❌ Invalid exception command: ${parsed.error}`,
    }).catch(err => console.error(`[server] Failed to post error reply: ${(err as Error).message}`));
    return { status: 200, body: 'Invalid command' };
  }

  const commenter = commentData.user.login;
  const isAuthorized = await isReviewerAuthorized({
    reviewer:       commenter,
    config:         approvers,
    installationId: (installation as { id: number }).id,
    owner:          repo.owner.login,
  }).catch(err => {
    console.error(`[server] Failed to check reviewer authorization: ${(err as Error).message}`);
    return false;
  });

  if (!isAuthorized) {
    debug('server', `ignoring issue_comment: commenter ${commenter} not in exception approvers`);
    return { status: 200, body: 'Commenter not authorized' };
  }

  const pr = await getPullRequest({
    installationId: (installation as { id: number }).id,
    owner:          repo.owner.login,
    repo:           repo.name,
    prNumber:       issueData.number,
  }).catch(err => {
    console.error(`[server] Failed to get PR: ${(err as Error).message}`);
    return null;
  });

  if (!pr) {
    return { status: 200, body: 'PR not found' };
  }

  const prData = pr as {
    state?: string;
    head: { sha: string };
    base: { sha: string; ref: string };
    title?: unknown;
    body?: unknown;
    user?: { login?: unknown } | null;
  };

  if (prData.state !== 'open') {
    debug('server', `issue_comment on non-open PR #${issueData.number} (state=${prData.state ?? 'unknown'}), ignoring`);
    return { status: 200, body: 'PR not open' };
  }
  const headSha = prData.head.sha;

  if (parsed.target === 'ids') {
    try {
      await storeExceptions({
        owner:           repo.owner.login,
        repo:            repo.name,
        prNumber:        issueData.number,
        approvedHeadSha: headSha,
        findingIds:      parsed.ids,
        approver:        commenter,
        reason:          parsed.reason!,
      });
    } catch (err) {
      console.error(`[server] Failed to store exceptions: ${(err as Error).message}`);
      await createPrComment({
        installationId: (installation as { id: number }).id,
        owner:          repo.owner.login,
        repo:           repo.name,
        prNumber:       issueData.number,
        body:           '❌ Layne could not record the exception. Please retry.',
      }).catch(commentError => console.error(`[server] Failed to post error reply: ${(commentError as Error).message}`));
      return { status: 200, body: 'Exception storage failed' };
    }
  }

  const checkRun = await getLatestCheckRun({
    installationId: (installation as { id: number }).id,
    owner:          repo.owner.login,
    repo:           repo.name,
    headSha,
  }).catch(err => {
    console.error(`[server] Failed to get latest check run: ${(err as Error).message}`);
    return null;
  });

  const checkRunData = checkRun as { conclusion?: string; completed_at?: string } | null;
  if (parsed.target === 'all') {
    const requestId = String(commentData.id ?? '');
    if (!requestId) {
      console.error('[server] Bulk exception command is missing its GitHub comment ID');
      return { status: 200, body: 'Invalid command' };
    }

    const existingRequest = await loadBulkExceptionRequest({
      owner: repo.owner.login, repo: repo.name, prNumber: issueData.number, approvedHeadSha: headSha, requestId,
    }).catch(() => null);
    if (existingRequest?.state === 'materialized') return ACCEPTED_RESPONSE;

    if (checkRunData?.conclusion !== 'failure') {
      await createPrComment({
        installationId: (installation as { id: number }).id,
        owner: repo.owner.login,
        repo: repo.name,
        prNumber: issueData.number,
        body: '❌ Layne can only approve all findings from a failed scan on the current PR head.',
      }).catch(err => console.error(`[server] Failed to post error reply: ${(err as Error).message}`));
      return { status: 200, body: 'No failed scan' };
    }

    const commentCreatedAt = Date.parse(commentData.created_at ?? '');
    const scanCompletedAt = Date.parse(checkRunData.completed_at ?? '');
    if (!Number.isFinite(commentCreatedAt) || !Number.isFinite(scanCompletedAt) || commentCreatedAt <= scanCompletedAt) {
      await createPrComment({
        installationId: (installation as { id: number }).id,
        owner: repo.owner.login,
        repo: repo.name,
        prNumber: issueData.number,
        body: '❌ This bulk exception command does not apply to the latest failed scan. Post a new command after reviewing the current result.',
      }).catch(err => console.error(`[server] Failed to post error reply: ${(err as Error).message}`));
      return { status: 200, body: 'Command predates failed scan' };
    }

    const jobId = getJobId(repo.full_name, issueData.number, headSha);
    const acceptance = await enqueueScanDetailed({
      pull_request: {
        number: issueData.number,
        head: { sha: headSha },
        base: { sha: prData.base.sha, ref: prData.base.ref },
      },
      pullRequestMetadata: metadataFromPullRequest(prData),
      repository: repo,
      installation,
      jobId,
      action: 'issue_comment',
      triggeredByException: true,
      exceptionApprovalRequest: { kind: 'all', requestId },
    }, {
      bulkRequestId: requestId,
      beforeEnqueue: async () => {
        const stored = await storeBulkExceptionRequest({
          owner: repo.owner.login,
          repo: repo.name,
          prNumber: issueData.number,
          approvedHeadSha: headSha,
          requestId,
          approver: commenter,
          reason: parsed.reason!,
        });
        if (stored === 'head-mismatch') {
          throw new BulkRequestRejectedError('Bulk exception comment is already bound to another PR head');
        }
      },
    });

    if (acceptance.outcome === 'busy') {
      await createPrComment({
        installationId: (installation as { id: number }).id,
        owner: repo.owner.login,
        repo: repo.name,
        prNumber: issueData.number,
        body: '❌ Another scan is already in progress for this commit. Retry the bulk exception command after it completes.',
      }).catch(err => console.error(`[server] Failed to post error reply: ${(err as Error).message}`));
      return acceptance.response;
    }
    if (acceptance.outcome === 'failed') {
      await createPrComment({
        installationId: (installation as { id: number }).id,
        owner: repo.owner.login,
        repo: repo.name,
        prNumber: issueData.number,
        body: '❌ Layne could not enqueue the bulk exception re-scan. Retry the command.',
      }).catch(err => console.error(`[server] Failed to post error reply: ${(err as Error).message}`));
      return acceptance.response;
    }
    if (acceptance.outcome === 'rejected') {
      await createPrComment({
        installationId: (installation as { id: number }).id,
        owner: repo.owner.login,
        repo: repo.name,
        prNumber: issueData.number,
        body: '❌ This bulk exception comment is already bound to a different PR head. Post a new command for the current scan.',
      }).catch(err => console.error(`[server] Failed to post error reply: ${(err as Error).message}`));
      return acceptance.response;
    }
    if (acceptance.outcome === 'duplicate') return acceptance.response;

    await createPrComment({
      installationId: (installation as { id: number }).id,
      owner: repo.owner.login,
      repo: repo.name,
      prNumber: issueData.number,
      body: `✅ Bulk exception request accepted for all current blocking findings by @${commenter}: "${parsed.reason}". Re-running scan...`,
    }).catch(err => console.error(`[server] Failed to post confirmation: ${(err as Error).message}`));
    return acceptance.response;
  }

  let rescanQueued = false;
  if (checkRunData?.conclusion === 'failure') {
    const jobId = getJobId(repo.full_name, issueData.number, headSha);
    const acceptance = await enqueueScanDetailed({
      pull_request: {
        number: issueData.number,
        head:   { sha: headSha },
        base:   { sha: prData.base.sha, ref: prData.base.ref },
      },
      pullRequestMetadata: metadataFromPullRequest(prData),
      repository: repo,
      installation,
      jobId,
      action: 'issue_comment',
      triggeredByException: true,
      exceptionApprovalRequest: { kind: 'ids', findingIds: parsed.ids, approver: commenter },
    }).catch(err => console.error(`[server] Failed to enqueue scan: ${(err as Error).message}`));
    rescanQueued = acceptance?.outcome === 'enqueued';
  }

  const idList = parsed.ids.join(', ');
  await createPrComment({
    installationId: (installation as { id: number }).id,
    owner:          repo.owner.login,
    repo:           repo.name,
    prNumber:       issueData.number,
    body:           `✅ Exception recorded for ${idList} by @${commenter}: "${parsed.reason}".${rescanQueued ? ' Re-running scan...' : ''}`,
  }).catch(err => console.error(`[server] Failed to post confirmation: ${(err as Error).message}`));

  return { status: 200, body: 'Accepted' };
}

async function deferPullRequest({ pull_request, repository, installation, config }: {
  pull_request: {
    number: number;
    head: { sha: string };
    base: { sha: string; ref: string };
    title?: unknown;
    body?: unknown;
    user?: { login?: unknown } | null;
  };
  repository: { id?: unknown; full_name: string; clone_url?: string; owner: { login: string }; name: string };
  installation: Record<string, unknown>;
  config: Awaited<ReturnType<typeof loadScanConfig>>;
}): Promise<{ status: number; body: string }> {
  const headSha  = pull_request.head.sha;
  const cacheKey = prCacheKey(repository.full_name, headSha);

  const cacheData: PRCacheData = {
    ...(trustedRepositoryId(repository) ? { repositoryId: trustedRepositoryId(repository) } : {}),
    prNumber:       pull_request.number,
    baseSha:        pull_request.base.sha,
    baseRef:        pull_request.base.ref,
    installationId: (installation as { id: number }).id,
    pullRequestMetadata: metadataFromPullRequest(pull_request),
  };

  await redis.set(cacheKey, JSON.stringify(cacheData), 'EX', PR_CACHE_TTL_SECONDS);

  const deferSummary = config.trigger.on === 'workflow_job'
    ? `Scan deferred — waiting for CI job "${config.trigger.job}" to complete.`
    : `Scan deferred — waiting for CI workflow "${config.trigger.workflow}" to complete.`;

  await skipCheckRun({
    installationId: (installation as { id: number }).id,
    owner:          repository.owner.login,
    repo:           repository.name,
    headSha,
    summary:        deferSummary,
  }).catch(err => {
    console.error(`[server] Failed to create skipped check run: ${(err as Error).message}`);
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

async function handleWorkflowRun(payload: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const { action, workflow_run, repository, installation } = payload as {
    action: string;
    workflow_run: Record<string, unknown>;
    repository: Record<string, unknown>;
    installation: Record<string, unknown>;
  };

  const repo = repository as { id?: unknown; full_name: string; owner: { login: string }; name: string; clone_url?: string };
  const run = workflow_run as { name?: string; head_sha: string; conclusion?: string };

  debug('server', `workflow_run webhook: action=${action} workflow="${run?.name}" repo=${repo.full_name} conclusion=${run?.conclusion}`);

  if (action !== 'completed') {
    return { status: 200, body: 'Event ignored' };
  }

  const config = await loadScanConfig({ owner: repo.owner.login, repo: repo.name });

  if (config.trigger.on !== 'workflow_run') {
    debug('server', `ignoring workflow_run: repo ${repo.full_name} uses "${config.trigger.on}" trigger`);
    return { status: 200, body: 'Event ignored' };
  }

  if (run.name !== config.trigger.workflow) {
    debug('server', `ignoring workflow_run: "${run.name}" doesn't match configured "${config.trigger.workflow}"`);
    return { status: 200, body: 'Event ignored' };
  }

  const conclusions = config.trigger.conclusions ?? ['success'];
  if (!conclusions.includes(run.conclusion!)) {
    debug('server', `ignoring workflow_run: conclusion "${run.conclusion}" not in [${conclusions.join(', ')}]`);
    return { status: 200, body: 'Event ignored' };
  }

  const headSha  = run.head_sha;
  const prData   = await resolvePrData({
    installation,
    repository: repo,
    headSha,
    scanOnDraft: config.trigger.scanOnDraft,
  });

  if (!prData) {
    console.warn(`[server] workflow_run: could not find PR for ${repo.full_name}@${headSha} — scan skipped`);
    return { status: 200, body: 'PR not found' };
  }

  const jobId = getJobId(repo.full_name, prData.prNumber, headSha);

  return enqueueScan({
    pull_request: {
      number: prData.prNumber,
      head:   { sha: headSha },
      base:   { sha: prData.baseSha, ref: prData.baseRef },
    },
    pullRequestMetadata: prData.pullRequestMetadata,
    repository: repo,
    installation: { id: prData.installationId },
    jobId,
    action: 'workflow_run',
  });
}

// ---------------------------------------------------------------------------
// workflow_job handler
// ---------------------------------------------------------------------------

async function handleWorkflowJob(payload: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const { action, workflow_job, repository, installation } = payload as {
    action: string;
    workflow_job: Record<string, unknown>;
    repository: Record<string, unknown>;
    installation: Record<string, unknown>;
  };

  const repo = repository as { id?: unknown; full_name: string; owner: { login: string }; name: string; clone_url?: string };
  const job = workflow_job as { name?: string; head_sha: string; conclusion?: string };

  debug('server', `workflow_job webhook: action=${action} job="${job?.name}" repo=${repo.full_name} conclusion=${job?.conclusion}`);

  if (action !== 'completed') {
    return { status: 200, body: 'Event ignored' };
  }

  const config = await loadScanConfig({ owner: repo.owner.login, repo: repo.name });

  if (config.trigger.on !== 'workflow_job') {
    debug('server', `ignoring workflow_job: repo ${repo.full_name} uses "${config.trigger.on}" trigger`);
    return { status: 200, body: 'Event ignored' };
  }

  if (job.name !== config.trigger.job) {
    debug('server', `ignoring workflow_job: "${job.name}" doesn't match configured "${config.trigger.job}"`);
    return { status: 200, body: 'Event ignored' };
  }

  const conclusions = config.trigger.conclusions ?? ['success'];
  if (!conclusions.includes(job.conclusion!)) {
    debug('server', `ignoring workflow_job: conclusion "${job.conclusion}" not in [${conclusions.join(', ')}]`);
    return { status: 200, body: 'Event ignored' };
  }

  const headSha = job.head_sha;
  const prData  = await resolvePrData({
    installation,
    repository: repo,
    headSha,
    scanOnDraft: config.trigger.scanOnDraft,
  });

  if (!prData) {
    console.warn(`[server] workflow_job: could not find PR for ${repo.full_name}@${headSha} — scan skipped`);
    return { status: 200, body: 'PR not found' };
  }

  const jobId = getJobId(repo.full_name, prData.prNumber, headSha);

  return enqueueScan({
    pull_request: {
      number: prData.prNumber,
      head:   { sha: headSha },
      base:   { sha: prData.baseSha, ref: prData.baseRef },
    },
    pullRequestMetadata: prData.pullRequestMetadata,
    repository: repo,
    installation: { id: prData.installationId },
    jobId,
    action: 'workflow_job',
  });
}

async function resolvePrData({ installation, repository, headSha, scanOnDraft }: {
  installation: Record<string, unknown>;
  repository: { id?: unknown; full_name: string; owner: { login: string }; name: string; clone_url?: string };
  headSha: string;
  scanOnDraft: boolean;
}): Promise<PRCacheData | null> {
  const cacheKey = prCacheKey(repository.full_name, headSha);
  const cached   = await redis.get(cacheKey);

  let prData: PRCacheData | null = null;

  if (cached) {
    prData = JSON.parse(cached) as PRCacheData;
    prData.pullRequestMetadata = normalizePullRequestMetadata(prData.pullRequestMetadata);
    const currentRepositoryId = trustedRepositoryId(repository);
    if (prData.repositoryId !== undefined && currentRepositoryId !== prData.repositoryId) return null;
  } else {
    debug('server', `PR cache miss for ${repository.full_name}@${headSha} — querying GitHub API`);

    try {
      const pr = await findPullRequestBySha({
        installationId: (installation as { id: number }).id,
        owner:          repository.owner.login,
        repo:           repository.name,
        headSha,
      });

      if (!pr) return null;

      const apiPr = pr as {
        number: number;
        base: { sha: string; ref: string };
        title?: unknown;
        body?: unknown;
        user?: { login?: unknown } | null;
      };

      prData = {
        ...(trustedRepositoryId(repository) ? { repositoryId: trustedRepositoryId(repository) } : {}),
        prNumber:       apiPr.number,
        baseSha:        apiPr.base.sha,
        baseRef:        apiPr.base.ref,
        installationId: (installation as { id: number }).id,
        pullRequestMetadata: metadataFromPullRequest(apiPr),
      };
    } catch (err) {
      console.error(`[server] Failed to recover PR from GitHub API: ${(err as Error).message}`);
      return null;
    }
  }

  if (!prData) return null;

  // Confirm the PR is still open — the cache may be stale (written when the PR
  // was open) and the workflow may have fired after merge.
  try {
    const livePr = await getPullRequest({
      installationId: prData.installationId,
      owner:          repository.owner.login,
      repo:           repository.name,
      prNumber:       prData.prNumber,
    });
    const liveState = livePr as { state?: string; draft?: boolean };
    if (liveState.state !== 'open') {
      debug('server', `PR #${prData.prNumber} is no longer open, skipping scan`);
      return null;
    }
    if (liveState.draft === true && !scanOnDraft) {
      debug('server', `PR #${prData.prNumber} is a draft, skipping scan`);
      return null;
    }
  } catch (err) {
    console.error(`[server] Failed to verify PR state: ${(err as Error).message}`);
    return null;
  }

  return prData;
}

// ---------------------------------------------------------------------------
// Shared enqueue path
// ---------------------------------------------------------------------------

async function getActiveJob(jobId: string) {
  const job = await scanQueue.getJob(jobId);
  if (!job) return null;
  const state = await job.getState();
  if (state === 'waiting' || state === 'active' || state === 'delayed') return job;
  await job.remove();
  debug('server', `removed ${state} job ${jobId} to allow re-scan`);
  return null;
}

interface EnqueueScanParams {
  pull_request: {
    number: number;
    head: { sha: string };
    base: { sha: string; ref: string };
  };
  pullRequestMetadata: PullRequestMetadata;
  repository: { id?: unknown; full_name: string; clone_url?: string; owner: { login: string }; name: string };
  installation: Record<string, unknown>;
  jobId: string;
  action: string;
  triggeredByException?: boolean;
  exceptionApprovalRequest?: JobData['exceptionApprovalRequest'];
}

type EnqueueOutcome = 'enqueued' | 'duplicate' | 'busy' | 'rejected' | 'failed';

async function enqueueScan(params: EnqueueScanParams): Promise<{ status: number; body: string }> {
  return (await enqueueScanDetailed(params)).response;
}

async function enqueueScanDetailed(
  { pull_request, pullRequestMetadata, repository, installation, jobId, action, triggeredByException, exceptionApprovalRequest }: EnqueueScanParams,
  options: { bulkRequestId?: string; beforeEnqueue?: () => Promise<void> } = {},
): Promise<{ response: { status: number; body: string }; outcome: EnqueueOutcome }> {
  const activeJob = await getActiveJob(jobId);
  if (activeJob) {
    const activeRequest = activeJob.data?.exceptionApprovalRequest as JobData['exceptionApprovalRequest'] | undefined;
    const sameBulkRequest = options.bulkRequestId
      && activeRequest?.kind === 'all'
      && activeRequest.requestId === options.bulkRequestId;
    if (options.bulkRequestId && !sameBulkRequest) {
      debug('server', `bulk exception request rejected: job already active for ${jobId}`);
      return { response: { status: 200, body: 'Scan already in progress' }, outcome: 'busy' };
    }
    debug('server', `duplicate webhook ignored: job already active for ${jobId}`);
    webhooksTotal.inc({ action, deduplicated: 'true' });
    return { response: ACCEPTED_RESPONSE, outcome: 'duplicate' };
  }

  const webhookLock = await acquireWebhookLock(jobId);
  if (!webhookLock) {
    debug('server', `duplicate webhook ignored: another request is already accepting ${jobId}`);
    return options.bulkRequestId
      ? { response: { status: 200, body: 'Scan already in progress' }, outcome: 'busy' }
      : { response: ACCEPTED_RESPONSE, outcome: 'duplicate' };
  }

  let checkRunId: number | null = null;

  try {
    const activeJobAfterLock = await getActiveJob(jobId);
    if (activeJobAfterLock) {
      const activeRequest = activeJobAfterLock.data?.exceptionApprovalRequest as JobData['exceptionApprovalRequest'] | undefined;
      const sameBulkRequest = options.bulkRequestId
        && activeRequest?.kind === 'all'
        && activeRequest.requestId === options.bulkRequestId;
      if (options.bulkRequestId && !sameBulkRequest) {
        return { response: { status: 200, body: 'Scan already in progress' }, outcome: 'busy' };
      }
      debug('server', `duplicate webhook ignored after lock: job already active for ${jobId}`);
      webhooksTotal.inc({ action, deduplicated: 'true' });
      return { response: ACCEPTED_RESPONSE, outcome: 'duplicate' };
    }

    await options.beforeEnqueue?.();

    checkRunId = await createCheckRun({
      installationId: (installation as { id: number }).id,
      owner:          repository.owner.login,
      repo:           repository.name,
      headSha:        pull_request.head.sha,
    });

    await scanQueue.add('scan', {
      installationId: (installation as { id: number }).id,
      ...(trustedRepositoryId(repository) ? { repositoryId: trustedRepositoryId(repository) } : {}),
      owner:          repository.owner.login,
      repo:           repository.name,
      cloneUrl:       repository.clone_url ?? '',
      headSha:        pull_request.head.sha,
      baseSha:        pull_request.base.sha,
      baseRef:        pull_request.base.ref,
      prNumber:       pull_request.number,
      pullRequestMetadata: normalizePullRequestMetadata(pullRequestMetadata),
      checkRunId,
      ...(triggeredByException ? { triggeredByException: true } : {}),
      ...(exceptionApprovalRequest && { exceptionApprovalRequest }),
    }, {
      jobId,
    });

    if (options.bulkRequestId) {
      // BullMQ returns the caller's Job data when an existing job wins an ID race.
      // Reload Redis-backed data before confirming which bulk request was admitted.
      const persistedJob = await scanQueue.getJob(jobId);
      const queuedRequest = persistedJob?.data.exceptionApprovalRequest as JobData['exceptionApprovalRequest'] | undefined;
      if (
        queuedRequest?.kind !== 'all'
        || queuedRequest.requestId !== options.bulkRequestId
        || persistedJob?.data.checkRunId !== checkRunId
      ) {
        throw new Error('Bulk exception request lost queue admission race');
      }
    }

    console.log(`[server] Enqueued scan for ${repository.full_name} PR #${pull_request.number}`);
    webhooksTotal.inc({ action, deduplicated: 'false' });
    return { response: ACCEPTED_RESPONSE, outcome: 'enqueued' };
  } catch (err) {
    if (err instanceof BulkRequestRejectedError) {
      return { response: { status: 200, body: 'Bulk request bound to another head' }, outcome: 'rejected' };
    }
    console.error('[server] Failed to enqueue scan job:', err);

    if (checkRunId !== null) {
      await completeCheckRun({
        installationId: (installation as { id: number }).id,
        owner:          repository.owner.login,
        repo:           repository.name,
        checkRunId,
        conclusion:     'failure',
        annotations:    [],
        summary:        'Layne failed to accept this scan job. Retry the triggering event or exception command.',
      }).catch(() => {});
    }

    return { response: { status: 500, body: 'Failed to accept webhook' }, outcome: 'failed' };
  } finally {
    await releaseWebhookLock(webhookLock).catch(() => {});
  }
}

app.post('/webhook', async (req: Request, res: Response) => {
  const result = await processWebhookRequest({
    event:     req.headers['x-github-event'] as string | undefined,
    signature: req.headers['x-hub-signature-256'] as string | undefined,
    rawBody:   req.body as Buffer | string | undefined,
  });

  return res.status(result.status).send(result.body);
});

export { app, verifySignature };

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  validateEnv();
  await validateConfigFile();
  app.listen(PORT, () => {
    console.log(`[server] Layne listening on port ${PORT}`);
  });
}
