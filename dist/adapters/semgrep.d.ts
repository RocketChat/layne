import type { SemgrepConfig, SemgrepFinding } from '../types.js';
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
export declare function runSemgrep({ workspacePath, changedFiles, toolConfig, }: {
    workspacePath: string;
    changedFiles?: string[] | null;
    toolConfig?: SemgrepConfig;
}): Promise<SemgrepFinding[]>;
//# sourceMappingURL=semgrep.d.ts.map