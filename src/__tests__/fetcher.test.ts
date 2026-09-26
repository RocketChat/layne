import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMkdtemp  = vi.fn().mockResolvedValue('/tmp/layne-job-1-xyz');
const mockRm       = vi.fn().mockResolvedValue(undefined);
const mockRealpath = vi.fn(async (path: string) => path);
const mockStat     = vi.fn().mockResolvedValue({ isFile: () => true });
const mockExecFile = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, '', ''));

vi.mock('fs/promises', () => ({
  lstat:    mockStat,
  mkdtemp:  mockMkdtemp,
  realpath: mockRealpath,
  rm:       mockRm,
}));

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

const { createWorkspace, setupRepo, getChangedFiles, getGitChanges, getChangedLineRanges, getUnifiedDiff, checkoutFiles, checkoutGitChanges, cleanupWorkspace, fetchCommit } = await import('../fetcher.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultSetupArgs(overrides: Record<string, unknown> = {}) {
  return {
    token:         'tok123',
    cloneUrl:      'https://github.com/org/repo.git',
    headSha:       'abc123',
    baseSha:       'def456',
    workspacePath: '/tmp/workspace',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('createWorkspace()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a temp directory prefixed with the job ID', async () => {
    const path = await createWorkspace('job-42');
    expect(mockMkdtemp).toHaveBeenCalledWith(expect.stringContaining('layne-job-42-'));
    expect(path).toBe('/tmp/layne-job-1-xyz');
  });
});

// ---------------------------------------------------------------------------

