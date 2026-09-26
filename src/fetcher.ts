import { execFile } from 'child_process';
import { lstat, mkdtemp, realpath, rm } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { debug } from './debug.js';
import { parseUnifiedDiff } from './unified-diff.js';
import type { GitChange, GitChangeStatus, GitObjectKind, LineRangesByFile, LineRange, LineMap, PreparedGitChanges, UnifiedDiff } from './types.js';

// Runs a git command and returns its stdout. Rejects on non-zero exit.
// Command arguments are redacted in debug output so installation tokens never appear in logs.
function git(args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const redacted = args.map(a => a.replace(/x-access-token:[^@]+@/, 'x-access-token:[REDACTED]@'));
  debug('git', `running: git ${redacted.join(' ')}`);

  return new Promise((resolve, reject) => {
    execFile('git', args, {
      maxBuffer: 200 * 1024 * 1024,
      ...(signal && { signal }),
    }, (err, stdout, stderr) => {
      if (stderr) console.error(`[git] stderr: ${stderr.trim().replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@')}`);
      if (signal?.aborted) reject(signal.reason);
      else if (err) reject(err);
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

export async function setupRepo({ token, cloneUrl, headSha, baseSha, workspacePath, signal }: {
  token: string;
  cloneUrl: string;
  headSha: string;
  baseSha: string;
  workspacePath: string;
  signal?: AbortSignal;
}): Promise<void> {
  signal?.throwIfAborted();

  let parsedCloneUrl: URL;
  try {
    parsedCloneUrl = new URL(cloneUrl);
  } catch {
    throw new Error('Refusing to authenticate invalid GitHub clone URL');
  }

  if (
    parsedCloneUrl.protocol !== 'https:'
    || parsedCloneUrl.hostname !== 'github.com'
    || parsedCloneUrl.port !== ''
    || parsedCloneUrl.username !== ''
    || parsedCloneUrl.password !== ''
    || parsedCloneUrl.search !== ''
    || parsedCloneUrl.hash !== ''
  ) {
    throw new Error('Refusing to authenticate non-GitHub clone URL');
  }

  debug('fetcher', `setting up partial clone of ${parsedCloneUrl.href} at ${headSha}`);
  parsedCloneUrl.username = 'x-access-token';
  parsedCloneUrl.password = token;
  const authenticatedUrl = parsedCloneUrl.href;

  await git(['init', workspacePath], signal);
  await git(['-C', workspacePath, 'remote', 'add', 'origin', authenticatedUrl], signal);

  await git(['-C', workspacePath, '-c', 'protocol.version=2', 'fetch',
    '--depth', '1', '--filter=blob:none', 'origin', headSha], signal);

  await git(['-C', workspacePath, '-c', 'protocol.version=2', 'fetch',
    '--depth', '1', '--filter=blob:none', 'origin', baseSha], signal);

  await git(['-C', workspacePath, 'sparse-checkout', 'init', '--no-cone'], signal);

  debug('fetcher', 'repo setup complete (no blobs fetched yet)');
}

export async function getChangedFiles({ workspacePath, baseSha, headSha, signal }: {
  workspacePath: string;
  baseSha: string;
  headSha: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const stdout = await git(['-C', workspacePath, 'diff', '--name-only', '-z', baseSha, headSha], signal);
  const files  = stdout.split('\0').filter(Boolean);
  const safe: string[]   = [];

  for (const file of files) {
    signal?.throwIfAborted();
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

function gitObjectKind(mode: string): GitObjectKind {
  if (mode === '000000') return 'absent';
  if (mode.startsWith('100')) return 'regular';
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'submodule';
  return 'other';
}

function assertSafeGitPath(workspacePath: string, path: string): void {
  if (!path || path.startsWith('/') || path.split('/').includes('..') || !isWithinPath(resolve(workspacePath, path), workspacePath)) {
    throw new Error(`Unsafe path in git diff: ${JSON.stringify(path)}`);
  }
}

export async function getGitChanges({ workspacePath, baseSha, headSha, signal }: {
  workspacePath: string;
  baseSha: string;
  headSha: string;
  signal?: AbortSignal;
}): Promise<GitChange[]> {
  const stdout = await git(['-C', workspacePath, 'diff', '--raw', '-z', '--no-abbrev', '--find-renames', baseSha, headSha], signal);
  const tokens = stdout.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const changes: GitChange[] = [];

  for (let i = 0; i < tokens.length;) {
    signal?.throwIfAborted();
    const header = tokens[i++];
    const match = header?.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMTRC])(\d{1,3})?$/i);
    if (!match) throw new Error(`Malformed git raw diff record: ${JSON.stringify(header)}`);
    const [, oldMode, newMode, oldOid, newOid, code, score] = match;
    const firstPath = tokens[i++];
    if (firstPath === undefined) throw new Error('Malformed git raw diff: missing path');
    assertSafeGitPath(workspacePath, firstPath);
    const secondPath = code === 'R' || code === 'C' ? tokens[i++] : undefined;
    if ((code === 'R' || code === 'C') && secondPath === undefined) throw new Error('Malformed git raw diff: missing destination path');
    if (secondPath !== undefined) assertSafeGitPath(workspacePath, secondPath);

    const statusByCode: Record<string, GitChangeStatus> = {
      A: 'added', D: 'deleted', M: 'modified', T: 'type_changed', R: 'renamed', C: 'copied',
    };
    changes.push({
      status: statusByCode[code!]!,
      oldPath: code === 'A' ? null : firstPath,
      newPath: code === 'D' ? null : (secondPath ?? firstPath),
      oldMode: oldMode!,
      newMode: newMode!,
      oldOid: oldOid!,
      newOid: newOid!,
      oldKind: gitObjectKind(oldMode!),
      newKind: gitObjectKind(newMode!),
      ...(score === undefined ? {} : { similarity: Number.parseInt(score, 10) }),
    });
  }

  return changes;
}

// Returns changed line ranges in the head version of each file, keyed by
// repo-root-relative path. Normalized to return Map<string, LineRange[]>.
export async function getChangedLineRanges({ workspacePath, baseSha, headSha, files = [], signal }: {
  workspacePath: string;
  baseSha: string;
  headSha: string;
  files?: string[];
  signal?: AbortSignal;
}): Promise<LineRangesByFile> {
  const args = ['-C', workspacePath, 'diff', '--unified=0', '--no-color', '--no-ext-diff', baseSha, headSha];
  if (files.length > 0) args.push('--', ...files);
  const patch = await git(args, signal);
  return parseChangedLineRanges(patch);
}

export async function getUnifiedDiff({ workspacePath, baseSha, headSha, contextLines, files, changes, signal }: {
  workspacePath: string;
  baseSha: string;
  headSha: string;
  contextLines: number;
  files: string[];
  changes: GitChange[];
  signal?: AbortSignal;
}): Promise<UnifiedDiff> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(contextLines) || contextLines < 0) {
    throw new Error(`Invalid unified diff context: ${JSON.stringify(contextLines)}`);
  }
  if (files.length === 0) return { files: [] };

  const selectedChanges: GitChange[] = [];
  const selected = new Set<GitChange>();
  for (const file of files) {
    signal?.throwIfAborted();
    assertSafeGitPath(workspacePath, file);
    const matches = changes.filter(change => change.newPath === file || (change.newPath === null && change.oldPath === file));
    if (matches.length !== 1 || selected.has(matches[0]!)) {
      throw new Error(`Prepared file does not map to exactly one Git change: ${JSON.stringify(file)}`);
    }
    selected.add(matches[0]!);
    selectedChanges.push(matches[0]!);
  }

  const pathspecs = [...new Set(selectedChanges.flatMap(change =>
    [change.oldPath, change.newPath].filter((path): path is string => path !== null)
  ))];
  const patch = await git([
    '-C', workspacePath, 'diff', '--patch', `--unified=${contextLines}`, '--no-color', '--no-ext-diff', '--find-renames',
    baseSha, headSha, '--', ...pathspecs,
  ], signal);
  return parseUnifiedDiff(patch, selectedChanges);
}

export async function fetchCommit({ workspacePath, sha, signal }: {
  workspacePath: string;
  sha: string;
  signal?: AbortSignal;
}): Promise<void> {
  await git(['-C', workspacePath, '-c', 'protocol.version=2', 'fetch',
    '--depth', '1', '--filter=blob:none', 'origin', sha], signal);
}

export async function checkoutFiles({ workspacePath, headSha, files, signal }: {
  workspacePath: string;
  headSha: string;
  files: string[];
  signal?: AbortSignal;
}): Promise<string[]> {
  signal?.throwIfAborted();
  if (files.length === 0) return [];

  await git(['-C', workspacePath, 'sparse-checkout', 'set', ...files], signal);
  await git(['-C', workspacePath, 'checkout', headSha], signal);

  const workspaceReal = await realpath(workspacePath);
  signal?.throwIfAborted();
  const validated: string[]     = [];

  for (const file of files) {
    signal?.throwIfAborted();
    const candidate = resolve(workspacePath, file);

    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      continue;
    }
    if (!isWithinPath(resolved, workspaceReal)) continue;

    let fileStat: Awaited<ReturnType<typeof lstat>>;
    try {
      fileStat = await lstat(candidate);
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

export async function checkoutGitChanges({ workspacePath, headSha, changes, signal }: {
  workspacePath: string;
  headSha: string;
  changes: GitChange[];
  signal?: AbortSignal;
}): Promise<PreparedGitChanges> {
  signal?.throwIfAborted();
  const issues: PreparedGitChanges['issues'] = [];
  const regularChanges = changes.filter(change => {
    if (change.newKind === 'absent') {
      issues.push({ change, disposition: 'not_applicable', reason: 'deleted' });
      return false;
    }
    if (change.newKind !== 'regular') {
      const reason = change.newKind === 'symlink' ? 'head-symlink'
        : change.newKind === 'submodule' ? 'head-submodule'
        : 'head-other';
      issues.push({ change, disposition: 'unsupported', reason });
      return false;
    }
    return change.newPath !== null;
  });
  const requested = regularChanges.map(change => change.newPath!);
  const files = await checkoutFiles({ workspacePath, headSha, files: requested, signal });
  const prepared = new Set(files);
  for (const change of regularChanges) {
    if (!prepared.has(change.newPath!)) {
      issues.push({ change, disposition: 'unavailable', reason: 'checkout-unavailable' });
    }
  }
  return { changes, files, issues };
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
export async function buildLineMapForFile({ workspacePath, baseSha, headSha, filePath, signal }: {
  workspacePath: string;
  baseSha: string;
  headSha: string;
  filePath: string;
  signal?: AbortSignal;
}): Promise<LineMap> {
  const patch = await git([
    '-C', workspacePath, 'diff',
    '--unified=999999', '--no-color', '--no-ext-diff',
    baseSha, headSha, '--', filePath,
  ], signal);
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
