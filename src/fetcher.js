import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { debug } from './debug.js';

// Runs a git command and returns its stdout. Rejects on non-zero exit.
// Command arguments are redacted in debug output so installation tokens never appear in logs.
function git(args) {
  const redacted = args.map(a => a.replace(/x-access-token:[^@]+@/, 'x-access-token:[REDACTED]@'));
  debug('git', `running: git ${redacted.join(' ')}`);

  return new Promise((resolve, reject) => {
    execFile('git', args, (err, stdout, stderr) => {
      if (stderr) console.error(`[git] stderr: ${stderr.trim()}`);
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

// Clones exactly the commit that triggered the check run. We fetch by SHA rather than branch
// name to avoid a race condition: if a new commit is pushed between webhook delivery and the
// actual clone, fetching by branch would scan the wrong commit and misalign annotations.
// The installation token is injected into the HTTPS URL — it is never written to disk.
export async function cloneRepo({ token, cloneUrl, headSha, workspacePath }) {
  const authenticatedUrl = cloneUrl.replace(
    'https://',
    `https://x-access-token:${token}@`
  );

  debug('fetcher', `cloning ${cloneUrl} at ${headSha}`);

  await git(['init', workspacePath]);
  await git(['-C', workspacePath, 'remote', 'add', 'origin', authenticatedUrl]);
  await git(['-C', workspacePath, 'fetch', '--depth', '1', 'origin', headSha]);
  await git(['-C', workspacePath, 'checkout', 'FETCH_HEAD']);

  debug('fetcher', 'clone complete');
}

// Fetches the base commit into the workspace as FETCH_HEAD for diff operations.
// Must be called after cloneRepo(). The remote already has the authenticated URL from the clone.
export async function fetchBase({ workspacePath, baseSha }) {
  debug('fetcher', `fetching base sha: ${baseSha}`);
  await git(['-C', workspacePath, 'fetch', '--depth', '1', 'origin', baseSha]);
  debug('fetcher', 'base fetch complete');
}

export async function getChangedFiles({ workspacePath }) {
  // -z uses NUL as the record separator so filenames with spaces are handled correctly.
  const stdout = await git(['-C', workspacePath, 'diff', '--name-only', '-z', 'FETCH_HEAD', 'HEAD']);
  const files = stdout.split('\0').filter(Boolean);
  debug('fetcher', `${files.length} changed file(s)${files.length ? ': ' + files.join(', ') : ''}`);
  return files;
}

export async function cleanupWorkspace(workspacePath) {
  debug('fetcher', `cleaning up workspace: ${workspacePath}`);
  await rm(workspacePath, { recursive: true, force: true });
}
