import { getInstallationOctokit } from './auth.js';
import { debug } from './debug.js';
import type { Annotation } from './types.js';

const CHECK_NAME = 'Layne Security Scan';

const TEAM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface TeamCacheEntry {
  members: string[];
  expiresAt: number;
}

const teamMemberCache = new Map<string, TeamCacheEntry>();

function requestSignal<const T extends object>(params: T, signal?: AbortSignal): T & { request?: { signal: AbortSignal } } {
  return signal ? { ...params, request: { signal } } : params;
}

/** Clears the in-process team member cache. Exposed for testing. */
export function clearTeamMemberCache(): void {
  teamMemberCache.clear();
}

/**
 * Creates a Check Run in "queued" state immediately after receiving the webhook.
 * Returns the Check Run ID, which the worker uses to update it later.
 */
export async function createCheckRun({ installationId, owner, repo, headSha, signal }: {
  installationId: number;
  owner: string;
  repo: string;
  headSha: string;
  signal?: AbortSignal;
}): Promise<number> {
  debug('github', `creating check run for ${owner}/${repo} sha=${headSha}`);

  const octokit = await getInstallationOctokit(installationId, signal);

  const { data } = await octokit.checks.create(requestSignal({
    owner,
    repo,
    name:     CHECK_NAME,
    head_sha: headSha,
    status:   'queued',
  }, signal));

  debug('github', `check run created: id=${data.id}`);
  return data.id;
}

/**
 * Marks the Check Run as in_progress when the worker picks up the job.
 */
export async function startCheckRun({ installationId, owner, repo, checkRunId, signal }: {
  installationId: number;
  owner: string;
  repo: string;
  checkRunId: number;
  signal?: AbortSignal;
}): Promise<void> {
  debug('github', `marking check run ${checkRunId} in_progress for ${owner}/${repo}`);

  const octokit = await getInstallationOctokit(installationId, signal);

  await octokit.checks.update(requestSignal({
    owner,
    repo,
    check_run_id: checkRunId,
    status:       'in_progress',
    started_at:   new Date().toISOString(),
  }, signal));
}

/**
 * Completes the Check Run with a conclusion and inline annotations.
 */
export async function completeCheckRun({ installationId, owner, repo, checkRunId, conclusion, annotations, summary, signal }: {
  installationId: number;
  owner: string;
  repo: string;
  checkRunId: number;
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped' | 'stale';
  annotations: Annotation[];
  summary: string;
  signal?: AbortSignal;
}): Promise<void> {
  const octokit = await getInstallationOctokit(installationId, signal);

  // GitHub caps annotations at 50 per API call — chunk them if needed.
  // Ensure at least one chunk so the loop always completes the check run.
  const chunks = chunkArray(annotations, 50);
  if (chunks.length === 0) chunks.push([]);

  debug('github', `completing check run ${checkRunId} for ${owner}/${repo}: conclusion=${conclusion} annotations=${annotations.length} chunks=${chunks.length}`);

  for (let i = 0; i < chunks.length; i++) {
    signal?.throwIfAborted();
    const isLast = i === chunks.length - 1;
    const chunk = chunks[i]!;
    debug('github', `posting chunk ${i + 1}/${chunks.length} (${chunk.length} annotation(s))`);

    await octokit.checks.update(requestSignal({
      owner,
      repo,
      check_run_id: checkRunId,
      status:       isLast ? 'completed' : 'in_progress',
      conclusion:   isLast ? conclusion : undefined,
      completed_at: isLast ? new Date().toISOString() : undefined,
      output: {
        title:       isLast ? `Layne — ${conclusion}` : 'Layne — posting results...',
        summary,
        annotations: chunk,
      },
    }, signal));
  }
}

/**
 * Creates a Check Run in completed/skipped state immediately.
 * Used when a scan is deferred (workflow_run trigger) to make the deferral
 * visible in the PR status UI.
 */
