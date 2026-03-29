import { execFile } from 'child_process';
import { mkdtemp, realpath, rm, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { debug } from './debug.js';
import type { LineRangesByFile, LineRange, LineMap } from './types.js';

// Runs a git command and returns its stdout. Rejects on non-zero exit.
// Command arguments are redacted in debug output so installation tokens never appear in logs.
function git(args: string[]): Promise<string> {
  const redacted = args.map(a => a.replace(/x-access-token:[^@]+@/, 'x-access-token:[REDACTED]@'));
  debug('git', `running: git ${redacted.join(' ')}`);

  return new Promise((resolve, reject) => {
    execFile('git', args, (err, stdout, stderr) => {
      if (stderr) console.error(`[git] stderr: ${stderr.trim().replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@')}`);
      if (err) reject(err);
      else resolve(stdout ?? '');
    });
  });
}

export async function createWorkspace(jobId: string): Promise<string> {
  const safeId = jobId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = await mkdtemp(join(tmpdir(), `layne-${safeId}-`));
  debug('fetcher', `workspace created: ${path}`);
  return path;
}

export async function setupRepo({ token, cloneUrl, headSha, baseSha, workspacePath }: {
  token: string;
  cloneUrl: string;
  headSha: string;
  baseSha: string;
  workspacePath: string;
}): Promise<void> {
  const authenticatedUrl = cloneUrl.replace(
    'https://',
    `https://x-access-token:${token}@`
  );

  debug('fetcher', `setting up partial clone of ${cloneUrl} at ${headSha}`);

  await git(['init', workspacePath]);
  await git(['-C', workspacePath, 'remote', 'add', 'origin', authenticatedUrl]);

  await git(['-C', workspacePath, '-c', 'protocol.version=2', 'fetch',
    '--depth', '1', '--filter=blob:none', 'origin', headSha]);

  await git(['-C', workspacePath, '-c', 'protocol.version=2', 'fetch',
    '--depth', '1', '--filter=blob:none', 'origin', baseSha]);

  await git(['-C', workspacePath, 'sparse-checkout', 'init', '--no-cone']);

  debug('fetcher', 'repo setup complete (no blobs fetched yet)');
}

export async function getChangedFiles({ workspacePath, baseSha, headSha }: {
  workspacePath: string;
  baseSha: string;
  headSha: string;
}): Promise<string[]> {
  const stdout = await git(['-C', workspacePath, 'diff', '--name-only', '-z', baseSha, headSha]);
  const files  = stdout.split('\0').filter(Boolean);
  const safe: string[]   = [];

  for (const file of files) {
    if (file.startsWith('/') || file.split('/').includes('..')) continue;
    const candidate = resolve(workspacePath, file);
    if (!isWithinPath(candidate, workspacePath)) continue;
    safe.push(file);
  }

  if (safe.length !== files.length) {
    console.warn(`[fetcher] Dropped ${files.length - safe.length} unsafe path(s) from diff output`);
  }
  debug('fetcher', `${safe.length} changed file(s)${safe.length ? ': ' + safe.join(', ') : ''}`);
  return safe;
}

// Returns changed line ranges in the head version of each file, keyed by
// repo-root-relative path. Normalized to return Map<string, LineRange[]>.
export async function getChangedLineRanges({ workspacePath, baseSha, headSha, files = [] }: {
  workspacePath: string;
  baseSha: string;
  headSha: string;
  files?: string[];
}): Promise<LineRangesByFile> {
  const args = ['-C', workspacePath, 'diff', '--unified=0', '--no-color', '--no-ext-diff', baseSha, headSha];
  if (files.length > 0) args.push('--', ...files);
  const patch = await git(args);
  return parseChangedLineRanges(patch);
}

export async function fetchCommit({ workspacePath, sha }: {
  workspacePath: string;
  sha: string;
}): Promise<void> {
  await git(['-C', workspacePath, '-c', 'protocol.version=2', 'fetch',
    '--depth', '1', '--filter=blob:none', 'origin', sha]);
}

export async function checkoutFiles({ workspacePath, headSha, files }: {
  workspacePath: string;
  headSha: string;
  files: string[];
}): Promise<string[]> {
  if (files.length === 0) return [];

  await git(['-C', workspacePath, 'sparse-checkout', 'set', ...files]);
  await git(['-C', workspacePath, 'checkout', headSha]);

  const workspaceReal = await realpath(workspacePath);
  const validated: string[]     = [];

  for (const file of files) {
    const candidate = resolve(workspacePath, file);

    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      continue;
    }
    if (!isWithinPath(resolved, workspaceReal)) continue;

    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(candidate);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) continue;

    validated.push(file);
  }

  if (validated.length !== files.length) {
    console.warn(`[fetcher] Dropped ${files.length - validated.length} path(s) after checkout validation`);
  }
  debug('fetcher', `${validated.length} file(s) checked out`);
  return validated;
}

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
  debug('fetcher', `cleaning up workspace: ${workspacePath}`);
  await rm(workspacePath, { recursive: true, force: true });
}

function isWithinPath(targetPath: string, basePath: string): boolean {
  return targetPath === basePath || targetPath.startsWith(`${basePath}${sep}`);
}

/**
 * Builds a Map<headLine, baseLine | null> for a single file by parsing the
 * unified diff between baseSha and headSha.
 */
export async function buildLineMapForFile({ workspacePath, baseSha, headSha, filePath }: {
  workspacePath: string;
  baseSha: string;
  headSha: string;
  filePath: string;
}): Promise<LineMap> {
  const patch = await git([
    '-C', workspacePath, 'diff',
    '--unified=999999', '--no-color', '--no-ext-diff',
    baseSha, headSha, '--', filePath,
  ]);
  return parseLineMap(patch, filePath);
}

function parseLineMap(patch: string, filePath: string): LineMap {
  const map: LineMap = new Map();
  let headLine: number | null = null;
  let baseLine: number | null = null;
  let inFile = false;

  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      inFile = stripGitPathPrefix(line.slice(4).trim()) === filePath;
      continue;
    }

    if (!inFile) continue;

    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!match) continue;
      baseLine = Number.parseInt(match[1]!, 10);
      headLine = Number.parseInt(match[2]!, 10);
      continue;
    }

    if (headLine === null) continue;

    if (line.startsWith(' ')) {
      map.set(headLine, baseLine);
      headLine++;
      if (baseLine !== null) baseLine++;
    } else if (line.startsWith('+')) {
      map.set(headLine, null);
      headLine++;
    } else if (line.startsWith('-')) {
      if (baseLine !== null) baseLine++;
    }
  }

  return map;
}

function parseChangedLineRanges(patch: string): LineRangesByFile {
  const rangesByFile = new Map<string, LineRange[]>();
  let currentFile: string | null = null;

  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      currentFile = path === '/dev/null' ? null : stripGitPathPrefix(path);
      if (currentFile && !rangesByFile.has(currentFile)) {
        rangesByFile.set(currentFile, []);
      }
      continue;
    }

    if (!currentFile || !line.startsWith('@@')) continue;

    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;

    const start = Number.parseInt(match[1]!, 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (!Number.isInteger(start) || !Number.isInteger(count) || count <= 0) continue;

    rangesByFile.get(currentFile)!.push({ start, end: start + count - 1 });
  }

  return rangesByFile;
}

function stripGitPathPrefix(path: string): string {
  return path.startsWith('b/') ? path.slice(2) : path;
}
