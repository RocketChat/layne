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

  return {
    semgrep:    { ...DEFAULT_CONFIG.semgrep,    ...(repoOverrides.semgrep    ?? {}) },
    trufflehog: { ...DEFAULT_CONFIG.trufflehog, ...(repoOverrides.trufflehog ?? {}) },
  };
}
