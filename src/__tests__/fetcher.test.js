import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMkdtemp = vi.fn().mockResolvedValue('/tmp/layne-job-1-xyz');
const mockRm      = vi.fn().mockResolvedValue(undefined);
const mockRealpath = vi.fn(async path => path);
const mockStat     = vi.fn().mockResolvedValue({ isFile: () => true });
const mockExecFile = vi.fn((cmd, args, cb) => cb(null, '', ''));

vi.mock('fs/promises', () => ({
  mkdtemp: mockMkdtemp,
  realpath: mockRealpath,
  rm:      mockRm,
  stat:    mockStat,
}));

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

const { createWorkspace, cloneRepo, fetchBase, getChangedFiles, cleanupWorkspace } = await import('../fetcher.js');

describe('createWorkspace()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async path => path);
    mockStat.mockResolvedValue({ isFile: () => true });
  });

  it('creates a temp directory prefixed with the job ID', async () => {
    const path = await createWorkspace('job-42');
    expect(mockMkdtemp).toHaveBeenCalledWith(expect.stringContaining('layne-job-42-'));
    expect(path).toBe('/tmp/layne-job-1-xyz');
  });
});

// Helper — call cloneRepo with default args
function doClone(overrides = {}) {
  return cloneRepo({
    token:         'tok123',
    cloneUrl:      'https://github.com/org/repo.git',
    headSha:       'abc123',
    workspacePath: '/tmp/workspace',
    ...overrides,
  });
}

describe('cloneRepo()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async path => path);
    mockStat.mockResolvedValue({ isFile: () => true });
  });

  it('initialises an empty git repo in the workspace', async () => {
    await doClone();
    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toContain('init');
    expect(args).toContain('/tmp/workspace');
  });

  it('adds the authenticated URL as the origin remote', async () => {
    await doClone();
    const [cmd, args] = mockExecFile.mock.calls[1]; // second call: remote add
    expect(cmd).toBe('git');
    expect(args).toContain('remote');
    expect(args).toContain('add');
    expect(args).toContain('origin');
    expect(args).toContain('https://x-access-token:tok123@github.com/org/repo.git');
  });

  it('fetches exactly the head SHA with depth 1', async () => {
    await doClone({ headSha: 'deadbeef' });
    const [cmd, args] = mockExecFile.mock.calls[2]; // third call: fetch
    expect(cmd).toBe('git');
    expect(args).toContain('fetch');
    expect(args).toContain('--depth');
    expect(args).toContain('1');
    expect(args).toContain('deadbeef');
  });

  it('checks out FETCH_HEAD after fetching', async () => {
    await doClone();
    const [cmd, args] = mockExecFile.mock.calls[3]; // fourth call: checkout
    expect(cmd).toBe('git');
    expect(args).toContain('checkout');
    expect(args).toContain('FETCH_HEAD');
  });

  it('injects the token into the remote URL', async () => {
    await doClone({ token: 'tok999' });
    const remoteAddArgs = mockExecFile.mock.calls[1][1];
    const url = remoteAddArgs.find(a => a.includes('x-access-token'));
    expect(url).toBe('https://x-access-token:tok999@github.com/org/repo.git');
  });

  it('throws if any git step fails', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(new Error('Repository not found'), '', '')
    );
    await expect(doClone()).rejects.toThrow('Repository not found');
  });
});

describe('fetchBase()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async path => path);
    mockStat.mockResolvedValue({ isFile: () => true });
  });

  it('runs git fetch for the base sha inside the workspace', async () => {
    await fetchBase({ workspacePath: '/tmp/ws', baseSha: 'def456' });

    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toContain('-C');
    expect(args).toContain('/tmp/ws');
    expect(args).toContain('fetch');
    expect(args).toContain('origin');
    expect(args).toContain('def456');
  });

  it('fetches with depth 1 to keep it shallow', async () => {
    await fetchBase({ workspacePath: '/tmp/ws', baseSha: 'def456' });
    const args = mockExecFile.mock.calls[0][1];
    expect(args).toContain('--depth');
  });

  it('throws if git fetch fails', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(new Error('fatal: remote branch not found'), '', '')
    );
    await expect(fetchBase({ workspacePath: '/tmp/ws', baseSha: 'def456' }))
      .rejects.toThrow('fatal: remote branch not found');
  });
});

