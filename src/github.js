import { getInstallationOctokit } from './auth.js';

const CHECK_NAME = 'Layne Security Scan';

/**
 * Creates a Check Run in "queued" state immediately after receiving the webhook.
 * Returns the Check Run ID, which the worker uses to update it later.
 */
export async function createCheckRun({ installationId, owner, repo, headSha }) {
  const octokit = await getInstallationOctokit(installationId);

  const { data } = await octokit.checks.create({
    owner,
    repo,
    name:     CHECK_NAME,
    head_sha: headSha,
    status:   'queued',
  });

  return data.id;
}

/**
 * Marks the Check Run as in_progress when the worker picks up the job.
 */
export async function startCheckRun({ installationId, owner, repo, checkRunId }) {
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

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;

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

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
