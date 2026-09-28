import { join } from 'path';
import { exec, stripPrefix, throwIfAborted } from './helpers.js';
import { debug } from '../debug.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { AdapterResult, AdapterStatus, SemgrepConfig, SemgrepFinding, Severity } from '../types.js';

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
export async function runSemgrep({
  workspacePath,
  changedFiles,
  toolConfig = DEFAULT_CONFIG.semgrep,
  signal,
}: {
  workspacePath: string;
  changedFiles?: string[] | null;
  toolConfig?: SemgrepConfig;
  signal?: AbortSignal;
}): Promise<AdapterResult<SemgrepFinding>> {
  throwIfAborted(signal);
  if (!toolConfig.enabled) return { findings: [], status: { outcome: 'disabled' } };
  if (!changedFiles || changedFiles.length === 0) return { findings: [], status: { outcome: 'complete' } };

  debug('semgrep', `scanning ${changedFiles.length} file(s): ${changedFiles.join(', ')}`);

  const absolutePaths = changedFiles.map(f => join(workspacePath, f));
  const args = ['scan', ...(toolConfig.extraArgs ?? []), '--json', '--', ...absolutePaths];

  let command;
  try {
    command = await exec('semgrep', args, { cwd: workspacePath, signal });
  } catch (err) {
    throwIfAborted(signal);
    console.error('[semgrep] Failed to run scanner:', (err as Error).message);
    return { findings: [], status: incompleteCommandStatus(err) };
  }
  throwIfAborted(signal);

  const status: AdapterStatus = command.exitCode === 0 || command.exitCode === 1
    ? { outcome: 'complete' }
    : { outcome: 'incomplete', reason: 'unexpected-exit' };

  let parsed: { results?: SemgrepRawResult[]; errors?: unknown[] };
  try {
    // JSON.parse result typed as semgrep output shape
    parsed = JSON.parse(command.stdout) as { results?: SemgrepRawResult[]; errors?: unknown[] };
  } catch {
    console.error('[semgrep] Failed to parse JSON output:', command.stdout.slice(0, 500));
    return { findings: [], status: { outcome: 'incomplete', reason: 'invalid-output' } };
  }

  if (parsed.errors?.length) {
    console.error(`[semgrep] ${parsed.errors.length} error(s) reported:`, JSON.stringify(parsed.errors));
    status.outcome = 'incomplete';
    status.reason = 'scanner-errors-reported';
  }

  const findings = (parsed.results ?? []).map(r => toFinding(r, workspacePath));
  console.log(`[semgrep] ${findings.length} finding(s):`);
  for (const f of findings) {
    console.log(`[semgrep]   ${f.severity.toUpperCase()} ${f.file}:${f.line} [${f.ruleId}] ${f.message}`);
  }
  return { findings, status };
}

function incompleteCommandStatus(err: unknown): AdapterStatus {
  return {
    outcome: 'incomplete',
    reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'tool-unavailable' : 'command-failed',
  };
}

interface SemgrepRawResult {
  check_id: string;
  path: string;
  start?: { line: number };
  end?: { line: number };
  extra?: { severity?: string; message?: string };
}

const SEVERITY_MAP: Record<string, Severity> = {
  ERROR:   'high',
  WARNING: 'medium',
  INFO:    'low',
};

function toFinding(result: SemgrepRawResult, workspacePath: string): SemgrepFinding {
  const startLine = result.start?.line ?? 1;
  const endLine   = result.end?.line ?? startLine;
  return {
    file:      stripPrefix(result.path, workspacePath),
    line:      startLine,
    startLine,
    endLine,
    severity:  SEVERITY_MAP[result.extra?.severity ?? ''] ?? 'low',
    message:   result.extra?.message ?? 'Semgrep finding',
    ruleId:    result.check_id,
    tool:      'semgrep',
  };
}
