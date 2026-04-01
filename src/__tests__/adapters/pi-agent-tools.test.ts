import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockReadFile  = vi.fn();
const mockAccess    = vi.fn();
const mockStat      = vi.fn();
const mockReaddir   = vi.fn();
const mockGlob      = vi.fn();

vi.mock('fs/promises', () => ({
  default: {
    readFile:  (...args: unknown[]) => mockReadFile(...args),
    access:    (...args: unknown[]) => mockAccess(...args),
    stat:      (...args: unknown[]) => mockStat(...args),
    readdir:   (...args: unknown[]) => mockReaddir(...args),
  },
  readFile:  (...args: unknown[]) => mockReadFile(...args),
  access:    (...args: unknown[]) => mockAccess(...args),
  stat:      (...args: unknown[]) => mockStat(...args),
  readdir:   (...args: unknown[]) => mockReaddir(...args),
}));

vi.mock('tinyglobby', () => ({
  glob: (...args: unknown[]) => mockGlob(...args),
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  createReadTool: vi.fn((_cwd: string, opts: { operations: unknown }) => ({ name: 'read', ops: opts?.operations })),
  createGrepTool: vi.fn((_cwd: string, opts: { operations: unknown }) => ({ name: 'grep', ops: opts?.operations })),
  createFindTool: vi.fn((_cwd: string, opts: { operations: unknown }) => ({ name: 'find', ops: opts?.operations })),
  createLsTool:   vi.fn((_cwd: string, opts: { operations: unknown }) => ({ name: 'ls',   ops: opts?.operations })),
}));

