import { execFile } from 'child_process';
import { mkdtemp, realpath, rm, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { debug } from './debug.js';

// Runs a git command and returns its stdout. Rejects on non-zero exit.
// Command arguments are redacted in debug output so installation tokens never appear in logs.
function git(args) {
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

export async function createWorkspace(jobId) {
  const safeId = jobId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = await mkdtemp(join(tmpdir(), `layne-${safeId}-`));
  debug('fetcher', `workspace created: ${path}`);
  return path;
}

// Sets up a partial clone of the repository. Fetches both the head and base commits
// using --filter=blob:none so only tree and commit objects are downloaded — no file
// blobs yet. Sparse checkout is armed but no files are written to disk until
// checkoutFiles() is called.
//
// This replaces the old cloneRepo + fetchBase pair. The new call order in worker.js is:
//   setupRepo → getChangedFiles → checkoutFiles
//
// We clone by SHA rather than branch name to avoid a race condition: if a new commit
// is pushed between webhook delivery and the actual clone, fetching by branch would
// scan the wrong commit and misalign annotations.
// The installation token is injected into the HTTPS URL — it is never written to disk.
export async function setupRepo({ token, cloneUrl, headSha, baseSha, workspacePath }) {
  const authenticatedUrl = cloneUrl.replace(
    'https://',
    `https://x-access-token:${token}@`
  );

  debug('fetcher', `setting up partial clone of ${cloneUrl} at ${headSha}`);

  await git(['init', workspacePath]);
  await git(['-C', workspacePath, 'remote', 'add', 'origin', authenticatedUrl]);

  // Fetch the head commit — trees and commits only, no blobs.
  // protocol.version=2 is required for --filter to be accepted by the server.
  await git(['-C', workspacePath, '-c', 'protocol.version=2', 'fetch',
    '--depth', '1', '--filter=blob:none', 'origin', headSha]);

  // Fetch the base commit for diff — also blobless.
  await git(['-C', workspacePath, '-c', 'protocol.version=2', 'fetch',
    '--depth', '1', '--filter=blob:none', 'origin', baseSha]);

  // Arm sparse checkout in no-cone mode (exact file paths, not directory prefixes).
  // Blobs for the selected files are fetched lazily when checkoutFiles() runs.
  await git(['-C', workspacePath, 'sparse-checkout', 'init', '--no-cone']);

  debug('fetcher', 'repo setup complete (no blobs fetched yet)');
}

// Diffs the two commits using their tree objects and returns the list of changed files.
// Must be called after setupRepo() and before checkoutFiles() — files are not on disk yet.
// String-only path validation is applied here; the stat/realpath validation (symlink escape
// detection) is deferred to checkoutFiles() once the files are materialised on disk.
export async function getChangedFiles({ workspacePath, baseSha, headSha }) {
  // -z uses NUL as the record separator so filenames with spaces are handled correctly.
  const stdout = await git(['-C', workspacePath, 'diff', '--name-only', '-z', baseSha, headSha]);
  const files  = stdout.split('\0').filter(Boolean);
  const safe   = [];

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
// repo-root-relative path. This lets downstream annotation code distinguish
// "valid location in the file" from "valid location in the PR diff".
export async function getChangedLineRanges({ workspacePath, baseSha, headSha }) {
  const patch = await git(['-C', workspacePath, 'diff', '--unified=0', '--no-color', '--no-ext-diff', baseSha, headSha]);
  return parseChangedLineRanges(patch);
}

// Materialises only the changed files on disk. git sparse-checkout restricts the working
// tree to the listed paths, then checkout fetches the blobs for exactly those files.
// Post-checkout realpath and stat validation is applied to catch symlink escapes and
// non-regular files before the list is handed to the scanners.
export async function checkoutFiles({ workspacePath, headSha, files }) {
  if (files.length === 0) return [];

  // Set the sparse checkout list, then checkout — this is where blobs are fetched.
  await git(['-C', workspacePath, 'sparse-checkout', 'set', ...files]);
  await git(['-C', workspacePath, 'checkout', headSha]);

  // Post-checkout validation: symlink escape detection and regular-file check.
  const workspaceReal = await realpath(workspacePath);
  const validated     = [];

  for (const file of files) {
    const candidate = resolve(workspacePath, file);

    let resolved;
    try {
      resolved = await realpath(candidate);
    } catch {
      continue; // broken symlink or file absent despite sparse checkout
    }
    if (!isWithinPath(resolved, workspaceReal)) continue;

    let fileStat;
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

export async function cleanupWorkspace(workspacePath) {
  debug('fetcher', `cleaning up workspace: ${workspacePath}`);
  await rm(workspacePath, { recursive: true, force: true });
}

function isWithinPath(targetPath, basePath) {
  return targetPath === basePath || targetPath.startsWith(`${basePath}${sep}`);
}

/**
 * Builds a Map<headLine, baseLine | null> for a single file by parsing the
 * unified diff between baseSha and headSha.
 *
 * - Context lines ( ): headLine → baseLine (unchanged, possibly shifted)
 * - Added lines (+):   headLine → null     (new in this PR, no base equivalent)
 * - Removed lines (-): no head entry       (gone from head, base line consumed)
 *
 * --unified=999999 ensures every unchanged line appears as a context line so
 * the map covers the entire head file, not just changed regions.
 */
export async function buildLineMapForFile({ workspacePath, baseSha, headSha, filePath }) {
  const patch = await git([
    '-C', workspacePath, 'diff',
    '--unified=999999', '--no-color', '--no-ext-diff',
    baseSha, headSha, '--', filePath,
  ]);
  return parseLineMap(patch, filePath);
}

function parseLineMap(patch, filePath) {
  const map = new Map();
  let headLine = null;
  let baseLine = null;
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
      baseLine = Number.parseInt(match[1], 10);
      headLine = Number.parseInt(match[2], 10);
      continue;
    }

    if (headLine === null) continue;

    if (line.startsWith(' ')) {
      map.set(headLine, baseLine);
      headLine++;
      baseLine++;
    } else if (line.startsWith('+')) {
      map.set(headLine, null);
      headLine++;
    } else if (line.startsWith('-')) {
      baseLine++;
    }
  }

  return map;
}

function parseChangedLineRanges(patch) {
  const rangesByFile = {};
  let currentFile = null;

  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      currentFile = path === '/dev/null' ? null : stripGitPathPrefix(path);
      if (currentFile && !rangesByFile[currentFile]) {
        rangesByFile[currentFile] = [];
      }
      continue;
    }

    if (!currentFile || !line.startsWith('@@')) continue;

    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;

    const start = Number.parseInt(match[1], 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (!Number.isInteger(start) || !Number.isInteger(count) || count <= 0) continue;

    rangesByFile[currentFile].push({ start, end: start + count - 1 });
  }

  return rangesByFile;
}

function stripGitPathPrefix(path) {
  return path.startsWith('b/') ? path.slice(2) : path;
}
