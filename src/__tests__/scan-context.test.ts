import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.fn();

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

const { createScanContext, filterFindingsToChangedLines } = await import('../scan-context.js');

describe('createScanContext()', () => {
  let workspacePath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    workspacePath = await mkdtemp(join(tmpdir(), 'layne-scan-context-'));
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('keeps the original workspace in changed_files mode while preparing a bounded LLM prompt', async () => {
    await mkdir(join(workspacePath, 'src'), { recursive: true });
    await writeFile(join(workspacePath, 'src/app.js'), 'old\nchanged\n', 'utf8');
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, '@@ -2,1 +2,1 @@\n', '');
    });
    const context = await createScanContext({
      workspacePath,
      changedFiles: ['src/app.js'],
      baseSha: 'base',
      headSha: 'head',
      scanConfig: { mode: 'changed_files', contextLines: 3 },
    });

    expect(context).toEqual({
      mode: 'changed_files',
      contextLines: 3,
      headSha: 'head',
      baseSha: 'base',
      repoWorkspacePath: workspacePath,
      scanWorkspacePath: workspacePath,
      sourceFiles: ['src/app.js'],
      scanFiles: ['src/app.js'],
      promptFiles: [{ file: 'src/app.js', content: '@@ lines 1-2 @@\n1| old\n2| changed' }],
      changedLineRanges: new Map([['src/app.js', [{ start: 2, end: 2 }]]]),
    });
    expect(mockExecFile).toHaveBeenCalledOnce();
  });

  it('reuses canonical changed ranges instead of running a second Git diff', async () => {
    await mkdir(join(workspacePath, 'src'), { recursive: true });
    await writeFile(join(workspacePath, 'src/app.js'), 'old\nchanged\n', 'utf8');
    const ranges = new Map([['src/app.js', [{ start: 2, end: 2 }]]]);

    const context = await createScanContext({
      workspacePath,
      changedFiles: ['src/app.js'],
      baseSha: 'base',
      headSha: 'head',
      scanConfig: { mode: 'changed_files', contextLines: 0 },
      changedLineRanges: ranges,
    });

    expect(context.changedLineRanges).toBe(ranges);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('stops range extraction when the signal is aborted during Git', async () => {
    const controller = new AbortController();
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      controller.abort(new Error('scan deadline'));
      cb(null, '@@ -1,1 +1,1 @@\n', '');
    });

    await expect(createScanContext({
      workspacePath,
      changedFiles: ['src/app.js'],
      baseSha: 'base',
      headSha: 'head',
      signal: controller.signal,
    })).rejects.toThrow('scan deadline');
  });

  it('does not start file projection with an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(createScanContext({
      workspacePath,
      changedFiles: ['src/app.js'],
      baseSha: 'base',
      headSha: 'head',
      changedLineRanges: new Map([['src/app.js', [{ start: 1, end: 1 }]]]),
      signal: controller.signal,
    })).rejects.toThrow('cancelled');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('projects only changed hunks plus context into a synthetic workspace for diff_only mode', async () => {
    await mkdir(join(workspacePath, 'src'), { recursive: true });
    await writeFile(
      join(workspacePath, 'src/app.js'),
      'line 1\nline 2\nalert("x")\nline 4\nline 5\n',
      'utf8'
    );

    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, '@@ -3,1 +3,1 @@\n', '');
    });

    const context = await createScanContext({
      workspacePath,
      changedFiles: ['src/app.js'],
      baseSha: 'base',
      headSha: 'head',
      scanConfig: { mode: 'diff_only', contextLines: 1 },
    });

    expect(context.mode).toBe('diff_only');
    expect(context.scanFiles).toEqual(['src/app.js']);
    expect(context.changedLineRanges.get('src/app.js')).toEqual([{ start: 3, end: 3 }]);
    expect(context.promptFiles).toEqual([{
      file: 'src/app.js',
      content: [
        '@@ lines 2-4 @@',
        '2| line 2',
        '3| alert("x")',
        '4| line 4',
      ].join('\n'),
    }]);

    const projected = await readFile(join(context.scanWorkspacePath, 'src/app.js'), 'utf8');
    expect(projected).toBe('\nline 2\nalert("x")\nline 4\n\n');
  });

  it('filters diff_only findings back to exact changed lines', async () => {
    const findings = [
      { file: 'src/app.js', line: 2, tool: 'semgrep' },
      { file: 'src/app.js', line: 3, tool: 'semgrep' },
      { file: 'src/app.js', line: 4, tool: 'semgrep' },
      { file: 'src/other.js', line: 1, tool: 'semgrep' },
      { file: 'package-lock.json', line: 5, tool: 'dep-doctor' },
    ];

    const filtered = filterFindingsToChangedLines(findings, {
      mode: 'diff_only',
      contextLines: 8,
      headSha: 'head',
      baseSha: 'base',
      repoWorkspacePath: '/tmp/ws',
      scanWorkspacePath: '/tmp/ws',
      sourceFiles: [],
      scanFiles: [],
      promptFiles: [],
      changedLineRanges: new Map([
        ['src/app.js', [{ start: 3, end: 3 }]],
      ]),
    });

    expect(filtered).toEqual([
      { file: 'src/app.js', line: 3, tool: 'semgrep' },
      { file: 'package-lock.json', line: 5, tool: 'dep-doctor' },
    ]);
  });

  it('does not follow a repository-controlled .layne symlink when projecting files', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'layne-projection-outside-'));
    try {
      await symlink(outside, join(workspacePath, '.layne'));
      await writeFile(join(workspacePath, 'app.js'), 'eval(input);\n');
      const context = await createScanContext({
        workspacePath, changedFiles: ['app.js'], baseSha: 'base', headSha: 'head',
        scanConfig: { mode: 'diff_only', contextLines: 0 },
        changedLineRanges: new Map([['app.js', [{ start: 1, end: 1 }]]]),
      });
      expect(await readFile(join(context.scanWorkspacePath, 'app.js'), 'utf8')).toBe('eval(input);\n');
      await expect(readFile(join(outside, 'diff-only/app.js'))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
