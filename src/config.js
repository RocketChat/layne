import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateConfig } from './config-validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPOS_CONFIG_PATH = join(__dirname, '..', 'config', 'layne.json');

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
    prompt:  null,   // custom system prompt (string); mutually exclusive with skill
    skill:   null,   // API Skill config: { id: "skill_01...", version: "latest" }
  }),
  labels:  Object.freeze({}),
  trigger: Object.freeze({ on: 'pull_request' }),
  comment: Object.freeze({ enabled: false, template: null }),
  exceptionApprovers: Object.freeze({ users: [], teams: [] }),
});

// Cached after first read — layne.json is loaded once per process.
// Restart both server and worker to pick up config changes (same lifecycle as code deploys).
let reposConfigCache = null;

async function loadReposConfig() {
  if (reposConfigCache) return reposConfigCache;
  try {
    const raw = JSON.parse(await readFile(REPOS_CONFIG_PATH, 'utf8'));
    const result = validateConfig(raw);
    if (!result.valid) {
      console.error('[config] layne.json has validation errors — some settings may be ignored:');
      for (const err of result.errors) console.error(`[config]   • ${err}`);
    }
    reposConfigCache = (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) ? raw : {};
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`[config] layne.json is not valid JSON: ${err.message}`);
    } else {
      console.error(`[config] failed to load layne.json: ${err.message}`);
    }
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

  const globalTrigger  = reposConfig['$global']?.trigger ?? {};
  const globalComment  = reposConfig['$global']?.comment ?? {};
  const repoComment    = repoOverrides.comment ?? {};

  // Exception approvers: per-repo replaces global entirely (not merged key-by-key).
  // This is consistent with how labels work.
  const globalExceptionApprovers = reposConfig['$global']?.exceptionApprovers ?? DEFAULT_CONFIG.exceptionApprovers;
  const repoExceptionApprovers   = repoOverrides.exceptionApprovers ?? null;

  return {
    semgrep:       { ...DEFAULT_CONFIG.semgrep,    ...(repoOverrides.semgrep    ?? {}) },
    trufflehog:    { ...DEFAULT_CONFIG.trufflehog, ...(repoOverrides.trufflehog ?? {}) },
    claude:        { ...DEFAULT_CONFIG.claude,     ...(repoOverrides.claude     ?? {}) },
    notifications: { ...globalNotifications, ...repoNotifications },
    labels:        { ...globalLabels, ...repoLabels },
    trigger:       { ...DEFAULT_CONFIG.trigger, ...globalTrigger, ...(repoOverrides.trigger ?? {}) },
    comment:       { ...DEFAULT_CONFIG.comment, ...globalComment, ...repoComment },
    exceptionApprovers: repoExceptionApprovers ?? globalExceptionApprovers,
  };
}
