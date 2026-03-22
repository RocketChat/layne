/**
 * Validates the structure of a parsed layne.json object.
 *
 * Returns { valid: true } if the config is acceptable, or
 * { valid: false, errors: string[] } listing every problem found.
 *
 * This module has no dependencies and can be imported anywhere or run
 * directly via `npm run validate-config`.
 */

const KNOWN_REPO_KEYS    = new Set(['mode', 'contextLines', 'timeoutMinutes', 'semgrep', 'trufflehog', 'claude', 'notifications', 'labels', 'trigger', 'comment', 'exceptionApprovers']);
const KNOWN_GLOBAL_KEYS  = new Set(['mode', 'contextLines', 'timeoutMinutes', 'notifications', 'labels', 'trigger', 'comment', 'exceptionApprovers']);
const VALID_MODES        = new Set(['changed_files', 'diff_only']);
const VALID_TRIGGER_ONS  = new Set(['pull_request', 'workflow_run', 'workflow_job']);
const VALID_CONCLUSIONS  = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required']);
const CLAUDE_MODELS      = /^claude-/;
const REPO_KEY_RE        = /^[^/]+\/[^/]+$/;

export function validateConfig(config) {
  const errors = [];

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { valid: false, errors: ['layne.json must be a JSON object'] };
  }

  for (const [key, value] of Object.entries(config)) {
    const ctx = `"${key}"`;

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${ctx}: value must be an object`);
      continue;
    }

    if (key === '$global') {
      validateGlobal(value, ctx, errors);
    } else if (REPO_KEY_RE.test(key)) {
      validateRepo(value, ctx, errors);
    } else {
      errors.push(`${ctx}: key must be "$global" or "owner/repo" format`);
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------

function validateGlobal(block, ctx, errors) {
  for (const key of Object.keys(block)) {
    if (!KNOWN_GLOBAL_KEYS.has(key)) {
      errors.push(`${ctx}: unknown key "${key}" (allowed: ${[...KNOWN_GLOBAL_KEYS].join(', ')})`);
    }
  }
  validateScanMode(block, ctx, errors);
  if (block.notifications !== undefined) validateNotifications(block.notifications, `${ctx}.notifications`, errors);
  if (block.labels        !== undefined) validateLabels(block.labels, `${ctx}.labels`, errors);
  if (block.trigger       !== undefined) validateTrigger(block.trigger, `${ctx}.trigger`, errors);
  if (block.comment       !== undefined) validateComment(block.comment, `${ctx}.comment`, errors);
  if (block.exceptionApprovers !== undefined) validateExceptionApprovers(block.exceptionApprovers, `${ctx}.exceptionApprovers`, errors);
}

function validateRepo(block, ctx, errors) {
  for (const key of Object.keys(block)) {
    if (!KNOWN_REPO_KEYS.has(key)) {
      errors.push(`${ctx}: unknown key "${key}" (allowed: ${[...KNOWN_REPO_KEYS].join(', ')})`);
    }
  }
  validateScanMode(block, ctx, errors);
  if (block.semgrep       !== undefined) validateScanner(block.semgrep,    `${ctx}.semgrep`,    errors);
  if (block.trufflehog    !== undefined) validateScanner(block.trufflehog, `${ctx}.trufflehog`, errors);
  if (block.claude        !== undefined) validateClaude(block.claude,       `${ctx}.claude`,     errors);
  if (block.notifications !== undefined) validateNotifications(block.notifications, `${ctx}.notifications`, errors);
  if (block.labels        !== undefined) validateLabels(block.labels, `${ctx}.labels`, errors);
  if (block.trigger       !== undefined) validateTrigger(block.trigger, `${ctx}.trigger`, errors);
  if (block.comment       !== undefined) validateComment(block.comment, `${ctx}.comment`, errors);
  if (block.exceptionApprovers !== undefined) validateExceptionApprovers(block.exceptionApprovers, `${ctx}.exceptionApprovers`, errors);
}

function validateScanMode(block, ctx, errors) {
  if (block.mode !== undefined && !VALID_MODES.has(block.mode))
    errors.push(`${ctx}.mode: must be "changed_files" or "diff_only", got "${block.mode}"`);
  if (block.contextLines !== undefined) {
    if (!Number.isInteger(block.contextLines) || block.contextLines < 0)
      errors.push(`${ctx}.contextLines: must be a non-negative integer`);
  }
  if (block.timeoutMinutes !== undefined) {
    if (!Number.isInteger(block.timeoutMinutes) || block.timeoutMinutes < 1)
      errors.push(`${ctx}.timeoutMinutes: must be a positive integer`);
  }
}

function validateScanner(block, ctx, errors) {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  if (block.enabled   !== undefined && typeof block.enabled !== 'boolean')
    errors.push(`${ctx}.enabled: must be a boolean`);
  if (block.extraArgs !== undefined) {
    if (!Array.isArray(block.extraArgs))
      errors.push(`${ctx}.extraArgs: must be an array`);
    else if (block.extraArgs.some(a => typeof a !== 'string'))
      errors.push(`${ctx}.extraArgs: all items must be strings`);
  }
}

function validateClaude(block, ctx, errors) {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }

  if (block.enabled !== undefined && typeof block.enabled !== 'boolean')
    errors.push(`${ctx}.enabled: must be a boolean`);

  if (block.model !== undefined) {
    if (typeof block.model !== 'string')
      errors.push(`${ctx}.model: must be a string`);
    else if (!CLAUDE_MODELS.test(block.model))
      errors.push(`${ctx}.model: expected a Claude model ID (e.g. "claude-sonnet-4-6"), got "${block.model}"`);
  }

  if (block.prompt !== undefined && block.prompt !== null && typeof block.prompt !== 'string')
    errors.push(`${ctx}.prompt: must be a string or null`);

  if (block.skill !== undefined && block.skill !== null) {
    if (typeof block.skill !== 'object' || Array.isArray(block.skill)) {
      errors.push(`${ctx}.skill: must be an object with "id" and optional "version"`);
    } else {
      if (typeof block.skill.id !== 'string' || !block.skill.id.startsWith('skill_'))
        errors.push(`${ctx}.skill.id: must be a string starting with "skill_"`);
      if (block.skill.version !== undefined && typeof block.skill.version !== 'string')
        errors.push(`${ctx}.skill.version: must be a string (e.g. "latest")`);
    }
  }

  if (block.prompt && block.skill) {
    errors.push(`${ctx}: "prompt" and "skill" are mutually exclusive — remove one`);
  }
}

function validateTrigger(block, ctx, errors) {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }

  if (block.on !== undefined) {
    if (!VALID_TRIGGER_ONS.has(block.on))
      errors.push(`${ctx}.on: must be "pull_request", "workflow_run", or "workflow_job", got "${block.on}"`);
  }

  const on = block.on ?? 'pull_request';

  if (on === 'workflow_run') {
    if (block.workflow === undefined || block.workflow === null)
      errors.push(`${ctx}.workflow: required when "on" is "workflow_run"`);
    else if (typeof block.workflow !== 'string' || block.workflow.trim() === '')
      errors.push(`${ctx}.workflow: must be a non-empty string`);
  } else {
    if (block.workflow !== undefined)
      errors.push(`${ctx}.workflow: only valid when "on" is "workflow_run"`);
  }

  if (on === 'workflow_job') {
    if (block.job === undefined || block.job === null)
      errors.push(`${ctx}.job: required when "on" is "workflow_job"`);
    else if (typeof block.job !== 'string' || block.job.trim() === '')
      errors.push(`${ctx}.job: must be a non-empty string`);
  } else {
    if (block.job !== undefined)
      errors.push(`${ctx}.job: only valid when "on" is "workflow_job"`);
  }

  if (block.conclusions !== undefined) {
    if (!Array.isArray(block.conclusions))
      errors.push(`${ctx}.conclusions: must be an array`);
    else if (block.conclusions.length === 0)
      errors.push(`${ctx}.conclusions: must not be empty`);
    else {
      for (const c of block.conclusions) {
        if (typeof c !== 'string' || !VALID_CONCLUSIONS.has(c))
          errors.push(`${ctx}.conclusions: "${c}" is not a valid GitHub workflow conclusion`);
      }
    }
  }
}

function validateNotifications(block, ctx, errors) {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  for (const [provider, cfg] of Object.entries(block)) {
    const pctx = `${ctx}.${provider}`;
    if (typeof cfg !== 'object' || cfg === null) { errors.push(`${pctx}: must be an object`); continue; }
    if (cfg.enabled !== undefined && typeof cfg.enabled !== 'boolean')
      errors.push(`${pctx}.enabled: must be a boolean`);
    if (cfg.webhookUrl !== undefined && typeof cfg.webhookUrl !== 'string')
      errors.push(`${pctx}.webhookUrl: must be a string`);
    if (cfg.template !== undefined && typeof cfg.template !== 'string')
      errors.push(`${pctx}.template: must be a string`);
  }
}

function validateComment(block, ctx, errors) {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  if (block.enabled !== undefined && typeof block.enabled !== 'boolean')
    errors.push(`${ctx}.enabled: must be a boolean`);
  if (block.template !== undefined && block.template !== null && typeof block.template !== 'string')
    errors.push(`${ctx}.template: must be a string or null`);
}

function validateLabels(block, ctx, errors) {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  for (const key of ['onFailure', 'removeOnFailure', 'onSuccess', 'removeOnSuccess', 'onException']) {
    if (block[key] === undefined) continue;
    if (!Array.isArray(block[key]))
      errors.push(`${ctx}.${key}: must be an array`);
    else if (block[key].some(l => typeof l !== 'string'))
      errors.push(`${ctx}.${key}: all items must be strings`);
  }
}

function validateExceptionApprovers(block, ctx, errors) {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  
  if (block.users !== undefined) {
    if (!Array.isArray(block.users))
      errors.push(`${ctx}.users: must be an array`);
    else if (block.users.some(u => typeof u !== 'string'))
      errors.push(`${ctx}.users: all items must be strings`);
  }
  
  if (block.teams !== undefined) {
    if (!Array.isArray(block.teams))
      errors.push(`${ctx}.teams: must be an array`);
    else if (block.teams.some(t => typeof t !== 'string'))
      errors.push(`${ctx}.teams: all items must be strings`);
  }
}
