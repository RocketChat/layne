import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateConfig } from './config-validator.js';
import type { ScanConfig, SemgrepConfig, TrufflehogConfig, ClaudeConfig, PiAgentConfig, LabelConfig, TriggerConfig, CommentConfig, ExceptionApproversConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPOS_CONFIG_PATH = join(__dirname, '..', 'config', 'layne.json');

export const DEFAULT_CONFIG: Readonly<ScanConfig> = Object.freeze({
  mode:           'changed_files' as const,
  contextLines:   8,
  timeoutMinutes: 10,
  semgrep: Object.freeze({
    enabled:   true,
    extraArgs: ['--config', 'auto'],
  } as SemgrepConfig),
  trufflehog: Object.freeze({
    enabled:   true,
    extraArgs: [],
  } as TrufflehogConfig),
  claude: Object.freeze({
    enabled: false,
    model:   'claude-haiku-4-5-20251001',
    prompt:  null,   // custom system prompt (string); mutually exclusive with skill
    skill:   null,   // API Skill config: { id: "skill_01...", version: "latest" }
  } as ClaudeConfig),
  piAgent: Object.freeze({
    enabled:        false,
    model:          'claude-opus-4-6',
    thinkingLevel:  'medium',
    timeoutMinutes: 10,
    followImports:  true,
    prompt:         null,
  } as PiAgentConfig),  // note: no default provider — omitting provider disables Pi Agent even when enabled: true
  labels:  Object.freeze({} as LabelConfig),
  trigger: Object.freeze({ on: 'pull_request' } as TriggerConfig),
  comment: Object.freeze({ enabled: false, template: null } as CommentConfig),
  exceptionApprovers: Object.freeze({ users: [], teams: [] } as ExceptionApproversConfig),
  notifications: Object.freeze({} as Record<string, never>),
});

// Cached after first read — layne.json is loaded once per process.
// Restart both server and worker to pick up config changes (same lifecycle as code deploys).
let reposConfigCache: Record<string, unknown> | null = null;

async function loadReposConfig(): Promise<Record<string, unknown>> {
  if (reposConfigCache) return reposConfigCache;
  try {
    // JSON.parse result used as typed config object
    const raw: unknown = JSON.parse(await readFile(REPOS_CONFIG_PATH, 'utf8'));
    const result = validateConfig(raw);
    if (!result.valid) {
      console.error('[config] layne.json has validation errors — some settings may be ignored:');
      for (const err of result.errors) console.error(`[config]   • ${err}`);
    }
    reposConfigCache = (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`[config] layne.json is not valid JSON: ${err.message}`);
    } else {
      console.error(`[config] failed to load layne.json: ${(err as Error).message}`);
    }
    reposConfigCache = {};
  }
  return reposConfigCache;
}

export async function loadScanConfig({ owner, repo }: { owner: string; repo: string }): Promise<ScanConfig> {
  const reposConfig = await loadReposConfig();
  const repoOverrides = (reposConfig[`${owner}/${repo}`] ?? {}) as Partial<ScanConfig>;

  const globalConfig = (reposConfig['$global'] ?? {}) as Partial<ScanConfig>;

  // Notifications merge: per-repo notifier keys win over global ones.
  // A repo with no notifications block inherits the global config entirely.
  // A repo can opt out of a specific notifier by setting its enabled: false.
  const globalNotifications = globalConfig.notifications ?? {};
  const repoNotifications   = repoOverrides.notifications ?? {};

  // Labels merge: per-repo labels override global at the whole-key level.
  const globalLabels = globalConfig.labels ?? {};
  const repoLabels   = repoOverrides.labels ?? {};

  const globalTrigger  = globalConfig.trigger ?? {};
  const globalComment  = globalConfig.comment ?? {};
  const repoComment    = repoOverrides.comment ?? {};

  // Exception approvers: per-repo replaces global entirely (not merged key-by-key).
  // This is consistent with how labels work.
  const globalExceptionApprovers = globalConfig.exceptionApprovers ?? DEFAULT_CONFIG.exceptionApprovers;
  const repoExceptionApprovers   = repoOverrides.exceptionApprovers ?? null;

  return {
    mode:           repoOverrides.mode           ?? globalConfig.mode           ?? DEFAULT_CONFIG.mode,
    contextLines:   repoOverrides.contextLines   ?? globalConfig.contextLines   ?? DEFAULT_CONFIG.contextLines,
    timeoutMinutes: repoOverrides.timeoutMinutes ?? globalConfig.timeoutMinutes ?? DEFAULT_CONFIG.timeoutMinutes,
    semgrep:       { ...DEFAULT_CONFIG.semgrep,    ...(repoOverrides.semgrep    ?? {}) },
    trufflehog:    { ...DEFAULT_CONFIG.trufflehog, ...(repoOverrides.trufflehog ?? {}) },
    claude:        { ...DEFAULT_CONFIG.claude,     ...(repoOverrides.claude     ?? {}) },
    piAgent:       { ...DEFAULT_CONFIG.piAgent,    ...(repoOverrides.piAgent    ?? {}) },
    notifications: { ...globalNotifications, ...repoNotifications },
    labels:        { ...globalLabels, ...repoLabels },
    trigger:       { ...DEFAULT_CONFIG.trigger, ...globalTrigger, ...(repoOverrides.trigger ?? {}) },
    comment:       { ...DEFAULT_CONFIG.comment, ...globalComment, ...repoComment },
    exceptionApprovers: repoExceptionApprovers ?? globalExceptionApprovers,
  };
}