describe('setupRepo()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('initialises an empty git repo in the workspace', async () => {
    await setupRepo(defaultSetupArgs());
    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toContain('init');
    expect(args).toContain('/tmp/workspace');
  });

  it('adds the authenticated URL as the origin remote', async () => {
    await setupRepo(defaultSetupArgs({ token: 'tok999' }));
    const [cmd, args] = mockExecFile.mock.calls[1]; // second call: remote add
    expect(cmd).toBe('git');
    expect(args).toContain('remote');
    expect(args).toContain('add');
    expect(args).toContain('origin');
    expect(args).toContain('https://x-access-token:tok999@github.com/org/repo.git');
  });

  it.each([
    'https://attacker.example/org/repo.git',
    'https://github.com.attacker.example/org/repo.git',
    'https://github.com@attacker.example/org/repo.git',
    'http://github.com/org/repo.git',
    'https://github.com:8443/org/repo.git',
    'https://user@github.com/org/repo.git',
    'https://:password@github.com/org/repo.git',
    'file:///tmp/repo.git',
    'ssh://git@github.com/org/repo.git',
    'https://github.com/org/repo.git?redirect=attacker.example',
    'https://github.com/org/repo.git#attacker.example',
  ])('rejects a non-GitHub clone URL before spawning Git: %s', async cloneUrl => {
    await expect(setupRepo(defaultSetupArgs({ cloneUrl }))).rejects.toThrow(
      'Refusing to authenticate non-GitHub clone URL',
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('rejects an invalid clone URL before spawning Git', async () => {
    await expect(setupRepo(defaultSetupArgs({ cloneUrl: 'not a URL' }))).rejects.toThrow(
      'Refusing to authenticate invalid GitHub clone URL',
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('encodes token delimiters without changing the destination', async () => {
    await setupRepo(defaultSetupArgs({ token: 'synthetic@token:with/slash' }));
    const url = new URL(mockExecFile.mock.calls[1][1].at(-1)!);
    expect(url.hostname).toBe('github.com');
    expect(decodeURIComponent(url.password)).toBe('synthetic@token:with/slash');
  });

  it('fetches the head SHA with --filter=blob:none', async () => {
    await setupRepo(defaultSetupArgs({ headSha: 'deadbeef' }));
    const [cmd, args] = mockExecFile.mock.calls[2]; // third call: fetch head
    expect(cmd).toBe('git');
    expect(args).toContain('fetch');
    expect(args).toContain('--filter=blob:none');
    expect(args).toContain('--depth');
    expect(args).toContain('1');
    expect(args).toContain('deadbeef');
  });

  it('fetches the base SHA with --filter=blob:none', async () => {
    await setupRepo(defaultSetupArgs({ baseSha: 'base999' }));
    const [cmd, args] = mockExecFile.mock.calls[3]; // fourth call: fetch base
    expect(cmd).toBe('git');
    expect(args).toContain('fetch');
    expect(args).toContain('--filter=blob:none');
    expect(args).toContain('base999');
  });

  it('uses Git protocol v2 for both fetches', async () => {
    await setupRepo(defaultSetupArgs());
    const headFetchArgs = mockExecFile.mock.calls[2][1];
    const baseFetchArgs = mockExecFile.mock.calls[3][1];
    expect(headFetchArgs).toContain('protocol.version=2');
    expect(baseFetchArgs).toContain('protocol.version=2');
  });

  it('initialises sparse checkout in no-cone mode', async () => {
    await setupRepo(defaultSetupArgs());
    const [cmd, args] = mockExecFile.mock.calls[4]; // fifth call: sparse-checkout init
    expect(cmd).toBe('git');
    expect(args).toContain('sparse-checkout');
    expect(args).toContain('init');
    expect(args).toContain('--no-cone');
  });

  it('throws if any git step fails', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
      cb(new Error('Repository not found'), '', '')
    );
    await expect(setupRepo(defaultSetupArgs())).rejects.toThrow('Repository not found');
  });

  it('passes the signal to every Git child process', async () => {
    const signal = new AbortController().signal;
    await setupRepo(defaultSetupArgs({ signal }));
    for (const call of mockExecFile.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ signal }));
    }
  });

  it('does not spawn Git when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(setupRepo(defaultSetupArgs({ signal: controller.signal }))).rejects.toThrow('cancelled');
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('getChangedFiles()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (path: string) => path);
    mockStat.mockResolvedValue({ isFile: () => true });
  });

  it('runs git diff --name-only -z with explicit SHAs inside the workspace', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, '', ''));
    await getChangedFiles({ workspacePath: '/tmp/ws', baseSha: 'base1', headSha: 'head1' });

    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toContain('-C');
    expect(args).toContain('/tmp/ws');
    expect(args).toContain('diff');
    expect(args).toContain('--name-only');
    expect(args).toContain('-z');
    expect(args).toContain('base1');
    expect(args).toContain('head1');
  });

  it('returns an array of changed file paths (NUL-delimited output)', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
      cb(null, 'src/app.js\0src/utils.js\0', '')
    );
    const files = await getChangedFiles({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });
    expect(files).toEqual(['src/app.js', 'src/utils.js']);
  });

  it('correctly handles filenames with spaces', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
      cb(null, 'src/my file.js\0src/utils.js\0', '')
    );
    const files = await getChangedFiles({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });
    expect(files).toEqual(['src/my file.js', 'src/utils.js']);
  });

  it('returns an empty array when no files changed', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, '', ''));
    const files = await getChangedFiles({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });
    expect(files).toEqual([]);
  });

  it('drops paths with a leading slash', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
      cb(null, '/etc/passwd\0src/ok.js\0', '')
    );
    const files = await getChangedFiles({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });
    expect(files).toEqual(['src/ok.js']);
  });

  it('drops paths containing .. traversal segments', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
      cb(null, '../escape.js\0src/ok.js\0', '')
    );
    const files = await getChangedFiles({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });
    expect(files).toEqual(['src/ok.js']);
  });
});

