/**
 * Resolves with stdout regardless of exit code so callers can parse
 * findings from a non-zero exit (e.g. Semgrep exits 1, Trufflehog exits 183).
 * Rejects only when the process couldn't be spawned or produced no stdout.
 */
export declare function exec(cmd: string, args: string[], options?: Record<string, unknown>): Promise<string>;
/**
 * Strips a workspace path prefix from an absolute file path, producing a
 * path relative to the repo root as required by the GitHub Checks API.
 */
export declare function stripPrefix(filePath: string | undefined, workspacePath: string): string;
//# sourceMappingURL=helpers.d.ts.map