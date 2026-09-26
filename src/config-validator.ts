/**
 * Validates the structure of a parsed layne.json object.
 *
 * Returns { valid: true } if the config is acceptable, or
 * { valid: false, errors: string[] } listing every problem found.
 *
 * This module has no dependencies and can be imported anywhere or run
 * directly via `npm run validate-config`.
 */

const KNOWN_REPO_KEYS    = new Set(['mode', 'contextLines', 'timeoutMinutes', 'maxFileSizeKb', 'maxLockfileSizeKb', 'semgrep', 'trufflehog', 'claude', 'spectre', 'depDoctor', 'notifications', 'labels', 'trigger', 'comment', 'exceptionApprovers']);
const KNOWN_GLOBAL_KEYS  = new Set(['mode', 'contextLines', 'timeoutMinutes', 'maxFileSizeKb', 'maxLockfileSizeKb', 'semgrep', 'trufflehog', 'claude', 'spectre', 'depDoctor', 'notifications', 'labels', 'trigger', 'comment', 'exceptionApprovers']);
const VALID_MODES        = new Set(['changed_files', 'diff_only']);
const VALID_TRIGGER_ONS  = new Set(['pull_request', 'workflow_run', 'workflow_job']);
const VALID_CONCLUSIONS  = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required']);
const CLAUDE_MODELS  = /^claude-/;
const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const VALID_NOTIFICATION_EVENTS = new Set(['findings', 'coverage-failure', 'incomplete-scan', 'internal-error', 'exception-approval']);
const KNOWN_NOTIFIER_KEYS = new Set(['enabled', 'webhookUrl', 'template', 'templates', 'notifyOn', 'minFindingSeverity']);
const VALID_SPECTRE_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'mistral', 'amazon-bedrock']);
const KNOWN_SPECTRE_KEYS = new Set(['enabled', 'provider', 'model', 'fileCap', 'secondaryFileCap', 'maxDiffLines', 'minSeverity', 'skipPaths', 'skipExtensions', 'concurrency', 'prompt', 'boostPatterns', 'maxInputBytes', 'maxOutputTokens', 'requestTimeoutSeconds', 'maxCallsPerFile', 'maxCallsPerPullRequest', 'maxRepairCallsPerPullRequest', 'cache', 'astSignals']);
const KNOWN_SPECTRE_CACHE_KEYS = new Set(['enabled', 'positiveTtlSeconds', 'negativeTtlSeconds']);
const KNOWN_SPECTRE_AST_SIGNAL_KEYS = new Set(['mode', 'maxFiles', 'maxTotalBytes', 'timeoutSeconds']);
const SPECTRE_LIMITS = {
  maxInputBytes: 64 * 1024,
  maxOutputTokens: 2_000,
  requestTimeoutSeconds: 30,
  concurrency: 2,
  maxCallsPerFile: 20,
  maxCallsPerPullRequest: 100,
};
const REPO_KEY_RE        = /^[^/]+\/[^/]+$/;

export type ValidateConfigResult =
  | { valid: true }
  | { valid: false; errors: string[] };

