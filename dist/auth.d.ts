import { Octokit } from '@octokit/rest';
/**
 * Returns an Octokit instance authenticated as the given installation.
 * The underlying token is short-lived (1 hour) and scoped to that installation's repos.
 */
export declare function getInstallationOctokit(installationId: number): Promise<Octokit>;
/**
 * Returns just the raw installation token string.
 * Useful when passing credentials to a subprocess (e.g. git clone).
 */
export declare function getInstallationToken(installationId: number): Promise<string>;
//# sourceMappingURL=auth.d.ts.map