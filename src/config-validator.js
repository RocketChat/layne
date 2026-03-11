/**
 * Validates the structure of a parsed repos.json object.
 *
 * Returns { valid: true } if the config is acceptable, or
 * { valid: false, errors: string[] } listing every problem found.
 *
 * This module has no dependencies and can be imported anywhere or run
 * directly via `npm run validate-config`.
 */

const KNOWN_REPO_KEYS    = new Set(['semgrep', 'trufflehog', 'claude', 'notifications', 'labels']);
const KNOWN_GLOBAL_KEYS  = new Set(['notifications', 'labels']);
const CLAUDE_MODELS      = /^claude-/;
const REPO_KEY_RE        = /^[^/]+\/[^/]+$/;

export function validateConfig(config) {
  const errors = [];

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { valid: false, errors: ['repos.json must be a JSON object'] };
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
  if (block.notifications !== undefined) validateNotifications(block.notifications, `${ctx}.notifications`, errors);
  if (block.labels       !== undefined) validateLabels(block.labels, `${ctx}.labels`, errors);
}

function validateRepo(block, ctx, errors) {
  for (const key of Object.keys(block)) {
    if (!KNOWN_REPO_KEYS.has(key)) {
      errors.push(`${ctx}: unknown key "${key}" (allowed: ${[...KNOWN_REPO_KEYS].join(', ')})`);
    }
  }
  if (block.semgrep       !== undefined) validateScanner(block.semgrep,    `${ctx}.semgrep`,    errors);
  if (block.trufflehog    !== undefined) validateScanner(block.trufflehog, `${ctx}.trufflehog`, errors);
  if (block.claude        !== undefined) validateClaude(block.claude,       `${ctx}.claude`,     errors);
  if (block.notifications !== undefined) validateNotifications(block.notifications, `${ctx}.notifications`, errors);
  if (block.labels        !== undefined) validateLabels(block.labels, `${ctx}.labels`, errors);
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

function validateLabels(block, ctx, errors) {
  if (typeof block !== 'object' || block === null) { errors.push(`${ctx}: must be an object`); return; }
  for (const key of ['onFailure', 'removeOnFailure', 'onSuccess', 'removeOnSuccess']) {
    if (block[key] === undefined) continue;
    if (!Array.isArray(block[key]))
      errors.push(`${ctx}.${key}: must be an array`);
    else if (block[key].some(l => typeof l !== 'string'))
      errors.push(`${ctx}.${key}: all items must be strings`);
  }
}