export async function skipCheckRun({ installationId, owner, repo, headSha, summary, signal }: {
  installationId: number;
  owner: string;
  repo: string;
  headSha: string;
  summary: string;
  signal?: AbortSignal;
}): Promise<void> {
  debug('github', `creating skipped check run for ${owner}/${repo} sha=${headSha}`);

  const octokit = await getInstallationOctokit(installationId, signal);

  await octokit.checks.create(requestSignal({
    owner,
    repo,
    name:         CHECK_NAME,
    head_sha:     headSha,
    status:       'completed',
    conclusion:   'skipped',
    completed_at: new Date().toISOString(),
    output: {
      title:   'Layne — deferred',
      summary,
    },
  }, signal));
}

/**
 * Returns the merge base SHA between a base and head commit.
 */
export async function getMergeBaseSha({ installationId, owner, repo, base, head, signal }: {
  installationId: number;
  owner: string;
  repo: string;
  base: string;
  head: string;
  signal?: AbortSignal;
}): Promise<string> {
  debug('github', `resolving merge base for ${owner}/${repo}: ${base}...${head}`);
  const octokit = await getInstallationOctokit(installationId, signal);
  const { data } = await octokit.repos.compareCommits(requestSignal({ owner, repo, base, head }, signal));
  return data.merge_base_commit.sha;
}

/**
 * Returns the first open pull request associated with a commit SHA,
 * or null if none is found.
 */
export async function findPullRequestBySha({ installationId, owner, repo, headSha, signal }: {
  installationId: number;
  owner: string;
  repo: string;
  headSha: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown> | null> {
  debug('github', `looking up PR for ${owner}/${repo} sha=${headSha}`);

  const octokit = await getInstallationOctokit(installationId, signal);

  const { data } = await octokit.repos.listPullRequestsAssociatedWithCommit(requestSignal({
    owner,
    repo,
    commit_sha: headSha,
  }, signal));

  return data.find(pr => pr.state === 'open') ?? null;
}

/**
 * Ensures all label names exist on the repository, creating any that are missing.
 * Missing labels are created with a neutral gray color.
 * Errors are logged and swallowed — never throws.
 */
export async function ensureLabelsExist({ installationId, owner, repo, labelNames, signal }: {
  installationId: number;
  owner: string;
  repo: string;
  labelNames: string[];
  signal?: AbortSignal;
}): Promise<void> {
  signal?.throwIfAborted();
  if (!labelNames.length) return;
  const octokit = await getInstallationOctokit(installationId, signal);

  for (const name of labelNames) {
    signal?.throwIfAborted();
    try {
      await octokit.issues.getLabel(requestSignal({ owner, repo, name }, signal));
    } catch (err) {
      signal?.throwIfAborted();
      const octokitErr = err as { status?: number; message?: string };
      if (octokitErr.status === 404) {
        try {
          await octokit.issues.createLabel(requestSignal({ owner, repo, name, color: 'ededed' }, signal));
          debug('github', `created label "${name}" on ${owner}/${repo}`);
        } catch (createErr) {
          signal?.throwIfAborted();
          console.error(`[github] Failed to create label "${name}": ${(createErr as Error).message}`);
        }
      } else {
        console.error(`[github] Failed to check label "${name}": ${octokitErr.message}`);
      }
    }
  }
}

/**
 * Adds and removes labels on a PR.
 * Errors are logged and swallowed — never throws.
 */
export async function setLabels({ installationId, owner, repo, prNumber, add, remove, signal }: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  add: string[];
  remove: string[];
  signal?: AbortSignal;
}): Promise<void> {
  signal?.throwIfAborted();
  const octokit = await getInstallationOctokit(installationId, signal);

  if (add.length) {
    try {
      await octokit.issues.addLabels(requestSignal({ owner, repo, issue_number: prNumber, labels: add }, signal));
      debug('github', `added labels [${add.join(', ')}] to ${owner}/${repo}#${prNumber}`);
    } catch (err) {
      signal?.throwIfAborted();
      console.error(`[github] Failed to add labels: ${(err as Error).message}`);
    }
  }

  for (const name of remove) {
    signal?.throwIfAborted();
    try {
      await octokit.issues.removeLabel(requestSignal({ owner, repo, issue_number: prNumber, name }, signal));
      debug('github', `removed label "${name}" from ${owner}/${repo}#${prNumber}`);
    } catch (err) {
      signal?.throwIfAborted();
      const octokitErr = err as { status?: number; message?: string };
      if (octokitErr.status !== 404) {
        console.error(`[github] Failed to remove label "${name}": ${octokitErr.message}`);
      }
    }
  }
}

/**
 * Returns a pull request by number.
 */
export async function getPullRequest({ installationId, owner, repo, prNumber, signal }: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  debug('github', `fetching PR ${owner}/${repo} #${prNumber}`);

  const octokit = await getInstallationOctokit(installationId, signal);

  const { data } = await octokit.pulls.get(requestSignal({
    owner,
    repo,
    pull_number: prNumber,
  }, signal));

  return data as unknown as Record<string, unknown>;
}

/**
 * Posts a comment on a pull request (issues API, since PRs are issues).
 */
export async function createPrComment({ installationId, owner, repo, prNumber, body, signal }: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  signal?: AbortSignal;
}): Promise<void> {
  debug('github', `posting comment on ${owner}/${repo} PR #${prNumber}`);

  const octokit = await getInstallationOctokit(installationId, signal);

  await octokit.issues.createComment(requestSignal({
    owner,
    repo,
    issue_number: prNumber,
    body,
  }, signal));
}

