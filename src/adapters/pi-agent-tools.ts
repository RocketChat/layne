import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { glob as globFn } from 'tinyglobby';
import {
  createReadTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  type ReadOperations,
  type GrepOperations,
  type FindOperations,
  type LsOperations,
} from '@mariozechner/pi-coding-agent';

/**
 * Resolves `absolutePath` and throws if it escapes `workspacePath`.
 * Returns the normalized absolute path on success.
 *
 * Note: grep's main ripgrep spawn resolves paths via the upstream resolveToCwd()
 * and is not interceptable through the GrepOperations interface. The confined
 * GrepOperations below guard auxiliary reads only (context lines, isDirectory
 * checks). Grep therefore carries a residual risk of line-level content leakage
 * from outside the workspace if the model is injected with an absolute path.
 * read, find, and ls are fully confined.
 */
function confinePath(absolutePath: string, workspacePath: string): string {
  const resolved  = path.resolve(absolutePath);
  const workspace = path.resolve(workspacePath);
  const prefix    = workspace.endsWith(path.sep) ? workspace : workspace + path.sep;

  if (resolved !== workspace && !resolved.startsWith(prefix)) {
    throw new Error(`[pi-agent] access denied: ${absolutePath} is outside the workspace`);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Git helpers for lazy blob fetching
// ---------------------------------------------------------------------------

/**
 * Returns the git object type ('blob', 'tree', etc.) for the given path at sha.
 * Tree objects are always available after setupRepo (--filter=blob:none fetches
 * everything except blobs), so this is cheap and does not trigger a network fetch.
 * Rejects if the path does not exist at that commit.
 */
function gitObjectType(workspacePath: string, sha: string, relativePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', workspacePath, 'cat-file', '-t', `${sha}:${relativePath}`], (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Fetches the blob content for the given path at sha via `git show` and writes
 * it to disk so subsequent grep/find/ls calls can also see the file.
 * Returns the file content as a Buffer.
 */
function gitShow(workspacePath: string, sha: string, relativePath: string, absolutePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', workspacePath, 'show', `${sha}:${relativePath}`],
      { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 },
      async (err, stdout) => {
        if (err) { reject(err); return; }
        const content = stdout as unknown as Buffer;
        try {
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, content);
        } catch {
          // Materialization failure is non-fatal — return content in memory
        }
        resolve(content);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Confined operations
// ---------------------------------------------------------------------------

function confinedReadOperations(
  workspacePath: string,
  options?: { headSha?: string; followImports?: boolean },
): ReadOperations {
  const { headSha, followImports = false } = options ?? {};

  return {
    readFile: async (absolutePath: string) => {
      const safe = confinePath(absolutePath, workspacePath);
      try {
        return await fs.readFile(safe);
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (!followImports || !headSha || nodeErr.code !== 'ENOENT') throw err;
        const relative = path.relative(workspacePath, safe);
        try {
          return await gitShow(workspacePath, headSha, relative, safe);
        } catch {
          throw err; // re-throw original ENOENT — file doesn't exist in repo
        }
      }
    },
    access: async (absolutePath: string) => {
      const safe = confinePath(absolutePath, workspacePath);
      try {
        return await fs.access(safe);
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (!followImports || !headSha || nodeErr.code !== 'ENOENT') throw err;
        const relative = path.relative(workspacePath, safe);
        let type: string;
        try {
          type = await gitObjectType(workspacePath, headSha, relative);
        } catch {
          throw err; // path doesn't exist in git either
        }
        if (type !== 'blob') throw err; // directories are not lazily materialized
        // File exists in git as a blob — readFile will fetch it on demand
      }
    },
  };
}

function confinedGrepOperations(workspacePath: string): GrepOperations {
  return {
    isDirectory: async (absolutePath: string) => {
      const safe = confinePath(absolutePath, workspacePath);
      const stat = await fs.stat(safe);
      return stat.isDirectory();
    },
    readFile: async (absolutePath: string) => {
      const safe = confinePath(absolutePath, workspacePath);
      return fs.readFile(safe, 'utf8');
    },
  };
}

function confinedFindOperations(workspacePath: string): FindOperations {
  const workspace = path.resolve(workspacePath);
  return {
    exists: async (absolutePath: string) => {
      const safe = confinePath(absolutePath, workspacePath);
      return fs.access(safe).then(() => true).catch(() => false);
    },
    glob: async (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => {
      // Confine cwd before running the glob
      const safeCwd = confinePath(cwd, workspacePath);
      const results = await globFn(pattern, {
        cwd: safeCwd,
        ignore: options.ignore,
        absolute: true,
      });
      // Filter results to workspace just in case glob follows symlinks outside
      return results
        .filter((p: string) => {
          const resolved = path.resolve(p);
          const prefix   = workspace.endsWith(path.sep) ? workspace : workspace + path.sep;
          return resolved === workspace || resolved.startsWith(prefix);
        })
        .slice(0, options.limit);
    },
  };
}

function confinedLsOperations(workspacePath: string): LsOperations {
  return {
    exists: async (absolutePath: string) => {
      const safe = confinePath(absolutePath, workspacePath);
      return fs.access(safe).then(() => true).catch(() => false);
    },
    stat: async (absolutePath: string) => {
      const safe = confinePath(absolutePath, workspacePath);
      return fs.stat(safe);
    },
    readdir: async (absolutePath: string) => {
      const safe = confinePath(absolutePath, workspacePath);
      return fs.readdir(safe);
    },
  };
}

/**
 * Creates read-only file tools (read, grep, find, ls) confined to workspacePath.
 * Replaces createReadOnlyTools() from @mariozechner/pi-coding-agent, which allows
 * absolute paths to escape the workspace boundary.
 *
 * When options.followImports is true (default in PiAgentConfig) and options.headSha
 * is provided, the read tool will lazily fetch files from git on ENOENT so the agent
 * can follow imports beyond the sparse-checked-out changed files.
 */
export function createConfinedTools(
  workspacePath: string,
  options?: { headSha?: string; followImports?: boolean },
) {
  return [
    createReadTool(workspacePath, { operations: confinedReadOperations(workspacePath, options) }),
    createGrepTool(workspacePath, { operations: confinedGrepOperations(workspacePath) }),
    createFindTool(workspacePath, { operations: confinedFindOperations(workspacePath) }),
    createLsTool(workspacePath,  { operations: confinedLsOperations(workspacePath) }),
  ];
}
