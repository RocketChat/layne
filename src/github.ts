import { getInstallationOctokit } from './auth.js';
import { debug } from './debug.js';
import type { Annotation } from './types.js';

const CHECK_NAME = 'Layne Security Scan';

/**
 * Creates a Check Run in "queued" state immediately after receiving the webhook.
 * Returns the Check Run ID, which the worker uses to update it later.
 */
export async function createCheckRun({ installationId, owner, repo, headSha }: {
  installationId: number;
  owner: string;
  repo: string;
  headSha: string;
}): Promise<number> {
  debug('github', `creating check run for ${owner}/${repo} sha=${headSha}`);

  const octokit = await getInstallationOctokit(installationId);

  const { data } = await octokit.checks.create({
    owner,
    repo,
    name:     CHECK_NAME,
    head_sha: headSha,
    status:   'queued',
  });

  debug('github', `check run created: id=${data.id}`);
  return data.id;
}

/**
 * Marks the Check Run as in_progress when the worker picks up the job.
 */
export async function startCheckRun({ installationId, owner, repo, checkRunId }: {
  installationId: number;
  owner: string;
  repo: string;
  checkRunId: number;
}): Promise<void> {
  debug('github', `marking check run ${checkRunId} in_progress for ${owner}/${repo}`);

  const octokit = await getInstallationOctokit(installationId);

  await octokit.checks.update({
    owner,
    repo,
    check_run_id: checkRunId,
    status:       'in_progress',
    started_at:   new Date().toISOString(),
  });
}

/**
 * Completes the Check Run with a conclusion and inline annotations.
 */
export async function completeCheckRun({ installationId, owner, repo, checkRunId, conclusion, annotations, summary }: {
  installationId: number;
  owner: string;
  repo: string;
  checkRunId: number;
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped' | 'stale';
  annotations: Annotation[];
  summary: string;
}): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);

  // GitHub caps annotations at 50 per API call — chunk them if needed.
  // Ensure at least one chunk so the loop always completes the check run.
  const chunks = chunkArray(annotations, 50);
  if (chunks.length === 0) chunks.push([]);

  debug('github', `completing check run ${checkRunId} for ${owner}/${repo}: conclusion=${conclusion} annotations=${annotations.length} chunks=${chunks.length}`);

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const chunk = chunks[i]!;
    debug('github', `posting chunk ${i + 1}/${chunks.length} (${chunk.length} annotation(s))`);

    await octokit.checks.update({
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
    });
  }
}

/**
 * Creates a Check Run in completed/skipped state immediately.
 * Used when a scan is deferred (workflow_run trigger) to make the deferral
 * visible in the PR status UI.
 */
export async function skipCheckRun({ installationId, owner, repo, headSha, summary }: {
  installationId: number;
  owner: string;
  repo: string;
  headSha: string;
  summary: string;
}): Promise<void> {
  debug('github', `creating skipped check run for ${owner}/${repo} sha=${headSha}`);

  const octokit = await getInstallationOctokit(installationId);

  await octokit.checks.create({
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
  });
}

/**
 * Returns the merge base SHA between a base and head commit.
 */
export async function getMergeBaseSha({ installationId, owner, repo, base, head }: {
  installationId: number;
  owner: string;
  repo: string;
  base: string;
  head: string;
}): Promise<string> {
  debug('github', `resolving merge base for ${owner}/${repo}: ${base}...${head}`);
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.repos.compareCommits({ owner, repo, base, head });
  return data.merge_base_commit.sha;
}

/**
 * Returns the first open pull request associated with a commit SHA,
 * or null if none is found.
 */
export async function findPullRequestBySha({ installationId, owner, repo, headSha }: {
  installationId: number;
  owner: string;
  repo: string;
  headSha: string;
}): Promise<Record<string, unknown> | null> {
  debug('github', `looking up PR for ${owner}/${repo} sha=${headSha}`);

  const octokit = await getInstallationOctokit(installationId);

  const { data } = await octokit.repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: headSha,
  });

  return data[0] ?? null;
}

/**
 * Ensures all label names exist on the repository, creating any that are missing.
 * Missing labels are created with a neutral gray color.
 * Errors are logged and swallowed — never throws.
 */
export async function ensureLabelsExist({ installationId, owner, repo, labelNames }: {
  installationId: number;
  owner: string;
  repo: string;
  labelNames: string[];
}): Promise<void> {
  if (!labelNames.length) return;
  const octokit = await getInstallationOctokit(installationId);

  for (const name of labelNames) {
    try {
      await octokit.issues.getLabel({ owner, repo, name });
    } catch (err) {
      const octokitErr = err as { status?: number; message?: string };
      if (octokitErr.status === 404) {
        try {
          await octokit.issues.createLabel({ owner, repo, name, color: 'ededed' });
          debug('github', `created label "${name}" on ${owner}/${repo}`);
        } catch (createErr) {
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
export async function setLabels({ installationId, owner, repo, prNumber, add, remove }: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  add: string[];
  remove: string[];
}): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);

  if (add.length) {
    try {
      await octokit.issues.addLabels({ owner, repo, issue_number: prNumber, labels: add });
      debug('github', `added labels [${add.join(', ')}] to ${owner}/${repo}#${prNumber}`);
    } catch (err) {
      console.error(`[github] Failed to add labels: ${(err as Error).message}`);
    }
  }

  for (const name of remove) {
    try {
      await octokit.issues.removeLabel({ owner, repo, issue_number: prNumber, name });
      debug('github', `removed label "${name}" from ${owner}/${repo}#${prNumber}`);
    } catch (err) {
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
export async function getPullRequest({ installationId, owner, repo, prNumber }: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<Record<string, unknown>> {
  debug('github', `fetching PR ${owner}/${repo} #${prNumber}`);

  const octokit = await getInstallationOctokit(installationId);

  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  return data as unknown as Record<string, unknown>;
}

/**
 * Posts a comment on a pull request (issues API, since PRs are issues).
 */
export async function createPrComment({ installationId, owner, repo, prNumber, body }: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
}): Promise<void> {
  debug('github', `posting comment on ${owner}/${repo} PR #${prNumber}`);

  const octokit = await getInstallationOctokit(installationId);

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

/**
 * Resolves team slugs to a list of member usernames.
 */
export async function getTeamMembers({ installationId, org, teamSlugs }: {
  installationId: number;
  org: string;
  teamSlugs: string[];
}): Promise<string[]> {
  if (!teamSlugs?.length) return [];

  const octokit = await getInstallationOctokit(installationId);
  const members = new Set<string>();

  for (const slug of teamSlugs) {
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

    try {
      const { data } = await octokit.teams.listMembersInOrg({
        org: teamOrg,
        team_slug: teamSlug,
      });
      data.forEach(m => members.add(m.login));
      debug('github', `resolved team ${teamOrg}/${teamSlug}: ${data.length} member(s)`);
    } catch (err) {
      console.error(`[github] Failed to list members for team ${teamOrg}/${teamSlug}: ${(err as Error).message}`);
    }
  }

  return Array.from(members);
}

/**
 * Returns the latest Layne check run for a given commit SHA.
 */
export async function getLatestCheckRun({ installationId, owner, repo, headSha }: {
  installationId: number;
  owner: string;
  repo: string;
  headSha: string;
}): Promise<Record<string, unknown> | null> {
  debug('github', `fetching check runs for ${owner}/${repo} sha=${headSha}`);

  const octokit = await getInstallationOctokit(installationId);

  const { data } = await octokit.checks.listForRef({
    owner,
    repo,
    ref: headSha,
    check_name: CHECK_NAME,
  });

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
