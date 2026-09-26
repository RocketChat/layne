import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateConfig } from './config-validator.js';
import type { ScanConfig, SemgrepConfig, TrufflehogConfig, ClaudeConfig, SpectreConfig, DepDoctorConfig, LabelConfig, TriggerConfig, CommentConfig, ExceptionApproversConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPOS_CONFIG_PATH = join(__dirname, '..', 'config', 'layne.json');

export const DEFAULT_CONFIG: Readonly<ScanConfig> = Object.freeze({
  mode:           'changed_files' as const,
  contextLines:   8,
  timeoutMinutes: 15,
  maxFileSizeKb:  1024,
  maxLockfileSizeKb: 4096,
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
  spectre: Object.freeze({
    enabled:        false,
    model:          'claude-haiku-4-5-20251001',
    fileCap:        20,
    secondaryFileCap: 20,
    maxDiffLines:   400,
    maxInputBytes:  64 * 1024,
    maxOutputTokens: 1_200,
    requestTimeoutSeconds: 30,
    maxCallsPerFile: 4,
    maxCallsPerPullRequest: 40,
    maxRepairCallsPerPullRequest: 3,
    minSeverity:    'high',
    concurrency:    2,
    skipPaths:      [],
    skipExtensions: [],
    prompt:         null,
    boostPatterns:  [],
    cache: Object.freeze({
      enabled: false,
      positiveTtlSeconds: 24 * 60 * 60,
      negativeTtlSeconds: 60 * 60,
    }),
    astSignals: Object.freeze({
      mode: 'off',
      maxFiles: 200,
      maxTotalBytes: 2 * 1024 * 1024,
      timeoutSeconds: 3,
    }),
  } as SpectreConfig),  // note: no default provider — omitting provider disables Spectre even when enabled: true
  depDoctor: Object.freeze({
    enabled:         false,
    minCveSeverity:  'high',
    checkAbandoned:  true,
    abandonedDays:   730,
    checkDeprecated: true,
    extraArgs:       [],
  } as DepDoctorConfig),
  labels:  Object.freeze({} as LabelConfig),
  trigger: Object.freeze({ on: 'pull_request', scanOnDraft: false } as TriggerConfig),
  comment: Object.freeze({ enabled: false, template: null } as CommentConfig),
  exceptionApprovers: Object.freeze({ users: [], teams: [] } as ExceptionApproversConfig),
  notifications: Object.freeze({} as Record<string, never>),
});

// Cached after first read — layne.json is loaded once per process.
// Restart both server and worker to pick up config changes (same lifecycle as code deploys).
let reposConfigCache: Record<string, unknown> | null = null;

export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}

async function loadReposConfig(): Promise<Record<string, unknown>> {
  if (reposConfigCache) return reposConfigCache;
  try {
    // JSON.parse result used as typed config object
    const raw: unknown = JSON.parse(await readFile(REPOS_CONFIG_PATH, 'utf8'));
    const result = validateConfig(raw);
    if (!result.valid) {
      throw new ConfigLoadError(`layne.json has validation errors:\n${result.errors.map(err => `- ${err}`).join('\n')}`);
    }
    reposConfigCache = (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
    return reposConfigCache;
  } catch (err) {
    if (err instanceof ConfigLoadError) throw err;
    if (err instanceof SyntaxError) throw new ConfigLoadError(`layne.json is not valid JSON: ${err.message}`);
    throw new ConfigLoadError(`failed to load layne.json: ${(err as Error).message}`);
  }
}

export async function validateConfigFile(): Promise<void> {
  await loadReposConfig();
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

  const globalSpectre: Partial<SpectreConfig> = globalConfig.spectre ?? {};
  const repoSpectre: Partial<SpectreConfig> = repoOverrides.spectre ?? {};

  return {
    mode:           repoOverrides.mode           ?? globalConfig.mode           ?? DEFAULT_CONFIG.mode,
    contextLines:   repoOverrides.contextLines   ?? globalConfig.contextLines   ?? DEFAULT_CONFIG.contextLines,
    timeoutMinutes: repoOverrides.timeoutMinutes ?? globalConfig.timeoutMinutes ?? DEFAULT_CONFIG.timeoutMinutes,
    maxFileSizeKb:  repoOverrides.maxFileSizeKb  ?? globalConfig.maxFileSizeKb  ?? DEFAULT_CONFIG.maxFileSizeKb,
    maxLockfileSizeKb: repoOverrides.maxLockfileSizeKb ?? globalConfig.maxLockfileSizeKb ?? DEFAULT_CONFIG.maxLockfileSizeKb,
    semgrep:       { ...DEFAULT_CONFIG.semgrep,    ...(globalConfig.semgrep    ?? {}), ...(repoOverrides.semgrep    ?? {}) },
    trufflehog:    { ...DEFAULT_CONFIG.trufflehog, ...(globalConfig.trufflehog ?? {}), ...(repoOverrides.trufflehog ?? {}) },
    claude:        { ...DEFAULT_CONFIG.claude,     ...(globalConfig.claude     ?? {}), ...(repoOverrides.claude     ?? {}) },
    spectre:       {
      ...DEFAULT_CONFIG.spectre,
      ...globalSpectre,
      ...repoSpectre,
      cache: {
        ...DEFAULT_CONFIG.spectre.cache!,
        ...(globalSpectre.cache ?? {}),
        ...(repoSpectre.cache ?? {}),
      },
      astSignals: {
        ...DEFAULT_CONFIG.spectre.astSignals,
        ...(globalSpectre.astSignals ?? {}),
        ...(repoSpectre.astSignals ?? {}),
      },
    },
    depDoctor:     { ...DEFAULT_CONFIG.depDoctor,  ...(globalConfig.depDoctor  ?? {}), ...(repoOverrides.depDoctor  ?? {}) },
    notifications: { ...globalNotifications, ...repoNotifications },
    labels:        { ...globalLabels, ...repoLabels },
    trigger:       { ...DEFAULT_CONFIG.trigger, ...globalTrigger, ...(repoOverrides.trigger ?? {}) },
    comment:       { ...DEFAULT_CONFIG.comment, ...globalComment, ...repoComment },
    exceptionApprovers: repoExceptionApprovers ?? globalExceptionApprovers,
  };
}
