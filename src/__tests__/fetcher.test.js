import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMkdtemp  = vi.fn().mockResolvedValue('/tmp/layne-job-1-xyz');
const mockRm       = vi.fn().mockResolvedValue(undefined);
const mockRealpath = vi.fn(async path => path);
const mockStat     = vi.fn().mockResolvedValue({ isFile: () => true });
const mockExecFile = vi.fn((cmd, args, cb) => cb(null, '', ''));

vi.mock('fs/promises', () => ({
  mkdtemp:  mockMkdtemp,
  realpath: mockRealpath,
  rm:       mockRm,
  stat:     mockStat,
}));

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

const { createWorkspace, setupRepo, getChangedFiles, getChangedLineRanges, checkoutFiles, cleanupWorkspace } = await import('../fetcher.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultSetupArgs(overrides = {}) {
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
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(new Error('Repository not found'), '', '')
    );
    await expect(setupRepo(defaultSetupArgs())).rejects.toThrow('Repository not found');
  });
});

// ---------------------------------------------------------------------------

describe('getChangedFiles()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async path => path);
    mockStat.mockResolvedValue({ isFile: () => true });
  });

  it('runs git diff --name-only -z with explicit SHAs inside the workspace', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) => cb(null, '', ''));
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
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(null, 'src/app.js\0src/utils.js\0', '')
    );
    const files = await getChangedFiles({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });
    expect(files).toEqual(['src/app.js', 'src/utils.js']);
  });

  it('correctly handles filenames with spaces', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(null, 'src/my file.js\0src/utils.js\0', '')
    );
    const files = await getChangedFiles({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });
    expect(files).toEqual(['src/my file.js', 'src/utils.js']);
  });

  it('returns an empty array when no files changed', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) => cb(null, '', ''));
    const files = await getChangedFiles({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });
    expect(files).toEqual([]);
  });

  it('drops paths with a leading slash', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(null, '/etc/passwd\0src/ok.js\0', '')
    );
    const files = await getChangedFiles({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });
    expect(files).toEqual(['src/ok.js']);
  });

  it('drops paths containing .. traversal segments', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(null, '../escape.js\0src/ok.js\0', '')
    );
    const files = await getChangedFiles({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });
    expect(files).toEqual(['src/ok.js']);
  });
});

// ---------------------------------------------------------------------------

describe('getChangedLineRanges()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses added and modified line ranges from a zero-context diff', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) => cb(null, [
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

    expect(ranges).toEqual({
      'src/app.js': [{ start: 3, end: 4 }],
      'src/util.js': [{ start: 10, end: 10 }],
    });
  });

  it('ignores deleted hunks that have no lines in the head revision', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) => cb(null, [
      'diff --git a/src/app.js b/src/app.js',
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -5,2 +5,0 @@',
      '-x',
      '-y',
    ].join('\n'), ''));

    const ranges = await getChangedLineRanges({ workspacePath: '/tmp/ws', baseSha: 'b', headSha: 'h' });

    expect(ranges).toEqual({ 'src/app.js': [] });
  });
});

// ---------------------------------------------------------------------------

describe('checkoutFiles()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async path => path);
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
    mockRealpath.mockImplementation(async path => {
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
    mockRealpath.mockImplementation(async path => {
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
    mockStat.mockImplementation(async path => {
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
    mockRealpath.mockImplementation(async path => {
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
});

// ---------------------------------------------------------------------------

describe('cleanupWorkspace()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes the workspace directory recursively', async () => {
    await cleanupWorkspace('/tmp/layne-job-1-xyz');
    expect(mockRm).toHaveBeenCalledWith('/tmp/layne-job-1-xyz', { recursive: true, force: true });
  });
});
