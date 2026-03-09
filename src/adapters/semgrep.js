import { exec, stripPrefix } from './helpers.js';

/**
 * Runs Semgrep against the workspace directory and returns findings
 * in the common format: { file, line, severity, message, ruleId, tool }.
 *
 * When a baseline ref is provided (always 'FETCH_HEAD' in normal operation),
 * Semgrep compares the current state against that commit and only reports
 * findings that are new — i.e. not present on the base branch.
 *
 * Semgrep outputs a single JSON object with a `results` array.
 * Exit code 1 means findings were found; we parse stdout rather than
 * rejecting on non-zero exit.
 */
export async function runSemgrep({ workspacePath, baseline }) {
  const args = ['scan', '--config', 'auto', '--json'];
  if (baseline) args.push('--baseline-commit', baseline);
  args.push(workspacePath);

  const stdout = await exec('semgrep', args);

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  return (parsed.results ?? []).map(r => toFinding(r, workspacePath));
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
