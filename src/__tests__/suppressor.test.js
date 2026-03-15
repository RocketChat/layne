import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({ execFile: mockExecFile }));

const { suppressFindings } = await import('../suppressor.js');

// Helper: make execFile resolve with given stdout
function resolveWith(stdout) {
  mockExecFile.mockImplementationOnce((_cmd, _args, cb) => cb(null, stdout, ''));
}

// Helper: make execFile reject (simulates new file / blob unavailable)
function rejectWith(err = new Error('not found')) {
  mockExecFile.mockImplementationOnce((_cmd, _args, cb) => cb(err, '', ''));
}

const BASE = { workspacePath: '/workspace', baseSha: 'base-sha' };

const finding = (overrides = {}) => ({
  file: 'src/app.js',
  line: 5,
  severity: 'high',
  message: 'issue',
  ruleId: 'r/1',
  tool: 'semgrep',
  ...overrides,
});

describe('suppressFindings()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns [] and never calls execFile for an empty findings array', async () => {
    const result = await suppressFindings([], BASE);
    expect(result).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('keeps a finding when git show fails (new file)', async () => {
    rejectWith(new Error('fatal: path not in tree'));
    const f = finding();
    const result = await suppressFindings([f], BASE);
    expect(result).toEqual([f]);
  });

  it('keeps a finding when there is no SECURITY: comment at base', async () => {
    resolveWith('line1\nline2\nline3\nline4\nline5\nline6\n');
    const f = finding({ line: 5 });
    const result = await suppressFindings([f], BASE);
    expect(result).toEqual([f]);
  });

  it('suppresses a finding when // SECURITY: reason is on the same line', async () => {
    resolveWith('line1\nline2\nline3\nline4\nconst x = 1; // SECURITY: reviewed by alice\nline6\n');
    const result = await suppressFindings([finding({ line: 5 })], BASE);
    expect(result).toEqual([]);
  });

  it('suppresses a finding when // SECURITY: reason is on the line immediately above', async () => {
    resolveWith('line1\nline2\nline3\n// SECURITY: approved in issue #42\nconst x = 1;\nline6\n');
    const result = await suppressFindings([finding({ line: 5 })], BASE);
    expect(result).toEqual([]);
  });

  it('suppresses a finding with # SECURITY: (YAML/shell comment style)', async () => {
    resolveWith('line1\nline2\nline3\nline4\n# SECURITY: checked for injection\nline6\n');
    const result = await suppressFindings([finding({ line: 5 })], BASE);
    expect(result).toEqual([]);
  });

  it('does NOT suppress when // SECURITY: has no text after the colon', async () => {
    resolveWith('line1\nline2\nline3\nline4\n// SECURITY:\nline6\n');
    const f = finding({ line: 5 });
    const result = await suppressFindings([f], BASE);
    expect(result).toEqual([f]);
  });

  it('calls execFile only once for two findings in the same file (cache hit)', async () => {
    resolveWith('line1\nline2\nline3\nline4\nline5\n');
    const f1 = finding({ line: 2 });
    const f2 = finding({ line: 4 });
    await suppressFindings([f1, f2], BASE);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('does not crash and keeps the finding when finding.line === 1', async () => {
    resolveWith('const x = 1;\nline2\n');
    const f = finding({ line: 1 });
    const result = await suppressFindings([f], BASE);
    expect(result).toEqual([f]);
  });

  it('returns the correct filtered array for a mixed batch', async () => {
    // file A: has a SECURITY comment above line 3
    const fileAContent = 'line1\n// SECURITY: reviewed by bob\nconst y = 2;\nline4\n';
    // file B: no SECURITY comment
    const fileBContent = 'line1\nline2\nline3\n';

    mockExecFile
      .mockImplementationOnce((_cmd, _args, cb) => cb(null, fileAContent, ''))
      .mockImplementationOnce((_cmd, _args, cb) => cb(null, fileBContent, ''));

    const fA = finding({ file: 'src/a.js', line: 3 }); // should be suppressed
    const fB = finding({ file: 'src/b.js', line: 2 }); // should be kept

    const result = await suppressFindings([fA, fB], BASE);
    expect(result).toEqual([fB]);
  });

  it('handles git show failure for file A independently from success for file B', async () => {
    rejectWith(new Error('not found'));
    resolveWith('line1\nline2\nline3\n');

    const fA = finding({ file: 'src/a.js', line: 2 });
    const fB = finding({ file: 'src/b.js', line: 2 });

    const result = await suppressFindings([fA, fB], BASE);
    // fA kept (git show failed), fB kept (no SECURITY comment)
    expect(result).toEqual([fA, fB]);
  });
});
