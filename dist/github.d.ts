import type { Annotation } from './types.js';
/**
 * Creates a Check Run in "queued" state immediately after receiving the webhook.
 * Returns the Check Run ID, which the worker uses to update it later.
 */
export declare function createCheckRun({ installationId, owner, repo, headSha }: {
    installationId: number;
    owner: string;
    repo: string;
    headSha: string;
}): Promise<number>;
/**
 * Marks the Check Run as in_progress when the worker picks up the job.
 */
export declare function startCheckRun({ installationId, owner, repo, checkRunId }: {
    installationId: number;
    owner: string;
    repo: string;
    checkRunId: number;
}): Promise<void>;
/**
 * Completes the Check Run with a conclusion and inline annotations.
 */
export declare function completeCheckRun({ installationId, owner, repo, checkRunId, conclusion, annotations, summary }: {
    installationId: number;
    owner: string;
    repo: string;
    checkRunId: number;
    conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped' | 'stale';
    annotations: Annotation[];
    summary: string;
}): Promise<void>;
/**
 * Creates a Check Run in completed/skipped state immediately.
 * Used when a scan is deferred (workflow_run trigger) to make the deferral
 * visible in the PR status UI.
 */
export declare function skipCheckRun({ installationId, owner, repo, headSha, summary }: {
    installationId: number;
    owner: string;
    repo: string;
    headSha: string;
    summary: string;
}): Promise<void>;
/**
 * Returns the merge base SHA between a base and head commit.
 */
export declare function getMergeBaseSha({ installationId, owner, repo, base, head }: {
    installationId: number;
    owner: string;
    repo: string;
    base: string;
    head: string;
}): Promise<string>;
/**
 * Returns the first open pull request associated with a commit SHA,
 * or null if none is found.
 */
export declare function findPullRequestBySha({ installationId, owner, repo, headSha }: {
    installationId: number;
    owner: string;
    repo: string;
    headSha: string;
}): Promise<Record<string, unknown> | null>;
/**
 * Ensures all label names exist on the repository, creating any that are missing.
 * Missing labels are created with a neutral gray color.
 * Errors are logged and swallowed — never throws.
 */
export declare function ensureLabelsExist({ installationId, owner, repo, labelNames }: {
    installationId: number;
    owner: string;
    repo: string;
    labelNames: string[];
}): Promise<void>;
/**
 * Adds and removes labels on a PR.
 * Errors are logged and swallowed — never throws.
 */
export declare function setLabels({ installationId, owner, repo, prNumber, add, remove }: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    add: string[];
    remove: string[];
}): Promise<void>;
/**
 * Returns a pull request by number.
 */
export declare function getPullRequest({ installationId, owner, repo, prNumber }: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
}): Promise<Record<string, unknown>>;
/**
 * Posts a comment on a pull request (issues API, since PRs are issues).
 */
export declare function createPrComment({ installationId, owner, repo, prNumber, body }: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
}): Promise<void>;
/**
 * Resolves team slugs to a list of member usernames.
 */
export declare function getTeamMembers({ installationId, org, teamSlugs }: {
    installationId: number;
    org: string;
    teamSlugs: string[];
}): Promise<string[]>;
/**
 * Returns the latest Layne check run for a given commit SHA.
 */
export declare function getLatestCheckRun({ installationId, owner, repo, headSha }: {
    installationId: number;
    owner: string;
    repo: string;
    headSha: string;
}): Promise<Record<string, unknown> | null>;
//# sourceMappingURL=github.d.ts.map