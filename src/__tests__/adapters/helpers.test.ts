import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({ execFile: mockExecFile }));

const { exec } = await import('../../adapters/helpers.js');

describe('exec()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns stdout, stderr, and exitCode for a successful command', async () => {
    mockExecFile.mockImplementationOnce((_cmd, _args, _options, callback) => {
      callback(null, 'output', 'warning');
    });

    await expect(exec('scanner', ['--json'])).resolves.toEqual({
      stdout: 'output',
      stderr: 'warning',
      exitCode: 0,
    });
  });

  it('resolves numeric non-zero exits with their output and exitCode', async () => {
    const error = Object.assign(new Error('exit 7'), { code: 7 });
    mockExecFile.mockImplementationOnce((_cmd, _args, _options, callback) => {
      callback(error, 'partial output', 'scanner warning');
    });

    await expect(exec('scanner', [])).resolves.toEqual({
      stdout: 'partial output',
      stderr: 'scanner warning',
      exitCode: 7,
    });
  });

  it('rejects spawn errors without a numeric exit code', async () => {
    const error = Object.assign(new Error('spawn scanner ENOENT'), { code: 'ENOENT' });
    mockExecFile.mockImplementationOnce((_cmd, _args, _options, callback) => {
      callback(error, '', '');
    });

    await expect(exec('scanner', [])).rejects.toBe(error);
  });
});