describe('getGitChanges()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves rename paths, similarity, object IDs, and modes', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
      cb(null, ':100644 100755 aaaaaaa bbbbbbb R097\0src/old name.js\0src/new name.js\0', '')
    );

    const changes = await getGitChanges({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });

    expect(changes).toEqual([expect.objectContaining({
      status: 'renamed', oldPath: 'src/old name.js', newPath: 'src/new name.js',
      oldKind: 'regular', newKind: 'regular', similarity: 97,
      oldOid: 'aaaaaaa', newOid: 'bbbbbbb',
    })]);
    expect(mockExecFile.mock.calls[0][1]).toEqual(expect.arrayContaining(['--raw', '-z', '--no-abbrev', '--find-renames']));
  });

  it('classifies deletions, symlinks, submodules, and type changes', async () => {
    const raw = [
      ':100644 000000 aaaaaaa 0000000 D\0deleted.js\0',
      ':000000 120000 0000000 bbbbbbb A\0link\0',
      ':000000 160000 0000000 ccccccc A\0vendor/lib\0',
      ':100644 120000 ddddddd eeeeeee T\0changed-type\0',
    ].join('');
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, raw, ''));

    const changes = await getGitChanges({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });

    expect(changes.map(change => [change.status, change.oldKind, change.newKind])).toEqual([
      ['deleted', 'regular', 'absent'],
      ['added', 'absent', 'symlink'],
      ['added', 'absent', 'submodule'],
      ['type_changed', 'regular', 'symlink'],
    ]);
  });

  it('fails closed on unsafe or malformed raw records', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
      cb(null, ':100644 100644 aaaaaaa bbbbbbb M\0../escape.js\0', '')
    );
    await expect(getGitChanges({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' })).rejects.toThrow('Unsafe path');
  });
});

// ---------------------------------------------------------------------------

describe('fetchCommit()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches the given SHA with --depth 1 and --filter=blob:none', async () => {
    await fetchCommit({ workspacePath: '/tmp/ws', sha: 'deadbeef' });

    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toContain('fetch');
    expect(args).toContain('--depth');
    expect(args).toContain('1');
    expect(args).toContain('--filter=blob:none');
    expect(args).toContain('origin');
    expect(args).toContain('deadbeef');
  });

  it('uses Git protocol v2', async () => {
    await fetchCommit({ workspacePath: '/tmp/ws', sha: 'deadbeef' });
    expect(mockExecFile.mock.calls[0][1]).toContain('protocol.version=2');
  });

  it('runs inside the given workspace path', async () => {
    await fetchCommit({ workspacePath: '/tmp/my-workspace', sha: 'abc' });
    const args = mockExecFile.mock.calls[0][1];
    expect(args).toContain('-C');
    expect(args).toContain('/tmp/my-workspace');
  });

  it('throws when git exits with a non-zero code', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
      cb(new Error('unknown revision'), '', '')
    );
    await expect(fetchCommit({ workspacePath: '/tmp/ws', sha: 'bad' })).rejects.toThrow('unknown revision');
  });
});

// ---------------------------------------------------------------------------

describe('getChangedLineRanges()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses added and modified line ranges from a zero-context diff', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, [
      'diff --git a/src/app.js b/src/app.js',
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -2,0 +3,2 @@',
      '+x',
      '+y',
      'diff --git a/src/util.js b/src/util.js',
      '--- a/src/util.js',
      '+++ b/src/util.js',
      '@@ -10 +10 @@',
      '-old',
      '+new',
    ].join('\n'), ''));

    const ranges = await getChangedLineRanges({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });

    expect(ranges).toEqual(new Map([
      ['src/app.js', [{ start: 3, end: 4 }]],
      ['src/util.js', [{ start: 10, end: 10 }]],
    ]));
  });

  it('scopes the diff to specific files when files array is provided', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, '', ''));
    await getChangedLineRanges({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h', files: ['src/a.js', 'src/b.js'] });

    const args = mockExecFile.mock.calls[0][1];
    expect(args).toContain('--');
    expect(args).toContain('src/a.js');
    expect(args).toContain('src/b.js');
  });

  it('does not append -- when files array is empty', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, '', ''));
    await getChangedLineRanges({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });

    const args = mockExecFile.mock.calls[0][1];
    expect(args).not.toContain('--');
  });

  it('ignores deleted hunks that have no lines in the head revision', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, [
      'diff --git a/src/app.js b/src/app.js',
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -5,2 +5,0 @@',
      '-x',
      '-y',
    ].join('\n'), ''));

    const ranges = await getChangedLineRanges({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });

    expect(ranges).toEqual(new Map([['src/app.js', []]]));
  });
});

