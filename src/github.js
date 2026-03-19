import { getInstallationOctokit } from './auth.js';
import { debug } from './debug.js';

const CHECK_NAME = 'Layne Security Scan';

/**
 * Creates a Check Run in "queued" state immediately after receiving the webhook.
 * Returns the Check Run ID, which the worker uses to update it later.
 */
export async function createCheckRun({ installationId, owner, repo, headSha }) {
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
export async function startCheckRun({ installationId, owner, repo, checkRunId }) {
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
 *
 * @param {object} params
 * @param {string} params.conclusion - 'success' | 'failure' | 'neutral'
 * @param {Array}  params.annotations - GitHub Check Run annotation objects
 * @param {string} params.summary - Short markdown summary shown at the top of the Check
 */
export async function completeCheckRun({
  installationId,
  owner,
  repo,
  checkRunId,
  conclusion,
  annotations,
  summary,
}) {
  const octokit = await getInstallationOctokit(installationId);

  // GitHub caps annotations at 50 per API call — chunk them if needed.
  // Ensure at least one chunk so the loop always completes the check run.
  const chunks = chunkArray(annotations, 50);
  if (chunks.length === 0) chunks.push([]);

  debug('github', `completing check run ${checkRunId} for ${owner}/${repo}: conclusion=${conclusion} annotations=${annotations.length} chunks=${chunks.length}`);

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    debug('github', `posting chunk ${i + 1}/${chunks.length} (${chunks[i].length} annotation(s))`);

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
        annotations: chunks[i],
      },
    });
  }
}

/**
 * Creates a Check Run in completed/skipped state immediately.
 * Used when a scan is deferred (workflow_run trigger) to make the deferral
 * visible in the PR status UI.
 */
export async function skipCheckRun({ installationId, owner, repo, headSha, summary }) {
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
 * This matches GitHub's PR diff (three-dot / merge-base diff), ensuring Layne
 * only scans files the PR itself changed rather than files that differ because
 * the base branch advanced after the PR was opened.
 */
export async function getMergeBaseSha({ installationId, owner, repo, base, head }) {
  debug('github', `resolving merge base for ${owner}/${repo}: ${base}...${head}`);
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.repos.compareCommits({ owner, repo, base, head });
  return data.merge_base_commit.sha;
}

/**
 * Returns the first open pull request associated with a commit SHA,
 * or null if none is found. Used as a fallback when the PR metadata
 * cache is cold (e.g. Layne was offline when the PR was opened).
 */
export async function findPullRequestBySha({ installationId, owner, repo, headSha }) {
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
export async function ensureLabelsExist({ installationId, owner, repo, labelNames }) {
  if (!labelNames.length) return;
  const octokit = await getInstallationOctokit(installationId);

  for (const name of labelNames) {
    try {
      await octokit.issues.getLabel({ owner, repo, name });
    } catch (err) {
      if (err.status === 404) {
        try {
          await octokit.issues.createLabel({ owner, repo, name, color: 'ededed' });
          debug('github', `created label "${name}" on ${owner}/${repo}`);
        } catch (createErr) {
          console.error(`[github] Failed to create label "${name}": ${createErr.message}`);
        }
      } else {
        console.error(`[github] Failed to check label "${name}": ${err.message}`);
      }
    }
  }
}

/**
 * Adds and removes labels on a PR.
 * Errors are logged and swallowed — never throws.
 *
 * @param {object} params
 * @param {string[]} params.add    - Label names to add
 * @param {string[]} params.remove - Label names to remove
 */
export async function setLabels({ installationId, owner, repo, prNumber, add, remove }) {
  const octokit = await getInstallationOctokit(installationId);

  if (add.length) {
    try {
      await octokit.issues.addLabels({ owner, repo, issue_number: prNumber, labels: add });
      debug('github', `added labels [${add.join(', ')}] to ${owner}/${repo}#${prNumber}`);
    } catch (err) {
      console.error(`[github] Failed to add labels: ${err.message}`);
    }
  }

  for (const name of remove) {
    try {
      await octokit.issues.removeLabel({ owner, repo, issue_number: prNumber, name });
      debug('github', `removed label "${name}" from ${owner}/${repo}#${prNumber}`);
    } catch (err) {
      if (err.status !== 404) {
        console.error(`[github] Failed to remove label "${name}": ${err.message}`);
      }
    }
  }
}

/**
 * Returns a pull request by number.
 * The caller uses .head.sha to get the current head commit.
 */
export async function getPullRequest({ installationId, owner, repo, prNumber }) {
  debug('github', `fetching PR ${owner}/${repo} #${prNumber}`);

  const octokit = await getInstallationOctokit(installationId);

  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  return data;
}

/**
 * Posts a comment on a pull request (issues API, since PRs are issues).
 */
export async function createPrComment({ installationId, owner, repo, prNumber, body }) {
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
 * Team slugs can be "org/team-slug" or just "team-slug" (uses owner as org).
 */
export async function getTeamMembers({ installationId, org, teamSlugs }) {
  if (!teamSlugs?.length) return [];

  const octokit = await getInstallationOctokit(installationId);
  const members = new Set();

  for (const slug of teamSlugs) {
    let teamOrg, teamSlug;
    
    if (slug.includes('/')) {
      [teamOrg, teamSlug] = slug.split('/');
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
      console.error(`[github] Failed to list members for team ${teamOrg}/${teamSlug}: ${err.message}`);
    }
  }

  return Array.from(members);
}

/**
 * Returns the latest Layne check run for a given commit SHA.
 * Used to check if previous scan failed before re-running on approval.
 */
export async function getLatestCheckRun({ installationId, owner, repo, headSha }) {
  debug('github', `fetching check runs for ${owner}/${repo} sha=${headSha}`);

  const octokit = await getInstallationOctokit(installationId);

  const { data } = await octokit.checks.listForRef({
    owner,
    repo,
    ref: headSha,
    check_name: CHECK_NAME,
  });

  // GitHub returns check runs in reverse-creation order by default, so [0] is the most recent.
  return data.check_runs?.[0] ?? null;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