const { createConfinedTools } = await import('../../adapters/pi-agent-tools.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = '/workspace/repo';

function getOps(toolName: string) {
  const tools = createConfinedTools(WS) as unknown as Array<{ name: string; ops: Record<string, Function> }>;
  return tools.find(t => t.name === toolName)!.ops;
}

// ---------------------------------------------------------------------------
// confinePath - tested indirectly through operations
// ---------------------------------------------------------------------------

describe('createConfinedTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns four tools', () => {
    const tools = createConfinedTools(WS);
    expect(tools).toHaveLength(4);
  });

  // -------------------------------------------------------------------------
  // read operations
  // -------------------------------------------------------------------------

  describe('read operations', () => {
    it('allows reading a file inside the workspace', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('hello'));
      const ops = getOps('read');
      await expect(ops.readFile(`${WS}/src/foo.ts`)).resolves.toBeDefined();
      expect(mockReadFile).toHaveBeenCalledWith(`${WS}/src/foo.ts`);
    });

    it('blocks reading a file outside the workspace', async () => {
      const ops = getOps('read');
      await expect(ops.readFile('/etc/passwd')).rejects.toThrow('access denied');
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('blocks path traversal via ..', async () => {
      const ops = getOps('read');
      await expect(ops.readFile(`${WS}/../../../etc/passwd`)).rejects.toThrow('access denied');
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('blocks a path that is a prefix match but not inside the workspace', async () => {
      const ops = getOps('read');
      // /workspace/repo-evil should not match /workspace/repo
      await expect(ops.readFile('/workspace/repo-evil/secret')).rejects.toThrow('access denied');
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('allows access check inside the workspace', async () => {
      mockAccess.mockResolvedValue(undefined);
      const ops = getOps('read');
      await expect(ops.access(`${WS}/package.json`)).resolves.toBeUndefined();
      expect(mockAccess).toHaveBeenCalledWith(`${WS}/package.json`);
    });

    it('blocks access check outside the workspace', async () => {
      const ops = getOps('read');
      await expect(ops.access('/home/user/.ssh/id_rsa')).rejects.toThrow('access denied');
      expect(mockAccess).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // grep operations
  // -------------------------------------------------------------------------

  describe('grep operations', () => {
    it('allows isDirectory inside the workspace', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      const ops = getOps('grep');
      await expect(ops.isDirectory(`${WS}/src`)).resolves.toBe(true);
    });

    it('blocks isDirectory outside the workspace', async () => {
      const ops = getOps('grep');
      await expect(ops.isDirectory('/etc')).rejects.toThrow('access denied');
      expect(mockStat).not.toHaveBeenCalled();
    });

    it('allows readFile inside the workspace', async () => {
      mockReadFile.mockResolvedValue('code');
      const ops = getOps('grep');
      await expect(ops.readFile(`${WS}/src/app.ts`)).resolves.toBe('code');
    });

    it('blocks readFile outside the workspace', async () => {
      const ops = getOps('grep');
      await expect(ops.readFile('/Users/julio/layne/.env')).rejects.toThrow('access denied');
      expect(mockReadFile).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // find operations
  // -------------------------------------------------------------------------

  describe('find operations', () => {
    it('allows exists check inside the workspace', async () => {
      mockAccess.mockResolvedValue(undefined);
      const ops = getOps('find');
      await expect(ops.exists(`${WS}/src`)).resolves.toBe(true);
    });

    it('blocks exists check outside the workspace', async () => {
      const ops = getOps('find');
      await expect(ops.exists('/etc/passwd')).rejects.toThrow('access denied');
      expect(mockAccess).not.toHaveBeenCalled();
    });

    it('allows glob with cwd inside the workspace', async () => {
      mockGlob.mockResolvedValue([`${WS}/src/foo.ts`, `${WS}/src/bar.ts`]);
      const ops = getOps('find');
      const results = await ops.glob('**/*.ts', `${WS}/src`, { ignore: [], limit: 100 });
      expect(results).toHaveLength(2);
      expect(mockGlob).toHaveBeenCalledWith('**/*.ts', expect.objectContaining({ cwd: `${WS}/src` }));
    });

    it('blocks glob with cwd outside the workspace', async () => {
      const ops = getOps('find');
      await expect(ops.glob('**/*', '/etc', { ignore: [], limit: 100 })).rejects.toThrow('access denied');
      expect(mockGlob).not.toHaveBeenCalled();
    });

    it('filters out glob results that escape the workspace', async () => {
      mockGlob.mockResolvedValue([`${WS}/src/foo.ts`, '/etc/passwd', `${WS}/src/bar.ts`]);
      const ops = getOps('find');
      const results = await ops.glob('**/*.ts', WS, { ignore: [], limit: 100 });
      expect(results).toEqual([`${WS}/src/foo.ts`, `${WS}/src/bar.ts`]);
    });

    it('respects the limit after filtering', async () => {
      mockGlob.mockResolvedValue([`${WS}/a.ts`, `${WS}/b.ts`, `${WS}/c.ts`]);
      const ops = getOps('find');
      const results = await ops.glob('**/*.ts', WS, { ignore: [], limit: 2 });
      expect(results).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // ls operations
  // -------------------------------------------------------------------------

  describe('ls operations', () => {
    it('allows exists check inside the workspace', async () => {
      mockAccess.mockResolvedValue(undefined);
      const ops = getOps('ls');
      await expect(ops.exists(`${WS}/src`)).resolves.toBe(true);
    });

    it('blocks exists check outside the workspace', async () => {
      const ops = getOps('ls');
      await expect(ops.exists('/var/log')).rejects.toThrow('access denied');
      expect(mockAccess).not.toHaveBeenCalled();
    });

    it('allows stat inside the workspace', async () => {
      const fakeStat = { isDirectory: () => true };
      mockStat.mockResolvedValue(fakeStat);
      const ops = getOps('ls');
      await expect(ops.stat(`${WS}/src`)).resolves.toBe(fakeStat);
    });

    it('blocks stat outside the workspace', async () => {
      const ops = getOps('ls');
      await expect(ops.stat('/root')).rejects.toThrow('access denied');
      expect(mockStat).not.toHaveBeenCalled();
    });

    it('allows readdir inside the workspace', async () => {
      mockReaddir.mockResolvedValue(['foo.ts', 'bar.ts']);
      const ops = getOps('ls');
      await expect(ops.readdir(`${WS}/src`)).resolves.toEqual(['foo.ts', 'bar.ts']);
    });

    it('blocks readdir outside the workspace', async () => {
      const ops = getOps('ls');
      await expect(ops.readdir('/etc')).rejects.toThrow('access denied');
      expect(mockReaddir).not.toHaveBeenCalled();
    });

    it('allows access to the workspace root itself', async () => {
      mockAccess.mockResolvedValue(undefined);
      const ops = getOps('ls');
      await expect(ops.exists(WS)).resolves.toBe(true);
    });
  });
});
