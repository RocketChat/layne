import { join } from 'path';
import { exec, stripPrefix } from './helpers.js';

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

export async function runTrufflehog({ workspacePath, changedFiles }) {
  if (!changedFiles || changedFiles.length === 0) return [];

  const absolutePaths = changedFiles.map(f => join(workspacePath, f));
  const findings = [];

  for (let i = 0; i < absolutePaths.length; i += BATCH_SIZE) {
    const batch = absolutePaths.slice(i, i + BATCH_SIZE);
    const stdout = await exec('trufflehog', ['filesystem', '--json', '--no-update', ...batch]);

    stdout
      .split('\n')
      .filter(Boolean)
      .forEach(line => {
        try {
          findings.push(toFinding(JSON.parse(line), workspacePath));
        } catch {
          // malformed line — skip
        }
      });
  }

  return findings;
}

function toFinding(result, workspacePath) {
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
