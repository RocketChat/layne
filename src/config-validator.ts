/**
 * Validates the structure of a parsed layne.json object.
 *
 * Returns { valid: true } if the config is acceptable, or
 * { valid: false, errors: string[] } listing every problem found.
 *
 * This module has no dependencies and can be imported anywhere or run
 * directly via `npm run validate-config`.
 */

const KNOWN_REPO_KEYS    = new Set(['mode', 'contextLines', 'timeoutMinutes', 'maxFileSizeKb', 'semgrep', 'trufflehog', 'claude', 'spectre', 'depDoctor', 'notifications', 'labels', 'trigger', 'comment', 'exceptionApprovers']);
const KNOWN_GLOBAL_KEYS  = new Set(['mode', 'contextLines', 'timeoutMinutes', 'maxFileSizeKb', 'depDoctor', 'notifications', 'labels', 'trigger', 'comment', 'exceptionApprovers']);
const VALID_MODES        = new Set(['changed_files', 'diff_only']);
const VALID_TRIGGER_ONS  = new Set(['pull_request', 'workflow_run', 'workflow_job']);
const VALID_CONCLUSIONS  = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required']);
const CLAUDE_MODELS  = /^claude-/;
const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
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

  if (b['enabled'] !== undefined && typeof b['enabled'] !== 'boolean')
    errors.push(`${ctx}.enabled: must be a boolean`);

  if (b['provider'] !== undefined && typeof b['provider'] !== 'string')
    errors.push(`${ctx}.provider: must be a string`);

  if (b['model'] !== undefined) {
    if (typeof b['model'] !== 'string')
      errors.push(`${ctx}.model: must be a string`);
    else if (
      (b['provider'] === undefined || b['provider'] === 'anthropic') &&
      !CLAUDE_MODELS.test(b['model'])
    )
      errors.push(`${ctx}.model: expected a Claude model ID (e.g. "claude-haiku-4-5-20251001"), got "${b['model']}"`);
  }

  if (b['fileCap'] !== undefined) {
    if (!Number.isInteger(b['fileCap']) || (b['fileCap'] as number) < 1)
      errors.push(`${ctx}.fileCap: must be a positive integer`);
  }

  if (b['secondaryFileCap'] !== undefined) {
    if (!Number.isInteger(b['secondaryFileCap']) || (b['secondaryFileCap'] as number) < 0)
      errors.push(`${ctx}.secondaryFileCap: must be a non-negative integer (use 0 to disable)`);
  }

  if (b['maxDiffLines'] !== undefined) {
    if (!Number.isInteger(b['maxDiffLines']) || (b['maxDiffLines'] as number) < 1)
      errors.push(`${ctx}.maxDiffLines: must be a positive integer`);
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
}

function validateTrigger(block: unknown, ctx: string, errors: string[]): void {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  const b = block as Record<string, unknown>;

  if (b['on'] !== undefined) {
    if (!VALID_TRIGGER_ONS.has(b['on'] as string))
      errors.push(`${ctx}.on: must be "pull_request", "workflow_run", or "workflow_job", got "${b['on']}"`);
  }

  const on = (b['on'] as string | undefined) ?? 'pull_request';

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
    if (typeof cfg !== 'object' || cfg === null) { errors.push(`${pctx}: must be an object`); continue; }
    const c = cfg as Record<string, unknown>;
    if (c['enabled'] !== undefined && typeof c['enabled'] !== 'boolean')
      errors.push(`${pctx}.enabled: must be a boolean`);
    if (c['webhookUrl'] !== undefined && typeof c['webhookUrl'] !== 'string')
      errors.push(`${pctx}.webhookUrl: must be a string`);
    if (c['template'] !== undefined && typeof c['template'] !== 'string')
      errors.push(`${pctx}.template: must be a string`);
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
  for (const key of ['onFailure', 'removeOnFailure', 'onSuccess', 'removeOnSuccess', 'onException']) {
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