/**
 * Resolves team slugs to a list of member usernames.
 */
export async function getTeamMembers({ installationId, org, teamSlugs, signal }: {
  installationId: number;
  org: string;
  teamSlugs: string[];
  signal?: AbortSignal;
}): Promise<string[]> {
  signal?.throwIfAborted();
  if (!teamSlugs?.length) return [];

  const octokit = await getInstallationOctokit(installationId, signal);
  const members = new Set<string>();

  for (const slug of teamSlugs) {
    signal?.throwIfAborted();
    let teamOrg: string;
    let teamSlug: string;

    if (slug.includes('/')) {
      const parts = slug.split('/');
      const parsedOrg = parts[0];
      const parsedSlug = parts[1];
      if (!parsedOrg || !parsedSlug) {
        console.error(`[github] Invalid team slug format: "${slug}" - skipping`);
        continue;
      }
      teamOrg = parsedOrg;
      teamSlug = parsedSlug;
    } else {
      teamOrg = org;
      teamSlug = slug;
    }

    const cacheKey = `${installationId}:${teamOrg}/${teamSlug}`;
    const cached = teamMemberCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      debug('github', `team cache hit for ${teamOrg}/${teamSlug}: ${cached.members.length} member(s)`);
      cached.members.forEach(m => members.add(m));
      continue;
    }

    try {
      const { data } = await octokit.teams.listMembersInOrg(requestSignal({
        org: teamOrg,
        team_slug: teamSlug,
      }, signal));
      const slugMembers = data.map(m => m.login);
      slugMembers.forEach(m => members.add(m));
      teamMemberCache.set(cacheKey, { members: slugMembers, expiresAt: Date.now() + TEAM_CACHE_TTL_MS });
      debug('github', `resolved team ${teamOrg}/${teamSlug}: ${data.length} member(s)`);
    } catch (err) {
      signal?.throwIfAborted();
      console.error(`[github] Failed to list members for team ${teamOrg}/${teamSlug}: ${(err as Error).message}`);
    }
  }

  return Array.from(members);
}

/**
 * Returns the latest Layne check run for a given commit SHA.
 */
export async function getLatestCheckRun({ installationId, owner, repo, headSha, signal }: {
  installationId: number;
  owner: string;
  repo: string;
  headSha: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown> | null> {
  debug('github', `fetching check runs for ${owner}/${repo} sha=${headSha}`);

  const octokit = await getInstallationOctokit(installationId, signal);

  const { data } = await octokit.checks.listForRef(requestSignal({
    owner,
    repo,
    ref: headSha,
    check_name: CHECK_NAME,
  }, signal));

  // GitHub returns check runs in reverse-creation order by default, so [0] is the most recent.
  return (data.check_runs?.[0] as Record<string, unknown> | undefined) ?? null;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
