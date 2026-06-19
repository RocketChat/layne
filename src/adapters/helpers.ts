import { execFile } from 'child_process';
import { debug } from '../debug.js';

const MAX_STDOUT_BUFFER = 200 * 1024 * 1024; // 200 MB — prevents ENOBUF on large scan outputs

/**
 * Resolves with stdout regardless of exit code so callers can parse
 * findings from a non-zero exit (e.g. Semgrep exits 1, Trufflehog exits 183).
 * Rejects only when the process couldn't be spawned or produced no stdout.
 */
export function exec(cmd: string, args: string[], options: Record<string, unknown> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    debug(cmd, `running: ${cmd} ${args.join(' ')}`);
    execFile(cmd, args, { maxBuffer: MAX_STDOUT_BUFFER, ...options, encoding: 'utf8' } as Parameters<typeof execFile>[2], (err, stdout, stderr) => {
      const stdoutStr = stdout as string;
      const stderrStr = stderr as string;
      if (stderrStr) {
        console.error(`[${cmd}] stderr: ${stderrStr.trim()}`);
      }
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        debug(cmd, `exited with code ${code ?? 'unknown'}${stdoutStr ? ' (stdout present, parsing output)' : ''}`);
      }
      if (err && !stdoutStr) {
        reject(err);
      } else {
        resolve(stdoutStr ?? '');
      }
    });
  });
}

/**
 * Strips a workspace path prefix from an absolute file path, producing a
 * path relative to the repo root as required by the GitHub Checks API.
 */
export function stripPrefix(filePath: string | undefined, workspacePath: string): string {
  const prefix = workspacePath + '/';
  return filePath?.startsWith(prefix) ? filePath.slice(prefix.length) : (filePath ?? '');
}
