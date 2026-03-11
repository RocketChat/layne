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

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