describe('getChangedFiles()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async path => path);
    mockStat.mockResolvedValue({ isFile: () => true });
  });

  it('runs git diff --name-only -z FETCH_HEAD HEAD inside the workspace', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) => cb(null, '', ''));
    await getChangedFiles({ workspacePath: '/tmp/ws' });

    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toContain('-C');
    expect(args).toContain('/tmp/ws');
    expect(args).toContain('diff');
    expect(args).toContain('--name-only');
    expect(args).toContain('-z');
    expect(args).toContain('FETCH_HEAD');
    expect(args).toContain('HEAD');
  });

  it('returns an array of changed file paths (NUL-delimited output)', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(null, 'src/app.js\0src/utils.js\0', '')
    );
    const files = await getChangedFiles({ workspacePath: '/tmp/ws' });
    expect(files).toEqual(['src/app.js', 'src/utils.js']);
  });

  it('correctly handles filenames with spaces', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(null, 'src/my file.js\0src/utils.js\0', '')
    );
    const files = await getChangedFiles({ workspacePath: '/tmp/ws' });
    expect(files).toEqual(['src/my file.js', 'src/utils.js']);
  });

  it('returns an empty array when no files changed', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) => cb(null, '', ''));
    const files = await getChangedFiles({ workspacePath: '/tmp/ws' });
    expect(files).toEqual([]);
  });

  it('keeps an internal symlink target when it resolves inside the workspace', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(null, 'link.js\0', '')
    );
    mockRealpath.mockImplementation(async path => {
      if (path === '/tmp/ws') return '/private/tmp/ws';
      if (path === '/tmp/ws/link.js') return '/private/tmp/ws/src/real.js';
      return path;
    });

    const files = await getChangedFiles({ workspacePath: '/tmp/ws' });
    expect(files).toEqual(['link.js']);
  });

  it('drops a changed path when its resolved target escapes the workspace', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(null, 'leak\0', '')
    );
    mockRealpath.mockImplementation(async path => {
      if (path === '/tmp/ws') return '/private/tmp/ws';
      if (path === '/tmp/ws/leak') return '/etc/hosts';
      return path;
    });

    const files = await getChangedFiles({ workspacePath: '/tmp/ws' });
    expect(files).toEqual([]);
  });

  it('keeps a file beneath an internal symlinked directory', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(null, 'shared/app.js\0', '')
    );
    mockRealpath.mockImplementation(async path => {
      if (path === '/tmp/ws') return '/private/tmp/ws';
      if (path === '/tmp/ws/shared/app.js') return '/private/tmp/ws/packages/shared/app.js';
      return path;
    });

    const files = await getChangedFiles({ workspacePath: '/tmp/ws' });
    expect(files).toEqual(['shared/app.js']);
  });

  it('drops broken symlinks or missing files', async () => {
    mockExecFile.mockImplementationOnce((cmd, args, cb) =>
      cb(null, 'broken-link\0', '')
    );
    mockRealpath.mockImplementation(async path => {
      if (path === '/tmp/ws') return '/private/tmp/ws';
      if (path === '/tmp/ws/broken-link') throw new Error('ENOENT');
      return path;
    });

    const files = await getChangedFiles({ workspacePath: '/tmp/ws' });
    expect(files).toEqual([]);
  });
});

describe('cleanupWorkspace()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async path => path);
    mockStat.mockResolvedValue({ isFile: () => true });
  });

  it('removes the workspace directory recursively', async () => {
    await cleanupWorkspace('/tmp/layne-job-1-xyz');
    expect(mockRm).toHaveBeenCalledWith('/tmp/layne-job-1-xyz', { recursive: true, force: true });
  });
});
