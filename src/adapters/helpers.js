import { execFile } from 'child_process';

/**
 * Resolves with stdout regardless of exit code so callers can parse
 * findings from a non-zero exit (e.g. Semgrep exits 1, Trufflehog exits 183).
 * Rejects only when the process couldn't be spawned or produced no stdout.
 */
export function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => {
      if (err && !stdout) {
        reject(err);
      } else {
        resolve(stdout ?? '');
      }
    });
  });
}

/**
 * Strips a workspace path prefix from an absolute file path, producing a
 * path relative to the repo root as required by the GitHub Checks API.
 */
export function stripPrefix(filePath, workspacePath) {
  const prefix = workspacePath + '/';
  return filePath?.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}
