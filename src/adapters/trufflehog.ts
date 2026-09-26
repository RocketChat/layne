import { join } from 'path';
import { exec, stripPrefix, throwIfAborted } from './helpers.js';
import { debug } from '../debug.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { AdapterResult, AdapterStatus, TrufflehogConfig, TrufflehogFinding } from '../types.js';

/**
 * Runs Trufflehog against the files changed in the PR and returns findings
 * in the common format: { file, line, severity, message, ruleId, tool }.
 *
 * changedFiles is an array of paths relative to workspacePath. Trufflehog
 * receives them as absolute paths so it can locate them on disk.
 *
 * Trufflehog outputs newline-delimited JSON — one result object per line.
 * Exit code 183 means secrets were found; we treat that as success and parse
 * stdout rather than rejecting.
 */
// Keep batches well under the OS ARG_MAX limit. A PR changing more than
// BATCH_SIZE files is uncommon but valid in monorepos.
const BATCH_SIZE = 200;

export async function runTrufflehog({
  workspacePath,
  changedFiles,
  toolConfig = DEFAULT_CONFIG.trufflehog,
  signal,
}: {
  workspacePath: string;
  changedFiles?: string[] | null;
  toolConfig?: TrufflehogConfig;
  signal?: AbortSignal;
}): Promise<AdapterResult<TrufflehogFinding>> {
  throwIfAborted(signal);
  if (!toolConfig.enabled) return { findings: [], status: { outcome: 'disabled' } };
  if (!changedFiles || changedFiles.length === 0) return { findings: [], status: { outcome: 'complete' } };

  const absolutePaths = changedFiles.map(f => join(workspacePath, f));
  const findings: TrufflehogFinding[] = [];
  const batchCount = Math.ceil(absolutePaths.length / BATCH_SIZE);
  const extraArgs = toolConfig.extraArgs ?? [];
  const status: AdapterStatus = { outcome: 'complete' };

  debug('trufflehog', `scanning ${changedFiles.length} file(s) in ${batchCount} batch(es)`);

  for (let i = 0; i < absolutePaths.length; i += BATCH_SIZE) {
    throwIfAborted(signal);
    const batch = absolutePaths.slice(i, i + BATCH_SIZE);
    const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
    debug('trufflehog', `batch ${batchIndex}/${batchCount}: ${batch.length} file(s)`);
    let command;
    try {
      command = await exec('trufflehog', ['filesystem', '--json', '--no-update', ...extraArgs, '--', ...batch], { signal });
    } catch (err) {
      throwIfAborted(signal);
      console.error(`[trufflehog] batch ${batchIndex}/${batchCount} failed:`, (err as Error).message);
      status.outcome = 'incomplete';
      status.reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'tool-unavailable' : 'command-failed';
      break;
    }
    throwIfAborted(signal);

    if (command.exitCode !== 0 && command.exitCode !== 183) {
      status.outcome = 'incomplete';
      status.reason ??= 'unexpected-exit';
    }

    command.stdout
      .split('\n')
      .filter(Boolean)
      .forEach(line => {
        try {
          findings.push(toFinding(JSON.parse(line) as TrufflehogRawResult, workspacePath));
        } catch {
          status.outcome = 'incomplete';
          status.reason ??= 'invalid-output';
        }
      });
  }

  return { findings, status };
}

interface TrufflehogRawResult {
  SourceMetadata?: { Data?: { Filesystem?: { file?: string; line?: number } } };
  DetectorName?: string;
}

function toFinding(result: TrufflehogRawResult, workspacePath: string): TrufflehogFinding {
  const fs = result.SourceMetadata?.Data?.Filesystem ?? {};
  const detector = result.DetectorName ?? 'unknown';
  const rawFile = fs.file ?? 'unknown';
  return {
    file:     stripPrefix(rawFile, workspacePath),
    line:     fs.line ?? 1,
    severity: 'high',
    message:  `${detector} secret detected`,
    ruleId:   `trufflehog/${detector.toLowerCase()}`,
    tool:     'trufflehog',
  };
}
