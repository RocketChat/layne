import { join } from 'path';
import { exec, stripPrefix } from './helpers.js';
import { debug } from '../debug.js';
import { DEFAULT_CONFIG } from '../config.js';

/**
 * Runs Semgrep against the files changed in the PR and returns findings
 * in the common format: { file, line, severity, message, ruleId, tool }.
 *
 * changedFiles is an array of paths relative to workspacePath. Semgrep
 * receives them as absolute paths so it can locate them on disk.
 *
 * Semgrep outputs a single JSON object with a `results` array.
 * Exit code 1 means findings were found; we parse stdout rather than
 * rejecting on non-zero exit.
 */
export async function runSemgrep({ workspacePath, changedFiles, toolConfig = DEFAULT_CONFIG.semgrep }) {
  if (!changedFiles || changedFiles.length === 0) return [];
  if (!toolConfig.enabled) return [];

  debug('semgrep', `scanning ${changedFiles.length} file(s): ${changedFiles.join(', ')}`);

  const absolutePaths = changedFiles.map(f => join(workspacePath, f));
  const args = ['scan', ...(toolConfig.extraArgs ?? []), '--json', ...absolutePaths];

  const stdout = await exec('semgrep', args, { cwd: workspacePath });

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    console.error('[semgrep] Failed to parse JSON output:', stdout.slice(0, 500));
    return [];
  }

  if (parsed.errors?.length) {
    console.error(`[semgrep] ${parsed.errors.length} error(s) reported:`, JSON.stringify(parsed.errors));
  }

  const findings = (parsed.results ?? []).map(r => toFinding(r, workspacePath));
  console.log(`[semgrep] ${findings.length} finding(s):`);
  for (const f of findings) {
    console.log(`[semgrep]   ${f.severity.toUpperCase()} ${f.file}:${f.line} [${f.ruleId}] ${f.message}`);
  }
  return findings;
}

const SEVERITY_MAP = {
  ERROR:   'high',
  WARNING: 'medium',
  INFO:    'low',
};

function toFinding(result, workspacePath) {
  return {
    file:     stripPrefix(result.path, workspacePath),
    line:     result.start?.line ?? 1,
    severity: SEVERITY_MAP[result.extra?.severity] ?? 'low',
    message:  result.extra?.message ?? 'Semgrep finding',
    ruleId:   result.check_id,
    tool:     'semgrep',
  };
}
