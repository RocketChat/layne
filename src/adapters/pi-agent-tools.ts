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

function confinedReadOperations(workspacePath: string): ReadOperations {
  return {
    readFile: async (absolutePath: string) => {
      const safe = confinePath(absolutePath, workspacePath);
      return fs.readFile(safe);
    },
    access: async (absolutePath: string) => {
      const safe = confinePath(absolutePath, workspacePath);
      return fs.access(safe);
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
 */
export function createConfinedTools(workspacePath: string) {
  return [
    createReadTool(workspacePath, { operations: confinedReadOperations(workspacePath) }),
    createGrepTool(workspacePath, { operations: confinedGrepOperations(workspacePath) }),
    createFindTool(workspacePath, { operations: confinedFindOperations(workspacePath) }),
    createLsTool(workspacePath,  { operations: confinedLsOperations(workspacePath) }),
  ];
}
