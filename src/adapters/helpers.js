import { execFile } from 'child_process';
import { debug } from '../debug.js';

/**
 * Resolves with stdout regardless of exit code so callers can parse
 * findings from a non-zero exit (e.g. Semgrep exits 1, Trufflehog exits 183).
 * Rejects only when the process couldn't be spawned or produced no stdout.
 */
export function exec(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    debug(cmd, `running: ${cmd} ${args.join(' ')}`);
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (stderr) {
        console.error(`[${cmd}] stderr: ${stderr.trim()}`);
      }
      if (err) {
        debug(cmd, `exited with code ${err.code ?? 'unknown'}${stdout ? ' (stdout present, parsing output)' : ''}`);
      }
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