export function validateConfig(config: unknown): ValidateConfigResult {
  const errors: string[] = [];

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { valid: false, errors: ['layne.json must be a JSON object'] };
  }

  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    const ctx = `"${key}"`;

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${ctx}: value must be an object`);
      continue;
    }

    if (key === '$global') {
      validateGlobal(value as Record<string, unknown>, ctx, errors);
    } else if (REPO_KEY_RE.test(key)) {
      validateRepo(value as Record<string, unknown>, ctx, errors);
    } else {
      errors.push(`${ctx}: key must be "$global" or "owner/repo" format`);
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------

function validateGlobal(block: Record<string, unknown>, ctx: string, errors: string[]): void {
  for (const key of Object.keys(block)) {
    if (!KNOWN_GLOBAL_KEYS.has(key)) {
      errors.push(`${ctx}: unknown key "${key}" (allowed: ${[...KNOWN_GLOBAL_KEYS].join(', ')})`);
    }
  }
  validateScanMode(block, ctx, errors);
  if (block['semgrep']             !== undefined) validateScanner(block['semgrep'], `${ctx}.semgrep`, errors);
  if (block['trufflehog']          !== undefined) validateScanner(block['trufflehog'], `${ctx}.trufflehog`, errors);
  if (block['claude']              !== undefined) validateClaude(block['claude'], `${ctx}.claude`, errors);
  if (block['spectre']             !== undefined) validateSpectre(block['spectre'], `${ctx}.spectre`, errors);
  if (block['notifications'] !== undefined) validateNotifications(block['notifications'], `${ctx}.notifications`, errors);
  if (block['labels']        !== undefined) validateLabels(block['labels'], `${ctx}.labels`, errors);
  if (block['trigger']       !== undefined) validateTrigger(block['trigger'], `${ctx}.trigger`, errors);
  if (block['comment']       !== undefined) validateComment(block['comment'], `${ctx}.comment`, errors);
  if (block['depDoctor']          !== undefined) validateDepDoctor(block['depDoctor'], `${ctx}.depDoctor`, errors);
  if (block['exceptionApprovers'] !== undefined) validateExceptionApprovers(block['exceptionApprovers'], `${ctx}.exceptionApprovers`, errors);
}

function validateRepo(block: Record<string, unknown>, ctx: string, errors: string[]): void {
  for (const key of Object.keys(block)) {
    if (!KNOWN_REPO_KEYS.has(key)) {
      errors.push(`${ctx}: unknown key "${key}" (allowed: ${[...KNOWN_REPO_KEYS].join(', ')})`);
    }
  }
  validateScanMode(block, ctx, errors);
  if (block['semgrep']       !== undefined) validateScanner(block['semgrep'],    `${ctx}.semgrep`,    errors);
  if (block['trufflehog']    !== undefined) validateScanner(block['trufflehog'], `${ctx}.trufflehog`, errors);
  if (block['claude']        !== undefined) validateClaude(block['claude'],       `${ctx}.claude`,     errors);
  if (block['spectre']       !== undefined) validateSpectre(block['spectre'],    `${ctx}.spectre`,    errors);
  if (block['depDoctor']     !== undefined) validateDepDoctor(block['depDoctor'], `${ctx}.depDoctor`,  errors);
  if (block['notifications'] !== undefined) validateNotifications(block['notifications'], `${ctx}.notifications`, errors);
  if (block['labels']        !== undefined) validateLabels(block['labels'], `${ctx}.labels`, errors);
  if (block['trigger']       !== undefined) validateTrigger(block['trigger'], `${ctx}.trigger`, errors);
  if (block['comment']       !== undefined) validateComment(block['comment'], `${ctx}.comment`, errors);
  if (block['exceptionApprovers'] !== undefined) validateExceptionApprovers(block['exceptionApprovers'], `${ctx}.exceptionApprovers`, errors);
}

function validateScanMode(block: Record<string, unknown>, ctx: string, errors: string[]): void {
  if (block['mode'] !== undefined && !VALID_MODES.has(block['mode'] as string))
    errors.push(`${ctx}.mode: must be "changed_files" or "diff_only", got "${block['mode']}"`);
  if (block['contextLines'] !== undefined) {
    if (!Number.isInteger(block['contextLines']) || (block['contextLines'] as number) < 0)
      errors.push(`${ctx}.contextLines: must be a non-negative integer`);
  }
  if (block['timeoutMinutes'] !== undefined) {
    if (!Number.isInteger(block['timeoutMinutes']) || (block['timeoutMinutes'] as number) < 1)
      errors.push(`${ctx}.timeoutMinutes: must be a positive integer`);
  }
  if (block['maxFileSizeKb'] !== undefined) {
    if (!Number.isInteger(block['maxFileSizeKb']) || (block['maxFileSizeKb'] as number) < 1)
      errors.push(`${ctx}.maxFileSizeKb: must be a positive integer (kilobytes)`);
  }
  if (block['maxLockfileSizeKb'] !== undefined) {
    if (!Number.isInteger(block['maxLockfileSizeKb']) || (block['maxLockfileSizeKb'] as number) < 1)
      errors.push(`${ctx}.maxLockfileSizeKb: must be a positive integer (kilobytes)`);
  }
}

function validateScanner(block: unknown, ctx: string, errors: string[]): void {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  const b = block as Record<string, unknown>;
  if (b['enabled']   !== undefined && typeof b['enabled'] !== 'boolean')
    errors.push(`${ctx}.enabled: must be a boolean`);
  if (b['extraArgs'] !== undefined) {
    if (!Array.isArray(b['extraArgs']))
      errors.push(`${ctx}.extraArgs: must be an array`);
    else if ((b['extraArgs'] as unknown[]).some(a => typeof a !== 'string'))
      errors.push(`${ctx}.extraArgs: all items must be strings`);
  }
}

function validateClaude(block: unknown, ctx: string, errors: string[]): void {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  const b = block as Record<string, unknown>;

  if (b['enabled'] !== undefined && typeof b['enabled'] !== 'boolean')
    errors.push(`${ctx}.enabled: must be a boolean`);

  if (b['model'] !== undefined) {
    if (typeof b['model'] !== 'string')
      errors.push(`${ctx}.model: must be a string`);
    else if (!CLAUDE_MODELS.test(b['model']))
      errors.push(`${ctx}.model: expected a Claude model ID (e.g. "claude-sonnet-4-6"), got "${b['model']}"`);
  }

  if (b['prompt'] !== undefined && b['prompt'] !== null && typeof b['prompt'] !== 'string')
    errors.push(`${ctx}.prompt: must be a string or null`);

  if (b['skill'] !== undefined && b['skill'] !== null) {
    if (typeof b['skill'] !== 'object' || Array.isArray(b['skill'])) {
      errors.push(`${ctx}.skill: must be an object with "id" and optional "version"`);
    } else {
      const skill = b['skill'] as Record<string, unknown>;
      if (typeof skill['id'] !== 'string' || !(skill['id'] as string).startsWith('skill_'))
        errors.push(`${ctx}.skill.id: must be a string starting with "skill_"`);
      if (skill['version'] !== undefined && typeof skill['version'] !== 'string')
        errors.push(`${ctx}.skill.version: must be a string (e.g. "latest")`);
    }
  }

  if (b['prompt'] && b['skill']) {
    errors.push(`${ctx}: "prompt" and "skill" are mutually exclusive — remove one`);
  }
}

function validateSpectre(block: unknown, ctx: string, errors: string[]): void {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  const b = block as Record<string, unknown>;

  for (const key of Object.keys(b)) {
    if (!KNOWN_SPECTRE_KEYS.has(key)) errors.push(`${ctx}: unknown key "${key}"`);
  }

  if (b['enabled'] !== undefined && typeof b['enabled'] !== 'boolean')
    errors.push(`${ctx}.enabled: must be a boolean`);

  if (b['provider'] !== undefined) {
    if (typeof b['provider'] !== 'string' || (b['provider'] as string).trim() === '')
      errors.push(`${ctx}.provider: must be a non-empty string`);
    else if (!VALID_SPECTRE_PROVIDERS.has(b['provider'] as string))
      errors.push(`${ctx}.provider: must be one of ${[...VALID_SPECTRE_PROVIDERS].join(', ')}`);
  }

  if (b['model'] !== undefined) {
    if (typeof b['model'] !== 'string' || (b['model'] as string).trim() === '')
      errors.push(`${ctx}.model: must be a non-empty string`);
    else if (
      (b['provider'] === undefined || b['provider'] === 'anthropic') &&
      !CLAUDE_MODELS.test(b['model'])
    )
      errors.push(`${ctx}.model: expected a Claude model ID (e.g. "claude-haiku-4-5-20251001"), got "${b['model']}"`);
  }

  if (b['fileCap'] !== undefined) {
    if (!Number.isInteger(b['fileCap']) || (b['fileCap'] as number) < 1 || (b['fileCap'] as number) > 30)
      errors.push(`${ctx}.fileCap: must be an integer between 1 and 30`);
  }

  if (b['secondaryFileCap'] !== undefined) {
    if (!Number.isInteger(b['secondaryFileCap']) || (b['secondaryFileCap'] as number) < 0 || (b['secondaryFileCap'] as number) > 50)
      errors.push(`${ctx}.secondaryFileCap: must be an integer between 0 and 50 (use 0 to disable)`);
  }

  if (b['maxDiffLines'] !== undefined) {
    if (!Number.isInteger(b['maxDiffLines']) || (b['maxDiffLines'] as number) < 1 || (b['maxDiffLines'] as number) > 1000)
      errors.push(`${ctx}.maxDiffLines: must be an integer between 1 and 1000`);
  }

  if (b['minSeverity'] !== undefined) {
    if (!VALID_SEVERITIES.has(b['minSeverity'] as string))
      errors.push(`${ctx}.minSeverity: must be one of ${[...VALID_SEVERITIES].join(', ')}`);
  }

  if (b['skipPaths'] !== undefined) {
    if (!Array.isArray(b['skipPaths']))
      errors.push(`${ctx}.skipPaths: must be an array`);
    else if ((b['skipPaths'] as unknown[]).some(p => typeof p !== 'string'))
      errors.push(`${ctx}.skipPaths: all items must be strings`);
  }

  if (b['skipExtensions'] !== undefined) {
    if (!Array.isArray(b['skipExtensions']))
      errors.push(`${ctx}.skipExtensions: must be an array`);
    else if ((b['skipExtensions'] as unknown[]).some(e => typeof e !== 'string'))
      errors.push(`${ctx}.skipExtensions: all items must be strings`);
    else if ((b['skipExtensions'] as string[]).some(e => !e.startsWith('.')))
      errors.push(`${ctx}.skipExtensions: all items must start with "." (e.g. ".min.js")`);
  }

  if (b['concurrency'] !== undefined) {
    if (!Number.isInteger(b['concurrency']) || (b['concurrency'] as number) < 1)
      errors.push(`${ctx}.concurrency: must be a positive integer`);
  }

  for (const [key, maximum] of Object.entries(SPECTRE_LIMITS)) {
    if (b[key] !== undefined && (!Number.isInteger(b[key]) || (b[key] as number) < 1 || (b[key] as number) > maximum))
      errors.push(`${ctx}.${key}: must be an integer between 1 and ${maximum}`);
  }

  if (b['maxRepairCallsPerPullRequest'] !== undefined) {
    if (!Number.isInteger(b['maxRepairCallsPerPullRequest']) || (b['maxRepairCallsPerPullRequest'] as number) < 0 || (b['maxRepairCallsPerPullRequest'] as number) > 10)
      errors.push(`${ctx}.maxRepairCallsPerPullRequest: must be an integer between 0 and 10`);
  }

  if (b['prompt'] !== undefined && b['prompt'] !== null) {
    if (typeof b['prompt'] !== 'string' || (b['prompt'] as string).trim() === '')
      errors.push(`${ctx}.prompt: must be a non-empty string or null`);
  }

  if (b['boostPatterns'] !== undefined) {
    if (!Array.isArray(b['boostPatterns'])) {
      errors.push(`${ctx}.boostPatterns: must be an array`);
    } else {
      for (const p of b['boostPatterns'] as unknown[]) {
        if (typeof p !== 'string') {
          errors.push(`${ctx}.boostPatterns: all items must be strings`);
          break;
        }
        try { new RegExp(p); } catch {
          errors.push(`${ctx}.boostPatterns: "${p}" is not a valid regular expression`);
        }
      }
    }
  }

  if (b['cache'] !== undefined) validateSpectreCache(b['cache'], `${ctx}.cache`, errors);
  if (b['astSignals'] !== undefined) validateSpectreAstSignals(b['astSignals'], `${ctx}.astSignals`, errors);
}

function validateSpectreAstSignals(block: unknown, ctx: string, errors: string[]): void {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    errors.push(`${ctx}: must be an object`);
    return;
  }
  const astSignals = block as Record<string, unknown>;
  for (const key of Object.keys(astSignals)) {
    if (!KNOWN_SPECTRE_AST_SIGNAL_KEYS.has(key)) errors.push(`${ctx}: unknown key "${key}"`);
  }
  if (astSignals['mode'] !== undefined && !['off', 'shadow', 'enabled'].includes(String(astSignals['mode']))) {
    errors.push(`${ctx}.mode: must be "off", "shadow", or "enabled"`);
  }
  const limits: Record<string, [number, number]> = {
    maxFiles: [1, 500],
    maxTotalBytes: [1, 64 * 1024 * 1024],
    timeoutSeconds: [1, 30],
  };
  for (const [key, [minimum, maximum]] of Object.entries(limits)) {
    const value = astSignals[key];
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum)) {
      errors.push(`${ctx}.${key}: must be an integer between ${minimum} and ${maximum}`);
    }
  }
}

function validateSpectreCache(block: unknown, ctx: string, errors: string[]): void {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    errors.push(`${ctx}: must be an object`);
    return;
  }
  const cache = block as Record<string, unknown>;
  for (const key of Object.keys(cache)) {
    if (!KNOWN_SPECTRE_CACHE_KEYS.has(key)) errors.push(`${ctx}: unknown key "${key}"`);
  }
  if (cache['enabled'] !== undefined && typeof cache['enabled'] !== 'boolean') {
    errors.push(`${ctx}.enabled: must be a boolean`);
  }
  for (const key of ['positiveTtlSeconds', 'negativeTtlSeconds']) {
    const value = cache[key];
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 60 || (value as number) > 7 * 24 * 60 * 60)) {
      errors.push(`${ctx}.${key}: must be an integer between 60 and 604800`);
    }
  }
}

function validateTrigger(block: unknown, ctx: string, errors: string[]): void {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  const b = block as Record<string, unknown>;

  if (b['on'] !== undefined) {
    if (!VALID_TRIGGER_ONS.has(b['on'] as string))
      errors.push(`${ctx}.on: must be "pull_request", "workflow_run", or "workflow_job", got "${b['on']}"`);
  }

  const on = (b['on'] as string | undefined) ?? 'pull_request';

  if (b['scanOnDraft'] !== undefined && typeof b['scanOnDraft'] !== 'boolean')
    errors.push(`${ctx}.scanOnDraft: must be a boolean`);

  if (on === 'workflow_run') {
    if (b['workflow'] === undefined || b['workflow'] === null)
      errors.push(`${ctx}.workflow: required when "on" is "workflow_run"`);
    else if (typeof b['workflow'] !== 'string' || (b['workflow'] as string).trim() === '')
      errors.push(`${ctx}.workflow: must be a non-empty string`);
  } else {
    if (b['workflow'] !== undefined)
      errors.push(`${ctx}.workflow: only valid when "on" is "workflow_run"`);
  }

  if (on === 'workflow_job') {
    if (b['job'] === undefined || b['job'] === null)
      errors.push(`${ctx}.job: required when "on" is "workflow_job"`);
    else if (typeof b['job'] !== 'string' || (b['job'] as string).trim() === '')
      errors.push(`${ctx}.job: must be a non-empty string`);
  } else {
    if (b['job'] !== undefined)
      errors.push(`${ctx}.job: only valid when "on" is "workflow_job"`);
  }

  if (b['conclusions'] !== undefined) {
    if (!Array.isArray(b['conclusions']))
      errors.push(`${ctx}.conclusions: must be an array`);
    else if ((b['conclusions'] as unknown[]).length === 0)
      errors.push(`${ctx}.conclusions: must not be empty`);
    else {
      for (const c of b['conclusions'] as unknown[]) {
        if (typeof c !== 'string' || !VALID_CONCLUSIONS.has(c))
          errors.push(`${ctx}.conclusions: "${c}" is not a valid GitHub workflow conclusion`);
      }
    }
  }
}

function validateNotifications(block: unknown, ctx: string, errors: string[]): void {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  for (const [provider, cfg] of Object.entries(block as Record<string, unknown>)) {
    const pctx = `${ctx}.${provider}`;
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) { errors.push(`${pctx}: must be an object`); continue; }
    const c = cfg as Record<string, unknown>;
    for (const key of Object.keys(c)) {
      if (!KNOWN_NOTIFIER_KEYS.has(key)) errors.push(`${pctx}: unknown key "${key}"`);
    }
    if (c['enabled'] !== undefined && typeof c['enabled'] !== 'boolean')
      errors.push(`${pctx}.enabled: must be a boolean`);
    if (c['webhookUrl'] !== undefined && typeof c['webhookUrl'] !== 'string')
      errors.push(`${pctx}.webhookUrl: must be a string`);
    if (c['template'] !== undefined && typeof c['template'] !== 'string')
      errors.push(`${pctx}.template: must be a string`);
    if (c['minFindingSeverity'] !== undefined && !VALID_SEVERITIES.has(c['minFindingSeverity'] as string))
      errors.push(`${pctx}.minFindingSeverity: must be one of ${[...VALID_SEVERITIES].join(', ')}`);
    if (c['notifyOn'] !== undefined) {
      if (!Array.isArray(c['notifyOn']) || (c['notifyOn'] as unknown[]).length === 0) {
        errors.push(`${pctx}.notifyOn: must be a non-empty array`);
      } else {
        for (const event of c['notifyOn'] as unknown[]) {
          if (typeof event !== 'string' || !VALID_NOTIFICATION_EVENTS.has(event))
            errors.push(`${pctx}.notifyOn: "${event}" is not a valid notification event`);
        }
      }
    }
    if (c['templates'] !== undefined) {
      if (typeof c['templates'] !== 'object' || c['templates'] === null || Array.isArray(c['templates'])) {
        errors.push(`${pctx}.templates: must be an object`);
      } else {
        for (const [event, template] of Object.entries(c['templates'] as Record<string, unknown>)) {
          if (!VALID_NOTIFICATION_EVENTS.has(event)) errors.push(`${pctx}.templates: unknown event "${event}"`);
          if (typeof template !== 'string') errors.push(`${pctx}.templates.${event}: must be a string`);
        }
      }
    }
  }
}

function validateComment(block: unknown, ctx: string, errors: string[]): void {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  const b = block as Record<string, unknown>;
  if (b['enabled'] !== undefined && typeof b['enabled'] !== 'boolean')
    errors.push(`${ctx}.enabled: must be a boolean`);
  if (b['template'] !== undefined && b['template'] !== null && typeof b['template'] !== 'string')
    errors.push(`${ctx}.template: must be a string or null`);
}

function validateLabels(block: unknown, ctx: string, errors: string[]): void {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  const b = block as Record<string, unknown>;
  for (const key of ['onFailure', 'removeOnFailure', 'onSuccess', 'removeOnSuccess', 'onIncomplete', 'removeOnIncomplete', 'onException', 'removeOnException']) {
    if (b[key] === undefined) continue;
    if (!Array.isArray(b[key]))
      errors.push(`${ctx}.${key}: must be an array`);
    else if ((b[key] as unknown[]).some(l => typeof l !== 'string'))
      errors.push(`${ctx}.${key}: all items must be strings`);
  }
}

function validateDepDoctor(block: unknown, ctx: string, errors: string[]): void {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  const b = block as Record<string, unknown>;

  if (b['enabled'] !== undefined && typeof b['enabled'] !== 'boolean')
    errors.push(`${ctx}.enabled: must be a boolean`);

  if (b['minCveSeverity'] !== undefined && !VALID_SEVERITIES.has(b['minCveSeverity'] as string))
    errors.push(`${ctx}.minCveSeverity: must be one of ${[...VALID_SEVERITIES].join(', ')}`);

  if (b['checkAbandoned'] !== undefined && typeof b['checkAbandoned'] !== 'boolean')
    errors.push(`${ctx}.checkAbandoned: must be a boolean`);

  if (b['abandonedDays'] !== undefined) {
    if (!Number.isInteger(b['abandonedDays']) || (b['abandonedDays'] as number) < 1)
      errors.push(`${ctx}.abandonedDays: must be a positive integer`);
  }

  if (b['checkDeprecated'] !== undefined && typeof b['checkDeprecated'] !== 'boolean')
    errors.push(`${ctx}.checkDeprecated: must be a boolean`);

  if (b['extraArgs'] !== undefined) {
    if (!Array.isArray(b['extraArgs']))
      errors.push(`${ctx}.extraArgs: must be an array`);
    else if ((b['extraArgs'] as unknown[]).some(a => typeof a !== 'string'))
      errors.push(`${ctx}.extraArgs: all items must be strings`);
  }
}

function validateExceptionApprovers(block: unknown, ctx: string, errors: string[]): void {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  const b = block as Record<string, unknown>;

  if (b['users'] !== undefined) {
    if (!Array.isArray(b['users']))
      errors.push(`${ctx}.users: must be an array`);
    else if ((b['users'] as unknown[]).some(u => typeof u !== 'string'))
      errors.push(`${ctx}.users: all items must be strings`);
  }

  if (b['teams'] !== undefined) {
    if (!Array.isArray(b['teams']))
      errors.push(`${ctx}.teams: must be an array`);
    else if ((b['teams'] as unknown[]).some(t => typeof t !== 'string'))
      errors.push(`${ctx}.teams: all items must be strings`);
  }
}
