import { execFile } from 'child_process';
import { debug } from '../debug.js';

const MAX_STDOUT_BUFFER = 200 * 1024 * 1024; // 200 MB — prevents ENOBUF on large scan outputs

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Returns output and the numeric exit code so each scanner can classify it. */
export function exec(cmd: string, args: string[], options: Record<string, unknown> = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const signal = options.signal as AbortSignal | undefined;
    try {
      throwIfAborted(signal);
    } catch (err) {
      reject(err);
      return;
    }

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
      try {
        throwIfAborted(signal);
      } catch (abortErr) {
        reject(abortErr);
        return;
      }
      const exitCode = err ? (err as NodeJS.ErrnoException).code : 0;
      if (err && typeof exitCode !== 'number') {
        reject(err);
      } else {
        resolve({
          stdout: stdoutStr ?? '',
          stderr: stderrStr ?? '',
          exitCode: typeof exitCode === 'number' ? exitCode : 0,
        });
      }
    });
  });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Scan cancelled');
}

/**
 * Strips a workspace path prefix from an absolute file path, producing a
 * path relative to the repo root as required by the GitHub Checks API.
 */
export function stripPrefix(filePath: string | undefined, workspacePath: string): string {
  const prefix = workspacePath + '/';
  return filePath?.startsWith(prefix) ? filePath.slice(prefix.length) : (filePath ?? '');
}
