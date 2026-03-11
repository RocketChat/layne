import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPOS_CONFIG_PATH = join(__dirname, '..', 'config', 'repos.json');

export const DEFAULT_CONFIG = Object.freeze({
  semgrep: Object.freeze({
    enabled:   true,
    extraArgs: ['--config', 'auto'],
  }),
  trufflehog: Object.freeze({
    enabled:   true,
    extraArgs: [],
  }),
  claude: Object.freeze({
    enabled: false,
    model:   'claude-haiku-4-5-20251001',
    prompt:  null,
  }),
  labels: Object.freeze({}),
});

// Cached after first read — repos.json is loaded once per worker process.
// Restart Layne to pick up config changes (same lifecycle as code deploys).
let reposConfigCache = null;

async function loadReposConfig() {
  if (reposConfigCache) return reposConfigCache;
  try {
    const raw = JSON.parse(await readFile(REPOS_CONFIG_PATH, 'utf8'));
    reposConfigCache = (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) ? raw : {};
  } catch {
    reposConfigCache = {};
  }
  return reposConfigCache;
}

export async function loadScanConfig({ owner, repo }) {
  const reposConfig = await loadReposConfig();
  const repoOverrides = reposConfig[`${owner}/${repo}`] ?? {};

  // Notifications merge: per-repo notifier keys win over global ones.
  // A repo with no notifications block inherits the global config entirely.
  // A repo can opt out of a specific notifier by setting its enabled: false.
  const globalNotifications = reposConfig['$global']?.notifications ?? {};
  const repoNotifications   = repoOverrides.notifications ?? {};

  // Labels merge: per-repo labels override global at the whole-key level.
  const globalLabels = reposConfig['$global']?.labels ?? {};
  const repoLabels   = repoOverrides.labels ?? {};

  return {
    semgrep:       { ...DEFAULT_CONFIG.semgrep,    ...(repoOverrides.semgrep    ?? {}) },
    trufflehog:    { ...DEFAULT_CONFIG.trufflehog, ...(repoOverrides.trufflehog ?? {}) },
    claude:        { ...DEFAULT_CONFIG.claude,     ...(repoOverrides.claude     ?? {}) },
    notifications: { ...globalNotifications, ...repoNotifications },
    labels:        { ...globalLabels, ...repoLabels },
  };
}
