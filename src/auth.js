import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { debug } from './debug.js';

// Lazy-initialized so the module can be imported before env vars are
// validated. Without this, a missing GITHUB_APP_PRIVATE_KEY would throw
// a confusing TypeError instead of the clear error from validateEnv().
let appAuth;

function getAppAuth() {
  if (!appAuth) {
    appAuth = createAppAuth({
      appId:      process.env.GITHUB_APP_ID,
      // The private key is stored with literal \n in env vars — replace them
      // so the PEM is valid when read from a single-line environment variable.
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
  }
  return appAuth;
}

/**
 * Returns an Octokit instance authenticated as the given installation.
 * The underlying token is short-lived (1 hour) and scoped to that installation's repos.
 */
export async function getInstallationOctokit(installationId) {
  debug('auth', `generating installation token for installation ${installationId}`);
  const { token } = await getAppAuth()({ type: 'installation', installationId });
  return new Octokit({ auth: token });
}

/**
 * Returns just the raw installation token string.
 * Useful when passing credentials to a subprocess (e.g. git clone).
 */
export async function getInstallationToken(installationId) {
  debug('auth', `generating installation token for installation ${installationId}`);
  const { token } = await getAppAuth()({ type: 'installation', installationId });
  return token;
}