describe('getUnifiedDiff()', () => {
  const changes = [{
    status: 'modified', oldPath: 'src/app.ts', newPath: 'src/app.ts', oldMode: '100644', newMode: '100644',
    oldOid: 'a', newOid: 'b', oldKind: 'regular', newKind: 'regular',
  }] as Parameters<typeof getUnifiedDiff>[0]['changes'];

  beforeEach(() => vi.clearAllMocks());

  it('runs a file-scoped git diff with the configured context and parses it', async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n'), ''));

    const result = await getUnifiedDiff({
      workspacePath: '/tmp/ws', baseSha: 'base', headSha: 'head', contextLines: 7, files: ['src/app.ts'], changes,
    });

    expect(mockExecFile.mock.calls[0][1]).toEqual([
      '-C', '/tmp/ws', 'diff', '--patch', '--unified=7', '--no-color', '--no-ext-diff', '--find-renames',
      'base', 'head', '--', 'src/app.ts',
    ]);
    expect(result.files[0]?.hunks[0]?.lines[1]).toEqual({
      type: 'addition', content: 'new', oldLine: null, newLine: 1,
    });
  });

  it('does not run an unscoped diff when no prepared files are known', async () => {
    const result = await getUnifiedDiff({
      workspacePath: '/tmp/ws', baseSha: 'base', headSha: 'head', contextLines: 3, files: [], changes,
    });

    expect(result).toEqual({ files: [] });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('fails before git when a prepared file has no matching Git change', async () => {
    await expect(getUnifiedDiff({
      workspacePath: '/tmp/ws', baseSha: 'base', headSha: 'head', contextLines: 3, files: ['src/other.ts'], changes,
    })).rejects.toThrow(/exactly one Git change/);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('checkoutFiles()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (path: string) => path);
    mockStat.mockResolvedValue({ isFile: () => true });
  });

  it('returns an empty array without running git when files list is empty', async () => {
    const result = await checkoutFiles({ workspacePath: '/tmp/ws', headSha: 'h', files: [] });
    expect(result).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('runs sparse-checkout set with the changed files', async () => {
    await checkoutFiles({ workspacePath: '/tmp/ws', headSha: 'h', files: ['a.js', 'b.js'] });
    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toContain('sparse-checkout');
    expect(args).toContain('set');
    expect(args).toContain('a.js');
    expect(args).toContain('b.js');
  });

  it('checks out the head SHA after setting sparse checkout', async () => {
    await checkoutFiles({ workspacePath: '/tmp/ws', headSha: 'abc123', files: ['a.js'] });
    const [cmd, args] = mockExecFile.mock.calls[1]; // second call: checkout
    expect(cmd).toBe('git');
    expect(args).toContain('checkout');
    expect(args).toContain('abc123');
  });

  it('returns files that pass stat validation', async () => {
    const result = await checkoutFiles({
      workspacePath: '/tmp/ws',
      headSha:       'h',
      files:         ['src/app.js', 'src/utils.js'],
    });
    expect(result).toEqual(['src/app.js', 'src/utils.js']);
  });

  it('drops a file whose resolved path escapes the workspace', async () => {
    mockRealpath.mockImplementation(async (path: string) => {
      if (path === '/tmp/ws')         return '/private/tmp/ws';
      if (path === '/tmp/ws/leak.js') return '/etc/hosts';
      // Remap all other workspace sub-paths so they resolve inside /private/tmp/ws
      if (path.startsWith('/tmp/ws/')) return '/private' + path;
      return path;
    });

    const result = await checkoutFiles({
      workspacePath: '/tmp/ws',
      headSha:       'h',
      files:         ['leak.js', 'src/ok.js'],
    });
    expect(result).toEqual(['src/ok.js']);
  });

  it('drops a broken symlink that throws on realpath', async () => {
    mockRealpath.mockImplementation(async (path: string) => {
      if (path === '/tmp/ws')              return '/private/tmp/ws';
      if (path === '/tmp/ws/broken-link')  throw new Error('ENOENT');
      if (path.startsWith('/tmp/ws/'))     return '/private' + path;
      return path;
    });

    const result = await checkoutFiles({
      workspacePath: '/tmp/ws',
      headSha:       'h',
      files:         ['broken-link', 'src/ok.js'],
    });
    expect(result).toEqual(['src/ok.js']);
  });

  it('drops a path that is not a regular file (e.g. a directory)', async () => {
    mockStat.mockImplementation(async (path: string) => {
      if (path === '/tmp/ws/dir') return { isFile: () => false };
      return { isFile: () => true };
    });

    const result = await checkoutFiles({
      workspacePath: '/tmp/ws',
      headSha:       'h',
      files:         ['dir', 'src/ok.js'],
    });
    expect(result).toEqual(['src/ok.js']);
  });

  it('keeps an internal symlink that resolves inside the workspace', async () => {
    mockRealpath.mockImplementation(async (path: string) => {
      if (path === '/tmp/ws')          return '/private/tmp/ws';
      if (path === '/tmp/ws/link.js')  return '/private/tmp/ws/src/real.js';
      return path;
    });

    const result = await checkoutFiles({
      workspacePath: '/tmp/ws',
      headSha:       'h',
      files:         ['link.js'],
    });
    expect(result).toEqual(['link.js']);
  });

  it('reports deleted and non-regular Git objects instead of silently dropping them', async () => {
    const changes = [
      { status: 'deleted', oldPath: 'old.js', newPath: null, oldMode: '100644', newMode: '000000', oldOid: 'a', newOid: '0', oldKind: 'regular', newKind: 'absent' },
      { status: 'added', oldPath: null, newPath: 'link', oldMode: '000000', newMode: '120000', oldOid: '0', newOid: 'b', oldKind: 'absent', newKind: 'symlink' },
      { status: 'added', oldPath: null, newPath: 'vendor/lib', oldMode: '000000', newMode: '160000', oldOid: '0', newOid: 'c', oldKind: 'absent', newKind: 'submodule' },
    ] as Parameters<typeof checkoutGitChanges>[0]['changes'];

    const result = await checkoutGitChanges({ workspacePath: '/tmp/ws', headSha: 'h', changes });

    expect(result.files).toEqual([]);
    expect(result.issues.map(issue => [issue.disposition, issue.reason])).toEqual([
      ['not_applicable', 'deleted'],
      ['unsupported', 'head-symlink'],
      ['unsupported', 'head-submodule'],
    ]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('reports an expected regular file that cannot be prepared as unavailable', async () => {
    mockRealpath.mockImplementation(async (path: string) => {
      if (path === '/tmp/ws/src/app.js') throw new Error('ENOENT');
      return path;
    });
    const changes = [{
      status: 'modified', oldPath: 'src/app.js', newPath: 'src/app.js', oldMode: '100644', newMode: '100644',
      oldOid: 'a', newOid: 'b', oldKind: 'regular', newKind: 'regular',
    }] as Parameters<typeof checkoutGitChanges>[0]['changes'];

    const result = await checkoutGitChanges({ workspacePath: '/tmp/ws', headSha: 'h', changes });

    expect(result.files).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ disposition: 'unavailable', reason: 'checkout-unavailable' })]);
  });
});

// ---------------------------------------------------------------------------

describe('cleanupWorkspace()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes the workspace directory recursively', async () => {
    await cleanupWorkspace('/tmp/layne-job-1-xyz');
    expect(mockRm).toHaveBeenCalledWith('/tmp/layne-job-1-xyz', { recursive: true, force: true });
  });
});
